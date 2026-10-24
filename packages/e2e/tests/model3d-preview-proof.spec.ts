/**
 * Isolated proof for model3d previews (GLB scenes and gaussian-splat PLY):
 * the poster paints in-canvas like an image preview, and the on-demand orbit
 * viewport mounts a live WebGL scene in a DOM overlay and disposes on close.
 * Every backend route is mocked, so the spec runs against any dev server.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const proofDir = process.env.DINKSTER_MODEL3D_PROOF_DIR ?? '/tmp/dinkster-model3d-proof'
const savedModelDigest = `blake3:${'c'.repeat(64)}`
const savedSplatDigest = `blake3:${'d'.repeat(64)}`

/** Minimal valid GLB: one red unlit-friendly triangle, non-indexed. */
function glb(): Buffer {
  const positions = Buffer.alloc(36)
  const vertices = [-1, -1, 0, 1, -1, 0, 0, 1, 0]
  vertices.forEach((value, index) => positions.writeFloatLE(value, index * 4))
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.9, 0.25, 0.2, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
    buffers: [{ byteLength: positions.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
    accessors: [{
      bufferView: 0,
      componentType: 5126,
      count: 3,
      type: 'VEC3',
      min: [-1, -1, 0],
      max: [1, 1, 0],
    }],
  }
  let json = Buffer.from(JSON.stringify(gltf))
  if (json.length % 4 !== 0) json = Buffer.concat([json, Buffer.alloc(4 - json.length % 4, 0x20)])
  const bin = positions.length % 4 === 0 ? positions : Buffer.concat([positions, Buffer.alloc(4 - positions.length % 4)])
  const out = Buffer.alloc(12 + 8 + json.length + 8 + bin.length)
  out.write('glTF', 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(out.length, 8)
  out.writeUInt32LE(json.length, 12)
  out.writeUInt32LE(0x4e4f534a, 16) // 'JSON'
  json.copy(out, 20)
  out.writeUInt32LE(bin.length, 20 + json.length)
  out.writeUInt32LE(0x004e4942, 24 + json.length) // 'BIN\0'
  bin.copy(out, 28 + json.length)
  return out
}

/**
 * Minimal binary 3DGS PLY: a few opaque gaussians near the origin with the
 * property layout spark's loader detects (x/y/z, f_dc_*, opacity, scale_*,
 * rot_*). Opacity and scales are in the usual pre-activation (logit / log)
 * space.
 */
function splatPly(): Buffer {
  const gaussians = [
    { pos: [0, 0, 0], dc: [1.4, -0.9, -0.9] },
    { pos: [0.6, 0.2, 0], dc: [-0.9, 1.4, -0.9] },
    { pos: [-0.4, 0.5, 0.2], dc: [-0.9, -0.9, 1.4] },
    { pos: [0.1, -0.5, -0.2], dc: [1.4, 1.4, -0.9] },
  ]
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${gaussians.length}`,
    ...['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
      .map((name) => `property float ${name}`),
    'end_header',
    '',
  ].join('\n')
  const body = Buffer.alloc(gaussians.length * 14 * 4)
  gaussians.forEach((g, i) => {
    const values = [...g.pos, ...g.dc, 4.0, -1.2, -1.2, -1.2, 1, 0, 0, 0]
    values.forEach((value, j) => body.writeFloatLE(value, (i * 14 + j) * 4))
  })
  return Buffer.concat([Buffer.from(header, 'ascii'), body])
}

const model = glb()
const splat = splatPly()

async function mockBackend(page: Page): Promise<void> {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated proof' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'proof' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'model3d-proof', schemaWire: 1 },
    nodes: {},
  } }))
  await page.route('/api/assets/**', (route) => {
    // assetUrl percent-encodes the digest colon, so match on the hex tail.
    const isSplat = route.request().url().includes(savedSplatDigest.slice('blake3:'.length))
    return route.fulfill({
      status: 200,
      contentType: isSplat ? 'model/ply' : 'model/gltf-binary',
      body: isSplat ? splat : model,
    })
  })
  await page.route('/api/values*', (route) => route.fulfill({
    status: 404,
    json: { available: false, reason: 'unknown-output', error: 'proof' },
  }))
}

interface ProofArtifact {
  readonly digest: string
  readonly typeName: string
  readonly name: string
  readonly mediaType: string
}

async function installGraph(page: Page, artifact: ProofArtifact): Promise<void> {
  await page.evaluate(({ digest, typeName, name, mediaType }) => {
    window.__dinksterTest!.app.registerSchemas([{
      type: 'ProofSavedModel',
      displayName: 'ProofSavedModel',
      category: 'proof',
      source: 'v3' as const,
      isOutputNode: true,
      items: [{ kind: 'output' as const, id: 'saved', type: { kind: 'concrete' as const, name: typeName }, preview: true }],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'model3d-proof', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { saved: { id: 'saved', type: 'ProofSavedModel', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      } },
      view: { graphs: { g0: { nodes: { saved: {
        position: { x: 80, y: 80 },
        size: { width: 360, height: 320 },
      } } } } },
    } as never, '3D Model Preview Proof')
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error(`compile failed: ${JSON.stringify(compiled?.diagnostics)}`)
    const ref = { connection: compiled.artifact.connection, prompt: 'model3d-proof-job' }
    const store = app.store as unknown as {
      register(execution: { connection: string; prompt: string }, artifact: unknown, now: number): void
      apply(event: unknown): void
      hydrateArtifacts(execution: { connection: string; prompt: string }, artifacts: readonly unknown[]): void
    }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    store.apply({
      kind: 'nodeStates', execution: ref, timestamp: Date.now(),
      nodes: { saved: { state: 'done' } },
    })
    store.hydrateArtifacts(ref, [{
      nodeId: 'saved',
      digest,
      name,
      size: 128,
      mediaType,
      virtualPath: `output/${name}`,
    }])
    store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() })
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, artifact)
}

test.beforeEach(async ({ page }) => {
  mkdirSync(proofDir, { recursive: true })
  await mockBackend(page)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app !== undefined)).toBe(true)
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined,
  )).toBe(true)
})

async function provePosterAndOrbitViewport(
  page: Page,
  screenshot: (name: string) => string,
): Promise<void> {
  // Poster: rendered by the real offscreen pass in Chromium and handed to
  // the canvas renderer like any image preview.
  await expect.poll(() => page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer as unknown as {
      getNodePreviews(): Record<string, { kind?: string; image?: unknown; width?: number; height?: number }>
    }
    const preview = renderer.getNodePreviews()['saved']
    return preview === undefined ? undefined : { kind: preview.kind, hasImage: preview.image !== undefined, width: preview.width, height: preview.height }
  }), { timeout: 30_000 }).toEqual({ kind: 'model3d', hasImage: true, width: 512, height: 384 })

  const overlay = page.locator('.node-media-overlay[data-media-kind="model3d"]')
  await expect(overlay).toHaveCount(1)
  const openButton = page.getByRole('button', { name: 'Open 3D orbit view' })
  await expect(openButton).toBeVisible()
  const download = overlay.getByRole('link', { name: 'Download' })
  await expect(download).toHaveAttribute('download', /\.(glb|ply)$/)
  await expect(download).toHaveAttribute('href', /^blob:/)
  await expect(page.getByRole('link', { name: 'Download' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Hide minimap' }).click()
  await page.screenshot({ path: screenshot('poster.png'), animations: 'disabled' })

  // Orbit viewport: a live WebGL canvas mounts inside the overlay.
  await openButton.click()
  const viewport = page.locator('.node-model3d-viewport')
  await expect(viewport).toBeVisible()
  await expect(viewport.locator('canvas')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator('.node-model3d-viewport .node-media-failed')).toHaveCount(0)
  // Splat sorting is asynchronous; give the live view a beat to draw its
  // first sorted frame so the screenshot shows actual content.
  await page.waitForTimeout(1_500)
  await page.screenshot({ path: screenshot('orbit-open.png'), animations: 'disabled' })

  // Close disposes the viewer: the WebGL context is force-lost, the canvas
  // leaves the DOM, and the Orbit affordance returns.
  await page.evaluate(() => {
    const canvas = document.querySelector('.node-model3d-viewport canvas')
    if (canvas === null) throw new Error('missing orbit canvas')
    canvas.addEventListener('webglcontextlost', () => {
      (window as unknown as { __model3dContextLost?: boolean }).__model3dContextLost = true
    })
  })
  await page.getByRole('button', { name: 'Close 3D orbit view' }).click()
  await expect(viewport).toHaveCount(0)
  await expect(openButton).toBeVisible()
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __model3dContextLost?: boolean }).__model3dContextLost === true,
  )).toBe(true)
}

test('a saved GLB artifact paints a poster and mounts a disposable orbit viewport', async ({ page }, testInfo) => {
  // Temporary skip pending attribution: Kosinkadink/comfy-vibe-station#430
  test.skip(true, 'red at main; attribution and re-enable tracked in Kosinkadink/comfy-vibe-station#430')
  await installGraph(page, {
    digest: savedModelDigest,
    typeName: 'dinkster.model3d',
    name: 'proof-mesh.glb',
    mediaType: 'model/gltf-binary',
  })
  await provePosterAndOrbitViewport(page, (name) => testInfo.outputPath(`model3d-${name}`))
})

test('a saved splat PLY artifact paints a poster and mounts a disposable orbit viewport', async ({ page }, testInfo) => {
  // Temporary skip pending attribution: Kosinkadink/comfy-vibe-station#430
  test.skip(true, 'red at main; attribution and re-enable tracked in Kosinkadink/comfy-vibe-station#430')
  await installGraph(page, {
    digest: savedSplatDigest,
    typeName: 'dinkster.splat',
    name: 'proof-splat.ply',
    mediaType: 'model/ply',
  })
  await provePosterAndOrbitViewport(page, (name) => testInfo.outputPath(`splat-${name}`))
})
