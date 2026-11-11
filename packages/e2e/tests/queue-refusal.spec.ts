import { readFileSync } from 'node:fs'
import { nativeTest as test, expect } from './fixtures.js'

const catalog = JSON.parse(readFileSync(new URL('../../core/fixtures/dinkster-nodes-comfy.json', import.meta.url), 'utf8'))
const workflow = JSON.parse(readFileSync(new URL('../../app/test/fixtures/unresolved-output-dependency.json', import.meta.url), 'utf8'))

for (const width of [1440, 900]) {
  test(`refused Queue explains problems and opens the panel at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 })
    await page.route('/api/nodes*', (route) => route.fulfill({ json: catalog }))
    await page.route('/api/diagnostics', (route) => route.fulfill({ json: { diagnostics: [] } }))
    await page.route('/api/composition', (route) => route.fulfill({ json: {} }))
    await page.routeWebSocket('**/api/events?*', () => {})
    await page.goto('/')
    await expect(page.getByTestId('status-bar')).toContainText('node schemas')
    await page.evaluate((doc) => {
      const app = window.__dinksterTest!.app
      ;(app as unknown as { templateGalleryOpen: { set(value: boolean): void } }).templateGalleryOpen.set(false)
      app.openDocument(doc, 'Blocked workflow')
      app.dock.setOpen('right', false)
    }, workflow)
    await expect(page.getByTestId('queue-refusal-toast')).toBeHidden()
    await page.getByTestId('queue-button').click()
    const toast = page.getByTestId('queue-refusal-toast')
    await expect(toast).toBeVisible()
    await expect(toast).toContainText('Workflow not queued')
    await expect(toast).toContainText('worst severity error')
    const box = (await toast.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
    await page.screenshot({ path: info.outputPath(`queue-refusal-${width}.png`) })
    await toast.getByRole('button', { name: 'Show Problems', exact: true }).click()
    await expect(page.getByTestId('problems-panel')).toBeVisible()
    await expect(page.getByTestId('problems-panel').locator('summary[title="comfy.Morphology: not available on backend Local"]')).toContainText('comfy.Morphology: not available on backend Local')
    await expect(toast).toBeHidden()
    await page.screenshot({ path: info.outputPath(`queue-problems-${width}.png`) })
  })
}
