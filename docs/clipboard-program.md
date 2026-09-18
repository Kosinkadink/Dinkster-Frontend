# Clipboard Program Research

This document designs the deferred clipboard work around the graph clipboard
documented in [clipboard.md](clipboard.md). It covers Cut, cross-instance graph
paste, ComfyUI node paste, and a media clipboard inspired by ComfyUI clipspace.
It does not promise implementation or a mask editor.

Research was performed against the local ComfyUI frontend and backend source
and against the running Dinkster frontend on `:5199` and native backend on
`:8765` on 2026-07-28. No server was restarted.

## 1. What ComfyUI clipspace actually is

### It is not the graph clipboard

ComfyUI has two independent clipboard systems:

- Graph copy serializes `ClipboardItems` (`nodes`, `groups`, `reroutes`,
  `links`, and recursively referenced `subgraphs`). LiteGraph writes that JSON
  to the origin's `localStorage` key `litegrapheditor_clipboard`.
- A document-level copy event also puts that same JSON in a base64
  `data-metadata` attribute in a `text/html` clipboard flavor. The visible
  fallback text is the literal `Text`; the JSON is not written as
  `text/plain`.
- Clipspace is a separate static in-memory `ComfyApp.clipspace` object. It is
  not written to the OS clipboard, `localStorage`, or workflow JSON.

Primary sources:

- `ComfyUI_frontend/src/lib/litegraph/src/LGraphCanvas.ts`
  (`_serializeItems`, `copyToClipboard`, `_deserializeItems`)
- `ComfyUI_frontend/src/composables/useCopy.ts` and `usePaste.ts`
- `ComfyUI_frontend/src/scripts/app.ts` (`Clipspace`, `copyToClipspace`,
  `pasteFromClipspace`)

### Clipspace contents

Copying a node to clipspace snapshots:

1. Every node widget as `{type, name, value}`. This is a shallow value
   snapshot, not a schema-qualified input map.
2. Cloned `HTMLImageElement` objects for every `node.imgs` entry. Each clone
   retains the source URL. `original_imgs` is initialized to the same image
   objects and is not consumed by current first-party code.
3. `node.images`, or the node output store's `images`, as ComfyUI `ResultItem`
   references (`filename`, `subfolder`, and `type`).
4. The selected image index and a paste mode, reset to `selected`. The dialog
   can switch paste mode to `all`.
5. Conventional indexes for a painted RGB image and a combined image. Paste
   recognizes these extra raster slots if some editor populated them. There is
   no first-class mask value or paint-layer object in the clipspace type.

Clipspace therefore stores image elements and server file references, not raw
pixel blobs. It does not own a durable layered image model. Current first-party
mask editing opens directly from an image node rather than using clipspace.
The editor loads an RGB base, alpha mask, and optional paint layer, then saves
four PNGs through `/upload/image`: masked, paint, painted, and painted-masked.
Only the final painted-masked reference is written back to the source node.
This newer path is grounded in `useMaskEditorLoader.ts`,
`useMaskEditorSaver.ts`, and the cloud `/api/files/mask-layers` contract.

### Menus and semantics

When no editor has claimed `clipspace_return_node`, every node context menu
offers `Copy (Clipspace)`. It offers `Paste (Clipspace)` when clipspace is
non-empty. Image nodes additionally offer `Open in MaskEditor | Image Canvas`.
The Edit menu opens the clipspace dialog, which selects one image or all images
and previews the selected image. The 3D viewer also uses clipspace plus a return
node as an old editor handoff mechanism. The no-argument mask-editor bridge is
explicitly deprecated compatibility code.

Paste is target-node mutation, not node creation:

- selected/all image references and preview images replace the target's image
  state;
- a widget named `image` receives the selected `ResultItem` or an annotated
  filename;
- widget values are copied by matching both widget type and widget name, with
  buttons excluded;
- painted and combined raster slots, when present, override the preview image
  list according to their legacy conventions.

The observable user jobs are consequently: move a result image from one node
to another without rewiring, choose one frame from a multi-image result, and
hand an image-bearing node to an editor and receive the edited image back.
Clipspace is not a general mask interchange format.

### Recommended Dinkster media clipboard

Do not port `ComfyApp.clipspace` or widget-name matching. Dinkster already has
typed assets, backend-owned previews, and an EditorRegistry. Add a versioned
media clipboard payload alongside, not inside, `dinkster-clipboard`:

```json
{
  "format": "dinkster-media-clipboard",
  "version": 1,
  "items": [
    { "role": "image", "asset": { "digest": "blake3:..." } }
  ],
  "selectedIndex": 0
}
```

The real schema must carry complete executable `AssetRef` records and may add
typed roles such as `image`, `mask`, `paint`, and `composite`. Roles describe a
bundle; array indexes must not acquire hidden meanings. The graph clipboard
continues to own graph topology. A shared clipboard router chooses graph,
media, ComfyUI HTML, or native text behavior.

Offer `Copy image` only for a durable asset reference. A transient WebSocket
preview or V1 `/view` URL must first be explicitly materialized through the
ordinary asset protocol; never put an expiring URL in the envelope. `Paste
image` should target a compatible AssetWidget through `node.setValue`, or open
the future image/mask editor through EditorRegistry. Execution outputs remain
execution-owned and must not be overwritten to imitate ComfyUI's node preview
mutation.

Because AssetRef has no backend identity, "same backend" cannot be inferred
from the untrusted OS payload. Media v1 must either pair the envelope with
page-local trusted source-connection identity and compare it to the target, or
probe the target backend for the referenced digest before assignment. If
neither check proves availability, reject with a repair/transfer explanation;
do not assign a structurally valid but unavailable reference. This presence
check is distinct from the later cross-backend byte-transfer protocol.

A future layered editor should persist each layer as an asset, return a bundle
through ordinary commands, and use the same maintained asset protocol as every
other frontend surface. The clipboard may reference that bundle but must not
be its persistence layer. EditorRegistry currently provides placement, not a
media handoff or return protocol, so this is an architecture direction pending
the editor design rather than a ready integration contract.

## 2. Dinkster cross-instance graph paste today

### Empirical result

An inline headless Playwright run opened Chromium on the running `:5199`
frontend with clipboard permission and exercised the keyboard-shortcut copy
path. Synthetic unknown-node fixtures carried an AssetRef-shaped value, a
remote-combo-like string, and a `#g1` subgraph instance. Reading the system
clipboard returned version 1 `dinkster-clipboard` JSON in `text/plain`, including
the full shaped value and string but only the `#g1` instance, not its
definition. A representative payload fragment was:

```json
{"format":"dinkster-clipboard","version":1,"nodes":[{"data":{"type":"UnknownAssetNode","values":{"image":{"digest":"blake3:...","mediaType":"image/png","virtualPath":"images/source.png"}}}},{"data":{"type":"UnknownRemoteCombo","values":{"model":"remote-choice.safetensors"}}},{"data":{"type":"#g1","values":{"prompt":"preserved override"}}}]}
```

This proves shortcut-path JSON serialization of those synthetic values only.
It does not prove AssetWidget behavior, asset-byte availability,
remote-option resolution, executable schema availability, or target paste.

Attempts to drive the corresponding paste into a separate empty browser
context were inconclusive: isolated browser contexts did not reliably share
the host clipboard, and synthetic canvas keyboard input did not provide an
independent proof of the target transaction. The survival and rejection rules
below therefore combine the directly observed system payload with the cited
serializer, validator, and paste-planner source. They are not reported as an
empirically completed cross-context paste. Existing E2E coverage independently
proves a same-origin cross-document system-clipboard paste for ordinary nodes.
No server was restarted or mutated during this research.

### Exact envelope and survival rules

Copy writes JSON with:

- `format: "dinkster-clipboard"`, `version: 1`;
- selected semantic node records plus node view records;
- selected reroute records plus reroute view records;
- only links whose two endpoints are included;
- explicitly supplied view groups.

Node data includes its type, values, controllers, dynamic state, mode, title,
and extension data. Paste validates every record, remaps node/reroute/link/group
IDs, translates positions, and dispatches one `clipboard.paste` command.

What survives across processes:

- Plain nodes, node values, controller modes, dynamic state, extension JSON,
  view state, self-contained links, and reroutes survive. The envelope and
  planner can represent explicitly supplied groups, but the current
  `CanvasHost.copySelection` path supplies only nodes and reroutes, so groups
  are not currently copied by the user shortcut.
- AssetRef JSON survives structurally. Availability does not. Asset refs carry
  a digest and metadata but no source backend identity, and paste performs no
  acquisition. A different target backend may not have those bytes.
- A remote combo's stored scalar survives. The fetched option list does not
  live in the document. On edit, options are fetched from the target tab's
  backend, so the value can become out-of-vocabulary or unavailable.
- A node type can be absent on the target backend. It remains a missing-schema
  node and cannot run until that schema exists.
- Subgraph definitions never enter version 1. A missing `#gN` definition
  rejects the whole paste. Worse, an unrelated target definition with the same
  ID can capture the instance reference. Numeric definition IDs are
  document-local, not portable identities.
- Named nets, surfaces, selectors, value sources, boundary bindings, and links
  crossing outside the selection do not survive.

The in-memory fallback is per page JavaScript realm. It helps a denied read
after a copy in the same page, but cannot rescue another tab or process. True
cross-instance paste requires the system write and system read to succeed.

Primary sources are `packages/core/src/clipboard.ts`,
`packages/app/src/clipboard-paste.ts`, `packages/app/src/CanvasHost.tsx`, and
`packages/e2e/tests/clipboard.spec.ts`.

### Recommended hardening

1. Extend the envelope with a `definitions` closure for every selected
   subgraph instance, recursively. On every paste, clone and freshly key one
   closure, preserving sharing only among instances that referenced the same
   source definition inside that payload. Do not content-deduplicate against
   target definitions: equal bytes do not mean two mutable definitions should
   share future edits. Never bind by a coincidentally equal `gN` key.
2. Cross-backend assets require a new staged transfer operation; the existing
   legacy filename guesser and queue-time acquisition consent do not provide
   it. A trusted configured source must be resolved outside untrusted payload
   URLs, target presence probed, consent obtained, source bytes fetched and
   digest-verified, target upload completed, metadata reconstructed, and all
   async ownership rechecked before the atomic graph commit.
3. Keep remote option lists out of the payload. After paste, surface a warning
   when a stored remote value is not offered by the target backend; do not
   rewrite it silently.
4. Report paste rejection and partial portability problems in Problems. Keep
   commit all-or-nothing after any required user decisions.
5. Add envelope size/count limits before deep validation. Clipboard input is
   foreign input even when it resembles Dinkster JSON.
6. Make the fallback limitation explicit in UI messaging: `Copied locally`
   is not equivalent to `Copied for other tabs`.

## 3. Pasting ComfyUI nodes into Dinkster

### Payload mismatch

Modern ComfyUI copy places its selection in the OS clipboard as `text/html`:

```html
<meta charset="utf-8"><div><span data-metadata="BASE64_JSON"></span></div>
<span style="white-space:pre-wrap;">Text</span>
```

The decoded JSON is `ClipboardItems`, not a workflow:

- `nodes`: serialized LiteGraph nodes with positional `widgets_values`;
- `links`: modern object-form links (`origin_id`, `origin_slot`, `target_id`,
  `target_slot`, `type`, optional `parentId`);
- `groups`, native `reroutes`, and recursive `subgraphs` arrays.

ComfyUI also saves the same JSON to its own origin's `localStorage`, but Dinkster
cannot read another origin's storage. Dinkster currently calls
`navigator.clipboard.readText()`, sees no `dinkster-clipboard` envelope (typically
only the HTML fallback text), and does nothing. Feasibility therefore starts at
the browser paste event or `navigator.clipboard.read()` with `text/html`; JSON
conversion alone is not enough.

### Mapping to the existing importer

The existing LiteGraph importer already owns the hard semantic translation:
schema-resolved positional widgets, controller companion values, modes,
titles, groups, legacy Reroute nodes, PrimitiveNode, Set/Get named nets,
unknown-node parking, and diagnostics. It should remain the source of truth.

An adapter is still required because `importLitegraph` expects a complete
workflow-like object with legacy array links. It does not directly accept
`ClipboardItems`; native reroutes are currently dropped by full-workflow
import, and ComfyUI subgraph import is a documented hard error.

Recommended converter pipeline:

1. Move ownership of canvas Paste either to the actual `paste` event or to
   `navigator.clipboard.read()`. The current keydown handler prevents the
   browser paste and calls `readText()`, so an event router cannot simply run
   beside it. Prefer native Dinkster graph/media flavors, then recognize
   ComfyUI's exact `data-metadata` HTML wrapper, then leave text editing and
   foreign content alone.
2. Length-check the encoded HTML metadata before base64 decode and JSON parse,
   then enforce entity-count and JSON-shape limits. `ClipboardEvent.getData()`
   has already materialized the HTML string; `navigator.clipboard.read()` can
   expose a Blob size first but has different permission/support constraints.
   Do not execute HTML or accept arbitrary embedded scripts/markup. A true
   pre-parse nesting bound needs a bounded parser rather than plain
   `JSON.parse`.
3. Normalize modern node IDs to a private safe integer namespace. Convert
   object links to the legacy tuples the importer consumes, retaining only
   links whose required endpoints are in the copied selection. Translate
   native reroutes rather than dropping their geometry.
4. Preflight the original normalized `ClipboardItems` before import. Reject
   every source construct outside the approved ordinary-node subset, including
   PrimitiveNode, Set/Get, notes, native reroutes until supported, subgraphs,
   and unsupported dynamics. Source-shape checks are mandatory because the
   whole-workflow importer can omit a construct while emitting only a
   diagnostic.
5. Build a synthetic LiteGraph workflow and invoke `importLitegraph` against
   the target tab's schema registry. Preserve every importer diagnostic and
   define an explicit blocking-code allowlist: any diagnostic that means a
   source node, link, value, geometry, or semantic construct was dropped or
   unresolved blocks commit.
6. Preflight the imported result against what `DinksterClipboardEnvelope` can
   represent. The first slice must reject PrimitiveNode-derived value sources,
   Set/Get-derived named nets, notes, and any other root constructs the native
   envelope cannot carry. For the ordinary-node subset, convert the imported
   root graph to an envelope and use the existing one-command paste planner for
   fresh IDs, positioning, undo, shared-session allocation, and ownership
   checks. Supporting those richer constructs requires extending the native
   fragment materializer, not silently dropping them. Do not open a replacement
   tab.
7. Legacy filename assets need an explicit target-scoped resolution decision
   before atomic commit. Cross-backend AssetRefs need the new staged transfer
   contract from section 2; neither current flow can be reused unchanged.
8. Reject ComfyUI `subgraphs` loudly until the separate LiteGraph subgraph
   importer lands. Do not paste instances as unknown nodes or discard their
   definitions.

The first converter should support ordinary nodes, self-contained links,
groups, positional widget/controller values, and legacy Reroute nodes. It must
block, rather than drop, PrimitiveNode, Set/Get, notes, native reroutes,
subgraphs, and dynamic shapes that cannot survive the adapter unless the user
explicitly approves an independently valid subset. ComfyUI custom nodes whose
schemas are unavailable should keep the importer's placeholder and raw-value
behavior.

## 4. Cut design

Cut should compose the existing serializer, clipboard writer, and deletion
commands rather than introduce a second envelope. Version 1 must be limited to
entity kinds the envelope actually represents. Today CanvasHost copy supplies
nodes and reroutes, while selection deletion can also remove standalone links,
net sinks, boundary bindings, value sources, and selectors. Deleting the live
selection after serializing only part of it would lose uncopied content.

Recommended contract:

1. Support nodes and reroutes only in the first slice. Before publication,
   dry-run the exact delete command to derive its complete deletion and
   modification closure. Refuse Cut when the selection or closure contains
   anything the payload does not represent: unsupported selected kinds,
   boundary-crossing links, named nets or sinks, boundary bindings, value
   sources, selectors, surviving dynamic-node compaction, or any other
   cascading record change. Internal links are allowed because the
   self-contained payload represents them. Groups can join only when the UI
   actually supplies them to both serializer and deletion path.
2. Capture the exact tab object, graph incarnation, document revision,
   supported IDs, complete dry-run closure, and serialized envelope before
   awaiting the system write. Establish exact equivalence between records in
   the portable payload and records the deletion plan removes or modifies.
3. Require a successful system clipboard write. A page-local fallback is not
   sufficient authority to delete user data, because it does not satisfy the
   cross-instance meaning of Cut.
4. After the await, abort without mutation if the tab, graph incarnation,
   revision, frozen state, captured records, or recomputed deletion closure
   changed. This is intentionally conservative: deleting a newer node while
   holding an older clipboard snapshot is data loss.
5. Dispatch only the captured, revalidated deletion plan as one batch, never a
   fresh deletion of the live selection. Undo restores the represented records
   atomically. Undo does not restore the previous OS clipboard; that external
   side effect matches normal desktop Cut behavior.
6. Clipboard content stays self-contained. A selection with a link crossing
   its boundary is refused by v1 because deleting that link would lose content
   absent from the payload. A later reconnectable-stub design could make such a
   Cut portable, but it must not be smuggled into v1.
7. On denied write, stale ownership, or dispatch rejection, keep the graph
   untouched and show a short actionable error.

## 5. Slice decomposition

Rough sizes are implementation and focused-test effort, not calendar promises.

| Slice | Scope | Size |
| --- | --- | --- |
| A | Node/reroute-only Cut, complete delete-closure dry run/refusal, owner/revision guard, successful-write requirement, captured-plan atomic delete, UI error | M-L |
| B | Clipboard shortcut ownership refactor with native text behavior preserved and HTML metadata length checks before decode/parse | M |
| C | ComfyUI HTML decoder, source-shape and blocking-diagnostic preflight, modern-link/ID adapter; ordinary-node import into current graph | M-L |
| D | ComfyUI groups and native reroutes; explicit unsupported-shape diagnostics | M |
| E | Cross-instance subgraph definition closure, fresh clone/re-key policy, nested tests | L-XL |
| F | Trusted cross-backend asset provenance and staged pre-commit transfer/consent | L-XL |
| G | Media clipboard v1 limited to complete AssetRefs already stored in AssetWidgets, with trusted connection identity or target-presence proof | M |
| H | Completed-output materialization plus layered image/mask bundle and editor handoff | blocked/unsized |

Suggested order: A, B, C, D, then E/F. Restricted same-backend G can proceed
after product questions 1-4, 17, 18, 20, and 22 below are answered.
Cross-backend G also waits for F. H waits for questions 19 and 21 plus the
image/mask editor and bundle semantics.

## 6. Open product questions

1. Is the media clipboard a one-item desktop clipboard, a visible reusable
   shelf/history, or both? ComfyUI implements only one volatile item.
2. Should `Copy image` be available only for durable assets, or may it prompt
   to upload/materialize a transient preview?
3. When a media payload reaches an incompatible selected node, should Paste do
   nothing, open a target chooser, or create a suitable load node?
4. Should multi-image paste preserve a batch as one list value, create several
   nodes, or ask each time?
5. May cross-backend paste transfer bytes automatically after explicit consent,
   or should it preserve unavailable refs and report them for later repair?
6. If a remote combo value is unavailable on the target backend, should paste
   commit with a warning or block the whole selection?
7. Should ComfyUI clipboard import appear as ordinary Paste automatically, or
   require a distinct `Paste from ComfyUI` command so diagnostics can be shown
   before commit?
8. Should unsupported ComfyUI subgraphs block the whole selection (recommended)
   or allow the independent ordinary-node subset after a preview and consent?
9. For Cut, is successful OS clipboard publication mandatory (recommended),
   or may a same-page fallback authorize deletion?
10. Should v1 refuse every Cut with boundary-crossing links (recommended), or
    does the product require a reconnect-stub representation before Cut ships?
11. Is v1 Cut limited to nodes and reroutes, or must standalone links, groups,
    value sources, selectors, nets, and boundary bindings become portable too?
    Should a mixed supported/unsupported selection block the whole Cut
    (recommended)?
12. Must any document revision change cancel Cut, including an unrelated
    multiplayer edit in another graph, or may it compare the complete captured
    deletion/modification closure? If clipboard publication succeeds but
    ownership then goes stale, is `nothing was cut` with the new clipboard
    retained acceptable?
13. Which ComfyUI unsupported constructs block the whole paste: PrimitiveNode,
    Set/Get, notes, native reroutes, Autogrow, and subgraphs? May an independent
    ordinary-node subset proceed only after a preview and explicit approval?
14. On same-lineage subgraph paste, should instances keep sharing an existing
    definition or always receive a detached clone? Should repeated pastes clone
    again, and must same-content independently authored definitions stay
    independent?
15. Which configured source backends may supply asset bytes, and who transfers
    them? Define authentication, CORS, size, timeout, cancellation, digest
    verification, and the prohibition on arbitrary clipboard-provided URLs.
16. After cross-backend upload, is source `virtualPath` discarded, preserved as
    provenance, or mapped to a target path? Is digest equality sufficient for
    content dedupe while UI identity remains digest plus virtual path?
17. Does `Copy image` v1 cover only a complete AssetRef already stored in an
    AssetWidget, or also native completed outputs, V1 outputs, peek renditions,
    and live frames? Which latter cases may prompt for materialization?
18. If a target node has several compatible asset inputs, which receives Paste?
    Define scalar, list, `asset<list<T>>`, and merge-capable scalar behavior.
19. What semantically distinguishes a mask from an ordinary grayscale PNG?
    Define dimensions, alpha/polarity, color space, and layer compatibility
    before adding mask/paint/composite roles.
20. Should media copy also publish `image/png` for external applications? If
    Dinkster JSON and image flavors coexist, which wins on paste?
21. Is an image/mask editor a view over the workflow tab, a separate asset
    document, or a transient session? Which serializable commands own layers
    and make the return operation undoable?
22. How should media copy prove source/target backend identity without trusting
    provenance supplied by the OS payload? Is trusted live connection identity
    retained page-locally, or must every paste probe the target for the digest
    and reject/report absence before assigning the AssetRef?
