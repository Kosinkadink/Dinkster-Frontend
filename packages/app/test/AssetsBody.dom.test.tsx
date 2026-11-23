// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DinksterConnection } from '@dinkster/client'
import { asConnectionId, registerCatalog, setLocale } from '@dinkster/core'
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
})

const stubConnection = <T extends object>(members: T): DinksterConnection => ({
  id: 'native',
  status: { subscribe: () => () => undefined },
  fetchAssetBytes: async () => new Uint8Array([1, 7, 3]).buffer,
  onEvent: vi.fn(() => () => undefined),
  onMountsChanged: vi.fn(() => () => undefined),
  listLocalAssets: vi.fn().mockResolvedValue({ assets: [] }),
  checkAssetAvailability: vi.fn().mockResolvedValue([]),
  fetchAssetLocations: vi.fn().mockResolvedValue([]),
  fetchMountSettings: async () => ({
    mounts: await (members as { listMounts: DinksterConnection['listMounts'] }).listMounts(),
    outputMount: 'output', mountChangesAllowed: false,
  }),
  ...members,
} as unknown as DinksterConnection)

describe('Assets dock body', () => {
  it.each(['selection', 'engine'])('ignores a pending hide completion after changing %s', async (change) => {
    const item = (name: string) => assetEntryOf({ id: name, name, kind: 'model/checkpoint', digest: `blake3:${'a'.repeat(64)}`,
      virtualPath: `mounts/models/${name}`, rawRef: { digest: `blake3:${'a'.repeat(64)}`, virtualPath: `mounts/models/${name}` }, source: { id: 'mount:models', label: 'Models' } })
    let finish!: () => void
    const first = { hideModel: async () => {
      await new Promise<void>((resolve) => { finish = resolve })
      return { settings: { version: 1 as const, locations: [], downloadLocation: null }, locations: [], revision: 'first', project: 'default', changesAllowed: true, restartRequired: false, pendingRemovals: [] }
    }, fetchAssetLocations: async () => [] }
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
  it('requires confirmation to hide a selected model and refreshes Browse without deleting bytes', async () => {
    const model = { virtualPath: 'mounts/checkpoints/a.safetensors', name: 'a.safetensors', digest: `blake3:${'d'.repeat(64)}`, size: 1031, mediaType: 'application/octet-stream', kind: 'model/checkpoint' }
    let hidden = false
    const hideModel = vi.fn(async (asset, kind) => { expect(asset).toEqual(model); expect(kind).toBe(model.kind); hidden = true; return {} })
    const connection = stubConnection({ hideModel, assetUrl: () => '',
      listMounts: async () => [{ id: 'checkpoints', mode: 'read', state: 'ready', kind: model.kind }],
      listMountEntries: async () => ({ entries: hidden ? [] : [model] }) })
    const root = document.createElement('div'); document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)
    try {
      await vi.waitFor(() => expect(root.querySelector('[data-testid="collection-entry"]')).not.toBeNull())
      root.querySelector<HTMLElement>('[data-testid="collection-entry"]')!.click()
      const action = () => root.querySelector<HTMLElement>('[data-testid="model-visibility-action"]')!
      const button = (text: string) => [...action().querySelectorAll<HTMLButtonElement>('button')].find((row) => row.textContent === text)!
      button('Hide in this project').click()
      expect(action().textContent).toContain('No files will be deleted')
      expect(hideModel).not.toHaveBeenCalled()
      button('Cancel').click()
      expect(hideModel).not.toHaveBeenCalled()
      button('Hide in this project').click()
      button('Hide in this project').click()
      await vi.waitFor(() => expect(root.querySelector('[data-testid="collection-entry"]')).toBeNull())
      expect(hideModel).toHaveBeenCalledTimes(1)
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
        listMountEntries: async () => ({ entries: [{ virtualPath: 'a.png', name: 'a.png', digest, size: 3, mediaType: 'image/png', kind: 'media/image' }] }),
      })
      const [selected, setSelected] = createSignal(connection)
      const root = document.createElement('div'); document.body.append(root)
      const dispose = render(() => <AssetsBody connection={selected()} backendId="native" />, root)
      let closed = false
      try {
        await vi.waitFor(() => expect(fetchAsset).toHaveBeenCalledTimes(1))
        root.querySelector<HTMLElement>('[data-testid="collection-entry"]')!.click()
        await vi.waitFor(() => expect(fetchAsset).toHaveBeenCalledTimes(2))
        expect(root.querySelectorAll('img')).toHaveLength(0)
        if (scenario === 'closed') { dispose(); closed = true }
        if (scenario === 'closed') {
        } else {
          if (scenario === 'late-body') { dispose(); closed = true }
          if (scenario === 'stale-connection') setSelected(stubConnection({ assetUrl: () => '/other', listMounts: async () => [] }))
          expect(createUrl).not.toHaveBeenCalled()
          finish()
          if (scenario === 'accepted') {
            await vi.waitFor(() => expect(root.querySelectorAll('img')).toHaveLength(2))
            for (const image of root.querySelectorAll('img')) expect(image.getAttribute('src')).toMatch(/^blob:image-/)
            expect(createUrl).toHaveBeenCalledTimes(2)
            const blob = createUrl.mock.calls[0]![0] as Blob
            expect(blob.type).toBe('image/png')
            expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([17, 31, 7])
            dispose(); closed = true
            expect(revokeUrl.mock.calls.map(([url]) => url).sort()).toEqual(['blob:image-1', 'blob:image-2'])
          }
        }
        if (scenario !== 'accepted') expect(createUrl).not.toHaveBeenCalled()
        expect(root.querySelectorAll('img.collection-thumb, img.asset-preview')).toHaveLength(0)
      } finally { finish(); if (!closed) dispose() }
    },
  )

  it.each([false, true])('shows produced-output provenance and server paths with native reveal %s', async (reveal) => {
    const digest = `blake3:${'d'.repeat(64)}`
    const missing = `blake3:${'e'.repeat(64)}`
    const asset = { digest, name: 'kept.bin', size: 7, mediaType: 'application/octet-stream', virtualPath: 'mounts/output/kept.bin' }
    const revealFile = vi.fn().mockResolvedValue(undefined)
    window.dinksterDesktop = { fileCapabilities: async () => ({ nativeFolderChoice: false, reveal }), revealFile } as unknown as DinksterDesktopBridge
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    const connection = stubConnection({
      listMounts: async () => [],
      listLocalAssets: async () => ({ assets: [
        { asset, aliases: ['kept.bin'], observations: [{ kind: 'asset/file', created: 1700000000, origin: { kind: 'produced', job: 'output-job', node: 'save-node' } }] },
        { asset: { ...asset, digest: missing, name: 'missing.bin' }, aliases: ['missing.bin'], observations: [] },
      ] }),
      checkAssetAvailability: async () => [{ digest, status: 'available' }, { digest: missing, status: 'missing' }],
      assetUrl: (digest: string) => `/api/assets/${digest}`,
      fetchAssetLocations: async () => ['/server/output/kept.bin'],
    })
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="remote" baseUrl="http://remote.test:3639" backendLabel="Render workstation" />, root)
    try {
      await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(2))
      ;[...root.querySelectorAll<HTMLElement>('[data-testid="collection-entry"]')].find((row) => row.textContent?.includes('kept.bin'))!.click()
      await vi.waitFor(() => expect(root.textContent).toContain('Copy server path'))
      expect(root.textContent).toContain('Render workstation')
      const details = root.querySelector<HTMLDetailsElement>('[data-testid="asset-rail-details"]')!
      details.open = true
      expect(details.textContent).toContain('output-job')
      expect(details.textContent).toContain('save-node')
      expect(details.textContent).toContain('2023-11-14T22:13:20.000Z')
      ;[...root.querySelectorAll('button')].find((b) => b.textContent === 'Copy server path')!.click()
      await vi.waitFor(() => expect(copy).toHaveBeenCalledWith('/server/output/kept.bin'))
      const revealButton = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Show file on this computer')
      if (reveal) {
        expect(revealButton).toBeDefined()
        revealButton!.click()
        await vi.waitFor(() => expect(revealFile).toHaveBeenCalledWith('http://remote.test:3639/', { digest, scope: 'local', project: 'default' }))
      } else expect(revealButton).toBeUndefined()
      ;[...root.querySelectorAll<HTMLElement>('[data-testid="collection-entry"]')].find((row) => row.textContent?.includes('missing.bin'))!.click()
      expect(root.querySelector('[data-testid="asset-file-location"]')).toBeNull()
    } finally { dispose() }
  })

  it('keeps sources available for a null output and opens configuration on request', async () => {
    const connection = new DinksterConnection({
      id: asConnectionId('native'), baseUrl: 'http://native', clientId: 'test',
      fetchFn: async (url) => new Response(JSON.stringify(String(url).endsWith('/api/mounts')
        ? { mounts: [{ id: 'inputs', mode: 'read', state: 'ready', entryCount: 1 }], outputMount: null, activeOutputMount: null }
        : { entries: [] })),
    })
    const root = document.createElement('div')
    document.body.append(root)
    let storageOpened = false
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" onOpenStorage={() => { storageOpened = true }} />, root)
    try {
      await vi.waitFor(() => expect(root.textContent).toContain('No output mount configured'))
      expect(root.querySelector('[data-testid="assets-error"]')).toBeNull()
      const select = root.querySelector<HTMLButtonElement>('[data-testid="asset-source-select"]')!
      select.click()
      expect(document.querySelector('[data-option-id="mount:inputs"]')).not.toBeNull()
      root.querySelector<HTMLButtonElement>('[data-testid="assets-output-unconfigured"] button')!.click()
      expect(storageOpened).toBe(true)
      expect(root.querySelector('[data-testid="output-mount-settings"]')).toBeNull()
      expect(root.querySelector('.asset-project-folders')).toBeNull()
    } finally { dispose() }
  })

  it('updates open source and health controls without refetching or translating source data', async () => {
    registerCatalog('de-DE', {
      'assets.search': '[Assets durchsuchen]',
      'assets.source.all': '[Alle Assets]',
      'assets.source.ariaLabel': '[Assetquelle]',
      'assets.source.health.issues': '[{count, plural, one {# Problem} other {# Probleme}}]',
      'assets.source.health.title': '[Quellenzustand]',
      'assets.source.kind.checkpoint': '[Prufpunkte]',
      'assets.source.kind.lora': '[LoRAs DE]',
      'assets.source.kind.vae': '[VAEs DE]',
      'assets.source.label': '[Quelle]',
      'assets.source.mountDetail': '[Mount {id}]',
      'assets.source.section.models': '[Modelle]',
      'assets.source.section.other': '[Andere]',
      'assets.state.empty.detail': '[Keine Assets in {source}.]',
      'assets.state.empty.title': '[Noch keine Assets]',
    })
    const listMountEntries = vi.fn(async (mountId: string) => {
      if (mountId === 'RAW-broken-source') throw new Error('RAW backend failure')
      return { entries: [] }
    })
    const connection = stubConnection({
      listMounts: vi.fn().mockResolvedValue([
        { id: 'RAW-checkpoints', mode: 'read', state: 'ready', kind: 'model/checkpoint', entryCount: 1 },
        { id: 'RAW-custom-source', mode: 'read', state: 'ready', entryCount: 1 },
        { id: 'RAW-broken-source', mode: 'read', state: 'ready', kind: 'model/checkpoint', entryCount: 1 },
        { id: 'RAW-empty-cache', mode: 'read', state: 'ready', kind: 'model/lora', entryCount: 0 },
        { id: 'RAW-offline-cache', mode: 'read', state: 'offline', kind: 'model/vae', entryCount: 9 },
      ]),
      listMountEntries,
      assetUrl: vi.fn(),
      fetchAssetMetadata: vi.fn(),
    })
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="RAW-backend" />, root)
    await vi.waitFor(() => expect(root.querySelector('[data-collection-state="empty"]')?.textContent).toContain('No assets yet'))
    const sourceSelect = root.querySelector<HTMLButtonElement>('[data-testid="asset-source-select"]')!
    const health = root.querySelector<HTMLDetailsElement>('[data-testid="asset-source-health"]')!
    sourceSelect.click()
    health.querySelector('summary')!.click()
    await vi.waitFor(() => expect(health.textContent).toContain('RAW backend failure'))
    expect(health.textContent).toContain('3 issues')
    expect(document.querySelector('[data-option-id="mount:RAW-checkpoints"]')?.textContent).toBe('Models / Checkpoints')
    expect(document.querySelector('[data-option-id="mount:RAW-custom-source"]')?.textContent).toBe('Other / RAW Custom Source')
    const callsBeforeLocale = listMountEntries.mock.calls.length

    setLocale('de-DE')

    expect(root.querySelector('.asset-source-label')?.textContent).toBe('[Quelle]')
    expect(sourceSelect.getAttribute('aria-label')).toBe('[Assetquelle]')
    expect(sourceSelect.textContent).toContain('[Alle Assets]')
    expect(root.querySelector<HTMLInputElement>('[data-testid="collection-search"]')?.placeholder).toBe('[Assets durchsuchen]')
    expect(document.querySelector('[data-option-id="mount:RAW-checkpoints"]')?.textContent).toBe('[Modelle] / [Prufpunkte]')
    expect(document.querySelector('[data-option-id="mount:RAW-custom-source"]')?.textContent).toBe('[Andere] / RAW Custom Source')
    expect(health.open).toBe(true)
    expect(health.textContent).toContain('[Quellenzustand]')
    expect(health.textContent).toContain('[3 Probleme]')
    expect(health.querySelector('[data-source="mount:RAW-empty-cache"]')?.textContent).toContain('[LoRAs DE]empty[Mount RAW-empty-cache]')
    expect(health.querySelector('[data-source="mount:RAW-offline-cache"]')?.textContent).toContain('[VAEs DE]offline[Mount RAW-offline-cache]')
    expect(health.querySelector('[data-source="mount:RAW-broken-source"]')?.textContent).toContain('RAW backend failure')
    expect(root.querySelector('[data-collection-state="empty"]')?.textContent).toContain('[Noch keine Assets]')
    expect(root.querySelector('[data-collection-state="empty"]')?.textContent).toContain('[Keine Assets in [Alle Assets].]')
    expect(listMountEntries).toHaveBeenCalledTimes(callsBeforeLocale)
    dispose()
  })

  it('browses local assets while mount discovery is pending', async () => {
    const connection = stubConnection({ listMounts: vi.fn(() => new Promise(() => undefined)) })
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)
    await vi.waitFor(() => expect(root.textContent).toContain('No assets yet'))
    expect(root.querySelector('[data-testid="collection-panel"]')).not.toBeNull()
    dispose()
  })

  it('keeps available sources in one picker and empty or unavailable mounts in dedicated health', async () => {
    const connection = stubConnection({
      listMounts: vi.fn().mockResolvedValue([
        { id: 'comfy-model-checkpoints-1', mode: 'read', state: 'ready', kind: 'model/checkpoint', entryCount: 1 },
        { id: 'comfy-model-checkpoints-2', mode: 'read', state: 'ready', kind: 'model/checkpoint', entryCount: 1 },
        { id: 'writable-models', mode: 'readwrite', state: 'ready', kind: 'model/checkpoint', entryCount: 1 },
        { id: 'scratch', mode: 'readwrite', state: 'ready', entryCount: 1 },
        { id: 'comfy-input', mode: 'read', state: 'ready', kind: 'media/image', entryCount: 1 },
        { id: 'empty-cache', mode: 'read', state: 'ready', kind: 'model/lora', entryCount: 0 },
        { id: 'unknown-cache', mode: 'read', state: 'ready', kind: 'model/vae' },
        { id: 'offline-cache', mode: 'read', state: 'offline', kind: 'model/vae', entryCount: 9 },
      ]),
      listMountEntries: vi.fn().mockResolvedValue({ entries: [] }),
      assetUrl: vi.fn(),
      fetchAssetMetadata: vi.fn(),
    })
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)
    await vi.waitFor(() => expect(root.querySelector('[data-testid="asset-source-control"]')).not.toBeNull())
    await vi.waitFor(() => expect(root.querySelector('[data-source="mount:offline-cache"]')).not.toBeNull())
    root.querySelector<HTMLButtonElement>('[data-testid="asset-source-select"]')!.click()
    expect(document.querySelector('[data-option-id="mount:comfy-model-checkpoints-1"]')?.textContent).toBe('Models / Checkpoints')
    expect(document.querySelector('[data-option-id="mount:comfy-model-checkpoints-2"]')?.textContent).toBe('Models / Checkpoints 2')
    expect(document.querySelector('[data-option-id="mount:writable-models"]')?.textContent).toBe('Models / Checkpoints 3')
    expect(document.querySelector('[data-option-id="mount:scratch"]')?.textContent).toBe('Other / Scratch')
    expect(document.querySelector('[data-option-id="mount:comfy-input"]')?.textContent).toBe('Input/Output / Input')
    expect(document.querySelector('[data-option-id="mount:unknown-cache"]')?.textContent).toBe('Models / VAEs')
    expect(document.querySelector('[data-option-id="mount:empty-cache"]')).toBeNull()
    expect(document.querySelector('[data-option-id="mount:offline-cache"]')).toBeNull()
    root.querySelector<HTMLElement>('[data-testid="asset-source-health"] summary')!.click()
    expect(root.querySelector('[data-testid="asset-source-health"]')?.textContent).toContain('2 issues')
    expect(root.querySelector('[data-source="mount:empty-cache"]')?.getAttribute('data-state')).toBe('empty')
    expect(root.querySelector('[data-source="mount:offline-cache"]')?.getAttribute('data-state')).toBe('offline')
    expect(root.querySelector('.assets-panel > .collection-panel')).not.toBeNull()
    expect(root.querySelector('.collection-toolbar > .asset-source-control')).not.toBeNull()
    dispose()
  })

  it('shows scan counters and polls until the mount becomes ready', async () => {
    vi.useFakeTimers()
    const listMounts = vi.fn()
      .mockResolvedValueOnce([{
        id: 'models',
        mode: 'read',
        state: 'scanning',
        entryCount: 4,
        scanProgress: {
          filesDone: 4,
          filesTotal: 10,
          bytesDone: 1024,
          bytesTotal: 4096,
          elapsedSeconds: 2.5,
        },
      }])
      .mockRejectedValueOnce(new Error('temporary mount listing failure'))
      .mockResolvedValue([{ id: 'models', mode: 'read', state: 'ready', entryCount: 10 }])
    const connection = stubConnection({
      listMounts,
      listMountEntries: vi.fn().mockResolvedValue({
        entries: [{
          virtualPath: 'checkpoints/indexed.ckpt',
          name: 'indexed.ckpt',
          digest: `blake3:${'a'.repeat(64)}`,
          size: 1024,
          mediaType: 'application/octet-stream',
          kind: 'model/checkpoint',
        }],
      }),
      assetUrl: vi.fn(),
      fetchAssetMetadata: vi.fn(),
    })
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)

    await vi.waitFor(() => expect(root.querySelector('[data-testid="asset-source-health"]')).not.toBeNull())
    await vi.waitFor(() => expect(root.querySelector('[data-testid="collection-entry"]')?.textContent).toContain('indexed.ckpt'))
    root.querySelector<HTMLElement>('[data-testid="asset-source-health"] summary')!.click()
    expect(root.querySelector('[data-source="mount:models"]')?.getAttribute('data-state')).toBe('scanning')
    expect(root.querySelector('[data-source="mount:models"]')?.textContent).toContain(
      'Indexed 4/10 files, 1.0 KiB/4.0 KiB, 2s elapsed',
    )

    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(listMounts).toHaveBeenCalledTimes(2))
    expect(root.textContent).toContain('temporary mount listing failure')
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(listMounts).toHaveBeenCalledTimes(3))
    expect(root.querySelector('[data-source="mount:models"]')).toBeNull()
    dispose()
  })

  it('defaults to All assets, shows offline reasons and digest facts, and persists view', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:asset-image')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    registerCatalog('de-DE', { 'assets.preview.alt': '[Vorschau von {name}]' })
    const digest = `blake3:${'1234567890abcdef'.repeat(4)}`
    const connection = stubConnection({
      listMounts: vi.fn().mockResolvedValue([
        { id: 'input', mode: 'read', state: 'ready' },
        { id: 'offline', mode: 'read', state: 'offline' },
      ]),
      listMountEntries: vi.fn().mockResolvedValue({
        entries: [{ virtualPath: 'images/a.png', name: 'a.png', digest, size: 12, mediaType: 'image/png', kind: 'media/image' }],
      }),
      assetUrl: (digest: string) => `/api/assets/${digest}`,
      fetchAssetMetadata: vi.fn(),
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 7, 3]), { headers: { 'content-type': 'image/png' } })))
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)

    await vi.waitFor(() => expect(root.textContent).toContain('a.png'))
    expect(root.querySelector('[data-testid="asset-source-select"]')?.getAttribute('data-selected-id')).toBe('all-assets')
    expect(root.textContent).not.toContain('offline unavailable')
    root.querySelector<HTMLElement>('[data-testid="asset-source-health"] summary')!.click()
    expect(root.querySelector('[data-testid="asset-source-health"]')?.textContent).toContain('1 issue')
    expect(root.querySelector('[data-source="mount:offline"]')?.textContent).toContain('offline')
    const row = root.querySelector<HTMLElement>('[data-testid="collection-entry"]')!
    await vi.waitFor(() => expect(row.querySelector('.collection-thumb')).not.toBeNull())
    const preview = row.querySelector<HTMLImageElement>('.collection-thumb')!
    preview.dispatchEvent(new Event('error'))
    expect(row.querySelector('[data-testid="asset-entry-fallback"]')?.getAttribute('data-kind')).toBe('image')
    expect(root.querySelector('[data-testid="asset-selection-empty"]')?.textContent).toContain('Click an asset')
    row.click()
    const selection = root.querySelector<HTMLElement>('[data-testid="asset-selection-summary"]')!
    expect(selection.querySelector('h3')?.textContent).toBe('a.png')
    await vi.waitFor(() => expect(selection.querySelector('img')).not.toBeNull())
    const selectedPreview = selection.querySelector<HTMLImageElement>('img')!
    expect(selectedPreview.alt).toBe('Preview of a.png')
    Object.defineProperties(selectedPreview, { naturalWidth: { value: 640 }, naturalHeight: { value: 480 } })
    selectedPreview.dispatchEvent(new Event('load'))
    expect(selection.querySelector('[data-testid="asset-preview-caption"]')?.textContent).toBe('640 x 480')
    selection.querySelector<HTMLElement>('[data-testid="asset-rail-details"] summary')!.click()
    expect(selection.textContent).toContain('Resolution640 x 480')
    expect(selection.textContent).toContain('Media type')
    expect(selection.querySelector('.asset-digest code')?.textContent).toBe('blake3:12345...90abcdef')
    expect(selection.querySelector('.asset-digest code')?.getAttribute('title')).toBe(digest)
    expect(selection.querySelector<HTMLButtonElement>('[aria-label="Copy digest"]')).not.toBeNull()
    setLocale('de-DE')
    expect(selectedPreview.alt).toBe('[Vorschau von a.png]')
    root.querySelector<HTMLButtonElement>('[data-testid="collection-mode"]')!.click()
    expect(localStorage.getItem('dinkster.assetBrowser.view.v1')).toBe('grid')
    expect(connection.listMounts).toHaveBeenCalledOnce()
    dispose()
  })

  it('re-discovers sources on a backend switch and ignores a stale discovery response', async () => {
    let releaseFirst!: (mounts: readonly { id: string; mode: 'read'; state: string }[]) => void
    const connection = (id: string, delayed = false) => stubConnection({
      listMounts: vi.fn(() => delayed
        ? new Promise<readonly { id: string; mode: 'read'; state: string }[]>((resolve) => { releaseFirst = resolve })
        : Promise.resolve([{ id, mode: 'read' as const, state: 'ready' }])),
      listMountEntries: vi.fn().mockResolvedValue({ entries: [] }),
      assetUrl: (digest: string) => `/${id}/${digest}`,
      fetchAssetMetadata: vi.fn(),
    })
    const first = connection('first', true)
    const second = connection('second')
    const [current, setCurrent] = createSignal(first)
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AssetsBody connection={current()} backendId="native" />, root)
    setCurrent(second)
    await vi.waitFor(() => expect(root.querySelector('[data-testid="asset-source-select"]')).not.toBeNull())
    root.querySelector<HTMLButtonElement>('[data-testid="asset-source-select"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-option-id="mount:second"]')).not.toBeNull())
    releaseFirst([{ id: 'first', mode: 'read', state: 'ready' }])
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(document.querySelector('[data-option-id="mount:first"]')).toBeNull()
    dispose()
  })

  it('renders a ready mount listing failure as a source-specific reason', async () => {
    const connection = stubConnection({
      listMounts: vi.fn().mockResolvedValue([{ id: 'broken', mode: 'read', state: 'ready' }]),
      listMountEntries: vi.fn().mockRejectedValue(new Error('index unavailable')),
      listLocalAssets: vi.fn().mockRejectedValue(new Error('local catalog unavailable')),
      assetUrl: (digest: string) => `/assets/${digest}`,
      fetchAssetMetadata: vi.fn(),
    })
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)
    await vi.waitFor(() => expect(root.querySelector('[data-collection-state="error"]')?.textContent).toContain('Assets unavailable'))
    expect(root.querySelector('[data-collection-state="error"]')?.textContent).toContain('index unavailable')
    root.querySelector<HTMLElement>('[data-testid="asset-source-health"] summary')!.click()
    expect(root.querySelector('[data-testid="asset-source-health"]')?.textContent).toContain('Broken')
    expect(root.querySelector('[data-testid="asset-source-health"]')?.textContent).toContain('index unavailable')
    dispose()
  })

  it('keeps local assets and retry available when mount discovery fails', async () => {
    const digest = `blake3:${'c'.repeat(64)}`
    const asset = { digest, name: 'local.png', size: 5, mediaType: 'image/png', virtualPath: 'imports/local.png' }
    const connection = stubConnection({
      listMounts: vi.fn().mockRejectedValue(new Error('mount catalog offline')),
      listLocalAssets: vi.fn().mockResolvedValue({ assets: [{ asset, aliases: ['local.png'], observations: [] }] }),
      checkAssetAvailability: vi.fn().mockResolvedValue([{ digest, status: 'available' }]),
      assetUrl: (digest: string) => `/assets/${digest}`,
    })
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)
    await vi.waitFor(() => expect(root.querySelector('[data-testid="collection-entry"]')?.textContent).toContain('local.png'))
    expect(root.querySelector('[data-testid="asset-source-health"]')?.textContent).toContain('mount catalog offline')
    root.querySelector<HTMLButtonElement>('[data-testid="assets-retry"]')!.click()
    await vi.waitFor(() => expect(connection.listMounts).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(root.querySelector('[data-testid="collection-entry"]')?.textContent).toContain('local.png'))
    expect(root.textContent).not.toContain('Loading asset sources')
    dispose()
  })
})
