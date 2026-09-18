# Wire-15 structural routing design

Status: I1, I2, AND I3 IMPLEMENTED 2026-07-30. This document is the
design of record for the gate-removal plan in
`docs/wire15-bypass-mute-routing-decision.md`. I1 ships Option A structural
routing and removes `compile.wire15.modesUnsupported`; I2 ships lazy-switch
would-run projection, and I3 completes the combined evidence and Option C
audit.

## Goal and load-bearing rule

Wire-15 bypass/mute support must not rediscover an interface from compile
liveness. The compiler first materializes the structural interface the editor
shows, routes bypass over that fixed interface, and only then derives delivery
liveness and wire-15 submission membership:

```text
stored schema/state/topology
  -> occurrence-local structural interface
  -> bypass routing
  -> delivery liveness and would-run projection
  -> wire-15 submission membership
```

No arrow points backward. In particular:

- Routing never reads liveness, submission membership, scope closure, or a
  previous compile pass.
- Liveness never adds, removes, reorders, or re-elaborates a port.
- Wire-15 membership filters a fixed structural interface. It never asks the
  elaborator to build a smaller "live" interface.
- Exact lowering and would-run display consume the same route and liveness
  derivation. Would-run is a projection policy, not a second topology walk.

This is a semantic change from the current compile-live evidence loop. It is
not a better fixed point. There is no fixed point.

## Terms

### Structural connectivity

Structural connectivity is persisted document topology, independent of
whether it can deliver at compile time. It includes:

- direct links whose target is a node input,
- net sinks targeting a node input,
- links that reach an input through a reroute, selector, widget tap, value
  source, or subgraph boundary, and
- occurrence-local input/output addresses projected through the existing
  `FamilyCrossing` abstraction.

A link from a muted source is still structural connectivity. A link ending at
an undriven reroute is still structural connectivity at its visible consumer.
Those links may later be dead, but the user can see them and they remain part
of structural interface materialization and positional routing.

### Materialized structural interface

The materialized structural interface is the ordered `ElaboratedInterface`
produced for one node occurrence from:

1. its normalized `NodeSchema`,
2. its occurrence-effective stored `values` and `dynamic` state, including
   family/choice overlays projected through subgraph occurrences, and
3. structural connectivity for that occurrence.

It contains static ports and every active recursive wire-15 port. Routing
uses only wireable, non-ghost, non-synthetic ports. Sections, growth rows,
trailing ghosts, and unmaterialized minimum-fill members remain editor
affordances and never take routing indexes.

Node mode is deliberately not an interface input. Muting or bypassing a node
changes route delivery, not the ordered ports visible on that node. Solved
types, compile scope, selector roll outcomes, and prior delivery results are
also forbidden interface inputs.

The implementation seam is
`packages/core/src/schema/elaborate.ts::elaborateInterface`. It remains the
only semantic definition of a node interface. The compiler's occurrence
adapter supplies occurrence overlays and structural `Connectivity`, invokes
that function once per occurrence, and caches the returned object. Port
resolution, bypass candidate enumeration, output indexes, value lowering,
link lowering, and wire-15 membership all consume that cached object. No
compile-local family scanner, target probe, candidate union, or liveness-only
`Connectivity` method may define another interface.

The editor may compute the same function in a different process tick, but it
must pass the same normalized schema, stored state, and structural
connectivity. Occurrence views use the same crossing and overlay inputs as
compile. "One implementation" means one materializer and one ordering rule,
not two functions expected to agree by tests.

For safe cache sharing, two structural `Connectivity` inputs are identical
only when every materializer-visible predicate has the same result and
`inputPorts()` returns the same ordered address sequence. Link object identity
and occurrence-qualified storage records do not matter after that projection.
The sequence order matters because it orders evidence-only members; the compile
adapter must make it deterministic and equal to the editor adapter's sequence.

## Exact materialization contract

### Static inputs and outputs

Static schema ports retain declaration order. Output indexes are their order
among all wireable elaborated outputs. Input indexes are their order among all
wireable elaborated inputs, including undriven inputs. Only driven inputs
become bypass candidates, but an undriven input still occupies its index.

### Wire-15 Autogrow families

A wire-15 family member exists structurally when the canonical elaborator
finds it in persisted document state or stored topology:

- the occurrence-effective `DynamicPortState.members` list,
- a stored value at a reachable leaf beneath the member,
- reachable nested dynamic state, or
- a structurally connected link/net target at a reachable leaf beneath the
  member.

Nested evidence counts only through active stored choices. State beneath an
inactive combo branch or inactive slot does not resurrect that branch.

The existing elaborator ordering is normative for the gate-removal slice:

1. explicit members in persisted `members` order,
2. evidence-only members in first-seen order from the materializer's one
   evidence stream: stored value paths, structural input paths, then dynamic
   state paths, and
3. recursive template entries in schema declaration order.

Duplicate suffixes retain their first position. Names-form suffix validation,
prefix/names capacity, recursive member and item budgets, and projected wire
name collision checks remain unchanged. Evidence-only order must be
characterized before implementation; changing it is a separate user-visible
bypass semantic change because positional matching observes it.

Every structurally materialized member occupies all of its emitted input
positions even when its only source later proves dead. This is the approved
dead-but-visible-link stance. A family exceeding its structural cap fails
loudly as `elab.autogrow.overMax`; compilation must not discard dead members
until the live subset fits.

Native free-suffix families remain inert at zero capacity. Their document
identity source is not part of this design.

### Recursive DynamicCombo entries

Wire-15 DynamicCombo state is explicit when stored. A valid stored `selected`
key materializes that option's entries recursively, in schema order. When the
selection is absent, the first ordered option is effective; descriptor defaults
do not participate. Fresh node materialization stores that first selection.
Legacy imported documents with absent state still materialize and submit the
same first choice without being rewritten merely by viewing. A user change
stores normal command state, and undo on a newly created node restores the
explicit initial choice. An invalid stored selection remains the anchored
`prompt.bad_dynamic_choice` error and never falls back. Inactive branch values
and nested state stay preserved in the document but do not enter the structural
interface.

The selector value itself remains a submission value at the construct path;
option keys never enter submitted input ids. Routing and lowering consume the
same active branch produced by `elaborateInterface`.

### DynamicSlot variants and open slots

Variant-form DynamicSlot is choice-driven. A valid stored variant selection
materializes the slot, shared dependents, and selected variant dependents in
schema order. Missing selection materializes none of them. An invalid choice
remains `prompt.bad_dynamic_choice`. No solved or upstream type may choose a
variant during compile.

An open-form DynamicSlot always materializes its base slot. Its dependents are
active when the base slot has a stored value or structural connectivity in
the occurrence. Source liveness does not matter. A link from a muted source
therefore keeps the dependents visible and keeps their positions. A stored
dependent beneath an inactive base slot remains
`compile.value.unknownInput`; a dependent link does not activate its parent
slot.

### Backend lazy-switch selector nodes

`NodeSelectorSpec` does not remove either branch input from the structural
interface. The decision input and both distinct static branch inputs retain
schema order. A stored boolean records a certain false/true branch choice for
would-run projection. A link-fed, missing, or non-boolean decision is neutral
and makes both branches maybe-live for display. Backend editing implementation accepts a link-fed
decision as a runtime selector, so the frontend submits it without a
capability gate; older backends expose incompatibility as a structured
lowering problem.

The decision link and both branch inputs continue to lower byte-for-byte into
the prompt. The backend remains the owner of lazy-switch lowering and
fingerprint semantics. The stored choice affects frontend would-run liveness
only; it is not a new client-side prompt-pruning pass.

## Bypass and mute semantics

### Positional matching generalized from wire 14

For every requested bypass output, enumerate candidates from the one cached
structural interface. The output index and every candidate index count all
wireable interface ports. Retain only candidates with a structural driver,
then apply the existing `matchBypassInput` tiers unchanged:

1. the same-index candidate when compatible with the final consumer type,
2. the first exact-type candidate, and
3. the first compatible candidate.

One v1 carve-out remains: a family-bound forwarded member whose only driver is
across `FamilyCrossing` keeps its interface index but is skipped as a
candidate. Other driven inputs may still match. `compile.bypass.unrouted`
results only if no remaining candidate matches.

The final consumer's declared type is carried through reroutes and every
bypass hop. Matching against an intermediate bypass output type is forbidden
because it can choose a different route than actual lowering.

The selected candidate is a routing fact. Liveness may prove that route dead,
but the compiler must not retry with the next candidate. Such a retry would
make routing read liveness and recreate the rejected self-reference.

Wire-14 schemas and normalized wire-15 single-value families continue through
the same matcher and must remain byte-stable.

### Muted nodes

A muted node contributes no prompt node and cannot deliver an output or tap
value. Connections touching it are dead and keep the existing dropped-link
policy. Its visible links still contribute structural connectivity to the
other endpoint before liveness is derived.

A muted subgraph occurrence is dead at its shell. Liveness does not descend
into its definition. The shell's parent-visible structural boundary remains
available for diagnostics and for materializing connected peers, but nothing
inside that occurrence becomes live.

### Bypassed nodes

A bypassed node contributes no prompt node. A consumer of one of its outputs
follows the structurally selected driven input. The trace may continue through
reroutes, graph selectors, taps, value sources, nets, a parent boundary, or
another bypassed node. A bypassed subgraph occurrence matches over its
parent-visible structural boundary interface and never descends into its
body, preserving wire-14 behavior.

Cycles remain loud `compile.bypass.cycle` errors. An output with no compatible
structurally driven input remains `compile.bypass.unrouted` and drops the
consumer edge.

### Dead structural route diagnostic

Option A intentionally permits a dead structural input to win positional
matching. When a structurally selected bypass route later dies because it
reaches a muted node, inactive occurrence shell, undriven junction, or other
non-delivering terminal, emit a warning named
`compile.bypass.structuralRouteDropped`. It identifies the bypass occurrence,
output, selected input address/index, and terminal reason. It explains that
the visible input retained positional priority and that disconnecting or
reordering it changes routing.

For a multi-hop chain, emit one warning at the first bypass occurrence reached
from the final consumer whose selected chain dies. Include the selected input,
the traversed bypass occurrences, and the final terminal reason; do not emit a
second warning for every upstream hop.

Derive this warning from exact submission delivery only. Do not emit it for a
hypothetical would-run random branch. If the selected chain crosses a random
graph-level selector, the injected exact queue choice can make the warning
appear or disappear between submissions; that is intentional because the
warning describes the route attempted by that submission.

This diagnostic is produced after route selection. It reports only the route
already selected; it must not probe alternate interfaces or silently claim
that another input would have delivered. Existing cycle, invalid-port,
unrouted, dropped-link, tap, selector, and reroute diagnostics remain the
authoritative errors for those conditions.

Repeated reports of this warning in ordinary workflows are one of the Option
C escalation signals listed below.

## One routed topology, two projections

The implementation should expose one liveness derivation in
`packages/core/src/compile/liveness.ts`. The exact API name may be chosen in
implementation, but this module owns one traversal over occurrence-qualified
routed edges. It consumes the cached structural interfaces, the bypass route
choices, node modes, selector decisions, and execution scope. It returns
successful deliveries, occurrence closure, and structural traversal records.
It does not materialize ports.

### Exact submission lowering

Exact compile requires one decision for every graph-level selector:

- fixed policy follows its fixed candidate,
- random policy uses the injected queue chooser, and
- invalid or undecidable policy remains a compile error.

Reroutes and graph-level selectors lower away. Bypass routes either reach a
real output, bake a value/tap literal, or die. Successful deliveries mark
their destination address as submission-live. Wire-15 membership then lowers:

- stored values/default behavior already attached to the fixed structural
  input of an included active node,
- explicit DynamicCombo selector values and selected DynamicSlot variant
  metadata from the structural interface, and
- links or baked literals only for successful destination deliveries.

A structurally present link-only family member whose link is dead still
occupied its routing position, but it contributes no submitted input unless
it also has an independently submitted stored value. No exact-pass
re-elaboration follows this filtering.

Autogrow `min` and `max` validate the structural member set, not the submitted
delivery subset. If two members satisfy structural `min: 2` solely through
links from muted sources, materialization passes, both links drop, and the
existing `compile.link.dropped` plus per-required-port
`compile.input.missing` warnings describe the delivery gap. The latter remains
a warning in I1, consistent with current wire-14 mute behavior. I1 must not
restore live-member `elab.autogrow.underMin`. If backend validation later
proves an aggregate submitted-member refusal necessary, add it as a terminal
membership check over the fixed interface and fixed delivery results. It must
never re-elaborate the family or change its route.

Backend lazy-switch nodes remain byte-preserving: both branch deliveries and
their full submitted cones remain in the exact prompt. The backend uses the
stored boolean to execute one branch. This design does not reinterpret its
wire bytes.

### Would-run projection

Would-run uses the same routed edges and delivery states, with two projection
rules:

- fixed graph-level selectors remain exact, while random graph-level
  selectors recursively union every candidate; and
- a backend lazy-switch node with a valid stored boolean follows only the
  selected branch for "would run" display. Neutral state unions both branches.

Random expansion is applied at every selector reached through every bypass
hop. It is never gated on an arbitrary exact random candidate. Branches that
end in another bypass, a tap literal, or a value source are traversed by the
same recursive route engine. The result records reroutes, selector candidates,
value sources, and occurrence-qualified nodes from that traversal.

An exact candidate may still be staged while constructing a discarded
would-run artifact, as current compile mechanics do. That staged artifact is
not the closure: whether it succeeds or dies cannot gate candidate expansion
or the returned would-run union.

Would-run does not produce a submittable artifact and does not choose
wire-15 membership. It projects the exact same route graph under "may run"
rules. No interface or route is rediscovered.

### Lazy-switch exclusive cones

The liveness result also carries, per `NodeSelectorSpec` occurrence, the
inactive branch's exclusive upstream occurrences. Derive it from the routed
graph as:

```text
inactiveExclusive = inactiveBranchCone
                    - selectedBranchCone
                    - every other live root cone in the requested scope
```

Thus a producer shared by both branches, or used elsewhere in the live scope,
does not dim. A nested selector composes by applying the same set derivation
recursively. Missing/non-boolean choice yields no inactive-exclusive set.
A muted, bypassed, out-of-scope, or otherwise dead `NodeSelectorSpec`
occurrence also contributes no inactive-exclusive set.

Canvas selection highlighting and lazy-switch cone dimming consume this one
result. Canvas code must not walk links or infer cones independently.
Branch-row dimming may continue to use the stored boolean directly because it
describes the selector node's own two rows, not an upstream liveness cone.

## Traversal rules

### Reroutes

Reroutes are transparent structural junctions. Follow their unique driver in
the owning graph definition. Record every traversed reroute in would-run
structural output. An undriven reroute terminates the selected route as dead;
a cycle remains `compile.reroute.cycle`.

### Widget taps

A driven tap aliases the tapped input's upstream route. An undriven tap ends
in the tapped node's stored literal and canonical tapped-input type. A muted
tapped node makes the route dead. Existing tap-cycle and missing/non-concrete
diagnostics remain. A baked tap value uses the same `$typed` capability and
asset-source rules as direct lowering.

### Value sources

A value source is a terminal literal and is recorded in would-run structural
output. It has no runtime type to guess; existing non-concrete destination
refusal remains. Value sources never become fake nodes or interface ports.

### Nets

A net is one structural source with independent delivery edges to each sink.
Every sink participates in its occurrence's structural connectivity. The
source route is evaluated with each final consumer type, so one fanout may
select different bypass inputs for differently typed consumers. A net sink
may also structurally drive a bypass candidate.

### Graph-level selectors

The selector output is a structural producer and each candidate has one
structural driver. Exact traversal follows the resolved candidate. Would-run
follows fixed choices and unions all random candidates. Traversal remains
recursive after a candidate reaches a bypassed output; it does not stop at the
first bypass shell. Candidate, reroute, tap, and value-source records retain
their actual graph-definition ownership.

### Backend lazy-switch nodes

These are ordinary node ports for routing and exact submission. The selector
metadata affects only would-run branch projection. Bypassing a lazy-switch
node therefore matches over all its structurally materialized inputs in schema
order, including decision and both branch ports if driven and type-compatible.
No special liveness-pruned bypass interface is allowed.

## Subgraph occurrence boundaries

Structural materialization is occurrence-local before routing:

1. Walk active graph occurrences outside-in.
2. Build family crossings and selector overlays with `crossing.ts`.
3. Merge definition prefix state with that occurrence's suffix state.
4. Project structural input/output addresses from the parent into that
   occurrence.
5. Materialize and cache each occurrence's interface.

Routing may climb an active static boundary input to its parent driver or
descend an active boundary output through the existing boundary route.
Family-bound forwarded member inputs whose driver is across a `FamilyCrossing`
remain non-candidates in I1, preserving the current v1 fail-closed behavior
and `compile.bypass.unrouted` result. I1 must not synthesize their driver with a
path parser or crossing-specific candidate probe.

A bypassed instance routes at the parent boundary and does not create a child
occurrence. A muted instance is dead at the parent shell. An active instance
whose inner route later reaches mute becomes dead during occurrence-aware
liveness, after the structural route is fixed.

Occurrences whose schema, occurrence-effective state, and structural
connectivity inputs are identical may share one immutable interface cache
entry. Occurrences with different overlays or projected connectivity never
share that entry. Route state, liveness sets, runtime ids, and diagnostics are
always keyed by full occurrence path. No child result flows back into parent
interface materialization, and no cross-occurrence fixed point exists.

## Invariants and proof obligations

The gate-removal implementation is correct only if all of these hold:

1. **One interface:** every routing index and lowering address comes from the
   same cached `ElaboratedInterface` returned by `elaborateInterface`.
2. **Structural-only inputs:** that materializer receives schema, stored
   occurrence state, and structural connectivity only. No `liveInputPorts`,
   successful-delivery set, scope closure, or previous-pass evidence affects
   it.
3. **Route before liveness:** `matchBypassInput` is called with candidates in
   the cached interface order before any candidate delivery is classified.
4. **No fallback on death:** liveness cannot replace a selected candidate.
5. **No interface mutation:** liveness and membership return sets/maps; they
   never invoke an interface probe or append a candidate.
6. **One liveness traversal:** exact delivery, would-run union, structural
   highlight records, and lazy-switch exclusive cones come from one routed
   graph implementation.
7. **Occurrence locality:** route and liveness keys contain the full occurrence
   path. Overlaid interfaces are occurrence-keyed; only immutable interfaces
   with identical schema/state/connectivity inputs may share a cache entry.
   Boundary translation uses existing crossings.
8. **Wire-14 stability:** documents without recursive wire-15 materialization
   produce byte-identical prompts. Through I1, their would-run closures remain
   unchanged. Diagnostics may add `compile.bypass.structuralRouteDropped` only
   when an already-selected structural bypass route dies. I2 intentionally
   changes would-run display for a stored-boolean lazy-switch node, regardless
   of its schema wire version, while keeping prompt bytes unchanged.
9. **Fail closed:** malformed structural state, capacity overflow, ambiguous
   boundary translation, or routing cycles produce existing loud diagnostics,
   never a partial prompt assembled from a truncated interface.

The corresponding dependency proof is simple. Let `S` be the immutable set
of structural interfaces, `R = route(S)`, `G` be graph-level selector
resolution sets, `P` be stored lazy-switch projection choices, and
`L = deriveLiveness(S, R, modes, G, scope, projectionPolicy)`. Exact `G`
contains one fixed/rolled candidate; would-run `G` contains every eligible
random candidate. `P` is read only while adding would-run/exclusive-cone fields
to `L`; it cannot affect exact successful deliveries. Finally,
`M = membership(S, L.exactDeliveries)`. `route` has no parameter for `L`, `M`,
`G`, or `P`; liveness cannot change `S` or `R`; and membership is terminal.
Therefore no self-reference or convergence pass remains.

## Rounds 3-9 counterexample audit

The rejected slice-76 history remains mandatory regression context.

### Round 3: bypass-hop evidence and provisional boundary connectivity

Failure: a link-only wire-15 family input selected inside a bypass hop was not
recorded as terminal evidence, so it disappeared in the exact pass. Projected
subgraph connectivity was also hidden by an empty provisional live set.

Why it cannot recur: the hop input and projected boundary address are in `S`
before routing. They do not need successful-delivery evidence and cannot
disappear after routing. There is no provisional live connectivity method.

### Round 4: multi-hop/fanout and delayed evidence commitment

Failure: tests could pass while retaining only one hop or eagerly committing a
dead hop, allowing evidence mutation to reshape a later pass.

Why it cannot recur: route traversal is an occurrence-qualified graph whose
every hop is fixed from `S`; fanout has independent delivery edges. Dead or
live classification changes only `L`. There is no evidence commit and no
later interface pass to observe one.

### Round 5: random would-run branches losing bypass evidence

Failure: hypothetical selector branches discarded bypass evidence, so their
family members vanished and their producers fell out of the may-run superset.

Why it cannot recur: would-run expands every random candidate over the same
fixed `S` and recursively follows each candidate's bypass routes. It unions
terminal deliveries and traversal records without producing interface
evidence.

### Round 6: a newly live route losing its wire-15 destination

Failure: after a dead preferred input disappeared, a fallback became live, but
the wire-15 destination had already disappeared. Two passes could not
converge, and longer chains required more passes.

Why it cannot recur: the dead preferred input never disappears. It keeps
positional priority, so the route deterministically dies and emits
`compile.bypass.structuralRouteDropped`; it does not switch to the fallback.
The destination also remains in `S`. This is Option A's intentional semantic
answer, not a convergence attempt.

### Round 7: dead-link capacity poisoning and baked-value would-run loss

Failure: structural discovery exceeded family capacity on dead links and
hid the live target; would-run ignored bypass traces ending in tap/value-source
literals.

Why it cannot recur: all visible structural members count. Over-cap state is a
deterministic `elab.autogrow.overMax` refusal before routing, not an empty
approximate interface or silently wrong prompt. Tap and value-source terminals
are first-class routed delivery outcomes in the one liveness traversal and are
recorded in would-run output.

### Round 8: relay capacity poisoning and selectors hidden behind bypass

Failure: a bypassed relay used an aggregate interface while destination probes
used target-local interfaces; over-cap dead members prevented discovery. A
random selector reached after entering bypass tracing collapsed to one branch.

Why it cannot recur: relay and destination use the same complete structural
materializer. Over-cap relays refuse loudly. Would-run selector expansion is
recursive at every bypass hop and preserves all candidate terminals and
structural records.

### Round 9a: arbitrary exact random choice controlled would-run

Failure: would-run first attempted an arbitrary exact candidate; if that
candidate was dead, other candidates and nested bypasses were never explored.

Why it cannot recur: would-run does not require an exact random candidate. It
expands all random candidates directly in the routed graph, including a branch
whose terminal is another bypassed node. A discarded staged artifact may use
one exact candidate, but closure expansion never depends on its result.

### Round 9b: independent probes lost interface order

Failure: candidate inputs independently probed and appended in link order no
longer had coherent interface indexes, so positional matching chose the wrong
input.

Why it cannot recur: candidate order and indexes are read only from the one
cached `ElaboratedInterface`. Target probes and candidate unions are forbidden.

### Round 9c: direct-mode filtering missed occurrence-aware death

Failure: filtering only a terminal node's direct mode missed death through an
active boundary or nested bypass; a target probe then resurrected the dead
member on every iteration.

Why it cannot recur: routing does not filter dead candidates at all.
Occurrence-aware liveness follows the already selected route through boundary
shells and nested bypasses, classifies its final outcome, and cannot feed that
classification back into the interface.

## Option C escalation criteria

Option A is accepted unless positional structural routing is materially more
surprising than the visible-link explanation and diagnostics can support.
Escalate to a joint frontend/backend Option C decision only with reproducible
evidence of one or more of these patterns:

- A dead structurally connected family member repeatedly wins a same-index or
  first-compatible match and drops an output users reasonably expect a later
  visible input to carry.
- A structurally present but undriven member shifts indexes often enough that
  unrelated edits reroute bypass outputs in a way canvas order does not make
  understandable.
- Dead visible members make otherwise useful workflows exceed wire-15 family
  capacity, and explicit cleanup is not an acceptable product behavior.
- Definition-prefix edits or occurrence-local suffix ordering cause sibling
  subgraph occurrences to route different inputs in a way users cannot
  predict from each occurrence's visible interface.
- `compile.bypass.structuralRouteDropped` is common in ordinary imported
  workflows or cannot identify an actionable visible cause.

The evidence package must include the document, both visible interface orders,
selected output/input indexes, types, occurrence path, and expected behavior.
Do not implement id/type matching locally. Option C changes user-visible
bypass semantics and requires backend parity; the frontend orchestrator must
relay that recommendation to the backend coordinator.

## Implementation plan for delegates

The slices are sequential. Do not parallelize files that define routing or
liveness.

### Implementation slice I1: atomic gate removal in core

Owner: one delegate across `packages/core/src/schema/elaborate.ts`,
`packages/core/src/compile/compile.ts`, `packages/core/src/compile/bypass.ts`,
the intended `packages/core/src/compile/liveness.ts`, and focused core tests.

Required work:

1. Characterize the structural member/evidence order and occurrence overlays
   in focused elaboration tests before behavior changes.
2. Remove compile-time `liveInputPorts`/`isLiveInputConnected` interface
   overrides and the recursive `compileImpl(...liveEvidence...)` pass.
3. Cache one structural elaboration per occurrence and make port resolution,
   output indexing, bypass candidate enumeration, and node lowering consume
   it.
4. Build route outcomes from that cache, retaining final-consumer typing and
   all existing reroute/tap/value-source/net/boundary behavior.
5. Add one liveness derivation for exact deliveries and would-run random
   supersets. Wire wire-15 membership to successful destination deliveries
   without re-elaboration.
6. Add `compile.bypass.structuralRouteDropped` after route death.
7. Delete the `compile.wire15.modesUnsupported` preflight only after all proof
   tests pass. Keep region and unrelated fail-closed gates unchanged.

Proof obligations for I1:

- Two structurally identical occurrences produce identical interface orders
  even when one source is muted.
- Changing a source from active to muted changes liveness/membership but not
  the selected bypass candidate or any interface index.
- Multi-hop bypass, fanout, nets, reroutes, driven/undriven taps, value
  sources, fixed selectors, random would-run selectors, and bypass cycles are
  proven with recursive wire-15 families at both relay and destination.
- A dead first structural route does not fall back; it warns and leaves the
  consumer unset.
- Structurally over-cap dead members refuse loudly rather than hide a live
  member.
- Structural minimums remain structural: a minimum satisfied only by dead
  links does not trigger live-member re-elaboration, and the existing dropped
  link plus required-input warnings are proven.
- Active boundary death, bypassed/muted shells, chained boundaries, and two
  sibling occurrences with different overlays are occurrence-correct.
- Family-bound forwarded members remain non-candidates across a crossing and
  fail closed as unrouted; no crossing-specific candidate probe appears.
- Exact and would-run use the final consumer type through every bypass hop.
- Wire-14 prompt and closure golden behavior remains byte-identical.
- No code path can call `matchBypassInput` with candidates assembled outside
  the cached structural interface.

Existing refusal tests in `packages/core/test/compile.test.ts` convert as
follows:

- "refuses exact and would-run wire-15 lowering when a root node is bypassed"
  becomes a positive exact prompt plus `scopeClosure` proof. Split its current
  `UnknownAfterGate` sentinel into a separate assertion that ordinary
  post-preflight diagnostics now surface; a positive fixture cannot retain an
  intentionally unknown node.
- "refuses wire-15 lowering for a muted node in a reachable nested
  definition" becomes a positive occurrence proof: the nested muted node is
  absent while the unrelated root wire-15 value lowers.
- "invalidates a clean wire-15 compile after a node becomes bypassed" becomes
  a positive before/after route proof with the bypassed node removed from the
  prompt and its consumer rewired.
- "uses compile-live links as wire-15 family evidence and gates muted
  evidence" becomes the dead-but-visible proof: active source submits the
  member; muted source compiles without the gate, keeps structural position,
  and submits no dead link value.
- "shares reroute and net delivery semantics while gating wire-15 bypass"
  keeps the reroute/net assertions and replaces the final refusal with a
  positive bypass delivery assertion.

The existing wire-14 byte-identity and normalized wire-15 value-family tests
remain unchanged and must stay green.

### Implementation slice I2: lazy-switch would-run projection

Owner: one dependent delegate after I1, focused on the shared liveness result,
`ScopeClosure`/canvas consumption, and tests in core, canvas, and app.

Required work:

1. Carry stored `NodeSelectorSpec` choices into would-run projection without
   changing exact prompt bytes.
2. Return inactive-exclusive occurrence sets from the I1 liveness module.
3. Dim only inactive-exclusive upstream cones; preserve shared producers and
   producers live from another scope root.
4. Keep missing/non-boolean choices neutral and both branches maybe-live.
5. Prove nested lazy switches, bypass on either branch, recursive wire-15
   destinations, reroutes, taps, value sources, nets, and subgraph occurrences.

This slice flips the deferred "Lazy-switch selector would-run/liveness
projection" row only when its tests land. It must not add a canvas-side link
walker.

### Implementation slice I3: review and Option C evidence audit

After I1 and I2, run an Oracle review over the combined diff and execute the
rounds 3-9 fixture matrix as a group. Audit the new structural-route warning
on realistic imported workflows. Compare occurrence-local materialized inputs
and their order against the actual canvas for definition-prefix and
occurrence-suffix state; the current occurrence-view path does not by itself
prove projected-connectivity parity. If an Option C trigger fires, stop and
record the evidence; do not improvise a frontend-only matching rule.

## Explicit deferrals and revival triggers

- **Option C id/type matching:** deferred. Revives only when the escalation
  evidence above is accepted as a joint frontend/backend semantic change.
- **Native free-suffix wire-15 families:** deferred under the existing promise.
  Revives when a persisted suffix identity and ordering contract is approved.
- **Client-side lazy-switch prompt pruning or fingerprint changes:** deferred
  indefinitely to backend ownership. Revives only through a new joint wire
  contract; I2 changes display, not submitted bytes.
- **Automatic removal/reordering of dead structural links:** deferred. Revives
  only as an explicit undoable editor command; compile never mutates the
  document to improve a route.
- **Alternate-route suggestions:** deferred. The first diagnostic reports the
  selected route only, avoiding a second routing scan. Revives if users need a
  review UI and it can consume routes already enumerated by the canonical
  engine without defining another interface.
- **Family-bound member-input climb:** deferred at the current v1 fail-closed
  behavior. Revives only with a dedicated `FamilyCrossing` routing design and
  tests proving one canonical driver mapping without a candidate probe.
- **Region occurrence bypass:** unchanged and deferred under the regions
  program. This design must not remove `compile.region.loweringRequired` or
  claim region routing support.

## Oracle review record and open questions

The mandatory design review is recorded here so no finding can disappear.
Each round must answer this explicit question: "does any path reintroduce
liveness-dependent routing or a second approximate interface definition?"

### Round 1

Explicit answer: no stated path reintroduces liveness-dependent routing or a
second approximate interface. Three handoff blockers and four nonblocking
ambiguities were found. All are resolved in this revision:

1. **Cache locality:** the first draft required a distinct interface cache
   entry for every sibling occurrence, contradicting the safe existing shared
   definition cache. Resolution: immutable entries may be shared only when
   schema, effective state, and structural connectivity inputs are identical;
   route/liveness state remains occurrence-keyed.
2. **Post-filter family minimum:** the first draft did not say whether a
   structural minimum had to be rechecked after dead links were filtered.
   Resolution: min/max are structural-only. Current dropped-link and
   required-input warnings are accepted in I1; any future aggregate refusal is
   terminal membership validation and cannot re-elaborate.
3. **Family-bound member climb:** the first draft could be read as extending
   boundary climbing through `FamilyCrossing`, despite current v1 fail-closed
   behavior. Resolution: those members remain non-candidates in I1 and the
   extension is explicitly deferred.
4. **Editor parity:** occurrence overlays alone do not prove that canvas and
   compile supply identical projected connectivity. Resolution: I3 must audit
   actual canvas order against compiled occurrence interfaces.
5. **Multi-hop warning attribution:** "the bypass occurrence" was ambiguous.
   Resolution: emit one `compile.bypass.structuralRouteDropped` at the first
   bypass occurrence encountered from the final consumer whose selected chain
   dies, including the selected input and terminal reason.
6. **Discarded would-run staging:** an implementation could over-delete the
   existing arbitrary staged artifact. Resolution: staging may remain, but
   closure expansion cannot depend on it.
7. **Missing-input severity:** `compile.input.missing` is currently a warning.
   Resolution: I1 retains that severity, matching wire-14 mute behavior.

No round-1 finding remains open. API type names and file-local decomposition
may change during implementation only if the one-interface and one-liveness
boundaries above remain intact.

### Round 2

Explicit answer: no path reintroduces liveness-dependent routing or a second
approximate interface. One proof wording blocker and five nonblocking
clarifications were found. All are resolved in this revision:

1. **Wire-14 stability scope:** the first revision promised unchanged
   diagnostics and would-run closures while also adding a general route-death
   warning and later lazy-switch projection. Resolution: prompt bytes remain
   stable; the one additive warning and I2's display-only projection are named
   exceptions.
2. **Selector choice roles:** the proof formula conflated graph-level choices
   that affect exact delivery with backend lazy-switch booleans that affect
   display only. Resolution: `G` and `P` are separate, and `P` cannot affect
   exact deliveries or membership.
3. **Cache identity:** "identical connectivity" was vague. Resolution:
   identity means equal materializer-visible predicate results plus the same
   ordered `inputPorts()` sequence; editor/compiler order parity is required.
4. **Route-death warning policy:** would-run hypothetical branches could have
   spammed warnings. Resolution: the warning uses exact submission delivery;
   its dependence on an injected exact random roll is intentional and
   recorded.
5. **Dead lazy-switch cones:** dead selector occurrences were unspecified.
   Resolution: they contribute no inactive-exclusive set.
6. **Forwarded-member candidate wording:** "non-candidate" could have implied
   unconditional failure. Resolution: the port keeps its interface index but
   is skipped; other candidates may match, and only no match is unrouted.

No round-2 finding remains open. The Oracle recommended only a spot-check of
these edits before handoff.

### Round 3 spot-check

The Oracle verified all round-2 edits against the normative sections and found
no unresolved issue. Explicit answer: no path reintroduces
liveness-dependent routing or a second approximate interface. The design is
approved for handoff to implementation slice I1; no further design round is
required.

### I3 combined implementation and Option C audit

The combined implementation review used base
`c5d2d4b40189f59831388354ef0ca99c7c04bf40` through I1 `611666d`, I2
`fa7a825`, and the closure-cache follow-up `b56ab3b`. Explicit answer: no path
reintroduces liveness-dependent routing or a second approximate interface
definition. `traverseRoutedProjection` remains the sole recursive route
engine, `selectBypassHop` remains the sole `matchBypassInput` caller and
candidate enumerator, would-run projection does not mutate submitted prompt
inputs, and the app cache includes resolver identity.

The review found one implementation blocker unrelated to Option C: NUL-
delimited occurrence-path and selector-override keys were not injective even
though document ids may contain NUL. I3 replaced those keys and routed-vertex
keys with JSON tuple encodings. The named adversarial tests "keeps
NUL-containing occurrence paths distinct during structural routing" and
"keeps colliding NUL-containing definition and selector pairs distinct" pin
both collision classes; the occurrence test was also run against the old key
expression and failed. Final review found the same delimiter defect in the
app closure cache's graph-feature sequence; JSON sequence encoding and test
"keeps NUL-containing graph-feature sequences distinct in the closure cache"
resolved it. Resolver function identity remains an independent cache-key
component.

The required rounds 3-9 fixture matrix is executable coverage, not a
source-inspection argument:

| Round | Counterexample summary | Proving test file and named test | Status |
| --- | --- | --- | --- |
| 3 | A link-only family input selected inside bypass and projected boundary connectivity disappeared before exact routing | `packages/core/test/compile-bypass.test.ts`: "Real two-occurrence compile fixture: structurally identical sibling subgraph occurrences preserve materialized input order/index semantics and differ only in delivery membership" | pre-existing |
| 4 | Multi-hop or fanout retained only one hop, or eager evidence mutation reshaped a later pass | `packages/core/test/compile-bypass.test.ts`: "Recursive wire15 successful multi-hop route preserves reroute, net fanout, relay, and destination semantics" | pre-existing |
| 5 | Random would-run branches lost bypass evidence and their producers left the may-run closure | `packages/core/test/compile-bypass.test.ts`: "Recursive wire15 named-net fanout keeps every random selector branch in would-run closure" | pre-existing |
| 6 | A dead preferred input vanished, fallback became live, and the original wire-15 destination had already vanished | `packages/core/test/compile-bypass.test.ts`: "keeps a dead first structural wire-15 route selected without fallback and warns" and "attributes one multi-hop structural route death to the first bypass occurrence" | pre-existing |
| 7 | Dead links poisoned capacity, while would-run lost bypass traces ending in tap or value-source literals | `packages/core/test/compile-forwarding.test.ts`: "dead structural members exceed cap while a later live member exists: elab.autogrow.overMax and no trimmed prompt"; `packages/core/test/compile-bypass.test.ts`: "records child-owned selector reroute and value source under the child definition" plus the dedicated driven tap, undriven tap, and value-source terminal tests | would-run assertions added in I3 |
| 8 | Relay and destination used different interfaces, and a selector reached behind bypass collapsed to one branch | `packages/core/test/compile-bypass.test.ts`: "Over-cap bypassed wire15 relay refuses before routing to its destination interface" and "Recursive wire15 named-net fanout keeps every random selector branch in would-run closure" | over-cap relay proof added in I3 |
| 9a | Would-run depended on an arbitrary exact random candidate and stopped when that candidate was dead | `packages/core/test/selector.test.ts`: "random policy needs NO chooser and widens to EVERY candidate (may-run superset)" and "random policy expands reroutes on EVERY branch" | pre-existing |
| 9b | Independent link-order probes destroyed coherent interface order and positional matching | `packages/core/test/elaborate.test.ts`: "orders wire-15 explicit members before value, structural, and dynamic evidence" and "keeps structural wire-15 interface order independent of source mode"; `packages/canvas/test/dynamic-scene.test.ts`: "matches compiled structural input order to canvas-visible definition prefixes and occurrence suffixes" | parity proof added in I3 |
| 9c | Direct terminal-mode filtering missed occurrence-aware death through boundaries or nested bypass | `packages/core/test/compile-forwarding.test.ts`: "I1 obligation 7: active boundary death, bypassed shell, chained boundaries, and sibling overlays stay occurrence-correct" | pre-existing |

The realistic LiteGraph import audit is pinned by
`packages/core/test/import-litegraph.test.ts` test "imports and compiles
structural bypass drops with exact first-hop attribution and no live-route
warning". It imports reconstructed wire-15 family endpoints and node modes,
then compiles both live and muted-first variants. The warning appears only in
the exact muted route, is anchored to the first bypass occurrence, names input
index 0, carries the concrete muted-producer terminal reason, does not fall
back, and is absent from the live route.

Occurrence parity is pinned by
`packages/canvas/test/dynamic-scene.test.ts` test "matches compiled structural
input order to canvas-visible definition prefixes and occurrence suffixes".
For the same occurrence, the definition-local prefix and rebased
occurrence-local suffix are compared port for port and in order against the
compiler's emitted input provenance. This closes the projected-connectivity
gap that the occurrence-view-only proof left open.

No Option C escalation trigger fired. The imported workflow produced no
spurious live-route warning; visible definition-prefix and occurrence-suffix
order matched compilation; the matrix found no common ordinary-workflow route
drop, unpredictable sibling reroute, or unacceptable structural-capacity
case. The NUL key collision was a localized identity bug and did not change
the accepted Option A positional semantics.

Final Oracle re-review verdict: APPROVE, with no remaining findings. It
confirmed the standing answer remains no, single traversal and candidate
ownership remain intact, would-run remains exact-prompt byte neutral, all
occurrence/resolver/feature cache identities are sound, and Option C remains
deferred because no escalation trigger fired.
