import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

async function disableNativeDiscovery(page: Page): Promise<void> {
  await page.route('/api/nodes*', (route) => route.fulfill({ status: 502, body: 'no native backend' }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
}

test('settings changes reach an already-open panel window', async ({ page, context }) => {
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
