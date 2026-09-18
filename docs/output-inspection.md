# Output inspection

The Outputs rail inspects the execution selected by the existing live,
pinned, or frozen execution binding. It does not select executions or invent
artifact authority. Every media URL is resolved through that execution's
backend by `viewUrlForExecution` or `assetUrlForExecution`, including retained
routes for a removed owner.

Each output card preserves inventory order and shows the backend and execution
identity, runtime node, output ID, one-based descriptor position, legacy-file
or content-addressed source, image kind, media type, complete name or digest,
and observed browser availability. Complete identifiers wrap; they are not
replaced by ordinals, thumbnails, dots, or color.

Recorded native values also offer [typed media inspection](media-inspection.md)
through the execution owner's values API. Nonblocking alpha and mask warnings
name their runtime node and affected ports. Metadata reads do not download media.

The rail distinguishes no selected execution, queued/running output wait,
completed-output loading, completed empty output, execution failure, removed
owner, checking media, available media, and unavailable media. A removed owner
does not suppress retained output URLs, so an item can truthfully show both
owner removal and successful media availability.

Opening a card or the canvas output pager uses the same read-only modal. Single
mode retains previous/next and Arrow-key paging plus fit, 100%, and 25%-400%
zoom. Grid mode shows the selected item with `aria-pressed` and visible text.
Escape, Close, and backdrop dismissal restore the rail card or canvas pager
focus. Inventory replacement closes a stale viewer; a shrinking inventory
clamps its selected index. Narrow and browser CSS-zoom layouts keep the media
and a separately scrollable identity tail inside the modal.

Recorded media previews in nodes and App View can be downloaded with the
backend artifact name or a rendition-derived filename. Outputs cannot be
edited, deleted, reordered, ranked, or persisted from these surfaces. Assets
browsing, acquisition, backend DTOs, execution selection, and generic
collection behavior remain separate owners.

Focused coverage lives in `packages/app/test/executed-image-inventory.test.ts`,
`packages/app/test/ExecutedImageViewer.dom.test.tsx`, and
`packages/app/test/node-output-pager.dom.test.tsx`. The isolated Chromium proof
in `packages/e2e/tests/assets-output-preview.spec.ts` covers lifecycle states,
long identities, unavailable media, owner removal, focus, replacement and
shrink behavior, narrow layout, reduced motion, and 200% CSS zoom.
