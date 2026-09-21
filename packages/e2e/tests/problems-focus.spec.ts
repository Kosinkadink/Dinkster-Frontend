import { expect, openRailPanel, test } from './fixtures.js'
import { evidencePath } from './evidence-output.js'


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
        type: 'ProblemSource', displayName: 'Problem Source', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'IMAGE' } }],
      },
      {
        type: 'ProblemTarget', displayName: 'Problem Target', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'input', type: { kind: 'concrete', name: 'INT' }, optional: false }],
      },
    ])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'problems-focus', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        source: { id: 'source', type: 'ProblemSource', values: {} },
        target: { id: 'target', type: 'ProblemTarget', values: {} },
      }, links: {
        bad: { id: 'bad', from: { node: 'source', port: 'out' }, to: { node: 'target', port: 'input' } },
      }, nets: {}, reroutes: {}, nextOrdinal: 3 } },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 40, y: 80 } },
        target: { position: { x: 1200, y: 500 } },
      } } } },
    }, 'Problems Focus')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await openRailPanel(page, 'Problems')
})

test('explicit Show on canvas centers and selects a warned node', async ({ page }) => {
  const row = page.getByTestId('problems-panel')
    .locator('details.problem[data-activatable="true"]', { hasText: /solve\./ }).first()
  await expect(row).toBeVisible()
  await row.locator('summary').click()
  await expect(row).toHaveAttribute('open', '')
  await row.getByRole('button', { name: 'Show on canvas' }).click()

  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')
  await expect.poll(() => page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'target')!
    const viewport = renderer.getViewport()
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return Math.hypot(
      (node.x + node.layout.width / 2) * viewport.scale + viewport.x - canvas.width / 2,
      (node.y + node.layout.height / 2) * viewport.scale + viewport.y - canvas.height / 2,
    )
  })).toBeLessThan(2)
})

test('Problems locale, disclosure, selection, clipboard, and explicit canvas action remain independent', async ({ context, page, request }) => {
  let objectInfoRequests = 0
  let diagnosticRequests = 0
  page.on('request', (event) => {
    const path = new URL(event.url()).pathname
    if (path === '/object_info') objectInfoRequests += 1
    if (path === '/api/diagnostics') diagnosticRequests += 1
  })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.reportProblems(app.activeTab()!.id, [
      {
        severity: 'error', source: 'runtime', code: 'runtime.browserProof',
        message: 'A long selectable browser proof error message.',
        refs: [{ graphId: 'g0', nodeId: 'source' }],
        anchor: { occurrence: { instancePath: [], node: 'source' } },
        runtime: {
          exceptionType: 'BrowserProofError', exceptionMessage: 'browser proof failed',
          hints: [{ code: 'repair', message: 'Select this runtime hint with the mouse.', suggestion: 'Keep browser copy native.' }],
          traceback: ['Traceback line one', 'Traceback line two'],
        },
      },
      {
        severity: 'warning', source: 'runtime', code: 'runtime.warningProof',
        message: 'Warning with nested guidance.',
        refs: [{ graphId: 'g0', nodeId: 'target', portId: 'input', direction: 'input' }],
        anchor: { port: { node: 'target', port: 'input' } },
        runtime: {
          exceptionType: 'BrowserProofWarning', exceptionMessage: 'warning proof',
          hints: [{ code: 'warning-help', message: 'Nested warning guidance is fully disclosed.' }],
          traceback: ['Warning traceback'],
        },
      },
    ])
    const backend = app.backends.get()[0]! as unknown as {
      readonly compatSkips: { set(value: readonly { packId: string; nodeId: string; reason: string }[]): void }
    }
    backend.compatSkips.set([{
      packId: 'raw-pack', nodeId: 'RawNode', reason: 'raw compatibility refusal',
    }])
  })

  const panel = page.getByTestId('problems-panel')
  const error = panel.locator('details.problem', { hasText: 'runtime.browserProof' })
  const warning = panel.locator('details.problem', { hasText: 'runtime.warningProof' })
  await error.locator('summary').click()
  await warning.locator('summary').click()
  await expect(error).toHaveAttribute('open', '')
  await expect(error.locator('.runtime-error-hints')).toContainText('Keep browser copy native.')
  await expect(error.locator('.traceback')).toContainText('Traceback line two')
  await expect(warning).toHaveAttribute('open', '')
  await expect(warning.locator('.runtime-error-hints')).toContainText('Nested warning guidance is fully disclosed.')
  await expect(warning.locator('.traceback')).toContainText('Warning traceback')
  const compatSkips = panel.locator('.compat-skips-group')
  await expect(compatSkips).toContainText('raw-pack: RawNode')
  await expect(compatSkips).toContainText('raw compatibility refusal')
  await warning.locator('summary').click()
  await expect(warning).not.toHaveAttribute('open', '')
  await warning.locator('summary').click()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('app-tooltip')).toHaveCount(0)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await panel.screenshot({ path: evidencePath('issue-457', 'problems-static-i18n-en.png'), animations: 'disabled' })

  const errorSummary = error.locator('summary')
  await errorSummary.evaluate((summary) => {
    const range = document.createRange()
    range.selectNodeContents(summary)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString() ?? '')).toContain('runtime.browserProof')
  await expect(error).toHaveAttribute('open', '')
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '0')

  await panel.evaluate((element) => { element.dataset['localeIdentity'] = 'panel' })
  await error.evaluate((element) => { element.dataset['localeIdentity'] = 'error' })
  await error.locator('.runtime-error-hint').evaluate((element) => { element.dataset['localeIdentity'] = 'hint' })
  const objectInfoRequestsBeforeLocaleChange = objectInfoRequests
  const diagnosticRequestsBeforeLocaleChange = diagnosticRequests
  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'shell.panel.problems.title': '[Probleme]',
      'problems.action.showInFocused': '[Im Fokus zeigen]',
      'problems.action.showOnCanvas': '[Auf Leinwand zeigen]',
      'problems.compat.advisory': '[HINWEIS]',
      'problems.compat.description': '[Nicht in den Katalog aufgenommen.]',
      'problems.compat.title': '[Kompatibilitatssprunge]',
      'problems.empty': '[Keine Probleme.]',
      'problems.hint.code': '[Diagnosecode: {code}]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })
  await expect(panel.locator('h2')).toHaveText('[Probleme]')
  await expect(error.getByRole('button', { name: '[Auf Leinwand zeigen]' })).toBeVisible()
  await expect(error.getByRole('button', { name: '[Im Fokus zeigen]' })).toBeVisible()
  await expect(error.locator('.runtime-error-hint-code')).toHaveAttribute('aria-label', '[Diagnosecode: repair]')
  await expect(compatSkips).toHaveAttribute('aria-label', '[Kompatibilitatssprunge]')
  await expect(compatSkips.locator('.problems-group-title')).toHaveText('[Kompatibilitatssprunge]')
  await expect(compatSkips.locator('.problems-group-severity')).toHaveText('[HINWEIS]')
  await expect(compatSkips.locator('.compat-skips-explanation')).toHaveText('[Nicht in den Katalog aufgenommen.]')
  await expect(panel).toHaveAttribute('data-locale-identity', 'panel')
  await expect(error).toHaveAttribute('data-locale-identity', 'error')
  await expect(error.locator('.runtime-error-hint')).toHaveAttribute('data-locale-identity', 'hint')
  await expect(error).toHaveAttribute('open', '')
  await expect(error).toContainText('runtime.browserProof')
  await expect(error).toContainText('A long selectable browser proof error message.')
  await expect(error).toContainText('Keep browser copy native.')
  await expect(compatSkips).toContainText('raw-pack: RawNode')
  await expect(compatSkips).toContainText('raw compatibility refusal')
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString() ?? '')).toContain('runtime.browserProof')
  await page.waitForTimeout(50)
  expect(objectInfoRequests).toBe(objectInfoRequestsBeforeLocaleChange)
  expect(diagnosticRequests).toBe(diagnosticRequestsBeforeLocaleChange)

  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>('[data-testid="graph-canvas"]')!
    canvas.focus()
    if (document.activeElement !== canvas) throw new Error('canvas did not take focus')
  })
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString() ?? '')).toContain('runtime.browserProof')

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('runtime.browserProof')
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '0')
  await page.evaluate(() => document.getSelection()?.removeAllRanges())
  await panel.screenshot({ path: evidencePath('issue-457', 'problems-static-i18n-de-DE.png'), animations: 'disabled' })

  await error.locator('summary').click()
  await expect(error).not.toHaveAttribute('open', '')
  await error.locator('summary').click()
  await error.getByRole('button', { name: '[Auf Leinwand zeigen]' }).click()
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')

  await page.evaluate(() => {
    document.getSelection()?.removeAllRanges()
    window.__dinksterTest!.controller!.setSelection(['target'], [], [])
    document.querySelector<HTMLElement>('[data-testid="graph-canvas"]')!.focus()
  })
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toContain('runtime.browserProof')
})

test('hover a warned pin shows every diagnostic severity and message', async ({ page }) => {
  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'target')!
    const pin = node.layout.pins.find((candidate) => candidate.portId === 'input')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    // The fixture places 'target' far from the origin, outside the visible
    // canvas at the seeded viewport; center it so the pin is hoverable.
    renderer.setViewport({
      x: canvas.width / 2 - (node.x + node.layout.width / 2),
      y: canvas.height / 2 - (node.y + node.layout.height / 2),
      scale: 1,
    })
    const viewport = renderer.getViewport()
    return {
      x: canvas.left + node.x * viewport.scale + viewport.x,
      y: canvas.top + (node.y + pin.y) * viewport.scale + viewport.y,
    }
  })
  await page.mouse.move(point.x, point.y)
  await expect(page.getByTestId('app-tooltip')).toContainText(/\[(warning|error)\]/, { timeout: 1_500 })
  await expect(page.getByTestId('app-tooltip')).toContainText(/type|match|compatible/i)
})
