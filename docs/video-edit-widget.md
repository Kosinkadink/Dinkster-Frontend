# Video trim and crop widget

`comfy.VIDEO_EDIT` inputs open a one-track, one-clip editor from the canvas or
an exposed App view parameter. Each schema declares a `VIDEO_EDIT` widget
descriptor whose presentation-only `features` list selects the visible trim
and crop sections. The frontend does not infer features from node type IDs.
An open App view editor remains
open while shared-workspace tab metadata synchronizes.

Linked literal value-source pills use the same editor and write only their
literal value, without changing a consumer's sibling inputs. Apply and undo
use the normal value-source command path.

The Trim section stores `start_time` and `duration` in seconds. A duration of
zero means through the end of the source. When source timing is available,
frame fields, the playhead, and trim handles are constrained to the clip.
Negative starts are relative to the source end. Frame positions use average
fps and are approximate for variable-frame-rate media. `strict_duration`
remains a separate sibling input; Apply commits both changes in one undo step.
Linked strict inputs are read-only, and crop-only nodes do not gain one.

The Crop section stores source-pixel `x`, `y`, `width`, and `height`. A width
or height less than or equal to zero means the full source frame. Crop
handles and 16:9, 4:3, 1:1, and full-frame presets clamp to the source and
chroma-even boundaries when source facts are available. Crop handles support
arrow keys (2 pixels, or 10 with Shift). Full odd-sized frames retain their
exact dimensions. Numeric fields store authored integers without clamping or
even-rounding; the overlay and backend normalize geometry, not stored JSON.
Untouched imported fields remain unchanged.
Numeric controls retain incomplete signs and decimal fractions while typing.
Blur or Enter updates only the local draft; Apply stores the edit. Explicitly
typing zero into an absent field stores that sentinel without filling other
missing fields. Malformed numeric text remains visible with a validation
message and blocks Apply until corrected; it never becomes a zero sentinel.

Empty and partial edit objects are valid. Applying an edit preserves
unknown top-level and section fields exactly so imported and newer documents
round-trip without data loss. An absent native VIDEO_EDIT displays existing
scalar settings without storing an override until they change. Linked scalar
settings refuse that override. Cancel and unchanged Apply do not write values.

The editor resolves one linked VIDEO producer in a completed native execution,
checking occurrence identity and current upstream provenance. It reads
display-oriented `effective.width/height` and rational `duration/fps` metadata,
not coded probe dimensions. Missing, stale, ambiguous, or refused sources are
visible. Crop handles need dimensions, not timing; trim handles require timing.

Opening the modal requests advertised `frame` (effective seconds) or `poster`,
and the provider's default `thumbs` count for Trim. Frame selection requires
advertised `parameters: ['frame']`; legacy providers use their default frame
with a visible selection-unavailable notice. Unknown timing uses actual frame
index zero when selection is supported. Average-fps controls request timestamps,
not VFR frame indices. Scrubbing debounces and cancels obsolete requests.
Bounded `preview` MP4 is fetched only on request. Color-transform headers are
shown; 400/404/406 and other refusals remain visible. Object URLs are released
on replacement or close. Original bytes are never used for an edited preview.

Draft controls overlay a bounded source frame, not a server-rendered draft.
The value API does not accept temporary VIDEO_EDIT inputs: Apply and run the
node to obtain its lazy edited result. Advertised bounded providers are needed
for frame/filmstrip/playback; original-only backends show unavailable notices.
No full-video decode, client path, hardware gate, or second timeline is used.

`video-edit.spec.ts` exports the applied workflow before undo, reopens its saved
JSON, imports the same file, and attaches exact workflow/value/feature/compiled
input records. Cases include empty/partial edits, sentinels, unknown fields,
measured pointer geometry, and deterministic numeric crop coordinates. SaveVideo
v3 coverage checks migration of `dynamic.format.selected` to static `format`
and the inserted assemble node's links. Backend schema fixtures carry source
provenance; routed schemas and the combined-editor test node are not evidence
of backend execution. Local JSON save/reopen is distinct from library storage.

The opt-in live case in `video-edit.spec.ts` runs the saved trim/crop graph on
the local Dinkster backend, edits both native nodes through the production modal,
and checks the resulting lazy VIDEO metadata. It also records every value and
rendition request and rejects path or file parameters, while the saved and
submitted edits remain plain JSON graph values. Current Dinkster VIDEO descriptors
advertise no renditions, so the live case also records the truthful bounded
frame refusal. Run it on an isolated frontend port with
`DINKSTER_VIDEO_EDIT_LIVE=1` and
`DINKSTER_NATIVE_BACKEND=http://127.0.0.1:8765`, and set
`DINKSTER_VIDEO_EDIT_BACKEND_COMMIT` to the backend's full commit hash for the
attached receipt.

The paired Dinkster contract in `tests/test_video_editor_contract.py` runs the
same serialized graph in process, across worker shared memory, and through a
remote-worker protocol daemon. It compares encoded VIDEO bytes exactly,
compares decoded frames exactly, proves shared-memory transport, and proves
that the remote worker fetches the source from its advertised asset host
without opening it on the submitting host. A second LAN host and cloud pool
remain separate environment-gated evidence lanes.

## Video document commands

Video documents also use the shared center tab strip. The film tab action
creates a project-scoped durable document with a canonical OTIO timeline.
The initial editor exposes the complete JSON, validates it through the same
`dinkster.video` adapter used by collaboration, and records Apply, Undo, and
Redo through the generic document session. Local documents recover after a
reload. Share and Shared video documents create or join video-kind sessions;
workflow and image sessions never appear in that list.

Every authored text input on `dinkster.video_document.*` opens a command-specific
video document editor. It covers document creation, clip and track insertion,
effects, transitions, retiming and freeze frames, audio mixing, split/move/trim,
ripple/roll edits, source binding, and OTIO import. Canvas size and frame rate
are creation parameters, and sampling is the retime scalar. The verified
contract has no separate cap, resize, or pad command; `set_effect` preserves
ordered effect payloads, but rendering may refuse effect node types the backend
does not support. `render` and `export_otio` have no authored text input and
retain their ordinary graph ports.

Structured fields write the exact JSON string consumed by the node. Imported
keys unknown to this frontend survive structured edits, while the Advanced JSON
section can edit the complete object. Malformed objects and nested JSON remain
unchanged and cannot be applied until repaired. Empty node defaults open as an
empty object. OTIO import text is stored verbatim. Source and document links
remain graph connections; the editor reports their status rather than copying
runtime values into the parameters.

Apply uses the normal undoable graph-value command, so compile, export, reopen,
import, and execution use the same value as a hand-authored node. The command
editor does not request timeline or media bytes. It adds no timeline endpoint
and cannot fetch an original or unbounded preview; executed media continues to
use only the existing advertised bounded rendition routes.

`VideoDocumentEditor.dom.test.tsx` covers command completeness, unknown-key
preservation, nested JSON validation, empty defaults, OTIO text, and typed VIDEO
binding status. `video-document-editor.spec.ts` covers every editor state in
Chromium, exact compiled values, save/reopen/import, undo/redo, no editor media
requests, and equal native outputs for editor-authored and literal creation,
every mutation, OTIO import/export, and render graphs.
