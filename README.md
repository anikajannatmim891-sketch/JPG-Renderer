# Universal Visual Render Studio

A local Electron artwork renderer with a React interface, isolated Playwright Chromium, Sharp sRGB raster exports, persistent serial queue, genuine SVG preservation, and automatic HTML-source metadata embedding/readback with ExifTool. Source is the artwork; there is no generator or template engine.

**Windows 1.0.0 is built and installation-tested.** [Download the installer artifact](https://github.com/anikajannatmim891-sketch/JPG-Renderer/actions/runs/41967594571/artifacts/13388541731), extract the ZIP, and run `Universal-Visual-Render-Studio-Setup-1.0.0.exe`. See [Windows release evidence](docs/WINDOWS-RELEASE.md) for checksums, executed tests and limitations.

## Develop and run

Node 22.21+ (or 24) and npm are needed for development only:

```sh
npm ci
npm run electron:install
npm run browser:install
npm run resources:prepare
npm run build
# Set PLAYWRIGHT_BROWSERS_PATH to the absolute vendor/chromium directory:
# PowerShell: $env:PLAYWRIGHT_BROWSERS_PATH = "$PWD/vendor/chromium"
# POSIX: export PLAYWRIGHT_BROWSERS_PATH="$PWD/vendor/chromium"
npm run dev
```

Alternatively set `UVRS_CHROMIUM` to an installed Chromium executable, as used for Linux validation. That override is explicitly separate from testing the pinned runtime. Preserve Chromium sandboxing, TLS, dependency integrity checks and the platform proxy. For Linux desktop development, use a display/Xvfb and Chromium system libraries. Never use `--no-sandbox` to hide an environment failure.

```sh
npm test                  # six core tests and eleven metadata tests
npm run test:render       # actual high-resolution renderer regression exports
npm run test:metadata     # 8K/12K image exports with embedded/read-back metadata
node scripts/ui-smoke.mjs # actual Electron import/export interaction
npm run package:win       # run on Windows; bundles Chromium and builds NSIS
npm run smoke:packaged    # silently installs NSIS, tests actual installed UI
```

`package-lock.json` pins dependencies. `npm run package:win` installs its required pinned Chromium automatically. Core rendering is offline after installation. Installed users need no separate Node, Python, Chromium or Rust. The installer artifact is `release/Universal-Visual-Render-Studio-Setup-1.0.0.exe`. It is unsigned unless you supply your own signing configuration; Windows may show an unknown-publisher prompt. The Windows GitHub Actions workflow builds, installs and smoke-tests it and uploads the installer and real images. [Run 41967594571](https://github.com/anikajannatmim891-sketch/JPG-Renderer/actions/runs/41967594571) passed, including installed native 8K/10K/12K JPEG and 8K transparent PNG exports with metadata readback.

## Use the application

1. Open an HTML/SVG file or project folder, drag a source file into the workspace, or paste self-contained HTML and click **Load pasted source**.
2. Choose target dimensions and the source's logical CSS design width. Choose format/quality, time, seed and transparency as appropriate. 8K/10K/12K and portrait/aspect presets are included; custom dimensions are checked honestly.
3. Review the automatically populated **Metadata** section. Edit title, description, ordered keywords or 0–5 rating if needed (default 5). Missing fields must be corrected, or explicitly approve a metadata-free export by disabling embedding. See [metadata guide](docs/METADATA.md).
4. Choose an output directory and **Render preview** or **Queue full-resolution export**. Previews run the final-resolution pipeline, then fit the actual encoded result to the workspace. 1:1 shows its actual pixels; drag to pan.
5. Inspect the actual size, bytes, duration, alpha, profile, warnings and renderer information in **Diagnostics**. Queue actions support cancel, retry, inspecting completed exports and revealing output files.
6. For genuine standalone SVG select **Native SVG**, or **EPS via Inkscape** when available. These are distinct from raster exports. AI export is unavailable.

Outputs receive embedded XMP (and compatible JPEG IPTC), independent readback verification, unique names and a JSON technical manifest. Metadata is never stored only in the JSON manifest. A metadata failure preserves one encoded render for **Retry metadata** without rendering again. Vector metadata is not implemented. Existing exports are never overwritten. Settings, project history, queue manifests and pasted sources are stored in Electron's userData directory. Interrupted jobs recover as failed and can be retried. Only one heavy render runs at once. Browser processes are closed on success, error and cancellation. Logs are bounded per job and saved queue history is bounded; original sources are preserved.

Adobe Stock mode enforces 4–100 MP raster, ≤45 MB, JPEG or transparent PNG and sRGB ICC. Vector mode enforces 15–65 MP artboards. Validation detects basic uniform/black/transparent failures, low-resolution Canvas, failed loads, exact duplicate hashes and perceptual similarity. It cannot guarantee Stock approval, artistic quality, absence of all missing content, or seam-free output for arbitrary effects. Quality/resolution are never reduced automatically. Browser captures are 8-bit; no HDR/16-bit claims.

See the short [authoring contract](docs/AUTHORING.md) for deterministic Canvas/WebGL, local dependencies, optional manifest, readiness and correct tiles.
