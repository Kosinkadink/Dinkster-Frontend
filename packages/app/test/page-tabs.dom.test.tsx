import { createRoot, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { Images } from 'lucide-solid'
import { describe, expect, it, vi } from 'vitest'
import { createPageTabHost, PageTabPanel, type PageTab } from '../src/page-tabs.js'
import { App } from '../src/App.js'
import { ASSET_DRAG_TYPE } from '../src/asset-browser/drag.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'
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
  it('places an Assets drop as an undoable Board edit and retains dismissible refusals until a successful drop', async () => {
    const app = createWorkflowApp()
    const root = document.createElement('div')
    document.body.append(root)
    let dispose = () => {}
    const available = vi.spyOn(app.connection, 'checkAssetAvailability').mockImplementation(async (digests) =>
      digests.map((digest) => ({ digest, status: 'available' as const })))
    try {
      app.settings.set('features.board.enabled', true)
      app.commands.get('board.new')!.run()
      const entry = app.boards.entries.get()[0]!
      const tab = app.pages.tabs().find((tab) => tab.id === `page:board:${entry.id}`) as PageTab
      dispose = render(() => <PageTabPanel host={app.pages} tab={tab} />, root)
      const surface = root.querySelector('.dinkster-board')!
      const drop = (value: unknown) => {
        const event = new Event('drop', { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'dataTransfer', { value: { getData: (type: string) => type === ASSET_DRAG_TYPE ? JSON.stringify(value) : '' } })
        Object.defineProperties(event, { clientX: { value: 70 }, clientY: { value: 90 } })
        surface.dispatchEvent(event)
      }
      const asset = { digest: `blake3:${'a'.repeat(64)}`, name: 'Reference', mediaType: 'image/png', size: 12, virtualPath: '' }
      drop({ project: 'another-project', baseUrl: entry.baseUrl, asset })
      await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('project and backend'))
      expect(entry.session.doc.order).toEqual([])
      drop({ project: 'default', baseUrl: entry.baseUrl, asset: { ...asset, digest: 'invalid' } })
      await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('Invalid media drop'))
      expect(entry.session.doc.order).toEqual([])
      root.querySelector<HTMLButtonElement>('[role="alert"] button')!.click()
      expect(root.querySelector('[role="alert"]')).toBeNull()
      drop({ project: 'another-project', baseUrl: entry.baseUrl, asset })
      await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull())
      drop({ project: 'default', baseUrl: entry.baseUrl, asset })
      await vi.waitFor(() => expect(entry.session.doc.order).toHaveLength(1))
      const item = entry.session.doc.items[entry.session.doc.order[0]!]!
      expect(item.kind).toBe('picture')
      expect(item.rect.x).toBe(54)
      expect(item.rect.y).toBe(10)
      expect(root.querySelector('[role="alert"]')).toBeNull()
      expect(entry.session.undo()).toBe(true)
      expect(entry.session.doc.order).toEqual([])
    } finally {
      available.mockRestore()
      dispose()
      app.dispose()
      root.remove()
      vi.unstubAllGlobals()
    }
  })

  it('opens distinct session-backed Boards only when enabled and releases closed documents without changing workflows', () => {
    const app = createWorkflowApp()
    const workflows = app.tabs.get()
    try {
      expect(app.commands.get('board.new')).toBeUndefined()
      app.settings.set('features.board.enabled', true)
      const create = app.commands.get('board.new')!
      create.run()
      const first = app.boards.entries.get()[0]!
      const firstPage = app.pages.activeId()
      first.session.dispatch({ command: 'board.item.add', params: {
        items: [{ kind: 'note', text: 'Keep this Board separate', rect: { x: 12, y: 34, width: 180, height: 80 } }],
      } })
      create.run()
      const second = app.boards.entries.get()[1]!
      expect(second.id).not.toBe(first.id)
      expect(second.session.doc.order).toEqual([])
      expect(app.pages.descriptor(`board:${first.id}`)?.snapshot?.()).toBe(first.session.doc)
      expect(app.activeTab()).toBeUndefined()
      expect(app.tabs.get()).toBe(workflows)
      app.pages.close(firstPage)
      expect(app.boards.entries.get()).toEqual([second])
      expect(app.pages.descriptor(`board:${first.id}`)).toBeUndefined()
      app.settings.set('features.board.enabled', false)
      expect(app.commands.get('board.new')).toBeUndefined()
      expect(app.boards.entries.get()).toEqual([second])
      app.pages.close(`page:board:${second.id}`)
      expect(app.boards.entries.get()).toEqual([])
      expect(app.pages.tabs()).toEqual(workflows)
      expect(app.activeTab()).toBeDefined()
    } finally {
      app.dispose()
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
