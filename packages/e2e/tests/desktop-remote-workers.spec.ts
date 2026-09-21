import { expect, test } from './fixtures.js'
import { evidencePath } from './evidence-output.js'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    type RemoteWorker = {
      name: string
      endpoint: string
      tokenFile: string
      tlsCaFile?: string
      nodes?: string[]
      memory: { device: string; size: string }[]
    }
    let workers: RemoteWorker[] = [{
      name: 'render-box',
      endpoint: 'worker.example.test:5151',
      tokenFile: 'C:\\ProgramData\\Dinkster\\render-box.token',
      tlsCaFile: 'C:\\ProgramData\\Dinkster\\render-box.pem',
      nodes: [],
      memory: [{ device: 'ram', size: '24G' }, { device: 'vram:cuda:0', size: '20G' }],
    }]
    const calls = { info: 0, systemCheck: 0, remoteWorkers: 0, saveRemoteWorker: 0 }
    ;(window as typeof window & { __desktopLocaleCalls: typeof calls }).__desktopLocaleCalls = calls
    const info = {
      appVersion: '0.2.0', engineCommit: 'bd09e6eb0ac3bbdf', remoteWorkerProtocol: 8, variant: 'cuda', storageBytes: 2 * 1024 ** 3,
      releases: [{ commit: 'bd09e6eb0ac3bbdf', variant: 'cuda', bytes: 2 * 1024 ** 3, active: true }],
      update: { state: 'current', detail: 'Dinkster Desktop is up to date' },
    }
    ;(window as typeof window & { dinksterDesktop: unknown }).dinksterDesktop = {
      locale: async () => 'en-US',
      status: async () => ({ phase: 'running', detail: 'Dinkster is running locally', variant: 'cuda' }),
      retry: async () => {},
      info: async () => { calls.info += 1; return info },
      selectEngine: async () => {},
      checkForUpdates: async () => {},
      installUpdate: async () => {},
      chooseDirectory: async () => undefined,
      revealFile: async () => {},
      exportSnapshot: async () => undefined,
      importSnapshot: async () => undefined,
      systemCheck: async () => { calls.systemCheck += 1; return {
        platform: 'win32', architecture: 'x64', freeBytes: 100 * 1024 ** 3, totalBytes: 200 * 1024 ** 3,
        engineReady: true, engineDetail: 'Locked cuda environment is installed',
        gpu: { available: true, name: 'NVIDIA Test GPU', driver: '600.1', memoryMiB: 24576 },
      } },
      clearCache: async () => {},
      exportSupportReport: async () => undefined,
      windowContext: async () => ({ id: 'primary', kind: 'primary' }),
      windowLayout: async () => ({ windows: [{ id: 'primary', kind: 'primary' }] }),
      openWorkflowWindow: async () => {},
      openPanelWindow: async () => {},
      redockWindow: async () => {},
      switchProject: async () => {},
      openProjectWindow: async () => {},
      setConnectionCredential: async () => {},
      retireConnectionProfile: async () => {},
      connectionCredentials: async () => ({ custody: true, profiles: [] }),
      remoteWorkers: async () => { calls.remoteWorkers += 1; return structuredClone(workers) },
      saveRemoteWorker: async (worker: RemoteWorker) => {
        calls.saveRemoteWorker += 1
        workers = [...workers.filter((candidate) => candidate.name !== worker.name), structuredClone(worker)]
      },
      removeRemoteWorker: async (name: string) => { workers = workers.filter((worker) => worker.name !== name) },
      chooseRemoteWorkerFile: async (kind: 'token' | 'tls-ca') => kind === 'token'
        ? { path: 'C:\\ProgramData\\Dinkster\\new-worker.token', grant: 'token-grant' }
        : { path: 'C:\\ProgramData\\Dinkster\\new-worker.pem', grant: 'tls-grant' },
      takeDeepLinks: async () => [],
      onStatus: () => () => {},
      onLog: () => () => {},
      onInfo: (_listener: (value: unknown) => void) => () => {},
      onWindowLayout: () => () => {},
      onDeepLinkPending: () => () => {},
    }
  })
})

test('edits a guided remote-worker profile across a mounted locale change', async ({ page, request }) => {
  await page.goto('/')
  await page.getByTestId('desktop-management-button').click()
  const section = page.locator('.desktop-management-section').filter({ has: page.locator('.desktop-worker-list') })
  await expect(section).toContainText('render-box')
  await expect(section).toContainText('protocol 8 from matching Dinkster engine revision bd09e6eb0ac3')
  await expect(section).toContainText('TLS certificate pinned')
  await expect(section).toContainText('No allowed node types')
  await section.getByRole('button', { name: 'Edit' }).click()
  await expect(section.getByRole('heading', { name: 'Edit render-box' })).toBeVisible()
  await expect(section.getByLabel(/^Profile name/)).toBeDisabled()
  await expect(section.getByLabel(/^Token file/)).toHaveValue('C:\\ProgramData\\Dinkster\\render-box.token')
  await expect(section.getByLabel('Node routing policy')).toHaveValue('allowlist')
  await expect(section.getByLabel('Allowed node types')).toHaveValue('')
  await expect(section).toContainText('An empty list allows no node types')
  await expect(section).toContainText('token contents never enter the renderer')

  await page.locator('.modal-surface').evaluate((element) => { element.style.maxHeight = 'none' })
  await page.locator('.desktop-management').evaluate((element) => { element.style.overflow = 'visible' })
  await section.evaluate((element) => { element.dataset['localeIdentity'] = 'worker-section' })
  await section.locator('.desktop-worker-card').evaluate((element) => { element.dataset['localeIdentity'] = 'worker-card' })
  await section.locator('.desktop-worker-form').evaluate((element) => { element.dataset['localeIdentity'] = 'worker-form' })
  const address = section.locator('.desktop-worker-form input').nth(1)
  await address.fill('worker.example.test:5252')
  await address.focus()
  const callsBeforeLocale = await page.evaluate(() => (window as typeof window & { __desktopLocaleCalls: unknown }).__desktopLocaleCalls)
  await section.screenshot({
    path: evidencePath('issue-457', 'desktop-management-i18n-en.png'),
    animations: 'disabled',
  })

  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { setLocale } = await import(i18nModule)
    setLocale('zh')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(page.locator('[data-locale-identity="worker-section"]')).toHaveCount(1)
  await expect(page.locator('[data-locale-identity="worker-card"]')).toHaveCount(1)
  await expect(page.locator('[data-locale-identity="worker-form"]')).toHaveCount(1)
  await expect(address).toBeFocused()
  await expect(address).toHaveValue('worker.example.test:5252')
  await expect(section).toContainText('\u8fdc\u7a0b\u5de5\u4f5c\u8282\u70b9')
  await expect(section).toContainText('\u7f16\u8f91 render-box')
  await expect(section).toContainText('worker.example.test:5151')
  await expect(section.locator('.desktop-worker-form input').nth(2)).toHaveValue('C:\\ProgramData\\Dinkster\\render-box.token')
  await expect(section.locator('.desktop-worker-form textarea').nth(0)).toHaveValue('')
  await expect.poll(async () => page.evaluate(() => (window as typeof window & { __desktopLocaleCalls: unknown }).__desktopLocaleCalls)).toEqual(callsBeforeLocale)
  await section.screenshot({
    path: evidencePath('issue-457', 'desktop-management-i18n-zh.png'),
    animations: 'disabled',
  })

  const save = section.locator('button[type="submit"]')
  await expect(save).toBeDisabled()
  await expect(section).toContainText('\u8bf7\u518d\u6b21\u9009\u62e9\u4ee4\u724c\u6587\u4ef6')
  await section.locator('.desktop-worker-path-field').nth(0).getByRole('button').click()
  await expect(save).toBeDisabled()
  await expect(section).toContainText('\u8bf7\u518d\u6b21\u9009\u62e9\u6b64\u6587\u4ef6')
  await section.locator('.desktop-worker-path-field').nth(1).getByRole('button').first().click()
  await expect(save).toBeEnabled()
  await save.click()
  await expect(section).toContainText('worker.example.test:5252')
  await expect(page.locator('.desktop-management-message')).toContainText('\u5df2\u4fdd\u5b58\u8fdc\u7a0b\u5de5\u4f5c\u8282\u70b9\u5e76\u91cd\u542f\u672c\u5730\u5f15\u64ce')
  await expect.poll(async () => page.evaluate(() => (window as typeof window & { __desktopLocaleCalls: { saveRemoteWorker: number } }).__desktopLocaleCalls.saveRemoteWorker)).toBe(1)
})
