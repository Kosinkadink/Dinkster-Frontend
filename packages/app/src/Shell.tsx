/**
 * The one app under the always-on process: the projects page and one
 * project's editor in the same document.
 *
 * Opening a project mounts its editor under the page and fades the page out;
 * "All projects" fades the page back in over the editor, which keeps running.
 * Both views draw the same frame (logo, icon bar, account, Settings) in the
 * same place, so the frame does not visibly change during a fade. Switching
 * from one editor to another covers the screen with the frame colour while
 * the editor is replaced.
 *
 * A project whose installation needs its own frontend shows the page's
 * opening state while its engine starts, then the screen fades to the frame
 * colour and the browser loads that frontend at the installation frontend
 * address, which starts on the same colour (index.html) and fades its first
 * frame in.
 */
import { createSignal, onCleanup, onMount, Show, type Accessor, type JSX } from 'solid-js'
import { activeProjectId } from './projects.js'
import {
  openPath,
  readHomeStatus,
  readInstallationFrontends,
  urlForView,
  viewFromUrl,
  type HomeStatus,
  type InstallationFrontend,
  type ProjectInstallation,
  type ShellView,
} from './shell-route.js'
import { useAppMessage } from './locale.js'

export const SHELL_FADE_MS = 150
const ENGINE_POLL_MS = 250

export interface ShellInstallation extends ProjectInstallation {
  /** Shown in the opening line; the root's folder name when absent. */
  readonly name?: string
}

/** The page's opening state, as the shell drives it. */
export interface ProjectOpening {
  readonly projectId: string
  readonly line: string
  /** Why it opens elsewhere; the line's tooltip. */
  readonly reason?: string
  readonly failed?: string
}

export interface ShellNavigation {
  readonly view: Accessor<ShellView>
  readonly opening: Accessor<ProjectOpening | undefined>
  /** The project the page shows selected: the open or opening one. */
  readonly selectedProjectId: Accessor<string | undefined>
  /** Without an installation, the project opens on the installation that is open. */
  openProject(projectId: string, installation?: ShellInstallation): void
  showProjects(options?: { readonly newProject?: boolean }): void
  cancelOpening(): void
}

export type ProjectsPageComponent = (props: { readonly shell: ShellNavigation }) => JSX.Element

/** The projects page this build shows under the always-on process; without one, every address opens the editor. */
export const projectsPage: ProjectsPageComponent | undefined = undefined

/** Mounts one project's editor into ``host``; resolves once it has drawn, with its disposer. */
export type MountEditor = (projectId: string, host: HTMLElement, shell: ShellNavigation) => Promise<() => void>

const reducedMotion = (): boolean => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
const fadeTime = (): number => (reducedMotion() ? 0 : SHELL_FADE_MS)
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function postJson(path: string, body: unknown): Promise<HomeStatus & { message?: string; error?: string }> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return (await response.json()) as HomeStatus & { message?: string; error?: string }
}

export function Shell(props: {
  readonly home: HomeStatus
  readonly page: ProjectsPageComponent
  readonly mountEditor: MountEditor
  /** Leaves this page for another address; a stand-in in tests. */
  readonly navigate?: (url: string) => void
}): JSX.Element {
  const message = useAppMessage()
  const [view, setView] = createSignal<ShellView>(viewFromUrl(new URL(location.href)))
  const [pageShown, setPageShown] = createSignal(view().kind === 'projects')
  const [pageOpaque, setPageOpaque] = createSignal(view().kind === 'projects')
  const [covered, setCovered] = createSignal(false)
  const [opening, setOpening] = createSignal<ProjectOpening>()
  const [editorProject, setEditorProject] = createSignal<string>()
  let editorHost!: HTMLDivElement
  let disposeEditor: (() => void) | undefined
  let openInstallation: ProjectInstallation | undefined = props.home.open
  let facts: Promise<ReadonlyMap<string, InstallationFrontend>> | undefined
  let attempt = 0

  const factsFor = async (root: string | undefined): Promise<InstallationFrontend | undefined> => {
    if (root === undefined) return undefined
    facts ??= readInstallationFrontends().catch(() => new Map())
    return (await facts).get(root)
  }

  const push = (next: ShellView): void => {
    setView(next)
    const url = urlForView(new URL(location.href), next)
    if (url.href !== location.href) history.pushState(null, '', url)
  }

  const fadePage = async (shown: boolean): Promise<void> => {
    if (shown) {
      setPageShown(true)
      await new Promise(requestAnimationFrame)
    }
    setPageOpaque(shown)
    await wait(fadeTime())
    if (!shown) setPageShown(false)
  }

  const cover = async (on: boolean): Promise<void> => {
    setCovered(on)
    await wait(fadeTime())
  }

  const mount = async (projectId: string): Promise<void> => {
    if (editorProject() === projectId) return
    disposeEditor?.()
    disposeEditor = undefined
    setEditorProject(projectId)
    disposeEditor = await props.mountEditor(projectId, editorHost, navigation)
  }

  const openInstallationEngine = async (installation: ProjectInstallation): Promise<void> => {
    if (openInstallation?.root === installation.root && openInstallation.engine === installation.engine) return
    const answer = await postJson('/supervisor/engine', installation)
    if (answer.error !== undefined) throw new Error(answer.message ?? answer.error)
    openInstallation = installation
  }

  /** The page-load path: wait for the engine and the address, then leave on the frame colour. */
  const openElsewhere = async (projectId: string, installation: ShellInstallation, reason: 'older' | 'development', run: number): Promise<void> => {
    const name = installation.name ?? installation.root.split(/[\\/]/).filter(Boolean).pop() ?? installation.root
    const base = {
      projectId,
      line: message('shell.opening.ownEditor', { installation: name }),
      reason: message(reason === 'older' ? 'shell.opening.reason.older' : 'shell.opening.reason.development'),
    }
    setOpening(base)
    push({ kind: 'projects', newProject: false })
    if (!pageShown() || !pageOpaque()) await fadePage(true)
    try {
      await openInstallationEngine(installation)
      let status: HomeStatus | undefined
      while (run === attempt) {
        status = await readHomeStatus()
        if (status?.state === 'failed') throw new Error(status.detail || message('shell.opening.failed'))
        if (status?.state === 'ready' && status.installationFrontend !== undefined) {
          // Any answer will do; a page of another origin is opaque here.
          const answered = await fetch(status.installationFrontend + '/', { mode: 'no-cors', cache: 'no-store' }).then(() => true, () => false)
          if (answered) break
        }
        await wait(ENGINE_POLL_MS)
      }
      if (run !== attempt || status?.installationFrontend === undefined) return
      await cover(true)
      if (run !== attempt) return void cover(false)
      const target = urlForView(new URL(status.installationFrontend + '/'), { kind: 'editor', projectId })
      ;(props.navigate ?? ((url) => location.assign(url)))(target.href)
    } catch (error) {
      if (run === attempt) setOpening({ ...base, failed: error instanceof Error ? error.message : String(error) })
    }
  }

  const openHere = async (projectId: string, installation: ProjectInstallation | undefined, run: number): Promise<void> => {
    const replacing = editorProject() !== undefined && editorProject() !== projectId
    setOpening({ projectId, line: message('shell.opening.here') })
    try {
      if (installation !== undefined) await openInstallationEngine(installation)
    } catch (error) {
      if (run === attempt) setOpening({ projectId, line: message('shell.opening.here'), failed: error instanceof Error ? error.message : String(error) })
      return
    }
    if (run !== attempt) return
    // From one editor straight to another, the frame colour covers the swap.
    const fromEditor = !pageShown()
    if (fromEditor && replacing) await cover(true)
    await mount(projectId)
    if (run !== attempt) return
    push({ kind: 'editor', projectId })
    setOpening(undefined)
    if (fromEditor) await cover(false)
    else await fadePage(false)
  }

  const open = async (projectId: string, installation?: ShellInstallation): Promise<void> => {
    const run = ++attempt
    const path = openPath(await factsFor((installation ?? openInstallation)?.root))
    if (run !== attempt) return
    const target = installation ?? openInstallation
    if (path.kind === 'own' && target !== undefined) return openElsewhere(projectId, { ...target, ...installation }, path.reason, run)
    if (path.kind === 'unavailable') {
      push({ kind: 'projects', newProject: false })
      if (!pageShown() || !pageOpaque()) await fadePage(true)
      setOpening({ projectId, line: message('shell.opening.here'), failed: message('shell.opening.unavailable') })
      return
    }
    return openHere(projectId, installation, run)
  }

  const navigation: ShellNavigation = {
    view,
    opening,
    selectedProjectId: () => opening()?.projectId ?? editorProject() ?? (view().kind === 'editor' ? activeProjectId() : undefined),
    openProject: (projectId, installation) => void open(projectId, installation),
    showProjects: (options) => {
      attempt += 1
      setOpening(undefined)
      push({ kind: 'projects', newProject: options?.newProject === true })
      if (!pageShown() || !pageOpaque()) void fadePage(true)
    },
    cancelOpening: () => {
      attempt += 1
      setOpening(undefined)
      void cover(false)
    },
  }

  const follow = (): void => {
    const next = viewFromUrl(new URL(location.href))
    if (next.kind === 'editor') void open(next.projectId)
    else {
      attempt += 1
      setOpening(undefined)
      setView(next)
      if (!pageShown() || !pageOpaque()) void fadePage(true)
    }
  }

  onMount(() => {
    window.addEventListener('popstate', follow)
    // The page restored from the back-forward cache after leaving on the frame colour.
    const restored = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      attempt += 1
      setOpening(undefined)
      void cover(false)
    }
    window.addEventListener('pageshow', restored)
    onCleanup(() => {
      window.removeEventListener('popstate', follow)
      window.removeEventListener('pageshow', restored)
      disposeEditor?.()
    })
    const initial = view()
    if (initial.kind === 'editor') void open(initial.projectId)
  })

  return (
    <div class="app-shell" data-testid="app-shell" data-view={view().kind}>
      <div class="app-shell-layer" ref={editorHost} data-testid="app-shell-editor" />
      <Show when={pageShown()}>
        <div class="app-shell-layer app-shell-page" classList={{ 'app-shell-faded': !pageOpaque() }} data-testid="app-shell-page">
          {props.page({ shell: navigation })}
        </div>
      </Show>
      <div class="app-shell-cover" classList={{ 'app-shell-covered': covered() }} data-testid="app-shell-cover" />
    </div>
  )
}
