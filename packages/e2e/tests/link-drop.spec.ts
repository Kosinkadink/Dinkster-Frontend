/**
 * Noodle-drop compatible-node search: releasing a FRESH link drag over
 * empty canvas opens the palette constrained to entries that can terminate
 * the dangling end; picking one inserts the node AND connects it in one
 * undo step. Rewires keep their disconnect-on-empty behavior, and Escape
 * cancels without touching the document.
 */
import { expect, nativeTest, skipWithoutNativeCatalog, test, type Page } from './fixtures.js'

/** Reset the viewport to identity so world coords == canvas CSS pixels. */
async function identityViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

/** Page coordinates of a pin on a scene node (assumes identity viewport). */
async function pinPoint(
  page: Page,
  nodeId: string,
  direction: 'in' | 'out',
  portId: string,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ nodeId, direction, portId }) => {
      const r = window.__dinksterTest!.renderer!
      const vp = r.getViewport()
      const node = r.getScene().nodes.find((n) => n.id === nodeId)
      if (!node) throw new Error(`no scene node '${nodeId}'`)
      const pin = node.layout.pins.find((p) => p.direction === direction && p.portId === portId)
      if (!pin) throw new Error(`no pin ${direction}:${portId} on '${nodeId}'`)
      const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      return {
        x: rect.left + (node.x + (direction === 'in' ? 0 : node.layout.width)) * vp.scale + vp.x,
        y: rect.top + (node.y + pin.y) * vp.scale + vp.y,
      }
    },
    { nodeId, direction, portId },
  )
}

/** Page coordinates safely inside a node body, away from every pin. */
async function nodeBodyPoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nodeId) => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const node = r.getScene().nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error(`no scene node '${nodeId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * vp.scale + vp.x,
      y: rect.top + (node.y + node.layout.height / 2) * vp.scale + vp.y,
    }
  }, nodeId)
}

/** Page point in the genuine gap between adjacent real sockets on one side. */
async function betweenSocketLanePoint(
  page: Page,
  nodeId: string,
  direction: 'in' | 'out',
  depth = 9,
): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, direction, depth }) => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const node = r.getScene().nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error(`no scene node '${nodeId}'`)
    const pins = node.layout.pins
      .filter((pin) => {
        const detail = pin as typeof pin & { familyOwner?: unknown; widgetTap?: true; widgetBacked?: true }
        return pin.direction === direction &&
          detail.familyOwner === undefined && detail.widgetTap !== true && detail.widgetBacked !== true
      })
      .sort((a, b) => a.y - b.y)
    if (pins.length < 2) throw new Error(`need two rendered ${direction} pins on '${nodeId}'`)
    let pair = [pins[0]!, pins[1]!] as const
    for (let i = 1; i < pins.length - 1; i++) {
      if (pins[i + 1]!.y - pins[i]!.y < pair[1].y - pair[0].y) pair = [pins[i]!, pins[i + 1]!]
    }
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const worldX = direction === 'in'
      ? node.x + depth
      : node.x + node.layout.width - depth
    const worldY = node.y + (pair[0].y + pair[1].y) / 2
    return { x: rect.left + worldX * vp.scale + vp.x, y: rect.top + worldY * vp.scale + vp.y }
  }, { nodeId, direction, depth })
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  // Two intermediate moves: cross the drag threshold, then land exactly.
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

/** Well inside the canvas but empty world space (fixture nodes sit left). */
const EMPTY = { x: 900, y: 750 }

const activeDoc = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

async function singleAddedNode(page: Page, previousIds: readonly string[]): Promise<{ id: string; type: string }> {
  const added = await page.evaluate((before) => {
    const nodes = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes
    return Object.entries(nodes)
      .filter(([id]) => !before.includes(id))
      .map(([id, node]) => ({ id, type: node.type }))
  }, previousIds)
  expect(added).toHaveLength(1)
  return added[0]!
}

async function prepareTest(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.waitForFunction(() => 'status' in window.__dinksterTest!.app.activeTab()!.store)
  await identityViewport(page)
}

test.beforeEach(async ({ page }) => {
  await prepareTest(page)
})

nativeTest.beforeEach(async ({ page, request }, testInfo) => {
  await skipWithoutNativeCatalog(request, testInfo)
  await prepareTest(page)
})

test('node-body hover snaps the noodle and release connects the ranked input', async ({ page }) => {
  // First free the fixture input, then make a fresh output drag to its body.
  await drag(page, await pinPoint(page, 'n1', 'in', 'images'), EMPTY)
  const from = await pinPoint(page, 'n0', 'out', 'out0')
  const body = await nodeBodyPoint(page, 'n1')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(body.x, body.y)
  const overlay = await page.evaluate(() => {
    const value = window.__dinksterTest!.renderer!.getOverlay() as unknown as {
      bodyDropNode?: string
      dropTargets?: Set<string>
      ghostLink?: { x2: number; y2: number }
    }
    return {
      bodyDropNode: value.bodyDropNode,
      dropTargets: [...(value.dropTargets ?? [])],
      ghostLink: value.ghostLink,
    }
  })
  expect(overlay.bodyDropNode).toBe('n1')
  expect(overlay.dropTargets).toEqual(['n1:images:in'])
  const input = await pinPoint(page, 'n1', 'in', 'images')
  const rect = await page.getByTestId('graph-canvas').evaluate((el) => el.getBoundingClientRect())
  expect(overlay.ghostLink!.x2).toBeCloseTo(input.x - rect.x, 0)
  expect(overlay.ghostLink!.y2).toBeCloseTo(input.y - rect.y, 0)
  await page.mouse.up()
  const links = Object.values((await activeDoc(page)).graphs['g0']!.links)
  expect(links.some((l) => 'node' in l.to && l.to.node === 'n1' && l.to.port === 'images')).toBe(true)
})

nativeTest('quantized socket-lane boundaries refuse body autosnap while the interior still previews and connects', {
  tag: '@native-catalog',
}, async ({ page }) => {
  const failures = await page.evaluate(() => window.__dinksterTest!.app.openDocument({
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'socket-lane-drop', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'root', nodes: {
      source: { id: 'source', type: 'dinkster.load_checkpoint', values: {} },
      target: { id: 'target', type: 'dinkster.ksampler', values: {} },
    }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
    view: { graphs: { g0: { nodes: {
      source: { position: { x: 100, y: 150 } },
      target: { position: { x: 500, y: 150 } },
    } } } },
  }, 'Socket lane drop'))
  expect(failures).toEqual([])
  await identityViewport(page)

  const sourceOutput = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'source')
    if (!node) throw new Error("no scene node 'source'")
    return node.layout.pins.find((pin) => pin.direction === 'out' && pin.portId === 'model')?.portId ??
      node.layout.pins.find((pin) => pin.direction === 'out' && pin.portId === 'out0')?.portId ??
      node.layout.pins.find((pin) => pin.direction === 'out')?.portId ??
      (() => { throw new Error("no output pin on 'source'") })()
  })
  const sourcePin = await pinPoint(page, 'source', 'out', sourceOutput)
  const targetPin = await pinPoint(page, 'target', 'in', 'model')
  const overlay = () => page.evaluate(() => {
    const value = window.__dinksterTest!.renderer!.getOverlay() as unknown as {
      bodyDropNode?: string
      dropTargets?: Set<string>
    }
    return { bodyDropNode: value.bodyDropNode, dropTargets: [...(value.dropTargets ?? [])] }
  })

  for (const depth of [8.9, 9]) {
    const inputLane = await betweenSocketLanePoint(page, 'target', 'in', depth)
    await page.mouse.move(sourcePin.x, sourcePin.y)
    await page.mouse.down()
    await page.mouse.move(inputLane.x, inputLane.y)
    expect(await overlay()).toEqual({ bodyDropNode: undefined, dropTargets: ['target:model:in'] })
    await page.mouse.up()
    expect(Object.values((await activeDoc(page)).graphs['g0']!.links)).toHaveLength(0)

    const outputLane = await betweenSocketLanePoint(page, 'source', 'out', depth)
    await page.mouse.move(targetPin.x, targetPin.y)
    await page.mouse.down()
    await page.mouse.move(outputLane.x, outputLane.y)
    expect(await overlay(), `output depth ${depth}`).toEqual({
      bodyDropNode: undefined,
      dropTargets: [`source:${sourceOutput}:out`],
    })
    await page.mouse.up()
    expect(Object.values((await activeDoc(page)).graphs['g0']!.links)).toHaveLength(0)
  }

  for (const [from, point, nodeId] of [
    [sourcePin, await betweenSocketLanePoint(page, 'target', 'in', 9.1), 'target'],
    [targetPin, await betweenSocketLanePoint(page, 'source', 'out', 9.1), 'source'],
  ] as const) {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(point.x, point.y)
    expect((await overlay()).bodyDropNode).toBe(nodeId)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    expect(Object.values((await activeDoc(page)).graphs['g0']!.links)).toHaveLength(0)
  }

  const body = await nodeBodyPoint(page, 'target')
  await page.mouse.move(sourcePin.x, sourcePin.y)
  await page.mouse.down()
  await page.mouse.move(body.x, body.y)
  expect(await overlay()).toEqual({ bodyDropNode: 'target', dropTargets: ['target:model:in'] })
  await page.mouse.up()
  expect(Object.values((await activeDoc(page)).graphs['g0']!.links)).toEqual([
    expect.objectContaining({ from: { node: 'source', port: sourceOutput }, to: { node: 'target', port: 'model' } }),
  ])
})

for (const terminalEvent of ['pointercancel', 'lostpointercapture'] as const) {
  test(`${terminalEvent} over a valid input commits once and ignores the late pointerup`, async ({ page }) => {
    // Written as a browser regression for macOS/Safari release traces. The
    // synthetic terminal event exercises controller policy; physical Mac
    // validation must still prove the browser emits the expected sequence.
    await drag(page, await pinPoint(page, 'n1', 'in', 'images'), EMPTY)
    const from = await pinPoint(page, 'n0', 'out', 'out0')
    const to = await pinPoint(page, 'n1', 'in', 'images')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
    await page.mouse.move(to.x, to.y)
    await page.getByTestId('graph-canvas').evaluate((canvas, detail) => {
      canvas.dispatchEvent(new PointerEvent(detail.terminalEvent, {
        bubbles: true,
        pointerId: 1,
        clientX: detail.x,
        clientY: detail.y,
      }))
    }, { terminalEvent, x: to.x, y: to.y })
    await page.mouse.up()

    const links = Object.values((await activeDoc(page)).graphs['g0']!.links)
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      from: { node: 'n0', port: 'out0' },
      to: { node: 'n1', port: 'images' },
    })
  })
}

test('pointermove with buttons zero over a valid input commits once and ignores the late pointerup', async ({ page }) => {
  await drag(page, await pinPoint(page, 'n1', 'in', 'images'), EMPTY)
  const from = await pinPoint(page, 'n0', 'out', 'out0')
  const to = await pinPoint(page, 'n1', 'in', 'images')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.getByTestId('graph-canvas').evaluate((canvas, point) => {
    canvas.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
      buttons: 0,
      clientX: point.x,
      clientY: point.y,
    }))
  }, to)
  await page.mouse.up()

  const links = Object.values((await activeDoc(page)).graphs['g0']!.links)
  expect(links).toHaveLength(1)
  expect(links[0]).toMatchObject({
    from: { node: 'n0', port: 'out0' },
    to: { node: 'n1', port: 'images' },
  })
})

test('mouse pointercancel over empty after a rewire drag disconnects', async ({ page }) => {
  const from = await pinPoint(page, 'n1', 'in', 'images')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(EMPTY.x, EMPTY.y)
  await page.getByTestId('graph-canvas').evaluate((canvas) => {
    canvas.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
    }))
  })
  await page.mouse.up()
  expect(Object.values((await activeDoc(page)).graphs['g0']!.links)).toHaveLength(0)
})

test('node-body drop replaces an occupied compatible input', async ({ page }) => {
  // The fixture's n1.images is occupied. Dropping the same producer on the
  // body exercises the occupied fallback and link.connect replacement path.
  await drag(page, await pinPoint(page, 'n0', 'out', 'out0'), await nodeBodyPoint(page, 'n1'))
  const links = Object.values((await activeDoc(page)).graphs['g0']!.links)
  expect(links).toHaveLength(1)
  expect(links[0]).toMatchObject({
    from: { node: 'n0', port: 'out0' },
    to: { node: 'n1', port: 'images' },
  })
})

test('incompatible node-body drop cancels without opening the palette', async ({ page }) => {
  await drag(page, await pinPoint(page, 'n0', 'out', 'out0'), await nodeBodyPoint(page, 'n0'))
  await expect(page.getByTestId('node-palette')).not.toBeVisible()
  expect(Object.keys((await activeDoc(page)).graphs['g0']!.links)).toHaveLength(1)
})

test('output noodle dropped on empty opens input-compatible search; Escape cancels clean', async ({ page }) => {
  // n0 (EmptyImage) out0 is IMAGE: the palette must seek IMAGE inputs.
  await drag(page, await pinPoint(page, 'n0', 'out', 'out0'), EMPTY)
  const palette = page.getByTestId('node-palette')
  await expect(palette).toBeVisible()
  await expect(palette).toHaveAttribute('data-link-drop', 'in')

  const search = page.getByTestId('palette-search')
  // PreviewImage accepts IMAGE - present.
  await search.fill('preview image')
  await expect(page.locator('[data-node-type="PreviewImage"]')).toBeVisible()
  // VAEDecode consumes LATENT+VAE, never IMAGE - excluded even when the
  // text would rank it.
  await search.fill('vae decode')
  await expect(page.locator('[data-node-type="VAEDecode"]')).not.toBeVisible()

  // Escape: no node, no link, nothing.
  await search.press('Escape')
  await expect(palette).not.toBeVisible()
  const doc = await activeDoc(page)
  expect(Object.keys(doc.graphs['g0']!.nodes)).toHaveLength(2)
  expect(Object.keys(doc.graphs['g0']!.links)).toHaveLength(1)
})

nativeTest('native typed Autogrow families filter in both directions and generic targets remain available', {
  tag: '@native-catalog',
}, async ({ page }) => {
  const openSingleNode = async (type: string, title: string): Promise<void> => {
    const failures = await page.evaluate(({ type, title }) => window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: title, root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        n0: { id: 'n0', type, values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: { g0: { nodes: { n0: { position: { x: 100, y: 150 } } } } } },
    }, title), { type, title })
    expect(failures).toEqual([])
    await identityViewport(page)
  }

  await openSingleNode('comfy.EmptyImage', 'Native typed output drop')
  await drag(page, await pinPoint(page, 'n0', 'out', 'image'), EMPTY)
  const search = page.getByTestId('palette-search')
  await search.fill('Batch Images')
  await expect(page.locator('[data-node-type="comfy.BatchImagesNode"]')).toBeVisible()
  await search.fill('Batch Masks')
  await expect(page.locator('[data-node-type="comfy.BatchMasksNode"]')).not.toBeVisible()
  await search.fill('Batch Latents')
  await expect(page.locator('[data-node-type="comfy.BatchLatentsNode"]')).not.toBeVisible()
  await search.fill('Preview as Text')
  await expect(page.locator('[data-node-type="dinkster.preview_any"]')).toBeVisible()
  await expect(page.locator('[data-node-type="comfy.PreviewAny"]')).toBeVisible()

  await search.fill('Batch Images')
  await page.locator('[data-node-type="comfy.BatchImagesNode"]').click()
  const inserted = await activeDoc(page)
  const batch = Object.values(inserted.graphs['g0']!.nodes).find((node) => node.type === 'comfy.BatchImagesNode')
  expect(batch?.dynamic?.['images']).toMatchObject({ members: ['m0'] })
  expect(Object.values(inserted.graphs['g0']!.links)).toEqual([
    expect.objectContaining({
      from: { node: 'n0', port: 'image' },
      to: expect.objectContaining({ node: batch!.id, port: 'images.images', members: ['m0'] }),
    }),
  ])

  await openSingleNode('comfy.PreviewImage', 'Native typed input drop')
  await drag(page, await pinPoint(page, 'n0', 'in', 'images'), EMPTY)
  await expect(page.getByTestId('node-palette')).toHaveAttribute('data-link-drop', 'out')
  await page.getByTestId('palette-search').fill('Batch Images')
  await expect(page.locator('[data-node-type="comfy.BatchImagesNode"]')).toBeVisible()
  await page.getByTestId('palette-search').fill('Batch Masks')
  await expect(page.locator('[data-node-type="comfy.BatchMasksNode"]')).not.toBeVisible()
})

test('backdrop pointerdown cancels a link-drop ghost without creating a link or panning', async ({ page }) => {
  await drag(page, await pinPoint(page, 'n0', 'out', 'out0'), EMPTY)
  await expect(page.getByTestId('node-palette')).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getOverlay().ghostLink)).toBeDefined()
  const viewportBefore = await page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())

  const box = (await page.getByTestId('palette-backdrop').boundingBox())!
  await page.mouse.move(box.x + 8, box.y + box.height / 2)
  await page.mouse.down()
  await expect(page.getByTestId('node-palette')).not.toBeVisible()
  await page.mouse.move(box.x + 80, box.y + box.height / 2)
  await page.mouse.up()

  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getOverlay().ghostLink)).toBeUndefined()
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())).toEqual(viewportBefore)
  const doc = await activeDoc(page)
  expect(Object.keys(doc.graphs['g0']!.nodes)).toHaveLength(2)
  expect(Object.keys(doc.graphs['g0']!.links)).toHaveLength(1)
})

test('picking a node inserts it and connects the dangling end - ONE undo step', async ({ page }) => {
  const previousIds = Object.keys((await activeDoc(page)).graphs.g0!.nodes)
  await drag(page, await pinPoint(page, 'n0', 'out', 'out0'), EMPTY)
  await page.getByTestId('palette-search').fill('preview image')
  await page.locator('[data-node-type="PreviewImage"]').click()
  await expect(page.getByTestId('node-palette')).not.toBeVisible()

  const doc = await activeDoc(page)
  const added = await singleAddedNode(page, previousIds)
  expect(added.type).toBe('PreviewImage')
  const links = Object.values(doc.graphs['g0']!.links)
  expect(links).toHaveLength(2) // l2 untouched + the new connection
  expect(
    links.some(
      (l) =>
        'node' in l.from && l.from.node === 'n0' && l.from.port === 'out0' &&
        'node' in l.to && l.to.node === added.id && l.to.port === 'images',
    ),
  ).toBe(true)
  // The new node is selected.
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')

  // ONE undo removes insert + connect together.
  await page.keyboard.press('Control+z')
  const undone = await activeDoc(page)
  expect(undone.graphs['g0']!.nodes[added.id]).toBeUndefined()
  expect(Object.keys(undone.graphs['g0']!.links)).toHaveLength(1)
})

test('rewire dropped on empty still disconnects (no palette); a free input then seeks outputs', async ({ page }) => {
  const previousIds = Object.keys((await activeDoc(page)).graphs.g0!.nodes)
  // n1.images is CONNECTED: grabbing it is a rewire; empty drop = disconnect.
  await drag(page, await pinPoint(page, 'n1', 'in', 'images'), EMPTY)
  await expect(page.getByTestId('node-palette')).not.toBeVisible()
  expect(Object.keys((await activeDoc(page)).graphs['g0']!.links)).toHaveLength(0)

  // Now the input is free: a fresh drag from it seeks IMAGE producers.
  await drag(page, await pinPoint(page, 'n1', 'in', 'images'), EMPTY)
  const palette = page.getByTestId('node-palette')
  await expect(palette).toBeVisible()
  await expect(palette).toHaveAttribute('data-link-drop', 'out')

  const search = page.getByTestId('palette-search')
  // CLIPTextEncode outputs CONDITIONING, never IMAGE - excluded.
  await search.fill('CLIPTextEncode')
  await expect(page.locator('[data-node-type="CLIPTextEncode"]')).not.toBeVisible()

  await search.fill('empty image')
  await page.locator('[data-node-type="EmptyImage"]').click()

  const doc = await activeDoc(page)
  const added = await singleAddedNode(page, previousIds)
  expect(added.type).toBe('EmptyImage')
  const links = Object.values(doc.graphs['g0']!.links)
  expect(links).toHaveLength(1)
  expect(
    links.some(
      (l) =>
        'node' in l.from && l.from.node === added.id && l.from.port === 'out0' &&
        'node' in l.to && l.to.node === 'n1' && l.to.port === 'images',
    ),
  ).toBe(true)
})

test('dropped noodle stays visible while the palette is browsed; clears on Escape and commit', async ({ page }) => {
  const from = await pinPoint(page, 'n0', 'out', 'out0')
  await drag(page, from, EMPTY)
  await expect(page.getByTestId('node-palette')).toBeVisible()

  // The ghost noodle persists after the gesture ended: anchored at the
  // source pin, ending at the drop point (identity viewport: world ==
  // canvas CSS px), carrying the anchor's type for coloring.
  const ghost = () =>
    page.evaluate(() => window.__dinksterTest!.renderer!.getOverlay().ghostLink)
  const rect = await page.getByTestId('graph-canvas').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top }
  })
  const g1 = await ghost()
  expect(g1).toBeDefined()
  expect(g1!.typeName).toBe('IMAGE')
  expect(g1!.x1).toBeCloseTo(from.x - rect.left, 0)
  expect(g1!.y1).toBeCloseTo(from.y - rect.top, 0)
  expect(g1!.x2).toBeCloseTo(EMPTY.x - rect.left, 0)
  expect(g1!.y2).toBeCloseTo(EMPTY.y - rect.top, 0)

  // Browsing (typing, filtering) never drops the noodle.
  await page.getByTestId('palette-search').fill('preview image')
  expect(await ghost()).toBeDefined()

  // Escape closes the palette AND the pending noodle.
  await page.getByTestId('palette-search').press('Escape')
  await expect(page.getByTestId('node-palette')).not.toBeVisible()
  expect(await ghost()).toBeUndefined()

  // Committing a pick clears it too (the real link replaces the ghost).
  await drag(page, from, EMPTY)
  await page.getByTestId('palette-search').fill('preview image')
  await page.locator('[data-node-type="PreviewImage"]').click()
  await expect(page.getByTestId('node-palette')).not.toBeVisible()
  expect(await ghost()).toBeUndefined()
})

test('subgraphs participate through their boundary-derived schema', async ({ page }) => {
  await page.getByTestId('tab-bar').locator('.tab', { hasText: 'Subgraph' }).click()
  await identityViewport(page)
  const previousIds = Object.keys((await activeDoc(page)).graphs.g0!.nodes)

  // Free n1.images first (it is driven by the #g1 instance).
  await drag(page, await pinPoint(page, 'n1', 'in', 'images'), EMPTY)
  await expect(page.getByTestId('node-palette')).not.toBeVisible()

  // Fresh drag from the free IMAGE input: #g1 ("Image source") produces
  // an IMAGE through its boundary, so it must appear and auto-connect.
  await drag(page, await pinPoint(page, 'n1', 'in', 'images'), EMPTY)
  await expect(page.getByTestId('node-palette')).toHaveAttribute('data-link-drop', 'out')
  await page.getByTestId('palette-search').fill('Image source')
  await page.locator('[data-node-type="#g1"]').click()

  const doc = await activeDoc(page)
  const added = await singleAddedNode(page, previousIds)
  expect(added.type).toBe('#g1')
  const links = Object.values(doc.graphs['g0']!.links)
  expect(links).toHaveLength(1)
  expect(
    links.some(
      (l) =>
        'node' in l.from && l.from.node === added.id && l.from.port === 'image' &&
        'node' in l.to && l.to.node === 'n1' && l.to.port === 'images',
    ),
  ).toBe(true)
})
