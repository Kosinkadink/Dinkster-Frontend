import { expect, openRailPanel, test, waitForWorkspaceReady } from './fixtures.js'
import { evidencePath } from './evidence-output.js'

test.use({ seedWorkflows: false })

test('removed pack parts open with a notice for the replaced option, anchored rows for the rest, and their stored values kept', async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/workflows/plan', (route) => route.fulfill({ json: { packs: [], assets: [], errors: [] } }))
  await page.goto('/')
  await waitForWorkspaceReady(page)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'UpdatedSampler', displayName: 'Sampler', category: 'test', source: 'v3', isOutputNode: false,
      body: [{ kind: 'choice', id: 'mode', displayName: 'Mode', required: true, shared: [],
        options: [{ key: 'current', rows: [] }, { key: 'other', rows: [] }] }],
    }])
    await app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'removed-pack-parts', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Updated pack', nodes: {
        option: { id: 'option', type: 'UpdatedSampler', title: 'Removed option',
          values: { 'mode.oldAmount': 31 }, dynamic: { mode: { selected: 'removed' } } },
        group: { id: 'group', type: 'UpdatedSampler', title: 'Removed group',
          values: { 'old.m3.amount': 17 }, dynamic: { old: { members: ['m3'], seq: 4 } } },
        choice: { id: 'choice', type: 'UpdatedSampler', title: 'Removed choice',
          values: { 'old.amount': 23 }, dynamic: { old: { selected: 'previous' } } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 3 } },
      view: { graphs: { g0: { nodes: {
        option: { position: { x: 50, y: 80 } }, group: { position: { x: 300, y: 80 } },
        choice: { position: { x: 50, y: 300 } },
      } } } },
    }, 'After a pack update')
  })
  // The removed option is replaced and reported in the notice; the parts it cannot replace stay problems.
  const notice = page.getByTestId('fixes-notice')
  await expect(notice.locator('.dinkster-fixes-title')).toHaveText('1 thing was adjusted')
  await notice.getByRole('button', { name: 'Review', exact: true }).click()
  await expect(notice).toContainText("option 'removed' of 'Mode' is no longer in the pack. It is now 'current'.")
  await openRailPanel(page, 'Problems')
  const panel = page.getByTestId('problems-panel')
  await expect(panel.locator('.problems-group-title')).not.toContainText(['Upgraded on open'])
  const upgrades = panel.locator('[data-section="workflow"] details.problem').filter({ hasText: 'is no longer part of this node' })
  await expect(upgrades).toHaveCount(2)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.option!.dynamic!.mode!.selected)).toBe('current')
  await expect(page.getByTestId('status-bar')).not.toContainText('Workflow dynamic identities are invalid')
  await page.screenshot({ path: evidencePath('removed-pack-parts', 'opened.png'), animations: 'disabled' })
  await upgrades.locator('summary').filter({ hasText: 'Removed group:' }).click()
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')
  expect(await page.evaluate(() => {
    const nodes = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes
    return { values: nodes.option!.values, group: nodes.group!.dynamic, choice: nodes.choice!.dynamic }
  })).toEqual({ values: { 'mode.oldAmount': 31 }, group: { mode: { selected: 'current' }, old: { members: ['m3'], seq: 4 } },
    choice: { mode: { selected: 'current' }, old: { selected: 'previous' } } })
})

test('Problems presents four ordered sections with one-line rows and debug-only codes', async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/workflows/plan', (route) => route.fulfill({ json: { packs: [], assets: [], errors: [] } }))
  await page.goto('/')
  await waitForWorkspaceReady(page)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'PanelSampler', displayName: 'Sampler', category: 'test', source: 'v3',
      isOutputNode: false, body: [],
    }])
    await app.openDocument({
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
    'Execution', 'This workflow', 'Packs and backend', 'Collaboration',
  ])
  const rows = panel.locator('details.problem summary')
  await expect(rows).toHaveCount(5)
  await panel.screenshot({ path: evidencePath('problems-sections', 'four-sections.png'), animations: 'disabled' })
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
  await expect(rows.first()).toHaveAttribute('title', 'Sampler: model memory is exhausted')
  await expect(panel.getByText('Sampler: model memory is exhausted', { exact: true })).toHaveCount(1)
  await panel.screenshot({ path: evidencePath('problems-sections', 'expanded-detail.png'), animations: 'disabled' })
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')
})
