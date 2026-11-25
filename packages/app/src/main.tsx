import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { syntheticWorkflow } from '@dinkster/core'
import { App } from './App.js'
import { projectsPage, Shell, type ShellNavigation } from './Shell.js'
import { readHomeStatus } from './shell-route.js'
import { AppState } from './app-state.js'
import { createBootIndicatorElement, startBootIndicator } from './boot-indicator.js'
import { DesktopSetup } from './DesktopSetup.js'
import { desktopBridge, type DesktopLifecycleStatus } from './desktop-bridge.js'
import { bindLocale, bindPersistedLocale } from './locale.js'
import { bindTheme, bindPersistedTheme } from './theme.js'
import { initializeProjectScope, projectIdFromSearch } from './projects.js'
import type { CanvasTestHandles } from './test-bridge.js'
import './fonts.css'
import './styles.css'

// The project scope namespaces every per-project storage key and shared
// worker/channel/lock name. It must be fixed before AppState (or anything
// that touches storage) constructs. Under the always-on process the shell
// sets it again before each editor it mounts.
initializeProjectScope(projectIdFromSearch(globalThis.location?.search ?? ''))
const disposeBootTheme = bindPersistedTheme()

// Show a minimal centered indicator while fonts and desktop setup load.
// It appears only after 150ms (no flash on a fast boot), names what it is
// waiting on after 3s, and is removed the
// moment the real app renders. See docs/shell.md "Boot indicator".
const root = document.getElementById('root')!
// The page starts on the frame colour (index.html); the first drawn content fades in.
const revealRoot = (): void => {
  requestAnimationFrame(() => root.classList.add('root-shown'))
}
let bootEl: HTMLElement | undefined
const hideBoot = startBootIndicator({
  onShow: () => {
    bootEl = createBootIndicatorElement().el
    root.appendChild(bootEl)
    revealRoot()
  },
  onShowMessage: () => {
    const waiting = bootEl?.querySelector<HTMLElement>('.boot-indicator-waiting')
    if (waiting) waiting.hidden = false
  },
  onHide: () => {
    bootEl?.remove()
    bootEl = undefined
  },
})

// The explicit test build exposes mutable app/canvas handles to Playwright.
// Ordinary development and production builds do not publish this bridge.
declare global {
  interface Window {
    __dinksterTestDefaultProtocol?: 'v1'
    __dinksterTest?: {
      app: AppState
      semanticDerivations: number
      syntheticWorkflow: typeof syntheticWorkflow
    } & Partial<CanvasTestHandles>
  }
}

async function bootstrap(): Promise<void> {
  // Canvas measurement must use the same loaded faces as DOM text.
  await Promise.all([
    document.fonts.load('400 13px "Noto Sans"'),
    document.fonts.load('600 13px "Noto Sans"'),
    document.fonts.load('italic 600 13px "Noto Sans"'),
    document.fonts.load('400 13px "Noto Sans Mono"'),
  ])
  const desktop = desktopBridge()
  const desktopLocale = await desktop?.locale()
  const desktopLogs: string[] = []
  let app: AppState | undefined
  desktop?.onLog((line) => {
    if (app) app.recordHostLog('info', 'Local engine', line)
    else {
      desktopLogs.push(line)
      if (desktopLogs.length > 500) desktopLogs.shift()
    }
  })
  if (desktop) {
    hideBoot()
    const disposeSetupLocale = bindPersistedLocale(globalThis.localStorage, document.documentElement, navigator.language, desktopLocale)
    try {
      const [desktopStatus, setDesktopStatus] = createSignal<DesktopLifecycleStatus>(await desktop.status())
      const disposeSetup = render(
        () => <DesktopSetup status={desktopStatus()} onRetry={() => { void desktop.retry().catch(() => undefined) }} />,
        root,
      )
      revealRoot()
      try {
        await new Promise<void>((resolve) => {
          const receive = (status: DesktopLifecycleStatus) => {
            setDesktopStatus(status)
            if (status.phase === 'running') {
              stopListening()
              resolve()
            }
          }
          const stopListening = desktop.onStatus(receive)
          receive(desktopStatus())
        })
      } finally {
        disposeSetup()
      }
    } finally {
      disposeSetupLocale()
      root.replaceChildren()
    }
  }
  const home = desktop || projectsPage === undefined ? undefined : await readHomeStatus()
  hideBoot()
  if (home !== undefined && projectsPage !== undefined) {
    // The projects page shares the editor's frame; it follows the persisted theme and language.
    bindPersistedLocale(globalThis.localStorage, document.documentElement, navigator.language)
    render(() => <Shell home={home} page={projectsPage!} mountEditor={async (projectId, host, shell) => {
      initializeProjectScope(projectId)
      const { dispose } = await startEditor(host, desktopLocale, undefined, shell)
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
      return dispose
    }} />, root)
    revealRoot()
    return
  }
  disposeBootTheme()
  const desktopWindow = desktop
    ? { context: await desktop.windowContext(), layout: await desktop.windowLayout() }
    : undefined
  app = (await startEditor(root, desktopLocale, desktopWindow, undefined, desktopLogs)).app
  revealRoot()
}

/** Build one project's editor into ``host``; the returned disposer ends it. */
async function startEditor(
  host: HTMLElement,
  desktopLocale: string | undefined,
  desktopWindow: Parameters<typeof App>[0]['desktopWindow'],
  shell: ShellNavigation | undefined,
  desktopLogs: readonly string[] = [],
): Promise<{ readonly app: AppState; readonly dispose: () => void }> {
  const app = new AppState()
  const disposeTheme = bindTheme(app.settings)
  const disposeLocale = bindLocale(app.settings, document.documentElement, navigator.language, desktopLocale)
  for (const line of desktopLogs.slice(-500)) app.recordHostLog('info', 'Local engine', line)
  // Browser tests reach the app as soon as it exists; they wait for
  // readiness through it, not for the kept node tables below.
  if (import.meta.env.MODE === 'test') {
    window.__dinksterTest = { app, semanticDerivations: 0, syntheticWorkflow }
  }
  // Restored tabs draw from the kept node tables on their first frame. The
  // browser store is a cache, so a slow one only costs that, never startup.
  await Promise.race([app.loadKeptSchemas(), new Promise((resolve) => setTimeout(resolve, 1000))])
  const started = app.start()

  const disposeRender = render(() => <App
    app={app}
    {...(desktopWindow ? { desktopWindow } : {})}
    {...(shell ? { shell } : {})}
  />, host)
  void started.then(() => app.enableWorkspaceAuthority()).catch((error: unknown) => {
    console.warn('Shared editing could not start', error)
  })
  return {
    app,
    dispose: () => {
      disposeRender()
      disposeLocale()
      disposeTheme()
    },
  }
}

// Do not hide startup failures: a rejected bootstrap remains an observable
// unhandled rejection, matching the previous failed module-evaluation path.
void bootstrap()
