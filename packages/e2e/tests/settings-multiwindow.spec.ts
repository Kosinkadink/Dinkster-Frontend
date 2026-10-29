import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

async function disableNativeDiscovery(page: Page): Promise<void> {
  await page.route('/api/nodes*', (route) => route.fulfill({ status: 502, body: 'no native backend' }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
}

async function expectInteractiveReturnButton(page: Page, state: Locator): Promise<void> {
  const button = state.getByRole('button', { name: 'Move back to main window', exact: true })
  await expect(button).toBeVisible()
  await expect(button).toBeEnabled()
  await expect(button).toHaveAttribute('type', 'button')
  await expect(button).toHaveCSS('cursor', 'pointer')
  await page.mouse.move(0, 0)
  const background = await button.evaluate((element) => getComputedStyle(element).backgroundColor)
  await button.hover()
  await expect.poll(() => button.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(background)
  await page.keyboard.press('Tab')
  await button.focus()
  await expect(button).toBeFocused()
  await expect(button).toHaveCSS('outline-style', 'solid')
  expect(await button.evaluate((element) => Number.parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThan(0)
}

test('settings changes reach an already-open panel window', async ({ page, context }, info) => {
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  const setGate = (enabled: boolean) => page.evaluate((value) => {
    const app = window.__dinksterTest!.app as unknown as {
      settings: { set(id: string, next: boolean): void }
    }
    app.settings.set('features.controlSurfaces.enabled', value)
  }, enabled)
  await setGate(true)

  const panel = await context.newPage()
  await disableNativeDiscovery(panel)
  await panel.goto('/?dinksterWindow=browser-panel-surfaces&dinksterWindowKind=panel&dinksterPanel=surfaces&dinksterPanelReturn=rail')
  await panel.waitForFunction(() => window.__dinksterTest !== undefined)
  await expect(panel.locator('[data-testid="native-panel-window"][data-panel="surfaces"]')).toBeVisible()

  await setGate(false)
  await expect(panel.getByTestId('native-panel-window-missing')).toBeVisible()
  await expect(panel.getByTestId('native-panel-window-missing')).toContainText('Panel unavailable')
  await expectInteractiveReturnButton(panel, panel.getByTestId('native-panel-window-missing'))
  await panel.screenshot({ path: info.outputPath('missing-panel-action.png') })

  await panel.goto('/?dinksterWindow=browser-missing-workflow&dinksterWorkflow=not-an-open-workflow')
  const missing = panel.getByTestId('detached-workflow-missing')
  await expect(missing).toBeVisible()
  await expect(missing).toContainText('Workflow unavailable')
  await expectInteractiveReturnButton(panel, missing)
  await panel.screenshot({ path: info.outputPath('missing-workflow-action.png') })
})

test('panel window headers render and clear live indicators', async ({ page }) => {
  await disableNativeDiscovery(page)
  await page.goto('/?dinksterWindow=browser-panel-problems&dinksterWindowKind=panel&dinksterPanel=problems&dinksterPanelReturn=rail')
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  const panel = page.locator('[data-testid="native-panel-window"][data-panel="problems"]')
  await expect(panel).toBeVisible()

  const owner = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): { id: string } | undefined
      createWorkflow(): { id: string }
      reportProblems(owner: string, diagnostics: readonly unknown[]): void
    }
    const id = (app.activeTab() ?? app.createWorkflow()).id
    app.reportProblems(id, [{
      severity: 'warning', source: 'runtime', code: 'proof.panelWindowIndicator',
      message: 'Detached panel indicator proof.',
    }])
    return id
  })
  const indicator = panel.getByTestId('panel-indicator')
  await expect(indicator).toHaveAttribute('data-severity', 'warning')
  await expect(indicator.locator('.visually-hidden')).toHaveText('1 problem, worst severity warning')

  await page.evaluate((id) => { window.__dinksterTest!.app.clearProblems(id) }, owner)
  await expect(indicator).toHaveCount(0)
})
