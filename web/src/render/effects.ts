import { Raster } from '../model/raster'
import type { LayerEffects } from '../model/types'

const on = <T extends { enabled?: boolean } | undefined>(effect: T) => effect && effect.enabled !== false ? effect : undefined

export function hasVisibleEffects(effects: LayerEffects | null) {
  return !!effects && Object.values(effects).some(effect => effect && effect.enabled !== false)
}

// The helpers below run over every pixel of a layer's grown grid each time its effects are redone, so they index directly and
// only clamp near the edges; the sums run in the same order as before, so the results are the same to the bit.
function blur(source: Float32Array, width: number, height: number, sigma: number) {
  if (sigma <= 0.01) return source
  const radius = Math.max(1, Math.round(3 * sigma))
  const weights = new Float32Array(radius * 2 + 1)
  let sum = 0
  for (let k = -radius; k <= radius; k++) sum += weights[k + radius] = Math.exp(-k * k / (2 * sigma * sigma))
  for (let k = 0; k < weights.length; k++) weights[k] /= sum
  const temp = new Float32Array(source.length), out = new Float32Array(source.length), taps = radius * 2 + 1
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let v = 0
      if (x >= radius && x + radius < width) for (let k = 0, i = row + x - radius; k < taps; k++, i++) v += source[i] * weights[k]
      else for (let k = -radius; k <= radius; k++) { const sx = x + k; v += source[row + (sx < 0 ? 0 : sx > width - 1 ? width - 1 : sx)] * weights[k + radius] }
      temp[row + x] = v
    }
  }
  for (let y = 0; y < height; y++) {
    const inside = y >= radius && y + radius < height
    for (let x = 0; x < width; x++) {
      let v = 0
      if (inside) for (let k = 0, i = (y - radius) * width + x; k < taps; k++, i += width) v += temp[i] * weights[k]
      else for (let k = -radius; k <= radius; k++) { const sy = y + k; v += temp[(sy < 0 ? 0 : sy > height - 1 ? height - 1 : sy) * width + x] * weights[k + radius] }
      out[y * width + x] = v
    }
  }
  return out
}

function shift(source: Float32Array, width: number, height: number, dx: number, dy: number) {
  const out = new Float32Array(source.length)
  const at = (x: number, y: number) => x < 0 || y < 0 || x >= width || y >= height ? 0 : source[y * width + x]
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = x - dx, sy = y - dy, x0 = Math.floor(sx), y0 = Math.floor(sy), gx = sx - x0, gy = sy - y0
    if (x0 >= 0 && y0 >= 0 && x0 + 1 < width && y0 + 1 < height) {
      const i = y0 * width + x0
      out[y * width + x] = (source[i] * (1 - gx) + source[i + 1] * gx) * (1 - gy) + (source[i + width] * (1 - gx) + source[i + width + 1] * gx) * gy
    } else out[y * width + x] = (at(x0, y0) * (1 - gx) + at(x0 + 1, y0) * gx) * (1 - gy) + (at(x0, y0 + 1) * (1 - gx) + at(x0 + 1, y0 + 1) * gx) * gy
  }
  return out
}

// Square dilation (outside) or erosion (inside) by `reach`, as separable running max/min.
function morph(source: Float32Array, width: number, height: number, reach: number, dilate: boolean) {
  const temp = new Float32Array(source.length), out = new Float32Array(source.length)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let v = dilate ? 0 : 1
      for (let sx = x - reach; sx <= x + reach; sx++) { const s = sx < 0 || sx >= width ? 0 : source[row + sx]; if (dilate ? s > v : s < v) v = s }
      temp[row + x] = v
    }
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let v = dilate ? 0 : 1
    for (let sy = y - reach; sy <= y + reach; sy++) { const s = sy < 0 || sy >= height ? 0 : temp[sy * width + x]; if (dilate ? s > v : s < v) v = s }
    out[y * width + x] = v
  }
  return out
}

// The layer with its effects, in layer pixels, grown by `inset` on every side (MetalLayerEffects' composite order: shadow, outer glow,
// outside stroke, the recolored layer, inside stroke).
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
    innerBuf = b.map(v => Math.min(1, Math.max(0, 1 - v)))
  }
  if (outerGlow && outerGlow.size > 0) glowBuf = blur(shape, width, height, outerGlow.size / 2)
  if (innerGlow && innerGlow.size > 0) { const b = blur(shape, width, height, innerGlow.size / 2); innerGlowBuf = b.map(v => Math.min(1, Math.max(0, 1 - v))) }
  const out = new Raster(width, height, 4)
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  for (let i = 0; i < width * height; i++) {
    let r = 0, g = 0, b = 0, a = 0
    const over = (effect: { red: number; green: number; blue: number }, k: number) => { r = effect.red * k + r * (1 - k); g = effect.green * k + g * (1 - k); b = effect.blue * k + b * (1 - k); a = k + a * (1 - k) }
    if (shadow && shadowBuf) { const k = clamp(shadowBuf[i] * shadow.opacity); r = shadow.red * k; g = shadow.green * k; b = shadow.blue * k; a = k }
    if (outerGlow && glowBuf) over(outerGlow, clamp(glowBuf[i] * (1 - shape[i]) * outerGlow.opacity))
    if (stroke && ring && !stroke.inside) over(stroke, clamp(ring[i] * stroke.opacity))
    // A color overlay, inner glow and inner shadow recolor the layer's own pixels and keep their alpha, as Photoshop's do, so a
    // translucent pixel takes the whole color and the effects beneath aren't tinted.
    const sa = src[i * 4 + 3]
    let sr = src[i * 4], sg = src[i * 4 + 1], sb = src[i * 4 + 2]
    const recolor = (effect: { red: number; green: number; blue: number }, k: number) => { sr = sr * (1 - k) + effect.red * sa * k; sg = sg * (1 - k) + effect.green * sa * k; sb = sb * (1 - k) + effect.blue * sa * k }
    if (overlay) recolor(overlay, clamp(overlay.opacity))
    if (innerGlow && innerGlowBuf) recolor(innerGlow, clamp(innerGlowBuf[i] * innerGlow.opacity))
    if (innerShadow && innerBuf) recolor(innerShadow, clamp(innerBuf[i] * innerShadow.opacity))
    r = sr + r * (1 - sa); g = sg + g * (1 - sa); b = sb + b * (1 - sa); a = sa + a * (1 - sa)
    if (stroke && ring && stroke.inside) over(stroke, clamp(ring[i] * stroke.opacity))
    const p = i * 4
    out.data[p] = clamp(r) * 255 + 0.5; out.data[p + 1] = clamp(g) * 255 + 0.5; out.data[p + 2] = clamp(b) * 255 + 0.5; out.data[p + 3] = clamp(a) * 255 + 0.5
  }
  return { raster: out, inset }
}
