import { useEffect, useRef, useState } from 'react'
import { useEditor } from './hooks'
import { store } from '../editor/store'
import { type GIFLayerData, deleteFrame, duplicateFrame, frameRaster, gifFrames, setUniformDelay, useOriginalDelays } from '../model/gif'
import { showFrame, syncedGIF, withGIF } from '../model/gifLayer'
import type { Raster } from '../model/raster'

const presets = [20, 33, 40, 50, 67, 80, 100, 125, 150, 200, 250, 500, 1000]
const thumbnails = new WeakMap<GIFLayerData['source'], Map<string, string>>()

// A frame small, as a data URL, for the strip: made once per frame of a source (or per edited raster).
function thumbnail(gif: GIFLayerData, index: number): string {
  const edited = gif.framePixels.get(index), key = edited ? `e${index}:${edited.version}` : `${index}`
  let cache = thumbnails.get(gif.source)
  if (!cache) thumbnails.set(gif.source, cache = new Map())
  const hit = cache.get(key)
  if (hit) return hit
  const raster: Raster = frameRaster(gif, index), f = Math.min(1, 56 / Math.max(raster.width, raster.height))
  const full = new OffscreenCanvas(raster.width, raster.height), image = new ImageData(raster.width, raster.height), d = image.data, p = raster.data
  for (let i = 0; i < p.length; i += 4) { const a = p[i + 3]; if (a) for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, Math.round(p[i + c] * 255 / a)); d[i + 3] = a }
  full.getContext('2d')!.putImageData(image, 0, 0)
  const small = document.createElement('canvas')
  small.width = Math.max(1, Math.round(raster.width * f)); small.height = Math.max(1, Math.round(raster.height * f))
  small.getContext('2d')!.drawImage(full, 0, 0, small.width, small.height)
  const url = small.toDataURL()
  cache.set(key, url)
  return url
}

// A GIF layer's frames under the canvas (GIFTimeline.swift): play and pause, one delay for every frame or the GIF's own, and a strip of
// frames to show, duplicate or delete.
export function GIFTimeline() {
  const state = useEditor()
  const layer = store.active, gif = layer?.gif
  const [playing, setPlaying] = useState(false)
  const [menu, setMenu] = useState(false)
  const [, redraw] = useState(0)
  const stripRef = useRef<HTMLDivElement>(null)
  // Thumbnails come in a few at a time, so a long GIF doesn't hold up the page.
  useEffect(() => {
    if (!gif) return
    let cancelled = false, i = 0
    const frames = gifFrames(gif)
    const step = () => { if (cancelled) return; const end = Math.min(frames.length, i + 8); for (; i < end; i++) thumbnail(gif, frames[i].index); redraw(n => n + 1); if (i < frames.length) setTimeout(step, 16) }
    step()
    return () => { cancelled = true }
  }, [gif?.source, gif?.framePixels, gif?.deletedFrameIndices, gif?.frameOrder])
  // Playback shows each frame for its delay, live (not an undo step), and puts back the frame it started on when stopped.
  useEffect(() => {
    if (!playing || !layer?.gif) return
    const id = layer.id, start = layer.gif.selectedFrameIndex, frames = gifFrames(syncedGIF(layer) ?? layer.gif)
    let position = Math.max(0, frames.findIndex(f => f.index === start)), timer = 0
    const tick = () => {
      position = (position + 1) % frames.length
      const l = store.layer(id), changes = l && showFrame(l, frames[position].index)
      if (!changes) { setPlaying(false); return }
      store.updateLayerLive(id, changes)
      timer = window.setTimeout(tick, Math.max(20, frames[position].delay * 1000))
    }
    timer = window.setTimeout(tick, Math.max(20, frames[position].delay * 1000))
    return () => { clearTimeout(timer); const l = store.layer(id), back = l && showFrame(l, start); if (back) store.updateLayerLive(id, back) }
  }, [playing, layer?.id])
  useEffect(() => { if (!gif) setPlaying(false) }, [!!gif])
  useEffect(() => { stripRef.current?.querySelector('.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [gif?.selectedFrameIndex])
  if (!layer || !gif || state.panel) return null
  const frames = gifFrames(gif), delays = frames.map(f => Math.round(f.delay * 1000)), shortest = Math.min(...delays), longest = Math.max(...delays)
  const originals = frames.map(f => Math.round((gif.timing.frameDelays.get(f.index) ?? f.duration) * 1000)), own = `${Math.min(...originals)}${Math.min(...originals) === Math.max(...originals) ? '' : `–${Math.max(...originals)}`}`
  const uniform = gif.timing.mode === 'Same for all'
  const apply = (next: GIFLayerData | null, name: string) => { if (next) store.updateLayer(layer.id, withGIF(next), name) }
  const current = () => syncedGIF(store.active!) ?? gif
  const select = (index: number) => { setPlaying(false); const changes = showFrame(layer, index); if (changes) store.updateLayer(layer.id, changes, 'Select Frame', 'gif-frame') }
  return (
    <div className="gif-timeline">
      <div className="gif-controls">
        <button className="gif-play" title={playing ? 'Pause' : 'Play'} disabled={frames.length < 2} onClick={() => setPlaying(!playing)}>{playing ? '❚❚' : '▶'}</button>
        <span className="menu" style={{ position: 'relative' }}>
          <button className="muted" title="How long each frame shows" onClick={() => setMenu(!menu)}>{uniform ? `${Math.round(gif.timing.uniformDelay * 1000)}ms` : shortest === longest ? `${shortest}ms` : `${shortest}–${longest}ms`}</button>
          {menu && <div className="menu-list" style={{ bottom: '100%', top: 'auto' }} onPointerLeave={e => { if (e.pointerType === 'mouse') setMenu(false) }}>
            <button onClick={() => { setMenu(false); apply(useOriginalDelays(current()), 'Frame Delay') }}><span>{uniform ? '' : '✓ '}{own} ms · Original</span></button>
            {presets.map(ms => <button key={ms} onClick={() => { setMenu(false); apply(setUniformDelay(current(), ms / 1000), 'Frame Delay') }}><span>{uniform && Math.round(gif.timing.uniformDelay * 1000) === ms ? '✓ ' : ''}{ms} ms · {+(1000 / ms).toFixed(1)} fps</span></button>)}
          </div>}
        </span>
      </div>
      <div className="gif-strip" ref={stripRef}>
        {frames.map((frame, n) => {
          const url = thumbnails.get(gif.source)?.get(gif.framePixels.get(frame.index) ? `e${frame.index}:${gif.framePixels.get(frame.index)!.version}` : `${frame.index}`)
          return <div key={frame.index} className={`gif-frame ${frame.index === gif.selectedFrameIndex ? 'selected' : ''}`} title={`Frame ${n + 1} · ${Math.round(frame.delay * 1000)} ms`} onClick={() => select(frame.index)}>
            {url ? <img src={url} alt={`Frame ${n + 1}`} /> : <span className="muted">{n + 1}</span>}
            <span className="gif-number">{n + 1}</span>
          </div>
        })}
      </div>
      <div className="gif-controls">
        <button title="Duplicate the selected frame" onClick={() => { setPlaying(false); apply(duplicateFrame(current(), gif.selectedFrameIndex), 'Duplicate Frame') }}>Duplicate</button>
        <button title="Delete the selected frame" disabled={frames.length < 2} onClick={() => { setPlaying(false); apply(deleteFrame(current(), gif.selectedFrameIndex), 'Delete Frame') }}>Delete</button>
      </div>
    </div>
  )
}
