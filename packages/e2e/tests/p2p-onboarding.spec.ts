import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { selectProductOption } from './fixtures.js'
import { auditLayout } from './ui-audit.js'

const proofDir = process.env['DINKSTER_P2P_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })
const P2P_SURFACE = '.product-tabpanel:has(> .p2p-panels)'

const digest = `blake3:${'a'.repeat(64)}`
const grantId = 'b'.repeat(64)
const seedGrant = {
  version: 1,
  grantId,
  digest,
  sourceType: 'declarative-resolver',
  sourceId: 'resolver.example/models',
  sourceRevision: `sha256:${'c'.repeat(64)}`,
  license: '',
  descriptor: {
    protocol: 'bittorrent-v2',
    infoHash: 'd'.repeat(64),
    fileRoot: 'e'.repeat(64),
    pieceLength: 8388608,
  },
  expiresAt: 4_000_000_000,
  evidenceType: 'public-acquisition-receipt',
  evidenceId: 'f'.repeat(32),
}
const defaultSettings = {
  downloadsEnabled: true,
  seedingEnabled: true,
  scope: 'lan-and-internet',
  internetUploadBytesPerSecond: 5 * 1024 ** 2,
  internetDownloadBytesPerSecond: 0,
  lanUploadBytesPerSecond: 0,
  lanDownloadBytesPerSecond: 0,
  pauseOnMetered: true,
  networkCostOverride: 'auto',
  seedMode: 'budgeted',
  internetSeedRatio: 1,
  internetSeedTimeSeconds: 86400,
  stagingBudgetBytes: 64 * 1024 ** 3,
}

const section = (value: unknown) => ({
  value,
  source: 'persisted',
  mutability: 'live',
  writable: true,
  persistence: { available: true, persisted: true },
})

interface P2PFixture {
  settings: typeof defaultSettings
  metered: boolean
  grantRevoked: boolean
  requiresResume: boolean
  resumed: boolean
  downloadedBytes: number
  uploadedBytes: number
  settingsRequests?: number
  statusRequests: number
  settingsWrites?: number
  writable?: boolean
  denyWrite?: boolean
}

const status = (fixture: P2PFixture) => {
  const effective = fixture.settings.networkCostOverride === 'auto'
    ? fixture.metered ? 'metered' : 'unmetered'
    : fixture.settings.networkCostOverride
  const transferState = fixture.requiresResume && !fixture.resumed ? 'paused' : 'downloading'
  const networkPaused = false
  const globalActive = fixture.settings.scope === 'lan-and-internet'
    && !(effective === 'metered' && fixture.settings.pauseOnMetered) && (!fixture.requiresResume || fixture.resumed)
  const globalFeatures = { dht: globalActive, pex: globalActive, tcp: globalActive, utp: globalActive, trackers: false, upnp: globalActive, natMappings: globalActive, natPmp: globalActive, pcp: globalActive }
  return {
    state: 'running',
    settings: fixture.settings,
    restartCount: 0,
    lastError: null,
    network: {
      system: fixture.metered ? 'metered' : 'unmetered',
      override: fixture.settings.networkCostOverride,
      effective,
      paused: networkPaused,
    },
    lan: {
      networkAllowed: !networkPaused,
      mappingPort: networkPaused ? null : 6881,
      mappedDigests: fixture.settings.seedingEnabled && !networkPaused ? [digest] : [],
    },
    sidecar: {
      version: 3,
      state: networkPaused ? 'paused' : 'running',
      pid: 1234,
      capabilities: {
        downloads: fixture.settings.downloadsEnabled,
        seeding: fixture.settings.seedingEnabled,
      },
      libtorrentVersion: '2.0.11',
      listenPort: 6881,
      listenInterfaces: networkPaused ? [] : ['192.168.1.10'],
      networkPaused,
      networkFeatures: {
        ...globalFeatures,
        lsd: !networkPaused,
      },
      global: {
        active: globalActive,
        listenPort: globalActive ? 6881 : null,
        closureReason: globalActive ? null : effective === 'metered' ? 'metered-network' : 'resume-required',
        networkFeatures: globalFeatures,
        transfers: [],
      },
      leases: [],
      totals: { downloadedBytes: fixture.downloadedBytes, uploadedBytes: fixture.uploadedBytes },
      transfers: [{
        digest,
        state: transferState,
        sizeBytes: 512 * 1024 ** 2,
        peers: 2,
        downloadRateBytesPerSecond: transferState === 'downloading' ? 6 * 1024 ** 2 : 0,
        uploadRateBytesPerSecond: transferState === 'downloading' ? 512 * 1024 : 0,
        downloadedBytes: fixture.downloadedBytes,
        uploadedBytes: fixture.uploadedBytes,
        partialBytes: fixture.downloadedBytes,
        seedAuthorizations: [{
          grantId,
          state: fixture.grantRevoked ? 'revoked' : fixture.settings.seedingEnabled ? 'active' : 'inactive',
          grant: fixture.grantRevoked ? null : seedGrant,
        }],
        remainingSeedRatio: 0.75,
        remainingSeedTimeSeconds: 7200,
      }],
      recovery: null,
    },
  }
}

async function installRoutes(page: Page, fixture: P2PFixture, base = ''): Promise<void> {
  await page.route(`${base}/system_stats`, (route) => route.fulfill({ status: 404 }))
  await page.route(`${base}/supervisor/status`, (route) => route.fulfill({ json: { protocol: 1, state: 'ready', detail: 'Ready' } }))
  await page.route(`${base}/api/nodes*`, (route) => route.fulfill({ json: {
    schemaVersion: 21,
    dinkster: { version: 'p2p-e2e', schemaWire: 21 },
    nodes: {},
  } }))
  await page.route(`${base}/api/settings`, (route) => {
    fixture.settingsRequests = (fixture.settingsRequests ?? 0) + 1
    return route.fulfill({ json: {
      categories: { granted: fixture.writable === false ? [] : ['p2p'], available: ['p2p'] },
      settings: { p2p: { ...section(fixture.settings), writable: fixture.writable !== false } },
    } })
  })
  await page.route(`${base}/api/settings/p2p`, async (route) => {
    fixture.settingsWrites = (fixture.settingsWrites ?? 0) + 1
    if (fixture.denyWrite || fixture.writable === false) {
      await route.fulfill({ status: 403, json: { error: 'settings-changes-disabled', category: 'p2p', granted: [] } })
      return
    }
    fixture.settings = route.request().postDataJSON() as typeof defaultSettings
    await route.fulfill({ json: section(fixture.settings) })
  })
  await page.route(`${base}/api/p2p/status`, async (route) => {
    fixture.statusRequests += 1
    if (fixture.metered && fixture.settings.networkCostOverride === 'auto' && fixture.settings.pauseOnMetered) {
      fixture.requiresResume = true
    }
    await route.fulfill({ json: status(fixture) })
  })
  await page.route(`${base}/api/p2p/transfers/**`, async (route) => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().url()).toContain(`${encodeURIComponent(digest)}/resume`)
    fixture.resumed = true
    fixture.downloadedBytes += 4 * 1024 ** 2
    fixture.uploadedBytes += 512 * 1024
    await route.fulfill({ status: 204 })
  })
}

async function captureOnboarding(page: Page, testInfo: TestInfo): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(800, 400)
  await page.waitForTimeout(500)
  const panel = await page.getByTestId('p2p-panel').boundingBox()
  const sharing = await page.locator('.p2p-sharing').boundingBox()
  if (panel === null || sharing === null) throw new Error('P2P onboarding screenshot bounds are unavailable')
  const clip = { x: panel.x, y: panel.y, width: panel.width, height: sharing.y + sharing.height - panel.y + 2 }
  const body = await page.screenshot({
    ...(proofDir ? { path: join(proofDir, 'p2p-onboarding.png') } : {}),
    clip,
    animations: 'disabled',
  })
  await testInfo.attach('p2p-onboarding.png', { body, contentType: 'image/png' })
}

async function captureRuntime(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(800, 400)
  await page.waitForTimeout(500)
  const body = await page.locator('.p2p-runtime').screenshot({
    ...(proofDir ? { path: join(proofDir, name) } : {}),
    animations: 'disabled',
  })
  await testInfo.attach(name, { body, contentType: 'image/png' })
}

async function openP2P(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const backend = window.__dinksterTest?.app.backends.get()[0]
    return backend?.registry.get() !== undefined
  })).toBe(true)
  const toggle = page.getByTestId('p2p-sidebar-toggle')
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click()
  await expect(page.getByTestId('p2p-panel')).toBeVisible()
}

test('P2P settings, LAN activity, metered recovery, and counters survive reload without a first-run modal', async ({ page }, testInfo) => {
  const fixture: P2PFixture = {
    settings: { ...defaultSettings },
    metered: false,
    grantRevoked: false,
    requiresResume: false,
    resumed: false,
    downloadedBytes: 24 * 1024 ** 2,
    uploadedBytes: 2 * 1024 ** 2,
    statusRequests: 0,
  }
  await installRoutes(page, fixture)
  await page.goto('/')
  const notice = page.getByTestId('p2p-first-run-notice')
  await expect(notice).toHaveCount(0)
  expect(fixture.settingsWrites ?? 0).toBe(0)
  await openP2P(page)
  const panel = page.getByTestId('p2p-panel')
  await expect(panel).toBeVisible()

  await expect(panel.getByRole('checkbox', { name: 'Peer-to-peer sharing' })).toHaveAttribute('aria-checked', 'true')
  await expect(panel).toContainText('Current seeding state: On.')
  await expect(panel.getByRole('combobox', { name: 'Network scope' })).toContainText('LAN and internet')
  await expect(panel.getByTestId('p2p-transfer')).toContainText('Authorized and active')
  await expect(panel.getByTestId('p2p-transfer')).toContainText('Not specified (metadata only)')
  await expect(panel).toContainText('Other peers can learn your IP address and that your device is requesting or sharing a particular model digest.')
  await expect(panel).toContainText('While a download is active, peers may receive pieces from your device even when background seeding is off.')
  expect(await auditLayout(page, P2P_SURFACE)).toEqual([])
  await captureOnboarding(page, testInfo)

  const disk = panel.getByRole('group', { name: 'Temporary download storage', exact: true })
  await disk.scrollIntoViewIfNeeded()
  const diskBody = await disk.screenshot({ ...(proofDir ? { path: join(proofDir, 'p2p-staging-budget.png') } : {}) })
  await testInfo.attach('p2p-staging-budget.png', { body: diskBody, contentType: 'image/png' })
  await page.setViewportSize({ width: 1440, height: 1300 })
  await captureRuntime(page, testInfo, 'p2p-active-empty-license.png')
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(panel.getByTestId('p2p-transfer')).toContainText('2')
  await expect(panel.getByTestId('p2p-transfer')).toContainText('512.0 KiB/s up')
  await expect(panel.getByTestId('p2p-transfer')).toContainText('Authorized and active')
  await expect(panel.getByTestId('p2p-transfer')).toContainText('Public acquisition receipt')
  await expect(panel).toContainText('Uploaded: 2.0 MiB')

  fixture.metered = true
  await panel.getByRole('button', { name: 'Refresh activity' }).click()
  await expect(panel).toContainText('Internet P2P is closed. Reason: metered-network')
  await expect(panel).toContainText('LAN networking is not paused.')
  await expect(panel).not.toContainText('All P2P networking is paused')
  await expect(panel.getByTestId('p2p-transfer')).toContainText('Paused')
  await page.setViewportSize({ width: 1440, height: 1100 })
  await captureRuntime(page, testInfo, 'p2p-metered-pause.png')

  await selectProductOption(page, panel.getByRole('combobox', { name: 'Network cost override' }), 'unmetered')
  await panel.getByRole('button', { name: 'Apply settings' }).click()
  await expect(panel).toContainText('LAN networking is not paused.')
  await panel.getByRole('button', { name: 'Resume' }).click()
  await expect(panel.getByTestId('p2p-transfer')).toContainText('Downloading')
  await expect(panel).toContainText('Downloaded: 28.0 MiB')
  await expect(panel).toContainText('Uploaded: 2.5 MiB')

  await page.reload()
  await openP2P(page)
  await expect(notice).toHaveCount(0)
  await expect(panel.getByRole('checkbox', { name: 'Peer-to-peer sharing' })).toHaveAttribute('aria-checked', 'true')
  await expect(panel).toContainText('Downloaded: 28.0 MiB')
  await expect(panel).toContainText('Uploaded: 2.5 MiB')
  expect(fixture.settings.networkCostOverride).toBe('unmetered')
  expect(await auditLayout(page, P2P_SURFACE)).toEqual([])
  await page.setViewportSize({ width: 1440, height: 1000 })
  await captureRuntime(page, testInfo, 'p2p-transfer-activity.png')

  fixture.grantRevoked = true
  await panel.getByRole('button', { name: 'Refresh activity' }).click()
  await expect(panel.getByTestId('p2p-transfer')).toContainText('Revoked')
  await captureRuntime(page, testInfo, 'p2p-revoked-authorization.png')

  const railToggle = page.getByRole('button', { name: 'Toggle right rail' })
  if (await railToggle.getAttribute('aria-pressed') === 'true') await railToggle.click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(panel).toBeVisible()
  expect(await auditLayout(page, P2P_SURFACE)).toEqual([])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const narrowName = 'p2p-transfer-narrow.png'
  const narrowBody = await panel.getByTestId('p2p-transfer').screenshot({
    ...(proofDir ? { path: join(proofDir, narrowName) } : {}),
    animations: 'disabled',
  })
  await testInfo.attach(narrowName, { body: narrowBody, contentType: 'image/png' })
})

test('mounted P2P panel follows the shared catalog without resetting state or requests', async ({ browser, baseURL, request }, testInfo) => {
  const fixture: P2PFixture = {
    settings: { ...defaultSettings, downloadsEnabled: false, seedingEnabled: false, scope: 'lan-only' },
    metered: false,
    grantRevoked: false,
    requiresResume: false,
    resumed: false,
    downloadedBytes: 0,
    uploadedBytes: 0,
    statusRequests: 0,
  }
  const context = await browser.newContext({ baseURL: baseURL!, locale: 'zh-CN', viewport: { width: 1440, height: 1300 } })
  const page = await context.newPage()
  await installRoutes(page, fixture)
  await page.goto('/')
  await openP2P(page)
  const panel = page.getByTestId('p2p-panel')
  const downloads = panel.getByRole('checkbox', { name: '\u70b9\u5bf9\u70b9\u5171\u4eab' })
  await expect(panel.getByRole('heading', { name: 'P2P \u4f20\u8f93' })).toBeVisible()
  await expect(page.getByTestId('p2p-first-run-notice')).toHaveCount(0)
  await expect(downloads).toHaveAttribute('aria-checked', 'false')
  await expect(panel).toContainText('\u4ec5\u9650\u5c40\u57df\u7f51')
  expect(fixture.statusRequests).toBe(0)
  expect(await auditLayout(page, P2P_SURFACE)).toEqual([])
  const panelBox = await panel.boundingBox()
  const sharingBox = await page.locator('.p2p-sharing').boundingBox()
  if (panelBox === null || sharingBox === null) throw new Error('P2P catalog screenshot bounds are unavailable')
  const clip = { x: panelBox.x, y: panelBox.y, width: panelBox.width, height: sharingBox.y + sharingBox.height - panelBox.y + 2 }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(800, 900)
  await page.waitForTimeout(250)
  const chinese = await page.screenshot({
    ...(proofDir ? { path: join(proofDir, 'p2p-shared-catalog-zh.png') } : {}),
    clip,
    animations: 'disabled',
  })
  await testInfo.attach('p2p-shared-catalog-zh.png', { body: chinese, contentType: 'image/png' })
  await downloads.focus()
  const panelNode = await panel.elementHandle()
  const downloadsNode = await downloads.elementHandle()
  const settingsRequests = fixture.settingsRequests

  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { setLocale } = await import(i18nModule)
    setLocale('en')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  const englishDownloads = panel.getByRole('checkbox', { name: 'Peer-to-peer sharing' })
  await expect(panel.getByRole('heading', { name: 'P2P transfers' })).toBeVisible()
  await expect(englishDownloads).toHaveAttribute('aria-checked', 'false')
  await expect(panel).toContainText('LAN only')
  expect(await panelNode!.evaluate((node, current) => node === current, await panel.elementHandle())).toBe(true)
  expect(await downloadsNode!.evaluate((node, current) => node === current, await englishDownloads.elementHandle())).toBe(true)
  await expect(englishDownloads).toBeFocused()
  expect(fixture.settingsRequests).toBe(settingsRequests)
  expect(fixture.statusRequests).toBe(0)
  expect(await auditLayout(page, P2P_SURFACE)).toEqual([])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(800, 900)
  const english = await page.screenshot({
    ...(proofDir ? { path: join(proofDir, 'p2p-shared-catalog-en.png') } : {}),
    clip,
    animations: 'disabled',
  })
  await testInfo.attach('p2p-shared-catalog-en.png', { body: english, contentType: 'image/png' })
  await context.close()
})

test('explicit locale setting overrides the browser locale across P2P surfaces', async ({ browser, baseURL }) => {
  const fixture: P2PFixture = {
    settings: { ...defaultSettings, downloadsEnabled: false, seedingEnabled: false, scope: 'lan-only' },
    metered: false,
    grantRevoked: false,
    requiresResume: false,
    resumed: false,
    downloadedBytes: 0,
    uploadedBytes: 0,
    statusRequests: 0,
  }
  const context = await browser.newContext({ baseURL: baseURL!, locale: 'zh-CN' })
  await context.addInitScript(() => localStorage.setItem('dinkster.settings', JSON.stringify({
    v: 1,
    values: { 'dinkster.locale': 'en' },
  })))
  const page = await context.newPage()
  await installRoutes(page, fixture)
  await page.goto('/')
  await expect(page.getByTestId('p2p-sidebar-toggle')).toHaveAttribute('aria-label', 'P2P transfers')
  await openP2P(page)
  const panel = page.getByTestId('p2p-panel')
  await expect(panel.getByRole('heading', { name: 'P2P transfers' })).toBeVisible()
  await expect(panel.getByRole('checkbox', { name: 'Peer-to-peer sharing' })).toHaveAttribute('aria-checked', 'false')
  await expect(panel).toContainText('LAN only')
  expect(fixture.statusRequests).toBe(0)
  await context.close()
})

test('fresh P2P is off without a modal and the single toggle starts and stops it', async ({ page }, testInfo) => {
  const fixture: P2PFixture = {
    settings: { ...defaultSettings, downloadsEnabled: false, seedingEnabled: false },
    metered: false, grantRevoked: false, requiresResume: false, resumed: false,
    downloadedBytes: 0, uploadedBytes: 0, statusRequests: 0,
  }
  await installRoutes(page, fixture)
  await page.goto('/')
  await expect(page.getByTestId('p2p-first-run-notice')).toHaveCount(0)
  await openP2P(page)
  const panel = page.getByTestId('p2p-panel')
  const toggle = panel.getByRole('checkbox', { name: 'Peer-to-peer sharing' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(panel).toContainText('Current seeding state: Off.')
  expect(fixture.statusRequests).toBe(0)
  expect(await auditLayout(page, P2P_SURFACE)).toEqual([])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(1430, 890)
  await page.waitForTimeout(750)
  const image = await panel.locator('.p2p-sharing').screenshot({
    ...(proofDir ? { path: join(proofDir, 'p2p-fresh-off.png') } : {}),
    animations: 'disabled',
  })
  await testInfo.attach('p2p-fresh-off.png', { body: image, contentType: 'image/png' })

  await toggle.click()
  await panel.getByRole('button', { name: 'Apply settings' }).click()
  await expect(panel).toContainText('P2P settings saved.')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(fixture.settings).toMatchObject({ downloadsEnabled: true, seedingEnabled: true })
  expect(fixture.statusRequests).toBeGreaterThan(0)

  await toggle.click()
  await panel.getByRole('button', { name: 'Apply settings' }).click()
  await expect(panel).toContainText('P2P settings saved.')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(panel.locator('.p2p-runtime')).toHaveCount(0)
  expect(fixture.settings).toMatchObject({ downloadsEnabled: false, seedingEnabled: false })
  await page.reload()
  await expect(page.getByTestId('p2p-first-run-notice')).toHaveCount(0)
})
