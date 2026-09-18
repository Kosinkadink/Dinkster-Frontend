import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'

const contract = JSON.parse(await readFile(new URL('../fixtures/video-edit-contract.json', import.meta.url), 'utf8')) as {
  provenance: Record<string, unknown>
  nodes: Record<string, Record<string, unknown>>
}

const schemaWire = contract.nodes['dinkster.video.trim']!.schemaVersion
const typed = (name: string) => ({ kind: 'concrete', types: [name] })
const input = (id: string, name: string, value?: unknown) => ({ role: 'input', id, type: typed(name), ...(value === undefined ? {} : { default: value }) })
const node = (entries: unknown[]) => ({ schemaVersion: schemaWire, signature: 'video-edit-test', outputNode: true, interface: entries })
const catalog = {
  schemaVersion: 1, epoch: 1, dinkster: { version: 'video-edit-test', schemaWire }, nodes: {
    'test.video': node([
      input('source_version', 'core.int', 0),
      { role: 'output', id: 'video', type: typed('comfy.VIDEO') },
      { role: 'output', id: 'images', type: typed('dinkster.image') },
      { role: 'output', id: 'strict_duration', type: typed('core.boolean') },
      { role: 'output', id: 'start_time', type: typed('core.float') },
    ]),
    ...contract.nodes,
    // Isolated compile targets; computational ports come from the backend fixture.
    'dinkster.video.trim': { ...contract.nodes['dinkster.video.trim'], outputNode: true },
    'dinkster.video.crop': { ...contract.nodes['dinkster.video.crop'], outputNode: true },
    'test.video.edit': node([
      input('video', 'comfy.VIDEO'), { ...input('video_edit', 'comfy.VIDEO_EDIT'), required: false },
      input('strict_duration', 'core.boolean', false),
      { role: 'output', id: 'video', type: typed('comfy.VIDEO') },
    ]),
  },
}
const descriptor = { typeId: 'comfy.VIDEO', fingerprint: 'retained-source', meta: {
  probe: { width: 1080, height: 1920, rotation: 90, color_space: 'HDR PQ' },
  effective: { width: 1920, height: 1080, duration: [10, 1], fps: [24, 1], frame_count: 240 },
} }
const imported = { vendor: { future: [1, 'keep'] }, trim: { start_time: 1.25, duration: 3.5, extra: true }, crop: { x: 100, y: 40, width: 1280, height: 720, extra: 'keep' } }
const nativeBackend = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
const nativeBackendCommit = process.env['DINKSTER_VIDEO_EDIT_BACKEND_COMMIT']
const liveTestTitle = 'live native editor uses plain graph values against lazy VIDEO results'

test.beforeEach(async ({ page }, info) => {
  if (info.title === liveTestTitle) return
  await page.route('/api/**', (route) => route.fulfill({ status: 404, json: { error: 'Isolated fixture' } }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated fixture' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'test' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: catalog }))
  await page.routeWebSocket('**/api/events?*', () => {})
})

async function openDocument(page: Page, kind: 'trim' | 'crop' | 'both', values: Record<string, unknown> = { video_edit: imported, strict_duration: false }, linked: string[] = []) {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(Object.keys(catalog.nodes).length)
  await page.evaluate(({ kind, values, linked }) => {
    const app = window.__dinksterTest!.app
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'video-editor-test', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Video', nodes: {
        source: { id: 'source', type: 'test.video', values: {} },
        edit: { id: 'edit', type: kind === 'both' ? 'test.video.edit' : `dinkster.video.${kind}`, values },
      }, links: Object.fromEntries(['video', ...linked].map((port) => [port, { id: port, from: { node: 'source', port }, to: { node: 'edit', port } }])), nets: {}, reroutes: {}, nextOrdinal: 3 } },
      view: { graphs: { g0: { nodes: { source: { position: { x: 50, y: 80 } }, edit: { position: { x: 480, y: 80 } } } } } },
      ext: { 'dinkster.exposed': [{ graphId: 'g0', nodeId: 'edit', inputId: 'video_edit', label: 'Video edit' }] },
    }, 'Video editor')
  }, { kind, values, linked })
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store && tab.store.doc.lineage === 'video-editor-test'
  })).toBe(true)
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.some((node) => node.id === 'edit'),
  )).toBe(true)
  await page.evaluate((descriptor) => {
    const app = window.__dinksterTest!.app
    const compiled = app.compileTab(app.activeTab()!)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = { connection: compiled.artifact.connection, prompt: 'video-editor-run' }
    const store = app.store as unknown as { register(ref: unknown, artifact: unknown, now: number): void; apply(event: unknown): void }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    store.apply({ kind: 'nodeStates', execution: ref, timestamp: Date.now(), nodes: { source: { state: 'done', outputs: { video: descriptor } }, edit: { state: 'done', outputs: { video: { ...descriptor, fingerprint: 'edited-output-not-source' } } } } })
    store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() })
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, descriptor)
}

async function openEditor(page: Page) {
  await openEditorFor(page, 'edit')
}

async function openEditorFor(page: Page, nodeId: string) {
  const point = await page.evaluate((id) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === id)!
    const row = node.layout.rows.find((row) => row.kind === 'widget' && row.inputId === 'video_edit')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    return {
      x: rect.left + viewport.x + (node.x + node.layout.width / 2) * viewport.scale,
      y: rect.top + viewport.y + (node.y + row.y + row.height / 2) * viewport.scale,
    }
  }, nodeId)
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('video-edit-editor')).toBeVisible()
}
const valuesOf = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.edit!.values)

const persistedState = (page: Page) => page.evaluate(() => {
  const app = window.__dinksterTest!.app
  const tab = app.activeTab()!
  const compiled = app.compileTab(tab)
  if (!compiled?.ok || !compiled.artifact.prompt) throw new Error(`Compile failed: ${JSON.stringify(compiled)}`)
  const edit = tab.store.doc.graphs.g0!.nodes.edit!
  const registry = app.backends.get().find((backend) => backend.id === app.tabTargets.get().get(tab.id))?.registry.get()
    ?? app.backends.get()[0]!.registry.get()!
  const schema = registry.schemas.get(edit.type) as { items: { kind: string; id?: string; widget?: { options: { features?: string[] } } }[] }
  return {
    workflow: app.exportDocument(tab.id),
    values: edit.values,
    featureSubset: schema.items.find((item) => item.kind === 'input' && item.id === 'video_edit')?.widget?.options.features ?? [],
    compiledPrompt: compiled.artifact.prompt,
  }
})

async function retainRoundTrip(
  page: Page, info: TestInfo, name: string, before: unknown, expected: Record<string, unknown>,
  featureSubset: string[], measured: Record<string, unknown> = {},
) {
  const originalTab = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.id)
  const afterApply = await persistedState(page)
  expect(afterApply.values).toEqual(expected)
  expect(afterApply.featureSubset).toEqual(featureSubset)
  const downloadPromise = page.waitForEvent('download')
  expect(await page.evaluate(() => { const app = window.__dinksterTest!.app; return app.exportWorkflow(app.activeTab()!.id) })).toBe(true)
  const download = await downloadPromise
  const workflowPath = info.outputPath(`${name}.workflow.json`)
  await download.saveAs(workflowPath)
  const savedText = await readFile(workflowPath, 'utf8')
  expect(JSON.parse(savedText)).toEqual(afterApply.workflow)
  expect(await page.evaluate((text) => window.__dinksterTest!.app.openDocument(JSON.parse(text), 'Saved video reopened', undefined, true), savedText)).toEqual([])
  const afterSaveReload = await persistedState(page)
  expect(await page.evaluate((text) => window.__dinksterTest!.app.importWorkflowFile(new File([text], 'imported-video.json', { type: 'application/json' })), savedText)).toBe(true)
  const afterImport = await persistedState(page)
  for (const state of [afterSaveReload, afterImport]) {
    expect(state.values).toEqual(expected)
    expect(state.featureSubset).toEqual(featureSubset)
    expect(state.compiledPrompt).toEqual(afterApply.compiledPrompt)
  }
  let submitted: { graph: { nodes: Record<string, { nodeType: string; inputs: Record<string, unknown>; slotVariants?: Record<string, string> }> } } | undefined
  await page.route('**/api/assets', (route) => route.fulfill({ status: 503, json: { error: 'No fixture asset storage' } }))
  await page.route('**/api/jobs', (route) => {
    submitted = route.request().postDataJSON() as NonNullable<typeof submitted>
    return route.fulfill({ status: 202, json: { jobRef: 'captured-not-executed' } })
  })
  await page.evaluate(async () => { const app = window.__dinksterTest!.app; await app.queue(app.activeTab()!) })
  expect(submitted).toBeDefined()
  const compiledNodeInputs = submitted!.graph.nodes
  if ('video_edit' in expected) {
    expect(compiledNodeInputs.edit!.inputs.video_edit).toEqual(expected.video_edit)
    expect(compiledNodeInputs.edit!.inputs.video).toEqual({ $link: { node: 'source', output: 'video' } })
    expect(compiledNodeInputs.edit!.inputs).not.toHaveProperty('features')
    if ('strict_duration' in expected) expect(compiledNodeInputs.edit!.inputs.strict_duration).toBe(expected.strict_duration)
    else expect(compiledNodeInputs.edit!.inputs).not.toHaveProperty('strict_duration')
  }
  const evidencePath = info.outputPath(`${name}.evidence.json`)
  await writeFile(evidencePath, JSON.stringify({
    evidenceKind: 'executed-browser-save-reload-import', backendRuntimeExecuted: false,
    contractFixture: contract.provenance, fixtureOnlyNodeTypes: ['test.video', 'test.video.edit'],
    operation: name === 'save-video-v3' ? 'automatic on-open migration' : 'VIDEO_EDIT Apply',
    before, afterApply, afterSaveReload, afterImport, featureSubset,
    compiledNodeInputs, submittedRequest: submitted, measured,
  }, null, 2) + '\n')
  await info.attach(`${name}.workflow.json`, { path: workflowPath, contentType: 'application/json' })
  await info.attach(`${name}.evidence.json`, { path: evidencePath, contentType: 'application/json' })
  await page.evaluate((id) => window.__dinksterTest!.app.activeTabId.set(id), originalTab)
  return compiledNodeInputs
}

test('native trim derives its widget, requests lazy source selectors, preserves JSON and undoes the sibling atomically', async ({ page }, info) => {
  const requests: URL[] = []
  await openDocument(page, 'trim')
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#164e63'; ctx.fillRect(0, 0, 320, 180)
    ctx.fillStyle = '#fbbf24'; ctx.fillRect(80, 40, 160, 100)
    return canvas.toDataURL('image/png').split(',')[1]!
  })
  await page.route('**/api/values?*', (route) => {
    const url = new URL(route.request().url()); requests.push(url)
    const kind = url.searchParams.get('rendition')
    if (kind === 'preview') return route.fulfill({ status: 406, json: { available: false, reason: 'unavailable-rendition', error: 'Bounded encoder unavailable' } })
    return kind === null ? route.fulfill({ json: { available: true, descriptor, renditions: [
      { kind: 'original', mime: 'video/x-matroska', default: true },
      { kind: 'frame', mime: 'image/png', version: 'frame-v1', parameters: ['frame'], defaults: { frame: '0' }, limits: { maxEdge: 1024, maxOutputFrames: 1 } },
      { kind: 'thumbs', mime: 'image/png', version: 'thumbs-v1', parameters: ['thumbs'], defaults: { thumbs: '4' }, limits: { maxCount: 4, maxEdge: 128 } },
      { kind: 'preview', mime: 'video/mp4', version: 'preview-v1', parameters: [], defaults: {}, limits: { maxDuration: 10 } },
    ] } }) : route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64'), headers: { 'X-Dinkster-Fingerprint': descriptor.fingerprint, 'X-Dinkster-Rendition': kind, 'X-Dinkster-Color-Transform': 'PQ to sRGB' } })
  })
  const before = await valuesOf(page)
  const beforeState = await persistedState(page)
  await openEditor(page)
  await expect(page.getByTestId('video-edit-source-facts')).toContainText('1920 x 1080')
  await expect(page.getByRole('img', { name: 'Selected source frame' })).toBeVisible()
  await expect(page.getByTestId('video-edit-editor')).toContainText('PQ to sRGB')
  await expect(page.getByRole('region', { name: 'Crop video' })).toHaveCount(0)
  expect(requests.some((url) => url.searchParams.get('frame') === '1.25s')).toBe(true)
  expect(requests.some((url) => url.searchParams.get('rendition') === 'thumbs')).toBe(true)
  expect(requests.every((url) => !url.searchParams.has('thumbs'))).toBe(true)
  expect(requests.every((url) => url.searchParams.get('nodeId') === 'source' && url.searchParams.get('jobId') === 'video-editor-run' && !url.searchParams.has('element'))).toBe(true)
  expect(requests.some((url) => ['original', 'preview'].includes(url.searchParams.get('rendition') ?? ''))).toBe(false)
  await page.getByTestId('video-trim-start-frame').fill('48')
  await page.getByTestId('video-trim-start-frame').press('Tab')
  await page.getByTestId('video-trim-duration-seconds').fill('0')
  await page.getByTestId('video-trim-duration-seconds').press('Tab')
  await page.getByTestId('video-trim-strict').check()
  await expect(page.getByRole('slider', { name: 'Playhead frame' })).toHaveAttribute('max', '239')
  await expect.poll(() => requests.some((url) => url.searchParams.get('frame') === '2s')).toBe(true)
  await expect(page.getByRole('img', { name: 'Selected source frame' })).toBeVisible()
  await page.getByRole('img', { name: 'Selected source frame' }).evaluate((image) => (image as HTMLImageElement).decode())
  await page.getByTestId('widget-modal-surface').screenshot({ path: info.outputPath('trim-source-preview.png') })
  await page.getByRole('button', { name: 'Load bounded source preview' }).click()
  await expect(page.getByTestId('video-edit-editor')).toContainText('406 unavailable-rendition: Bounded encoder unavailable')
  await page.getByTestId('video-edit-apply').click()
  expect(await valuesOf(page)).toEqual({ video_edit: { ...imported, trim: { start_time: 2, duration: 0, extra: true } }, strict_duration: true })
  await retainRoundTrip(page, info, 'trim-edited', beforeState, { video_edit: { ...imported, trim: { start_time: 2, duration: 0, extra: true } }, strict_duration: true }, ['trim'])
  await page.getByTestId('graph-canvas').focus(); await page.keyboard.press('Control+z')
  expect(await valuesOf(page)).toEqual(before)
})

test('native crop source-pixel geometry, pointer handles, presets, and App editor share one value', async ({ page }, info) => {
  await openDocument(page, 'crop', { video_edit: imported })
  await page.route('**/api/values?*', (route) => route.fulfill({ json: { available: true, descriptor, renditions: [{ kind: 'original', mime: 'video/mp4', default: true }] } }))
  const before = await valuesOf(page)
  const beforeState = await persistedState(page)
  await openEditor(page)
  await expect(page.getByTestId('video-edit-source-facts')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Trim video' })).toHaveCount(0)
  await expect(page.getByTestId('video-edit-preview-unavailable')).toContainText('poster rendition is not advertised')
  await page.getByRole('button', { name: '1:1', exact: true }).click()
  await expect(page.getByTestId('video-crop-x')).toHaveValue('420')
  const east = page.getByRole('button', { name: 'Crop e handle', exact: true })
  const box = (await east.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
  await page.mouse.move(box.x - 60, box.y + box.height / 2); await page.mouse.up()
  const draggedWidth = Number(await page.getByTestId('video-crop-width').inputValue())
  await east.focus(); await page.keyboard.press('Shift+ArrowLeft')
  const width = Number(await page.getByTestId('video-crop-width').inputValue())
  expect(width).toBe(draggedWidth - 10)
  expect(width).toBeGreaterThan(0); expect(width).toBeLessThan(1080); expect(width % 2).toBe(0)
  await page.getByTestId('widget-modal-surface').screenshot({ path: info.outputPath('crop-source-pixels.png') })
  await page.getByTestId('video-edit-apply').click()
  expect((await valuesOf(page)).video_edit).toEqual({ ...imported, crop: { x: 420, y: 0, width, height: 1080, extra: 'keep' } })
  await retainRoundTrip(page, info, 'crop-pointer', beforeState, { video_edit: { ...imported, crop: { x: 420, y: 0, width, height: 1080, extra: 'keep' } } }, ['crop'], { draggedWidth, width })
  await page.getByTestId('graph-canvas').focus(); await page.keyboard.press('Control+z')
  expect(await valuesOf(page)).toEqual(before)
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
  await expect(page.getByTestId('views-switcher')).toContainText('App')
  await page.getByRole('button', { name: 'Edit Video edit video' }).click()
  await expect(page.getByRole('dialog', { name: /Edit Video edit/ })).toBeVisible()
  await page.getByTestId('widget-modal-surface').screenshot({ path: info.outputPath('app-video-editor.png') })
  await page.getByTestId('video-crop-width').fill('0')
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('video-crop-width')).toHaveValue('0')
  await page.getByTestId('video-edit-apply').press('Enter')
  expect((await valuesOf(page)).video_edit).toEqual({ ...imported, crop: { ...imported.crop, width: 0 } })
})

test('absent VIDEO_EDIT preserves scalar settings until a real edit', async ({ page }) => {
  await openDocument(page, 'trim', { start_time: 2, duration: 3, strict_duration: true })
  const before = await valuesOf(page)
  await openEditor(page)
  await expect(page.getByTestId('video-trim-start-seconds')).toHaveValue('2')
  await page.getByTestId('video-edit-apply').click()
  expect(await valuesOf(page)).toEqual(before)
  await openEditor(page)
  await page.getByTestId('video-trim-duration-seconds').fill('0')
  await page.getByTestId('video-edit-apply').click()
  expect(await valuesOf(page)).toEqual({ ...before, video_edit: { trim: { start_time: 2, duration: 0 } } })
})

test('linked scalar overrides refuse Apply and linked strict duration stays read-only', async ({ page }, info) => {
  await openDocument(page, 'trim', { start_time: 2, duration: 3 }, ['start_time'])
  await openEditor(page)
  await expect(page.getByTestId('video-edit-editor')).toContainText('Scalar edit inputs are linked')
  await expect(page.getByTestId('video-edit-apply')).toBeDisabled()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await openDocument(page, 'trim', { video_edit: {}, strict_duration: false }, ['strict_duration'])
  await openEditor(page)
  await expect(page.getByTestId('video-trim-strict')).toBeDisabled()
  await expect(page.getByTestId('video-edit-editor')).toContainText('Strict duration is driven by a link')
  await page.setViewportSize({ width: 620, height: 760 })
  await page.getByTestId('widget-modal-surface').screenshot({ path: info.outputPath('trim-narrow-refusal.png') })
  await page.getByTestId('video-trim-duration-seconds').fill('2')
  await page.getByTestId('video-edit-apply').click()
  expect(await valuesOf(page)).toEqual({ video_edit: { trim: { duration: 2 } }, strict_duration: false })
})

test('changed source refuses stale preview and a concurrent edit cannot be overwritten', async ({ page }) => {
  await openDocument(page, 'trim')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.dispatchTo(app.activeTab()!, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'source', inputId: 'source_version', value: 1 } })
  })
  await openEditor(page)
  await expect(page.getByTestId('video-edit-editor')).toContainText('source changed since execution')
  await page.getByTestId('video-trim-duration-seconds').fill('2')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.dispatchTo(app.activeTab()!, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'edit', inputId: 'strict_duration', value: true } })
  })
  // Canvas ownership can close on mutation; a retained editor must also refuse its stale commit.
  if (await page.getByTestId('video-edit-apply').count()) await page.getByTestId('video-edit-apply').click()
  expect(await valuesOf(page)).toEqual({ video_edit: imported, strict_duration: true })
})

test('execution snapshots refuse VIDEO_EDIT writes and changing editor views', async ({ page }) => {
  await openDocument(page, 'trim')
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const execution = [...app.store.executions.get().values()].find((item) => item.ref.prompt === 'video-editor-run')!
    return app.openExecutionView(execution.ref)
  })).toBe(true)
  await expect(page.getByTestId('views-switcher')).toBeDisabled()
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return app.dispatchTo(app.activeTab()!, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'edit', inputId: 'video_edit', value: {} } }).ok
  })).toBe(false)
  await expect(page.getByRole('button', { name: 'Edit Video edit video' })).toHaveCount(0)
  await expect(page.getByTestId('video-edit-editor')).toHaveCount(0)
  expect(await valuesOf(page)).toEqual({ video_edit: imported, strict_duration: false })
})

test('unknown timing retains crop geometry and requests the advertised first frame by index', async ({ page }, info) => {
  await openDocument(page, 'crop', { video_edit: {} })
  const requests: URL[] = []
  await page.route('**/api/values?*', (route) => {
    const url = new URL(route.request().url()); requests.push(url)
    return url.searchParams.has('rendition')
      ? route.fulfill({ status: 406, json: { available: false, reason: 'unavailable-rendition', error: 'Decoder refused this source' } })
      : route.fulfill({ json: { available: true, descriptor: { ...descriptor, meta: { effective: { width: 1920, height: 1080, fps: null, duration: null } } }, renditions: [{ kind: 'frame', mime: 'image/png', version: 'frame-v1', parameters: ['frame'], defaults: { frame: '0' }, limits: { maxEdge: 1024 } }] } })
  })
  await openEditor(page)
  await expect(page.getByTestId('video-edit-source-facts')).toContainText('1920 x 1080 source pixels | Source timing unavailable')
  await expect(page.getByTestId('video-edit-preview-unavailable')).toContainText('Decoder refused this source')
  expect(requests.some((url) => url.searchParams.get('frame') === '0')).toBe(true)
  expect(requests.some((url) => url.searchParams.get('rendition') === 'original')).toBe(false)
  await page.getByRole('button', { name: '1:1', exact: true }).click()
  await expect(page.getByTestId('video-crop-x')).toHaveValue('420')
  await page.getByTestId('widget-modal-surface').screenshot({ path: info.outputPath('crop-unknown-timing.png') })
  await page.getByTestId('video-edit-apply').click()
  expect(await valuesOf(page)).toEqual({ video_edit: { crop: { x: 420, y: 0, width: 1080, height: 1080 } } })
})

test('legacy frame providers keep their default and visibly disable frame selection', async ({ page }, info) => {
  await openDocument(page, 'trim')
  const requests: URL[] = []
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#164e63'; ctx.fillRect(0, 0, 320, 180)
    ctx.fillStyle = '#fbbf24'; ctx.fillRect(80, 40, 160, 100)
    return canvas.toDataURL('image/png').split(',')[1]!
  })
  await page.route('**/api/values?*', (route) => {
    const url = new URL(route.request().url()); requests.push(url)
    const kind = url.searchParams.get('rendition')
    return kind === null
      ? route.fulfill({ json: { available: true, descriptor, renditions: [{ kind: 'frame', mime: 'image/png' }] } })
      : route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64'), headers: { 'X-Dinkster-Fingerprint': descriptor.fingerprint, 'X-Dinkster-Rendition': kind } })
  })
  await openEditor(page)
  await expect(page.getByTestId('video-edit-frame-selection-unavailable')).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Playhead frame' })).toBeDisabled()
  const image = page.getByRole('img', { name: 'Selected source frame' })
  await expect(image).toBeVisible()
  await image.evaluate((image) => (image as HTMLImageElement).decode())
  expect(requests.filter((url) => url.searchParams.has('rendition'))).toHaveLength(1)
  expect(requests.every((url) => !url.searchParams.has('frame'))).toBe(true)
  await page.getByTestId('widget-modal-surface').screenshot({ path: info.outputPath('trim-default-frame.png') })
})

const persistenceCases: {
  name: string; kind: 'trim' | 'crop' | 'both'; before: Record<string, unknown>;
  fields: Record<string, string>; expected: Record<string, unknown>
}[] = [
  { name: 'trim-empty', kind: 'trim', before: { video_edit: {}, strict_duration: false }, fields: {}, expected: { video_edit: {}, strict_duration: false } },
  { name: 'crop-empty', kind: 'crop', before: { video_edit: {} }, fields: {}, expected: { video_edit: {} } },
  { name: 'both-empty', kind: 'both', before: { video_edit: {}, strict_duration: false }, fields: {}, expected: { video_edit: {}, strict_duration: false } },
  {
    name: 'crop-numeric', kind: 'crop', before: { video_edit: imported },
    fields: { 'video-crop-x': '101', 'video-crop-y': '41', 'video-crop-width': '1279', 'video-crop-height': '719' },
    expected: { video_edit: { ...imported, crop: { x: 101, y: 41, width: 1279, height: 719, extra: 'keep' } } },
  },
  {
    name: 'both-edited', kind: 'both', before: { video_edit: imported, strict_duration: true },
    fields: { 'video-trim-start-seconds': '-2', 'video-trim-duration-seconds': '0', 'video-crop-x': '101', 'video-crop-width': '0' },
    expected: { video_edit: { ...imported, trim: { start_time: -2, duration: 0, extra: true }, crop: { ...imported.crop, x: 101, width: 0 } }, strict_duration: true },
  },
  {
    name: 'trim-partial', kind: 'trim', before: { video_edit: { vendor: [1], trim: { start_time: -2, extra: true } }, strict_duration: false },
    fields: { 'video-trim-duration-seconds': '0' },
    expected: { video_edit: { vendor: [1], trim: { start_time: -2, duration: 0, extra: true } }, strict_duration: false },
  },
  {
    name: 'crop-partial', kind: 'crop', before: { video_edit: { vendor: [1], trim: {}, crop: { x: 13, extra: 'keep' } } },
    fields: { 'video-crop-width': '0' },
    expected: { video_edit: { vendor: [1], trim: {}, crop: { x: 13, width: 0, extra: 'keep' } } },
  },
  {
    name: 'crop-nonpositive-height', kind: 'crop', before: { video_edit: { crop: { x: 101, y: -3, width: 1279, height: -1 } } },
    fields: {}, expected: { video_edit: { crop: { x: 101, y: -3, width: 1279, height: -1 } } },
  },
  {
    name: 'trim-missing-section', kind: 'trim', before: { video_edit: { crop: { width: 0 } }, start_time: 8, duration: 1, strict_duration: false },
    fields: {}, expected: { video_edit: { crop: { width: 0 } }, start_time: 8, duration: 1, strict_duration: false },
  },
  {
    name: 'crop-missing-section', kind: 'crop', before: { video_edit: { trim: { duration: 0 } }, x: 50, width: 200 },
    fields: {}, expected: { video_edit: { trim: { duration: 0 } }, x: 50, width: 200 },
  },
]

for (const scenario of persistenceCases) {
  test(`persists actual editor JSON: ${scenario.name}`, async ({ page }, info) => {
    await openDocument(page, scenario.kind, scenario.before)
    const before = await persistedState(page)
    await openEditor(page)
    const featureSubset = scenario.kind === 'both' ? ['trim', 'crop'] : [scenario.kind]
    for (const feature of ['trim', 'crop']) await expect(page.getByRole('region', { name: `${feature === 'trim' ? 'Trim' : 'Crop'} video` })).toHaveCount(featureSubset.includes(feature) ? 1 : 0)
    for (const [field, value] of Object.entries(scenario.fields)) await page.getByTestId(field).fill(value)
    await page.getByTestId('video-edit-apply').click()
    await retainRoundTrip(page, info, scenario.name, before, scenario.expected, featureSubset)
  })
}

test('normal typing preserves negative and fractional trim starts', async ({ page }) => {
  await openDocument(page, 'trim')
  for (const raw of ['-2', '-0.5', '1.25']) {
    await openEditor(page)
    const field = page.getByTestId('video-trim-start-seconds')
    await field.focus()
    await field.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
    await field.pressSequentially(raw)
    await expect(field).toHaveValue(raw)
    await page.getByTestId('video-edit-apply').click()
    expect((await valuesOf(page)).video_edit).toEqual({ ...imported, trim: { ...imported.trim, start_time: Number(raw) } })
  }
})

test('malformed numeric edits visibly refuse Apply and can be corrected without a sentinel write', async ({ page }, info) => {
  await openDocument(page, 'trim')
  const before = await valuesOf(page)
  await openEditor(page)
  const field = page.getByTestId('video-trim-duration-seconds')
  await field.fill('oops')
  await field.press('Tab')
  await expect(field).toHaveValue('oops')
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByTestId('video-edit-numeric-error')).toContainText('Duration seconds must be a finite number')
  await expect(page.getByTestId('video-edit-apply')).toBeDisabled()
  expect(await valuesOf(page)).toEqual(before)
  await page.getByTestId('widget-modal-surface').screenshot({ path: info.outputPath('trim-invalid-number.png') })
  await field.fill('3.5')
  await field.press('Tab')
  await expect(page.getByTestId('video-edit-numeric-error')).toHaveCount(0)
  await expect(page.getByTestId('video-edit-apply')).toBeEnabled()
  await field.fill('oops')
  await field.press('Enter')
  await expect(page.getByTestId('video-edit-apply')).toBeDisabled()
  await field.press('Escape')
  await expect(field).toHaveValue('3.5')
  await expect(page.getByTestId('video-edit-numeric-error')).toHaveCount(0)
  await expect(page.getByTestId('video-edit-apply')).toBeEnabled()
  await page.getByTestId('video-edit-apply').click()
  expect(await valuesOf(page)).toEqual(before)
})

test('VIDEO_EDIT value-source pills apply, undo and reopen without sibling writes', async ({ page }, info) => {
  await openDocument(page, 'trim')
  await page.evaluate((value) => {
    const app = window.__dinksterTest!.app
    const doc = app.activeTab()!.store.doc
    const graph = doc.graphs.g0!
    app.openDocument({ ...doc, lineage: 'video-edit-value-source', graphs: { ...doc.graphs, g0: {
      ...graph, valueSources: { v0: { id: 'v0', value } }, links: { ...graph.links,
        literal: { id: 'literal', from: { valueSource: 'v0' }, to: { node: 'edit', port: 'video_edit' } },
      },
    } }, view: { ...doc.view, graphs: { ...doc.view.graphs, g0: {
      ...doc.view.graphs.g0, valueSources: { v0: { position: { x: 120, y: 430 } } },
    } } } }, 'Video edit literal')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, imported)
  const point = await page.evaluate(() => {
    const pill = window.__dinksterTest!.renderer!.getScene().valueSources.find((item) => item.id === 'v0')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + pill.x + 14, y: rect.top + pill.y + pill.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('video-edit-editor')).toBeVisible()
  await expect(page.getByTestId('video-trim-strict')).toHaveCount(0)
  await page.getByTestId('video-trim-duration-seconds').fill('2')
  await page.getByTestId('video-trim-duration-seconds').press('Tab')
  await page.getByTestId('widget-modal-surface').screenshot({ path: info.outputPath('video-edit-value-source.png') })
  await page.getByTestId('video-edit-apply').click()
  const value = () => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.valueSources!.v0!.value)
  const expected = { ...imported, trim: { ...imported.trim, duration: 2 } }
  expect(await value()).toEqual(expected)
  expect(await valuesOf(page)).toEqual({ video_edit: imported, strict_duration: false })
  await page.getByTestId('graph-canvas').focus()
  await page.keyboard.press('Control+z')
  expect(await value()).toEqual(imported)
  await page.keyboard.press('Control+Shift+z')
  expect(await value()).toEqual(expected)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.openDocument(app.exportDocument(app.activeTab()!.id), 'Reopened literal', undefined, true)
  })
  expect(await value()).toEqual(expected)
})

test(liveTestTitle, async ({ page, request }, info) => {
  test.skip(process.env['DINKSTER_VIDEO_EDIT_LIVE'] !== '1' || process.env['DINKSTER_NATIVE_BACKEND'] === undefined,
    'set DINKSTER_VIDEO_EDIT_LIVE=1 and DINKSTER_NATIVE_BACKEND to the local Dinkster backend')
  test.setTimeout(120_000)
  expect(nativeBackendCommit).toMatch(/^[0-9a-f]{40}$/)

  const catalogResponse = await fetch(`${nativeBackend}/api/nodes?wire=41`, { signal: AbortSignal.timeout(5_000) })
  expect(catalogResponse.ok).toBe(true)
  const liveCatalog = await catalogResponse.json() as { nodes: Record<string, unknown> }
  for (const type of ['dinkster.image.generate', 'dinkster.video.assemble', 'dinkster.video.trim', 'dinkster.video.crop', 'dinkster.video.disassemble']) {
    expect(type in liveCatalog.nodes).toBe(true)
  }

  const valueRequests: URL[] = []
  const submissions: Record<string, any>[] = []
  page.on('request', (outgoing) => {
    const url = new URL(outgoing.url())
    if (url.pathname === '/api/values') valueRequests.push(url)
    if (outgoing.method() === 'POST' && url.pathname === '/api/jobs') submissions.push(outgoing.postDataJSON() as Record<string, any>)
  })
  await page.goto('/')
  const p2pNotice = page.getByRole('dialog', { name: /Peer-to-peer sharing is on/ })
  if (await p2pNotice.isVisible()) await p2pNotice.getByRole('button', { name: 'Dismiss notice' }).last().click()
  const closeInspector = page.getByRole('button', { name: 'Close Inspector panels' })
  if (await closeInspector.isVisible()) await closeInspector.click()
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get().find((candidate) => candidate.protocol === 'dinkster')
      ?.registry.get()?.schemas.has('dinkster.video.crop') ?? false,
  ), { timeout: 20_000 }).toBe(true)

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get().find((candidate) => candidate.protocol === 'dinkster')!
    const failures = app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'video-edit-native-live', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'Native video edit',
        nodes: {
          source: {
            id: 'source', type: 'dinkster.image.generate',
            values: { width: 64, height: 32, batch_size: 20, channels: 'rgb', 'color_source.color_a': '#2855c7' },
            dynamic: { color_source: { selected: 'hex' }, operation: { selected: 'solid' } },
          },
          assemble: { id: 'assemble', type: 'dinkster.video.assemble', values: { fps: 10, bit_depth: '8', color_space: 'sRGB' } },
          edit: {
            id: 'edit', type: 'dinkster.video.trim',
            values: { video_edit: { trim: { start_time: 0.5, duration: 1 } }, strict_duration: false },
          },
          crop: {
            id: 'crop', type: 'dinkster.video.crop',
            values: { video_edit: { crop: { x: 3, y: 3, width: 33, height: 17 } } },
          },
          frames: { id: 'frames', type: 'dinkster.video.disassemble', values: {} },
        },
        links: {
          images: { id: 'images', from: { node: 'source', port: 'image' }, to: { node: 'assemble', port: 'images' } },
          assembled: { id: 'assembled', from: { node: 'assemble', port: 'video' }, to: { node: 'edit', port: 'video' } },
          trimmed: { id: 'trimmed', from: { node: 'edit', port: 'video' }, to: { node: 'crop', port: 'video' } },
          cropped: { id: 'cropped', from: { node: 'crop', port: 'video' }, to: { node: 'frames', port: 'video' } },
        },
        nets: {}, reroutes: {}, nextOrdinal: 6,
      } },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 20, y: 80 } }, assemble: { position: { x: 300, y: 80 } },
        edit: { position: { x: 580, y: 80 } }, crop: { position: { x: 860, y: 80 } },
        frames: { position: { x: 1140, y: 80 } },
      } } } },
      ext: { 'dinkster.exposed': [
        { graphId: 'g0', nodeId: 'edit', inputId: 'video_edit', label: 'Native trim' },
        { graphId: 'g0', nodeId: 'crop', inputId: 'video_edit', label: 'Native crop' },
      ] },
    } as never, 'Native VIDEO_EDIT acceptance')
    if (failures.length > 0) throw new Error(JSON.stringify(failures))
    app.setTabTarget(app.activeTab()!.id, backend.id)
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  const run = async (): Promise<string> => {
    await page.evaluate(async () => {
      const app = window.__dinksterTest!.app
      await app.queueSelection(app.activeTab()!, ['frames'])
    })
    await expect.poll(() => page.evaluate(() => {
      const executions = [...window.__dinksterTest!.app.store.executions.get().values()]
      return executions.sort((a, b) => b.queuedAt - a.queuedAt)[0]?.status
    }), { timeout: 60_000, intervals: [250, 500, 1_000] }).toBe('completed')
    return page.evaluate(() => {
      const executions = [...window.__dinksterTest!.app.store.executions.get().values()]
      return executions.sort((a, b) => b.queuedAt - a.queuedAt)[0]!.ref.prompt
    })
  }

  await run()
  const firstRunNotice = page.getByTestId('p2p-first-run-notice')
  if (await firstRunNotice.isVisible()) {
    await firstRunNotice.getByRole('button', { name: 'Dismiss notice' }).last().click()
  }
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
  await page.getByRole('button', { name: 'Edit Native trim video' }).click()
  await expect(page.getByTestId('video-edit-editor')).toBeVisible()
  await expect(page.getByTestId('video-edit-source-facts')).toContainText('64 x 32 source pixels')
  await expect(page.getByTestId('video-edit-preview-unavailable')).toContainText('poster rendition is not advertised')
  await page.getByTestId('video-trim-duration-seconds').fill('0.6')
  await page.getByTestId('video-trim-strict').check()
  await page.getByTestId('widget-modal-surface').screenshot({ path: info.outputPath('video-edit-native-trim.png') })
  await page.getByTestId('video-edit-apply').click()

  await run()
  await page.getByRole('button', { name: 'Edit Native crop video' }).click()
  await expect(page.getByTestId('video-edit-editor')).toBeVisible()
  await expect(page.getByTestId('video-edit-source-facts')).toContainText('64 x 32 source pixels')
  await expect(page.getByTestId('video-edit-preview-unavailable')).toContainText('poster rendition is not advertised')
  await page.getByTestId('video-crop-width').fill('31')
  await page.getByTestId('widget-modal-surface').screenshot({ path: info.outputPath('video-edit-native-crop.png') })
  await page.getByTestId('video-edit-apply').click()
  const prompt = await run()

  const clientId = await page.evaluate(() => {
    const backend = window.__dinksterTest!.app.backends.get().find((candidate) => candidate.protocol === 'dinkster')!
    return (backend.connection as unknown as { clientId: string }).clientId
  })
  const valueQuery = `clientId=${encodeURIComponent(clientId)}&jobId=${encodeURIComponent(prompt)}&nodeId=crop&outputId=video`
  const resultResponse = await request.get(`${nativeBackend}/api/values?${valueQuery}`)
  expect(resultResponse.ok()).toBe(true)
  const result = await resultResponse.json() as { available: boolean; descriptor?: { meta?: { effective?: Record<string, unknown> } } }
  expect(result.available).toBe(true)
  expect(result.descriptor?.meta?.effective).toMatchObject({ width: 30, height: 16, duration: [3, 5] })
  const frameUrl = new URL(`${nativeBackend}/api/values?${valueQuery}&rendition=frame&frame=0`)
  expect(frameUrl.searchParams.has('path') || frameUrl.searchParams.has('file')).toBe(false)
  expect(frameUrl.searchParams.get('rendition')).not.toBe('original')
  const frameResponse = await request.get(frameUrl.toString())
  expect(frameResponse.status()).toBe(406)
  expect(await frameResponse.json()).toMatchObject({ available: false, reason: 'no-rendition', renditions: [] })

  const saved = await page.evaluate(() => window.__dinksterTest!.app.exportDocument(window.__dinksterTest!.app.activeTab()!.id)!) as any
  expect(saved.graphs.g0.nodes.edit.values).toEqual({ video_edit: { trim: { start_time: 0.5, duration: 0.6 } }, strict_duration: true })
  expect(saved.graphs.g0.nodes.crop.values).toEqual({ video_edit: { crop: { x: 3, y: 3, width: 31, height: 17 } } })
  expect(JSON.stringify([saved.graphs.g0.nodes.edit.values, saved.graphs.g0.nodes.crop.values])).not.toMatch(/file:|[A-Za-z]:\\|\/tmp\//)
  expect(submissions.at(-1)?.graph.nodes.edit.inputs.video_edit).toEqual(saved.graphs.g0.nodes.edit.values.video_edit)
  expect(submissions.at(-1)?.graph.nodes.crop.inputs.video_edit).toEqual(saved.graphs.g0.nodes.crop.values.video_edit)
  const reopened = await page.evaluate((document) => {
    const app = window.__dinksterTest!.app
    const failures = app.openDocument(document, 'Reopened native VIDEO_EDIT', undefined, true)
    if (failures.length > 0) throw new Error(JSON.stringify(failures))
    const nodes = app.activeTab()!.store.doc.graphs.g0!.nodes
    return { trim: nodes.edit!.values, crop: nodes.crop!.values }
  }, saved)
  expect(reopened).toEqual({ trim: saved.graphs.g0.nodes.edit.values, crop: saved.graphs.g0.nodes.crop.values })
  expect(valueRequests.length).toBeGreaterThan(0)
  for (const url of valueRequests) {
    expect(url.pathname).toBe('/api/values')
    expect(url.searchParams.has('path') || url.searchParams.has('file')).toBe(false)
    expect(url.searchParams.get('rendition')).not.toBe('original')
  }

  const evidence = { backend: { url: nativeBackend, commit: nativeBackendCommit }, prompt, submitted: submissions.at(-1), savedValues: {
    trim: saved.graphs.g0.nodes.edit.values, crop: saved.graphs.g0.nodes.crop.values,
  }, effective: result.descriptor?.meta?.effective, renditionRequests: [...valueRequests.map((url) => url.search), frameUrl.search] }
  const evidencePath = info.outputPath('video-edit-native-live.json')
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  await info.attach('video-edit-native-live.json', { path: evidencePath, contentType: 'application/json' })
})

test('SaveVideo v3 persists the migrated dynamic format as a static input', async ({ page }, info) => {
  await openDocument(page, 'trim')
  const before = {
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'save-video-v3-migration', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'Video', nodes: {
      source: { id: 'source', type: 'test.video', values: {} },
      edit: { id: 'edit', type: 'dinkster.save_video', values: {
        target: { mount: 'comfy-output', prefix: 'saved-editor' }, fps: 4, 'format.crf': 31, 'format.bit_depth': '10',
      }, dynamic: { format: { selected: 'webm_vp9' } } },
    }, links: { frames: { id: 'frames', from: { node: 'source', port: 'images' }, to: { node: 'edit', port: 'images' } } }, nets: {}, reroutes: {}, nextOrdinal: 3 } },
    view: { graphs: {} },
  }
  expect(await page.evaluate((document) => window.__dinksterTest!.app.openDocument(document, 'Historical Save Video'), before)).toEqual([])
  const expected = { target: { mount: 'comfy-output', prefix: 'saved-editor' }, format: 'webm_vp9', crf: 31, container: 'auto', codec: 'auto', metadata: '{}' }
  expect(await valuesOf(page)).toEqual(expected)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.edit!.dynamic?.format)).toBeUndefined()
  const compiledNodeInputs = await retainRoundTrip(page, info, 'save-video-v3', before, expected, [])
  const [assembleId, assemble] = Object.entries(compiledNodeInputs).find(([, node]) => node.nodeType === 'dinkster.video.assemble')!
  expect(assemble.inputs).toEqual({ images: { $link: { node: 'source', output: 'images' } }, fps: 4, bit_depth: '10', color_space: 'sRGB' })
  expect(compiledNodeInputs.edit!.inputs).toEqual({ ...expected, video: { $link: { node: assembleId, output: 'video' } } })
  expect(compiledNodeInputs.edit).not.toHaveProperty('slotVariants')
})
