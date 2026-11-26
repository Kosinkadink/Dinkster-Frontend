import {
  batch,
  createComponent,
  createEffect,
  createRoot,
  getOwner,
  onCleanup,
  Show,
  type Accessor,
  type JSX,
} from 'solid-js'
import type { WorkflowTabItem } from './WorkflowTabs.js'

export interface PageTab extends WorkflowTabItem {
  readonly editorKind: 'page'
  readonly pageId: string
  readonly parameters?: unknown
}

export const isPageTab = (tab: WorkflowTabItem): tab is PageTab =>
  tab.editorKind === 'page'

export interface PageTabContext<T extends WorkflowTabItem> {
  readonly tab: PageTab
  readonly close: () => void
  readonly replaceWithWorkflow: (workflow: T) => boolean
}

export interface PageTabDescriptor<T extends WorkflowTabItem> {
  readonly id: string
  readonly title: string
  readonly icon: NonNullable<WorkflowTabItem['icon']>
  readonly component: (context: PageTabContext<T>) => JSX.Element
  readonly enabled?: Accessor<boolean>
  readonly dirty?: Accessor<boolean>
  readonly save?: () => void | Promise<void>
  readonly snapshot?: () => unknown
}

/** Pages share tab order and selection, but never need a workflow document. */
export function createPageTabHost<T extends WorkflowTabItem>(state: {
  readonly tabs: Accessor<readonly (T | PageTab)[]>
  readonly setTabs: (tabs: readonly (T | PageTab)[]) => void
  readonly activeId: Accessor<string>
  readonly setActiveId: (id: string) => void
  readonly onReplace?: (page: PageTab, workflow: T) => void
}) {
  const pages = new Map<string, PageTabDescriptor<T>>()
  const registrations = new Set<() => void>()
  const close = (id: string): void => {
    const before = state.tabs()
    const index = before.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const remaining = before.filter((tab) => tab.id !== id)
    batch(() => {
      state.setTabs(remaining)
      if (state.activeId() === id)
        state.setActiveId(
          remaining[Math.min(index, remaining.length - 1)]?.id ?? '',
        )
    })
  }
  const replaceWithWorkflow = (page: PageTab, workflow: T): boolean => {
    const before = state.tabs()
    // A late picker result must not replace a reopened instance of its page.
    if (
      !before.includes(page) ||
      isPageTab(workflow) ||
      before.some(
        (tab) => tab.id === workflow.id && isPageTab(tab) && tab !== page,
      )
    )
      return false
    // Workflow opening can publish its tab before the page receives it.
    // Keep that workflow once, at the page's position among its neighbours.
    batch(() => {
      state.onReplace?.(page, workflow)
      state.setTabs(
        before
          .filter((tab) => tab.id !== workflow.id || tab === page)
          .map((tab) => (tab === page ? workflow : tab)),
      )
      state.setActiveId(workflow.id)
    })
    return true
  }
  const open = (pageId: string, parameters?: unknown): PageTab | undefined => {
    const page = pages.get(pageId)
    if (!page || page.enabled?.() === false) return undefined
    const existing = state
      .tabs()
      .find((tab): tab is PageTab => isPageTab(tab) && tab.pageId === pageId)
    if (existing) {
      state.setActiveId(existing.id)
      return existing
    }
    const id = `page:${pageId}`
    if (state.tabs().some((tab) => tab.id === id))
      throw new Error(`page tab id already in use: ${id}`)
    const tab: PageTab = {
      id,
      title: page.title,
      icon: page.icon,
      editorKind: 'page',
      pageId,
      parameters,
    }
    batch(() => {
      state.setTabs([...state.tabs(), tab])
      state.setActiveId(id)
    })
    return tab
  }
  const register = (page: PageTabDescriptor<T>): (() => void) => {
    if (pages.has(page.id))
      throw new Error(`page already registered: ${page.id}`)
    pages.set(page.id, page)
    const dispose = createRoot((dispose) => {
      createEffect(() => {
        if (page.enabled?.() === false) {
          for (const tab of state.tabs())
            if (isPageTab(tab) && tab.pageId === page.id) close(tab.id)
        }
      })
      return dispose
    })
    let registered = true
    const unregister = () => {
      if (!registered) return
      registered = false
      dispose()
      registrations.delete(unregister)
      pages.delete(page.id)
      for (const tab of state.tabs())
        if (isPageTab(tab) && tab.pageId === page.id) close(tab.id)
    }
    registrations.add(unregister)
    if (getOwner()) onCleanup(unregister)
    return unregister
  }
  return {
    ...state,
    register,
    open,
    close,
    replaceWithWorkflow,
    descriptor: (id: string) => pages.get(id),
    dispose: () => {
      for (const unregister of registrations) unregister()
    },
  }
}

export function PageTabPanel<T extends WorkflowTabItem>(props: {
  readonly host: ReturnType<typeof createPageTabHost<T>>
  readonly tab: PageTab
}) {
  return (
    <Show when={props.tab} keyed>
      {(tab) => {
        const page = props.host.descriptor(tab.pageId)
        return (
          page &&
          createComponent(page.component, {
            tab,
            close: () => {
              if (props.host.tabs().includes(tab)) props.host.close(tab.id)
            },
            replaceWithWorkflow: (workflow) =>
              props.host.replaceWithWorkflow(tab, workflow),
          })
        )
      }}
    </Show>
  )
}
