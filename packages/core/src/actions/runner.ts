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
import type { DocumentSession } from '../commands/session.js'
import { DocumentStore } from '../commands/store.js'
import type { ControllerMode, GraphDef, Json, NodeData, WorkflowDocument } from '../format/document.js'
import type { LinkEndpoint, PortRef } from '../ids.js'
import { resolveDynamicAddress } from '../format/document.js'
import { Formula, FormulaRefused, UNKNOWN, type FormulaNameKind, type FormulaOutcome, type FormulaValue } from '../mirror/formula.js'
import { constructsOf, rowKind } from '../schema/body.js'
import { isComboValue, normalizeComboOption, normalizedComboOptions, type NormalizedComboOption } from '../schema/combo-options.js'
import type { SchemaResolver } from '../schema/derive-boundary.js'
import {
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
import { integerWidgetValue, numericStepConstraints } from '../schema/numeric-step.js'
import { typesCompatible } from '../schema/type-relations.js'
import { effectiveWidgetDefault } from '../schema/widget-defaults.js'
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
  lookup(request: LookupRequest, signal: AbortSignal): Promise<LookupResult>
  call(request: CallRequest, progress: (fraction: number, text: string) => void, signal: AbortSignal): Promise<CallAnswer>
  /** The chosen option's value, or undefined when the list closed. */
  pick(request: PickRequest, signal: AbortSignal): Promise<string | number | boolean | undefined>
  /** The applied rows by id, or undefined on Cancel. */
  ask(request: AskRequest, signal: AbortSignal): Promise<Readonly<Record<string, Json>> | undefined>
  /** The chosen asset value, or undefined when the picker closed. */
  openPicker(field: ElaboratedInput, signal: AbortSignal): Promise<Json | undefined>
  /** The field's host editor, or undefined when it has none yet. */
  editorFor(field: ElaboratedInput): ((signal: AbortSignal) => Promise<Json | undefined>) | undefined
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
  readonly why: 'wired' | 'edited'
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

class Refusal extends Error {}
const refuse = (message: string): never => {
  throw new Refusal(message)
}

class Cancelled extends Error {}

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

/** An answer's value as steps read it: integral JSON numbers are whole numbers. */
function answerOf(raw: unknown): unknown {
  if (typeof raw === 'number') return Number.isInteger(raw) ? BigInt(raw) : raw
  if (Array.isArray(raw)) return raw.map(answerOf)
  return raw
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
      if (limits.min !== undefined && value < limits.min) return refuse(`${name} must be at least ${limits.min}; the button gave ${value}.`)
      if (limits.max !== undefined && value > limits.max) return refuse(`${name} must be at most ${limits.max}; the button gave ${value}.`)
      if ((value - (limits.min ?? 0n)) % limits.step !== 0n) {
        return refuse(`${name} moves in steps of ${limits.step}; the button gave ${value}.`)
      }
      return integerWidgetValue(value)
    }
    case 'FLOAT': {
      const number = typeof value === 'bigint' ? Number(value) : value
      if (typeof number !== 'number' || !Number.isFinite(number)) return refuse(`${name} takes a number; the button gave ${display(value)}.`)
      const limits = numericStepConstraints(widget)
      if (limits.integer) return refuse(`${name} takes a whole number.`)
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

/** The declared default a Reset writes; explicit, as the node's own reset writes it. */
function defaultValueOf(field: ElaboratedInput, name: string): Json {
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
}

function viewOf(doc: WorkflowDocument, target: StepPlace, host: ActionHost): View | undefined {
  const graph = doc.graphs[target.graphId]
  const node = graph?.nodes[target.nodeId]
  const schema = node && host.schemaOf(doc, target.graphId, node)
  if (graph === undefined || node === undefined || schema === undefined) return undefined
  const connectivity = buildGraphConnectivity(graph)(node.id)
  const contexts = new Map<string, FormulaContext>()
  const elaborated = elaborateInterface(schema, node, connectivity, { nodeId: node.id, formulaContexts: contexts })
  return { doc, graph, node, schema, elaborated, contexts, connectivity }
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
  ]
  return ends.some((end) => 'node' in end && 'port' in end && end.node === view.node.id && under(String(end.port)))
}

// ---------------------------------------------------------------------------
// What a press stages

type Action =
  | { readonly kind: 'value'; readonly path: string; readonly value: Json }
  | { readonly kind: 'mode'; readonly path: string; readonly mode: ControllerMode }
  | {
      readonly kind: 'materialize'
      readonly frames: readonly MaterializeFrame[]
      /** The member an AddMember step adds, which must still be new at the commit. */
      readonly adds?: { readonly group: string; readonly member: string }
    }
  | { readonly kind: 'removeMember'; readonly group: string; readonly member: string }
  | { readonly kind: 'disconnect'; readonly path: string }
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
    }

function invocationsOf(action: Action, doc: WorkflowDocument, target: StepPlace, actor: string | undefined): CommandInvocation[] {
  const { graphId, nodeId } = target
  switch (action.kind) {
    case 'value':
      return [{ command: 'node.setValue', params: { graphId, nodeId, inputId: action.path, value: action.value } }]
    case 'mode':
      return [{ command: 'node.setController', params: { graphId, nodeId, inputId: action.path, mode: action.mode } }]
    case 'materialize':
      return [{ command: 'dynamic.materialize', params: { graphId, nodeId, frames: action.frames as unknown as Json } }]
    case 'removeMember':
      return [{ command: 'dynamic.removeMember', params: { graphId, nodeId, construct: action.group, member: action.member } }]
    case 'disconnect': {
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
      return [
        { command: 'node.add', params: { graphId, type: action.type, position: action.position, values: action.values } },
        ...(action.between === undefined ? [] : [{
          command: 'link.connect',
          params: { graphId, from: action.between.from as unknown as Json, to: { node: id, port: action.between.input } },
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

/** Apply `actions` to the scratch store; a refusal names the first diagnostic. */
function stageOn(store: DocumentStore, actions: readonly Action[], target: StepPlace, actor: string | undefined): void {
  for (const action of actions) dispatchOn(store, invocationsOf(action, store.doc, target, actor), actor)
}

// ---------------------------------------------------------------------------
// Formulas, with the locals of a Pick or an Ask

interface Locals {
  readonly kinds: Map<string, FormulaNameKind>
  readonly values: Map<string, Value>
}

function evaluateIn(context: FormulaContext, locals: Locals, text: string): FormulaOutcome {
  const scope = { ...context.scope, names: new Map([...context.scope.names, ...locals.kinds]) }
  const values = { ...context.values, values: new Map([...(context.values.values ?? []), ...locals.values]) }
  try {
    return Formula.parse(text, scope).evaluate(values)
  } catch (error) {
    if (error instanceof FormulaRefused) return { kind: 'failed', reason: error.message }
    throw error
  }
}

/** The names a formula reads that are wired inputs with no known value. */
function unknownWired(context: FormulaContext, locals: Locals, text: string): string[] {
  try {
    const scope = { ...context.scope, names: new Map([...context.scope.names, ...locals.kinds]) }
    const formula = Formula.parse(text, scope)
    if (formula.evaluate({ ...context.values, values: new Map([...(context.values.values ?? []), ...locals.values]) }).kind !== 'unknown') return []
    return [...formula.uses().names].filter((name) => context.values.linked?.get(name) === true)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// One press

class Press {
  readonly locals: Locals = { kinds: new Map(), values: new Map() }
  readonly actions: Action[] = []
  readonly notes: string[] = []
  readonly skipped: Skip[] = []
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
  }

  // -- staging ---------------------------------------------------------------

  stage(actions: readonly Action[]): void {
    stageOn(this.store, actions, this.target, this.session.allocationActor)
    this.actions.push(...actions)
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
  read(name: string, context: FormulaContext = this.context): Value {
    const value = this.locals.values.get(name) ?? context.values.values?.get(name)
    if (value === undefined || value === UNKNOWN) return refuse(`Needs ${name}, which is not known until a run.`)
    return value
  }

  formula(text: string, context: FormulaContext = this.context): Value {
    const outcome = evaluateIn(context, this.locals, text)
    if (outcome.kind === 'value') return outcome.value
    if (outcome.kind === 'failed') return refuse(`A formula of this button failed: ${outcome.reason}`)
    const needs = unknownWired(context, this.locals, text)
    return refuse(needs.length > 0 ? `Needs ${needs[0]}, which is not known until a run.` : 'A value this button needs is not known yet.')
  }

  async argument(argument: Argument, context: FormulaContext = this.context): Promise<CallArg> {
    if (typeof argument !== 'string') return this.formula(argument.formula, context) as CallArg
    if (context.scope.names.get(argument) === 'opaque' || context.scope.assets?.has(argument)) {
      const path = this.pathOf(argument, context)
      if (this.wired(path)) return refuse(`Needs ${argument}, which is not known until a run.`)
      return (this.view.node.values[path] ?? null) as CallArg
    }
    return this.read(argument, context) as CallArg
  }

  async lookup(name: string, args: readonly Argument[], use: 'options' | 'value', context = this.context): Promise<{ request: LookupRequest; result: LookupResult }> {
    if (this.options.noWait === true) return refuse(NO_WAIT_MESSAGE)
    const request: LookupRequest = {
      nodeType: this.view.node.type,
      node: this.target.occurrence ?? this.target.nodeId,
      function: name,
      args: await Promise.all(args.map((item) => this.argument(item, context))),
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
    return answerOf(result.value)
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
        const current = this.read(step.field)
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
        if (this.wired(a.path) || this.wired(b.path)) {
          // A wired field's value is not known, so neither side can take the other's.
          this.skip(a.path)
          this.skip(b.path)
          return
        }
        const valueA = this.read(step.a)
        const valueB = this.read(step.b)
        this.stage([...this.write(step.a, valueB), ...this.write(step.b, valueA)])
        return
      }
      case 'append': {
        const { path } = this.fieldOf(step.field)
        if (this.wired(path)) return this.skip(path)
        const current = this.read(step.field)
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
          const raw = this.formula(step.which.formula)
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
        else value = await this.wait((this.host.editorFor(field) ?? refuse(NO_EDITOR_MESSAGE))(this.signal))
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
    const random = (): number => {
      const drawn = this.host.random()
      return drawn >= 0 && drawn < 1 ? drawn : 0
    }
    let value: unknown
    switch (widget?.widgetType) {
      case 'INT': {
        const limits = numericStepConstraints(widget)
        if (!limits.integer) return
        const lowest = typeof low === 'bigint' ? low : limits.min
        const highest = typeof high === 'bigint' ? high : limits.max
        if (lowest === undefined || highest === undefined || lowest > highest) {
          return refuse(`Randomize needs a lowest and a highest value for ${step.field}.`)
        }
        const base = limits.min ?? 0n
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
        const lowest = typeof low === 'number' || typeof low === 'bigint' ? Number(low) : limits.min
        const highest = typeof high === 'number' || typeof high === 'bigint' ? Number(high) : limits.max
        if (!Number.isFinite(lowest) || !Number.isFinite(highest) || lowest > highest) {
          return refuse(`Randomize needs a lowest and a highest value for ${step.field}.`)
        }
        value = lowest + random() * (highest - lowest)
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
    const driver = Object.values(graph.links).find((link) => 'port' in link.to && link.to.node === this.target.nodeId && link.to.port === path)
    let between: { from: LinkEndpoint; input: string } | undefined
    if (driver !== undefined && 'port' in driver.from) {
      const from = driver.from as PortRef
      const source = graph.nodes[from.node]
      const sourceSchema = source && this.host.schemaOf(this.view.doc, this.target.graphId, source)
      const sourceType = source && sourceSchema && elabOutputsOf(elaborateInterface(sourceSchema, source, buildGraphConnectivity(graph)(source.id), { promoteGhosts: false }))
        .find((candidate) => candidate.address.port === from.port)?.spec.type
      const input = sourceType && elabInputsOf(added).find((candidate) => typesCompatible(sourceType, candidate.spec.type))
      if (input) between = { from, input: valueKeyOf(input) }
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
      args: await Promise.all(step.args.map((item) => this.argument(item, context))),
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
        actions.push(...this.write(key, answerOf(raw)))
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
      const view = viewOf(live.doc, this.target, this.host) ?? refuse('The node was removed while the button waited.')
      if (action.kind === 'value' || action.kind === 'mode') {
        if (edited.has(`${action.kind === 'value' ? 'values' : 'controllers'}:${action.path}`)) {
          if (this.options.strict === true) return refuse(this.options.staleMessage ?? STALE_MESSAGE)
          this.skip(action.path, 'edited')
          continue
        }
        if (view.connectivity.isInputConnected(action.path)) {
          this.skip(action.path)
          continue
        }
        if (resolveDynamicAddress({ port: action.path }, view.node.dynamic).kind === 'missing') {
          return refuse('A member this button sets was removed while it waited.')
        }
        // A choice switched to another option, or a group or member gone, takes the field away.
        if (inputAt(view, action.path) === undefined) return refuse('A field this button sets is no longer on the node.')
        written.add(action.path)
      } else if (action.kind === 'materialize') {
        if (action.adds !== undefined && view.node.dynamic?.[action.adds.group]?.members?.includes(action.adds.member) === true) {
          return refuse('The group changed while the button waited.')
        }
      } else if (action.kind === 'addNode') {
        const graph = live.doc.graphs[this.target.graphId]!
        const driver = Object.values(graph.links).find((link) => 'port' in link.to && link.to.node === this.target.nodeId && link.to.port === action.to)
        const connected = view.connectivity.isInputConnected(action.to)
        if (JSON.stringify(driver?.from) !== JSON.stringify(action.source) || (connected && driver === undefined)) {
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
      const built = invocationsOf(action, live.doc, this.target, this.session.allocationActor)
      if (built.length === 0) continue
      dispatchOn(live, built, this.session.allocationActor)
      invocations.push(...built)
    }
    return { invocations, written: written.size }
  }

  /** The value or mode this press leaves on each field it sets, keyed by node and field. */
  finalWrites(): Map<string, string> {
    const writes = new Map<string, string>()
    for (const action of this.actions) {
      if (action.kind === 'value') writes.set(`${this.target.graphId} ${this.target.nodeId} values:${action.path}`, JSON.stringify(action.value))
      if (action.kind === 'mode') writes.set(`${this.target.graphId} ${this.target.nodeId} controllers:${action.path}`, JSON.stringify(action.mode))
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

function summary(changed: number, skipped: readonly Skip[], notes: readonly string[]): string | undefined {
  if (skipped.length === 0 && notes.length === 0) return undefined
  const parts: string[] = []
  if (skipped.length > 0) {
    if (changed > 0) parts.push(`Set ${changed} ${changed === 1 ? 'field' : 'fields'}.`)
    parts.push(...skipped.map(({ id, why }) => why === 'edited'
      ? `${id} was changed while the button waited and keeps that value.`
      : `${id} has a wire and was left as it is.`))
  }
  parts.push(...notes)
  return parts.join(' ')
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
  const { graphId, nodeId, occurrence } = target
  return run(session, [{ graphId, nodeId, ...(occurrence !== undefined ? { occurrence } : {}), prefix: button.prefix, steps: decodeSteps(button.spec.steps) }], host, options)
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

const failedOutcome = (message: string, notes: readonly string[] = []): PressOutcome =>
  ({ kind: 'failed', message: `Nothing was changed. ${message}`, warning: true, skipped: [], notes })

async function run(session: DocumentSession, parts: readonly StepPart[], host: ActionHost, options: PressOptions): Promise<PressOutcome> {
  const stale = options.staleMessage ?? STALE_MESSAGE
  if (options.insideOnly === true || options.noWait === true) {
    const steps = parts.flatMap((part) => part.steps)
    if (steps.some((step) => isOutsideStep(step) || ASKS_THE_USER.has(step.step))) return failedOutcome(INSIDE_ONLY_MESSAGE)
    if (options.noWait === true && steps.some((step) => step.step === 'call')) return failedOutcome(NO_WAIT_MESSAGE)
  }
  if (options.unchanged?.(session.doc) === false) return failedOutcome(stale)

  // Which fields of each node the run touches change while it waits, and whether a node goes.
  const placeKey = (place: StepPlace): string => `${place.graphId} ${place.nodeId}`
  const nodeOf = (doc: WorkflowDocument, place: StepPlace): NodeData | undefined => doc.graphs[place.graphId]?.nodes[place.nodeId]
  const places = new Map(parts.map((part) => [placeKey(part), part]))
  const edited = new Map([...places.keys()].map((key) => [key, new Set<string>()]))
  const before = new Map([...places].map(([key, place]) => [key, nodeOf(session.doc, place)]))
  let gone = false
  const stop = session.onOp(() => {
    for (const [key, place] of places) {
      const was = before.get(key)
      const now = nodeOf(session.doc, place)
      if (was === undefined || now === undefined) {
        gone = true
        continue
      }
      for (const store of ['values', 'controllers'] as const) {
        const old = was[store] ?? {}
        const next = now[store] ?? {}
        for (const field of new Set([...Object.keys(old), ...Object.keys(next)])) {
          if (JSON.stringify((old as Record<string, unknown>)[field]) !== JSON.stringify((next as Record<string, unknown>)[field])) edited.get(key)!.add(`${store}:${field}`)
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
        if (writes.has(field) && writes.get(field) !== value) refuse(options.conflictMessage ?? CONFLICT_MESSAGE)
        writes.set(field, value)
      }
    }
    if (options.unchanged?.(session.doc) === false) refuse(stale)
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
    if (error instanceof Refusal) return failedOutcome(error.message, notes)
    return failedOutcome(error instanceof Error && error.message !== '' ? error.message : 'The button could not finish.', notes)
  }

  // The outside steps read the committed document.
  const outsideFailures: string[] = []
  const unsaved: string[] = []
  for (const [index, press] of presses.entries()) {
    const part = parts[index]!
    const committed = viewOf(session.doc, part, host)
    if (committed !== undefined) {
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
    summary(changed, skipped, notes),
  ].filter((part) => part !== undefined).join(' ') || undefined
  if (outsideFailures.length > 0) {
    const kept = lead.length > 0 || presses.some((press) => press.actions.length > 0) ? 'The changes were made. ' : ''
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

/** The fields a step list would set, by name in the button's scope. */
function targetsOf(steps: readonly Step[]): { readonly fields: readonly string[]; readonly other: boolean } {
  const fields: string[] = []
  let other = false
  for (const step of steps) {
    switch (step.step) {
      case 'set': case 'toggle': case 'reset': case 'append': case 'randomize': case 'setMode':
      case 'openPicker': case 'openEditor': case 'pasteImage':
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
export function buttonAvailability(doc: WorkflowDocument, target: PressTarget, host: Pick<ActionHost, 'schemaOf' | 'editorFor'>): ButtonAvailability {
  const view = viewOf(doc, target, host as ActionHost)
  const button = view && buttonOf(view, target)
  const context = button && view.contexts.get(button.prefix)
  if (view === undefined || button === undefined || context === undefined) return { enabled: false, reason: 'This button is not on the node.' }
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

  const wiredName = (name: string): boolean => {
    const path = context.paths.get(name)
    return path !== undefined && view.connectivity.isInputConnected(path)
  }
  for (const step of steps) {
    const texts: string[] = []
    const names: string[] = []
    for (const key of ['value', 'low', 'high', 'options', 'url'] as const) texts.push(...formulasOf((step as Record<string, unknown>)[key] as StepValue | undefined))
    if (step.step === 'addMember' || step.step === 'addNode') for (const value of Object.values(step.values)) texts.push(...formulasOf(value))
    if (step.step === 'removeMember' && typeof step.which === 'object') texts.push(step.which.formula)
    for (const key of ['value', 'low', 'high', 'options', 'url'] as const) {
      const value = (step as Record<string, unknown>)[key] as StepValue | undefined
      if (value?.kind === 'lookup') names.push(...value.args.filter((arg): arg is string => typeof arg === 'string'))
    }
    if (step.step === 'call') {
      for (const arg of step.args) {
        if (typeof arg === 'string') names.push(arg)
        else texts.push(arg.formula)
      }
    }
    if (step.step === 'setEach') continue
    const needed = [...names.filter((name) => !locals.kinds.has(name) && wiredName(name)), ...texts.flatMap((text) => unknownWired(context, locals, text))]
    if (needed.length > 0) return { enabled: false, reason: `Needs ${needed[0]}, which is not known until a run.` }
  }

  const { fields, other } = targetsOf(steps)
  if (!other && fields.length > 0 && fields.every(wiredName)) return { enabled: false, reason: ALL_WIRED_MESSAGE }
  return { enabled: true }
}
