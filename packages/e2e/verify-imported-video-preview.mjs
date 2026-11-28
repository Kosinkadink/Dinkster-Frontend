import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'

const frontend = process.env.DINKSTER_PREVIEW_FRONTEND
const retained = process.env.DINKSTER_PREVIEW_RESULT
const artifacts = process.env.DINKSTER_PREVIEW_ARTIFACTS
assert.ok(
  frontend && retained && artifacts,
  'Set DINKSTER_PREVIEW_FRONTEND, RESULT and ARTIFACTS',
)
const transfer = JSON.parse(await readFile(retained, 'utf8'))
assert.equal(transfer.completed, true)
assert.equal(transfer.refused, false)
assert.equal(transfer.surfaces.length, 1)
const surface = process.env.DINKSTER_PREVIEW_SURFACE ?? transfer.surfaces[0]
assert.ok(['field', 'canvas'].includes(surface))
const document = transfer.attempts.at(-1).browser.document
assert.equal(document.lineage, `video-transfer-${transfer.surfaces[0]}`)
const nodes = Object.values(document.graphs[document.root].nodes)
assert.equal(nodes.length, 1)
const [node] = nodes
assert.equal(node.type, 'dev.automatic.video_rate')
assert.equal(node.values.video.size, transfer.size)
assert.equal(node.values.video.mediaType, 'video/mp4')
await mkdir(artifacts, { recursive: true })
const result = {
  surface,
  source: transfer.source,
  sourceSha256: transfer.sha256,
  descriptor: node.values.video,
  uploads: [],
  assetRequests: [],
  pageErrors: [],
  states: [],
}
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
page.setDefaultTimeout(30_000)
page.on('pageerror', (error) => result.pageErrors.push(error.message))
page.on('request', (request) => {
  const url = new URL(request.url())
  if (request.method() === 'GET' && url.pathname.startsWith('/api/assets/'))
    result.assetRequests.push({ origin: url.origin, path: url.pathname })
  if (request.method() === 'POST' && /^\/api\/assets\//.test(url.pathname))
    result.uploads.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
    })
})

try {
  await page.goto(new URL('/?dinksterTheme=dark', frontend).href)
  await page.waitForFunction(() =>
    window.__dinksterTest?.app?.backends
      .get()[0]
      ?.registry.get()
      ?.schemas.has('dev.automatic.video_rate'),
  )
  await page.evaluate(async (doc) => {
    await window.__dinksterTest.app.openDocument(doc, 'Imported video preview')
  }, document)
  await page.waitForFunction((lineage) => {
    const tab = window.__dinksterTest.app.activeTab()
    return tab?.store.doc.lineage === lineage && 'status' in tab.store
  }, document.lineage)
  // Closing the dock and fitting the view leave the imported graph and asset unchanged.
  await page.evaluate(() => {
    window.__dinksterTest.app.dock.setOpen('right', false)
    window.__dinksterTest.renderer.fitToScene()
  })
  const canvas = page.getByTestId('graph-canvas')
  await expect(canvas).toBeVisible()
  if (surface === 'field') {
    const point = await page.waitForFunction((id) => {
      const renderer = window.__dinksterTest.renderer
      const node = renderer.getScene().nodes.find((entry) => entry.id === id)
      const row = node?.layout.rows.find(
        (entry) => entry.kind === 'widget' && entry.inputId === 'video',
      )
      if (!row) return undefined
      const view = renderer.getViewport()
      const rect = document
        .querySelector('[data-testid=graph-canvas]')
        .getBoundingClientRect()
      return {
        x: rect.left + (node.x + node.layout.width / 2) * view.scale + view.x,
        y: rect.top + (node.y + row.y + row.height / 2) * view.scale + view.y,
      }
    }, node.id)
    const position = await point.jsonValue()
    await page.mouse.click(position.x, position.y)
    await page
      .locator('[data-editor-surface="asset-quick-list"]')
      .getByRole('button', { name: 'Browse folders', exact: true })
      .click()
    await expect(page.getByTestId('asset-editor')).toBeVisible()
  }
  const controls =
    surface === 'field'
      ? page
          .getByTestId('asset-video-preview')
          .getByRole('group', { name: 'Video preview controls', exact: true })
      : page
          .locator('.node-media-overlay[data-media-kind="video"]')
          .getByRole('group', { name: 'Video preview controls', exact: true })
  await expect(controls).toHaveCount(1)
  const video = controls.locator('video')
  for (const [width, height] of [
    [1440, 950],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height })
    if (surface === 'canvas')
      await page.evaluate(() => window.__dinksterTest.renderer.fitToScene())
    await expect(controls).toBeVisible()
    await expect
      .poll(() => video.evaluate((element) => element.readyState))
      .toBeGreaterThanOrEqual(2)
    const before = await video.evaluate((element) => ({
      time: element.currentTime,
      width: element.videoWidth,
      height: element.videoHeight,
      duration: element.duration,
      source: element.currentSrc,
      error: element.error?.message ?? null,
    }))
    assert.equal(before.width, 640)
    assert.equal(before.height, 360)
    assert.ok(Number.isFinite(before.duration) && before.duration > 0)
    assert.equal(before.error, null)
    assert.ok(
      new URL(before.source).protocol === 'blob:' ||
        new URL(before.source).origin === new URL(frontend).origin,
    )
    const play = controls.getByRole('button', {
      name: 'Play video',
      exact: true,
    })
    await expect(play).toBeVisible()
    await expect(play).toBeEnabled()
    await play.click()
    await expect
      .poll(() => video.evaluate((element) => element.currentTime))
      .toBeGreaterThan(before.time + 0.1)
    await controls
      .getByRole('button', { name: 'Pause video', exact: true })
      .click()
    await expect(video).toHaveJSProperty('paused', true)
    const after = await video.evaluate((element) => ({
      time: element.currentTime,
      width: element.videoWidth,
      height: element.videoHeight,
      decodedFrames: element.getVideoPlaybackQuality().totalVideoFrames,
      error: element.error?.message ?? null,
    }))
    assert.ok(after.decodedFrames > 0)
    assert.equal(after.error, null)
    const bounds = await controls.boundingBox()
    assert.ok(
      bounds &&
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= width &&
        bounds.y + bounds.height <= height,
      'Preview controls must fit in the viewport',
    )
    assert.deepEqual(
      await page.evaluate(
        () => window.__dinksterTest.app.activeTab().store.doc.graphs,
      ),
      document.graphs,
    )
    assert.deepEqual(result.uploads, [], 'Preview must not repeat asset upload')
    result.states.push({
      width,
      height,
      before,
      after,
      bounds,
      readout: await controls.getByTestId('video-timing').innerText(),
    })
    await page.screenshot({
      path: join(artifacts, `${surface}-preview-${width}.png`),
    })
  }
  assert.deepEqual(result.pageErrors, [])
  result.completed = true
} catch (error) {
  result.failure = String(error)
  try {
    await page.screenshot({
      path: join(artifacts, `${surface}-preview-failed.png`),
      timeout: 5000,
    })
  } catch {}
  throw error
} finally {
  await writeFile(
    join(artifacts, 'preview-result.json'),
    JSON.stringify(result, null, 2),
  )
  await browser.close()
}
