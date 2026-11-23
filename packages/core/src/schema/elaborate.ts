/**
 * Interface elaboration: the node body tree, read against one node's
 * document state, becomes the node's effective ordered interface.
 *
 * A pure function from (NodeSchema, stored values and dynamic state, link
 * existence) to the rows the node has now. It follows the engine's flattening
 * (dinkster_schema.flatten): a member's rows are `<group>.<key>.<row>` in a
 * group of records and `<group>.<key>` in a group of values; a choice's rows
 * are `<choice>.<row>`, with the option key left out of the path. That
 * flattened id is the document identity (value key, link port) and the name
 * the run receives, so nothing is renamed between editing and running.
 *
 * Load-bearing invariant (the anti-oscillation DAG): elaboration reads only
 * the schema, stored values and dynamic state, and link EXISTENCE. Solved
 * types never feed back into which rows exist.
 *
 * Rows are emitted in the order the body declares them, which is the order
 * the node draws them; the engine sorts a scope's rows by id for the run,
 * which changes no id.
 *
 * Dynamic state is keyed by flattened path: a group's member keys in order
 * (`members`), the counter that keeps a key from being used twice (`seq`),
 * labels the user typed (`memberLabels`), and the key a choice or a type
 * choice stores (`selected`).
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import type { DynamicPortState, GraphDef, Json, NodeData } from '../format/document.js'
import { asPortId, isExactWidgetTapRef, isPortEndpoint, portAddressKey, type DynamicMemberId, type NodeId } from '../ids.js'
import { Formula, FormulaRefused, UNKNOWN, type FormulaNameKind, type FormulaScope, type FormulaValue, type FormulaValues, type Unknown } from '../mirror/formula.js'
import {
  applyUse,
  choiceScopeRows,
  formulaTablesOf,
  framesNamesOf,
  hasRequiredRow,
  isRowId,
  keyPosition,
  memberKeyAt,
  memberLimitOf,
  memberRowsOf,
  optionRows,
  scopeNamesOf,
} from './body.js'
import type {
  BodyRow,
  ButtonSpec,
  ChoiceSpec,
  DescribedSpec,
  GroupSpec,
  InputSpec,
  NoteSpec,
  NodeSchema,
  OptionRow,
  OutputSpec,
  SectionSpec,
  TypeChoiceSpec,
  TypeExpr,
  UseSpec,
  WidgetSpec,
} from './model.js'
import { scopeRowsOf } from './model.js'

// ---------------------------------------------------------------------------
// Connectivity facts (structural link presence - built once per graph)
// ---------------------------------------------------------------------------

/**
 * Structural connection facts for ONE node: "does a link or net endpoint
 * attach to this producer/consumer address?". Memberless output queries are
 * producer-kind agnostic (ordinary output or widget tap). Link EXISTENCE
 * only - whether the chain is driven or type-compatible is irrelevant here
 * by design.
 */
export interface Connectivity {
  isInputConnected(port: string): boolean
  isOutputConnected(port: string): boolean
  /** Enumerable document input ports with a link or net endpoint. */
  inputPorts?(): readonly string[]
}

export const EMPTY_CONNECTIVITY: Connectivity = {
  isInputConnected: () => false,
  isOutputConnected: () => false,
}

/**
 * Build per-node connectivity for a graph definition in one pass over links
 * and nets. Returns an accessor; nodes with no attachments share a constant.
 */
export function buildGraphConnectivity(def: GraphDef): (node: NodeId) => Connectivity {
  const inputs = new Map<NodeId, Set<string>>()
  const outputs = new Map<NodeId, Set<string>>()
  const inputPorts = new Map<NodeId, Set<string>>()
  const producerKey = (kind: 'port' | 'tap', port: string): string => JSON.stringify([kind, port])
  const add = (map: Map<NodeId, Set<string>>, node: NodeId, key: string): void => {
    let set = map.get(node)
    if (!set) map.set(node, (set = new Set()))
    set.add(key)
  }
  for (const link of Object.values(def.links)) {
    if (isPortEndpoint(link.from))
      add(outputs, link.from.node, producerKey('port', link.from.port))
    else if (
      isExactWidgetTapRef(link.from) &&
      def.nodes[link.from.node] !== undefined
    )
      add(outputs, link.from.node, producerKey('tap', link.from.tap))
    if (isPortEndpoint(link.to)) {
      add(inputs, link.to.node, portAddressKey(link.to.port))
      add(inputPorts, link.to.node, link.to.port)
    }
  }
  for (const net of Object.values(def.nets)) {
    add(outputs, net.source.node, producerKey('port', net.source.port))
    for (const sink of net.sinks) {
      add(inputs, sink.node, portAddressKey(sink.port))
      add(inputPorts, sink.node, sink.port)
    }
  }
  const cache = new Map<NodeId, Connectivity>()
  return (node) => {
    let c = cache.get(node)
    if (c) return c
    const ins = inputs.get(node)
    const outs = outputs.get(node)
    if (!ins && !outs) return EMPTY_CONNECTIVITY
    c = {
      isInputConnected: (port) => ins?.has(portAddressKey(port)) ?? false,
      isOutputConnected: (port) =>
        outs?.has(producerKey('port', port)) === true || outs?.has(producerKey('tap', port)) === true,
      inputPorts: () => [...(inputPorts.get(node) ?? [])],
    }
    cache.set(node, c)
    return c
  }
}

// ---------------------------------------------------------------------------
// Elaborated interface model
// ---------------------------------------------------------------------------

/**
 * Document-identity address of an elaborated port: what PortRef stores.
 * `port` is the flattened id; it also keys the port's stored value, its
 * layout row and its pin.
 */
export interface PortAddress {
  readonly port: string
}

/**
 * Where an elaborated item came from. Downstream code branches on THIS
 * role, never on the row kind that produced it.
 */
export type ElaboratedOrigin =
  | { readonly kind: 'static' }
  /**
   * A row of one group member. `ghost`: a member the node offers but the
   * document does not store yet (up to the minimum, and the spare one).
   */
  | {
      readonly kind: 'member'
      readonly construct: string
      readonly ordinal: number
      readonly key: string
      readonly ghost?: boolean
    }
  /** A choice's own dropdown; its value is the stored key, never a stored value. */
  | { readonly kind: 'selector'; readonly construct: string; readonly selected?: string }
  /** A row of the chosen option of a choice. */
  | { readonly kind: 'branch'; readonly construct: string; readonly option: string }
  /** A type choice's own pin. */
  | {
      readonly kind: 'slot'
      readonly construct: string
      readonly variants?: readonly { readonly key: string; readonly type: TypeExpr }[]
      readonly selected?: string
      readonly typeTemplateId?: string
    }
  /** A row a type choice reveals: its shared rows and the chosen variant's. */
  | { readonly kind: 'dependent'; readonly construct: string; readonly variant?: string }

/**
 * One group crossed on the way to an elaborated item, outermost first.
 * `construct` is the group's flattened id and `member` the member's key.
 * `ghost` and `synthetic` mark a member the document does not store yet:
 * it is drawn, never compiled, and a write to it persists it first.
 */
export interface DynamicAncestor {
  readonly construct: string
  readonly member: DynamicMemberId
  readonly ordinal: number
  readonly ghost?: boolean
  readonly synthetic?: boolean
}

export interface ElaboratedInput {
  readonly kind: 'input'
  readonly address: PortAddress
  /**
   * The id the run receives (the flattened id). Absent on rows that never
   * reach the run: a member the document does not store, a choice's own
   * dropdown (its key travels with the node's stored choices), and rows of
   * options that are not chosen in a dormant census.
   */
  readonly apiName?: string
  /** Effective spec; `spec.id` is the flattened id. */
  readonly spec: InputSpec
  readonly origin: ElaboratedOrigin
  /** Groups crossed to reach this row. Absent at the node's top scope. */
  readonly ancestry?: readonly DynamicAncestor[]
  /** Value not stored in node.values (a choice's dropdown: the chosen key). */
  readonly derivedValue?: Json
  /** Member state to persist before writing or wiring this row. */
  readonly materialize?: readonly MaterializeFrame[]
}

export interface ElaboratedOutput {
  readonly kind: 'output'
  readonly address: PortAddress
  readonly spec: OutputSpec
  readonly origin: ElaboratedOrigin
  /** Canonical backend output id when it differs from the flattened id. */
  readonly backendId?: string
  readonly ancestry?: readonly DynamicAncestor[]
  /** False when this output takes no part in wiring: a member the document does not store. */
  readonly wireable?: false
  readonly materialize?: readonly MaterializeFrame[]
}

/** A section header as the node draws it. */
export interface ElaboratedSectionSpec {
  readonly kind: 'section'
  /** Flattened id: keys the saved open or closed state. */
  readonly id: string
  readonly displayName?: string
  readonly collapsedByDefault?: boolean
}

export interface ElaboratedSection {
  readonly kind: 'section'
  readonly spec: ElaboratedSectionSpec
  /** The section around this one, when nested. */
  readonly section?: string
}

/**
 * A group's add control: a member the node offers when a spare member would
 * show no pin or field (a button-grown group, or a member of only boxes).
 * Not a port: it has no address and never compiles. Activating it dispatches
 * `dynamic.materialize` with `frames`.
 */
export interface ElaboratedGrowth {
  readonly kind: 'growth'
  /** Group flattened id. */
  readonly construct: string
  readonly side: 'input' | 'output'
  readonly label: string
  readonly frames: readonly MaterializeFrame[]
  readonly section?: string
}

/**
 * Read-only text drawn as a row. A note whose text is a formula or a lookup
 * shows its `unknown` text: the editor does not evaluate it here.
 */
export interface ElaboratedNote {
  readonly kind: 'note'
  /** Flattened id. */
  readonly id: string
  readonly text: string
  /** The text is the note's "while unknown" answer. */
  readonly unknown?: true
  readonly section?: string
  /** Line key of the cell drawn before this one in a `Row`. */
  readonly adjacentTo?: string
}

/** An action drawn as a row; the button runner (actions/runner.ts) runs its steps. */
export interface ElaboratedButton {
  readonly kind: 'button'
  /** Flattened id. */
  readonly id: string
  readonly label: string
  /** The declaration: its steps, icon, tooltip and the formulas that enable it. */
  readonly spec: ButtonSpec
  readonly section?: string
  /** Line key of the cell drawn before this one in a `Row`. */
  readonly adjacentTo?: string
}

/** The key a cell of a `Row` names the cell before it by: an input's flattened id, or a note's or button's. */
export const lineKeyOf = (item: ElaboratedItem): string | undefined =>
  item.kind === 'input' ? item.spec.id
    : item.kind === 'note' || item.kind === 'button' ? `${item.kind}:${item.id}` : undefined

export type ElaboratedItem = ElaboratedInput | ElaboratedOutput | ElaboratedSection | ElaboratedGrowth | ElaboratedNote | ElaboratedButton

export interface ElaboratedInterface {
  /** Ordered as the body declares; members appear in their stored order at their group's place. */
  readonly items: readonly ElaboratedItem[]
  readonly chunkSafe?: Pick<NonNullable<NodeSchema['chunkSafe']>, 'inputs' | 'outputs'>
  /** Non-port values the run carries. */
  readonly submissionValues: readonly { readonly path: string; readonly apiPath: string; readonly value: Json }[]
  /** Stored member keys of each group that is not a count group, in order: the run's member lists. */
  readonly outputMembers?: Readonly<Record<string, readonly string[]>>
  /** The key of every choice and type choice that takes part in the run, by flattened id. */
  readonly choices?: Readonly<Record<string, string>>
  /**
   * Required choices that take part in the node with no stored key and no
   * leader, with the start key the node shows for each (view mode only).
   */
  readonly unstoredChoices?: Readonly<Record<string, string>>
  /**
   * Groups that grow by hand and take part in the node with fewer stored
   * members than their minimum, with the members that reach it (view mode only).
   */
  readonly unstoredMinimums?: Readonly<Record<string, MaterializeFrame>>
  /** Flattened id of every group, choice and type choice the node holds (not offered members). */
  readonly constructs: readonly string[]
  readonly diagnostics: readonly Diagnostic[]
}

export const elabInputsOf = (e: Pick<ElaboratedInterface, 'items'>): readonly ElaboratedInput[] =>
  e.items.filter((i): i is ElaboratedInput => i.kind === 'input')
export const elabOutputsOf = (e: Pick<ElaboratedInterface, 'items'>): readonly ElaboratedOutput[] =>
  e.items.filter((i): i is ElaboratedOutput => i.kind === 'output')

/**
 * The node.values key an elaborated input's value persists under: its
 * flattened id. The one rule compile, the canvas and the app share.
 */
export const valueKeyOf = (i: ElaboratedInput): string => i.address.port

// ---------------------------------------------------------------------------
// Options and budget
// ---------------------------------------------------------------------------

/**
 * Hard elaboration limits, one set with the engine: a body nests at most 16
 * boxes, a group holds at most 512 members, and a node has at most 1024
 * flattened rows. Exhaustion stops elaboration with one error.
 */
export interface ElabBudget {
  readonly maxDepth: number
  readonly maxItems: number
  readonly maxMembers: number
}

export const DEFAULT_ELAB_BUDGET: ElabBudget = {
  maxDepth: 16,
  maxItems: 1024,
  maxMembers: 512,
}

export interface ElaborateOptions {
  readonly budget?: Partial<ElabBudget>
  /**
   * True (the default) is the node as drawn: a group also shows the members
   * the document does not store yet, up to its minimum and one spare. False
   * is the node as the run sees it: only stored members, and a group whose
   * required rows have fewer stored members than its minimum is an error,
   * as the engine refuses that run.
   */
  readonly promoteGhosts?: boolean
  /** Read-only stored-value census: also the rows of options and variants that are not chosen. */
  readonly includeDormant?: boolean
  /** Node identity for diagnostic anchors. */
  readonly nodeId?: NodeId
  /**
   * When given, receives the formula context of every scope the walk enters,
   * keyed by the scope's flattened prefix ('' for the body, 'loras.lora_1.'
   * for a member, 'format.' for a choice's option). The button runner reads
   * it to work out a step's formulas where the button sits.
   */
  readonly formulaContexts?: Map<string, FormulaContext>
}

/** What a formula sees in one scope of a node, and where each name it reads is stored. */
export interface FormulaContext {
  readonly scope: FormulaScope
  readonly values: FormulaValues
  /** Each name's flattened id. */
  readonly paths: ReadonlyMap<string, string>
  /** The scope is a member the node shows but does not store. */
  readonly ghost?: true
}

// ---------------------------------------------------------------------------
// Materialization frames (the bridge from an offered member to commands)
// ---------------------------------------------------------------------------

/** One group's members to persist, as `dynamic.materialize` takes them. */
export interface MaterializeFrame {
  /** Group flattened id, the key of its state in NodeData.dynamic. */
  readonly construct: string
  /** Member keys to append, in order. */
  readonly members: readonly string[]
  /** The group's counter after these members, so a removed key is never offered again. */
  readonly seq?: number
}

/**
 * The `dynamic.materialize` frames that make `target` persistable: every
 * offered member on its path, with the offered members before it in the same
 * group. Undefined when everything on the path is stored.
 */
export function materializeFramesOf(
  _items: readonly ElaboratedItem[],
  target: ElaboratedInput | ElaboratedOutput,
): readonly MaterializeFrame[] | undefined {
  return target.materialize
}

// ---------------------------------------------------------------------------
// Elaboration
// ---------------------------------------------------------------------------

/** One scope a formula sees: its flattened prefix, its rows, and its member. */
interface FormulaFrame {
  readonly prefix: string
  readonly rows: readonly OptionRow[]
  readonly index?: number
  readonly key?: string
  /** Names of this scope under the options of its choice that are not chosen. */
  readonly hidden?: ReadonlySet<string>
}

interface Scope {
  /** Flattened prefix of this scope's rows: '' or 'loras.lora0.'. */
  readonly prefix: string
  /** False below a member past the minimum of an optional-after-minimum group. */
  readonly required: boolean
  /** Inside a member the document does not store. */
  readonly ghost: boolean
  /** Inside an option or variant that is not chosen (dormant census only). */
  readonly dormant: boolean
  readonly hidden: boolean
  readonly origin: ElaboratedOrigin
  readonly ancestry: readonly DynamicAncestor[]
  readonly frames?: readonly MaterializeFrame[]
  readonly section?: string
  /** Type-variable scope of an independent-types member (`group.key`). */
  readonly typeMember?: string
  /** Prefix for the labels of a record member's rows. */
  readonly labelPrefix?: string
  readonly formulaFrames: readonly FormulaFrame[]
  /** Use overrides for the shared rows of the choice whose option this is. */
  readonly shared?: ReadonlyMap<string, BodyRow>
}

const scopeType = (type: TypeExpr, member: string): TypeExpr => {
  if (type.kind === 'variable') return { ...type, templateId: `${member}:${type.templateId}` }
  if (type.kind === 'tuple') return { ...type, elements: type.elements.map((element) => scopeType(element, member)) }
  if (type.kind === 'list' || type.kind === 'asset' || type.kind === 'stream') return { ...type, element: scopeType(type.element, member) }
  return type
}

/** The pin type of a type choice before a variant is chosen. */
function slotTypeOf(choice: TypeChoiceSpec): TypeExpr {
  if (choice.type !== undefined) return choice.type
  const variants = choice.variants ?? []
  if (variants.length === 1) return variants[0]!.type
  if (variants.length > 1 && variants.every((variant) => variant.type.kind === 'concrete')) {
    const names = [...new Set(variants.map((variant) => (variant.type as Extract<TypeExpr, { kind: 'concrete' }>).name))]
    return names.length === 1 ? { kind: 'concrete', name: names[0]! } : { kind: 'union', names }
  }
  return { kind: 'wildcard' }
}

/** A literal label, or undefined when the label is a formula (formula labels are worked out where they are drawn). */
const literalText = (value: string | { readonly formula: string } | undefined): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** A stored JSON value as a formula reads it, for a row of `kind`. */
function formulaValueOf(raw: unknown, kind: FormulaNameKind): FormulaValue | Unknown {
  if (raw === undefined || raw === null || typeof raw === 'boolean' || typeof raw === 'string') return raw ?? null
  if (typeof raw === 'number') {
    if (kind === 'int' && Number.isSafeInteger(raw)) return BigInt(raw)
    return raw
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const big = (raw as Record<string, unknown>)['$int']
    if (typeof big === 'string' && /^-?[0-9]+$/.test(big)) return BigInt(big)
    return UNKNOWN
  }
  if (Array.isArray(raw)) {
    const items: (bigint | number | boolean | string | null)[] = []
    for (const item of raw) {
      const value = formulaValueOf(item, kind.endsWith('[]') ? (kind.slice(0, -2) as FormulaNameKind) : kind)
      if (value === UNKNOWN || Array.isArray(value)) return UNKNOWN
      items.push(value as bigint | number | boolean | string | null)
    }
    return items
  }
  return UNKNOWN
}

const defaultOf = (row: InputSpec): unknown => row.widget?.default ?? row.ext?.['default']

/** Passes a node's choice keys take to settle; a longer chain of formulas is refused. */
const MAX_CHOICE_PASSES = 8

/**
 * Elaborate one node's effective interface. Pure and deterministic over
 * (schema, node.values/node.dynamic/node.additionalInputs, connectivity).
 */
export function elaborateInterface(
  schema: NodeSchema,
  node: Pick<NodeData, 'values' | 'dynamic' | 'additionalInputs'>,
  connectivity: Connectivity = EMPTY_CONNECTIVITY,
  options: ElaborateOptions = {},
): ElaboratedInterface {
  // A formula may read a choice the walk has not reached yet, such as a led
  // choice declared later. Such a read takes the key the previous pass
  // settled, and the passes repeat until every key read is the key settled,
  // so declaration order does not change the result.
  let settled: ReadonlyMap<string, string | null> = new Map()
  for (let pass = 1; ; pass++) {
    const result = elaboratePass(schema, node, connectivity, options, settled)
    const unsettled = [...result.early].filter((path) => (result.chosen.get(path) ?? null) !== (settled.get(path) ?? null))
    if (unsettled.length === 0) return result.elaborated
    if (pass === MAX_CHOICE_PASSES) {
      return {
        ...result.elaborated,
        diagnostics: [...result.elaborated.diagnostics, diag('error', 'schema', 'elab.choice.unsettled',
          `${schema.type}: the keys of ${unsettled.map((path) => `'${path}'`).join(', ')} depend on each other and never settle`)],
      }
    }
    settled = result.chosen
  }
}

function elaboratePass(
  schema: NodeSchema,
  node: Pick<NodeData, 'values' | 'dynamic' | 'additionalInputs'>,
  connectivity: Connectivity,
  options: ElaborateOptions,
  settled: ReadonlyMap<string, string | null>,
): { readonly elaborated: ElaboratedInterface; readonly chosen: ReadonlyMap<string, string | null>; readonly early: ReadonlySet<string> } {
  const budget: ElabBudget = { ...DEFAULT_ELAB_BUDGET, ...options.budget }
  const view = options.promoteGhosts ?? true
  const census = options.includeDormant ?? false
  const items: ElaboratedItem[] = []
  const outputMembers: Record<string, string[]> = {}
  const choices: Record<string, string> = {}
  const unstoredChoices: Record<string, string> = {}
  const unstoredMinimums: Record<string, MaterializeFrame> = {}
  const constructs = new Set<string>()
  const diagnostics: Diagnostic[] = []
  const emittedInputs = new Set<string>()
  const emittedOutputs = new Set<string>()
  // A dormant census visits every option and variant, so a row they share, or
  // a row id two variants both declare, is emitted once per visit. Only rows
  // in the chosen interface must have unique ids.
  const activeInputs = new Set<string>()
  const activeOutputs = new Set<string>()
  const claim = (emitted: Set<string>, active: Set<string>, path: string, scope: Scope): boolean => {
    if (!scope.dormant) {
      if (active.has(path)) return false
      active.add(path)
    }
    emitted.add(path)
    return true
  }
  const readState = new Set<string>()
  const tables = formulaTablesOf(schema.tables)
  const derived = new Map(Object.entries(schema.derived ?? {}))
  /** Choice keys this elaboration settled, which formulas read before the run stores them. */
  const chosen = new Map<string, string | null>()
  /** Choices a formula read before the walk settled them. */
  const early = new Set<string>()
  /** The key of a choice the walk has not settled: the stored one, else the previous pass's. */
  const unsettledKey = (path: string): string | null | undefined => {
    const selected = stateOf(path)?.selected
    if (selected !== undefined) return selected
    early.add(path)
    return settled.get(path)
  }
  let depth = 0
  let membersVisited = 0
  let halted = false

  const report = (code: string, message: string, port?: string, severity: 'error' | 'warning' = 'error'): void => {
    diagnostics.push(diag(severity, 'schema', code, `${schema.type}: ${message}`, {
      ...(options.nodeId !== undefined && port !== undefined
        ? { anchor: { port: { node: options.nodeId, port: asPortId(port) } } }
        : {}),
    }))
  }
  const exhaust = (code: string, message: string): void => {
    if (halted) return
    halted = true
    report(code, message)
  }
  const stateOf = (path: string): DynamicPortState | undefined => {
    readState.add(path)
    return node.dynamic?.[path]
  }
  const linked = (path: string): boolean => connectivity.isInputConnected(path)
  const stored = (path: string): boolean => Object.hasOwn(node.values, path) || linked(path)

  const push = (item: ElaboratedItem): boolean => {
    if (halted) return false
    if (items.length >= budget.maxItems) {
      exhaust('elab.budget.items', `elaborated interface exceeds ${budget.maxItems} items; elaboration stopped`)
      return false
    }
    items.push(item)
    return true
  }

  // -- Formulas (a group's count and a choice's leader) ----------------------

  /** The value a formula reads for one flattened id, and whether a wire feeds it. */
  const valueFor = (path: string, kind: FormulaNameKind, fallback: unknown): FormulaValue | Unknown => {
    if (chosen.has(path)) return chosen.get(path)!
    if (kind === 'choice') {
      const key = unsettledKey(path)
      if (key !== undefined) return key
    }
    if (linked(path)) return UNKNOWN
    return formulaValueOf(Object.hasOwn(node.values, path) ? node.values[path] : fallback, kind)
  }

  /** Member keys a formula counts for a group: the stored ones, or a count group's own. */
  const membersFor = (path: string): readonly string[] => stateOf(path)?.members ?? []

  /**
   * Names, as a formula in this scope writes them, of rows under an option
   * that is not chosen: a formula reads them as unknown, with no wire.
   */
  const unchosen = (rows: readonly OptionRow[], prefix: string): Set<string> => {
    const hidden = new Set<string>()
    for (const row of scopeRowsOf(rows)) {
      if (row.kind === 'choice') {
        const path = prefix + row.id
        const key = chosen.has(path) ? chosen.get(path) : unsettledKey(path)
        const live = key === undefined || key === null ? [] : optionRows(row, key)
        const kept = scopeNamesOf(live).names
        for (const name of scopeNamesOf(choiceScopeRows(row)).names.keys()) if (!kept.has(name)) hidden.add(`${row.id}.${name}`)
        for (const name of unchosen(live, `${path}.`)) hidden.add(`${row.id}.${name}`)
      } else if (row.kind === 'typeChoice') {
        for (const name of unchosen(row.rows, `${prefix}${row.id}.`)) hidden.add(`${row.id}.${name}`)
      }
    }
    return hidden
  }

  /**
   * The default of each field by flattened id, under the chosen options and
   * the members the node stores, with each Use's override, as the engine
   * gives a formula reading a field with nothing stored.
   */
  const defaultsUnder = (list: readonly OptionRow[], prefix: string, found: Map<string, unknown>, shared?: ReadonlyMap<string, BodyRow>): void => {
    for (const row of list) {
      if (row.kind === 'use') {
        const target = shared?.get(row.id)
        if (target !== undefined) defaultsUnder([applyUse(target, row)], prefix, found)
      } else if (row.kind === 'section' || row.kind === 'row') {
        defaultsUnder(row.rows, prefix, found, shared)
      } else if (row.kind === 'input') {
        found.set(prefix + row.id, defaultOf(row))
      } else if (row.kind === 'state') {
        found.set(prefix + row.id, row.default)
      } else if (row.kind === 'choice') {
        const path = prefix + row.id
        const key = chosen.has(path) ? chosen.get(path) : unsettledKey(path)
        const option = row.options.find((item) => item.key === key)
        if (option !== undefined) {
          defaultsUnder(option.rows, `${path}.`, found,
            new Map(row.shared.filter((item) => item.kind !== 'row').map((item) => [(item as { id: string }).id, item])))
        }
      } else if (row.kind === 'typeChoice') {
        const path = prefix + row.id
        const variant = row.variants?.find((item) => item.key === stateOf(path)?.selected)
        defaultsUnder([...row.rows, ...(variant?.rows ?? [])], `${path}.`, found)
      } else if (row.kind === 'group') {
        const path = prefix + row.id
        for (const key of membersFor(path)) {
          if (row.value !== undefined) found.set(`${path}.${key}`, row.value.kind === 'input' ? defaultOf(row.value) : undefined)
          else defaultsUnder(row.member ?? [], `${path}.${key}.`, found)
        }
      }
    }
  }

  /** The names a formula sees in `scope`, their values in the stored state, and where each is stored. */
  const contextOf = (scope: Scope): FormulaContext => {
    const names = framesNamesOf(scope.formulaFrames.map((frame) => frame.rows))
    const where = new Map<string, string>()
    const defaults = new Map<string, unknown>()
    defaultsUnder(schema.body, '', defaults)
    const unknown = new Set<string>()
    for (const frame of scope.formulaFrames) {
      const hidden = unchosen(frame.rows, frame.prefix)
      for (const name of frame.hidden ?? []) hidden.add(name)
      for (const name of framesNamesOf([frame.rows]).names.keys()) {
        where.set(name, frame.prefix + name)
        if (hidden.has(name)) unknown.add(name)
        else unknown.delete(name)
      }
      // A member the node shows but does not store reads its own rows' defaults.
      for (const row of scopeRowsOf(frame.rows)) {
        if (row.kind !== 'input' && row.kind !== 'state') continue
        const path = frame.prefix + row.id
        if (!defaults.has(path)) defaults.set(path, row.kind === 'input' ? defaultOf(row) : row.default)
      }
    }
    const member = [...scope.formulaFrames].reverse().find((frame) => frame.index !== undefined)
    const values = new Map<string, FormulaValue | Unknown>()
    const wired = new Map<string, boolean>()
    const sizes = new Map<string, number>()
    for (const [name, kind] of names.names) {
      const path = where.get(name)!
      if (unknown.has(name)) {
        // A group's size with no entry in `sizes` reads unknown.
        if (kind !== 'opaque' && kind !== 'group') values.set(name, UNKNOWN)
        if (names.inputs.has(name)) wired.set(name, false)
      } else if (kind === 'group') {
        sizes.set(name, membersFor(path).length)
      } else if (kind.endsWith('[]')) {
        const dot = path.lastIndexOf('.')
        const group = path.slice(0, dot)
        const row = path.slice(dot + 1)
        const list: (bigint | number | boolean | string | null)[] = []
        let unknown = false
        for (const key of membersFor(group)) {
          const value = valueFor(`${group}.${key}.${row}`, kind.slice(0, -2) as FormulaNameKind, defaults.get(`${group}.${key}.${row}`))
          if (value === UNKNOWN || Array.isArray(value)) unknown = true
          else list.push(value as bigint | number | boolean | string | null)
        }
        values.set(name, unknown ? UNKNOWN : list)
      } else {
        if (kind !== 'opaque') values.set(name, valueFor(path, kind, defaults.get(path)))
        if (names.inputs.has(name)) wired.set(name, linked(path))
      }
    }
    return {
      scope: {
        names: names.names,
        inputs: names.inputs,
        assets: names.assets,
        tables,
        derived,
        inMember: member !== undefined,
      },
      values: {
        values,
        linked: wired,
        groupSizes: sizes,
        memberIndex: member?.index ?? null,
        memberKey: member?.key ?? null,
      },
      paths: where,
      ...(scope.ghost ? { ghost: true as const } : {}),
    }
  }

  const evaluate = (text: string, scope: Scope): ReturnType<Formula['evaluate']> => {
    const context = contextOf(scope)
    try {
      return Formula.parse(text, context.scope).evaluate(context.values)
    } catch (error) {
      if (error instanceof FormulaRefused) return { kind: 'failed', reason: error.message }
      throw error
    }
  }

  // -- Emission ---------------------------------------------------------------

  const common = (scope: Scope): Pick<ElaboratedInput, 'origin' | 'ancestry' | 'materialize'> => ({
    origin: scope.origin,
    ...(scope.ancestry.length > 0 ? { ancestry: scope.ancestry } : {}),
    ...(scope.frames !== undefined ? { materialize: scope.frames } : {}),
  })

  const emitInput = (row: InputSpec, path: string, scope: Scope, label?: string, extra: Partial<ElaboratedInput> = {}): void => {
    if (!claim(emittedInputs, activeInputs, path, scope)) {
      exhaust('elab.projectedNamespaceCollision', `projected input namespace collision at '${path}'`)
      return
    }
    let spec: InputSpec = {
      ...row,
      id: path,
      displayName: label ?? (scope.labelPrefix !== undefined ? `${scope.labelPrefix} ${row.displayName ?? row.id}` : row.displayName ?? row.id),
      optional: row.optional || !scope.required || scope.ghost,
      ...(scope.section !== undefined ? { section: scope.section } : {}),
      ...(scope.hidden ? { hidden: true as const } : {}),
      ...(scope.typeMember !== undefined ? { type: scopeType(row.type, scope.typeMember) } : {}),
    }
    const widget = spec.widget
    if (widget?.editableOptions) {
      const stored = stateOf(path)?.options
      if (stored !== undefined) spec = { ...spec, widget: { ...widget, options: { ...widget.options, options: stored } } }
    }
    push({
      kind: 'input',
      address: { port: path },
      ...(scope.ghost || scope.dormant ? {} : { apiName: path }),
      spec,
      ...common(scope),
      ...extra,
    })
  }

  const emitOutput = (row: OutputSpec, path: string, scope: Scope, label?: string): void => {
    if (!claim(emittedOutputs, activeOutputs, path, scope)) {
      exhaust('elab.projectedNamespaceCollision', `projected output namespace collision at '${path}'`)
      return
    }
    push({
      kind: 'output',
      address: { port: path },
      spec: {
        ...row,
        id: path,
        displayName: label ?? (scope.labelPrefix !== undefined ? `${scope.labelPrefix} ${row.displayName ?? row.id}` : row.displayName ?? row.id),
        ...(scope.section !== undefined ? { section: scope.section } : {}),
        ...(scope.typeMember !== undefined ? { type: scopeType(row.type, scope.typeMember) } : {}),
      },
      ...common(scope),
      ...(scope.ghost || scope.dormant ? { wireable: false as const } : {}),
    })
  }

  // -- The walk ---------------------------------------------------------------

  const enter = (path: string): boolean => {
    if (halted) return false
    if (depth + 1 > budget.maxDepth) {
      exhaust('elab.budget.depth', `'${path}' nests deeper than ${budget.maxDepth}; elaboration stopped`)
      return false
    }
    depth++
    return true
  }

  const rows = (list: readonly OptionRow[], scope: Scope): void => {
    if (options.formulaContexts !== undefined && !options.formulaContexts.has(scope.prefix)) {
      options.formulaContexts.set(scope.prefix, contextOf(scope))
    }
    for (const raw of list) {
      if (halted) return
      let row: BodyRow
      if (raw.kind === 'use') {
        const shared = scope.shared?.get(raw.id)
        if (shared === undefined) continue
        row = applyUse(shared, raw as UseSpec)
      } else {
        row = raw
      }
      one(row, scope)
    }
  }

  const one = (row: BodyRow, scope: Scope): void => {
    switch (row.kind) {
      case 'input':
        emitInput(row, scope.prefix + row.id, scope)
        return
      case 'output':
        emitOutput(row, scope.prefix + row.id, scope)
        return
      case 'state':
        if (row.partOfRun) {
          emitInput({
            kind: 'input',
            id: row.id,
            type: row.type,
            optional: true,
            hidden: true,
            socketless: true,
            ...(row.default !== undefined ? { ext: { default: row.default } } : {}),
          }, scope.prefix + row.id, scope)
        }
        return
      case 'section':
        section(row, scope)
        return
      case 'row':
        line(row.rows, scope)
        return
      case 'group':
        group(row, scope.prefix + row.id, scope)
        return
      case 'choice':
        choice(row, scope.prefix + row.id, scope)
        return
      case 'typeChoice':
        typeChoice(row, scope.prefix + row.id, scope)
        return
      case 'described':
        described(row, scope.prefix + row.id, scope)
        return
      case 'note':
      case 'button':
        layoutRow(row, scope)
        return
      case 'editor':
        return
    }
  }

  /** A note or a button: drawn, never stored, compiled or wired. */
  const layoutRow = (row: NoteSpec | ButtonSpec, scope: Scope, adjacentTo?: string): string | undefined => {
    if (scope.ghost || scope.dormant || scope.hidden) return undefined
    const id = scope.prefix + row.id
    const placed = {
      ...(scope.section !== undefined ? { section: scope.section } : {}),
      ...(adjacentTo !== undefined ? { adjacentTo } : {}),
    }
    const item: ElaboratedItem = row.kind === 'note'
      ? typeof row.text === 'string'
        ? { kind: 'note', id, text: row.text, ...placed }
        : { kind: 'note', id, text: row.unknown ?? '', unknown: true, ...placed }
      : { kind: 'button', id, label: row.label, spec: row, ...placed }
    return push(item) ? lineKeyOf(item) : undefined
  }

  const section = (row: SectionSpec, scope: Scope): void => {
    const id = scope.prefix + row.id
    if (!enter(id)) return
    const label = literalText(row.displayName)
    push({
      kind: 'section',
      spec: {
        kind: 'section',
        id,
        ...(label !== undefined ? { displayName: label } : {}),
        ...(row.collapsedByDefault ? { collapsedByDefault: true } : {}),
      },
      ...(scope.section !== undefined ? { section: scope.section } : {}),
    })
    rows(row.rows, { ...scope, section: id })
    depth--
  }

  /** Fields side by side: each after the first is drawn beside the one before it. */
  const line = (list: readonly BodyRow[], scope: Scope): void => {
    if (!enter(`${scope.prefix}row`)) return
    let previous: string | undefined
    for (const row of list) {
      if (row.kind === 'note' || row.kind === 'button') {
        previous = layoutRow(row, scope, previous) ?? previous
        continue
      }
      if (row.kind !== 'input') continue
      const path = scope.prefix + row.id
      emitInput(previous === undefined ? row : { ...row, adjacentTo: previous }, path, scope)
      previous = path
    }
    depth--
  }

  const memberLabelOf = (group: GroupSpec, path: string, key: string, position: number, scope: Scope): string => {
    const typed = stateOf(path)?.memberLabels?.[key]
    if (typed !== undefined && typed !== '') return typed
    if (group.memberLabel !== undefined) {
      if (typeof group.memberLabel === 'string') return group.memberLabel
      const outcome = evaluate(group.memberLabel.formula, {
        ...scope,
        formulaFrames: [...scope.formulaFrames, { prefix: `${path}.`, rows: [], index: position, key }],
      })
      if (outcome.kind === 'value' && typeof outcome.value === 'string' && outcome.value !== '') return outcome.value
    }
    if (group.keys.kind === 'named') return key
    const number = String(position + 1)
    return group.keys.prefix === '' ? number : `${group.keys.prefix} ${number}`
  }

  const group = (row: GroupSpec, path: string, scope: Scope): void => {
    if (!enter(path)) return
    if (!scope.ghost) constructs.add(path)
    try {
      groupBody(row, path, scope)
    } finally {
      depth--
    }
  }

  const groupBody = (row: GroupSpec, path: string, scope: Scope): void => {
    const limit = memberLimitOf(row)
    const grows = row.grows
    let keys: string[]
    let storedCount: number
    if (typeof grows === 'object' && 'followList' in grows) {
      report('elab.group.followList', `group '${path}' follows a list, and a field that holds a list of assets is not built yet`, path)
      return
    }
    if (typeof grows === 'object' && 'count' in grows) {
      const outcome = evaluate(grows.count, scope)
      const value = outcome.kind === 'value' ? outcome.value : undefined
      let count = typeof value === 'bigint' && value >= 0n ? Number(value > BigInt(limit) ? BigInt(limit) : value) : row.minMembers
      count = Math.min(count, limit)
      keys = []
      for (let index = 0; index < count; index++) keys.push(memberKeyAt(row.keys, index)!)
      storedCount = keys.length
    } else {
      const state = stateOf(path)
      keys = [...(state?.members ?? [])]
      for (const key of keys) {
        if (keyPosition(row.keys, key) === undefined) {
          report('elab.autogrow.badMember', `group '${path}' has a member key its naming rule cannot make: '${key}'`, path)
          return
        }
      }
      if (new Set(keys).size !== keys.length) {
        report('elab.autogrow.badMember', `group '${path}' stores a member key twice`, path)
        return
      }
      if (keys.length > limit) {
        report('elab.autogrow.overMax', `group '${path}' has more than ${limit} members`, path)
        return
      }
      storedCount = keys.length
      if (!view && !scope.ghost && !scope.dormant && storedCount < row.minMembers && hasRequiredRow(row)) {
        report('elab.autogrow.underMin', `${path} needs at least ${row.minMembers} members; the run has ${storedCount}`, path)
      }
    }
    if (membersVisited + keys.length > budget.maxMembers) {
      exhaust('elab.budget.members', `group members exceed ${budget.maxMembers}; elaboration stopped`)
      return
    }

    const holdsOutput = memberRowsOf(row).some(function holds(item: OptionRow): boolean {
      switch (item.kind) {
        case 'output': return true
        case 'section': case 'row': return item.rows.some(holds)
        case 'group': return memberRowsOf(item).some(holds)
        case 'choice': return choiceScopeRows(item).some(holds)
        case 'typeChoice': return [...item.rows, ...(item.variants ?? []).flatMap((variant) => variant.rows)].some(holds)
        case 'described': return item.kinds.some((kind) => kind.kind === 'output')
        default: return false
      }
    })
    // The run's member list gives the engine the order of a grown group's
    // members, including one whose only stored state is a choice or an output.
    if (typeof grows === 'string' && !scope.ghost && !scope.dormant && storedCount > 0) {
      outputMembers[path] = [...keys]
    }

    let seq = Math.max(stateOf(path)?.seq ?? 0, ...keys.map((key) => keyPosition(row.keys, key)! + 1))
    const offered: string[] = []
    const fresh = (): string | undefined => {
      if (row.keys.kind === 'named') return row.keys.names.find((name) => !keys.includes(name) && !offered.includes(name))
      if (seq >= Number.MAX_SAFE_INTEGER) return undefined
      return memberKeyAt(row.keys, seq++)
    }
    const growthLabel = literalText(row.addLabel) ?? literalText(row.displayName) ?? row.id
    const frameFor = (members: readonly string[]): MaterializeFrame => ({
      construct: path,
      members,
      ...(row.keys.kind === 'numbered' ? { seq: keyPosition(row.keys, members.at(-1)!)! + 1 } : {}),
    })

    /** Emit one member; returns whether it is in use (a stored value or a wire). */
    const member = (position: number, key: string, ghost: boolean, dormant = false): boolean => {
      membersVisited++
      const frames = ghost ? [...(scope.frames ?? []), frameFor(offered.slice(0, position - storedCount + 1))] : scope.frames
      const required = scope.required && (!row.optionalAfterMinimum || position < row.minMembers)
      const label = memberLabelOf(row, path, key, position, scope)
      const memberScope: Scope = {
        ...scope,
        required,
        ghost: scope.ghost || ghost,
        dormant: scope.dormant || dormant,
        origin: { kind: 'member', construct: path, ordinal: position, key, ...(ghost ? { ghost: true } : {}) },
        ancestry: [...scope.ancestry, {
          construct: path,
          member: key as DynamicMemberId,
          ordinal: position,
          ...(ghost ? { ghost: true, synthetic: true } : {}),
        }],
        ...(frames !== undefined ? { frames } : {}),
        ...(row.independentTypes ? { typeMember: `${path}.${key}` } : {}),
      }
      const before = items.length
      if (row.value !== undefined) {
        const valueScope: Scope = {
          ...memberScope,
          prefix: `${path}.`,
          formulaFrames: [...scope.formulaFrames, { prefix: `${path}.`, rows: [], index: position, key }],
        }
        if (row.value.kind === 'input') emitInput({ ...row.value, id: key }, `${path}.${key}`, valueScope, label)
        else emitOutput({ ...row.value, id: key }, `${path}.${key}`, valueScope, label)
      } else {
        const prefix = `${path}.${key}.`
        rows(row.member ?? [], {
          ...memberScope,
          prefix,
          labelPrefix: label,
          formulaFrames: [...scope.formulaFrames, { prefix, rows: row.member ?? [], index: position, key }],
        })
      }
      const emitted = items.slice(before)
      if (ghost && emitted.length === 0 && position === storedCount + offered.length - 1) {
        push({
          kind: 'growth',
          construct: path,
          side: holdsOutput && !memberRowsOf(row).some((item) => item.kind === 'input') ? 'output' : 'input',
          label: growthLabel,
          frames: frames!,
          ...(scope.section !== undefined ? { section: scope.section } : {}),
        })
      }
      return emitted.some((item) =>
        (item.kind === 'input' && (Object.hasOwn(node.values, item.address.port) || linked(item.address.port))) ||
        (item.kind === 'output' && connectivity.isOutputConnected(item.address.port)))
    }

    let allUsed = true
    for (const [position, key] of keys.entries()) {
      if (halted) return
      if (!member(position, key, false)) allUsed = false
    }
    // A count that shrank leaves its later members stored: the census reads
    // them as dormant, as it reads an option that is not chosen.
    if (census && typeof grows === 'object' && 'count' in grows) {
      const later = new Map<number, string>()
      for (const stored of [...Object.keys(node.values), ...Object.keys(node.dynamic ?? {})]) {
        if (!stored.startsWith(`${path}.`)) continue
        const key = stored.slice(path.length + 1).split('.')[0]!
        const position = keyPosition(row.keys, key)
        if (position !== undefined && position >= keys.length && position < limit) later.set(position, key)
      }
      for (const [position, key] of [...later.entries()].sort(([a], [b]) => a - b)) {
        if (halted) return
        member(position, key, false, true)
      }
    }

    // Members the node offers beyond the stored ones: up to the minimum, and
    // one spare once every member of a group that grows by link or by a
    // filled field is in use, so a minimum of five shows five until the
    // fifth is used.
    if (!view || typeof grows !== 'string' || scope.dormant) return
    const spare = (grows === 'link' || grows === 'filled') && !scope.ghost && allUsed ? 1 : 0
    const shown = Math.min(limit, Math.max(row.minMembers, storedCount + spare))
    while (storedCount + offered.length < shown) {
      const key = fresh()
      if (key === undefined) break
      offered.push(key)
    }
    // A member the node always shows is not the user's to add: the editor stores it.
    const missing = Math.min(row.minMembers, storedCount + offered.length) - storedCount
    if (!scope.ghost && missing > 0) unstoredMinimums[path] = frameFor(offered.slice(0, missing))
    if (membersVisited + offered.length > budget.maxMembers) {
      exhaust('elab.budget.members', `group members exceed ${budget.maxMembers}; elaboration stopped`)
      return
    }
    for (const [index, key] of offered.entries()) {
      if (halted) return
      member(storedCount + index, key, true)
    }
    if (grows === 'button' && !scope.ghost && storedCount + offered.length < limit) {
      const key = fresh()
      if (key !== undefined) {
        push({
          kind: 'growth',
          construct: path,
          side: 'input',
          label: growthLabel,
          frames: [...(scope.frames ?? []), frameFor([...offered, key])],
          ...(scope.section !== undefined ? { section: scope.section } : {}),
        })
      }
    }
  }

  const choice = (row: ChoiceSpec, path: string, scope: Scope): void => {
    if (!enter(path)) return
    if (!scope.ghost) constructs.add(path)
    try {
      choiceBody(row, path, scope)
    } finally {
      depth--
    }
  }

  const choiceBody = (row: ChoiceSpec, path: string, scope: Scope): void => {
    const keys = row.options.map((option) => option.key)
    const storedKey = row.leader === undefined ? stateOf(path)?.selected : undefined
    let key: string | undefined
    if (row.leader !== undefined) {
      const outcome = evaluate(row.leader, scope)
      if (outcome.kind === 'value' && typeof outcome.value === 'string' && keys.includes(outcome.value)) key = outcome.value
      else if (outcome.kind === 'value' && outcome.value === null && !row.required) key = undefined
      else key = keys[0]
      const stale = stateOf(path)?.selected
      if (stale !== undefined && stale !== key) {
        report('prompt.bad_dynamic_choice', `choice '${path}' is led by a formula; '${stale}' was stored`, path)
        return
      }
    } else if (storedKey !== undefined) {
      if (!keys.includes(storedKey)) {
        report('prompt.bad_dynamic_choice', `choice '${path}' has unknown option '${storedKey}'`, path)
        return
      }
      key = storedKey
    } else if (row.required && !view && !scope.ghost && !scope.dormant) {
      // The editor stores a required choice's start key on every command
      // (storeStartState); a run never makes one up.
      report('prompt.missing_dynamic_choice', `required choice '${path}' has no stored option`, path)
      return
    } else {
      key = row.required ? row.default ?? keys[0] : undefined
    }
    chosen.set(path, key ?? null)
    const inRun = !scope.ghost && !scope.dormant
    if (key !== undefined && inRun) choices[path] = key
    if (key !== undefined && inRun && row.required && row.leader === undefined && storedKey === undefined) unstoredChoices[path] = key
    if (row.leader === undefined) {
      const label = literalText(row.displayName) ?? row.id
      const startKey = row.required ? row.default ?? keys[0] : undefined
      const widget: WidgetSpec = {
        widgetType: 'COMBO',
        options: {
          options: row.options.map((option) => option.label !== undefined ? { value: option.key, label: option.label } : option.key),
        },
        ...(startKey !== undefined ? { default: startKey } : {}),
      }
      const selector: InputSpec = {
        kind: 'input',
        id: row.id,
        type: { kind: 'concrete', name: 'COMBO' },
        optional: !row.required,
        displayName: label,
        socketless: true,
        widget,
        ...(row.hidden ? { hidden: true as const } : {}),
        ...(literalText(row.tooltip) !== undefined ? { tooltip: literalText(row.tooltip)! } : {}),
      }
      if (!claim(emittedInputs, activeInputs, path, scope)) {
        exhaust('elab.projectedNamespaceCollision', `projected input namespace collision at '${path}'`)
        return
      }
      push({
        kind: 'input',
        address: { port: path },
        spec: {
          ...selector,
          id: path,
          ...(scope.labelPrefix !== undefined ? { displayName: `${scope.labelPrefix} ${label}` } : {}),
          ...(scope.section !== undefined ? { section: scope.section } : {}),
          ...(scope.hidden ? { hidden: true as const } : {}),
        },
        origin: { kind: 'selector', construct: path, ...(key !== undefined ? { selected: key } : {}) },
        ...(key !== undefined ? { derivedValue: key } : {}),
        ...(scope.ancestry.length > 0 ? { ancestry: scope.ancestry } : {}),
        ...(scope.frames !== undefined ? { materialize: scope.frames } : {}),
      })
    }
    const shared = new Map(row.shared.filter((item) => item.kind !== 'row').map((item) => [(item as { id: string }).id, item]))
    const every = choiceScopeRows(row)
    for (const option of row.options) {
      const active = option.key === key
      if (!active && !census) continue
      // The option's formulas read the other options' rows as unknown.
      const kept = scopeNamesOf(optionRows(row, option.key)).names
      const frame: FormulaFrame = {
        prefix: `${path}.`, rows: every,
        hidden: new Set([...scopeNamesOf(every).names.keys()].filter((name) => !kept.has(name))),
      }
      rows(option.rows, {
        ...scope,
        prefix: `${path}.`,
        // A hidden choice hides its option's rows too; they are still stored and run.
        hidden: scope.hidden || row.hidden === true,
        dormant: scope.dormant || !active,
        origin: { kind: 'branch', construct: path, option: option.key },
        shared,
        formulaFrames: [...scope.formulaFrames, frame],
      })
    }
  }

  const typeChoice = (row: TypeChoiceSpec, path: string, scope: Scope): void => {
    if (!enter(path)) return
    if (!scope.ghost) constructs.add(path)
    try {
      typeChoiceBody(row, path, scope)
    } finally {
      depth--
    }
  }

  const typeChoiceBody = (row: TypeChoiceSpec, path: string, scope: Scope): void => {
    const label = literalText(row.displayName) ?? row.id
    const tooltip = literalText(row.tooltip)
    const base: InputSpec = {
      kind: 'input',
      id: row.id,
      type: slotTypeOf(row),
      optional: true,
      displayName: label,
      ...(tooltip !== undefined ? { tooltip } : {}),
    }
    const dependents = (list: readonly BodyRow[], variant: string | undefined, dormant: boolean): void => {
      rows(list, {
        ...scope,
        prefix: `${path}.`,
        dormant: scope.dormant || dormant,
        origin: { kind: 'dependent', construct: path, ...(variant !== undefined ? { variant } : {}) },
        formulaFrames: [...scope.formulaFrames, {
          prefix: `${path}.`,
          rows: [...row.rows, ...(row.variants?.find((item) => item.key === variant)?.rows ?? [])],
        }],
      })
    }
    if (row.variants === undefined) {
      emitInput(base, path, scope, undefined, { origin: { kind: 'slot', construct: path } })
      if (stored(path) || census) dependents(row.rows, undefined, !stored(path))
      return
    }
    const variants = row.variants.map(({ key, type }) => ({ key, type }))
    const key = stateOf(path)?.selected
    const variant = row.variants.find((item) => item.key === key)
    if (key !== undefined && variant === undefined) {
      report('prompt.bad_dynamic_choice', `type choice '${path}' has unknown variant '${key}'`, path)
      return
    }
    if (variant === undefined && row.required && !view && !scope.ghost && !scope.dormant) {
      report('prompt.missing_dynamic_choice', `required type choice '${path}' has no stored variant`, path)
    }
    const inRun = !scope.ghost && !scope.dormant
    if (variant !== undefined && inRun) choices[path] = variant.key
    if (variant !== undefined || row.required || view || census || linked(path)) {
      emitInput(
        { ...base, type: variant?.type ?? base.type, optional: variant === undefined ? !row.required : false },
        path,
        variant === undefined && !census && !linked(path) ? { ...scope, dormant: true } : scope,
        undefined,
        {
          origin: {
            kind: 'slot',
            construct: path,
            variants,
            ...(variant !== undefined ? { selected: variant.key } : {}),
            ...(row.typeVariable !== undefined ? { typeTemplateId: row.typeVariable } : {}),
          },
        },
      )
    }
    if (variant !== undefined) dependents([...row.rows, ...variant.rows], variant.key, false)
    if (census) {
      for (const item of row.variants) {
        if (item !== variant) dependents([...(variant === undefined ? row.rows : []), ...item.rows], item.key, true)
      }
    }
  }

  /** The description stored under the row's own id, and one row per entry. */
  const described = (row: DescribedSpec, path: string, scope: Scope): void => {
    if (!enter(path)) return
    try {
      emitInput({
        kind: 'input',
        id: row.id,
        type: { kind: 'concrete', name: 'STRING' },
        optional: true,
        hidden: true,
        socketless: true,
      }, path, scope)
      if (linked(path)) {
        report('elab.outputDescriptors.linkedSource', `described '${path}': the description is a stored value, not a wire`, path)
        return
      }
      const raw = node.values[path]
      const parsed = describedEntries(row, raw === undefined || raw === null ? undefined : raw, path)
      if (typeof parsed === 'string') {
        report('elab.outputDescriptors.invalid', parsed, path)
        return
      }
      for (const entry of parsed) {
        const kind = row.kinds.find((candidate) => candidate.id === entry.kind)!
        const entryPath = `${path}.${entry.id}`
        if (kind.kind === 'output') {
          emitOutput({ ...kind, id: entry.id }, entryPath, scope, entry.label)
          continue
        }
        let spec: InputSpec = { ...kind, id: entry.id }
        if (kind.widget !== undefined) {
          const options: Record<string, unknown> = { ...kind.widget.options }
          for (const [field, value] of Object.entries(entry.fields)) options[field] = value
          spec = {
            ...spec,
            widget: {
              ...kind.widget,
              options,
              ...(entry.default !== undefined ? { default: entry.default as Json } : {}),
            },
          }
        } else if (entry.default !== undefined) {
          spec = { ...spec, ext: { ...spec.ext, default: entry.default } }
        }
        emitInput(spec, entryPath, scope, entry.label)
      }
    } finally {
      depth--
    }
  }

  const topScope: Scope = {
    prefix: '',
    required: true,
    ghost: false,
    dormant: false,
    hidden: false,
    origin: { kind: 'static' },
    ancestry: [],
    formulaFrames: [{ prefix: '', rows: schema.body }],
  }
  rows(schema.body, topScope)

  if (census && !halted) {
    for (const key of Object.keys(node.dynamic ?? {})) {
      if (!readState.has(key)) report('elab.dynamic.unknownState', `unknown stored dynamic state '${key}'`, key)
    }
  }

  const additionalType = schema.additionalInputs
  // A box or a state of the top scope owns its id and the ids under it.
  const reserved = scopeRowsOf(schema.body)
    .filter((row) => row.kind === 'group' || row.kind === 'choice' || row.kind === 'typeChoice' || row.kind === 'described' || row.kind === 'state')
    .map((row) => (row as { id: string }).id)
  for (const id of node.additionalInputs ?? []) {
    if (halted) break
    if (additionalType === undefined) {
      report('elab.additionalInput.closed', 'This node does not declare additional inputs.', id)
      break
    }
    if (!id || id.includes('\0') || emittedInputs.has(id) || reserved.some((root) => id === root || id.startsWith(`${root}.`))) {
      report('elab.additionalInput.reserved', `Additional input '${id}' conflicts with a declared input or box.`, id)
      continue
    }
    emittedInputs.add(id)
    push({
      kind: 'input', address: { port: id }, apiName: id,
      spec: { kind: 'input', id, type: scopeType(additionalType, id), optional: true },
      origin: { kind: 'static' },
    })
  }

  const project = (type: TypeExpr): TypeExpr => {
    if (type.kind === 'tuple_element') {
      const input = items.find((item) => item.kind === 'input' && item.spec.id === type.input)
      const element = type.element ?? (input?.kind === 'input' ? input.spec.type : undefined)
      const selector = typeof type.index === 'string' ? type.index : undefined
      const spec = selector === undefined ? undefined : scopeRowsOf(schema.body).find((row) => row.kind === 'input' && row.id === selector)
      const index = selector === undefined
        ? type.index
        : Object.hasOwn(node.values, selector) ? node.values[selector] : (spec?.kind === 'input' ? defaultOf(spec) : undefined)
      if (element === undefined || typeof index !== 'number' || !Number.isSafeInteger(index) || (selector !== undefined && linked(selector))) {
        report('elab.tuple.literalIndex', 'Tuple selection requires a stored integer index and a declared tuple input.', selector)
        return type
      }
      return { kind: 'tuple_element', element, index }
    }
    if (type.kind === 'tuple') return { ...type, elements: type.elements.map(project) }
    if (type.kind === 'list' || type.kind === 'asset' || type.kind === 'stream') return { ...type, element: project(type.element) }
    return type
  }
  for (const [index, item] of items.entries()) {
    if (item.kind === 'output') items[index] = { ...item, spec: { ...item.spec, type: project(item.spec.type) } }
  }

  const chunkSafe = schema.chunkSafe
  const covered = chunkSafe?.applies === undefined || Object.entries(chunkSafe.applies).every(([id, keys]) => {
    const key = chosen.get(id)
    return typeof key === 'string' && keys.includes(key)
  })
  if (chunkSafe && !covered) {
    for (const [index, item] of items.entries()) {
      if (item.kind !== 'input' || !chunkSafe.inputs.includes(item.address.port) || !item.spec.acceptsStream) continue
      const { acceptsStream: _, ...spec } = item.spec
      items[index] = { ...item, spec }
    }
  }
  const elaborated: ElaboratedInterface = {
    items,
    submissionValues: [],
    ...(chunkSafe && covered ? { chunkSafe: {
      inputs: chunkSafe.inputs.filter((id) => items.some((item) => item.kind === 'input' && item.apiName === id)),
      outputs: chunkSafe.outputs,
    } } : {}),
    ...(Object.keys(outputMembers).length > 0 ? { outputMembers } : {}),
    ...(Object.keys(choices).length > 0 ? { choices } : {}),
    ...(Object.keys(unstoredChoices).length > 0 ? { unstoredChoices } : {}),
    ...(Object.keys(unstoredMinimums).length > 0 ? { unstoredMinimums } : {}),
    constructs: [...constructs],
    diagnostics,
  }
  return { elaborated, chosen, early }
}

// ---------------------------------------------------------------------------
// Described rows
// ---------------------------------------------------------------------------

export interface DescribedEntry {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly default?: unknown
  /** Widget fields of the entry's kind, such as options or limits. */
  readonly fields: Readonly<Record<string, unknown>>
}

const MAX_DESCRIPTION_BYTES = 1048576

/**
 * The entries of a stored description (`{"entries": [{id, label, kind, ...}]}`),
 * checked as the engine checks them, or the reason it is refused. Nothing
 * stored is no entries.
 */
export function describedEntries(row: DescribedSpec, value: unknown, path: string = row.id): readonly DescribedEntry[] | string {
  let entries: readonly unknown[] = []
  if (value !== undefined) {
    if (typeof value !== 'string') return `described '${path}': the description is a stored value, not a wire`
    if (new TextEncoder().encode(value).length > MAX_DESCRIPTION_BYTES) return `described '${path}': the description exceeds the byte budget`
    let document: unknown
    try { document = JSON.parse(value) } catch { return `described '${path}': the description must be valid JSON` }
    if (document === null || typeof document !== 'object' || Array.isArray(document)) return `described '${path}': the description must be an object with entries`
    const raw = (document as Record<string, unknown>)['entries']
    if (!Array.isArray(raw) || raw.length > 512) return `described '${path}': entries must be a list of at most 512 entries`
    entries = raw
  }
  if (entries.length < row.minEntries || entries.length > row.maxEntries) {
    return `described '${path}' has ${entries.length} entries, outside its bounds`
  }
  const ids = new Set<string>()
  const labels = new Set<string>()
  const result: DescribedEntry[] = []
  for (const raw of entries) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return `described '${path}': entries must be objects`
    const { id, label, kind, default: dflt, ...fields } = raw as Record<string, unknown>
    if (!isRowId(id)) return `described '${path}': entry id ${JSON.stringify(id)} is not a row id`
    if (typeof label !== 'string' || label.trim() === '' || [...label].length > 256 || label.includes('\0')) {
      return `described '${path}': entry ${id} needs a label`
    }
    if (ids.has(id) || labels.has(label)) return `described '${path}': entry ids and labels must be unique`
    ids.add(id)
    labels.add(label)
    const found = typeof kind === 'string' ? row.kinds.find((candidate) => candidate.id === kind) : undefined
    if (found === undefined) return `described '${path}': entry ${id} has unknown kind ${JSON.stringify(kind)}`
    if (row.fixedIds && id !== found.id) return `described '${path}': fixed entry ids equal their kind ids`
    if (found.kind === 'output' && (dflt !== undefined || Object.keys(fields).length > 0)) {
      return `described '${path}': output entry ${id} takes no fields`
    }
    result.push({ id, label, kind: found.id, ...(dflt !== undefined ? { default: dflt } : {}), fields })
  }
  return result
}
