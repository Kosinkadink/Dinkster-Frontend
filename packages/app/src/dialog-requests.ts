/**
 * Singleton async dialog request ownership.
 *
 * The app exposes two singleton dialog slots (asset consent, import asset
 * resolution): one Signal each, where the current request is whatever the
 * slot holds. Multiple async operations can race for a slot, so every
 * completion must prove that the slot still holds its own request.
 *
 * The rule here: every write to a slot is owner-checked. An operation only
 * clears, replaces, or busy-toggles the slot while the slot still holds the
 * exact request object that operation installed (identity comparison - the
 * request object IS the owner token; no counters, no ids). A superseded
 * operation still completes its real side effects (a retried submit that
 * reached the server still installs the run), but its dialog writes become
 * no-ops and anything the user would have needed the dialog for is surfaced
 * through the problems channel instead of silently lost.
 */

import type { CommandInvocation, Diagnostic, Json, ReadonlySignal } from '@dinkster/core'
import type {
  AssetGuessCandidate,
  AssetGuessMatch,
  DinksterSubmitResult,
  MissingAsset,
  DinksterConnection,
  ModelDownloadRequirement,
} from '@dinkster/client'
import type { ImportAssetPromptReason } from './import-asset-autoresolve.js'
import type { ModelProviderConnection } from './ModelProvider.js'
import { ModelDownloadsController, type ModelDownloadState } from './model-downloads.js'

/** Minimal slot surface (a core Signal satisfies it). */
export interface RequestSlot<T> {
  get(): T | undefined
  set(value: T | undefined): void
}

export type ModelConsentState = ModelDownloadState

export interface AssetConsentRequest {
  readonly workflowTitle?: string
  readonly modelDownloadController?: ModelDownloadsController
  readonly providerConnection?: ModelProviderConnection
  readonly providerChanged?: () => void
  readonly providerBackendUrl?: string
  readonly models?: readonly ModelConsentState[]
  readonly selectModelSource?: (index: number, source: string) => void
  readonly reviewModel?: (index: number) => Promise<void>
  readonly downloadModel?: (index: number) => Promise<void>
  readonly downloadModels?: (indices: readonly number[]) => Promise<void>
  readonly cancelModel?: (index: number) => Promise<void>
  readonly enableModelLocation?: (index: number, location: string) => Promise<void>
  readonly assets: readonly MissingAsset[]
  readonly busy: boolean
  readonly retry?: (digests: readonly string[]) => Promise<void>
  readonly enableLocation?: (location: string) => Promise<void>
  readonly enablingLocation?: string
}

export interface ImportAssetReference {
  readonly graphId: string
  readonly nodeId: string
  readonly inputId: string
  readonly name: string
}

export interface ImportAssetResolutionRequest {
  readonly matches: readonly AssetGuessMatch[]
  readonly reasons: Readonly<Record<string, ImportAssetPromptReason>>
  readonly accept: (choices: ReadonlyMap<string, AssetGuessCandidate>) => void | Promise<void>
  readonly cancel: () => void
}

export interface ImportAssetRef {
  readonly digest: string
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly virtualPath: string
}

/** Convert only complete server descriptors into executable ASSET values. */
export function assetGuessCandidateToRef(candidate: AssetGuessCandidate): ImportAssetRef | undefined {
  if (!/^blake3:[0-9a-f]{64}$/.test(candidate.digest) ||
    typeof candidate.name !== 'string' ||
    typeof candidate.size !== 'number' || !Number.isSafeInteger(candidate.size) || candidate.size < 0 ||
    typeof candidate.mediaType !== 'string' ||
    typeof candidate.virtualPath !== 'string') return undefined
  return {
    digest: candidate.digest,
    name: candidate.name,
    size: candidate.size,
    mediaType: candidate.mediaType,
    virtualPath: candidate.virtualPath,
  }
}

type AssetsMissingResult = Extract<DinksterSubmitResult, { assetsMissing: unknown }>
type SubmitOk = Extract<DinksterSubmitResult, { ok: true }>

/**
 * Review model requirements without a submission, or install an asset-consent
 * request and own its whole retry chain. One call
 * covers the full conversation with the server: retry may come back with
 * MORE missing assets (reopen), a terminal rejection, a transport failure,
 * or success. Each busy toggle and reopen installs a fresh request object
 * and the chain tracks which object is currently ITS OWN; once the slot
 * holds someone else's request (a newer submit claimed the dialog, or the
 * user dismissed it), this chain stops touching the slot entirely.
 *
 * Superseded completions still report through the callbacks: a successful
 * retried submit really happened on the server, so `onSubmitted` always
 * fires; a superseded still-missing outcome fires `onSuperseded` instead of
 * reopening over the newer owner's dialog.
 */
export function installAssetConsent(p: {
  readonly workflowTitle?: string
  readonly slot: RequestSlot<AssetConsentRequest> & Pick<ReadonlySignal<AssetConsentRequest | undefined>, 'subscribe'>
  readonly signal?: AbortSignal
  /** Releases submission resources after the dialog and any posted retry settle. */
  readonly onSettled?: () => void
  /** Final app-owned safety check run before every captured-body retry. */
  readonly beforeRetry?: () => boolean
  readonly enableLocation?: (location: string) => Promise<void>
  readonly modelDownloads?: {
    readonly connection: Pick<DinksterConnection, 'planModelDownload' | 'startModelDownload' | 'fetchModelDownloads' | 'fetchModelDownload' | 'cancelModelDownload'>
    readonly project: string
    readonly controller?: ModelDownloadsController
    readonly providerConnection?: ModelProviderConnection
    readonly backendUrl?: string
  }
} & ({
  readonly result: AssetsMissingResult
  readonly onSubmitted: (submitted: SubmitOk) => void
  readonly onRejected: (diagnostics: readonly Diagnostic[]) => void
  readonly onTransportError: (message: string) => void
  readonly onSuperseded: (assets: readonly MissingAsset[]) => void
} | {
  readonly models: readonly ModelDownloadRequirement[]
  readonly result?: never
})): void {
  /** The request object this chain most recently installed - its owner token. */
  let chain: AssetConsentRequest | undefined
  let inFlight = false
  let settled = false
  const transfers = p.modelDownloads && (p.modelDownloads.controller ?? new ModelDownloadsController(p.modelDownloads.connection, p.modelDownloads.project))
  let unsubscribeModels: (() => void) | undefined
  let unsubscribe = (): void => {}
  const owned = (): boolean => chain !== undefined && p.slot.get() === chain
  const clearIfOwned = (): void => {
    if (owned()) p.slot.set(undefined)
    chain = undefined
  }
  const settle = (): void => {
    if (settled || inFlight) return
    settled = true
    unsubscribeModels?.()
    if (!p.modelDownloads?.controller) transfers?.dispose()
    unsubscribe()
    p.signal?.removeEventListener('abort', cancel)
    p.onSettled?.()
  }
  const cancel = (): void => {
    clearIfOwned()
    settle()
  }
  p.signal?.addEventListener('abort', cancel, { once: true })
  const install = (assets: readonly MissingAsset[], models: readonly ModelDownloadRequirement[] | undefined, result?: AssetsMissingResult): void => {
    // This STAGE's own request (advanced to its busy copy). `chain` alone
    // is not enough: a retained retry closure from an earlier stage of the
    // same chain would otherwise see the reopened request as "current" and
    // retry with ITS captured result. Each stage may only act through the
    // request object it installed itself.
    let owner: AssetConsentRequest
    unsubscribeModels?.()
    transfers?.ensure(models ?? [], result !== undefined)
    const currentModels = (): readonly ModelConsentState[] => (models ?? []).flatMap((requirement) => {
      const row = transfers?.rows.get().find((row) => row.requirement.name === requirement.name && row.requirement.kind === requirement.kind &&
        row.requirement.asset?.digest === requirement.asset?.digest)
      return row ? [row] : [{ requirement, pending: false }]
    })
    const update = (): void => {
      if (!owned() || settled) return
      const next: AssetConsentRequest = { ...owner, models: currentModels(),
        selectModelSource: (i, source) => selectModelSource(i, source, next),
        reviewModel: (i) => modelAction(i, 'review', next),
        downloadModel: (i) => modelAction(i, 'download', next),
        downloadModels: (indices) => downloadModels(indices, next),
        cancelModel: (i) => modelAction(i, 'cancel', next),
        ...(p.enableLocation ? { enableModelLocation: (i: number, location: string) => modelAction(i, 'enable', next, location) } : {}),
        ...(p.modelDownloads?.providerConnection ? { providerChanged: () => providerChanged(next) } : {}),
      }
      owner = next
      chain = next
      p.slot.set(next)
    }
    const selectModelSource = (index: number, source: string, expected: AssetConsentRequest): void => {
      const state = owner.models?.[index]
      if (!owned() || settled || owner.busy || owner !== expected || !state || state.pending ||
        state.queued) return
      if (p.beforeRetry && !p.beforeRetry()) { clearIfOwned(); return }
      transfers?.setSource(state.requirement, source)
    }
    const providerChanged = (expected: AssetConsentRequest): void => {
      if (!owned() || settled || owner.busy || owner !== expected) return
      if (p.beforeRetry && !p.beforeRetry()) { clearIfOwned(); return }
      for (const entry of owner.models ?? []) transfers?.invalidate(entry.requirement)
    }
    const modelAction = async (index: number, action: 'review' | 'download' | 'cancel' | 'enable', expected = owner, location?: string): Promise<void> => {
      const state = owner.models?.[index]
      if (!transfers || settled || !owned() || chain !== owner || expected !== owner || owner.busy || !state || state.pending) return
      if (p.beforeRetry && !p.beforeRetry()) { clearIfOwned(); return }
      if (action === 'review') await transfers.review(state.requirement)
      else if (action === 'download') await transfers.download([state.requirement])
      else if (action === 'enable') {
        if (p.enableLocation && location !== undefined) await transfers.enableLocation(state.requirement, location, p.enableLocation)
      }
      else await transfers.cancel(state.requirement)
      if (owned() && p.beforeRetry && !p.beforeRetry()) clearIfOwned()
    }
    const downloadModels = async (indices: readonly number[], expected: AssetConsentRequest): Promise<void> => {
      if (!transfers || settled || !owned() || expected !== owner || owner.busy) return
      if (p.beforeRetry && !p.beforeRetry()) { clearIfOwned(); return }
      await transfers.download(indices.flatMap((index) => owner.models?.[index]?.requirement ? [owner.models[index]!.requirement] : []))
      if (owned() && p.beforeRetry && !p.beforeRetry()) clearIfOwned()
    }
    const retry = async (digests: readonly string[], location?: string): Promise<void> => {
      if (!result || !p.result) return
      // Only this stage's CURRENT request may start a retry, and only once:
      // a stale closure (dialog replaced between render and click, or a
      // reopened stage of this same chain) or a double-click during flight
      // is a no-op.
      const current = p.slot.get()
      if (settled || p.signal?.aborted || current === undefined || current !== owner || current !== chain || current.busy) return
      if (current.models?.some((entry) => entry.pending || (entry.plan?.status !== 'local' && entry.job?.status !== 'completed'))) return
      if (location !== undefined && (!p.enableLocation || !current.assets.some((asset) => asset.disabledLocations?.includes(location)))) return
      inFlight = true
      const busy: AssetConsentRequest = { ...current, busy: true, ...(location !== undefined ? { enablingLocation: location } : {}) }
      owner = busy
      chain = busy
      p.slot.set(busy)
      try {
        if (p.beforeRetry !== undefined && !p.beforeRetry()) {
          clearIfOwned()
          return
        }
        if (location !== undefined) {
          await p.enableLocation!(location)
          if (!owned() || p.signal?.aborted) return
          if (p.beforeRetry !== undefined && !p.beforeRetry()) { clearIfOwned(); return }
        }
        const retried = await result.retryWithAssets(digests)
        if (retried.ok) {
          clearIfOwned()
          p.onSubmitted(retried)
        } else if ('assetsMissing' in retried) {
          if (owned()) {
            install(retried.assetsMissing.assets, retried.assetsMissing.models, retried)
          } else {
            chain = undefined
            p.onSuperseded(retried.assetsMissing.assets)
          }
        } else {
          clearIfOwned()
          p.onRejected(retried.diagnostics)
        }
      } catch (error) {
        clearIfOwned()
        p.onTransportError(error instanceof Error ? error.message : String(error))
      } finally {
        inFlight = false
        if (!owned()) settle()
      }
    }
    const request: AssetConsentRequest = { assets, busy: false,
      ...(p.workflowTitle === undefined ? {} : { workflowTitle: p.workflowTitle }),
      ...(transfers ? { modelDownloadController: transfers } : {}),
      ...(result === undefined ? {} : { retry }),
      ...(p.modelDownloads?.providerConnection ? {
        providerConnection: p.modelDownloads.providerConnection,
        ...(p.modelDownloads.backendUrl === undefined ? {} : { providerBackendUrl: p.modelDownloads.backendUrl }),
        providerChanged: () => providerChanged(request),
      } : {}),
      ...(models?.length ? {
        models: currentModels(),
        selectModelSource: (index: number, source: string) => selectModelSource(index, source, request),
        reviewModel: (index: number) => modelAction(index, 'review', request),
        downloadModel: (index: number) => modelAction(index, 'download', request),
        downloadModels: (indices: readonly number[]) => downloadModels(indices, request),
        cancelModel: (index: number) => modelAction(index, 'cancel', request),
        ...(p.enableLocation ? { enableModelLocation: (index: number, location: string) => modelAction(index, 'enable', request, location) } : {}),
      } : {}),
      ...(p.enableLocation && result ? { enableLocation: (location: string) => retry([], location) } : {}),
    }
    owner = request
    chain = request
    p.slot.set(request)
    unsubscribeModels = transfers?.rows.subscribe(update)
  }
  if (p.signal?.aborted) settle()
  else if (p.result) install(p.result.assetsMissing.assets, p.result.assetsMissing.models, p.result)
  else install([], p.models)
  if (!owned()) settle()
  else unsubscribe = p.slot.subscribe(() => { if (!owned()) settle() })
}

/**
 * Install an import-asset-resolution request whose accept/cancel only act
 * while the slot still holds THIS request. A stale dialog closure (another
 * import replaced the slot between render and click) neither dispatches
 * nor clears; accept for a since-closed tab clears its own dialog without
 * dispatching into a dead session.
 */
export function installImportAssetResolution(p: {
  readonly matches: readonly AssetGuessMatch[]
  readonly refs: readonly ImportAssetReference[]
  readonly reasons: Readonly<Record<string, ImportAssetPromptReason>>
  readonly slot: RequestSlot<ImportAssetResolutionRequest>
  readonly tabStillOpen: () => boolean
  readonly dispatch: (invocation: CommandInvocation) => boolean | Promise<boolean>
}): void {
  let pending = false
  const clearIfOwned = (): void => {
    if (p.slot.get() === request) p.slot.set(undefined)
  }
  const request: ImportAssetResolutionRequest = {
    matches: p.matches,
    reasons: p.reasons,
    cancel: clearIfOwned,
    accept: async (choices) => {
      if (p.slot.get() !== request || pending) return
      if (p.tabStillOpen()) {
        const invocations: CommandInvocation[] = []
        for (const ref of p.refs) {
          const candidate = choices.get(ref.name)
          if (!candidate) continue
          const value = assetGuessCandidateToRef(candidate)
          if (!value) continue
          invocations.push({ command: 'node.setValue', params: { graphId: ref.graphId, nodeId: ref.nodeId, inputId: ref.inputId, value: {
            ...value,
          } } })
        }
        if (invocations.length > 0) {
          pending = true
          try {
            const accepted = await p.dispatch({ command: 'batch', params: { invocations } as unknown as Json })
            if (!accepted && p.tabStillOpen()) return
          } finally {
            pending = false
          }
        }
      }
      clearIfOwned()
    },
  }
  p.slot.set(request)
}
