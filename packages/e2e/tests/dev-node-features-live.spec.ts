import { expect, nativeTest as test, type Page } from './fixtures.js'

async function pinPoint(page: Page, nodeId: string, portId: string, direction: 'in' | 'out') {
  return page.evaluate(({ nodeId, portId, direction }) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((item) => item.id === nodeId)!
    const pin = node.layout.pins.find((item) => item.portId === portId && item.direction === direction)!
    const viewport = renderer.getViewport()
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (node.x - viewport.x + (direction === 'out' ? node.layout.width : 0)) * viewport.scale,
      y: rect.top + (node.y - viewport.y + pin.y) * viewport.scale,
    }
  }, { nodeId, portId, direction })
}

test('required served slot can be cleared, reselected and execute a connected value', async ({ page, request }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()
    .some((backend) => backend.registry.get()?.schemas.has('dev.features.slot')))).toBe(true)
  expect(await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get().find((item) => item.registry.get()?.schemas.has('dev.features.slot'))!
    return app.openTemplate('dinkster-nodes-dev', 'node-features', 'Node Feature Examples', backend.id)
  })).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .some((node) => node.id === 'slot'))).toBe(true)
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))

  const source = await pinPoint(page, 'slot', 'source', 'in')
  await page.mouse.click(source.x, source.y, { button: 'right' })
  await page.locator('[data-item-id="core.slot.specialize.clear"]').click()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .find((node) => node.id === 'slot')!.layout.pins.some((pin) => pin.portId === 'source' && pin.direction === 'in'))).toBe(true)
  await test.info().attach('required-slot-cleared.png', { body: await page.screenshot(), contentType: 'image/png' })

  const cleared = await pinPoint(page, 'slot', 'source', 'in')
  await page.mouse.click(cleared.x, cleared.y, { button: 'right' })
  await page.locator('[data-item-id="core.slot.specialize.text"]').click()
  const output = await pinPoint(page, 'representations', 'text', 'out')
  const input = await pinPoint(page, 'slot', 'source', 'in')
  await page.mouse.move(output.x, output.y)
  await page.mouse.down()
  await page.mouse.move(input.x, input.y, { steps: 10 })
  await page.mouse.up()
  await test.info().attach('required-slot-connected.png', { body: await page.screenshot(), contentType: 'image/png' })
  await expect.poll(() => page.evaluate(() => Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!.links)
    .some((link) => 'node' in link.to && link.to.node === 'slot' && 'node' in link.from && link.from.node === 'representations'))).toBe(true)

  const jobRequest = page.waitForRequest((outgoing) => outgoing.method() === 'POST' && new URL(outgoing.url()).pathname === '/api/jobs')
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queueSelection(app.activeTab()!, ['slot'])
  })
  const submitted = (await jobRequest).postDataJSON() as { clientId: string; jobId: string; graph: { nodes: Record<string, unknown> } }
  expect(submitted.graph.nodes.slot).toMatchObject({ slotVariants: { source: 'text' }, inputs: { source: { $link: { node: 'representations', output: 'text' } } } })
  await expect.poll(async () => {
    const response = await request.get(`/api/jobs/${encodeURIComponent(submitted.clientId)}/${encodeURIComponent(submitted.jobId)}`)
    return (await response.json() as { state: string }).state
  }, { timeout: 30_000 }).toBe('completed')
  const response = await request.get(`/api/jobs/${encodeURIComponent(submitted.clientId)}/${encodeURIComponent(submitted.jobId)}`)
  const job = await response.json() as { executed: string[] }
  expect(job.executed).toEqual(expect.arrayContaining(['representations', 'slot']))
  await test.info().attach('required-slot-executed.json', { body: JSON.stringify(job, null, 2), contentType: 'application/json' })
})
