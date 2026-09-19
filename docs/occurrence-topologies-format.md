# Occurrence-local topology format

This document summarizes the persisted format and shipped behavior from the
[drilled occurrence topology design](archive/drilled-occurrence-topology-design.md).
The reviewed design is commit `a1456c63c4dd355877a98d3d9af8caf192aef3e8`.
The program now includes format and identity, effective compile, occurrence
commands, scene projection, automatic compaction, definition guards, root
clipboard remapping, root flatten materialization, and production UI wiring.
Extract remapping, drilled flatten specialization, and LiteGraph materializing
interchange remain deferred with revival triggers in the design and promise
ledger.

## Version policy

Dinkster is unreleased, so workflow format v1 is revised in place. The format
version remains `1` and there is no v2 reader, migration entry, save-time
upgrade, or downgrade path. `occurrenceTopologies` is optional. A v1 document
without it loads and serializes unchanged.

## Root map and owner identity

`WorkflowDocument.occurrenceTopologies` is a record of sparse overlays. Its
key is the existing `occurrenceKey(owner)`, but the structural owner record is
authoritative:

```ts
interface OccurrenceRef {
  readonly instancePath: readonly NodeId[]
  readonly node: NodeId
}

interface OccurrenceTopology {
  readonly owner: OccurrenceRef
  readonly bodyGraph: GraphDefId
  readonly links: Readonly<Record<string, OccurrenceLinkData>>
  readonly suppressedDeliveries?: readonly SuppressedDelivery[]
  readonly nextOrdinal: number
  readonly actorCursors?: Readonly<Record<string, number>>
  readonly ext?: ExtData
}
```

Validation regenerates the map key from `owner`; it never parses a persisted
key. The owner path must resolve through subgraph occurrences, and its current
body definition must equal `bodyGraph`. For example, root occurrence `s` and
nested occurrence `i` under `s` have distinct owners and keys:

```text
{ instancePath: [], node: "s" }       -> s
{ instancePath: ["s"], node: "i" }  -> s.i
```

## Local links and endpoints

Each topology owns a link record. Link keys equal link ids, and ids are unique
only within that owner topology.

```ts
interface OccurrenceLinkData {
  readonly id: LinkId
  readonly from: OccurrenceLinkEndpoint
  readonly to: OccurrenceLinkEndpoint
  readonly ext?: ExtData
}
```

A `body` endpoint is an ordinary `LinkEndpoint` in `bodyGraph` coordinates.
Dynamic member ids in it are definition-owned ids. Derived NUL-prefixed
projection ids are never persisted.

A `boundary` endpoint stores an address on the owner occurrence or one of its
ancestors. Its nonempty route records each exact boundary hop, outermost
first:

```ts
interface BoundaryRouteLeg {
  readonly graph: GraphDefId
  readonly boundaryId: string
  readonly binding: BoundaryBinding
}

type OccurrenceLinkEndpoint =
  | { readonly kind: "body"; readonly endpoint: LinkEndpoint }
  | {
      readonly kind: "boundary"
      readonly occurrence: OccurrenceRef
      readonly address: {
        readonly port: PortId
        readonly members?: readonly DynamicMemberId[]
      }
      readonly route: readonly BoundaryRouteLeg[]
    }
```

Route identity compares canonical boundary bindings. Unordered `slots` are
sorted for comparison, ordered dynamic member paths stay ordered, and every
exposure-changing binding field participates. A reordered fan-out list stays
valid; rebinding, an ambiguous address, a removed materialized member, or a
changed crossing fails closed. Bindings do not gain separate persisted ids.
Document ingress reports `doc.occurrenceTopology.routeInvalid` when a saved
boundary route is stale or no longer reaches the body graph.

## Suppressions

The overlay can hide one shared body delivery or one projected parent leg:

```ts
type SuppressedDelivery =
  | { readonly kind: "link"; readonly linkId: LinkId }
  | { readonly kind: "netSink"; readonly netId: NetId; readonly to: PortRef }
  | {
      readonly kind: "projectedLeg"
      readonly delivery: ParentDeliveryIdentity
      readonly route: readonly BoundaryRouteLeg[]
    }
```

A body link tombstone may survive deletion because graph link ids are never
reused. A body net-sink suppression must still name its exact current sink;
net-sink removal commands remove matching suppressions atomically.
A projected-leg suppression includes the parent graph delivery identity and
one exact route so sibling fan-out legs remain visible.

Suppression arrays are sorted and deduplicated by structural identity. The
field is omitted when empty. Route order and dynamic member order are never
reordered.

## Allocation and empty overlays

`nextOrdinal` allocates solo local link ids. `actorCursors` allocates
actor-suffixed ids in shared sessions. The same floor rule as graph invariant
I6 applies: every allocated ordinal is strictly below its cursor. Undo never
rewinds either cursor.

A never-allocated empty overlay is omitted. Once either cursor advances, an
empty owner/body/links skeleton remains so an old id cannot be reused. Its
`bodyGraph` must continue to match the resolved owner body; changing the body
while retaining allocated identity fails closed.

## Effective topology and compile

`effectiveOccurrenceTopology(document, resolver, owner)` is the one
pure execution-facing projection. It resolves the concrete owner path, reuses
the family crossing and occurrence dynamic-view machinery, and returns shared
definition links, named-net sink deliveries, occurrence-local links, projected
parent aliases, and diagnostics. Resolved endpoints retain their persisted
source coordinate so scene and command callers can dispatch to the real
owner rather than copying parent links into an overlay.

Shared link and net-sink suppressions remove only their named body delivery.
Boundary endpoints walk every recorded route leg by canonical binding identity;
zero or multiple current matches fail closed. Parent fan-out aliases retain the
parent delivery identity. A `projectedLeg` suppression is consulted while that
parent delivery resolves and removes only the exact recorded route, never its
sibling bindings. Projected aliases are not lowered by the child pass.

Compile derives structural indexes per graph occurrence, not per definition.
Connectivity, reroute and selector routing, widget taps, bypass input lookup,
would-run projection, and final lowering therefore see the same effective
connection set. A local reroute driver composes with definition-owned consumers
in both compile and semantic hashing. Documents without
`occurrenceTopologies` retain the existing prompt and artifact bytes.

Proof is in `packages/core/test/effective-occurrence-topology.test.ts`, with
the pre-existing direct, forwarded, whole, grouped, nested, and chained
crossing matrix retained in `packages/core/test/compile-forwarding.test.ts`.

## Command and lifecycle semantics

The command registry includes `occurrence.link.connect`,
`occurrence.link.disconnect`, `occurrence.link.rewire`, and
`occurrence.link.rewireSource`. Callers do not construct their trusted fields.
`planOccurrenceLinkMutation()` accepts a structural intention and returns one
opaque invocation containing an `occurrence-link-plan-v1` plan, an exact
schema snapshot, an owner-scoped topology fingerprint, and a digest over all
three. Initial dispatch and shared replay rebuild and compare the plan using
only that snapshot. Missing, extra, stale, ambiguous, or digest-mismatched
evidence refuses before mutation.

Occurrence connects replace the effective driver according to its owner. A
local driver is removed, a shared link or net sink is suppressed, and one
projected parent fan-out leg receives a route-qualified suppression. An
unchanged suppressed shared delivery is restored by removing its suppression.
Definition-only connections continue to use `link.connect`. Converting an
unexposed projected parent delivery into local ownership refuses.

Local target and source rewires retain their link id. Rewiring a shared
delivery forks it for one occurrence by suppressing the shared identity and
allocating a local replacement. Every gesture is one command transaction and
one undo record. Solo and actor-scoped cursors remain monotonic through undo;
an allocated-empty topology skeleton is retained, so deleted ids are never
reused.

Definition-level commands cannot commit a crossing change that would leave a
persisted route stale: the transaction invariant gate refuses it without
changing the document. Commands that remove a projected parent delivery also
remove its matching suppression. Serialized documents remain an untrusted
ingress, so loading validates the complete saved topology. A projected-leg
suppression whose delivery is missing reports
`doc.occurrenceTopology.suppressionDangling`; when the delivery still exists
but its saved route has no unique current match, loading instead reports
`doc.occurrenceTopology.routeInvalid`.

`dynamic.compact` includes occurrence link endpoints in its reference scan.
A member referenced by any overlay is retained, and an unresolved overlay
causes compaction to fail safe without removing members. Trigger policy stays
in the interaction layer: occurrence commands do not add an automatic
compaction trigger. The trailing ghost remains derived and exactly one is
offered below capacity; it is never stored in an overlay.
