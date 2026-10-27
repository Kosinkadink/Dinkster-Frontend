import { expect, openRailPanel, test } from './fixtures.js'
import { evidencePath } from './evidence-output.js'

test('Problems presents five ordered sections with one-line rows and debug-only codes', async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'PanelSampler', displayName: 'Sampler', category: 'test', source: 'v3',
      isOutputNode: false, items: [],
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'problems-sections', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root', nodes: { sampler: { id: 'sampler', type: 'PanelSampler', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      } },
      view: { graphs: { g0: { nodes: { sampler: { position: { x: 100, y: 80 } } } } } },
    }, 'Problems')
    app.reportProblems(app.activeTab()!.id, [
      { severity: 'warning', origin: 'collab', code: 'collab.disconnected', message: 'Shared session: connection lost' },
      { severity: 'warning', origin: 'schema', code: 'schema.unresolvedType', message: 'EmptyImage: not available on backend Local' },
      { severity: 'info', origin: 'import', code: 'import.fixture', message: 'Sampler: saved seed format is upgraded' },
      { severity: 'warning', origin: 'compile', code: 'compile.input.missing', message: 'Sampler model: required input has no connection' },
      {
        severity: 'error', origin: 'runtime', code: 'runtime.failed', message: 'Sampler: model memory is exhausted',
        anchor: { occurrence: { instancePath: [], node: 'sampler' } },
      },
    ])
  })
  await openRailPanel(page, 'Problems')
  const panel = page.getByTestId('problems-panel')
  await expect(panel.locator('.problems-group-title')).toHaveText([
    'Execution', 'This workflow', 'Upgraded on open', 'Packs and backend', 'Collaboration',
  ])
  const rows = panel.locator('details.problem summary')
  await expect(rows).toHaveCount(5)
  await panel.screenshot({ path: evidencePath('problems-sections', 'five-sections.png'), animations: 'disabled' })
  for (const row of await rows.all()) {
    await expect(row).not.toContainText(/\[(error|warning|info)\]|(?:runtime|schema|compile|import|collab)\./)
    const line = row.locator('.problem-message')
    expect(await line.evaluate((element) => {
      const style = getComputedStyle(element)
      const text = document.createRange()
      text.selectNodeContents(element)
      return { whiteSpace: style.whiteSpace, lines: [...new Set(Array.from(text.getClientRects(), (rect) => rect.top))] }
    })).toMatchObject({ whiteSpace: 'nowrap', lines: [expect.any(Number)] })
  }
  await rows.first().click()
  await expect(panel.locator('details.problem').first().locator('.problem-detail')).toContainText('runtime.failed')
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')
  await panel.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(panel.locator('.problems-group-title')).toHaveText([
    'Execution', 'This workflow', 'Packs and backend', 'Collaboration',
  ])
})
