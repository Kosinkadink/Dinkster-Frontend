import { createMemo, createSignal, For, Show } from 'solid-js'
import type { Diagnostic } from '@dinkster/core'
import type { CompatSkip, PackInferenceUnavailable } from '@dinkster/client'
import { currentGraphId, diagnosticFocusTarget, type AppState } from './app-state.js'
import { groupProblemDiagnostics, problemDisplay, type ProblemGroup } from './problem-display.js'
import { RuntimeErrorHints } from './RuntimeErrorHints.js'
import { useAppMessage } from './locale.js'

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
  /** Packs whose nodes, routes and events composed but whose declared
   * samplers/schedulers could not bind because no native sampling worker
   * was live; their ids are refused at plan time until a worker connects.
   * Absent hosts (older backends, unit harnesses) render no such group. */
  readonly packInferenceUnavailable?: () => readonly PackInferenceUnavailable[]
  /** Injectable so the Node-rendered component contract can drive disclosure state. */
  readonly disclosure?: ProblemsDisclosure
  /**
   * Navigate to a problem's owning context (focus the owner AND activate the
   * Context panel). Offered per row alongside Show on canvas for diagnostics
   * with an owning context; absent hosts render no such action.
   */
  readonly onShowInContext?: (diagnostic: Diagnostic) => void
}

export function ProblemsPanel(props: ProblemsPanelProps) {
  const message = useAppMessage()
  const inferenceUnavailable = (): readonly PackInferenceUnavailable[] => {
    return props.packInferenceUnavailable?.() ?? []
  }
  const disclosure = props.disclosure ?? createProblemsDisclosure()
  const groups = createMemo<readonly ProblemGroup[]>((previous) => {
    const tab = props.app.activeTab()
    const next = groupProblemDiagnostics(
      props.diagnostics(),
      tab?.store.doc,
      tab === undefined ? undefined : props.app.registryForTab(tab),
      tab === undefined ? undefined : { graphId: currentGraphId(tab) },
    )
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
      <h2>{message('shell.panel.problems.title')}</h2>
      {/* Problems are owner-scoped: the caller supplies only visible canvases'
          entries plus app-scoped globals and the active execution's errors. */}
      <Show
        when={groups().length > 0 || props.compatSkips().length > 0 || inferenceUnavailable().length > 0}
        fallback={<p class="empty">{message('problems.empty')}</p>}
      >
        <For each={groups()}>
          {(group, index) => {
            const contentId = () => `problems-group-${index()}`
            return (
              <section class="problems-group" data-severity={group.severity}>
                <button
                  type="button"
                  class="problems-group-header"
                  aria-expanded={disclosure.expanded(group.key)}
                  aria-controls={contentId()}
                  onClick={() => disclosure.toggle(group.key)}
                >
                  <span class="problems-group-disclosure" aria-hidden="true">{disclosure.expanded(group.key) ? 'v' : '>'}</span>
                  <span class="problems-group-title">{group.title}</span>
                  <span class="problems-group-count">{group.diagnostics.length}</span>
                  <span class="problems-group-severity">{group.severity}</span>
                </button>
                <div id={contentId()} class="problems-group-items" hidden={!disclosure.expanded(group.key)}>
                  <For each={group.diagnostics}>
                    {(diagnostic) => (
                      <details
                        class="problem"
                        data-severity={diagnostic.severity}
                        data-activatable={diagnostic.anchor?.occurrence !== undefined || diagnostic.anchor?.port !== undefined ? true : undefined}
                      >
                        <summary>
                          [{diagnostic.severity}] {diagnostic.code}: {(() => {
                            const tab = props.app.activeTab()
                            return problemDisplay(
                              diagnostic,
                              tab?.store.doc,
                              tab === undefined ? undefined : props.app.registryForTab(tab),
                            )
                          })()}
                        </summary>
                        <Show when={diagnostic.anchor?.occurrence !== undefined || diagnostic.anchor?.port !== undefined}>
                          <button
                            type="button"
                            class="problem-show-on-canvas"
                            onClick={() => activateProblem(props.app, diagnostic)}
                          >
                            {message('problems.action.showOnCanvas')}
                          </button>
                          <Show when={props.onShowInContext} keyed>{(showInContext) => (
                            <button
                              type="button"
                              class="problem-show-in-context"
                              onClick={() => showInContext(diagnostic)}
                            >
                              {message('problems.action.showInFocused')}
                            </button>
                          )}</Show>
                        </Show>
                        <Show when={diagnostic.runtime?.hints?.length}>
                          <RuntimeErrorHints hints={diagnostic.runtime!.hints} />
                        </Show>
                        <Show when={diagnostic.runtime}>
                          <pre class="traceback">{diagnostic.runtime!.traceback.join('\n')}</pre>
                        </Show>
                      </details>
                    )}
                  </For>
                </div>
              </section>
            )
          }}
        </For>
        <Show when={props.compatSkips().length > 0}>
          <section class="problems-group compat-skips-group" data-severity="info" aria-label={message('problems.compat.title')}>
            <div class="problems-group-header compat-skips-header">
              <span class="problems-group-title">{message('problems.compat.title')}</span>
              <span class="problems-group-count">{props.compatSkips().length}</span>
              <span class="problems-group-severity">{message('problems.compat.advisory')}</span>
            </div>
            <p class="compat-skips-explanation">{message('problems.compat.description')}</p>
            <div class="problems-group-items">
              <For each={props.compatSkips()}>
                {(skip) => (
                  <div class="problem compat-skip" data-severity="info">
                    <strong>{`${skip.packId}: ${skip.nodeId}`}</strong>
                    <div class="compat-skip-reason">{skip.reason}</div>
                  </div>
                )}
              </For>
            </div>
          </section>
        </Show>
        <Show when={inferenceUnavailable().length > 0}>
          <section
            class="problems-group inference-unavailable-group"
            data-severity="warning"
            data-testid="pack-inference-unavailable-group"
            aria-label={message('problems.inferenceUnavailable.title')}
          >
            <div class="problems-group-header inference-unavailable-header">
              <span class="problems-group-title">{message('problems.inferenceUnavailable.title')}</span>
              <span class="problems-group-count">{inferenceUnavailable().length}</span>
              <span class="problems-group-severity">{message('problems.inferenceUnavailable.warning')}</span>
            </div>
            <p class="inference-unavailable-explanation">{message('problems.inferenceUnavailable.description')}</p>
            <div class="problems-group-items">
              <For each={inferenceUnavailable()}>
                {(unavailable) => (
                  <div class="problem inference-unavailable" data-severity="warning">
                    <strong>{unavailable.pack}</strong>
                    <div class="inference-unavailable-reason">{unavailable.reason}</div>
                    <For each={unavailable.providers}>
                      {(provider) => (
                        <div class="inference-unavailable-provider">{`${provider.registry}.${provider.id}`}</div>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </section>
        </Show>
      </Show>
    </section>
  )
}
