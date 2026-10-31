/**
 * Isolated proof for model3d previews (GLB scenes and gaussian-splat PLY):
 * the poster paints in-canvas like an image preview, and the on-demand orbit
 * viewport mounts a live WebGL scene in a DOM overlay and disposes on close.
 * Every backend route is mocked, so the spec runs against any dev server.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const proofDir = process.env.DINKSTER_MODEL3D_PROOF_DIR ?? '/tmp/dinkster-model3d-proof'
const savedModelDigest = `blake3:${'c'.repeat(64)}`
const savedSplatDigest = `blake3:${'d'.repeat(64)}`

/** Minimal valid GLB: one red unlit-friendly triangle, non-indexed. */
function glb(alpha = 1, animated = false): Buffer {
  const positions = Buffer.alloc(animated ? 68 : 36)
  const vertices = [-1, -1, 0, 1, -1, 0, 0, 1, 0]
  vertices.forEach((value, index) => positions.writeFloatLE(value, index * 4))
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.9, 0.25, 0.2, alpha], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true, alphaMode: alpha < 1 ? 'BLEND' : 'OPAQUE' }],
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
    ...(animated ? { animations: [{ name: 'Slide right', samplers: [{ input: 1, output: 2 }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }] } : {}),
  }
  if (animated) {
    ;[0, 1, 0, 0, 0, 2, 0, 0].forEach((value, index) => positions.writeFloatLE(value, 36 + index * 4))
    gltf.bufferViews.push({ buffer: 0, byteOffset: 36, byteLength: 8 }, { buffer: 0, byteOffset: 44, byteLength: 24 })
    gltf.accessors.push({ bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3', min: [0, 0, 0], max: [2, 0, 0] })
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
  await page.waitForFunction(() => 'status' in window.__dinksterTest!.app.activeTab()!.store)
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
  await installGraph(page, {
    digest: savedModelDigest,
    typeName: 'MODEL3D',
    name: 'proof-mesh.glb',
    mediaType: 'model/gltf-binary',
  })
  await provePosterAndOrbitViewport(page, (name) => testInfo.outputPath(`model3d-${name}`))
})

test('a saved splat PLY artifact paints a poster and mounts a disposable orbit viewport', async ({ page }, testInfo) => {
  await installGraph(page, {
    digest: savedSplatDigest,
    typeName: 'SPLAT',
    name: 'proof-splat.ply',
    mediaType: 'model/ply',
  })
  await provePosterAndOrbitViewport(page, (name) => testInfo.outputPath(`splat-${name}`))
})

test('authored captures retain material alpha and camera state across projection and capture', async ({ page }) => {
  const result = await page.evaluate(async (bytes) => {
    const modulePath = '/src/model3d-viewer.ts'
    const { mountModel3dViewer } = await import(modulePath)
    const host = document.createElement('div')
    host.style.cssText = 'width:400px;height:300px;position:fixed;inset:0;z-index:1000'
    document.body.append(host)
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'model/gltf-binary' }))
    const viewer = await mountModel3dViewer(host, url)
    try {
      const camera = {
        ...viewer.cameraState(), position: { x: 0, y: 0, z: 4 }, target: { x: 0, y: 0, z: 0 },
        customUp: { x: 1, y: 0, z: 0 }, useCustomUp: true, fov: 51, zoom: 1.2,
      }
      viewer.setCameraState(camera)
      const restored = viewer.cameraState()
      viewer.setCameraState({ ...restored, cameraType: 'orthographic', frustum: { left: -4, right: 4, top: 3, bottom: -3 } })
      const orthographic = viewer.cameraState()
      viewer.setCameraState({ ...restored, cameraType: 'perspective' })
      viewer.setModelTransform({ position: { x: 0.1, y: -0.2, z: 0 }, quaternion: { x: 0, y: 0, z: 1, w: 2 }, scale: { x: 0.8, y: 1.1, z: 1 } })
      const transform = viewer.modelTransform()
      const pendingCapture = viewer.capture(257, 143)
      viewer.setCameraState({ ...restored, position: { x: 99, y: 0, z: 4 } })
      viewer.setModelTransform({ ...transform, position: { x: 99, y: 0, z: 0 } })
      host.querySelector('canvas')!.dispatchEvent(new WheelEvent('wheel', { deltaY: 400, bubbles: true, cancelable: true }))
      const capture = await pendingCapture
      const afterTransform = viewer.modelTransform()
      const images: Record<string, { width: number; height: number; transparent: number; halfAlpha: number; opaque: number }> = {}
      for (const [name, blob] of Object.entries(capture as Record<string, Blob>)) {
        const bitmap = await createImageBitmap(blob)
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width; canvas.height = bitmap.height
        const context = canvas.getContext('2d')!
        context.drawImage(bitmap, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let transparent = 0; let halfAlpha = 0; let opaque = 0
        for (let i = 3; i < pixels.length; i += 4) {
          if (pixels[i] === 0) transparent++
          if (pixels[i]! >= 120 && pixels[i]! <= 200) halfAlpha++
          if (pixels[i] === 255) opaque++
        }
        images[name] = { width: canvas.width, height: canvas.height, transparent, halfAlpha, opaque }
        bitmap.close()
      }
      return { restored, orthographic, transform, afterTransform, after: viewer.cameraState(), images }
    } finally { viewer.dispose(); URL.revokeObjectURL(url); host.remove() }
  }, Array.from(glb(0.5)))
  expect(result.restored).toMatchObject({ customUp: { x: 1, y: 0, z: 0 }, useCustomUp: true, zoom: 1.2, fov: 51 })
  expect(result.restored.quaternion.z).toBeCloseTo(-Math.SQRT1_2, 12)
  expect(result.restored.quaternion.w).toBeCloseTo(Math.SQRT1_2, 12)
  expect(result.orthographic).toMatchObject({ cameraType: 'orthographic', frustum: { left: -4, right: 4, top: 3, bottom: -3 }, useCustomUp: true })
  expect(result.after).toEqual(result.restored)
  expect(result.afterTransform).toEqual(result.transform)
  expect(result.transform.position).toEqual({ x: 0.1, y: -0.2, z: 0 })
  expect(result.transform.quaternion.z).toBeCloseTo(1 / Math.sqrt(5), 12)
  expect(result.transform.quaternion.w).toBeCloseTo(2 / Math.sqrt(5), 12)
  for (const image of Object.values(result.images)) expect(image).toMatchObject({ width: 257, height: 143 })
  expect(result.images.mask!.transparent).toBeGreaterThan(1000)
  expect(result.images.mask!.halfAlpha).toBeGreaterThan(1000)
  expect(result.images.mask!.opaque).toBe(0)
  expect(result.images.normal!.opaque).toBe(257 * 143)
})

test('GLTF sidecars use granted bytes and an ungranted external buffer cannot load', async ({ page }) => {
  const result = await page.evaluate(async (bytes) => {
    const modulePath = '/src/model3d-viewer.ts'
    const { mountModel3dViewer } = await import(modulePath)
    const packed = new Uint8Array(bytes)
    const view = new DataView(packed.buffer)
    const jsonLength = view.getUint32(12, true)
    const json = JSON.parse(new TextDecoder().decode(packed.slice(20, 20 + jsonLength)))
    const buffer = packed.slice(28 + jsonLength)
    json.buffers[0].uri = 'buffers/mesh.bin'
    const host = document.createElement('div')
    host.style.cssText = 'width:400px;height:300px'
    document.body.append(host)
    const urls: string[] = []
    const urlFor = (blob: Blob): string => { const url = URL.createObjectURL(blob); urls.push(url); return url }
    try {
      const source = urlFor(new Blob([JSON.stringify(json)], { type: 'model/gltf+json' }))
      const resource = urlFor(new Blob([buffer]))
      const viewer = await mountModel3dViewer(host, source, 'model/gltf+json', { format: 'gltf', resources: { 'buffers/mesh.bin': resource } })
      let visible = 0
      try {
        const capture = await viewer.capture(129, 83)
        const bitmap = await createImageBitmap(capture.image)
        const canvas = document.createElement('canvas'); canvas.width = 129; canvas.height = 83
        const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0)
        const pixels = context.getImageData(0, 0, 129, 83).data
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) visible++
        bitmap.close()
      } finally { viewer.dispose() }
      json.buffers[0].uri = 'https://ungranted.invalid/mesh.bin'
      let rejection = ''
      try {
        const rejected = await mountModel3dViewer(host, urlFor(new Blob([JSON.stringify(json)])), 'model/gltf+json', { format: 'gltf', resources: {} })
        rejected.dispose()
      } catch (error) { rejection = String(error) }
      return { visible, rejection }
    } finally { urls.forEach((url) => URL.revokeObjectURL(url)); host.remove() }
  }, Array.from(glb()))
  expect(result.visible).toBeGreaterThan(100)
  expect(result.rejection).toContain('3D resource is not granted')
})

test('mesh formats render and animation seeking changes pixels without moving authored placement', async ({ page }) => {
  const result = await page.evaluate(async (bytes) => {
    const modulePath = '/src/model3d-viewer.ts'
    const { mountModel3dViewer } = await import(modulePath)
    const host = document.createElement('div'); host.style.cssText = 'width:400px;height:300px'; document.body.append(host)
    const urls: string[] = []
    const source = (data: BlobPart): string => { const url = URL.createObjectURL(new Blob([data])); urls.push(url); return url }
    const threePath = '/node_modules/.vite/deps/three.js'
    const exporterPath = '/node_modules/three/examples/jsm/exporters/USDZExporter.js'
    const THREE = await import(threePath)
    const imports = document.createElement('script'); imports.type = 'importmap'
    imports.textContent = JSON.stringify({ imports: { three: threePath } }); document.head.append(imports)
    const { USDZExporter } = await import(exporterPath)
    const scene = new THREE.Scene()
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.5), new THREE.MeshStandardMaterial({ color: 0xff4020 })))
    const samples: Record<string, BlobPart> = {
      obj: 'v -1 -1 0\nv 1 -1 0\nv 0 1 0\nf 1 2 3\n',
      stl: 'solid triangle\nfacet normal 0 0 1\nouter loop\nvertex -1 -1 0\nvertex 1 -1 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle',
      ply: 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n-1 -1 0\n1 -1 0\n0 1 0\n3 0 1 2\n',
      fbx: '; FBX 7.4.0 project file\nFBXHeaderExtension:  {\n\tFBXVersion: 7400\n}\nObjects:  {\n\tGeometry: 1, "Geometry::Triangle", "Mesh" {\n\t\tVertices: *9 {\n\t\t\ta: -1,-1,0,1,-1,0,0,1,0\n\t\t}\n\t\tPolygonVertexIndex: *3 {\n\t\t\ta: 0,1,-3\n\t\t}\n\t}\n\tModel: 2, "Model::Triangle", "Mesh" {\n\t\tVersion: 232\n\t}\n}\nConnections:  {\n\tC: "OO",1,2\n\tC: "OO",2,0\n}\n',
      usdz: await new USDZExporter().parseAsync(scene),
    }
    const pixels = async (blob: Blob): Promise<{ count: number; centerX: number }> => {
      const bitmap = await createImageBitmap(blob)
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0)
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
      let count = 0; let sumX = 0
      for (let i = 3; i < rgba.length; i += 4) if (rgba[i]! > 0) { count++; sumX += ((i - 3) / 4) % canvas.width }
      bitmap.close(); return { count, centerX: sumX / count }
    }
    const visible: Record<string, number> = {}
    try {
      for (const [format, text] of Object.entries(samples)) {
        const viewer = await mountModel3dViewer(host, source(text), 'application/octet-stream', { format, resources: {} })
        try { visible[format] = (await pixels((await viewer.capture(257, 143)).image)).count } finally { viewer.dispose() }
      }
      const viewer = await mountModel3dViewer(host, source(new Uint8Array(bytes)), 'model/gltf-binary', { resources: {} })
      try {
        viewer.setCameraState({ ...viewer.cameraState(), position: { x: 0, y: 0, z: 6 }, target: { x: 0, y: 0, z: 0 } })
        const placement = viewer.modelTransform()
        viewer.setAnimation(0, 0, false, 1)
        const before = await pixels((await viewer.capture(257, 143)).image)
        viewer.setAnimation(0, 0.5, false, 1)
        const after = await pixels((await viewer.capture(257, 143)).image)
        return { visible, before, after, clips: viewer.animationClips(), time: viewer.animationTime(), placement, afterPlacement: viewer.modelTransform() }
      } finally { viewer.dispose() }
    } finally { urls.forEach((url) => URL.revokeObjectURL(url)); host.remove() }
  }, Array.from(glb(1, true)))
  for (const [format, count] of Object.entries(result.visible)) expect(count, format).toBeGreaterThan(100)
  expect(result.clips).toEqual([{ name: 'Slide right', duration: 1 }])
  expect(result.time).toBe(0.5)
  expect(result.after.centerX - result.before.centerX).toBeGreaterThan(20)
  expect(result.afterPlacement).toEqual(result.placement)
})

test('splat, spz and ksplat scenes render their encoded gaussians', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/model3d-viewer.ts'
    const { mountModel3dViewer } = await import(modulePath)
    const centers = [[-0.5, 0, 0], [0.5, 0, 0], [0, 0.5, 0]]
    const splat = new Uint8Array(centers.length * 32)
    const ksplat = new Uint8Array(5120 + centers.length * 44)
    const ks = new DataView(ksplat.buffer)
    ks.setUint8(1, 1); ks.setUint32(4, 1, true)
    ks.setUint32(8, 1, true); ks.setUint32(12, centers.length, true); ks.setUint32(16, centers.length, true)
    ks.setUint32(4096, centers.length, true); ks.setUint32(4100, centers.length, true)
    const spz = new Uint8Array(16 + centers.length * 20)
    const sz = new DataView(spz.buffer)
    sz.setUint32(0, 0x5053474e, true); sz.setUint32(4, 3, true)
    sz.setUint32(8, centers.length, true); sz.setUint8(13, 12)
    centers.forEach((center, index) => {
      const raw = new DataView(splat.buffer, index * 32, 32)
      center.forEach((value, axis) => {
        raw.setFloat32(axis * 4, value, true); raw.setFloat32(12 + axis * 4, 0.2, true)
        ks.setFloat32(5120 + index * 44 + axis * 4, value, true)
        ks.setFloat32(5132 + index * 44 + axis * 4, 0.2, true)
        const fixed = Math.round(value * 4096)
        for (let byte = 0; byte < 3; byte++) spz[16 + index * 9 + axis * 3 + byte] = (fixed >> (byte * 8)) & 255
        spz[16 + centers.length * 13 + index * 3 + axis] = Math.round((Math.log(0.2) + 10) * 16)
        spz[16 + centers.length * 10 + index * 3 + axis] = axis === index ? 240 : 80
      })
      splat.set([255, 80, 30, 255, 255, 128, 128, 128], index * 32 + 24)
      ks.setFloat32(5144 + index * 44, 1, true)
      ksplat.set([255, 80, 30, 255], 5160 + index * 44)
      spz[16 + centers.length * 9 + index] = 255
      spz[16 + centers.length * 16 + index * 4 + 3] = 192
    })
    const compressed = await new Response(new Blob([spz]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
    const samples = { splat, spz: new Uint8Array(compressed), ksplat }
    const host = document.createElement('div'); host.style.cssText = 'width:400px;height:300px'; document.body.append(host)
    const visible: Record<string, { count: number; image: number[] }> = {}
    try {
      for (const [format, bytes] of Object.entries(samples)) {
        const url = URL.createObjectURL(new Blob([bytes]))
        try {
          const viewer = await mountModel3dViewer(host, url, 'application/octet-stream', { format })
          try {
            const image = (await viewer.capture(257, 143)).image
            const bitmap = await createImageBitmap(image)
            const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
            const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0)
            const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
            let count = 0
            for (let i = 3; i < rgba.length; i += 4) if (rgba[i]! > 0) count++
            visible[format] = { count, image: Array.from(new Uint8Array(await image.arrayBuffer())) }; bitmap.close()
          } finally { viewer.dispose() }
        } finally { URL.revokeObjectURL(url) }
      }
      return visible
    } finally { host.remove() }
  })
  mkdirSync(proofDir, { recursive: true })
  for (const [format, capture] of Object.entries(result)) {
    writeFileSync(`${proofDir}/${format}-capture.png`, Buffer.from(capture.image))
    expect(capture.count, format).toBeGreaterThan(100)
  }
})

test('anisotropic splat normal capture encodes facing normals rather than source colors', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const modulePath = '/src/model3d-viewer.ts'
    const { mountModel3dViewer } = await import(modulePath)
    const centers = [[-0.45, -0.2, 0], [0.15, 0.35, 0.1], [0.55, -0.1, -0.1]]
    const bytes = new Uint8Array(centers.length * 32)
    centers.forEach((center, index) => {
      const view = new DataView(bytes.buffer, index * 32, 32)
      center.forEach((value, axis) => view.setFloat32(axis * 4, value, true))
      ;[0.2, 0.12, 0.025].forEach((value, axis) => view.setFloat32(12 + axis * 4, value, true))
      bytes.set([255, 35, 15, 255, 255, 128, 128, 128], index * 32 + 24)
    })
    const host = document.createElement('div'); host.style.cssText = 'width:400px;height:300px'; document.body.append(host)
    const url = URL.createObjectURL(new Blob([bytes]))
    const viewer = await mountModel3dViewer(host, url, 'application/octet-stream', { format: 'splat' })
    try {
      viewer.setCameraState({ ...viewer.cameraState(), position: { x: 0, y: 0, z: 4 }, target: { x: 0, y: 0, z: 0 } })
      const capture = await viewer.capture(300, 200)
      const counts: Record<string, { red: number; blue: number; png: number[] }> = {}
      for (const name of ['image', 'normal'] as const) {
        const bitmap = await createImageBitmap(capture[name])
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
        const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close()
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let red = 0; let blue = 0
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i]! > pixels[i + 2]! + 30) red++
          if (pixels[i + 2]! > pixels[i]! + 30 && pixels[i + 2]! > pixels[i + 1]! + 30) blue++
        }
        counts[name] = { red, blue, png: Array.from(new Uint8Array(await capture[name].arrayBuffer())) }
      }
      return counts
    } finally { viewer.dispose(); URL.revokeObjectURL(url); host.remove() }
  })
  mkdirSync(proofDir, { recursive: true })
  for (const [name, capture] of Object.entries(result)) writeFileSync(`${proofDir}/anisotropic-${name}.png`, Buffer.from(capture.png))
  expect(result.image!.red).toBeGreaterThan(100)
  expect(result.normal!.blue).toBeGreaterThan(100)
  expect(result.normal!.red).toBe(0)
})

test('backend quaternion and orthographic resize preserve authored orientation and proportions', async ({ page }) => {
  const result = await page.evaluate(async (bytes) => {
    const modulePath = '/src/model3d-viewer.ts'
    const { mountModel3dViewer } = await import(modulePath)
    const host = document.createElement('div'); host.style.cssText = 'width:400px;height:300px;position:fixed;inset:0;z-index:1000'
    document.body.append(host)
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]))
    const viewer = await mountModel3dViewer(host, url, 'model/gltf-binary')
    try {
      viewer.setCameraState({ position: { x: 0, y: 0, z: 6 }, target: { x: 0, y: 0, z: 5 }, zoom: 1,
        cameraType: 'orthographic', frustum: { left: -3, right: 5, top: 3, bottom: -3 },
        quaternion: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }, useCustomUp: true })
      const opened = viewer.cameraState()
      host.style.width = '600px'
      await new Promise<void>((resolve) => {
        const observer = new ResizeObserver(() => { requestAnimationFrame(() => { observer.disconnect(); resolve() }) })
        observer.observe(host)
      })
      const resized = viewer.cameraState()
      const session = viewer.recordingStream(300, 300)
      const recording = viewer.cameraState()
      session.stop()
      const restored = viewer.cameraState()
      const capture = await viewer.capture(600, 300)
      return { opened, resized, recording, restored, afterCapture: viewer.cameraState(), image: Array.from(new Uint8Array(await capture.image.arrayBuffer())) }
    } finally { viewer.dispose(); URL.revokeObjectURL(url); host.remove() }
  }, Array.from(glb()))
  expect(result.opened.quaternion.z).toBeCloseTo(Math.SQRT1_2, 12)
  expect(result.opened.quaternion.w).toBeCloseTo(Math.SQRT1_2, 12)
  expect(result.opened.frustum).toEqual({ left: -3, right: 5, top: 3, bottom: -3 })
  expect(result.resized.frustum).toEqual({ left: -5, right: 7, top: 3, bottom: -3 })
  expect(result.recording.frustum).toEqual({ left: -2, right: 4, top: 3, bottom: -3 })
  expect(result.restored).toEqual(result.resized)
  expect(result.afterCapture).toEqual(result.resized)
  mkdirSync(proofDir, { recursive: true })
  writeFileSync(`${proofDir}/quaternion-resized-capture.png`, Buffer.from(result.image))
})

test('orthographic image and recording preserve an off-center authored frustum', async ({ page }) => {
  const result = await page.evaluate(async (bytes) => {
    const modulePath = '/src/model3d-viewer.ts'
    const { mountModel3dViewer } = await import(modulePath)
    const host = document.createElement('div'); host.style.cssText = 'width:400px;height:300px'; document.body.append(host)
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]))
    const viewer = await mountModel3dViewer(host, url, 'model/gltf-binary')
    try {
      viewer.setCameraState({ ...viewer.cameraState(), position: { x: 0, y: 0, z: 4 }, target: { x: 0, y: 0, z: 0 },
        zoom: 1, cameraType: 'orthographic', frustum: { left: -3, right: 5, top: 4, bottom: -2 } })
      const pending = viewer.capture(320, 240)
      const capturing = viewer.cameraState().frustum
      const image = (await pending).image
      const bitmap = await createImageBitmap(image)
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close()
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      const rows: number[] = []
      for (let y = 0; y < canvas.height; y++) {
        if (Array.from({ length: canvas.width }, (_, x) => pixels[(y * canvas.width + x) * 4 + 3]!).some((alpha) => alpha > 0)) rows.push(y)
      }
      const session = viewer.recordingStream(300, 300)
      const recording = viewer.cameraState().frustum
      session.stop()
      return { capturing, recording, after: viewer.cameraState().frustum, height: rows.at(-1)! - rows[0]! + 1,
        image: Array.from(new Uint8Array(await image.arrayBuffer())) }
    } finally { viewer.dispose(); URL.revokeObjectURL(url); host.remove() }
  }, Array.from(glb()))
  expect(result.capturing).toEqual({ left: -3, right: 5, top: 4, bottom: -2 })
  expect(result.recording).toEqual({ left: -2, right: 4, top: 4, bottom: -2 })
  expect(result.after).toEqual({ left: -3, right: 5, top: 4, bottom: -2 })
  expect(result.height).toBe(80)
  mkdirSync(proofDir, { recursive: true })
  writeFileSync(`${proofDir}/orthographic-authored-capture.png`, Buffer.from(result.image))
})

test('recording locks projection until stopped in either camera mode', async ({ page }) => {
  const result = await page.evaluate(async (bytes) => {
    const modulePath = '/src/model3d-viewer.ts'
    const { mountModel3dViewer } = await import(modulePath)
    const host = document.createElement('div'); host.style.cssText = 'width:418px;height:271px'; document.body.append(host)
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]))
    const viewer = await mountModel3dViewer(host, url, 'model/gltf-binary')
    try {
      const states = []
      for (const cameraType of ['perspective', 'orthographic'] as const) {
        viewer.setCameraState({ ...viewer.cameraState(), cameraType, frustum: { left: -4, right: 6, top: 3, bottom: -2 } })
        const session = viewer.recordingStream(360, 200)
        const before = viewer.cameraState()
        viewer.setCameraState({ ...before, cameraType: cameraType === 'perspective' ? 'orthographic' : 'perspective' })
        states.push({ before, during: viewer.cameraState() })
        session.stop()
        viewer.setCameraState({ ...viewer.cameraState(), cameraType: cameraType === 'perspective' ? 'orthographic' : 'perspective' })
        states.push({ unlocked: viewer.cameraState().cameraType })
      }
      return states
    } finally { viewer.dispose(); URL.revokeObjectURL(url); host.remove() }
  }, Array.from(glb(0.75)))
  expect(result[0]!.during).toEqual(result[0]!.before)
  expect(result[1]!.unlocked).toBe('orthographic')
  expect(result[2]!.during).toEqual(result[2]!.before)
  expect(result[3]!.unlocked).toBe('perspective')
})

test('viewport recording preserves authored resolution across resize and releases its stream', async ({ page }) => {
  const result = await page.evaluate(async (bytes) => {
    const modulePath = '/src/model3d-viewer.ts'
    const { mountModel3dViewer } = await import(modulePath)
    const host = document.createElement('div'); host.style.cssText = 'width:400px;height:300px'; document.body.append(host)
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]))
    const viewer = await mountModel3dViewer(host, url, 'model/gltf-binary')
    let recordedUrl: string | undefined
    try {
      const session = viewer.recordingStream(258, 146)
      const recorder = new MediaRecorder(session.stream)
      const chunks: Blob[] = []
      const firstFrame = new Promise<void>((resolve) => {
        recorder.ondataavailable = (event) => { if (event.data.size) { chunks.push(event.data); if (event.data.size > 1) resolve() } }
      })
      const stopped = new Promise<void>((resolve) => { recorder.onstop = () => { session.stop(); resolve() } })
      recorder.start(50)
      host.style.width = '517px'; host.style.height = '211px'
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const canvas = host.querySelector('canvas')!
      const during = { width: canvas.width, height: canvas.height }
      await firstFrame
      recorder.stop()
      await stopped
      const tracks = session.stream.getTracks().map((track: MediaStreamTrack) => track.readyState)
      recordedUrl = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }))
      const video = document.createElement('video')
      const metadata = new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve()
        video.onerror = () => reject(new Error('recording did not decode'))
      })
      video.src = recordedUrl
      await metadata
      const dimensions = { width: video.videoWidth, height: video.videoHeight }
      const decoded = document.createElement('canvas'); decoded.width = video.videoWidth; decoded.height = video.videoHeight
      const context = decoded.getContext('2d')!; context.drawImage(video, 0, 0)
      let redPixels = 0
      const inspect = (): void => {
        context.drawImage(video, 0, 0)
        const rgba = context.getImageData(0, 0, decoded.width, decoded.height).data
        let count = 0
        for (let i = 0; i < rgba.length; i += 4) if (rgba[i]! > 50 && rgba[i]! > rgba[i + 1]! * 1.3) count++
        redPixels = Math.max(redPixels, count)
        if (!video.ended) video.requestVideoFrameCallback(inspect)
      }
      video.requestVideoFrameCallback(inspect)
      const ended = new Promise<void>((resolve) => { video.onended = () => resolve() })
      video.muted = true
      await video.play()
      await ended
      video.removeAttribute('src'); video.load()
      const restored = { width: canvas.width, height: canvas.height }
      const active = viewer.recordingStream(130, 82)
      viewer.dispose()
      return { during, dimensions, tracks, restored, redPixels, pixelRatio: devicePixelRatio,
        disposedTracks: active.stream.getTracks().map((track: MediaStreamTrack) => track.readyState) }
    } finally { viewer.dispose(); URL.revokeObjectURL(url); if (recordedUrl) URL.revokeObjectURL(recordedUrl); host.remove() }
  }, Array.from(glb()))
  expect(result.during).toEqual({ width: 258, height: 146 })
  expect(result.dimensions).toEqual({ width: 258, height: 146 })
  expect(result.redPixels).toBeGreaterThan(100)
  expect(result.restored).toEqual({ width: 517 * result.pixelRatio, height: 211 * result.pixelRatio })
  expect(result.tracks).toEqual(['ended'])
  expect(result.disposedTracks).toEqual(['ended'])
})
