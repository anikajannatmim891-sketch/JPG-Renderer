# Artwork authoring contract, version 1

Self-contained static HTML/CSS and SVG need no framework. Open a file or a folder with `index.html`. Assets are served from that selected file's parent directory (or the selected project folder), on a random loopback port with an unguessable route. Relative images, fonts, scripts and textures work offline. Nothing modifies the original files. JavaScript executes in dedicated Chromium with no Electron or Node access.

A folder may contain `render-studio.json`:

```json
{
  "entry": "index.html",
  "width": 7680,
  "height": 4320,
  "designWidth": 1920,
  "seed": 42,
  "time": 1.5,
  "transparent": false,
  "requiredAssets": ["textures/paper.png"],
  "readiness": "explicit",
  "selector": "#artwork"
}
```

`width` and `height` are exported native pixels. `designWidth` is the CSS viewport width. Its corresponding CSS height must be integral; the pixel ratio is `width / designWidth`. For static HTML, Chromium paints the CSS layout at this effective resolution. Fixed-width content must fit that logical viewport. `selector`, if present, must have precisely the logical artwork dimensions; the app refuses implicit cropping/stretching. Standalone SVG must have a matching aspect ratio; its viewBox is rendered to the chosen pixel resolution without changing the source file.

The manifest does not grant network permission. External dependency origins are blocked unless a user adds exact HTTPS origins in the export panel and explicitly approves the job. WebSockets, service workers, new windows, browser permissions and downloads are disabled. Keep offline copies of project dependencies whenever possible. Browser sandboxing reduces risk but is not a promise that malicious JavaScript is harmless; select only the project folder you intend to expose.

## Deterministic Canvas, WebGL and animated artwork

Set `window.renderStudio` during document initialization:

```html
<canvas id="art"></canvas>
<script>
let animationFrame;
// If you start a live animation, keep its RAF handle and stop it in render().
window.renderStudio = {
  version: 1,
  ready: async () => {
    // Await all custom fetches, textures, models and asynchronous initialization.
    // Reject on failure. Do not resolve before your resources are ready.
  },
  async render({ width, height, cssWidth, cssHeight, pixelRatio, time, seed, tile }) {
    cancelAnimationFrame(animationFrame);
    const c = document.getElementById('art');
    c.width = width;
    c.height = height;
    c.style.width = cssWidth + 'px';
    c.style.height = cssHeight + 'px';
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#183653';
    ctx.fillRect(0, 0, width, height);
    // Draw the selected time and seeded state here. No later loop may overwrite it.
    // Await any GPU completion or async draw work before returning.
  }
};
</script>
```

`time` is seconds and `seed` is a finite number, passed unchanged. The app does not replace Math.random, patch RAF, rewrite source code, or claim control of arbitrary animation loops. The author must use its own seeded PRNG, select the requested frame, stop independent loops and resolve render only when drawing has completed. `ready` may also be a Promise. Render rejections fail the job.

The app waits for document load, font loading, image decoding, network quiescence and author readiness. Failed assets and JavaScript errors fail the job. CSS background images are covered by network failures/quiescence; custom streamed models/textures must be included in author readiness. The global render deadline is bounded. Static automatic mode rejects running CSS/SVG animations and nonzero fixed time; animation projects should implement the contract. Arbitrary automatic-mode Canvas/JS completion cannot be proven; use the contract for asynchronous drawing.

Canvas backing stores must cover their displayed area at the effective pixel ratio. A 300×150 Canvas stretched to a 12K output is rejected. Use `renderer.setPixelRatio(pixelRatio)` and `renderer.setSize(cssWidth, cssHeight)` for Three.js. Rendering must use a capturable frame (`preserveDrawingBuffer: true` is advisable for raw WebGL). WebGL is checked for context loss, actual drawing-buffer dimensions and software renderer identity. Software WebGL needs user acceptance. GPU memory availability is not reliably exposed by browsers.

## Explicit tiling

Tiling is opt-in:

```js
window.renderStudio.capabilities = { tiles: true };
```

When `tile` is non-null, its `x`, `y`, `width`, `height`, `fullWidth`, `fullHeight` and `overlap` are in **native output pixels**. `width`/`height` outside `tile` still describe the entire composition. The app changes the browser viewport to the tile's CSS dimensions. Set the backing store to `tile.width × tile.height`, and its CSS dimensions to those values divided by pixelRatio. Draw the exact portion of the global scene beginning at `(tile.x, tile.y)`; for Canvas2D, translate by `(-tile.x, -tile.y)` before using global native-pixel coordinates. The app captures real overlap and crops it before assembly. See `tests/fixtures/tiles.html` and `deterministic.html`.

For Three.js use camera.setViewOffset(fullWidth, fullHeight, x, y, width, height), and keep full-scene camera framing and state constant. Shader coordinates must add the tile offset; postprocessing must explicitly handle overlap and the full composition. The adapter must support all tile arguments, including edge tiles and overlap. Rendering the same CSS document with independently reflowed tiles is invalid. Effects with a support radius larger than the supplied overlap are unsupported without author-managed padding. Exact pixel comparison is tested for the compatible rectangle fixture; curved Canvas anti-aliasing may differ slightly between full and tiled rasterization. The app does not claim arbitrary filters or GPU pipelines are seam-free.

Direct Canvas rendering is rejected beyond the detected texture limit because some backends repeat texture content silently. Select contract tiles when available. There is no automatic software WebGL fallback, resize or hidden switch of rendering paths. This release caps output at 250 MP / 65535 pixels per axis and may reject earlier according to hardware and alignment limits.

## JS, TS, JSX and TSX

Open a browser entry module directly; the controlled esbuild adapter bundles it without running package scripts. It creates a page with `#root`, uses automatic JSX, supports text imports for `.glsl`, `.vert`, `.frag`, resolves project-local dependencies and provides bundled React and Three.js as fallbacks. Write the initialization/render mount in your entry; default-exporting a component alone does not mount it. ES module imports must resolve offline. Framework-specific config, asset loaders and arbitrary build commands are unsupported; build those trusted projects externally and open their browser output. No package install/build command is run automatically.

## Vector adapters

Standalone SVG export preserves actual geometry, groups, gradients and source dimensions. Only comment cleanup is enabled. resvg checks renderability; scripts, XML entities, foreignObject, raster images and external resources are rejected by the vector exporter. Rasterizing SVG for JPEG/PNG is a separate action. Vector Stock mode checks the original 15–65 MP artboard. Rasterized screenshots are never advertised as vectors.

EPS uses a discovered, version-probed Inkscape executable and a separate confirmation. Filters/masks/transparency are rejected conservatively. Fonts are outlined by Inkscape. EPS is checked for an EPSF header; appearance still needs review. Illustrator native AI automation, Blender and Python adapters are unavailable in this release and are labelled as such. Do not rename SVG/PDF/EPS to AI.

`src/core/adapters.ts` documents extension interfaces. Extensions are trusted host code integrated by a developer; the app does not execute plugin code found in an artwork folder. Core rendering needs no external adapter.

## Autopilot compatibility

For an artwork that can fill any viewport, declare `designWidth` and `designHeight` in
`render-studio.json`, or expose `window.renderStudio.design = {width, height}`. Autopilot compares
these with stable computed artwork bounds. A filename with `__css2400x1000__10k10200x4250.html`
or `_W1280_10K-8192x10240.html` supplies a design hint. A convention containing an export size
does not override the chosen resolution preset.

An existing Canvas 2D initialization can size its backing store with `devicePixelRatio` and draw
at its original logical dimensions. Autopilot can also adapt a single unscaled Canvas 2D with
fixed `CW` and `CH` property assignments, matching CSS dimensions, and logical drawing
operations, including shadows and filters with pixel lengths. Backing-store reads, pixel writes,
URL or layout-dependent filters, absolute transform resets, and canvas-to-canvas draws need
native DPR handling or a render contract for that pattern. Large standalone fixed-coordinate
canvases use padded native tiles after a diagnostic comparison checks the composition.

Autopilot can tile a single fullscreen WebGL pass that uses `gl_FragCoord` and an identifiable
two-component resolution uniform. It checks the adapter against the original diagnostic image
before capturing. Render-to-texture, depth/discard, multi-pass programs, mixed DOM overlays,
and shaders whose geometry or effects depend on tile size require an explicit tile contract
when direct capture fails.

A compatible Three.js `renderStudio` contract can opt into the camera adapter with
`capabilities: {tiles: true, threeViewOffset: true}` and `threeCamera: camera`. In tile mode,
size the drawing buffer to `tile.width` by `tile.height` physical pixels and preserve the
full-frame camera aspect. Autopilot sets and clears the camera view offset around the render.
The contract can specify `capabilities.tilePadding` in CSS pixels. Test postprocessing and
screen-space effects across tile boundaries before enabling tiles.

The optional manifest `metadata` object accepts the same title, description, ordered keywords,
and rating as `uvrs-metadata`. It sits below runtime metadata and above standard HTML tags.

## Graphics contract version 2

Version 1 projects still run. Use version 2 for asynchronous GPU setup, advanced
tiles, worker-backed canvases, or progressive rendering. Static HTML and SVG
can omit the contract when their layout is unambiguous and all assets load
locally. Use intrinsic SVG dimensions or a viewBox, or set a fixed artwork
container. Keep complex DOM and canvas layers within the same logical design.

```js
window.renderStudio = {
  version: 2,
  engine: 'WebGPU / WGSL',
  design: { width: 2400, height: 1000 },
  async ready() {
    // Load models, await textures, compile shaders, and create the GPU device.
  },
  async render({ width, height, cssWidth, cssHeight, pixelRatio, seed, time, tile }) {
    // Keep the design and camera at their authored dimensions and aspect.
    // Size the physical backing store to tile?.width ?? width and tile?.height ?? height.
    // Draw the selected deterministic frame.
  },
  async flush() {
    // Await any artwork-owned workers or device queues before capture.
  },
  dispose() {
    // Release devices, workers, textures, render targets and listeners.
  },
};
```

Keep `width` and `height` as physical full-frame dimensions even when rendering a
tile. Use `cssWidth`, `cssHeight`, and `pixelRatio` for logical layout. For a
Canvas 2D contract, scale the context or use an authored pixel-coordinate
pipeline exactly once. For WebGL2, initialize the canvas at the native
resolution before drawing and use the actual drawing-buffer dimensions to
validate your viewport. Uniform locations can be null when compiled away.
Worker-backed OffscreenCanvas artwork must resolve `render()` or `flush()` only
after the worker has drawn the requested native frame.

### Local libraries and assets

Use the pinned browser libraries shipped with Studio:

| Import | Pinned version |
| --- | --- |
| `three`, `three/addons/*`, `three/webgpu`, `three/tsl` | 0.180.0 |
| `@babylonjs/core`, `@babylonjs/loaders` | 9.38.0 |
| `react`, `react-dom`, `@react-three/fiber` | 19.2.0, 19.2.0, 9.8.2 |
| `three-gpu-pathtracer`, `three-mesh-bvh` | 0.0.24, 0.9.2 |

Use a JS, TS or TSX manifest entry for bundled imports and React Three Fiber.
An HTML module can import bare `three`, its addons and WebGPU modules, Babylon
core and loaders, or the Three.js path tracer. Studio resolves exact
Three.js 0.180.0 jsDelivr and unpkg module URLs to the corresponding bundled
files. Other versions must be supplied with the project. Studio resolves
imports at runtime and does not rewrite files on disk.

Use relative URLs for shaders, models, HDR environments, images, and fonts.
Declare essential project-relative files in `render-studio.json` under
`requiredAssets`. Addon modules include Three.js GLTF, OBJ, texture, KTX2, and
Draco loaders. Point decoder paths at assets under the project or, in HTML
modules, use `new URL('../libs/draco/', import.meta.resolve('three/addons/loaders/DRACOLoader.js')).href`
for the bundled Draco decoder directory. Use native WGSL for Babylon WebGPU. When compiling
GLSL with Babylon WebGPU, provide the compatible local glslang and Tint
converters using Babylon's engine options. Studio blocks unsolicited CDN
requests and executes no package scripts.

### Tiles and progressive frames

Enable `capabilities: {tiles:true, tilePadding:6, tileSize:480}` only after
comparing tiled and direct output. Padding and tile size are CSS pixels.
`tile.x` and `tile.y` begin at the top left of the full image. Convert Y for
WebGL fragment coordinates. WGSL fragment positions already use top-left
coordinates. Keep global coordinates, the camera and exposure fixed across
tiles.

For Three.js, expose `threeCamera` and set
`capabilities.threeViewOffset = true` for compatible scenes. For Babylon.js
or a custom camera, use `beginTile(args)` to apply the tile window to the
authored full projection and `endTile(args)` to restore it. The
[verified Babylon fixture](../tests/fixtures/graphics/babylon.ts) shows the
clip-space matrix for a standard left-handed perspective camera. Preserve the
technique appropriate to an authored orthographic, reversed-depth, or
custom projection. Keep full-image state for shadow maps, tone mapping, and
post-processing. Leave tiling disabled if an effect depends on pixels
outside the verified padding.

Declare `progressive: {minSamples:64, maxSamples:128, requireConvergence:true}`
and a `sample(args)` function for path tracing. `render(args)` initializes
the native scene and resets the accumulation for that output or tile.
`sample({samples,sampleLimit,...args})` must resolve to
`{samples: completedCount, converged: boolean}` after real work. Wait inside
the hook for asynchronous compilation and complete samples. Report completed
accumulation rather than render loop ticks. The exporter captures once the
minimum is met and, when requested, convergence is reported. If the
declared requirement exceeds the user's sample or execution budget, Studio
keeps the job in Needs Attention. It never emits the preview or lowers
samples to force completion. See the [tested path-tracer fixture](../tests/fixtures/graphics/pathtrace.ts).

### Verification boundaries

Studio checks submitted WebGPU work, actual device limits, surface size, device
loss, and validation errors. Some Chromium/driver combinations can run compute
and texture rendering but cannot present a WebGPU canvas. A project can author
an exact native texture-to-canvas readback, as in the
[WGSL readback fixture](../tests/fixtures/graphics/webgpu-texture.html).
Worker-side GPU devices remain dependent on authored readiness and presentation
contracts. Hardware-only mode rejects unverified worker GPU paths. Preserve
the authored lighting, physical materials, procedural seeds, and color
management in every rendering path.
