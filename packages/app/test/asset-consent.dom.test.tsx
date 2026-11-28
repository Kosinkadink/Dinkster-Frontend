import { render } from 'solid-js/web'
import { beforeEach, expect, it, vi } from 'vitest'
import { asConnectionId, createSignal } from '@dinkster/core'
import { DinksterConnection, RequestFailure, parseAssetsMissingRejection, type ModelDownloadJob, type ModelDownloadSpace, type WebSocketLike } from '@dinkster/client'
import type { AppState } from '../src/app-state.js'
import { AssetConsentDialog } from '../src/AssetConsentDialog.js'
import { installAssetConsent, type AssetConsentRequest } from '../src/dialog-requests.js'
import { ModelDownloadsController } from '../src/model-downloads.js'

beforeEach(() => {
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.setAttribute('open', '') })
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) { this.removeAttribute('open') })
})

it('renders plan answers, selected filesystem capacity, and independent downloads through the public client', async () => {
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const slot = createSignal<AssetConsentRequest | undefined>(undefined)
  const answers = [
    { status: 'local' }, { status: 'consent-required' }, { status: 'consent-required' },
    { status: 'picker-required', sources: [] },
    { status: 'picker-required', sources: ['https://huggingface.co/example/model/resolve/main/one.safetensors'] },
    { status: 'destination-required' },
    { status: 'folder-disabled', disabledLocations: ['opaque-folder'], detail: 'Folder not enabled for this project' },
    { status: 'duplicate' }, { status: 'model-hidden', hiddenIdentities: ['opaque-model'] },
    { status: 'credential-required', provider: 'huggingface' },
    { status: 'provider-grant-required', provider: 'huggingface', source: 'https://huggingface.co/example/model' },
    { status: 'civitai-access-required', provider: 'civitai', source: 'https://civitai.com/models/123' },
  ]
  const requirements = answers.map((_, index) => ({ name: `model-${index}.safetensors`, kind: 'model/vae' }))
  let space: ModelDownloadSpace = { status: 'available', filesystem: 'shared-volume', freeBytes: 1000 }
  const jobs = new Map<string, ModelDownloadJob>()
  jobs.set('0', { ...requirements[0]!, jobId: '0', status: 'completed', received: 2048, size: 2048,
    project: 'studio', provider: 'huggingface', source: 'https://huggingface.co/example/model', repo: 'example/model',
    revision: 'a'.repeat(40), file: requirements[0]!.name, sha256: 'b'.repeat(64), license: 'Apache-2.0',
    destination: '/models/ready/' + requirements[0]!.name, path: '/models/ready/' + requirements[0]!.name,
    mount: 'ready', reused: true, renamed: false,
    asset: { digest: `blake3:${'c'.repeat(64)}`, name: requirements[0]!.name, size: 2048,
      mediaType: 'application/octet-stream', virtualPath: 'models/' + requirements[0]!.name } })
  const location = { id: 'opaque-folder', path: '/models/disabled', mode: 'read', visibility: 'opt-in' }
  const shared = { id: 'shared', path: '/models', mode: 'readwrite', visibility: 'opt-in' }
  const portable = { id: 'portable', path: '/portable', mode: 'readwrite', visibility: 'opt-in' }
  const connection = new DinksterConnection({ id: asConnectionId('downloads'), baseUrl: '/engine', clientId: 'test', project: 'studio',
    webSocketFactory: () => ({}) as WebSocketLike,
    fetchFn: async (url, init) => {
      const path = new URL(url, 'http://localhost').pathname
      if (path.endsWith('/settings')) return Response.json({
        settings: { version: 1, downloadLocation: 'shared', locations: [location, shared, portable] },
        locations: [{ ...location, mounts: [], enabled: false, active: false },
          { ...shared, mounts: ['root-1', 'root-2'], enabled: true, active: true, space: { status: 'available', filesystem: 'shared-volume', freeBytes: 1000 } },
          { ...portable, mounts: ['portable-vae'], enabled: true, active: true, space: { status: 'available', filesystem: 'portable', freeBytes: 100 } }], revision: 'one', project: 'studio',
        changesAllowed: true, restartRequired: false, pendingRemovals: [],
      })
      if (path.endsWith('/plan')) {
        const requirement = JSON.parse(String(init?.body)) as { name: string; kind: string; location?: string }
        const index = requirements.findIndex((row) => row.name === requirement.name)
        const moved = requirement.location === 'portable'
        return Response.json({ ...requirement, ...answers[index], planId: String(index), project: 'studio',
          provider: 'huggingface', source: 'https://huggingface.co/example/model/resolve/main/' + requirement.name,
          repo: 'example/model', revision: 'a'.repeat(40), file: requirement.name, sha256: 'b'.repeat(64),
          size: index === 1 ? 600 : 500, license: 'Apache-2.0', destination: (moved ? '/portable/vae/' : `/models/root-${index}/`) + requirement.name,
          mount: moved ? 'portable-vae' : `root-${index}`, destinationSpace: moved ? { status: 'available', filesystem: 'portable', freeBytes: 100 } : space,
        })
      }
      if (path.endsWith('/start')) {
        const { planId, consent } = JSON.parse(String(init?.body)) as { planId: string; consent: boolean }
        expect(consent).toBe(true)
        const requirement = requirements[Number(planId)]!
        const job: ModelDownloadJob = { ...requirement, jobId: planId, status: 'downloading', received: 100,
          project: 'studio', provider: 'huggingface', source: 'https://huggingface.co/example/model', repo: 'example/model',
          revision: 'a'.repeat(40), file: requirement.name, sha256: 'b'.repeat(64), size: 600,
          license: 'Apache-2.0', destination: `/models/root-${planId}/` + requirement.name, mount: `root-${planId}` }
        jobs.set(planId, job)
        return Response.json(job, { status: 202 })
      }
      if (path.endsWith('/downloads')) return Response.json({ instance: 'one', jobs: [...jobs.values()] })
      const id = path.split('/').at(-1)!
      if (init?.method === 'DELETE') jobs.set(id, { ...jobs.get(id)!, status: 'cancelled' })
      return Response.json(jobs.get(id))
    },
  })
  const controller = new ModelDownloadsController(connection, 'studio')
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <AssetConsentDialog app={{ assetConsent: slot } as AppState} />, root)
  const open = () => installAssetConsent({ models: requirements, slot, modelDownloads: { connection, project: 'studio', controller } })
  const button = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)!
  const rows = () => [...root.querySelectorAll<HTMLElement>('.dinkster-model-download-row')]
  try {
    open()
    await vi.waitFor(() => expect(root.textContent).toContain('Already in /models/disabled'))
    await vi.waitFor(() => expect(button('Download 2 models')).toBeDefined())
    expect(rows().map((row) => row.dataset['state'])).toEqual(['ready', 'available', 'available', ...Array(9).fill('needs')])
    expect(root.textContent).toContain('needs 11 models that are not ready on this computer.')
    expect(rows()[0]!.textContent).toContain('2 KB - Hugging Face')
    expect(rows()[0]!.textContent).toContain('an identical file was already here')
    rows()[1]!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click()
    expect(rows()[1]!.textContent).toContain('/models/root-1/model-1.safetensors')
    expect(rows()[1]!.textContent).not.toContain('a'.repeat(40))
    expect(rows()[1]!.textContent).not.toContain('b'.repeat(64))
    button('Copy revision and checksum').click()
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith(`Revision: ${'a'.repeat(40)}\nSHA-256: ${'b'.repeat(64)}`))
    const chooseLocation = (id: string) => {
      root.querySelector<HTMLButtonElement>('button[aria-label="Save to"]')!.click()
      expect(root.querySelector('[role="menu"]')?.textContent).toContain('shared1000 B free')
      expect(root.querySelector('[role="menu"]')?.textContent).toContain('portable100 B free')
      ;[...root.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')].find((item) => item.textContent?.startsWith(id))!.click()
    }
    chooseLocation('portable')
    await vi.waitFor(() => expect(rows()[1]!.textContent).toContain('/portable/vae/model-1.safetensors'))
    expect(root.querySelector('.dinkster-model-download-destination')?.textContent).toContain('100 B free')
    expect(button('Download 2 models').disabled).toBe(true)
    expect(rows()[0]!.textContent).toContain('/models/ready')
    chooseLocation('shared')
    await vi.waitFor(() => expect(rows()[1]!.textContent).toContain('/models/root-1/model-1.safetensors'))
    for (const reason of ['No known source', 'More than one source', 'No folder to save it in', 'Two files have this name',
      'Hidden on this computer', 'Not signed in to Hugging Face', 'No access to this file on Hugging Face', 'No access to this file on Civitai'])
      expect(root.textContent).toContain(reason)
    expect(button('Download 2 models').disabled).toBe(true)
    expect(root.textContent).toContain('1000 B free')
    expect(root.textContent).toContain('Save somewhere else or untick some models.')
    button('Select none').click()
    expect(button('Download 0 models').disabled).toBe(true)
    expect(rows().filter((row) => row.querySelector<HTMLInputElement>('input')?.checked)).toHaveLength(0)
    button('Select all').click()
    expect(rows().filter((row) => row.querySelector<HTMLInputElement>('input')?.checked)).toHaveLength(2)
    const second = rows()[2]!.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    second.click()
    expect(button('Download 1 model').disabled).toBe(false)
    expect(root.textContent).not.toContain('Save somewhere else or untick some models.')
    expect(button('Select all')).toBeDefined()
    expect(root.querySelector('.dinkster-model-download-footer [role="status"]')?.textContent).toBe('600 B to download')
    second.click()
    space = { status: 'unavailable' }
    await slot.get()!.reviewModel!(1)
    await slot.get()!.reviewModel!(2)
    expect(button('Download 2 models').disabled).toBe(false)
    expect(root.textContent).not.toContain(' free.')
    button('Download 2 models').click()
    await vi.waitFor(() => expect(rows().filter((row) => row.dataset['state'] === 'downloading')).toHaveLength(2))
    expect(rows()[1]!.textContent).toContain('Downloading - 100 of 600 B')
    expect(root.querySelector('.dinkster-model-download-destination')?.textContent).toContain('Save to')
    expect(root.querySelector('.dinkster-model-download-destination button')).toBeNull()
    button('Close').click()
    expect(slot.get()).toBeUndefined()
    open()
    await vi.waitFor(() => expect(rows().filter((row) => row.dataset['state'] === 'downloading')).toHaveLength(2))
    rows()[1]!.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(rows()[1]!.dataset['state']).toBe('failed'))
    expect(rows()[2]!.dataset['state']).toBe('downloading')
    rows()[2]!.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(rows()[2]!.dataset['state']).toBe('failed'))
    expect(root.querySelector<HTMLButtonElement>('button[aria-label="Save to"]')).not.toBeNull()
    expect(button('Download 2 models')).toBeUndefined()
    expect(root.textContent).not.toContain('to download')
    expect(button('Run')).toBeUndefined()
    answers[0] = { status: 'consent-required' }
    controller.invalidate(requirements[0]!)
    await vi.waitFor(() => expect(rows()[0]!.dataset['state']).toBe('available'))
    expect(rows()[0]!.textContent).not.toContain('an identical file was already here')
  } finally {
    slot.set(undefined)
    controller.dispose()
    unmount()
    root.remove()
    vi.restoreAllMocks()
  }
})

it('offers Run only after selectable models are ready, then keeps pack and media consent separate', async () => {
  const assetConsent = createSignal<AssetConsentRequest | undefined>(undefined)
  const requirement = { name: 'missing.safetensors', kind: 'model/vae' }
  let failPlan = false
  const connection = {
    planModelDownload: async () => {
      if (failPlan) throw new RequestFailure('POST', '/api/models/downloads/plan', 503, 'Source unavailable')
      return { ...requirement, status: 'local' as const }
    },
    startModelDownload: vi.fn(), fetchModelDownloads: async () => ({ instance: 'one', jobs: [] }),
    fetchModelDownload: vi.fn(), cancelModelDownload: vi.fn(),
  }
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <AssetConsentDialog app={{ assetConsent } as AppState} />, root)
  try {
    installAssetConsent({ models: [requirement], slot: assetConsent, modelDownloads: { connection, project: 'default' } })
    await vi.waitFor(() => expect(root.textContent).toContain('has every model it needs.'))
    expect(root.textContent).toContain('Download models')
    expect(root.textContent).toContain('Choose a folder')
    expect(root.textContent).not.toContain('Free space unavailable')
    expect(root.textContent).not.toContain('Run once')
    expect(root.querySelector('.dinkster-model-download-footer [role="status"]')?.textContent).toBe('')
    expect(root.querySelector('[data-testid="asset-consent-acquire"]')).toBeNull()
    expect([...root.querySelectorAll('button')].some((button) => button.textContent === 'Run')).toBe(false)
    ;[...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Close')!.click()
    expect(assetConsent.get()).toBeUndefined()

    failPlan = true
    installAssetConsent({ models: [requirement], slot: assetConsent, modelDownloads: { connection, project: 'default' } })
    await vi.waitFor(() => expect(root.textContent).toContain('Source unavailable'))
    expect(root.textContent).toContain('needs 1 model that is not ready on this computer.')
    expect(root.querySelector('.dinkster-model-download-footer [role="status"]')?.textContent).toBe('')
    ;[...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Close')!.click()
    failPlan = false

    const asset = { digest: `blake3:${'a'.repeat(64)}`, name: requirement.name, size: 8192,
      mediaType: 'application/octet-stream', virtualPath: `models/${requirement.name}` }
    const media = { digest: `blake3:${'b'.repeat(64)}`, name: 'source.png', status: 'missing' as const,
      sources: ['https://example.com/source.png'], fetchable: true }
    const provider = { digest: `blake3:${'c'.repeat(64)}`, name: 'provider-model.bin', kind: 'model/auxiliary',
      status: 'missing' as const, sources: ['https://example.com/provider-model.bin'], fetchable: true }
    const retryWithAssets = vi.fn(async () => ({ ok: false as const, diagnostics: [] }))
    installAssetConsent({ slot: assetConsent, modelReferences: [{ ...requirement, asset }],
      modelDownloads: { connection, project: 'default' },
      result: { ok: false, diagnostics: [], assetsMissing: parseAssetsMissingRejection({ error: 'assets-missing', assets: [
        { digest: asset.digest, name: asset.name, status: 'missing', sources: [], fetchable: true },
        media,
        provider,
      ] })!, retryWithAssets },
      onSubmitted: vi.fn(), onRejected: vi.fn(), onTransportError: vi.fn(), onSuperseded: vi.fn(),
    })
    await vi.waitFor(() => expect(root.querySelector('.dinkster-model-download-row')?.getAttribute('data-state')).toBe('ready'))
    expect(root.querySelectorAll('.dinkster-model-download-row')).toHaveLength(1)
    expect(root.querySelector('[data-testid="asset-consent-row"]')).toBeNull()
    expect(retryWithAssets).not.toHaveBeenCalled()
    ;[...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Run')!.click()
    await Promise.resolve()
    expect(root.querySelector('.dinkster-model-download-row')).toBeNull()
    expect(root.querySelectorAll('[data-testid="asset-consent-row"]')).toHaveLength(2)
    expect(root.textContent).toContain(media.name)
    expect(root.textContent).toContain(provider.name)
    expect(root.textContent).not.toContain(requirement.name)
    expect(retryWithAssets).not.toHaveBeenCalled()
    root.querySelector<HTMLButtonElement>('[data-testid="asset-consent-acquire"]')!.click()
    await Promise.resolve()
    expect(retryWithAssets).toHaveBeenCalledExactlyOnceWith([media.digest, provider.digest])
  } finally {
    assetConsent.set(undefined)
    unmount()
    root.remove()
    vi.restoreAllMocks()
  }
})
