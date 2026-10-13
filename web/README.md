# Compositor for the web

A browser edition of Compositor that opens, edits and saves the same `.comp` projects as the Mac app.

- **Rendering**: WebGL 2, following the Mac app's export renderer: 8-bit premultiplied sRGB, pass-through folders, folder masks, clipping stacks, every blend mode, adjustment layers and layer effects.
- **Pixel code**: the app's own C kernels in `../Compositor/Rendering/*.c`, compiled to WebAssembly (`public/kernels.wasm`). They build the Black & White, Color Balance and Gradient Map color cubes, run the Magic Wand and trace selection outlines. The compiler is [`@yowasp/clang`](https://www.npmjs.com/package/@yowasp/clang), clang packaged for npm, so no Emscripten or system toolchain is needed.
- **UI**: React, written to follow the Mac app's layout and shortcuts (⌘ is Ctrl on Windows and Linux).

## Running

```sh
cd web
npm install
npm run dev      # builds kernels.wasm, then serves on http://localhost:5173
npm test         # project format, adjustments, wasm kernels, brush, layer operations
npm run build    # static site in dist/, deployable anywhere
```

`npm run wasm` rebuilds the kernels whenever a C file in `Compositor/Rendering` changes. The first build downloads the compiler, about 100 MB.

## Opening and saving

- **Chrome and Edge**: *Open Project Folder* reads a `.comp` folder and *Save* writes it back in place, using the File System Access API. The Mac app's file watcher picks up the change.
- **Firefox and Safari**: open a project folder or a zipped `.comp`; *Save* downloads a zip.
- Dropping a `.comp` folder, a zip or images onto the window opens or places them.

Fields the web app doesn't edit (text and shape metadata, unknown keys from newer builds) are kept on save. 16-bit and HDR (OpenEXR)
layers from the Mac open as an 8-bit copy dithered as the Mac shows them, and save back at full depth until they're edited; an
edited one saves as 8-bit. Text and shape metadata are dropped once their pixels change, as the Mac app does.

## What's here

- **Projects:** several open at once in tabs, with copy and paste of whole layers between them, or dragging layers onto another tab.
- **Layers:**
  - Layers and folders, drag to reorder, opacity, and all 24 blend modes.
  - Layer and folder masks: paint them, add one from the selection, apply, disable, link and unlink.
  - Clipping masks.
  - All twelve adjustment layer kinds, with editors. Levels has a histogram and Auto.
  - Layer effects, with a show/hide eye on each effect.
  - Right-click menus on layers and on the canvas.
- **Transform:**
  - Move, scale, rotate and flip, for one layer or several (or a folder) together.
  - Free distort (⌘-drag a handle).
  - Option-drag to duplicate.
  - Snapping to the canvas, layers, guides and grid, with snap lines.
- **Selections:**
  - Marquee, Lasso (Freehand and Polygonal), Magic Wand and Color Range.
  - Expand, Contract and Feather.
  - Load a layer or mask as a selection (⌘-click its thumbnail).
  - Move the outline, or ⌘-drag to move the selected pixels (⌘⌥-drag duplicates them).
- **Painting and retouching:** Brush and Eraser, Spot Healing, Clone Stamp, Smear (Liquify, Blur and Smudge), Gradient, and Shape layers that redraw when scaled. Plus right-drag to resize the tip, `[` `]` `{` `}`, and digit keys for opacity.
- **Image menu:** Curves, Levels, Hue/Saturation, Black & White, Color Balance, Exposure, Gradient Map, Grain and Invert, applied to a layer's pixels. Also Canvas Size, Image Size, Trim, Crop to Selection and Flip Canvas.
- **Filter menu:** Last Filter, Gaussian Blur, Motion Blur, Progressive Blur, Add Noise, Vignette, Bloom / Glow, Dither (all ten styles), Scanlines, Tonal Contrast and Lens Correction. Edit › Content-Aware Fill (⇧⌫). Each previews live and is limited to the selection.
- **Canvas aids:** the Crop tool (ratios, ⌥ for symmetric cropping), rulers, guides dragged from them, a layout grid, and a pixel grid at 800% and above.
- **Editing:**
  - Cut, Copy, Copy Merged and Paste (images from other apps too).
  - Layer via Copy, fill and clear.
  - Undo and redo, with named steps.
- **Photoshop files:** PSD and PSB (8-bit RGB and CMYK) open with their layers, folders, masks, clipping, text, shapes and
  Levels, Curves and Hue/Saturation layers, after a report of what will be converted.
- **Export and settings:**
  - Export As: JPEG, PNG or a one-page PDF, sized, previewed live (on the checkerboard for PNG) with the file's size. Export PNG saves at once.
  - Remappable keyboard shortcuts (Edit › Keyboard Shortcuts).
  - Drag a field's label to scrub its number.
- **Phones and tablets:**
  - Below 760 px wide: the canvas fills the screen, the tools and their options sit along the bottom, layers come up in a sheet, and the menus are one full-screen list.
  - One finger uses the tool; two fingers pinch to zoom and pan. A long press opens the canvas or layer menu.
  - On-screen Shift, Option and Command keys, and a Set Source button for Clone Stamp.
  - Optional pen pressure for brush size (off by default, as the Mac app has none).
  - Add to Home Screen for a full-screen app. Without folder access, Save keeps projects in the browser.

- **HEIC and HEIF** (iPhone photos, cameras' .hif) are read with [libheif](https://github.com/strukturag/libheif) compiled to WebAssembly ([libheif-js](https://github.com/catdad-experiments/libheif-js), LGPL-3.0), loaded the first time one is opened, as browsers other than Safari can't read them. They come in as sRGB through their embedded profile or color description, and 10-bit ones as 16-bit layers.
- **Camera RAW** files are decoded with [LibRaw](https://www.libraw.org) compiled to WebAssembly ([libraw-wasm](https://github.com/ybouane/LibRaw-Wasm), ISC; LibRaw is LGPL-2.1 or CDDL-1.0), loaded the first time one is opened, then developed in a sheet like the Mac's. The look differs from Apple's RAW engine, and Lens Correction is unavailable.
- **CMYK** proofing, export and opening CMYK files use [LittleCMS](https://www.littlecms.com) (MIT), from lcms-wasm, vendored in `vendor/lcms`.
- **Object selection** (the Magic tool's Object mode) uses [SlimSAM-77](https://huggingface.co/Xenova/slimsam-77-uniform) (Apache-2.0), a pruned Segment Anything, through ONNX Runtime Web: 14 MB, downloaded the first time and cached. The Mac uses Apple's Vision, so the outlines differ.
- **Select Subject and Remove Background** use [ormbg](https://huggingface.co/onnx-community/ormbg-ONNX) (Apache-2.0) through ONNX Runtime Web instead of Apple's Vision framework. The model downloads from Hugging Face the first time either is used (88 MB with WebGPU, 44 MB without) and is cached by the browser; images never leave the device. The masks differ from the Mac app's, since it's a different model; Remove Background's Refine, Contrast and Shift Edge follow the Mac's arithmetic.

## Deploying

It's live at [compositor.fyi](https://compositor.fyi). `npm run deploy` builds and uploads `dist/` to the server, where nginx
serves it as static files over HTTPS (needed for WebGPU, folder access and the clipboard).

## Not yet ported

See [TODO.md](TODO.md) for what's left, largest first.

## Differences from the Mac app

- **Shortcuts:** browsers keep ⌘N, ⌘W and ⌘T for themselves. New Canvas is ⌥⌘N, Close Project ⌥⌘W, Transform ⌥⌘T and New Blank Layer ⌥⇧⌘N. Everything can be remapped.
- **Size changes keep layer effects:** Crop, Canvas Size, Image Size and Trim keep them (the Mac app drops them). Image Size scales their sizes.
- **Approximations:**
  - Bloom / Glow stands in for Core Image's `CIBloom`.
- **Tabs:** they have a right-click menu (close, close others, close to the right); the Mac app's don't.


The renderer follows `docs/project-format.md` and the export path in the Swift source, but a few steps approximate Apple framework behavior: Catmull-Rom for Core Graphics' high-quality interpolation, standard formulas for Core Image's blend modes, and a Gaussian smear for `CIMotionBlur`. Color-only adjustments run through lookup tables, as the Mac app's live canvas does. Expect occasional one- or two-level differences from a Mac export.

Canvases over about 36 megapixels preview at reduced resolution. Export renders at full size up to the GPU's texture limit (usually 16,384 px on a side).
