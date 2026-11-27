/**
 * Board commands and the store that applies them with undo and redo.
 *
 * Every change is a serializable command planned into self-inverting patch
 * ops against the current board, then validated as a whole board before it
 * commits, so a command can never leave a board that would fail to load.
 */

import { createSignal, type ReadonlySignal } from '../reactive/signal.js'
import { diag, type Diagnostic } from '../diagnostics.js'
import type { ControllerMode, Json, JsonObject } from '../format/document.js'
import { applyOwnedOps, invertOps, type PatchOp } from '../commands/patch.js'
import { jsonSameValue } from '../commands/store.js'
import { exposedKey, type ExposedParameter } from '../format/exposed.js'
import { ownJson } from '../format/json.js'
import {
  BOARD_MAX_ITEMS,
  boardDropSection,
  loadBoard,
  readBoardItem,
  rectContains,
  sectionMembers,
  type BoardDocument,
  type BoardItem,
  type BoardRect,
} from './model.js'

/** An item to add; the store gives it an id when it has none. */
export type BoardItemInput = BoardItem extends infer T ? T extends BoardItem ? Omit<T, 'id'> & { readonly id?: string } : never : never

export type BoardCommandInvocation =
  | { readonly command: 'board.item.add'; readonly params: { readonly items: readonly BoardItemInput[] } }
  | { readonly command: 'board.run.add'; readonly params: {
      readonly job: string
      readonly card: string
      readonly items: readonly BoardItemInput[]
    } }
  | { readonly command: 'board.item.move'; readonly params: { readonly moves: readonly { readonly id: string; readonly x: number; readonly y: number }[] } }
  | { readonly command: 'board.item.resize'; readonly params: { readonly id: string; readonly rect: BoardRect } }
  | { readonly command: 'board.card.fit'; readonly params: { readonly id: string; readonly height: number } }
  | { readonly command: 'board.item.remove'; readonly params: { readonly ids: readonly string[] } }
  | { readonly command: 'board.note.edit'; readonly params: { readonly id: string; readonly text: string } }
  | { readonly command: 'board.section.rename'; readonly params: { readonly id: string; readonly name: string } }
  | { readonly command: 'board.card.inputs'; readonly params: { readonly id: string; readonly values: JsonObject } }
  | { readonly command: 'board.card.controller'; readonly params: {
      readonly id: string
      readonly key: string
      readonly mode?: ControllerMode
    } }
  | { readonly command: 'board.card.input'; readonly params: {
      readonly id: string
      readonly input: Pick<ExposedParameter, 'graphId' | 'nodeId' | 'inputId'>
      /** Omit to restore the source's value and controller mode; null is an explicit value. */
      readonly value?: Json
    } }

export type BoardDispatchOutcome =
  | { readonly ok: true; readonly document: BoardDocument; readonly revision: number; readonly created: readonly string[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }

export interface BoardTransaction {
  readonly revision: number
  readonly command: BoardCommandInvocation['command'] | 'board.undo' | 'board.redo'
  readonly forward: readonly PatchOp[]
  readonly inverse: readonly PatchOp[]
}

/** Document editing shared by local stores and collaborative Board sessions. */
export interface BoardSession {
  readonly doc: BoardDocument
  readonly document: ReadonlySignal<BoardDocument>
  readonly revision: number
  readonly canUndo: boolean
  readonly canRedo: boolean
  dispatch(invocation: BoardCommandInvocation): BoardDispatchOutcome
  undo(): boolean
  redo(): boolean
}

type Refusal = Extract<BoardDispatchOutcome, { readonly ok: false }>

const refuse = (code: string, message: string): Refusal =>
  ({ ok: false, diagnostics: [diag('error', 'command', `board.${code}`, message)] })

const owned = (value: unknown): Json => {
  const result = ownJson(value, { undefinedProps: 'reject' })
  if (!result.ok) throw new Error(result.reason)
  return result.value
}

/** The smallest unused `<kind>-<n>` id. */
function nextId(kind: string, taken: ReadonlySet<string>): string {
  let n = 1
  while (taken.has(`${kind}-${n}`)) n += 1
  return `${kind}-${n}`
}

/**
 * Plan one command into forward patch ops against `board`. Moving a section
 * moves its stored members, without adopting items at its destination.
 */
export function planBoardCommand(
  board: BoardDocument,
  invocation: BoardCommandInvocation,
): { readonly ok: true; readonly forward: readonly PatchOp[]; readonly created: readonly string[] } | Refusal {
  const missing = (id: string): Refusal => refuse('item.missing', `no item '${id}' on this board`)
  switch (invocation.command) {
    case 'board.run.add': {
      const { job, card, items } = invocation.params
      if (Object.hasOwn(board.runs ?? {}, job)) return { ok: true, forward: [], created: [] }
      const source = board.items[card]
      if (source?.kind !== 'workflow' && source?.kind !== 'blueprint') return missing(card)
      if (items.some((item) => item.kind !== 'picture' && item.kind !== 'video' && item.kind !== 'sound'))
        return refuse('run.invalid', 'a run can deliver only media items')
      const addition = items.length === 0 ? { ok: true as const, forward: [], created: [] }
        : planBoardCommand(board, { command: 'board.item.add', params: { items } })
      if (!addition.ok) return addition
      const forward: PatchOp[] = [...addition.forward]
      if (board.runs === undefined) forward.push({ op: 'add', path: ['runs'], value: {} })
      forward.push({ op: 'add', path: ['runs', job], value: { card, items: [...addition.created] } })
      return { ok: true, forward, created: addition.created }
    }
    case 'board.item.add': {
      const { items } = invocation.params
      if (items.length === 0) return refuse('add.empty', 'nothing to add')
      if (board.order.length + items.length > BOARD_MAX_ITEMS) return refuse('items.tooMany', `a board holds at most ${BOARD_MAX_ITEMS} items`)
      const taken = new Set(board.order)
      const ops: PatchOp[] = []
      const created: string[] = []
      for (const input of items) {
        const id = input.id ?? nextId(input.kind, taken)
        if (taken.has(id)) return refuse('item.duplicate', `an item '${id}' is already on this board`)
        taken.add(id)
        const item = readBoardItem(id, owned({ ...input, id }))
        if ('severity' in item) return { ok: false, diagnostics: [item] }
        ops.push({ op: 'add', path: ['items', id], value: owned(item) })
        created.push(id)
      }
      ops.push({ op: 'replace', path: ['order'], value: owned([...board.order, ...created]), oldValue: board.order as unknown as Json })
      const next = applyOwnedOps(board as unknown as Json, ops) as unknown as BoardDocument
      const newSections = created.filter((id) => next.items[id]!.kind === 'section')
      for (const id of next.order) {
        const item = next.items[id]!
        const parent = boardDropSection(next, item, item.rect, created.includes(id) ? next.order : newSections)
        if (!created.includes(id) && item.sectionId !== undefined && parent !== undefined && rectContains(next.items[parent]!.rect, next.items[item.sectionId]!.rect)) continue
        if (parent !== undefined) ops.push(...membershipOps(item, parent))
      }
      return { ok: true, forward: ops, created }
    }
    case 'board.item.move': {
      const { moves } = invocation.params
      const named = new Set(moves.map((move) => move.id))
      const targets = new Map<string, { readonly x: number; readonly y: number }>()
      for (const move of moves) {
        const item = board.items[move.id]
        if (item === undefined) return missing(move.id)
        targets.set(move.id, { x: move.x, y: move.y })
        if (item.kind !== 'section') continue
        const dx = move.x - item.rect.x
        const dy = move.y - item.rect.y
        for (const member of sectionMembers(board, move.id)) {
          if (named.has(member) || targets.has(member)) continue
          const rect = board.items[member]!.rect
          targets.set(member, { x: rect.x + dx, y: rect.y + dy })
        }
      }
      const ops: PatchOp[] = []
      for (const [id, to] of targets) {
        const rect = board.items[id]!.rect
        if (rect.x === to.x && rect.y === to.y) continue
        ops.push({ op: 'replace', path: ['items', id, 'rect'], value: owned({ ...rect, x: to.x, y: to.y }), oldValue: rect as unknown as Json })
      }
      if (ops.length === 0) return refuse('move.none', 'nothing moved')
      const next = applyOwnedOps(board as unknown as Json, ops) as unknown as BoardDocument
      for (const move of moves) {
        const item = next.items[move.id]!
        ops.push(...membershipOps(item, boardDropSection(next, item, item.rect)))
      }
      return { ok: true, forward: ops, created: [] }
    }
    case 'board.card.fit': {
      const item = board.items[invocation.params.id]
      if (item === undefined) return missing(invocation.params.id)
      if ((item.kind !== 'workflow' && item.kind !== 'blueprint') || item.autoSize !== true)
        return refuse('fit.manual', 'only automatically sized cards can refit')
      const height = Math.min(480, Math.ceil(invocation.params.height))
      if (height === item.rect.height) return refuse('edit.none', 'the card already fits its controls')
      const rect = { ...item.rect, height }
      if (Object.values(board.items).some((other) => other.id !== item.id && other.kind !== 'section' &&
        rect.x < other.rect.x + other.rect.width && rect.x + rect.width > other.rect.x &&
        rect.y < other.rect.y + other.rect.height && rect.y + rect.height > other.rect.y))
        return refuse('fit.occupied', 'the fitted card would overlap another Board item')
      return { ok: true, created: [], forward: [{ op: 'replace', path: ['items', item.id, 'rect'], value: owned(rect), oldValue: item.rect as unknown as Json }] }
    }
    case 'board.item.resize': {
      const item = board.items[invocation.params.id]
      if (item === undefined) return missing(invocation.params.id)
      const rect = owned(invocation.params.rect)
      const forward: PatchOp[] = [{ op: 'replace', path: ['items', item.id, 'rect'], value: rect, oldValue: item.rect as unknown as Json }]
      if ((item.kind === 'workflow' || item.kind === 'blueprint') && item.autoSize === true)
        forward.push({ op: 'replace', path: ['items', item.id, 'autoSize'], value: false, oldValue: true })
      return { ok: true, created: [], forward }
    }
    case 'board.item.remove': {
      const ids = new Set(invocation.params.ids)
      if (ids.size === 0) return refuse('remove.empty', 'nothing to remove')
      const ops: PatchOp[] = []
      for (const id of ids) {
        const item = board.items[id]
        if (item === undefined) return missing(id)
        ops.push({ op: 'remove', path: ['items', id], oldValue: item as unknown as Json })
      }
      for (const id of board.order) {
        const item = board.items[id]!
        if (!ids.has(id) && item.sectionId !== undefined && ids.has(item.sectionId)) ops.push(...membershipOps(item, undefined))
      }
      ops.push({ op: 'replace', path: ['order'], value: owned(board.order.filter((id) => !ids.has(id))), oldValue: board.order as unknown as Json })
      return { ok: true, forward: ops, created: [] }
    }
    case 'board.note.edit': {
      const item = board.items[invocation.params.id]
      if (item === undefined) return missing(invocation.params.id)
      if (item.kind !== 'note') return refuse('item.kind', `'${item.id}' is not a note`)
      if (item.text === invocation.params.text) return refuse('edit.none', 'the note already says that')
      return { ok: true, created: [], forward: [{ op: 'replace', path: ['items', item.id, 'text'], value: invocation.params.text, oldValue: item.text }] }
    }
    case 'board.section.rename': {
      const item = board.items[invocation.params.id]
      if (item === undefined) return missing(invocation.params.id)
      if (item.kind !== 'section') return refuse('item.kind', `'${item.id}' is not a section`)
      if (item.name === invocation.params.name) return refuse('edit.none', 'the section already has that name')
      return { ok: true, created: [], forward: [{ op: 'replace', path: ['items', item.id, 'name'], value: invocation.params.name, oldValue: item.name }] }
    }
    case 'board.card.inputs': {
      const { id, values } = invocation.params
      const item = board.items[id]
      if (item === undefined) return missing(id)
      if (item.kind !== 'workflow' && item.kind !== 'blueprint') return refuse('item.kind', `'${id}' is not a workflow or blueprint card`)
      if (jsonSameValue(item.values, values)) return refuse('edit.none', 'the card already has those input values')
      return { ok: true, created: [], forward: [{ op: 'replace', path: ['items', id, 'values'], value: owned(values), oldValue: item.values }] }
    }
    case 'board.card.controller': {
      const { id, key, mode } = invocation.params
      const item = board.items[id]
      if (item === undefined) return missing(id)
      if (item.kind !== 'workflow' && item.kind !== 'blueprint') return refuse('item.kind', `'${id}' is not a workflow or blueprint card`)
      if (typeof key !== 'string' || key.length === 0) return refuse('input.invalid', 'card controller needs an input key')
      const previous = item.controllers?.[key]
      if (previous === mode) return refuse('edit.none', 'the card already has that controller mode')
      const path = ['items', id, 'controllers', key]
      const forward: PatchOp[] = item.controllers === undefined
        ? [{ op: 'add', path: ['items', id, 'controllers'], value: {} }] : []
      forward.push(mode === undefined ? { op: 'remove', path, oldValue: previous! }
        : previous === undefined ? { op: 'add', path, value: mode } : { op: 'replace', path, value: mode, oldValue: previous })
      return { ok: true, created: [], forward }
    }
    case 'board.card.input': {
      const { id, input, value } = invocation.params
      const item = board.items[id]
      if (item === undefined) return missing(id)
      if (item.kind !== 'workflow' && item.kind !== 'blueprint') return refuse('item.kind', `'${id}' is not a workflow or blueprint card`)
      if (![input.graphId, input.nodeId, input.inputId].every((part) => typeof part === 'string' && part.length > 0)) return refuse('input.invalid', 'card inputs need graph, node and input ids')
      const key = exposedKey(input)
      const previous = item.values[key]
      const resetMode = value === undefined && item.controllers?.[key] !== undefined
      if (jsonSameValue(previous, value) && !resetMode) return refuse('edit.none', 'the card already has that input value')
      const path = ['items', id, 'values', key]
      const forward: PatchOp[] = jsonSameValue(previous, value) ? [] : [value === undefined
        ? { op: 'remove', path, oldValue: previous! } : previous === undefined
          ? { op: 'add', path, value: owned(value) } : { op: 'replace', path, value: owned(value), oldValue: previous }]
      if (resetMode) forward.push({ op: 'remove', path: ['items', id, 'controllers', key], oldValue: item.controllers![key]! })
      return { ok: true, created: [], forward }
    }
    default:
      return refuse('command.unknown', `unknown board command '${String((invocation as { readonly command?: unknown }).command)}'`)
  }
}

function membershipOps(item: BoardItem, sectionId: string | undefined): PatchOp[] {
  if (item.sectionId === sectionId) return []
  const path = ['items', item.id, 'sectionId']
  if (sectionId === undefined) return [{ op: 'remove', path, oldValue: item.sectionId! }]
  return item.sectionId === undefined
    ? [{ op: 'add', path, value: sectionId }]
    : [{ op: 'replace', path, value: sectionId, oldValue: item.sectionId }]
}

interface HistoryEntry {
  readonly forward: readonly PatchOp[]
  readonly inverse: readonly PatchOp[]
}

/** Delivery receipts survive undo; only the delivered items are editable history. */
export function boardUndoableOps(operations: readonly PatchOp[]): readonly PatchOp[] {
  return operations.filter((operation) => operation.path[0] !== 'runs')
}

export class BoardStore implements BoardSession {
  private current: BoardDocument
  private currentRevision = 0
  private readonly undoStack: HistoryEntry[] = []
  private readonly redoStack: HistoryEntry[] = []
  private readonly listeners = new Set<(transaction: BoardTransaction) => void>()
  private readonly signal

  constructor(initial: unknown, private readonly maxUndo = 200) {
    const loaded = loadBoard(initial)
    if (loaded.document === undefined) throw new Error(loaded.diagnostics[0]?.message ?? 'initial board is invalid')
    this.current = loaded.document
    this.signal = createSignal(this.current)
  }

  get doc(): BoardDocument { return this.current }
  get document(): ReadonlySignal<BoardDocument> { return this.signal }
  get revision(): number { return this.currentRevision }
  get canUndo(): boolean { return this.undoStack.length > 0 }
  get canRedo(): boolean { return this.redoStack.length > 0 }

  dispatch(invocation: BoardCommandInvocation): BoardDispatchOutcome {
    const plan = planBoardCommand(this.current, invocation)
    if (!plan.ok) return plan
    if (invocation.command === 'board.run.add' && plan.forward.length === 0)
      return { ok: true, document: this.current, revision: this.currentRevision, created: [] }
    const next = this.apply(plan.forward)
    if (!next.ok) return next
    const forward = boardUndoableOps(plan.forward)
    if (invocation.command !== 'board.run.add' || forward.length > 0) {
      this.undoStack.push({ forward, inverse: invertOps(forward) })
      if (this.undoStack.length > this.maxUndo) this.undoStack.shift()
      this.redoStack.length = 0
    }
    const revision = this.commit(next.document, invocation.command, plan.forward)
    return { ok: true, document: next.document, revision, created: plan.created }
  }

  undo(): boolean {
    const entry = this.undoStack.at(-1)
    if (entry === undefined) return false
    const next = this.apply(entry.inverse)
    if (!next.ok) return false
    this.undoStack.pop()
    this.redoStack.push(entry)
    this.commit(next.document, 'board.undo', entry.inverse)
    return true
  }

  redo(): boolean {
    const entry = this.redoStack.at(-1)
    if (entry === undefined) return false
    const next = this.apply(entry.forward)
    if (!next.ok) return false
    this.redoStack.pop()
    this.undoStack.push(entry)
    this.commit(next.document, 'board.redo', entry.forward)
    return true
  }

  onTransaction(listener: (transaction: BoardTransaction) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private apply(ops: readonly PatchOp[]): { readonly ok: true; readonly document: BoardDocument } | Refusal {
    const loaded = loadBoard(applyOwnedOps(this.current as unknown as Json, ops))
    return loaded.document === undefined ? { ok: false, diagnostics: loaded.diagnostics } : { ok: true, document: loaded.document }
  }

  private commit(document: BoardDocument, command: BoardTransaction['command'], forward: readonly PatchOp[]): number {
    this.current = document
    this.currentRevision += 1
    this.signal.set(document)
    const transaction: BoardTransaction = Object.freeze({ revision: this.currentRevision, command, forward, inverse: invertOps(forward) })
    for (const listener of this.listeners) {
      try {
        listener(transaction)
      } catch (error) {
        console.error('[BoardStore] listener threw:', error)
      }
    }
    return this.currentRevision
  }
}
