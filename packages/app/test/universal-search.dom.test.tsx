// @vitest-environment happy-dom

import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SearchProvider, SearchResult } from '@dinkster/core'
import { AppState } from '../src/app-state.js'
import { UniversalSearch, UniversalSearchTrigger } from '../src/UniversalSearch.js'
import { searchRecents } from '../src/universal-search.js'

afterEach(() => { document.body.replaceChildren(); vi.useRealTimers() })

const action = (id: string) => ({ kind: 'host' as const, action: 'tab.activate' as const, params: { id } })
const row = (id: string, score: number): SearchResult => ({ id, title: id, score, action: action(id) })

function fixture(providers: readonly SearchProvider[]) {
  const app = new AppState()
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

describe('UniversalSearch palette', () => {
  it('renders the host-owned combobox, ranked groups, rows, announcements, and five-row expansion', async () => {
    const { root, dispose } = fixture([
      { id: 'commands', label: 'Commands', prefix: '>', priority: 20, query: () => [row('low', 1), row('high', 10)] },
      { id: 'tabs', label: 'Tabs', prefix: '~', priority: 10, query: () => Array.from({ length: 6 }, (_, at) => row(`tab-${at}`, 6 - at)) },
    ])
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const searchInput = input(root)
    const listbox = root.querySelector<HTMLElement>('[role="listbox"]')!
    const options = [...root.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(searchInput.getAttribute('role')).toBe('combobox')
    expect(searchInput.getAttribute('aria-controls')).toBe(listbox.id)
    expect(searchInput.getAttribute('aria-activedescendant')).toBe(options[0]?.id)
    expect([...root.querySelectorAll('.search-result-group-header h2')].map((item) => item.textContent)).toEqual(['Commands', 'Tabs'])
    expect([...root.querySelectorAll('[data-provider="commands"] .search-result-row-title')].map((item) => item.textContent)).toEqual(['high', 'low'])
    expect(root.querySelectorAll('[data-provider="tabs"] [data-testid="search-result-row"]')).toHaveLength(5)
    expect(listbox.querySelector('[data-search-state]')).toBeNull()
    expect(listbox.querySelector('button:not([role="option"])')).toBeNull()
    expect([...listbox.querySelectorAll('[role="group"]')].every((group) => group.querySelector('[role="option"]') !== null)).toBe(true)
    expect(root.querySelector('[role="status"]')?.textContent).toContain('8 results')
    const showMore = root.querySelector('[data-provider="tabs"] .search-show-more') as HTMLButtonElement
    expect(showMore.getAttribute('role')).toBe('option')
    for (let at = 0; at < 7; at += 1) searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(searchInput.getAttribute('aria-activedescendant')).toBe(showMore.id)
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(root.querySelectorAll('[data-provider="tabs"] [data-testid="search-result-row"]')).toHaveLength(6)
    expect(root.querySelector('[data-provider="tabs"] .search-show-more')).toBeNull()
    expect(document.activeElement).toBe(searchInput)
    expect(searchInput.getAttribute('aria-activedescendant')).toBe(root.querySelectorAll('[data-provider="tabs"] [role="option"]')[5]?.id)
    dispose()
  })

  it('renders manifest-gated extension providers and previews without extension-owned markup', async () => {
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
          preview: {
            version: 1, title: 'Demo workflow', description: 'Static detail rendered by the search host.',
            fields: [{ label: 'Source', value: 'Demo pack' }, { label: 'Kind', value: 'Workflow action' }],
          },
        }],
      })
      api.searchProvider('demo.search.secondary', {
        id: 'demo.search.secondary', label: 'Demo secondary', priority: 40,
        query: () => [row('secondary-result', 1)],
      })
    })).toEqual([])
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <UniversalSearch app={app} />, root)
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect([...root.querySelectorAll('.search-result-group-header h2')].map((heading) => heading.textContent)).toEqual([
      'Demo primary', 'Demo secondary',
    ])
    const preview = root.querySelector('[data-testid="search-result-preview"]')!
    expect(preview.getAttribute('aria-labelledby')).toBe(`${preview.id}-heading`)
    expect(preview.querySelector('h2')?.textContent).toBe('Demo workflow')
    expect(preview.textContent).toContain('Static detail rendered by the search host.')
    expect(preview.textContent).toContain('SourceDemo pack')
    expect(root.querySelector('[aria-selected="true"]')?.getAttribute('aria-describedby')).toBe(`${preview.id}-heading ${preview.id}-content`)
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Preview available')
    expect(preview.querySelector('[class]')).toBeNull()

    app.extensions.setContributionEnabled('demo.search.primary', false)
    expect(root.querySelector('[data-provider="demo.search.primary"]')).toBeNull()
    expect(root.querySelector('[data-testid="search-result-preview"]')).toBeNull()
    app.extensions.setContributionEnabled('demo.search.primary', true)
    expect(root.querySelector('[data-provider="demo.search.primary"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="search-result-preview"]')).not.toBeNull()
    app.extensions.unregister('demo')
    expect(root.querySelector('[data-provider^="demo.search"]')).toBeNull()
    dispose()
  })

  it('relates only useful preview text to the active option', async () => {
    const cases: readonly {
      readonly resultTitle: string
      readonly preview: NonNullable<SearchResult['preview']>
      readonly describedBy: readonly ('heading' | 'content')[]
    }[] = [
      { resultTitle: 'Result title', preview: { version: 1, title: 'Distinct preview title' }, describedBy: ['heading'] },
      { resultTitle: 'Repeated title', preview: { version: 1, title: 'Repeated title' }, describedBy: [] },
      {
        resultTitle: 'Result with detail',
        preview: { version: 1, title: 'Distinct detail title', description: 'Preview detail' },
        describedBy: ['heading', 'content'],
      },
    ]
    for (const testCase of cases) {
      const { root, dispose } = fixture([{
        id: 'preview', label: 'Previews', priority: 1,
        query: () => [{ ...row('result', 1), title: testCase.resultTitle, preview: testCase.preview }],
      }])
      await new Promise<void>((resolve) => queueMicrotask(resolve))

      const preview = root.querySelector('[data-testid="search-result-preview"]')!
      const expected = testCase.describedBy.map((part) => `${preview.id}-${part}`).join(' ') || null
      expect(root.querySelector('[aria-selected="true"]')?.getAttribute('aria-describedby')).toBe(expected)
      dispose()
      root.remove()
    }
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
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    calls.length = 0
    type(input(root), '> save')
    expect(calls).toEqual(['commands:save'])
    input(root).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    input(root).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
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
    const initialRequest = app.settingsOpenRequest.get()
    const initialModal = app.modalPanel.get()
    const initialRecents = searchRecents(app.settings)
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    ;(root.querySelector('[data-testid="search-result-row"]') as HTMLButtonElement).click()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(app.searchOpen.get()).toBe(true)
    expect(searchRecents(app.settings)).toEqual(initialRecents)
    expect(app.settingsOpenRequest.get()).toBe(initialRequest)
    expect(app.modalPanel.get()).toBe(initialModal)
    dispose()
  })

  it('topbar field shows the effective shortcut and clicking it opens and focuses the palette input', async () => {
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
    expect(trigger.textContent).toBe('Search Dinksteralt+k')
    expect(trigger.getAttribute('aria-label')).toBe('Search Dinkster, alt+k')
    trigger.click()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
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

  it('renders sync results immediately, debounces async work, aborts stale queries, and preserves selection as groups stream', async () => {
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

    expect(root.querySelector('[data-provider="sync"]')).not.toBeNull()
    expect(root.querySelector('[data-provider="async"] [data-search-state="loading"]')?.textContent).toContain('Searching Async')
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Searching providers')
    expect(calls).toBe(0)
    input(root).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(root.querySelector('.search-result-row.active')?.textContent).toContain('sync-second')
    await vi.advanceTimersByTimeAsync(119)
    expect(calls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(1)
    resolveAsync?.([row('async-first', 5)])
    await Promise.resolve()
    expect(root.querySelector('[data-provider="async"]')).not.toBeNull()
    expect(root.querySelector('.search-result-row.active')?.textContent).toContain('sync-second')

    type(input(root), 'next')
    expect(signals[0]?.aborted).toBe(true)
    expect(root.querySelector('[data-provider="async"] [data-search-state="loading"]')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(120)
    expect(calls).toBe(2)
    dispose()
  })

  it('renders no-match and isolated provider-failure states without exposing error text', async () => {
    const empty = fixture([{ id: 'empty', label: 'Empty', priority: 1, query: () => [] }])
    type(input(empty.root), 'no such result')
    const emptyState = empty.root.querySelector('[data-search-state="empty"]')!
    expect(emptyState.textContent).toContain('No matches')
    expect(empty.root.querySelector('[role="listbox"]')!.contains(emptyState)).toBe(false)
    expect(empty.root.querySelector('[role="status"]')?.textContent).toContain('No matches for no such result')
    empty.dispose()

    const failed = fixture([{
      id: 'failed', label: 'Private provider', priority: 1,
      query: () => { throw new Error('secret provider detail') },
    }])
    const errorState = failed.root.querySelector('[data-search-state="error"]')!
    expect(errorState.textContent).toContain('Provider unavailable')
    expect(errorState.textContent).toContain('Private provider could not return results')
    expect(failed.root.querySelector('[role="listbox"]')!.contains(errorState)).toBe(false)
    expect(errorState.closest('[role="region"]')).not.toBeNull()
    expect(errorState.closest('[role="group"]')).toBeNull()
    expect(failed.root.textContent).not.toContain('secret provider detail')
    expect(failed.root.querySelector('[role="status"]')?.textContent).toContain('1 provider is unavailable')
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
    app.canvasBridge.set({ armNodePlacement } as never)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(armNodePlacement).not.toHaveBeenCalled()
    ;(root.querySelector('[data-testid="search-result-row"]') as HTMLButtonElement).click()
    expect(armNodePlacement).toHaveBeenCalledWith('canonical.node', { schemaKey: 'schema-a', backendId: 'backend-a' })
    dispose()
  })
})
