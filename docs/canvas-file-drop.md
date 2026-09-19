# Safe canvas file drop

The graph canvas accepts one local file at a time. Classification uses bounded
file bytes. Names and extensions select the bounded latent parser but are never
trusted as file authority. Browser MIME claims, URLs, and local paths remain
untrusted. The data-only handlers are:

- UTF-8 JSON, opened through the existing workflow-file import pipeline.
- PNG, JPEG, and WebP signatures.
- An uncompressed `workflow` tEXt or iTXt entry in a PNG, subject to chunk,
  count, UTF-8, and JSON limits.
- `.latent` and `.safetensors` safetensors headers, subject to unsigned 64-bit
  length, 8-byte framing alignment, 4 MiB header, strict UTF-8, duplicate-key,
  tensor extent, profile, and retained metadata limits. Tensor bodies are never
  read into JavaScript state.

Other bytes and multiple-file drags report a named problem without changing the
document. HTML, SVG, scripts, executables, archives, URLs, and path strings have
no drop handler. Internal canvas gestures and non-file drags remain canvas-owned.
Drops are also refused before file reading while an app modal or a
dismiss-blocked widget upload is active, so file ingress cannot rebuild the
canvas behind another modal operation.

The canvas presents a host-owned drop target while a file is dragged over an
editable workflow. It switches to explicit inspecting and uploading states
after drop, with an enabled Cancel action for the owned request. Success and
refusal remain visible on the canvas instead of depending on the Problems
panel; named diagnostics are still reported there. Success and refusal remain
until explicit dismissal so facts do not disappear while focused or being
read. The surface is a live status/alert, contains long facts at narrow widths
and 200% zoom, and removes motion under the reduced-motion preference. Owner
loss clears the surface and aborts the request without claiming either success
or failure.

## Images

A plain image is uploaded through the active tab's same-origin `uploadAsset`
connection. The response must be a lowercase BLAKE3 digest. The canvas then
scans that tab's current catalog for a node with one visible ASSET input that
accepts the image MIME type. An exact MIME match wins over wildcard matches;
ties retain catalog order. The canvas dispatches one atomic batch containing
that node with a complete five-field AssetRef. The stored name is a generated
media label such as `dropped-image.png`; the local filename and path are never
persisted. Undo removes the node; the immutable uploaded object may remain in
the library.

Upload failure, malformed responses, no compatible catalog schema, frozen tabs,
closed or retargeted tabs, and retired or navigated graphs insert nothing. The
tab object, backend, graph id, graph incarnation, and world coordinates are all
captured before asynchronous classification and upload.

The frontend passes the original File object to `uploadAsset` and does not
write the graph until that upload succeeds. Framework-free tests pin the exact
object, bytes, metadata, and write ordering. A native browser proof is authored
in `packages/e2e/tests/image-upload-byte-proof.spec.ts`: its canvas-drop arm
uses a deterministic valid PNG larger than 256 KiB and compares the POST body,
returned digest, vault GET bytes/hash/length, AssetRef, and export/reopen value;
its explicit Load Image arm also proves execution. The prior live proof and exact hashes are
recorded in `docs/promises.md`.

Historical backend defect observed 2026-08-07: live job
`019fd935047563a88365345d68d1cd8a` failed at `dinkster.load_image` n16. Source
document blob `blake3:5932696ceb7c52ed03f0566144103a929047ec68669bebac04aa5efc1f8f3a9a`
records digest `blake3:b584866aabc7b7bb0c4c1016b809254d71261e15db24b392a3cb15bb62398b07`
at 300047 bytes, but the backend vault file held only 78840 bytes. The backend
handler performed one `request.content.read(limit+1)`, which does not guarantee
EOF. Backend commit `6a5a1c23a25d7b24b8c01c49eec021d513eb4910`
fixed the handler by draining chunks to EOF; verified-read commit
`0313abfefc96ac037591d25879bd11d2eb831a01` protects GET and execution.
Frontend retry, chunking, readback, digest, and decode workarounds remain
explicitly out of scope.

## Pasting images

Ctrl+V, Ctrl+Shift+V, and the empty-canvas context-menu Paste first read the OS
clipboard for an image (png preferred, then jpeg, then webp). A found image
rides the same classification, upload, and atomic insertion pipeline as a
dropped file; only the surface wording says pasting instead of dropping. The
stored asset name is a generated label such as `pasted-image.png`. The anchor
is the current pointer position in world coordinates for keyboard paste, the
menu invocation position for context-menu paste, and the viewport center when
neither applies.

An image on the clipboard takes precedence over clipboard text because the
internal graph copy writes only a text envelope; an image item always came from
outside the app. Without an image, paste falls through to the graph clipboard
described in `clipboard.md`. The same guards apply as for drops: refusal while
busy or while a modal is active, and no document mutation on upload failure.

## Embedded PNG workflows

An embedded workflow never opens or executes automatically. A native modal
dialog offers exactly `Load image`, `Open embedded workflow`, and `Cancel`.
The first image/workflow action synchronously consumes the choice and clears the
modal; double-clicks and cross-choice races cannot start a second action.
Native modal behavior supplies focus containment, Escape cancellation,
background inertness, keyboard operation, and opener-focus restoration. Cancel
is a no-op. Opening the workflow reuses `AppState.importWorkflowFile` and
`openDocument`; loading the image uses the same upload and atomic insertion path
as a plain image.

## Latents

A valid embedded latent workflow goes through the same schema-aware workflow
import, validation, and missing-node diagnostics as JSON and PNG workflows. A
missing or invalid workflow instead uploads the original File through
`POST /api/assets/latent` and inserts the first catalog node whose single visible
ASSET input accepts `application/x-comfy-latent`, preferring an exact match over
wildcards. The inserted input receives the server-authored `AssetRef`; no local
path enters the document.

Admission matches the backend parser: native Dinkster v1 requires exact
single/multi schema-to-tensor correspondence, while schema-less ComfyUI files
require `latent_tensor` with an optional zero-byte F32 `[0]`
`latent_format_version_0` tensor at the end of its data. Metadata `format` does
not select the profile. Unknown or malformed native versions, indexed-only
`latent_tensor_0`/`latent_tensor_1` files, arbitrary model safetensors,
unsupported dtypes or shapes, non-integer descriptor tokens, malformed markers,
and extra tensors fail before workflow recovery or upload.

Bounded VAE source and latent-space hints appear only as escaped informational
facts in the successful drop surface. They never load models, open URLs,
install nodes, or queue execution. Controls, URLs, paths, and non-registered
latent-space IDs are not displayed. Graph deletion or same-tab navigation
aborts an in-flight upload immediately. Malformed and oversized files do not
upload or mutate the graph.

The classifier registry is intentionally small and data-only. Extending it means
adding another bounded byte classifier and an explicit host-owned handler, not
dispatching code from a dropped file or a plugin.
