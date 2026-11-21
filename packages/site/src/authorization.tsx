import { render } from 'solid-js/web'
import {
  ProductAuthCard,
  ProductButton,
  ProductCodeBlock,
  ProductTextInput,
  reportProductEvent,
} from '@dinkster/ui'
import '@dinkster/ui/styles.css'

export interface AuthorizationConfig {
  clientName: string
  scopes: string[]
  consentToken: string
}

export function authorizationView(
  root: HTMLElement,
  config: AuthorizationConfig,
) {
  reportProductEvent({ type: 'page-viewed', route: 'authorization' })
  return render(
    () => (
      <div class="dinkster-root" data-density="site" data-theme="dark">
        <ProductAuthCard title={`Authorize ${config.clientName}`}>
          <p class="dinkster-description">
            This application is requesting these permissions:
          </p>
          <ProductCodeBlock
            label="Permissions"
            value={config.scopes.join('\n')}
          />
          <form class="dinkster-actions" method="post" action="/authorize">
            <ProductTextInput
              hidden
              name="consent_token"
              value={config.consentToken}
              readOnly
            />
            <ProductButton
              type="submit"
              name="action"
              value="approve"
              intent="add"
              fill="solid"
            >
              Allow
            </ProductButton>
            <ProductButton type="submit" name="action" value="deny">
              Deny
            </ProductButton>
          </form>
        </ProductAuthCard>
      </div>
    ),
    root,
  )
}

const config = document.querySelector<HTMLMetaElement>(
  'meta[name="authorization-config"]',
)
if (config)
  authorizationView(
    document.getElementById('authorization-root')!,
    JSON.parse(config.content) as AuthorizationConfig,
  )
