import { expect, nativeAppViewTest as test } from './fixtures.js'

test.use({ retentionApi: false })

test('cancels a running and a queued job while later jobs continue, including App View', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.has('dev.execution.sleep'))).toBe(true)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'cancel-live', root: 'root',
      graphs: { root: {
        id: 'root', name: 'Cancellation', nodes: {
          sleep: { id: 'sleep', type: 'dev.execution.sleep', title: 'Waiting job', values: { value: Date.now(), seconds: 30 } },
        }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      } },
      view: { graphs: { root: { nodes: { sleep: { position: { x: 120, y: 120 } } } } } },
      ext: { 'dinkster.appLayout': {
        version: 1, desktop: { items: [{ id: 'run-delay', kind: 'queue', label: 'Run delay', targets: [{ graphId: 'root', nodeId: 'sleep' }] }] },
        mobile: { customized: false, items: [] },
      } },
    } as never, 'Cancellation')
  })
  const toolbar = page.getByTestId('workflow-queue-control')
  await expect(toolbar.getByTestId('cancel-execution')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('cancel-before.png') })

  const queue = async () => page.evaluate(async () => {
    const app = window.__dinksterTest!.app as unknown as import('../../app/src/app-state.js').AppState
    await app.queue(app.activeTab()!, { kind: 'partial', targets: [{ instancePath: [], node: 'sleep' as never }] })
  })
  const states = () => page.evaluate(() => [...window.__dinksterTest!.app.store.executions.get().values()].map((entry) => entry.status))
  await queue()
  await expect.poll(states).toEqual(['running'])
  await queue()
  await queue()
  await expect.poll(states).toEqual(['running', 'queued', 'queued'])
  await page.getByTestId('workflow-queue-toggle').click()
  const entries = page.getByTestId('workflow-queue-entry')
  await expect(entries.filter({ has: page.getByText('Queued', { exact: true }) }).getByRole('button', { name: 'Cancel run' })).toHaveCount(2)
  await entries.filter({ has: page.getByText('Queued', { exact: true }) }).first().getByRole('button', { name: 'Cancel run' }).click()
  await expect.poll(states).toEqual(['running', 'queued', 'cancelled'])
  await page.screenshot({ path: testInfo.outputPath('cancel-during.png') })
  await toolbar.locator('.workflow-queue-buttons').getByRole('button', { name: 'Cancel run' }).focus()
  await page.keyboard.press('Enter')
  await expect.poll(states).toEqual(['cancelled', 'running', 'cancelled'])
  await expect(entries.filter({ has: page.getByText('Cancelled', { exact: true }) })).toHaveCount(2)
  await page.screenshot({ path: testInfo.outputPath('cancel-after.png') })

  await page.getByTestId('workflow-queue-toggle').click()
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
  const placement = page.getByTestId('app-layout-queue')
  await expect(placement.getByRole('button', { name: 'Cancel run' })).toBeVisible()
  await placement.getByRole('button', { name: 'Cancel run' }).click()
  await expect.poll(states).toEqual(['cancelled', 'cancelled', 'cancelled'])
  await expect(page.getByTestId('app-layout-queue-state')).toHaveText('Cancelled')
  await page.getByRole('button', { name: 'Run delay', exact: true }).click()
  await expect.poll(states).toEqual(['cancelled', 'cancelled', 'cancelled', 'running'])
  await placement.getByRole('button', { name: 'Cancel run' }).click()
  await expect.poll(states).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled'])
  await page.screenshot({ path: testInfo.outputPath('cancel-app-view.png') })
})
