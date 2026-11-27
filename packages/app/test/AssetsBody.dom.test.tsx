// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DinksterConnection, RequestFailure } from '@dinkster/client'
import { asConnectionId, setLocale } from '@dinkster/core'
import { AssetsBody } from '../src/AssetsBody.js'
import { AssetEntrySelection } from '../src/asset-browser/rail.js'
import { assetEntryOf } from '../src/asset-browser/collection-adapter.js'
import { ASSET_DRAG_TYPE, readAssetDrag } from '../src/asset-browser/drag.js'
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
  it('opens the requested mount after discovery without overriding later source choices', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const connection = stubConnection({
      listMounts: async () => {
        await pending
        return [{ id: 'renders', mode: 'readwrite', state: 'ready', entryCount: 1 }, { id: 'plates', mode: 'read', state: 'ready', entryCount: 0 }]
      },
      listMountEntries: async (id: string) => ({ entries: id === 'renders' ? [{ virtualPath: 'render.txt', name: 'render.txt', size: 7, mediaType: 'text/plain' }] : [] }),
      assetUrl: () => '',
    })
    const [focus, setFocus] = createSignal({ mountId: 'plates' })
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" mountFocus={focus()} />, root)
    const source = () => root.querySelector<HTMLButtonElement>('[data-testid="asset-source-select"]')!
    try {
      finish()
      await vi.waitFor(() => expect(source().textContent).toContain('plates'))
      expect(root.querySelector('[data-testid="collection-entry"]')).toBeNull()
      setFocus({ mountId: 'renders' })
      await vi.waitFor(() => expect(root.querySelector('[data-testid="collection-entry"]')?.textContent).toContain('render.txt'))
      expect(source().textContent).toContain('renders')
      source().click()
      document.querySelector<HTMLButtonElement>('[data-option-id="all-mounts"]')!.click()
      await vi.waitFor(() => expect(source().textContent).toContain('All mounts'))
      setFocus({ mountId: 'renders' })
      await vi.waitFor(() => expect(source().textContent).toContain('renders'))
      await vi.waitFor(() => expect(root.querySelector('[data-testid="collection-entry"]')?.textContent).toContain('render.txt'))
    } finally { dispose() }
  })

  it('shows file modification dates and decoded dimensions below unselected pictures', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }))
    const connection = stubConnection({
      assetUrl: () => '/image',
      listMounts: async () => [{ id: 'input', mode: 'read', state: 'ready' }],
      listMountEntries: async () => ({ entries: [
        { virtualPath: 'mounts/input/wide.png', name: 'wide.png', digest: 'blake3:a', size: 7, mediaType: 'image/png', modifiedAt: 1700000000 },
        { virtualPath: 'mounts/input/tall.png', name: 'tall.png', digest: 'blake3:b', size: 9, mediaType: 'image/png', modifiedAt: 0 },
      ] }),
    })
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)
    try {
      await vi.waitFor(() => expect(root.querySelectorAll('img.collection-thumb')).toHaveLength(2))
      const rows = [...root.querySelectorAll<HTMLElement>('[data-testid="collection-entry"]')]
      for (const [index, [width, height]] of [[1024, 256], [320, 800]].entries()) {
        const image = rows[index]!.querySelector<HTMLImageElement>('img')!
        Object.defineProperties(image, { naturalWidth: { value: width }, naturalHeight: { value: height } })
        image.dispatchEvent(new Event('load'))
        expect(rows[index]!.querySelector('.asset-entry-dimensions')?.textContent).toBe(`${width} x ${height}`)
      }
      expect(rows[0]!.querySelector('time')?.dateTime).toBe('2023-11-14T22:13:20.000Z')
      expect(rows[1]!.querySelector('time')?.dateTime).toBe('1970-01-01T00:00:00.000Z')
      expect(root.querySelector('[data-testid="asset-selection-summary"]')).toBeNull()
      const pictures = root.querySelector<HTMLInputElement>('[aria-label="File view"] input[value="grid"]')!
      pictures.checked = true; pictures.dispatchEvent(new Event('change', { bubbles: true }))
      expect(rows[0]!.textContent).toContain('1024 x 256')
      expect(rows[1]!.textContent).toContain('320 x 800')
      rows[0]!.querySelector('img')!.dispatchEvent(new Event('error'))
      expect(rows[0]!.querySelector('.asset-entry-dimensions')).toBeNull()
      expect(rows[1]!.textContent).toContain('320 x 800')
    } finally { dispose() }
  })

  it('widens an empty search from this folder to subfolders and then all mounts without dropping the name', async () => {
    const connection = stubConnection({
      listMounts: async () => [{ id: 'input', mode: 'read', state: 'ready' }, { id: 'output', mode: 'readwrite', state: 'ready' }],
      listMountEntries: async (mount: string | undefined, request: { q?: string }) => ({ entries: mount === undefined && request.q === 'distant'
        ? [{ virtualPath: 'mounts/input/distant.bin', name: 'distant.bin', digest: 'blake3:a', size: 7, mediaType: 'application/octet-stream' }]
        : [] }),
    })
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)
    const click = (text: string) => [...root.querySelectorAll<HTMLElement>('button, label')].find((element) => element.textContent === text)!.click()
    try {
      await vi.waitFor(() => expect(root.textContent).not.toContain('Loading assets'))
      root.querySelector<HTMLButtonElement>('[data-testid="asset-source-select"]')!.click()
      document.querySelector<HTMLElement>('[data-option-id="mount:output"]')!.click()
      click('This folder')
      const search = root.querySelector<HTMLInputElement>('[data-testid="collection-search"]')!
      search.value = 'distant'; search.dispatchEvent(new InputEvent('input', { bubbles: true }))
      await vi.waitFor(() => expect(root.textContent).toContain('Search with subfolders'))
      click('Search with subfolders')
      await vi.waitFor(() => expect(root.textContent).toContain('Search all mounts'))
      expect(root.querySelector('[data-testid="asset-scope"]')?.textContent).toBe('output, with subfolders')
      click('Search all mounts')
      await vi.waitFor(() => expect(root.textContent).toContain('distant.bin'))
      expect(search.value).toBe('distant')
      expect(root.querySelector('[data-testid="asset-scope"]')?.textContent).toBe('All mounts, with subfolders')
    } finally { dispose() }
  })

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
          : request.pathname.includes('/output/') ? { entries: [entry('direct.bin')], total: 1,
            folders: request.searchParams.get('recursive') === 'false' && request.searchParams.get('path') === '' ? ['photos', 'empty', 'unknown'] : [],
            folderCounts: { photos: 3, empty: 0, unknown: '4' } }
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
      await vi.waitFor(() => expect(root.querySelector('[data-entry="mount:output:photos"]')?.textContent).toContain('3 items'))
      expect(root.querySelector('[data-entry="mount:output:empty"]')?.textContent).toContain('0 items')
      expect(root.querySelector('[data-entry="mount:output:unknown"]')?.textContent).not.toContain('4 items')
      const search = root.querySelector<HTMLInputElement>('[data-testid="collection-search"]')!
      search.value = 'direct'; search.dispatchEvent(new InputEvent('input', { bubbles: true }))
      await vi.waitFor(() => expect(requests.at(-1)?.searchParams.get('q')).toBe('direct'))
      expect(requests.at(-1)?.searchParams.get('recursive')).toBe('false')
      await vi.waitFor(() => expect(root.querySelector('[data-entry="mount:output:photos"]')).toBeNull())
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
      search.value = ''; search.dispatchEvent(new InputEvent('input', { bubbles: true }))
      shallow.checked = true; shallow.dispatchEvent(new Event('change', { bubbles: true }))
      await vi.waitFor(() => expect(root.querySelector('[data-entry="mount:output:photos"]')).not.toBeNull())
      root.querySelector<HTMLElement>('[data-entry="mount:output:photos"]')!.click()
      await vi.waitFor(() => expect(requests.at(-1)?.searchParams.get('path')).toBe('photos'))
      expect(root.textContent).toContain('output/photos, this folder only')
      root.querySelector<HTMLButtonElement>('[data-testid="asset-source-select"]')!.click()
      document.querySelector<HTMLElement>('[data-option-id="mount:output"]')!.click()
      await vi.waitFor(() => expect(requests.at(-1)?.searchParams.get('path')).toBe(''))
      expect(root.textContent).toContain('output, this folder only')
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
          await vi.waitFor(() => expect(root.querySelectorAll('img')).toHaveLength(1))
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
          expect(new Set(revokeUrl.mock.calls.map(([url]) => url))).toEqual(new Set(createUrl.mock.results.map((result) => result.value)))
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
      .mockResolvedValueOnce([{ id: 'input', mode: 'read', state: 'scanning', entryCount: 4,
        scanProgress: { filesDone: 4, filesTotal: 10, bytesDone: 28, bytesTotal: 70, elapsedSeconds: 1 } }])
      .mockRejectedValueOnce(new RequestFailure('GET', '/api/mounts', 503, 'temporary mount listing failure'))
      .mockResolvedValue([{ id: 'input', mode: 'read', state: 'ready', entryCount: 10 }])
    const connection = stubConnection({ listMounts, assetUrl: () => '', listMountEntries: async () => ({ entries: [
      { virtualPath: 'mounts/input/indexed.bin', name: 'indexed.bin', size: 7, mediaType: 'application/octet-stream' },
    ] }) })
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)
    try {
      await vi.waitFor(() => expect(root.textContent).toContain('indexed.bin'))
      expect(root.textContent).toContain('input: Scanning 4 of 10 files')
      await vi.advanceTimersByTimeAsync(1000)
      expect(root.textContent).toContain('temporary mount listing failure')
      expect(root.textContent).toContain('indexed.bin')
      await vi.advanceTimersByTimeAsync(1000)
      expect(root.textContent).not.toContain('Scanning 4 of 10 files')
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
      await vi.waitFor(() => expect(root.textContent).toContain('Loading assets'))
      expect(root.querySelector('[data-testid="collection-search"]')).not.toBeNull()
      expect(root.querySelector('[data-testid="asset-sort-select"]')).not.toBeNull()
      expect(root.querySelector('[data-testid="asset-source-select"]')).not.toBeNull()
      setCurrent(second)
      await vi.waitFor(() => expect(root.textContent).not.toContain('Loading assets'))
      root.querySelector<HTMLButtonElement>('[data-testid="asset-source-select"]')!.click()
      expect(document.querySelector('[data-option-id="mount:second"]')).not.toBeNull()
      release([{ id: 'first', mode: 'read', state: 'ready' }])
      await Promise.resolve(); await Promise.resolve()
      expect(document.querySelector('[data-option-id="mount:first"]')).toBeNull()
    } finally { dispose() }
  })

  it('reports mount discovery failures and retries without offering local catalog assets', async () => {
    const listMounts = vi.fn().mockRejectedValueOnce(new RequestFailure('GET', '/api/mounts', 503, 'mount catalog offline')).mockResolvedValue([{ id: 'input', mode: 'read', state: 'ready' }])
    const connection = stubConnection({ listMounts, listMountEntries: async () => ({ entries: [] }), assetUrl: () => '' })
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)
    try {
      await vi.waitFor(() => expect(root.textContent).toContain('mount catalog offline'))
      root.querySelector<HTMLButtonElement>('[data-testid="assets-retry"]')!.click()
      await vi.waitFor(() => expect(root.textContent).not.toContain('Loading assets'))
      expect(root.textContent).not.toContain('mount catalog offline')
      root.querySelector<HTMLButtonElement>('[data-testid="asset-source-select"]')!.click()
      expect(document.querySelector('[data-option-id="mount:input"]')).not.toBeNull()
    } finally { dispose() }
  })

  it('reports a mount listing failure rather than displaying an empty collection', async () => {
    const connection = stubConnection({ listMounts: async () => [{ id: 'broken', mode: 'read', state: 'ready' }], listMountEntries: async () => { throw new RequestFailure('GET', '/api/mounts/broken/entries', 503, 'index unavailable') }, assetUrl: () => '' })
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)
    try { await vi.waitFor(() => expect(root.querySelector('[data-collection-state="error"]')?.textContent).toContain('index unavailable')) }
    finally { dispose() }
  })
})

describe('Shared asset selection', () => {
  it('offers complete available media as project/backend-tagged drags, but not models or missing bytes', async () => {
    const assets = [
      { digest: `blake3:${'a'.repeat(64)}`, name: 'song.wav', mediaType: 'audio/wav', size: 42, virtualPath: 'mounts/input/song.wav' },
      { name: 'missing.mp4', mediaType: 'video/mp4', size: 84, virtualPath: 'mounts/input/missing.mp4' },
      { digest: `blake3:${'c'.repeat(64)}`, name: 'model.bin', mediaType: 'application/octet-stream', size: 126, virtualPath: 'mounts/input/model.bin' },
    ]
    const connection = stubConnection({
      listMounts: async () => [{ id: 'input', mode: 'read', state: 'ready' }], assetUrl: () => '',
      listMountEntries: async () => ({ entries: assets }),
    })
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" baseUrl="http://engine.test" />, root)
    try {
      await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(3))
      const row = (name: string) => [...root.querySelectorAll<HTMLElement>('[data-testid="collection-entry"]')].find((entry) => entry.textContent?.includes(name))!
      expect(row('missing.mp4').getAttribute('draggable')).toBe('false')
      expect(row('model.bin').getAttribute('draggable')).toBe('false')
      expect(row('song.wav').getAttribute('draggable')).toBe('true')
      const transfer = new Map<string, string>()
      const event = new Event('dragstart', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: { setData: (type: string, value: string) => transfer.set(type, value) } })
      row('song.wav').dispatchEvent(event)
      expect(readAssetDrag(transfer.get(ASSET_DRAG_TYPE)!)).toEqual({ project: 'default', baseUrl: 'http://engine.test', asset: assets[0] })
      expect(root.querySelector('[data-testid="asset-rail-details"]')).toBeNull()
    } finally { dispose() }
  })

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
      const button = () => [...root.querySelectorAll<HTMLButtonElement>('[data-testid="model-visibility-action"] button')].find((row) => row.textContent === 'Hide in this project')!
      button().click(); button().click()
      expect(button().getAttribute('aria-disabled')).toBe('true')
      expect(button().getAttribute('aria-busy')).toBe('true')
      if (change === 'engine') setConnection(second)
      else setEntry(item('second.safetensors'))
      finish(); await Promise.resolve(); await Promise.resolve()
      expect(changed).not.toHaveBeenCalled()
      expect(root.textContent).not.toContain('Hidden in this project.')
      expect(second.hideModel).not.toHaveBeenCalled()
    } finally { dispose() }
  })
  it('requires confirmation before hiding a selected model', async () => {
    const model = { virtualPath: 'mounts/checkpoints/a.safetensors', name: 'a.safetensors', digest: `blake3:${'d'.repeat(64)}`, size: 1031, mediaType: 'application/octet-stream', kind: 'model/checkpoint' }
    let hidden = false
    const connection = stubConnection({ hideModel: async () => { hidden = true; return {} }, fetchAssetLocations: async () => [] })
    const entry = assetEntryOf({ ...model, id: 'model', rawRef: model, source: { id: 'mount:checkpoints', label: 'Checkpoints' } })
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <AssetEntrySelection entry={entry} adapters={[]} backendId="native" connection={connection}
      visibilityConnection={connection} backendUrl="" />, root)
    try {
      const action = () => root.querySelector<HTMLElement>('[data-testid="model-visibility-action"]')!
      const button = (text: string) => [...action().querySelectorAll<HTMLButtonElement>('button')].find((row) => row.textContent === text)!
      button('Hide in this project').click()
      expect(action().textContent).toContain('no files are deleted')
      expect(hidden).toBe(false)
      button('Cancel').click()
      expect(hidden).toBe(false)
      expect(action().textContent).not.toContain('no files are deleted')
      button('Hide in this project').click()
      button('Hide in this project').click()
      await vi.waitFor(() => expect(action().textContent).toContain('Hidden in this project.'))
      expect(hidden).toBe(true)
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
      await vi.waitFor(() => expect(root.textContent).toContain('Copy path'))
      expect(root.textContent).not.toContain('not necessarily this computer')
      expect(root.querySelector('[data-testid="asset-rail-details"]')?.textContent).toContain('output-job')
      ;[...root.querySelectorAll('button')].find((button) => button.textContent === 'Copy path')!.click()
      expect(copy).toHaveBeenCalledWith('/server/output/kept.bin')
      const button = [...root.querySelectorAll('button')].find((button) => button.textContent === 'Show on this computer')
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
