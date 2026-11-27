import { expect, nativeTest as test, mockProjectPacks, setShellRegion } from './fixtures.js'

test('panel sizes use available window space without changing the opposite panel or stored preferences', async ({ page }, info) => {
  await page.route('**/api/**', (route) => route.fulfill({ status: 404 }))
  await page.route('**/api/mounts', (route) => route.fulfill({ json: { mounts: [] } }))
  await page.route('**/api/assets/catalog*', (route) => route.fulfill({ json: { assets: [] } }))
  await page.route('**/api/docs?*', (route) => route.fulfill({ json: { docs: [] } }))
  await mockProjectPacks(page)
  await page.route('**/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'shell-resize', schemaWire: 2 }, nodes: {},
  } }))
  await page.route('/supervisor/**', (route) => route.fulfill({ status: 404 }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled()
  await setShellRegion(page, 'left', true)
  await setShellRegion(page, 'right', true)
  const left = page.getByTestId('dock-panel')
  const right = page.getByTestId('dock-zone-right')
  const canvas = page.getByTestId('editor-split-region')
  const rightWidth = (await right.boundingBox())!.width
  const drag = async (id: string, dx: number, dy: number): Promise<void> => {
    const handle = (await page.getByTestId(id).boundingBox())!
    const x = handle.x + handle.width / 2
    const y = handle.y + handle.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx, y + dy, { steps: 5 })
    await page.mouse.up()
  }
  await drag('dock-resize', 2000, 0)
  await page.screenshot({ path: info.outputPath('left-maximum.png') })
  const leftWidth = (await left.boundingBox())!.width
  expect(leftWidth).toBeGreaterThan(1200)
  expect((await right.boundingBox())!.width).toBe(rightWidth)
  expect((await canvas.boundingBox())!.width).toBeGreaterThanOrEqual(200)
  expect((await canvas.boundingBox())!.width).toBeLessThan(202)
  await page.reload()
  await expect(left).toBeVisible()
  await expect.poll(async () => (await left.boundingBox())!.width).toBe(leftWidth)
  await page.setViewportSize({ width: 900, height: 720 })
  await expect.poll(async () => (await left.boundingBox())!.width).toBeLessThan(700)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await expect.poll(async () => (await left.boundingBox())!.width).toBe(leftWidth)

  // Leave the left open at its minimum while growing the right.
  await page.getByTestId('dock-resize').press('Home')
  const minimumLeft = (await left.boundingBox())!.width
  await setShellRegion(page, 'right', true)
  await drag('rail-resize', -2000, 0)
  expect((await right.boundingBox())!.width).toBeGreaterThan(1200)
  expect((await left.boundingBox())!.width).toBe(minimumLeft)
  expect((await canvas.boundingBox())!.width).toBeGreaterThanOrEqual(200)
  await page.screenshot({ path: info.outputPath('right-maximum.png') })

  await setShellRegion(page, 'left', false)
  await setShellRegion(page, 'right', false)
  await setShellRegion(page, 'bottom', true)
  await drag('bottom-resize', 0, -1080)
  const bottom = page.getByTestId('bottom-panel')
  const bottomHeight = (await bottom.boundingBox())!.height
  expect(bottomHeight).toBeGreaterThan(800)
  const canvasStage = page.locator('.canvas-stage').first()
  expect((await canvasStage.boundingBox())!.height).toBeGreaterThanOrEqual(160)
  expect((await canvasStage.boundingBox())!.height).toBeLessThan(162)
  const minimap = page.getByTestId('minimap')
  const mapSwitch = page.getByTestId('minimap-toggle')
  const toolbar = page.locator('.canvas-stage-toolbar').first()
  const zoomBar = page.locator('.canvas-corner-bar').first()
  await expect(minimap).toBeHidden()
  await expect(mapSwitch).toHaveAttribute('aria-pressed', 'true')
  const checkChrome = async (): Promise<void> => {
    const stageBox = (await canvasStage.boundingBox())!
    const toolbarBox = (await toolbar.boundingBox())!
    const zoomBox = (await zoomBar.boundingBox())!
    const tabBox = (await page.locator('.editor-group > .tab-strip').first().boundingBox())!
    expect(tabBox.y + tabBox.height).toBeLessThanOrEqual(stageBox.y)
    expect(toolbarBox.y).toBeGreaterThan(stageBox.y)
    expect(toolbarBox.y + toolbarBox.height + 6).toBeLessThanOrEqual(zoomBox.y)
    expect(zoomBox.y + zoomBox.height).toBeLessThan(stageBox.y + stageBox.height)
  }
  await checkChrome()
  await page.screenshot({ path: info.outputPath('bottom-maximum.png') })
  await setShellRegion(page, 'left', true)
  await setShellRegion(page, 'right', true)
  await page.getByTestId('rail-resize').press('Home')
  await page.getByTestId('dock-resize').press('End')
  await expect(minimap).toBeHidden()
  await checkChrome()
  await page.screenshot({ path: info.outputPath('bottom-maximum-both-sides.png') })
  await setShellRegion(page, 'left', false)
  await setShellRegion(page, 'right', false)
  await page.getByTestId('bottom-resize').press('Home')
  await expect(minimap).toBeVisible()
  await expect(mapSwitch).toHaveAttribute('aria-pressed', 'true')
  await drag('bottom-resize', 0, -1080)
  await page.reload()
  await expect.poll(async () => (await bottom.boundingBox())?.height).toBe(bottomHeight)
  await expect(minimap).toBeHidden()
  await expect(mapSwitch).toHaveAttribute('aria-pressed', 'true')
  await page.setViewportSize({ width: 1920, height: 640 })
  await expect.poll(async () => (await bottom.boundingBox())!.height).toBeLessThan(500)
  expect((await canvasStage.boundingBox())!.height).toBeGreaterThanOrEqual(160)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await expect.poll(async () => (await bottom.boundingBox())!.height).toBe(bottomHeight)

  // External setting edits keep oversized preferences, just like pointer resizing.
  await setShellRegion(page, 'left', true)
  await page.evaluate(() => {
    const settings = window.__dinksterTest!.app.settings
    settings.set('shell.layout.left.width', 1600)
    settings.set('shell.layout.bottom.height', 900)
  })
  await expect.poll(async () => (await left.boundingBox())!.width).toBe(1600)
  await expect.poll(async () => (await bottom.boundingBox())!.height).toBe(bottomHeight)
  await page.getByTestId('dock-resize').press('End')
  expect((await canvas.boundingBox())!.width).toBeGreaterThanOrEqual(200)
  await page.setViewportSize({ width: 2560, height: 1440 })
  await expect.poll(async () => (await bottom.boundingBox())!.height).toBe(900)
  await expect(minimap).toBeVisible()
  await expect(mapSwitch).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect.poll(async () => (await bottom.boundingBox())!.height).toBe(900)
  await expect(minimap).toBeVisible()
  await mapSwitch.click()
  await page.setViewportSize({ width: 1920, height: 640 })
  await expect(minimap).toBeHidden()
  await page.setViewportSize({ width: 2560, height: 1440 })
  await expect(mapSwitch).toHaveAttribute('aria-pressed', 'false')
  await expect(minimap).toBeHidden()
  await mapSwitch.click()
  await expect(minimap).toBeVisible()
})
