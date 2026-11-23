# Asset picker and library constraints

The ASSET widget picker, node-input preview, and executed-output preview are
separate from the global Assets side panel and library. Validation of one
surface does not establish correctness of the others.

The standing user requirements live in
[asset-picker-requirements.md](asset-picker-requirements.md). Dialog behavior
is specified in [widget-editors.md](widget-editors.md), model identity in
[logical-model-variants.md](logical-model-variants.md), and acquisition consent
in [assets-consent.md](assets-consent.md).

## Picker and node previews

- Populated, sparse, empty, loading, error, and overflow layouts must keep the
  collection primary, with readable titles, reachable final items, and footer
  actions separated from content. Grid and list modes must both remain usable.
- A selected-image preview must leave browse content usable on short viewports,
  including at least one complete grid card with collection-owned scrolling.
- All assets, Imported, and Generated must reflect their source contracts.
  Folder navigation, recursive search, paging, and keyboard selection must not
  submit jobs, acquire bytes, or mutate the document merely by browsing.
- Selection binds a complete five-field AssetRef. Its bytes and metadata must
  survive upload, export, reopen, and execution without partial references or
  silent corruption.
- Selecting an image must update its bounded in-node preview; reload must
  preserve the selection, clear must remove it, and unavailable bytes must not
  leave stale pixels or stale accessibility state.
- Executed-image inventory must retain output order across the thumbnail grid,
  viewer, and pageable canvas preview. Preserve dimensions, unavailable states,
  low-zoom simplification, focus restoration, new-execution reset, and paging
  bounds when the inventory shrinks. Preview navigation does not edit the graph.
- A primary backdrop press on another exposed ASSET widget must target that
  widget without replaying an untrusted event or changing document revision.

## Global library

- Keep a height-contained collection viewport, a visible scrollbar, a reachable
  final row/path, and footer actions outside the scrolled content.
- Load more must not obscure list content. Empty, error, and loading states must
  remain legible.
- Preserve curated navigation, human titles, provenance, per-mount browsing,
  federated All assets, and catalog paging.

## Backend authority

Group model candidates by logical identity while retaining concrete variant and
digest facts. An explicit local choice binds the exact AssetRef; logical grouping
must not fabricate or rewrite it. Recommendation policy and non-local acquisition
require authoritative backend contracts, not frontend inference.

Catalog and candidate browsing are read-only. Transfer requires backend-owned
policy, integrity verification, atomic publication, progress, retry, and
credential semantics. Verified local asset reads must not become remote
thumbnail workarounds; remote thumbnails need their own route, authorization,
cache, and error contract.
