import { refined, type BackgroundSettings } from './matte'

// Remove Background's full-size refine, off the page, so OK doesn't freeze it on a large layer.
self.onmessage = (event: MessageEvent<{ found: Float32Array; rgba: Uint8Array; width: number; height: number; settings: BackgroundSettings }>) => {
  const { found, rgba, width, height, settings } = event.data, out = refined(found, rgba, width, height, settings)
  self.postMessage(out, { transfer: [out.buffer as ArrayBuffer] })
}
