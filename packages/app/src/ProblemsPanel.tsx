import { createMemo, createSignal, For, Show } from 'solid-js'
import { diag, type Diagnostic } from '@dinkster/core'
import type { CompatSkip, PackInferenceUnavailable } from '@dinkster/client'
import { diagnosticFocusTarget, type AppState } from './app-state.js'
import { groupProblemDiagnostics, type ProblemGroup } from './problem-display.js'
import { RuntimeErrorHints } from './RuntimeErrorHints.js'
import { useAppMessage } from './locale.js'
import { ProductButton } from './ProductControls.js'
import { ProductEmptyState, ProductPanelHeader } from './ProductSurfaces.js'

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
  readonly packInferenceUnavailable?: () => readonly PackInferenceUnavailable[]
  readonly disclosure?: ProblemsDisclosure
  readonly onShowInContext?: (diagnostic: Diagnostic) => void
}

export function ProblemsPanel(props: ProblemsPanelProps) {
  const message = useAppMessage()
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
    const unchanged = previous.length === next.length && previous.every((group, index) => {
      const candidate = next[index]
      return candidate !== undefined && group.key === candidate.key && group.title === candidate.title &&
        group.severity === candidate.severity && group.diagnostics.length === candidate.diagnostics.length &&
        group.diagnostics.every((diagnostic, diagnosticIndex) => diagnostic === candidate.diagnostics[diagnosticIndex])
    })
    return unchanged ? previous : next
  }, [])

  return (
    <section class="rail-section" data-testid="problems-panel" data-native-text-scope>
      <ProductPanelHeader title={message('shell.panel.problems.title')} />
      <Show when={groups().length > 0} fallback={<ProductEmptyState title={message('problems.empty')} />}>
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
