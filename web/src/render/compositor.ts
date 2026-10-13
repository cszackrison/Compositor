import { type Mat3, type Program, Target, TargetPool, chain, compile, invert, multiply, rotate, scale, setSampling, translate, use, apply, identity } from './gl'
import { adjustFragment, adjustMixFragment, blurFragment, clipFragment, copyFragment, deepFlattenFragment, displayFragment, layerFragment, passVertex } from './shaders'
import { renderEffects, hasVisibleEffects } from './effects'
import { channelTables, hueSaturationCube, kernelCube, cubeSize } from '../model/adjustments'
import { type Adjustment, type Doc, type Layer, type Transform, blendModes } from '../model/types'
import { type Deep, deepOf, sixteenToHalf } from '../model/deep'
import { Raster } from '../model/raster'
import { layerToMask, maskOnGrid } from '../model/masks'

// Layer unit square (0…1 on both axes, row 0 at the top) to document pixels: about the center, clockwise rotation, flips inside the box.
export function unitToDocument(t: Transform): Mat3 {
  const radians = (t.rotation % 360) * Math.PI / 180
  return chain(translate(t.origin[0] + t.size[0] / 2, t.origin[1] + t.size[1] / 2), rotate(radians), scale(t.size[0] * (t.flipX ? -1 : 1), t.size[1] * (t.flipY ? -1 : 1)), translate(-0.5, -0.5))
}

// The same, for a W×H pixel grid (pixel corners at integers), as BrushRaster.pixelToDocument.
export function pixelToDocument(t: Transform, width: number, height: number): Mat3 {
  return multiply(unitToDocument(t), scale(1 / width, 1 / height))
}

// Rebuilds a layer's transform after its group's box goes from `from` to `to` (LayerTransform.following), dropping any shear.
export function following(layer: Transform, from: Transform, to: Transform): Transform {
  if (from.size[0] === to.size[0] && from.size[1] === to.size[1] && from.rotation === to.rotation && from.flipX === to.flipX && from.flipY === to.flipY)
    return { ...layer, origin: [layer.origin[0] + to.origin[0] - from.origin[0], layer.origin[1] + to.origin[1] - from.origin[1]] }
  const m = chain(unitToDocument(to), invert(unitToDocument(from)), unitToDocument(layer))
  const [cx, cy] = apply(m, 0.5, 0.5)
  const s = layer.flipX ? -1 : 1
  const a = m[0], b = m[1], c = m[3], d = m[4]
  let angle = Math.atan2(b * s, a * s) * 180 / Math.PI
  while (angle - layer.rotation > 180) angle -= 360
  while (angle - layer.rotation < -180) angle += 360
  const r = angle * Math.PI / 180, width = Math.hypot(a, b), along = -c * Math.sin(r) + d * Math.cos(r), height = Math.abs(along)
  return { ...layer, rotation: Math.round(angle * 1000) / 1000, origin: [cx - width / 2, cy - height / 2], size: [width, height], flipY: along < 0 }
}

// Scales the box by dragging one handle in its own rotated frame, the opposite side (or the center, with Option) staying put. Corners
// keep the ratio unless Shift. Dragging past the opposite side flips the box on that axis.
export function transformCorners(t: Transform) {
  const m = unitToDocument(t)
  return [apply(m, 0, 0), apply(m, 1, 0), apply(m, 1, 1), apply(m, 0, 1)]
}

type Entry = { layer: Layer; ancestors: Layer[] }
type Source = { texture: WebGLTexture; width: number; height: number; unitToDoc: Mat3; sampling: Transform['sampling'] | 'Exact'; rotation: number; raster?: Raster; mipmapped?: boolean }
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

type Part = { key: string; version: number; texture: WebGLTexture; step: number; width: number; height: number }
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
  private releasedTargets = new FinalizationRegistry<Target>(target => target.dispose())
  private luts = new WeakMap<Adjustment, { kind: 'table' | 'cube'; texture: WebGLTexture } | null>()
  // `made` orders results by when they were started, so a worker result never replaces one made after it.
  // `made` orders results by when they were started, so a worker result never replaces one made after it; `from` is the image's
  // size and the layer's transform it was made from, to draw a result that's waiting to be redone where it belongs.
  private effectsCache = new Map<string, { key: string; raster: Raster; inset: number; made: number; from: { width: number; height: number; transform: Transform } }>()
  // Effects being redone in the worker, by layer: the one running and the newest waiting.
  private effectsJobs = new Map<string, { running: string; next: { key: string; layer: Layer } | null }>()
  private effectsWorker: Worker | null | undefined
  // The effects result each layer was last drawn with, so a newer one arriving from the worker redraws it.
  private drawnEffects = new Map<string, object>()
  private clipCache = new Map<string, Target>()
  private maskBackgrounds = new WeakMap<Raster, { version: number; value: number }>()
  private white: WebGLTexture
  output: Target | null = null
  renderScale = 1
  // Redrawing only what changed: the area this frame is limited to (target pixels; null redraws everything), the document as
  // last drawn, and areas GPU work changed in rasters whose textures are already current (gpuWarp.ts).
  private region: { x: number; y: number; w: number; h: number } | null = null
  private previous: { doc: Doc; width: number; height: number; scale: number } | null = null
  private gpuChanges = new Map<Raster, { x0: number; y0: number; x1: number; y1: number }>()
  // The canvas after the layers below the one being edited, kept while an edit goes on above them: each frame starts from it and
  // draws only the rest. `signatures` says what each of those layers was; `last` is every layer's, as of the last frame.
  private prefix: { target: Target; signatures: string[] } | null = null
  private lastSignatures: string[] = []
  private ids = new WeakMap<object, number>()
  private nextId = 1
  private width = 0
  private height = 0
  // Half-float targets, for a document with a 16-bit or HDR layer: its tones between 8-bit levels, and an HDR layer's light brighter
  // than white, carry through the layers and adjustments above it (Exposure turned down brings highlights into view) and out to an
  // EXR export; the screen shows it clipped to white, dithered.
  hdr = false
  private floatTargets: boolean
  private deepTextures = new WeakMap<Deep, { deep: WebGLTexture; base: WebGLTexture; flat: Target; version: number }>()
  private flattenProgram: Program

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    // `desynchronized` lets Chrome show frames without waiting on the page's compositor, cutting the delay between a finger and the
    // stroke under it.
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: false, antialias: false, preserveDrawingBuffer: false, desynchronized: true } as WebGLContextAttributes) as WebGL2RenderingContext | null
    if (!gl) throw new Error('This browser does not support WebGL 2, which Compositor needs.')
    this.gl = gl
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float')
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
    this.flattenProgram = compile(gl, deepFlattenFragment, passVertex)
    this.pool = new TargetPool(gl, 'rgba8')
    this.white = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.white)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
  }

  // Uploads a raster (or just what changed in it) and returns its texture. One larger than the GPU takes comes reduced to fit.
  texture(raster: Raster, mipmaps = false): WebGLTexture {
    if (Math.max(raster.width, raster.height) > this.maxSize) return this.part(raster, 0, 0, raster.width, raster.height).texture
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
      // The texture has it all now: the next change starts a fresh dirty rectangle instead of growing this one all stroke long.
      raster.dirty = null
    }
    gl.bindTexture(gl.TEXTURE_2D, record.texture)
    if (mipmaps && record.mipVersion !== record.version) { gl.generateMipmap(gl.TEXTURE_2D); record.mipVersion = record.version }
    return record.texture
  }

  // A source's texture: one too large for the GPU is cut down when it's drawn (`fitted`), so none is made for it here.
  private sourceTexture(raster: Raster) { return Math.max(raster.width, raster.height) > this.maxSize ? this.white : this.texture(raster) }

  // The part of a raster too large for the GPU that's at `x`, `y`, `w` × `h` (its pixels), reduced by whole steps until it fits: the
  // part a tile or the view shows. The last one made for each raster is kept.
  private parts = new WeakMap<Raster, Part>()
  private releasedParts = new FinalizationRegistry<{ texture: WebGLTexture }>(part => this.gl.deleteTexture(part.texture))
  // A region's own parts (renderRegion), let go when it's done, so the live view's stay as they are.
  private regionParts: Map<Raster, Part> | null = null
  private part(raster: Raster, x: number, y: number, w: number, h: number) {
    const gl = this.gl, key = `${x},${y},${w},${h}`, parts = this.regionParts ?? this.parts, kept = parts.get(raster)
    if (kept?.key === key && kept.version === raster.version) return kept
    const channels = raster.channels, format = channels === 4 ? gl.RGBA : gl.RED
    // What changed since the part was made, when that's known (a stroke on the layer), or all of it.
    const changed = kept?.key === key && raster.dirty && raster.dirtyFrom <= kept.version ? raster.dirty : null
    let part = kept
    if (!part || !changed) {
      if (kept) gl.deleteTexture(kept.texture)
      const step = Math.ceil(Math.max(w, h) / this.maxSize), width = Math.ceil(w / step), height = Math.ceil(h / step)
      const texture = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(width, height))) + 1, channels === 4 ? gl.RGBA8 : gl.R8, width, height)
      part = { key, version: raster.version, texture, step, width, height }
      parts.set(raster, part)
      if (!this.regionParts) this.releasedParts.register(raster, part)
    }
    const { step } = part
    // The texels to bring up to date, and the pixels they average.
    const t0 = changed ? Math.max(0, Math.floor((changed.x - x) / step)) : 0, u0 = changed ? Math.max(0, Math.floor((changed.y - y) / step)) : 0
    const t1 = changed ? Math.min(part.width, Math.ceil((changed.x + changed.w - x) / step)) : part.width, u1 = changed ? Math.min(part.height, Math.ceil((changed.y + changed.h - y) / step)) : part.height
    if (t1 > t0 && u1 > u0) {
      const tw = t1 - t0, th = u1 - u0, out = new Uint8Array(tw * th * channels), src = raster.data
      if (step === 1) for (let r = 0; r < th; r++) { const from = ((y + u0 + r) * raster.width + x + t0) * channels; out.set(src.subarray(from, from + tw * channels), r * tw * channels) }
      else {
        const sums = new Float64Array(tw * channels), counts = new Uint32Array(tw)
        for (let r = 0; r < th; r++) {
          sums.fill(0); counts.fill(0)
          const sy0 = y + (u0 + r) * step, sx0 = x + t0 * step, sx1 = Math.min(x + w, x + t1 * step)
          for (let sy = sy0; sy < Math.min(y + h, sy0 + step); sy++) for (let sx = sx0; sx < sx1; sx++) {
            const t = Math.floor((sx - sx0) / step), i = (sy * raster.width + sx) * channels
            counts[t]++
            for (let c = 0; c < channels; c++) sums[t * channels + c] += src[i + c]
          }
          for (let t = 0; t < tw; t++) for (let c = 0; c < channels; c++) out[(r * tw + t) * channels + c] = Math.round(sums[t * channels + c] / Math.max(1, counts[t]))
        }
      }
      gl.bindTexture(gl.TEXTURE_2D, part.texture)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, t0, u0, tw, th, format, gl.UNSIGNED_BYTE, out)
      gl.generateMipmap(gl.TEXTURE_2D)
    }
    gl.bindTexture(gl.TEXTURE_2D, part.texture)
    setSampling(gl, gl.LINEAR)
    part.version = raster.version
    if (!this.regionParts) raster.dirty = null
    return part
  }

  // A source too large for the GPU, cut to what `target` shows of it (on a coarse grid, so a view that pans a little keeps it).
  private fitted(source: Source, target: Target): Source | null {
    const raster = source.raster!, W = raster.width, H = raster.height, toTarget = multiply(this.docToTarget, source.unitToDoc), toUnit = invert(toTarget)
    const [ox, oy] = apply(toTarget, 0, 0), [ux, uy] = apply(toTarget, 1, 0), perPixel = Math.hypot(ux - ox, uy - oy) / W
    const corners = [[0, 0], [target.width, 0], [0, target.height], [target.width, target.height]].map(([x, y]) => apply(toUnit, x, y))
    const margin = 4 + 2 / Math.max(1e-6, perPixel)
    const span = (grid: number) => [
      Math.max(0, Math.floor((Math.min(...corners.map(c => c[0])) * W - margin) / grid) * grid), Math.max(0, Math.floor((Math.min(...corners.map(c => c[1])) * H - margin) / grid) * grid),
      Math.min(W, Math.ceil((Math.max(...corners.map(c => c[0])) * W + margin) / grid) * grid), Math.min(H, Math.ceil((Math.max(...corners.map(c => c[1])) * H + margin) / grid) * grid),
    ]
    let [x0, y0, x1, y1] = span(1024)
    if (Math.max(x1 - x0, y1 - y0) > this.maxSize) [x0, y0, x1, y1] = span(1)
    if (x1 <= x0 || y1 <= y0) return null
    const part = this.part(raster, x0, y0, x1 - x0, y1 - y0)
    return { texture: part.texture, mipmapped: true, width: part.width, height: part.height, unitToDoc: multiply(source.unitToDoc, chain(translate(x0 / W, y0 / H), scale(part.width * part.step / W, part.height * part.step / H))), sampling: source.sampling, rotation: source.rotation }
  }

  // A 16-bit or HDR layer's pixels as a half-float texture with mipmaps: its deep pixels, uploaded once, with its paint laid over them
  // on the GPU whenever its 8-bit copy changes, so strokes show as they're made.
  private deepTexture(layer: Layer, deep: Deep): WebGLTexture {
    const gl = this.gl, image = layer.image!
    let record = this.deepTextures.get(deep)
    if (!record) {
      const upload = (format: number, type: number, data: ArrayBufferView) => {
        const texture = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texStorage2D(gl.TEXTURE_2D, 1, format, deep.width, deep.height)
        setSampling(gl, gl.NEAREST)
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, deep.width, deep.height, gl.RGBA, type, data)
        return texture
      }
      const halves = deep.hdr ? deep.pixels : new Uint16Array(deep.pixels.length)
      if (!deep.hdr) for (let i = 0; i < halves.length; i++) halves[i] = sixteenToHalf[deep.pixels[i]]
      record = { deep: upload(gl.RGBA16F, gl.HALF_FLOAT, halves), base: upload(gl.RGBA8, gl.UNSIGNED_BYTE, deep.base), flat: new Target(gl, deep.width, deep.height, 'rgba16f', true), version: -1 }
      this.deepTextures.set(deep, record)
      const made = record
      this.released.register(deep, made.deep); this.released.register(deep, made.base); this.releasedTargets.register(deep, made.flat)
    }
    if (record.version !== image.version) {
      gl.disable(gl.SCISSOR_TEST)
      this.pass(record.flat, this.flattenProgram, { deep: { texture: record.deep, unit: 0 }, painted: { texture: this.texture(image), unit: 1 }, base: { texture: record.base, unit: 2 } })
      gl.bindTexture(gl.TEXTURE_2D, record.flat.texture)
      gl.generateMipmap(gl.TEXTURE_2D)
      record.version = image.version
    }
    return record.flat.texture
  }

  // A raster whose texture the GPU has just drawn into (Smudge and Liquify, see gpuWarp.ts), with its bytes brought back to match:
  // the texture is current, so it isn't uploaded again, though its mipmaps need making afresh.
  markCurrent(raster: Raster, rect?: { x0: number; y0: number; x1: number; y1: number }) {
    raster.touch()
    const record = this.textures.get(raster)
    if (record) record.version = raster.version
    if (rect) { const d = this.gpuChanges.get(raster); this.gpuChanges.set(raster, d ? { x0: Math.min(d.x0, rect.x0), y0: Math.min(d.y0, rect.y0), x1: Math.max(d.x1, rect.x1), y1: Math.max(d.y1, rect.y1) } : rect) }
  }

  // What changed since the last frame, in target pixels, when all that changed is some layers' pixels in known places (null if
  // nothing did); 'all' otherwise. Blur adjustment layers read their neighbors, so a document with one redraws it all.
  private changes(doc: Doc, entries: Entry[]): { x0: number; y0: number; x1: number; y1: number } | 'all' | null {
    const previous = this.previous
    if (!previous || previous.width !== this.width || previous.height !== this.height || previous.scale !== this.renderScale) return 'all'
    const before = previous.doc.layers
    if (before.length !== doc.layers.length || doc.layers.some((layer, i) => layer !== before[i])) return 'all'
    let area: { x0: number; y0: number; x1: number; y1: number } | null = null
    const add = (raster: Raster, transform: Transform, rect: { x0: number; y0: number; x1: number; y1: number }) => {
      // Two texels of filtering reach on every side, then three target pixels for antialiasing and mipmaps.
      const m = multiply(this.docToTarget, pixelToDocument(transform, raster.width, raster.height))
      const corners = [[rect.x0 - 2, rect.y0 - 2], [rect.x1 + 2, rect.y0 - 2], [rect.x1 + 2, rect.y1 + 2], [rect.x0 - 2, rect.y1 + 2]].map(([x, y]) => apply(m, x, y))
      const x0 = Math.floor(Math.min(...corners.map(c => c[0]))) - 3, y0 = Math.floor(Math.min(...corners.map(c => c[1]))) - 3
      const x1 = Math.ceil(Math.max(...corners.map(c => c[0]))) + 3, y1 = Math.ceil(Math.max(...corners.map(c => c[1]))) + 3
      area = area ? { x0: Math.min(area.x0, x0), y0: Math.min(area.y0, y0), x1: Math.max(area.x1, x1), y1: Math.max(area.y1, y1) } : { x0, y0, x1, y1 }
    }
    for (const { layer } of entries) {
      const visible = !layer.isGroup || !!layer.mask
      if (layer.adjustment && (layer.adjustment.kind === 'Gaussian Blur' || layer.adjustment.kind === 'Motion Blur') && layer.visible) return 'all'
      if (layer.image && hasVisibleEffects(layer.effects)) {
        // A new result, or a switch between drawing it as is and drawing a waiting one under the layer, redraws everything; while
        // one waits, the layer's own pixels change in known places like any other layer's.
        const cached = this.effectsCache.get(layer.id)
        if (!cached || cached !== this.drawnEffects.get(layer.id) || this.staleEffects(layer, cached) !== this.drawnStale.get(layer.id)) return 'all'
      }
      if (!visible) continue
      const owned: [Raster | null | undefined, Transform][] = [[layer.image, layer.transform], [layer.mask, layer.maskPlacement && !layer.isGroup && !layer.adjustment ? layer.maskPlacement : layer.transform]]
      for (const [raster, transform] of owned) {
        if (!raster) continue
        const gpu = this.gpuChanges.get(raster)
        if (gpu) add(raster, transform, gpu)
        // A raster never drawn (a hidden layer, a disabled mask) isn't in the picture; showing it changes its layer.
        const record = this.textures.get(raster)
        if (!record || record.version === raster.version) continue
        const dirty = raster.dirty && raster.dirtyFrom <= record.version ? raster.dirty : null
        if (!dirty) return 'all'
        add(raster, transform, { x0: dirty.x, y0: dirty.y, x1: dirty.x + dirty.w, y1: dirty.y + dirty.h })
      }
    }
    return area
  }

  // What a drawing step depends on besides the canvas below it: the layer itself (its settings), its pixels and mask, its folders'
  // masks, what it's clipped to, and for effects the result in use.
  private signature(entry: Entry, children: Entry[] = []): string {
    const id = (o: object) => { let n = this.ids.get(o); if (!n) { n = this.nextId++; this.ids.set(o, n) } return n }
    const one = (e: Entry): string => {
      const l = e.layer, clip = l.clipTo ? this.byIdForSignature?.get(l.clipTo) : null
      const effects = l.image && hasVisibleEffects(l.effects) ? `fx${this.effectsCache.get(l.id)?.key}` : ''
      return `${id(l)}:${l.image?.version}:${l.mask?.version}:${e.ancestors.map(a => `${id(a)}.${a.mask?.version}`).join(',')}:${clip ? one(clip) : ''}${effects}`
    }
    return [entry, ...children].map(one).join('|')
  }
  private byIdForSignature: Map<string, Entry> | null = null

  // Scissors to a layer's bounds within this frame's region; false when they don't meet.
  private limit(x0: number, y0: number, x1: number, y1: number) {
    const r = this.region
    if (r) { x0 = Math.max(x0, r.x); y0 = Math.max(y0, r.y); x1 = Math.min(x1, r.x + r.w); y1 = Math.min(y1, r.y + r.h) }
    if (x1 <= x0 || y1 <= y0) return false
    this.gl.enable(this.gl.SCISSOR_TEST)
    this.gl.scissor(x0, y0, x1 - x0, y1 - y0)
    return true
  }
  // Back to the frame's region (or no scissor at all).
  private unlimit() {
    const gl = this.gl, r = this.region
    if (r) { gl.enable(gl.SCISSOR_TEST); gl.scissor(r.x, r.y, r.w, r.h) } else gl.disable(gl.SCISSOR_TEST)
  }

  get quadArray() { return this.quad }
  private get format() { return this.hdr ? 'rgba16f' as const : 'rgba8' as const }

  forget(raster: Raster) {
    const record = this.textures.get(raster)
    if (record) { this.released.unregister(record); this.gl.deleteTexture(record.texture); this.textures.delete(raster) }
  }

  // Where the target's top-left corner is in the document: the origin for the whole canvas, a tile's corner for a region.
  private origin: [number, number] = [0, 0]
  private get docToTarget(): Mat3 { return chain(scale(this.renderScale), translate(-this.origin[0], -this.origin[1])) }
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
    if (source.raster && Math.max(source.raster.width, source.raster.height) > this.maxSize) {
      // Cut down, the source no longer spans the layer: its mask is placed over the layer's own rectangle instead.
      if (options.mask?.mode === 1) options = { ...options, mask: { mode: 2, texture: options.mask.texture, unitToDoc: source.unitToDoc, outside: 0 } }
      const fitted = this.fitted(source, target)
      if (!fitted) return
      source = fitted
    }
    const toTarget = multiply(this.docToTarget, source.unitToDoc)
    const [ox, oy] = apply(toTarget, 0, 0), [ux, uy] = apply(toTarget, 1, 0)
    const factor = Math.hypot(ux - ox, uy - oy) / source.width
    const exact = source.sampling === 'Exact' || (source.rotation % 360 === 0 && Math.abs(factor - 1) < 0.001 && Math.abs(ox - Math.round(ox)) < 0.001 && Math.abs(oy - Math.round(oy)) < 0.001)
    const nearest = exact || source.sampling === 'Nearest'
    const shrinking = factor < 0.999
    if (source.raster) this.texture(source.raster, !nearest && factor < 0.5)
    gl.bindTexture(gl.TEXTURE_2D, source.texture)
    setSampling(gl, nearest ? gl.NEAREST : shrinking && factor < 0.5 && (source.raster || source.mipmapped) ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    const filterMode = !nearest && !shrinking && source.sampling === 'High quality' ? 1 : 0
    if (filterMode === 1) setSampling(gl, gl.NEAREST)
    const margin = nearest ? 0 : 2 / Math.max(1e-6, Math.min(Math.hypot(ux - ox, uy - oy), Math.hypot(...(([a, b]) => [a - ox, b - oy])(apply(toTarget, 0, 1)))))
    const expand = chain(translate(-margin, -margin), scale(1 + 2 * margin))
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => apply(multiply(toTarget, expand), x, y))
    const x0 = Math.max(0, Math.floor(Math.min(...corners.map(c => c[0])))), y0 = Math.max(0, Math.floor(Math.min(...corners.map(c => c[1]))))
    const x1 = Math.min(target.width, Math.ceil(Math.max(...corners.map(c => c[0])))), y1 = Math.min(target.height, Math.ceil(Math.max(...corners.map(c => c[1]))))
    if (x1 <= x0 || y1 <= y0) return
    if (!this.limit(x0, y0, x1, y1)) { this.unlimit(); return }
    this.unlimit()
    const mode = blendModes.indexOf(options.blendMode)
    let backdrop: Target | null = null
    if (mode !== 0) {
      backdrop = this.pool.take(target.width, target.height)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, backdrop.framebuffer)
      gl.blitFramebuffer(x0, y0, x1, y1, x0, y0, x1, y1, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    }
    target.bind()
    this.limit(x0, y0, x1, y1)
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
      blendMode: mode === 0 ? -1 : mode, backdrop: { texture: backdrop?.texture ?? this.white, unit: 4 }, targetSize: [target.width, target.height], hdr: this.hdr ? 1 : 0,
    })
    this.bindQuad()
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    this.unlimit()
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

  // Effects are worked out on the CPU. The first time a layer shows them they're made here; after that, while its pixels or
  // settings change, the live view keeps drawing the last result and the worker makes the new one, redrawing when it's ready.
  // Exports and merges (not the live view) always make them here, so they're current.
  private effects(layer: Layer) {
    const mask = this.effectsMask(layer)
    const key = this.effectsKey(layer)
    const cached = this.effectsCache.get(layer.id)
    if (cached?.key === key) return cached
    if (cached && this.live && this.requestEffects(layer, key)) return cached
    if (cached && cached.raster !== layer.image) this.forget(cached.raster)
    this.readBack.get(layer.image!)?.()
    if (mask) this.readBack.get(mask)?.()
    const rendered = { key, made: this.nextId++, from: { width: layer.image!.width, height: layer.image!.height, transform: layer.transform }, ...renderEffects(layer.image!, mask, layer.effects!) }
    this.effectsCache.set(layer.id, rendered)
    return rendered
  }

  private requestEffects(layer: Layer, key: string): boolean {
    if (this.effectsWorker === undefined) {
      try {
        this.effectsWorker = new Worker(new URL('./effectsWorker.ts', import.meta.url), { type: 'module' })
        this.effectsWorker.onmessage = (event: MessageEvent<{ id: number; width: number; height: number; data: Uint8Array; inset: number }>) => this.effectsDone(event.data)
        this.effectsWorker.onerror = () => { this.effectsWorker = null; this.effectsJobs.clear() }
      } catch { this.effectsWorker = null }
    }
    if (!this.effectsWorker) return false
    const job = this.effectsJobs.get(layer.id)
    if (job) { if (job.running !== key) job.next = { key, layer }; return true }
    this.startEffects(layer, key)
    return true
  }

  private effectsIds = new Map<number, { layerId: string; key: string; made: number; from: { width: number; height: number; transform: Transform } }>()
  // Rasters whose newest pixels are on the GPU (a brush stroke in progress), with how to bring them back before anything reads them.
  readBack = new Map<Raster, () => void>()

  private startEffects(layer: Layer, key: string) {
    const id = this.nextId++
    this.readBack.get(layer.image!)?.()
    if (layer.mask) this.readBack.get(layer.mask)?.()
    const mask = this.effectsMask(layer)
    const pixels = (r: Raster) => ({ width: r.width, height: r.height, channels: r.channels, data: r.data.slice() })
    const image = pixels(layer.image!), maskPixels = mask ? pixels(mask) : null
    this.effectsJobs.set(layer.id, { running: key, next: null })
    this.effectsIds.set(id, { layerId: layer.id, key, made: id, from: { width: layer.image!.width, height: layer.image!.height, transform: layer.transform } })
    this.effectsWorker!.postMessage({ id, image, mask: maskPixels, effects: layer.effects }, { transfer: [image.data.buffer, ...(maskPixels ? [maskPixels.data.buffer] : [])] })
  }

  private effectsDone({ id, width, height, data, inset }: { id: number; width: number; height: number; data: Uint8Array; inset: number }) {
    const job = this.effectsIds.get(id)
    this.effectsIds.delete(id)
    if (!job) return
    const waiting = this.effectsJobs.get(job.layerId)
    this.effectsJobs.delete(job.layerId)
    const cached = this.effectsCache.get(job.layerId)
    if (!cached || cached.made < job.made) {
      if (cached) this.forget(cached.raster)
      this.effectsCache.set(job.layerId, { key: job.key, raster: new Raster(width, height, 4, data), inset, made: job.made, from: job.from })
    }
    if (waiting?.next) this.startEffects(waiting.next.layer, waiting.next.key)
    this.onStale?.()
  }
  // Where a placed mask sits relative to its layer: moving both together leaves it, and the effects, as they are.
  private maskRelation(layer: Layer) {
    if (!layer.mask || !layer.maskEnabled || !layer.maskPlacement || layer.isGroup || layer.adjustment) return ''
    return layerToMask(layer.mask, layer.maskPlacement, layer.transform, layer.image!.width, layer.image!.height).map(v => Math.round(v * 1e4) / 1e4).join(',')
  }
  private effectsKey(layer: Layer) {
    const mask = layer.mask && layer.maskEnabled ? layer.mask : null
    return `${layer.image!.version}:${mask?.version}:${this.maskRelation(layer)}:${JSON.stringify(layer.effects)}`
  }
  // The mask effects are worked out with, on the layer's own grid: a placed mask is read onto it first (kept until it moves).
  private gridMasks = new WeakMap<Raster, { key: string; raster: Raster }>()
  private effectsMask(layer: Layer): Raster | null {
    const mask = layer.mask && layer.maskEnabled ? layer.mask : null
    if (!mask || !layer.maskPlacement || layer.isGroup || layer.adjustment) return mask
    const key = `${mask.version}:${this.maskRelation(layer)}`, cached = this.gridMasks.get(mask)
    if (cached?.key === key) return cached.raster
    this.readBack.get(mask)?.()
    const { width, height } = layer.image!, levels = maskOnGrid(mask, layer.maskPlacement, layer.transform, width, height)
    const raster = new Raster(width, height, 1)
    for (let i = 0; i < levels.length; i++) raster.data[i] = Math.round(levels[i] * 255)
    this.gridMasks.set(mask, { key, raster })
    return raster
  }
  // Whether this frame draws a layer's effects from a result made for older pixels or settings (the live view, while the worker
  // redoes them); `drawnStale` is how each layer was drawn last frame, as switching redraws the whole canvas.
  private staleEffects(layer: Layer, effects: { key: string }) { return this.live && effects.key !== this.effectsKey(layer) }
  private drawnStale = new Map<string, boolean>()

  // Called when something drawn from a stale cache is ready to be redone.
  onStale: (() => void) | null = null

  private opacity(entry: Entry) { return entry.ancestors.reduce((o, a) => o * a.opacity, entry.layer.opacity) }

  // The layer's own pixels, with effects, opacity, mask and blend mode.
  private drawOwn(entry: Entry, target: Target, options: { clip?: Target | null; coverage?: Target | null; blendMode?: Layer['blendMode'] }) {
    const { layer } = entry
    if (!layer.image) return
    const opacity = this.opacity(entry), blendMode = options.blendMode ?? layer.blendMode
    if (hasVisibleEffects(layer.effects)) {
      const effects = this.effects(layer), { raster, inset } = effects
      this.drawnEffects.set(layer.id, effects)
      this.drawnStale.set(layer.id, this.staleEffects(layer, effects))
      // Effects still being redone for a layer whose grid has since changed size (a stroke grows it to the canvas, the end of one
      // trims it back) are drawn where they were made, not stretched over the new grid.
      const same = effects.from.width === layer.image.width && effects.from.height === layer.image.height
      const t = same ? layer.transform : effects.from.transform, sx = raster.width / (raster.width - 2 * inset), sy = raster.height / (raster.height - 2 * inset)
      const grown: Transform = { ...t, origin: [t.origin[0] + t.size[0] / 2 - t.size[0] * sx / 2, t.origin[1] + t.size[1] / 2 - t.size[1] * sy / 2], size: [t.size[0] * sx, t.size[1] * sy] }
      const withEffects: Source = { texture: this.sourceTexture(raster), raster, width: raster.width, height: raster.height, unitToDoc: unitToDocument(grown), sampling: t.sampling, rotation: t.rotation }
      if (!this.staleEffects(layer, effects)) { this.draw(target, withEffects, { opacity, blendMode, clip: options.clip, coverage: options.coverage }); return }
      // Effects still being redone (a stroke on the layer): the last result with the layer's pixels as they are now over it, so the
      // stroke shows at once; the new result replaces it when the worker has it.
      const { width, height } = target, both = this.pool.take(width, height), lt = layer.transform
      this.draw(both, withEffects, { opacity: 1, blendMode: 'Normal' })
      this.draw(both, { texture: this.sourceTexture(layer.image), raster: layer.image, width: layer.image.width, height: layer.image.height, unitToDoc: unitToDocument(lt), sampling: lt.sampling, rotation: lt.rotation }, { opacity: 1, blendMode: 'Normal', mask: this.layerMask(layer) })
      this.draw(target, { texture: both.texture, width, height, unitToDoc: unitToDocument({ origin: [...this.origin], size: [width / this.renderScale, height / this.renderScale], rotation: 0, flipX: false, flipY: false, sampling: 'Nearest' }), sampling: 'Exact', rotation: 0 }, { opacity, blendMode, clip: options.clip, coverage: options.coverage })
      this.pool.give(both)
      return
    }
    const t = layer.transform
    const deep = this.hdr ? deepOf(layer) : null
    if (deep) { this.draw(target, { texture: this.deepTexture(layer, deep), mipmapped: true, width: layer.image.width, height: layer.image.height, unitToDoc: unitToDocument(t), sampling: t.sampling, rotation: t.rotation }, { opacity, blendMode, mask: this.layerMask(layer), clip: options.clip, coverage: options.coverage }); return }
    this.draw(target, { texture: this.sourceTexture(layer.image), raster: layer.image, width: layer.image.width, height: layer.image.height, unitToDoc: unitToDocument(t), sampling: t.sampling, rotation: t.rotation }, { opacity, blendMode, mask: this.layerMask(layer), clip: options.clip, coverage: options.coverage })
  }

  // The product of enclosing folders' masks, each over its folder's own rectangle.
  private folderClip(ancestors: Layer[], used: Set<string>): Target | null {
    const masked = ancestors.filter(a => a.mask && a.maskEnabled)
    if (!masked.length) return null
    const key = masked.map(a => `${a.id}:${a.mask!.version}:${JSON.stringify(a.transform)}`).join('|') + `@${this.width}x${this.height}`
    used.add(key)
    const cached = this.clipCache.get(key)
    if (cached) return cached
    // Cached and reused by later frames, so made whole whatever this frame's region.
    this.gl.disable(this.gl.SCISSOR_TEST)
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
    this.unlimit()
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
    // The 3D lookup's sampler always gets its own unit: left on unit 0 with the 2D source, every draw would fail.
    const base = { source: { texture: original.texture, unit: 0 }, table: { texture: this.white, unit: 1 }, cube: { texture: undefined, unit: 2, target: gl.TEXTURE_3D }, unitsPerPixel: 1 / this.renderScale, offset: [Math.round(this.origin[0] * this.renderScale), Math.round(this.origin[1] * this.renderScale)], hdr: this.hdr ? 1 : 0 }
    if (kind === 'Exposure' && this.hdr) {
      const e = adjustment.exposureSettings ?? { exposure: 0, offset: 0, gamma: 1 }
      this.pass(out, this.adjustProgram, { ...base, mode: 6, params: [2 ** e.exposure, e.offset, 1 / Math.max(0.01, e.gamma), 0] })
    } else if (kind === 'Invert') this.pass(out, this.adjustProgram, { ...base, mode: 3 })
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
        hasClip: clip ? 1 : 0, clip: { texture: clip?.texture ?? this.white, unit: 3 }, hdr: this.hdr ? 1 : 0,
      })
      this.pool.give(adjusted)
    }
    this.pool.give(original)
  }

  // Half-float targets while a layer has kept deep pixels, still current or not, so a filter's 8-bit preview doesn't switch them back
  // and forth.
  private matchDepth(doc: Doc) {
    const hdr = this.floatTargets && doc.layers.some(l => !!l.deep)
    if (hdr === this.hdr) return
    this.hdr = hdr
    this.pool.trim(-1, -1)
    this.pool = new TargetPool(this.gl, this.format)
    this.prefix?.target.dispose(); this.prefix = null
    this.previous = null
    this.width = 0
  }

  // Composites a rectangle of the document (`x`, `y`, `w` × `h` in its pixels) at `renderScale` into a target of its own: a tile of an
  // export too large for one texture, or the view's detail over a canvas too large to show whole. The live frame's caches stay as
  // they are. The caller disposes of the target. `live` draws effects still being redone as the live view does, from the last result.
  renderRegion(doc: Doc, x: number, y: number, w: number, h: number, renderScale = 1, live = false): Target {
    this.matchDepth(doc)
    const saved = { output: this.output, width: this.width, height: this.height, renderScale: this.renderScale, origin: this.origin, prefix: this.prefix, previous: this.previous, lastSignatures: this.lastSignatures, live: this.live, clipCache: this.clipCache, gpuChanges: this.gpuChanges }
    const width = Math.max(1, Math.round(w * renderScale)), height = Math.max(1, Math.round(h * renderScale)), target = new Target(this.gl, width, height, this.format, true)
    Object.assign(this, { output: target, width, height, renderScale, origin: [x, y], prefix: null, previous: null, lastSignatures: [], live, clipCache: new Map(), gpuChanges: new Map(), regionParts: new Map() })
    try { this.compose(doc, target, width, height) } finally {
      this.clipCache.forEach(t => t.dispose())
      this.regionParts!.forEach(part => this.gl.deleteTexture(part.texture))
      this.regionParts = null
      Object.assign(this, saved)
      this.pool.trim(saved.width, saved.height)
    }
    return target
  }

  // Composites the document into `output` at `renderScale`. `hidden` leaves layers out (e.g. while a tool previews them elsewhere).
  render(doc: Doc, renderScale = 1): Target {
    this.renderScale = renderScale
    this.origin = [0, 0]
    const width = Math.max(1, Math.round(doc.width * renderScale)), height = Math.max(1, Math.round(doc.height * renderScale))
    this.matchDepth(doc)
    if (width !== this.width || height !== this.height) {
      this.output?.dispose()
      this.output = new Target(this.gl, width, height, this.format, true)
      this.pool.trim(width, height)
      this.clipCache.forEach(t => t.dispose())
      this.clipCache.clear()
      this.width = width; this.height = height
    }
    return this.compose(doc, this.output!, width, height)
  }

  private compose(doc: Doc, canvas: Target, width: number, height: number): Target {
    const gl = this.gl, renderScale = this.renderScale
    const entries = drawOrder(doc)
    // Exports and merges draw it all: the last live frame may show effects that are still being redone.
    const changed = this.live ? this.changes(doc, entries) : 'all'
    this.gpuChanges.clear()
    this.previous = { doc, width, height, scale: renderScale }
    if (changed === null) return canvas
    this.region = null
    if (changed !== 'all') {
      const x = Math.max(0, changed.x0), y = Math.max(0, changed.y0), w = Math.min(width, changed.x1) - x, h = Math.min(height, changed.y1) - y
      if (w <= 0 || h <= 0) return canvas
      // Worth it only when it's well short of the whole canvas.
      if (w * h < width * height * 0.6) this.region = { x, y, w, h }
    }
    this.unlimit()
    canvas.bind(true)
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
    const units = drawn.filter(e => !stacked.has(e.layer.id))
    // Effects being redone change what their layer draws; working them out first keeps the signatures true to this frame.
    for (const e of units) if (e.layer.image && hasVisibleEffects(e.layer.effects)) this.effects(e.layer)
    this.byIdForSignature = byId
    const signatures = units.map(e => this.signature(e, stacks.get(e.layer.id)))
    this.byIdForSignature = null
    // Start from the kept canvas when every layer it holds is as it was.
    let start = 0
    const kept = this.prefix
    if (kept && (kept.target.width !== width || kept.target.height !== height)) { kept.target.dispose(); this.prefix = null }
    else if (kept && kept.signatures.every((sig, i) => signatures[i] === sig)) { this.copy(kept.target, canvas); start = kept.signatures.length }
    // The first layer that changed since the last frame: everything below it is worth keeping while the edit goes on (taken from
    // a whole-canvas frame, as a partial one only redraws its region).
    let firstChanged = 0
    while (firstChanged < signatures.length && signatures[firstChanged] === this.lastSignatures[firstChanged]) firstChanged++
    const keep = !this.region && firstChanged > 0 && firstChanged < units.length && this.prefix?.signatures.length !== firstChanged && this.live ? firstChanged : -1
    this.lastSignatures = signatures
    for (let i = start; i < units.length; i++) {
      if (i === keep) this.keepPrefix(canvas, signatures.slice(0, i))
      const entry = units[i], { layer } = entry
      const clip = this.folderClip(entry.ancestors, used)
      if (layer.adjustment) { if (!layer.clipTo) this.applyAdjustment(entry, canvas, clip); continue }
      const children = stacks.get(layer.id)
      if (children) { this.drawStack(entry, children, canvas, clip); continue }
      this.drawOwn(entry, canvas, { clip, coverage: layer.clipTo ? coverage(layer.clipTo) : null })
    }
    coverages.forEach(t => this.pool.give(t))
    for (const [key, target] of this.clipCache) if (!used.has(key)) { target.dispose(); this.clipCache.delete(key) }
    for (const id of this.effectsCache.keys()) if (!byId.has(id)) this.effectsCache.delete(id)
    this.region = null
    gl.disable(gl.SCISSOR_TEST)
    gl.bindTexture(gl.TEXTURE_2D, canvas.texture)
    gl.generateMipmap(gl.TEXTURE_2D)
    return canvas
  }

  private keepPrefix(canvas: Target, signatures: string[]) {
    if (!this.prefix) this.prefix = { target: new Target(this.gl, canvas.width, canvas.height, this.format), signatures }
    this.prefix.signatures = signatures
    this.copy(canvas, this.prefix.target)
  }
  // Set while the live view draws: only it keeps the canvas below an edit or shows effects that are still being redone. Exports,
  // merges and sampling render everything current.
  live = false

  // A clipping base and the layers clipped to it: the children draw over the base's colors made opaque, then the result is cut
  // back to the base's coverage and blended onto the canvas in the base's mode.
  private drawStack(base: Entry, children: Entry[], canvas: Target, clip: Target | null) {
    const { width, height } = canvas
    const group = this.pool.take(width, height)
    this.drawOwn(base, group, { blendMode: 'Normal' })
    const alpha = this.pool.take(width, height)
    this.copy(group, alpha)
    this.pass(group, this.copyProgram, { source: { texture: alpha.texture, unit: 0 }, mode: 1, hdr: this.hdr ? 1 : 0 })
    for (const child of children) {
      if (child.layer.adjustment) this.applyAdjustment(child, group, null)
      else this.drawOwn(child, group, {})
    }
    const restored = this.pool.take(width, height)
    this.pass(restored, this.copyProgram, { source: { texture: group.texture, unit: 0 }, mode: 2, alpha: { texture: alpha.texture, unit: 1 } })
    this.draw(canvas, { texture: restored.texture, width, height, unitToDoc: unitToDocument({ origin: [...this.origin], size: [width / this.renderScale, height / this.renderScale], rotation: 0, flipX: false, flipY: false, sampling: 'Nearest' }), sampling: 'Exact', rotation: 0 }, { opacity: 1, blendMode: base.layer.blendMode, clip })
    ;[group, alpha, restored].forEach(t => this.pool.give(t))
  }

  // The CMYK proof's color lookup (io/cmyk.ts), 33 points a side, red fastest; null shows the document's own colors.
  private proofCube: WebGLTexture | null = null
  setProof(lookup: Float32Array | null) {
    const gl = this.gl
    if (this.proofCube) { gl.deleteTexture(this.proofCube); this.proofCube = null }
    if (!lookup) return
    this.proofCube = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_3D, this.proofCube)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, 33, 33, 33, 0, gl.RGBA, gl.FLOAT, lookup)
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, p, v)
  }

  // Over a canvas the live view shows reduced (too large to render whole), the part in view at the screen's detail, rendered once
  // the view settles and drawn over the reduced frame until the document changes.
  private detail: { target: Target; x: number; y: number; w: number; h: number; key: string } | null = null
  get detailKey() { return this.detail?.key ?? null }
  get liveScale() { return this.renderScale }
  setDetail(detail: { target: Target; x: number; y: number; w: number; h: number; key: string } | null) {
    if (this.detail?.target !== detail?.target) this.detail?.target.dispose()
    this.detail = detail
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
    use(gl, this.displayProgram, { toClip, toSource: identity(), image: { texture: this.output.texture, unit: 0 }, docSize: [docWidth, docHeight], zoom, proof: this.proofCube ? 1 : 0, dither: this.hdr ? 1 : 0, proofCube: { texture: this.proofCube ?? undefined, unit: 1, target: gl.TEXTURE_3D } })
    this.bindQuad()
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    const d = this.detail
    if (!d || d.target.format !== this.format) return
    const detailZoom = zoom / this.renderScale * d.w / d.target.width
    gl.bindTexture(gl.TEXTURE_2D, d.target.texture)
    setSampling(gl, detailZoom >= 1 ? gl.NEAREST : gl.LINEAR_MIPMAP_LINEAR)
    use(gl, this.displayProgram, { toClip: chain(translate(-1, 1), scale(2 / screenWidth, -2 / screenHeight), documentToScreen, translate(d.x, d.y), scale(d.w, d.h)), toSource: identity(), image: { texture: d.target.texture, unit: 0 }, docSize: [d.w, d.h], zoom: detailZoom, proof: this.proofCube ? 1 : 0, dither: this.hdr ? 1 : 0, proofCube: { texture: this.proofCube ?? undefined, unit: 1, target: gl.TEXTURE_3D } })
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  // The last composite made small, its longer side `maxSide` at most, for the Navigator: halved on the GPU until it's that size, each
  // halving averaging 2 × 2 pixels, so it's smooth without reading the whole composite back.
  thumbnail(maxSide: number): Raster | null {
    if (!this.output) return null
    const gl = this.gl, made: Target[] = []
    let source = this.output
    while (Math.max(source.width, source.height) > maxSide) {
      const f = Math.max(0.5, maxSide / Math.max(source.width, source.height))
      const next = new Target(gl, Math.max(1, Math.round(source.width * f)), Math.max(1, Math.round(source.height * f)), 'rgba8')
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, next.framebuffer)
      gl.blitFramebuffer(0, 0, source.width, source.height, 0, 0, next.width, next.height, gl.COLOR_BUFFER_BIT, gl.LINEAR)
      made.push(next)
      source = next
    }
    const out = this.read(source)
    made.forEach(target => target.dispose())
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return out
  }

  // The composite's premultiplied pixels, top row first; an HDR composite clipped to white.
  read(target = this.output!): Raster {
    const gl = this.gl
    const out = new Raster(target.width, target.height, 4)
    if (target.format === 'rgba16f') {
      const floats = this.readFloat(target), data = out.data
      for (let i = 0; i < floats.length; i += 4) {
        const a = Math.min(1, Math.max(0, floats[i + 3])), alpha = Math.round(a * 255)
        data[i + 3] = alpha
        for (let c = 0; c < 3; c++) data[i + c] = Math.min(alpha, Math.max(0, Math.round(floats[i + c] * 255)))
      }
      return out
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, out.data)
    return out
  }
  // A composite's premultiplied floats as they are, brighter than white kept: extended sRGB, top row first.
  readFloat(target = this.output!): Float32Array {
    const gl = this.gl, out = new Float32Array(target.width * target.height * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, out)
    return out
  }
}
