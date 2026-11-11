import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const proofDir = resolve(import.meta.dirname, '../../../.amp/in/artifacts/native-output-preview')
const longIdentityName = `middle-${'complete-identity-'.repeat(6)}.png`

const imageOutput = (names: readonly string[]) => ({
  images: { typeId: 'list<ASSET>', elements: names.map((name, index) => {
    const digest = `blake3:${'abc'[index]!.repeat(64)}`
    return { typeId: 'ASSET', fingerprint: digest, meta: { digest, name, mediaType: 'image/png' } }
  }) },
})

async function mockBackend(page: Page): Promise<void> {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated proof' }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'output-proof', schemaWire: 1 }, nodes: {},
  } }))
  await page.route('**/api/assets/*', (route) => {
    const digest = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!)
    if (digest === `blake3:${'c'.repeat(64)}`) {
      void route.fulfill({ status: 404, body: 'missing proof image' })
      return
    }
    const filename = digest === `blake3:${'b'.repeat(64)}` ? longIdentityName : 'first.png'
    const color = filename === 'first.png' ? '#3b82f6' : filename.startsWith('middle-') ? '#a855f7' : '#22c55e'
    void route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640"><rect width="960" height="640" fill="${color}"/><text x="480" y="330" text-anchor="middle" fill="white" font-size="72">${filename.startsWith('middle-') ? 'long identity image' : filename}</text></svg>`,
    })
  })
}

async function installExecution(page: Page): Promise<void> {
  await page.evaluate((output) => {
    window.__dinksterTest!.app.registerSchemas([{
      type: 'OutputPreviewProof', displayName: 'Save Image', category: 'proof', source: 'v3', isOutputNode: true,
      items: [{ kind: 'output', id: 'images', type: { kind: 'concrete', name: 'IMAGE' } }],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'output-preview-proof', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { save: { id: 'save', type: 'OutputPreviewProof', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { save: { position: { x: 150, y: 100 }, size: { width: 520, height: 420 } } } } } },
    } as never, 'Output Preview Proof')
    const app = window.__dinksterTest!.app
    const compiled = app.compileTab(app.activeTab()!)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = { connection: compiled.artifact.connection, prompt: 'output-preview-run-1' }
    const store = app.store as unknown as { register(ref: unknown, artifact: unknown, now: number): void; apply(event: unknown): void }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    store.apply({ kind: 'nodeStates', execution: ref, timestamp: Date.now(), nodes: { save: { state: 'done' } } })
    store.apply({
      kind: 'nodeOutput', execution: ref, runtimeNodeId: 'save', timestamp: Date.now(),
      output,
    })
    store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() })
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, imageOutput(['first.png', longIdentityName, 'unavailable.png']))
}

test.beforeEach(async ({ page }) => {
  mkdirSync(proofDir, { recursive: true })
  await mockBackend(page)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app !== undefined)).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined)).toBe(true)
  await installExecution(page)
  await page.locator('.dock-zone').getByRole('tab', { name: 'Outputs' }).click()
  await expect(page.locator('.output-thumbnail')).toHaveCount(3)
  await expect(page.getByTestId('node-output-pager')).toHaveCount(1)
})

test('native batch rail mounts one page, releases departing tiles, and keeps viewer indices', async ({ page }) => {
  const requested: number[] = []
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 32
    const context = canvas.getContext('2d')!
    context.fillStyle = '#3b82f6'
    context.fillRect(0, 0, 64, 32)
    const revoked: string[] = []
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.revokeObjectURL = (url) => { revoked.push(url); revoke(url) }
    ;(window as unknown as { revokedOutputUrls: string[] }).revokedOutputUrls = revoked
    return canvas.toDataURL('image/png').split(',')[1]!
  })
  const descriptor = { typeId: 'IMAGE', fingerprint: 'native-batch', meta: { shape: [9, 32, 64, 3] } }
  await page.route('**/api/values?*', (route) => {
    const query = new URL(route.request().url()).searchParams
    if (!query.has('rendition')) return route.fulfill({ json: {
      available: true, descriptor, renditions: [{ kind: 'png', mime: 'image/png', parameters: ['batch'] }],
    } })
    requested.push(Number(query.get('batch')))
    return route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64'), headers: {
      'X-Dinkster-Fingerprint': 'native-batch', 'X-Dinkster-Rendition': 'png',
    } })
  })
  await page.evaluate((descriptor) => {
    const app = window.__dinksterTest!.app
    const execution = [...app.store.executions.get().values()].find((entry) => entry.ref.prompt === 'output-preview-run-1')!
    ;(app.store as unknown as { apply(event: unknown): void }).apply({
      kind: 'nodeOutput', execution: execution.ref, runtimeNodeId: 'save', timestamp: Date.now(), output: { images: descriptor },
    })
  }, descriptor)
  const thumbnails = page.locator('.output-thumbnail')
  const pages = page.getByRole('group', { name: 'Output image pages' })
  await expect(thumbnails).toHaveCount(4)
  await expect(pages).toContainText('1-4 of 9')
  await expect.poll(() => [...new Set(requested)].sort()).toEqual([0, 1, 2, 3])
  for (const image of await thumbnails.locator('img').all()) await expect(image).toHaveJSProperty('naturalWidth', 64)
  const firstUrls = await thumbnails.locator('img').evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src))
  await page.getByTestId('outputs-panel').screenshot({ path: `${proofDir}/native-batch-page-1.png` })
  await thumbnails.last().scrollIntoViewIfNeeded()
  await expect(thumbnails.last()).toBeInViewport()
  await page.getByTestId('outputs-panel').screenshot({ path: `${proofDir}/native-batch-page-1-tail.png` })
  await pages.getByRole('button', { name: 'Next output page' }).click()
  await expect(pages).toContainText('5-8 of 9')
  await expect(thumbnails.first()).toHaveAttribute('aria-label', /Image 5 of 9/)
  await expect.poll(() => page.evaluate((urls) => {
    const revoked = (window as unknown as { revokedOutputUrls: string[] }).revokedOutputUrls
    return urls.every((url) => revoked.includes(url))
  }, firstUrls)).toBe(true)
  await expect.poll(() => [...new Set(requested)].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  await page.getByTestId('outputs-panel').screenshot({ path: `${proofDir}/native-batch-page-2.png` })
  await thumbnails.last().scrollIntoViewIfNeeded()
  await expect(thumbnails.last()).toBeInViewport()
  await page.getByTestId('outputs-panel').screenshot({ path: `${proofDir}/native-batch-page-2-tail.png` })
  await pages.getByRole('button', { name: 'Next output page' }).click()
  await expect(thumbnails).toHaveCount(1)
  await expect(pages).toContainText('9-9 of 9')
  await expect(pages.getByRole('button', { name: 'Next output page' })).toBeDisabled()
  await thumbnails.first().click()
  await expect(page.getByTestId('output-viewer-position')).toHaveText('9 / 9')
  await page.keyboard.press('Escape')
  await expect(thumbnails.first()).toBeFocused()
  await page.getByTestId('outputs-panel').screenshot({ path: `${proofDir}/native-batch-page-3.png` })
})

test('rail viewer and canvas paging remain ordered, accessible, ephemeral, and responsive', async ({ page }) => {
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  const thumbnails = page.locator('.output-thumbnail')
  await expect(thumbnails.nth(0)).toHaveAttribute('aria-label', /Image 1 of 3, node save, output images, descriptor 1, first.png/)
  await expect(thumbnails.nth(1)).toHaveAttribute('aria-label', /Image 2 of 3, node save, output images, descriptor 2, middle-/)
  await expect(thumbnails.nth(1)).toContainText(longIdentityName)
  await expect(page.getByTestId('outputs-panel').getByLabel('Execution provenance')).toContainText('output-preview-run-1')
  await page.screenshot({ path: `${proofDir}/01-rail-grid-1920.png`, animations: 'disabled' })
  await page.getByTestId('outputs-panel').screenshot({ path: `${proofDir}/01a-output-panel-complete.png`, animations: 'disabled' })
  await page.locator('.dock-zone .product-tabpanel:not([hidden])').evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(thumbnails.nth(2)).toBeInViewport()
  await page.screenshot({ path: `${proofDir}/01b-output-panel-scroll-tail.png`, animations: 'disabled' })
  await thumbnails.nth(1).scrollIntoViewIfNeeded()

  await thumbnails.nth(1).click()
  await expect(page.getByTestId('output-viewer-position')).toHaveText('2 / 3')
  await page.screenshot({ path: `${proofDir}/02-viewer-single-middle-1920.png`, animations: 'disabled' })
  await page.getByRole('button', { name: 'Show all images' }).click()
  await expect(page.getByTestId('output-viewer-grid').getByRole('button')).toHaveCount(3)
  await expect(page.getByTestId('output-viewer-grid')).toContainText('Unavailable')
  await page.screenshot({ path: `${proofDir}/03-viewer-grid-1920.png`, animations: 'disabled' })
  await page.getByTestId('output-viewer-grid').getByRole('button', { name: /Image 1 of 3, node save, output images, descriptor 1, first.png/ }).click()
  await page.getByTestId('output-viewer').getByRole('button', { name: '100%' }).click()
  await page.getByTestId('output-viewer').getByRole('button', { name: 'Zoom in' }).click()
  await expect(page.getByTestId('output-viewer-image')).toHaveAttribute('data-scale', '125')
  await page.screenshot({ path: `${proofDir}/04-viewer-zoom-1920.png`, animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('output-viewer')).toBeVisible()
  expect(await page.getByTestId('output-viewer').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: `${proofDir}/04a-viewer-narrow-390x844.png`, animations: 'disabled' })
  await page.locator('.output-viewer-details').evaluate((element) => { element.scrollTop = element.scrollHeight })
  await page.screenshot({ path: `${proofDir}/04b-viewer-narrow-scroll-tail.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(thumbnails.nth(1)).toBeFocused()
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.evaluate(() => { document.documentElement.style.zoom = '2' })
  await thumbnails.nth(0).click()
  expect(await page.getByTestId('output-viewer').evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= window.innerWidth && bounds.bottom <= window.innerHeight
  })).toBe(true)
  await page.screenshot({ path: `${proofDir}/04c-viewer-css-zoom-200.png`, animations: 'disabled' })
  await page.locator('.output-viewer-details').evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(page.locator('.output-viewer-details').getByText('Available', { exact: true })).toBeInViewport()
  await page.screenshot({ path: `${proofDir}/04c2-viewer-css-zoom-200-tail.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')
  await page.evaluate(() => { document.documentElement.style.zoom = '' })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await thumbnails.nth(0).click()
  await page.screenshot({ path: `${proofDir}/04d-viewer-reduced-motion.png`, animations: 'disabled' })
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('output-viewer-position')).toHaveText('2 / 3')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('output-viewer')).toHaveCount(0)
  await expect(thumbnails.nth(0)).toBeFocused()
  await thumbnails.nth(0).click()
  await page.getByTestId('output-viewer').getByRole('button', { name: /Close/ }).click()
  await expect(thumbnails.nth(0)).toBeFocused()
  await thumbnails.nth(0).click()
  await page.getByTestId('output-viewer').dispatchEvent('pointerdown', { clientX: 0, clientY: 0 })
  await expect(page.getByTestId('output-viewer')).toHaveCount(0)
  await expect(thumbnails.nth(0)).toBeFocused()

  const pager = page.getByTestId('node-output-pager')
  await expect(pager.getByRole('button', { name: /Open image 1 of 3/ })).toBeVisible()
  await page.screenshot({ path: `${proofDir}/05-canvas-first-1920.png`, animations: 'disabled' })
  await pager.getByRole('button', { name: /Next image/ }).focus()
  await page.keyboard.press('Enter')
  await expect(pager.getByRole('button', { name: /Open image 2 of 3/ })).toBeVisible()
  await expect(pager.getByRole('button', { name: /Next image/ })).toBeFocused()
  await page.screenshot({ path: `${proofDir}/06-canvas-middle-1920.png`, animations: 'disabled' })
  await pager.getByRole('button', { name: /Next image/ }).click()
  await expect(pager.getByRole('button', { name: /Open image 3 of 3/ })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getNodePreviews()['save']?.status)).toBe('unavailable')
  await page.screenshot({ path: `${proofDir}/07-canvas-last-unavailable-1920.png`, animations: 'disabled' })
  await pager.getByRole('button', { name: /Open image 3 of 3/ }).click()
  await expect(page.getByTestId('output-viewer-position')).toHaveText('3 / 3')
  await expect(page.getByTestId('output-viewer').getByRole('alert')).toContainText('Image unavailable')
  await page.screenshot({ path: `${proofDir}/08-viewer-unavailable-1920.png`, animations: 'disabled' })
  await page.getByTestId('output-viewer').getByRole('button', { name: /Close/ }).click()

  await pager.getByRole('button', { name: /Open image 3 of 3/ }).click()
  await page.evaluate((output) => {
    const app = window.__dinksterTest!.app
    const execution = (app as unknown as { executionForTab(tab: unknown): { ref: unknown } }).executionForTab(app.activeTab()!)
    ;(app.store as unknown as { apply(event: unknown): void }).apply({
      kind: 'nodeOutput', execution: execution.ref, runtimeNodeId: 'save', timestamp: Date.now(),
      output,
    })
  }, imageOutput(['first.png', longIdentityName, 'unavailable.png']))
  await page.keyboard.press('Escape')
  await expect(pager.getByRole('button', { name: /Open image 3 of 3/ })).toBeFocused()

  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 0.5 }))
  await expect(page.getByTestId('node-output-pager')).toHaveCount(0)
  await page.screenshot({ path: `${proofDir}/09-low-zoom-simplification-1920.png`, animations: 'disabled' })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
  await expect(page.getByTestId('node-output-pager')).toHaveCount(1)
  await page.screenshot({ path: `${proofDir}/10-rail-canvas-1366.png`, animations: 'disabled' })
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await page.getByTestId('node-output-pager').getByRole('button', { name: /Open image 3 of 3/ }).click()
  await expect(page.getByTestId('output-viewer-position')).toHaveText('3 / 3')

  await page.evaluate((output) => {
    const app = window.__dinksterTest!.app
    const compiled = app.compileTab(app.activeTab()!)
    if (!compiled?.ok) throw new Error('second compile failed')
    const ref = { connection: compiled.artifact.connection, prompt: 'output-preview-run-2' }
    const store = app.store as unknown as { register(ref: unknown, artifact: unknown, now: number): void; apply(event: unknown): void }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    store.apply({ kind: 'nodeStates', execution: ref, timestamp: Date.now(), nodes: { save: { state: 'done' } } })
    store.apply({ kind: 'nodeOutput', execution: ref, runtimeNodeId: 'save', timestamp: Date.now(), output })
    store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() })
  }, imageOutput(['first.png', longIdentityName]))
  await expect(page.getByTestId('output-viewer')).toHaveCount(0)
  await expect(page.getByTestId('node-output-pager').getByRole('button', { name: /Open image 1 of 2/ })).toBeVisible()
  await page.screenshot({ path: `${proofDir}/11-new-execution-reset-1366.png`, animations: 'disabled' })
  await page.getByTestId('node-output-pager').getByRole('button', { name: /Next image/ }).click()
  await expect(page.getByTestId('node-output-pager').getByRole('button', { name: /Open image 2 of 2/ })).toBeVisible()
  await page.getByTestId('node-output-pager').getByRole('button', { name: /Open image 2 of 2/ }).click()
  await page.evaluate((output) => {
    const app = window.__dinksterTest!.app
    const execution = (app as unknown as { executionForTab(tab: unknown): { ref: unknown } }).executionForTab(app.activeTab()!)
    ;(app.store as unknown as { apply(event: unknown): void }).apply({
      kind: 'nodeOutput', execution: execution.ref, runtimeNodeId: 'save', timestamp: Date.now(),
      output,
    })
  }, imageOutput(['first.png']))
  await expect(page.getByTestId('output-viewer')).toHaveCount(1)
  await expect(page.getByTestId('output-viewer-position')).toHaveText('1 / 1')
  await expect(page.getByTestId('node-output-pager')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => {
    const preview = window.__dinksterTest!.renderer!.getNodePreviews()['save'] as { index?: number; count?: number } | undefined
    return [preview?.index, preview?.count]
  })).toEqual([0, 1])
  await page.screenshot({ path: `${proofDir}/12-shrink-clamp-single-1366.png`, animations: 'disabled' })

  await page.evaluate(() => window.__dinksterTest!.app.openDocument({
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'output-preview-empty', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
    view: { graphs: { g0: { nodes: {} } } },
  }, 'Output Preview Empty'))
  await expect(page.getByTestId('node-output-pager')).toHaveCount(0)
  await expect(page.locator('.output-thumbnail')).toHaveCount(0)
  await expect(page.getByTestId('outputs-panel')).toContainText('No execution selected')
  await page.screenshot({ path: `${proofDir}/13-no-execution-1366.png`, animations: 'disabled' })
})

test('output inspection distinguishes lifecycle, asset identity, errors, and unavailable owners', async ({ page }) => {
  const installState = async (kind: 'queued' | 'running' | 'loading' | 'empty' | 'error' | 'asset' | 'disconnected-owner' | 'removed-owner') => {
    await page.evaluate((stateKind) => {
      const app = window.__dinksterTest!.app as any
      const compiled = app.compileTab(app.activeTab())
      if (!compiled?.ok) throw new Error(`compile failed for ${stateKind}`)
      let connection = compiled.artifact.connection
      if (stateKind === 'disconnected-owner' || stateKind === 'removed-owner') {
        const removed = stateKind === 'removed-owner'
        const backend = app.addBackend(
          `http://127.0.0.1:5382/${removed ? 'removed' : 'disconnected'}-output-owner`,
          removed ? 'Removed output owner' : 'Configured disconnected owner',
          false, 'dinkster', false,
        )
        if (!backend) throw new Error(`${stateKind} fixture failed`)
        connection = backend.id
      } else {
        ;(app.backendFor(connection).connection.status as any).set('connected')
      }
      const ref = { connection, prompt: `output-state-${stateKind}-${Date.now()}` }
      app.store.register(ref, compiled.artifact, Date.now() + 100)
      if (stateKind !== 'queued') app.store.apply({ kind: 'started', execution: ref, timestamp: Date.now() + 101 })
      if (stateKind === 'error') {
        app.store.apply({
          kind: 'error', execution: ref, timestamp: Date.now() + 102, runtimeNodeId: 'save',
          detail: { exceptionType: 'OutputProofError', exceptionMessage: 'Exact output proof failure.', traceback: [] },
        })
      } else if (stateKind === 'asset') {
        const digest = `blake3:${'a'.repeat(64)}`
        app.store.apply({
          kind: 'nodeOutput', execution: ref, runtimeNodeId: 'save', timestamp: Date.now() + 102,
          output: { result: {
            typeId: 'ASSET', fingerprint: digest,
            meta: { digest, mediaType: 'image/png', name: `asset-${'complete-identity-'.repeat(6)}.png` },
          } },
        })
        app.store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() + 103 })
        app.store.hydrateArtifacts(ref, [])
      } else if (stateKind === 'removed-owner') {
        const digest = `blake3:${'a'.repeat(64)}`
        app.store.apply({
          kind: 'nodeOutput', execution: ref, runtimeNodeId: 'save', timestamp: Date.now() + 102,
          output: { images: {
            typeId: 'ASSET', fingerprint: digest,
            meta: { digest, mediaType: 'image/png', name: 'first.png', virtualPath: 'mounts/output/retained/owner/path/first.png' },
          } },
        })
        app.store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() + 103 })
        app.store.hydrateArtifacts(ref, [])
        app.removeBackend(connection, false)
      } else if (stateKind === 'disconnected-owner') {
        app.store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() + 103 })
        app.store.hydrateArtifacts(ref, [])
      } else if (stateKind === 'loading' || stateKind === 'empty') {
        app.store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() + 102 })
        if (stateKind === 'empty') app.store.hydrateArtifacts(ref, [])
      }
    }, kind)
  }

  await installState('queued')
  await expect(page.getByTestId('outputs-panel')).toContainText('Waiting for image outputs')
  await expect(page.getByTestId('outputs-panel')).toContainText('The execution is queued')
  await page.screenshot({ path: `${proofDir}/20-state-queued.png`, animations: 'disabled' })

  await installState('running')
  await expect(page.getByTestId('outputs-panel')).toContainText('The execution is running')
  await page.screenshot({ path: `${proofDir}/21-state-running.png`, animations: 'disabled' })

  await installState('loading')
  await expect(page.getByTestId('outputs-panel')).toContainText('Loading retained outputs')
  await page.screenshot({ path: `${proofDir}/22-state-loading.png`, animations: 'disabled' })

  await installState('empty')
  await expect(page.getByTestId('outputs-panel')).toContainText('No image outputs')
  await page.screenshot({ path: `${proofDir}/23-state-empty.png`, animations: 'disabled' })

  await installState('error')
  await expect(page.getByTestId('outputs-panel').getByRole('alert')).toContainText('Exact output proof failure')
  await page.screenshot({ path: `${proofDir}/24-state-error.png`, animations: 'disabled' })
  await page.getByTestId('outputs-panel').screenshot({ path: `${proofDir}/24a-state-error-panel.png`, animations: 'disabled' })

  await installState('asset')
  const assetCard = page.locator('.output-thumbnail')
  await expect(assetCard).toHaveCount(1)
  await expect(assetCard).toContainText(`blake3:${'a'.repeat(5)}...${'a'.repeat(8)}`)
  await expect(assetCard.locator('.asset-digest-value code')).toHaveAttribute('title', `blake3:${'a'.repeat(64)}`)
  await expect(assetCard).toContainText('Content-addressed asset')
  await expect(assetCard).toContainText('image/png')
  await page.screenshot({ path: `${proofDir}/25-state-asset-long-identity.png`, animations: 'disabled' })
  await page.getByTestId('outputs-panel').screenshot({ path: `${proofDir}/25a-state-asset-panel.png`, animations: 'disabled' })

  await installState('disconnected-owner')
  await expect(page.getByTestId('outputs-panel')).toContainText('Configured disconnected owner')
  await expect(page.getByTestId('outputs-panel')).toContainText('Output owner unavailable')
  await expect(page.getByTestId('outputs-panel')).toContainText('removed or disconnected')
  await page.screenshot({ path: `${proofDir}/26-state-disconnected-owner.png`, animations: 'disabled' })
  await page.getByTestId('outputs-panel').screenshot({ path: `${proofDir}/26a-state-disconnected-owner-panel.png`, animations: 'disabled' })

  await installState('removed-owner')
  await expect(page.getByTestId('outputs-panel')).toContainText('http://127.0.0.1:5382/removed-output-owner')
  await expect(page.getByTestId('outputs-panel')).toContainText('removed or disconnected')
  await expect(page.locator('.output-thumbnail')).toContainText('retained/owner/path')
  await page.screenshot({ path: `${proofDir}/27-state-removed-owner.png`, animations: 'disabled' })
  await page.getByTestId('outputs-panel').screenshot({ path: `${proofDir}/27a-state-removed-owner-panel.png`, animations: 'disabled' })
})
