import { expect, test, type Page } from '@playwright/test'
import { auditLayout } from './ui-audit.js'
import { evidencePath } from './evidence-output.js'

const BACKENDS_SURFACE = '.product-tabpanel:has(> [data-testid="backends-panel"])'

test.use({ hasTouch: true })

const runtimeSettings = {
  categories: {
    granted: ['memory-budgets', 'dtype-policy', 'jobs', 'logging'],
    available: ['memory-budgets', 'dtype-policy', 'worker-comfy-args', 'jobs', 'logging', 'future-category'],
  },
  settings: {
    'memory-budgets': { value: { 'cuda:0': '12G', ram: '40G' }, source: 'environment', mutability: 'on-worker-restart', writable: true, persistence: { available: true, persisted: true } },
    'dtype-policy': { value: { diffusion: 'auto', textEncoder: 'float16', vae: 'float32' }, source: 'runtime', mutability: 'on-worker-restart', writable: true, persistence: { available: true, persisted: true } },
    'worker-comfy-args': { value: ['--preview-method', 'latent2rgb'], source: 'command-line', mutability: 'on-worker-restart', writable: false, persistence: { available: false, persisted: false } },
    jobs: { value: { maxRunningJobs: 2 }, source: 'default', mutability: 'live', writable: true, persistence: { available: true, persisted: true } },
    logging: { value: { level: 'info', overrides: { 'dinkster.engine.composition.with.a.very.long.logger.name': 'debug' } }, source: 'config', mutability: 'live', writable: false, persistence: { available: true, persisted: true } },
    'future-category': { value: { provider: 'server-owned', nested: { text: 'A long additive value remains visible without requiring a frontend-specific editor.' } }, source: 'server', mutability: 'live', writable: true, persistence: { available: true, persisted: true } },
  },
}

async function installRoutes(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }))
  await page.route('/supervisor/status', (route) => route.fulfill({ json: {
    protocol: 1,
    state: 'ready',
    detail: 'Engine healthy',
    progress: { done: 3, total: 8, phase: 'Composing custom node packs' },
  } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 4,
    dinkster: { version: 'issue-37-proof', schemaWire: 22 },
    nodes: {},
  } }))
  await page.route('/api/diagnostics*', (route) => route.fulfill({ json: { diagnostics: [] } }))
  await page.route('/api/settings*', async (route) => {
    if (route.request().method() === 'PATCH') {
      const category = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()!)
      const value = route.request().postDataJSON() as unknown
      return route.fulfill({ json: { ...runtimeSettings.settings[category as keyof typeof runtimeSettings.settings], value, source: 'runtime' } })
    }
    return route.fulfill({ json: runtimeSettings })
  })
}

async function openFixture(page: Page): Promise<void> {
  await installRoutes(page)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => Boolean(window.__dinksterTest))).toBe(true)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const local = app.backends.get()[0]!
    ;(local.connection.status as any).set('connected')
    local.schemaState.set({ status: 'ready' })
    local.supervisor.set({ protocol: 1, state: 'ready', detail: 'Engine healthy', progress: { done: 3, total: 8, phase: 'Composing custom node packs' } })

    const reconnecting = app.addBackend('http://render-farm.example.test:9000/a/very/long/backend/path', 'Render farm with a long descriptive backend name', false, 'dinkster')!
    ;(reconnecting.connection.status as any).set('reconnecting')
    reconnecting.schemaState.set({ status: 'error', message: 'Schema wire 99 is not supported by this frontend build.' })
    reconnecting.supervisor.set({ protocol: 1, state: 'failed', detail: 'Worker exited while loading a custom pack.', engine: { exitCode: 2 } })

    const stopped = app.addBackend('/maintenance', 'Maintenance backend', false, 'dinkster')!
    ;(stopped.connection.status as any).set('disconnected')
    stopped.schemaState.set({ status: 'idle' })
    stopped.supervisor.set({ protocol: 1, state: 'stopped', detail: 'Stopped by operator.' })
  })
  await page.getByTestId('backends-sidebar-toggle').click()
  await expect(page.getByTestId('backends-panel')).toBeVisible()
}

test('backend and runtime management remains truthful and usable across wide, narrow, and zoomed layouts', async ({ page }) => {
  await openFixture(page)
  const panel = page.getByTestId('backends-panel')
  const surface = page.locator(BACKENDS_SURFACE)
  await expect(page.getByTestId('backend-row')).toHaveCount(3)
  await expect(panel).toContainText('Composing custom node packs')
  await expect(panel).toContainText('Schema wire 99 is not supported')
  await expect(panel).toContainText('Stopped by operator')
  await expect(page.getByTestId('backend-row').filter({ hasText: 'Maintenance backend' })).toContainText('Not loaded')
  await expect(panel.getByRole('button', { name: 'Remove Local' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: /Restart Render farm/ })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Remove Maintenance backend' })).toBeVisible()
  await expect(page.locator('.backend-address').filter({ hasText: '/a/very/long/backend/path' })).toBeVisible()
  expect(await auditLayout(page, BACKENDS_SURFACE)).toEqual([])
  await page.screenshot({ path: evidencePath('issue-37', 'after-backends-wide.png'), fullPage: true })

  const local = page.getByTestId('backend-row').filter({ hasText: 'Local' })
  await local.getByRole('button', { name: 'Local runtime settings' }).click()
  await expect(local.getByText('Component precision', { exact: true })).toBeVisible()
  await expect(local.getByText('Grant required').first()).toBeVisible()
  await expect(local.getByText('Read-only').first()).toBeVisible()
  const jobs = local.locator('details[data-category="jobs"]')
  const jobsInput = jobs.getByRole('spinbutton', { name: 'Maximum running jobs' })
  await jobsInput.fill('4')
  await expect(jobs.getByText('Unsaved changes')).toBeVisible()
  await expect(jobs.getByRole('button', { name: 'Apply' })).toBeEnabled()
  await jobs.getByRole('button', { name: 'Reset' }).click()
  await expect(jobsInput).toHaveValue('2')
  await expect(jobs.getByText('No unsaved changes')).toBeVisible()
  await local.locator('[data-category="future-category"]').scrollIntoViewIfNeeded()
  await expect(local.getByText('A long additive value remains visible')).toBeVisible()
  expect(await auditLayout(page, BACKENDS_SURFACE)).toEqual([])
  await local.locator('[data-category="future-category"]').screenshot({ path: evidencePath('issue-37', 'after-runtime-wide.png') })

  await page.setViewportSize({ width: 390, height: 844 })
  const railToggle = page.getByTestId('rail-toggle')
  if (await railToggle.getAttribute('aria-pressed') === 'true') await railToggle.click()
  await expect(railToggle).toHaveAttribute('aria-pressed', 'false')
  await surface.evaluate((element) => { element.scrollTop = 0 })
  await expect(panel).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  expect(await auditLayout(page, BACKENDS_SURFACE)).toEqual([])
  await panel.screenshot({ path: evidencePath('issue-37', 'after-backends-narrow.png') })

  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await panel.evaluate((element) => getComputedStyle(element).animationDuration)).toBe('0s')
  const runtimeToggle = local.getByRole('button', { name: 'Local runtime settings', exact: true })
  await runtimeToggle.scrollIntoViewIfNeeded()
  const runtimeToggleBox = await runtimeToggle.boundingBox()
  expect(runtimeToggleBox).not.toBeNull()
  await page.touchscreen.tap(runtimeToggleBox!.x + runtimeToggleBox!.width / 2, runtimeToggleBox!.y + runtimeToggleBox!.height / 2)
  await expect(runtimeToggle).toHaveAttribute('aria-expanded', 'false')

  await page.setViewportSize({ width: 720, height: 720 })
  await page.evaluate(() => { document.documentElement.style.zoom = '2' })
  await surface.evaluate((element) => { element.scrollTop = 0 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(720)
  await page.getByTestId('backend-url-input').focus()
  await expect(page.getByTestId('backend-url-input')).toBeFocused()
  await page.getByTestId('backend-url-input').fill('http://touch.example.test:7777')
  const add = page.getByTestId('backend-add')
  const box = await add.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.height).toBeGreaterThanOrEqual(40)
  await page.keyboard.press('Tab')
  await expect(add).toBeFocused()
  await panel.screenshot({ path: evidencePath('issue-37', 'after-backends-200-percent.png') })
})

test('mounted backend connection chrome follows the supported locale without changing backend facts or authority', async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 950 })
  await openFixture(page)
  const panel = page.getByTestId('backends-panel')
  const reconnecting = page.getByTestId('backend-row').filter({ hasText: 'Render farm with a long descriptive backend name' })
  const maintenance = page.getByTestId('backend-row').filter({ hasText: 'Maintenance backend' })
  const input = page.getByTestId('backend-url-input')
  const retry = reconnecting.getByTestId('backend-schema-retry')
  const restart = reconnecting.getByTestId('backend-engine-restart')
  await panel.evaluate((element) => { element.dataset['localeIdentity'] = 'panel' })
  await reconnecting.evaluate((element) => { element.dataset['localeIdentity'] = 'card' })
  await retry.evaluate((element) => { element.dataset['localeIdentity'] = 'retry' })
  await restart.evaluate((element) => { element.dataset['localeIdentity'] = 'restart' })
  await input.fill('http://entered.example.test:7000/raw-path')
  await input.focus()
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const calls = { add: [] as string[], restart: [] as string[], retry: [] as string[] }
    ;(window as any).__backendLocaleCalls = calls
    app.addBackendByUrl = async (address: string) => {
      calls.add.push(address)
      return app.addBackend(address, 'Added raw backend', false, 'dinkster')
    }
    app.restartEngine = async (backend: any) => { calls.restart.push(backend.label) }
    app.refreshBackendSchemas = async (backend: any) => { calls.retry.push(backend.label) }
  })
  await reconnecting.scrollIntoViewIfNeeded()
  await page.screenshot({ path: evidencePath('issue-457', 'backend-connections-i18n-en.png'), fullPage: true })

  const backendRequests: string[] = []
  page.on('request', (outgoing) => {
    const url = new URL(outgoing.url())
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/supervisor/')) backendRequests.push(url.pathname)
  })
  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { setLocale } = await import(i18nModule)
    setLocale('zh')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(page.locator('[data-locale-identity="panel"]')).toHaveCount(1)
  await expect(page.locator('[data-locale-identity="card"]')).toHaveCount(1)
  await expect(page.locator('[data-locale-identity="retry"]')).toHaveCount(1)
  await expect(page.locator('[data-locale-identity="restart"]')).toHaveCount(1)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('http://entered.example.test:7000/raw-path')
  await expect(panel).toHaveAttribute('aria-label', '\u540e\u7aef\u8fde\u63a5')
  await expect(panel.getByRole('heading', { name: '\u540e\u7aef\u8fde\u63a5' })).toBeVisible()
  await expect(reconnecting).toContainText('\u6b63\u5728\u91cd\u65b0\u8fde\u63a5')
  await expect(reconnecting).toContainText('\u67b6\u6784\u8bf7\u6c42\u5931\u8d25\uff1aSchema wire 99 is not supported by this frontend build.')
  await expect(reconnecting).toContainText('Worker exited while loading a custom pack.')
  await expect(reconnecting).toContainText('Render farm with a long descriptive backend name')
  await expect(reconnecting).toContainText('http://render-farm.example.test:9000/a/very/long/backend/path')
  await expect(retry).toHaveText('\u91cd\u8bd5\u67b6\u6784\u8bf7\u6c42')
  await expect(restart).toHaveText('\u91cd\u542f\u5f15\u64ce')
  await expect(maintenance).toContainText('Stopped by operator.')
  await expect.poll(() => backendRequests).toEqual([])
  expect(await auditLayout(page, BACKENDS_SURFACE)).toEqual([])
  await reconnecting.scrollIntoViewIfNeeded()
  await page.screenshot({ path: evidencePath('issue-457', 'backend-connections-i18n-zh.png'), fullPage: true })

  await retry.click()
  await restart.click()
  await input.fill('http://added.example.test:7777')
  await panel.getByTestId('backend-add').click()
  await expect(page.getByTestId('backend-row').filter({ hasText: 'Added raw backend' })).toBeVisible()
  await maintenance.getByTestId('backend-remove').click()
  await expect(maintenance).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__backendLocaleCalls)).toEqual({
    add: ['http://added.example.test:7777'],
    restart: ['Render farm with a long descriptive backend name'],
    retry: ['Render farm with a long descriptive backend name'],
  })
})

test('open saved connections follow the active locale', async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 950 })
  await openFixture(page)
  const profiles = page.getByTestId('connection-profiles')
  await profiles.scrollIntoViewIfNeeded()
  await expect(profiles.getByRole('heading', { name: 'Saved connections' })).toBeVisible()
  await expect(profiles.getByText('Maintenance backend')).toHaveCount(0)
  await page.screenshot({ path: evidencePath('issue-457', 'connection-profiles-i18n-en.png'), fullPage: true })

  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'connectionProfiles.action.saveProfile': '[Verbindungsprofil speichern]',
      'connectionProfiles.description': '[Benannte entfernte Dinkster-Server bei Bedarf verbinden.]',
      'connectionProfiles.label.name': '[Profilname]',
      'connectionProfiles.label.serverAddress': '[Serveradresse]',
      'connectionProfiles.notice.desktopRequired': '[Zugriffstoken benotigen die Desktop-App und den Betriebssystem-Schlusselbund.]',
      'connectionProfiles.placeholder.name': '[Studio-Arbeitsstation]',
      'connectionProfiles.title': '[Gespeicherte Verbindungen mit langem Namen]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(profiles.getByRole('heading', { name: '[Gespeicherte Verbindungen mit langem Namen]' })).toBeVisible()
  await expect(profiles).toHaveAttribute('aria-label', '[Gespeicherte Verbindungen mit langem Namen]')
  await expect(profiles.getByText('[Benannte entfernte Dinkster-Server bei Bedarf verbinden.]')).toBeVisible()
  await expect(profiles.getByText('[Zugriffstoken benotigen die Desktop-App und den Betriebssystem-Schlusselbund.]')).toBeVisible()
  await expect(profiles.getByTestId('profile-name-input')).toHaveAttribute('placeholder', '[Studio-Arbeitsstation]')
  await expect(profiles.getByText('[Serveradresse]')).toBeVisible()
  await expect(profiles.getByTestId('profile-add')).toHaveText('[Verbindungsprofil speichern]')
  await expect(profiles.getByText('Maintenance backend')).toHaveCount(0)
  expect(await auditLayout(page, BACKENDS_SURFACE)).toEqual([])
  await page.screenshot({ path: evidencePath('issue-457', 'connection-profiles-i18n-de-DE.png'), fullPage: true })
})

test('mounted agent permission chrome relabels without refetching or changing authority', async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 950 })
  await openFixture(page)
  let principalRequests = 0
  let permissionUpdates = 0
  await page.route('**/api/principals', (route) => {
    principalRequests += 1
    return route.fulfill({ json: [{
      principalId: 'raw.agent-one',
      kind: 'automation-agent',
      categories: { edit: true, execute: false, future: true },
    }] })
  })
  await page.route('**/api/principals/*/permissions', (route) => {
    permissionUpdates += 1
    expect(route.request().postDataJSON()).toEqual({ execute: true })
    return route.fulfill({ json: { edit: true, execute: true, future: true } })
  })
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const backend = app.addBackend('http://permissions.example.test:9000', 'Raw permissions backend', false, 'dinkster')!
    ;(backend.connection.status as any).set('connected')
    backend.schemaState.set({ status: 'ready' })
  })

  const backend = page.getByTestId('backend-row').filter({ hasText: 'Raw permissions backend' })
  const panel = backend.getByTestId('agent-permissions')
  const row = panel.getByTestId('agent-permissions-row')
  const edit = row.locator('[data-category="edit"]')
  const execute = row.locator('[data-category="execute"]')
  const future = row.locator('[data-category="future"]')
  await expect(panel).toBeVisible()
  await expect.poll(() => principalRequests).toBe(1)
  await panel.evaluate((element) => { element.dataset['localeIdentity'] = 'panel' })
  await row.evaluate((element) => { element.dataset['localeIdentity'] = 'row' })
  await edit.evaluate((element) => { element.dataset['localeIdentity'] = 'edit' })
  await execute.focus()
  await page.screenshot({ path: evidencePath('issue-457', 'agent-permissions-i18n-en.png'), fullPage: true })

  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'agentPermissions.aria.category': '[{category} FUR {principal}]',
      'agentPermissions.aria.panel': '[BERECHTIGUNGEN FUR {backend}]',
      'agentPermissions.category.edit': '[DOKUMENTE BEARBEITEN]',
      'agentPermissions.category.execute': '[AUFTRAGE AUSFUHREN]',
      'agentPermissions.title': '[AGENTENBERECHTIGUNGEN MIT LANGEM TITEL]',
      'automation-agent': '[NICHT UBERSETZEN]',
      'future': '[NICHT UBERSETZEN]',
      'Raw permissions backend': '[NICHT UBERSETZEN]',
      'raw.agent-one': '[NICHT UBERSETZEN]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(page.locator('[data-locale-identity="panel"]')).toHaveCount(1)
  await expect(page.locator('[data-locale-identity="row"]')).toHaveCount(1)
  await expect(page.locator('[data-locale-identity="edit"]')).toHaveCount(1)
  await expect(panel).toHaveAttribute('aria-label', '[BERECHTIGUNGEN FUR Raw permissions backend]')
  await expect(panel.getByRole('heading')).toHaveText('[AGENTENBERECHTIGUNGEN MIT LANGEM TITEL]')
  await expect(edit.locator('xpath=..')).toContainText('[DOKUMENTE BEARBEITEN]')
  await expect(execute).toHaveAttribute('aria-label', '[[AUFTRAGE AUSFUHREN] FUR raw.agent-one]')
  await expect(future.locator('xpath=..')).toContainText('future')
  await expect(row).toContainText('raw.agent-one')
  await expect(row).toContainText('automation-agent')
  await expect(execute).toHaveAttribute('aria-checked', 'false')
  await expect(execute).toBeFocused()
  expect(principalRequests).toBe(1)
  expect(permissionUpdates).toBe(0)
  expect(await auditLayout(page, BACKENDS_SURFACE)).toEqual([])

  await execute.click()
  await expect.poll(() => permissionUpdates).toBe(1)
  await expect(row.locator('[data-category="execute"]')).toHaveAttribute('aria-checked', 'true')
  expect(principalRequests).toBe(1)
})
