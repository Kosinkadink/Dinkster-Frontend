# Latest-ComfyUI widget/input inventory and A/F/I diagnosis (audit W1-AUDIT)

Durable record of the W1-AUDIT delegate report
(thread T-019fe2a2-9378-711b-845d-484bad8ad91f, read-only research, no code
or service mutation). Parent matrix: docs/widget-parity-matrix-audit.md
(rows A, F, I). This file is the pinned source diagnosis those rows cite.

## Source pins

- Dinkster-Frontend evidence: clean HEAD 975073a49af75c99a88eea75baf309a445468ed5.
- Dinkster backend evidence: clean HEAD 6a5a1c23a25d7b24b8c01c49eec021d513eb4910.
- ComfyUI: fetched origin/master 00d02f2854892ee5b9808bc2f6348b972017886a
  (read via git show; checkout not switched).
- ComfyUI_frontend: fetched origin/main bdc0345da4610f16b4102f7e4628905b09b165ac
  (read via git show; checkout not switched).
- Representative node pack: pythongosssss/ComfyUI-Custom-Scripts
  609f3afaa74b2f88ef9ce8d939626065e3247469.

## Row A - numeric slider opt-in: four-stage trace

1. ComfyUI declares display intent independently of bounds. Legacy
   InputTypeOptions defines numeric min/max/step/round and the frontend
   parser accepts display: 'slider'|'number'|'knob'|'gradientslider'
   (ComfyUI/comfy/comfy_types/node_typing.py:129-138;
   ComfyUI_frontend/packages/object-info-parser/src/schemas/nodeDefSchema.ts:45-72).
   V3 has NumberDisplay.number/.slider/.gradient_slider
   (ComfyUI/comfy_api/latest/_io.py:74-78); Int.Input and Float.Input take
   display_mode and serialize it as display (_io.py:267-320). V3 does not
   expose knob; the legacy frontend schema does. Bounds and display are
   separate fields in both declarations.

2. Dinkster drops the intent in compat/backend translation. The v1
   translator's _number_widget iterates only min/max/step plus INT
   control_after_generate
   (Dinkster/packages/dinkster-compat-comfy/src/dinkster_compat_comfy/translate.py:1002-1059).
   The V3 direct translator builds widgets only for COMBO and BOOLEAN
   (translate_v3.py:226-284). The runtime v1/V3-shim path ultimately calls
   _number_widget (translate.py:1830-1897). Backend NumberWidget has exactly
   min/max/step/control_after_generate
   (Dinkster/packages/dinkster-schema/src/dinkster_schema/model.py:352-386); wire
   encoding has exactly type/min/max/step/controlAfterGenerate
   (wire.py:93-103; NUMBER shape unchanged since wire v11 per wire.py:47-65).
   The loss is backend-side, before the frontend sees the catalog.

3. The frontend cannot accept an additive field without a coordinated
   decoder change. Strict NUMBER validation allows only
   type,min,max,step,controlAfterGenerate; rejectUnknownWidgetFields throws
   otherwise (Dinkster-Frontend/packages/core/src/schema/dinkster-wire.ts:284-290,
   357-380; descriptor view :450-465,587-635; goldens
   packages/core/test/dinkster-wire.golden.test.ts:571-666 and strict-reject
   packages/core/test/dinkster-wire17.golden.test.ts:99-130). Adding backend
   display alone would loudly reject; backend model/wire and frontend strict
   decoder must land as one wire bump / negotiated additive contract.

4. Current ComfyUI_frontend uses explicit intent; Dinkster currently infers
   fill from bounds. ComfyUI_frontend INT chooses slider only when
   display == 'slider' (useIntWidget.ts:42-68), FLOAT routes
   gradientslider/slider/knob/number (useFloatWidget.ts:41-82). Dinkster's
   compact number painter computes numericRangeFill for every finite
   strictly ordered min/max pair with no display gate
   (Dinkster-Frontend/packages/widgets/src/kinds.ts:317-358) - exactly the
   bounds inference forbidden by row A.

### Verdict A

The slider declaration is MISSING FROM THE DINKSTER WIRE (backend-side loss),
not a frontend-only dropped field. Exact missing field: a NUMBER
presentation field preserving upstream's declared numeric display mode.

Proposed additive contract wording (requires a coordinated schema wire
version because current strict decoders reject unknown NUMBER keys):

> A NUMBER widget descriptor MAY contain `display`, one of `number`,
> `slider`, `knob`, or `gradientslider`. The field preserves
> source-declared presentation intent only. Absence means ordinary numeric
> presentation. Clients MUST NOT infer `slider`, slider track, or slider
> fill solely from `min`/`max`. `min`, `max`, and `step` remain
> validation/stepping metadata independent of `display`. A client that does
> not implement a declared non-default mode MAY fall back to an ordinary
> number editor without changing the value.

Backend slice: add display to NumberWidget + wire encoder/strict decoder
(dinkster_schema model.py/wire.py); preserve legacy config['display'] in
translate.py and V3 display_mode in translate_v3.py; compat + wire
round-trip tests. Coordinated frontend slice: admit/copy display in
packages/core/src/schema/dinkster-wire.ts + goldens; then gate numericRangeFill
in packages/widgets/src/kinds.ts and widget tests.

Row E keys on spec.options['display'] === 'slider', never bounds.
gradientslider and knob are separate declared modes, not row-E sliders.
Plain/absent display stays ordinary numeric even with finite min/max.

### Concurred contract and wire mechanics (backend CONCUR 2026-08-08)

Backend T-019fdb99-2732-71ff-a7db-4f6f3c0c944e accepted the contract
wording above exactly as written, with this pinned interpretation and
mechanics:

- Wire spelling: `display?: "number" | "slider" | "knob" | "gradientslider"`
  on a NUMBER descriptor. Presentation-only; excluded from execution/
  schema-signature/cache semantics. A NumberWidget may exist with display
  as its only metadata.
- Explicit `display: "number"` and absence both permit ordinary numeric
  rendering, but the backend preserves the explicit source declaration
  rather than canonicalizing it away. Bounds/step remain independent;
  neither side may infer slider/track/fill from min/max. Unsupported UI
  modes fall back to the ordinary number editor without changing the value.
- Wire mechanics: schema wire 17 -> 18. SCHEMA_WIRE_VERSION = 18;
  SCHEMA_WIRE_SERVE_VERSIONS = (17, 18); rolling historical decoder window
  (16, 17, 18). Wire 18 strictly accepts the new closed display
  key/vocabulary. Wire 17 remains frozen and must not receive the key.
- v17 downlevel encoding drops display; when display is the NumberWidget's
  only metadata, the whole NUMBER descriptor is omitted so the primitive
  numeric input gets the contractually permitted ordinary-editor fallback.
  When old min/max/step/controller metadata is also present, v17 keeps
  exactly those old fields. This is an explicit negotiated downlevel
  presentation fallback, not a silent addition to v17.
- Negotiation: `/api/nodes?wire=18,17` selects 18; a client advertising
  only 17 keeps strict v17; absent ?wire= selects current 18. The frontend
  adoption therefore adds 18 decoding/goldens and advertises 18 with 17
  fallback.
- Backend slice: preserve only exact supported legacy config['display']
  values; lower V3 Int/Float display_mode to the same field; construct V3
  numeric widgets including bounds/step; model + strict v18 encode/decode +
  v17 downgrade + both translator paths + negotiation + round-trip/golden
  proofs. No V3 knob synthesis; unknown source display values are not
  reinterpreted.
- Backend and frontend PROMISES/current-wire rows move together; the
  standing shared frontend/server must not be advanced to wire 18 until
  the accepting frontend slice is ready. The concurrence authorized no
  implementation, deployment, service, or live action by itself.

## Row F - inventory

Legend: supported = present through Dinkster's current catalog/wire/frontend;
missing/supportable = upstream provides a stable declaration Dinkster loses;
intentional/incompatible = execution or security semantics forbid
presentation-only guessing.

### Primitive and widget surfaces

| Surface | Upstream source | Dinkster status / bounded slice |
|---|---|---|
| INT/FLOAT default,min/max/step | node_typing.py:104-136; _io.py:267-320 | Supported in runtime compat (translate.py:1002-1059; wire.py:93-103; dinkster-wire.ts:587-635). V3 direct port misses numeric widgets (translate_v3.py:226-284): add V3 number construction in A's backend slice. |
| Numeric display number/slider/knob/gradientslider | nodeDefSchema.ts:45-52; _io.py:74-78,267-320; useIntWidget.ts:42-50; useFloatWidget.ts:44-52 | Missing/supportable, contract-gated: slice F1 (= row A). Knob is legacy-only at this pin; do not synthesize. Gradient stops (nodeDefSchema.ts:64-72; _io.py:297-320) are a follow-on widget view after the display contract. |
| FLOAT round | node_typing.py:137-138; _io.py:297-320; useFloatWidget.ts:12-25,54-80 | Missing/supportable: NumberWidget/wire has no round. Slice F2: optional finite positive round in NUMBER model/wire/decode, both translators, WidgetEditor commit rounding tests. Separate from step, as upstream. |
| control_after_generate (INT + COMBO) | node_typing.py:165-177; _io.py:273-290,350-389; useComboWidget.ts:291-306 | Partly supported: declared INT modes survive (translate.py:1038-1059; dinkster-wire.ts:618-634). COMBO control dropped (ComboWidget has no controller field; wire.py:76-85). Slice F5: controller metadata on COMBO + frontend WidgetSpec/controller tests. Never infer by input name (Comfy's seed/noise_seed name inference at useIntWidget.ts:70-87 is frontend-only convention, not portable). |
| STRING single/multiline | node_typing.py:145-154; _io.py:322-342; useStringWidget.ts:68-91 | Frontend/wire capability exists (dinkster-wire.ts:637-653; kinds.ts:170-179,359-379; native CLIP proves switchable single/multiline, Dinkster native.py:927-947) but BOTH compat translators never construct string widgets (translate.py:1830-1897; translate_v3.py:249-269). Slice F3: _string_widget in v1 + V3 translators preserving explicit multiline; compat + golden tests. |
| STRING placeholder | node_typing.py:149-150; _io.py:328-342; useStringWidget.ts:15-24,77-85 | Missing/supportable: StringWidget has only multiline (model.py:437-450; wire.py:104-105). Slice F3 (joint): optional placeholder in STRING descriptor, decoder, compact/editor empty-state rendering, tests. |
| STRING dynamicPrompts | node_typing.py:153-154; _io.py:328-342; behavior is frontend serialization-time expansion (ComfyUI_frontend/src/extensions/core/dynamicPrompts.ts:5-30) | Missing, SEMANTIC decision required (changes submitted text; native CLIP port deliberately drops it, native.py:906-914). Slice F4 only after policy approval: explicit semantic flag or maintained pre-submit transform with deterministic/undo tests. Distinct from row I autocomplete. |
| BOOLEAN label_on/label_off | node_typing.py:139-144; _io.py:247-265; useBooleanWidget.ts:6-28 | Supported end-to-end (translate.py:985-999,1883-1895; translate_v3.py:262-268; golden dinkster-wire.golden.test.ts:516-569; kinds.ts:380-390). No Comfy schema authority for alternate boolean representations - no checkbox/switch inference. Dinkster wire-17 representation switching exists only when explicitly authored (model.py:482-550; dinkster-wire17.golden.test.ts:45-80; userSwitchable gate menu-target.test.ts:58-101). |
| COMBO static choices/default | node_typing.py:167-177; _io.py:344-389 | Supported for non-empty strings (translate.py:1062-1085,1830-1897; golden :445-514). Numeric combo options intentionally not presented (string-only core.combo contract, translate.py:1062-1075). |
| COMBO remote/refresh | node_typing.py:161-164; RemoteOptions _io.py:47-71; useComboWidget.ts:285-288 | Partly supported: probed filesystem listings become Dinkster-owned /api/choices/... with refresh (translate.py:19-24,690-694,1840-1881; frontend fetch/refresh/filter WidgetEditor.tsx:425-495). Generic upstream remote config dropped in V3 (translate_v3.py:249-261). Slice F6 (contract/security): allowlisted/proxied Dinkster routes only; TTL/retry/control-after-refresh need separately adjudicated client policy. |
| COMBO multi-select | _io.py:89-93,396-418; MultiSelectWidget.vue:1-32 | Missing: Dinkster combo value domain is scalar string (model.py; wire.py:76-85; kinds.ts:189-218). Slice F7 (cross-contract): list-valued COMBO descriptor/value binding, decode, compile behavior, multi-select editor + tests. Do not fake as scalar. |
| COMBO filtering/search | Frontend-only UX (contextMenuFilter.ts:9-26,124-169; MultiSelectWidget.vue:1-9) | Supported frontend convention (WidgetEditor.tsx:483-495). No slice. |
| COMBO media upload flags; model file_upload | nodeDefSchema.ts:90-105; UploadType _io.py:40-45,350-389; WidgetSelect.vue:55-110 (model upload TODO at :94) | Missing for compat media uploads: translators never read upload flags. Dinkster has typed ASSET picker/upload (model.py:214-238) and frontend ASSET kind (kinds.ts:230-248). Slice F8: declared image/audio/video uploads -> typed AssetWidget kinds/media types with worker-side AssetRef-to-source-filename adaptation + tests. model file_upload NOT source-ready (upstream TODO). |
| COLOR | V3 _io.py:1332-1343; Dinkster frontend already has COLOR kind/view (kinds.ts:220-228,399-413) | Missing at backend contract/compat: PRIMITIVES maps only INT/FLOAT/STRING/BOOLEAN so COLOR is opaque comfy.COLOR (translate.py:697-705; translate_v3.py:125-158); wire descriptor union has no COLOR (model.py:456-458; dinkster-wire.ts:293-388). Slice F9 (joint): COLOR descriptor bound to canonical string type, V3 translation, strict encode/decode, compat + editor/compile tests. |

### Structural, media, and special-input surfaces

| Surface | Source classification | Dinkster status / slice |
|---|---|---|
| IMAGE/MASK, AUDIO, VIDEO sockets + previews | Tensor/data types (_io.py:420-446,653-663); previews/mask editor are frontend UX (useNodeImage.ts:99-132; maskeditor.ts:10-33,50-89; DisplayCarousel.vue:343-348) | Data supported: dedicated IMAGE/AUDIO/VIDEO codecs (translate.py:1680-1703). Upload = slice F8. Preview and editing are editor surfaces: Dinkster's `image` editor kind provides mask tools and applies through `image.applyAsset`; output preview is an explicit wire flag (model.py:663-670; wire.py:464-466). |
| Generic FILE | No standalone V3 FILE primitive; model files are UploadType.model on COMBO (_io.py:40-45,344-389) | No generic FILE widget to port; use F8. Do not invent FILE from filenames. |
| Hidden inputs | Legacy UNIQUE_ID/PROMPT/EXTRA_PNGINFO/DYNPROMPT (node_typing.py:182-211); V3 auth/API holders (_io.py:1480-1508) | Intentional non-UI: Dinkster excludes hidden values and synthesizes known execution values (translate.py:62-68,1949-1968). Auth/API hidden values must not become widgets. |
| required/optional/default | node_typing.py:197-207; _io.py:160-210 | Supported (translate.py:1267-1301,1830-1913; translate_v3.py:247-284). No slice. |
| forceInput/defaultInput/socketless/widgetType | node_typing.py:104-128; _io.py:191-213; migration nodeDefStore.ts:104-133; litegraphService.ts:218-235,268-317 | forceInput supported (translate.py:1451-1460; translate_v3.py:273-284; wire.py:350-353). defaultInput deprecated upstream - no support needed. socketless/widgetType are dropped frontend-layout conventions; only add an explicit Dinkster representation descriptor when a real custom widget is ported. |
| lazy | node_typing.py:114-117; _io.py:160-183 | Supported only for the proven synchronous scalar selector subset (translate.py:809-850; test_compat_comfy.py:631-683; wire.py:354-357). Other lazy semantics intentionally incompatible until backend execution support exists. |
| rawLink | node_typing.py:116-117; _io.py:164-183 | Intentional incompatibility: both paths loudly refuse (translate.py:1341-1344,1770-1774; translate_v3.py:236-239,296-299). Backend execution owner + semantic trigger required; no frontend slice. |
| tooltip/displayName/advanced | nodeDefSchema.ts:28-43; _io.py:164-183 | V3 direct + dynamic shim supported (translate_v3.py:273-284; translate.py:1383-1417,1451-1460); legacy TOP-LEVEL runtime compat drops doc/display/advanced/forceInput (translate.py:1905-1913). Slice F10: centralize ordinary input construction so top-level v1 and V3-shim rows preserve them; compat wire golden tests. Frontend already consumes them (dinkster-wire.ts:98-127,682-700). |
| Autogrow, DynamicCombo, DynamicSlot, MultiType/MatchType | _io.py:957-1051,1082-1217,1219-1270,1272-1302 | Supported schema translation (translate_v3.py:135-223,287-360; catalog :394-493). No widget-specific slice. No separate generic "input group" declaration exists at this pin. |
| V3 special widget IO (COMPOSITOR, IMAGECOMPARE, COLOR(S), BOUNDING_BOX(ES), CURVE, RANGE, WEBCAM) | _io.py:885-903,1319-1459,430-441 | Mostly opaque (translate.py:697-705; translate_v3.py:249-269). COLOR = F9. Others are separate source-ready slices only when value codec + maintained editor exist: F11 RANGE/gradient, F12 CURVE, F13 BOUNDING_BOX(ES), F14 COMPOSITOR/IMAGECOMPARE. Do not collapse into JSON text editors. |
| Representation switching | Dinkster schema capability, not a Comfy declaration (model.py:482-550; wire.py:112-130; dinkster-wire17.golden.test.ts:45-80,179-223) | Supported only where schema explicitly declares it (e.g. native CLIP text, native.py:927-947). Never create boolean/numeric representation alternatives from bounds/labels. |

### Wave-2 slice register (F-derived)

| Slice | Scope | Layer |
|---|---|---|
| F1 | Numeric declared display contract (= row A); slider first, knob/gradient explicit follow-ons; includes V3 direct numeric widget construction | joint backend+frontend |
| F2 | FLOAT round in NUMBER descriptor + compat + editor commit rounding | joint |
| F3 | Compat STRING metadata: multiline + placeholder through both translators | joint |
| F4 | dynamicPrompts semantic adjudication (pre-submit transform or explicit flag) | policy + joint |
| F5 | COMBO control_after_generate controller metadata | joint |
| F6 | Generic remote COMBO policy (allowlisted Dinkster routes; refresh first) | backend contract |
| F7 | Multi-select COMBO list-valued contract + editor | joint |
| F8 | Declared media uploads -> typed ASSET (image/audio/video; model waits upstream) | joint |
| F9 | COLOR end-to-end (backend descriptor + existing frontend kind) | joint |
| F10 | Legacy top-level input prose/layout metadata parity (tooltip/displayName/advanced/forceInput) | backend |
| F11-F14 | RANGE, CURVE, BOUNDING_BOX(ES), COMPOSITOR/IMAGECOMPARE - each gated on codec/editor design | joint, separately gated |
| F15 | Output media preview renderer + image editor mask capability | frontend |

## Row I - multiline extension capability

### Mechanisms reviewed

- ComfyUI native multiline editor is a real textarea bound to widget
  value/callback (multilineTextarea.ts:15-27,33-109); string construction
  passes placeholder/dynamicPrompts (useStringWidget.ts:68-91).
- Built-in dynamic prompts are serialization-time {a|b} replacement, not
  autocomplete (dynamicPrompts.ts:5-30).
- Public extension seam: getCustomWidgets + beforeRegisterNodeDef
  (types/comfy.ts:152-165,188-207; extensionService.ts:70-98;
  widgetStore.ts:10-39).
- pysssss autocomplete wraps ComfyWidgets.STRING, enhances multiline only,
  attaches TextAreaAutoComplete (autocompleter.js:273-317); per-input
  config via beforeRegisterNodeDef (:585-600); embeddings from
  api.getEmbeddings() (:530-546); LoRAs from choices or /pysssss/loras
  (:548-571); backend routes py/autocomplete.py:6-29; caret-token parser /
  ranking / keys / undo-preserving replacement (common/autocomplete.js:
  536-554,496-534,408-480,290-336,613-651). No wildcard-file scanner in
  this pack.

### Verdict I

The generic per-widget completion seam is FRONTEND-LOCAL; no public
backend/schema wire change required. Dinkster already has: a public widget
registry with identical core/pack registration
(packages/widgets/src/registry.ts:1-44); extension activation exposing
widgetKind/widgetView/preview contributions with lifecycle disposal
(packages/core/src/extensions/host.ts:69-88,283-309); host-owned textarea
editing converging on maintained document commands
(packages/app/src/WidgetEditor.tsx:957-1014,1017-1056).

Smallest typed seam (slice I1):

```ts
interface TextWidgetEditorContext {
  readonly graphId: string
  readonly nodeId: string
  readonly inputId: string
  readonly nodeType: string
  readonly spec: WidgetSpec
}
interface TextCompletionRequest extends TextWidgetEditorContext {
  readonly text: string
  readonly caret: number
  readonly trigger: string
  readonly signal: AbortSignal
}
interface TextCompletion {
  readonly id: string
  readonly label: string
  readonly replacement: { readonly start: number; readonly end: number; readonly text: string }
  readonly detail?: string
}
interface TextWidgetEditorExtension {
  readonly id: string
  supports(context: TextWidgetEditorContext): boolean
  complete(request: TextCompletionRequest): readonly TextCompletion[] | Promise<readonly TextCompletion[]>
}
```

Registration: disposable TextWidgetEditorExtensionRegistry, exposed as a
manifest-declared textEditorExtension contribution beside existing widget
registrations (host.ts:69-88,283-309), held beside widgetRegistry in
app-state.ts:1020-1031, consumed only by the textareas in
WidgetEditor.tsx:957-1056. Providers return data/ranges only - no DOM
mutation authority; acceptance dispatches exactly one maintained undoable
command through the existing commit path.

Proving example: static/local EmbeddingAndLoraCompletionProvider scoped to
multiline STRING widgets with an injected catalog fixture, completing
`embedding:foo` and `<lora:foo:1.0>`.

Live inventory contract: LiveEmbeddingAndLoraInventoryProvider captures a
typed source scope restricted to `/api/choices/comfy.files.embeddings` and
`/api/choices/comfy.files.loras`. A lazy request exposes immutable loading and
settled ready, empty, or error states. Query and filter text share
NFKC/locale-invariant lowercase normalization; ready items also carry stable
source order and exact replacements. It forwards cancellation and
explicit refresh, refuses superseded or changed-scope results, and never falls
back to stale data. AppState scopes each request to the active live tab and its
selected backend client. The provider owns no DOM, store, or dispatcher. Dinkster
#130 tracks guaranteed backend publication of both routes.

Required tests: duplicate registration/refusal + disposer identity; stable
provider ordering; per-widget supports; replacement range at caret;
Escape/no mutation; Arrow/Tab/Enter; IME isComposing; stale async result
cancellation on edit/close/provider disposal; provider failure isolation;
exactly one maintained undoable command on acceptance.

No arbitrary filesystem route is permitted. Wildcard inventory remains out of
scope unless a separate safe catalog contract is defined.

## Cleanliness

Final git status --short was empty in Dinkster-Frontend, Dinkster, ComfyUI, and
ComfyUI_frontend. Only remote-tracking refs were fetched; no branch switch,
code change, commit, browser/server/process action, or backend job.
