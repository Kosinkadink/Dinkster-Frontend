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
import { expect, test } from './fixtures.js'

declare global {
  interface Window {
    __rendererProbe?: unknown
  }
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
    nodes: {},
  } }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined)
})

test('graph editor mounts once and never remounts across tab switches, registry churn, or no active tab', async ({
  page,
}) => {
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const document = structuredClone(app.activeTab()!.store.doc)
    document.lineage = 'editor-lifecycle-second-tab'
    app.openDocument(document, 'Second graph')
  })
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(2)

  // Capture the mounted CanvasHost's renderer identity in-page.
  await page.evaluate(() => {
    window.__rendererProbe = window.__dinksterTest!.renderer
  })
  const rendererUnchanged = () =>
    page.evaluate(
      () => window.__rendererProbe !== undefined && window.__rendererProbe === window.__dinksterTest!.renderer,
    )
  expect(await rendererUnchanged()).toBe(true)

  // Same-kind tab switches: the registry returns the same descriptor object,
  // so the keyed Show must not re-render the editor.
  await page.getByTestId('tab-bar').locator('.tab').first().click()
  expect(await rendererUnchanged()).toBe(true)
  await page.getByTestId('tab-bar').locator('.tab').last().click()
  expect(await rendererUnchanged()).toBe(true)

  // Registry churn for an UNRELATED kind bumps editors.changed; the graph
  // descriptor is untouched, so the mounted editor must survive both ticks.
  await page.evaluate(() => {
    const unregister = window.__dinksterTest!.app.editors.register({
      id: 'e2e-temp-editor',
      title: 'Temp',
      component: () => null,
    })
    unregister()
  })
  expect(await rendererUnchanged()).toBe(true)

  // No active tab: editor-kind resolution defaults to the graph kind (the
  // canvas host owns the empty state), so the editor must stay mounted.
  const previousActive = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const previous = app.activeTabId.get()
    app.activeTabId.set('')
    return previous
  })
  expect(await rendererUnchanged()).toBe(true)
  await expect(page.getByTestId('editor-missing')).toHaveCount(0)
  await page.evaluate((id) => window.__dinksterTest!.app.activeTabId.set(id), previousActive)
  expect(await rendererUnchanged()).toBe(true)
})

test('unknown editor kind shows the loud missing-editor fallback, not blank space', async ({ page }) => {
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  // Force the active tab onto a kind nothing registered. Mutating the tab
  // object directly is test-only surgery: tabs are created through makeTab
  // and there is no user path to an unknown kind today (that is the point -
  // this pins the failure mode for when future kinds CAN appear).
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const active = app.activeTab() as unknown as { editorKind: string }
    active.editorKind = 'not-a-registered-kind'
    const tabs = app.tabs as unknown as { set(tabs: readonly unknown[]): void }
    tabs.set([...app.tabs.get()])
  })
  await expect(page.getByTestId('editor-missing')).toContainText("No editor registered for kind 'not-a-registered-kind'")
  await expect(page.getByTestId('graph-canvas')).toHaveCount(0)
})

test('a synthetic node opens its editor from the schema role', async ({ page }) => {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([
      {
        type: 'synthetic.curve',
        displayName: 'Synthetic Curve',
        category: 'test',
        source: 'v3',
        isOutputNode: false,
        editorRole: 'curve',
        items: [
          {
            kind: 'input',
            id: 'curve',
            type: { kind: 'concrete', name: 'dinkster.curve' },
            optional: false,
            widget: {
              widgetType: 'CURVE',
              options: {},
              default: {
                interpolation: 'linear',
                points: [
                  { position: 0, value: 0 },
                  { position: 1, value: 1 }
                ]
              }
            }
          },
          {
            kind: 'input',
            id: 'enabled',
            type: { kind: 'concrete', name: 'core.boolean' },
            optional: false,
            widget: { widgetType: 'BOOLEAN', options: {}, default: false }
          }
        ]
      }
    ])
    app.openDocument(
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
