import { expect, nativeTest as test, waitForStartupOwnership } from './fixtures.js'

test.use({ retentionApi: false })

for (const kind of ['map', 'fold', 'while'] as const) {
  test(`an untouched ${kind} starter runs with the served catalog`, async ({ page }, testInfo) => {
    await page.goto('/')
    await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.has('dinkster.utilities.primitive_float'))).toBe(true)
    await waitForStartupOwnership(page)
    const occurrenceId = await page.evaluate(async (kind) => {
      const app = window.__dinksterTest!.app
      const tab = app.createWorkflow()
      const result = await app.createRegion(tab, tab.store.doc.root, { x: 240, y: 160 }, kind)
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
      const occurrence = Object.values(tab.store.doc.graphs[tab.store.doc.root]!.nodes)[0]!
      const compiled = app.compileTab(tab, { kind: 'partial', targets: [{ instancePath: [], node: occurrence.id as never }] })
      if (!compiled?.ok) throw new Error(JSON.stringify(compiled))
      return occurrence.id
    }, kind)
    await page.screenshot({ path: testInfo.outputPath(`${kind}-starter.png`) })
    await page.evaluate(async (id) => {
      const app = window.__dinksterTest!.app
      await app.queue(app.activeTab()!, { kind: 'partial', targets: [{ instancePath: [], node: id as never }] })
    }, occurrenceId)
    await expect.poll(() => page.evaluate(() => {
      const app = window.__dinksterTest!.app
      return [...app.store.executions.get().values()].at(-1)?.status
    })).toBe('completed')
    const output = await page.evaluate(async ({ occurrenceId, kind }) => {
      const app = window.__dinksterTest!.app
      const execution = [...app.store.executions.get().values()].at(-1)!
      const backend = app.backends.get().find((entry) => entry.id === execution.ref.connection)!
      const connection = backend.connection as unknown as { values(): {
        peek(query: { jobId: string; nodeId: string; outputId: string }): Promise<{
          available: boolean; descriptor: { value?: unknown; elements?: readonly { value?: unknown }[] }
        }>
      } }
      const peek = await connection.values().peek({
        jobId: execution.ref.prompt, nodeId: occurrenceId, outputId: kind === 'map' ? 'result' : 'state',
      })
      if (!peek.available) throw new Error(JSON.stringify(peek))
      return peek.descriptor.elements?.map((element) => element.value) ?? peek.descriptor.value
    }, { occurrenceId, kind })
    expect(output).toEqual(kind === 'map' ? [] : 0)
  })
}

test('dropping a latent uses the served extension-declared Load Latent input', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.has('dinkster.latent.load_latent'))).toBe(true)
  await waitForStartupOwnership(page)
  await page.evaluate(() => { window.__dinksterTest!.app.createWorkflow() })
  const uploaded = page.waitForResponse((response) => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/assets/latent')
  await page.locator('canvas').first().evaluate((canvas) => {
    const raw = new TextEncoder().encode(JSON.stringify({ latent_tensor: { dtype: 'F32', shape: [1], data_offsets: [0, 4] } }))
    const header = new Uint8Array(raw.length + (-raw.length & 7))
    header.set(raw)
    header.fill(0x20, raw.length)
    const prefix = new Uint8Array(8)
    new DataView(prefix.buffer).setBigUint64(0, BigInt(header.length), true)
    const transfer = new DataTransfer()
    transfer.items.add(new File([prefix, header, new Uint8Array(4)], 'starter.latent', { type: 'application/octet-stream' }))
    canvas.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: 420, clientY: 320, dataTransfer: transfer }))
  })
  const response = await uploaded
  expect(response.ok()).toBe(true)
  const asset = (await response.json()).asset
  expect(asset.name).toMatch(/\.latent$/)
  await expect.poll(() => page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return Object.values(app.activeTab()!.store.doc.graphs[app.activeTab()!.store.doc.root]!.nodes)
      .filter((node) => node.type === 'dinkster.latent.load_latent').map((node) => node.values)
  })).toEqual([{ latent: asset }])
  await page.screenshot({ path: testInfo.outputPath('latent-inserted.png') })
})
