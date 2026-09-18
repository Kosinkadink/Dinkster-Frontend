import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { MessageParams } from '@dinkster/core'
import { canonicalBackendUrl, type AppState } from './app-state.js'
import {
  CONNECTION_PROFILES_KEY,
  createConnectionProfile,
  listConnectionProfiles,
  removeConnectionProfile,
  validProfileUrl,
  withConnectionProfilesLock,
  type ConnectionProfile,
} from './connection-profiles.js'
import { desktopBridge, type DesktopConnectionCredentials } from './desktop-bridge.js'
import { useAppMessage } from './locale.js'
import { ProductNotice } from './ProductForm.js'
import { scopedStorageKey } from './projects.js'

interface ConnectionProfileError {
  readonly key: string
  readonly params?: MessageParams
}

/**
 * Saved remote connections: create, connect, and remove profiles, and on
 * desktop attach an access token per profile. Tokens go straight to the
 * desktop bridge; they are never rendered back and never enter storage the
 * renderer can read.
 */
export function ConnectionProfilesSection(props: { readonly app: AppState }) {
  const bridge = desktopBridge()
  const message = useAppMessage()
  const [profiles, setProfiles] = createSignal<readonly ConnectionProfile[]>(listConnectionProfiles())
  const [credentials, setCredentials] = createSignal<DesktopConnectionCredentials>({ custody: false, profiles: [] })
  const [name, setName] = createSignal('')
  const [url, setUrl] = createSignal('')
  const [token, setToken] = createSignal('')
  const [error, setError] = createSignal<ConnectionProfileError>({ key: '' })
  const [busyProfile, setBusyProfile] = createSignal<string | undefined>(undefined)
  const errorMessage = (): string => {
    const current = error()
    return current.key ? message(current.key, current.params) : ''
  }

  const refreshProfiles = (): void => { setProfiles(listConnectionProfiles()) }
  const refreshCredentials = (): void => {
    if (!bridge) return
    void bridge.connectionCredentials().then(setCredentials).catch(() => {})
  }
  onMount(() => {
    refreshCredentials()
    // Another window on the same project may edit the same profile list.
    const storageKey = scopedStorageKey(CONNECTION_PROFILES_KEY)
    const onStorage = (event: StorageEvent): void => {
      if (event.key === storageKey) refreshProfiles()
    }
    globalThis.addEventListener?.('storage', onStorage)
    onCleanup(() => globalThis.removeEventListener?.('storage', onStorage))
  })

  const custody = (): boolean => credentials().custody
  const hasCredential = (id: string): boolean => credentials().profiles.includes(id)

  // One credential mutation at a time in this window: the guard is set
  // synchronously before any await so the UI disables immediately. Other
  // windows on the same project have their own guard, so every mutation body
  // also runs under withConnectionProfilesLock, and token saves re-check the
  // profile still exists inside the lock. Without that, a save in one window
  // interleaved with a removal in another would re-store a credential whose
  // profile is being deleted, orphaning it.
  const [credentialBusy, setCredentialBusy] = createSignal(false)

  const add = async (): Promise<void> => {
    if (credentialBusy()) return
    setCredentialBusy(true)
    setError({ key: '' })
    try {
      await withConnectionProfilesLock(async () => {
        const profile = createConnectionProfile(name(), url())
        if (!profile) {
          setError({
            key: validProfileUrl(canonicalBackendUrl(url()))
              ? 'connectionProfiles.error.storage'
              : 'connectionProfiles.error.address',
          })
          return
        }
        const secret = token().trim()
        if (secret !== '' && bridge) {
          try {
            await bridge.setConnectionCredential(profile.id, profile.url, secret)
          } catch (cause) {
            setError({ key: 'connectionProfiles.error.savedToken', params: { error: cause instanceof Error ? cause.message : String(cause) } })
          }
        }
        setName('')
        setUrl('')
        setToken('')
        refreshProfiles()
        refreshCredentials()
      })
    } finally {
      setCredentialBusy(false)
    }
  }

  const connect = async (profile: ConnectionProfile): Promise<void> => {
    if (busyProfile()) return
    setBusyProfile(profile.id)
    setError({ key: '' })
    try {
      const added = await props.app.addBackendByUrl(profile.url, { label: profile.name })
      if (!added) setError({ key: 'connectionProfiles.error.connect', params: { name: profile.name } })
    } finally {
      setBusyProfile(undefined)
    }
  }

  const remove = async (profile: ConnectionProfile): Promise<void> => {
    if (credentialBusy()) return
    setCredentialBusy(true)
    setError({ key: '' })
    try {
      await withConnectionProfilesLock(async () => {
        // The credential is retired first: removing the profile first could
        // orphan an encrypted token that keeps authenticating its origin with
        // no remaining UI to clear it. Retirement also blocks any in-flight
        // save from another window from re-storing a token for this id.
        // On failure the profile stays.
        if (bridge) {
          try {
            await bridge.retireConnectionProfile(profile.id)
          } catch (cause) {
            setError({ key: 'connectionProfiles.error.removeToken', params: { name: profile.name, error: cause instanceof Error ? cause.message : String(cause) } })
            return
          }
        }
        if (!removeConnectionProfile(profile.id)) {
          setError({ key: 'connectionProfiles.error.removeStorage', params: { name: profile.name } })
          return
        }
        refreshProfiles()
        refreshCredentials()
      })
    } finally {
      setCredentialBusy(false)
    }
  }

  const clearToken = async (profile: ConnectionProfile): Promise<void> => {
    if (!bridge || credentialBusy()) return
    setCredentialBusy(true)
    try {
      await withConnectionProfilesLock(async () => {
        await bridge.setConnectionCredential(profile.id, undefined, null)
      })
    } catch (cause) {
      setError({ key: 'connectionProfiles.error.clearToken', params: { error: cause instanceof Error ? cause.message : String(cause) } })
      return
    } finally {
      setCredentialBusy(false)
    }
    setError({ key: '' })
    refreshCredentials()
  }

  const [tokenEditor, setTokenEditor] = createSignal<string | undefined>(undefined)
  const [editedToken, setEditedToken] = createSignal('')
  const saveToken = async (profile: ConnectionProfile): Promise<void> => {
    const secret = editedToken().trim()
    if (!bridge || secret === '' || credentialBusy()) return
    setCredentialBusy(true)
    setError({ key: '' })
    try {
      await withConnectionProfilesLock(async () => {
        // Re-check under the lock: another window may have removed this
        // profile while the save waited; storing its token now would leave
        // an orphaned credential with no UI to clear it.
        if (!listConnectionProfiles().some((p) => p.id === profile.id)) {
          setError({ key: 'connectionProfiles.error.removedElsewhere', params: { name: profile.name } })
          refreshProfiles()
          refreshCredentials()
          return
        }
        try {
          await bridge.setConnectionCredential(profile.id, profile.url, secret)
        } catch (cause) {
          setError({ key: 'connectionProfiles.error.saveToken', params: { error: cause instanceof Error ? cause.message : String(cause) } })
          return
        }
        setTokenEditor(undefined)
        setEditedToken('')
        refreshCredentials()
      })
    } finally {
      setCredentialBusy(false)
    }
  }

  return (
    <section class="connection-profiles" data-testid="connection-profiles" aria-label={message('connectionProfiles.title')}>
      <div>
        <h2>{message('connectionProfiles.title')}</h2>
        <p>
          {message('connectionProfiles.description')}
          {custody()
            ? message('connectionProfiles.description.custody')
            : ''}
        </p>
      </div>
      <Show when={bridge && !custody()}>
        <ProductNotice tone="status">
          {message('connectionProfiles.notice.noEncryption')}
        </ProductNotice>
      </Show>
      <Show when={!bridge}>
        <ProductNotice tone="status">
          {message('connectionProfiles.notice.desktopRequired')}
        </ProductNotice>
      </Show>

      <form onSubmit={(event) => { event.preventDefault(); void add() }}>
        <div class="connection-profile-fields">
          <label>
            {message('connectionProfiles.label.name')}
            <input
              data-testid="profile-name-input"
              placeholder={message('connectionProfiles.placeholder.name')}
              value={name()}
              onInput={(event) => { setName(event.currentTarget.value); setError({ key: '' }) }}
            />
          </label>
          <label>
            {message('connectionProfiles.label.serverAddress')}
            <input
              data-testid="profile-url-input"
              inputmode="url"
              autocomplete="url"
              placeholder={message('connectionProfiles.placeholder.url')}
              value={url()}
              onInput={(event) => { setUrl(event.currentTarget.value); setError({ key: '' }) }}
            />
          </label>
          <Show when={custody()}>
            <label>
              {message('connectionProfiles.label.accessTokenOptional')}
              <input
                data-testid="profile-token-input"
                type="password"
                autocomplete="off"
                value={token()}
                onInput={(event) => setToken(event.currentTarget.value)}
              />
            </label>
          </Show>
        </div>
        <button data-testid="profile-add" type="submit" disabled={url().trim() === '' || credentialBusy()}>
          {message('connectionProfiles.action.saveProfile')}
        </button>
        <Show when={errorMessage()}>{(text) => <p class="backend-add-error" role="alert">{text()}</p>}</Show>
      </form>

      <ul class="connection-profile-list">
        <For each={profiles()}>{(profile) => (
          <li class="connection-profile-row" data-testid="profile-row" data-profile={profile.id}>
            <div class="connection-profile-identity">
              <div class="backend-title-line">
                <strong>{profile.name}</strong>
                <Show when={hasCredential(profile.id)}>
                  <span class="backend-badge" data-testid="profile-credential-badge">{message('connectionProfiles.badge.tokenInKeychain')}</span>
                </Show>
              </div>
              <code class="backend-address">{profile.url}</code>
            </div>
            <div class="connection-profile-actions">
              <button
                type="button"
                data-testid="profile-connect"
                disabled={busyProfile() !== undefined}
                onClick={() => void connect(profile)}
              >
                {message(busyProfile() === profile.id ? 'connectionProfiles.action.connecting' : 'connectionProfiles.action.connect')}
              </button>
              <Show when={custody()}>
                <button
                  type="button"
                  data-testid="profile-token-edit"
                  disabled={credentialBusy()}
                  onClick={() => {
                    setEditedToken('')
                    setTokenEditor(tokenEditor() === profile.id ? undefined : profile.id)
                  }}
                >
                  {message(hasCredential(profile.id) ? 'connectionProfiles.action.replaceToken' : 'connectionProfiles.action.setToken')}
                </button>
              </Show>
              <Show when={hasCredential(profile.id)}>
                <button
                  type="button"
                  data-testid="profile-token-clear"
                  disabled={credentialBusy()}
                  onClick={() => void clearToken(profile)}
                >
                  {message('connectionProfiles.action.clearToken')}
                </button>
              </Show>
              <button
                type="button"
                class="danger"
                data-testid="profile-remove"
                aria-label={message('connectionProfiles.action.removeAriaLabel', { name: profile.name })}
                disabled={credentialBusy()}
                onClick={() => void remove(profile)}
              >
                {message('connectionProfiles.action.remove')}
              </button>
            </div>
            <Show when={tokenEditor() === profile.id}>
              <form
                class="connection-profile-token-editor"
                onSubmit={(event) => { event.preventDefault(); void saveToken(profile) }}
              >
                <label>
                  {message('connectionProfiles.label.accessTokenFor', { name: profile.name })}
                  <input
                    data-testid="profile-token-editor-input"
                    type="password"
                    autocomplete="off"
                    value={editedToken()}
                    onInput={(event) => setEditedToken(event.currentTarget.value)}
                  />
                </label>
                <button data-testid="profile-token-save" type="submit" disabled={editedToken().trim() === '' || credentialBusy()}>
                  {message('connectionProfiles.action.saveToken')}
                </button>
              </form>
            </Show>
          </li>
        )}</For>
      </ul>
    </section>
  )
}
