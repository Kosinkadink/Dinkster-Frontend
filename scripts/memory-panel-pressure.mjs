import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect } from '../packages/e2e/node_modules/@playwright/test/index.mjs'

const url = process.argv[2] ?? 'http://127.0.0.1:5395'
const output = process.argv[3]
if (!output) throw new Error('Usage: node scripts/memory-panel-pressure.mjs <frontend-url> <evidence-directory>')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 2600 } })
  await page.goto(url)
  await page.getByTestId('memory-sidebar-toggle').click()
  const panel = page.getByTestId('memory-panel').first()
  await expect(panel.locator('.memory-telemetry-state')).toHaveText('Live')
  await expect(panel).toContainText('Torch allocated10 GiB')
  await page.getByTestId('memory-sidebar-toggle').evaluate((element) => element.blur())
  await page.waitForTimeout(8000)
  await page.mouse.move(1000, 250)
  await page.waitForTimeout(300)
  await panel.locator('.memory-device').screenshot({ path: join(output, 'pressure-loaded.png') })
  await panel.getByText('History data').click()
  await panel.locator('.memory-graph').screenshot({ path: join(output, 'pressure-history-open.png') })
  const loaded = await (await page.request.get(`${url}/memory/status?details=1`)).json()
  await panel.getByRole('button', { name: 'Reset peak', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(panel).toContainText('Peak reset to current device usage.')
  await panel.getByRole('button', { name: 'Unload Pressure buffer B', exact: true }).click()
  await expect(panel).toContainText('Freed 4.0 GiB')
  await expect(panel).toContainText('Torch allocated6.0 GiB')
  await page.waitForTimeout(1100)
  const afterModel = await (await page.request.get(`${url}/memory/status?details=1`)).json()
  await panel.locator('.memory-device').screenshot({ path: join(output, 'pressure-after-model-unload.png') })
  await panel.getByRole('button', { name: 'Unload all', exact: true }).click()
  await expect(panel).toContainText('Freed 6.0 GiB')
  await expect(panel).toContainText('Torch allocated0 B')
  await page.waitForTimeout(1100)
  const afterAll = await (await page.request.get(`${url}/memory/status?details=1`)).json()
  expect(loaded.memoryGovernor['vram:cuda:0'].consumerFootprintBytes).toBe(10 * 2 ** 30)
  expect(afterModel.memoryGovernor['vram:cuda:0'].consumerFootprintBytes).toBe(6 * 2 ** 30)
  expect(afterAll.memoryGovernor['vram:cuda:0'].consumerFootprintBytes).toBe(0)
  await panel.locator('.memory-device').screenshot({ path: join(output, 'pressure-after-all-unload.png') })
  await writeFile(join(output, 'browser-receipt.json'), JSON.stringify({ url, timestamp: new Date().toISOString(), loaded, afterModel, afterAll }, null, 2) + '\n')
} finally {
  await browser.close()
}
