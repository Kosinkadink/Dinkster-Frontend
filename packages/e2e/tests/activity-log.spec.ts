import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from './fixtures.js'
import { evidencePath } from './evidence-output.js'

const proofDir = process.env['DINKSTER_ACTIVITY_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

interface ProofLogEntry {
  readonly timestamp: number
  readonly severity: 'info' | 'warn' | 'error'
  readonly source: string
  readonly message: string
}

const entries = (count: number): readonly ProofLogEntry[] => Array.from({ length: count }, (_, index) => ({
  timestamp: Date.UTC(2026, 7, 16, 12, 30, index),
  severity: index === count - 1 || index % 13 === 0 ? 'error' : index % 7 === 0 ? 'warn' : 'info',
  source: index === count - 1
    ? 'Disconnected backend / GPU-87db989a-530b-1702-e17d-3edb75b378e6'
    : 'Local native backend',
  message: index === count - 1
    ? 'A deliberately long activity message with workflow/very-long-identifier/that-must-not-overlap-or-clip and enough text to wrap across the available panel width.'
    : `Fixture activity event ${index + 1}`,
}))

async function installFixture(page: Page): Promise<void> {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
}

async function setEntries(page: Page, value: readonly ProofLogEntry[]): Promise<void> {
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  await page.evaluate((next) => {
    const app = window.__dinksterTest!.app as unknown as {
      connection: { disconnect(): void }
      registerSchemas(schemas: readonly unknown[]): void
      logs: { set(entries: readonly ProofLogEntry[]): void }
    }
    app.registerSchemas([
      { type: 'EmptyImage', displayName: 'Empty Image', category: 'e2e', source: 'e2e', isOutputNode: false, items: [] },
      { type: 'PreviewImage', displayName: 'Preview Image', category: 'e2e', source: 'e2e', isOutputNode: true, items: [] },
    ])
    app.connection.disconnect()
    app.logs.set(next)
  }, value)
}

async function appendEntry(page: Page, entry: ProofLogEntry): Promise<void> {
  await page.evaluate((next) => {
    const app = window.__dinksterTest!.app as unknown as {
      logs: {
        get(): readonly ProofLogEntry[]
        set(entries: readonly ProofLogEntry[]): void
      }
    }
    app.logs.set([...app.logs.get(), next])
  }, entry)
}

async function capture(page: Page, name: string): Promise<void> {
  if (!proofDir) return
  await page.mouse.move(1000, 80)
  await page.screenshot({ path: join(proofDir, `${name}.png`), animations: 'disabled' })
}

test.beforeEach(async ({ page }) => {
  await installFixture(page)
})

test('mounted Activity chrome localizes without changing raw events or reader state', async ({ page, request }) => {
  let backendRequests = 0
  page.on('request', (sent) => {
    const path = new URL(sent.url()).pathname
    if (path === '/object_info' || path === '/system_stats' || path.startsWith('/api/')) backendRequests += 1
  })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const seeded = [entries(3)[2]!, ...entries(32).slice(3)]
  await setEntries(page, seeded)
  await page.getByTestId('logs-toggle').click()
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  const clearButton = page.getByTestId('logs-clear')
  await clearButton.click()

  const panel = page.locator('[data-testid="logs-panel"]:visible')
  const clearStatus = panel.locator('.activity-log-clear-status')
  await expect(panel).toHaveCount(1)
  await expect(clearStatus).toBeVisible()
  const log = panel.getByRole('log', { name: 'Activity events' })
  const rawRow = log.locator('.activity-log-row').first()
  await log.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll'))
    element.dataset['localeIdentity'] = 'activity-log'
  })
  await rawRow.evaluate((element) => { element.dataset['localeIdentity'] = 'raw-row' })
  await expect(clearButton).toBeFocused()
  await expect(clearStatus).toContainText('30 entries')
  const requestsBeforeLocale = backendRequests
  await page.screenshot({ path: evidencePath('issue-457', 'activity-log-i18n-en.png'), fullPage: true })

  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'activityLog.aria.contents': '[AKTIVITATSINHALT MIT LANGEM TESTTEXT]',
      'activityLog.aria.events': '[AKTIVITATSEREIGNISSE]',
      'activityLog.clearArmed': '[LOSCHEN AKTIV. ERNEUT LOSCHEN WAHLEN, UM {count, plural, one {# EINTRAG} other {# EINTRAGE}} ZU ENTFERNEN.]',
      'activityLog.empty.description': '[VERBINDUNGS-, SCHEMA- UND AUSFUHRUNGSEREIGNISSE ERSCHEINEN HIER.]',
      'activityLog.empty.title': '[NOCH KEINE AKTIVITAT]',
      'error': '[NICHT UBERSETZEN]',
      'Disconnected backend / GPU-87db989a-530b-1702-e17d-3edb75b378e6': '[NICHT UBERSETZEN]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  const retainedLog = page.locator('[data-locale-identity="activity-log"]')
  const retainedRow = page.locator('[data-locale-identity="raw-row"]')
  await expect(page.getByTestId('logs-panel')).toHaveAttribute('aria-label', '[AKTIVITATSINHALT MIT LANGEM TESTTEXT]')
  await expect(retainedLog).toHaveAttribute('aria-label', '[AKTIVITATSEREIGNISSE]')
  await expect(clearButton).toBeFocused()
  expect(await retainedLog.evaluate((element) => element.scrollTop)).toBe(0)
  await expect(clearStatus).toContainText('[LOSCHEN AKTIV. ERNEUT LOSCHEN WAHLEN, UM 30 EINTRAGE ZU ENTFERNEN.]')
  await expect(retainedRow.locator('time')).toHaveAttribute('datetime', '2026-08-16T12:30:02.000Z')
  await expect(retainedRow.locator('.activity-log-time')).toHaveText('2026-08-16 12:30:02.000 UTC')
  await expect(retainedRow.locator('.activity-log-severity')).toHaveText('error')
  await expect(retainedRow.locator('.activity-log-source')).toHaveText(seeded[0]!.source)
  await expect(retainedRow.locator('.activity-log-message')).toHaveText(seeded[0]!.message)
  expect(backendRequests).toBe(requestsBeforeLocale)
  await page.screenshot({ path: evidencePath('issue-457', 'activity-log-i18n-de-DE.png'), fullPage: true })

  await clearButton.click()
  await expect(retainedLog.locator('.activity-log-row')).toHaveCount(0)
  await expect(page.getByTestId('activity-log-empty')).toHaveText('[NOCH KEINE AKTIVITAT][VERBINDUNGS-, SCHEMA- UND AUSFUHRUNGSEREIGNISSE ERSCHEINEN HIER.]')
  await expect(clearButton).toBeFocused()
})

test('semantic rows and guarded Clear preserve exact activity facts', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 950 })
  await page.goto('/')
  const seeded = entries(3)
  await setEntries(page, seeded)
  await page.getByTestId('logs-toggle').click()

  const log = page.getByRole('log', { name: 'Activity events' })
  const rows = log.locator('.activity-log-row')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(2).locator('time')).toHaveAttribute('datetime', '2026-08-16T12:30:02.000Z')
  await expect(rows.nth(2).locator('.activity-log-time')).toHaveText('2026-08-16 12:30:02.000 UTC')
  await expect(rows.nth(2).locator('.activity-log-severity')).toHaveText('error')
  await expect(rows.nth(2).locator('.activity-log-source')).toHaveText(seeded[2]!.source)
  await expect(rows.nth(2).locator('.activity-log-message')).toHaveText(seeded[2]!.message)
  await capture(page, 'after-normal-1600x950')

  const clear = page.getByTestId('logs-clear')
  await clear.click()
  await expect(page.locator('.activity-log-clear-status')).toContainText('Choose Clear again within 4 seconds')
  await expect(rows).toHaveCount(3)
  await expect(clear).toBeFocused()
  await capture(page, 'after-clear-armed-1600x950')

  await expect(page.getByText('Clear is armed.')).toHaveCount(0, { timeout: 5000 })
  await clear.click()
  await expect(rows).toHaveCount(3)
  await expect(page.getByText('Clear is armed.')).toBeVisible()
  await clear.click()
  await expect(log).toHaveCount(1)
  await expect(rows).toHaveCount(0)
  await expect(page.getByTestId('activity-log-empty')).toContainText('No activity yet')
  await expect(clear).toBeFocused()
  await capture(page, 'after-empty-1600x950')

  await setEntries(page, entries(30))
  await expect(rows).toHaveCount(30)
  await expect.poll(() => log.evaluate((element) =>
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
  )).toBeLessThanOrEqual(1)
  await page.setViewportSize({ width: 1366, height: 768 })
  await expect.poll(() => log.evaluate((element) =>
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
  )).toBeLessThanOrEqual(1)
})

test('overflow, reader position, long content, narrow layout, and zoom remain contained', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/')
  const seeded = entries(45)
  await setEntries(page, seeded)
  await page.getByTestId('logs-toggle').click()

  const log = page.getByRole('log', { name: 'Activity events' })
  const rows = log.locator('.activity-log-row')
  await expect(rows).toHaveCount(45)
  await expect.poll(() => log.evaluate((element) =>
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
  )).toBeLessThanOrEqual(1)
  await log.focus()
  await expect(log).toBeFocused()
  await expect(log).toHaveCSS('touch-action', 'pan-y')

  await log.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll'))
  })
  await appendEntry(page, {
    timestamp: Date.UTC(2026, 7, 16, 13, 0, 0),
    severity: 'info',
    source: 'Tail source',
    message: 'This append must not steal a reader who scrolled upward.',
  })
  await expect(rows).toHaveCount(46)
  expect(await log.evaluate((element) => element.scrollTop)).toBe(0)

  await log.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll'))
  })
  await appendEntry(page, {
    timestamp: Date.UTC(2026, 7, 16, 13, 0, 1),
    severity: 'warn',
    source: 'Disconnected backend / retained-provenance-with-a-very-long-owner-identifier',
    message: 'Tail-following readers see this deliberately long append without clipping or losing the disconnected source identity.',
  })
  await expect(rows).toHaveCount(47)
  await expect.poll(() => log.evaluate((element) =>
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
  )).toBeLessThanOrEqual(1)

  await page.evaluate(() => {
    const message = document.querySelector('.activity-log-row:last-child .activity-log-message')!
    const selection = document.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(message)
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await capture(page, 'after-overflow-focus-selection-1366x768')

  await page.setViewportSize({ width: 1600, height: 950 })
  await capture(page, 'after-overflow-1600x950')

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      dock: { setOpen(zone: 'right', open: boolean): void }
    }
    app.dock.setOpen('right', false)
  })
  await page.setViewportSize({ width: 360, height: 640 })
  await expect(page.getByTestId('bottom-panel')).toBeVisible()
  await expect(rows.last().locator('.activity-log-source')).toBeVisible()
  await expect(rows.last().locator('.activity-log-message')).toBeVisible()
  await expect.poll(() => log.evaluate((element) =>
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
  )).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
  await capture(page, 'after-overflow-360x640')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 800, height: 475 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(800)
  await capture(page, 'after-overflow-200pct-layout-equivalent')
})
