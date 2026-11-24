import { Raster } from '../model/raster'
import type { LayerEffects } from '../model/types'
import { call, kernelsLoaded, withBuffers } from '../kernels'

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
  if (kernelsLoaded() && source.length >= 16384) {
    const out = new Float32Array(source.length)
    const ok = withBuffers([{ data: source }, { data: out, out: true }, { data: weights }], ([s, d, w]) =>
      call('web_effects_blur_f32', s, d, width, height, w, radius))
    if (ok) return out
  }
  const temp = new Float32Array(source.length), out = new Float32Array(source.length), taps = radius * 2 + 1
  const rowLive = new Uint8Array(height)
  for (let y = 0; y < height; y++) {
    const row = y * width
    let minX = 0
    while (minX < width && source[row + minX] === 0) minX++
    if (minX === width) continue
    let maxX = width - 1
    while (maxX > minX && source[row + maxX] === 0) maxX--
    rowLive[y] = 1
    const xs = Math.max(0, minX - radius), xe = Math.min(width, maxX + radius + 1)
    for (let x = xs; x < xe; x++) {
      let v = 0
      if (x >= radius && x + radius < width) for (let k = 0, i = row + x - radius; k < taps; k++, i++) v += source[i] * weights[k]
      else for (let k = -radius; k <= radius; k++) { const sx = x + k; v += source[row + (sx < 0 ? 0 : sx > width - 1 ? width - 1 : sx)] * weights[k + radius] }
      temp[row + x] = v
    }
  }
  // Row-major tiled vertical pass (64 columns per tile): sequential reads in exact k = -radius..radius float64 order.
  const acc = new Float64Array(64)
  for (let y = 0; y < height; y++) {
    let any = false
    for (let k = -radius; k <= radius; k++) {
      const sy = y + k < 0 ? 0 : y + k >= height ? height - 1 : y + k
      if (rowLive[sy]) { any = true; break }
    }
    if (!any) continue
    const outRow = y * width
    for (let x0 = 0; x0 < width; x0 += 64) {
      const len = Math.min(64, width - x0)
      acc.fill(0, 0, len)
      for (let k = -radius; k <= radius; k++) {
        const sy = y + k < 0 ? 0 : y + k >= height ? height - 1 : y + k
        if (!rowLive[sy]) continue
        const w = weights[k + radius], inRow = sy * width + x0
        for (let j = 0; j < len; j++) acc[j] += temp[inRow + j] * w
      }
      for (let j = 0; j < len; j++) out[outRow + x0 + j] = acc[j]
    }
  }
  return out
}

function shift(source: Float32Array, width: number, height: number, dx: number, dy: number) {
  const out = new Float32Array(source.length)
  // Fractional offsets are identical for every pixel; hoist floor & weights outside the pixel loop.
  const ox = Math.floor(-dx), oy = Math.floor(-dy), gx = -dx - ox, gy = -dy - oy
  const omgX = 1 - gx, omgY = 1 - gy
  const at = (x: number, y: number) => x < 0 || y < 0 || x >= width || y >= height ? 0 : source[y * width + x]
  const inX0 = Math.max(0, -ox), inX1 = Math.min(width, width - 1 - ox)
  for (let y = 0; y < height; y++) {
    const y0 = y + oy, outRow = y * width
    if (y0 + 1 < 0 || y0 >= height) continue
    if (y0 >= 0 && y0 + 1 < height) {
      const r0 = y0 * width, r1 = r0 + width
      let x = 0
      for (; x < inX0; x++) {
        const x0 = x + ox
        out[outRow + x] = (at(x0, y0) * omgX + at(x0 + 1, y0) * gx) * omgY + (at(x0, y0 + 1) * omgX + at(x0 + 1, y0 + 1) * gx) * gy
      }
      for (; x < inX1; x++) {
        const i = r0 + x + ox, j = r1 + x + ox
        out[outRow + x] = (source[i] * omgX + source[i + 1] * gx) * omgY + (source[j] * omgX + source[j + 1] * gx) * gy
      }
      for (; x < width; x++) {
        const x0 = x + ox
        out[outRow + x] = (at(x0, y0) * omgX + at(x0 + 1, y0) * gx) * omgY + (at(x0, y0 + 1) * omgX + at(x0 + 1, y0 + 1) * gx) * gy
      }
    } else {
      for (let x = 0; x < width; x++) {
        const x0 = x + ox
        out[outRow + x] = (at(x0, y0) * omgX + at(x0 + 1, y0) * gx) * omgY + (at(x0, y0 + 1) * omgX + at(x0 + 1, y0 + 1) * gx) * gy
      }
    }
  }
  return out
}

// For each pixel, Euclidean distance to the nearest pixel on the other side of the shape's edge (Felzenszwalb–Huttenlocher,
// matching LayerEffectsRenderer.edgeDistances): from the shape for an outside stroke, from what's around it for an inside one
// (where past the image's edge counts as outside). Pixels at least half covered are the shape.
export function edgeDistances(levels: Float32Array, width: number, height: number, inside: boolean, limit: number): Float32Array {
  const cap = limit + 1, far = cap * cap
  const squared = new Int32Array(levels.length)
  for (let row = 0; row < height; row++) {
    const base = row * width
    let last = inside ? -1 : -cap - 1
    for (let x = 0; x < width; x++) {
      if ((levels[base + x] >= 0.5) !== inside) last = x
      const gap = x - last
      squared[base + x] = gap >= cap ? far : gap * gap
    }
    last = inside ? width : width + cap + 1
    for (let x = width - 1; x >= 0; x--) {
      if ((levels[base + x] >= 0.5) !== inside) last = x
      const gap = last - x
      if (gap < cap) {
        const d2 = gap * gap
        if (d2 < squared[base + x]) squared[base + x] = d2
      }
    }
  }
  const column = new Int32Array(height), lowest = new Int32Array(height), bounds = new Float64Array(height + 1)
  const result = new Float32Array(levels.length)
  for (let x = 0; x < width; x++) {
    let minV = far, maxV = 0
    for (let y = 0, idx = x; y < height; y++, idx += width) {
      const v = squared[idx]
      column[y] = v
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
    // Uniform column: skip building the parabola envelope (covers empty margins and deep interiors).
    if (minV === maxV && (!inside || minV === 0)) {
      const d = minV === 0 ? 0 : minV >= far ? cap : Math.sqrt(minV)
      if (d !== 0) for (let y = 0, idx = x; y < height; y++, idx += width) result[idx] = d
      continue
    }
    let count = 0
    lowest[0] = 0; bounds[0] = -Infinity; bounds[1] = Infinity
    for (let q = 1; q < height; q++) {
      const cq = column[q]
      let p = lowest[count]
      let crossesAt = ((cq - column[p]) / (q - p) + (q + p)) * 0.5
      while (crossesAt <= bounds[count]) {
        count--
        p = lowest[count]
        crossesAt = ((cq - column[p]) / (q - p) + (q + p)) * 0.5
      }
      count++; lowest[count] = q; bounds[count] = crossesAt; bounds[count + 1] = Infinity
    }
    count = 0
    for (let y = 0, idx = x; y < height; y++, idx += width) {
      while (bounds[count + 1] < y) count++
      const p = lowest[count], dy = y - p
      let distance = dy * dy + column[p]
      if (inside) {
        const top = (y + 1) * (y + 1), bot = (height - y) * (height - y)
        if (top < distance) distance = top
        if (bot < distance) distance = bot
      }
      result[idx] = distance === 0 ? 0 : distance >= far ? cap : Math.sqrt(distance)
    }
  }
  return result
}

// The layer with its effects, in layer pixels, grown by `inset` on every side (MetalLayerEffects' composite order: shadow, outer glow,
// outside stroke, the recolored layer, inside stroke).
export function renderEffects(image: Raster, mask: Raster | null, effects: LayerEffects): { raster: Raster; inset: number } {
  const stroke = on(effects.stroke), shadow = on(effects.shadow), overlay = on(effects.colorOverlay), innerShadow = on(effects.innerShadow), outerGlow = on(effects.outerGlow), innerGlow = on(effects.innerGlow)
  const inset = Math.ceil(Math.max(stroke && !stroke.inside ? stroke.size : 0, shadow ? shadow.distance + 3 * shadow.blur : 0, outerGlow ? 3 * outerGlow.size : 0)) + 2
  const W = image.width, H = image.height, width = W + inset * 2, height = H + inset * 2
  const total = width * height

  // Fast path when only a stroke is active: skips the 4-channel Float32 copy of the whole grown layer.
  if (stroke && !shadow && !overlay && !innerShadow && !outerGlow && !innerGlow) {
    const out = new Raster(width, height, 4)
    const shape = new Float32Array(total)
    const srcData = image.data, outData = out.data
    const hasMask = !!mask, mw = mask?.width ?? 0, mh = mask?.height ?? 0, mData = mask?.data
    for (let y = 0; y < H; y++) {
      const my = hasMask ? Math.min(mh - 1, Math.floor((y + 0.5) * mh / H)) * mw : 0
      const sRow = y * W, dRow = (y + inset) * width + inset
      for (let x = 0; x < W; x++) {
        const s = (sRow + x) * 4
        const m = hasMask ? mData![my + Math.min(mw - 1, Math.floor((x + 0.5) * mw / W))] / 255 : 1
        shape[dRow + x] = (srcData[s + 3] / 255) * m
      }
    }
    const reach = stroke.size, op = stroke.opacity, sr = stroke.red, sg = stroke.green, sb = stroke.blue, inside = stroke.inside
    const dist = reach > 0 && op > 0 ? edgeDistances(shape, width, height, inside, Math.ceil(reach) + 2) : null
    for (let y = 0; y < height; y++) {
      const inY = y >= inset && y < inset + H
      const sy = y - inset
      const my = hasMask && inY ? Math.min(mh - 1, Math.floor((sy + 0.5) * mh / H)) * mw : 0
      const sRow = sy * W, dRow = y * width
      for (let x = 0; x < width; x++) {
        const i = dRow + x
        const sa = shape[i]
        let ring = 0
        if (dist) {
          const reached = reach + 1 - dist[i]
          const cl = reached <= 0 ? 0 : reached >= 1 ? 1 : reached
          const raw = inside ? sa - (1 - cl) : cl - sa
          ring = raw <= 0 ? 0 : raw >= 1 ? 1 : raw
        }
        if (sa === 0 && ring === 0) continue
        let r = 0, g = 0, b = 0, a = 0
        if (!inside && ring > 0) {
          const k = ring * op
          r = sr * k; g = sg * k; b = sb * k; a = k
        }
        if (sa > 0 && inY && x >= inset && x < inset + W) {
          const sx = x - inset, s = (sRow + sx) * 4
          const m = hasMask ? mData![my + Math.min(mw - 1, Math.floor((sx + 0.5) * mw / W))] / 255 : 1
          const inv255 = m / 255, oneMinus = 1 - sa
          r = srcData[s] * inv255 + r * oneMinus
          g = srcData[s + 1] * inv255 + g * oneMinus
          b = srcData[s + 2] * inv255 + b * oneMinus
          a = sa + a * oneMinus
        }
        if (inside && ring > 0) {
          const k = ring * op, oneMinus = 1 - k
          r = sr * k + r * oneMinus; g = sg * k + g * oneMinus; b = sb * k + b * oneMinus; a = k + a * oneMinus
        }
        const p = i * 4
        outData[p] = (r <= 0 ? 0 : r >= 1 ? 1 : r) * 255 + 0.5
        outData[p + 1] = (g <= 0 ? 0 : g >= 1 ? 1 : g) * 255 + 0.5
        outData[p + 2] = (b <= 0 ? 0 : b >= 1 ? 1 : b) * 255 + 0.5
        outData[p + 3] = (a <= 0 ? 0 : a >= 1 ? 1 : a) * 255 + 0.5
      }
    }
    return { raster: out, inset }
  }

  const src = new Float32Array(total * 4), shape = new Float32Array(total)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const m = mask ? mask.data[Math.min(mask.height - 1, Math.floor((y + 0.5) * mask.height / H)) * mask.width + Math.min(mask.width - 1, Math.floor((x + 0.5) * mask.width / W))] / 255 : 1
    const s = (y * W + x) * 4, d = (y + inset) * width + x + inset
    for (let c = 0; c < 4; c++) src[d * 4 + c] = image.data[s + c] / 255 * m
    shape[d] = src[d * 4 + 3]
  }
  const offset = (angle: number, distance: number) => [-Math.cos(angle * Math.PI / 180) * distance, Math.sin(angle * Math.PI / 180) * distance]
  let ring: Float32Array | undefined, shadowBuf: Float32Array | undefined, innerBuf: Float32Array | undefined, glowBuf: Float32Array | undefined, innerGlowBuf: Float32Array | undefined
  if (stroke && stroke.size > 0 && stroke.opacity > 0) {
    const reach = stroke.size
    ring = edgeDistances(shape, width, height, stroke.inside, Math.ceil(reach) + 2)
    for (let i = 0; i < total; i++) {
      const reached = Math.min(1, Math.max(0, reach + 1 - ring[i]))
      ring[i] = Math.min(1, Math.max(0, stroke.inside ? shape[i] - (1 - reached) : reached - shape[i]))
    }
  }
  if (shadow) { const [dx, dy] = offset(shadow.angle, shadow.distance); shadowBuf = blur(shift(shape, width, height, dx, dy), width, height, shadow.blur / 2) }
  if (innerShadow) {
    const [dx, dy] = offset(innerShadow.angle, innerShadow.distance), b = blur(shift(shape, width, height, dx, dy), width, height, innerShadow.blur / 2)
    for (let i = 0; i < total; i++) { const v = 1 - b[i]; b[i] = v <= 0 ? 0 : v >= 1 ? 1 : v }
    innerBuf = b
  }
  if (outerGlow && outerGlow.size > 0) glowBuf = blur(shape, width, height, outerGlow.size / 2)
  if (innerGlow && innerGlow.size > 0) {
    const b = blur(shape, width, height, innerGlow.size / 2)
    for (let i = 0; i < total; i++) { const v = 1 - b[i]; b[i] = v <= 0 ? 0 : v >= 1 ? 1 : v }
    innerGlowBuf = b
  }
  const out = new Raster(width, height, 4)
  const clamp = (v: number) => v <= 0 ? 0 : v >= 1 ? 1 : v
  for (let i = 0; i < total; i++) {
    let r = 0, g = 0, b = 0, a = 0
    if (shadow && shadowBuf) { const k = clamp(shadowBuf[i] * shadow.opacity); r = shadow.red * k; g = shadow.green * k; b = shadow.blue * k; a = k }
    if (outerGlow && glowBuf) { const k = clamp(glowBuf[i] * (1 - shape[i]) * outerGlow.opacity); r = outerGlow.red * k + r * (1 - k); g = outerGlow.green * k + g * (1 - k); b = outerGlow.blue * k + b * (1 - k); a = k + a * (1 - k) }
    if (stroke && ring && !stroke.inside) { const k = clamp(ring[i] * stroke.opacity); r = stroke.red * k + r * (1 - k); g = stroke.green * k + g * (1 - k); b = stroke.blue * k + b * (1 - k); a = k + a * (1 - k) }
    // A color overlay, inner glow and inner shadow recolor the layer's own pixels and keep their alpha, as Photoshop's do, so a
    // translucent pixel takes the whole color and the effects beneath aren't tinted.
    const sa = src[i * 4 + 3]
    let sr = src[i * 4], sg = src[i * 4 + 1], sb = src[i * 4 + 2]
    if (overlay) { const k = clamp(overlay.opacity); sr = sr * (1 - k) + overlay.red * sa * k; sg = sg * (1 - k) + overlay.green * sa * k; sb = sb * (1 - k) + overlay.blue * sa * k }
    if (innerGlow && innerGlowBuf) { const k = clamp(innerGlowBuf[i] * innerGlow.opacity); sr = sr * (1 - k) + innerGlow.red * sa * k; sg = sg * (1 - k) + innerGlow.green * sa * k; sb = sb * (1 - k) + innerGlow.blue * sa * k }
    if (innerShadow && innerBuf) { const k = clamp(innerBuf[i] * innerShadow.opacity); sr = sr * (1 - k) + innerShadow.red * sa * k; sg = sg * (1 - k) + innerShadow.green * sa * k; sb = sb * (1 - k) + innerShadow.blue * sa * k }
    r = sr + r * (1 - sa); g = sg + g * (1 - sa); b = sb + b * (1 - sa); a = sa + a * (1 - sa)
    if (stroke && ring && stroke.inside) { const k = clamp(ring[i] * stroke.opacity); r = stroke.red * k + r * (1 - k); g = stroke.green * k + g * (1 - k); b = stroke.blue * k + b * (1 - k); a = k + a * (1 - k) }
    const p = i * 4
    out.data[p] = clamp(r) * 255 + 0.5; out.data[p + 1] = clamp(g) * 255 + 0.5; out.data[p + 2] = clamp(b) * 255 + 0.5; out.data[p + 3] = clamp(a) * 255 + 0.5
  }
  return { raster: out, inset }
}
