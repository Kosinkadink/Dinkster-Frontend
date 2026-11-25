/**
 * The canvas side of calling declared lookups: what elaboration reads from a
 * backend's one lookup client, and which calls the nodes on screen ask for.
 * The client shares equal calls and keeps answers; this only decides demand.
 */
import { lookupSitesOf, type AutomaticCall, type AutomaticValueRecord, type ElaborateOptions, type ElaboratedItem, type LookupAnswerState, type LookupCallSpec, type LookupFailure } from '@dinkster/core'
import type { LookupClient } from '@dinkster/client'
import { comboOptions } from './app-view-rows.js'
import type { ComboOption } from './combo-search.js'
import type { RowListLookup, RowListLookupFailure, RowListLookupState } from './editors/InRowListEditor.js'
import type { RowLookups } from './WidgetEditorController.js'

/** What elaboration reads for a lookup call: the answer the client holds, if any. */
export const lookupAnswersOf = (lookups: LookupClient): NonNullable<ElaborateOptions['lookupAnswers']> =>
  (lookup, args) => lookups.entry({ function: lookup, args }) as LookupAnswerState | undefined

/**
 * A run worked out each recorded field again when it was queued. Where it
 * got another value from the call the editor made for the field, that call's
 * kept answer is old, so the row asks again and the next run agrees.
 */
export function recordRunAnswers(lookups: LookupClient, calls: readonly AutomaticCall[], records: readonly AutomaticValueRecord[]): void {
  for (const record of records) {
    if (!record.workedOut) continue
    const call = calls.find((item) => item.runtimeNodeId === record.runtimeNodeId && item.inputId === record.inputId)
    if (call !== undefined) lookups.answerRecorded({ function: call.lookup, args: call.args }, record.value)
  }
}

/** A drawn node: its type (which declares the lookups), a key unique on its backend, and its elaborated rows. */
export interface LookupDemandNode {
  readonly nodeType: string
  readonly node: string
  readonly items: readonly ElaboratedItem[]
  /** The value key of the node's field open for editing. */
  readonly openField?: string
}

/**
 * The calls nodes on screen wait on. Each node's site asks once for its
 * current arguments; when the arguments change, or the node leaves the
 * screen, its demand for the old call is dropped, which cancels that call
 * unless another node still waits for it.
 */
export class LookupDemand {
  private readonly held = new Map<string, { readonly call: string; readonly controller: AbortController }>()

  constructor(private readonly lookups: LookupClient) {}

  /** Ask for what `nodes` show and have no current answer for, and drop every other demand. */
  show(nodes: readonly LookupDemandNode[]): void {
    const wanted = new Set<string>()
    for (const { nodeType, node, items, openField } of nodes) {
      lookupSitesOf(items, openField).forEach((site, index) => {
        const key = `${node}\u0000${index}`
        const call = { nodeType, node, function: site.call.lookup, args: site.call.args }
        const callKey = JSON.stringify([site.call.lookup, site.call.args])
        wanted.add(key)
        const previous = this.held.get(key)
        // A demand is held only while its call is under way; asking again
        // would cancel the call that is to replace an old answer.
        if (previous?.call === callKey) return
        previous?.controller.abort()
        this.held.delete(key)
        if (this.lookups.entry(call) !== undefined && !this.lookups.isOld(call)) return
        const controller = new AbortController()
        this.held.set(key, { call: callKey, controller })
        this.lookups.request(call, { accept: site.accepts, signal: controller.signal }).then(
          () => { if (this.held.get(key)?.controller === controller) this.held.delete(key) },
          () => { if (this.held.get(key)?.controller === controller) this.held.delete(key) },
        )
      })
    }
    for (const [key, demand] of this.held) {
      if (wanted.has(key)) continue
      demand.controller.abort()
      this.held.delete(key)
    }
  }

  /** Try again or Refresh: ask for `call` again even when an answer is kept. */
  refresh(nodeType: string, node: string, call: LookupCallSpec, accepts?: (answer: unknown) => boolean): void {
    void this.lookups.request(
      { nodeType, node, function: call.lookup, args: call.args },
      { refresh: true, ...(accepts === undefined ? {} : { accept: accepts }) },
    ).catch(() => undefined)
  }

  dispose(): void {
    for (const demand of this.held.values()) demand.controller.abort()
    this.held.clear()
  }
}

const LIST_FAILURES: Readonly<Partial<Record<LookupFailure, RowListLookupFailure>>> = {
  failed: 'failed',
  timeout: 'timeout',
  'wrong-shape': 'wrong-shape',
  offline: 'offline',
}

/** What the in-row list shows for a row whose options come from a lookup. */
export function rowListLookupOf(lookups: RowLookups): RowListLookup | undefined {
  if (lookups.current()?.looked.options === undefined) return undefined
  return {
    state: (): RowListLookupState => {
      const current = lookups.current()
      const state = current?.looked.options
      if (current === undefined || state === undefined) return { kind: 'loading' }
      const options = (): readonly ComboOption[] => comboOptions(current.spec)
      switch (state.state) {
        case 'off': return { kind: 'off' }
        case 'waiting': return { kind: 'waiting', input: state.input }
        case 'loading': return { kind: 'loading' }
        case 'ready': return { kind: 'ready', options: options(), refreshing: state.refreshing === true }
        case 'stale': return { kind: 'stale', options: options(), refreshing: false }
        case 'paused': return state.kept ? { kind: 'paused', options: options() } : { kind: 'paused' }
        case 'unavailable':
          // A file the host has not checked yet is waited for, with no Try again.
          return state.reason === 'file-unchecked'
            ? { kind: 'waiting', input: 'the file', check: true }
            : { kind: 'unavailable', reason: LIST_FAILURES[state.reason] ?? 'failed', refreshing: false }
      }
    },
    refresh: () => lookups.refresh('options'),
  }
}
