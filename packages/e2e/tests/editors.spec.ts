/**
 * Editor seam (docs/editors.md): the center region resolves the active tab's
 * editorKind through EditorRegistry. The pinned lifecycle contract is that
 * the ONE registered graph editor never remounts across same-kind tab
 * switches, registry churn for other kinds, or the no-active-tab default -
 * per-tab canvas view state (viewport, gestures) lives in CanvasHost and a
 * remount would silently reset it.
 *
 * CanvasHost assigns window.__dinksterTest.renderer once per mount, so strict
 * in-page identity of that object across operations proves "never
 * remounted" without reaching into component internals.
 */
import { expect, nativeTest as test } from './fixtures.js'

declare global {
}

test.beforeEach(async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/supervisor/status', (route) => route.fulfill({ json: {
    protocol: 1,
    state: 'ready',
    detail: 'Engine healthy',
    progress: { done: 1, total: 1, phase: 'Engine healthy' },
  } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'editor-role-e2e', schemaWire: 1 },
    packs: { test: { displayName: 'Test' } },
    nodes: {
      'synthetic.curve': {
        schemaVersion: 1,
        nodeType: 'synthetic.curve',
        displayName: 'Synthetic Curve',
        category: 'test',
        pack: 'test',
        signature: 'editor-role-e2e-curve',
        editorRole: 'curve',
        interface: [
          {
            role: 'input',
            id: 'curve',
            required: true,
            type: { kind: 'concrete', types: ['CURVE'] },
            widget: { type: 'CURVE' },
            default: {
              interpolation: 'linear',
              points: [
                { position: 0, value: 0 },
                { position: 1, value: 1 },
              ],
            },
          },
          {
            role: 'input',
            id: 'enabled',
            required: true,
            type: { kind: 'concrete', types: ['BOOLEAN'] },
            widget: { type: 'BOOLEAN', labelOn: 'On', labelOff: 'Off' },
            default: false,
          },
        ],
      },
    },
  } }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined)
})

test('a synthetic node opens its editor from the schema role', async ({ page }) => {
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'editor-role-e2e',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'Editor role',
            nodes: {
              curve: { id: 'curve', type: 'synthetic.curve', values: { enabled: false } }
            },
            links: {},
            nets: {},
            reroutes: {},
            nextOrdinal: 2
          }
        },
        view: {
          graphs: {
            g0: { nodes: { curve: { position: { x: 160, y: 120 } } } }
          }
        }
      },
      'Editor role'
    )
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.waitForFunction(() => window.__dinksterTest!.renderer!.getScene().nodes.some((node) => node.id === 'curve' && node.layout.rows.some((row) => row.inputId === 'curve')))
  const points = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'curve')!
    const viewport = renderer.getViewport()
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const point = (inputId: string) => {
      const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === inputId)!
      return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y
      }
    }
    return { curve: point('curve'), enabled: point('enabled') }
  })
  await page.mouse.click(points.enabled.x, points.enabled.y)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.curve!.values.enabled)).toBe(true)
  await page.mouse.click(points.curve.x, points.curve.y)
  await expect(page.getByTestId('curve-editor')).toBeVisible()
  if (process.env['DINKSTER_ROLE_SCREENSHOT']) {
    await page.screenshot({
      path: process.env['DINKSTER_ROLE_SCREENSHOT'],
      fullPage: true
    })
  }
})
