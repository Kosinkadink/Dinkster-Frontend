# Rework Queue

## V1 MultiType comma-joined types reach the frontend as one bogus atom (FIXED, live-verified 2026-07-28)

User-observed 2026-07-28: a V1 ComfyUI input declared as a comma-joined
MultiType (e.g. Convert Number's "INT,FLOAT,STRING,BOOLEAN") arrived as
ONE opaque concrete type `comfy.INT,FLOAT,STRING,BOOLEAN` with a
hash-derived color instead of a union. Root cause was backend-owned:
`dinkster-compat-comfy/translate.py translate_type` had no comma branch,
while the V3 path (`translate_v3.py translate_v3_type`) already split
into a union / collapsed `*` to wildcard.

Fixed on Dinkster main at
`66ad7b6d918509104eb10549ec7ddb1762643caf` ("Fix V1 MultiType comma
translation") with exactly the V3 semantics (split/strip dropping empty
segments, `*` member collapses to wildcard, multi-member order-preserving
deduped union on inputs AND comma RETURN_TYPES, per-member opaque
registration, per-member GPU-residency detection). No wire bump; the
existing `{kind:'union'}` shape is used, so no frontend change was
needed.

Live-verified 2026-07-28 against the shared :8765 server (restarted at
backend `6fd8d1e`, which includes the fix): `/api/nodes` shows
`comfy.ComfyNumberConvert` (Convert Number) input `value` as
`{"kind":"union","types":["core.int","core.float","core.string","core.boolean"]}`
and the bogus comma atom no longer appears anywhere in the payload
(13 union occurrences total). Remaining optional follow-up: visually
spot-check union pin color/tooltip presentation on canvas during the
user's manual testing pass.

## ComfyUI-compat V3 dynamic/nested-dynamic type translation is broken end to end (AUDITED 2026-07-28, joint fix in flight)

- What it is: user-reported (2026-07-28, priority over Batch 14 launch) - the compat translation between ComfyUI and Dinkster is broken for many types, especially dynamic and nested dynamic types. Distinct from BOTH the fixed V1 MultiType comma bug (backend 66ad7b6, section above) and the LiteGraph workflow importer program (section below): this is the NODE SCHEMA path - backend runtime translation of ComfyUI V3 declarations into the native /api/nodes wire.
- Grounded three-way audit (backend compat code + frontend wire decoder + live :8765 catalog):
  1. ROOT CAUSE (backend): the runtime compat translator (Dinkster packages/dinkster-compat-comfy/translate.py) reads V1-serialized INPUT_TYPES and never recognizes the V3 structural markers, so MatchType/Autogrow/DynamicCombo/DynamicSlot inputs and outputs are emitted as fake opaque concrete atoms: `{"kind":"concrete","types":["comfy.COMFY_AUTOGROW_V3"|"comfy.COMFY_DYNAMICCOMBO_V3"|"comfy.COMFY_MATCHTYPE_V3"]}`. Live catalog: 25 of 542 comfy.* nodes affected (e.g. ComfySwitchNode, BatchImagesNode, ComfyMathExpression, ResizeImageMaskNode, GLSLShader, SaveAudioAdvanced). All DynamicCombo conditional inputs are dropped wholesale; MatchType input/output matching relations are lost; min=0 Autogrow families serve required:true; SaveAudioAdvanced also loses its declared Audio output (separate backend output-drop bug). The backend's separate `dinkster port` V3 translator handles MatchType/Autogrow/MultiType correctly but is not the live path, and refuses DynamicCombo/DynamicSlot.
  2. FRONTEND decoder capability (dinkster-wire.ts): decodes concrete/union/wildcard/variable/list/asset TypeExprs and roles input, inputFamily (single ordinary template member), dynamicSlot (typed variants, ordinary non-recursive dependents), output, outputFamily. NO native dynamicCombo role; NO recursive dynamic entries inside family templates or slot dependents. Unknown TypeExpr kind fails closed per node; unknown role skips the entry with `schema.dinkster.unknownRole`.
  3. FRONTEND model/elaboration are READY: elaborate.ts handles Autogrow, DynamicCombo, and DynamicSlot recursively (proven by the legacy /object_info parser's nesting test matrix in object-info.test.ts). The gap is purely that the native wire cannot carry the shapes. Nested Autogrow API names remain provisional pending the backend nested-naming contract (elaborate.ts ~595-610).
- Joint fix proposed to backend coordinator T-019f9e5d-d2e8-7173-8d6b-88a91bf66880 (message sent 2026-07-28):
  - PHASE 1, backend-only, no wire bump: MatchType inputs/outputs -> TypeExpr.variable (templateId + allowed); single-member prefix Autogrow -> inputFamily; fix required-ness of min=0 families; fix dropped outputs; untranslatable nodes refuse/degrade loudly instead of minting COMFY_*_V3 atoms (those poison documents with type ids that change identity when the real fix lands).
  - PHASE 2, joint wire bump 14 -> 15, contract must be co-pinned first: native dynamicCombo role (ordered options, recursive entries), recursive dynamic entries inside inputFamily templates and dynamicSlot dependents, named-Autogrow vocabulary (ordered fixed names), and the nested member naming contract (dot-scoped paths). Frontend work then: decoder for the new roles + recursive decode, golden tests mirroring the legacy nesting matrix, promise rows.
  - Explicit deferrals to mirror when backend ledgers them: V3 accept_all_inputs, lazy/rawLink semantics.
- Frontend follow-ups this unblocks/revives: nested controller command/execution advancement (deferred in slice 54, trigger arguably fires when nested dynamics arrive on the native wire); union pin wedge truncation at three members (minor UX, renderer.ts) - a four-member union like ComfyNumberConvert's shows only three wedges though label/compat are correct.
- Status: awaiting backend confirmation of phase 1 + counterproposal on phase 2 wire shape. Frontend decode work is BLOCKED on the phase 2 pin; do not start decoder changes before the contract lands in both ledgers.

## ComfyUI-compat import of dynamic constructs (DynamicCombo / Autogrow / subgraphs)

- What it is: The importer recursively decodes ComfyUI's DynamicCombo positional selector-then-active-branch stream, persists selected state and branch-local values under elaboration's shared path convention, and resumes following top-level widgets without shifting them. Dynamic constructs also retain their schema display name and tooltip.
- Findings, ranked:
  1. FIXED - DynamicCombo values no longer shift into later unrelated widgets. Real `ColorTransfer` with `widgets_values = ["reinhard_lab", "uniform", 0.75]` imports `method = "reinhard_lab"`, selects `source_stats = "uniform"`, imports `strength = 0.75`, and has zero excess values. Nested DynamicCombos recurse through the same decoder, including controller companion positions and stored modes. Controller editing and advancement resolve active elaborated value keys.
  2. PARTIAL - Top-level materialized Autogrow families with static template inputs decode positional and keyed widget values after reconstructing every authored member. A nested dynamic family template emits `import.dynamic.autogrowUnsupported`, stops the node's positional walk, and preserves every remaining value in `ext["importer.excessWidgetValues"]`; it never guess-assigns later positions after alignment is lost.
  3. FIXED - Autogrow connections reconstruct schema-declared prefix and names vocabularies, including grouped forms, into persisted member state and resolvable member-qualified endpoints. Ordinary native prefix members mint `mN` identities in first input-slot appearance order; foreign numeric ordinals are recognition labels only, so sparse or out-of-order inputs never become sorting keys. Maintained alias snapshots preserve their source suffixes and authored order so family replacement can copy them one-for-one. Names families retain their declared names as identities. Unmatched family-scoped wire names emit `import.dynamic.autogrowWireUnknown`; the importer omits the invalid link instead of leaving a misleading `solve.portMissing` result.
  4. FIXED - LiteGraph subgraph definitions retain definition and instance identity, boundary slots, promoted widget values, nested structure, and save/reopen behavior. Boundaries whose node schemas are unavailable retain their authored structure and report `import.subgraphs.boundaryUnresolved`; boundaries incompatible with available schemas and unrepresentable structural boundaries use explicit per-instance fallback.
  5. FIXED - `parseDynamic` copies `display_name` and `tooltip` for all three dynamic kinds (e.g. "Sampling Mode").
  6. MEDIUM (design decision) - Grouped Autogrow labels differ from ComfyUI: Dinkster shows `item0.image`, `item0.mask`; ComfyUI shows `image0`, `mask0`. Changing this touches native presentation (width, Problems references, boundary views) and needs UX signoff; compat-parsed families could carry presentation naming distinct from native semantics.
  7. NO DEFECT - ordinary static combos (bare arrays and labeled tuples) import correctly; the "combo" complaint means DynamicCombo.
- Remaining work: decide DynamicSlot foreign positional/connectivity semantics before decoding its dependents or treating it as an alignment boundary.
- Still active: DynamicCombo import, top-level widget order, node titles, static combos, and duplicate/geometry validation import correctly; unknown DynamicCombo selectors keep the schema default, emit `import.dynamic.unknownSelector`, and park the remaining tail instead of guessing.
- Promise ledger: `docs/promises.md` carries the matching partial row and exact proving tests.

## Cut

- What it is: Removing a graph selection while placing the same self-contained content on the clipboard.
- Design reference: `docs/clipboard-program.md` section 4. The safe first slice is node/reroute-only, dry-runs and captures the complete delete/modify closure, refuses any closure not exactly represented by the portable payload (including boundary-crossing links and cascading net/binding/dynamic changes), deletes the captured plan only after a successful OS clipboard write, and aborts on owner/revision/closure drift.
- Why deferred: Product questions remain on the supported Cut selection surface, whether a same-page fallback may authorize deletion, revision versus complete-closure concurrency, and whether boundary links should eventually become reconnectable stubs.
- Still active: Copy and paste are available through the system clipboard.

## Clipspace-like image/mask clipboard

- What it is: ComfyUI's separate image and mask clipboard workflow, commonly called clipspace.
- Research and design reference: `docs/clipboard-program.md` sections 1-3. ComfyUI clipspace is volatile widget/image-reference state, not a durable mask format; Dinkster should use a separate typed media envelope over durable AssetRefs and route editing through EditorRegistry and ordinary document commands.
- Why deferred: Product decisions remain on shelf versus one-item clipboard, transient-preview materialization, incompatible paste targets, multi-image behavior, trusted backend identity/target-presence checks, and cross-backend byte transfer. The layered form also waits for the image/mask editor design.
- Still active: The graph clipboard copies nodes and self-contained topology only; it does not claim image or mask clipboard data.

## Named nets

- What it is: Named get/set-style hyperedges with labeled noodles and authorable Set/Get endpoint views.
- Rework shipped: Every existing net projects one movable Set view and one movable Get view per sink. Advisory per-definition geometry survives save/reopen, and view deletion uses the existing net commands.
- Enabled by default: Creation and management menus and the create/rename prompt ship on for fresh installations. `features.namedNets.enabled` remains as an escape hatch; setting it to `false` hides the authoring menus again.
- Still active: Existing net data loads, renders, and compiles normally. The data model, `net.*` commands, and focused tests remain intact.

## Control surfaces (mode panels)

- What it is: The right-rail "Control surfaces" panel - mode panels that bind nodes/groups and fire bulk active/mute/bypass changes; the sanctioned form of rgthree's Fast Muter / Fast Groups Muter (architecture section 6, SurfacePanel.tsx).
- Why deferred: Same rgthree-like control family as the seed controller; the user wants these reworked together after feedback, and hidden so they are not mistaken for something else.
- Disabled: The panel is not rendered by default, gated by `features.controlSurfaces.enabled`.
- Still active: Surface data serializes with the workflow and loads intact; `surface.*` commands remain registered; core and E2E tests remain (the E2E suite enables the flag).
- Re-enable: Set `features.controlSurfaces.enabled` to `true` in Settings.

## E2E backend-serial two-lane split (dev tooling)

- What it is: Splitting the `backend-serial` Playwright project into two concurrent serial lanes: the V1 `:8199` execution writers (one shared queue/history) and the native `:8765` writers (library/uploads/run-history) touch disjoint server state, so each lane could run with 1 worker in parallel with the other. Would cut the full-suite wall time from ~5.8 min to roughly 4 min (the 2026-07-27 parallelization already took it from 10.6 min; see `packages/e2e/playwright.config.ts` and README "E2E smoke tests").
- Why deferred: User accepted the current 1.8x speedup as sufficient for now, and the timing-budget specs (`perf.spec.ts`) flake under CPU contention, so they would need isolation from both lanes - extra care for a modest further gain.
- Still active: The two-project split (parallel-safe at 10 workers, backend-serial at 1) is in place and green; `test:e2e:serial` remains the trustworthy all-serial fallback.
- Revive when: E2E wall time becomes a bottleneck again, or the backend-serial spec count grows enough that 3.7 min serial dominates further.

## Early dependency-cycle feedback

- What it is: Surfacing a dependency-cycle diagnostic at (or soon after) the connection that creates the cycle, instead of only at workflow submit. ComfyUI also allows wiring cycles and reports "Dependency Cycle detected" at submit; Dinkster currently matches that (the error is reported correctly on submit).
- Why deferred: User assessed the submit-time error as sufficient (2026-07-27); immediate detection needs an incremental cycle check on every link.connect that must not regress large-graph interaction performance.
- Still active: Cycles are detected and reported with the offending nodes at submit time.
- Revive when: Users report confusion from late cycle errors, or an incremental topological-order structure lands in core for other reasons (making the per-connect check cheap).

## 2026-07-28 user UX batch (batch 15: chrome IA, hover affordances, memory viz)

User-requested (verbatim intent, ledger rows slice 61-63):

- Draggable shell edges visibly thicker than non-draggable edges.
- Top rail toggles ordered left bar, bottom bar, right bar, with
  Customize Layout in front; active state stops being a blue highlight -
  the expanded region of the panel icon fills white instead.
- Hover behavior everywhere: shell chrome, hover bar, node slots
  (ComfyUI-style slight enlargement of the circle/diamond), widgets
  (subtle conventional highlight).
- Settings button needs a coherent new home (decision: bottom of the
  left activity rail, VSCode-style). Dedicated App-mode and Data-lens
  buttons by Queue removed; functionality folds into the per-tab
  lens/view menu.
- Left rail icons ~2x current size.
- Search Dinkster geometrically centered regardless of topbar side content
  (3-column grid, not flex spacers).
- Memory panel redesigned; current design judged very poor. Reference:
  kijai/ComfyUI-MemoryVisualization (aimdo viewer). Target visual
  grammar from that extension: per-device 8px stacked usage bars with
  byte legends; ~1 sample/sec time-series canvas graph (stacked area,
  dashed capacity line, hover crosshair, bounded ring buffer);
  per-consumer rows with 10px stacked residency bars; page-level
  residency heatmap as a wrapping canvas grid of ~6x6px cells (warm
  pulse on page-in, red fade on page-out, count/byte summary below);
  controls (budget/headroom sliders live, aimdo-policy restart-noted)
  ALWAYS visible inline, with a loud named-grant message when
  read-only. Fault/evict/stall history counters remain deferred - no
  backend contract exists; do not fabricate.
