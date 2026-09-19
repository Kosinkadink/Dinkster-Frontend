# Frontend deferral inventory - 2026-07-29 tri-program sync

Compiled 2026-07-29 by the frontend coordinator for the user-directed
tri-program sync (backend coordinator thread
T-019f9e5d-d2e8-7173-8d6b-88a91bf66880; consolidated snapshot at Dinkster
docs/research/tri-program-inventory-2026-07-29.md, commit 5aae5db).
Sources: the former `docs/promises.md` and `docs/feature-coverage-audit.md` as
of main `942930b`. The promise file was later removed; this document remains a
dated historical snapshot, not a current index. Current implementation status
lives in `docs/feature-coverage-audit.md`, and deferred work lives in GitHub
issues.

## Corrections applied during the sync

Two items were reported to the backend as "blocked on backend" but had
already shipped; the stale rows were fixed in the same commit as this
file:

- Mount folder navigation: folder-scoped `GET /api/mounts/{id}/entries`
  shipped backend f95be58 and the frontend restore landed 2026-07-28
  (implemented both sides). A stale embedded deferral note in the AP10
  ownership row was corrected.
- Mid-graph tensor previews: the comfy.IMAGE png rendition provider
  shipped backend-side 2026-07-23; the deferral trigger fired in this
  sync. Row flipped deferred -> promised (unblocked); remaining work is
  a live-validation slice.
- Scalar-merge-arm binding relaxation: NOT blocked - the final matrix
  was announced and the frontend gate already flipped 2026-07-28
  (Dinkster 9b38d55; live-validated against :8765). Remaining caveat is
  fixture-only proof of the widget-editor scalar arm until the first
  scalar-T AssetWidget node migration lands backend-side.

## A. Deferred (with revival triggers)

- Cut (graph clipboard): safe v1 copies/deletes only. Revive after
  decisions on selection surface, fallback authority, concurrency
  granularity, and boundary stubs.
- Clipspace-like image/mask clipboard: separate typed media clipboard
  over durable AssetRefs. Revive after media-clipboard product
  decisions and the image/mask-editor design.
- ComfyUI-to-Dinkster node paste: blocked by PrimitiveNode, Set/Get,
  notes, native reroutes, dynamics, and subgraphs. Revive as those
  fragment representations land.
- Zoom-dependent LoD rendering: measured within budget at current
  scale. Revive when preview-heavy frame times exceed budget or
  markedly larger backend renditions land.
- Shared drag-reorder primitive: tabs and AppView use incompatible
  gesture models. Revive with a third reorder surface or AppView
  pointer-owned live reordering.
- Movable surfaces to floating/window hosts: hosting unimplemented.
  Revive with the desktop-shell slice.
- Persisted backend protocol re-discovery: stored protocol is a
  last-known hint only. Revive on a real protocol-migration report or
  fleet/mixed-version work.
- Dev-proxy segment-boundary matching: revive if an SPA route ever
  starts with `/api` or `/supervisor`.
- Runtime-settings full-shell placement proof: revive with the next
  Backends-panel component/E2E harness.
- Full instance-side conditional branch materialization:
  occurrence-local branch links/members unrepresentable. Revive on a
  user-requested design explainer, then a document-model/edit-routing/
  compile-equivalence design pass.
- Wire-15 bypass/mute lowering: conservative
  `compile.wire15.modesUnsupported` gate remains. Revive only through
  the dedicated Option A structural-interface-stratified routing design
  slice and removal plan (user-approved direction; unstarted).
- Schema-wire clean-slate reset: revive only on explicit user
  direction, at latest before a real third-party consumer.
- Tab docking / split-canvas multi-view: revive after the rest of the
  frontend design settles, then a dedicated docking design pass.

## B. Promised, unstarted

- Subgraph lifecycle L2-L7 (L1 in flight as slice 81); sequential, then
  Regions R2.
- Mid-graph tensor previews live-validation slice (unblocked this
  sync; see corrections).
- Asset editors open from anywhere (editor projection); revives with
  the first asset-editor surface.
- Station groups; planned after connection-model foundation slices.
- One frontend/backend protocol; enforced by review as surfaces begin.
- Frontend extension program F0-F6; F0 snapshot loader/transactional
  world is unblocked now that backend S0-A/S0-B/S1/S2 landed.

## C. Partial (missing half)

- LiteGraph dynamic import: Autogrow member allocation/link
  rewriting/grouped naming, DynamicSlot alignment, nested controller
  advancement, LG subgraph definitions missing.
- Shared multiplayer DocumentSession: production transport adoption
  and collaboration UX remain.
- Collaboration-readiness invariants: shared-session transport
  adoption remains.
- Cross-instance graph paste: missing-definition handling,
  definition-ID collision safety, asset acquisition remain.
- Tabs: complete new -> dirty -> close -> cancel/discard flow untested.
- Blueprint insertion ownership: CanvasHost wiring tests await an E2E
  blueprint-shipping pack.
- Canvas ephemeral ownership: controller-menu routing, shortcut
  scoping, gesture disposal need multi-tab E2E.
- Scene geometry/identity audit: painted-pixel fidelity and widget
  behavior coverage remain.
- CanvasHost decomposition: orchestration and remaining surface-sized
  responsibilities retained.
- Editor surfaces as projections: broader open-with flows and split
  EditorGroups remain.
- Exposed parameters + App view: ASSET read-only until the first
  asset-editor surface.
- SurfaceContext/ModalHost: body requestClose, floating/window hosts,
  topmost independent-dialog coordination remain.
- Run-history no-op grouping: cross-page merging and causal
  post-persistence invalidation remain.
- Stateless ingress/event cursors: frontend cursor replay/resync
  consumption remains (backend half landed).
- Global jobRef/attemptId: frontend identity adoption remains (backend
  half landed); cross-terminal idempotency stays deferred.
- Auth/RBAC execution context: frontend token UX, 401/403 handling,
  per-reconnect WS ticket minting, scope-aware submission absent
  (backend contracts landed).
- Loop/repetition regions: R2 authoring/canvas, R3 lowering/live
  submission, R4 execution feedback remain (R1/R1.5 landed).
- Typed assets: no live list-outer multi-select proof; widget-editor
  scalar arm fixture-only until a scalar-T AssetWidget node migration.

## D. Remaining scope inside implemented rows

- Backend error-body `hints` UI: revive when the backend ships hints
  (backend has a ROADMAP row; contract announcement promised).
- Per-device fault/offload telemetry counters: revive when the backend
  defines the contract (now ledgered backend-side as a joint design
  with the inference thread).
- Runtime settings: dedicated fp8-matmul boolean editing on request or
  with the next settings-editor slice.
- Dormant stored-value strike-through: visual tuning only.
- Typed-literal lowering: refused writes do not clear lower-precedence
  staged values; revive only if partial prompts can ever surface.
- Wire-15 document materialization/lowering: canvas/UI affordances and
  editors, and native free-suffix materialization, remain explicitly
  out of the landed core scope.

## E. Feature-coverage-audit functional gaps (beyond the above)

- Union/MultiType, wildcard `*`, MatchType, list TypeExpr: V1 prompt
  lowering is type-erased/advisory; union editing and nested
  `U = list<V>` inexpressible in the flat solver domain.
- Lazy inputs: copied, not interpreted; no scheduling emulation.
- Hidden inputs: not boundary-forwardable by design.
- Optional inputs/outputs: compile treatment warning-only/advisory.
- Named nets and reroutes: boundary topology parent-graph-only;
  execution events lose net/reroute identity (they compile away).
- Unknown/custom dynamic kinds: compile and boundary derivation fail
  closed; browser/execution support absent.
- Conditional boundaries: member-scoped forwarded-selector edit
  routing deferred. DynamicSlot direct boundary forwarding rejected
  pending an occurrence-local design.
- Grouped Autogrow: grouped API paths provisional.
- Legacy OutputSpec.isList: metadata, not full solver semantics.
- Value sources: boundary derivation binds inner ports, not
  value-source nodes; BOOLEAN/COMBO/ASSET source editors uncovered.

## F. Soft/silent items (documented but easy to miss)

- Authored-but-never-run suites: universal-search E2E, selection
  toolbox browser specs, noodle-presence E2E, shell-layout runs,
  canvas overlapping-selection assertions, memory-panel E2E.
- CLOSED: keybinding modifier-only capture was already pending correctly;
  component chord/conflict/reset proof now prevents the stale ctrl+control
  report from returning.
- SurfacePanel disabled by default pending rework; no component
  coverage.
- Group-extraction product question (lifecycle open question 2):
  design default chosen; USER APPROVED 2026-07-29 (snapshotted spatial
  contents, with explicit preview/action disclosure). Closed.
- Long tail of widget/panel test coverage gaps recorded per-item in
  docs/feature-coverage-audit.md (FLOAT clamp, combo dropdown
  keyboard/empty options, raw-widget JSON commits, numeric COMBO options,
  etc.). BoundaryPanel accessibility and settings reset-to-default are closed.
