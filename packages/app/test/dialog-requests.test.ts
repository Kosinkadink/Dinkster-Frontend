/**
 * Singleton async dialog ownership unit tests: every write to
 * a dialog slot is owner-checked. An older operation whose slot was claimed
 * by a newer request (or dismissed by the user) completes its real side
 * effects but stops touching the slot: no clears over the newer owner, no
 * busy toggles on someone else's request, no stale accept/cancel dispatch.
 */
import { describe, expect, it, vi } from 'vitest'
import { asConnectionId, createSignal, type CommandInvocation } from '@dinkster/core'
import { DinksterConnection, type AssetGuessCandidate, type AssetGuessMatch, type DinksterSubmitResult, type MissingAsset, type ModelDownloadJob, type WebSocketLike } from '@dinkster/client'
import { ModelDownloadsController } from '../src/model-downloads.js'
import {
  assetGuessCandidateToRef,
  installAssetConsent,
  installImportAssetResolution,
  type AssetConsentRequest,
  type ImportAssetReference,
  type ImportAssetResolutionRequest,
  type RequestSlot,
} from '../src/dialog-requests.js'

const slotOf = <T>() => {
  const slot = createSignal<T | undefined>(undefined)
  return { ...slot, get value() { return slot.get() } }
}

// ---------------------------------------------------------------------------
// installAssetConsent
// ---------------------------------------------------------------------------

const missing = (digest: string): MissingAsset =>
  ({ digest, name: digest, status: 'missing', sources: [], fetchable: true })

type AssetsMissingResult = Extract<DinksterSubmitResult, { assetsMissing: unknown }>
type SubmitOk = Extract<DinksterSubmitResult, { ok: true }>

const submitOk: SubmitOk = { ok: true, execution: { prompt: 'p1', clientId: 'c1' } as unknown as SubmitOk['execution'] }

/** A controllable assets-missing rejection: each retry resolves on demand. */
const rejection = (assets: readonly MissingAsset[]): {
  result: AssetsMissingResult
  retries: Array<{ digests: readonly string[]; resolve: (r: DinksterSubmitResult) => void; reject: (e: unknown) => void }>
} => {
  const retries: Array<{ digests: readonly string[]; resolve: (r: DinksterSubmitResult) => void; reject: (e: unknown) => void }> = []
  const result: AssetsMissingResult = {
    ok: false,
    diagnostics: [],
    assetsMissing: { error: 'assets-missing', assets },
    retryWithAssets: (digests) => new Promise<DinksterSubmitResult>((resolve, reject) => { retries.push({ digests, resolve, reject }) }),
  }
  return { result, retries }
}

const consentCallbacks = () => ({
  onSubmitted: vi.fn(),
  onRejected: vi.fn(),
  onTransportError: vi.fn(),
  onSuperseded: vi.fn(),
})

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

describe('installAssetConsent ownership', () => {
  it('keeps exact hashes and name-only requests separate for same-named model downloads', async () => {
    const named = { name: 'weights.safetensors', kind: 'model/vae' }
    const asset = { digest: `blake3:${'a'.repeat(64)}`, name: named.name, size: 8192,
      mediaType: 'application/octet-stream', virtualPath: 'models/weights.safetensors' }
    const first = { ...named, asset }
    const second = { ...named, asset: { ...asset, digest: `blake3:${'b'.repeat(64)}` } }
    const selection = { ...named, project: 'studio', provider: 'huggingface',
      source: 'https://huggingface.co/example/model/resolve/main/weights.safetensors',
      repo: 'example/model', revision: 'c'.repeat(40), file: named.name,
      sha256: 'd'.repeat(64), size: asset.size, license: 'apache-2.0',
      destination: '/models/weights.safetensors', mount: 'models' }
    const jobs = [{ ...selection, digest: second.asset.digest, jobId: 'second', status: 'downloading', received: 317 }]
    const plans: unknown[] = []
    const requests: string[] = []
    const connection = new DinksterConnection({ id: asConnectionId('exact-downloads'), baseUrl: '/engine', clientId: 'test', project: 'studio',
      webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async (url, init) => {
        requests.push(String(url))
        let payload: unknown = { instance: 'engine', jobs }
        if (String(url).includes('/plan?')) {
          const body = JSON.parse(String(init?.body)) as { asset?: typeof asset }
          plans.push(body)
          payload = { ...selection, status: 'consent-required', planId: body.asset ? 'first-plan' : 'named-plan',
            ...(body.asset ? { digest: body.asset.digest } : {}) }
        }
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
      } })
    const controller = new ModelDownloadsController(connection, 'studio')
    const slot = slotOf<AssetConsentRequest>()
    const install = () => installAssetConsent({ models: [first, second, named], slot,
      modelDownloads: { connection, controller, project: 'studio' } })
    try {
      install()
      for (let index = 0; index < 3; index++) await slot.value!.reviewModel!(index)
      expect(plans).toEqual([
        { ...named, asset, project: 'studio', scope: 'local' },
        { ...named, project: 'studio', scope: 'local' },
      ])
      expect(slot.value!.models?.map((row) => row.job?.jobId ?? (row.plan?.status === 'consent-required' ? row.plan.planId : undefined)))
        .toEqual(['first-plan', 'second', 'named-plan'])
      slot.set(undefined)
      install()
      expect(slot.value!.models?.map((row) => row.requirement.asset?.digest)).toEqual([asset.digest, second.asset.digest, undefined])
      expect(slot.value!.models?.[1]?.job?.received).toBe(317)
      expect(requests.every((url) => url.startsWith('/engine/api/models/downloads'))).toBe(true)
      expect(slot.value!.retry).toBeUndefined()
    } finally {
      slot.set(undefined)
      controller.dispose()
    }
  })

  it('keeps a batch live across dismissal, queues busy folders and stops only the chosen model', async () => {
    const requirements = [
      { name: 'weights.safetensors', kind: 'model/vae' },
      { name: 'weights.safetensors', kind: 'model/checkpoint' },
      { name: 'three.safetensors', kind: 'model/vae' },
      { name: 'four.safetensors', kind: 'model/vae' },
      { name: 'five.safetensors', kind: 'model/vae' },
      { name: 'six.safetensors', kind: 'model/vae' },
    ]
    const selections = requirements.map((requirement, index) => ({
      ...requirement, project: 'studio', provider: 'huggingface' as const,
      source: `https://huggingface.co/example/model/resolve/main/${requirement.name}`,
      repo: 'example/model', revision: 'a'.repeat(40), file: requirement.name,
      sha256: 'b'.repeat(64), size: 8192, license: 'apache-2.0',
      destination: `/models/${index === 1 ? 0 : index}/${requirement.name}`, mount: `folder-${index === 1 ? 0 : index}`,
      status: 'consent-required' as const, planId: `plan-${index}`,
    }))
    const jobs = new Map<string, ModelDownloadJob>()
    const complete = (id: string): void => {
      const job = jobs.get(id)!
      jobs.set(id, { ...job, status: 'completed', received: job.size, path: job.destination, reused: false, renamed: false,
        asset: { digest: `blake3:${'c'.repeat(64)}`, name: job.name, size: job.size,
          mediaType: 'application/octet-stream', virtualPath: `models/${job.name}` } })
    }
    let lastStartBusy = true
    let discoveryFails = false
    let disabledFolder = false
    let folderEnabled = false
    let acceptStart!: () => void
    let observeStart!: () => void
    const startObserved = new Promise<void>((resolve) => { observeStart = resolve })
    const startAccepted = new Promise<void>((resolve) => { acceptStart = resolve })
    let observeBusy!: () => void
    let refuseStart!: () => void
    const busyObserved = new Promise<void>((resolve) => { observeBusy = resolve })
    const startRefused = new Promise<void>((resolve) => { refuseStart = resolve })
    const connection = new DinksterConnection({ id: asConnectionId('downloads'), baseUrl: '/engine', clientId: 'test', project: 'studio',
      webSocketFactory: () => ({}) as WebSocketLike,
      fetchFn: async (url, init) => {
        const path = new URL(url, 'http://localhost').pathname
        if (path.endsWith('/plan')) {
          const requested = JSON.parse(String(init?.body)) as { name: string; kind: string }
          if (disabledFolder && requested.name === requirements[1]!.name && requested.kind === requirements[1]!.kind)
            return new Response(JSON.stringify(folderEnabled ? { ...requested, status: 'local' } : {
              status: 'folder-disabled', disabledLocations: ['existing-models'], detail: 'Folder is disabled',
            }))
          return new Response(JSON.stringify(selections.find((selection) => selection.name === requested.name && selection.kind === requested.kind)))
        }
        if (path.endsWith('/start')) {
          const body = JSON.parse(String(init?.body)) as { planId: string; consent: boolean }
          const selection = selections.find((selection) => selection.planId === body.planId)!
          const active = [...jobs.values()].filter((job) => job.status === 'downloading')
          if (!body.consent) return new Response('{}', { status: 403 })
          if (selection.planId === 'plan-5' && lastStartBusy) {
            lastStartBusy = false
            observeBusy()
            await startRefused
            return new Response(JSON.stringify({ error: 'model-download-busy' }), { status: 409 })
          }
          if (active.length >= 4 || active.some((job) => job.mount === selection.mount))
            return new Response(JSON.stringify({ error: 'model-download-busy' }), { status: 409 })
          const job = { ...selection, jobId: selection.planId, status: 'downloading' as const, received: 1024 }
          jobs.set(job.jobId, job)
          if (selection.planId === 'plan-0') { observeStart(); await startAccepted }
          return new Response(JSON.stringify(job), { status: 202 })
        }
        if (path.endsWith('/downloads')) {
          if (discoveryFails) throw new Error('Temporary observation failure')
          return new Response(JSON.stringify({ instance: 'engine-one', jobs: [...jobs.values()] }))
        }
        const id = path.split('/').at(-1)!
        const job = jobs.get(id)!
        if (init?.method === 'DELETE') jobs.set(id, { ...job, status: 'cancelled' })
        return new Response(JSON.stringify(jobs.get(id)))
      },
    })
    const controller = new ModelDownloadsController(connection, 'studio')
    const slot = slotOf<AssetConsentRequest>()
    const open = () => installAssetConsent({ models: requirements, slot,
      enableLocation: async (location) => { if (location === 'existing-models') folderEnabled = true },
      modelDownloads: { connection, project: 'studio', controller } })
    try {
      open()
      for (let index = 0; index < requirements.length; index++) await slot.value!.reviewModel!(index)
      discoveryFails = true
      await slot.value!.downloadModels!([0, 1, 2, 3, 4, 5])
      expect(slot.value!.models!.every((row) => row.queued)).toBe(true)
      expect(jobs.size).toBe(0)
      discoveryFails = false
      const starting = controller.refresh()
      await startObserved
      controller.invalidate(requirements[0]!)
      acceptStart()
      await starting
      expect(slot.value!.models!.map((row) => row.queued ? 'waiting' : row.job?.status)).toEqual([
        'downloading', 'waiting', 'downloading', 'downloading', 'downloading', 'waiting',
      ])
      const dismissed = slot.value!
      slot.set(undefined)
      jobs.set('plan-2', { ...jobs.get('plan-2')!, received: 3072 })
      await controller.refresh()
      expect(slot.value).toBeUndefined()
      open()
      expect(slot.value!.models![2]!.job?.received).toBe(3072)
      expect(slot.value!.retry).toBeUndefined()
      await slot.value!.cancelModel!(1)
      expect(slot.value!.models![1]!.queued).toBe(false)
      expect(jobs.has('plan-1')).toBe(false)
      await slot.value!.cancelModel!(0)
      const refused = controller.refresh()
      await busyObserved
      controller.invalidate(requirements[5]!)
      refuseStart()
      await refused
      expect(slot.value!.models![5]!.queued).toBeUndefined()
      expect(slot.value!.models![5]!.plan).toBeUndefined()
      expect(slot.value!.models![5]!.error).toBeUndefined()
      await controller.refresh()
      expect(jobs.has('plan-5')).toBe(false)
      await slot.value!.reviewModel!(5)
      await slot.value!.downloadModel!(5)
      expect(slot.value!.models!.map((row) => row.job?.status)).toEqual([
        'cancelled', undefined, 'downloading', 'downloading', 'downloading', 'downloading',
      ])
      expect(slot.value!.models![2]!.job?.received).toBe(3072)
      await dismissed.cancelModel!(2)
      expect(jobs.get('plan-2')?.status).toBe('downloading')

      complete('plan-2')
      await controller.refresh()
      expect(slot.value!.models![2]!.job?.status).toBe('completed')
      await slot.value!.reviewModel!(2)
      expect(slot.value!.models![2]!.plan?.status).toBe('consent-required')
      expect(slot.value!.models![2]!.job).toBeUndefined()

      complete('plan-5')
      await controller.refresh()
      const submitted = rejection([])
      installAssetConsent({ result: { ...submitted.result, assetsMissing: { ...submitted.result.assetsMissing, models: [requirements[5]!] } },
        slot, modelDownloads: { connection, project: 'studio', controller }, ...consentCallbacks() })
      expect(slot.value!.models![0]!.job).toBeUndefined()
      await slot.value!.retry!([])
      expect(submitted.retries).toHaveLength(0)
      await slot.value!.reviewModel!(0)
      expect(slot.value!.models![0]!.plan?.status).toBe('consent-required')

      disabledFolder = true
      controller.invalidate(requirements[1]!)
      open()
      await slot.value!.reviewModel!(1)
      await slot.value!.enableModelLocation!(1, 'unrelated-folder')
      expect(slot.value!.models![1]!.plan?.status).toBe('folder-disabled')
      const staleFolderReview = slot.value!
      open()
      await staleFolderReview.enableModelLocation!(1, 'existing-models')
      expect(slot.value!.models![1]!.plan?.status).toBe('folder-disabled')
      await slot.value!.enableModelLocation!(1, 'existing-models')
      expect(slot.value!.models![1]!.plan?.status).toBe('local')
      expect(slot.value!.models![1]!.job).toBeUndefined()
      expect(submitted.retries).toHaveLength(0)
      expect(jobs.has('plan-1')).toBe(false)
    } finally { slot.set(undefined); controller.dispose() }
  })

  it('reviews and transfers one model without holding any submission retry', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const requirement = { name: 'requested.safetensors', kind: 'model/vae' }
    const selection = { ...requirement, project: 'studio', provider: 'huggingface' as const,
      source: 'https://huggingface.co/example/vae', repo: 'example/vae', revision: 'a'.repeat(40),
      file: 'weights.safetensors', sha256: 'b'.repeat(64), size: 8192, license: 'apache-2.0',
      destination: '/models/vae/requested.safetensors', mount: 'models' }
    const plan = { ...selection, status: 'consent-required' as const, planId: 'opaque-plan' }
    let job: import('@dinkster/client').ModelDownloadJob = { ...selection, jobId: 'owned', status: 'downloading', received: 2048 }
    const connection = {
      planModelDownload: vi.fn(async () => plan), startModelDownload: vi.fn(async () => job),
      fetchModelDownloads: vi.fn(async () => ({ instance: 'one', jobs: [] as typeof job[] })),
      fetchModelDownload: vi.fn(async () => job),
      cancelModelDownload: vi.fn(async () => ({ ...job, status: 'cancelled' as const })),
    }
    const input = { models: [requirement], slot, modelDownloads: { project: 'studio', connection } }
    installAssetConsent(input)
    expect(slot.value?.assets).toEqual([])
    expect(slot.value?.models?.map((entry) => entry.requirement)).toEqual([requirement])
    expect(slot.value).not.toHaveProperty('retry')
    await slot.value!.downloadModel!(0)
    expect(connection.startModelDownload).not.toHaveBeenCalled()
    await slot.value!.reviewModel!(0)
    expect(slot.value?.models?.[0]?.plan).toEqual(plan)
    expect(connection.startModelDownload).not.toHaveBeenCalled()
    await slot.value!.downloadModel!(0)
    expect(slot.value?.models?.[0]?.job?.received).toBe(2048)
    await slot.value!.cancelModel!(0)
    expect(slot.value?.models?.[0]?.job?.status).toBe('cancelled')
    await slot.value!.reviewModel!(0)
    await slot.value!.downloadModel!(0)
    job = { ...job, status: 'completed', received: 8192, path: selection.destination }
    await slot.value!.reviewModel!(0)
    expect(slot.value?.models?.[0]?.job?.status).toBe('completed')
    expect(slot.value).not.toHaveProperty('retry')
    const completed = slot.value!
    slot.set(undefined)
    await completed.downloadModel!(0)
    expect(slot.value).toBeUndefined()
    expect(connection.startModelDownload).toHaveBeenCalledTimes(2)

    installAssetConsent(input)
    let finish!: (value: typeof plan) => void
    connection.planModelDownload.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const review = slot.value!.reviewModel!(0)
    await flush()
    installAssetConsent(input)
    const newer = slot.value
    finish(plan)
    await review
    expect(slot.value).toBe(newer)
    slot.set(undefined)
  })

  it('invalidates reviewed model consent after sign-in changes without starting or submitting', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const { result, retries } = rejection([])
    const requirement = { name: 'gated.safetensors', kind: 'model/checkpoint' }
    const selected = { ...requirement, project: 'work', provider: 'huggingface' as const, source: 'https://huggingface.co/org/model', repo: 'org/model', revision: 'a'.repeat(40), file: requirement.name, sha256: 'b'.repeat(64), size: 17, license: 'test', destination: '/models/gated.safetensors', mount: 'models', status: 'consent-required' as const, planId: 'old-plan' }
    const connection = { planModelDownload: async () => selected, startModelDownload: vi.fn(), fetchModelDownloads: async () => ({ instance: 'engine', jobs: [] }), fetchModelDownload: vi.fn(), cancelModelDownload: vi.fn() }
    const provider = { fetchModelProvider: vi.fn(), saveModelProviderToken: vi.fn(), forgetModelProvider: vi.fn(), startModelProviderSignIn: vi.fn(), pollModelProviderSignIn: vi.fn(), cancelModelProviderSignIn: vi.fn() }
    installAssetConsent({ result: { ...result, assetsMissing: { ...result.assetsMissing, models: [requirement] } }, slot,
      modelDownloads: { connection, providerConnection: provider, project: 'work' }, ...consentCallbacks() })
    await slot.value!.reviewModel!(0)
    const reviewed = slot.value!
    expect(reviewed.models![0]!.plan).toEqual(selected)
    reviewed.providerChanged!()
    expect(slot.value!.models![0]!.plan).toBeUndefined()
    await reviewed.downloadModel!(0)
    await slot.value!.retry!([])
    expect(connection.startModelDownload).not.toHaveBeenCalled()
    expect(retries).toHaveLength(0)
    slot.set(undefined)
  })


  it('requires fresh consent after a source edit and ignores obsolete source and download callbacks', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const { result, retries } = rejection([])
    const requirement = { name: 'custom.safetensors', kind: 'model/vae' }
    const source = 'https://huggingface.co/studio/custom/resolve/main/custom.safetensors'
    const replacement = 'https://huggingface.co/studio/replacement/resolve/main/custom.safetensors'
    const selected = { ...requirement, project: 'work', provider: 'huggingface' as const,
      source, repo: 'studio/custom', revision: 'a'.repeat(40), file: requirement.name,
      sha256: 'b'.repeat(64), size: 137, license: 'test', destination: '/models/vae/custom.safetensors',
      mount: 'models', status: 'consent-required' as const, planId: 'reviewed-source' }
    const reviewedSources: (string | undefined)[] = []
    const connection = { planModelDownload: async (_requirement: unknown, _signal?: AbortSignal, chosen?: string) => {
      reviewedSources.push(chosen)
      return chosen ? selected : { status: 'picker-required' as const, sources: [source] }
    }, startModelDownload: vi.fn(), fetchModelDownloads: async () => ({ instance: 'engine', jobs: [] }),
    fetchModelDownload: vi.fn(), cancelModelDownload: vi.fn() }
    installAssetConsent({ result: { ...result, assetsMissing: { ...result.assetsMissing, models: [requirement] } }, slot,
      modelDownloads: { connection, project: 'work' }, ...consentCallbacks() })
    await slot.value!.reviewModel!(0)
    const picker = slot.value!
    picker.selectModelSource!(0, source)
    expect(slot.value!.models![0]!.source).toBe(source)
    await slot.value!.reviewModel!(0)
    const reviewed = slot.value!
    expect(reviewed.models![0]!.plan).toEqual(selected)
    reviewed.selectModelSource!(0, replacement)
    expect(slot.value!.models![0]!.plan).toBeUndefined()
    picker.selectModelSource!(0, source)
    expect(slot.value!.models![0]!.source).toBe(replacement)
    await reviewed.downloadModel!(0)
    await slot.value!.downloadModel!(0)
    await slot.value!.retry!([])
    expect(connection.startModelDownload).not.toHaveBeenCalled()
    expect(retries).toHaveLength(0)
    expect(reviewedSources).toEqual([undefined, source])
    slot.set(undefined)
  })

  it('requires reviewed model consent, stops on dismissal, and retries only after verified completion', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const { result, retries } = rejection([])
    const requirement = { name: 'requested.safetensors', kind: 'model/vae' }
    const selection = { ...requirement, project: 'studio', provider: 'huggingface' as const,
      source: 'https://huggingface.co/example/vae', repo: 'example/vae', revision: 'a'.repeat(40),
      file: 'weights.safetensors', sha256: 'b'.repeat(64), size: 8192, license: 'apache-2.0',
      destination: '/models/vae/requested.safetensors', mount: 'models' }
    const plan = { ...selection, status: 'consent-required' as const, planId: 'opaque-plan' }
    let job: import('@dinkster/client').ModelDownloadJob = { ...selection, jobId: 'owned', status: 'downloading', received: 2048 }
    const connection = {
      planModelDownload: vi.fn(async () => plan),
      startModelDownload: vi.fn(async () => job),
      fetchModelDownloads: vi.fn(async () => ({ instance: 'one', jobs: [] as typeof job[] })),
      fetchModelDownload: vi.fn(async (): Promise<typeof job | undefined> => job),
      cancelModelDownload: vi.fn(async () => ({ ...job, status: 'cancelled' as const })),
    }
    const input = { result: { ...result, assetsMissing: { ...result.assetsMissing, models: [requirement] } },
      slot, modelDownloads: { project: 'studio', connection }, ...consentCallbacks() }
    installAssetConsent(input)
    await slot.value!.retry!([])
    expect(retries).toHaveLength(0)
    await slot.value!.downloadModel!(0)
    expect(connection.startModelDownload).not.toHaveBeenCalled()
    const staleDownload = slot.value!.downloadModel!
    await slot.value!.reviewModel!(0)
    expect(slot.value!.models![0]!.plan).toEqual(plan)
    await staleDownload(0)
    expect(connection.startModelDownload).not.toHaveBeenCalled()
    await slot.value!.downloadModel!(0)
    expect(slot.value!.models![0]!.job?.received).toBe(2048)
    await slot.value!.retry!([])
    expect(retries).toHaveLength(0)
    await slot.value!.cancelModel!(0)
    expect(slot.value!.models![0]!.job?.status).toBe('cancelled')
    await slot.value!.reviewModel!(0)
    await slot.value!.downloadModel!(0)
    connection.fetchModelDownload.mockResolvedValueOnce(undefined)
    await slot.value!.reviewModel!(0)
    expect(slot.value!.models![0]!.interrupted).toBe(true)
    expect(connection.startModelDownload).toHaveBeenCalledTimes(2)
    await slot.value!.reviewModel!(0)
    await slot.value!.downloadModel!(0)
    job = { ...job, status: 'completed', received: 8192, path: '/models/odd/existing.safetensors', reused: true }
    await slot.value!.reviewModel!(0)
    expect(retries).toHaveLength(0)
    const run = slot.value!.retry!([])
    expect(retries).toHaveLength(1)
    retries[0]!.resolve(submitOk)
    await run
    expect(slot.value).toBeUndefined()
    installAssetConsent(input)
    let resolve!: (value: typeof plan) => void
    connection.planModelDownload.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const review = slot.value!.reviewModel!(0)
    await flush()
    slot.set(undefined)
    resolve(plan)
    await review
    expect(slot.value).toBeUndefined()
    expect(connection.startModelDownload).toHaveBeenCalledTimes(3)
    connection.fetchModelDownloads.mockResolvedValueOnce({ instance: 'one', jobs: [job] })
    installAssetConsent(input)
    await slot.value!.reviewModel!(0)
    expect(slot.value!.models![0]!.plan).toEqual(plan)
    expect(slot.value!.models![0]!.job).toBeUndefined()
    await slot.value!.retry!([])
    expect(retries).toHaveLength(1)
    slot.set(undefined)
  })

  it('enables only a returned folder and retries without consenting to downloads', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const { result, retries } = rejection([{ ...missing('blake3:a'), fetchable: false, disabledLocations: ['studio'] }])
    let finish!: () => void
    const enabled: string[] = []
    const enableLocation = async (location: string) => { enabled.push(location); await new Promise<void>((resolve) => { finish = resolve }) }
    const cb = consentCallbacks()
    installAssetConsent({ result, slot, enableLocation, ...cb })
    await slot.value!.enableLocation!('unrelated')
    expect(enabled).toEqual([])
    const action = slot.value!.enableLocation!('studio')
    expect(slot.value?.busy).toBe(true)
    expect(retries).toHaveLength(0)
    finish(); await flush()
    expect(enabled).toEqual(['studio'])
    expect(retries[0]!.digests).toEqual([])
    retries[0]!.resolve(submitOk)
    await action
    expect(slot.value).toBeUndefined()
    expect(cb.onSubmitted).toHaveBeenCalledWith(submitOk)

    installAssetConsent({ result, slot, enableLocation, ...cb })
    const canceled = slot.value!.enableLocation!('studio')
    slot.set(undefined)
    finish(); await canceled
    expect(retries).toHaveLength(1)
  })

  it('successful retry clears its own dialog and reports the run', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const { result, retries } = rejection([missing('blake3:a')])
    const cb = consentCallbacks()
    installAssetConsent({ result, slot, ...cb })
    void slot.value!.retry!(['blake3:a'])
    expect(slot.value?.busy).toBe(true)
    retries[0]!.resolve(submitOk)
    await flush()
    expect(slot.value).toBeUndefined()
    expect(cb.onSubmitted).toHaveBeenCalledWith(submitOk)
  })

  it('a busy request refuses a second retry (double-click)', () => {
    const slot = slotOf<AssetConsentRequest>()
    const { result, retries } = rejection([missing('blake3:a')])
    installAssetConsent({ result, slot, ...consentCallbacks() })
    void slot.value!.retry!(['blake3:a'])
    void slot.value!.retry!(['blake3:a'])
    expect(retries).toHaveLength(1)
  })

  it('checks the app safety gate before every captured-body retry', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const { result, retries } = rejection([missing('blake3:a')])
    const beforeRetry = vi.fn().mockReturnValue(false)
    installAssetConsent({ result, slot, beforeRetry, ...consentCallbacks() })
    await slot.value!.retry!(['blake3:a'])
    expect(beforeRetry).toHaveBeenCalledOnce()
    expect(retries).toHaveLength(0)
    expect(slot.value).toBeUndefined()
  })

  it('a stale closure retry (slot replaced between render and click) is a no-op', () => {
    const slot = slotOf<AssetConsentRequest>()
    const { result, retries } = rejection([missing('blake3:a')])
    installAssetConsent({ result, slot, ...consentCallbacks() })
    const stale = slot.value!
    const b = rejection([missing('blake3:b')])
    installAssetConsent({ result: b.result, slot, ...consentCallbacks() })
    const current = slot.value
    void stale.retry!(['blake3:a'])
    expect(retries).toHaveLength(0)
    expect(slot.value).toBe(current)
    expect(slot.value?.busy).toBe(false)
  })

  it('still-missing while owned reopens with the fresh assets', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const { result, retries } = rejection([missing('blake3:a')])
    const cb = consentCallbacks()
    installAssetConsent({ result, slot, ...cb })
    void slot.value!.retry!(['blake3:a'])
    const followup = rejection([missing('blake3:a'), missing('blake3:b')])
    retries[0]!.resolve(followup.result)
    await flush()
    expect(slot.value?.busy).toBe(false)
    expect(slot.value?.assets.map((a) => a.digest)).toEqual(['blake3:a', 'blake3:b'])
    expect(cb.onSuperseded).not.toHaveBeenCalled()
    // ...and the reopened request's retry chain still works.
    void slot.value!.retry!(['blake3:b'])
    expect(followup.retries).toHaveLength(1)
  })

  it('a superseded still-missing outcome leaves the newer owner alone and reports instead', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const a = rejection([missing('blake3:a')])
    const cb = consentCallbacks()
    installAssetConsent({ result: a.result, slot, ...cb })
    void slot.value!.retry!(['blake3:a'])
    // A newer submit claims the dialog while A's retry is in flight.
    const b = rejection([missing('blake3:b')])
    const cbB = consentCallbacks()
    installAssetConsent({ result: b.result, slot, ...cbB })
    const owner = slot.value
    a.retries[0]!.resolve(rejection([missing('blake3:a')]).result)
    await flush()
    expect(slot.value).toBe(owner)
    expect(cb.onSuperseded).toHaveBeenCalledWith([expect.objectContaining({ digest: 'blake3:a' })])
    // B's own chain is untouched and fully operational.
    void slot.value!.retry!(['blake3:b'])
    expect(b.retries).toHaveLength(1)
  })

  it('external slot clearance during flight makes the chain surrender the slot', async () => {
    // (The production dialog's Dismiss button clears the slot while busy -
    // this is exactly the contract that makes that safe: the chain keeps
    // completing, surrenders the slot, and surfaces outcomes via callbacks.)
    const slot = slotOf<AssetConsentRequest>()
    const a = rejection([missing('blake3:a')])
    const cb = consentCallbacks()
    installAssetConsent({ result: a.result, slot, ...cb })
    void slot.value!.retry!(['blake3:a'])
    slot.set(undefined) // slot cleared externally while the retry is in flight
    a.retries[0]!.resolve(rejection([missing('blake3:a')]).result)
    await flush()
    expect(slot.value).toBeUndefined() // no zombie reopen
    expect(cb.onSuperseded).toHaveBeenCalled()
  })

  it('terminal rejection clears its own dialog and reports diagnostics', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const a = rejection([missing('blake3:a')])
    const cb = consentCallbacks()
    installAssetConsent({ result: a.result, slot, ...cb })
    void slot.value!.retry!(['blake3:a'])
    const diag = { severity: 'error', origin: 'validation', code: 'x', message: 'no' } as const
    a.retries[0]!.resolve({ ok: false, diagnostics: [diag] })
    await flush()
    expect(slot.value).toBeUndefined()
    expect(cb.onRejected).toHaveBeenCalledWith([diag])
  })

  it('an owned transport failure clears its own dialog and reports', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const a = rejection([missing('blake3:a')])
    const cb = consentCallbacks()
    installAssetConsent({ result: a.result, slot, ...cb })
    void slot.value!.retry!(['blake3:a'])
    a.retries[0]!.reject(new Error('socket closed'))
    await flush()
    expect(cb.onTransportError).toHaveBeenCalledWith('socket closed')
    expect(slot.value).toBeUndefined()
  })

})

// ---------------------------------------------------------------------------
// installImportAssetResolution
// ---------------------------------------------------------------------------

const candidate = (name: string): AssetGuessCandidate =>
  ({ digest: `blake3:${'a'.repeat(64)}`, name, confidence: 'name', held: true, virtualPath: `models/${name}`, size: 42, mediaType: 'application/octet-stream' })

const match = (query: string): AssetGuessMatch => ({ query, candidates: [candidate(query)] })

const ref = (name: string): ImportAssetReference => ({ graphId: 'g0', nodeId: 'n1', inputId: 'model', name })

const installResolution = (slot: RequestSlot<ImportAssetResolutionRequest>, overrides: {
  readonly tabStillOpen?: () => boolean
} = {}): { dispatch: ReturnType<typeof vi.fn> } => {
  const dispatch = vi.fn().mockReturnValue(true)
  installImportAssetResolution({
    matches: [match('model.safetensors')],
    refs: [ref('model.safetensors')],
    reasons: { 'model.safetensors': 'ambiguous' },
    slot,
    tabStillOpen: overrides.tabStillOpen ?? (() => true),
    dispatch: dispatch as unknown as (invocation: CommandInvocation) => boolean,
  })
  return { dispatch }
}

const choicesFor = (name: string): ReadonlyMap<string, AssetGuessCandidate> =>
  new Map([[name, candidate(name)]])

describe('installImportAssetResolution ownership', () => {
  it('accepts only complete executable candidate descriptors without requiring held', () => {
    expect(assetGuessCandidateToRef({ ...candidate('model.safetensors'), held: false, virtualPath: 'models/model.safetensors' })).toEqual({
      digest: `blake3:${'a'.repeat(64)}`, name: 'model.safetensors', size: 42,
      mediaType: 'application/octet-stream', virtualPath: 'models/model.safetensors',
    })
    expect(assetGuessCandidateToRef({ ...candidate('model.safetensors'), digest: 'blake3:not-canonical' })).toBeUndefined()
    expect(assetGuessCandidateToRef({ ...candidate('model.safetensors'), size: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined()
    const { virtualPath: _missingPath, ...withoutVirtualPath } = candidate('model.safetensors')
    expect(assetGuessCandidateToRef(withoutVirtualPath)).toBeUndefined()
  })

  it('accept dispatches one batch of asset values and clears its own dialog', async () => {
    const slot = slotOf<ImportAssetResolutionRequest>()
    const { dispatch } = installResolution(slot)
    await slot.value!.accept(choicesFor('model.safetensors'))
    expect(dispatch).toHaveBeenCalledTimes(1)
    const batch = dispatch.mock.calls[0]![0] as { command: string; params: { invocations: Array<{ params: { value: { digest: string } } }> } }
    expect(batch.command).toBe('batch')
    expect(batch.params.invocations[0]!.params.value).toEqual({
      digest: `blake3:${'a'.repeat(64)}`,
      name: 'model.safetensors',
      size: 42,
      mediaType: 'application/octet-stream',
      virtualPath: 'models/model.safetensors',
    })
    expect(slot.value).toBeUndefined()
  })

  it('a stale accept (slot claimed by a newer import) neither dispatches nor clears', () => {
    const slot = slotOf<ImportAssetResolutionRequest>()
    const { dispatch } = installResolution(slot)
    const stale = slot.value!
    installResolution(slot) // newer import claims the dialog
    const owner = slot.value
    stale.accept(choicesFor('model.safetensors'))
    expect(dispatch).not.toHaveBeenCalled()
    expect(slot.value).toBe(owner)
  })

  it('cancel clears its own dialog', () => {
    const slot = slotOf<ImportAssetResolutionRequest>()
    installResolution(slot)
    slot.value!.cancel()
    expect(slot.value).toBeUndefined()
  })

  it.each([false, true])('waits for acceptance=%s and permits retry after refusal', async (accepted) => {
    const slot = slotOf<ImportAssetResolutionRequest>()
    const { dispatch } = installResolution(slot)
    let finish!: (accepted: boolean) => void
    dispatch.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve }))
    const request = slot.value!
    const pending = request.accept(choicesFor('model.safetensors'))
    await request.accept(choicesFor('model.safetensors'))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(slot.value).toBe(request)
    finish(accepted)
    await pending
    expect(slot.value).toBe(accepted ? undefined : request)
    if (!accepted) {
      const retry = request.accept(choicesFor('model.safetensors'))
      finish(true)
      await retry
      expect(slot.value).toBeUndefined()
    }
  })

})
