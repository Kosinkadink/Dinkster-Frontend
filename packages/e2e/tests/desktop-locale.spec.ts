/**
 * Desktop startup locale: the bridge's locale reaches the full application
 * without waiting for any engine runtime. A fresh project window renders the
 * app even while the host reports a non-running legacy engine, and startup
 * makes exactly one locale call with no retry side effects.
 */
import { expect, test } from '@playwright/test'

test('desktop Automatic locale reaches the full app without host side effects', async ({ page }) => {
  await page.addInitScript(() => {
    const calls = { locale: 0, status: 0, retry: 0 }
    ;(window as typeof window & { __desktopBridgeCalls: typeof calls }).__desktopBridgeCalls = calls
    ;(window as typeof window & { dinksterDesktop: unknown }).dinksterDesktop = {
      locale: async () => {
        ;(window as typeof window & { __desktopBridgeCalls: { locale: number } }).__desktopBridgeCalls.locale += 1
        return 'zh-CN'
      },
      status: async () => {
        ;(window as typeof window & { __desktopBridgeCalls: { status: number } }).__desktopBridgeCalls.status += 1
        return { phase: 'idle', detail: 'The local engine is not running', variant: 'cuda' }
      },
      retry: async () => {
        ;(window as typeof window & { __desktopBridgeCalls: { retry: number } }).__desktopBridgeCalls.retry += 1
      },
      info: async () => ({
        appVersion: '0.2.0', engineCommit: 'desktop-locale-test', variant: 'cuda', storageBytes: 0,
        releases: [], update: { state: 'current', detail: 'Current' },
      }),
      selectEngine: async () => undefined,
      checkForUpdates: async () => undefined,
      installUpdate: async () => undefined,
      chooseDirectory: async () => undefined,
      revealFile: async () => undefined,
      exportSnapshot: async () => undefined,
      importSnapshot: async () => undefined,
      systemCheck: async () => ({
        platform: 'win32', architecture: 'x64', freeBytes: 1, totalBytes: 2,
        engineReady: true, engineDetail: 'Ready', gpu: { available: false },
      }),
      clearCache: async () => undefined,
      exportSupportReport: async () => undefined,
      windowContext: async () => ({ id: 'primary', kind: 'primary' }),
      windowLayout: async () => ({ windows: [{ id: 'primary', kind: 'primary' }] }),
      openWorkflowWindow: async () => undefined,
      openPanelWindow: async () => undefined,
      redockWindow: async () => undefined,
      switchProject: async () => undefined,
      openProjectWindow: async () => undefined,
      projectEngine: async () => ({
        projectId: 'proj-locale', configured: false, mirrorConfigured: false,
        dataRoot: 'C:\\Users\\kosin\\AppData\\Local\\Dinkster\\projects\\proj-locale',
        generations: [],
      }),
      installProjectEngine: async () => undefined,
      activateProjectGeneration: async () => undefined,
      removeProject: async () => undefined,
      setConnectionCredential: async () => undefined,
      retireConnectionProfile: async () => undefined,
      connectionCredentials: async () => ({ custody: false, profiles: [] }),
      remoteWorkers: async () => [],
      saveRemoteWorker: async () => undefined,
      removeRemoteWorker: async () => undefined,
      chooseRemoteWorkerFile: async () => undefined,
      takeDeepLinks: async () => [],
      onStatus: () => () => undefined,
      onLog: () => () => undefined,
      onInfo: () => () => undefined,
      onWindowLayout: () => () => undefined,
      onDeepLinkPending: () => () => undefined,
    }
  })
  await page.route(/\/(?:supervisor\/status|api\/nodes|system_stats)(?:\?.*)?$/, (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: '{}',
  }))

  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest !== undefined)).toBe(true)
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  expect(await page.evaluate(() => (window as typeof window & { __desktopBridgeCalls: unknown }).__desktopBridgeCalls))
    .toEqual({ locale: 1, status: 0, retry: 0 })
})
