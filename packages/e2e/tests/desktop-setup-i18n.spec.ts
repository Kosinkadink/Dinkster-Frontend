import { expect, test } from '@playwright/test'
import { auditLayout } from './ui-audit.js'
import { evidencePath } from './evidence-output.js'



test('desktop Automatic locale reaches setup and the full app without host side effects', async ({ page }) => {
  await page.addInitScript(() => {
    const calls = { locale: 0, status: 0, retry: 0 }
    let statusListener: ((status: { phase: string; detail: string; variant: string }) => void) | undefined
    ;(window as typeof window & { __desktopSetupCalls: typeof calls }).__desktopSetupCalls = calls
    ;(window as typeof window & { __completeDesktopSetup: () => void }).__completeDesktopSetup = () => {
      statusListener?.({ phase: 'running', detail: 'Dinkster is running locally', variant: 'cuda' })
    }
    ;(window as typeof window & { dinksterDesktop: unknown }).dinksterDesktop = {
      locale: async () => { calls.locale += 1; return 'zh-CN' },
      status: async () => {
        calls.status += 1
        return { phase: 'installing', detail: 'Installing locked CUDA environment', variant: 'cuda' }
      },
      retry: async () => { calls.retry += 1 },
      info: async () => ({
        appVersion: '0.2.0', engineCommit: 'desktop-locale-test', variant: 'cuda', storageBytes: 0,
        releases: [], update: { state: 'current', detail: 'Current' },
      }),
      selectEngine: async () => undefined,
      checkForUpdates: async () => undefined,
      installUpdate: async () => undefined,
      chooseDirectory: async () => undefined,
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
      setConnectionCredential: async () => undefined,
      retireConnectionProfile: async () => undefined,
      connectionCredentials: async () => ({ custody: false, profiles: [] }),
      remoteWorkers: async () => [],
      saveRemoteWorker: async () => undefined,
      removeRemoteWorker: async () => undefined,
      chooseRemoteWorkerFile: async () => undefined,
      takeDeepLinks: async () => [],
      onStatus: (listener: typeof statusListener) => {
        statusListener = listener
        return () => { statusListener = undefined }
      },
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
  const setup = page.locator('main.desktop-setup')
  await expect(setup).toContainText('\u6b63\u5728\u51c6\u5907\u60a8\u7684\u672c\u5730\u5de5\u4f5c\u5ba4')
  await expect(setup).toContainText('\u73af\u5883\uff1aCUDA')
  await expect(setup).toContainText('Installing locked CUDA environment')
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-label', '\u672c\u5730\u5f15\u64ce\u8bbe\u7f6e')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  expect(await auditLayout(page, 'main.desktop-setup')).toEqual([])
  await page.screenshot({ path: `evidencePath('issue-457', 'desktop-setup-zh.png')`, fullPage: true })

  const preserved = await page.evaluate(() => {
    const main = document.querySelector('main.desktop-setup')
    const card = document.querySelector('.desktop-setup-card')
    const progress = document.querySelector('[role="progressbar"]')
    localStorage.setItem('dinkster.settings', JSON.stringify({ v: 1, values: { 'dinkster.locale': 'en' } }))
    dispatchEvent(new StorageEvent('storage', { key: 'dinkster.settings' }))
    return new Promise<{ main: boolean; card: boolean; progress: boolean }>((resolve) => queueMicrotask(() => resolve({
      main: document.querySelector('main.desktop-setup') === main,
      card: document.querySelector('.desktop-setup-card') === card,
      progress: document.querySelector('[role="progressbar"]') === progress,
    })))
  })
  expect(preserved).toEqual({ main: true, card: true, progress: true })
  await expect(setup).toContainText('Preparing your local studio')
  await expect(setup).toContainText('Environment: CUDA')
  await expect(setup).toContainText('Installing locked CUDA environment')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  expect(await page.evaluate(() => (window as typeof window & { __desktopSetupCalls: unknown }).__desktopSetupCalls)).toEqual({ locale: 1, status: 1, retry: 0 })
  expect(await auditLayout(page, 'main.desktop-setup')).toEqual([])
  await page.screenshot({ path: `evidencePath('issue-457', 'desktop-setup-en.png')`, fullPage: true })

  await page.evaluate(() => {
    localStorage.setItem('dinkster.settings', JSON.stringify({ v: 1, values: { 'dinkster.locale': 'auto' } }))
    dispatchEvent(new StorageEvent('storage', { key: 'dinkster.settings' }))
  })
  await expect(setup).toContainText('\u6b63\u5728\u51c6\u5907\u60a8\u7684\u672c\u5730\u5de5\u4f5c\u5ba4')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')

  await page.evaluate(() => (window as typeof window & { __completeDesktopSetup: () => void }).__completeDesktopSetup())
  await expect.poll(() => page.evaluate(() => window.__dinksterTest !== undefined)).toBe(true)
  await expect(page.locator('main.desktop-setup')).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  expect(await page.evaluate(() => (window as typeof window & { __desktopSetupCalls: unknown }).__desktopSetupCalls)).toEqual({ locale: 1, status: 1, retry: 0 })
})
