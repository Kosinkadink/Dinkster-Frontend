# Subgraph boundary forwarding

Boundaries expose behavior on each instance, not mutable state on a shared
definition. Full DynamicCombo branches use `kind: 'dynamicCombo'`; specialized
DynamicSlots use explicit `kind: 'slot'`. Both carry dependent inputs, widgets,
controller declarations, and nested dynamic state through chained boundaries.

## Support and refusal matrix

The six cases in [#397](https://github.com/Kosinkadink/Dinkster-Frontend/issues/397)
have the following contracts. A refusal is intentional, not silent loss of
state or a promise that the compiler can recover it.

| Case | Contract | Verification |
| --- | --- | --- |
| Specialized DynamicSlot variants | Supported with explicit full-slot exposure. A persisted plain-port boundary never silently upgrades. Use **Forward full slot** in the Boundary inspector; edit specialization and dependents on the instance or while drilled into that occurrence. | `boundary-subtrees.test.ts`; `boundary-conditional.spec.ts` exercises explicit exposure, two wrappers, sibling variants/values, drilled edits, undo, compiled `slotVariants`, and reopen. |
| DynamicCombo branch dependents | New boundaries forward the whole selected branch by default. Persisted selector-only bindings retain their meaning and show `boundary.selectorOnly` plus **Upgrade to full branch**. **Use selector only** remains an explicit authoring choice. | `boundary-subtrees.test.ts`; `boundary-conditional.spec.ts` exercises default authoring, explicit upgrade, independent values, selector editing, and reopen. |
| Structural producer outputs | Direct value-source, selector, and reroute boundary outputs are refused until they have a stamped public type. External producers may feed instance inputs. Exact static widget-tap outputs are supported. Decision: [#397](https://github.com/Kosinkadink/Dinkster-Frontend/issues/397). | `boundary-output-refusals.spec.ts` drags all three producers onto Outputs and verifies visible `boundary.structuralProducerUnsupported` without document mutation. |
| Runtime-computed arity | Output arity must be known before execution. Arity that changes during execution is refused, not guessed from a stored count. Declared/probed pre-execution schemas are distinct; see [Dinkster #1241](https://github.com/Kosinkadink/Dinkster/issues/1241) and [#397](https://github.com/Kosinkadink/Dinkster-Frontend/issues/397). | `boundary-output-refusals.spec.ts` verifies visible `boundary.countBoundOutputInvalid` and queue-time `elab.outputFamily.badCount` with no prompt submission. |
| Nested output families | Supported through chained family crossings. Sibling suffix members retain independent identities and exact terminal output indexes. | `compile-forwarding.test.ts`; six tests in `boundary-output-families.spec.ts` include two wrappers, nested members, export/reopen, compiled indexes, and literal counts. |
| Linked count | Refused with `boundary.countBoundOutputInvalid` and `elab.outputFamily.linkedCount`; an unlinked promoted literal count remains instance-local. Decision: [#397](https://github.com/Kosinkadink/Dinkster-Frontend/issues/397). | `boundary-output-families.spec.ts` verifies the visible diagnostic and compile refusal. |

### State and identity

`BoundaryCrossing` is the shared address translator. Family crossings append
and rebase suffix members. Slot/combo subtree crossings replace inherited
member lists, prefix concrete ancestor members, and preserve descendant IDs.
Values and controllers use the existing elaborated-address codec, including
member-addressed keys; no display label is an identity.

Rendering and compilation share `boundaryStateResolver`. Absent fields inherit
the closest definition value, controller mode, or dynamic state. Explicit
empty/stale state masks inheritance. These fallbacks are derived, not written
into every instance. An edit copies the needed inherited member scope onto
its occurrence; shared command replay carries a validated immutable snapshot.
Sibling instances and the definition are never mutated by occurrence edits.

Both new binding kinds are input-only, have one target, and reject `promoted`,
`alsoBinds`, and `slots`. Internal drivers, mismatched construct kinds, missing
ancestor members, and ambiguous dotted routes remain diagnostic failures.
Old format-v1 documents retain their meanings; older readers reject documents
using an unknown binding kind without a global format-version bump.

The approved design and original audit below retain the wider contracts,
including static widget promotion and structural-producer constraints. The
support matrix above describes full subtree forwarding.

The current BoundaryPanel exposes a named `region`, labels each input/output
item as a `group`, and uses native buttons and product checkboxes in document
order. Enter toggles a focused exposure checkbox (in addition to Space),
while Escape leaves the focused boundary control without changing the
document. Inline refusal notices use status semantics and derivation errors
use alert semantics.

Boundary item ids, elaborated addresses, member ids, value paths, and backend
API names are structural identity. They are never shortened or inferred from
labels. If an unlabelled boundary id is path-shaped, the canvas and derived
instance show only its final segment; an authored `displayName` still wins.
Nested family presentation also suppresses a repeated authored family stem
(`images.images_m0` displays as `images_m0`) without changing the structural
API path. A dotted static schema id that aliases a stamped dynamic route stays
fail-closed as `boundary.ambiguousBind` rather than choosing precedence.

This document audits which ordinary-node interface behaviors survive a
subgraph boundary, then specifies how specialized DynamicSlot behavior should
cross that boundary. "Boundary panel" means the Inputs/Outputs pseudo-nodes
shown while editing a definition. "Instance" means a `#definition` node in
its parent graph. Those are different surfaces: the panel edits the shared
definition interface, while the instance owns occurrence-local values and
dynamic choices.

## Grounded invariants

1. A boundary derives the same `NodeSchema` model as a backend node. See
   `docs/architecture.md` sections 3-5c and
   `packages/core/src/schema/derive-boundary.ts`.
2. Boundary bindings name real node ports, whole autogrow families, or an
   exact output-side widget tap. `kind: 'widgetTap'` stores `node/tap` and
   cannot carry members, slots, promotion, or fan-out bindings. Value sources,
   selectors, and reroutes remain unrepresentable. See
   `packages/core/src/format/document.ts` and the matching runtime/JSON-schema
   validators.
3. Boundary panels are derived view constructs, not `NodeData`. Their slot
   model carries only id, label, type, and a family marker. Inputs pins only
   produce, Outputs pins only consume, and `BOUNDARY_ADD_SLOT` is the trailing
   wildcard exposure target. See `layoutBoundaryNode` in
   `packages/canvas/src/layout.ts`.
4. Boundary authoring targets are assembled from node layout pins, so they
   exclude reroutes, selectors, and value sources. Output-side authoring keeps
   widget taps under a tap-namespaced drop key and dispatches the exact
   `node/tap` endpoint. See `innerPinTargets` and `endParams` in
   `packages/canvas/src/interaction.ts`.
5. A DynamicSlot specialization is persisted dynamic state selected by a
   connect gesture, not inferred during elaboration. Variant dependents use
   document keys such as `slot.[variant].input`, while compile emits one
   construct-local `slotVariants` choice per participating runtime node. See
   `docs/architecture.md` sections 3 and 10, `dynamicSlotHandler` in
   `packages/core/src/schema/elaborate.ts`, and the `slotVariants` assembly in
   `packages/core/src/compile/compile.ts`.

## Original behavior audit

This baseline predates full subtree forwarding. Every result below is tied to
executable code or a named test. "No" does not
mean a type is lost: it means the specialized behavior is absent even if a
plain typed pin remains. The full-branch/full-slot changes are owned by
[#397](https://github.com/Kosinkadink/Dinkster-Frontend/issues/397); use the support
matrix above for their implemented contract.

| Ordinary-node behavior | Definition boundary panel today | Parent-graph instance today | Compile/runtime today | Verification |
| --- | --- | --- | --- | --- |
| Plain static input/output | One typed row and pin. Inputs produce rightward; Outputs consume leftward. | Same derived type appears as an ordinary instance port. | Links flatten through the bound inner endpoint. | `layoutBoundaryNode`; `packages/canvas/test/scene.test.ts` tests "a definition derives Inputs...", "pin types mirror...", and binding noodles. |
| Widget-backed input, not promoted | Panel still shows only a socket row. | Derived as optional `forceInput`; no editor, default display, controller chip, or tap. | If no value is stored on the instance, the inner node's stored/default value is authoritative. Compile does not gate override lowering on `promoted`, so a stale instance value left after unpromotion still overrides the inner value even though no editor exposes it. | `deriveBoundarySchema` non-promoted branch; `packages/core/test/derive-boundary.test.ts` "non-promoted widget-backed inputs become forced sockets..."; unconditional `node.values[item.id]` promotion pass in `compile.ts`. |
| Widget-backed input, `promoted: true` | Still only a typed socket row. The panel has no widget/value/controller fields. | The complete inner `WidgetSpec` is copied, so the normal compact view, expanded editor, schema default, remote metadata, controller chip, and ordinary widget tap are all eligible to render. | A stored instance value is lowered as an override to the inner input. If the instance stores no value, no override is recorded and the inner definition value/default wins; this can differ from the schema default displayed by the unset instance widget. | Whole-object `{ widget: inner.widget }` copy in `deriveBoundarySchema`; `derive-boundary.test.ts` "promotes widgets onto the instance, controller included" and "promoted widget-backed inputs carry the WidgetSpec"; override pass in `compile.ts`. The unset fallback follows from `const v = node.values[item.id]; if (v === undefined) continue`. |
| Widget tap on a promoted instance input | No tap endpoint exists on the panel. Its right-facing Inputs pin is a synthetic boundary endpoint, not `widgetTap`. | Yes. Normal layout adds a right-side tap for a memberless widget input. | The tap resolves the instance input through `resolveInputPort`; a driven tap aliases the producer and an undriven tap bakes the effective value, including `$typed` rules. | `layoutNode` widget-tap branch; `packages/canvas/test/widget-tap.test.ts`; nested forwarding coverage in `packages/core/test/compile-forwarding.test.ts`; `tappedInputs`/`tapValue` in `compile.ts`. |
| Export an inner widget tap as a boundary output | Yes. Dragging the tap to an Outputs row or expose slot stores the exact `node/tap` identity; the panel labels it `Widget output`. | The derived instance exposes a typed ordinary output. | Compile follows the real widget driver or bakes its stored/default literal. Extraction groups every outside fan-out consumer behind one exact tap-bound output; flatten restores the tap endpoint. | `BoundaryBinding`; `packages/canvas/test/interaction.test.ts`; `packages/core/test/derive-boundary.test.ts`, `compile-forwarding.test.ts`, and `subgraph-lifecycle-planner.test.ts`. |
| External value source or selector feeds an instance input | Not represented inside the panel; the panel's job is the shared interface declaration. | Yes. Both are ordinary producer endpoints in the parent graph and can feed the instance's derived input. | `resolveInputPort` forwards the delivery to the inner target. Value-source literals bake; selectors resolve one branch before flattening. | `packages/core/test/value-source.test.ts` "bakes inside subgraph instances (per occurrence)"; selector subgraph coverage in `packages/core/test/selector.test.ts`. |
| Bind a boundary directly to an inner value source/selector/reroute | No. None is a legal `BoundaryBinding` or boundary-gesture target. | No corresponding instance output can be derived. | No route/type derivation exists. Value sources have only a consumer-derived advisory type; selectors and reroutes are type-agnostic and derive output by tracing. | `BoundaryBinding`; `innerPinTargets`; `effectiveValueSourceSpec`; structural data comments in `format/document.ts`. |
| DynamicCombo selector input | Panel shows one plain typed row, not branch dependents or live selection. Promotion/fan-out are rejected. | The derived instance preserves the selector choices but intentionally carries empty branch input lists. Its explicit valid occurrence selection can differ per instance; unset/invalid selection inherits the definition selection. | Compile already projects occurrence selection onto the inner target before elaboration via `overlaySelectorDynamic`; branch-dependent inputs remain definition-owned and are not forwarded. | DynamicCombo branch in `deriveBoundarySchema`; selector overlay in the child collection pass of `compile.ts`. This is the closest existing precedent for specialized-slot projection. |
| Autogrow/dynamic input family | Panel shows one family-marked row (`[]`), not its live members. | Yes, when the boundary uses `kind: 'family'`. The derived autogrow template is recursively freshened; each instance owns its suffix members. Template widgets and specialized slots nested in the template are already copied recursively. `promoted` is invalid because there is no shared inner stored value for occurrence suffixes. | `FamilyCrossing` already translates occurrence member addresses/state, recursively rewrites member state, projects connectivity for DynamicSlot dependents inside templates, and composes nested forwarding. The missing direct-slot feature must not reimplement this support. | `deriveBoundarySchema`; `rewriteState`/`overlayNodeDynamic` in `compile/crossing.ts`; family connectivity projection in `compile.ts`; `compile-forwarding.test.ts`. Native `role: 'inputFamily'` decodes to a one-slot autogrow template in `dinkster-wire.ts`. |
| Count-bound output family | Panel shows one family-marked output row. | Canonical members `0..count-1` project from a fixed definition count or an occurrence-local promoted count. Sibling instances can have different arities. | Crossings preserve canonical member identity and inner output indexes. `boundary.countBoundOutputInvalid` omits only an invalid fixed output; a promoted output remains available for valid instance counts. | `derive-boundary.test.ts`, `compile-forwarding.test.ts`, `occurrence-view.test.ts`, and `effective-occurrence-topology.test.ts`. |
| Plain DynamicSlot without variants | Panel shows one plain typed row. | Forwarded as optional `forceInput`; the fact that it is a DynamicSlot is flattened away. | It behaves as a plain socket. | `derive-boundary.test.ts` "still flattens a slot without variants to a forced socket". |
| Specialized DynamicSlot with variants | An attempted direct binding makes boundary derivation fail; no usable typed panel is produced. | No instance schema is produced for that definition. | Explicit `boundary.specializedSlotUnsupported`: flattening would erase variants and put one shared choice on the definition instead of one choice per occurrence. Variant dependents can be exposed individually only when the inner slot is already connected and a variant is selected in the definition. | `deriveBoundarySchema`; `derive-boundary.test.ts` "rejects directly forwarding a slot that has variants" and dependent-binding cases. |
| Shared and variant-dependent DynamicSlot inputs | A shared dependent may be bound once the definition-local slot is connected. A variant dependent additionally requires a selected valid definition variant. The panel is still a plain row. | An individually promoted dependent carries its widget, but direct-slot forwarding cannot reveal the whole shared/active-variant subtree per occurrence. Nested dynamic constructs below an individually bound dependent remain definition-shaped. | Shared dependents elaborate from connectivity alone; variant dependents elaborate from connectivity plus `state.selected`. Individual boundary bindings target one definition-selected path and cannot change shape per instance. | `dynamicSlotHandler` in `elaborate.ts`; `resolveBoundaryRoute` slot/slotVariant hops; specialized-slot derive tests. |
| `control_after_generate` controller | No panel chip or panel-owned mode. | A promoted widget renders a chip because the full `WidgetSpec` is copied and normal layout reads `node.controllers[boundaryId]`. | Advancement consumes the compiled occurrence view. Promoted and nested owners remain occurrence-local, active dynamic inputs are included, terminal delivery through a boundary suppresses linked controls, and shared unpromoted definition state advances once. For fan-out, the primary binding supplies an unset owner's fallback before `alsoBinds`, independent of graph node storage order. | `derive-boundary.test.ts` controller assertion; `layout.ts`; occurrence, dynamic-input, completion, fallback, fan-out order, and driven-delivery coverage in `packages/app/test/controller-advancement.test.ts` and `packages/e2e/tests/seed-controller.spec.ts`. |
| Remote COMBO widget | No panel editor. | Yes when promoted, because `WidgetSpec.remote` is copied with the whole spec; static options/default and remote replacement behavior use the ordinary editor. | Stored selected string lowers like any promoted value. The remote route is presentation metadata and is not rewritten by flattening. | `WidgetSpec` and COMBO decoder in `schema/model.ts`/`dinkster-wire.ts`; whole-object widget copy in `derive-boundary.ts`; remote COMBO decoder tests in `dinkster-wire.golden.test.ts`. No promoted-remote-COMBO integration test exists. |
| MatchType/type variable relations | Panel pin carries the derived variable expression, though paint may show its unsolved presentation. | Yes. Every variable is prefixed by the bound inner node id; ports from the same inner node and template retain equality, while unrelated inner nodes are separated. The ordinary solver freshens again by the instance node occurrence. | Relations cross static and family boundaries, including nested structured types. Nested re-forwarding adds another instance-node prefix and preserves equality for all ports crossing through that same instance. | `freshenType` in `derive-boundary.ts`; `derive-boundary.test.ts` "type variables cross the boundary" and chained family tests; `solve.ts` variable key `(nodeId, templateId)`. |
| Boundary direction legality | Inputs only produce; Outputs only consume. The add slot follows the same side. | Ordinary instance inputs consume and outputs produce, as expected. | Scene audit rejects reversed boundary ends; boundary noodles are synthetic and cannot be used as persisted graph links. | `layoutBoundaryNode`; `docs/promises.md` rows 87, 100, and 101; `packages/canvas/test/scene-audit.test.ts`. |

### Audit conclusions

The base type-system promise is mostly true: types, MatchType relations,
families, widget specs, and promoted values already use the ordinary instance
schema. The failures are all ownership or endpoint-shape failures:

- a specialized slot's selected variant belongs to an occurrence, but current
  derive/compile code has nowhere to project that choice onto the inner
  occurrence before elaboration;
- trace-derived producer endpoints still lack a stable public output contract;
- the definition panel intentionally has too little data to impersonate an
  instance widget; and
- promoted controller presentation exists without matching queue-time owner
  traversal.

The existing DynamicCombo and FamilyCrossing overlays prove occurrence
projection is viable, but neither is sufficient alone: DynamicCombo forwards
only one `selected` field and deliberately erases branch dependents, while a
family owns a recursively translated prefix/suffix subtree.

## Product decisions

### 1. Forward specialized slots as specialized slots

A direct specialized-slot boundary exposure MUST preserve its
`DynamicSlotSpec`, including variant keys, variant types, dependent inputs,
widget specs, defaults, controller declarations, remote COMBO sources,
tooltips, and nested dynamic constructs. It MUST NOT flatten to `slotType`.

Each parent instance stores the selected variant and all dependent values in
its existing `NodeData.dynamic`/`NodeData.values`, under the boundary item id:

```text
instance.dynamic[boundaryId].selected
instance.values[boundaryId + ".[" + variant + "]." + dependentPath]
```

No choice is written back into the shared definition. Disconnect keeps the
choice and dependent values inert, matching ordinary DynamicSlot behavior.
Reconnect restores them. A connect gesture selects a variant only when the
solved producer type identifies exactly one declared variant; unresolved or
ambiguous types leave the choice unset and retain the existing loud compile
error if the connected slot participates without a valid choice.

### 2. The boundary panel remains a declaration surface, not a value owner

The Inputs panel row for a forwarded specialized slot gains a specialization
marker and a variant summary in its tooltip/menu. It does NOT render the
variant widget editors, defaults, controller chips, or live selected branch.
Those belong to each parent-graph instance. Rendering live values on the
shared definition panel would either invent a fake occurrence or mutate all
occurrences together.

Individual definition-local variant dependents remain exposable under the
existing rule when the definition itself connects/selects the slot. That is a
different feature: it exports one shared, fixed branch. The UI must label it
"fixed to definition variant <key>" so it is not confused with forwarding
the slot.

### 3. Promoted and variant-carried widgets forward the complete contract

The forwarded `WidgetSpec` remains an atomic contract. No boundary-specific
allowlist may copy only known fields. This preserves custom widget kinds,
defaults, ASSET metadata, remote COMBO routes, and future additive fields.

For a direct promoted static widget, and for a widget inside a forwarded
slot/family template, the occurrence is the visible value owner. The
implementation must make unset display and compile agree:

- derive an occurrence fallback from the bound definition value when one is
  stored, otherwise from the widget's schema default/intrinsic default;
- expose that fallback to normal widget rendering/reset without serializing
  it into every instance; and
- use the identical fallback in promoted override lowering and widget taps.

This closes the current case where an unset instance can display the schema
default while compile silently uses a different inner stored value.

Unpromotion keeps instance value/controller state dormant, matching
disconnect and inactive-branch retention, but compile MUST stop applying it
while `promoted !== true`. Re-promotion restores it. A separate explicit reset
may delete dormant state; toggling promotion itself must not silently delete
user data.

### 4. Widget taps forward on instances and boundary outputs

Every memberless widget row produced by the derived instance schema gets the
ordinary right-side widget tap, including variant-dependent widgets revealed
by a forwarded specialized slot. Tap lowering follows the same occurrence
projection as input lowering. An undriven tap reads the occurrence value or
its derived fallback; a driven tap aliases the real producer; typed-literal
and asset-source stamping rules stay unchanged.

An inner static widget tap can also be exported as a boundary output. The
binding retains exact tap identity, derives the input's declared type, and
uses the same driven-alias or undriven-literal compile path. Missing,
ambiguous, dynamic, and non-widget tap targets fail closed.

### 5. Controllers forward with occurrence ownership

Controller mode for a promoted or variant-dependent instance widget lives at
`instance.controllers[valueKey]`. Queue-time advancement must be rebuilt over
compiled elaborated inputs and effective-owner provenance, not raw schema
items. This fixes ordinary dynamic-input controllers and promoted instance
controllers in one path. It then compare-and-sets the occurrence value/mode
through the existing app-state rules and determines driven state from the
compiled terminal delivery, including boundary links.

The promoted parent occurrence owns advancement for both value and mode. An
unset occurrence still reads the inner definition's current controller mode
as its fallback, but completion writes the new value to the occurrence rather
than shared definition state. An unpromoted widget remains definition-owned
and advances that definition once. `after_refresh` follows the same owner
rule when its trigger path is shipped.

### 6. Remote COMBO sources forward unchanged

`WidgetSpec.remote` remains the backend-relative declarative route on every
instance. It is not copied into boundary document data and is not rewritten
for nesting. The editor fetches through the instance tab's target backend,
exactly like an ordinary node. Static options render immediately; successful
remote results replace them under the existing COMBO contract.

The route is presentation metadata, not type identity. Two COMBOs with
different routes remain link-compatible `core.combo`; execution-time
membership stays backend-authoritative.

### 7. Whole dynamic input families continue to forward, not promote

`role: 'inputFamily'` and grouped autogrow templates use the existing
`kind: 'family'` crossing. Recursive state rewriting and connectivity for a
DynamicSlot already exist inside a forwarded family template; this design
requires auditing and extending proof, not a second implementation. Each
suffix member owns its own selected variant in instance member-scoped dynamic
state. Prefix members remain definition-owned.

`promoted` stays invalid on a whole family. Template widgets already travel,
and a promotion bit would create two competing owners. Slot-selective family
forwarding may include or exclude a whole specialized slot, but MUST NOT
narrow into one slot variant: variants are mutually exclusive occurrence
choices, not stable template paths.

### 8. MatchType relations preserve one namespace per crossing

All types inside the forwarded DynamicSlot, including each variant type and
every dependent input type, are recursively freshened with one crossing
namespace. Equal original `(innerNode, templateId)` pairs remain equal across
the slot and its dependents. Different inner nodes remain distinct.

Nested wrappers prepend one namespace at each hop. Implementations MUST use a
structured namespace path internally rather than parse colon-joined strings;
colon rendering may remain the diagnostic/debug spelling. Tests must cover
two sibling instances and two nesting levels so a choice in one occurrence
cannot constrain another.

A drilled occurrence solves incoming parent links as input constraints on the
projected inner ports. A concrete constraint binds the node-local template
once, so every elaborated input and output using that template presents the
same solved type. Removing the parent link removes the constraint and restores
the declared variable. Source types and dynamic members are solved in their
own occurrence context; no resolution is persisted in the definition or
shared with sibling instances.

### 9. Trace-derived structural producers remain deferred

Direct boundary attachment to value sources, selectors, and reroutes is
deferred because they lack the stable declared type needed to derive a public
output schema:

- value-source type is consumer-derived and can be wildcard when unconnected;
- selector/reroute type is trace-derived and can change with topology/policy.

Dragging these producers directly to Outputs reports
`boundary.structuralProducerUnsupported` in Problems without changing the
document. The refusal contract is owned by
[#397](https://github.com/Kosinkadink/Dinkster-Frontend/issues/397).

Widget taps use an explicit `kind: 'widgetTap'` output binding, so they never
collide with same-named real output ports.

External value sources and selectors MAY continue feeding any derived
instance input, including a specialized slot or revealed dependent. The
ordinary connect gesture writes the occurrence's selected variant when the
producer has one unambiguous solved type.

A later structural-producer design should add a required/stamped public
`TypeExpr` for trace-derived producers. It must diagnose drift instead of
silently changing the public interface.

## Core data-model and algorithm changes

### Boundary binding discriminant

`BoundaryBinding` distinguishes whole subtrees from individual ports:

```ts
type BoundaryBinding =
  | { kind: 'port'; node: NodeId; port: PortId; members?: DynamicMemberId[] }
  | { kind: 'family'; node: NodeId; port: PortId; members?: DynamicMemberId[]; slots?: string[] }
  | { kind: 'slot' | 'dynamicCombo'; node: NodeId; port: PortId; members?: DynamicMemberId[] }
  | { kind: 'widgetTap'; node: NodeId; tap: PortId }
```

`kind: 'slot'` MUST resolve exactly to a DynamicSlot terminal with non-empty
`variants`. `kind: 'port'` continues to flatten plain slots and MUST reject a
variant-bearing terminal with a diagnostic instructing the author to expose
it as a slot. This explicit spelling prevents an installed schema update from
silently changing an old plain-port boundary into occurrence-local dynamic
behavior.

`alsoBinds`, `promoted`, and `slots` are invalid on `kind: 'slot'`. A
specialized slot has one occurrence-state owner; fan-out to several slots
would require one selection to satisfy several potentially different variant
sets and is a separate intersection design.

Format version 1 is unchanged: older readers reject an unknown binding kind,
while old documents retain their meanings. TypeScript types, runtime and JSON
Schema validation, invariants, commands, and command replay share the binding
contract. Unsupported flatten plans refuse rather than erasing subtree state.

### Derived schema

`deriveBoundarySchema` must recursively freshen and copy the complete
DynamicSlot spec for a `kind: 'slot'` input. The derived top-level input keeps
the boundary id/display name/optional contract and stores source-route
provenance in derivation-only metadata, not serialized schema wire.

`SubtreeCrossing` shares the `BoundaryCrossing` union with `FamilyCrossing`,
keyed by instance occurrence and boundary id. A subtree crossing owns its entire
structurally elaborated subtree, not only the root port:

- `boundaryId`;
- shared descendants such as `boundaryId.shared`;
- active variant descendants such as `boundaryId.[variant].dependent`; and
- arbitrary dynamic/member descendants below either branch.

It records the structurally resolved inner node/construct, ancestor member
route, and composable mappings for port addresses, member paths, construct
paths, value keys, controller keys, and reverse producer/driver traversal.
Matching enumerates every interpretation because a dotted boundary id can
collide with a descendant path; zero or multiple matches diagnose instead of
choosing a longest prefix. Derivation, connectivity, forward lowering,
bypass/driver tracing, taps, and provenance MUST consume this same crossing;
a second path parser is forbidden.

### Occurrence overlay before elaboration

For each `SubtreeCrossing`, build an occurrence overlay before elaborating the
inner target node:

1. Read the complete parent dynamic subtree rooted at the boundary slot at the
   exact member scope: `selected`, nested selections, `members`, `seq`, and
   recursive `memberState`.
2. Structurally rekey and overlay it onto the inner occurrence's target
   construct subtree without mutating `GraphDef`.
3. Elaborate the inner occurrence from that overlaid state, revealing the
   matching variant dependents.
4. Translate parent instance links/values/controllers for the slot and active
   dependent paths through the crossing.
5. Emit `slotVariants` only on the flattened runtime node, using the inner
   construct-local API name exactly as an ordinary node does.

Overlay precedence is field-presence based and outside-in:

```text
outer explicit occurrence subtree
  > nearest intermediate authored instance subtree
  > terminal authored node subtree
  > schema defaults
```

Explicit empty or stale fields still win: `members: []`, an unknown
`selected`, or a present empty descendant state MUST NOT fall back to a valid
inner value. For an occurrence-owned slot subtree, member lists replace the
inherited list; they do not concatenate as whole-family prefix/suffix state
does. Sibling fields absent from the outer subtree inherit recursively. Each
occurrence gets a fresh overlay object, so sibling and nested instances never
share mutable state.

### Connectivity ownership

The outer slot connection is the authoritative terminal-slot connection for
that occurrence and is projected through every crossing before elaboration.
A `kind: 'slot'` binding to a target already driven inside its definition is
rejected at derive time (`boundary.constructConnected`). This avoids a
disconnect revealing an unexpected local driver and preserves the ordinary
one-driver rule. Connectivity for every active descendant is translated
through the same subtree crossing; it is never inferred from values.

### Connectivity and connect gestures

Scene layout for the parent instance already receives DynamicSlot annotations
from normal `layoutNode` once the derived schema preserves the spec. The
existing `dynamic.specializeSlot` command remains the write path. Boundary
authoring uses `bindingKind: 'slot'` on `boundary.addItem` or
`boundary.setBinding`, not a guess from a post-command schema.

Dropping a producer on a specialized boundary-instance pin composes
specialization and link creation in one batch, exactly like an ordinary slot.
The Boundary inspector's **Forward full slot** action explicitly converts an
existing slot binding to `kind: 'slot'`. Plain-port/family gestures are unchanged.

### Values, taps, and controllers

Generalize crossing translation from only input port addresses to three
occurrence-owned channels:

- `values`: active variant-dependent widget values and the slot value;
- `controllers`: same translated value keys for controller modes; and
- tap resolution: source lookup through the same translated input address.

Add one shared effective-forwarded-value helper used by instance rendering,
promoted override staging, tap fallback, and controller compare-and-set.
Avoid a boundary-only widget wrapper.

For nesting `A -> B -> terminal`, recursive fallback is:

```text
A stored occurrence value/mode
else B authored instance value/mode
else terminal authored node value/mode
else schema/intrinsic default
```

Derivation retains an opaque source-route chain for each occurrence-owned
input; rendering/reset asks the same resolver used by compile rather than
embedding inherited values into `WidgetSpec` or serializing them on A.
Property absence means inherit; explicit null follows the widget kind's
normal unset semantics.

### Effective-owner provenance

Extend compile provenance for every lowered terminal input with its effective
document owner and full forwarding chain, at minimum:

```ts
interface EffectiveInputOwner {
  graphId: GraphDefId
  nodeId: NodeId
  valueKey: string
  controllerKey: string
  boundaryOccurrence: Occurrence
  forwardingChain: readonly BoundaryCrossingRef[]
}
```

The outermost explicit owner is retained while the terminal target translates
at each crossing. Controller advancement, tap fallback, reset, and diagnostics
consume this record. Missing/unknown variant diagnostics anchor to that owner,
not whichever intermediate or terminal node detects the error.

### Diagnostics

Add stable diagnostics for:

- `boundary.slotKindRequired`: `kind: 'port'` targets a specialized slot;
- `boundary.notASpecializedSlot`: `kind: 'slot'` targets anything else;
- `boundary.slotFanout`, `boundary.slotPromoted`, `boundary.slotsOnSlot`;
- `boundary.slotInternallyDriven`;
- `compile.boundary.slotCrossingUnresolved`;
- `compile.boundary.slotVariantMissing` and `...Unknown`, anchored to the
  parent occurrence boundary input while preserving the existing
  `compile.slot.missingVariant` for ordinary nodes; and
- stale nested forwarding where an intermediate definition no longer exposes
  the selected variant/dependent route.

Schema edits leave links/values visible with diagnostics; they never delete a
choice or branch values automatically.

## Nested-subgraph rules

Nested forwarding is the load-bearing case, not a follow-up:

```text
root instance A boundary slot
  -> wrapper definition instance B boundary slot
    -> terminal backend node DynamicSlot
```

- A's occurrence choice controls only the terminal occurrence under A.
- A second A instance may choose another variant.
- B's authored choice is a fallback for contexts where B's slot is not
  forwarded/overridden; it is not mutated by A.
- Outer value/controller keys translate at each crossing, while final graph
  wire names remain terminal construct-local names.
- Root/shared/variant/dynamic descendant addresses match and translate in
  both directions at every crossing; bypass and driver tracing cannot stop at
  an intermediate wrapper.
- MatchType namespaces accumulate per crossing and remain equal along one
  chain, distinct across sibling chains.
- Disconnect at any wrapper leaves outer state inert and emits no terminal
  `slotVariants` entry.
- Explicit empty/stale outer dynamic state masks inner valid state; absent
  fields alone inherit.
- If an intermediate wrapper filters a family template so the slot is absent,
  derivation fails at that wrapper; flattening never skips a crossing and
  falls through to terminal definition state.

The implementation is not complete until two-level nesting tests prove all
rules for two sibling root instances with different variants, plus one
three-crossing associativity case.

## Slice decomposition

Sizes are relative engineering estimates including focused tests and docs.

| Slice | Size | Depends on | Deliverable |
| --- | --- | --- | --- |
| A. Format and derivation | M | none | Add `kind: 'slot'` to format/validators/commands/invariants; derive the recursively freshened DynamicSlot; reject ambiguous legacy `port` targeting; golden and derive tests. |
| B. SlotCrossing and occurrence overlay | L | A | Subtree matching; bidirectional/composable path translation; complete recursive dynamic overlay; authoritative connectivity and internal-driver refusal; direct, two-level, and three-crossing compile tests. |
| C. Values and widget surfaces | M | B | Translate active dependent values; effective forwarded fallback shared by render/compile; editor/default/remote-COMBO tests on direct and nested instances. |
| D. Taps and typed lowering | M | C | Tap active dependent widgets through direct/nested crossings; driven alias, undriven literal, wildcard `$typed`, asset-source stamping, same-id output collision tests. |
| E. Elaborated controller ownership repair | L | C | Effective-owner provenance and driven-state consumption for ordinary dynamic controllers plus promoted/variant-dependent controllers; compare-and-set direct/nested advancement; ensure inner shared controller never advances for an occurrence-owned widget. |
| F. Family composition audit | S/M | B, C | First pin existing specialized-slot-in-family state/connectivity support with tests; implement only gaps found. Cover member-scoped choices/values, prefix vs suffix ownership, slot-selection whole-slot behavior, and native `inputFamily`. |
| G. Canvas boundary authoring | M | A | Specialized marker/tooltip, explicit slot exposure gesture and command, rename/rewire/delete/undo, direction and scene-audit tests. Panel remains non-widget. |
| H. Integration and migration audit | M | B-G | E2E direct/nested workflows, schema-change stale diagnostics, copy/paste/replacement/import checks, promises/feature-coverage updates, performance comparison. |
| I. Structural producer outputs | L, separate project | none of B-H required | Exact widget-tap output bindings are implemented. Value-source/selector/reroute outputs still need a stamped public type contract. |

Parallelism: C and G can proceed after B/A respectively. D and E can proceed
in parallel after C. F should wait for B and C because it multiplies both
state projection and value ownership. H is the convergence gate.

## Required proof matrix for implementation

Each applicable case must run for an ordinary backend node, a direct
subgraph instance, and a two-level nested instance:

- each specialized variant, disconnect/reconnect, stale/unknown choice;
- shared dependents, variant dependents, DynamicCombo-in-slot,
  family-in-dependent, and slot-in-forwarded-family;
- two sibling occurrences selecting different variants;
- dependent plain socket, widget editor/default, remote COMBO, and controller;
- driven and undriven widget taps, including non-concrete and asset targets;
- MatchType equality within one occurrence and isolation across occurrences;
- specialized slot inside a forwarded family suffix member;
- definition prefix state versus occurrence suffix/overlay state;
- mute, bypass, partial execution closure, and controller advancement;
- schema edit removing a selected variant or dependent; and
- boundary panel direction legality, add-slot behavior, undo, replacement,
  copy/paste, and scene audit.

## Open questions for the user

1. Should an unset promoted instance inherit the definition's current stored
   value/mode (the design above), or should promotion sever that inheritance
   and reset to the backend schema default? Inheriting preserves current
   compile behavior; severing is simpler but is a visible behavior change.
2. Should direct specialized-slot forwarding be opt-in through an explicit
   `kind: 'slot'` command, as designed, or should existing `kind: 'port'`
   bindings automatically upgrade when an installed schema gains variants?
   Automatic upgrade is less UI work but violates the explicit-state rule.
3. When a producer type matches several variants with structurally equal
   types, should connect leave specialization unresolved (recommended), or
   select the first schema variant? First-match makes schema order semantic.
4. Should users be allowed to override a connect-selected variant manually
   when the current producer type is incompatible? Ordinary DynamicSlot
   behavior currently permits persisted stale choices and reports advisory
   mismatch; this design keeps that rule.
5. Exporting inner widget taps is supported. Value sources and selectors stay
   deferred until their trace-derived types have a stamped public contract.
6. For controller promotion, should controller history/reset use the inner
   definition's current mode as its inherited default, or always use the
   schema's `controllerInitial`? The design treats the definition mode as the
   inherited fallback to match value inheritance.
7. Does adding persisted `BoundaryBinding.kind: 'slot'` require a workflow
   format-version bump, or may format v1 readers reject only documents that
   actually use the new kind? The design does not assume compatibility.

Until questions 1, 2, and 6 are answered, slices A and B can establish the
explicit crossing and nested overlay, but slices C and E should not ship.

## Decisions (user, 2026-07-29)

The user approved the recommended answers for all open questions, with the
explicit caveat that they may be revisited if issues surface in practice:

1. Unset promoted instances INHERIT the definition's current stored
   value/mode (the design as written); promotion does not sever inheritance.
2. Specialized-slot forwarding is explicit OPT-IN via the `kind: 'slot'`
   command; existing `kind: 'port'` bindings never auto-upgrade.
3. Connect leaves specialization UNRESOLVED when multiple variants match
   with structurally equal types; schema order is never semantic.
4. Persisted stale variant choices remain permitted with advisory mismatch
   reporting, matching ordinary DynamicSlot behavior.
5. External attachment to instance inputs is sufficient for the current
   product; exporting inner taps/value sources/selectors as subgraph
   outputs is a follow-up, not a prerequisite.
6. Controller promotion inherits the inner definition's CURRENT MODE as
   its fallback, matching value inheritance (not `controllerInitial`).
7. No format-version bump: format v1 readers reject only documents that
   actually use `BoundaryBinding.kind: 'slot'` (fail-closed on use, not
   on version).

All seven slices are therefore unblocked on product decisions. Sequencing
unchanged: implementation follows the wire-15 document-materialization
program per the standing priority order.

## DynamicCombo boundary behavior

The ruling in [comfy-vibe-station #24](https://github.com/Kosinkadink/comfy-vibe-station/issues/24)
requires full behavior across subgraph boundaries unless impossible.
[Dinkster-Frontend #397](https://github.com/Kosinkadink/Dinkster-Frontend/issues/397)
owns implementation and verification of this contract:

- New DynamicCombo boundaries forward the full selected branch by default,
  including dependent inputs, values, controllers, and nested dynamic state.
- Each instance owns that state. Sibling and nested occurrences remain
  independent; forwarding never mutates the shared definition.
- Persisted selector-only boundaries retain their meaning on load. A visible
  upgrade action explicitly enables full-branch forwarding; loading never
  silently changes semantics.
- Selector-only forwarding remains a deliberate authoring choice. It carries
  a visible diagnostic explaining that branch inputs remain definition-owned.

Full-branch forwarding is not opt-in for newly authored boundaries and must
not be replaced by a refusal. The explicit persisted binding distinguishes it
from the existing selector-only `kind: 'port'` contract. The specialized-slot
decisions above remain unchanged.
