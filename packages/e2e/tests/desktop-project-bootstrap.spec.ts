/**
 * Desktop startup transport selection: a window's default backend comes from
 * the project engine report. A fresh unconfigured project has no project
 * supervisor yet, so it must reach the application's management flow on the
 * window origin's default transport without waiting for any engine runtime,
 * configured projects route to their own loopback port, and a configured
 * report without a usable port fails startup closed instead of silently
 * targeting the window origin.
 */
import { expect, test, type Page } from './fixtures.js'
import { evidencePath } from './evidence-output.js'

type MockProject = {
  configured: boolean
  port?: number
  projectId?: string
}

function installDesktopBridge(project: MockProject): void {
  const projectId = project.projectId ?? 'proj-main'
  // A fresh unconfigured report carries only the required facts: the host
  // does not report channel, install root, cell, or available commit until
  // an engine is installed.
  const projectInfo = {
    projectId,
    configured: project.configured,
    mirrorConfigured: project.configured,
    dataRoot: `C:\\Users\\kosin\\AppData\\Local\\Dinkster\\projects\\${projectId}`,
    generations: project.configured
      ? [
          { generation: 1, current: true, baseId: 'base-9f2c', engineCommit: '8c7db20e7f30afbc', cell: 'linux-cu128', status: 'active' },
        ]
      : [],
    ...(project.configured
      ? {
          channel: 'stable',
          installRoot: `C:\\Users\\kosin\\AppData\\Local\\Dinkster\\engines\\${projectId}`,
          cell: 'linux-cu128',
          availableEngineCommit: 'bd09e6eb0ac3bbdf',
        }
      : {}),
    ...(project.port === undefined ? {} : { port: project.port }),
  }
  const w = window as typeof window & { __projectEngineCalls?: number }
  const bridge: Record<string, unknown> = {
    locale: async () => 'en-US',
    status: async () => ({ phase: 'idle', detail: 'The local engine is not running', variant: 'cuda' }),
    retry: async () => {},
    info: async () => ({
      appVersion: '0.2.0', engineCommit: 'bd09e6eb0ac3bbdf', remoteWorkerProtocol: 8, variant: 'cuda',
      storageBytes: 2 * 1024 ** 3,
      releases: [{ commit: 'bd09e6eb0ac3bbdf', variant: 'cuda', bytes: 2 * 1024 ** 3, active: true }],
      update: { state: 'current', detail: 'Dinkster Desktop is up to date' },
    }),
    selectEngine: async () => {},
    checkForUpdates: async () => {},
    installUpdate: async () => {},
    chooseDirectory: async () => undefined,
    revealFile: async () => {},
    exportSnapshot: async () => undefined,
    importSnapshot: async () => undefined,
    systemCheck: async () => ({
      platform: 'linux', architecture: 'x64', freeBytes: 100 * 1024 ** 3, totalBytes: 200 * 1024 ** 3,
      engineReady: true, engineDetail: 'Locked cuda environment is installed',
      gpu: { available: true, name: 'NVIDIA Test GPU', driver: '600.1', memoryMiB: 24576 },
    }),
    clearCache: async () => {},
    exportSupportReport: async () => undefined,
    windowContext: async () => ({ id: 'primary', kind: 'primary' }),
    windowLayout: async () => ({ windows: [{ id: 'primary', kind: 'primary' }] }),
    openWorkflowWindow: async () => {},
    openPanelWindow: async () => {},
    redockWindow: async () => {},
    switchProject: async () => {},
    openProjectWindow: async () => {},
    projectEngine: async () => {
      w.__projectEngineCalls = (w.__projectEngineCalls ?? 0) + 1
      return structuredClone(projectInfo)
    },
    installProjectEngine: async () => {},
    activateProjectGeneration: async () => {},
    removeProject: async () => {},
    setConnectionCredential: async () => {},
    retireConnectionProfile: async () => {},
    connectionCredentials: async () => ({ custody: true, profiles: [] }),
    remoteWorkers: async () => [],
    saveRemoteWorker: async () => {},
    removeRemoteWorker: async () => {},
    chooseRemoteWorkerFile: async () => undefined,
    takeDeepLinks: async () => [],
    onStatus: () => () => {},
    onLog: () => () => {},
    onInfo: () => () => {},
    onWindowLayout: () => () => {},
    onDeepLinkPending: () => () => {},
  }
  ;(window as typeof window & { dinksterDesktop: unknown }).dinksterDesktop = bridge
}

const defaultBackendBaseUrl = async (page: Page): Promise<string> => {
  // Bootstrap is asynchronous: wait until the app object and its backend
  // signal exist before reading the connection target.
  await page.waitForFunction(
    () => {
      const app = (window as typeof window & { __dinksterTest?: { app?: { backends?: unknown } } }).__dinksterTest
      return app?.app?.backends !== undefined
    },
    undefined,
    { timeout: 30_000 },
  )
  return page.evaluate(
    () =>
      (
        (window as typeof window & { __dinksterTest: { app: { backends: { get: () => { readonly baseUrl: string }[] } } } })
          .__dinksterTest.app.backends.get()[0]!
      ).baseUrl,
  )
}

test('a fresh unconfigured project reaches the management flow on the window origin default transport', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 2400 })
  await page.addInitScript(installDesktopBridge, { configured: false, projectId: 'proj-new' } satisfies MockProject)
  await page.goto('/')
  await page.getByTestId('desktop-management-button').click()
  const section = page.locator('.desktop-management-section').filter({ has: page.locator('.desktop-project') })
  await expect(section).toContainText('Project engine')
  await expect(section.getByRole('button', { name: 'Remove project' })).toBeVisible()
  // The fresh report carries no configured-only facts, so the dialog shows
  // the project id, its data root, and the mirror state only.
  await expect(section.getByText('proj-new', { exact: true })).toBeVisible()
  await expect(section.getByText('C:\\Users\\kosin\\AppData\\Local\\Dinkster\\projects\\proj-new')).toBeVisible()
  await expect(section.getByText('Install root')).toHaveCount(0)
  await expect(section.getByText('Available engine')).toHaveCount(0)
  // No project supervisor exists yet and no engine runtime wait gates
  // startup: the window renders the app on the window origin's default
  // transport so the management dialog can install the first engine.
  expect(await defaultBackendBaseUrl(page)).toBe('')
  await expect
    .poll(() => page.evaluate(() => (window as typeof window & { __projectEngineCalls?: number }).__projectEngineCalls ?? 0))
    .toBeGreaterThan(0)
  await page.locator('.modal-surface').evaluate((element) => { element.style.maxHeight = 'none' })
  await page.locator('.desktop-management').evaluate((element) => { element.style.overflow = 'visible' })
  await page.locator('.desktop-project').screenshot({
    path: evidencePath('issue-214', 'first-install-management-reachable.png'),
    animations: 'disabled',
  })
})

test('configured projects route their windows to their own loopback ports', async ({ page, browser }) => {
  await page.addInitScript(installDesktopBridge, { configured: true, port: 8188 } satisfies MockProject)
  await page.goto('/')
  expect(await defaultBackendBaseUrl(page)).toBe('http://127.0.0.1:8188')

  const secondContext = await browser.newContext()
  const second = await secondContext.newPage()
  await second.addInitScript(installDesktopBridge, { configured: true, port: 8189 } satisfies MockProject)
  await second.goto('/')
  expect(await defaultBackendBaseUrl(second)).toBe('http://127.0.0.1:8189')
  await secondContext.close()
})

test('a configured project without a usable port fails startup closed', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.addInitScript(installDesktopBridge, { configured: true, projectId: 'proj-broken' } satisfies MockProject)
  await page.goto('/')
  await expect.poll(() => pageErrors.join('\n')).toContain('no usable engine port')
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __dinksterTest?: unknown }).__dinksterTest === undefined)).toBe(true)
  await expect(page.getByTestId('desktop-management-button')).toHaveCount(0)
})
