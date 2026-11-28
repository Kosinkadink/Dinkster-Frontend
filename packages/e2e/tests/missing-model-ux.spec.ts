import { expect, nativeTest as test, waitForWorkspaceReady, type Page } from './fixtures.js'

const REQUESTED = 'models/checkpoints/audit-definitely-missing-model.safetensors'

test.skip(process.env['DINKSTER_E2E_USE_NATIVE'] !== '1', 'requires isolated same-origin native backend proof')

async function openAssetEditor(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    renderer.setViewport({ x: 0, y: 0, scale: 1 })
    const node = renderer.getScene().nodes.find((item) => item.id === 'n1')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'model')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + node.x + node.layout.width / 2,
      y: rect.top + node.y + row.y + row.height / 2,
    }
  })
  await page.getByTestId('graph-canvas').focus()
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('asset-editor')).toBeVisible()
}

const currentValue = (page: Page) => page.evaluate(() =>
  window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values.model,
)

test('unresolved imported model is actionable, cancel-safe, mappable, undoable, and stable across reopen', async ({ page }) => {
  const guessBodies: string[][] = []
  const entryUrls: string[] = []
  const requestedUrls: string[] = []
  page.on('request', (request) => {
    requestedUrls.push(request.url())
    const url = new URL(request.url())
    if (url.pathname === '/api/assets/guess') {
      const body = request.postDataJSON() as { names: string[] }
      guessBodies.push(body.names)
    }
    if (url.pathname.endsWith('/entries')) entryUrls.push(request.url())
  })

  await page.goto('/')
  await waitForWorkspaceReady(page)
  const checkpointResponse = await page.request.get('/api/mounts/checkpoints/entries?kind=model/checkpoint')
  expect(checkpointResponse.ok()).toBe(true)
  const checkpointEntries = await checkpointResponse.json() as { entries: Array<Record<string, unknown>> }
  const checkpoint = checkpointEntries.entries.find((entry) => entry['name'] === 'audit-local-checkpoint.safetensors')
  expect(checkpoint).toBeDefined()
  const checkpointRef = {
    digest: checkpoint!['digest'], name: checkpoint!['name'], size: checkpoint!['size'],
    mediaType: checkpoint!['mediaType'], virtualPath: checkpoint!['virtualPath'],
  }
  await page.evaluate(async (requested) => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'auditModelLoader', displayName: 'audit Model Loader', category: 'test', source: 'v3', isOutputNode: false,
      body: [{
        kind: 'input', id: 'model', type: { kind: 'concrete', name: 'ASSET' }, optional: false,
        widget: {
          widgetType: 'ASSET', kind: 'model/checkpoint',
          options: { accept: ['application/x-safetensors', 'application/octet-stream'] }, default: null,
        },
      }],
    }])
    await app.openDocument({
      last_node_id: 1, last_link_id: 0,
      nodes: [{ id: 1, type: 'auditModelLoader', pos: [120, 100], widgets_values: [requested] }],
      links: [], groups: [], config: {}, extra: {}, version: 0.4,
    }, 'audit imported missing model')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, REQUESTED)

  const importDialog = page.getByTestId('import-asset-resolution-dialog')
  await expect(importDialog).toBeVisible()
  await page.getByTestId('import-assets-cancel').click()
  await expect(importDialog).not.toBeVisible()

  await expect.poll(() => page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return app.problems.get().map(({ code, severity, message }) => ({ code, severity, message }))
  })).toContainEqual({
    code: 'model.availability.invalid', severity: 'error',
    message: `${REQUESTED} is not a plain file name, so the model cannot be looked up.`,
  })
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return app.problems.get().find((entry) => entry.code === 'model.availability.invalid')?.message
  })).toContain('audit-definitely-missing-model.safetensors')
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { solveDiagnostics: { get(): ReadonlyArray<{ code: string }> } }
    return app.solveDiagnostics.get().some((entry) => entry.code === 'widget.ASSET.badValue')
  })).toBe(false)
  await expect.poll(() => page.evaluate(() =>
    (window.__dinksterTest!.renderer!.getBadges().n1 ?? []).map((badge) => badge.id),
  )).toContain('core.problem.error')

  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await openAssetEditor(page)
  const editor = page.getByTestId('asset-editor')
  const details = editor.getByTestId('asset-unresolved-import')
  await expect(details).toContainText(REQUESTED)
  await expect(details).toContainText('audit-definitely-missing-model.safetensors')
  await expect(details).toContainText('model/checkpoint')
  await expect(details).toContainText('application/x-safetensors, application/octet-stream')
  await expect(details.getByTestId('asset-not-on-disk')).toHaveText('Not on disk. A download is offered when the workflow runs.')
  await expect(editor.getByText('Download unavailable', { exact: true })).toHaveCount(0)
  await expect(editor.getByTestId('asset-download')).toHaveCount(0)

  const guessesBeforeRetry = guessBodies.length
  await details.getByTestId('asset-retry-match').click()
  await expect.poll(() => guessBodies.length).toBe(guessesBeforeRetry + 1)
  expect(guessBodies.at(-1)).toEqual([REQUESTED])
  await expect(details).toContainText('No exact local matches')
  await page.keyboard.press('Escape')
  await expect(editor).not.toBeVisible()
  expect(await currentValue(page)).toBe(REQUESTED)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)

  await openAssetEditor(page)
  await expect(page.getByRole('option', { name: /audit-local-checkpoint\.safetensors/ })).toBeVisible()
  await page.getByRole('option', { name: /audit-local-checkpoint\.safetensors/ }).click()
  await page.getByTestId('asset-apply').click()
  await expect(editor).not.toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)
  expect(await currentValue(page)).toEqual(checkpointRef)
  expect(entryUrls.some((url) => new URL(url).searchParams.get('kind') === 'model/checkpoint')).toBe(true)

  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await currentValue(page)).toBe(REQUESTED)
  await expect.poll(() => page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return app.problems.get().some((entry) => entry.code === 'model.availability.invalid')
  })).toBe(true)

  const exported = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return app.exportDocument(app.activeTab()!.id)
  })
  expect(await page.evaluate(async (document) => {
    const app = window.__dinksterTest!.app
    await app.openDocument(document, 'audit reopened missing model')
    return app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values.model
  }, exported)).toBe(REQUESTED)
  await expect.poll(() => page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return app.problems.get().some((entry) => entry.code === 'model.availability.invalid')
  })).toBe(true)
  expect(requestedUrls.some((url) => url.includes('audit-definitely-missing-model.safetensors'))).toBe(false)
})

test('a real missing model opens standalone review without posting a workflow', async ({ page }) => {
  const posts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(new URL(request.url()).pathname)
  })
  await page.goto('/')
  await waitForWorkspaceReady(page)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'StandaloneModelReview', displayName: 'Load checkpoint', category: 'test', source: 'v3', isOutputNode: false,
      body: [{ kind: 'input', id: 'model', type: { kind: 'concrete', name: 'ASSET' }, optional: false,
        widget: { widgetType: 'ASSET', kind: 'model/checkpoint', options: {}, default: null } }],
    }])
    await app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'standalone-model-review', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        n1: { id: 'n1', type: 'StandaloneModelReview', values: { model: 'audit-standalone-missing.safetensors' } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { n1: { position: { x: 180, y: 120 } } } } } },
    }, 'Missing model')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.problems.get()
    .filter((entry) => entry.code === 'model.availability.missing').map((entry) => entry.data?.['name'])))
    .toEqual(['audit-standalone-missing.safetensors'])
  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((node) => node.id === 'n1')!
    const tab = renderer.getNodeBadgeLayout(node).find((badge) => badge.badge.id === 'core.problem.error')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + tab.x + tab.width / 2, y: canvas.top + tab.y + tab.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  const box = page.getByTestId('problem-box')
  await expect(box.getByTestId('problem-box-line')).toHaveCount(1)
  await page.screenshot({ path: test.info().outputPath('real-missing-model-box.png') })
  await box.getByRole('button', { name: 'Download models', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Download models', exact: true })
  const row = dialog.locator('.dinkster-model-download-row')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('No known source')
  await expect(dialog.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0)
  await row.getByRole('button', { name: 'Choose a source', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: 'Or paste a Hugging Face or Civitai file address', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /^Download/ })).toHaveCount(0)
  await expect(page.getByTestId('asset-consent-acquire')).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('real-missing-model-review.png') })
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
  await expect(row).toHaveCount(0)
  expect(posts.filter((path) => !['/api/models/presence', '/api/models/downloads/plan', '/api/workflows/plan'].includes(path))).toEqual([])
  expect(await page.evaluate(() => window.__dinksterTest!.app.store.executions.get().size)).toBe(0)
})
