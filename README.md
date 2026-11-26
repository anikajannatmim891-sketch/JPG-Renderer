# Universal Visual Render Studio

Universal Visual Render Studio uses Electron, isolated Playwright Chromium, Sharp, and ExifTool to render original artwork to native-resolution stock JPEGs. Rendering and metadata verification run offline.

[Windows x64 downloads](https://github.com/anikajannatmim891-sketch/JPG-Renderer/releases)

## Autopilot

1. Choose **Add Files**, drop artwork files, or choose **Add Folder**. Turn on **Include subfolders** for a recursive scan.
2. Choose an **Output Folder**, a **Global Resolution Preset**, and an **Output Profile**. Autopilot remembers these settings.
3. Choose **Start Autopilot**. The queue analyzes each artwork, captures its native pixels, encodes and embeds metadata, and reopens the export for verification.
4. Select a row for its dimensions, strategy, and diagnostic. **Needs Attention** lists individual failures and lets you correct exceptional metadata on the retained image. **Thumbnail** uses the completed JPEG. **Save Batch Report** exports one JSON summary.

Use **Pause All** to stop dispatch after active work finishes. You can pause or cancel an individual job and resume paused jobs. **Clear Completed** removes queue rows while keeping the JPEGs. SQLite persists progress and encoded checkpoints in the app’s data directory. Interrupted jobs resume when the app reopens unless the batch was paused.

The 4K, 6K, 8K, 10K, 12K, and custom presets target the longest edge. Exact integer aspect ratios and the selected profile determine the actual dimensions. For example, Adobe Stock limits a 10K square to 10000 × 10000. General JPEG and Transparent PNG offer a 16K longest-edge target where the engine and exact aspect ratio allow it. The Adobe profile targets 4–100 MP, 45 MB and 49 keywords. The Shutterstock profile targets 4–100 MP, 50 MB and 50 keywords. JPEG starts at quality 96 with 4:4:4 chroma and an sRGB ICC profile. Autopilot can lower JPEG quality to the configured floor, which defaults to 88. You can separately opt into lower native dimensions after WebGL capture failures. The selected output folder contains finished images by default. Publishing requires a filesystem that supports hard links, such as NTFS.

## Rendering and metadata

Autopilot checks fixed layout, the manifest and runtime render contract, artwork bounds, SVG and Canvas CSS dimensions, inline design constants, and filename hints. It records conflicting evidence and sends genuinely ambiguous dimensions to Needs Attention. A responsive artwork that fills any viewport may need a source declaration or an existing dimension hint in its filename.

Chromium renders HTML/CSS, SVG, Canvas, and supported JS/TS/React projects. Canvas sources that already use DPR or a render contract get the requested device scale. Autopilot can adapt the recognized fixed-size Canvas 2D and single-pass fullscreen shader patterns described in the [authoring contract](docs/AUTHORING.md). Compatible Three.js contracts can expose a camera for native view-offset tiles. Arbitrary shader pipelines, framebuffer effects, and Canvas operations that depend on backing-store coordinates need a render contract when direct capture fails. Pinned graphics libraries include Three.js and its add-ons, Babylon.js, React Three Fiber, and a Three.js WebGL2 path tracer. WebGPU checks actual submitted work, device diagnostics, native surface sizes, and capture. Version 2 render contracts support worker readiness, camera tiles, progressive sampling and disposal. Output options expose a sample limit, time budget and verified hardware policy. GPU diagnostics report the backend actually used. Spatial image checks catch blank frames and some incomplete regions. They cannot establish artistic intent or stock marketplace approval.

The per-field metadata order is explicit Advanced Studio edits, the authoritative `uvrs-metadata` JSON, runtime metadata, project manifest metadata, standard HTML tags, and the document title or default five-star rating. ExifTool writes the original ordered text to XMP and, where fields fit the format, IPTC. An independent readback verifies both namespaces and checks that metadata embedding left decoded pixels unchanged. Missing or malformed metadata enters review. Transient writer or readback failures can retry the encoded image up to three attempts without launching Chromium again. See the [metadata guide](docs/METADATA.md).

Imported artwork runs in Chromium with its sandbox enabled. Autopilot blocks external network requests and serves supported assets from the selected artwork directory, excluding hidden paths and common credential files. Keep artwork and its local dependencies in a dedicated directory. Source files are read-only throughout the workflow.

**Advanced Studio** retains the individual preview, manual dimensions and Direct/Tiled controls, metadata editing, transparent PNG, WebP, and editable SVG or EPS export.

## Development and Windows installer

Requires Node 22.21+ and npm for development.

```sh
npm ci
npm run electron:install
npm run browser:install
npm run resources:prepare
npm run build
npm test
npm run test:render
npm run test:metadata
npm run test:autopilot
npm run test:graphics
npm run test:ui
```

Set `PLAYWRIGHT_BROWSERS_PATH` to the absolute `vendor/chromium` directory to use the pinned development runtime. For Linux development, `UVRS_CHROMIUM` can point to a sandbox-capable installed Chromium. Set `UVRS_SOFTWARE_TEST=1` on machines without a hardware WebGL backend. The software WebGPU acceptance uses `UVRS_WEBGPU_TEST=1 UVRS_WEBGPU_CANVAS_TEST=1` with a Chromium Vulkan compositor. For hardware, use `UVRS_HARDWARE_WEBGPU=1` without either software flag. CI proves software WebGL and WebGPU exports. Hardware-driver behavior requires separate validation.

The [Windows workflow](.github/workflows/windows.yml) builds the x64 NSIS installer with Chromium and ExifTool bundled, installs the EXE, and drives real Autopilot exports through the installed UI, including a bundled Babylon.js scene. A workflow dispatch with **Publish** enabled publishes the tested version and checksum to [GitHub Releases](https://github.com/anikajannatmim891-sketch/JPG-Renderer/releases). The [Windows release evidence](docs/WINDOWS-RELEASE.md) records the earlier 1.0.0 installer and verification.
