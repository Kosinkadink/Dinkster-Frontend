import { mkdirSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { evidencePath, evidenceGroupDir } from './evidence-output.js'

interface ContextAppInternals {
  readonly canvasSelection: { get(): unknown }
  readonly widgetFocus: { get(): unknown }
  readonly diagnosticFocus: { get(): { readonly anchor?: unknown } | undefined }
}


const capture = async (page: Page, name: string): Promise<void> => {
  if (process.env['DINKSTER_CAPTURE_ISSUE_22'] !== '1') return
  await page.screenshot({
    path: `evidencePath('issue-22', '${name}.png')`,
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
        severity: 'error', source: 'runtime', code: 'proof.sourceBroken',
        message: 'Source node proof problem.',
        refs: [{ graphId: 'g0', nodeId: 'source' }],
        anchor: { occurrence: { instancePath: [], node: 'source' } },
      },
      {
        severity: 'warning', source: 'runtime', code: 'proof.targetSuspicious',
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
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(() => {
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'ProofNode', displayName: 'Proof Node', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'steps', displayName: 'Steps', type: { kind: 'concrete', name: 'INT' }, optional: false }],
      },
    ])
    // Two disconnected nodes: no links, so the solver contributes no
    // diagnostics and the spec fully controls the problem population.
    window.__dinksterTest!.app.openDocument({
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

test('the mounted Focused panel relabels without changing context, raw facts, or requests', async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 950 })
  const requests: string[] = []
  page.on('request', (event) => {
    const path = new URL(event.url()).pathname
    if (path.startsWith('/api/') || path === '/object_info' || path === '/system_stats' || path === '/prompt') {
      requests.push(`${event.method()} ${path}`)
    }
  })
  await reportTwoProblems(page)
  await widenRail(page)
  await railTab(page, 'context').click()
  await page.evaluate(() => { window.__dinksterTest!.controller!.setSelection(['source']) })

  const panel = page.getByTestId('context-panel')
  const context = page.getByTestId('context-summary')
  const entity = context.locator('.context-entities li')
  const problem = panel.locator('details.problem', { hasText: 'proof.sourceBroken' })
  const problemSummary = problem.locator('summary')
  await problemSummary.click()
  const showOnCanvas = problem.locator('.problem-show-on-canvas')
  await expect(showOnCanvas).toHaveText('Show on canvas')
  await showOnCanvas.focus()
  await expect(problem).toHaveAttribute('open', '')
  await expect(showOnCanvas).toBeFocused()
  await expect(entity).toContainText('Source proof')
  await expect(problemSummary).toContainText('[error] proof.sourceBroken: Node "Source proof" (source): Source node proof problem.')

  await panel.evaluate((element) => { element.dataset['localeIdentity'] = 'panel' })
  await context.evaluate((element) => { element.dataset['localeIdentity'] = 'context' })
  await entity.evaluate((element) => { element.dataset['localeIdentity'] = 'entity' })
  await problem.evaluate((element) => { element.dataset['localeIdentity'] = 'problem' })
  await problemSummary.evaluate((element) => { element.dataset['localeIdentity'] = 'problem-summary' })
  await showOnCanvas.evaluate((element) => { element.dataset['localeIdentity'] = 'show-on-canvas' })
  const stateBeforeLocale = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const focus = app as unknown as ContextAppInternals
    const tab = app.activeTab()!
    return {
      activeTabId: app.activeTabId.get(),
      document: JSON.stringify(tab.store.doc),
      revision: tab.store.revision,
      graphStack: [...tab.graphStack.get()],
      instancePath: [...tab.instancePath.get()],
      selection: focus.canvasSelection.get(),
      widgetFocus: focus.widgetFocus.get(),
      diagnosticFocus: focus.diagnosticFocus.get(),
    }
  })
  await page.screenshot({
    path: `evidencePath('issue-457', 'context-panel-i18n-en.png')`,
    fullPage: true,
    animations: 'disabled',
  })

  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  const requestsBeforeLocale = requests.length
  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'contextPanel.action.showOnCanvas': '[AUF DER LEINWAND ANZEIGEN]',
      'contextPanel.context.node': '[AUSGEWAHLTE KNOTEN IM AKTUELLEN KONTEXT]',
      'contextPanel.problems.count': '[{count, plural, one {# SICHTBARES PROBLEM} other {# SICHTBARE PROBLEME}}]',
      'contextPanel.problems.title': '[PROBLEME, DIE ZU DIESEM FOKUSSIERTEN KONTEXT GEHOREN]',
      'contextPanel.title': '[FOKUSSIERTER KONTEXT MIT LANGER UBERSETZUNG]',
      'Problem Surfaces': '[NICHT UBERSETZEN]',
      'Source proof': '[NICHT UBERSETZEN]',
      'proof.sourceBroken': '[NICHT UBERSETZEN]',
      'Source node proof problem.': '[NICHT UBERSETZEN]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(panel.locator('h2')).toHaveText('[FOKUSSIERTER KONTEXT MIT LANGER UBERSETZUNG]')
  await expect(context.locator('.context-kind')).toHaveText('[AUSGEWAHLTE KNOTEN IM AKTUELLEN KONTEXT]')
  await expect(panel.locator('.context-problems-title')).toContainText('[PROBLEME, DIE ZU DIESEM FOKUSSIERTEN KONTEXT GEHOREN]')
  await expect(panel.locator('.problems-group-count')).toHaveAttribute('aria-label', '[1 SICHTBARES PROBLEM]')
  await expect(showOnCanvas).toHaveText('[AUF DER LEINWAND ANZEIGEN]')
  await expect(panel).toHaveAttribute('data-locale-identity', 'panel')
  await expect(context).toHaveAttribute('data-locale-identity', 'context')
  await expect(entity).toHaveAttribute('data-locale-identity', 'entity')
  await expect(problem).toHaveAttribute('data-locale-identity', 'problem')
  await expect(problemSummary).toHaveAttribute('data-locale-identity', 'problem-summary')
  await expect(showOnCanvas).toHaveAttribute('data-locale-identity', 'show-on-canvas')
  await expect(problem).toHaveAttribute('open', '')
  await expect(showOnCanvas).toBeFocused()
  await expect(entity).toContainText('Source proof')
  await expect(problemSummary).toContainText('[error] proof.sourceBroken: Node "Source proof" (source): Source node proof problem.')
  expect(requests.slice(requestsBeforeLocale)).toEqual([])
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const focus = app as unknown as ContextAppInternals
    const tab = app.activeTab()!
    return {
      activeTabId: app.activeTabId.get(),
      document: JSON.stringify(tab.store.doc),
      revision: tab.store.revision,
      graphStack: [...tab.graphStack.get()],
      instancePath: [...tab.instancePath.get()],
      selection: focus.canvasSelection.get(),
      widgetFocus: focus.widgetFocus.get(),
      diagnosticFocus: focus.diagnosticFocus.get(),
    }
  })).toEqual(stateBeforeLocale)
  await page.screenshot({
    path: `evidencePath('issue-457', 'context-panel-i18n-de-DE.png')`,
    fullPage: true,
    animations: 'disabled',
  })

  await showOnCanvas.click()
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')
  await expect.poll(() => page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'source')!
    const viewport = renderer.getViewport()
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return Math.hypot(
      (node.x + node.layout.width / 2) * viewport.scale + viewport.x - canvas.width / 2,
      (node.y + node.layout.height / 2) * viewport.scale + viewport.y - canvas.height / 2,
    )
  })).toBeLessThan(2)
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
