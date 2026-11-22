# In-node output previews

Image, video, and audio previews render inside a node body under a "Preview"
caption row. Every node that can show a preview has that row, before its first
picture too, so a node that can preview always says so; a node that cannot
shows nothing.

Recorded string outputs also render automatically inside the producing node
in the Standard view. This makes short text results visible immediately after
execution without switching to the Data lens.

Live compositor state and recorded previews load directly from their captured
backend. No file list is recorded and no cleanup acknowledgment delays display.
Changed sources, cancellation and disposed viewers still prevent stale publication.

## Source precedence

The first available source wins:

1. A live frame while the node is running.
2. An executed image output, including native image assets and negotiated
   recorded-value renditions.
3. The first renderable final-output rendition whose schema explicitly marks
   `preview: true`, in schema/interface order.
4. A producer image peek for a node without recorded execution presence.
5. A selected image AssetRef stored by a widget, without requiring execution.
6. A locally computed scalar expression estimate.
7. An unambiguous recorded string output.

Recorded-value candidates keep their priority while the backend reports
`409 not-complete`: the loader rechecks publication for up to ten seconds
instead of caching a lower-priority output. Closing the loader aborts the wait.
A publication timeout stays retryable; permanent refusals such as not-retained
or evicted still permit the next candidate immediately.

The declared final-output stage dispatches by the response MIME rather than
the output type. `image/*` decodes as an image, `video/mp4` and `video/webm`
play in a browser video element, and `audio/wav` plays through an audio
transport. An unmarked VIDEO or AUDIO output never creates a preview region.
VIDEO lists and multiple declared VIDEO outputs share a previous/next pager
and a bounded row of selection dots. Arrow Left/Right selects a video when
focus is in its controls; the scrubber retains its own arrow-key seeking.
Other rendition lists initially request element zero and report `1/N`.

Native VIDEO values negotiate the advertised bounded `preview` rendition,
falling back to an advertised `poster` when playback is unavailable. An
original-only VIDEO shows unavailable rather than downloading the original:
original encoded bytes do not apply pending lazy edits. App View labels bounded
rendition downloads **Download preview**, independently of any color conversion.
Live frame rings and animated WebP remain unchanged. Saved VIDEO artifacts
never become original-file playback URLs; recorded values use renditions.

Saved files may carry an associated display image, including a browser-readable
preview of an EXR. The preview is fetched for display; Download still fetches the
original saved file under its original filename. An unavailable preview does not
remove that download or fetch the original as a display fallback. File metadata
is not an inline payload: large saved-file sizes and multiple nodes' file lists
remain intact, and malformed optional previews do not discard valid saved files.
Disposing a preview loader aborts its pending recorded-file and associated-image
response bodies without stopping another loader's reads. A disposed loader no
longer accepts source loads or live-frame decodes, including stale callers that
still hold its sources. This closes loader admission but does not settle already
started shared renderers.

Recorded artifacts, associated images, native renditions, model resources and
picker thumbnails read directly from the selected source backend. Viewers and
editors abort pending requests and revoke their own Blob URLs on disposal.
Byte decoding does not acquire a cleanup receipt. File availability is checked
by the actual read, not by a separately recorded file list.

## Video inspection

Canvas and App View use the same video transport. It exposes play/pause,
time scrub, zero-based frame index, effective fps, frame count, and duration.
Comma and period step backward/forward one frame; the buttons do the same.
Frame steps use the advertised `frame` PNG rendition with an integer selector;
scrubs use a timestamp selector. Integer selectors follow actual effective VFR
frame order, independently of fps. Stepping starts at zero after playback or
a time seek, then advances from the last successfully inspected integer index.
Step controls wait for that rendition before accepting another step.
An indexed frame has unknown time; a timestamp seek has unknown frame index.
The browser never converts between them using fps. Null duration/count/fps
remain explicitly unknown. Unadvertised frame parameters disable stepping.
Counts retain `frame_count_kind`; estimated or unknown-quality counts never
clamp navigation. Reported fps is informational, not a frame-navigation clock.

Bounded frame/poster/thumbs/preview selectors are a pending backend contract,
not shipped support in the published VIDEO runtime. These controls activate
only for advertised renditions and parameters; a legacy kind-only declaration
does not advertise selectors. Browser fixtures exercise that future surface.
Without advertised bounded support, show unavailable. Never use original
encoded bytes or full disassemble as a preview fallback.

Loop, mute, and autoplay default on and persist per node in `NodeViewState.video`.
These preferences are undoable view commands, not workflow computation or
source edits. Overview playback stays muted. Controls remain accessible from
zoom 0.5 upward, including the 0.5-0.75 range; short panels scroll their
controls instead of hiding actions. Download preview has a reserved footer
outside that scroll area, so wrapped readouts cannot push it below the node.
Hover or keyboard focus requests one
PNG strip per selected video, only when the `thumbs` parameter is advertised.
The strip and its color label occupy space above the scrubber rather than
overlapping transport or timing text in short panels.
Its count comes from the provider's `defaults.thumbs`, bounded by `limits.maxCount`,
not a local capability table. Captured renderer versions identify cached requests.
Downloads follow the currently displayed bounded preview or inspected frame.

Requests retain the execution owner's client/job/runtime-node/output identity
and list element; VIDEO never sends an IMAGE/AUDIO batch selector.
Frame and thumbnail refusals display their real status and
reason. Server-provided color transforms are shown beside previews and strips;
the browser does not modify stored bytes. Selection changes cancel pending
frame/strip and output-selection work and release superseded object URLs.
Hovering during an output switch cannot start work for the old video; late
thumbnail results and errors remain bound to their source. Replacement or
disposal cancels pending selection. Initial output enumeration uses the
loader's cancellation lifetime.

Selected VIDEO inputs show `Video input preview pending server route`.
No jobless bounded input-rendition route is published in this frontend contract,
so load-node inputs never fall back to original asset bytes or a local file.
Remote-worker and cloud input playback needs that owner-published contract.

## Recorded images

Executed image outputs share one ordered inventory with the Outputs rail.
Runtime/node ids sort ascending. Each V1 `images` array retains its declared
order; native outputs sort by output key and retain every image AssetRef in
descriptor order, including repeated digests. Each URL is resolved through
the backend that owns the execution. The selected page is presentation-only
and resets for a new execution, graph, document, or tab.

For multi-image execution output, host-owned previous, next, and current/total
controls project over the preview region at normal editing zoom. The current
page can open the same product image viewer as a rail thumbnail. The controls
are omitted for a single image, live frame, selected-input preview, low zoom,
offscreen node, or region too small to contain them. Wheel gestures over the
controls continue to pan or zoom the canvas. Loading and unavailable pages
retain the real current/total count in the caption; changing pages does not
mutate the execution or document.
Paging and rendition updates retain focus on the active control, so repeated
arrow-key navigation does not require refocusing the pager.

Selected AssetRef input lists remain separate: only their first element is
rendered and `1/N` reports the list size. A list whose first element is not an
`image/*` asset does not activate a selected-input preview.

## Live preview overrides and capability gating

Documents carry an optional live-preview mode (`off`/`cheap`/`quality`/`auto`)
at the workflow root and on individual nodes; absent means inherit. A workflow
tab context submenu and a node context submenu ("Live Previews") expose the
modes with the current state checked.

The node submenu is gated by schema capability. Backends declare
`emitsPreviews: true` on node types that emit live sampling previews; the menu
appears only on nodes whose type declares the flag. A
subgraph instance keeps the menu when any inner node (at any nesting depth)
is capable, because the derived boundary schema aggregates the flag the same
way it aggregates output-node status. A mixed selection acts on the capable
nodes only.

A catalog may legitimately flag nothing, in which case no node offers the
menu. A custom node that emits previews without declaring `emitsPreviews` in
its schema loses the menu; the backend also skips preview work for such nodes,
so the menu truthfully reflects that no previews will arrive.

## States and geometry

The region is appended after the node's final row with the normal body inset.
It starts with a 22 world-unit caption row: the word "Preview" in the label
color, and at its right end, in the quieter color, what the region holds.
Before content exists the row says `no picture yet`; while the first picture
loads it says `loading`, and after a failure `failed` (or the loader's own
reason). Such a row has no arrow, nothing under it, and is ordinary node body.
Right-click the caption row (or anywhere on the region) and choose **Promote to
App View** to expose the preview, before running the workflow too.

With a picture or a ready player, the caption row has an arrow before the word,
the same disclosure arrow as a section row and the title bar's minimize arrow,
and shows expected provenance (`last resolved` or `estimated`), `i/N` for
lists, and decoded dimensions, joined by `|`. The picture's 180 world-unit
media area sits under it; images are centered and contain-fit without
upscaling, and the caption never covers image pixels. An executed output with
host controls keeps its media area while it loads or after a failure, with the
word centered in it, so a list's paging controls and a saved file's download
stay.

The whole caption row folds the preview: it highlights under the pointer like
a closed box's row, and a click (a press and release without moving) folds or
opens it. Folded, the row stays, with the arrow pointing right and a small
picture before the size. Folding is view state with the node's layout
(`view.setPreviewFolded`, `previewFolded`): it changes no value, run or cache
key, undo treats it like any other layout change, and the stored size request
opens the picture at the same size again. Clearing the selected asset returns a
capable node to its "no picture yet" row. Stored AssetRefs naturally survive
save, reload, and import because no separate preview state is persisted.

An editable selected-input preview also has a passive screen-reader equivalent.
It names the node and selected asset, reports the list count when greater than
one, and reports loading, unavailable, or decoded natural dimensions. The
equivalent is not focusable and is omitted when execution imagery wins source
precedence or when the selected asset is cleared.

Apart from the caption row's click, the region is ordinary node body for
selection, drag, resize, and hit testing. Only the executed-output paging
controls add image-specific actions.

A minimized node keeps the caption row, folded, while it has real content: a
picture to paint, shown as the small picture and its size, or else a recorded
text result, shown as the start of its first line. Without either (no preview
yet, loading, unavailable, or a ready video or audio player) the node is only
its title bar, with no second row. Clicking the caption opens the picture
under it at the height it has on the open node, without restoring the node;
again folds it. Minimized previews start folded: minimizing or restoring the
node forgets an opened one (`minimizedPreviewOpen`), and restoring brings back
the open node's own choice.
Video/audio DOM transports and paging controls are omitted while minimized.
Restoring the node returns its full preview and stored expanded size. See
[Node minimization](node-minimization.md).

Video is contain-fit and centered with shared playback controls at readable
zoom. Audio uses a centered 64px transport row and starts paused. At zoom 0.75
and above audio play/seek controls are interactive. From 0.5 through 0.75 audio
becomes a noninteractive type/duration summary. Below 0.5 the canvas paints only the
media type/count badge. At detail zoom, media DOM is confined to the media area
while the canvas paints count and cached state in the caption row above.
Media DOM is clipped to the canvas and removed when its node or projected region
is offscreen. At most 24 visible audio/video roots and 24 output-pager roots are
mounted; focused, playing, selected, and open-viewer roots receive retention
priority. Wheel gestures over media continue to the canvas; only direct control
activation is consumed.

Media loading and failure labels identify video or audio. Only 404, 406, and
410 rendition refusals enter the bounded negative cache; transport and other
HTTP failures remain retryable. A definitive miss from explicit preview
intent leaves the caption row saying why the preview is unavailable. Disposing the host pauses
media and revokes generated object URLs.

## Resizing

The node's bottom edge sizes the preview. While the preview is open, a short
bar in the middle of that edge marks it, the same bar a text box has: it takes
the accent color under the pointer and while dragged, and dragging anywhere
along the edge between the corners changes only the node's height. The
corners still resize both ways. Once pressed, the bar takes Arrow Up and Arrow
Down: each press makes the picture 10 units shorter or taller, or an open text
result one row, until Escape or a press elsewhere. A folded preview, a preview
that is only its caption row, and a minimized node have no bar. An open text
result has the same bar; it sizes the text region in whole rows, at least two.
Multiline `core.text` rows keep their
own heights in lines (see "Text box height" in `docs/widget-editors.md`), so
the preview takes all of the node's resize surplus, down to its 40-unit floor
plus the 22-unit caption. The caption-only row and the open preview map the same
stored size request, so preview appearance, removal, and zoom change neither
the text boxes nor the size the panel opens at.

## Local expression estimates

An expression node with a supported schema-declared mirror shows a live
"Estimated locally" panel with one line per declared scalar output. The panel
updates as the expression or client-resident operands change and disappears
when mirror estimates are disabled, the tab is frozen, or an operand cannot be
resolved locally. It is display-only and never substitutes for backend
execution. Calculated scalar outputs propagate through downstream expression
mirrors in dependency order. Exact and retained cached results can seed a new
downstream estimate, and schema-declared primitive known outputs enter the
same chain as exact literals. Stale results cannot seed an estimate; cycles
and unresolved suffixes show no estimate. An exact or cached result also
suppresses the same node's local estimate panel without changing the
downstream preview.

## Local image estimates

A supported GLSL mirror can use an attributed, decoded native output image
to estimate an edited node without queueing. Native rendition previews retain
the exact producing runtime node and output, including the selected batch page.
After an edit, a result whose upstream recipe no longer matches is labeled
cached. An unavailable exactness comparison also leaves runtime-backed imagery
cached. A cached result can be replaced by a local image labeled estimated, but
cannot seed another estimate itself. A proven unchanged source can still feed
the edited mirror.

An identical local-to-shared workspace promotion keeps the current comparison
proof, so an already visible estimate does not disappear during the session
swap. Changed documents, schemas, extensions, assets, backend targets and
unrelated replacement sessions do not inherit that proof. Full compile and
queue artifacts still use the current session's snapshot and revision; genuine
edits continue to defer comparison work until after paint.

Frozen views and current backend results remain authoritative. Disabling mirror
previews suppresses local estimates without discarding recorded images.

## Recorded text results

A text result appears only when the Data lens recorded-output projection finds
exactly one unambiguous inline string output for the node. Numeric, Boolean,
list, image, and arbitrary object values do not activate this region. Nodes
with two or more string outputs are deliberately deferred because choosing one
would be ambiguous. The full value remains available in the Data lens.

The result sits under the same "Preview" caption row as a picture, with the
number of the string's own lines where a picture has its size (line breaks plus one, a final line break adding none, and "empty" for an empty string; like a size, it does not change with the node's width); the row folds it the
same way, and folded it shows the start of the first line in place of a
picture, upright and in the caption's quieter text color.
Text uses the same measured wrapping as multiline canvas text. Without a size
request the region fits the result, at least two rows and at most six. The
node's bottom edge (see "Resizing") sizes it past that in whole rows, never
below two; the text boxes keep their own heights. When the result has more
rows than the region shows, the final visible row is a `+N more` marker. A
live value that is no longer proven current after a document edit uses the
existing stale companion vocabulary: semantic light blue text with a dotted
underline. Frozen or currently proven values use the normal companion value
color.

Any active media preview wins over recorded text on the same node. The text
region is suppressed until media is no longer active. This keeps one in-body
result surface and preserves the existing preview geometry.

## Executed image viewer

The Outputs rail and product-owned viewer expose complete execution and output
provenance rather than thumbnail-only identity. The shared inventory still
drives rail order and canvas paging. Opening a card or the canvas current/total
control retains grid/single selection, previous/next and Arrow-key paging,
fit, 100%, zoom, unavailable media, and focus restoration. See
[Output inspection](output-inspection.md) for the state, identity, ownership,
and responsive-layout contract.

Native IMAGE batches use the descriptor's channels-last `[B,H,W,C]` shape.
Two-channel `gray_alpha` batches use the same paging and comparison controls.
The batch pager, including Left/Right arrows while its controls have focus,
works in Canvas and App View. Opening the current image uses the same lightbox
as recorded images. Grid shows four images per page rather than downloading
the whole batch. Compare slider and Side by side each have independent left
and right image numbers and Previous/Next controls; focused side controls also
accept Left/Right arrows. Range-input arrows adjust only the compare split.
Escape closes the lightbox. Selection is view-local and never edits the graph.

Nested lists are not image batches: preview discovery descends through the
first list element at each level, then pages the selected IMAGE's batch axis.
The lightbox identifies that zero-based list path separately from the batch
index. It preserves runtime node, output ID, execution/backend identity, and
the original typed metadata. List navigation remains a value-inspection task.

IMAGE batch pages require a `png` rendition whose `parameters` explicitly
includes `batch`. The request uses `batch=3` for tensor-axis selection and
keeps `element=0,1` exclusively for nested-list descent. A PNG kind and a
batch-shaped descriptor alone do not establish batch support: older backends
show an explicit unsupported-capability notice in Canvas and App View without
requesting rendition bytes or offering batch controls for multi-image batches.
Singleton IMAGE values retain their advertised default preview without sending
a batch selector. This is the published
pending extension, not a claim that all backends ship it. No raw tensor/frame
batch is downloaded. Grid mounts at most four requests and compare mounts two.
Discovery registers the declared renderer version with the shared values
client cache; batch reads also pass it explicitly for cache identity, never as
a wire selector. Provider defaults and limits remain descriptor metadata, not
inferred capabilities. Paging sends an explicit batch index rather than relying
on the provider's default.
Changing pages/modes or closing cancels hidden tile requests and revokes their
object URLs. The values client's 64-entry/64 MiB encoded cache remains shared;
decoded previews share a 256 MiB RGBA-weighted cache budget. The declared
`limits.maxEdge` bounds the preview pixel estimate; absent that limit, source
dimensions apply. Estimates above 16 megapixels or responses above 64 MiB
encoded are refused. HDR conversion labels remain visible and display-only;
stored descriptors and source bytes are never rewritten.
