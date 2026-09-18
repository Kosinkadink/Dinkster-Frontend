/**
 * App-side collaboration plumbing: the per-tab actor identity and
 * the transport seam AppState uses to create, discover, join, and end shared
 * sessions (docs/collaboration.md; promises.md "Shared (multiplayer)
 * DocumentSession").
 *
 * The seam exists for the same reason the core session takes a
 * CollabConnection: AppState's share/join/leave logic is tab lifecycle, not
 * HTTP, so tests drive it with an in-memory transport while the app default
 * wraps the real @dinkster/client HTTP/WS adapter.
 */
import {
  CollabHttpConnection,
  closeCollabSession,
  createCollabSession,
  getCollabSession,
  listCollabSessions,
} from '@dinkster/client'
import {
  createWorkflowDocumentTypeAdapter,
  DocumentTypeRegistry,
  imageDocumentTypeAdapter,
  isValidActorId,
  legacyCollabDocumentKind,
  type CollabConnection,
  type CollabDocumentKind,
  type CollabSessionDescriptor,
  type DocumentTypeAdapter,
  type WorkflowDocument,
} from '@dinkster/core'

export function createCollabDocumentTypes(
  workflow: DocumentTypeAdapter<WorkflowDocument> = createWorkflowDocumentTypeAdapter(),
): DocumentTypeRegistry {
  return new DocumentTypeRegistry().register(workflow).register(imageDocumentTypeAdapter)
}

/**
 * Discovery scope for app-created shared sessions. Deliberately NOT the
 * backend's reserved single-user scope 'local' (backend contract, thread
 * T-019f9e5d-d2e8-7173-8d6b-88a91bf66880): multiplayer discovery gets its
 * own namespace so single-user machinery can never surface in the join list.
 */
export const COLLAB_SCOPE = 'shared'

export const COLLAB_ACTOR_ID_KEY = 'dinkster.collab.actorId'

/** Storage access can itself throw (storage-blocked); never let it. */
const safeStorage = (): Pick<Storage, 'getItem' | 'setItem'> | undefined => {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}

const mintActorId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `a${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffffff).toString(36)}`

/**
 * The tab's collab identity is retained across reloads in session storage.
 * The joint actorId pin ([A-Za-z0-9_-]+, never
 * '__proto__'; core isValidActorId) is re-checked on every load - a stored
 * value that violates it (hand-edited storage, an older buggy build) is
 * REPLACED, never sent: the backend would 400 every op it touched.
 */
export function stableActorId(storage = safeStorage()): string {
  try {
    const saved = storage?.getItem(COLLAB_ACTOR_ID_KEY)
    if (saved !== null && saved !== undefined && isValidActorId(saved)) return saved
  } catch {
    // Unreadable storage: fall through to a session-only identity.
  }
  const minted = mintActorId()
  try {
    storage?.setItem(COLLAB_ACTOR_ID_KEY, minted)
  } catch {
    // Unwritable storage: the id lives for this session only.
  }
  return minted
}

/** Session-surface operations AppState needs; baseUrl comes from the backend entry. */
export interface CollabTransport {
  bindActor?(baseUrl: string, sessionId: string, actorId: string): Promise<string>
  create(
    baseUrl: string,
    args: {
      readonly scope: string
      readonly documentId: string
      readonly snapshot: unknown
      readonly documentKind?: CollabDocumentKind
    },
  ): Promise<CollabSessionDescriptor>
  list(baseUrl: string, scope: string): Promise<readonly CollabSessionDescriptor[]>
  get(baseUrl: string, sessionId: string): Promise<CollabSessionDescriptor | undefined>
  /** DELETE the session for every participant. */
  end(baseUrl: string, sessionId: string): Promise<void>
  connect(config: { readonly baseUrl: string; readonly sessionId: string; readonly actorId: string }): CollabConnection
}

/** The production transport: the @dinkster/client HTTP + WS adapter. */
export const httpCollabTransport: CollabTransport = {
  bindActor: bindBrowserActor,
  create: (baseUrl, args) => createCollabSession(baseUrl, args),
  list: (baseUrl, scope) => listCollabSessions(baseUrl, scope),
  get: (baseUrl, sessionId) => getCollabSession(baseUrl, sessionId),
  end: (baseUrl, sessionId) => closeCollabSession(baseUrl, sessionId),
  connect: (config) => new CollabHttpConnection(config),
}

/** Bind before allocating document ids; a collision gets one fresh identity. */
export async function bindBrowserActor(baseUrl: string, sessionId: string, actorId: string, fetchFn: typeof fetch = fetch): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchFn(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/actors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actorId }),
    })
    if (response.ok) return actorId
    const body = await response.json().catch(() => null) as { error?: string } | null
    if (attempt === 0 && response.status === 409 && body?.error === 'actor-principal-mismatch') {
      actorId = mintActorId()
      try { safeStorage()?.setItem(COLLAB_ACTOR_ID_KEY, actorId) } catch { /* Session-only identity. */ }
      continue
    }
    throw new Error(`Actor binding: HTTP ${response.status}: ${body?.error ?? 'refused'}`)
  }
  throw new Error('Actor binding refused')
}
