import { renderToString } from 'solid-js/web'
import { ProductAuthCard, ProductLink } from '@dinkster/ui'

export function callbackTemplate() {
  return renderToString(() => (
    <ProductAuthCard title="__CALLBACK_HEADING__">
      <p class="dinkster-description">__CALLBACK_MESSAGE__</p>
      <ProductLink href="__CALLBACK_RETURN_URL__">
        __CALLBACK_RETURN_LABEL__
      </ProductLink>
    </ProductAuthCard>
  ))
}
