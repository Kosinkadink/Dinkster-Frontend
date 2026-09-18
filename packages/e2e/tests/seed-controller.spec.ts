import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from './fixtures.js'

const fanoutProofDir = process.env['DINKSTER_CONTROLLER_FANOUT_PROOF_DIR']
if (fanoutProofDir) mkdirSync(fanoutProofDir, { recursive: true })

async function chipPoint(page: Page, inputId: string) {
  return page.evaluate((inputId) => {
    const renderer = window.__dinksterTest!.renderer! as any
    const node = renderer.getScene().nodes.find((item: any) => item.id === 'n0')!
    const row = node.layout.rows.find((item: any) => item.kind === 'widget' && item.inputId === inputId)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    // Mirror controllerChipRect: the square chip sits immediately before the
    // trailing edge control with one control gap.
    const inset = row.inset ?? 0
    const rowWidth = node.layout.width - inset * 2
    const size = row.height - 8
    const chipX = Math.max(12, rowWidth - 12 - 6 - size)
    return {
      x: canvas.left + node.x + inset + chipX + size / 2,
      y: canvas.top + node.y + row.y + row.height / 2,
    }
  }, inputId)
}

async function widgetPoint(page: Page, inputId: string) {
  return page.evaluate((inputId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'n0')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      // Stay in the widget body even when a short value places its controller
      // chip near the row center.
      x: canvas.left + node.x + node.layout.width / 4,
      y: canvas.top + node.y + row.y + row.height / 2,
    }
  }, inputId)
}

async function incrementPoint(page: Page, inputId: string) {
  return page.evaluate((inputId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'n0')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const inset = row.inset ?? 0
    return {
      x: canvas.left + node.x + node.layout.width - inset - 6,
      y: canvas.top + node.y + row.y + row.height / 2,
    }
  }, inputId)
}

const state = (page: Page) => page.evaluate(() => {
  const tab = window.__dinksterTest!.app.activeTab()! as any
  const node = tab.store.doc.graphs[tab.store.doc.root]!.nodes.n0!
  const row = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'n0')!.layout.rows
    .find((item) => item.kind === 'widget' && item.inputId === 'width')! as any
  return { controller: node.controllers?.width, width: node.values.width, height: node.values.height, displayed: row.controllerMode }
})

test.beforeEach(async ({ page }, testInfo) => {
  const mockLegacyDiscovery = testInfo.annotations.some((annotation) => annotation.type === 'mock-legacy-discovery')
  if (mockLegacyDiscovery) {
    await page.route('/system_stats', (route) =>
      route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
    )
    await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  }
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  if (mockLegacyDiscovery) return
  await page.evaluate(() => {
    const test = window.__dinksterTest! as any
    const node = test.renderer!.getScene().nodes.find((item: any) => item.id === 'n0')!
    const registry = test.app.registry.get()!
    const original = registry.resolve(node.node.type)!
    test.app.registerSchemas([{ ...original, items: original.items.map((item: any) =>
      item.kind === 'input' && item.id === 'width' && item.widget
        ? { ...item, widget: { ...item.widget, controller: 'after_generate' } }
        : item,
    ) }])
    const tab = test.app.activeTab()!
    tab.store.dispatch({ command: 'node.setValue', params: { graphId: tab.store.doc.root, nodeId: 'n0', inputId: 'width', value: 64 } })
    tab.store.dispatch({ command: 'node.setValue', params: { graphId: tab.store.doc.root, nodeId: 'n0', inputId: 'height', value: 64 } })
    tab.store.dispatch({ command: 'node.setController', params: { graphId: tab.store.doc.root, nodeId: 'n0', inputId: 'width', mode: 'fixed' } })
    test.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
})

test('controller chip opens a detailed menu, selects a persistent mode, and undo restores it', async ({ page }) => {
  await expect.poll(() => state(page)).toMatchObject({ controller: 'fixed', displayed: 'fixed' })
  const point = await chipPoint(page, 'width')
  await page.mouse.move(point.x - 20, point.y)
  await page.mouse.move(point.x, point.y)
  await expect(page.getByTestId('app-tooltip')).toContainText('Fixed', { timeout: 1_500 })
  await page.keyboard.down('Alt')
  await expect(page.getByTestId('app-tooltip')).toContainText('Only successful runs', { timeout: 250 })
  await page.keyboard.up('Alt')
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('seed-controller-menu')).toBeVisible()
  await expect(page.getByTestId('seed-controller-fixed')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('seed-controller-randomize')).toContainText('Randomize after run')
  await expect(page.getByTestId('seed-controller-randomize')).toContainText('selecting this mode does not change the current value')
  await page.getByTestId('seed-controller-randomize').click()
  await expect.poll(() => state(page)).toMatchObject({ controller: 'randomize', displayed: 'randomize' })
  await page.keyboard.press('Control+z')
  await expect.poll(() => state(page)).toMatchObject({ controller: 'fixed', displayed: 'fixed' })
})

test('INT expanded editor has no controller control; the compact chip remains the sole surface', async ({ page }) => {
  const point = await widgetPoint(page, 'width')
  await page.mouse.click(point.x, point.y)
  const editor = page.getByTestId('widget-editor')
  await expect(editor).toBeVisible()
  await expect(page.getByTestId('widget-editor-controller')).toHaveCount(0)
  await page.keyboard.press('Escape')

  const chip = await chipPoint(page, 'width')
  await page.mouse.click(chip.x, chip.y)
  await expect(page.getByTestId('seed-controller-menu')).toBeVisible()
  await expect(page.getByTestId('seed-controller-fixed')).toHaveAttribute('aria-checked', 'true')
})

test('20 rapid INT increments commit exact declared steps and undo individually', {
  annotation: { type: 'mock-legacy-discovery' },
}, async ({ page }) => {
  await page.evaluate(() => {
    const test = window.__dinksterTest!
    test.app.registerSchemas([{
      type: 'RapidSeedE2E', displayName: 'Rapid Seed', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'seed', type: { kind: 'concrete', name: 'core.int' }, optional: false,
        widget: {
          widgetType: 'INT', options: { min: 0, max: Number.MAX_SAFE_INTEGER, step: 3 }, default: 100,
          controller: 'after_generate', controllerInitial: 'increment',
        },
      }],
    }])
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'rapid-seed-e2e', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        n0: { id: 'n0', type: 'RapidSeedE2E', values: { seed: 100 }, controllers: { seed: 'increment' } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { n0: { position: { x: 160, y: 140 }, size: { width: 340, height: 70 } } } } } },
    }, 'Rapid Seed')
    test.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .find((node) => node.id === 'n0')?.layout.rows
    .some((row) => row.kind === 'widget' && row.inputId === 'seed'))).toBe(true)
  await expect.poll(() => page.evaluate(() => 'status' in window.__dinksterTest!.app.activeTab()!.store)).toBe(true)
  const before = await page.screenshot({ animations: 'disabled' })
  const point = await incrementPoint(page, 'seed')
  for (let index = 0; index < 20; index++) await page.mouse.click(point.x, point.y)
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return { value: tab.store.doc.graphs.g0!.nodes.n0!.values.seed, revision: tab.store.revision }
  })).toEqual({ value: 160, revision: 20 })
  const after = await page.screenshot({ animations: 'disabled' })
  await test.info().attach('rapid-seed-before', { body: before, contentType: 'image/png' })
  await test.info().attach('rapid-seed-after', { body: after, contentType: 'image/png' })
  await page.evaluate(() => {
    const store = window.__dinksterTest!.app.activeTab()!.store
    for (let index = 0; index < 20; index++) {
      if (!store.undo()) throw new Error(`undo ${index + 1} refused`)
    }
  })
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return { value: tab.store.doc.graphs.g0!.nodes.n0!.values.seed, revision: tab.store.revision }
  })).toEqual({ value: 100, revision: 40 })
})

test('completed runs advance promoted controller values on each subgraph occurrence', {
  annotation: { type: 'mock-legacy-discovery' },
}, async ({ page }, testInfo) => {
  await page.evaluate(() => {
    const test = window.__dinksterTest!
    test.app.registerSchemas([{
      type: 'PromotedControllerE2E', displayName: 'Promoted Controller', category: 'test', source: 'v3', isOutputNode: true,
      items: [
        {
          kind: 'input', id: 'seed', type: { kind: 'concrete', name: 'INT' }, optional: false,
          widget: {
            widgetType: 'INT', options: { min: 0, max: 100, step: 1 }, default: 1,
            controller: 'after_generate',
          },
        },
        { kind: 'output', id: 'out', type: { kind: 'concrete', name: 'INT' } },
      ],
    }])
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'promoted-controller-e2e', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Root',
          nodes: {
            left: { id: 'left', type: '#controlled', values: { seed: 10 }, controllers: { seed: 'decrement' } },
            right: { id: 'right', type: '#controlled', values: { seed: 20 }, controllers: { seed: 'increment' } },
          },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 3,
        },
        controlled: {
          id: 'controlled', name: 'Reusable controlled seed',
          nodes: {
            leaf: { id: 'leaf', type: 'PromotedControllerE2E', values: { seed: 5 }, controllers: { seed: 'randomize' } },
          },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
          boundary: {
            inputs: [{ id: 'seed', binds: { kind: 'port', node: 'leaf', port: 'seed' }, promoted: true }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'leaf', port: 'out' } }],
          },
        },
      },
      view: { graphs: { root: { nodes: {
        left: { position: { x: 140, y: 180 }, size: { width: 300, height: 90 } },
        right: { position: { x: 520, y: 180 }, size: { width: 300, height: 90 } },
      } }, controlled: { nodes: {} } } },
    }, 'Promoted Controllers')
    ;(test.app as any).shell.statusBarVisible.set(false)
    test.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .filter((node) => node.layout.rows.some((row) => row.kind === 'widget' && row.inputId === 'seed')).length)).toBe(2)

  const beforePath = testInfo.outputPath('promoted-controller-before-completion.png')
  await page.screenshot({ path: beforePath, animations: 'disabled' })
  await testInfo.attach('promoted-controller-before-completion', { path: beforePath, contentType: 'image/png' })
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const tab = app.activeTab()!
    const result = app.compileTab(tab)
    if (result === undefined || !result.ok) throw new Error(`compile failed: ${JSON.stringify(result?.diagnostics)}`)
    const execution = { connection: result.artifact.connection, prompt: 'promoted-controller-e2e-run' as never }
    app.registerRun(tab, execution, result.artifact, Date.now())
    app.store.apply({ kind: 'completed', execution, timestamp: Date.now() + 1 })
  })
  await expect.poll(() => page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    return {
      left: document.graphs.root!.nodes.left!.values.seed,
      right: document.graphs.root!.nodes.right!.values.seed,
      definition: document.graphs.controlled!.nodes.leaf!.values.seed,
    }
  })).toEqual({ left: 9, right: 21, definition: 5 })
  const afterPath = testInfo.outputPath('promoted-controller-after-completion.png')
  await page.screenshot({ path: afterPath, animations: 'disabled' })
  await testInfo.attach('promoted-controller-after-completion', { path: afterPath, contentType: 'image/png' })
})

test('promoted fan-out advancement follows primary binding order', {
  annotation: { type: 'mock-legacy-discovery' },
}, async ({ page }, testInfo) => {
  await page.evaluate(() => {
    const controlled = (type: string, name: string) => ({
      type, displayName: name, category: 'test', source: 'v3', isOutputNode: true,
      items: [
        {
          kind: 'input', id: 'seed', type: { kind: 'concrete', name: 'INT' }, optional: false,
          widget: {
            widgetType: 'INT', options: { min: 0, max: 100, step: 1 }, default: 1,
            controller: 'after_generate',
          },
        },
        { kind: 'output', id: 'out', type: { kind: 'concrete', name: 'INT' } },
      ],
    } as const)
    const test = window.__dinksterTest!
    test.app.registerSchemas([
      controlled('FanoutPrimaryE2E', 'Primary controller'),
      controlled('FanoutSecondaryE2E', 'Secondary controller'),
    ])
    const innerNodes = {
      primary: {
        id: 'primary', type: 'FanoutPrimaryE2E', values: { seed: 10 }, controllers: { seed: 'increment' },
      },
      secondary: {
        id: 'secondary', type: 'FanoutSecondaryE2E', values: { seed: 20 }, controllers: { seed: 'decrement' },
      },
    }
    const boundary = {
      inputs: [{
        id: 'seed', displayName: 'Primary seed',
        binds: { kind: 'port', node: 'primary', port: 'seed' },
        alsoBinds: [{ kind: 'port', node: 'secondary', port: 'seed' }],
        promoted: true,
      }],
      outputs: [{ id: 'out', binds: { kind: 'port', node: 'primary', port: 'out' } }],
    }
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'controller-fanout-order-e2e', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Primary fan-out order',
          nodes: {
            first: { id: 'first', type: '#primaryFirst', values: {} },
            second: { id: 'second', type: '#secondaryFirst', values: {} },
          },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 3,
        },
        primaryFirst: {
          id: 'primaryFirst', name: 'Primary stored first',
          nodes: { primary: innerNodes.primary, secondary: innerNodes.secondary },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 3, boundary,
        },
        secondaryFirst: {
          id: 'secondaryFirst', name: 'Secondary stored first',
          nodes: { secondary: innerNodes.secondary, primary: innerNodes.primary },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 3, boundary,
        },
      },
      view: { graphs: { root: { nodes: {
        first: { position: { x: 140, y: 180 }, size: { width: 300, height: 90 } },
        second: { position: { x: 520, y: 180 }, size: { width: 300, height: 90 } },
      } }, primaryFirst: { nodes: {} }, secondaryFirst: { nodes: {} } } },
    }, 'Primary fan-out order')
    ;(test.app as any).shell.statusBarVisible.set(false)
    test.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .filter((node) => node.layout.rows.some((row) => row.kind === 'widget' && row.inputId === 'seed')).length)).toBe(2)

  const beforePath = fanoutProofDir
    ? join(fanoutProofDir, 'controller-fanout-before-completion.png')
    : testInfo.outputPath('controller-fanout-before-completion.png')
  await page.screenshot({ path: beforePath, animations: 'disabled', fullPage: true })
  await testInfo.attach('controller-fanout-before-completion', { path: beforePath, contentType: 'image/png' })
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const tab = app.activeTab()!
    const result = app.compileTab(tab)
    if (result === undefined || !result.ok) throw new Error(`compile failed: ${JSON.stringify(result?.diagnostics)}`)
    const execution = { connection: result.artifact.connection, prompt: 'controller-fanout-order-e2e-run' as never }
    app.registerRun(tab, execution, result.artifact, Date.now())
    app.store.apply({ kind: 'completed', execution, timestamp: Date.now() + 1 })
  })
  const afterPath = fanoutProofDir
    ? join(fanoutProofDir, 'controller-fanout-after-completion.png')
    : testInfo.outputPath('controller-fanout-after-completion.png')
  await page.screenshot({ path: afterPath, animations: 'disabled', fullPage: true })
  await testInfo.attach('controller-fanout-after-completion', { path: afterPath, contentType: 'image/png' })
  await expect.poll(() => page.evaluate(() => {
    const nodes = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!.nodes
    return { primaryFirst: nodes.first!.values.seed, secondaryFirst: nodes.second!.values.seed }
  })).toEqual({ primaryFirst: 11, secondaryFirst: 11 })
})

test('controller rows keep stable responsive value geometry across digit widths', {
  annotation: { type: 'mock-legacy-discovery' },
}, async ({ page }) => {
  await page.evaluate(() => {
    const numeric = (id: string, value: number, controlled = true) => ({
      kind: 'input', id, type: { kind: 'concrete', name: 'INT' }, optional: false,
      widget: {
        widgetType: 'INT', options: { min: 0, max: 9007199254740991, step: 1 }, default: value,
        ...(controlled ? { controller: 'after_generate' } : {}),
      },
    })
    const test = window.__dinksterTest!
    test.app.registerSchemas([{
      type: 'ControllerWidthE2E', displayName: 'Controller Widths', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        numeric('one_digit', 7),
        numeric('two_digits', 50),
        numeric('seven_digits', 1234567),
        numeric('safe_integer', 9007199254740991),
        numeric('ordinary', 50, false),
      ],
    }])
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'controller-widths', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        n0: {
          id: 'n0', type: 'ControllerWidthE2E',
          values: { one_digit: 7, two_digits: 50, seven_digits: 1234567, safe_integer: 9007199254740991, ordinary: 50 },
          controllers: { one_digit: 'randomize', two_digits: 'randomize', seven_digits: 'randomize', safe_integer: 'randomize' },
        },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { n0: { position: { x: 100, y: 100 } } } } } },
    }, 'Controller Widths')
    test.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .find((node) => node.id === 'n0')?.layout.rows.filter((row) => row.kind === 'widget').length)).toBe(5)

  const geometry = () => page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer! as any
    const node = renderer.getScene().nodes.find((item: any) => item.id === 'n0')!
    const rows = node.layout.rows.filter((item: any) => item.kind === 'widget')
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return rows.map((row: any) => {
      const inset = row.inset ?? 0
      const rowWidth = node.layout.width - inset * 2
      const value = node.node.values[row.valueKey]
      if (row.controllerMode === undefined) {
        return {
          id: row.inputId, controlled: false, rowWidth,
          textPaintRight: node.x + inset + rowWidth - 12 - 6 - 2,
        }
      }
      const size = row.height - 8
      const chipX = Math.max(12, rowWidth - 12 - 6 - size)
      const valueWidth = Math.max(0, chipX - 12)
      return {
        id: row.inputId, controlled: true, rowWidth, chipX, size, valueWidth,
        textCapacity: Math.max(0, valueWidth - 4),
        measured: renderer.measureWidgetText(String(value)),
        textPaintRight: node.x + inset + chipX - 6 - 2,
        chipPageX: canvas.left + node.x + inset + chipX + size / 2,
        valuePageX: canvas.left + node.x + inset + 12 + valueWidth * 0.75,
        pageY: canvas.top + node.y + row.y + row.height / 2,
      }
    })
  })

  type RowGeometry = {
    id: string; controlled: boolean; rowWidth: number; textPaintRight: number
    chipX?: number; size?: number; valueWidth?: number; textCapacity?: number; measured?: number
    chipPageX?: number; valuePageX?: number; pageY?: number
  }
  const narrow = await geometry() as RowGeometry[]
  const controlled = narrow.filter((row) => row.controlled) as Array<{
    id: string; chipX: number; size: number; valueWidth: number; textCapacity: number; measured: number
    textPaintRight: number; chipPageX: number; valuePageX: number; pageY: number
  }>
  expect(new Set(controlled.map((row) => row.chipX)).size).toBe(1)
  expect(controlled.every((row) => row.valueWidth > 0)).toBe(true)
  expect(new Set(controlled.map((row) => row.textPaintRight)).size).toBe(1)
  expect(narrow.find((row) => !row.controlled)!.textPaintRight).toBeGreaterThan(controlled[0]!.textPaintRight)

  const sceneClip = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'n0')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + node.x - 8, y: canvas.top + node.y - 8, width: node.layout.width + 16, height: node.layout.height + 16 }
  })
  await test.info().attach('controller-widths-narrow', {
    body: await page.screenshot({ clip: sceneClip, animations: 'disabled' }),
    contentType: 'image/png',
  })

  const long = controlled.find((row) => row.id === 'safe_integer')!
  await page.mouse.move(long.valuePageX, long.pageY)
  await expect(page.getByTestId('app-tooltip')).toContainText('Value: 9007199254740991', { timeout: 1_500 })
  const first = controlled.find((row) => row.id === 'one_digit')!
  await page.mouse.click(first.chipPageX, first.pageY)
  await expect(page.getByTestId('seed-controller-menu')).toBeVisible()
  await page.keyboard.press('Escape')

  await page.evaluate(() => {
    const test = window.__dinksterTest!
    const tab = test.app.activeTab()!
    const node = test.renderer!.getScene().nodes.find((item) => item.id === 'n0')!
    tab.store.dispatch({
      command: 'view.setNodeSize',
      params: { graphId: tab.store.doc.root, nodeId: 'n0', size: { width: 390, height: node.layout.height } },
    })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .find((node) => node.id === 'n0')?.layout.width)).toBe(390)
  const wide = await geometry() as RowGeometry[]
  const wideLong = wide.find((row) => row.id === 'safe_integer') as { measured: number; textCapacity: number }
  expect(wideLong.textCapacity).toBeGreaterThan(controlled.find((row) => row.id === 'safe_integer')!.textCapacity)
  const wideClip = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'n0')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + node.x - 8, y: canvas.top + node.y - 8, width: node.layout.width + 16, height: node.layout.height + 16 }
  })
  await test.info().attach('controller-widths-wide', {
    body: await page.screenshot({ clip: wideClip, animations: 'disabled' }),
    contentType: 'image/png',
  })
})

test('remote COMBO reuses the controller chip with refresh-specific copy', async ({ page }) => {
  let remoteRequests = 0
  await page.route('**/api/choices/seed-controller-options', async (route) => {
    remoteRequests += 1
    await route.fulfill({ json: ['alpha', 'beta', 'gamma'] })
  })
  await page.evaluate(() => {
    const test = window.__dinksterTest!
    test.app.registerSchemas([{
      type: 'RefreshComboE2E', displayName: 'Refresh Combo', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'choice', type: { kind: 'concrete', name: 'core.combo' }, optional: false,
        widget: {
          widgetType: 'COMBO', options: {}, default: 'alpha', controller: 'after_refresh',
          remote: { route: '/api/choices/seed-controller-options', refreshButton: true },
        },
      }],
    }])
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'refresh-combo-e2e', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        n0: { id: 'n0', type: 'RefreshComboE2E', values: { choice: 'alpha' }, controllers: { choice: 'increment' } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { n0: { position: { x: 100, y: 100 } } } } } },
    }, 'Refresh Combo')
    test.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .find((node) => node.id === 'n0')?.layout.rows
    .some((row) => row.kind === 'widget' && row.inputId === 'choice'))).toBe(true)
  const chip = await chipPoint(page, 'choice')
  await page.mouse.click(chip.x, chip.y)
  await expect(page.getByTestId('seed-controller-menu')).toContainText('After refresh')
  await expect(page.getByTestId('seed-controller-increment')).toContainText('Choose the next option after refresh.')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('seed-controller-menu')).not.toBeVisible()
  const row = await widgetPoint(page, 'choice')
  await page.mouse.click(row.x, row.y)
  await expect(page.getByTestId('combo-dropdown')).toHaveAttribute('data-remote', 'ready')
  await expect(page.getByTestId('widget-editor-controller')).toHaveCount(0)
  expect(remoteRequests).toBe(1)
  await page.getByTestId('remote-refresh').click()
  await expect.poll(() => remoteRequests).toBe(2)
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n0!.values.choice)).toBe('beta')
  await page.keyboard.press('Control+z')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n0!.values.choice)).toBe('alpha')
})

test('a completed backend run increments by step and leaves a fixed widget alone', async ({ page }) => {
  const point = await chipPoint(page, 'width')
  await page.mouse.click(point.x, point.y)
  await page.getByTestId('seed-controller-increment').click()
  await page.getByTestId('queue-button').click()
  const row = page.getByTestId('execution-row').first()
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
  await expect.poll(() => state(page)).toMatchObject({ width: 65, height: 64 })
})
