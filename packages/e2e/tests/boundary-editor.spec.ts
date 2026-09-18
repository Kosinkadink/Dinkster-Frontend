/**
 * Boundary exposure editor (hazard F10): while editing a subgraph
 * definition, forwarded families show an exposure tree driven entirely by
 * boundary.setSlots / boundary.clearSlots.
 *
 * The contract under test: pinning writes an explicit full selection;
 * checkbox states derive from the document (whole / narrowed via
 * indeterminate / excluded); unchecking an inherited slot expands the
 * covering whole-subtree entry into explicit siblings; edits are single
 * undo steps; emptying a pinned selection is refused with an inline notice
 * (no document write); hiding a required socket-only slot commits but
 * surfaces derive's boundary.slotStarved inline; unpinning restores
 * whole-template tracking.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, openRailPanel, test, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_BOUNDARY_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

async function capture(page: Page, name: string): Promise<void> {
  if (!proofDir) return
  await page.screenshot({ path: join(proofDir, `${name}.png`), animations: 'disabled', fullPage: true })
}

async function identityViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

const activeDoc = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

const fwdSlots = async (page: Page): Promise<readonly string[] | undefined> => {
  const doc = await activeDoc(page)
  const graphs = doc.graphs as Record<
    string,
    { boundary?: { inputs: ReadonlyArray<{ id: string; binds: { slots?: readonly string[] } }> } }
  >
  return graphs['sub']!.boundary!.inputs.find((b) => b.id === 'fwd')!.binds.slots
}

const slotToggle = (page: Page, path: string) =>
  page.locator(`[data-testid=slot-toggle][data-slot-path="${path}"]`)

const boundaryTab = (page: Page) =>
  page.getByTestId('dock-zone-right').locator('[role="tab"][data-tab-id="boundary"]')

const queueTab = (page: Page) =>
  page.getByTestId('dock-zone-right').locator('[role="tab"][data-tab-id="queue"]')

async function widenRail(page: Page): Promise<void> {
  await page.getByTestId('rail-resize').focus()
  await page.keyboard.press('End')
  await expect(boundaryTab(page)).toBeVisible()
}

async function drillIntoOccurrence(page: Page): Promise<void> {
  await identityViewport(page)
  const activeRailTabId = await page.getByTestId('dock-zone-right')
    .locator('[role="tab"][aria-selected="true"]')
    .getAttribute('data-tab-id')
  const previousRailTab = page.getByTestId('dock-zone-right')
    .locator(`[role="tab"][data-tab-id="${activeRailTabId}"]`)
  const header = await page.evaluate(() => {
    const r = window.__dinksterTest!.renderer!
    const node = r.getScene().nodes.find((candidate) => candidate.id === 'i0')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + node.x + node.layout.width / 2,
      y: rect.top + node.y + node.layout.headerHeight / 2,
    }
  })
  await page.mouse.dblclick(header.x, header.y)
  await expect(page.getByTestId('graph-breadcrumb')).toBeVisible()
  await expect(previousRailTab).toHaveAttribute('aria-selected', 'true')
  const indicator = boundaryTab(page).getByTestId('panel-indicator')
  await expect(indicator).toBeVisible()
  await expect(indicator).toHaveAttribute('data-severity', 'info')
  await expect(indicator.locator('.visually-hidden')).toHaveText('Boundary editable for this subgraph')
  if (await boundaryTab(page).getAttribute('aria-selected') === 'false') {
    await capture(page, 'boundary-tab-highlighted-subgraph')
  }
  await openRailPanel(page, 'Boundary')
  await expect(page.getByTestId('boundary-panel')).toBeVisible()
}

/**
 * Family template: tag (optional socket), req (REQUIRED socket-only -
 * hiding it starves instance-appended members), sub (nested autogrow of
 * optional x/y).
 */
async function openBoundaryWorkflow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const socket = (id: string, optional: boolean) => ({
      kind: 'input',
      id,
      type: { kind: 'concrete', name: 'IMAGE' },
      optional,
    })
    app.registerSchemas([
      {
        type: 'GrowTest',
        displayName: 'Grow Test',
        category: 'test',
        source: 'v3',
        isOutputNode: false,
        items: [
          {
            kind: 'input',
            id: 'items',
            type: { kind: 'wildcard' },
            optional: false,
            dynamic: {
              kind: 'autogrow',
              template: [
                socket('tag', true),
                socket('req', false),
                {
                  kind: 'input',
                  id: 'sub',
                  type: { kind: 'wildcard' },
                  optional: false,
                  dynamic: {
                    kind: 'autogrow',
                    template: [socket('x', true), socket('y', true)],
                    naming: { kind: 'prefix', prefix: 'sub', min: 0, max: 4 },
                  },
                },
              ],
              naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
            },
          },
          { kind: 'input', id: 'masks_m4', type: { kind: 'concrete', name: 'MASK' }, optional: true },
          { kind: 'input', id: 'masks_m7', type: { kind: 'concrete', name: 'MASK' }, optional: true },
          { kind: 'input', id: 'image_3', type: { kind: 'concrete', name: 'IMAGE' }, optional: true },
          { kind: 'output', id: 'out0', type: { kind: 'concrete', name: 'IMAGE' } },
          { kind: 'output', id: 'MASK', type: { kind: 'concrete', name: 'MASK' } },
          ...Array.from({ length: 6 }, (_, index) => ({
            kind: 'input' as const,
            id: `dense_input_${index}`,
            displayName: `Dense input ${index + 1}`,
            type: { kind: 'concrete' as const, name: 'IMAGE' },
            optional: true,
          })),
          ...Array.from({ length: 6 }, (_, index) => ({
            kind: 'output' as const,
            id: `dense_output_${index}`,
            displayName: `Dense output ${index + 1}`,
            type: { kind: 'concrete' as const, name: index === 1 ? 'core.boolean' : 'IMAGE' },
          })),
        ],
      },
    ])
    app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'lineage-boundary-editor',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'root',
            nodes: { i0: { id: 'i0', type: '#sub', values: {} } },
            links: {},
            nets: {},
            reroutes: {},
            nextOrdinal: 100,
          },
          sub: {
            id: 'sub',
            name: 'Grower',
            nodes: { n1: { id: 'n1', type: 'GrowTest', values: {} } },
            links: {},
            nets: {},
            reroutes: {},
            boundary: {
              inputs: [
                { id: 'fwd', binds: { kind: 'family', node: 'n1', port: 'items' } },
                { id: 'workflow.input.masks_m4', binds: { kind: 'port', node: 'n1', port: 'masks_m4' } },
                { id: 'workflow.input.masks_m7', binds: { kind: 'port', node: 'n1', port: 'masks_m7' } },
                { id: 'image_3', binds: { kind: 'port', node: 'n1', port: 'image_3' } },
                ...Array.from({ length: 6 }, (_, index) => ({
                  id: `workflow.input.${'long-path-segment.'.repeat(index === 5 ? 3 : 0)}${index}`,
                  binds: { kind: 'port' as const, node: 'n1', port: `dense_input_${index}` },
                })),
              ],
              outputs: [
                { id: 'image', binds: { kind: 'port', node: 'n1', port: 'out0' } },
                { id: 'MASK', binds: { kind: 'port', node: 'n1', port: 'MASK' } },
                ...Array.from({ length: 6 }, (_, index) => ({
                  id: `workflow.output.${'long-path-segment.'.repeat(index === 5 ? 3 : 0)}${index}`,
                  binds: { kind: 'port' as const, node: 'n1', port: `dense_output_${index}` },
                })),
              ],
            },
            nextOrdinal: 100,
          },
        },
        view: {
          graphs: {
            g0: { nodes: { i0: { position: { x: 120, y: 120 } } } },
            sub: { nodes: { n1: { position: { x: 120, y: 120 } } } },
          },
        },
      },
      'BoundaryEditor',
    )
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab?.store.doc.lineage === 'lineage-boundary-editor' && 'status' in tab.store
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await widenRail(page)
  await queueTab(page).click()
  await expect(queueTab(page)).toHaveAttribute('aria-selected', 'true')
  await expect(boundaryTab(page).getByTestId('panel-indicator')).toHaveCount(0)
  await capture(page, 'boundary-tab-normal-root')
  // Drill into the definition: the panel edits definitions, not instances.
  await drillIntoOccurrence(page)
}

/** Blur the last-clicked checkbox so window-level undo keys are not
 * swallowed by the in-field guard. (The panel's own h2 is display:none
 * under the rail section host, so blur programmatically.) */
async function blurControls(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await openBoundaryWorkflow(page)
})

test('panel hidden outside definitions; family item pins to an explicit full selection', async ({ page }) => {
  const item = page.locator('[data-testid=boundary-item][data-boundary-id=fwd]')
  await expect(item).toContainText('Tracks template')
  // Port-bound items list without an exposure tree.
  await expect(page.locator('[data-testid=boundary-item][data-boundary-id=image]')).toBeVisible()
  expect(await fwdSlots(page)).toBeUndefined()

  const drilledTabId = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): { id: string } | undefined
      createWorkflow(): unknown
    }
    const drilled = app.activeTab()!.id
    app.createWorkflow()
    return drilled
  })
  await expect(boundaryTab(page).getByTestId('panel-indicator')).toHaveCount(0)
  await page.evaluate((drilled) => { window.__dinksterTest!.app.activeTabId.set(drilled) }, drilledTabId)
  await expect(boundaryTab(page).getByTestId('panel-indicator')).toBeVisible()

  const setBoundaryPlacement = (placement: 'rail' | 'floating') => page.evaluate((next) => {
    const app = window.__dinksterTest!.app as unknown as {
      panels: { setPlacement(id: string, placement: 'rail' | 'floating'): boolean }
    }
    return app.panels.setPlacement('boundary', next)
  }, placement)
  expect(await setBoundaryPlacement('floating')).toBe(true)
  const floatingBoundary = page.locator('[data-testid="floating-panel"][data-panel="boundary"]')
  await expect(floatingBoundary.getByTestId('panel-indicator')).toBeVisible()
  await expect(floatingBoundary.getByTestId('panel-indicator').locator('.visually-hidden'))
    .toHaveText('Boundary editable for this subgraph')
  expect(await setBoundaryPlacement('rail')).toBe(true)
  await expect(boundaryTab(page).getByTestId('panel-indicator')).toBeVisible()

  await page.setViewportSize({ width: 1600, height: 950 })
  await capture(page, 'after-boundary-wide')
  await page.setViewportSize({ width: 390, height: 844 })
  await capture(page, 'after-boundary-narrow')
  await page.setViewportSize({ width: 1440, height: 900 })

  await item.getByTestId('boundary-pin').click()
  expect(await fwdSlots(page)).toEqual(['req', 'sub', 'tag'])
  await expect(item).toContainText('Pinned')

  // Everything reads whole - nested slots inherit from the sub entry.
  for (const path of ['tag', 'req', 'sub', 'sub.x', 'sub.y']) {
    await expect(slotToggle(page, path)).toHaveAttribute('data-state', 'whole')
  }

  // Navigating back to the root hides the panel.
  await page.getByTestId('graph-breadcrumb').locator('.crumb').first().click()
  await expect(page.getByTestId('boundary-panel')).not.toBeVisible()
  await expect(boundaryTab(page).getByTestId('panel-indicator')).toHaveCount(0)
})

test('unchecking an inherited nested slot expands the covering entry; one undo step reverts', async ({ page }) => {
  await page.getByTestId('boundary-pin').click()
  await slotToggle(page, 'sub.x').click()
  expect(await fwdSlots(page)).toEqual(['req', 'sub.y', 'tag'])
  await expect(slotToggle(page, 'sub')).toHaveAttribute('data-state', 'narrowed')
  await expect(slotToggle(page, 'sub')).toHaveAttribute('aria-checked', 'mixed')
  await expect(slotToggle(page, 'sub.x')).toHaveAttribute('data-state', 'excluded')
  await expect(slotToggle(page, 'sub.x')).toHaveAttribute('aria-checked', 'false')
  await expect(slotToggle(page, 'sub.y')).toHaveAttribute('data-state', 'whole')
  await expect(slotToggle(page, 'sub.y')).toHaveAttribute('aria-checked', 'true')

  await blurControls(page)
  await page.keyboard.press('Control+z')
  expect(await fwdSlots(page)).toEqual(['req', 'sub', 'tag'])
  await expect(slotToggle(page, 'sub')).toHaveAttribute('data-state', 'whole')

  // Toggling a narrowed construct promotes it back to a whole entry.
  await slotToggle(page, 'sub.y').click()
  expect(await fwdSlots(page)).toEqual(['req', 'sub.x', 'tag'])
  await slotToggle(page, 'sub').click()
  expect(await fwdSlots(page)).toEqual(['req', 'sub', 'tag'])
})

test('emptying the selection is refused; hiding a required socket-only slot warns inline', async ({ page }) => {
  await page.getByTestId('boundary-pin').click()

  // Hiding req commits (commands are schema-blind) but derivation flags it.
  await slotToggle(page, 'req').click()
  expect(await fwdSlots(page)).toEqual(['sub', 'tag'])
  await expect(page.locator('[data-testid=boundary-diag][data-code="boundary.slotStarved"]')).toBeVisible()

  await slotToggle(page, 'sub').click()
  expect(await fwdSlots(page)).toEqual(['tag'])

  // Last entry: refused, no write, inline notice.
  await slotToggle(page, 'tag').click()
  await expect(page.getByTestId('boundary-notice')).toBeVisible()
  expect(await fwdSlots(page)).toEqual(['tag'])
  await page.locator('[data-testid=boundary-item][data-boundary-id=fwd]').evaluate((element) => {
    element.scrollIntoView({ block: 'center' })
  })
  await capture(page, 'after-boundary-refusal-diagnostic-wide')

  // Re-exposing req clears the starvation diagnostic with the next edit.
  await slotToggle(page, 'req').click()
  expect(await fwdSlots(page)).toEqual(['req', 'tag'])
  await expect(page.getByTestId('boundary-notice')).not.toBeVisible()
  await expect(page.locator('[data-testid=boundary-diag][data-code="boundary.slotStarved"]')).not.toBeVisible()
})

test('unpinning restores whole-template tracking', async ({ page }) => {
  await page.getByTestId('boundary-pin').click()
  await slotToggle(page, 'tag').click()
  expect(await fwdSlots(page)).toEqual(['req', 'sub'])

  await page.getByTestId('boundary-unpin').click()
  expect(await fwdSlots(page)).toBeUndefined()
  const item = page.locator('[data-testid=boundary-item][data-boundary-id=fwd]')
  await expect(item).toContainText('Tracks template')

  await blurControls(page)
  await page.keyboard.press('Control+z')
  expect(await fwdSlots(page)).toEqual(['req', 'sub'])
})

test('generated names and custom names round-trip through document persistence', async ({ page }) => {
  const panel = page.getByTestId('boundary-panel')
  const item = (id: string) => panel.locator(`[data-testid=boundary-item][data-boundary-id="${id}"]`)
  const itemName = (id: string) => item(id).locator('.boundary-name')
  const firstMask = 'workflow.input.masks_m4'

  await expect(itemName(firstMask)).toHaveText('Mask')
  await expect(itemName('workflow.input.masks_m7')).toHaveText('Mask 2')
  await expect(itemName('image_3')).toHaveText('Image')
  await expect(itemName('MASK')).toHaveText('Mask')
  await expect(item(firstMask).getByTestId('boundary-name-input')).toHaveAttribute('placeholder', 'Mask')

  await item(firstMask).scrollIntoViewIfNeeded()
  await capture(page, 'before-boundary-generated-names-wide')

  const input = item(firstMask).getByTestId('boundary-name-input')
  await input.focus()
  await expect(input).toBeFocused()
  await input.fill('Subject mask')
  await input.press('Enter')
  await expect(itemName(firstMask)).toHaveText('Subject mask')
  expect(await page.evaluate(() => {
    const scene = window.__dinksterTest!.renderer!.getScene() as unknown as {
      boundaryNodes: readonly {
        side: 'inputs' | 'outputs'
        layout: { rows: readonly { kind: string; output?: { portId: string; label: string } }[] }
      }[]
    }
    const node = scene.boundaryNodes.find((candidate) => candidate.side === 'inputs')!
    const row = node.layout.rows.find(
      (candidate) => candidate.kind === 'ports' && candidate.output?.portId === 'workflow.input.masks_m4',
    )
    return row?.output?.label
  })).toBe('Subject mask')
  await capture(page, 'after-boundary-custom-name-wide')

  await blurControls(page)
  await page.keyboard.press('Control+z')
  await expect(itemName(firstMask)).toHaveText('Mask')
  await page.keyboard.press('Control+Shift+z')
  await expect(itemName(firstMask)).toHaveText('Subject mask')

  await page.getByTestId('graph-breadcrumb').locator('.crumb').first().click()
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const doc = structuredClone(app.activeTab()!.store.doc)
    doc.lineage = 'lineage-boundary-editor-name-roundtrip'
    const diagnostics = app.openDocument(doc, 'Boundary name round-trip')
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
  })
  await drillIntoOccurrence(page)
  await expect(itemName(firstMask)).toHaveText('Subject mask')

  const persistedInput = item(firstMask).getByTestId('boundary-name-input')
  await persistedInput.fill('')
  await persistedInput.press('Enter')
  await expect(itemName(firstMask)).toHaveText('Mask')
})

test('dense and long-path content stays contained and its scroll tail remains reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = page.getByTestId('boundary-panel')
  const lastOutput = panel.locator('[data-boundary-side=outputs] [data-testid=boundary-item]').last()
  await lastOutput.scrollIntoViewIfNeeded()
  await expect(lastOutput).toHaveAttribute('data-boundary-id', /long-path-segment/)
  await expect(lastOutput.locator('.boundary-name')).toHaveText('Dense output 6')
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await lastOutput.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  const bounds = await lastOutput.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await capture(page, 'after-boundary-dense-tail-narrow')
})

test('invalid selection and unavailable schema states remain explicit', async ({ page }) => {
  const panel = page.getByTestId('boundary-panel')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.dispatch({
    command: 'boundary.setSlots',
    params: { graphId: 'sub', side: 'inputs', itemId: 'fwd', slots: ['unknown'] },
  }).ok)).toBe(true)
  const item = panel.locator('[data-testid=boundary-item][data-boundary-id=fwd]')
  await expect(item.locator('[data-code="boundary.slotUnknown"]')).toHaveAttribute('role', 'alert')
  await item.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await capture(page, 'after-boundary-invalid-selection-wide')

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      backends: { get(): Array<{ registry: { set(value: undefined): void } }> }
      backendsTick: { get(): number; set(value: number): void }
    }
    app.backends.get()[0]!.registry.set(undefined)
    app.backendsTick.set(app.backendsTick.get() + 1)
  })
  await expect(item.getByTestId('boundary-unavailable')).toHaveAttribute('role', 'status')
  await capture(page, 'after-boundary-unavailable-wide')
})

test('empty and frozen states preserve inspection semantics', async ({ page }) => {
  const panel = page.getByTestId('boundary-panel')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    ;(app as unknown as { disableWorkspaceAuthority(keepLocalTabs: boolean): void })
      .disableWorkspaceAuthority(true)
    const tab = app.activeTab()!
    const result = app.compileTab(tab)
    if (!result?.ok) throw new Error('boundary fixture compile failed')
    const ref = { connection: result.artifact.connection, prompt: 'boundary-frozen-proof' }
    app.store.register(ref, result.artifact, Date.now())
    if (!app.openExecutionView(ref)) throw new Error('boundary frozen view did not open')
    const frozen = app.activeTab()!
    frozen.graphStack.set(['g0', 'sub'])
    frozen.instancePath.set(['i0'])
  })
  await openRailPanel(page, 'Boundary')
  await expect(panel.getByTestId('boundary-frozen')).toHaveAttribute('role', 'status')
  await expect(panel.getByTestId('boundary-pin')).toBeDisabled()
  await expect(panel.getByTestId('boundary-name-input').first()).toBeDisabled()
  await expect(panel.getByTestId('boundary-unavailable')).toHaveCount(0)
  await expect(panel.getByTestId('boundary-show-on-canvas').first()).toBeEnabled()
  await capture(page, 'after-boundary-frozen-wide')

  await page.reload()
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await openBoundaryWorkflow(page)
  await page.evaluate(() => {
    type BoundItem = {
      id: string
      binds: { node: string; port: string; members?: readonly string[] }
    }
    const tab = window.__dinksterTest!.app.activeTab()! as unknown as {
      store: {
        doc: { graphs: Record<string, { boundary?: { inputs: readonly BoundItem[]; outputs: readonly BoundItem[] } }> }
        dispatch(command: unknown): { ok: boolean; diagnostics?: readonly { message: string }[] }
      }
    }
    const boundary = tab.store.doc.graphs.sub!.boundary!
    for (const side of ['inputs', 'outputs'] as const) {
      for (const item of [...boundary[side]]) {
        const outcome = tab.store.dispatch({
          command: 'boundary.unbind',
          params: {
            graphId: 'sub',
            side,
            itemId: item.id,
            node: item.binds.node,
            port: item.binds.port,
            ...(item.binds.members === undefined ? {} : { members: item.binds.members }),
          },
        })
        if (!outcome.ok) throw new Error(outcome.diagnostics?.[0]?.message ?? 'boundary unbind failed')
      }
    }
  })
  await expect(page.locator('[data-testid=boundary-empty]')).toHaveCount(2)
  await capture(page, 'after-boundary-empty-wide')
})

test('region roles and continuation settings remain occurrence-owned', async ({ page }) => {
  await page.getByTestId('graph-breadcrumb').locator('.crumb').first().click()
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const doc = structuredClone(app.activeTab()!.store.doc)
    const occurrence = doc.graphs.g0!.nodes.i0! as unknown as { region?: unknown; values: Record<string, unknown> }
    occurrence.values['workflow.input.0'] = 0
    occurrence.region = {
      kind: 'while',
      statePorts: ['workflow.input.0'],
      continueOutput: 'workflow.output.1',
      outputRoles: { 'workflow.output.0': { kind: 'state', statePort: 'workflow.input.0' } },
      maxIterations: 12,
    }
    const sibling = structuredClone(doc.graphs.g0!.nodes.i0!)
    sibling.id = 'i1'
    ;(sibling as unknown as { region?: unknown }).region = structuredClone(occurrence.region)
    doc.graphs.g0!.nodes.i1 = sibling
    doc.view!.graphs.g0!.nodes.i1 = { position: { x: 500, y: 120 } }
    const diagnostics = app.openDocument(doc, 'Boundary region proof')
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
  })
  await drillIntoOccurrence(page)
  const region = page.getByTestId('region-panel')
  await expect(region).toHaveAttribute('aria-label', 'While region settings')
  await expect(page.locator('[data-region-role=state]')).toHaveCount(2)
  await expect(page.locator('[data-region-role=continuation]')).toHaveCount(1)
  const compact = page.locator('[data-region-output=image][data-role-choice=compact]')
  await compact.click()
  await expect(compact).toHaveAttribute('aria-pressed', 'true')
  await compact.focus()
  await expect(page.getByTestId('app-tooltip')).toContainText(
    'Compact output - Collect only values produced by present iterations, without gaps.',
  )
  expect(await page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    const roleOf = (node: 'i0' | 'i1') => (doc.graphs.g0!.nodes[node] as unknown as {
      region: { outputRoles?: Record<string, unknown> }
    }).region.outputRoles?.image
    return {
      selected: roleOf('i0'),
      sibling: roleOf('i1'),
      definitionOwnsRegion: 'region' in (doc.graphs.sub as object),
    }
  })).toEqual({ selected: { kind: 'compact' }, sibling: undefined, definitionOwnsRegion: false })
  await blurControls(page)
  await page.keyboard.press('Control+z')
  await expect(compact).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Control+Shift+z')
  await expect(compact).toHaveAttribute('aria-pressed', 'true')
  await compact.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await compact.focus()
  await capture(page, 'after-boundary-region-compact-explanation-wide')
  const inputPin = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'n1')!
    const pin = node.layout.pins.find((candidate) =>
      candidate.direction === 'in' && candidate.portId === 'masks_m4')!
    const canvas = document.querySelector<HTMLElement>('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    return {
      x: canvas.left + node.x * viewport.scale + viewport.x,
      y: canvas.top + (node.y + pin.y) * viewport.scale + viewport.y,
    }
  })
  await page.mouse.move(inputPin.x, inputPin.y)
  await expect(page.getByTestId('app-tooltip')).toContainText('If absent:', { timeout: 1_500 })
  await capture(page, 'after-boundary-consumer-absence-explanation-wide')
  if (proofDir) {
    await compact.locator('xpath=ancestor::*[@data-testid="boundary-item"]')
      .screenshot({ path: join(proofDir, 'boundary-region-compact-output.png'), animations: 'disabled' })
  }
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const exported = app.exportDocument(tab.id) as typeof tab.store.doc
    const role = (exported.graphs.g0!.nodes.i0 as unknown as {
      region: { outputRoles: Record<string, unknown> }
    }).region.outputRoles.image
    const diagnostics = app.openDocument(exported, 'Compact region round-trip')
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
    const reopened = app.activeTab()!.store.doc
    return {
      role,
      reopened: (reopened.graphs.g0!.nodes.i0 as unknown as {
        region: { outputRoles: Record<string, unknown> }
      }).region.outputRoles.image,
    }
  })).toEqual({
    role: { kind: 'compact' },
    reopened: { kind: 'compact' },
  })
})
