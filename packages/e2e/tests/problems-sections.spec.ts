import { expect, openRailPanel, test, waitForWorkspaceReady } from './fixtures.js'
import { evidencePath } from './evidence-output.js'

test.use({ seedWorkflows: false })

test('removed pack parts open with anchored upgrade rows and preserve their stored values', async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/workflows/plan', (route) => route.fulfill({ json: { packs: [], assets: [], errors: [] } }))
  await page.goto('/')
  await waitForStartupOwnership(page)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'UpdatedSampler', displayName: 'Sampler', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'mode', displayName: 'Mode', optional: false,
        type: { kind: 'concrete', name: 'STRING' }, dynamic: { kind: 'dynamicCombo', materialization: 'wire15',
          options: [{ key: 'current', inputs: [] }, { key: 'other', inputs: [] }],
        } }],
    }])
    await app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'removed-pack-parts', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Updated pack', nodes: {
        option: { id: 'option', type: 'UpdatedSampler', title: 'Removed option',
          values: { 'mode.oldAmount': 31 }, dynamic: { mode: { selected: 'removed' } } },
        group: { id: 'group', type: 'UpdatedSampler', title: 'Removed group',
          values: { 'old.amount#m3': 17 }, dynamic: { old: { members: ['m3'], seq: 4 } } },
        choice: { id: 'choice', type: 'UpdatedSampler', title: 'Removed choice',
          values: { 'old.amount': 23 }, dynamic: { old: { selected: 'previous' } } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 3 } },
      view: { graphs: { g0: { nodes: {
        option: { position: { x: 50, y: 80 } }, group: { position: { x: 300, y: 80 } },
        choice: { position: { x: 50, y: 300 } },
      } } } },
    }, 'After a pack update')
  })
  await openRailPanel(page, 'Problems')
  const panel = page.getByTestId('problems-panel')
  await expect(panel.locator('.problems-group-title')).toContainText(['Upgraded on open'])
  const upgrades = panel.locator('[data-section="upgrade"]')
  await expect(upgrades.locator('details.problem')).toHaveCount(3)
  await expect(upgrades).toContainText("option 'removed' of 'Mode' is no longer in the pack. It is now 'current'.")
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.option!.dynamic!.mode!.selected)).toBe('current')
  await expect(page.getByTestId('status-bar')).not.toContainText('Workflow dynamic identities are invalid')
  await page.screenshot({ path: evidencePath('removed-pack-parts', 'opened.png'), animations: 'disabled' })
  await upgrades.locator('summary').filter({ hasText: 'Removed group:' }).click()
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')
  expect(await page.evaluate(() => {
    const nodes = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes
    return { values: nodes.option!.values, group: nodes.group!.dynamic, choice: nodes.choice!.dynamic }
  })).toEqual({ values: { 'mode.oldAmount': 31 }, group: { old: { members: ['m3'], seq: 4 } }, choice: { old: { selected: 'previous' } } })
})

test('Problems presents five ordered sections with one-line rows and debug-only codes', async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/workflows/plan', (route) => route.fulfill({ json: { packs: [], assets: [], errors: [] } }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await waitForWorkspaceReady(page)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'PanelSampler', displayName: 'Sampler', category: 'test', source: 'v3',
      isOutputNode: false, items: [],
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
  await expect(rows.first()).toHaveAttribute('title', 'Sampler: model memory is exhausted')
  await expect(panel.getByText('Sampler: model memory is exhausted', { exact: true })).toHaveCount(1)
  await panel.screenshot({ path: evidencePath('problems-sections', 'expanded-detail.png'), animations: 'disabled' })
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')
  await panel.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(panel.locator('.problems-group-title')).toHaveText([
    'Execution', 'This workflow', 'Packs and backend', 'Collaboration',
  ])
})
