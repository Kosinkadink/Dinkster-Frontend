// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollectionEntry, CollectionPageRequest, CollectionSource } from '@dinkster/core'
import { registerCatalog, setLocale } from '@dinkster/core'
import { CollectionPanel } from '../src/CollectionPanel.js'

const folder = (path: string): CollectionEntry => ({ id: `folder:${path}`, title: path.split('/').at(-1)!, folder: { path } })
const file = (id: string): CollectionEntry => ({ id, title: `${id}.png`, ref: { id } })

const settle = async (): Promise<void> => {
  await vi.waitFor(() => expect(document.querySelector('[data-testid="collection-empty"]')?.textContent).not.toBe('Loading...'))
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  setLocale('en')
})

describe('CollectionPanel folder navigation', () => {
  it('updates mounted host chrome without refetching or translating collection data', async () => {
    registerCatalog('de-DE', {
      'collection.action.confirmDelete': '[Loschen bestatigen]',
      'collection.action.hideRuns': '[Laufe ausblenden]',
      'collection.action.loadMore': '[Mehr laden]',
      'collection.action.removeFilter': '[Filter {filter} entfernen]',
      'collection.description.error': '[{source} konnte nicht geladen werden]',
      'collection.filter.active': '[Aktive Filter]',
      'collection.filter.all': '[Alle {filter}]',
      'collection.filter.title': '[Filter DE]',
      'collection.folder.ariaLabel': '[Ordner]',
      'collection.folder.root': '[wurzel]',
      'collection.group.collapse': '[{count} gruppierte Laufe einklappen]',
      'collection.group.runsIn': '[Laufe in {title}]',
      'collection.mode.grid': '[Rasteransicht]',
      'collection.result.ariaLabel': '[Ergebnisse fur {source}]',
      'collection.result.count': '[{count, plural, one {# Eintrag} other {# Eintrage}} in {source}]',
      'collection.result.total': '[{count} von {total}]',
      'collection.search.label': '[Sammlung durchsuchen]',
      'collection.search.placeholder': '[Sammlung durchsuchen...]',
      'collection.source.ariaLabel': '[Quelle DE]',
    })
    const page = vi.fn(async (request: CollectionPageRequest) => {
      if (request.query === 'failure') throw new Error('RAW backend refusal')
      return {
        items: [{
          id: 'RAW-group',
          title: 'RAW grouped entry',
          badges: ['RAW badge'],
          details: [{ label: 'RAW fact', text: 'RAW value' }],
          actions: [{ id: 'delete', label: 'RAW delete action' }],
          children: [{ id: 'RAW-child', title: 'RAW child entry' }],
        }],
        cursor: 'RAW-cursor',
        total: 4,
      }
    })
    const source: CollectionSource = {
      id: 'RAW-source-id',
      label: 'RAW Source',
      folders: true,
      filters: [{ id: 'kind', label: 'RAW Kind', options: () => [{ value: 'RAW-image', label: 'RAW Image' }] }],
      page,
    }
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <CollectionPanel
      sources={[source]}
      variant="select"
      searchPriority="primary"
      initialFilters={{ kind: 'RAW-image' }}
    />, root)
    await vi.waitFor(() => expect(root.querySelector('[data-entry="RAW-group"]')).not.toBeNull())

    const filters = root.querySelector<HTMLDetailsElement>('.collection-filter-disclosure')!
    filters.open = true
    filters.dispatchEvent(new Event('toggle'))
    const group = root.querySelector<HTMLElement>('[data-entry="RAW-group"]')!
    group.click()
    const disclosure = root.querySelector<HTMLButtonElement>('[data-testid="collection-expand"]')!
    disclosure.click()
    const action = root.querySelector<HTMLButtonElement>('[data-action="delete"]')!
    action.click()
    const search = root.querySelector<HTMLInputElement>('[data-testid="collection-search"]')!
    const requestsBeforeLocale = page.mock.calls.length

    setLocale('de-DE')

    expect(search.getAttribute('aria-label')).toBe('[Sammlung durchsuchen]')
    expect(search.placeholder).toBe('[Sammlung durchsuchen...]')
    expect(search.value).toBe('')
    expect(root.querySelector('[data-testid="collection-active-filters"]')?.getAttribute('aria-label')).toBe('[Aktive Filter]')
    expect(root.querySelector('.collection-active-filter')?.getAttribute('aria-label')).toBe('[Filter RAW Kind entfernen]')
    expect(filters.open).toBe(true)
    expect(filters.querySelector('summary')?.textContent).toBe('[Filter DE]')
    expect(root.querySelector('[data-testid="collection-source-select"]')?.getAttribute('aria-label')).toBe('[Quelle DE]')
    expect(root.querySelector('[data-testid="collection-source-select"]')?.textContent).toContain('RAW Source')
    expect(root.querySelector('[data-testid="collection-mode"]')?.getAttribute('aria-label')).toBe('[Rasteransicht]')
    expect(root.querySelector('[data-testid="collection-folders"]')?.getAttribute('aria-label')).toBe('[Ordner]')
    expect(root.querySelector('[data-testid="collection-folders"] button')?.textContent).toBe('[wurzel]')
    expect(root.querySelector('[data-testid="collection-items"]')?.getAttribute('aria-label')).toBe('[Ergebnisse fur RAW Source]')
    expect(root.querySelector('.collection-search-description')?.textContent).toBe('[4 Eintrage in RAW Source]')
    expect(root.querySelector('[data-testid="collection-total"]')?.textContent).toBe('[1 von 4]')
    expect(root.querySelector('[data-testid="collection-more"]')?.textContent).toBe('[Mehr laden]')
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(disclosure.getAttribute('aria-label')).toBe('[1 gruppierte Laufe einklappen]')
    expect(disclosure.textContent).toBe('[Laufe ausblenden]')
    expect(action.textContent).toBe('[Loschen bestatigen]')
    expect(group.getAttribute('aria-selected')).toBe('true')
    expect(root.textContent).toContain('RAW grouped entry')
    expect(root.textContent).toContain('RAW child entry')
    expect(root.textContent).toContain('RAW factRAW value')
    expect(page).toHaveBeenCalledTimes(requestsBeforeLocale)

    const filterSelect = root.querySelector<HTMLButtonElement>('[data-testid="collection-filter-kind"]')!
    filterSelect.click()
    expect(document.querySelector('[role="option"][data-option-id=""]')?.textContent).toBe('[Alle raw kind]')
    filterSelect.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    search.value = 'failure'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await vi.waitFor(() => expect(root.querySelector('[data-collection-state="error"]')?.textContent).toContain('RAW backend refusal'))
    expect(root.querySelector('.collection-search-description')?.textContent).toBe('[RAW Source konnte nicht geladen werden]')
    unmount()
  })

  it('presents primary search with removable active filters and deterministic states', async () => {
    const requests: CollectionPageRequest[] = []
    const source: CollectionSource = {
      id: 'assets',
      label: 'All assets',
      filters: [{ id: 'kind', label: 'Kind', options: () => [{ value: 'media/image', label: 'Images' }] }],
      page: vi.fn(async (request) => {
        requests.push(request)
        if (request.query === 'failure') throw new Error('catalog unavailable')
        return { items: [] }
      }),
    }
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <CollectionPanel
      sources={[source]}
      searchPriority="primary"
      searchLabel="Search assets"
      searchPlaceholder="Search assets"
      initialFilters={{ kind: 'media/image' }}
    />, root)

    await vi.waitFor(() => expect(root.querySelector('[data-collection-state="no-match"]')).not.toBeNull())
    const search = root.querySelector<HTMLInputElement>('[data-testid="collection-search"]')!
    expect(search.getAttribute('role')).toBe('combobox')
    expect(search.getAttribute('aria-label')).toBe('Search assets')
    expect(search.getAttribute('aria-controls')).toMatch(/^collection-results-/)
    expect(root.querySelector('.collection-toolbar input, .collection-toolbar button')).toBe(search)
    expect(root.querySelector<HTMLDetailsElement>('.collection-filter-disclosure')?.open).toBe(false)
    const filter = root.querySelector<HTMLButtonElement>('.collection-active-filter')!
    expect(filter.textContent).toContain('Kind: Images')
    filter.click()
    await vi.waitFor(() => expect(requests.at(-1)?.filters).toEqual({ kind: '' }))
    await vi.waitFor(() => expect(root.querySelector('[data-collection-state="empty"]')).not.toBeNull())
    expect(root.querySelector('.collection-active-filter')).toBeNull()

    search.value = 'missing'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await vi.waitFor(() => expect(requests.at(-1)?.query).toBe('missing'))
    await vi.waitFor(() => expect(root.querySelector('[data-collection-state="no-match"]')).not.toBeNull())
    search.value = 'failure'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await vi.waitFor(() => expect(root.querySelector('[data-collection-state="error"]')?.textContent).toContain('catalog unavailable'))
    unmount()
  })

  it('marks terminal small pages as sparse and paged collections as filled', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const source: CollectionSource = {
      id: 'mount:input',
      label: 'input',
      page: vi.fn(async () => ({ items: [file('only')] })),
    }
    const unmount = render(() => <CollectionPanel sources={[source]} />, root)
    await settle()
    expect(root.querySelector('[data-testid="collection-panel"]')?.getAttribute('data-layout')).toBe('sparse')
    unmount()

    const pagedSource: CollectionSource = {
      ...source,
      page: vi.fn(async () => ({ items: [file('only')], cursor: 'next' })),
    }
    const unmountPaged = render(() => <CollectionPanel sources={[pagedSource]} />, root)
    await settle()
    expect(root.querySelector('[data-testid="collection-panel"]')?.getAttribute('data-layout')).toBe('filled')
    unmountPaged()
  })

  it('uses product comboboxes for source and open-vocabulary filters without navigating on list movement', async () => {
    const requests: CollectionPageRequest[] = []
    const makeSource = (id: string): CollectionSource => ({
      id,
      label: id,
      filters: [{ id: 'kind', label: 'Kind', options: () => [{ value: 'image', label: 'Image' }] }],
      page: vi.fn(async (request) => { requests.push(request); return { items: [] } }),
    })
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <CollectionPanel
      sources={[makeSource('input'), makeSource('output')]}
      variant="select"
      initialFilters={{ kind: 'custom' }}
    />, root)
    await settle()

    const source = root.querySelector<HTMLButtonElement>('[data-testid="collection-source-select"]')!
    expect(source.getAttribute('role')).toBe('combobox')
    const toolbarControls = [...root.querySelectorAll('.collection-toolbar input, .collection-toolbar button')]
    expect(toolbarControls.indexOf(source)).toBeLessThan(toolbarControls.indexOf(root.querySelector('[data-testid="collection-search"]')!))
    source.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(requests.at(-1)?.filters).toEqual({ kind: 'custom' })
    source.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => expect(requests.at(-1)?.filters).toEqual({ kind: 'custom' }))

    const filter = root.querySelector<HTMLButtonElement>('[data-testid="collection-filter-kind"]')!
    expect(filter.textContent).toContain('custom')
    filter.click()
    expect(document.querySelector('[role="option"][data-option-id="custom"]')?.getAttribute('aria-selected')).toBe('true')
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(requests.at(-1)?.filters).toEqual({ kind: 'custom' })
    unmount()
  })

  it('enters folders, jumps breadcrumbs, returns to root, scopes search, and resets cursors', async () => {
    const requests: CollectionPageRequest[] = []
    const source: CollectionSource = {
      id: 'mount:input', label: 'input', folders: true,
      page: vi.fn(async (req) => {
        requests.push(req)
        if (req.cursor === 'root-next') return { items: [file('root-page-two')] }
        if (req.query !== '') return { items: [file('search-result')], cursor: 'search-next' }
        if (req.folder === 'photos/trips') return { items: [file('trip')] }
        if (req.folder === 'photos') return { items: [folder('photos/trips'), file('photo')], cursor: 'photos-next' }
        return { items: [folder('photos'), file('root-file')], cursor: 'root-next' }
      }),
    }
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <CollectionPanel sources={[source]} />, root)
    await settle()
    const rootFile = root.querySelector<HTMLElement>('[data-entry="root-file"]')!
    expect(rootFile.getAttribute('data-tooltip-label')).toBe('root-file.png')
    expect(rootFile.querySelector('.collection-title')?.getAttribute('title')).toBeNull()
    expect(root.querySelector('[data-testid="collection-mode"]')?.getAttribute('data-tooltip-label')).toBe('Grid view')

    root.querySelector<HTMLButtonElement>('[data-testid="collection-more"]')!.click()
    await vi.waitFor(() => expect(requests.at(-1)?.cursor).toBe('root-next'))
    await vi.waitFor(() => expect(root.querySelectorAll('[data-entry="folder:photos"]')).toHaveLength(1))
    root.querySelector<HTMLElement>('[data-entry="folder:photos"]')!.click()
    await vi.waitFor(() => expect(requests.at(-1)?.folder).toBe('photos'))
    expect(requests.at(-1)?.cursor).toBeUndefined()

    root.querySelector<HTMLElement>('[data-entry="folder:photos/trips"]')!.click()
    await vi.waitFor(() => expect(requests.at(-1)?.folder).toBe('photos/trips'))
    expect(root.querySelector('[aria-current="page"]')?.textContent).toBe('trips')
    const crumb = [...root.querySelectorAll<HTMLButtonElement>('[data-testid="collection-folders"] button')].find((button) => button.textContent === 'photos')!
    crumb.click()
    await vi.waitFor(() => expect(requests.at(-1)?.folder).toBe('photos'))
    expect(root.querySelector('[aria-label="Back one folder"]')).toBeNull()
    const rootCrumb = [...root.querySelectorAll<HTMLButtonElement>('[data-testid="collection-folders"] button')].find((button) => button.textContent === 'root')!
    rootCrumb.click()
    await vi.waitFor(() => expect(requests.at(-1)?.folder).toBeUndefined())
    expect(root.querySelector('[aria-current="page"]')?.textContent).toBe('root')

    root.querySelector<HTMLElement>('[data-entry="folder:photos"]')!.click()
    await vi.waitFor(() => expect(requests.at(-1)?.folder).toBe('photos'))
    const search = root.querySelector<HTMLInputElement>('[data-testid="collection-search"]')!
    search.value = 'moon'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await vi.waitFor(() => expect(requests.at(-1)?.query).toBe('moon'))
    const clear = root.querySelector<HTMLButtonElement>('[data-testid="collection-search-clear"]')!
    expect(clear.getAttribute('aria-label')).toBe('Clear search')
    clear.focus()
    clear.click()
    await vi.waitFor(() => expect(requests.at(-1)?.query).toBe(''))
    expect(search.value).toBe('')
    await vi.waitFor(() => expect(document.activeElement).toBe(search))

    search.value = 'moon'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await vi.waitFor(() => expect(requests.at(-1)?.query).toBe('moon'))
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.waitFor(() => expect(requests.at(-1)?.query).toBe(''))
    expect(search.value).toBe('')
    expect(requests.at(-1)?.folder).toBe('photos')
    expect(requests.at(-1)?.cursor).toBeUndefined()
    expect(root.querySelector('[data-testid="collection-search-clear"]')).toBeNull()

    unmount()
  })

  it('keeps nested initial selection armed until its folder page arrives', async () => {
    const source: CollectionSource = {
      id: 'mount:input', label: 'input', folders: true,
      page: async (req) => req.folder === 'photos'
        ? { items: [file('current')] }
        : { items: [folder('photos')] },
    }
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <CollectionPanel sources={[source]} initialSelection={(entry) => entry.id === 'current'} />, root)
    await settle()
    root.querySelector<HTMLElement>('[data-entry="folder:photos"]')!.click()
    await vi.waitFor(() => expect(root.querySelector('[data-entry="current"]')?.getAttribute('aria-selected')).toBe('true'))
    unmount()
  })

  it('does not restore a nested initial selection after the user keyboard-selects another file', async () => {
    const source: CollectionSource = {
      id: 'mount:input', label: 'input', folders: true,
      page: async (req) => req.folder === 'photos'
        ? { items: [file('current')] }
        : { items: [folder('photos'), file('other')] },
    }
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <CollectionPanel sources={[source]} initialSelection={(entry) => entry.id === 'current'} />, root)
    await settle()
    const folderRow = root.querySelector<HTMLElement>('[data-entry="folder:photos"]')!
    folderRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(root.querySelector('[data-entry="other"]')?.getAttribute('aria-selected')).toBe('true')
    folderRow.click()
    await vi.waitFor(() => expect(root.querySelector('[data-entry="current"]')).not.toBeNull())
    expect(root.querySelector('[data-entry="current"]')?.getAttribute('aria-selected')).toBe('false')
    unmount()
  })
})
