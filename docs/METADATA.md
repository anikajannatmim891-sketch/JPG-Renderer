# Embedded source metadata

The renderer reads supplied metadata; it does not generate stock titles or keywords. The original artwork files are never edited. Metadata is enabled by default and is applied after final raster encoding, before validation and atomic publication.

## Source contract

Standard HTML works without executing the source for extraction:

```html
<title>Luxury geometric background</title>
<meta name="description" content="Elegant layered background with generous copy space.">
<meta name="keywords" content="luxury, copy space, geometric, layered paper, background">
<meta name="rating" content="5">
```

`dc.title`, `dc.description`, `dc.subject`, and `dcterms.*` counterparts are supported. Keywords in standard meta tags are comma-separated. Multiword phrases are preserved, and repeated subject meta tags append in document order.

Preferred structured form:

```html
<script type="application/json" id="uvrs-metadata">
{
  "title": "Luxury geometric background",
  "description": "Elegant layered background with generous copy space.",
  "keywords": ["luxury", "copy space", "geometric", "layered paper", "background"],
  "rating": 5
}
</script>
```

This JSON script is not rendered as visible artwork. Keep exactly one block; malformed JSON and ambiguous blocks are reported. When serializing arbitrary content into HTML, escape `<` as `\u003c` so a literal `</script>` cannot end the block prematurely. Sources are parsed as UTF-8 with parse5; no JavaScript runs merely to read static metadata.

Optional runtime metadata is supported as `window.__UVRS_METADATA__ = { title, description, keywords, rating }`. It is read inside the existing sandboxed Chromium only after normal artwork initialization/render readiness. It is not evaluated during initial static import. Render a preview first if runtime values are needed in the panel. Custom asynchronous metadata must be ready under the existing author readiness contract.

Precedence applies independently to each field: explicit user edit → JSON block → runtime object → HTML meta → document title (title only). Missing fields remain missing; no visible text scraping, inference or generated keywords occurs. Rating defaults to 5 when absent. The preference checkbox changes the absent-field default to 0 when disabled; an explicitly supplied or edited 0–5 value takes precedence.

## Editing and validation

The compact Metadata section contains title, description, comma-separated keywords, count, rating, source, validation and embedding status. Native copy/paste works. The first ten keywords are highlighted; order is never alphabetized. Outer keyword whitespace is trimmed; duplicates and empty entries are reported rather than silently removed. The comma-separated editor treats commas as separators; use multiword phrases without commas.

Title, description and keywords are required for a metadata-complete export. Rating must be an integer 0–5. The default keyword limit is 49, configurable in the panel (1–1000 safety range). Exceeding it blocks metadata-complete publication until corrected. A title longer than 70 Unicode codepoints produces a warning without truncation. Duplicate keywords and obvious repeated words produce warnings; no semantic comparison to the artwork or Adobe approval is claimed. The user must review visual consistency.

Manual changes are job-specific and do not modify HTML. Exporting another resolution preserves current edits. Source changes reset those edits. A complete set of manually supplied title/description/keywords can override malformed source JSON while retaining a source-error warning.

Disabling automatic embedding requires explicit confirmation for a final export. Such a file is marked `omitted-by-approval` and `complete: false`. Internal previews may omit metadata and are marked `preview-only`; they are not labelled metadata-complete. Missing metadata with embedding enabled fails at the metadata stage, preserving the encoded render for retry.

## Actual embedded tags

ExifTool 13.60 (pinned `exiftool-vendored` platform distributions) writes and independently reopens the actual file. Windows packaging copies `exiftool.exe` **and the complete exiftool_files support directory**, supplied license files and documented vendored patches. No end-user PATH, Perl or ExifTool installation is required on Windows. Linux development uses the pinned Perl distribution and system Perl.

All verified raster formats write:

- `XMP-dc:Title` and `XMP-dc:Description` as standard default-language text.
- `XMP-dc:Subject` as individual ordered keyword values.
- `XMP-xmp:Rating` as an integer, five by default. This is an image rating, not an Adobe Stock public/customer/moderation score.

JPEG additionally writes UTF-8 IPTC with `IPTC:CodedCharacterSet`:

- `Caption-Abstract` when description is ≤2000 UTF-8 bytes.
- Individual `Keywords` when every keyword is ≤64 UTF-8 bytes.
- `ObjectName` when title is ≤64 UTF-8 bytes.
- `Headline` when title is ≤256 UTF-8 bytes.

If legacy byte limits conflict with the supplied text, that legacy field/list is omitted with a warning and full XMP remains intact. No truncation is used. PNG XMP is embedded in its standard Adobe XMP iTXt representation; real alpha is preserved. WebP XMP is embedded in the file and read back. SVG metadata editing, EPS metadata and native AI metadata are not implemented; existing vector geometry export is retained and is not advertised as metadata-complete.

Process order: encode → copy encoded image to a unique working file → ExifTool embed → new ExifTool process reopens it → exact title/description/rating/keyword count/content/order comparison → decoded pixel hash comparison → raster decode/profile/dimensions/alpha/final-size checks → atomic no-overwrite link to final filename. ExifTool is launched using a Node argument array and a UTF-8 argument file, with JSON values in a temporary import file. There is no shell interpolation. This avoids Windows argument-length/ANSI conversion issues and preserves spaces, quotes, newlines in descriptions and Unicode. CR/LF/NUL in filesystem arguments are rejected. Writer exit status alone is never accepted as metadata verification.

## Failure and retry

On embedding/readback failure, the job fails and keeps **one unmodified encoded render** at a unique recovery path recorded in the persistent queue. No metadata-free final output is published as successful. Fix the Metadata panel, reopen the original source if necessary, and use **Retry metadata**. The retry only copies, embeds, reads back, validates and publishes the retained image; it does not launch Chromium or rerender. Successful retry deletes the retained render. Cancelled jobs remove temporary output instead. Temporary argument/import/working files are cleaned up; ExifTool backup files are disabled.

The output JSON manifest records intended/readback metadata, standard tags, warnings, actual size and validation. It is evidence and convenience; the metadata itself is inside the image. Adobe's portal may expose only some embedded fields. Automated checks do not guarantee acceptance, ranking, sales or metadata visibility in every third-party image viewer.

## Evidence

- `npm test`: static/DC/JSON/runtime precedence, manual overrides, ordered phrases, duplicate/empty/invalid/missing data, rating defaults/range, Unicode, legacy byte limits, real JPEG/IPTC/XMP, PNG/iTXt/XMP, WebP, independent readback and unchanged pixels.
- `npm run test:metadata`: real 8K JPEG, 8K transparent PNG, 12K tiled JPEG, runtime/manual WebP, metadata-only retry with an unusable browser path, and explicitly approved omission.
- `npm run test:ui`: automatic import, manual edits, actual local-file drag/drop, JPEG/PNG metadata, external Unicode/space paths, diagnostics, recovery and relaunch.
- Windows workflow: packages and installs NSIS, then uses the installed application's bundled Chromium/ExifTool/esbuild paths from an independent working directory. High-resolution installed-application checks are included. Until a real Windows run completes, these remain unverified tests, not release evidence.
