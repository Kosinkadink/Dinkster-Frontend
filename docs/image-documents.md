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

## Durable documents

Graph opening and snapshot/recipe export are parked in
[the rework queue](rework-queue.md). Local drafts, library documents, shared
sessions, rendering and PNG download remain available in the workspace.

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

Pending mask edits and undo history survive layout refreshes while the same
tab and image target remain active.
**Bake to asset** explicitly replaces the input
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
id is not reused after undo. The history reports every raster digest that its
undo or redo stack can restore; local resource cleanup must retain those bytes
until the corresponding history entry is evicted or cleared.

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
session operation envelopes.
The inspected controls are captured for [crop](https://raw.githubusercontent.com/Kosinkadink/dinkster-evidence/main/frontend/issue-486/crop.png),
[resize](https://raw.githubusercontent.com/Kosinkadink/dinkster-evidence/main/frontend/issue-486/resize.png), and
[output policy](https://raw.githubusercontent.com/Kosinkadink/dinkster-evidence/main/frontend/issue-486/output-policy.png).
`packages/core/test/image-document-shared-session.test.ts` covers concurrent
rebase, actor-scoped allocation, and document-kind isolation. The image
workspace component test covers resource upload ordering, membership recovery,
shared command submission, local fallback on leave, render-without-publish, and
stale authoritative output. `packages/e2e/tests/image-document-workspace.spec.ts`
covers the visible render result and canonical PNG download.
`packages/e2e/tests/image-bake-live.spec.ts` checks Bake to asset through real
asset routes with a registered typed image-input fixture. It verifies the
decoded PNG RGB and alpha and the undoable input replacement. Graph-native
mask recipes are parked in [the rework queue](rework-queue.md#mask-paint-applied-to-the-graph).
