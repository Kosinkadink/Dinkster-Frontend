import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { chromium, expect } from '@playwright/test'

const frontend = process.env.DINKSTER_TRANSFER_FRONTEND
const backend = process.env.DINKSTER_TRANSFER_BACKEND
const source = process.env.DINKSTER_TRANSFER_SOURCE
const artifacts = process.env.DINKSTER_TRANSFER_ARTIFACTS
const mount = process.env.DINKSTER_TRANSFER_MOUNT
const expectedPolicy = process.env.DINKSTER_TRANSFER_POLICY
const surfaceFilter = process.env.DINKSTER_TRANSFER_SURFACE
assert.ok(
  surfaceFilter === undefined || ['field', 'canvas'].includes(surfaceFilter),
  'DINKSTER_TRANSFER_SURFACE must be field or canvas when set',
)
const surfaces = surfaceFilter ? [surfaceFilter] : ['field', 'canvas']
if (
  !frontend ||
  !backend ||
  !source ||
  !artifacts ||
  !mount ||
  !['uncapped', 'limited'].includes(expectedPolicy)
)
  throw new Error(
    'Set DINKSTER_TRANSFER_FRONTEND, BACKEND, SOURCE, ARTIFACTS, MOUNT and POLICY (uncapped or limited) for isolated resources',
  )
const file = resolve(source)
const size = (await stat(file)).size
assert.ok(size > 0)
const policyResponse = await fetch(
  new URL('/api/assets/upload-limits', backend),
  { signal: AbortSignal.timeout(30_000) },
)
assert.equal(policyResponse.status, 200)
const policy = await policyResponse.json()
if (expectedPolicy === 'uncapped') assert.equal(policy, null)
else
  assert.ok(
    Number.isSafeInteger(policy?.['media/video']) && policy['media/video'] > 0,
  )
const refused = policy !== null && size > policy['media/video']
const expectedHash = createHash('sha256')
for await (const chunk of createReadStream(file)) expectedHash.update(chunk)
const sha256 = expectedHash.digest('hex')
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({
  viewport: { width: 1440, height: 950 },
})
page.setDefaultTimeout(30_000)
const evidence = {
  source: basename(file),
  size,
  sha256,
  surfaces,
  policy,
  refused,
  pageErrors: [],
  results: [],
  attempts: [],
}
page.on('pageerror', (error) => evidence.pageErrors.push(error.message))
await page.addInitScript(() => {
  window.__transferReads = {
    largeArrayBuffer: 0,
    largeFileReader: 0,
    largeText: 0,
  }
  window.__transferResponses = []
  const fetchResponse = window.fetch
  window.fetch = async function (input, init) {
    const response = await fetchResponse.call(this, input, init)
    const request = input instanceof Request ? input : undefined
    const url = new URL(request?.url ?? String(input), window.location.href)
    if (
      (init?.method ?? request?.method ?? 'GET').toUpperCase() === 'POST' &&
      url.pathname === '/api/assets/media'
    ) {
      try {
        window.__transferResponses.push({
          status: response.status,
          payload: await response.clone().json(),
        })
      } catch (error) {
        window.__transferResponses.push({
          status: response.status,
          error: String(error),
        })
      }
    }
    return response
  }
  const openRequest = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    if (
      method.toUpperCase() === 'POST' &&
      new URL(String(url), window.location.href).pathname ===
        '/api/assets/media'
    ) {
      this.addEventListener(
        'load',
        () => {
          try {
            window.__transferResponses.push({
              status: this.status,
              payload: JSON.parse(this.responseText),
            })
          } catch (error) {
            window.__transferResponses.push({
              status: this.status,
              error: String(error),
            })
          }
        },
        { once: true },
      )
    }
    return openRequest.call(this, method, url, ...args)
  }
  for (const [method, counter] of [
    ['arrayBuffer', 'largeArrayBuffer'],
    ['text', 'largeText'],
  ]) {
    const original = Blob.prototype[method]
    Blob.prototype[method] = function (...args) {
      if (this.size > 64 * 1024) {
        window.__transferReads[counter] += 1
        throw new Error('Large whole-Blob read is forbidden during transfer')
      }
      return original.apply(this, args)
    }
  }
  for (const method of [
    'readAsArrayBuffer',
    'readAsText',
    'readAsDataURL',
    'readAsBinaryString',
  ]) {
    const original = FileReader.prototype[method]
    FileReader.prototype[method] = function (blob, ...args) {
      if (blob.size > 64 * 1024) {
        window.__transferReads.largeFileReader += 1
        throw new Error(
          'Large whole-file FileReader read is forbidden during transfer',
        )
      }
      return original.call(this, blob, ...args)
    }
  }
})

try {
  await page.goto(new URL('/?dinksterTheme=dark', frontend).href)
  await page.waitForFunction(() =>
    window.__dinksterTest?.app?.backends
      .get()[0]
      ?.registry.get()
      ?.schemas.has('dev.automatic.video_rate'),
  )
  const reported = await page.evaluate(
    () =>
      window.__dinksterTest.app.backends.get()[0].registry.get().uploadLimits,
  )
  assert.deepEqual(
    reported,
    policy,
    'Live frontend catalog must report the same policy as the engine route',
  )
  const session = await browser.newBrowserCDPSession()
  const pids = (
    await session.send('SystemInfo.getProcessInfo')
  ).processInfo.map((entry) => entry.id)
  const rss = () =>
    pids.reduce((total, pid) => {
      try {
        return (
          total +
          Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) *
            4096
        )
      } catch {
        return total
      }
    }, 0)

  for (const surface of surfaces) {
    await page.evaluate(
      async ({ surface, mount }) => {
        const app = window.__dinksterTest.app
        await app.openDocument(
          {
            format: 'dinkster-workflow',
            formatVersion: 1,
            lineage: `video-transfer-${surface}`,
            root: 'g0',
            graphs: {
              g0: {
                id: 'g0',
                name: 'root',
                nodes:
                  surface === 'field'
                    ? {
                        source: {
                          id: 'source',
                          type: 'dev.automatic.video_rate',
                          values: { video: null },
                        },
                      }
                    : {},
                links: {},
                nets: {},
                reroutes: {},
                nextOrdinal: surface === 'field' ? 1 : 0,
              },
            },
            view: {
              graphs: {
                g0: {
                  nodes:
                    surface === 'field'
                      ? { source: { position: { x: 100, y: 100 } } }
                      : {},
                },
              },
            },
          },
          `Video transfer ${surface}`,
        )
        window.__dinksterTest.renderer.setViewport({
          x: 0,
          y: 0,
          scale: 1,
        })
        localStorage.setItem(
          'dinkster.uploadDestination.local.default',
          JSON.stringify({ version: 1, mount, folder: '' }),
        )
      },
      { surface, mount },
    )
    await page.waitForFunction(
      (surface) =>
        window.__dinksterTest.app.activeTab()?.store.doc.lineage ===
        `video-transfer-${surface}`,
      surface,
    )
    const before = await page.evaluate(() =>
      JSON.stringify(window.__dinksterTest.app.activeTab().store.doc),
    )
    if (surface === 'field') {
      const point = await page.waitForFunction(() => {
        const renderer = window.__dinksterTest.renderer
        const node = renderer
          .getScene()
          .nodes.find((node) => node.id === 'source')
        const row = node?.layout.rows.find(
          (row) => row.kind === 'widget' && row.inputId === 'video',
        )
        if (!row) return undefined
        const viewport = renderer.getViewport()
        const rect = document
          .querySelector('[data-testid=graph-canvas]')
          .getBoundingClientRect()
        return {
          x:
            rect.left +
            (node.x + node.layout.width / 2) * viewport.scale +
            viewport.x,
          y:
            rect.top +
            (node.y + row.y + row.height / 2) * viewport.scale +
            viewport.y,
        }
      })
      const position = await point.jsonValue()
      await page.mouse.click(position.x, position.y)
      const quickList = page.locator(
        '[data-editor-surface="asset-quick-list"] .asset-quick-list',
      )
      await expect(quickList).toBeVisible()
      if (policy === null) await expect(quickList).toContainText('Any size')
      else await expect(quickList).toContainText('Up to')
      await page.screenshot({
        path: join(artifacts, `${surface}-${expectedPolicy}-before.png`),
      })
    }
    await page.evaluate(() => {
      window.__transferResponses = []
    })
    const baseline = rss()
    const samples = [baseline]
    const sampler = setInterval(() => samples.push(rss()), 25)
    let response
    const uploads = []
    const attempt = { surface, requests: [], responses: [], failures: [] }
    evidence.attempts.push(attempt)
    const isUpload = (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/assets/media'
    const track = (request) => {
      if (isUpload(request)) {
        uploads.push(request)
        const url = new URL(request.url())
        attempt.requests.push({
          timestamp: Date.now(),
          origin: url.origin,
          pathname: url.pathname,
          query: Object.fromEntries(
            ['scope', 'kind', 'name', 'mount', 'folder', 'project']
              .filter((key) => url.searchParams.has(key))
              .map((key) => [key, url.searchParams.get(key)]),
          ),
        })
      }
    }
    const trackResponse = (received) => {
      if (isUpload(received.request()))
        attempt.responses.push({
          timestamp: Date.now(),
          status: received.status(),
        })
    }
    const trackFailure = (request) => {
      if (isUpload(request))
        attempt.failures.push({
          timestamp: Date.now(),
          failure: request.failure(),
        })
    }
    const mediaResponse = refused
      ? undefined
      : page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/assets/media',
          { timeout: 180_000 },
        )
    // Retain rejection for the awaited result without an unhandled rejection if the UI fails first.
    mediaResponse?.catch(() => {})
    page.on('request', track)
    page.on('response', trackResponse)
    page.on('requestfailed', trackFailure)
    try {
      if (surface === 'field') {
        await page
          .locator('[data-editor-surface="asset-quick-list"]')
          .locator('input[type=file]')
          .setInputFiles(file)
      } else {
        // A disk-backed File enters DataTransfer without serializing its bytes through Playwright.
        await page.evaluate(() => {
          const input = document.createElement('input')
          input.type = 'file'
          input.id = 'video-transfer-source'
          input.hidden = true
          document.body.append(input)
        })
        await page.locator('#video-transfer-source').setInputFiles(file)
        await page.locator('#video-transfer-source').evaluate((input) => {
          const transfer = new DataTransfer()
          transfer.items.add(input.files[0])
          document.querySelector('[data-testid=graph-canvas]').dispatchEvent(
            new DragEvent('drop', {
              bubbles: true,
              cancelable: true,
              clientX: 420,
              clientY: 320,
              dataTransfer: transfer,
            }),
          )
          input.remove()
        })
      }
      if (refused) {
        let notice = page.getByTestId('canvas-file-drop-surface')
        if (surface === 'field') {
          const status = page.getByTestId('asset-field-import-status')
          await expect(status).toHaveAttribute('data-phase', 'refused')
          await status
            .getByRole('button', { name: 'Details', exact: true })
            .click()
          notice = page.getByRole('dialog', {
            name: 'File not added',
            exact: true,
          })
        }
        await expect(notice).toContainText(/This engine takes videos up to/i)
        assert.equal(
          await page.evaluate(() =>
            JSON.stringify(window.__dinksterTest.app.activeTab().store.doc),
          ),
          before,
        )
        assert.equal(
          uploads.length,
          0,
          'A reported lower limit must refuse before upload',
        )
      } else {
        if (surface === 'canvas') {
          await expect(page.getByTestId('canvas-import-dialog')).toBeVisible()
          await expect(
            page.getByTestId('upload-destination-mount'),
          ).toContainText(mount)
          await expect(page.getByTestId('canvas-import-limit')).toHaveCount(
            policy === null ? 0 : 1,
          )
          await page.screenshot({
            path: join(artifacts, `${surface}-${expectedPolicy}-before.png`),
          })
          await page
            .getByTestId('canvas-import-dialog')
            .getByRole('button', { name: 'Import video', exact: true })
            .click()
        }
        await expect.poll(() => uploads.length).toBe(1)
        response = await mediaResponse
        assert.ok(
          response && [200, 201].includes(response.status()),
          `Media upload returned ${response?.status()}`,
        )
        await page.waitForFunction(
          () => window.__transferResponses.length === 1,
        )
        const captured = await page.evaluate(
          () => window.__transferResponses[0],
        )
        assert.equal(captured.status, response.status())
        assert.equal(captured.error, undefined)
        const payload = captured.payload
        assert.equal(payload.asset.size, size)
        if (surface === 'field') {
          await expect(
            page.locator('[data-editor-surface="asset-quick-list"]'),
          ).toHaveCount(0)
          await expect(
            page.getByTestId('asset-field-import-status'),
          ).toBeHidden()
        }
        await expect
          .poll(() =>
            page.evaluate(() => {
              const doc = window.__dinksterTest.app.activeTab().store.doc
              return Object.values(doc.graphs[doc.root].nodes)
                .flatMap((node) => Object.values(node.values))
                .filter((value) => value?.mediaType?.startsWith('video/'))
            }),
          )
          .toEqual([payload.asset])
        const query = new URL(uploads[0].url()).searchParams
        assert.equal(query.get('mount'), mount)
        assert.equal(new URL(uploads[0].url()).origin, new URL(frontend).origin)
        const stored = new URL(
          `/api/assets/${encodeURIComponent(payload.asset.digest)}`,
          backend,
        )
        stored.search = new URLSearchParams({
          scope: query.get('scope'),
          project: query.get('project') || 'default',
        }).toString()
        const readback = await fetch(stored, {
          signal: AbortSignal.timeout(180_000),
        })
        assert.equal(readback.status, 200)
        let copied = 0
        const hash = createHash('sha256')
        for await (const chunk of readback.body) {
          hash.update(chunk)
          copied += chunk.length
        }
        assert.equal(copied, size)
        assert.equal(hash.digest('hex'), sha256)
      }
      await page.screenshot({
        path: join(artifacts, `${surface}-${expectedPolicy}-after.png`),
      })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.screenshot({
        path: join(artifacts, `${surface}-${expectedPolicy}-narrow.png`),
      })
      await page.setViewportSize({ width: 1440, height: 950 })
      evidence.results.push({
        surface,
        uploads: uploads.length,
        status: response?.status(),
        memory: {
          baseline,
          peak: Math.max(...samples),
          final: rss(),
          samples: samples.length,
          processIds: pids,
        },
        reads: await page.evaluate(() => window.__transferReads),
      })
      assert.deepEqual(evidence.results.at(-1).reads, {
        largeArrayBuffer: 0,
        largeFileReader: 0,
        largeText: 0,
      })
    } finally {
      clearInterval(sampler)
      page.off('request', track)
      page.off('response', trackResponse)
      page.off('requestfailed', trackFailure)
      attempt.memory = {
        baseline,
        peak: Math.max(...samples),
        final: rss(),
        samples: samples.length,
        processIds: pids,
      }
      try {
        attempt.browser = await page.evaluate(() => ({
          reads: window.__transferReads,
          responses: window.__transferResponses,
        }))
        await page.screenshot({
          path: join(artifacts, `${surface}-${expectedPolicy}-last.png`),
          timeout: 5000,
        })
      } catch (error) {
        attempt.observationFailure = String(error)
      }
      if (surface === 'field') await page.keyboard.press('Escape')
    }
  }
  assert.deepEqual(evidence.pageErrors, [])
  evidence.completed = true
  console.log(JSON.stringify(evidence, null, 2))
} catch (error) {
  evidence.failure = String(error)
  throw error
} finally {
  await writeFile(
    join(artifacts, 'video-transfer-result.json'),
    JSON.stringify(evidence, null, 2),
  )
  await browser.close()
}
