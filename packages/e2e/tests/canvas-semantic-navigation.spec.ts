import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TestInfo } from '@playwright/test'
import { expect, test, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_CANVAS_SEMANTIC_PROOF_DIR']
if (proofDir !== undefined) mkdirSync(proofDir, { recursive: true })

const capture = async (page: Page, testInfo: TestInfo, name: string): Promise<void> => {
  if (proofDir === undefined) return
  await page.locator('.canvas-stage').screenshot({
    path: join(proofDir, `${testInfo.project.name}-${name}.png`),
    animations: 'disabled',
  })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
})

test('semantic scene navigation stays virtual until focused and pans only on activation', async ({ page }, testInfo) => {
  const diagnostics = await page.evaluate(() => window.__dinksterTest!.app.openDocument(
    window.__dinksterTest!.syntheticWorkflow({ chains: 4, chainLength: 10, reroutes: true }),
    'Semantic navigation proof',
  ))
  expect(diagnostics).toEqual([])
  await expect(page.getByTestId('tab-bar').locator('.tab', { hasText: 'Semantic navigation proof' })).toBeVisible()

  const navigator = page.getByRole('listbox', { name: 'Canvas scene navigator' })
  await expect(navigator.getByRole('option')).toHaveCount(0)
  const unfocusedDerivations = await page.evaluate(() => window.__dinksterTest!.semanticDerivations)
  await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const initial = renderer.getViewport()
    for (let index = 0; index < 6; index += 1) {
      ;(renderer as unknown as { renderNow(): void }).renderNow()
      const viewport = renderer.getViewport()
      renderer.setViewport({ x: viewport.x + 3, y: viewport.y - 2, scale: viewport.scale * (index % 2 === 0 ? 1.01 : 1 / 1.01) })
    }
    renderer.setViewport(initial)
  })
  expect(await page.evaluate(() => window.__dinksterTest!.semanticDerivations)).toBe(unfocusedDerivations)
  const before = await page.evaluate(() => ({
    viewport: window.__dinksterTest!.renderer!.getViewport(),
    revision: window.__dinksterTest!.app.activeTab()!.store.revision,
    document: JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc),
  }))

  await navigator.focus()
  await expect(navigator.getByRole('option')).toHaveCount(5)
  const total = Number(await navigator.getByRole('option').first().getAttribute('aria-setsize'))
  expect(total).toBeGreaterThan(40)
  await expect(navigator.getByRole('option').first()).toHaveAttribute('aria-posinset', '1')
  const focusedDerivations = await page.evaluate(() => window.__dinksterTest!.semanticDerivations)
  expect(focusedDerivations).toBeGreaterThan(unfocusedDerivations)
  await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const initial = renderer.getViewport()
    for (let index = 0; index < 6; index += 1) {
      ;(renderer as unknown as { renderNow(): void }).renderNow()
      const viewport = renderer.getViewport()
      renderer.setViewport({ x: viewport.x - 2, y: viewport.y + 4, scale: viewport.scale * (index % 2 === 0 ? 1.01 : 1 / 1.01) })
    }
    renderer.setViewport(initial)
  })
  expect(await page.evaluate(() => window.__dinksterTest!.semanticDerivations)).toBe(focusedDerivations)

  await page.keyboard.press('End')
  await expect(navigator.getByRole('option')).toHaveCount(5)
  await expect(navigator.locator('[data-active="true"]')).toHaveAttribute('aria-posinset', String(total))
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())).toEqual(before.viewport)
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '0')
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-link-selection', '0')
  await capture(page, testInfo, 'wide-last-item')

  await page.setViewportSize({ width: 1366, height: 768 })
  await expect(navigator).toBeFocused()
  await expect(navigator.getByRole('option')).toHaveCount(5)
  await capture(page, testInfo, 'medium-last-item')

  await page.keyboard.press('Home')
  await expect(navigator.locator('[data-active="true"]')).toHaveAttribute('data-kind', 'node')
  await page.keyboard.press('Enter')
  await expect(navigator.locator('[data-active="true"]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())).not.toEqual(before.viewport)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(before.revision)
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(before.document)

  await page.setViewportSize({ width: 390, height: 844 })
  const railToggle = page.getByRole('button', { name: 'Toggle right rail' })
  if (await railToggle.getAttribute('aria-pressed') === 'true') await railToggle.click()
  await navigator.focus()
  await expect(navigator).toBeFocused()
  await expect(navigator.getByRole('option')).toHaveCount(5)
  await capture(page, testInfo, 'narrow-selected-node')

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('graph-canvas')).toBeFocused()
  await expect(navigator.getByRole('option')).toHaveCount(0)
})
