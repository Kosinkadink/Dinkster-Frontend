// The 18 screens captured by the component audit (comfy-vibe-station#505).
// Run against a fresh frontend and its workflow-pinned native backend, with
// the development pack loaded. AUDIT_BASE selects the frontend; AUDIT_OUT and
// AUDIT_RESULTS select the screenshot directory and JSON report.
import fs from 'node:fs'
import path from 'node:path'
import { chromium, expect } from '@playwright/test'
import axe from 'axe-core'

const BASE = process.env['AUDIT_BASE'] ?? 'http://127.0.0.1:15630'
const OUT = process.env['AUDIT_OUT'] ?? path.resolve('a11y-screenshots')
const AXE = axe.source
const RESULTS =
  process.env['AUDIT_RESULTS'] ?? path.join(OUT, '..', 'a11y-dinkster.json')
fs.mkdirSync(OUT, { recursive: true })

const demoWorkflow = {
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'audit-505-demo',
  root: 'g0',
  graphs: {
    g0: {
      id: 'g0',
      name: 'Audit demo',
      nodes: {
        gen: {
          id: 'gen',
          type: 'dinkster.image.generate',
          values: {
            width: 64,
            height: 64,
            batch_size: 1,
            channels: 'rgb',
            color_source: 'hex',
            operation: 'solid',
            color_a: '#336699',
          },
        },
        prev: { id: 'prev', type: 'dinkster.preview_image', values: {} },
      },
      links: {
        l1: {
          id: 'l1',
          from: { node: 'gen', port: 'image' },
          to: { node: 'prev', port: 'images' },
        },
      },
      nets: {},
      reroutes: {},
      nextOrdinal: 3,
    },
  },
  view: {
    graphs: {
      g0: {
        nodes: {
          gen: { position: { x: 80, y: 120 } },
          prev: { position: { x: 480, y: 120 } },
        },
      },
    },
  },
}

const screens = []
const errors = []
let current = 'boot'

async function audit(page, id, note) {
  current = id
  const surface = {
    '01-start-gallery': '.template-gallery-content',
    '02-blank-canvas': '[data-testid="graph-canvas"]',
    '03-canvas-demo-workflow': '[data-testid="graph-canvas"]',
    '04-dock-library': '[role="tabpanel"][id$="-panel-library"]',
    '04-dock-assets': '[role="tabpanel"][id$="-panel-assets"]',
    '04-dock-backends': '[data-testid="backends-panel"]',
    '05-bottom-execution-log': '[data-testid="execution-log-panel"]',
    '06-rail-focused-node-selected':
      '[data-testid="context-summary"][data-context-kind="node"]',
    '07-rail-problems': '[data-testid="problems-panel"]',
    '08-rail-boundary': '[data-testid="boundary-panel"]',
    '09-widget-combo-editor': '[data-testid="combo-dropdown"]',
    '10-widget-int-editor': '[data-testid="widget-editor"]',
    '12-node-context-menu': '[data-testid="context-menu"]',
    '13-node-palette': '[data-testid="node-palette"]',
    '14-universal-search': '.search-result-listbox [role="option"]',
    '15-modal-settings': '.settings-editor',
    '15-modal-projects': '[data-testid="projects-dialog"]',
    '15-modal-collab': '[data-testid="collab-panel"]',
  }[id]
  if (!surface) throw new Error(`Unknown audit screen ${id}`)
  await expect(page.locator(surface).first()).toBeVisible()
  if (id === '01-start-gallery') {
    await expect(
      page.locator('.template-family[role="group"][aria-label]').first(),
    ).toBeVisible()
    await expect(page.getByTestId('template-card').first()).toBeVisible()
  }
  if (id === '02-blank-canvas' || id === '03-canvas-demo-workflow') {
    await expect(page.locator('.template-gallery-content')).toBeHidden()
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__dinksterTest.renderer
            .getScene()
            .nodes.map((node) => node.id)
            .sort(),
        ),
      )
      .toEqual(id === '02-blank-canvas' ? [] : ['gen', 'prev'])
  }
  if (id === '10-widget-int-editor')
    await expect(page.getByTestId('widget-editor-type')).toHaveText('INT')
  if (id === '14-universal-search')
    await expect(page.getByTestId('universal-search-input')).toHaveValue('sett')
  await page.waitForTimeout(500)
  await page.screenshot({
    path: path.join(OUT, `${id}.png`),
    animations: 'disabled',
  })
  await page.evaluate(AXE)
  const result = await page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
      },
      resultTypes: ['violations', 'incomplete'],
    })
    return {
      axeVersion: r.testEngine.version,
      violations: r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        tags: v.tags.filter((t) => /^(wcag|best)/.test(t)),
        help: v.help,
        nodes: v.nodes.length,
        sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
      })),
      incomplete: r.incomplete.map((v) => ({
        id: v.id,
        nodes: v.nodes.length,
      })),
    }
  })
  const totalNodes = result.violations.reduce((s, v) => s + v.nodes, 0)
  screens.push({
    id,
    file: `${id}.png`,
    note,
    axeVersion: result.axeVersion,
    violationRules: result.violations.length,
    violationNodes: totalNodes,
    violations: result.violations,
    incomplete: result.incomplete,
  })
  console.log(`${id}: ${result.violations.length} rules / ${totalNodes} nodes`)
}

async function safe(label, fn) {
  try {
    await fn()
  } catch (error) {
    errors.push({ where: label, step: String(error).split('\n')[0] })
    console.log('step failed', label, String(error).split('\n')[0])
  }
}

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: 'dark',
})
const page = await context.newPage()
page.on('pageerror', (e) => errors.push({ where: current, error: String(e) }))
await page.goto(BASE + '/', { waitUntil: 'load' })
await page.waitForFunction(() => Boolean(window.__dinksterTest?.app), null, {
  timeout: 30000,
})
await page.waitForTimeout(3500)

await page.evaluate(() =>
  window.__dinksterTest.app.templateGalleryOpen.set(true),
)
await audit(page, '01-start-gallery', 'first load, starter template gallery')
await safe('close gallery', async () => {
  const close = page.locator('.template-gallery-close')
  if ((await close.count()) > 0 && (await close.first().isVisible()))
    await close.first().click()
  else
    await page.evaluate(() =>
      window.__dinksterTest.app.templateGalleryOpen.set(false),
    )
  await page.waitForTimeout(500)
})
await audit(page, '02-blank-canvas', 'shell with an empty Untitled workflow')

await safe('demo workflow', async () => {
  await page.evaluate(
    (doc) => window.__dinksterTest.app.openDocument(doc, 'Audit demo'),
    demoWorkflow,
  )
  await page.waitForTimeout(1200)
})
await audit(
  page,
  '03-canvas-demo-workflow',
  'two-node native workflow on the canvas',
)

async function openDock(toggleTestId) {
  const toggle = page.getByTestId(toggleTestId)
  if ((await toggle.getAttribute('aria-pressed')) !== 'true')
    await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(600)
}
for (const [toggle, id] of [
  ['library-toggle', 'library'],
  ['assets-toggle', 'assets'],
  ['backends-sidebar-toggle', 'backends'],
]) {
  await safe(`dock ${id}`, async () => {
    await openDock(toggle)
    await audit(page, `04-dock-${id}`, `${id} dock panel open`)
  })
}
await safe('bottom execution log', async () => {
  await openDock('execution-log-toggle')
  await audit(page, '05-bottom-execution-log', 'execution log bottom panel')
})

async function openRail(title) {
  const rail = page.getByTestId('dock-zone-right')
  if (!(await rail.isVisible())) await page.getByTestId('rail-toggle').click()
  const tab = rail.locator('[role="tab"]').filter({ hasText: title })
  if ((await tab.count()) > 0 && (await tab.first().isVisible()))
    await tab.first().click()
  else {
    const overflow = rail.getByTestId('dock-zone-overflow-button')
    if ((await overflow.count()) > 0) {
      await overflow.first().click()
      await rail
        .locator(
          '[data-testid="dock-zone-overflow-menu"] [role="menuitemradio"]',
        )
        .filter({ hasText: title })
        .first()
        .click()
    }
  }
  await expect(tab.first()).toHaveAttribute('aria-selected', 'true')
  await page.waitForTimeout(500)
}
async function nodePoint(nodeId, dx, dy) {
  await page.evaluate(() =>
    window.__dinksterTest.renderer?.setViewport({ x: 0, y: 0, scale: 1 }),
  )
  await page.waitForTimeout(200)
  return page.evaluate(
    ([node, ox, oy]) => {
      const renderer = window.__dinksterTest.renderer
      const n = renderer.getScene().nodes.find((c) => c.id === node)
      if (!n) return null
      const rect = document
        .querySelector('[data-testid=graph-canvas]')
        .getBoundingClientRect()
      return { x: rect.left + n.x + ox, y: rect.top + n.y + oy }
    },
    [nodeId, dx, dy],
  )
}
await safe('select node + focused rail', async () => {
  const p = await nodePoint('gen', 40, 12)
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(400)
  await openRail('Focused')
  await audit(
    page,
    '06-rail-focused-node-selected',
    'Focused rail with a node selected',
  )
})
await safe('problems rail', async () => {
  await openRail('Problems')
  await audit(page, '07-rail-problems', 'Problems rail')
})
await safe('boundary rail', async () => {
  await openRail('Boundary')
  await audit(page, '08-rail-boundary', 'Boundary rail (root graph)')
})

async function clickWidgetRow(nodeId, inputId) {
  await page.evaluate(() =>
    window.__dinksterTest.renderer?.setViewport({ x: 0, y: 0, scale: 1 }),
  )
  await page.waitForTimeout(200)
  const point = await page.evaluate(
    ([node, input]) => {
      const renderer = window.__dinksterTest.renderer
      const n = renderer.getScene().nodes.find((c) => c.id === node)
      if (!n) return null
      const row = n.layout.rows.find(
        (c) => c.kind === 'widget' && c.inputId === input,
      )
      if (!row) return null
      const rect = document
        .querySelector('[data-testid=graph-canvas]')
        .getBoundingClientRect()
      return {
        x: rect.left + n.x + n.layout.width / 2,
        y: rect.top + n.y + row.y + row.height / 2,
      }
    },
    [nodeId, inputId],
  )
  if (!point) throw new Error(`widget row ${nodeId}.${inputId} not found`)
  await page.mouse.click(point.x, point.y)
  await page.waitForTimeout(700)
}
await safe('combo editor', async () => {
  await clickWidgetRow('gen', 'operation')
  await audit(page, '09-widget-combo-editor', 'COMBO widget editor open')
  await page.keyboard.press('Escape')
})
await safe('scalar editor', async () => {
  await clickWidgetRow('gen', 'width')
  await audit(page, '10-widget-int-editor', 'INT widget editor open')
  await page.keyboard.press('Escape')
})

await safe('context menu', async () => {
  const p = await nodePoint('gen', 40, 12)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.waitForTimeout(500)
  await audit(page, '12-node-context-menu', 'node context menu')
  await page.keyboard.press('Escape')
})
await safe('node palette', async () => {
  const canvas = await page.getByTestId('graph-canvas').boundingBox()
  await page.mouse.dblclick(
    canvas.x + canvas.width / 2,
    canvas.y + canvas.height - 120,
  )
  await page.waitForTimeout(800)
  await audit(page, '13-node-palette', 'node palette opened by double-click')
  await page.keyboard.press('Escape')
})
await safe('universal search', async () => {
  await page.evaluate(() => window.__dinksterTest.app.searchOpen.set(true))
  await page.waitForTimeout(600)
  await page.keyboard.type('sett')
  await page.waitForTimeout(500)
  await audit(page, '14-universal-search', 'universal search with results')
  await page.keyboard.press('Escape')
})
for (const id of ['settings', 'projects', 'collab']) {
  await safe(`modal ${id}`, async () => {
    await page.evaluate(
      (panelId) => window.__dinksterTest.app.modalPanel.set(panelId),
      id,
    )
    await page.waitForTimeout(700)
    await audit(page, `15-modal-${id}`, `${id} dialog`)
    await page.evaluate(() => window.__dinksterTest.app.modalPanel.set(''))
    await page.waitForTimeout(300)
  })
}

await browser.close()
const byRule = {}
for (const screen of screens)
  for (const v of screen.violations) {
    byRule[v.id] ??= { impact: v.impact, help: v.help, screens: 0, nodes: 0 }
    byRule[v.id].screens += 1
    byRule[v.id].nodes += v.nodes
  }
const summary = {
  base: BASE,
  capturedAt: new Date().toISOString(),
  axeVersion: screens[0]?.axeVersion,
  screens: screens.length,
  totalViolationNodes: screens.reduce((s, x) => s + x.violationNodes, 0),
  distinctRules: Object.keys(byRule).length,
  byRule,
  perScreen: screens,
  errors,
  criticalNodes: screens.reduce(
    (total, screen) =>
      total +
      screen.violations
        .filter((v) => v.impact === 'critical')
        .reduce((sum, v) => sum + v.nodes, 0),
    0,
  ),
  seriousNodes: screens.reduce(
    (total, screen) =>
      total +
      screen.violations
        .filter((v) => v.impact === 'serious')
        .reduce((sum, v) => sum + v.nodes, 0),
    0,
  ),
}
fs.writeFileSync(RESULTS, JSON.stringify(summary, null, 2) + '\n')
console.log(
  JSON.stringify({
    screens: screens.length,
    criticalNodes: summary.criticalNodes,
    seriousNodes: summary.seriousNodes,
    totalViolationNodes: summary.totalViolationNodes,
    errors: errors.length,
  }),
)
const expected = [
  '01-start-gallery',
  '02-blank-canvas',
  '03-canvas-demo-workflow',
  '04-dock-library',
  '04-dock-assets',
  '04-dock-backends',
  '05-bottom-execution-log',
  '06-rail-focused-node-selected',
  '07-rail-problems',
  '08-rail-boundary',
  '09-widget-combo-editor',
  '10-widget-int-editor',
  '12-node-context-menu',
  '13-node-palette',
  '14-universal-search',
  '15-modal-settings',
  '15-modal-projects',
  '15-modal-collab',
]
if (
  errors.length > 0 ||
  expected.some((id) => !screens.some((screen) => screen.id === id)) ||
  summary.criticalNodes > 0 ||
  summary.seriousNodes > 0
)
  process.exitCode = 1
