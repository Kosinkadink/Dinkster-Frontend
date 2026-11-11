# Rework Queue

## Picker download-unavailable pane

- What and purpose: an unavailable-download heading, backend acquisition-contract explanation and disabled Download button appeared in missing imported-model and logical-model variant details. It attempted to explain why the picker could not download immediately.
- Why parked: downloading is offered by the pre-run approval dialog, not by the picker. The pane wrongly implied downloads could not work at all. Missing variants now say they are not on disk and explain when download is offered.
- Kept code: [draft-frontend-download-pane-before-removal-778](https://github.com/Kosinkadink/Dinkster-Frontend/tree/draft-frontend-download-pane-before-removal-778), commit `3171df30e133619cf7717848451135e0739b981e`. Paths: `packages/app/src/editors/AssetWidgetEditor.tsx`, `packages/app/src/asset-browser/rail.tsx`, `packages/app/src/WidgetEditor.tsx`, `packages/app/src/styles/widget-assets.css`, `packages/app/src/locales/{en,zh}.json`, `packages/app/test/LogicalModelCollection.dom.test.tsx`, `packages/e2e/tests/missing-model-ux.spec.ts`.
- Return conditions and hand test: only restore a picker download action if a real, supported backend acquisition contract makes it useful separately from run-time approval. Select a missing variant, verify truthful availability and usable selection, approve or reject a run-time download, and check Cancel, Undo and reopening. A disabled placeholder is not a reason to restore the pane.

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
`{"kind":"union","types":["INT","FLOAT","STRING","BOOLEAN"]}`
and the bogus comma atom no longer appears anywhere in the payload
(13 union occurrences total). Remaining optional follow-up: visually
spot-check union pin color/tooltip presentation on canvas during the
user's manual testing pass.

## ComfyUI-compat V3 dynamic/nested-dynamic type translation is broken end to end (AUDITED 2026-07-28, joint fix in flight)

- What it is: user-reported (2026-07-28, priority over Batch 14 launch) - the compat translation between ComfyUI and Dinkster is broken for many types, especially dynamic and nested dynamic types. Distinct from BOTH the fixed V1 MultiType comma bug (backend 66ad7b6, section above) and the LiteGraph workflow importer program (section below): this is the NODE SCHEMA path - backend runtime translation of ComfyUI V3 declarations into the native /api/nodes wire.
- Grounded three-way audit (backend compat code + frontend wire decoder + live :8765 catalog):
  1. ROOT CAUSE (backend): the runtime compat translator (Dinkster packages/dinkster-compat-comfy/translate.py) reads V1-serialized INPUT_TYPES and never recognizes the V3 structural markers, so MatchType/Autogrow/DynamicCombo/DynamicSlot inputs and outputs are emitted as fake opaque concrete atoms: `{"kind":"concrete","types":["comfy.COMFY_AUTOGROW_V3"|"comfy.COMFY_DYNAMICCOMBO_V3"|"comfy.COMFY_MATCHTYPE_V3"]}`. Live catalog: 25 of 542 comfy.* nodes affected (e.g. ComfySwitchNode, BatchImagesNode, ComfyMathExpression, ResizeImageMaskNode, GLSLShader, SaveAudioAdvanced). All DynamicCombo conditional inputs are dropped wholesale; MatchType input/output matching relations are lost; min=0 Autogrow families serve required:true; SaveAudioAdvanced also loses its declared Audio output (separate backend output-drop bug). The backend's separate `dinkster port` V3 translator handles MatchType/Autogrow/MultiType correctly but is not the live path, and refuses DynamicCombo/DynamicSlot.
  2. FRONTEND decoder capability (dinkster-wire.ts): decodes concrete/union/wildcard/variable/list/asset TypeExprs and roles input, inputFamily (single ordinary template member), dynamicSlot (typed variants, ordinary non-recursive dependents), output, outputFamily. NO native dynamicCombo role; NO recursive dynamic entries inside family templates or slot dependents. Unknown TypeExpr kind fails closed per node; unknown role skips the entry with `schema.dinkster.unknownRole`.
  3. Current frontend nesting coverage lives in `packages/core/test/dinkster-wire.golden.test.ts` and `packages/core/test/dynamic-commands.test.ts`: native schema decoding, recursive elaboration, and nested member/controller state do not depend on a stock schema parser.
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
  3. FIXED - Autogrow connections reconstruct schema-declared prefix and names vocabularies, including grouped forms, into persisted member state and resolvable member-qualified endpoints. Ordinary native prefix members mint `mN` identities in first input-slot appearance order; foreign numeric ordinals are recognition labels only, so sparse or out-of-order inputs never become sorting keys. Names families retain their declared names as identities. Reconstruction uses the ordinary registered schema and authored input slots, without alias snapshots, node replacement or helper insertion. Unmatched family-scoped wire names emit `import.dynamic.autogrowWireUnknown`; the importer omits the invalid link instead of leaving a misleading `solve.portMissing` result.
  4. FIXED - LiteGraph subgraph definitions retain definition and instance identity, boundary slots, promoted widget values, nested structure, and save/reopen behavior. Unresolved boundaries retain their authored structure and report `import.subgraphs.boundaryUnresolved`; a structural boundary that cannot be represented without losing an endpoint refuses the import with `import.subgraphs.boundaryUnsupported`.
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

- What and purpose: The right-rail "Control surfaces" panel creates mode panels bound to nodes/groups and applies bulk Active, Mute or Bypass changes as one undoable edit, without adding compute nodes.
- Why parked: The user wants these controls reworked before they return to main. The panel, `features.controlSurfaces.enabled`, `surface.{add,update,remove,mode.apply}` and `view.moveSurface` are removed, rather than hidden behind a setting. App View and ordinary node mode commands stay.
- Kept code: [draft-frontend-features-before-removal-776](https://github.com/Kosinkadink/Dinkster-Frontend/tree/draft-frontend-features-before-removal-776), commit `26d9be97f039c40f1e9fc97e566ac44b976b90be`. Main paths: `packages/app/src/{SurfacePanel.tsx,App.tsx,app-state.ts,styles/control-surfaces.css}`, `packages/core/src/{commands/surface-commands.ts,surfaces/contract.ts,surfaces/mode-panel.ts}`. Tests: `packages/core/test/surfaces.test.ts`, `packages/app/test/SurfacePanel.dom.test.tsx`, `packages/e2e/tests/surfaces.spec.ts` and control-surface cases in App View, dock/settings and product screenshots.
- Still active: Stored `surfaces`, `surfaceSeq` and `view.surfaces` round-trip without an editor. Binding decoding, group-id allocation floors and subgraph lifecycle handling remain to protect saved data during ordinary edits. Unknown surface/config/binding data stays intact. No command can create or apply a panel.
- Backend needed: None. This is document-owned frontend command/UI behavior; no node ids, editor roles, routes, server flags or backend draft branch are required.
- Return and hand test: Restore the panel, commands, registry and setting together after agreeing on the revised controls. Open a workflow with known and unknown bindings, add a panel, bind selected nodes and a group, apply each mode and Undo/Redo. Move a node outside the group and verify the next apply uses current membership. Verify pending/refused binding changes, save/reopen and unknown-data preservation, and confirm App View works independently.

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

## Mask paint applied to the graph

- What and purpose: "Apply mask to graph" creates or updates a mask-paint node and redirects the source image loader's mask consumers in one undoable edit. Unlike Bake to asset, it keeps a cumulative editable paint recipe in the workflow.
- Why parked: the backend no longer serves `dinkster.mask.paint` or the required `image-source` and `mask-paint` editor roles. The image editor, local paint tools and Bake to asset remain available.
- Kept code: [draft-frontend-features-before-removal-776](https://github.com/Kosinkadink/Dinkster-Frontend/tree/draft-frontend-features-before-removal-776), commit `26d9be97f039c40f1e9fc97e566ac44b976b90be`. Main paths: `packages/core/src/extensions/commands/mask-paint.ts`, `packages/core/src/mask-paint-recipe.ts`, `packages/app/src/{ImageEditor.tsx,image-editor.ts,app-state.ts}`. Tests: mask cases in `packages/core/test/image-commands.test.ts`, `packages/app/test/{image-editor.test.ts,editors.test.ts}`, and `packages/e2e/tests/image-mask-graph-live.spec.ts`.
- Backend needed: a served image loader with role `image-source`, an `image` asset input and IMAGE/MASK outputs; `dinkster.mask.paint` with role `mask-paint`, image asset `source`, multiline STRING `operations`, and MASK output. Asset upload/read routes must remain available. No feature-specific server start flag exists. Backend draft source is on [draft-nodes-before-first-party-packs-638](https://github.com/Kosinkadink/Dinkster/tree/draft-nodes-before-first-party-packs-638), recorded at `728f58b22ccf6bb64c7e2b8ee38f35c69fbf4a75`.
- Return and hand test: restore only this feature and serve its nodes through an installed pack. Load an image, connect its mask to two consumers, open the image editor, paint, and apply to graph. Verify one paint node replaces only the mask consumers, reopening edits that same recipe, and one Undo/Redo restores/reapplies the complete graph edit. Check stale source/topology refusal and Bake to asset separately.

## Layer-document graph export and opening

- What and purpose: "Export snapshot to graph" inserts load/flatten nodes for a published image document. "Open layers" opens a native layer output in the image document workspace. "Export editable recipe" branches layer-edit/flatten/save nodes from that output, retaining editable layer operations rather than only rendered pixels.
- Why parked: the layer-document node family and native `dinkster.layers` outputs are not served. The workspace's local layers, masks, drafts, Publish, Render and Open library remain available; the ordinary tensor `LAYERS` type is not a native image document.
- Kept code: [draft-frontend-features-before-removal-776](https://github.com/Kosinkadink/Dinkster-Frontend/tree/draft-frontend-features-before-removal-776), commit `26d9be97f039c40f1e9fc97e566ac44b976b90be`. Main paths: `packages/core/src/extensions/commands/image-document.ts`, `packages/app/src/{image-document-graph.ts,ImageDocumentWorkspace.tsx,App.tsx}`. Tests: `packages/app/test/image-document-recipe.test.ts`, graph cases in image-document persistence/workspace and core image-command tests, and `packages/e2e/tests/image-document-graph{,-live}.spec.ts`.
- Backend needed: served `dinkster.layers.load`, `dinkster.layers.edit`, `dinkster.layers.flatten` with roles `layers-load`, `layers-edit`, `layers-flatten`, and an image save node with role `image-save`. Restore against the served save id, not the kept fallback `dinkster.save_image`. The native `dinkster.layers` value must expose the canonical `application/vnd.dinkster.image-document+json` document rendition through `/api/values`; typed image-document upload, render, asset and library routes must also work. No feature-specific start flag exists. Related layer source is kept on backend [draft-nodes-before-first-party-packs-638](https://github.com/Kosinkadink/Dinkster/tree/draft-nodes-before-first-party-packs-638), recorded at `728f58b22ccf6bb64c7e2b8ee38f35c69fbf4a75`; serving/exporting the nodes still needs explicit implementation.
- Return and hand test: restore the three graph actions together. Export a two-layer workspace snapshot, run the resulting graph, open its native layers output, edit opacity and a mask, export an editable recipe and run again. Compare rendered pixels with the workspace, test Undo/Redo, save/reopen, and refuse stale graph/backend destinations. Never substitute a flattened preview for a native layer document.

## Audio envelope follow view in the curve editor

- What and purpose: a read-only curve view follows an executed audio envelope, shows computed points on a seconds axis, and follows only the playhead of the audio source that produced that envelope. Ordinary editable curves and histogram previews are separate features and remain available.
- Why parked: no backend pack serves `dinkster.audio.envelope` or editor role `audio-envelope`.
- Kept code: [draft-frontend-features-before-removal-776](https://github.com/Kosinkadink/Dinkster-Frontend/tree/draft-frontend-features-before-removal-776), commit `26d9be97f039c40f1e9fc97e566ac44b976b90be`. Main paths: `packages/app/src/{CurveEditor.tsx,app-state.ts,builtin-bindings.ts}`. Tests: envelope case in `packages/app/test/AudioTransport.dom.test.tsx` and envelope assertions in `packages/e2e/tests/audio-recording-live.spec.ts`.
- Backend needed: `dinkster.audio.envelope` with role `audio-envelope`, AUDIO input `audio` and CURVE output `curve`; a served role-`curve` editor with CURVE input `curve`; `/api/values` authoritative CURVE `curve-points` JSON rendition with a 4096-point bound and exact runtime provenance. AUDIO window/waveform renditions supply transport playback. No envelope start flag or matching backend draft implementation is known; the backend feature must be built, not assumed to exist on the draft branch.
- Return and hand test: record or load audio, connect it through the envelope to a curve editor, run, then open the curve. Check computed points, seconds positions and the matching playhead; unrelated audio must not move it. Apply stays disabled, inspection does not change the document, stale executions refuse, and an unconnected editable curve still uses its ordinary axis and Apply action.

## Video document editor

- What and purpose: a command-specific form edits OTIO-style video-document operations such as tracks, clips, trim, retime, transitions, audio mix and source binding, with an advanced JSON view. It is not the working video trim/crop widget or video preview.
- Why parked: no backend pack serves any `dinkster.video_document.*` node.
- Kept code: [draft-frontend-features-before-removal-776](https://github.com/Kosinkadink/Dinkster-Frontend/tree/draft-frontend-features-before-removal-776), commit `26d9be97f039c40f1e9fc97e566ac44b976b90be`. Main paths: `packages/app/src/{VideoDocumentEditor.tsx,WidgetEditorController.tsx,editors/ScalarWidgetEditor.tsx}`. Tests: `packages/app/test/VideoDocumentEditor.dom.test.tsx`, video-document cases in `ModalSurface.dom.test.tsx`, `packages/e2e/tests/video-document-editor.spec.ts`, and its product screenshot case.
- Backend needed: ordinary catalog schemas for `dinkster.video_document.{make,add_clip,add_track,set_effect,transition,retime,mix_audio,split,move,trim,ripple,roll,bind_source,import_otio}`, STRING operation parameters, document connections and VIDEO source input for source binding. The kept frontend routes by node-id prefix, not a dedicated editor role. Normal node catalog/job/value routes suffice; no special route, start flag or matching backend draft implementation is known. Define and serve the node contract before restoring the forms.
- Return and hand test: create a document, add video/audio tracks and clips, split/move/trim/retime, bind a real source, and run/export/import OTIO. Verify each form round-trips JSON, invalid fields refuse Apply, Cancel is unchanged, a connected video source is not duplicated in JSON, and the normal video trim/crop editor still works.

## Federated asset catalog

- What and purpose: combines asset candidates from configured providers with local and mounted assets, with provider/source facts, availability, compatibility and logical-model variants. It supplies an extra catalog source and candidate resolution in pickers; ordinary local/mount browsing and logical model selection remain available without it.
- Why parked: no shipped configuration enables both the frontend catalog paths and backend resolution-store policy. The feature cannot be reached in a normal build.
- Kept code: [draft-frontend-features-before-removal-776](https://github.com/Kosinkadink/Dinkster-Frontend/tree/draft-frontend-features-before-removal-776), commit `26d9be97f039c40f1e9fc97e566ac44b976b90be`. Main paths: `packages/client/src/federated-assets-v1.ts`, `packages/app/src/asset-browser/{federated-collection-source.ts,candidate-logical-model.ts}`, `packages/app/src/{main.tsx,AssetsBody.tsx,editors/AssetWidgetEditor.tsx}`, and `docs/federated-asset-dto-v1.md`. Tests: matching client/adapter unit files, injected-contract asset/modal cases, and federated portions of `audit-fedcat.spec.ts` and `audit-assets-surface.spec.ts`.
- Backend needed: POST `/api/catalog` and POST `/api/catalog/candidates` implementing the version-1 DTO contract. Current backend startup requires all of `--federated-assets-store PATH`, `--federated-assets-policy PATH`, and `--federated-assets-cursor-key PATH`; policy TOML has integer `version = 1` and a nonempty `scopes` table mapping scopes to provider-id arrays, including `local` without auth. The cursor key file contains at least 32 bytes. Populate the SQLite resolution store with provider records. Frontend builds previously required both `VITE_DINKSTER_FEDERATED_CATALOG_PATH=/api/catalog` and `VITE_DINKSTER_FEDERATED_CANDIDATES_PATH=/api/catalog/candidates`. No node id/editor role or backend draft branch is required: the backend routes already exist behind these flags.
- Return and hand test: configure a local provider and a second provider, restore the frontend contract and build paths, then browse/search/page the catalog and inspect provenance. Pick a compatible local variant; verify missing/incompatible/ambiguous candidates, auth failures and offline provider errors. Local/mounted assets must remain usable when the federated provider fails, and duplicate digests must not hide the selected variant's identity.

## Extension asset editor shell

- What and purpose: a root-only Host UI `asset-editor` contribution lets an extension describe an asset viewport, facts, Inspector/Editor tabs, field origins/capabilities, tool state and registered actions. It presents extension-owned state; it is not the ordinary builtin asset picker.
- Why parked: no builtin screen or shipped extension supplies this contribution, so the shell has no product user outside fixtures.
- Kept code: [draft-frontend-features-before-removal-776](https://github.com/Kosinkadink/Dinkster-Frontend/tree/draft-frontend-features-before-removal-776), commit `26d9be97f039c40f1e9fc97e566ac44b976b90be`. Main paths: `packages/app/src/{AssetEditorShell.tsx,host-ui.tsx}`, `packages/core/src/ui/contribution.ts`, shell styles in `packages/app/src/styles/canvas.css`, and the shell section of `docs/design-system.md`. Tests: shell cases in core `ui-contribution.test.ts`, app `host-ui.dom.test.tsx`, and `packages/e2e/tests/asset-editor-shell.spec.ts`.
- Backend needed: a pack with frontend extension content, served by `/api/extensions/snapshot` and `/packs/{pack_id}/static/{path}`, whose registered widget-editor provider returns a version-1 Host UI root of kind `asset-editor` with the kept presentation contract and registered action commands. No special node id, editor role or backend draft branch is required. For testing, start the server with `--pack PATH/TO/dinkster-pack.toml` for a pack that actually supplies this provider; the generic extension mechanism alone does not create an asset editor.
- Return and hand test: build one real extension using the shell, open its widget editor, and exercise viewport absent/loading/ready/error states, field validation, read-only reasons, both tabs and enabled/disabled/pending/failed actions. Check accessible labels/status, malformed contributions and wrong-surface refusal, and confirm generic extension panels/actions and the builtin picker are unchanged.
