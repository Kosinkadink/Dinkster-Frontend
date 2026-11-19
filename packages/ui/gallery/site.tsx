import { For, Match, Switch, createSignal } from 'solid-js'
import { ArrowUpFromLine, Key, Shield, User } from 'lucide-solid'
import {
  ProductAccountMenu,
  ProductAuthCard,
  ProductButton,
  ProductDisclosure,
  ProductFacts,
  ProductField,
  ProductList,
  ProductListRow,
  ProductPage,
  ProductPanel,
  ProductProviderButton,
  ProductSection,
  ProductSelect,
  ProductShell,
  ProductStatusPill,
  ProductTextInput,
} from '../src/index.js'

const navigation = [
  { label: 'Profile', href: '#site-profile', icon: User },
  { label: 'Security', href: '#site-security', icon: Shield },
  { label: 'API keys', href: '#site-keys', icon: Key },
  { label: 'Publishing', href: '#site-publishing', icon: ArrowUpFromLine },
]

/** A fixed account fixture makes the layout comparable across window sizes. */
export function SiteGallery(props: {
  route: string
  onNavigate: (href: string) => void
}) {
  const [displayName, setDisplayName] = createSignal('alice')
  const [savedName, setSavedName] = createSignal('alice')
  const [message, setMessage] = createSignal('')
  return (
    <Switch>
      <Match when={props.route === '#site-card'}>
        <ProductAuthCard
          title="Sign in"
          footer={
            <div class="dinkster-auth-footer">
              <p class="dinkster-description">New to Dinkster?</p>
              <ProductButton onClick={() => setMessage('Create an account')}>
                Create an account
              </ProductButton>
            </div>
          }
        >
          <ProductField label="Email">
            {(attributes) => <ProductTextInput {...attributes} type="email" />}
          </ProductField>
          <ProductField label="Password">
            {(attributes) => (
              <ProductTextInput {...attributes} type="password" />
            )}
          </ProductField>
          <ProductButton fill="solid" onClick={() => setMessage('Signed in')}>
            Sign in
          </ProductButton>
          <p class="dinkster-auth-separator">or</p>
          <ProductProviderButton
            provider="github"
            onClick={() => setMessage('GitHub selected')}
          >
            Continue with GitHub
          </ProductProviderButton>
          <ProductProviderButton
            provider="google"
            onClick={() => setMessage('Google selected')}
          >
            Continue with Google
          </ProductProviderButton>
          <span class="dinkster-visually-hidden" role="status">
            {message()}
          </span>
        </ProductAuthCard>
      </Match>
      <Match when={true}>
        <ProductShell
          title="Account"
          navigation={navigation}
          currentHref={props.route}
          onNavigate={props.onNavigate}
          account={
            <ProductAccountMenu
              name="alice"
              email="alice@example.com"
              pictureSrc={new URLSearchParams(window.location.search).get(
                'picture',
              )}
              onSignOut={() => setMessage('Signed out')}
            />
          }
        >
          <ProductPage
            title={
              navigation.find((item) => item.href === props.route)?.label ??
              'Security'
            }
          >
            <Switch>
              <Match when={props.route === '#site-security'}>
                <ProductSection title="Sign-in methods">
                  <ProductList label="Sign-in methods">
                    <For
                      each={[
                        {
                          title: 'Password',
                          description: 'Not set',
                          action: 'Set by email',
                        },
                        {
                          title: 'Google',
                          description: 'Not linked',
                          action: 'Link',
                        },
                        {
                          title: 'GitHub',
                          description: 'Not linked',
                          action: 'Link',
                        },
                      ]}
                    >
                      {(row) => (
                        <ProductListRow
                          title={row.title}
                          description={row.description}
                          action={
                            <ProductButton
                              intent={
                                row.title === 'Password' ? 'neutral' : 'add'
                              }
                              onClick={() => setMessage(row.action)}
                            >
                              {row.action}
                            </ProductButton>
                          }
                        />
                      )}
                    </For>
                  </ProductList>
                </ProductSection>
                <ProductSection title="Two-step sign-in">
                  <ProductList label="Two-step verification">
                    <ProductListRow
                      title="Authenticator app"
                      description="Off"
                      action={
                        <ProductButton
                          intent="add"
                          onClick={() => setMessage('Turn on')}
                        >
                          Turn on
                        </ProductButton>
                      }
                    />
                  </ProductList>
                  <p class="dinkster-description">
                    Asks for a code from an app on your phone each time you sign
                    in.
                  </p>
                </ProductSection>
              </Match>
              <Match when={props.route === '#site-profile'}>
                <ProductPanel>
                  <ProductField label="Display name">
                    {(attributes) => (
                      <ProductTextInput
                        {...attributes}
                        value={displayName()}
                        onInput={(event) =>
                          setDisplayName(event.currentTarget.value)
                        }
                      />
                    )}
                  </ProductField>
                  <ProductField label="Language">
                    {(attributes) => (
                      <ProductSelect {...attributes}>
                        <option>English</option>
                        <option>Chinese</option>
                      </ProductSelect>
                    )}
                  </ProductField>
                </ProductPanel>
                <div class="dinkster-actions">
                  <ProductButton
                    fill="solid"
                    disabled={displayName() === savedName()}
                    onClick={() => setSavedName(displayName())}
                  >
                    Save
                  </ProductButton>
                </div>
                <ProductPanel>
                  <ProductFacts
                    label="Account details"
                    items={[
                      {
                        label: 'Email',
                        value: (
                          <>
                            alice@example.com
                            <ProductStatusPill tone="good">
                              Verified
                            </ProductStatusPill>
                          </>
                        ),
                      },
                      { label: 'Account', value: 'alice' },
                    ]}
                  />
                </ProductPanel>
              </Match>
              <Match when={true}>
                <ProductPanel>
                  <ProductFacts
                    label="Statuses"
                    items={[
                      {
                        label: 'Current key',
                        value: (
                          <ProductStatusPill tone="good">
                            Active
                          </ProductStatusPill>
                        ),
                      },
                      {
                        label: 'Old key',
                        value: (
                          <ProductStatusPill tone="problem">
                            Revoked
                          </ProductStatusPill>
                        ),
                      },
                      {
                        label: 'Previous key',
                        value: (
                          <ProductStatusPill tone="warning">
                            Expired
                          </ProductStatusPill>
                        ),
                      },
                      {
                        label: 'Draft',
                        value: (
                          <ProductStatusPill tone="neutral">
                            Not published
                          </ProductStatusPill>
                        ),
                      },
                    ]}
                  />
                </ProductPanel>
                <ProductDisclosure title="Revoked and expired">
                  <p class="dinkster-description">No other keys.</p>
                </ProductDisclosure>
              </Match>
            </Switch>
            <span class="dinkster-visually-hidden" role="status">
              {message()}
            </span>
          </ProductPage>
        </ProductShell>
      </Match>
    </Switch>
  )
}
