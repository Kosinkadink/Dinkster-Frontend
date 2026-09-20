import { mkdirSync } from 'node:fs'
import { expect, openRailPanel, test, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_CUSTOM_WIDGET_PROOF_DIR']

async function widgetPoint(page: Page): Promise<[number, number]> {
  return page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const viewport = renderer.getViewport()
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'blob')!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'size')!
    const canvas = document.querySelector<HTMLElement>('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return [
      canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      canvas.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    ]
  })
}

test('a pack-declared custom widget uses its extension kind and reports the raw fallback', async ({ page }) => {
  if (proofDir !== undefined) mkdirSync(proofDir, { recursive: true })
  await page.routeWebSocket('**/ws*', () => {})
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: { diagnostics: [] } }))
  await page.route('/api/composition', (route) => route.fulfill({ json: {} }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 44,
    epoch: 1,
    dinkster: { version: 'pack-custom-widget-e2e', schemaWire: 44 },
    packs: { isopack: { displayName: 'Isolated Pack' } },
    nodes: {
      'iso.blob_out': {
        schemaVersion: 44,
        displayName: 'Blob Out',
        category: 'test',
        pack: 'isopack',
        interface: [{
          role: 'input', id: 'size', type: { kind: 'concrete', types: ['core.int'] },
          required: false, default: 8,
          widget: { type: 'isopack.size', min: 1, max: 12, unit: 'bytes' },
        }],
      },
    },
  } }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('1 node schemas', { timeout: 15_000 })

  await page.evaluate(() => {
    const diagnostics = window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'pack-custom-widget', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { blob: { id: 'blob', type: 'iso.blob_out', values: { size: 8 } } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      } },
      view: { graphs: { g0: { nodes: { blob: { position: { x: 220, y: 180 } } } } } },
    }, 'Pack custom widget')
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
  })
  await openRailPanel(page, 'Problems')
  await expect(page.getByTestId('problems-panel')).toContainText("widget kind 'isopack.size' is not available; using the raw-value editor")
  await page.mouse.click(...await widgetPoint(page))
  await expect(page.getByTestId('widget-editor')).toHaveAttribute('data-editor-mode', 'raw')
  await expect(page.getByTestId('widget-editor').locator('textarea')).toHaveValue('8')
  await page.keyboard.press('Escape')

  expect(await page.evaluate(() => window.__dinksterTest!.app.extensions.register(
    {
      id: 'isopack', displayName: 'Isolated Pack UI',
      contributions: [
        { id: 'isopack.size', category: 'widgetKind', label: 'Pack size' },
        { id: 'isopack.size.view', category: 'widgetView', label: 'Pack size view' },
      ],
    },
    (api) => {
      api.widgetKind('isopack.size', {
        type: 'isopack.size',
        valueSchema: { version: 1, validate: (value: unknown) => Number.isInteger(value) },
        defaultValue: (options: Readonly<Record<string, unknown>>) => options['min'],
        validate: () => [],
        defaultView: () => 'isopack.size.view',
      })
      api.widgetView('isopack.size.view', {
        id: 'isopack.size.view', kind: 'isopack.size', isCompatible: () => true,
        measure: () => ({ rows: 1 }),
        drawCompact(builder: {
          rect(x: number, y: number, width: number, height: number, style: object): void
          text(x: number, y: number, text: string, style: object): void
          hitRegion(x: number, y: number, width: number, height: number, action: string): void
        }, value: unknown) {
          builder.rect(0, 0, 1, 1, { role: 'widget' })
          builder.text(0, 0, `${String(value)} bytes`, { role: 'value' })
          builder.hitRegion(0, 0, 1, 1, 'widget.edit')
        },
        editorUi: (context: { data: unknown }) => ({
          version: 1,
          root: { kind: 'text', key: 'size', text: `Pack size: ${(context.data as { value: number }).value} bytes`, tone: 'accent' },
        }),
      })
    },
  ))).toEqual([])

  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes[0]?.layout.rows
      .find((row) => row.kind === 'widget' && row.inputId === 'size')?.viewId,
  )).toBe('isopack.size.view')
  await page.mouse.click(...await widgetPoint(page))
  await expect(page.getByTestId('widget-editor')).toBeVisible()
  await expect(page.getByTestId('widget-editor-host-ui')).toContainText('Pack size: 8 bytes')

  const screenshot = proofDir === undefined ? test.info().outputPath('pack-custom-widget.png') : `${proofDir}/pack-custom-widget.png`
  await page.screenshot({ path: screenshot, animations: 'disabled', fullPage: true })
  await test.info().attach('pack-custom-widget', { path: screenshot, contentType: 'image/png' })
})
