import { expect, test, type Page } from './fixtures.js'

async function openDescriptors(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((node) => node.id === 'n')!
    const row = node.layout.rows.find((row) => row.kind === 'widget' && row.inputId === 'entries')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const vp = renderer.getViewport()
    return { x: rect.left + vp.x + (node.x + node.layout.width / 2) * vp.scale, y: rect.top + vp.y + (node.y + row.y + row.height / 2) * vp.scale }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('output-descriptor-editor')).toBeVisible()
}

async function setup(page: Page, mode: boolean | 'fixed' = false): Promise<void> {
  await page.routeWebSocket('**/ws**', (socket) => socket.close())
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated mock' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  await expect(page.getByTestId('status-bar')).toContainText('0 node schemas', { timeout: 15_000 })
  await page.evaluate((mode) => {
    const profile = mode === true
    const fixedIds = mode !== false
    const choices = profile
      ? ['model', 'clip', 'vae'].map((id) => ({ id, type: { kind: 'concrete' as const, name: `dinkster.${id}` }, displayName: id.toUpperCase() }))
      : ['float', 'string'].map((id) => ({ id, type: { kind: 'concrete' as const, name: `core.${id}` } }))
    const entries = profile ? [] : [
      { id: fixedIds ? 'float' : 'm0', name: 'Result', type: 'float', expression: 'a+b' },
      { id: fixedIds ? 'string' : 'm1', name: 'Caption', type: 'string', value: 'hello' },
    ]
    const source = JSON.stringify({ entries, extra: { preserved: true } })
    const nodeType = profile ? 'dinkster.load_model_profile' : 'DescriptorFixture'
    window.__dinksterTest!.app.registerSchemas([{
      type: nodeType, displayName: profile ? 'Load Model Profile' : 'Named Expressions', category: 'test', source: 'v3', isOutputNode: true,
      items: [
        ...(profile ? [{ kind: 'input' as const, id: 'checkpoint', type: { kind: 'concrete' as const, name: 'dinkster.asset' }, optional: false, widget: { widgetType: 'ASSET', options: {} } }] : []),
        { kind: 'input', id: 'entries', displayName: 'Output schema', type: { kind: 'concrete', name: 'core.string' }, optional: false, widget: { widgetType: 'STRING', options: {}, default: source } },
        { kind: 'output', id: 'entries', type: choices[0]!.type, outputDescriptors: { input: 'entries', choices, minEntries: profile ? 1 : 0, maxEntries: profile ? 3 : 32, fixedIds, ...(profile ? { probe: { input: 'checkpoint', kind: 'model' as const, revision: '1' } } : {}) } },
      ],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'descriptor-browser', root: 'root',
      graphs: { root: { id: 'root', name: 'Descriptor editor', nodes: { n: { id: 'n', type: nodeType, values: { entries: source, ...(profile ? { checkpoint: { digest: `blake3:${'1'.repeat(64)}`, name: 'model.safetensors' } } : {}) } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 10 } },
      view: { graphs: { root: { nodes: { n: { position: { x: 130, y: 100 }, size: { width: 350, height: 190 } } } } } },
    }, 'Output descriptors')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, mode)
}

const stored = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!.nodes.n!.values.entries as string)
const pins = (page: Page) => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'n')!.layout.pins.filter((pin) => pin.direction === 'out' && !pin.widgetTap).map((pin) => pin.address.port))

test('production descriptor editor preserves IDs, extra fields, undo and typed rows', async ({ page }, info) => {
  await setup(page)
  expect(await pins(page)).toEqual(['m0', 'm1'])
  await openDescriptors(page)
  await page.getByLabel('Output 1 name', { exact: true }).fill('Sum')
  await page.getByLabel('Output 1 name', { exact: true }).press('Tab')
  await page.getByRole('button', { name: 'Move output 2 up' }).click()
  await expect(page.getByLabel('Output 1 ID', { exact: true })).toHaveValue('m1')
  await page.screenshot({ path: info.outputPath('descriptor-editor.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 800, height: 650 })
  await page.getByTestId('output-descriptors-apply').scrollIntoViewIfNeeded()
  expect(await page.getByTestId('widget-editor').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: info.outputPath('descriptor-editor-compact.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 1600, height: 950 })
  await page.getByTestId('output-descriptors-apply').click()
  expect(JSON.parse(await stored(page))).toEqual({ entries: [
    { id: 'm1', name: 'Caption', type: 'string', value: 'hello' },
    { id: 'm0', name: 'Sum', type: 'float', expression: 'a+b' },
  ], extra: { preserved: true } })
  expect(await pins(page)).toEqual(['m1', 'm0'])
  await page.screenshot({ path: info.outputPath('descriptor-typed-outputs.png'), animations: 'disabled' })
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect(await pins(page)).toEqual(['m0', 'm1'])
  await openDescriptors(page)
  await page.getByRole('button', { name: 'Stored JSON', exact: true }).click()
  await page.getByLabel('Descriptor document', { exact: true }).fill('{"entries":[{"id":"bad.id","name":"Bad","type":"float"}]}')
  await expect(page.getByTestId('output-descriptors-apply')).toBeDisabled()
  await expect(page.getByTestId('output-descriptor-editor')).toContainText('Output IDs must be unique')
})

test('profile probe uses asset identity, rejects connection races, and inactivates old outputs', async ({ page }, info) => {
  await setup(page, true)
  let release: (() => void) | undefined
  let requested = false
  await page.route('**/api/output-profiles/model?**', async (route) => {
    const url = new URL(route.request().url())
    expect(url.searchParams.get('revision')).toBe('1')
    expect(url.searchParams.get('digest')).toMatch(/^blake3:[0-9a-f]{64}$/)
    requested = true
    await new Promise<void>((resolve) => { release = resolve })
    await route.fulfill({ json: {
      entries: [{ id: 'model', name: 'Model', type: 'model' }, { id: 'vae', name: 'VAE', type: 'vae' }],
      assetDigest: url.searchParams.get('digest'), detectorRevision: '1', shapeDigest: `sha256:${'a'.repeat(64)}`, components: {}, diagnostics: ['Metadata diagnostic does not block this profile.'],
    } })
  })
  await openDescriptors(page)
  await expect(page.getByTestId('output-descriptor-editor')).toContainText('require 1..3 entries')
  await page.getByTestId('output-profile-probe').click()
  await expect.poll(() => requested).toBe(true)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const backend = (app as unknown as { backendForTab(tab: unknown): { scopedClient: { setRemoteChoicePartition(value: { principalGeneration: number; schemaEpoch: number }): void } } }).backendForTab(app.activeTab()!)
    backend.scopedClient.setRemoteChoicePartition({ principalGeneration: 100, schemaEpoch: 100 })
  })
  release!()
  await expect(page.getByTestId('output-profile-probe')).toBeEnabled()
  expect(JSON.parse(await stored(page)).entries).toEqual([])
  await expect(page.getByTestId('output-descriptors-apply')).toBeDisabled()
  requested = false
  await page.getByTestId('output-profile-probe').click()
  await expect.poll(() => requested).toBe(true)
  release!()
  await expect(page.getByTestId('output-descriptors-apply')).toBeEnabled()
  await expect(page.getByTestId('output-descriptor-editor')).toContainText('cannot be edited')
  await expect(page.getByTestId('output-descriptor-editor')).toContainText('Metadata diagnostic does not block this profile.')
  for (const index of [1, 2]) {
    await expect(page.getByLabel(`Output ${index} name`, { exact: true })).toHaveJSProperty('readOnly', true)
    await expect(page.getByLabel(`Output ${index} ID`, { exact: true })).toBeDisabled()
    await expect(page.getByRole('combobox', { name: `Output ${index} type`, exact: true })).toBeDisabled()
    for (const name of [`Move output ${index} up`, `Move output ${index} down`, `Remove output ${index}`]) {
      await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
    }
  }
  await expect(page.getByRole('button', { name: 'Add output', exact: true })).toBeDisabled()
  await page.getByLabel('Output 1 name', { exact: true }).press('Backspace')
  await expect(page.getByLabel('Output 1 name', { exact: true })).toHaveValue('Model')
  await page.getByRole('button', { name: 'Stored JSON', exact: true }).click()
  const canonicalProfile = await page.getByLabel('Descriptor document', { exact: true }).inputValue()
  await expect(page.getByLabel('Descriptor document', { exact: true })).toHaveJSProperty('readOnly', true)
  await page.getByLabel('Descriptor document', { exact: true }).press('Backspace')
  await expect(page.getByLabel('Descriptor document', { exact: true })).toHaveValue(canonicalProfile)
  await page.getByRole('button', { name: 'Stored JSON', exact: true }).click()
  await page.screenshot({ path: info.outputPath('metadata-profile-editor.png'), animations: 'disabled' })
  await page.getByTestId('output-descriptors-apply').click()
  expect(await stored(page)).toBe(canonicalProfile)
  expect(await pins(page)).toEqual(['model', 'vae'])
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.activeTab()!.store.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'n', inputId: 'checkpoint', value: { digest: `blake3:${'2'.repeat(64)}`, name: 'model.safetensors' } } })
  })
  expect(await pins(page)).toEqual([])
  await openDescriptors(page)
  await expect(page.getByTestId('output-descriptor-editor')).toContainText('stale')
  await page.screenshot({ path: info.outputPath('metadata-profile-stale.png'), animations: 'disabled' })
  await page.getByTestId('output-descriptors-apply').scrollIntoViewIfNeeded()
  await expect(page.getByTestId('output-descriptors-apply')).toBeDisabled()
  await page.screenshot({ path: info.outputPath('metadata-profile-stale-actions.png'), animations: 'disabled' })
  const beforeRace = await stored(page)
  requested = false
  await page.getByTestId('output-profile-probe').click()
  await expect.poll(() => requested).toBe(true)
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.dispatch({
    command: 'node.setValue', params: { graphId: 'root', nodeId: 'n', inputId: 'checkpoint', value: { digest: `blake3:${'3'.repeat(64)}`, name: 'model.safetensors' } },
  }))
  release!()
  await expect(page.getByTestId('output-descriptor-editor')).toBeHidden()
  await openDescriptors(page)
  await expect(page.getByTestId('output-descriptors-apply')).toBeDisabled()
  expect(await stored(page)).toBe(beforeRace)
  expect(await pins(page)).toEqual([])
})

test('matching saved metadata profiles restore exact ordered stable outputs', async ({ page }, info) => {
  await setup(page, true)
  const source = JSON.stringify({
    entries: [
      { id: 'vae', name: 'VAE', type: 'vae' },
      { id: 'model', name: 'Model', type: 'model' },
    ],
    assetDigest: `blake3:${'1'.repeat(64)}`,
    detectorRevision: '1',
  })
  await page.evaluate((entries) => {
    const app = window.__dinksterTest!.app
    const current = app.activeTab()!
    current.store.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'n', inputId: 'entries', value: entries } })
    const saved = structuredClone(current.store.doc)
    app.openDocument(saved, 'Restored metadata profile')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, source)
  expect(await pins(page)).toEqual(['vae', 'model'])
  await openDescriptors(page)
  await expect(page.getByLabel('Output 1 ID', { exact: true })).toHaveValue('vae')
  await expect(page.getByLabel('Output 2 ID', { exact: true })).toHaveValue('model')
  await expect(page.getByTestId('output-descriptors-apply')).toBeEnabled()
  await page.screenshot({ path: info.outputPath('metadata-profile-restored.png'), animations: 'disabled' })
  await page.evaluate((entries) => {
    const app = window.__dinksterTest!.app
    const current = app.activeTab()!
    const restored = structuredClone(current.store.doc)
    restored.lineage = 'mismatched-restored-profile'
    restored.graphs.root!.nodes.n!.values.entries = entries
    app.openDocument(restored, 'Mismatched restored metadata profile')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, source.replace('"detectorRevision":"1"', '"detectorRevision":"2"'))
  expect(await pins(page)).toEqual([])
  await openDescriptors(page)
  await expect(page.getByTestId('output-descriptor-editor')).toContainText('stale')
  await expect(page.getByTestId('output-descriptors-apply')).toBeDisabled()
})

test('invalid metadata profile responses expose no outputs and cannot be applied', async ({ page }) => {
  await setup(page, true)
  let promptPosts = 0
  await page.route('**/prompt', async (route) => {
    promptPosts++
    await route.fulfill({ status: 500, body: 'invalid profile must not submit' })
  })
  await page.route('**/api/output-profiles/model?**', async (route) => route.fulfill({ json: {
    entries: [{ id: 'model', name: 'Model', type: 'runtime-discovered' }],
    assetDigest: `blake3:${'1'.repeat(64)}`,
    detectorRevision: '1',
  } }))
  await openDescriptors(page)
  await page.getByTestId('output-profile-probe').click()
  await expect(page.getByTestId('output-descriptor-editor')).toContainText("Output 'model' must select a declared concrete type")
  await expect(page.getByTestId('output-descriptors-apply')).toBeDisabled()
  expect(await pins(page)).toEqual([])
  expect(JSON.parse(await stored(page)).entries).toEqual([])
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queue(app.activeTab()!)
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.problems.get()
    .filter((problem) => problem.code === 'elab.outputDescriptors.invalid')
    .map((problem) => problem.message))).not.toEqual([])
  expect(promptPosts).toBe(0)
})

test('inactive fixed-ID links stay attached to semantic outputs and can be disconnected', async ({ page }, info) => {
  await setup(page, true)
  const digest = `blake3:${'1'.repeat(64)}`
  const profile = JSON.stringify({
    entries: [
      { id: 'model', name: 'Model', type: 'model' },
      { id: 'vae', name: 'VAE', type: 'vae' },
    ],
    assetDigest: digest,
    detectorRevision: '1',
  })
  await page.evaluate(({ digest, profile }) => {
    const app = window.__dinksterTest!.app
    const sink = (type: string, input: string) => ({
      type, displayName: type, category: 'test', source: 'v3' as const, isOutputNode: true,
      items: [{ kind: 'input' as const, id: input, type: { kind: 'concrete' as const, name: `dinkster.${input}` }, optional: false }],
    })
    app.registerSchemas([sink('ModelSink', 'model'), sink('ClipSink', 'clip'), sink('VaeSink', 'vae')])
    const original = app.activeTab()!.store.doc
    app.openDocument({
      ...original,
      lineage: 'saved-checkpoint-profile-links',
      graphs: { root: {
        ...original.graphs.root!,
        nodes: {
          n: { ...original.graphs.root!.nodes.n!, values: { checkpoint: { digest, name: 'model.safetensors' }, entries: profile } },
          modelSink: { id: 'modelSink', type: 'ModelSink', values: {} },
          clipSink: { id: 'clipSink', type: 'ClipSink', values: {} },
          vaeSink: { id: 'vaeSink', type: 'VaeSink', values: {} },
        },
        links: {
          modelLink: { id: 'modelLink', from: { node: 'n', port: 'model' }, to: { node: 'modelSink', port: 'model' } },
          clipLink: { id: 'clipLink', from: { node: 'n', port: 'clip' }, to: { node: 'clipSink', port: 'clip' } },
          vaeLink: { id: 'vaeLink', from: { node: 'n', port: 'vae' }, to: { node: 'vaeSink', port: 'vae' } },
        },
      } },
      view: { graphs: { root: { nodes: {
        n: { position: { x: 130, y: 100 }, size: { width: 350, height: 190 } },
        modelSink: { position: { x: 650, y: 80 } },
        clipSink: { position: { x: 650, y: 260 } },
        vaeSink: { position: { x: 650, y: 440 } },
      } } } },
    }, 'Saved checkpoint profile links')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, { digest, profile })

  expect(await pins(page)).toEqual(['model', 'vae'])
  expect(await page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!.links))).toEqual(['modelLink', 'clipLink', 'vaeLink'])
  await openDescriptors(page)
  const stale = page.getByTestId('output-descriptor-stale-links')
  await expect(stale).toContainText('clip')
  await expect(stale).not.toContainText('model')
  await expect(stale).not.toContainText('vae')
  await stale.screenshot({ path: info.outputPath('metadata-profile-inactive-link.png'), animations: 'disabled' })
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.openDocument(structuredClone(app.activeTab()!.store.doc), 'Reloaded checkpoint profile links')
  })
  await page.getByRole('button', { name: 'Disconnect inactive clip output' }).click()
  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get().filter((problem) => problem.code.startsWith('link.') || problem.code === 'params.invalid').map((problem) => `${problem.code}: ${problem.message}`))).toEqual([])
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!.links)).toMatchObject({
    modelLink: { from: { node: 'n', port: 'model' } },
    vaeLink: { from: { node: 'n', port: 'vae' } },
  })
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!.links.clipLink)).toBeUndefined()

  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.dispatch({
    command: 'node.setValue', params: { graphId: 'root', nodeId: 'n', inputId: 'checkpoint', value: { digest: `blake3:${'2'.repeat(64)}`, name: 'replacement.safetensors' } },
  }))
  expect(await pins(page)).toEqual([])
  await openDescriptors(page)
  await expect(page.getByTestId('output-descriptor-stale-links')).toContainText('model')
  await expect(page.getByTestId('output-descriptor-stale-links')).toContainText('vae')
  await page.getByTestId('output-descriptor-stale-links').screenshot({ path: info.outputPath('metadata-profile-all-links-stale.png'), animations: 'disabled' })
})

test('fixed IDs without a probe do not make the descriptor document immutable', async ({ page }) => {
  await setup(page, 'fixed')
  await openDescriptors(page)
  await expect(page.getByLabel('Output 1 name', { exact: true })).toBeEditable()
  await expect(page.getByRole('combobox', { name: 'Output 1 type', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Add output', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Remove output 1', exact: true })).toBeEnabled()
  await page.getByLabel('Output 1 name', { exact: true }).fill('Editable')
  await page.getByLabel('Output 1 name', { exact: true }).press('Tab')
  await page.getByRole('button', { name: 'Move output 2 up', exact: true }).click()
  await page.getByRole('button', { name: 'Stored JSON', exact: true }).click()
  await expect(page.getByLabel('Descriptor document', { exact: true })).toBeEditable()
  await page.getByTestId('output-descriptors-apply').click()
  expect(JSON.parse(await stored(page)).entries.map((entry: { id: string; name: string }) => [entry.id, entry.name])).toEqual([['string', 'Caption'], ['float', 'Editable']])
})

test('unsafe node-owned numbers retain exact text through raw descriptor edits', async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1600 })
  await setup(page)
  const source = '{"entries":[{"id":"m0","name":"Original","type":"float","value":9007199254740993}],"nested":{"value":1e400}}'
  await page.evaluate((value) => window.__dinksterTest!.app.activeTab()!.store.dispatch({
    command: 'node.setValue', params: { graphId: 'root', nodeId: 'n', inputId: 'entries', value },
  }), source)
  await openDescriptors(page)
  await expect(page.getByTestId('output-descriptor-editor')).toContainText("outside JavaScript's exact range")
  await expect(page.getByLabel('Output 1 name', { exact: true })).toHaveJSProperty('readOnly', true)
  await expect(page.getByRole('button', { name: 'Move output 1 down', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Add output', exact: true })).toBeDisabled()
  await page.getByLabel('Output 1 name', { exact: true }).press('Backspace')
  await page.getByTestId('output-descriptors-apply').click()
  expect(await stored(page)).toBe(source)
  await openDescriptors(page)
  await page.getByRole('button', { name: 'Stored JSON', exact: true }).click()
  const renamed = source.replace('Original', 'Renamed')
  await page.getByLabel('Descriptor document', { exact: true }).fill(renamed)
  await page.getByTestId('output-descriptors-apply').scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('descriptor-unsafe-numbers.png'), animations: 'disabled' })
  await page.getByTestId('output-descriptors-apply').click()
  expect(await stored(page)).toBe(renamed)
})

test('chained source-only boundaries retain the metadata probe and read-only editor', async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1600 })
  await setup(page, true)
  const digest = `blake3:${'4'.repeat(64)}`
  await page.evaluate((digest) => {
    const app = window.__dinksterTest!.app
    const original = structuredClone(app.activeTab()!.store.doc)
    const node = original.graphs.root!.nodes.n!
    const graph = (id: string, type: string) => ({
      id, name: id, nodes: { n: { id: 'n', type, values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
      boundary: { inputs: ['entries', 'checkpoint'].map((id) => ({ id, binds: { kind: 'port', node: 'n', port: id }, promoted: true })), outputs: [] },
    })
    const inner = { ...graph('inner', node.type), nodes: { n: node } }
    const outer = graph('outer', '#inner')
    app.openDocument({ ...original, lineage: 'source-only-descriptors', graphs: {
      root: { ...original.graphs.root!, nodes: { n: { ...node, type: '#outer', values: { ...node.values, checkpoint: { digest, name: 'current.safetensors' } } } } },
      inner, outer,
    } } as Parameters<typeof app.openDocument>[0], 'Chained metadata source')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, digest)
  const profile = { entries: ['model', 'clip', 'vae'].map((id) => ({ id, name: id.toUpperCase(), type: id })), assetDigest: digest, detectorRevision: '1' }
  await page.route('**/api/output-profiles/model?**', async (route) => {
    expect(new URL(route.request().url()).searchParams.get('digest')).toBe(digest)
    await route.fulfill({ json: profile })
  })
  await openDescriptors(page)
  await page.getByTestId('output-profile-probe').click()
  await expect(page.getByTestId('output-descriptors-apply')).toBeEnabled()
  await expect(page.getByLabel('Output 1 name', { exact: true })).toHaveJSProperty('readOnly', true)
  await page.getByRole('button', { name: 'Stored JSON', exact: true }).click()
  await expect(page.getByLabel('Descriptor document', { exact: true })).toHaveJSProperty('readOnly', true)
  await page.getByTestId('output-descriptors-apply').scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('descriptor-source-only-profile.png'), animations: 'disabled' })
  await page.getByTestId('output-descriptors-apply').click()
  expect(JSON.parse(await stored(page))).toEqual(profile)
  expect(await pins(page)).toEqual([])
})
