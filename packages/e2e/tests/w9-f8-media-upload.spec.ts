import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, type Page } from './fixtures.js'

const PROOF = '/tmp/asset-widget-presentation-proof'
const digest = `blake3:${'a'.repeat(64)}`
const videoDigest = `blake3:${'d'.repeat(64)}`
const videoBytes = readFileSync(resolve(import.meta.dirname, '../fixtures/media-overlay/visible-2s.webm'))
const canonicalA = {
  digest,
  name: 'canonical-a.png',
  size: 999,
  mediaType: 'image/png',
  virtualPath: '',
}
const canonicalB = {
  ...canonicalA,
  digest: `blake3:${'b'.repeat(64)}`,
  name: 'canonical-b.png',
}
const canonicalC = {
  ...canonicalA,
  digest: `blake3:${'c'.repeat(64)}`,
  name: 'canonical-c.png',
}
const canonicalVideo = {
  digest: videoDigest,
  name: 'canonical-video.webm',
  size: videoBytes.byteLength,
  mediaType: 'video/webm',
  virtualPath: '',
}

async function openAsset(page: Page, nodeId = 'source', inputId = 'files'): Promise<void> {
  const point = await page.evaluate(({ nodeId, inputId }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + node.x + node.layout.width / 2, y: canvas.top + node.y + row.y + row.height / 2 }
  }, { nodeId, inputId })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('asset-editor')).toBeVisible()
}

test('source media upload adopts canonical refs and preserves list and cancel semantics', async ({ page }, testInfo) => {
  await mkdir(PROOF, { recursive: true })
  await page.setViewportSize({ width: 1600, height: 950 })
  const uploads: { url: string; bytes: Buffer; contentType: string | undefined }[] = []
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'none' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    dinkster: { version: 'wire22-proof', schemaWire: 22 },
    nodes: { SourceUpload: {
      schemaVersion: 22,
      nodeType: 'SourceUpload',
      displayName: 'Source Upload',
      interface: [{
        role: 'input',
        id: 'files',
        required: true,
        type: { kind: 'list', element: { kind: 'concrete', types: ['dinkster.asset'] } },
        widget: { type: 'ASSET', accept: ['image/*'], kind: 'media/image', allowUpload: true },
        sourceFilename: { kind: 'media/image', category: 'input' },
      }],
    }, SourceScalar: {
      schemaVersion: 22,
      nodeType: 'SourceScalar',
      displayName: 'Source Scalar',
      interface: [{
        role: 'input', id: 'file', required: true,
        type: { kind: 'concrete', types: ['dinkster.asset'] },
        widget: { type: 'ASSET', accept: ['image/*'], kind: 'media/image', allowUpload: true },
        sourceFilename: { kind: 'media/image', category: 'input' },
      }],
    }, SourceVideo: {
      schemaVersion: 22,
      nodeType: 'SourceVideo',
      displayName: 'Source Video',
      interface: [{
        role: 'input', id: 'video', required: true,
        type: { kind: 'concrete', types: ['dinkster.asset'] },
        widget: { type: 'ASSET', accept: ['video/*'], kind: 'media/video', allowUpload: true },
        sourceFilename: { kind: 'media/video', category: 'input' },
      }],
    } },
  } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('/api/mounts*', (route) => route.fulfill({ json: { mounts: [] } }))
  await page.route('/api/assets/media*', async (route) => {
    uploads.push({
      url: route.request().url(),
      bytes: route.request().postDataBuffer() ?? Buffer.alloc(0),
      contentType: route.request().headers()['content-type'],
    })
    const name = new URL(route.request().url()).searchParams.get('name')
    if (name === 'slow.png') await new Promise((resolve) => setTimeout(resolve, 1_000))
    const kind = new URL(route.request().url()).searchParams.get('kind')
    await route.fulfill({ status: 201, json: kind === 'media/video'
      ? { asset: canonicalVideo, kind }
      : {
          asset: name === 'b.png' ? canonicalB : name === 'c.png' ? canonicalC : canonicalA,
          kind: 'media/image',
        } })
  })
  await page.route('/api/assets/*', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/assets/media') {
      await route.fallback()
      return
    }
    if (route.request().method() === 'GET' && path.includes(encodeURIComponent(videoDigest))) {
      await route.fulfill({ status: 200, contentType: 'video/webm', body: videoBytes })
      return
    }
    if (route.request().method() === 'GET' && path.includes(encodeURIComponent(canonicalC.digest))) {
      await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from([0, 1, 2, 3]) })
      return
    }
    await route.fulfill({ status: 404 })
  })

  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(3)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'wire22-source', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        source: { id: 'source', type: 'SourceUpload', values: { files: [] } },
        scalar: { id: 'scalar', type: 'SourceScalar', values: {} },
        video: { id: 'video', type: 'SourceVideo', values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 3 } },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 120, y: 100 } },
        scalar: { position: { x: 500, y: 100 } },
        video: { position: { x: 800, y: 100 } },
      } } } },
    }, 'Source Upload')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await openAsset(page)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)

  const trigger = page.getByTestId('asset-upload-trigger')
  await page.getByTestId('asset-editor').getByRole('button', { name: 'cancel' }).focus()
  for (let press = 0; press < 30 && !(await trigger.evaluate((element) => element === document.activeElement)); press++) {
    await page.keyboard.press('Tab')
  }
  await expect(trigger).toBeFocused()
  await expect(trigger).toHaveCSS('outline-style', 'solid')
  const bytesA = Buffer.from([137, 80, 78, 71])
  const bytesB = Buffer.from([137, 80, 78, 72])
  await page.getByTestId('asset-editor').locator('input[type=file]').setInputFiles([
    { name: '../unsafe/a.png', mimeType: 'image/png', buffer: bytesA },
    { name: '../unsafe/b.png', mimeType: 'image/png', buffer: bytesB },
    { name: '../unsafe/a.png', mimeType: 'image/png', buffer: bytesA },
  ])
  await expect.poll(() => uploads.length).toBe(3)
  expect(uploads.map((item) => [...item.bytes])).toEqual([
    [137, 80, 78, 71], [137, 80, 78, 72], [137, 80, 78, 71],
  ])
  expect(uploads.map((item) => item.contentType)).toEqual(['image/png', 'image/png', 'image/png'])
  for (const [index, upload] of uploads.entries()) {
    const url = new URL(upload.url)
    expect(url.pathname).toBe('/api/assets/media')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      scope: 'local', kind: 'media/image', name: index === 1 ? 'b.png' : 'a.png',
    })
  }
  await expect(page.getByTestId('asset-chip')).toHaveCount(3)
  await page.getByTestId('asset-chip').nth(1).getByRole('button').click()
  await expect(page.getByTestId('asset-chip')).toHaveCount(2)
  await page.screenshot({ path: `${PROOF}/multi-selection-1600x950.png`, fullPage: true })
  await page.getByTestId('asset-apply').click()
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.source!.values.files)).toEqual([canonicalA, canonicalA])

  const committedRevision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await openAsset(page)
  await page.getByTestId('asset-editor').getByTestId('asset-selection-remove').click()
  await page.getByTestId('asset-editor').getByRole('button', { name: 'cancel' }).click()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(committedRevision)
  expect(await page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.source!.values.files)).toEqual([canonicalA, canonicalA])

  await openAsset(page, 'scalar', 'file')
  await page.getByTestId('asset-editor').locator('input[type=file]').setInputFiles({
    name: 'c.png', mimeType: 'image/png', buffer: bytesA,
  })
  // The finished upload stages the canonical ref; Apply commits it.
  await expect(page.getByTestId('asset-selection-summary')).toContainText('c.png')
  await page.getByTestId('asset-apply').click()
  await expect(page.getByTestId('asset-editor')).toBeHidden()
  expect(await page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.scalar!.values.file)).toEqual(canonicalC)

  const scalarRevision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await openAsset(page, 'scalar', 'file')
  await page.getByTestId('asset-editor').locator('input[type=file]').setInputFiles({
    name: 'slow.png', mimeType: 'image/png', buffer: bytesA,
  })
  await expect.poll(() => uploads.some((upload) => new URL(upload.url).searchParams.get('name') === 'slow.png')).toBe(true)
  const uploadingEditor = page.getByTestId('asset-editor')
  await expect(uploadingEditor.getByText('Uploading files...', { exact: true })).toBeVisible()
  await expect(uploadingEditor.getByTestId('asset-upload-trigger')).toBeDisabled()
  await expect(uploadingEditor.getByTestId('asset-selection-remove')).toBeDisabled()
  await expect(uploadingEditor.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  await page.screenshot({ path: `${PROOF}/uploading-1600x950.png`, fullPage: true })
  await page.getByTestId('asset-editor').getByRole('button', { name: 'cancel' }).click()
  await expect(page.getByTestId('asset-editor')).toBeHidden()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(scalarRevision)
  expect(await page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.scalar!.values.file)).toEqual(canonicalC)

  await openAsset(page, 'video', 'video')
  const uploadCount = uploads.length
  const videoInput = page.getByTestId('asset-editor').locator('input[type=file]')
  await videoInput.setInputFiles({ name: 'wrong.png', mimeType: 'image/png', buffer: bytesA })
  await expect(page.getByTestId('asset-editor').locator('.asset-error')).toContainText('Unsupported file type: image/png')
  expect(uploads).toHaveLength(uploadCount)
  await page.screenshot({ path: `${PROOF}/validation-error-1600x950.png`, fullPage: true })

  await videoInput.setInputFiles(resolve(import.meta.dirname, '../fixtures/media-overlay/visible-2s.webm'))
  // The finished upload stages the canonical ref returned by the backend, not the local file name.
  await expect(page.getByTestId('asset-selection-summary')).toContainText('canonical-video.webm')
  await page.getByTestId('asset-apply').click()
  await expect(page.getByTestId('asset-editor')).toBeHidden()
  expect(uploads).toHaveLength(uploadCount + 1)
  const videoUpload = uploads.at(-1)!
  expect(videoUpload.bytes.equals(videoBytes)).toBe(true)
  expect(videoUpload.contentType).toBe('video/webm')
  expect(Object.fromEntries(new URL(videoUpload.url).searchParams)).toEqual({
    scope: 'local', kind: 'media/video', name: 'visible-2s.webm',
  })
  expect(await page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.video!.values.video)).toEqual(canonicalVideo)

  await openAsset(page, 'video', 'video')
  const video = page.getByTestId('asset-video-preview')
  await expect(video).toBeVisible()
  await expect(video).toHaveAttribute('preload', 'metadata')
  expect(await video.evaluate((element: HTMLVideoElement) => element.controls)).toBe(true)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration)).toBeGreaterThan(0)
  const controlsProof = testInfo.outputPath('selected-video-controls.png')
  await page.getByTestId('asset-editor').screenshot({ path: controlsProof, animations: 'disabled' })
  await testInfo.attach('selected video controls', { path: controlsProof, contentType: 'image/png' })
  await video.dispatchEvent('error')
  const fallback = page.getByTestId('asset-video-fallback')
  await expect(fallback).toContainText('Video preview unavailable.')
  await expect(fallback.getByRole('link', { name: 'Download video' })).toHaveAttribute(
    'href', `/api/assets/${encodeURIComponent(videoDigest)}`,
  )
  await page.screenshot({ path: `${PROOF}/video-fallback-1600x950.png`, fullPage: true })

  await page.getByTestId('asset-editor').getByRole('button', { name: 'cancel' }).click()
  await openAsset(page, 'scalar', 'file')
  const imageFallback = page.getByTestId('asset-image-fallback')
  await expect(imageFallback).toContainText('Image preview unavailable.')
  const imageDownload = imageFallback.getByRole('link', { name: 'Download image' })
  await expect(imageDownload).toHaveAttribute('href', /^blob:/)
  await expect(imageDownload).toHaveAttribute('download', canonicalC.name)
  await page.screenshot({ path: `${PROOF}/image-fallback-1600x950.png`, fullPage: true })
})
