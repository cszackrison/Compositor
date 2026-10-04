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
- [x] **Select Subject and Remove Background**, with the ormbg model (Apache-2.0) in the browser instead of Apple's Vision:
  downloaded from Hugging Face on first use (88 MB on WebGPU, 44 MB on the CPU) and cached. Results differ from the Mac's.
- [ ] **Object selection (Magic tool)**: a click-to-select model (MobileSAM or SlimSAM) on the same runtime.
- [ ] Try Select Subject and Remove Background on phones (WebGPU in Chrome on Android and Safari on iOS 26).
- [ ] Remove Background's full-size refine (Advanced) runs on the main thread; a large layer pauses for a moment on OK.
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
- [ ] Filter previews run at full size (in a worker now, so the page stays responsive); the Mac caps most at 2048 px. Worth
  matching if large layers still feel slow on phones.
- [ ] Spot Healing and the Blur smear mode still paint on the CPU (Brush, Eraser, Clone Stamp, Smudge and Liquify run on the GPU).
- [ ] The low-latency canvas and pointer prediction were only checked in desktop Chrome; try them on a phone.

## Smaller differences

- [ ] Layer effects are kept through Crop, Canvas Size, Image Size and Trim; the Mac drops them, which looks like a Mac bug.
  Decide which way to go.
- [ ] Shortcuts that browsers reserve moved to ⌥ variants: New Canvas ⌥⌘N, Close Project ⌥⌘W, Transform ⌥⌘T, New Blank Layer ⌥⇧⌘N.
- [ ] Tabs have a right-click menu the Mac doesn't.
- [ ] Each change in the effect editor coalesces into one undo step; the Mac records every change.
- [ ] Ctrl+R (Show Rulers) on Windows and Linux couldn't be confirmed; browsers may keep it for reload.

## Touch and phones

Done: pinch and two-finger pan, long-press menus, the phone layout (top bar, bottom tool strips, layers sheet, full-screen
menu, dialogs as sheets), touch sizing, on-screen Shift/Option/Command, Clone Stamp's Set Source, bigger handles under a finger,
opt-in pen pressure, a web app manifest for the home screen, a large-canvas warning, and saving projects in the browser.

- [ ] Try it all on a real iPhone, iPad and Android phone: touch was only exercised with synthetic events, and the phone layout
  in a 390 px frame on a desktop.
- [ ] Phones in landscape get the desktop layout (they're wider than 760 px); a landscape phone layout may be worth it.
- [ ] Reordering layers by dragging on touch (Move Up and Move Down in the long-press menu for now).
- [ ] Offline use from the home screen would need a service worker.
- [ ] iOS may clear browser storage for sites not added to the home screen after a week unused; projects saved in the browser
  should be downloaded as a zip to keep.

## Untested by hand

Automation couldn't hold modifier keys during drags, so these were only exercised in code:

- [ ] Option-drag to duplicate layers
- [ ] ⌘-drag (Ctrl on Windows and Linux) to move selected pixels, and ⌘⌥-drag to copy them
- [ ] ⌘-drag a handle to free distort
- [ ] The Hue/Saturation targeted hand on a real image
- [ ] Open Recent, which needs a browser with folder access (Chrome or Edge)
