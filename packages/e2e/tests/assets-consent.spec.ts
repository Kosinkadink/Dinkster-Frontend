import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from './fixtures.js'
import { evidencePath, evidenceGroupDir } from './evidence-output.js'

const digest = (character: string) => `blake3:${character.repeat(64)}`
const plans = {
  fetchable: [
    { digest: digest('a'), name: 'A very long production checkpoint filename that must remain readable at every viewport size.safetensors', status: 'missing', sources: ['https://models.example/collections/production/first'], fetchable: true, kind: 'model/checkpoint', size: 7_654_321_098 },
    { digest: digest('b'), name: 'Second model', status: 'missing', sources: ['https://cdn.example/second'], fetchable: true, packagedFrom: ['RAW Pack ID'], detail: 'The backend will verify this exact digest after download.' },
  ],
  blocked: [{ digest: digest('c'), name: 'Private unresolvable model', status: 'missing', sources: [], fetchable: false, kind: 'model/checkpoint', detail: 'No provider declared a downloadable source for this exact digest.' }],
} as const

async function prepare(page: Page): Promise<void> {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'asset-consent-e2e', schemaWire: 1 }, nodes: {},
  } }))
  await page.route('/api/diagnostics*', (route) => route.fulfill({ json: { diagnostics: [] } }))
  await page.route('**/api/assets', (route) => route.fulfill({ status: 404, body: 'source document storage unavailable in isolated proof' }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined)).toBe(true)
  await page.evaluate(() => {
    window.__dinksterTest!.app.registerSchemas([{
      type: 'AssetConsentOutput', displayName: 'Asset consent output', category: 'test', source: 'v3', isOutputNode: true, items: [],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'asset-consent-e2e', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { output: { id: 'output', type: 'AssetConsentOutput', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { output: { position: { x: 100, y: 100 } } } } } },
    } as never, 'Consent')
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab?.id === 'asset-consent-e2e' && 'status' in tab.store
  })
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
}

async function submitSelection(page: Page): Promise<void> {
  await page.getByTestId('queue-button').focus()
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    void app.queueSelection(app.activeTab()!, ['output'])
  })
}

const capture = async (page: Page, name: string): Promise<void> => {
  if (process.env['DINKSTER_CAPTURE_ISSUE_41'] === '1') {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.mouse.move(0, 0)
    await page.waitForTimeout(350)
    await page.screenshot({ path: `evidencePath('issue-41', '${name}.png')`, fullPage: true, animations: 'disabled' })
  }
}


test('selects exact digests, updates the mounted locale, and closes after successful consent retry', async ({ page }) => {
  await prepare(page)
  const bodies: Record<string, unknown>[] = []
  await page.route('**/api/jobs', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    bodies.push(body)
    await route.fulfill({ status: bodies.length === 1 ? 409 : 200, contentType: 'application/json', body: JSON.stringify(bodies.length === 1 ? { error: 'assets-missing', assets: plans.fetchable } : { ok: true }) })
  })
  await submitSelection(page)
  await expect(page.getByTestId('asset-consent-row')).toHaveCount(2)
  const second = page.getByTestId('asset-consent-checkbox').nth(1)
  await expect(second).toHaveAttribute('aria-checked', 'true')
  await second.click()
  await expect(second).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByTestId('asset-consent-selection-status')).toHaveText('1 of 2 available assets selected.')
  await expect(page.getByTestId('asset-consent-dialog')).toContainText(digest('a'))
  const dialog = page.getByTestId('asset-consent-dialog')
  const first = page.getByTestId('asset-consent-checkbox').first()
  await first.evaluate((element) => { element.dataset['localeIdentity'] = 'retained' })
  await first.focus()
  if (process.env['DINKSTER_CAPTURE_ISSUE_457'] === '1') {
    mkdirSync(evidenceGroupDir('issue-457'), { recursive: true })
    await page.screenshot({ path: `evidencePath('issue-457', 'asset-consent-i18n-en.png')`, animations: 'disabled' })
  }
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { settings: { set(id: string, value: unknown): void } }
    app.settings.set('dinkster.locale', 'zh')
  })
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh')
  await expect(dialog).toHaveAttribute('aria-label', '\u67e5\u770b\u5e76\u83b7\u53d6\u7f3a\u5931\u8d44\u4ea7')
  await expect(dialog).toContainText('\u83b7\u53d6\u7f3a\u5931\u8d44\u4ea7')
  await expect(dialog).toContainText('\u4ece models.example \u4e0b\u8f7d')
  await expect(dialog).toContainText('\u968f\u5305 RAW Pack ID \u63d0\u4f9b')
  await expect(dialog).toContainText(plans.fetchable[0].name)
  await expect(dialog).toContainText('model/checkpoint')
  await expect(dialog).toContainText('missing')
  await expect(dialog).toContainText('RAW Pack ID')
  await expect(dialog).toContainText('The backend will verify this exact digest after download.')
  await expect(first).toHaveAttribute('data-locale-identity', 'retained')
  await expect(first).toBeFocused()
  await expect(first).toHaveAttribute('aria-checked', 'true')
  await expect(second).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByTestId('asset-consent-selection-status')).toHaveText('\u5728 2 \u4e2a\u53ef\u7528\u8d44\u4ea7\u4e2d\u5df2\u9009\u62e9 1 \u4e2a\u3002')
  expect(bodies).toHaveLength(1)
  if (process.env['DINKSTER_CAPTURE_ISSUE_457'] === '1') {
    await page.screenshot({ path: `evidencePath('issue-457', 'asset-consent-i18n-zh.png')`, animations: 'disabled' })
  }
  await capture(page, 'after-consent-wide-mixed')
  await page.getByTestId('asset-consent-acquire').click()
  await expect(page.getByTestId('asset-consent-dialog')).not.toBeVisible()
  await expect(page.getByTestId('queue-button')).toBeFocused()
  expect(bodies).toHaveLength(2)
  expect(bodies[1]!['acquireAssets']).toEqual([digest('a')])
  const { acquireAssets: _ignored, ...retryBase } = bodies[1]!
  expect(retryBase).toEqual(bodies[0])
})

test('cancel dismisses without resubmitting', async ({ page }) => {
  await prepare(page)
  let requests = 0
  await page.route('**/api/jobs', async (route) => { requests++; await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'assets-missing', assets: plans.fetchable }) }) })
  await submitSelection(page)
  await expect(page.getByTestId('asset-consent-dialog')).toBeVisible()
  expect(await page.evaluate(() => document.querySelector('[data-testid="asset-consent-dialog"]')!.contains(document.activeElement))).toBe(true)
  await page.getByTestId('queue-button').focus()
  expect(await page.evaluate(() => document.querySelector('[data-testid="asset-consent-dialog"]')!.contains(document.activeElement))).toBe(true)
  await page.getByTestId('asset-consent-cancel').click()
  await expect(page.getByTestId('asset-consent-dialog')).not.toBeVisible()
  await expect(page.getByTestId('queue-button')).toBeFocused()
  expect(requests).toBe(1)
})

test('all-unresolvable plan disables acquisition', async ({ page }) => {
  await prepare(page)
  await page.route('**/api/jobs', async (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'assets-missing', assets: plans.blocked }) }))
  await submitSelection(page)
  await expect(page.getByTestId('asset-consent-acquire')).toBeDisabled()
  await expect(page.getByTestId('asset-consent-dialog')).toContainText('None of these exact assets has a downloadable source')
  await expect(page.getByTestId('asset-consent-row')).toHaveAttribute('data-state', 'unresolvable')
  await capture(page, 'after-consent-unresolvable')
})

test('busy acquisition blocks incidental dismissal but explicit Dismiss does not cancel the retry', async ({ page }) => {
  await prepare(page)
  let releaseRetry!: () => void
  let calls = 0
  let retryBody: Record<string, unknown> | undefined
  await page.route('**/api/jobs', async (route) => {
    calls += 1
    if (calls === 1) {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'assets-missing', assets: plans.fetchable }) })
      return
    }
    retryBody = route.request().postDataJSON() as Record<string, unknown>
    await new Promise<void>((resolve) => { releaseRetry = resolve })
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })
  await submitSelection(page)
  const choices = page.getByTestId('asset-consent-checkbox')
  await choices.nth(1).click()
  await expect(page.getByTestId('asset-consent-selection-status')).toHaveText('1 of 2 available assets selected.')
  await page.getByTestId('asset-consent-acquire').click()
  const dialog = page.getByTestId('asset-consent-dialog')
  await expect(dialog).toHaveAttribute('aria-label', 'Review and acquire missing assets')
  await expect(dialog.locator('[aria-busy="true"]')).toBeVisible()
  await expect(choices.nth(0)).toHaveAttribute('aria-checked', 'true')
  await expect(choices.nth(1)).toHaveAttribute('aria-checked', 'false')
  await expect(dialog.getByTestId('asset-consent-selected-count')).toHaveText('1')
  await expect(dialog.getByTestId('asset-consent-selection-status')).toHaveText('Acquiring 1 selected asset and retrying the queued request.')
  await expect.poll(() => retryBody?.['acquireAssets']).toEqual([digest('a')])
  await expect(dialog.getByTestId('modal-close')).toBeDisabled()
  await expect(dialog.getByTestId('asset-consent-acquire')).toBeDisabled()
  await expect(dialog.getByTestId('asset-consent-progress')).toContainText('does not cancel the retry')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await page.mouse.click(2, 2)
  await expect(dialog).toBeVisible()
  await capture(page, 'after-consent-busy')
  await dialog.getByTestId('asset-consent-cancel').click()
  await expect(dialog).not.toBeVisible()
  releaseRetry()
  await expect.poll(() => calls).toBe(2)
  await expect(dialog).not.toBeVisible()
})

test('a repeated missing response replaces the plan and resets staged choices', async ({ page }) => {
  await prepare(page)
  let calls = 0
  await page.route('**/api/jobs', async (route) => {
    calls += 1
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'assets-missing', assets: calls === 1 ? [plans.fetchable[0]] : [plans.fetchable[1], ...plans.blocked] }),
    })
  })
  await submitSelection(page)
  await page.getByTestId('asset-consent-acquire').click()
  await expect(page.getByTestId('asset-consent-row')).toHaveCount(2)
  await expect(page.getByTestId('asset-consent-dialog')).toContainText('Second model')
  await expect(page.getByTestId('asset-consent-dialog')).not.toContainText(plans.fetchable[0].name)
  await expect(page.getByTestId('asset-consent-selection-status')).toHaveText('1 of 1 available asset selected.')
})

test('retry failure closes the decision and remains visible in Problems', async ({ page }) => {
  await prepare(page)
  let calls = 0
  await page.route('**/api/jobs', async (route) => {
    calls += 1
    await route.fulfill(calls === 1
      ? { status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'assets-missing', assets: plans.fetchable }) }
      : { status: 422, contentType: 'application/json', body: JSON.stringify({ diagnostics: [{ severity: 'error', origin: 'validation', code: 'asset.acquireFailed', message: 'The selected provider refused acquisition.' }] }) })
  })
  await submitSelection(page)
  await page.getByTestId('asset-consent-acquire').click()
  await expect(page.getByTestId('asset-consent-dialog')).not.toBeVisible()
  await expect(page.getByTestId('problems-panel')).toContainText('asset.acquireFailed')
  await expect(page.getByTestId('problems-panel')).toContainText('The selected provider refused acquisition.')
  await capture(page, 'after-consent-failure-problems')
})

test('narrow and 200 percent zoom retain long metadata and the scroll tail', async ({ page }) => {
  await prepare(page)
  await page.route('**/api/jobs', async (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
    error: 'assets-missing',
    assets: [...plans.fetchable, ...plans.blocked, ...Array.from({ length: 5 }, (_, index) => ({
      ...plans.fetchable[1], digest: digest(String(index + 1)), name: `Additional required model ${index + 1}.safetensors`,
    }))],
  }) }))
  await page.setViewportSize({ width: 390, height: 844 })
  await submitSelection(page)
  const dialog = page.getByTestId('asset-consent-dialog')
  const bounds = await dialog.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await capture(page, 'after-consent-narrow')
  await dialog.getByTestId('asset-consent-row').last().scrollIntoViewIfNeeded()
  await expect(dialog.getByTestId('asset-consent-row').last()).toBeInViewport()
  await expect(dialog.locator('.product-action-footer')).toBeInViewport()
  await capture(page, 'after-consent-narrow-tail')

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => { document.documentElement.style.zoom = '2' })
  const zoomBounds = await dialog.boundingBox()
  expect(zoomBounds).not.toBeNull()
  expect(zoomBounds!.x).toBeGreaterThanOrEqual(0)
  expect(zoomBounds!.x + zoomBounds!.width).toBeLessThanOrEqual(1440)
  await dialog.getByTestId('asset-consent-row').last().scrollIntoViewIfNeeded()
  await expect(dialog.getByTestId('asset-consent-row').last()).toBeInViewport()
  await expect(dialog.locator('.product-action-footer')).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await capture(page, 'after-consent-zoom-200')
})
