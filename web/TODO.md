# Web edition: what's left

Gaps between `web/` and the Mac app, largest first. Specs for most of these can be pulled from the Swift source the same way the
existing features were.

## Big pieces

- [ ] **Type tool.** Text layers render from their saved PNG but can't be edited. Needs inline editing in paragraph boxes, fonts,
  size, color, alignment, tracking and leading, and per-letter `colorRuns`/`fontRuns`. Browser text layout won't match Core Text
  exactly, so re-rendered text will differ slightly from the Mac.
  - [ ] Fill with Foreground/Background on a live text layer recolors the text ("Fill Text") instead of filling pixels.
  - [ ] The foreground color picker previews into a text draft's selected letters.
- [ ] **Camera Raw filter.** All of its C kernels already run in `kernels.wasm`; the panel (light, color, curves, mixer, grading,
  detail, optics, geometry, calibration) and the Swift glue that drives the kernels need porting.
- [ ] **PSD/PSB import**, with the conversion report (about 1,500 lines of Swift in `Compositor/IO/PSD`).
- [ ] **Camera RAW import** and its develop step. Needs a wasm decoder (LibRaw or similar).
- [ ] **HEIC, TIFF and SVG import.** HEIC and TIFF only work where the browser decodes them; SVG is easy.
- [ ] **Select Subject, Object selection (Magic tool) and Remove Background.** The Mac uses Apple's Vision framework, so these
  need an in-browser segmentation model (ONNX or WebGPU, SAM- or RMBG-style).
- [ ] **Live reload when the project changes on disk** (an AI agent or script writing the `.comp`). Browsers can't watch folders,
  so this would mean polling the directory handle in Chrome and Edge.

## Rendering

- [ ] **Tiled rendering**, so canvases over about 36 MP preview at full resolution and export isn't capped by the GPU's texture
  limit (usually 16,384 px a side). It would also stop brush strokes allocating two full-layer buffers.
- [ ] **Check against Mac exports.** These approximate Apple framework behavior and may be a level or two off:
  - [ ] Core Image blend modes (Color Burn and Dodge, Soft Light, Hard Mix, Divide and the rest)
  - [ ] Core Graphics high-quality resampling (Catmull-Rom here)
  - [ ] `CIMotionBlur`
  - [ ] `CIBloom` (Bloom / Glow)
- [ ] Filter previews run at full size; the Mac caps most at 2048 px. Worth matching if large layers feel slow.

## Smaller differences

- [ ] Layer effects are kept through Crop, Canvas Size, Image Size and Trim; the Mac drops them, which looks like a Mac bug.
  Decide which way to go.
- [ ] Shortcuts that browsers reserve moved to ⌥ variants: New Canvas ⌥⌘N, Close Project ⌥⌘W, Transform ⌥⌘T, New Blank Layer ⌥⇧⌘N.
- [ ] Tabs have a right-click menu the Mac doesn't.
- [ ] Each change in the effect editor coalesces into one undo step; the Mac records every change.
- [ ] Ctrl+R (Show Rulers) on Windows and Linux couldn't be confirmed; browsers may keep it for reload.

## Untested by hand

Automation couldn't hold modifier keys during drags, so these were only exercised in code:

- [ ] Option-drag to duplicate layers
- [ ] ⌘-drag (Ctrl on Windows and Linux) to move selected pixels, and ⌘⌥-drag to copy them
- [ ] ⌘-drag a handle to free distort
- [ ] The Hue/Saturation targeted hand on a real image
- [ ] Open Recent, which needs a browser with folder access (Chrome or Edge)
