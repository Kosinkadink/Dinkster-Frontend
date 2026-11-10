# Image documents

Status: the durable format, local recovery store, server-library persistence,
and first-class image workspace are implemented.

## Image workspace

Use **Image documents** in the top bar to switch the center region from workflow
tabs to durable images. **New from image** creates a document from PNG, JPEG, or
WebP. The workspace restores every valid draft in the current project and keeps
workflow tabs unchanged when you switch back.

Local image imports stay with their original project and workspace. A decode
that settles after project change or disposal cannot start another resource or
draft write or publish a tab/error. Disposal waits for pending imports before
closing the store; concurrent imports remain busy until they all settle.
Already submitted transactions may finish, without rollback.

Queued draft saves keep their original project, workspace, and document session.
Stale work cannot submit another local write or publish saved status or errors;
the store rechecks before its put. Explicit Save draft remains busy and holds
store close through settlement. Already submitted writes may finish without
rollback. Backend selection does not invalidate local-only saves.

Library publication keeps its original project, workspace, document session,
backend, and connection. Stale work cannot start another upload, adoption,
record mutation, or local link write, or publish status/errors. Pending
publication holds busy state and store close until settlement. Submitted writes
may finish without rollback; edits during a current publication remain queued
behind its confirmed link.

Authoritative renders keep their original workspace, project, session, backend,
and connection. Stale adoption/render/fetch continuations cannot publish output
or errors. Pending renders hold busy state and store close through actual
settlement, including retained-read cleanup. Submitted work may finish without
rollback; edits still mark a completed render stale when its source differs.

Snapshot export captures its source session and destination workflow, graph,
backend, and connection before waiting for persistence. Stale continuations
cannot start adoption, commit retained graph edits, or publish status/errors.
Pending exports hold busy state and store close through settlement. Already
submitted work may finish without rollback.

Editable recipe export also retains its original workspace, project, source
session, origin, and destination workflow/store/backend/connection. Stale
preflight or retained-admission continuations cannot commit graph edits or
publish status/errors. Pending recipes hold busy state and store close through
settlement; submitted work may finish without rollback.

Startup recovery stays with its original project and workspace. Saved shared
membership is rejoined only while its captured backend and connection remain
current. Stale lookups do not clear membership, and stale snapshot/resource
reads cannot start another local write or publish a shared tab/error. Disposal
keeps the store open until recovery and rejoin settle; writes already
submitted may finish without rollback. Membership changes recheck their captured
context after opening the database and reading the draft, before submitting the
write. A stale read aborts that transaction without changing membership.

Shared image lists stay with the workspace, project, backend connection, and
request that opened them. Closing the dialog invalidates a pending refresh;
stale results and errors do not reopen it. A list from an obsolete owner cannot
start a join. Pending list requests keep the workspace busy and settle before
disposal closes its store.

An explicit join keeps the list request's original owner through snapshot,
resource hydration, and local membership updates. Closing that dialog or changing
its project/backend connection invalidates the pending join; stale continuations
cannot publish membership, shared tabs, or errors. Disposal waits for the join
to settle and close its rejected session before closing the local store.
Already submitted local writes may finish without rollback.

Sharing captures the local document session, revision, project, and backend
connection before waiting for persistence. A stale resource read cannot start
an upload; later stale upload/create/snapshot results cannot begin adoption or
publish membership, tabs, or errors. Busy state and disposal wait for the share
to settle, including ending a newly created session rejected by its owner.
Already submitted uploads and local writes may finish without rollback.

Leaving a shared image, including fallback after the remote session ends,
keeps its original document, project, backend, and connection. Pending leaves
keep the workspace busy and its store open through actual settlement. Stale
reads cannot start another draft or membership write, or publish a local tab
or error. Draft and membership transactions recheck before submitting writes;
already submitted writes may finish without rollback.

Ending a shared session captures the document, membership, project, backend,
and connection before sending the request. A stale reply cannot start local
leave or publish an error. Busy state and disposal wait for the end request and
its local fallback to settle, even if a remote-ended notification replaces the
tab first. Already submitted server requests may finish without rollback.

Closing the library dialog (including Escape), changing its backend connection,
or leaving its project invalidates a pending library open. A settled stale read
does not open a tab or start another resource/draft write. An already submitted
local transaction is allowed to settle. Disposing the workspace keeps its store
open until the pending library read and its retention cleanup have settled.

Library listings capture their backend object and connection before requesting
records. A stale reply cannot open the list or publish an error. Pending lists
remain busy and keep the local store open until the request settles.

The workspace uses shared Product buttons and text fields, including primary
publish/render actions and danger actions for removal and ending a shared
session. Hidden Product file inputs retain native image selection for documents,
layers and masks. Toolbar actions wrap and layer actions reflow in narrow panes.

The left pane owns the raster layer tree and stacking order. The right pane
edits names, visibility, fixed-point affine transforms, opacity, blend mode,
and raster masks. Mask controls include enable, invert, opacity, combine mode,
and alpha or luminance sampling. All changes use typed ImageDocument commands;
Undo, Redo, Ctrl+Z, Ctrl+Shift+Z, and Ctrl+Y use command history.

**Group with below** groups the selected layer with its adjacent lower sibling;
**Wrap in group** wraps the bottom sibling on its own. Grouping preserves child
order and uses the same undo history. **Clip to previous** changes clipping,
and the canvas width and height fields change the document bounds without
resampling its raster resources. **Crop** translates the retained root
composition into a smaller canvas. **Resize** scales the root composition and
canvas with deterministic fixed-point rounding. Masks retain their owning layer
geometry. Neither operation changes source raster bytes, digests, source
rectangles, or library links. Invalid dimensions are refused without changing history.
Canvas dimensions and z order refuse blank, malformed and unsafe integer text
with an alert, without saving a draft or adding history. Correct the text or
press Escape to restore the canonical value and clear the refusal.
The layer list and structural edits use effective z order, with serialized order
breaking ties. Reordering or grouping normalizes explicit z indexes in affected
sibling lists; undo restores the original indexes and structure.

The center canvas is an interactive browser preview, not a numerical authority.
Linear color, extended blends, clipping, explicit z order, pass-through groups,
background color and opaque/premultiplied alpha interpretation require the CPU render. The browser
clears its stale preview and shows a diagnostic rather than approximating them.
**Linear color**, **Z order** and **Pass-through group** edit document properties
through the same command history. All 27 declared blend modes are retained.

## Graph documents

The Outputs panel offers **Open layers** for `dinkster.layers` values, not
the `LAYERS` or `comfy.LAYERS` tensor mappings. Opening uses the selected
execution, runtime node and output identity on the value's owning connection
and explicitly requests the `document`
rendition. The response must identify the selected type and fingerprint, report
the `document` rendition, and use
`application/vnd.dinkster.image-document+json`. The client adopts the exact
canonical response bytes in the selected scope before creating a recoverable
draft. It does not rebuild the adoption body from parsed JSON. The initial
workspace image comes from the backend composite Render API and its verified
PNG asset. A flattened value rendition is never substituted for the editable
document or for a failed adoption or render. Missing capabilities, dependency
grants, unsupported format versions, changed values, failed renders, and
conflicting local edits produce visible errors.

The admitted value reader covers canonical decode, adoption, reference rendering,
resource hydration and draft creation, not only the rendition response body.
Closing that reader waits for actual consumer settlement and refuses its return.
The workspace also checks its captured graph request, backend connection and
project before continuing reads, hydration, draft writes or tab/error publication.
A replacement request does not let an older open publish or clear its busy state.
Workspace disposal waits for all pending graph opens before closing the store.
Already submitted local transactions may settle; they are not rolled back.

**Export snapshot to graph** explicitly adopts the current document and its
resources on the destination backend, then adds `dinkster.layers.load` wired to
`dinkster.layers.flatten`. These nodes hold a document AssetRef and composite selector, not pixels,
browser URLs or producer paths. Export is one undoable workflow command and
refuses a changed destination graph, tab or backend. It neither changes the
original graph source nor publishes a library record.
Snapshot and recipe export require `dinkster.layers` at every layer port;
tensor `LAYERS` and `comfy.LAYERS` ports are not compatible document targets.

Documents opened from an executed native layer output also offer **Export
editable recipe**. It branches `dinkster.layers.edit` -> `dinkster.layers.flatten` ->
`dinkster.save_image` from the original `dinkster.layers` output without replacing or
rewiring that source. The edit node receives canonical document commands;
format and quality are explicit save-node values. PNG, JPEG, and WebP are
supported, quality is 0-100, and PNG remains lossless. Output policy is
non-rendering document metadata, so it does not change browser preview or the
authoritative canonical PNG Render API result.

Recipe export is one undoable workflow command. It requires the exact source
workflow, graph, node output, backend, and graph fingerprint captured by the
execution. It refuses stale provenance and edits that cannot be represented by
the advertised layer-edit node, including added or removed raster resources,
rather than substituting a flattened snapshot. Snapshot export remains a
separate explicit action.

Native graph opening requires the owner-side document rendition; preview-only owners are refused.
The durable schema is version 2. Loading canonical v1 changes only its version;
local recovery and library open verify the original canonical bytes before
migration and retain the original library digest until explicit Save. Canvas
FFmpeg color integers, RGBA16 background, group isolation, z order and affine
components are retained. Inline resources are limited to 4096 bytes and verified
against their BLAKE3 digest. They travel inside the document and are excluded
from external dependency manifests and uploads; external resources still require
scoped access, including resource records not currently referenced by a layer
or mask. Document retrieval alone grants no access to external raster bytes.

External raster hydration first journals a fresh scoped read owner in IndexedDB
and obtains an exact retained-asset acknowledgment before fetching bytes. The
owner protects missing external resources through digest verification and local
durable staging; inline and already-staged resources need no server read owner.
Before verified external bytes enter durable staging, a separate document owner
is journaled and acknowledged for that exact digest and scope. Uploading a staged
raster likewise confirms its independent staged owner before returning it to
the caller. A refused or mismatched acknowledgment blocks staging/publication;
a lost response requires an exact owner/revision readback, not a repeated write.
Hydration also admits a fresh staged owner for already-cached external bytes,
including legacy entries without receipts, before library opening returns or
saves its local link. Cached bytes are not evidence of backend ownership or
scope authority. Refused admission leaves those bytes and earlier owners intact;
inline resources need no external owner. Repeated descriptors of the same
external digest share one fresh owner within that hydration.
Staged owners and unresolved intents survive store closure and restart. Read
completion releases only the read owner, never the staged owner. Staged ownership
is conservative: replacing an image, closing its editor or disconnecting does
not release its durable raster protection.
Release happens only after those reads settle. Lost registration or release
responses reconcile by the exact owner and revision without replaying writes.
Unconfirmed owners remain journaled across restart; closing an editor or local
store does not release them. This read lifetime does not certify workflow,
execution-result, editor-history or durable document retention completeness.

Library source-document JSON uses the same scoped journal and acknowledgment
before fetching its complete text body. That read ends only when the text
settles; validation and resource hydration then consume the self-contained local
text. Refused or unconfirmed admission cannot fall back to an unprotected read.

Authoritative rendered PNG reads use the same scoped journal and acknowledgment
before fetching and verifying the declared output identity. Display and download
use the verified local Blob, not a second unprotected server read. The keyed
render view revokes its object URL on replacement or disposal; locale changes
keep the existing URL. The server read owner is released only after the verified
Blob exists, and unresolved release responses remain journaled.

Transform components are a closed record of x/y, width/height, rotation in
radians, boolean flipHorizontal/flipVertical, and sourceWidth/sourceHeight.
Dimensions may be fractional and must be positive and at most 16384; source
dimensions need not equal raster dimensions. Rotation and flips use the center
of the destination box, whose unrotated top-left is x/y. The backend generates
fixed-point coefficients in its declared operation order with ties-to-even
rounding. JavaScript and Python trigonometry can differ at rounding thresholds,
so the loader preserves stored affine coefficients rather than recomputing them.
It checks component shape and bounds; exact component-to-affine agreement is
validated by the backend on adoption. Editing affine fields drops components
instead of preserving metadata that no longer agrees with the transform.

For native `dinkster.load_image` mask outputs already consumed by the graph, the
image mask editor offers **Apply mask to graph**. It inserts or updates one
source-bound `dinkster.mask.paint` node, stores the serialized brush operations,
and rewires only that loader's current mask consumers. The original image
AssetRef remains unchanged, so the edit is visible and repeatable in execution.
Pending mask edits and undo history survive layout refreshes while the same
tab and image target remain active.
The live acceptance executes paint, layer, and flatten nodes and checks every
decoded transparency-mask sample against the identically edited explicit bake.
For other eligible inputs, **Bake to asset** explicitly replaces the input
asset; **Cancel** leaves the workflow unchanged. Typed PNG inputs use the same
editor and command guard for `asset<IMAGE>`. Canonical `LoadImage` inputs also
qualify through their declared `ASSET` carrier and `media/image` widget kind;
unclassified assets and other media kinds do not qualify.
Hidden and driven inputs are not writable.

## Authoritative render

**Render** sends the current edits to the backend CPU reference renderer without
publishing or updating a library record. The render target can be the full
composite, one layer, or one mask. The result panel displays and downloads the
canonical PNG together with its dimensions, byte size, selector, fixed render
profile, renderer contract, source digest, output digest, and cache key. It
labels reused output as a cache hit and marks a result stale after another edit.

Adoption and rendering require an ImageDocument v2 backend and the
`dinkster-image-document-v2-cpu-reference` profile. A v1-only backend cannot render
the migrated workspace document; its refusal remains visible. A response with
the v1 profile is not accepted as v2 provenance.

The browser canvas remains an interactive approximation. The backend result is
the bit-exact authority for transforms, opacity, supported blend modes, clipping,
groups, and raster masks. Rendering first uploads verified staged resources and
adopts the canonical document in server CAS; it does not create a library entry.

## Local recovery

ImageDocument drafts and referenced raster bytes are stored in project-scoped
IndexedDB records. Drafts use canonical format bytes and stable lineage ids.
Malformed records are ignored and can be repaired by opening a valid server
copy. Local imports normalize one PNG, JPEG, or WebP raster into a canonical
single-layer document before staging it.

Every command queues a recovery write. **Save draft** waits for that queue and
confirms the latest local snapshot; Ctrl+S performs the same action. Draft
writes detect concurrent replacement. A library save that overlaps a newer
local edit attaches the confirmed server link without replacing the newer
document or name.

## Library save and open

Publish is explicit. It uploads missing raster dependencies, asks the backend
to adopt the canonical ImageDocument, then creates its library record. The
button becomes **Update library** after the first successful publication.
The client verifies returned digests, media types, byte sizes, ownership, and
the immutable dependency manifest. A lost update acknowledgement is recorded
and reconciled on the next save instead of creating a duplicate record.

**Open library** is explicit. It verifies the library record, canonical document digest,
dependency manifest, and every downloaded raster before writing local state.
Opening refuses to replace unsaved changes or attach a lineage to a different
library record.

## Layered file interchange

The workspace does not offer ORA or PSD file interchange. Native/ORA export belongs
at the backend layer-save boundary; PNG downloads are flattened renditions, not
layered files. The upstream [Comfy layer editor import](https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/src/renderer/extensions/layerEditor/composables/useLayerEditorSession.ts)
and [PSD exporter](https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/src/renderer/extensions/layerEditor/psdExport.ts)
were evaluated but not reused: they use a separate canvas scene model and GPU
readback instead of canonical digest-owned resources and CPU-authoritative pixels.
Silently substituting unsupported blend modes would also lose document semantics.

## Commands and history

ImageDocument changes use a separate typed command session rather than the
workflow document store. Commands atomically update raster layers, their tree
order, transforms, opacity, blend mode, and raster masks. Every result passes
the same loader and invariant checks as an imported document.

Undo and redo replay immutable patches. Allocation cursors never rewind, so an
id is not reused after undo. The history reports every external raster digest
that its undo or redo stack can restore; inline bytes travel inside the document.
Local resource cleanup must retain external bytes until the corresponding
history entry is evicted or cleared.

The local core session exposes `prepareDispatch`, `prepareUndo`, and
`prepareRedo` for callers that must await ownership before publication. Preparing
does not change the document, revision, history, signal, or operation stream. A
candidate carries the current external-resource inventory and the proposed
document/history inventory, including unused resources. Its one-use `commit`
refuses an intervening document or history change. An optional synchronous
`validateCommit` policy guards initial construction and every command/history
commit, including direct synchronous calls. A refused policy leaves the existing
document and history unchanged. These core APIs do not themselves perform
backend admission.

The shared core also exposes one-use prepared command, undo, and redo
candidates. Their external inventory includes the confirmed ground, unused
resources, pending edits, and retained history. Its optional `validateCommit`
policy guards initial construction and local commits. Ordered remote ingest,
starting catch-up or resync, disconnect, close, history clearing, and intervening local commits
invalidate previously prepared candidates. A refused or stale history replay
leaves its history record intact; synchronous undo/redo still reports replay
conflicts. This policy does not guard remote
publication or perform backend admission; the workspace does not yet use it
for shared ownership. Shared retained digests remain conservative.

The workspace waits for backend admission before exposing a recovered or
imported local session. External rasters are verified against staged bytes and
uploaded before a fresh document owner is journaled and acknowledged. Local
commands, undo, and redo prepare their complete proposed document/history
inventory and await an exact acknowledgment before commit. A lost response is
reconciled by reading that owner, without replaying its write. Refusal, reuse,
disconnection, or a changed project/backend/session prevents publication.
Unavailable backends leave recovered drafts blocked, not visible without
ownership. Closing the workspace waits for pending admissions but does not
release their durable owners. These session owners remain held conservatively;
this does not establish shared-session or renderer-cache lifetime ownership.

## Shared editing

**Share** creates a live ImageDocument session after all current raster
resources have reached the backend. **Shared images** lists image sessions
without mixing them into workflow collaboration. Join replaces a local draft
of the same lineage with the shared document, while Leave keeps the current
image as a local draft. **End** requires confirmation and disconnects every
participant.

Shared commands use actor-scoped layer, mask, and resource ids so concurrent
imports do not collide. Concurrent edits rebase in server order and every
result passes the ImageDocument loader. Newly referenced raster bytes upload
before their command is sent; collaborators download verified missing bytes
from backend CAS. Session membership is stored with the IndexedDB draft and
rejoined after reload. A missing or ended session falls back to the latest
local draft.

The workspace shell and inner editor follow the active host locale without
reopening documents, resetting layer or render selection, or repeating preview
and backend requests. This includes toolbar, layer, preview, reference-render,
canvas, crop, resize, output, transform, mask, and property chrome, plus the
library and shared-session dialogs. Document and layer names, identifiers,
formats, blend and mask values, provenance, digests, and backend error details
remain source data.

## Proof

`packages/app/test/image-document-persistence.test.ts` covers project
isolation, import normalization, corrupt-record repair, resource staging,
save/open round trips, ownership loss, revision conflicts, uncertain
acknowledgements, and overlapping local edits. Client wire projection is
covered by `packages/client/test/dinkster-connection.test.ts`, including exact
render request and provenance validation.
`packages/core/test/image-document-commands.test.ts` covers atomic command
validation, crop and resize geometry, output policy, layer and mask edits,
deterministic allocation, resource-aware history, hostile ids, and local
session operation envelopes. `packages/app/test/image-document-recipe.test.ts`
proves crop, resize, and output-policy parity between workspace state and graph
recipe execution.
The inspected controls are captured for [crop](https://raw.githubusercontent.com/Kosinkadink/dinkster-evidence/main/frontend/issue-486/crop.png),
[resize](https://raw.githubusercontent.com/Kosinkadink/dinkster-evidence/main/frontend/issue-486/resize.png), and
[output policy](https://raw.githubusercontent.com/Kosinkadink/dinkster-evidence/main/frontend/issue-486/output-policy.png).
`packages/core/test/image-document-shared-session.test.ts` covers concurrent
rebase, actor-scoped allocation, and document-kind isolation. The image
workspace component test covers resource upload ordering, membership recovery,
shared command submission, local fallback on leave, render-without-publish, and
stale authoritative output. `packages/e2e/tests/image-document-workspace.spec.ts`
covers the visible render result and canonical PNG download.
`packages/e2e/tests/image-document-graph.spec.ts` uses route-mocked value,
adoption, render and asset endpoints to cover graph opening, crop, resize,
format/quality editing, guarded editable-recipe export, explicit snapshot
export, grouping, clipping refusal, and draft recovery after reload.
`packages/e2e/tests/image-document-graph-live.spec.ts` separately runs
a transparent `dinkster.load_image` -> `dinkster.layers.add` ->
`dinkster.layers.flatten` graph against a live Dinkster backend. It proves the
workspace's Render API PNG is byte-identical to the flatten image rendition and
that its decoded alpha matches the flatten transparency mask.
`packages/e2e/tests/image-mask-graph-live.spec.ts` applies the same real brush
stroke through graph-visible `dinkster.mask.paint` and explicit bake paths, then
proves executed-node receipts, source AssetRef preservation, PNG alpha parity,
transparency polarity, and authoritative document-render byte equality.
The acceptance captures the [graph mask editor](https://raw.githubusercontent.com/Kosinkadink/dinkster-evidence/main/frontend/issue-400/graph-mask-editor.png),
a [painted-mask detail](https://raw.githubusercontent.com/Kosinkadink/dinkster-evidence/main/frontend/issue-400/graph-mask-detail.png), and the
[authoritative document](https://raw.githubusercontent.com/Kosinkadink/dinkster-evidence/main/frontend/issue-400/graph-mask-authoritative-document.png).
Graph-opening unit tests cover exact value identity and bytes, missing headers
and capabilities, stale fingerprints, adoption/render refusals, resource
validation and protection of existing local edits. The route-mocked
authoritative display is captured in
[graph-layer-open-authoritative.png](https://raw.githubusercontent.com/Kosinkadink/dinkster-evidence/main/frontend/issue-402/graph-layer-open-authoritative.png).
