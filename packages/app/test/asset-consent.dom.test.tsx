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

    const asset = { digest: `blake3:${'a'.repeat(64)}`, name: requirement.name, size: 8192,
      mediaType: 'application/octet-stream', virtualPath: `models/${requirement.name}` }
    const retryWithAssets = vi.fn()
    installAssetConsent({ slot: assetConsent, modelReferences: [{ ...requirement, asset }],
      modelDownloads: { connection, project: 'default' },
      result: { ok: false, diagnostics: [], assetsMissing: { error: 'assets-missing', assets: [
        { digest: asset.digest, name: asset.name, status: 'missing', sources: [], fetchable: true },
      ] }, retryWithAssets },
      onSubmitted: vi.fn(), onRejected: vi.fn(), onTransportError: vi.fn(), onSuperseded: vi.fn(),
    })
    await Promise.resolve()
    expect(root.querySelectorAll('[data-testid="model-consent-row"]')).toHaveLength(1)
    expect(root.querySelector('[data-testid="asset-consent-row"]')).toBeNull()
    expect(root.querySelector<HTMLButtonElement>('[data-testid="asset-consent-acquire"]')?.disabled).toBe(true)
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
