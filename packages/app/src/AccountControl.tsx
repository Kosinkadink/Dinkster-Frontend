import { Show, createEffect, createSignal, onCleanup, type Accessor } from 'solid-js'
import type { AccountStatus, DinksterConnection } from '@dinkster/client'
import { ProductAccountMenu, ProductSignInControl } from '@dinkster/ui'
import { useAppMessage } from './locale.js'

type AccountConnection = Pick<DinksterConnection, 'accountStatus' | 'startAccountSignIn' | 'cancelAccountSignIn' | 'signOutAccount'>

const ACCOUNT_POLL_MS = 2000

/** The engine's native account session, shared by every control that shows it. */
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

export function createAccountSession(connection: Accessor<AccountConnection>, baseUrl: string): AccountSession {
  const [status, setStatus] = createSignal<AccountStatus>()
  const [authorizationUrl, setAuthorizationUrl] = createSignal<string>()
  let generation = 0
  let refreshing: object | undefined
  let changing = false
  let refreshNotified = false
  let notifications: BroadcastChannel | undefined
  const accept = (value: AccountStatus): void => {
    const previous = status()
    setStatus(value)
    if (previous !== undefined && (previous.signedIn !== value.signedIn ||
      previous.principalRevision !== value.principalRevision)) notifications?.postMessage(null)
  }
  const report = (error: unknown): void => {
    if (error instanceof DOMException && error.name === 'AbortError') return
    console.error('account request failed', error)
  }
  const request = <T extends AccountStatus,>(read: () => Promise<T>, accept: (value: T) => void): void => {
    const current = ++generation
    refreshing = undefined
    changing = true
    read().then((value) => {
      if (current === generation) accept(value)
    }, (error: unknown) => { if (current === generation) report(error) }).finally(() => {
      if (current === generation) {
        changing = false
        if (refreshNotified) {
          refreshNotified = false
          refresh()
        }
      }
    })
  }
  const refresh = (): void => {
    if (refreshing || changing) return
    const current = generation
    const reading = {}
    refreshing = reading
    connection().accountStatus().then((value) => {
      if (current === generation) accept(value)
    }, (error: unknown) => { if (current === generation) report(error) }).finally(() => {
      if (refreshing === reading) refreshing = undefined
    })
  }
  createEffect(() => {
    const selected = connection()
    generation += 1
    changing = false
    refreshNotified = false
    setStatus(undefined)
    setAuthorizationUrl(undefined)
    const channel = typeof globalThis.BroadcastChannel === 'function'
      ? new BroadcastChannel(`dinkster-account:${baseUrl}`) : undefined
    notifications = channel
    // Notifications carry no identity; only the engine's reply can change authority.
    channel?.addEventListener('message', () => {
      if (changing) refreshNotified = true
      else request(() => selected.accountStatus(), accept)
    })
    request(() => selected.accountStatus(), accept)
    onCleanup(() => {
      generation += 1
      notifications = undefined
      channel?.close()
    })
  })
  const pending = () => status()?.signIn === 'pending'
  createEffect(() => {
    if (!pending()) setAuthorizationUrl(undefined)
    if (!status()?.available) return
    // Native expiry and sign-out in another window must retire this window's authority too.
    const timer = setInterval(refresh, pending() ? ACCOUNT_POLL_MS : 30_000)
    window.addEventListener('focus', refresh)
    onCleanup(() => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    })
  })
  const open = (url: string): void => {
    window.open(url, '_blank', 'noopener')
  }
  return {
    status,
    pending,
    authorizationUrl,
    signIn() {
      request(() => connection().startAccountSignIn(), (started) => {
        accept(started)
        setAuthorizationUrl(started.authorizationUrl)
        open(started.authorizationUrl)
      })
    },
    cancelSignIn() { request(() => connection().cancelAccountSignIn(), accept) },
    signOut() { request(() => connection().signOutAccount(), accept) },
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
