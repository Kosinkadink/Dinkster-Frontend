import { expect, test, type Page } from '@playwright/test'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
const checkpoint = {
  digest: 'blake3:2da04f4a2d5a205c9422c871eca1e93670e843d48752b4d35ab782d002e5dcae',
  name: 'v1-5-pruned-emaonly.safetensors',
  size: 4_265_146_304,
  mediaType: 'application/octet-stream',
  virtualPath: 'mounts/comfy-model-checkpoints-1/v1-5-pruned-emaonly.safetensors',
}
const lora = {
  digest: 'blake3:95fc3fff16f71442e57673fc5613d95392092481740dd665938d387afd4f8380',
  name: 'dinkster-native-linear-proof.safetensors',
  size: 10_616,
  mediaType: 'application/octet-stream',
  virtualPath: 'mounts/comfy-model-loras-1/dinkster-native-linear-proof.safetensors',
}

const requiredNodeTypes = [
  'dinkster.load_checkpoint',
  'dinkster.clip_text_encode',
  'dinkster.empty_latent_image',
  'comfy.CreateHookLora',
  'comfy.CreateHookKeyframe',
  'comfy.SetHookKeyframes',
  'comfy.ConditioningTimestepsRange',
  'comfy.ConditioningSetPropertiesAndCombine',
  'comfy.PairConditioningSetProperties',
  'dinkster.ksampler',
  'dinkster.vae_decode',
  'dinkster.save_image',
] as const

async function openScheduledWorkflow(page: Page, varying = true): Promise<void> {
  await page.evaluate(({ checkpoint, lora, varying }) => {
    const nodes = {
      load: { id: 'load', type: 'dinkster.load_checkpoint', values: { checkpoint } },
      base: { id: 'base', type: 'dinkster.clip_text_encode', values: { text: 'a quiet mountain landscape, white clouds, detailed illustration' } },
      scheduled: { id: 'scheduled', type: 'dinkster.clip_text_encode', values: { text: 'a bright red dragon breathing fire, glowing lava, volcanic landscape' } },
      negative: { id: 'negative', type: 'dinkster.clip_text_encode', values: { text: 'blurry, low quality, text, watermark' } },
      latent: { id: 'latent', type: 'dinkster.empty_latent_image', values: { width: 512, height: 512, batch_size: 1 } },
      range: { id: 'range', type: 'comfy.ConditioningTimestepsRange', values: { start_percent: 0, end_percent: varying ? 0.55 : 1 } },
      cond: { id: 'cond', type: 'comfy.ConditioningSetPropertiesAndCombine', values: { strength: varying ? 1.5 : 1, set_cond_area: 'default' } },
      lora: { id: 'lora', type: 'comfy.CreateHookLora', values: { lora_name: lora, strength_model: 1, strength_clip: 1 } },
      kf0: { id: 'kf0', type: 'comfy.CreateHookKeyframe', values: { strength_mult: varying ? 0 : 1, start_percent: 0 } },
      kf1: { id: 'kf1', type: 'comfy.CreateHookKeyframe', values: { strength_mult: 1, start_percent: 0.55 } },
      hooks: { id: 'hooks', type: 'comfy.SetHookKeyframes', values: {} },
      pair: { id: 'pair', type: 'comfy.PairConditioningSetProperties', values: { strength: 1, set_cond_area: 'default' } },
      sampler: { id: 'sampler', type: 'dinkster.ksampler', values: { seed: 8_675_309, steps: 24, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
      decode: { id: 'decode', type: 'dinkster.vae_decode', values: {} },
      save: { id: 'save', type: 'dinkster.save_image', values: {} },
    }
    const links = Object.fromEntries([
      ['l1', 'load', 'clip', 'base', 'clip'],
      ['l2', 'load', 'clip', 'scheduled', 'clip'],
      ['l3', 'load', 'clip', 'negative', 'clip'],
      ['l4', 'base', 'conditioning', 'cond', 'cond'],
      ['l5', 'scheduled', 'conditioning', 'cond', 'cond_NEW'],
      ['l6', 'range', 'TIMESTEPS_RANGE', 'cond', 'timesteps'],
      ['l7', 'kf0', 'HOOK_KF', 'kf1', 'prev_hook_kf'],
      ['l8', 'lora', 'hooks', 'hooks', 'hooks'],
      ['l9', 'kf1', 'HOOK_KF', 'hooks', 'hook_kf'],
      ['l10', 'cond', 'conditioning', 'pair', 'positive_NEW'],
      ['l11', 'negative', 'conditioning', 'pair', 'negative_NEW'],
      ['l12', 'hooks', 'hooks', 'pair', 'hooks'],
      ['l13', 'load', 'model', 'sampler', 'model'],
      ['l14', 'latent', 'latent', 'sampler', 'latent_image'],
      ['l15', 'pair', 'positive', 'sampler', 'positive'],
      ['l16', 'pair', 'negative', 'sampler', 'negative'],
      ['l17', 'sampler', 'latent', 'decode', 'samples'],
      ['l18', 'load', 'vae', 'decode', 'vae'],
      ['l19', 'decode', 'image', 'save', 'images'],
    ].map(([id, fromNode, fromPort, toNode, toPort]) => [id, {
      id, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort },
    }]))
    const positions = {
      load: [60, 80], base: [360, 40], scheduled: [360, 260], negative: [360, 480],
      range: [680, 40], cond: [680, 260], lora: [60, 420], kf0: [360, 700],
      kf1: [680, 700], hooks: [980, 700], pair: [1010, 260], latent: [1010, 40],
      sampler: [1330, 250], decode: [1640, 250], save: [1940, 250],
    }
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'lora-conditioning-scheduling-live', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes, links, nets: {}, reroutes: {}, nextOrdinal: 40 } },
      view: { graphs: { g0: { nodes: Object.fromEntries(
        Object.entries(positions).map(([id, [x, y]]) => [id, { position: { x, y } }]),
      ) } } },
    } as never, 'LoRA + Conditioning Schedule')
    window.__dinksterTest!.renderer!.setViewport({ x: 30, y: 90, scale: 0.58 })
  }, { checkpoint, lora, varying })
}

async function imageSha256(image: ReturnType<Page['locator']>): Promise<string> {
  return image.evaluate(async (element) => {
    const response = await fetch((element as HTMLImageElement).src)
    const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer())
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
  })
}

test.beforeEach(async ({ page }) => {
  test.skip(process.env['DINKSTER_SCHEDULING_LIVE'] !== '1', 'set DINKSTER_SCHEDULING_LIVE=1 with the documented SD1.5 proof assets installed')
  let nodes: Record<string, unknown> | undefined
  try {
    const response = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(2_000) })
    if (response.ok) nodes = (await response.json() as { nodes: Record<string, unknown> }).nodes
  } catch { /* handled by the skip below */ }
  test.skip(nodes === undefined, `no native Dinkster backend reachable at ${NATIVE_BACKEND}`)
  test.skip(requiredNodeTypes.some((nodeType) => !(nodeType in nodes!)), 'live backend lacks required scheduling nodes')
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('connected', { timeout: 15_000 })
})

test('scheduled LoRA and conditioning execute natively and visibly change output', async ({ page }) => {
  await openScheduledWorkflow(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    let tab = app.activeTab()!
    tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'kf0', inputId: 'strength_mult', value: 0.25 },
    })
    const exported = app.exportDocument(tab.id)!
    app.openDocument(JSON.parse(JSON.stringify(exported)), 'Scheduling Round Trip')
    tab = app.activeTab()!
    if (tab.store.doc.graphs.g0.nodes.kf0.values.strength_mult !== 0.25) {
      throw new Error('edited LoRA curve did not survive graph round-trip')
    }
    tab.store.dispatch({
      command: 'node.remove',
      params: { graphId: 'g0', nodeIds: ['kf1'] },
    })
    if (tab.store.doc.graphs.g0.nodes.kf1 !== undefined) {
      throw new Error('LoRA curve point was not removed')
    }
    tab.store.undo()
    if (tab.store.doc.graphs.g0.nodes.kf1 === undefined) {
      throw new Error('LoRA curve point removal did not undo')
    }
    tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'kf0', inputId: 'strength_mult', value: 0 },
    })
    tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'range', inputId: 'end_percent', value: 2 },
    })
    window.__dinksterTest!.renderer!.setViewport({ x: 30, y: 90, scale: 0.58 })
  })
  await expect(page.getByTestId('problems-panel')).toContainText('widget.FLOAT.aboveMax')
  await page.evaluate(() => {
    const tab = (window.__dinksterTest!.app as any).activeTab()!
    tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'range', inputId: 'end_percent', value: 0.55 },
    })
  })
  await expect(page.getByTestId('problems-panel')).not.toContainText('widget.FLOAT.aboveMax')
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })

  const workflowScreenshot = test.info().outputPath('scheduled-workflow.png')
  await page.screenshot({ path: workflowScreenshot, animations: 'disabled' })
  await test.info().attach('scheduled-workflow', {
    path: workflowScreenshot,
    contentType: 'image/png',
  })
  await page.getByTestId('queue-button').click()
  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 60_000 })

  const image = page.getByTestId('outputs-panel').locator('.output-thumbnail img').first()
  await expect(image).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth), { timeout: 15_000 }).toBe(512)
  expect(await image.evaluate((element) => (element as HTMLImageElement).naturalHeight)).toBe(512)
  const outputScreenshot = test.info().outputPath('scheduled-output.png')
  await page.screenshot({ path: outputScreenshot, animations: 'disabled' })
  await test.info().attach('scheduled-output', {
    path: outputScreenshot,
    contentType: 'image/png',
  })
  const scheduledHash = await imageSha256(image)

  await openScheduledWorkflow(page, false)
  await page.getByTestId('queue-button').click()
  const flatRow = page.getByTestId('execution-row').first()
  await expect(flatRow.locator('.execution-status')).toHaveText('Completed', { timeout: 60_000 })
  await flatRow.locator('.execution-open').click()
  const flatImage = page.getByTestId('outputs-panel').locator('.output-thumbnail img').first()
  await expect(flatImage).toBeVisible({ timeout: 15_000 })
  const flatHash = await imageSha256(flatImage)
  expect(flatHash).not.toBe(scheduledHash)
  const comparisonScreenshot = test.info().outputPath('flat-schedule-output.png')
  await page.mouse.move(20, 20)
  await page.waitForTimeout(300)
  await page.screenshot({ path: comparisonScreenshot, animations: 'disabled' })
  await test.info().attach('flat-schedule-output', {
    path: comparisonScreenshot,
    contentType: 'image/png',
  })
  await test.info().attach('output-hashes', {
    body: JSON.stringify({ seed: 8_675_309, scheduledHash, flatHash }, null, 2),
    contentType: 'application/json',
  })
})
