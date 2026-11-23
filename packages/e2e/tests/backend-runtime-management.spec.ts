import { expect, nativeTest as test, waitForWorkspaceReady, type Page } from './fixtures.js'
import { auditLayout } from './ui-audit.js'
import { evidencePath } from './evidence-output.js'

const BACKENDS_SURFACE = '.product-tabpanel:has(> [data-testid="backends-panel"])'

test.use({ hasTouch: true, deviceScaleFactor: 2 })

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
    dinkster: { version: 'issue-37-proof', schemaWire: 2 },
    nodes: {},
  } }))
  await page.route('/api/diagnostics*', (route) => route.fulfill({ json: { diagnostics: [] } }))
  await page.route('**/api/settings*', async (route) => {
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
  await waitForWorkspaceReady(page)
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
  await expect(panel.getByTestId('backend-url-input')).toBeHidden()
  await page.evaluate(async () => {
    const path = '/src/connection-profiles.ts'
    const { createConnectionProfile } = await import(/* @vite-ignore */ path)
    if (!createConnectionProfile('Saved studio', 'https://saved.example.test:8443')) throw new Error('Profile was not saved')
    window.dispatchEvent(new Event('connection-profiles-changed'))
  })
  const saved = panel.getByTestId('backend-row').filter({ hasText: 'Saved studio' })
  await saved.locator('summary').click()
  await expect(saved.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()
  const farm = page.getByTestId('backend-row').filter({ hasText: 'Render farm with a long descriptive backend name' })
  const maintenance = page.getByTestId('backend-row').filter({ hasText: 'Maintenance backend' })
  await expect(farm.locator('summary').first()).toContainText('Reconnecting')
  await expect(maintenance.locator('summary').first()).toContainText('Disconnected')
  await farm.locator('summary').first().click()
  await expect(farm.locator('details').first()).toHaveAttribute('open', '')
  await page.evaluate(() => {
    const local = (window.__dinksterTest!.app as any).backends.get()[0]!
    local.supervisor.set({ ...local.supervisor.get()!, detail: 'Backend health refreshed' })
  })
  await expect(farm.locator('details').first()).toHaveAttribute('open', '')
  await expect(saved.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()
  await expect(farm).toContainText('Schema wire 99 is not supported')
  await expect(farm.getByRole('button', { name: 'Restart engine', exact: true })).toBeVisible()
  await expect(page.locator('.backend-address').filter({ hasText: '/a/very/long/backend/path' })).toBeVisible()
  await expect(panel.getByTestId('model-settings')).toHaveCount(0)
  await expect(panel.getByTestId('output-mount-settings')).toHaveCount(0)
  expect(await auditLayout(page, BACKENDS_SURFACE)).toEqual([])
  await page.screenshot({ path: evidencePath('issue-37', 'after-backends-wide.png'), fullPage: true })

  const local = page.getByTestId('backend-row').filter({ hasText: 'Local' })
  await local.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.locator('.settings-editor')
  await expect(settings.getByText('Component precision', { exact: true })).toBeVisible()
  await expect(settings.getByText('Grant required').first()).toBeVisible()
  await expect(settings.getByText('Read-only').first()).toBeVisible()
  await expect(settings.locator('[data-category="memory-budgets"]')).toHaveCount(0)
  const jobs = settings.locator('details[data-category="jobs"]')
  const jobsInput = jobs.getByRole('spinbutton', { name: 'Maximum running jobs' })
  await jobsInput.fill('4')
  await expect(jobs.getByText('Unsaved changes')).toBeVisible()
  await expect(jobs.getByRole('button', { name: 'Apply' })).toBeEnabled()
  await jobs.getByRole('button', { name: 'Reset' }).click()
  await expect(jobsInput).toHaveValue('2')
  await expect(jobs.getByText('No unsaved changes')).toBeVisible()
  await settings.locator('[data-category="future-category"]').scrollIntoViewIfNeeded()
  await expect(settings.getByText('A long additive value remains visible')).toBeVisible()
  expect(await auditLayout(page, '.settings-editor')).toEqual([])
  await settings.locator('[data-category="future-category"]').screenshot({ path: evidencePath('issue-37', 'after-runtime-wide.png') })
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 390, height: 844 })
  const railToggle = page.getByTestId('rail-toggle')
  if (await railToggle.getAttribute('aria-pressed') === 'true') await railToggle.click()
  await expect(railToggle).toHaveAttribute('aria-pressed', 'false')
  await surface.evaluate((element) => { element.scrollTop = 0 })
  await expect(panel).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  expect(await auditLayout(page, BACKENDS_SURFACE)).toEqual([])
  await page.screenshot({ path: evidencePath('issue-37', 'after-backends-narrow.png') })

  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await panel.evaluate((element) => getComputedStyle(element).animationDuration)).toBe('0s')
  const serverToggle = local.locator('summary').first()
  await serverToggle.scrollIntoViewIfNeeded()
  const serverToggleBox = await serverToggle.boundingBox()
  expect(serverToggleBox).not.toBeNull()
  await page.touchscreen.tap(serverToggleBox!.x + serverToggleBox!.width / 2, serverToggleBox!.y + serverToggleBox!.height / 2)
  await expect(local.locator('details').first()).not.toHaveAttribute('open', '')

  // Model the CSS viewport and pixel density of 200% zoom on a 720px display.
  // CSS zoom alone leaves window.innerWidth and media queries unchanged.
  await page.setViewportSize({ width: 360, height: 360 })
  expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio }))).toEqual({ width: 360, height: 360, scale: 2 })
  await surface.evaluate((element) => { element.scrollTop = 0 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
  expect(await auditLayout(page, BACKENDS_SURFACE)).toEqual([])
  await panel.getByRole('button', { name: 'Add backend', exact: true }).tap()
  await page.getByTestId('backend-url-input').focus()
  await expect(page.getByTestId('backend-url-input')).toBeFocused()
  await page.getByTestId('backend-url-input').fill('http://touch.example.test:7777')
  expect(await auditLayout(page, BACKENDS_SURFACE)).toEqual([])
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
  const add = page.getByTestId('backend-add')
  const box = await add.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.height).toBeGreaterThanOrEqual(44)
  await page.keyboard.press('Tab')
  await expect(panel.getByRole('textbox', { name: 'Name (optional)', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(add).toBeFocused()
  await page.screenshot({ path: evidencePath('issue-37', 'after-backends-200-percent.png') })
  await surface.evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: evidencePath('issue-37', 'after-backends-200-percent-top.png') })
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
  await backend.locator('summary').first().click()
  await backend.getByRole('button', { name: 'Settings', exact: true }).click()
  const panel = page.locator('.settings-editor').getByTestId('agent-permissions')
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
  expect(await auditLayout(page, '.settings-editor')).toEqual([])

  await execute.click()
  await expect.poll(() => permissionUpdates).toBe(1)
  await expect(row.locator('[data-category="execute"]')).toHaveAttribute('aria-checked', 'true')
  expect(principalRequests).toBe(1)
})
