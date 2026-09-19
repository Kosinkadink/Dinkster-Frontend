# Widget parity and delivery accountability matrix (audit)

Parent: integrator delivery 98378128-11c6-4624-9f1b-357573faaeae
(topic dinkster-frontend/widget-parity-and-delivery-accountability-batch r1,
integrator T-019fc4cd-079c-7749-bfc3-c79013ec876e, adjudicating audit).
Frontend coordinator and sole itemized-closure owner:
T-019fda1e-775f-72cb-ab0b-677dbb7b2fb0.

Provenance ruling preserved verbatim in intent: audit r1 (slider opt-in,
rapid INT seed stepping, multiline typography/scrollbar) was lost to lossy
topic amendment - r2/r3 narrowed the topic to hover geometry and resolving
r3 closed the topic without independent ownership of the r1 rows. This is
an accounting failure, not a proven source regression. This matrix restores
every lost row plus the current audit demands as independently closable
rows. The parent is NOT closable while any row is merely summarized,
delegated, queued, or omitted; every row ends COMPLETE, BLOCKED (with owner
and trigger), or NOT STARTED, and row J requires a final combined
served-app proof.

## Preserved visual evidence (exact media identities)

| Media ID | Filename | SHA-256 | Shows |
|---|---|---|---|
| ba5f7aaf-baa3-40b4-aaa9-81c67c2a07a5 | chrome_lFmPlkIqJn.png | d6d8611110952d026f8ff4d3f352f6af8897f6cfb899550878d4b93a175217d7 | Dinkster KSampler: steps/cfg/denoise range fills start right of the label zone (steps a sliver); seed lock chip and `+` nearly touch; combo carets at right edge |
| 7647cd0f-ae10-4493-9de2-10fac77b4c62 | chrome_JxTx3F51fx.png | 35c0e9308b955f33e76f40512b0a010249df5b45d28a304425295266aa810f88 | Dinkster Apply ControlNet: same post-label fill origin for strength/start_percent/end_percent |
| 17f6a323-80d2-4854-b653-a10400191cb5 | chrome_qaoU4c6i2j.png | 9b7a709fce7a8baf0eee07f6e05b02428a04d0e8c30c672dd7b8bd3d165f705e | Dinkster multiline idle/hover: overflowing painted content with NO scrollbar; hover tooltip overlaps content |
| 9f94f3c0-7250-4fbe-8dca-aabc926fd628 | chrome_aT1xaZJpRj.png | b8af44b6bc826e2fb54e5b6b2aef7509532e26be725b49a904ab97b0e3a39065 | Dinkster multiline focused editor: right scrollbar only in focus, starting below the top label/content edge; right-side text geometry differs from painted view |

Coordinator visual confirmation 2026-08-08: the fills in ba5f7aaf/7647cd0f
start at the registry painter's contentStart (post-label content zone,
registry-painter.ts numericRangeFill role clipped to contentStart/
contentWidth) rather than the chrome's left edge; this is consistent with
the audit I3 as-designed content-zone fill and is exactly what rows A/E
re-adjudicate against declared-slider presentation.

## Row status board

| Row | Title | Status | Owner/delegate | Closure identity |
|---|---|---|---|---|
| A | Numeric slider opt-in wire path | COMPLETE (deployed live 2026-08-08: backend :8765 at exact f93d78a serves default v18; frontend :5199 serves main 47a8d88 containing f2d8215) | backend T-019fdb99 (contract) + coordinator (frontend adoption) | frontend f2d8215 + backend f93d78a; deployment record in Row J closure below |
| B | Rapid KSampler seed +/- correctness | COMPLETE | W1-B | public aab455b |
| C | Multiline typography parity (audit) | COMPLETE | W1-CH | public 6fd5749 |
| D | Hover/chrome geometry | COMPLETE (record-only) | coordinator | public 8995107 |
| E | Explicit slider presentation (whole-bar track/fill) | COMPLETE (public f2d8215; whole-bar proof re-run green 2026-08-08 via checked-in isolated config; live catalog declares zero display:slider inputs, recorded truthfully in Row J closure) | W2-AE | frontend public f2d8215 |
| F | Exhaustive latest-ComfyUI widget inventory | COMPLETE 2026-08-11 (terminal reconciliation and served-app proof in Continuation) | coordinator | public source/tests plus packages/e2e/tests/audit-widget-parity-live.spec.ts |
| G | Shared trailing-action layout primitive | COMPLETE | W2-G | public 51a1ce2 |
| H | Multiline polish (label gap, scrollbar, gutter) | COMPLETE | W1-CH | public 6fd5749 |
| I | Multiline extension capability | COMPLETE (I1 public 5bf6384; conditional I2 has an explicit backend-catalog trigger and does not gate the row) | coordinator | source/tests recorded in detailed row I |
| J | Final combined served-app acceptance | COMPLETE 2026-08-11 (tranche-1 remains valid; terminal continuation proof covers adopted wire 19-22 surfaces) | coordinator | packages/e2e/tests/rowj-live.spec.ts + packages/e2e/tests/audit-widget-parity-live.spec.ts |

## Rows

Each row carries: provenance/user demand; owner; source diagnosis and
pinned references; public implementation commit or explicit
blocker/non-goal; focused tests; independent review; deployment identity;
browser/live evidence; user-visible status.

### A. Numeric slider opt-in

- Provenance: audit r1 (lost row, restored); audit/audit A.
- Demand: verify the latest ComfyUI schema/catalog -> Dinkster backend wire ->
  frontend decode path for slider display declaration. NEVER infer slider
  presentation solely from min/max bounds. If the declaration exists and is
  dropped frontend-side, implement the frontend-local correction; if the
  backend wire lacks the field, return the exact missing field/contract to
  the backend owner with the integrator copied.
- Owner: backend T-019fdb99-2732-71ff-a7db-4f6f3c0c944e (wire contract) +
  coordinator (coordinated frontend adoption slice).
- Source diagnosis (W1-AUDIT, 2026-08-08, full trace with file/line pins in
  docs/widget-inventory-audit.md): the slider declaration is MISSING FROM
  THE DINKSTER WIRE - a backend-side loss, not a dropped frontend field.
  ComfyUI declares numeric display intent separately from bounds (legacy
  display:'slider'|'number'|'knob'|'gradientslider'; V3 NumberDisplay via
  display_mode). Dinkster's compat translators drop it (_number_widget reads
  only min/max/step/control_after_generate; V3 direct path builds no
  numeric widgets at all), the NumberWidget model/wire has no display
  field, and the frontend strict NUMBER decoder rejects unknown keys - so
  the fix must land as one coordinated wire bump. Meanwhile the frontend's
  numericRangeFill infers fill from any finite min/max pair (kinds.ts:
  317-358), which is exactly the bounds inference row A forbids.
- Blocker: exact missing backend field is an additive optional NUMBER
  descriptor field `display` in {number,slider,knob,gradientslider}
  (proposed contract wording in docs/widget-inventory-audit.md). Routed
  to backend owner with integrator copied on 2026-08-08.
- CONTRACT CONCURRED 2026-08-08: backend T-019fdb99 replied CONCUR with the
  wording exactly as proposed, plus pinned wire mechanics (recorded in full
  in docs/widget-inventory-audit.md): schema wire bumps 17 -> 18;
  SCHEMA_WIRE_VERSION = 18, SCHEMA_WIRE_SERVE_VERSIONS = (17, 18),
  historical decoder window (16, 17, 18). Wire 18 strictly accepts the
  closed `display` key/vocabulary; wire 17 stays frozen and never receives
  the key. v17 downlevel encoding drops `display` - when display is the
  NumberWidget's ONLY metadata the whole NUMBER descriptor is omitted
  (ordinary-editor fallback); otherwise v17 keeps exactly the old fields.
  `/api/nodes?wire=18,17` selects 18; a 17-only client keeps strict v17;
  absent ?wire= selects 18. `display` is presentation-only, excluded from
  execution/schema-signature/cache semantics; explicit `display:"number"`
  is preserved, not canonicalized away; no V3 knob synthesis; unknown
  source display values are not reinterpreted. Backend/frontend PROMISES
  rows move together, and the standing shared server must NOT advance to
  wire 18 until the accepting frontend slice is ready.
- Frontend adoption slice (ready to schedule on trigger): add wire-18
  decode/goldens and advertise `?wire=18,17` in the client; admit/copy
  `display` in packages/core/src/schema/dinkster-wire.ts; gate
  numericRangeFill on declared display in packages/widgets/src/kinds.ts;
  row E keys on spec.options['display'] === 'slider', never bounds.
  Promise row added to docs/promises.md (same commit as this record).
- Frontend proposed implementation field (W2-AE): wire 18 accepts `display`
  only on NUMBER and preserves all four closed values in WidgetSpec options;
  a malformed value drops that field alone with
  `schema.dinkster.badNumberDisplay`, while an unknown key rejects the schema.
  Wire 17 remains strict and rejects `display`. The client advertises 18 with
  17 fallback. Source and browser proof are held for coordinated joint
  publish; no standing service or deployed default changed. The held source
  intentionally changes its advertisement to include 18.
- BACKEND COMMISSIONED 2026-08-08: backend owner T-019fdb99 reconfirmed the
  contract and commissioned its wire-18 slice - commission public at Dinkster
  294fa5d1688fdb12c8e0de4544cc12726431f6fb, backend delegate
  T-019fe2e2-d535-7022-b6a3-4c8672189ea1 pinned in
  5fdda3b39f4d533baf1805460f150d7e7027eb5d on exact backend source baseline
  89dfa387857bd049880b16f74c1f89f6b73c9d68. Activation protocol REVISED by
  backend: BOTH slices are built in parallel and held unpublished; the
  backend feature source stays unpushed until review AND frontend
  readiness; the trigger is "reviewed backend v18 feature commit plus
  reviewed frontend accepting decoder/goldens both ready", then both
  sources publish together, and only afterward may default no-query v18
  deployment advance. No shared service/default negotiation advances
  alone. F2/F3/F4/F5-F10 stay separate from this presentation slice.
- Status: COMPLETE 2026-08-11. The historical adoption record below begins
  with the W2-AE commission; terminal deployment is reconciled in Row J and
  the Continuation served-app proof.
- Historical adoption record: frontend adoption slice W2-AE was commissioned
  in the delegation ledger under the joint-publish gate above.
  2026-08-08 coordinator review: W2-AE delegate commit 340452fb (branch
  feat/audit-ae-display, parent 09dc45aa, local-only) independently
  REVIEWED/APPROVED - diff inspected (display admitted only under strict
  wire 18; <=17 rejects the key loudly per node; invalid display VALUE
  drops with schema.dinkster.badNumberDisplay; fill gated exclusively on
  display==='slider' with independent usable-bounds checks in both widget
  view and painter), gates independently rerun green (typecheck 6/6, core
  2344, widgets 124, canvas 808, client 297+3 skipped, app 1032 unit +
  188 component), and Chromium proof media inspected (whole-chrome fill
  independent of label; bounded-no-display renders ordinary row). Held
  unpublished on coordinator branch feat/audit-ae-display pending the
  reviewed backend v18 commit; frontend readiness trigger reported to
  backend T-019fdb99. 2026-08-08 JOINT PUBLISH: backend review APPROVED at
  a784576a (tree 0f88c178, parent 89dfa387; supersedes unpushed fc9c6f3,
  adds nested WidgetRepresentations v17 downgrade preservation) and issued
  GO; frontend 340452fb cherry-picked onto main (patch-identical, docs
  context drift only, authorship preserved) and published as f2d8215
  after full merged-tree gates rerun green (typecheck 6/6, core 2344,
  widgets 124, canvas 808, client 297+3s, app 1032+188, vite build).
  Backend is replaying its reviewed patch onto Dinkster origin/main.
  Default no-query v18 deployment remains UNAUTHORIZED until both public
  SHAs are confirmed and a separate deployment step is sequenced.
  V19 ordering concurred by backend: after v18 source/ledger closure, one
  coordinated bundle F2+F3b+F5+F9+F4 (F4 schema-significant,
  absent-vs-false preserved); nothing widens v18.
  2026-08-08 JOINT SOURCE PUBLICATION COMPLETE: backend public on Dinkster
  origin/main as f93d78a033ee4a275c910c6dea8986588dbaa201 (tree a0721711,
  parent bbeca5c2; stable patch id 0849e85a exactly matches reviewed
  a784576a; replay gates green per backend). Frontend public f2d8215.
  Coordinator verified both origin/main refs directly (Dinkster-Frontend
  e64487f containing f2d8215; Dinkster f93d78a). Default no-query v18
  deployment remains a separate joint step, not yet authorized.

### B. Rapid KSampler seed +/-

- Provenance: audit r1 (lost row, restored).
- Demand: reproduce and prove INT type/serialization, declared integer
  step, bounds/randomize behavior, and event/undo semantics under rapid
  repeated +/- activation. Explicitly NOT omitted because later messages
  focused on display concerns.
- Owner: W1-B delegate.
- Source diagnosis: three defects across shared numeric stepping and
  queue-time controller advancement were found.
  Applying the FLOAT-only 1e12 quantizer to large INT values skipped exact
  integers before the JS precision boundary, and an INT without a declared
  max could step from `Number.MAX_SAFE_INTEGER` to an unsafe value. Native
  schema wire v11 NUMBER fields accept only safe-integer INT min/max/step;
  an unsafe legacy ComfyUI `2^64-1` seed max is not representable in JS and
  must never become the frontend's effective bound. INT stepping now bypasses
  float quantization and clamps to the intersection of declared bounds and
  `[Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]`; legacy randomize uses
  the same normalized constraints. Value equality also had an ABA hole: a
  manual `+` then `-` could return to the queue-time value and be overwritten
  on completion. Per-input value mutation generations now close that hole
  without suppressing advancement for untouched sibling inputs.
- Tests: `core/test/numeric-step.test.ts` failing-first safe-bound proof;
  `canvas/test/interaction.test.ts` drives 20 synchronous physical edge
  activations through the real pointer path near `MAX_SAFE_INTEGER` and pins
  every exact intermediate value; `core/test/store.test.ts` proves 20 writes
  are 20 revisions/undo records; `app/test/controller-advancement.test.ts`
  proves 20 rapid manual writes win the queue-time compare-and-set while the
  untouched controller advances once, value ABA is preserved, and duplicate
  completion is inert. `e2e/seed-controller.spec.ts` drives 20 production
  CanvasHost clicks, asserts 20 exact revisions, and undoes all 20 writes.
  Existing numeric-step randomize, default/declared step, and bound-clamp
  cases remain the proof for fixed/increment/decrement/randomize semantics.
- Browser evidence: isolated Vite `127.0.0.1:5358`, no backend jobs. A real
  INT controller row with declared step 3 advanced exactly 100 -> 160 after
  20 rapid `+` clicks and committed revisions 0 -> 20. Screenshots and JSON:
  `/tmp/audit-b-browser/before.png`, `after.png`, and `evidence.json`.
  The owned server was stopped and port 5358 was confirmed released.
- Review/gates: Oracle round 1 requested changes for value ABA, legacy safe
  bounds/current normalization, and production-path proof; all were fixed.
  Round 2 found shared-session timing, raw-bound normalization ordering, and
  key-collision issues; all were fixed. Round 3 verdict: APPROVE code changes,
  and the final full-gate rerun passed: typecheck 6/6 projects; canvas 801,
  core 2332, widgets 112, client 296 (3 skipped integration), app unit 1032,
  app component 176; isolated Playwright 1; Vite production build; diff-check
  and ASCII checks clean. No deployment or standing-service mutation.
- Coordinator acceptance (2026-08-08): delegate commit 85f3bb6 (thread
  T-019fe2a2-aa81-724f-b0ab-3964b78dacc9, parent 2d913d7, authorship
  preserved, no delegate push) cherry-picked public as aab455b; the only
  conflict was this matrix's status board. Coordinator re-verified the
  10-file diff and re-ran all gates on the merged tree (first combination
  with the C/H commit 6fd5749): typecheck 6/6, canvas 802, core 2332,
  widgets 112, client 296+3s, app unit 1032, app component 176, Vite
  build clean, diff-check/ASCII clean. Deployed: supervised
  dinkster-mission-plus2-frontend.service restarted onto aab455b (PID
  2222445 -> 2245802, NRestarts 0), :5199 HTTP 200, direct/proxied
  /api/nodes byte-identical. Row J re-proves on the served app.
- Status: COMPLETE (public aab455b).

### C. Multiline typography parity

- Provenance: audit r1 (lost row, restored).
- Demand: source-verify and correct any unintended multiline-vs-single-line
  text size difference (multiline content is additive 14px/20px vs 12px
  compact rows - the audit decides which deltas are the approved audit I2
  design and which are unintended).
- Owner: W1-CH delegate (joint with H; same files).
- Source diagnosis (coordinator-accepted 2026-08-08): source verification
  confirms the 12px compact versus 14px/20px multiline delta is the
  approved audit I2 design recorded in `docs/promises.md`, not a
  regression. The unintended mismatch was geometry: painted content had no
  gutter while the focused editor did, and the editor surface extended
  below the shared chrome. The implementation gives Canvas2D and the
  zoom-scaled textarea the same 14px font, 20px leading, 6px padding,
  content origin, 8px gutter, and symmetric 2px chrome inset.
- Implementation: delegate commit 03aa9cf (thread
  T-019fe2a3-0bbd-771b-adc3-5a3b3c931683, parent 2d913d7, authorship
  preserved, no delegate push) cherry-picked public as 6fd5749.
- Focused tests: `registry-painter-label.test.ts`, `renderer-paint.test.ts`,
  `ModalSurface.dom.test.tsx`, and the 0.75/1/1.5 idle/hover/focus Chromium
  matrix in `widget-representations-wire17.spec.ts` (failing-first 5/245
  focused expectations red on unmodified source).
- Review: delegate Oracle round 1 CHANGE REQUESTED (70px clipped a natural
  line -> 74px; native thumb minimum; resize screenshot-only -> geometry
  assertions), round 2 APPROVE. Coordinator independently re-verified the
  15-file diff and re-ran all gates on the merged tree (typecheck 6/6,
  canvas 801, core 2324, widgets 112, client 296+3s, app unit 1029, app
  component 176, build 2209 modules, diff-check/ASCII/worktree clean).
- Deployment: supervised dinkster-mission-plus2-frontend.service restarted
  onto 6fd5749 (PID 2147690 -> 2222445, NRestarts 0), :5199 HTTP 200,
  direct/proxied /api/nodes byte-identical.
- Browser evidence: /tmp/audit-ch-multiline-proof/ (isolated :5299,
  stopped and released): idle/hover/focused at zoom 0.75/1/1.5 plus
  resized painted/focused pair; coordinator media-verified hover indicator
  inside rounded chrome with preserved gutter and focused scrollbar at
  content top. Row J re-proves on the served app.
- Status: COMPLETE (public 6fd5749).

### D. Hover/chrome geometry (record only - COMPLETE)

- Provenance: audit/audit/audit; integrator delivery 58b1d531.
- Closure: delegate ca2c5ca (thread T-019fe156-c079-7429-96d4-28f2d1e3dc8c,
  parent 7e891db) cherry-picked public as 8995107; ledger rows f3e3e24
  (open) / e7ddbd4 (close). Shared widgetChromeRect helper unifies chrome,
  hover wash, and diagnostic outline (y+2/height-4/radius 4).
- Tests: canvas/test/renderer-paint.test.ts, layout.test.ts,
  registry-painter-label.test.ts (failing-first 2/128 -> 202/202 focused).
- Review: delegate Oracle 3 rounds ending APPROVE; coordinator independent
  diff/gate re-verification.
- Deployment: supervised dinkster-mission-plus2-frontend.service restarted
  PID 2082968 -> 2147690 (NRestarts 0), :5199 HTTP 200, proxy byte-identical.
- Browser evidence: /tmp/audit-hover-outline/ screenshots (isolated
  :5352) + /tmp/audit-live-proof.png live load (2 canvases, 0 errors).
- Status: COMPLETE. No duplicate implementation permitted; row J re-proves
  it only as part of the combined served-app pass.

### E. Explicit slider presentation

- Provenance: audit/audit E; evidence ba5f7aaf/7647cd0f.
- Demand: for all DECLARED slider cases, the whole rounded widget bar is
  the track and the fill spans from the chrome's left edge, independent of
  label width. Label/value text paints above the fill. Depends on row A's
  diagnosis of what "declared slider" is on the wire; bounded-but-undeclared
  numerics keep (or explicitly re-adjudicate) the audit I3 content-zone
  fill.
- A diagnosis (2026-08-08): "declared slider" is exactly the pending NUMBER
  `display` === 'slider' wire field. gradientslider and knob are separate
  declared modes, not row-E sliders; absent display stays ordinary numeric
  content-zone fill even with finite min/max.
- Owner: wave 2 (frontend slice paired with A adoption; sequenced after
  C/H and G merges to avoid registry-painter conflicts).
- I3 fill re-adjudication (2026-08-08, coordinator decision under row A's
  no-bounds-inference contract clause): the audit I3 bounds-inferred
  numericRangeFill is RETIRED, not kept - the concurred contract forbids
  inferring track/fill solely from min/max, so fill/track presentation is
  gated exclusively on decoded `display` === 'slider'. knob and
  gradientslider fall back to the ordinary number row (contractually
  permitted) as separate follow-on modes.
- Frontend proposed implementation field (W2-AE): only decoded
  `display === 'slider'` with finite ordered min/max emits numericRangeFill.
  The rounded widgetChromeRect is the track and clip, fill starts at its left
  edge and spans its full height by the clamped value fraction independent of
  label width, and label/value text paints afterward. Missing or unusable
  bounds, absent display, explicit number, knob, and gradientslider paint an
  ordinary numeric row with no track. Stepping, editor, hit, hover,
  diagnostic, row-height, and trailing-action behavior are unchanged.
- Status: COMPLETE 2026-08-11. The historical adoption record begins with
  implementation inside the paired W2-AE frontend adoption slice under the
  same joint-publish gate as row A. 2026-08-08: W2-AE
  commit 340452fb REVIEWED/APPROVED by coordinator (see row A record);
  whole-bar track/fill proof media verified at zoom 0.75/1/1.5 plus
  near-min/near-max and all fallback modes.

### F. Exhaustive latest-ComfyUI widget/input/subfeature inventory

- Provenance: audit/audit F.
- Demand: source-pin current ComfyUI master (exact SHA); map every widget/
  input/subfeature surface (including COLOR and boolean representation
  variants and representation switching where schema permits) to
  supported / missing / intentional / incompatible for Dinkster. Inventory
  prose is NOT closure: every source-ready supported surface becomes an
  explicit implementation slice row appended to this matrix.
- Owner: coordinator (slice scheduling); inventory delivered by W1-AUDIT.
- Source diagnosis (2026-08-08): full inventory with exact pins in
  docs/widget-inventory-audit.md. Pins: ComfyUI origin/master 00d02f28,
  ComfyUI_frontend origin/main bdc0345d, Dinkster 6a5a1c23, Dinkster-Frontend
  975073a, pysssss Custom-Scripts 609f3afa. Every surface classified
  supported / missing-supportable / intentional-incompatible with file/line
  evidence; boolean representation variants have NO Comfy schema authority
  (no inference permitted); representation switching supported only where
  Dinkster schema explicitly declares it.
- Per-slice terminalization (2026-08-08, audit requirement; full
  design/evidence in docs/widget-inventory-audit.md slice register):

  | Slice | Owner | Status | Trigger / identity |
  |---|---|---|---|
  | F1 numeric display (= row A) | backend lead (engine-owner T-019fdb99), frontend adopts | BLOCKED | Reviewed/public backend wire-18 NUMBER `display` implementation per concurred contract; frontend adoption slice pre-scoped in row A. |
  | F2 FLOAT `round` | backend wire lead, joint | SOURCE-LANDED (W5-V19 frontend 445f723, delegate 2794397; deployment/live proof pending separate GO) | Proposed implementation: strict wire-19 decode retains finite-positive round metadata and editor commits quantize by it without changing step or serialization. Backend identity and prior commission record remain as documented below. |
  | F3a compat STRING multiline (translator-only) | backend-local | BLOCKED-CONCURRED (no wire) | Backend disposition 2026-08-08: CONCUR as a separate no-wire backend translator slice after v18. Preserve only explicit v1/V3 multiline declarations; absent stays inferred one-line; explicit false remains explicit StringWidget(false). Placeholder is NOT smuggled into this slice. No frontend trigger - existing STRING decode/views already consume multiline. |
  | F3b STRING `placeholder` (wire) | backend wire lead, joint | SOURCE-LANDED (W5-V19 frontend 445f723, delegate 2794397; deployment/live proof pending separate GO) | Proposed implementation: retain exact strings including explicit empty, render only empty painted/DOM editor states, and never mutate the canonical value. Backend disposition record (CONCUR, presentation-only, explicit empty distinct) retained in prior matrix revision. |
  | F4 dynamicPrompts | joint (backend wire field + frontend serialization) | CONTRACT-APPROVED / SOURCE-LANDED (W5-V19 frontend 445f723, delegate 2794397; deployment/live proof pending separate GO) | Proposed implementation: malformed schema-significant values reject; exact true expands on a cloned lowered graph immediately before POST with the ComfyUI_frontend bdc0345d grammar and fresh production randomness; false/absence remain literal and editor/document state is untouched. Binding contract record: integrator adjudication audit (58ede934) SELECT option (a) - explicit semantic flag, upstream-parity RANDOM expansion, SCHEMA-SIGNIFICANT, never inferred, v18 downgrade omits, expanded literal participates in job identity - as documented in prior matrix revision. |
  | F5 COMBO control_after_generate | backend wire lead, joint | SOURCE-LANDED (W5-V19 frontend 445f723, delegate 2794397; deployment/live proof pending separate GO) | Proposed implementation: reuse the existing after-generate chip and queue-time CAS plan; fixed parks, increment/decrement cycle declared options with wrap, and randomize selects uniformly. Backend disposition record (closed vocabulary, declared-only, no remote-combo contract) retained in prior matrix revision. |
  | F6 generic remote COMBO | joint (backend initial implementation/wire20 lead + frontend editing implementation) | CONTRACT-CONCURRED (audit) / FRONTEND COMMISSIONED-QUEUED (W6-F6, behind W5-V19) | Backend design proof SOURCE-READY (T-019fe37a, audit b816a749, reviewed against Dinkster bdfa0416 / ComfyUI 00d02f28 / ComfyUI_frontend bdc0345d / Dinkster-Frontend 8eb6f6d). Frontend per-item verdicts 2026-08-08: (1) authority byte-canonical /api/choices/{choice_id}, registered-at-composition, no arbitrary URL/redirect/proxy - CONCUR; (2) wire20 fields controlAfterRefresh/timeoutMs/maxRetries/refreshMs with bounds 1..60000 / 0..5 / 0..86400000 and 20->19/18 downgrade stripping only the four new fields - CONCUR except AMEND default maxRetries 5 -> 2 (timeout default 4096 and refresh default 0 CONCUR; downgrade verified compatible: strict decoders admit remote{route,refreshButton} since wire v9); (3) bounded HTTP response contract - CONCUR; (4) frontend editing implementation fetch/cache/state model - CONCUR; (5) retry/cancel policy - CONCUR; (6) controlAfterRefresh initiating-widget direct first/last on newest successful explicit manual refresh only, one undoable CAS, empty-list/user-edit preserve - CONCUR with pinned clarification that the existing extended-controller refresh advance (remoteComboRefreshCanAdvance/prepareComboRefresh) must not also fire for the same refresh; (7) V3 unresolved remote route -> loud whole-node classified skip, trusted compat mapping required, no input-name inference - CONCUR (matches accept_all_inputs and boundary-refusal precedents). Phase 1 editing implementation hardening and phase 2 strict wire-20 adoption are implemented together on W6-F6: exact d8d8a83 goldens, wire19 highest-common fallback, per-attempt timeout and retries, demand-only TTL, policy-free registry identity, and direct initiating-widget first/last CAS with legacy controller suppression. No deployment/default/service change is part of this implementation. |
  | F7 multi-select COMBO | joint (backend wire21 lead + frontend adoption) | CONTRACT-CONCURRED (audit) / FRONTEND COMMISSIONED-QUEUED (W7-F7, behind W6-F6) | Proposed implementation: implemented against exact backend a479dfee wire-21 goldens. MULTI_COMBO binds only to structural list<core.combo>, preserves ordered duplicate options and string-array defaults, carries the final wire-20 remote policy plus placeholder and explicit chip presentation, retains list-typed outputs, and loudly rejects old wires. Proving tests: packages/core/test/dinkster-wire21.golden.test.ts, packages/core/test/replacement.golden.test.ts, and packages/core/test/dinkster-wire20.golden.test.ts. |
  | F8 media uploads -> typed ASSET | joint (backend wire22/ingest/worker lead + frontend adoption) | CONTRACT-CONCURRED (audit) / FRONTEND COMMISSIONED-QUEUED (W9-F8, behind W7-F7) | Backend F8 design accepted as intermediate (T-019fe37b, audit 594f6471); backend implements dependency-ordered source slices. Frontend per-item verdicts 2026-08-08: (1) wire22 InputSpec sourceFilename:{kind,category} (media/image|media/audio|media/video x input|output|temp, strict equality, signature-significant) + ASSET allowUpload - CONCUR; (2) V1 exact Boolean image_upload/audio_upload/video_upload and V3 exact UploadType as sole authority, all contradictions refuse, no name/content inference - CONCUR; (3) value domain dinkster.asset or structural list<dinkster.asset> retaining order/duplicates, never typed media decoding - CONCUR (frontend already models the untyped atom as single-pick non-asset-source, model.ts:136-190; upload inputs stay raw file references); (4) authenticated POST /api/assets/media with scope+kind+bounded display basename, raw bytes, optional expected digest, server-canonical AssetRef + immutable scoped grant, no path authority - CONCUR with pinned clarification A: this endpoint is used only for sourceFilename-bound upload inputs; the existing generic POST /api/assets path and its consumers (image editor, typed asset rows) remain unchanged unless separately migrated; (5) upload legal for all three source categories via scoped vault, image_folder = worker source category only - CONCUR (backend-owned); (6) worker staging into reserved contained .dinkster-source with terminal cleanup + stale confined sweep - CONCUR (backend-owned, no frontend contract surface beyond returned relative/annotated filename opacity); (7) wire22->21 downgrade strips only sourceFilename and allowUpload=true, no descriptor scalarization, server-side execution binding authoritative - CONCUR (matches the v19 dynamicPrompts signature-significant-field downgrade precedent); (8) frontend uses server-returned canonical AssetRef metadata verbatim, wildcard accept matching, existing scalar/list/cancel semantics - CONCUR with pinned clarification B: this replaces the current client-constructed AssetRef (WidgetEditor.tsx:796) and exact-string accept check (WidgetEditor.tsx:771-774) for these inputs with server-canonical adoption + image/*-style wildcard matching; (9) exclusions file_upload/model/mesh/animated/arbitrary paths/F7 batch inference - CONCUR. AMEND (naming only): frontend commission identity is W9-F8, not W8 (W8-F15AVF already allocated to the F15-AV-F media overlay). Ledger row W9-F8 queued behind W7-F7; trigger: settled F8 contract + backend wire22 reviewed public source identity. |
  | F9 COLOR end-to-end | backend wire lead, joint | SOURCE-LANDED (W5-V19 frontend 445f723, delegate 2794397; deployment/live proof pending separate GO) | Proposed implementation: strict fieldless COLOR decode binds only core.string and reuses the existing kind/view/editor while compile and submission preserve the exact string. |
  | F10 legacy top-level input metadata parity | backend-local | BLOCKED-CONCURRED (no wire) | Backend disposition 2026-08-08: CONCUR, same translator-local backend slice as F3a if review confirms disjoint behavior. Preserve explicit legacy top-level tooltip -> doc, displayName, advanced, forceInput exactly like existing V3/dynamic paths; no inference of missing values. No frontend trigger - frontend already consumes these fields. |
  | F11 RANGE / F12 CURVE / F13 BOUNDING_BOX(ES) / F14 COMPOSITOR-IMAGECOMPARE | joint, design-gated | BLOCKED | Source-proven not source-ready: each needs an agreed value codec + maintained editor design before any contract work; currently deliberately opaque. Trigger: per-surface codec/editor design approval. Not collapsible into JSON text editors. |
  | F15 output media preview / image editor | split (see F15-AV-B / F15-AV-F / F15-M) | TERMINALIZED 2026-08-08 | Image/text portion landed via audit (P1 ff017c7, I1 3670b44, I2 723b5ce) - never duplicated. W2-F15R read-only design report (delegate T-019fe2e6, source pins Dinkster-Frontend 904b4aa / Dinkster 6a5a1c2 / ComfyUI_frontend bdc0345d) split the remainder; full slice register preserved in that thread's report. Coordinator spot-validated the load-bearing claims in source: EditorKindDescriptor id/title/component registry seam, node.setValue maintained transaction (core-commands.ts ~675-696), comfy_compose.py registers AUDIO/VIDEO codecs but only IMAGE gets a rendition, OutputSpec.preview type-agnostic and unset by both translators, POST /api/assets exists. |
  | F15-AV-B browser media rendition contract | backend T-019fdb99 | SOURCE-LANDED (backend public 31658bf8, verified tree a5f0b6cd/parent a0bceef7 on Dinkster origin/main) | Backend needs: dynamic truthful rendition MIME (mp4->video/mp4, webm->video/webm, unknown refuses; RenditionSpec.mime is static today), host-registered default VIDEO rendition returning original container bytes, host-registered AUDIO WAV rendition (presentation-only conversion of float32 [B,C,T]; canonical value/fingerprint bytes unchanged), and preview=True authored only on intentional concrete native final-output schemas - never inferred by type. Routed to backend owner 2026-08-08 with integrator copied. Trigger: reviewed public backend commit providing browser AUDIO+VIDEO renditions plus at least one intentional preview-marked fixture/schema. |
  | F15-AV-F in-node media overlay | frontend | COMPLETE (public 1c243f5 implementation + 8863e70 Chromium proof, 2026-08-09) | Frontend commits 1c243f5/8863e70 add explicit preview:true schema-ordered IMAGE/VIDEO/AUDIO declared rendition selection, list element-0 count badges, MIME discrimination, sequential renderable fallback, generalized preview precedence, and CanvasHost media overlays with responsive zoom thresholds, retry-safe failure handling, and deterministic cleanup. Delegate W8-F15AVF (T-019fe3b2) Oracle APPROVE; coordinator replayed all gates on the integrated tree (typecheck 6/6, core 2372, widgets 125, canvas 821, client 349+3, app 1061, component 193, build) plus isolated Chromium proof 1/1 on :5312 with 13 artifacts (ready MP4/WebM/WAV, IMAGE/TEXT precedence, keyboard transport, resize, zoom 0.49-1.5 threshold transitions, clipping, offscreen/delete/tab-switch cleanup, 410 unavailable, 1/3 list badge). MP4/WebM fixtures from pinned ComfyUI_frontend ccd19d8695; WAV synthesized. Pinned deferrals: paging, waveform/download/remove/loop UX, poster extraction, compat preview inference. Decided design: inline playback (no poster-only, no painted playback) as host-owned DOM <video controls playsInline preload=metadata, no autoplay/loop> and 64px <audio> transport row anchored in the existing withPreviewRegion; precedence generalized to live IMAGE > executed IMAGE > declared final-output rendition (first renderable, schema order, preview:true gated) > producer peek > selected input IMAGE > TEXT; discriminated media model by response MIME; list element 0 + 1/N; controls hidden below 0.75 zoom, badge-only below 0.5; loading/failed/unavailable states with bounded definitive-miss negative cache. Additive tokens mediaTransportHeight=64/mediaControlMinScale=0.75 only. Deferrals pinned: paging, waveform/download/remove/loop UX, poster extraction, compat preview inference. Trigger: F15-AV-B activation; sequence immediately after. |
  | F15-M image editor mask capability | frontend | COMPLETE | Registry-resolved `image` center editor with a session-only same-tab target; explicit image-ASSET row and unique selected-node admission; frozen, VIDEO, output-only, missing, ambiguous, and linked/driven cases refuse. Source GET and derived POST use the existing asset client paths. Paint, erase, clear, invert, pan, zoom, and serializable local operation history never mutate the document. Export preserves RGB under transparent pixels and writes Load Image's inverted-alpha mask. Apply dispatches exactly one guarded `image.applyAsset`, so document undo/redo swaps refs and collaboration rebase drops an apply after concurrent source replacement. Proof: `app/test/image-editor.test.ts`, `core/test/image-commands.test.ts`, `core/test/shared-session.test.ts`, `app/test/editors.test.ts`, and isolated `e2e/tests/image-editor.spec.ts`. Deferrals remain output-only preview editing, persistent editable image documents and layer/compositor models, VIDEO masks, driven-input disconnect-and-replace, and upstream four-file PNG conventions. |

  Terminal reconciliation (2026-08-11) supersedes only the historical
  Status column above; the design and landing history remains preserved.

  | Slice | Terminal status | Exact identity / evidence |
  |---|---|---|
  | F1 numeric display (= row A) | COMPLETE | Frontend f2d8215 + backend f93d78a; deployment and proof remain recorded in Row J. |
  | F2 FLOAT `round` | COMPLETE | Frontend 445f723; promise row 288; `dinkster-wire19.golden.test.ts`, `widget-commit.test.ts`, and live `comfy.KSamplerAdvanced.cfg` commit 8.129 -> 8.13 in `audit-widget-parity-live.spec.ts`. |
  | F3a compat STRING multiline | COMPLETE | Backend 934302e, `test_v1_widget_v19_declarations_are_preserved_without_inference`, `test_v3_widget_v19_declarations_are_preserved_exactly`, Dinkster PROMISES row 40, and deployed ancestry 934302e/b6412f88 -> 172ee02. |
  | F3b STRING `placeholder` | COMPLETE | Frontend 445f723; promise row 288; wire-19 golden/unit and `wire19-adoption-proof.spec.ts` fixture proof. The wire-22 catalog query and SHA recorded below contain zero declarers; re-run live proof when the first backend node declares placeholder. |
  | F4 dynamicPrompts | COMPLETE | Frontend 445f723; promise row 288; `dynamic-prompts.test.ts`, `dinkster-wire19.golden.test.ts`, and the standing-stack POST proof recorded below. |
  | F5 COMBO control_after_generate | COMPLETE | Frontend 445f723; promise row 288; `dinkster-wire19.golden.test.ts`, `controller-advancement.test.ts`, and `wire19-adoption-proof.spec.ts`. The deployed frontend/backend accept the contract; the live catalog currently has no COMBO `controlAfterGenerate` declarer. |
  | F6 generic remote COMBO | COMPLETE | Frontend 2d7c048; promise row 289; `dinkster-wire20.golden.test.ts`, `scoped-client.test.ts`, and `wire20-remote-policy-proof.spec.ts`; all three live generic routes refreshed below. The policy fields have zero live declarers, with a re-check triggered by the first declaration. |
  | F7 multi-select COMBO | COMPLETE | Frontend b108a3d; promise row 290; `dinkster-wire21.golden.test.ts`, `replacement.golden.test.ts`, and `wire21-multicombo-proof.spec.ts`. The wire-22 catalog contains zero MULTI_COMBO declarers; re-check live behavior when the first declaration lands. |
  | F8 source-filename media | COMPLETE | Frontend c9282e2; promise row 291; `dinkster-wire22.golden.test.ts`, `w9-f8-media-upload.spec.ts`, and the real source upload below. |
  | F9 COLOR | COMPLETE | Frontend 445f723; promise row 288; `dinkster-wire19.golden.test.ts`, `widget-commit.test.ts`, and `wire19-adoption-proof.spec.ts`; the deployed catalog contains four COLOR inputs. |
  | F10 legacy top-level metadata | COMPLETE | Backend 934302e, the same two compat translator tests and Dinkster PROMISES row 40 as F3a, and deployed ancestry 934302e/b6412f88 -> 172ee02. |
  | F11-F14 opaque editor families | source-proven BLOCKED | Joint backend-contract and frontend-editor owners; trigger is per-surface value-codec and maintained-editor design approval. Source evidence and explicit JSON-editor refusal remain in the historical row above and `widget-inventory-audit.md`. |
  | F15 output preview and image editor | COMPLETE | Media preview proof is in `media-overlay-proof.spec.ts`; image editing and its mask capability are pinned by `image-editor.spec.ts`. |

- Status: COMPLETE 2026-08-11 under the terminal reconciliation above.
  F11-F14 retain their exact source-proven blockers, owners, and triggers;
  every other registered slice is complete.

### G. Shared trailing layout primitive

- Provenance: audit/audit G; evidence ba5f7aaf (lock/+ near-touch,
  caret at edge).
- Demand: trailing actions (seed lock chip, +, combo caret) share one
  source-backed trailing-action alignment/margin primitive where possible.
- Owner: wave 2 (after C/H merge; registry-painter/controller-chip files).
- Implementation (coordinator-accepted 2026-08-08): `controller-chip.ts` owns
  the 3px glyph half-extent, 6px-from-edge center, and 6px adjacent-action
  gap. Numeric minus/plus and COMBO caret paint consume it; COMBO text
  separately reserves the unchanged 12px edge zone (the superseded
  view-level `reserveRight: 12` in `kinds.ts` was removed so the painter
  reserve is the single source, per delegate Oracle round 1); the controller
  chip rectangle moves left by the shared 6px gap and remains the source for
  paint, value rails, and hit testing. Stepper hit zones remain unchanged.
  Proof: `controller-chip.test.ts`, `renderer-paint.test.ts`,
  `registry-painter-label.test.ts`, `interaction.test.ts`, and isolated
  Chromium `widget-trailing-actions.spec.ts` at 0.75/1/1.5 zoom plus a
  narrow node (failing-first 5 red / 165 green on unmodified source).
- Delegate commit a77c4b4 (thread T-019fe2c1-511d-725b-ba08-4cf9d6583871,
  parent 7e40b75, authorship preserved, no delegate push) cherry-picked
  public as 51a1ce2 (clean). Coordinator re-verified the 13-file diff and
  re-ran all gates on the combined tree - first combination with row B's
  aab455b: typecheck 6/6, canvas 803, core 2332, widgets 112, client
  296+3s, app unit 1032, app component 176, Vite build, diff-check/ASCII
  clean. Browser evidence /tmp/audit-g-trailing-proof (isolated :5301,
  released) media-verified: chip/+ clearance, inset -/+ glyphs, caret
  margin with truncated text not running under it. Deployed:
  dinkster-mission-plus2-frontend.service restarted onto 51a1ce2 (PID
  2245802 -> 2277917, NRestarts 0), :5199 HTTP 200, direct/proxied
  /api/nodes byte-identical. Row J re-proves on the served app.
- Status: COMPLETE (public 51a1ce2).

### H. Multiline polish

- Provenance: audit r1 (lost row, restored) + audit/audit H;
  evidence 17f6a323/9f94f3c0.
- Demand: reduced label/text gap; scrollbar aligned inside the chrome,
  visible on hover AND active/focus whenever content overflows; permanent
  reserved gutter so text never shifts between states; consistent across
  zoom and resize; painted (idle/hover) and DOM-editor (focused) geometry
  agree.
- Owner: W1-CH delegate (joint with C).
- Implementation (coordinator-accepted 2026-08-08): additive 18px multiline
  label-band token (replacing the shared 24px compact-row band only for
  `core.text`) plus 6px scrollbar and 2px edge-inset tokens. The natural
  two-line row becomes 74px including the shared 2px top/bottom chrome
  inset. Every multiline painted state reserves the resulting 8px gutter;
  overflowing hover paints a proportional thumb from content top to the
  chrome bottom, while focus uses the same zoom-scaled native gutter and
  scrollbar geometry. The painted thumb is an indicator only: no canvas
  scrolling or hit behavior was added. Greedy word wrapping and code-point
  breaking are unchanged; narrower gutter-reserved width intentionally
  rewraps and is pinned by tests. Delegate commit 03aa9cf cherry-picked
  public as 6fd5749 (same closure as row C; shared tests/review/deployment/
  browser evidence recorded under row C).
- Deviation disposition: delegate's initial 70px natural row was corrected
  to 74px during Oracle review (18 label + 40 content + 12 padding + 4
  chrome inset cannot fit in 70); the reduced label gap still lands (18px
  band vs prior 24px) while preserving two complete natural lines.
- Status: COMPLETE (public 6fd5749).

### I. Multiline extension capability

- Provenance: audit/audit I.
- Demand: source-review latest ComfyUI plus representative node-pack
  autocomplete/augmentation mechanisms (e.g. embedding/LoRA autocomplete
  packs); prove whether Dinkster can support equivalent per-widget extensions.
  If frontend-local and non-public-contract: implement the smallest typed
  seam plus a proving example/tests (wave 2 slice). Otherwise: record and
  route the exact contract owner/blocker with the integrator copied.
- Owner: coordinator (wave-2 implementation); diagnosis by W1-AUDIT.
- Source diagnosis (2026-08-08, full design + evidence in
  docs/widget-inventory-audit.md): VERDICT FRONTEND-LOCAL. ComfyUI's
  autocomplete packs (pysssss pinned 609f3afa) use the public
  getCustomWidgets/beforeRegisterNodeDef seam to enhance the multiline
  textarea; Dinkster already has the equivalent anchor points (public widget
  registry, extension host contributions with lifecycle disposal, and
  host-owned textarea editing that converges on maintained document
  commands). No public backend/schema wire change is required for the
  generic per-widget completion seam.
- Wave-2 slice I1 (frontend-local): typed TextWidgetEditorExtension
  registry + manifest contribution + host-owned suggestion surface + static
  embedding/LoRA proving provider + focused unit/component tests + docs.
  Full interface design and required test list pinned in the inventory doc.
- Live inventory data contract: typed embedding and LoRA choice routes expose
  a lazy loading/ready/empty/error handle with cancellation and scope refusal.
  The host suggestion session accepts that handle directly; concrete live
  registration and feature E2E remain separate.
- Proposed I1 implementation field: local commit adds the public typed
  `TextWidgetEditorExtension` registry, manifest-gated host contribution,
  in-node multiline suggestion surface, and injected static embedding/LoRA
  proving provider. Focused tests are
  `widgets/test/text-editor-extension.test.ts`,
  `core/test/extensions.test.ts`, and
  `app/test/text-completion.dom.test.tsx`. The suggestion surface mutates only the local
  draft; the existing commit path remains the sole document mutation. No
  canvas, backend, wire, schema, serialization, or compile contract changes.
  Typed live inventory data is implemented independently of the host chrome.
- Acceptance (2026-08-08): delegate commit c051131 (thread
  T-019fe2c8-da15-720d-b9c5-8bf626fe8b5f, parent 626cfd1, authorship
  preserved, no delegate push) cherry-picked public as 5bf6384 (clean;
  docs auto-merged, matrix statuses retained). Coordinator re-verified
  the 16-file diff (no packages/canvas changes; additive
  textEditorExtension manifest category; registry beside widgetRegistry;
  popup consumption only in the multiline core.text textarea) and re-ran
  all gates on the combined tree: typecheck 6/6, canvas 803, core 2334,
  widgets 120, client 296+3s, app unit 1032, app component 188, Vite
  build, diff-check/ASCII clean. Browser evidence /tmp/audit-i1-proof
  (isolated :5303, released) media-verified: embedding popup at caret,
  popup-closed embedding/LoRA insertions, Escape leaves draft unchanged;
  Playwright pins caret positions, zero revision change on acceptance,
  +1 revision per Ctrl+Enter commit. Delegate Oracle R1 (stale published
  entries acceptible across requery/disposal; supports() throw not
  isolated) fixed, R2 APPROVE. Deployed:
  dinkster-mission-plus2-frontend.service restarted onto 5bf6384 (PID
  2277917 -> 2308245, NRestarts 0), :5199 HTTP 200, direct/proxied
  /api/nodes byte-identical. Row J re-proves on the served app.
- Status: COMPLETE (I1 public 5bf6384; conditional I2 remains deferred
  under the pinned backend-catalog trigger above and does not gate this
  row).

### J. Final combined acceptance

- Provenance: audit/audit J.
- Demand: after all other rows are terminal, one combined proof against the
  actual served app (:5199 supervised service) with the latest backend
  catalog: browser proof covering every implemented row and explicit
  visible proof for missing/blocked rows; source/merge/deploy identities;
  console/network health; service PID/restart counters; no silent
  omissions.
- Owner: coordinator.
- Status: COMPLETE 2026-08-08. Closure record:
  - Backend deployment (authorized audit, executed by frontend coordinator):
    user unit dinkster-mission-plus2-backend.service; checkout station1/Dinkster
    detached at exact public f93d78a033ee4a275c910c6dea8986588dbaa201 (tip
    origin/main e3e204c NOT used: contains non-equivalent inference source);
    no dependency-manifest change vs prior 6a5a1c2 so venv preserved;
    PID 972665 -> 2406018, NRestarts 0, ActiveState active; launch config
    byte-preserved. HTTP: default /api/nodes 200 schemaWire 18; wire=18
    canonical-JSON-equal to default; wire=17 200 schemaWire 17 with zero
    display keys; wire=19 406.
  - Frontend deployment (authorized audit): user unit
    dinkster-mission-plus2-frontend.service (Vite :5199, DINKSTER_NATIVE_BACKEND
    127.0.0.1:8765); served source main 47a8d88 (>= required 32f12d6;
    contains f2d8215 wire-v18 adoption and 6ed3482 mask editor);
    PID 2308245 -> 2411182, NRestarts 0, active; GET / 200; proxied
    /api/nodes default/17/18 each byte-equivalent to direct :8765.
  - Live combined proof: packages/e2e/tests/rowj-live.spec.ts via
    packages/e2e/playwright.rowj-live.config.ts (no webServer; connects to
    standing :5199; POST /api/assets and /api/jobs route-mocked so zero
    backend mutation; GETs pass through to the real catalog). Result:
    1 passed. Counters: assetPosts=1 (mocked apply), jobPosts=0,
    pageErrors=[]. Benign console findings recorded: 500 /system_stats,
    2x 404 /supervisor/status, 404 GET of the mocked post-apply digest.
    Evidence /tmp/audit-rowj-proof/: 01-ksampler-widgets.png 63769,
    02-int-step-undo.png 66524, 03-multiline-idle.png 86383,
    04-multiline-hover.png 86836, 05-multiline-focus.png 87996,
    06-multiline-resize-zoom.png 87250, 07-hover-geometry.png 87789,
    08-mask-editor-open.png 382499, 09-mask-cancel.png 173230,
    10-mask-apply-mocked.png 112376, 11-display-number-ordinary.png 106045.
    Coordinator independently re-inspected 01/04 plus the isolated slider
    frame: no slider fill on bounded no-display rows; seed lock adjacent to
    value; + and combo caret share the trailing margin; hover+focus
    scrollbar inside chrome with reserved gutter and no text shift;
    whole-bar slider fill origin at chrome left edge.
  - Explicit-slider truthfulness: the live wire-18 catalog declares zero
    display:"slider" inputs (4 declared display facts, all "number":
    comfy.ImageColorToMask.interface[1], comfy.LTXVEmptyLatentAudio
    .interface[0]/[2], comfy.CreateVideo.interface[3]). Slider rendering is
    therefore proven by the checked-in isolated proof re-run 2026-08-08
    (playwright.number-display.config.ts, 1 passed, artifacts
    /tmp/audit-ae-proof/, 7 frames incl. zoom 0.75/1/1.5 and
    near-min/near-max), not silently claimed live.
  - Mask editor: present live; entry from a real read-only library PNG via
    dinkster.load_image; paint/local undo-redo/cancel proven live with zero
    revision change; Apply proven with exactly one mocked POST /api/assets
    and exactly one revision/value change (no real backend mutation, per
    the audit observation boundary).
  - Prior D/I non-regression: D hover geometry re-proven visually
    (07-hover-geometry.png) against public 8995107 behavior; I1 seam
    behavior unchanged (public 5bf6384); no regressions observed.
  - Preserved source screenshots (exact media identities, unchanged):
    ba5f7aaf-baa3-40b4-aaa9-81c67c2a07a5 chrome_lFmPlkIqJn.png sha256
    d6d8611110952d026f8ff4d3f352f6af8897f6cfb899550878d4b93a175217d7;
    17f6a323-80d2-4854-b653-a10400191cb5 chrome_qaoU4c6i2j.png sha256
    9b7a709fce7a8baf0eee07f6e05b02428a04d0e8c30c672dd7b8bd3d165f705e;
    9f94f3c0-7250-4fbe-8dca-aabc926fd628 chrome_aT1xaZJpRj.png sha256
    b8af44b6bc826e2fb54e5b6b2aef7509532e26be725b49a904ab97b0e3a39065;
    7647cd0f-ae10-4493-9de2-10fac77b4c62 chrome_JxTx3F51fx.png sha256
    35c0e9308b955f33e76f40512b0a010249df5b45d28a304425295266aa810f88.
  - F2-F15 non-complete surfaces (CORRECTED 2026-08-08 per integrator
    audit; the earlier BLOCKED classification was stale): the row-J
    evidence above is TRANCHE-1 proof; the accountability parent continues
    in the continuation section below.
    F2 round / F3b placeholder / F4 dynamicPrompts / F5 controlAfterGenerate
    / F9 COLOR: BACKEND SOURCE PUBLIC 2026-08-08 (engine-owner audit,
    delivery 670ac896) - reviewed Dinkster source e905bd136b159370c838ebe9543e
    ecf9c9fcaf90 (tree d9138db, parent 19b4839), terminal delegation closure
    90d81211d97c8d399d442f8e97ba91e4cd65afd8. Backend contract:
    SCHEMA_WIRE_VERSION=19, served (18,19) highest-common, strict window
    (17,18,19) with 16 refusing; NUMBER round finite-positive float-only;
    STRING placeholder; STRING tri-state dynamicPrompts (absent/false/true
    distinct, schema-signature significant); COMBO controlAfterGenerate in
    fixed|increment|decrement|randomize; fieldless COLOR bound to
    core.string (producers and consumers map core.string; outputs carry no
    widget); backend never expands prompts or runs RNG; recursive v18
    downgrade omits only the five facts. Backend golden SHA256: vocabulary
    ee0a8a65abb8906a8eb6132239f940c0c6bf1bd762ba54386d09f9c76c459bb3, chain
    882491e734a53e11be9cddae49701888e943542d442a83aae4050a4893093f70, combo
    dcfc8118ecaefb774cfa266bac476a9fa2884784083274d2e97acb1b0a986b2f.
    Frontend strict decoder/goldens/serialization adoption (incl.
    dynamicPrompts submit-time expansion per F4 adjudication 58ede934)
    LANDED 2026-08-08 as slice W5-V19: delegate commit 2794397
    (T-019fe374, Oracle APPROVE after 3 fix rounds) cherry-picked to main
    as 445f723 against exact backend identity e905bd1; coordinator
    independently re-reviewed the diff, re-verified the three golden
    SHA256 hashes, and re-ran full merged-tree gates green (typecheck 6/6,
    core 2372, widgets 125, canvas 821, client 306+3skip, app 1044,
    component 188, Vite build). v19 default/deployment stays gated on a
    separate deployment GO; deployment/live proof still owed under
    audit before F2/F3b/F4/F5/F9 are terminal.
    F3a multiline preservation + F10 legacy metadata: QUEUED translator-local
    backend slices (owner engine, post-v18); no frontend trigger.
    F6 remote COMBO / F7 multi-select COMBO: OPEN, deferred to design
    (backend disposition audit) - not terminal.
    F8 AssetWidget: OPEN, deferred pending backend value-domain design
    proof - not terminal.
    F15-M mask editor: COMPLETE (public 6ed3482).
    F15 remainder (VIDEO/AUDIO in-node preview et al.): F15-AV-B backend
    SOURCE-LANDED public 31658bf8; frontend F15-AV-F COMPLETE (public
    1c243f5 + 8863e70, 2026-08-09) against that exact backend identity.

## Continuation (successor to parent 98378128, opened per audit)

Parent 98378128 was resolved with the audit tranche-1 closure; integrator
audit rejected that as terminal because open F rows remained queued/
deferred/in-progress. This section is the durable open continuation row.
It stays open until ALL of:
1. Backend v19 (F2/F3b/F4/F5/F9) reaches reviewed public source or a
   genuine terminal source-proven blocker.
2. Frontend strict v19 decoder/goldens/serialization adoption lands, is
   deployed through the supervised boundary, and is live-proven, including
   dynamicPrompts submit-time expansion behavior.
3. Every remaining F surface (F3a, F6, F7, F8, F10, F15 remainder) is
   COMPLETE, genuinely source-proven BLOCKED, or an explicit source-backed
   NON-GOAL. Queued/deferred/design states are not terminal.
Rules: do not duplicate backend v19 work; do not disturb the deployed v18
services; allocate the frontend adoption slice only against the exact
reviewed backend landing identity. Tranche-1 (v18 rows A-J) evidence at
48d765a remains valid and is not re-run.

Binding user clarification (integrator audit, delivery fe19e70c,
2026-08-08): summaries/inventories/designs/delegations/routing/queued
states are NOT completion for ANY listed item. A row is terminal only as
COMPLETE with implementation + verification + deployment/live proof where
user-visible, or source-proven BLOCKED / NOT-APPLICABLE with exact
owner + trigger + evidence. For F6/F7/F8 and the F15 remainder,
design/report/delegation is intermediate only: the moment the backend
contract/source for a surface is ready, the matching frontend adoption
slice and user-visible proof must be allocated immediately (activation
checkpoints: integrator audit activated F15-AV-B implementation,
bounded F6/F7/F8 design proofs with frontend field concurrence, and
post-v19 F3a/F10 translator-local slices). This matrix remains the single
itemized mapping from every original user demand to its exact terminal
outcome, and this continuation stays open until every mapping is
terminal under that standard.

### Terminal accounting and combined served-app proof (2026-08-11)

Status: COMPLETE. The terminal reconciliation in row F maps every original
surface to COMPLETE or a source-proven BLOCKED state under audit. The
standing backend serves wire 22 from deployed source 172ee02 and the
standing frontend contains the public frontend adoption commits.

F3a and F10 are COMPLETE, superseding the stale BLOCKED disposition in the
audit GO text after direct source verification and coordinator
adjudication. Backend 934302e implemented explicit legacy/V3 multiline
preservation and ordinary legacy tooltip/display-name/force-input/advanced
metadata. Backend tests
`test_v1_widget_v19_declarations_are_preserved_without_inference` and
`test_v3_widget_v19_declarations_are_preserved_exactly` plus Dinkster PROMISES
row 40 pin both contracts. Commits 934302e and closure b6412f88 are ancestors
of deployed 172ee02.

The combined browser proof is
`packages/e2e/tests/audit-widget-parity-live.spec.ts`, run with the
no-webServer config `playwright.audit-widget-parity.config.ts` against
`http://127.0.0.1:5199`. Its exact read-only catalog query was
`GET http://127.0.0.1:8765/api/nodes?wire=22`; the 600-node response SHA-256
was `fb9fe0fa2d8b70a58bae1a5d3d1fc8b78ad0dddb347c1517197245a790944598`.
The proof established:

- F2: `comfy.KSamplerAdvanced.cfg` declares `round:0.01`; editor commit
  quantized 8.129 to 8.13 on the served app.
- F3b: zero placeholder declarers. Adoption remains source/fixture-proven by
  445f723, promise row 288, `dinkster-wire19.golden.test.ts`, and
  `wire19-adoption-proof.spec.ts`. The first backend placeholder declaration
  triggers a live re-check.
- F4: the real `dinkster.clip_text_encode.text` declaration was partially
  submitted through POST `/api/jobs`; `{amber|violet} proof` expanded to one
  literal in the submitted graph while the document value stayed unchanged.
  The accepted two-node job was immediately cancelled.
- F5: the catalog has zero COMBO `controlAfterGenerate` declarers. The
  deployed adoption is fixture-proven by 445f723 and the row-288 tests; the
  first COMBO declaration triggers a live re-check.
- F6: `comfy.CheckpointLoader.config_name`,
  `dinkster.ksampler.sampler_name`, and `dinkster.ksampler.scheduler` each exposed
  and completed generic remote fetch plus explicit refresh through their
  declared `/api/choices/*` route. All three omit
  `controlAfterRefresh`/`timeoutMs`/`maxRetries`/`refreshMs`; 2d7c048,
  promise row 289, `dinkster-wire20.golden.test.ts`, `scoped-client.test.ts`,
  and `wire20-remote-policy-proof.spec.ts` provide source/fixture proof. The
  first policy declaration triggers a live re-check.
- F7: zero MULTI_COMBO declarers. Commit b108a3d, promise row 290,
  `dinkster-wire21.golden.test.ts`, `replacement.golden.test.ts`, and
  `wire21-multicombo-proof.spec.ts` provide source/fixture proof. The first
  declaration triggers a live re-check.
- F8: `comfy.LoadImageMask.image` declared `allowUpload:true` and matching
  `sourceFilename`; the served editor uploaded the exact 68-byte
  `audit-wpar-source.png`, adopted the server-canonical AssetRef, and read
  back byte-identical content. Commit c9282e2, promise row 291,
  `dinkster-wire22.golden.test.ts`, and `w9-f8-media-upload.spec.ts` pin the
  broader contract.
- F9: four live COLOR inputs were present; 445f723 and the row-288 tests pin
  exact string preservation.
- F15 remains COMPLETE through frontend 1c243f5 + 8863e70 against backend
  31658bf8, plus mask-editor commit 6ed3482.

Proof logs are `/tmp/audit-wpar-red-live.log` (failing-first request-body
observation corrected to server byte readback) and
`/tmp/audit-wpar-live.log`; screenshots are under
`/tmp/audit-wpar-proof/`. Standing service lifecycle was observation-only.
No fixture server or port 5374 was used.

## Delegation allocation (wave 1)

- W1-AUDIT (read-only research): rows A + F + I diagnosis. Pins exact
  ComfyUI/ComfyUI_frontend SHAs, the Dinkster backend catalog translation
  path, and the frontend decode path; outputs per-row source-backed
  diagnosis and the wave-2 slice definitions. COMPLETE 2026-08-08
  (thread T-019fe2a2-9378-711b-845d-484bad8ad91f); report preserved in
  docs/widget-inventory-audit.md; all four inspected worktrees clean,
  no mutation.
- W1-B (implementation/verification): row B.
- W1-CH (implementation): rows C + H together (same files:
  registry-painter/text-fit/tokens/canvas tests + app editor overlay).
- Wave 2 (opened when inputs land): E (needs A), G (needs C/H merge),
  I-implementation (needs I diagnosis), F-derived slices.
- Row D closed at matrix creation; row J last.

Thread IDs for commissioned delegates are recorded in
docs/delegation-ledger.md rows referencing this file.
