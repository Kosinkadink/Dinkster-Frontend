import { expect, nativeTest as test, waitForStartupOwnership } from './fixtures.js'

test('resolution composer previews and executes asymmetric dimensions with atomic undo', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('connected', { timeout: 20_000 })
  await waitForStartupOwnership(page)
  await page.evaluate(async () => {
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'resolution-live', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Resolution', nodes: {
        resolution: { id: 'resolution', type: 'ResolutionSelector', values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { resolution: { position: { x: 180, y: 100 } } } } } },
    } as never, 'Resolution')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((entry) => entry.id === 'resolution')!
    const row = node.layout.rows.find((entry) => entry.kind === 'widget' && entry.inputId === 'preview')!
    const bounds = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: bounds.left + node.x + node.layout.width / 2, y: bounds.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  const editor = page.getByTestId('resolution-editor')
  await expect(editor).toBeVisible()
  const before = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.resolution!.values)
  await expect(page.locator('[data-editor-mode="raw"]')).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get().filter((problem) => problem.message.includes('RESOLUTION_PREVIEW')))).toEqual([])
  const capture = async (name: string) => {
    const path = testInfo.outputPath(`${name}.png`)
    await editor.screenshot({ path })
    await testInfo.attach(name, { path, contentType: 'image/png' })
  }
  await expect(editor.locator('output')).toHaveText('1,024 x 1,024 pixels')
  await capture('resolution-default')
  await page.getByRole('combobox', { name: 'Aspect ratio' }).focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await page.getByRole('textbox', { name: 'Megapixels' }).fill('1.3')
  await page.getByRole('textbox', { name: 'Round to multiple' }).fill('')
  await expect(page.getByRole('button', { name: 'Apply resolution' })).toBeDisabled()
  await capture('resolution-invalid')
  await page.getByRole('textbox', { name: 'Round to multiple' }).fill('64')
  await expect(editor.locator('output')).toHaveText('1,536 x 896 pixels')
  await capture('resolution-edited')
  await page.getByRole('button', { name: 'Apply resolution' }).focus()
  await page.keyboard.press('Enter')
  await expect(editor).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.resolution!.values))
    .toEqual({ ...before, aspect_ratio: '16:9 (Widescreen)', megapixels: 1.3, multiple: 64 })
  await page.evaluate(async () => { const app = window.__dinksterTest!.app; await app.queueSelection(app.activeTab()!, ['resolution']) })
  await expect(page.getByTestId('execution-row').first().locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
  const result = await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const execution = [...app.store.executions.get().values()].sort((a, b) => b.queuedAt - a.queuedAt)[0]!
    const artifact = execution.artifact as typeof execution.artifact & {
      provenance: { toSource: Record<string, string>; outputAliases?: Record<string, Record<string, string>> }
    }
    const runtimeId = Object.keys(artifact.provenance.toSource).find((id) => artifact.provenance.toSource[id] === 'resolution')!
    const backend = app.backendForTab(app.activeTab()!)
    if (backend.protocol !== 'dinkster') throw new Error('Expected native backend')
    const values = (backend.connection as unknown as import('@dinkster/client').DinksterConnection).values()
    return Promise.all(['width', 'height'].map(async (output) => {
      const query = { jobId: execution.ref.prompt, nodeId: runtimeId, outputId: artifact.provenance.outputAliases?.[runtimeId]?.[output] ?? output }
      const peek = await values.peek(query)
      if (!peek.available) throw new Error('Resolution output unavailable')
      return peek.descriptor.value
    }))
  })
  expect(result).toEqual([1536, 896])
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.resolution!.values)).toEqual(before)
})
