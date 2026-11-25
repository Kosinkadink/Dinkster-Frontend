// @vitest-environment happy-dom

import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SearchProvider, SearchResult } from '@dinkster/core'
import { prepareWorkflowApp } from './fixtures/workflow-app.js'
import { AppState } from '../src/app-state.js'
import { UniversalSearch, UniversalSearchTrigger, shortcutKeys } from '../src/UniversalSearch.js'
import { recordSearchRecent, registerCoreSearchProviders, searchRecents } from '../src/universal-search.js'

afterEach(() => { document.body.replaceChildren(); vi.useRealTimers() })

const action = (id: string) => ({ kind: 'host' as const, action: 'tab.activate' as const, params: { id } })
const row = (id: string, score: number): SearchResult => ({ id, title: id, score, action: action(id) })

function fixture(providers: readonly SearchProvider[], app = new AppState()) {
  const disposers = providers.map((provider) => app.searchRegistry.register(provider))
  const root = document.createElement('div')
  document.body.append(root)
  const dispose = render(() => <UniversalSearch app={app} />, root)
  return { app, root, dispose: () => { dispose(); disposers.forEach((unregister) => unregister()) } }
}

const input = (root: Element): HTMLInputElement => root.querySelector('[data-testid="universal-search-input"]')!
const type = (element: HTMLInputElement, value: string): void => {
  element.value = value
  element.dispatchEvent(new InputEvent('input', { bubbles: true }))
}
const key = (root: Element, name: string, shiftKey = false): void => {
  input(root).dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true }))
}
const options = (root: Element, group?: string): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(`${group === undefined ? '' : `[data-group="${group}"] `}[role="option"]`)]
const titles = (root: Element, group?: string): string[] =>
  options(root, group).map((option) => option.querySelector('.dinkster-search-row-title')?.textContent ?? '')
const current = (root: Element): HTMLElement | null => root.querySelector('[role="option"][aria-selected="true"]')
const headings = (root: Element): string[] =>
  [...root.querySelectorAll('.dinkster-search-group-heading > span:first-child')].map((heading) => heading.textContent ?? '')
const busy = (root: Element): string | null => root.querySelector('dialog')!.getAttribute('aria-busy')
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve))

describe('UniversalSearch', () => {
  it.each([false, true])('waits for document command acceptance %s before dismissal and recency', async (accepted) => {
    const { app, root, dispose } = fixture([{
      id: 'edits', label: 'Edits', priority: 1,
      query: () => [{ ...row('add-node', 1), action: {
        kind: 'command', invocation: { command: 'node.add', params: { graphId: 'root', type: 'Fixture', position: { x: 12, y: 34 } } },
      } }],
    }])
    app.searchOpen.set(true)
    type(input(root), 'add')
    const recents = searchRecents(app.settings)
    let finish!: () => void
    const dispatch = vi.spyOn(app, 'dispatchTo').mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ ok: accepted, diagnostics: [] })
    }) as never)
    await settle()
    const option = options(root)[0]!
    option.click()
    expect(app.searchOpen.get()).toBe(true)
    expect(searchRecents(app.settings)).toEqual(recents)
    expect(busy(root)).toBe('true')
    option.click()
    key(root, 'Enter')
    expect(dispatch).toHaveBeenCalledOnce()
    finish()
    await vi.waitFor(() => expect(busy(root)).toBe('false'))
    expect(app.searchOpen.get()).toBe(!accepted)
    expect(searchRecents(app.settings)).toEqual(accepted ? ['edits:add-node', ...recents.filter((id) => id !== 'edits:add-node')].slice(0, 20) : recents)
    if (!accepted) {
      option.click()
      expect(dispatch).toHaveBeenCalledTimes(2)
      finish()
      await vi.waitFor(() => expect(busy(root)).toBe('false'))
    }
    dispose()
    app.dispose()
  })

  it.each(['query', 'tab', 'reopen', 'unmount'] as const)('isolates a delayed document command after %s replacement', async (replacement) => {
    const { app, root, dispose } = fixture([{
      id: 'edits', label: 'Edits', priority: 1,
      query: () => [{ ...row('edit', 1), action: {
        kind: 'command', invocation: { command: 'node.remove', params: { graphId: 'root', nodeIds: [] } },
      } }],
    }])
    app.searchOpen.set(true)
    type(input(root), 'edit')
    const recents = searchRecents(app.settings)
    let finish!: () => void
    vi.spyOn(app, 'dispatchTo').mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ ok: true })
    }) as never)
    await settle()
    options(root)[0]!.click()
    if (replacement === 'query') {
      type(input(root), 'another query')
      type(input(root), 'edit')
    } else if (replacement === 'tab') {
      const tab = app.activeTabId.get()
      app.activeTabId.set('another-tab')
      app.activeTabId.set(tab)
    } else if (replacement === 'reopen') {
      app.searchOpen.set(false)
      app.searchOpen.set(true)
    } else {
      dispose()
      app.searchOpen.set(true)
    }
    finish()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(app.searchOpen.get()).toBe(true)
    expect(searchRecents(app.settings)).toEqual(recents)
    if (replacement !== 'unmount') dispose()
    app.dispose()
  })

  it('before typing lists only what was used last and the open tabs', async () => {
    const app = new AppState()
    recordSearchRecent(app.settings, 'commands:second')
    recordSearchRecent(app.settings, 'tabs:tab-b')
    const { root, dispose } = fixture([
      { id: 'commands', label: 'Commands', priority: 20, query: () => [row('first', 2), row('second', 1)] },
      { id: 'core.tabs', label: 'Tabs', priority: 10, query: () => [row('tab-a', 1)] },
      { id: 'tabs', label: 'Other', priority: 5, query: () => [row('tab-b', 1)] },
    ], app)
    await settle()
    expect(headings(root)).toEqual(['Recent', 'Open tabs'])
    expect(titles(root, 'recent')).toEqual(['tab-b', 'second'])
    expect(titles(root, 'core.tabs')).toEqual(['tab-a'])
    type(input(root), 'x')
    expect(headings(root)).toEqual(['Commands', 'Tabs', 'Other'])
    dispose()
  })

  it('after typing shows the best three of each kind, then "N more", which opens the rest in place', async () => {
    const { root, dispose } = fixture([
      { id: 'commands', label: 'Commands', priority: 20, query: () => [row('low', 1), row('high', 10)] },
      { id: 'tabs', label: 'Tabs', priority: 10, query: () => Array.from({ length: 6 }, (_, at) => row(`tab-${at}`, 6 - at)) },
    ])
    type(input(root), 'a')
    await settle()
    const listbox = root.querySelector<HTMLElement>('[role="listbox"]')!
    expect(input(root).getAttribute('role')).toBe('combobox')
    expect(input(root).getAttribute('aria-controls')).toBe(listbox.id)
    expect(input(root).getAttribute('aria-activedescendant')).toBe(options(root)[0]?.id)
    expect(titles(root, 'commands')).toEqual(['high', 'low'])
    expect(titles(root, 'tabs')).toEqual(['tab-0', 'tab-1', 'tab-2', '3 more tabs'])
    expect(root.querySelector('[role="status"]')?.textContent).toContain('8 results')
    for (let at = 0; at < 5; at += 1) key(root, 'ArrowDown')
    expect(current(root)?.dataset['kind']).toBe('more')
    key(root, 'Enter')
    expect(titles(root, 'tabs')).toEqual(['tab-0', 'tab-1', 'tab-2', 'tab-3', 'tab-4', 'tab-5'])
    expect(current(root)?.textContent).toContain('tab-3')
    expect(document.activeElement).toBe(input(root))
    dispose()
  })

  it('names each kind as a tab with its count; Tab narrows the list to the next kind', async () => {
    const { root, dispose } = fixture([
      { id: 'commands', label: 'Commands', priority: 20, query: () => [row('one', 1)] },
      { id: 'tabs', label: 'Tabs', priority: 10, query: () => Array.from({ length: 4 }, (_, at) => row(`tab-${at}`, 4 - at)) },
      { id: 'empty', label: 'Empty', priority: 5, query: () => [] },
    ])
    const tabs = () => [...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
    expect(tabs()).toEqual(['All', 'Commands', 'Tabs', 'Empty'])
    type(input(root), 'a')
    expect(tabs()).toEqual(['All', 'Commands 1', 'Tabs 4'])
    key(root, 'Tab')
    key(root, 'Tab')
    expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Tabs 4')
    expect(headings(root)).toEqual(['Tabs'])
    expect(titles(root)).toEqual(['tab-0', 'tab-1', 'tab-2', 'tab-3'])
    key(root, 'Tab', true)
    expect(headings(root)).toEqual(['Commands'])
    dispose()
  })

  it('flips a setting that is a switch in its row and shows a command shortcut as keys', async () => {
    const app = new AppState()
    app.settings.register({ id: 'demo.flag', name: 'Demo flag', category: 'demo', type: 'boolean', defaultValue: false })
    const { root, dispose } = fixture([
      { id: 'core.settings', label: 'Settings', priority: 20, query: () => [{
        ...row('demo.flag', 1), title: 'Demo flag', action: { kind: 'host', action: 'settings.open', params: { category: 'demo', id: 'demo.flag' } },
      }] },
      { id: 'core.commands', label: 'Commands', priority: 10, query: () => [{
        ...row('save', 1), detail: 'ctrl+shift+s', action: { kind: 'host', action: 'command.run', params: { id: 'save' } },
      }] },
    ], app)
    app.searchOpen.set(true)
    type(input(root), 'a')
    const toggle = root.querySelector<HTMLElement>('[role="switch"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    toggle.click()
    expect(app.settings.get('demo.flag')).toBe(true)
    expect(app.searchOpen.get()).toBe(true)
    key(root, 'Enter')
    expect(app.settings.get('demo.flag')).toBe(false)
    expect(root.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
    expect([...root.querySelectorAll('[data-group="core.commands"] kbd')].map((chip) => chip.textContent)).toEqual(['Ctrl', 'Shift', 'S'])
    expect(shortcutKeys('ctrl+enter')).toEqual(['Ctrl', 'Enter'])
    dispose()
  })

  it('floats the preview beside a node or blueprint row only', async () => {
    const node = (id: string, actionName: 'node.armPlacement' | 'blueprint.armPlacement'): SearchResult => ({
      ...row(id, 2),
      title: `${id} title`,
      action: actionName === 'node.armPlacement'
        ? { kind: 'host', action: actionName, params: { type: id, schemaKey: 'key', backendId: 'backend' } }
        : { kind: 'host', action: actionName, params: { type: `blueprint:pack/${id}`, backendId: 'backend' } },
      preview: { version: 1, title: `${id} title`, description: `What ${id} does.`, fields: [{ label: 'Where', value: `dev / image - ${id} pack` }] },
    })
    const { root, dispose } = fixture([
      { id: 'core.nodes', label: 'Nodes', priority: 30, query: () => [node('stats', 'node.armPlacement')] },
      { id: 'core.blueprints', label: 'Blueprints', priority: 20, query: () => [node('upscale', 'blueprint.armPlacement')] },
      { id: 'core.tabs', label: 'Tabs', priority: 10, query: () => [{ ...row('tab', 1), preview: { version: 1, title: 'Tab preview' } }] },
    ])
    type(input(root), 'a')
    const preview = () => root.querySelector('[data-testid="search-preview"]')
    expect(preview()?.getAttribute('data-place')).toBe('floating')
    expect(preview()?.querySelector('h2')?.textContent).toBe('stats title')
    expect(preview()?.textContent).toContain('What stats does.')
    expect(preview()?.textContent).toContain('dev / image - stats pack')
    key(root, 'ArrowDown')
    expect(preview()?.querySelector('h2')?.textContent).toBe('upscale title')
    key(root, 'ArrowDown')
    expect(current(root)?.textContent).toContain('tab')
    expect(preview()).toBeNull()
    dispose()
  })

  it('draws the selected blueprint from its catalog entry', () => {
    const app = prepareWorkflowApp(new AppState())
    app.canvasBridge.set({
      selectedNodes: () => [],
      blueprintEntries: () => [{
        type: 'blueprint:pack/upscale', name: 'Upscale blueprint', category: 'Image tools', kind: 'blueprint', fields: [],
        blueprint: { packId: 'pack', descriptor: {
          id: 'upscale', name: 'Upscale blueprint', digest: `sha256:${'a'.repeat(64)}`,
          boundaryInputs: ['comfy.IMAGE'], boundaryOutputs: ['comfy.IMAGE'],
        } },
      }],
    } as never)
    const unregister = registerCoreSearchProviders(app)
    const { root, dispose } = fixture([], app)
    type(input(root), 'Upscale blueprint')
    expect(root.querySelector('[data-testid="search-preview"] canvas')?.getAttribute('aria-label')).toBe('Upscale blueprint preview')
    dispose()
    unregister.forEach((stop) => stop())
    app.dispose()
  })

  it('renders manifest-gated extension providers as kinds of their own without extension-owned markup', async () => {
    const app = new AppState()
    expect(app.extensions.register({
      id: 'demo', displayName: 'Demo pack', contributions: [
        { id: 'demo.search.primary', category: 'searchProvider' },
        { id: 'demo.search.secondary', category: 'searchProvider' },
      ],
    }, (api) => {
      api.searchProvider('demo.search.primary', {
        id: 'demo.search.primary', label: 'Demo primary', prefix: '?', priority: 50,
        query: () => [{
          id: 'open-demo', title: 'Open demo workflow', detail: 'Typed extension result', score: 2,
          action: { kind: 'host', action: 'settings.open', params: { category: 'demo' } },
        }],
      })
      api.searchProvider('demo.search.secondary', {
        id: 'demo.search.secondary', label: 'Demo secondary', priority: 40,
        query: () => [row('secondary-result', 1)],
      })
    })).toEqual([])
    const { root, dispose } = fixture([], app)
    type(input(root), 'demo')
    await settle()
    expect(headings(root)).toEqual(['Demo primary', 'Demo secondary'])
    expect(options(root, 'demo.search.primary')[0]?.querySelector('.dinkster-search-row-detail')?.textContent).toBe('Typed extension result')
    app.extensions.setContributionEnabled('demo.search.primary', false)
    expect(root.querySelector('[data-group="demo.search.primary"]')).toBeNull()
    app.extensions.setContributionEnabled('demo.search.primary', true)
    expect(root.querySelector('[data-group="demo.search.primary"]')).not.toBeNull()
    app.extensions.unregister('demo')
    expect(root.querySelector('[data-group^="demo.search"]')).toBeNull()
    dispose()
  })

  it('routes prefixes and activates the keyboard-selected result', async () => {
    const calls: string[] = []
    const provider = (id: string, prefix: string, priority: number): SearchProvider => ({
      id, label: id, prefix, priority,
      query: (query) => { calls.push(`${id}:${query}`); return [
        { ...row(`${id}-first`, 2), action: { kind: 'host', action: 'command.run', params: { id: `${id}-first` } } },
        { ...row(`${id}-second`, 1), action: { kind: 'host', action: 'command.run', params: { id: `${id}-second` } } },
      ] },
    })
    const { app, root, dispose } = fixture([provider('commands', '>', 20), provider('tabs', '~', 10)])
    let activated = ''
    app.commands.register({ id: 'commands-first', label: 'First', run: () => { activated = 'commands-first' } })
    app.commands.register({ id: 'commands-second', label: 'Second', run: () => { activated = 'commands-second' } })
    await settle()
    calls.length = 0
    type(input(root), '> save')
    expect(calls).toEqual(['commands:save'])
    key(root, 'ArrowDown')
    key(root, 'Enter')
    await settle()
    expect(activated).toBe('commands-second')
    expect(app.searchOpen.get()).toBe(false)
    dispose()
  })

  it('rejects malformed modal actions before recency or dismissal', async () => {
    const { app, root, dispose } = fixture([{
      id: 'invalid', label: 'Invalid', priority: 1,
      query: () => [{
        ...row('invalid-settings', 1),
        action: { kind: 'host', action: 'settings.open', params: { category: undefined } } as never,
      }],
    }])
    app.searchOpen.set(true)
    type(input(root), 'invalid')
    const initialRequest = app.settingsOpenRequest.get()
    const initialModal = app.modalPanel.get()
    const initialRecents = searchRecents(app.settings)
    await settle()
    options(root)[0]!.click()
    await settle()
    expect(app.searchOpen.get()).toBe(true)
    expect(searchRecents(app.settings)).toEqual(initialRecents)
    expect(app.settingsOpenRequest.get()).toBe(initialRequest)
    expect(app.modalPanel.get()).toBe(initialModal)
    dispose()
  })

  it('topbar field shows the effective shortcut and clicking it opens and focuses the search field', async () => {
    const app = new AppState()
    app.searchRegistry.register({ id: 'commands', label: 'Commands', priority: 1, query: () => [] })
    const [open, setOpen] = createSignal(false)
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <>
      <UniversalSearchTrigger shortcut="alt+k" onOpen={() => { app.searchOpen.set(true); setOpen(true) }} />
      <Show when={open()}><UniversalSearch app={app} /></Show>
    </>, root)

    const trigger = root.querySelector('[data-testid="topbar-search"]') as HTMLButtonElement
    expect(trigger.querySelector('kbd')?.textContent).toBe('alt+k')
    expect(trigger.getAttribute('aria-label')).toBe('Search Dinkster')
    expect(trigger.title).toBe('Search Dinkster (alt+k)')
    trigger.click()
    await settle()
    expect(document.activeElement).toBe(input(root))
    dispose()
  })

  it('routes native cancellation through the product open-state handler', () => {
    const { app, root, dispose } = fixture([])
    app.searchOpen.set(true)
    root.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))
    expect(app.searchOpen.get()).toBe(false)
    dispose()
  })

  it('routes backdrop pointerdown without allowing pointer focus to replace native restoration', () => {
    const { app, root, dispose } = fixture([])
    app.searchOpen.set(true)
    const backdrop = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    expect(root.querySelector('dialog')!.dispatchEvent(backdrop)).toBe(false)
    expect(backdrop.defaultPrevented).toBe(true)
    expect(app.searchOpen.get()).toBe(false)
    dispose()
  })

  it('renders sync results immediately, debounces async work, aborts stale queries, and keeps the current row as groups stream', async () => {
    vi.useFakeTimers()
    let resolveAsync: ((rows: readonly SearchResult[]) => void) | undefined
    const signals: AbortSignal[] = []
    let calls = 0
    const { root, dispose } = fixture([
      { id: 'async', label: 'Async', priority: 20, async: true, query: (_query, context) => {
        calls++
        signals.push(context.signal)
        return new Promise((resolve) => { resolveAsync = resolve })
      } },
      { id: 'sync', label: 'Sync', priority: 10, query: () => [row('sync-first', 2), row('sync-second', 1)] },
    ])
    type(input(root), 'a')
    calls = 0
    signals.length = 0
    expect(root.querySelector('[data-group="sync"]')).not.toBeNull()
    expect(root.querySelector('[data-group="async"] .dinkster-search-note')?.textContent).toBe('Searching async')
    expect(calls).toBe(0)
    key(root, 'ArrowDown')
    expect(current(root)?.textContent).toContain('sync-second')
    await vi.advanceTimersByTimeAsync(119)
    expect(calls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(1)
    resolveAsync?.([row('async-first', 5)])
    await Promise.resolve()
    expect(titles(root, 'async')).toEqual(['async-first'])
    expect(current(root)?.textContent).toContain('sync-second')

    type(input(root), 'next')
    expect(signals[0]?.aborted).toBe(true)
    expect(root.querySelector('[data-group="async"] .dinkster-search-note')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(120)
    expect(calls).toBe(2)
    dispose()
  })

  it('says when nothing matches and when a provider failed, without exposing its error text', async () => {
    const empty = fixture([{ id: 'empty', label: 'Empty', priority: 1, query: () => [] }])
    type(input(empty.root), 'no such result')
    const emptyState = empty.root.querySelector('.dinkster-search-empty')!
    expect(emptyState.textContent).toContain('No matches')
    expect(empty.root.querySelector('[role="status"]')?.textContent).toContain('Nothing is called "no such result"')
    empty.dispose()

    const failed = fixture([
      { id: 'failed', label: 'Private provider', priority: 2, query: () => { throw new Error('secret provider detail') } },
      { id: 'fine', label: 'Fine', priority: 1, query: () => [row('fine-result', 1)] },
    ])
    type(input(failed.root), 'a')
    expect(failed.root.querySelector('[data-group="failed"] .dinkster-search-note')?.textContent).toBe('Private provider could not be searched.')
    expect(titles(failed.root, 'fine')).toEqual(['fine-result'])
    expect(failed.root.textContent).not.toContain('secret provider detail')
    failed.dispose()
  })

  it('does not arm node placement until the selected result is activated', async () => {
    const { app, root, dispose } = fixture([{
      id: 'nodes', label: 'Nodes', priority: 1,
      query: () => [{
        ...row('canonical.node', 1),
        title: 'Canonical node',
        action: {
          kind: 'host', action: 'node.armPlacement',
          params: { type: 'canonical.node', schemaKey: 'schema-a', backendId: 'backend-a' },
        },
      }],
    }])
    const armNodePlacement = vi.fn(() => true)
    app.canvasBridge.set({ armNodePlacement, selectedNodes: () => [] } as never)
    type(input(root), 'canonical')
    await settle()
    expect(armNodePlacement).not.toHaveBeenCalled()
    options(root)[0]!.click()
    expect(armNodePlacement).toHaveBeenCalledWith('canonical.node', { schemaKey: 'schema-a', backendId: 'backend-a' })
    dispose()
  })
})
