/**
 * Runs a button's declared steps, in the node body or in the node menu.
 *
 * Steps run in order against a staged copy of the document: each step's
 * changes go through the ordinary commands on a scratch store, so a later
 * step reads what an earlier one set. Nothing reaches the session until every
 * step that changes the workflow has finished, including the waits for a
 * call, a lookup, a list, a form or a picker. Then the staged changes are
 * built again against the live document and dispatched as one `batch`: one
 * undo step, replayed by redo without calling anything again. A failing step,
 * a closed list or form, or Cancel drops everything staged.
 *
 * While the press waits, a field the user (or another press) changes keeps
 * that value and is reported; a target that gained a wire is skipped and
 * reported; a member or node that is gone fails the press. Steps that act
 * outside the workflow (Queue, Interrupt, Copy, Download, OpenLink and a
 * Call that downloads) run after the commit and read the committed document;
 * their failure is reported and changes nothing already committed.
 *
 * Pack code never runs here: a Call and a Lookup go to the host, which asks
 * the backend.
 */

import type { CommandDefinition, CommandExecutionContext, CommandInvocation } from '../commands/contract.js'
import { predictAllocatedId } from '../commands/alloc.js'
import { coreCommandRegistry } from '../commands/core-commands.js'
import type { DocumentSession } from '../commands/session.js'
import { DocumentStore } from '../commands/store.js'
import { planOccurrenceLinkCommand } from '../commands/occurrence-link-commands.js'
import { planOccurrenceLinkMutation } from '../commands/occurrence-planner.js'
import { documentNodeResolver } from '../compile/compile.js'
import { buildBypassCandidates, matchBypassInput } from '../compile/bypass.js'
import { innerConstructAddress, matchBoundaryItem, outerConstructAddress } from '../compile/crossing.js'
import { effectiveOccurrenceTopology, occurrenceMemberReferenced, type EffectiveLink } from '../compile/effective-topology.js'
import { occurrenceDynamicView, type ValueOwner } from '../compile/occurrence-view.js'
import type { ControllerMode, GraphDef, Json, NodeData, WorkflowDocument } from '../format/document.js'
import { asNodeId, asPortId, isExactWidgetTapRef, isPortEndpoint, portAddressKey, sameEndpoint, type LinkEndpoint } from '../ids.js'
import { subgraphDefIdOf } from '../invariants.js'
import { buildRerouteIndex, traceEndpoint } from '../reroute.js'
import { boundaryItems, resolveDynamicAddress } from '../format/document.js'
import { Formula, FormulaRefused, UNKNOWN, type FormulaNameKind, type FormulaOutcome, type FormulaValue, type FormulaValues } from '../mirror/formula.js'
import { constructsOf, keyPosition, rowKind } from '../schema/body.js'
import { isComboValue, normalizeComboOption, normalizedComboOptions, type NormalizedComboOption } from '../schema/combo-options.js'
import type { SchemaResolver } from '../schema/derive-boundary.js'
import {
  automaticValueOf,
  buildGraphConnectivity,
  describedEntries,
  elaborateInterface,
  elabInputsOf,
  elabOutputsOf,
  EMPTY_CONNECTIVITY,
  valueKeyOf,
  type Connectivity,
  type ElaboratedInput,
  type ElaboratedInterface,
  type FormulaContext,
  type MaterializeFrame,
} from '../schema/elaborate.js'
import type { ButtonSpec, DescribedSpec, GroupSpec, InputSpec, NodeSchema, OptionRow } from '../schema/model.js'
import { canonicalTypeIdOf, typeExprFromTypeId } from '../schema/model.js'
import { integerWidgetValue, numericStepConstraints } from '../schema/numeric-step.js'
import { solveGraphTypes } from '../schema/solve.js'
import { typesCompatible } from '../schema/type-relations.js'
import { effectiveWidgetDefault, readWhenUnset } from '../schema/widget-defaults.js'
import { decodeSteps, isOutsideStep, type Argument, type Step, type StepValue } from './steps.js'

// ---------------------------------------------------------------------------
// The host

/** A value a lookup or a call takes: whole numbers are bigints, decimals are numbers. */
export type CallArg = bigint | number | boolean | string | null | readonly CallArg[] | { readonly [key: string]: Json }

/** One lookup a press needs, for the lookup service of issue 1228. */
export interface LookupRequest {
  readonly nodeType: string
  /** The node's occurrence path. */
  readonly node: string
  readonly function: string
  readonly args: readonly CallArg[]
  /** `options` for a Pick's list; `value` for a value a step stores. */
  readonly use: 'options' | 'value'
  /** A press draws on its own budget, apart from the lookups fields ask while the user edits. */
  readonly asker: 'press'
}

/**
 * For `value`, the lookup service asks again once when its answer is missing
 * or stale, so `stale` never comes back. A Pick's list may be stale and is
 * still offered, as a field's list is.
 */
export type LookupResult =
  | { readonly state: 'ready'; readonly value: unknown }
  | { readonly state: 'stale'; readonly value: unknown }
  | { readonly state: 'failed'; readonly reason: string }
  | { readonly state: 'paused' }

export interface CallRequest {
  readonly nodeType: string
  readonly function: string
  readonly args: readonly CallArg[]
  readonly writes?: readonly string[]
  readonly download?: string
}

/** A call's answer. Whole numbers are bigints and decimals numbers, as the formula reads them. */
export type CallAnswer =
  | { readonly kind: 'answer'; readonly fields: Readonly<Record<string, unknown>>; readonly notes: readonly string[] }
  | { readonly kind: 'file'; readonly bytes: Uint8Array; readonly notes: readonly string[] }
  | { readonly kind: 'failed'; readonly message: string }

/** What a Pick shows: the list of a field, in the state its lookup is in. */
export interface PickRequest {
  readonly target: StepPlace
  readonly options: readonly NormalizedComboOption[]
  readonly state: 'ready' | 'stale' | 'failed' | 'paused'
  /** The lookup the list came from, for the list's Try again. */
  readonly lookup?: LookupRequest
}

export interface AskRequest {
  readonly target: StepPlace
  readonly title: string
  readonly rows: readonly InputSpec[]
}

/**
 * Everything a press needs from the editor around it. Each wait takes the
 * press's signal and rejects when it is aborted; any other rejection is a
 * failure whose message the user reads.
 */
export interface ActionHost {
  readonly commands: ReadonlyMap<string, CommandDefinition>
  readonly schemaResolverFor?: (doc: WorkflowDocument) => SchemaResolver
  /** The schema of a node of `graphId` as the canvas resolves it; also asked for a node AddNode creates. */
  schemaOf(doc: WorkflowDocument, graphId: string, node: NodeData): NodeSchema | undefined
  /** A renderer host places additions using its measured node and wire geometry. */
  positionAddedNode?(doc: WorkflowDocument, target: StepPlace, node: NodeData, to: string, source?: LinkEndpoint): { readonly x: number; readonly y: number }
  lookup(request: LookupRequest, signal: AbortSignal): Promise<LookupResult>
  call(request: CallRequest, progress: (fraction: number, text: string) => void, signal: AbortSignal): Promise<CallAnswer>
  /** The chosen option's value, or undefined when the list closed. */
  pick(request: PickRequest, signal: AbortSignal): Promise<string | number | boolean | undefined>
  /** The applied rows by id, or undefined on Cancel. */
  ask(request: AskRequest, signal: AbortSignal): Promise<Readonly<Record<string, Json>> | undefined>
  /** The chosen asset value, or undefined when the picker closed. */
  openPicker(field: ElaboratedInput, signal: AbortSignal): Promise<Json | undefined>
  /** The field's host editor, or undefined when it has none yet. */
  editorFor(field: ElaboratedInput): ((signal: AbortSignal, initial: Json | undefined) => Promise<Json | undefined>) | undefined
  pasteImage(field: ElaboratedInput, signal: AbortSignal): Promise<Json>
  copy(text: string): Promise<void>
  /** Saves a file; 'closed' when the user closed a Save As dialog without saving. */
  download(filename: string, content: string | Uint8Array): Promise<'saved' | 'closed'>
  queue(toHere: { readonly graphId: string; readonly nodeId: string } | undefined): Promise<void>
  interrupt(): Promise<void>
  /** Opens a new tab; `confirm` asks the user first, showing the address, until `signal` cancels. */
  openLink(url: string, confirm: boolean, signal: AbortSignal): Promise<void>
  /** A number in [0, 1); redo never draws again. */
  random(): number
}

/** The node a list of steps runs on. */
export interface StepPlace {
  readonly graphId: string
  readonly nodeId: string
  readonly instancePath?: readonly string[]
  /** The node's occurrence path for the lookup service; the node id by default. */
  readonly occurrence?: string
}

export interface PressTarget extends StepPlace {
  /** The button's flattened id, or a menu button's id. */
  readonly button: string
  readonly menu?: boolean
}

/** Steps to run on a node, with names resolved in the scope `prefix` names ('' for the node's own fields). */
export interface StepPart extends StepPlace {
  readonly prefix: string
  readonly steps: readonly Step[]
}

export interface PressProgress {
  /** Words for the button while it works; the host adds the three dots. */
  readonly text: string
  readonly fraction?: number
}

export interface PressOptions {
  readonly signal?: AbortSignal
  /** Called while the press waits on a call or a lookup; undefined while it waits on the user. */
  readonly onProgress?: (progress: PressProgress | undefined) => void
  /** False once the document the press started on was closed or replaced. */
  readonly stillCurrent?: () => boolean
  /** Checked when the run starts and again just before it stores; false fails the run with `staleMessage`. */
  readonly unchanged?: (doc: WorkflowDocument) => boolean
  /** A field the user changed while the run waited fails the run with `staleMessage`, instead of keeping the user's value. */
  readonly strict?: boolean
  readonly staleMessage?: string
  /** Two parts that set one field to different values fail the run with this message. */
  readonly conflictMessage?: string
  /** Refuse, before anything is staged, steps that ask the user or act outside the workflow. */
  readonly insideOnly?: boolean
  /** As `insideOnly`, and also refuse a step that waits on a pack function or a lookup. */
  readonly noWait?: boolean
  /** Commands staged first and stored with the run as its one undo step, such as the user's own edit that led to it. */
  readonly lead?: readonly CommandInvocation[]
}

export interface PressOutcome {
  readonly kind: 'done' | 'failed' | 'cancelled'
  /** The result box's words; absent when every step did its work. */
  readonly message?: string
  /** The box is a warning: the press failed, or an outside step did. */
  readonly warning?: true
  /** Fields and members the press left as they were, and why. */
  readonly skipped: readonly Skip[]
  readonly notes: readonly string[]
}

/** A field or member a press left as it was: it has a wire, or it changed while the press waited. */
export interface Skip {
  readonly id: string
  readonly why: 'wired' | 'edited' | 'outside'
}

export type ButtonAvailability = { readonly enabled: true } | { readonly enabled: false; readonly reason: string }

export const PAUSED_MESSAGE = 'Paused. Try again in a moment.'
export const LOOKUP_FAILED_MESSAGE = 'The pack could not provide this value.'
export const EXTRA_KEY_MESSAGE = 'The pack answered something this button may not set.'
export const NO_EDITOR_MESSAGE = 'This editor is not available yet.'
export const ALL_WIRED_MESSAGE = 'Every field this would set has a wire.'
export const STALE_MESSAGE = 'The workflow changed while the steps waited.'
export const CONFLICT_MESSAGE = 'Two of these set the same field to different values.'
export const INSIDE_ONLY_MESSAGE = 'These steps ask the user or act outside the workflow, so they cannot run here.'
export const NO_WAIT_MESSAGE = 'These steps wait on a pack or a lookup, so they cannot run here.'

// ---------------------------------------------------------------------------
// Values

/** A value as steps handle it: whole numbers are bigints and decimals numbers. */
type Value = FormulaValue

/** `own` marks a message the caller passed, which the outcome shows as it is. */
class Refusal extends Error {
  constructor(message: string, readonly own = false) { super(message) }
}
const refuse = (message: string, own = false): never => {
  throw new Refusal(message, own)
}

class Cancelled extends Error {}

class AutomaticNeeded extends Error {
  constructor(readonly field: ElaboratedInput) { super() }
}

/** A literal from the wire: a whole number is an int, `{"float": n}` a decimal. */
function literalOf(raw: unknown): Value {
  if (typeof raw === 'number') return Number.isInteger(raw) ? BigInt(raw) : raw
  if (Array.isArray(raw)) return raw.map((item) => literalOf(item) as Exclude<Value, readonly unknown[]>)
  if (typeof raw === 'object' && raw !== null && typeof (raw as Record<string, unknown>)['float'] === 'number') {
    return (raw as Record<string, number>)['float']!
  }
  if (raw === null || typeof raw === 'boolean' || typeof raw === 'string' || typeof raw === 'bigint') return raw
  return refuse('A step holds a value the editor cannot store.')
}

function display(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(display).join(', ')
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return String(value)
}

/** A local of a Pick or an Ask as a formula reads it. */
function localOf(raw: unknown, kind: FormulaNameKind): Value {
  if (kind.endsWith('[]') && Array.isArray(raw)) return raw.map((item) => {
    const value = localOf(item, kind.slice(0, -2) as FormulaNameKind)
    if (Array.isArray(value)) return refuse('The form gave a value the button cannot use.')
    return value as Exclude<Value, readonly unknown[]>
  })
  if (kind === 'int' && typeof raw === 'number' && Number.isSafeInteger(raw)) return BigInt(raw)
  if (kind === 'int' && typeof raw === 'string' && /^-?[0-9]+$/.test(raw)) return BigInt(raw)
  if (typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean' || raw === null) return raw
  return refuse('The form gave a value the button cannot use.')
}

const kindOfValue = (value: unknown): FormulaNameKind =>
  typeof value === 'bigint' ? 'int' : typeof value === 'number' ? 'float' : typeof value === 'boolean' ? 'bool' : 'text'

/** The stored value of `value` in `field`, or why it does not fit. Invalid values fail; nothing is clamped. */
export function fieldValue(field: ElaboratedInput, value: unknown, name: string): Json {
  const widget = field.spec.widget
  if (widget === undefined) return refuse(`${name} has no field a button can set.`)
  switch (widget.widgetType) {
    case 'INT': {
      if (typeof value !== 'bigint') return refuse(`${name} takes a whole number; the button gave ${display(value)}.`)
      const limits = numericStepConstraints(widget)
      if (!limits.integer) return refuse(`${name} takes a whole number.`)
      if (limits.special.includes(value)) return integerWidgetValue(value)
      if (limits.min !== undefined && value < limits.min) return refuse(`${name} must be at least ${limits.min}; the button gave ${value}.`)
      if (limits.max !== undefined && value > limits.max) return refuse(`${name} must be at most ${limits.max}; the button gave ${value}.`)
      if (limits.offset !== undefined && (value - limits.offset) % limits.step !== 0n) {
        return refuse(`${name} moves in steps of ${limits.step}; the button gave ${value}.`)
      }
      return integerWidgetValue(value)
    }
    case 'FLOAT': {
      const number = typeof value === 'bigint' ? Number(value) : value
      if (typeof number !== 'number' || !Number.isFinite(number)) return refuse(`${name} takes a number; the button gave ${display(value)}.`)
      const limits = numericStepConstraints(widget)
      if (limits.integer) return refuse(`${name} takes a whole number.`)
      if (limits.special.includes(number)) return number
      if (number < limits.min) return refuse(`${name} must be at least ${limits.min}; the button gave ${number}.`)
      if (number > limits.max) return refuse(`${name} must be at most ${limits.max}; the button gave ${number}.`)
      return number
    }
    case 'BOOLEAN':
      if (typeof value !== 'boolean') return refuse(`${name} takes yes or no; the button gave ${display(value)}.`)
      return value
    case 'STRING':
    case 'MARKDOWN':
    case 'COLOR':
      if (typeof value !== 'string') return refuse(`${name} takes text; the button gave ${display(value)}.`)
      return value
    case 'COMBO': {
      const choice = typeof value === 'bigint' ? Number(value) : value
      if (!isComboValue(choice)) return refuse(`${name} takes one of its options; the button gave ${display(value)}.`)
      // Options written in the declaration are fixed; a list from a lookup or the backend is only help.
      const fixed = widget.remote === undefined && widget.editableOptions !== true ? normalizedComboOptions(widget) : []
      if (fixed.length > 0 && !fixed.some((option) => option.value === choice)) {
        return refuse(`${display(value)} is not one of the options of ${name}.`)
      }
      return choice
    }
    case 'MULTI_COMBO': {
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return refuse(`${name} takes a list of options.`)
      const fixed = widget.remote === undefined ? normalizedComboOptions(widget) : []
      const outside = fixed.length > 0 ? value.find((item) => !fixed.some((option) => option.value === item)) : undefined
      if (outside !== undefined) return refuse(`${outside} is not one of the options of ${name}.`)
      return value as string[]
    }
    default:
      return refuse(`${name} is a field a button cannot set.`)
  }
}

/** Reset removes an automatic override; other fields keep an explicit current default. */
function defaultValueOf(field: ElaboratedInput, name: string): Json | undefined {
  if (field.spec.automatic !== undefined) return undefined
  const widget = field.spec.widget
  const value = widget === undefined ? undefined : effectiveWidgetDefault(widget)
  if (value === undefined) return refuse(`${name} has no default to reset to.`)
  return value
}

// ---------------------------------------------------------------------------
// Looking at a node

interface View {
  readonly doc: WorkflowDocument
  readonly graph: GraphDef
  readonly node: NodeData
  readonly schema: NodeSchema
  readonly elaborated: ElaboratedInterface
  readonly contexts: ReadonlyMap<string, FormulaContext>
  readonly connectivity: Connectivity
  readonly valueOwners: ReadonlyMap<string, ValueOwner>
  readonly incomingValue: (path: string, onRead?: (place: StepPlace, path: string) => void) => Json | undefined
  readonly incomingType: (path: string, onRead?: (place: StepPlace, path: string) => void) => string | undefined
}

function viewOf(doc: WorkflowDocument, target: StepPlace, host: ActionHost, reading = new Set<string>()): View | undefined {
  const graph = doc.graphs[target.graphId]
  const stored = graph?.nodes[target.nodeId]
  const path = target.instancePath ?? []
  if (path.length > 0 && host.schemaResolverFor === undefined) return undefined
  const resolve = host.schemaResolverFor?.(doc) ?? (() => undefined)
  let body = doc.graphs[doc.root]
  for (const hop of path) {
    const instance = body?.nodes[hop]
    const child = instance && subgraphDefIdOf(instance.type)
    body = child === undefined ? undefined : doc.graphs[child]
  }
  if (path.length > 0 && body?.id !== target.graphId) return undefined
  const occurrence = path.length > 0 ? occurrenceDynamicView(doc, resolve, path) : undefined
  const node = stored && {
    ...stored,
    values: occurrence?.values.get(stored.id) ?? stored.values,
    ...(occurrence?.dynamic.get(stored.id) === undefined ? {} : { dynamic: occurrence.dynamic.get(stored.id)! }),
    ...(occurrence?.controllers.get(stored.id) === undefined ? {} : { controllers: occurrence.controllers.get(stored.id)! }),
  }
  const schema = node && host.schemaOf(doc, target.graphId, node)
  if (graph === undefined || node === undefined || schema === undefined) return undefined
  const base = buildGraphConnectivity(graph)(node.id)
  const topology = path.length === 0 ? undefined : effectiveOccurrenceTopology(doc, resolve, {
    instancePath: path.slice(0, -1).map(asNodeId), node: asNodeId(path.at(-1)!),
  })
  const inputs = new Set<string>()
  const outputs = new Set<string>()
  for (const link of [...(topology?.links ?? []), ...(topology?.projectedParentLinks ?? [])]) {
    for (const [end, ports] of [[link.to, inputs], [link.from, outputs]] as const) {
      if (end.graphId !== graph.id || JSON.stringify(end.instancePath) !== JSON.stringify(path)) continue
      if (isPortEndpoint(end.endpoint) && end.endpoint.node === node.id) ports.add(end.endpoint.port)
      if (ports === outputs && isExactWidgetTapRef(end.endpoint) && end.endpoint.node === node.id) ports.add(end.endpoint.tap)
    }
  }
  const connectivity: Connectivity = topology === undefined ? base : {
    isInputConnected: (port) => [...inputs].some((input) => portAddressKey(input) === portAddressKey(port)),
    isOutputConnected: (port) => outputs.has(port),
    inputPorts: () => [...inputs], outputPorts: () => [...outputs],
  }
  const incoming = (port: string, mode: 'value' | 'type', onRead?: (place: StepPlace, path: string) => void): Json | undefined => {
    const key = JSON.stringify([mode, target.graphId, path, target.nodeId, port])
    if (reading.has(key)) return undefined
    reading.add(key)
    try {
      const link = topology && [...topology.links, ...topology.projectedParentLinks].find((link) =>
        link.to.graphId === graph.id && JSON.stringify(link.to.instancePath) === JSON.stringify(path) &&
        isPortEndpoint(link.to.endpoint) && link.to.endpoint.node === node.id &&
        portAddressKey(link.to.endpoint.port) === portAddressKey(port))
      if (link !== undefined) return endpointRead(link.from.graphId, link.from.instancePath, link.from.endpoint, mode, onRead)
      if (topology !== undefined) return undefined
      const driver = definitionDriverOf(graph, node.id, port)
      return driver && endpointRead(graph.id, path, driver.from, mode, onRead)
    } finally {
      reading.delete(key)
    }
  }
  const incomingValue: View['incomingValue'] = (port, onRead) => incoming(port, 'value', onRead)
  const incomingType: View['incomingType'] = (port, onRead) => {
    const type = incoming(port, 'type', onRead)
    return typeof type === 'string' ? type : undefined
  }
  const resolvedType = (source: View, side: 'input' | 'output', port: string, onRead?: (place: StepPlace, path: string) => void): string | undefined => {
    const field = side === 'input' ? inputAt(source, port) : elabOutputsOf(source.elaborated).find((output) => portAddressKey(output.address.port) === portAddressKey(port))
    if (field === undefined) return undefined
    const declared = canonicalTypeIdOf(field.spec.type)
    if (declared !== undefined) return declared
    const projectedInputs = elabInputsOf(source.elaborated).flatMap((input) => {
      const type = source.incomingType(valueKeyOf(input), onRead)
      return type === undefined ? [] : [{ type: typeExprFromTypeId(type), to: { node: source.node.id, port: asPortId(input.address.port) } }]
    })
    const graph = { ...source.graph, nodes: { [source.node.id]: source.node }, links: {}, nets: {}, reroutes: {} }
    const solved = solveGraphTypes(graph, () => source.schema, { connectivityOf: () => source.connectivity, projectedInputs })
    const type = solved.portTypeOf(source.node.id, side, port)
    return type === undefined ? undefined : canonicalTypeIdOf(type)
  }
  const endpointRead = (graphId: string, instancePath: readonly string[], endpoint: LinkEndpoint, mode: 'value' | 'type', onRead?: (place: StepPlace, path: string) => void): Json | undefined => {
    const sourceGraph = doc.graphs[graphId]
    if (sourceGraph === undefined) return undefined
    if (!isPortEndpoint(endpoint) && !isExactWidgetTapRef(endpoint)) {
      if (instancePath.length > 0) {
        const key = JSON.stringify([mode, graphId, instancePath, endpoint])
        if (reading.has(key)) return undefined
        reading.add(key)
        try {
          const topology = effectiveOccurrenceTopology(doc, resolve, {
            instancePath: instancePath.slice(0, -1).map(asNodeId), node: asNodeId(instancePath.at(-1)!),
          })
          const driver = [...topology.links, ...topology.projectedParentLinks].find((link) =>
            link.to.graphId === graphId && JSON.stringify(link.to.instancePath) === JSON.stringify(instancePath) && sameEndpoint(link.to.endpoint, endpoint))
          return driver && endpointRead(driver.from.graphId, driver.from.instancePath, driver.from.endpoint, mode, onRead)
        } finally {
          reading.delete(key)
        }
      }
      const trace = traceEndpoint(sourceGraph, endpoint, buildRerouteIndex(sourceGraph))
      if (trace.kind === 'output') return endpointRead(graphId, instancePath, trace.ref, mode, onRead)
      if (trace.kind === 'tapValue') return endpointRead(graphId, instancePath, { node: trace.node, tap: trace.input }, mode, onRead)
      return undefined
    }
    const sourceNode = sourceGraph.nodes[endpoint.node]
    if (sourceNode === undefined || sourceNode.mode === 'muted') return undefined
    const source = viewOf(doc, { graphId, nodeId: sourceNode.id, instancePath }, host, reading)
    if (source === undefined) return undefined
    let input: string | undefined
    if (isExactWidgetTapRef(endpoint)) input = endpoint.tap
    else {
      const child = subgraphDefIdOf(sourceNode.type)
      if (child !== undefined && sourceNode.mode !== 'bypassed') {
        const def = doc.graphs[child]
        const match = matchBoundaryItem(boundaryItems(def?.boundary, 'outputs'), endpoint)
        if (!def || !match.ok || match.item.binds.kind === 'unbound') return undefined
        const binding = match.item.binds
        const port = binding.kind === 'construct'
          ? innerConstructAddress(def, binding, match.item.id, endpoint.port, (node) => host.schemaOf(doc, child, node)) : undefined
        return endpointRead(child, [...instancePath, sourceNode.id], binding.kind === 'widgetTap'
          ? { node: binding.node, tap: binding.tap }
          : { node: binding.node, port: asPortId(port ?? binding.port) }, mode, onRead)
      }
      const outputs = elabOutputsOf(source.elaborated).filter((output) => output.wireable !== false)
      const index = outputs.findIndex((output) => portAddressKey(output.address.port) === portAddressKey(endpoint.port))
      const output = outputs[index]
      if (output === undefined) return undefined
      if (mode === 'type' && sourceNode.mode !== 'bypassed') {
        onRead?.({ graphId, nodeId: sourceNode.id, instancePath }, output.address.port)
        return resolvedType(source, 'output', output.address.port, onRead)
      }
      if (sourceNode.mode === 'bypassed') {
        input = matchBypassInput({ index, type: output.spec.type }, buildBypassCandidates(elabInputsOf(source.elaborated), (field) =>
          source.connectivity.isInputConnected(valueKeyOf(field)) ? valueKeyOf(field) : undefined))?.driver
      } else input = output.spec.knownValue?.input
    }
    if (input === undefined) return undefined
    const field = inputAt(source, input)
    if (field === undefined) return undefined
    const valueKey = valueKeyOf(field)
    onRead?.({ graphId, nodeId: sourceNode.id, instancePath }, valueKey)
    if (mode === 'type') return source.connectivity.isInputConnected(valueKey) ? source.incomingType(valueKey, onRead) : resolvedType(source, 'input', field.address.port, onRead)
    if (source.connectivity.isInputConnected(valueKey)) return source.incomingValue(valueKey, onRead)
    if (field.derivedValue !== undefined) return field.derivedValue
    if (Object.hasOwn(source.node.values, valueKey)) return source.node.values[valueKey]
    return field.automatic?.value ?? (readWhenUnset(field.spec) as Json | undefined)
  }
  const contexts = new Map<string, FormulaContext>()
  const elaborated = elaborateInterface(schema, node, connectivity, { nodeId: node.id, formulaContexts: contexts, incomingValue, incomingType })
  return { doc, graph, node, schema, elaborated, contexts, connectivity, incomingValue, incomingType, valueOwners: occurrence?.valueOwners.get(node.id) ?? new Map() }
}

/** The declaration and scope prefix of the pressed button. */
function buttonOf(view: View, target: PressTarget): { readonly spec: ButtonSpec; readonly prefix: string } | undefined {
  if (target.menu === true) {
    const spec = view.schema.menu?.find((button) => button.id === target.button)
    return spec === undefined ? undefined : { spec, prefix: '' }
  }
  const item = view.elaborated.items.find((candidate) => candidate.kind === 'button' && candidate.id === target.button)
  if (item?.kind !== 'button') return undefined
  const dot = item.id.lastIndexOf('.')
  return { spec: item.spec, prefix: dot < 0 ? '' : item.id.slice(0, dot + 1) }
}

const inputAt = (view: View, path: string): ElaboratedInput | undefined =>
  elabInputsOf(view.elaborated).find((input) => valueKeyOf(input) === path)

/** Route construct state and member addresses through the same boundary mapping as values. */
function constructOwnerOf(doc: WorkflowDocument, target: StepPlace, address: string, host: ActionHost): ValueOwner {
  const resolveNode = documentNodeResolver(doc, host.schemaResolverFor?.(doc) ?? (() => undefined))
  const parents: { graph: GraphDef; instance: NodeData; child: GraphDef }[] = []
  let graph = doc.graphs[doc.root]
  for (const hop of target.instancePath ?? []) {
    const instance = graph?.nodes[hop]
    const childId = instance && subgraphDefIdOf(instance.type)
    const child = childId === undefined ? undefined : doc.graphs[childId]
    if (!graph || !instance || !child) return refuse('The node is gone.')
    parents.push({ graph, instance, child })
    graph = child
  }
  let owner: ValueOwner = { graphId: target.graphId, nodeId: target.nodeId, valueKey: address }
  for (const parent of parents.reverse()) {
    let mapped: string | undefined
    for (const item of [...boundaryItems(parent.child.boundary, 'inputs'), ...boundaryItems(parent.child.boundary, 'outputs')]) {
      for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
        if (binding.kind !== 'construct' || binding.node !== owner.nodeId) continue
        mapped = outerConstructAddress(parent.child, binding, item.id, owner.valueKey, (node) => resolveNode(parent.child.id, node))
        if (mapped !== undefined) break
      }
      if (mapped !== undefined) break
    }
    if (mapped === undefined) break
    owner = { graphId: parent.graph.id, nodeId: parent.instance.id, valueKey: mapped }
  }
  return owner
}

/** The Described row stored at `path`, through layout boxes and the options of choices. */
function describedAt(rows: readonly OptionRow[], path: string, prefix = ''): DescribedSpec | undefined {
  for (const row of rows) {
    let found: DescribedSpec | undefined
    if (row.kind === 'described' && prefix + row.id === path) return row
    if (row.kind === 'section' || row.kind === 'row') found = describedAt(row.rows, path, prefix)
    if (row.kind === 'choice') {
      found = describedAt([...row.shared, ...row.options.flatMap((option) => option.rows)], path, `${prefix}${row.id}.`)
    }
    if (found !== undefined) return found
  }
  return undefined
}

/** Whether anything is wired to a port of `member`. */
function memberWired(view: View, group: string, member: string): boolean {
  const { graph } = view
  const under = (port: string): boolean => port === `${group}.${member}` || port.startsWith(`${group}.${member}.`)
  const ends = [
    ...Object.values(graph.links).flatMap((link) => [link.from, link.to]),
    ...Object.values(graph.nets).flatMap((net) => [net.source, ...net.sinks]),
    ...[...boundaryItems(graph.boundary, 'inputs'), ...boundaryItems(graph.boundary, 'outputs')].flatMap((item) => [item.binds, ...(item.alsoBinds ?? [])]),
  ]
  // A wire leaving a member field's output is a widget tap named by the field's flattened id.
  return ends.some((end) => 'node' in end && end.node === view.node.id &&
    (('port' in end && end.port !== undefined && under(String(end.port))) || ('tap' in end && end.tap !== undefined && under(String(end.tap))))) ||
    occurrenceMemberReferenced(view.doc, graph.id, view.node.id, group, member)
}

function definitionDriverOf(graph: GraphDef, node: string, port: string): { readonly id?: string; readonly from: LinkEndpoint } | undefined {
  const link = Object.values(graph.links).find((link) => isPortEndpoint(link.to) && link.to.node === node && link.to.port === port)
  if (link !== undefined) return link
  const net = Object.values(graph.nets).find((net) => net.sinks.some((sink) => sink.node === node && sink.port === port))
  return net === undefined ? undefined : { from: net.source }
}

function occurrenceDriverOf(doc: WorkflowDocument, target: StepPlace, port: string, host: ActionHost): { readonly chain: readonly EffectiveLink[]; readonly outside: boolean } {
  const path = target.instancePath ?? []
  if (path.length === 0) return { chain: [], outside: false }
  const topology = effectiveOccurrenceTopology(doc, host.schemaResolverFor!(doc), {
    instancePath: path.slice(0, -1).map(asNodeId), node: asNodeId(path.at(-1)!),
  })
  const links = [...topology.links, ...topology.projectedParentLinks]
  let upstream = links.find((link) =>
    link.to.graphId === target.graphId && JSON.stringify(link.to.instancePath) === JSON.stringify(path) &&
    isPortEndpoint(link.to.endpoint) && link.to.endpoint.node === target.nodeId &&
    portAddressKey(link.to.endpoint.port) === portAddressKey(port))
  const chain: EffectiveLink[] = []
  while (upstream !== undefined && !chain.includes(upstream)) {
    chain.push(upstream)
    if ((upstream.identity.kind !== 'definition' && upstream.identity.kind !== 'definitionNetSink') || upstream.from.graphId !== target.graphId ||
      JSON.stringify(upstream.from.instancePath) !== JSON.stringify(path)) return { chain, outside: true }
    const endpoint = upstream.from.endpoint
    if (isPortEndpoint(endpoint)) break
    const input = isExactWidgetTapRef(endpoint) ? { node: endpoint.node, port: endpoint.tap } : endpoint
    upstream = links.find((link) => link.to.graphId === target.graphId &&
      JSON.stringify(link.to.instancePath) === JSON.stringify(path) && sameEndpoint(link.to.endpoint, input))
  }
  return { chain, outside: false }
}

// ---------------------------------------------------------------------------
// What a press stages

type Action =
  | {
      readonly kind: 'read'
      readonly target?: StepPlace
      readonly path: string
      readonly field: boolean
      readonly group: boolean
      readonly members: readonly { readonly construct: string; readonly member: string }[]
      readonly choices: readonly { readonly construct: string; readonly selected: string | undefined }[]
    }
  | { readonly kind: 'value'; readonly path: string; readonly value: Json | undefined }
  | { readonly kind: 'mode'; readonly path: string; readonly mode: ControllerMode }
  | {
      readonly kind: 'materialize'
      readonly frames: readonly MaterializeFrame[]
      /** The member an AddMember step adds, which must still be new at the commit. */
      readonly adds?: { readonly group: string; readonly member: string }
    }
  | { readonly kind: 'removeMember'; readonly group: string; readonly member: string }
  | { readonly kind: 'disconnect'; readonly path: string; readonly delivery?: string }
  | {
      readonly kind: 'addNode'
      readonly type: string
      readonly values: Readonly<Record<string, Json>>
      readonly position: { readonly x: number; readonly y: number }
      readonly output: string
      readonly to: string
      /** Insert between: the old source of `to` and the new node's input it now feeds. */
      readonly between?: { readonly from: LinkEndpoint; readonly input: string }
      /** What fed `to` when the step ran; a different source at the commit skips the step. */
      readonly source?: LinkEndpoint
      readonly delivery?: string
    }

function invocationsOf(action: Action, doc: WorkflowDocument, target: StepPlace, actor: string | undefined, host: ActionHost): CommandInvocation[] {
  const owner = action.kind === 'value' || action.kind === 'mode'
    ? (viewOf(doc, target, host) ?? refuse('The node is gone.')).valueOwners.get(action.path) : undefined
  const { graphId, nodeId } = owner ?? target
  const path = owner?.valueKey ?? (action.kind === 'value' || action.kind === 'mode' ? action.path : '')
  switch (action.kind) {
    case 'read':
      return []
    case 'value':
      return [action.value === undefined
        ? { command: 'node.setValues', params: { graphId, nodeId, values: {}, unset: [path] } }
        : { command: 'node.setValue', params: { graphId, nodeId, inputId: path, value: action.value } }]
    case 'mode':
      return [{ command: 'node.setController', params: { graphId, nodeId, inputId: path, mode: action.mode } }]
    case 'materialize': {
      const staged = scratchOf(doc, host)
      return action.frames.map((frame) => {
        const current = staged.doc
        const into = constructOwnerOf(current, target, frame.construct, host)
        const members = frame.members.map((member) => {
          const mapped = constructOwnerOf(current, target, `${frame.construct}.${member}`, host)
          if (mapped.graphId !== into.graphId || mapped.nodeId !== into.nodeId || !mapped.valueKey.startsWith(`${into.valueKey}.`)) return refuse('The group changed while the button waited.')
          return mapped.valueKey.slice(into.valueKey.length + 1)
        })
        const node = current.graphs[into.graphId]!.nodes[into.nodeId]!
        const schema = documentNodeResolver(current, host.schemaResolverFor?.(current) ?? (() => undefined))(into.graphId, node)
        const group = schema && constructsOf(schema, node.dynamic).get(into.valueKey)
        const seq = frame.seq === undefined ? undefined : group?.kind === 'group'
          ? Math.max(...members.map((member) => (keyPosition(group.keys, member) ?? -1) + 1)) : refuse('The group is gone.')
        const invocation = { command: 'dynamic.materialize', params: { graphId: into.graphId, nodeId: into.nodeId, frames: [{ construct: into.valueKey, members, ...(seq === undefined ? {} : { seq }) }] } }
        dispatchOn(staged, [invocation], actor)
        return invocation
      })
    }
    case 'removeMember': {
      const into = constructOwnerOf(doc, target, `${action.group}.${action.member}`, host)
      const dot = into.valueKey.lastIndexOf('.')
      return [{ command: 'dynamic.removeMember', params: { graphId: into.graphId, nodeId: into.nodeId, construct: into.valueKey.slice(0, dot), member: into.valueKey.slice(dot + 1) } }]
    }
    case 'disconnect': {
      const path = target.instancePath ?? []
      if (path.length > 0) {
        const owner = { instancePath: path.slice(0, -1).map(asNodeId), node: asNodeId(path.at(-1)!) }
        const resolve = host.schemaResolverFor!(doc)
        const topology = effectiveOccurrenceTopology(doc, resolve, owner)
        return [...topology.links, ...topology.projectedParentLinks].filter((link) =>
          link.to.graphId === graphId && JSON.stringify(link.to.instancePath) === JSON.stringify(path) &&
          isPortEndpoint(link.to.endpoint) && link.to.endpoint.node === nodeId && portAddressKey(link.to.endpoint.port) === portAddressKey(action.path),
        ).map((link) => planOccurrenceLinkCommand(doc, resolve, { command: 'occurrence.link.disconnect', owner, bodyGraph: graphId, link: link.identity })?.invocation
          ?? refuse('The wire changed while the button waited.'))
      }
      const graph = doc.graphs[graphId]!
      const to = { node: nodeId, port: action.path }
      const links = Object.values(graph.links).filter((link) => 'port' in link.to && link.to.node === nodeId && link.to.port === action.path)
      const nets = Object.values(graph.nets).some((net) => net.sinks.some((sink) => sink.node === nodeId && sink.port === action.path))
      return [
        ...links.map((link) => ({ command: 'link.disconnect', params: { graphId, linkId: link.id } })),
        ...(nets ? [{ command: 'net.disconnectInput', params: { graphId, to } }] : []),
      ]
    }
    case 'addNode': {
      const id = predictAllocatedId(doc.graphs[graphId]!, actor, 'n')
      const position = host.positionAddedNode?.(doc, target, { id: asNodeId(id), type: action.type, values: action.values }, action.to, action.source) ?? action.position
      const add: CommandInvocation = { command: 'node.add', params: { graphId, type: action.type, position, values: action.values } }
      const driver = definitionDriverOf(doc.graphs[graphId]!, nodeId, action.to)
      return [
        add,
        ...(action.between === undefined ? [] : [{
          command: driver?.id === undefined ? 'link.connect' : 'link.rewire',
          params: { graphId, ...(driver?.id === undefined ? { from: action.between.from as unknown as Json } : { linkId: driver.id }), to: { node: id, port: action.between.input } },
        }]),
        { command: 'link.connect', params: { graphId, from: { node: id, port: action.output }, to: { node: nodeId, port: action.to } } },
      ]
    }
  }
}

const batch = (invocations: readonly CommandInvocation[]): CommandInvocation =>
  ({ command: 'batch', params: { invocations: invocations as unknown as Json } })

function scratchOf(doc: WorkflowDocument, host: ActionHost): DocumentStore {
  const context = (): CommandExecutionContext =>
    ({ kind: 'initial', ...(host.schemaResolverFor ? { schemaResolverFor: host.schemaResolverFor } : {}) })
  return new DocumentStore(doc, host.commands, 1, () => {}, context)
}

/** Dispatch `invocations` on a scratch store; a refusal names the first diagnostic. */
function dispatchOn(store: DocumentStore, invocations: readonly CommandInvocation[], actor: string | undefined): void {
  if (invocations.length === 0) return
  const outcome = store.dispatch({ ...batch(invocations), ...(actor !== undefined ? { actor } : {}) })
  if (!outcome.ok) refuse(outcome.diagnostics.find((item) => item.severity === 'error')?.message ?? 'The change could not be made.')
}

// ---------------------------------------------------------------------------
// Formulas, with the locals of a Pick or an Ask

interface Locals {
  readonly kinds: Map<string, FormulaNameKind>
  readonly values: Map<string, Value>
}

function evaluateIn(context: FormulaContext, locals: Locals, text: string, read?: (name: string, availability: boolean) => Value | typeof UNKNOWN | undefined, onRead?: FormulaValues['onRead'], inspectReads = false): FormulaOutcome {
  const scope = { ...context.scope, names: new Map([...context.scope.names, ...locals.kinds]) }
  const values = { ...context.values, read: (name: string, availability: boolean) =>
    locals.values.has(name) ? locals.values.get(name) : read === undefined ? context.values.values?.get(name) : read(name, availability), ...(onRead === undefined ? {} : { onRead }) }
  try {
    const formula = Formula.parse(text, scope)
    return inspectReads ? formula.inspectReads(values) : formula.evaluate(values)
  } catch (error) {
    if (error instanceof FormulaRefused) return { kind: 'failed', reason: error.message }
    throw error
  }
}

/** The names a formula reads that are wired inputs with no known value. */
function unknownWired(context: FormulaContext, locals: Locals, text: string, wired = (name: string) => context.values.linked?.get(name) === true, read = (name: string) => context.values.values?.get(name), onRead?: (name: string) => void): string[] {
  const needed: string[] = []
  const outcome = evaluateIn(context, locals, text, (name, availability) => {
    const value = read(name)
    if (!availability && (value === undefined || value === UNKNOWN) && wired(name)) needed.push(name)
    return value
  }, (name, fact, availability) => {
    onRead?.(name)
    if (!availability && fact !== undefined && fact !== 'linked' && fact !== 'linked_type' &&
      context.values.facts?.get(`${fact}(${name})`) === undefined && wired(name)) needed.push(name)
  })
  return outcome.kind === 'unknown' ? needed : []
}

// ---------------------------------------------------------------------------
// One press

class Press {
  readonly locals: Locals = { kinds: new Map(), values: new Map() }
  readonly declarationLocals: Locals = { kinds: new Map(), values: new Map() }
  readonly automaticValues = new Map<string, Value>()
  readonly resolvingAutomatic = new Set<string>()
  readonly actions: Action[] = []
  readonly notes: string[] = []
  readonly skipped: Skip[] = []
  nodeAdded = false
  view: View
  context: FormulaContext
  readonly signal: AbortSignal

  /** Runs on `store`, a scratch copy shared by every part of one run, so a later part sees what an earlier one staged. */
  constructor(
    readonly session: DocumentSession,
    readonly target: StepPlace,
    readonly host: ActionHost,
    readonly prefix: string,
    readonly store: DocumentStore,
    readonly options: PressOptions,
  ) {
    this.view = viewOf(store.doc, target, host) ?? refuse('The node is not in the workflow.')
    this.context = this.view.contexts.get(prefix) ?? refuse('The button is not on the node.')
    this.signal = options.signal ?? new AbortController().signal
    if (prefix !== '') this.retainRead(prefix.slice(0, -1))
  }

  // -- staging ---------------------------------------------------------------

  stage(actions: readonly Action[]): void {
    for (const action of actions) {
      const invocations = invocationsOf(action, this.store.doc, this.target, this.session.allocationActor, this.host)
      dispatchOn(this.store, invocations, this.session.allocationActor)
      this.actions.push(action.kind === 'disconnect' ? { ...action, delivery: JSON.stringify(invocations) } : action)
    }
    this.automaticValues.clear()
    this.view = viewOf(this.store.doc, this.target, this.host) ?? refuse('The node is gone.')
    this.context = this.view.contexts.get(this.prefix) ?? refuse('The button is not on the node.')
  }

  checkAbort(): void {
    if (this.signal.aborted) throw new Cancelled()
  }

  /** Wait for a host answer; Cancel ends the wait even when the host does not listen to the signal. */
  async wait<T>(promise: Promise<T>): Promise<T> {
    this.checkAbort()
    let onAbort = (): void => {}
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Cancelled())
      this.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const value = await Promise.race([promise, aborted])
      this.checkAbort()
      return value
    } catch (error) {
      if (this.signal.aborted) throw new Cancelled()
      throw error
    } finally {
      this.signal.removeEventListener('abort', onAbort)
      promise.catch(() => {})
    }
  }

  progress(progress: PressProgress | undefined): void {
    this.options.onProgress?.(progress)
  }

  // -- reading ---------------------------------------------------------------

  pathOf(name: string, context: FormulaContext = this.context): string {
    return context.paths.get(name) ?? refuse(`The button names ${name}, which is not on the node.`)
  }

  fieldOf(name: string, context: FormulaContext = this.context): { readonly path: string; readonly field: ElaboratedInput } {
    const path = this.pathOf(name, context)
    const field = inputAt(this.view, path) ?? refuse(`The button names ${name}, which is not a field the node shows.`)
    return { path, field }
  }

  wired(path: string): boolean {
    return this.view.connectivity.isInputConnected(path)
  }

  /** The value a formula reads for `name`; a wired field with no known value refuses. */
  async read(name: string, context: FormulaContext = this.context, locals = this.locals): Promise<Value> {
    return this.formula(name, context, undefined, locals)
  }

  retainRead(path: string, group = false, target = this.target, incoming = true): void {
    const view = target === this.target ? this.view : viewOf(this.store.doc, target, this.host) ?? refuse('The node is gone.')
    const address = resolveDynamicAddress({ port: path }, view.node.dynamic)
    const members = address.kind === 'resolved' ? [...address.references] : []
    if (group) for (const member of view.node.dynamic?.[path]?.members ?? []) members.push({ construct: path, member })
    const choices = [...constructsOf(view.schema, view.node.dynamic)].flatMap(([construct, spec]) =>
      (spec.kind === 'choice' || spec.kind === 'typeChoice') && (path === construct || path.startsWith(`${construct}.`))
        ? [{ construct, selected: view.elaborated.choices?.[construct] }] : [])
    this.actions.push({ kind: 'read', ...(target === this.target ? {} : { target }), path, field: inputAt(view, path) !== undefined, group, members, choices })
    if (incoming && view.connectivity.isInputConnected(path)) {
      view.incomingValue(path, (place, path) => this.retainRead(path, false, place, false))
      view.incomingType(path, (place, path) => this.retainRead(path, false, place, false))
    }
  }

  formulaRead(name: string, context: FormulaContext, availability: boolean): Value | typeof UNKNOWN | undefined {
    const path = context.paths.get(name)
    if (path === undefined) return context.values.values?.get(name)
    if (this.automaticValues.has(path)) return this.automaticValues.get(path)
    const field = inputAt(this.view, path)
    if (field?.spec.automatic !== undefined && !this.wired(path) && !Object.hasOwn(this.view.node.values, path)) {
      if (this.resolvingAutomatic.has(path)) return UNKNOWN
      if (availability) return 'lookup' in field.spec.automatic ? UNKNOWN : context.values.values?.get(name)
      throw new AutomaticNeeded(field)
    }
    if (field === undefined && context.scope.names.get(name)?.endsWith('[]') === true) {
      const dot = path.lastIndexOf('.')
      const group = path.slice(0, dot), row = path.slice(dot + 1)
      this.retainRead(group, true)
      const members = this.view.node.dynamic?.[group]?.members
      const minimums = this.view.elaborated.unstoredMinimums?.[group]?.members
      if (members !== undefined || minimums !== undefined) {
        const values: Exclude<Value, readonly unknown[]>[] = []
        for (const member of [...(members ?? []), ...(minimums ?? [])]) {
          const scope = this.view.contexts.get(`${group}.${member}.`)
          const memberPath = scope?.paths.get(row)
          if (memberPath !== undefined) this.retainRead(memberPath)
          const value = scope && this.formulaRead(row, scope, availability)
          if (value === undefined || value === UNKNOWN || Array.isArray(value)) return UNKNOWN
          values.push(value as Exclude<Value, readonly unknown[]>)
        }
        return values
      }
    }
    return context.values.values?.get(name)
  }

  async formula(text: string, context: FormulaContext = this.context, fallback?: Value, locals = this.locals): Promise<Value> {
    for (;;) {
      let pending: ElaboratedInput
      try {
        const outcome = evaluateIn(context, locals, text, (name, availability) => this.formulaRead(name, context, availability), (name) => {
          if (locals.values.has(name)) return
          const path = context.paths.get(name)
          if (path !== undefined) this.retainRead(path, context.scope.names.get(name) === 'group')
        })
        if (outcome.kind === 'value') return outcome.value
        if (fallback !== undefined) return fallback
        if (outcome.kind === 'failed') return refuse(`A formula of this button failed: ${outcome.reason}`)
        const needs = unknownWired(context, locals, text)
        return refuse(needs.length > 0 ? `Needs ${needs[0]}, which is not known until a run.` : 'A value this button needs is not known yet.')
      } catch (error) {
        if (!(error instanceof AutomaticNeeded)) throw error
        pending = error.field
      }
      const automatic = pending.spec.automatic!
      const path = valueKeyOf(pending)
      const scope = pending.automaticContext ?? context
      const defaultValue = (readWhenUnset(pending.spec) ?? null) as Json
      this.resolvingAutomatic.add(path)
      try {
        let value: unknown
        if ('lookup' in automatic) {
          const { result } = await this.lookup(automatic.lookup, automatic.args, 'value', scope, this.declarationLocals)
          if (result.state === 'paused') return refuse(PAUSED_MESSAGE)
          if (result.state !== 'ready') return refuse(LOOKUP_FAILED_MESSAGE)
          value = result.value
        } else {
          value = await this.formula(automatic.formula, scope, localOf(defaultValue, rowKind(pending.spec)), this.declarationLocals)
        }
        this.automaticValues.set(path, localOf(automaticValueOf(pending.spec, value as Json) ?? defaultValue, rowKind(pending.spec)))
      } finally {
        this.resolvingAutomatic.delete(path)
      }
    }
  }

  async argument(argument: Argument, context: FormulaContext = this.context, locals = this.locals): Promise<CallArg> {
    if (typeof argument !== 'string') return await this.formula(argument.formula, context, undefined, locals) as CallArg
    if (context.scope.names.get(argument) === 'opaque' || context.scope.assets?.has(argument)) {
      const fixed = context.fixed?.get(argument)
      if (fixed !== undefined) {
        if (fixed.linked === true) return refuse(`Needs ${argument}, which is not known until a run.`)
        return (fixed.value ?? null) as CallArg
      }
      const path = this.pathOf(argument, context)
      this.retainRead(path)
      if (this.wired(path)) {
        const incoming = this.view.incomingValue(path)
        if (incoming === undefined) return refuse(`Needs ${argument}, which is not known until a run.`)
        return incoming as CallArg
      }
      return (this.view.node.values[path] ?? null) as CallArg
    }
    return await this.read(argument, context, locals) as CallArg
  }

  async argumentsOf(args: readonly Argument[], context: FormulaContext, locals = this.locals): Promise<CallArg[]> {
    const values: CallArg[] = []
    for (const argument of args) values.push(await this.argument(argument, context, locals))
    return values
  }

  async lookup(name: string, args: readonly Argument[], use: 'options' | 'value', context = this.context, locals = this.locals): Promise<{ request: LookupRequest; result: LookupResult }> {
    if (this.options.noWait === true) return refuse(NO_WAIT_MESSAGE)
    const request: LookupRequest = {
      nodeType: this.view.node.type,
      node: this.target.occurrence ?? this.target.nodeId,
      function: name,
      args: await this.argumentsOf(args, context, locals),
      use,
      asker: 'press',
    }
    this.progress({ text: 'Loading' })
    try {
      const result = await this.wait(this.host.lookup(request, this.signal))
      return { request, result }
    } finally {
      this.progress(undefined)
    }
  }

  async value(value: StepValue, context: FormulaContext = this.context): Promise<Value | unknown> {
    if (value.kind === 'literal') return literalOf(value.value)
    if (value.kind === 'formula') return this.formula(value.text, context)
    const { result } = await this.lookup(value.function, value.args, 'value', context)
    if (result.state === 'paused') return refuse(PAUSED_MESSAGE)
    if (result.state !== 'ready') return refuse(LOOKUP_FAILED_MESSAGE)
    return result.value
  }

  // -- writing ---------------------------------------------------------------

  /** Stage `value` into the field `name`; a wired field is skipped and reported. */
  write(name: string, value: unknown, context: FormulaContext = this.context): Action[] {
    const { path, field } = this.fieldOf(name, context)
    if (this.wired(path)) {
      this.skip(path)
      return []
    }
    return [...this.materialize(field), { kind: 'value', path, value: fieldValue(field, value, path) }]
  }

  materialize(field: ElaboratedInput): Action[] {
    return field.materialize !== undefined && field.materialize.length > 0 ? [{ kind: 'materialize', frames: field.materialize }] : []
  }

  skip(id: string, why: Skip['why'] = 'wired'): void {
    if (!this.skipped.some((item) => item.id === id)) this.skipped.push({ id, why })
  }

  groupOf(name: string): { readonly path: string; readonly spec: GroupSpec; readonly members: readonly string[] } {
    const path = this.pathOf(name)
    const spec = constructsOf(this.view.schema, this.view.node.dynamic).get(path)
    if (spec?.kind !== 'group') return refuse(`The button names ${name}, which is not a group.`)
    this.retainRead(path, true)
    return { path, spec, members: this.view.node.dynamic?.[path]?.members ?? [] }
  }

  // -- the steps -------------------------------------------------------------

  async run(step: Step): Promise<void> {
    switch (step.step) {
      case 'set':
        this.stage(this.write(step.field, await this.value(step.value)))
        return
      case 'toggle': {
        const { path } = this.fieldOf(step.field)
        if (this.wired(path)) return this.skip(path)
        const current = await this.read(step.field)
        if (typeof current !== 'boolean') return refuse(`${step.field} is not a yes or no field.`)
        this.stage(this.write(step.field, !current))
        return
      }
      case 'reset': {
        const { path, field } = this.fieldOf(step.field)
        if (this.wired(path)) return this.skip(path)
        this.stage([...this.materialize(field), { kind: 'value', path, value: defaultValueOf(field, path) }])
        return
      }
      case 'swap': {
        const a = this.fieldOf(step.a)
        const b = this.fieldOf(step.b)
        if (this.wired(a.path) && this.wired(b.path)) {
          this.skip(a.path)
          this.skip(b.path)
          return
        }
        const valueA = await this.read(step.a)
        const valueB = await this.read(step.b)
        this.stage([...this.write(step.a, valueB), ...this.write(step.b, valueA)])
        return
      }
      case 'append': {
        const { path } = this.fieldOf(step.field)
        if (this.wired(path)) return this.skip(path)
        const current = await this.read(step.field)
        const added = await this.value(step.value)
        if (typeof current !== 'string' || typeof added !== 'string') return refuse(`Append joins text; ${step.field} or the added value is not text.`)
        this.stage(this.write(step.field, current === '' ? added : current + step.separator + added))
        return
      }
      case 'randomize':
        return this.randomize(step)
      case 'setMode': {
        const { path, field } = this.fieldOf(step.field)
        if (field.spec.widget?.controller === undefined) return refuse(`${step.field} has no after-run mode.`)
        if (this.wired(path)) return this.skip(path)
        this.stage([...this.materialize(field), { kind: 'mode', path, mode: step.mode }])
        return
      }
      case 'addMember':
        return this.addMember(step.group, step.values)
      case 'removeMember': {
        const group = this.groupOf(step.group)
        // The count is checked first: members not yet stored still count toward the least.
        if (group.spec.minMembers > 0 && group.members.length <= group.spec.minMembers) return refuse("The group already has its fewest members.")
        if (group.members.length === 0) return refuse(`${step.group} has no member to remove.`)
        let position: number
        if (step.which === 'first') position = 0
        else if (step.which === 'last') position = group.members.length - 1
        else {
          const raw = await this.formula(step.which.formula)
          if (typeof raw !== 'bigint') return refuse(`The position of the member to remove is not a whole number.`)
          if (raw < 0n || raw >= BigInt(group.members.length)) return refuse(`${step.group} has no member at position ${raw}.`)
          position = Number(raw)
        }
        const member = group.members[position]!
        if (memberWired(this.view, group.path, member)) return this.skip(`${group.path}.${member}`)
        this.stage([{ kind: 'removeMember', group: group.path, member }])
        return
      }
      case 'clearMembers': {
        const group = this.groupOf(step.group)
        let count = group.members.length
        const removed: Action[] = []
        for (const member of [...group.members].reverse()) {
          if (count <= group.spec.minMembers) break
          if (memberWired(this.view, group.path, member)) {
            this.skip(`${group.path}.${member}`)
            continue
          }
          removed.push({ kind: 'removeMember', group: group.path, member })
          count--
        }
        this.stage(removed)
        return
      }
      case 'setEach':
        return this.setEach(step.group, step.field, step.value)
      case 'disconnect': {
        const { path } = this.fieldOf(step.input)
        if (this.wired(path)) this.stage([{ kind: 'disconnect', path }])
        return
      }
      case 'addNode':
        return this.addNode(step.nodeType, step.to, step.values)
      case 'pick':
        return this.pick(step.name, step.options)
      case 'ask': {
        const answer = await this.wait(this.host.ask({ target: this.target, title: step.title, rows: step.rows }, this.signal))
        if (answer === undefined) throw new Cancelled()
        for (const row of step.rows) {
          const kind = rowKind(row)
          this.locals.kinds.set(row.id, kind)
          this.locals.values.set(row.id, localOf(answer[row.id], kind))
        }
        return
      }
      case 'openPicker':
      case 'openEditor':
      case 'pasteImage': {
        const { path, field } = this.fieldOf(step.field)
        if (this.wired(path)) return this.skip(path)
        let value: Json | undefined
        if (step.step === 'openPicker') value = await this.wait(this.host.openPicker(field, this.signal))
        else if (step.step === 'pasteImage') value = await this.wait(this.host.pasteImage(field, this.signal))
        else value = await this.wait((this.host.editorFor(field) ?? refuse(NO_EDITOR_MESSAGE))(this.signal, this.view.node.values[path]))
        if (value === undefined) throw new Cancelled()
        // The host's own picker, editor and paste give a value its asset handling already checked.
        this.stage([...this.materialize(field), { kind: 'value', path, value }])
        return
      }
      case 'call':
        return this.callWrites(step)
      default:
        return refuse(`${step.step} acts outside the workflow and runs after the changes are made.`)
    }
  }

  async randomize(step: Extract<Step, { step: 'randomize' }>): Promise<void> {
    const { path, field } = this.fieldOf(step.field)
    if (this.wired(path)) return this.skip(path)
    const widget = field.spec.widget
    const low = step.low === undefined ? undefined : await this.value(step.low)
    const high = step.high === undefined ? undefined : await this.value(step.high)
    if ((step.low !== undefined && typeof low !== 'bigint' && !(typeof low === 'number' && Number.isFinite(low)))
      || (step.high !== undefined && typeof high !== 'bigint' && !(typeof high === 'number' && Number.isFinite(high)))) {
      return refuse(`Randomize needs a lowest and a highest value for ${step.field}.`)
    }
    if ((typeof low === 'bigint' || typeof low === 'number') && (typeof high === 'bigint' || typeof high === 'number') && low > high) {
      return refuse(`Randomize needs a lowest and a highest value for ${step.field}.`)
    }
    const random = (): number => {
      const drawn = this.host.random()
      return drawn >= 0 && drawn < 1 ? drawn : 0
    }
    let value: unknown
    switch (widget?.widgetType) {
      case 'INT': {
        const limits = numericStepConstraints(widget)
        if (!limits.integer) return
        let lowest = typeof low === 'number' ? BigInt(Math.ceil(low)) : typeof low === 'bigint' ? low : limits.min
        let highest = typeof high === 'number' ? BigInt(Math.floor(high)) : typeof high === 'bigint' ? high : limits.max
        if (limits.min !== undefined && lowest !== undefined && lowest < limits.min) lowest = limits.min
        if (limits.max !== undefined && highest !== undefined && highest > limits.max) highest = limits.max
        if (lowest === undefined || highest === undefined || lowest > highest) {
          return refuse(`Randomize needs a lowest and a highest value for ${step.field}.`)
        }
        const base = limits.offset ?? lowest
        const first = lowest + ((((base - lowest) % limits.step) + limits.step) % limits.step)
        if (first > highest) return refuse(`${step.field} has no allowed value between ${lowest} and ${highest}.`)
        const count = (highest - first) / limits.step + 1n
        // Uniform over `count` values from 96 random bits, so no value is favoured noticeably.
        const bits = BigInt(Math.floor(random() * 2 ** 32)) << 64n | BigInt(Math.floor(random() * 2 ** 32)) << 32n | BigInt(Math.floor(random() * 2 ** 32))
        value = first + ((bits * count) >> 96n) * limits.step
        break
      }
      case 'FLOAT': {
        const limits = numericStepConstraints(widget)
        if (limits.integer) return
        const bound = (value: number | bigint, lower: boolean): number => {
          const number = Number(value)
          if (lower && number === -Infinity) return -Number.MAX_VALUE
          if (!lower && number === Infinity) return Number.MAX_VALUE
          if (typeof value === 'bigint' && Number.isFinite(number) && (lower ? number < value : number > value)) {
            // Integer bounds can round out of the interval; use the adjacent float inside it.
            const bits = new DataView(new ArrayBuffer(8))
            bits.setFloat64(0, number)
            bits.setBigUint64(0, bits.getBigUint64(0) + ((number > 0) === lower ? 1n : -1n))
            return bits.getFloat64(0)
          }
          return number
        }
        const lowest = Math.max(limits.min, typeof low === 'number' || typeof low === 'bigint' ? bound(low, true) : limits.min)
        const highest = Math.min(limits.max, typeof high === 'number' || typeof high === 'bigint' ? bound(high, false) : limits.max)
        if (!Number.isFinite(lowest) || !Number.isFinite(highest) || lowest > highest) {
          return refuse(`Randomize needs a lowest and a highest value for ${step.field}.`)
        }
        const draw = random()
        value = Math.min(highest, Math.max(lowest, lowest * (1 - draw) + highest * draw))
        break
      }
      case 'BOOLEAN':
        value = random() < 0.5
        break
      case 'COMBO': {
        const options = normalizedComboOptions(widget)
        if (options.length === 0 || widget.remote !== undefined) return refuse(`${step.field} has no options written in its declaration.`)
        value = options[Math.floor(random() * options.length)]!.value
        break
      }
      default:
        return refuse(`Randomize cannot choose a value for ${step.field}, a ${widget?.widgetType.toLowerCase() ?? 'pin'} field.`)
    }
    this.stage(this.write(step.field, value))
  }

  async addMember(name: string, values: Readonly<Record<string, StepValue>>): Promise<void> {
    const group = this.groupOf(name)
    const evaluated: [string, unknown][] = []
    for (const [row, value] of Object.entries(values)) evaluated.push([row, await this.value(value)])
    const growth = this.view.elaborated.items.find((item) => item.kind === 'growth' && item.construct === group.path)
    const ghost = elabInputsOf(this.view.elaborated).find((input) =>
      input.ancestry?.at(-1)?.construct === group.path && input.ancestry.at(-1)?.ghost === true &&
      !(this.view.elaborated.unstoredMinimums?.[group.path]?.members.includes(input.ancestry.at(-1)!.member) ?? false))
    const frames = growth?.kind === 'growth' ? growth.frames : ghost?.materialize
    const frame = frames === undefined ? undefined : [...frames].reverse().find((item) => item.construct === group.path)
    if (frames === undefined || frame === undefined) return refuse(`${name} already has its most members.`)
    const key = frame.members.at(-1)!
    this.stage([{ kind: 'materialize', frames, adds: { group: group.path, member: key } }])
    const memberContext = this.view.contexts.get(`${group.path}.${key}.`)
    const writes: Action[] = []
    for (const [row, value] of evaluated) {
      if (group.spec.value !== undefined) return refuse(`${name} holds one value per member; AddMember values name member rows.`)
      writes.push(...this.write(row, value, memberContext ?? refuse(`${name} did not add a member.`)))
    }
    this.stage(writes)
  }

  async setEach(name: string, row: string, value: StepValue): Promise<void> {
    const group = this.groupOf(name)
    const members = [...group.members, ...(this.view.elaborated.unstoredMinimums?.[group.path]?.members ?? [])]
    // Every member's value is worked out before any member is written.
    const evaluated: [FormulaContext, unknown][] = []
    for (const member of members) {
      const context = this.view.contexts.get(`${group.path}.${member}.`) ?? refuse(`${name} has no member ${member}.`)
      evaluated.push([context, await this.value(value, context)])
    }
    this.stage(evaluated.flatMap(([context, item]) => this.write(row, item, context)))
  }

  async addNode(type: string, to: string, values: Readonly<Record<string, StepValue>>): Promise<void> {
    const { path, field } = this.fieldOf(to)
    const graph = this.view.doc.graphs[this.target.graphId]!
    const occurrence = (this.target.instancePath?.length ?? 0) > 0
    const delivery = occurrenceDriverOf(this.view.doc, this.target, path, this.host)
    if (delivery.outside) {
      this.skip(path, 'outside')
      return
    }
    const hops = this.target.instancePath ?? []
    const topology = occurrence ? effectiveOccurrenceTopology(this.view.doc, this.host.schemaResolverFor!(this.view.doc), {
      instancePath: hops.slice(0, -1).map(asNodeId), node: asNodeId(hops.at(-1)!),
    }) : undefined
    const probe: NodeData = { id: '' as NodeData['id'], type, values: {} }
    const schema = this.host.schemaOf(this.view.doc, this.target.graphId, probe) ?? refuse(`The node type ${type} is not installed.`)
    const evaluated: Record<string, unknown> = {}
    for (const [row, value] of Object.entries(values)) evaluated[row] = await this.value(value)
    const added = elaborateInterface(schema, probe, EMPTY_CONNECTIVITY, { promoteGhosts: false })
    const stored: Record<string, Json> = {}
    for (const [row, value] of Object.entries(evaluated)) {
      const input = elabInputsOf(added).find((candidate) => valueKeyOf(candidate) === row) ?? refuse(`${type} has no field ${row}.`)
      stored[row] = fieldValue(input, value, row)
    }
    const output = elabOutputsOf(added).find((candidate) => candidate.wireable !== false && typesCompatible(candidate.spec.type, field.spec.type))
    if (output === undefined) return refuse(`${type} has no output that fits ${to}.`)
    const driver = occurrence ? delivery.chain[0] === undefined ? undefined : { from: delivery.chain[0].from.endpoint }
      : definitionDriverOf(graph, this.target.nodeId, path)
    let between: { from: LinkEndpoint; input: string } | undefined
    if (driver !== undefined) {
      let effective = graph
      if (topology !== undefined) {
        effective = { ...graph, nets: {}, links: Object.fromEntries(topology.links.map((link, index) =>
          [`l${index}`, { id: `l${index}`, from: link.from.endpoint, to: link.to.endpoint }])) as GraphDef['links'] }
      }
      const trace = traceEndpoint(effective, driver.from, buildRerouteIndex(effective))
      if (trace.kind !== 'output' && trace.kind !== 'tapValue') return refuse(`The wire feeding ${to} could not be resolved.`)
      const sourceView = viewOf(this.view.doc, { ...this.target, nodeId: trace.kind === 'output' ? trace.ref.node : trace.node }, this.host)
      const sourceType = trace.kind === 'output'
        ? sourceView && elabOutputsOf(sourceView.elaborated).find((candidate) => candidate.address.port === trace.ref.port)?.spec.type
        : sourceView && inputAt(sourceView, trace.input)?.spec.type
      if (sourceType === undefined) return refuse(`The wire feeding ${to} could not be resolved.`)
      const input = elabInputsOf(added).find((candidate) => candidate.spec.socketless !== true && typesCompatible(sourceType, candidate.spec.type))
      if (input === undefined) return refuse(`${type} has no input that fits the wire feeding ${to}.`)
      between = { from: driver.from, input: valueKeyOf(input) }
    }
    const at = this.view.doc.view.graphs[this.target.graphId]?.nodes[this.target.nodeId]?.position ?? { x: 0, y: 0 }
    this.stage([{
      kind: 'addNode',
      type,
      values: stored,
      position: { x: at.x - 320, y: at.y },
      output: output.address.port,
      to: path,
      ...(between !== undefined ? { between } : {}),
      ...(driver !== undefined ? { source: driver.from } : {}),
      ...(occurrence ? { delivery: JSON.stringify(delivery.chain) } : {}),
    }])
  }

  async pick(name: string, options: StepValue): Promise<void> {
    let list: unknown
    let state: PickRequest['state'] = 'ready'
    let lookup: LookupRequest | undefined
    if (options.kind === 'lookup') {
      const { request, result } = await this.lookup(options.function, options.args, 'options')
      lookup = request
      state = result.state
      if (result.state === 'ready' || result.state === 'stale') list = result.value
    } else {
      list = await this.value(options)
    }
    const normalized = Array.isArray(list)
      ? list.flatMap((item: unknown) => {
        const option = normalizeComboOption(typeof item === 'bigint' ? Number(item) : item)
        return option === undefined ? [] : [option]
      })
      : []
    if (list !== undefined && !Array.isArray(list)) return refuse('The list of this button is not a list.')
    const chosen = await this.wait(this.host.pick({ target: this.target, options: normalized, state, ...(lookup ? { lookup } : {}) }, this.signal))
    if (chosen === undefined) throw new Cancelled()
    const value = typeof chosen === 'number' && Number.isInteger(chosen) ? BigInt(chosen) : chosen
    this.locals.kinds.set(name, kindOfValue(value))
    this.locals.values.set(name, value)
  }

  async call(step: Extract<Step, { step: 'call' }>, context: FormulaContext): Promise<CallAnswer & { readonly kind: 'answer' | 'file' }> {
    if (this.options.noWait === true) return refuse(NO_WAIT_MESSAGE)
    const request: CallRequest = {
      nodeType: this.view.node.type,
      function: step.function,
      args: await this.argumentsOf(step.args, context),
      ...(step.download !== undefined ? { download: step.download } : { writes: step.writes }),
    }
    this.progress({ text: 'Working' })
    try {
      const answer = await this.wait(this.host.call(request, (fraction, text) => this.progress({ text: text || 'Working', fraction }), this.signal))
      if (answer.kind === 'failed') return refuse(answer.message)
      this.notes.push(...answer.notes)
      return answer
    } finally {
      this.progress(undefined)
    }
  }

  async callWrites(step: Extract<Step, { step: 'call' }>): Promise<void> {
    const answer = await this.call(step, this.context)
    if (answer.kind !== 'answer') return refuse('The pack answered with a file where the button expected fields.')
    const fields = Object.entries(answer.fields)
    if (fields.some(([key]) => !step.writes.includes(key))) return refuse(EXTRA_KEY_MESSAGE)
    const actions: Action[] = []
    for (const [key, raw] of fields) {
      const path = this.pathOf(key)
      const described = describedAt(this.view.schema.body, path)
      if (described !== undefined) {
        const entries = describedEntries(described, raw, path)
        if (typeof entries === 'string') return refuse(`The pack's answer for ${key} does not fit: ${entries}.`)
        actions.push({ kind: 'value', path, value: raw as string })
      } else {
        actions.push(...this.write(key, raw))
      }
    }
    this.stage(actions)
  }

  // -- the commit ------------------------------------------------------------

  /**
   * Build the staged changes again on `live`, a copy of the live document,
   * skipping what changed meanwhile; the invocations to dispatch, and how
   * many fields they set.
   */
  rebuild(live: DocumentStore, edited: ReadonlySet<string>): { readonly invocations: readonly CommandInvocation[]; readonly written: number } {
    const invocations: CommandInvocation[] = []
    const written = new Set<string>()
    for (const action of this.actions) {
      const view = viewOf(live.doc, action.kind === 'read' ? action.target ?? this.target : this.target, this.host) ?? refuse('The node was removed while the button waited.')
      if (action.kind === 'read') {
        for (const { construct, member } of action.members) {
          if (view.node.dynamic?.[construct]?.members?.includes(member) !== true) return refuse('A member this button needs was removed while it waited.')
        }
        for (const { construct, selected } of action.choices) {
          if (view.elaborated.choices?.[construct] !== selected) return refuse('An option this button needs changed while it waited.')
        }
        if ((action.field && inputAt(view, action.path) === undefined) ||
          (action.group && constructsOf(view.schema, view.node.dynamic).get(action.path)?.kind !== 'group')) return refuse('A field or group this button needs is no longer on the node.')
        continue
      } else if (action.kind === 'value' || action.kind === 'mode') {
        if (resolveDynamicAddress({ port: action.path }, view.node.dynamic).kind === 'missing') {
          return refuse('A member this button sets was removed while it waited.')
        }
        // Missing structure aborts the press even when its removal also deleted a saved value.
        if (inputAt(view, action.path) === undefined) return refuse('A field this button sets is no longer on the node.')
        if (edited.has(`${action.kind === 'value' ? 'values' : 'controllers'}:${action.path}`)) {
          if (this.options.strict === true) return refuse(this.options.staleMessage ?? STALE_MESSAGE, this.options.staleMessage !== undefined)
          this.skip(action.path, 'edited')
          continue
        }
        if (view.connectivity.isInputConnected(action.path)) {
          this.skip(action.path)
          continue
        }
        written.add(action.path)
      } else if (action.kind === 'materialize') {
        if (action.adds !== undefined && view.node.dynamic?.[action.adds.group]?.members?.includes(action.adds.member) === true) {
          return refuse('The group changed while the button waited.')
        }
      } else if (action.kind === 'addNode') {
        const graph = live.doc.graphs[this.target.graphId]!
        const driver = definitionDriverOf(graph, this.target.nodeId, action.to)
        const connected = view.connectivity.isInputConnected(action.to)
        const delivery = occurrenceDriverOf(live.doc, this.target, action.to, this.host)
        if (delivery.outside) {
          this.skip(action.to, 'outside')
          continue
        }
        const changed = action.delivery !== undefined
          ? JSON.stringify(delivery.chain) !== action.delivery
          : JSON.stringify(driver?.from) !== JSON.stringify(action.source) || (connected && driver === undefined)
        if (changed) {
          this.skip(action.to)
          continue
        }
      } else if (action.kind === 'removeMember') {
        if (view.node.dynamic?.[action.group]?.members?.includes(action.member) !== true) {
          return refuse('A member this button removes was already removed.')
        }
        if (memberWired(view, action.group, action.member)) {
          this.skip(`${action.group}.${action.member}`)
          continue
        }
      }
      const built = invocationsOf(action, live.doc, this.target, this.session.allocationActor, this.host)
      if (action.kind === 'disconnect' && JSON.stringify(built) !== action.delivery) {
        this.skip(action.path)
        continue
      }
      if (built.length === 0) continue
      dispatchOn(live, built, this.session.allocationActor)
      invocations.push(...built)
      if (action.kind === 'addNode') this.nodeAdded = true
    }
    return { invocations, written: written.size }
  }

  /** The value or mode this press leaves on each field it sets, keyed by node and field. */
  finalWrites(): Map<string, string> {
    const writes = new Map<string, string>()
    for (const action of this.actions) {
      if (action.kind !== 'value' && action.kind !== 'mode') continue
      const owner = this.view.valueOwners.get(action.path)
      const { graphId, nodeId } = owner ?? this.target
      const path = owner?.valueKey ?? action.path
      if (action.kind === 'value') writes.set(`${graphId} ${nodeId} values:${path}`, JSON.stringify(action.value) ?? 'unset')
      if (action.kind === 'mode') writes.set(`${graphId} ${nodeId} controllers:${path}`, JSON.stringify(action.mode))
    }
    return writes
  }

  // -- outside the workflow --------------------------------------------------

  /** Runs a step outside the workflow; the name of a file the user closed Save As on. */
  async outside(step: Step): Promise<string | undefined> {
    switch (step.step) {
      case 'queue':
        await this.host.queue(step.toHere ? { graphId: this.target.graphId, nodeId: this.target.nodeId } : undefined)
        return undefined
      case 'interrupt':
        await this.host.interrupt()
        return undefined
      case 'copy':
        await this.host.copy(display(await this.value(step.value)))
        return undefined
      case 'download':
        return await this.host.download(step.filename, display(await this.value(step.value))) === 'closed' ? step.filename : undefined
      case 'openLink':
        await this.host.openLink(display(await this.value(step.url)), step.url.kind !== 'literal', this.signal)
        return undefined
      case 'call': {
        const answer = await this.call(step, this.context)
        if (answer.kind !== 'file') return refuse('The pack answered with fields where the button expected a file.')
        return await this.host.download(step.download!, answer.bytes) === 'closed' ? step.download : undefined
      }
      default:
        return refuse(`${step.step} changes the workflow after a step that acts outside it.`)
    }
  }
}

const OUTSIDE_WORDS: Readonly<Record<string, string>> = {
  queue: 'Queueing the run',
  interrupt: 'Stopping the run',
  copy: 'Copying',
  download: 'Saving the file',
  openLink: 'Opening the link',
  call: 'Saving the file',
}

function summary(changed: number, skipped: readonly Skip[], notes: readonly string[], nodeAdded: boolean): string | undefined {
  if (skipped.length === 0 && notes.length === 0) return undefined
  const mixedAddition = nodeAdded && skipped.some(({ why }) => why === 'outside')
  const parts: string[] = mixedAddition ? [...notes] : []
  if (skipped.length > 0) {
    if (changed > 0) parts.push(`Set ${changed} ${changed === 1 ? 'field' : 'fields'}.`)
    parts.push(...skipped.map(({ id, why }) => why === 'edited'
      ? `${id} was changed while the button waited and keeps that value.`
      : why === 'outside' ? nodeAdded ? `Skipped ${id}: it is wired from outside this subgraph.` : `Nothing added. ${id} is wired from outside this subgraph.`
        : `${id} has a wire and was left as it is.`))
  }
  if (!mixedAddition) parts.push(...notes)
  return parts.join(mixedAddition ? '\n' : ' ')
}

/** Steps that ask the user for something: they cannot run where nobody waits on them. */
const ASKS_THE_USER = new Set<Step['step']>(['pick', 'ask', 'openPicker', 'openEditor', 'pasteImage'])

/**
 * Run the steps of the button `target` names on `session`'s document. The
 * press is one undo step, or nothing when it fails or is cancelled.
 */
export async function runPress(
  session: DocumentSession,
  target: PressTarget,
  host: ActionHost,
  options: PressOptions = {},
): Promise<PressOutcome> {
  const availability = buttonAvailability(session.doc, target, host)
  if (!availability.enabled) return failedOutcome(availability.reason)
  const view = viewOf(session.doc, target, host)!
  const button = buttonOf(view, target)!
  return run(session, [{ ...target, prefix: button.prefix, steps: decodeSteps(button.spec.steps) }], host, options)
}

/**
 * Run lists of steps that are not a button's, such as the fixes of a node's
 * rules, as one run: each part in order on one scratch copy of the document,
 * so a later part sees what an earlier one set, then every change stored as
 * one undo step, or nothing when any part fails or the run is cancelled.
 * Steps outside the workflow run after that, part by part.
 */
export async function runSteps(
  session: DocumentSession,
  parts: readonly StepPart[],
  host: ActionHost,
  options: PressOptions = {},
): Promise<PressOutcome> {
  return run(session, parts, host, options)
}

/** A failure; a message the caller passed is shown as it is, any other after "Nothing was changed." */
const failedOutcome = (message: string, notes: readonly string[] = [], own = false): PressOutcome =>
  ({ kind: 'failed', message: own ? message : `Nothing was changed. ${message}`, warning: true, skipped: [], notes })

async function run(session: DocumentSession, parts: readonly StepPart[], host: ActionHost, options: PressOptions): Promise<PressOutcome> {
  const stale = options.staleMessage ?? STALE_MESSAGE
  if (options.insideOnly === true || options.noWait === true) {
    const steps = parts.flatMap((part) => part.steps)
    if (steps.some((step) => isOutsideStep(step) || ASKS_THE_USER.has(step.step))) return failedOutcome(INSIDE_ONLY_MESSAGE)
    if (options.noWait === true && steps.some((step) => step.step === 'call')) return failedOutcome(NO_WAIT_MESSAGE)
  }
  const ownStale = options.staleMessage !== undefined
  if (options.unchanged?.(session.doc) === false) return failedOutcome(stale, [], ownStale)

  // Which fields of each node the run touches change while it waits, and whether a node goes.
  const placeKey = (place: StepPlace): string => JSON.stringify([place.graphId, place.instancePath ?? [], place.nodeId])
  const places = new Map(parts.map((part) => [placeKey(part), part]))
  const edited = new Map([...places.keys()].map((key) => [key, new Set<string>()]))
  const before = new Map([...places].map(([key, place]) => [key, viewOf(session.doc, place, host)]))
  let gone = false
  const stop = session.onOp(() => {
    for (const [key, place] of places) {
      const was = before.get(key)
      const now = viewOf(session.doc, place, host)
      if (was === undefined || now === undefined) {
        gone = true
        continue
      }
      for (const store of ['values', 'controllers'] as const) {
        const old = was.node[store] ?? {}
        const next = now.node[store] ?? {}
        for (const field of new Set([...Object.keys(old), ...Object.keys(next)])) {
          if (JSON.stringify((old as Record<string, unknown>)[field]) !== JSON.stringify((next as Record<string, unknown>)[field])) edited.get(key)!.add(`${store}:${field}`)
        }
      }
      for (const field of new Set([...was.valueOwners.keys(), ...now.valueOwners.keys()])) {
        const oldOwner = was.valueOwners.get(field)
        const newOwner = now.valueOwners.get(field)
        if (JSON.stringify(oldOwner) !== JSON.stringify(newOwner)) {
          edited.get(key)!.add(`values:${field}`)
          edited.get(key)!.add(`controllers:${field}`)
        } else if (oldOwner !== undefined && newOwner !== undefined) {
          const oldNode = was.doc.graphs[oldOwner.graphId]?.nodes[oldOwner.nodeId]
          const newNode = now.doc.graphs[newOwner.graphId]?.nodes[newOwner.nodeId]
          for (const store of ['values', 'controllers'] as const) {
            if (JSON.stringify(oldNode?.[store]?.[oldOwner.valueKey]) !== JSON.stringify(newNode?.[store]?.[newOwner.valueKey])) {
              edited.get(key)!.add(`${store}:${field}`)
            }
          }
        }
      }
      before.set(key, now)
    }
  })

  const actor = session.allocationActor
  const lead = options.lead ?? []
  const presses: Press[] = []
  let changed = 0
  try {
    const scratch = scratchOf(session.doc, host)
    dispatchOn(scratch, lead, actor)
    for (const part of parts) {
      const press = new Press(session, part, host, part.prefix, scratch, options)
      presses.push(press)
      for (const step of part.steps) {
        if (isOutsideStep(step)) break
        press.checkAbort()
        await press.run(step)
      }
    }
    presses[0]?.checkAbort()
    stop()

    // Two parts may set one field only to the same value.
    const writes = new Map<string, string>()
    for (const press of presses) {
      for (const [field, value] of press.finalWrites()) {
        if (writes.has(field) && writes.get(field) !== value) refuse(options.conflictMessage ?? CONFLICT_MESSAGE, options.conflictMessage !== undefined)
        writes.set(field, value)
      }
    }
    if (options.unchanged?.(session.doc) === false) refuse(stale, ownStale)
    if (gone || options.stillCurrent?.() === false) refuse('The node was removed while the button waited.')

    // Build everything again on the live document and store it as one undo step.
    const live = scratchOf(session.doc, host)
    dispatchOn(live, lead, actor)
    const invocations: CommandInvocation[] = [...lead]
    for (const press of presses) {
      const rebuilt = press.rebuild(live, edited.get(placeKey(press.target))!)
      invocations.push(...rebuilt.invocations)
      changed += rebuilt.written
    }
    if (invocations.length > 0) {
      const outcome = session.dispatch(batch(invocations))
      if (!outcome.ok) refuse(outcome.diagnostics.find((item) => item.severity === 'error')?.message ?? 'The change could not be made.')
    }
  } catch (error) {
    stop()
    options.onProgress?.(undefined)
    const notes = presses.flatMap((press) => press.notes)
    if (error instanceof Cancelled) return { kind: 'cancelled', skipped: [], notes: [] }
    if (error instanceof Refusal) return failedOutcome(error.message, notes, error.own)
    return failedOutcome(error instanceof Error && error.message !== '' ? error.message : 'The button could not finish.', notes)
  }

  // The outside steps read the committed document.
  const outsideFailures: string[] = []
  const unsaved: string[] = []
  for (const [index, press] of presses.entries()) {
    if (press.nodeAdded && (press.target.instancePath?.length ?? 0) > 0) {
      const count = (id: string, ancestors: ReadonlySet<string>): number => {
        if (ancestors.has(id)) return 0
        return (id === press.target.graphId ? 1 : 0) + Object.values(session.doc.graphs[id]!.nodes).reduce((total, node) => {
          const child = subgraphDefIdOf(node.type)
          return total + (child === undefined ? 0 : count(child, new Set([...ancestors, id])))
        }, 0)
      }
      const uses = count(session.doc.root, new Set())
      if (uses > 1) press.notes.push(`Also added in the other ${uses === 2 ? 'use' : `${uses - 1} uses`} of ${session.doc.graphs[press.target.graphId]!.name}.`)
    }
    const part = parts[index]!
    const committed = viewOf(session.doc, part, host)
    if (committed !== undefined) {
      press.automaticValues.clear()
      press.view = committed
      press.context = committed.contexts.get(part.prefix) ?? press.context
    }
    for (const step of part.steps.filter(isOutsideStep)) {
      try {
        const closed = await press.outside(step)
        if (closed !== undefined) unsaved.push(closed)
      } catch (error) {
        const reason = error instanceof Error && error.message !== '' ? error.message : 'it did not finish'
        outsideFailures.push(`${OUTSIDE_WORDS[step.step] ?? 'This step'} failed: ${reason}`)
      }
    }
  }
  options.onProgress?.(undefined)
  const skipped = presses.flatMap((press) => press.skipped)
  const notes = presses.flatMap((press) => press.notes)
  const message = [
    ...unsaved.map((name) => `The Save As dialog was closed, so ${name} was not saved.`),
    summary(changed, skipped, notes, presses.some((press) => press.nodeAdded)),
  ].filter((part) => part !== undefined).join(' ') || undefined
  if (outsideFailures.length > 0) {
    const kept = lead.length > 0 || presses.some((press) => press.actions.some((action) => action.kind !== 'read')) ? 'The changes were made. ' : ''
    return {
      kind: 'done',
      message: `${kept}${outsideFailures.join(' ')}${message === undefined ? '' : ` ${message}`}`,
      warning: true,
      skipped,
      notes,
    }
  }
  return { kind: 'done', ...(message !== undefined ? { message } : {}), skipped, notes }
}

// ---------------------------------------------------------------------------
// Before a press

/** The fields steps would set, by name in their evaluation scope. */
function targetsOf(steps: readonly Step[]): { readonly fields: readonly string[]; readonly other: boolean } {
  const fields: string[] = []
  let other = false
  for (const step of steps) {
    switch (step.step) {
      case 'set': case 'toggle': case 'reset': case 'append': case 'randomize': case 'setMode':
      case 'openPicker': case 'openEditor': case 'pasteImage': case 'setEach':
        fields.push(step.field)
        break
      case 'swap':
        fields.push(step.a, step.b)
        break
      case 'call':
        if (step.download === undefined) fields.push(...step.writes)
        else other = true
        break
      case 'pick': case 'ask':
        break
      default:
        other = true
    }
  }
  return { fields, other }
}

const formulasOf = (value: StepValue | undefined): readonly string[] =>
  value?.kind === 'formula' ? [value.text] : value?.kind === 'lookup' ? value.args.flatMap((arg) => typeof arg === 'string' ? [] : [arg.formula]) : []

/**
 * Whether the button can be pressed now, and why not. Known from the
 * declaration and the stored state, so a press that could not finish never
 * starts: the pack turned it off, it would open an editor that does not exist
 * yet, it needs a wired value not known until a run, or every field it sets
 * has a wire.
 */
export function buttonAvailability(doc: WorkflowDocument, target: PressTarget, host: Pick<ActionHost, 'schemaOf' | 'schemaResolverFor' | 'editorFor'>): ButtonAvailability {
  const initial = viewOf(doc, target, host as ActionHost)
  const button = initial && buttonOf(initial, target)
  const initialContext = button && initial!.contexts.get(button.prefix)
  if (initial === undefined || button === undefined || initialContext === undefined) return { enabled: false, reason: 'This button is not on the node.' }
  let view: View = initial
  let context: FormulaContext = initialContext
  let steps: readonly Step[]
  try {
    steps = decodeSteps(button.spec.steps)
  } catch (error) {
    return { enabled: false, reason: `This button cannot run: ${error instanceof Error ? error.message : String(error)}.` }
  }

  // Locals are declared, unknown until their step runs.
  const locals: Locals = { kinds: new Map(), values: new Map() }
  for (const step of steps) {
    if (step.step === 'pick') locals.kinds.set(step.name, 'text')
    if (step.step === 'ask') for (const row of step.rows) locals.kinds.set(row.id, rowKind(row))
  }
  const literal = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined
  const enabled = button.spec.enabled
  const on = typeof enabled === 'object' ? evaluateIn(context, locals, enabled.formula) : { kind: 'value' as const, value: enabled ?? true }
  if (on.kind === 'value' && on.value === false) {
    const reason = button.spec.disabledReason
    const text = typeof reason === 'object' ? evaluateIn(context, locals, reason.formula) : undefined
    return { enabled: false, reason: literal(text?.kind === 'value' ? text.value : reason) ?? 'This button is turned off.' }
  }

  for (const step of steps) {
    if (step.step !== 'openEditor') continue
    const path = context.paths.get(step.field)
    const field = path === undefined ? undefined : inputAt(view, path)
    if (field === undefined || host.editorFor(field) === undefined) return { enabled: false, reason: NO_EDITOR_MESSAGE }
  }

  const unknown = new Set<string>()
  const pending = new Error('A preceding step has no preview value.')
  const checkRead = (scope: FormulaContext, name: string): void => {
    const path = scope.paths.get(name)
    if (path !== undefined && [...unknown].some((field) => field === path || field.startsWith(`${path}.`) || path.startsWith(`${field}.`))) throw pending
  }
  const read = (scope: FormulaContext, name: string): Value | typeof UNKNOWN | undefined => {
    checkRead(scope, name)
    return scope.values.values?.get(name)
  }
  const valueOf = (value: StepValue, scope: FormulaContext): Value | typeof UNKNOWN => {
    if (value.kind === 'literal') return literalOf(value.value)
    if (value.kind === 'lookup') return UNKNOWN
    const outcome = evaluateIn(scope, locals, value.text, (name) => read(scope, name), (name) => checkRead(scope, name))
    return outcome.kind === 'value' ? outcome.value : UNKNOWN
  }
  const wiredName = (name: string, scope: FormulaContext): boolean => {
    const path = scope.paths.get(name)
    if (path === undefined) return scope.values.linked?.get(name) === true
    if (view.connectivity.isInputConnected(path)) return true
    if (scope.scope.names.get(name)?.endsWith('[]')) {
      const dot = path.lastIndexOf('.')
      const group = path.slice(0, dot), row = path.slice(dot + 1)
      return [...(view.node.dynamic?.[group]?.members ?? []), ...(view.elaborated.unstoredMinimums?.[group]?.members ?? [])]
        .some((member) => view.connectivity.isInputConnected(`${group}.${member}.${row}`))
    }
    return false
  }
  let scratch: DocumentStore | undefined
  let previewHost: ActionHost | undefined
  const targets: boolean[] = []
  let other = false
  for (const step of steps) {
    let scopes = [context]
    if (step.step === 'setEach') {
      const path = context.paths.get(step.group)
      const members = path === undefined ? [] : [
        ...(view.node.dynamic?.[path]?.members ?? []),
        ...(view.elaborated.unstoredMinimums?.[path]?.members ?? []),
      ]
      scopes = members.flatMap((member) => {
        const scope = view.contexts.get(`${path}.${member}.`)
        return scope === undefined ? [] : [scope]
      })
    }
    const writes = targetsOf([step])
    other ||= writes.other
    targets.push(...scopes.flatMap((scope) => writes.fields.map((name) => wiredName(name, scope))))
    const texts: string[] = []
    const names: string[] = []
    const values = ['value', 'low', 'high', 'options', 'url'].map((key) => (step as Record<string, unknown>)[key] as StepValue | undefined)
    if (step.step === 'addMember' || step.step === 'addNode') values.push(...Object.values(step.values))
    for (const value of values) {
      texts.push(...formulasOf(value))
      if (value?.kind === 'lookup') names.push(...value.args.filter((arg): arg is string => typeof arg === 'string'))
    }
    if (step.step === 'removeMember' && typeof step.which === 'object') texts.push(step.which.formula)
    if (step.step === 'call') {
      for (const arg of step.args) {
        if (typeof arg === 'string') names.push(arg)
        else texts.push(arg.formula)
      }
    }
    if (step.step === 'swap' && !(wiredName(step.a, context) && wiredName(step.b, context))) names.push(step.a, step.b)
    for (const scope of scopes) {
      const needed: string[] = []
      const requiredRead = (name: string, availability = false): Value | typeof UNKNOWN | undefined => {
        const value = read(scope, name)
        if (!availability && !locals.kinds.has(name) && wiredName(name, scope) && (value === UNKNOWN || value === undefined)) needed.push(name)
        return value
      }
      for (const name of names) {
        try {
          requiredRead(name)
        } catch (error) {
          if (error !== pending) throw error
        }
      }
      for (const text of texts) {
        try {
          evaluateIn(scope, locals, text, requiredRead, (name, fact, availability) => {
            checkRead(scope, name)
            if (!availability && fact !== undefined && fact !== 'linked' && fact !== 'linked_type' &&
              scope.values.facts?.get(`${fact}(${name})`) === undefined && wiredName(name, scope)) needed.push(name)
          }, true)
        } catch (error) {
          if (error !== pending) throw error
        }
      }
      if (needed.length > 0) return { enabled: false, reason: `Needs ${needed[0]}, which is not known until a run.` }
    }
    // Only deterministic values are staged here. No host effect runs during a repaint.
    try {
      const actions: Action[] = []
      const write = (name: string, value: Value | typeof UNKNOWN, scope = context): void => {
        const path = scope.paths.get(name)
        const field = path === undefined ? undefined : inputAt(view, path)
        if (path === undefined || field === undefined || view.connectivity.isInputConnected(path)) return
        unknown.add(path)
        if (value === UNKNOWN) return
        const stored = fieldValue(field, value, path)
        if (field.materialize?.length) actions.push({ kind: 'materialize', frames: field.materialize })
        actions.push({ kind: 'value', path, value: stored })
        unknown.delete(path)
      }
      switch (step.step) {
        case 'set': write(step.field, valueOf(step.value, context)); break
        case 'toggle': {
          const value = read(context, step.field)
          write(step.field, typeof value === 'boolean' ? !value : UNKNOWN)
          break
        }
        case 'swap':
          if (!(wiredName(step.a, context) && wiredName(step.b, context))) {
            const a = read(context, step.a), b = read(context, step.b)
            write(step.a, b === undefined ? UNKNOWN : b); write(step.b, a === undefined ? UNKNOWN : a)
          }
          break
        case 'append': {
          const current = read(context, step.field), added = valueOf(step.value, context)
          write(step.field, typeof current === 'string' && typeof added === 'string'
            ? current === '' ? added : current + step.separator + added : UNKNOWN)
          break
        }
        case 'reset': {
          const path = context.paths.get(step.field), field = path === undefined ? undefined : inputAt(view, path)
          if (field !== undefined && path !== undefined && !view.connectivity.isInputConnected(path)) {
            if (field.materialize?.length) actions.push({ kind: 'materialize', frames: field.materialize })
            actions.push({ kind: 'value', path, value: defaultValueOf(field, path) })
            unknown.delete(path)
          }
          break
        }
        case 'setEach': {
          const values = scopes.map((scope) => valueOf(step.value, scope))
          scopes.forEach((scope, index) => write(step.field, values[index]!, scope))
          break
        }
        case 'disconnect': {
          const path = context.paths.get(step.input)
          if (path !== undefined) actions.push({ kind: 'disconnect', path })
          break
        }
        case 'setMode': break
        case 'addMember': case 'removeMember': case 'clearMembers': {
          const path = context.paths.get(step.group)
          if (path !== undefined) unknown.add(path)
          break
        }
        case 'addNode': {
          const path = context.paths.get(step.to)
          if (path !== undefined) unknown.add(path)
          break
        }
        default:
          for (const scope of scopes) for (const field of writes.fields) write(field, UNKNOWN, scope)
      }
      if (actions.length > 0) {
        previewHost ??= { ...host, commands: coreCommandRegistry([], host.schemaResolverFor?.(doc)) } as ActionHost
        scratch ??= scratchOf(doc, previewHost)
        for (const action of actions) dispatchOn(scratch, invocationsOf(action, scratch.doc, target, undefined, previewHost), undefined)
        view = viewOf(scratch.doc, target, previewHost)!
        context = view.contexts.get(button.prefix)!
      }
    } catch {
      // An uncertain preview cannot decide later lazy branches, but independent reads still matter.
      for (const scope of scopes) for (const field of writes.fields) {
        const path = scope.paths.get(field)
        if (path !== undefined && !view.connectivity.isInputConnected(path)) unknown.add(path)
      }
    }
  }

  if (!other && targets.length > 0 && targets.every(Boolean)) return { enabled: false, reason: ALL_WIRED_MESSAGE }
  return { enabled: true }
}
