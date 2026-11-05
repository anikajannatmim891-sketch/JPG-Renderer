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
