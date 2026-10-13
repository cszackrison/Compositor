# Web edition: what's left

Gaps between `web/` and the Mac app, largest first. Specs for most of these can be pulled from the Swift source the same way the
existing features were.

## Big pieces

- [x] **Type tool** (T). A click starts point text on its baseline, a drag a paragraph box that wraps; a click on a text layer edits it
  (double-click in the Layers panel or Return too). Text is set with the browser's canvas (`render/text.ts`), the same layout drawing
  the layer and placing the caret, selection and box handles; typing, input methods and the clipboard go through a hidden text
  field. The Type bar sets the face (with a live preview), size, color, alignment, tracking and leading, of the selected letters for
  face and color (`colorRuns`, `fontRuns`); Option with the arrows sets tracking and leading; Done or ⌘Return keeps, Escape cancels.
  Faces are found by their PostScript names through `@font-face local()`, so a project's fonts draw where they're installed.
  - [x] Fill with Foreground/Background on a live text layer recolors the text ("Fill Text").
  - [x] The foreground color picker paints a text draft's selected letters.
  - [ ] Browser text layout isn't Core Text's: a project's text re-set on the web can sit a pixel or two differently, and wrap
    differently at the edge of a box.
  - [ ] The font menu lists every installed face only where the browser can (Chrome and Edge, on HTTPS or localhost, once allowed);
    elsewhere it offers the common faces it can draw.
- [x] **Camera Raw filter.** Filter › Camera Raw Filter docks its column at the window's right: the histogram, then Light, Color,
  Color Grading, Effects, Curve, Color Mixer, Detail, Optics, Geometry and Calibration, each with an eye and a reset. The measured
  tables (`Compositor/Resources/CameraRawTables.bin`) are copied beside the page at build time and unpacked on first use; the
  results match the Mac's tests of Photoshop's numbers.
  - [x] The targeted adjustment drag (Curve and Color Mixer), Point Color, Upright › Guided with guides drawn on the layer, Option on
    a Light slider for the clipping view and on Masking for the sharpening mask, the clipping triangles, the vectorscope (right-click
    the histogram) and the RGB readout. Guides are measured in pixels here, so a line comes out level on any layer (the Mac takes
    their angle in fractions of the width and height).
- [ ] **PSD/PSB import**, with the conversion report (about 1,500 lines of Swift in `Compositor/IO/PSD`). CMYK PSDs too, since 1.5
  (896d5c8).
- [ ] **Camera RAW import** and its develop step. Needs a wasm decoder (LibRaw or similar).
- [x] **TIFF and SVG import.** TIFF is read here (UTIF, lazily loaded) where the browser can't, including 16-bit and CMYK; SVG is
  drawn by the browser, fitted to the canvas as the Mac does.
- [ ] **HEIC import** only works where the browser decodes it (Safari). A wasm decoder (libheif) would cover the rest.
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

## From upstream (Mac 1.4.6 to 1.5.1)

Merged 2026-10-12. Done in the merge: format version 13 (16-bit PNG and HDR OpenEXR layers open, shown dithered to 8 bits as the
Mac shows them, and saved back untouched until edited), Content-Aware Fill on the new PatchMatch `patch_fill` (Spot Healing's
Content-Aware mode got it for free), Filter › Scanlines split out of Dither, and the Blocks runtime hooks that `__block` in the
new C needs. Hashes are upstream's commits; effort is a guess.

### Small

- [x] **Filter › Last Filter** (0415aa4, 6b81d4a): the last Filter-menu filter again with the same settings and no dialog, named in
  the menu ("Last Filter: Gaussian Blur"); not Content-Aware Fill or the Image menu's adjustments. `FilterSession.start()` and
  `commit()` already run a job without a dialog, so keep the last job from `FilterDialog`'s commit. The Mac's ⌃⌘F has no separate
  chord off the Mac, and Ctrl+F is the browser's Find. Small.
- [x] **Gaussian Blur: Preserve Transparency, solid edges at the canvas, 5 px to start** (9a0ad3e). Preserve Transparency blurs
  without padding, divides by the blurred alpha and puts the original alpha back. A side at or past the canvas edge isn't padded
  and carries its edge pixels outward (Motion Blur too); other sides still fade out. Small.
- [x] **Color Overlay, Inner Glow and Inner Shadow recolor translucent pixels fully** (e7e295e, 9cb57db): recolor the layer's own
  pixels before they go over the shadow, glow and outside stroke, and drop the `shape ×` from the inner buffers in
  `render/effects.ts`. Regenerate `test/fixtures/effectsReference.ts`. Small.
- [x] **Image › Rotate Canvas 90° Clockwise and Counterclockwise** (754f188, `CanvasRotation.swift`): width and height swap, each
  transform quarter-turns about the canvas (no resampling), guides swap axis, the selection turns too. Model on
  `store.flipCanvas`. Small.
- [x] **Canvas Only** on F (ad4bddf, 088a5c1, 720c121): the canvas alone on black over the whole window, F or Esc to leave, maybe
  `requestFullscreen` too. Small.
- [x] **New Canvas** (b0b4f01, ab9779a, a00d8b6): sizes in px, in, cm or mm at 72 or 300 DPI, Transparent, White or Black, every
  setting a pill, always starting transparent in pixels at 72 DPI. The unit math is in the Image Size dialog. Small.
- [x] **Paste an image on the New Canvas screen** to make the canvas from it (2522e3b). `onPaste` skips text fields, and the width
  field has focus. Small.
- [x] **Reveal the selected layer in the Layers panel** (d2b8aaf): open its folders and scroll its row into view when it's chosen on
  the canvas. Small.
- [x] **Import a folder of images as layers** (b2a0c45): a dropped folder without `manifest.json` brings in the images directly in
  it, in natural name order, instead of failing. Plus File › Import Folder…. Small.
- [x] **A layer dragged into a new project sizes the canvas to it** (e580107), not to the document it came from. Small.
- [x] **Keyboard Shortcuts: clear a shortcut** to None (87e2283), and load saved shortcuts one at a time, so one bad entry doesn't
  throw them all away (`load()` in `editor/shortcuts.ts`). Small.
- [x] **HEIF from cameras** (.hif, .heif, 70b3e14): accept them by extension, as `file.type` is often empty. Decoding still needs
  Safari, or a wasm decoder. Small.
- [x] Untitled projects numbered with the lowest free number (d0ec2f3), rather than all "Untitled". Small.
- [x] Save, Don't Save and Cancel on closing an unsaved project, instead of `window.confirm`, with Save the one colored button
  (283d360, 4e035bf). Small.
- [x] Adjustment layer button before the layer effects button in the Layers footer (067fca4). Trivial.
- [x] Drop anywhere on the tab bar to open in a new project (d3d0ce7). Trivial.
- [x] ⌘ or Ctrl with a middle drag zooms, 2^(dy/100) about the press point (e03923f); and the closed hand for a middle-button pan
  with any tool (c0a1cd0). Trivial.
- [x] Image Size caps the effect sizes it scales (94e90bd): sizes and blurs at 500, distances at 5000, in `scaleEffects`. Trivial.

### Medium

- [x] **Command palette** on ⌘F, Search Commands (cb139a1, 384632d, 07b8b1e, 94b57f7, bba92dc, 720c121): every menu command, tool
  and tool mode, whole words first, disabled ones last, checkmarks for toggles, Return runs the chosen row. Build it from `menus`
  in `App.tsx`; needs a key other than Ctrl+F off the Mac.
- [x] **File › Export As…** (450af5f, b1db93d, f5ae5ba, dac3bc6): JPEG and PNG first, PDF under More, sized with the ratio locked
  or by percent, previewed on the checkerboard with the file size. Grow `ExportJPEG` into it; PDF needs a small writer (fflate
  for its streams).
- [x] **Navigator** (3e09948): a minimap in the canvas's top-right corner from 300% zoom, the visible part boxed, click or drag to
  move there, redrawn 250 ms after edits settle. Needs a small render of the document that leaves the view alone.
- [x] **Filter › Progressive Blur** (3ae11cd): a blur from From to To along a line dragged on the canvas, or out from a point; Invert
  swaps them. Needs dragging on the canvas while a filter is open (`canvasPicker` only takes clicks).

### Large

- [x] **16-bit and HDR layers at full depth** (d9cdb81, 6aea90a, 2b9603f, 3d2ada4, 2fe3524, a10fcb7, 905efc5). `model/deep.ts` keeps
  a layer's 16-bit or half-float pixels beside its dithered 8-bit copy; painting is taken over them at 8 bits (`deep_take_painted`),
  and the canvas draws them from half-float textures, dithered to the screen. Filters and adjustments run at full depth on OK
  (`editor/deepFilters.ts`: floats for the blurs and Bloom, color lookups, exact HDR Exposure, the 8-bit runs read between for the
  rest), as do Fill, Invert, Apply Mask, Image Size, Merge, floating selections, the clipboard, pixel moves, Distort and the
  Gradient tool. Convert to 8/16-Bit and the 16-Bit / HDR tag are in the Layers panel; Export As writes 16-bit PNG.
  - [x] Liquify and Smudge run each dab on a half-float copy too, and a Blur stroke is made again at full depth from its coverage,
    as the Mac's 16-bit working copies do. Painting past a smaller layer's edge grows its deep pixels with it.
  - [x] Filter previews on an HDR layer are made again from its HDR pixels, once through, as the Mac previews them.
- [x] **Import 16-bit images, EXR and Radiance HDR** (d9cdb81, 7f239dc). They come in dithered to 8 bits as the Mac shows them, and a
  16-bit PNG or EXR is kept as the layer's file until it's edited, so saving keeps its depth.
  - [x] Radiance HDR is kept as an OpenEXR (`io/exr.ts` writes half-float, ZIP-compressed EXR; ImageMagick and OpenEXR read it).
- [x] **EXR export** for documents with HDR layers (b9186f7). A document with an unedited HDR layer composites in half floats, the
  layer drawn from its own pixels: Exposure works past white and the tonal adjustments divide highlights down and back, so turning
  Exposure down shows them, and Export As offers EXR.
  - [x] Blend modes carry light brighter than white through (Multiply, Lighten, Linear Dodge and the rest). Layer effects pass
    through 8 bits, as the Mac's export does.
- [x] **CMYK** (59025aa, dac3bc6): View › CMYK › Proof Colors and Gamut Warning on the canvas (a 3D lookup in the display shader, with a
  pill at the canvas's foot), and Export As writes JPEG, TIFF (new, under More) and PDF in a profile's inks with it embedded. Color
  management is LittleCMS (lcms-wasm, vendored in `web/vendor/lcms`). Browsers ship no CMYK profile, so profiles come from Load Profile and are kept in the browser.
  - [x] CMYK JPEG and TIFF files open through their own profile, or the chosen one when they name none (the Mac's Generic CMYK has no
    browser equivalent), and one that starts a project has its profile kept and chosen. TIFFs go through LittleCMS; JPEGs are
    decoded by the browser with the profile embedded, as Chrome and Safari convert them (Firefox may not).
- [ ] Open a Mac 1.5 project with an HDR layer and compare. The web reads EXR as premultiplied linear light, which upstream's EXR
  round-trip test implies ImageIO writes, but it was only checked against ImageMagick's files.

Mac only, nothing to port: versions and update feeds, CI and screenshot tests, the app icon, RAW develop speedups and its noise
reduction, lens and highlight recovery (part of the RAW import item above), macOS menu and dialog details, and Layers panel
redraw fixes the web doesn't have.

## Untested by hand

Automation couldn't hold modifier keys during drags, so these were only exercised in code:

- [ ] Option-drag to duplicate layers
- [ ] ⌘-drag (Ctrl on Windows and Linux) to move selected pixels, and ⌘⌥-drag to copy them
- [ ] ⌘-drag a handle to free distort
- [ ] The Hue/Saturation targeted hand on a real image
- [ ] Open Recent, which needs a browser with folder access (Chrome or Edge)
