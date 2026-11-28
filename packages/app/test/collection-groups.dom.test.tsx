// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollectionSource } from '@dinkster/core'
import { CollectionPanel } from '../src/CollectionPanel.js'
import { boardBlueprintsSource } from '../src/collections.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

afterEach(() => document.body.replaceChildren())

describe('CollectionPanel grouped rows', () => {
  it('keeps both blueprint sources distinct, ranks all saved pages, and retries partial failures without hiding pack choices', async () => {
    const app = createWorkflowApp()
    const backend = app.backends.get()[0]!
    const registry = backend.registry.get()!
    const digest = `sha256:${'a'.repeat(64)}`
    backend.registry.set({ ...registry, packs: new Map([['pack', { displayName: 'Installed pack', blueprints: [
      { id: 'same', name: 'Moon pack', digest },
    ] }]]) })
    let failed = false
    const record = { id: 'same', scope: 'local', name: 'Moon saved', digest: `blake3:${'b'.repeat(64)}`,
      mediaType: 'application/x-dinkster-workflow+json', labels: ['blueprint'], created: 1, modified: 2, revision: 1 }
    vi.spyOn(backend.connection, 'listLibrary').mockImplementation(async (request) => {
      if (failed) throw new Error('Saved blueprints unavailable')
      if (request.project !== 'board-project') throw new Error('Wrong project')
      return request.cursor ? { records: [record] } : { records: [{ ...record, id: 'other', name: 'Sun' }], cursor: 'second' }
    })
    const source = boardBlueprintsSource(() => backend, 'board-project')
    const root = document.createElement('div')
    document.body.append(root)
    let dispose = () => {}
    try {
      const first = await source.page({ query: 'Moon', limit: 1 })
      const second = await source.page({ query: 'Moon', limit: 1, cursor: first.cursor! })
      expect([...first.items, ...second.items].map((entry) => entry.title).sort()).toEqual(['Moon pack', 'Moon saved'])
      expect(new Set([...first.items, ...second.items].map((entry) => entry.id)).size).toBe(2)
      expect([...first.items, ...second.items].map((entry) => entry.ref)).toEqual(expect.arrayContaining([
        { kind: 'library', recordId: 'same' }, { kind: 'pack', packId: 'pack', blueprintId: 'same', digest },
      ]))
      expect([...first.items, ...second.items].every((entry) => entry.actions === undefined)).toBe(true)
      failed = true
      dispose = render(() => <CollectionPanel sources={[source]} />, root)
      await vi.waitFor(() => expect(root.querySelector('[data-testid="collection-retry"]')).not.toBeNull())
      expect(root.textContent).toContain('Moon pack')
      expect(root.textContent).toContain('Could not load Blueprints.')
      failed = false
      root.querySelector<HTMLButtonElement>('[data-testid="collection-retry"]')!.click()
      await vi.waitFor(() => expect(root.textContent).toContain('Moon saved'))
      expect(root.textContent).toContain('Moon pack')
      expect(root.querySelector('[data-testid="collection-retry"]')).toBeNull()
    } finally { dispose(); app.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() }
  })

  it('drags only eligible committed rows without activating them or dragging their actions', async () => {
    const activate = vi.fn()
    const transfer = new Map<string, string>()
    const source: CollectionSource = {
      id: 'media', label: 'Media', page: async () => ({ owner: 'engine-a', items: [
        { id: 'picture', title: 'Picture', actions: [{ id: 'inspect', label: 'Inspect' }] },
        { id: 'folder', title: 'Folder', folder: { path: 'folder' } },
      ] }),
    }
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <CollectionPanel sources={[source]} onActivate={activate} drag={{
      enabled: (entry, owner) => owner === 'engine-a' && entry.id === 'picture',
      start: (entry, event, owner) => event.dataTransfer!.setData('text/plain', `${owner}:${entry.id}`),
    }} />, root)
    try {
      await flush()
      const picture = root.querySelector<HTMLElement>('[data-entry="picture"]')!
      const folder = root.querySelector<HTMLElement>('[data-entry="folder"]')!
      expect(picture.getAttribute('draggable')).toBe('true')
      expect(folder.getAttribute('draggable')).toBe('false')
      const drag = (element: Element) => {
        const event = new Event('dragstart', { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'dataTransfer', { value: { setData: (type: string, value: string) => transfer.set(type, value) } })
        element.dispatchEvent(event)
        return event.defaultPrevented
      }
      expect(drag(picture)).toBe(false)
      expect(transfer.get('text/plain')).toBe('engine-a:picture')
      expect(activate).not.toHaveBeenCalled()
      transfer.clear()
      expect(drag(folder)).toBe(true)
      picture.click()
      expect(drag(picture.querySelector('button')!)).toBe(true)
      expect(transfer.size).toBe(0)
      expect(activate).toHaveBeenCalled()
    } finally { dispose() }
  })

  it('keeps row disclosures across refreshes but not across backend owners', async () => {
    const [tick, setTick] = createSignal(0)
    let owner = 'backend-a'
    let title = 'Original result'
    const source: CollectionSource = {
      id: 'runs', label: 'Runs',
      page: async () => ({ items: [{ id: 'same-run', owner, title }] }),
    }
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <CollectionPanel sources={[source]} refreshTick={tick}
      entryContent={(entry) => <details><summary>{entry().title}</summary>Result details</details>} />, root)
    await flush()
    root.querySelector('details')!.open = true
    title = 'Updated result'
    setTick(1)
    await flush()
    expect(root.querySelector('summary')!.textContent).toBe('Updated result')
    expect(root.querySelector('details')!.open).toBe(true)
    owner = 'backend-b'
    setTick(2)
    await flush()
    expect(root.querySelector('details')!.open).toBe(false)
  })

  it('keeps a grouped run disclosure across refreshes', async () => {
    const [tick, setTick] = createSignal(0)
    const source: CollectionSource = {
      id: 'runs', label: 'Runs',
      page: async () => ({ items: [{ id: 'group', title: 'Latest', children: [
        { id: 'new', title: 'New run' }, { id: 'old', title: 'Old run' },
      ] }] }),
    }
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <CollectionPanel sources={[source]} refreshTick={tick}
      entryContent={(entry) => <details><summary>{entry().title}</summary>Result details</details>} />, root)
    await flush()
    root.querySelector<HTMLButtonElement>('[data-testid="collection-expand"]')!.click()
    const old = () => root.querySelector<HTMLDetailsElement>('[data-entry="old"] details')!
    old().open = true
    setTick(1)
    await flush()
    expect(old().open).toBe(true)
  })

  it('renders a collapsed count row and expands individual runs in order', async () => {
    const activate = vi.fn()
    const source: CollectionSource = {
      id: 'runs',
      label: 'Runs',
      page: async () => ({
        items: [{
          id: 'noop:digest:old',
          title: 'latest run',
          badges: ['completed', 'x2'],
          children: [
            { id: 'new', title: 'new run' },
            { id: 'old', title: 'old run' },
          ],
        }],
      }),
    }
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <CollectionPanel sources={[source]} onActivate={(_source, entry) => activate(entry.id)} />, root)
    await flush()

    expect(root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(1)
    expect(root.textContent).toContain('x2')
    const expand = root.querySelector<HTMLButtonElement>('[data-testid="collection-expand"]')!
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    expand.click()
    expect(expand.getAttribute('aria-expanded')).toBe('true')
    expect([...root.querySelectorAll('.collection-child .collection-title')].map((el) => el.textContent))
      .toEqual(['new run', 'old run'])
    const parent = root.querySelector<HTMLElement>('[data-entry="noop:digest:old"]')!
    const firstChild = root.querySelector<HTMLElement>('[data-entry="new"]')!
    parent.focus()
    parent.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await flush()
    expect(document.activeElement).toBe(firstChild)
    expect(firstChild.tabIndex).toBe(0)
    firstChild.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(activate).toHaveBeenCalledWith('new')
  })

  it('hands a run removal request to its host without deleting on row activation', async () => {
    const action = vi.fn()
    const source: CollectionSource = {
      id: 'runs',
      label: 'Runs',
      page: async () => ({ items: [{
        id: 'run-1',
        title: 'Completed run',
        actions: [{ id: 'delete', label: 'Delete record' }],
      }] }),
    }
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <CollectionPanel sources={[source]} onAction={(_source, entry, id) => action(entry.id, id)} />, root)
    await flush()

    root.querySelector<HTMLElement>('[data-entry="run-1"]')!.click()
    const remove = root.querySelector<HTMLButtonElement>('[data-action="delete"]')!
    expect(action).not.toHaveBeenCalled()
    remove.click()
    expect(action).toHaveBeenCalledWith('run-1', 'delete')
  })
})
