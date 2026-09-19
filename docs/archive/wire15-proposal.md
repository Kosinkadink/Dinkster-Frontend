# Schema wire 15 recursive dynamic entries: frontend proposal

Status: frontend proposal for backend reconciliation. This document does not
implement wire 15. Neither side should advertise wire 15 until the field names,
validation, and naming rules below are mirrored in both promise ledgers.

## Grounding and goals

The native wire-14 decoder in
`packages/core/src/schema/dinkster-wire.ts` is the frontend decoder used by
`packages/client`. Its interface entries already use `role`, `id`, `type`,
`required`, `default`, `widget`, and `doc`. It also already uses
`minMembers`/`maxMembers` on `inputFamily`, `variants` on `dynamicSlot`, and
`inputs` for each variant's dependent list. Wire 15 should retain those names.

The legacy V1 `/object_info` normalizer in
`packages/core/src/schema/object-info.ts` proves a larger recursive model than
wire 14 can carry:

- Autogrow has an ordered, non-empty template of ordinary or dynamic inputs,
  including grouped templates and Autogrow nested in Autogrow.
- DynamicCombo has ordered options whose input lists recurse.
- DynamicSlot has shared dependent inputs plus optional typed variants whose
  input lists recurse.
- Ordinary leaves retain widget/default/required-ness and documentation at
  every depth.

The tests in `packages/core/test/object-info.test.ts` pin Autogrow in
DynamicCombo, DynamicCombo in Autogrow, DynamicCombo in DynamicSlot shared
dependents, and Autogrow in DynamicSlot variant inputs. Therefore a singular
ordinary-only Autogrow template, as in the initial backend sketch, is not
closed over the legacy model. This proposal changes that one point to a
non-empty recursive `template` array.

## Exact recursive union

`DynamicEntry` is a closed discriminated union. The discriminator remains
`role`, matching the top-level interface. `DynamicEntry` is valid only in input
positions; outputs remain the existing top-level `output` and `outputFamily`
roles in wire 15.

```ts
type DynamicEntry =
  | InputEntry
  | InputFamilyEntry
  | DynamicComboEntry
  | DynamicSlotEntry

interface InputEntry {
  role: "input"
  id: string
  type: TypeExpr
  required?: boolean
  default?: JsonValue
  widget?: WidgetDescriptor
  doc?: string
  displayName?: string
  onAbsent?: "skip" | "accept" | "fail" | "omit"
  forceInput?: boolean
  advanced?: boolean
}

interface InputFamilyEntry {
  role: "inputFamily"
  id: string
  template: DynamicEntry[]
  minMembers?: number
  maxMembers?: number
  memberPrefix?: string
  memberNames?: string[]
  required?: boolean
  doc?: string
  displayName?: string
}

interface DynamicComboEntry {
  role: "dynamicCombo"
  id: string
  options: Array<{
    key: string
    inputs: DynamicEntry[]
  }>
  default?: string
  required?: boolean
  doc?: string
  displayName?: string
}

interface DynamicSlotEntry {
  role: "dynamicSlot"
  id: string
  slotType: TypeExpr
  inputs: DynamicEntry[]
  variants?: Array<{
    key: string
    type: TypeExpr
    inputs: DynamicEntry[]
    doc?: string
  }>
  required?: boolean
  forceInput?: boolean
  doc?: string
  displayName?: string
}
```

`inputs` is used rather than a new `entries` field because wire 14 already
uses `variants[].inputs`, the legacy model calls these lists inputs, and each
list is normalized directly to `InputSpec[]`. In wire 15, every `inputs` list
shown above is recursive. `template` is an array rather than one entry because
one Autogrow member may stamp a group and any stamped slot may itself be
dynamic.

For a prefix-form family, `memberNames` is absent and `memberPrefix` preserves
the upstream prefix independently from the construct `id`. The encoder omits
`memberPrefix` only when it equals `id`; decoder omission therefore means
`memberPrefix = id`. For a names-form family, `memberNames` is present and is
the complete ordered vocabulary (including an empty zero-capacity vocabulary),
and `memberPrefix` is absent. Preserving the independent prefix is a necessary
change from the backend sketch: the legacy model can legally declare family
id `images` with prefix `image`.

Wire-14 `inputFamily` entries use a top-level `type` instead of `template`.
The wire-15 decoder should accept only the wire-15 shape after negotiation;
the existing accepted versions keep their existing decoder path. This avoids
an ambiguous wire-15 entry containing both `type` and `template`.

## Variable types (MatchType) at every depth

Every `type` and `slotType` in a `DynamicEntry` is a full wire TypeExpr and
therefore admits every wire-14 kind, including `variable` with `templateId`
and an optional allowed set. MatchType inside Autogrow templates, DynamicCombo
option inputs, or DynamicSlot dependents is first-class, not excluded.
Upstream CreateList - an Autogrow whose template member is a MatchType input
sharing a template_id with the node's MatchType output - is the canonical
vector.

Unification scope is pinned to the node instance. The frontend solver
(`packages/core/src/schema/solve.ts`) unifies by (nodeId, templateId), so
every stamped member of a family whose template carries `templateId: "T"`
joins one class together with all other same-template ports on the node,
including top-level outputs. For CreateList this reproduces the upstream
semantics exactly - every member and the output resolve to one common type -
and exceeds them: the resolved binding is displayed live on pins and noodles,
propagates through reroutes and subgraph boundaries, and is validated before
submission. A schema wanting independent per-member types declares distinct
template ids; the wire carries whatever the schema says and imposes no extra
restriction.

Wire-14 fast path: an Autogrow whose single template member is a MatchType
input needs no wire-15 grammar at all. Wire-14 `inputFamily` already carries a
full TypeExpr, so its member type may be `{kind: "variable", templateId,
allowed}` today, and the frontend solver already gives elaborated members the
shared node-scoped class. Backend phase 1 currently refuses this shape as an
unsupported nested dynamic marker; translating it to a wire-14 `inputFamily`
with a variable member type would restore CreateList-class nodes immediately,
ahead of wire 15 (reconciliation question 11).

## Recursive identity and submission lowering

Runtime identity and compat submission names are intentionally different.
The runtime keeps schema choices and stable generated member ids; compat
submission uses the active choices and current member ordinals. The following
recursive algorithm is the contract, where `join("", x) = x` and
`join(a, x) = a + "." + x` otherwise.

Each recursive call carries four values:

- `runtimeScope`: schema/document path before this entry.
- `apiScope`: dot-scoped compat submission path before this entry.
- `members`: stable member ids crossed so far, outermost first.
- Active option/variant choices and ordered family member state.

| Arm | Runtime contribution | Submission contribution |
| --- | --- | --- |
| ordinary `input` | Port `join(runtimeScope, id)`, with current `members` | Emit `join(apiScope, id)` |
| `dynamicCombo` | Selector construct `C = join(runtimeScope, id)`; active children recurse from `join(C, "[" + key + "]")` | Emit selector `join(apiScope, id)`; active children recurse from that same selector name, so option key is omitted |
| `dynamicSlot` | Socket construct `S = join(runtimeScope, id)`; shared children recurse from `S`; active variant children recurse from `join(S, "[" + key + "]")` | Emit socket `join(apiScope, id)`; shared and active variant children recurse from that same socket name, so variant key is omitted |
| `inputFamily` | Construct `F = join(runtimeScope, id)`; each template child uses `F` and appends that member's stable id to `members` | Member name is `memberNames[i]` or `(memberPrefix ?? id) + i`; member base is `join(apiScope, memberName)` |

Family template lowering has one compatibility exception. When `template`
contains exactly one ordinary `input`, that leaf's id is omitted from the
submission name and the leaf emits at the member base. This preserves the
upstream single-member `{prefix}{i}` form. Otherwise every template child
recurses normally from the member base, retaining ordinary leaf and dynamic
construct ids. This makes grouped leaves and single dynamic constructs
unambiguous. Nested families naturally append another member-name segment.

The lowering is invertible only with the schema, active choices, and current
ordered family state. A compat key alone cannot recover stable member id `m7`,
and must not pretend to: ordinal names deliberately change after reorder while
the runtime identity remains stable.

Golden vectors the implementation slice must pin:

| Shape | Stable runtime key | Compat submission id(s) |
| --- | --- | --- |
| ordinary `strength` | `strength` | `strength` |
| family id `images`, prefix `image`, one ordinary `image`, member `m7` at ordinal 0 | `images.image#m7` | `image0` |
| grouped family id/prefix `pair`, leaves `image` + `mask`, member `m7` | `pair.image#m7`, `pair.mask#m7` | `pair0.image`, `pair0.mask` |
| combo `mode`, option `batch`, nested family id `frame`, prefix `image`, member `m7` | `mode.[batch].frame.image#m7` | selector `mode`, member `mode.image0` |
| family prefix `row`, member `m7`, single nested combo `mode`, option `full`, leaf `strength` | `rows.mode.[full].strength#m7` | selector `row0.mode`, leaf `row0.mode.strength` |
| slot `source`, shared combo `resize`, option `fit`, leaf `width` | `source.resize.[fit].width` | selectors `source.resize`, leaf `source.resize.width` |
| slot `source`, variant `mask`, leaf `invert` | `source.[mask].invert` | `source.invert` |
| outer family prefix `row` member `m7`, single inner family prefix `sub` member `m2`, one leaf `value` | `outer.inner.value#m7#m2` | `row0.sub0` |

The decoder also validates the projected compat namespace before accepting a
node. For every reachable active-state combination, every simultaneously
emitted submission id from the recursive algorithm must be unique. Combo
options are checked independently because only one is active. DynamicSlot
shared dependents are checked together with each variant independently;
different variants may reuse a local id because they are mutually exclusive.
Every possible family member name within its declared capacity participates.
For prefix form with omitted `maxMembers`, the encoder/decoder must prove
symbolically that the complete `{prefix}{non-negative integer}` language is
disjoint from sibling ordinary names and other family languages; inability to
prove disjointness rejects the node.

Required negative vectors are: ordinary `image0` beside family prefix `image`;
two sibling families with different ids but the same prefix `item`; overlapping
names-form vocabularies; and either collision repeated beneath a combo, slot,
or family member scope. Retaining family ids in submission names would avoid
these collisions but would violate the proposed upstream naming, so changing
that rule requires backend reconciliation rather than an implementation guess.

The safe-segment grammar in this proposal is an intentional requirement of
dot scoping, not a claim about the legacy parser's permissive string handling.
The backend must confirm that real ComfyUI V3 construction enforces this
grammar. If it does not, wire 15 is not ready to co-pin: both sides must first
add a shared escaping/mapping rule that preserves raw upstream names while
keeping document and submission paths injective. The compat translator must
skip such a node loudly until then.

### Ordinary entry

```json
{
  "role": "input",
  "id": "strength",
  "type": { "kind": "concrete", "types": ["core.float"] },
  "required": false,
  "default": 0.75,
  "widget": { "type": "NUMBER", "min": 0, "max": 1, "step": 0.01 },
  "doc": "Blend strength"
}
```

This maps through the existing ordinary input decoder to one `InputSpec`.
`required: false` maps to `optional: true`; `default`, `widget`, and `doc`
keep their wire-14 meanings.

### Autogrow entry

```json
{
  "role": "inputFamily",
  "id": "channel",
  "template": [
    {
      "role": "input",
      "id": "gain",
      "type": { "kind": "concrete", "types": ["core.float"] },
      "required": false,
      "default": 1,
      "widget": { "type": "NUMBER", "min": 0, "max": 2, "step": 0.05 },
      "doc": "Per-channel gain"
    }
  ],
  "minMembers": 1,
  "memberNames": ["left", "right"],
  "required": false,
  "doc": "Ordered channel inputs"
}
```

This maps to the existing `AutogrowSpec`: `template` becomes its ordered
`InputSpec[]`, and `memberNames` becomes
`naming: {kind: "names", names: ["left", "right"], min: 1}`. With no
`memberNames`, it becomes prefix naming with `prefix: memberPrefix ?? id` and
the declared bounds. Grouped and recursively dynamic templates need no new
runtime model.

### DynamicCombo entry, including nested Autogrow

```json
{
  "role": "dynamicCombo",
  "id": "mode",
  "options": [
    {
      "key": "single",
      "inputs": [
        {
          "role": "input",
          "id": "image",
          "type": { "kind": "concrete", "types": ["comfy.IMAGE"] },
          "required": true
        }
      ]
    },
    {
      "key": "batch",
      "inputs": [
        {
          "role": "inputFamily",
          "id": "frame",
          "template": [
            {
              "role": "input",
              "id": "image",
              "type": { "kind": "concrete", "types": ["comfy.IMAGE"] },
              "required": true
            }
          ],
          "minMembers": 1,
          "maxMembers": 8,
          "memberPrefix": "image"
        }
      ]
    }
  ],
  "default": "single",
  "required": true,
  "doc": "Input mode"
}
```

This maps to the existing `DynamicComboSpec`. Option order is preserved,
`default` maps to `defaultOption`, and the decoder derives the selector's COMBO
widget from the ordered option keys exactly as the runtime does today. There
is no redundant `widget` field to drift from `options`, and an empty option
list remains representable. The runtime already elaborates only the selected
option and preserves inactive branch-local values.

The nested `batch` example illustrates the algorithm end to end:

1. Wire entry ids are local segments: `mode` -> `frame` -> `image`.
2. With option `batch` selected and stable member id `m7`, the frontend
   runtime address is `{port: "mode.[batch].frame.image", members: ["m7"]}`;
   its packed runtime key is `mode.[batch].frame.image#m7`. The bracketed
   option and `m7` are document identity, never submission names.
3. If `m7` is ordinal 0, the compat submission member id is `mode.image0`.
   The parent `mode.` is the dot scope and `image0` is the upstream-compatible
   `{prefix}{i}` member name. The single template leaf does not add `.image`.
   A grouped template would submit `mode.image0.image` and
   `mode.image0.mask`. Reordering members changes ordinals/submission names but
   does not change stable runtime identity.
4. A top-level equivalent submits `image0` (not `frame.image0`). A deeper
   family under that member appends another dot-scoped member segment, for
   example `mode.image0.tile0`.

For names-form Autogrow, the selected name replaces `{prefix}{i}` verbatim:
the first nested member in `memberNames: ["left", "right"]` submits as
`mode.left`; grouped leaves append as `mode.left.gain`.

### DynamicSlot entry

```json
{
  "role": "dynamicSlot",
  "id": "source",
  "slotType": { "kind": "concrete", "types": ["comfy.IMAGE"] },
  "inputs": [
    {
      "role": "dynamicCombo",
      "id": "resize",
      "options": [
        { "key": "none", "inputs": [] },
        {
          "key": "fit",
          "inputs": [
            {
              "role": "input",
              "id": "width",
              "type": { "kind": "concrete", "types": ["core.int"] },
              "required": false,
              "default": 1024,
              "widget": { "type": "NUMBER", "min": 1, "step": 1 }
            }
          ]
        }
      ],
      "default": "none",
      "required": false
    }
  ],
  "variants": [
    {
      "key": "mask",
      "type": { "kind": "concrete", "types": ["comfy.MASK"] },
      "inputs": [
        {
          "role": "input",
          "id": "invert",
          "type": { "kind": "concrete", "types": ["core.boolean"] },
          "required": false,
          "default": false,
          "widget": { "type": "BOOLEAN" }
        }
      ],
      "doc": "Mask specialization"
    }
  ],
  "required": false,
  "doc": "Connected source"
}
```

This maps to the existing `DynamicSlotSpec`: `slotType`, recursive shared
`inputs`, and existing typed `variants` all map directly. Wire 14 derives a
slot's unspecialized type from variants because it has no `slotType`; wire 15
should carry `slotType` explicitly so the schema can express a shared base
socket even with zero variants. The runtime already supports recursive shared
and variant dependents. The native wire decoder currently exposes only
ordinary variant dependents and no shared dependents, so recursive decoding is
implementation work for the later wire-15 slice.

## Validation and failure policy

Wire 15 is structural schema, not presentation metadata. The decoder rejects
the whole node with an error diagnostic when any rule below fails. It must not
drop a malformed dynamic child and present a partial interface.

- Every recursive value is an object with one known `role` from the closed
  union. Unknown roles reject the node loudly, including at top level. This is
  deliberately stricter than wire 14's `schema.dinkster.unknownRole` entry skip:
  skipping a dynamic selector or family changes prompt meaning.
- Every `TypeExpr` is valid under the existing strict recursive decoder.
  Unknown kinds reject the node; no `comfy.COMFY_*_V3` fake concrete atoms are
  synthesized.
- STRUCTURAL entry ids and member names are non-empty dot-free path segments
  matching `[A-Za-z0-9_-]+`: construct ids (inputFamily/dynamicCombo/
  dynamicSlot/outputFamily), entry ids nested inside any dynamic construct,
  template leaf ids, option keys, variant keys, memberPrefix, and each
  memberNames entry. Ordinary TOP-LEVEL input and output ids are NOT
  structural - they never join a dot-joined construct path - and keep
  wire-14 leniency (any non-empty string). Live-verified 2026-07-28: the
  backend emits working upstream ids like `input_blocks.0.` (ModelMerge*)
  and `Audio VAE` (LTXVAudioVAE*); an earlier decoder build that applied
  the segment grammar to ordinary top-level ids wrongly rejected 17
  catalog nodes, matching the Q7 pin's structural-segment scoping and the
  backend's own enforcement. Sibling ids are unique within one recursive
  input list. Top-level input and output namespaces are independent: an
  input and output may share an id, as pinned by the SaveAudioAdvanced
  decoder test.
- `template` is a non-empty array. `inputs` arrays and `options` may be empty.
  Dynamic recursion is subject to the frontend's existing depth and total-item
  budgets; budget exhaustion rejects the native node rather than turning a
  reserved dynamic marker into a wildcard.
- `minMembers` and `maxMembers` are safe non-negative integers. For prefix
  form, `memberPrefix` is absent or one safe segment and
  `minMembers <= maxMembers` when max is present. For names form,
  `memberNames` is unique (an empty list is a valid zero-capacity family),
  `memberPrefix` is absent,
  `minMembers <= memberNames.length`, and `maxMembers` is omitted because the
  vocabulary length is the maximum. Empty `memberNames` therefore requires
  omitted or zero `minMembers` and emits no members.
- DynamicCombo option keys are non-empty, dot-free, unique, and ordered.
  `default`, when present, names an option. The selector widget is derived
  from this one source of truth; it is not carried separately on the wire.
- DynamicSlot variant keys retain wire 14's `[A-Za-z0-9_-]+` grammar and are
  unique. Each variant has a valid `type`. `slotType` is always required in
  wire 15. A shared dependent id may not collide with an active variant-local
  id because both lower construct-locally; reject such a schema rather than
  relying on the runtime's current skip diagnostic.
- `required`, `forceInput`, `advanced`, defaults, absence policies, and widget
  descriptors retain their existing strict types and wire-14 normalization.
  In particular, `onAbsent: "omit"` on a required ordinary input is invalid.
- The recursive projected compat namespace is collision-free for every
  reachable active-state combination. A collision rejects the whole node;
  no input silently wins or disappears.

Unknown object fields remain additive and may be ignored. Unknown presentation
widget descriptors retain wire 14's tolerant fallback where safe. Unknown
structural roles, TypeExpr kinds, or future dynamic kinds are not additive:
the client skips the entire node loudly. A client must never mint a concrete
atom from an unknown structural marker.

## Runtime mapping and implementation notes

- Ordinary entries reuse `decodeInput` and the current pin/widget model.
- Input families extend the current `familyDynamic` path to decode an ordered
  recursive template and names-form naming. `AutogrowSpec`, grouped stamping,
  named vocabularies, nested state, stable member ids, and widgets already
  exist.
- DynamicCombo maps directly to `DynamicComboSpec`; selector widgets,
  branch-local state, inactive-value preservation, pins, and editors already
  exist. The native decoder and schema-wire validation are the missing parts.
- DynamicSlot maps directly to `DynamicSlotSpec`; shared and variant recursive
  dependents already elaborate. Native decode must stop deriving `slotType`
  from variants for wire 15 and decode both recursive input lists.
- The current Autogrow API-name code explicitly labels nested/grouped naming
  provisional. It currently composes family and member names differently from
  the contract above. The implementation slice must change submission-name
  derivation and add golden compile tests; this proposal does not change it.
- The internal `PortSpecBase` comment says ids are unique within a node, but
  the actual model is role-tagged and already retains same-id input/output
  entries. Any future validator should state uniqueness per role namespace,
  not globally.

No new runtime construct is required. The implementation risk is decoder
validation and API-name lowering, not pin or widget representation.

## Explicit exclusions

Wire 15 does not add `accept_all_inputs`, `lazy`, or `rawLink`. Dynamic output
nesting is also not proposed here; top-level wire-14 `outputFamily` remains as
is. These exclusions must skip an affected compat node loudly at translation
or decode time, never silently erase behavior.

## Open questions for backend reconciliation

1. Will the backend accept `template: DynamicEntry[]` rather than the sketched
   singular ordinary entry? Without this, grouped Autogrow and every legacy
   dynamic-inside-Autogrow case are unrepresentable.
2. Will wire-15 `inputFamily` replace wire-14's `type` with `template` after
   version negotiation as proposed, or does "additive" mean both fields are
   present? If both, which one is authoritative for a one-entry template?
3. Will every recursive child list use the existing field name `inputs`, with
   `template` reserved for Autogrow stamping, rather than introducing
   `entries`?
4. Does the backend agree to retain `variants[].{key,type,inputs,doc}` and add
   explicit `slotType` plus shared `inputs`? Removing variants would regress
   the existing native and legacy DynamicSlot model.
5. Does the backend agree to add `memberPrefix` and omit it only when equal to
   `id`? Prefix = id alone cannot encode legal id `images`, prefix `image`.
6. Does the backend agree that the family construct id is replaced by the
   upstream member name in submission space (`image0`, nested
   `mode.image0`), while the template leaf is appended only for grouped
   families? If not, provide the exact expected names for top-level single,
   nested single, grouped prefix, grouped names-form, and nested Autogrow in
   Autogrow before either side implements.
7. Are ids, option keys, prefixes, and member names guaranteed to satisfy
   `[A-Za-z0-9_-]+`, or does upstream require a broader escaped vocabulary?
   Wire 15 cannot co-pin until literal dots are forbidden or an escaping rule
   is pinned.
8. Does the backend agree to carry ordinary `forceInput` and `advanced`, plus
   DynamicSlot `forceInput`, so recursive widget-capable sockets and advanced
   presentation survive? These are additions to the initial sketch; `lazy`
   remains explicitly excluded.
9. Does the backend agree that DynamicCombo's widget is derived from its
   option keys rather than duplicated on the wire, including for zero-option
   constructs?
10. Should malformed/unknown structural entries reject the whole node in the
   backend encoder as proposed, so the frontend never receives a partial
   dynamic interface?
11. Nested MatchType: does the backend agree that (a) `variable` TypeExprs are
   legal at every recursive depth in wire 15, carrying the shim's template_id
   so the input/output matching relation survives, with node-instance-wide
   unification scope (all stamped members plus same-template outputs join one
   class); and (b) as a phase-1.5 fast path independent of wire 15, a
   single-member Autogrow whose template is a MatchType input translates
   today to wire-14 `inputFamily` with a variable member type, restoring
   CreateList-class nodes immediately?

## Co-pin record (2026-07-28, FINAL)

All eleven open questions are reconciled with the backend coordinator
(T-019f9e5d-d2e8-7173-8d6b-88a91bf66880). This section is the contract of
record; where it amends the body above, this section wins.

- Q1/Q2/Q3: recursive non-empty `template: DynamicEntry[]` replaces `type`
  on wire 15 (both-present is malformed); recursive child lists are named
  `inputs`; wire 14 stays bit-compatible.
- Q4 (amended): dynamicSlot has two MUTUALLY EXCLUSIVE forms discriminated
  by field presence - variant form `{id, variants[{key, type, inputs?,
  doc?}], inputs?, required, doc?, displayName?}` and open compat form
  `{id, slotType, inputs, required, forceInput?, doc?, displayName?}`.
  Exactly one of `variants`/`slotType` present; both or neither rejects
  the node. The body's always-required derived `slotType` is superseded.
- Q5 (amended): `memberPrefix` is emitted EXPLICITLY whenever an ordinal
  vocabulary exists, including when equal to `id`; absence means no
  vocabulary and the decoder never infers a prefix from `id`. Exactly one
  of `memberPrefix`/`memberNames` may be present; both absent is legal
  (native free-suffix family). Names form omits `maxMembers` (capacity =
  memberNames length, `[]` legal zero capacity with min 0/omitted).
  Prefix ordinals are ZERO-BASED `{prefix}{i}`; first `minMembers`
  required, rest optional.
- Q6 (corrected): compat submission lowering is CONSTRUCT-SCOPED - the
  construct id is RETAINED in upstream paths (`images.image0`,
  `mode.frame.image0`, `combo.subcombo.float_x`, `source.<depId>`),
  verified against upstream parse_class_inputs/finalize_prefix. The
  body's replace-the-id lowering and its symbolic-disjointness machinery
  are superseded. Dinkster document space is unchanged: `<family>.<suffix>`
  with stable suffixes, grouped leaf appended, option/variant keys never
  in materialized ids, active combo choice is document state keyed by
  materialized construct path. Prefix families map ordered document
  members to ordinals; names families require suffixes to be memberNames
  entries (subset allowed, min enforced).
- Q7 (amended): every wire-15 structural segment (construct ids, nested
  entry ids, template leaf ids, option keys, variant keys, memberPrefix,
  each memberNames entry) must match `[A-Za-z0-9_-]+`. NO escaping in
  wire 15; the backend skips violators loudly (compatSkips) and the
  frontend rejects malformed nodes. Revival trigger: a real working
  upstream node with a non-conforming identifier.
- Q8/Q9/Q10: confirmed as proposed - presentation-only `forceInput`/
  `advanced` on ordinary entries and `forceInput` on open-form
  dynamicSlot; DynamicCombo selector derived from ordered option keys
  (no widget field, zero-option legal but required zero-option compat
  combos skip loudly); whole-node rejection on any structural failure,
  unknown object FIELDS stay additive/ignorable.
- Q11a: variable TypeExprs (`{kind: "variable", templateId, allowed?}`)
  are legal as the type of ANY DynamicEntry at ANY recursive depth -
  Autogrow templates, DynamicCombo option entries, dynamicSlot dependents
  in both forms. EXCEPTION: open-form `slotType` itself may NOT be a
  variable (upstream slots are non-dynamic typed sockets); variant-form
  types stay recursively concrete as today. Unification is node-instance-
  wide by (nodeId, templateId); the backend solver binds through
  list<variable> and asset<variable> in both directions. Backend
  worker-boundary resolution is authoritative; frontend document-level
  solving is a pre-submission layer.
- Q11b: shipped backend-only on wire 14 (backend commit 08542db):
  single-member MatchType Autogrow templates translate to variable-typed
  inputFamily; CreateList-class nodes restored and live-verified.
- Open-form dependent activation (amendment pinned 2026-07-28, backend
  contract of record Dinkster docs/wire15-contract.md at be3e120): the
  open-slot socket itself is ALWAYS present in the effective schema as
  an optional input (required:true open form whole-node-rejects). The
  shared `inputs` dependents - plus any nested active state and consumed
  choices under them - materialize ONLY when the document stores a
  VALUE OR LINK at the slot's materialized construct path (upstream
  parity: DynamicSlot._expand_schema_for_dynamic activates on
  finalized_id in live_inputs). An absent open slot contributes the bare
  optional socket and nothing else; stored dependents under an inactive
  open slot reject as unknown inputs. Variant-form activation
  (choice-driven) is completely unchanged. Backend node-facing delivery:
  variant slots keep SlotValue-with-choice, an active open slot delivers
  the plain value with no choice, absent passes nothing. FRONTEND DELTA
  (flagged to backend 2026-07-28, ledgered in docs/promises.md): our
  elaboration gates open-form dependents on LINK existence only
  (elaborate.ts dynamicSlotHandler), and compile stages any stored
  document value at an elaborated slot path into the prompt - so a
  stored value at an unconnected open-slot path is today emitted without
  materializing (or validating) the dependents the backend would
  activate. Alignment (value-or-link gating in elaboration) is a pinned
  follow-up before or with the wire-15 materialization slices; slot
  sockets currently expose no widget, so the skew is reachable only via
  imported or command-crafted documents, not normal UI.
- DynamicCombo option-key grammar amendment (joint pin 2026-07-29, widened
  in round 2): option keys match `[!-~]+( [!-~]+)*`, allowing single-space-
  joined tokens of printable non-space ASCII while rejecting leading,
  trailing, consecutive, or empty spaces, non-ASCII, and controls.
  Identity remains exact: there is no trim, case folding, or whitespace
  normalization, and duplicate/default matching compares exact strings.
  This amendment applies only to DynamicCombo option keys because they live
  in choice state and selector values, never dot-scoped structural paths.
  Construct and nested entry ids, template leaf ids, DynamicSlot variant
  keys, memberPrefix, and memberNames entries remain strict
  `[A-Za-z0-9_-]+`. A combo also rejects sibling keys when one starts with
  the other followed by `]`, preventing persisted branch-prefix aliasing.
  Backend acknowledgement: 2026-07-29; backend mirror landed at fc7bc1b and
  is tracked in Dinkster `docs/PROMISES.md` and `docs/wire15-contract.md`.
- Exclusions unchanged: `accept_all_inputs`, `lazy`, `rawLink`, dynamic
  output nesting.
- Versioning (clarified 2026-07-28, superseding any back-compat phrasing
  above): the existing ?wire= negotiation contract is SINGLE-VERSION -
  the server serves exactly SCHEMA_WIRE_VERSION and answers anything
  else with the loud machine-readable 406, never a dual encode or silent
  downgrade. Wire 15 is therefore a hard cutover like v13->v14 (one
  signature/cache rotation). Operationally: the shared :8765 stays on a
  pre-bump commit until the frontend decoder speaks 15; the restart onto
  a bumped build is coordinated between both coordinators, and the
  frontend accept-set flip lands in lockstep with that restart.
- Sequencing: backend implements slice A (schema foundation, wire-15
  encode/decode under the single-version negotiation, version bump
  14->15) then slice B (compat translate phase 2). The frontend is
  cleared to implement its decoder against this pinned grammar now,
  fixture-driven; live verification and the requested-wire-version flip
  wait for backend slice A and the coordinated shared-server restart.
- Backend contract of record: Dinkster `docs/wire15-contract.md` (main
  a3496a0), cross-checked against this document 2026-07-28 with no
  grammar discrepancies. Neither side changes the contract unilaterally.
