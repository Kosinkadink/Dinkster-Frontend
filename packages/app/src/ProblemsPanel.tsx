import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { diag, type Diagnostic, type ImportedNodePackResolution } from '@dinkster/core'
import type { CompatSkip, PackInferenceUnavailable, PackInstallPlan } from '@dinkster/client'
import { diagnosticFocusTarget, type AppState, type MigrationNotice } from './app-state.js'
import { groupProblemDiagnostics, type ProblemGroup } from './problem-display.js'
import { RuntimeErrorHints } from './RuntimeErrorHints.js'
import { useAppMessage } from './locale.js'
import { ProductButton } from './ProductControls.js'
import { ProductActionFooter, ProductNotice } from './ProductForm.js'
import { ProductEmptyState, ProductPanelHeader } from './ProductSurfaces.js'
import { useSignal } from './solid-adapter.js'

export interface ProblemsDisclosure {
  readonly expanded: (key: string) => boolean
  readonly toggle: (key: string) => void
}

export function createProblemsDisclosure(): ProblemsDisclosure {
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set())
  return {
    expanded: (key) => !collapsed().has(key),
    toggle: (key) => {
      setCollapsed((current) => {
        const next = new Set(current)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    },
  }
}

export function activateProblem(app: AppState, diagnostic: Diagnostic): void {
  const target = diagnosticFocusTarget(app.tabs.get(), app.activeTabId.get(), diagnostic)
  if (!target || !diagnostic.anchor) return
  app.activeTabId.set(target.tab.id)
  app.diagnosticFocus.set({
    tab: target.tab,
    anchor: diagnostic.anchor,
    ...(diagnostic.anchor.occurrence === undefined ? { portInstancePath: target.plan.instancePath } : {}),
  })
}

export interface ProblemsPanelProps {
  readonly app: AppState
  readonly diagnostics: () => readonly Diagnostic[]
  readonly compatSkips: () => readonly CompatSkip[]
  readonly migrationNotice?: () => MigrationNotice | undefined
  readonly packInferenceUnavailable?: () => readonly PackInferenceUnavailable[]
  readonly importedNodes?: () => readonly ImportedNodePackResolution[]
  readonly disclosure?: ProblemsDisclosure
  readonly onShowInContext?: (diagnostic: Diagnostic) => void
}

interface PackInstallReview {
  readonly current: () => boolean
  readonly phase: 'planning' | 'review' | 'applying' | 'error'
  readonly plan?: PackInstallPlan
  readonly error?: string
  readonly apply?: () => Promise<void>
}

export function ProblemsPanel(props: ProblemsPanelProps) {
  const message = useAppMessage()
  const tabs = useSignal(props.app.tabs)
  const activeTabId = useSignal(props.app.activeTabId)
  const [undoTick, setUndoTick] = createSignal(0)
  createEffect(() => {
    const owner = props.migrationNotice?.()?.owner
    const tab = tabs().find((candidate) => candidate.id === owner)
    if (tab === undefined) return
    // Shared sessions publish optimistic documents before updating undo history.
    const unsubscribe = tab.store.document.subscribe(() => queueMicrotask(() => setUndoTick((tick) => tick + 1)))
    onCleanup(unsubscribe)
  })
  const canUndoNotice = (): boolean => {
    undoTick()
    const owner = props.migrationNotice?.()?.owner
    return owner !== undefined && props.app.canUndoMigrationNotice(owner)
  }
  const disclosure = props.disclosure ?? createProblemsDisclosure()
  const missingPacks = createMemo(() => {
    const packs = new Map<string, ImportedNodePackResolution[]>()
    for (const node of props.importedNodes?.() ?? []) {
      if (node.status !== 'installable' || node.pack === undefined) continue
      const nodes = packs.get(node.pack) ?? []
      nodes.push(node)
      packs.set(node.pack, nodes)
    }
    return [...packs].sort(([left], [right]) => left.localeCompare(right))
  })
  const [install, setInstall] = createSignal<PackInstallReview>()
  const [commandsCopied, setCommandsCopied] = createSignal(false)
  createEffect(() => {
    activeTabId()
    tabs()
    props.importedNodes?.()
    if (install() && !install()!.current()) setInstall(undefined)
  })
  onCleanup(() => setInstall(undefined))
  const planInstall = async (selectedPack?: string) => {
    const tab = props.app.activeTab()
    if (!tab) return
    const backend = props.app.backendForTab(tab)
    const document = tab.store.doc
    const current = () => props.app.activeTab() === tab &&
      props.app.backendForTab(tab) === backend && tab.store.doc === document
    const request = { current, phase: 'planning' as const }
    setCommandsCopied(false)
    setInstall(request)
    try {
      const packs = missingPacks().filter(([pack]) => selectedPack === undefined || pack === selectedPack).map(([pack, nodes]) => {
        const versions = new Set(nodes.map((node) => node.version))
        const version = nodes[0]?.version
        if (versions.size !== 1 || !version) throw new Error(message('problems.importedPacks.versionConflict'))
        return { pack, version }
      })
      const plan = await backend.connection.planPackInstall(packs)
      if (install() !== request || !current()) return
      const confirmation = plan.confirmation
      if (confirmation === undefined) {
        setInstall({ current, phase: 'review', plan })
        return
      }
      const review = { current, phase: 'review' as const, plan, apply: async () => {
        if (install() !== review || !current()) { setInstall(undefined); return }
        const applying = { current, phase: 'applying' as const, plan }
        setInstall(applying)
        try {
          await backend.connection.applyPackInstall(confirmation)
          await props.app.refreshBackendSchemas(backend)
          if (install() === applying) setInstall(undefined)
        } catch (error) {
          if (install() === applying && current()) setInstall({ current, phase: 'error', error: String(error) })
        }
      } }
      setInstall(review)
    } catch (error) {
      if (install() === request && current()) setInstall({ current, phase: 'error', error: String(error) })
    }
  }
  const packDiagnostics = createMemo(() => [
    ...props.compatSkips().map((skip) => diag('info', 'schema', 'pack.compatSkipped', `${skip.packId}: ${skip.nodeId} - ${skip.reason}`)),
    ...(props.packInferenceUnavailable?.() ?? []).map((pack) => diag(
      'warning', 'schema', 'pack.inferenceUnavailable', `${pack.pack}: ${pack.reason}`,
      { data: { providers: pack.providers } },
    )),
  ])
  const groups = createMemo<readonly ProblemGroup[]>((previous) => {
    const next = groupProblemDiagnostics([...props.diagnostics(), ...packDiagnostics()], props.app.activeTab()?.store.doc)
    return next.map((group) => {
      const existing = previous.find((candidate) => candidate.key === group.key)
      return existing !== undefined && existing.title === group.title &&
        existing.severity === group.severity && existing.diagnostics.length === group.diagnostics.length &&
        existing.diagnostics.every((diagnostic, index) => diagnostic === group.diagnostics[index])
        ? existing
        : group
    })
  }, [])

  return (
    <section class="rail-section" data-testid="problems-panel" data-native-text-scope>
      <ProductPanelHeader title={message('shell.panel.problems.title')} />
      <Show when={missingPacks().length > 0}>
        <section class="problems-group imported-packs-report" data-testid="imported-packs-report" data-severity="warning">
          <div class="problems-group-header">
            <span class="problems-group-title">{message('problems.importedPacks.title')}</span>
            <span class="problems-group-count">{missingPacks().length}</span>
          </div>
          <p>{message('problems.importedPacks.hint')}</p>
          <For each={missingPacks()}>{([pack, nodes]) => (
            <section class="problem" data-pack={pack}>
              <h3>{pack}</h3>
              <ul>
                <For each={nodes}>{(node) => (
                  <li>
                    <span>{node.sourceClass}</span>
                    <code>{node.graphId}/{node.nodeId}</code>
                    <span class="imported-pack-status">{message('problems.importedPacks.installable')}</span>
                  </li>
                )}</For>
              </ul>
              <ProductButton variant="secondary" size="compact"
                disabled={install()?.phase === 'planning' || install()?.phase === 'applying'}
                onClick={() => void planInstall(pack)}>{message('problems.importedPacks.planOne')}</ProductButton>
            </section>
          )}</For>
          <Show when={install()?.plan}>{(plan) => (
            <div class="problem-detail" data-testid="pack-install-review">
              <p>{message(plan().commands === undefined ? 'problems.importedPacks.reviewHint' : 'problems.importedPacks.terminalHint')}</p>
              <pre>{plan().review}</pre>
              <Show when={plan().commands}>{(commands) => <>
                <pre>{commands().join('\n')}</pre>
                <ProductButton variant="secondary" size="compact" onClick={async () => {
                  const review = install()
                  setCommandsCopied(false)
                  try {
                    await navigator.clipboard.writeText(commands().join('\n'))
                    if (install() === review && review?.current()) {
                      setInstall({ current: review.current, phase: 'review', plan: plan() })
                      setCommandsCopied(true)
                    }
                  } catch {
                    if (install() === review && review?.current()) setInstall({ ...review, error: message('problems.importedPacks.copyFailed') })
                  }
                }}>{message(commandsCopied() ? 'problems.importedPacks.copied' : 'problems.importedPacks.copyCommands')}</ProductButton>
              </>}</Show>
            </div>
          )}</Show>
          <Show when={install()?.error}>{(error) => (
            <ProductNotice tone="error">{error()}</ProductNotice>
          )}</Show>
          <Show when={install()?.phase === 'planning' || install()?.phase === 'applying'}>
            <ProductNotice tone="status">{message(install()?.phase === 'applying'
              ? 'problems.importedPacks.applying' : 'problems.importedPacks.planning')}</ProductNotice>
          </Show>
          <ProductActionFooter>
            <Show when={install()?.phase === 'review'} fallback={
              <ProductButton variant="secondary" size="compact"
                disabled={install()?.phase === 'planning' || install()?.phase === 'applying'}
                onClick={() => void planInstall()}>{message('problems.importedPacks.plan')}</ProductButton>
            }>
              <Show when={install()?.apply}>
                <ProductButton variant="primary" size="compact"
                  onClick={() => void install()?.apply?.()}>{message('problems.importedPacks.confirm')}</ProductButton>
              </Show>
            </Show>
            <Show when={install()?.phase === 'review'}>
              <ProductButton variant="ghost" size="compact"
                onClick={() => setInstall(undefined)}>{message('problems.importedPacks.cancel')}</ProductButton>
            </Show>
          </ProductActionFooter>
        </section>
      </Show>
      <Show
        when={props.migrationNotice?.() !== undefined || groups().length > 0}
        fallback={<Show when={missingPacks().length === 0}><ProductEmptyState title={message('problems.empty')} /></Show>}
      >
        <Show when={props.migrationNotice?.()}>{(notice) => (
          <section class="problems-group" data-testid="migration-notice">
            <div class="problems-group-header">
              <span class="problems-group-title">{message('problems.migration.title')}</span>
              <span class="problems-group-count">{notice().entries.length}</span>
            </div>
            <div class="problems-group-items">
              <For each={notice().entries}>{(entry) => (
                <div class="problem" data-severity={entry.severity}>
                  <ProductButton variant="ghost" size="compact" disabled={entry.anchor === undefined}
                    onClick={() => activateProblem(props.app, entry)}>
                    {entry.message}
                  </ProductButton>
                  <For each={entry.data?.warnings as readonly string[] | undefined}>
                    {(warning) => <p>{warning}</p>}
                  </For>
                </div>
              )}</For>
            </div>
            <ProductActionFooter>
              <ProductButton variant="ghost" size="compact"
                disabled={!canUndoNotice()}
                title={message('problems.migration.undoHint')}
                onClick={() => props.app.undoMigrationNotice(notice().owner)}>
                {message('problems.migration.undo')}
              </ProductButton>
              <ProductButton variant="ghost" size="compact"
                onClick={() => props.app.dismissMigrationNotice(notice().owner)}>
                {message('problems.action.dismiss')}
              </ProductButton>
            </ProductActionFooter>
          </section>
        )}</Show>
        <For each={groups()}>
          {(group, index) => {
            const contentId = () => `problems-group-${index()}`
            return (
              <section class="problems-group" data-section={group.title} data-severity={group.severity}>
                <ProductButton
                  type="button" variant="ghost" size="compact" class="problems-group-header"
                  aria-expanded={disclosure.expanded(group.key)} aria-controls={contentId()}
                  onClick={() => disclosure.toggle(group.key)}
                >
                  <span class="problems-group-disclosure" aria-hidden="true">{disclosure.expanded(group.key) ? 'v' : '>'}</span>
                  <span class="problems-group-title">{message(`problems.section.${group.title}`)}</span>
                  <span class="problems-group-count">{group.diagnostics.length}</span>
                </ProductButton>
                <Show when={group.title === 'upgrade'}>
                  <ProductButton type="button" variant="ghost" size="compact" class="problems-dismiss"
                    onClick={() => props.app.dismissImportProblems()}>
                    {message('problems.action.dismiss')}
                  </ProductButton>
                </Show>
                <div id={contentId()} class="problems-group-items" hidden={!disclosure.expanded(group.key)}>
                  <For each={group.diagnostics}>
                    {(diagnostic) => (
                      <details class="problem" data-severity={diagnostic.severity}
                        data-activatable={diagnostic.anchor !== undefined ? true : undefined}>
                        <summary title={diagnostic.message} onClick={() => activateProblem(props.app, diagnostic)}>
                          <span class="problem-severity" aria-label={diagnostic.severity}>
                            {diagnostic.severity === 'error' ? 'x' : diagnostic.severity === 'warning' ? '!' : 'i'}
                          </span>
                          <span class="problem-message">{diagnostic.message}</span>
                        </summary>
                        <div class="problem-detail">
                          <code>{diagnostic.code}</code>
                          <Show when={diagnostic.data}><pre>{JSON.stringify(diagnostic.data, null, 2)}</pre></Show>
                          <Show when={diagnostic.anchor !== undefined}>
                            <ProductButton type="button" variant="secondary" size="compact" class="problem-show-on-canvas"
                              onClick={() => activateProblem(props.app, diagnostic)}>
                              {message('problems.action.showOnCanvas')}
                            </ProductButton>
                            <Show when={props.onShowInContext} keyed>{(showInContext) => (
                              <ProductButton type="button" variant="secondary" size="compact" class="problem-show-in-context"
                                onClick={() => showInContext(diagnostic)}>
                                {message('problems.action.showInFocused')}
                              </ProductButton>
                            )}</Show>
                          </Show>
                          <Show when={diagnostic.runtime?.hints?.length}>
                            <RuntimeErrorHints hints={diagnostic.runtime!.hints} />
                          </Show>
                          <Show when={diagnostic.runtime}>
                            <pre class="traceback">{diagnostic.runtime!.traceback.join('\n')}</pre>
                          </Show>
                        </div>
                      </details>
                    )}
                  </For>
                </div>
              </section>
            )
          }}
        </For>
      </Show>
    </section>
  )
}
