/**
 * Singleton async dialog ownership unit tests: every write to
 * a dialog slot is owner-checked. An older operation whose slot was claimed
 * by a newer request (or dismissed by the user) completes its real side
 * effects but stops touching the slot: no clears over the newer owner, no
 * busy toggles on someone else's request, no stale accept/cancel dispatch.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSignal, type CommandInvocation } from '@dinkster/core'
import type { AssetGuessCandidate, AssetGuessMatch, DinksterSubmitResult, MissingAsset } from '@dinkster/client'
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
  it('installs a non-busy request carrying the rejection assets', () => {
    const slot = slotOf<AssetConsentRequest>()
    const { result } = rejection([missing('blake3:a')])
    installAssetConsent({ result, slot, ...consentCallbacks() })
    expect(slot.value?.assets.map((a) => a.digest)).toEqual(['blake3:a'])
    expect(slot.value?.busy).toBe(false)
  })

  it('successful retry clears its own dialog and reports the run', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const { result, retries } = rejection([missing('blake3:a')])
    const cb = consentCallbacks()
    installAssetConsent({ result, slot, ...cb })
    void slot.value!.retry(['blake3:a'])
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
    void slot.value!.retry(['blake3:a'])
    void slot.value!.retry(['blake3:a'])
    expect(retries).toHaveLength(1)
  })

  it('checks the app safety gate before every captured-body retry', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const { result, retries } = rejection([missing('blake3:a')])
    const beforeRetry = vi.fn().mockReturnValue(false)
    installAssetConsent({ result, slot, beforeRetry, ...consentCallbacks() })
    await slot.value!.retry(['blake3:a'])
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
    void stale.retry(['blake3:a'])
    expect(retries).toHaveLength(0)
    expect(slot.value).toBe(current)
    expect(slot.value?.busy).toBe(false)
  })

  it('still-missing while owned reopens with the fresh assets', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const { result, retries } = rejection([missing('blake3:a')])
    const cb = consentCallbacks()
    installAssetConsent({ result, slot, ...cb })
    void slot.value!.retry(['blake3:a'])
    const followup = rejection([missing('blake3:a'), missing('blake3:b')])
    retries[0]!.resolve(followup.result)
    await flush()
    expect(slot.value?.busy).toBe(false)
    expect(slot.value?.assets.map((a) => a.digest)).toEqual(['blake3:a', 'blake3:b'])
    expect(cb.onSuperseded).not.toHaveBeenCalled()
    // ...and the reopened request's retry chain still works.
    void slot.value!.retry(['blake3:b'])
    expect(followup.retries).toHaveLength(1)
  })

  it('a retained pre-reopen request cannot retry the reopened stage of its own chain', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const { result, retries } = rejection([missing('blake3:a')])
    installAssetConsent({ result, slot, ...consentCallbacks() })
    const first = slot.value!
    void first.retry(['blake3:a'])
    const followup = rejection([missing('blake3:a'), missing('blake3:b')])
    retries[0]!.resolve(followup.result)
    await flush()
    const reopened = slot.value
    expect(reopened).not.toBe(first)
    // The stale first-stage closure must not mark the reopened request busy
    // or fire ITS captured retryWithAssets against the reopened stage.
    void first.retry(['blake3:a'])
    expect(slot.value).toBe(reopened)
    expect(slot.value?.busy).toBe(false)
    expect(retries).toHaveLength(1) // no second retry through the old result
    expect(followup.retries).toHaveLength(0)
  })

  it('a superseded still-missing outcome leaves the newer owner alone and reports instead', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const a = rejection([missing('blake3:a')])
    const cb = consentCallbacks()
    installAssetConsent({ result: a.result, slot, ...cb })
    void slot.value!.retry(['blake3:a'])
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
    void slot.value!.retry(['blake3:b'])
    expect(b.retries).toHaveLength(1)
  })

  it('a superseded successful retry still reports the run without touching the slot', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const a = rejection([missing('blake3:a')])
    const cb = consentCallbacks()
    installAssetConsent({ result: a.result, slot, ...cb })
    void slot.value!.retry(['blake3:a'])
    const b = rejection([missing('blake3:b')])
    installAssetConsent({ result: b.result, slot, ...consentCallbacks() })
    const owner = slot.value
    a.retries[0]!.resolve(submitOk)
    await flush()
    expect(cb.onSubmitted).toHaveBeenCalledWith(submitOk) // the server really ran it
    expect(slot.value).toBe(owner) // but B's dialog survives
  })

  it('external slot clearance during flight makes the chain surrender the slot', async () => {
    // (The production dialog's Dismiss button clears the slot while busy -
    // this is exactly the contract that makes that safe: the chain keeps
    // completing, surrenders the slot, and surfaces outcomes via callbacks.)
    const slot = slotOf<AssetConsentRequest>()
    const a = rejection([missing('blake3:a')])
    const cb = consentCallbacks()
    installAssetConsent({ result: a.result, slot, ...cb })
    void slot.value!.retry(['blake3:a'])
    slot.set(undefined) // slot cleared externally while the retry is in flight
    a.retries[0]!.resolve(rejection([missing('blake3:a')]).result)
    await flush()
    expect(slot.value).toBeUndefined() // no zombie reopen
    expect(cb.onSuperseded).toHaveBeenCalled()
  })

  it('idle user dismissal makes a later stale retry a no-op', () => {
    const slot = slotOf<AssetConsentRequest>()
    const { result, retries } = rejection([missing('blake3:a')])
    installAssetConsent({ result, slot, ...consentCallbacks() })
    const dismissed = slot.value!
    slot.set(undefined) // the dialog's non-busy dismiss path
    void dismissed.retry(['blake3:a'])
    expect(retries).toHaveLength(0)
    expect(slot.value).toBeUndefined()
  })

  it('terminal rejection clears its own dialog and reports diagnostics', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const a = rejection([missing('blake3:a')])
    const cb = consentCallbacks()
    installAssetConsent({ result: a.result, slot, ...cb })
    void slot.value!.retry(['blake3:a'])
    const diag = { severity: 'error', origin: 'validation', code: 'x', message: 'no' } as const
    a.retries[0]!.resolve({ ok: false, diagnostics: [diag] })
    await flush()
    expect(slot.value).toBeUndefined()
    expect(cb.onRejected).toHaveBeenCalledWith([diag])
  })

  it('a superseded terminal rejection reports diagnostics without clearing the newer owner', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const a = rejection([missing('blake3:a')])
    const cb = consentCallbacks()
    installAssetConsent({ result: a.result, slot, ...cb })
    void slot.value!.retry(['blake3:a'])
    const b = rejection([missing('blake3:b')])
    installAssetConsent({ result: b.result, slot, ...consentCallbacks() })
    const owner = slot.value
    const diag = { severity: 'error', origin: 'validation', code: 'x', message: 'no' } as const
    a.retries[0]!.resolve({ ok: false, diagnostics: [diag] })
    await flush()
    expect(cb.onRejected).toHaveBeenCalledWith([diag])
    expect(slot.value).toBe(owner)
  })

  it('an owned transport failure clears its own dialog and reports', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const a = rejection([missing('blake3:a')])
    const cb = consentCallbacks()
    installAssetConsent({ result: a.result, slot, ...cb })
    void slot.value!.retry(['blake3:a'])
    a.retries[0]!.reject(new Error('socket closed'))
    await flush()
    expect(cb.onTransportError).toHaveBeenCalledWith('socket closed')
    expect(slot.value).toBeUndefined()
  })

  it('a superseded transport failure reports without clearing the newer owner', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const a = rejection([missing('blake3:a')])
    const cb = consentCallbacks()
    installAssetConsent({ result: a.result, slot, ...cb })
    void slot.value!.retry(['blake3:a'])
    const b = rejection([missing('blake3:b')])
    installAssetConsent({ result: b.result, slot, ...consentCallbacks() })
    const owner = slot.value
    a.retries[0]!.reject(new Error('socket closed'))
    await flush()
    expect(cb.onTransportError).toHaveBeenCalledWith('socket closed')
    expect(slot.value).toBe(owner)
  })

  it('settles resources once, after the final callback, across reopened and cancelled in-flight stages', async () => {
    const slot = slotOf<AssetConsentRequest>()
    const first = rejection([missing('blake3:a')])
    const second = rejection([missing('blake3:b')])
    const controller = new AbortController()
    const onSettled = vi.fn()
    const onSubmitted = vi.fn(() => expect(onSettled).not.toHaveBeenCalled())
    installAssetConsent({ result: first.result, slot, ...consentCallbacks(), onSubmitted, onSettled, signal: controller.signal })
    const firstRetry = slot.get()!.retry([])
    first.retries[0]!.resolve(second.result)
    await firstRetry
    expect(onSettled).not.toHaveBeenCalled()
    const secondRetry = slot.get()!.retry([])
    controller.abort()
    expect(slot.get()).toBeUndefined()
    expect(onSettled).not.toHaveBeenCalled()
    second.retries[0]!.resolve(submitOk)
    await secondRetry
    expect(onSubmitted).toHaveBeenCalledOnce()
    expect(onSettled).toHaveBeenCalledOnce()
    slot.set(undefined)
    expect(onSettled).toHaveBeenCalledOnce()
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
  const dispatch = vi.fn()
  installImportAssetResolution({
    matches: [match('model.safetensors')],
    refs: [ref('model.safetensors')],
    reasons: { 'model.safetensors': 'ambiguous' },
    slot,
    tabStillOpen: overrides.tabStillOpen ?? (() => true),
    dispatch: dispatch as unknown as (invocation: CommandInvocation) => void,
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

  it('accept dispatches one batch of asset values and clears its own dialog', () => {
    const slot = slotOf<ImportAssetResolutionRequest>()
    const { dispatch } = installResolution(slot)
    slot.value!.accept(choicesFor('model.safetensors'))
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

  it('does not dispatch an incomplete candidate supplied by a stale caller', () => {
    const slot = slotOf<ImportAssetResolutionRequest>()
    const { dispatch } = installResolution(slot)
    const { mediaType: _missing, ...incomplete } = candidate('model.safetensors')
    slot.value!.accept(new Map([['model.safetensors', incomplete]]))
    expect(dispatch).not.toHaveBeenCalled()
    expect(slot.value).toBeUndefined()
  })

  it('accept with no chosen candidates clears without dispatching', () => {
    const slot = slotOf<ImportAssetResolutionRequest>()
    const { dispatch } = installResolution(slot)
    slot.value!.accept(new Map())
    expect(dispatch).not.toHaveBeenCalled()
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

  it('a stale cancel leaves the newer owner in place', () => {
    const slot = slotOf<ImportAssetResolutionRequest>()
    installResolution(slot)
    const stale = slot.value!
    installResolution(slot)
    const owner = slot.value
    stale.cancel()
    expect(slot.value).toBe(owner)
  })

  it('accept for a since-closed tab clears its own dialog without dispatching', () => {
    const slot = slotOf<ImportAssetResolutionRequest>()
    let open = true
    const { dispatch } = installResolution(slot, { tabStillOpen: () => open })
    open = false // tab closed (or replaced - object identity) before the click
    slot.value!.accept(choicesFor('model.safetensors'))
    expect(dispatch).not.toHaveBeenCalled()
    expect(slot.value).toBeUndefined()
  })

  it('a second accept after the first is a no-op', () => {
    const slot = slotOf<ImportAssetResolutionRequest>()
    const { dispatch } = installResolution(slot)
    const request = slot.value!
    request.accept(choicesFor('model.safetensors'))
    request.accept(choicesFor('model.safetensors'))
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('cancel clears its own dialog', () => {
    const slot = slotOf<ImportAssetResolutionRequest>()
    installResolution(slot)
    slot.value!.cancel()
    expect(slot.value).toBeUndefined()
  })
})
