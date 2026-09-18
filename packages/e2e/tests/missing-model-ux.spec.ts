import { expect, nativeTest as test, type Page } from './fixtures.js'

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
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  const checkpointResponse = await page.request.get('/api/mounts/comfy-model-checkpoints-1/entries?kind=model/checkpoint')
  expect(checkpointResponse.ok()).toBe(true)
  const checkpointEntries = await checkpointResponse.json() as { entries: Array<Record<string, unknown>> }
  const checkpoint = checkpointEntries.entries.find((entry) => entry['name'] === 'audit-local-checkpoint.safetensors')
  expect(checkpoint).toBeDefined()
  const { kind: _kind, ...checkpointRef } = checkpoint!
  await page.evaluate((requested) => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'auditModelLoader', displayName: 'audit Model Loader', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'model', type: { kind: 'concrete', name: 'dinkster.asset' }, optional: false,
        widget: {
          widgetType: 'ASSET', kind: 'model/checkpoint',
          options: { accept: ['application/x-safetensors', 'application/octet-stream'] }, default: null,
        },
      }],
    }])
    app.openDocument({
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
    const app = window.__dinksterTest!.app as unknown as {
      solveDiagnostics: { get(): ReadonlyArray<{ code: string; severity: string; message: string }> }
    }
    return app.solveDiagnostics.get().map(({ code, severity, message }) => ({ code, severity, message }))
  })).toContainEqual({
    code: 'widget.ASSET.unresolvedImport', severity: 'error',
    message: expect.stringContaining(REQUESTED),
  })
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { solveDiagnostics: { get(): ReadonlyArray<{ code: string; message: string }> } }
    return app.solveDiagnostics.get().find((entry) => entry.code === 'widget.ASSET.unresolvedImport')?.message
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
  await expect(details.getByTestId('asset-download')).toBeDisabled()

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
    const app = window.__dinksterTest!.app as unknown as { solveDiagnostics: { get(): ReadonlyArray<{ code: string }> } }
    return app.solveDiagnostics.get().some((entry) => entry.code === 'widget.ASSET.unresolvedImport')
  })).toBe(true)

  const exported = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return app.exportDocument(app.activeTab()!.id)
  })
  expect(await page.evaluate((document) => {
    const app = window.__dinksterTest!.app
    app.openDocument(document, 'audit reopened missing model')
    return app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values.model
  }, exported)).toBe(REQUESTED)
  await expect.poll(() => page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { solveDiagnostics: { get(): ReadonlyArray<{ code: string }> } }
    return app.solveDiagnostics.get().some((entry) => entry.code === 'widget.ASSET.unresolvedImport')
  })).toBe(true)
  expect(requestedUrls.some((url) => url.includes('audit-definitely-missing-model.safetensors'))).toBe(false)
})
