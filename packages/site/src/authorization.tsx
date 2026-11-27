import { render } from 'solid-js/web'
import {
  ProductAuthCard,
  ProductButton,
  ProductTextInput,
  reportProductEvent,
} from '@dinkster/ui'
import '@dinkster/ui/styles.css'

export interface AuthorizationConfig {
  clientName: string
  scopes: string[]
  consentToken: string
}

const permissionDescriptions = new Map([
  ['openid', 'Recognize your account.'],
  ['profile', 'See your name and picture.'],
  ['email', 'See your email address.'],
  ['offline_access', 'Stay signed in between visits.'],
  [
    'projects:gateway',
    "See your projects and use Dinkster's online services with your current project permissions.",
  ],
])

export function authorizationView(
  root: HTMLElement,
  config: AuthorizationConfig,
) {
  const identityScopes = ['openid', 'profile', 'email']
  const fullProfile = identityScopes.every((scope) =>
    config.scopes.includes(scope),
  )
  const permissions = config.scopes.flatMap((scope) => {
    if (fullProfile && identityScopes.includes(scope))
      return scope === 'email'
        ? ['See your name, picture and email address.']
        : []
    return [permissionDescriptions.get(scope) ?? scope]
  })
  reportProductEvent({ type: 'page-viewed', route: 'authorization' })
  return render(
    () => (
      <div class="dinkster-root" data-density="site" data-theme="dark">
        <ProductAuthCard title={`Let "${config.clientName}" use your account?`}>
          <p class="dinkster-description">It will be able to:</p>
          {permissions.map((permission) => (
            <p class="dinkster-description">{permission}</p>
          ))}
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
