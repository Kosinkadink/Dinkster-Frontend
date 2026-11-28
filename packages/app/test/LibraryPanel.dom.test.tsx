// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asConnectionId, createSignal as createCoreSignal, registerCatalog, setLocale, type CollectionEntry, type CollectionSource } from '@dinkster/core'
import { DinksterConnection, RequestFailure, type ModelDownloadJob } from '@dinkster/client'
import { LibraryPanel } from '../src/LibraryPanel.js'
import { LibraryModels } from '../src/LibraryModels.js'
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
  vi.useRealTimers()
})

describe('LibraryPanel', () => {
  it('unites folder models with exact job versions and removes stopped lines when their records disappear', async () => {
    vi.useFakeTimers()
    const digest = `blake3:${'a'.repeat(64)}`
    let published = false
    const locations = ['studio', 'archive'].map((id) => ({ id, path: `/${id}`, mode: 'read', visibility: 'default-on', mounts: [id], enabled: true, active: true }))
    const connection = new DinksterConnection({ id: asConnectionId('jobs'), baseUrl: '', clientId: 'human', project: 'studio', fetchFn: async (input) => {
      const path = new URL(String(input), 'http://example.test').pathname
      if (path === '/api/models/settings') return Response.json({ settings: { version: 1, downloadLocation: null, locations }, locations, revision: 'one', project: 'studio', changesAllowed: true, restartRequired: false, pendingRemovals: [] })
      if (path === '/api/mounts') return Response.json({ mounts: locations.map((location) => ({ id: location.id, mode: 'read', state: 'ready', kind: 'model/checkpoint' })) })
      if (path.endsWith('/entries')) return Response.json({ entries: path.includes('/studio/') || published ? [{ name: 'alpha.safetensors', virtualPath: 'alpha.safetensors', digest: path.includes('/studio/') ? digest : `blake3:${'b'.repeat(64)}`, size: 1024, mediaType: 'application/x-safetensors', kind: 'model/checkpoint' }] : [] })
      throw new Error(`Unexpected route ${path}`)
    } })
    const selection = { project: 'studio', provider: 'huggingface' as const, source: 'https://huggingface.co/example/model/resolve/main/alpha.safetensors',
      repo: 'example/model', revision: 'c'.repeat(40), file: 'alpha.safetensors', sha256: 'd'.repeat(64), size: 8192,
      license: 'apache-2.0', destination: '/archive/alpha.safetensors', mount: 'archive', kind: 'model/checkpoint' }
    const downloading: ModelDownloadJob = { ...selection, name: 'alpha.safetensors', digest: `blake3:${'b'.repeat(64)}`, jobId: 'active', status: 'downloading', received: 3072 }
    const stopped: ModelDownloadJob = { ...selection, name: 'beta.safetensors', file: 'beta.safetensors', jobId: 'stopped', status: 'failed', received: 1536 }
    const checking: ModelDownloadJob = { ...selection, kind: 'model/diffusion', name: 'gamma.safetensors', file: 'gamma.safetensors', mount: 'studio', jobId: 'checking', status: 'verifying', received: 8192 }
    const jobs = createCoreSignal<readonly ModelDownloadJob[]>([downloading, stopped, checking])
    const opened: ModelDownloadJob[] = []
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <LibraryModels connection={connection} downloadJobs={jobs} onDownload={(job) => opened.push(job)} onOpenStorage={() => {}} onAddModelFolder={() => {}} />, root)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(root.textContent).toContain('3 models in 2 folders')
      expect(root.querySelector('input[type="search"]')?.getAttribute('placeholder')).toBe('Search models')
      const row = (name: string) => [...root.querySelectorAll<HTMLButtonElement>('.dinkster-row-main')].find((button) => button.textContent?.includes(name))!
      expect(row('alpha.safetensors').textContent).toContain('Checkpoints, 1 here, 1 to download')
      expect(row('gamma.safetensors').textContent).toContain('Diffusion models')
      row('alpha.safetensors').click()
      expect(root.textContent).toContain('1 here, 1 to download')
      expect(root.querySelector('[role="progressbar"][aria-valuenow="0.375"]')).not.toBeNull()
      expect(root.textContent).toContain('38%, 3 of 8 KB')
      expect(root.textContent).not.toContain('Downloading')
      jobs.set([{ ...downloading, size: 0, received: 0 }, stopped, checking])
      expect(root.textContent).toContain('0 B')
      expect(root.textContent).not.toContain('Downloading')
      expect(root.textContent).not.toContain('of 0 B')
      expect(root.textContent).not.toContain('%')
      jobs.set([downloading, stopped, checking])
      expect(row('gamma.safetensors').textContent).toContain('Checking')
      expect(root.textContent).toContain('Not downloaded')
      root.querySelector<HTMLButtonElement>('[aria-label="Model kind"]')!.click()
      const checkpoints = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'Checkpoints')
      expect(checkpoints).toBeDefined()
      checkpoints!.click()
      expect(root.textContent).toContain('2 models in 2 folders')
      expect(root.textContent).not.toContain('gamma.safetensors')
      expect(row('alpha.safetensors').textContent).toContain('1 here, 1 to download')
      expect(row('alpha.safetensors').textContent).not.toContain('Checkpoints')
      expect(row('alpha.safetensors').textContent).not.toContain(', 1 here')
      const installed = [...root.querySelectorAll<HTMLButtonElement>('.dinkster-row-main')].find((button) => button.textContent === 'studio1 KB')!
      expect(installed).toBeDefined()
      expect(installed.querySelector('.dinkster-metadata')).toBeNull()
      expect(row('archive').textContent).toContain('38%, 3 of 8 KB')
      installed.click()
      const facts = installed.closest('li')!.querySelector('dl')!
      expect(facts.querySelector('code')?.title).toBe('alpha.safetensors')
      expect([...facts.querySelectorAll('.dinkster-fact')].find((fact) => fact.querySelector('dt')?.textContent === 'Model folder')?.querySelector('dd')?.textContent).toBe('studio')
      expect(row('beta.safetensors').textContent).toContain('Not downloaded')
      root.querySelector<HTMLButtonElement>('[aria-label="Model kind"]')!.click()
      ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'All kinds')!.click()
      expect(root.textContent).toContain('3 models in 2 folders')
      root.querySelector<HTMLButtonElement>('[aria-label="Download: beta.safetensors"]')!.click()
      expect(opened).toEqual([stopped])
      root.querySelector<HTMLButtonElement>('[aria-label="Model folder"]')!.click()
      ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'archive')!.click()
      expect(root.textContent).toContain('2 models in 1 folder')
      expect(row('alpha.safetensors').textContent).not.toContain('1 KB')
      expect(root.textContent).not.toContain('gamma.safetensors')
      jobs.set([{ ...downloading, status: 'cancelled' }, stopped, checking])
      expect(root.textContent).not.toContain('Downloading')
      root.querySelector<HTMLButtonElement>('[aria-label="Download: alpha.safetensors"]')!.click()
      expect(opened.at(-1)?.digest).toBe(downloading.digest)
      jobs.set([{ ...downloading, status: 'completed', indexingPending: true }, checking])
      expect(root.textContent).toContain('No matching models')
      expect(root.textContent).not.toContain('beta.safetensors')
      expect(root.textContent).not.toContain('Not downloaded')
      await vi.advanceTimersByTimeAsync(0)
      expect(root.textContent).toContain('No matching models')
      published = true
      jobs.set([{ ...downloading, status: 'completed', indexingPending: false }, checking])
      await vi.advanceTimersByTimeAsync(0)
      expect(root.textContent).toContain('1 model in 1 folder')
      expect(row('alpha.safetensors').textContent).toContain('1 KB')
      expect(root.textContent).not.toContain('Not downloaded')
      jobs.set([checking])
      expect(root.textContent).toContain('1 model in 1 folder')
      root.querySelector<HTMLButtonElement>('[aria-label="Model folder"]')!.click()
      ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'All model folders')!.click()
      expect(row('alpha.safetensors').textContent).toContain('2 here')
      expect(row('alpha.safetensors').textContent).not.toContain('to download')
    } finally { dispose(); root.remove() }
  })

  it('cancels hide questions on selection and backend changes and ignores obsolete hide completions', async () => {
    vi.useFakeTimers()
    for (const failed of [false, true]) {
      const replies: ((response: Response) => void)[] = []
      const writes: string[] = []
      const settings = new Map<string, unknown>()
      const connection = (id: string) => new DinksterConnection({
        id: asConnectionId(id), baseUrl: '', clientId: 'human', project: id,
        fetchFn: async (input) => {
          const path = new URL(String(input), 'http://example.test').pathname
          if (path.startsWith('/api/models/hidden/')) {
            writes.push(path)
            return new Promise<Response>((resolve) => replies.push(resolve))
          }
          if (path === '/api/models/settings') {
            const locations = [{ id: 'models', path: `/${id}`, mode: 'read', visibility: 'default-on', mounts: ['models'], enabled: true, active: true }]
            const state = { settings: { version: 1, downloadLocation: null, locations }, locations, revision: id, project: id, changesAllowed: true, restartRequired: false, pendingRemovals: [] }
            settings.set(id, state)
            return Response.json(state)
          }
          if (path === '/api/mounts') return Response.json({ mounts: [{ id: 'models', mode: 'read', state: 'ready', kind: 'model/checkpoint' }] })
          if (path.endsWith('/entries')) return Response.json({ entries: ['first', 'second'].map((name, index) => ({ name: `${id}-${name}.safetensors`, virtualPath: `${id}-${name}.safetensors`, digest: `blake3:${(index ? 'b' : 'a').repeat(64)}`, size: 1024, mediaType: 'application/x-safetensors', kind: 'model/checkpoint' })) })
          throw new Error(`Unexpected route ${path}`)
        },
      })
      const [current, setCurrent] = createSignal(connection('previous'))
      const root = document.createElement('div')
      document.body.append(root)
      const dispose = render(() => <LibraryModels connection={current()} onOpenStorage={() => {}} onAddModelFolder={() => {}} />, root)
      const action = (label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label)!
      const row = (name: string) => [...root.querySelectorAll<HTMLButtonElement>('.dinkster-row-main')].find((button) => button.textContent?.includes(name))!
      try {
        await vi.advanceTimersByTimeAsync(0)
        row('previous-first').click()
        action('Hide in this project').click()
        row('previous-second').focus()
        expect(root.textContent).not.toContain('from this project?')
        expect(writes).toEqual([])
        row('previous-first').focus()
        action('Hide in this project').click()
        action('Hide in this project').click()
        expect(action('Cancel').disabled).toBe(true)
        row('previous-first').click()
        row('previous-second').click()
        expect(root.textContent).not.toContain('from this project?')
        action('Hide in this project').click()
        action('Hide in this project').click()
        replies[0]!(failed ? new Response('Obsolete selection failure', { status: 503 }) : Response.json(settings.get('previous')))
        await vi.advanceTimersByTimeAsync(0)
        expect(root.textContent).toContain('Hide "previous-second.safetensors" from this project?')
        expect(action('Cancel').disabled).toBe(true)
        expect(root.querySelector('[role="alert"]')).toBeNull()
        setCurrent(connection('current'))
        await vi.advanceTimersByTimeAsync(0)
        expect(root.textContent).not.toContain('from this project?')
        row('current-first').click()
        action('Hide in this project').click()
        action('Hide in this project').click()
        expect(writes).toEqual(['/api/models/hidden/previous', '/api/models/hidden/previous', '/api/models/hidden/current'])
        replies[1]!(failed ? new Response('Obsolete failure', { status: 503 }) : Response.json(settings.get('previous')))
        await vi.advanceTimersByTimeAsync(0)
        expect(root.textContent).toContain('Hide "current-first.safetensors" from this project?')
        expect(action('Cancel').disabled).toBe(true)
        expect(root.querySelector('[role="alert"]')).toBeNull()
        replies[2]!(new Response('Current failure', { status: 503 }))
        await vi.advanceTimersByTimeAsync(0)
        expect(root.querySelector('[role="alert"]')?.textContent).toContain('Model visibility could not be changed.')
        expect(action('Cancel').disabled).toBe(false)
        action('Cancel').click()
        expect(root.querySelector('[role="alert"]')).toBeNull()
        expect(root.textContent).not.toContain('from this project?')
      } finally { dispose(); root.remove() }
    }
  })

  it('keeps the current backend models when an earlier folder read finishes or fails late', async () => {
    vi.useFakeTimers()
    for (const failed of [false, true]) {
      let finish!: (response: Response) => void
      const pending = new Promise<Response>((resolve) => { finish = resolve })
      const connection = (id: string, delayed: boolean) => new DinksterConnection({
        id: asConnectionId(id), baseUrl: '', clientId: 'human', project: id,
        fetchFn: async (input) => {
          const path = new URL(String(input), 'http://example.test').pathname
          if (path === '/api/models/settings') {
            const locations = [{ id: 'models', path: `/${id}`, mode: 'read', visibility: 'default-on', mounts: ['models'], enabled: true, active: true }]
            return Response.json({ settings: { version: 1, downloadLocation: null, locations }, locations, revision: id, project: id, changesAllowed: true, restartRequired: false, pendingRemovals: [] })
          }
          if (path === '/api/mounts') return Response.json({ mounts: [{ id: 'models', mode: 'read', state: 'ready', kind: 'model/checkpoint' }] })
          if (path.endsWith('/entries')) return delayed ? pending : Response.json({ entries: [{ name: `${id}.safetensors`, virtualPath: `${id}.safetensors`, digest: `blake3:${'a'.repeat(64)}`, size: 1024, mediaType: 'application/x-safetensors', kind: 'model/checkpoint' }] })
          throw new Error(`Unexpected route ${path}`)
        },
      })
      const [current, setCurrent] = createSignal(connection('previous', true))
      const root = document.createElement('div')
      document.body.append(root)
      const dispose = render(() => <LibraryModels connection={current()} onOpenStorage={() => {}} onAddModelFolder={() => {}} />, root)
      try {
        await vi.advanceTimersByTimeAsync(0)
        expect(root.textContent).toContain('Reading models')
        setCurrent(connection('current', false))
        await vi.advanceTimersByTimeAsync(0)
        expect(root.textContent).toContain('current.safetensors')
        expect(root.textContent).toContain('1 model in 1 folder')
        finish(failed ? new Response('Previous folder unavailable', { status: 503 }) : Response.json({ entries: [{ name: 'previous.safetensors', virtualPath: 'previous.safetensors', digest: `blake3:${'b'.repeat(64)}`, size: 2048, mediaType: 'application/x-safetensors', kind: 'model/checkpoint' }] }))
        await vi.advanceTimersByTimeAsync(0)
        expect(root.textContent).toContain('current.safetensors')
        expect(root.textContent).toContain('1 model in 1 folder')
        expect(root.textContent).not.toContain('previous.safetensors')
        expect(root.querySelector('[role="alert"]')).toBeNull()
        root.querySelector<HTMLButtonElement>('.dinkster-row-main')!.click()
        expect(root.querySelector('code')?.title).toBe('current.safetensors')
        expect(root.textContent).not.toContain('/previous')
      } finally { dispose(); root.remove() }
    }
  })

  it('filters equal-digest copies by their actual folder and hides the selected revision in its project', async () => {
    const digest = `blake3:${'a'.repeat(64)}`
    const otherDigest = `blake3:${'b'.repeat(64)}`
    const locations = ['studio', 'archive'].map((id) => ({ id, path: `/${id}`, mode: 'read' as const, visibility: 'default-on' as const, mounts: [id], enabled: true, active: true }))
    const state = { settings: { version: 1, downloadLocation: null, locations }, locations, revision: 'first', project: 'commercial', changesAllowed: true, restartRequired: false, pendingRemovals: [] }
    let hidden = false
    let rejectHide = true
    const writes: unknown[] = []
    const connection = new DinksterConnection({ id: asConnectionId('library'), baseUrl: '', clientId: 'human', project: 'commercial', fetchFn: async (input, init) => {
      const url = new URL(String(input), 'http://example.test')
      if (url.pathname === '/api/models/hidden/commercial') {
        writes.push(JSON.parse(String(init?.body)))
        if (rejectHide) return new Response('Unavailable', { status: 503 })
        hidden = true
        return Response.json(state)
      }
      if (url.pathname === '/api/models/settings') return Response.json(state)
      if (url.pathname === '/api/mounts') return Response.json({ mounts: locations.map((location) => ({ id: location.id, mode: 'read', state: location.id === 'archive' ? 'scanning' : 'ready', kind: 'model/checkpoint' })) })
      if (url.pathname.endsWith('/entries')) {
        const archive = url.pathname.includes('/archive/')
        const entries = hidden ? [] : [
          { name: archive ? 'zeta.safetensors' : 'alpha.safetensors', virtualPath: archive ? 'renamed/zeta.safetensors' : 'alpha.safetensors', digest, size: 1024, mediaType: 'application/x-safetensors', kind: 'model/checkpoint' },
          ...(!archive ? [{ name: 'unique.safetensors', virtualPath: 'unique.safetensors', digest: otherDigest, size: 2048, mediaType: 'application/x-safetensors', kind: 'model/checkpoint' }] : []),
        ]
        return Response.json({ entries: entries.filter((entry) => !url.searchParams.has('kind') || entry.kind === url.searchParams.get('kind')) })
      }
      throw new Error(`Unexpected route ${url.pathname}`)
    } })
    const folders: (string | undefined)[] = []
    const [focus, setFocus] = createSignal<{ readonly modelLocationId: string }>({ modelLocationId: 'studio' })
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <LibraryModels connection={connection} focus={focus()} onOpenStorage={(id) => folders.push(id)} onAddModelFolder={() => {}} />, root)
    try {
      await vi.waitFor(() => expect(root.textContent).toContain('2 models in 1 folder'))
      root.querySelector<HTMLButtonElement>('[aria-label="Model folder"]')!.click()
      ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'All model folders')!.click()
      await vi.waitFor(() => expect(root.textContent).toContain('2 models in 2 folders'))
      root.querySelector<HTMLButtonElement>('[aria-label="Model folder"]')!.click()
      const archive = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'archive')!
      archive.click()
      await vi.waitFor(() => expect(root.textContent).toContain('1 model in 1 folder'))
      setFocus({ modelLocationId: 'studio' })
      await vi.waitFor(() => expect(root.textContent).toContain('2 models in 1 folder'))
      const search = root.querySelector<HTMLInputElement>('input[type="search"]')!
      search.value = 'unique'
      search.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.waitFor(() => expect(root.textContent).toContain('1 model in 1 folder'))
      setFocus({ modelLocationId: 'archive' })
      await vi.waitFor(() => {
        expect(search.value).toBe('')
        expect(root.textContent).toContain('1 model in 1 folder')
      })
      root.querySelector<HTMLButtonElement>('[aria-label="Model folder"]')!.click()
      ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'All model folders')!.click()
      await vi.waitFor(() => expect(root.textContent).toContain('2 models in 2 folders'))
      setFocus({ modelLocationId: 'archive' })
      await vi.waitFor(() => expect(root.textContent).toContain('1 model in 1 folder'))
      expect(root.textContent).not.toContain('unique.safetensors')
      expect(root.textContent).toContain('Reading archive')
      root.querySelector<HTMLButtonElement>('.dinkster-row-main')!.click()
      await vi.waitFor(() => expect(root.textContent).toContain('renamed/zeta.safetensors'))
      const action = (label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label)!
      action('Show folder').click()
      expect(folders).toEqual(['archive'])
      action('Hide in this project').click()
      expect(writes).toEqual([])
      expect(root.textContent).toContain('Hide "alpha.safetensors" from this project?')
      await vi.waitFor(() => expect(document.activeElement).toBe(action('Cancel')))
      expect(root.textContent).toContain('renamed/zeta.safetensors')
      action('Cancel').click()
      expect(root.textContent).not.toContain('from this project?')
      expect(writes).toEqual([])
      action('Hide in this project').click()
      action('Cancel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(root.textContent).not.toContain('from this project?')
      expect(writes).toEqual([])
      action('Hide in this project').click()
      action('Hide in this project').click()
      await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('Model visibility could not be changed.'))
      expect(root.textContent).toContain('from this project?')
      expect(root.textContent).toContain('renamed/zeta.safetensors')
      expect(action('Cancel').disabled).toBe(false)
      rejectHide = false
      action('Hide in this project').click()
      await vi.waitFor(() => expect(root.textContent).toContain('No matching models'))
      expect(writes).toEqual(Array.from({ length: 2 }, () => ({ asset: { digest, name: 'zeta.safetensors', size: 1024, mediaType: 'application/x-safetensors', virtualPath: 'renamed/zeta.safetensors' }, kind: 'model/checkpoint' })))
    } finally { dispose() }
  })

  it('opens Models without leaving collection results reachable and returns to the chosen collection', async () => {
    const [modelsFocus, setModelsFocus] = createSignal<object>()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <LibraryPanel
      backend={() => backend}
      sources={[source('packs', 'Packs', [{ id: 'installed', title: 'Installed pack' }])]}
      models={() => <p>Models in this project</p>}
      modelsFocus={modelsFocus()}
    />, root)
    try {
      await vi.waitFor(() => expect(root.textContent).toContain('Installed pack'))
      const models = root.querySelector<HTMLButtonElement>('[data-source="models"]')!
      expect(models).not.toBeNull()
      models.click()
      expect(root.querySelector('[data-testid="library-overlay"]')?.getAttribute('data-source')).toBe('models')
      expect(root.textContent).toContain('Models in this project')
      expect(root.querySelector('.library-collection-body')?.hasAttribute('hidden')).toBe(true)
      root.querySelector<HTMLButtonElement>('[data-source="packs"]')!.click()
      await vi.waitFor(() => {
        expect(root.textContent).not.toContain('Models in this project')
        expect(root.querySelector('.library-collection-body')?.hasAttribute('hidden')).toBe(false)
        expect(root.textContent).toContain('Installed pack')
      })
      setModelsFocus({})
      await vi.waitFor(() => expect(root.querySelector('[data-testid="library-overlay"]')?.getAttribute('data-source')).toBe('models'))
      root.querySelector<HTMLButtonElement>('[data-source="packs"]')!.click()
      await vi.waitFor(() => expect(root.querySelector('[data-testid="library-overlay"]')?.getAttribute('data-source')).toBe('packs'))
      setModelsFocus({})
      await vi.waitFor(() => expect(root.querySelector('[data-testid="library-overlay"]')?.getAttribute('data-source')).toBe('models'))
    } finally { dispose() }
  })

  it('adds and withdraws a capability-controlled source without leaving its results reachable', async () => {
    const packs = source('packs', 'Packs', [{ id: 'pack', title: 'Installed pack' }])
    const templates = source('templates', 'Templates', [{ id: 'starter', title: 'Starter workflow' }])
    const [sources, setSources] = createSignal<readonly CollectionSource[]>([packs])
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <LibraryPanel backend={() => backend} sources={sources()} />, root)
    await vi.waitFor(() => expect(root.textContent).toContain('Installed pack'))
    setSources([packs, templates])
    root.querySelector<HTMLButtonElement>('[data-source="templates"]')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Starter workflow'))
    setSources([packs])
    await vi.waitFor(() => {
      expect(root.querySelector('[data-testid="library-overlay"]')?.getAttribute('data-source')).toBe('packs')
      expect(root.querySelector('[data-source="templates"]')).toBeNull()
      expect(root.textContent).not.toContain('Starter workflow')
      expect(root.textContent).toContain('Installed pack')
    })
    dispose()
  })

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
    await vi.waitFor(() => expect([...root.querySelectorAll('[role="status"]')].map((element) => element.textContent)).toContainEqual(expect.stringContaining('Loading packs')))
    expect(root.textContent).toContain('Loading packs')
    resolve({ items: [], total: 0 })
    await vi.waitFor(() => expect(root.textContent).toContain('No packs available'))
    dispose()

    const failed: CollectionSource = { id: 'templates', label: 'Templates', page: async () => { throw new RequestFailure('GET', '/api/templates', 503, 'catalog offline') } }
    const disposeFailed = render(() => <LibraryPanel backend={() => backend} sources={[failed]} />, root)
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('Could not load Templates.'))
    expect(root.querySelector('[role="alert"] [data-testid="collection-retry"]')).not.toBeNull()
    expect(root.textContent).not.toContain('catalog offline')
    disposeFailed()

    const disposeHistory = render(() => <LibraryPanel backend={() => backend} sources={[source('history', 'History', [])]} />, root)
    await vi.waitFor(() => expect(root.querySelector('[data-collection-state="empty"]')?.textContent).toContain('No local execution snapshots'))
    expect(root.textContent).toContain('backend acceptance')
    disposeHistory()
  })

})
