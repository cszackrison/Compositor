import { type Mat3, type Program, Target, TargetPool, chain, compile, invert, multiply, rotate, scale, setSampling, translate, use, apply, identity } from './gl'
import { adjustFragment, adjustMixFragment, blurFragment, clipFragment, copyFragment, displayFragment, layerFragment, passVertex } from './shaders'
import { renderEffects, hasVisibleEffects } from './effects'
import { channelTables, hueSaturationCube, kernelCube, cubeSize } from '../model/adjustments'
import { type Adjustment, type Doc, type Layer, type Transform, blendModes } from '../model/types'
import { Raster } from '../model/raster'

// Layer unit square (0…1 on both axes, row 0 at the top) to document pixels: about the center, clockwise rotation, flips inside the box.
export function unitToDocument(t: Transform): Mat3 {
  const radians = (t.rotation % 360) * Math.PI / 180
  return chain(translate(t.origin[0] + t.size[0] / 2, t.origin[1] + t.size[1] / 2), rotate(radians), scale(t.size[0] * (t.flipX ? -1 : 1), t.size[1] * (t.flipY ? -1 : 1)), translate(-0.5, -0.5))
}

// The same, for a W×H pixel grid (pixel corners at integers), as BrushRaster.pixelToDocument.
export function pixelToDocument(t: Transform, width: number, height: number): Mat3 {
  return multiply(unitToDocument(t), scale(1 / width, 1 / height))
}

export function transformCorners(t: Transform) {
  const m = unitToDocument(t)
  return [apply(m, 0, 0), apply(m, 1, 0), apply(m, 1, 1), apply(m, 0, 1)]
}

type Entry = { layer: Layer; ancestors: Layer[] }
type Source = { texture: WebGLTexture; width: number; height: number; unitToDoc: Mat3; sampling: Transform['sampling'] | 'Exact'; rotation: number; raster?: Raster }
type MaskSpec = { mode: 0 } | { mode: 1; texture: WebGLTexture } | { mode: 2; texture: WebGLTexture; unitToDoc: Mat3; outside: number }

export function drawOrder(doc: Doc): Entry[] {
  const children = new Map<string | null, Layer[]>()
  for (const layer of doc.layers) children.set(layer.parentId, [...(children.get(layer.parentId) ?? []), layer])
  const out: Entry[] = []
  const walk = (parent: string | null, ancestors: Layer[], depth: number) => {
    if (depth > 64) return
    for (const layer of children.get(parent) ?? []) {
      out.push({ layer, ancestors })
      if (layer.isGroup) walk(layer.id, [...ancestors, layer], depth + 1)
    }
  }
  walk(null, [], 0)
  return out
}

export const effectivelyVisible = (entry: Entry) => entry.layer.visible && entry.ancestors.every(a => a.visible)

type TextureRecord = { texture: WebGLTexture; version: number; mipVersion: number; width: number; height: number; channels: number }

export class Compositor {
  readonly gl: WebGL2RenderingContext
  readonly maxSize: number
  private quad: WebGLVertexArrayObject
  private layerProgram: Program
  private copyProgram: Program
  private clipProgram: Program
  private adjustProgram: Program
  private blurProgram: Program
  private mixProgram: Program
  private displayProgram: Program
  private pool!: TargetPool
  private textures = new WeakMap<Raster, TextureRecord>()
  // Rasters dropped by the document (undo history aged out, previews replaced) give their GPU textures back once collected.
  private released = new FinalizationRegistry<WebGLTexture>(texture => this.gl.deleteTexture(texture))
  private luts = new WeakMap<Adjustment, { kind: 'table' | 'cube'; texture: WebGLTexture } | null>()
  private effectsCache = new Map<string, { key: string; raster: Raster; inset: number }>()
  private clipCache = new Map<string, Target>()
  private maskBackgrounds = new WeakMap<Raster, { version: number; value: number }>()
  private white: WebGLTexture
  output: Target | null = null
  renderScale = 1
  private width = 0
  private height = 0

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: false, antialias: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null
    if (!gl) throw new Error('This browser does not support WebGL 2, which Compositor needs.')
    this.gl = gl
    gl.getExtension('EXT_color_buffer_float')
    gl.getExtension('OES_texture_float_linear')
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE)
    this.quad = gl.createVertexArray()!
    gl.bindVertexArray(this.quad)
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    this.layerProgram = compile(gl, layerFragment)
    this.displayProgram = compile(gl, displayFragment)
    this.copyProgram = compile(gl, copyFragment, passVertex)
    this.clipProgram = compile(gl, clipFragment, passVertex)
    this.adjustProgram = compile(gl, adjustFragment, passVertex)
    this.blurProgram = compile(gl, blurFragment, passVertex)
    this.mixProgram = compile(gl, adjustMixFragment, passVertex)
    this.pool = new TargetPool(gl, 'rgba8')
    this.white = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.white)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
  }

  // Uploads a raster (or just what changed in it) and returns its texture.
  texture(raster: Raster, mipmaps = false): WebGLTexture {
    const gl = this.gl
    let record = this.textures.get(raster)
    const format = raster.channels === 4 ? [gl.RGBA8, gl.RGBA] : [gl.R8, gl.RED]
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    if (!record) {
      const texture = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, texture)
      const levels = Math.floor(Math.log2(Math.max(raster.width, raster.height))) + 1
      gl.texStorage2D(gl.TEXTURE_2D, levels, format[0], raster.width, raster.height)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels - 1)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, raster.width, raster.height, format[1], gl.UNSIGNED_BYTE, raster.data)
      record = { texture, version: raster.version, mipVersion: 0, width: raster.width, height: raster.height, channels: raster.channels }
      this.textures.set(raster, record)
      this.released.register(raster, texture, record)
    } else if (record.version !== raster.version) {
      gl.bindTexture(gl.TEXTURE_2D, record.texture)
      const dirty = raster.dirty && raster.dirtyFrom <= record.version ? raster.dirty : null
      if (dirty) {
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, raster.width)
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, dirty.x)
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, dirty.y)
        gl.texSubImage2D(gl.TEXTURE_2D, 0, dirty.x, dirty.y, dirty.w, dirty.h, format[1], gl.UNSIGNED_BYTE, raster.data)
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
      } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, raster.width, raster.height, format[1], gl.UNSIGNED_BYTE, raster.data)
      record.version = raster.version
    }
    gl.bindTexture(gl.TEXTURE_2D, record.texture)
    if (mipmaps && record.mipVersion !== record.version) { gl.generateMipmap(gl.TEXTURE_2D); record.mipVersion = record.version }
    return record.texture
  }

  forget(raster: Raster) {
    const record = this.textures.get(raster)
    if (record) { this.released.unregister(record); this.gl.deleteTexture(record.texture); this.textures.delete(raster) }
  }

  private get docToTarget(): Mat3 { return scale(this.renderScale) }
  private get targetToClip(): Mat3 { return chain(translate(-1, -1), scale(2 / this.width, 2 / this.height)) }
  private bindQuad() { this.gl.bindVertexArray(this.quad) }

  private pass(target: Target, program: Program, uniforms: Parameters<typeof use>[2], blend: 'none' | 'multiply' = 'none') {
    const gl = this.gl
    target.bind()
    if (blend === 'multiply') { gl.enable(gl.BLEND); gl.blendFunc(gl.ZERO, gl.SRC_COLOR) } else gl.disable(gl.BLEND)
    use(gl, program, uniforms)
    this.bindQuad()
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.disable(gl.BLEND)
  }

  private copy(from: Target, to: Target) {
    const gl = this.gl
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from.framebuffer)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to.framebuffer)
    gl.blitFramebuffer(0, 0, from.width, from.height, 0, 0, to.width, to.height, gl.COLOR_BUFFER_BIT, gl.NEAREST)
  }

  // Draws a source quad into `target` with its opacity, mask, clips and blend mode.
  private draw(target: Target, source: Source, options: { opacity: number; blendMode: Layer['blendMode']; mask?: MaskSpec; clip?: Target | null; coverage?: Target | null }) {
    const gl = this.gl
    const toTarget = multiply(this.docToTarget, source.unitToDoc)
    const [ox, oy] = apply(toTarget, 0, 0), [ux, uy] = apply(toTarget, 1, 0)
    const factor = Math.hypot(ux - ox, uy - oy) / source.width
    const exact = source.sampling === 'Exact' || (source.rotation % 360 === 0 && Math.abs(factor - 1) < 0.001 && Math.abs(ox - Math.round(ox)) < 0.001 && Math.abs(oy - Math.round(oy)) < 0.001)
    const nearest = exact || source.sampling === 'Nearest'
    const shrinking = factor < 0.999
    if (source.raster) this.texture(source.raster, !nearest && factor < 0.5)
    gl.bindTexture(gl.TEXTURE_2D, source.texture)
    setSampling(gl, nearest ? gl.NEAREST : shrinking && factor < 0.5 && source.raster ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    const filterMode = !nearest && !shrinking && source.sampling === 'High quality' ? 1 : 0
    if (filterMode === 1) setSampling(gl, gl.NEAREST)
    const margin = nearest ? 0 : 2 / Math.max(1e-6, Math.min(Math.hypot(ux - ox, uy - oy), Math.hypot(...(([a, b]) => [a - ox, b - oy])(apply(toTarget, 0, 1)))))
    const expand = chain(translate(-margin, -margin), scale(1 + 2 * margin))
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => apply(multiply(toTarget, expand), x, y))
    const x0 = Math.max(0, Math.floor(Math.min(...corners.map(c => c[0])))), y0 = Math.max(0, Math.floor(Math.min(...corners.map(c => c[1]))))
    const x1 = Math.min(target.width, Math.ceil(Math.max(...corners.map(c => c[0])))), y1 = Math.min(target.height, Math.ceil(Math.max(...corners.map(c => c[1]))))
    if (x1 <= x0 || y1 <= y0) return
    const mode = blendModes.indexOf(options.blendMode)
    let backdrop: Target | null = null
    if (mode !== 0) {
      backdrop = this.pool.take(target.width, target.height)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, backdrop.framebuffer)
      gl.blitFramebuffer(x0, y0, x1, y1, x0, y0, x1, y1, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    }
    target.bind()
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(x0, y0, x1 - x0, y1 - y0)
    if (mode === 0) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) } else gl.disable(gl.BLEND)
    const mask = options.mask ?? { mode: 0 }
    if (mask.mode !== 0) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mask.texture); setSampling(gl, gl.LINEAR) }
    use(gl, this.layerProgram, {
      toClip: chain(this.targetToClip, toTarget, expand), toSource: expand,
      image: { texture: source.texture, unit: 0 }, imageSize: [source.width, source.height], filterMode, antialias: nearest ? 0 : 1, opacity: options.opacity,
      maskMode: mask.mode, mask: { texture: mask.mode ? mask.texture : this.white, unit: 1 },
      targetToMask: mask.mode === 2 ? invert(multiply(this.docToTarget, mask.unitToDoc)) : identity(), maskOutside: mask.mode === 2 ? mask.outside : 0,
      hasClip: options.clip ? 1 : 0, clip: { texture: options.clip?.texture ?? this.white, unit: 2 },
      hasCoverage: options.coverage ? 1 : 0, coverage: { texture: options.coverage?.texture ?? this.white, unit: 3 },
      blendMode: mode === 0 ? -1 : mode, backdrop: { texture: backdrop?.texture ?? this.white, unit: 4 }, targetSize: [target.width, target.height],
    })
    this.bindQuad()
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.BLEND)
    if (backdrop) this.pool.give(backdrop)
  }

  private maskBackground(mask: Raster) {
    const cached = this.maskBackgrounds.get(mask)
    if (cached?.version === mask.version) return cached.value
    let sum = 0, count = 0
    const { width, height, data } = mask
    for (let x = 0; x < width; x++) { sum += data[x] + data[(height - 1) * width + x]; count += 2 }
    for (let y = 0; y < height; y++) { sum += data[y * width] + data[y * width + width - 1]; count += 2 }
    const value = sum / count / 255 >= 0.5 ? 1 : 0
    this.maskBackgrounds.set(mask, { version: mask.version, value })
    return value
  }

  private layerMask(layer: Layer): MaskSpec {
    if (!layer.mask || !layer.maskEnabled) return { mode: 0 }
    const texture = this.texture(layer.mask)
    const placed = layer.maskPlacement && !layer.isGroup && !layer.adjustment && JSON.stringify({ ...layer.maskPlacement, sampling: 0 }) !== JSON.stringify({ ...layer.transform, sampling: 0 })
    return placed ? { mode: 2, texture, unitToDoc: unitToDocument(layer.maskPlacement!), outside: this.maskBackground(layer.mask) } : { mode: 1, texture }
  }

  private effects(layer: Layer) {
    const mask = layer.mask && layer.maskEnabled ? layer.mask : null
    const key = `${layer.image!.version}:${mask?.version}:${JSON.stringify(layer.effects)}`
    const cached = this.effectsCache.get(layer.id)
    if (cached?.key === key) return cached
    if (cached) this.forget(cached.raster)
    const rendered = { key, ...renderEffects(layer.image!, mask, layer.effects!) }
    this.effectsCache.set(layer.id, rendered)
    return rendered
  }

  private opacity(entry: Entry) { return entry.ancestors.reduce((o, a) => o * a.opacity, entry.layer.opacity) }

  // The layer's own pixels, with effects, opacity, mask and blend mode.
  private drawOwn(entry: Entry, target: Target, options: { clip?: Target | null; coverage?: Target | null; blendMode?: Layer['blendMode'] }) {
    const { layer } = entry
    if (!layer.image) return
    const opacity = this.opacity(entry), blendMode = options.blendMode ?? layer.blendMode
    if (hasVisibleEffects(layer.effects)) {
      const { raster, inset } = this.effects(layer)
      const t = layer.transform, sx = raster.width / (raster.width - 2 * inset), sy = raster.height / (raster.height - 2 * inset)
      const grown: Transform = { ...t, origin: [t.origin[0] + t.size[0] / 2 - t.size[0] * sx / 2, t.origin[1] + t.size[1] / 2 - t.size[1] * sy / 2], size: [t.size[0] * sx, t.size[1] * sy] }
      this.draw(target, { texture: this.texture(raster), raster, width: raster.width, height: raster.height, unitToDoc: unitToDocument(grown), sampling: t.sampling, rotation: t.rotation }, { opacity, blendMode, clip: options.clip, coverage: options.coverage })
      return
    }
    const t = layer.transform
    this.draw(target, { texture: this.texture(layer.image), raster: layer.image, width: layer.image.width, height: layer.image.height, unitToDoc: unitToDocument(t), sampling: t.sampling, rotation: t.rotation }, { opacity, blendMode, mask: this.layerMask(layer), clip: options.clip, coverage: options.coverage })
  }

  // The product of enclosing folders' masks, each over its folder's own rectangle.
  private folderClip(ancestors: Layer[], used: Set<string>): Target | null {
    const masked = ancestors.filter(a => a.mask && a.maskEnabled)
    if (!masked.length) return null
    const key = masked.map(a => `${a.id}:${a.mask!.version}:${JSON.stringify(a.transform)}`).join('|') + `@${this.width}x${this.height}`
    used.add(key)
    const cached = this.clipCache.get(key)
    if (cached) return cached
    const target = new Target(this.gl, this.width, this.height, 'rgba8')
    target.bind()
    this.gl.clearColor(1, 1, 1, 1)
    this.gl.clear(this.gl.COLOR_BUFFER_BIT)
    for (const folder of masked) {
      const texture = this.texture(folder.mask!)
      setSampling(this.gl, folder.transform.sampling === 'Nearest' ? this.gl.NEAREST : this.gl.LINEAR)
      this.pass(target, this.clipProgram, { mask: { texture, unit: 0 }, targetToMask: invert(multiply(this.docToTarget, unitToDocument(folder.transform))), targetSize: [this.width, this.height] }, 'multiply')
    }
    this.clipCache.set(key, target)
    return target
  }

  private lut(adjustment: Adjustment) {
    if (this.luts.has(adjustment)) return this.luts.get(adjustment)!
    const gl = this.gl
    let result: { kind: 'table' | 'cube'; texture: WebGLTexture } | null = null
    const tables = channelTables(adjustment)
    if (tables) {
      const texture = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, 256, 3, 0, gl.RED, gl.FLOAT, tables)
      setSampling(gl, gl.LINEAR)
      result = { kind: 'table', texture }
    } else {
      const cube = adjustment.kind === 'Hue/Saturation' ? hueSaturationCube(adjustment) : kernelCube(adjustment)
      if (cube) {
        const texture = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_3D, texture)
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, cubeSize, cubeSize, cubeSize, 0, gl.RGBA, gl.FLOAT, cube)
        for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, p, v)
        result = { kind: 'cube', texture }
      }
    }
    this.luts.set(adjustment, result)
    return result
  }

  private blur(source: Target, sigma: number, direction: [number, number] | null): Target {
    const gl = this.gl
    let input = source, factor = 1
    const reduce = direction ? 1 : Math.max(1, 2 ** Math.floor(Math.log2(sigma / 6)))
    const chainTargets: Target[] = []
    while (factor < reduce) {
      const next = this.pool.take(Math.max(1, Math.ceil(input.width / 2)), Math.max(1, Math.ceil(input.height / 2)))
      gl.bindTexture(gl.TEXTURE_2D, input.texture)
      setSampling(gl, gl.LINEAR)
      this.pass(next, this.copyProgram, { source: { texture: input.texture, unit: 0 }, mode: 0 })
      if (input !== source) chainTargets.push(input)
      input = next
      factor *= 2
    }
    const s = sigma / factor
    const run = (from: Target, dir: [number, number]) => {
      const out = this.pool.take(from.width, from.height)
      const reach = 3 * s, taps = Math.min(64, Math.ceil(reach)), step = Math.max(1, reach / taps)
      gl.bindTexture(gl.TEXTURE_2D, from.texture)
      setSampling(gl, gl.LINEAR)
      this.pass(out, this.blurProgram, { source: { texture: from.texture, unit: 0 }, direction: dir, sigma: s, taps, step })
      return out
    }
    let result: Target
    if (direction) result = run(input, direction)
    else { const h = run(input, [1, 0]); result = run(h, [0, 1]); this.pool.give(h) }
    if (input !== source) chainTargets.push(input)
    if (factor > 1) {
      const full = this.pool.take(source.width, source.height)
      gl.bindTexture(gl.TEXTURE_2D, result.texture)
      setSampling(gl, gl.LINEAR)
      this.pass(full, this.copyProgram, { source: { texture: result.texture, unit: 0 }, mode: 0 })
      this.pool.give(result)
      result = full
    }
    chainTargets.forEach(t => this.pool.give(t))
    return result
  }

  // What an adjustment layer makes of `original`, or null when it changes nothing.
  private adjusted(adjustment: Adjustment, original: Target): Target | null {
    const gl = this.gl
    const kind = adjustment.kind
    if (kind === 'Gaussian Blur') return this.blur(original, Math.max(0.1, adjustment.blurRadius ?? 10) * this.renderScale, null)
    if (kind === 'Motion Blur') {
      const angle = (adjustment.motionAngle ?? 0) * Math.PI / 180
      return this.blur(original, (adjustment.motionDistance ?? 10) * this.renderScale / Math.sqrt(12), [Math.cos(angle), -Math.sin(angle)])
    }
    const out = this.pool.take(original.width, original.height)
    gl.bindTexture(gl.TEXTURE_2D, original.texture)
    setSampling(gl, gl.NEAREST)
    const base = { source: { texture: original.texture, unit: 0 }, table: { texture: this.white, unit: 1 }, unitsPerPixel: 1 / this.renderScale }
    if (kind === 'Invert') this.pass(out, this.adjustProgram, { ...base, mode: 3 })
    else if (kind === 'Grain') {
      const g = adjustment.grainSettings ?? { amount: 25, size: 1.5, roughness: 50, seed: 0 }
      if (!(g.amount > 0)) { this.pool.give(out); return null }
      this.pass(out, this.adjustProgram, { ...base, mode: 4, seed: g.seed, params: [g.amount, g.size > 0 ? g.size : 1, g.roughness, 0] })
    } else if (kind === 'Add Noise') {
      this.pass(out, this.adjustProgram, { ...base, mode: 5, seed: adjustment.noiseSeed ?? 0, params: [Math.min(400, Math.max(0.1, adjustment.noiseAmount ?? 10)), 0, 0, 0], gaussian: adjustment.noiseGaussian ? 1 : 0, monochromatic: adjustment.noiseMonochromatic ? 1 : 0 })
    } else {
      const lut = this.lut(adjustment)
      if (!lut) { this.pool.give(out); return null }
      this.pass(out, this.adjustProgram, { ...base, mode: lut.kind === 'table' ? 1 : 2, cube: { texture: lut.kind === 'cube' ? lut.texture : undefined, unit: 2, target: gl.TEXTURE_3D }, table: { texture: lut.kind === 'table' ? lut.texture : this.white, unit: 1 } })
    }
    return out
  }

  private applyAdjustment(entry: Entry, target: Target, clip: Target | null) {
    const { layer } = entry
    const original = this.pool.take(target.width, target.height)
    this.copy(target, original)
    const adjusted = this.adjusted(layer.adjustment!, original)
    if (adjusted) {
      const hasMask = !!(layer.mask && layer.maskEnabled)
      if (hasMask) { this.texture(layer.mask!); setSampling(this.gl, layer.transform.sampling === 'Nearest' ? this.gl.NEAREST : this.gl.LINEAR) }
      this.pass(target, this.mixProgram, {
        original: { texture: original.texture, unit: 0 }, adjusted: { texture: adjusted.texture, unit: 1 }, blendMode: blendModes.indexOf(layer.blendMode), opacity: this.opacity(entry),
        hasMask: hasMask ? 1 : 0, mask: { texture: hasMask ? this.texture(layer.mask!) : this.white, unit: 2 }, targetToMask: invert(multiply(this.docToTarget, unitToDocument(layer.transform))), targetSize: [target.width, target.height],
        hasClip: clip ? 1 : 0, clip: { texture: clip?.texture ?? this.white, unit: 3 },
      })
      this.pool.give(adjusted)
    }
    this.pool.give(original)
  }

  // Composites the document into `output` at `renderScale`. `hidden` leaves layers out (e.g. while a tool previews them elsewhere).
  render(doc: Doc, renderScale = 1): Target {
    const gl = this.gl
    this.renderScale = renderScale
    const width = Math.max(1, Math.round(doc.width * renderScale)), height = Math.max(1, Math.round(doc.height * renderScale))
    if (width !== this.width || height !== this.height) {
      this.output?.dispose()
      this.output = new Target(gl, width, height, 'rgba8', true)
      this.pool.trim(width, height)
      this.clipCache.forEach(t => t.dispose())
      this.clipCache.clear()
      this.width = width; this.height = height
    }
    const canvas = this.output!
    canvas.bind(true)
    const entries = drawOrder(doc)
    const byId = new Map(entries.map(e => [e.layer.id, e]))
    const drawn = entries.filter(e => effectivelyVisible(e) && !e.layer.isGroup)
    const stacks = new Map<string, Entry[]>(), stacked = new Set<string>()
    drawn.forEach((base, i) => {
      if (base.layer.clipTo || base.layer.adjustment) return
      const children: Entry[] = []
      for (const child of drawn.slice(i + 1)) {
        if (child.layer.clipTo !== base.layer.id || child.layer.parentId !== base.layer.parentId) break
        children.push(child)
      }
      if (children.length) { stacks.set(base.layer.id, children); children.forEach(c => stacked.add(c.layer.id)) }
    })
    const used = new Set<string>()
    const coverages = new Map<string, Target>()
    const coverage = (id: string, depth = 0): Target | null => {
      if (coverages.has(id)) return coverages.get(id)!
      const source = byId.get(id)
      if (!source || source.layer.isGroup || source.layer.adjustment || depth > 256) return null
      const target = this.pool.take(width, height)
      this.drawOwn(source, target, { coverage: source.layer.clipTo ? coverage(source.layer.clipTo, depth + 1) : null, blendMode: 'Normal' })
      coverages.set(id, target)
      return target
    }
    for (const entry of drawn) {
      const { layer } = entry
      if (stacked.has(layer.id)) continue
      const clip = this.folderClip(entry.ancestors, used)
      if (layer.adjustment) { if (!layer.clipTo) this.applyAdjustment(entry, canvas, clip); continue }
      const children = stacks.get(layer.id)
      if (children) { this.drawStack(entry, children, canvas, clip); continue }
      this.drawOwn(entry, canvas, { clip, coverage: layer.clipTo ? coverage(layer.clipTo) : null })
    }
    coverages.forEach(t => this.pool.give(t))
    for (const [key, target] of this.clipCache) if (!used.has(key)) { target.dispose(); this.clipCache.delete(key) }
    for (const id of this.effectsCache.keys()) if (!byId.has(id)) this.effectsCache.delete(id)
    gl.bindTexture(gl.TEXTURE_2D, canvas.texture)
    gl.generateMipmap(gl.TEXTURE_2D)
    return canvas
  }

  // A clipping base and the layers clipped to it: the children draw over the base's colors made opaque, then the result is cut
  // back to the base's coverage and blended onto the canvas in the base's mode.
  private drawStack(base: Entry, children: Entry[], canvas: Target, clip: Target | null) {
    const { width, height } = canvas
    const group = this.pool.take(width, height)
    this.drawOwn(base, group, { blendMode: 'Normal' })
    const alpha = this.pool.take(width, height)
    this.copy(group, alpha)
    this.pass(group, this.copyProgram, { source: { texture: alpha.texture, unit: 0 }, mode: 1 })
    for (const child of children) {
      if (child.layer.adjustment) this.applyAdjustment(child, group, null)
      else this.drawOwn(child, group, {})
    }
    const restored = this.pool.take(width, height)
    this.pass(restored, this.copyProgram, { source: { texture: group.texture, unit: 0 }, mode: 2, alpha: { texture: alpha.texture, unit: 1 } })
    this.draw(canvas, { texture: restored.texture, width, height, unitToDoc: unitToDocument({ origin: [0, 0], size: [width / this.renderScale, height / this.renderScale], rotation: 0, flipX: false, flipY: false, sampling: 'Nearest' }), sampling: 'Exact', rotation: 0 }, { opacity: 1, blendMode: base.layer.blendMode, clip })
    ;[group, alpha, restored].forEach(t => this.pool.give(t))
  }

  // Draws the composite into the visible canvas: `documentToScreen` maps document pixels to device pixels.
  present(documentToScreen: Mat3, screenWidth: number, screenHeight: number, background: [number, number, number]) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, screenWidth, screenHeight)
    gl.clearColor(...background, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (!this.output) return
    const docWidth = this.width / this.renderScale, docHeight = this.height / this.renderScale
    const zoom = Math.hypot(documentToScreen[0], documentToScreen[1]) * this.renderScale
    gl.bindTexture(gl.TEXTURE_2D, this.output.texture)
    setSampling(gl, zoom >= 1 ? gl.NEAREST : gl.LINEAR_MIPMAP_LINEAR)
    const toClip = chain(translate(-1, 1), scale(2 / screenWidth, -2 / screenHeight), documentToScreen, scale(docWidth, docHeight))
    use(gl, this.displayProgram, { toClip, toSource: identity(), image: { texture: this.output.texture, unit: 0 }, docSize: [docWidth, docHeight], zoom })
    this.bindQuad()
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  // The composite's premultiplied pixels, top row first.
  read(target = this.output!): Raster {
    const gl = this.gl
    const out = new Raster(target.width, target.height, 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, out.data)
    return out
  }
}
