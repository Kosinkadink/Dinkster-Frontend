/**
 * The node's problem box, end to end in the editor: row outlines, counted
 * tabs, the box opened by a tab click and nothing else, highlight from a line
 * to its row, and one list behind the tab, the box and Problems.
 */
import { expect, openRailPanel, nativeTest as test, waitForWorkspaceReady, type Page } from './fixtures.js'

interface Rect { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
const overlaps = (a: Rect, b: Rect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/** The node and its pins in page px. */
async function nodeRects(page: Page, nodeId: string): Promise<{ node: Rect; pins: readonly Rect[] }> {
  return page.evaluate((nodeId) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((item) => item.id === nodeId)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const v = renderer.getViewport()
    const at = (x: number, y: number) => ({ x: canvas.left + x * v.scale + v.x, y: canvas.top + y * v.scale + v.y })
    const a = at(node.x, node.y)
    const b = at(node.x + node.layout.width, node.y + node.layout.height)
    return {
      node: { left: a.x, top: a.y, right: b.x, bottom: b.y },
      pins: node.layout.pins.map((pin) => {
        const p = at(node.x + (pin.direction === 'in' ? 0 : node.layout.width), node.y + pin.y)
        return { left: p.x - 8, top: p.y - 8, right: p.x + 8, bottom: p.y + 8 }
      }),
    }
  }, nodeId)
}

async function tabPoint(page: Page, nodeId: string, badgeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, badgeId }) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((item) => item.id === nodeId)!
    const tab = renderer.getNodeBadgeLayout(node).find((entry) => entry.badge.id === badgeId)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const v = renderer.getViewport()
    return { x: canvas.left + (tab.x + tab.width / 2) * v.scale + v.x, y: canvas.top + (tab.y + tab.height / 2) * v.scale + v.y }
  }, { nodeId, badgeId })
}

async function rowPoint(page: Page, nodeId: string, inputId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, inputId }) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((item) => item.id === nodeId)!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const v = renderer.getViewport()
    return { x: canvas.left + (node.x + node.layout.width / 2) * v.scale + v.x, y: canvas.top + (node.y + row.y + row.height / 2) * v.scale + v.y }
  }, { nodeId, inputId })
}

const nodeHeight = (page: Page) => page.evaluate(() =>
  window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'gen')!.layout.height)

test.beforeEach(async ({ page }) => {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'problem-box-fixture', schemaWire: 2 }, nodes: {},
  } }))
  await page.route('**/api/workflows/plan', (route) => route.fulfill({ json: { packs: [], assets: [], errors: [] } }))
  await page.goto('/')
  await waitForWorkspaceReady(page)
})

test('a problem outlines its row and the tab opens one box under the node', async ({ page }) => {
  // Generate image: width and height with no lower limit, steps with an upper limit of 10000.
  await page.evaluate(async () => {
    const field = (id: string, value: number, options: Record<string, unknown> = {}) => ({
      kind: 'input', id, type: { kind: 'concrete', name: 'INT' }, optional: false,
      widget: { widgetType: 'INT', options, default: value },
    })
    window.__dinksterTest!.app.registerSchemas([{
      type: 'ProblemBoxGenerate', displayName: 'Generate image', category: 'test', source: 'v3', isOutputNode: false,
      body: [
        { kind: 'output', id: 'image', type: { kind: 'concrete', name: 'IMAGE' } },
        field('width', 1024), field('height', 1024), field('steps', 20, { min: 1, max: 10000 }),
      ],
    }])
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'problem-box', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        gen: { id: 'gen', type: 'ProblemBoxGenerate', values: { width: 1024, height: 1024, steps: 20 } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { gen: { position: { x: 200, y: 120 } } } } } },
    }, 'Problem Box')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  const cleanHeight = await nodeHeight(page)

  // Width and height are 0, breaking one rule each that reads only that field,
  // reported as the editor reports a failed node rule; steps is beyond its limit.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    for (const [inputId, value] of [['width', 0], ['height', 0], ['steps', 12000]] as const)
      tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'gen', inputId, value } })
    const rule = (index: number, field: string, message: string) => ({
      severity: 'error' as const, origin: 'compile' as const, code: 'node.rule.failed', message,
      refs: [{ graphId: 'g0', nodeId: 'gen', portId: field, valueKey: field, direction: 'input' as const }],
      data: { rule: index, hasFix: false, fields: [field] },
    })
    app.reportProblems(tab.id, [rule(0, 'width', 'Width must be positive.'), rule(1, 'height', 'Height must be positive.')])
  })

  // Row outlines in the kind's color, nothing at the node's edge, counted tabs.
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getRowMarks()['gen'])).toEqual({
    width: 'error', height: 'error', steps: 'warning',
  })
  await expect.poll(() => page.evaluate(() =>
    (window.__dinksterTest!.renderer!.getBadges()['gen'] ?? []).map((badge) => badge.glyph))).toEqual(['Error 2', 'Warning'])
  expect(await nodeHeight(page)).toBe(cleanHeight)

  // Selecting the node and pointing at its rows open nothing.
  const steps = await rowPoint(page, 'gen', 'steps')
  await page.mouse.move(steps.x, steps.y)
  const box = page.getByTestId('problem-box')
  await expect(box).toHaveCount(0)
  const nodes = await nodeRects(page, 'gen')
  await page.mouse.click((nodes.node.left + nodes.node.right) / 2, nodes.node.top + 10)
  await page.waitForTimeout(300)
  await expect(box).toHaveCount(0)

  // Clicking Error 2 opens the box: three lines, rows top to bottom.
  const errorTab = await tabPoint(page, 'gen', 'core.problem.error')
  await page.mouse.click(errorTab.x, errorTab.y)
  await expect(box).toHaveAttribute('data-node', 'gen')
  await expect(box.getByTestId('problem-box-line')).toHaveText([
    /^width: Width must be positive\./,
    /^height: Height must be positive\./,
    /^steps: /,
  ])

  // Pointing at the height line lights the height row.
  await box.getByTestId('problem-box-line').nth(1).hover()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getProblemRowHighlight()))
    .toEqual({ nodeId: 'gen', row: 'height' })

  // The box covers neither the node nor any pin.
  const rect = await box.boundingBox()
  const boxRect = { left: rect!.x, top: rect!.y, right: rect!.x + rect!.width, bottom: rect!.y + rect!.height }
  expect(overlaps(boxRect, nodes.node)).toBe(false)
  for (const pin of nodes.pins) expect(overlaps(boxRect, pin)).toBe(false)

  // One list behind the tab, the box and Problems: 2 + 1 causes.
  await openRailPanel(page, 'Problems')
  await expect(page.getByTestId('problems-panel').locator('details.problem')).toHaveCount(3)
})
