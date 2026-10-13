import { type RawDevelopSettings, asShotFromCamera, developPixels, rawSettings } from '../model/rawDevelop'

// Camera RAW files (RawImporter.swift): decoded with LibRaw compiled to WebAssembly (libraw-wasm, in its own worker, loaded the first
// time one is opened) to linear light in sRGB primaries at 16 bits, balanced as the camera recorded it, then developed with the
// sheet's settings (model/rawDevelop.ts). Noise reduction (LibRaw's wavelet denoise) and highlight recovery (its blend mode) are set
// at decoding, so changing them decodes again; the rest develops from the decoded pixels. Lens correction needs a lens profile,
// which LibRaw doesn't apply, so it's unavailable here.

export const isRAW = (name: string) => /\.(3fr|ari|arw|bay|cr2|cr3|crw|dcr|dcs|dng|erf|fff|iiq|k25|kdc|mef|mos|mrw|nef|nrw|orf|pef|raf|raw|rw2|rwl|sr2|srf|srw|x3f)$/i.test(name)

export type DecodedRaw = { width: number; height: number; pixels: Uint16Array }
type LibRaw = { open(bytes: Uint8Array, settings: object): Promise<unknown>; metadata(full?: boolean): Promise<Record<string, unknown>>; imageData(): Promise<{ width: number; height: number; colors: number; bits: number; data: Uint16Array | Uint8Array } | undefined>; dispose(): void }

// One file being developed: its decodes, kept by what they were decoded with, so the sliders that don't need one stay quick.
export class RawSource {
  private engine: Promise<LibRaw> | null = null
  private decodes = new Map<string, Promise<DecodedRaw>>()
  constructor(readonly bytes: Uint8Array, readonly name: string) {}

  private libraw() { return this.engine ??= import('libraw-wasm').then(module => new (module.default as unknown as new () => LibRaw)()) }

  // The camera's own white balance as a temperature and tint, where the sheet's controls start.
  async asShot(): Promise<RawDevelopSettings> {
    const raw = await this.libraw()
    await raw.open(this.bytes.slice(), { halfSize: true, useCameraWb: true, noInterpolation: true })
    const meta = await raw.metadata(true), color = meta.color_data as { cam_mul?: number[]; pre_mul?: number[]; rgb_cam?: number[][] } | undefined
    const shot = color?.cam_mul && color.pre_mul && color.rgb_cam ? asShotFromCamera(color.cam_mul, color.pre_mul, color.rgb_cam) : { temperature: 5000, tint: 0 }
    return rawSettings(shot.temperature, shot.tint)
  }

  // The frame decoded: `half` for the preview, at half size and quicker interpolation.
  decode(half: boolean, s: RawDevelopSettings): Promise<DecodedRaw> {
    const key = JSON.stringify([half, s.highlightRecovery, s.noiseReduction])
    let found = this.decodes.get(key)
    if (!found) {
      found = (async () => {
        const raw = await this.libraw()
        await raw.open(this.bytes.slice(), { useCameraWb: true, outputBps: 16, outputColor: 1, gamm: [1, 1], noAutoBright: true, halfSize: half, userQual: half ? 0 : 3, highlight: s.highlightRecovery ? 2 : 0, threshold: s.noiseReduction * 400 })
        const image = await raw.imageData()
        if (!image || image.colors !== 3) throw new Error(`“${this.name}” couldn’t be developed.`)
        const pixels = image.data instanceof Uint16Array ? image.data : new Uint16Array(image.data.buffer, image.data.byteOffset, image.data.byteLength >> 1)
        return { width: image.width, height: image.height, pixels }
      })()
      // Only the newest few stay, as each holds a whole frame.
      this.decodes.set(key, found)
      while (this.decodes.size > 3) this.decodes.delete(this.decodes.keys().next().value!)
      found.catch(() => this.decodes.delete(key))
    }
    return found
  }

  async develop(half: boolean, s: RawDevelopSettings) {
    const decoded = await this.decode(half, s)
    return { width: decoded.width, height: decoded.height, pixels: developPixels(decoded.pixels, decoded.width * decoded.height, s) }
  }

  dispose() { this.engine?.then(raw => raw.dispose()); this.engine = null; this.decodes.clear() }
}
