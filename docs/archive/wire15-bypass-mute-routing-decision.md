# Decision record: wire-15 lowering under bypass/mute (Option A)

Status: DIRECTION APPROVED by the user 2026-07-29. Design step 1 is delivered
in `docs/wire15-structural-routing-design.md`; implementation step 2 is
pending. Do not remove the gate from this decision record alone.

## Problem

Recursive wire-15 constructs make a node's live input ports a function of
document state (family members, selector choices, active slots). Bypass
routing matches inputs to outputs positionally over the node's interface,
so which ports exist affects where a bypass routes; but which links are
compile-live (and therefore which dynamic members exist at compile time)
depends on that routing. Slice 76 proved across nine Oracle rounds
(delegate thread T-019fac7d-b7b6-707f-936a-220c44149095) that patching
this self-reference incrementally spawns a second, inconsistent compiler:
bypass-hop evidence, would-run random-branch supersets, dead-link capacity
poisoning, interface-order loss under independent probes, and
occurrence-aware death through subgraph boundaries each individually
broke a probe-based approach. The conservative stopgap is
`compile.wire15.modesUnsupported`: a genuinely recursive wire-15 construct
plus any muted/bypassed node in the reachable occurrence closure refuses
loudly (see the availability amendment row in docs/promises.md).

## Decision: Option A - stratify on the structural interface

Define bypass/mute ROUTING over the structural, editor-visible interface
(the same materialized interface the editor derives from stored document
state: family members from stored ids and nested choice state, active
slots, selector choices), not over compile-live evidence. Then derive
compile liveness and dynamic-family membership FROM that routing. This
breaks the cycle into a one-directional pipeline:

```diagram
+--------------------+    +---------+    +----------+    +--------------------+
| structural         |--->| routing |--->| liveness |--->| wire-15 membership |
| interface (stored  |    | (bypass |    | (compile |    | (submitted family  |
| document state)    |    | /mute)  |    |  -live)  |    |  values/links)     |
+--------------------+    +---------+    +----------+    +--------------------+
```

No fixed point is needed because routing never reads liveness. The cost is
that a dead-but-visible link (a stored member whose source is itself dead)
still occupies a positional slot for routing purposes; that is acceptable
because it matches what the user sees on the canvas - the editor renders
the structural interface, so routing behaves exactly as drawn.

Constraints carried over from the slice-76 rejection history:

- ONE implementation: routing and actual lowering must share a single
  semantic definition of the interface. No separate approximate scanner
  (that is precisely what Oracle round 1 prohibited and what rounds 3-9
  kept re-creating).
- Wire-14 structural connectivity semantics are the model: wire 14 already
  routes bypass over the structural interface and it is proven byte-stable.
  Option A generalizes that stance to wire 15 instead of inventing a
  stricter liveness-first stance for wire 15 only.
- Occurrence-locality: the structural interface is materialized per
  subgraph occurrence (slice-75 semantics), so routing is occurrence-local
  and needs no cross-occurrence fixed point either.

## Option C (fallback, not chosen now)

Change wire-15 bypass matching from positional to id/type matching, so
routing no longer depends on interface ORDER at all. The user is willing
to change semantics if it materially improves the design; consider Option
C only if the Option A design slice finds that positional matching over
the structural interface still produces surprising routes (e.g. a stored
dead member silently displacing which output a bypass feeds) that cannot
be fixed with diagnostics. If Option C fires it is a joint decision with
the backend, since bypass semantics are user-visible behavior parity.

## Removal plan for the gate

1. DELIVERED: the Oracle-reviewed design is
   `docs/wire15-structural-routing-design.md`. It specifies the structural
   interface contract, exact vs would-run behavior, selector projections,
   reroute/tap/value-source/net traversal, occurrence boundaries, the rounds
   3-9 counterexample audit, and proof obligations.
2. PENDING: implementation slice. Implement the shared interface definition, derive
   routing and liveness from it, remove `compile.wire15.modesUnsupported`,
   and convert the gate's refusal tests into positive routing proofs. The
   deferred promise row in docs/promises.md ("Wire-15 submission lowering
   under bypass/mute") flips in that commit.

The nine-round failure history is durable context: any future attempt
that reintroduces liveness-dependent routing must first explain why the
round 3-9 counterexamples do not apply.
