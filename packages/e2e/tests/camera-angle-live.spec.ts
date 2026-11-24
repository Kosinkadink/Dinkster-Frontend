import { expect, nativeTest as test, unfoldNodeEditor, waitForWorkspaceReady } from './fixtures.js'


test('camera angle in the node writes real siblings, executes orbit coordinates and preserves undo', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByTestId('status-connection')).toHaveAttribute('data-state', 'connected', { timeout: 20_000 })
  await waitForWorkspaceReady(page)
  await page.evaluate(async () => {
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'camera-angle-live', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Camera', nodes: {
        camera: { id: 'camera', type: 'dinkster.3d.camera_angle', values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { camera: { position: { x: 180, y: 100 } } } } } },
    } as never, 'Camera angle')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  const values = () => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.camera!.values)
  const before = await values()
  const editor = await unfoldNodeEditor(page, 'camera', 'angle_view')
  const picture = editor.getByRole('img', { name: 'Camera orbit from above and elevation from the side' })
  await expect(picture).toHaveAttribute('data-movable', 'true')
  await expect(editor).toContainText('Front, level, zoom 5.0')
  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get().filter((problem) => problem.message.includes('CAMERA_ANGLE_VIEW')))).toEqual([])
  const capture = async (name: string) => {
    const path = testInfo.outputPath(`${name}.png`)
    await editor.screenshot({ path })
    await testInfo.attach(name, { path, contentType: 'image/png' })
  }
  await capture('camera-default')
  // A point of the picture's 300 by 150 drawing, on the page: the orbit is a
  // ring of radius 55 around (80, 75), the elevation an arc of radius 86 around (172, 92).
  const at = (x: number, y: number) => picture.evaluate((svg, [x, y]) => {
    const point = new DOMPoint(x, y).matrixTransform((svg as SVGSVGElement).getScreenCTM()!)
    return { x: point.x, y: point.y }
  }, [x, y] as const)
  const press = async (x: number, y: number) => {
    const point = await at(x, y)
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await page.mouse.up()
  }
  // 90 degrees on the ring is its right; 30 degrees on the arc is up and right of its centre.
  await press(80 + 55, 75)
  await expect.poll(async () => (await values())['horizontal_angle']).toBe(90)
  await press(172 + Math.cos(Math.PI / 6) * 86, 92 - Math.sin(Math.PI / 6) * 86)
  await expect.poll(async () => (await values())['vertical_angle']).toBe(30)
  // Zoom is the node's own number row below the picture.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.dispatchTo(app.activeTab()!, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'camera', inputId: 'zoom', value: 7.5 } })
  })
  await expect(editor).toContainText('Right, a little above, zoom 7.5')
  await capture('camera-edited')
  expect(await values()).toEqual({ ...before, horizontal_angle: 90, vertical_angle: 30, zoom: 7.5 })
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
  // Each drag and the zoom are one change apiece.
  for (let step = 0; step < 3; step++) expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await values()).toEqual(before)
})
