// The parts of lcms-wasm (LittleCMS in WebAssembly) the CMYK code uses.
declare module 'lcms-wasm' {
  export type Lcms = {
    cmsOpenProfileFromMem(data: Uint8Array, size: number): number
    cmsCloseProfile(profile: number): void
    cmsCreate_sRGBProfile(): number
    cmsGetColorSpace(profile: number): number
    cmsGetProfileInfoASCII(profile: number, info: number, language: string, country: string): string
    cmsCreateTransform(input: number, inputFormat: number, output: number, outputFormat: number, intent: number, flags: number): number
    cmsDeleteTransform(transform: number): void
    cmsDoTransform(transform: number, input: ArrayLike<number>, size: number): Uint8Array
  }
  export function instantiate(options?: { locateFile?: (name: string) => string }): Promise<Lcms>
  export const TYPE_RGB_8: number, TYPE_CMYK_8: number, INTENT_RELATIVE_COLORIMETRIC: number, cmsFLAGS_BLACKPOINTCOMPENSATION: number, cmsSigCmykData: number, cmsInfoDescription: number
}
declare module 'lcms-wasm/dist/lcms.wasm?url' { const url: string; export default url }
