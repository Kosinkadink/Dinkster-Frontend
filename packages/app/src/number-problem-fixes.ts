import { asNodeId, createSignal, diag, t, type Diagnostic, type DocumentSession, type StoredNumberFix } from '@dinkster/core'
import type { AppState, Tab } from './app-state.js'

export interface NumberProblemFix {
  readonly key: string
  readonly offered: StoredNumberFix
  readonly state: 'offered' | 'storing' | 'stale'
  readonly message?: string
}

export function numberProblemFixLabel(fix: NumberProblemFix, message: typeof t = t): string {
  return fix.state === 'storing' ? message('problemFix.storing')
    : fix.state === 'stale' ? message('problemFix.checkAgain')
    : message('problemFix.useNumber', { value: String(fix.offered.after) })
}

const keyOf = (fix: StoredNumberFix): string => JSON.stringify([
  fix.part.graphId, fix.part.instancePath ?? [], fix.part.nodeId, fix.valueKey,
])

/** The box and Problems share one offered snapshot and one in-flight write. */
export class NumberProblemFixes {
  readonly changed = createSignal(0)
  private readonly offers = new WeakMap<DocumentSession, Map<string, NumberProblemFix>>()

  constructor(private readonly app: AppState) {}

  scan(tab: Tab): readonly NumberProblemFix[] {
    const live = this.app.scanTabNumberFixes(tab)
    let offers = this.offers.get(tab.store)
    if (offers === undefined) { offers = new Map(); this.offers.set(tab.store, offers) }
    const keys = new Set(live.map(keyOf))
    for (const key of offers.keys()) if (!keys.has(key) && offers.get(key)?.state !== 'storing') offers.delete(key)
    return live.map((offered) => {
      const key = keyOf(offered)
      const previous = offers.get(key)
      if (previous !== undefined) return previous
      const fix: NumberProblemFix = { key, offered, state: 'offered' }
      offers.set(key, fix)
      return fix
    })
  }

  forProblem(tab: Tab, diagnostic: Diagnostic): NumberProblemFix | undefined {
    const key = diagnostic.data?.['numberFixKey']
    return typeof key === 'string' ? this.offers.get(tab.store)?.get(key) : undefined
  }

  diagnostics(tab: Tab): readonly Diagnostic[] {
    const registry = this.app.registryForTab(tab)
    return this.scan(tab).map((fix) => {
      const { offered } = fix
      const node = tab.store.doc.graphs[offered.part.graphId]?.nodes[offered.part.nodeId]
      const title = node?.title || (node === undefined ? offered.part.nodeId : registry?.resolve(node.type)?.displayName ?? node.type)
      const text = `${offered.label}: ${fix.message ?? t('problemFix.numberOutsideLimits', { value: String(offered.before) })}`
      return diag('warning', 'schema', 'automatic.numberOutsideLimits', `${title}: ${text}`, {
        refs: [{ graphId: offered.part.graphId, nodeId: offered.part.nodeId, valueKey: offered.valueKey, portId: offered.valueKey, direction: 'input' }],
        anchor: { occurrence: { instancePath: (offered.part.instancePath ?? []).map(asNodeId), node: asNodeId(offered.part.nodeId) } },
        data: { numberFixKey: fix.key, nodeMessage: text },
      })
    })
  }

  recheck(tab: Tab, key: string): void {
    const offers = this.offers.get(tab.store)
    if (offers?.get(key)?.state === 'storing') return
    offers?.delete(key)
    this.scan(tab)
    this.changed.update((value) => value + 1)
  }

  async apply(tab: Tab, fixes: readonly NumberProblemFix[]): Promise<void> {
    const offers = this.offers.get(tab.store)
    if (fixes.length === 0 || fixes.some((fix) => fix.state !== 'offered' || offers?.get(fix.key) !== fix)) return
    for (const fix of fixes) offers!.set(fix.key, { ...fix, state: 'storing' })
    this.changed.update((value) => value + 1)
    try {
      const outcome = await this.app.applyNumberFixes(tab, fixes.map((fix) => fix.offered))
      for (const fix of fixes) {
        if (outcome.kind === 'done') offers!.delete(fix.key)
        else offers!.set(fix.key, { ...fix, state: 'stale', message: outcome.message ?? t('problemFix.workflowChanged') })
      }
    } catch (error) {
      for (const fix of fixes) offers!.set(fix.key, { ...fix, state: 'stale', message: String(error) })
    }
    this.changed.update((value) => value + 1)
  }
}
