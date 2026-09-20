import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { syntheticWorkflow } from '@dinkster/core'
import { assetDtoV1Contract, discoverBackend } from '@dinkster/client'
import { App } from './App.js'
import { AppState } from './app-state.js'
import { createBootIndicatorElement, startBootIndicator } from './boot-indicator.js'
import { DesktopSetup } from './DesktopSetup.js'
import { desktopBridge, type DesktopLifecycleStatus } from './desktop-bridge.js'
import { bindLocale, bindPersistedLocale } from './locale.js'
import { initializeProjectScope, projectIdFromSearch } from './projects.js'
import type { CanvasTestHandles } from './test-bridge.js'
import './styles.css'

// The project scope namespaces every per-project storage key and shared
// worker/channel/lock name. It must be fixed before AppState (or anything
// that touches storage) constructs, and it never changes within a page:
// switching projects reloads the window.
initializeProjectScope(projectIdFromSearch(globalThis.location?.search ?? ''))

// Boot indicator: #root is blank while discoverBackend() awaits (up to the
// probe timeout on a slow/dead origin). Show a minimal centered indicator so
// the launch is never a blank screen. It appears only after 150ms (no flash
// on a fast boot), names what it is waiting on after 3s, and is removed the
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
    __dinksterTest?: {
      app: AppState
      semanticDerivations: number
      syntheticWorkflow: typeof syntheticWorkflow
    } & Partial<CanvasTestHandles>
  }
}

async function bootstrap(): Promise<void> {
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
  // Native-first same-origin default: discover what THIS origin routes to
  // before constructing the app, so a clean launch connects to its Dinkster
  // engine or supervisor. Production launch is native-only; compatibility
  // test deployments can explicitly enable the v1 probe. Users can still add
  // a ComfyUI backend by URL, where full protocol discovery remains enabled.
  const discovery = await discoverBackend('', {
    timeoutMs: 2500,
    probeV1: import.meta.env['VITE_DINKSTER_PROBE_V1'] === '1',
  })
  hideBoot()
  app = new AppState({ defaultProtocol: discovery.kind === 'v1' ? 'v1' : 'dinkster' })
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
  const resolvePath = import.meta.env['VITE_DINKSTER_FEDERATED_RESOLVE_PATH']
  const federatedAssets = catalogPath && candidatesPath
    ? assetDtoV1Contract({ catalog: catalogPath, candidates: candidatesPath, ...(resolvePath ? { resolve: resolvePath } : {}) })
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
