/**
 * Widget-value diagnostics in the Problems panel.
 *
 * Stored widget values are validated through the same WidgetKind contract
 * the editors use, so a document that ARRIVES broken (hand-edited JSON, an
 * older frontend, a schema whose bounds tightened) reports itself without
 * anyone opening an editor. These specs pin the scope rules end to end in
 * the production CanvasHost + Problems panel:
 *
 * - only STORED values are diagnosed (schema defaults are the author's
 *   contract, not the document's)
 * - explicit JSON null is a stored value (ASSET / SAVE_TARGET "no value"),
 *   not an absent one, and must validate clean
 * - link-driven inputs are skipped: the wire decides the executed value and
 *   the dormant stored literal underneath must not nag
 * - diagnostics REPLACE per scene build (never accumulate) and clear the
 *   moment the value is fixed through the real editor
 * - every message is anchored as <nodeId>.<valueKey> so a report names the
 *   exact node and input
 */
import { expect, test, type Page } from './fixtures.js'

const problems = (page: Page) => page.getByTestId('problems-panel')

const problemEntries = (page: Page, code: string) =>
  problems(page).locator('details.problem', { hasText: code })

async function openEditor(page: Page, nodeId: string, inputId: string): Promise<void> {
  const point = await page.evaluate(({ nodeId, inputId }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  }, { nodeId, inputId })
  await page.mouse.click(point.x, point.y)
}

/** Page coordinates for one node badge, resolved by stable badge id. */
async function badgePoint(page: Page, nodeId: string, badgeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, badgeId }) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((item) => item.id === nodeId)!
    const index = (renderer.getBadges()[nodeId] ?? []).findIndex((badge) => badge.id === badgeId)
    if (index < 0) throw new Error(`no badge '${badgeId}' on '${nodeId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    // Mirrors badgeRect(): index 0 is rightmost, 22px inset, 18px stride.
    return {
      x: rect.left + (node.x + node.layout.width - 22 + 7 - index * 18) * viewport.scale + viewport.x,
      y: rect.top + (node.y + node.layout.headerHeight / 2) * viewport.scale + viewport.y,
    }
  }, { nodeId, badgeId })
}

/**
 * Every test opens its own document over the same schema pair: a widgets
 * node carrying one input per widget kind under test, and an INT producer
 * for the link-driven exclusion. Values (and links) vary per test, so the
 * fixture takes them as arguments instead of baking one broken document.
 */
async function openFixture(
  page: Page,
  values: Record<string, unknown>,
  links: Record<string, unknown> = {},
): Promise<void> {
  await page.evaluate(({ values, links }) => {
    const widget = (id: string, widgetType: string, defaultValue: unknown, options: Record<string, unknown> = {}) => ({
      kind: 'input', id, type: { kind: 'concrete', name: widgetType === 'COMBO' ? 'core.combo' : widgetType }, optional: false,
      widget: { widgetType, options, default: defaultValue },
    })
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'DiagWidgetsTest', displayName: 'Diag Widgets', category: 'test', source: 'v3', isOutputNode: false,
        items: [
          widget('count', 'INT', 5, { min: 0, max: 100 }),
          widget('choice', 'COMBO', 'alpha', { options: ['alpha', 'beta', 'gamma'] }),
          { kind: 'input', id: 'required', displayName: 'Required value', type: { kind: 'concrete', name: 'INT' }, optional: false },
          { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'dinkster.asset' }, optional: true,
            widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: null } },
          { kind: 'input', id: 'target', type: { kind: 'concrete', name: 'dinkster.save_target' }, optional: true,
            widget: { widgetType: 'SAVE_TARGET', options: { suffix: '.png' }, default: { mount: 'comfy-output', prefix: 'ComfyUI' } } },
        ],
      },
      {
        type: 'DiagIntSourceTest', displayName: 'Int Source', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'INT' } }],
      },
    ])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'widget-diagnostics', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        widgets: { id: 'widgets', type: 'DiagWidgetsTest', values },
        src: { id: 'src', type: 'DiagIntSourceTest', values: {} },
      }, links, nets: {}, reroutes: {}, nextOrdinal: 9 } },
      view: { graphs: { g0: { nodes: {
        widgets: { position: { x: 300, y: 100 } },
        src: { position: { x: 40, y: 100 } },
      } } } },
    }, 'Widget Diagnostics')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, { values, links })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
})

test('legacy SAVE_TARGET prefixes migrate structurally, reopen, and compile while unsafe strings stay loud', async ({ page }) => {
  const valid = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'LegacySaveTargetTest', displayName: 'Legacy Save Target', category: 'test', source: 'v3', isOutputNode: true,
      items: [{ kind: 'input', id: 'target', type: { kind: 'concrete', name: 'dinkster.save_target' }, optional: false,
        widget: { widgetType: 'SAVE_TARGET', options: {}, default: { mount: 'comfy-output', prefix: 'ComfyUI' } } }],
    }])
    const diagnostics = app.openDocument({
      last_node_id: 1, last_link_id: 0,
      nodes: [{ id: 1, type: 'LegacySaveTargetTest', pos: [10, 10], widgets_values: ['SD1.5'] }],
      links: [], groups: [], config: {}, extra: {}, version: 0.4,
    }, 'Legacy structured target') as ReadonlyArray<{ code: string }>
    const tab = app.activeTab()!
    const value = tab.store.doc.graphs.g0!.nodes.n1!.values.target
    const exported = app.exportDocument(tab.id)
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error('migrated target did not compile')
    const prompt = (compiled.artifact as unknown as { prompt: Record<string, { inputs: Record<string, unknown> }> }).prompt
    return { diagnostics: diagnostics.map((entry) => entry.code), value, exported, compiled: prompt.n1!.inputs.target }
  })
  expect(valid.diagnostics).not.toContain('import.saveTarget.invalidLegacy')
  expect(valid.value).toEqual({ mount: 'comfy-output', prefix: 'SD1.5' })
  expect(valid.compiled).toEqual(valid.value)
  await expect(problems(page)).not.toContainText('widget.SAVE_TARGET.badValue')
  expect(await page.evaluate((document) => {
    const app = window.__dinksterTest!.app
    app.openDocument(document, 'Reopened structured target')
    return app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values.target
  }, valid.exported)).toEqual(valid.value)

  const invalid = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.openDocument({
      last_node_id: 1, last_link_id: 0,
      nodes: [{ id: 1, type: 'LegacySaveTargetTest', pos: [10, 10], widgets_values: ['../escape'] }],
      links: [], groups: [], config: {}, extra: {}, version: 0.4,
    }, 'Invalid legacy target')
    return {
      codes: app.problems.get().map((entry) => entry.code),
      value: app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values.target,
    }
  })
  expect(invalid.value).toBe('../escape')
  expect(invalid.codes).toContain('import.saveTarget.invalidLegacy')
  await expect(problems(page)).toContainText('import.saveTarget.invalidLegacy')
  await expect(problems(page)).toContainText('widget.SAVE_TARGET.badValue')
})

test('out-of-range stored INT reports anchored in Problems and clears when fixed in the editor', async ({ page }) => {
  await openFixture(page, { count: 999 })
  // Anchored as node.valueKey so the report names the exact input.
  await expect(problems(page)).toContainText('widget.INT.aboveMax')
  await expect(problems(page)).toContainText('widgets.count: 999 > max 100')
  // Fixing the value through the real editor rebuilds the scene and the
  // diagnostic goes with it - replace semantics, not append.
  await openEditor(page, 'widgets', 'count')
  const input = page.getByTestId('widget-editor').locator('input')
  await input.fill('42'); await input.press('Enter')
  await expect(problems(page)).not.toContainText('widget.INT')
})

test('a stored value of the wrong JSON shape reports badValue instead of crashing the validator', async ({ page }) => {
  // A hand-edited document can store anything; the kind's valueSchema gate
  // must catch the shape mismatch BEFORE validate() sees the value.
  await openFixture(page, { count: 'not a number' })
  await expect(problems(page)).toContainText('widget.INT.badValue')
  await expect(problems(page)).toContainText('widgets.count')
})

test('unknown stored COMBO option reports and clears when a listed option is picked', async ({ page }) => {
  await openFixture(page, { choice: 'omega' })
  await expect(problems(page)).toContainText('widget.COMBO.unknownOption')
  await expect(problems(page)).toContainText("widgets.choice: 'omega' is not in the option list")
  await openEditor(page, 'widgets', 'choice')
  const search = page.getByTestId('combo-search')
  await search.fill('beta'); await search.press('ArrowDown'); await search.press('Enter')
  await expect(problems(page)).not.toContainText('widget.COMBO')
})

test('invalid stored save target reports the grammar violation and clears through the picker', async ({ page }) => {
  await page.route('**/api/mounts*', (route) => void route.fulfill({ json: { mounts: [
    { id: 'comfy-output', path: '/srv/out', mode: 'readwrite', source: 'derived', state: 'ready' },
  ] } }))
  // Absolute prefix: refused by the shared save-target grammar.
  await openFixture(page, { target: { mount: 'comfy-output', prefix: '/etc/passwd' } })
  await expect(problems(page)).toContainText('widget.SAVE_TARGET.invalid')
  await expect(problems(page)).toContainText('widgets.target')
  await openEditor(page, 'widgets', 'target')
  await expect(page.getByTestId('save-target-editor')).toHaveAttribute('data-mounts', 'ready')
  await page.getByTestId('save-target-prefix').fill('renders/stem')
  await page.getByTestId('save-target-save').click()
  await expect(problems(page)).not.toContainText('widget.SAVE_TARGET')
})

test('explicit null ASSET and SAVE_TARGET are stored values that validate clean', async ({ page }) => {
  // null is "no value chosen", a legal state for both kinds - it must not
  // be mistaken for absent (skipped) OR for a shape violation (badValue).
  await openFixture(page, { image: null, target: null })
  await expect(problems(page)).toContainText('None.')
})

test('a link-driven input does not report its dormant stored literal', async ({ page }) => {
  // The wire decides the executed value; the stored 999 survives untouched
  // underneath (companion display) and must not nag while driven.
  await openFixture(page, { count: 999 }, {
    l1: { id: 'l1', from: { node: 'src', port: 'out' }, to: { node: 'widgets', port: 'count' } },
  })
  await expect(problems(page)).not.toContainText('widget.INT')
})

test('diagnostics replace per scene rebuild: unrelated edits never duplicate an entry', async ({ page }) => {
  await openFixture(page, { count: 999 })
  await expect(problemEntries(page, 'widget.INT.aboveMax')).toHaveCount(1)
  // Editing a DIFFERENT widget rebuilds the scene; the standing diagnostic
  // must stay a single entry, not accumulate one copy per rebuild.
  await openEditor(page, 'widgets', 'choice')
  const search = page.getByTestId('combo-search')
  await search.fill('gamma'); await search.press('ArrowDown'); await search.press('Enter')
  await expect(problemEntries(page, 'widget.INT.aboveMax')).toHaveCount(1)
  await expect(problems(page)).toContainText('widgets.count: 999 > max 100')
})

test('node problem badges expose friendly details, clear live, and distinguish blocking warnings', async ({ page }) => {
  await openFixture(page, { count: 999 })

  // The widget sweep is advisory: it paints the amber warning badge, not the
  // explicit execution-blocking warning badge.
  await expect.poll(() => page.evaluate(() =>
    (window.__dinksterTest!.renderer!.getBadges()['widgets'] ?? []).map((badge) => badge.id),
  )).toContain('core.problem.warning')
  await expect.poll(() => page.evaluate(() =>
    (window.__dinksterTest!.renderer!.getBadges()['widgets'] ?? []).map((badge) => badge.id),
  )).not.toContain('core.problem.blocking-warning')

  const advisory = await badgePoint(page, 'widgets', 'core.problem.warning')
  await page.keyboard.down('Alt')
  await page.mouse.move(advisory.x, advisory.y)
  const tooltip = page.getByTestId('app-tooltip')
  await expect(tooltip).toContainText('Node "Diag Widgets" (widgets)', { timeout: 1_500 })
  await expect(tooltip).toContainText('input "count"')
  await page.keyboard.up('Alt')

  await page.mouse.click(advisory.x, advisory.y)
  const popover = page.getByTestId('badge-popover')
  await expect(popover).toHaveAttribute('data-badge', 'core.problem.warning')
  const detail = popover.getByTestId('badge-problem-detail')
  await expect(detail).toContainText('Node "Diag Widgets" (widgets)')
  await expect(detail).toContainText('input "count"')
  await expect(detail).toContainText('999 > max 100')

  // Fixing the value replaces solveDiagnostics. The effect dependency must
  // rederive overlays and remove the warning badge without another gesture.
  await openEditor(page, 'widgets', 'count')
  const input = page.getByTestId('widget-editor').locator('input')
  await input.fill('42'); await input.press('Enter')
  await expect.poll(() => page.evaluate(() =>
    (window.__dinksterTest!.renderer!.getBadges()['widgets'] ?? []).map((badge) => badge.id),
  )).not.toContain('core.problem.warning')

  // Compile the fixture's unvalued required API input and publish that real
  // compile sweep under the active tab owner. Its severity remains warning,
  // but its explicit blocksExecution signal selects the orange badge.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const result = app.compileTab(tab)
    if (!result?.ok) throw new Error('fixture compile failed')
    const missing = result.artifact.diagnostics.filter((diagnostic) => diagnostic.code === 'compile.input.missing')
    if (missing.length !== 1) throw new Error(`expected one missing-input diagnostic, got ${missing.length}`)
    app.reportProblems(tab.id, missing)
  })
  await expect.poll(() => page.evaluate(() =>
    (window.__dinksterTest!.renderer!.getBadges()['widgets'] ?? []).map((badge) => badge.id),
  )).toContain('core.problem.blocking-warning')
  await expect.poll(() => page.evaluate(() =>
    (window.__dinksterTest!.renderer!.getBadges()['widgets'] ?? []).map((badge) => badge.id),
  )).not.toContain('core.problem.warning')
})
