/**
 * Legacy litegraph workflow importer: translate, never support.
 *
 * The old frontend's format is positional at its core: `widgets_values` is a
 * bare array whose meaning depends entirely on the schema the workflow was
 * saved under. This importer maps those positions onto ID-keyed values using
 * the CURRENT schema and surfaces every mismatch as a review diagnostic
 * instead of silently misassigning values (architecture section 16, risk 8).
 *
 * Translations, not features:
 * - node modes: 0/1 -> active (1 was ON_EVENT, unused), 2 -> muted, 4 -> bypassed
 * - seed-style controllers: `control_after_generate` widgets serialize as an
 *   EXTRA positional entry after their value; imported into node.controllers
 * - Reroute nodes: preserved as first-class reroutes (topology + position);
 *   chains fed by GetNodes collapse into net sinks since nets are port-only
 * - KJNodes SetNode/GetNode pairs: converted to named nets (first-class here)
 * - frontend PrimitiveNode: converted to the primitive node a wire dragged
 *   off its first consumer's field makes (Int, Float, Text, Boolean, Choice,
 *   or the general Primitive), with value and controller from
 *   widgets_values. Backend PrimitiveInt/Float/... are ordinary compute
 *   nodes and import as nodes.
 * - Note/MarkdownNote nodes: translated to frontend virtual nodes
 * - groups: imported as view groups
 * - node sizes are not imported for executable nodes; note geometry is
 *   presentation authored by the user and is preserved
 */

import { canonicalJson } from '../compile/hash.js'
import { diag, type Diagnostic } from '../diagnostics.js'
import {
  allRowsOf,
  inputsOf,
  isAssetWidgetInput,
  outputsOf,
  scopeRowsOf,
  type BodyRow,
  type ChoiceSpec,
  type GroupSpec,
  type InputSpec,
  type NodeSchema,
  type OptionRow,
} from '../schema/model.js'
import { applyUse, keyPosition, memberKeyAt, memberLimitOf, memberRowsOf } from '../schema/body.js'
import { EMPTY_CONNECTIVITY, elaborateInterface, elabInputsOf, elabOutputsOf } from '../schema/elaborate.js'
import {
  FORMAT_VERSION,
  type ControllerMode,
  type DynamicPortState,
  type GraphDef,
  type GroupViewState,
  type Json,
  type JsonObject,
  type NodeViewState,
  type WorkflowDocument,
} from './document.js'
import { ownJson } from './json.js'
import { validateDocumentShape } from './validate.js'
import { checkDocument } from '../invariants.js'
import { isPortEndpoint } from '../ids.js'
import { isAssetRefValue } from '../schema/widget-defaults.js'
import { primitiveForField, primitiveOf } from '../primitive.js'
import { importLitegraphSubgraphs } from './import-litegraph-subgraphs.js'
import { convertLitegraphListConsumers } from './import-litegraph-loops.js'
import { createTransactionBuilder } from '../commands/contract.js'
import { REPLACE_COMMANDS } from '../commands/replace-commands.js'
import { planReplacement } from '../replace/plan.js'
import type { ReplacementRule } from '../replace/model.js'

// -- litegraph wire shapes (loose: this is foreign, hostile JSON) ------------

interface LgNode {
  readonly id: number
  readonly type: string
  readonly title?: string
  readonly flags?: JsonObject
  readonly pos?: readonly number[] | Readonly<Record<string, number>>
  readonly size?: readonly number[] | Readonly<Record<string, number>>
  readonly mode?: number
  readonly inputs?: ReadonlyArray<{
    readonly name?: string
    readonly type?: Json
    readonly link?: number | null
    readonly widget?: { readonly name?: string }
  }>
  readonly outputs?: ReadonlyArray<{
    readonly name?: string
    readonly type?: Json
    readonly links?: readonly number[] | null
  }>
  readonly widgets_values?: readonly Json[] | Readonly<Record<string, Json>>
  readonly properties?: JsonObject
  readonly color?: string
  readonly bgcolor?: string
}

/** Widget upgrades are keyed by class name, then the saved node properties.ver. */
export type ComfyNodeUpgradeTable = ReadonlyMap<string, ReadonlyMap<string,
  (values: LgNode['widgets_values']) => NonNullable<LgNode['widgets_values']>
>>

/** Saved source versions whose widget streams predate the current node schema. */
export const COMFY_NODE_UPGRADES: ComfyNodeUpgradeTable = new Map([
  ['SaveVideo', new Map([
    ['0.3.68', (values: LgNode['widgets_values']) => {
      if (!Array.isArray(values) || values.length !== 3 || !['auto', 'h264', 'av1'].includes(values[2] as string)) return values ?? []
      // Older streams omit both the codec's encoding mode and the optional
      // top-level codec fallback. Store their automatic choices explicitly.
      return [...values, ...(values[2] === 'auto' ? [] : ['auto']), 'auto']
    }],
  ])],
  ['ResizeImagesByLongerEdge', new Map([
    ['0.5.1', (values: LgNode['widgets_values']) => {
      if (!Array.isArray(values) || values.length !== 1 || !Number.isSafeInteger(values[0])) return values ?? []
      return { longer_edge: values[0]! }
    }],
  ])],
])

/** [id, fromNode, fromSlot, toNode, toSlot, type] */
type LgLink = readonly [number, number, number, number, number, ...unknown[]]

interface LgWire {
  fromNode: number
  fromSlot: number
  toNode: number
  toSlot: number
  type?: Json
}

const CONTROLLER_MODES: ReadonlySet<string> = new Set(['fixed', 'increment', 'decrement', 'randomize'])
const MAX_UE_LINKS = 1024

/** Frontend-only litegraph node types with dedicated translations. */
const REROUTE_TYPES = new Set(['Reroute'])
const NOTE_TYPES = new Set(['Note', 'MarkdownNote'])
const SET_TYPES = new Set(['SetNode'])
const GET_TYPES = new Set(['GetNode'])
const PRIMITIVE_TYPES = new Set(['PrimitiveNode'])
const UE_SEED_CONTROLLER_TYPE = 'Seed Everywhere'
const UE_CONTROLLER_TYPES = new Set([
  'Anything Everywhere', 'Anything Everywhere3', 'Anything Everywhere?',
  'Prompts Everywhere', UE_SEED_CONTROLLER_TYPE,
])
const UE_INPUT_CONTROLLER_TYPES = new Set(
  [...UE_CONTROLLER_TYPES].filter((type) => type !== UE_SEED_CONTROLLER_TYPE),
)
const isUeController = (node: LgNode): boolean =>
  UE_CONTROLLER_TYPES.has(node.type) || node.properties?.['ue_convert'] === true
const isUeBroadcastInput = (type: string, slot: number): boolean => {
  if (type === 'Anything Everywhere?') return slot === 0
  if (type === 'Anything Everywhere3') return slot <= 2
  if (type === 'Prompts Everywhere') return slot <= 1
  return type === 'Anything Everywhere'
}

interface UeLink {
  readonly downstream: number
  readonly downstreamSlot: number
  readonly upstream: number
  readonly upstreamSlot: number
  readonly controller: number
  readonly type: string
}

export interface ImportLitegraphResult {
  /** Present only when there are no error-level diagnostics. */
  readonly document?: WorkflowDocument
  readonly diagnostics: readonly Diagnostic[]
}

/** Import-only interfaces never join the installed schema registry. */
export interface ComfyTranslation {
  readonly source?: string
  readonly pack?: string
  readonly version?: string
  readonly rule: ReplacementRule
  readonly schema: NodeSchema
  readonly interfaces?: readonly NodeSchema[]
}

export interface ImportedNodePackResolution {
  readonly graphId: string
  readonly nodeId: string
  readonly type: string
  readonly sourceClass: string
  readonly status: 'installed' | 'installable' | 'unknown'
  readonly pack?: string
  readonly version?: string
}

/** Recompute after registry changes; the imported document is not rewritten. */
export function resolveImportedNodePacks(
  document: WorkflowDocument,
  resolve: (type: string) => NodeSchema | undefined,
): readonly ImportedNodePackResolution[] {
  return Object.entries(document.graphs).flatMap(([graphId, graph]) =>
    Object.values(graph.nodes).map((node): ImportedNodePackResolution => {
      const metadata = node.ext?.['importer.comfyTranslation']
      const translation = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata as JsonObject : undefined
      const pack = typeof translation?.['pack'] === 'string' ? translation['pack'] : undefined
      const version = typeof translation?.['version'] === 'string' ? translation['version'] : undefined
      const sourceClass = typeof translation?.['sourceClass'] === 'string' ? translation['sourceClass'] : node.type
      const installed = node.virtual === true || resolve(node.type)?.type === node.type ||
        (node.type.startsWith('#') && document.graphs[node.type.slice(1)] !== undefined)
      return {
        graphId, nodeId: node.id, type: node.type, sourceClass,
        status: installed ? 'installed' : pack !== undefined ? 'installable' : 'unknown',
        ...(pack !== undefined ? { pack } : {}),
        ...(version !== undefined ? { version } : {}),
      }
    }),
  )
}

const imp = (severity: 'error' | 'warning' | 'info', code: string, message: string): Diagnostic =>
  diag(severity, 'import', code, message)

interface PositionalWidgetDecode {
  readonly values: Record<string, Json>
  readonly controllers: Record<string, ControllerMode>
  readonly dynamic: Record<string, DynamicPortState & JsonObject>
  index: number
  stopped: boolean
}

/**
 * A group of an active scope. Its flattened id is also its ComfyUI wire
 * scope: a member of a group of values is `<group>.<key>` and a row of a
 * member of records `<group>.<key>.<row>` on both sides.
 */
interface GroupImport {
  readonly path: string
  readonly group: GroupSpec
}

interface GroupWireMatch {
  readonly family: GroupImport
  readonly memberKey: string
  readonly slot: InputSpec
}

interface DiscoveredGroupMembers {
  readonly order: ReadonlyMap<string, readonly string[]>
  readonly slots: ReadonlyMap<number, { readonly match: GroupWireMatch; readonly memberId: string }>
}

function normalizeLegacyWidgetValue(
  item: InputSpec,
  value: Json,
): Json | undefined {
  if (value === '' && item.optional && isAssetWidgetInput(item) && item.widget?.selection !== true) return undefined
  if (typeof value !== 'string') return value
  const floating = item.widget?.widgetType === 'FLOAT'
  if (item.widget?.widgetType === 'INT' || floating) {
    const numericText = value.trim()
    const numeric = Number(numericText)
    const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(numericText)
    if (
      decimal &&
      Number.isFinite(numeric) &&
      (floating || Number.isSafeInteger(numeric))
    ) return numeric
    return value
  }
  return value
}

/** A choice's shared rows by id, for the Use rows of its options. */
const sharedRowsOf = (choice: ChoiceSpec): ReadonlyMap<string, BodyRow> =>
  new Map(scopeRowsOf(choice.shared).flatMap((item) =>
    item.kind === 'use' || item.kind === 'row' || item.kind === 'section' ? [] : [[item.id, item as BodyRow] as const]))

/** A row of a scope that is not layout. */
type PlacedRow = Exclude<BodyRow, { readonly kind: 'row' } | { readonly kind: 'section' }>

/** The rows of one scope in declared order, with each Use placed from the shared rows. */
const placedRows = (rows: readonly OptionRow[], shared?: ReadonlyMap<string, BodyRow>): readonly PlacedRow[] =>
  scopeRowsOf(rows).flatMap((raw): PlacedRow[] => {
    if (raw.kind === 'use') {
      const row = shared?.get(raw.id)
      const placed = row === undefined ? undefined : applyUse(row, raw)
      return placed === undefined || placed.kind === 'row' || placed.kind === 'section' ? [] : [placed]
    }
    return raw.kind === 'row' || raw.kind === 'section' ? [] : [raw]
  })

/** A row that is a box holding other rows. */
const isBox = (row: PlacedRow): boolean =>
  row.kind === 'group' || row.kind === 'choice' || row.kind === 'typeChoice' || row.kind === 'described'

/** Member state for imported members: their keys, and the next number a numbered group hands out. */
const importedGroupState = (group: GroupSpec, members: readonly string[]): DynamicPortState & JsonObject => {
  const positions = group.keys.kind === 'numbered'
    ? members.map((member) => keyPosition(group.keys, member)).filter((position): position is number => position !== undefined)
    : []
  return { members, ...(positions.length > 0 ? { seq: Math.max(...positions) + 1 } : {}) }
}

function decodeKeyedWidgets(
  rows: readonly PlacedRow[],
  raw: Readonly<Record<string, Json>>,
  state: PositionalWidgetDecode,
  prefix: string,
  known: Set<string>,
): void {
  for (const row of rows) {
    const path = prefix + row.id
    if (row.kind === 'input') {
      if (row.widget === undefined || !Object.prototype.hasOwnProperty.call(raw, path)) continue
      known.add(path)
      const value = normalizeLegacyWidgetValue(row, raw[path]!)
      if (value !== undefined) state.values[path] = value
    } else if (row.kind === 'choice' && row.leader === undefined) {
      const selected = raw[path]
      const option = typeof selected === 'string'
        ? row.options.find((candidate) => candidate.key === selected)
        : undefined
      if (option === undefined) continue
      known.add(path)
      state.dynamic[path] = { selected: option.key }
      decodeKeyedWidgets(placedRows(option.rows, sharedRowsOf(row)), raw, state, `${path}.`, known)
    } else if (row.kind === 'group') {
      const members = (state.dynamic[path] as { readonly members?: readonly string[] } | undefined)?.members ?? []
      for (const member of members) {
        if (row.value === undefined) {
          decodeKeyedWidgets(placedRows(row.member ?? []), raw, state, `${path}.${member}.`, known)
          continue
        }
        const key = `${path}.${member}`
        if (row.value.kind !== 'input' || row.value.widget === undefined || row.value.forceInput === true ||
          !Object.prototype.hasOwnProperty.call(raw, key)) continue
        known.add(key)
        const value = normalizeLegacyWidgetValue(row.value, raw[key]!)
        if (value !== undefined) state.values[key] = value
      }
    }
  }
}

/** The groups of the scopes a node's stored choices make active. */
function activeGroups(
  rows: readonly PlacedRow[],
  dynamic: Readonly<Record<string, Json>>,
  prefix = '',
): GroupImport[] {
  const groups: GroupImport[] = []
  for (const row of rows) {
    const path = prefix + row.id
    if (row.kind === 'group') {
      groups.push({ path, group: row })
      continue
    }
    if (row.kind !== 'choice' || row.leader !== undefined) continue
    const selected = (dynamic[path] as { readonly selected?: unknown } | undefined)?.selected
    const option = typeof selected === 'string'
      ? row.options.find((candidate) => candidate.key === selected)
      : undefined
    if (option !== undefined) groups.push(...activeGroups(placedRows(option.rows, sharedRowsOf(row)), dynamic, `${path}.`))
  }
  return groups
}

/** Match only names the group's naming rule and member rows can make. */
function matchGroupWire(
  name: string,
  family: GroupImport,
): GroupWireMatch | undefined {
  const prefix = `${family.path}.`
  if (!name.startsWith(prefix)) return undefined
  const relative = name.slice(prefix.length)
  const { group } = family
  const limit = memberLimitOf(group)
  const memberAt = (key: string): boolean => {
    const position = keyPosition(group.keys, key)
    return position !== undefined && position < limit
  }
  if (group.value !== undefined) {
    return group.value.kind === 'input' && !relative.includes('.') && memberAt(relative)
      ? { family, memberKey: relative, slot: group.value }
      : undefined
  }
  const inputs = placedRows(group.member ?? []).filter((row): row is InputSpec => row.kind === 'input')
  const dot = relative.indexOf('.')
  if (dot > 0) {
    const key = relative.slice(0, dot)
    const slot = inputs.find((input) => input.id === relative.slice(dot + 1))
    return slot !== undefined && memberAt(key) ? { family, memberKey: key, slot } : undefined
  }
  // The flat ComfyUI form `<row><N>` names the member at number N.
  if (group.keys.kind !== 'numbered') return undefined
  for (const slot of inputs) {
    const ordinalText = new RegExp(`^${escapeRegExp(slot.id)}([0-9]+)$`).exec(relative)?.[1]
    if (ordinalText === undefined) continue
    const position = Number(ordinalText) - group.keys.start
    if (ordinalText !== String(Number(ordinalText)) || !Number.isSafeInteger(position) || position < 0 || position >= limit) return undefined
    return { family, memberKey: memberKeyAt(group.keys, position)!, slot }
  }
  return undefined
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Members in the order the serialized inputs first name them: a member's
 * shown number is its position, so a foreign number is a key, never a sort
 * key. Then each group gets its minimum of members.
 */
const discoverGroupMembers = (
  inputs: readonly { readonly name?: string }[],
  families: readonly GroupImport[],
  targetedSlots: ReadonlySet<number>,
): DiscoveredGroupMembers => {
  const order = new Map<string, string[]>()
  const slots = new Map<number, { match: GroupWireMatch; memberId: string }>()
  for (const [slotIndex, input] of inputs.entries()) {
    if (typeof input.name !== 'string') continue
    const candidates = families
      .map((family) => matchGroupWire(input.name!, family))
      .filter((candidate): candidate is GroupWireMatch => candidate !== undefined)
    if (candidates.length !== 1) continue
    const match = candidates[0]!
    const rows = placedRows(memberRowsOf(match.family.group))
    if (!targetedSlots.has(slotIndex) && !rows.some((row) => isBox(row) || (row.kind === 'input' && row.widget !== undefined))) continue
    let members = order.get(match.family.path)
    if (members === undefined) order.set(match.family.path, (members = []))
    if (!members.includes(match.memberKey)) members.push(match.memberKey)
    slots.set(slotIndex, { match, memberId: match.memberKey })
  }
  for (const { path, group } of families) {
    let members = order.get(path)
    if (members === undefined) order.set(path, (members = []))
    const first = placedRows(memberRowsOf(group))[0]
    if (group.optionalAfterMinimum === true && first?.kind === 'input' && first.optional) continue
    for (let index = 0; members.length < group.minMembers && index < memberLimitOf(group); index++) {
      const key = memberKeyAt(group.keys, index)
      if (key !== undefined && !members.includes(key)) members.push(key)
    }
  }
  return { order, slots }
}

const decodePositionalFamilyWidgets = (
  family: GroupImport,
  members: readonly string[],
  raw: readonly Json[],
  state: PositionalWidgetDecode,
  nodeLabel: string,
  diags: Diagnostic[],
): void => {
  const { group } = family
  for (const member of members) {
    const rows = group.value !== undefined ? [group.value] : placedRows(group.member ?? [])
    for (const item of rows) {
      if (isBox(item)) {
        state.stopped = true
        diags.push(imp('warning', 'import.dynamic.autogrowUnsupported', `${nodeLabel}: group '${family.path}' has a box inside its members; remaining positional values kept for review`))
        return
      }
      if (item.kind !== 'input') continue
      if (item.type.kind === 'concrete' && item.type.name === 'RESOLUTION_PREVIEW') continue
      if (item.widget === undefined || item.forceInput === true) continue
      const key = group.value !== undefined ? `${family.path}.${member}` : `${family.path}.${member}.${item.id}`
      if (state.index >= raw.length) {
        diags.push(imp('warning', 'import.widgets.missing', `${nodeLabel}: no positional value for widget '${key}'; schema default applies`))
        continue
      }
      const value = normalizeLegacyWidgetValue(item, raw[state.index++] as Json)
      if (value !== undefined) state.values[key] = value
      if (item.widget.controller !== undefined && state.index < raw.length) {
        const mode = raw[state.index]
        if (typeof mode === 'string' && CONTROLLER_MODES.has(mode)) {
          state.controllers[key] = mode as ControllerMode
          state.index++
        }
      }
    }
  }
}

/** A row that takes positions in ComfyUI's ordered widget stream. */
/**
 * The top-level rows in positional widget order. A save mount was appended
 * after the node's original widgets, so it takes the last position even
 * where the body draws it beside the filename prefix.
 */
const positionalRowsOf = (schema: NodeSchema): PlacedRow[] => {
  const rows = placedRows(schema.body)
  const mount = (row: PlacedRow): boolean => row.kind === 'input' && row.id === 'mount'
  return [...rows.filter((row) => !mount(row)), ...rows.filter(mount)]
}

const takesPositions = (row: PlacedRow): boolean =>
  !(row.kind === 'input' && row.type.kind === 'concrete' && row.type.name === 'RESOLUTION_PREVIEW') &&
  (row.kind === 'choice' || (row.kind === 'input' && row.widget !== undefined && row.forceInput !== true) ||
    // A group of outputs or pins has no widgets to take positions.
    (row.kind === 'group' && placedRows(memberRowsOf(row)).some((item) => isBox(item) || takesPositions(item))))

/**
 * Decode ComfyUI's ordered widget stream without elaborating a partial node.
 * A choice's stored key determines which option's rows own the following
 * positions. Groups consume the members already reconstructed from the
 * serialized LiteGraph input order.
 */
function decodePositionalWidgets(
  rows: readonly PlacedRow[],
  raw: readonly Json[],
  state: PositionalWidgetDecode,
  prefix: string,
  nodeLabel: string,
  diags: Diagnostic[],
  following: readonly PlacedRow[] = [],
): void {
  for (const [index, row] of rows.entries()) {
    if (state.stopped) return
    const key = prefix + row.id

    // A choice's dropdown owns one position, before the chosen option's rows.
    if (row.kind === 'choice') {
      if (row.leader !== undefined) {
        state.stopped = true
        diags.push(imp('warning', 'import.dynamic.ledChoice', `${nodeLabel}: choice '${key}' is led by a formula, which a positional widget stream cannot follow; remaining positional values kept for review`))
        return
      }
      const rest = [...rows.slice(index + 1), ...following]
      if (state.index >= raw.length) {
        diags.push(imp('warning', 'import.widgets.missing', `${nodeLabel}: no positional value for dynamic selector '${key}'; schema default applies`))
        const fallback = row.default ?? row.options[0]?.key
        const branch = row.options.find((option) => option.key === fallback)
        if (branch) decodePositionalWidgets(placedRows(branch.rows, sharedRowsOf(row)), raw, state, `${key}.`, nodeLabel, diags, rest)
        continue
      }
      const selected = raw[state.index++]
      const branch = typeof selected === 'string'
        ? row.options.find((option) => option.key === selected)
        : undefined
      if (branch === undefined) {
        state.stopped = true
        diags.push(imp('warning', 'import.dynamic.unknownSelector', `${nodeLabel}: dynamic selector '${key}' has unknown option ${JSON.stringify(selected)}; schema default applies and remaining positional values were kept for review`))
        return
      }
      state.dynamic[key] = { selected: branch.key }
      decodePositionalWidgets(placedRows(branch.rows, sharedRowsOf(row)), raw, state, `${key}.`, nodeLabel, diags, rest)
      continue
    }

    if (row.kind === 'group') {
      if (!takesPositions(row)) continue
      const members = (state.dynamic[key] as { readonly members?: readonly string[] } | undefined)?.members
      if (members === undefined) {
        state.stopped = true
        diags.push(imp('warning', 'import.dynamic.autogrowUnsupported', `${nodeLabel}: group '${key}' cannot be reconstructed; remaining positional values kept for review`))
        return
      }
      decodePositionalFamilyWidgets({ path: key, group: row }, members, raw, state, nodeLabel, diags)
      continue
    }

    // Current ComfyUI does not materialize forceInput parameters as widgets,
    // so they consume no positional widgets_values entry. Older workflows
    // that serialized one remain loud as excess rather than shifting every
    // later widget onto the wrong semantic input.
    if (row.kind !== 'input' || !takesPositions(row) || row.widget === undefined) continue
    if (state.index >= raw.length) {
      diags.push(imp('warning', 'import.widgets.missing', `${nodeLabel}: no positional value for widget '${key}'; schema default applies`))
      continue
    }
    const value = normalizeLegacyWidgetValue(row, raw[state.index++] as Json)
    if (value !== undefined) state.values[key] = value
    if (row.widget.controller !== undefined && state.index < raw.length) {
      const mode = raw[state.index]
      if (typeof mode === 'boolean') {
        const next = [...rows.slice(index + 1), ...following].find(takesPositions)
        if (next !== undefined && (next.kind !== 'input' || next.type.kind !== 'concrete' || next.type.name === 'BOOLEAN')) {
          state.stopped = true
          diags.push(imp('error', 'import.controller.ambiguousBoolean', `${nodeLabel}: boolean after '${key}' could be a controller or the next widget value; use an explicit controller mode or a versioned widget upgrade`))
          return
        }
      }
      if (typeof mode === 'boolean' || (typeof mode === 'string' && CONTROLLER_MODES.has(mode))) {
        state.controllers[key] = typeof mode === 'boolean' ? (mode ? 'randomize' : 'fixed') : mode as ControllerMode
        state.index++
      }
      // Not a controller value: leave it for the next widget rather than
      // guessing, including for widgets nested under a choice's option.
    }
  }
}

/** Save Video's rows that ComfyUI's widget stream fills, found by id. */
interface SaveVideoRows {
  readonly prefix: PlacedRow
  readonly format: ChoiceSpec
  readonly mount?: PlacedRow
}

/**
 * Save Video's rows when the served node has exactly the filename prefix,
 * the format choice and an optional save mount taking positions; any other
 * layout decodes in plain order.
 */
const saveVideoRowsOf = (schema: NodeSchema): SaveVideoRows | undefined => {
  const rows = positionalRowsOf(schema).filter(takesPositions)
  const prefix = rows.find((row) => row.id === 'filename_prefix')
  const format = rows.find((row) => row.id === 'format')
  const mount = rows.find((row) => row.id === 'mount')
  if (prefix?.kind !== 'input' || prefix.type.kind !== 'concrete' || prefix.type.name !== 'STRING' ||
    prefix.widget?.widgetType !== 'STRING' || prefix.widget.controller !== undefined) return undefined
  if (format?.kind !== 'choice' || format.leader !== undefined) return undefined
  if (mount !== undefined && (mount.kind !== 'input' || !mount.optional || mount.widget?.controller !== undefined)) return undefined
  if (rows.length !== (mount === undefined ? 2 : 3)) return undefined
  return { prefix, format, ...(mount !== undefined ? { mount } : {}) }
}

/**
 * ComfyUI's Save Video stream holds the filename prefix, the format with its
 * rows, and then a hidden top-level codec with its rows, which this node does
 * not have. The hidden codec's values are read past and stored nowhere, so a
 * save mount appended after them still takes the last position.
 */
function decodeSaveVideoWidgets(
  rows: SaveVideoRows,
  raw: readonly Json[],
  state: PositionalWidgetDecode,
  nodeLabel: string,
  diags: Diagnostic[],
): void {
  decodePositionalWidgets([rows.prefix, rows.format], raw, state, '', nodeLabel, diags)
  const codec = sharedRowsOf(rows.format).get('codec')
  if (!state.stopped && codec?.kind === 'choice' && codec.options.some((option) => option.key === raw[state.index])) {
    const skipped: PositionalWidgetDecode = { values: {}, controllers: {}, dynamic: {}, index: state.index, stopped: false }
    decodePositionalWidgets([codec], raw, skipped, '', nodeLabel, [])
    state.index = skipped.index
  }
  if (!state.stopped && rows.mount !== undefined && state.index < raw.length) {
    decodePositionalWidgets([rows.mount], raw, state, '', nodeLabel, diags)
  }
}

const inputPortForSchema = (node: LgNode, slot: number, schema: NodeSchema): string | undefined => {
  const foreignInput = node.inputs?.[slot]
  if (foreignInput === undefined) return undefined
  const foreignName = foreignInput.name
  const widgetName = foreignInput.widget?.name
  const inputs = inputsOf(schema)
  const named = foreignInput.widget !== undefined
    ? inputs.find((input) => input.id === widgetName) ?? inputs.find((input) => input.id === foreignName)
    : inputs.find((input) => input.id === foreignName)
  if (named !== undefined) return named.id
  if (foreignInput.widget !== undefined) return widgetName ?? foreignName
  if (schema.source === 'subgraph') return foreignName
  const sockets = inputs.filter((input) => input.widget === undefined || input.forceInput === true)
  const ordinal = (node.inputs ?? [])
    .slice(0, slot + 1)
    .filter((input) => input.widget === undefined).length - 1
  return sockets[ordinal]?.id ?? foreignName
}

const staticOutputPortForSchema = (
  node: LgNode,
  slot: number,
  schema: NodeSchema,
  allowPositional: boolean,
): string | undefined => {
  const foreignName = node.outputs?.[slot]?.name
  if (typeof foreignName !== 'string' || foreignName.length === 0) return undefined
  const occurrence = (node.outputs ?? [])
    .slice(0, slot)
    .filter((output) => output.name === foreignName).length
  const outputs = outputsOf(schema)
  const exact = outputs.filter((output) => output.id === foreignName)
  if (exact.length > 0) return exact[occurrence]?.id
  if (schema.source === 'subgraph') return undefined
  const displayed = outputs.filter((output) => output.displayName === foreignName)
  if (displayed.length > 0) return displayed[occurrence]?.id
  const foldedName = foreignName.toLowerCase()
  const folded = outputs.filter((output) =>
    output.id.toLowerCase() === foldedName || output.displayName?.toLowerCase() === foldedName)
  if (folded.length > 0) return folded[occurrence]?.id
  // An output inside a box shifts the positions of the ones after it.
  if (!allowPositional || allRowsOf(schema.body).filter((row) => row.kind === 'output').length !== outputs.length) return undefined
  const positional = outputsOf(schema)[slot]
  return positional?.id
}

/** FNV-1a 32-bit hash, hex-encoded. Deterministic lineage for imports. */
const fnv1a = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Rule-local helper names may repeat across import hops, unlike graph IDs. */
function freshImportHelpers(rule: ReplacementRule, graph: GraphDef, nodeId: string): ReplacementRule {
  if (!rule.cases.some((branch) => Object.keys(branch.nodes ?? {}).length > 0)) return rule
  const occupied = new Set([
    graph.nodes, graph.links, graph.nets, graph.reroutes,
  ].flatMap((entities) => Object.keys(entities)))
  return { ...rule, cases: rule.cases.map((branch) => {
    if (branch.nodes === undefined) return branch
    const reserved = new Set(Object.keys(branch.nodes))
    const names = new Map<string, string>()
    for (const localId of Object.keys(branch.nodes)) {
      let fresh = localId
      let suffix = 1
      while (occupied.has(`${nodeId}:${fresh}`) || (fresh !== localId && reserved.has(fresh))) {
        fresh = `${localId}_${suffix++}`
      }
      reserved.add(fresh)
      names.set(localId, fresh)
    }
    const address = (value: string): string => {
      const colon = value.indexOf(':')
      if (colon < 0) return value
      const renamed = names.get(value.slice(0, colon))
      return renamed === undefined ? value : `${renamed}${value.slice(colon)}`
    }
    const keys = <T>(entries: Readonly<Record<string, T>>): Record<string, T> =>
      Object.fromEntries(Object.entries(entries).map(([key, value]) => [address(key), value]))
    return {
      ...branch,
      nodes: Object.fromEntries(Object.entries(branch.nodes).map(([key, value]) => [names.get(key)!, value])),
      ...(branch.inputs !== undefined ? { inputs: keys(branch.inputs) } : {}),
      ...(branch.outputs !== undefined ? { outputs: keys(branch.outputs) } : {}),
      ...(branch.slotVariants !== undefined ? { slotVariants: keys(branch.slotVariants) } : {}),
      ...(branch.inputFamilies !== undefined ? { inputFamilies: keys(branch.inputFamilies) } : {}),
      ...(branch.links !== undefined ? { links: branch.links.map((link) => ({ from: address(link.from), to: address(link.to) })) } : {}),
    }
  }) }
}

/**
 * Translate a legacy litegraph workflow into a v1 dinkster document. `resolve`
 * supplies the ordinary schemas used to decode each authored class.
 * Positional widget and port mapping is impossible without a schema, so
 * unresolved node types remain raw with their values parked under ext for
 * later review.
 */
export function importLitegraph(
  input: JsonObject,
  resolve: (type: string) => NodeSchema | undefined,
  upgrades: ComfyNodeUpgradeTable = COMFY_NODE_UPGRADES,
  translations: readonly ComfyTranslation[] = [],
  /** Installed schemas; a frontend PrimitiveNode becomes one of their primitives. */
  schemas: Iterable<NodeSchema> = [],
): ImportLitegraphResult {
  const primitives = [...schemas].filter((schema) => primitiveOf(schema) !== undefined)
  const ingress = ownJson(input)
  if (!ingress.ok) return { diagnostics: [imp('error', 'import.notJson', `workflow rejected: ${ingress.reason}`)] }
  const ambiguous = new Set<string>()
  const bySource = new Map<string, ComfyTranslation>()
  for (const record of translations) {
    const source = record.source ?? record.rule.from
    if (bySource.has(source)) ambiguous.add(source)
    bySource.set(source, record)
  }
  for (const source of ambiguous) bySource.delete(source)
  const importSchemas = new Map([...bySource].flatMap(([source, record]) => [
    [source, { ...record.schema, type: source }] as const,
    ...(record.interfaces ?? [record.schema]).map((schema) => [schema.type, schema] as const),
  ]))
  const resolveForImport = (type: string): NodeSchema | undefined => {
    const installed = resolve(type)
    return installed?.type === type ? installed : importSchemas.get(type)
  }
  const result = importLitegraphSubgraphs(ingress.value as JsonObject, (type) => {
    const schema = resolveForImport(type)
    return schema?.type === type ? schema : undefined
  }, (graph, localResolve, definitions) =>
    importLitegraphGraph(graph, localResolve, definitions, upgrades, primitives))
  if (!result.document) return result
  let document = result.document
  const diagnostics = [...result.diagnostics]
  for (const graph of Object.values(document.graphs)) for (const node of Object.values(graph.nodes)) {
    if (ambiguous.has(node.type)) diagnostics.push(imp('warning', 'import.translation.ambiguous', `node ${node.id} ('${node.type}'): multiple registry replacements; original node kept for review`))
  }
  for (const [graphId, graph] of Object.entries(document.graphs)) {
    const pending = Object.values(graph.nodes).map((node) => ({ nodeId: node.id as string, sources: [] as string[], sourceClass: node.type }))
    for (let index = 0; index < pending.length; index++) {
      const { nodeId, sources, sourceClass } = pending[index]!
      const node = document.graphs[graphId]!.nodes[nodeId]
      if (node === undefined) continue
      const record = bySource.get(node.type)
      if (record === undefined) continue
      // Helpers inherit ancestry too: fresh helper IDs must not evade cycle detection.
      if (sources.includes(node.type)) {
        diagnostics.push(imp('warning', 'import.translation.cycle', `translation cycle at '${node.type}' in ${graphId}/${nodeId}; node kept for review`))
        continue
      }
      const rule = freshImportHelpers({ ...record.rule, from: node.type }, document.graphs[graphId]!, node.id)
      const planned = planReplacement(document, graphId, node.id, rule, resolveForImport)
      // A failed translation is advisory: retain the editable imported node.
      diagnostics.push(...planned.diagnostics.map((entry) => ({ ...entry, severity: entry.severity === 'error' ? 'warning' as const : entry.severity })))
      if (planned.plan === undefined) continue
      const tx = createTransactionBuilder(document)
      const applied = REPLACE_COMMANDS.find((command) => command.id === 'node.replace')!.run(
        document, { plan: planned.plan } as unknown as Json, tx,
        { kind: 'initial', schemaResolverFor: () => resolveForImport },
      )
      diagnostics.push(...applied.map((entry) => ({ ...entry, severity: entry.severity === 'error' ? 'warning' as const : entry.severity })))
      if (applied.some((entry) => entry.severity === 'error')) continue
      const translated = tx.result().doc
      const translatedNode = translated.graphs[graphId]!.nodes[node.id]!
      tx.set(['graphs', graphId, 'nodes', node.id, 'ext'], {
        ...translatedNode.ext,
        'importer.comfyTranslation': { sourceClass,
          ...(record.pack !== undefined ? { pack: record.pack } : {}),
          ...(record.version !== undefined ? { version: record.version } : {}),
        },
      })
      document = tx.result().doc
      const ancestry = [...sources, node.type]
      if (translatedNode.type !== node.type) pending.push({ nodeId, sources: ancestry, sourceClass })
      for (const helper of planned.plan.createdNodes ?? []) {
        pending.push({ nodeId: helper.nodeId, sources: ancestry, sourceClass: helper.type })
      }
    }
  }
  const retained = ownJson({ ...document,
    lineage: `lg-${fnv1a(JSON.stringify(ingress.value))}` as WorkflowDocument['lineage'],
    ext: { ...document.ext, 'importer.comfyWorkflow': ingress.value },
  })
  if (!retained.ok) return { diagnostics: [...diagnostics, imp('error', 'import.notJson', `workflow provenance rejected: ${retained.reason}`)] }
  return { diagnostics, document: retained.value as unknown as WorkflowDocument }
}

export interface ImportedAssetLiteral {
  readonly graphId: string
  readonly nodeId: string
  readonly inputId: string
  readonly name: string
}

export interface ImportedAssetResolution {
  readonly document: WorkflowDocument
  readonly unresolved: readonly ImportedAssetLiteral[]
}

/** Replace legacy filename strings on native ASSET inputs from a trusted catalog lookup. */
export function resolveImportedAssetLiterals(
  document: WorkflowDocument,
  resolve: (type: string) => NodeSchema | undefined,
  assetForName: (name: string) => Json | undefined,
): ImportedAssetResolution {
  const unresolved: ImportedAssetLiteral[] = []
  const graphs = Object.fromEntries(Object.entries(document.graphs).map(([graphId, graph]) => {
    const nodes = Object.fromEntries(Object.entries(graph.nodes).map(([nodeId, node]) => {
      const schema = resolve(node.type)
      if (!schema) return [nodeId, node]
      let values: Record<string, Json> | undefined
      for (const item of inputsOf(schema)) {
        if (!isAssetWidgetInput(item) || item.widget?.selection === true) continue
        const value = node.values[item.id]
        if (typeof value !== 'string') continue
        const asset = assetForName(value)
        if (!isAssetRefValue(asset)) {
          unresolved.push({ graphId, nodeId, inputId: item.id, name: value })
          continue
        }
        values ??= { ...node.values }
        values[item.id] = asset as Json
      }
      return [nodeId, values === undefined ? node : { ...node, values }]
    })) as Record<string, GraphDef['nodes'][string]>
    // A primitive's value names an asset when every wire it drives ends on an asset field.
    for (const [nodeId, node] of Object.entries(nodes)) {
      const schema = resolve(node.type)
      const shape = schema && primitiveOf(schema)
      const value = shape && node.values[shape.value.id]
      if (shape === undefined || isAssetWidgetInput(shape.value) || typeof value !== 'string') continue
      const outgoing = Object.values(graph.links).filter((link) =>
        isPortEndpoint(link.from) && link.from.node === nodeId && link.from.port === shape.output.id)
      const targets = outgoing.flatMap((link) => {
        if (!isPortEndpoint(link.to)) return []
        const target = link.to
        const consumer = nodes[target.node]
        const consumerSchema = consumer === undefined ? undefined : resolve(consumer.type)
        const input = consumerSchema === undefined ? undefined : inputsOf(consumerSchema).find((item) => item.id === target.port)
        return input !== undefined && isAssetWidgetInput(input) && input.widget?.selection !== true
          ? [{ nodeId: target.node, inputId: target.port }]
          : []
      })
      if (targets.length === 0 || targets.length !== outgoing.length) continue
      const asset = assetForName(value)
      if (!isAssetRefValue(asset)) {
        unresolved.push(...targets.map((target) => ({ graphId, ...target, name: value })))
        continue
      }
      nodes[nodeId] = { ...node, values: { ...node.values, [shape.value.id]: asset as Json } }
    }
    return [graphId, { ...graph, nodes }]
  })) as WorkflowDocument['graphs']
  return { document: { ...document, graphs }, unresolved }
}

function importLitegraphGraph(
  input: JsonObject,
  resolve: (type: string) => NodeSchema | undefined,
  definitions: WorkflowDocument['graphs'],
  upgrades: ComfyNodeUpgradeTable,
  primitives: readonly NodeSchema[],
): ImportLitegraphResult {
  // Ownership boundary (CO1/CO9): the workflow is foreign input. Owning it
  // up front rejects accessors/proxies/cycles/non-finite numbers (e.g. an
  // Infinity widgets_values entry) before ANY translation reads it, and
  // makes every read below safe and side-effect free.
  const ingress = ownJson(input)
  if (!ingress.ok) {
    return {
      diagnostics: [imp('error', 'import.notJson', `workflow rejected: ${ingress.reason}`)],
    }
  }
  const json = ingress.value as JsonObject
  const diags: Diagnostic[] = []
  if (json['occurrenceTopologies'] !== undefined) {
    return {
      diagnostics: [imp('error', 'import.occurrenceTopologies.unsupported', 'LiteGraph import cannot carry occurrence topology overlays; use the native Dinkster workflow format')],
    }
  }
  const rawNodes = Array.isArray(json['nodes']) ? (json['nodes'] as readonly LgNode[]) : []
  const rawLinks = Array.isArray(json['links']) ? (json['links'] as readonly LgLink[]) : []
  const isId = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  const isFinitePair = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])
    if (value === null || typeof value !== 'object') return false
    const pair = value as Readonly<Record<string, unknown>>
    return Number.isFinite(pair['0']) && Number.isFinite(pair['1'])
  }
  const canonicalId = (value: unknown): number | undefined => {
    if (isId(value)) return value
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined
    const parsed = Number(value)
    return isId(parsed) ? parsed : undefined
  }

  const extra = json['extra']
  const extraObject = extra !== null && typeof extra === 'object' && !Array.isArray(extra)
    ? extra as JsonObject
    : undefined
  const presentLinkIds = new Set(
    rawLinks.filter(Array.isArray).map((link) => canonicalId(link[0])).filter((id): id is number => id !== undefined),
  )
  const temporaryLinks = new Set<number>()
  const marked = extraObject?.['links_added_by_ue']
  if (marked !== undefined) {
    if (!Array.isArray(marked) || marked.length > MAX_UE_LINKS) {
      diags.push(imp('error', 'import.ue.temporaryLinksInvalid', `extra.links_added_by_ue must be an array of at most ${MAX_UE_LINKS} link IDs`))
    } else {
      for (const raw of marked) {
        const id = canonicalId(raw)
        if (id === undefined || temporaryLinks.has(id)) {
          diags.push(imp('error', 'import.ue.temporaryLinksInvalid', 'extra.links_added_by_ue must contain unique safe non-negative integer link IDs'))
          continue
        }
        temporaryLinks.add(id)
      }
      for (const id of temporaryLinks) if (!presentLinkIds.has(id)) {
        diags.push(imp('error', 'import.ue.temporaryLinkMissing', `extra.links_added_by_ue references missing link ${id}`))
      }
    }
  }

  const ueLinks: UeLink[] = []
  const manifest = extraObject?.['ue_links']
  if (manifest !== undefined) {
    if (!Array.isArray(manifest) || manifest.length > MAX_UE_LINKS) {
      diags.push(imp('error', 'import.ue.manifestInvalid', `extra.ue_links must be an array of at most ${MAX_UE_LINKS} entries`))
    } else {
      for (const [index, raw] of manifest.entries()) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          diags.push(imp('error', 'import.ue.entryInvalid', `extra.ue_links entry ${index} is malformed`))
          continue
        }
        const entry = raw as JsonObject
        const keys = Object.keys(entry).sort()
        const expectedKeys = ['controller', 'downstream', 'downstream_slot', 'type', 'upstream', 'upstream_slot']
        const downstream = canonicalId(entry['downstream'])
        const upstream = canonicalId(entry['upstream'])
        const controller = canonicalId(entry['controller'])
        const downstreamSlot = entry['downstream_slot']
        const upstreamSlot = entry['upstream_slot']
        const type = entry['type']
        if (canonicalJson(keys) !== canonicalJson(expectedKeys) || downstream === undefined ||
          upstream === undefined || controller === undefined || !isId(downstreamSlot) ||
          !isId(upstreamSlot) || typeof type !== 'string' || type.trim().length === 0) {
          diags.push(imp('error', 'import.ue.entryInvalid', `extra.ue_links entry ${index} must contain exactly canonical node IDs, safe slot indices, and a non-empty type`))
          continue
        }
        ueLinks.push({ downstream, downstreamSlot, upstream, upstreamSlot, controller, type })
      }
    }
  }
  if (temporaryLinks.size > 0 && manifest === undefined) {
    diags.push(imp('error', 'import.ue.manifestMissing', 'extra.links_added_by_ue requires the authoritative extra.ue_links manifest'))
  }
  const ueEndpointKeys = new Set(
    ueLinks.map((entry) => `${entry.upstream}:${entry.upstreamSlot}:${entry.downstream}:${entry.downstreamSlot}`),
  )
  const ueEndpointTypes = new Map(
    ueLinks.map((entry) => [`${entry.upstream}:${entry.upstreamSlot}:${entry.downstream}:${entry.downstreamSlot}`, entry.type]),
  )

  // Link endpoints, keyed by litegraph link id.
  const wires = new Map<number, LgWire>()
  const seenLinkIds = new Set<number>()
  const claimedTemporaryLinks = new Set<number>()
  for (const l of rawLinks) {
    if (!Array.isArray(l) || l.length < 5) {
      diags.push(imp('warning', 'import.link.malformed', `skipping malformed link entry ${JSON.stringify(l)}`))
      continue
    }
    const linkId = l[0]
    const fromNode = canonicalId(l[1])
    const toNode = canonicalId(l[3])
    if (!isId(linkId) || fromNode === undefined || !isId(l[2]) || toNode === undefined || !isId(l[4])) {
      diags.push(imp('error', 'import.link.invalidId', `link entry ${JSON.stringify(l)} must use a safe integer link ID and slot indices, and canonical node IDs`))
      continue
    }
    if (seenLinkIds.has(linkId)) {
      diags.push(imp('error', 'import.link.duplicateId', `duplicate litegraph link ID ${linkId}`))
      continue
    }
    seenLinkIds.add(linkId)
    if (temporaryLinks.has(linkId)) {
      const endpointKey = `${fromNode}:${l[2]}:${toNode}:${l[4]}`
      if (ueEndpointKeys.has(endpointKey)) {
        claimedTemporaryLinks.add(linkId)
        const linkType = l[5]
        const manifestType = ueEndpointTypes.get(endpointKey)
        if (linkType !== undefined && (typeof linkType !== 'string' || (linkType !== '*' && linkType !== manifestType))) {
          diags.push(imp('error', 'import.ue.temporaryLinkTypeMismatch', `temporary Use Everywhere link ${linkId} has type '${String(linkType)}', not '${manifestType}'`))
        }
      }
      continue
    }
    wires.set(linkId, {
      fromNode,
      fromSlot: l[2],
      toNode,
      toSlot: l[4],
      ...(l[5] !== undefined ? { type: l[5] as Json } : {}),
    })
  }
  for (const id of temporaryLinks) {
    if (presentLinkIds.has(id) && !claimedTemporaryLinks.has(id)) {
      diags.push(imp('error', 'import.ue.temporaryLinkUnclaimed', `temporary Use Everywhere link ${id} does not match an extra.ue_links connection`))
    }
  }

  const byId = new Map<number, LgNode>()
  for (const n of rawNodes) {
    if (n?.id === undefined || typeof n?.type !== 'string') {
      diags.push(imp('warning', 'import.node.malformed', `skipping malformed node entry ${JSON.stringify(n).slice(0, 120)}`))
      continue
    }
    const nodeId = canonicalId(n.id)
    if (nodeId === undefined) {
      diags.push(imp('error', 'import.node.invalidId', `node ID ${String(n.id)} must be a safe non-negative integer`))
      continue
    }
    if (byId.has(nodeId)) {
      diags.push(imp('error', 'import.node.duplicateId', `duplicate litegraph node ID ${nodeId}`))
      continue
    }
    if ((n.pos !== undefined && !isFinitePair(n.pos)) || (n.size !== undefined && !isFinitePair(n.size))) {
      diags.push(imp('error', 'import.node.geometry', `node ${nodeId} ('${n.type}') has a non-finite or malformed position or size`))
      continue
    }
    const version = n.properties?.['ver']
    const upgrade = typeof version === 'string' ? upgrades.get(n.type)?.get(version) : undefined
    const node = upgrade === undefined ? n : { ...n, widgets_values: upgrade(n.widgets_values) }
    byId.set(nodeId, nodeId === node.id ? node : { ...node, id: nodeId })
  }
  for (const node of byId.values()) {
    const ueConvert = node.properties?.['ue_convert']
    if (ueConvert !== undefined && typeof ueConvert !== 'boolean') {
      diags.push(imp('error', 'import.ue.controllerStateInvalid', `node ${node.id} has non-boolean ue_convert state`))
    }
  }
  if (
    manifest === undefined &&
    temporaryLinks.size === 0 &&
    [...byId.values()].some(isUeController)
  ) {
    diags.push(imp('error', 'import.ue.manifestMissing', 'Use Everywhere broadcasters require the authoritative extra.ue_links manifest'))
  }

  const ueControllerIds = new Set<number>()
  const droppedUeControllerIds = new Set<number>()
  const authoredWires = [...wires.entries()]
  const invalidConvertedControllers = new Set<number>()
  for (const controller of byId.values()) {
    if (controller.properties?.['ue_convert'] !== true) continue
    const ueProperties = controller.properties?.['ue_properties']
    if (ueProperties !== undefined && (ueProperties === null || typeof ueProperties !== 'object' || Array.isArray(ueProperties))) {
      invalidConvertedControllers.add(controller.id)
      diags.push(imp('error', 'import.ue.controllerStateInvalid', `converted broadcaster ${controller.id} has malformed ue_properties`))
      continue
    }
    const disabled = (ueProperties as JsonObject | undefined)?.['output_not_broadcasting']
    if (disabled !== undefined && (disabled === null || typeof disabled !== 'object' || Array.isArray(disabled))) {
      invalidConvertedControllers.add(controller.id)
      diags.push(imp('error', 'import.ue.controllerStateInvalid', `converted broadcaster ${controller.id} has malformed output_not_broadcasting state`))
      continue
    }
    if (disabled !== undefined && Object.values(disabled as JsonObject).some((value) => typeof value !== 'boolean')) {
      invalidConvertedControllers.add(controller.id)
      diags.push(imp('error', 'import.ue.controllerStateInvalid', `converted broadcaster ${controller.id} has non-boolean output_not_broadcasting state`))
      continue
    }
    const outputNames = (controller.outputs ?? []).map((output) => output.name)
    if (disabled !== undefined && Object.keys(disabled as JsonObject).some((name) =>
      outputNames.filter((outputName) => outputName === name).length !== 1)) {
      invalidConvertedControllers.add(controller.id)
      diags.push(imp('error', 'import.ue.controllerStateInvalid', `converted broadcaster ${controller.id} has stale or ambiguous output_not_broadcasting keys`))
    }
  }
  if (Array.isArray(manifest)) {
    for (const node of byId.values()) {
      if (!UE_CONTROLLER_TYPES.has(node.type)) continue
      ueControllerIds.add(node.id)
      if (node.type !== UE_SEED_CONTROLLER_TYPE) droppedUeControllerIds.add(node.id)
    }
    for (const controller of byId.values()) {
      if (!UE_INPUT_CONTROLLER_TYPES.has(controller.type)) continue
      if ((controller.inputs ?? []).some((input, slot) =>
        input.link !== null && input.link !== undefined && !isUeBroadcastInput(controller.type, slot))) {
        diags.push(imp('error', 'import.ue.controllerWireUnsupported', `Use Everywhere controller ${controller.id} has a serialized link on a non-broadcast input`))
      }
      for (const [linkId, wire] of authoredWires) {
        if (wire.toNode === controller.id && !isUeBroadcastInput(controller.type, wire.toSlot)) {
          diags.push(imp('error', 'import.ue.controllerWireUnsupported', `Use Everywhere controller ${controller.id} has an incoming ordinary link ${linkId} on non-broadcast input ${wire.toSlot}`))
        }
      }
      const declaredWires = (controller.inputs ?? []).flatMap((input, slot) =>
        isUeBroadcastInput(controller.type, slot) && input.link !== null && input.link !== undefined
          ? [{ linkId: input.link, slot }]
          : [],
      )
      const actualWires = authoredWires.filter(([, wire]) =>
        wire.toNode === controller.id && isUeBroadcastInput(controller.type, wire.toSlot),
      )
      const consistent = declaredWires.length === actualWires.length && declaredWires.every((declared) =>
        isId(declared.linkId) && actualWires.some(([linkId, wire]) =>
          linkId === declared.linkId && wire.toSlot === declared.slot),
      )
      if (!consistent) {
        diags.push(imp('error', 'import.ue.controllerStateInvalid', `Use Everywhere controller ${controller.id} broadcast inputs do not match their authored links`))
      }
    }
    for (const [linkId, wire] of [...wires]) {
      const source = byId.get(wire.fromNode)
      const target = byId.get(wire.toNode)
      if (source !== undefined && UE_INPUT_CONTROLLER_TYPES.has(source.type)) {
        diags.push(imp('error', 'import.ue.controllerWireUnsupported', `Use Everywhere controller ${source.id} has an unsupported outgoing ordinary link ${linkId}`))
      }
      if (target !== undefined && UE_INPUT_CONTROLLER_TYPES.has(target.type)) {
        wires.delete(linkId)
        continue
      }
      if (target?.type === UE_SEED_CONTROLLER_TYPE) {
        diags.push(imp('error', 'import.ue.controllerWireUnsupported', `Seed Everywhere controller ${target.id} has an unsupported incoming ordinary link ${linkId}`))
      }
    }
  }

  const ueTargets = new Map<string, UeLink>()
  const wiredTargets = new Set([...wires.values()].map((wire) => `${wire.toNode}:${wire.toSlot}`))
  for (const entry of ueLinks) {
    const upstream = byId.get(entry.upstream)
    const downstream = byId.get(entry.downstream)
    const controller = byId.get(entry.controller)
    if (upstream === undefined || downstream === undefined || controller === undefined) {
      diags.push(imp('error', 'import.ue.nodeMissing', 'extra.ue_links references a missing producer, consumer, or controller node'))
      continue
    }
    if (!isUeController(controller)) {
      diags.push(imp('error', 'import.ue.controllerInvalid', `extra.ue_links controller ${entry.controller} is not a supported Use Everywhere controller`))
      continue
    }
    if (entry.upstream === entry.downstream) {
      diags.push(imp('error', 'import.ue.selfConnection', `extra.ue_links cannot connect node ${entry.upstream} to itself`))
      continue
    }
    const sourceType = upstream.outputs?.[entry.upstreamSlot]?.type
    if (sourceType !== undefined && (typeof sourceType !== 'string' || (sourceType !== '*' && sourceType !== entry.type))) {
      diags.push(imp('error', 'import.ue.sourceTypeMismatch', `extra.ue_links source ${entry.upstream}:${entry.upstreamSlot} has type '${String(sourceType)}', not '${entry.type}'`))
      continue
    }
    const targetType = downstream.inputs?.[entry.downstreamSlot]?.type
    if (targetType !== undefined && (typeof targetType !== 'string' || (targetType !== '*' && targetType !== entry.type))) {
      diags.push(imp('error', 'import.ue.targetTypeMismatch', `extra.ue_links target ${entry.downstream}:${entry.downstreamSlot} has type '${String(targetType)}', not '${entry.type}'`))
      continue
    }
    if (controller.type === UE_SEED_CONTROLLER_TYPE) {
      if (entry.controller !== entry.upstream || entry.upstreamSlot !== 0 || entry.type !== 'INT') {
        diags.push(imp('error', 'import.ue.controllerSourceMismatch', `Seed Everywhere controller ${entry.controller} must broadcast its own INT output 0`))
        continue
      }
    } else if (UE_INPUT_CONTROLLER_TYPES.has(controller.type)) {
      const sourceMatches = authoredWires.filter(([, wire]) =>
        wire.toNode === controller.id && isUeBroadcastInput(controller.type, wire.toSlot) &&
        wire.fromNode === entry.upstream && wire.fromSlot === entry.upstreamSlot,
      )
      if (sourceMatches.length !== 1) {
        diags.push(imp('error', 'import.ue.controllerSourceMismatch', `Use Everywhere controller ${entry.controller} must have exactly one broadcast input connected to source ${entry.upstream}:${entry.upstreamSlot}`))
        continue
      }
      const controllerLinkType = sourceMatches[0]![1].type
      if (controllerLinkType !== undefined &&
        (typeof controllerLinkType !== 'string' || (controllerLinkType !== '*' && controllerLinkType !== entry.type))) {
        diags.push(imp('error', 'import.ue.sourceTypeMismatch', `Use Everywhere controller ${entry.controller} input link has type '${String(controllerLinkType)}', not '${entry.type}'`))
        continue
      }
    } else {
      if (invalidConvertedControllers.has(controller.id)) continue
      if (entry.controller !== entry.upstream) {
        diags.push(imp('error', 'import.ue.controllerSourceMismatch', `converted broadcaster ${entry.controller} can only broadcast its own outputs`))
        continue
      }
      const outputName = controller.outputs?.[entry.upstreamSlot]?.name
      const outputNames = (controller.outputs ?? []).map((output) => output.name)
      if (typeof outputName !== 'string' || outputName.trim().length === 0 ||
        outputNames.filter((name) => name === outputName).length !== 1) {
        diags.push(imp('error', 'import.ue.controllerOutputInvalid', `converted broadcaster ${entry.controller} has no named output ${entry.upstreamSlot}`))
        continue
      }
      const ueProperties = controller.properties?.['ue_properties']
      const disabled = (ueProperties as JsonObject | undefined)?.['output_not_broadcasting']
      if (Boolean((disabled as JsonObject | undefined)?.[outputName])) {
        diags.push(imp('error', 'import.ue.controllerOutputDisabled', `converted broadcaster ${entry.controller} output '${outputName}' is disabled`))
        continue
      }
    }
    const key = `${entry.downstream}:${entry.downstreamSlot}`
    if (ueTargets.has(key)) {
      diags.push(imp('error', 'import.ue.targetDuplicate', `extra.ue_links assigns target ${key} more than once`))
      continue
    }
    if (wiredTargets.has(key)) {
      diags.push(imp('error', 'import.ue.targetConflict', `extra.ue_links target ${key} already has an ordinary connection`))
      continue
    }
    ueTargets.set(key, entry)
  }
  // A frontend PrimitiveNode becomes the primitive chosen below, before the nodes are built.
  const primitiveSchemas = new Map<number, NodeSchema>()
  const importedNodeType = (node: LgNode): string =>
    node.type === UE_SEED_CONTROLLER_TYPE && ueControllerIds.has(node.id) ? 'PrimitiveInt'
      : primitiveSchemas.get(node.id)?.type ?? node.type
  const resolveImported = (node: LgNode): NodeSchema | undefined =>
    resolve(importedNodeType(node))

  // -- Upstream resolution (net sources only) -----------------------------------
  // Named nets are port-only: a net's source must be a real producing output.
  // Resolving a SetNode's input therefore skips over reroutes and SetNode
  // passthroughs until it reaches either a real output or a GetNode (which
  // chains nets). Ordinary links do NOT use this; they keep reroutes
  // first-class via resolveFeed below.
  type Upstream =
    | { kind: 'origin'; node: number; slot: number }
    | { kind: 'net'; name: string }

  const netName = (n: LgNode): string | undefined => {
    const v = Array.isArray(n.widgets_values) ? n.widgets_values[0] : undefined
    return typeof v === 'string' && v.trim().length > 0 ? v : undefined
  }

  const resolveUpstream = (linkId: number, seen: Set<number> = new Set()): Upstream | undefined => {
    const wire = wires.get(linkId)
    if (!wire) return undefined
    const src = byId.get(wire.fromNode)
    if (!src) return undefined
    if (GET_TYPES.has(src.type)) {
      const name = getNames.get(src.id)
      if (name === undefined) return undefined
      return { kind: 'net', name }
    }
    if (!REROUTE_TYPES.has(src.type) && !SET_TYPES.has(src.type)) {
      return { kind: 'origin', node: wire.fromNode, slot: wire.fromSlot }
    }
    // Reroute or SetNode passthrough: continue through its single input.
    if (seen.has(wire.fromNode)) {
      if (SET_TYPES.has(src.type)) {
        diags.push(imp('error', 'import.net.cycle', `SetNode passthrough cycle at litegraph node ${wire.fromNode}`))
      } else {
        diags.push(imp('warning', 'import.reroute.cycle', `reroute cycle at litegraph node ${wire.fromNode}; dropping the connection`))
      }
      return undefined
    }
    seen.add(wire.fromNode)
    const inLink = src.inputs?.[0]?.link
    if (inLink === null || inLink === undefined) return undefined // dangling
    return resolveUpstream(inLink, seen)
  }

  // -- Set/Get -> named nets --------------------------------------------------
  // SetNode: input link + widgets_values[0] = name (the net's source).
  // GetNode: widgets_values[0] = name; its output links are the net's sinks.
  // A Set fed by a Get chains nets; the chain collapses to the real origin.
  const outputLinksMatch = (node: LgNode): boolean => {
    const declared = node.outputs?.[0]?.links
    if (declared !== undefined && declared !== null &&
      (!Array.isArray(declared) || declared.some((id) => !isId(id)) || new Set(declared).size !== declared.length)) return false
    const declaredIds = declared ?? []
    const actualIds = [...wires.entries()]
      .filter(([, wire]) => wire.fromNode === node.id && wire.fromSlot === 0)
      .map(([id]) => id)
    return declaredIds.length === actualIds.length && declaredIds.every((id) => actualIds.includes(id))
  }
  const setInputs = new Map<string, number>() // name -> input link id
  const setNodes = new Map<string, LgNode>()
  for (const n of byId.values()) {
    if (!SET_TYPES.has(n.type)) continue
    if (n.inputs?.length !== 1 || n.outputs?.length !== 1) {
      diags.push(imp('error', 'import.net.nodeInvalid', `SetNode ${n.id} must have exactly one input and one output`))
      continue
    }
    const name = netName(n)
    const inLink = n.inputs?.[0]?.link
    if (name === undefined || inLink === null || inLink === undefined) {
      diags.push(imp('error', 'import.net.danglingSet', `SetNode ${n.id} has no ${name === undefined ? 'name' : 'input'}`))
      continue
    }
    const inputWire = wires.get(inLink)
    const inputWires = [...wires.entries()].filter(([, wire]) => wire.toNode === n.id && wire.toSlot === 0)
    if (inputWire === undefined || inputWire.toNode !== n.id || inputWire.toSlot !== 0 ||
      inputWires.length !== 1 || inputWires[0]![0] !== inLink || !outputLinksMatch(n)) {
      diags.push(imp('error', 'import.net.wireInvalid', `SetNode ${n.id} serialized links do not exactly match its input and passthrough output wires`))
      continue
    }
    if (setInputs.has(name)) {
      diags.push(imp('error', 'import.net.duplicateSet', `multiple SetNodes named '${name}' make the source ambiguous`))
      continue
    }
    setInputs.set(name, inLink)
    setNodes.set(name, n)
  }

  const getNames = new Map<number, string>()
  const getNodes = new Map<string, LgNode[]>()
  for (const n of byId.values()) {
    if (!GET_TYPES.has(n.type)) continue
    if ((n.inputs?.length ?? 0) !== 0 || n.outputs?.length !== 1) {
      diags.push(imp('error', 'import.net.nodeInvalid', `GetNode ${n.id} must have no inputs and exactly one output`))
      continue
    }
    if (!outputLinksMatch(n)) {
      diags.push(imp('error', 'import.net.wireInvalid', `GetNode ${n.id} serialized output links do not exactly match its outgoing wires`))
      continue
    }
    const name = netName(n)
    if (name === undefined) {
      diags.push(imp('error', 'import.net.danglingGet', `GetNode ${n.id} has no name`))
      continue
    }
    getNames.set(n.id, name)
    const namedGets = getNodes.get(name) ?? []
    namedGets.push(n)
    getNodes.set(name, namedGets)
    if (!setInputs.has(name)) {
      diags.push(imp('error', 'import.net.danglingGet', `GetNode ${n.id} names '${name}', but no matching SetNode exists`))
    }
  }

  for (const [linkId, wire] of wires) {
    const source = byId.get(wire.fromNode)
    const target = byId.get(wire.toNode)
    if ((SET_TYPES.has(source?.type ?? '') || GET_TYPES.has(source?.type ?? '')) && wire.fromSlot !== 0) {
      diags.push(imp('error', 'import.net.wireInvalid', `Set/Get link ${linkId} uses unsupported output slot ${wire.fromSlot}`))
    }
    if (GET_TYPES.has(target?.type ?? '') || (SET_TYPES.has(target?.type ?? '') && wire.toSlot !== 0)) {
      diags.push(imp('error', 'import.net.wireInvalid', `Set/Get link ${linkId} uses unsupported input slot ${wire.toSlot}`))
    }
  }

  const setSources = new Map<string, { node: number; slot: number }>()
  const resolveNetSource = (name: string, chain: Set<string>): { node: number; slot: number } | undefined => {
    const cached = setSources.get(name)
    if (cached) return cached
    const inLink = setInputs.get(name)
    if (inLink === undefined) return undefined
    const up = resolveUpstream(inLink)
    if (up === undefined) return undefined
    if (up.kind === 'net') {
      if (chain.has(up.name)) {
        diags.push(imp('error', 'import.net.cycle', `Set/Get cycle through net '${name}'`))
        return undefined
      }
      chain.add(name)
      const src = resolveNetSource(up.name, chain)
      if (src) setSources.set(name, src)
      return src
    }
    const src = { node: up.node, slot: up.slot }
    setSources.set(name, src)
    return src
  }
  for (const name of setInputs.keys()) resolveNetSource(name, new Set())

  const concreteType = (value: Json | undefined): string | undefined =>
    typeof value === 'string' && value !== '*' && value.trim().length > 0 ? value : undefined
  const wiresBySource = new Map<number, LgWire[]>()
  for (const wire of wires.values()) {
    const outgoing = wiresBySource.get(wire.fromNode) ?? []
    outgoing.push(wire)
    wiresBySource.set(wire.fromNode, outgoing)
  }
  for (const [name, setNode] of setNodes) {
    const types = new Set<string>()
    let malformedType = false
    const addType = (value: Json | undefined) => {
      if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
        malformedType = true
        return
      }
      const type = concreteType(value)
      if (type !== undefined) types.add(type)
    }
    const addUpstreamTypes = (linkId: number, seen: Set<number>) => {
      if (seen.has(linkId)) return
      seen.add(linkId)
      const wire = wires.get(linkId)
      if (wire === undefined) return
      addType(wire.type)
      const source = byId.get(wire.fromNode)
      if (source !== undefined && (REROUTE_TYPES.has(source.type) || SET_TYPES.has(source.type))) {
        const inputLink = source.inputs?.[0]?.link
        if (inputLink !== null && inputLink !== undefined) addUpstreamTypes(inputLink, seen)
      }
    }
    const addDownstreamTypes = (sourceId: number, seen: Set<number>) => {
      if (seen.has(sourceId)) return
      seen.add(sourceId)
      for (const wire of wiresBySource.get(sourceId) ?? []) {
        const target = byId.get(wire.toNode)
        addType(wire.type)
        addType(target?.inputs?.[wire.toSlot]?.type)
        if (target !== undefined && REROUTE_TYPES.has(target.type)) {
          for (const output of target.outputs ?? []) addType(output.type)
          addDownstreamTypes(target.id, seen)
        }
      }
    }
    addType(setNode.inputs?.[0]?.type)
    addType(setNode.outputs?.[0]?.type)
    addUpstreamTypes(setInputs.get(name)!, new Set())
    addDownstreamTypes(setNode.id, new Set())
    for (const getNode of getNodes.get(name) ?? []) {
      addType(getNode.outputs?.[0]?.type)
      addDownstreamTypes(getNode.id, new Set())
    }
    const source = setSources.get(name)
    if (source !== undefined) addType(byId.get(source.node)?.outputs?.[source.slot]?.type)
    if (malformedType) {
      diags.push(imp('error', 'import.net.typeMismatch', `Set/Get net '${name}' has a malformed serialized type`))
    } else if (types.size > 1) {
      diags.push(imp('error', 'import.net.typeMismatch', `Set/Get net '${name}' has conflicting serialized types: ${[...types].join(', ')}`))
    }
  }

  // -- Reroute classification ---------------------------------------------------
  // Legacy Reroute nodes survive as first-class reroutes, EXCEPT chains that
  // are ultimately fed by a GetNode: nets deliver straight to sinks (port-only
  // model), so a net-fed reroute has nothing to drive it. Those collapse into
  // direct net sinks. Cycles among reroutes are broken by dropping the driver
  // link that closes the cycle.
  type Feed =
    | { kind: 'port'; node: number; slot: number }
    | { kind: 'reroute'; id: number }
    | { kind: 'net'; name: string }

  const droppedCycleLinks = new Set<number>()
  const rerouteFeed = new Map<number, Feed | undefined>()
  const classifying = new Set<number>()

  /** What actually feeds a litegraph link, with kept reroutes first-class. */
  const resolveFeed = (linkId: number, seenSets: Set<number>): Feed | undefined => {
    if (droppedCycleLinks.has(linkId)) return undefined
    const wire = wires.get(linkId)
    if (!wire) return undefined
    const src = byId.get(wire.fromNode)
    if (!src) return undefined
    if (GET_TYPES.has(src.type)) {
      const name = getNames.get(src.id)
      if (name === undefined) return undefined
      return { kind: 'net', name }
    }
    if (REROUTE_TYPES.has(src.type)) {
      const feed = classifyReroute(src.id)
      if (feed?.kind === 'net') return feed // collapsed with its chain
      return { kind: 'reroute', id: src.id }
    }
    if (SET_TYPES.has(src.type)) {
      // SetNode passthrough output: transparent, continue through its input.
      if (seenSets.has(src.id)) {
        diags.push(imp('error', 'import.net.cycle', `SetNode passthrough cycle at litegraph node ${src.id}`))
        return undefined
      }
      seenSets.add(src.id)
      const inLink = src.inputs?.[0]?.link
      if (inLink === null || inLink === undefined) return undefined
      return resolveFeed(inLink, seenSets)
    }
    return { kind: 'port', node: wire.fromNode, slot: wire.fromSlot }
  }

  /** A reroute's upstream feed; undefined = undriven (still kept). */
  function classifyReroute(id: number): Feed | undefined {
    if (rerouteFeed.has(id)) return rerouteFeed.get(id)
    const n = byId.get(id)
    const inLink = n?.inputs?.[0]?.link
    if (classifying.has(id)) {
      // Cycle: break it by dropping this reroute's driver link. The reroute
      // itself survives, undriven.
      if (inLink !== null && inLink !== undefined) {
        droppedCycleLinks.add(inLink)
        diags.push(imp('warning', 'import.reroute.cycle', `reroute cycle at litegraph node ${id}; dropped its incoming connection to break it`))
      }
      rerouteFeed.set(id, undefined)
      return undefined
    }
    classifying.add(id)
    const feed = inLink === null || inLink === undefined ? undefined : resolveFeed(inLink, new Set())
    classifying.delete(id)
    rerouteFeed.set(id, feed)
    return feed
  }
  for (const n of byId.values()) if (REROUTE_TYPES.has(n.type)) classifyReroute(n.id)

  // Reroutes whose entire fan-out feeds SetNodes are absorbed by net
  // resolution (the net delivers straight from the real producer), so
  // materializing them would invent dangling producer->reroute branches.
  // Transitive: a chain feeding only Sets drops entirely; ANY real consumer
  // (directly or through a kept downstream reroute) keeps the junction. A
  // reroute with no outgoing wires at all stays: it is a visible endpoint
  // dot the author placed, not net plumbing.
  const rerouteOut = new Map<number, { toNode: number }[]>()
  for (const wire of wires.values()) {
    const src = byId.get(wire.fromNode)
    if (!src || !REROUTE_TYPES.has(src.type)) continue
    const outs = rerouteOut.get(src.id) ?? []
    outs.push({ toNode: wire.toNode })
    rerouteOut.set(src.id, outs)
  }
  const realFanout = new Map<number, boolean>()
  const hasRealFanout = (id: number, visiting: Set<number>): boolean => {
    const cached = realFanout.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return false
    visiting.add(id)
    let real = false
    for (const out of rerouteOut.get(id) ?? []) {
      const target = byId.get(out.toNode)
      if (!target) continue
      if (SET_TYPES.has(target.type) || GET_TYPES.has(target.type) || NOTE_TYPES.has(target.type)) continue
      if (REROUTE_TYPES.has(target.type)) {
        if (rerouteFeed.get(target.id)?.kind === 'net') continue // collapsed chain
        if (hasRealFanout(target.id, visiting)) {
          real = true
          break
        }
        continue
      }
      real = true
      break
    }
    visiting.delete(id)
    realFanout.set(id, real)
    return real
  }
  const absorbedReroutes = new Set<number>()
  for (const n of byId.values()) {
    if (!REROUTE_TYPES.has(n.type)) continue
    if (rerouteFeed.get(n.id)?.kind === 'net') continue // already collapsing
    const outs = rerouteOut.get(n.id) ?? []
    if (outs.length > 0 && !hasRealFanout(n.id, new Set())) absorbedReroutes.add(n.id)
  }

  // -- Nodes ------------------------------------------------------------------
  const nodes: Record<string, Json> = {}
  const viewNodes: Record<string, NodeViewState> = {}
  const importedInputEndpoints = new Map<number, Map<number, JsonObject>>()
  const importedOutputEndpoints = new Map<number, Map<number, JsonObject>>()
  const unresolvedInputEndpoints = new Set<string>()
  let maxOrdinal = 0

  const posOf = (n: LgNode): { x: number; y: number } => {
    if (Array.isArray(n.pos) && typeof n.pos[0] === 'number' && typeof n.pos[1] === 'number') {
      return { x: n.pos[0], y: n.pos[1] }
    }
    // Some serializations store pos as {"0": x, "1": y}.
    const o = n.pos as Readonly<Record<string, number>> | undefined
    if (o && typeof o['0'] === 'number' && typeof o['1'] === 'number') return { x: o['0'], y: o['1'] }
    return { x: 0, y: 0 }
  }

  // A PrimitiveNode takes the widget of the first field it feeds, through
  // reroutes and Set/Get nets, so it becomes the primitive a wire dragged off
  // that field makes.
  const originOf = (linkId: number): number | undefined => {
    const seen = new Set<number>()
    for (let current: number | null | undefined = linkId; current !== null && current !== undefined;) {
      const src = byId.get(wires.get(current)?.fromNode ?? -1)
      if (src === undefined) return undefined
      if (GET_TYPES.has(src.type)) {
        const name = getNames.get(src.id)
        return name === undefined ? undefined : setSources.get(name)?.node
      }
      if (!REROUTE_TYPES.has(src.type) && !SET_TYPES.has(src.type)) return src.id
      if (seen.has(src.id)) return undefined
      seen.add(src.id)
      current = src.inputs?.[0]?.link
    }
    return undefined
  }
  const fedField = new Map<number, InputSpec | undefined>()
  for (const [lgId, wire] of [...wires].sort(([a], [b]) => a - b)) {
    const consumer = byId.get(wire.toNode)
    if (consumer === undefined || REROUTE_TYPES.has(consumer.type) || SET_TYPES.has(consumer.type) ||
      GET_TYPES.has(consumer.type) || NOTE_TYPES.has(consumer.type) || PRIMITIVE_TYPES.has(consumer.type)) continue
    const origin = originOf(lgId)
    if (origin === undefined || !PRIMITIVE_TYPES.has(byId.get(origin)?.type ?? '') || fedField.has(origin)) continue
    const schema = resolveImported(consumer)
    const port = schema === undefined ? undefined : inputPortForSchema(consumer, wire.toSlot, schema)
    fedField.set(origin, port === undefined ? undefined : inputsOf(schema!).find((item) => item.id === port))
  }
  const generalPrimitive = primitives.find((schema) => primitiveOf(schema)!.value.type.kind === 'variable')
  for (const n of byId.values()) {
    if (!PRIMITIVE_TYPES.has(n.type)) continue
    const field = fedField.get(n.id)
    const schema = field === undefined ? generalPrimitive : primitiveForField(primitives, field)
    if (schema !== undefined) primitiveSchemas.set(n.id, schema)
  }
  const wiredSources = new Set<number>()
  for (const w of wires.values()) wiredSources.add(w.fromNode)
  let convertedPrimitives = 0
  let droppedPrimitives = 0

  for (const n of byId.values()) {
    maxOrdinal = Math.max(maxOrdinal, n.id)
    if (REROUTE_TYPES.has(n.type) || SET_TYPES.has(n.type) || GET_TYPES.has(n.type) || droppedUeControllerIds.has(n.id)) continue
    if (PRIMITIVE_TYPES.has(n.type)) {
      // widgets_values = [value, controllerMode?] once a widget was adopted.
      const raw = Array.isArray(n.widgets_values) ? n.widgets_values : []
      const schema = primitiveSchemas.get(n.id)
      const shape = schema && primitiveOf(schema)
      if (shape === undefined || (raw.length === 0 && !wiredSources.has(n.id))) {
        // Never adopted a widget and drives nothing, or no primitive node is installed.
        droppedPrimitives++
        continue
      }
      const id = `n${n.id}`
      const mode = raw[1]
      const controller = typeof mode === 'string' && CONTROLLER_MODES.has(mode) ? (mode as ControllerMode) : undefined
      const nodeMode = n.mode === 2 ? 'muted' : n.mode === 4 ? 'bypassed' : undefined
      const title = typeof n.title === 'string' && n.title !== n.type && n.title !== 'Primitive' && n.title !== schema!.displayName ? n.title : undefined
      nodes[id] = {
        id,
        type: schema!.type,
        values: raw.length > 0 ? { [shape.value.id]: raw[0] as Json } : {},
        ...(controller ? { controllers: { [shape.value.id]: controller } } : {}),
        ...(nodeMode ? { mode: nodeMode } : {}),
        ...(title !== undefined ? { title } : {}),
      }
      viewNodes[id] = { position: posOf(n), ...(n.flags?.collapsed === true ? { collapsed: true } : {}) }
      importedOutputEndpoints.set(n.id, new Map([[0, { node: id, port: shape.output.id }]]))
      convertedPrimitives++
      continue
    }
    if (NOTE_TYPES.has(n.type)) {
      const text = Array.isArray(n.widgets_values) ? n.widgets_values[0] : undefined
      const id = `n${n.id}`
      nodes[id] = {
        id,
        type: n.type === 'MarkdownNote' ? 'dinkster.markdown_note' : 'dinkster.note',
        virtual: true,
        values: { text: typeof text === 'string' ? text : '' },
        ...(n.title !== undefined ? { title: n.title } : {}),
      }
      const size = n.size
      const sizeObject = size as Readonly<Record<string, number>> | undefined
      const width = Array.isArray(size) ? size[0] : sizeObject?.['0']
      const height = Array.isArray(size) ? size[1] : sizeObject?.['1']
      viewNodes[id] = {
        position: posOf(n),
        ...(typeof width === 'number' && typeof height === 'number'
          ? { size: { width, height } }
          : {}),
        ...(typeof n.color === 'string' || typeof n.bgcolor === 'string'
          ? { color: n.color ?? n.bgcolor }
          : {}),
      }
      continue
    }

    const id = `n${n.id}`
    const schema = resolveImported(n)
    let values: Record<string, Json> = {}
    const controllers: Record<string, ControllerMode> = {}
    const dynamic: Record<string, DynamicPortState & JsonObject> = {}
    const ext: Record<string, Json> = {}
    if (typeof n.properties?.['ver'] === 'string') {
      ext['importer.comfyNodeType'] = n.type
      ext['importer.comfyNodeVersion'] = n.properties['ver']
    }
    const additionalInputs: string[] = []
    const targetedSlots = new Set<number>()
    for (const wire of wires.values())
      if (wire.toNode === n.id) targetedSlots.add(wire.toSlot)
    for (const entry of ueLinks)
      if (entry.downstream === n.id) targetedSlots.add(entry.downstreamSlot)

    if (schema !== undefined) {
      const families = activeGroups(placedRows(schema.body), dynamic)
      const discovered = discoverGroupMembers(n.inputs ?? [], families, targetedSlots)
      for (const [familyPath, members] of discovered.order) {
        const { group } = families.find((family) => family.path === familyPath)!
        // A count group's members follow its count; it stores no member list.
        if (typeof group.grows === 'string') dynamic[familyPath] = importedGroupState(group, members)
      }
    }

    if (schema === undefined) {
      diags.push(imp('warning', 'import.schema.missing', `node ${n.id} ('${n.type}'): no such node type is installed; widget values kept raw for review`))
      if (n.widgets_values !== undefined) ext['importer.rawWidgetValues'] = n.widgets_values as Json
      if (n.widgets_values !== undefined && !Array.isArray(n.widgets_values)) {
        values = Object.fromEntries(Object.entries(n.widgets_values))
      }
    } else if (n.type === 'CustomCombo' && schema.additionalInputs !== undefined &&
      inputsOf(schema).find((input) => input.id === 'choice')?.widget?.editableOptions === true) {
      const raw = n.widgets_values
      const keyed = raw as Readonly<Record<string, Json>> | undefined
      const choice = Array.isArray(raw) ? raw[0] : keyed?.['choice']
      const index = Array.isArray(raw) ? raw[1] : keyed?.['index']
      if (choice !== undefined) values['choice'] = choice
      const authored = Array.isArray(raw)
        ? raw.slice(2)
        : Object.entries(raw ?? {}).filter(([name]) => name.startsWith('option')).map(([, value]) => value)
      dynamic['choice'] = { options: authored.filter((value) =>
        typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) }
      // INDEX is the choice's position among the authored options, so a stored index is not kept.
      if (index !== undefined) {
        diags.push(imp('info', 'import.combo.index', `node ${n.id} ('${n.type}'): its stored index is not kept; INDEX is the choice's position among its options`))
      }
      if (raw !== undefined) {
        if (Array.isArray(raw)) ext['importer.rawWidgetValues'] = raw
        else {
          const unknown = Object.fromEntries(Object.entries(raw).filter(([name]) =>
            name !== 'choice' && name !== 'index' && !name.startsWith('option')))
          if (Object.keys(unknown).length > 0) ext['importer.unknownWidgetValues'] = unknown
          ext['importer.rawWidgetValues'] = raw
        }
      }
    } else if (Array.isArray(n.widgets_values)) {
      let raw = n.widgets_values
      const sourceVersion = n.properties?.['ver']
      const hasExactUpgrade = typeof sourceVersion === 'string' && upgrades.get(n.type)?.has(sourceVersion) === true
      const saveVideo = n.type === 'SaveVideo' ? saveVideoRowsOf(schema) : undefined
      if (saveVideo !== undefined && !hasExactUpgrade && raw.length === 3 &&
        typeof raw[0] === 'string' && typeof raw[1] === 'string' && typeof raw[2] === 'string') {
        const branch = saveVideo.format.options.find((option) => option.key === raw[1])
        const codec = branch === undefined
          ? undefined
          : placedRows(branch.rows, sharedRowsOf(saveVideo.format)).find((item) => item.id === 'codec')
        if (codec?.kind === 'choice' && codec.leader === undefined && codec.options.some((option) => option.key === raw[2])) {
          // The served layout, not an unlisted version, establishes the
          // three-widget stream, which predates the encoding mode: a codec
          // other than auto then encoded automatically. Preserve the authored
          // version in the import record.
          raw = [...raw, ...(raw[2] === 'auto' ? [] : ['auto'])]
          ext['importer.inferredWidgetLayout'] = { layout: 'SaveVideo:filename_prefix,format,codec', sourceVersion: sourceVersion ?? null }
          diags.push(imp('info', 'import.widgets.layoutInferred', `node ${n.id} ('SaveVideo'): recognized the three-widget layout; stored version ${sourceVersion === undefined ? 'absent' : JSON.stringify(sourceVersion)}`))
        }
      }
      const state: PositionalWidgetDecode = { values, controllers, dynamic, index: 0, stopped: false }
      const nodeLabel = `node ${n.id} ('${n.type}')`
      if (saveVideo !== undefined) decodeSaveVideoWidgets(saveVideo, raw, state, nodeLabel, diags)
      else decodePositionalWidgets(positionalRowsOf(schema), raw, state, '', nodeLabel, diags)
      if (state.index < raw.length) {
        diags.push(imp('warning', 'import.widgets.excess', `node ${n.id} ('${n.type}'): ${raw.length - state.index} positional widget value(s) beyond the current schema; kept raw for review`))
        ext['importer.excessWidgetValues'] = raw.slice(state.index) as Json
      }
    } else if (n.widgets_values !== undefined) {
      // Object form (newer serializations): traverse the current schema so
      // active DynamicCombo branch widgets receive the same normalization as
      // positional values. Park every unrecognized key for review.
      const known = new Set<string>()
      const state: PositionalWidgetDecode = { values, controllers, dynamic, index: 0, stopped: false }
      const keyed = n.widgets_values as Readonly<Record<string, Json>>
      decodeKeyedWidgets(placedRows(schema.body), keyed, state, '', known)
      if (n.type === 'SaveVideo' && saveVideoRowsOf(schema) !== undefined) {
        // ComfyUI's hidden top-level codec has no row here; its values are stored nowhere.
        for (const key of Object.keys(keyed)) if (key === 'codec' || key.startsWith('codec.')) known.add(key)
      }
      const unknown: Record<string, Json> = {}
      for (const [k, v] of Object.entries(keyed)) {
        if (!known.has(k)) unknown[k] = v as Json
      }
      if (Object.keys(unknown).length > 0) {
        diags.push(imp('warning', 'import.widgets.unknownKeys', `node ${n.id} ('${n.type}'): widget values for unknown inputs ${Object.keys(unknown).join(', ')}; kept raw for review`))
        ext['importer.unknownWidgetValues'] = unknown
      }
    }

    if (schema !== undefined) {
      const families = activeGroups(placedRows(schema.body), dynamic)
      const endpoints = new Map<number, JsonObject>()
      const discovered = discoverGroupMembers(n.inputs ?? [], families, targetedSlots)

      // LiteGraph inputs are an ordered array. This first-observation walk is
      // the identity policy: sparse or out-of-order foreign names keep their
      // member keys in the order observed, never sorted (image2 before image0
      // stays image2, then image0).
      for (const [slotIndex, input] of (n.inputs ?? []).entries()) {
        if (!targetedSlots.has(slotIndex) || typeof input.name !== 'string') continue
        const found = discovered.slots.get(slotIndex)
        if (found === undefined) {
          const candidates = families
            .map((family) => matchGroupWire(input.name!, family))
            .filter((candidate): candidate is GroupWireMatch => candidate !== undefined)
          const staticInput = inputsOf(schema).some((item) => item.id === input.name)
          const familyScoped = families.some((family) => input.name!.startsWith(`${family.path}.`))
          const scoped = !staticInput && familyScoped
          if (scoped) {
            diags.push(imp(
              'warning',
              candidates.length === 0 ? 'import.dynamic.autogrowWireUnknown' : 'import.dynamic.autogrowWireAmbiguous',
              `node ${n.id} ('${n.type}'): linked input '${input.name}' does not identify exactly one declared Autogrow member; endpoint left unresolved`,
            ))
            unresolvedInputEndpoints.add(`${n.id}:${slotIndex}`)
          }
          continue
        }

        const { match, memberId } = found
        endpoints.set(slotIndex, {
          node: `n${n.id}`,
          port: match.family.group.value !== undefined
            ? `${match.family.path}.${memberId}`
            : `${match.family.path}.${memberId}.${match.slot.id}`,
        })
      }

      for (const [familyPath, members] of discovered.order) {
        const { group } = families.find((family) => family.path === familyPath)!
        // A count group's members follow its count; it stores no member list.
        if (typeof group.grows === 'string') dynamic[familyPath] = importedGroupState(group, members)
      }
      if (schema.additionalInputs !== undefined) {
        const declared = elabInputsOf(elaborateInterface(schema, { values, dynamic }))
        const roots = placedRows(schema.body).map((item) => item.id)
        const linkedNames = (n.inputs ?? []).flatMap((input, slot) => {
          const name = input.widget?.name ?? input.name
          return targetedSlots.has(slot) && typeof name === 'string' &&
            !declared.some((item) => item.apiName === name) &&
            !roots.some((root) => name === root || name.startsWith(`${root}.`))
            ? [name] : []
        })
        additionalInputs.splice(0, additionalInputs.length, ...new Set([...linkedNames, ...additionalInputs]))
      }
      const elaborated = elabInputsOf(elaborateInterface(schema, { values, dynamic, additionalInputs }))
      for (const [slot, input] of (n.inputs ?? []).entries()) {
        if (endpoints.has(slot)) continue
        const matches = elaborated.filter((item) => (item.origin.kind === 'branch' || additionalInputs.includes(item.spec.id)) && item.apiName === (input.widget?.name ?? input.name))
        if (matches.length === 1) endpoints.set(slot, { node: id, ...matches[0]!.address } as unknown as JsonObject)
      }
      if (endpoints.size > 0) importedInputEndpoints.set(n.id, endpoints)
    }

    const linkedOutputSlots = new Set<number>()
    for (const wire of wires.values()) if (wire.fromNode === n.id) linkedOutputSlots.add(wire.fromSlot)
    for (const entry of ueLinks) if (entry.upstream === n.id) linkedOutputSlots.add(entry.upstreamSlot)
    const outputEndpoints = new Map<number, JsonObject>()
    // Member outputs of groups exist as the imported state elaborates them,
    // with its wired inputs: a count read from a wire is not known, and an
    // elaboration that fails makes no members.
    const wiredInputs = new Set((n.inputs ?? []).flatMap((input, slot) => {
      const name = input.widget?.name ?? input.name
      return targetedSlots.has(slot) && typeof name === 'string' ? [name] : []
    }))
    const memberElaboration = schema === undefined ? undefined : elaborateInterface(schema, { values, dynamic }, {
      ...EMPTY_CONNECTIVITY, isInputConnected: (port) => wiredInputs.has(port),
    })
    const memberOutputs = new Set(memberElaboration === undefined ||
      memberElaboration.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
      ? []
      : elabOutputsOf(memberElaboration)
          .filter((output) => output.wireable !== false && output.address.port.includes('.'))
          .map((output) => output.address.port))
    for (const slot of linkedOutputSlots) {
      const foreignOutput = n.outputs?.[slot]
      const foreignName = foreignOutput?.name
      if (typeof foreignName !== 'string' || foreignName.length === 0) {
        diags.push(imp(
          'error',
          'import.link.outputSlot',
          `node ${n.id} ('${n.type}'): linked output slot ${slot} has no serialized non-empty name`,
        ))
        continue
      }
      if (schema === undefined) {
        const occurrences = (n.outputs ?? []).filter((output) => output.name === foreignName).length
        if (occurrences !== 1) {
          diags.push(imp(
            'error',
            'import.link.outputSlot',
            `node ${n.id} ('${n.type}'): linked output '${foreignName}' is ambiguous without a schema`,
          ))
          continue
        }
        outputEndpoints.set(slot, { node: id, port: foreignName })
        continue
      }
      if (memberOutputs.has(foreignName)) {
        outputEndpoints.set(slot, { node: id, port: foreignName })
        continue
      }
      const group = scopeRowsOf(schema.body).find((row): row is GroupSpec => row.kind === 'group' && foreignName.startsWith(`${row.id}.`))
      if (group !== undefined) {
        diags.push(imp(
          'error',
          'import.link.outputSlot',
          `node ${n.id} ('${n.type}'): linked output '${foreignName}' is not a current member of '${group.id}'`,
        ))
        continue
      }
      const staticPort = staticOutputPortForSchema(n, slot, schema, true)
      if (staticPort === undefined) {
        diags.push(imp(
          'error',
          'import.link.outputSlot',
          `node ${n.id} ('${n.type}'): linked output slot ${slot} ('${foreignName}') does not identify a declared output`,
        ))
        continue
      }
      outputEndpoints.set(slot, { node: id, port: staticPort })
    }
    if (outputEndpoints.size > 0) importedOutputEndpoints.set(n.id, outputEndpoints)

    const mode = n.mode === 2 ? 'muted' : n.mode === 4 ? 'bypassed' : undefined
    if (n.mode !== undefined && n.mode !== 0 && n.mode !== 1 && mode === undefined) {
      diags.push(imp('warning', 'import.node.mode', `node ${n.id} ('${n.type}'): unknown litegraph mode ${n.mode}; imported as active`))
    }
    const title = typeof n.title === 'string' && n.title !== (schema?.displayName ?? n.type) ? n.title : undefined

    nodes[id] = {
      id,
      type: importedNodeType(n),
      values,
      ...(Object.keys(controllers).length > 0 ? { controllers } : {}),
      ...(Object.keys(dynamic).length > 0 ? { dynamic } : {}),
      ...(additionalInputs.length > 0 ? { additionalInputs } : {}),
      ...(mode ? { mode } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(Object.keys(ext).length > 0 ? { ext } : {}),
    }
    viewNodes[id] = {
      position: posOf(n),
      ...(n.flags?.collapsed === true ? { collapsed: true } : {}),
    }
  }

  // -- Reroutes -----------------------------------------------------------------
  // Kept reroutes become first-class junctions (r{lgId}); positions land in
  // view state. Net-fed chains collapse into direct net sinks below.
  const reroutes: Record<string, Json> = {}
  const viewReroutes: Record<string, Json> = {}
  let netFedReroutes = 0
  for (const n of byId.values()) {
    if (!REROUTE_TYPES.has(n.type)) continue
    if (rerouteFeed.get(n.id)?.kind === 'net') {
      netFedReroutes++
      continue
    }
    if (absorbedReroutes.has(n.id)) continue
    const id = `r${n.id}`
    reroutes[id] = { id }
    viewReroutes[id] = { position: posOf(n) }
  }
  if (Object.keys(reroutes).length > 0) {
    diags.push(imp('info', 'import.reroute.converted', `${Object.keys(reroutes).length} Reroute node(s) imported as first-class reroutes`))
  }
  if (netFedReroutes > 0) {
    diags.push(imp('warning', 'import.reroute.netFed', `${netFedReroutes} Reroute node(s) fed by GetNodes collapsed into direct net connections (nets deliver straight to inputs)`))
  }
  if (absorbedReroutes.size > 0) {
    diags.push(imp('warning', 'import.reroute.absorbed', `${absorbedReroutes.size} Reroute node(s) feeding only SetNodes absorbed into their nets (nets deliver straight from the producing output)`))
  }

  if (convertedPrimitives > 0) {
    diags.push(imp('info', 'import.primitive.converted', `${convertedPrimitives} PrimitiveNode(s) imported as primitive nodes`))
  }
  if (droppedPrimitives > 0) {
    diags.push(imp('warning', 'import.primitive.dropped', `${droppedPrimitives} PrimitiveNode(s) had no value to keep or no installed primitive to become; dropped`))
  }

  // -- Links --------------------------------------------------------------------
  // LiteGraph endpoint indices select entries in the serialized actual slot
  // arrays. Schemas interpret those entries by name; they never invent source
  // outputs from a declaration whose runtime arity may differ.
  const inPortId = (node: LgNode, slot: number): string | undefined => {
    const schema = resolveImported(node)
    const foreignInput = node.inputs?.[slot]
    if (foreignInput === undefined) return undefined
    return schema === undefined ? foreignInput.name : inputPortForSchema(node, slot, schema)
  }

  // Net feeds are handled by callers before link emission ever gets here.
  const fromEndpoint = (feed: Exclude<Feed, { kind: 'net' }>): JsonObject | undefined =>
    feed.kind === 'reroute'
      ? { reroute: `r${feed.id}` }
      : importedOutputEndpoints.get(feed.node)?.get(feed.slot)

  const links: Record<string, Json> = {}
  const netSinks = new Map<string, JsonObject[]>()
  for (const [lgId, wire] of wires) {
    maxOrdinal = Math.max(maxOrdinal, lgId)
    if (droppedCycleLinks.has(lgId)) continue // diagnosed during classification
    const toNode = byId.get(wire.toNode)
    const fromNode = byId.get(wire.fromNode)
    if (!toNode || !fromNode) {
      diags.push(imp('warning', 'import.link.dangling', `link ${lgId} references a missing node; dropped`))
      continue
    }
    // Links INTO sets/gets are absorbed by net resolution; notes never carry
    // data; primitives never consume (their legacy node has no inputs).
    // Links into KEPT reroutes are emitted as the reroute's driver.
    if (SET_TYPES.has(toNode.type) || GET_TYPES.has(toNode.type) || NOTE_TYPES.has(toNode.type) || PRIMITIVE_TYPES.has(toNode.type)) continue
    if (NOTE_TYPES.has(fromNode.type)) continue

    if (REROUTE_TYPES.has(toNode.type)) {
      if (rerouteFeed.get(toNode.id)?.kind === 'net') continue // collapsed chain
      if (absorbedReroutes.has(toNode.id)) continue // absorbed into a net
      const feed = resolveFeed(lgId, new Set())
      if (feed === undefined || feed.kind === 'net') continue // dangling / absorbed
      const from = fromEndpoint(feed)
      if (from === undefined) continue
      const id = `l${lgId}`
      links[id] = { id, from, to: { reroute: `r${toNode.id}` } }
      continue
    }

    const feed = resolveFeed(lgId, new Set())
    const toPort = inPortId(toNode, wire.toSlot)
    if (toPort === undefined) {
      if (feed?.kind === 'net' || SET_TYPES.has(fromNode.type)) {
        diags.push(imp('error', 'import.net.endpointUnavailable', `translated Set/Get link ${lgId} targets missing input slot ${wire.toNode}:${wire.toSlot}`))
      } else {
        diags.push(imp('warning', 'import.link.slot', `link ${lgId}: node ${wire.toNode} has no input slot ${wire.toSlot}; dropped`))
      }
      continue
    }
    if (unresolvedInputEndpoints.has(`${wire.toNode}:${wire.toSlot}`)) continue
    const toEndpoint = importedInputEndpoints.get(wire.toNode)?.get(wire.toSlot) ?? { node: `n${wire.toNode}`, port: toPort }

    if (feed === undefined) continue // dangling sugar chain: nothing to connect

    if (feed.kind === 'net') {
      // A sink of the named net (if its Set half resolved).
      if (!setSources.has(feed.name)) {
        continue
      }
      const sinks = netSinks.get(feed.name) ?? []
      sinks.push(toEndpoint)
      netSinks.set(feed.name, sinks)
      continue
    }

    const from = fromEndpoint(feed)
    if (from === undefined) continue
    const id = `l${lgId}`
    links[id] = { id, from, to: toEndpoint }
  }

  // -- Materialize nets ---------------------------------------------------------
  const nets: Record<string, Json> = {}
  let netCount = 0
  for (const name of setInputs.keys()) {
    if (!setSources.has(name)) {
      diags.push(imp('error', 'import.net.unresolved', `net '${name}' has no resolvable source`))
    }
  }
  for (const [name, src] of setSources) {
    const source = importedOutputEndpoints.get(src.node)?.get(src.slot)
    if (source === undefined) {
      diags.push(imp('error', 'import.net.endpointUnavailable', `Set/Get net '${name}' resolves to missing output slot ${src.node}:${src.slot}`))
      continue
    }
    maxOrdinal += 1
    const id = `net${maxOrdinal}`
    nets[id] = {
      id,
      name,
      source,
      sinks: netSinks.get(name) ?? [],
    }
    netCount++
  }
  if (netCount > 0) diags.push(imp('info', 'import.net.converted', `${netCount} Set/Get pair(s) converted to named nets`))

  const usedNetNames = new Set(Object.values(nets).map((net) => (net as JsonObject)['name']).filter((name): name is string => typeof name === 'string'))
  const ueGroups = new Map<string, { source: JsonObject; sinks: JsonObject[] }>()
  for (const entry of ueTargets.values()) {
    const source = importedOutputEndpoints.get(entry.upstream)?.get(entry.upstreamSlot)
    const targetNode = byId.get(entry.downstream)
    if (targetNode === undefined) {
      diags.push(imp('error', 'import.ue.endpointUnavailable', `extra.ue_links endpoint ${entry.upstream}:${entry.upstreamSlot} -> ${entry.downstream}:${entry.downstreamSlot} is unavailable`))
      continue
    }
    const targetPort = inPortId(targetNode, entry.downstreamSlot)
    const sink = importedInputEndpoints.get(entry.downstream)?.get(entry.downstreamSlot) ??
      (targetPort === undefined ? undefined : { node: `n${entry.downstream}`, port: targetPort })
    if (source === undefined || sink === undefined) {
      diags.push(imp('error', 'import.ue.endpointUnavailable', `extra.ue_links endpoint ${entry.upstream}:${entry.upstreamSlot} -> ${entry.downstream}:${entry.downstreamSlot} is unavailable`))
      continue
    }
    const key = canonicalJson(source)
    const group = ueGroups.get(key) ?? { source, sinks: [] }
    group.sinks.push(sink)
    ueGroups.set(key, group)
  }
  let ueIndex = 0
  for (const group of ueGroups.values()) {
    let name = `use_everywhere_${ueIndex++}`
    while (usedNetNames.has(name)) name = `use_everywhere_${ueIndex++}`
    usedNetNames.add(name)
    maxOrdinal += 1
    const id = `net${maxOrdinal}`
    nets[id] = { id, name, source: group.source, sinks: group.sinks }
  }
  if (ueGroups.size > 0) diags.push(imp('info', 'import.ue.converted', `${ueLinks.length} Use Everywhere connection(s) converted to ${ueGroups.size} named net(s)`))

  // -- Groups -------------------------------------------------------------------
  const groups: Record<string, GroupViewState> = {}
  if (Array.isArray(json['groups'])) {
    for (const [i, g] of (json['groups'] as readonly JsonObject[]).entries()) {
      const b = g['bounding']
      if (!Array.isArray(b) || b.length < 4 || b.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
        diags.push(imp('warning', 'import.group.malformed', `group ${i} has no numeric bounding box; dropped`))
        continue
      }
      const id = `grp${i}`
      groups[id] = {
        id,
        title: typeof g['title'] === 'string' ? g['title'] : '',
        bounds: { x: b[0] as number, y: b[1] as number, width: b[2] as number, height: b[3] as number },
        ...(typeof g['color'] === 'string' ? { color: g['color'] } : {}),
      }
    }
  }
  // Native (non-node) litegraph reroutes live in extra.reroutes as pure
  // geometry waypoints; the links themselves are still direct node-to-node,
  // so dropping them loses layout only, never topology.
  if (extra !== null && typeof extra === 'object' && !Array.isArray(extra)) {
    const nativeReroutes = (extra as JsonObject)['reroutes']
    if (Array.isArray(nativeReroutes) && nativeReroutes.length > 0) {
      diags.push(imp('warning', 'import.reroute.nativeDropped', `${nativeReroutes.length} native reroute waypoint(s) (extra.reroutes) not translated yet; connections stay intact, only the waypoint geometry is lost`))
    }
  }

  // Deterministic lineage: same legacy JSON -> same lineage, so re-importing
  // the same file lands on the same tab/execution lineage.
  const lineageHash = fnv1a(JSON.stringify(json))

  const document = {
    format: 'dinkster-workflow',
    formatVersion: FORMAT_VERSION,
    lineage: `lg-${lineageHash}`,
    root: 'g0',
    graphs: {
      ...definitions,
      g0: {
        id: 'g0',
        name: 'imported',
        nodes,
        links,
        nets,
        reroutes,
        nextOrdinal: maxOrdinal + 1,
      },
    },
    view: {
      graphs: {
        g0: {
          nodes: viewNodes,
          ...(Object.keys(viewReroutes).length > 0
            ? { reroutes: viewReroutes }
            : {}),
          ...(Object.keys(groups).length > 0 ? { groups } : {}),
        },
      },
    },
  } as unknown as JsonObject

  convertLitegraphListConsumers(document, resolve)

  // Error-level import diagnostics (e.g. untranslatable subgraph definitions)
  // block the import outright: a partially-translated workflow is corruption.
  if (diags.some((d) => d.severity === 'error')) return { diagnostics: diags }

  // Same gate as loadDocument: the importer's output gets no special trust.
  const shapeDiags = validateDocumentShape(document)
  const all = [...diags, ...shapeDiags]
  if (shapeDiags.some((d) => d.severity === 'error')) return { diagnostics: all }
  const doc = document as unknown as WorkflowDocument
  const invariantDiags = checkDocument(doc)
  all.push(...invariantDiags)
  if (invariantDiags.some((d) => d.severity === 'error')) return { diagnostics: all }
  // Same ownership contract as loadDocument (CO1): the result is a deep-
  // frozen owned copy, so consumers (stores, blueprint caches) can share it
  // without freezing caller state or carrying mutable importer scratch.
  const ownedDoc = ownJson(document)
  if (!ownedDoc.ok) {
    // Unreachable after ingress ownership + shape validation; keep it a
    // diagnostic, never a throw.
    return { diagnostics: [...all, imp('error', 'import.notJson', `translated document rejected: ${ownedDoc.reason}`)] }
  }
  return { document: ownedDoc.value as unknown as WorkflowDocument, diagnostics: all }
}
