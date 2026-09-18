// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerCatalog, setLocale, type CollectionEntry, type CollectionSource } from '@dinkster/core'
import { LibraryPanel } from '../src/LibraryPanel.js'
import '../src/locale.js'

const source = (id: string, label: string, entries: readonly CollectionEntry[]): CollectionSource => ({
  id,
  label,
  page: async () => ({ items: entries, total: entries.length }),
})

const backend = { label: 'Studio backend', protocol: 'dinkster' as const, status: 'connected' as const }

afterEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
  setLocale('en')
  vi.restoreAllMocks()
})

describe('LibraryPanel', () => {
  it('updates open detail and transition chrome when the active locale changes', async () => {
    registerCatalog('de-DE', {
      'library.action.confirmDelete': '[Loschen bestatigen]',
      'library.backend': '[Server]',
      'library.detail.attributes': '[Eintragsmerkmale]',
      'library.detail.selected': '[Ausgewahlter Eintrag]',
      'library.results': '[Ergebnisse: {source}]',
      'library.search': '[Suche: {source}]',
      'library.source.collection': '[Bibliothekssammlung]',
      'library.source.collections': '[Bibliothekssammlungen]',
      'library.state.loading.directDetail': '[Lese {source} von {backend}.]',
      'library.state.loading.title': '[Lade {source}]',
    })
    let releaseTemplates!: (page: { items: readonly CollectionEntry[]; total: number }) => void
    const templateSource: CollectionSource = {
      id: 'templates',
      label: 'Templates',
      page: () => new Promise((resolve) => { releaseTemplates = resolve }),
    }
    const entry: CollectionEntry = {
      id: 'pack.proof',
      title: 'Pack supplied title',
      badges: ['pack supplied badge'],
      details: [{ label: 'pack field', text: 'pack supplied value' }],
      actions: [{ id: 'delete', label: 'Pack supplied delete' }],
    }
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <LibraryPanel
      backend={() => backend}
      sources={[source('packs', 'Packs', [entry]), templateSource]}
      onAction={() => {}}
    />, root)

    await vi.waitFor(() => expect(root.querySelector('[data-entry="pack.proof"]')).not.toBeNull())
    root.querySelector<HTMLElement>('[data-entry="pack.proof"]')!.click()
    const detail = root.querySelector<HTMLElement>('[data-testid="library-detail-rail"]')!
    const deleteAction = root.querySelector<HTMLButtonElement>('[data-testid="library-detail-action"]')!
    deleteAction.click()
    expect(root.querySelector('.library-backend-context')?.textContent).toContain('BackendStudio backend')
    expect(root.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Library collections')
    expect(root.querySelector('[data-testid="library-source-select"]')?.getAttribute('aria-label')).toBe('Library collection')
    expect(detail.getAttribute('aria-label')).toBe('Selected library item')
    expect(deleteAction.textContent).toBe('Confirm delete')

    setLocale('de-DE')

    expect(root.querySelector('.library-backend-context')?.textContent).toContain('[Server]Studio backend')
    expect(root.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('[Bibliothekssammlungen]')
    expect(root.querySelector('[data-testid="library-source-select"]')?.getAttribute('aria-label')).toBe('[Bibliothekssammlung]')
    expect(root.querySelector<HTMLInputElement>('[data-testid="collection-search"]')?.getAttribute('aria-label')).toBe('[Suche: packs]')
    expect(detail.getAttribute('aria-label')).toBe('[Ausgewahlter Eintrag]')
    expect(detail.querySelector('.library-detail-badges')?.getAttribute('aria-label')).toBe('[Eintragsmerkmale]')
    expect(deleteAction.textContent).toBe('[Loschen bestatigen]')
    expect(detail.textContent).toContain('Pack supplied title')
    expect(detail.textContent).toContain('pack supplied badge')
    expect(detail.textContent).toContain('pack supplied value')

    setLocale('en')
    root.querySelector<HTMLButtonElement>('[data-source="templates"]')!.click()
    await vi.waitFor(() => expect(root.querySelector('[data-testid="library-source-transition"]')?.textContent).toContain('Loading templates'))
    setLocale('de-DE')
    const transition = root.querySelector<HTMLElement>('[data-testid="library-source-transition"]')!
    expect(transition.textContent).toContain('[Lade templates]')
    expect(transition.textContent).toContain('[Lese Templates von Studio backend.]')
    expect(transition.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('[Ergebnisse: Templates]')
    releaseTemplates({ items: [], total: 0 })
    dispose()
  })

  it('presents backend provenance, keyboard source navigation, and direct-source states', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const [backendContext, setBackendContext] = createSignal<{
      readonly label: string
      readonly protocol: 'dinkster'
      readonly status: 'connected' | 'disconnected'
    }>(backend)
    const dispose = render(() => <LibraryPanel
      backend={backendContext}
      sources={[
        source('packs', 'Packs', [{ id: 'pack.long', title: 'Long Pack', details: [{ label: 'pack id', text: 'pack.long' }] }]),
        source('templates', 'Templates', []),
        source('workflows', 'Workflows', []),
        source('history', 'History', []),
        source('runs', 'Runs', []),
      ]}
    />, root)

    await vi.waitFor(() => expect(root.querySelector('[data-entry="pack.long"]')).not.toBeNull())
    expect(root.querySelector('.library-backend-context')?.textContent).toContain('Studio backend')
    expect(root.querySelector('.library-backend-context')?.textContent).toContain('Dinkster - connected')
    expect(root.querySelector<HTMLInputElement>('[data-testid="collection-search"]')?.getAttribute('aria-label')).toBe('Search packs')
    expect(root.querySelector('[data-testid="library-source-select"]')?.getAttribute('data-selected-id')).toBe('packs')

    const tabs = root.querySelectorAll<HTMLButtonElement>('[data-testid="collection-source"]')
    expect(root.querySelector('[role="group"][aria-label="Library collections"]')).not.toBeNull()
    expect(root.querySelector('[role="tablist"]')).toBeNull()
    expect([...tabs].map((tab) => tab.dataset['source'])).toEqual(['packs', 'templates', 'workflows', 'history', 'runs'])
    expect(tabs[0]?.tabIndex).toBe(0)
    expect(tabs[1]?.tabIndex).toBe(-1)
    tabs[0]!.focus()
    tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await vi.waitFor(() => expect(tabs[1]?.getAttribute('aria-pressed')).toBe('true'))
    await vi.waitFor(() => expect(document.activeElement).toBe(tabs[1]))
    expect(root.querySelector<HTMLInputElement>('[data-testid="collection-search"]')?.getAttribute('aria-label')).toBe('Search templates')
    await vi.waitFor(() => expect(root.textContent).toContain('No templates available'))
    expect(root.textContent).toContain('No workflow templates are available from Studio backend.')
    setBackendContext({ ...backend, status: 'disconnected' })
    await vi.waitFor(() => expect(root.querySelector('.library-backend-context')?.textContent).toContain('disconnected'))
    expect(root.querySelector('[data-testid="library-overlay"]')?.getAttribute('data-source')).toBe('templates')
    expect(tabs[1]?.getAttribute('aria-pressed')).toBe('true')
    dispose()
  })

  it('keeps direct item details inspectable and routes explicit actions with source identity', async () => {
    const onAction = vi.fn()
    const template: CollectionEntry = {
      id: 'pack/template/with/a/very/long/id',
      title: 'Template with a long descriptive name',
      subtitle: 'Modified 8/16/2026, 1:00:00 PM',
      badges: ['review', 'rev 7'],
      details: [
        { label: 'template id', text: 'pack/template/with/a/very/long/id' },
        { label: 'backend', text: 'Studio backend' },
        { label: 'digest', text: `blake3:${'a'.repeat(64)}` },
      ],
      actions: [{ id: 'open', label: 'Open template' }],
    }
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <LibraryPanel
      backend={() => backend}
      sources={[source('templates', 'Templates', [template])]}
      onAction={onAction}
    />, root)

    await vi.waitFor(() => expect(root.querySelector('[data-entry="pack/template/with/a/very/long/id"]')).not.toBeNull())
    root.querySelector<HTMLElement>('[data-entry="pack/template/with/a/very/long/id"]')!.click()
    const rail = root.querySelector('[data-testid="library-detail-rail"]')!
    expect(rail.textContent).toContain('pack/template/with/a/very/long/id')
    expect(rail.textContent).toContain(`blake3:${'a'.repeat(64)}`)
    const action = root.querySelector<HTMLButtonElement>('[data-testid="library-detail-action"]')!
    expect(action.textContent).toBe('Open template')
    action.click()
    expect(onAction).toHaveBeenCalledWith('templates', template, 'open')
    dispose()
  })

  it('resets detail position and destructive confirmation when selection changes', async () => {
    const onAction = vi.fn()
    const first: CollectionEntry = {
      id: 'run.first',
      title: 'First run',
      details: [{ label: 'run id', text: 'run.first' }],
      actions: [{ id: 'delete', label: 'Delete run' }],
    }
    const second: CollectionEntry = {
      id: 'run.second',
      title: 'Second run',
      details: [{ label: 'run id', text: 'run.second' }],
      actions: [{ id: 'delete', label: 'Delete run' }],
    }
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <LibraryPanel
      backend={() => backend}
      sources={[source('runs', 'Runs', [first, second])]}
      onAction={onAction}
    />, root)

    await vi.waitFor(() => expect(root.querySelector('[data-entry="run.first"]')).not.toBeNull())
    root.querySelector<HTMLElement>('[data-entry="run.first"]')!.click()
    const rail = root.querySelector<HTMLElement>('[data-testid="library-detail-rail"]')!
    const action = (): HTMLButtonElement => root.querySelector<HTMLButtonElement>('[data-testid="library-detail-action"]')!
    action().click()
    expect(action().textContent).toBe('Confirm delete')
    rail.scrollTop = 120

    root.querySelector<HTMLElement>('[data-entry="run.second"]')!.click()
    await vi.waitFor(() => expect(rail.scrollTop).toBe(0))
    expect(action().textContent).toBe('Delete run')
    action().click()
    expect(action().textContent).toBe('Confirm delete')
    expect(onAction).not.toHaveBeenCalled()
    dispose()
  })

  it('announces loading, error, and activity-specific empty states', async () => {
    let resolve!: (page: { items: readonly CollectionEntry[]; total: number }) => void
    const pending: CollectionSource = {
      id: 'packs',
      label: 'Packs',
      page: () => new Promise((done) => { resolve = done }),
    }
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <LibraryPanel backend={() => backend} sources={[pending]} />, root)
    await vi.waitFor(() => expect(root.querySelector('[role="status"] .search-state-loading')).not.toBeNull())
    expect(root.textContent).toContain('Loading packs')
    resolve({ items: [], total: 0 })
    await vi.waitFor(() => expect(root.textContent).toContain('No packs available'))
    dispose()

    const failed: CollectionSource = { id: 'templates', label: 'Templates', page: async () => { throw new Error('catalog offline') } }
    const disposeFailed = render(() => <LibraryPanel backend={() => backend} sources={[failed]} />, root)
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('catalog offline'))
    disposeFailed()

    const disposeHistory = render(() => <LibraryPanel backend={() => backend} sources={[source('history', 'History', [])]} />, root)
    await vi.waitFor(() => expect(root.querySelector('[data-collection-state="empty"]')?.textContent).toContain('No local execution snapshots'))
    expect(root.textContent).toContain('backend acceptance')
    disposeHistory()
  })

  it('hides prior-source rows behind a labelled loading state during source switches', async () => {
    let resolveTemplates!: (page: { items: readonly CollectionEntry[]; total: number }) => void
    const templates: CollectionSource = {
      id: 'templates',
      label: 'Templates',
      page: () => new Promise((done) => { resolveTemplates = done }),
    }
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <LibraryPanel
      backend={() => backend}
      sources={[source('packs', 'Packs', [{ id: 'pack.one', title: 'Pack One' }]), templates]}
    />, root)

    await vi.waitFor(() => expect(root.querySelector('[data-entry="pack.one"]')).not.toBeNull())
    root.querySelector<HTMLButtonElement>('[data-source="templates"]')!.click()
    await vi.waitFor(() => expect(root.querySelector('[data-testid="library-source-transition"]')?.textContent).toContain('Loading templates'))
    expect(root.querySelector('[data-testid="library-overlay"]')?.getAttribute('data-source-loading')).toBe('true')
    const search = root.querySelector<HTMLInputElement>('[data-testid="collection-search"]')!
    expect(search.getAttribute('aria-label')).toBe('Search templates')
    const transitionDescriptionId = search.getAttribute('aria-describedby')!
    const transitionResultsId = search.getAttribute('aria-controls')!
    expect(document.getElementById(transitionDescriptionId)?.textContent).toContain('Loading templates')
    expect(document.getElementById(transitionDescriptionId)?.textContent).not.toContain('1 entry in Templates')
    expect(document.getElementById(transitionResultsId)?.getAttribute('aria-label')).toBe('Templates results')
    expect(document.getElementById(transitionResultsId)?.getAttribute('aria-busy')).toBe('true')
    expect(document.getElementById(transitionResultsId)?.textContent).not.toContain('Pack One')
    expect(root.querySelector('[data-testid="collection-items"]')?.getAttribute('aria-hidden')).toBe('true')
    resolveTemplates({ items: [{ id: 'template.one', title: 'Template One' }], total: 1 })
    await vi.waitFor(() => expect(root.querySelector('[data-entry="template.one"]')).not.toBeNull())
    await vi.waitFor(() => expect(root.querySelector('[data-testid="library-source-transition"]')).toBeNull())
    expect(search.getAttribute('aria-describedby')).not.toBe(transitionDescriptionId)
    expect(search.getAttribute('aria-controls')).not.toBe(transitionResultsId)
    expect(root.querySelector('[data-testid="collection-items"]')?.getAttribute('aria-hidden')).toBeNull()
    dispose()
  })

  it('does not suggest unsupported saved-workflow writes on ComfyUI backends', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <LibraryPanel
      backend={() => ({ label: 'ComfyUI backend', protocol: 'v1', status: 'connected' })}
      sources={[source('workflows', 'Workflows', [])]}
    />, root)

    await vi.waitFor(() => expect(root.textContent).toContain('Saved workflows unavailable'))
    expect(root.textContent).toContain('Saved workflows require a native Dinkster backend.')
    expect(root.textContent).not.toContain('Save a workflow to ComfyUI backend')
    dispose()
  })
})
