/** Library collections stay separate from execution history in Runs. */
import { expect, test, waitForStartupOwnership } from './fixtures.js'

test('Library keeps the pack empty state and does not duplicate Runs history', async ({ page }) => {
  await page.route('/api/nodes*', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json(), packs: {} } })
  })
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await waitForStartupOwnership(page)
  const library = page.getByTestId('library-overlay')
  await page.getByTestId('library-toggle').click()
  await expect(library).toBeVisible()
  await expect(library.getByTestId('collection-source').first()).toHaveAttribute('aria-pressed', 'true')
  const emptyPacks = library.getByTestId('collection-empty')
  await expect(emptyPacks).toContainText('No packs available')
  await expect(emptyPacks).toContainText('Local has not published any pack descriptors.')
  await expect(library.locator('[data-testid=collection-source][data-source=history]')).toHaveCount(0)
  await expect(library.locator('[data-testid=collection-source][data-source=runs]')).toHaveCount(0)
  await page.getByTestId('library-toggle').click()
  await expect(library).not.toBeVisible()
})
