import { expect, test, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

interface SaveVideoWire {
  readonly schemaVersion: number
  readonly version: number
  readonly outputNode?: boolean
  readonly executionArms?: readonly string[]
  readonly interface: readonly Record<string, unknown>[]
  readonly replacements?: readonly {
    readonly migration?: { readonly historicalInputs?: readonly string[] }
    readonly cases?: readonly Record<string, unknown>[]
  }[]
}

interface SubmittedJob {
  readonly clientId: string
  readonly jobId: string
  readonly graph: { readonly nodes: Record<string, unknown> }
}

interface EvidenceWorkflow {
  readonly graphs: Record<string, {
    readonly nodes: Record<string, { readonly type: string; readonly values: Record<string, unknown> }>
    readonly links: Record<string, {
      readonly from: { readonly node: string; readonly port: string }
      readonly to: { readonly node: string; readonly port: string }
    }>
  }>
}

const rowIds = (page: Page, nodeId: string): Promise<string[]> => page.evaluate((id) => {
  const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === id)!
  return node.layout.rows.flatMap((row) =>
    row.kind === 'widget' && typeof row.inputId === 'string' ? [row.inputId] : [],
  )
}, nodeId)

async function expandAdvanced(page: Page, nodeId: string): Promise<void> {
  const point = await page.evaluate((id) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === id)!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'section' && candidate.sectionId === 'advanced')!
    const canvas = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return { x: canvas.left + node.x + node.layout.width / 2, y: canvas.top + node.y + row.y + row.height / 2 }
  }, nodeId)
  await page.mouse.click(point.x, point.y)
}

function assertWireContract(schema: SaveVideoWire): void {
  expect(schema.schemaVersion).toBe(38)
  expect(schema.version).toBe(4)
  expect(schema.outputNode).toBe(true)
  expect(schema.executionArms).toContain('native')
  expect(schema.interface.map((entry) => [entry['role'], entry['id']])).toEqual([
    ['input', 'video'], ['input', 'target'], ['input', 'container'], ['input', 'codec'],
    ['input', 'profile'], ['input', 'audio_layout'], ['input', 'trim_to_audio'],
    ['input', 'crf'], ['input', 'metadata'], ['input', 'format'],
    ['output', 'video'], ['output', 'asset'],
  ])
  const format = schema.interface.find((entry) => entry['id'] === 'format')!
  expect(format['widget']).toEqual({ type: 'COMBO', options: ['mp4_h264', 'webm_vp9', 'webm_av1'] })
  expect(format['advanced']).toBe(true)
  expect(schema.replacements?.[0]?.migration?.historicalInputs).toEqual([
    'images', 'fps', 'audio', 'bit_depth', 'format.crf', 'format.bit_depth',
  ])
  expect(schema.replacements?.[0]?.cases).toHaveLength(2)
}

test('Save Video v2 migrates static formats and executes through VIDEO', async ({ page, request }) => {
  test.skip(process.env['DINKSTER_E2E_USE_NATIVE'] !== '1' || process.env['DINKSTER_NATIVE_BACKEND'] === undefined,
    'set DINKSTER_E2E_USE_NATIVE=1 and DINKSTER_NATIVE_BACKEND to an isolated Dinkster backend')
  test.setTimeout(90_000)

  const catalogResponse = await fetch(`${NATIVE_BACKEND}/api/nodes?wire=38`, {
    signal: AbortSignal.timeout(5_000),
  })
  expect(catalogResponse.ok).toBe(true)
  const catalog = await catalogResponse.json() as { nodes: Record<string, unknown> }
  expect('dinkster.image.generate' in catalog.nodes).toBe(true)
  expect('dinkster.video.assemble' in catalog.nodes).toBe(true)
  assertWireContract(catalog.nodes['dinkster.save_video'] as SaveVideoWire)

  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  let submitted: SubmittedJob | undefined
  page.on('request', (outgoing) => {
    if (outgoing.method() === 'POST' && new URL(outgoing.url()).pathname === '/api/jobs') {
      submitted = outgoing.postDataJSON() as SubmittedJob
    }
  })

  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get().find((candidate) => candidate.protocol === 'dinkster')
      ?.registry.get()?.schemas.has('dinkster.save_video') ?? false,
  ), { timeout: 15_000 }).toBe(true)

  const historicalWorkflow = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get().find((candidate) => candidate.protocol === 'dinkster')!
    const historical = {
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'save-video-v2-native', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          source: {
            id: 'source', type: 'dinkster.image.generate',
            values: {
              width: 64, height: 48, batch_size: 4, channels: 'rgb',
              'color_source.color_a': '#5a46d6',
            },
            dynamic: { color_source: { selected: 'hex' }, operation: { selected: 'solid' } },
          },
          crfSource: { id: 'crfSource', type: 'dinkster.int', values: { value: 29 } },
          nested: {
            id: 'nested', type: 'dinkster.save_video',
            values: {
              target: { mount: 'comfy-output', prefix: 'nested-av1' },
              fps: 4, 'format.bit_depth': '8',
            },
            dynamic: { format: { selected: 'webm_av1' } },
          },
          flat: {
            id: 'flat', type: 'dinkster.save_video',
            values: {
              target: { mount: 'comfy-output', prefix: 'flat-h264' },
              fps: 4, format: 'mp4_h264', crf: 31, bit_depth: '8',
            },
            dynamic: { format: { selected: 'webm_vp9' } },
          },
          vp9: {
            id: 'vp9', type: 'dinkster.save_video',
            values: {
              target: { mount: 'comfy-output', prefix: 'vp9' },
              fps: 4, 'format.crf': 27,
            },
            dynamic: { format: { selected: 'webm_vp9' } },
          },
          oldAssetConsumer: { id: 'oldAssetConsumer', type: 'dinkster.load_video', values: {} },
        },
        links: {
          flatFrames: { id: 'flatFrames', from: { node: 'source', port: 'image' }, to: { node: 'flat', port: 'images' } },
          nestedFrames: { id: 'nestedFrames', from: { node: 'source', port: 'image' }, to: { node: 'nested', port: 'images' } },
          vp9Frames: { id: 'vp9Frames', from: { node: 'source', port: 'image' }, to: { node: 'vp9', port: 'images' } },
          linkedCrf: { id: 'linkedCrf', from: { node: 'crfSource', port: 'value' }, to: { node: 'nested', port: 'format.crf' } },
          oldVideoOutput: { id: 'oldVideoOutput', from: { node: 'flat', port: 'video' }, to: { node: 'oldAssetConsumer', port: 'video' } },
        },
        nets: {}, reroutes: {}, nextOrdinal: 265,
      } },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 20, y: 70 } },
        crfSource: { position: { x: 20, y: 500 } },
        flat: { position: { x: 430, y: 70 }, size: { width: 290, height: 0 } },
        nested: { position: { x: 800, y: 70 }, size: { width: 290, height: 0 } },
        vp9: { position: { x: 1170, y: 70 }, size: { width: 290, height: 0 } },
        oldAssetConsumer: { position: { x: 1100, y: 500 } },
      } } } },
    }
    const failures = app.openDocument(historical as never, 'Save Video v2 Migration')
    if (failures.length > 0) throw new Error(`open failed: ${JSON.stringify(failures)}`)
    const tab = app.activeTab()!
    app.setTabTarget(tab.id, backend.id)
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    return historical
  })

  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store && tab.store.doc.lineage === 'save-video-v2-native'
  })).toBe(true)

  await expect.poll(() => page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!
    const helpers = Object.values(graph.nodes).filter((node) => node.type === 'dinkster.video.assemble')
    return {
      flat: graph.nodes.flat?.values,
      nested: graph.nodes.nested?.values,
      vp9: graph.nodes.vp9?.values,
      flatDynamic: graph.nodes.flat?.dynamic,
      nestedDynamic: graph.nodes.nested?.dynamic,
      vp9Dynamic: graph.nodes.vp9?.dynamic,
      helpers: Object.fromEntries(helpers.map((node) => [node.id, node.values])),
      links: Object.values(graph.links).map((link) => ({ from: link.from, to: link.to })),
    }
  })).toMatchObject({
    flat: {
      target: { mount: 'comfy-output', prefix: 'flat-h264' }, format: 'mp4_h264', crf: 31,
    },
    nested: {
      target: { mount: 'comfy-output', prefix: 'nested-av1' }, format: 'webm_av1',
    },
    vp9: {
      target: { mount: 'comfy-output', prefix: 'vp9' }, format: 'webm_vp9', crf: 27,
    },
    flatDynamic: undefined,
    nestedDynamic: undefined,
    vp9Dynamic: undefined,
    helpers: {
      'flat:assemble': { fps: 4, bit_depth: '8', color_space: 'sRGB' },
      'nested:assemble': { fps: 4, bit_depth: '8', color_space: 'sRGB' },
      'vp9:assemble': { fps: 4, bit_depth: 'auto', color_space: 'sRGB' },
    },
    links: expect.arrayContaining([
      { from: { node: 'crfSource', port: 'value' }, to: { node: 'nested', port: 'crf' } },
      { from: { node: 'flat', port: 'asset' }, to: { node: 'oldAssetConsumer', port: 'video' } },
    ]),
  })
  await expandAdvanced(page, 'flat')
  await expandAdvanced(page, 'nested')
  await expect.poll(() => rowIds(page, 'flat')).toEqual(expect.arrayContaining(['format', 'crf']))
  await expect.poll(() => rowIds(page, 'nested')).toEqual(expect.arrayContaining(['format']))

  const migratedWorkflow = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return app.exportDocument(app.activeTab()!.id)!
  }) as EvidenceWorkflow

  const closeInspector = page.getByRole('button', { name: 'Close Inspector panels' })
  if (await closeInspector.isVisible()) await closeInspector.click()
  await expandAdvanced(page, 'flat')
  await expandAdvanced(page, 'nested')
  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get()
    .filter((problem) => problem.severity === 'error')
    .map((problem) => `${problem.code}: ${problem.message}`))).toEqual([])
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queue(app.activeTab()!)
  })
  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get()
    .filter((problem) => problem.severity === 'error')
    .map((problem) => `${problem.code}: ${problem.message}`))).toEqual([])
  await expect.poll(() => page.evaluate(() => {
    const executions = [...window.__dinksterTest!.app.store.executions.get().values()]
    return executions.sort((a, b) => b.queuedAt - a.queuedAt)[0]?.status
  }), { timeout: 60_000, intervals: [250, 500, 1_000] }).toBe('completed')

  expect(submitted).toBeDefined()
  const submittedNodes = submitted!.graph.nodes as Record<string, {
    nodeType?: string
    inputs?: Record<string, unknown>
  }>
  expect(submittedNodes.flat).toMatchObject({
    inputs: {
      format: 'mp4_h264',
      crf: 31,
      video: { $link: { node: 'flat%3Aassemble', output: 'video' } },
    },
  })
  expect(submittedNodes.nested).toMatchObject({
    inputs: {
      format: 'webm_av1', crf: { $link: { node: 'crfSource', output: 'value' } },
      video: { $link: { node: 'nested%3Aassemble', output: 'video' } },
    },
  })
  expect(submittedNodes.vp9).toMatchObject({
    inputs: {
      format: 'webm_vp9', crf: 27,
      video: { $link: { node: 'vp9%3Aassemble', output: 'video' } },
    },
  })
  expect(Object.values(submittedNodes).filter((node) => node.nodeType === 'dinkster.video.assemble')).toHaveLength(3)

  const completed = await request.get(
    `${NATIVE_BACKEND}/api/jobs/${encodeURIComponent(submitted!.clientId)}/${encodeURIComponent(submitted!.jobId)}`,
  )
  expect(completed.ok()).toBe(true)
  const job = await completed.json() as Record<string, unknown>
  expect(job['state']).toBe('completed')
  expect(job['executed']).toEqual(expect.arrayContaining(['flat', 'nested', 'vp9']))
  const outputs = job['outputs'] as Record<string, Record<string, {
    typeId?: string
    meta?: Record<string, unknown>
  }>>
  for (const [nodeId, extension, mediaType] of [
    ['flat', 'mp4', 'video/mp4'], ['nested', 'mkv', 'video/x-matroska'], ['vp9', 'webm', 'video/webm'],
  ] as const) {
    expect(outputs[nodeId]?.video?.typeId).toBe('comfy.VIDEO')
    expect(outputs[nodeId]?.asset).toMatchObject({
      typeId: 'asset<comfy.VIDEO>',
      meta: { name: expect.stringMatching(new RegExp(`^${nodeId === 'flat' ? 'flat-h264' : nodeId === 'nested' ? 'nested-av1' : 'vp9'}_\\d+\\.${extension}$`)), mediaType },
    })
    const digest = outputs[nodeId]?.asset?.meta?.['digest']
    expect(typeof digest).toBe('string')
    const artifact = await request.get(`${NATIVE_BACKEND}/api/assets/${encodeURIComponent(String(digest))}`)
    expect(artifact.ok()).toBe(true)
    expect((await artifact.body()).byteLength).toBeGreaterThan(100)
  }
  const nodeStates = job['nodeStates'] as Record<string, string>
  expect(nodeStates['flat%3Aassemble']).toMatch(/^(completed|cached)$/)
  expect(nodeStates['nested%3Aassemble']).toMatch(/^(completed|cached)$/)
  expect(nodeStates['vp9%3Aassemble']).toMatch(/^(completed|cached)$/)

  const reopenedWorkflow = await page.evaluate((exported) => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get().find((candidate) => candidate.protocol === 'dinkster')!
    const imported = JSON.parse(JSON.stringify(exported))
    const viewNodes = imported.view.graphs.g0.nodes
    viewNodes.nested.position = { x: 1150, y: 70 }
    viewNodes['nested:assemble'].position = { x: 1470, y: 70 }
    viewNodes.vp9.position = { x: 1790, y: 70 }
    viewNodes['vp9:assemble'].position = { x: 2110, y: 70 }
    viewNodes.oldAssetConsumer.position = { x: 1500, y: 650 }
    const failures = app.openDocument(imported, 'Save Video v3 Reopened')
    if (failures.length > 0) throw new Error(`reopen failed: ${JSON.stringify(failures)}`)
    app.setTabTarget(app.activeTab()!.id, backend.id)
    return app.exportDocument(app.activeTab()!.id)!
  }, migratedWorkflow) as EvidenceWorkflow

  const reopened = reopenedWorkflow.graphs.g0!
  expect({
    flatFormat: reopened.nodes.flat?.values.format,
    nestedFormat: reopened.nodes.nested?.values.format,
    vp9Format: reopened.nodes.vp9?.values.format,
    helperCount: Object.values(reopened.nodes).filter((node) => node.type === 'dinkster.video.assemble').length,
    removedInputLinks: Object.values(reopened.links)
      .filter((link) => ['flat', 'nested', 'vp9'].includes(link.to.node) && link.to.port === 'images'),
  }).toEqual({ flatFormat: 'mp4_h264', nestedFormat: 'webm_av1', vp9Format: 'webm_vp9', helperCount: 3, removedInputLinks: [] })
  expect(pageErrors).toEqual([])

  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 0.65 }))

  const screenshot = await page.screenshot({
    animations: 'disabled',
    ...(process.env['DINKSTER_SAVE_VIDEO_EVIDENCE'] !== undefined
      ? { path: process.env['DINKSTER_SAVE_VIDEO_EVIDENCE'] }
      : {}),
  })
  await test.info().attach('save-video-v2-v3-migration.png', { body: screenshot, contentType: 'image/png' })
  await test.info().attach('save-video-v2-v3-native.json', {
    body: JSON.stringify({ submitted, job }, null, 2), contentType: 'application/json',
  })

  const evidence = {
    contract: {
      schemaWire: 38,
      migration: {
        selectionSource: 'dynamic.format.selected',
        selectionDestination: 'values.format',
        explicitValuePrecedence: 'values.format overrides dynamic.format.selected when both are present',
        helperType: 'dinkster.video.assemble',
        oldOutputMapping: 'video -> asset',
      },
      videoEdit: null,
      videoEditReason: 'SaveVideo v3 has no VIDEO_EDIT input or output in the published schema',
    },
    historicalV2Workflow: historicalWorkflow,
    migratedV3Workflow: migratedWorkflow,
    reopenedImportedWorkflow: reopenedWorkflow,
    submittedJob: submitted,
    completedJob: job,
  }
  const evidencePath = process.env['DINKSTER_SAVE_VIDEO_EVIDENCE_JSON']
  if (evidencePath !== undefined) {
    await mkdir(dirname(evidencePath), { recursive: true })
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  }
  await test.info().attach('save-video-v2-v3-evidence.json', {
    body: JSON.stringify(evidence, null, 2), contentType: 'application/json',
  })
})
