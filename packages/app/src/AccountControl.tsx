import { Show, createEffect, createSignal, onCleanup, type Accessor } from 'solid-js'
import type { AccountStatus, DinksterConnection } from '@dinkster/client'
import { ProductAccountMenu, ProductSignInControl } from '@dinkster/ui'
import { useAppMessage } from './locale.js'

type AccountConnection = Pick<DinksterConnection, 'accountStatus' | 'startAccountSignIn' | 'cancelAccountSignIn' | 'signOutAccount'>

const PENDING_POLL_MS = 2000

/** The engine's native account session, read once and shared by every control that shows it. */
export interface AccountSession {
  /** Undefined until read; `available` is false while the engine has no account services. */
  readonly status: Accessor<AccountStatus | undefined>
  readonly pending: Accessor<boolean>
  /** The sign-in page of a pending sign-in this window started. */
  readonly authorizationUrl: Accessor<string | undefined>
  signIn(): void
  cancelSignIn(): void
  signOut(): void
  openSignInPage(): void
}

export function createAccountSession(connection: Accessor<AccountConnection>): AccountSession {
  const [status, setStatus] = createSignal<AccountStatus>()
  const [authorizationUrl, setAuthorizationUrl] = createSignal<string>()
  const report = (error: unknown): void => console.error('account request failed', error)
  const refresh = (): void => {
    connection().accountStatus().then(setStatus, report)
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
  const open = (url: string): void => {
    window.open(url, '_blank', 'noopener')
  }
  return {
    status,
    pending,
    authorizationUrl,
    signIn() {
      connection().startAccountSignIn().then((started) => {
        setStatus(started)
        setAuthorizationUrl(started.authorizationUrl)
        open(started.authorizationUrl)
      }, report)
    },
    cancelSignIn() { connection().cancelAccountSignIn().then(setStatus, report) },
    signOut() { connection().signOutAccount().then(setStatus, report) },
    openSignInPage() {
      const url = authorizationUrl()
      if (url !== undefined) open(url)
    },
  }
}

/**
 * The account control: sign in, signing in, or the signed-in account's menu.
 * Hidden while the engine has no account services or its status cannot be read.
 */
export function AccountControl(props: { readonly session: AccountSession; readonly rail?: boolean }) {
  const message = useAppMessage()
  const status = () => props.session.status()
  return (
    <Show when={status()?.available}>
      <Show
        when={status()!.signedIn && !props.session.pending()}
        fallback={
          <ProductSignInControl
            pending={props.session.pending()}
            unavailableReason={status()!.signInUnavailableReason === 'account-sign-in-requires-engine-machine'
              ? message('shell.account.signInRequiresEngineMachine')
              : ''}
            rail={props.rail ?? false}
            onSignIn={() => props.session.signIn()}
            onCancel={() => props.session.cancelSignIn()}
            onOpenSignInPage={props.session.authorizationUrl() === undefined ? undefined : () => props.session.openSignInPage()}
          />
        }
      >
        <ProductAccountMenu
          name={status()!.profile?.displayName ?? null}
          email={status()!.profile?.email ?? null}
          rail={props.rail ?? false}
          onSignOut={() => props.session.signOut()}
        />
      </Show>
    </Show>
  )
}
