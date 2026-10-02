import { Raster } from '../model/raster'
import type { LayerEffects } from '../model/types'

const on = <T extends { enabled?: boolean } | undefined>(effect: T) => effect && effect.enabled !== false ? effect : undefined

export function hasVisibleEffects(effects: LayerEffects | null) {
  return !!effects && Object.values(effects).some(effect => effect && effect.enabled !== false)
}

function blur(source: Float32Array, width: number, height: number, sigma: number) {
  if (sigma <= 0.01) return source
  const radius = Math.max(1, Math.round(3 * sigma))
  const weights = new Float32Array(radius * 2 + 1)
  let sum = 0
  for (let k = -radius; k <= radius; k++) sum += weights[k + radius] = Math.exp(-k * k / (2 * sigma * sigma))
  for (let k = 0; k < weights.length; k++) weights[k] /= sum
  const temp = new Float32Array(source.length), out = new Float32Array(source.length)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let v = 0
      for (let k = -radius; k <= radius; k++) v += source[row + Math.min(width - 1, Math.max(0, x + k))] * weights[k + radius]
      temp[row + x] = v
    }
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let v = 0
    for (let k = -radius; k <= radius; k++) v += temp[Math.min(height - 1, Math.max(0, y + k)) * width + x] * weights[k + radius]
    out[y * width + x] = v
  }
  return out
}

function shift(source: Float32Array, width: number, height: number, dx: number, dy: number) {
  const out = new Float32Array(source.length)
  const at = (x: number, y: number) => x < 0 || y < 0 || x >= width || y >= height ? 0 : source[y * width + x]
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = x - dx, sy = y - dy, x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0
    out[y * width + x] = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
  }
  return out
}

// Square dilation (outside) or erosion (inside) by `reach`, as separable running max/min.
function morph(source: Float32Array, width: number, height: number, reach: number, dilate: boolean) {
  const pick = dilate ? Math.max : Math.min
  const temp = new Float32Array(source.length), out = new Float32Array(source.length)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let v = dilate ? 0 : 1
    for (let k = -reach; k <= reach; k++) { const sx = x + k; v = pick(v, sx < 0 || sx >= width ? 0 : source[y * width + sx]) }
    temp[y * width + x] = v
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let v = dilate ? 0 : 1
    for (let k = -reach; k <= reach; k++) { const sy = y + k; v = pick(v, sy < 0 || sy >= height ? 0 : temp[sy * width + x]) }
    out[y * width + x] = v
  }
  return out
}

// The layer with its effects, in layer pixels, grown by `inset` on every side (MetalLayerEffects' composite order).
export function renderEffects(image: Raster, mask: Raster | null, effects: LayerEffects): { raster: Raster; inset: number } {
  const stroke = on(effects.stroke), shadow = on(effects.shadow), overlay = on(effects.colorOverlay), innerShadow = on(effects.innerShadow), outerGlow = on(effects.outerGlow), innerGlow = on(effects.innerGlow)
  const inset = Math.ceil(Math.max(stroke && !stroke.inside ? stroke.size : 0, shadow ? shadow.distance + 3 * shadow.blur : 0, outerGlow ? 3 * outerGlow.size : 0)) + 2
  const W = image.width, H = image.height, width = W + inset * 2, height = H + inset * 2
  const src = new Float32Array(width * height * 4), shape = new Float32Array(width * height)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const m = mask ? mask.data[Math.min(mask.height - 1, Math.floor((y + 0.5) * mask.height / H)) * mask.width + Math.min(mask.width - 1, Math.floor((x + 0.5) * mask.width / W))] / 255 : 1
    const s = (y * W + x) * 4, d = (y + inset) * width + x + inset
    for (let c = 0; c < 4; c++) src[d * 4 + c] = image.data[s + c] / 255 * m
    shape[d] = src[d * 4 + 3]
  }
  const offset = (angle: number, distance: number) => [-Math.cos(angle * Math.PI / 180) * distance, Math.sin(angle * Math.PI / 180) * distance]
  let ring: Float32Array | undefined, shadowBuf: Float32Array | undefined, innerBuf: Float32Array | undefined, glowBuf: Float32Array | undefined, innerGlowBuf: Float32Array | undefined
  if (stroke && stroke.size > 0 && stroke.opacity > 0) {
    const reach = Math.max(1, Math.round(stroke.size)), m = morph(shape, width, height, reach, !stroke.inside)
    ring = new Float32Array(shape.length)
    for (let i = 0; i < ring.length; i++) ring[i] = Math.min(1, Math.max(0, stroke.inside ? shape[i] - m[i] : m[i] - shape[i]))
  }
  if (shadow) { const [dx, dy] = offset(shadow.angle, shadow.distance); shadowBuf = blur(shift(shape, width, height, dx, dy), width, height, shadow.blur / 2) }
  if (innerShadow) {
    const [dx, dy] = offset(innerShadow.angle, innerShadow.distance), b = blur(shift(shape, width, height, dx, dy), width, height, innerShadow.blur / 2)
    innerBuf = shape.map((s, i) => Math.min(1, Math.max(0, s * (1 - b[i]))))
  }
  if (outerGlow && outerGlow.size > 0) glowBuf = blur(shape, width, height, outerGlow.size / 2)
  if (innerGlow && innerGlow.size > 0) { const b = blur(shape, width, height, innerGlow.size / 2); innerGlowBuf = shape.map((s, i) => Math.min(1, Math.max(0, s * (1 - b[i])))) }
  const out = new Raster(width, height, 4)
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  for (let i = 0; i < width * height; i++) {
    let r = 0, g = 0, b = 0, a = 0
    const over = (effect: { red: number; green: number; blue: number }, k: number) => { r = effect.red * k + r * (1 - k); g = effect.green * k + g * (1 - k); b = effect.blue * k + b * (1 - k); a = k + a * (1 - k) }
    if (shadow && shadowBuf) { const k = clamp(shadowBuf[i] * shadow.opacity); r = shadow.red * k; g = shadow.green * k; b = shadow.blue * k; a = k }
    if (outerGlow && glowBuf) over(outerGlow, clamp(glowBuf[i] * (1 - shape[i]) * outerGlow.opacity))
    if (stroke && ring && !stroke.inside) over(stroke, clamp(ring[i] * stroke.opacity))
    const sa = src[i * 4 + 3]
    r = src[i * 4] + r * (1 - sa); g = src[i * 4 + 1] + g * (1 - sa); b = src[i * 4 + 2] + b * (1 - sa); a = sa + a * (1 - sa)
    if (overlay) over(overlay, clamp(shape[i] * overlay.opacity))
    if (innerGlow && innerGlowBuf) over(innerGlow, clamp(innerGlowBuf[i] * innerGlow.opacity))
    if (innerShadow && innerBuf) over(innerShadow, clamp(innerBuf[i] * innerShadow.opacity))
    if (stroke && ring && stroke.inside) over(stroke, clamp(ring[i] * stroke.opacity))
    const p = i * 4
    out.data[p] = clamp(r) * 255 + 0.5; out.data[p + 1] = clamp(g) * 255 + 0.5; out.data[p + 2] = clamp(b) * 255 + 0.5; out.data[p + 3] = clamp(a) * 255 + 0.5
  }
  return { raster: out, inset }
}
