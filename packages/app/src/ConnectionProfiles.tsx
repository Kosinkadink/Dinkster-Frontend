import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { MessageParams } from '@dinkster/core'
import {
  CONNECTION_PROFILES_KEY, createConnectionProfile, listConnectionProfiles,
  removeConnectionProfile, validProfileUrl, withConnectionProfilesLock, type ConnectionProfile,
} from './connection-profiles.js'
import { canonicalBackendUrl } from './app-state.js'
import { desktopBridge, type DesktopConnectionCredentials } from './desktop-bridge.js'
import { useAppMessage } from './locale.js'
import { ProductButton } from '@dinkster/ui'
import { ProductTextInput } from './ProductControls.js'
import { ProductActionFooter } from './ProductForm.js'
import { scopedStorageKey } from './projects.js'

/** Profile identities stay intact because desktop credentials are keyed by profile id. */
export function createConnectionProfiles() {
  const bridge = desktopBridge()
  const message = useAppMessage()
  const [profiles, setProfiles] = createSignal<readonly ConnectionProfile[]>(listConnectionProfiles())
  const [credentials, setCredentials] = createSignal<DesktopConnectionCredentials>({ custody: false, profiles: [] })
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<{ key: string; params?: MessageParams }>({ key: '' })
  const refreshCredentials = async () => {
    if (bridge) setCredentials(await bridge.connectionCredentials())
  }
  const refresh = () => {
    setProfiles(listConnectionProfiles())
    globalThis.dispatchEvent?.(new Event('connection-profiles-changed'))
  }
  onMount(() => {
    void refreshCredentials().catch(() => {})
    const storageKey = scopedStorageKey(CONNECTION_PROFILES_KEY)
    const onChanged = () => { setProfiles(listConnectionProfiles()); void refreshCredentials().catch(() => {}) }
    const onStorage = (event: StorageEvent) => { if (event.key === storageKey) onChanged() }
    globalThis.addEventListener?.('storage', onStorage)
    globalThis.addEventListener?.('connection-profiles-changed', onChanged)
    onCleanup(() => {
      globalThis.removeEventListener?.('storage', onStorage)
      globalThis.removeEventListener?.('connection-profiles-changed', onChanged)
    })
  })
  const mutate = async (action: () => Promise<boolean>): Promise<boolean> => {
    if (busy()) return false
    setBusy(true)
    setError({ key: '' })
    try { return await withConnectionProfilesLock(action) }
    finally { setBusy(false) }
  }
  const matching = (url: string) => profiles().filter((profile) => canonicalBackendUrl(profile.url) === canonicalBackendUrl(url))
  const saveToken = (url: string, name: string, secret: string, profileId?: string): Promise<boolean> => mutate(async () => {
    if (!bridge || !credentials().custody) return false
    let profile = profileId ? listConnectionProfiles().find((profile) => profile.id === profileId) : undefined
    if (profileId && !profile) {
      setError({ key: 'connectionProfiles.error.removedElsewhere', params: { name } })
      refresh()
      return false
    }
    if (!profile) {
      profile = createConnectionProfile(name, url)
      if (!profile) { setError({ key: validProfileUrl(url) ? 'connectionProfiles.error.storage' : 'connectionProfiles.error.address' }); return false }
      refresh()
    }
    try { await bridge.setConnectionCredential(profile.id, profile.url, secret) }
    catch (cause) {
      setError({ key: 'connectionProfiles.error.saveToken', params: { error: cause instanceof Error ? cause.message : String(cause) } })
      return false
    }
    await refreshCredentials().catch(() => {})
    return true
  })
  const clearToken = (profile: ConnectionProfile): Promise<boolean> => mutate(async () => {
    if (!bridge) return false
    try { await bridge.setConnectionCredential(profile.id, undefined, null) }
    catch (cause) {
      setError({ key: 'connectionProfiles.error.clearToken', params: { error: cause instanceof Error ? cause.message : String(cause) } })
      return false
    }
    await refreshCredentials().catch(() => {})
    return true
  })
  const remove = (url: string): Promise<boolean> => mutate(async () => {
    // Read under the cross-window lock and retire every duplicate profile before
    // forgetting any address. A failed retirement leaves its profile reachable.
    for (const profile of listConnectionProfiles().filter((profile) => canonicalBackendUrl(profile.url) === canonicalBackendUrl(url))) {
      if (bridge) {
        try { await bridge.retireConnectionProfile(profile.id) }
        catch (cause) {
          setError({ key: 'connectionProfiles.error.removeToken', params: { name: profile.name, error: cause instanceof Error ? cause.message : String(cause) } })
          refresh()
          return false
        }
      }
      if (!removeConnectionProfile(profile.id)) {
        setError({ key: 'connectionProfiles.error.removeStorage', params: { name: profile.name } })
        refresh()
        return false
      }
    }
    refresh()
    await refreshCredentials().catch(() => {})
    return true
  })
  return {
    profiles, matching, busy, saveToken, clearToken, remove,
    custody: () => credentials().custody,
    hasCredential: (id: string) => credentials().profiles.includes(id),
    error: () => error().key ? message(error().key, error().params) : '',
    dismissError: () => setError({ key: '' }),
  }
}

export function ConnectionCredentialControls(props: {
  readonly connections: ReturnType<typeof createConnectionProfiles>
  readonly url: string
  readonly name: string
}) {
  const message = useAppMessage()
  const [editing, setEditing] = createSignal<string>()
  const [token, setToken] = createSignal('')
  const profiles = () => props.connections.matching(props.url)
  const save = async (profileId?: string) => {
    if (await props.connections.saveToken(props.url, props.name, token().trim(), profileId)) {
      setToken('')
      setEditing(undefined)
    }
  }
  const editButton = (profile?: ConnectionProfile) => <ProductButton data-testid="profile-token-edit" disabled={props.connections.busy()}
    onClick={() => { setToken(''); setEditing(editing() === (profile?.id ?? '') ? undefined : profile?.id ?? '') }}>
    {message(profile && props.connections.hasCredential(profile.id) ? 'connectionProfiles.action.replaceToken' : 'connectionProfiles.action.setToken')}
  </ProductButton>
  return <>
    <For each={profiles()}>{(profile) => <div data-profile={profile.id}>
      <Show when={props.connections.hasCredential(profile.id)}><span class="backend-badge" data-testid="profile-credential-badge">{message('connectionProfiles.badge.tokenInKeychain')}</span></Show>
      <Show when={props.connections.custody()}><ProductActionFooter>
        {editButton(profile)}
        <Show when={props.connections.hasCredential(profile.id)}><ProductButton intent="remove" data-testid="profile-token-clear" disabled={props.connections.busy()} onClick={() => { void props.connections.clearToken(profile) }}>{message('connectionProfiles.action.clearToken')}</ProductButton></Show>
      </ProductActionFooter></Show>
    </div>}</For>
    <Show when={profiles().length === 0 && props.connections.custody()}>{editButton()}</Show>
    <Show when={editing() !== undefined}><form class="connection-profile-token-editor" onSubmit={(event) => { event.preventDefault(); void save(editing() || undefined) }}>
      <label>{message('connectionProfiles.label.accessTokenFor', { name: props.name })}
        <ProductTextInput data-testid="profile-token-editor-input" type="password" autocomplete="off" value={token()} onInput={(event) => setToken(event.currentTarget.value)} />
      </label>
      <ProductButton data-testid="profile-token-save" type="submit" fill="solid" disabled={!token().trim() || props.connections.busy()}>{message('connectionProfiles.action.saveToken')}</ProductButton>
    </form></Show>
  </>
}
