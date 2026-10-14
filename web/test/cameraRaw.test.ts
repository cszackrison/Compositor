import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadKernels } from '../src/kernels'
import { Raster } from '../src/model/raster'
import { applyCameraRaw, newPointColor, autoBalance, defaultCameraRaw, isIdentity, loadCameraRawTables, neutralize, normalized, resetGroup, cameraRawGroups, adjusts, type CameraRawSettings } from '../src/model/cameraRaw'

beforeAll(async () => {
  await loadKernels(readFileSync(new URL('../public/kernels.wasm', import.meta.url)))
  const resource = (name: string) => new Uint8Array(readFileSync(new URL(`../../Compositor/Resources/${name}`, import.meta.url)))
  await loadCameraRawTables(resource('CameraRawTables.bin'), resource('CameraRawShadows.bin'))
})

const solid = (rgb: number[], width = 4, height = 4, alpha = 255) => Raster.filled(width, height, 4, [...rgb.map(v => Math.round(v * alpha / 255)), alpha])
const row = (...colors: number[][]) => { const r = new Raster(colors.length, 1, 4); colors.forEach((c, i) => r.data.set([...c, 255], i * 4)); return r }
const straight = (r: Raster, i = 0) => { const a = r.data[i * 4 + 3]; return [0, 1, 2].map(c => a ? Math.min(255, Math.round(r.data[i * 4 + c] * 255 / a)) : 0) }
const graded = (input: Raster, change: (s: CameraRawSettings) => void) => { const s = defaultCameraRaw(); change(s); return applyCameraRaw(input, s) }
const near = (got: number[], expected: number[], within = 4) => got.every((v, i) => Math.abs(v - expected[i]) <= within)

// CameraRawTests.swift: Photoshop's Camera Raw Filter's own measured numbers.
describe('Camera Raw', () => {
  it('leaves pixels alone by default and keeps settings in range', () => {
    const input = solid([128, 128, 128], 4, 4, 128)
    expect(applyCameraRaw(input, defaultCameraRaw()).data).toEqual(input.data)
    const broken = { ...defaultCameraRaw(), exposure: NaN, temperature: 400 }
    expect([normalized(broken).exposure, normalized(broken).temperature]).toEqual([0, 100])
    expect(isIdentity(defaultCameraRaw())).toBe(true)
  })

  it('matches Photoshop\'s Exposure and Contrast', () => {
    const brighter = straight(graded(solid([128, 128, 128]), s => { s.exposure = 1 }))
    expect(Math.abs(brighter[0] - 181)).toBeLessThanOrEqual(2)
    expect(brighter[0] === brighter[1] && brighter[1] === brighter[2]).toBe(true)
    expect(graded(solid([128, 128, 128], 4, 4, 128), s => { s.exposure = 1 }).data[3]).toBe(128)
    const pair = row([64, 64, 64], [192, 192, 192])
    const pushed = graded(pair, s => { s.contrast = 100 })
    expect([straight(pushed, 0)[0], straight(pushed, 1)[0]].map((v, i) => Math.abs(v - [36, 213][i]) <= 3)).toEqual([true, true])
    const flat = graded(pair, s => { s.contrast = -100 })
    expect([straight(flat, 0)[0], straight(flat, 1)[0]].map((v, i) => Math.abs(v - [88, 174][i]) <= 3)).toEqual([true, true])
  })

  it('moves the end each tonal slider names', () => {
    const brightAndMid = row([230, 230, 230], [128, 128, 128]), darkAndMid = row([20, 20, 20], [128, 128, 128])
    const recovered = graded(brightAndMid, s => { s.highlights = -100 })
    expect(straight(recovered, 0)[0]).toBeLessThan(222)
    expect(Math.abs(straight(recovered, 1)[0] - 128)).toBeLessThanOrEqual(4)
    const clipped = graded(brightAndMid, s => { s.whites = 100 })
    expect(straight(clipped, 0)[0]).toBe(255)
    expect(straight(clipped, 1)[0]).toBeGreaterThan(128)
    const opened = graded(darkAndMid, s => { s.shadows = 100 })
    expect(straight(opened, 0)[0]).toBeGreaterThan(22)
    expect(Math.abs(straight(opened, 1)[0] - 128)).toBeLessThanOrEqual(6)
    const crushed = graded(darkAndMid, s => { s.blacks = -100 })
    expect(straight(crushed, 0)[0]).toBe(0)
    expect(Math.abs(straight(crushed, 1)[0] - 91)).toBeLessThanOrEqual(3)
  })

  it('matches Photoshop\'s white balance, vibrance, mixer, calibration and curve', () => {
    const cases: [string, number[], (s: CameraRawSettings) => void, number[]][] = [
      ['temperature +100', [128, 128, 128], s => { s.temperature = 100 }, [235, 189, 117]],
      ['temperature −50', [128, 128, 128], s => { s.temperature = -50 }, [102, 146, 210]],
      ['tint +100', [128, 128, 128], s => { s.tint = 100 }, [159, 125, 215]],
      ['tint −100', [128, 128, 128], s => { s.tint = -100 }, [98, 198, 120]],
      ['vibrance +100 spares skin', [153, 107, 107], s => { s.vibrance = 100 }, [167, 98, 98]],
      ['vibrance +100 fills a dull cyan', [107, 153, 153], s => { s.vibrance = 100 }, [0, 160, 160]],
      ['vibrance −100', [92, 92, 230], s => { s.vibrance = -100 }, [164, 164, 210]],
      ['orange saturation −60', [230, 115, 0], s => { s.mixer.saturation[1] = -60 }, [189, 130, 107]],
      ['red hue +60', [230, 92, 92], s => { s.mixer.hue[0] = 60 }, [227, 125, 83]],
      ['blue luminance +60', [92, 92, 230], s => { s.mixer.luminance[5] = 60 }, [142, 142, 248]],
      ['blue primary saturation −60', [92, 92, 230], s => { s.calibration.blueSaturation = -60 }, [149, 149, 226]],
      ['red primary hue +60', [230, 92, 92], s => { s.calibration.redHue = 60 }, [228, 118, 37]],
      ['darks −60', [130, 130, 130], s => { s.curve.darks = -60 }, [101, 101, 101]],
    ]
    for (const [name, input, change, expected] of cases) {
      const got = straight(graded(solid(input), change))
      expect(near(got, expected), `${name}: ${got}, Photoshop ${expected}`).toBe(true)
    }
  })

  it('matches Photoshop\'s lens and post-crop vignettes at a corner', () => {
    const wide = solid([128, 128, 128], 300, 200)
    expect(Math.abs(straight(graded(wide, s => { s.optics.vignetteAmount = 100 }))[0] - 223)).toBeLessThanOrEqual(6)
    expect(Math.abs(straight(graded(wide, s => { s.vignetteAmount = -60 }))[0] - 30)).toBeLessThanOrEqual(6)
  })

  it('balances white from a pixel or the average', () => {
    const cast = [150, 128, 100], solved = neutralize(...cast.map(v => v / 255) as [number, number, number])!
    const chroma = (c: number[]) => Math.max(...c) - Math.min(...c)
    const neutral = straight(graded(solid(cast), s => { s.temperature = solved.temperature; s.tint = solved.tint }))
    expect(chroma(neutral)).toBeLessThan(chroma(cast) / 2)
    const auto = autoBalance(solid(cast))!
    expect(chroma(straight(graded(solid(cast), s => { s.temperature = auto.temperature; s.tint = auto.tint })))).toBeLessThan(chroma(cast) / 2)
  })

  it('resets each section to its defaults and nothing else', () => {
    for (const group of cameraRawGroups) expect(adjusts(resetGroup({ ...defaultCameraRaw(), exposure: 1, temperature: 20, texture: 30, curve: { ...defaultCameraRaw().curve, darks: 10 }, detail: { ...defaultCameraRaw().detail, sharpenAmount: 40 } }, group), group)).toBe(false)
    expect(resetGroup({ ...defaultCameraRaw(), exposure: 1, temperature: 20 }, 'Light').temperature).toBe(20)
  })

  it('warps geometry, keeping the size', () => {
    const input = solid([200, 100, 50], 40, 30)
    const turned = graded(input, s => { s.geometry.rotate = 20 })
    expect([turned.width, turned.height]).toEqual([40, 30])
    expect(turned.data[3]).toBe(0)
    expect(straight(turned, 15 * 40 + 20)).toEqual([200, 100, 50])
    expect(graded(input, s => { s.geometry.scale = -50 }).data[3]).toBe(0)
    expect(near(straight(graded(input, s => { s.geometry.scale = -50; s.geometry.constrainCrop = true }), 2 * 40 + 2), [200, 100, 50], 1)).toBe(true)
  })

  it('shifts a picked color and leaves the others', () => {
    const pair = row([220, 60, 60], [60, 60, 220])
    const shifted = graded(pair, s => { s.mixer.points = [{ ...newPointColor(0, 0.73, 0.55), hueShift: 60 }] })
    expect(straight(shifted, 0)).not.toEqual([220, 60, 60])
    expect(near(straight(shifted, 1), [60, 60, 220], 2)).toBe(true)
  })

  it('shows clipping, the sharpening mask and the triangles only when asked', () => {
    const brightAndMid = row([230, 230, 230], [128, 128, 128]), s = { ...defaultCameraRaw(), whites: 100 }
    expect([straight(applyCameraRaw(brightAndMid, s, 0, 1, { clipping: 1 }), 0), straight(applyCameraRaw(brightAndMid, s, 0, 1, { clipping: 1 }), 1)]).toEqual([[255, 255, 255], [0, 0, 0]])
    const marked = applyCameraRaw(row([255, 255, 255], [0, 0, 0]), defaultCameraRaw(), 0, 1, { shadows: true, highlights: true })
    expect(straight(marked, 0)[0]).toBeGreaterThan(straight(marked, 0)[2])
    expect(straight(marked, 1)[2]).toBeGreaterThan(straight(marked, 1)[0])
    const masked = applyCameraRaw(solid([128, 128, 128], 8, 8), { ...defaultCameraRaw(), detail: { ...defaultCameraRaw().detail, sharpenAmount: 50 } }, 0, 1, { sharpenMask: true })
    expect(straight(masked, 27)[0]).not.toBe(128)
  })

  it('levels a tilted guide line when Upright is Guided', () => {
    // A bright bar running down to the right, a guide along it (from the lower left, so its end is lower), straightened: the bar's
    // ends come out level.
    const width = 80, height = 60, input = new Raster(width, height, 4)
    for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) { const bar = Math.abs(y - (20 + x * 0.25)) < 2; input.data.set(bar ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * width + x) * 4) }
    const guide = { startX: 0.1, startY: 1 - (20 + 8 * 0.25) / height, endX: 0.9, endY: 1 - (20 + 72 * 0.25) / height }
    const level = graded(input, s => { s.geometry = { ...s.geometry, upright: 'Guided', guides: [guide] } })
    const rowOf = (x: number) => { let best = 0, at = 0; for (let y = 0; y < height; y++) { const v = level.data[(y * width + x) * 4]; if (v > best) { best = v; at = y } } return at }
    expect(Math.abs(rowOf(20) - rowOf(60))).toBeLessThanOrEqual(1)
  })

  // Shadows adapts to the picture as Photoshop's does, measured on a made-up landscape (value noise over seven octaves from a fixed
  // seed: a cloudy sky brightening upward over dark textured ground) against Photoshop's own renders of exactly these pictures. A
  // picture under about 1020 pixels on its long side gets Photoshop's gentler treatment of small pictures, which ours follows less
  // closely.
  it('adapts Shadows to the picture as Photoshop does', () => {
    const field = (width: number, height: number, seed: bigint) => {
      let state = seed
      const unit = () => { state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn; return Number(state >> 11n) / 2 ** 53 }
      const out = new Float64Array(width * height)
      let amplitude = 1, total = 0
      for (let octave = 0; octave < 7; octave++) {
        const cell = Math.max(1, Math.max(width, height) >> (octave + 2)), gw = Math.floor(width / cell) + 2, gh = Math.floor(height / cell) + 2
        const grid = Array.from({ length: gw * gh }, unit)
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const fx = x / cell, fy = y / cell, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0
          const top = grid[y0 * gw + x0] * (1 - tx) + grid[y0 * gw + x0 + 1] * tx, bottom = grid[(y0 + 1) * gw + x0] * (1 - tx) + grid[(y0 + 1) * gw + x0 + 1] * tx
          out[y * width + x] += amplitude * (top * (1 - ty) + bottom * ty)
        }
        total += amplitude
        amplitude *= 0.6
      }
      return out.map(v => v / total)
    }
    const landscape = (width: number) => {
      const height = Math.floor(width * 2 / 3), clouds = field(width, height, 1n), lay = field(width, height, 2n), image = new Raster(width, height, 4)
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x, horizon = height * (0.5 + 0.25 * (lay[x] - 0.5))
        const sky = 140 + 80 * (1 - y / horizon) + 60 * (clouds[i] - 0.5), ground = 4 + 70 * Math.pow(clouds[i], 2.2) + 20 * (lay[i] - 0.5)
        const value = Math.max(0, Math.min(255, Math.round(y < horizon ? sky : ground)))
        image.data.set([value, value, value, 255], i * 4)
      }
      return image
    }
    // The bottom fifth's mean, all ground, and the top fifth's, all sky.
    const means = (image: Raster) => {
      const mean = (from: number, to: number) => { let sum = 0; for (let y = from; y < to; y++) for (let x = 0; x < image.width; x++) sum += image.data[(y * image.width + x) * 4 + 1]; return sum / ((to - from) * image.width) }
      return { ground: mean(Math.floor(image.height * 4 / 5), image.height), sky: mean(0, Math.floor(image.height / 5)) }
    }
    // Width, Shadows, Photoshop's ground and sky, and how near ours must be. Unchanged: ground 19.7, sky 204.7.
    const cases: [number, number, number, number, number][] = [[1200, 100, 59.0, 205.9, 4], [1200, 50, 34.9, 205.3, 4], [1200, -100, 4.2, 203.6, 4], [600, 100, 51.0, 205.8, 10], [600, 50, 32.2, 205.2, 4], [600, -100, 5.5, 203.6, 4]]
    for (const [width, amount, ground, sky, tolerance] of cases) {
      const result = means(graded(landscape(width), s => { s.shadows = amount }))
      expect(Math.abs(result.ground - ground), `${width} wide, Shadows ${amount}: ground ${result.ground}, Photoshop ${ground}`).toBeLessThanOrEqual(tolerance)
      expect(Math.abs(result.sky - sky), `${width} wide, Shadows ${amount}: sky ${result.sky}, Photoshop ${sky}`).toBeLessThanOrEqual(2)
    }
  })
})
