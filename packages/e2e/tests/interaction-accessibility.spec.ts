import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TestInfo } from '@playwright/test'
import { expect, test, type Locator, type Page } from './fixtures.js'

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
  await page.evaluate(() => {
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
        type: { kind: 'concrete', name: 'core.int' },
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
    window.__dinksterTest!.app.openDocument({
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

async function controllerPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'proof')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'seed')! as any
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const inset = row.inset ?? 0
    const rowWidth = node.layout.width - inset * 2
    const size = row.height - 8
    const chipX = Math.max(12, rowWidth - 18 - size)
    return {
      x: canvas.left + node.x + inset + chipX + size / 2,
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
})

test('forms and floating controls remain contained at a 200 percent browser zoom equivalent', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 720, height: 450 })
  await installProofSurfaces(page)
  expect(await page.evaluate(() => ({
    devicePixelRatio: window.devicePixelRatio,
    width: window.innerWidth,
    height: window.innerHeight,
  }))).toEqual({ devicePixelRatio: 2, width: 720, height: 450 })

  await page.getByTestId('settings-button').click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.locator('.settings-categories').getByRole('button', { name: 'Proof' }).click()
  const select = settings.locator('[data-setting-id="proof.interaction-density"] [role="combobox"]')
  await select.click()
  const listbox = page.getByRole('listbox', { name: 'Interaction density' })
  await expect(listbox).toBeVisible()
  await expectContained(page, settings)
  await expectContained(page, listbox)
  await expectTouchTarget(select)
  await expectTouchTarget(page.getByRole('option').last())
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(720)
  expect(await capture(page, testInfo, '200-percent-browser-zoom-form-and-select')).toEqual({ width: 1440, height: 900 })
})

test('touch reaches widget actions and semantic menu targets on a narrow viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 640 })
  await installProofSurfaces(page)
  const railToggle = page.getByRole('button', { name: 'Toggle right rail' })
  if (await railToggle.getAttribute('aria-pressed') === 'true') await touch(railToggle, page)

  const widget = await widgetPoint(page)
  await page.touchscreen.tap(widget.x, widget.y)
  const editor = page.getByTestId('widget-editor')
  await expect(editor).toBeVisible()
  const input = editor.getByRole('textbox', { name: 'Value' })
  const cancel = page.getByTestId('widget-editor-cancel')
  await expectTouchTarget(input)
  await expectTouchTarget(cancel)
  await expectContained(page, editor)
  await captureSurface(editor, testInfo, 'touch-widget-editor-390x640')
  await touch(cancel, page)
  await expect(editor).not.toBeVisible()

  const controller = await controllerPoint(page)
  await page.mouse.click(controller.x, controller.y)
  const menu = page.getByTestId('seed-controller-menu')
  await expect(menu).toBeVisible()
  await expectContained(page, menu)
  const options = menu.getByRole('menuitemradio')
  for (let index = 0; index < await options.count(); index += 1) await expectTouchTarget(options.nth(index))
  await captureSurface(menu, testInfo, 'touch-controller-menu-390x640')
  await touch(page.getByTestId('seed-controller-randomize'), page)
  await expect(menu).not.toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const node = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.proof! as unknown as {
      readonly controllers?: Readonly<Record<string, string>>
    }
    return node.controllers?.seed
  })).toBe('randomize')
})

test('seed controller menu follows a short canvas resize and keeps its tail reachable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 400 })
  await installProofSurfaces(page)
  const railToggle = page.getByRole('button', { name: 'Toggle right rail' })
  if (await railToggle.getAttribute('aria-pressed') === 'true') await touch(railToggle, page)
  await page.getByTestId('minimap-toggle').click()

  const controller = await controllerPoint(page)
  await page.mouse.click(controller.x, controller.y)
  const menu = page.getByTestId('seed-controller-menu')
  await expect(menu).toBeVisible()
  await page.setViewportSize({ width: 390, height: 360 })
  await expect.poll(() => page.evaluate(() => {
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const surface = document.querySelector('[data-testid=seed-controller-menu]')!.getBoundingClientRect()
    return surface.left >= canvas.left && surface.top >= canvas.top &&
      surface.right <= canvas.right && surface.bottom <= canvas.bottom &&
      surface.left >= 0 && surface.top >= 0 &&
      surface.right <= window.innerWidth && surface.bottom <= window.innerHeight
  })).toBe(true)
  expect(await menu.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      bounded: style.maxHeight !== 'none' && element.scrollHeight > element.clientHeight,
      overflowY: style.overflowY,
    }
  })).toEqual({ bounded: true, overflowY: 'auto' })

  const randomize = page.getByTestId('seed-controller-randomize')
  await randomize.scrollIntoViewIfNeeded()
  await expect(randomize).toBeInViewport()
  expect(await capture(page, testInfo, 'touch-controller-menu-resized-390x360')).toEqual({ width: 780, height: 720 })
  await touch(randomize, page)
  await expect(menu).not.toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const node = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.proof! as unknown as {
      readonly controllers?: Readonly<Record<string, string>>
    }
    return node.controllers?.seed
  })).toBe('randomize')
})

test('reduced-motion preference removes loading and switch motion', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.reload()
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  await page.evaluate(() => {
    const registry = (window.__dinksterTest!.app as any).searchRegistry
    registry.register({
      id: 'proof.reduced-motion',
      label: 'Reduced motion proof',
      prefix: '?',
      priority: 1000,
      query: () => new Promise(() => {}),
    })
  })
  await page.getByTestId('topbar-search').click()
  await page.getByTestId('universal-search-input').fill('? pending')
  const loading = page.locator('[data-provider="proof.reduced-motion"] .search-state-loading')
  await expect(loading).toBeVisible()
  expect(await loading.locator('.search-state-icon').evaluate((element) => getComputedStyle(element).animationDuration)).toBe('0s')
  await captureSurface(page.locator('.search-dialog'), testInfo, 'reduced-motion-search-loading')
  await page.evaluate(() => (window.__dinksterTest!.app as unknown as {
    readonly searchOpen: { set(value: boolean): void }
  }).searchOpen.set(false))
  await expect(page.getByTestId('universal-search-input')).toHaveCount(0)

  await page.getByTestId('minimap-settings').click()
  const toggle = page.getByTestId('minimap-toggle-nodes')
  await expect(toggle).toBeVisible()
  const durations = await toggle.locator('.minimap-switch > span').evaluate((element) =>
    getComputedStyle(element).transitionDuration.split(', ').map((value) => value.trim()))
  expect(durations.every((duration) => duration === '0s')).toBe(true)
  await toggle.click()
  await captureSurface(page.locator('.minimap-menu'), testInfo, 'reduced-motion-switch')
})
