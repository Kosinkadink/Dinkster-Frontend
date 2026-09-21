// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assetDtoV1Contract, type DinksterConnection } from '@dinkster/client'
import { registerCatalog, setLocale } from '@dinkster/core'
import { AssetsBody } from '../src/AssetsBody.js'
import '../src/locale.js'

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
  localStorage.clear()
  setLocale('en')
  vi.restoreAllMocks()
})

const stubConnection = <T extends object>(members: T): DinksterConnection => ({
  onEvent: vi.fn(() => () => undefined),
  ...members,
} as unknown as DinksterConnection)

describe('Assets dock body', () => {
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

  it('shows a deterministic source-discovery loading state', () => {
    const connection = stubConnection({ listMounts: vi.fn(() => new Promise(() => undefined)) })
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)
    expect(root.textContent).toContain('Loading asset sources')
    expect(root.textContent).toContain('Discovering backend-owned asset mounts.')
    dispose()
  })

  it('uses only an injected federated contract for All assets and renders its human title', async () => {
    registerCatalog('de-DE', {
      'assets.details.title': '[Details DE]',
      'assets.fact.source': '[Quelle DE]',
      'assets.source.all': '[Alle Assets]',
    })
    const digest = `blake3:${'a'.repeat(64)}`
    const encodeRequest = vi.fn(() => ({ injected: true }))
    const base = assetDtoV1Contract({ catalog: '/api/catalog', candidates: '/api/catalog/candidates' })
    const contract = { ...base, catalog: { ...base.catalog, encodeRequest } }
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ contractVersion: 1, items: [{
      logicalId: 'federated-alpha', family: 'flux', assetKind: 'model', variantId: 'fp16', dtype: 'fp16', quantization: 'none', format: 'safetensors', role: 'base',
      requirements: { loaders: [], runtimes: [], hardware: [] }, digest,
      availability: { status: 'local', reason: '' }, compatibility: { status: 'compatible', reason: '' },
      providerSources: [{ source: { providerId: 'fixture-provider', sourceId: 'fixture-source' }, status: 'available', reason: '', requires: { credential: 'fixture-token' } }],
      assetRef: { digest, name: 'Federated Alpha.safetensors', size: 12, mediaType: 'application/octet-stream', virtualPath: 'models/federated-alpha.safetensors' },
    }] })))
    vi.stubGlobal('fetch', fetchFn)
    const connection = stubConnection({
      listMounts: vi.fn().mockResolvedValue([{ id: 'local', mode: 'read', state: 'ready', entryCount: 1 }]),
      listMountEntries: vi.fn().mockResolvedValue({ entries: [{ virtualPath: 'local.safetensors', name: 'local.safetensors', digest: `blake3:${'b'.repeat(64)}`, size: 10, mediaType: 'application/octet-stream' }] }),
      assetUrl: vi.fn(),
      fetchAssetMetadata: vi.fn(),
    })
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" baseUrl="https://backend.example" federatedContract={contract} />, root)
    await vi.waitFor(() => expect(root.textContent).toContain('Federated Alpha.safetensors'))
    expect(root.textContent).not.toContain('local.safetensors')
    expect(root.querySelector('[data-testid="asset-source-select"]')?.getAttribute('data-selected-id')).toBe('all-assets')
    expect(root.querySelector('[data-testid="collection-search"]')?.getAttribute('placeholder')).toBe('Search assets')
    expect(root.querySelector('[data-testid="asset-entry-fallback"]')?.getAttribute('data-kind')).toBe('model')
    const entry = root.querySelector<HTMLElement>('[data-testid="collection-entry"]')!
    expect(entry.querySelector('.collection-subtitle')).toBeNull()
    expect([...entry.querySelectorAll('.collection-badge')].map((badge) => badge.textContent)).toEqual(['12 B'])
    entry.click()
    const selection = root.querySelector<HTMLElement>('[data-testid="asset-selection-summary"]')!
    expect(selection.querySelector('h3')?.textContent).toBe('Federated Alpha.safetensors')
    selection.querySelector<HTMLElement>('[data-testid="asset-rail-details"] summary')!.click()
    expect(selection.textContent).toContain('Size12 B')
    expect([...selection.querySelectorAll('dt')].filter((term) => term.textContent === 'Kind')).toHaveLength(1)
    expect(selection.textContent).toContain('Kindmodel')
    expect(selection.textContent).toContain('Virtual pathmodels/federated-alpha.safetensors')
    expect(selection.querySelector('.asset-digest code')?.textContent).toBe('blake3:aaaaa...aaaaaaaa')
    expect(selection.textContent).toContain('Providerfixture-provider')
    expect(selection.textContent).toContain('Provider sourcefixture-source')
    expect(selection.textContent).toContain('Provider statusavailable')
    expect(selection.textContent).toContain('Requires credentialfixture-token')
    expect(selection.textContent).toContain('Availabilitylocal:')
    expect(selection.textContent).toContain('Compatibilitycompatible:')
    setLocale('de-DE')
    expect(selection.querySelector<HTMLDetailsElement>('[data-testid="asset-rail-details"]')?.open).toBe(true)
    expect(selection.textContent).toContain('[Quelle DE][Alle Assets]')
    expect(encodeRequest).toHaveBeenCalled()
    expect(fetchFn).toHaveBeenCalledWith('https://backend.example/api/catalog', expect.anything())
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
    await vi.waitFor(() => expect(root.querySelector('[data-entry="mount:models:checkpoints/indexed.ckpt"]')).not.toBeNull())
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
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)

    await vi.waitFor(() => expect(root.textContent).toContain('a.png'))
    expect(root.querySelector('[data-testid="asset-source-select"]')?.getAttribute('data-selected-id')).toBe('all-assets')
    expect(root.textContent).not.toContain('offline unavailable')
    root.querySelector<HTMLElement>('[data-testid="asset-source-health"] summary')!.click()
    expect(root.querySelector('[data-testid="asset-source-health"]')?.textContent).toContain('1 issue')
    expect(root.querySelector('[data-source="mount:offline"]')?.textContent).toContain('offline')
    const preview = root.querySelector<HTMLImageElement>('[data-entry="mount:input:images/a.png"] .collection-thumb')!
    preview.dispatchEvent(new Event('error'))
    expect(root.querySelector('[data-entry="mount:input:images/a.png"] [data-testid="asset-entry-fallback"]')?.getAttribute('data-kind')).toBe('image')
    expect(root.querySelector('[data-testid="asset-selection-empty"]')?.textContent).toContain('Click an asset')
    root.querySelector<HTMLElement>('[data-entry="mount:input:images/a.png"]')!.click()
    const selection = root.querySelector<HTMLElement>('[data-testid="asset-selection-summary"]')!
    expect(selection.querySelector('h3')?.textContent).toBe('a.png')
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

  it('updates an open selection and metadata state without changing raw asset data or requests', async () => {
    registerCatalog('de-DE', {
      'assets.details.forAsset': '[Details fur {name}]',
      'assets.details.title': '[Details DE]',
      'assets.digest.copy': '[Kopieren]',
      'assets.digest.copyLabel': '[Digest kopieren]',
      'assets.fact.digest': '[Digest DE]',
      'assets.fact.kind': '[Art]',
      'assets.fact.mediaType': '[Medientyp]',
      'assets.fact.mount': '[Mount DE]',
      'assets.fact.name': '[Name DE]',
      'assets.fact.size': '[Grosse]',
      'assets.fact.source': '[Quelle DE]',
      'assets.fact.virtualPath': '[Virtueller Pfad]',
      'assets.metadata.inspect': '[Modelldaten prufen]',
      'assets.metadata.loading': '[ladend]',
      'assets.metadata.unsupported': '[Metadaten nicht unterstutzt.]',
      'assets.preview.alt': '[Vorschau von {name}]',
      'assets.selection.title': '[Auswahl]',
    })
    const digest = `blake3:${'c'.repeat(64)}`
    let finishMetadata!: (value: unknown) => void
    const fetchAssetMetadata = vi.fn(() => new Promise((resolve) => { finishMetadata = resolve }))
    const connection = stubConnection({
      listMounts: vi.fn().mockResolvedValue([{ id: 'RAW-mount', mode: 'read', state: 'ready', kind: 'model/checkpoint', entryCount: 1 }]),
      listMountEntries: vi.fn().mockResolvedValue({ entries: [{
        virtualPath: 'RAW/path/model.safetensors', name: 'RAW Model.safetensors', digest,
        size: 2048, mediaType: 'image/RAW-preview', kind: 'model/checkpoint',
      }] }),
      assetUrl: (value: string) => `/api/assets/${value}`,
      fetchAssetMetadata,
    })
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
    vi.stubGlobal('navigator', { ...navigator, clipboard })
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="RAW-backend" />, root)
    await vi.waitFor(() => expect(root.textContent).toContain('RAW Model.safetensors'))
    root.querySelector<HTMLElement>('[data-testid="collection-entry"]')!.click()
    const selection = root.querySelector<HTMLElement>('[data-testid="asset-selection-summary"]')!
    const details = selection.querySelector<HTMLDetailsElement>('[data-testid="asset-rail-details"]')!
    details.querySelector('summary')!.click()
    const inspect = [...details.querySelectorAll('button')].find((button) => button.textContent === 'Inspect model metadata')!
    inspect.click()
    expect(details.textContent).toContain('loading')
    expect(fetchAssetMetadata).toHaveBeenCalledOnce()

    setLocale('de-DE')

    expect(details.open).toBe(true)
    expect(selection.getAttribute('aria-label')).toBe('[Auswahl]')
    expect(details.querySelector('summary')?.textContent).toBe('[Details DE]')
    expect(details.querySelector('summary')?.getAttribute('aria-label')).toBe('[Details fur RAW Model.safetensors]')
    expect(details.textContent).toContain('[Virtueller Pfad]RAW/path/model.safetensors')
    expect(details.textContent).toContain('[Medientyp]image/RAW-preview')
    expect(details.textContent).toContain('[ladend]')
    expect(details.textContent).toContain('RAW-mount')
    expect(details.textContent).toContain(digest.slice(0, 12))
    expect(fetchAssetMetadata).toHaveBeenCalledOnce()
    const copy = details.querySelector<HTMLButtonElement>('[aria-label="[Digest kopieren]"]')!
    expect(copy.textContent).toBe('[Kopieren]')
    copy.click()
    expect(clipboard.writeText).toHaveBeenCalledWith(digest)

    finishMetadata(undefined)
    await vi.waitFor(() => expect(details.textContent).toContain('[Metadaten nicht unterstutzt.]'))
    expect(fetchAssetMetadata).toHaveBeenCalledOnce()

    fetchAssetMetadata.mockRejectedValueOnce(new Error('RAW metadata backend refusal'))
    inspect.click()
    await vi.waitFor(() => expect(details.querySelector('pre')?.textContent).toBe('RAW metadata backend refusal'))
    setLocale('en')
    expect(details.querySelector('pre')?.textContent).toBe('RAW metadata backend refusal')
    expect(fetchAssetMetadata).toHaveBeenCalledTimes(2)
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

  it('shows a terminal discovery failure without a false loading state', async () => {
    const connection = stubConnection({ listMounts: vi.fn().mockRejectedValue(new Error('mount catalog offline')) })
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AssetsBody connection={connection} backendId="native" />, root)
    await vi.waitFor(() => expect(root.querySelector('[data-testid="assets-error"]')?.textContent).toContain('mount catalog offline'))
    expect(root.querySelector('[data-testid="assets-error"]')?.textContent).toContain('Asset sources unavailable')
    expect(root.textContent).not.toContain('Loading asset sources')
    dispose()
  })
})
