import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { diag, type Diagnostic } from '@dinkster/core'
import type { CompatSkip, PackInferenceUnavailable } from '@dinkster/client'
import { diagnosticFocusTarget, type AppState, type MigrationNotice } from './app-state.js'
import { groupProblemDiagnostics, type ProblemGroup } from './problem-display.js'
import { RuntimeErrorHints } from './RuntimeErrorHints.js'
import { useAppMessage } from './locale.js'
import { ProductButton } from './ProductControls.js'
import { ProductActionFooter } from './ProductForm.js'
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
  readonly disclosure?: ProblemsDisclosure
  readonly onShowInContext?: (diagnostic: Diagnostic) => void
}

export function ProblemsPanel(props: ProblemsPanelProps) {
  const message = useAppMessage()
  const tabs = useSignal(props.app.tabs)
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
      <Show
        when={props.migrationNotice?.() !== undefined || groups().length > 0}
        fallback={<ProductEmptyState title={message('problems.empty')} />}
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
