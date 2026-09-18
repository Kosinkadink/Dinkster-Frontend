/**
 * Library collection browser: the shared paged grid/list surface over
 * built-in sources (Packs, History). Against the V1 e2e backend the packs
 * table is absent, so Packs exercises the text-first empty state while
 * History exercises search-over-corpus, activation (frozen view), and the
 * grid/list mode toggle.
 */
import { expect, selectProductOption, test, type Page } from './fixtures.js'

async function selectSource(page: Page, source: string): Promise<void> {
  const library = page.getByTestId('library-overlay')
  const sourceTab = library.locator(`[data-testid=collection-source][data-source=${source}]`)
  if (await sourceTab.isVisible()) await sourceTab.click()
  else await selectProductOption(page, library.getByTestId('library-source-select'), source)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
})

/** Queue the active tab and wait for the newest execution row to complete. */
async function queueAndComplete(page: Page): Promise<void> {
  await page.getByTestId('queue-button').click()
  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
}

test('library opens, packs is text-first empty on V1, history lists runs', async ({ page }) => {
  await queueAndComplete(page)

  await page.getByTestId('library-toggle').click()
  await expect(page.getByTestId('library-overlay')).toBeVisible()

  // Packs is the first source; a V1 backend has no packs table.
  await expect(page.getByTestId('collection-source').first()).toHaveAttribute('aria-pressed', 'true')
  const emptyPacks = page.getByTestId('collection-empty')
  await expect(emptyPacks).toContainText('No packs available')
  await expect(emptyPacks).toContainText('Local has not published any pack descriptors.')

  // History: the completed run appears with its status badge and total.
  await selectSource(page, 'history')
  const entry = page.getByTestId('collection-entry')
  await expect(entry).toHaveCount(1)
  await expect(entry.locator('.collection-badges')).toContainText('completed')
  await expect(page.getByTestId('collection-total')).toHaveText('1 of 1')

  // The toggle closes the overlay again; canvas state was never torn down.
  await page.getByTestId('library-toggle').click()
  await expect(page.getByTestId('library-overlay')).not.toBeVisible()
})

test('search queries the source (not the page) and clears back to browse', async ({ page }) => {
  await queueAndComplete(page)
  await page.getByTestId('library-toggle').click()
  await selectSource(page, 'history')
  await expect(page.getByTestId('collection-entry')).toHaveCount(1)

  await page.getByTestId('collection-search').fill('zzz-definitely-nothing')
  const noMatches = page.getByTestId('collection-empty')
  await expect(noMatches).toContainText('No matching local execution snapshots')
  await expect(noMatches).toContainText('Try a workflow, prompt, backend, or status identity.')

  await page.getByTestId('collection-search').fill('')
  await expect(page.getByTestId('collection-entry')).toHaveCount(1)
})

test('grid/list toggle switches layout mode', async ({ page }) => {
  await queueAndComplete(page)
  await page.getByTestId('library-toggle').click()
  await selectSource(page, 'history')

  await expect(page.getByTestId('collection-items')).toHaveAttribute('data-mode', 'list')
  await page.getByTestId('collection-mode').click()
  await expect(page.getByTestId('collection-items')).toHaveAttribute('data-mode', 'grid')
  await page.getByTestId('collection-mode').click()
  await expect(page.getByTestId('collection-items')).toHaveAttribute('data-mode', 'list')
})

test('activating a history entry opens its frozen view and closes the library', async ({ page }) => {
  await queueAndComplete(page)
  await page.getByTestId('library-toggle').click()
  await selectSource(page, 'history')

  await page.getByTestId('collection-entry').click()
  await expect(page.getByTestId('library-overlay')).not.toBeVisible()
  await expect(page.getByTestId('tab-bar').locator('.tab.frozen.active')).toHaveCount(1)
  await expect(page.getByTestId('frozen-banner')).toBeVisible()
})

test('a live refresh re-page does not drop keyboard focus from the list', async ({ page }) => {
  await queueAndComplete(page)
  await page.getByTestId('library-toggle').click()
  await selectSource(page, 'history')
  const entries = page.getByTestId('collection-entry')
  await expect(entries).toHaveCount(1)
  await entries.focus()
  await expect(entries).toBeFocused()

  // Queue another run WITHOUT touching the DOM (no click to steal focus):
  // its completion fires the library refresh tick, which re-pages the open
  // panel and replaces every row object. Focus must carry to the
  // replacement row instead of falling to <body>.
  await page.evaluate(() => { const app = window.__dinksterTest!.app; void app.queue(app.activeTab()!) })
  await expect(entries).toHaveCount(2, { timeout: 30_000 })
  await expect(page.locator('[data-testid=collection-entry]:focus')).toHaveCount(1)
})

test('Tab reaches the entry list and Enter activates it (roving tab index)', async ({ page }) => {
  await queueAndComplete(page)
  await page.getByTestId('library-toggle').click()
  await selectSource(page, 'history')
  await expect(page.getByTestId('collection-entry')).toHaveCount(1)

  // One Tab from the last toolbar control lands on the list's single tab
  // stop (the roving row) - rows must be keyboard-reachable, not only
  // programmatically focusable.
  await page.getByTestId('collection-mode').focus()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('collection-entry')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('library-overlay')).not.toBeVisible()
  await expect(page.getByTestId('frozen-banner')).toBeVisible()
})
