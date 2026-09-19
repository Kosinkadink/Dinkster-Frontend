# Subgraph create, extract, and flatten lifecycle design

Status: L1-L7 and explicit unused-definition cleanup are implemented. The
deferred cases below remain fail closed until their revival triggers occur.

This design defines the lifecycle that is currently missing between Dinkster's
subgraph document model and its editing UX: create an empty definition,
extract a selection into a definition plus occurrence, and flatten one
occurrence back into its parent. The goal is semantic preservation, not a
LiteGraph-compatible representation. Every persisted result uses the existing
`GraphDef`, `BoundaryItem`, `BoundaryBinding`, and ordinary command model.

The design was Oracle-reviewed on 2026-07-29 with special attention to taps,
value sources, dynamic-family members, nested occurrences, occurrence-local
state, and recursion. The resulting constraints are incorporated below.

## Table of contents

1. [Existing contracts](#existing-contracts)
2. [Lifecycle commands and shared rules](#lifecycle-commands-and-shared-rules)
3. [Create an empty subgraph](#create-an-empty-subgraph)
4. [Extract a selection](#extract-a-selection)
5. [Cut behavior matrix](#cut-behavior-matrix)
6. [Groups and view state](#groups-and-view-state)
7. [Modes, nested subgraphs, and recursion](#modes-nested-subgraphs-and-recursion)
8. [Flatten an occurrence](#flatten-an-occurrence)
9. [Definition retention](#definition-retention)
10. [Undo, collaboration, and rebase safety](#undo-collaboration-and-rebase-safety)
11. [Validation and diagnostics](#validation-and-diagnostics)
12. [Regions integration and sequencing](#regions-integration-and-sequencing)
13. [Implementation slices](#implementation-slices)
14. [Deferred items and revival triggers](#deferred-items-and-revival-triggers)
15. [Open product questions and chosen defaults](#open-product-questions-and-chosen-defaults)

## Existing contracts

The lifecycle is built on these existing facts.

1. `WorkflowDocument.graphs` owns the root and every subgraph definition. A
   subgraph occurrence is ordinary `NodeData` whose type is `#<GraphDefId>`;
   the definition boundary is its derived `NodeSchema`. See
   `packages/core/src/format/document.ts` and
   `packages/core/src/schema/derive-boundary.ts`.
2. `BoundaryBinding` already distinguishes concrete `kind: 'port'` bindings
   from whole `kind: 'family'` forwarding. A boundary input may fan out via
   `alsoBinds`; an output has one source. Boundary commands already edit this
   model in `packages/core/src/commands/boundary-commands.ts`. Extraction and
   flattening MUST produce the same records, not pseudo input/output nodes or
   another boundary graph.
3. `subgraph.import` is the atomic definition-import primitive and validates
   graph/view shape before writing. It lives in
   `packages/core/src/commands/subgraph-commands.ts`. Existing blueprint
   materialization in `packages/core/src/blueprint.ts` establishes copy
   semantics, fresh `g<n>` definition ids, internal `#<id>` rewriting, and
   matching view import.
4. Core identities are graph-definition scoped. `Occurrence` is the path of
   enclosing occurrence node ids plus the local node id; endpoint and port
   comparison use the canonical helpers in `packages/core/src/ids.ts`.
   `subgraphDefIdOf` and the no-recursion DAG check are in
   `packages/core/src/invariants.ts`.
5. All mutations are serializable commands through
   `DocumentSession.dispatch`. `batch` is one transaction, revision, and undo
   record; any command or invariant error aborts all writes. Shared sessions
   re-execute pending command intentions after foreign operations and drop an
   intention that no longer applies. See
   `packages/core/src/commands/core-commands.ts`,
   `packages/core/src/commands/session.ts`, and
   `packages/core/src/commands/shared-session.ts`.
6. Reroutes, value sources, selectors, widget taps, and named nets are already
   first-class graph-local constructs. Their endpoint shapes are in
   `packages/core/src/ids.ts`; their semantics and storage are in
   `packages/core/src/format/document.ts`. An output boundary can name an exact
   widget tap with `kind: 'widgetTap'`; it still cannot name a reroute, value
   source, or selector. This is a hard representational constraint, not an
   invitation to encode fake ports.
7. Groups are view rectangles with spatially derived membership, not semantic
   containers. See `GroupViewState` in `document.ts` and the group commands in
   `core-commands.ts`.
8. Whole-family forwarding has one address translator,
   `FamilyCrossing`, in `packages/core/src/compile/crossing.ts`. DynamicCombo
   choice projection and family state overlay already make occurrence-local
   state visible inside a definition. Any lifecycle translation of forwarded
   state MUST extend/reuse that crossing machinery rather than parse dotted
   ids independently.
9. `docs/boundary-forwarding-design.md` is the contract for specialized-slot,
   promoted-widget, tap, controller, and recursive family behavior across a
   boundary. This lifecycle composes with it. In particular, flattening must
   materialize the effective occurrence state that compiler projection would
   otherwise derive; it must not discard or reinterpret that state.
10. `docs/regions-design.md` defines a region as a subgraph occurrence with an
    occurrence-local iteration contract. Region creation uses the same fresh
    definition plus occurrence foundation defined here.

### ComfyUI reference, not architecture

ComfyUI_frontend's `LGraph.convertToSubgraph` and `unpackSubgraph` in
`src/lib/litegraph/src/LGraph.ts`, with helpers in
`src/lib/litegraph/src/subgraph/subgraphUtils.ts`, establish useful UX
expectations:

- one conversion gesture and one undo unit;
- crossing links grouped by producer, with unique boundary names;
- an occurrence centered on the extracted bounds;
- internal nodes, reroutes, and groups retaining relative positions; and
- unpack reconnecting outer boundary links while cloning the body with fresh
  ids.

Its TODOs around reroutes and its imperative disconnect/reconnect behavior are
not copied. Dinkster has graph-local structural endpoints, explicit boundary
bindings, persistent ids, commands, and collaboration requirements that make
those details materially different.

## Lifecycle commands and shared rules

### Public operations

The application exposes three gestures:

- **Create subgraph**: a planned `batch` of existing `subgraph.import` and
  `node.add` commands. No new core command is needed for the empty case.
- **Extract to subgraph**: one new `subgraph.extract` command. The transform
  must allocate, cut, move, bind, and reconnect against one transaction, so a
  loose batch of public CRUD commands would expose intermediate invalid
  states and duplicate the cut algorithm in the app.
- **Flatten subgraph**: one new `subgraph.flatten` command for the same reason.

All three are dispatched once through the active `DocumentSession`. Canvas
and app code only plan invocations and consume outcomes; they never patch a
document directly.

### Planning context and selection

Extraction takes one graph definition and a canonical selection:

```text
graphId
instancePath              current drilled-in occurrence, for anchors
nodeIds
rerouteIds
valueSourceIds
selectorIds
groupIds
name
selectionFingerprint
placementCenter             finite world-space {x,y}
resolvedGeometry           planner-owned positions/bounds used for placement
boundaryPlan               exact inferred cut/binding records
schemaPlanDigest           resolver snapshot used for schema-sensitive routes
schemaSnapshot             canonical consulted schema fragments
stateRoutePlan             exhaustive occurrence-state/address mappings
```

At least one semantic producer/consumer item (node, value source, or selector)
is required; a group-only or reroute-only extraction refuses. Arrays are
deduplicated and sorted before hashing or dispatch. Links and nets are not
selection seeds: ownership is inferred from their endpoints. The planner
expands a selected group to the positionables spatially inside it before
dispatch, then records that explicit expanded selection. The command never
recomputes group membership from a later view.

`instancePath` must resolve from `doc.root` to `graphId`. It does not change
which shared definition is edited; it gives command diagnostics a truthful
occurrence anchor when the same definition has several occurrences.

`selectionFingerprint` covers every selected entity record, its relevant
view record, every incident link, every incident net source/sink, every
current-definition boundary binding touching it, and selected group records.
The command recomputes it before writing. A mismatch refuses as stale instead
of silently absorbing a collaborator's concurrent topology or position edit.

The fingerprint is `sha256:` plus lowercase hex over canonical JSON for a
versioned projection (`subgraph-lifecycle-plan-v1`). Projection arrays use the
canonical sort orders below; records sort their object keys recursively, and
absent fields stay absent. It includes boundary and `alsoBinds` array order,
dynamic state, every occurrence-tap source link, group state, and
`collapsedNets`. The hash never depends on ambient object iteration order.

Core commands do not call canvas layout. The app planner resolves the current
scene fallback positions/sizes into `resolvedGeometry`, computes the finite
`placementCenter`, and fingerprints the source view records from which they
came. The command validates that every selected id has one matching geometry
entry. Shared re-execution therefore uses exactly the planned geometry or
refuses stale; the no-view fallback is executable without importing canvas
code into core.

Lifecycle commands remain deterministic and schema-blind like existing
boundary commands. The app/core planner uses the active registry to resolve
specialized slots, families, promoted widgets, and flatten state routes, then
serializes the exact `boundaryPlan`, canonical consulted `schemaSnapshot`, and
`stateRoutePlan` into the invocation. `schemaPlanDigest` hashes that immutable
snapshot. It is not merely a pointer to the ambient registry.

The state plan enumerates every source boundary address and every key present
in occurrence `dynamic`, `values`, and `controllers`, including schema-valid
inactive branches. Dormant keys are generated by recursively traversing the
snapshotted schema and applying `valueKeyOf`; packed keys are never parsed.
For every source it records exactly one destination route or a named refusal.
Command execution validates plan shape, source ids, endpoint ownership, route
target existence, snapshot digest, and exact one-to-one coverage before any
destructive write. Unexpected, duplicate, or unmapped source state refuses.

The app also refuses initial dispatch if the active registry no longer hashes
to the planned digest. Shared re-execution does not consult or replan against
the latest registry: it applies the immutable schema snapshot and exhaustive
maps in the invocation, or drops the command when the document fingerprint/
coverage no longer matches. Two collaborators therefore cannot derive
different patches from different schema caches. Schema drift discovered after
commit remains visible through existing boundary derivation diagnostics.

### Deterministic allocation and remapping

Extract allocates its definition and remapped entity ids during command
execution; flatten allocates cloned entity ids during command execution.
Definition ids use the existing blueprint rule: the smallest unused `g<n>`;
shared re-execution may choose a different id without changing intent. Empty
creation fixes only its definition id because the existing `subgraph.import`
and `node.add.type` invocations must embed the same id. `node.add` still
allocates the occurrence node id under `tx.actor`, and may reallocate it during
shared re-execution. A definition-id collision fails the whole batch.

The fresh definition starts with an empty allocator and remaps every moved
core graph entity in this order:

1. nodes by old id;
2. value sources by old id;
3. selectors by old id, then candidates in stored order;
4. reroutes by old id;
5. internal links by old id; and
6. internal named nets by old id.

Each kind uses its existing allocator prefix (`n`, `v`, `s`, `c`, `r`, `l`,
`net`) through `graphAllocator`. Node ids in `PortRef` and `WidgetTapRef`,
reroute/value-source/selector references, selector policies, link endpoints,
net endpoints, boundary bindings, and view keys are rewritten through the
maps. A missing map entry is an internal planning error and refuses the whole
command.

Dynamic member ids are node-local stable identity and remain unchanged with
their owning node; their `members`, `memberState`, value keys, and endpoint
member paths move together. Remapping them would require parsing opaque value
keys, which the identity contract forbids. The new definition cursor is
floored above any allocator-shaped candidate ids retained by a future format
extension. Unknown namespaced `ext` data round-trips byte-for-byte and is not
searched for hidden id references; extensions that store core ids in `ext`
need the remapper contract deferred below.

Existing parent crossing links and nets keep their ids and are rewired in
place. Only additional fan-out links, cloned inner topology, and the new
occurrence allocate from the parent definition's existing graph allocator in
deterministic cut order. This minimizes identity churn and preserves any
opaque data attached to surviving parent records.
Group ids allocate from the target graph's `groupSeq`/`groupAllocationFloor`,
never `nextOrdinal`, matching `view.createGroup` and clipboard paste.

## Create an empty subgraph

One parameterized app creation planner owns fresh definition-id and display-
name allocation for every create-new-definition gesture. Its input contains
(a) an id-less definition/view initializer and (b) occurrence initialization
fields supported by `node.add`, excluding `type` but including a future
`NodeData.region`. The planner chooses the fresh id/name, injects
`GraphDef.id`, constructs `node.add.type` as `#<freshGraphId>`, validates the
completed shapes, and emits one `subgraph.import` + `node.add` batch. Consumers
may supply semantic initial nodes and boundary items, but cannot supply the
definition id/occurrence type, independently allocate them, or assemble a
competing create batch.

The empty-subgraph action calls this planner with an empty definition, an
ordinary occurrence, and the first unused display name from `New Subgraph`,
`New Subgraph 2`, and so on, comparing all definition names. A caller-supplied
nonblank name replaces that default but is not forced unique; `GraphDefId`,
not name, is identity.

The imported definition is:

```text
GraphDef {
  id: freshGraphId
  name: chosenName
  nodes: {}
  links: {}
  nets: {}
  reroutes: {}
  boundary: { inputs: [], outputs: [] }
  nextOrdinal: 0
}
GraphViewState { nodes: {} }
```

The same batch then invokes `node.add` in the current graph with type
`#<freshGraphId>`, the requested position, empty values, and no title override.
The occurrence therefore displays the shared definition name and has the
minimal empty derived interface. Boundary pseudo-node positions remain absent
so existing deterministic layout places them when the user drills in.

If `subgraph.import` observes a newly occupied id during shared-session
re-execution, the batch refuses atomically and the shared session reports the
dropped intention using the existing `graph.exists` diagnostic. The app may
offer an explicit retry that replans the entire fixed-id batch from the new
document; it never rewrites only one invocation or substitutes an occurrence
pointing at somebody else's definition.

## Extract a selection

### Atomic algorithm

`subgraph.extract` performs these phases against its transaction working copy:

1. Validate graph context, selected ids, fingerprint, finite view geometry,
   structural-cut support, boundary derivability, and prospective recursion.
2. Build a canonical cut plan over links, nets, and the current definition's
   own boundary bindings.
3. Allocate the fresh definition and all inner/parent id maps.
4. Copy selected entities and wholly internal topology into the fresh
   definition, rewriting known identities.
5. Derive fresh boundary items from cuts, then rewrite parent links, nets, and
   enclosing boundary bindings through the new occurrence.
6. Remove moved entities and obsolete topology from the parent.
7. Add the fresh definition view, occurrence view, and moved groups.
8. Run ordinary document invariants on the staged result. Any error aborts all
   phases.

This is one command outcome, revision, collaboration op, and undo record.

### Crossing-link inference

Every ordinary link is classified after tracing only enough structural
topology to determine ownership:

- both terminal sides inside: copy it as internal topology;
- producer outside and consumer inside: an **in-cut**;
- producer inside and consumer outside: an **out-cut**; or
- both outside: leave it unchanged.

In-cuts are grouped by canonical outer producer endpoint. One boundary input
binds the sorted first inner consumer as `binds` and the rest as `alsoBinds`.
The parent has one delivery from that producer to the occurrence input. This
preserves fan-out and follows ComfyUI's useful one-input-per-producer UX while
using Dinkster's existing fan-out representation.

Coordinator pin 2026-07-29: a consumer-delivering in-cut link with nonempty
semantic `LinkData.ext` is exempt from same-producer grouping. It receives its
own boundary input, so its retained parent link unambiguously keeps that
consumer's exact opaque `ext`. Plain links from the same producer still group
through one `alsoBinds` item. A mixed producer partition is deterministic:
all plain links form one group and each ext-bearing link forms one single-link
group, ordered by the ordinary canonical producer/primary-consumer/link order.
Equal-looking extension payloads never re-group because extension equality is
not a core-owned interpretation.

Out-cuts are grouped by canonical remapped inner producer `PortRef`. One
boundary output binds that source and every external consumer is rewired from
the occurrence output. A producer that also has internal consumers retains
those internal links.

Consumer-delivering link `ext` stays on the parent link that still terminates
at the effective consumer. Structural-feed `ext` may disappear when a
reroute-only segment is normalized; `LinkData` already defines it as
view-only on such segments.

### Stable boundary ids, labels, and order

Cut ordering never depends on map insertion or selection order. Inputs sort by
canonical producer endpoint, then primary consumer `portRefKey`; outputs sort
by producer `portRefKey`, then first outer consumer endpoint.

The input base name is the primary inner consumer's exact port id. The output
base name is the inner producer's exact port id. Empty names fall back to
`input` or `output`. The base is used unchanged when globally unique across
both boundary sides; collisions receive `_2`, `_3`, and so on in cut order.
`displayName` is initially absent, so the stable id is also the visible label
and `boundary.renameItem` remains the one rename path. Schema display names
are deliberately not used: commands remain schema-blind and a schema refresh
cannot rename a persisted interface.

Concrete dynamic member cuts use `kind: 'port'` with the exact
`port`/`members` address. Extraction does not infer `kind: 'family'` merely
because all currently materialized members cross; that would move future
member ownership to each occurrence and change semantics. Whole-family
forwarding is retained only when extraction rewrites an already-existing
family boundary binding.

A direct cut into the root of a specialized DynamicSlot is not a concrete
port cut. Once both the explicit `kind: 'slot'` representation and
`SlotCrossing` from `docs/boundary-forwarding-design.md` ship, extraction
creates a nested slot item and flatten reverses it through that crossing;
`alsoBinds`, `promoted`, and `slots` remain illegal. Until both exist,
`subgraph.extract.specializedSlotUnsupported` refuses a direct slot-root cut.
Dependent ports already elaborated beneath an active slot remain concrete
port cuts, subject to route validation.

### Existing enclosing boundary bindings

When extraction runs inside a subgraph definition, its Inputs/Outputs panels
are not links, but their bindings are real cuts and must survive:

- an enclosing boundary input target moved inside becomes a binding to the
  new occurrence input;
- selected targets from one enclosing fan-out collapse behind one nested
  boundary input, while unselected targets remain in their original stable
  order;
- if the enclosing primary target moved, the occurrence input replaces that
  primary; otherwise it is inserted as an additional target at the position
  of the first moved additional target;
- an enclosing output source moved inside is rebound to the occurrence
  output; and
- an existing `kind: 'family'` binding becomes a nested family item whose
  inner binding receives the original remapped `node`, `port`, and ancestor
  `members` but exposes the whole family; the enclosing item retains its
  original `slots` filter and rebinds to `{node: occurrence, port:
  nestedItem.id}` with no `members`; and
- once both `kind: 'slot'` and the shared `SlotCrossing` interpretation exist,
  an enclosing slot item is nested in the same manner and rebound to the
  occurrence slot. Until both boundary-forwarding slices have shipped, the
  operation refuses explicitly.

If an enclosing static item is promoted, the nested boundary item is also
`promoted: true`; otherwise the intermediate derived schema would erase the
widget before the outer promotion can reach it. The intermediate occurrence
stores no value of its own. This is forwarding, not a new owner. Its lowering
must use the fallback/ownership rules in
`docs/boundary-forwarding-design.md`.

An enclosing binding and an ordinary internal driver claiming the same moved
input is already inconsistent with the one-driver intent. Extraction refuses
rather than choose one.

## Cut behavior matrix

The table is normative for v1. "Refuse" means no document mutation and an
anchored error, not silent exclusion from the selection.

| Construct crossing the selection boundary | Extract behavior | Flatten inverse |
| --- | --- | --- |
| Plain node-port link | Infer input/output boundary item and retain consumer link `ext`. Group plain fan-out by producer; a link with nonempty semantic `ext` gets its own input so grouping cannot discard per-consumer state (coordinator pin 2026-07-29). | Expand occurrence input to every bound inner target; map one bound output to all outer consumers. |
| Reroute chain | A reroute whose producer and every consumer are inside moves with its links. An unselected parent-side reroute remains and is rewired to the occurrence. A selected reroute lying on a crossing chain refuses because no boundary binding can drive or source a reroute. | Inner reroutes clone into the parent with fresh ids. Existing parent reroutes remain on outer links; adjacent chains join through the rewritten link without sharing ids. |
| Named net | If source is outside, selected sinks become one occurrence sink on the same parent net and one nested boundary input fans out to the moved sinks; outside sinks stay. If source is inside, the parent net source becomes the occurrence output while selected sinks retain an inner net. A wholly internal net moves. | An occurrence net sink expands to bound cloned inputs; an occurrence net source becomes the cloned bound output. Duplicate sinks are rejected, not silently deduplicated. |
| Widget tap outside -> selected consumer | Treat the tap as an ordinary outer producer. The tap remains in the parent and feeds the occurrence input. | Reconnects like any occurrence input delivery. |
| Selected widget tap source -> outside consumer | Group fan-out by exact `node/tap`, create one output-side `widgetTap` binding, and rewrite every outside consumer through the occurrence output. Dynamic, ambiguous, missing, or non-widget tap targets fail boundary derivation. | An occurrence output bound to a widget tap restores the cloned exact tap endpoint. A tap on a promoted occurrence input still maps through the forwarding crossing to the cloned primary inner widget tap; driven and undriven value behavior follows `boundary-forwarding-design.md`. |
| Value source outside -> selected consumer | Value source stays parent and feeds the occurrence input. | Reconnects like any occurrence input delivery. |
| Selected value source -> only selected consumers | Move source, view, and internal links. | Clone source and links with fresh parent ids. |
| Selected value source -> outside consumer | Refuse `subgraph.extract.structuralOutputUnsupported`: value sources have no legal boundary output binding or stable declared output port. | Not produced by extraction v1. Imported documents with such an impossible binding already fail shape/invariants. |
| Selector outside -> selected consumer | Selector stays parent; its output feeds the occurrence input. | Reconnects like any occurrence input delivery. |
| Selected selector and all candidates/consumers inside | Move selector, candidate policy/state, view, and internal links. | Clone selector, candidates, policy, and links with fresh ids. |
| Link into a selected selector candidate, or selected selector output -> outside | Refuse `subgraph.extract.structuralCutUnsupported`; a boundary cannot bind a selector candidate or output. | Not produced by extraction v1. |
| Dynamic-family member link | Preserve exact `PortRef.port` and full stable `members` path in a concrete port binding. Recursive member state moves with its owning node. | Translate through the same `FamilyCrossing`; merge definition prefix and occurrence suffix state, then materialize it on the cloned node without persisting compile-only NUL-rebased ids. |
| DynamicCombo or DynamicSlot member/dependent link | Preserve the concrete elaborated address and all dormant node state. If the route cannot be resolved unambiguously, refuse. A specialized slot ROOT requires both `kind: 'slot'` and `SlotCrossing` and refuses until both exist. | Project the occurrence choice and descendant state onto the cloned inner construct through the shared crossing abstraction. Unknown/inactive paths refuse rather than disappear. |
| Widget-backed input crossed by a link/net | Boundary input is not promoted: its producer remains authoritative in the parent. Dormant inner value/controller state stays on the moved node. | External delivery drives each inner target; dormant cloned values remain for later disconnect. |
| Existing promoted enclosing boundary widget | Promotion is forwarded through the nested item as described above; no value is copied onto the intermediate occurrence. | Occurrence value/controller state maps to the primary and `alsoBinds` targets using the forwarding owner rules. |
| Link into/out of another subgraph occurrence | Treat the other occurrence as a normal node with its derived schema. If selected, it becomes a nested occurrence referencing the same definition; if unselected, the cut terminates on its ordinary port. | Nested occurrences remain occurrences with their definition references; outer occurrence consumers/producers reconnect normally. |
| Current definition boundary binding | Treat as an enclosing-boundary cut and rewrite it through the new occurrence. | Expand it through the flattened occurrence boundary, preserving primary/fan-out order and promotion. |

The structural-producer refusals deliberately match the current boundary audit
in `docs/boundary-forwarding-design.md`. Supporting them later requires the
producer-binding union designed there; extraction must not get a private
one-off encoding first.

## Groups and view state

### Extraction

The planner snapshots group membership spatially using the same center-inside
bounds rule as existing group interactions.

- Selecting a nonempty group expands the semantic selection to every node,
  reroute, value source, and selector inside it.
- A group moves into the definition when it was explicitly selected and all
  of its snapshotted members move. An empty selected group also moves.
- An unselected group never moves merely because all current members happen
  to be selected.
- A straddling group remains unchanged in the parent. It is not clipped,
  duplicated, or given stored membership. This may leave a smaller or empty
  rectangle after extraction, which is truthful for a pure view construct.

Compute the bounds of moved positioned entities using stored positions and
sizes when present, otherwise the scene's deterministic fallback geometry.
Let its center be `C`. Inner node/reroute/value-source/selector positions and
moved group bounds subtract `C`, preserving relative geometry. The occurrence
is centered at `C`; its final node size remains derived from its boundary
schema. Existing per-node size, collapse, section, color, and widget-view
records move with their node. Boundary panel positions start absent.

If no moved entity has usable geometry, use the user's invocation position as
`C` from the planned `placementCenter` and emit a warning. Non-finite or
incomplete planned geometry refuses.

`collapsedNets` follows actual net identity by direction:

- outside source -> moved sinks: retain/rewire only the parent net. Inner
  delivery is boundary fan-out, not a `NamedNetData`, so there is no inner
  collapsed flag. Parent `ext` and collapsed state remain unchanged;
- moved source -> inside and outside sinks: create the actual inner/parent
  split and copy the collapsed flag to both records. Refuse nonempty `ext`
  because assigning or duplicating opaque semantic state is undefined; and
- wholly moved net: move `ext` and collapsed state with the net.

A newly inferred boundary delivery has no collapsed-net state. Flattening
preserves each real resulting net's own flag.

### Flatten

Compute the inner positioned-content center with the same rule. Offset all
cloned body positions and group bounds so that center lands on the occurrence
center in the parent. Fresh parent group ids preserve title, color, bounds,
and `ext`; spatial membership remains derived after placement.

The occurrence shell's size, collapsed state, sections, color, and title are
not copied to arbitrary body nodes. They describe the shell being removed.
The preview must disclose this view-only loss. Body view state survives.

## Modes, nested subgraphs, and recursion

### Muted and bypassed selected nodes

Extraction copies each selected node's `mode` unchanged. It adds an active
occurrence and does not push the selected mode onto the occurrence or its
neighbors. Therefore the selected node's bypass/mute routing remains in the
same body topology.

The conservative `compile.wire15.modesUnsupported` gate remains authoritative
before and after extraction. Extraction neither clears a mode nor claims that
nesting makes a recursive wire-15 construct supported. Once
`docs/wire15-bypass-mute-routing-decision.md` is implemented, lifecycle tests
must use that same structural-interface routing rather than a special extract
path.

Flattening an occurrence whose own mode is `muted` or `bypassed` refuses in
v1 as `subgraph.flatten.modeUnsupported`. Muting all body nodes is not
equivalent to muting the occurrence boundary, and there is no general way to
distribute occurrence bypass routing into the body. Modes on nodes inside an
active occurrence clone unchanged.

### Nested occurrences

Extraction moves a selected `#<GraphDefId>` node as ordinary `NodeData`. It
does not clone or detach the referenced definition. Occurrence-local values,
controllers, dynamic choices, mode, title, and `ext` remain on that moved
node. Links into/out of it are cut using its derived boundary schema.

Flattening one occurrence clones only that occurrence's immediate definition
body. Nested occurrences in the body remain nested references. "Flatten all"
is repeated explicit flatten operations, each independently undoable.

### Recursion prevention

Before mutation, build the prospective definition-reference graph and run the
same DAG rule as `checkNoRecursion`:

- extraction adds `parent -> fresh` and `fresh -> each moved occurrence ref`;
- flatten removes `parent -> flattenedDef` for that occurrence and adds
  `parent -> each immediate nested ref in the cloned body`; and
- empty creation adds only `parent -> fresh`.

An invariant-clean source DAG makes the normal transforms safe, but the
explicit preflight gives a local anchored error and protects commands applied
to imported or concurrently changed data. No operation may create a
definition containing an occurrence of itself directly or transitively.

## Flatten an occurrence

### Preconditions

`subgraph.flatten` takes `graphId`, `instancePath`, `nodeId`, a finite planned
parent `placementCenter`, canonical `resolvedGeometry` for the occurrence and
every body positionable/group, the immutable schema/state plans described
above, and a `selectionFingerprint` covering the occurrence, referenced
definition, boundary, body topology/view, all incident parent links/nets/
boundary bindings, occurrence-local state, and source geometry records. It
requires:

- an existing active `#<defId>` node;
- a resolvable, invariant-clean definition boundary;
- no `region` contract on the occurrence;
- every occurrence-local value/controller/dynamic key to resolve through the
  current derived boundary/crossing model; and
- sufficient parent graph/group id capacity.

Missing schemas may render nodes as placeholders, but flattening needs no
backend schema for plain static boundary routes. It refuses only when schema
derivation is required to interpret a family, selector, specialized slot, or
promoted widget and that schema is unavailable.

L5 carries an exact canonical `boundaryPlan` entry for every body boundary
item, the canonical `schemaSnapshot` consulted by
`planFlattenBoundaryRoutes`, and its `schemaPlanDigest`. The planner resolves
authored node types through the active resolver and keys snapshot fragments by
the byte-for-byte authored type, including aliases whose resolved schema has a
different canonical type. The command remains schema-blind: it validates plan
shape, endpoint ownership, route target existence, exact coverage, snapshot
integrity, and the document fingerprint without consulting the live registry.
The exported `flattenRegistryMatchesSchemaPlan` helper provides the separate
initial-dispatch registry-versus-digest guard; shared replay deliberately uses
the immutable snapshot and plan.

The planner resolves scene fallback geometry before dispatch. Command
execution validates finite, complete geometry and uses the serialized body
center/offset; it never invokes canvas layout. Shared re-execution uses that
same placement or refuses when fingerprinted source view records changed.

### Clone and reconnect algorithm

1. Allocate fresh parent ids for every body node, value source, selector and
   candidate, reroute, internal link, net, and group. Rewrite all known core
   references. The shared definition remains unchanged.
2. Materialize the occurrence's effective boundary state onto the clones as
   specified below.
3. For each external link into an occurrence input, translate the boundary
   item to its primary plus `alsoBinds` cloned targets. Rewire the original
   link to the first target and allocate one additional delivery for each
   later target. Preserve the original consumer-delivery `ext` on every
   terminal delivery. A reroute/value-source/selector/tap producer remains
   valid.
4. For each parent net sink on an occurrence input, replace it with all cloned
   bound input sinks in stable binding order.
5. For every occurrence output, rewrite each external link source and parent
   net source to the one cloned inner bound producer.
6. Classify every parent link sourced from
   `{node: occurrence, tap: boundaryInput}` before shell removal. Match that
   memberless boundary address through the shared crossing: a static promoted
   input rewrites the existing link source in place to the cloned primary
   inner `WidgetTapRef`; a specialized-slot descendant uses `SlotCrossing`.
   An unpromoted, family-member, ambiguous, stale, or unsupported slot tap
   refuses. Retain link id and `ext`, then run ordinary tap-cycle and driver
   checks after incoming expansion so a driven tap aliases the primary
   target's expanded driver.
7. Rewrite any enclosing current-definition boundary binding that targets an
   occurrence input/output through the same expansion. Family bindings remain
   family bindings and concrete fan-out uses this exact splice: replacing a
   primary inserts child primary then child `alsoBinds`, followed by the old
   outer additions; replacing an additional target inserts all child targets
   at that target's index. The enclosing item remains the visible promotion
   owner. Family flatten uses one route-composition algorithm: (a) match the
   enclosing occurrence address, including descendant `port`, through the
   child `FamilyCrossing`; (b) materialize every crossed suffix member and
   translate the complete port/member path through the persisted map; (c)
   project the child's slot-selection tree down into the targeted descendant
   family's coordinate system; and (d) intersect that projection with the
   enclosing selection, treating absence as whole only at that target.
   Serialize entries in canonical template order; refuse an empty, ambiguous,
   or unrepresentable result. Slot bindings follow `SlotCrossing` once
   available.
8. Remove the occurrence and any incident links not already rewritten, install
   the rewritten
   topology, then place cloned view state around the old occurrence center.
9. Validate one-driver, tap-cycle, boundary, id, and recursion invariants
   against the staged node records before commit. The prospective DAG is
   rebuilt from all staged occurrences, so another surviving `#<defId>` in
   the parent keeps its reference edge.

If two expanded paths would drive one input, if a net expansion repeats a
sink, or if a rewritten output has no unique inner producer, flatten refuses.
It never deduplicates semantic deliveries merely to make invariants pass.

### Occurrence-local state materialization

Flattening must produce the same effective body that compiling that occurrence
would see, while replacing derived compile-only identity with legal persisted
identity.

- **Plain promoted widget:** resolve one effective occurrence value and
  controller mode through the same shared crossing/fallback helper required by
  `boundary-forwarding-design.md`: explicit occurrence state first, then the
  primary forwarding chain's definition value, then schema/intrinsic default.
  Materialize that one result onto the cloned primary and every eligible
  `alsoBinds` owner. Do this even while externally driven so it stays dormant
  for a later disconnect. Independent target fallbacks are never retained,
  because one pre-flatten occurrence must not become several values.
- **Unpromoted widget:** definition state remains authoritative, but a stored
  occurrence value/controller is dormant user data that re-promotion would
  restore. Flatten has no semantically inert destination for it and therefore
  refuses as `subgraph.flatten.dormantStateUnsupported`. It is never ignored
  or written onto an active cloned widget.
- **DynamicCombo forwarding:** a valid occurrence selection replaces the
  cloned inner construct's selection at the exact route. Unset inherits the
  definition selection. Branch-local values remain definition-owned unless
  the boundary forwarding contract explicitly forwards them.
- **Whole family forwarding:** use a new schema-aware persisted materialization
  result built by the same route resolver as `FamilyCrossing`, not
  `FamilyCrossing`'s compile-only NUL map. For ordinary and wire-15 prefix
  families, each affected scope allocates fresh canonical `m<N>` ids in stored
  suffix order from `max(seq, highest members/memberState suffix + 1)`, refuses
  past `MAX_MEMBER_ORDINAL`, and updates `members`, `memberState`, and `seq`.
  For wire-15 names families, each occurrence suffix is semantic identity: the
  materializer preserves it exactly and in occurrence order, verifies it is in
  the declared `memberNames` vocabulary, and refuses a stale name, duplicate,
  or collision with definition-owned materialization. It never invents `m<N>`
  for a names family. Native free-suffix families are inert today and refuse
  stateful flattening until their persisted materialization program ships.
  These rules recurse independently at each nested scope. The structured
  result maps outer PortRefs,
  construct/member scopes, and elaborated inputs before/after materialization;
  values/controllers map through `valueKeyOf` on those elaborated inputs,
  never by parsing a packed key. Parent links, net sources/sinks, enclosing
  bindings, dynamic state, values, and controllers all consume this one map.
  Orphan member state, inactive paths, address collisions, missing mappings,
  or exhaustion refuse. A final assertion rejects NUL only in persisted
  identities produced or translated here: member ids/memberState keys,
  endpoint/boundary member paths, and generated value/controller keys. It does
  not inspect unrelated user JSON string values.
- **Specialized-slot forwarding:** project the occurrence's selected variant,
  shared/variant descendant values, controllers, nested dynamic state, and
  forwarded tap owner through the `SlotCrossing` required by
  `boundary-forwarding-design.md`. The lifecycle implementation cannot ship
  a second parser; until that crossing exists, flatten refuses definitions
  using direct specialized-slot forwarding.
- **Forwarded widget tap:** if an outer consumer taps the occurrence input,
  map it to the cloned primary inner widget tap. If the occurrence input is
  driven, it aliases that driver through normal compile semantics; if
  undriven, the transferred occurrence value/fallback is authoritative.
- **Dormant state:** state under inactive but still valid branches is
  translated and retained. A key that cannot be mapped because the boundary
  changed after it was stored refuses with an anchored stale-state diagnostic;
  flatten does not drop user data.

Occurrence `title` and shell view fields intentionally disappear with the
shell. Occurrence `ext` is copied nowhere because its owner disappears; a
nonempty occurrence `ext` therefore refuses in every session until extension
remappers exist. Body entity `ext` data stays with each cloned entity
unchanged.

## Definition retention

Flattening or deleting the last occurrence does **not** delete its definition.
Definitions are shared assets; occurrence count is not ownership, eager
deletion races undo/collaboration, and an orphan may be intentionally reused.
Undo of flatten therefore only removes the clones and restores the occurrence;
it need not reconstruct a deleted definition.

The Subgraph Definitions dialog previews definitions that are unreachable
from the root, including orphan trees whose definitions reference one another.
Its confirmed cleanup removes the complete reviewed set plus matching views
and core-owned support state as one stale-plan-protected command. Undo and
redo restore or remove the set atomically. `subgraph.deleteDefinition` also
supports one safe deletion when no remaining orphan references it. Save
does not silently garbage-collect.

## Undo, collaboration, and rebase safety

- Empty creation is one `batch`; extract and flatten are each one primitive
  lifecycle command. Each is exactly one local undo/redo step.
- Forward and inverse patches use the existing `DocumentStore`; no lifecycle
  snapshot format or private history exists.
- Extract/flatten invocations contain semantic source ids plus a fingerprint,
  not preallocated destination ids. Their allocation happens during command
  execution under `tx.actor`, so shared re-execution mints from the correct
  actor cursor. Empty creation instead replays a batch carrying a fixed planned
  definition id; `node.add` still remints the occurrence node id under the
  current actor. An intervening definition-id claim produces `graph.exists`
  and drops the intention.
- A foreign edit to selected/body/incident topology or relevant view state
  invalidates the fingerprint. Shared rebase drops the pending intention and
  emits its existing conflict path with the lifecycle diagnostic. The command
  never broadens the selection or incorporates a new cut silently.
- A foreign edit outside the fingerprint may rebase normally. Fresh graph and
  entity ids can change; all references are derived in the same execution.
- The app changes selection/navigation only after a successful command
  outcome. Ephemeral canvas state is not part of undo or collaboration.
- Undo remains local intention replay. If later foreign edits make the inverse
  impossible, the existing shared-session conflict behavior applies; no
  lifecycle command force-restores over collaborators.

## Validation and diagnostics

Lifecycle commands return ordinary `Diagnostic` values. Errors anchor to the
current `instancePath` plus the selected/occurrence node; port-specific cuts
also set `anchor.port`. `refs` include `graphId`, `nodeId`, `portId`, and
direction so Problems and command UI can label them without parsing messages.

### Loud refusals

| Code | Condition |
| --- | --- |
| `subgraph.extract.empty` | No semantic item selected. |
| `subgraph.lifecycle.contextInvalid` | `instancePath` does not resolve to `graphId`. |
| `subgraph.lifecycle.selectionMissing` | A named source entity disappeared. |
| `subgraph.lifecycle.stalePlan` | Fingerprinted entity, topology, boundary, or view changed. |
| `subgraph.lifecycle.idExhausted` | Graph or group allocator cannot represent all fresh ids. |
| `subgraph.extract.structuralCutUnsupported` | Selected reroute/selector crosses a boundary the binding model cannot represent. |
| `subgraph.extract.structuralOutputUnsupported` | An out-cut originates at an inner value source. |
| `subgraph.extract.specializedSlotUnsupported` | A direct specialized-slot root cut requires the shared slot binding/crossing that has not shipped. |
| `subgraph.lifecycle.boundaryUnresolved` | Existing or inferred binding cannot derive one route/type. |
| `subgraph.lifecycle.multiDriver` | Transform would produce two deliveries to one input/candidate/reroute. |
| `subgraph.lifecycle.recursive` | Prospective definition references are cyclic. |
| `subgraph.flatten.notOccurrence` | Target is not a resolvable `#<defId>` node. |
| `subgraph.flatten.modeUnsupported` | Occurrence shell is muted or bypassed. |
| `subgraph.flatten.regionUnsupported` | Occurrence carries a region contract. |
| `subgraph.flatten.stateUnresolved` | Occurrence-local forwarded/dormant state has no unique inner route. |
| `subgraph.flatten.dormantStateUnsupported` | An unpromoted boundary key has occurrence-local value/controller state with no inert flattened owner. |
| `subgraph.flatten.nativeFamilyUnsupported` | Occurrence-local state targets an inert native free-suffix family with no persisted materialization program. |
| `subgraph.flatten.extensionStateUnsupported` | Occurrence-owned `ext` cannot be mapped safely. |
| `subgraph.flatten.boundaryExtensionUnsupported` | Body boundary-item `ext` would lose its owner when the boundary dissolves. |
| `subgraph.flatten.specializedSlotUnsupported` | L5's exhaustive route plan identifies a specialized slot that requires shared `SlotCrossing`. |

All structural shape and invariant diagnostics from existing validators also
remain authoritative. The lifecycle does not catch and downgrade them.

### Allowed degradation and warnings

- A straddling or unselected group remains in the parent; warn when it becomes
  empty after extraction.
- Missing optional view records use deterministic scene fallback positions.
- Structural-feed link `ext` lost solely by reroute normalization is view-only
  by the document contract; warn once per operation when this occurs.
- The occurrence shell's title and view styling disappear on flatten after a
  preview disclosure.
- Unknown schemas on body nodes remain placeholder-capable when no boundary
  interpretation needs them.

Semantic topology, values, modes, dynamic state, and occurrence-owned
extension state never degrade silently.

## Regions integration and sequencing

Extraction is the foundation for the deferred **Wrap selection in region**
feature from `docs/regions-design.md`. When revived, a dedicated atomic
`region.wrapSelection` command will consume the same pure extract plan and
transform while decorating its planned occurrence with the `region` contract
before the one commit. Its decorator writes input roles, distinct-output
`outputRoles` entries whose state roles name `statePort` input ids, and a
separate `continueOutput`; it never pairs state input/output by same id. It
must not call `subgraph.extract` and then mutate the occurrence in a second
undo step, nor maintain a second cut, naming, id-remap, group, or view
algorithm.

Flattening an occurrence carrying `region` is REFUSED in v1 with anchored
`subgraph.flatten.regionUnsupported`. Removing the shell would erase map/fold/
while iteration, element/state roles, gather/state outputs, continuation, and
binding semantics; distributing those semantics over ordinary nodes is not
defined.

Sequencing is pinned:

1. Regions R1 landed independently as slice 78.
2. The separate Regions R1.5 core migration to `outputRoles` lands before R2;
   it may proceed in parallel with lifecycle implementation.
3. This subgraph lifecycle implementation L1-L7 lands before R2.
4. Regions R2 (authoring UI) then invokes
   the parameterized creation planner with the invariant-clean initializer
   chosen by `docs/regions-design.md`'s preserved R2 template decision and a
   region-bearing occurrence initialization using the R1.5 `outputRoles`
   contract. Wrap-
   selection remains deferred exactly as `docs/regions-design.md` specifies;
   when revived, its atomic command shares the pure extract transform.

## Implementation slices

Each slice is independently reviewable and testable.

### L1 - Pure lifecycle planner and cut audit

- Add pure canonical selection/fingerprint, ownership, cut grouping, boundary
  naming, prospective-DAG, versioned canonical hash, and geometry-plan helpers.
- Exhaustive table tests for plain links, nets, enclosing boundaries, all
  structural endpoint directions, dynamic member addresses, and stale plans.
- No mutation command or UI.

### L2 - Empty create path

- Add the parameterized creation planner and empty action using the existing
  `subgraph.import` + `node.add` batch; prove a region-shaped caller can supply
  the eventual R2 initializer and R1.5 `outputRoles` occurrence data without a
  second allocation path. L2 does not decide R2's preserved starter-template
  question.
- Add command/menu/search entry and successful drill-in selection behavior.
- Prove one undo, name suffixing, shared collision refusal, and minimal
  boundary/view shape.

### L3 - Extraction core

- Implement `subgraph.extract` for nodes, plain links, named nets, current
  boundary rewrites, deterministic id maps, and invariant gating.
- Unit tests assert exact documents, one undo/redo, parent allocator behavior,
  nesting, and shared re-execution/drop behavior.

### L4 - Extraction structural and view completion

- Implemented 2026-07-30. The temporary L3
  `subgraph.extract.viewUnsupported` gate is removed; extraction now transfers
  the selected structural and view constructs below.
- Add value sources, selectors, reroutes, groups, positions, modes, recursive
  dynamic member addresses, promoted enclosing boundary forwarding,
  specialized-slot root refusal/support gating, collapsed-net view behavior,
  and every normative refusal/warning in the matrix.
- Add coexistence tests combining nets, reroutes, taps, value sources,
  selectors, wire-15 members, nested occurrences, and groups in one extract.

### L5 - Flatten core

- Implemented 2026-07-30. Clone/remap/place and plain boundary link/net/current-boundary
  expansion for active occurrences.
- Prove shared definition immutability, retained orphan definitions, one undo,
  duplicate-driver refusal, nested occurrence retention, exact positions, and
  named `subgraph.flatten.extensionStateUnsupported` refusal for nonempty
  occurrence `ext`.
- Before L6 landed, occurrence state and family/member route composition used
  temporary fail-closed remainder gates. L6 removed the family remainder gate;
  remaining unsupported cases still fail closed as
  `subgraph.flatten.dormantStateUnsupported`,
  `subgraph.flatten.boundaryExtensionUnsupported`,
  `subgraph.flatten.specializedSlotUnsupported` until their shared
  materializers ship.

### L6 - Flatten occurrence-local state

- Extend the shared boundary crossing abstraction with persisted flatten
  materialization for promoted values/controllers, DynamicCombo selection,
  schema-aware family prefix/suffix state and per-scope member allocation,
  dormant-state refusals, taps, and the pre-`SlotCrossing` slot refusal.
- Reuse this API from compile and flatten tests so two interpretations cannot
  drift. Prove ordinary/prefix families allocate fresh ordered `m<N>` ids,
  names families preserve and vocabulary-check semantic suffixes, native
  free-suffix state refuses, and direct specialized-slot forwarding refuses.
  Boundary-forwarding slice B integration later replaces only the slot
  refusal; L6 does not implement `SlotCrossing`.

#### L6 implementation plan (slice 101)

This subsection is the internal implementation contract for L6. It does not
change the normative semantics in "Occurrence-local state materialization" or
flatten walkthrough step 7. In particular, it does not make compile's NUL-
rebased identities persistable and it does not make active elaboration an
inventory of stored user state.

The current seams that this plan extends are:

- `FlattenSchemaPlan`, `planFlattenBoundaryRoutes`, and the authored-type-
  keyed digest guard in `packages/core/src/lifecycle/planner.ts:34-130`;
- the complete flatten fingerprint projection in
  `packages/core/src/lifecycle/planner.ts:438-514`;
- `FamilyCrossing`, `matchBoundaryItem`, route resolution, and compile-only
  rebasing in `packages/core/src/compile/crossing.ts:35-70,96-196,215-275`;
- the recursive dynamic-state cursor, address model, `valueKeyOf`, member-id
  floor, wire-15 evidence order, conditional handlers, and hard budgets in
  `packages/core/src/schema/elaborate.ts:149-320,460-489,529-677,679-896,
  902-1128,1143-1163`;
- `BoundaryBinding.slots` and `SelectionTree` in
  `packages/core/src/format/document.ts:349-425` and
  `packages/core/src/schema/slot-selection.ts:21-97`;
- structural route hops in
  `packages/core/src/schema/derive-boundary.ts:142-317`, including combo and
  specialized-slot hops; and
- L5's schema-blind command and local-until-commit graph allocator in
  `packages/core/src/commands/subgraph-commands.ts:850-1335` and
  `packages/core/src/commands/alloc.ts:33-85`.

##### Serialized materialization program

The planner always supplies `statePlan` once L6a lands, even when no
occurrence-local state is present. It is required, not a compatibility mode:
absence fails strict shape validation as `params.invalid`. The app discards
cached pre-L6a intentions because their old digest/fingerprint is not v2;
they are replanned rather than upgraded by adding a field. The L6a/L6b
rollout's L5-compatible behavior comes only from the named remainder refusals
below, never from accepting an absent or unverified plan. These are the
JSON-safe records of record; branded id types may replace `string` in source
without changing the serialized fields.

```ts
type FlattenStateRefusalCode =
  | 'subgraph.flatten.stateUnresolved'
  | 'subgraph.flatten.dormantStateUnsupported'
  | 'subgraph.flatten.nativeFamilyUnsupported'
  | 'subgraph.flatten.specializedSlotUnsupported'
  | 'subgraph.lifecycle.boundaryUnresolved'
  | 'subgraph.lifecycle.idExhausted'

interface FlattenNodeStateSnapshot {
  readonly node: string
  readonly type: string
  readonly values: Readonly<Record<string, Json>>
  readonly controllers?: Readonly<Record<string, ControllerMode>>
  readonly dynamic?: Readonly<Record<string, DynamicPortState>>
}

interface FlattenStateSource {
  readonly occurrence: FlattenNodeStateSnapshot
  readonly bodyNodes: readonly FlattenNodeStateSnapshot[]
}

interface FlattenPortAddress {
  readonly port: string
  readonly members?: readonly string[]
}

interface FlattenScopeStep {
  readonly construct: string
  readonly member: string
  readonly storage: 'memberState' | 'pathSegment'
}

interface FlattenFamilyScopeRef {
  readonly construct: string
  readonly ancestors: readonly FlattenScopeStep[]
}

interface FlattenFamilyMemberMap {
  readonly before: string
  readonly after: string
}

interface FlattenFamilyScopeMap {
  readonly id: string
  readonly parent?: {
    readonly scope: string
    readonly beforeMember: string
    readonly afterMember: string
  }
  readonly source: FlattenFamilyScopeRef
  readonly target: FlattenFamilyScopeRef & { readonly node: string }
  readonly policy:
    | {
        readonly kind: 'ordinal'
        readonly materialization: 'ordinary' | 'wire15'
        readonly prefix: string
        readonly min: number
        readonly max: number
      }
    | {
        readonly kind: 'names'
        readonly materialization: 'wire15'
        readonly vocabulary: readonly string[]
        readonly min: number
        readonly max: number
      }
  readonly sourceMembers: readonly string[]
  readonly targetBefore: {
    readonly members: readonly string[]
    readonly memberStateKeys: readonly string[]
    readonly seq?: number
  }
  readonly members: readonly FlattenFamilyMemberMap[]
  readonly targetAfter: {
    readonly members: readonly string[]
    readonly memberStateKeys: readonly string[]
    readonly seq?: number
  }
}

interface FlattenInputIdentity {
  readonly address: FlattenPortAddress
  readonly valueKey: string
  readonly origin:
    | 'static'
    | 'member'
    | 'selector'
    | 'branch'
    | 'slot'
    | 'dependent'
}

interface FlattenMappedTarget {
  readonly bindingIndex: number
  /** Body-local node id; command execution remaps it to the fresh parent id. */
  readonly binding: BoundaryBinding
  readonly input?: FlattenInputIdentity
}

interface FlattenAddressMapEntry {
  readonly side: 'input' | 'output'
  readonly boundaryId: string
  readonly before: FlattenPortAddress
  readonly uses: readonly ('endpoint' | 'value' | 'controller' | 'dynamic')[]
  readonly input?: FlattenInputIdentity
  readonly targets: readonly FlattenMappedTarget[]
}

interface FlattenBoundaryStateRoute {
  readonly side: 'input' | 'output'
  readonly id: string
  readonly bindingCount: number
  readonly familyScopeIds: readonly string[]
  readonly addressIndexes: readonly number[]
}

interface FlattenEnclosingBindingRewrite {
  readonly side: 'input' | 'output'
  readonly itemIndex: number
  readonly itemId: string
  readonly bindingIndex: number
  readonly before: BoundaryBinding
  /** Body-local node ids, in exact splice order. */
  readonly after: readonly BoundaryBinding[]
}

interface FlattenReadyStatePlan {
  readonly version: 'subgraph-flatten-state-plan-v1'
  readonly status: 'ready'
  readonly source: FlattenStateSource
  /** Exact post-materialization state for every body node, body-id order. */
  readonly nodes: readonly FlattenNodeStateSnapshot[]
  readonly familyScopes: readonly FlattenFamilyScopeMap[]
  readonly addresses: readonly FlattenAddressMapEntry[]
  /** Exact boundary order: inputs, then outputs; target order is binds then alsoBinds. */
  readonly routes: readonly FlattenBoundaryStateRoute[]
  readonly enclosingRewrites: readonly FlattenEnclosingBindingRewrite[]
}

interface FlattenRefusedStatePlan {
  readonly version: 'subgraph-flatten-state-plan-v1'
  readonly status: 'refused'
  readonly source: FlattenStateSource
  readonly refusal: {
    readonly code: FlattenStateRefusalCode
    readonly message: string
    readonly side?: 'input' | 'output'
    readonly boundaryId?: string
    readonly key?: string
    readonly address?: FlattenPortAddress
  }
}

type FlattenStatePlan = FlattenReadyStatePlan | FlattenRefusedStatePlan

interface FlattenSchemaPlan {
  readonly boundaryPlan: readonly FlattenBoundaryPlanEntry[]
  readonly statePlan: FlattenStatePlan
  readonly schemaSnapshot: Readonly<Record<string, NodeSchema>>
  readonly schemaPlanDigest: string
}
```

`FlattenStateSource.bodyNodes` and ready `nodes` each cover every body node
exactly once in sorted body-id order. They include only state fields; all
other node fields continue to come from the fingerprinted body clone. A ready
plan's routes cover every boundary item exactly once, every route has exactly
`[binds, ...alsoBinds].length` targets, every map id/index is unique and in
bounds, and every enclosing rewrite points to the exact fingerprinted item,
index, and old binding. Unknown fields, duplicate records, omitted optional
fields represented as empty objects, and ready/refused union mixtures are
`params.invalid`, not tolerated extensions.

The planner owns every schema-aware action: derive the occurrence schema,
resolve each binding route, inventory stored state, allocate persisted family
members, compose slot selections, calculate value/controller keys, produce
the body-local endpoint and enclosing-binding rewrites, and produce complete
post-state snapshots. The command owns no schema lookup and no dotted-path or
packed-key interpretation. It validates the program and source, stages fresh
parent entity ids, remaps body-local node ids, applies the exact snapshots and
rewrites, runs invariant checks, and commits.

`schemaPlanDigest` changes to a versioned canonical projection containing all
three records, not only schemas:

```ts
{
  version: 'subgraph-flatten-schema-plan-v2',
  schemas: [{ authoredType, schema }, ...], // authoredType sorted
  boundaryPlan,
  statePlan,
}
```

The initial-dispatch app guard rebuilds only `schemas` from the active
resolver, retaining the supplied immutable `boundaryPlan` and `statePlan`, and
requires the resulting v2 digest to match. This checks every authored type
the planner consulted, including aliases keyed by their byte-for-byte authored
type. Shared re-execution does not consult the live registry; it verifies the
immutable snapshot checksum and reapplies the plan, preserving L5 replay
semantics. The digest is integrity evidence, never authorization.

Command check order is load-bearing:

1. Validate parameter and plan shape, exact body/boundary coverage, refusal-
   code membership in the closed union above, and v2 digest integrity. Do not
   return a planner-carried refusal yet.
2. Recompute `lifecycleFlattenFingerprint` with plan evidence
   `{boundaryPlan, statePlan, schemaPlanDigest}`. A mismatch returns
   `subgraph.lifecycle.stalePlan`.
3. Canonically compare `statePlan.source.occurrence` and every source body
   node state to the current records. A mismatch after a matching fingerprint
   is `params.invalid`; it indicates a malformed invocation, not stale user
   work.
4. Only now honor a whitelisted `status: 'refused'` diagnostic. A forged,
   stale, or source-mismatched plan can never select a command diagnostic.
5. For `status: 'ready'`, validate exact evidence coverage and stage the
   program. There are no schema-aware fallback decisions after this point.

The flatten fingerprint already includes the complete occurrence record,
complete referenced body and body view, occurrence view, all parent links and
nets incident to the occurrence, every enclosing boundary binding targeting
the occurrence, mode-panel bindings, and collapsed nets
(`planner.ts:438-487`). L6 must retain that coverage and add the whole plan
evidence above. Thus every document record read by state enumeration,
allocation, route composition, or geometry is either in the fingerprint or
in the exact state source. Schemas are covered by the v2 digest and initial
registry guard. The parent graph/actor allocation cursor is deliberately not
frozen: command execution recomputes fresh parent ids after a legal unrelated
rebase. Unrelated parent topology also remains outside the fingerprint; if it
makes the staged whole document invalid, the late invariant gate refuses
atomically.

##### One recursive per-scope family map

`FlattenFamilyScopeMap[]` is the serialized form of one in-memory
`PersistedFamilyMap`. It is flat in canonical pre-order, with explicit parent
references, so a command can validate bounded acyclicity and exact coverage
without recursion over attacker-chosen object links. `source` and `target`
are state cursors, not parsed strings. An ordinary family step uses
`storage: 'memberState'`; a wire-15 family step uses
`storage: 'pathSegment'`, because its stable suffix is part of the dotted
document path while its nested choice records remain in the node's top-level
dynamic map. Mixed ordinary/wire-15 nesting is represented one step at a
time.

For every whole-family target, the planner performs these steps in order:

1. Resolve the binding with `resolveBoundaryRoute` from the snapshot-verified
   schema. Require exactly one family terminal. Record all member, combo,
   slot, and slot-variant hops. Each concrete target ancestor member must be
   present in the corresponding target `DynamicPortState.members`; an orphan
   `memberState` key is not membership. Missing ancestors, route ambiguity,
   and a direct specialized-slot hop refuse.
2. Ask the persisted-state walker below for the source root's ordered member
   set and every recursively reachable nested family scope. Do not synthesize
   minimum-fill or ghost members: the target schema will derive the same
   state-free minimum after flatten, while persisted state is mapped exactly.
3. At each source/target scope independently, validate duplicate-free source
   members, target members, and both `memberState` key sets. Every source and
   target `memberState` key must belong to that same scope's `members`; any
   orphan refuses. Authenticate the scope's exact materialization mode,
   prefix/names vocabulary, and local min/max in `policy`, then validate those
   bounds, maximum depth, per-node member and item budgets, and destination
   address/key uniqueness. Existing target members remain the prefix.
   `targetBefore` records exact allocation evidence and `targetAfter` records
   the result. A local family cap, dynamic-state depth cap, or elaboration
   member/item budget refusal is `subgraph.flatten.stateUnresolved`.
4. For ordinary and wire-15 prefix families, start at
   `max(seq ?? 0, highestCanonicalMSuffix(members U memberStateKeys) + 1)`.
   Allocate one fresh `m<N>` per source member in source order, refuse when
   `N > MAX_MEMBER_ORDINAL`, append to target `members`, and set `seq` to the
   first unused ordinal. Noncanonical member strings do not affect the numeric
   floor but remain collision occupants. A generated id must not collide with
   any member or `memberState` key. Exhausting `MAX_MEMBER_ORDINAL` refuses
   `subgraph.lifecycle.idExhausted`; it is identity-space exhaustion, not a
   malformed stored-state budget.
5. For a names family, preserve each source suffix exactly and in source
   order. At that scope independently, require membership in the terminal
   spec's remaining declared `naming.names` vocabulary, reject duplicate
   suffixes and collisions with target members or `memberState`, append the
   preserved names, and do not invent or advance an ordinal sequence. A native
   free-suffix scope with any state/evidence refuses
   `subgraph.flatten.nativeFamilyUnsupported`.
6. Descend each mapped member in source order and each schema template item in
   declaration order. Build a new child scope map for every nested family that
   has persisted source evidence. Copy valid combo/slot selection records into
   the mapped construct cursor, but allocate nested family members from that
   child's own target `seq/members/memberState` evidence. Never copy a nested
   scope wholesale and never reuse its parent's allocation counter or names
   vocabulary.
7. Generate `FlattenAddressMapEntry` records from the scope map. Ordinary
   family identities move through `PortAddress.members`; wire-15 identities
   move through the schema-known suffix segment; mixed paths do both. The
   walker emits before/after `FlattenInputIdentity` records and calls
   `valueKeyOf` on each actual elaborated input descriptor. No code parses a
   `#`-packed elaboration key or infers a member from an arbitrary dotted
   string.

The one `PersistedFamilyMap` instance is the only identity authority. The
planner uses it to derive the post-node dynamic state, value and controller
keys, parent link endpoints, net source/sink endpoints, and enclosing boundary
bindings. The ready program serializes those applications as `nodes`,
`addresses`, and `enclosingRewrites`, but they are projections of that same
map, not independent mapping algorithms. Proof tests must feed the same deep
mixed-family map through all seven consumers and compare every resulting
identity.

Before/after input descriptors are important even when two keys happen to be
textually equal. `valueKeyOf` distinguishes a static authored id from dynamic
elaborated identity (`elaborate.ts:310-320`), and a wire-15 member may encode
identity in `port` where an ordinary member encodes it in `members`. Exact
descriptor pairing, rather than key surgery, is what keeps values and
controllers aligned with topology.

##### Exhaustive persisted-state enumeration

L6 adds a pure schema-guided stored-state walker used by the lifecycle
planner. It must not call `elaborateInterface` to discover state:
`DynamicCombo` elaborates only its selected branch
(`elaborate.ts:902-988`), wire-15 DynamicSlot elaborates only active
dependents (`elaborate.ts:993-1061`), and ordinary output-family state is not
input evidence. The existing recursive format validator proves only JSON
shape (`format/validate.ts:200-236`), not schema ownership.

The walker has two phases.

1. Inventory actual persisted evidence without interpretation:
   `Object.keys(values)`, `Object.keys(controllers)`, every top-level dynamic
   construct and every recursively nested `memberState` entry, every incident
   parent link/net occurrence endpoint on both input and output sides, and
   every enclosing boundary binding that names the occurrence. Preserve array
   order and the existing wire-15 evidence-channel order. Factor the current
   wire-15 member-evidence collector out of `elaborate.ts` and use it from both
   active elaboration and this walker: explicit `members`, then stored value
   keys, then structural input-port evidence, then dynamic construct keys,
   each channel in its existing document/graph order. Controller-only state
   does not create a member that compile would not see; it must match a member
   established by another channel or refuse.
2. Walk the snapshot-verified derived occurrence schema in declaration order and
   match that inventory. Static inputs emit one input descriptor. Autogrow
   emits only persisted/evidence-backed members, never minimum/ghost members,
   and recurses through every member. DynamicCombo emits its selector and
   recurses through every declared option, using `comboBranchValuePath`,
   regardless of the active selection. DynamicSlot records the slot, shared
   dependents, and every declared variant path; direct slot forwarding still
   produces the named refusal. Output autogrow constructs run through the same
   family-scope matcher even though they have no values/controllers. Route
   paths come from schema items and `resolveBoundaryRoute`; arbitrary key
   splitting is prohibited.

Every actual inventory item must match exactly one schema-owned descriptor and
one boundary route. Zero matches means stale/missing mapping and more than one
means address collision/ambiguity; both refuse
`subgraph.flatten.stateUnresolved`. A `memberState` key absent from its
family's `members` is an orphan and refuses even if values happen to mention
it. Unknown selected combo keys, invalid names suffixes, over-cap scopes,
budget exhaustion, duplicate generated before/after addresses, and a
controller on an input without a controller slot likewise refuse. State under
a valid inactive combo option or slot variant is matched and translated; it
is never dropped for inactivity. An occurrence value/controller on a plain
unpromoted boundary remains the normative
`subgraph.flatten.dormantStateUnsupported` case.

This exact-coverage rule is how inactive-branch values, output-family dynamic
state, and family scopes reached through combo hops are retained. Active
elaboration may still be used after inventory as a parity oracle in tests, but
never as the inventory source or the coverage proof.

Promoted plain widgets use one separate effective-state operation after exact
enumeration. Value and controller channels resolve independently:

```text
value:
  own property on occurrence.values (including explicit null)
  else own property on primary definition target values (including null)
  else effectiveWidgetDefault(primary widget)

controller:
  own property on occurrence.controllers
  else own property on primary definition target controllers
  else primary widget controllerInitial
  else 'randomize' when the primary widget declares a controller
  else absent
```

Each test and implementation check uses `Object.hasOwn`; truthiness, `??`, and
`value !== undefined` are forbidden for ownership. The resolved channels are
written onto the cloned primary and every eligible `alsoBinds` input even when
externally driven. Before writing, delete each target's independent prior key;
if the authoritative result is absent, all targets remain absent. Thus a
fan-out cannot retain divergent secondary fallbacks. Dynamic-family values
and controllers instead map one persisted input at a time through the shared
family map; newly materialized suffix members have no definition fallback.

An explicit occurrence DynamicCombo selection replaces the target construct's
selection at the exact resolved member/option scope. Absence inherits target
definition state; an unknown explicit selection refuses. Branch-local values
remain definition-owned unless the exhaustive walker finds a separately
forwarded concrete input or a whole-family occurrence-owned path.

##### Enclosing family slot-selection composition

`SelectionTree` is `Map<string, SelectionTree | 'all'>`; `'all'` is whole
subtree and a nested map is a narrowed autogrow selection
(`slot-selection.ts:21-97`). L6 factors the private template-order validator
from `derive-boundary.ts:489-529` into a shared pure helper and adds
template-order projection, intersection, and serialization. Lexically sorting
raw strings is not the flatten algorithm.

For each enclosing current-definition binding whose `node` is the occurrence,
the planner does exactly this:

1. Call `matchBoundaryItem` with its complete `{port, members}` address.
   Require exactly one child item. Resolve the descendant address through that
   child's snapshot-verified family route and `PersistedFamilyMap`; do not use the
   first dotted segment. This identifies the complete target route, including
   template slot ids, wire-15 suffix segments, ordinary member ids, and the
   descendant family construct if `kind: 'family'` must survive.
2. Materialize every family suffix member crossed by that route, outermost to
   innermost. Translate the full port/member path through the resulting scope
   maps. Missing source members, target ancestors, scope maps, or final inputs
   refuse; partial translation is never serialized.
3. Project the child binding's `slots` selection down to the targeted
   descendant family's template coordinate system. If child `slots` is absent,
   the projection is whole at the root. Otherwise parse it, walk the exact
   schema-derived template path to the descendant, and: an inherited `'all'`
   yields whole at the target; a missing segment yields empty; a nested map at
   the target yields that map. Validate each narrowed segment against an
   autogrow template. Do not treat absence as whole before the target has been
   uniquely identified.
4. Parse the enclosing binding's own `slots` relative to that target; absence
   means whole only there. Intersect the two target-coordinate selections. For
   each template slot in declaration order: missing on either side omits it;
   `all/all` yields `all`; `all/map` or `map/all` yields the map; `map/map`
   recurses and omits an empty child. An empty result refuses.
5. Serialize an explicit result by pre-order traversal of the target template,
   preserving canonical template order at every depth. If a projected
   explicit selection is whole at the target, serialize all current top-level
   target template slots as `'all'` entries in declaration order; there is no
   persisted root-`'all'` marker. Omit `slots` only when both original
   applicable `slots` properties were absent and the result is whole at the
   target. If either input was explicit, an explicit-full result stays
   explicit, because absence and a pinned full listing have different schema-
   evolution semantics.
6. Emit one `FlattenEnclosingBindingRewrite`. A family target remains
   `kind: 'family'` with translated ancestor members and composed `slots`; a
   concrete descendant becomes `kind: 'port'`. A primary replacement splices
   child primary then child `alsoBinds` before the old outer additions. An
   additional replacement splices all child targets at that exact index.
   Output items still require one unique producer.

Refuse `subgraph.flatten.stateUnresolved` for empty projection/intersection,
ambiguous item/address selection, an unmapped suffix, or a destination address
collision. Refuse `subgraph.lifecycle.boundaryUnresolved` when the uniquely
resolved result cannot be represented by `BoundaryBinding` (for example, a
family result would require output fan-out). Refuse the existing specialized-
slot code for any direct slot/variant hop. Never broaden either selection to
make the result representable.

##### Late-refusal allocator atomicity

All schema planning, program authentication, source/freshness checks, stored-
state exhaustion checks, and family allocations happen before parent entity
allocation. Parent graph ids still mint during command execution so shared
replay uses `tx.actor`, but `graphAllocator.mint` advances only a local cursor
until `commit()` (`commands/alloc.ts:60-84`). Group ids are likewise staged as
numbers, not written.

After minting, the command builds complete local `nodes`, `links`, `nets`,
`reroutes`, structural records, enclosing boundary, view, and cursor-bearing
staged graph objects. Endpoint-map exhaustion, enclosing rewrite exhaustion,
NUL checks, duplicate deliveries/sinks, tap cycles, one-driver checks,
prospective DAG checks, shape checks, and full `checkDocument(staged)` all run
against those local objects. Every error return is before the first `tx.set`
and before allocator `commit()`. The success tail contains only the already-
validated `tx.set` calls and one final allocator commit; there is no fallible
branch after the first write. Transaction rollback remains a second line of
defense, not the atomicity mechanism.

Proofs snapshot canonical document bytes, solo `nextOrdinal`, actor cursors,
and group sequence before each forced late refusal and require exact equality
afterwards. Include at least a missing endpoint-map entry, empty slot
intersection, repeated net sink, generated key collision, final NUL failure,
staged invariant failure, and exhausted parent graph/group allocation.

##### Final persisted-NUL assertion

Compile's `FamilyCrossing.rebase` deliberately creates `"\u0000"`-prefixed
derived member ids (`compile/crossing.ts:69-70`). No compile crossing object or
rebased id may appear in `statePlan`. Immediately before commit, assert no NUL
in exactly these identities produced or translated by L6:

- every member string in changed `DynamicPortState.members` and every key of
  every changed `memberState`, recursively;
- every consumed source member, every `FlattenFamilyMemberMap.before/after`,
  and every member in a source/target scope ancestor; this covers translated
  state with no endpoint of its own;
- every element of `PortRef.members` and `BoundaryBinding.members` emitted by
  `addresses` or `enclosingRewrites`, and the corresponding staged parent
  links, nets, and boundary bindings; and
- every destination key inserted, deleted, or otherwise generated for cloned
  `values` and `controllers`.

Allocated `m<N>` and preserved names are checked before path composition, so a
wire-15 port containing an allocated suffix is safe by construction. The final
scan does not inspect schema-authored node/port/construct ids, unrelated
preexisting body state, titles, `ext`, or any JSON value payload, including
user strings. This is the bounded assertion at lines 694-697 above, not a
document-wide string ban.

##### Landing split and proof obligations

L6 lands as three truthfully bounded slices. Every temporary remainder gate is
checked before allocation and is removed only by the slice named below.

**L6a - checksum-bound program, stored inventory, promoted/plain and combo
state.** Implement the v2 digest and ready/refused union, exact source and
coverage validation, plan-evidence fingerprinting, registry guard update,
schema-guided exhaustive walker, independent promoted value/controller
fallback, and direct DynamicCombo selection. Keep all family/member routes on
the temporary family remainder gate, native state on its existing code, and
direct specialized slots on their existing code. Proofs: every digest
component tamper; unknown refusal code; refusal attempted before stale/source
checks; authored alias registry drift; shared replay from immutable snapshot;
explicit null versus absent value; independent value/controller ownership;
primary plus `alsoBinds`; driven dormant fallback; inactive combo branch
inventory; stale/ambiguous/unpromoted keys; no compile behavior change from
factoring wire-15 evidence order.

**L6b - recursive persisted family map and all non-enclosing consumers.** Add
the recursive per-scope allocator/map, full stored-state mapping, post-node
snapshots, and address-map application for parent links, net sources/sinks,
dynamic state, values, and controllers on input and output families. Keep a
family/member enclosing-boundary target, or any required child/enclosing slot
composition, on the temporary family remainder gate until L6c; ordinary L5
enclosing rewrites continue. Proofs: two-plus nested ordinary and wire-15
scopes; mixed encodings; independent seq floors; highest `members` and orphan
`memberState` suffixes; names vocabulary/collision at every depth; native,
cap, ordinal, item, member, and depth exhaustion; target ancestor missing;
inactive options/variants; output-only family state; combo-hop family state;
deep value/controller keys via `valueKeyOf`; identical map use by parent link,
net source, net sink, dynamic, value, and controller consumers; full NUL scope.

**L6c - enclosing route/selection composition and final atomic integration.**
Implement descendant route matching, every-crossed-suffix materialization,
target-coordinate slot projection/intersection/template-order serialization,
exact primary/additional splice semantics, and remove the temporary enclosing-
family gate. Re-audit all late returns so no refusal follows a transaction
write, then run compile-before/flatten-after equivalence and shared replay over
the combined program. Proofs: child/enclosing absent, explicit-full, narrowed,
and disjoint selections; nested descendant family; dotted boundary id
ambiguity; mixed ordinary/wire-15 member path; primary and additional
replacement order; unique output; empty/ambiguous/unrepresentable refusals;
whitelisted `subgraph.lifecycle.boundaryUnresolved` transport;
all late-refusal byte/cursor snapshots; one shared replay exercising family,
controller, combo, links, nets, and enclosing binding together. The direct
specialized-slot and native free-suffix refusals remain normative after L6c.

Slice-100 salvage is deliberately narrow:

- L6a may reuse the ideas and tests for digest coverage, a serialized state
  snapshot, a closed refusal whitelist, `Object.hasOwn` channel independence,
  and promoted compile-equivalence. Its active-elaboration state inventory,
  optional/loosely shaped plan, refusal timing, and partial source validation
  must be rewritten.
- L6b may reuse `resolveBoundaryRoute`, the prefix floor formula, names-family
  preservation, NUL-free serialized-map intent, and the one-level endpoint
  tests as seed fixtures. `materializePersistedFamilyCrossing`, its one-suffix
  `memberPaths`, wholesale nested `rewriteScope`, and all active-input-based
  value/controller mapping must be rewritten around per-scope maps and the
  exhaustive walker.
- L6c has no production algorithm to salvage from the WIP. Its flat enclosing
  rewrite and string-prefix slot check do not implement projection,
  intersection, every-crossed-suffix allocation, or template-order output.
  Only existing baseline helpers such as `matchBoundaryItem`,
  `parseSelection`, and the L5 splice tests remain useful.

The seven slice-100 Oracle findings are discharged as follows:

| Finding | Owning slice and discharge |
| --- | --- |
| 1. State-plan authentication/refusal order | L6a: v2 digest covers snapshot + boundary + state; closed union; freshness and exact source precede refusal. |
| 2. One-level recursive family materialization | L6b: independent pre-order per-scope maps, allocation/vocabulary/bounds/ancestor proofs, and full before/after input/address mapping. |
| 3. Topology and enclosing slot composition | L6c: full descendant crossing, crossed-suffix materialization, target projection/intersection, canonical template order, and loud empty/ambiguous/unrepresentable refusal. |
| 4. Active-only state enumeration | L6b, built on L6a's walker: exact stored-state coverage proves inactive branches, output families, combo hops, orphan/collision/missing-map/exhaustion behavior. |
| 5. Fallback channel/null handling | L6a: independent `Object.hasOwn` value/controller chains; explicit null is authoritative; primary fallback replaces all fan-out fallbacks. |
| 6. Deep values/controllers/topology, caps, NUL, selection, replay, atomicity | L6b owns deep map/caps/full NUL and L6c owns enclosing selection, combined replay, and late-refusal byte atomicity. Each proof list above is a landing gate. |
| 7. Truthful staged delivery | L6a-L6c: named pre-allocation remainder gates, with only the owning later slice removing each gate. |

##### Slice 101 review record

1. **Round 1 - CHANGE REQUESTED, three blocker/high findings.** The reviewer
   found that the slot-composition section required
   `subgraph.lifecycle.boundaryUnresolved` but the closed planner-refusal union
   omitted it; that member-ordinal and scope-budget exhaustion did not each
   name their code; and that prose suggesting an optional rollout plan
   contradicted the required v2 shape/digest. Disposition: added
   `boundaryUnresolved` to the union and L6c proof, assigned
   `idExhausted` only to `MAX_MEMBER_ORDINAL` and `stateUnresolved` to local
   cap/depth/budget exhaustion, and made `statePlan` unconditionally required
   from L6a. The reviewer reported no other blocker/high issue in normative
   preservation, freshness, enumeration, slot composition, atomicity,
   staging, WIP disposition, promises status, or repository gates.
2. **Round 2 - APPROVED.** The reviewer verified all three round-1
   dispositions and the additional per-scope policy, source/target orphan,
   explicit-full selection, and translated-source NUL clarifications. No
   blocker or high finding remained or was introduced. The only optional note
   was that the pre-existing refusal-table summary describes graph/group id
   exhaustion more narrowly than this plan's explicit member-ordinal case;
   the implementation contract is unambiguous, so the normative table was not
   edited in this design-only internal amendment.

##### L6 combined audit record (2026-07-30, Batch 22 slice 105)

**Verdict: approved with two deferred architecture findings.** The audit
reviewed `a3cb565..dee4697` as one change rather than three landing slices.
It found and fixed two small defects: inventoried inactive dynamic state could
be silently dropped, and the final persisted-NUL check inspected unrelated
preexisting body identities. Dynamic state is now kind-checked and has closed
consumer coverage; NUL checks compare changed state and exempt only exact
source identities on freshly cloned body links/nets. The audit also removed
the obsolete `subgraph.flatten.familyUnsupported` current-contract references.

The standing answers are:

1. **Schema-blind execution: no.** Execution does not consult the live
   registry, but `flattenRoutePlanFromJson` classifies through the immutable
   schema snapshot and `verifyFlattenStatePlan` reruns schema-aware planning.
   This needs a separate trusted-dispatch/executor-boundary slice.
2. **Digest coverage: yes.** The v2 projection contains the complete authored
   schema snapshot, `boundaryPlan`, and `statePlan`; `enclosingRewrites` is
   inside `statePlan`. The named mutation matrix changes the digest for every
   top-level plan field.
3. **Atomicity: yes by combined control-flow review and executed snapshots.**
   Every refusal remains before the first `tx.set` and allocator `commit`.
   The L6b-family-allocation/L6c-selection-refusal fixture pins document bytes,
   solo/actor cursors, and group sequence.
4. **Walker/map/composition seam: fixed for silent drop.** Every nonempty
   inventoried dynamic record is consumed or refused, and dynamic records with
   fields invalid for their declared construct kind refuse rather than lose
   fields.

The executed proof matrix is:

| Finding or proof obligation | Executed proof |
| --- | --- |
| Slice-100 finding 1: digest, closed refusal union, freshness/source/refusal order, alias drift | `checksums every top-level v2 plan field and rejects refusal codes outside the closed union`; `checks freshness and exact source before honoring a planner-carried refusal`; `keys schema plans by authored aliases and exposes the initial-dispatch registry digest guard` |
| Finding 2: recursive per-scope maps, mixed identity encodings, independent allocation floors, names policy, ancestor routing | `materializes recursive family scopes independently and preserves the compiled prompt`; `flattens a realistic nested-subgraph workflow with three family scopes and exact compile equivalence`; `preserves wire-15 names suffixes and refuses stale names and ordinal exhaustion`; `materializes a concrete port beneath ancestor family members` |
| Finding 3: topology consumers and enclosing selection/composition | `materializes prefix-family members in occurrence order and rewrites member endpoints`; `fans out enclosing descendant family inputs in primary-additional order and preserves the compiled prompt`; `re-executes an input-fan-out family/controller/combo flatten after an unrelated foreign op and drops it after an incident foreign op` |
| Finding 4: inactive/output/combo-hop inventory, orphan/collision/no-drop behavior | `walks inactive combo branches, combo-hop output families, and refuses orphan or colliding family state`; `refuses inventoried inactive combo descendant state instead of silently dropping it`; `materializes an explicit DynamicCombo selection into the planned clone state` |
| Finding 5: independent value/controller fallback, explicit null, fan-out, driven dormant state | `resolves promoted value and controller ownership independently with explicit null authoritative`; `materializes one effective promoted value and controller onto primary and alsoBinds targets`; `clones every body construct, expands plain routes, retains nesting and definition, and places exact view state` |
| Finding 6: deep state/topology, NUL scope, selection, replay, and atomicity | `flattens a realistic nested-subgraph workflow with three family scopes and exact compile equivalence`; `materializes prefix-family members in occurrence order and rewrites member endpoints`; `composes enclosing descendant family selections in canonical template order and preserves the compiled prompt`; `refuses post-allocation duplicate drivers and repeated net sinks without changing bytes or allocator cursors`; all `refuses $name atomically as $code` cases |
| Finding 7: truthful staged delivery and removed remainder gate | `plans family roots, combo descendants, and slot descendants as L6-owned routes`; `checksums every top-level v2 plan field and rejects refusal codes outside the closed union` |
| L6a shared replay and immutable snapshot | `re-executes an input-fan-out family/controller/combo flatten after an unrelated foreign op and drops it after an incident foreign op` |
| L6b all seven consumers and three-plus nested scopes | `materializes prefix-family members in occurrence order and rewrites member endpoints`; `flattens a realistic nested-subgraph workflow with three family scopes and exact compile equivalence` |
| L6c absent/full/narrow/disjoint selection, mixed path, splice order, unique output | `fans out enclosing descendant family inputs in primary-additional order and preserves the compiled prompt`; `keeps enclosing output unique-producer refusal named and byte-cursor atomic`; `preserves wire-15 names suffixes and refuses stale names and ordinal exhaustion`; `clones every body construct, expands plain routes, retains nesting and definition, and places exact view state` |
| Deferred finding (b): enclosing family input fan-out splice | Implemented in Batch 22 slice 107. `derives whole-family input fan-out from the authoritative primary target`; `fans out enclosing descendant family inputs in primary-additional order and preserves the compiled prompt`; `checksums every top-level v2 plan field and rejects refusal codes outside the closed union`; `keeps enclosing output unique-producer refusal named and byte-cursor atomic`; `re-executes an input-fan-out family/controller/combo flatten after an unrelated foreign op and drops it after an incident foreign op` |
| Full-pipeline NUL source refusal and unrelated preexisting identity preservation | `flattens a realistic nested-subgraph workflow with three family scopes and exact compile equivalence`; `materializes prefix-family members in occurrence order and rewrites member endpoints` |

Three proof limitations remain explicit rather than overstated: the design's
complete cap/depth/item/member/target-ancestor exhaustion matrix is not all
pinned through the lifecycle command; the NUL matrix does not force every
post-mint translated link/net/enclosing branch; and compile equivalence compares
the exact materialized state plus the complete sole prompt node inputs, not
every artifact metadata field. These are a bounded test-completion follow-up,
not evidence of a known execution defect.

Deferred finding (b) is implemented in Batch 22 slice 107: whole-family input
fan-out is shape-validated and compiled through every declared crossing, the
flatten planner composes one digest-bound enclosing rewrite in exact
primary/additional order, and output uniqueness remains unchanged. The named
proofs are recorded in the matrix above. Finding (a), restoring the promised
zero-schema-resolver executor boundary while retaining a trusted initial-
dispatch guard, is closed by the 2026-07-30 trusted flatten dispatch record
below. Four Oracle rounds for the original combined
audit ended in APPROVED after the closed dynamic coverage, kind validation,
and source-provenance NUL fixes; no additional blocker or high-confidence
defect remained.

### L7 - App/canvas lifecycle UX and region handoff

- Selection toolbox/context/search actions, naming prompt, preview/refusal
  display, post-success selection, and keyboard path.
- Browser tests for create, mixed extract, flatten, undo/redo, nested drill-in,
  and region-flatten refusal.
- Flip the promise to implemented only when named proof exists; Regions R2 may
  then consume the lifecycle API.

## Deferred items and revival triggers

| Deferred item | Revival trigger |
| --- | --- |
| Boundary outputs bound directly to inner value sources, selectors, or reroutes | A stamped public type contract for trace-derived producers in `boundary-forwarding-design.md` is approved and implemented. Exact widget-tap outputs already use their declared widget input type. |
| Flatten muted/bypassed occurrence shells | The wire-15 structural-interface routing design ships and a separate proof defines distribution of occurrence boundary routing into ordinary body topology. |
| Flatten region occurrences | Product requests a semantics-preserving desugaring for map/fold/while and specifies iteration/result materialization; otherwise refusal remains permanent. |
| Extension id remappers for namespaced `ext` | A real extension persists core entity ids inside `ext` and requests lifecycle support; define one registry used by clipboard, extract, and flatten together. |
| Extract inferred whole families instead of concrete member cuts | A user asks for future occurrence-local family growth as part of extraction; offer it as an explicit preview option because it changes ownership semantics. |
| Flatten all nested levels in one gesture | Repeated one-level flatten is measurably painful; design one atomic recursive command with cycle, id-budget, and partial-refusal UX. |
| Preserve occurrence shell styling/title on flatten | Product defines a target (for example, a generated group carrying title/color) that does not misrepresent semantic node title ownership. |

## Open product questions and chosen defaults

These defaults make implementation unambiguous but remain user-vetoable.

## 2026-07-30 trusted flatten dispatch

Deferred finding (a), schema authority at the command boundary, is closed.
An initial `subgraph.flatten` dispatch receives a nonserializable execution
context and verifies the snapshot-derived route and state programs, checksum,
freshness, and the snapshot against a resolver built for the current document.
Missing authority fails closed with
`subgraph.flatten.schemaAuthorityUnavailable`; registry drift fails with
`subgraph.flatten.schemaPlanStale`. Authored aliases that resolve to the same
canonical schema remain valid. The command invocation wire shape is unchanged.

Shared-session rebase uses a distinct `shared-replay` context. Replay verifies
the complete immutable snapshot, route coverage and reclassification, state
program, checksum, and freshness, but never consults a live registry. The
mutation executor is schema-blind and retains only structural, geometry,
identity, staged-topology, and atomic-write checks. The digest is an integrity,
checksum, and freshness mechanism, not authorization.

Before a shared invocation enters the pending queue, the actor-stamped
invocation is JSON-validated, deeply copied, and frozen. Rebase therefore
reexecutes the exact bytes that passed the initial authority check even if the
caller's objects are later mutated.

1. **Do same-producer in-cuts share one boundary input?** Chosen: yes for plain
   links, using existing `alsoBinds`. Coordinator pin 2026-07-29: a consumer
   link with nonempty semantic `ext` is exempt and receives its own input,
   because `BoundaryBinding`/`alsoBinds` has no per-consumer extension field
   and grouping would silently discard semantics. Mixed producers partition
   into one plain group plus one group per ext-bearing link. Opaque extension
   payloads are never compared for re-grouping. This retains compact fan-out
   UX wherever it is lossless. A later split command can separate plain items.
2. **Does selecting a group imply its contents?** Chosen: yes, snapshotted at
   gesture time. Because clipboard/delete use different selection precedent,
   the extraction preview and action copy must explicitly state that the
   group's current contents will be extracted. Selecting all contents without
   the group does not move the group. USER APPROVED 2026-07-29 ("the spatial
   contents default seems fine") - no longer an open call; L4/L7 implement as
   specified.
3. **What happens to definitions after their last occurrence disappears?**
   Chosen: keep them until explicit deletion; no save-time GC in v1.
4. **Should extraction auto-forward a whole dynamic family?** Chosen: no.
   Concrete crossing members become concrete port items; family ownership
   changes only by explicit boundary authoring.
5. **Should unsupported value-source/selector/reroute output cuts partially
   extract and leave a node behind?** Chosen: no. Refuse the whole operation
   with anchors so the selection and result never diverge silently.
6. **Should flatten transfer a shell title/color to a generated group?**
   Chosen: no. Body layout survives, while shell-only presentation is disclosed
   and removed.
7. **Should occurrence-owned extension data be discarded on flatten?** Chosen:
   no. Refuse unless empty until extensions can register remappers.
