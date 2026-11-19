/**
 * Projects: a named scope binding backend connections, open documents,
 * layout, and settings overrides. One project per window; windows sharing a
 * project share its SharedWorker tab authority, windows on different
 * projects are fully isolated.
 *
 * Two independent concerns live here:
 *
 * 1. The engine library owns the project registry. Legacy browser descriptors
 *    in `dinkster.projects` are registered idempotently on connection, and
 *    retired only after every valid descriptor has acknowledged.
 *
 * 2. The active-project SCOPE for this window: every piece of per-project
 *    persisted state (tabs, backends, settings, layout) and every
 *    cross-window rendezvous name (SharedWorker, BroadcastChannel, Web Lock)
 *    is namespaced through scopedStorageKey/scopedSharedName. The default
 *    project maps to the UNPREFIXED legacy names, so existing user state
 *    becomes the default project with no migration step.
 *
 * The scope is set once per page from the `dinksterProject` URL parameter
 * before AppState construction and never changes: switching projects
 * reloads the window.
 */

import type { DinksterConnection } from '@dinkster/client'

export const DEFAULT_PROJECT_ID = 'default'
export const PROJECTS_KEY = 'dinkster.projects'
export const PROJECT_URL_PARAM = 'dinksterProject'

export interface ProjectDescriptor {
  readonly id: string
  readonly name: string
  readonly createdAt: number
}

interface ProjectsEnvelope {
  readonly v: 1
  readonly projects: readonly ProjectDescriptor[]
  /** Display-name override for the synthesized default project. */
  readonly defaultName?: string
}

const DEFAULT_PROJECT_NAME = 'Default'

/** Created ids are `p-<random>`; 'default' is reserved for the synthesized default. */
export function validProjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
}

function readEnvelope(storage: Pick<Storage, 'getItem'> | undefined): ProjectsEnvelope {
  try {
    const parsed = JSON.parse(storage?.getItem(PROJECTS_KEY) ?? 'null') as Partial<ProjectsEnvelope> | null
    if (parsed?.v !== 1 || !Array.isArray(parsed.projects)) return { v: 1, projects: [] }
    return {
      v: 1,
      projects: parsed.projects.filter((p): p is ProjectDescriptor =>
        typeof p === 'object' && p !== null &&
        validProjectId((p as { id?: unknown }).id) && (p as { id: string }).id !== DEFAULT_PROJECT_ID &&
        typeof (p as { name?: unknown }).name === 'string' && (p as { name: string }).name.length > 0 &&
        Number.isFinite((p as { createdAt?: unknown }).createdAt)),
      ...(typeof parsed.defaultName === 'string' && parsed.defaultName.length > 0
        ? { defaultName: parsed.defaultName }
        : {}),
    }
  } catch {
    return { v: 1, projects: [] } // corrupt/unavailable storage never blocks startup
  }
}

/** Every project, default first. The default is synthesized, never stored. */
function legacyProjects(storage: Pick<Storage, 'getItem'> | undefined): readonly ProjectDescriptor[] {
  const envelope = readEnvelope(storage)
  return [
    { id: DEFAULT_PROJECT_ID, name: envelope.defaultName ?? DEFAULT_PROJECT_NAME, createdAt: 0 },
    ...envelope.projects,
  ]
}

/** Keep the browser registry intact until every idempotent registration acknowledges. */
export async function migrateBrowserProjects(
  connection: Pick<DinksterConnection, 'registerProject'>,
  storage: Pick<Storage, 'getItem' | 'removeItem'> | undefined = globalThis.localStorage,
  signal?: AbortSignal,
  stillCurrent: () => boolean = () => true,
): Promise<void> {
  const original = storage?.getItem(PROJECTS_KEY)
  if (original === undefined || original === null) return
  // Unreadable envelopes remain available for recovery instead of being retired.
  const parsed: unknown = JSON.parse(original)
  if (typeof parsed !== 'object' || parsed === null ||
    (parsed as Partial<ProjectsEnvelope>).v !== 1 || !Array.isArray((parsed as Partial<ProjectsEnvelope>).projects)) {
    throw new Error('Browser project list is unreadable')
  }
  const projects = legacyProjects(storage)
  const hasUnreadableProjects = projects.length - 1 !== (parsed as ProjectsEnvelope).projects.length
  for (const project of projects) {
    signal?.throwIfAborted()
    if (!stillCurrent()) throw new Error('Project connection changed during registration')
    await connection.registerProject(project.id, project.name, signal)
  }
  signal?.throwIfAborted()
  if (!stillCurrent()) throw new Error('Project connection changed during registration')
  if (hasUnreadableProjects) throw new Error('Some browser projects are unreadable. The original list was kept.')
  const remaining = storage?.getItem(PROJECTS_KEY)
  // Another window may have acknowledged and retired the same source already.
  if (remaining != null && remaining !== original) {
    throw new Error('Browser project list changed during registration. Reconnect to finish.')
  }
  storage?.removeItem(PROJECTS_KEY)
}

// ---------------------------------------------------------------------------
// Active-project scope for this window.
// ---------------------------------------------------------------------------

let activeProject = DEFAULT_PROJECT_ID

/**
 * Set once during bootstrap, before any AppState or SettingsRegistry
 * construction. An unknown or malformed id falls back to the default
 * project rather than stranding the window in an unreachable scope.
 */
export function initializeProjectScope(projectId: string | null | undefined): string {
  activeProject = validProjectId(projectId) ? projectId : DEFAULT_PROJECT_ID
  return activeProject
}

export function activeProjectId(): string {
  return activeProject
}

/** The project id carried by a window's URL, validated. */
export function projectIdFromSearch(search: string): string {
  const raw = new URLSearchParams(search).get(PROJECT_URL_PARAM)
  return validProjectId(raw) ? raw : DEFAULT_PROJECT_ID
}

/**
 * Project-scoped localStorage key. The default project uses the unprefixed
 * legacy key, so pre-project state needs no migration; other projects get
 * `dinkster.p.<id>.` in place of the `dinkster.` prefix.
 */
export function scopedStorageKey(baseKey: string): string {
  if (activeProject === DEFAULT_PROJECT_ID) return baseKey
  return baseKey.startsWith('dinkster.')
    ? `dinkster.p.${activeProject}.${baseKey.slice('dinkster.'.length)}`
    : `dinkster.p.${activeProject}.${baseKey}`
}

/**
 * Project-scoped cross-window rendezvous name (SharedWorker, BroadcastChannel,
 * Web Lock). Same default-project identity rule as scopedStorageKey.
 */
export function scopedSharedName(baseName: string): string {
  return activeProject === DEFAULT_PROJECT_ID ? baseName : `${baseName}--p-${activeProject}`
}
