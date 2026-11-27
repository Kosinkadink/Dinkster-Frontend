import { asNodeId, createSignal, diag, isOutsideStep, ruleProblemRefs, t, type Diagnostic, type DocumentSession, type StoredProblemFix } from '@dinkster/core'
import type { AppState, Tab } from './app-state.js'

export interface ProblemFix {
  readonly key: string
  readonly offered: StoredProblemFix
  readonly state: 'offered' | 'storing' | 'stale'
  readonly message?: string
}

export function problemFixLabel(fix: ProblemFix, message: typeof t = t): string {
  return fix.state === 'storing' ? message('problemFix.storing')
    : fix.state === 'stale' ? message('problemFix.checkAgain')
    : fix.offered.kind === 'rule' ? fix.offered.label
    : message('problemFix.useNumber', { value: String(fix.offered.after) })
}

export function problemFixLabels(fix: ProblemFix, message: typeof t = t): readonly string[] {
  return [fix.offered.kind === 'rule' ? fix.offered.label : message('problemFix.useNumber', { value: String(fix.offered.after) }),
    message('problemFix.storing'), message('problemFix.checkAgain')]
}

export const problemFixKey = (fix: StoredProblemFix): string => JSON.stringify([
  fix.part.graphId, fix.part.instancePath ?? [], fix.part.nodeId, fix.kind, fix.kind === 'rule' ? fix.rule : fix.valueKey,
])

/** Fix all never opens another interaction or starts a lookup. */
export function problemFixIsImmediate(fix: ProblemFix): boolean {
  return fix.offered.part.steps.every((step) => {
    if (isOutsideStep(step)) return false
    switch (step.step) {
      case 'pick': case 'ask': case 'openPicker': case 'openEditor': case 'pasteImage': case 'call': return false
      case 'set': case 'append': case 'setEach': return step.value.kind !== 'lookup'
      case 'randomize': return step.low?.kind !== 'lookup' && step.high?.kind !== 'lookup'
      case 'addMember': case 'addNode': return Object.values(step.values).every((value) => value.kind !== 'lookup')
      default: return true
    }
  })
}

/** The box and Problems share one offered snapshot and one in-flight write. */
export class ProblemFixes {
  readonly changed = createSignal(0)
  private readonly offers = new WeakMap<DocumentSession, Map<string, ProblemFix>>()

  constructor(private readonly app: AppState) {}

  scan(tab: Tab): readonly ProblemFix[] {
    const live = this.app.scanTabProblemFixes(tab)
    let offers = this.offers.get(tab.store)
    if (offers === undefined) { offers = new Map(); this.offers.set(tab.store, offers) }
    const keys = new Set(live.map(problemFixKey))
    for (const key of offers.keys()) if (!keys.has(key) && offers.get(key)?.state !== 'storing') offers.delete(key)
    return live.map((offered) => {
      const key = problemFixKey(offered)
      const previous = offers.get(key)
      if (previous !== undefined) return previous
      const fix: ProblemFix = { key, offered, state: 'offered' }
      offers.set(key, fix)
      return fix
    })
  }

  forProblem(tab: Tab, diagnostic: Diagnostic): ProblemFix | undefined {
    const key = diagnostic.data?.['problemFixKey']
    const fix = typeof key === 'string' ? this.offers.get(tab.store)?.get(key) : undefined
    return fix?.offered.kind === 'number' && this.app.settings.get<string>('automaticFixes.numberOutsideLimits') !== 'ask'
      ? undefined : fix
  }

  diagnostics(tab: Tab): readonly Diagnostic[] {
    const registry = this.app.registryForTab(tab)
    return this.scan(tab).map((fix) => {
      const { offered } = fix
      const node = tab.store.doc.graphs[offered.part.graphId]?.nodes[offered.part.nodeId]
      const title = node?.title || (node === undefined ? offered.part.nodeId : registry?.resolve(node.type)?.displayName ?? node.type)
      const text = offered.kind === 'rule' ? fix.message ?? offered.message
        : `${offered.label}: ${fix.message ?? t('problemFix.numberOutsideLimits', { value: String(offered.before) })}`
      const data = { problemFixKey: fix.key, nodeMessage: text,
        ...(offered.kind === 'rule' ? { rule: offered.rule, hasFix: true, fields: offered.fields } : {}) }
      const diagnostic = diag('warning', offered.kind === 'rule' ? 'compile' : 'environment',
        offered.kind === 'rule' ? 'node.rule.failed' : 'automatic.numberOutsideLimits', `${title}: ${text}`, {
          ...(offered.kind === 'number' ? { refs: [{ graphId: offered.part.graphId, nodeId: offered.part.nodeId,
            valueKey: offered.valueKey, portId: offered.valueKey, direction: 'input' as const }] } : {}),
          anchor: { occurrence: { instancePath: (offered.part.instancePath ?? []).map(asNodeId), node: asNodeId(offered.part.nodeId) } },
          data,
        })
      return offered.kind === 'rule'
        ? { ...diagnostic, refs: ruleProblemRefs(diagnostic, offered.part.graphId, offered.part.nodeId) } : diagnostic
    })
  }

  recheck(tab: Tab, key: string): void {
    const offers = this.offers.get(tab.store)
    if (offers?.get(key)?.state === 'storing') return
    offers?.delete(key)
    this.scan(tab)
    this.changed.update((value) => value + 1)
  }

  async apply(tab: Tab, fixes: readonly ProblemFix[], options: { readonly noWait?: boolean } = {}): Promise<void> {
    const offers = this.offers.get(tab.store)
    if (fixes.length === 0 || fixes.some((fix) => fix.state !== 'offered' || offers?.get(fix.key) !== fix)) return
    for (const fix of fixes) offers!.set(fix.key, { ...fix, state: 'storing' })
    this.changed.update((value) => value + 1)
    try {
      const outcome = await this.app.applyProblemFixes(tab, fixes.map((fix) => fix.offered), false, options)
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
