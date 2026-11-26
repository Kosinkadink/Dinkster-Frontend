import { createRoot, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { Images } from 'lucide-solid'
import { describe, expect, it, vi } from 'vitest'
import { createPageTabHost, type PageTab } from '../src/page-tabs.js'
import { App } from '../src/App.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'
import { runSearchAction } from '../src/universal-search.js'
import {
  layoutGroups,
  repairEditorLayout,
  singleGroupLayout,
  splitGroup,
} from '../src/editor-layout.js'

vi.mock('../src/CanvasHost.js', async (original) => ({
  ...(await original<typeof import('../src/CanvasHost.js')>()),
  CanvasHost: () => <div data-testid="workflow-editor" />,
}))

interface Workflow {
  readonly id: string
  readonly title: string
}

function fixture(
  run: (
    host: ReturnType<typeof createPageTabHost<Workflow>>,
    enabled: (value: boolean) => void,
  ) => void | Promise<void>,
) {
  return createRoot(async (dispose) => {
    const [tabs, setTabs] = createSignal<readonly (Workflow | PageTab)[]>([
      { id: 'left', title: 'Left' },
    ])
    const [activeId, setActiveId] = createSignal('left')
    const [enabled, setEnabled] = createSignal(true)
    const host = createPageTabHost<Workflow>({
      tabs,
      setTabs,
      activeId,
      setActiveId,
    })
    host.register({
      id: 'board',
      title: 'Board',
      icon: Images,
      component: () => null,
      enabled,
    })
    try {
      await run(host, setEnabled)
    } finally {
      dispose()
    }
  })
}

describe('page tab host', () => {
  it('opens by page id once, preserves opening parameters and focuses the existing tab', () =>
    fixture((host) => {
      const parameters = { pick: 'image' }
      const first = host.open('board', parameters)!
      host.setTabs([...host.tabs(), { id: 'right', title: 'Right' }])
      host.setActiveId('right')
      expect(host.open('board', { pick: 'audio' })).toBe(first)
      expect(host.tabs().map((tab) => tab.id)).toEqual([
        'left',
        first.id,
        'right',
      ])
      expect(host.activeId()).toBe(first.id)
      expect(first.parameters).toBe(parameters)
      expect(host.open('missing')).toBeUndefined()
    }))

  it('replaces a middle page in place, activates its workflow, and deduplicates an already published workflow', () =>
    fixture((host) => {
      const page = host.open('board')!
      host.setTabs([
        { id: 'opened', title: 'Old title' },
        ...host.tabs(),
        { id: 'right', title: 'Right' },
      ])
      expect(
        host.replaceWithWorkflow(page, { id: 'opened', title: 'Opened' }),
      ).toBe(true)
      expect(host.tabs()).toEqual([
        { id: 'left', title: 'Left' },
        { id: 'opened', title: 'Opened' },
        { id: 'right', title: 'Right' },
      ])
      expect(host.activeId()).toBe('opened')
      const reopened = host.open('board')!
      expect(
        host.replaceWithWorkflow(page, { id: 'late', title: 'Late' }),
      ).toBe(false)
      expect(host.activeId()).toBe(reopened.id)
      host.close(reopened.id)
      expect(host.tabs().map((tab) => tab.id)).toEqual([
        'left',
        'opened',
        'right',
      ])
    }))

  it('removes disabled and unregistered pages, repairs selection, and never reopens them on reenable', () =>
    fixture(async (host, setEnabled) => {
      const page = host.open('board')!
      host.setTabs([...host.tabs(), { id: 'right', title: 'Right' }])
      await Promise.resolve()
      setEnabled(false)
      expect(host.tabs().map((tab) => tab.id)).toEqual(['left', 'right'])
      expect(host.activeId()).toBe('right')
      expect(host.open('board')).toBeUndefined()
      setEnabled(true)
      expect(host.tabs().map((tab) => tab.id)).toEqual(['left', 'right'])
      const remove = createRoot((dispose) => {
        const unregister = host.register({
          id: 'picker',
          title: 'Picker',
          icon: Images,
          component: () => null,
        })
        return () => {
          unregister()
          dispose()
        }
      })
      host.open('picker')
      remove()
      expect(host.activeId()).toBe('right')
      expect(host.open('picker')).toBeUndefined()
      host.close(page.id)
      host.close('left')
      host.close('right')
      expect(host.tabs()).toEqual([])
      expect(host.activeId()).toBe('')
    }))
})

describe('app page tabs', () => {
  it('opens Settings once and applies later search requests to the existing page without changing workflow tabs', async () => {
    const app = createWorkflowApp()
    const workflows = app.tabs.get()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <App app={app} />, root)
    try {
      app.commands.get('settings.open')!.run()
      await vi.waitFor(() => expect(root.querySelector('.dinkster-settings-host')).not.toBeNull())
      expect(app.pages.tabs().filter((tab) => tab.id === 'page:settings')).toHaveLength(1)
      expect(root.querySelector('[aria-modal="true"]')).toBeNull()
      app.commands.get('settings.open')!.run()
      expect(app.pages.tabs().filter((tab) => tab.id === 'page:settings')).toHaveLength(1)
      runSearchAction(app, { kind: 'host', action: 'settings.open', params: { category: 'canvas.grid', id: 'canvas.grid.visible' } })
      await vi.waitFor(() => expect(document.activeElement?.id).toBe('setting-canvas.grid.visible'))
      runSearchAction(app, { kind: 'host', action: 'settings.open', params: { category: 'search', id: 'search.registryUrl' } })
      await vi.waitFor(() => expect(document.activeElement?.id).toBe('setting-search.registryUrl'))
      expect(app.pages.tabs().filter((tab) => tab.id === 'page:settings')).toHaveLength(1)
      expect(app.tabs.get()).toBe(workflows)
      expect(app.activeTabId.get()).toBe('page:settings')
      const search = root.querySelector<HTMLInputElement>('.dinkster-search-input')!
      for (const definition of app.settings.list()) {
        if (['keybindings.overrides', 'search.recentActivations'].includes(definition.id)) continue
        search.value = definition.id
        search.dispatchEvent(new InputEvent('input', { bubbles: true }))
        expect(root.querySelector(`[data-setting-id="${definition.id}"]`), definition.id).not.toBeNull()
      }
      for (const command of app.commands.list()) {
        search.value = command.id
        search.dispatchEvent(new InputEvent('input', { bubbles: true }))
        expect(root.querySelector(`[data-command-id="${command.id}"]`), command.id).not.toBeNull()
      }
      app.pages.close('page:settings')
      await vi.waitFor(() => expect(root.querySelector('.dinkster-settings-host')).toBeNull())
      expect(app.activeTab()).toBeDefined()
    } finally {
      dispose()
      app.dispose()
      root.remove()
      vi.unstubAllGlobals()
    }
  })

  it('renders pages in the shared shell, keeps workflows separate, and confirms discarding a dirty page', async () => {
    const app = createWorkflowApp()
    const workflows = app.tabs.get()
    const root = document.createElement('div')
    document.body.append(root)
    let dispose = () => {}
    const unregister = app.pages.register({
      id: 'board',
      title: 'Board',
      icon: Images,
      dirty: () => true,
      component: (context) => <h2>{String(context.tab.parameters)}</h2>,
    })
    try {
      app.pages.open('board', 'Selected image')
      dispose = render(() => <App app={app} />, root)
      await vi.waitFor(() =>
        expect(root.querySelector('[role="tabpanel"]')?.textContent).toContain(
          'Selected image',
        ),
      )
      expect(app.tabs.get()).toBe(workflows)
      expect(app.activeTab()).toBeUndefined()
      expect(root.querySelector('[data-testid="workflow-editor"]')).toBeNull()
      root
        .querySelector<HTMLButtonElement>('[aria-label="Close Board"]')!
        .click()
      await vi.waitFor(() =>
        expect(
          root.querySelector('[data-testid="close-tab-dialog"]'),
        ).not.toBeNull(),
      )
      expect(app.pages.tabs().some((tab) => tab.id === 'page:board')).toBe(true)
      const discard = [
        ...root.querySelectorAll<HTMLButtonElement>(
          '[data-testid="close-tab-dialog"] button',
        ),
      ].find((button) => button.textContent === 'Close and discard')!
      discard.click()
      await vi.waitFor(() =>
        expect(
          root.querySelector('[data-testid="workflow-editor"]'),
        ).not.toBeNull(),
      )
      expect(app.pages.tabs()).toEqual(workflows)
      expect(app.activeTab()).toBeDefined()
    } finally {
      unregister()
      dispose()
      app.dispose()
      root.remove()
      vi.unstubAllGlobals()
    }
  })

  it('replaces a page in its split group with an already published workflow and preserves its session', () => {
    const app = createWorkflowApp()
    const unregister = app.pages.register({
      id: 'templates',
      title: 'Templates',
      icon: Images,
      component: () => null,
    })
    try {
      const first = app.tabs.get()[0]!
      const workflow = app.createWorkflow()
      const page = app.pages.open('templates')!
      const before = splitGroup(
        singleGroupLayout(app.pages.tabs().map((tab) => tab.id)),
        'group-1',
        'row',
        page.id,
      )
      app.editorSplits.layout.set(before)
      const pageGroup = layoutGroups(before.root).find((group) =>
        group.tabIds.includes(page.id),
      )!.id
      expect(app.pages.replaceWithWorkflow(page, workflow)).toBe(true)
      const layout = repairEditorLayout(
        app.editorSplits.layout.get(),
        app.pages.tabs().map((tab) => tab.id),
      )
      expect(
        layoutGroups(layout.root).find((group) => group.id === pageGroup)
          ?.tabIds,
      ).toEqual([workflow.id])
      expect(app.pages.activeId()).toBe(workflow.id)
      expect(app.activeTab()?.store).toBe(workflow.store)
      expect(app.tabs.get()).toEqual([first, workflow])
      expect(app.pages.tabs()).toEqual([first, workflow])
      const reopened = app.pages.open('templates')!
      expect(
        layoutGroups(app.editorSplits.layout.get().root).find(
          (group) => group.id === pageGroup,
        )?.tabIds,
      ).toEqual([workflow.id, reopened.id])
      unregister()
      expect(app.pages.tabs()).toEqual([first, workflow])
      expect(app.activeTabId.get()).toBe(workflow.id)
    } finally {
      unregister()
      app.dispose()
      vi.unstubAllGlobals()
    }
  })
})
