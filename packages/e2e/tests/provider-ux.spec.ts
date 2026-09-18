import { expect, test, type Page } from '@playwright/test'
import { openRailPanel } from './fixtures.js'

const catalog = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'provider-ux-proof', schemaWire: 38 },
  packs: {
    'dinkster-nodes-image': { displayName: 'Dinkster Image Nodes', abbr: 'DN' },
    'dinkster-nodes-generation': { displayName: 'Dinkster Generation', abbr: 'DG' },
  },
  nodes: {
    'test.ImageSource': {
      schemaVersion: 38,
      nodeType: 'test.ImageSource',
      displayName: 'Load Test Image',
      category: 'test',
      interface: [{ role: 'output', id: 'image', type: { kind: 'concrete', types: ['comfy.IMAGE'] } }],
      signature: 'provider-ux-image-source',
    },
    'test.ImageSink': {
      schemaVersion: 38,
      nodeType: 'test.ImageSink',
      displayName: 'Preview Image',
      category: 'test',
      outputNode: true,
      interface: [{ role: 'input', id: 'image', type: { kind: 'concrete', types: ['comfy.IMAGE'] } }],
      signature: 'provider-ux-image-sink',
    },
    'test.AdvancedControls': {
      schemaVersion: 38,
      nodeType: 'test.AdvancedControls',
      displayName: 'Advanced Controls',
      category: 'test',
      interface: [
        {
          role: 'input', id: 'prompt', displayName: 'Prompt', required: false,
          type: { kind: 'concrete', types: ['core.string'] }, default: '',
          widget: { type: 'STRING', multiline: true },
        },
        {
          role: 'input', id: 'policy', displayName: 'Policy', required: false,
          type: { kind: 'concrete', types: ['core.combo'] }, default: 'auto', advanced: true,
          widget: { type: 'COMBO', options: ['auto', 'quality'] },
        },
        {
          role: 'input', id: 'reference_image', displayName: 'Reference Image', required: false,
          type: { kind: 'concrete', types: ['comfy.IMAGE'] }, advanced: true,
        },
      ],
      signature: 'advanced-controls-proof',
    },
    'dinkster.preprocess.model_depth': {
      schemaVersion: 38,
      displayName: 'Preprocess Model Depth',
      category: 'Image',
      pack: 'dinkster-nodes-image',
      executionArms: ['native'],
      interface: [
        {
          role: 'input', id: 'model', displayName: 'Model', required: false,
          type: { kind: 'concrete', types: ['core.combo'] }, default: 'auto',
          widget: {
            type: 'COMBO',
            options: [
              { value: 'auto', label: 'Automatic' },
              { value: 'depth-anything-v3', label: 'Depth Anything V3' },
              { value: 'depth-anything-v2-large', label: 'Depth Anything V2 Large' },
            ],
          },
        },
        {
          role: 'input', id: 'provider', displayName: 'Provider', required: false,
          type: { kind: 'concrete', types: ['core.combo'] },
          widget: { type: 'COMBO', remote: { route: '/api/choices/dinkster.preprocess.model_depth.providers' } },
          hidden: true,
        },
      ],
    },
    'dinkster.preprocess.lineart_realistic': {
      schemaVersion: 38,
      displayName: 'Preprocess Realistic Line Art',
      category: 'Image',
      pack: 'dinkster-vision-hed',
      executionArms: ['native'],
      interface: [
        {
          role: 'input', id: 'image', displayName: 'Image', required: true,
          type: { kind: 'concrete', types: ['comfy.IMAGE'] },
        },
        {
          role: 'input', id: 'provider', displayName: 'Provider', required: false,
          type: { kind: 'concrete', types: ['core.combo'] },
          widget: { type: 'COMBO', remote: { route: '/api/choices/dinkster.preprocess.lineart_realistic.providers' } },
          hidden: true,
        },
        {
          role: 'output', id: 'image', displayName: 'Image',
          type: { kind: 'concrete', types: ['comfy.IMAGE'] },
        },
      ],
    },
    'dinkster.text_generate': {
      schemaVersion: 38,
      displayName: 'Generate Text',
      category: 'Generation',
      pack: 'dinkster-nodes-generation',
      executionArms: ['native'],
      interface: [
        {
          role: 'input', id: 'prompt', displayName: 'Prompt', required: false,
          type: { kind: 'concrete', types: ['core.string'] }, default: '',
          widget: { type: 'STRING', multiline: true },
        },
        {
          role: 'input', id: 'provider', displayName: 'Service', required: false,
          type: { kind: 'concrete', types: ['core.combo'] }, hidden: true,
          widget: {
            type: 'COMBO',
            options: [
              { value: 'builtin', label: 'Built-in' },
              { value: 'dinkster-nodes-generation-openai', label: 'Configured OpenAI-compatible service' },
            ],
          },
        },
      ],
    },
  },
}

async function sectionPoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nodeId) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === nodeId)!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'section' && candidate.sectionId === 'advanced')!
    const canvas = document.querySelector<HTMLElement>('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  }, nodeId)
}

test('node cards show intent controls without provider, arm, or pack leakage', async ({ page }, testInfo) => {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: {}, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: catalog }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest !== undefined)).toBe(true)

  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'provider-ux-proof',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'Implementation selection',
          nodes: {
            source: { id: 'source', type: 'test.ImageSource', values: {} },
            depth: { id: 'depth', type: 'dinkster.preprocess.model_depth', values: { model: 'auto' } },
            text: { id: 'text', type: 'dinkster.text_generate', values: {} },
            advanced: { id: 'advanced', type: 'test.AdvancedControls', values: {} },
          },
          links: {
            reference: {
              id: 'reference',
              from: { node: 'source', port: 'image' },
              to: { node: 'advanced', port: 'reference_image' },
            },
          },
          nets: {}, reroutes: {}, nextOrdinal: 5,
        },
      },
      view: {
        graphs: {
          g0: {
            nodes: {
              source: { position: { x: 120, y: 430 }, size: { width: 220, height: 0 } },
              depth: { position: { x: 220, y: 210 }, size: { width: 280, height: 0 } },
              text: { position: { x: 560, y: 210 }, size: { width: 320, height: 0 } },
              advanced: { position: { x: 500, y: 430 }, size: { width: 280, height: 0 } },
            },
          },
        },
      },
    } as never, 'Implementation Selection')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(4)
  const initial = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const rows = Object.fromEntries(renderer.getScene().nodes.map((node) => [
      node.id,
      node.layout.rows.map((row) => row.kind === 'widget'
        ? `widget:${row.inputId}`
        : row.kind === 'section'
          ? `section:${row.sectionId}:${row.collapsed ? 'collapsed' : 'expanded'}`
          : row.kind),
    ]))
    const badges = renderer.getBadges() as unknown as Readonly<Record<string, readonly { glyph: string }[]>>
    return { rows, badgeGlyphs: Object.values(badges).flat().map((badge) => badge.glyph) }
  })
  expect(initial.rows['depth']).toContain('widget:model')
  expect(initial.rows['depth']).not.toContain('widget:provider')
  expect(initial.rows['text']).not.toContain('widget:provider')
  expect(initial.rows['advanced']).toContain('section:advanced:collapsed')
  const collapsedAdvanced = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'advanced')!
    return {
      group: node.layout.advancedGroup,
      pins: node.layout.pins.filter((pin) => ['policy', 'reference_image'].includes(pin.portId)),
    }
  })
  expect(collapsedAdvanced.group).toBeUndefined()
  expect(collapsedAdvanced.pins).toHaveLength(1)
  expect(collapsedAdvanced.pins[0]).toMatchObject({ portId: 'reference_image', collapsedSection: 'advanced' })
  expect(initial.badgeGlyphs).not.toEqual(expect.arrayContaining(['NATIVE', 'N + C', 'COMFYUI', 'DN', 'DG']))
  const builtin = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const compiled = app.compileTab(tab)
    if (compiled === undefined || !compiled.ok) throw new Error('provider UX fixture did not compile')
    const prompt = (compiled.artifact as unknown as {
      prompt: Record<string, { inputs: Record<string, unknown> }>
    }).prompt
    return {
      stored: tab.store.doc.graphs.g0!.nodes.text!.values.provider,
      submitted: prompt.text!.inputs.provider,
    }
  })
  expect(builtin).toEqual({ stored: undefined, submitted: undefined })

  const collapsed = testInfo.outputPath('provider-ux-collapsed.png')
  await page.screenshot({ path: collapsed, fullPage: true })
  await testInfo.attach('intent controls without implementation badges', { path: collapsed, contentType: 'image/png' })

  const point = await sectionPoint(page, 'advanced')
  await page.mouse.click(point.x, point.y)
  await expect.poll(() => page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'advanced')!
    return node.layout.rows.map((row) => row.kind === 'widget' ? row.inputId : row.kind)
  })).toContain('policy')
  expect(await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'advanced')!
    const group = node.layout.advancedGroup
    const policy = node.layout.rows.find((row) => row.kind === 'widget' && row.inputId === 'policy')
    const reference = node.layout.rows.find((row) => row.kind === 'ports' && row.input?.portId === 'reference_image')
    return {
      bounded: group !== undefined
        && policy !== undefined
        && reference !== undefined
        && policy.y >= group.y
        && policy.y + policy.height <= group.y + group.height
        && reference.y >= group.y
        && reference.y + reference.height <= group.y + group.height,
      pinCount: node.layout.pins.filter((pin) => pin.portId === 'policy').length,
      referencePinCount: node.layout.pins.filter((pin) => pin.portId === 'reference_image').length,
    }
  })).toEqual({ bounded: true, pinCount: 2, referencePinCount: 1 })

  const connectable = testInfo.outputPath('provider-ux-advanced-connectable.png')
  await page.screenshot({ path: connectable, fullPage: true })
  await testInfo.attach('bounded advanced connectable input', { path: connectable, contentType: 'image/png' })

  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({
      command: 'view.setNodeSize',
      params: { graphId: 'g0', nodeId: 'advanced', size: { width: 200, height: 0 } },
    })
  })
  await expect.poll(() => page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'advanced')!
    return node.layout.width
  })).toBe(200)
  const compact = testInfo.outputPath('provider-ux-advanced-compact.png')
  await page.screenshot({ path: compact, fullPage: true })
  await testInfo.attach('bounded advanced group on compact node', { path: compact, contentType: 'image/png' })
})

test('unavailable vision capability identifies and anchors Preprocess Realistic Line Art', async ({ page }, testInfo) => {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: {}, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: catalog }))
  await page.route('/api/assets', (route) => route.fulfill({ status: 404, json: { error: 'no fixture library' } }))
  await page.route('/api/jobs', (route) => route.fulfill({
    status: 400,
    json: {
      error: 'capability-unavailable',
      diagnostics: [{
        severity: 'error',
        code: 'capability-unavailable',
        message: 'Preprocess Realistic Line Art cannot run because a compatible vision-processing implementation is unavailable on this server. Install or reconnect the standard vision components, then retry.',
        nodeId: 'realistic-line-art',
        nodeType: 'dinkster.preprocess.lineart_realistic',
        title: 'Preprocess Realistic Line Art',
        capability: 'a compatible vision-processing implementation',
        remedy: 'Install or reconnect the standard vision components, then retry.',
      }],
    },
  }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest !== undefined)).toBe(true)

  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'provider-capability-proof',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'Vision preprocessing',
          nodes: {
            source: { id: 'source', type: 'test.ImageSource', values: {} },
            'realistic-line-art': {
              id: 'realistic-line-art',
              type: 'dinkster.preprocess.lineart_realistic',
              values: {},
            },
            preview: { id: 'preview', type: 'test.ImageSink', values: {} },
          },
          links: {
            input: {
              id: 'input',
              from: { node: 'source', port: 'image' },
              to: { node: 'realistic-line-art', port: 'image' },
            },
            output: {
              id: 'output',
              from: { node: 'realistic-line-art', port: 'image' },
              to: { node: 'preview', port: 'image' },
            },
          },
          nets: {}, reroutes: {}, nextOrdinal: 4,
        },
      },
      view: {
        graphs: {
          g0: {
            nodes: {
              source: { position: { x: 100, y: 260 }, size: { width: 240, height: 0 } },
              'realistic-line-art': { position: { x: 420, y: 260 }, size: { width: 340, height: 0 } },
              preview: { position: { x: 840, y: 260 }, size: { width: 240, height: 0 } },
            },
          },
        },
      },
    } as never, 'Vision Preprocessing')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(3)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queue(app.activeTab()!)
  })

  await openRailPanel(page, 'Problems')
  const panel = page.getByTestId('problems-panel')
  await expect(panel).toContainText('Preprocess Realistic Line Art')
  await expect(panel).toContainText('compatible vision-processing implementation')
  await expect(panel).toContainText('Install or reconnect the standard vision components, then retry.')
  const problem = panel.locator('details.problem[data-activatable="true"]')
  await expect(problem).toHaveCount(1)
  await problem.locator('summary').click()
  await problem.getByRole('button', { name: 'Show on canvas' }).click()
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')
  expect(await page.evaluate(() => (
    window.__dinksterTest!.app as unknown as {
      canvasBridge: { get(): { selectedNodes(): readonly string[] } }
    }
  ).canvasBridge.get().selectedNodes())).toEqual(['realistic-line-art'])

  const screenshot = testInfo.outputPath('provider-capability-error.png')
  await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' })
  await testInfo.attach('actionable vision capability error', { path: screenshot, contentType: 'image/png' })
})
