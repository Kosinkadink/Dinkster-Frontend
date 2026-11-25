/**
 * Where the one app stands under the always-on process: the projects page or
 * one project's editor, and how a project opens.
 *
 * A project opens in this app (a fade, no page load) only when its
 * installation's engine speaks the schema wire version this build speaks and
 * the installation has not chosen a frontend of its own. Otherwise the
 * installation's own frontend opens at the process's installation frontend
 * address with a page load. The check uses the wire version this code speaks,
 * never a declared range.
 */
import { DINKSTER_SCHEMA_WIRE_VERSION } from '@dinkster/core'
import { PROJECT_URL_PARAM, validProjectId } from './projects.js'

export type ShellView =
  | { readonly kind: 'projects'; readonly newProject: boolean }
  | { readonly kind: 'editor'; readonly projectId: string }

export interface InstallationFrontend {
  /** The schema wire version the installation's engine speaks; null when unknown. */
  readonly wire: number | null
  /** How it chose a frontend of its own (folder, dev, git, version), or null. */
  readonly selected: string | null
  /** Whether it has a frontend the installation frontend address can serve. */
  readonly available: boolean
}

export interface ProjectInstallation {
  readonly root: string
  readonly engine: string
}

/** The always-on process's status fields the shell reads. */
export interface HomeStatus {
  readonly role: 'home'
  readonly state: string
  readonly detail?: string
  readonly installationFrontend?: string
  readonly open?: ProjectInstallation
}

export type OpenPath =
  | { readonly kind: 'here' }
  | { readonly kind: 'own'; readonly reason: 'older' | 'development' }
  | { readonly kind: 'unavailable' }

const NEW_PROJECT_PARAM = 'newProject'

export function viewFromUrl(url: URL): ShellView {
  const project = url.searchParams.get(PROJECT_URL_PARAM)
  if (project !== null && validProjectId(project)) return { kind: 'editor', projectId: project }
  return { kind: 'projects', newProject: url.searchParams.has(NEW_PROJECT_PARAM) }
}

/** The address of a view, keeping the current address's other parameters. */
export function urlForView(current: URL, view: ShellView): URL {
  const url = new URL(current.href)
  url.searchParams.delete(PROJECT_URL_PARAM)
  url.searchParams.delete(NEW_PROJECT_PARAM)
  if (view.kind === 'editor') url.searchParams.set(PROJECT_URL_PARAM, view.projectId)
  else if (view.newProject) url.searchParams.set(NEW_PROJECT_PARAM, '')
  return url
}

/** How a project on an installation with these facts opens from this build. */
export function openPath(
  facts: InstallationFrontend | undefined,
  wire: number = DINKSTER_SCHEMA_WIRE_VERSION,
): OpenPath {
  // An installation the process cannot describe opens here; its engine says the rest.
  if (facts === undefined) return { kind: 'here' }
  if (facts.selected === null && facts.wire === wire) return { kind: 'here' }
  if (!facts.available) return { kind: 'unavailable' }
  return { kind: 'own', reason: facts.selected === null ? 'older' : 'development' }
}

/** The status of the always-on process serving this page, or undefined when none does. */
export async function readHomeStatus(): Promise<HomeStatus | undefined> {
  try {
    const response = await fetch('/supervisor/status', { cache: 'no-store' })
    if (!response.ok) return undefined
    const status = (await response.json()) as { role?: unknown }
    return status.role === 'home' ? (status as HomeStatus) : undefined
  } catch {
    return undefined
  }
}

export async function readInstallationFrontends(): Promise<ReadonlyMap<string, InstallationFrontend>> {
  const response = await fetch('/supervisor/installations', { cache: 'no-store' })
  if (!response.ok) throw new Error(`installations: HTTP ${response.status}`)
  const body = (await response.json()) as {
    installations: readonly { root: string; frontend: InstallationFrontend }[]
  }
  return new Map(body.installations.map((row) => [row.root, row.frontend]))
}
