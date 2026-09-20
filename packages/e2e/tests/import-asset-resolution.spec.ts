import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, selectProductOption, test, type Page } from './fixtures.js'

const evidenceDir = fileURLToPath(new URL('../../../docs/evidence/issue-41/', import.meta.url))
const MOCK = 'http://asset-guesses.test'
const RAW_MODEL = 'v1-5-pruned-emaonly-fp16.safetensors'
const RAW_IMAGE = 'missing.png'
const DIGEST = 'blake3:4c50ebc6e2a5cb19e8d19626d5ede1fb64755562085ce7383d86c72d1d03eb7e'
const MODEL_PATH = 'mounts/comfy-model-checkpoints-1/v1-5-pruned-emaonly-fp16.safetensors'
const MODEL_SIZE = 2_132_696_762
const IMAGE_REF = {
  digest: `blake3:${'b'.repeat(64)}`,
  name: RAW_IMAGE,
  size: 128,
  mediaType: 'image/png',
  virtualPath: `mounts/comfy-input/${RAW_IMAGE}`,
} as const

type Confidence = 'path' | 'name' | 'name-insensitive' | 'stem'
interface Candidate {
  digest: string
  name: string
  confidence: Confidence
  held: boolean
  virtualPath?: string
  size?: number
  mediaType?: string
}
type Guesses = Record<string, readonly Candidate[]>

const capture = async (page: Page, name: string): Promise<void> => {
  if (process.env['DINKSTER_CAPTURE_ISSUE_41'] === '1') {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.mouse.move(0, 0)
    await page.waitForTimeout(350)
    await page.screenshot({ path: `${evidenceDir}/${name}.png`, fullPage: true, animations: 'disabled' })
  }
}

test.beforeAll(() => mkdirSync(evidenceDir, { recursive: true }))

const workflow = (model = RAW_MODEL, image = RAW_IMAGE) => ({
  last_node_id: 2, last_link_id: 0,
  nodes: [
    { id: 1, type: 'TestModelLoader', pos: [50, 50], widgets_values: [model] },
    { id: 2, type: 'TestImageLoader', pos: [350, 50], widgets_values: [image] },
  ],
  links: [], groups: [], config: {}, extra: {}, version: 0.4,
})

const workflowWithDigest = (model = RAW_MODEL) => ({
  ...workflow(model),
  last_node_id: 1,
  nodes: workflow(model).nodes.slice(0, 1),
  models: [{ name: model.split(/[\\/]/).pop()!, url: 'https://example.test/model', hash: DIGEST.slice(7), hash_type: 'BLAKE3', directory: 'checkpoints' }],
})

const modelOnlyWorkflow = (model = RAW_MODEL) => ({
  ...workflow(model),
  last_node_id: 1,
  nodes: workflow(model).nodes.slice(0, 1),
})

async function setup(page: Page, guesses: Guesses): Promise<void> {
  await page.route(`${MOCK}/api/nodes*`, (route) => void route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'test', schemaWire: 1 },
    nodes: {
      TestModelLoader: { schemaVersion: 1, nodeType: 'TestModelLoader', displayName: 'Test Model Loader', interface: [{ role: 'input', id: 'model', type: { kind: 'asset', element: { kind: 'concrete', types: ['core.asset'] } }, widget: { type: 'ASSET', accept: ['*/*'] } }] },
      TestImageLoader: { schemaVersion: 1, nodeType: 'TestImageLoader', displayName: 'Test Image Loader', interface: [{ role: 'input', id: 'image', type: { kind: 'asset', element: { kind: 'concrete', types: ['core.asset'] } }, widget: { type: 'ASSET', accept: ['image/*'] } }] },
    },
  } }))
  await page.route(`${MOCK}/api/assets/guess`, async (route) => {
    const body = route.request().postDataJSON() as { names: string[] }
    await route.fulfill({ json: { matches: body.names.map((query) => ({ query, candidates: guesses[query] ?? [] })) } })
  })
  await page.goto('/')
  await page.getByTestId('backends-toggle').click()
  await page.getByTestId('backend-url-input').fill(MOCK)
  await page.getByTestId('backend-add').click()
  await selectProductOption(page, page.getByTestId('tab-target'), MOCK)
  await expect.poll(() => page.evaluate((url) => window.__dinksterTest!.app.backends.get().find((b) => b.baseUrl === url)?.registry.get()?.schemas.size, MOCK)).toBe(2)
}

const values = (page: Page) => page.evaluate(() => {
  const nodes = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes
  return { model: nodes.n1!.values.model, image: nodes.n2!.values.image }
})

const hasModelAssetBadValue = (page: Page) => page.evaluate(() => {
  const app = window.__dinksterTest!.app as unknown as {
    solveDiagnostics: { get(): ReadonlyArray<{ code: string; message: string }> }
  }
  return app.solveDiagnostics.get().some((entry) => entry.code === 'widget.ASSET.badValue' && entry.message.startsWith('n1.model:'))
})

test('auto-resolves an obvious path match and prompts only for leftovers', async ({ page }) => {
  await setup(page, { [RAW_MODEL]: [{
    digest: DIGEST, name: RAW_MODEL, confidence: 'path', held: true,
    virtualPath: MODEL_PATH, size: MODEL_SIZE, mediaType: 'application/octet-stream',
  }] })
  expect(await page.evaluate((json) => window.__dinksterTest!.app.openDocument(json, 'Assets'), workflow())).toEqual([])
  await page.evaluate((backendId) => {
    const app = window.__dinksterTest!.app
    app.setTabTarget(app.activeTab()!.id, backendId)
  }, MOCK)

  const dialog = page.getByTestId('import-asset-resolution-dialog')
  await expect(dialog).toBeVisible()
  const rows = page.getByTestId('import-asset-row')
  await expect(rows).toHaveCount(1)
  await expect(rows.filter({ hasText: RAW_IMAGE })).toContainText('No candidates returned')
  await expect(rows.filter({ hasText: RAW_IMAGE }).getByTestId('import-asset-reason')).toContainText('No complete local match')
  await expect(page.getByTestId('import-assets-selection-status')).toHaveText('0 replacements selected; 1 name remains unresolved.')
  await capture(page, 'after-import-some-auto-resolved')

  await page.getByTestId('import-assets-cancel').click()
  await expect(dialog).not.toBeVisible()
  expect(await values(page)).toEqual({ model: {
    digest: DIGEST, name: RAW_MODEL, size: MODEL_SIZE,
    mediaType: 'application/octet-stream', virtualPath: MODEL_PATH,
  }, image: RAW_IMAGE })
  await expect.poll(() => hasModelAssetBadValue(page)).toBe(false)
  const exported = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'n2', inputId: 'image', value: {
        digest: `blake3:${'b'.repeat(64)}`,
        name: 'missing.png',
        size: 128,
        mediaType: 'image/png',
        virtualPath: 'mounts/comfy-input/missing.png',
      } },
    })
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error('accepted assets did not compile')
    const prompt = (compiled.artifact as unknown as { prompt: Record<string, { inputs: Record<string, unknown> }> }).prompt
    return { document: app.exportDocument(tab.id), model: prompt.n1!.inputs.model }
  })
  expect(exported.model).toEqual({
    digest: DIGEST, name: RAW_MODEL, size: MODEL_SIZE,
    mediaType: 'application/octet-stream', virtualPath: MODEL_PATH,
  })
  expect(await values(page)).toEqual({ model: exported.model, image: IMAGE_REF })
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await values(page)).toEqual({ model: exported.model, image: RAW_IMAGE })
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await values(page)).toEqual({ model: RAW_MODEL, image: RAW_IMAGE })
  expect(await page.evaluate((document) => {
    const app = window.__dinksterTest!.app
    app.openDocument(document, 'Reopened assets')
    return app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values.model
  }, exported.document)).toEqual(exported.model)
})

test('digest and basename signals auto-resolve a subdirectory path without prompting', async ({ page }) => {
  const nested = `SD1.5/${RAW_MODEL}`
  await setup(page, { [RAW_MODEL]: [{
    digest: DIGEST, name: RAW_MODEL, confidence: 'path', held: true,
    virtualPath: MODEL_PATH, size: MODEL_SIZE, mediaType: 'application/octet-stream',
  }, {
    digest: `blake3:${'c'.repeat(64)}`, name: RAW_MODEL, confidence: 'path', held: true,
    virtualPath: `other/${RAW_MODEL}`, size: 1, mediaType: 'application/octet-stream',
  }] })
  await page.evaluate((json) => window.__dinksterTest!.app.openDocument(json, 'Nested digest'), workflowWithDigest(nested))
  await expect.poll(() => page.evaluate(() => typeof window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values.model === 'object')).toBe(true)
  await expect(page.getByTestId('import-asset-resolution-dialog')).not.toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values.model)).toEqual(
    expect.objectContaining({ digest: DIGEST, virtualPath: MODEL_PATH }),
  )
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(1)
  await capture(page, 'after-import-all-auto-resolved')
})

test('a unique exact-name digest auto-resolves without prompting', async ({ page }) => {
  await setup(page, { [RAW_MODEL]: [{
    digest: DIGEST, name: RAW_MODEL, confidence: 'name', held: true,
    virtualPath: MODEL_PATH, size: MODEL_SIZE, mediaType: 'application/octet-stream',
  }] })
  await page.evaluate((json) => window.__dinksterTest!.app.openDocument(json, 'Unique name'), modelOnlyWorkflow())
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(1)
  await expect(page.getByTestId('import-asset-resolution-dialog')).not.toBeVisible()
})

test('ambiguous collisions remain unresolved and show their reason', async ({ page }) => {
  await setup(page, { [RAW_MODEL]: [
    { digest: DIGEST, name: RAW_MODEL, confidence: 'path', held: true, virtualPath: MODEL_PATH, size: MODEL_SIZE, mediaType: 'application/octet-stream' },
    { digest: `blake3:${'c'.repeat(64)}`, name: RAW_MODEL, confidence: 'path', held: true, virtualPath: `other/${RAW_MODEL}`, size: 1, mediaType: 'application/octet-stream' },
  ] })
  await page.evaluate((json) => window.__dinksterTest!.app.openDocument(json, 'Ambiguous'), workflow())
  const row = page.getByTestId('import-asset-row').filter({ hasText: RAW_MODEL })
  await expect(row.getByTestId('import-asset-reason')).toContainText('Multiple different assets match')
  await expect(row).toContainText(DIGEST)
  await expect(row).toContainText(MODEL_PATH)
  expect((await values(page)).model).toBe(RAW_MODEL)
  await capture(page, 'after-import-ambiguous')
})

test('keeps incomplete candidates visible but disabled and unresolved', async ({ page }) => {
  await setup(page, { [RAW_MODEL]: [{ digest: DIGEST, name: RAW_MODEL, confidence: 'path', held: true }] })
  await page.evaluate((json) => window.__dinksterTest!.app.openDocument(json, 'Incomplete asset'), workflow())
  const row = page.getByTestId('import-asset-row').filter({ hasText: RAW_MODEL })
  await expect(row.getByRole('radio', { name: /v1-5-pruned-emaonly-fp16\.safetensors/ })).toBeDisabled()
  await expect(row).toContainText('Incomplete asset metadata - cannot select.')
  await expect(row.getByRole('radio', { name: /Leave unresolved/ })).toHaveAttribute('aria-checked', 'true')
  await capture(page, 'after-import-incomplete-disabled')
})

test('Escape cancels without mutation and restores focus to the opener', async ({ page }) => {
  await setup(page, { [RAW_MODEL]: [{ digest: DIGEST, name: RAW_MODEL, confidence: 'name', held: true, size: MODEL_SIZE, mediaType: 'application/octet-stream' }] })
  const opener = page.getByRole('button', { name: 'New workflow' })
  await opener.focus()
  await page.evaluate((json) => window.__dinksterTest!.app.openDocument(json, 'Cancel assets'), workflow())
  const dialog = page.getByTestId('import-asset-resolution-dialog')
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(() => document.querySelector('[data-testid="import-asset-resolution-dialog"]')!.contains(document.activeElement))).toBe(true)
  await opener.focus()
  expect(await page.evaluate(() => document.querySelector('[data-testid="import-asset-resolution-dialog"]')!.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(opener).toBeFocused()
  expect(await values(page)).toEqual({ model: RAW_MODEL, image: RAW_IMAGE })
})

test('backdrop cancels without mutation and restores focus to the opener', async ({ page }) => {
  await setup(page, { [RAW_MODEL]: [{ digest: DIGEST, name: RAW_MODEL, confidence: 'name', held: true, size: MODEL_SIZE, mediaType: 'application/octet-stream' }] })
  const opener = page.getByRole('button', { name: 'New workflow' })
  await opener.focus()
  await page.evaluate((json) => window.__dinksterTest!.app.openDocument(json, 'Backdrop assets'), workflow())
  const dialog = page.getByTestId('import-asset-resolution-dialog')
  await expect(dialog).toBeVisible()
  await page.mouse.click(2, 2)
  await expect(dialog).not.toBeVisible()
  await expect(opener).toBeFocused()
  expect(await values(page)).toEqual({ model: RAW_MODEL, image: RAW_IMAGE })
})

test('shows stem candidates unresolved with a caution', async ({ page }) => {
  const stemName = 'cat.ckpt'
  await setup(page, { [stemName]: [{ digest: DIGEST, name: 'cat.safetensors', confidence: 'stem', held: false }] })
  await page.evaluate((json) => window.__dinksterTest!.app.openDocument(json, 'Stem asset'), workflow(stemName))
  const stemRow = page.getByTestId('import-asset-row').filter({ hasText: stemName })
  await expect(stemRow.getByRole('radio', { name: /Leave unresolved/ })).toHaveAttribute('aria-checked', 'true')
  await expect(stemRow.getByRole('radio', { name: /cat\.safetensors/ })).toHaveAttribute('aria-checked', 'false')
  await expect(stemRow).toContainText('Different extension - verify this is the right asset.')
  await capture(page, 'after-import-weak-warning')
  await page.getByTestId('import-assets-cancel').click()
})

test('opens with no-match rows when every name is unmatched', async ({ page }) => {
  await setup(page, {})
  await page.evaluate((json) => window.__dinksterTest!.app.openDocument(json, 'No matches'), workflow())
  const rows = page.getByTestId('import-asset-row')
  await expect(rows).toHaveCount(2)
  await expect(rows).toHaveText([new RegExp(`${RAW_MODEL}.*No candidates returned`), new RegExp(`${RAW_IMAGE}.*No candidates returned`)])
  await capture(page, 'after-import-no-matches')
})

test('stages multiple choices and accepts them as one atomic batch and undo', async ({ page }) => {
  await setup(page, {
    [RAW_MODEL]: [{
      digest: DIGEST, name: RAW_MODEL, confidence: 'stem', held: false,
      virtualPath: MODEL_PATH, size: MODEL_SIZE, mediaType: 'application/octet-stream',
    }],
    [RAW_IMAGE]: [{ ...IMAGE_REF, confidence: 'stem', held: true }],
  })
  await page.evaluate((json) => window.__dinksterTest!.app.openDocument(json, 'Atomic choices'), workflow())
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })
  const before = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  const rows = page.getByTestId('import-asset-row')
  await rows.filter({ hasText: RAW_MODEL }).getByRole('radio', { name: new RegExp(RAW_MODEL) }).last().click()
  await rows.filter({ hasText: RAW_IMAGE }).getByRole('radio', { name: new RegExp(RAW_IMAGE) }).last().click()
  await expect(page.getByTestId('import-assets-selection-status')).toHaveText('2 replacements selected; 0 names remain unresolved.')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(before)
  expect(await values(page)).toEqual({ model: RAW_MODEL, image: RAW_IMAGE })
  await capture(page, 'after-import-staged-all')

  await page.getByTestId('import-assets-accept').click()
  await expect(page.getByTestId('import-asset-resolution-dialog')).not.toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(before + 1)
  expect(await values(page)).toEqual({
    model: { digest: DIGEST, name: RAW_MODEL, size: MODEL_SIZE, mediaType: 'application/octet-stream', virtualPath: MODEL_PATH },
    image: IMAGE_REF,
  })
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await values(page)).toEqual({ model: RAW_MODEL, image: RAW_IMAGE })
})

test('lookup failure stays out of the dialog and reports through Problems', async ({ page }) => {
  await setup(page, {})
  await page.route(`${MOCK}/api/assets/guess`, (route) => route.fulfill({ status: 500, body: 'resolver unavailable' }))
  await page.evaluate((json) => window.__dinksterTest!.app.openDocument(json, 'Resolver failure'), workflow())
  await expect(page.getByTestId('import-asset-resolution-dialog')).not.toBeVisible()
  await expect(page.getByTestId('problems-panel')).toContainText('import.assets.guessFailed')
  await expect(page.getByTestId('problems-panel')).toContainText('POST /api/assets/guess failed: 500')
  await capture(page, 'after-import-failure-problems')
})

test('closing an import while lookup is in flight prevents a stale decision', async ({ page }) => {
  await setup(page, {})
  let started = false
  let finished = false
  let release!: () => void
  await page.route(`${MOCK}/api/assets/guess`, async (route) => {
    started = true
    await new Promise<void>((resolve) => { release = resolve })
    const body = route.request().postDataJSON() as { names: string[] }
    await route.fulfill({ json: { matches: body.names.map((query) => ({ query, candidates: [] })) } })
    finished = true
  })
  await page.evaluate((json) => window.__dinksterTest!.app.openDocument(json, 'Closed lookup'), workflow())
  await expect.poll(() => started).toBe(true)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { activeTab(): { id: string }; closeTab(id: string): void }
    app.closeTab(app.activeTab().id)
  })
  release()
  await expect.poll(() => finished).toBe(true)
  await expect(page.getByTestId('import-asset-resolution-dialog')).not.toBeVisible()
})

test('narrow, reduced-motion, and 200 percent zoom keep long candidates and the footer reachable', async ({ page }) => {
  const candidates = Array.from({ length: 4 }, (_, index): Candidate => ({
    digest: `blake3:${String(index + 1).repeat(64)}`,
    name: `A-very-long-candidate-name-${index + 1}.safetensors`,
    confidence: index === 3 ? 'stem' : 'path',
    held: index % 2 === 0,
    virtualPath: `mounts/checkpoints/a-very-long-provider-directory/candidate-${index + 1}.safetensors`,
    size: MODEL_SIZE + index,
    mediaType: 'application/x-safetensors',
  }))
  await setup(page, { [RAW_MODEL]: candidates, [RAW_IMAGE]: candidates.map((candidate, index) => ({ ...candidate, digest: `blake3:${String(index + 5).repeat(64)}`, name: `Image candidate ${index + 1}.png` })) })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate((json) => window.__dinksterTest!.app.openDocument(json, 'Long candidates'), workflow())
  const dialog = page.getByTestId('import-asset-resolution-dialog')
  await expect(dialog).toBeVisible()
  const bounds = await dialog.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  expect(await dialog.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0)
  await capture(page, 'after-import-narrow')
  await page.getByTestId('import-asset-row').last().getByRole('radio').last().scrollIntoViewIfNeeded()
  await expect(page.getByTestId('import-asset-row').last().getByRole('radio').last()).toBeInViewport()
  await expect(dialog.locator('.product-action-footer')).toBeInViewport()
  await capture(page, 'after-import-narrow-tail')

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => { document.documentElement.style.zoom = '2' })
  const zoomBounds = await dialog.boundingBox()
  expect(zoomBounds).not.toBeNull()
  expect(zoomBounds!.x).toBeGreaterThanOrEqual(0)
  expect(zoomBounds!.x + zoomBounds!.width).toBeLessThanOrEqual(1440)
  await page.getByTestId('import-asset-row').last().getByRole('radio').last().scrollIntoViewIfNeeded()
  await expect(page.getByTestId('import-asset-row').last().getByRole('radio').last()).toBeInViewport()
  await expect(dialog.locator('.product-action-footer')).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await capture(page, 'after-import-zoom-200')
})
