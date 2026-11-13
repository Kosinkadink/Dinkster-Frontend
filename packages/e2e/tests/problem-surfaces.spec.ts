import { mkdirSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { expect, test, waitForStartupOwnership } from './fixtures.js'
import { evidencePath, evidenceGroupDir } from './evidence-output.js'

const capture = async (page: Page, name: string): Promise<void> => {
  if (process.env['DINKSTER_CAPTURE_ISSUE_22'] !== '1') return
  await page.screenshot({
    path: evidencePath('issue-22', `${name}.png`),
    fullPage: true,
    animations: 'disabled',
  })
}

test.beforeAll(() => {
  mkdirSync(evidenceGroupDir('issue-22'), { recursive: true })
  mkdirSync(evidenceGroupDir('issue-457'), { recursive: true })
})

const railTab = (page: Page, id: string): Locator =>
  page.getByTestId('dock-zone-right').locator(`.product-tab[data-tab-id="${id}"]`)

// At the default rail width the trailing tabs (Focused, Problems) are
// clipped into the all-tabs menu; End on the resize separator widens the
// rail to its maximum, where every rail tab fits.
const widenRail = async (page: Page): Promise<void> => {
  await page.getByTestId('rail-resize').focus()
  await page.keyboard.press('End')
  await expect(railTab(page, 'problems')).toBeVisible()
}

const contextKind = (page: Page): Locator => page.getByTestId('context-summary')

const reportTwoProblems = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.reportProblems(app.activeTab()!.id, [
      {
        severity: 'error', origin: 'runtime', code: 'proof.sourceBroken',
        message: 'Source node proof problem.',
        refs: [{ graphId: 'g0', nodeId: 'source' }],
        anchor: { occurrence: { instancePath: [], node: 'source' } },
      },
      {
        severity: 'warning', origin: 'runtime', code: 'proof.targetSuspicious',
        message: 'Target node proof problem.',
        refs: [{ graphId: 'g0', nodeId: 'target' }],
        anchor: { occurrence: { instancePath: [], node: 'target' } },
      },
    ])
  })

test.beforeEach(async ({ page }) => {
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.route('/api/workflows/plan', (route) => route.fulfill({ json: { packs: [], assets: [], errors: [] } }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await waitForStartupOwnership(page)
  await page.evaluate(async () => {
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'ProofNode', displayName: 'Proof Node', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'steps', displayName: 'Steps', type: { kind: 'concrete', name: 'INT' }, optional: false }],
      },
    ])
    // Two disconnected nodes: no links, so the solver contributes no
    // diagnostics and the spec fully controls the problem population.
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'problem-surfaces', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        source: { id: 'source', type: 'ProofNode', title: 'Source proof', values: { steps: 4 } },
        target: { id: 'target', type: 'ProofNode', title: 'Target proof', values: { steps: 8 } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 3 } },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 40, y: 80 } },
        target: { position: { x: 520, y: 300 } },
      } } } },
    }, 'Problem Surfaces')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => 'status' in window.__dinksterTest!.app.activeTab()!.store)).toBe(true)
})

test('the Focused tab follows canvas focus and shows only that context\'s problems', async ({ page }) => {
  await reportTwoProblems(page)
  await widenRail(page)
  const tab = railTab(page, 'context')
  await expect(tab).toContainText('Focused')
  await tab.click()
  const panel = page.getByTestId('context-panel')
  await expect(panel).toBeVisible()

  // Nothing focused: the whole document is the context, every problem shows.
  await expect(contextKind(page)).toHaveAttribute('data-context-kind', 'document')
  await expect(panel.locator('details.problem')).toHaveCount(2)

  // Selecting a node on canvas narrows the context without any document
  // change; only that node's problem remains.
  const revisionBefore = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await page.evaluate(() => { window.__dinksterTest!.controller!.setSelection(['source']) })
  await expect(contextKind(page)).toHaveAttribute('data-context-kind', 'node')
  await expect(panel).toContainText('Source proof')
  await expect(panel.locator('details.problem')).toHaveCount(1)
  await expect(panel.locator('details.problem')).toContainText('proof.sourceBroken')
  await capture(page, 'context-tab-focused-node')

  // Clearing the selection returns to the document context.
  await page.evaluate(() => { window.__dinksterTest!.controller!.setSelection([]) })
  await expect(contextKind(page)).toHaveAttribute('data-context-kind', 'document')
  await expect(panel.locator('details.problem')).toHaveCount(2)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revisionBefore)
})

test('the problem indicator is discoverable from every right-panel state and clears at zero', async ({ page }) => {
  // The default active rail tab is Executions, so Problems starts INACTIVE;
  // at the default rail width it is clipped into the all-tabs menu.
  const problemsTab = railTab(page, 'problems')
  const overflowButton = page.getByTestId('dock-zone-right').getByTestId('dock-zone-overflow-button')
  await expect(problemsTab).toHaveAttribute('aria-selected', 'false')
  await expect(overflowButton.getByTestId('panel-indicator')).toHaveCount(0)

  // Clipped Problems tab: the attention aggregates onto the all-tabs
  // trigger, count and severity intact.
  await reportTwoProblems(page)
  const overflowBadge = overflowButton.getByTestId('panel-indicator')
  await expect(overflowBadge).toBeVisible()
  await expect(overflowBadge).toHaveAttribute('data-severity', 'error')
  await expect(overflowBadge).toContainText('2')
  await expect(overflowButton).toHaveAttribute('aria-label', /2 problems, worst severity error/)

  // Visible-but-inactive Problems tab: the badge sits on the tab itself.
  await widenRail(page)
  const badge = problemsTab.getByTestId('panel-indicator')
  await expect(badge).toBeVisible()
  await expect(badge).toHaveAttribute('data-severity', 'error')
  await expect(badge).toContainText('2')
  await expect(badge.locator('.visually-hidden')).toHaveText('2 problems, worst severity error')
  await capture(page, 'problems-indicator-inactive-tab')

  // Collapsing the rail keeps the attention visible on the region toggle.
  const railToggle = page.getByTestId('rail-toggle')
  await railToggle.click()
  await expect(page.getByTestId('dock-zone-right')).toHaveCount(0)
  await expect(railToggle.getByTestId('panel-indicator')).toBeVisible()
  await expect(railToggle).toHaveAttribute('aria-label', /2 problems, worst severity error/)
  await capture(page, 'problems-indicator-rail-collapsed')
  await railToggle.click()
  await expect(page.getByTestId('dock-zone-right')).toBeVisible()

  // No problems left: every badge clears.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.clearProblems(app.activeTab()!.id)
  })
  await expect(problemsTab.getByTestId('panel-indicator')).toHaveCount(0)
  await expect(railToggle.getByTestId('panel-indicator')).toHaveCount(0)
})

test('the whole-document list navigates to a problem\'s owning context', async ({ page }) => {
  await reportTwoProblems(page)
  await widenRail(page)
  await railTab(page, 'problems').click()
  const problemsPanel = page.getByTestId('problems-panel')
  await expect(problemsPanel.locator('details.problem')).toHaveCount(2)
  await capture(page, 'problems-tab-whole-document')

  const row = problemsPanel.locator('details.problem', { hasText: 'proof.targetSuspicious' })
  await row.locator('summary').click()
  await row.getByRole('button', { name: 'Show in Focused' }).click()

  // The owner is focused on canvas and the Focused tab takes over, showing
  // exactly the owner's problems.
  await expect(railTab(page, 'context')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')
  await expect(contextKind(page)).toHaveAttribute('data-context-kind', 'node')
  const contextPanel = page.getByTestId('context-panel')
  await expect(contextPanel).toContainText('Target proof')
  await expect(contextPanel.locator('details.problem')).toHaveCount(1)
  await expect(contextPanel.locator('details.problem')).toContainText('proof.targetSuspicious')
})

test('rail tabs, counts, and problem navigation stay keyboard and screen-reader accessible', async ({ page }) => {
  await reportTwoProblems(page)
  await widenRail(page)

  // The badge text is part of the tab's accessible name, so a screen
  // reader announces the count and severity with the tab.
  const problemsTab = page.getByRole('tab', { name: /Problems.*2 problems, worst severity error/ })
  await expect(problemsTab).toBeVisible()

  // Roving tabindex: focus the active tab, then arrow through enabled tabs.
  // Selection follows focus, so arrowing alone activates the Problems tab.
  const contextTab = railTab(page, 'context')
  await contextTab.click()
  await expect(contextTab).toHaveAttribute('aria-selected', 'true')
  await contextTab.focus()
  await expect(contextTab).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(railTab(page, 'node-help')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(railTab(page, 'problems')).toBeFocused()
  await expect(railTab(page, 'problems')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('problems-panel')).toBeVisible()

  // The context problem count is announced with an explicit label.
  await railTab(page, 'context').click()
  const count = page.locator('.context-problems-title .problems-group-count')
  await expect(count).toHaveAttribute('aria-label', '2 problems')
})
