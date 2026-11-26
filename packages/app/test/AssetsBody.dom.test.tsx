// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DinksterConnection } from '@dinkster/client'
import { asConnectionId, setLocale } from '@dinkster/core'
import { AssetsBody } from '../src/AssetsBody.js'
import { AssetEntrySelection } from '../src/asset-browser/rail.js'
import { assetEntryOf } from '../src/asset-browser/collection-adapter.js'
import type { DinksterDesktopBridge } from '../src/desktop-bridge.js'
import '../src/locale.js'

afterEach(() => {
  delete window.dinksterDesktop
  vi.useRealTimers()
  document.body.replaceChildren()
  localStorage.clear()
  setLocale('en')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const stubConnection = <T extends object>(members: T): DinksterConnection => ({
  id: 'native',
  onEvent: () => () => undefined,
  onMountsChanged: () => () => undefined,
  fetchAssetBytes: async () => new Uint8Array([1, 7, 3]).buffer,
  fetchAssetLocations: async () => [],
  fetchMountSettings: async () => ({
    mounts: await (members as { listMounts: DinksterConnection['listMounts'] }).listMounts(),
    outputMount: 'output', mountChangesAllowed: false,
  }),
  ...members,
} as unknown as DinksterConnection)

describe('Assets dock body', () => {
  it('opens on files in available non-model mounts and keeps scope and depth explicit while scrolling', async () => {
    const requests: URL[] = []
    const mounts = [
      { id: 'input', mode: 'read', state: 'ready', entryCount: 2 },
      { id: 'output', mode: 'readwrite', state: 'ready', entryCount: 61 },
      { id: 'models', mode: 'read', state: 'ready', kind: 'model/checkpoint', entryCount: 5 },
      { id: 'missing', mode: 'read', state: 'failed', entryCount: 20 },
    ]
    const entry = (name: string) => ({ virtualPath: `mounts/output/${name}`, name, digest: 'blake3:a', size: 7, mediaType: 'application/octet-stream', modifiedAt: 1700000000 })
    const connection = new DinksterConnection({
      id: asConnectionId('native'), baseUrl: 'http://native', clientId: 'test',
      fetchFn: async (url) => {
        const request = new URL(url); requests.push(request)
        if (request.pathname === '/api/mounts') return new Response(JSON.stringify({ mounts, outputMount: 'output', activeOutputMount: 'output' }))
        const page = request.searchParams.has('cursor') ? { entries: [entry('last.bin')], total: 61 }
          : request.pathname.includes('/output/') ? { entries: [entry('direct.bin')], total: 1 }
            : { entries: Array.from({ length: 60 }, (_, index) => entry(`newest-${index}.bin`)), cursor: 'more', total: 61 }
        return new Response(JSON.stringify(page))
      },
    })
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)
    try {
      await vi.waitFor(() => expect(root.querySelectorAll('[data-entry]')).toHaveLength(60))
      const first = requests.find((request) => request.pathname === '/api/mounts/entries')!
      expect(first.searchParams.getAll('mount')).toEqual(['input', 'output'])
      expect(first.searchParams.get('sort')).toBe('newest')
      expect(first.searchParams.get('limit')).toBe('60')
      expect(root.textContent).toContain('All mounts, with subfolders')
      const viewport = root.querySelector<HTMLElement>('[data-testid="collection-items"]')!
      Object.defineProperties(viewport, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 } })
      viewport.scrollTop = 800; viewport.dispatchEvent(new Event('scroll'))
      await vi.waitFor(() => expect(root.textContent).toContain('last.bin'))
      expect(root.querySelectorAll('[data-entry]')).toHaveLength(61)
      root.querySelector<HTMLButtonElement>('[data-testid="asset-source-select"]')!.click()
      expect(document.querySelector('[data-option-id="mount:models"]')).toBeNull()
      expect(document.querySelector('[data-option-id="mount:missing"]')).toBeNull()
      document.querySelector<HTMLElement>('[data-option-id="mount:output"]')!.click()
      await vi.waitFor(() => expect(root.textContent).toContain('direct.bin'))
      const shallow = root.querySelector<HTMLInputElement>('[aria-label="Folder depth"] input[value="false"]')!
      shallow.checked = true; shallow.dispatchEvent(new Event('change', { bubbles: true }))
      await vi.waitFor(() => expect(requests.at(-1)?.searchParams.get('recursive')).toBe('false'))
      expect(requests.at(-1)?.pathname).toBe('/api/mounts/output/entries')
      const search = root.querySelector<HTMLInputElement>('[data-testid="collection-search"]')!
      search.value = 'direct'; search.dispatchEvent(new InputEvent('input', { bubbles: true }))
      await vi.waitFor(() => expect(requests.at(-1)?.searchParams.get('q')).toBe('direct'))
      expect(requests.at(-1)?.searchParams.get('recursive')).toBe('false')
      expect(root.textContent).toContain('output, this folder only')
      expect(root.querySelector('[data-testid="collection-more"]')).toBeNull()
      const deep = root.querySelector<HTMLInputElement>('[aria-label="Folder depth"] input[value="true"]')!
      deep.checked = true; deep.dispatchEvent(new Event('change', { bubbles: true }))
      await vi.waitFor(() => expect(requests.at(-1)?.searchParams.get('recursive')).toBe('true'))
      expect(requests.at(-1)?.searchParams.get('q')).toBe('direct')
      root.querySelector<HTMLButtonElement>('[data-testid="asset-sort-select"]')!.click()
      document.querySelector<HTMLElement>('[data-option-id="name"]')!.click()
      await vi.waitFor(() => expect(requests.at(-1)?.searchParams.get('sort')).toBe('name'))
      expect(requests.at(-1)?.searchParams.get('q')).toBe('direct')
    } finally { dispose() }
  })

  it.each(['accepted', 'closed', 'late-body', 'stale-connection'])(
    'loads card and detail image bodies without publishing stale local URLs: %s', async (scenario) => {
      const digest = `blake3:${'a'.repeat(64)}`
      let finish!: () => void
      const body = new Promise<ArrayBuffer>((resolve) => { finish = () => resolve(new Uint8Array([17, 31, 7]).buffer) })
      const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:image-${createUrl.mock.calls.length}`)
      const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
      const fetchAsset = vi.fn(async () => new Response(await body, { headers: { 'content-type': 'image/png' } }))
      vi.stubGlobal('fetch', fetchAsset)
      const connection = stubConnection({
        assetUrl: (digest: string) => `/api/assets/${digest}`,
        listMounts: async () => [{ id: 'input', mode: 'read', state: 'ready' }],
        listMountEntries: async () => ({ entries: [{ virtualPath: 'mounts/input/a.png', name: 'a.png', digest, size: 3, mediaType: 'image/png', kind: 'media/image' }] }),
      })
      const [selected, setSelected] = createSignal(connection)
      const root = document.createElement('div'); document.body.append(root)
      const dispose = render(() => <AssetsBody connection={selected()} backendId="native" />, root)
      let closed = false
      try {
        await vi.waitFor(() => expect(fetchAsset).toHaveBeenCalledTimes(1))
        expect(root.querySelector('[data-testid="asset-selection-summary"]')).toBeNull()
        root.querySelector<HTMLElement>('[data-testid="collection-entry"]')!.click()
        await vi.waitFor(() => expect(fetchAsset).toHaveBeenCalledTimes(2))
        expect(root.querySelector('.collection-inline-detail [data-testid="asset-selection-summary"]')).not.toBeNull()
        expect(root.querySelectorAll('img')).toHaveLength(0)
        if (scenario === 'closed' || scenario === 'late-body') { dispose(); closed = true }
        if (scenario === 'stale-connection') setSelected(stubConnection({ assetUrl: () => '/other', listMounts: async () => [] }))
        expect(createUrl).not.toHaveBeenCalled()
        finish()
        if (scenario === 'accepted') {
          await vi.waitFor(() => expect(root.querySelectorAll('img')).toHaveLength(2))
          const image = root.querySelector<HTMLImageElement>('.asset-preview')!
          Object.defineProperties(image, { naturalWidth: { value: 640 }, naturalHeight: { value: 480 } })
          image.dispatchEvent(new Event('load'))
          expect(root.querySelector('[data-testid="asset-preview-caption"]')?.textContent).toBe('640 x 480')
          const pictures = root.querySelector<HTMLInputElement>('[aria-label="File view"] input[value="grid"]')!
          pictures.checked = true; pictures.dispatchEvent(new Event('change', { bubbles: true }))
          expect(localStorage.getItem('dinkster.assetBrowser.view.v1')).toBe('grid')
          expect(root.querySelector('.collection-content > [data-testid="asset-selection-summary"]')).not.toBeNull()
          const blob = createUrl.mock.calls[0]![0] as Blob
          expect(blob.type).toBe('image/png')
          expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([17, 31, 7])
          dispose(); closed = true
          expect(revokeUrl.mock.calls.map(([url]) => url)).toContain('blob:image-1')
          expect(revokeUrl.mock.calls.map(([url]) => url)).toContain('blob:image-2')
        } else {
          await Promise.resolve(); await Promise.resolve()
          expect(createUrl).not.toHaveBeenCalled()
        }
        expect(root.querySelectorAll('img.collection-thumb, img.asset-preview')).toHaveLength(0)
      } finally { finish(); if (!closed) dispose() }
    },
  )

  it('keeps available mounts for a null output and offers one configuration link', async () => {
    const connection = new DinksterConnection({
      id: asConnectionId('native'), baseUrl: 'http://native', clientId: 'test',
      fetchFn: async (url) => new Response(JSON.stringify(String(url).endsWith('/api/mounts')
        ? { mounts: [{ id: 'inputs', mode: 'read', state: 'ready', entryCount: 1 }], outputMount: null, activeOutputMount: null }
        : { entries: [] })),
    })
    const root = document.createElement('div'); document.body.append(root)
    const opened = vi.fn()
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" onOpenStorage={opened} />, root)
    try {
      await vi.waitFor(() => expect(root.textContent).toContain('No output mount is configured.'))
      root.querySelector<HTMLButtonElement>('[data-testid="asset-source-select"]')!.click()
      expect(document.querySelector('[data-option-id="mount:inputs"]')).not.toBeNull()
      const links = [...root.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === 'Open Storage')
      expect(links).toHaveLength(1); links[0]!.click()
      expect(opened).toHaveBeenCalledOnce()
    } finally { dispose() }
  })

  it('keeps scanning entries readable and resumes discovery after a transient failure', async () => {
    vi.useFakeTimers()
    const listMounts = vi.fn()
      .mockResolvedValueOnce([{ id: 'input', mode: 'read', state: 'scanning', entryCount: 4 }])
      .mockRejectedValueOnce(new Error('temporary mount listing failure'))
      .mockResolvedValue([{ id: 'input', mode: 'read', state: 'ready', entryCount: 10 }])
    const connection = stubConnection({ listMounts, assetUrl: () => '', listMountEntries: async () => ({ entries: [
      { virtualPath: 'mounts/input/indexed.bin', name: 'indexed.bin', size: 7, mediaType: 'application/octet-stream' },
    ] }) })
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)
    try {
      await vi.waitFor(() => expect(root.textContent).toContain('indexed.bin'))
      expect(root.textContent).toContain('Reading folder...')
      await vi.advanceTimersByTimeAsync(1000)
      expect(root.textContent).toContain('temporary mount listing failure')
      expect(root.textContent).toContain('indexed.bin')
      await vi.advanceTimersByTimeAsync(1000)
      expect(root.textContent).not.toContain('Reading folder...')
      expect(root.textContent).not.toContain('temporary mount listing failure')
    } finally { dispose() }
  })

  it('re-discovers sources on a backend switch and ignores a stale discovery response', async () => {
    let release!: (mounts: readonly { id: string; mode: 'read'; state: string }[]) => void
    const first = stubConnection({ listMounts: () => new Promise((resolve) => { release = resolve }) })
    const second = stubConnection({ listMounts: async () => [{ id: 'second', mode: 'read', state: 'ready' }], listMountEntries: async () => ({ entries: [] }), assetUrl: () => '' })
    const [current, setCurrent] = createSignal(first)
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <AssetsBody connection={current()} backendId="native" />, root)
    try {
      setCurrent(second)
      await vi.waitFor(() => expect(root.querySelector('[data-testid="asset-source-select"]')).not.toBeNull())
      root.querySelector<HTMLButtonElement>('[data-testid="asset-source-select"]')!.click()
      expect(document.querySelector('[data-option-id="mount:second"]')).not.toBeNull()
      release([{ id: 'first', mode: 'read', state: 'ready' }])
      await Promise.resolve(); await Promise.resolve()
      expect(document.querySelector('[data-option-id="mount:first"]')).toBeNull()
    } finally { dispose() }
  })

  it('reports mount discovery failures and retries without offering local catalog assets', async () => {
    const listMounts = vi.fn().mockRejectedValueOnce(new Error('mount catalog offline')).mockResolvedValue([{ id: 'input', mode: 'read', state: 'ready' }])
    const connection = stubConnection({ listMounts, listMountEntries: async () => ({ entries: [] }), assetUrl: () => '' })
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)
    try {
      await vi.waitFor(() => expect(root.textContent).toContain('mount catalog offline'))
      root.querySelector<HTMLButtonElement>('[data-testid="assets-retry"]')!.click()
      await vi.waitFor(() => expect(root.querySelector('[data-testid="asset-source-select"]')).not.toBeNull())
      expect(root.textContent).not.toContain('mount catalog offline')
      root.querySelector<HTMLButtonElement>('[data-testid="asset-source-select"]')!.click()
      expect(document.querySelector('[data-option-id="mount:input"]')).not.toBeNull()
    } finally { dispose() }
  })

  it('reports a mount listing failure rather than displaying an empty collection', async () => {
    const connection = stubConnection({ listMounts: async () => [{ id: 'broken', mode: 'read', state: 'ready' }], listMountEntries: async () => { throw new Error('index unavailable') }, assetUrl: () => '' })
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)
    try { await vi.waitFor(() => expect(root.querySelector('[data-collection-state="error"]')?.textContent).toContain('index unavailable')) }
    finally { dispose() }
  })
})

describe('Shared asset selection', () => {
  it.each(['selection', 'engine'])('ignores a pending hide completion after changing %s', async (change) => {
    const item = (name: string) => assetEntryOf({ id: name, name, kind: 'model/checkpoint', digest: `blake3:${'a'.repeat(64)}`,
      virtualPath: `mounts/models/${name}`, rawRef: { digest: `blake3:${'a'.repeat(64)}`, virtualPath: `mounts/models/${name}` }, source: { id: 'mount:models', label: 'Models' } })
    let finish!: () => void
    const first = { hideModel: async () => { await new Promise<void>((resolve) => { finish = resolve }); return {} as never }, fetchAssetLocations: async () => [] }
    const second = { ...first, hideModel: vi.fn() }
    const [connection, setConnection] = createSignal(first)
    const [entry, setEntry] = createSignal(item('first.safetensors'))
    const changed = vi.fn()
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <AssetEntrySelection entry={entry()} adapters={[]} backendId="native" connection={connection()} visibilityConnection={connection()} backendUrl="" onVisibilityChanged={changed} />, root)
    try {
      const button = () => root.querySelector<HTMLButtonElement>('[data-testid="model-visibility-action"] button:last-child')!
      button().click(); button().click()
      expect(button().disabled).toBe(true)
      if (change === 'engine') setConnection(second)
      else setEntry(item('second.safetensors'))
      finish(); await Promise.resolve(); await Promise.resolve()
      expect(changed).not.toHaveBeenCalled()
      expect(root.textContent).not.toContain('Hidden in this project.')
      expect(second.hideModel).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it.each([false, true])('keeps produced-output provenance and server paths with native reveal %s', async (reveal) => {
    const digest = `blake3:${'d'.repeat(64)}`
    const item = { id: 'kept', digest, name: 'kept.bin', size: 7, mediaType: 'application/octet-stream', virtualPath: 'mounts/output/kept.bin', source: { id: 'mount:output', label: 'output' },
      details: [{ label: 'Job', text: 'output-job' }, { label: 'Node', text: 'save-node' }] }
    const revealFile = vi.fn().mockResolvedValue(undefined)
    window.dinksterDesktop = { fileCapabilities: async () => ({ nativeFolderChoice: false, reveal }), revealFile } as unknown as DinksterDesktopBridge
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    const connection = stubConnection({ fetchAssetLocations: async () => ['/server/output/kept.bin'] })
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <AssetEntrySelection entry={assetEntryOf(item)} adapters={[]} backendId="remote" connection={connection} backendUrl="http://remote.test:3639" backendLabel="Render workstation" />, root)
    try {
      await vi.waitFor(() => expect(root.textContent).toContain('Copy server path'))
      expect(root.textContent).toContain('Render workstation')
      expect(root.querySelector('[data-testid="asset-rail-details"]')?.textContent).toContain('output-job')
      ;[...root.querySelectorAll('button')].find((button) => button.textContent === 'Copy server path')!.click()
      expect(copy).toHaveBeenCalledWith('/server/output/kept.bin')
      const button = [...root.querySelectorAll('button')].find((button) => button.textContent === 'Show file on this computer')
      if (reveal) {
        expect(button).toBeDefined()
        await vi.waitFor(() => expect(button!.disabled).toBe(false))
        button!.click()
        await vi.waitFor(() => expect(revealFile).toHaveBeenCalledWith('http://remote.test:3639/', { digest, scope: 'local', project: 'default' }))
      }
      else expect(button).toBeUndefined()
    } finally { dispose() }
  })
})
