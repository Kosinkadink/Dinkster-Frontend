/**
 * MatchType (type variable) pin repaint: connecting a concrete producer to
 * one variable-typed pin must resolve EVERY pin sharing that template on the
 * node to the concrete type (the renderer paints pin color from the solved
 * type), and disconnecting must revert them to the unresolved variable.
 * Asserted through the live renderer's scene - the same objects the paint
 * pass consumes; color mapping itself is pinned by canvas unit tests.
 */
import { expect, openRailPanel, test, type Page } from './fixtures.js'

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

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

async function drillInto(page: Page, nodeId: string): Promise<void> {
  const header = await page.evaluate((nodeId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + node.layout.headerHeight / 2 }
  }, nodeId)
  await page.mouse.dblclick(header.x, header.y)
  await openRailPanel(page, 'Boundary')
  await expect(page.getByTestId('boundary-panel')).toBeVisible()
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
}

const pinPresentation = (page: Page, nodeId: string, portId: string, direction?: 'in' | 'out') =>
  page.evaluate(({ nodeId, portId, direction }) => {
    const pin = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === nodeId)!
      .layout.pins.find((candidate) => candidate.portId === portId &&
        (direction === undefined || candidate.direction === direction))!
    return { type: pin.type, matchVariable: pin.matchVariable, inferred: pin.inferred }
  }, { nodeId, portId, direction })

test.beforeEach(async ({ page }) => {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'match-type-e2e', schemaWire: 1 },
    nodes: {},
  } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(() => {
    const concrete = (name: string) => ({ kind: 'concrete', name })
    // One template shared by two inputs and the output: resolving any one
    // endpoint must resolve them all.
    const variable = { kind: 'variable', templateId: 'T' }
    const imageOrMask = {
      kind: 'variable',
      templateId: 'input_type',
      allowedTypes: [concrete('IMAGE'), concrete('MASK')],
    }
    const fourTypes = { kind: 'union', names: ['STRING', 'INT', 'FLOAT', 'BOOLEAN'] }
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'MatchNodeE2E', displayName: 'Match Node', category: 'test', source: 'v3', isOutputNode: false,
        items: [
          { kind: 'input', id: 'a', type: variable, optional: true },
          { kind: 'input', id: 'b', type: variable, optional: true },
          { kind: 'output', id: 'out', type: variable },
        ],
      },
      {
        type: 'ImageProducerE2E', displayName: 'Image Producer', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'output', id: 'out', type: concrete('IMAGE') }],
      },
      {
        type: 'ImageListProducerE2E', displayName: 'Image List Producer', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'output', id: 'out', type: { kind: 'list', element: concrete('IMAGE') } }],
      },
      {
        type: 'ImageSinkE2E', displayName: 'Image Sink', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'in', type: concrete('IMAGE'), optional: false }],
      },
      {
        type: 'AnyNodeE2E', displayName: 'Any Node', category: 'test', source: 'v3', isOutputNode: false,
        items: [
          { kind: 'input', id: 'in', type: { kind: 'wildcard' }, optional: false },
          { kind: 'output', id: 'out', type: { kind: 'wildcard' } },
        ],
      },
      {
        type: 'ResizeImageMaskE2E', displayName: 'Resize Image/Mask', category: 'test', source: 'v3', isOutputNode: false,
        items: [
          { kind: 'input', id: 'input', type: imageOrMask, optional: false },
          { kind: 'input', id: 'reference', type: { kind: 'union', names: ['IMAGE', 'MASK'] }, optional: true },
          { kind: 'output', id: 'resized', type: imageOrMask },
        ],
      },
      {
        type: 'ValueConvertE2E', displayName: 'Value Convert', category: 'test', source: 'v3', isOutputNode: false,
        items: [
          { kind: 'input', id: 'value', type: fourTypes, optional: false },
          { kind: 'output', id: 'value', type: fourTypes },
        ],
      },
      {
        type: 'FormatStringE2E', displayName: 'Format String', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'value', type: fourTypes, optional: false }],
      },
    ])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'match-type-e2e', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        image: { id: 'image', type: 'ImageProducerE2E', values: {} },
        image_list: { id: 'image_list', type: 'ImageListProducerE2E', values: {} },
        match: { id: 'match', type: 'MatchNodeE2E', values: {} },
        sink: { id: 'sink', type: 'ImageSinkE2E', values: {} },
        any: { id: 'any', type: 'AnyNodeE2E', values: {} },
        resize: { id: 'resize', type: 'ResizeImageMaskE2E', values: {} },
        convert: { id: 'convert', type: 'ValueConvertE2E', values: {} },
        format: { id: 'format', type: 'FormatStringE2E', values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 10 } },
      view: { graphs: { g0: { nodes: {
        image: { position: { x: 80, y: 100 } },
        image_list: { position: { x: 80, y: 300 } },
        match: { position: { x: 500, y: 180 } },
        sink: { position: { x: 800, y: 100 } },
        any: { position: { x: 500, y: 420 } },
        resize: { position: { x: 900, y: 220 } },
        convert: { position: { x: 900, y: 420 } },
        format: { position: { x: 200, y: 600 } },
      } } } },
    }, 'Match Type E2E')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
})

test('finite unions and constrained generics expose every accepted type in both directions', async ({ page }) => {
  for (const port of ['input', 'resized']) {
    expect(await pinPresentation(page, 'resize', port)).toEqual({
      type: {
        kind: 'variable',
        templateId: 'input_type',
        allowedTypes: [{ kind: 'concrete', name: 'IMAGE' }, { kind: 'concrete', name: 'MASK' }],
      },
      matchVariable: 'input_type',
      inferred: undefined,
    })
  }
  for (const [nodeId, portId, direction, names] of [
    ['resize', 'reference', 'in', ['IMAGE', 'MASK']],
    ['convert', 'value', 'in', ['STRING', 'INT', 'FLOAT', 'BOOLEAN']],
    ['convert', 'value', 'out', ['STRING', 'INT', 'FLOAT', 'BOOLEAN']],
    ['format', 'value', 'in', ['STRING', 'INT', 'FLOAT', 'BOOLEAN']],
  ] as const) {
    const presentation = await pinPresentation(page, nodeId, portId, direction)
    expect(presentation.matchVariable).toBeUndefined()
    expect(presentation.type).toEqual({ kind: 'union', names })
  }
  if (process.env['DINKSTER_MATCHTYPE_PROOF_DIR']) {
    await page.screenshot({
      path: `${process.env['DINKSTER_MATCHTYPE_PROOF_DIR']}/union-generic-unresolved.png`,
      animations: 'disabled',
    })
  }

  await drag(page, await pinPoint(page, 'image', 'out'), await pinPoint(page, 'resize', 'input'))
  for (const port of ['input', 'resized']) {
    await expect.poll(() => pinPresentation(page, 'resize', port)).toEqual({
      type: { kind: 'concrete', name: 'IMAGE' },
      matchVariable: 'input_type',
      inferred: true,
    })
  }
  if (process.env['DINKSTER_MATCHTYPE_PROOF_DIR']) {
    await page.screenshot({
      path: `${process.env['DINKSTER_MATCHTYPE_PROOF_DIR']}/union-generic-resolved.png`,
      animations: 'disabled',
    })
  }
})

test('connecting one variable pin repaints every shared pin concrete; disconnect reverts', async ({ page }) => {
  // Unresolved: all three pins display the raw template variable.
  for (const port of ['a', 'b', 'out']) {
    expect(await pinPresentation(page, 'match', port)).toEqual({
      type: { kind: 'variable', templateId: 'T' },
      matchVariable: 'T',
      inferred: undefined,
    })
  }
  if (process.env['DINKSTER_MATCHTYPE_PROOF_DIR']) {
    await page.screenshot({
      path: `${process.env['DINKSTER_MATCHTYPE_PROOF_DIR']}/matchtype-unresolved.png`,
      animations: 'disabled',
    })
  }

  await drag(page, await pinPoint(page, 'image', 'out'), await pinPoint(page, 'match', 'a'))

  // One connection binds T for the whole node: the connected pin AND its
  // unconnected siblings (input b, output out) all display concrete IMAGE.
  for (const port of ['a', 'b', 'out']) {
    await expect.poll(() => pinPresentation(page, 'match', port), { message: `pin '${port}' resolves` })
      .toEqual({ type: { kind: 'concrete', name: 'IMAGE' }, matchVariable: 'T', inferred: true })
  }
  if (process.env['DINKSTER_MATCHTYPE_PROOF_DIR']) {
    await page.screenshot({
      path: `${process.env['DINKSTER_MATCHTYPE_PROOF_DIR']}/matchtype-scalar-inferred.png`,
      animations: 'disabled',
    })
  }

  // Disconnect: drag the noodle off the input and drop on empty canvas.
  const input = await pinPoint(page, 'match', 'a')
  await drag(page, input, { x: input.x + 140, y: input.y + 140 })

  // The binding dissolves with the edge - every pin reverts to the variable.
  for (const port of ['a', 'b', 'out']) {
    await expect.poll(() => pinPresentation(page, 'match', port), { message: `pin '${port}' reverts` })
      .toEqual({ type: { kind: 'variable', templateId: 'T' }, matchVariable: 'T', inferred: undefined })
  }
})

test('list inference keeps nesting and downstream inference works from a generic output', async ({ page }) => {
  await drag(page, await pinPoint(page, 'match', 'a'), await pinPoint(page, 'image_list', 'out'))
  for (const port of ['a', 'b', 'out']) {
    await expect.poll(() => pinPresentation(page, 'match', port))
      .toEqual({
        type: { kind: 'list', element: { kind: 'concrete', name: 'IMAGE' } },
        matchVariable: 'T',
        inferred: true,
      })
  }
  if (process.env['DINKSTER_MATCHTYPE_PROOF_DIR']) {
    await page.screenshot({
      path: `${process.env['DINKSTER_MATCHTYPE_PROOF_DIR']}/matchtype-list-inferred.png`,
      animations: 'disabled',
    })
  }

  const input = await pinPoint(page, 'match', 'a')
  await drag(page, input, { x: input.x + 120, y: input.y + 120 })
  await drag(page, await pinPoint(page, 'match', 'out'), await pinPoint(page, 'sink', 'in'))
  await expect.poll(() => pinPresentation(page, 'match', 'a')).toEqual({
    type: { kind: 'concrete', name: 'IMAGE' },
    matchVariable: 'T',
    inferred: true,
  })
})

test('wildcard Any accepts independently without capturing or propagating a type', async ({ page }) => {
  expect(await pinPresentation(page, 'any', 'in')).toEqual({
    type: { kind: 'wildcard' },
    matchVariable: undefined,
    inferred: undefined,
  })
  await drag(page, await pinPoint(page, 'image_list', 'out'), await pinPoint(page, 'any', 'in'))
  for (const port of ['in', 'out']) {
    await expect.poll(() => pinPresentation(page, 'any', port)).toEqual({
      type: { kind: 'wildcard' },
      matchVariable: undefined,
      inferred: undefined,
    })
  }
  if (process.env['DINKSTER_MATCHTYPE_PROOF_DIR']) {
    await page.screenshot({
      path: `${process.env['DINKSTER_MATCHTYPE_PROOF_DIR']}/matchtype-wildcard-independent.png`,
      animations: 'disabled',
    })
  }
})

test('drilled input-family MatchType resolves each occurrence independently and reverts on disconnect', async ({ page }) => {
  await page.evaluate(() => {
    const variable = { kind: 'variable', templateId: 'T' }
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'InputFamilyMatchE2E', displayName: 'Input Family Match', category: 'test', source: 'v3', isOutputNode: false,
        items: [
          {
            kind: 'input', id: 'items', type: { kind: 'wildcard' }, optional: false,
            dynamic: {
              kind: 'autogrow',
              template: [{ kind: 'input', id: 'value', type: variable, optional: false }],
              naming: { kind: 'prefix', prefix: 'value', min: 1, max: 8 },
            },
          },
          { kind: 'output', id: 'result', type: { kind: 'list', element: variable } },
        ],
      },
      {
        type: 'LatentProducerE2E', displayName: 'Latent Producer', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'LATENT' } }],
      },
    ])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'boundary-match-e2e', root: 'g0',
      graphs: {
        g0: { id: 'g0', name: 'root', nodes: {
          image: { id: 'image', type: 'ImageProducerE2E', values: {} },
          latent: { id: 'latent', type: 'LatentProducerE2E', values: {} },
          i1: { id: 'i1', type: '#sub', values: {} }, i2: { id: 'i2', type: '#sub', values: {} },
        }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 20 },
        sub: { id: 'sub', name: 'Wrapper', nodes: {
          match: {
            id: 'match', type: 'InputFamilyMatchE2E', values: {},
            dynamic: { items: { members: ['m0', 'm1'], seq: 2 } },
          },
        },
          links: {}, nets: {}, reroutes: {}, boundary: {
            inputs: [{ id: 'in', binds: { kind: 'port', node: 'match', port: 'items.value', members: ['m0'] } }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'match', port: 'result' } }],
          }, nextOrdinal: 2 },
      },
      view: { graphs: {
        g0: { nodes: {
          image: { position: { x: 60, y: 100 } }, latent: { position: { x: 60, y: 360 } },
          i1: { position: { x: 420, y: 100 } }, i2: { position: { x: 420, y: 360 } },
        } },
        sub: { nodes: { match: { position: { x: 340, y: 180 } } } },
      } },
    }, 'Boundary Match Type')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  const type = (nodeId: string, portId: string) => page.evaluate(({ nodeId, portId }) =>
    window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === nodeId)!
      .layout.pins.find((p) => p.portId === portId)!.type, { nodeId, portId })

  const listOf = (name: string) => ({ kind: 'list', element: { kind: 'concrete', name } })
  for (const id of ['i1', 'i2']) expect(await type(id, 'out')).toEqual({
    kind: 'list', element: { kind: 'variable', templateId: 'match:T' },
  })

  await drillInto(page, 'i1')
  for (const port of ['items.value#m0', 'items.value#m1']) {
    expect(await type('match', port)).toEqual({ kind: 'variable', templateId: 'T' })
  }
  if (process.env['DINKSTER_MATCHTYPE_PROOF_DIR']) {
    await page.screenshot({ path: `${process.env['DINKSTER_MATCHTYPE_PROOF_DIR']}/matchtype-input-before.png`, animations: 'disabled' })
  }
  await page.getByTestId('graph-breadcrumb').locator('.crumb').first().click()
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))

  await drag(page, await pinPoint(page, 'image', 'out'), await pinPoint(page, 'i1', 'in'))
  await drag(page, await pinPoint(page, 'latent', 'out'), await pinPoint(page, 'i2', 'in'))
  await expect.poll(() => type('i1', 'out')).toEqual(listOf('IMAGE'))
  await expect.poll(() => type('i2', 'out')).toEqual(listOf('LATENT'))

  await drillInto(page, 'i1')
  for (const port of ['items.value#m0', 'items.value#m1']) {
    await expect.poll(() => type('match', port)).toEqual({ kind: 'concrete', name: 'IMAGE' })
  }
  await expect.poll(() => type('match', 'result')).toEqual(listOf('IMAGE'))
  if (process.env['DINKSTER_MATCHTYPE_PROOF_DIR']) {
    await page.screenshot({ path: `${process.env['DINKSTER_MATCHTYPE_PROOF_DIR']}/matchtype-input-after.png`, animations: 'disabled' })
  }

  await page.getByTestId('graph-breadcrumb').locator('.crumb').first().click()
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))

  const input = await pinPoint(page, 'i1', 'in')
  await drag(page, input, { x: input.x + 120, y: input.y + 120 })
  await expect.poll(() => type('i1', 'out')).toEqual({
    kind: 'list', element: { kind: 'variable', templateId: 'match:T' },
  })
  expect(await type('i2', 'out')).toEqual(listOf('LATENT'))

  await drillInto(page, 'i1')
  for (const port of ['items.value#m0', 'items.value#m1']) {
    await expect.poll(() => type('match', port)).toEqual({ kind: 'variable', templateId: 'T' })
  }
  await expect.poll(() => type('match', 'result')).toEqual({
    kind: 'list', element: { kind: 'variable', templateId: 'T' },
  })
})
