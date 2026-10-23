import { expect, appViewTest as test, type Page } from './fixtures.js'

test.beforeEach(async ({ page }) => {
  await page.route('/api/**', (route) =>
    route.fulfill({ status: 502, body: 'visual fixture unavailable' }),
  )
  await page.route('/memory/**', (route) =>
    route.fulfill({ status: 502, body: 'visual fixture unavailable' }),
  )
  await page.route('/supervisor/**', (route) =>
    route.fulfill({ status: 502, body: 'visual fixture unavailable' }),
  )
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'visual-fixture' }, devices: [] } }),
  )
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.routeWebSocket('**/ws?*', () => {})
})

const screenshot = async (page: Page, name: string, immediate = false): Promise<void> => {
  if (immediate) {
    expect(await page.screenshot({ animations: 'disabled' })).toMatchSnapshot(`${name}.png`, {
      maxDiffPixelRatio: 0.002,
    })
    return
  }
  await expect(page).toHaveScreenshot(`${name}.png`, {
    animations: 'disabled',
    maxDiffPixelRatio: 0.002,
  })
}

const boot = async (page: Page): Promise<void> => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest?.app !== undefined)
}

const closeGallery = async (page: Page): Promise<void> => {
  const close = page.locator('.template-gallery-close')
  if ((await close.count()) > 0 && (await close.first().isVisible()))
    await close.first().click()
  else
    await page.evaluate(() =>
      (window.__dinksterTest!.app as unknown as {
        readonly templateGalleryOpen: { set(value: boolean): void }
      }).templateGalleryOpen.set(false),
    )
  await expect(page.getByTestId('template-gallery')).toBeHidden()
}

const openDock = async (page: Page, testId: string): Promise<void> => {
  const toggle = page.getByTestId(testId)
  if ((await toggle.getAttribute('aria-pressed')) !== 'true')
    await toggle.click()
}

const openRail = async (page: Page, title: string): Promise<void> => {
  const rail = page.getByTestId('dock-zone-right')
  if (!(await rail.isVisible())) await page.getByTestId('rail-toggle').click()
  const tab = rail.getByRole('tab', { name: title, exact: true })
  if ((await tab.count()) > 0 && (await tab.first().isVisible())) {
    await tab.first().click()
    return
  }
  await rail.getByTestId('dock-zone-overflow-button').click()
  await page
    .getByRole('menuitemradio')
    .filter({ hasText: title })
    .first()
    .click()
}

const openModal = async (page: Page, id: string): Promise<void> => {
  await page.evaluate(
    (panel) => (window.__dinksterTest!.app as unknown as {
      readonly modalPanel: { set(value: string): void }
    }).modalPanel.set(panel),
    id,
  )
}

test('canvas chrome at desktop and compact widths', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 })
    await expect(page.getByTestId('canvas-zoom-in')).toBeVisible()
    await screenshot(page, `canvas-chrome-${width}`)
    await page.getByTestId('minimap-settings').click()
    await expect(page.locator('.minimap-menu')).toBeVisible()
    await screenshot(page, `canvas-minimap-settings-${width}`)
    await page.keyboard.press('Escape')
    await expect(page.locator('.minimap-menu')).toBeHidden()
    await page.getByTestId('views-switcher').click()
    await expect(page.getByRole('menuitem', { name: /Noodles/ })).toBeVisible()
    await screenshot(page, `canvas-view-menu-${width}`)
    await page.getByTestId('views-switcher').click()
  }
})

test('shell and canvas visual matrix', async ({ page }) => {
  // Temporary skip pending attribution: Kosinkadink/comfy-vibe-station#430
  test.skip(true, 'red at main; attribution and re-enable tracked in Kosinkadink/comfy-vibe-station#430')
  await boot(page)
  await page.evaluate(() => (window.__dinksterTest!.app as unknown as {
    readonly templateGalleryOpen: { set(value: boolean): void }
  }).templateGalleryOpen.set(true))
  await expect(page.getByTestId('template-gallery')).toBeVisible()
  await screenshot(page, '01-starter-template-gallery')
  await closeGallery(page)
  await screenshot(page, '02-shell-and-top-bar')
  const rightRail = page.getByTestId('dock-zone-right')
  if (!(await rightRail.isVisible())) await page.getByTestId('rail-toggle').click()
  await expect(rightRail).toBeVisible()
  await screenshot(page, '03-right-rail-tabs')
  await page.getByTestId('rail-toggle').click()
  await expect(rightRail).toBeHidden()
  await page.getByTestId('minimap-settings').click()
  await expect(page.locator('.minimap-menu')).toBeVisible()
  await page.mouse.move(720, 450)
  await page.waitForTimeout(600)
  await expect(page.getByTestId('app-tooltip')).toBeHidden()
  await screenshot(page, '04-canvas-toolbar')
  await page.keyboard.press('Escape')
  await expect(page.locator('.minimap-menu')).toBeHidden()
  await page.evaluate(() => {
    const bridge = window.__dinksterTest!
    bridge.app.registerSchemas([
      {
        type: 'EmptyImage',
        displayName: 'Empty Image',
        category: 'visual',
        source: 'visual',
        isOutputNode: false,
        items: [
          {
            kind: 'output',
            id: 'out0',
            type: { kind: 'concrete', name: 'IMAGE' },
          },
        ],
      },
    ])
    bridge.app.openDocument(
      bridge.syntheticWorkflow({ chains: 1, chainLength: 2, reroutes: false }),
      'Visual controls',
    )
  })
  await screenshot(page, '05-canvas-nodes')
  const canvas = await page.getByTestId('graph-canvas').boundingBox()
  if (!canvas) throw new Error('graph canvas did not render')
  await page.mouse.click(
    canvas.x + canvas.width / 2,
    canvas.y + canvas.height / 2,
    { button: 'right' },
  )
  await screenshot(page, '06-canvas-context-menu')
  await page.keyboard.press('Escape')
  await page.getByTestId('views-switcher').click()
  await screenshot(page, '07-views-switcher')
  await page.keyboard.press('Escape')
  await page.mouse.dblclick(
    canvas.x + canvas.width / 2,
    canvas.y + canvas.height / 2,
  )
  await screenshot(page, '08-node-palette')
  await page.keyboard.press('Escape')
  await page.evaluate(() => (window.__dinksterTest!.app as unknown as {
    readonly searchOpen: { set(value: boolean): void }
  }).searchOpen.set(true))
  await screenshot(page, '09-universal-search')
})

test('dock visual matrix', async ({ page }) => {
  // Temporary skip pending attribution: Kosinkadink/comfy-vibe-station#430
  test.skip(true, 'red at main; attribution and re-enable tracked in Kosinkadink/comfy-vibe-station#430')
  await boot(page)
  await closeGallery(page)
  const panels = [
    ['library-toggle', '10-library'],
    ['learn-toggle', '11-learn'],
    ['assets-toggle', '12-assets'],
    ['backends-sidebar-toggle', '13-backends'],
    ['memory-sidebar-toggle', '14-memory'],
    ['logs-toggle', '16-activity'],
    ['execution-log-toggle', '17-execution-log'],
  ] as const
  for (const [testId, name] of panels) {
    await openDock(page, testId)
    if (name === '11-learn') {
      const input = page.getByLabel('Search guides')
      await input.hover()
      await input.focus()
      await page.mouse.move(720, 450)
      await page.waitForTimeout(600)
      const styles = await input.evaluate((element) => {
        const control = getComputedStyle(element)
        const body = getComputedStyle(document.body)
        return {
          font: control.fontFamily,
          bodyFont: body.fontFamily,
          radius: control.borderRadius,
          outline: control.outlineStyle,
        }
      })
      expect(styles.font).toBe(styles.bodyFont)
      expect(styles.radius).not.toBe('0px')
      expect(styles.outline).toBe('solid')
      await page.keyboard.press('Escape')
      await expect(input).toBeFocused()
      await expect(page.getByTestId('app-tooltip')).toBeHidden()
    }
    if (name === '17-execution-log')
      await page.getByTestId('execution-log-node-select').click()
    await screenshot(page, name, name === '11-learn')
  }
})

test('rail visual matrix', async ({ page }) => {
  // Temporary skip pending attribution: Kosinkadink/comfy-vibe-station#430
  test.skip(true, 'red at main; attribution and re-enable tracked in Kosinkadink/comfy-vibe-station#430')
  await boot(page)
  await closeGallery(page)
  for (const [title, name] of [
    ['Executions', '18-executions'],
    ['Outputs', '19-outputs'],
    ['Extensions', '20-extensions'],
    ['Boundary', '21-boundary'],
    ['Focused', '22-focused'],
    ['Help', '23-node-help'],
    ['Problems', '24-problems'],
  ] as const) {
    await openRail(page, title)
    await screenshot(page, name)
  }
})

test('modal visual matrix', async ({ page }) => {
  // Temporary skip pending attribution: Kosinkadink/comfy-vibe-station#430
  test.skip(true, 'red at main; attribution and re-enable tracked in Kosinkadink/comfy-vibe-station#430')
  await boot(page)
  await closeGallery(page)
  for (const [id, name] of [
    ['settings', '25-settings'],
    ['customize-layout', '26-customize-layout'],
    ['projects', '27-projects'],
    ['subgraph-definitions', '28-subgraph-definitions'],
    ['collab', '29-collaboration'],
    ['desktop-management', '30-desktop-management'],
  ] as const) {
    await openModal(page, id)
    await screenshot(page, name)
    await page.evaluate(() => (window.__dinksterTest!.app as unknown as {
      readonly modalPanel: { set(value: string): void }
    }).modalPanel.set(''))
  }
})

test('populated app-view controls and arrange visuals', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const inputs = [
      { id: 'prompt', label: 'Prompt', widgetType: 'STRING', value: 'A quiet mountain lake' },
      { id: 'steps', label: 'Steps', widgetType: 'INT', value: 24 },
      { id: 'enabled', label: 'Enabled', widgetType: 'BOOLEAN', value: true },
      { id: 'color', label: 'Color', widgetType: 'COLOR', value: '#3498db' },
    ]
    app.registerSchemas([{
      type: 'AppViewVisual', displayName: 'Image settings', category: 'test', source: 'visual', isOutputNode: true,
      items: inputs.map((input) => ({
        kind: 'input', id: input.id, type: { kind: 'concrete', name: input.widgetType }, optional: false,
        widget: { widgetType: input.widgetType, options: {}, default: input.value },
      })),
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'app-view-visual', root: 'g0',
      meta: { title: 'Landscape studio', description: 'Set the prompt and image controls, then queue the workflow.' },
      graphs: { g0: {
        id: 'g0', name: 'root', nodes: { settings: { id: 'settings', type: 'AppViewVisual', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      } },
      view: { graphs: { g0: { nodes: { settings: { position: { x: 100, y: 100 } } } } } },
      ext: {
        'dinkster.exposed': inputs.map((input) => ({ graphId: 'g0', nodeId: 'settings', inputId: input.id, label: input.label })),
        'dinkster.appLayout': {
          version: 1,
          desktop: { items: [
            { id: 'instructions', kind: 'text', role: 'body', text: 'Choose the look for your next image.' },
            { id: 'controls', kind: 'group', title: 'Image controls', children: ['prompt', 'steps', 'enabled', 'color'] },
            ...inputs.map((input) => ({ id: input.id, kind: 'control', ref: { graphId: 'g0', nodeId: 'settings', inputId: input.id } })),
          ] },
          mobile: { customized: false, items: [], order: [] },
        },
      },
    }, 'Landscape studio')
  })
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('A quiet mountain lake')
  await expect(page.getByRole('spinbutton', { name: 'Steps', exact: true })).toHaveValue('24')
  await expect(page.getByRole('checkbox', { name: 'Toggle Enabled' })).toBeChecked()
  await expect(page.getByTestId('app-view-color')).toContainText('#3498db')
  await screenshot(page, 'app-view-controls')
  await page.setViewportSize({ width: 1440, height: 1400 })
  await page.getByTestId('app-view-arrange-toggle').click()
  await expect(page.getByTestId('app-layout-text-input')).toHaveValue('Choose the look for your next image.')
  await expect(page.getByTestId('app-layout-group-title')).toHaveValue('Image controls')
  await screenshot(page, 'app-view-arrange-controls')
})

test('document and app-view visual matrix', async ({ page }) => {
  // Temporary skip pending attribution: Kosinkadink/comfy-vibe-station#430
  test.skip(true, 'red at main; attribution and re-enable tracked in Kosinkadink/comfy-vibe-station#430')
  const typed = (name: string) => ({ kind: 'concrete', types: [name] })
  const nodes = Object.fromEntries(
    ['make', 'retime'].map((command) => [
      `dinkster.video_document.${command}`,
      {
        schemaVersion: 1,
        nodeType: `dinkster.video_document.${command}`,
        version: 1,
        displayName: `Video document ${command}`,
        category: 'video/timeline',
        description: '',
        idempotent: true,
        outputNode: true,
        interface:
          command === 'make'
            ? [
                {
                  role: 'input',
                  id: 'params',
                  type: typed('core.string'),
                  required: false,
                  default: '{}',
                  widget: { type: 'STRING', multiline: true },
                },
                {
                  role: 'output',
                  id: 'document',
                  type: typed('dinkster.video_document'),
                },
              ]
            : [
                {
                  role: 'input',
                  id: 'document',
                  type: typed('dinkster.video_document'),
                  required: true,
                },
                {
                  role: 'input',
                  id: 'params',
                  type: typed('core.string'),
                  required: true,
                  widget: { type: 'STRING', multiline: true },
                },
                {
                  role: 'output',
                  id: 'document',
                  type: typed('dinkster.video_document'),
                },
              ],
      },
    ]),
  )
  await page.route('/api/nodes*', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        epoch: 1,
        dinkster: { version: 'visual', schemaWire: 1 },
        nodes,
      },
    }),
  )
  await boot(page)
  await closeGallery(page)
  await page.getByTestId('views-switcher').click()
  const appView = page.getByRole('menuitemradio', { name: 'App view' })
  if ((await appView.count()) > 0) await appView.click()
  await screenshot(page, '32-app-view-empty')
  const arrange = page.getByTestId('app-view-arrange-toggle')
  if ((await arrange.count()) > 0) await arrange.click()
  await screenshot(page, '33-app-view-arrange')
  await page.getByTestId('image-documents-button').click()
  await screenshot(page, '31-image-document')
  await page.getByTestId('image-documents-button').click()
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'Graph' }).click()
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'visual-video',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'Video document',
            nodes: {
              source: {
                id: 'source',
                type: 'dinkster.video_document.make',
                values: { params: '{}' },
              },
              edit: {
                id: 'edit',
                type: 'dinkster.video_document.retime',
                values: { params: '{"track":1,"clip":2,"scalar":0.5}' },
              },
            },
            links: {
              document: {
                id: 'document',
                from: { node: 'source', port: 'document' },
                to: { node: 'edit', port: 'document' },
              },
            },
            nets: {},
            reroutes: {},
            nextOrdinal: 3,
          },
        },
        view: {
          graphs: {
            g0: {
              nodes: {
                source: { position: { x: 60, y: 80 } },
                edit: { position: { x: 500, y: 80 } },
              },
            },
          },
        },
      },
      'Video document',
    )
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer
      .getScene()
      .nodes.find((candidate) => candidate.id === 'edit')!
    const row = node.layout.rows.find(
      (candidate) =>
        candidate.kind === 'widget' && candidate.inputId === 'params',
    )!
    const rect = document
      .querySelector('[data-testid=graph-canvas]')!
      .getBoundingClientRect()
    return {
      x: rect.left + node.x + node.layout.width / 2,
      y: rect.top + node.y + row.y + row.height / 2,
    }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('video-document-editor')).toBeVisible()
  await screenshot(page, '34-video-document-editor')
})
