# Drilled occurrence-local topology design

Status: implemented through the root transform boundary. Native overlays,
effective compile, trusted occurrence commands, drilled canvas projection,
automatic disconnect compaction, root clipboard remapping, and root flatten
materialization are shipped. The deferred transform boundaries and their
revival triggers are recorded below.

## Release closure

The format remains `formatVersion: 1`. The release matrix is pinned as follows.

| Matrix row | Proving test |
| --- | --- |
| Native save/open/import and no-overlay byte identity | `packages/core/test/occurrence-topology.test.ts` - `round-trips overlay-bearing documents and leaves absent-field bytes unchanged` |
| Clipboard v3 owner-subtree remap and closure/duplicate refusal | `packages/core/test/clipboard.test.ts` - `copies a closed occurrence topology subtree with fresh owner and link ids`, `refuses every v3 occurrence topology closure violation by name`, the three `rejects duplicate source ... ids` tests, and `rejects duplicate occurrence topology owners in a v3 envelope` |
| Extract fail-closed intersection | `packages/core/test/subgraph-lifecycle-planner.test.ts` - `extract refuses a selection intersecting an %s` |
| Flatten materialization, compile equivalence, and unsupported contexts | `packages/core/test/subgraph-lifecycle-planner.test.ts` - `materializes the selected occurrence effective topology while preserving a sibling overlay` and `refuses unsupported occurrence overlay flatten contexts by name` |
| LiteGraph import refusal | `packages/core/test/import-litegraph.test.ts` - `refuses a legacy workflow carrying an occurrence topology overlay` |
| Concurrent sibling isolation | `packages/core/test/occurrence-link-commands.test.ts` - `isolates sibling occurrences and keeps definition edits shared` |
| Definition edits never steal occurrence links | `packages/core/test/occurrence-link-commands.test.ts` - `guards every occurrence-referenced definition entity deletion path` and `guards replacement and every definition driver displacement path` |
| Compile equivalence | `packages/core/test/effective-occurrence-topology.test.ts` - `lowers a local replacement only in its owning occurrence` and `keeps no-overlay compilation byte-identical` |
| Exactly one trailing ghost after compaction | `packages/core/test/occurrence-link-commands.test.ts` - `keeps occurrence-referenced members during compaction and derives one trailing ghost` |
| Shared replay, including disconnect plus compaction | `packages/app/test/occurrence-planner-wiring.test.ts` - `disconnects and compacts an occurrence-owned member in one replayable undo record` |

### Definition-edit command audit

Every command that can remove, replace, or rewire an entity named by an
occurrence overlay has one of three outcomes: an explicit occurrence guard,
targeted suppression cleanup, or the ordinary invariant gate which rejects the
whole transaction before commit.

| Commands | Guard or refusal path | Proving test |
| --- | --- | --- |
| `node.remove`, `graph.deleteItems`, `reroute.remove`, `valueSource.remove`, `selector.remove` | `occurrenceDeletionConflict` refuses with `occurrence.topology.definitionReferenced` | `packages/core/test/occurrence-link-commands.test.ts` - `rejects definition deletion while a local endpoint references the node`; `guards every occurrence-referenced definition entity deletion path` |
| `node.replace` | Replacement preflight scans both local endpoints with `occurrenceEndpointReferencesDefinition` and refuses with `occurrence.topology.definitionReferenced` | `packages/core/test/occurrence-link-commands.test.ts` - `guards replacement and every definition driver displacement path` |
| `link.connect`, `link.rewire`, `net.connectInput` | `occurrenceDriverConflict` refuses any target already driven by an occurrence link with `occurrence.topology.definitionReferenced` | `packages/core/test/occurrence-link-commands.test.ts` - `allows ordinary edits to distinct members while occurrence and whole-family drivers stay guarded`; `protects boundary-backed occurrence targets from shared driver edits`; `guards replacement and every definition driver displacement path` |
| `link.rewireSource` | Source-only rewire preserves link identity and cannot displace an occurrence-owned target driver | `packages/core/test/occurrence-link-commands.test.ts` - `guards replacement and every definition driver displacement path` |
| `link.disconnect`, `reroute.insert`, `net.disconnectInput`, `net.remove`, node/delete cascades, and link/net replacement internals | `removeDefinitionLink`, `removeProjectedLinkSuppressions`, and `removeNetDeliverySuppressions` remove only projected suppressions for deleted deliveries; stable shared-link suppression tombstones remain valid by design | `packages/core/test/occurrence-topology.test.ts` - `allows a deleted shared-link suppression tombstone because link ids are never reused`; `packages/core/test/occurrence-link-commands.test.ts` - `removes only suppressions for definition deliveries removed by public commands` |
| `selector.removeCandidate` | The staged-document invariant gate rejects a local selector-candidate endpoint that would become dangling | `packages/core/test/occurrence-link-commands.test.ts` - `rejects selector candidate removal while an occurrence endpoint references it` |
| `boundary.setSlots`, `boundary.clearSlots`, `boundary.removeBinding`, `boundary.setBinding`, `boundary.unbind` | The staged-document route identity gate rejects changed, removed, truncated, or ambiguous recorded boundary routes atomically | `packages/core/test/occurrence-topology.test.ts` - `occurrence topology semantic invariants fail closed` route drift, rebinding, truncation, and canonical comparison cases |
| `dynamic.compact` | Effective reference scan includes body and boundary occurrence endpoints; unresolved or invalid overlays make compaction a fail-safe no-op | `packages/core/test/occurrence-link-commands.test.ts` - `keeps occurrence-referenced members during compaction and derives one trailing ghost` |
| `subgraph.extract` | `extractionIntersectsOccurrenceTopology` refuses with `subgraph.extract.occurrenceTopologyIntersect` | `packages/core/test/subgraph-lifecycle-planner.test.ts` - `extract refuses a selection intersecting an %s` |
| `subgraph.flatten` | Authenticated preflight and command execution refuse overlay extension, drilled context, descendant overlay, and intersecting topology; root-owner materialization removes only the selected topology | `packages/core/test/subgraph-lifecycle-planner.test.ts` - `refuses unsupported occurrence overlay flatten contexts by name`; `materializes the selected occurrence effective topology while preserving a sibling overlay` |
| `clipboard.paste` | v3 materialization refuses non-root context, owner/endpoint outside the copied closure, and projected delivery outside the copied topology; normalization rejects duplicate node, reroute, link, and structural owner ids | `packages/core/test/clipboard.test.ts` - `refuses every v3 occurrence topology closure violation by name`, the three `rejects duplicate source ... ids` tests, and `rejects duplicate occurrence topology owners in a v3 envelope` |

### Deferred transform boundaries

- Extract occurrence remapping revives only when an approved planner can remap
  every intersected local link, suppression, owner path, and boundary route
  into the extracted owner/body with compile-equivalence, undo, and replay proof.
- Drilled or descendant-overlay flatten specialization revives only when an
  approved planner can materialize the selected drilled owner and descendant
  overlays with explicit owner-path and id remapping plus semantic compile
  equivalence before and after.
- LiteGraph materializing interchange revives only after export semantics are
  chosen: automatic selected-occurrence materialization or explicit user
  flatten. Either choice requires a lossless plan, named refusal diagnostics,
  and round-trip plus compile proof. Import continues to refuse overlays.

This document records how the representation gap for Autogrow family members
shown while editing a concrete subgraph occurrence was closed. At design time,
`occurrenceDynamicView()` projected definition-prefix members,
occurrence-owned suffix members, and one trailing ghost, but suffix sockets
were inert because persisted links belonged only to `GraphDef.links`.
Projection alone was not topology ownership; the shipped overlay supplies it.

The recommended change is a sparse occurrence topology overlay. Existing
parent-canvas links stay exactly where they are. A drilled gesture which can
truthfully edit one of those links dispatches to that existing link owner. A
gesture which needs topology inside only one occurrence writes an explicitly
owned overlay link, or suppresses one shared definition link for that
occurrence. Compiler and canvas consume the same effective-topology builder.

The alternative of mapping every drilled gesture onto parent occurrence links
is rejected. It handles an external producer connected to a forwarded member,
but it cannot represent an unexposed inner producer connected to that member,
or an occurrence-only removal of a shared inner link. Mutating the shared
definition would change sibling occurrences and is forbidden.

## Historical source contracts

The design began from these source-audited preimplementation facts. Statements
in this section describe the baseline that the shipped program superseded.

1. `WorkflowDocument.graphs` is the semantic document. A subgraph occurrence
   was a `NodeData` with type `#<GraphDefId>`. `GraphDef.links` was the only
   persisted topology map.
2. Link endpoints are graph-local structural identities. A `PortRef` is a
   node id, schema port id, and optional stable member-id path. Reroutes,
   selectors, value sources, and widget taps have distinct endpoint shapes.
3. `FamilyCrossing` is the single interpreter of whole-family forwarding.
   It translates owner-side boundary addresses into inner addresses, merges
   prefix and suffix dynamic state, and projects connectivity before
   elaboration. Persisted member ids are rebased with NUL only in derived
   state. NUL-rebased ids must never enter a document.
4. `occurrenceDynamicView()` walks a concrete instance path through the same
   crossings as compile. `FamilyOwner` records the owning graph/node/boundary
   and a reverse map from projected suffix id to persisted suffix id.
5. Scene construction stamps occurrence suffix rows and the trailing ghost
   with `familyOwner`. Interaction, hit testing, painting, and drop ranking
   excluded those sockets. Value and selector edits already routed to
   owner coordinates.
6. `link.connect`, `link.disconnect`, `link.rewire`, and
   `link.rewireSource` are atomic commands. A connect replaces the existing
   driver. IDs come from monotonic graph cursors; undo never rewinds those
   cursors.
7. Autogrow members are persisted state and the trailing ghost is derived.
   `seq` is a monotonic high-water mark. Documented behavior required explicit
   compaction; automatic compaction restore was a parallel concern.
   Either policy must use effective occurrence topology, not only
   `GraphDef.links`, when deciding whether a member is referenced.
8. Compile recursively resolves parent links through boundary items and
   `FamilyCrossing`. `collectNodes()` creates one runtime occurrence per
   concrete path, while the final link pass enumerated only each
   definition's shared links.
9. Extraction and flattening are planned, fingerprinted, one-transaction
   transforms. Flatten already has a trusted schema-planning boundary and
   materializes occurrence-local state. Clipboard copy has a versioned
   envelope and fresh-id paste path.
10. Commits `fa8de34` and `64f83a7` establish the lifecycle rule which this
    design preserves: disconnect and rewire are topology edits; compaction is
    a distinct member-lifecycle decision; no command may recycle a retired
    member id.

## Required invariants

The implementation must enforce all of these as document invariants, command
preconditions, or both.

- Every effective delivery has one stable identity and one explicit owner:
  a `GraphDef.links` link, a `GraphDef.nets` sink delivery, or an
  `OccurrenceTopology.links` link.
- A parent link remains a parent link. Drilling does not migrate, duplicate,
  or silently replace it.
- A shared definition link remains shared unless one occurrence explicitly
  suppresses it. Suppression never deletes the shared record.
- Definition edits never retarget, adopt, or overwrite an occurrence link.
- An occurrence link endpoint is stored in source coordinates. Derived
  NUL-prefixed member ids are never serialized.
- An occurrence path must resolve from `document.root`, and its recorded body
  graph must equal the definition referenced by the final occurrence node.
- A local topology may reference only entities visible in that concrete body
  occurrence. Cross-graph references are legal only through the explicit
  boundary endpoint variant below and must resolve through the recorded path.
- The effective graph has at most one driver per input after shared links,
  suppressions, parent-link projections, and local links are combined.
- A definition edit which would invalidate an occurrence endpoint or create
  an effective driver conflict is rejected before mutation. It does not
  cascade-delete or steal occurrence topology. Deleting the owning occurrence
  itself removes its topology subtree in the same transaction.
- Link and member allocation cursors never rewind on undo. Removed ids are
  never offered again within the same owner scope.
- Exactly one nonpersisted trailing ghost is derived below family capacity.
  Neither effective-topology construction nor compile turns that ghost into
  a persisted endpoint.

## Recommended document representation

Add one optional semantic map at the document root. The spelling below is
normative for implementation planning; branded id aliases are omitted only
where they add no information.

```ts
interface WorkflowDocument {
  // Existing fields remain unchanged.
  readonly occurrenceTopologies?: Readonly<Record<string, OccurrenceTopology>>
}

interface OccurrenceRef {
  readonly instancePath: readonly NodeId[]
  readonly node: NodeId
}

interface OccurrenceTopology {
  // Must equal occurrenceKey(owner). The duplicate structural record means
  // validators never need to parse the map key.
  readonly owner: OccurrenceRef
  // Definition referenced by the owner occurrence at validation time.
  readonly bodyGraph: GraphDefId
  readonly links: Readonly<Record<string, OccurrenceLinkData>>
  readonly suppressedDeliveries?: readonly SuppressedDelivery[]
  readonly nextOrdinal: number
  readonly actorCursors?: Readonly<Record<string, number>>
  readonly ext?: ExtData
}

type ParentDeliveryIdentity =
  | { readonly kind: 'link'; readonly graph: GraphDefId; readonly linkId: LinkId }
  | { readonly kind: 'netSink'; readonly graph: GraphDefId; readonly netId: NetId; readonly to: PortRef }

interface BoundaryRouteLeg {
  readonly graph: GraphDefId
  readonly boundaryId: string
  readonly binding: BoundaryBinding
}

type SuppressedDelivery =
  | { readonly kind: 'link'; readonly linkId: LinkId }
  | { readonly kind: 'netSink'; readonly netId: NetId; readonly to: PortRef }
  | {
      // Suppress only one concrete fan-out leg of a parent-owned delivery.
      readonly kind: 'projectedLeg'
      readonly delivery: ParentDeliveryIdentity
      readonly route: readonly BoundaryRouteLeg[]
    }

interface OccurrenceLinkData {
  readonly id: LinkId
  readonly from: OccurrenceLinkEndpoint
  readonly to: OccurrenceLinkEndpoint
  readonly ext?: ExtData
}

type OccurrenceLinkEndpoint =
  | {
      // A structural endpoint authored in bodyGraph coordinates. Any member
      // ids here are definition-owned ids, never projected suffix ids.
      readonly kind: 'body'
      readonly endpoint: LinkEndpoint
    }
  | {
      // A source-backed endpoint on an occurrence boundary. `occurrence` is
      // owner or one of its ancestors. The crossing chain from this boundary
      // to bodyGraph derives the visible inner endpoint.
      readonly kind: 'boundary'
      readonly occurrence: OccurrenceRef
      readonly address: {
        readonly port: PortId
        readonly members?: readonly DynamicMemberId[]
      }
      // One exact authored target at each concrete boundary fan-out hop, outermost
      // first. Each entry is structural binding identity, never an array
      // index. A definition edit which changes it invalidates, rather than
      // retargets, the local endpoint.
      readonly route: readonly BoundaryRouteLeg[]
    }
```

The map key is the existing canonical `occurrenceKey(owner)`. Validation
regenerates and compares it; no code parses it. The structural `owner` path is
the authority. A topology for root occurrence `s` has owner
`{instancePath: [], node: 's'}`. A topology for nested occurrence `i` under
that concrete `s` has owner `{instancePath: ['s'], node: 'i'}`. Therefore two
outer siblings containing the same definition node `i` have distinct maps.

`kind: 'boundary'` is required because a projected suffix address is not a
body-graph address. For a direct forwarding it stores the real persisted
owner address such as `forwarded.image` plus member `m3`; the existing
crossing translates that to the inner family coordinate. For chained
forwarding it stores the address at the owning ancestor occurrence and walks
every intervening crossing. A suffix first introduced by an intermediate
occurrence uses that intermediate occurrence as the endpoint occurrence.
This is a durable cross-graph mapping, not a persisted projection.

`route` resolves a concrete boundary-input fan-out. One `kind: 'port'`
boundary item may have a primary binding plus `alsoBinds`, and several drilled
pins can therefore share the same owner boundary address. Current
`kind: 'family'` forwarding is singular; this design does not invent family
`alsoBinds`. A gesture on one drilled pin means that one visible target, not
every concrete fan-out target. Every hop stores the exact authored
`BoundaryBinding` it selected. Binding records are already required to be
structurally unique within an item, so this is stable without an array index.
Reordering `alsoBinds` does not change identity. Rebinding a target makes the
endpoint stale and the definition edit fails closed; it never retargets the
local link. If boundary bindings later gain first-class ids, those ids can
replace the structural discriminator through a migration.

Route matching uses one canonical binding key, not object identity or raw JSON
bytes. It normalizes semantically unordered fields such as `slots` before
comparison, preserves semantically ordered member paths, and includes every
field which changes exposure. A reorder alone cannot stale a route.

`kind: 'body'` covers ordinary body nodes, reroutes, value sources, selectors,
widget taps, and definition-owned dynamic members. It cannot carry an
occurrence-projected member. The planner converts a `familyOwner` pin back to
`kind: 'boundary'`; command validation independently resolves it and rejects
forged, ambiguous, stale, or ghost routes.

Suppressions are necessary, not optional sugar. Without them a drilled delete
of a shared definition link would either mutate all occurrences or be
unrepresentable. Link suppression names the stable shared link id in
`bodyGraph.links`. Net-sink suppression names the stable net id plus its exact
consumer `PortRef`; it suppresses only that delivery, not the net source or
other sinks. Since graph link and net ids are never reused, a stale link
suppression cannot hide a later unrelated link. Since net sinks do not yet
have ids, every definition command which removes a suppressed net sink must
also remove the matching suppression in the same transaction. Re-adding the
same address later is then a new unsuppressed delivery, preventing stale
resurrection. Canonical form sorts and deduplicates suppressions and omits the
field when empty. A future first-class net-sink id may replace this coordinated
cleanup rule.

A `projectedLeg` suppression is the negative overlay for one concrete
`alsoBinds` leg of a parent-owned link or net sink. It does not delete the
parent record and does not suppress sibling legs. Compile still visits the
parent delivery once, but filters that one resolved route for this occurrence.
The full parent delivery remains owner-editable as a separate action.

An empty topology record which has allocated an id is retained with its
high-water cursor. Removing the last local link must not erase `nextOrdinal`
and allow reuse. A topology that has never allocated anything need not exist.
Topology link ids are scoped to their occurrence topology, so `l4` under two
different owners is not a collision. Diagnostics and selection identity use
the pair `(owner, linkId)`.

### Why this is smaller than a general graph overlay

The model adds only links, shared-delivery suppressions, and their allocators. It
does not clone nodes, dynamic state, values, view state, reroutes, selectors,
or definitions. Existing occurrence state stays on its existing owners and
`familyOwner` remains the routing authority. Existing parent links and shared
body links keep their current bytes and command behavior.

A fully general occurrence graph fork would also need node additions,
deletions, view overrides, schema replacement, boundary changes, and merge
semantics. None is required to make Autogrow occurrence sockets truthful.

## One effective-topology builder

Add one pure core operation used by compile, scene construction, invariants,
compaction, lifecycle planning, and tests:

```ts
effectiveOccurrenceTopology(document, resolver, owner): {
  bodyGraph: GraphDef
  links: readonly EffectiveLink[]
  projectedParentLinks: readonly EffectiveLink[]
  diagnostics: readonly Diagnostic[]
}

interface EffectiveLink {
  readonly identity:
    | { readonly kind: 'definition'; readonly graphId: GraphDefId; readonly linkId: LinkId }
    | { readonly kind: 'parent'; readonly graphId: GraphDefId; readonly linkId: LinkId }
    | { readonly kind: 'definitionNetSink'; readonly graphId: GraphDefId; readonly netId: NetId; readonly to: PortRef }
    | { readonly kind: 'parentNetSink'; readonly graphId: GraphDefId; readonly netId: NetId; readonly to: PortRef }
    | { readonly kind: 'parentLeg'; readonly delivery: ParentDeliveryIdentity; readonly route: readonly BoundaryRouteLeg[] }
    | { readonly kind: 'occurrence'; readonly owner: OccurrenceRef; readonly linkId: LinkId }
  readonly from: ResolvedOccurrenceEndpoint
  readonly to: ResolvedOccurrenceEndpoint
}
```

The builder performs these steps in order.

1. Resolve the owner path and assert `bodyGraph`.
2. Build exactly the same family crossings and selector/family dynamic
   overlays used by compile and `occurrenceDynamicView()`.
3. Start with `bodyGraph.links` and each `bodyGraph.nets` sink delivery,
   excluding explicit suppressions.
4. Resolve every local `body` endpoint directly and every `boundary` endpoint
   by walking the one crossing implementation and matching every recorded
   fan-out-hop binding. Reject zero or multiple matches for a recorded route.
5. Project parent links and parent net sinks incident on the concrete
   occurrence boundary for rendering and edit ownership. These records remain
   parent-owned and are not copied into `OccurrenceTopology.links`.
6. Validate direction, endpoint existence, materialized-member membership,
   the existing reroute/selector/widget-tap cycle classes, and one-driver rules
   over the combined effective set. This design does not add a general
   compute-graph acyclicity rule.

The result contains derived NUL coordinates only in memory. It must expose
reverse source metadata so a visible link or pin dispatches to its real owner.
Scene `familyOwner` is retained and extended with enough route metadata to
construct a `boundary` endpoint; it is not removed or treated as a mere flag.

Compile must consume this builder while recursively collecting each concrete
occurrence. It lowers effective local links at that occurrence path using the
same `resolveInputPort()` and `resolveOutputPort()` machinery as shared links.
Connectivity projection before elaboration also consumes the effective set,
so DynamicSlot dependents inside family templates cannot diverge from final
link lowering.

Projected parent deliveries are render/edit aliases only. Compile continues to
lower the parent link or net sink once in its owning graph occurrence; the
child effective-topology pass must not lower the projected alias a second
time. A route-qualified projected-leg suppression is consulted while that one
parent lowering resolves boundary fan-out, so only the selected leg is
filtered.

Every compile consumer of structural topology must use an occurrence-keyed
effective index, not a cache keyed only by `GraphDefId`. This includes reroute
driver/successor indexes, selector driver/successor indexes, bypass input
driver lookup, address/connectivity projection, would-run analysis, and final
lowering. Otherwise a suppressed shared reroute/selector/tap driver would stay
active, or a local one would be invisible, even if the final link loop were
correct. Projected parent aliases enter those indexes only through their one
owning-parent resolution.

## Command surface and gesture routing

Add occurrence-specific commands rather than overloading graph-local link
commands with optional path semantics.

```text
occurrence.link.connect
  { owner, bodyGraph, from, to, expectedTopologyFingerprint }

occurrence.link.disconnect
  { owner, bodyGraph, link: EffectiveLinkIdentity,
    expectedTopologyFingerprint }

occurrence.link.rewire
  { owner, bodyGraph, link: EffectiveLinkIdentity, to,
    expectedTopologyFingerprint }

occurrence.link.rewireSource
  { owner, bodyGraph, links: [EffectiveLinkIdentity, ...], from,
    expectedTopologyFingerprint }
```

All are one dispatch and one undo record. `expectedTopologyFingerprint`
covers the owner path records, body definition id, consulted boundary items,
relevant dynamic state, shared/suppressed/local links, and endpoints. Shared
re-execution either applies the same intention to unchanged sources or drops
it as stale. Boundary route interpretation uses the established trusted
initial-dispatch resolver and immutable plan/snapshot pattern already used by
flatten; shared replay uses the authenticated plan, never ambient schema.

The fingerprint is intention-scoped: it includes the target's effective
driver, endpoint routes, consulted definitions, materialization state, and
allocator assumptions, but excludes unrelated sibling topologies and actor
cursors. Independent edits in another occurrence must not make this command
spuriously stale.

Gesture routing is based on effective link identity and endpoint ownership.

- A projected parent link with one resolved leg dispatches the existing parent
  graph command. A drilled disconnect therefore removes the same parent link
  visible outside.
- A projected concrete fan-out leg adds a route-qualified `projectedLeg`
  suppression. Other legs and the parent record survive.
- A projected parent net sink follows the same sole-leg versus route-qualified
  fan-out rule as a parent link.
- An occurrence link disconnect removes that local record.
- A shared definition link disconnect appends its id to this occurrence's
  suppression set.
- A shared definition net sink disconnect appends its net-id/consumer identity
  to this occurrence's suppression set.
- Connecting two ordinary definition endpoints while drilled remains an
  ordinary shared definition edit. At least one occurrence-owned endpoint is
  required before `occurrence.link.connect` is offered.
- Connecting an occurrence-owned endpoint creates one local link. The command
  allocates its id and materializes a ghost member, when applicable, in the
  same transaction.
- Rewiring an occurrence link updates the same local id.
- Rewiring a projected parent link uses the parent link command when the new
  endpoint is representable at that parent. If the new endpoint is internal
  and unexposed, the command atomically disconnects the parent link and creates
  a local link only after an explicit UX confirmation, because the external
  source is otherwise lost. The first implementation should fail closed
  rather than silently perform this ownership-changing conversion.
- Rewiring a shared definition link to an occurrence endpoint atomically
  suppresses the shared link and creates a fresh local replacement. The shared
  link remains unchanged for siblings.
- Rewiring a shared net delivery suppresses that one sink and creates a local
  replacement; other sinks remain shared.
- Reconnecting an unchanged suppressed shared delivery removes its suppression
  rather than allocating a replacement shared link or net sink. This is an
  explicit unsuppress arm of the occurrence command.
- Reconnecting the original parent delivery on one suppressed concrete fan-out
  route removes that exact `projectedLeg` suppression. Source or target rewire
  of a `parentLeg` suppresses only that route and adds the local replacement.
  Other parent legs remain unchanged.
- Link Delete is the corresponding disconnect operation. Deleting or
  compacting a suffix member first removes every owner-local link addressing
  it and every parent link addressing it, then applies the lifecycle policy in
  one transaction. Node deletion remains a shared-definition operation and is
  not smuggled into this feature.

The existing `link.*` commands and parent-canvas interaction path stay
unchanged. This is important regression armor for the already proven outer
path.

### Effective-driver displacement on connect

`occurrence.link.connect` preserves ordinary connect's replace-driver
semantics, but displacement follows the existing driver's owner:

| Existing effective driver | Atomic displacement before adding the requested delivery |
| --- | --- |
| None | Add the local link, or unsuppress the exact shared delivery when that is the requested connection. |
| Occurrence-local link | Remove that local link, then add the replacement. |
| Shared definition link | Add a link suppression, then add the local replacement. |
| Shared definition net sink | Add a net-sink suppression, then add the local replacement. |
| Projected parent link | For a sole leg, dispatch through the parent owner only when the new connection is representable there; for one of several concrete fan-out legs, suppress that route and add the local replacement. Otherwise fail closed pending explicit ownership-conversion UX. |
| Projected parent net sink | Apply the same sole-leg versus route-qualified fan-out rule through the parent net-sink owner. |

Driver displacement, ghost materialization, suppression, allocation, and link
creation are one transaction. Failure in any arm leaves all owners unchanged.

## Compaction and the trailing ghost

The reference set for a persisted occurrence member is the union of:

- parent `GraphDef.links` and named-net sink endpoints on its owner occurrence;
- resolved occurrence-local links in every descendant topology which uses
  that owner boundary address;
- values, controllers, nested dynamic state, boundary bindings, and other
  existing evidence already considered by compaction; and
- effective shared definition links only when they resolve to that suffix in
  the concrete occurrence.

Manual or automatic compaction must query that union. Removing a topology
link cannot compact a member while another local or parent link still
references it. Conversely, an occurrence-local suppression means the
suppressed shared link is not evidence in that occurrence.

Materializing the trailing ghost and connecting it is one atomic command:
advance the owner's `seq`, add the member to the owner state, and add the link.
Undo removes member and link together but never rewinds `seq`. Redo restores
the exact member and link ids. Automatic restore must run before endpoint
validation in the same planned transaction when its policy restores a
recently compacted member. It must never infer restoration from a stale
NUL-projected address.

Scene derivation still appends exactly one ghost after the effective persisted
member list and below capacity. No topology record is created for merely
viewing or drilling through that ghost.

## Serialization and compatibility decision

This is a material document-format change.

- Existing saved documents remain readable by the new reader because
  `occurrenceTopologies` is optional and absence means the exact current
  semantics.
- Existing documents which are opened and saved without occurrence topology
  edits need not gain the field; their canonical bytes remain unchanged apart
  from unrelated normal save metadata.
- A document containing occurrence topology cannot be represented by the old
  format without changing execution. Dropping the field would silently lose
  local links and suppressions. Therefore downgrade is not reversible.
- Current validators and JSON Schema are closed over known document fields.
  Old binaries will reject, not safely ignore, the new root field. This is
  asymmetric compatibility: new reads old, old does not read new.
- Native full-document import/export must preserve and validate the field.
  LiteGraph import has no equivalent occurrence overlay and creates none.
  LiteGraph export must flatten/materialize the selected occurrences or refuse
  with a named diagnostic; it must not omit the overlay.

The repository's pre-release policy applied, so the optional field shipped in
format version 1. The first save containing `occurrenceTopologies` remains a
user-visible compatibility point because older binaries reject the field.

This is a frontend document contract, not a backend prompt-wire change. The
compiled prompt remains ordinary flattened topology. No backend wire version
change is required unless occurrence topology is later sent to the backend as
authored document data.

## Required behavior matrix

The table covers both the recommendation and the rejected parent-link-only
mapping. "Parent-only" means mapping drilled gestures to existing parent
occurrence links without adding occurrence topology.

| Matrix cell | Sparse occurrence overlay | Parent-link-only alternative |
| --- | --- | --- |
| Root occurrence | Owner `{[], node}` isolates one root instance. Parent links stay parent-owned; internal local links use the overlay. | Works only when both semantics can be expressed at the root occurrence boundary. |
| Nested occurrence | Full structural owner path selects the concrete nested occurrence; `bodyGraph` guards path drift. | Cannot name an unexposed endpoint in the nested body. Adding a boundary item would mutate the shared definition. |
| Chained occurrence | A boundary endpoint may start at any owner-prefix occurrence and is translated through every `FamilyCrossing`; no NUL id persists. | Works for a link already entering the outermost forwarded boundary, but not for local topology introduced at an inner hop or a shared-link suppression. |
| Direct family | Owner boundary address maps through one crossing. Prefix body members remain `body` endpoints. | External-to-suffix links work. Inner-to-suffix links without an exposed producer do not. |
| Forwarded family | Source address plus crossing chain is the durable mapping; `familyOwner` remains authoritative. | Covers the already proven outer parent link only. It cannot cover the full drilled gesture set. |
| Whole scope | Boundary address keeps family id, slot suffix, and member path; crossing validates whole-family exposure. | Same limited success for boundary-reachable links; no local shared-link removal. |
| Grouped scope | One promoted member identity owns all sibling template slots. Links address the selected slot while materialization and compaction act on the group atomically. | Can map parent links to grouped boundary slots, but cannot express an unexposed inner producer or occurrence-only shared-link rewire. |
| Concrete boundary-input fan-out | Every `alsoBinds` hop is selected by canonical structural binding identity. A pin gesture suppresses or rewires one route-qualified projected leg; an explicit full-delivery action still edits the parent-owned record. Family forwarding remains singular under the current contract. | One parent link intentionally reaches all fan-out targets, so it cannot express editing only one drilled target. |
| Connect | Reuse a parent link path when it is truly parent-owned; otherwise allocate one local link. Ghost promotion and link creation are one transaction. | Fails whenever either required inner endpoint is not represented on the parent occurrence boundary. |
| Disconnect | Parent link deletes at parent; local link deletes locally; shared body link gains an occurrence suppression. One step, one undo. | Can disconnect a parent link, but occurrence-only disconnect of a shared body link is impossible. |
| Rewire target | Local link retains id. Shared link forks by suppression plus a fresh local link. Parent link remains parent-owned unless an explicit future ownership conversion is supported. | Cannot rewire to an unexposed body endpoint and cannot fork shared topology for one occurrence. |
| Rewire source | Same ownership rules. Ordinary output-link fan-out lists are all-or-nothing and preserve each local link id; concrete boundary-input `alsoBinds` legs are independently route-qualified and suppress only the selected leg. | Fails for an unexposed source and cannot preserve sibling behavior when source was a shared definition link. |
| Delete link | Alias of the owner-correct disconnect. Suppression is deletion only in this occurrence. | Only parent-owned links are safely deletable occurrence-locally. |
| Delete member | Remove all parent/local references in one transaction, then apply compaction policy; reject if any reference remains. | Misses internal local references because it has no representation for them. |
| Delete referenced definition node | Reject the definition edit while any local endpoint references it, unless the user deletes the owning occurrence itself. No implicit adoption or cascade. | Avoids the new reference but only because it cannot represent the required topology. |
| Named-net sink | Shared/parent net sinks have explicit effective-delivery identity and may be suppressed or owner-dispatched. Local replacement is an ordinary occurrence link. Net-sink removal cleans matching suppressions atomically. | Can dispatch a parent net-sink removal, but cannot suppress one shared body sink in only this occurrence. |
| Automatic compaction | Effective reference scan includes parent, local, suppression, value, and dynamic evidence. Cursor retention and atomic restoration compose with the parallel policy. | Scans only parent/shared links and can wrongly compact a member needed by an unrepresentable drilled link. |
| Exactly one trailing ghost | Still purely derived from effective persisted state and cap; never stored as an endpoint. | Can retain one ghost, but cannot make its full drilled connection semantics durable. |
| Save/open | Optional root map round-trips exact owner paths, links, suppressions, and cursors. Resolver validation reconstructs the same effective graph. | No new bytes for supported parent links, but unsupported gestures have nothing truthful to save. |
| Native import | New reader validates and imports topologies. Id and member cursors are preserved. | Preserves only parent topology and loses the missing gesture semantics. |
| LiteGraph import/export | Import creates no overlay. Export materializes effective occurrences or refuses; never silently drops. | Export can handle parent links, but cannot export behavior it could not author. |
| Drill in/out | Both scenes show one effective link with owner metadata. Drilling never migrates it. The outer proven path is unchanged. | Existing parent links survive drill, but locally authored inner topology cannot survive because it cannot exist. |
| Copy root/nested occurrence | Clipboard includes a closed owner topology subtree. Paste rewrites internal owner paths and allocates fresh local link ids/cursors; shared suppressions still name retained definitions. A nested subtree with a boundary endpoint owned by an ancestor outside the copy refuses until a planner also copies or materializes that ancestor state. | Copies existing NodeData state but cannot copy missing local topology. |
| Copy body selection | Include selected local links whose endpoints are both copied. A cut touching a boundary endpoint or suppression must use an extended occurrence-aware envelope or refuse loudly. | Can copy shared definition links only, silently differing from what the concrete occurrence displays. |
| Extract while editing definition | Existing shared extraction is unchanged. | Works as today. |
| Extract while drilled | Planner fingerprints effective topology. First slice refuses when the cut intersects local links/suppressions; later support must remap them explicitly into the new owner/body. Never treat them as shared links. | Either ignores visible effective links or mutates the shared definition; neither is correct. |
| Flatten occurrence | Extend the existing authenticated state plan to materialize effective shared-minus-suppressed plus local links into the parent with fresh graph-local ids, then remove the owner topology subtree. Compile before/after must match. | Can flatten parent links and shared body links, but has no representation for occurrence-only differences. |
| Compile endpoint equivalence | Each resolved local boundary endpoint is lowered through the same crossing and input/output resolvers as the equivalent parent link. Tests assert exact resolved runtime producer/consumer identity and prompt delivery. Flatten tests assert semantic prompt equivalence modulo the authenticated node/member id map, since flatten necessarily changes runtime ids. | Equivalent only for the subset already representable as parent links, not the full matrix. |
| One-step undo/redo | Each gesture is one command/transaction. Fork rewire includes suppression, allocation, link add, materialization/compaction in that record. Cursor preservers prevent rewind. | Supported parent gestures have one-step history; unsupported local gestures cannot enter history. |
| Concurrent sibling instances | Different owner paths mean occurrence-local links and suppressions in `a` cannot affect `b`. Owner-correct edits explicitly routed to a shared definition or shared parent graph remain shared and the UX must label them as such. | Parent links can be sibling-local only when their owning graph occurrence is not itself shared; unsupported inner edits otherwise mutate shared state. |
| Concurrent chained instances | Full path distinguishes local overlays at `a/i` from `b/i`. Shared replay fingerprints the exact owner and consulted crossings. Explicit edits to a shared ancestor record remain shared by design. | Inner shared-definition mutation changes both chains; adding boundaries also changes both. |
| No ID reuse | Topology cursor and actor cursors are monotonic and preserved through undo. Member `seq` remains monotonic. Empty allocated topology skeletons retain cursors. | Existing parent ids remain safe, but there is no id domain for missing local links. |
| No stale resurrection | Link suppressions name never-reused ids; net-sink suppressions are cleaned when their source sink is removed; endpoints store source member ids; invalid path/body/crossing refuses. Definition deletion is blocked while referenced. | Avoids local stale records only by refusing to represent local behavior; boundary synthesis could later retarget stale routes after definition edits. |
| Definition edits never steal occurrence links | Conflicting or endpoint-invalidating definition edits reject. Local links remain local; shared links remain shared. Deleting the owner occurrence explicitly deletes its topology subtree. | To cover unsupported gestures it would have to mutate the definition or synthesize shared boundary state, which does steal semantics across occurrences. |

## Rejected alternative: map every gesture to parent links

The attractive part of the alternative is real: for a parent source connected
to `occurrence.forwarded.slot[m0]`, `FamilyCrossing` already proves exactly
which inner suffix pin it reaches. The drilled canvas should project that link
and route disconnect/rewire back to its existing parent `LinkData`. The
recommended model does this; it does not duplicate that link.

It is not a complete representation for three source-backed reasons.

1. Consider body node `producer.out` connected while drilled to the projected
   suffix `consumer.items.value[owner m0]`. If `producer.out` is not a body
   boundary output, the parent graph has no endpoint for it. Creating one
   changes the public definition interface and every occurrence. A fake parent
   port is not a `BoundaryBinding` and compile cannot resolve it.
2. Consider shared body link `producer.out -> consumer.items.value[d0]`.
   Deleting or rewiring it in only occurrence `a` requires a negative or
   replacement overlay. A parent link cannot remove a shared inner link, and
   mutating `bodyGraph.links` also changes occurrence `b`.
3. Grouped, nested, and chained forwarding amplify both failures. A route may
   traverse several boundary items and member scopes, but translation does not
   create a durable producer endpoint where none is exposed.
4. Input `alsoBinds` makes one parent boundary delivery fan out to several
   inner targets. It cannot represent a gesture which forks or removes only
   one visible drilled target. Named-net sinks have the same negative-overlay
   requirement.

Encoding hidden inner endpoints inside a parent `LinkEndpoint.ext` is also
rejected. It would violate endpoint validation, make old compilers silently
miscompile, and give the link two competing semantic meanings. Automatically
adding boundary items is rejected because it mutates the shared definition,
changes derived schemas, and lets a local gesture alter every sibling.

## Definition editing and stale-state policy

Occurrence topology makes definition mutation constraints observable. The
smallest safe first implementation is fail-closed.

- `node.delete`, reroute/value-source/selector deletion, node replacement,
  boundary rebinding, and dynamic compaction in a definition preflight every
  occurrence topology that resolves through that definition.
- If the edit invalidates a local endpoint or its crossing chain, reject with
  `occurrence.topology.definitionReferenced` and anchors for the definition
  entity and each affected occurrence.
- Adding or rewiring a shared definition link rejects when any effective
  occurrence would gain a second driver. It never removes the local driver.
- Deleting a shared definition link is legal. Existing suppressions may be
  retained as harmless tombstones because the link id cannot be reused, or
  removed canonically in the same edit; retaining is simpler under undo and
  collaboration.
- Removing a shared net sink also removes every matching net-sink suppression
  in the same transaction because sink addresses do not yet have never-reused
  ids. Re-adding that address later creates a new unsuppressed delivery.
- Deleting a top-level occurrence deletes every topology whose owner path has
  that occurrence as a prefix. Deleting a nested occurrence in a definition
  is rejected if any concrete owner path traverses it and carries topology,
  unless a dedicated planned transform enumerates and removes those records.
- Undo restores exact records. Allocation cursors remain at their current
  high-water values, matching existing graph and member behavior.

These rules may later be relaxed by explicit remapping planners. Silent
cascade, endpoint retargeting by label, and longest-prefix guessing remain
forbidden.

## Implementation slices

This is the historical implementation sequence. T1-T5 and automatic
disconnect compaction are shipped; this release closure completes T6 while
retaining the explicit transform deferrals above.

### T1 - Format, validation, identity, and cursors

- Add the document types, runtime validator, JSON Schema, canonicalization,
  semantic hashing, and format migration/policy decision.
- Add structural occurrence-ref equality/key helpers. Never parse map keys.
- Extend undo cursor preservation for topology `nextOrdinal` and actor cursors.
- Add invariants for owner resolution, body graph agreement, suppression ids,
  endpoint shape, per-hop binding routes, no NUL persistence, canonical
  arrays, allocator floors, and id/key agreement.
- Proof old documents load byte-equivalently and new documents round-trip.

Topology allocator floors exactly mirror graph allocator invariant I6. A solo
allocated id ordinal is lower than `nextOrdinal`; an actor-suffixed id ordinal
is lower than `actorCursors[actor]`; malformed or noncanonical allocated ids
follow the same rules as graph-local ids. An allocated empty topology blocks a
`bodyGraph` replacement because carrying its cursor into a different identity
scope could make old ids meaningful again.

### T2 - Effective topology and compile

- Build the one effective-topology operation on the existing crossing code.
- Project parent, shared, suppressed, and local link/net-delivery identities without
  changing current parent-link storage.
- Feed effective connectivity into elaboration and effective links into final
  lowering.
- Add direct/forwarded, whole/grouped, root/nested/chained compile-equivalence
  tests and sibling-isolation tests.
- Oracle review this slice before any editing UI is enabled.

### T3 - Commands and lifecycle interaction

- Implement the four occurrence link commands with trusted planning,
  fingerprints, allocation, one-driver validation, and atomic materialization.
- Extend member-reference and compaction scans to effective topology.
- Prove connect/disconnect/rewire/delete, one-step undo/redo, cursor retention,
  stale replay refusal, and no parent-path regression.
- Integrate the automatic compaction policy through the shared reference scan;
  do not duplicate that policy in interaction code.

### T4 - Drilled canvas projection

- Render effective parent/shared/local links with owner identities.
- Keep `familyOwner`, but allow sockets only after an endpoint can be mapped to
  a valid source coordinate and the corresponding occurrence command exists.
- Route projected parent links to existing graph commands and local/shared
  effective links to occurrence commands.
- Prove exactly one ghost, body-drop ranking, no invisible hit target, drill
  in/out stability, and unchanged outer parent-canvas Chromium coverage.

### T5 - Save/import/copy/lifecycle transforms

- Round-trip native save/open/import and add explicit LiteGraph refusal or
  materialization behavior.
- Extend clipboard for owner topology subtrees and fresh local ids.
- Make extract fail closed on intersecting occurrence topology first; add
  explicit remapping only in a separately reviewed slice.
- Extend flatten's authenticated plan to materialize the effective topology
  and prove semantic compile equivalence under its explicit id-remap table.

### T6 - Full matrix and compatibility release gate

- Run unit, app, canvas, serialization, shared-session, and focused Chromium
  matrices named above.
- Audit every definition-edit command for endpoint invalidation and driver
  conflict.
- Perform whole-area review, migration/downgrade UX review, and update user
  docs, promises, feature coverage, and performance history if measured scene
  or compile costs move.

## Open questions

1. Resolved: the pre-release revise-v1 policy applied. The format stays at 1,
   and old binaries reject overlay-bearing documents rather than dropping the
   field silently.
2. Should rewiring a projected parent link to an unexposed inner endpoint offer
   an explicit ownership conversion, or remain a named refusal? The safe first
   slice is refusal.
3. Should a drilled connect between two entirely definition-owned endpoints
   always remain a shared definition edit, or should the UI offer an explicit
   "Only this occurrence" fork? The minimal design defaults to shared and uses
   local ownership only when an occurrence endpoint participates.
4. When a shared definition link is already suppressed, should a later global
   rewire of that same stable link remain suppressed? This design says yes:
   identity, not old endpoint bytes, is what the occurrence deleted.
5. Should deleting a definition entity offer a planned "delete affected local
   topology too" action after the initial fail-closed diagnostic? It must be a
   previewed, one-transaction transform if added.
6. Clipboard copy of a body selection can intersect boundary endpoints and
   suppressions. Is named refusal acceptable for the first slice, or must the
   clipboard envelope gain scoped endpoints immediately?
7. Native full-document import is lossless, but LiteGraph has no occurrence
   overlay. Should export automatically flatten selected occurrences or always
   refuse until the user flattens explicitly?
8. Occurrence topology lookup is potentially proportional to all saved
   topologies during definition-edit preflight. Is a derived reverse index
   sufficient, or do expected workflow sizes justify a persisted index? The
   default is a derived cache; a second persisted source of truth is rejected.
9. Structural `BoundaryBinding` identity is the smallest fan-out discriminator
   available today. Should boundary bindings gain first-class never-reused ids
   before implementation, or is fail-closed invalidation on rebinding the
   preferred v1 contract?

## Required `familyOwner` extension

`familyOwner` remains present on every projected suffix and ghost. It must stop
being only a socket-suppression flag and carry the exact reversible source
route needed by the command planner:

```ts
interface FamilyOwner {
  readonly graphId: GraphDefId
  readonly nodeId: NodeId
  readonly boundaryId: string
  readonly occurrence: OccurrenceRef
  readonly familyPath: string
  readonly suffixMembers: ReadonlyMap<string, string>
  readonly route: readonly BoundaryRouteLeg[]
}
```

The current graph/node/boundary/value routing remains available. `occurrence`
and `route` distinguish concrete chained owners and legal `alsoBinds` targets.
Scene code may hold derived maps, but persistence receives only the structural
owner occurrence, persisted member id, and authored route. The planner must
not reconstruct this route from labels, pin order, dotted-id prefixes, or a
NUL-projected address.

## Design conclusion

Retain the proven outer parent-link path unchanged. Add a sparse, explicitly
owned occurrence topology only for semantics which cannot live truthfully in
the parent or shared definition. Store suffix endpoints in owner boundary
coordinates, never projected coordinates; suppress shared links rather than
mutating them; derive one effective topology through the existing crossing
machinery; and make compile, canvas, compaction, lifecycle transforms, and
serialization consume that same result. This is the smallest representation
which covers the full required matrix without sacrificing occurrence
isolation, stable identity, or definition ownership.
