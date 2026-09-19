# Common asset browser

Widget media pickers expose All assets, Imported, and Generated through the
shared collection surface. All assets fans out to every compatible ready
mount. Imported includes mounts classified by trusted mount identity as input,
and Generated includes output mounts. A custom unclassified mount remains in
All assets only. Each adapter retains query, folder, kind, and opaque cursor
ownership; the fan-out rejects stale query and generation responses.

Model-kind widgets feed grouped local-mount and read-only Candidate V1 data
through a logical-model `CollectionSource` adapter. Candidate requests are made
only for an authoritative existing node input and use its declared kind,
accept list, node type, and input key. Value sources and missing graph targets
stay local-only.

`CollectionPanel` is the only widget browse shell. Media and model providers
supply entries while the shell owns one SearchInput, one listbox, one staged
selection contract, and one footer commit path. Model providers can supply
multi-variant group entries; a single variant remains a plain row. Model rows
default to list and media rows default to grid. Model upload is disabled.

Status: **SUPERSEDED - unified onto the common collection surface (2026-07-25).**

Phase 1 shipped a dedicated `AssetBrowser` renderer (decision 1 below). That
decision is now reversed: assets browse and pick through the ONE shared
`CollectionPanel` list/grid surface (the same renderer the Library uses, and
the one Manager sources will use), embedded in the ASSET widget's native
product dialog in pick mode. The dialog is non-draggable, focus-contained,
Escape/explicit-close operable, opener-focus-restoring, and internally
height-contained on narrow or short viewports. The collection list is its
sole collection scroller; the CollectionPanel footer and outer upload actions
remain visible non-scrolling siblings. Sparse states content-size instead of
stretching to the overflow-dialog cap. It keeps schema-owned kind, MIME
accept, and cardinality constraints visible beside the shared browser. What
remains asset-OWNED is exactly the non-rendering half of the original contract:

- `asset-browser/types.ts` - `AssetBrowserItem` + `AssetSourceAdapter`
  (transport contract; mounts today, pack declarations later);
- `asset-browser/mountAssetSource.ts` - mount discovery + paging transport;
- `asset-browser/collection-adapter.ts` - maps an `AssetSourceAdapter` onto
  the common `CollectionSource` vocabulary; mount entries carry the whole
  `AssetBrowserItem` as an opaque `ref`, while federated entries retain their
  exact `AssetRef` and are normalized only for asset-owned presentation;
- `asset-browser/rail.tsx` - the shared selection/details presentation
  (preview, facts, digest copy, and opt-in safetensors inspection) used by
  the picker and the Assets panel;
- `asset-browser/helpers.ts` - compatibility, preview policy, discovery
  status; `asset-browser/metadata.ts` - inspection ownership (AP10).

Every existing behavioral pin (server-owned query, query-bound cursors,
folder honesty, compatibility hiding in pick mode, complete `AssetRef`
commits, metadata staleness ownership, persisted view preference - the
legacy `tile` value decodes as `grid`) carries over unchanged and is proven
by the same test files. The sections below are kept as the design record;
read "AssetBrowser" as "CollectionPanel in pick mode + the asset adapter"
throughout. The standalone browse mode is shipped as the left-dock Assets
section. It uses the same mount adapters and selection/details panel without
enabling pick or document mutation. The consent-dialog presentation remains future work;
the v1 exclusions remain in force.

The left-dock embedding is search-first. It composes the shared `SearchInput`
and state vocabulary, keeps inactive filters behind a disclosure, and shows
only active filters as removable capsules. Available mounts live in one
source combobox. Empty, unavailable, and failed sources live in a separate
Source health disclosure rather than becoming asset rows. Loading, empty,
no-match, incompatible, and error states have distinct copy. Preview absence
or image decode failure uses a kind-family icon, never initials or broken
media chrome. These presentation choices do not change source-owned query,
folder, cursor, or `AssetRef` identity.

Without an injected federated contract, `All assets` remains the client-side
fan-out over the existing per-mount `/api/mounts/{id}/entries` endpoints. It
sends the same query to each ready mount, merges pages by name and virtual
path, and carries per-mount opaque cursors in a query-bound composite cursor.
One mount failure is reported in Source health while successful mount results
remain available. If every ready source fails, the results area reports an
error rather than claiming the catalog is empty.

With an injected contract, `All assets` reads only the federated catalog and
preserves its server order and opaque cursor. Its rows use the same compact
name-and-size presentation as mounted assets; kind, catalog status, provider,
path, and digest remain available in selection Details. Backend ingestion commits
`816f9da` and `e78b398` satisfied the former union-removal trigger on
2026-08-12: receipt audit/07199b23 proved the deployed `/api/catalog`
digest set exactly matched all ready-mount entries (31 = 31). Per-mount
sources remain available for source-specific browsing, and the no-contract
fan-out remains the explicit fallback. This introduces no backend endpoint
or DTO.

The dock source combobox prefixes human-readable mount-kind labels with
Models, Media, Input/Output, or Other. A numeric suffix distinguishes repeated
kinds. Ready mounts proven empty by `entryCount: 0` and unavailable mounts are
reported in Source health; unknown counts remain selectable. Mount ids remain
available in selected-entry details. There is no Uploads source because the
upload vault has no enumeration API.

Source controls, known mount-kind labels, health counts, discovery states, and
result states use the host locale and update while the Assets panel is open.
Mount ids, unknown source labels, mount states, backend failures, and asset
identity remain source-authored data and are not translated. A locale change
does not repeat source discovery or catalog requests.

Both embeddings preserve one bounded flex chain into `CollectionPanel`.
`.collection-items` shrinks and owns row overflow with a stable scrollbar
gutter; the footer is outside that scroll region. Keyboard navigation adjusts
the list scroll after selection details expand, keeping the complete focused
row visible.

The Widget picker is browse-primary. The browse list owns the left column at
full dialog height; the current selection lives in a compact rail on the
right (capped around 260px wide) that never squeezes the list, and the dialog
is wider to hold both. Picker rows are compact - name plus formatted size -
because kind, source, mount, virtual path, and digest belong to the detail
rail, and in the picker that rail shows only a name/size summary with the
full facts and opt-in metadata inspection behind a closed `Details`
disclosure. Model rows add only an availability badge; aliases, digest,
providers, conflicts, and download state also stay in selection Details.
The Assets dock uses the same click-to-populate summary and closed `Details`
disclosure, with a quiet instruction when nothing is selected. Image entries
show their digest-backed preview and decoded resolution when available. On
narrow viewports (at most 700px wide) the picker selection rail stacks
above the browse list, capped at 30% of viewport height so the list keeps
most of the space. The selected image preview is capped at 140px (80px on
viewports at most 800px high).
Rapid commit and reopen is lifecycle-safe: a retiring native dialog's close
event is consumed by that instance and cannot dismiss its immediate successor.

All assets preserves partial results when one ready source fails and the
global browser retains an unavailable source note. When every compatible
ready source fails, the Widget picker shows the combined listing error rather
than claiming there are no compatible entries.

A primary backdrop press normally closes the picker. If that same trusted
press targets an exposed ASSET row on the canvas, CanvasHost closes the old
dialog, hit-tests the current scene at the pointer coordinate, and opens the
target ASSET editor. It never synthesizes a browser event and never mutates
the document. Upload dismissal lock still blocks both close and handoff.

## Decisions for review

1. Build a dedicated `AssetBrowser` in `packages/app`, reusing the paging discipline but not the generic entry shape of `CollectionPanel`.
2. Make mount catalog entries the first browse adapter and migrate the ASSET widget first; keep upload as a separate action, not a synthetic asset source.
3. Share one single-selection model across tile and list views, and persist the last view mode globally as `dinkster.assetBrowser.view.v1`.
4. Use server-owned query paging, exact kind filtering, and mount folder navigation; never filter only the loaded page.
5. Fetch preview bytes only for previewable `media/*` entries and fetch safetensors metadata only on explicit detail inspection.
6. Treat the missing-assets consent dialog as a read-only AssetBrowser presentation, not as an asset picker.
7. Defer browser multi-select, bulk asset operations, drag-out, upload-in-place, and asset mutation until usage proves their contracts.

## Baseline before phase 1

- The ASSET widget editor in `CanvasHost` is not currently a browser. It shows the selected asset name, size, and an image preview fetched by digest. Its only picker is a native file input labelled `choose image`; choosing a file checks the widget's MIME `accept` list and a 16 MiB limit, uploads to `POST /api/assets`, and commits an `AssetRef`. It does not list the upload vault or mounts.
- SAVE_TARGET fetches `GET /api/mounts` fresh on each open, keeps only `ready` and `readwrite` mounts, and edits `{mount, prefix}`. It deliberately neither shows nor stores host paths. An unavailable current mount remains visible to avoid trapping an existing document. This is destination selection, not asset selection, so it should share mount/folder presentation primitives but not `AssetBrowser`'s asset contract.
- The Library sidebar already has a generic `CollectionPanel`: source tabs, source-owned debounced query, exact filters, query-bound cursor paging, stale-response guards, lazy thumbnails, list/grid mode, one selected entry, details, and actions. Its mode currently starts as list on every mount. Sources include local packs and live execution history plus remote workflows, durable runs, and templates. Pack rows expose declared assets in details; template rows resolve pack-local requirement IDs against those declarations. Neither is an asset-row browser today.
- Pack asset declarations contain id, name, digest, optional kind, size, media type, metadata, sources, and requiring node types. Template requirements are pack-local asset IDs, not standalone catalog rows until joined to their pack declarations.
- The client has immutable digest bytes at `GET /api/assets/{digest}` and upload at `POST /api/assets`. There is no endpoint that enumerates the upload vault itself, so v1 must not advertise an "Uploads" source. Workflow library records enumerate workflow documents, not arbitrary uploaded assets.
- Mount APIs provide a small mount list, one-level folder listing at `/api/mounts/{id}/list`, and query-paged catalog entries at `/api/mounts/{id}/entries`. A catalog row already has the fields needed to commit the existing `AssetRef`: virtualPath, name, digest, size, and mediaType.
- `GET /api/assets/{digest}/metadata` is the opt-in safetensors probe surface; it should not be called while rendering every row.
- The missing-assets consent dialog landed concurrently with this proposal. It renders checkbox rows with name, optional kind and size, status, source or `packagedFrom` story, and failure detail. Fetchable rows start checked; its dialog-owned action retries the exact rejected job with selected digests. AssetBrowser should replace only the common row presentation/details, not take ownership of consent selection or acquisition.

## Component contract

`AssetBrowser` owns rendering, paging state, selection, view mode, keyboard behavior, empty/error/loading states, and the detail rail. A source adapter owns transport and source-specific normalization.

```text
Host configuration
  mode: pick | browse | readonly
  sources[] ----------+       +----------------------+
  initialSelection    +------>| AssetBrowser         |
  kind/accept preset  |       | query/filter/paging  |
  allowed actions     |       | tile/list/selection  |
  onPick/onAction ----+<------| details              |
                              +----------+-----------+
                                         |
                              AssetSourceAdapter
                                         |
                  +----------------------+-------------------+
                  | mount entries | pack declarations | requirements |
```

Proposed conceptual types (names and fields are design, not implementation):

```text
AssetSourceAdapter
  id, label, sourceLabel
  capabilities: { folders, query, kindFilter, thumbnails, actions }
  page({ query, kind?, folder?, cursor?, limit, signal })
    -> { items, cursor?, total? }
  listFolder?({ folder, signal })
    -> { folders, items? }
  loadMetadata?(item, signal) -> detail sections
  actions?(item) -> actions
  runAction?(actionId, item)

AssetBrowserItem
  id                 stable within adapter; digest alone is not source identity
  name
  kind?              open-vocabulary string, never a closed enum
  mediaType?
  size?
  digest?
  source: { id, label, path? }
  virtualPath?
  folder?            navigation item, never pickable as an asset
  thumbnail?         adapter hint; browser still applies preview policy
  status?            for requirement/consent rows
  details?           ordered facts, including packagedFrom or requirement owner
  rawRef?            adapter-owned value used to commit or act
```

The page request follows the existing collection rule: query belongs to the source, a changed query/filter/folder restarts at page one, cursors are opaque and bound to that request, and stale requests are cancelled or ignored. `id` should normally be `adapter id + virtual path` for mount rows and `pack id + asset id` for declarations; digest remains content identity and can legitimately appear in multiple sources.

### Known adapters

| Adapter | Rows and transport | Folders | Primary actions |
| --- | --- | --- | --- |
| Mount entries | Ready readable mounts from `GET /api/mounts`; catalog from `/entries`; one level from `/list` | Yes | Pick, inspect |
| Pack-declared assets | Join active backend pack table to each pack's asset declarations | No | Inspect declaration; future acquire only through consent policy |
| Template requirements | Join template asset IDs to the owning pack declarations; preserve unresolved IDs as unavailable rows | No | Inspect requirement/owning template |
| Missing requirements | Adapt one `assets-missing` rejection, including status, kind, size, sources, and `packagedFrom` | No | Read-only in this component; dialog owns consent/acquire controls |
| Upload vault/library | **Not available as a catalog today**. Add only when a backend enumeration API exists | Unknown | Not in v1 |

Pack and template adapters are useful in Library browse mode but must not imply that declared bytes are locally selectable. Pick mode should include only adapters whose rows can produce a valid, available `AssetRef` on the active backend.

## Views and selection

Both views use the same selected item ID, focus model, query, filters, page, and detail state. Switching views does not clear selection or refetch.

```text
Tile                                      List
+------------+ +------------+            Name          Kind         Size    Source
| thumbnail  | | model icon |            sunset.png    media/image  2 MiB   input/photos
| sunset.png | | style.sft  |            style.sft     model/lora   144 MiB pack: styles
| image chip | | lora chip  |
+------------+ +------------+
```

- Tile mode uses a lazy thumbnail from `/api/assets/{digest}` only when kind is `media/*` and the media type is browser-previewable. If kind is absent, a browser-previewable `mediaType` may be used as a conservative fallback. Models and unknown kinds get a stable kind-family icon plus kind chip, never initials that suggest a preview failed. Video/audio v1 tiles use family icons; autoplay and waveform extraction are out of scope.
- List mode has fixed semantic columns: name, kind chip, formatted size, and source. Path/status may be secondary text. Narrow hosts collapse source and size beneath name rather than horizontally scrolling the picker.
- Single click selects and opens details in browse mode. In pick mode, click or Enter stages the item into the host dialog's selection panel; nothing commits until the dialog footer's primary commit button (`Use asset` / `Use N assets`) commits, so browsing never commits accidentally. Folders navigate on single activation and are never selectable. Read-only mode permits focus/details but has no pick affordance.
- Keyboard: arrows move through the visual order, Home/End move within loaded rows, Enter activates, Escape returns to the host, and focus remains on the corresponding item when modes switch.
- Persist only `tile | list`. Media uses `dinkster.assetBrowser.view.v1`; models use its model-specific companion key so the model list preference does not replace the media grid preference. Hosts set the first-use default to grid for media-specific ASSET and list for models, while a stored choice wins.

## Search, kinds, and folders

The global toolbar order is text search, active filters, source and health,
inactive-filter disclosure, then view switch. Compact picker embeddings retain
their source/filter/search arrangement.

> **Status (2026-07-28):** mount folder navigation is implemented through
> `GET /api/mounts/{id}/entries`. Normal browsing sends `recursive=false`
> and the current mount-relative `path`; its first page supplies immediate
> folder names before the paged files. Search sends `recursive=true` with
> the same `path`, so matching stays within the current folder while
> including descendants. Folder, query, and recursive-mode changes always
> start without a cursor.

- Text query is sent to the adapter. Mount catalog search uses `/entries?q=...&path=...&recursive=true`; it searches all descendants of the current folder, never only the loaded page. Clearing search returns to the same folder with `recursive=false`.
- Kind is open vocabulary in browse mode. Filter options are derived from kinds observed or declared by the adapter; unknown future values render and remain selectable. Filtering is exact by full kind (`model/lora`), with optional family shortcuts (`model/*`, `media/*`) expanded by the adapter. Do not hard-code a permanent kind registry.
- A typed ASSET picker treats the widget's semantic kind as a fixed scope, not an editable initial filter: it sends that kind on every page, omits the `All kinds` escape, includes only matching homogeneous mounts, and probes heterogeneous mounts for matching content before exposing them as sources. An unambiguous image/audio/video MIME accept list supplies the corresponding `media/*` scope for older schemas that omitted it; model semantics are never inferred from names, paths, or extensions.
- The ASSET host intersects the widget's MIME `accept` metadata with its effective semantic kind. MIME controls byte compatibility; kind controls semantic intent. Rows missing enough metadata to prove compatibility remain hidden in pick mode but visible as `unknown` in browse mode.
- Breadcrumbs are the one folder-traversal mechanism: a root affordance plus clickable real path segments, nothing else. There is no separate back button; going up is clicking the parent crumb. Folder rows come from the first non-recursive `/entries` page and sort before its file rows; cursor pages contain files only.
- In tile mode, folders are first-class tiles sorted before assets, with a folder icon, name, and optional immediate child count only when supplied. Breadcrumbs provide upward navigation.

## Details and metadata

Hover is limited to a short tooltip (full name, kind, size, source/path). It must not fetch bytes or metadata and must not be the only way to access information.

Selecting a row populates the host's selection panel. The compact summary shows name, size, and an image preview with decoded resolution when available. A `Details` disclosure shows kind, media type, resolution when known, source, virtual path, and a middle-truncated digest. Federated entries retain their catalog availability, compatibility, provider, and requirement facts in the same disclosure. The full digest remains in the title and is copied by the adjacent Copy button.

For likely safetensors model kinds (`model/*` with a safetensors media type or filename), the rail offers `Inspect model metadata`. Only that explicit action calls `/api/assets/{digest}/metadata`. Show probe status and the backend's aggregate facts, at minimum tensor count and a dtype breakdown; show any additional returned fields defensively as labelled facts. A missing/unsupported probe is a local detail message, not a browser-wide failure. Cache a successful result by backend identity plus digest because digest bytes are immutable.

## Embedding configurations

| Surface | Mode and sources | Preset and behavior |
| --- | --- | --- |
| ASSET widget | `pick`, kind-scoped media mount entries or logical-model entries | Active tab backend only; fix the widget kind on source discovery and paging, intersect it with `accept`, stage an existing `AssetRef` on click/Enter, and commit through the editor footer. Keep upload as a host action beside the browser for non-model kinds, not an adapter, until uploads are enumerable. Model upload remains disabled. |
| Assets dock section | `browse`, mount entries | All mounts remain visible; ready mounts support folder navigation, search, and details. With a federated contract, `All assets` uses only that catalog; without one, it fans out over the per-mount adapters. |
| Library packs | `browse`, pack declarations nested from selected pack | Replace today's declaration-as-detail-lines with asset rows when a pack is expanded; no pick unless availability can produce an `AssetRef`. |
| Library templates | `browse`, template requirements nested from selected template | Preserve unresolved pack-local IDs as unavailable rows. Opening a template remains a template action, not an asset action. |
| Missing-assets consent dialog | `readonly`, one in-memory missing-requirements adapter | List default; show name, kind, size, status, and packaged-from/source provenance. Existing checkbox selection and `Acquire selected and retry` remain dialog-owned; browser row activation cannot acquire bytes. |

SAVE_TARGET should not embed `AssetBrowser`: it selects a writable destination, not existing content. A later `MountLocationPicker` can reuse the mount selector, breadcrumbs, lazy folder tree, and path formatting while committing `{mount, prefix}` and preserving the current unavailable-mount behavior.

## Explicit v1 exclusions

- Browser multi-select and bulk delete/tag/move. The consent dialog's existing digest checkboxes are separate host state, not AssetBrowser selection. Defer other bulk actions until authorization and partial-failure behavior are designed.
- Drag-out to canvas or drag-in upload. Defer until drop semantics across node inputs and backend affinity are defined.
- Upload-in-place inside folders. Keep the current explicit upload path; there is no upload-vault catalog or mount write API in this browser contract.
- Rename, move, delete, mount grant/revoke, and filesystem path display. These are management capabilities, not browsing defaults.
- Video playback, audio waveforms, generated model cover art, and client-side thumbnail generation.
- Cross-backend aggregation. The Assets section aggregates mounts only within its active backend; a digest on one backend does not prove availability on another.
- Automatic safetensors probing, automatic acquisition, or network requests to pack-declared remote URLs.

## Implementation plan and status

**Location.** Put `AssetBrowser.tsx`, item/source types, adapters, and focused helpers under `packages/app/src/asset-browser/`. It depends on app/client backend context and is not yet a generic core domain primitive. Keep the source-owned paging concepts aligned with `@dinkster/core`'s collection contract; extract a lower-level paging controller later only if both components can use it without asset-specific leakage.

**Breakdown.** `AssetBrowser` coordinates state; its toolbar, list/grid, folder navigation, and selection/details presentation render the surface. `mountAssetSource`, `packAssetSource`, `templateRequirementSource`, and `missingAssetSource` normalize transport rows. A `previewPolicy` decides whether digest bytes may be used as an image. A small versioned preference helper owns view persistence.

**Migration order.** ASSET migration is live: it proves the pick contract and mount adapter while preserving the existing upload fallback. Next migrate the landed consent dialog's row presentation without changing its checkbox/retry behavior. Then expose pack/template assets in Library. Build the full mount browser only after these establish useful actions. Do not rewrite unrelated Library sources merely to share markup.

**Tests.** Unit-test adapter normalization, compatibility intersection, open-vocabulary kinds, query/cursor reset, stale response handling, preview policy, metadata lazy loading/cache, and preference corruption fallback. Component tests cover shared selection across modes, keyboard behavior, folder navigation, details, readonly action suppression, and compact layout semantics. E2E tests intercept native backend routes for ASSET mount picking and verify the committed `AssetRef`; retain upload tests. Consent E2E coverage belongs with that feature. Accessibility checks cover roles, names, focus restoration, and keyboard-only picking. No broad suite is required for the proposal itself.
