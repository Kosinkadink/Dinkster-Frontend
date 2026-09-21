/**
 * Saved connection profiles: named remote Dinkster addresses that survive
 * across sessions independently of the live backend list. A profile holds
 * only non-secret fields (name, URL); on desktop, an access token can be
 * attached through the desktop bridge, which keeps it OS-keychain-encrypted
 * in the main process and injects it per-origin - the renderer and this
 * envelope never see the secret.
 *
 * Profiles are project-scoped (read through scopedStorageKey at call time),
 * matching the backend list they feed.
 */

import { canonicalBackendUrl } from './app-state.js'
import { scopedSharedName, scopedStorageKey } from './projects.js'

export const CONNECTION_PROFILES_KEY = 'dinkster.connectionProfiles'

export interface ConnectionProfile {
  readonly id: string
  readonly name: string
  /** Canonical absolute http(s) base URL of the remote server. */
  readonly url: string
  readonly createdAt: number
}

interface ProfilesEnvelope {
  readonly v: 1
  readonly profiles: readonly ConnectionProfile[]
}

/** Created ids are `cp-<random>`; the shape is also enforced by desktop main. */
export function validConnectionProfileId(value: unknown): value is string {
  return typeof value === 'string' && /^cp-[a-z0-9-]{1,64}$/.test(value)
}

/** A profile address must be an absolute http(s) URL without credentials. */
export function validProfileUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.username === '' && parsed.password === ''
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function readEnvelope(storage: StorageLike | undefined): ProfilesEnvelope {
  try {
    const parsed = JSON.parse(storage?.getItem(scopedStorageKey(CONNECTION_PROFILES_KEY)) ?? 'null') as
      | Partial<ProfilesEnvelope>
      | null
    if (parsed?.v !== 1 || !Array.isArray(parsed.profiles)) return { v: 1, profiles: [] }
    return {
      v: 1,
      profiles: parsed.profiles.filter((p): p is ConnectionProfile =>
        typeof p === 'object' && p !== null &&
        validConnectionProfileId((p as { id?: unknown }).id) &&
        typeof (p as { name?: unknown }).name === 'string' && (p as { name: string }).name.length > 0 &&
        typeof (p as { url?: unknown }).url === 'string' && validProfileUrl((p as { url: string }).url) &&
        Number.isFinite((p as { createdAt?: unknown }).createdAt)),
    }
  } catch {
    return { v: 1, profiles: [] } // corrupt/unavailable storage never blocks the panel
  }
}

/**
 * Whether the envelope was durably written. Full or private-mode storage
 * must read as failure: a profile that only appears saved would vanish on
 * refresh while any credential attached to it stayed active.
 */
function writeEnvelope(envelope: ProfilesEnvelope, storage: StorageLike | undefined): boolean {
  if (!storage) return false
  try {
    storage.setItem(scopedStorageKey(CONNECTION_PROFILES_KEY), JSON.stringify(envelope))
    return true
  } catch {
    return false
  }
}

export function listConnectionProfiles(
  storage: StorageLike | undefined = globalThis.localStorage,
): readonly ConnectionProfile[] {
  return readEnvelope(storage).profiles
}

/**
 * Save a profile. Returns undefined (and saves nothing) when the URL is not
 * an absolute credential-free http(s) address, or when the profile could
 * not be durably written. Callers must not attach a credential to a
 * profile this function did not return.
 */
export function createConnectionProfile(
  name: string,
  url: string,
  storage: StorageLike | undefined = globalThis.localStorage,
): ConnectionProfile | undefined {
  const canonical = canonicalBackendUrl(url)
  if (!validProfileUrl(canonical)) return undefined
  const trimmed = name.trim()
  const profile: ConnectionProfile = {
    id: `cp-${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.floor(Math.random() * 1e9)}`).replaceAll(/[^a-z0-9-]/gi, '').toLowerCase()}`,
    name: trimmed.length > 0 ? trimmed : canonical,
    url: canonical,
    createdAt: Date.now(),
  }
  const envelope = readEnvelope(storage)
  if (!writeEnvelope({ ...envelope, profiles: [...envelope.profiles, profile] }, storage)) return undefined
  return profile
}

/**
 * Run a connection-profile/credential mutation while holding a Web Lock
 * shared by every window of the same project. Per-window busy flags cannot
 * stop one window from saving a token while another removes the same
 * profile; the lock serializes the mutations, and callers re-check profile
 * existence inside the locked section before attaching a credential. Where
 * Web Locks are unavailable (some test DOMs), the task runs unserialized,
 * which is safe for a single window.
 */
export function withConnectionProfilesLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks
  if (!locks) return task()
  return locks.request(scopedSharedName('dinkster.connectionProfiles.mutation'), task) as Promise<T>
}

/** Whether the removal was durably written. */
export function removeConnectionProfile(
  id: string,
  storage: StorageLike | undefined = globalThis.localStorage,
): boolean {
  const envelope = readEnvelope(storage)
  return writeEnvelope({ ...envelope, profiles: envelope.profiles.filter((p) => p.id !== id) }, storage)
}

/**
 * Format a shareable dinkster:// link for a saved workflow. The grammar is
 * parsed by the Desktop shell: identifiers only, never credentials. The
 * project parameter is omitted for the default
 * project; the backend parameter is omitted for the same-origin default
 * backend (empty canonical base URL), which the opener resolves to its own
 * library backend.
 */
export function formatWorkflowDeepLink(link: {
  readonly projectId: string
  readonly workflowId: string
  readonly backendUrl?: string
}): string {
  const params = new URLSearchParams({ workflow: link.workflowId })
  if (link.projectId !== 'default') params.set('project', link.projectId)
  if (link.backendUrl !== undefined && link.backendUrl !== '') params.set('backend', link.backendUrl)
  return `dinkster://open/workflow?${params.toString()}`
}

/**
 * The connected backend a deep link's backend URL names, by canonical-URL
 * identity. A link without a backend URL resolves to nothing here; the
 * caller falls back to its library backend. A link naming a backend that is
 * not connected also resolves to nothing - deep links never auto-connect a
 * server, so following a link can never send requests to an address the
 * user did not add themselves.
 */
export function resolveDeepLinkBackend(
  backends: readonly { readonly id: string; readonly baseUrl: string }[],
  backendUrl: string,
): string | undefined {
  const canonical = canonicalBackendUrl(backendUrl)
  return backends.find((backend) => canonicalBackendUrl(backend.baseUrl) === canonical)?.id
}
