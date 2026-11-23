/**
 * Normalized NodeSchema model. V3 is the semantic target.
 *
 * Native catalog entries are parsed once into this model; nothing downstream
 * touches raw schema JSON. Subgraph definition boundaries derive this exact
 * same model, which is what makes "anything that works on a node works on a
 * subgraph" true by construction.
 *
 * The interface is one ordered list of items (inputs, outputs, presentation
 * constructs) - any order the schema declares. Inputs and outputs are modeled
 * symmetrically, including dynamic families.
 */

import type { ReplacementRule } from '../replace/model.js'

export type SchemaSource = 'v3' | 'v1' | 'subgraph'

// ---------------------------------------------------------------------------
// Type expressions
// ---------------------------------------------------------------------------

/**
 * The type of a port. Kept small and closed on purpose: the type solver is
 * defined over exactly these forms.
 * - concrete: a single data type name ('IMAGE', 'LATENT', ...)
 * - union: MultiType (COMFY_MULTITYPED_V3) - any of the named types
 * - wildcard: '*' - matches anything, no propagation
 * - variable: MatchType (COMFY_MATCHTYPE_V3) - a type variable shared among
 *   ports with the same templateId, optionally constrained to allowedTypes.
 *   Freshened per node instance (and per subgraph instance) by the solver.
 * - list: structured (recursive) kind, mirroring Dinkster schema wire
 *   v2 (DESIGN 3.13). `list<T>` is ONE ordinary value on ONE edge - never
 *   implicit repeated execution; length is runtime data, never schema.
 *   There is no implicit coercion in either direction: list-vs-scalar
 *   cardinality mismatches are structural errors, unlike ordinary advisory
 *   atom mismatches.
 * - asset: the second structured kind (Dinkster schema wire v12, typed assets).
 *   `asset<T>` is a committed-asset REFERENCE whose decode target is T; the
 *   value is one AssetRef envelope regardless of T, so cardinality is
 *   SCALAR even for `asset<list<T>>`. The backend applies exactly one
 *   engine-side coercion step at input resolution (decode asset<T> -> T,
 *   lift list<asset<T>> -> list<T>, registry-gated merge
 *   list<asset<T>> -> T), which advisory compatibility mirrors.
 * - stream: recursive wire-41 media stream type with scalar cardinality.
 *   Stream transport and chunk execution remain backend-owned.
 */
export type TypeExpr =
  | { readonly kind: 'concrete'; readonly name: string }
  | { readonly kind: 'union'; readonly names: readonly string[] }
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'variable'; readonly templateId: string; readonly allowedTypes?: readonly TypeExpr[] }
  | { readonly kind: 'list'; readonly element: TypeExpr }
  | { readonly kind: 'asset'; readonly element: TypeExpr }
  | { readonly kind: 'stream'; readonly element: TypeExpr }
  | { readonly kind: 'tuple'; readonly elements: readonly TypeExpr[] }
  | { readonly kind: 'tuple_element'; readonly input?: string; readonly element?: TypeExpr; readonly index: string | number }

/** COMBO is a concrete type carrying a string, boolean, or finite number. */
export const COMBO_TYPE = 'COMBO'

// ---------------------------------------------------------------------------
// Canonical parametric type ids ('list<...>', 'asset<...>', 'stream<...>')
// ---------------------------------------------------------------------------
//
// The canonical runtime identity of a closed structured type is the
// parametric string `list<element_type_id>` / `asset<element_type_id>`
// (nesting composes: `list<asset<comfy.IMAGE>>`), matching the backend's
// dinkster_values grammar exactly (its closed constructor set: atom | list<id>
// | asset<id> | stream<id>). These functions are the SINGLE owner of that grammar -
// nothing else string-matches parametric ids (the same rule the backend
// pins), and a structured type has exactly ONE schema representation:
// `{ kind: 'list' | 'asset' | 'stream' }`, never `concrete('list<...>')`.
// Structural slot/family ids already forbid '<'/'>' (elaborate.ts), so
// canonical type ids can never collide with structural ids.

const LIST_TYPE_PREFIX = 'list<'
const ASSET_TYPE_PREFIX = 'asset<'
const TYPE_SUFFIX = '>'

const parseParametricTypeId = (typeId: string, prefix: string): string | undefined =>
  typeId.startsWith(prefix) &&
  typeId.endsWith(TYPE_SUFFIX) &&
  typeId.length > prefix.length + TYPE_SUFFIX.length
    ? typeId.slice(prefix.length, -TYPE_SUFFIX.length)
    : undefined

/** The canonical type id of a list of `elementTypeId`. */
export const listTypeId = (elementTypeId: string): string =>
  `${LIST_TYPE_PREFIX}${elementTypeId}${TYPE_SUFFIX}`

/** The element type id if `typeId` is a canonical list id, else undefined. */
export const parseListTypeId = (typeId: string): string | undefined =>
  parseParametricTypeId(typeId, LIST_TYPE_PREFIX)

/** The canonical type id of an asset whose decode target is `elementTypeId`. */
export const assetTypeId = (elementTypeId: string): string =>
  `${ASSET_TYPE_PREFIX}${elementTypeId}${TYPE_SUFFIX}`

/** The decode-target type id if `typeId` is a canonical asset id, else undefined. */
export const parseAssetTypeId = (typeId: string): string | undefined =>
  parseParametricTypeId(typeId, ASSET_TYPE_PREFIX)

export const streamTypeId = (elementTypeId: string): string => `stream<${elementTypeId}>`
export const parseStreamTypeId = (typeId: string): string | undefined =>
  parseParametricTypeId(typeId, 'stream<')

/** Split positional ids without splitting commas inside nested constructors. */
export const parseTupleTypeId = (typeId: string): readonly string[] | undefined => {
  if (!typeId.startsWith('tuple<') || !typeId.endsWith('>')) return undefined
  const body = typeId.slice(6, -1)
  if (body === '') return []
  const elements: string[] = []
  let start = 0
  let depth = 0
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (char === '<') depth++
    else if (char === '>') {
      if (--depth < 0) return undefined
    } else if (char === ',' && depth === 0) {
      elements.push(body.slice(start, index))
      start = index + 1
    }
  }
  elements.push(body.slice(start))
  return depth === 0 && elements.every((element) => element !== '') ? elements : undefined
}

/**
 * The canonical type id a recursively-closed expression denotes (concrete ->
 * its name, closed list -> 'list<...>', closed asset -> 'asset<...>'), else
 * undefined. The single bridge between the expression level and canonical
 * atom strings: solver domains and display labels use these ids for
 * structured-type identity.
 */
export const canonicalTypeIdOf = (t: TypeExpr): string | undefined => {
  if (t.kind === 'concrete') return t.name
  if (t.kind === 'tuple') {
    const elements = t.elements.map(canonicalTypeIdOf)
    return elements.some((element) => element === undefined) ? undefined : `tuple<${elements.join(',')}>`
  }
  if (t.kind === 'list' && t.element.kind === 'wildcard') return 'list<*>'
  if (t.kind === 'list' || t.kind === 'asset' || t.kind === 'stream') {
    const inner = canonicalTypeIdOf(t.element)
    return inner === undefined ? undefined : `${t.kind}<${inner}>`
  }
  return undefined
}

/**
 * Rebuild the structured expression a canonical type id denotes (inverse of
 * canonicalTypeIdOf). Keeps the one-representation invariant: code holding a
 * solved atom string must go through this instead of wrapping it in
 * `concrete` directly, so `concrete('list<...>')` never enters the system.
 */
export const typeExprFromTypeId = (typeId: string): TypeExpr => {
  const positions = parseTupleTypeId(typeId)
  if (positions !== undefined) return { kind: 'tuple', elements: positions.map(typeExprFromTypeId) }
  const listInner = parseListTypeId(typeId)
  if (listInner !== undefined)
    return {
      kind: 'list',
      element:
        listInner === '*'
          ? { kind: 'wildcard' }
          : typeExprFromTypeId(listInner),
    }
  const assetInner = parseAssetTypeId(typeId)
  if (assetInner !== undefined) return { kind: 'asset', element: typeExprFromTypeId(assetInner) }
  const streamInner = parseStreamTypeId(typeId)
  if (streamInner !== undefined) return { kind: 'stream', element: typeExprFromTypeId(streamInner) }
  return { kind: 'concrete', name: typeId }
}

/**
 * True when a canonical type id is an ASSET-SOURCE form the backend's
 * coercion planner accepts on a concrete destination: `asset<T>` (decode
 * arm) or `list<asset<T>>` (lift/merge arms). The emission rule keys on
 * exactly these forms: a literal whose
 * runtime type is an asset source DIFFERING from the concrete declared
 * type must be $typed-stamped (the plain literal would be wrapped as the
 * declared type raw and never reach the planner). Bare `ASSET` and
 * `list<ASSET>` are NOT asset sources - the untyped atom has no
 * decode target, so a stamp would not make it coercible.
 */
export const isAssetSourceTypeId = (typeId: string): boolean => {
  if (parseAssetTypeId(typeId) !== undefined) return true
  const inner = parseListTypeId(typeId)
  return inner !== undefined && parseAssetTypeId(inner) !== undefined
}

/**
 * True when a canonical type id DECLARES an asset-reference destination:
 * bare `ASSET`, `asset<...>`, or a list of either. Per the typed-assets
 * joint pins, such destinations receive AssetRef envelopes AS-IS - never
 * coerced - so an asset-source literal landing on one must stay a PLAIN
 * literal even when the source form differs from the declared form (e.g. an
 * `asset<comfy.IMAGE>` tap into a bare `ASSET` input): a $typed stamp
 * would route it into the coercion planner, which has no asset-to-asset
 * vocabulary and would refuse a delivery the plain ref satisfies.
 */
export const isAssetRefDestinationTypeId = (typeId: string): boolean => {
  if (typeId === 'ASSET' || parseAssetTypeId(typeId) !== undefined) return true
  const inner = parseListTypeId(typeId)
  return inner !== undefined && (inner === 'ASSET' || parseAssetTypeId(inner) !== undefined)
}

/**
 * Multi-select gating for ASSET widgets (typed-assets joint pin (5),
 * Dinkster b56fa4f + caf1070 amendment). Two arms:
 *
 * - LIST-OUTER (schema-driven): the declared outer type is a LIST of
 *   asset references - `list<asset<T>>` or bare `list<ASSET>` -
 *   because N selections lower to N descriptors in a list literal.
 * - SCALAR MERGE (registry-gated, backend 6dbbddd): the declared type is
 *   a scalar concrete atom T with a registered batch-merge provider
 *   (`mergeableTypes` from the /api/nodes dinkster envelope). N selections
 *   stage a `list<asset<T>>` literal the engine decodes-each-then-merges
 *   into ONE batched T; the widget tap exposes T (one batch), which is
 *   simply the declared input type. Absent list (older backend) = arm
 *   off; the backend planner enforces regardless, so staleness only
 *   under/over-offers the UI.
 *
 * `asset<list<T>>` stays single-pick: its multi-ness comes from the
 * DECODER (one file, many batches), not from selection. Bare scalar
 * `ASSET` stays single-pick: the untyped atom has no decode target
 * to merge through (and the backend registry holds atoms like
 * comfy.IMAGE, never ASSET).
 */
export const assetMultiSelect = (t: TypeExpr, mergeableTypes?: readonly string[]): boolean =>
  (t.kind === 'list' &&
    (t.element.kind === 'asset' ||
      (t.element.kind === 'concrete' && t.element.name === 'ASSET'))) ||
  (t.kind === 'concrete' &&
    t.name !== 'ASSET' &&
    parseListTypeId(t.name) === undefined &&
    parseAssetTypeId(t.name) === undefined &&
    mergeableTypes !== undefined &&
    mergeableTypes.includes(t.name))

/**
 * Structural shape of an expression. Cardinality is authoritative (unlike
 * atom compatibility, which is advisory): a definitely-list edge into a
 * definitely-scalar input is a document-time ERROR, while wildcard/variable
 * stay 'unknown' and never trigger structural rejection. Mirrors the
 * backend's TypeExpr.cardinality().
 */
export type Cardinality = 'scalar' | 'list' | 'unknown'

export const cardinalityOf = (t: TypeExpr): Cardinality => {
  switch (t.kind) {
    case 'list':
      return 'list'
    case 'tuple':
    case 'stream':
      return 'scalar'
    case 'asset':
      // One AssetRef envelope regardless of decode target - even
      // asset<list<T>> is a scalar on the edge (backend pin, typed assets).
      return 'scalar'
    case 'concrete':
      // Defensive: a canonical list id smuggled into `concrete` (adapters
      // must use typeExprFromTypeId) still reports its true shape.
      return parseListTypeId(t.name) === undefined ? 'scalar' : 'list'
    case 'union':
      return t.names.every((n) => parseListTypeId(n) === undefined)
        ? 'scalar'
        : t.names.every((n) => parseListTypeId(n) !== undefined)
          ? 'list'
          : 'unknown'
    default:
      return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

/**
 * One closed widget descriptor. It owns presentation for one canonical value
 * domain; changing descriptors never changes the input's socket or value.
 */
export interface WidgetDescriptorSpec {
  readonly widgetType: string
  readonly options: Readonly<Record<string, unknown>>
  /** Scalar presentation retained by a one-level primitive LIST widget. */
  readonly element?: WidgetDescriptorSpec
  /** Open-vocabulary ASSET classification (wire v7; presentation only). */
  readonly kind?: string
  /** Source media inputs may acquire bytes through the bounded media ingest route. */
  readonly allowUpload?: true
  /** Source-named file, pair, directory or file-free option under exact grants. */
  readonly selection?: true
  readonly default?: unknown
  /** Controller slot (control_after_generate / control_after_refresh). */
  readonly controller?: 'after_generate' | 'after_refresh'
  /**
   * Schema-declared INITIAL controller mode (native wire v11
   * controlAfterGenerate). Presentation seed only: live mode stays
   * client-owned document state (node.controllers); absent falls back to
   * the historical 'randomize' default.
   */
  readonly controllerInitial?: 'fixed' | 'increment' | 'decrement' | 'randomize'
  /** Declarative remote option source (combos and kin). */
  readonly remote?: RemoteSourceSpec
  /** Ordered choices authored on an occurrence, independently of its selected value. */
  readonly editableOptions?: true
  /** Schema-declared text completion vocabulary (wire 36). */
  readonly textCompletions?: TextCompletionsSpec
  /** A custom or compositor widget's own part names -> the row ids it writes. */
  readonly writes?: Readonly<Record<string, string>>
  /** A custom or compositor widget's own part names -> the row ids it reads. */
  readonly reads?: Readonly<Record<string, string>>
}

export interface TextCompletionItemSpec {
  readonly value: string
  readonly label: string
  readonly insertText: string
  readonly detail: string
  readonly kind: 'identifier' | 'operator'
}

export interface TextCompletionsSpec {
  readonly items: readonly TextCompletionItemSpec[]
}

/** One stable schema-authored name for one widget presentation. */
export interface WidgetRepresentationSpec {
  readonly id: string
  readonly displayName: string
  readonly widget: WidgetDescriptorSpec
}

/**
 * Finite presentation choices from schema wire 17. `default` is only the
 * initial choice; client selection lives in NodeViewState and is never part
 * of the canonical input value, TypeExpr, links, or execution identity.
 */
export interface WidgetRepresentationsSpec {
  readonly default: string
  readonly userSwitchable: boolean
  readonly representations: readonly WidgetRepresentationSpec[]
}

/**
 * WidgetSpec: the effective/default descriptor plus optional wire-17 named
 * alternatives. Existing consumers keep reading the descriptor fields; only
 * presentation selection needs to inspect `representations`.
 */
export interface WidgetSpec extends WidgetDescriptorSpec {
  readonly representations?: WidgetRepresentationsSpec
}

export interface ResolvedWidgetRepresentation {
  readonly spec: WidgetSpec
  readonly id?: string
}

/**
 * Ordinary strings and bounded FLOATs support value-compatible views. An
 * explicit representation set takes authority, including a locked set with
 * userSwitchable false or only one representation.
 */
export function widgetRepresentationsOf(spec: WidgetSpec): WidgetRepresentationsSpec | undefined {
  if (spec.representations !== undefined) return spec.representations
  if (spec.widgetType === 'FLOAT') {
    const { min, max } = spec.options
    if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min)
      || !Number.isFinite(max) || max <= min || !Number.isFinite(max - min)) return undefined
    return {
      default: spec.options['display'] === 'slider' ? 'slider' : 'number',
      userSwitchable: true,
      representations: [
        { id: 'number', displayName: 'Number', widget: { ...spec, options: { ...spec.options, display: 'number' } } },
        { id: 'slider', displayName: 'Slider', widget: { ...spec, options: { ...spec.options, display: 'slider' } } },
      ],
    }
  }
  if (spec.widgetType !== 'STRING') return undefined
  const descriptor = (multiline: boolean): WidgetDescriptorSpec => ({
    ...spec,
    options: { ...spec.options, multiline },
  })
  return {
    default: spec.options['multiline'] === true ? 'multiline' : 'single-line',
    userSwitchable: true,
    representations: [
      { id: 'single-line', displayName: 'Single line', widget: descriptor(false) },
      { id: 'multiline', displayName: 'Multiline', widget: descriptor(true) },
    ],
  }
}

/**
 * Resolve a client-owned representation selection without mutating schema or
 * document state. An absent or stale selection uses the schema default; the
 * stale id remains stored so a later schema refresh can restore it.
 */
export function resolveWidgetRepresentation(
  spec: WidgetSpec,
  selected?: string,
): ResolvedWidgetRepresentation {
  const set = widgetRepresentationsOf(spec)
  if (set === undefined) return { spec }
  const representation = set.representations.find((candidate) => candidate.id === selected) ??
    set.representations.find((candidate) => candidate.id === set.default)
  if (representation === undefined) return { spec }
  return {
    id: representation.id,
    spec: {
      ...representation.widget,
      representations: set,
    },
  }
}

export interface RemoteSourceSpec {
  readonly route: string
  readonly refreshButton?: boolean
  readonly controlAfterRefresh?: 'first' | 'last'
  readonly timeoutMs?: number
  readonly maxRetries?: number
  readonly refreshMs?: number
}

// ---------------------------------------------------------------------------
// Formulas, lookups and steps as a declaration carries them
// ---------------------------------------------------------------------------

/** A formula over the node's own rows (mirror/formula.ts evaluates it). */
export interface FormulaSpec {
  readonly formula: string
}

/**
 * A call to a pack's lookup function. The editor never calls one: a place
 * whose value comes from a lookup shows its "while unknown" answer.
 */
export interface LookupSpec {
  /** Module path inside the pack and function name; opaque to the editor. */
  readonly lookup: string
  /** Field ids and formulas, by position. */
  readonly args: readonly (string | FormulaSpec)[]
}

/** A literal, or a formula that works it out. */
export type Formulated<T> = T | FormulaSpec
/** A literal, a formula, or a lookup. */
export type Looked<T> = T | FormulaSpec | LookupSpec

export const isFormulaSpec = (value: unknown): value is FormulaSpec =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  typeof (value as { formula?: unknown }).formula === 'string' && Object.keys(value).length === 1

export const isLookupSpec = (value: unknown): value is LookupSpec =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  typeof (value as { lookup?: unknown }).lookup === 'string'

/**
 * One action step, kept as declared. Running steps is not built in the
 * editor; a button that holds them is drawn and does nothing.
 */
export interface StepSpec {
  readonly step: string
  readonly [field: string]: unknown
}

/** A validation rule: a formula that must be true, its message, and an optional fix. */
export interface RuleSpec {
  readonly check: FormulaSpec
  readonly message: string
  readonly fix: readonly StepSpec[]
}

// ---------------------------------------------------------------------------
// The node body: an ordered tree of rows
// ---------------------------------------------------------------------------

interface PortSpecBase {
  /**
   * Row id, unique among the inputs (or outputs) of its scope. Elaborated
   * specs carry the flattened id instead (`loras.2.strength`).
   */
  readonly id: string
  readonly displayName?: string
  /** A label the declaration works out by formula; `displayName` is then unset. */
  readonly labelFormula?: FormulaSpec
  readonly tooltip?: string
  /** Whether the row shows. A hidden row is still stored and sent to the run. */
  readonly visible?: Formulated<boolean>
  /** Alpha handling at this port; undefined is the default 'preserve'. */
  readonly alphaPolicy?: AlphaPolicy
  readonly maskPolarity?: MaskPolarity
  readonly maskSemantic?: MaskSemantic
  /**
   * Set by elaboration, never declared: the flattened id of the innermost
   * section that holds this row.
   */
  readonly section?: string
  readonly ext?: Readonly<Record<string, unknown>>
}

export type AlphaPolicy = 'preserve' | 'require' | 'create_if_missing' | 'drop'
export type MaskPolarity = 'coverage' | 'transparency'
export type MaskSemantic = 'alpha' | 'selection' | 'other'

/**
 * What happens when a linked input's value arrives ABSENT at runtime (Dinkster
 * first-class absence, schema wire v3). Applied by the ENGINE before
 * invocation - never frontend behavior to emulate:
 * - 'skip': the node does not run; its outputs become absent with the ROOT
 *   origin's provenance (default for required inputs)
 * - 'omit': treated as unconnected (default for optional inputs; invalid on
 *   required ones - decoders must not produce that combination)
 * - 'accept': the node runs and receives an explicit no-value
 * - 'fail': the run fails loudly, naming the origin. An optional output
 *   feeding a 'fail' input is legal but warned (solve.maybeAbsent).
 */
export type AbsentPolicy = 'skip' | 'accept' | 'fail' | 'omit'

/** A pin, a field, or both. */
export interface InputSpec extends PortSpecBase {
  readonly kind: 'input'
  readonly type: TypeExpr
  readonly optional: boolean
  /** Derived boundary input forwarding an edit-time schema literal. */
  readonly outputSchemaSource?: true
  /** Declared absence policy; undefined = the required-ness default. */
  readonly onAbsent?: AbsentPolicy
  /** The execution accepts storage-backed values directly (wire 39); true or omitted. */
  readonly acceptsStorage?: true
  readonly acceptsStream?: true
  /** Consume a whole list of the declared type without element mapping or wrapping. */
  readonly acceptsList?: true
  /** Widget backing; when present the input has a value unless connected. */
  readonly widget?: WidgetSpec
  /** A field shown as a pin until the user converts it (declared `pin_first`). */
  readonly forceInput?: boolean
  /** A field with no input pin (declared `pin=False`); values and output taps are unchanged. */
  readonly socketless?: boolean
  /** Backend computation-semantic demand marker (wire 16); true or omitted. */
  readonly lazy?: true
  /** Execution binding for a staged Comfy source filename (wire 22). */
  readonly sourceFilename?: SourceFilenameSpec
  /** Stored and executed, never shown. */
  readonly hidden?: true
  /** Steps the host applies together with the user's own change of this field; kept as declared. */
  readonly onEdit?: readonly StepSpec[]
  /**
   * Set by elaboration, never declared: the flattened id of the field drawn
   * before this one on a line of several fields.
   */
  readonly adjacentTo?: string
}

export interface SourceFilenameSpec {
  readonly kind: 'media/image' | 'media/audio' | 'media/video' | 'data/latent' | 'media/model3d'
  readonly category: 'input' | 'output' | 'temp'
}

/** The effective absence policy: the declaration, or the required-ness
 * default (skip for required inputs, omit for optional ones). */
export const effectiveAbsentPolicy = (spec: InputSpec): AbsentPolicy =>
  spec.onAbsent ?? (spec.optional ? 'omit' : 'skip')

/** One selected asset that can estimate an output before execution. */
export interface OutputRepresents {
  /** Top-level asset-widget input carrying the selected asset. */
  readonly input: string
  /** Client-side conversion from the selected asset to the output. */
  readonly rendition: string
  /** Required choice selections for which the representation is sound. */
  readonly applies?: Readonly<Record<string, readonly string[]>>
}

/** True when this frontend can render the declared output rendition. */
export const supportsOutputRepresentation = (
  represents: OutputRepresents | undefined,
): represents is OutputRepresents => represents?.rendition === 'decoded-image'

/** An output equal to one same-typed primitive input before execution. */
export interface OutputKnownValue {
  /** Top-level input whose resolved value is the output value. */
  readonly input: string
}

/** An output pin. Inside a group member or an option it exists only with it. */
export interface OutputSpec extends PortSpecBase {
  readonly kind: 'output'
  readonly type: TypeExpr
  /** Set by elaboration, never declared: its `visible` is false. Still part of the run. */
  readonly hidden?: true
  readonly isList?: boolean
  /**
   * Presentation/discovery-only marker: this final output is offered as a
   * generic run-and-show candidate. It does not promise renderability,
   * retention, caching, liveness, editability, purity, preference, or any
   * runtime preview capability. Wire 16 normalizes this to true or omission.
   */
  readonly preview?: true
  /**
   * The producer may deliberately emit NO value at runtime (a loader with no
   * VAE, a detector with no match). Declared, so edges from it render
   * maybe-absent and validation warns when it feeds a fail-policy input.
   * Skipped is a normal downstream state, never an error.
   */
  readonly optional?: boolean
  /** Presentation-only pre-execution estimate sourced from a selected asset. */
  readonly represents?: OutputRepresents
  /** Exact pre-execution value sourced from a typed primitive identity input. */
  readonly knownValue?: OutputKnownValue
}

/** A stored value with no pin and no field, written by an editor or an action. */
export interface StateSpec {
  readonly kind: 'state'
  readonly id: string
  readonly type: TypeExpr
  readonly default?: unknown
  /** False: kept with the workflow, never sent to a run, in no cache key. */
  readonly partOfRun: boolean
}

/** A titled box that opens and closes. Layout only: it opens no scope. */
export interface SectionSpec {
  readonly kind: 'section'
  /** Unique among the sections of its scope; elaborated sections carry the flattened id. */
  readonly id: string
  readonly displayName?: Formulated<string>
  readonly tooltip?: Formulated<string>
  readonly visible?: Formulated<boolean>
  /** A section under a choice's option may place the choice's shared rows by `Use`. */
  readonly rows: readonly OptionRow[]
  readonly collapsedByDefault?: boolean
  /** False: the open box shows no name, only a small tab that closes it. */
  readonly openName?: false
}

/** Two to four fields, buttons or notes side by side. Layout only: it opens no scope. */
export interface RowSpec {
  readonly kind: 'row'
  readonly rows: readonly (InputSpec | ButtonSpec | NoteSpec)[]
}

/**
 * A widget with no value of its own, on a line of its own. Layout: it is not
 * stored, run or drawn by the editor yet; its widget names the rows it writes
 * and reads.
 */
export interface EditorSpec {
  readonly kind: 'editor'
  readonly id: string
  readonly widget: WidgetSpec
  readonly visible?: Formulated<boolean>
}

/** Read-only text, usually a formula. */
export interface NoteSpec {
  readonly kind: 'note'
  readonly id: string
  readonly text: Looked<string>
  /** What the note shows while its formula is unknown. */
  readonly unknown?: string
  readonly visible?: Formulated<boolean>
}

/** Runs an action. The editor draws it and does not run its steps. */
export interface ButtonSpec {
  readonly kind: 'button'
  readonly id: string
  readonly label: string
  readonly tooltip?: Formulated<string>
  readonly visible?: Formulated<boolean>
  readonly steps: readonly StepSpec[]
  readonly enabled?: Formulated<boolean>
  readonly disabledReason?: Formulated<string>
  /** A lucide icon name from the engine's list. */
  readonly icon?: string
}

/** How a group's members are named: the middle part of each flattened id. */
export type GroupKeysSpec =
  | { readonly kind: 'numbered'; readonly prefix: string; readonly start: number; readonly pad: number }
  | { readonly kind: 'named'; readonly names: readonly string[] }

/**
 * How a group grows: when something is plugged into its spare member, when a
 * field of the spare member is filled, from an add button, to match a count
 * formula over stored values, or with a list-valued field (not flattened yet).
 */
export type GroupGrowsSpec =
  | 'link'
  | 'filled'
  | 'button'
  | { readonly count: string }
  | { readonly followList: string }

/**
 * On a construct a subgraph node shows whole: what each name its formulas
 * read outside the construct means on that node. The formulas keep the inner
 * node's scope; a name the subgraph also shows reads that row of the subgraph
 * node, and any other name reads the definition's fixed value.
 */
export interface OuterScope {
  /** The inner node's scopes around the construct, outermost first, each with what its names mean. */
  readonly frames: readonly { readonly rows: readonly OptionRow[]; readonly names: Readonly<Record<string, OuterName>> }[]
}

export type OuterName =
  | { readonly row: string }
  | { readonly value: unknown; readonly linked?: true }

/** A box that repeats its member rows. */
export interface GroupSpec {
  readonly kind: 'group'
  readonly id: string
  readonly displayName?: Formulated<string>
  readonly tooltip?: Formulated<string>
  readonly visible?: Formulated<boolean>
  /** A group of values: one input or output per member, flattened `<group>.<key>`. */
  readonly value?: InputSpec | OutputSpec
  /** A group of records: these rows per member, flattened `<group>.<key>.<row>`. */
  readonly member?: readonly BodyRow[]
  readonly keys: GroupKeysSpec
  readonly grows: GroupGrowsSpec
  readonly minMembers: number
  readonly maxMembers?: number
  /** A type variable used in a member's rows belongs to that member alone. */
  readonly independentTypes?: true
  /** A member row's own `required` holds for the first `minMembers` members only. */
  readonly optionalAfterMinimum?: true
  readonly reorderable?: true
  readonly addLabel?: string
  readonly memberLabel?: Formulated<string>
  readonly openName?: false
  /** On a subgraph node: how many members the definition holds before this node's own. */
  readonly interiorMembers?: number
  readonly outer?: OuterScope
}

/** One option of a choice: its key and the rows it holds. */
export interface OptionSpec {
  readonly key: string
  readonly label?: string
  readonly rows: readonly OptionRow[]
}

/** A shared row of a choice, placed under one option with that place's overrides. */
export interface UseSpec {
  readonly kind: 'use'
  readonly id: string
  readonly displayName?: string
  readonly tooltip?: string
  /** `null` removes the shared row's widget in this place. */
  readonly widget?: WidgetSpec | null
  readonly default?: unknown
  readonly required?: boolean
  /** For a shared choice: which of its option keys are offered here. */
  readonly only?: readonly string[]
  /** For a shared choice: overrides of rows inside it, by id. */
  readonly inside?: readonly UseSpec[]
}

export type OptionRow = BodyRow | UseSpec

/** A dropdown or a boolean that leads, and the rows each option holds. */
export interface ChoiceSpec {
  readonly kind: 'choice'
  readonly id: string
  readonly displayName?: Formulated<string>
  readonly tooltip?: Formulated<string>
  readonly visible?: Formulated<boolean>
  readonly options: readonly OptionSpec[]
  /** Rows more than one option uses, declared once and named by `UseSpec`. */
  readonly shared: readonly BodyRow[]
  /** In place of a dropdown: a formula over stored values and link state that gives the key. */
  readonly leader?: string
  /** The option a new node starts on. */
  readonly default?: string
  /** False: "none" may be chosen, and then no row exists. */
  readonly required: boolean
  readonly hidden?: true
  readonly onEdit?: readonly StepSpec[]
  readonly outer?: OuterScope
}

/** One variant of a type choice: the type plugged in and the rows it reveals. */
export interface VariantSpec {
  readonly key: string
  readonly type: TypeExpr
  readonly rows: readonly BodyRow[]
  readonly tooltip?: string
}

/** A choice led by the type plugged into its pin. */
export interface TypeChoiceSpec {
  readonly kind: 'typeChoice'
  readonly id: string
  readonly displayName?: Formulated<string>
  readonly tooltip?: Formulated<string>
  readonly visible?: Formulated<boolean>
  /** Closed variants; absent for an open slot of `type`. */
  readonly variants?: readonly VariantSpec[]
  readonly type?: TypeExpr
  /** Rows every variant has. */
  readonly rows: readonly BodyRow[]
  readonly required: boolean
  /** Node-level type variable bound by the chosen variant. */
  readonly typeVariable?: string
  /** On a subgraph node that shows it whole: the variant the definition picks, used while the node stores none. */
  readonly default?: string
  readonly outer?: OuterScope
}

/** Rows listed by a stored description, stored under the row's own id. */
export interface DescribedSpec {
  readonly kind: 'described'
  readonly id: string
  readonly displayName?: Formulated<string>
  readonly tooltip?: Formulated<string>
  readonly visible?: Formulated<boolean>
  /** The rows an entry may be; an entry names one by id. */
  readonly kinds: readonly (InputSpec | OutputSpec)[]
  readonly minEntries: number
  readonly maxEntries: number
  readonly fixedIds: boolean
  readonly probe?: { readonly input: string; readonly kind: 'model'; readonly revision: string }
  /** The description a node starts with while it stores none of its own. */
  readonly default?: unknown
  readonly outer?: OuterScope
}

export type BodyRow =
  | InputSpec
  | OutputSpec
  | StateSpec
  | SectionSpec
  | RowSpec
  | NoteSpec
  | EditorSpec
  | ButtonSpec
  | GroupSpec
  | ChoiceSpec
  | TypeChoiceSpec
  | DescribedSpec

/** The rows of one scope with the rows of its sections and lines in their place. */
export function scopeRowsOf(rows: readonly OptionRow[]): readonly OptionRow[] {
  const found: OptionRow[] = []
  const visit = (items: readonly OptionRow[]): void => {
    for (const row of items) {
      if (row.kind === 'section' || row.kind === 'row') visit(row.rows)
      else found.push(row)
    }
  }
  visit(rows)
  return found
}

// ---------------------------------------------------------------------------
// NodeSchema
// ---------------------------------------------------------------------------

/**
 * Structured deprecation (Dinkster schema wire v3 additive field). `message` is
 * required author prose; `replacement` is a cheap NAME-ONLY pointer to the
 * successor type, never an executable migration. Pointers may CHAIN (A -> B -> C when B is
 * itself deprecated); resolve transitively with `resolveDeprecationPointer`,
 * never by a single hop.
 */
export interface DeprecationInfo {
  readonly message: string
  readonly since?: string
  readonly replacement?: string
}

/**
 * Search-listing demotion, fully orthogonal to deprecation and to validity:
 * any visibility validates, instantiates, and executes identically.
 * 'deprecated' = listed but demoted; 'hidden' = not listed at all (loading
 * old workflows still works). Omitted = normal.
 */
export type SearchVisibility = 'deprecated' | 'hidden'

export type PackAssetSource =
  | { readonly type: 'packaged'; readonly pack: string; readonly path: string }
  | { readonly type: 'remote'; readonly url: string }

/** Descriptor for immutable bytes declared by a pack; never the bytes themselves. */
export interface PackAssetDescriptor {
  readonly id: string
  readonly name: string
  /** Usually blake3:<64 hex>; kept prefix-tolerant for rolling digest upgrades. */
  readonly digest: string
  readonly kind?: string
  readonly size?: number
  readonly mediaType?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly sources?: readonly PackAssetSource[]
  /** Node types whose instantiation makes this asset a job requirement. */
  readonly nodes?: readonly string[]
}

/**
 * Pack presentation (Dinkster /api/nodes top-level "packs" table): author-
 * declared display identity for compact provenance badges. abbr/mark are
 * NOT identity and may collide across packs; the pack ID is the only
 * lookup key. All fields beyond displayName are optional - omission means
 * "not declared", and the backend never synthesizes fallbacks (deriving
 * initials/colors is a frontend concern). Presentation only: excluded
 * from schema signatures and cache identity on both ends.
 */
export interface PackInfo {
  readonly displayName: string
  /** Short ASCII (<= 8) for search/tooltips. */
  readonly abbr?: string
  /** Single-grapheme badge glyph (emoji allowed). */
  readonly mark?: string
  /** #rrggbb chip color. */
  readonly color?: string
  /**
   * Raster chip icon (64x64 static PNG/WebP), served at
   * GET /api/packs/{packId}/icon. The digest is the immutable content
   * identity (also the endpoint's ETag): bytes for a digest never change,
   * so decoded bitmaps cache forever. Presence here is the ONLY fetch
   * signal - never probe the endpoint blindly.
   */
  readonly icon?: PackIcon
  /**
   * Provenance (environment stamping): all omitted-when-unknown, never
   * null. version appears only for registry releases - unpublished
   * local/git installs have no release identity and the backend never
   * surfaces a fake pin. artifactDigest ('sha256:<hex>') is the real pin
   * for managed installs; source is 'registry' | 'git:<url>@<commit>' |
   * 'local:<path>'; publisher is 'local' for unpublished installs.
   * Records, never identity: nothing load-bearing reads these.
   */
  readonly version?: string
  readonly artifactDigest?: string
  readonly source?: string
  readonly publisher?: string
  /** Pack asset declarations, descriptors only; absent means none declared. */
  readonly assets?: readonly PackAssetDescriptor[]
  /**
   * Pack-shipped blueprints (premade subgraph documents): full descriptors
   * inline so search/browse never fetches bodies. The body rides
   * GET /api/packs/{packId}/blueprints/{id} (immutable, digest ETag).
   * Absent when the pack ships none.
   */
  readonly blueprints?: readonly PackBlueprintDescriptor[]
  /** Immutable pack locale catalogs: canonical locale tag -> exact content digest. */
  readonly locales?: Readonly<Record<string, string>>
  /** Pack declares a validated settings schema available from the pack settings endpoint. */
  readonly settings?: true
}

/** Descriptor for a pack's chip icon; bytes are fetched lazily by digest. */
export interface PackIcon {
  /** 'sha256:<hex>' content digest; the icon endpoint's ETag. */
  readonly digest: string
  /** 'image/png' | 'image/webp' (sniffed server-side from actual bytes). */
  readonly mediaType: string
}

/**
 * One pack-shipped blueprint, descriptor only - the graph document body is
 * fetched lazily and cached forever by digest (a changed blueprint is a
 * new digest). boundaryInputs/boundaryOutputs are author DECLARATIONS
 * passed through verbatim by the backend (never resolved or cross-checked
 * server-side): treat them as untrusted hints for in:/out: search, never
 * as verified interface truth.
 */
export interface PackBlueprintDescriptor {
  /** Blueprint id within the pack (closed name grammar, backend-validated). */
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly tags?: readonly string[]
  /** 'sha256:<hex>' over the exact body bytes; the body endpoint's ETag. */
  readonly digest: string
  /** Declared boundary input type ids (advisory, verbatim passthrough). */
  readonly boundaryInputs?: readonly string[]
  /** Declared boundary output type ids (advisory, verbatim passthrough). */
  readonly boundaryOutputs?: readonly string[]
}

/**
 * A Switch the server routes itself: the `input` row picks one member of the
 * group of inputs `group`, and the node's one output passes it on. A stored
 * pick is a member key; a key that is no longer a member, or no pick, picks
 * the first member. A whole number is a position counting from 0, and a
 * boolean picks between exactly two members, false first. Submission carries
 * the full graph for server-owned lowering.
 */
export interface NodeSelectorSpec {
  readonly input: string
  readonly group: string
}

/**
 * The member input id a pick names among `members` (flattened ids, in stored
 * order), or undefined when the pick is not one the server accepts.
 */
export const selectedMember = (
  selector: NodeSelectorSpec,
  members: readonly string[],
  pick: unknown,
): string | undefined => {
  if (members.length === 0) return undefined
  if (pick === undefined || pick === null) return members[0]
  if (typeof pick === 'string') {
    const member = `${selector.group}.${pick}`
    return members.includes(member) ? member : members[0]
  }
  if (typeof pick === 'boolean') return members.length === 2 ? members[Number(pick)] : undefined
  if (typeof pick === 'number' && Number.isInteger(pick)) return members[pick]
  return undefined
}

export type SelectorBranchDisplay = 'active' | 'inactive' | 'neutral'

export type ExecutionArm = 'native' | 'comfyui'

export type MirrorKind = 'expression' | 'glsl'

export type MirrorPrecision = 'exact' | 'bounded'

/** Declared accuracy bounds for a bounded mirror; at least one bound is present. */
export interface MirrorTolerance {
  readonly relative?: number
  readonly perChannel?: number
}

/**
 * Backend-declared recipe for locally recomputing a node's output for
 * display (wire 29). Presentation only: never part of interface signatures,
 * and the backend never executes it - the frontend may evaluate it to show
 * an estimate while the authoritative backend result is pending. An
 * 'expression' mirror names the shared expression grammar version and
 * carries no source; a 'glsl' mirror carries its shader source. 'exact'
 * mirrors reproduce the backend bit-for-bit and carry no tolerance;
 * 'bounded' mirrors declare their tolerance.
 */
export interface MirrorSpec {
  readonly kind: MirrorKind
  readonly precision: MirrorPrecision
  readonly tolerance?: MirrorTolerance
  readonly grammarVersion?: number
  readonly source?: string
  /**
   * Combo values the mirror covers (wire 30): each key names a declared
   * combo input and maps to the option keys the mirror can reproduce. An
   * estimate renders only when every named combo's resident value is in
   * its covered set - a mirror has no abstain channel of its own, so this
   * scope is what keeps a partially mirrorable node from producing wrong
   * estimates rather than missing ones. Absent means the mirror covers
   * the node's whole input space.
   */
  readonly applies?: Readonly<Record<string, readonly string[]>>
}

export interface NodeSchema {
  /** Node type id ('KSampler') or subgraph-derived id ('#<GraphDefId>'). */
  readonly type: string
  /** Frontend-owned node kind that is never sent to an execution backend. */
  readonly virtual?: true
  readonly displayName: string
  readonly category: string
  /** Backend-declared role used to bind rich editors without node-type knowledge. */
  readonly editorRole?: string
  /**
   * Owning pack id, host-attached by the backend at schema collection
   * (never self-claimed by the schema): 'core' for Dinkster std nodes, the
   * pack's id otherwise. Absent on non-Dinkster sources (ComfyUI V1,
   * subgraph-derived). Presentation/attribution only - never identity.
   */
  readonly pack?: string
  /**
   * Backend-computed content hash of the node's computational interface
   * (Dinkster native only; presentation/lifecycle/admission hints excluded -
   * same exclusions as cache identity). Opaque: compared for equality
   * only, never parsed. The precise drift key for environment stamps: a
   * pack version can change while a node's signature stays identical
   * (interface unchanged), or a dev pack's signature can change with no
   * version bump.
   */
  readonly signature?: string
  /** User-facing execution implementations available for this node type. */
  readonly executionArms?: readonly ExecutionArm[]
  /** Host-declared refusal; absent means no node-wide execution restriction. */
  readonly unavailableReason?: string
  /** Host-declared process affinity; opaque process keys are only compared for equality. */
  readonly residentAffinity?: {
    readonly types: readonly string[]
    readonly routes: readonly { readonly process: string; readonly pack: string; readonly worker: string; readonly unplaced?: boolean; readonly provider?: string }[]
  }
  readonly description?: string
  readonly source: SchemaSource
  /** The node body: ordered rows, some of them boxes holding more rows. */
  readonly body: readonly BodyRow[]
  /** Constants formulas may name. */
  readonly tables?: Readonly<Record<string, unknown>>
  /** Named formulas other formulas may use. */
  readonly derived?: Readonly<Record<string, string>>
  /** Rules about the node as a whole, shown on its title. */
  readonly validate?: readonly RuleSpec[]
  /** Text or a formula after the node's title. */
  readonly titleSuffix?: Formulated<string>
  /** Buttons in the node's menu; drawn and inert, as body buttons are. */
  readonly menu?: readonly ButtonSpec[]
  /** Type authority for explicit occurrence-authored extra input names. Absent means closed. */
  readonly additionalInputs?: TypeExpr
  readonly isOutputNode: boolean
  /**
   * This node's execution emits live previews (sampling previews etc.).
   * Declarative capability from the backend schema (wire 24): gates the
   * per-node Live Previews affordances, and the backend skips preview
   * work entirely for unflagged types. On subgraph-derived schemas, true
   * iff any inner node's schema declares it. Absent means not capable
   * (older backends: absent everywhere, and consumers should keep the
   * affordances available rather than hide them all).
   */
  readonly emitsPreviews?: boolean
  /** Execution may request unsupported runtime graph expansion (wire 46). */
  readonly mayExpandGraph?: boolean
  /** Full help content is available from the paged docs catalog (wire 42). */
  readonly hasDocs?: boolean
  /**
   * Frontend-renderable mirror of this node's computation (wire 29).
   * Presentation only: excluded from interface signatures, never executed
   * by the backend, and absent on nodes without a declared mirror.
   */
  readonly mirror?: MirrorSpec
  readonly chunkSafe?: {
    readonly inputs: readonly string[]
    readonly outputs: readonly string[]
    readonly applies?: Readonly<Record<string, readonly string[]>>
  }
  /** Legacy V1 boolean flag; Dinkster backends use `deprecation` instead. */
  readonly deprecated?: boolean
  /** Structured deprecation (message/since/replacement pointer). */
  readonly deprecation?: DeprecationInfo
  /** Rules shipped by the successor; source node schemas need not be served. */
  readonly replacements?: readonly ReplacementRule[]
  /** Explicit search demotion; omitted = normal. See searchVisibilityOf. */
  readonly searchVisibility?: SearchVisibility
  readonly experimental?: boolean
  readonly searchAliases?: readonly string[]
  /** Frontend-only discoverability vocabulary (wire v8; never resolution or identity). */
  readonly searchTerms?: readonly string[]
  /** Hidden inputs the compiler must inject (V1 wire names preserved). */
  readonly hidden?: readonly string[]
  /** Optional server-owned document-time branch selector (schema wire 15). */
  readonly selector?: NodeSelectorSpec
  readonly ext?: Readonly<Record<string, unknown>>
}

export function schemaForEditorRole(schemas: Iterable<NodeSchema>, role: string): NodeSchema | undefined {
  const matches = [...schemas].filter((schema) => schema.editorRole === role)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * Derive display treatment from the STORED pick: the picked member is active
 * and the others inactive. `members` are the node's member input ids in
 * stored order. A pick the server would refuse is neutral: the server remains
 * authoritative for value validation, and the canvas must not guess which
 * branch will run.
 */
export const selectorBranchDisplay = (
  schema: NodeSchema,
  values: Readonly<Record<string, unknown>>,
  members: readonly string[],
): Readonly<Record<string, SelectorBranchDisplay>> | undefined => {
  const selector = schema.selector
  if (selector === undefined) return undefined
  const picked = selectedMember(selector, members, values[selector.input])
  return Object.fromEntries(
    members.map((member) => [member, picked === undefined ? 'neutral' : member === picked ? 'active' : 'inactive']),
  )
}

/**
 * Effective search listing for a schema. Explicit `searchVisibility` wins;
 * otherwise deprecation (structured or legacy boolean) infers a soft
 * demotion. This inference is deliberately FRONTEND-side: the backend never
 * auto-demotes. (The wire omits 'normal', so a deprecated node cannot
 * currently opt back into normal listing - acceptable until someone asks.)
 */
export const searchVisibilityOf = (s: NodeSchema): 'normal' | SearchVisibility =>
  s.searchVisibility ?? (isDeprecated(s) ? 'deprecated' : 'normal')

/** Deprecated via the structured field OR the legacy V1 boolean. */
export const isDeprecated = (s: NodeSchema): boolean =>
  s.deprecation !== undefined || s.deprecated === true

/** The node's own inputs and outputs: its top scope, through sections and lines. */
export const inputsOf = (s: NodeSchema): readonly InputSpec[] =>
  scopeRowsOf(s.body).filter((row): row is InputSpec => row.kind === 'input')
export const outputsOf = (s: NodeSchema): readonly OutputSpec[] =>
  scopeRowsOf(s.body).filter((row): row is OutputSpec => row.kind === 'output')
export const hasPreviewSurface = (s: NodeSchema): boolean =>
  s.emitsPreviews === true || outputsOf(s).some((output) => output.preview === true)

/** Every row of the body at any depth, boxes before the rows they hold. */
export function allRowsOf(rows: readonly OptionRow[]): readonly OptionRow[] {
  const found: OptionRow[] = []
  const visit = (items: readonly OptionRow[]): void => {
    for (const row of items) {
      found.push(row)
      switch (row.kind) {
        case 'section':
        case 'row':
          visit(row.rows)
          break
        case 'group':
          visit(row.value !== undefined ? [row.value] : row.member ?? [])
          break
        case 'choice':
          visit(row.shared)
          for (const option of row.options) visit(option.rows)
          break
        case 'typeChoice':
          visit(row.rows)
          for (const variant of row.variants ?? []) visit(variant.rows)
          break
        case 'described':
          visit(row.kinds)
          break
      }
    }
  }
  visit(rows)
  return found
}

/** An input whose concrete COMBO value is edited by a combo dropdown. */
export const isComboWidgetInput = (spec: InputSpec): boolean =>
  spec.widget?.widgetType === 'COMBO'

export const isAssetWidgetInput = (spec: Pick<InputSpec, 'widget'>): boolean =>
  spec.widget?.widgetType === 'ASSET'

export const isImageAssetInput = (spec: InputSpec): boolean => {
  const type = canonicalTypeIdOf(spec.type)
  return spec.hidden !== true && isAssetWidgetInput(spec) &&
    (type === 'asset<IMAGE>' || type === 'asset<comfy.IMAGE>' ||
      (type === 'ASSET' && spec.widget?.kind === 'media/image'))
}
