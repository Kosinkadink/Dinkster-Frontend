import { expect, test, type Page } from './fixtures.js'

const activeDoc = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

async function pinPoint(page: Page, nodeId: string, portId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, portId }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const pin = node.layout.pins.find((item) => item.portId === portId)!
    if (!pin) throw new Error(`no pin '${nodeId}/${portId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + node.x + (pin.direction === 'out' ? node.layout.width : 0),
      y: rect.top + node.y + pin.y,
    }
  }, { nodeId, portId })
}

async function rowPoint(page: Page, inputId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((inputId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'slot')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    if (!row) throw new Error(`no widget row '${inputId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  }, inputId)
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

async function connect(page: Page, producer = 'image'): Promise<void> {
  await drag(page, await pinPoint(page, producer, 'out'), await pinPoint(page, 'slot', 'slot'))
}

async function disconnect(page: Page): Promise<void> {
  const input = await pinPoint(page, 'slot', 'slot')
  await drag(page, input, { x: input.x + 120, y: input.y + 120 })
}

async function specialize(page: Page, key: 'image' | 'latent'): Promise<void> {
  const input = await pinPoint(page, 'slot', 'slot')
  await page.mouse.click(input.x, input.y, { button: 'right' })
  await page.locator(`[data-item-id="core.slot.specialize.${key}"]`).click()
}

async function clearSpecialization(page: Page): Promise<void> {
  const input = await pinPoint(page, 'slot', 'slot')
  await page.mouse.click(input.x, input.y, { button: 'right' })
  await page.locator('[data-item-id="core.slot.specialize.clear"]').click()
}

async function visibleWidgetIds(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .find((item) => item.id === 'slot')!.layout.rows
    .filter((row) => row.kind === 'widget').map((row) => row.inputId!))
}

const selectedVariant = (doc: Awaited<ReturnType<typeof activeDoc>>) =>
  (doc.graphs.g0!.nodes.slot as {
    dynamic?: Record<string, { selected?: string }>
  }).dynamic?.slot?.selected

async function setStrength(page: Page, value: string): Promise<void> {
  const point = await rowPoint(page, 'slot.[image].strength')
  await page.mouse.click(point.x, point.y)
  const input = page.getByTestId('widget-editor').locator('input')
  await input.fill(value)
  await input.press('Enter')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(() => {
    const concrete = (name: string) => ({ kind: 'concrete', name })
    const wildcard = { kind: 'wildcard' }
    const widget = (id: string, widgetType: string, defaultValue: number) => ({
      kind: 'input', id, type: concrete(widgetType), optional: true,
      widget: { widgetType, options: {}, default: defaultValue },
    })
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'DynamicSlotE2E', displayName: 'Dynamic Slot', category: 'test', source: 'v3', isOutputNode: false,
        items: [{
          kind: 'input', id: 'slot', type: wildcard, optional: true,
          dynamic: {
            kind: 'dynamicSlot', slotType: wildcard, inputs: [],
            variants: [
              { key: 'image', type: concrete('IMAGE'), inputs: [widget('strength', 'FLOAT', 1)] },
              { key: 'latent', type: concrete('LATENT'), inputs: [widget('samples', 'INT', 20)] },
            ],
          },
        }],
      },
      {
        type: 'ImageProducerE2E', displayName: 'Image Producer', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'output', id: 'out', type: concrete('IMAGE') }],
      },
      {
        type: 'GenericProducerE2E', displayName: 'Generic Producer', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'output', id: 'out', type: wildcard }],
      },
    ])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'dynamic-slot-e2e', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        image: { id: 'image', type: 'ImageProducerE2E', values: {} },
        generic: { id: 'generic', type: 'GenericProducerE2E', values: {} },
        slot: { id: 'slot', type: 'DynamicSlotE2E', values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 10 } },
      view: { graphs: { g0: { nodes: {
        image: { position: { x: 80, y: 100 } }, generic: { position: { x: 80, y: 350 } },
        slot: { position: { x: 500, y: 180 } },
      } } } },
    }, 'Dynamic Slot E2E')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
})

test('concrete fresh connect auto-specializes atomically and one undo restores the base form', async ({ page }) => {
  await connect(page)
  expect(await visibleWidgetIds(page)).toContain('slot.[image].strength')
  let doc = await activeDoc(page)
  expect(selectedVariant(doc)).toBe('image')
  expect(Object.keys(doc.graphs.g0!.links)).toHaveLength(1)

  await page.keyboard.press('Control+z')
  doc = await activeDoc(page)
  expect(selectedVariant(doc)).toBeUndefined()
  expect(Object.keys(doc.graphs.g0!.links)).toHaveLength(0)
  expect(await visibleWidgetIds(page)).toEqual([])
})

test('generic producer connects without selecting a variant', async ({ page }) => {
  await connect(page, 'generic')
  const doc = await activeDoc(page)
  expect(Object.keys(doc.graphs.g0!.links)).toHaveLength(1)
  expect(selectedVariant(doc)).toBeUndefined()
  expect(await visibleWidgetIds(page)).toEqual([])
})

test('manual specialization switches variants and preserves branch-local values', async ({ page }) => {
  await connect(page, 'generic')
  await specialize(page, 'image')
  expect(await visibleWidgetIds(page)).toContain('slot.[image].strength')
  await setStrength(page, '2.75')

  await specialize(page, 'latent')
  expect(await visibleWidgetIds(page)).toContain('slot.[latent].samples')
  expect(await visibleWidgetIds(page)).not.toContain('slot.[image].strength')
  await specialize(page, 'image')
  expect(await visibleWidgetIds(page)).toContain('slot.[image].strength')
  expect((await activeDoc(page)).graphs.g0!.nodes.slot!.values['slot.[image].strength']).toBe(2.75)
})

test('disconnect hides dependents and reconnect restores selection and value', async ({ page }) => {
  await connect(page, 'generic')
  await specialize(page, 'image')
  await setStrength(page, '3.5')
  await disconnect(page)
  expect(await visibleWidgetIds(page)).toEqual([])
  let doc = await activeDoc(page)
  expect(selectedVariant(doc)).toBe('image')
  expect(doc.graphs.g0!.nodes.slot!.values['slot.[image].strength']).toBe(3.5)

  await connect(page, 'generic')
  expect(await visibleWidgetIds(page)).toContain('slot.[image].strength')
  doc = await activeDoc(page)
  expect(doc.graphs.g0!.nodes.slot!.values['slot.[image].strength']).toBe(3.5)
})

test('clear specialization returns a connected slot to its base form', async ({ page }) => {
  await connect(page, 'generic')
  await specialize(page, 'image')
  await clearSpecialization(page)
  const doc = await activeDoc(page)
  expect(Object.keys(doc.graphs.g0!.links)).toHaveLength(1)
  expect(selectedVariant(doc)).toBeUndefined()
  expect(await visibleWidgetIds(page)).toEqual([])
})

test('a stale specialization is marked in the Problems panel and clears when resolved', async ({ page }) => {
  const problems = page.getByTestId('problems-panel')
  // IMAGE producer + persisted 'latent' choice: the solver advisory must be
  // user-visible, not just a core diagnostic.
  await connect(page, 'image')
  await specialize(page, 'latent')
  await expect(problems).toContainText('solve.slot.staleSpecialization')
  // Canvas-visible, not only panel-visible: the live renderer's scene must
  // carry the warn flag on the slot pin (the renderer paints an error ring
  // for it - paint itself is pinned by canvas unit tests).
  const slotPinWarn = () =>
    page.evaluate(
      () =>
        window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === 'slot')!
          .layout.pins.find((p) => p.portId === 'slot' && p.direction === 'in')?.warn,
    )
  await expect.poll(slotPinWarn).toBe(true)
  // Derived, not logged: fixing the choice removes the entry on the next build.
  await specialize(page, 'image')
  await expect(problems).not.toContainText('solve.slot.staleSpecialization')
  await expect.poll(slotPinWarn).toBeUndefined()
})
