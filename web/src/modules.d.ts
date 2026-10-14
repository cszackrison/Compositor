// libheif-js's WebAssembly build as an ES module (io/heif.ts types what it uses).
declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' { const factory: (options?: object) => unknown; export default factory }
// A name for each build, so the service worker it registers replaces the last one's (vite.config.ts).
declare const __BUILD__: string
declare const __VERSION__: string
declare const __COMMIT__: string
declare const __BUILT__: string
