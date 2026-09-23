import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from './fixtures.js'
import { evidencePath } from './evidence-output.js'

const proofDir = process.env['DINKSTER_EXECUTION_LOG_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

const settlePaint = (page: Page): Promise<void> => page.evaluate(() =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))

interface Seed {
  readonly execution: { readonly connection: string; readonly prompt: string }
  readonly firstNode: string
  readonly lastNode: string
}

/** Open a workflow, register a run, and feed it log events plus one error report. */
async function seedRun(page: Page): Promise<Seed> {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  const seed = await page.evaluate(() => {
    const bridge = window.__dinksterTest!
    bridge.app.registerSchemas([
      {
        type: 'EmptyImage', displayName: 'Empty Image', category: 'e2e', source: 'e2e', isOutputNode: false,
        items: [{ kind: 'output', id: 'out0', type: { kind: 'concrete', name: 'IMAGE' } }],
      },
      {
        type: 'ImageScaleBy', displayName: 'Scale Image', category: 'e2e', source: 'e2e', isOutputNode: false,
        items: [
          { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
          { kind: 'output', id: 'out0', type: { kind: 'concrete', name: 'IMAGE' } },
        ],
      },
      {
        type: 'PreviewImage', displayName: 'Preview Image', category: 'e2e', source: 'e2e', isOutputNode: true,
        items: [{ kind: 'input', id: 'images', type: { kind: 'concrete', name: 'IMAGE' }, optional: false }],
      },
    ])
    const diagnostics = bridge.app.openDocument(
      bridge.syntheticWorkflow({ chains: 1, chainLength: 4, reroutes: false }),
      'Execution log proof',
    )
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
    const tab = bridge.app.activeTab()!
    const nodeIds = Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes)
    const connection = bridge.app.backends.get()[0]!.id
    const execution = { connection, prompt: 'execution-log-proof-run' }
    type Artifact = Parameters<typeof bridge.app.store.register>[1]
    const app = bridge.app as typeof bridge.app & {
      compileTabCached(candidate: typeof tab): { ok: true; artifact: Artifact } | { ok: false } | undefined
    }
    const compiled = app.compileTabCached(tab)
    if (compiled === undefined || !compiled.ok) throw new Error(`compile failed: ${JSON.stringify(compiled)}`)
    app.store.register(execution as never, compiled.artifact, Date.now())
    const base = Date.now()
    const apply = (event: Record<string, unknown>): void => bridge.app.store.apply(event as never)
    apply({ kind: 'started', execution, timestamp: base })
    apply({
      kind: 'log', execution, timestamp: base + 1, level: 'info',
      message: 'loading checkpoint shards', runtimeNodeId: nodeIds[0]!,
      origin: 'logging', logger: 'dinkster.engine', seq: 1,
    })
    apply({
      kind: 'log', execution, timestamp: base + 2, level: 'warning',
      message: 'low free vram, enabling attention slicing', seq: 2,
    })
    apply({
      kind: 'log', execution, timestamp: base + 3, level: 'info',
      message: 'denoising step batch complete', runtimeNodeId: nodeIds[2]!,
      origin: 'stdout', seq: 3,
    })
    apply({
      kind: 'error', execution, timestamp: base + 4, runtimeNodeId: nodeIds[2]!,
      detail: {
        exceptionType: 'RuntimeError',
        exceptionMessage: 'CUDA out of memory while decoding latents',
        traceback: ['Traceback (most recent call last):', 'RuntimeError: CUDA out of memory'],
      },
    })
    return { execution, firstNode: nodeIds[0]!, lastNode: nodeIds[2]! }
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })
  return seed
}

test('execution log panel shows live records and changes mounted chrome locale', async ({ page, request }) => {
  let objectInfoRequests = 0
  page.on('request', (event) => {
    if (new URL(event.url()).pathname === '/object_info') objectInfoRequests += 1
  })
  await page.setViewportSize({ width: 1600, height: 1000 })
  const seed = await seedRun(page)
  await page.getByTestId('execution-log-toggle').click()
  await expect(page.getByTestId('execution-log-panel')).toBeVisible()

  const rows = page.getByTestId('execution-log-row')
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(0)).toContainText('loading checkpoint shards')
  await expect(rows.nth(1)).toContainText('low free vram, enabling attention slicing')
  await expect(rows.nth(3)).toContainText('CUDA out of memory while decoding latents')
  // The error row is the run's error report (the same diagnostic that badges
  // the node), projected into the feed - not a separate error log record.
  await expect(rows.nth(3)).toHaveAttribute('data-source', 'diagnostic')
  await expect(rows.nth(3)).toHaveAttribute('data-level', 'error')
  await expect(rows.nth(0)).toHaveAttribute('data-origin', 'logging')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('app-tooltip')).toHaveCount(0)
  await page.getByTestId('execution-log-panel').screenshot({ path: evidencePath('issue-457', 'execution-log-i18n-en.png'), animations: 'disabled' })

  if (proofDir) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.mouse.move(1000, 80)
    await page.screenshot({ path: join(proofDir, '01-execution-log-panel.png'), animations: 'disabled', fullPage: true })
  }

  // Hiding info keeps the warning and the diagnostic-backed error row.
  await page.getByTestId('execution-log-level-info').click()
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toHaveAttribute('data-level', 'warning')
  await expect(rows.nth(1)).toHaveAttribute('data-level', 'error')
  if (proofDir) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.mouse.move(1000, 80)
    await page.screenshot({ path: join(proofDir, '02-level-filter.png'), animations: 'disabled', fullPage: true })
  }
  await page.getByTestId('execution-log-level-info').click()
  await expect(rows).toHaveCount(4)

  // Node filter narrows to one node's records, log and error alike.
  await page.getByTestId('execution-log-node-select').click()
  await page.locator(`[role="option"][data-option-id="${seed.lastNode}"]`).click()
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('denoising step batch complete')
  await expect(rows.nth(1)).toHaveAttribute('data-source', 'diagnostic')
  const objectInfoRequestsBeforeLocaleChange = objectInfoRequests
  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'executionLog.aria.contents': '[Ausfuhrungsprotokoll]',
      'executionLog.aria.levelFilters': '[Stufenfilter]',
      'executionLog.aria.records': '[Protokolleintrage]',
      'executionLog.field.node': '[Knoten]',
      'executionLog.field.run': '[Lauf]',
      'executionLog.level.error': '[FEHLER]',
      'executionLog.level.info': '[INFO]',
      'executionLog.level.warning': '[WARNUNG]',
      'executionLog.option.allNodes': '[Alle Knoten]',
      'executionLog.option.current': '[Aktuell]',
      'executionLog.run.label': '[{prompt} :: {status}]',
      'executionLog.status.error': '[STATUS-FEHLER]',
      'executionLog.title.showNode': '[Knoten {id} auf Leinwand zeigen]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })
  const panel = page.getByTestId('execution-log-panel')
  await expect(panel).toHaveAttribute('aria-label', '[Ausfuhrungsprotokoll]')
  await expect(page.getByTestId('execution-log-list')).toHaveAttribute('aria-label', '[Protokolleintrage]')
  await expect(page.getByTestId('execution-log-node-select')).toHaveAttribute('data-selected-id', seed.lastNode)
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('denoising step batch complete')
  await expect(rows.nth(1)).toContainText('CUDA out of memory while decoding latents')
  await expect(rows.nth(0)).toHaveAttribute('data-origin', 'stdout')
  await expect(rows.nth(1)).toHaveAttribute('data-level', 'error')
  await expect(page.getByTestId('execution-log-node').first()).toHaveAttribute('title', `[Knoten ${seed.lastNode} auf Leinwand zeigen]`)
  await page.getByTestId('execution-log-run-select').click()
  await expect(page.getByRole('option').filter({ hasText: seed.execution.prompt }))
    .toHaveText(`[${seed.execution.prompt} :: [STATUS-FEHLER]]`)
  await page.keyboard.press('Escape')
  await settlePaint(page)
  expect(objectInfoRequests).toBe(objectInfoRequestsBeforeLocaleChange)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('app-tooltip')).toHaveCount(0)
  await panel.screenshot({ path: evidencePath('issue-457', 'execution-log-i18n-de-DE.png'), animations: 'disabled' })

  // A row's node chip focuses that node on canvas (diagnostic focus path).
  await page.getByTestId('execution-log-node').first().click()
  await settlePaint(page)
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')
})

test('tail follow pauses on scroll-up and resumes from the jump button', async ({ page }) => {
  const seed = await seedRun(page)
  await page.getByTestId('execution-log-toggle').click()
  await expect(page.getByTestId('execution-log-panel')).toBeVisible()

  await page.evaluate(({ execution }) => {
    const base = Date.now()
    for (let index = 0; index < 60; index += 1) {
      window.__dinksterTest!.app.store.apply({
        kind: 'log', execution, timestamp: base + index, level: 'info',
        message: `sampler step ${index + 1}/60 complete`, seq: 10 + index,
      } as never)
    }
  }, seed)
  const rowCount = 64
  await expect(page.getByTestId('execution-log-row')).toHaveCount(rowCount)

  const list = page.getByTestId('execution-log-list')
  const atTail = () => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 8)
  expect(await atTail()).toBe(true)
  await expect(page.getByTestId('execution-log-resume')).toHaveCount(0)

  // Scrolling up disengages tail follow: new records no longer move the view.
  await list.evaluate((el) => { el.scrollTop = 0 })
  await expect(page.getByTestId('execution-log-resume')).toBeVisible()
  await page.evaluate(({ execution }) => {
    window.__dinksterTest!.app.store.apply({
      kind: 'log', execution, timestamp: Date.now(), level: 'warning',
      message: 'appended while scrolled up', seq: 99,
    } as never)
  }, seed)
  await expect(page.getByTestId('execution-log-row')).toHaveCount(rowCount + 1)
  expect(await list.evaluate((el) => el.scrollTop)).toBeLessThan(50)

  await page.getByTestId('execution-log-resume').click()
  await expect(page.getByTestId('execution-log-resume')).toHaveCount(0)
  expect(await atTail()).toBe(true)
})

/** Page coordinates inside the FIRST below-lane badge on a scene node. */
async function bottomBadgePoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nodeId) => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const node = r.getScene().nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error(`no scene node '${nodeId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    // Mirrors badgeRect() for placement 'below': the lane starts at the
    // node's left edge on its bottom edge; 8,7 lands inside the first badge.
    return {
      x: rect.left + (node.x + 8) * vp.scale + vp.x,
      y: rect.top + (node.y + node.layout.height + 7) * vp.scale + vp.y,
    }
  }, nodeId)
}

test('bottom badges expose the run error report and log records per node', async ({ page }) => {
  const seed = await seedRun(page)
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await settlePaint(page)

  // The errored node carries its error tab on the bottom edge.
  const errorPoint = await bottomBadgePoint(page, seed.lastNode)
  await page.mouse.click(errorPoint.x, errorPoint.y)
  const popover = page.getByTestId('badge-popover')
  await expect(popover).toBeVisible()
  await expect(popover).toHaveAttribute('data-badge', 'core.error')
  await expect(popover.getByTestId('badge-error-detail')).toContainText('CUDA out of memory while decoding latents')

  // Open in Execution log pre-filters the panel to the node's rows.
  await popover.getByTestId('badge-open-execution-log').hover()
  await page.mouse.down()
  await page.mouse.up()
  await expect(popover).not.toBeVisible()
  await expect(page.getByTestId('execution-log-panel')).toBeVisible()
  await expect(page.getByTestId('execution-log-node-select')).toHaveAttribute('data-selected-id', seed.lastNode)
  const rows = page.getByTestId('execution-log-row')
  await expect(rows).toHaveCount(2)

  // The info-logging node carries the compact info dot; its popover lists
  // the run's records for that node.
  const infoPoint = await bottomBadgePoint(page, seed.firstNode)
  await page.mouse.click(infoPoint.x, infoPoint.y)
  await expect(popover).toBeVisible()
  await expect(popover).toHaveAttribute('data-badge', 'core.log.info')
  await expect(popover.getByTestId('badge-log-entry')).toContainText('loading checkpoint shards')

  // Dismissing the error badge hides it; the error report is untouched.
  await page.mouse.click(errorPoint.x, errorPoint.y)
  await expect(popover).toHaveAttribute('data-badge', 'core.error')
  await popover.getByTestId('badge-dismiss-error').hover()
  await page.mouse.down()
  await page.mouse.up()
  await expect(popover).not.toBeVisible()
  await settlePaint(page)
  // The lane is left-aligned, so the node's info dot takes the freed slot:
  // clicking the same point now opens the info popover, not the error one.
  await page.mouse.click(errorPoint.x, errorPoint.y)
  await expect(popover).toBeVisible()
  await expect(popover).toHaveAttribute('data-badge', 'core.log.info')
  const errorCount = await page.evaluate(({ execution }) => {
    const state = [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((entry) => entry.ref.prompt === execution.prompt)
    return state?.errors.length ?? 0
  }, seed)
  expect(errorCount).toBe(1)
})
