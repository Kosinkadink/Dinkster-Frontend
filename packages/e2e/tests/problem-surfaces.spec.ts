import { mkdirSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { expect, mockProjectPacks, nativeTest as base, waitForWorkspaceReady } from './fixtures.js'
import { evidencePath, evidenceGroupDir } from './evidence-output.js'

const test = base.extend<{ proofDocument: boolean }>({ proofDocument: [true, { option: true }] })
const residentTest = test.extend({ proofDocument: false })

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

// Widen the rail so the complete tab labels and indicator fit.
const widenRail = async (page: Page): Promise<void> => {
  await page.getByTestId('rail-resize').focus()
  await page.keyboard.press('End')
  await expect(railTab(page, 'problems')).toBeVisible()
}

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

test.beforeEach(async ({ page, proofDocument }) => {
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.route('/api/workflows/plan', (route) => route.fulfill({ json: { packs: [], assets: [], errors: [] } }))
  if (!proofDocument) return
  await page.goto('/')
  await waitForWorkspaceReady(page)
  await page.evaluate(async () => {
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'ProofNode', displayName: 'Proof Node', category: 'test', source: 'v3', isOutputNode: false,
        body: [{ kind: 'input', id: 'steps', displayName: 'Steps', type: { kind: 'concrete', name: 'INT' }, optional: false }],
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

for (const state of ['shared', 'isolated', 'host-refused'] as const) {
  residentTest(`resident process availability is visible before Run (${state})`, async ({ page }) => {
    let submissions = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs') submissions++
    })
    const reason = state === 'host-refused'
      ? "Pack 'modifier' requires a writable mount that was not granted."
      : "Pack 'modifier' cannot receive a resident value from pack 'models' in another process; admit the pack to the shared inference process or use the owner's node through an engine-run node on a reference."
    await page.route('/api/nodes*', (route) => route.fulfill({ json: {
      schemaVersion: 1, epoch: 1,
      dinkster: { version: 'resident-process-test', schemaWire: 2, graphFeatures: ['regions', 'typedLiteral'] },
      nodes: {
        'proof.model': { displayName: 'Loaded model', pack: 'models', body: [
          { kind: 'output', id: 'model', type: { kind: 'concrete', types: ['MODEL'] } },
        ], residentAffinity: { types: ['MODEL'], routes: [{ process: 'models', pack: 'models', worker: 'local' }] } },
        'proof.modify': { displayName: 'Model modifier', pack: 'modifier', outputNode: true, body: [
          { kind: 'input', id: 'model', required: true, type: { kind: 'concrete', types: ['MODEL'] } },
        ], ...(state === 'host-refused' ? { unavailableReason: reason } : {}),
        residentAffinity: { types: ['MODEL'], routes: [{ process: state === 'isolated' ? 'isolated' : 'models', pack: 'modifier', worker: 'local' }] } },
      },
    } }))
    await mockProjectPacks(page, ['models', 'modifier'])
    await page.goto('/')
    await waitForWorkspaceReady(page, 2)
    await page.evaluate(async () => {
      await window.__dinksterTest!.app.openDocument({
        format: 'dinkster-workflow', formatVersion: 1, lineage: 'resident-process', root: 'g0',
        graphs: { g0: { id: 'g0', name: 'Resident model', nodes: {
          source: { id: 'source', type: 'proof.model', values: {} },
          target: { id: 'target', type: 'proof.modify', values: {} },
        }, links: { model: { id: 'model', from: { node: 'source', port: 'model' }, to: { node: 'target', port: 'model' } } }, nets: {}, reroutes: {}, nextOrdinal: 2 } },
        view: { graphs: { g0: { nodes: { source: { position: { x: 80, y: 160 } }, target: { position: { x: 380, y: 160 } } } } } },
      }, 'Resident model')
      window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    })
    await waitForWorkspaceReady(page)
    await expect.poll(() => page.evaluate(() => {
      const app = window.__dinksterTest!.app
      return app.previewComparisonCompile(app.activeTab()!) !== undefined
    })).toBe(true)
    const titleCompileCounts = await page.evaluate(async () => {
      const app = window.__dinksterTest!.app
      const tab = app.activeTab()!
      let compiles = 0
      const original = app.compileTab.bind(app)
      app.compileTab = (...args) => { compiles++; return original(...args) }
      const counts: number[] = []
      try {
        for (const title of ['Renamed model', 'Renamed model again', null]) {
          const outcome = tab.store.dispatch({ command: 'node.setTitle', params: { graphId: 'g0', nodeId: 'target', title } })
          if (!outcome.ok) throw new Error(JSON.stringify(outcome.diagnostics))
          await new Promise((resolve) => setTimeout(resolve, 250))
          counts.push(compiles)
        }
        if (!tab.store.undo() || !tab.store.redo()) throw new Error('Title history unavailable')
        await new Promise((resolve) => setTimeout(resolve, 250))
        counts.push(compiles)
      } finally { app.compileTab = original }
      return counts
    })
    expect(titleCompileCounts).toEqual([0, 0, 0, 0])
    await widenRail(page)
    await railTab(page, 'problems').click()
    const panel = page.getByTestId('problems-panel')
    await expect.poll(() => page.evaluate(() =>
      window.__dinksterTest!.renderer!.getBadges()['target']?.some((badge) => 'glyph' in badge && badge.glyph === 'Unavailable') ?? false)).toBe(state !== 'shared')
    if (state !== 'shared') {
      await expect(panel).toContainText(reason)
      const point = await page.evaluate(() => {
        const renderer = window.__dinksterTest!.renderer!
        const node = renderer.getScene().nodes.find((node) => node.id === 'target')!
        const tab = renderer.getNodeBadgeLayout(node).find((entry) => 'glyph' in entry.badge && entry.badge.glyph === 'Unavailable')
        if (!tab) throw new Error("no Unavailable tab on 'target'")
        const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
        const viewport = renderer.getViewport()
        return { x: rect.left + (tab.x + tab.width / 2) * viewport.scale + viewport.x,
          y: rect.top + (tab.y + tab.height / 2) * viewport.scale + viewport.y }
      })
      await page.mouse.click(point.x, point.y)
      await expect(page.getByTestId('problem-box-line').first()).toContainText(reason)
    } else await expect(panel).not.toContainText('residentProcessBoundary')
    expect(submissions).toBe(0)
    const path = test.info().outputPath(`resident-${state}.png`)
    await page.screenshot({ path, fullPage: true, animations: 'disabled' })
    await test.info().attach(`resident-${state}`, { path, contentType: 'image/png' })
    if (state !== 'shared') {
      expect(await page.evaluate(async () => {
        const app = window.__dinksterTest!.app
        return (await app.dispatchTo(app.activeTab()!, { command: 'node.move', params: {
          graphId: 'g0', positions: { target: { x: 520, y: 180 } },
        } })).ok
      })).toBe(true)
      await expect(panel).toContainText(reason)
      expect(await page.evaluate(async () => {
        const app = window.__dinksterTest!.app
        return (await app.dispatchTo(app.activeTab()!, { command: 'link.disconnect', params: {
          graphId: 'g0', linkId: 'model',
        } })).ok
      })).toBe(true)
      if (state === 'isolated') {
        await expect(panel).not.toContainText(reason)
        expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
        await expect(panel).toContainText(reason)
      } else await expect(panel).toContainText(reason)
      expect(submissions).toBe(0)
    }
  })
}

test('Selection only follows canvas selection without changing the full problem count', async ({ page }) => {
  await reportTwoProblems(page)
  await widenRail(page)
  const tab = railTab(page, 'problems')
  await tab.click()
  const panel = page.getByTestId('problems-panel')
  await expect(panel.locator('details.problem')).toHaveCount(2)
  const revisionBefore = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await panel.getByRole('checkbox', { name: 'Selection only' }).check()
  await expect(panel.getByTestId('problems-selection')).toHaveText('Nothing selected')
  await expect(panel.locator('details.problem')).toHaveCount(0)
  await expect(tab.getByTestId('panel-indicator').locator('[aria-hidden="true"]')).toHaveText('2')
  await page.evaluate(() => { window.__dinksterTest!.controller!.setSelection(['source']) })
  await expect(panel.getByTestId('problems-selection')).toHaveText('Source proof')
  await expect(panel.locator('details.problem')).toHaveCount(1)
  await expect(panel.locator('details.problem')).toContainText('proof.sourceBroken')
  await capture(page, 'problems-selection-node')
  await page.evaluate(() => { window.__dinksterTest!.controller!.setSelection([]) })
  await expect(panel.locator('details.problem')).toHaveCount(0)
  await panel.getByRole('checkbox', { name: 'Selection only' }).uncheck()
  await expect(panel.locator('details.problem')).toHaveCount(2)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revisionBefore)
})

test('the problem indicator is discoverable from every right-panel state and clears at zero', async ({ page }) => {
  // Extra panels make clipping explicit rather than depending on core tab count.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    for (let index = 0; index < 3; index++) app.panels.register({
      id: `attention-fixture-${index}`, title: `Additional panel ${index + 1}`,
      placement: 'rail', allowedPlacements: ['rail'], order: index, when: () => true,
      component: () => document.createElement('div'),
    })
  })
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
  await expect(row.getByRole('button', { name: 'Show in focused' })).toHaveCount(0)
  await row.getByRole('button', { name: 'Show on canvas' }).click()
  await expect(railTab(page, 'problems')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')
  await problemsPanel.getByRole('checkbox', { name: 'Selection only' }).check()
  await expect(problemsPanel.getByTestId('problems-selection')).toHaveText('Target proof')
  await expect(problemsPanel.locator('details.problem')).toHaveCount(1)
  await expect(problemsPanel.locator('details.problem')).toContainText('proof.targetSuspicious')
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
  const runsTab = railTab(page, 'runs')
  await runsTab.click()
  await expect(runsTab).toHaveAttribute('aria-selected', 'true')
  await runsTab.focus()
  await expect(runsTab).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(problemsTab).toBeFocused()
  await expect(problemsTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('problems-panel')).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(railTab(page, 'node-help')).toBeFocused()
})
