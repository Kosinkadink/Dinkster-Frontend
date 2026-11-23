import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TestInfo } from '@playwright/test'
import { expect, test, waitForWorkspaceReady, type Locator, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_INTERACTION_ACCESSIBILITY_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

test.use({ hasTouch: true, deviceScaleFactor: 2 })

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<{ width: number; height: number }> {
  const path = proofDir ? join(proofDir, `${name}.png`) : testInfo.outputPath(`${name}.png`)
  const image = await page.screenshot({ path, animations: 'disabled', scale: 'device' })
  await testInfo.attach(name, { path, contentType: 'image/png' })
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) }
}

async function captureSurface(locator: Locator, testInfo: TestInfo, name: string): Promise<void> {
  const path = proofDir ? join(proofDir, `${name}.png`) : testInfo.outputPath(`${name}.png`)
  await locator.screenshot({ path, animations: 'disabled', scale: 'device' })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

async function expectContained(page: Page, locator: Locator): Promise<void> {
  const [box, viewport] = await Promise.all([
    locator.boundingBox(),
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
  ])
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
}

async function expectTouchTarget(locator: Locator): Promise<void> {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(24)
  expect(box!.height).toBeGreaterThanOrEqual(24)
}

async function touch(locator: Locator, page: Page): Promise<void> {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2)
}

async function installProofSurfaces(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const choices = Array.from({ length: 6 }, (_, index) => `Interaction option ${index + 1}`)
    ;(window.__dinksterTest!.app as any).settings.register({
      id: 'proof.interaction-density',
      name: 'Interaction density',
      description: 'Proves form and floating-control containment at browser zoom.',
      category: 'proof',
      type: 'combo',
      defaultValue: '1',
      options: choices.map((label, index) => ({ value: String(index + 1), label })),
    })
    window.__dinksterTest!.app.registerSchemas([{
      type: 'InteractionAccessibilityProof',
      displayName: 'Interaction accessibility proof',
      category: 'proof',
      source: 'v3',
      isOutputNode: false,
      items: [{
        kind: 'input',
        id: 'seed',
        type: { kind: 'concrete', name: 'INT' },
        optional: false,
        widget: {
          widgetType: 'INT',
          options: { min: 0, max: 9007199254740991, step: 1 },
          default: 42,
          controller: 'after_generate',
          controllerInitial: 'fixed',
        },
      }],
    }])
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'interaction-accessibility-proof',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0',
          name: 'root',
          nodes: {
            proof: {
              id: 'proof',
              type: 'InteractionAccessibilityProof',
              values: { seed: 42 },
              controllers: { seed: 'fixed' },
            },
          },
          links: {},
          nets: {},
          reroutes: {},
          nextOrdinal: 2,
        },
      },
      view: { graphs: { g0: { nodes: { proof: { position: { x: 48, y: 56 } } } } } },
    }, 'Interaction accessibility')
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab?.store.doc.lineage === 'interaction-accessibility-proof' &&
      'status' in tab.store && (tab.store.status as { get(): string }).get() === 'live'
  })
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

async function widgetPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'proof')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'seed')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: canvas.left + node.x + node.layout.width / 4,
      y: canvas.top + node.y + row.y + row.height / 2,
    }
  })
}

test.beforeEach(async ({ page }) => {
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await waitForWorkspaceReady(page)
})

test('touch reaches the in-row field and its after-run modes on a narrow viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 640 })
  await installProofSurfaces(page)
  const railToggle = page.getByRole('button', { name: 'Toggle right rail' })
  if (await railToggle.getAttribute('aria-pressed') === 'true') await touch(railToggle, page)

  const widget = await widgetPoint(page)
  await page.touchscreen.tap(widget.x, widget.y)
  const field = page.getByTestId('canvas-row-field')
  const input = page.getByTestId('widget-editor').locator('input')
  await expect(input).toBeVisible()
  const side = field.locator('.dinkster-canvas-field-side')
  await expectContained(page, side)
  const modes = page.getByRole('group', { name: 'After each run' }).getByRole('button')
  await expect(modes).toHaveCount(4)
  for (let index = 0; index < await modes.count(); index += 1) await expectTouchTarget(modes.nth(index))
  await captureSurface(side, testInfo, 'touch-widget-editor-390x640')
  await touch(page.getByRole('group', { name: 'After each run' }).getByRole('button', { name: 'randomize' }), page)
  await expect.poll(() => page.evaluate(() => {
    const node = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.proof! as unknown as {
      readonly controllers?: Readonly<Record<string, string>>
    }
    return node.controllers?.seed
  })).toBe('randomize')
  await input.press('Escape')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
})

test('an open field keeps its after-run modes reachable through a short canvas resize', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 400 })
  await installProofSurfaces(page)
  const railToggle = page.getByRole('button', { name: 'Toggle right rail' })
  if (await railToggle.getAttribute('aria-pressed') === 'true') await touch(railToggle, page)
  await page.getByTestId('minimap-toggle').click()

  const widget = await widgetPoint(page)
  await page.mouse.click(widget.x, widget.y)
  await expect(page.getByTestId('canvas-row-field').locator('.dinkster-canvas-field-side')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 360 })
  // Put the canvas at a fractional page position past the half pixel, as
  // other font metrics do; it is drawn from its rounded position.
  await page.evaluate(() => { document.body.style.marginTop = '0.3px' })
  // The side part stays whole on the visible canvas; the canvas does not move.
  await expect.poll(() => page.evaluate(() => {
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const side = document.querySelector('[data-testid=canvas-row-field] .dinkster-canvas-field-side')!.getBoundingClientRect()
    return side.left >= canvas.left && side.top >= canvas.top &&
      side.right <= canvas.right && side.bottom <= canvas.bottom
  })).toBe(true)

  const randomize = page.getByRole('group', { name: 'After each run' }).getByRole('button', { name: 'randomize' })
  await expect(randomize).toBeInViewport()
  expect(await capture(page, testInfo, 'touch-controller-menu-resized-390x360')).toEqual({ width: 780, height: 720 })
  await touch(randomize, page)
  await expect.poll(() => page.evaluate(() => {
    const node = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.proof! as unknown as {
      readonly controllers?: Readonly<Record<string, string>>
    }
    return node.controllers?.seed
  })).toBe('randomize')
})
