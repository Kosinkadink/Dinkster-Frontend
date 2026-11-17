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
  ModelRequirement,
  ModelDownloadPlan,
  ModelDownloadJob,
} from '@dinkster/client'
import type { ImportAssetPromptReason } from './import-asset-autoresolve.js'
import type { ModelProviderConnection } from './ModelProvider.js'

/** Minimal slot surface (a core Signal satisfies it). */
export interface RequestSlot<T> {
  get(): T | undefined
  set(value: T | undefined): void
}

export interface ModelConsentState {
  readonly requirement: ModelRequirement
  readonly pending: boolean
  readonly plan?: ModelDownloadPlan
  readonly job?: ModelDownloadJob
  readonly interrupted?: boolean
  readonly error?: string
}

export interface AssetConsentRequest {
  readonly providerConnection?: ModelProviderConnection
  readonly providerChanged?: () => void
  readonly providerBackendUrl?: string
  readonly models?: readonly ModelConsentState[]
  readonly reviewModel?: (index: number) => Promise<void>
  readonly downloadModel?: (index: number) => Promise<void>
  readonly cancelModel?: (index: number) => Promise<void>
  readonly assets: readonly MissingAsset[]
  readonly busy: boolean
  readonly retry: (digests: readonly string[]) => Promise<void>
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
 * Install an asset-consent request and own its whole retry chain. One call
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
  readonly result: AssetsMissingResult
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
    readonly providerConnection?: ModelProviderConnection
    readonly backendUrl?: string
  }
  readonly onSubmitted: (submitted: SubmitOk) => void
  readonly onRejected: (diagnostics: readonly Diagnostic[]) => void
  readonly onTransportError: (message: string) => void
  readonly onSuperseded: (assets: readonly MissingAsset[]) => void
}): void {
  /** The request object this chain most recently installed - its owner token. */
  let chain: AssetConsentRequest | undefined
  let inFlight = false
  let settled = false
  let poll: ReturnType<typeof setTimeout> | undefined
  const observation = new AbortController()
  const owned = (): boolean => chain !== undefined && p.slot.get() === chain
  const clearIfOwned = (): void => {
    if (owned()) p.slot.set(undefined)
    chain = undefined
  }
  const settle = (): void => {
    if (settled || inFlight) return
    settled = true
    clearTimeout(poll)
    observation.abort()
    unsubscribe()
    p.signal?.removeEventListener('abort', cancel)
    p.onSettled?.()
  }
  const cancel = (): void => {
    clearIfOwned()
    settle()
  }
  const unsubscribe = p.slot.subscribe(() => { if (!owned()) settle() })
  p.signal?.addEventListener('abort', cancel, { once: true })
  const install = (result: AssetsMissingResult): void => {
    // This STAGE's own request (advanced to its busy copy). `chain` alone
    // is not enough: a retained retry closure from an earlier stage of the
    // same chain would otherwise see the reopened request as "current" and
    // retry with ITS captured result. Each stage may only act through the
    // request object it installed itself.
    let owner: AssetConsentRequest
    const active = (job: ModelDownloadJob): boolean => !['completed', 'cancelled', 'failed'].includes(job.status)
    const update = (index: number, state: ModelConsentState): void => {
      const next: AssetConsentRequest = { ...owner, models: owner.models!.map((entry, i) => i === index ? state : entry),
        reviewModel: (i) => modelAction(i, 'review', next),
        downloadModel: (i) => modelAction(i, 'download', next),
        cancelModel: (i) => modelAction(i, 'cancel', next),
        ...(p.modelDownloads?.providerConnection ? { providerChanged: () => providerChanged(next) } : {}),
      }
      owner = next
      chain = next
      p.slot.set(next)
    }
    const providerChanged = (expected: AssetConsentRequest): void => {
      if (!owned() || settled || owner.busy || owner !== expected) return
      if (p.beforeRetry && !p.beforeRetry()) { clearIfOwned(); return }
      for (const [index, entry] of (owner.models ?? []).entries())
        update(index, { requirement: entry.requirement, pending: false })
    }
    const modelAction = async (index: number, action: 'review' | 'download' | 'cancel', expected = owner): Promise<void> => {
      const scope = p.modelDownloads
      const state = owner.models?.[index]
      if (!scope || settled || !owned() || chain !== owner || expected !== owner || owner.busy || !state || state.pending) return
      if (p.beforeRetry && !p.beforeRetry()) { clearIfOwned(); return }
      if (action === 'download' && state.plan?.status !== 'consent-required') return
      if (action === 'cancel' && (!state.job || !active(state.job))) return
      const { error: _error, ...withoutError } = state
      const pending: ModelConsentState = { ...withoutError, pending: true }
      update(index, pending)
      const current = (): boolean => !settled && owned() && chain === owner && owner.models?.[index] === pending
      try {
        const matches = (job: ModelDownloadJob): boolean => job.project === scope.project &&
          job.name === state.requirement.name && job.kind === state.requirement.kind
        let next: ModelConsentState = { requirement: state.requirement, pending: false }
        if (action === 'download' && state.plan?.status === 'consent-required') {
          const job = await scope.connection.startModelDownload(state.plan.planId, observation.signal)
          if (!matches(job)) throw new Error('Model job does not match the captured project and requirement')
          next = { ...next, job }
        } else if (action === 'cancel' && state.job) {
          const job = await scope.connection.cancelModelDownload(state.job.jobId, observation.signal)
          if (!matches(job)) throw new Error('Model job ownership changed')
          next = { ...next, job }
        } else if (state.job && active(state.job)) {
          const job = await scope.connection.fetchModelDownload(state.job.jobId, observation.signal)
          if (job && !matches(job)) throw new Error('Model job ownership changed')
          next = { ...next, ...(job ? { job } : { interrupted: true }) }
        } else {
          const { jobs } = await scope.connection.fetchModelDownloads(observation.signal)
          const job = [...jobs].reverse().find((entry) => matches(entry) && active(entry))
          if (job) next = { ...next, job }
          else {
            const plan = await scope.connection.planModelDownload(state.requirement, observation.signal)
            if (plan.status === 'consent-required' && (plan.project !== scope.project ||
              plan.name !== state.requirement.name || plan.kind !== state.requirement.kind))
              throw new Error('Model plan does not match the captured project and requirement')
            next = { ...next, plan }
          }
        }
        if (!current()) return
        if (p.beforeRetry && !p.beforeRetry()) { clearIfOwned(); return }
        update(index, next)
      } catch (error) {
        if (current()) update(index, { ...(action === 'download' ? { requirement: state.requirement } : state), pending: false,
          // A timed-out start may have reached the server. Discover before another consent.
          ...(action === 'download' ? { interrupted: true } : {}),
          error: error instanceof Error ? error.message : String(error),
        })
      }
      if (owned() && !settled) {
        clearTimeout(poll)
        poll = setTimeout(() => {
          for (const [i, entry] of (owner.models ?? []).entries()) {
            if (entry.job && active(entry.job) && !entry.error) void modelAction(i, 'review')
          }
        }, 1000)
      }
    }
    const retry = async (digests: readonly string[], location?: string): Promise<void> => {
      // Only this stage's CURRENT request may start a retry, and only once:
      // a stale closure (dialog replaced between render and click, or a
      // reopened stage of this same chain) or a double-click during flight
      // is a no-op.
      const current = p.slot.get()
      if (settled || p.signal?.aborted || current === undefined || current !== owner || current !== chain || current.busy) return
      if (current.models?.some((entry) => entry.pending || (entry.plan?.status !== 'local' && entry.job?.status !== 'completed'))) return
      if (location !== undefined && (!p.enableLocation || !current.assets.some((asset) => asset.disabledLocations?.includes(location)))) return
      clearTimeout(poll)
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
            install(retried)
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
    const request: AssetConsentRequest = { assets: result.assetsMissing.assets, busy: false, retry,
      ...(p.modelDownloads?.providerConnection ? {
        providerConnection: p.modelDownloads.providerConnection,
        ...(p.modelDownloads.backendUrl === undefined ? {} : { providerBackendUrl: p.modelDownloads.backendUrl }),
        providerChanged: () => providerChanged(request),
      } : {}),
      ...(result.assetsMissing.models?.length ? {
        models: result.assetsMissing.models.map((requirement) => ({ requirement, pending: false })),
        reviewModel: (index: number) => modelAction(index, 'review', request),
        downloadModel: (index: number) => modelAction(index, 'download', request),
        cancelModel: (index: number) => modelAction(index, 'cancel', request),
      } : {}),
      ...(p.enableLocation ? { enableLocation: (location: string) => retry([], location) } : {}),
    }
    owner = request
    chain = request
    p.slot.set(request)
  }
  if (p.signal?.aborted) settle()
  else install(p.result)
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
