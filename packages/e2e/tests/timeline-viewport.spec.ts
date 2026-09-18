import { expect, test } from '@playwright/test'

test('timeline viewport seeks, zooms and refuses an unavailable owner without media requests', async ({ page }, testInfo) => {
  const errors: string[] = []
  const apiRequests: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url()) })
  await page.route('**/timeline-viewport-fixture', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="fixture"></div><script type="module">
    import { mountTimelineFixture } from '/test/fixtures/timeline-viewport.tsx';
    mountTimelineFixture(document.getElementById('fixture'));
  </script></body></html>` }))
  await page.goto('/timeline-viewport-fixture')
  const viewport = page.getByRole('region', { name: 'Timeline viewport', exact: true })
  const ruler = page.getByRole('slider', { name: 'Timeline playhead' })
  await expect(ruler).toHaveAttribute('aria-valuenow', '2')
  const seconds = page.getByRole('spinbutton', { name: 'Playhead seconds' })
  await seconds.fill('')
  await seconds.press('Tab')
  await expect(seconds).toHaveValue('2')
  for (const [key, entered, expected] of [['Home', '-1', '0'], ['End', '13', '12']] as const) {
    await ruler.focus()
    await page.keyboard.press(key)
    await seconds.fill(entered)
    await seconds.press('Tab')
    await expect(seconds).toHaveValue(expected)
    await expect(ruler).toHaveAttribute('aria-valuenow', expected)
    expect(await seconds.evaluate((element) => (element as HTMLInputElement).validity.valid)).toBe(true)
  }
  await ruler.focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => Number(await ruler.getAttribute('aria-valuenow'))).toBe(1001 / 30000)
  await page.getByRole('spinbutton', { name: 'Playhead seconds' }).fill('4.2')
  await page.getByRole('spinbutton', { name: 'Playhead seconds' }).press('Tab')
  await expect.poll(async () => Number(await ruler.getAttribute('aria-valuenow'))).toBeCloseTo(4.2042)
  await page.getByRole('button', { name: 'Second interval', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Second interval', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await viewport.screenshot({ path: testInfo.outputPath('timeline-lanes.png') })
  const initialWidth = await page.locator('.timeline-lane-content').first().evaluate((element) => element.clientWidth)
  await page.getByRole('button', { name: 'Zoom in timeline' }).click()
  await expect.poll(() => page.locator('.timeline-lane-content').first().evaluate((element) => element.clientWidth)).toBe(initialWidth * 2)
  await page.locator('.timeline-scroll').evaluate((element) => { element.scrollLeft = 250 })
  await ruler.click({ position: { x: 500, y: 20 } })
  const frame = 1001 / 30000
  await expect.poll(async () => Number(await ruler.getAttribute('aria-valuenow')))
    .toBe(Math.round((500 / (initialWidth * 2) * 12) / frame) * frame)
  const scrollBounds = await page.locator('.timeline-scroll').boundingBox()
  const labelBounds = await page.getByRole('region', { name: 'Video lane', exact: true }).locator('.timeline-lane-label').boundingBox()
  expect(labelBounds!.x).toBeCloseTo(scrollBounds!.x)
  await expect.poll(() => page.locator('.timeline-tick').evaluateAll((elements) => {
    const left = document.querySelector('.timeline-lane-label')!.getBoundingClientRect().right
    const right = document.querySelector('.timeline-scroll')!.getBoundingClientRect().right
    return elements.every((element) => {
      const bounds = element.getBoundingClientRect()
      return bounds.left >= left && bounds.right <= right
    })
  })).toBe(true)
  expect(await page.getByRole('spinbutton', { name: 'Playhead seconds' }).evaluate((element) => (element as HTMLInputElement).validity.valid)).toBe(true)
  await viewport.screenshot({ path: testInfo.outputPath('timeline-zoomed.png') })
  await page.getByRole('button', { name: 'Fit timeline' }).click()
  expect(await page.locator('.timeline-scroll').evaluate((element) => element.scrollLeft)).toBe(0)
  await page.setViewportSize({ width: 440, height: 850 })
  await expect.poll(() => viewport.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await viewport.screenshot({ path: testInfo.outputPath('timeline-narrow.png') })
  await page.getByRole('button', { name: 'Toggle unavailable owner' }).click()
  await expect(viewport).toContainText('Execution owner unavailable')
  await expect(ruler).toHaveCount(0)
  await expect(page.getByRole('spinbutton', { name: 'Playhead seconds' })).toBeDisabled()
  await viewport.screenshot({ path: testInfo.outputPath('timeline-unavailable.png') })
  expect(apiRequests).toEqual([])
  expect(errors).toEqual([])
})
