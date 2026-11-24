import { Show, createEffect, createSignal, onCleanup } from 'solid-js'
import type { AccountStatus, DinksterConnection } from '@dinkster/client'
import { ProductAccountMenu, ProductSignInControl } from '@dinkster/ui'
import { useAppMessage } from './locale.js'

type AccountConnection = Pick<DinksterConnection, 'accountStatus' | 'startAccountSignIn' | 'cancelAccountSignIn' | 'signOutAccount'>

const PENDING_POLL_MS = 2000

/**
 * The engine's native account session in the top bar. Hidden while the engine
 * has no account services configured or its status cannot be read.
 */
export function TopBarAccount(props: { readonly connection: AccountConnection }) {
  const message = useAppMessage()
  const [status, setStatus] = createSignal<AccountStatus>()
  const [authorizationUrl, setAuthorizationUrl] = createSignal<string>()
  const report = (error: unknown): void => console.error('account request failed', error)
  const refresh = (): void => {
    props.connection.accountStatus().then(setStatus, report)
  }
  createEffect(refresh)
  const pending = () => status()?.signIn === 'pending'
  // Sign-in finishes in another browser tab, so status is read again while it is pending.
  createEffect(() => {
    if (!pending()) {
      setAuthorizationUrl(undefined)
      return
    }
    const timer = setInterval(refresh, PENDING_POLL_MS)
    onCleanup(() => clearInterval(timer))
  })
  const openSignInPage = (url: string): void => {
    window.open(url, '_blank', 'noopener')
  }
  const signIn = (): void => {
    props.connection.startAccountSignIn().then((started) => {
      setStatus(started)
      setAuthorizationUrl(started.authorizationUrl)
      openSignInPage(started.authorizationUrl)
    }, report)
  }
  return (
    <Show when={status()?.available}>
      <Show
        when={status()!.signedIn && !pending()}
        fallback={
          <ProductSignInControl
            pending={pending()}
            unavailableReason={status()!.signInUnavailableReason === 'account-sign-in-requires-engine-machine'
              ? message('shell.account.signInRequiresEngineMachine')
              : ''}
            onSignIn={signIn}
            onCancel={() => { props.connection.cancelAccountSignIn().then(setStatus, report) }}
            onOpenSignInPage={authorizationUrl() === undefined ? undefined : () => openSignInPage(authorizationUrl()!)}
          />
        }
      >
        <ProductAccountMenu
          name={status()!.profile?.displayName ?? null}
          email={status()!.profile?.email ?? null}
          onSignOut={() => { props.connection.signOutAccount().then(setStatus, report) }}
        />
      </Show>
    </Show>
  )
}
