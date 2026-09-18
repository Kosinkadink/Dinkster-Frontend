import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const proofDir = process.env['DINKSTER_FLOATING_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

const viewports = [
  { name: '1600x950', width: 1600, height: 950 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '360x640', width: 360, height: 640 },
] as const

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = proofDir ? join(proofDir, `${name}.png`) : testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, animations: 'disabled' })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

async function moveProofNodeToEdge(page: Page): Promise<void> {
  await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'floating-proof')!
    const canvas = document.querySelector<HTMLElement>('[data-testid="graph-canvas"]')!
    renderer.setViewport({
      x: Math.max(0, canvas.clientWidth - node.x - node.layout.width - 12),
      y: Math.max(0, canvas.clientHeight / 2 - node.y - node.layout.height / 2),
      scale: 1,
    })
  })
}

async function nodePoint(page: Page, kind: 'header' | 'widget'): Promise<{ x: number; y: number }> {
  return page.evaluate((kind) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'floating-proof')!
    const canvas = document.querySelector<HTMLElement>('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    const localY = kind === 'header'
      ? node.layout.headerHeight / 2
      : node.layout.rows.find((row) => row.kind === 'widget' && row.inputId === 'choice')!.y + 12
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + localY) * viewport.scale + viewport.y,
    }
  }, kind)
}

async function expectContained(page: Page, locator: ReturnType<Page['locator']>, canvasBounded: boolean): Promise<void> {
  const [surface, stage] = await Promise.all([
    locator.boundingBox(),
    page.locator('.canvas-stage').boundingBox(),
  ])
  expect(surface).not.toBeNull()
  expect(surface!.x).toBeGreaterThanOrEqual(0)
  expect(surface!.y).toBeGreaterThanOrEqual(0)
  expect(surface!.x + surface!.width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth))
  expect(surface!.y + surface!.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight))
  if (canvasBounded && stage !== null && stage.width > 8 && stage.height > 8) {
    expect(surface!.x).toBeGreaterThanOrEqual(stage.x)
    expect(surface!.y).toBeGreaterThanOrEqual(stage.y)
    expect(surface!.x + surface!.width).toBeLessThanOrEqual(stage.x + stage.width)
    expect(surface!.y + surface!.height).toBeLessThanOrEqual(stage.y + stage.height)
  }
}

test.beforeEach(async ({ page }) => {
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(() => {
    const longOptions = Array.from({ length: 14 }, (_, index) =>
      `Option ${index + 1} with a deliberately long label that must remain inside its floating surface`)
    window.__dinksterTest!.app.registerSchemas([{
      type: 'FloatingSurfaceProof',
      displayName: 'Floating Surface Proof',
      category: 'proof',
      source: 'v3',
      isOutputNode: false,
      items: [{
        kind: 'input',
        id: 'choice',
        type: { kind: 'concrete', name: 'core.combo' },
        optional: false,
        widget: { widgetType: 'COMBO', options: { options: longOptions }, default: longOptions[0] },
      }],
    }])
    ;(window.__dinksterTest!.app as any).settings.register({
      id: 'proof.floating-surface',
      name: 'Floating surface choice',
      description: 'Long options prove overflow, keyboard selection, and narrow containment.',
      category: 'proof',
      type: 'combo',
      defaultValue: 'one',
      options: longOptions.map((label, index) => ({ value: String(index + 1), label })),
    })
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'floating-surface-proof',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0',
          name: 'root',
          nodes: { 'floating-proof': { id: 'floating-proof', type: 'FloatingSurfaceProof', values: {} } },
          links: {},
          nets: {},
          reroutes: {},
          nextOrdinal: 2,
        },
      },
      view: { graphs: { g0: { nodes: { 'floating-proof': { position: { x: 100, y: 100 } } } } } },
    }, 'Floating surfaces')
  })
  // openDocument returns a local tab that the workspace authority promotes
  // asynchronously; the promotion replaces the tab and rebuilds the canvas
  // scene, which closes any open widget editor. Wait for the shared-session
  // store before interacting so a click cannot race the tab swap.
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === 'floating-surface-proof')
    return tab !== undefined && 'status' in tab.store
  })
  await page.getByRole('button', { name: 'Hide minimap' }).click()
})

test('menus, selects, and widget popovers share contained semantic chrome', async ({ page }, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    if (viewport.width === 360) {
      const railToggle = page.getByRole('button', { name: 'Toggle right rail' })
      if (await railToggle.getAttribute('aria-pressed') === 'true') await railToggle.click()
    }
    await moveProofNodeToEdge(page)

    const widgetPoint = await nodePoint(page, 'widget')
    await page.mouse.click(widgetPoint.x, widgetPoint.y)
    const widget = page.getByTestId('combo-dropdown')
    await expect(widget).toBeVisible()
    const search = page.getByTestId('combo-search')
    for (let index = 0; index < 13; index += 1) await search.press('ArrowDown')
    await expectContained(page, widget, true)
    await expect(widget).toHaveClass(/floating-surface/)
    await capture(page, testInfo, `${viewport.name}-widget-popover`)
    await search.press('Escape')
    await expect(page.getByTestId('graph-canvas')).toBeFocused()

    await page.getByTestId('settings-button').click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.locator('.settings-categories').getByRole('button', { name: 'Proof' }).click()
    const select = settings.locator('[data-setting-id="proof.floating-surface"] [role="combobox"]')
    await select.click()
    await select.press('End')
    const listbox = page.getByRole('listbox', { name: 'Floating surface choice' })
    await expectContained(page, listbox, false)
    await expect(listbox).toHaveClass(/floating-surface/)
    const activeId = await select.getAttribute('aria-activedescendant')
    await expect(page.locator(`#${activeId}`)).toBeInViewport()
    await capture(page, testInfo, `${viewport.name}-product-select`)
    await select.press('Escape')
    await expect(select).toBeFocused()
    await expect(settings).toBeVisible()
    await settings.getByRole('button', { name: 'Close settings' }).click()

    await moveProofNodeToEdge(page)
    const header = await nodePoint(page, 'header')
    await page.mouse.click(header.x, header.y, { button: 'right' })
    const rootMenu = page.getByTestId('context-menu')
    await expect(rootMenu).toBeVisible()
    await page.mouse.move(0, 0)
    await page.locator('[data-item-id="core.node.mode"]').dispatchEvent('mouseenter')
    const submenu = page.getByTestId('context-submenu')
    await expect(submenu).toBeVisible()
    await expectContained(page, rootMenu, false)
    await expectContained(page, submenu, false)
    await expect(rootMenu).toHaveClass(/floating-surface/)
    await expect(submenu).toHaveClass(/floating-surface/)
    await capture(page, testInfo, `${viewport.name}-context-menu`)
    const cascade = page.locator('.context-menu-cascade')
    await cascade.focus()
    await expect(cascade).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('[data-item-id="core.node.mode.muted"]')).toHaveClass(/active/)
    await page.keyboard.press('Escape')
    await expect(rootMenu).not.toBeVisible()
  }
})
