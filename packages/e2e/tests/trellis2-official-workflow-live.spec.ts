import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page, type Route } from './fixtures.js'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
const WORKFLOW_PATH = fileURLToPath(
  new URL('../../core/fixtures/workflows/3d_pixal3d_trellis2_image_to_model.json', import.meta.url),
)
const OFFICIAL_WORKFLOW_SHA256 = '594295ae20490b4ed990655686f2d0c15ba06732df5553bc22bda98966c40a97'
const MODEL_NAMES = new Set([
  'birefnet.safetensors',
  'dino_v3_L_naf_fp32.safetensors',
  'moge_2_vitl_normal_fp16.safetensors',
  'pixal3d_int8_convrot.safetensors',
  'trellis_2_int8_convrot.safetensors',
  'trellis_2_shape_vae_bf16.safetensors',
  'trellis_2_texture_vae_bf16.safetensors',
  'viking_wolf_rune_axe.png',
])

interface SubmittedJob {
  clientId: string
  jobId: string
  graph: { nodes: Record<string, { nodeType: string; inputs: Record<string, unknown> }> }
}

const waitForJob = async (page: Page, submitted: SubmittedJob): Promise<Record<string, unknown>> => {
  let last: Record<string, unknown> = {}
  await expect.poll(async () => {
    const response = await page.request.get(
      `${NATIVE_BACKEND}/api/jobs/${encodeURIComponent(submitted.clientId)}/${encodeURIComponent(submitted.jobId)}`,
    )
    expect(response.ok()).toBe(true)
    last = await response.json() as Record<string, unknown>
    if (last['state'] === 'failed' || last['state'] === 'cancelled') {
      throw new Error(`TRELLIS.2 official workflow ${String(last['state'])}: ${JSON.stringify(last)}`)
    }
    return last['state']
  }, { timeout: 30 * 60_000, intervals: [1_000, 2_000, 5_000] }).toBe('completed')
  return last
}

test('imports, lowers, and executes the official Pixal3D and TRELLIS.2 workflow', async ({ page }) => {
  test.skip(process.env['DINKSTER_TRELLIS2_E2E'] !== '1', 'set DINKSTER_TRELLIS2_E2E=1 for the official-weight gate')
  test.setTimeout(65 * 60_000)

  const bytes = readFileSync(WORKFLOW_PATH)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(OFFICIAL_WORKFLOW_SHA256)
  const workflow = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  const served = await page.request.get(`${NATIVE_BACKEND}/api/nodes`).catch(() => null)
  expect(served?.ok(), `native Dinkster backend must be reachable at ${NATIVE_BACKEND}`).toBe(true)

  await page.unroute('/api/nodes*')
  await page.unroute('/supervisor/status')
  await page.goto('/')
  await page.waitForFunction(() => {
    const backend = window.__dinksterTest?.app.backends.get().find((candidate) => candidate.protocol === 'dinkster')
    return backend?.registry.get() !== undefined
  })

  const imported = await page.evaluate((officialWorkflow) => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get().find((candidate) => candidate.protocol === 'dinkster')!
    const failures = (app.openDocument as unknown as (...args: unknown[]) => readonly unknown[])(
      officialWorkflow,
      'Official Pixal3D and TRELLIS.2',
      backend,
    )
    const tab = app.activeTab()!
    app.setTabTarget(tab.id, backend.id)
    const registry = backend.registry.get()! as unknown as {
      diagnostics: readonly unknown[]
      comfyAliases?: { recordsByNodeClass: Map<string, unknown> }
    }
    const replacements = (app as unknown as {
      scanTabReplacements(value: unknown): readonly {
        sourceType: string
        terminalType: string
        safe: boolean
        diagnostics: readonly unknown[]
      }[]
    }).scanTabReplacements(tab)
    return {
      failures,
      nodeCount: Object.keys(tab.store.doc.graphs['g0']!.nodes).length,
      maintainedAliases: [...(registry.comfyAliases?.recordsByNodeClass.keys() ?? [])],
      registryDiagnostics: registry.diagnostics,
      schemaProblems: app.problems.get().filter((problem) => problem.code.startsWith('schema.')),
      pendingReplacements: replacements.map((item) => ({
        sourceType: item.sourceType,
        terminalType: item.terminalType,
        safe: item.safe,
        diagnostics: item.diagnostics,
      })),
    }
  }, workflow)
  expect(imported.failures).toEqual([])
  expect(imported.nodeCount).toBe(64)
  expect(imported.registryDiagnostics).toEqual([])
  expect(imported.maintainedAliases, JSON.stringify(imported.schemaProblems)).toEqual(expect.arrayContaining([
    'GetMeshInfo',
    'ImageCropToMask',
    'MoGeInference',
  ]))
  expect(imported.pendingReplacements).toEqual([])

  await expect.poll(() => page.evaluate((names) => {
    const nodes = window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes
    return Object.entries(nodes).flatMap(([nodeId, node]) =>
      Object.entries(node.values)
        .filter(([, value]) => typeof value === 'string' && names.includes(value))
        .map(([inputId, value]) => ({ nodeId, nodeType: node.type, inputId, value })),
    )
  }, [...MODEL_NAMES]), { timeout: 120_000 }).toEqual([])

  const runVariant = async (trellis2: boolean): Promise<{ job: Record<string, unknown>; submitted: SubmittedJob }> => {
    const prepared = await page.evaluate((enabled) => {
      const app = window.__dinksterTest!.app
      const tab = app.activeTab()!
      const result = tab.store.dispatch({
        command: 'node.setValue',
        params: { graphId: 'g0', nodeId: 'n316', inputId: 'value', value: enabled },
      })
      const compiled = app.compileTab(tab)
      return {
        dispatchOk: result.ok,
        compiled: compiled?.ok ?? false,
        diagnostics: compiled?.ok === false ? compiled.diagnostics : [],
      }
    }, trellis2)
    expect(prepared.dispatchOk).toBe(true)
    expect(prepared.compiled, JSON.stringify(prepared.diagnostics)).toBe(true)

    let submitted: SubmittedJob | undefined
    const capture = async (route: Route): Promise<void> => {
      submitted = route.request().postDataJSON() as SubmittedJob
      const response = await route.fetch()
      await route.fulfill({ response })
    }
    await page.route('**/api/jobs', capture)
    const queueProblems = await page.evaluate(async () => {
      const app = window.__dinksterTest!.app
      await app.queue(app.activeTab()!)
      return app.problems.get()
    })
    await expect.poll(
      () => submitted !== undefined,
      { timeout: 30_000, message: JSON.stringify(queueProblems) },
    ).toBe(true)
    await page.unroute('**/api/jobs', capture)

    const lowered = submitted!
    const nodeTypes = new Set(Object.values(lowered.graph.nodes).map((node) => node.nodeType))
    expect([...nodeTypes]).toEqual(expect.arrayContaining([
      'dinkster.load_diffusion_model',
      'dinkster.load_vae',
      'dinkster.load_vision',
      'dinkster.trellis2_conditioning',
      'dinkster.pixal3d_conditioning',
      'dinkster.trellis2_shape_stage',
      'dinkster.trellis2_upsample_stage',
      'dinkster.trellis2_texture_stage',
    ]))
    expect([...nodeTypes].some((nodeType) => /^(?:Empty|Trellis2|Pixal3D|VaeDecode.*Trellis)/.test(nodeType))).toBe(false)
    return { submitted: lowered, job: await waitForJob(page, lowered) }
  }

  const pixal = await runVariant(false)
  const trellis = await runVariant(true)
  expect(pixal.job['executed']).toEqual(expect.arrayContaining([expect.any(String)]))
  expect(trellis.job['executed']).toEqual(expect.arrayContaining([expect.any(String)]))
})
