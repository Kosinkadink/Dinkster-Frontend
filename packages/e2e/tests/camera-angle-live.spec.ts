import { expect, nativeTest as test, waitForStartupOwnership } from './fixtures.js'

test('camera composer writes real siblings, executes orbit coordinates and preserves undo', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('connected', { timeout: 20_000 })
  await waitForStartupOwnership(page)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'camera-angle-live', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Camera', nodes: {
        camera: { id: 'camera', type: 'CameraAngle', values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { camera: { position: { x: 180, y: 100 } } } } } },
    } as never, 'Camera angle')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((entry) => entry.id === 'camera')!
    const row = node.layout.rows.find((entry) => entry.kind === 'widget' && entry.inputId === 'view')!
    const bounds = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: bounds.left + node.x + node.layout.width / 2, y: bounds.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  const editor = page.getByTestId('camera-angle-editor')
  await expect(editor).toBeVisible()
  const before = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.camera!.values)
  await expect(page.locator('[data-editor-mode="raw"]')).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get().filter((problem) => problem.message.includes('CAMERA_ANGLE_VIEW')))).toEqual([])
  const capture = async (name: string) => {
    const path = testInfo.outputPath(`${name}.png`)
    await editor.screenshot({ path })
    await testInfo.attach(name, { path, contentType: 'image/png' })
  }
  await capture('camera-default')
  await page.getByRole('textbox', { name: 'Horizontal angle' }).fill('90')
  await page.getByRole('textbox', { name: 'Vertical angle' }).fill('30')
  await page.getByRole('textbox', { name: 'Zoom' }).fill('')
  await expect(page.getByRole('button', { name: 'Apply camera angle' })).toBeDisabled()
  await capture('camera-invalid')
  await page.getByRole('textbox', { name: 'Zoom' }).fill('7.5')
  await expect(editor.locator('output')).toHaveText('Camera position: X 5.20, Y 3.00, Z 0.00')
  await capture('camera-edited')
  await page.getByRole('button', { name: 'Apply camera angle' }).focus()
  await page.keyboard.press('Enter')
  await expect(editor).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.camera!.values))
    .toEqual({ ...before, horizontal_angle: 90, vertical_angle: 30, zoom: 7.5 })
  await page.evaluate(async () => { const app = window.__dinksterTest!.app; await app.queueSelection(app.activeTab()!, ['camera']) })
  await expect(page.getByTestId('execution-row').first().locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
  const result = await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const execution = [...app.store.executions.get().values()].sort((a, b) => b.queuedAt - a.queuedAt)[0]!
    const artifact = execution.artifact as typeof execution.artifact & {
      provenance: { toSource: Record<string, string>; outputAliases?: Record<string, Record<string, string>> }
    }
    const runtimeId = Object.keys(artifact.provenance.toSource).find((id) => artifact.provenance.toSource[id] === 'camera')!
    const backend = app.backendForTab(app.activeTab()!)
    if (backend.protocol !== 'dinkster') throw new Error('Expected native backend')
    const values = (backend.connection as unknown as import('@dinkster/client').DinksterConnection).values()
    const query = { jobId: execution.ref.prompt, nodeId: runtimeId, outputId: artifact.provenance.outputAliases?.[runtimeId]?.camera_info ?? 'camera_info' }
    const peek = await values.peek(query)
    if (!peek.available) throw new Error('Camera output unavailable')
    const rendition = peek.renditions.find((entry) => entry.mime === 'application/json')!
    return values.read(query, peek.descriptor, async () => {
      const result = await values.rendition(query, rendition.kind, { descriptor: peek.descriptor })
      if (!result.available) throw new Error('Camera rendition unavailable')
      return JSON.parse(new TextDecoder().decode(result.bytes)) as { position: { x: number; y: number; z: number }; zoom: number; fov: number; cameraType: string }
    })
  })
  expect(result.position.x).toBeCloseTo(5.196152422706632, 10)
  expect(result.position.y).toBeCloseTo(3, 10)
  expect(result.position.z).toBeCloseTo(0, 10)
  expect(result.zoom).toBe(1.65625)
  expect(result.fov).toBe(35)
  expect(result.cameraType).toBe('perspective')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.camera!.values)).toEqual(before)
})
