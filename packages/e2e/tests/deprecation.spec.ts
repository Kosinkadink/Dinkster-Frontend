/**
 * extension API implementation deprecation/replacement UX: safe plans auto-apply on document open
 * (one undo step), the review toggle holds them for manual approval, and
 * deprecation badges display name-only successor guidance. The rule arrives
 * through the PUBLIC pack registration API on the bridge - the real
 * backend's object_info ships no replacement metadata (that is a Dinkster/V3
 * concern), which is exactly the pack-extension path.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from './fixtures.js'

const objectInfo = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../core/fixtures/object_info.json', import.meta.url)),
  'utf8',
)) as Record<string, unknown>

// Exact values derived once from the served dev-pack catalog; see the
// fixture's _provenance. The audit lane serves that catalog instead of the
// V1-style object_info fixture the route-mocked lanes use, so the synthetic
// replacement rule and document must use the native ids it actually serves.
const nativeCatalog = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/native-catalog.json', import.meta.url)),
  'utf8',
)) as {
  emptyLatent: { type: string; outputs: [string, ...string[]] }
  emptyMinimaxH3Av: { type: string }
  vaeDecode: { type: string }
}
const inAuditLane = () => (test.info().config.configFile ?? '').includes('audit-assets')

interface DeprecationIds {
  sourceType: string
  targetType: string
  sourceOutput: string
  sinkType: string
  targetBatchInput: string
}

const deprecationIds = (): DeprecationIds => {
  if (inAuditLane()) {
    return {
      sourceType: nativeCatalog.emptyLatent.type,
      targetType: nativeCatalog.emptyMinimaxH3Av.type,
      sourceOutput: nativeCatalog.emptyLatent.outputs[0],
      sinkType: nativeCatalog.vaeDecode.type,
      targetBatchInput: 'frame_count',
    }
  }
  return {
    sourceType: 'OldEmpty', targetType: 'EmptyLatentImage', sourceOutput: 'out0',
    sinkType: 'VAEDecode', targetBatchInput: 'batch_size',
  }
}

/** Reset the viewport to identity so world coords == canvas CSS pixels. */
async function identityViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

/** Page coordinates of badge slot 0 (rightmost) on a scene node's header. */
async function badgePoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nodeId) => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const node = r.getScene().nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error(`no scene node '${nodeId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    // Mirrors badgeRect(): index 0 is rightmost, 22px inset.
    return {
      x: rect.left + (node.x + node.layout.width - 22 + 7) * vp.scale + vp.x,
      y: rect.top + (node.y + node.layout.headerHeight / 2) * vp.scale + vp.y,
    }
  }, nodeId)
}

/**
 * Register the OldEmpty -> EmptyLatentImage pack rule and open a document
 * containing one OldEmpty node (plus an optional dropped-link sink to make
 * the plan lossy). Returns openDocument's diagnostics.
 */
async function openDeprecatedDoc(
  page: Page,
  opts: { lineage: string; lossy?: boolean },
): Promise<readonly unknown[]> {
  const ids = deprecationIds()
  const diagnostics = await page.evaluate(({ lineage, lossy, sourceType, targetType, sourceOutput, sinkType, targetBatchInput }) => {
    const app = window.__dinksterTest!.app
    app.registerReplacementRule('pack', {
      from: sourceType,
      note: 'renamed upstream',
      cases: [
        lossy
          ? { to: targetType } // no output map -> dropped link warning
          : {
              to: targetType,
              inputs: {
                width: { kind: 'copy', input: 'width' },
                height: { kind: 'copy', input: 'height' },
                [targetBatchInput]: { kind: 'copy', input: 'batch_size' },
              },
              outputs: { [sourceOutput]: sourceOutput },
            },
      ],
    })
    const nodes: Record<string, unknown> = {
      old: { id: 'old', type: sourceType, values: { width: 512 } },
    }
    const links: Record<string, unknown> = {}
    if (lossy) {
      nodes.sink = { id: 'sink', type: sinkType, values: {} }
      links.l0 = { id: 'l0', from: { node: 'old', port: sourceOutput }, to: { node: 'sink', port: 'samples' } }
    }
    return app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage,
        root: 'g0',
        graphs: { g0: { id: 'g0', name: 'root', nodes, links, nets: {}, reroutes: {}, nextOrdinal: 99 } },
        view: {
          graphs: {
            g0: { nodes: { old: { position: { x: 120, y: 120 } }, sink: { position: { x: 420, y: 120 } } } },
          },
        },
        meta: { title: lineage },
      },
      `Dep ${lineage}`,
    )
  }, { ...opts, ...ids })
  // The shared-store handoff dismisses focus-scoped popovers on the local store.
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })).toBe(true)
  return diagnostics
}

/** The active tab's root-graph node types, keyed by node id. */
const rootTypes = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const doc = tab.store.doc
    return Object.fromEntries(Object.values(doc.graphs[doc.root]!.nodes).map((n) => [n.id, n.type]))
  })

async function openWidget(page: Page, nodeId: string, inputId: string): Promise<void> {
  const point = await page.evaluate(({ nodeId, inputId }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === nodeId)!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === inputId)
    if (!row) throw new Error(`no widget row '${inputId}' on '${nodeId}'`)
    const canvas = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return {
      x: canvas.left + node.x + node.layout.width / 2,
      y: canvas.top + node.y + row.y + row.height / 2,
    }
  }, { nodeId, inputId })
  await page.mouse.click(point.x, point.y)
}

test.beforeEach(async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: objectInfo }))
  await page.routeWebSocket('/ws*', () => {})
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
})

test('a safe plan auto-applies on open as one undoable step', async ({ page }) => {
  const { sourceType, targetType } = deprecationIds()
  expect(await openDeprecatedDoc(page, { lineage: 'dep-auto' })).toEqual([])
  expect((await rootTypes(page)).old).toBe(targetType)
  // Copied value survived the migration.
  const width = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return tab.store.doc.graphs.g0!.nodes.old!.values.width
  })
  expect(width).toBe(512)
  await expect(page.getByTestId('problems-panel')).toContainText('applied 1 replacement step(s) automatically')
  // ONE undo restores the deprecated node exactly.
  await page.evaluate(() => void window.__dinksterTest!.app.activeTab()!.store.undo())
  expect((await rootTypes(page)).old).toBe(sourceType)
})

test('a historical dynamic selection migrates into a current static combo', async ({ page }, testInfo) => {
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([
      {
        type: 'DynamicComboMigrationFixture', displayName: 'Dynamic Combo Migration', category: 'test', source: 'v3', isOutputNode: false,
        items: [{
          kind: 'input', id: 'format', type: { kind: 'concrete', name: 'STRING' }, optional: false,
          dynamic: { kind: 'dynamicCombo', options: [
            { key: 'mp4_h264', inputs: [] },
            { key: 'webm_av1', inputs: [] },
          ] },
        }],
      },
      {
        type: 'ComboMigrationFixture', displayName: 'Combo Migration', category: 'test', source: 'v3', isOutputNode: false,
        items: [{
          kind: 'input', id: 'format', type: { kind: 'concrete', name: 'COMBO' }, optional: false,
          widget: { widgetType: 'COMBO', options: { options: ['mp4_h264', 'webm_av1'] }, default: 'mp4_h264' },
        }],
      },
    ])
    app.registerReplacementRule('pack', {
      from: 'DynamicComboMigrationFixture',
      cases: [{
        to: 'ComboMigrationFixture',
        inputs: { format: { kind: 'copy', input: 'format' } },
      }],
    })
    return app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'dynamic-to-static-combo', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        old: {
          id: 'old', type: 'DynamicComboMigrationFixture', values: {},
          dynamic: { format: { selected: 'webm_av1' } },
        },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { old: { position: { x: 120, y: 120 } } } } } },
    }, 'Dynamic to Static Combo')
  })).toEqual([])

  await expect.poll(() => page.evaluate(() => {
    const node = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.old!
    return { type: node.type, format: node.values.format, dynamic: node.dynamic }
  })).toEqual({ type: 'ComboMigrationFixture', format: 'webm_av1', dynamic: undefined })

  await identityViewport(page)
  await openWidget(page, 'old', 'format')
  const selected = page.getByTestId('combo-dropdown').getByRole('option', { name: 'webm_av1', exact: true })
  await expect(selected).toHaveAttribute('aria-selected', 'true')
  const screenshot = await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('migrated-static-combo.png'),
  })
  await testInfo.attach('migrated-static-combo', {
    body: screenshot,
    contentType: 'image/png',
  })
  await page.keyboard.press('Escape')

  const exported = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return JSON.parse(JSON.stringify(app.exportDocument(app.activeTab()!.id)!))
  })
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await page.evaluate(() => {
    const node = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.old!
    return {
      type: node.type,
      hasFormatValue: Object.hasOwn(node.values, 'format'),
      selected: node.dynamic?.format?.selected,
    }
  })).toEqual({ type: 'DynamicComboMigrationFixture', hasFormatValue: false, selected: 'webm_av1' })

  expect(await page.evaluate((document) =>
    window.__dinksterTest!.app.openDocument(document, 'Dynamic to Static Combo Reopened'), exported)).toEqual([])
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })).toBe(true)
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'old')?.layout.rows
      .some((row) => row.kind === 'widget' && row.inputId === 'format'),
  )).toBe(true)
  expect(await page.evaluate(() => {
    const node = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.old!
    return { type: node.type, format: node.values.format, dynamic: node.dynamic }
  })).toEqual({ type: 'ComboMigrationFixture', format: 'webm_av1', dynamic: undefined })
  await identityViewport(page)
  await openWidget(page, 'old', 'format')
  await expect(page.getByTestId('combo-dropdown').getByRole('option', { name: 'webm_av1', exact: true }))
    .toHaveAttribute('aria-selected', 'true')
})

test('native deprecation badges show guidance without graph replacement controls', async ({ page }, testInfo) => {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'deprecation-fixture', schemaWire: 1 },
    nodes: {
      AuthoredNode: { deprecation: { message: 'Use CurrentNode for new workflows', since: '2.0', replacement: 'CurrentNode' }, interface: [] },
      CurrentNode: { interface: [] },
      NoSuccessor: { deprecation: { message: 'This node is deprecated' }, interface: [] },
    },
  } }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/3 node schemas/, { timeout: 30_000 })
  expect(await page.evaluate(() => window.__dinksterTest!.app.openDocument({
    nodes: [{ id: 1, type: 'AuthoredNode', pos: [120, 120] }, { id: 2, type: 'NoSuccessor', pos: [450, 120] }], links: [],
  }, 'Deprecation guidance'))).toEqual([])
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(2)
  await identityViewport(page)
  for (const [id, text, filename] of [
    ['n1', "Successor: 'CurrentNode'", 'deprecation-successor.png'],
    ['n2', 'No successor is declared.', 'deprecation-no-successor.png'],
  ]) {
    await page.keyboard.press('Escape')
    const point = await badgePoint(page, id!)
    await page.mouse.click(point.x, point.y)
    const popover = page.getByTestId('badge-popover')
    await expect(popover).toBeVisible()
    await expect(popover).toContainText(text!)
    await expect(popover.getByRole('button')).toHaveCount(0)
    await popover.screenshot({ path: testInfo.outputPath(filename!) })
  }
  expect(await rootTypes(page)).toEqual({ n1: 'AuthoredNode', n2: 'NoSuccessor' })
})
