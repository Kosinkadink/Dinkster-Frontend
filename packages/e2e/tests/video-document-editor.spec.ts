import { expect, test, type Page, type TestInfo } from '@playwright/test'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
const commands = [
  'make', 'add_clip', 'add_track', 'set_effect', 'transition', 'retime', 'mix_audio',
  'split', 'move', 'trim', 'ripple', 'roll', 'bind_source', 'render', 'import_otio', 'export_otio',
] as const
const mutations = commands.filter((command): command is Exclude<typeof command, 'make' | 'render' | 'import_otio' | 'export_otio'> =>
  !['make', 'render', 'import_otio', 'export_otio'].includes(command))
const typed = (name: string) => ({ kind: 'concrete', types: [name] })
const input = (id: string, type: string, options: { optional?: boolean; default?: unknown; multiline?: boolean } = {}) => ({
  role: 'input', id, type: typed(type), required: options.optional !== true,
  ...(options.default === undefined ? {} : { default: options.default }),
  ...(options.multiline ? { widget: { type: 'STRING', multiline: true } } : {}),
})
const output = (id: string, type: string) => ({ role: 'output', id, type: typed(type) })
const schema = (command: typeof commands[number]) => ({
  schemaVersion: 38,
  nodeType: `dinkster.video_document.${command}`,
  version: 1,
  displayName: `Video document ${command}`,
  category: 'video/timeline',
  description: '',
  idempotent: true,
  outputNode: true,
  interface: command === 'make'
    ? [input('params', 'core.string', { optional: true, default: '{}', multiline: true }), output('document', 'dinkster.video_document')]
    : command === 'render'
      ? [input('document', 'dinkster.video_document'), output('video', 'comfy.VIDEO')]
      : command === 'import_otio'
        ? [input('otio', 'core.string', { multiline: true }), output('document', 'dinkster.video_document')]
        : command === 'export_otio'
          ? [input('document', 'dinkster.video_document'), output('otio', 'core.string')]
          : [
              input('document', 'dinkster.video_document'),
              input('params', 'core.string', { multiline: true }),
              ...(command === 'bind_source' ? [input('video', 'comfy.VIDEO', { optional: true })] : []),
              output('document', 'dinkster.video_document'),
            ],
})
const catalog = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'video-document-editor-test', schemaWire: 38 },
  nodes: Object.fromEntries(commands.map((command) => [`dinkster.video_document.${command}`, schema(command)])),
}

test.beforeEach(async ({ page }) => {
  await page.route('/api/**', (route) => route.fulfill({ status: 404, json: { error: 'Isolated fixture' } }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated fixture' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'test' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: catalog }))
  if (process.env['DINKSTER_E2E_USE_NATIVE'] !== '1') await page.routeWebSocket('**/api/events?*', () => {})
})

async function openCommand(page: Page, command: typeof commands[number], value?: string) {
  const editable = command === 'import_otio' ? 'otio' : 'params'
  if (page.url() === 'about:blank') await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(commands.length)
  await page.evaluate(({ command, value }) => {
    const inputId = command === 'import_otio' ? 'otio' : 'params'
    const needsDocument = !['make', 'import_otio'].includes(command)
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: `video-document-${command}`, root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Video document', nodes: {
        source: { id: 'source', type: 'dinkster.video_document.make', values: { params: '{}' } },
        edit: { id: 'edit', type: `dinkster.video_document.${command}`, values: value === undefined ? {} : { [inputId]: value } },
      }, links: needsDocument ? { document: { id: 'document', from: { node: 'source', port: 'document' }, to: { node: 'edit', port: 'document' } } } : {}, nets: {}, reroutes: {}, nextOrdinal: 3 } },
      view: { graphs: { g0: { nodes: { source: { position: { x: 60, y: 80 } }, edit: { position: { x: 500, y: 80 } } } } } },
    }, `Video document ${command}`)
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, { command, value })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.some((node) => node.id === 'edit'))).toBe(true)
  const point = await page.evaluate((inputId) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'edit')!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === inputId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  }, editable)
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('video-document-editor')).toBeVisible()
}

test('every authored command input opens the video document editor and terminal commands retain exact graph ports', async ({ page }) => {
  for (const command of [...mutations, 'make', 'import_otio'] as const) {
    await openCommand(page, command)
    await expect(page.getByTestId('video-document-editor')).toHaveAttribute('data-command', command)
    await page.getByTestId('video-document-cancel').click()
  }
  expect(catalog.nodes['dinkster.video_document.render']!.interface.map((entry) => entry.id)).toEqual(['document', 'video'])
  expect(catalog.nodes['dinkster.video_document.export_otio']!.interface.map((entry) => entry.id)).toEqual(['document', 'otio'])
  expect(catalog.nodes['dinkster.video_document.bind_source']!.interface.map((entry) => entry.id)).toEqual(['document', 'params', 'video', 'document'])
})

test('editor-authored parameters compile, save, reopen, import, and undo as ordinary graph values', async ({ page }, info) => {
  const initial = JSON.stringify({ track: 1, clip: 2, scalar: 0.5, future: { keep: true } })
  await openCommand(page, 'retime', initial)
  await page.getByTestId('video-document-scalar').fill('-2')
  await page.getByTestId('video-document-scalar').press('Tab')
  await page.getByTestId('widget-modal-surface').screenshot({ path: info.outputPath('video-document-retime.png') })
  await page.getByTestId('video-document-apply').click()
  const expected = JSON.stringify({ track: 1, clip: 2, scalar: -2, future: { keep: true } })
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.edit!.values.params)).toBe(expected)
  await page.getByTestId('graph-canvas').focus()
  await page.keyboard.press('Control+z')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.edit!.values.params)).toBe(initial)
  await page.keyboard.press('Control+Shift+z')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.edit!.values.params)).toBe(expected)
  const compiled = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const result = app.compileTab(app.activeTab()!)
    if (!result?.ok || !result.artifact.prompt) throw new Error('Compile failed')
    return { workflow: app.exportDocument(app.activeTab()!.id), prompt: result.artifact.prompt }
  })
  expect(compiled.prompt.edit!.inputs.params).toBe(expected)
  expect(await page.evaluate((workflow) => window.__dinksterTest!.app.openDocument(workflow, 'Reopened', undefined, true), compiled.workflow)).toEqual([])
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.edit!.values.params)).toBe(expected)
})

test('timeline, effect, audio, source, interchange, and validation states remain usable and bounded', async ({ page }, info) => {
  const states = [
    ['make', 'video-document-make.png'],
    ['add_clip', 'video-document-add-clip.png'],
    ['add_track', 'video-document-add-track.png'],
    ['transition', 'video-document-transition.png'],
    ['retime', 'video-document-retime-empty.png'],
    ['split', 'video-document-split.png'],
    ['move', 'video-document-move.png'],
    ['trim', 'video-document-trim.png'],
    ['ripple', 'video-document-ripple.png'],
    ['roll', 'video-document-roll.png'],
    ['set_effect', 'video-document-effect.png'],
    ['mix_audio', 'video-document-audio.png'],
    ['bind_source', 'video-document-source.png'],
    ['import_otio', 'video-document-interchange.png'],
  ] as const
  for (const [command, file] of states) {
    await openCommand(page, command)
    await expect(page.getByTestId('video-document-error')).toHaveCount(0)
    await page.getByTestId('widget-modal-surface').screenshot({ path: info.outputPath(file) })
    await page.getByTestId('video-document-cancel').click()
  }
  await openCommand(page, 'set_effect')
  await page.getByTestId('video-document-effect').fill('{bad')
  await page.getByTestId('video-document-effect').press('Tab')
  await expect(page.getByTestId('video-document-error')).toBeVisible()
  await expect(page.getByTestId('video-document-apply')).toBeDisabled()
  await page.getByTestId('widget-modal-surface').screenshot({ path: info.outputPath('video-document-validation.png') })
  expect(await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => name.includes('/api/')))).toEqual([])
})

test('native execution matches editor-authored and literal values for every command family', async ({ page }, info) => {
  test.setTimeout(120_000)
  test.skip(process.env['DINKSTER_E2E_USE_NATIVE'] !== '1' || process.env['DINKSTER_NATIVE_BACKEND'] === undefined,
    'set DINKSTER_E2E_USE_NATIVE=1 and DINKSTER_NATIVE_BACKEND to an isolated Dinkster backend')
  const rationalTime = (value: number) => ({ OTIO_SCHEMA: 'RationalTime.1', value, rate: 1 })
  const timeRange = (start: number, duration: number) => ({
    OTIO_SCHEMA: 'TimeRange.1', start_time: rationalTime(start), duration: rationalTime(duration),
  })
  const clip = (source: string, name: string, duration = 2) => ({
    OTIO_SCHEMA: 'Clip.2', name, source_range: timeRange(0, duration), effects: [], markers: [], metadata: {
      dinkster: { source },
    },
    active_media_reference_key: 'DEFAULT_MEDIA',
    media_references: { DEFAULT_MEDIA: {
      OTIO_SCHEMA: 'MissingReference.1', name: '', metadata: {}, available_range: timeRange(0, duration), available_image_bounds: null,
    } },
  })
  const baseParams = {
    width: 320, height: 180, rate: 12, name: 'Parity',
    clips: [clip('first', 'First'), clip('second', 'Second')],
  }
  const videoReference = {
    type: 'comfy.VIDEO',
    asset: {
      digest: `blake3:${'a'.repeat(64)}`, name: 'source.mp4', size: 1,
      mediaType: 'video/mp4', virtualPath: 'source.mp4',
    },
  }
  const params = {
    make: baseParams,
    add_clip: { track: 0, item: clip('inserted', 'Inserted', 1), index: 1 },
    add_track: { kind: 'Audio', name: 'Audio', blend: 'normal', opacity: 0.5 },
    set_effect: { track: 0, clip: 0, effect: { node_type: 'dinkster.image.draw_text', parameters: { text: 'Title' } } },
    transition: { track: 0, clip: 0, in_offset: 0.25, out_offset: 0.25 },
    retime: { track: 0, clip: 0, scalar: -2 },
    mix_audio: { track: 0, audio_mix: { gain: 0.5 } },
    split: { track: 0, clip: 0, position: 0.5 },
    move: { track: 0, clip: 0, to_track: 0, index: 1 },
    trim: { track: 0, clip: 0, start_time: 0.25, duration: 1, strict_duration: true },
    ripple: { track: 0, clip: 0, start_time: 0.25, duration: 1, strict_duration: true },
    roll: { track: 0, clip: 0, delta: 0.25 },
    bind_source: { source: 'video', reference: videoReference },
  } as const
  const otio = JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1', name: 'Imported', metadata: {}, global_start_time: null,
    tracks: {
      OTIO_SCHEMA: 'Stack.1', name: 'tracks', metadata: {}, source_range: null,
      effects: [], markers: [], children: [],
    },
  })
  const authored: Record<string, string> = {}
  for (const command of ['make', ...mutations] as const) {
    await openCommand(page, command, '{}')
    for (const [key, value] of Object.entries(params[command])) {
      const control = page.getByTestId(`video-document-${key.replaceAll('_', '-')}`)
      if (typeof value === 'boolean') await control.click()
      else if (key === 'kind') await control.selectOption(String(value))
      else {
        await control.fill(typeof value === 'object' ? JSON.stringify(value) : String(value))
        await control.press('Tab')
      }
    }
    await page.getByTestId('video-document-apply').click()
    authored[command] = await page.evaluate(() =>
      window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.edit!.values.params as string)
    expect(JSON.parse(authored[command]!)).toEqual(params[command])
  }
  await openCommand(page, 'import_otio', '')
  await page.getByTestId('video-document-otio').fill(otio)
  await page.getByTestId('video-document-apply').click()
  authored['import_otio'] = await page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.edit!.values.otio as string)
  expect(authored['import_otio']).toBe(otio)

  await page.unroute('/api/**')
  await page.unroute('/api/nodes*')
  const response = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(3_000) })
  expect(response.ok).toBe(true)
  const served = await response.json() as { nodes: Record<string, unknown> }
  expect(commands.every((command) => `dinkster.video_document.${command}` in served.nodes)).toBe(true)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app !== undefined), { timeout: 15_000 }).toBe(true)
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.app.backends.get()[0]?.registry.get()?.schemas.has('dinkster.video_document.make') ?? false,
  ), { timeout: 15_000 }).toBe(true)
  const executionPairs = await page.evaluate(({ authored, params, otio }) => {
    const nodes: Record<string, { id: string; type: string; values: Record<string, string> }> = {}
    const links: Record<string, { id: string; from: { node: string; port: string }; to: { node: string; port: string } }> = {}
    const positions: Record<string, { position: { x: number; y: number } }> = {}
    const pairs: Array<{ command: string; editor: string; literal: string; output: string }> = []
    let ordinal = 1
    const addNode = (id: string, command: string, values: Record<string, string> = {}) => {
      nodes[id] = { id, type: `dinkster.video_document.${command}`, values }
      positions[id] = { position: { x: 80 + ((ordinal - 1) % 6) * 360, y: 80 + Math.floor((ordinal - 1) / 6) * 220 } }
      ordinal += 1
    }
    const addLink = (id: string, from: string, to: string) => {
      links[id] = { id, from: { node: from, port: 'document' }, to: { node: to, port: 'document' } }
    }
    const addPair = (command: string, output: string) => {
      pairs.push({ command, editor: `editor-${command}`, literal: `literal-${command}`, output })
    }

    addNode('editor-make', 'make', { params: authored.make! })
    addNode('literal-make', 'make', { params: JSON.stringify(params.make) })
    addPair('make', 'document')
    for (const command of Object.keys(params).filter((value) => value !== 'make')) {
      const base = `base-${command}`
      addNode(base, 'make', { params: JSON.stringify(params.make) })
      addNode(`editor-${command}`, command, { params: authored[command]! })
      addNode(`literal-${command}`, command, { params: JSON.stringify(params[command as keyof typeof params]) })
      addLink(`link-${command}-editor`, base, `editor-${command}`)
      addLink(`link-${command}-literal`, base, `literal-${command}`)
      addPair(command, 'document')
    }
    addNode('editor-import_otio', 'import_otio', { otio: authored.import_otio! })
    addNode('literal-import_otio', 'import_otio', { otio })
    addPair('import_otio', 'document')
    for (const command of ['export_otio', 'render']) {
      const base = `base-${command}`
      addNode(base, 'make', { params: command === 'render' ? '{}' : JSON.stringify(params.make) })
      addNode(`editor-${command}`, command)
      addNode(`literal-${command}`, command)
      addLink(`link-${command}-editor`, base, `editor-${command}`)
      addLink(`link-${command}-literal`, base, `literal-${command}`)
      addPair(command, command === 'render' ? 'video' : 'otio')
    }
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'video-document-native-parity', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Parity', nodes, links, nets: {}, reroutes: {}, nextOrdinal: ordinal } },
      view: { graphs: { g0: { nodes: positions } } },
    }, 'Native video document parity')
    return pairs
  }, { authored, params, otio })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBeGreaterThan(40)
  const compiled = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const result = app.compileTab(tab)
    if (!result?.ok || !result.artifact.prompt) throw new Error('Compile failed')
    return result.artifact.prompt
  })
  for (const pair of executionPairs) {
    if (pair.command === 'render' || pair.command === 'export_otio') continue
    const input = pair.command === 'import_otio' ? 'otio' : 'params'
    expect(compiled[pair.editor]!.inputs[input]).toBe(compiled[pair.literal]!.inputs[input])
  }
  await page.evaluate(async (nodeIds) => {
    const app = window.__dinksterTest!.app
    await app.queueSelection(app.activeTab()!, nodeIds)
  }, executionPairs.flatMap((pair) => [pair.editor, pair.literal]))
  await expect.poll(() => page.evaluate(() => {
    const executions = [...window.__dinksterTest!.app.store.executions.get().values()]
      .sort((left, right) => right.queuedAt - left.queuedAt)
    return executions[0]?.status
  }), { timeout: 30_000 }).toBe('completed')
  const outputs = await page.evaluate((pairs) => {
    const execution = [...window.__dinksterTest!.app.store.executions.get().values()]
      .sort((left, right) => right.queuedAt - left.queuedAt)[0]!
    const nodes = execution.nodes as Record<string, { outputs?: Record<string, unknown> }>
    return pairs.map((pair) => ({
      command: pair.command,
      editor: nodes[pair.editor]?.outputs?.[pair.output],
      literal: nodes[pair.literal]?.outputs?.[pair.output],
    }))
  }, executionPairs)
  for (const output of outputs) {
    expect(output.editor, `${output.command} editor output`).toBeDefined()
    expect(output.editor, `${output.command} native parity`).toEqual(output.literal)
  }
  await info.attach('native-video-document-parity.json', {
    body: JSON.stringify({ backend: NATIVE_BACKEND, authored, outputs }, null, 2), contentType: 'application/json',
  })
})
