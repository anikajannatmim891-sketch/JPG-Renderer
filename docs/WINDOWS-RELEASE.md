# Windows 1.0.0 delivery

The Windows x64 NSIS installer was built, uploaded, downloaded and installed successfully in GitHub Actions. The complete workflow passed:

https://github.com/anikajannatmim891-sketch/JPG-Renderer/actions/runs/41967594571

## Download

Installer artifact (ZIP containing the EXE):

https://github.com/anikajannatmim891-sketch/JPG-Renderer/actions/runs/41967594571/artifacts/13388541731

Extract and run `Universal-Visual-Render-Studio-Setup-1.0.0.exe`.

- Application build commit: `251f1e4da7d28d7d1092636fa44e903595a5b78a`.
- Installer bytes: `295821700`.
- EXE SHA-256: `a7c097db350d536cbe07c450bb63228c17b1917aeff1b2a8121f33b97cabc47c`.
- The downloaded EXE hash matches the Windows runner's `installer-origin.json` record.
- Installer is unsigned (no Authenticode certificate directory).
- Actions artifact retention currently expires February 3, 2027; GitHub access is required to download an Actions artifact.

Rendered samples, metadata readback, installer identity and screenshots:

https://github.com/anikajannatmim891-sketch/JPG-Renderer/actions/runs/41967594571/artifacts/13388562129

## Executed Windows verification

All six core tests, eleven metadata tests, thirteen renderer acceptance groups and six metadata export acceptance groups passed. The NSIS-installed application then passed its actual UI smoke suite from an independent working directory, using Unicode/space-containing source and destination paths.

Installed-application exports verified exact native dimensions and independently reopened their embedded metadata:

| Export | Dimensions | Metadata |
| --- | --- | --- |
| JPEG with manual title edit | 3840 × 2160 | Verified XMP/IPTC, five stars, ordered keywords |
| Transparent PNG imported by real file drag/drop | 3840 × 2160 | Verified XMP, actual alpha |
| JPEG | 7680 × 4320 | Verified XMP/IPTC, five stars, ordered keywords |
| JPEG using the explicit tile contract | 10240 × 5760 | Verified XMP/IPTC, five stars, ordered keywords |
| JPEG using the explicit tile contract | 12288 × 6912 | Verified XMP/IPTC, five stars, ordered keywords |
| Transparent PNG | 7680 × 4320 | Verified XMP and actual alpha |

Also passed: local fonts/images, bundled React TSX, bundled Three.js, native editable SVG, preview/zoom, GPU report saving, active cancellation, recovery after broken assets, application relaunch and persistent queue restoration. The test asserted that Chromium, ExifTool and esbuild came from installed resources, not the original checkout. No development server was used.

The independent source-renderer acceptance report still labels its own test K as unrun because that script does not launch the installed app. Installed verification is a separate, completed workflow step; `ui-metadata/smoke.json` and workflow logs are its evidence.

## Packaging repairs made during the Windows run

1. Canonicalized ExifTool's JSON SourceFile and target path consistently on Windows; disabled libvips file-handle caching so external metadata writes can replace images.
2. Disabled electron-builder's automatic GitHub Release publishing (`--publish never`); delivery uses Actions artifacts and needs no Release token.
3. Corrected smoke-test dropdown selectors. The existing artifact was reused for that diagnostic rerun; no failed diagnostic installer is linked as the final deliverable.
4. Canonicalized the installed dependency trust root and used path-component containment so Windows short/long path spellings do not reject bundled React/Three.js. Project isolation remains enforced.

No rendering mathematics or feature set was rebuilt.

## Limits

The CI GPU backend was explicitly accepted ANGLE/SwiftShader software Vulkan. RTX 4060 hardware acceleration and a physical Windows 10/11 machine were not tested. The installer is unsigned. Inkscape was unavailable; EPS was not exercised. Native AI/Blender/Python adapters and vector metadata embedding remain unavailable. Existing deterministic-readiness and explicit-tile compatibility requirements still apply; arbitrary screen-space effects are not automatically tile-compatible. Automated technical/metadata validation is not an Adobe Stock approval guarantee.

## Use

Install → open/drop HTML → inspect or edit the Metadata panel → select matching resolution/design width and output format → choose destination → export → inspect metadata/readback status and reveal the resulting file. Use explicit tiles only for sources implementing the documented contract. Core installed rendering needs no separate Node, Python, Chromium, Perl or ExifTool installation.
