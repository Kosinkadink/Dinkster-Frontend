import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_ASSET_EDITOR_SHELL_PROOF_DIR'] ?? '/tmp/dinkster-asset-editor-shell-proof'

async function widgetPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const viewport = renderer.getViewport()
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'asset-editor-node')!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'asset')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  })
}

async function installFixture(page: Page): Promise<void> {
  const diagnostics = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const commandIds = [
      'asset-shell.edit-prompt',
      'asset-shell.export',
      'asset-shell.import',
      'asset-shell.open',
      'asset-shell.apply',
      'asset-shell.cancel-apply',
      'asset-shell.progress',
      'asset-shell.open-crop',
      'asset-shell.unsafe',
    ]
    const result = app.extensions.register({
      id: 'asset-shell',
      displayName: 'Asset editor shell proof',
      contributions: [
        { id: 'asset-shell.widget', category: 'widgetKind', label: 'Asset shell widget' },
        { id: 'asset-shell.view', category: 'widgetView', label: 'Asset shell view' },
        ...commandIds.map((id) => ({ id, category: 'command' as const, label: id })),
      ],
    }, (api) => {
      api.widgetKind('asset-shell.widget', {
        type: 'asset-shell.widget',
        valueSchema: { version: 1, validate: (value: unknown) => typeof value === 'string' },
        defaultValue: () => 'asset-portrait',
        validate: () => [],
        defaultView: () => 'asset-shell.view',
      })
      api.widgetView('asset-shell.view', {
        id: 'asset-shell.view',
        kind: 'asset-shell.widget',
        isCompatible: () => true,
        measure: () => ({ rows: 1 }),
        drawCompact(builder: {
          rect(x: number, y: number, width: number, height: number, style: object): void
          text(x: number, y: number, text: string, style: object): void
          hitRegion(x: number, y: number, width: number, height: number, action: string): void
        }) {
          builder.rect(0, 0, 1, 1, { role: 'widget' })
          builder.text(0, 0, 'Portrait study', { role: 'value' })
          builder.hitRegion(0, 0, 1, 1, 'widget.edit')
        },
        editorSizing: () => ({ preferred: { width: 920, height: 720 }, min: { width: 320, height: 320 } }),
        editorUi: () => ({
          version: 1,
          root: {
            kind: 'asset-editor',
            key: 'proof.asset-editor',
            presentation: {
              heading: 'Portrait study',
              description: 'Host-owned presentation of supplied asset state.',
              viewport: { label: 'Portrait preview', state: 'ready', detail: '2048 x 2048 responsive viewport' },
              fields: [
                { key: 'field.ui', kind: 'display', label: 'Prompt', value: 'Soft studio portrait with a very long authored description that remains contained', origin: { label: 'UI-authored', tone: 'accent' }, capability: { kind: 'editable' }, validation: { key: 'field.ui.validation', tone: 'warning', text: 'Review before export.' }, action: { key: 'field.ui.action', label: 'Edit Prompt', command: 'asset-shell.edit-prompt', state: 'enabled' } },
                { key: 'field.node', kind: 'display', label: 'Seed', value: '12345', origin: { label: 'Node-authored' }, capability: { kind: 'read-only', reason: 'Locked upstream.' } },
                { key: 'field.linked', kind: 'display', label: 'Dimensions', value: '2048 x 2048', origin: { label: 'Calculated / linked', tone: 'info' }, capability: { kind: 'read-only' } },
                { key: 'field.imported', kind: 'display', label: 'Color profile', value: 'Display P3', origin: { label: 'Imported' }, capability: { kind: 'editable' } },
                { key: 'field.mixed', kind: 'display', label: 'Description', value: 'Merged presentation', origin: { label: 'Mixed', tone: 'warning' }, capability: { kind: 'read-only' } },
                { key: 'field.unknown', kind: 'future-slider', label: 'Future field', value: 'Must remain hidden', capability: { kind: 'future-edit' }, action: { key: 'field.unknown.action', label: 'Unsafe', command: 'asset-shell.unsafe', state: 'enabled' } },
              ],
              messages: [
                { key: 'notice.version', tone: 'warning', text: 'Unsupported capability version supplied upstream.' },
                { key: 'notice.migration', tone: 'info', text: 'Normalization and migration notice supplied upstream.' },
                { key: 'notice.form', tone: 'error', text: 'Form-level validation requires attention.' },
              ],
              factGroups: [
                { key: 'facts.source', label: 'Source facts', facts: [
                  { key: 'source.absent', label: 'Capture', state: 'absent' },
                  { key: 'source.pending', label: 'Metadata', state: 'pending', detail: 'Reading' },
                  { key: 'source.ready', label: 'Input', state: 'ready', value: 'portrait.png' },
                  { key: 'source.error', label: 'Sidecar', state: 'error', detail: 'Unavailable' },
                ] },
                { key: 'facts.output', label: 'Output facts', facts: [
                  { key: 'output.absent', label: 'Published', state: 'absent' },
                  { key: 'output.pending', label: 'Preview', state: 'pending', detail: 'Preparing' },
                  { key: 'output.ready', label: 'Dimensions', state: 'ready', value: '2048 x 2048' },
                  { key: 'output.error', label: 'Thumbnail', state: 'error', detail: 'Failed upstream' },
                ] },
              ],
              tools: [
                { key: 'tool.absent', label: 'Timeline unavailable', state: 'absent' },
                { key: 'tool.loading', label: 'Timeline loading', state: 'loading', detail: 'Loading supplied timeline state' },
                { key: 'tool.ready', label: 'Crop ready', state: 'ready', actions: [{ key: 'tool.crop.open', label: 'Open crop controls', command: 'asset-shell.open-crop', state: 'enabled' }] },
                { key: 'tool.disabled', label: 'Crop disabled', state: 'disabled', detail: 'Disabled by supplied capability' },
                { key: 'tool.error', label: 'Timeline error', state: 'error', detail: 'Supplied tool error' },
              ],
              actions: [
                { key: 'action.export', label: 'Export', command: 'asset-shell.export', state: 'enabled' },
                { key: 'action.import', label: 'Import', command: 'asset-shell.import', state: 'disabled', disabledReason: 'Import unavailable.' },
                { key: 'action.open', label: 'Open in workflow', command: 'asset-shell.open', state: 'failed', detail: 'Previous request failed.' },
                { key: 'action.apply', label: 'Apply', command: 'asset-shell.apply', state: 'pending', detail: 'Applying supplied state' },
                { key: 'action.cancel-apply', label: 'Cancel apply', command: 'asset-shell.cancel-apply', state: 'enabled' },
                { key: 'action.progress', label: 'Background task', command: 'asset-shell.progress', state: 'pending', detail: 'Supplied pending state.' },
              ],
            },
          },
        }),
      })
      for (const id of commandIds) {
        api.command(id, {
          id,
          label: id,
          run: () => {
            const target = window as unknown as { __assetShellCommands?: string[] }
            target.__assetShellCommands ??= []
            target.__assetShellCommands.push(id)
          },
        })
      }
    })
    app.registerSchemas([{
      type: 'AssetEditorProof', displayName: 'Asset editor proof', category: 'proof', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'asset', type: { kind: 'concrete', name: 'asset-shell.widget' }, optional: false,
        widget: { widgetType: 'asset-shell.widget', options: {}, default: 'asset-portrait' },
      }],
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'asset-editor-shell-proof', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { 'asset-editor-node': { id: 'asset-editor-node', type: 'AssetEditorProof', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      } },
      view: { graphs: { g0: { nodes: { 'asset-editor-node': { position: { x: 32, y: 48 } } } } } },
    }, 'Asset editor shell proof')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    return result
  })
  expect(diagnostics).toEqual([])
}

async function openEditor(page: Page): Promise<void> {
  await installFixture(page)
  const point = await widgetPoint(page)
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('asset-editor-shell')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'none' }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'asset-editor-shell-proof', schemaWire: 1 },
    nodes: {},
  } }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
})

test('registered WidgetView presents the shell, keyboard regions, and bounded commands', async ({ page }) => {
  mkdirSync(proofDir, { recursive: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await openEditor(page)
  const shell = page.getByTestId('asset-editor-shell')
  await expect(shell.getByRole('tab', { name: 'Inspector' })).toBeFocused()
  await expect(shell).toContainText('UI-authored')
  await expect(shell).toContainText('Node-authored')
  await expect(shell).toContainText('Calculated / linked')
  await expect(shell).toContainText('Imported')
  await expect(shell).toContainText('Mixed')
  await expect(shell.getByTestId('asset-editor-shell-unsupported')).toContainText('Unsupported field presentation')
  await expect(shell).not.toContainText('Must remain hidden')
  await page.screenshot({ path: `${proofDir}/asset-editor-shell-1440x900-inspector.png`, animations: 'disabled' })

  await shell.getByRole('button', { name: 'Export' }).click()
  await shell.getByRole('button', { name: 'Cancel apply' }).click()
  expect(await page.evaluate(() => (window as unknown as { __assetShellCommands?: string[] }).__assetShellCommands)).toEqual([
    'asset-shell.export',
    'asset-shell.cancel-apply',
  ])
  await expect(shell.getByRole('button', { name: 'Import' })).toBeDisabled()
  await expect(shell.getByRole('button', { name: 'Open in workflow' })).toBeDisabled()
  await expect(shell.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled()
  await expect(shell.getByRole('button', { name: 'Background task' })).toBeDisabled()

  await shell.getByRole('tab', { name: 'Inspector' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(shell.getByRole('tab', { name: 'Editor' })).toBeFocused()
  await expect(shell.locator('[data-tool-state]')).toHaveCount(5)
  await shell.getByRole('button', { name: 'Open crop controls' }).click()
  await page.screenshot({ path: `${proofDir}/asset-editor-shell-1440x900-editor.png`, animations: 'disabled' })
})

test('shell stacks and remains reachable at narrow width', async ({ page }) => {
  mkdirSync(proofDir, { recursive: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Toggle right rail' }).click()
  await openEditor(page)
  const editor = page.getByTestId('widget-editor')
  const shell = page.getByTestId('asset-editor-shell')
  await shell.getByRole('tab', { name: 'Editor' }).click()
  await shell.getByRole('button', { name: 'Open crop controls' }).scrollIntoViewIfNeeded()
  await expect(shell.getByRole('button', { name: 'Open crop controls' })).toBeVisible()
  await shell.getByRole('button', { name: 'Export' }).scrollIntoViewIfNeeded()
  await expect(shell.getByRole('button', { name: 'Export' })).toBeVisible()
  const bounds = await editor.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: `${proofDir}/asset-editor-shell-390x844.png`, animations: 'disabled' })
})

test('shell remains contained at browser CSS 200 percent zoom', async ({ page }) => {
  mkdirSync(proofDir, { recursive: true })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.getByRole('button', { name: 'Toggle right rail' }).click()
  await openEditor(page)
  await page.evaluate(() => { document.documentElement.style.zoom = '2' })
  const editor = page.getByTestId('widget-editor')
  const shell = page.getByTestId('asset-editor-shell')
  await expect(shell).toBeVisible()
  await expect.poll(() => editor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await shell.getByText('Unsupported capability version supplied upstream.').scrollIntoViewIfNeeded()
  await expect(shell.getByText('Unsupported capability version supplied upstream.')).toBeVisible()
  const bounds = await editor.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1366)
  await page.screenshot({ path: `${proofDir}/asset-editor-shell-1366x768-zoom-200.png`, animations: 'disabled' })
})
