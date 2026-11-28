import { createRoot, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { buildDinksterRegistry } from '@dinkster/client'
import nodesPayload from '../../core/fixtures/dinkster-nodes.json'
import { Images } from 'lucide-solid'
import { describe, expect, it, vi } from 'vitest'
import { createPageTabHost, PageTabPanel, type PageTab } from '../src/page-tabs.js'
import { App } from '../src/App.js'
import { ASSET_DRAG_TYPE } from '../src/asset-browser/drag.js'
import * as boardMedia from '../src/board-media.js'
import { setPanelOpen } from '../src/panel-location.js'
import { BOARD_MEDIA_TYPE, asPromptId, boundaryOf, emptyBoard, exposedKey, loadDocument } from '@dinkster/core'
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
  it('clears a receiving section when a dragged Board item is removed by another edit', () => {
    const app = createWorkflowApp()
    const root = document.createElement('div')
    document.body.append(root)
    let dispose = () => {}
    try {
      app.commands.get('board.new')!.run()
      const entry = app.boards.entries.get()[0]!
      entry.session.dispatch({ command: 'board.item.add', params: { items: [
        { id: 'section', kind: 'section', name: 'References', rect: { x: 0, y: 0, width: 600, height: 400 } },
        { id: 'dragged', kind: 'note', text: 'Removed while dragging', rect: { x: 50, y: 80, width: 180, height: 80 } },
        { id: 'survivor', kind: 'note', text: 'Keep this reference', rect: { x: 300, y: 100, width: 180, height: 80 } },
      ] } })
      const tab = app.pages.tabs().find((tab) => tab.id === `page:board:${entry.id}`) as PageTab
      dispose = render(() => <PageTabPanel host={app.pages} tab={tab} />, root)
      const dragged = root.querySelector<HTMLElement>('[data-board-item="dragged"]')!
      // happy-dom has no pointer capture; browser checks exercise real capture.
      dragged.setPointerCapture = () => {}
      dragged.hasPointerCapture = () => false
      dragged.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 90, clientY: 180, bubbles: true }))
      dragged.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 120, clientY: 200 }))
      const section = root.querySelector('[data-board-item="section"]')!
      expect(section.getAttribute('data-drop-target')).toBe('true')
      entry.session.dispatch({ command: 'board.item.remove', params: { ids: ['dragged'] } })
      expect(root.querySelector('[data-board-item="dragged"]')).toBeNull()
      expect(section.getAttribute('data-drop-target')).toBe('false')
      expect(root.querySelector('[data-board-item="survivor"]')?.textContent).toContain('Keep this reference')
    } finally {
      dispose()
      app.dispose()
      root.remove()
      vi.unstubAllGlobals()
    }
  })

  it('keeps the later Board active when an earlier Library open finishes last', async () => {
    const app = createWorkflowApp()
    const root = document.createElement('div')
    document.body.append(root)
    let dispose = () => {}
    const backend = app.backends.get()[0]!
    vi.spyOn(backend.connection, 'fetchMountSettings').mockResolvedValue({ mounts: [], mountChangesAllowed: false })
    const earlier = emptyBoard()
    const later = emptyBoard()
    const record = (id: string) => ({
      id, scope: 'local', name: id, digest: `blake3:${id.repeat(64)}`, mediaType: BOARD_MEDIA_TYPE,
      labels: ['board'], created: 1, modified: 2, revision: 1,
    })
    vi.spyOn(backend.connection, 'listLibrary').mockResolvedValue({ records: [record('a'), record('b')] })
    vi.spyOn(backend.connection, 'getLibraryRecord').mockImplementation(async (id) => record(id))
    let release!: (text: string) => void
    let requested!: () => void
    const started = new Promise<void>((resolve) => { requested = resolve })
    const pending = new Promise<string>((resolve) => { release = resolve })
    vi.spyOn(backend.connection, 'fetchAssetText').mockImplementation(async (digest) => {
      if (digest !== record('a').digest) return JSON.stringify(later)
      requested()
      return pending
    })
    const openSaved = app.boards.openSaved.bind(app.boards)
    let opening!: ReturnType<typeof openSaved>
    vi.spyOn(app.boards, 'openSaved').mockImplementation((...args) => {
      const result = openSaved(...args)
      if (args[0] === 'a') opening = result
      return result
    })
    try {
      app.settings.set('features.board.enabled', true)
      dispose = render(() => <App app={app} />, root)
      setPanelOpen(app.panels, app.dock, 'library', 'left', true)
      root.querySelector<HTMLButtonElement>('[data-source="boards"]')!.click()
      await vi.waitFor(() => expect(root.querySelector('[data-entry="a"]')).not.toBeNull())
      root.querySelector<HTMLElement>('[data-entry="a"]')!.click()
      await started
      root.querySelector<HTMLElement>('[data-entry="b"]')!.click()
      await vi.waitFor(() => expect(app.pages.activeId()).toBe(`page:board:${later.lineage}`))
      setPanelOpen(app.panels, app.dock, 'library', 'left', true)
      release(JSON.stringify(earlier))
      await Promise.allSettled([opening])
      expect(app.pages.activeId()).toBe(`page:board:${later.lineage}`)
      expect(root.querySelector('[data-testid="library-overlay"]')).not.toBeNull()
    } finally {
      dispose()
      app.dispose()
      root.remove()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })

  it('reopens saved Boards from their Library backend without loading them as workflows', async () => {
    const app = createWorkflowApp()
    const root = document.createElement('div')
    document.body.append(root)
    let dispose = () => {}
    const backend = app.addBackend('http://board-library:8000', 'Board library', false, 'dinkster')!
    backend.registry.set(app.registry.get())
    vi.spyOn(backend.connection, 'fetchMountSettings').mockResolvedValue({ mounts: [], mountChangesAllowed: false })
    const board = { ...emptyBoard(), order: ['note'], items: { note: {
      id: 'note', kind: 'note' as const, text: 'Library reference text', rect: { x: 35, y: 70, width: 180, height: 90 },
    } } }
    const record = {
      id: 'reference-board', scope: 'local', name: 'Reference Board', digest: `blake3:${'b'.repeat(64)}`,
      mediaType: BOARD_MEDIA_TYPE, labels: ['board'], created: 1, modified: 2, revision: 3,
    }
    vi.spyOn(backend.connection, 'listLibrary').mockResolvedValue({ records: [record] })
    vi.spyOn(backend.connection, 'getLibraryRecord').mockResolvedValue(record)
    vi.spyOn(backend.connection, 'fetchAssetText').mockResolvedValue(JSON.stringify(board))
    const workflow = app.tabs.get()[0]!
    app.setTabTarget(workflow.id, backend.id)
    app.disconnectBackend(backend)
    const workflows = app.tabs.get()
    try {
      expect(app.settings.get('features.board.enabled')).toBe(true)
      app.settings.set('features.board.enabled', false)
      dispose = render(() => <App app={app} />, root)
      setPanelOpen(app.panels, app.dock, 'library', 'left', true)
      expect(root.querySelector('[data-source="boards"]')).toBeNull()
      app.settings.set('features.board.enabled', true)
      root.querySelector<HTMLButtonElement>('[data-source="boards"]')!.click()
      await vi.waitFor(() => expect(root.querySelector('[data-entry="reference-board"]'), root.textContent ?? '').not.toBeNull())
      root.querySelector<HTMLElement>('[data-entry="reference-board"]')!.click()
      await vi.waitFor(() => expect(app.pages.activeId()).toBe(`page:board:${board.lineage}`))
      expect(app.boards.entries.get()[0]?.session.doc).toEqual(board)
      expect(app.boards.isDirty(board.lineage)).toBe(false)
      expect(app.libraryBackend()).toBe(backend)
      setPanelOpen(app.panels, app.dock, 'library', 'left', true)
      expect(root.querySelector('.library-backend-context strong')?.textContent).toBe('Board library')
      expect(app.tabs.get()).toEqual(workflows)
      app.pages.close(`page:board:${board.lineage}`)
      expect(app.boards.entries.get()).toEqual([])
      setPanelOpen(app.panels, app.dock, 'library', 'left', true)
      root.querySelector<HTMLButtonElement>('[data-source="boards"]')!.click()
      await vi.waitFor(() => expect(root.querySelector('[data-entry="reference-board"]')).not.toBeNull())
      root.querySelector<HTMLElement>('[data-entry="reference-board"]')!.click()
      await vi.waitFor(() => expect(app.pages.activeId()).toBe(`page:board:${board.lineage}`))
      expect(app.boards.entries.get()[0]?.session.doc).toEqual(board)
      expect(app.tabs.get()).toEqual(workflows)
    } finally {
      dispose()
      app.dispose()
      root.remove()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })

  it('saves the active Board, tracks dirty undo, reports refused saves, and never saves through a page without a save handler', async () => {
    const app = createWorkflowApp()
    const root = document.createElement('div')
    document.body.append(root)
    let dispose = () => {}
    const digest = `blake3:${'a'.repeat(64)}`
    let uploaded = ''
    const upload = vi.spyOn(app.connection, 'uploadAsset').mockImplementation(async (text) => { uploaded = String(text); return digest })
    vi.spyOn(app.connection, 'createLibraryRecord').mockImplementation(async (value) => ({
      ...value, id: 'saved-board', labels: value.labels ?? [], created: 1, modified: 1, revision: 1,
    }))
    vi.spyOn(app.connection, 'patchLibraryRecord').mockRejectedValue(new Error('Board write refused'))
    try {
      app.settings.set('features.board.enabled', true)
      app.commands.get('board.new')!.run()
      const entry = app.boards.entries.get()[0]!
      entry.session.dispatch({ command: 'board.item.add', params: { items: [
        { id: 'note', kind: 'note', text: 'Saved Board text', rect: { x: 20, y: 30, width: 180, height: 80 } },
      ] } })
      dispose = render(() => <App app={app} />, root)
      const dirty = () => root.querySelector(`[data-tab-id="page:board:${entry.id}"]`)!.querySelector('.tab-dirty')
      const save = app.commands.get('workflow.save')!
      expect(save.enabled?.()).toBe(true)
      const shortcut = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
      window.dispatchEvent(shortcut)
      expect(shortcut.defaultPrevented).toBe(true)
      await vi.waitFor(() => expect(app.boards.isDirty(entry.id)).toBe(false))
      expect(JSON.parse(uploaded).items.note.text).toBe('Saved Board text')
      expect(save.enabled?.()).toBe(false)
      expect(dirty()).toBeNull()
      entry.session.dispatch({ command: 'board.note.edit', params: { id: 'note', text: 'Unsaved Board text' } })
      expect(save.enabled?.()).toBe(true)
      expect(dirty()).not.toBeNull()
      entry.session.undo()
      expect(save.enabled?.()).toBe(false)
      expect(dirty()).toBeNull()
      entry.session.redo()
      save.run()
      await vi.waitFor(() => expect(root.querySelector('.board-page [role="alert"]')?.textContent).toContain('Board write refused'))
      expect(app.boards.isDirty(entry.id)).toBe(true)
      root.querySelector<HTMLButtonElement>('.board-page [role="alert"] button')!.click()
      expect(root.querySelector('.board-page [role="alert"]')).toBeNull()
      entry.session.undo()
      app.pages.register({ id: 'readonly', title: 'Read only', icon: Images, dirty: () => true, component: () => <h2>Read only</h2> })
      app.pages.open('readonly')
      const bytes = uploaded
      const count = upload.mock.calls.length
      expect(save.enabled?.()).toBe(false)
      save.run()
      await Promise.resolve()
      expect(upload.mock.calls.length).toBe(count)
      expect(uploaded).toBe(bytes)
      app.pages.close('page:readonly')
      app.pages.open(`board:${entry.id}`)
      root.querySelector<HTMLButtonElement>('[aria-label="Close Board"]')!.click()
      expect(root.querySelector('[data-testid="close-tab-dialog"]')).toBeNull()
      expect(app.boards.entries.get()).toEqual([])
    } finally {
      dispose()
      app.dispose()
      root.remove()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })

  it('chooses workflows and both blueprint sources from the Board backend, cancels late placement, and selects undoable independent cards', async () => {
    const app = createWorkflowApp()
    const tabs = app.tabs.get()
    const root = document.createElement('div')
    document.body.append(root)
    let dispose = () => {}
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.setAttribute('open', '') })
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) { this.removeAttribute('open') })
    const record = { id: 'saved-card', scope: 'local', name: 'Saved card', digest: `blake3:${'c'.repeat(64)}`,
      mediaType: 'application/x-dinkster-workflow+json', labels: ['workflow'], created: 1, modified: 2, revision: 1 }
    const source = { format: 'dinkster-workflow', formatVersion: 1, lineage: 'card-source', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Source', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 } },
      view: { graphs: {} } }
    const bytes = JSON.stringify(source)
    const backend = app.addBackend('http://board-cards:8000', 'Card sources', false, 'dinkster')!
    vi.spyOn(app.connection, 'listLibrary').mockRejectedValue(new Error('Wrong backend'))
    vi.spyOn(backend.connection, 'listLibrary').mockResolvedValue({ records: [record] })
    vi.spyOn(backend.connection, 'getLibraryRecord').mockResolvedValue(record)
    let release!: (text: string) => void
    const fetch = vi.spyOn(backend.connection, 'fetchAssetText').mockImplementation(() => new Promise((resolve) => { release = resolve }))
    try {
      const entry = app.boards.open(emptyBoard(), 'Cards', backend.baseUrl)
      app.pages.open(`board:${entry.id}`)
      const tab = app.pages.tabs().find((tab) => tab.id === `page:board:${entry.id}`) as PageTab
      dispose = render(() => <PageTabPanel host={app.pages} tab={tab} />, root)
      const choose = async (kind = 'Workflow', row = 'saved-card') => {
        [...root.querySelectorAll<HTMLButtonElement>('.dinkster-board button')].find((button) => button.textContent === 'Add')!.click()
        const workflow = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === kind)!
        workflow.click()
        await vi.waitFor(() => expect([...root.querySelectorAll('[data-entry]')].some((item) => item.getAttribute('data-entry') === row)).toBe(true))
      }
      await choose()
      root.querySelector<HTMLButtonElement>('[data-testid="board-card-picker"] [data-testid="modal-close"]')!.click()
      expect(entry.session.doc.order).toEqual([])
      await choose()
      root.querySelector<HTMLElement>('[data-entry="saved-card"]')!.click()
      expect(entry.session.doc.order).toEqual([])
      root.querySelector<HTMLButtonElement>('.library-detail-rail button')!.click()
      await vi.waitFor(() => expect(release).toBeDefined())
      root.querySelector<HTMLButtonElement>('[data-testid="board-card-picker"] [data-testid="modal-close"]')!.click()
      release(bytes)
      await Promise.resolve()
      expect(entry.session.doc.order).toEqual([])
      expect(entry.session.canUndo).toBe(false)
      fetch.mockResolvedValue(bytes)
      for (let i = 0; i < 2; i++) {
        await choose()
        root.querySelector<HTMLElement>('[data-entry="saved-card"]')!.click()
        expect(entry.session.doc.order).toHaveLength(i)
        root.querySelector<HTMLButtonElement>('.library-detail-rail button')!.click()
        await vi.waitFor(() => expect(entry.session.doc.order).toHaveLength(i + 1))
        const id = entry.session.doc.order[i]!
        await vi.waitFor(() => expect(root.querySelector(`[data-board-item="${id}"]`)?.getAttribute('data-selected')).toBe('true'))
      }
      const [first, second] = entry.session.doc.order.map((id) => entry.session.doc.items[id]!)
      expect(first).toMatchObject({ kind: 'workflow', name: 'Saved card', source: { kind: 'library', recordId: 'saved-card' }, values: {} })
      expect(second!.rect.x - first!.rect.x).toBe(24)
      expect(second!.rect.y - first!.rect.y).toBe(24)
      expect(entry.session.undo()).toBe(true)
      expect(entry.session.doc.order).toHaveLength(1)
      expect(root.querySelector('.dinkster-board-card')?.textContent).toContain('Saved card')
      expect(app.tabs.get()).toEqual(tabs)
      const blueprint = { ...source, graphs: { g0: { ...source.graphs.g0, boundary: boundaryOf([], []) } } }
      const digest = `sha256:${'d'.repeat(64)}`
      backend.registry.set({ ...app.registry.get()!, connection: backend.id, packs: new Map([['pack', { displayName: 'Installed pack',
        blueprints: [{ id: 'saved-card', name: 'Pack card', digest }],
      }]]) })
      vi.mocked(backend.connection.listLibrary).mockResolvedValue({ records: [{ ...record, labels: ['blueprint'] }] })
      vi.mocked(backend.connection.getLibraryRecord).mockResolvedValue({ ...record, labels: ['blueprint'] })
      fetch.mockResolvedValue(JSON.stringify(blueprint))
      vi.spyOn(backend.connection, 'fetchBlueprintBody').mockResolvedValue(loadDocument(blueprint).document)
      await choose('Blueprint', 'saved:saved-card')
      root.querySelector<HTMLElement>('[data-entry="saved:saved-card"]')!.click()
      expect(entry.session.doc.order).toHaveLength(1)
      root.querySelector<HTMLButtonElement>('.library-detail-rail button')!.click()
      await vi.waitFor(() => expect(entry.session.doc.order).toHaveLength(2))
      const saved = entry.session.doc.items[entry.session.doc.order[1]!]!
      expect(saved).toMatchObject({ kind: 'blueprint', source: { kind: 'library', recordId: 'saved-card' } })
      await choose('Blueprint', 'saved:saved-card')
      const packed = [...root.querySelectorAll<HTMLElement>('[data-entry]')].find((item) => item.textContent?.includes('Pack card'))!
      packed.click()
      expect(entry.session.doc.order).toHaveLength(2)
      root.querySelector<HTMLButtonElement>('.library-detail-rail button')!.click()
      await vi.waitFor(() => expect(entry.session.doc.order).toHaveLength(3))
      expect(entry.session.doc.items[entry.session.doc.order[2]!]).toMatchObject({ kind: 'blueprint',
        source: { kind: 'pack', packId: 'pack', blueprintId: 'saved-card', digest } })
      const packCard = root.querySelector<HTMLElement>(`[data-board-item="${entry.session.doc.order[2]}"]`)!
      packCard.querySelector<HTMLButtonElement>('[aria-label="Actions for Pack card"]')!.click()
      expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(['Remove from board'])
      packCard.querySelector<HTMLButtonElement>('[aria-label="Actions for Pack card"]')!.click()
      expect(document.querySelector('[role="menu"]')).toBeNull()
      packCard.querySelector('.dinkster-board-card-name')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      const savedCard = root.querySelector<HTMLElement>(`[data-board-item="${entry.session.doc.order[1]}"]`)!
      savedCard.querySelector<HTMLButtonElement>('[aria-label="Actions for Saved card"]')!.click()
      expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(['Open workflow', 'Choose inputs', 'Remove from board'])
      expect(app.tabs.get()).toEqual(tabs)
    } finally {
      dispose()
      app.dispose()
      root.remove()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })

  it('edits ordered exposed card inputs independently, preserves focus, and restores defaults on undo while the source is offline', async () => {
    const app = createWorkflowApp()
    const root = document.createElement('div')
    document.body.append(root)
    let dispose = () => {}
    const backend = app.addBackend('http://board-inputs:8000', 'Card inputs', false, 'dinkster')!
    backend.registry.set(buildDinksterRegistry(backend.id, nodesPayload))
    const exposed = [
      { graphId: 'g0', nodeId: 'n0', inputId: 'b', label: 'Right' },
      { graphId: 'g0', nodeId: 'n0', inputId: 'a', label: 'Left' },
      { graphId: 'g0', nodeId: 'n1', inputId: 'a', label: 'Linked' },
    ]
    const bytes = JSON.stringify({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'card-controls-source', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Source', nodes: {
        n0: { id: 'n0', type: 'std.math.add_ints', values: { a: 3, b: 4 } },
        n1: { id: 'n1', type: 'std.math.add_ints', values: { b: 10 } },
      }, links: { l0: { id: 'l0', from: { node: 'n0', port: 'sum' }, to: { node: 'n1', port: 'a' } } }, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: {} }, ext: { 'dinkster.exposed': exposed } })
    const record = { id: 'form', scope: 'local', name: 'Arithmetic', digest: `blake3:${'e'.repeat(64)}`,
      mediaType: 'application/x-dinkster-workflow+json', labels: ['workflow'], created: 1, modified: 2, revision: 1 }
    vi.spyOn(backend.connection, 'getLibraryRecord').mockResolvedValue(record)
    const fetch = vi.spyOn(backend.connection, 'fetchAssetText').mockResolvedValue(bytes)
    try {
      const entry = app.boards.open(emptyBoard(), 'Controls', backend.baseUrl)
      const selection = { project: 'default', baseUrl: backend.baseUrl, kind: 'workflow' as const,
        source: { kind: 'library' as const, recordId: record.id }, name: record.name }
      const first = await app.boards.placeCard(entry.id, selection, { x: 300, y: 250 })
      const second = await app.boards.placeCard(entry.id, selection, { x: 700, y: 250 })
      app.pages.open(`board:${entry.id}`)
      const tab = app.pages.tabs().find((tab) => tab.id === `page:board:${entry.id}`) as PageTab
      dispose = render(() => <PageTabPanel host={app.pages} tab={tab} />, root)
      await vi.waitFor(() => expect(root.querySelectorAll('.dinkster-board-card input')).toHaveLength(4))
      const card = () => root.querySelector(`[data-board-item="${first}"]`)!
      expect([...card().querySelectorAll('.app-view-label')].map((label) => label.textContent)).toEqual(['Right', 'Left', 'Linked'])
      expect(card().querySelectorAll('input')).toHaveLength(2)
      const input = card().querySelector<HTMLInputElement>('input')!
      expect(input.value).toBe('4')
      fetch.mockRejectedValue(new Error('Source is offline'))
      input.focus()
      input.value = '17'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await vi.waitFor(() => expect((entry.session.doc.items[first] as { values: object }).values).toEqual({ [exposedKey(exposed[0]!)]: 17 }))
      expect(document.activeElement).toBe(input)
      expect(root.querySelector<HTMLInputElement>(`[data-board-item="${second}"] input`)!.value).toBe('4')
      expect(entry.session.undo()).toBe(true)
      await vi.waitFor(() => expect(input.value).toBe('4'))
      expect(entry.session.redo()).toBe(true)
      await vi.waitFor(() => expect(input.value).toBe('17'))
      expect(app.tabs.get()).toHaveLength(1)
      fetch.mockResolvedValue(bytes)
      vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(`blake3:${'f'.repeat(64)}`)
      const ref = { connection: backend.id, prompt: asPromptId('board-progress') }
      let release!: () => void
      vi.spyOn(backend.connection, 'submit').mockImplementation(() => new Promise((resolve) => {
        release = () => resolve({ ok: true, execution: ref, jobRef: 'board-progress' })
      }))
      ;[...card().querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Run')!.click()
      await vi.waitFor(() => expect(release).toBeDefined())
      expect(root.querySelector('[data-board-pending]')?.textContent).toBe('Preparing')
      expect(root.querySelector('[aria-label="Run progress"]')).toBeNull()
      expect(card().querySelector('footer [role="status"]')?.textContent).toBe('Preparing')
      release()
      await vi.waitFor(() => expect(app.store.get(ref)).toBeDefined())
      expect(root.querySelectorAll('[data-board-pending]')).toHaveLength(1)
      await vi.waitFor(() => expect(root.querySelector('[data-board-pending]')?.textContent).toBe('Queued'))
      expect(root.querySelector('[aria-label="Run progress"]')).toBeNull()
      expect(card().querySelector('footer [role="status"]')?.textContent).toBe('Queued')
      app.store.apply({ kind: 'started', execution: ref, timestamp: 1 })
      app.store.apply({ kind: 'nodeStates', execution: ref, timestamp: 2,
        nodes: { n0: { state: 'done' }, n1: { state: 'running', value: 0.5 } } })
      await vi.waitFor(() => expect(root.querySelector('[aria-label="Run progress"]')?.getAttribute('aria-valuenow')).toBe('0.75'))
      app.store.apply({ kind: 'error', execution: ref, timestamp: 3,
        detail: { exceptionType: 'Error', exceptionMessage: 'Failed before saving', traceback: [] } })
      app.store.hydrateArtifacts(ref, [])
      await vi.waitFor(() => expect(root.querySelectorAll('[data-board-pending]')).toHaveLength(0))
      expect(root.querySelectorAll('[data-board-history]')).toHaveLength(0)
      expect(entry.session.doc.order).toEqual([first, second])
    } finally {
      dispose(); app.dispose(); root.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
    }
  })

  it('requires file confirmation, cancels late uploads without edits, and imports a confirmed batch with undo', async () => {
    const app = createWorkflowApp()
    const root = document.createElement('div')
    document.body.append(root)
    let dispose = () => {}
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.setAttribute('open', '') })
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) { this.removeAttribute('open') })
    vi.spyOn(boardMedia, 'inspectBoardMedia').mockImplementation(async (file) => ({ file, width: 300, height: 600 }))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let uploadSignal: AbortSignal | undefined
    const upload = vi.spyOn(app.connection, 'uploadMediaAsset').mockImplementation(async (file, options) => {
      uploadSignal = options.signal
      await gate
      return { digest: `blake3:${'a'.repeat(64)}`, name: file.name, mediaType: file.type, size: file.size, virtualPath: '' }
    })
    try {
      app.settings.set('features.board.enabled', true)
      app.commands.get('board.new')!.run()
      const entry = app.boards.entries.get()[0]!
      const tab = app.pages.tabs().find((tab) => tab.id === `page:board:${entry.id}`) as PageTab
      dispose = render(() => <PageTabPanel host={app.pages} tab={tab} />, root)
      const input = root.querySelector<HTMLInputElement>('[data-testid="board-media-files"]')!
      const choose = () => {
        Object.defineProperty(input, 'files', { configurable: true, value: [new File(['image'], 'Portrait.png', { type: 'image/png' })] })
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
      const cancel = () => [...root.querySelectorAll<HTMLButtonElement>('[data-testid="board-import-dialog"] button')]
        .find((button) => button.textContent === 'Cancel import')!.click()
      choose()
      expect(root.querySelector('[data-testid="board-import-dialog"]')?.textContent).toContain('Portrait.png')
      expect(upload).not.toHaveBeenCalled()
      cancel()
      expect(entry.session.doc.order).toEqual([])
      choose()
      root.querySelector<HTMLButtonElement>('[data-testid="board-import-confirm"]')!.click()
      await vi.waitFor(() => expect(uploadSignal).toBeDefined())
      cancel()
      expect(uploadSignal!.aborted).toBe(true)
      release()
      await vi.waitFor(() => expect(root.querySelector('[data-testid="board-import-dialog"]')).toBeNull())
      expect(entry.session.doc.order).toEqual([])
      choose()
      root.querySelector<HTMLButtonElement>('[data-testid="board-import-confirm"]')!.click()
      await vi.waitFor(() => expect(entry.session.doc.order).toHaveLength(1))
      expect(entry.session.doc.items[entry.session.doc.order[0]!]!).toMatchObject({
        kind: 'picture', asset: { name: 'Portrait.png', width: 300, height: 600 }, rect: { width: 280, height: 560 },
      })
      expect(entry.session.undo()).toBe(true)
      expect(entry.session.doc.order).toEqual([])
    } finally {
      release()
      dispose()
      app.dispose()
      root.remove()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })

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
        Object.defineProperty(event, 'dataTransfer', { value: { files: [], getData: (type: string) => type === ASSET_DRAG_TYPE ? JSON.stringify(value) : '' } })
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
      expect(app.settings.get('features.board.enabled')).toBe(true)
      expect(app.commands.get('board.new')).toBeDefined()
      app.settings.set('features.board.enabled', false)
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
