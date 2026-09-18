/**
 * Focused panel (panel id 'context'): the focused-context problem surface
 * (#22). Shows WHAT is focused (widget, nodes, links, groups, subgraph view,
 * or the whole document) and only the Problems entries belonging to that
 * context. The
 * focus-to-context mapping is the pure derivation in problem-context.ts
 * (priority documented in docs/problem-surfaces.md); this component only
 * gathers the live focus facts and renders the result. Focus changes never
 * mutate the document: everything here is a read-only projection.
 */
import { createEffect, createMemo, createSignal as createSolidSignal, For, onCleanup, Show } from 'solid-js'
import type { DinksterValuesClient, ExecutionState } from '@dinkster/client'
import { asNodeId, isPortEndpoint, isRerouteRef, isValueSourceRef, isWidgetTapRef, type Diagnostic, type Occurrence, type WorkflowDocument } from '@dinkster/core'
import { currentGraphId, viewInstancePath, type AppState, type Tab } from './app-state.js'
import { activateProblem } from './ProblemsPanel.js'
import { problemDisplay } from './problem-display.js'
import { contextProblems, deriveFocusContext, hasOwningContext, type FocusContext } from './problem-context.js'
import { RegionIterationInspector } from './RegionIterationInspector.js'
import { useAppMessage } from './locale.js'
import { useSignal } from './solid-adapter.js'

const CONTEXT_KIND_TITLES: Readonly<Record<FocusContext['kind'], string>> = {
  widget: 'contextPanel.context.widget',
  node: 'contextPanel.context.node',
  link: 'contextPanel.context.link',
  group: 'contextPanel.context.group',
  subgraph: 'contextPanel.context.subgraph',
  document: 'contextPanel.context.document',
}

interface ContextView {
  readonly tab: Tab
  readonly doc: WorkflowDocument
  readonly graphId: string
  readonly instancePath: readonly string[] | undefined
  readonly context: FocusContext
}

export function ContextPanel(props: {
  readonly app: AppState
  /** The same owner-scoped list the whole-document Problems panel shows. */
  readonly diagnostics: () => readonly Diagnostic[]
  readonly execution?: () => ExecutionState | undefined
  readonly values?: (execution: ExecutionState) => DinksterValuesClient | undefined
}) {
  const message = useAppMessage()
  const tabs = useSignal(props.app.tabs)
  const activeTabId = useSignal(props.app.activeTabId)
  const selection = useSignal(props.app.canvasSelection)
  const widgetFocus = useSignal(props.app.widgetFocus)
  const bridge = useSignal(props.app.canvasBridge)
  const activeTab = (): Tab | undefined => tabs().find((tab) => tab.id === activeTabId())

  // Navigation and document live in per-tab core signals; re-subscribe when
  // the active tab changes and surface their updates as one Solid tick.
  const [navTick, setNavTick] = createSolidSignal(0)
  createEffect(() => {
    const tab = activeTab()
    if (tab === undefined) return
    const bump = (): void => {
      setNavTick((value) => value + 1)
    }
    const unsubscribes = [
      tab.graphStack.subscribe(bump),
      tab.instancePath.subscribe(bump),
      tab.store.document.subscribe(bump),
    ]
    onCleanup(() => { for (const unsubscribe of unsubscribes) unsubscribe() })
  })

  const view = createMemo((): ContextView | undefined => {
    navTick()
    const tab = activeTab()
    if (tab === undefined) return undefined
    const doc = tab.store.doc
    const graphId = currentGraphId(tab)
    const instancePath = viewInstancePath(tab)
    const current = selection()
    const groups = current.groups.map((id) => ({
      id,
      title: doc.view.graphs[graphId]?.groups?.[id]?.title ?? id,
      members: bridge()?.groupMembers(graphId, id) ?? [],
    }))
    const context = deriveFocusContext({
      widget: widgetFocus(),
      nodes: current.nodes,
      links: current.links,
      groups,
      graphId,
      rootGraphId: doc.root,
      instancePath,
    })
    return { tab, doc, graphId, instancePath, context }
  })

  const registry = () => {
    const tab = activeTab()
    return tab === undefined ? undefined : props.app.registryForTab(tab)
  }

  const nodeLabel = (doc: WorkflowDocument, graphId: string, nodeId: string): string => {
    const node = doc.graphs[graphId]?.nodes[nodeId]
    if (node === undefined) return nodeId
    return node.title ?? registry()?.resolve(node.type)?.displayName ?? node.type
  }

  const linkLabel = (doc: WorkflowDocument, graphId: string, linkId: string): string => {
    const link = doc.graphs[graphId]?.links[linkId]
    if (link === undefined) return linkId
    const endpoint = (end: typeof link.from): string => {
      if (isPortEndpoint(end)) return `${nodeLabel(doc, graphId, end.node)}.${end.port}`
      if (isWidgetTapRef(end)) return message('contextPanel.link.tap', { node: nodeLabel(doc, graphId, end.node), tap: end.tap })
      if (isRerouteRef(end)) return message('contextPanel.link.reroute', { id: end.reroute })
      if (isValueSourceRef(end)) return message('contextPanel.link.value', { id: end.valueSource })
      return message('contextPanel.link.selector', { id: end.selector })
    }
    return `${endpoint(link.from)} -> ${endpoint(link.to)}`
  }

  const problems = createMemo((): readonly Diagnostic[] => {
    const current = view()
    if (current === undefined) return []
    return contextProblems(current.context, props.diagnostics(), {
      graphId: current.graphId,
      instancePath: current.instancePath,
    })
  })

  const selectedRegion = (current: ContextView): Occurrence | undefined => {
    if (current.context.kind !== 'node' || current.context.nodeIds.length !== 1 || current.instancePath === undefined) return undefined
    const nodeId = current.context.nodeIds[0]!
    return current.doc.graphs[current.graphId]?.nodes[nodeId]?.region === undefined
      ? undefined
      : { instancePath: current.instancePath.map(asNodeId), node: asNodeId(nodeId) }
  }

  const contextDetails = (current: ContextView) => {
    const { context, doc, graphId } = current
    switch (context.kind) {
      case 'widget':
        return <ul class="context-entities">
          <li>{message('contextPanel.entity.widget', { widget: context.label, node: nodeLabel(doc, graphId, context.nodeId) })} <span class="context-entity-id">({context.nodeId}.{context.valueKey})</span></li>
        </ul>
      case 'node':
        return <ul class="context-entities">
          <For each={context.nodeIds}>{(nodeId) => (
            <li>{nodeLabel(doc, graphId, nodeId)} <span class="context-entity-id">({nodeId})</span></li>
          )}</For>
        </ul>
      case 'link':
        return <ul class="context-entities">
          <For each={context.linkIds}>{(linkId) => (
            <li>{linkLabel(doc, graphId, linkId)} <span class="context-entity-id">({linkId})</span></li>
          )}</For>
        </ul>
      case 'group':
        return <ul class="context-entities">
          <For each={context.groups}>{(group) => (
            <li>{group.title} <span class="context-entity-id">({message('contextPanel.entity.groupCount', { count: group.members.length })})</span></li>
          )}</For>
        </ul>
      case 'subgraph':
        return <ul class="context-entities">
          <li>{doc.graphs[context.graphId]?.name ?? context.graphId} <span class="context-entity-id">({message('contextPanel.entity.subgraphDepth', { depth: context.instancePath.length })})</span></li>
        </ul>
      case 'document':
        return <ul class="context-entities">
          <li>{current.tab.title}</li>
        </ul>
    }
  }

  return (
    <section class="rail-section context-panel" data-testid="context-panel" data-native-text-scope>
      <h2>{message('contextPanel.title')}</h2>
      <Show when={view()} keyed fallback={<p class="empty">{message('contextPanel.empty.document')}</p>}>
        {(current) => (
          <>
            <div class="context-summary" data-testid="context-summary" data-context-kind={current.context.kind}>
              <strong class="context-kind">{message(CONTEXT_KIND_TITLES[current.context.kind])}</strong>
              {contextDetails(current)}
            </div>
            <Show when={selectedRegion(current)} keyed>
              {(occurrence) => <Show when={props.execution?.()} keyed>
                {(execution) => {
                  const registry = props.app.registryForTab(current.tab)
                  return registry === undefined
                    ? undefined
                    : <RegionIterationInspector
                        execution={execution}
                        regionOccurrence={occurrence}
                        document={current.doc}
                        resolveSchema={registry.resolve}
                        values={props.values?.(execution)}
                      />
                }}
              </Show>}
            </Show>
            <h3 class="context-problems-title">
              {message('contextPanel.problems.title')}
              <span class="problems-group-count" aria-label={message('contextPanel.problems.count', { count: problems().length })}>{problems().length}</span>
            </h3>
            <Show when={problems().length > 0} fallback={<p class="empty" data-testid="context-no-problems">{message('contextPanel.empty.problems')}</p>}>
              <div class="problems-group-items context-problems" data-testid="context-problems">
                <For each={problems()}>
                  {(diagnostic) => (
                    <details
                      class="problem"
                      data-severity={diagnostic.severity}
                      data-activatable={hasOwningContext(diagnostic) ? true : undefined}
                    >
                      <summary>
                        [{diagnostic.severity}] {diagnostic.code}: {problemDisplay(diagnostic, current.doc, registry())}
                      </summary>
                      <Show when={hasOwningContext(diagnostic)}>
                        <button
                          type="button"
                          class="problem-show-on-canvas"
                          onClick={() => activateProblem(props.app, diagnostic)}
                        >
                          {message('contextPanel.action.showOnCanvas')}
                        </button>
                      </Show>
                    </details>
                  )}
                </For>
              </div>
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}
