# Loop / repetition regions design (map, fold, while)

Status: APPROVED by the user 2026-07-29, including all four defaulted open
questions at the bottom (contract on the occurrence, fresh definition per
region, no implicit while continuation, no default maxIterations for
map/fold). Defaults may be revisited later if real usage argues otherwise.
R1-R4 and per-iteration retained-value inspection are implemented.

Regions are the backend's only repetition construct: ordinary cycles are
rejected, and mapping is never implicit (Dinkster DESIGN.md 3.13). The backend
model, validation, wire shape, and runtime are fully implemented and tested
(`packages/dinkster-graph/src/dinkster_graph/model.py`, `validate.py`, `wire.py`,
`tests/test_regions.py`). The frontend already validates and encodes the
region wire shape in `packages/core/src/compile/dinkster-graph.ts` but has no
document model, authoring surface, lowering, or rendering. This document
closes that gap.

## Grounded backend facts

All verified against the backend source 2026-07-29.

1. One primitive, three validation profiles. `RegionNode { kind, body,
   ports, inputs, element_ports, state_ports, outputs, binding,
   max_iterations, continue_source }`. Map: >=1 element ports, no state
   ports. Fold: >=1 element, >=1 state. While: no element ports, >=1 state
   ports, mandatory `continue_source` (boolean body output) and mandatory
   `max_iterations`; cross and broadcast bindings rejected (model.py:70-131,
   validate.py:763-792).
2. Ports are the body-side interface. An element port declared `T` expects
   `list<T>` from the outer graph and binds one element per iteration.
   State ports take their initial value from `inputs` and chain through the
   same-id state-mode output. Every other declared port broadcasts
   unchanged into every iteration (model.py:106-116).
3. Outputs: `gather` collects a body output across iterations into
   `list<T>` (empty list for zero iterations; source type must be
   runtime-resolvable or `gather-nonconcrete` rejects); `flatten` concatenates
   a list-typed body output in iteration order and preserves its `list<T>`
   type (typed empty list for zero iterations; `flatten-non-list` and
   `flatten-nonconcrete` reject invalid sources); `state` exports the final
   chained value and its key MUST be a declared state port. Flatten is legal
   for map, fold, and while and does not participate in the state chain
   (validate.py:719-900).
4. Binding: `zip` (equal-length element lists, loud runtime error on
   mismatch), `cross` (cartesian product, last element port varying
   fastest), or `broadcast` (iterate to the longest element list and repeat
   each shorter list's final element). For broadcast, all element lists empty
   means zero iterations; a mix of empty and non-empty lists fails loudly
   because an empty list has no final element. Lengths are runtime data;
   document validation checks only the vocabulary (engine.py:1262-1291).
5. Body links read region ports via the reserved producer id `$region`
   (`Link("$region", portId)`); `$region` is banned as a real node id.
   Bodies are their own graph scope: cycles are checked per scope and links
   cannot cross a region boundary (model.py:56-58, validate.py:644-684).
6. Wire JSON: a graph node entry `{"region": {kind, ports, inputs, body,
   outputs, elementPorts, statePorts, binding, maxIterations,
   continueSource}}` inside the ordinary `graph.nodes` map POSTed to
   /api/jobs; body is a recursive `{nodes: {...}}`; links spell
   `{"$link": {node, output}}` (wire.py:191-265). Regions do NOT appear in
   /api/nodes or the wire-15 schema surface.
7. Runtime identity: iteration node ids are namespaced `region[3]/node`,
   nested as `outer[0]/inner[2]/node`; node ids ban `/ [ ]` so paths parse
   mechanically. Events: `region_expanded` (kind, binding, iterations -
   null for while) and `region_finished` (iterations), plus ordinary node
   lifecycle events under iteration paths. GET /api/values accepts
   iteration paths (engine.py:1299-1337, events.py, app.py:1875-1887).
8. Region port TypeExprs may be variables, but the region is not a solving
   boundary: variables resolve per invocation at the worker boundary, and
   gather and flatten require statically runtime-resolvable source types
   (solve.py:1-10, validate.py:828-882).

## Grounded frontend facts

1. Subgraphs: a `GraphDef` map keyed off `WorkflowDocument.graphs`; an
   occurrence is an ordinary node whose type is `#<defId>`. The definition
   boundary (`GraphDef.boundary.inputs/outputs`, `BoundaryItem`,
   `BoundaryBinding`) declares the interface and binds to inner node
   ports; `deriveBoundarySchema` projects it as the occurrence's external
   `NodeSchema` (document.ts:246-353, derive-boundary.ts).
2. Drill-in keeps a definition `graphStack` plus an occurrence
   `instancePath`; boundary panels render as derived pseudo-nodes
   (app-state.ts:390-520, scene.ts:1038-1101).
3. Compile flattens active subgraph occurrences into a flat prompt keyed by
   runtime ids; `promptToDinksterGraph` re-encodes for the native wire.
   `dinkster-graph.ts` already validates region entries structurally
   (compile.ts:1034-1185, dinkster-connection.ts:76-142).
4. Execution: `r[3]/node` runtime paths are already parsed and aggregated
   onto the visible occurrence node (occurrences.ts:47-106,
   events/dinkster.ts:486-525). There is no per-iteration surface.
5. Groups are pure view state with spatial membership - not a semantic
   container. Boundary panels are the only existing boundary visual.

## Product decisions

### 1. A region is a subgraph occurrence with an iteration contract

The document model reuses the entire subgraph mechanism. A region is an
ordinary `#<defId>` occurrence node whose `NodeData` gains one optional
persisted block:

```
region?: {
  kind: 'map' | 'fold' | 'while'
  elementPorts?: readonly string[]   // boundary INPUT item ids
  statePorts?: readonly string[]     // boundary INPUT item ids
  outputRoles?: Record<string, 'gather' | 'compact' | 'state' | 'flatten'>  // boundary OUTPUT ids
  continueOutput?: string            // boundary OUTPUT id (while)
  binding?: 'zip' | 'cross' | 'broadcast'  // default zip
  maxIterations?: number             // required for while
}
```

Rationale: the backend puts the contract on the region node, not the body
graph; boundary item ids are exactly the region port ids; boundary OUTPUT
bindings already name the body-node output a `RegionOutput.source` needs;
and `GraphDef` stays untouched. Coordinator-revised pin 2026-07-29: format
v1 is pre-release and unstable, so the strictly validated `region` block
joins v1 in place and `FORMAT_VERSION` remains 1. The older-reader
fail-closed policy is deferred until format stabilization / first public
release, together with boundary-forwarding-design.md open question 7. The
definition itself stays an ordinary subgraph definition; kind and roles are
occurrence state.

#### R1.5 migration pin (2026-07-29, required before R2)

R1 shipped `outputModes` plus same-id `statePorts`, with a region-only
relaxation of the global boundary-id uniqueness check. That implemented
contract remains recorded and test-pinned, but is superseded before any
authoring UI consumes it. R1.5 replaces only that representation with:

```
outputRoles?: Record<VisibleBoundaryOutputId,
  | { kind: 'gather' }
  | { kind: 'flatten' }
  | { kind: 'state'; statePort: BoundaryInputId }
>
```

The record key is a distinct visible boundary output id. `statePort` names
the visible boundary input and the backend wire state key. Gather-by-omission
remains canonical. R1.5 restores the global one-namespace boundary-id
invariant by removing the region-only `seenIds` relaxation from
`derive-boundary.ts`; inputs and outputs cannot share an id.

Implemented 2026-07-29 and amended 2026-07-30 for flatten: core format, strict ingress validation, semantic
validation, region-aware schema derivation, and undoable commands now use this
R1.5 contract. Explicit `{ kind: 'gather' }` entries are accepted, while
commands canonicalize gather roles by omitting their `outputRoles` entry.
Explicit `{ kind: 'flatten' }` entries are preserved.

This migration is required by existing shared subgraph machinery, not just
R2 presentation. `buildFamilyCrossings` stores both boundary sides in one map
keyed by bare item id, compile retrieves crossings by that id, and
`instanceDynamic[item.id]` has no direction discriminator. A same-id output
can therefore overwrite its input route and occurrence-local suffix state.
Definition-only resolution also rejects the relaxed shape, so one definition
cannot safely serve both a region and the approved ordinary-subgraph reuse
case. Finally, `boundary.addItem` already allocates one namespace; Model B lets
extraction add a state relation without rekeying either cut endpoint.

Continue source is a designated boundary OUTPUT (`continueOutput`) rather
than a raw body link: it stays visible, renameable, and re-bindable through
the existing boundary commands, and compile lowers its binding to the
backend's body-link form. It is excluded from the occurrence's external
sockets (it is consumed by the region itself), as are state-mode outputs'
duplicates - see decision 3.

### 2. External interface derivation

`deriveBoundarySchema` gains region awareness (occurrence-parameterized,
like selector choices already are):

- element port declared `T` -> external input `list<T>`;
- state port -> external input `T` (the initial value);
- broadcast port (neither role) -> external input `T` unchanged;
- gather output bound to `T` -> external output `list<T>`;
- flatten output bound to `list<T>` -> external output `list<T>` unchanged;
- state output -> external output `T` (final value);
- `continueOutput` -> no external socket.

R1.5 changes the state-output projection, not the backend wire rule. A state
role's external output keeps its distinct visible boundary output id, but its
carried type is looked up through `role.statePort`; the bound body source must
be compatible with that state-input type. Lowering aliases the visible output
id to the backend's same-key state-port output. Continuation remains hidden,
and outputs absent from `outputRoles` remain gather outputs.

Widget promotion, remote COMBO, controllers, and dynamic forwarding keep
their existing boundary semantics on broadcast and state ports. Promoted
widgets on ELEMENT ports are rejected by validation in v1 (an element port
needs a whole list; a scalar widget editor would lie about it) - the
deferral trigger is a real request for per-element literal list editing.

### 3. Authoring UX

- Palette/search gains three entries under a "Regions" section: Map
  region, Fold region, While region. Committing dispatches one atomic
  `batch`: `subgraph.import` of a fresh definition plus `node.add` with the
  `#defId` type and the matching `region` block. Coordinator-revised
  2026-07-29: the original empty-body template was structurally impossible
  because every boundary item requires a binding to a real body node. R2
  decides the exact valid template at launch per the decision point below.
  Fresh-definition-per-
  region: v1 has no UI for pointing an existing definition at a region
  contract or sharing a body between regions, though the model permits it.
- Role editing lives on the drilled-in boundary panels: each Inputs-panel
  row shows a role tag (element / state / broadcast) cycling through a new
  `region.setPortRole` command; each Outputs-panel row shows gather /
  flatten / state / continue. Role edits are occurrence-scoped (they live in the
  occurrence's `region` block); when a definition has multiple region
  occurrences the drilled-in `instancePath` identifies which occurrence's
  roles are being edited, mirroring occurrence-local selector choices.
- `binding` and `maxIterations` render as
  synthetic config rows on the region occurrence node, edited like widget
  values through `region.setBinding` / `region.setMaxIterations`.
- Wrap-selection-in-region and extract-to-subgraph do not exist and stay
  out of v1 (they are one feature; ledgered follow-up).

Lifecycle supersession note (2026-07-29): the preceding bullet records the R1
delivery boundary. Generic extract-to-subgraph now ships through lifecycle
L1-L7 before R2. Only the dedicated atomic `region.wrapSelection` authoring
gesture remains deferred; it reuses the lifecycle's pure extract transform
and applies R1.5 input roles, distinct-output `outputRoles` state mappings,
and separate `continueOutput` in the same undo unit.

R1 command vocabulary (all payloads are plain JSON and go through
`DocumentSession.dispatch`):

- `region.setPortRole {graphId, nodeId, side, portId, role}` where input
  roles are `element | state | broadcast` and output roles are
  `gather | flatten | state | continue`. Pair state input/output edits in one `batch`.
- `region.setBinding {graphId, nodeId, binding: 'zip' | 'cross' | 'broadcast'}`. Setting
  `zip` removes the optional field and restores its canonical default.
- `region.setMaxIterations {graphId, nodeId, maxIterations}` where the value
  is a safe integer >= 1 or `null` to remove the optional map/fold limit.
- Region creation composes as one `batch` containing `subgraph.import` then
  `node.add`; the latter accepts the strict optional `region` block.

R1.5 replaces output-side `region.setPortRole` with
`region.setOutputRole {graphId, nodeId, outputId, role, statePort?}` and adds
`region.setContinueOutput {graphId, nodeId, outputId?}`. A state role requires
the selected declared state input; gather removes the optional role entry;
flatten stores an explicit role and does not accept `statePort`; continuation
is exclusive with `outputRoles`. Input-side `region.setPortRole`,
binding, max-iterations, and atomic creation commands remain unchanged.

The Boundary panel explains these occurrence-owned choices on focus and hover.
Gather preserves one result per iteration, Compact removes absent iteration
results, Flatten concatenates list results, State returns the final carried
state, and Continuation identifies the Boolean controlling another while
iteration. Canvas consumer input tooltips separately expose the effective
`on_absent` policy and whether it was declared or defaulted by required-ness.

R2 template decision point (coordinator-revised 2026-07-29): the current
`BoundaryItem` contract requires every item to bind an existing inner node.
R1 proves atomic command composition with a structurally valid imported
definition. At R2 launch choose among: (a), the preferred direction, one
minimal passthrough body node with legally bound input/output pairs (while
also needs a real boolean continuation producer); (b) zero boundary items,
with `doc.region.*` guiding the user to add required roles; or (c) a separate
model design allowing declared-but-unbound boundary ports. Option (c) is not
an incidental R2 relaxation and requires its own design pass.

### 4. Rendering: drill-in first, no inline frame in v1

The region occurrence renders as a node with a distinct identity: a loop
glyph plus kind label in the header, a doubled border, and list-typed
sockets using the existing `list<T>` edge treatment. Drill-in reuses the
subgraph path (double-click, breadcrumb) with the boundary panels showing
role tags. An inline expanded frame (body visible inside the parent canvas)
is explicitly deferred - it requires multi-scope scene composition the
canvas does not have; revival trigger: user asks for in-place editing after
using drill-in regions.

### 5. Compile lowering

R3 implements the lowering below for exact compile and would-run. Reachable
region occurrences require the backend `regions` graph feature and fail closed
with `compile.region.backendUnsupported` when it is absent. A muted region
occurrence skips the whole region. A bypassed region occurrence fails with the
anchored `compile.region.bypassUnsupported` diagnostic because list contracts
have no positional passthrough.

`collectNodes` stops flattening an occurrence that carries a `region`
block. Instead it emits one region entry:

- `ports`: boundary input types plus, for `continueOutput` and state
  chains, nothing extra (ports are inputs only, per backend model);
- `inputs`: the occurrence's stored values/links per boundary input id,
  lowered with existing delivery semantics (reroutes, selectors, value
  sources, taps resolve in the PARENT scope);
- `body`: the definition's graph compiled recursively in its own scope -
  inner subgraph occurrences flatten as today, nested regions recurse,
  boundary input bindings become `$region` links, `alsoBinds` fan-out
  included;
- `outputs`: boundary output bindings as `{source, mode}` using body-local
  ids. Gather outputs use the visible boundary output id. For a state role,
  one frozen alias map projects `visibleOutputId -> statePort`; lowering emits
  the binding source under the backend state-port key, and the same map is the
  sole authority for parent-link lowering, provenance, and value lookup.
  `continueSource` comes from the `continueOutput` binding;
- `elementPorts`, `statePorts`, `binding`, `maxIterations` copied.

Scope rules come free: document links are graph-local, so cross-boundary
links are unrepresentable. Bypass/mute of nodes INSIDE a region body lowers
within the body scope with the existing structural routing semantics. Muting
the region occurrence itself skips the whole region (backend emits
`node_skipped`); bypassing a region
occurrence is refused with an anchored diagnostic in v1 (no meaningful
positional pass-through for list-in/list-out contracts).

### 6. Validation (document-level, mirrored from backend)

New `doc.region.*` diagnostics anchored to the occurrence and port, so
problems surface while editing instead of at submit:

- `doc.region.shapeInvalid` rejects malformed occurrence contracts at load,
  command commit, and collaborative patch ingress;
- kind profile violations (map/fold/while port-role requirements,
  while+cross/broadcast, while without maxIterations or continueOutput);
- roles naming undeclared boundary items; element+state overlap;
- state port without a same-id state-mode output and vice versa;
- continue output not boolean-typed (advisory, hard at core.combo, same
  policy as backend);
- gather source not runtime-resolvable (hard before submission);
- flatten source not list-typed or not runtime-resolvable (hard before
  submission);
- plain literal on a non-runtime-resolvable region or body input (hard; an
  explicit typed literal remains valid); and
- schema selector node in any nested region body (hard). A schema input marked
  `lazy` is not a selector and remains outside this check; its separate runtime
  region limitation remains backend-owned.
- maxIterations < 1; missing required port inputs.

R1.5 replaces the same-id state-chain check with these validations:

- every `outputRoles` key names a declared boundary output;
- every state role names a declared state input;
- every state input has exactly one state-role output, and no two outputs name
  the same state input;
- no `outputRoles` key equals `continueOutput`; and
- each state output's bound body source is type-compatible with the referenced
  state input, matching backend validation.

The native graph validator reads these type and selector facts from the
occurrence-local elaborated interfaces used to emit the graph. It does not
infer producer types from literal stamps. Every refusal keeps the backend's
slash-joined wire path in diagnostic data and anchors Problems to the authored
region or nested node occurrence and port.

External list typing reuses the existing `list-into-scalar` /
`scalar-into-list` advisory vocabulary through the derived schema, so a
`T` producer wired into an element port gets the existing "wrap in a Map
region" style guidance. Body cycles are already per-scope
(`dinksterGraph.cycle`); document invariants add nothing new.

### 7. Execution feedback

v1 uses what already flows: `region_expanded` fixes the iteration count
(null for while), `region_finished` the actual count, and body-node events
arrive under `region[i]/node` paths that `occurrencesForView` already
aggregates onto the occurrence. The region node header shows aggregate
progress plus an "iteration k of n" (or "iteration k" for while) counter
derived from the highest-index running iteration. Selecting a region occurrence
opens iteration inspection in the Focused panel for its bound execution. The
inventory comes only from exact retained runtime paths and compile provenance;
lifecycle totals never synthesize body values. Users can select simple or nested
iterations, body nodes, and outputs. Each output query preserves the execution's
backend, prompt id, slash-delimited runtime path, and output id through
`/api/values`; unavailable owners and structured retention refusals stay visible.
Cached and coalesced nodes are distinguished from executed nodes. R4 normalizes
the actual backend event identifiers, keeps lifecycle state in the execution
store, and renders the counter as projection-only header feedback. Backend
validation paths such as `r/body`
fall back to the owning region occurrence through the existing Problems
ingress while retaining the backend error code.

### 8. Collaboration and undo

All new mutations are ordinary commands through `DocumentSession.dispatch`
(`region.setPortRole`, `region.setOutputRole`, `region.setContinueOutput`,
`region.setBinding`, `region.setMaxIterations`, plus the creation batch), so
shared-session ordering, rebase, and undo inherit. The `region` block rides
`NodeData` like `slot_variants` does; no new sync surface.

## Slices

- R1.5 (core rework, separate implementation owner): migrate the shipped R1
  `outputModes`/same-id contract to `outputRoles`, restore global boundary-id
  uniqueness, replace output/continue commands and validation, and update R1
  proof fixtures. R1.5 lands before R2 and R3.
- Subgraph lifecycle sequencing: lifecycle L1-L7 land before R2. R1 is already
  independent; R1.5 is the additional core prerequisite. R2 consumes the
  shared parameterized fresh-definition planner after its preserved template
  decision is settled.
- R1 (core): `region` block in the document format + JSON schema +
  invariants, `doc.region.*` validation, derived external schema, command
  set, serialization round trip. No UI.
- R2 (app/canvas): palette creation entries, region node visual identity,
  boundary-panel role tags and editing, config rows, docs.
- R3 (core/client): compile lowering to region wire entries, occurrence
  projection, submission through /api/jobs, live E2E against :8765 with a
  map and a while workflow, wire-14/15 invariance regression.
- R4 (app, implemented): execution feedback (iteration counter, aggregate
  states) and Problems anchoring for backend region refusals.
- Deferred (ledgered with triggers): atomic `region.wrapSelection`, inline
  frames, element-port widget editing, region
  occurrence bypass semantics, shared-definition region UI. Generic extraction
  belongs to lifecycle L1-L7 and is not deferred here.

## Open questions (defaults chosen; veto before R1)

1. Contract on the occurrence (chosen) vs on the definition. Occurrence
   matches the backend model and needs no GraphDef change; definition
   would make every occurrence share roles and read more like a dedicated
   "Map body" asset. Chosen: occurrence.
2. Creation always mints a fresh definition (chosen) vs a picker over
   existing definitions. Chosen: fresh; conversion UI later.
3. While regions require a wired continue output before first submit; no
   implicit "run once" default. Chosen: loud validation, no default.
4. `maxIterations` default for map/fold: none (unbounded by document,
   runtime binding count rules apply). Chosen: absent unless set.
