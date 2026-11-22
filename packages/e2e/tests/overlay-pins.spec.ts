/**
 * execution UX implementation concurrent-execution UX: per-live-tab execution-overlay binding. A live
 * tab follows its lineage's newest run by default; pinning binds its canvas
 * overlay (progress/errors/previews/outputs) to one explicit run until the
 * user follows latest again. Pins are per tab and never cross lineages.
 * Runs against a REAL backend: every execution here is an actual prompt.
 */
import { expect, test, type Page } from './fixtures.js'

/** Queue the active tab and wait until the newest row reaches 'completed'. */
async function queueAndComplete(page: Page): Promise<void> {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.getByTestId('queue-button').click()
  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
}

const switchTab = (page: Page, title: string) =>
  page.getByTestId('tab-bar').locator('.tab', { hasText: title }).click()

/** The bridge's view of the pin map, as {tabId: promptId}. */
const pinsSnapshot = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...window.__dinksterTest!.app.overlayPins.get()].map(([tabId, ref]) => [tabId, ref.prompt]),
    ),
  )

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
})

test('pin holds an older run through new submissions; follow-latest releases it', async ({
  page,
}) => {
  await queueAndComplete(page)
  await queueAndComplete(page)

  const rows = page.getByTestId('execution-row')
  await expect(rows).toHaveCount(2)
  // Unpinned: the newest row is what the live tab's overlay shows.
  await expect(rows.nth(0)).toHaveAttribute('data-overlay', 'latest')
  await expect(rows.nth(1)).not.toHaveAttribute('data-overlay')
  const chip = page.getByTestId('sync-chip')
  await expect(chip).toHaveAttribute('data-overlay-mode', 'latest')

  // Pin the OLDER run. The pin control must not open a frozen view.
  const tabCount = await page.getByTestId('tab-bar').locator('.tab').count()
  await rows.nth(1).getByTestId('execution-pin').click()
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(tabCount)
  await expect(rows.nth(1)).toHaveAttribute('data-overlay', 'pinned')
  await expect(rows.nth(0)).not.toHaveAttribute('data-overlay')
  await expect(chip).toHaveAttribute('data-overlay-mode', 'pinned')
  await expect(chip).toContainText('pinned:')

  // A NEW run must not steal the overlay from the pin.
  await queueAndComplete(page)
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(2)).toHaveAttribute('data-overlay', 'pinned')
  await expect(rows.nth(0)).not.toHaveAttribute('data-overlay')
  await expect(chip).toHaveAttribute('data-overlay-mode', 'pinned')

  // Follow latest: the newest run overlays again.
  await page.getByTestId('sync-chip-follow-latest').click()
  await expect(chip).toHaveAttribute('data-overlay-mode', 'latest')
  await expect(rows.nth(0)).toHaveAttribute('data-overlay', 'latest')
  await expect(rows.nth(2)).not.toHaveAttribute('data-overlay')
  expect(await pinsSnapshot(page)).toEqual({})
})

test('pins are per tab, keyed to the run lineage, and survive tab switches', async ({ page }) => {
  // One run per lineage: Basic first, then Subgraph.
  await queueAndComplete(page)
  await switchTab(page, 'Subgraph')
  await queueAndComplete(page)

  const rows = page.getByTestId('execution-row')
  await expect(rows).toHaveCount(1)
  await expect(rows.first().locator('.execution-tab')).toHaveText('Subgraph')

  // The Subgraph queue cannot expose Basic controls. Switch to Basic before
  // pinning its run, then prove the pin remains isolated across tab changes.
  await switchTab(page, 'Basic')
  await expect(rows).toHaveCount(1)
  await expect(rows.first().locator('.execution-tab')).toHaveText('Basic')
  await rows.first().getByTestId('execution-pin').click()
  await expect(rows.first()).toHaveAttribute('data-overlay', 'pinned')
  const basicTabId = await page.evaluate(
    () => window.__dinksterTest!.app.tabs.get().find((t) => !t.execution && t.title === 'Basic')!.id,
  )
  expect(Object.keys(await pinsSnapshot(page))).toEqual([basicTabId])

  // The Subgraph tab still follows ITS latest, unaffected.
  await switchTab(page, 'Subgraph')
  await expect(rows.first().locator('.execution-tab')).toHaveText('Subgraph')
  await expect(page.getByTestId('sync-chip')).toHaveAttribute('data-overlay-mode', 'latest')

  // Switching to Basic shows the pinned chip; the pin persisted.
  await switchTab(page, 'Basic')
  await expect(page.getByTestId('sync-chip')).toHaveAttribute('data-overlay-mode', 'pinned')

  // The explicit Open action opens the frozen view without changing the pin.
  await rows.first().locator('.execution-open').click()
  await expect(page.getByTestId('tab-bar').locator('.tab.frozen.active')).toHaveCount(1)
  await expect(page.getByTestId('frozen-banner')).toBeVisible()
})
