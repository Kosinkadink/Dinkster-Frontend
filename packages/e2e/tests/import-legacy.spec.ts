/**
 * Legacy litegraph import through the real app: openDocument detects the
 * foreign format, translates it against the backend schema registry
 * (positional widgets -> ID-keyed values, Reroute nodes -> first-class
 * reroutes, Set/Get and Use Everywhere -> named nets) and the result renders
 * + surfaces translation notes in the problems panel. The store must only
 * ever contain the native format.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, openRailPanel, test } from './fixtures.js'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
const groupEvidenceDir = fileURLToPath(new URL('../../../docs/evidence/issue-681/', import.meta.url))
const importEvidenceDir = fileURLToPath(new URL('../../../test-results/issue-381/', import.meta.url))
const comboEvidenceDir = fileURLToPath(new URL('../../../test-results/issue-118/', import.meta.url))
const clientModuleUrl = `/@fs${fileURLToPath(new URL('../../client/src/index.ts', import.meta.url))}`
const sd15DefaultWorkflow = JSON.parse(readFileSync(
  fileURLToPath(new URL('../fixtures/comfyui-default-workflow.json', import.meta.url)),
  'utf8',
)) as Record<string, unknown>
const legacyObjectInfo = (() => {
  const fixture = JSON.parse(readFileSync(
    fileURLToPath(new URL('../../core/fixtures/object_info.json', import.meta.url)),
    'utf8',
  )) as Record<string, any>
  const selected = Object.fromEntries(
    ['CheckpointLoaderSimple', 'CLIPTextEncode', 'KSampler'].map((type) => [type, fixture[type]]),
  )
  selected['CheckpointLoaderSimple'].input.required.ckpt_name[0] = ['v1-5-pruned-emaonly.safetensors']
  return selected
})()

const exactGroupPayload = (): Record<string, unknown> => {
  const raw = JSON.parse(readFileSync(
    fileURLToPath(new URL('../../core/fixtures/dinkster-nodes-comfy.json', import.meta.url)),
    'utf8',
  )) as Record<string, any>
  const source = (nativeType: 'comfy.EmptyImage' | 'comfy.PreviewImage', nodeType: string): any => {
    const schema = structuredClone(raw['nodes'][nativeType])
    schema.nodeType = nodeType
    delete schema.aliases
    delete schema.pack
    delete schema.signature
    return schema
  }
  const emptyType = 'comfy_group_source:comfy-core/EmptyImage'
  const previewType = 'comfy_group_source:comfy-core/PreviewImage'
  const groupType = 'comfy-group.comfy-core.empty-image-preview'
  const groupSchema = source('comfy.EmptyImage', groupType)
  groupSchema.interface = groupSchema.interface.filter((item: { role: string }) => item.role === 'input')
  raw['packs']['comfy'].comfyGroups = {
    format: 'dinkster-comfy-group/1',
    sourceSchemas: [
      source('comfy.EmptyImage', emptyType),
      source('comfy.PreviewImage', previewType),
    ],
    groupSchemas: [groupSchema],
    records: [{
      id: 'comfy_group:comfy-core/empty-image-preview',
      mappingKind: 'op',
      carrier: 'comfy.EmptyImage',
      source: { pack: 'comfy-core', name: 'empty-image-preview', revision: 'b78cec87' },
      pattern: {
        groupType,
        anchor: 'preview',
        nodes: {
          image: {
            source: { pack: 'comfy-core', nodeClass: 'EmptyImage', nodeType: emptyType, revision: 'b78cec87' },
            mode: 'active',
          },
          preview: {
            source: { pack: 'comfy-core', nodeClass: 'PreviewImage', nodeType: previewType, revision: 'b78cec87' },
            mode: 'active',
          },
        },
        edges: [{ from: 'image:image', to: 'preview:images' }],
        disconnected: [],
        boundary: { inputs: {}, outputs: {} },
        parameters: {
          width: 'image:width',
          height: 'image:height',
          batch_size: 'image:batch_size',
          color: 'image:color',
        },
        constants: {},
      },
      replacement: {
        from: groupType,
        cases: [{
          to: 'comfy.EmptyImage',
          inputs: {
            width: { kind: 'copy', input: 'width' },
            height: { kind: 'copy', input: 'height' },
            batch_size: { kind: 'copy', input: 'batch_size' },
            color: { kind: 'copy', input: 'color' },
          },
        }],
      },
      confidence: { tier: 'grouped', evidence: ['tests/empty-image-preview.json'] },
    }],
  }
  return raw
}

test.beforeAll(() => {
  mkdirSync(groupEvidenceDir, { recursive: true })
  if (process.env['DINKSTER_CAPTURE_ISSUE_381_IMPORT'] === '1') {
    mkdirSync(importEvidenceDir, { recursive: true })
  }
  if (process.env['DINKSTER_CAPTURE_ISSUE_118_IMPORT'] === '1') {
    mkdirSync(comboEvidenceDir, { recursive: true })
  }
})

test.beforeEach(async ({ page }) => {
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.routeWebSocket('/ws*', () => {})
})

/** A representative legacy workflow: direct, KJNodes Set/Get, and Use
 * Everywhere CLIP paths, plus a KSampler with a controller extra, a group,
 * and a note. Node types resolve against a captured object_info fixture. */
const legacyWorkflow = {
  last_node_id: 12,
  last_link_id: 15,
  nodes: [
    {
      id: 1,
      type: 'CheckpointLoaderSimple',
      pos: [80, 120],
      outputs: [
        { name: 'MODEL', type: 'MODEL', links: [] },
        { name: 'CLIP', type: 'CLIP', links: [10] },
        { name: 'VAE', type: 'VAE', links: [] },
      ],
      widgets_values: ['v1-5-pruned-emaonly.safetensors'],
    },
    {
      id: 12,
      type: 'CheckpointLoaderSimple',
      pos: [80, 680],
      outputs: [
        { name: 'MODEL', type: 'MODEL', links: [] },
        { name: 'CLIP', type: 'CLIP', links: [14, 15] },
        { name: 'VAE', type: 'VAE', links: [] },
      ],
      widgets_values: ['v1-5-pruned-emaonly.safetensors'],
    },
    {
      id: 11,
      type: 'CheckpointLoaderSimple',
      pos: [80, 400],
      outputs: [
        { name: 'MODEL', type: 'MODEL', links: [] },
        { name: 'CLIP', type: 'CLIP', links: [12] },
        { name: 'VAE', type: 'VAE', links: [] },
      ],
      widgets_values: ['v1-5-pruned-emaonly.safetensors'],
    },
    {
      id: 5,
      type: 'Reroute',
      pos: [300, 120],
      inputs: [{ name: '', type: '*', link: 10 }],
      outputs: [{ name: '', type: 'CLIP', links: [11] }],
    },
    {
      id: 2,
      type: 'CLIPTextEncode',
      pos: [500, 100],
      inputs: [{ name: 'clip', type: 'CLIP', link: 11 }],
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [] }],
      widgets_values: ['a photo of a cat'],
    },
    {
      id: 6,
      type: 'SetNode',
      pos: [350, 400],
      inputs: [{ name: '*', type: '*', link: 12 }],
      outputs: [{ name: '*', type: '*', links: [] }],
      widgets_values: ['clipline'],
    },
    {
      id: 7,
      type: 'GetNode',
      pos: [470, 400],
      outputs: [{ name: '*', type: '*', links: [13] }],
      widgets_values: ['clipline'],
    },
    {
      id: 3,
      type: 'CLIPTextEncode',
      pos: [500, 400],
      inputs: [{ name: 'clip', type: 'CLIP', link: 13 }],
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [] }],
      widgets_values: ['a watercolor of a dog'],
    },
    {
      id: 8,
      type: 'CLIPTextEncode',
      pos: [850, 680],
      inputs: [{ name: 'clip', type: 'CLIP', link: 14 }],
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [] }],
      widgets_values: ['a charcoal sketch of a fox'],
    },
    {
      id: 10,
      type: 'Anything Everywhere',
      pos: [300, 680],
      inputs: [{ name: 'anything', type: '*', link: 15 }],
    },
    {
      id: 4,
      type: 'KSampler',
      pos: [900, 100],
      mode: 2,
      inputs: [
        { name: 'model', type: 'MODEL', link: null },
        { name: 'positive', type: 'CONDITIONING', link: null },
        { name: 'negative', type: 'CONDITIONING', link: null },
        { name: 'latent_image', type: 'LATENT', link: null },
      ],
      outputs: [{ name: 'LATENT', type: 'LATENT', links: [] }],
      widgets_values: [42, 'randomize', 20, 8.0, 'euler', 'normal', 1.0],
    },
    { id: 9, type: 'Note', pos: [80, 400], widgets_values: ['legacy note text'] },
  ],
  links: [
    [10, 1, 1, 5, 0, '*'],
    [11, 5, 0, 2, 0, 'CLIP'],
    [12, 11, 1, 6, 0, '*'],
    [13, 7, 0, 3, 0, 'CLIP'],
    [14, 12, 1, 8, 0, 'CLIP'],
    [15, 12, 1, 10, 0, 'CLIP'],
  ],
  groups: [{ title: 'Encoding', bounding: [60, 70, 700, 230], color: '#3f789e' }],
  config: {},
  extra: {
    ue_links: [{
      downstream: 8,
      downstream_slot: 0,
      upstream: '12',
      upstream_slot: 1,
      controller: 10,
      type: 'CLIP',
    }],
    links_added_by_ue: ['14'],
  },
  version: 0.4,
}

const sd15AliasWorkflow = {
  nodes: [
    { id: 1, type: 'CheckpointLoaderSimple', pos: [0, 0], outputs: [{ name: 'MODEL' }, { name: 'CLIP' }, { name: 'VAE' }], widgets_values: ['sd15.safetensors'] },
    { id: 2, type: 'CLIPTextEncode', pos: [300, 0], inputs: [{ name: 'clip' }], outputs: [{ name: 'CONDITIONING' }], widgets_values: ['positive'] },
    { id: 3, type: 'CLIPTextEncode', pos: [300, 240], inputs: [{ name: 'clip' }], outputs: [{ name: 'CONDITIONING' }], widgets_values: ['negative'] },
    { id: 4, type: 'EmptyLatentImage', pos: [300, 480], outputs: [{ name: 'LATENT' }], widgets_values: [512, 512, 1] },
    {
      id: 5,
      type: 'KSampler',
      pos: [640, 160],
      inputs: [{ name: 'model' }, { name: 'positive' }, { name: 'negative' }, { name: 'latent_image' }],
      outputs: [{ name: 'LATENT' }],
      widgets_values: [7, 'fixed', 20, 8, 'euler', 'normal', 1],
    },
    { id: 6, type: 'VAEDecode', pos: [940, 160], inputs: [{ name: 'samples' }, { name: 'vae' }], outputs: [{ name: 'IMAGE' }] },
    { id: 7, type: 'PreviewImage', pos: [1240, 160], inputs: [{ name: 'images' }] },
  ],
  links: [
    [1, 1, 0, 5, 0, 'MODEL'],
    [2, 1, 1, 2, 0, 'CLIP'],
    [3, 1, 1, 3, 0, 'CLIP'],
    [4, 2, 0, 5, 1, 'CONDITIONING'],
    [5, 3, 0, 5, 2, 'CONDITIONING'],
    [6, 4, 0, 5, 3, 'LATENT'],
    [7, 5, 0, 6, 0, 'LATENT'],
    [8, 1, 2, 6, 1, 'VAE'],
    [9, 6, 0, 7, 0, 'IMAGE'],
  ],
  groups: [],
  version: 0.4,
}

test('translates a legacy litegraph workflow into the native format', async ({ page }) => {
  await page.route('/object_info', (route) => route.fulfill({ json: legacyObjectInfo }))
  await page.goto('/')
  await expect(page.locator('.conn-status')).toHaveText('connected', { timeout: 15_000 })
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })

  const result = await page.evaluate((json) => {
    const app = window.__dinksterTest!.app
    const failures = app.openDocument(json, 'Legacy')
    const tab = app.activeTab()!
    const doc = tab.store.doc
    return { failures, doc }
  }, legacyWorkflow) as unknown as {
    failures: readonly unknown[]
    doc: {
      format: string
      lineage: string
      graphs: Record<
        string,
        {
          nodes: Record<
            string,
            { type: string; values: Record<string, unknown>; controllers?: Record<string, string>; mode?: string }
          >
          links: Record<string, { from: Record<string, string>; to: Record<string, string> }>
          nets: Record<string, { name: string; source: { node: string; port: string }; sinks: readonly { node: string; port: string }[] }>
          reroutes: Record<string, { id: string }>
        }
      >
    }
  }

  expect(result.failures).toEqual([])
  expect(result.doc.format).toBe('dinkster-workflow')
  expect(result.doc.lineage).toMatch(/^lg-/)

  const g = result.doc.graphs['g0']!
  // Positional -> ID-keyed widget values via the live schemas.
  expect(g.nodes['n1']!.values).toEqual({ ckpt_name: 'v1-5-pruned-emaonly.safetensors' })
  expect(g.nodes['n2']!.values).toEqual({ text: 'a photo of a cat' })
  expect(g.nodes['n4']!.values).toMatchObject({ seed: 42, steps: 20, sampler_name: 'euler' })
  expect(g.nodes['n4']!.controllers).toEqual({ seed: 'randomize' })
  expect(g.nodes['n4']!.mode).toBe('muted')
  // Sugar nodes never reach the native document.
  expect(g.nodes['n5']).toBeUndefined()
  expect(g.nodes['n6']).toBeUndefined()
  expect(g.nodes['n7']).toBeUndefined()
  expect(g.nodes['n9']).toBeUndefined()
  expect(g.nodes['n10']).toBeUndefined()
  expect(g.nodes['n11']!.values).toEqual({ ckpt_name: 'v1-5-pruned-emaonly.safetensors' })
  expect(g.nodes['n12']!.values).toEqual({ ckpt_name: 'v1-5-pruned-emaonly.safetensors' })
  // The Reroute node became a first-class reroute (r5) with segmented links
  // through it: n1.out1 -> r5 -> n2.clip.
  expect(Object.keys(g.reroutes)).toEqual(['r5'])
  const links = Object.values(g.links)
  expect(links).toHaveLength(2)
  expect(links).toContainEqual(
    expect.objectContaining({ from: { node: 'n1', port: 'out1' }, to: { reroute: 'r5' } }),
  )
  expect(links).toContainEqual(
    expect.objectContaining({ from: { reroute: 'r5' }, to: { node: 'n2', port: 'clip' } }),
  )
  // Set/Get became a named net.
  const nets = new Map(Object.values(g.nets).map((net) => [net.name, net]))
  expect(nets.size).toBe(2)
  expect(nets.get('clipline')!.source).toEqual({ node: 'n11', port: 'out1' })
  expect(nets.get('clipline')!.sinks).toEqual([{ node: 'n3', port: 'clip' }])
  expect(nets.get('use_everywhere_0')!.source).toEqual({ node: 'n12', port: 'out1' })
  expect(nets.get('use_everywhere_0')!.sinks).toEqual([{ node: 'n8', port: 'clip' }])

  // The net renders as a labeled noodle in the scene.
  const netNames = await page.evaluate(() =>
    window
      .__dinksterTest!.renderer!.getScene()
      .links.map((l) => l.netName)
      .filter(Boolean),
  )
  expect(netNames).toContain('clipline')
  expect(netNames).toContain('use_everywhere_0')

  // Translation notes surface for review.
  await expect(page.getByTestId('problems-panel')).toContainText('import.reroute.converted')
  await expect(page.getByTestId('problems-panel')).toContainText('import.net.converted')
  await expect(page.getByTestId('problems-panel')).toContainText('import.ue.converted')

  if (process.env['DINKSTER_CAPTURE_ISSUE_381_IMPORT'] === '1') {
    await page.setViewportSize({ width: 1600, height: 900 })
    await openRailPanel(page, 'Problems')
    await page.evaluate(() => {
      window.__dinksterTest!.renderer!.setViewport({ x: 40, y: 20, scale: 0.8 })
    })
    await page.mouse.move(0, 0)
    await page.waitForTimeout(350)
    await page.screenshot({
      path: `${importEvidenceDir}/import-named-nets.png`,
      fullPage: true,
      animations: 'disabled',
    })
  }

  const stability = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const doc = tab.store.doc
    const exported = (app as unknown as { exportDocument(id: string): unknown }).exportDocument(tab.id)!
    const reopenFailures = app.openDocument(JSON.parse(JSON.stringify(exported)), 'Legacy reopened')
    return { reopenFailures, doc, reopened: app.activeTab()!.store.doc }
  })
  expect(stability.reopenFailures).toEqual([])
  expect(stability.reopened).toEqual(stability.doc)

  let submitted: Record<string, unknown> | undefined
  await page.route('**/prompt', async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ prompt_id: 'import-equivalence', number: 0, node_errors: {} }),
    })
  })
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queue(app.activeTab()!)
  })
  expect(submitted).toBeDefined()
  const prompt = submitted!['prompt'] as Record<string, { class_type: string; inputs: Record<string, unknown> }>
  expect(prompt['n2']!.inputs['clip']).toEqual(['n1', 1])
  expect(prompt['n3']!.inputs['clip']).toEqual(['n11', 1])
  expect(prompt['n8']!.inputs['clip']).toEqual(['n12', 1])
  expect(prompt['n2']!.inputs['text']).toBe('a photo of a cat')
  expect(prompt['n3']!.inputs['text']).toBe('a watercolor of a dog')
  expect(prompt['n8']!.inputs['text']).toBe('a charcoal sketch of a fox')
  expect(prompt['n6']).toBeUndefined()
  expect(prompt['n7']).toBeUndefined()
  expect(prompt['n10']).toBeUndefined()
})

test('collapses an exact maintained group into its native replacement', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })

  const result = await page.evaluate(async ({ workflow, payload, moduleUrl }) => {
    const client = await import(/* @vite-ignore */ moduleUrl) as {
      buildDinksterRegistry(connection: unknown, value: unknown): unknown
    }
    const app = window.__dinksterTest!.app
    const backend = app.backends.get()[0]! as unknown as {
      id: unknown
      registry: { set(value: unknown): void }
    }
    backend.registry.set(client.buildDinksterRegistry(backend.id, payload))
    const failures = app.openDocument(workflow, 'Exact group import')
    const tab = app.activeTab()!
    const graph = tab.store.doc.graphs[tab.store.doc.root]!
    return {
      failures,
      nodes: Object.values(graph.nodes).map((node) => ({
        id: node.id,
        type: node.type,
        values: node.values,
      })),
      position: tab.store.doc.view.graphs[tab.store.doc.root]!.nodes['n2']?.position,
    }
  }, {
    moduleUrl: clientModuleUrl,
    payload: exactGroupPayload(),
    workflow: {
      nodes: [
        {
          id: 1,
          type: 'EmptyImage',
          pos: [50, 100],
          outputs: [{ name: 'IMAGE', links: [1] }],
          widgets_values: [640, 384, 2, 32],
        },
        {
          id: 2,
          type: 'PreviewImage',
          pos: [500, 220],
          inputs: [{ name: 'images', link: 1 }],
        },
      ],
      links: [[1, 1, 0, 2, 0, 'IMAGE']],
      groups: [],
      version: 0.4,
    },
  })

  expect(result.failures).toEqual([])
  expect(result.nodes).toEqual([{
    id: 'n2',
    type: 'comfy.EmptyImage',
    values: { width: 640, height: 384, batch_size: 2, color: 32 },
  }])
  expect(result.position).toEqual({ x: 500, y: 220 })
  await expect(page.getByTestId('problems-panel')).toContainText('import.comfyGroup.collapsed')
  await expect(page.getByTestId('problems-panel')).toContainText('grouped=1')

  if (process.env['DINKSTER_CAPTURE_ISSUE_681_GROUP'] === '1') {
    await openRailPanel(page, 'Problems')
    await page.mouse.move(0, 0)
    await page.waitForTimeout(350)
    await page.screenshot({
      path: `${groupEvidenceDir}/exact-group-import.png`,
      fullPage: true,
      animations: 'disabled',
    })
  }
})

test('native alias import is canonical before badges, save/reopen, and submission', async ({ page }) => {
  const served = await page.request.get(`${NATIVE_BACKEND}/api/nodes?wire=3,4,5,6,10,11,12,13,14,15,16`).catch(() => null)
  test.skip(served === null || !served.ok(), `no native Dinkster backend reachable at ${NATIVE_BACKEND}`)

  // This spec intentionally exercises the live native backend through the
  // same-origin Vite proxy. The shared fixture disables native discovery for
  // legacy V1 tests; remove only those two fixture routes before navigation.
  await page.unroute('/api/nodes*')
  await page.unroute('/supervisor/status')
  await page.goto('/')
  await page.waitForFunction(() => {
    const backend = window.__dinksterTest?.app.backends.get().find((candidate) => candidate.protocol === 'dinkster')
    return backend?.registry.get() !== undefined
  })

  const imported = await page.evaluate(({ workflow }) => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get().find((candidate) => candidate.protocol === 'dinkster')!
    const failures = (app.openDocument as unknown as (...args: unknown[]) => readonly unknown[])(
      workflow,
      'SD1.5 aliases',
      backend,
    )
    const tab = app.activeTab()!
    app.setTabTarget(tab.id, backend.id)
    const first = tab.store.doc
    const scans = (app as unknown as { scanTabReplacements(value: unknown): readonly unknown[] }).scanTabReplacements(tab)
    const exported = (app as unknown as { exportDocument(id: string): unknown }).exportDocument(tab.id)!
    const reopenFailures = app.openDocument(JSON.parse(JSON.stringify(exported)), 'SD1.5 reopened')
    const reopened = app.activeTab()!
    app.setTabTarget(reopened.id, backend.id)
    const reopenedDocument = reopened.store.doc
    const setValue = (nodeId: string, inputId: string, value: unknown): void => {
      const result = reopened.store.dispatch({
        command: 'node.setValue',
        params: { graphId: 'g0', nodeId, inputId, value },
      })
      if (!result.ok) throw new Error(`could not prepare ${nodeId}.${inputId}`)
    }
    // Native std schemas intentionally replaced Comfy's checkpoint path with
    // a typed asset and made CLIP text a plain semantic input. Prepare valid
    // execution values after the import round-trip; the intercepted request
    // below proves canonical lowering without executing.
    setValue('n1', 'checkpoint', {
      digest: `blake3:${'0'.repeat(64)}`,
      name: 'sd15.safetensors',
      size: 1,
      mediaType: 'application/octet-stream',
      virtualPath: 'models/sd15.safetensors',
    })
    setValue('n2', 'text', 'positive')
    setValue('n3', 'text', 'negative')
    const badges = window.__dinksterTest!.renderer!.getBadges()
    return {
      failures,
      reopenFailures,
      scans,
      first,
      reopened: reopenedDocument,
      badgeIds: Object.values(badges).flatMap((rows) => rows.map((badge) => badge.id)),
      problemCodes: app.problems.get().map((problem) => problem.code),
    }
  }, { workflow: sd15AliasWorkflow })

  expect(imported.failures).toEqual([])
  expect(imported.reopenFailures).toEqual([])
  expect(imported.scans).toEqual([])
  const graph = imported.first.graphs['g0']!
  expect(Object.values(graph.nodes).map((node) => node.type)).toEqual([
    'dinkster.load_checkpoint',
    'dinkster.clip_text_encode',
    'dinkster.clip_text_encode',
    'dinkster.empty_latent_image',
    'dinkster.ksampler',
    'dinkster.vae_decode',
    'comfy.PreviewImage',
  ])
  expect(graph.links['l4']).toMatchObject({
    from: { node: 'n2', port: 'conditioning' },
    to: { node: 'n5', port: 'positive' },
  })
  expect(graph.links['l5']).toMatchObject({
    from: { node: 'n3', port: 'conditioning' },
    to: { node: 'n5', port: 'negative' },
  })
  expect(graph.links).toMatchObject({
    l1: { from: { node: 'n1', port: 'model' }, to: { node: 'n5', port: 'model' } },
    l2: { from: { node: 'n1', port: 'clip' }, to: { node: 'n2', port: 'clip' } },
    l3: { from: { node: 'n1', port: 'clip' }, to: { node: 'n3', port: 'clip' } },
    l4: { from: { node: 'n2', port: 'conditioning' }, to: { node: 'n5', port: 'positive' } },
    l5: { from: { node: 'n3', port: 'conditioning' }, to: { node: 'n5', port: 'negative' } },
    l6: { from: { node: 'n4', port: 'latent' }, to: { node: 'n5', port: 'latent_image' } },
    l7: { from: { node: 'n5', port: 'latent' }, to: { node: 'n6', port: 'samples' } },
    l8: { from: { node: 'n1', port: 'vae' }, to: { node: 'n6', port: 'vae' } },
    l9: { from: { node: 'n6', port: 'image' }, to: { node: 'n7', port: 'images' } },
  })
  expect(imported.reopened.graphs['g0']!.nodes).toEqual(graph.nodes)
  expect(imported.reopened.graphs['g0']!.links).toEqual(graph.links)
  expect(imported.badgeIds).not.toContain('core.deprecated')
  expect(imported.problemCodes).not.toContain('replace.applied')
  expect(imported.problemCodes).not.toContain('replace.review')
  expect(imported.problemCodes).not.toContain('replace.outputDropped')

  let submitted: Record<string, unknown> | undefined
  await page.route('**/api/assets', (route) => route.fulfill({ status: 503, body: '{}' }))
  await page.route('**/api/jobs', async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobRef: 'alias-import-proof' }) })
  })
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queue(app.activeTab()!)
  })
  expect(submitted).toBeDefined()
  const submittedGraph = submitted!['graph'] as { nodes: Record<string, { nodeType: string; inputs: Record<string, unknown> }> }
  expect(submittedGraph.nodes['n2']!.nodeType).toBe('dinkster.clip_text_encode')
  expect(submittedGraph.nodes['n5']!.inputs['positive']).toEqual({ $link: { node: 'n2', output: 'conditioning' } })
  expect(submittedGraph.nodes['n5']!.inputs['negative']).toEqual({ $link: { node: 'n3', output: 'conditioning' } })
})

test('audit SD1.5 workflow import preserves canonical combos without false errors', async ({ page }) => {
  const served = await page.request.get(`${NATIVE_BACKEND}/api/nodes`).catch(() => null)
  test.skip(served === null || !served.ok(), `no native Dinkster backend reachable at ${NATIVE_BACKEND}`)

  await page.unroute('/api/nodes*')
  await page.unroute('/supervisor/status')
  await page.route('/api/assets/guess', async (route) => {
    const body = route.request().postDataJSON() as { names: string[] }
    await route.fulfill({ json: { matches: body.names.map((query) => ({
      query,
      candidates: query === 'v1-5-pruned-emaonly-fp16.safetensors' ? [{
        digest: 'blake3:4c50ebc6e2a5cb19e8d19626d5ede1fb64755562085ce7383d86c72d1d03eb7e',
        name: query,
        confidence: 'name',
        held: true,
        virtualPath: `mounts/checkpoints/${query}`,
        size: 2_132_696_762,
        mediaType: 'application/octet-stream',
      }] : [],
    })) } })
  })
  await page.goto('/')
  await page.waitForFunction(() => {
    const backend = window.__dinksterTest?.app.backends.get().find((candidate) => candidate.protocol === 'dinkster')
    return backend?.registry.get() !== undefined
  })

  const imported = await page.evaluate((workflow) => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get().find((candidate) => candidate.protocol === 'dinkster')!
    const failures = (app.openDocument as unknown as (...args: unknown[]) => readonly unknown[])(
      workflow,
      'Default SD1.5 workflow',
      backend,
    )
    const tab = app.activeTab()!
    app.setTabTarget(tab.id, backend.id)
    const graph = tab.store.doc.graphs[tab.store.doc.root]!
    return {
      failures,
      nodeTypes: Object.values(graph.nodes).map((node) => node.type),
      samplerValues: graph.nodes['n5']?.values,
      errors: app.problems.get().filter((problem) => problem.severity === 'error'),
    }
  }, sd15DefaultWorkflow)

  expect(imported.failures).toEqual([])
  expect(imported.nodeTypes).toContain('dinkster.ksampler')
  expect(imported.samplerValues).toMatchObject({
    sampler_name: 'dinkster.euler',
    scheduler: 'dinkster.normal',
  })
  expect(imported.errors).toEqual([])

  await openRailPanel(page, 'Problems')
  await expect(page.getByTestId('problems-panel')).not.toContainText('sampler_name')
  await expect(page.getByTestId('problems-panel')).not.toContainText('scheduler')
  if (process.env['DINKSTER_CAPTURE_ISSUE_118_IMPORT'] === '1') {
    await page.mouse.move(0, 0)
    await page.waitForTimeout(350)
    await page.screenshot({
      path: `${comboEvidenceDir}/default-workflow-problems.png`,
      fullPage: true,
      animations: 'disabled',
    })
  }
})
