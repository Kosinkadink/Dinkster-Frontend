import { createSignal, type Signal } from '@dinkster/core'
import type { Tab } from './app-state.js'
import type { EditorSplitStore } from './editor-split-store.js'
import {
  focusGroup,
  focusedGroup,
  layoutGroups,
  moveTabToGroup,
  repairEditorLayout,
} from './editor-layout.js'
import { createPageTabHost, isPageTab, type PageTab } from './page-tabs.js'

export type AppTab = Tab | PageTab

/** Session-only shell tabs; document persistence and execution retain real workflows. */
export function createAppPageTabs(state: {
  readonly tabs: Signal<readonly Tab[]>
  readonly activeTabId: Signal<string>
  readonly editorSplits: EditorSplitStore
}) {
  const tabs = createSignal<readonly AppTab[]>(state.tabs.get())
  const unsubscribe = state.tabs.subscribe((workflows) => {
    const byId = new Map(workflows.map((tab) => [tab.id, tab]))
    const previous = tabs.get()
    const retained = new Set(previous.map((tab) => tab.id))
    const ordered = workflows.filter((tab) => retained.has(tab.id))
    let index = 0
    tabs.set([
      ...previous.flatMap((tab): AppTab[] => {
        if (isPageTab(tab)) return [tab]
        return byId.has(tab.id) ? [ordered[index++]!] : []
      }),
      ...workflows.filter((tab) => !retained.has(tab.id)),
    ])
  })
  const host = createPageTabHost<Tab>({
    tabs: () => tabs.get(),
    setTabs: (next) => {
      const active = state.activeTabId.get()
      const previousTabs = tabs.get()
      const addedPage = next.some(
        (tab) => isPageTab(tab) && !previousTabs.includes(tab),
      )
      const removedActive = !next.some((tab) => tab.id === active)
      if (addedPage || removedActive) {
        const before = repairEditorLayout(
          state.editorSplits.layout.get(),
          previousTabs.map((tab) => tab.id),
        )
        const owner = layoutGroups(before.root).find((group) =>
          group.tabIds.includes(active),
        )
        const remaining = repairEditorLayout(
          owner ? focusGroup(before, owner.id) : before,
          next.map((tab) => tab.id),
        )
        state.editorSplits.layout.set(remaining)
        if (removedActive)
          state.activeTabId.set(focusedGroup(remaining).activeTabId)
      }
      tabs.set(next)
      const workflows = next.filter((tab): tab is Tab => !isPageTab(tab))
      const previous = state.tabs.get()
      if (
        workflows.length !== previous.length ||
        workflows.some((tab, index) => tab !== previous[index])
      )
        state.tabs.set(workflows)
    },
    activeId: () => state.activeTabId.get(),
    setActiveId: (id) => state.activeTabId.set(id),
    onReplace: (page, workflow) => {
      const ids = tabs.get().map((tab) => tab.id)
      const layout = repairEditorLayout(state.editorSplits.layout.get(), ids)
      const group = layoutGroups(layout.root).find((group) =>
        group.tabIds.includes(page.id),
      )!
      const withWorkflow = repairEditorLayout(layout, [
        ...new Set([...ids, workflow.id]),
      ])
      state.editorSplits.layout.set(
        repairEditorLayout(
          moveTabToGroup(
            withWorkflow,
            workflow.id,
            group.id,
            group.tabIds.indexOf(page.id),
          ),
          ids.filter((id) => id !== page.id).concat(workflow.id),
        ),
      )
    },
  })
  return {
    ...host,
    changed: tabs,
    dispose: () => {
      unsubscribe()
      host.dispose()
    },
  }
}
