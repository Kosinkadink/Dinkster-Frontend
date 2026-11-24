import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TestInfo } from '@playwright/test'
import { expect, setShellRegion, test, waitForWorkspaceReady, type Page } from './fixtures.js'

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
  await page.route('/api/workflows/plan', (route) => route.fulfill({ json: { packs: [], assets: [], errors: [] } }))
  await page.goto('/')
  await waitForWorkspaceReady(page)
})

test('semantic scene navigation stays virtual until focused and pans only on activation', async ({ page }, testInfo) => {
  const diagnostics = await page.evaluate(async () => (await window.__dinksterTest!.app.openDocument(
    window.__dinksterTest!.syntheticWorkflow({ chains: 4, chainLength: 10, reroutes: true }),
    'Semantic navigation proof',
  )))
  expect(diagnostics).toEqual([])
  await expect(page.getByTestId('tab-bar').locator('.tab', { hasText: 'Semantic navigation proof' })).toBeVisible()
  await page.waitForFunction(() => 'status' in window.__dinksterTest!.app.activeTab()!.store)

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
  // Async diagnostics may refresh semantics; measure camera work in one browser task.
  const focusedDerivations = await page.evaluate(() => {
    const before = window.__dinksterTest!.semanticDerivations
    const renderer = window.__dinksterTest!.renderer!
    const initial = renderer.getViewport()
    for (let index = 0; index < 6; index += 1) {
      ;(renderer as unknown as { renderNow(): void }).renderNow()
      const viewport = renderer.getViewport()
      renderer.setViewport({ x: viewport.x - 2, y: viewport.y + 4, scale: viewport.scale * (index % 2 === 0 ? 1.01 : 1 / 1.01) })
    }
    renderer.setViewport(initial)
    return { before, after: window.__dinksterTest!.semanticDerivations }
  })
  expect(focusedDerivations.before).toBeGreaterThan(unfocusedDerivations)
  expect(focusedDerivations.after).toBe(focusedDerivations.before)

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

  // Rows join the list, each with its value; Enter selects and centers the
  // row's node and changes nothing.
  const active = navigator.locator('[data-active="true"]')
  for (let step = 0; step < 12 && await active.getAttribute('data-kind') !== 'widget'; step += 1) {
    await page.keyboard.press('ArrowDown')
  }
  await expect(active).toHaveAttribute('data-kind', 'widget')
  await expect(active).toHaveText(/^Row: width of .+, 64$/)
  await page.keyboard.press('Enter')
  await expect(active).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(before.document)

  // The list stays while a row is open in place. Once the camera has stopped
  // on the node Enter centered, show that node at 100 percent so its rows
  // take clicks, and open its width row.
  const viewportNow = () => page.evaluate(() => JSON.stringify(window.__dinksterTest!.renderer!.getViewport()))
  let settled = ''
  await expect.poll(async () => {
    const previous = settled
    settled = await viewportNow()
    return settled === previous
  }).toBe(true)
  const widthRow = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    const centerX = (canvas.width / 2 - viewport.x) / viewport.scale
    const centerY = (canvas.height / 2 - viewport.y) / viewport.scale
    const node = renderer.getScene().nodes
      .filter((candidate) => candidate.layout.rows.some((row) => row.kind === 'widget' && row.inputId === 'width'))
      .sort((a, b) =>
        Math.hypot(a.x + a.layout.width / 2 - centerX, a.y + a.layout.height / 2 - centerY) -
        Math.hypot(b.x + b.layout.width / 2 - centerX, b.y + b.layout.height / 2 - centerY))[0]!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'width')!
    const x = canvas.width / 2 - (node.x + node.layout.width / 2)
    const y = canvas.height / 2 - (node.y + row.y + row.height / 2)
    renderer.setViewport({ x, y, scale: 1 })
    return { x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 }
  })
  await page.mouse.click(widthRow.x, widthRow.y)
  await expect(page.locator('.widget-in-row-field input')).toBeFocused()
  await expect(navigator).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.locator('.widget-in-row-field')).toHaveCount(0)

  await page.setViewportSize({ width: 390, height: 844 })
  await setShellRegion(page, 'right', false)
  await navigator.focus()
  await expect(navigator).toBeFocused()
  await expect(navigator.getByRole('option')).toHaveCount(5)
  await capture(page, testInfo, 'narrow-selected-node')

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('graph-canvas')).toBeFocused()
  await expect(navigator.getByRole('option')).toHaveCount(0)
})
