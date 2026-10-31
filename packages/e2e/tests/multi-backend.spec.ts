/**
 * Multi-backend execution through one shared store. The hosted harness exposes
 * the same native server through two frontend origins, so these tests
 * exercise two real connections with distinct connection ids/base urls.
 *
 * Contract under test: tab targeting is per-tab view state, executions are
 * keyed by (connection, prompt), the rail groups by backend only when more
 * than one exists, and outputs always route through the execution's OWN
 * backend - including after that backend is removed.
 */
import { expect, selectProductOption, test, type Page } from './fixtures.js'

const secondBackend = process.env['DINKSTER_E2E_NATIVE_FRONTEND']
if (!secondBackend) throw new Error('DINKSTER_E2E_NATIVE_FRONTEND must identify the second native frontend')

/** Queue the active tab and wait until a new row reaches 'completed'. */
async function queueAndComplete(page: Page, expectedRows: number): Promise<void> {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.getByTestId('queue-button').click()
  const rows = page.getByTestId('execution-row')
  await expect(rows).toHaveCount(expectedRows, { timeout: 10_000 })
  await expect(rows.first().locator('.execution-status')).toHaveText('Completed', {
    timeout: 30_000,
  })
}

/** Add the second origin through the panel UI and wait for schemas. */
async function addSecondBackend(page: Page): Promise<void> {
  await page.getByTestId('backends-toggle').click()
  await page.getByTestId('backend-url-input').fill(secondBackend!)
  await page.getByTestId('backend-add').click()
  const rows = page.getByTestId('backend-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(1)).toContainText(/Schemas\d+ available/, { timeout: 15_000 })
  await expect(rows.nth(1)).toContainText('Connected', { timeout: 15_000 })
}

const executionConnections = (page: Page) =>
  page.evaluate(() =>
    [...window.__dinksterTest!.app.store.executions.get().values()].map((e) => e.ref.connection),
  )

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
})

test('single backend shows none of the multi-backend chrome', async ({ page }) => {
  await expect(page.getByTestId('tab-target')).toHaveCount(0)
  await expect(page.getByTestId('statusbar-backend')).toHaveCount(0)
  await expect(page.getByTestId('backend-group')).toHaveCount(0)
  // The panel still opens and shows the one (unremovable) default backend.
  await page.getByTestId('backends-toggle').click()
  await expect(page.getByTestId('backend-row')).toHaveCount(1)
  await expect(page.getByTestId('backend-remove')).toHaveCount(0)
})

test('adding a backend connects it and reveals per-tab targeting', async ({ page }) => {
  await addSecondBackend(page)
  const rows = page.getByTestId('backend-row')
  await expect(rows.nth(1)).toContainText('Connected', { timeout: 15_000 })
  // Multi-backend chrome appears: topbar selector + statusbar label.
  await expect(page.getByTestId('tab-target')).toBeVisible()
  await expect(page.getByTestId('statusbar-backend')).toHaveText('Local')
  // Duplicate registration is rejected (still 2 rows).
  await page.getByTestId('backend-url-input').fill(`${secondBackend}/`)
  await page.getByTestId('backend-add').click()
  await expect(rows).toHaveCount(2)
})

test('tab targets are per tab; runs group by backend with distinct connections', async ({
  page,
}) => {
  await addSecondBackend(page)

  // Retarget the active tab; the other tab must stay on default.
  await selectProductOption(page, page.getByTestId('tab-target'), secondBackend!)
  const targets = await page.evaluate(() => [...window.__dinksterTest!.app.tabTargets.get().values()])
  expect(targets).toEqual([secondBackend])
  await expect(page.getByTestId('statusbar-backend')).toHaveText(secondBackend!)

  // Queue on the second origin, then retarget back to default and queue again.
  await queueAndComplete(page, 1)
  await selectProductOption(page, page.getByTestId('tab-target'), 'local')
  await queueAndComplete(page, 2)

  // Same server, same workflow - but two DISTINCT connection identities.
  const connections = await executionConnections(page)
  expect(new Set(connections).size).toBe(2)

  // The workflow-local rail groups its rows per backend without presenting
  // backend-wide queue depth as though it belonged to this workflow.
  const groups = page.getByTestId('backend-group')
  await expect(groups).toHaveCount(2)
  await expect(page.getByTestId('queue-rail').locator('.queue-remaining')).toHaveCount(0)
})

test('frozen views route outputs through the run backend, surviving removal', async ({ page }) => {
  const renditionUrls: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/values' && url.searchParams.has('rendition')) renditionUrls.push(url.href)
  })
  await addSecondBackend(page)
  await selectProductOption(page, page.getByTestId('tab-target'), secondBackend!)
  await queueAndComplete(page, 1)
  const run = await page.evaluate(() => [...window.__dinksterTest!.app.store.executions.get().values()][0]!.ref)
  expect(run.connection).toBe(secondBackend)

  // Open the frozen view of the second-origin run.
  await page.getByTestId('execution-row').first().locator('.execution-open').click()
  await expect(page.getByTestId('status-bar')).toContainText(secondBackend!)
  await page.getByRole('tab', { name: 'Outputs' }).click()
  const image = page.getByTestId('outputs-panel').locator('.output-thumbnail img').first()
  await expect.poll(() => image.evaluate((element) => ({
    width: (element as HTMLImageElement).naturalWidth, height: (element as HTMLImageElement).naturalHeight,
  })), { timeout: 15_000 }).toEqual({ width: 64, height: 64 })
  const src = await image.getAttribute('src')
  expect(src).toMatch(/^blob:/)
  expect(renditionUrls.length).toBeGreaterThan(0)

  // Removing the second origin keeps the history row and frozen image route.
  await page.getByTestId('backend-remove').click()
  await expect(page.getByTestId('backend-row')).toHaveCount(1)
  await expect(page.getByTestId('tab-target')).toHaveCount(0) // single-backend again
  await expect(page.getByTestId('execution-row')).toHaveCount(1)
  await expect(page.getByTestId('backend-group')).toHaveText(`${secondBackend} - backend removed or disconnected`)
  await test.info().attach('Removed backend outputs', {
    body: await page.screenshot({ path: test.info().outputPath('removed-backend-outputs.png'), animations: 'disabled' }), contentType: 'image/png',
  })
  await expect(image).toHaveAttribute('src', /^blob:/)
  expect(await image.evaluate((element) => ({
    width: (element as HTMLImageElement).naturalWidth, height: (element as HTMLImageElement).naturalHeight,
  }))).toEqual({ width: 64, height: 64 })
  for (const href of renditionUrls) {
    const url = new URL(href)
    expect(url.origin).toBe(secondBackend)
    expect(url.searchParams.get('jobId')).toBe(run.prompt)
    expect(['n0', 'n1']).toContain(url.searchParams.get('nodeId'))
  }
  // Live tabs fall back to the default backend.
  const targets = await page.evaluate(() => window.__dinksterTest!.app.tabTargets.get().size)
  expect(targets).toBe(0)
})
