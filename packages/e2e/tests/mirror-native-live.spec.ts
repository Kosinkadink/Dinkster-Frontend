import { expect, nativeTest as test, type Page } from './fixtures.js'

async function preview(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    const value = window.__dinksterTest!.renderer!.getNodePreviews()[id]
    if (!value?.image) return undefined
    const canvas = document.createElement('canvas')
    canvas.width = value.width!
    canvas.height = value.height!
    const context = canvas.getContext('2d')!
    context.drawImage(value.image, 0, 0)
    return {
      state: value.state ?? null,
      width: canvas.width,
      height: canvas.height,
      pixels: [context.getImageData(23, 17, 1, 1), context.getImageData(80, 49, 1, 1)]
        .flatMap((pixel) => [...pixel.data]),
    }
  }, nodeId)
}

test('served mirror estimates edited gain without submitting and yields to executed output', async ({ page }, testInfo) => {
  const errors: string[] = []
  const posts: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(new URL(request.url()).pathname)
  })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()
    .some((backend) => backend.registry.get()?.schemas.has('dev.features.mirror'))),
  { timeout: 15_000 }).toBe(true)
  expect(await page.evaluate(() => document.createElement('canvas').getContext('webgl2') !== null)).toBe(true)
  expect(await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get().find((candidate) => candidate.registry.get()?.schemas.has('dev.features.mirror'))!
    return app.openTemplate('dinkster-nodes-dev', 'node-features', 'Node Feature Examples', backend.id)
  })).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .some((node) => node.id === 'mirror'))).toBe(true)

  const queue = async () => {
    const previous = await page.evaluate(() => [...window.__dinksterTest!.app.store.executions.get().values()]
      .map((execution) => execution.ref.prompt))
    await expect(page.getByTestId('queue-button')).toBeEnabled()
    await page.getByTestId('queue-button').click()
    await expect.poll(() => page.evaluate((keys) => [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((execution) => !keys.includes(execution.ref.prompt))?.status, previous),
    { timeout: 30_000 }).toBe('completed')
  }
  const setGain = async (gain: number) => {
    await page.evaluate(async (value) => {
      const app = window.__dinksterTest!.app
      await app.dispatchTo(app.activeTab()!, {
        command: 'node.setValue', params: { graphId: 'root', nodeId: 'mirror', inputId: 'gain', value },
      })
    }, gain)
  }
  const estimates = async (enabled: boolean) => {
    await page.evaluate((value) => window.__dinksterTest!.app.settings.set('execution.mirrorPreviews', value), enabled)
  }

  await queue()
  await expect.poll(() => preview(page, 'mirror')).toMatchObject({ state: null, width: 96, height: 64 })
  const initial = (await preview(page, 'mirror'))!
  const source = (await preview(page, 'source'))!
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 0.65 }))
  await page.screenshot({ path: testInfo.outputPath('mirror-executed.png') })

  const priorPosts = posts.length
  await setGain(1.5)
  await expect.poll(() => preview(page, 'mirror')).toMatchObject({ state: 'estimate', width: 96, height: 64 })
  const estimated = (await preview(page, 'mirror'))!
  const expected = source.pixels.map((channel, index) => index % 4 === 3 ? 255 : Math.min(255, channel * 1.5))
  estimated.pixels.forEach((channel, index) => expect(Math.abs(channel - expected[index]!)).toBeLessThanOrEqual(1))
  expect(estimated.pixels).not.toEqual(initial.pixels)
  await page.screenshot({ path: testInfo.outputPath('mirror-estimated.png') })

  await estimates(false)
  await expect.poll(() => preview(page, 'mirror')).toEqual({ ...initial, state: 'cached' })
  await page.screenshot({ path: testInfo.outputPath('mirror-disabled.png') })
  await estimates(true)
  await expect.poll(() => preview(page, 'mirror')).toEqual(estimated)
  expect(posts.slice(priorPosts)).toEqual([])

  await queue()
  await expect.poll(() => preview(page, 'mirror')).toMatchObject({ state: null, width: 96, height: 64 })
  const authoritative = (await preview(page, 'mirror'))!
  authoritative.pixels.forEach((channel, index) => expect(Math.abs(channel - estimated.pixels[index]!)).toBeLessThanOrEqual(1))
  await page.screenshot({ path: testInfo.outputPath('mirror-authoritative.png') })

  const downstream = await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const previous = Object.keys(tab.store.doc.graphs.root!.nodes)
    const added = await app.dispatchTo(tab, { command: 'node.add', params: {
      graphId: 'root', type: 'dev.features.mirror', values: { gain: 0.75 }, position: { x: 760, y: 750 },
    } })
    if (!added.ok) throw new Error(JSON.stringify(added.diagnostics))
    const id = Object.keys(tab.store.doc.graphs.root!.nodes).find((node) => !previous.includes(node))!
    const linked = await app.dispatchTo(tab, { command: 'link.connect', params: {
      graphId: 'root', from: { node: 'mirror', port: 'image' }, to: { node: id, port: 'image' },
    } })
    if (!linked.ok) throw new Error(JSON.stringify(linked.diagnostics))
    await app.dispatchTo(tab, { command: 'node.setMirrorPreviews', params: {
      graphId: 'root', nodeIds: ['mirror'], mirrorPreviews: false,
    } })
    return id
  })
  await queue()
  await expect.poll(() => preview(page, downstream)).toMatchObject({ state: null, width: 96, height: 64 })
  const downstreamOutput = (await preview(page, downstream))!
  const beforeSourceEdit = posts.length
  await setGain(1.25)
  await expect.poll(() => preview(page, 'mirror')).toMatchObject({ state: 'cached' })
  await expect.poll(() => preview(page, downstream)).toEqual({ ...downstreamOutput, state: 'cached' })
  await page.screenshot({ path: testInfo.outputPath('mirror-stale-source.png') })
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.dispatchTo(app.activeTab()!, { command: 'node.setMirrorPreviews', params: {
      graphId: 'root', nodeIds: ['mirror'], mirrorPreviews: true,
    } })
  })
  await expect.poll(() => preview(page, downstream)).toMatchObject({ state: 'estimate', width: 96, height: 64 })
  const upstreamEstimate = (await preview(page, 'mirror'))!
  const chainedEstimate = (await preview(page, downstream))!
  chainedEstimate.pixels.forEach((channel, index) => expect(Math.abs(channel -
    (index % 4 === 3 ? 255 : upstreamEstimate.pixels[index]! * 0.75))).toBeLessThanOrEqual(1))
  expect(posts.slice(beforeSourceEdit)).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('mirror-chained-estimates.png') })
  expect(errors).toEqual([])
})
