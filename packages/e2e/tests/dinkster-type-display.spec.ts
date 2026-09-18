/**
 * Native dinkster boundary types display with their ComfyUI names and colors.
 * One alias table (typeDisplayAliases) drives both the label and the color,
 * the pin tooltip keeps the canonical dinkster id as secondary detail, and
 * unaliased dinkster types keep the deterministic fallback presentation.
 */
import { expect, test, type Page } from './fixtures.js'

const schema = {
  type: 'TypeDisplayNative',
  displayName: 'Native Dinkster Types',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [
    { kind: 'input', id: 'te', displayName: 'text encoder', type: { kind: 'concrete', name: 'dinkster.clip' }, optional: false },
    { kind: 'input', id: 'codec', displayName: 'codec', type: { kind: 'concrete', name: 'dinkster.vae' }, optional: false },
    { kind: 'input', id: 'control', displayName: 'control', type: { kind: 'concrete', name: 'dinkster.control' }, optional: false },
    { kind: 'input', id: 'guider', displayName: 'guider', type: { kind: 'concrete', name: 'dinkster.guider' }, optional: false },
    { kind: 'input', id: 'noise', displayName: 'noise', type: { kind: 'concrete', name: 'dinkster.noise' }, optional: false },
    { kind: 'output', id: 'model', displayName: 'model', type: { kind: 'concrete', name: 'dinkster.model' } },
    { kind: 'output', id: 'sampler', displayName: 'sampler', type: { kind: 'concrete', name: 'dinkster.sampler' } },
    { kind: 'output', id: 'sigmas', displayName: 'sigmas', type: { kind: 'concrete', name: 'dinkster.sigmas' } },
    { kind: 'output', id: 'cond', displayName: 'conditioning', type: { kind: 'concrete', name: 'dinkster.conditioning' } },
    { kind: 'output', id: 'latent', displayName: 'latent', type: { kind: 'concrete', name: 'dinkster.latent' } },
  ],
}

const document_ = {
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'dinkster-type-display', root: 'g0',
  graphs: { g0: { id: 'g0', name: 'root', nodes: {
    native: { id: 'native', type: 'TypeDisplayNative', values: {} },
  }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
  view: { graphs: { g0: { nodes: { native: { position: { x: 120, y: 120 } } } } } },
}

/** Expected ComfyUI palette entries for each aliased pin, keyed by port id. */
const expectations: Record<string, { alias: string; canonical: string; hex: string }> = {
  te: { alias: 'CLIP', canonical: 'dinkster.clip', hex: '#FFD500' },
  codec: { alias: 'VAE', canonical: 'dinkster.vae', hex: '#FF6E6E' },
  control: { alias: 'CONTROL_NET', canonical: 'dinkster.control', hex: '#6EE7B7' },
  guider: { alias: 'GUIDER', canonical: 'dinkster.guider', hex: '#66FFFF' },
  noise: { alias: 'NOISE', canonical: 'dinkster.noise', hex: '#B0B0B0' },
  model: { alias: 'MODEL', canonical: 'dinkster.model', hex: '#B39DDB' },
  sampler: { alias: 'SAMPLER', canonical: 'dinkster.sampler', hex: '#ECB4B4' },
  sigmas: { alias: 'SIGMAS', canonical: 'dinkster.sigmas', hex: '#CDFFCD' },
  cond: { alias: 'CONDITIONING', canonical: 'dinkster.conditioning', hex: '#FFA931' },
  latent: { alias: 'LATENT', canonical: 'dinkster.latent', hex: '#FF9CF9' },
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.evaluate(({ schema, doc }) => {
    const test = window.__dinksterTest!
    test.app.registerSchemas([schema] as never)
    const diags = test.app.openDocument(doc, 'Native dinkster type display')
    if (diags.length > 0) throw new Error(`failed to open: ${JSON.stringify(diags)}`)
    test.renderer!.setViewport({ x: 40, y: 40, scale: 1 })
  }, { schema, doc: document_ })
})

test('native dinkster pins show ComfyUI alias names with the canonical id in the tooltip', async ({ page }) => {
  const points = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'native')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const vp = renderer.getViewport()
    return node.layout.pins.map((pin: any) => ({
      portId: pin.portId as string,
      x: rect.left + (node.x + (pin.direction === 'in' ? 0 : node.layout.width)) * vp.scale + vp.x,
      y: rect.top + (node.y + pin.y) * vp.scale + vp.y,
    }))
  })
  expect(points.map((p) => p.portId).sort()).toEqual(['codec', 'cond', 'control', 'guider', 'latent', 'model', 'noise', 'sampler', 'sigmas', 'te'])
  const tooltip = page.getByTestId('app-tooltip')
  for (const point of points) {
    const expected = expectations[point.portId]!
    await page.mouse.move(point.x, point.y)
    await expect(tooltip).toContainText(`${expected.alias} (${expected.canonical})`, { timeout: 1_500 })
    // The pin label row shows the alias, never the raw dinkster id.
    await expect(tooltip).not.toContainText(`${expected.canonical} (`)
    await page.mouse.move(point.x, point.y + 200)
    await expect(tooltip).toBeHidden()
  }
})

test('native dinkster pins paint in the exact ComfyUI palette colors', async ({ page }) => {
  const pixels = await page.evaluate(async () => {
    const renderer = window.__dinksterTest!.renderer!
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'native')!
    const canvas = document.querySelector('[data-testid=graph-canvas]') as HTMLCanvasElement
    const ctx = canvas.getContext('2d')!
    const vp = renderer.getViewport()
    const dpr = canvas.width / canvas.getBoundingClientRect().width
    return node.layout.pins.map((pin: any) => {
      const x = ((node.x + (pin.direction === 'in' ? 0 : node.layout.width)) * vp.scale + vp.x) * dpr
      const y = ((node.y + pin.y) * vp.scale + vp.y) * dpr
      const data = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data
      return { portId: pin.portId as string, r: data[0]!, g: data[1]!, b: data[2]! }
    })
  })
  expect(pixels).toHaveLength(10)
  for (const pixel of pixels) {
    const hex = expectations[pixel.portId]!.hex
    const expected = { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) }
    expect(Math.abs(pixel.r - expected.r), `${pixel.portId} red`).toBeLessThanOrEqual(8)
    expect(Math.abs(pixel.g - expected.g), `${pixel.portId} green`).toBeLessThanOrEqual(8)
    expect(Math.abs(pixel.b - expected.b), `${pixel.portId} blue`).toBeLessThanOrEqual(8)
  }
})

test('visual artifact: native dinkster type node screenshot', async ({ page }, testInfo) => {
  // Not a pixel assertion - a stable, human-reviewable artifact showing the
  // aliased sockets in ComfyUI colors with ComfyUI names.
  await page.waitForTimeout(250)
  const path = testInfo.outputPath('dinkster-type-display.png')
  await page.getByTestId('graph-canvas').screenshot({ path })
  await testInfo.attach('dinkster-type-display', { path, contentType: 'image/png' })

  // Second artifact: the CLIP pin hovered, so the tooltip's aliased type line
  // ("CLIP (dinkster.clip)") is visible in the capture.
  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'native')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const vp = renderer.getViewport()
    const pin = node.layout.pins.find((candidate: any) => candidate.portId === 'te')!
    return {
      x: rect.left + node.x * vp.scale + vp.x,
      y: rect.top + (node.y + pin.y) * vp.scale + vp.y,
    }
  })
  await page.mouse.move(point.x, point.y)
  await expect(page.getByTestId('app-tooltip')).toBeVisible({ timeout: 1_500 })
  const tooltipPath = testInfo.outputPath('dinkster-type-display-tooltip.png')
  await page.screenshot({ path: tooltipPath })
  await testInfo.attach('dinkster-type-display-tooltip', { path: tooltipPath, contentType: 'image/png' })
})

// ---------------------------------------------------------------------------
// dinkster.image <-> comfy.IMAGE: one value type across the comfy-compat
// boundary. The backend registers both ids with the identical image-array
// codec, so the frontend treats them as one atom: same IMAGE color and
// label, and a native dinkster.image output legally drives a comfy.IMAGE input.
// ---------------------------------------------------------------------------

const imageSchemas = [
  {
    type: 'DinksterImageProducer',
    displayName: 'Native Image Producer',
    category: 'test',
    source: 'v3',
    isOutputNode: false,
    items: [{ kind: 'output', id: 'image', displayName: 'image', type: { kind: 'concrete', name: 'dinkster.image' } }],
  },
  {
    type: 'ComfyImageConsumer',
    displayName: 'Comfy Image Consumer',
    category: 'test',
    source: 'v3',
    isOutputNode: false,
    items: [
      { kind: 'input', id: 'image', displayName: 'image', type: { kind: 'concrete', name: 'comfy.IMAGE' }, optional: false },
      { kind: 'input', id: 'mask', displayName: 'mask', type: { kind: 'concrete', name: 'comfy.MASK' }, optional: false },
    ],
  },
]

/** Page coordinates of a pin on a scene node. */
async function imagePinPoint(page: Page, nodeId: string, direction: 'in' | 'out', portId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, direction, portId }) => {
    const renderer = window.__dinksterTest!.renderer!
    const vp = renderer.getViewport()
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === nodeId)
    if (!node) throw new Error(`no scene node '${nodeId}'`)
    const pin = node.layout.pins.find((candidate) => candidate.direction === direction && candidate.portId === portId)
    if (!pin) throw new Error(`no pin ${direction}:${portId} on '${nodeId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (node.x + (direction === 'in' ? 0 : node.layout.width)) * vp.scale + vp.x,
      y: rect.top + (node.y + pin.y) * vp.scale + vp.y,
    }
  }, { nodeId, direction, portId })
}

test('a native dinkster.image output connects to a comfy.IMAGE input as one IMAGE type', async ({ page }, testInfo) => {
  const diagnostics = await page.evaluate(({ schemas }) => {
    const test = window.__dinksterTest!
    test.app.registerSchemas(schemas as never)
    const diags = test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'dinkster-image-compat', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        src: { id: 'src', type: 'DinksterImageProducer', values: {} },
        sink: { id: 'sink', type: 'ComfyImageConsumer', values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { src: { position: { x: 80, y: 160 } }, sink: { position: { x: 460, y: 160 } } } } } },
    } as never, 'Dinkster image compat')
    test.renderer!.setViewport({ x: 40, y: 40, scale: 1 })
    return diags
  }, { schemas: imageSchemas })
  expect(diagnostics).toEqual([])
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(2)

  // The native pin presents as IMAGE with the canonical id in the tooltip.
  const srcPin = await imagePinPoint(page, 'src', 'out', 'image')
  const tooltip = page.getByTestId('app-tooltip')
  await page.mouse.move(srcPin.x, srcPin.y)
  await expect(tooltip).toContainText('IMAGE (dinkster.image)', { timeout: 1_500 })
  await page.mouse.move(srcPin.x, srcPin.y + 250)
  await expect(tooltip).toBeHidden()

  // The native pin paints in the exact ComfyUI IMAGE blue (#64B5F6).
  const pixel = await page.evaluate(async () => {
    const renderer = window.__dinksterTest!.renderer!
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'src')!
    const pin = node.layout.pins.find((candidate: any) => candidate.portId === 'image')!
    const canvas = document.querySelector('[data-testid=graph-canvas]') as HTMLCanvasElement
    const ctx = canvas.getContext('2d')!
    const vp = renderer.getViewport()
    const dpr = canvas.width / canvas.getBoundingClientRect().width
    const x = ((node.x + node.layout.width) * vp.scale + vp.x) * dpr
    const y = ((node.y + pin.y) * vp.scale + vp.y) * dpr
    const data = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data
    return { r: data[0]!, g: data[1]!, b: data[2]! }
  })
  expect(Math.abs(pixel.r - 0x64)).toBeLessThanOrEqual(8)
  expect(Math.abs(pixel.g - 0xb5)).toBeLessThanOrEqual(8)
  expect(Math.abs(pixel.b - 0xf6)).toBeLessThanOrEqual(8)

  // Drag from the native output: the comfy.IMAGE input is a legal drop
  // target, the comfy.MASK input is not.
  const imageIn = await imagePinPoint(page, 'sink', 'in', 'image')
  await page.mouse.move(srcPin.x, srcPin.y)
  await page.mouse.down()
  await page.mouse.move((srcPin.x + imageIn.x) / 2, (srcPin.y + imageIn.y) / 2)
  await page.mouse.move(imageIn.x, imageIn.y)
  const dropTargets = await page.evaluate(() => {
    const overlay = window.__dinksterTest!.renderer!.getOverlay() as unknown as { dropTargets?: Set<string> }
    return [...(overlay.dropTargets ?? [])]
  })
  expect(dropTargets).toContain('sink:image:in')
  expect(dropTargets).not.toContain('sink:mask:in')
  await page.mouse.up()

  // Release created the link, and the solver keeps it verdict-clean.
  const state = await page.evaluate(() => {
    const test = window.__dinksterTest!
    const links = Object.values(test.app.activeTab()!.store.doc.graphs['g0']!.links)
    return {
      links: links.map((link) => ({ from: link.from, to: link.to })),
      mismatches: test.renderer!.getScene().links.map((link) => link.mismatch).filter((flag) => flag === true),
    }
  })
  expect(state.links).toEqual([{ from: { node: 'src', port: 'image' }, to: { node: 'sink', port: 'image' } }])
  expect(state.mismatches).toEqual([])

  await page.waitForTimeout(250)
  const path = testInfo.outputPath('dinkster-image-comfy-image-connection.png')
  await page.getByTestId('graph-canvas').screenshot({ path })
  await testInfo.attach('dinkster-image-comfy-image-connection', { path, contentType: 'image/png' })
})

// dinkster.mask <-> comfy.MASK: the second interchangeable pair; the backend
// registers both ids with the shared image-array codec, so masks connect
// across the boundary and both spellings present as MASK.

const maskSchemas = [
  {
    type: 'DinksterMaskProducer',
    displayName: 'Native Mask Producer',
    category: 'test',
    source: 'v3',
    isOutputNode: false,
    items: [{ kind: 'output', id: 'mask', displayName: 'mask', type: { kind: 'concrete', name: 'dinkster.mask' } }],
  },
  {
    type: 'ComfyMaskConsumer',
    displayName: 'Comfy Mask Consumer',
    category: 'test',
    source: 'v3',
    isOutputNode: false,
    items: [
      { kind: 'input', id: 'mask', displayName: 'mask', type: { kind: 'concrete', name: 'comfy.MASK' }, optional: false },
      { kind: 'input', id: 'image', displayName: 'image', type: { kind: 'concrete', name: 'comfy.IMAGE' }, optional: false },
    ],
  },
]

test('a native dinkster.mask output connects to a comfy.MASK input as one MASK type', async ({ page }, testInfo) => {
  const diagnostics = await page.evaluate(({ schemas }) => {
    const test = window.__dinksterTest!
    test.app.registerSchemas(schemas as never)
    const diags = test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'dinkster-mask-compat', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        src: { id: 'src', type: 'DinksterMaskProducer', values: {} },
        sink: { id: 'sink', type: 'ComfyMaskConsumer', values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { src: { position: { x: 80, y: 160 } }, sink: { position: { x: 460, y: 160 } } } } } },
    } as never, 'Dinkster mask compat')
    test.renderer!.setViewport({ x: 40, y: 40, scale: 1 })
    return diags
  }, { schemas: maskSchemas })
  expect(diagnostics).toEqual([])
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(2)

  // The native pin presents as MASK with the canonical id in the tooltip.
  const srcPin = await imagePinPoint(page, 'src', 'out', 'mask')
  const tooltip = page.getByTestId('app-tooltip')
  await page.mouse.move(srcPin.x, srcPin.y)
  await expect(tooltip).toContainText('MASK (dinkster.mask)', { timeout: 1_500 })
  await page.mouse.move(srcPin.x, srcPin.y + 250)
  await expect(tooltip).toBeHidden()

  // The native pin paints in the exact ComfyUI MASK green (#81C784).
  const pixel = await page.evaluate(async () => {
    const renderer = window.__dinksterTest!.renderer!
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'src')!
    const pin = node.layout.pins.find((candidate: any) => candidate.portId === 'mask')!
    const canvas = document.querySelector('[data-testid=graph-canvas]') as HTMLCanvasElement
    const ctx = canvas.getContext('2d')!
    const vp = renderer.getViewport()
    const dpr = canvas.width / canvas.getBoundingClientRect().width
    const x = ((node.x + node.layout.width) * vp.scale + vp.x) * dpr
    const y = ((node.y + pin.y) * vp.scale + vp.y) * dpr
    const data = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data
    return { r: data[0]!, g: data[1]!, b: data[2]! }
  })
  expect(Math.abs(pixel.r - 0x81)).toBeLessThanOrEqual(8)
  expect(Math.abs(pixel.g - 0xc7)).toBeLessThanOrEqual(8)
  expect(Math.abs(pixel.b - 0x84)).toBeLessThanOrEqual(8)

  // Drag from the native output: the comfy.MASK input is a legal drop
  // target, the comfy.IMAGE input is not (image and mask stay distinct).
  const maskIn = await imagePinPoint(page, 'sink', 'in', 'mask')
  await page.mouse.move(srcPin.x, srcPin.y)
  await page.mouse.down()
  await page.mouse.move((srcPin.x + maskIn.x) / 2, (srcPin.y + maskIn.y) / 2)
  await page.mouse.move(maskIn.x, maskIn.y)
  const dropTargets = await page.evaluate(() => {
    const overlay = window.__dinksterTest!.renderer!.getOverlay() as unknown as { dropTargets?: Set<string> }
    return [...(overlay.dropTargets ?? [])]
  })
  expect(dropTargets).toContain('sink:mask:in')
  expect(dropTargets).not.toContain('sink:image:in')
  await page.mouse.up()

  // Release created the link, and the solver keeps it verdict-clean.
  const state = await page.evaluate(() => {
    const test = window.__dinksterTest!
    const links = Object.values(test.app.activeTab()!.store.doc.graphs['g0']!.links)
    return {
      links: links.map((link) => ({ from: link.from, to: link.to })),
      mismatches: test.renderer!.getScene().links.map((link) => link.mismatch).filter((flag) => flag === true),
    }
  })
  expect(state.links).toEqual([{ from: { node: 'src', port: 'mask' }, to: { node: 'sink', port: 'mask' } }])
  expect(state.mismatches).toEqual([])

  await page.waitForTimeout(250)
  const path = testInfo.outputPath('dinkster-mask-comfy-mask-connection.png')
  await page.getByTestId('graph-canvas').screenshot({ path })
  await testInfo.attach('dinkster-mask-comfy-mask-connection', { path, contentType: 'image/png' })
})
