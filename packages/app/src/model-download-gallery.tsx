import { createSignal, t } from '@dinkster/core'
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
  <main class="dinkster-page"><ProductPage title={t('modelReviewGallery.title')} description={t('modelReviewGallery.description')}>
    <ProductSection title={t('modelReviewGallery.standaloneTitle')} description={t('modelReviewGallery.standaloneDescription')}>
      <ProductButton onClick={() => void openReview(true)}>{t('modelReviewGallery.openStandalone')}</ProductButton>
    </ProductSection>
    <ProductSection title={t('modelReviewGallery.submittedTitle')} description={t('modelReviewGallery.submittedDescription')}>
      <ProductButton onClick={() => void openReview(false)}>{t('modelReviewGallery.openSubmitted')}</ProductButton>
    </ProductSection>
  </ProductPage></main>
  <AssetConsentDialog app={{ assetConsent } as AppState} />
</>, document.getElementById('root')!)

if (query.has('review')) void openReview(query.get('review') !== 'submitted')
