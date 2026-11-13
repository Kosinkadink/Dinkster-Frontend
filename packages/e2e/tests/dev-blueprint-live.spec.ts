import { expect, nativeTest as test } from './fixtures.js'

test('served dev blueprint copies its graph independently and undoes as one insertion', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()
    .some((backend) => backend.registry.get()?.schemas.has('dev.features.slot')))).toBe(true)
  const openTemplate = () => page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get().find((item) => item.registry.get()?.schemas.has('dev.features.slot'))!
    return app.openTemplate('dinkster-nodes-dev', 'node-features', 'Node Feature Examples', backend.id)
  })
  expect(await openTemplate()).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .some((node) => node.id === 'slot'))).toBe(true)
  const document = () => page.evaluate(() => structuredClone(window.__dinksterTest!.app.activeTab()!.store.doc))
  const before = await document()
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 0.5 }))
  await page.getByTestId('graph-canvas').dblclick({ position: { x: 600, y: 500 } })
  await page.getByTestId('palette-search').fill('Node Feature Examples')
  await page.getByTestId('palette-item').filter({ hasText: 'Node Feature Examples' }).click()
  await page.getByTestId('graph-canvas').click({ position: { x: 600, y: 500 } })
  await expect.poll(async () => Object.keys((await document()).graphs).length).toBe(2)
  const inserted = await document()
  const id = Object.keys(inserted.graphs).find((key) => key !== inserted.root)!
  const copy = inserted.graphs[id]!
  expect(Object.keys(inserted.graphs.root!.nodes)).toHaveLength(9)
  expect(Object.keys(copy.nodes)).toHaveLength(8)
  expect(copy.boundary).toEqual({ inputs: [], outputs: [] })
  expect(copy.nodes).toEqual(before.graphs.root!.nodes)
  expect(copy.links.image).toEqual({
    id: 'image', from: { node: 'source', port: 'image' }, to: { node: 'mirror', port: 'image' },
  })
  expect(Object.values(inserted.graphs.root!.nodes).filter((node) => node.type === `#${id}`)).toHaveLength(1)
  await page.screenshot({ path: testInfo.outputPath('blueprint-inserted.png') })

  expect(await page.evaluate(async (graphId) => {
    const app = window.__dinksterTest!.app
    return (await app.dispatchTo(app.activeTab()!, { command: 'node.setValue', params: {
      graphId, nodeId: 'mirror', inputId: 'gain', value: 1.75,
    } })).ok
  }, id)).toBe(true)
  const edited = await document()
  expect(edited.graphs[id]!.nodes.mirror!.values!.gain).toBe(1.75)
  expect(edited.graphs.root!.nodes.mirror!.values!.gain).toBe(0.5)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  await expect.poll(async () => (await document()).graphs[id]!.nodes.mirror!.values!.gain).toBe(0.5)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  await expect.poll(async () => Object.keys((await document()).graphs).length).toBe(1)
  const undone = await document()
  expect({ ...undone.graphs.root, actorCursors: undefined })
    .toEqual({ ...before.graphs.root, actorCursors: undefined })
  await page.screenshot({ path: testInfo.outputPath('blueprint-undone.png') })
  expect(await openTemplate()).toBe(true)
  await expect.poll(async () => Object.keys((await document()).graphs.root!.nodes).length).toBe(8)
  expect((await document()).graphs.root).toEqual(before.graphs.root)
  await page.screenshot({ path: testInfo.outputPath('blueprint-template-reopened.png') })
})
