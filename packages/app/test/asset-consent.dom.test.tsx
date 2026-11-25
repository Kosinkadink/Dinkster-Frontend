import { render } from 'solid-js/web'
import { beforeEach, expect, it, vi } from 'vitest'
import { createSignal } from '@dinkster/core'
import type { AppState } from '../src/app-state.js'
import { AssetConsentDialog } from '../src/AssetConsentDialog.js'
import { installAssetConsent, type AssetConsentRequest } from '../src/dialog-requests.js'

beforeEach(() => {
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.setAttribute('open', '') })
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) { this.removeAttribute('open') })
})

it('keeps standalone review free of Run once even when locally ready, but retains it for a submitted run', async () => {
  const assetConsent = createSignal<AssetConsentRequest | undefined>(undefined)
  const requirement = { name: 'missing.safetensors', kind: 'model/vae' }
  const connection = {
    planModelDownload: async () => ({ ...requirement, status: 'local' as const }),
    startModelDownload: vi.fn(), fetchModelDownloads: async () => ({ instance: 'one', jobs: [] }),
    fetchModelDownload: vi.fn(), cancelModelDownload: vi.fn(),
  }
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <AssetConsentDialog app={{ assetConsent } as AppState} />, root)
  try {
    installAssetConsent({ models: [requirement], slot: assetConsent, modelDownloads: { connection, project: 'default' } })
    await Promise.resolve()
    expect(root.textContent).toContain('Check where this model comes from before you download it.')
    expect(root.textContent).toContain('Nothing downloads until you agree.')
    expect(root.textContent).toContain('Closing this does not stop a download that has started.')
    expect(root.textContent).not.toMatch(/\brun\b/i)
    expect(root.textContent).not.toContain('Run once')
    expect(root.querySelector('[data-testid="asset-consent-acquire"]')).toBeNull()
    await assetConsent.get()!.reviewModel!(0)
    await Promise.resolve()
    expect(root.textContent).not.toContain('Run once')
    expect(root.querySelector('[data-testid="asset-consent-acquire"]')).toBeNull()
    expect(root.querySelector('[data-testid="model-consent-download"]')).toBeNull()
    root.querySelector<HTMLButtonElement>('[data-testid="asset-consent-cancel"]')!.click()
    expect(assetConsent.get()).toBeUndefined()

    const retryWithAssets = vi.fn()
    installAssetConsent({ slot: assetConsent, modelDownloads: { connection, project: 'default' },
      result: { ok: false, diagnostics: [], assetsMissing: { error: 'assets-missing', assets: [], models: [requirement] }, retryWithAssets },
      onSubmitted: vi.fn(), onRejected: vi.fn(), onTransportError: vi.fn(), onSuperseded: vi.fn(),
    })
    await assetConsent.get()!.reviewModel!(0)
    await Promise.resolve()
    expect(root.querySelector<HTMLButtonElement>('[data-testid="asset-consent-acquire"]')?.textContent).toBe('Run once')
    expect(root.querySelector<HTMLButtonElement>('[data-testid="asset-consent-acquire"]')?.disabled).toBe(false)
    expect(retryWithAssets).not.toHaveBeenCalled()
  } finally {
    assetConsent.set(undefined)
    unmount()
    root.remove()
    vi.restoreAllMocks()
  }
})

it.each([false, true])('blocks downloads only for the duplicate model in standalone=%s review', async (standalone) => {
  const assetConsent = createSignal<AssetConsentRequest | undefined>(undefined)
  const models = [
    { name: 'repeated.safetensors', kind: 'model/vae' },
    { name: 'available.safetensors', kind: 'model/vae' },
  ]
  const connection = {
    planModelDownload: async (model: { name: string; kind: string }) => model.name === models[0]!.name
      ? { status: 'duplicate' as const }
      : { ...model, status: 'local' as const },
    startModelDownload: vi.fn(), fetchModelDownloads: async () => ({ instance: 'one', jobs: [] }),
    fetchModelDownload: vi.fn(), cancelModelDownload: vi.fn(),
  }
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <AssetConsentDialog app={{ assetConsent } as AppState} />, root)
  try {
    const options = { slot: assetConsent, modelDownloads: { connection, project: 'default' } }
    if (standalone) installAssetConsent({ ...options, models })
    else installAssetConsent({ ...options,
      result: { ok: false, diagnostics: [], assetsMissing: { error: 'assets-missing', assets: [], models }, retryWithAssets: vi.fn() },
      onSubmitted: vi.fn(), onRejected: vi.fn(), onTransportError: vi.fn(), onSuperseded: vi.fn(),
    })
    await assetConsent.get()!.reviewModel!(0)
    await assetConsent.get()!.reviewModel!(1)
    await Promise.resolve()
    const rows = root.querySelectorAll('[data-testid="model-consent-row"]')
    expect(rows[0]!.textContent).toContain('Two files with this name')
    expect(rows[0]!.textContent).toContain("Two files named repeated.safetensors are in this project's model folders.")
    expect(rows[0]!.textContent).not.toContain('Review source')
    expect(rows[0]!.querySelector('[data-testid="model-consent-download"]')).toBeNull()
    expect(rows[0]!.querySelector('[data-testid="model-consent-source"]')).toBeNull()
    expect(rows[1]!.textContent).toContain('Review source')
    if (standalone) expect(root.textContent).not.toMatch(/\brun\b/i)
    else expect(rows[0]!.textContent).toContain('Choose one on the node, then run again.')
    expect(root.querySelector<HTMLButtonElement>('[data-testid="asset-consent-acquire"]')?.disabled ?? true).toBe(true)
    expect(connection.startModelDownload).not.toHaveBeenCalled()
  } finally {
    assetConsent.set(undefined)
    unmount()
    root.remove()
    vi.restoreAllMocks()
  }
})
