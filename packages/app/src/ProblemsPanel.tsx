import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { canonicalJson, diag, type Diagnostic, type ImportedNodePackResolution } from '@dinkster/core'
import type { CompatSkip, PackInferenceUnavailable, PackInstallPlan, PackPreparationProgress } from '@dinkster/client'
import { diagnosticFocusTarget, type AppState } from './app-state.js'
import { groupProblemDiagnostics } from './problem-display.js'
import { RuntimeErrorHints } from './RuntimeErrorHints.js'
import { useAppMessage } from './locale.js'
import { ProductButton, ProductCheckbox } from './ProductControls.js'
import type { useSelectionContext } from './selection-context.js'
import { contextProblems } from './problem-context.js'
import { PackPreparationStatus } from './PackPreparationStatus.js'
import { ProductActionFooter, ProductNotice } from './ProductForm.js'
import { ProductEmptyState, ProductPanelHeader } from './ProductSurfaces.js'
import { useSignal } from './solid-adapter.js'
import { isNativeProjectBackend } from './desktop-bridge.js'
import { activeProjectId } from './projects.js'

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

export function activateProblem(app: AppState, diagnostic: Diagnostic, openAssetInput?: string): void {
  const target = diagnosticFocusTarget(app.tabs.get(), app.activeTabId.get(), diagnostic)
  if (!target || !diagnostic.anchor) return
  app.activeTabId.set(target.tab.id)
  app.diagnosticFocus.set({
    tab: target.tab,
    anchor: diagnostic.anchor,
    ...(openAssetInput === undefined ? {} : { openAssetInput }),
    ...(openAssetInput !== undefined && typeof diagnostic.data?.['digest'] === 'string'
      ? { missingAssetDigest: diagnostic.data['digest'] } : {}),
    ...(diagnostic.anchor.occurrence === undefined ? { portInstancePath: target.plan.instancePath } : {}),
  })
}

export interface ProblemsPanelProps {
  readonly app: AppState
  readonly diagnostics: () => readonly Diagnostic[]
  readonly compatSkips: () => readonly CompatSkip[]
  readonly packInferenceUnavailable?: () => readonly PackInferenceUnavailable[]
  readonly importedNodes?: () => readonly ImportedNodePackResolution[]
  readonly disclosure?: ProblemsDisclosure
  readonly selection?: ReturnType<typeof useSelectionContext>
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
  const disclosure = props.disclosure ?? createProblemsDisclosure()
  const [selectionOnly, setSelectionOnly] = createSignal(false)
  const selectedContext = () => {
    const view = props.selection?.()
    return view !== undefined && view.context.kind !== 'document' && view.context.kind !== 'subgraph' ? view : undefined
  }
  const filterDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] => {
    if (!selectionOnly()) return diagnostics
    const view = selectedContext()
    return view === undefined ? [] : contextProblems(view.context, diagnostics, view)
  }
  const selectionLabel = (): string => {
    const view = selectedContext()
    if (view === undefined) return message('problems.selection.none')
    const context = view.context
    if (context.kind === 'widget') return context.label
    if (context.kind === 'group') return context.groups.map((group) => group.title).join(', ')
    if (context.kind === 'link') return message('problems.selection.links', { count: context.linkIds.length })
    if (context.kind === 'node') {
      if (context.nodeIds.length !== 1) return message('problems.selection.nodes', { count: context.nodeIds.length })
      const id = context.nodeIds[0]!
      const node = view.doc.graphs[view.graphId]?.nodes[id]
      return node?.title || (node === undefined ? id : props.app.registryForTab(view.tab)?.resolve(node.type)?.displayName ?? id)
    }
    return message('problems.selection.none')
  }
  const missingPacks = createMemo(() => {
    const packs = new Map<string, ImportedNodePackResolution[]>()
    for (const node of props.importedNodes?.() ?? []) {
      if (node.status !== 'installable' || node.pack === undefined) continue
      if (filterDiagnostics([diag('warning', 'schema', 'pack.missing', node.sourceClass, {
        refs: [{ graphId: node.graphId, nodeId: node.nodeId }],
      })]).length === 0) continue
      const nodes = packs.get(node.pack) ?? []
      nodes.push(node)
      packs.set(node.pack, nodes)
    }
    return [...packs].sort(([left], [right]) => left.localeCompare(right))
  })
  const [install, setInstall] = createSignal<PackInstallReview>()
  const [progress, setProgress] = createSignal<PackPreparationProgress>()
  let preparationController: AbortController | undefined
  const [commandsCopied, setCommandsCopied] = createSignal(false)
  createEffect(() => {
    activeTabId()
    tabs()
    props.importedNodes?.()
    if (install() && !install()!.current()) { preparationController?.abort(); setInstall(undefined) }
  })
  onCleanup(() => { preparationController?.abort(); setInstall(undefined) })
  const planInstall = async (selectedPack?: string) => {
    const tab = props.app.activeTab()
    if (!tab) return
    const backend = props.app.backendForTab(tab)
    const document = canonicalJson(tab.store.doc)
    const revision = tab.store.revision
    const current = () => {
      const live = props.app.liveTabContinuing(tab.store)
      return live !== undefined && props.app.activeTab() === live &&
        props.app.backendForTab(live) === backend && live.store.revision === revision &&
        canonicalJson(live.store.doc) === document
    }
    const request = { current, phase: 'planning' as const }
    preparationController?.abort()
    const controller = new AbortController()
    preparationController = controller
    setProgress(undefined)
    setCommandsCopied(false)
    setInstall(request)
    try {
      const packs = missingPacks().filter(([pack]) => selectedPack === undefined || pack === selectedPack).map(([pack, nodes]) => {
        const versions = new Set(nodes.map((node) => node.version))
        const version = nodes[0]?.version
        if (versions.size !== 1 || !version) throw new Error(message('problems.importedPacks.versionConflict'))
        return { pack, version }
      })
      if (isNativeProjectBackend(backend.baseUrl, activeProjectId())) {
        await props.app.checkProjectNeeds(backend, packs, () => install() === request && current())
        if (install() === request && current()) {
          const needs = props.app.projectNeedsReview.get()
          if (needs?.backend !== backend || !needs.current()) throw new Error(message('projectNeeds.changed'))
          setInstall(undefined)
          props.app.modalPanel.set('')
        }
        return
      }
      const plan = await backend.connection.planPackInstall(packs, controller.signal, (value) => {
        if (install() !== request || !current()) { controller.abort(); return }
        setProgress(value)
      })
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
  const expandedProblems = new Set<string>()
  const packDiagnostics = createMemo(() => [
    ...props.compatSkips().map((skip) => diag('info', 'schema', 'pack.compatSkipped', `${skip.packId}: ${skip.nodeId} - ${skip.reason}`)),
    ...(props.packInferenceUnavailable?.() ?? []).map((pack) => diag(
      'warning', 'schema', 'pack.inferenceUnavailable', `${pack.pack}: ${pack.reason}`,
      { data: { providers: pack.providers } },
    )),
  ])
  const groups = createMemo(() => {
    return groupProblemDiagnostics(filterDiagnostics([...props.diagnostics(), ...packDiagnostics()]), props.app.activeTab()?.store.doc)
  })

  return (
    <section class="rail-section" data-testid="problems-panel" data-native-text-scope>
      <ProductPanelHeader title={message('shell.panel.problems.title')} actions={
        <label class="problems-selection-control">
          <ProductCheckbox checked={selectionOnly()} onChange={setSelectionOnly}
            ariaLabel={message('problems.selection.only')} testId="problems-selection-only" />
          {message('problems.selection.only')}
        </label>
      } />
      <Show when={selectionOnly()}><p data-testid="problems-selection">{selectionLabel()}</p></Show>
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
            <ProductNotice tone="status">{install()?.phase === 'applying'
              ? message('problems.importedPacks.applying') : <PackPreparationStatus progress={progress()} />}</ProductNotice>
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
            <Show when={install()?.phase === 'review' || install()?.phase === 'planning'}>
              <ProductButton variant="ghost" size="compact"
                onClick={() => { preparationController?.abort(); setInstall(undefined) }}>{message('problems.importedPacks.cancel')}</ProductButton>
            </Show>
          </ProductActionFooter>
        </section>
      </Show>
      <Show
        when={groups().length > 0}
        fallback={<Show when={missingPacks().length === 0 && (!selectionOnly() || selectedContext() !== undefined)}><ProductEmptyState title={message('problems.empty')} /></Show>}
      >
        <For each={groups().map((group) => group.key)}>
          {(key, index) => {
            const group = () => groups().find((candidate) => candidate.key === key)!
            const contentId = () => `problems-group-${index()}`
            return (
              <section class="problems-group" data-section={group().title} data-severity={group().severity}>
                <ProductButton
                  type="button" variant="ghost" size="compact" class="problems-group-header"
                  aria-expanded={disclosure.expanded(key)} aria-controls={contentId()}
                  onClick={() => disclosure.toggle(key)}
                >
                  <span class="problems-group-disclosure" aria-hidden="true">{disclosure.expanded(key) ? 'v' : '>'}</span>
                  <span class="problems-group-title">{message(`problems.section.${group().title}`)}</span>
                  <span class="problems-group-count">{group().diagnostics.length}</span>
                </ProductButton>
                <div id={contentId()} class="problems-group-items" hidden={!disclosure.expanded(key)}>
                  <For each={group().diagnostics}>
                    {(diagnostic) => (
                      <details class="problem" data-severity={diagnostic.severity}
                        open={expandedProblems.has(JSON.stringify([key, diagnostic]))}
                        onToggle={(event) => {
                          const problemKey = JSON.stringify([key, diagnostic])
                          if (event.currentTarget.open) expandedProblems.add(problemKey)
                          else expandedProblems.delete(problemKey)
                        }}
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
                            <Show when={diagnostic.code === 'asset.availability.missing' && typeof diagnostic.data?.['input'] === 'string'}>
                              <ProductButton type="button" variant="secondary" size="compact"
                                onClick={() => activateProblem(props.app, diagnostic, diagnostic.data!['input'] as string)}>
                                {message('problems.action.locateAsset')}
                              </ProductButton>
                            </Show>
                            <ProductButton type="button" variant="secondary" size="compact" class="problem-show-on-canvas"
                              onClick={() => activateProblem(props.app, diagnostic)}>
                              {message('problems.action.showOnCanvas')}
                            </ProductButton>
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
