/**
 * Decode the current Dinkster schema wire contract.
 *
 * Optional fields are feature flags: their presence enables the corresponding
 * schema capability, and their absence preserves the default behavior. Before
 * public release the contract is revised in place as version 1.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import { isReplacementRule, type ReplacementRule } from '../replace/model.js'
import { allRowsOf, inputsOf, outputsOf, scopeRowsOf } from './model.js'
import { checkBody, formulaTablesOf, isLayoutId, isMemberKey, isOptionKey, isRowId, isVariantKey, MAX_GROUP_MEMBERS } from './body.js'
import { isCanonicalUnsafeInteger } from './numeric-step.js'
import { isComboValue } from './combo-options.js'
import type {
  AbsentPolicy,
  AlphaPolicy,
  DeprecationInfo,
  BodyRow,
  ChoiceSpec,
  DescribedSpec,
  FormulaSpec,
  Formulated,
  GroupGrowsSpec,
  GroupKeysSpec,
  InputSpec,
  LookupSpec,
  Looked,
  MaskPolarity,
  MaskSemantic,
  MirrorSpec,
  MirrorTolerance,
  NodeSelectorSpec,
  NodeSchema,
  OutputKnownValue,
  OutputRepresents,
  OptionRow,
  OutputSpec,
  PackAssetDescriptor,
  PackAssetSource,
  PackBlueprintDescriptor,
  PackIcon,
  PackInfo,
  RowSpec,
  RuleSpec,
  SearchVisibility,
  SourceFilenameSpec,
  StepSpec,
  TextCompletionsSpec,
  TypeExpr,
  UseSpec,
  WidgetDescriptorSpec,
  WidgetRepresentationSpec,
  WidgetSpec,
} from './model.js'

/** The single schema wire contract decoded by this frontend. */
export const DINKSTER_SCHEMA_WIRE_VERSION = 2

/** Widget kinds implied by built-in primitive type ids. */
const PRIMITIVE_WIDGETS: Readonly<Record<string, string>> = {
  INT: 'INT',
  FLOAT: 'FLOAT',
  STRING: 'STRING',
  BOOLEAN: 'BOOLEAN',
}

const ABSENT_POLICIES: ReadonlySet<string> = new Set(['skip', 'accept', 'fail', 'omit'])

interface WireEntry {
  readonly role?: unknown
  readonly id?: unknown
  readonly type?: unknown
  readonly required?: unknown
  readonly default?: unknown
  readonly doc?: unknown
  readonly onAbsent?: unknown
  readonly optional?: unknown
  readonly minMembers?: unknown
  readonly maxMembers?: unknown
  readonly count?: unknown
  readonly widget?: unknown
  /** Per-input display label; empty/absent falls back to the id. */
  readonly displayName?: unknown
  /** dynamicSlot role only: [{key, type, inputs, doc?}]. */
  readonly variants?: unknown
  /** Recursive dynamic-entry fields. */
  readonly template?: unknown
  readonly inputs?: unknown
  readonly options?: unknown
  readonly slotType?: unknown
  readonly typeTemplateId?: unknown
  readonly memberPrefix?: unknown
  readonly memberNames?: unknown
  readonly optionalAfterMinimum?: unknown
  readonly forceInput?: unknown
  readonly socketless?: unknown
  /** Computation-semantic demand marker. */
  readonly lazy?: unknown
  /** Storage-backed execution marker. */
  readonly acceptsStorage?: unknown
  readonly acceptsStream?: unknown
  readonly acceptsList?: unknown
  /** Source-filename execution binding. */
  readonly sourceFilename?: unknown
  /** Presentation/discovery marker. */
  readonly preview?: unknown
  /** Selected-asset output estimate declaration. */
  readonly represents?: unknown
  /** Typed primitive identity output declaration. */
  readonly knownValue?: unknown
  readonly advanced?: unknown
  /** Compatibility-only presentation marker. */
  readonly hidden?: unknown
  /** Execution-affecting media policies. */
  readonly alphaPolicy?: unknown
  readonly maskPolarity?: unknown
  readonly maskSemantic?: unknown
}

const ALPHA_POLICIES: ReadonlySet<string> = new Set(['preserve', 'require', 'create_if_missing', 'drop'])
const MASK_POLARITIES: ReadonlySet<string> = new Set(['coverage', 'transparency'])
const MASK_SEMANTICS: ReadonlySet<string> = new Set(['alpha', 'selection', 'other'])

function acceptsStorageOf(entry: { readonly role?: unknown; readonly acceptsStorage?: unknown }, where: string): Pick<InputSpec, 'acceptsStorage'> {
  if (entry.acceptsStorage === undefined) return {}
  if (entry.role !== 'input') throw new Error(`${where}.acceptsStorage is only valid on ordinary inputs`)
  if (typeof entry.acceptsStorage !== 'boolean') throw new Error(`${where}.acceptsStorage must be a boolean`)
  return entry.acceptsStorage ? { acceptsStorage: true } : {}
}

function acceptsStreamOf(
  entry: { readonly role?: unknown; readonly acceptsStream?: unknown },
  where: string,
): Pick<InputSpec, 'acceptsStream'> {
  if (!Object.hasOwn(entry, 'acceptsStream')) return {}
  if (entry.role !== 'input')
    throw new Error(`${where}.acceptsStream is only valid on ordinary inputs`)
  if (typeof entry.acceptsStream !== 'boolean')
    throw new Error(`${where}.acceptsStream must be a boolean`)
  return entry.acceptsStream ? { acceptsStream: true } : {}
}

function acceptsListOf(
  entry: { readonly role?: unknown; readonly acceptsList?: unknown },
  where: string,
): Pick<InputSpec, 'acceptsList'> {
  if (!Object.hasOwn(entry, 'acceptsList')) return {}
  if (entry.role !== 'input')
    throw new Error(`${where}.acceptsList is only valid on ordinary inputs`)
  if (typeof entry.acceptsList !== 'boolean')
    throw new Error(`${where}.acceptsList must be a boolean`)
  return entry.acceptsList ? { acceptsList: true } : {}
}

function mediaPolicyOf(
  entry: {
    readonly alphaPolicy?: unknown
    readonly maskPolarity?: unknown
    readonly maskSemantic?: unknown
  },
  where: string,
): Pick<InputSpec, 'alphaPolicy' | 'maskPolarity' | 'maskSemantic'> {
  const alphaPolicy = entry['alphaPolicy']
  const maskPolarity = entry['maskPolarity']
  const maskSemantic = entry['maskSemantic']
  if (alphaPolicy !== undefined && (typeof alphaPolicy !== 'string' || !ALPHA_POLICIES.has(alphaPolicy))) {
    throw new Error(`${where}.alphaPolicy must be one of ${[...ALPHA_POLICIES].join(', ')}`)
  }
  if (maskPolarity !== undefined && (typeof maskPolarity !== 'string' || !MASK_POLARITIES.has(maskPolarity))) {
    throw new Error(`${where}.maskPolarity must be one of ${[...MASK_POLARITIES].join(', ')}`)
  }
  if (maskSemantic !== undefined && (typeof maskSemantic !== 'string' || !MASK_SEMANTICS.has(maskSemantic))) {
    throw new Error(`${where}.maskSemantic must be one of ${[...MASK_SEMANTICS].join(', ')}`)
  }
  return {
    ...(alphaPolicy !== undefined ? { alphaPolicy: alphaPolicy as AlphaPolicy } : {}),
    ...(maskPolarity !== undefined ? { maskPolarity: maskPolarity as MaskPolarity } : {}),
    ...(maskSemantic !== undefined ? { maskSemantic: maskSemantic as MaskSemantic } : {}),
  }
}

export interface DinksterWireSchema {
  readonly schemaVersion?: unknown
  readonly nodeType?: unknown
  readonly version?: unknown
  readonly displayName?: unknown
  readonly category?: unknown
  readonly description?: unknown
  readonly editorRole?: unknown
  readonly idempotent?: unknown
  /** Legacy flat entry list; version 2 carries the node body instead and refuses a non-empty list. */
  readonly interface?: unknown
  /** The node body tree (engine `body_row_to_wire`). */
  readonly body?: unknown
  readonly tables?: unknown
  readonly derived?: unknown
  readonly validate?: unknown
  readonly titleSuffix?: unknown
  readonly menu?: unknown
  readonly additionalInputs?: unknown
  readonly occupies?: unknown
  readonly ioBound?: unknown
  readonly deprecation?: unknown
  readonly replacements?: unknown
  readonly searchVisibility?: unknown
  readonly searchTerms?: unknown
  /** Optional document-time branch selector. */
  readonly selector?: unknown
  /** Host-attached pack attribution (not part of the schema wire proper). */
  readonly pack?: unknown
  /** Interface signature (always present on backends serving env stamping). */
  readonly signature?: unknown
  /** Host-normalized execution implementations (not worker lane names). */
  readonly executionArms?: unknown
  readonly residentAffinity?: unknown
  readonly unavailableReason?: unknown
  /** Explicit default-target hint (true only, omitted when false). */
  readonly outputNode?: unknown
  /** Live-preview capability flag (true only, omitted when false). */
  readonly emitsPreviews?: unknown
  /** Runtime graph-expansion capability flag (true only, omitted when false). */
  readonly mayExpandGraph?: unknown
  /** Full help page availability flag (true only, omitted when false). */
  readonly hasDocs?: unknown
  readonly widgetGroups?: unknown
  /** Frontend-renderable mirror declaration (presentation only). */
  readonly mirror?: unknown
  readonly chunkSafe?: unknown
}

function decodeWireSelector(wire: unknown, inputs: ReadonlyMap<string, InputSpec>, outputs: readonly OutputSpec[]): NodeSelectorSpec | undefined {
  if (wire === undefined) return undefined
  const selector = wireObject(wire, 'selector')
  const selectorKeys = Object.keys(selector).sort()
  if (selectorKeys.length !== 2 || selectorKeys[0] !== 'branches' || selectorKeys[1] !== 'input') {
    throw new Error('selector must contain exactly input and branches')
  }
  if (typeof selector['input'] !== 'string') throw new Error('selector.input must be a string')
  const input = selector['input']
  const selectorInput = inputs.get(input)
  if (selectorInput === undefined) throw new Error(`selector.input names unknown input '${input}'`)
  if (JSON.stringify(selectorInput.type) !== JSON.stringify({ kind: 'concrete', name: 'BOOLEAN' })) {
    throw new Error('selector.input must have type BOOLEAN')
  }

  const branches = wireObject(selector['branches'], 'selector.branches')
  const branchKeys = Object.keys(branches).sort()
  if (branchKeys.length !== 2 || branchKeys[0] !== 'false' || branchKeys[1] !== 'true') {
    throw new Error('selector.branches must contain exactly false and true')
  }
  if (typeof branches['false'] !== 'string' || typeof branches['true'] !== 'string') {
    throw new Error('selector branch input ids must be strings')
  }
  const falseInput = branches['false']
  const trueInput = branches['true']
  if (falseInput === trueInput) throw new Error('selector branch input ids must be distinct')
  if (input === falseInput || input === trueInput) {
    throw new Error('selector.input must be distinct from both branch input ids')
  }
  const falseSpec = inputs.get(falseInput)
  const trueSpec = inputs.get(trueInput)
  if (falseSpec === undefined) throw new Error(`selector false branch names unknown input '${falseInput}'`)
  if (trueSpec === undefined) throw new Error(`selector true branch names unknown input '${trueInput}'`)
  if (outputs.length !== 1) throw new Error('selector-bearing schema must declare exactly one output')
  const outputType = JSON.stringify(outputs[0]!.type)
  if (JSON.stringify(falseSpec.type) !== outputType || JSON.stringify(trueSpec.type) !== outputType) {
    throw new Error('selector branch inputs must share the sole output type')
  }
  return { input, branches: { false: falseInput, true: trueInput } }
}

export interface DinksterNodesPayload {
  readonly schemaVersion?: unknown
  readonly nodes?: unknown
  /** Immutable frontend/backend extension generation paired with this table. */
  readonly extensionSnapshotDigest?: unknown
  /** packId -> presentation table (additive; absent on older backends). */
  readonly packs?: unknown
  /** Server identity header {version, schemaWire} (additive; absent on older backends). */
  readonly dinkster?: unknown
  /**
   * Schema surface generation, monotonic per engine process (additive;
   * absent on older backends). Distinct from schemaVersion (wire format).
   */
  readonly epoch?: unknown
  /**
   * Present (true) exactly while the backend is still announcing packs:
   * this table is real but not final. Omitted once composed - never false.
   */
  readonly composing?: unknown
}

// ---------------------------------------------------------------------------
// TypeExpr
// ---------------------------------------------------------------------------

/**
 * Decode a wire TypeExpr. Throws on malformed shapes; the per-node wrapper
 * turns that into a diagnostic + dropped node (the backend decoder raises on
 * unknown kinds too - strict beats silently-wrong on an unstable wire).
 */
export function typeExprFromDinksterWire(wire: unknown): TypeExpr {
  if (typeof wire !== 'object' || wire === null) throw new Error('type expression must be an object')
  const w = wire as {
    kind?: unknown
    types?: unknown
    templateId?: unknown
    element?: unknown
    elements?: unknown
    input?: unknown
    index?: unknown
  }
  const types: string[] = Array.isArray(w.types) ? w.types.map((t) => String(t)) : []
  if (types.some((type) => type.startsWith('stream<'))) throw new Error('stream type requires a structured constructor')
  switch (w.kind) {
    case 'concrete': {
      if (types.length !== 1) throw new Error(`concrete type carries ${types.length} names, expected exactly 1`)
      return { kind: 'concrete', name: types[0]! }
    }
    case 'union': {
      if (types.length < 2) throw new Error('union type requires at least two names')
      return { kind: 'union', names: types }
    }
    case 'wildcard':
      return { kind: 'wildcard' }
    case 'variable': {
      const templateId = typeof w.templateId === 'string' ? w.templateId : ''
      if (templateId === '') throw new Error('variable type requires a templateId')
      return {
        kind: 'variable',
        templateId,
        ...(types.length > 0
          ? {
              allowedTypes: types.map((name): TypeExpr => ({ kind: 'concrete', name })),
            }
          : {}),
      }
    }
    case 'list':
    case 'asset':
    case 'stream':
      return { kind: w.kind, element: typeExprFromDinksterWire(w.element) }
    case 'tuple':
    case 'tuple_element':
      return wireType(wire, 'type')
    default:
      throw new Error(`unknown type expression kind: ${String(w.kind)}`)
  }
}

// ---------------------------------------------------------------------------
// Interface entries
// ---------------------------------------------------------------------------

/**
 * Decode explicit presentation first, then preserve primitive inference when
 * a descriptor is absent or not understood.
 */
const ASSET_KIND = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)+$/

const NUMBER_DISPLAY_MODES: ReadonlySet<string> = new Set(['number', 'slider', 'knob', 'gradientslider', 'color'])

const WIDGET_REPRESENTATION_ID = /^[A-Za-z0-9_-]+$/

function checkWidgetFields(descriptor: Record<string, unknown>, allowed: readonly string[], where: string, diags?: Diagnostic[]): void {
  const unknown = Object.keys(descriptor)
    .filter((key) => !allowed.includes(key))
    .sort()
  if (diags === undefined) {
    if (unknown.length > 0) throw new Error(`${where} has unknown fields: ${unknown.join(', ')}`)
    return
  }
  for (const field of unknown) {
    diags.push(diag('warning', 'schema', 'schema.widget.unknownField', `${where}: unknown field '${field}'`))
  }
}

function comboOptionFields(option: unknown): unknown {
  if (typeof option !== 'object' || option === null) return option
  return Object.fromEntries(Object.entries(option).filter(([key]) => ['value', 'label', 'info', 'folder'].includes(key)))
}

function validateComboOption(value: unknown, where: string, diags: Diagnostic[], scalar = false): void {
  const validValue = (candidate: unknown) => scalar ? isComboValue(candidate) : typeof candidate === 'string' && candidate !== ''
  if (validValue(value)) return
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be ${scalar ? 'a finite JSON scalar' : 'a non-empty string'} or structured choice`)
  }
  const option = value as Record<string, unknown>
  checkWidgetFields(option, ['value', 'label', 'info', 'folder'], where, diags)
  if (!validValue(option['value'])) {
    throw new Error(`${where}.value must be ${scalar ? 'a finite JSON scalar' : 'a non-empty string'}`)
  }
  for (const field of ['label', 'info'] as const) {
    if (option[field] !== undefined && (typeof option[field] !== 'string' || option[field] === '')) {
      throw new Error(`${where}.${field} must be a non-empty string`)
    }
  }
  if (option['folder'] !== undefined) {
    if (typeof option['folder'] !== 'string' || option['folder'] === '' || option['folder'].includes('\\')) {
      throw new Error(`${where}.folder must be a relative /-separated path`)
    }
    const segments = option['folder'].split('/')
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`${where}.folder must contain non-empty segments other than '.' or '..'`)
    }
  }
}

function decodeTextCompletions(value: unknown, where: string, diags: Diagnostic[] = []): TextCompletionsSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`)
  }
  const raw = value as Record<string, unknown>
  checkWidgetFields(raw, ['items'], where, diags)
  const rawItems = raw['items'] ?? []
  if (!Array.isArray(rawItems)) throw new Error(`${where}.items must be an array`)
  const items = rawItems.map((value, index) => {
    const itemWhere = `${where}.items[${index}]`
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${itemWhere} must be an object`)
    }
    const item = value as Record<string, unknown>
    checkWidgetFields(item, ['value', 'label', 'insertText', 'detail', 'kind'], itemWhere, diags)
    if (typeof item['value'] !== 'string' || item['value'] === '') {
      throw new Error(`${itemWhere}.value must be a non-empty string`)
    }
    for (const field of ['label', 'insertText', 'detail'] as const) {
      if (item[field] !== undefined && typeof item[field] !== 'string') {
        throw new Error(`${itemWhere}.${field} must be a string`)
      }
    }
    if (item['kind'] !== undefined && item['kind'] !== 'identifier' && item['kind'] !== 'operator') {
      throw new Error(`${itemWhere}.kind must be identifier or operator`)
    }
    const label = item['label']
    const insertText = item['insertText']
    const detail = item['detail']
    const kind = item['kind']
    return {
      value: item['value'],
      label: typeof label === 'string' ? label : item['value'],
      insertText: typeof insertText === 'string' ? insertText : item['value'],
      detail: typeof detail === 'string' ? detail : '',
      kind: kind === 'operator' ? kind : 'identifier',
    } as const
  })
  if (items.length === 0) throw new Error(`${where} must declare items`)
  return { items }
}

function validateStrictWidgetDescriptor(descriptor: Record<string, unknown>, where: string, diags: Diagnostic[]): void {
  switch (descriptor['type']) {
    case 'ASSET':
      checkWidgetFields(descriptor, ['type', 'accept', 'kind', 'allowUpload', 'selection'], where, diags)
      if (!Array.isArray(descriptor['accept']) || !descriptor['accept'].every((value) => typeof value === 'string' && value !== '')) {
        throw new Error(`${where}.accept must be an array of non-empty strings`)
      }
      if (descriptor['kind'] !== undefined && (typeof descriptor['kind'] !== 'string' || (descriptor['kind'] !== '' && !ASSET_KIND.test(descriptor['kind'])))) {
        throw new Error(`${where}.kind must be a valid asset kind`)
      }
      if (descriptor['allowUpload'] !== undefined && typeof descriptor['allowUpload'] !== 'boolean') {
        throw new Error(`${where}.allowUpload must be a boolean`)
      }
      if (descriptor['selection'] !== undefined && typeof descriptor['selection'] !== 'boolean') {
        throw new Error(`${where}.selection must be a boolean`)
      }
      if (descriptor['selection'] === true && (
        !['model/vae', 'model/diffusers', 'directory/input', 'directory/dataset'].includes(String(descriptor['kind'])) ||
        descriptor['allowUpload'] === true
      )) {
        throw new Error(`${where}.selection requires a supported exact kind and forbids upload`)
      }
      return
    case 'COMBO': {
      checkWidgetFields(descriptor, ['type', 'options', 'remote', 'editableOptions'], where, diags)
      if (descriptor['editableOptions'] !== undefined && typeof descriptor['editableOptions'] !== 'boolean') {
        throw new Error(`${where}.editableOptions must be a boolean`)
      }
      if (descriptor['editableOptions'] === true && descriptor['remote'] !== undefined) {
        throw new Error(`${where}.editableOptions cannot have another option source`)
      }
      const options = descriptor['options']
      if (options !== undefined) {
        if (!Array.isArray(options)) throw new Error(`${where}.options must be an array`)
        options.forEach((value, index) => validateComboOption(value, `${where}.options[${index}]`, diags, true))
      }
      const remote = descriptor['remote']
      if (remote !== undefined) {
        if (typeof remote !== 'object' || remote === null || Array.isArray(remote)) {
          throw new Error(`${where}.remote must be an object`)
        }
        const remoteObject = remote as Record<string, unknown>
        checkWidgetFields(remoteObject, ['route', 'refreshButton', 'controlAfterRefresh', 'timeoutMs', 'maxRetries', 'refreshMs'], `${where}.remote`, diags)
        if (typeof remoteObject['route'] !== 'string' || !remoteObject['route'].startsWith('/')) {
          throw new Error(`${where}.remote.route must start with '/'`)
        }
        if (remoteObject['refreshButton'] !== undefined && typeof remoteObject['refreshButton'] !== 'boolean') {
          throw new Error(`${where}.remote.refreshButton must be a boolean`)
        }
      }
      if ((!Array.isArray(options) || options.length === 0) && remote === undefined && descriptor['editableOptions'] !== true) {
        throw new Error(`${where} requires options or remote`)
      }
      return
    }
    case 'MULTI_COMBO': {
      checkWidgetFields(descriptor, ['type', 'options', 'remote', 'placeholder', 'chip'], where, diags)
      const options = descriptor['options']
      if (options !== undefined) {
        if (!Array.isArray(options)) throw new Error(`${where}.options must be an array`)
        options.forEach((value, index) => validateComboOption(value, `${where}.options[${index}]`, diags))
      }
      const remote = descriptor['remote']
      if (remote !== undefined) {
        if (typeof remote !== 'object' || remote === null || Array.isArray(remote)) {
          throw new Error(`${where}.remote must be an object`)
        }
        const r = remote as Record<string, unknown>
        checkWidgetFields(r, ['route', 'refreshButton', 'controlAfterRefresh', 'timeoutMs', 'maxRetries', 'refreshMs'], `${where}.remote`, diags)
        if (typeof r['route'] !== 'string' || !/^\/api\/choices\/[A-Za-z0-9._-]+$/.test(r['route'])) {
          throw new Error(`${where}.remote.route must be /api/choices/{choice_id}`)
        }
        if (r['refreshButton'] !== undefined && typeof r['refreshButton'] !== 'boolean') {
          throw new Error(`${where}.remote.refreshButton must be a boolean`)
        }
      }
      if ((!Array.isArray(options) || options.length === 0) && remote === undefined) {
        throw new Error(`${where} requires options or remote`)
      }
      return
    }
    case 'BOOLEAN':
      checkWidgetFields(descriptor, ['type', 'labelOn', 'labelOff'], where, diags)
      for (const key of ['labelOn', 'labelOff']) {
        if (descriptor[key] !== undefined && typeof descriptor[key] !== 'string') {
          throw new Error(`${where}.${key} must be a string`)
        }
      }
      if (!descriptor['labelOn'] && !descriptor['labelOff']) {
        throw new Error(`${where} requires at least one custom label`)
      }
      return
    case 'NUMBER':
      checkWidgetFields(descriptor, ['type', 'min', 'max', 'step', 'display', 'round'], where, diags)
      for (const key of ['min', 'max', 'step']) {
        const value = descriptor[key]
        const finiteNumber = typeof value === 'number' && Number.isFinite(value)
        const decimalInteger = isCanonicalUnsafeInteger(value)
        if (value !== undefined && !finiteNumber && !decimalInteger) {
          throw new Error(`${where}.${key} must be a finite number or exact decimal integer`)
        }
      }
      if (descriptor['min'] !== undefined && descriptor['max'] !== undefined) {
        const min = descriptor['min']
        const max = descriptor['max']
        const minInteger = isCanonicalUnsafeInteger(min) ? BigInt(min) : Number.isSafeInteger(min) ? BigInt(min as number) : undefined
        const maxInteger = isCanonicalUnsafeInteger(max) ? BigInt(max) : Number.isSafeInteger(max) ? BigInt(max as number) : undefined
        if (
          (typeof min === 'number' && typeof max === 'number' && min > max) ||
          (minInteger !== undefined && maxInteger !== undefined && minInteger > maxInteger)
        ) {
          throw new Error(`${where}.min must not exceed max`)
        }
      }
      if (
        (typeof descriptor['step'] === 'number' && descriptor['step'] <= 0) ||
        (isCanonicalUnsafeInteger(descriptor['step']) && BigInt(descriptor['step']) <= 0n)
      ) {
        throw new Error(`${where}.step must be positive`)
      }
      if (
        descriptor['round'] !== undefined && descriptor['round'] !== false &&
        (typeof descriptor['round'] !== 'number' || !Number.isFinite(descriptor['round']) || descriptor['round'] <= 0)
      ) {
        throw new Error(`${where}.round must be false or a finite positive number`)
      }
      if (['min', 'max', 'step', 'display', 'round'].every((key) => descriptor[key] === undefined)) {
        throw new Error(`${where} requires a constraint`)
      }
      return
    case 'STRING':
      checkWidgetFields(descriptor, ['type', 'multiline', 'placeholder', 'dynamicPrompts', 'completions'], where, diags)
      if (descriptor['multiline'] !== undefined && typeof descriptor['multiline'] !== 'boolean') {
        throw new Error(`${where}.multiline must be a boolean`)
      }
      if (descriptor['dynamicPrompts'] !== undefined && typeof descriptor['dynamicPrompts'] !== 'boolean') {
        throw new Error(`${where}.dynamicPrompts must be a boolean`)
      }
      if (descriptor['completions'] !== undefined) decodeTextCompletions(descriptor['completions'], `${where}.completions`, diags)
      if (
        descriptor['multiline'] === undefined &&
        descriptor['placeholder'] === undefined &&
        descriptor['dynamicPrompts'] === undefined &&
        descriptor['completions'] === undefined
      )
        throw new Error(`${where} requires a presentation field`)
      return
    case 'COLOR':
    case 'MOUNT':
      checkWidgetFields(descriptor, ['type'], where, diags)
      return
    case 'CURVE':
      checkWidgetFields(descriptor, ['type'], where, diags)
      return
    case 'COMPOSITOR':
      checkWidgetFields(descriptor, ['type', 'writes', 'reads'], where, diags)
      editorNamesOf(descriptor, where)
      return
    default:
      if (typeof descriptor['type'] !== 'string' || descriptor['type'] === '') {
        throw new Error(`${where}.type must be a non-empty string`)
      }
      editorNamesOf(descriptor, where)
      for (const [key, value] of Object.entries(descriptor)) {
        if (key !== 'type') cloneJsonValue(value, `${where}.${key}`)
      }
      return
  }
}

/**
 * The rows a custom or compositor widget writes and reads: its own part name
 * -> a row id of its scope (the engine checks the ids when the pack loads).
 */
function editorNamesOf(descriptor: Record<string, unknown>, where: string): Pick<WidgetSpec, 'writes' | 'reads'> {
  const names: { writes?: Record<string, string>; reads?: Record<string, string> } = {}
  for (const field of ['writes', 'reads'] as const) {
    if (descriptor[field] === undefined) continue
    const mapping = wireObject(descriptor[field], `${where}.${field}`)
    for (const [part, row] of Object.entries(mapping)) {
      if (part === '' || typeof row !== 'string' || row === '') throw new Error(`${where}.${field}.${part} must name a row`)
    }
    names[field] = mapping as Record<string, string>
  }
  return names
}

function cloneJsonValue(value: unknown, where: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item, index) => cloneJsonValue(item, `${where}[${index}]`))
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = cloneJsonValue(item, `${where}.${key}`)
    }
    return result
  }
  throw new Error(`${where} must be JSON-safe`)
}

function numericWidgetType(type: TypeExpr, forceInput = false): 'INT' | 'FLOAT' | undefined {
  if (type.kind === 'concrete' && (type.name === 'INT' || type.name === 'FLOAT')) return type.name
  if (forceInput && type.kind === 'concrete' && type.name === 'FLOATS') return 'FLOAT'
  if (type.kind === 'union' && type.names.length === 2 && type.names.includes('INT') && type.names.includes('FLOAT')) return 'FLOAT'
  return undefined
}

function validateStrictWidgetBinding(descriptor: Record<string, unknown>, type: TypeExpr, where: string, forceInput = false): void {
  const socket = type.kind === 'concrete' ? type.name : undefined
  switch (descriptor['type']) {
    case 'STRING':
    case 'MOUNT':
      if (socket !== 'STRING') throw new Error(`${where} requires a concrete STRING input`)
      return
    case 'COLOR':
      if (socket !== 'STRING' && socket !== 'COLOR') throw new Error(`${where} requires a concrete COLOR or STRING input`)
      return
    case 'CURVE':
      if (socket !== 'CURVE') throw new Error(`${where} requires a concrete CURVE input`)
      return
    case 'COMPOSITOR':
      if (socket !== 'COMPOSITOR') throw new Error(`${where} requires a concrete COMPOSITOR input`)
      return
    case 'BOOLEAN':
      if (socket !== 'BOOLEAN') throw new Error(`${where} requires a concrete BOOLEAN input`)
      return
    case 'COMBO':
      if (socket !== 'COMBO') throw new Error(`${where} requires a concrete COMBO input`)
      return
    case 'MULTI_COMBO':
      if (type.kind !== 'list' || type.element.kind !== 'concrete' || type.element.name !== 'COMBO') {
        throw new Error(`${where} requires list<COMBO>`)
      }
      return
    case 'NUMBER': {
      const numericKind = numericWidgetType(type, forceInput)
      if (numericKind === undefined) {
        throw new Error(`${where} requires INT, FLOAT, their numeric-only union, or forced FLOATS`)
      }
      if (descriptor['round'] !== undefined && numericKind !== 'FLOAT') {
        throw new Error(`${where}.round requires FLOAT`)
      }
      if (numericKind === 'INT') {
        for (const key of ['min', 'max', 'step']) {
          const value = descriptor[key]
          if (value !== undefined && !Number.isSafeInteger(value) && !isCanonicalUnsafeInteger(value)) {
            throw new Error(`${where}.${key} must be an exact integer on INT`)
          }
        }
      } else if (['min', 'max', 'step'].some((key) => descriptor[key] !== undefined && typeof descriptor[key] !== 'number')) {
        throw new Error(`${where} decimal integer constraints require INT`)
      }
      return
    }
    case 'ASSET':
      if (descriptor['selection'] === true) {
        if (socket === 'COMBO' || (
          descriptor['kind'] === 'model/vae' && type.kind === 'union' &&
          type.names.length === 2 && type.names.includes('COMBO') && type.names.includes('ASSET')
        )) return
        throw new Error(`${where}.selection requires COMBO or the model/vae COMBO/ASSET union`)
      }
      if (type.kind === 'concrete') return
      if (descriptor['allowUpload'] === true && type.kind === 'list' && type.element.kind === 'concrete' && type.element.name === 'ASSET') return
      if (type.kind === 'asset') {
        const isClosed = (candidate: TypeExpr): boolean =>
          candidate.kind === 'concrete' ||
          ((candidate.kind === 'list' || candidate.kind === 'asset' || candidate.kind === 'stream') && isClosed(candidate.element))
        if (isClosed(type.element)) return
      }
      throw new Error(`${where} requires a concrete scalar, ASSET, or fully-concrete asset input`)
    default:
      return
  }
}

function widgetDomain(widget: WidgetDescriptorSpec): string {
  switch (widget.widgetType) {
    case 'ASSET':
      return widget.selection === true ? 'asset-selection' : 'asset'
    case 'COMBO':
      return 'combo'
    case 'BOOLEAN':
      return 'boolean'
    case 'INT':
    case 'FLOAT':
      return 'number'
    case 'STRING':
      return 'string'
    case 'COLOR':
      return 'string'
    case 'CURVE':
      return 'curve'
    case 'COMPOSITOR':
      return 'compositor'
    default:
      return widget.widgetType
  }
}

function widgetFor(
  nodeType: string,
  id: string,
  type: TypeExpr,
  dflt: unknown,
  wire: unknown,
  diags: Diagnostic[],
  representationsAllowed = true,
  forceInput = false,
): WidgetSpec | undefined {
  if (typeof wire === 'object' && wire !== null) {
    const descriptor = wire as {
      type?: unknown
      accept?: unknown
      suffix?: unknown
      kind?: unknown
      allowUpload?: unknown
      selection?: unknown
      options?: unknown
      remote?: unknown
      labelOn?: unknown
      labelOff?: unknown
      editableOptions?: unknown
      min?: unknown
      max?: unknown
      step?: unknown
      display?: unknown
      round?: unknown
      multiline?: unknown
      placeholder?: unknown
      dynamicPrompts?: unknown
      completions?: unknown
      chip?: unknown
    }
    if (descriptor.type === 'REPRESENTATIONS') {
      if (!representationsAllowed) throw new Error(`${nodeType}.${id}: nested widget representations are forbidden`)
      const raw = wire as Record<string, unknown>
      checkWidgetFields(raw, ['type', 'default', 'userSwitchable', 'representations'], `${nodeType}.${id} REPRESENTATIONS widget`, diags)
      if (typeof raw['default'] !== 'string') throw new Error(`${nodeType}.${id}: representation default must be a string`)
      if (typeof raw['userSwitchable'] !== 'boolean') throw new Error(`${nodeType}.${id}: representation userSwitchable must be a boolean`)
      if (!Array.isArray(raw['representations']) || raw['representations'].length === 0) {
        throw new Error(`${nodeType}.${id}: representations must be a non-empty array`)
      }
      const representations: WidgetRepresentationSpec[] = []
      const ids = new Set<string>()
      for (const [index, value] of raw['representations'].entries()) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new Error(`${nodeType}.${id}: representation ${index} must be an object`)
        }
        const representation = value as Record<string, unknown>
        checkWidgetFields(representation, ['id', 'displayName', 'widget'], `${nodeType}.${id} representation ${index}`, diags)
        const representationId = representation['id']
        if (typeof representationId !== 'string' || !WIDGET_REPRESENTATION_ID.test(representationId)) {
          throw new Error(`${nodeType}.${id}: representation ${index} id must match [A-Za-z0-9_-]+`)
        }
        if (ids.has(representationId)) throw new Error(`${nodeType}.${id}: duplicate representation id '${representationId}'`)
        ids.add(representationId)
        const displayName = representation['displayName'] ?? ''
        if (typeof displayName !== 'string') throw new Error(`${nodeType}.${id}: representation ${index} displayName must be a string`)
        if (typeof representation['widget'] !== 'object' || representation['widget'] === null || Array.isArray(representation['widget'])) {
          throw new Error(`${nodeType}.${id}: representation ${index} widget must be an object`)
        }
        const nested = widgetFor(nodeType, id, type, dflt, representation['widget'], diags, false, forceInput)
        if (nested === undefined || nested.representations !== undefined) {
          throw new Error(`${nodeType}.${id}: representation ${index} must contain one widget descriptor`)
        }
        representations.push({
          id: representationId,
          displayName,
          widget: nested,
        })
      }
      if (!ids.has(raw['default'])) throw new Error(`${nodeType}.${id}: representation default must name a declared representation`)
      const domains = new Set(representations.map((representation) => widgetDomain(representation.widget)))
      if (domains.size !== 1) throw new Error(`${nodeType}.${id}: representations must share one canonical value domain`)
      if (domains.has('asset') || domains.has('asset-selection')) {
        const kinds = new Set(representations.map((representation) => representation.widget.kind))
        if (kinds.size !== 1) throw new Error(`${nodeType}.${id}: asset representations must share one asset kind`)
      }
      const defaultWidget = representations.find((representation) => representation.id === raw['default'])!.widget
      return {
        ...defaultWidget,
        representations: {
          default: raw['default'],
          userSwitchable: raw['userSwitchable'],
          representations,
        },
      }
    }
    if (type.kind === 'list' && (descriptor.type === 'STRING' || descriptor.type === 'NUMBER')) {
      if (type.element.kind !== 'concrete') throw new Error(`${nodeType}.${id}: list widget requires a concrete primitive element`)
      // Decode the element through the same scalar binding and precision rules.
      validateStrictWidgetBinding(wire as Record<string, unknown>, type.element, `${nodeType}.${id} widget element`)
      const element = widgetFor(nodeType, id, type.element, undefined, wire, diags, false)
      if (element === undefined) throw new Error(`${nodeType}.${id}: list widget requires a scalar element descriptor`)
      return {
        widgetType: 'LIST',
        options: {},
        element,
        ...(dflt !== undefined ? { default: dflt } : {}),
      }
    }
    validateStrictWidgetDescriptor(wire as Record<string, unknown>, `${nodeType}.${id} widget`, diags)
    validateStrictWidgetBinding(wire as Record<string, unknown>, type, `${nodeType}.${id} widget`, forceInput)
    if (descriptor.type === 'ASSET' && Array.isArray(descriptor.accept) && descriptor.accept.every((v) => typeof v === 'string')) {
      let kind: string | undefined
      if (descriptor.kind !== undefined) {
        if (typeof descriptor.kind === 'string' && ASSET_KIND.test(descriptor.kind)) kind = descriptor.kind
        else if (descriptor.kind === '') kind = undefined
        else {
          diags.push(
            diag('warning', 'schema', 'schema.dinkster.badAssetKind', `${nodeType}.${id}: invalid ASSET kind '${String(descriptor.kind)}'`),
          )
        }
      }
      return {
        widgetType: 'ASSET',
        options: { accept: [...descriptor.accept] },
        ...(kind !== undefined ? { kind } : {}),
        ...(descriptor.allowUpload === true ? { allowUpload: true } : {}),
        ...(descriptor.selection === true ? { selection: true } : {}),
        ...(dflt !== undefined ? { default: dflt } : {}),
      }
    }
    // COMBO supports static options and/or a declarative remote source. Static
    // options render immediately; a successful remote fetch REPLACES them
    // (never merges). At least one of the two must survive validation. A
    // combo with neither source is invalid schema; keep the COMBO
    // socket visible but drop its unusable widget descriptor.
    if (descriptor.type === 'COMBO') {
      if (type.kind !== 'concrete' || type.name !== 'COMBO') {
        diags.push(
          diag('warning', 'schema', 'schema.dinkster.badComboSocket', `${nodeType}.${id}: COMBO descriptor requires a COMBO input`),
        )
        return undefined
      }
      let options: unknown[] | undefined
      if (descriptor.options !== undefined) {
        if (Array.isArray(descriptor.options)) {
          if (descriptor.options.length > 0 || descriptor.editableOptions === true) options = descriptor.options.map(comboOptionFields)
        } else {
          diags.push(diag('warning', 'schema', 'schema.dinkster.badComboOptions', `${nodeType}.${id}: COMBO options are invalid`))
        }
      }
      let remote: WidgetSpec['remote']
      if (descriptor.remote !== undefined) {
        const r = descriptor.remote as Record<string, unknown>
        if (typeof descriptor.remote === 'object' && descriptor.remote !== null && typeof r.route === 'string' && r.route.startsWith('/')) {
          remote = {
            route: r.route,
            ...(r.refreshButton === true ? { refreshButton: true } : {}),
          }
          const policyWarning = (field: string, requirement: string): void => {
            diags.push(
              diag('warning', 'schema', 'schema.dinkster.badComboRemotePolicy', `${nodeType}.${id}: COMBO remote ${field} ${requirement}`),
            )
          }
          if (r.controlAfterRefresh !== undefined) {
            if (r.controlAfterRefresh === 'first' || r.controlAfterRefresh === 'last') {
              if (r.refreshButton === true)
                remote = {
                  ...remote,
                  controlAfterRefresh: r.controlAfterRefresh,
                }
              else policyWarning('controlAfterRefresh', 'requires refreshButton: true')
            } else policyWarning('controlAfterRefresh', "must be 'first' or 'last'")
          }
          for (const [field, lower, upper] of [
            ['timeoutMs', 1, 60_000],
            ['maxRetries', 0, 5],
            ['refreshMs', 0, 86_400_000],
          ] as const) {
            const value = r[field]
            if (value === undefined) continue
            if (typeof value === 'number' && Number.isSafeInteger(value) && value >= lower && value <= upper) {
              remote = { ...remote, [field]: value }
            } else policyWarning(field, `must be an integer in ${lower}..${upper}`)
          }
        } else {
          diags.push(diag('warning', 'schema', 'schema.dinkster.badComboRemote', `${nodeType}.${id}: COMBO remote requires a route starting with '/'`))
        }
      }
      if (options === undefined && remote === undefined && descriptor.editableOptions !== true) {
        diags.push(diag('warning', 'schema', 'schema.dinkster.badCombo', `${nodeType}.${id}: COMBO has no options or option source`))
      } else {
        return {
          widgetType: 'COMBO',
          options: options !== undefined ? { options } : {},
          ...(descriptor.editableOptions === true ? { editableOptions: true as const } : {}),
          ...(remote !== undefined ? { remote } : {}),
          ...(dflt !== undefined ? { default: dflt } : {}),
        }
      }
    }
    if (descriptor.type === 'MULTI_COMBO') {
      if (!Array.isArray(dflt) && dflt !== undefined) throw new Error(`${nodeType}.${id}: MULTI_COMBO default must be string[]`)
      if (Array.isArray(dflt) && !dflt.every((value) => typeof value === 'string')) {
        throw new Error(`${nodeType}.${id}: MULTI_COMBO default must be string[]`)
      }
      const options = Array.isArray(descriptor.options) && descriptor.options.length > 0 ? descriptor.options.map(comboOptionFields) : undefined
      const outOptions: Record<string, unknown> = options ? { options } : {}
      if (descriptor.placeholder !== undefined) {
        if (typeof descriptor.placeholder === 'string') outOptions['placeholder'] = descriptor.placeholder
        else
          diags.push(
            diag('warning', 'schema', 'schema.dinkster.badMultiComboPlaceholder', `${nodeType}.${id}: MULTI_COMBO placeholder must be a string`),
          )
      }
      if (descriptor.chip !== undefined) {
        if (typeof descriptor.chip === 'boolean') outOptions['chip'] = descriptor.chip
        else diags.push(diag('warning', 'schema', 'schema.dinkster.badMultiComboChip', `${nodeType}.${id}: MULTI_COMBO chip must be a boolean`))
      }
      const r = descriptor.remote as Record<string, unknown> | undefined
      let remote: WidgetSpec['remote']
      if (r !== undefined) {
        remote = {
          route: r['route'] as string,
          ...(r['refreshButton'] === true ? { refreshButton: true } : {}),
        }
        const warn = (field: string) =>
          diags.push(
            diag('warning', 'schema', 'schema.dinkster.badMultiComboRemotePolicy', `${nodeType}.${id}: MULTI_COMBO remote ${field} is invalid`),
          )
        if (r['controlAfterRefresh'] !== undefined) {
          if ((r['controlAfterRefresh'] === 'first' || r['controlAfterRefresh'] === 'last') && r['refreshButton'] === true)
            remote = {
              ...remote,
              controlAfterRefresh: r['controlAfterRefresh'],
            }
          else warn('controlAfterRefresh')
        }
        for (const [field, low, high] of [
          ['timeoutMs', 1, 60000],
          ['maxRetries', 0, 5],
          ['refreshMs', 0, 86400000],
        ] as const) {
          const value = r[field]
          if (value === undefined) continue
          if (typeof value === 'number' && Number.isSafeInteger(value) && value >= low && value <= high) remote = { ...remote, [field]: value }
          else warn(field)
        }
      }
      return {
        widgetType: 'MULTI_COMBO',
        options: outOptions,
        ...(remote ? { remote } : {}),
        ...(dflt !== undefined ? { default: dflt } : {}),
      }
    }
    // NUMBER carries presentation constraints on INT/FLOAT inputs.
    // The SOCKET type is authoritative for integer-vs-float rendering and
    // validation (joint pin); the descriptor only carries constraints. Per
    // the BOOLEAN precedent, a malformed FIELD drops alone with a
    // warning and the input keeps a usable numeric widget - presentation
    // metadata never hides an editor. Integer sockets retain unsafe
    // constraints as canonical decimal strings; float sockets remain numbers.
    if (descriptor.type === 'NUMBER') {
      const numericKind = numericWidgetType(type, forceInput)
      if (numericKind !== 'INT' && numericKind !== 'FLOAT') {
        diags.push(
          diag('warning', 'schema', 'schema.dinkster.badNumberSocket', `${nodeType}.${id}: NUMBER descriptor requires a numeric input`),
        )
      } else {
        const isInt = numericKind === 'INT'
        const options: Record<string, unknown> = {}
        for (const key of ['min', 'max', 'step'] as const) {
          const v = descriptor[key]
          if (v === undefined) continue
          const numeric = typeof v === 'number' && Number.isFinite(v)
          const exactInteger = (numeric && Number.isSafeInteger(v)) || isCanonicalUnsafeInteger(v)
          const positiveStep = key !== 'step' || (numeric && v > 0) || (isCanonicalUnsafeInteger(v) && BigInt(v) > 0n)
          if ((isInt ? exactInteger : numeric) && positiveStep) options[key] = v
          else {
            diags.push(
              diag(
                'warning',
                'schema',
                'schema.dinkster.badNumberField',
                `${nodeType}.${id}: ${key} '${String(v)}' is not a valid ${isInt ? 'integer' : 'number'}`,
              ),
            )
          }
        }
        const min = options['min']
        const max = options['max']
        const inverted =
          isInt && min !== undefined && max !== undefined
            ? BigInt(min as number | string) > BigInt(max as number | string)
            : typeof min === 'number' && typeof max === 'number' && min > max
        if (inverted) {
          diags.push(
            diag(
              'warning',
              'schema',
              'schema.dinkster.badNumberRange',
              `${nodeType}.${id}: NUMBER min ${String(options['min'])} exceeds max ${String(options['max'])}`,
            ),
          )
          delete options['min']
          delete options['max']
        }
        if (descriptor.display !== undefined) {
          if (typeof descriptor.display === 'string' && NUMBER_DISPLAY_MODES.has(descriptor.display) &&
            (descriptor.display !== 'color' || numericKind === 'INT')) {
            options['display'] = descriptor.display
          } else {
            diags.push(
              diag(
                'warning',
                'schema',
                'schema.dinkster.badNumberDisplay',
                `${nodeType}.${id}: unknown NUMBER display '${String(descriptor.display)}'`,
              ),
            )
          }
        }
        if (descriptor.round !== undefined) {
          options['round'] = descriptor.round
        }
        return {
          widgetType: numericKind,
          options,
          ...(dflt !== undefined ? { default: dflt } : {}),
        }
      }
    }
    if (descriptor.type === 'STRING') {
      if (type.kind !== 'concrete' || type.name !== 'STRING') {
        diags.push(
          diag('warning', 'schema', 'schema.dinkster.badStringSocket', `${nodeType}.${id}: STRING descriptor requires a string input`),
        )
      } else if (descriptor.multiline === true || descriptor.multiline === false || descriptor.multiline === undefined) {
        const options: Record<string, unknown> = {}
        if (descriptor.multiline !== undefined) options['multiline'] = descriptor.multiline
        if (descriptor.placeholder !== undefined) {
          if (typeof descriptor.placeholder === 'string') options['placeholder'] = descriptor.placeholder
          else
            diags.push(
              diag('warning', 'schema', 'schema.dinkster.badStringPlaceholder', `${nodeType}.${id}: STRING placeholder must be a string`),
            )
        }
        if (descriptor.dynamicPrompts !== undefined) options['dynamicPrompts'] = descriptor.dynamicPrompts
        const textCompletions =
          descriptor.completions === undefined ? undefined : decodeTextCompletions(descriptor.completions, `${nodeType}.${id} widget.completions`)
        return {
          widgetType: 'STRING',
          options,
          ...(textCompletions === undefined ? {} : { textCompletions }),
          ...(dflt !== undefined ? { default: dflt } : {}),
        }
      } else {
        diags.push(
          diag(
            'warning',
            'schema',
            'schema.dinkster.badStringMultiline',
            `${nodeType}.${id}: STRING descriptor without multiline: true; falling back to the single-line widget`,
          ),
        )
      }
    }
    if (descriptor.type === 'COLOR' || descriptor.type === 'MOUNT') {
      return {
        widgetType: descriptor.type,
        options: {},
        ...(dflt !== undefined ? { default: dflt } : {}),
      }
    }
    if (descriptor.type === 'CURVE') {
      return {
        widgetType: 'CURVE',
        options: {},
        ...(dflt !== undefined ? { default: dflt } : {}),
      }
    }
    if (descriptor.type === 'COMPOSITOR') {
      return {
        widgetType: 'COMPOSITOR',
        options: {},
        ...editorNamesOf(wire as Record<string, unknown>, `${nodeType}.${id}.widget`),
        ...(dflt !== undefined ? { default: dflt } : {}),
      }
    }
    // BOOLEAN supports custom toggle labels. A label-less boolean carries no
    // descriptor at all (the BOOLEAN type alone implies the toggle);
    // empty strings are treated as absent per the omitted-when-empty wire
    // convention. A malformed label drops alone, never the widget.
    if (descriptor.type === 'BOOLEAN') {
      const labels: Record<string, string> = {}
      for (const key of ['labelOn', 'labelOff'] as const) {
        const v = descriptor[key]
        if (typeof v === 'string' && v !== '') labels[key] = v
        else if (v !== undefined && v !== '') {
          diags.push(diag('warning', 'schema', 'schema.dinkster.badBooleanLabel', `${nodeType}.${id}: BOOLEAN ${key} must be a string`))
        }
      }
      return {
        widgetType: 'BOOLEAN',
        options: labels,
        ...(dflt !== undefined ? { default: dflt } : {}),
      }
    }
    if (typeof descriptor.type === 'string' && descriptor.type !== '') {
      const options: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(descriptor)) {
        if (key !== 'type' && key !== 'writes' && key !== 'reads') options[key] = cloneJsonValue(value, `${nodeType}.${id}.widget.${key}`)
      }
      return {
        widgetType: descriptor.type,
        options,
        ...editorNamesOf(wire as Record<string, unknown>, `${nodeType}.${id}.widget`),
        ...(dflt !== undefined ? { default: dflt } : {}),
      }
    }
    throw new Error(`${nodeType}.${id}: widget descriptor is incompatible with its input`)
  }
  if (type.kind !== 'concrete') return undefined
  const widgetType = PRIMITIVE_WIDGETS[type.name]
  if (widgetType === undefined) return undefined
  return {
    widgetType,
    options: {},
    ...(dflt !== undefined ? { default: dflt } : {}),
  }
}

function decodeInput(nodeType: string, entry: WireEntry, diags: Diagnostic[], normalizedType?: TypeExpr): InputSpec {
  const id = String(entry.id)
  const type = normalizedType ?? typeExprFromDinksterWire(entry.type)
  const required = entry.required !== false
  let onAbsent: AbsentPolicy | undefined
  if (entry.onAbsent !== undefined) {
    if (typeof entry.onAbsent === 'string' && ABSENT_POLICIES.has(entry.onAbsent)) {
      onAbsent = entry.onAbsent as AbsentPolicy
      if (onAbsent === 'omit' && required) {
        // The backend model rejects this combination at construction; a wire
        // that smuggles it is malformed. Fall back to the required default.
        diags.push(diag('warning', 'schema', 'schema.dinkster.badAbsentPolicy', `${nodeType}.${id}: onAbsent='omit' on a required input; using the default`))
        onAbsent = undefined
      }
    } else {
      diags.push(
        diag('warning', 'schema', 'schema.dinkster.badAbsentPolicy', `${nodeType}.${id}: unknown onAbsent '${String(entry.onAbsent)}'; using the default`),
      )
    }
  }
  const widget = widgetFor(nodeType, id, type, entry.default, entry.widget, diags, true, entry.forceInput === true)
  const representedUpload = widget?.representations?.representations.some((representation) => representation.widget.allowUpload === true) === true
  let sourceFilename: SourceFilenameSpec | undefined
  if (entry.sourceFilename !== undefined) {
    if (typeof entry.sourceFilename !== 'object' || entry.sourceFilename === null || Array.isArray(entry.sourceFilename)) {
      throw new Error(`${nodeType}.${id}.sourceFilename must be an object`)
    }
    const source = entry.sourceFilename as Record<string, unknown>
    checkWidgetFields(source, ['kind', 'category'], `${nodeType}.${id}.sourceFilename`)
    if (
      source['kind'] !== 'media/image' &&
      source['kind'] !== 'media/audio' &&
      source['kind'] !== 'media/video' &&
      source['kind'] !== 'data/latent' &&
      source['kind'] !== 'media/model3d'
    ) {
      throw new Error(`${nodeType}.${id}.sourceFilename.kind is invalid`)
    }
    if (source['category'] !== 'input' && source['category'] !== 'output' && source['category'] !== 'temp') {
      throw new Error(`${nodeType}.${id}.sourceFilename.category is invalid`)
    }
    const isAssetExpr = (t: TypeExpr): boolean => (t.kind === 'concrete' && t.name === 'ASSET') || t.kind === 'asset'
    const scalarAsset = isAssetExpr(type)
    const listedAsset = type.kind === 'list' && isAssetExpr(type.element)
    if (!scalarAsset && !listedAsset) {
      throw new Error(`${nodeType}.${id}.sourceFilename requires an asset-typed input (ASSET, asset<T>, or a list of either)`)
    }
    if (widget?.representations !== undefined || widget?.widgetType !== 'ASSET' || widget.allowUpload !== true || widget.kind !== source['kind']) {
      throw new Error(`${nodeType}.${id}.sourceFilename requires a matching upload-enabled ASSET widget`)
    }
    sourceFilename = { kind: source['kind'], category: source['category'] }
  } else if (widget?.allowUpload === true || representedUpload) {
    throw new Error(`${nodeType}.${id} upload-enabled ASSET widget requires sourceFilename`)
  }
  // Per-input display label; empty is the wire's omitted-when-empty
  // convention, a non-string is smuggled - warn and fall back to the id.
  let displayName: string | undefined
  if (entry.displayName !== undefined && entry.displayName !== '') {
    if (typeof entry.displayName === 'string') displayName = entry.displayName
    else diags.push(diag('warning', 'schema', 'schema.dinkster.badDisplayName', `${nodeType}.${id}: displayName is not a string; using the id`))
  }
  return {
    kind: 'input',
    id,
    type,
    optional: !required,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(onAbsent !== undefined ? { onAbsent } : {}),
    ...(widget !== undefined ? { widget } : {}),
    ...(sourceFilename !== undefined ? { sourceFilename } : {}),
    ...(typeof entry.doc === 'string' && entry.doc !== '' ? { tooltip: entry.doc } : {}),
    // Preserve literal defaults on non-widget inputs even though they have
    // no editing surface, so translation remains lossless.
    ...(widget === undefined && entry.default !== undefined ? { ext: { default: entry.default } } : {}),
  }
}

function decodeOutput(nodeType: string, entry: WireEntry, diags: Diagnostic[], normalizedType?: TypeExpr): OutputSpec {
  const id = String(entry.id)
  const type = normalizedType ?? typeExprFromDinksterWire(entry.type)

  const represents = decodeOutputRepresents(entry.represents)
  const knownValue = decodeOutputKnownValue(entry.knownValue)
  return {
    kind: 'output',
    id,
    type,
    ...(entry.optional === true ? { optional: true } : {}),
    ...(typeof entry.doc === 'string' && entry.doc !== '' ? { tooltip: entry.doc } : {}),
    ...(represents !== undefined ? { represents } : {}),
    ...(knownValue !== undefined ? { knownValue } : {}),
  }
}

function wirePreview(entry: Record<string, unknown>, where: string): { preview?: true } {
  if (entry['preview'] === undefined || entry['preview'] === false) return {}
  if (entry['preview'] !== true) throw new Error(`${where}.preview must be a boolean`)
  return { preview: true }
}

const WIRE_SEGMENT = /^[A-Za-z0-9_-]+$/

function wireObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`)
  }
  return value as Record<string, unknown>
}

function wireSegment(value: unknown, where: string): string {
  if (typeof value !== 'string' || !WIRE_SEGMENT.test(value)) {
    throw new Error(`${where} must match [A-Za-z0-9_-]+`)
  }
  return value
}

function wireBoolean(value: unknown, where: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${where} must be a boolean`)
  return value
}

function wireOptionalString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${where} must be a string`)
  return value
}

function wireBound(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${where} must be a safe non-negative integer`)
  }
  return value
}

function wireJson(value: unknown, where: string): void {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${where} must be JSON`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => wireJson(item, `${where}[${index}]`))
    return
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      wireJson(item, `${where}.${key}`)
    }
    return
  }
  throw new Error(`${where} must be JSON`)
}

function wireType(value: unknown, where: string): TypeExpr {
  const type = wireObject(value, where)
  const stringList = (raw: unknown, field: string, minimum: number): string[] => {
    if (!Array.isArray(raw) || raw.length < minimum || !raw.every((item) => typeof item === 'string' && item !== '')) {
      throw new Error(`${where}.${field} must contain at least ${minimum} non-empty string${minimum === 1 ? '' : 's'}`)
    }
    if (raw.some((item: string) => item.startsWith('stream<'))) throw new Error(`${where} stream type requires a structured constructor`)
    return [...raw] as string[]
  }
  switch (type['kind']) {
    case 'concrete': {
      const types = stringList(type['types'], 'types', 1)
      if (types.length !== 1) throw new Error(`${where}.types must contain exactly one string`)
      return { kind: 'concrete', name: types[0]! }
    }
    case 'union':
      return { kind: 'union', names: stringList(type['types'], 'types', 2) }
    case 'wildcard':
      return { kind: 'wildcard' }
    case 'variable': {
      if (typeof type['templateId'] !== 'string' || type['templateId'] === '') {
        throw new Error(`${where}.templateId must be a non-empty string`)
      }
      if (type['types'] !== undefined) throw new Error(`${where}.types is not a variable field; use allowed`)
      const allowed = type['allowed'] === undefined ? undefined : stringList(type['allowed'], 'allowed', 1)
      return {
        kind: 'variable',
        templateId: type['templateId'],
        ...(allowed !== undefined
          ? {
              allowedTypes: allowed.map((name): TypeExpr => ({ kind: 'concrete', name })),
            }
          : {}),
      }
    }
    case 'list':
    case 'asset':
    case 'stream':
      return {
        kind: type['kind'],
        element: wireType(type['element'], `${where}.element`),
      }
    case 'tuple': {
      if (!Array.isArray(type['elements'])) throw new Error(`${where}.elements must be an array`)
      return { kind: 'tuple', elements: type['elements'].map((element, index) => wireType(element, `${where}.elements[${index}]`)) }
    }
    case 'tuple_element': {
      const input = type['input'] === undefined ? undefined : wireSegment(type['input'], `${where}.input`)
      const element = type['element'] === undefined ? undefined : wireType(type['element'], `${where}.element`)
      if ((input === undefined) === (element === undefined)) throw new Error(`${where} requires exactly one tuple source`)
      const index = type['index']
      if (typeof index !== 'string' && !(typeof index === 'number' && Number.isSafeInteger(index))) throw new Error(`${where}.index must be an integer or input id`)
      return { kind: 'tuple_element', ...(input !== undefined ? { input } : { element: element! }), index: typeof index === 'string' ? wireSegment(index, `${where}.index`) : index as number }
    }
    default:
      throw new Error(`${where} has unknown type expression kind '${String(type['kind'])}'`)
  }
}

// ---------------------------------------------------------------------------
// The node body on schema wire version 2
// ---------------------------------------------------------------------------

const AFTER_RUN_MODES: ReadonlySet<string> = new Set(['fixed', 'increment', 'decrement', 'randomize'])

function rejectUnknownFields(entry: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(entry)) {
    if (!allowed.includes(key)) throw new Error(`${where} has unknown field '${key}'`)
  }
}

function wireRowId(value: unknown, where: string): string {
  if (!isRowId(value)) throw new Error(`${where} must be an identifier that is not a Python keyword`)
  return value
}

function wireLayoutId(value: unknown, where: string): string {
  if (!isLayoutId(value)) throw new Error(`${where} must be an identifier`)
  return value
}

function wireString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} must be a string`)
  return value
}

function wireList(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`)
  return value
}

function wireFormula(value: unknown, where: string): FormulaSpec {
  const data = wireObject(value, where)
  rejectUnknownFields(data, ['formula'], where)
  return { formula: wireString(data['formula'], `${where}.formula`) }
}

function wireLookup(data: Record<string, unknown>, where: string): LookupSpec {
  rejectUnknownFields(data, ['lookup', 'args'], where)
  const args = wireList(data['args'] ?? [], `${where}.args`).map((argument, index): string | FormulaSpec =>
    typeof argument === 'string' ? wireRowId(argument, `${where}.args[${index}]`) : wireFormula(argument, `${where}.args[${index}]`))
  return { lookup: wireString(data['lookup'], `${where}.lookup`), args }
}

/** Text or a flag as itself, a formula or a lookup as an object (engine `_formula_to_wire`). */
function wireFormulated<T extends string | boolean>(value: unknown, where: string, literal: 'string' | 'boolean'): Formulated<T> {
  if (typeof value === literal) return value as T
  return wireFormula(value, where)
}

function wireLooked(value: unknown, where: string): Looked<string> {
  if (typeof value === 'string') return value
  const data = wireObject(value, where)
  if ('lookup' in data) return wireLookup(data, where)
  return wireFormula(data, where)
}

function wireSteps(value: unknown, where: string): readonly StepSpec[] {
  return wireList(value, where).map((raw, index) => {
    const step = wireObject(raw, `${where}[${index}]`)
    if (typeof step['step'] !== 'string' || step['step'] === '') throw new Error(`${where}[${index}].step must name a step`)
    wireJson(step, `${where}[${index}]`)
    return step as StepSpec
  })
}

function wireRule(value: unknown, where: string): RuleSpec {
  const data = wireObject(value, where)
  rejectUnknownFields(data, ['check', 'message', 'fix'], where)
  return {
    check: wireFormula(data['check'], `${where}.check`),
    message: wireString(data['message'], `${where}.message`),
    fix: wireSteps(data['fix'] ?? [], `${where}.fix`),
  }
}

/** The label, tooltip and visible every box may carry. */
function wireCommon(entry: Record<string, unknown>, where: string): {
  displayName?: Formulated<string>
  tooltip?: Formulated<string>
  visible?: Formulated<boolean>
} {
  return {
    ...(entry['label'] !== undefined ? { displayName: wireFormulated<string>(entry['label'], `${where}.label`, 'string') } : {}),
    ...(entry['tooltip'] !== undefined ? { tooltip: wireFormulated<string>(entry['tooltip'], `${where}.tooltip`, 'string') } : {}),
    ...(entry['visible'] !== undefined ? { visible: wireFormulated<boolean>(entry['visible'], `${where}.visible`, 'boolean') } : {}),
  }
}
const COMMON_FIELDS = ['label', 'tooltip', 'visible'] as const

const INPUT_FIELDS = [
  'kind', 'id', 'type', 'required', 'default', 'onAbsent', 'widget', 'tooltip', 'label', 'pinFirst', 'pin',
  'afterRun', 'onEdit', 'hidden', 'lazy', 'acceptsStorage', 'acceptsStream', 'acceptsList', 'sourceFilename',
  'alphaPolicy', 'maskPolarity', 'maskSemantic', 'visible',
]

/** A port's label, literal or worked out by formula, and whether it shows. */
function wirePortCommon(entry: Record<string, unknown>, where: string): Pick<InputSpec, 'displayName' | 'labelFormula' | 'visible'> {
  const label = entry['label'] === undefined ? undefined : wireFormulated<string>(entry['label'], `${where}.label`, 'string')
  return {
    ...(typeof label === 'string' ? { displayName: label } : label !== undefined ? { labelFormula: label } : {}),
    ...(entry['visible'] !== undefined ? { visible: wireFormulated<boolean>(entry['visible'], `${where}.visible`, 'boolean') } : {}),
  }
}

function decodeBodyInput(nodeType: string, entry: Record<string, unknown>, where: string, diags: Diagnostic[]): InputSpec {
  rejectUnknownFields(entry, INPUT_FIELDS, where)
  const id = wireRowId(entry['id'], `${where}.id`)
  const required = wireBoolean(entry['required'], `${where}.required`, true)
  const pinFirst = wireBoolean(entry['pinFirst'], `${where}.pinFirst`, false)
  const pin = wireBoolean(entry['pin'], `${where}.pin`, true)
  if (!pin && pinFirst) throw new Error(`${where}.pin false conflicts with pinFirst`)
  const hidden = wireBoolean(entry['hidden'], `${where}.hidden`, false)
  const lazy = wireBoolean(entry['lazy'], `${where}.lazy`, false)
  wireJson(entry['default'], `${where}.default`)
  if (entry['onAbsent'] !== undefined && (typeof entry['onAbsent'] !== 'string' || !ABSENT_POLICIES.has(entry['onAbsent']))) {
    throw new Error(`${where}.onAbsent is invalid`)
  }
  if (required && entry['onAbsent'] === 'omit') throw new Error(`${where}.onAbsent cannot be 'omit' when required`)
  const afterRun = entry['afterRun']
  if (afterRun !== undefined && (typeof afterRun !== 'string' || !AFTER_RUN_MODES.has(afterRun))) {
    throw new Error(`${where}.afterRun must be one of ${[...AFTER_RUN_MODES].join(', ')}`)
  }
  const onEdit = entry['onEdit'] === undefined ? [] : wireSteps(entry['onEdit'], `${where}.onEdit`)
  const tooltip = wireOptionalString(entry['tooltip'], `${where}.tooltip`)
  const decoded = decodeInput(
    nodeType,
    {
      id,
      type: entry['type'],
      required,
      default: entry['default'],
      onAbsent: entry['onAbsent'],
      widget: entry['widget'],
      forceInput: pinFirst,
      sourceFilename: entry['sourceFilename'],
      ...(tooltip !== undefined ? { doc: tooltip } : {}),
    },
    diags,
    wireType(entry['type'], `${where}.type`),
  )
  let widget = decoded.widget
  if (afterRun !== undefined) {
    // As the engine checks it: every field the row can show is a number or
    // list field, or the row has no field and a number or list type.
    const field = entry['widget'] as Record<string, unknown> | undefined
    const shown = field?.['type'] === 'REPRESENTATIONS'
      ? (field['representations'] as readonly { readonly widget: Record<string, unknown> }[]).map((item) => item.widget)
      : [field]
    const numeric = decoded.type.kind === 'concrete' && ['INT', 'FLOAT', 'COMBO'].includes(decoded.type.name)
    if (!shown.every((item) => item === undefined ? numeric : item['type'] === 'NUMBER' || item['type'] === 'COMBO')) {
      throw new Error(`${where}.afterRun needs a number or list field`)
    }
    if (widget !== undefined) widget = { ...widget, controller: 'after_generate', controllerInitial: afterRun as NonNullable<WidgetSpec['controllerInitial']> }
  }
  return {
    ...decoded,
    ...wirePortCommon(entry, where),
    ...(widget !== undefined ? { widget } : {}),
    ...(pinFirst ? { forceInput: true } : {}),
    ...(!pin ? { socketless: true } : {}),
    ...(hidden ? { hidden: true } : {}),
    ...(lazy ? { lazy: true } : {}),
    ...(onEdit.length > 0 ? { onEdit } : {}),
    ...acceptsStorageOf({ role: 'input', acceptsStorage: entry['acceptsStorage'] }, where),
    ...acceptsStreamOf({ role: 'input', ...(Object.hasOwn(entry, 'acceptsStream') ? { acceptsStream: entry['acceptsStream'] } : {}) }, where),
    ...acceptsListOf({ role: 'input', ...(Object.hasOwn(entry, 'acceptsList') ? { acceptsList: entry['acceptsList'] } : {}) }, where),
    ...mediaPolicyOf(entry, where),
  }
}

const OUTPUT_FIELDS = [
  'kind', 'id', 'type', 'optional', 'tooltip', 'label', 'preview', 'represents', 'knownValue',
  'alphaPolicy', 'maskPolarity', 'maskSemantic', 'visible',
]

function decodeBodyOutput(nodeType: string, entry: Record<string, unknown>, where: string, diags: Diagnostic[]): OutputSpec {
  rejectUnknownFields(entry, OUTPUT_FIELDS, where)
  const id = wireRowId(entry['id'], `${where}.id`)
  const tooltip = wireOptionalString(entry['tooltip'], `${where}.tooltip`)
  return {
    ...decodeOutput(nodeType, { ...entry, id, ...(tooltip !== undefined ? { doc: tooltip } : {}) } as WireEntry, diags, wireType(entry['type'], `${where}.type`)),
    ...wirePortCommon(entry, where),
    ...(wireBoolean(entry['optional'], `${where}.optional`, false) ? { optional: true } : {}),
    ...wirePreview(entry, where),
    ...mediaPolicyOf(entry, where),
  }
}

function decodeKeys(value: unknown, where: string): GroupKeysSpec {
  const data = wireObject(value, where)
  if (Object.keys(data).length === 1 && Array.isArray(data['named'])) {
    const names = data['named'].map((name, index) => {
      if (!isMemberKey(name)) throw new Error(`${where}.named[${index}] must match [A-Za-z0-9_]+`)
      return name
    })
    if (names.length === 0 || new Set(names).size !== names.length) throw new Error(`${where}.named must be unique names`)
    return { kind: 'named', names }
  }
  if (Object.keys(data).length !== 1 || data['numbered'] === undefined) {
    throw new Error(`${where} is {numbered: {...}} or {named: [...]}`)
  }
  const numbered = wireObject(data['numbered'], `${where}.numbered`)
  rejectUnknownFields(numbered, ['prefix', 'start', 'pad'], `${where}.numbered`)
  const prefix = wireString(numbered['prefix'] ?? '', `${where}.numbered.prefix`)
  if (prefix !== '' && !isMemberKey(prefix)) throw new Error(`${where}.numbered.prefix must match [A-Za-z0-9_]+`)
  const start = wireBound(numbered['start'] ?? 1, `${where}.numbered.start`)!
  const pad = wireBound(numbered['pad'] ?? 0, `${where}.numbered.pad`)!
  if (pad > 8) throw new Error(`${where}.numbered.pad is from 0 to 8`)
  return { kind: 'numbered', prefix, start, pad }
}

function decodeGrows(value: unknown, where: string): GroupGrowsSpec {
  if (value === undefined) return 'link'
  if (value === 'link' || value === 'filled' || value === 'button') return value
  const data = wireObject(value, where)
  if (Object.keys(data).length === 1 && typeof data['count'] === 'string') return { count: data['count'] }
  if (Object.keys(data).length === 1 && data['followList'] !== undefined) {
    return { followList: wireRowId(data['followList'], `${where}.followList`) }
  }
  throw new Error(`${where} is "link", "filled", "button", {count: formula} or {followList: field}`)
}

/**
 * A Use's field is decoded against the type of the shared row it places,
 * found among `scope`, the rows the Use may name.
 */
function decodeUse(nodeType: string, entry: Record<string, unknown>, where: string, diags: Diagnostic[], scope: readonly OptionRow[]): UseSpec {
  rejectUnknownFields(entry, ['kind', 'id', 'label', 'tooltip', 'widget', 'default', 'required', 'only', 'inside'], where)
  const id = wireRowId(entry['id'], `${where}.id`)
  wireJson(entry['default'], `${where}.default`)
  const target = scope.find((row) => row.kind !== 'row' && row.kind !== 'use' && row.id === id)
  let widget: WidgetSpec | null | undefined
  if (entry['widget'] === null) widget = null
  else if (entry['widget'] !== undefined) {
    const type: TypeExpr = target?.kind === 'input' ? target.type : { kind: 'wildcard' }
    widget = widgetFor(nodeType, id, type, entry['default'], entry['widget'], diags)
  }
  const inner = target?.kind === 'choice' ? scopeRowsOf([...target.shared, ...target.options.flatMap((option) => option.rows)]) : []
  return {
    kind: 'use',
    id,
    ...(entry['label'] !== undefined ? { displayName: wireString(entry['label'], `${where}.label`) } : {}),
    ...(entry['tooltip'] !== undefined ? { tooltip: wireString(entry['tooltip'], `${where}.tooltip`) } : {}),
    ...(widget !== undefined ? { widget } : {}),
    ...(entry['default'] !== undefined ? { default: entry['default'] } : {}),
    ...(entry['required'] !== undefined ? { required: wireBoolean(entry['required'], `${where}.required`, false) } : {}),
    ...(entry['only'] !== undefined
      ? { only: wireList(entry['only'], `${where}.only`).map((key, index) => wireString(key, `${where}.only[${index}]`)) }
      : {}),
    ...(entry['inside'] !== undefined
      ? {
          inside: wireList(entry['inside'], `${where}.inside`).map((raw, index) =>
            decodeUse(nodeType, wireObject(raw, `${where}.inside[${index}]`), `${where}.inside[${index}]`, diags, inner)),
        }
      : {}),
  }
}

function decodeRows(nodeType: string, value: unknown, where: string, diags: Diagnostic[]): readonly BodyRow[] {
  return wireList(value, where).map((raw, index) => {
    const row = decodeOptionRow(nodeType, raw, `${where}[${index}]`, diags, [])
    if (row.kind === 'use') throw new Error(`${where}[${index}]: a Use belongs under a choice's option`)
    return row
  })
}

function decodeOptionRows(nodeType: string, value: unknown, where: string, diags: Diagnostic[], scope: readonly OptionRow[]): readonly OptionRow[] {
  return wireList(value, where).map((raw, index) => decodeOptionRow(nodeType, raw, `${where}[${index}]`, diags, scope))
}

/** One body row (engine `body_row_from_wire`). */
function decodeOptionRow(nodeType: string, raw: unknown, where: string, diags: Diagnostic[], scope: readonly OptionRow[]): OptionRow {
  const entry = wireObject(raw, where)
  switch (entry['kind']) {
    case 'use':
      return decodeUse(nodeType, entry, where, diags, scope)
    case 'input':
      return decodeBodyInput(nodeType, entry, where, diags)
    case 'output':
      return decodeBodyOutput(nodeType, entry, where, diags)
    case 'state': {
      rejectUnknownFields(entry, ['kind', 'id', 'type', 'default', 'partOfRun'], where)
      wireJson(entry['default'], `${where}.default`)
      return {
        kind: 'state',
        id: wireRowId(entry['id'], `${where}.id`),
        type: wireType(entry['type'], `${where}.type`),
        ...(entry['default'] !== undefined && entry['default'] !== null ? { default: entry['default'] } : {}),
        partOfRun: wireBoolean(entry['partOfRun'], `${where}.partOfRun`, true),
      }
    }
    case 'row': {
      rejectUnknownFields(entry, ['kind', 'rows'], where)
      const rows = decodeRows(nodeType, entry['rows'], `${where}.rows`, diags)
      if (rows.length < 2 || rows.length > 4 || rows.some((row) => row.kind !== 'input' && row.kind !== 'button' && row.kind !== 'note')) {
        throw new Error(`${where}: a Row holds two to four of Input, Button and Note`)
      }
      return { kind: 'row', rows: rows as RowSpec['rows'] }
    }
    case 'section': {
      rejectUnknownFields(entry, ['kind', 'id', 'rows', 'collapsed', 'openName', ...COMMON_FIELDS], where)
      return {
        kind: 'section',
        id: wireLayoutId(entry['id'], `${where}.id`),
        ...wireCommon(entry, where),
        rows: decodeOptionRows(nodeType, entry['rows'], `${where}.rows`, diags, scope),
        ...(wireBoolean(entry['collapsed'], `${where}.collapsed`, false) ? { collapsedByDefault: true } : {}),
        ...(!wireBoolean(entry['openName'], `${where}.openName`, true) ? { openName: false as const } : {}),
      }
    }
    case 'note': {
      rejectUnknownFields(entry, ['kind', 'id', 'text', 'unknown', 'visible'], where)
      const unknown = wireOptionalString(entry['unknown'], `${where}.unknown`)
      return {
        kind: 'note',
        id: wireLayoutId(entry['id'], `${where}.id`),
        text: wireLooked(entry['text'], `${where}.text`),
        ...(unknown !== undefined ? { unknown } : {}),
        ...(entry['visible'] !== undefined ? { visible: wireFormulated<boolean>(entry['visible'], `${where}.visible`, 'boolean') } : {}),
      }
    }
    case 'editor': {
      rejectUnknownFields(entry, ['kind', 'id', 'widget', 'visible'], where)
      const id = wireLayoutId(entry['id'], `${where}.id`)
      const descriptor = wireObject(entry['widget'], `${where}.widget`)
      // A custom or compositor widget; the compositor binds as on its own input type.
      const type: TypeExpr = descriptor['type'] === 'COMPOSITOR' ? { kind: 'concrete', name: 'COMPOSITOR' } : { kind: 'wildcard' }
      const widget = widgetFor(nodeType, id, type, undefined, descriptor, diags)
      if (widget === undefined || (widget.writes === undefined && widget.reads === undefined)) {
        throw new Error(`${where}.widget must name at least one row it writes or reads`)
      }
      return {
        kind: 'editor',
        id,
        widget,
        ...(entry['visible'] !== undefined ? { visible: wireFormulated<boolean>(entry['visible'], `${where}.visible`, 'boolean') } : {}),
      }
    }
    case 'button': {
      rejectUnknownFields(entry, ['kind', 'id', 'steps', 'enabled', 'disabledReason', 'icon', ...COMMON_FIELDS], where)
      const common = wireCommon(entry, where)
      if (typeof common.displayName !== 'string' || common.displayName === '') throw new Error(`${where}.label is required text`)
      const { displayName: label, ...rest } = common
      return {
        kind: 'button',
        id: wireLayoutId(entry['id'], `${where}.id`),
        label,
        ...(rest.tooltip !== undefined ? { tooltip: rest.tooltip } : {}),
        ...(rest.visible !== undefined ? { visible: rest.visible } : {}),
        steps: wireSteps(entry['steps'], `${where}.steps`),
        ...(entry['enabled'] !== undefined ? { enabled: wireFormulated<boolean>(entry['enabled'], `${where}.enabled`, 'boolean') } : {}),
        ...(entry['disabledReason'] !== undefined
          ? { disabledReason: wireFormulated<string>(entry['disabledReason'], `${where}.disabledReason`, 'string') }
          : {}),
        ...(entry['icon'] !== undefined ? { icon: wireString(entry['icon'], `${where}.icon`) } : {}),
      }
    }
    case 'group': {
      rejectUnknownFields(entry, [
        'kind', 'id', 'member', 'value', 'keys', 'grows', 'minMembers', 'maxMembers', 'independentTypes',
        'optionalAfterMinimum', 'reorderable', 'addLabel', 'memberLabel', 'openName', ...COMMON_FIELDS,
      ], where)
      const id = wireRowId(entry['id'], `${where}.id`)
      if ((entry['member'] === undefined) === (entry['value'] === undefined)) {
        throw new Error(`${where}: group ${id} declares exactly one of member and value`)
      }
      let value: InputSpec | OutputSpec | undefined
      if (entry['value'] !== undefined) {
        const row = decodeOptionRow(nodeType, entry['value'], `${where}.value`, diags, [])
        if (row.kind !== 'input' && row.kind !== 'output') throw new Error(`${where}.value is one Input or one Output`)
        value = row
      }
      const member = entry['member'] === undefined ? undefined : decodeRows(nodeType, entry['member'], `${where}.member`, diags)
      if (member !== undefined && member.length === 0) throw new Error(`${where}: group ${id} member needs at least one row`)
      const minMembers = wireBound(entry['minMembers'] ?? 0, `${where}.minMembers`)!
      const maxMembers = wireBound(entry['maxMembers'], `${where}.maxMembers`)
      if (minMembers > MAX_GROUP_MEMBERS) throw new Error(`${where}.minMembers is from 0 to ${MAX_GROUP_MEMBERS}`)
      if (maxMembers !== undefined && (maxMembers < Math.max(1, minMembers) || maxMembers > MAX_GROUP_MEMBERS)) {
        throw new Error(`${where}.maxMembers is from minMembers (and 1) to ${MAX_GROUP_MEMBERS}`)
      }
      const keys = decodeKeys(entry['keys'], `${where}.keys`)
      if (keys.kind === 'named' && maxMembers !== undefined && maxMembers > keys.names.length) {
        throw new Error(`${where}.maxMembers exceeds the declared names`)
      }
      const flag = (name: string): boolean => wireBoolean(entry[name], `${where}.${name}`, false)
      return {
        kind: 'group',
        id,
        ...wireCommon(entry, where),
        ...(value !== undefined ? { value } : {}),
        ...(member !== undefined ? { member } : {}),
        keys,
        grows: decodeGrows(entry['grows'], `${where}.grows`),
        minMembers,
        ...(maxMembers !== undefined ? { maxMembers } : {}),
        ...(flag('independentTypes') ? { independentTypes: true as const } : {}),
        ...(flag('optionalAfterMinimum') ? { optionalAfterMinimum: true as const } : {}),
        ...(flag('reorderable') ? { reorderable: true as const } : {}),
        ...(wireOptionalString(entry['addLabel'], `${where}.addLabel`) !== undefined ? { addLabel: entry['addLabel'] as string } : {}),
        ...(entry['memberLabel'] !== undefined && entry['memberLabel'] !== ''
          ? { memberLabel: wireFormulated<string>(entry['memberLabel'], `${where}.memberLabel`, 'string') }
          : {}),
        ...(!wireBoolean(entry['openName'], `${where}.openName`, true) ? { openName: false as const } : {}),
      }
    }
    case 'choice': {
      rejectUnknownFields(entry, ['kind', 'id', 'options', 'shared', 'leader', 'default', 'required', 'hidden', 'onEdit', ...COMMON_FIELDS], where)
      const id = wireRowId(entry['id'], `${where}.id`)
      const shared = decodeRows(nodeType, entry['shared'] ?? [], `${where}.shared`, diags)
      const sharedScope = scopeRowsOf(shared)
      const keys = new Set<string>()
      const options = wireList(entry['options'], `${where}.options`).map((raw, index) => {
        const optionWhere = `${where}.options[${index}]`
        const option = wireObject(raw, optionWhere)
        rejectUnknownFields(option, ['key', 'rows', 'label'], optionWhere)
        const key = option['key']
        if (!isOptionKey(key)) throw new Error(`${optionWhere}.key must be printable ASCII words separated by single spaces`)
        if (keys.has(key)) throw new Error(`${where}: choice ${id} declares option '${key}' twice`)
        keys.add(key)
        const label = wireOptionalString(option['label'], `${optionWhere}.label`)
        return {
          key,
          ...(label !== undefined ? { label } : {}),
          rows: decodeOptionRows(nodeType, option['rows'] ?? [], `${optionWhere}.rows`, diags, sharedScope),
        }
      })
      if (options.length === 0) throw new Error(`${where}: choice ${id} needs at least one option`)
      const defaultKey = entry['default'] === undefined ? undefined : wireString(entry['default'], `${where}.default`)
      if (defaultKey !== undefined && !keys.has(defaultKey)) throw new Error(`${where}.default must name an option`)
      const onEdit = entry['onEdit'] === undefined ? [] : wireSteps(entry['onEdit'], `${where}.onEdit`)
      return {
        kind: 'choice',
        id,
        ...wireCommon(entry, where),
        options,
        shared,
        ...(entry['leader'] !== undefined ? { leader: wireString(entry['leader'], `${where}.leader`) } : {}),
        ...(defaultKey !== undefined ? { default: defaultKey } : {}),
        required: wireBoolean(entry['required'], `${where}.required`, true),
        ...(wireBoolean(entry['hidden'], `${where}.hidden`, false) ? { hidden: true as const } : {}),
        ...(onEdit.length > 0 ? { onEdit } : {}),
      }
    }
    case 'typeChoice': {
      rejectUnknownFields(entry, ['kind', 'id', 'variants', 'type', 'rows', 'required', 'typeVariable', ...COMMON_FIELDS], where)
      const id = wireRowId(entry['id'], `${where}.id`)
      if ((entry['variants'] === undefined) === (entry['type'] === undefined)) {
        throw new Error(`${where}: type choice ${id} declares exactly one of variants and type`)
      }
      const keys = new Set<string>()
      const variants = entry['variants'] === undefined ? undefined : wireList(entry['variants'], `${where}.variants`).map((raw, index) => {
        const variantWhere = `${where}.variants[${index}]`
        const variant = wireObject(raw, variantWhere)
        rejectUnknownFields(variant, ['key', 'type', 'rows', 'tooltip'], variantWhere)
        const key = variant['key']
        if (!isVariantKey(key)) throw new Error(`${variantWhere}.key must match [A-Za-z0-9_-]+`)
        if (keys.has(key)) throw new Error(`${where}: type choice ${id} declares variant '${key}' twice`)
        keys.add(key)
        const tooltip = wireOptionalString(variant['tooltip'], `${variantWhere}.tooltip`)
        return {
          key,
          type: wireType(variant['type'], `${variantWhere}.type`),
          rows: decodeRows(nodeType, variant['rows'] ?? [], `${variantWhere}.rows`, diags),
          ...(tooltip !== undefined ? { tooltip } : {}),
        }
      })
      if (variants !== undefined && variants.length === 0) throw new Error(`${where}: type choice ${id} needs at least one variant`)
      const typeVariable = wireOptionalString(entry['typeVariable'], `${where}.typeVariable`)
      if (typeof entry['required'] !== 'boolean') throw new Error(`${where}.required must be a boolean`)
      return {
        kind: 'typeChoice',
        id,
        ...wireCommon(entry, where),
        ...(variants !== undefined ? { variants } : { type: wireType(entry['type'], `${where}.type`) }),
        rows: decodeRows(nodeType, entry['rows'] ?? [], `${where}.rows`, diags),
        required: entry['required'],
        ...(typeVariable !== undefined ? { typeVariable } : {}),
      }
    }
    case 'described': {
      rejectUnknownFields(entry, ['kind', 'id', 'kinds', 'maxEntries', 'minEntries', 'fixedIds', 'probe', ...COMMON_FIELDS], where)
      const id = wireRowId(entry['id'], `${where}.id`)
      const kinds = decodeRows(nodeType, entry['kinds'], `${where}.kinds`, diags).map((row, index) => {
        if (row.kind !== 'input' && row.kind !== 'output') throw new Error(`${where}.kinds[${index}] is an Input or an Output`)
        return row
      })
      const kindIds = kinds.map((kind) => kind.id)
      if (kinds.length === 0 || new Set(kindIds).size !== kindIds.length) {
        throw new Error(`${where}: described ${id} needs kinds with unique ids across inputs and outputs`)
      }
      const maxEntries = wireBound(entry['maxEntries'], `${where}.maxEntries`)
      if (maxEntries === undefined) throw new Error(`${where}.maxEntries is required`)
      const minEntries = wireBound(entry['minEntries'] ?? 0, `${where}.minEntries`)!
      let probe: DescribedSpec['probe']
      if (entry['probe'] !== undefined) {
        const raw = wireObject(entry['probe'], `${where}.probe`)
        rejectUnknownFields(raw, ['input', 'kind', 'revision'], `${where}.probe`)
        if (raw['kind'] !== 'model') throw new Error(`${where}.probe.kind must be 'model'`)
        probe = { input: wireRowId(raw['input'], `${where}.probe.input`), kind: 'model', revision: wireString(raw['revision'], `${where}.probe.revision`) }
      }
      return {
        kind: 'described',
        id,
        ...wireCommon(entry, where),
        kinds,
        minEntries,
        maxEntries,
        fixedIds: wireBoolean(entry['fixedIds'], `${where}.fixedIds`, false),
        ...(probe !== undefined ? { probe } : {}),
      }
    }
    default:
      throw new Error(`${where} has unknown row kind '${String(entry['kind'])}'`)
  }
}

/**
 * Tables as formulas read them: whole JSON numbers are whole numbers, `{float: n}` a whole float,
 * `{table: [[k, v]]}` a dictionary.
 */
function decodeTable(value: unknown, where: string): unknown {
  if (Array.isArray(value)) return value.map((item, index) => decodeTable(item, `${where}[${index}]`))
  if (typeof value === 'object' && value !== null) {
    const data = value as Record<string, unknown>
    if (Object.keys(data).length === 1 && Object.hasOwn(data, 'float')) {
      if (typeof data['float'] !== 'number' || !Number.isInteger(data['float'])) throw new Error(`${where}: a marked table float is {float: whole number}`)
      return value
    }
    if (Object.keys(data).length !== 1 || !Array.isArray(data['table'])) throw new Error(`${where}: a table dictionary is {table: [[key, value], ...]}`)
    return {
      table: data['table'].map((pair, index) => {
        if (!Array.isArray(pair) || pair.length !== 2 || !(typeof pair[0] === 'string' || (typeof pair[0] === 'number' && Number.isSafeInteger(pair[0])))) {
          throw new Error(`${where}.table[${index}] is [text or whole-number key, value]`)
        }
        return [pair[0], decodeTable(pair[1], `${where}.table[${index}][1]`)]
      }),
    }
  }
  wireJson(value, where)
  return value
}

/** The body and the node-level formula fields of a version 2 schema, checked as the engine checks them. */
function decodeBodySchema(nodeType: string, wire: DinksterWireSchema, diags: Diagnostic[]): Pick<NodeSchema, 'body' | 'tables' | 'derived' | 'validate' | 'titleSuffix' | 'menu'> {
  const body = decodeRows(nodeType, wire.body, 'body', diags)
  const tables = wire.tables === undefined ? {} : Object.fromEntries(
    Object.entries(wireObject(wire.tables, 'tables')).map(([name, value]) => [wireRowId(name, `tables.${name}`), decodeTable(value, `tables.${name}`)]),
  )
  const derived = wire.derived === undefined ? {} : Object.fromEntries(
    Object.entries(wireObject(wire.derived, 'derived')).map(([name, text]) => [wireRowId(name, `derived.${name}`), wireString(text, `derived.${name}`)]),
  )
  const validate = wire.validate === undefined ? [] : wireList(wire.validate, 'validate').map((rule, index) => wireRule(rule, `validate[${index}]`))
  const menu = wire.menu === undefined ? [] : decodeRows(nodeType, wire.menu, 'menu', diags).map((row, index) => {
    if (row.kind !== 'button') throw new Error(`menu[${index}] is a Button`)
    return row
  })
  const titleSuffix = wire.titleSuffix !== undefined && wire.titleSuffix !== '' ? wireFormulated<string>(wire.titleSuffix, 'titleSuffix', 'string') : undefined
  checkBody(body, { tables: formulaTablesOf(tables), derived: new Map(Object.entries(derived)) }, {
    validate, menu, ...(titleSuffix === undefined ? {} : { titleSuffix }),
  })
  return {
    body,
    ...(Object.keys(tables).length > 0 ? { tables } : {}),
    ...(Object.keys(derived).length > 0 ? { derived } : {}),
    ...(validate.length > 0 ? { validate } : {}),
    ...(titleSuffix === undefined ? {} : { titleSuffix }),
    ...(menu.length > 0 ? { menu } : {}),
  }
}

export function parseDinksterSchema(nodeType: string, wire: DinksterWireSchema): DinksterParseResult {
  const diags: Diagnostic[] = []
  try {
    if (wire.schemaVersion !== undefined && wire.schemaVersion !== DINKSTER_SCHEMA_WIRE_VERSION) {
      throw new Error(`expected schema wire version ${DINKSTER_SCHEMA_WIRE_VERSION}, received ${String(wire.schemaVersion)}`)
    }
    if (wire.interface !== undefined && (!Array.isArray(wire.interface) || wire.interface.length > 0)) {
      throw new Error('schema wire version 2 carries the node body, not an interface list')
    }
    const bodySchema = decodeBodySchema(nodeType, wire, diags)
    const idempotent = wire.idempotent !== false
    const additionalInputs = wire.additionalInputs === undefined ? undefined : wireType(wire.additionalInputs, 'additionalInputs')
    const deprecation = decodeDeprecation(nodeType, wire.deprecation, diags)
    const replacements = decodeReplacements(nodeType, wire.replacements, diags)
    const searchVisibility = decodeSearchVisibility(nodeType, wire.searchVisibility, diags)
    const searchTerms = Array.isArray(wire.searchTerms) && wire.searchTerms.every((term) => typeof term === 'string') ? ([...wire.searchTerms] as string[]) : []
    const executionArms = Array.isArray(wire.executionArms)
      ? wire.executionArms.filter((arm): arm is 'native' | 'comfyui' => arm === 'native' || arm === 'comfyui')
      : []
    let residentAffinity: NodeSchema['residentAffinity']
    if (wire.residentAffinity !== undefined) {
      const affinity = wireObject(wire.residentAffinity, 'residentAffinity')
      if (!Array.isArray(affinity['types']) || !affinity['types'].every((type) => typeof type === 'string') ||
        !Array.isArray(affinity['routes'])) throw new Error('residentAffinity requires types and routes lists')
      residentAffinity = {
        types: [...affinity['types']] as string[],
        routes: affinity['routes'].map((value: unknown) => {
          const route = wireObject(value, 'residentAffinity.routes')
          if (typeof route['process'] !== 'string' || typeof route['pack'] !== 'string' || typeof route['worker'] !== 'string') {
            throw new Error('residentAffinity route requires process, pack and worker strings')
          }
          return { process: route['process'], pack: route['pack'], worker: route['worker'],
            unplaced: route['unplaced'] !== false,
            ...(typeof route['provider'] === 'string' ? { provider: route['provider'] } : {}),
          }
        }),
      }
    }
    const baseSchema: NodeSchema = {
      type: nodeType,
      displayName: typeof wire.displayName === 'string' && wire.displayName !== '' ? wire.displayName : nodeType,
      category: typeof wire.category === 'string' ? wire.category : '',
      ...(typeof wire.editorRole === 'string' && wire.editorRole !== '' ? { editorRole: wire.editorRole } : {}),
      ...(typeof wire.pack === 'string' && wire.pack !== '' ? { pack: wire.pack } : {}),
      ...(typeof wire.signature === 'string' && wire.signature !== '' ? { signature: wire.signature } : {}),
      ...(executionArms.length > 0 ? { executionArms: [...new Set(executionArms)] } : {}),
      ...(residentAffinity !== undefined ? { residentAffinity } : {}),
      ...(typeof wire.unavailableReason === 'string' && wire.unavailableReason !== ''
        ? { unavailableReason: wire.unavailableReason } : {}),
      ...(typeof wire.description === 'string' && wire.description !== '' ? { description: wire.description } : {}),
      source: 'v3',
      ...bodySchema,
      ...(additionalInputs !== undefined ? { additionalInputs } : {}),
      isOutputNode: wire.outputNode === true || !idempotent,
      ...(wire.emitsPreviews === true ? { emitsPreviews: true } : {}),
      ...(wire.mayExpandGraph === true ? { mayExpandGraph: true } : {}),
      ...(wire.hasDocs === true ? { hasDocs: true } : {}),
      ...(deprecation !== undefined ? { deprecation } : {}),
      ...(replacements !== undefined ? { replacements } : {}),
      ...(searchVisibility !== undefined ? { searchVisibility } : {}),
      searchTerms,
      ext: {
        dinkster: {
          version: typeof wire.version === 'number' ? wire.version : 1,
          idempotent,
          ...(Array.isArray(wire.occupies) && wire.occupies.length > 0 ? { occupies: wire.occupies.map(String) } : {}),
          ...(wire.ioBound === true ? { ioBound: true } : {}),
        },
      },
    }
    const decodedInputs = new Map(inputsOf(baseSchema).map((item) => [item.id, item]))
    const decodedOutputs = outputsOf(baseSchema)
    const validateTupleDeclaration = (type: TypeExpr, output: boolean): void => {
      if (type.kind === 'tuple_element') {
        const source = type.input === undefined ? undefined : decodedInputs.get(type.input)
        const selector = typeof type.index === 'string' ? decodedInputs.get(type.index) : undefined
        if (!output || (type.input !== undefined && source === undefined)) throw new Error('tuple_element requires a tuple input of the node and an output declaration')
        if (typeof type.index === 'string' && (selector === undefined || selector.optional || selector.type.kind !== 'concrete' || selector.type.name !== 'INT')) throw new Error('tuple_element requires a required INT selector of the node')
      } else if (type.kind === 'tuple') {
        type.elements.forEach((element) => validateTupleDeclaration(element, output))
      } else if (type.kind === 'list' || type.kind === 'asset' || type.kind === 'stream') validateTupleDeclaration(type.element, output)
    }
    for (const row of allRowsOf(baseSchema.body)) {
      if (row.kind === 'input' || row.kind === 'output') validateTupleDeclaration(row.type, row.kind === 'output')
    }
    if (additionalInputs !== undefined) validateTupleDeclaration(additionalInputs, false)
    for (const output of decodedOutputs) {
      const knownValue = output.knownValue
      if (knownValue === undefined) continue
      const input = decodedInputs.get(knownValue.input)
      const primitive = output.type.kind === 'concrete' && PRIMITIVE_WIDGETS[output.type.name] !== undefined
      if (input === undefined || !primitive || input.type.kind !== 'concrete' || input.type.name !== output.type.name) {
        throw new Error(`output '${output.id}' knownValue must name an input of the node with the same concrete primitive type`)
      }
    }
    const selector = decodeWireSelector(wire.selector, decodedInputs, decodedOutputs)
    if (wire.widgetGroups !== undefined) throw new Error('widgetGroups is not part of a body node; a Choice or a visible formula shows and hides rows')
    const mirror = decodeMirror(wire.mirror)
    const topChoices = new Map(scopeRowsOf(baseSchema.body).filter((row): row is ChoiceSpec => row.kind === 'choice').map((row) => [row.id, row]))
    const chunkSafe = decodeChunkSafe(wire, decodedInputs, decodedOutputs, topChoices)
    if (mirror?.applies !== undefined) checkAppliesChoices(mirror.applies, topChoices, 'mirror')
    for (const row of allRowsOf(baseSchema.body)) {
      if (row.kind === 'output' && row.represents?.applies !== undefined) {
        checkAppliesChoices(row.represents.applies, topChoices, `output '${row.id}' represents`)
      }
    }
    return {
      schema: {
        ...baseSchema,
        ...(selector !== undefined ? { selector } : {}),
        ...(mirror !== undefined ? { mirror } : {}),
        ...(chunkSafe !== undefined ? { chunkSafe } : {}),
      },
      diagnostics: diags,
    }
  } catch (error) {
    return {
      schema: undefined,
      diagnostics: [
        ...diags,
        diag('error', 'schema', 'schema.parse.threw', `${nodeType}: schema parse threw: ${error instanceof Error ? error.message : String(error)}`),
      ],
    }
  }
}

const MIRROR_KINDS: ReadonlySet<string> = new Set(['expression', 'glsl'])
const MIRROR_PRECISIONS: ReadonlySet<string> = new Set(['exact', 'bounded'])
const MIRROR_FIELDS: ReadonlySet<string> = new Set(['kind', 'precision', 'tolerance', 'grammarVersion', 'source', 'applies'])
const MIRROR_TOLERANCE_FIELDS: ReadonlySet<string> = new Set(['relative', 'perChannel'])
/** Byte ceiling for glsl mirror source; matches the backend declaration limit. */
const MAX_MIRROR_SOURCE_BYTES = 16384

function decodeMirrorTolerance(raw: unknown): MirrorTolerance {
  const tolerance = wireObject(raw, 'mirror.tolerance')
  for (const key of Object.keys(tolerance)) {
    if (!MIRROR_TOLERANCE_FIELDS.has(key)) throw new Error(`mirror.tolerance has unknown field '${key}'`)
  }
  const relative = tolerance['relative']
  const perChannel = tolerance['perChannel']
  if (relative === undefined && perChannel === undefined) {
    throw new Error('mirror.tolerance must declare relative or perChannel')
  }
  for (const [name, value] of [
    ['relative', relative],
    ['perChannel', perChannel],
  ] as const) {
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`mirror.tolerance.${name} must be a finite positive number`)
    }
  }
  return {
    ...(relative !== undefined ? { relative: relative as number } : {}),
    ...(perChannel !== undefined ? { perChannel: perChannel as number } : {}),
  }
}

/**
 * The mirror applies scope: combo id -> covered option keys. Strict like
 * every mirror field - the scope is a soundness boundary, so a malformed
 * scope fails the node rather than decoding into an over- or under-applied
 * mirror.
 */
/** An applies key names a required choice of the body's top scope, and its values are option keys. */
function checkAppliesChoices(
  applies: Readonly<Record<string, readonly string[]>>,
  choices: ReadonlyMap<string, ChoiceSpec>,
  subject: string,
): void {
  for (const [id, keys] of Object.entries(applies)) {
    const choice = choices.get(id)
    if (choice === undefined) throw new Error(`${subject} applies key '${id}' does not name a declared choice`)
    if (!choice.required) throw new Error(`${subject} applies key '${id}' must name a required choice`)
    const undeclared = keys.filter((key) => !choice.options.some((option) => option.key === key))
    if (undeclared.length > 0) throw new Error(`${subject} applies['${id}'] covers undeclared option(s): ${[...undeclared].sort().join(', ')}`)
  }
}

function decodeApplies(raw: unknown, subject: string): Readonly<Record<string, readonly string[]>> {
  const entries = Object.entries(wireObject(raw, subject))
  if (entries.length === 0) throw new Error(`${subject} must not be empty`)
  const applies = new Map<string, readonly string[]>()
  for (const [comboId, rawValues] of entries) {
    if (comboId === '') throw new Error(`${subject} keys must be non-empty combo ids`)
    if (!Array.isArray(rawValues) || rawValues.length === 0) {
      throw new Error(`${subject}['${comboId}'] must cover at least one option`)
    }
    if (rawValues.some((value) => typeof value !== 'string' || value === '')) {
      throw new Error(`${subject}['${comboId}'] options must be non-empty strings`)
    }
    if (new Set(rawValues).size !== rawValues.length) {
      throw new Error(`${subject}['${comboId}'] has duplicate options`)
    }
    applies.set(comboId, rawValues as readonly string[])
  }
  return Object.fromEntries(applies)
}

const OUTPUT_REPRESENTS_FIELDS: ReadonlySet<string> = new Set(['input', 'rendition', 'applies'])

function decodeOutputRepresents(raw: unknown): OutputRepresents | undefined {
  if (raw === undefined) return undefined
  const represents = wireObject(raw, 'output.represents')
  for (const key of Object.keys(represents)) {
    if (!OUTPUT_REPRESENTS_FIELDS.has(key)) throw new Error(`output.represents has unknown field '${key}'`)
  }
  const input = represents['input']
  if (typeof input !== 'string' || input === '') {
    throw new Error('output.represents.input must be a non-empty string')
  }
  const rendition = represents['rendition']
  if (typeof rendition !== 'string' || rendition === '') {
    throw new Error('output.represents.rendition must be a non-empty string')
  }
  const applies = represents['applies'] === undefined ? undefined : decodeApplies(represents['applies'], 'output.represents.applies')
  return { input, rendition, ...(applies === undefined ? {} : { applies }) }
}

function decodeOutputKnownValue(raw: unknown): OutputKnownValue | undefined {
  if (raw === undefined) return undefined
  const knownValue = wireObject(raw, 'output.knownValue')
  for (const key of Object.keys(knownValue)) {
    if (key !== 'input') throw new Error(`output.knownValue has unknown field '${key}'`)
  }
  const input = knownValue['input']
  if (typeof input !== 'string' || input === '') {
    throw new Error('output.knownValue.input must be a non-empty string')
  }
  return { input }
}

function decodeMirror(raw: unknown): MirrorSpec | undefined {
  if (raw === undefined) return undefined
  const mirror = wireObject(raw, 'mirror')
  for (const key of Object.keys(mirror)) {
    if (!MIRROR_FIELDS.has(key)) throw new Error(`mirror has unknown field '${key}'`)
  }
  const kind = mirror['kind']
  if (typeof kind !== 'string' || !MIRROR_KINDS.has(kind)) {
    throw new Error(`mirror.kind must be one of ${[...MIRROR_KINDS].join(', ')}`)
  }
  const precision = mirror['precision']
  if (typeof precision !== 'string' || !MIRROR_PRECISIONS.has(precision)) {
    throw new Error(`mirror.precision must be one of ${[...MIRROR_PRECISIONS].join(', ')}`)
  }
  const tolerance = mirror['tolerance'] !== undefined ? decodeMirrorTolerance(mirror['tolerance']) : undefined
  if (precision === 'bounded' && tolerance === undefined) {
    throw new Error('bounded mirror requires a tolerance')
  }
  if (precision === 'exact' && tolerance !== undefined) {
    throw new Error('exact mirror must not declare a tolerance')
  }
  const grammarVersion = mirror['grammarVersion']
  const source = mirror['source']
  if (kind === 'expression') {
    if (typeof grammarVersion !== 'number' || !Number.isInteger(grammarVersion) || grammarVersion <= 0) {
      throw new Error('expression mirror requires a positive integer grammarVersion')
    }
    if (source !== undefined) throw new Error('expression mirror must not carry source')
  } else {
    if (grammarVersion !== undefined) throw new Error('glsl mirror must not carry grammarVersion')
    if (typeof source !== 'string' || source === '') {
      throw new Error('glsl mirror requires non-empty source')
    }
    if (new TextEncoder().encode(source).length > MAX_MIRROR_SOURCE_BYTES) {
      throw new Error(`glsl mirror source exceeds ${MAX_MIRROR_SOURCE_BYTES} bytes`)
    }
  }
  const applies = mirror['applies'] !== undefined ? decodeApplies(mirror['applies'], 'mirror.applies') : undefined
  return {
    kind: kind as MirrorSpec['kind'],
    precision: precision as MirrorSpec['precision'],
    ...(tolerance !== undefined ? { tolerance } : {}),
    ...(kind === 'expression' ? { grammarVersion: grammarVersion as number } : {}),
    ...(kind === 'glsl' ? { source: source as string } : {}),
    ...(applies !== undefined ? { applies } : {}),
  }
}

function decodeChunkSafe(
  wire: DinksterWireSchema,
  inputs: ReadonlyMap<string, InputSpec>,
  outputs: readonly OutputSpec[],
  choices: ReadonlyMap<string, ChoiceSpec>,
): NodeSchema['chunkSafe'] {
  if (!Object.hasOwn(wire, 'chunkSafe')) return undefined
  const raw = wireObject(wire.chunkSafe, 'chunkSafe')
  if (Object.keys(raw).some((key) => !['inputs', 'outputs', 'applies'].includes(key))) throw new Error('chunkSafe has unknown fields')
  const ids = (field: 'inputs' | 'outputs'): readonly string[] => {
    const value = raw[field]
    if (!Array.isArray(value) || value.length === 0 || !value.every((id) => typeof id === 'string' && id !== '') || new Set(value).size !== value.length) {
      throw new Error(`chunkSafe.${field} must contain unique non-empty strings`)
    }
    return value as string[]
  }
  const inputIds = ids('inputs')
  const outputIds = ids('outputs')
  for (const id of inputIds) {
    const input = inputs.get(id)
    if (!input) throw new Error(`chunkSafe.inputs names invalid input '${id}'`)
  }
  for (const id of outputIds) {
    if (!outputs.some((output) => output.id === id))
      throw new Error(`chunkSafe.outputs names invalid output '${id}'`)
  }
  const applies = Object.hasOwn(raw, 'applies') ? decodeApplies(raw['applies'], 'chunkSafe.applies') : undefined
  if (applies !== undefined) checkAppliesChoices(applies, choices, 'chunk_safe')
  return {
    inputs: inputIds,
    outputs: outputIds,
    ...(applies !== undefined ? { applies } : {}),
  }
}

// ---------------------------------------------------------------------------
// Deprecation / search visibility
// ---------------------------------------------------------------------------

const SEARCH_VISIBILITIES: ReadonlySet<string> = new Set(['deprecated', 'hidden'])

/**
 * Decode the optional structured deprecation object. The backend rejects an
 * empty message and self-pointers at registration, so a wire carrying either
 * is malformed - warn and drop the field (the node stays usable) rather than
 * fail the node over presentation metadata.
 */
function decodeDeprecation(nodeType: string, wire: unknown, diags: Diagnostic[]): DeprecationInfo | undefined {
  if (wire === undefined) return undefined
  if (typeof wire !== 'object' || wire === null) {
    diags.push(diag('warning', 'schema', 'schema.dinkster.badDeprecation', `${nodeType}: deprecation is not an object`))
    return undefined
  }
  const w = wire as {
    message?: unknown
    since?: unknown
    replacement?: unknown
  }
  if (typeof w.message !== 'string' || w.message === '') {
    diags.push(diag('warning', 'schema', 'schema.dinkster.badDeprecation', `${nodeType}: deprecation has no message`))
    return undefined
  }
  let replacement = typeof w.replacement === 'string' && w.replacement !== '' ? w.replacement : undefined
  if (replacement === nodeType) {
    diags.push(diag('warning', 'schema', 'schema.dinkster.badDeprecation', `${nodeType}: deprecation replacement points at itself`))
    replacement = undefined
  }
  return {
    message: w.message,
    ...(typeof w.since === 'string' && w.since !== '' ? { since: w.since } : {}),
    ...(replacement !== undefined ? { replacement } : {}),
  }
}

/**
 * Decode the optional search-visibility demotion. The backend's vocabulary is
 * closed over normal|deprecated|hidden and it omits 'normal', but accept an
 * explicit 'normal' as omission for robustness. Unknown values warn and fall
 * back to normal - a listing hint must never cost a node.
 */
function decodeSearchVisibility(nodeType: string, wire: unknown, diags: Diagnostic[]): SearchVisibility | undefined {
  if (wire === undefined || wire === 'normal') return undefined
  if (typeof wire === 'string' && SEARCH_VISIBILITIES.has(wire)) return wire as SearchVisibility
  diags.push(diag('warning', 'schema', 'schema.dinkster.badSearchVisibility', `${nodeType}: unknown searchVisibility '${String(wire)}'; treating as normal`))
  return undefined
}

/** Malformed migration advice must not hide an otherwise valid current node. */
function decodeReplacements(nodeType: string, wire: unknown, diags: Diagnostic[]): readonly ReplacementRule[] | undefined {
  if (wire === undefined) return undefined
  if (!Array.isArray(wire)) {
    diags.push(diag('warning', 'schema', 'schema.dinkster.badReplacements', `${nodeType}: replacements is not an array`))
    return undefined
  }
  const rules: ReplacementRule[] = []
  for (const [i, rule] of wire.entries()) {
    if (isReplacementRule(rule)) rules.push(rule)
    else diags.push(diag('warning', 'schema', 'schema.dinkster.badReplacements', `${nodeType}: replacements[${i}] is malformed`))
  }
  return rules.length > 0 ? rules : undefined
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export interface DinksterParseResult {
  readonly schema: NodeSchema | undefined
  readonly diagnostics: readonly Diagnostic[]
}

/** Parse a full GET /api/nodes payload. */
export function parseDinksterNodes(payload: DinksterNodesPayload): {
  schemas: ReadonlyMap<string, NodeSchema>
  diagnostics: readonly Diagnostic[]
} {
  const schemas = new Map<string, NodeSchema>()
  const diagnostics: Diagnostic[] = []
  // Wire-format version: current backends carry it in the dinkster header
  // (schemaWire) and per node entry; TOP-LEVEL schemaVersion there is the
  // API surface version (1, a different axis). Payloads without the header
  // (older shape / fixtures) carried the wire version top-level instead.
  const wireVersion = serverInfoFromDinksterWire(payload)?.schemaWire ?? payload.schemaVersion
  if (wireVersion !== DINKSTER_SCHEMA_WIRE_VERSION) {
    diagnostics.push(
      diag(
        'error',
        'schema',
        'schema.dinkster.wireVersion',
        `unsupported Dinkster schema wire version ${String(wireVersion)}; this build speaks ${DINKSTER_SCHEMA_WIRE_VERSION}`,
      ),
    )
    return { schemas, diagnostics }
  }
  const nodes = typeof payload.nodes === 'object' && payload.nodes !== null ? (payload.nodes as Record<string, DinksterWireSchema>) : {}
  for (const [type, wire] of Object.entries(nodes)) {
    try {
      if (wire.schemaVersion !== undefined && wire.schemaVersion !== DINKSTER_SCHEMA_WIRE_VERSION) {
        diagnostics.push(
          diag(
            'error',
            'schema',
            'schema.dinkster.wireVersion',
            `${type}: unsupported schema wire version ${String(wire.schemaVersion)}`,
          ),
        )
        continue
      }
      if (wire.schemaVersion !== undefined && wire.schemaVersion !== wireVersion) {
        diagnostics.push(
          diag(
            'error',
            'schema',
            'schema.dinkster.wireVersion',
            `${type}: schema wire version ${String(wire.schemaVersion)} does not match payload version ${String(wireVersion)}`,
          ),
        )
        continue
      }
      const { schema, diagnostics: d } = parseDinksterSchema(type, wire)
      diagnostics.push(...d)
      if (schema) schemas.set(type, schema)
    } catch (e) {
      diagnostics.push(diag('error', 'schema', 'schema.parse.threw', `${type}: schema parse threw: ${e instanceof Error ? e.message : String(e)}`))
    }
  }
  return { schemas, diagnostics }
}

/**
 * Decode the top-level /api/nodes "packs" presentation table. Tolerant by
 * design: the backend already warn-and-drops malformed author declarations
 * at manifest load, so anything malformed HERE is a smuggled wire - drop
 * the field (or entry), never fail schema fetch over a bad emoji.
 * displayName falls back to the pack id (backend contract sends it always;
 * the fallback keeps the table total for badge/tooltip consumers).
 */
export function packsFromDinksterWire(payload: DinksterNodesPayload): ReadonlyMap<string, PackInfo> {
  const out = new Map<string, PackInfo>()
  const wireVersion = serverInfoFromDinksterWire(payload)?.schemaWire ?? payload.schemaVersion
  const table = typeof payload.packs === 'object' && payload.packs !== null && !Array.isArray(payload.packs) ? (payload.packs as Record<string, unknown>) : {}
  for (const [packId, raw] of Object.entries(table)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const e = raw as {
      displayName?: unknown
      abbr?: unknown
      mark?: unknown
      color?: unknown
      icon?: unknown
      version?: unknown
      artifactDigest?: unknown
      source?: unknown
      publisher?: unknown
      assets?: unknown
      blueprints?: unknown
      locales?: unknown
      settings?: unknown
    }
    const opt = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
    const abbr = opt(e.abbr)
    const mark = opt(e.mark)
    const color = opt(e.color)
    const version = opt(e.version)
    const artifactDigest = opt(e.artifactDigest)
    const source = opt(e.source)
    const publisher = opt(e.publisher)
    let locales: Readonly<Record<string, string>> | undefined
    if (typeof e.locales === 'object' && e.locales !== null && !Array.isArray(e.locales)) {
      const decoded = Object.entries(e.locales).filter(
        (entry): entry is [string, string] =>
          /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/.test(entry[0]) && typeof entry[1] === 'string' && /^sha256:[0-9a-f]{64}$/.test(entry[1]),
      )
      if (decoded.length > 0) locales = Object.fromEntries(decoded)
    }
    const assets: PackAssetDescriptor[] = []
    if (Array.isArray(e.assets)) {
      for (const rawAsset of e.assets) {
        if (typeof rawAsset !== 'object' || rawAsset === null || Array.isArray(rawAsset)) continue
        const a = rawAsset as Record<string, unknown>
        const id = opt(a['id'])
        const name = opt(a['name'])
        const digest = opt(a['digest'])
        if (id === undefined || name === undefined || digest === undefined) continue
        const strings = (v: unknown): readonly string[] | undefined => {
          if (!Array.isArray(v)) return undefined
          const kept = v.filter((s): s is string => typeof s === 'string' && s !== '')
          return kept.length > 0 ? kept : undefined
        }
        const sources: PackAssetSource[] = []
        if (Array.isArray(a['sources'])) {
          for (const rawSource of a['sources']) {
            if (typeof rawSource !== 'object' || rawSource === null || Array.isArray(rawSource)) continue
            const source = rawSource as Record<string, unknown>
            if (source['type'] === 'packaged') {
              const pack = opt(source['pack'])
              const path = opt(source['path'])
              if (pack !== undefined && path !== undefined) sources.push({ type: 'packaged', pack, path })
            } else if (source['type'] === 'remote') {
              const url = opt(source['url'])
              if (url !== undefined) sources.push({ type: 'remote', url })
            }
          }
        }
        const kind = opt(a['kind'])
        const mediaType = opt(a['mediaType'])
        const size = typeof a['size'] === 'number' && Number.isInteger(a['size']) && a['size'] >= 0 ? a['size'] : undefined
        const metadata =
          typeof a['metadata'] === 'object' && a['metadata'] !== null && !Array.isArray(a['metadata']) ? (a['metadata'] as Record<string, unknown>) : undefined
        const nodes = strings(a['nodes'])
        assets.push({
          id,
          name,
          digest,
          ...(kind !== undefined ? { kind } : {}),
          ...(size !== undefined ? { size } : {}),
          ...(mediaType !== undefined ? { mediaType } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
          ...(sources.length > 0 ? { sources } : {}),
          ...(nodes !== undefined ? { nodes } : {}),
        })
      }
    }
    // Icon descriptor: digest + mediaType, both nonempty strings, or the
    // field drops whole - a half-formed descriptor must never trigger a
    // fetch keyed by a bogus digest.
    let icon: PackIcon | undefined
    if (typeof e.icon === 'object' && e.icon !== null && !Array.isArray(e.icon)) {
      const i = e.icon as { digest?: unknown; mediaType?: unknown }
      const digest = opt(i.digest)
      const mediaType = opt(i.mediaType)
      if (digest !== undefined && mediaType !== undefined) icon = { digest, mediaType }
    }
    // Blueprint descriptors: id + name + digest required, or the entry
    // drops alone (a descriptor without a digest can never key a body
    // fetch or a cache). Optional fields stay omitted, never synthesized;
    // boundary hints keep only well-formed string members - they are
    // author declarations the backend passes through verbatim.
    const blueprints: PackBlueprintDescriptor[] = []
    if (Array.isArray(e.blueprints)) {
      for (const rawBp of e.blueprints) {
        if (typeof rawBp !== 'object' || rawBp === null || Array.isArray(rawBp)) continue
        const b = rawBp as {
          id?: unknown
          name?: unknown
          description?: unknown
          tags?: unknown
          digest?: unknown
          boundaryInputs?: unknown
          boundaryOutputs?: unknown
        }
        const id = opt(b.id)
        const name = opt(b.name)
        const digest = opt(b.digest)
        if (id === undefined || name === undefined || digest === undefined) continue
        const strings = (v: unknown): readonly string[] | undefined => {
          if (!Array.isArray(v)) return undefined
          const kept = v.filter((s): s is string => typeof s === 'string' && s !== '')
          return kept.length > 0 ? kept : undefined
        }
        const description = opt(b.description)
        const tags = strings(b.tags)
        const boundaryInputs = strings(b.boundaryInputs)
        const boundaryOutputs = strings(b.boundaryOutputs)
        blueprints.push({
          id,
          name,
          digest,
          ...(description !== undefined ? { description } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(boundaryInputs !== undefined ? { boundaryInputs } : {}),
          ...(boundaryOutputs !== undefined ? { boundaryOutputs } : {}),
        })
      }
    }
    out.set(packId, {
      displayName: opt(e.displayName) ?? packId,
      ...(abbr !== undefined ? { abbr } : {}),
      ...(mark !== undefined ? { mark } : {}),
      ...(color !== undefined && /^#[0-9a-fA-F]{6}$/.test(color) ? { color } : {}),
      ...(icon !== undefined ? { icon } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(artifactDigest !== undefined ? { artifactDigest } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(publisher !== undefined ? { publisher } : {}),
      ...(assets.length > 0 ? { assets } : {}),
      ...(blueprints.length > 0 ? { blueprints } : {}),
      ...(locales !== undefined ? { locales } : {}),
      ...(e.settings === true ? { settings: true as const } : {}),
    })
  }
  return out
}

/**
 * Decode the /api/nodes "dinkster" server-identity header. Absent or
 * malformed -> undefined (older backend); never a diagnostic - the header
 * only feeds advisory environment stamps.
 */
export function serverInfoFromDinksterWire(payload: DinksterNodesPayload): {
  readonly version: string
  readonly schemaWire: number
  readonly services?: { readonly name: 'production' | 'qa' | 'custom' }
} | undefined {
  const d = payload.dinkster
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return undefined
  const h = d as { version?: unknown; schemaWire?: unknown; services?: unknown }
  if (typeof h.version !== 'string' || h.version === '' || typeof h.schemaWire !== 'number') return undefined
  const name = h.services && typeof h.services === 'object' && !Array.isArray(h.services)
    ? (h.services as { name?: unknown }).name : undefined
  return { version: h.version, schemaWire: h.schemaWire,
    ...(name === 'production' || name === 'qa' || name === 'custom' ? { services: { name } } : {}) }
}

/**
 * Decode the /api/nodes "dinkster" header's graphFeatures flags (additive
 * capability negotiation for the GRAPH document wire, decoupled from
 * schemaWire; Dinkster ea6eca7). Unlike the identity header this IS
 * load-bearing: it gates lowering forms the target server may not decode
 * (e.g. 'typedLiteral' - see DINKSTER_GRAPH_FEATURE_TYPED_LITERAL). Absent or
 * malformed -> undefined (older backend, emit none); non-string entries are
 * dropped, never a diagnostic - unknown future flags pass through unread.
 */
export function graphFeaturesFromDinksterWire(payload: DinksterNodesPayload): readonly string[] | undefined {
  const d = payload.dinkster
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return undefined
  const raw = (d as { graphFeatures?: unknown }).graphFeatures
  if (!Array.isArray(raw)) return undefined
  return raw.filter((f): f is string => typeof f === 'string')
}

/**
 * Decode the /api/nodes "dinkster" header's mergeableTypes list (additive,
 * joint contract 2026-07-26, Dinkster 6dbbddd): the sorted ATOM type ids with a
 * registered batch-merge provider (list<T> -> one batched T), derived from
 * the composed registry at envelope build time. PRESENTATION gating only -
 * the widget layer offers the multi-select merge arm on membership; the
 * backend coercion planner stays the enforcement point, so a stale list can
 * only under/over-OFFER multi-select until refetch, never execute anything
 * invalid. Absent or malformed -> undefined (older backend, merge arm off);
 * non-string entries are dropped silently, mirroring graphFeatures.
 */
export function mergeableTypesFromDinksterWire(payload: DinksterNodesPayload): readonly string[] | undefined {
  const d = payload.dinkster
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return undefined
  const raw = (d as { mergeableTypes?: unknown }).mergeableTypes
  if (!Array.isArray(raw)) return undefined
  return raw.filter((f): f is string => typeof f === 'string')
}
