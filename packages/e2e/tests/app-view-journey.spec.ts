import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from './fixtures.js'
import { evidencePath, evidenceGroupDir } from './evidence-output.js'


async function registerSchema(page: Page): Promise<void> {
  await page.evaluate(() => {
    const widget = (id: string, widgetType: string, defaultValue: unknown, options: Record<string, unknown> = {}) => ({
      kind: 'input', id, type: { kind: 'concrete', name: widgetType }, optional: false,
      widget: { widgetType, options, default: defaultValue },
    })
    window.__dinksterTest!.app.registerSchemas([{
      type: 'AppViewJourneyTest', displayName: 'Portrait Studio', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        widget('prompt', 'STRING', 'portrait'),
        widget('steps', 'INT', 20, { min: 1, max: 100, step: 1 }),
      ],
    }])
  })
}

async function openJourneyDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'app-view-complete-journey', root: 'g0',
      meta: { title: 'Portrait Studio', description: 'Create a finished portrait without opening the graph.' },
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { widgets: { id: 'widgets', type: 'AppViewJourneyTest', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      } },
      view: { graphs: { g0: { nodes: { widgets: { position: { x: 100, y: 80 }, size: { width: 460, height: 420 } } } } } },
    }, 'Portrait Studio')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === 'app-view-complete-journey')
    return tab !== undefined && 'status' in tab.store
  })
}

async function selectAppView(page: Page): Promise<void> {
  if (await page.getByTestId('app-view').count()) return
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
}

async function canvasPoint(page: Page, target: 'prompt' | 'steps' | 'preview'): Promise<{ x: number; y: number }> {
  return page.evaluate((kind) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'widgets')!
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    const bounds = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const local = kind === 'preview'
      ? node.layout.preview!
      : node.layout.rows.find((row) => row.kind === 'widget' && row.inputId === kind)!
    return {
      x: bounds.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: bounds.top + (node.y + local.y + local.height / 2) * viewport.scale + viewport.y,
    }
  }, target)
}

async function exposeInput(page: Page, inputId: 'prompt' | 'steps'): Promise<void> {
  const point = await canvasPoint(page, inputId)
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await page.locator('[data-item-id="core.widget.expose.toggle"]').click()
}

async function exposePreview(page: Page): Promise<void> {
  const point = await canvasPoint(page, 'preview')
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await page.locator('[data-item-id="core.node.preview.expose.toggle"]').click()
}

async function injectPreview(page: Page, label: string): Promise<void> {
  await page.evaluate(async (text) => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = { connection: compiled.artifact.connection, prompt: `app-view-journey-${text}` }
    const store = app.store as unknown as {
      register(ref: unknown, artifact: unknown, now: number): void
      apply(event: unknown): void
    }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    store.apply({
      kind: 'nodeStates', execution: ref, timestamp: Date.now(),
      nodes: { widgets: { state: 'running' } },
    })
    const canvas = new OffscreenCanvas(640, 360)
    const context = canvas.getContext('2d')!
    const gradient = context.createLinearGradient(0, 0, 640, 360)
    gradient.addColorStop(0, '#0f766e')
    gradient.addColorStop(1, '#4338ca')
    context.fillStyle = gradient
    context.fillRect(0, 0, 640, 360)
    context.fillStyle = '#ffffff'
    context.font = '600 40px sans-serif'
    context.textAlign = 'center'
    context.fillText(text, 320, 195)
    const payload = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()
    store.apply({
      kind: 'preview', execution: ref, timestamp: Date.now(),
      runtimeNodeId: 'widgets', channel: 'image/png', payload,
    })
  }, label)
}

async function setEditorWidth(page: Page, width: number): Promise<void> {
  await page.locator('.canvas-stage').evaluate((element, nextWidth) => {
    element.style.width = `${nextWidth}px`
  }, width)
  await expect(page.getByTestId('app-view')).toHaveAttribute(
    'data-app-breakpoint',
    width < 640 ? 'mobile' : 'desktop',
  )
}

async function renamePlacement(page: Page, currentLabel: string, nextLabel: string): Promise<void> {
  const row = page.getByTestId('app-view-row').filter({
    has: page.getByTestId('app-view-label').filter({ hasText: currentLabel }),
  })
  await row.getByTestId('app-view-rename-start').click()
  await page.getByTestId('app-view-rename').fill(nextLabel)
  await page.getByTestId('app-view-rename').press('Enter')
}

test('authors, uses, and reloads a complete App View', async ({ page }) => {
  mkdirSync(evidenceGroupDir('issue-21'), { recursive: true })
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await registerSchema(page)
  await openJourneyDocument(page)
  await injectPreview(page, 'Portrait result')

  await exposeInput(page, 'prompt')
  await exposeInput(page, 'steps')
  await exposePreview(page)
  await selectAppView(page)
  await expect(page.getByTestId('app-view-row')).toHaveCount(2)
  await expect(page.getByTestId('app-preview-row')).toHaveCount(1)

  await page.getByTestId('app-view-arrange-toggle').click()
  await renamePlacement(page, 'prompt', 'Prompt')
  await renamePlacement(page, 'steps', 'Steps')
  await page.getByTestId('app-preview-rename-start').click()
  await page.getByTestId('app-preview-rename').fill('Result')
  await page.getByTestId('app-preview-rename').press('Enter')

  await page.getByTestId('app-layout-add-text').click()
  await page.getByTestId('app-layout-text-input').fill('Create a **finished portrait** with the controls below.')
  await page.getByTestId('app-layout-text-input').blur()
  await page.getByTestId('app-layout-text-role').selectOption('heading')
  await page.getByTestId('app-layout-add-group').click()
  await page.getByTestId('app-layout-group-title').fill('Controls')
  await page.getByTestId('app-layout-group-title').blur()
  const promptRow = page.getByTestId('app-view-row').filter({
    has: page.getByTestId('app-view-label').filter({ hasText: /^Prompt/ }),
  })
  await promptRow.getByTestId('app-layout-parent').selectOption({ label: 'Controls' })

  await page.getByRole('button', { name: /Place Create a \*\*finished portrait\*\*/ }).click()
  await page.getByRole('button', { name: 'Place Controls in grid' }).click()
  await page.getByRole('button', { name: 'Place Steps in grid' }).click()
  await page.getByRole('button', { name: 'Place Result in grid' }).click()
  await page.setViewportSize({ width: 1440, height: 1300 })
  await page.evaluate(() => {
    const store = window.__dinksterTest!.app.activeTab()!.store
    const items = (store.doc.ext?.['dinkster.appLayout'] as { desktop: { items: Array<Record<string, unknown>> } }).desktop.items
    const byKind = (kind: string) => items.find((item) => item.kind === kind)!
    const byControl = (inputId: string) => items.find((item) =>
      item.kind === 'control' && (item.ref as { inputId?: string }).inputId === inputId)!
    store.dispatch({ command: 'app.layout.setGrid', params: { id: byKind('text').id, grid: { x: 0, y: 0, w: 12, h: 4 } } })
    store.dispatch({ command: 'app.layout.setGrid', params: { id: byKind('group').id, grid: { x: 0, y: 4, w: 5, h: 4 } } })
    store.dispatch({ command: 'app.layout.setGrid', params: { id: byControl('steps').id, grid: { x: 5, y: 4, w: 7, h: 3 } } })
    store.dispatch({ command: 'app.layout.setGrid', params: { id: byKind('preview').id, grid: { x: 5, y: 7, w: 7, h: 5 } } })
  })
  await page.getByTestId('app-view').evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: evidencePath('issue-21', 'app-grid-arrange.png'), animations: 'disabled' })

  await page.getByTestId('app-layout-breakpoint-mobile').click()
  const mobileResult = page.getByRole('listitem', { name: /Mobile placement: Result/ })
  await mobileResult.getByRole('button', { name: 'Move Result up in mobile layout' }).click()
  await mobileResult.getByRole('button', { name: 'Move Result up in mobile layout' }).click()
  await expect(page.getByTestId('app-layout-reset-mobile')).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 1700 })
  await page.getByTestId('app-view').evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: evidencePath('issue-21', 'app-mobile-arrange.png'), animations: 'disabled' })

  await page.evaluate(() => {
    const store = window.__dinksterTest!.app.activeTab()!.store
    const items = (store.doc.ext?.['dinkster.appLayout'] as { desktop: { items: Array<Record<string, unknown>> } }).desktop.items
    const byKind = (kind: string) => items.find((item) => item.kind === kind)!
    const byControl = (inputId: string) => items.find((item) =>
      item.kind === 'control' && (item.ref as { inputId?: string }).inputId === inputId)!
    store.dispatch({ command: 'app.layout.setGrid', params: { id: byKind('text').id, grid: { x: 0, y: 0, w: 12, h: 1 } } })
    store.dispatch({ command: 'app.layout.setGrid', params: { id: byKind('group').id, grid: { x: 0, y: 1, w: 5, h: 3 } } })
    store.dispatch({ command: 'app.layout.setGrid', params: { id: byControl('steps').id, grid: { x: 5, y: 1, w: 7, h: 2 } } })
    store.dispatch({ command: 'app.layout.setGrid', params: { id: byKind('preview').id, grid: { x: 5, y: 3, w: 7, h: 4 } } })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('app-view-arrange-toggle').click()
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'desktop')
  await page.getByRole('textbox', { name: 'Prompt' }).fill('cinematic portrait')
  await page.getByRole('textbox', { name: 'Prompt' }).blur()
  await page.getByTestId('app-view').evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: evidencePath('issue-21', 'app-grid-use-mixed-flow.png'), animations: 'disabled' })

  await page.setViewportSize({ width: 1440, height: 1100 })
  await setEditorWidth(page, 600)
  await page.getByTestId('app-view').evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: evidencePath('issue-21', 'app-mobile-use-narrow.png'), animations: 'disabled' })

  const popupPromise = page.waitForEvent('popup')
  await page.getByTestId('tab-bar').locator('.tab', { hasText: 'Portrait Studio' }).click({ button: 'right' })
  await page.getByTestId('context-menu').locator('[data-item-id="workflow.openWindow"]').click()
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded')
  await expect(popup.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await registerSchema(popup)
  await injectPreview(popup, 'Pop-out result')
  await popup.setViewportSize({ width: 560, height: 1100 })
  if (await popup.getByTestId('rail-toggle').getAttribute('aria-pressed') === 'true') {
    await popup.getByTestId('rail-toggle').click()
  }
  await expect(popup.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'mobile')
  await expect(popup.getByRole('img', { name: 'Image preview' })).toBeVisible()
  await popup.mouse.move(300, 300)
  await popup.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await popup.waitForTimeout(500)
  await popup.screenshot({ path: evidencePath('issue-21', 'app-mobile-use-popout.png'), animations: 'disabled' })
  await popup.close()

  const restoredTab = page.getByRole('tab', { name: /Portrait Studio/ })
  await expect(restoredTab).toBeVisible()
  await restoredTab.click()
  await page.waitForFunction(() => window.__dinksterTest!.app.activeTab()?.id === 'app-view-complete-journey')
  await page.evaluate(() => {
    ;(window.__dinksterTest!.app as unknown as { flushPersistTabs(): void }).flushPersistTabs()
  })
  const beforeReload = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)
  await page.reload()
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await registerSchema(page)
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === 'app-view-complete-journey')
    return tab !== undefined && 'status' in tab.store
  })
  await selectAppView(page)
  await injectPreview(page, 'Reloaded result')
  await expect(page.getByTestId('app-view-arrange-toggle')).toHaveAttribute('aria-pressed', 'false')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)).toEqual(beforeReload)
  await expect(page.getByTestId('app-layout-grid-placement')).toHaveCount(4)
  await expect(page.getByTestId('app-layout-group')).toContainText('Controls')
  await expect(page.getByTestId('app-layout-text')).toContainText('finished portrait')
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('cinematic portrait')
  expect(await page.evaluate(() => {
    const layout = window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'] as {
      mobile: { customized: boolean; order: string[] }
    }
    return layout.mobile.customized && layout.mobile.order.length === 4
  })).toBe(true)
})
