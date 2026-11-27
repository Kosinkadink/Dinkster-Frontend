import { asNodeId, createSignal, diag, isOutsideStep, ruleProblemRefs, t, type Diagnostic, type DocumentSession, type StoredProblemFix, type StoredSaveTargetFix } from '@dinkster/core'
import type { MountSettings } from '@dinkster/client'
import type { AppState, Backend, Tab } from './app-state.js'

interface SaveTargetGroup {
  readonly kind: 'save-targets'
  readonly backend: Backend
  readonly fixes: readonly StoredSaveTargetFix[]
  readonly defaultMount: string | undefined
  readonly defaultReady: boolean
}

const readyMounts = (settings: MountSettings): ReadonlySet<string> => new Set(settings.mounts
  .filter((mount) => mount.mode === 'readwrite' && mount.state === 'ready').map((mount) => mount.id))

const saveTargetStamp = (fixes: readonly StoredSaveTargetFix[]): string => JSON.stringify(fixes.map((fix) =>
  [fix.part.graphId, fix.part.instancePath ?? [], fix.part.nodeId, fix.valueKey, fix.stamp]).sort())

export interface ProblemFix {
  readonly key: string
  readonly offered: StoredProblemFix | SaveTargetGroup
  readonly state: 'offered' | 'storing' | 'stale'
  readonly message?: string
}

export function problemFixLabel(fix: ProblemFix, message: typeof t = t): string {
  return fix.state === 'storing' ? message('problemFix.storing')
    : fix.state === 'stale' ? message('problemFix.checkAgain')
    : fix.offered.kind === 'save-targets' ? message('problemFix.useProjectDefaultForAll')
    : fix.offered.kind === 'rule' ? fix.offered.label
    : message('problemFix.useNumber', { value: String(fix.offered.after) })
}

export function problemFixLabels(fix: ProblemFix, message: typeof t = t): readonly string[] {
  return [fix.offered.kind === 'save-targets' ? message('problemFix.useProjectDefaultForAll')
    : fix.offered.kind === 'rule' ? fix.offered.label : message('problemFix.useNumber', { value: String(fix.offered.after) }),
    message('problemFix.storing'), message('problemFix.checkAgain')]
}

export const problemFixKey = (fix: StoredProblemFix): string => JSON.stringify([
  fix.part.graphId, fix.part.instancePath ?? [], fix.part.nodeId, fix.kind, fix.kind === 'rule' ? fix.rule : fix.valueKey,
])

/** Fix all never opens another interaction or starts a lookup. */
export function problemFixIsImmediate(fix: ProblemFix): boolean {
  if (fix.offered.kind === 'save-targets') return fix.offered.defaultReady
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
  private readonly mounts = new WeakMap<Backend, { settings?: MountSettings }>()

  constructor(private readonly app: AppState) {}

  invalidateMounts(backend: Backend): void {
    this.mounts.delete(backend)
    this.changed.update((value) => value + 1)
  }

  private async readMounts(backend: Backend): Promise<MountSettings | undefined> {
    let entry = this.mounts.get(backend)
    if (entry === undefined) { entry = {}; this.mounts.set(backend, entry) }
    try {
      const settings = await backend.connection.fetchMountSettings()
      if (this.mounts.get(backend) !== entry) return undefined
      entry.settings = settings
      this.changed.update((value) => value + 1)
      return settings
    } catch {
      if (this.mounts.get(backend) === entry) {
        delete entry.settings
        this.changed.update((value) => value + 1)
      }
      return undefined
    }
  }

  private saveTargets(tab: Tab): SaveTargetGroup | null | undefined {
    const backend = this.app.backendForTab(tab)
    if (backend === undefined || this.app.scanTabSaveTargetFixes(tab, new Set()).length === 0) return null
    if (!this.mounts.has(backend)) void this.readMounts(backend)
    const settings = this.mounts.get(backend)?.settings
    if (settings === undefined) return undefined
    const ready = readyMounts(settings)
    const fixes = this.app.scanTabSaveTargetFixes(tab, ready)
    return fixes.length === 0 ? null : { kind: 'save-targets', backend, fixes,
      defaultMount: settings.activeOutputMount,
      defaultReady: settings.activeOutputMount !== undefined && ready.has(settings.activeOutputMount) }
  }

  scan(tab: Tab): readonly ProblemFix[] {
    const live: { key: string; offered: ProblemFix['offered'] }[] = this.app.scanTabProblemFixes(tab)
      .map((offered) => ({ key: problemFixKey(offered), offered }))
    let offers = this.offers.get(tab.store)
    if (offers === undefined) { offers = new Map(); this.offers.set(tab.store, offers) }
    const targets = this.saveTargets(tab)
    const held = offers.get('save-targets')?.offered
    if (targets != null) live.push({ key: 'save-targets', offered: targets })
    else if (targets === undefined && held?.kind === 'save-targets') live.push({ key: 'save-targets', offered: held })
    const keys = new Set(live.map(({ key }) => key))
    for (const key of offers.keys()) if (!keys.has(key) && offers.get(key)?.state !== 'storing') offers.delete(key)
    return live.map(({ key, offered }) => {
      const previous = offers.get(key)
      if (previous !== undefined) {
        if (offered.kind !== 'save-targets' || previous.offered.kind !== 'save-targets' || previous.state === 'storing' ||
          offered.defaultMount === previous.offered.defaultMount && offered.defaultReady === previous.offered.defaultReady &&
          saveTargetStamp(offered.fixes) === saveTargetStamp(previous.offered.fixes)) return previous
        const stale = previous.state === 'stale' || previous.offered.defaultReady && offered.defaultReady
        const updated: ProblemFix = { key, offered, state: stale ? 'stale' : 'offered',
          ...(stale ? { message: t('problemFix.workflowChanged') } : {}) }
        offers.set(key, updated)
        return updated
      }
      const fix: ProblemFix = { key, offered, state: 'offered' }
      offers.set(key, fix)
      return fix
    })
  }

  forProblem(tab: Tab, diagnostic: Diagnostic): ProblemFix | undefined {
    const key = diagnostic.data?.['problemFixKey']
    const fix = typeof key === 'string' ? this.offers.get(tab.store)?.get(key) : undefined
    return fix?.offered.kind === 'number' && this.app.settings.get<string>('automaticFixes.numberOutsideLimits') !== 'ask' ||
      fix?.offered.kind === 'save-targets' && !fix.offered.defaultReady && fix.state !== 'stale'
      ? undefined : fix
  }

  diagnostics(tab: Tab): readonly Diagnostic[] {
    const registry = this.app.registryForTab(tab)
    return this.scan(tab).map((fix) => {
      const { offered } = fix
      if (offered.kind === 'save-targets') return diag('warning', 'environment', 'saveTarget.mountsMissing',
        fix.message ?? t('problemFix.saveTargetsMissing'), { data: { problemFixKey: fix.key },
          refs: offered.fixes.map((target) => ({ graphId: target.part.graphId, nodeId: target.part.nodeId,
            valueKey: target.valueKey, portId: target.valueKey, direction: 'input' as const })) })
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
    const backend = key === 'save-targets' ? this.app.backendForTab(tab) : undefined
    if (backend !== undefined) this.invalidateMounts(backend)
    this.scan(tab)
    this.changed.update((value) => value + 1)
  }

  async apply(tab: Tab, fixes: readonly ProblemFix[], options: { readonly noWait?: boolean } = {}): Promise<void> {
    const offers = this.offers.get(tab.store)
    if (fixes.length === 0 || fixes.some((fix) => fix.state !== 'offered' || offers?.get(fix.key) !== fix)) return
    for (const fix of fixes) offers!.set(fix.key, { ...fix, state: 'storing' })
    this.changed.update((value) => value + 1)
    try {
      const regular = fixes.flatMap((fix) => fix.offered.kind === 'save-targets' ? [] : [fix.offered])
      const group = fixes.find((fix) => fix.offered.kind === 'save-targets')?.offered
      const targets = group?.kind === 'save-targets' ? group : undefined
      const store = tab.store
      if (targets !== undefined) await this.readMounts(targets.backend)
      const currentMounts = (): ReadonlySet<string> | undefined => {
        if (targets === undefined || this.app.backendForTab(tab) !== targets.backend || tab.store !== store) return undefined
        const settings = this.mounts.get(targets.backend)?.settings
        if (settings === undefined || settings.activeOutputMount !== targets.defaultMount) return undefined
        const ready = readyMounts(settings)
        return targets.defaultReady && targets.defaultMount !== undefined && ready.has(targets.defaultMount) ? ready : undefined
      }
      const outcome = await this.app.applyProblemFixes(tab, regular, false, {
        ...options,
        ...(targets === undefined ? {} : {
          saveTargets: { fixes: targets.fixes, readyMounts: currentMounts },
          unchanged: (document) => {
            const mounts = currentMounts()
            return mounts !== undefined && saveTargetStamp(this.app.scanTabSaveTargetFixes(tab, mounts, document)) === saveTargetStamp(targets.fixes)
          },
        }),
      })
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
