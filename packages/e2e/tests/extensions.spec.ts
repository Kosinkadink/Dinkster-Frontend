/**
 * Per-contribution gating (architecture section 11): a pack installs
 * through the public manifest API, its features show up in the Extensions
 * panel, and every one is individually toggleable - a disabled menu
 * contribution vanishes from the context menu and returns when re-enabled,
 * with no pack code involved in either direction. Gate overrides persist
 * across reloads. Host/registry mechanics (categories, policy, refusals)
 * are unit-tested in core; this proves the user-visible wiring.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { expect, openRailPanel, test, type Page } from './fixtures.js'
import { evidencePath } from './evidence-output.js'

const xy = (p: { x: number; y: number }): [number, number] => [p.x, p.y]
const editorProofDir = process.env['DINKSTER_EXTENSION_EDITOR_PROOF_DIR']

async function captureEditorProof(page: Page, name: string): Promise<void> {
  if (editorProofDir === undefined) return
  mkdirSync(editorProofDir, { recursive: true })
  await page.screenshot({ path: `${editorProofDir}/${name}.png`, animations: 'disabled' })
}

async function expectStatusBarContained(page: Page): Promise<void> {
  const status = page.getByTestId('status-bar')
  expect(await status.evaluate((footer) => {
    const bounds = footer.getBoundingClientRect()
    const entries = Array.from(footer.querySelectorAll('.host-ui-text, .host-ui-status, .statusbar-backend, .statusbar-toggle'), (element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return { text: element.textContent, rects: Array.from(range.getClientRects()) }
    })
    const overlapping: string[] = []
    for (const [index, entry] of entries.entries()) {
      for (const other of entries.slice(index + 1)) {
        if (entry.rects.some((a) => other.rects.some((b) =>
          Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)))) {
          overlapping.push(`${entry.text} / ${other.text}`)
        }
      }
    }
    return {
      overlapping,
      outsideFooter: entries.filter((entry) => entry.rects.some((rect) =>
        rect.left < bounds.left || rect.right > bounds.right || rect.top < bounds.top || rect.bottom > bounds.bottom)).map((entry) => entry.text),
      horizontalOverflow: footer.scrollWidth > footer.clientWidth || document.documentElement.scrollWidth > window.innerWidth,
    }
  })).toEqual({ overlapping: [], outsideFooter: [], horizontalOverflow: false })
}

/** Page coordinates of a node's header center (assumes identity viewport). */
async function headerPoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nodeId) => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const node = r.getScene().nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error(`no scene node '${nodeId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * vp.scale + vp.x,
      y: rect.top + (node.y + node.layout.headerHeight / 2) * vp.scale + vp.y,
    }
  }, nodeId)
}

async function widgetPoint(page: Page, nodeId: string, inputId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, inputId }) => {
    const renderer = window.__dinksterTest!.renderer!
    const viewport = renderer.getViewport()
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === nodeId)
    const row = node?.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === inputId)
    if (!node || !row) throw new Error(`no widget '${inputId}' on node '${nodeId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  }, { nodeId, inputId })
}

/** Install a demo pack through the public extension API. */
const installDemoPack = (page: Page) =>
  page.evaluate(() =>
    window.__dinksterTest!.app.extensions.register(
      {
        id: 'demo',
        displayName: 'Demo Pack',
        contributions: [
          { id: 'demo.menu.hello', category: 'menu', label: 'Hello menu' },
          { id: 'demo.widget.stars', category: 'widgetKind', label: 'Stars widget' },
          { id: 'demo.widget.stars.view', category: 'widgetView', label: 'Stars view' },
          { id: 'demo.widget.stars.record', category: 'command', label: 'Record stars' },
        ],
      },
      (api) => {
        api.menu('demo.menu.hello', {
          id: 'demo.menu.hello',
          targets: ['node'],
          group: '85-demo',
          resolve: () => [
            { id: 'demo.menu.hello.item', label: 'Demo: Hello', action: { kind: 'host', action: 'noop' } },
          ],
        })
        api.widgetKind('demo.widget.stars', {
          type: 'demo.widget.stars',
          valueSchema: { version: 1, validate: (v: unknown) => typeof v === 'number' },
          defaultValue: () => 3,
          validate: () => [],
          defaultView: () => 'demo.widget.stars.view',
        })
        api.widgetView('demo.widget.stars.view', {
          id: 'demo.widget.stars.view',
          kind: 'demo.widget.stars',
          isCompatible: () => true,
          measure: () => ({ rows: 1 }),
          drawCompact(builder: {
            rect(x: number, y: number, width: number, height: number, style: object): void
            text(x: number, y: number, text: string, style: object): void
            hitRegion(x: number, y: number, width: number, height: number, action: string): void
          }, value: unknown) {
            builder.rect(0, 0, 1, 1, { role: 'widget' })
            builder.text(0, 0, `${String(value)} stars`, { role: 'value' })
            builder.hitRegion(0, 0, 1, 1, 'widget.edit')
          },
          editorSizing: () => ({ preferred: { width: 420, height: 240 } }),
          editorUi: (context: {
            version: 1
            surface: 'status' | 'widget-editor' | 'preview-viewer'
            data: null | boolean | number | string | readonly unknown[] | Readonly<Record<string, unknown>>
          }) => {
            const state = window as unknown as {
              __demoEditorContext?: typeof context
            }
            state.__demoEditorContext = context
            const data = context.data as { value: number; target: { graphId: string; nodeId: string; inputId: string } }
            return {
              version: 1,
              root: {
                kind: 'group', key: 'demo.editor', direction: 'column', children: [
                  { kind: 'text', key: 'demo.summary', text: `Current rating: ${data.value} stars`, tone: 'accent' },
                  { kind: 'text', key: 'demo.detail', text: 'Extension editors can present long, descriptive content without owning DOM, theme, placement, or lifecycle behavior.' },
                  { kind: 'status', key: 'demo.status', text: 'Ready to dispatch a declared command.', tone: 'success', live: 'polite' },
                  { kind: 'action', key: 'demo.record', label: 'Record this rating', command: 'demo.widget.stars.record', payload: { ...data.target, value: data.value } },
                ],
              },
            }
          },
        })
        api.command('demo.widget.stars.record', {
          id: 'demo.widget.stars.record',
          label: 'Record stars',
          run: (payload: unknown) => {
            ;(window as unknown as { __demoEditorCommandPayload?: unknown }).__demoEditorCommandPayload = payload
          },
        })
      },
    ),
  )

const menu = (page: Page) => page.getByTestId('context-menu')
const menuItem = (page: Page, id: string) => page.locator(`[data-item-id="${id}"]`)
const hasWidgetKind = (page: Page) =>
  page.evaluate(
    () =>
      (
        window.__dinksterTest!.app as unknown as {
          widgetRegistry: { kind(t: string): unknown }
        }
      ).widgetRegistry.kind('demo.widget.stars') !== undefined,
  )

const activeWidgetView = (page: Page) => page.evaluate(() =>
  window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'n0')?.layout.rows
    .find((row) => row.kind === 'widget' && row.inputId === 'stars')?.viewId,
)

const registerExtensionSchema = (page: Page) => page.evaluate(() => {
  window.__dinksterTest!.app.registerSchemas([{
    type: 'extensionMenuTest', displayName: 'Extension menu test', category: 'test', source: 'v3', isOutputNode: false,
    items: [{
      kind: 'input', id: 'stars', type: { kind: 'concrete', name: 'demo.widget.stars' }, optional: false,
      widget: { widgetType: 'demo.widget.stars', options: { display_name: 'Rating' }, default: 3 },
    }],
  }])
})

async function openNodeMenu(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.mouse.click(...xy(await headerPoint(page, 'n0')), { button: 'right' })
  await expect(menu(page)).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket('**/ws*', () => {})
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await registerExtensionSchema(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const diagnostics = app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'extension-menu-test', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { n0: { id: 'n0', type: 'extensionMenuTest', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      } },
      view: { graphs: { g0: { nodes: { n0: { position: { x: 180, y: 160 } } } } } },
    }, 'Extension menu test')
    if (diagnostics.length > 0) throw new Error(`extension fixture failed: ${JSON.stringify(diagnostics)}`)
  })
  await expect.poll(() => page.evaluate(() => 'status' in window.__dinksterTest!.app.activeTab()!.store)).toBe(true)
  await registerExtensionSchema(page)
  await openRailPanel(page, 'Extensions')
})

test('pack doors render a center editor and right panel through host UI', async ({ page }) => {
  const diagnostics = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const provider = () => ({
      version: 1 as const,
      root: { kind: 'group' as const, key: 'proof', direction: 'column' as const, children: [
        { kind: 'status' as const, key: 'status', text: 'Third-party pack active', tone: 'success' as const },
        { kind: 'text' as const, key: 'detail', text: 'Rendered by the host from a declarative contribution.' },
      ] },
    })
    const result = app.extensions.register({
      id: 'pack-doors-proof',
      displayName: 'Pack Doors Proof',
      contributions: [
        { id: 'pack-doors-proof.editor', category: 'editor', label: 'Pack editor' },
        { id: 'pack-doors-proof.binding', category: 'editorBinding', label: 'Pack editor binding' },
        { id: 'pack-doors-proof.panel', category: 'panel', label: 'Pack panel' },
      ],
    }, (api) => {
      api.editor('pack-doors-proof.editor', { id: 'pack-doors-proof.editor', title: 'Pack editor', provider })
      api.editorBinding('pack-doors-proof.binding', {
        id: 'pack-doors-proof.binding', editor: 'pack-doors-proof.editor', match: { editorRole: 'proof' }, priority: 20,
      })
      api.panel('pack-doors-proof.panel', 'sidebar.right', provider, 5, 'Pack panel')
    })
    const tab = app.activeTab()!
    if (!app.openEditorForBinding(tab.id, { editorRole: 'proof' })) throw new Error('binding did not open its editor')
    app.dock.activate('right', 'pack-doors-proof.panel')
    app.dock.setOpen('right', true)
    return result
  })
  expect(diagnostics).toEqual([])
  await expect(page.locator('.canvas-stage').getByText('Third-party pack active', { exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Pack panel', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.rail').getByText('Third-party pack active', { exact: true })).toBeVisible()
  await captureEditorProof(page, 'pack-registered-editor-and-panel')
})

test('installed pack lists in the Extensions panel and its menu item serves', async ({ page }) => {
  // Skipped pending Kosinkadink/comfy-vibe-station#430: the audit lane's
  // native dev-pack serve does not compose the widget-kind contribution the
  // demo pack asserts.
  test.skip(test.info().config.configFile?.includes('audit-assets') ?? false, 'skipped pending Kosinkadink/comfy-vibe-station#430')
  await expect(page.getByTestId('extensions-empty')).toContainText('No extension packs')
  expect(await installDemoPack(page)).toEqual([])

  const panel = page.getByTestId('extensions-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('extension-pack')).toHaveAttribute('data-pack', 'demo')
  await expect(panel.getByTestId('extension-contribution')).toHaveCount(4)
  await expect(panel.getByTestId('extension-category')).toHaveCount(4)
  expect(await hasWidgetKind(page)).toBe(true)

  await openNodeMenu(page)
  await expect(menuItem(page, 'demo.menu.hello.item')).toBeVisible()
  await page.keyboard.press('Escape')

  const menuCategoryToggle = panel.locator('[data-category="menu"]').getByTestId('extension-category-toggle')
  await menuCategoryToggle.click()
  await expect(menuCategoryToggle).toBeFocused()
  await expect(menuCategoryToggle).toHaveAttribute('aria-checked', 'false')
  await openNodeMenu(page)
  await expect(menuItem(page, 'demo.menu.hello.item')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await menuCategoryToggle.click()
  await expect(menuCategoryToggle).toHaveAttribute('aria-checked', 'true')
  await openNodeMenu(page)
  await expect(menuItem(page, 'demo.menu.hello.item')).toBeVisible()
  await page.keyboard.press('Escape')

  await page.evaluate(() => window.__dinksterTest!.app.extensions.unregister('demo'))
  await expect(panel.getByTestId('extension-pack')).toHaveCount(0)
  await expect(page.getByTestId('extensions-empty')).toBeVisible()
})

test('mounted Extensions management chrome localizes without changing extension gates or raw pack data', async ({ page, request }) => {
  let backendRequests = 0
  page.on('request', (sent) => {
    const path = new URL(sent.url()).pathname
    if (path === '/object_info' || path === '/system_stats' || path.startsWith('/api/')) backendRequests += 1
  })
  expect(await installDemoPack(page)).toEqual([])
  const panel = page.getByTestId('extensions-panel')
  const pack = panel.getByTestId('extension-pack')
  const category = panel.locator('[data-category="menu"]')
  const contribution = panel.locator('[data-contribution="demo.menu.hello"]')
  const categoryToggle = category.getByTestId('extension-category-toggle')
  await panel.evaluate((element) => { element.dataset['localeIdentity'] = 'panel' })
  await pack.evaluate((element) => { element.dataset['localeIdentity'] = 'pack' })
  await category.evaluate((element) => { element.dataset['localeIdentity'] = 'category' })
  await contribution.evaluate((element) => { element.dataset['localeIdentity'] = 'contribution' })
  await categoryToggle.focus()
  const changedBeforeLocale = await page.evaluate(() =>
    (window.__dinksterTest!.app.extensions as unknown as { changed: { get(): number } }).changed.get())
  const requestsBeforeLocale = backendRequests
  await page.screenshot({ path: evidencePath('issue-457', 'extensions-panel-i18n-en.png'), fullPage: true })

  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'extensions.action.enableCategory': '[ALLE BEITRAGE VON {id} {category} AKTIVIEREN]',
      'extensions.action.enableContribution': '[BEITRAG {id} AKTIVIEREN]',
      'extensions.action.enablePack': '[ERWEITERUNGSPAKET {id} AKTIVIEREN]',
      'extensions.aria.category': '[BEITRAGE DER KATEGORIE {category}]',
      'extensions.aria.diagnostics': '[DIAGNOSEN FUR {id}]',
      'extensions.aria.pack': '[ERWEITERUNGSPAKET {id}]',
      'extensions.control.unregistered': '[PAKET NICHT REGISTRIERT; DIAGNOSEN BEHEBEN UND NEU LADEN]',
      'extensions.description': '[DIE HOST-RICHTLINIE SETZT DIE AUSSERE GRENZE. IHRE SCHALTER STEUERN AKTIVE FUNKTIONEN.]',
      'extensions.diagnostics': '[DIAGNOSEN]',
      'extensions.empty': '[KEINE ERWEITERUNGSPAKETE REGISTRIERT]',
      'extensions.emptyContributions': '[DIESES PAKET HAT KEINE BEITRAGE]',
      'extensions.state.activationFailed': '[AKTIVIERUNG FEHLGESCHLAGEN]',
      'extensions.state.active': '[AKTIV]',
      'extensions.state.activeRegistered': '[AKTIV UND REGISTRIERT]',
      'extensions.state.blockedByPolicy': '[DURCH RICHTLINIE BLOCKIERT]',
      'extensions.state.declaredNotRegistered': '[DEKLARIERT, NICHT REGISTRIERT]',
      'extensions.state.disabledByUser': '[VOM BENUTZER DEAKTIVIERT]',
      'extensions.state.enabledInactive': '[AKTIVIERT, INAKTIV]',
      'extensions.state.enabledInactiveCategoryDisabled': '[AKTIVIERT, INAKTIV: KATEGORIE DEAKTIVIERT]',
      'extensions.state.enabledInactivePackDisabled': '[AKTIVIERT, INAKTIV: PAKET DEAKTIVIERT]',
      'extensions.state.registeredActive': '[REGISTRIERT UND AKTIV]',
      'extensions.state.registeredInactive': '[REGISTRIERT, INAKTIV]',
      'extensions.state.registrationFailed': '[REGISTRIERUNG FEHLGESCHLAGEN]',
      'extensions.title': '[ERWEITERUNGSVERWALTUNG]',
      'Demo Pack': '[NICHT UBERSETZEN]',
      'Hello menu': '[NICHT UBERSETZEN]',
      'menu': '[NICHT UBERSETZEN]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(page.locator('[data-locale-identity="panel"]')).toHaveCount(1)
  await expect(page.locator('[data-locale-identity="pack"]')).toHaveCount(1)
  await expect(page.locator('[data-locale-identity="category"]')).toHaveCount(1)
  await expect(page.locator('[data-locale-identity="contribution"]')).toHaveCount(1)
  await expect(panel.locator('h2')).toHaveText('[ERWEITERUNGSVERWALTUNG]')
  await expect(panel).toContainText('[DIE HOST-RICHTLINIE SETZT DIE AUSSERE GRENZE. IHRE SCHALTER STEUERN AKTIVE FUNKTIONEN.]')
  await expect(pack).toContainText('Demo Pack')
  await expect(pack).toContainText('Hello menu')
  await expect(category.locator('h4')).toHaveText('menu')
  await expect(pack).toHaveAttribute('data-state', 'Registered and active')
  await expect(category.locator('.extension-category-header > .extension-state')).toHaveAttribute('data-state', 'Active')
  await expect(contribution).toHaveAttribute('data-state', 'Active and registered')
  await expect(contribution.locator('.extension-state')).toHaveText('[AKTIV UND REGISTRIERT]')
  await expect(categoryToggle).toHaveAttribute('aria-label', '[ALLE BEITRAGE VON demo menu AKTIVIEREN]')
  await expect(categoryToggle).toHaveAttribute('aria-checked', 'true')
  await expect(categoryToggle).toBeFocused()
  expect(await page.evaluate(() =>
    (window.__dinksterTest!.app.extensions as unknown as { changed: { get(): number } }).changed.get())).toBe(changedBeforeLocale)
  expect(backendRequests).toBe(requestsBeforeLocale)
  await page.screenshot({ path: evidencePath('issue-457', 'extensions-panel-i18n-de-DE.png'), fullPage: true })

  await categoryToggle.click()
  await expect(categoryToggle).toHaveAttribute('aria-checked', 'false')
  await expect(category.locator('.extension-category-header > .extension-state')).toHaveAttribute('data-state', 'Disabled by user')
  await expect(category.locator('.extension-category-header > .extension-state')).toHaveText('[VOM BENUTZER DEAKTIVIERT]')
  await expect(categoryToggle).toBeFocused()
})

test('fixture WidgetView opens a bounded host-rendered editor and dispatches declared commands', async ({ page }) => {
  expect(await installDemoPack(page)).toEqual([])
  await expect.poll(() => activeWidgetView(page)).toBe('demo.widget.stars.view')
  await page.getByRole('button', { name: 'Hide minimap' }).click()
  await page.mouse.click(...xy(await widgetPoint(page, 'n0', 'stars')))

  const editor = page.getByTestId('widget-editor')
  await expect(editor).toBeVisible()
  await expect(editor).toHaveAttribute('role', 'dialog')
  await expect(editor).toHaveAttribute('aria-label', 'Edit stars demo.widget.stars')
  await expect(page.getByTestId('widget-editor-host-ui')).toContainText('Current rating: 3 stars')
  await expect(page.getByRole('button', { name: 'Record this rating' })).toBeFocused()
  await captureEditorProof(page, 'extension-widget-editor-1440x900')
  expect(await page.evaluate(() => {
    const context = (window as unknown as { __demoEditorContext?: {
      surface: string
      data: Readonly<Record<string, unknown>>
    } }).__demoEditorContext
    return {
      surface: context?.surface,
      contextFrozen: Object.isFrozen(context),
      dataFrozen: Object.isFrozen(context?.data),
    }
  })).toEqual({ surface: 'widget-editor', contextFrozen: true, dataFrozen: true })

  await page.getByRole('button', { name: 'Record this rating' }).click()
  expect(await page.evaluate(() =>
    (window as unknown as { __demoEditorCommandPayload?: unknown }).__demoEditorCommandPayload,
  )).toEqual({ kind: 'input', graphId: 'g0', nodeId: 'n0', inputId: 'stars', value: 3 })

  const canvasBounds = await page.getByTestId('graph-canvas').boundingBox()
  const editorBounds = await editor.boundingBox()
  expect(canvasBounds).not.toBeNull()
  expect(editorBounds).not.toBeNull()
  expect(editorBounds!.x).toBeGreaterThanOrEqual(canvasBounds!.x)
  expect(editorBounds!.y).toBeGreaterThanOrEqual(canvasBounds!.y)
  expect(editorBounds!.x + editorBounds!.width).toBeLessThanOrEqual(canvasBounds!.x + canvasBounds!.width)
  expect(editorBounds!.y + editorBounds!.height).toBeLessThanOrEqual(canvasBounds!.y + canvasBounds!.height)

  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  await expect(page.getByTestId('graph-canvas')).toBeFocused()

  await page.getByRole('button', { name: 'Toggle right rail' }).click()
  await page.setViewportSize({ width: 360, height: 640 })
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: -120, y: 80, scale: 1 }))
  await page.mouse.click(...xy(await widgetPoint(page, 'n0', 'stars')))
  await expect(editor).toBeVisible()
  await expect(page.getByRole('button', { name: 'Record this rating' })).toBeFocused()
  const narrowBounds = await editor.boundingBox()
  expect(narrowBounds).not.toBeNull()
  expect(narrowBounds!.x).toBeGreaterThanOrEqual(0)
  expect(narrowBounds!.x + narrowBounds!.width).toBeLessThanOrEqual(360)
  expect(narrowBounds!.y).toBeGreaterThanOrEqual(0)
  expect(narrowBounds!.y + narrowBounds!.height).toBeLessThanOrEqual(640)
  expect(await page.getByTestId('widget-editor-host-ui').evaluate((element) =>
    element.scrollWidth <= element.clientWidth,
  )).toBe(true)
  await captureEditorProof(page, 'extension-widget-editor-360x640')
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
})

test('toggling one contribution removes exactly that feature and restores it', async ({ page }) => {
  // Skipped pending Kosinkadink/comfy-vibe-station#430: the audit lane's
  // native dev-pack serve does not compose the widget-kind contribution the
  // demo pack asserts.
  test.skip(test.info().config.configFile?.includes('audit-assets') ?? false, 'skipped pending Kosinkadink/comfy-vibe-station#430')
  await installDemoPack(page)
  const menuToggle = page
    .locator('[data-contribution="demo.menu.hello"]')
    .getByTestId('extension-contribution-toggle')

  await menuToggle.click()
  await expect(menuToggle).toHaveAttribute('aria-checked', 'false')
  await expect(menuToggle).toBeFocused()
  await expect(page.locator('[data-contribution="demo.menu.hello"]')).toHaveAttribute('data-active', 'false')
  expect(await hasWidgetKind(page)).toBe(true) // sibling untouched
  await openNodeMenu(page)
  await expect(menuItem(page, 'demo.menu.hello.item')).toHaveCount(0)
  await expect(menuItem(page, 'core.node.delete')).toBeVisible() // core items unaffected
  await page.keyboard.press('Escape')

  await menuToggle.click()
  await expect(menuToggle).toHaveAttribute('aria-checked', 'true')
  await openNodeMenu(page)
  await expect(menuItem(page, 'demo.menu.hello.item')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('an open extension widget editor closes when its kind is gated off', async ({ page }) => {
  await installDemoPack(page)
  await expect.poll(() => activeWidgetView(page)).toBe('demo.widget.stars.view')
  await page.getByRole('button', { name: 'Hide minimap' }).click()
  await page.mouse.click(...xy(await widgetPoint(page, 'n0', 'stars')))
  const editor = page.getByTestId('widget-editor')
  await expect(editor).toBeVisible()
  // Programmatic gate flip: no pointer or focus change, so only the scene
  // rebuild's survival check can close the editor.
  await page.evaluate(() => window.__dinksterTest!.app.extensions.setContributionEnabled('demo.widget.stars', false))
  await expect(editor).toHaveCount(0)
})

test('an open canvas menu closes when a menu contribution is gated off', async ({ page }) => {
  await installDemoPack(page)
  await openNodeMenu(page)
  await expect(menuItem(page, 'demo.menu.hello.item')).toBeVisible()
  await page.evaluate(() => window.__dinksterTest!.app.extensions.setContributionEnabled('demo.menu.hello', false))
  await expect(menu(page)).toHaveCount(0)
})

test('pack-level toggle disables every contribution at once', async ({ page }) => {
  await installDemoPack(page)
  await page.getByTestId('extension-pack-toggle').click()
  await expect(page.getByTestId('extension-pack-toggle')).toHaveAttribute('aria-checked', 'false')
  expect(await hasWidgetKind(page)).toBe(false)
  await openNodeMenu(page)
  await expect(menuItem(page, 'demo.menu.hello.item')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('gate overrides persist across reload and apply before activation', async ({ page }) => {
  await installDemoPack(page)
  await page
    .locator('[data-contribution="demo.widget.stars"]')
    .getByTestId('extension-contribution-toggle')
    .click()
  expect(await hasWidgetKind(page)).toBe(false)

  await page.reload()
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await installDemoPack(page) // packs re-activate per session; gates outlive them
  expect(await hasWidgetKind(page)).toBe(false)
  await expect(page.locator('[data-contribution="demo.widget.stars"]')).toHaveAttribute('data-active', 'false')
  // Clean up the persisted gate so other specs start default-on.
  await page.evaluate(() => localStorage.removeItem('dinkster.extensionGates'))
})

test('declarative status failures surface once in Problems and clear independently', async ({ page }) => {
  const diagnostics = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.extensions.register({
      id: 'demo.monitor', displayName: 'Monitor',
      contributions: [{ id: 'demo.monitor.status', category: 'hostUi' }],
    }, (api) => api.hostUi('demo.monitor.status', 'status.trailing',
      (context) => ({ version: 1, root: { kind: 'status', key: 'demo.monitor', text: `${(context.data as { connectionLabel: string }).connectionLabel}: monitor ready`, tone: 'success', live: 'polite' } })))
    app.extensions.register({
      id: 'demo.provider-failure', displayName: 'Provider failure',
      contributions: [{ id: 'demo.provider-failure.status', category: 'hostUi' }],
    }, (api) => api.hostUi('demo.provider-failure.status', 'status.trailing', () => {
      throw new Error('Host UI provider proof failure')
    }))
    app.extensions.register({
      id: 'demo.vhs', displayName: 'VHS',
      contributions: [{ id: 'demo.vhs.preview-enabled', category: 'setting' }],
    }, (api) => api.setting('demo.vhs.preview-enabled', {
      id: 'demo.vhs.preview-enabled', name: 'VHS previews', type: 'boolean', defaultValue: false,
    }))
    return app.extensions.register({
      id: 'demo.broken', displayName: 'Broken',
      contributions: [{ id: 'demo.broken.status', category: 'hostUi' }],
    }, (api) => {
      api.hostUi('demo.broken.status', 'status.trailing', () => ({ version: 1, root: { kind: 'text', key: 'bad', text: 'must roll back' } }))
      throw new Error('injected activation failure')
    }).map((item) => item.code)
  })
  expect(diagnostics).toEqual(['extension.activate-failed', 'extension.rollback-complete'])
  await expect(page.locator('[data-pack="demo.broken"]')).toContainText('Activation failed')
  await expect(page.locator('[data-pack="demo.broken"]')).toContainText('injected activation failure')
  await expect(page.locator('[data-host-ui-contribution="demo.monitor.status"]')).toContainText('monitor ready')
  await expect(page.locator('[data-host-ui-contribution="demo.broken.status"]')).toHaveCount(0)
  await expect(page.locator('[data-contribution="demo.vhs.preview-enabled"]')).toHaveAttribute('data-active', 'true')
  await expect(page.locator('[data-host-ui-contribution="demo.provider-failure.status"] [role=alert]')).toBeVisible()
  const providerProblems = page.getByTestId('problems-panel').getByText(/Host UI provider proof failure/)
  await expect(providerProblems).toHaveCount(1)

  await page.locator('[data-contribution="demo.provider-failure.status"]').getByTestId('extension-contribution-toggle').click()
  await expect(page.locator('[data-host-ui-contribution="demo.provider-failure.status"]')).toHaveCount(0)
  await expect(providerProblems).toHaveCount(0)

  await page.locator('[data-contribution="demo.monitor.status"]').getByTestId('extension-contribution-toggle').click()
  await expect(page.locator('[data-host-ui-contribution="demo.monitor.status"]')).toHaveCount(0)
  await expect(page.locator('[data-contribution="demo.vhs.preview-enabled"]')).toHaveAttribute('data-active', 'true')
  await page.locator('[data-contribution="demo.vhs.preview-enabled"]').getByTestId('extension-contribution-toggle').click()
  await expect(page.locator('[data-contribution="demo.vhs.preview-enabled"]')).toHaveAttribute('data-active', 'false')
})

const previewModule = readFileSync(new URL('../fixtures/video-preview-extension.js', import.meta.url), 'utf8')
const sha256 = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`
const previewPack = 'dinkster-video-preview'
const previewContribution = `${previewPack}.preview.initialized`

async function installSnapshot(page: Page, options: { source?: string; privileges?: readonly string[]; corruptAsset?: boolean; baseUrl?: string; badRoute?: boolean } = {}) {
  const baseUrl = options.baseUrl ?? '/snapshot'
  const source = options.source ?? previewModule
  const moduleDigest = sha256(source)
  const moduleUrl = `/api/extension-assets/${previewPack}/${moduleDigest}/${previewPack}.frontend.preview.js`
  const body = JSON.stringify({
    format: 'dinkster.extension-snapshot', version: 1, frontendApi: '1.0.0', extensions: [{
      id: previewPack, version: '1.0.0', packageDigest: sha256('installed-pack'), contributionIds: [],
      selectorResolutions: [], serviceProviders: [], capabilities: ['accelerator', 'artifacts'], behaviorConfiguration: [],
      events: [{ name: 'video-preview.initialized', payload: { fps: 'number', frameCount: 'integer', height: 'integer', width: 'integer' } }],
      routes: [{ id: 'preview-policy', method: 'GET', handler: 'dinkster_video_preview:preview_policy', request: {}, response: { defaultFps: 'number', maxFrames: 'integer', maxWidth: 'integer' } }],
      frontend: [{ id: `${previewPack}.frontend.preview`, moduleUrl, moduleDigest,
        authorizedPrivileges: options.privileges ?? ['app-workflow', 'event-consumer'],
        contributions: [{ id: previewContribution, kind: 'eventConsumer', event: 'video-preview.initialized' }, { id: `${previewPack}.preview.status`, kind: 'hostUi' }],
      }],
    }],
  })
  const digest = sha256(body)
  let assetRequests = 0
  let routeRequests = 0
  await page.route(`${baseUrl}/api/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === `${baseUrl}/api/nodes`) return route.fulfill({ json: {
      schemaVersion: 1, epoch: 1, extensionSnapshotDigest: digest, dinkster: { version: 'proof', schemaWire: 1 },
      nodes: { 'video-preview.initialize': { schemaVersion: 1, displayName: 'Video preview initialization', interface: [] } },
    } })
    if (path === `${baseUrl}/api/extensions/snapshot`) return route.fulfill({ body, contentType: 'application/json' })
    if (path === `${baseUrl}/api/extensions/${previewPack}/routes/preview-policy`) {
      routeRequests++
      expect(route.request().method()).toBe('GET')
      expect(route.request().headers()['if-match']).toBe(digest)
      return route.fulfill({ json: { defaultFps: 30, maxFrames: 96, maxWidth: 384 }, headers: {
        'X-Dinkster-Extension-Snapshot': options.badRoute ? sha256('other') : digest,
      } })
    }
    if (path === `${baseUrl}${moduleUrl}`) {
      assetRequests++
      return route.fulfill({ body: options.corruptAsset ? `${source}\n// changed` : source, contentType: 'text/javascript', headers: { 'cache-control': 'public, max-age=31536000, immutable' } })
    }
    return route.fulfill({ status: 404 })
  })
  await page.evaluate(async (baseUrl) => {
    const app = window.__dinksterTest!.app
    const backend = app.addBackend(baseUrl, 'Snapshot proof', false, 'dinkster', false)!
    app.setTabTarget(app.activeTab()!.id, backend.id)
    await app.refreshBackendSchemas(backend)
  }, baseUrl)
  expect(await page.evaluate(() => window.__dinksterTest!.app.backendForTab(window.__dinksterTest!.app.activeTab()!).schemaState.get().status)).toBe('ready')
  return { digest, assetRequests: () => assetRequests, routeRequests: () => routeRequests }
}

test('narrow Extensions identifiers stay on one line with complete titles', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const fixture = await installSnapshot(page)
  const contribution = page.locator(`[data-contribution="${previewContribution}"]`)
  await contribution.scrollIntoViewIfNeeded()
  await captureEditorProof(page, 'snapshot-narrow-identifiers')
  for (const tag of ['strong', 'code']) {
    const identity = contribution.locator(`.extension-identity ${tag}`)
    await expect(identity).toHaveAttribute('title', previewContribution)
    expect(await identity.evaluate((element) => {
      const style = getComputedStyle(element)
      const text = document.createRange()
      text.selectNodeContents(element)
      return {
        singleLine: new Set(Array.from(text.getClientRects(), (rect) => rect.top)).size === 1,
        ellipsis: style.textOverflow === 'ellipsis' && style.overflowX === 'hidden',
      }
    })).toEqual({ singleLine: true, ellipsis: true })
  }
  const panel = page.getByTestId('extensions-panel')
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await expectStatusBarContained(page)
  await page.evaluate((digest) => {
    const backend = window.__dinksterTest!.app.backends.get().find((backend) => backend.baseUrl === '/snapshot')!
    backend.connection.ingest({
      type: 'node_event', event: 'video-preview.initialized', data: { fps: 24, frameCount: 8, height: 64, width: 512 },
      jobId: 'preview-job', nodeId: 'outer[1]/preview', pack: 'dinkster-video-preview',
      schemaVersion: 1, extensionSnapshotDigest: digest, seq: 0,
    })
  }, fixture.digest)
  await expect(page.getByTestId('status-bar')).toContainText('Video exceeds preview policy limits')
  await expectStatusBarContained(page)
  await captureEditorProof(page, 'snapshot-narrow-footer-limit')
  const backendsToggle = page.getByTestId('backends-toggle')
  await backendsToggle.focus()
  await expect(backendsToggle).toBeInViewport()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('review-upgrades-toggle')).toBeFocused()
  await expect(page.getByTestId('review-upgrades-toggle')).toBeInViewport()
  await contribution.getByTestId('extension-contribution-toggle').click()
  await expect(contribution).toHaveAttribute('data-active', 'false')
})

test('status layout media queries are complementary at fractional widths', async ({ page }) => {
  const widths = [519.99, 520, 520.01, 520.25, 520.5, 520.75, 520.99, 521]
  const { desktopQuery, matches } = await page.evaluate((widths) => {
    const media = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules))
      .filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule)
    const containsSelector = (rule: CSSMediaRule, selector: string) =>
      Array.from(rule.cssRules).some((child) => child instanceof CSSStyleRule && child.selectorText === selector)
    const desktop = media.find((rule) => containsSelector(rule, '.statusbar .host-ui-column'))!
    const narrow = media.find((rule) => rule.conditionText === '(max-width: 520px)' && containsSelector(rule, '.topbar'))!
    // Scale both sides equally so integer iframe viewports preserve fractional-width query semantics.
    const queries = [narrow, desktop].map((rule) => rule.conditionText.replace(/([\d.]+)px/g, (_, value: string) => `${Number(value) * 100}px`))
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position: fixed; left: -100000px; height: 1px; border: 0;'
    document.body.append(frame)
    try {
      const matches = widths.map((width) => {
        frame.style.width = `${width * 100}px`
        const viewport = frame.contentWindow!
        return { width: viewport.innerWidth / 100, matches: queries.map((query) => viewport.matchMedia(query).matches) }
      })
      return { desktopQuery: desktop.conditionText, matches }
    } finally {
      frame.remove()
    }
  }, widths)
  expect(desktopQuery).toBe('not all and (max-width: 520px)')
  expect(matches).toEqual(widths.map((width) => ({ width, matches: [width <= 520, width > 520] })))
})

for (const [width, height] of [[1280, 800], [1920, 1080]] as const) {
  test(`desktop status preserves the canvas with an active contribution at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    const status = page.getByTestId('status-bar')
    const canvas = page.getByTestId('graph-canvas')
    const baseline = (await canvas.boundingBox())!
    expect((await status.boundingBox())!.height).toBe(28)
    expect(baseline.y + baseline.height).toBe(height - 28)
    await installSnapshot(page)
    await expect(status).toContainText('Preview policy: 30 fps | up to 96 frames, 384 px')
    await expect(status).toContainText('Waiting for video preview initialization')
    await captureEditorProof(page, `snapshot-desktop-footer-${width}`)
    expect((await status.boundingBox())!.height).toBe(28)
    const active = (await canvas.boundingBox())!
    expect(active.y + active.height).toBe(baseline.y + baseline.height)
    await expectStatusBarContained(page)
  })
}

test('snapshot-selected module consumes typed JSON with pinned provenance and obeys its gate', async ({ page }) => {
  const fixture = await installSnapshot(page)
  const contribution = page.locator(`[data-contribution="${previewContribution}"]`)
  const preview = page.locator(`[data-host-ui-contribution="${previewPack}.preview.status"]`)
  await expect(contribution).toHaveAttribute('data-active', 'true')
  expect(fixture.assetRequests()).toBeGreaterThan(0)
  await expect(preview).toContainText('Preview policy: 30 fps | up to 96 frames, 384 px')
  await expect(preview).toContainText('Waiting for video preview initialization')
  await expect(preview).toContainText(`Video preview: /snapshot [${fixture.digest.slice(7, 19)}]`)
  expect(fixture.routeRequests()).toBe(1)
  await expectStatusBarContained(page)
  const send = (seq: number, digest = fixture.digest) => page.evaluate(({ digest, seq }) => {
    const backend = window.__dinksterTest!.app.backends.get().find((backend) => backend.baseUrl === '/snapshot')!
    if (backend.protocol !== 'dinkster') throw new Error('expected native backend')
    backend.connection.ingest({
      type: 'node_event', event: 'video-preview.initialized', data: { fps: 24, frameCount: 8, height: 64, width: 128 * seq },
      jobId: 'preview-job', runId: 'preview-run', nodeId: 'outer[1]/preview', worker: 'cpu-worker', pack: 'dinkster-video-preview', executionArm: 'native',
      schemaVersion: 1, extensionSnapshotDigest: digest, seq, futureField: 'tolerated',
    })
  }, { digest, seq })
  await send(1)
  await expect(preview).toContainText('outer[1]/preview: 128 x 64 | 24 fps | 8 frames')
  await captureEditorProof(page, 'snapshot-event-consumer-active')
  await contribution.getByTestId('extension-contribution-toggle').click()
  await expect(contribution).toHaveAttribute('data-active', 'false')
  await send(2)
  await expect(preview).toContainText('outer[1]/preview: 128 x 64 | 24 fps | 8 frames')
  await contribution.getByTestId('extension-contribution-toggle').click()
  await send(4)
  await expect(preview).toContainText('outer[1]/preview: 512 x 64 | 24 fps | 8 frames')
  await expect(preview).toContainText('Video exceeds preview policy limits')
  await expectStatusBarContained(page)
  await send(5, sha256('wrong snapshot'))
  await expect(preview).toContainText('outer[1]/preview: 512 x 64 | 24 fps | 8 frames')
  await captureEditorProof(page, 'snapshot-preview-policy-limit')
  const other = await installSnapshot(page, { baseUrl: '/other' })
  expect(other.digest).toBe(fixture.digest)
  await expect(preview).toContainText('Video preview: /other')
  await expect(preview).toContainText('Waiting for video preview initialization')
  await send(6)
  await expect(preview).toContainText('Waiting for video preview initialization')
  await page.evaluate(() => window.__dinksterTest!.app.setTabTarget(window.__dinksterTest!.app.activeTab()!.id, '/snapshot'))
  await expect(preview).toContainText('outer[1]/preview: 768 x 64 | 24 fps | 8 frames')
  await page.locator(`[data-contribution="${previewPack}.preview.status"]`).getByTestId('extension-contribution-toggle').click()
  await expect(preview).toHaveCount(0)
})

test('unpaired own-pack route data leaves a visible generic fallback', async ({ page }) => {
  await installSnapshot(page, { badRoute: true })
  await expect(page.locator(`[data-host-ui-contribution="${previewPack}.preview.status"]`)).toContainText('Preview policy unavailable; native video remains available')
  await captureEditorProof(page, 'snapshot-preview-route-fallback')
})

test('event-consumer alone never imports presentation or calls its route', async ({ page }) => {
  const fixture = await installSnapshot(page, { privileges: ['event-consumer'] })
  expect(fixture.assetRequests()).toBe(0)
  expect(fixture.routeRequests()).toBe(0)
  await expect(page.locator(`[data-host-ui-contribution="${previewPack}.preview.status"]`)).toHaveCount(0)
  await expect(page.locator(`[data-pack="${previewPack}"]`)).toContainText('lacks a required frontend privilege')
})

test('missing event privilege prevents imports but does not block native schemas', async ({ page }) => {
  const fixture = await installSnapshot(page, { privileges: ['app-workflow'] })
  expect(fixture.assetRequests()).toBe(0)
  await expect(page.locator(`[data-pack="${previewPack}"]`)).toContainText('lacks a required frontend privilege')
  expect(await page.evaluate(() => window.__dinksterTest!.app.backendForTab(window.__dinksterTest!.app.activeTab()!).registry.get()!.schemas.has('video-preview.initialize'))).toBe(true)
})

test('snapshot activation failure rolls back a staged event consumer', async ({ page }) => {
  await installSnapshot(page, { source: previewModule.replace('context.onDispose', "throw new Error('proof activation failure'); context.onDispose") })
  await expect(page.locator(`[data-pack="${previewPack}"]`)).toContainText('proof activation failure')
  await expect(page.locator(`[data-contribution="${previewContribution}"]`)).toHaveAttribute('data-active', 'false')
  await captureEditorProof(page, 'snapshot-activation-rollback')
})

test('module digest mismatch rejects asset bytes without executing them', async ({ page }) => {
  await installSnapshot(page, { corruptAsset: true })
  await expect(page.locator(`[data-pack="${previewPack}"]`)).toContainText('digest mismatch')
  await expect(page.locator(`[data-contribution="${previewContribution}"]`)).toHaveAttribute('data-active', 'false')
})
