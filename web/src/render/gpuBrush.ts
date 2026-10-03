import type { Compositor } from './compositor'
import { compile, type Mat3, type Program } from './gl'
import { passVertex } from './shaders'
import type { Raster } from '../model/raster'

// Brush, Eraser and Clone Stamp strokes on the GPU, in the compositor's own texture for the layer or mask, so a move no longer
// works every pixel under the brush on the CPU and uploads them. BrushStroke still lays out the dabs (curve, spacing, tail,
// pressure); here each dab is a quad blended into a float coverage texture (lighten for a hard tip, screen for a soft one, the
// CPU code's formulas), and each frame a pass lays the color (or the clone source) over the untouched original at coverage ×
// opacity, through the selection. The pixels come back to the raster when the stroke ends, or when something needs them before
// then (the effects worker, see Compositor.readBack).

export type GPUSource = { kind: 'layer'; shift: [number, number] } | { kind: 'composite'; image: Raster; offset: [number, number] }

const dabFragment = `#version 300 es
precision highp float;
uniform vec2 center;
uniform float radius;
uniform float hardness;
uniform int hard;
out vec4 value;
float falloff(float u) {
  const float k = 2.5;
  return max(0.0, (exp(-k * u * u) - exp(-k)) / (1.0 - exp(-k)));
}
void main() {
  vec2 d = gl_FragCoord.xy - center;
  float d2 = dot(d, d), v;
  if (hard == 1) {
    float outer = radius + 0.5, solid = max(0.0, radius - 0.5);
    if (d2 >= outer * outer) discard;
    v = d2 <= solid * solid ? 1.0 : min(1.0, radius - sqrt(d2) + 0.5);
  } else {
    float inner = radius * hardness, band = max(1e-6, radius - inner);
    if (d2 >= radius * radius) discard;
    v = d2 <= inner * inner ? 1.0 : falloff((sqrt(d2) - inner) / band);
  }
  if (v <= 0.0) discard;
  value = vec4(v, 0.0, 0.0, 0.0);
}`

const compositeFragment = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D original;
uniform sampler2D coverage;
uniform sampler2D selection;
uniform sampler2D source;
uniform int channels;
uniform int mode;
uniform int hasSelection;
uniform float opacity;
uniform vec3 color;
uniform float gray;
uniform mat3 toDoc;
uniform ivec2 size;
uniform ivec2 selectionSize;
uniform ivec2 sourceSize;
uniform vec2 shift;
out vec4 result;
// BrushStroke's bilinear: four neighbors, those outside the image leaving their share out; 0…255.
vec4 bilinear(sampler2D image, ivec2 extent, vec2 at) {
  vec2 f = at - 0.5, b = floor(f), t = f - b;
  ivec2 i0 = ivec2(b);
  vec4 sum = vec4(0.0);
  for (int n = 0; n < 4; n++) {
    ivec2 q = i0 + ivec2(n & 1, n >> 1);
    float w = ((n & 1) == 1 ? t.x : 1.0 - t.x) * ((n >> 1) == 1 ? t.y : 1.0 - t.y);
    if (q.x < 0 || q.y < 0 || q.x >= extent.x || q.y >= extent.y || w <= 0.0) continue;
    sum += texelFetch(image, q, 0) * 255.0 * w;
  }
  return sum;
}
vec4 rounded(vec4 v) { return floor(v + 0.5) / 255.0; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 o = texelFetch(original, p, 0) * 255.0;
  float a = texelFetch(coverage, p, 0).r * opacity;
  vec2 centre = vec2(p) + 0.5, doc = (toDoc * vec3(centre, 1.0)).xy;
  if (a > 0.0 && hasSelection == 1) {
    ivec2 s = ivec2(floor(doc));
    a *= s.x >= 0 && s.y >= 0 && s.x < selectionSize.x && s.y < selectionSize.y ? texelFetch(selection, s, 0).r : 0.0;
  }
  if (a <= 0.0) { result = o / 255.0; return; }
  if (mode >= 2) {
    vec4 sampled = mode == 2 ? bilinear(original, size, centre + shift) : bilinear(source, sourceSize, doc + shift);
    if (channels == 1) { result = rounded(vec4(sampled.r * a + o.r * (1.0 - a))); return; }
    result = rounded(sampled * a + o * (1.0 - sampled.a / 255.0 * a));
    return;
  }
  if (channels == 1) { result = rounded(vec4((mode == 1 ? 0.0 : gray) * a + o.r * (1.0 - a))); return; }
  float keep = 1.0 - a;
  result = mode == 1 ? rounded(o * keep) : rounded(vec4(color * a, 255.0 * a) + o * keep);
}`

type Programs = { dab: Program; composite: Program }
const programs = new WeakMap<WebGL2RenderingContext, Programs | null>()

function programsFor(gl: WebGL2RenderingContext): Programs | null {
  if (!programs.has(gl)) {
    try {
      // Coverage builds in a 32-bit float texture, which needs blending into float targets.
      const ok = gl.getExtension('EXT_color_buffer_float') && gl.getExtension('EXT_float_blend')
      programs.set(gl, ok ? { dab: compile(gl, dabFragment, passVertex), composite: compile(gl, compositeFragment, passVertex) } : null)
    } catch (error) { console.warn('Brush strokes stay on the CPU:', error); programs.set(gl, null) }
  }
  return programs.get(gl)!
}

type Rect = { x0: number; y0: number; x1: number; y1: number }

export class GPUBrush {
  private gl: WebGL2RenderingContext
  private programs: Programs
  private textures: WebGLTexture[] = []
  private framebuffers: WebGLFramebuffer[] = []
  private layerFramebuffer: WebGLFramebuffer
  private original: WebGLTexture
  private coverage: WebGLTexture
  private coverageFramebuffer: WebGLFramebuffer
  private tail: { texture: WebGLTexture; framebuffer: WebGLFramebuffer; width: number; height: number } | null = null
  private selectionTexture: WebGLTexture | null = null
  private sourceTexture: WebGLTexture | null = null
  // What the stroke has written to the layer's texture and not yet brought back.
  private written: Rect | null = null

  static create(compositor: Compositor | null, raster: Raster, options: { erasing: boolean; color: [number, number, number]; opacity: number; toDocument: Mat3; selection: Raster | null; source?: GPUSource }): GPUBrush | null {
    if (!compositor) return null
    const found = programsFor(compositor.gl)
    if (!found || Math.max(raster.width, raster.height) > compositor.maxSize) return null
    return new GPUBrush(compositor, raster, found, options)
  }

  private constructor(private compositor: Compositor, readonly raster: Raster, programs: Programs, private options: { erasing: boolean; color: [number, number, number]; opacity: number; toDocument: Mat3; selection: Raster | null; source?: GPUSource }) {
    const gl = this.gl = compositor.gl
    this.programs = programs
    const { width, height } = raster, format = raster.channels === 4 ? gl.RGBA8 : gl.R8
    this.layerFramebuffer = this.framebuffer(compositor.texture(raster))
    // The layer as the stroke found it.
    this.original = this.texture(width, height, format)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.layerFramebuffer)
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height)
    this.coverage = this.texture(width, height, gl.R32F)
    this.coverageFramebuffer = this.framebuffer(this.coverage)
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0])
    const upload = (r: Raster) => {
      const texture = this.texture(r.width, r.height, r.channels === 4 ? gl.RGBA8 : gl.R8)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, r.width, r.height, r.channels === 4 ? gl.RGBA : gl.RED, gl.UNSIGNED_BYTE, r.data)
      return texture
    }
    if (options.selection) this.selectionTexture = upload(options.selection)
    if (options.source?.kind === 'composite') this.sourceTexture = upload(options.source.image)
    this.done()
    compositor.readBack.set(raster, () => { if (this.written) this.read(this.written) })
  }

  private texture(width: number, height: number, format: number) {
    const gl = this.gl, texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, Math.max(1, width), Math.max(1, height))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    this.textures.push(texture)
    return texture
  }

  private framebuffer(texture: WebGLTexture) {
    const gl = this.gl, framebuffer = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    this.framebuffers.push(framebuffer)
    return framebuffer
  }

  private uniforms(program: Program, values: Record<string, number | number[]>) {
    const gl = this.gl
    gl.useProgram(program.program)
    for (const [name, value] of Object.entries(values)) {
      const u = program.uniforms.get(name)
      if (!u) continue
      const v = Array.isArray(value) ? value : [value]
      if (u.type === gl.FLOAT_MAT3) gl.uniformMatrix3fv(u.location, false, v)
      else if (u.type === gl.INT || u.type === gl.SAMPLER_2D) gl.uniform1i(u.location, v[0])
      else if (u.type === gl.INT_VEC2) gl.uniform2i(u.location, v[0], v[1])
      else if (u.type === gl.FLOAT_VEC2) gl.uniform2f(u.location, v[0], v[1])
      else if (u.type === gl.FLOAT_VEC3) gl.uniform3f(u.location, v[0], v[1], v[2])
      else gl.uniform1f(u.location, v[0])
    }
  }

  private draw() {
    const gl = this.gl
    gl.bindVertexArray(this.compositor.quadArray)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private done() {
    const gl = this.gl
    gl.disable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
    gl.disable(gl.SCISSOR_TEST)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    gl.activeTexture(gl.TEXTURE0)
  }

  // One dab into the coverage, over its bounds `rect` (raster pixels).
  dab(cx: number, cy: number, radius: number, hardness: number, rect: Rect) {
    const gl = this.gl, hard = hardness >= 1
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.coverageFramebuffer)
    gl.viewport(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0)
    gl.enable(gl.BLEND)
    if (hard) gl.blendEquation(gl.MAX)
    else { gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR) }
    this.uniforms(this.programs.dab, { center: [cx, cy], radius, hardness, hard: hard ? 1 : 0 })
    this.draw()
    this.done()
  }

  // Keeps the coverage in `rect` so a provisional tail drawn over it can be taken back.
  saveTail(rect: Rect) {
    const gl = this.gl, w = rect.x1 - rect.x0, h = rect.y1 - rect.y0
    if (w <= 0 || h <= 0) return
    if (!this.tail || this.tail.width < w || this.tail.height < h) {
      if (this.tail) { gl.deleteTexture(this.tail.texture); gl.deleteFramebuffer(this.tail.framebuffer) }
      const width = Math.max(w, Math.ceil((this.tail?.width ?? 0) * 1.25)), height = Math.max(h, Math.ceil((this.tail?.height ?? 0) * 1.25))
      const texture = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, width, height)
      const framebuffer = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      this.tail = { texture, framebuffer, width, height }
      gl.bindTexture(gl.TEXTURE_2D, texture)
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.coverageFramebuffer)
    gl.bindTexture(gl.TEXTURE_2D, this.tail.texture)
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, rect.x0, rect.y0, w, h)
    this.done()
  }

  restoreTail(rect: Rect) {
    const gl = this.gl, w = rect.x1 - rect.x0, h = rect.y1 - rect.y0
    if (!this.tail || w <= 0 || h <= 0) return
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.tail.framebuffer)
    gl.bindTexture(gl.TEXTURE_2D, this.coverage)
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, rect.x0, rect.y0, 0, 0, w, h)
    this.done()
  }

  // Lays the stroke so far over the original in `rect`, in the layer's texture.
  composite(rect: Rect) {
    const gl = this.gl, { raster, options } = this, source = options.source
    const [r, g, b] = options.color
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFramebuffer)
    gl.viewport(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0)
    const units: [string, WebGLTexture][] = [['original', this.original], ['coverage', this.coverage], ['selection', this.selectionTexture ?? this.original], ['source', this.sourceTexture ?? this.original]]
    units.forEach(([, texture], i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, texture) })
    const shift = source?.kind === 'layer' ? source.shift : source?.kind === 'composite' ? source.offset : [0, 0]
    this.uniforms(this.programs.composite, {
      original: 0, coverage: 1, selection: 2, source: 3, channels: raster.channels, mode: source ? (source.kind === 'layer' ? 2 : 3) : options.erasing ? 1 : 0,
      hasSelection: this.selectionTexture ? 1 : 0, opacity: options.opacity, color: [r, g, b], gray: Math.round(0.299 * r + 0.587 * g + 0.114 * b),
      toDoc: options.toDocument, size: [raster.width, raster.height], selectionSize: options.selection ? [options.selection.width, options.selection.height] : [0, 0],
      sourceSize: source?.kind === 'composite' ? [source.image.width, source.image.height] : [0, 0], shift,
    })
    this.draw()
    this.done()
    this.compositor.markCurrent(raster, rect)
    const w = this.written
    this.written = w ? { x0: Math.min(w.x0, rect.x0), y0: Math.min(w.y0, rect.y0), x1: Math.max(w.x1, rect.x1), y1: Math.max(w.y1, rect.y1) } : { ...rect }
  }

  // Brings `rect` of the layer's texture back into the raster's bytes, without counting as a change to them.
  read(rect: Rect) {
    const gl = this.gl, { raster } = this
    const x0 = Math.max(0, rect.x0), y0 = Math.max(0, rect.y0), x1 = Math.min(raster.width, rect.x1), y1 = Math.min(raster.height, rect.y1)
    if (x0 >= x1 || y0 >= y1) return
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.layerFramebuffer)
    this.written = null
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1)
    if (raster.channels === 4) {
      gl.pixelStorei(gl.PACK_ROW_LENGTH, raster.width)
      gl.readPixels(x0, y0, x1 - x0, y1 - y0, gl.RGBA, gl.UNSIGNED_BYTE, raster.data, (y0 * raster.width + x0) * 4)
      gl.pixelStorei(gl.PACK_ROW_LENGTH, 0)
    } else {
      // A mask reads back as RGBA (the one format every GPU can read), keeping its red.
      const w = x1 - x0, h = y1 - y0, rgba = new Uint8Array(w * h * 4)
      gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raster.data[(y + y0) * raster.width + x + x0] = rgba[(y * w + x) * 4]
    }
    // The texture already counts as current (composite marked it); the bytes now match it.
    this.done()
  }

  dispose() {
    const gl = this.gl
    if (this.compositor.readBack.get(this.raster)) this.compositor.readBack.delete(this.raster)
    this.framebuffers.forEach(f => gl.deleteFramebuffer(f))
    this.textures.forEach(t => gl.deleteTexture(t))
    if (this.tail) { gl.deleteTexture(this.tail.texture); gl.deleteFramebuffer(this.tail.framebuffer) }
    this.framebuffers = []; this.textures = []; this.tail = null
  }
}
