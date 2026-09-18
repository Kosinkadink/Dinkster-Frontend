# In-node output previews

Image, video, and audio previews render inside a node body. Before execution,
a preview-capable node reserves one compact row that identifies the preview
surface and its App View promotion action.

Recorded string outputs also render automatically inside the producing node
in the Standard view. This makes short text results visible immediately after
execution without switching to the Data lens.

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

The node submenu is gated by schema capability. Backends at schema wire 24 or
later declare `emitsPreviews: true` on node types that emit live sampling
previews; the menu appears only on nodes whose type declares the flag. A
subgraph instance keeps the menu when any inner node (at any nesting depth)
is capable, because the derived boundary schema aggregates the flag the same
way it aggregates output-node status. A mixed selection acts on the capable
nodes only.

Gating applies iff the negotiated schema wire version is 24 or later - the
backend's declared version, not catalog contents, decides: a wire-24 catalog
may legitimately flag nothing (then no node offers the menu), and a flagged
frontend-registered schema never makes an older backend look flag-aware. On
backends below wire 24 (including v1) every node keeps the menu, preserving
the older show-everywhere behavior. Known tradeoff: a custom node that emits
previews without declaring `emitsPreviews` in its schema loses the menu on
flag-aware backends (false negative); the backend also skips preview work for
such nodes, so the menu truthfully reflects that no previews will arrive.

## States and geometry

The region is appended after the node's final row with the normal body inset.
Before content exists, it is one 24-unit row. Right-click that row and choose
**Promote to App View** to expose it before running the workflow. Active
previews reserve a 180 world-unit media area plus a 22 world-unit caption strip.
Images are centered and contain-fit without upscaling inside the media area;
the caption never covers image pixels. The caption is always painted when a
preview is present. Its first line shows expected provenance (`last resolved`
or `estimated`) and `i/N` for lists; its second line shows decoded dimensions.
Pending decodes show `loading preview...`;
failed asset decodes show `preview unavailable`. Clearing the selected asset
returns a capable node to its compact row. Stored AssetRefs naturally survive
save, reload, and import because no separate preview state is persisted.

An editable selected-input preview also has a passive screen-reader equivalent.
It names the node and selected asset, reports the list count when greater than
one, and reports loading, unavailable, or decoded natural dimensions. The
equivalent is not focusable and is omitted when execution imagery wins source
precedence or when the selected asset is cleared.

The region is ordinary node body for selection, drag, resize, and hit testing.
Only the executed-output paging controls add image-specific actions.

A minimized node keeps an always-visible one-row preview. Available image
content is contain-fit into that row; otherwise it shows a compact loading,
unavailable, or `Preview` label. Video/audio DOM transports and paging controls
are omitted while minimized. Restoring the node returns its full preview and
stored expanded size. See [Node minimization](node-minimization.md).

Video is contain-fit and centered with shared playback controls at readable
zoom. Audio uses a centered 64px transport row and starts paused. At zoom 0.75
and above audio play/seek controls are interactive. From 0.5 through 0.75 audio
becomes a noninteractive type/duration summary. Below 0.5 the canvas paints only the
media type/count badge. At detail zoom, media DOM is confined to the media area
while the canvas paints count and cached state in the caption below.
Media DOM is clipped to the canvas and removed when its node or projected region
is offscreen. At most 24 visible audio/video roots and 24 output-pager roots are
mounted; focused, playing, selected, and open-viewer roots receive retention
priority. Wheel gestures over media continue to the canvas; only direct control
activation is consumed.

Media loading and failure labels identify video or audio. Only 404, 406, and
410 rendition refusals enter the bounded negative cache; transport and other
HTTP failures remain retryable. A definitive miss from explicit preview
intent retains the region as `Preview unavailable`. Disposing the host pauses
media and revokes generated object URLs.

## Resizing

Existing multiline `core.text` rows retain first claim on user-resize surplus.
The compact row and active preview map the same stored size request, so preview
appearance, removal, and zoom do not change multiline editor height. The media
area grows beyond 180 only when there is no active `core.text` row; the 22-unit
caption remains reserved in both cases. This preserves the existing preview
budgets and multiline resize contract.

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

## Recorded text results

A text result appears only when the Data lens recorded-output projection finds
exactly one unambiguous inline string output for the node. Numeric, Boolean,
list, image, and arbitrary object values do not activate this region. Nodes
with two or more string outputs are deliberately deferred because choosing one
would be ambiguous. The full value remains available in the Data lens.

Text uses the same measured wrapping as multiline canvas text. A short result
uses one row; wrapped results grow to their content and stop at six rows. When
wrapping produces more rows, the final visible row is a `+N more` marker. A
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
