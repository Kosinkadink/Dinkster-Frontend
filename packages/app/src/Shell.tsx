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

export const SHELL_FADE_MS = 260
const ENGINE_POLL_MS = 250

export interface ShellInstallation extends ProjectInstallation {
  /** Shown in the opening line; the root's folder name when absent. */
  readonly name?: string
}

/** The page's opening state, as the shell drives it. */
export interface ProjectOpening {
  readonly projectId: string
  readonly line: string
  /** The line's tooltip: why it opens elsewhere, or after a failure the engine's own detail. */
  readonly reason?: string
  /** The failed row's text, such as "Nightly did not start". */
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
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const nameOf = (installation: ShellInstallation): string =>
  installation.name ?? installation.root.split(/[\\/]/).filter(Boolean).pop() ?? installation.root
const sameInstallation = (a: ProjectInstallation | undefined, b: ProjectInstallation): boolean =>
  a?.root === b.root && a.engine === b.engine
const detailOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
/** Records that a project opened; a failure never touches the open. Survives leaving the page. */
const recordOpened = (projectId: string): void => {
  void fetch(`/api/projects/${encodeURIComponent(projectId)}/opened`, { method: 'POST', keepalive: true }).catch(() => undefined)
}

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
  let heldHost!: HTMLDivElement
  let coverElement!: HTMLDivElement
  let disposeEditor: (() => void) | undefined
  let openInstallation: ProjectInstallation | undefined = props.home.open
  let facts: Promise<ReadonlyMap<string, InstallationFrontend>> | undefined
  let attempt = 0
  let pageFade = 0
  let mounting: Promise<void> = Promise.resolve()

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
    const fade = ++pageFade
    if (shown) {
      setPageShown(true)
      await new Promise(requestAnimationFrame)
    }
    if (fade !== pageFade) return
    setPageOpaque(shown)
    await wait(reducedMotion() ? 0 : 200)
    if (fade === pageFade && !shown) setPageShown(false)
  }

  const cover = async (on: boolean): Promise<void> => {
    const duration = coverElement.style.clipPath ? 200 : SHELL_FADE_MS
    coverElement.style.setProperty('--app-shell-cover-fade', `${duration}ms`)
    setCovered(on)
    await wait(reducedMotion() ? 0 : duration)
    if (!on && !covered()) coverElement.style.clipPath = ''
  }

  /** On a switch the cover leaves the editor's top bar and icon bar out, so they stay on screen. */
  const shapeCoverAroundBars = (): void => {
    const origin = editorHost.getBoundingClientRect()
    const top = editorHost.querySelector('.dinkster-window-toolbar-host')?.getBoundingClientRect()
    const icons = editorHost.querySelector('nav.left-sidebar:not([hidden])')?.getBoundingClientRect()
    const below = top ? top.bottom - origin.top : 0
    const right = icons ? icons.right - origin.left : 0
    const bottom = icons ? icons.bottom - origin.top : below
    coverElement.style.clipPath = `polygon(0 ${bottom}px, ${right}px ${bottom}px, ${right}px ${below}px, 100% ${below}px, 100% 100%, 0 100%)`
  }

  /**
   * A still copy of the old editor over the swap; with the centre covered only its bars show.
   * One project scope per window rules out keeping the old editor running beside the new one.
   */
  const holdOldEditor = (): (() => void) => {
    const copy = editorHost.cloneNode(true) as HTMLElement
    for (const node of copy.querySelectorAll('[id]')) node.removeAttribute('id')
    copy.removeAttribute('data-testid')
    copy.setAttribute('inert', '')
    copy.setAttribute('aria-hidden', 'true')
    heldHost.replaceChildren(copy)
    return () => copy.remove()
  }

  /**
   * The new top bar names its project once the library answers. The arrival waits for that, a
   * second at most, so the name arrives with the icons rather than appearing on its own.
   */
  const projectNamed = async (run: number): Promise<void> => {
    const until = performance.now() + 1000
    while (run === attempt && editorHost.querySelector('.dinkster-project-name') === null && performance.now() < until) {
      await new Promise(requestAnimationFrame)
    }
  }

  /** Hides the new editor's arriving parts at once, before anything over it fades. */
  const hideForArrival = (scope: 'all' | 'centre'): void => {
    if (reducedMotion()) return
    editorHost.dataset['stageScope'] = scope
    editorHost.dataset['stage'] = 'hidden'
  }

  /** Brings the hidden parts in, in the mock's order, the canvas ``start`` ms from now. */
  const arrive = async (start: number, run: number): Promise<void> => {
    if (editorHost.dataset['stage'] !== 'hidden') return
    editorHost.style.setProperty('--app-shell-stage-start', `${start}ms`)
    // Commit the hidden state so the parts transition from it.
    editorHost.getBoundingClientRect()
    editorHost.dataset['stage'] = 'arrive'
    // The status bar is last: 160 ms after the canvas from the page, 200 ms on a switch.
    await wait(start + (editorHost.dataset['stageScope'] === 'all' ? 160 : 200) + 240)
    if (run !== attempt) return
    delete editorHost.dataset['stage']
    delete editorHost.dataset['stageScope']
  }

  /** Lifts the cover at once; the arriving parts take over the fade. */
  const uncoverAtOnce = (): void => {
    coverElement.style.transition = 'none'
    setCovered(false)
    coverElement.getBoundingClientRect()
    coverElement.style.transition = ''
    coverElement.style.clipPath = ''
  }

  const mount = async (projectId: string, run: number): Promise<void> => {
    // A project scope cannot overlap the editor still being built for an older open.
    await mounting.catch(() => undefined)
    if (run !== attempt || editorProject() === projectId) return
    mounting = (async () => {
      disposeEditor?.()
      disposeEditor = undefined
      setEditorProject(undefined)
      try {
        const dispose = await props.mountEditor(projectId, editorHost, navigation)
        if (run !== attempt) dispose()
        else {
          disposeEditor = dispose
          setEditorProject(projectId)
        }
      } catch (error) {
        editorHost.replaceChildren()
        throw error
      }
    })()
    await mounting
  }

  const failedOpening = (opening: ProjectOpening, installation: ShellInstallation, error: unknown): ProjectOpening => {
    const detail = detailOf(error)
    return { ...opening, ...(detail ? { reason: detail } : {}), failed: message('shell.opening.didNotStart', { installation: nameOf(installation) }) }
  }

  const openInstallationEngine = async (installation: ProjectInstallation): Promise<void> => {
    if (sameInstallation(openInstallation, installation)) return
    const answer = await postJson('/supervisor/engine', installation)
    if (answer.error !== undefined) throw new Error(answer.message ?? answer.error)
    openInstallation = installation
  }

  /** The page-load path: wait for the engine and the address, then leave on the frame colour. */
  const openElsewhere = async (projectId: string, installation: ShellInstallation, reason: 'older' | 'development', run: number): Promise<void> => {
    const name = nameOf(installation)
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
        if (status?.state === 'failed') throw new Error(status.detail ?? '')
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
      // That editor keeps its own settings; this keeps its loading colour the one on screen now.
      target.searchParams.set('dinksterTheme', document.documentElement.dataset['theme'] ?? 'dark')
      recordOpened(projectId)
      ;(props.navigate ?? ((url) => location.assign(url)))(target.href)
    } catch (error) {
      if (run === attempt) setOpening(failedOpening(base, installation, error))
    }
  }

  const openHere = async (projectId: string, installation: ShellInstallation | undefined, run: number): Promise<void> => {
    const replacing = editorProject() !== undefined && editorProject() !== projectId
    const starting = installation !== undefined && !sameInstallation(openInstallation, installation)
    const line = starting ? message('shell.opening.starting', { installation: nameOf(installation) }) : message('shell.opening.here')
    setOpening({ projectId, line })
    try {
      if (installation !== undefined) await openInstallationEngine(installation)
    } catch (error) {
      if (run === attempt && installation !== undefined) setOpening(failedOpening({ projectId, line }, installation, error))
      return
    }
    if (run !== attempt) return
    // From one editor straight to another, the frame colour covers the swap below the bars.
    const fromEditor = !pageShown()
    const switching = fromEditor && replacing
    let release: (() => void) | undefined
    if (switching) {
      shapeCoverAroundBars()
      await cover(true)
      if (run !== attempt) return
      release = holdOldEditor()
    }
    try {
      await mount(projectId, run)
      await projectNamed(run)
    } catch (error) {
      if (run !== attempt) return
      push({ kind: 'projects', newProject: false })
      setOpening({ projectId, line, reason: detailOf(error), failed: message('shell.opening.editorFailed') })
      if (!pageShown() || !pageOpaque()) await fadePage(true)
      await cover(false)
      return
    } finally {
      release?.()
    }
    if (run !== attempt) return
    push({ kind: 'editor', projectId })
    recordOpened(projectId)
    setOpening(undefined)
    if (switching) {
      hideForArrival('centre')
      uncoverAtOnce()
      await arrive(0, run)
    } else if (fromEditor) {
      await cover(false)
    } else {
      // The page's panels fade out while the editor's parts come in behind them, the canvas first.
      hideForArrival('all')
      await Promise.all([fadePage(false), arrive(100, run)])
    }
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
      if (covered()) void cover(false)
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
      if (covered()) void cover(false)
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
      attempt += 1
      pageFade += 1
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
      <div class="app-shell-held" ref={heldHost} data-testid="app-shell-held" />
      <Show when={pageShown()}>
        <div class="app-shell-layer app-shell-page" classList={{ 'app-shell-faded': !pageOpaque() }} data-testid="app-shell-page">
          {props.page({ shell: navigation })}
        </div>
      </Show>
      <div class="app-shell-cover" ref={coverElement} classList={{ 'app-shell-covered': covered() }} data-testid="app-shell-cover" />
    </div>
  )
}
