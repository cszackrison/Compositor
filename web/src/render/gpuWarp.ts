import type { Compositor } from './compositor'
import { compile, type Program } from './gl'
import { passVertex } from './shaders'
import type { Raster } from '../model/raster'

// Smudge and Liquify on the GPU, in the layer's own texture, as the Mac app runs them on Metal (MetalWarp.swift): each dab is
// that file's compute kernel ported to a fragment shader over the dab's square, so a stroke never uploads the layer per pointer
// move. What a move touched is read back into the raster's bytes, so effects, thumbnails and undo see the stroke as it goes.

const header = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform ivec2 center;
uniform int radius;
uniform ivec2 size;
uniform ivec2 origin;
uniform ivec2 area;
uniform float inverseRadius;
uniform float hardness;
uniform float keep;
uniform vec2 move;
// How much a dab moves pixels at a distance u (0 center, 1 rim) from its center.
float weight(float u, float h) {
  if (u >= 1.0) return 0.0;
  if (u <= h) return 1.0;
  float t = (1.0 - u) / (1.0 - h);
  return t * t * (3.0 - 2.0 * t);
}
`

// warp_pick_up: the square under the brush, in 0…255, as what Smudge carries.
const pickUpFragment = header + `
uniform sampler2D canvas;
out vec4 carried;
void main() {
  ivec2 p = center + ivec2(gl_FragCoord.xy) - radius;
  bool inside = p.x >= 0 && p.y >= 0 && p.x < size.x && p.y < size.y;
  carried = inside ? texelFetch(canvas, p, 0) * 255.0 : vec4(0.0);
}`

// warp_smudge, over the dab's square: the canvas square (copied out, as a fragment can't read what it writes) and what the brush
// carries, in and out.
const smudgeFragment = header + `
uniform sampler2D canvasIn;
uniform sampler2D carriedIn;
layout(location = 0) out vec4 canvasOut;
layout(location = 1) out vec4 carriedOut;
void main() {
  ivec2 gid = ivec2(gl_FragCoord.xy), offset = gid - radius, p = center + offset;
  vec4 under = texelFetch(canvasIn, gid, 0) * 255.0, held = texelFetch(carriedIn, gid, 0);
  bool inside = p.x >= 0 && p.y >= 0 && p.x < size.x && p.y < size.y;
  float w = inside ? weight(sqrt(float(offset.x * offset.x + offset.y * offset.y)) * inverseRadius, hardness) : 0.0;
  if (w <= 0.0) { canvasOut = under / 255.0; carriedOut = held; return; }
  vec4 painted = under + (held - under) * w * keep;
  canvasOut = clamp(floor(painted + 0.5), 0.0, 255.0) / 255.0;
  carriedOut = painted;
}`

// warp_push, drawn straight into the layer and the offsets at the dab's square (scissored to its area).
const pushFragment = header + `
uniform sampler2D before;
uniform sampler2D original;
layout(location = 0) out vec4 canvasOut;
layout(location = 1) out vec4 offsetOut;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), offset = p - center;
  float w = weight(sqrt(float(offset.x * offset.x + offset.y * offset.y)) * inverseRadius, hardness);
  if (w <= 0.0) discard;
  float sx = min(float(area.x - 1), max(0.0, float(p.x - origin.x) - move.x * w));
  float sy = min(float(area.y - 1), max(0.0, float(p.y - origin.y) - move.y * w));
  int ix = min(area.x - 2, int(sx)), iy = min(area.y - 2, int(sy));
  if (ix < 0 || iy < 0) discard;
  float fx = sx - float(ix), fy = sy - float(iy);
  vec2 o00 = texelFetch(before, ivec2(ix, iy), 0).xy, o10 = texelFetch(before, ivec2(ix + 1, iy), 0).xy;
  vec2 o01 = texelFetch(before, ivec2(ix, iy + 1), 0).xy, o11 = texelFetch(before, ivec2(ix + 1, iy + 1), 0).xy;
  vec2 moved = mix(mix(o00, o10, fx), mix(o01, o11, fx), fy) - move * w;
  offsetOut = vec4(moved, 0.0, 0.0);
  vec2 source = clamp(vec2(p) + moved, vec2(0.0), vec2(size - 1));
  ivec2 i = min(ivec2(source), size - 2);
  vec2 f = source - vec2(i);
  vec4 c00 = texelFetch(original, i, 0), c10 = texelFetch(original, i + ivec2(1, 0), 0);
  vec4 c01 = texelFetch(original, i + ivec2(0, 1), 0), c11 = texelFetch(original, i + ivec2(1, 1), 0);
  vec4 color = mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
  canvasOut = clamp(floor(color * 255.0 + 0.5), 0.0, 255.0) / 255.0;
}`

type Programs = { pickUp: Program; smudge: Program; push: Program }
const programs = new WeakMap<WebGL2RenderingContext, Programs | null>()

function programsFor(gl: WebGL2RenderingContext): Programs | null {
  if (!programs.has(gl)) {
    try {
      // Float render targets carry Smudge's color and Liquify's offsets.
      programs.set(gl, gl.getExtension('EXT_color_buffer_float') ? { pickUp: compile(gl, pickUpFragment, passVertex), smudge: compile(gl, smudgeFragment, passVertex), push: compile(gl, pushFragment, passVertex) } : null)
    } catch (error) { console.warn('Smudge and Liquify stay on the CPU:', error); programs.set(gl, null) }
  }
  return programs.get(gl)!
}

type Rect = { x0: number; y0: number; x1: number; y1: number }

export class GPUWarp {
  private gl: WebGL2RenderingContext
  private programs: Programs
  private layerFramebuffer: WebGLFramebuffer
  private owned: { textures: WebGLTexture[]; framebuffers: WebGLFramebuffer[] } = { textures: [], framebuffers: [] }
  // Smudge: the canvas square in and out, and what the brush carries (two, swapped each dab).
  private square: { side: number; canvasIn: WebGLTexture; canvasOut: WebGLTexture; carried: WebGLTexture[]; framebuffers: WebGLFramebuffer[] } | null = null
  // Liquify: the layer as the stroke found it, each pixel's offset into it, and the offsets a dab reads.
  private liquify: { original: WebGLTexture; offsets: WebGLTexture; push: WebGLFramebuffer; offsetsFramebuffer: WebGLFramebuffer; scratch: WebGLTexture | null; scratchSide: number } | null = null

  static create(compositor: Compositor | null, raster: Raster): GPUWarp | null {
    if (!compositor || raster.channels !== 4) return null
    const found = programsFor(compositor.gl)
    return found ? new GPUWarp(compositor, raster, found) : null
  }

  private constructor(private compositor: Compositor, readonly raster: Raster, programs: Programs) {
    this.gl = compositor.gl
    this.programs = programs
    const texture = compositor.texture(raster)
    this.layerFramebuffer = this.framebuffer([texture])
  }

  private texture(width: number, height: number, format: number): WebGLTexture {
    const gl = this.gl, texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    this.owned.textures.push(texture)
    return texture
  }

  private framebuffer(textures: WebGLTexture[]): WebGLFramebuffer {
    const gl = this.gl, framebuffer = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    textures.forEach((texture, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, texture, 0))
    gl.drawBuffers(textures.map((_, i) => gl.COLOR_ATTACHMENT0 + i))
    this.owned.framebuffers.push(framebuffer)
    return framebuffer
  }

  private run(program: Program, uniforms: Record<string, number | number[]>, samplers: WebGLTexture[], names: string[]) {
    const gl = this.gl
    gl.useProgram(program.program)
    for (const [name, value] of Object.entries(uniforms)) {
      const u = program.uniforms.get(name)
      if (!u) continue
      const v = Array.isArray(value) ? value : [value]
      if (u.type === gl.INT || u.type === gl.SAMPLER_2D) gl.uniform1i(u.location, v[0])
      else if (u.type === gl.INT_VEC2) gl.uniform2i(u.location, v[0], v[1])
      else if (u.type === gl.FLOAT_VEC2) gl.uniform2f(u.location, v[0], v[1])
      else gl.uniform1f(u.location, v[0])
    }
    samplers.forEach((texture, i) => {
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      const u = program.uniforms.get(names[i])
      if (u) gl.uniform1i(u.location, i)
    })
    gl.disable(gl.BLEND)
    gl.bindVertexArray(this.compositor.quadArray)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.activeTexture(gl.TEXTURE0)
  }

  private get size() { return [this.raster.width, this.raster.height] }

  pickUp(cx: number, cy: number, radius: number) {
    const gl = this.gl, side = 2 * radius + 1
    if (!this.square || this.square.side !== side) {
      const canvasIn = this.texture(side, side, gl.RGBA8), canvasOut = this.texture(side, side, gl.RGBA8)
      const carried = [this.texture(side, side, gl.RGBA32F), this.texture(side, side, gl.RGBA32F)]
      this.square = { side, canvasIn, canvasOut, carried, framebuffers: [this.framebuffer([canvasOut, carried[0]]), this.framebuffer([canvasOut, carried[1]]), this.framebuffer([carried[0]])] }
    }
    const s = this.square
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.framebuffers[2])
    gl.viewport(0, 0, side, side)
    this.run(this.programs.pickUp, { center: [cx, cy], radius, size: this.size }, [this.compositor.texture(this.raster)], ['canvas'])
    this.done()
  }

  // One Smudge dab; returns the pixels it may have changed.
  smudge(cx: number, cy: number, radius: number, inverseRadius: number, hardness: number, keep: number): Rect | null {
    const s = this.square
    if (!s) return null
    const gl = this.gl, side = s.side, [width, height] = this.size
    const x0 = Math.max(0, cx - radius), y0 = Math.max(0, cy - radius), x1 = Math.min(width, cx + radius + 1), y1 = Math.min(height, cy + radius + 1)
    if (x0 >= x1 || y0 >= y1) return null
    // The canvas square, copied out so the dab can read it while it writes.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.layerFramebuffer)
    gl.bindTexture(gl.TEXTURE_2D, s.canvasIn)
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, x0 - (cx - radius), y0 - (cy - radius), x0, y0, x1 - x0, y1 - y0)
    // Reads carried[0], writes carried[1] (framebuffer 1 holds canvasOut and carried[1]), then they swap.
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.framebuffers[1])
    gl.viewport(0, 0, side, side)
    this.run(this.programs.smudge, { center: [cx, cy], radius, size: this.size, inverseRadius, hardness, keep }, [s.canvasIn, s.carried[0]], ['canvasIn', 'carriedIn'])
    // And the square back into the layer.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.framebuffers[1])
    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    gl.bindTexture(gl.TEXTURE_2D, this.compositor.texture(this.raster))
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x0 - (cx - radius), y0 - (cy - radius), x1 - x0, y1 - y0)
    s.carried.reverse()
    s.framebuffers = [s.framebuffers[1], s.framebuffers[0], s.framebuffers[2]]
    this.done()
    return { x0, y0, x1, y1 }
  }

  // One Liquify dab from a to b (WarpStroke.push / MetalWarp.push); returns the pixels it may have changed.
  push(a: [number, number], b: [number, number], radius: number, inverseRadius: number, hardness: number, strength: number): Rect | null {
    const gl = this.gl, [width, height] = this.size
    const mx = (b[0] - a[0]) * strength, my = (b[1] - a[1]) * strength
    const margin = Math.ceil(Math.max(Math.abs(mx), Math.abs(my))) + 2
    const cx = Math.round(b[0]), cy = Math.round(b[1])
    const x0 = Math.max(0, cx - radius - margin), x1 = Math.min(width - 1, cx + radius + margin)
    const y0 = Math.max(0, cy - radius - margin), y1 = Math.min(height - 1, cy + radius + margin)
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1
    if (cw < 2 || ch < 2) return null
    // The first push keeps the layer as it is, and starts every offset at nothing.
    if (!this.liquify) {
      const original = this.texture(width, height, gl.RGBA8), offsets = this.texture(width, height, gl.RG32F)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.layerFramebuffer)
      gl.bindTexture(gl.TEXTURE_2D, original)
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height)
      const offsetsFramebuffer = this.framebuffer([offsets])
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0])
      this.liquify = { original, offsets, push: this.framebuffer([this.compositor.texture(this.raster), offsets]), offsetsFramebuffer, scratch: null, scratchSide: 0 }
    }
    const l = this.liquify
    const side = Math.max(cw, ch)
    if (side > l.scratchSide) { l.scratchSide = Math.max(side, Math.ceil(l.scratchSide * 1.5)); l.scratch = this.texture(l.scratchSide, l.scratchSide, gl.RG32F) }
    // The offsets in the dab's area as they were, which the dab reads.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, l.offsetsFramebuffer)
    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    gl.bindTexture(gl.TEXTURE_2D, l.scratch)
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, x0, y0, cw, ch)
    gl.bindFramebuffer(gl.FRAMEBUFFER, l.push)
    gl.viewport(cx - radius, cy - radius, 2 * radius + 1, 2 * radius + 1)
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(x0, y0, cw, ch)
    this.run(this.programs.push, { center: [cx, cy], size: this.size, origin: [x0, y0], area: [cw, ch], inverseRadius, hardness, move: [mx, my] }, [l.scratch!, l.original], ['before', 'original'])
    gl.disable(gl.SCISSOR_TEST)
    this.done()
    return { x0, y0, x1: x1 + 1, y1: y1 + 1 }
  }

  private done() {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
  }

  // Brings what the dabs did in `rect` back into the raster's bytes, and tells the compositor its texture is already current.
  sync(rect: Rect) {
    const gl = this.gl, { raster } = this, x0 = Math.max(0, rect.x0), y0 = Math.max(0, rect.y0), x1 = Math.min(raster.width, rect.x1), y1 = Math.min(raster.height, rect.y1)
    if (x0 < x1 && y0 < y1) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.layerFramebuffer)
      gl.readBuffer(gl.COLOR_ATTACHMENT0)
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1)
      gl.pixelStorei(gl.PACK_ROW_LENGTH, raster.width)
      gl.readPixels(x0, y0, x1 - x0, y1 - y0, gl.RGBA, gl.UNSIGNED_BYTE, raster.data, (y0 * raster.width + x0) * 4)
      gl.pixelStorei(gl.PACK_ROW_LENGTH, 0)
      this.done()
    }
    this.compositor.markCurrent(raster, { x0, y0, x1, y1 })
  }

  dispose() {
    const gl = this.gl
    this.owned.framebuffers.forEach(f => gl.deleteFramebuffer(f))
    this.owned.textures.forEach(t => gl.deleteTexture(t))
    gl.deleteFramebuffer(this.layerFramebuffer)
    this.owned = { textures: [], framebuffers: [] }
  }
}
