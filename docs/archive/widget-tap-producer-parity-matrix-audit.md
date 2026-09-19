# Widget-tap producer-endpoint parity matrix (audit)

Durable matrix for integrator commission audit delivery
5fe42b6c-5a62-494b-bd0e-53f3057a9439 (topic
dinkster-frontend/widget-output-noodle-parity-systemic-followups).
Owner: frontend coordinator T-019fda1e-775f-72cb-ab0b-677dbb7b2fb0.
Baseline for all rows: public main 6f3a2f68660589308616d9b3613a5f14f7f9c461.

Predecessor audit/audit work is separately COMPLETE (public 701c405 +
8d5a085, deployed/live proof 6f3a2f6) and is NOT reopened by this matrix.

## Binding invariant (integrator audit)

WidgetTapRef is a static/memberless producer endpoint. It is semantically
equivalent to an ordinary output PortRef wherever an operation consumes only
producer identity/connectivity/outgoing-link semantics. It is deliberately
different wherever the operation requires a link target, mutable dynamic
member/path semantics, or an input-side boundary binding. Code must never
silently omit a valid tap producer: it must either use shared producer-endpoint
semantics or return an explicit tested refusal.

Terminal states per row: COMPLETE, BLOCKED (exact owner + activation
trigger), or NOT-APPLICABLE (source evidence). "Queued", "delegated", or
"summarized" are not terminal.

## Rows

| Row | Site (at 6f3a2f6) | Verdict | Status | Evidence |
|-----|-------------------|---------|--------|----------|
| A | core/src/replace/plan.ts sourceStateOf link scan (~149-160): outgoing capture gates on isPortEndpoint(link.from); WidgetTapRef-sourced outgoing links are absent from linksOut/memberLinks and from replacement survivor mapping/dropped-link review | SOURCE-READY producer parity (integrator-adjudicated) | COMPLETE 2026-08-08 (public 59fd3c3, delegate ff085397 replayed byte-identical) | 59fd3c3: replacement planning captures exact widget-tap producers in a discriminated tap map (`tapLinksOut`, never colliding with output-port ids); unique elaboration-proven static/memberless/same-type taps survive with exact stale `tapGuards` validated atomically at apply, while missing/incompatible/forced/dynamic/ambiguous taps enter warning + dropLinks review and malformed/member/path lookalikes fail as replace.tap.invalid. Targets remain port-only. replacement.test.ts proves capture, supported survival, unsupported review/drop, malformed/stale refusal, unchanged targets, and one-step undo/redo (failing-first: 7 red on unmodified source across A+B) |
| B | core/src/schema/elaborate.ts buildGraphConnectivity link scan (~109-115): producer connectivity records only isPortEndpoint(link.from); tap producers omitted from outputs accounting | SOURCE-READY producer parity (integrator-adjudicated) | COMPLETE 2026-08-08 (public 59fd3c3, delegate ff085397 replayed byte-identical) | 59fd3c3: buildGraphConnectivity indexes exact extant widget taps under discriminated producer keys; memberless output queries count port or tap while member queries and all input/inputPorts accounting remain port-only; stale-node/empty-id/member-malformed taps create no phantom facts and no member/dynamic inference was added. elaborate.test.ts proves tap-only, mixed port+tap, stale/empty/member-malformed refusal, and no member inference. Only output-family elaboration consumes isOutputConnected; member paths keep taps out of promotion. |
| C | core/src/lifecycle/planner.ts endpoint collection/reservation/forwarding: exact widget-tap out-cuts share one derived boundary output while value-source and selector/reroute structural outputs remain refused | SOURCE-READY producer parity | COMPLETE 2026-08-30 | The boundary-output binding union preserves `{node,tap}` through validation, schema derivation, extraction, flattening, compile forwarding, scene projection, and bind/unbind/delete commands. Lifecycle, compile, format, scene, interaction, and production-browser tests cover exact-tap fan-out, nested/save-load/undo-redo/delete behavior, malformed fail-closed cases, and ordinary port/family regressions. |
| D | canvas/src/interaction.ts boundary drops for widget-tap producers | SOURCE-READY producer parity | COMPLETE 2026-08-30 | Fresh and Alt-fan-out tap drops onto existing outputs, the add slot, panel body, and header preserve exact tap identity. Input-side exposure remains explicitly refused. Interaction and native-backed browser tests cover tap exposure, ordinary-port regression, and visible `Widget output` projection. |
| E | app/src/CanvasHost.tsx delete/unbind projection for widget-tap boundary sources | SOURCE-READY producer parity | COMPLETE 2026-08-30 | Selection deletion and boundary gestures emit exact tap-aware unbind commands; document commands preserve atomic delete, undo, and redo behavior. Scene, app, command, and lifecycle tests cover unbind and deletion. |

## Slice allocation

- W4-AB (rows A+B, one delegate, implementation): shared producer-endpoint
  semantics in replace planning and connectivity accounting. Failing-first
  tests, full gates, Oracle review to APPROVE, local no-push commit,
  steer:false reply.
- W4-CE (rows C+D+E, one delegate, adjudication-first): trace the
  authoritative document/binding/compile boundary contract and classify every
  cited branch (not just isPortEndpoint spelling). On SOURCE-READY verdict,
  implement all three layers atomically under existing audit authorization
  (no second GO needed). If the boundary contract intentionally cannot
  represent taps, preserve the explicit refusal, add focused tests/docs, and
  return the exact missing document/compile contract, owner, and activation
  trigger. Served-app proof required if D/E are implemented.

Closure rule: this topic stays open until every row is terminal. Source
landing alone does not close a row that requires deployment/served proof.
