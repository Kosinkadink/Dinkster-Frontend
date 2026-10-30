import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { syntheticWorkflow } from '@dinkster/core'
import { assetDtoV1Contract } from '@dinkster/client'
import { App } from './App.js'
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
// that touches storage) constructs, and it never changes within a page:
// switching projects reloads the window.
initializeProjectScope(projectIdFromSearch(globalThis.location?.search ?? ''))
const disposeBootTheme = bindPersistedTheme()

// Show a minimal centered indicator while fonts and desktop setup load.
// It appears only after 150ms (no flash on a fast boot), names what it is
// waiting on after 3s, and is removed the
// moment the real app renders. See docs/shell.md "Boot indicator".
const root = document.getElementById('root')!
let bootEl: HTMLElement | undefined
const hideBoot = startBootIndicator({
  onShow: () => {
    bootEl = createBootIndicatorElement().el
    root.appendChild(bootEl)
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

// Test bridge: lets Playwright inspect app state without poking DOM
// internals. Read-only by convention; grows into the __comfyTest contract.
// syntheticWorkflow rides along so perf specs generate workloads in-page.
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
  hideBoot()
  app = new AppState()
  disposeBootTheme()
  bindTheme(app.settings)
  bindLocale(app.settings, document.documentElement, navigator.language, desktopLocale)
  await app.enableWorkspaceAuthority()
  const desktopWindow = desktop
    ? { context: await desktop.windowContext(), layout: await desktop.windowLayout() }
    : undefined
  for (const line of desktopLogs.slice(-500)) app.recordHostLog('info', 'Local engine', line)
  void app.start()

  window.__dinksterTest = { app, semanticDerivations: 0, syntheticWorkflow }
  const catalogPath = import.meta.env['VITE_DINKSTER_FEDERATED_CATALOG_PATH']
  const candidatesPath = import.meta.env['VITE_DINKSTER_FEDERATED_CANDIDATES_PATH']
  const federatedAssets = catalogPath && candidatesPath
    ? assetDtoV1Contract({ catalog: catalogPath, candidates: candidatesPath })
    : undefined
  render(() => <App
    app={app}
    {...(federatedAssets ? { federatedAssets } : {})}
    {...(desktopWindow ? { desktopWindow } : {})}
  />, root)
}

// Do not hide startup failures: a rejected bootstrap remains an observable
// unhandled rejection, matching the previous failed module-evaluation path.
void bootstrap()
