import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { currentGraphId, viewInstancePath, type AppState } from './app-state.js'
import { deriveFocusContext } from './problem-context.js'
import { useSignal } from './solid-adapter.js'

/** Selection and navigation belong to the active view, not the diagnostic's owner. */
export function useSelectionContext(app: AppState) {
  const tabs = useSignal(app.tabs)
  const activeId = useSignal(app.activeTabId)
  const selection = useSignal(app.canvasSelection)
  const widget = useSignal(app.widgetFocus)
  const bridge = useSignal(app.canvasBridge)
  const tab = createMemo(() => tabs().find((candidate) => candidate.id === activeId()))
  const [tick, setTick] = createSignal(0)
  createEffect(() => {
    const current = tab()
    if (current === undefined) return
    const bump = () => setTick((value) => value + 1)
    const unsubscribes = [current.graphStack.subscribe(bump), current.instancePath.subscribe(bump), current.store.document.subscribe(bump)]
    onCleanup(() => { for (const unsubscribe of unsubscribes) unsubscribe() })
  })
  return createMemo(() => {
    tick()
    const current = tab()
    if (current === undefined) return undefined
    const doc = current.store.doc
    const graphId = currentGraphId(current)
    const instancePath = viewInstancePath(current)
    const selected = selection()
    const context = deriveFocusContext({
      widget: widget(),
      nodes: selected.nodes,
      links: selected.links,
      groups: selected.groups.map((id) => ({
        id,
        title: doc.view.graphs[graphId]?.groups?.[id]?.title ?? id,
        members: bridge()?.groupMembers(graphId, id) ?? [],
      })),
      graphId,
      rootGraphId: doc.root,
      instancePath,
    })
    return { tab: current, doc, graphId, instancePath, context }
  })
}
