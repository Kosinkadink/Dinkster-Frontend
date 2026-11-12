import { expect, test, type Page } from '@playwright/test'
import { waitForStartupOwnership } from './fixtures.js'

const backend = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
const nativeFrontend = process.env['DINKSTER_E2E_NATIVE_FRONTEND']
if (!nativeFrontend) throw new Error('Native frontend is required')
test.use({ baseURL: nativeFrontend })

async function openInput(page: Page, nodeId: string, inputId: string): Promise<void> {
  await expect.poll(() => page.evaluate(({ nodeId, inputId }) =>
    window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === nodeId)?.layout.rows
      .some((row) => row.kind === 'widget' && row.inputId === inputId), { nodeId, inputId })).toBe(true)
  await page.getByTestId('graph-canvas').focus()
  const point = await page.evaluate(({ nodeId, inputId }) => {
    const renderer = window.__dinksterTest!.renderer!
    renderer.setViewport({ x: 0, y: 0, scale: 1 })
    const node = renderer.getScene().nodes.find((node) => node.id === nodeId)!
    const row = node.layout.rows.find((row) => row.kind === 'widget' && row.inputId === inputId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  }, { nodeId, inputId })
  await page.mouse.click(point.x, point.y)
}

async function openGraph(page: Page, type: string, values: Record<string, unknown>): Promise<void> {
  await page.evaluate(async ({ type, values }) => {
    const app = window.__dinksterTest!.app
    await app.openDocument({ format: 'dinkster-workflow', formatVersion: 1,
      lineage: `served-widget-${type}`, root: 'g0', graphs: { g0: {
        id: 'g0', name: 'Saved widget workflow',
        nodes: { target: { id: 'target', type, values } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      } }, view: { graphs: { g0: { nodes: { target: {
        position: { x: 80, y: 80 }, size: { width: 340, height: 400 },
      } } } } },
    } as never, 'Saved widget workflow')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, { type, values })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.lineage)).toBe(`served-widget-${type}`)
  await waitForStartupOwnership(page)
}

async function run(page: Page): Promise<{ clientId: string; jobId: string }> {
  await waitForStartupOwnership(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const result = app.compileTab(app.activeTab()!)
    if (!result?.ok) throw new Error(`Cannot execute widget workflow: ${JSON.stringify(result?.diagnostics)}`)
  })
  const submitted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs')
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queueSelection(app.activeTab()!, ['target'])
  })
  const request = await submitted
  const { clientId, jobId } = request.postDataJSON() as { clientId: string; jobId: string }
  const row = page.getByTestId('execution-row').filter({ has: page.locator('.execution-id', { hasText: jobId }) })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
  return { clientId, jobId }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.backends.get()[0]!.connection.status.get())).toBe('connected')
  await waitForStartupOwnership(page)
})

test('Record Audio records a fake microphone and executes its saved asset after reopening', async ({ page, request }, info) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      const audio = new AudioContext()
      const tone = audio.createOscillator()
      const output = audio.createMediaStreamDestination()
      tone.frequency.value = 523.25
      tone.connect(output); tone.start(); await audio.resume()
      const track = output.stream.getAudioTracks()[0]!
      const stop = track.stop.bind(track)
      track.stop = () => { tone.stop(); void audio.close(); stop() }
      return output.stream
    } })
  })
  await openGraph(page, 'dinkster.audio.record_audio', {})
  await openInput(page, 'target', 'audio')
  const editor = page.getByTestId('audio-record-editor')
  await expect(editor).toBeVisible()
  await editor.getByRole('button', { name: 'Record microphone', exact: true }).click()
  await expect(editor.getByTestId('audio-recorded-bytes')).toHaveText(/Recorded [1-9][0-9]* bytes/)
  await editor.getByRole('button', { name: 'Stop recording', exact: true }).click()
  await expect(editor.getByRole('button', { name: 'Save recording', exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('record-audio.png') })
  const uploaded = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/assets/media')
  await editor.getByRole('button', { name: 'Save recording', exact: true }).click()
  const response = await uploaded
  expect(response.ok()).toBe(true)
  const { asset } = await response.json()
  await expect(editor).toContainText('Recording saved')
  await editor.getByRole('button', { name: 'Use asset', exact: true }).click()
  await expect(editor).toBeHidden()
  const saved = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)
  expect(saved.graphs.g0!.nodes.target!.values.audio).toEqual(asset)
  for (const reopen of [false, true]) {
    if (reopen) await page.evaluate(async (saved) => { await window.__dinksterTest!.app.openDocument(saved, 'Reopened recording') }, saved)
    const job = await run(page)
    const query = new URLSearchParams({ ...job, nodeId: 'target', outputId: 'AUDIO' })
    const descriptor = await request.get(`${backend}/api/values?${query}`)
    expect(descriptor.ok()).toBe(true)
    const value = await descriptor.json()
    expect(value.descriptor.typeId).toBe('AUDIO')
    expect(value.descriptor.meta.duration).toBeGreaterThan(0)
    const duration = Math.min(0.1, value.descriptor.meta.duration / 2)
    const pcm = await request.get(`${backend}/api/values?${query}&rendition=window&batch=0&window=0,${duration}`)
    expect(pcm.ok(), await pcm.text()).toBe(true)
    const bytes = await pcm.body()
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF')
    expect(bytes.subarray(44).some((byte) => byte !== 0)).toBe(true)
  }
})

function modelFile(cloud: boolean): { name: string; mimeType: string; buffer: Buffer } {
  if (cloud) {
    const fields = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
    const header = Buffer.from(['ply', 'format binary_little_endian 1.0', 'element vertex 4',
      ...fields.map((name) => `property float ${name}`), 'end_header', ''].join('\n'))
    const body = Buffer.alloc(4 * fields.length * 4)
    const points = [[-1, -1, 0, 1, -1, -1], [1, -1, 0, -1, 1, -1],
      [0, 1, 0, -1, -1, 1], [0, 0, 1, 1, 1, -1]]
    points.flatMap((point) => [...point, 4, -1, -1, -1, 1, 0, 0, 0])
      .forEach((value, index) => body.writeFloatLE(value, index * 4))
    return { name: 'colored-cloud.ply', mimeType: 'model/ply', buffer: Buffer.concat([header, body]) }
  }
  const vertices = Buffer.alloc(36)
  ;[-1, -1, 0, 1, -1, 0, 0, 1, 0].forEach((value, index) => vertices.writeFloatLE(value, index * 4))
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.9, 0.2, 0.1, 1] }, doubleSided: true }],
    buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] }],
  }))
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)])
  const out = Buffer.alloc(28 + padded.length + vertices.length)
  out.write('glTF'); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8)
  out.writeUInt32LE(padded.length, 12); out.writeUInt32LE(0x4e4f534a, 16); padded.copy(out, 20)
  out.writeUInt32LE(vertices.length, 20 + padded.length); out.writeUInt32LE(0x004e4942, 24 + padded.length); vertices.copy(out, 28 + padded.length)
  return { name: 'red-triangle.glb', mimeType: 'model/gltf-binary', buffer: out }
}

for (const type of ['load3_d', 'load3_d_advanced', 'preview3_d_advanced', 'preview_gaussian_splat',
  'preview_point_cloud', 'save3_d_advanced', 'save_gaussian_splat', 'save_point_cloud']) {
  test(`LOAD_3D opens, applies and executes saved values for ${type}`, async ({ page, request }, info) => {
    const file = modelFile(type.includes('splat') || type.includes('cloud'))
    const loader = type.startsWith('load')
    await openGraph(page, loader ? `dinkster.3d.${type}` : 'dinkster.3d.load3_d_advanced', { viewport_state: {}, width: 256, height: 192 })
    await openInput(page, 'target', 'model_file')
    const picker = page.getByTestId('asset-editor')
    await expect(picker).toBeVisible()
    const uploaded = page.waitForResponse((response) => response.request().method() === 'POST' && ['/api/assets', '/api/assets/media'].includes(new URL(response.url()).pathname))
    await picker.locator('input[type=file]').setInputFiles(file)
    const response = await uploaded
    expect(response.ok()).toBe(true)
    const { asset } = await response.json()
    await picker.getByTestId('asset-apply').click()
    await expect(picker).toBeHidden()
    if (!loader) await openGraph(page, `dinkster.3d.${type}`, {
      model_3d: { $typed: { type: file.name.endsWith('.ply') ? 'FILE_3D_PLY' : 'FILE_3D_GLB',
        value: { format: file.name.endsWith('.ply') ? 'ply' : 'glb', source: asset, resources: {} } } },
      viewport_state: {}, width: 256, height: 192,
      ...(type.startsWith('save') ? { filename_prefix: `widget-editors/${type}` } : {}),
    })
    const inputId = type === 'load3_d' ? 'image' : 'viewport_state'
    await openInput(page, 'target', inputId)
    const editor = page.getByTestId('load3d-widget-editor')
    await expect(editor).toBeVisible()
    await expect(editor.locator('#load3d-fov')).toBeVisible()
    await editor.locator('#load3d-fov').fill('53')
    await editor.locator('#load3d-fov').dispatchEvent('change')
    await editor.locator('#load3d-position-x').fill('0.25')
    await editor.locator('#load3d-position-x').dispatchEvent('change')
    if (type.includes('splat')) {
      await expect.poll(async () => {
        const png = await editor.getByTestId('load3d-viewport').screenshot()
        return page.evaluate(async (base64) => {
          const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
          const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
          const canvas = document.createElement('canvas')
          canvas.width = image.width
          canvas.height = image.height
          const context = canvas.getContext('2d')!
          context.drawImage(image, 0, 0)
          image.close()
          const data = context.getImageData(0, 0, canvas.width, canvas.height).data
          let colored = 0
          for (let i = 0; i < data.length; i += 4) {
            if (Math.max(data[i]!, data[i + 1]!, data[i + 2]!) - Math.min(data[i]!, data[i + 1]!, data[i + 2]!) > 30) colored++
          }
          return colored
        }, png.toString('base64'))
      }).toBeGreaterThan(100)
    }
    await page.screenshot({ path: info.outputPath(`${type}.png`) })
    await editor.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(editor).toBeHidden()
    const saved = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)
    expect(saved.graphs.g0!.nodes.target!.values[inputId]).toMatchObject({ camera_info: { fov: 53 }, model_3d_info: [{ position: { x: 0.25 } }] })
    for (const reopen of [false, true]) {
      if (reopen) await page.evaluate(async (saved) => { await window.__dinksterTest!.app.openDocument(saved, 'Reopened viewport') }, saved)
      const job = await run(page)
      const query = new URLSearchParams({ ...job, nodeId: 'target' })
      const camera = await request.get(`${backend}/api/values?${query}&outputId=camera_info&rendition=json`)
      expect(camera.ok()).toBe(true)
      expect(await camera.json()).toMatchObject({ fov: 53 })
      const model = await request.get(`${backend}/api/values?${query}&outputId=model_3d&rendition=manifest`)
      expect(model.ok()).toBe(true)
      const manifest = await model.json()
      expect(manifest.source.digest).toBe(asset.digest)
      const bytes = await request.get(`${backend}/api/assets/${encodeURIComponent(manifest.source.digest)}?scope=local`)
      expect(bytes.ok()).toBe(true)
      expect(await bytes.body()).toEqual(file.buffer)
    }
  })
}
