import { expect, nativeAppViewTest as test, waitForWorkspaceReady } from './fixtures.js'


test('each slim X cancels its own job while later jobs continue, and App View still cancels', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.has('dev.execution.sleep'))).toBe(true)
  await waitForWorkspaceReady(page)
  await page.evaluate(async () => {
    const diagnostics = await window.__dinksterTest!.app.openDocument({
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
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
  })
  const topbar = page.getByRole('banner', { name: 'Application controls' })
  await expect(topbar.getByTestId('cancel-execution')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('cancel-before.png') })

  const queue = async () => page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queue(app.activeTab()!, { kind: 'partial', targets: [{ instancePath: [], node: 'sleep' as never }] })
  })
  const states = () => page.evaluate(() => [...window.__dinksterTest!.app.store.executions.get().values()].map((entry) => entry.status))
  await queue()
  await expect.poll(states).toEqual(['running'])
  await queue()
  await queue()
  await expect.poll(states).toEqual(['running', 'queued', 'queued'])

  // The count beside Run opens the list; the X on the job next in line cancels that job only.
  await page.getByTestId('workflow-queue-toggle').click()
  const entries = page.getByTestId('workflow-queue-entry')
  await expect(entries.locator('.run-row-detail')).toHaveText(['0%', 'next', '2 in line'])
  await expect(entries.getByTestId('cancel-execution')).toHaveCount(3)
  await entries.filter({ hasText: 'next' }).getByTestId('cancel-execution').click()
  await expect.poll(states).toEqual(['running', 'cancelled', 'queued'])
  await page.screenshot({ path: testInfo.outputPath('cancel-during.png') })
  await page.getByTestId('workflow-queue-toggle').click()

  // The top bar's X names and cancels the running job; the last one in line starts.
  const topX = topbar.getByTestId('cancel-execution')
  await expect(topX).toHaveAttribute('aria-label', 'Cancel Cancellation')
  await topX.focus()
  await page.keyboard.press('Enter')
  await expect.poll(states).toEqual(['cancelled', 'cancelled', 'running'])

  // The X after the count on the Run bar cancels this workflow's running job.
  await page.getByTestId('workflow-cancel').click()
  await expect.poll(states).toEqual(['cancelled', 'cancelled', 'cancelled'])
  await expect(page.getByTestId('workflow-cancel')).toHaveCount(0)
  await expect(topbar.getByTestId('cancel-execution')).toHaveCount(0)

  // The X on the Runs panel's running row cancels that job.
  await queue()
  await expect.poll(states).toEqual(['cancelled', 'cancelled', 'cancelled', 'running'])
  const running = page.getByTestId('runs-panel').getByTestId('runs-running').getByTestId('execution-row')
  await expect(running).toHaveCount(1)
  await running.getByTestId('cancel-execution').click()
  await expect.poll(states).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled'])
  await page.screenshot({ path: testInfo.outputPath('cancel-after.png') })

  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App', exact: true }).click()
  const placement = page.getByTestId('app-layout-queue')
  await page.getByRole('button', { name: 'Run delay', exact: true }).click()
  await expect.poll(states).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled', 'running'])
  await placement.getByRole('button', { name: 'Cancel run' }).click()
  await expect.poll(states).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled', 'cancelled'])
  await expect(page.getByTestId('app-layout-queue-state')).toHaveText('Cancelled')
  await page.screenshot({ path: testInfo.outputPath('cancel-app-view.png') })
})
