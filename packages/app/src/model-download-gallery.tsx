import { createSignal } from '@dinkster/core'
import { ProductButton, ProductPage, ProductSection } from '@dinkster/ui'
import { render } from 'solid-js/web'
import type { AppState } from './app-state.js'
import { AssetConsentDialog } from './AssetConsentDialog.js'
import { installAssetConsent, type AssetConsentRequest } from './dialog-requests.js'
import '@dinkster/ui/styles.css'
import './fonts.css'
import './styles.css'

const query = new URLSearchParams(location.search)
document.documentElement.dataset.theme = query.get('theme') === 'light' ? 'light' : 'dark'
const assetConsent = createSignal<AssetConsentRequest | undefined>(undefined)
const models = [
  { name: 'flux1-dev.safetensors', kind: 'model/diffusion' },
  { name: 'available.safetensors', kind: 'model/vae' },
]

const connection = {
  planModelDownload: async (model: { name: string; kind: string }) => model.name === models[0]!.name
    ? { status: 'duplicate' as const }
    : { ...model, status: 'local' as const },
  fetchModelDownloads: async () => ({ instance: 'gallery', jobs: [] }),
  startModelDownload: async (): Promise<never> => { throw new Error('Gallery does not transfer models') },
  fetchModelDownload: async (): Promise<never> => { throw new Error('Gallery has no transfers') },
  cancelModelDownload: async (): Promise<never> => { throw new Error('Gallery has no transfers') },
}

async function openReview(standalone: boolean): Promise<void> {
  const options = { slot: assetConsent, modelDownloads: { connection, project: 'default' } }
  if (standalone) installAssetConsent({ ...options, models })
  else installAssetConsent({ ...options,
    result: {
      ok: false, diagnostics: [], assetsMissing: { error: 'assets-missing', assets: [], models },
      retryWithAssets: async (): Promise<never> => { throw new Error('Gallery does not submit workflows') },
    },
    onSubmitted: () => {}, onRejected: () => {}, onTransportError: () => {}, onSuperseded: () => {},
  })
  await assetConsent.get()!.reviewModel!(0)
  await assetConsent.get()!.reviewModel!(1)
}

render(() => <>
  <main class="dinkster-page"><ProductPage title="Model download review" description="The actual product dialog with local duplicate and available model fixtures. No model is downloaded and no workflow is submitted.">
    <ProductSection title="Duplicate name before a run" description="A model review opened from the editor. There is no captured run to retry.">
      <ProductButton onClick={() => void openReview(true)}>Open standalone review</ProductButton>
    </ProductSection>
    <ProductSection title="Duplicate name after a submitted run" description="The duplicate row blocks retry, while the separate local model remains available.">
      <ProductButton onClick={() => void openReview(false)}>Open submitted review</ProductButton>
    </ProductSection>
  </ProductPage></main>
  <AssetConsentDialog app={{ assetConsent } as AppState} />
</>, document.getElementById('root')!)

if (query.has('review')) void openReview(query.get('review') !== 'submitted')
