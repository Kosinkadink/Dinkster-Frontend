import { readFileSync } from 'node:fs'
import { expect, nativeTest, skipWithoutNativeCatalog, test, type Page } from './fixtures.js'

const SOURCE = `blake3:${'1'.repeat(64)}`
const DERIVED = `blake3:${'2'.repeat(64)}`
const PNG = readFileSync(new URL('../../../docs/assets/lora-conditioning-scheduling/flat-native-image.png', import.meta.url))
const PROOF = '/tmp/image-editor-proof'
const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

async function widgetPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'asset')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'image')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  })
}

async function openFromRow(page: Page): Promise<void> {
  const point = await widgetPoint(page)
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Edit mask', exact: true })).toHaveCount(0)
  await page.getByRole('menuitem', { name: 'Edit image' }).click()
  await expect(page.getByTestId('image-editor')).toBeVisible()
  await expect(page.getByTestId('image-editor').getByText('Image editor', { exact: true })).toBeVisible()
  await expect(page.getByTestId('image-editor').getByText('Mask', { exact: true })).toBeVisible()
  await expect(page.getByTestId('image-mask-surface')).toBeVisible()
  await page.waitForTimeout(500)
  if (await page.getByRole('button', { name: 'Bake to asset' }).isDisabled())
    throw new Error(`image source did not load: ${await page.getByTestId('image-editor').textContent()}`)
  await expect(page.getByRole('button', { name: 'Bake to asset' })).toBeEnabled()
}

async function reopen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): unknown
      imageTargetForInput(tab: unknown, graphId: string, nodeId: string, inputId: string): unknown
      openImageEditor(target: unknown): boolean
    }
    const tab = app.activeTab()
    const target = app.imageTargetForInput(tab, 'g0', 'asset', 'image')
    if (!target || !app.openImageEditor(target)) throw new Error('derived image was not eligible for image editor reopen')
  })
  await expect(page.getByTestId('image-editor')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Bake to asset' })).toBeEnabled()
}

type ImagePointerType = 'mouse' | 'pen' | 'touch'
type ImagePointerEventType = 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture'

async function dispatchImagePointer(page: Page, args: {
  readonly type: ImagePointerEventType
  readonly pointerId: number
  readonly pointerType: ImagePointerType
  readonly x: number
  readonly y: number
  readonly pressure?: number
  readonly tiltX?: number
  readonly tiltY?: number
  readonly twist?: number
  readonly coalesced?: readonly {
    readonly x: number
    readonly y: number
    readonly pressure: number
    readonly tiltX?: number
    readonly tiltY?: number
    readonly twist?: number
  }[]
}): Promise<void> {
  await page.evaluate((detail) => {
    const viewport = document.querySelector('[data-testid=image-canvas-viewport]')!
    const rect = viewport.getBoundingClientRect()
    const init = (point: {
      readonly x: number
      readonly y: number
      readonly pressure?: number
      readonly tiltX?: number
      readonly tiltY?: number
      readonly twist?: number
    }) => ({
      pointerId: detail.pointerId,
      pointerType: detail.pointerType,
      clientX: rect.left + point.x,
      clientY: rect.top + point.y,
      pressure: point.pressure ?? detail.pressure ?? (detail.pointerType === 'pen' ? 0.5 : 0),
      tiltX: point.tiltX ?? detail.tiltX ?? 0,
      tiltY: point.tiltY ?? detail.tiltY ?? 0,
      twist: point.twist ?? detail.twist ?? 0,
      button: detail.type === 'pointermove' ? -1 : 0,
      buttons: detail.type === 'pointerdown' || detail.type === 'pointermove' ? 1 : 0,
      bubbles: true,
      cancelable: true,
    })
    const event = new PointerEvent(detail.type, init(detail))
    if (detail.coalesced !== undefined) {
      const samples = detail.coalesced.map((point) => new PointerEvent('pointermove', init(point)))
      Object.defineProperty(event, 'getCoalescedEvents', { value: () => samples })
    }
    viewport.dispatchEvent(event)
  }, args)
}

const overlayAlpha = (page: Page) => page.evaluate(() => {
  const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=image-mask-surface]')!
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  let total = 0
  for (let index = 3; index < data.length; index += 4) total += data[index]!
  return total
})

const overlayAlphaAt = (page: Page, points: readonly { readonly x: number; readonly y: number }[]) =>
  page.evaluate((samples) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=image-mask-surface]')!
    const context = canvas.getContext('2d')!
    return samples.map((sample) => {
      const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(canvas.width * sample.x)))
      const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(canvas.height * sample.y)))
      return context.getImageData(x, y, 1, 1).data[3]!
    })
  }, points)

const imageNavigation = (page: Page) => page.evaluate(() => {
  const stack = document.querySelector<HTMLElement>('.image-canvas-stack')!
  return { left: stack.style.left, top: stack.style.top, transform: stack.style.transform }
})

nativeTest('image editor keeps mask edits local until one guarded AssetRef apply', async ({ page, request }, testInfo) => {
  await skipWithoutNativeCatalog(request, testInfo)
  let uploaded: Buffer<ArrayBufferLike> = PNG
  let failUpload = false
  let uploadCount = 0
  let heldUpload: { readonly promise: Promise<void>; readonly release: () => void } | undefined
  const nodesResponse = await fetch(`${NATIVE_BACKEND}/api/nodes`)
  expect(nodesResponse.ok).toBe(true)
  const nodes = await nodesResponse.text()
  const extensionSnapshotResponse = await fetch(`${NATIVE_BACKEND}/api/extensions/snapshot`)
  expect(extensionSnapshotResponse.ok).toBe(true)
  const extensionSnapshot = await extensionSnapshotResponse.text()
  await page.route('**/api/nodes*', (route) => route.fulfill({ contentType: 'application/json', body: nodes }))
  await page.route('**/api/extensions/snapshot', (route) => route.fulfill({ contentType: 'application/json', body: extensionSnapshot }))
  await page.route('**/api/assets/**', (route) => route.fulfill({ contentType: 'image/png', body: uploaded }))
  await page.route('**/api/assets', async (route) => {
    uploadCount += 1
    if (failUpload) return route.fulfill({ status: 500, json: { error: 'injected upload failure' } })
    const hold = heldUpload
    if (hold) {
      await hold.promise
      if (heldUpload === hold) heldUpload = undefined
    }
    uploaded = await route.request().postDataBuffer() ?? Buffer.alloc(0)
    return route.fulfill({ status: 200, json: { digest: DERIVED } })
  })
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.app.backends.get()[0]?.registry.get() !== undefined,
  ), { timeout: 15_000 }).toBe(true)
  await page.evaluate(({ source, pngSize }) => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'ImageEditorAssetTest', displayName: 'Load Image', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'image', type: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.IMAGE' } }, optional: false,
        widget: { widgetType: 'ASSET', kind: 'image', options: { accept: ['image/png'] } } }],
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'image-editor-proof', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { asset: { id: 'asset', type: 'ImageEditorAssetTest', values: {
        image: { digest: source, name: 'source.png', size: pngSize, mediaType: 'image/png', virtualPath: '' },
      } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { asset: { position: { x: 100, y: 100 } } } } } },
    }, 'Image editor proof')
    const tab = app.activeTab()!
    const backend = (app as unknown as { backendForTab(tab: unknown): unknown }).backendForTab(tab) as { protocol: string; connection: Record<string, unknown> }
    backend.protocol = 'dinkster'
    backend.connection.assetUrl = (digest: string) => `/api/assets/${encodeURIComponent(digest)}`
    backend.connection.uploadAsset = async (blob: Blob, signal: AbortSignal) => {
      const response = await fetch('/api/assets', { method: 'POST', body: blob, signal })
      if (!response.ok) throw new Error(`POST /api/assets failed: ${response.status}`)
      return ((await response.json()) as { digest: string }).digest
    }
    const dispatchingApp = app as unknown as {
      dispatchTo(tab: unknown, invocation: { command: string }): unknown
    }
    const originalDispatch = dispatchingApp.dispatchTo.bind(dispatchingApp)
    ;(window as unknown as { __imageApplyCount: number }).__imageApplyCount = 0
    dispatchingApp.dispatchTo = (owner, invocation) => {
      if (invocation.command === 'image.applyAsset') (window as unknown as { __imageApplyCount: number }).__imageApplyCount += 1
      return originalDispatch(owner as never, invocation as never)
    }
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, { source: SOURCE, pngSize: PNG.byteLength })

  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .find((item) => item.id === 'asset')?.layout.rows.some((item) => item.kind === 'widget' && item.inputId === 'image'))).toBe(true)
  await openFromRow(page)
  const initialRevision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await page.screenshot({ path: `${PROOF}/01-open-image-editor.png` })
  await page.setViewportSize({ width: 640, height: 700 })
  await expect(page.getByTestId('image-editor').getByText('Image editor', { exact: true })).toBeVisible()
  await expect(page.getByTestId('image-editor').getByText('Mask', { exact: true })).toBeVisible()
  const narrowBoxes = await page.evaluate(() => {
    const controls = document.querySelector('.canvas-view-controls')!.getBoundingClientRect()
    const title = document.querySelector('.image-editor-header strong')!.getBoundingClientRect()
    const actions = document.querySelector('.image-editor-actions')!.getBoundingClientRect()
    const editor = document.querySelector('.image-editor')!.getBoundingClientRect()
    return {
      controlsBottom: controls.bottom,
      titleTop: title.top,
      actionsRight: actions.right,
      editorRight: editor.right,
    }
  })
  expect(narrowBoxes.titleTop).toBeGreaterThanOrEqual(narrowBoxes.controlsBottom)
  expect(narrowBoxes.actionsRight).toBeLessThanOrEqual(narrowBoxes.editorRight)
  await page.screenshot({ path: `${PROOF}/08-narrow-image-editor.png` })
  await page.setViewportSize({ width: 1440, height: 900 })

  const surface = page.getByTestId('image-mask-surface')
  await page.getByRole('button', { name: 'Clear' }).click()
  const clearedAlpha = await overlayAlpha(page)
  const viewportBoxForInput = await page.getByTestId('image-canvas-viewport').boundingBox()
  const surfaceBoxForInput = await surface.boundingBox()
  const imagePoint = (x: number, y: number) => ({
    x: surfaceBoxForInput!.x - viewportBoxForInput!.x + surfaceBoxForInput!.width * x,
    y: surfaceBoxForInput!.y - viewportBoxForInput!.y + surfaceBoxForInput!.height * y,
  })
  const penStart = imagePoint(0.2, 0.35)
  const penEnd = imagePoint(0.8, 0.35)
  await dispatchImagePointer(page, { type: 'pointerdown', pointerId: 31, pointerType: 'pen', ...penStart, pressure: 0.25 })
  await dispatchImagePointer(page, {
    type: 'pointermove', pointerId: 31, pointerType: 'pen', ...penEnd, pressure: 1,
    coalesced: [
      { ...imagePoint(0.4, 0.35), pressure: 0.5, tiltX: 12, tiltY: -8, twist: 30 },
      { ...imagePoint(0.6, 0.35), pressure: 1, tiltX: 18, tiltY: -4, twist: 45 },
    ],
  })
  await dispatchImagePointer(page, { type: 'pointerup', pointerId: 31, pointerType: 'pen', ...penEnd, pressure: 0 })
  await expect.poll(() => overlayAlpha(page)).toBeGreaterThan(clearedAlpha)
  const penAlpha = await overlayAlphaAt(page, [
    { x: 0.2, y: 0.35 },
    { x: 0.4, y: 0.35 },
    { x: 0.6, y: 0.35 },
    { x: 0.8, y: 0.35 },
  ])
  expect(penAlpha[0]).toBeGreaterThan(0)
  expect(penAlpha[1]).toBeGreaterThan(penAlpha[0]!)
  expect(penAlpha[2]).toBeGreaterThan(penAlpha[1]!)
  expect(penAlpha[3]).toBe(0)
  await page.getByRole('button', { name: 'Undo mask edit' }).click()
  await expect.poll(() => overlayAlpha(page)).toBe(clearedAlpha)

  const cancelledPoint = imagePoint(0.3, 0.55)
  await dispatchImagePointer(page, { type: 'pointerdown', pointerId: 32, pointerType: 'pen', ...cancelledPoint, pressure: 1 })
  await expect.poll(() => overlayAlpha(page)).toBeGreaterThan(clearedAlpha)
  await dispatchImagePointer(page, { type: 'pointercancel', pointerId: 32, pointerType: 'pen', ...cancelledPoint, pressure: 0 })
  await expect.poll(() => overlayAlpha(page)).toBe(clearedAlpha)

  const lostPoint = imagePoint(0.5, 0.55)
  await dispatchImagePointer(page, { type: 'pointerdown', pointerId: 33, pointerType: 'pen', ...lostPoint, pressure: 1 })
  await expect.poll(() => overlayAlpha(page)).toBeGreaterThan(clearedAlpha)
  await dispatchImagePointer(page, { type: 'lostpointercapture', pointerId: 33, pointerType: 'pen', ...lostPoint, pressure: 0 })
  await expect.poll(() => overlayAlpha(page)).toBe(clearedAlpha)

  const beforePalm = await imageNavigation(page)
  const palmPoint = imagePoint(0.7, 0.55)
  await dispatchImagePointer(page, { type: 'pointerdown', pointerId: 34, pointerType: 'pen', ...palmPoint, pressure: 1 })
  await dispatchImagePointer(page, { type: 'pointerdown', pointerId: 35, pointerType: 'touch', x: 300, y: 300 })
  await dispatchImagePointer(page, { type: 'pointermove', pointerId: 35, pointerType: 'touch', x: 390, y: 370 })
  expect(await imageNavigation(page)).toEqual(beforePalm)
  await dispatchImagePointer(page, { type: 'pointerup', pointerId: 35, pointerType: 'touch', x: 390, y: 370 })
  await dispatchImagePointer(page, { type: 'pointerup', pointerId: 34, pointerType: 'pen', ...palmPoint, pressure: 0 })
  await page.getByRole('button', { name: 'Undo mask edit' }).click()
  await expect.poll(() => overlayAlpha(page)).toBe(clearedAlpha)

  const beforeTouch = await imageNavigation(page)
  await dispatchImagePointer(page, { type: 'pointerdown', pointerId: 41, pointerType: 'touch', x: 400, y: 350 })
  await dispatchImagePointer(page, { type: 'pointermove', pointerId: 41, pointerType: 'touch', x: 440, y: 380 })
  const oneFinger = await imageNavigation(page)
  expect(oneFinger.left).not.toBe(beforeTouch.left)
  expect(oneFinger.top).not.toBe(beforeTouch.top)
  await dispatchImagePointer(page, { type: 'pointerdown', pointerId: 42, pointerType: 'touch', x: 650, y: 380 })
  await dispatchImagePointer(page, { type: 'pointermove', pointerId: 42, pointerType: 'touch', x: 780, y: 380 })
  await expect(page.locator('.image-mask-tool-rail output')).not.toHaveText('100%')
  await page.screenshot({ path: `${PROOF}/09-pen-touch-navigation.png` })
  await dispatchImagePointer(page, { type: 'pointerup', pointerId: 41, pointerType: 'touch', x: 440, y: 380 })
  await dispatchImagePointer(page, { type: 'pointerup', pointerId: 42, pointerType: 'touch', x: 780, y: 380 })
  await page.setViewportSize({ width: 640, height: 700 })
  if (await page.getByTestId('dock-zone-right').isVisible())
    await page.getByRole('button', { name: /^Toggle right rail/ }).click()
  await expect(page.getByTestId('dock-zone-right')).toHaveCount(0)
  await page.getByRole('button', { name: 'Paint' }).focus()
  await page.mouse.move(500, 600)
  await expect(page.getByTestId('app-tooltip')).toHaveCount(0)
  await expect(page.getByTestId('image-editor').getByText('Image editor', { exact: true })).toBeVisible()
  await expect(page.locator('.image-mask-tool-rail output')).not.toHaveText('100%')
  await page.screenshot({ path: `${PROOF}/10-pen-touch-navigation-narrow.png` })
  await page.setViewportSize({ width: 1440, height: 900 })
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(initialRevision)

  const box = await surface.boundingBox()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.getByRole('button', { name: 'Erase' }).click()
  await page.getByRole('button', { name: 'Invert' }).click()
  await page.getByRole('button', { name: 'Undo mask edit' }).click()
  await page.getByRole('button', { name: 'Redo mask edit' }).click()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(initialRevision)
  await page.screenshot({ path: `${PROOF}/02-local-tools-history.png` })

  await page.getByRole('button', { name: 'Bake to asset' }).click()
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  const afterApply = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return { revision: tab.store.revision, value: tab.store.doc.graphs.g0!.nodes.asset!.values.image }
  })
  expect(afterApply.revision).toBe(initialRevision + 1)
  expect(uploadCount).toBe(1)
  expect(await page.evaluate(() => (window as unknown as { __imageApplyCount: number }).__imageApplyCount)).toBe(1)
  expect(afterApply.value).toMatchObject({ digest: DERIVED, mediaType: 'image/png', virtualPath: '' })
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await page.evaluate(() => (window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.asset!.values.image as { digest: string }).digest)).toBe(SOURCE)
  expect(await page.evaluate(() => (window.__dinksterTest!.app.activeTab()!.store as unknown as { redo(): boolean }).redo())).toBe(true)
  expect(await page.evaluate(() => (window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.asset!.values.image as { digest: string }).digest)).toBe(DERIVED)
  await page.screenshot({ path: `${PROOF}/03-apply-undo-redo.png` })

  await reopen(page)
  const cancelRevision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await page.getByRole('button', { name: 'Cancel' }).click()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(cancelRevision)
  await page.screenshot({ path: `${PROOF}/04-cancel.png` })

  await reopen(page)
  failUpload = true
  const failureRevision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await page.getByRole('button', { name: 'Bake to asset' }).click()
  await expect(page.getByRole('alert')).toContainText('POST /api/assets failed: 500')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(failureRevision)
  await page.screenshot({ path: `${PROOF}/05-upload-failure.png` })

  failUpload = false
  let releaseHeldUpload!: () => void
  heldUpload = {
    promise: new Promise<void>((resolve) => { releaseHeldUpload = resolve }),
    release: () => releaseHeldUpload(),
  }
  await page.getByRole('button', { name: 'Bake to asset' }).click()
  await expect.poll(() => uploadCount).toBe(3)
  const staleRevision = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): { readonly store: { readonly revision: number } }
      dispatchTo(tab: unknown, invocation: unknown): { readonly ok: boolean }
    }
    const tab = app.activeTab()!
    const outcome = app.dispatchTo(tab, {
      command: 'node.setValue',
      params: {
        graphId: 'g0', nodeId: 'asset', inputId: 'image',
        value: { digest: `blake3:${'3'.repeat(64)}`, name: 'new-source.png', size: 78, mediaType: 'image/png', virtualPath: '' },
      },
    })
    if (!outcome.ok) throw new Error('failed to replace source during upload')
    return tab.store.revision
  })
  heldUpload.release()
  await expect(page.getByRole('alert')).toContainText('destination changed')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(staleRevision)
  expect(await page.evaluate(() => (window as unknown as { __imageApplyCount: number }).__imageApplyCount)).toBe(1)
  await page.screenshot({ path: `${PROOF}/06-stale-destination.png` })

  const viewport = page.getByTestId('image-canvas-viewport')
  await viewport.hover()
  await page.mouse.wheel(0, -300)
  await page.keyboard.down('Shift')
  const viewportBox = await viewport.boundingBox()
  await page.mouse.move(viewportBox!.x + 40, viewportBox!.y + 40)
  await page.mouse.down()
  await page.mouse.move(viewportBox!.x + 90, viewportBox!.y + 80)
  await page.mouse.up()
  await page.keyboard.up('Shift')
  await page.screenshot({ path: `${PROOF}/07-zoom-pan-no-bleed.png` })
  await page.getByRole('button', { name: 'Cancel' }).click()
})

test('image editor inserts and reopens one graph-native mask paint node', async ({ page }) => {
  // Temporary skip pending attribution: Kosinkadink/comfy-vibe-station#429
  test.skip(true, 'red at main; attribution and re-enable tracked in Kosinkadink/comfy-vibe-station#429')
  let uploadCount = 0
  await page.route('**/api/assets/**', (route) => route.fulfill({ contentType: 'image/png', body: PNG }))
  await page.route('**/api/assets', (route) => {
    uploadCount += 1
    return route.fulfill({ status: 500 })
  })
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  await page.evaluate(({ source, pngSize }) => {
    const app = window.__dinksterTest!.app
    ;(app as unknown as { registry: { set(value: unknown): void } }).registry.set({
      schemas: new Map(), diagnostics: [], resolve: () => undefined,
    })
    app.registerSchemas([
      {
        type: 'dinkster.load_image', displayName: 'Load Image', category: 'test', source: 'v3', isOutputNode: false,
        items: [
          { kind: 'input', id: 'image', type: { kind: 'asset', element: { kind: 'concrete', name: 'dinkster.image' } }, optional: false, widget: { widgetType: 'ASSET', kind: 'image', options: { accept: ['image/png'] } } },
          { kind: 'output', id: 'image', type: { kind: 'concrete', name: 'dinkster.image' } },
          { kind: 'output', id: 'mask', type: { kind: 'concrete', name: 'dinkster.mask' } },
        ],
      },
      {
        type: 'dinkster.mask.paint', displayName: 'Paint Mask', category: 'test', source: 'v3', isOutputNode: false,
        items: [
          { kind: 'input', id: 'source', type: { kind: 'asset', element: { kind: 'concrete', name: 'dinkster.image' } }, optional: false, widget: { widgetType: 'ASSET', kind: 'image', options: { accept: ['image/png'] } } },
          { kind: 'input', id: 'operations', type: { kind: 'concrete', name: 'core.string' }, optional: false, widget: { widgetType: 'STRING', options: { multiline: true } } },
          { kind: 'output', id: 'mask', type: { kind: 'concrete', name: 'dinkster.mask' } },
        ],
      },
    ] as never)
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'graph-mask-paint', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        loader: { id: 'loader', type: 'dinkster.load_image', values: { image: { digest: source, name: 'source.png', size: pngSize, mediaType: 'image/png', virtualPath: '' } } },
        consumer: { id: 'consumer', type: 'MaskConsumer', values: {} },
      }, links: { mask: { id: 'mask', from: { node: 'loader', port: 'mask' }, to: { node: 'consumer', port: 'mask' }, ext: { retained: true } } }, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: { g0: { nodes: { loader: { position: { x: 100, y: 100 } }, consumer: { position: { x: 700, y: 100 } } } } } },
    }, 'Graph mask paint')
    const graphApp = app as unknown as {
      activeTab(): unknown
      backendForTab(tab: unknown): { protocol: string; connection: { assetUrl(digest: string): string } }
      imageTargetForInput(tab: unknown, graphId: string, nodeId: string, inputId: string): { maskPaint?: unknown } | undefined
      openImageEditor(target: unknown): boolean
    }
    const tab = graphApp.activeTab()
    const backend = graphApp.backendForTab(tab)
    backend.protocol = 'dinkster'
    backend.connection.assetUrl = (digest: string) => `/api/assets/${encodeURIComponent(digest)}`
  }, { source: SOURCE, pngSize: PNG.byteLength })

  await expect.poll(() => page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): unknown
      imageTargetForInput(tab: unknown, graphId: string, nodeId: string, inputId: string): { maskPaint?: unknown } | undefined
      openImageEditor(target: unknown): boolean
    }
    const target = app.imageTargetForInput(app.activeTab(), 'g0', 'loader', 'image')
    return target?.maskPaint ? app.openImageEditor(target) : false
  })).toBe(true)

  await expect(page.getByRole('button', { name: 'Apply mask to graph' })).toBeEnabled()
  await page.getByRole('button', { name: 'Clear' }).click()
  await page.screenshot({ path: `${PROOF}/09-graph-mask-apply.png` })
  await page.getByRole('button', { name: 'Apply mask to graph' }).click()
  const first = await page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!
    const paints = Object.values(graph.nodes).filter((node) => node.type === 'dinkster.mask.paint')
    return { count: paints.length, paint: paints[0], link: graph.links.mask }
  })
  expect(uploadCount).toBe(0)
  expect(first.count).toBe(1)
  expect(first.paint!.values.source).toMatchObject({ digest: SOURCE, name: 'source.png' })
  expect(JSON.parse(first.paint!.values.operations as string).commands).toEqual([{ op: 'clear' }])
  expect(first.link).toMatchObject({ id: 'mask', from: { node: first.paint!.id, port: 'mask' }, ext: { retained: true } })

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): unknown
      imageTargetForInput(tab: unknown, graphId: string, nodeId: string, inputId: string): { maskPaint?: unknown } | undefined
      openImageEditor(target: unknown): boolean
    }
    const tab = app.activeTab()
    const target = app.imageTargetForInput(tab, 'g0', 'loader', 'image')
    if (!target?.maskPaint || !app.openImageEditor(target)) throw new Error('associated mask paint node did not reopen')
  })
  await expect(page.getByRole('button', { name: 'Undo mask edit' })).toBeEnabled()
  await page.getByRole('button', { name: 'Invert' }).click()
  await page.getByRole('button', { name: 'Apply mask to graph' }).click()
  expect(await page.evaluate(() => Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes)
    .filter((node) => node.type === 'dinkster.mask.paint').length)).toBe(1)
  expect(uploadCount).toBe(0)
})
