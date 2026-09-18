import { expect, selectProductOption, test, type Page } from './fixtures.js'

test.use({ hasTouch: true })

interface AssetValue {
  digest: string
  name: string
  size: number
  mediaType: string
  virtualPath: string
}

const validPng = (): Buffer => Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

const value = (page: Page): Promise<AssetValue | null> => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.asset!.values.image as AssetValue | null)

/**
 * Asset routes exist only on a NATIVE Dinkster backend, not on the ComfyUI
 * backend the rest of the suite requires. The suite must stay runnable
 * without one, so upload tests skip loudly when no native server answers.
 */
const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

const widgetRowPoint = (page: Page): Promise<{ x: number; y: number }> =>
  page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'asset')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'image')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  })

async function openAsset(page: Page): Promise<void> {
  // A native dialog restores focus on a browser task after teardown. Wait for
  // that lifecycle and reset the canvas opener before another row gesture.
  await expect(page.getByTestId('widget-modal-surface')).toHaveCount(0)
  await page.getByTestId('graph-canvas').focus()
  const point = await widgetRowPoint(page)
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('asset-editor')).toBeVisible()
}

async function targetNativeBackend(page: Page): Promise<void> {
  const alreadyNative = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()
    return tab !== undefined &&
      (app as unknown as { backendForTab(tab: unknown): { protocol: string } }).backendForTab(tab).protocol === 'dinkster'
  })
  if (!alreadyNative) {
    await page.getByTestId('backends-toggle').click()
    await page.getByTestId('backend-url-input').fill(NATIVE_BACKEND)
    await page.getByTestId('backend-add').click()
    await expect(page.getByTestId('tab-target')).toBeVisible()
    await selectProductOption(page, page.getByTestId('tab-target'), NATIVE_BACKEND)
  }
  // The native-only harness already targets its sole same-origin backend, so
  // multi-backend target chrome is intentionally absent in that environment.
  await expect.poll(() => page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()
    return tab === undefined
      ? undefined
      : (app as unknown as { backendForTab(tab: unknown): { protocol: string } }).backendForTab(tab).protocol
  })).toBe('dinkster')
  // Protocol changes replace backend-discovered schemas. Restore this
  // synthetic fixture only after the native connection has finished syncing.
  await page.evaluate(() => {
    window.__dinksterTest!.app.registerSchemas([{
      type: 'AssetWidgetTest', displayName: 'Asset Widget', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'ASSET' }, optional: false,
        widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: null } }],
    }])
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'asset')?.layout.rows.some((item) => item.kind === 'widget' && item.inputId === 'image'))).toBe(true)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(() => {
    window.__dinksterTest!.app.registerSchemas([{
      type: 'AssetWidgetTest', displayName: 'Asset Widget', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'ASSET' }, optional: false,
        widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: null } }],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'asset-widget', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { asset: { id: 'asset', type: 'AssetWidgetTest', values: { image: { digest: `blake3:${'b'.repeat(64)}`, name: 'old.png', size: 3, mediaType: 'image/png', virtualPath: '' } } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { asset: { position: { x: 100, y: 100 } } } } } },
    }, 'Asset Widget')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
})

test('overlay opens and cancel preserves the old asset', async ({ page }) => {
  const before = await value(page)
  await openAsset(page)
  await page.getByTestId('asset-editor').getByRole('button', { name: 'cancel' }).click()
  await expect(page.getByTestId('asset-editor')).not.toBeVisible()
  expect(await value(page)).toEqual(before)
})

test('asset editing uses the product modal with focus, close, touchscreen, and narrow viewport containment', async ({ page }) => {
  const railToggle = page.getByTestId('rail-toggle')
  if (await railToggle.getAttribute('aria-pressed') === 'true') await railToggle.click()
  await openAsset(page)
  const dialog = page.getByRole('dialog', { name: 'Edit image asset' })
  const editor = page.getByTestId('asset-editor')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-describedby', 'widget-editor-description')
  await expect(editor.getByTestId('asset-schema-metadata')).toContainText('Single asset')
  await expect(editor.getByTestId('asset-schema-metadata')).toContainText('image/png')
  await expect(editor.getByTestId('widget-editor-resize-handle')).toHaveCount(0)

  await expect.poll(() => page.evaluate(() => {
    const modal = document.querySelector('dialog[data-modal="widget-asset"]')
    return modal !== null && modal.contains(document.activeElement)
  })).toBe(true)
  await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="rail-toggle"]')?.focus())
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).not.toBe('rail-toggle')

  // Header pointer movement cannot drag a modal. The inner surface has no
  // drag handlers and the native dialog remains in the same top-layer box.
  const header = dialog.locator('.dock-header')
  const headerBox = await header.boundingBox()
  const wideBounds = await dialog.boundingBox()
  await page.mouse.move(headerBox!.x + 10, headerBox!.y + 10)
  await page.mouse.down()
  await page.mouse.move(headerBox!.x + 80, headerBox!.y + 40)
  await page.mouse.up()
  expect(await dialog.boundingBox()).toEqual(wideBounds)

  await page.setViewportSize({ width: 360, height: 300 })
  const bounds = await dialog.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(300)
  expect(await editor.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto')

  // A real touch-capable Playwright context reaches the ordinary close control.
  const close = page.getByRole('button', { name: 'Close image asset editor' })
  const closeBounds = await close.boundingBox()
  await page.touchscreen.tap(
    closeBounds!.x + closeBounds!.width / 2,
    closeBounds!.y + closeBounds!.height / 2,
  )
  await expect(dialog).not.toBeVisible()
  await expect(page.getByTestId('graph-canvas')).toBeFocused()

  // Restore enough canvas room to reach the row, then return to the narrow
  // viewport to prove native Escape follows the same constrained layout.
  await page.setViewportSize({ width: 1440, height: 900 })
  await openAsset(page)
  await page.setViewportSize({ width: 360, height: 300 })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('widget-modal-surface')).not.toBeVisible()
  await expect(page.getByTestId('graph-canvas')).toBeFocused()
})

test('clear stages an empty selection and Apply commits null', async ({ page }) => {
  await openAsset(page)
  await page.getByTestId('asset-editor').getByTestId('asset-selection-remove').click()
  // Clear only stages: the editor stays open until Apply commits.
  await expect(page.getByTestId('asset-editor')).toBeVisible()
  await page.getByTestId('asset-apply').click()
  await expect(page.getByTestId('asset-editor')).not.toBeVisible()
  expect(await value(page)).toBeNull()
})

test.describe('native asset uploads', () => {
  test.beforeEach(async () => {
    try {
      const probe = await fetch(`${NATIVE_BACKEND}/api/library?scope=local`, { signal: AbortSignal.timeout(2000) })
      test.skip(!probe.ok, `native Dinkster backend at ${NATIVE_BACKEND} did not serve /api/library`)
    } catch {
      test.skip(true, `no native Dinkster backend reachable at ${NATIVE_BACKEND} (set DINKSTER_NATIVE_BACKEND)`)
    }
  })

  test('upload commits the stored asset and its bytes are retrievable', async ({ page, request }) => {
    await targetNativeBackend(page)
    await openAsset(page)
    const png = validPng()
    await page.getByTestId('asset-editor').locator('input[type=file]').setInputFiles({
      name: 'tiny.png',
      mimeType: 'image/png',
      buffer: png,
    })

    const editor = page.getByTestId('asset-editor')
    await expect(editor).toBeVisible()
    await expect(editor.getByTestId('asset-upload-trigger')).toBeFocused()
    await editor.getByTestId('asset-apply').click()
    await expect(editor).not.toBeVisible()
    const stored = await value(page)
    expect(stored).not.toBeNull()
    if (stored === null) throw new Error('asset upload committed null')
    expect(stored).toMatchObject({ name: 'tiny.png', size: png.length, mediaType: 'image/png' })
    expect(stored.digest).toMatch(/^blake3:[0-9a-f]{64}$/)
    const fetched = await request.get(`${NATIVE_BACKEND}/api/assets/${encodeURIComponent(stored.digest)}`)
    expect(fetched.ok()).toBe(true)
    expect(await fetched.body()).toEqual(png)
  })

  test('a schema-declared kind fixes picker scope with no All kinds escape', async ({ page }) => {
    await targetNativeBackend(page)
    // Re-register with a declared semantic kind, as the wire decoder emits it:
    // top-level WidgetSpec.kind, never options.kind.
    await page.evaluate(() => {
      window.__dinksterTest!.app.registerSchemas([{
        type: 'AssetWidgetTest', displayName: 'Asset Widget', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'ASSET' }, optional: false,
          widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: null, kind: 'media/image' } }],
      }])
    })
    await openAsset(page)
    const editor = page.getByTestId('asset-editor')
    await expect(editor.getByTestId('asset-schema-metadata')).toContainText('media/image')
    await expect(editor.getByTestId('collection-filter-kind')).toHaveCount(0)
    // Source facets change provenance, not the schema-declared kind.
    await editor.getByTestId('collection-source-select').click()
    const sources = page.getByRole('listbox', { name: 'Source', exact: true })
    await expect(sources.getByRole('option', { name: 'All assets', exact: true })).toBeVisible()
    await expect(sources.getByRole('option').filter({ hasNotText: /^(All assets|Imported|Generated)$/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test('failed upload surfaces the error and preserves the old asset', async ({ page }) => {
    await targetNativeBackend(page)
    const before = await value(page)
    await openAsset(page)
    await page.route('**/api/assets/media*', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 500, body: 'injected asset failure' })
      } else {
        await route.continue()
      }
    })
    await page.getByTestId('asset-editor').locator('input[type=file]').setInputFiles({
      name: 'tiny.png',
      mimeType: 'image/png',
      buffer: validPng(),
    })

    await expect(page.getByTestId('asset-editor')).toContainText('POST /api/assets/media failed: 500')
    expect(await value(page)).toEqual(before)
  })

  test('a failed upload stops a multi-file batch: later files never upload, the error stays', async ({ page }) => {
    await targetNativeBackend(page)
    // Multi-select declaration so the file input accepts a batch.
    await page.evaluate(() => {
      window.__dinksterTest!.app.registerSchemas([{
        type: 'AssetWidgetTest', displayName: 'Asset Widget', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'image',
          type: { kind: 'list', element: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.IMAGE' } } },
          optional: false,
          widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: null } }],
      }])
      // The shared fixture's stored value predates virtualPath and cannot
      // restore as staging; seed a complete AssetRef so the chip-count
      // assertions below distinguish "batch stopped" from "nothing staged".
      const tab = window.__dinksterTest!.app.activeTab()!
      ;(tab.store as unknown as {
        dispatch(invocation: { command: string; params: unknown }): { ok: boolean }
      }).dispatch({
        command: 'node.setValue',
        params: { graphId: 'g0', nodeId: 'asset', inputId: 'image', value: { digest: `blake3:${'b'.repeat(64)}`, name: 'old.png', size: 3, mediaType: 'image/png', virtualPath: '' } },
      })
    })
    await openAsset(page)
    const editor = page.getByTestId('asset-editor')
    // The stored scalar restores as one staged chip.
    await expect(editor.getByTestId('asset-chip')).toHaveCount(1)
    let posts = 0
    await page.route('**/api/assets/media*', async (route) => {
      if (route.request().method() === 'POST') {
        posts++
        await route.fulfill({ status: 500, body: 'injected asset failure' })
      } else {
        await route.continue()
      }
    })
    const png = { mimeType: 'image/png', buffer: validPng() }
    await editor.locator('input[type=file]').setInputFiles([
      { ...png, name: 'first.png' },
      { ...png, name: 'second.png' },
    ])
    await expect(editor).toContainText('POST /api/assets/media failed: 500')
    // Wait for the whole batch to SETTLE (the upload trigger re-enables) before
    // counting POSTs: a regressed loop could start the second request just
    // after the error renders.
    await expect(editor.getByTestId('asset-upload-trigger')).toBeEnabled()
    // The batch stopped at the first failure: the second file was never
    // POSTed and nothing joined the staged selection.
    expect(posts).toBe(1)
    await expect(editor.getByTestId('asset-chip')).toHaveCount(1)
    // The batch settled, so Cancel (and Escape) work again.
    await editor.getByRole('button', { name: 'cancel' }).click()
    await expect(editor).not.toBeVisible()
  })

  test('a pending upload blocks dismissal: Escape and outside clicks refuse until the batch settles', async ({ page }) => {
    await targetNativeBackend(page)
    await openAsset(page)
    const editor = page.getByTestId('asset-editor')
    let posts = 0
    let releaseFirst: (() => void) | undefined
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve })
    await page.route('**/api/assets/media*', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      posts++
      // Hold the first POST open so the editor is observably mid-batch.
      if (posts === 1) await firstHeld
      await route.fulfill({ status: 500, body: 'injected asset failure' })
    })
    await editor.locator('input[type=file]').setInputFiles({
      name: 'held.png',
      mimeType: 'image/png',
      buffer: validPng(),
    })
    // Mid-batch: the busy label shows and the upload trigger is disabled
    // (Cancel stays ENABLED as the abort escape hatch - proven separately).
    await expect(editor).toContainText('Uploading')
    await expect(editor.getByTestId('asset-upload-trigger')).toBeDisabled()
    // The host's window-capture Escape must refuse the close (the guard
    // lives in CanvasHost, which sees the key BEFORE any editor handler).
    await page.keyboard.press('Escape')
    await expect(editor).toBeVisible()
    // An outside click must refuse too (no dismiss gesture starts).
    const canvas = await page.getByTestId('graph-canvas').boundingBox()
    if (canvas === null) throw new Error('graph canvas has no bounding box')
    await page.mouse.click(canvas.x + canvas.width - 10, canvas.y + canvas.height - 10)
    await expect(editor).toBeVisible()
    // An outside target with its OWN activation must be swallowed as well:
    // clicking the widget row would normally REPLACE the editor with a
    // fresh mount, whose reset busy state would let the orphaned batch
    // keep uploading. The lock keeps the ORIGINAL mount (still uploading).
    const row = await widgetRowPoint(page)
    await page.mouse.click(row.x, row.y)
    await expect(editor).toBeVisible()
    await expect(editor).toContainText('Uploading')
    await expect(editor.getByTestId('asset-upload-trigger')).toBeDisabled()
    // Outside-focused KEYBOARD shortcuts must be swallowed too: with focus
    // on the body, plain 'd' toggles the data lens, which rebuilds the
    // scene and would close the blocked mount from behind.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('d')
    await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-lens', 'standard')
    await expect(editor).toBeVisible()
    // Tab is not just eaten: a keyboard-only user whose focus dropped to the
    // body (the upload trigger disables when the batch starts) is pulled back
    // INTO the blocked editor, where the enabled Cancel control lives.
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() =>
      document.activeElement?.closest('[data-testid=asset-editor]') !== null,
    )).toBe(true)
    // Middle-click activation (auxclick) is swallowed as well: middle-
    // clicking the workflow tab would otherwise CLOSE the tab under the
    // uploading editor.
    const tabCount = await page.getByTestId('tab-bar').locator('.tab').count()
    const tab = await page.getByTestId('tab-bar').locator('.tab').first().boundingBox()
    if (tab === null) throw new Error('tab strip has no tab')
    await page.mouse.click(tab.x + tab.width / 2, tab.y + tab.height / 2, { button: 'middle' })
    await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(tabCount)
    await expect(editor).toBeVisible()
    // Release the held POST as a failure and let the batch settle.
    releaseFirst!()
    await expect(editor).toContainText('POST /api/assets/media failed: 500')
    await expect(editor.getByTestId('asset-upload-trigger')).toBeEnabled()
    expect(posts).toBe(1)
    // The block lifted: Escape closes the editor again.
    await page.keyboard.press('Escape')
    await expect(editor).not.toBeVisible()
  })

  test('Cancel during a pending upload aborts the batch and closes without committing', async ({ page }) => {
    await targetNativeBackend(page)
    const before = await value(page)
    await openAsset(page)
    const editor = page.getByTestId('asset-editor')
    // Hold the POST open FOREVER: a server that never answers must not
    // leave the dismissal-locked editor without a recovery path.
    await page.route('**/api/assets/media*', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      // Never fulfilled: the abort on the page side settles the fetch.
      await new Promise(() => undefined)
    })
    await editor.locator('input[type=file]').setInputFiles({
      name: 'stalled.png',
      mimeType: 'image/png',
      buffer: validPng(),
    })
    await expect(editor).toContainText('Uploading')
    // Cancel is the lock's escape hatch: enabled mid-batch, aborts, closes.
    // Prove the fetch is genuinely ABORTED (not merely ignored): the held
    // request must fail page-side when Cancel fires.
    const aborted = page.waitForEvent('requestfailed', (request) =>
      new URL(request.url()).pathname === '/api/assets/media' && request.method() === 'POST')
    // Keyboard-only route: focus dropped to the body when the upload trigger
    // disabled; the firewall's Tab pull-in reaches Cancel without a pointer.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Tab')
    let reachedCancel = false
    for (let presses = 0; presses < 30; presses++) {
      const onCancel = await page.evaluate(() => {
        const active = document.activeElement
        return active?.closest('[data-testid=asset-editor]') !== null &&
          active instanceof HTMLButtonElement && active.textContent?.trim().toLowerCase() === 'cancel'
      })
      if (onCancel) {
        reachedCancel = true
        break
      }
      await page.keyboard.press('Tab')
    }
    expect(reachedCancel).toBe(true)
    await page.keyboard.press('Enter')
    await expect(editor).not.toBeVisible()
    await aborted
    // Nothing committed: the stored value survives the aborted upload.
    expect(await value(page)).toEqual(before)
  })

  test('a pending upload refuses staging and disables Apply', async ({ page }) => {
    // A pickable browse row mid-upload: mock the mount surface so a row
    // exists, keep the native backend for everything else. Without the
    // guard a pick could stage and Apply could commit AND CLOSE, orphaning
    // the held POST.
    await page.route('**/api/mounts**', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/mounts') {
        await route.fulfill({ json: { mounts: [{ id: 'input', mode: 'read', state: 'ready' }] } })
      } else if (url.pathname.match(/^\/api\/mounts\/[^/]+\/entries$/)) {
        await route.fulfill({ json: { entries: [
          { virtualPath: 'photos/sunset.png', name: 'sunset.png', digest: `blake3:${'7'.repeat(64)}`, size: 2048, mediaType: 'image/png', kind: 'media/image' },
        ], total: 1 } })
      } else {
        await route.fulfill({ status: 404 })
      }
    })
    await targetNativeBackend(page)
    const before = await value(page)
    await openAsset(page)
    const editor = page.getByTestId('asset-editor')
    await expect(editor.getByRole('option', { name: /sunset\.png/ })).toBeVisible()
    let releaseHeld: (() => void) | undefined
    const held = new Promise<void>((resolve) => { releaseHeld = resolve })
    await page.route('**/api/assets/media*', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      await held
      await route.fulfill({ status: 500, body: 'injected asset failure' })
    })
    await editor.locator('input[type=file]').setInputFiles({
      name: 'held.png',
      mimeType: 'image/png',
      buffer: validPng(),
    })
    await expect(editor).toContainText('Uploading')
    // Clicking a pickable row mid-batch must NOT stage, and Apply is
    // disabled, so nothing can commit while the POST is held.
    await editor.getByRole('option', { name: /sunset\.png/ }).click()
    await expect(editor).toBeVisible()
    await expect(editor).toContainText('Uploading')
    await expect(editor.getByTestId('asset-selection-summary')).not.toContainText('sunset.png')
    await expect(editor.getByTestId('asset-apply')).toBeDisabled()
    expect(await value(page)).toEqual(before)
    // Settle the batch; picking works again and commits normally.
    releaseHeld!()
    await expect(editor).toContainText('POST /api/assets/media failed: 500')
    await expect(editor.getByTestId('asset-upload-trigger')).toBeEnabled()
    await editor.getByRole('option', { name: /sunset\.png/ }).click()
    await editor.getByTestId('asset-apply').click()
    await expect(editor).not.toBeVisible()
    expect((await value(page)) as { name?: string } | null).toMatchObject({ name: 'sunset.png' })
  })
})

// Multi-select (typed-assets joint pin (5)): a list-of-asset declaration
// (list<asset<T>> / list<dinkster.asset>) stages N picks and commits ONE array;
// every other declaration keeps the single-pick commit-and-close flow (the
// scalar-merge arm stays deferred until the wire exposes merge providers).
test.describe('multi-select on list-of-asset declarations', () => {
  const ref = (n: number) => ({
    digest: `blake3:${String(n).repeat(64)}`, name: `img${n}.png`, size: 3, mediaType: 'image/png', virtualPath: '',
  })

  test.beforeEach(async ({ page }) => {
    await page.evaluate(() => {
      window.__dinksterTest!.app.registerSchemas([{
        type: 'AssetWidgetTest', displayName: 'Asset Widget', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'image',
          type: { kind: 'list', element: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.IMAGE' } } },
          optional: false,
          widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: null } }],
      }])
    })
    await page.evaluate(([a, b]) => {
      const tab = window.__dinksterTest!.app.activeTab()!
      ;(tab.store as unknown as {
        dispatch(invocation: { command: string; params: unknown }): { ok: boolean }
      }).dispatch({
        command: 'node.setValue',
        params: { graphId: 'g0', nodeId: 'asset', inputId: 'image', value: [a, b] },
      })
    }, [ref(1), ref(2)] as const)
  })

  test('shows staged chips, deselects via chip remove, and Apply commits one array', async ({ page }) => {
    await openAsset(page)
    const editor = page.getByTestId('asset-editor')
    await expect(editor.getByTestId('asset-chip')).toHaveCount(2)
    await expect(editor.getByTestId('asset-chip').nth(0)).toContainText('img1.png')
    // Deselect the first via its labeled remove control.
    await editor.getByRole('button', { name: 'Remove img1.png' }).click()
    await expect(editor.getByTestId('asset-chip')).toHaveCount(1)
    // Staging is not a commit: the stored value is untouched until Apply.
    expect(await value(page)).toEqual([ref(1), ref(2)])
    await editor.getByTestId('asset-apply').click()
    await expect(editor).not.toBeVisible()
    expect(await value(page)).toEqual([ref(2)])
  })

  test('cancel discards staged deselections', async ({ page }) => {
    await openAsset(page)
    const editor = page.getByTestId('asset-editor')
    await editor.getByRole('button', { name: 'Remove img2.png' }).click()
    await editor.getByRole('button', { name: 'cancel' }).click()
    await expect(editor).not.toBeVisible()
    expect(await value(page)).toEqual([ref(1), ref(2)])
  })

  test('clear stages an empty selection: Cancel restores, Apply commits []', async ({ page }) => {
    await openAsset(page)
    const editor = page.getByTestId('asset-editor')
    await expect(editor.getByTestId('asset-chip')).toHaveCount(2)
    // Clear is staged under multi-select: the editor stays open and the
    // stored array is untouched until Apply (scalar keeps commit-and-close).
    await editor.getByTestId('asset-selection-remove').click()
    await expect(editor.getByTestId('asset-chip')).toHaveCount(0)
    await expect(editor).toBeVisible()
    expect(await value(page)).toEqual([ref(1), ref(2)])
    await editor.getByRole('button', { name: 'cancel' }).click()
    await expect(editor).not.toBeVisible()
    expect(await value(page)).toEqual([ref(1), ref(2)])
    // Clear then Apply commits the empty array.
    await openAsset(page)
    await editor.getByTestId('asset-selection-remove').click()
    await editor.getByTestId('asset-apply').click()
    await expect(editor).not.toBeVisible()
    expect(await value(page)).toEqual([])
  })

  test('reopening restores the committed selection as chips', async ({ page }) => {
    await openAsset(page)
    const editor = page.getByTestId('asset-editor')
    await editor.getByRole('button', { name: 'Remove img1.png' }).click()
    await editor.getByTestId('asset-apply').click()
    await expect(editor).not.toBeVisible()
    await openAsset(page)
    await expect(editor.getByTestId('asset-chip')).toHaveCount(1)
    await expect(editor.getByTestId('asset-chip')).toContainText('img2.png')
  })

  // The SCALAR MERGE arm (typed-assets pin (5) + mergeableTypes adoption): a
  // scalar concrete T whose atom is a mergeableTypes member multi-selects,
  // and an EMPTY staged selection commits null (unset) - never `[]`, which
  // on a scalar-T declaration would compile to raw junk the merge provider
  // rejects (zero batches). List-outer declarations keep the pinned `[]`
  // commit (covered above). Fixture-only today: no live backend binds an
  // ASSET widget to scalar plain T (backend binding policy, 72c0719).
  test.describe('scalar merge arm (mergeableTypes membership)', () => {
    test.beforeEach(async ({ page }) => {
      await page.evaluate(([a, b]) => {
        // The tab targets the first backend; graft mergeableTypes onto its
        // live registry (the wire would deliver this on a real v12+ server).
        const backend = window.__dinksterTest!.app.backends.get()[0]! as unknown as {
          registry: { get(): object | undefined; set(r: object): void }
        }
        const reg = backend.registry.get()
        if (!reg) throw new Error('no registry on the default backend')
        backend.registry.set({ ...reg, mergeableTypes: ['comfy.IMAGE'] })
        window.__dinksterTest!.app.registerSchemas([{
          type: 'AssetWidgetTest', displayName: 'Asset Widget', category: 'test', source: 'v3', isOutputNode: false,
          items: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'comfy.IMAGE' }, optional: false,
            widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: null } }],
        }])
        const tab = window.__dinksterTest!.app.activeTab()!
        ;(tab.store as unknown as {
          dispatch(invocation: { command: string; params: unknown }): { ok: boolean }
        }).dispatch({
          command: 'node.setValue',
          params: { graphId: 'g0', nodeId: 'asset', inputId: 'image', value: [a, b] },
        })
      }, [ref(1), ref(2)] as const)
    })

    test('a merger-member scalar T gets the multi-select UI and Apply commits the array', async ({ page }) => {
      await openAsset(page)
      const editor = page.getByTestId('asset-editor')
      await expect(editor.getByTestId('asset-chip')).toHaveCount(2)
      await editor.getByRole('button', { name: 'Remove img1.png' }).click()
      await editor.getByTestId('asset-apply').click()
      await expect(editor).not.toBeVisible()
      expect(await value(page)).toEqual([ref(2)])
    })

    test('clear then Apply commits null (unset), not []', async ({ page }) => {
      await openAsset(page)
      const editor = page.getByTestId('asset-editor')
      await expect(editor.getByTestId('asset-chip')).toHaveCount(2)
      await editor.getByTestId('asset-selection-remove').click()
      await expect(editor.getByTestId('asset-chip')).toHaveCount(0)
      await editor.getByTestId('asset-apply').click()
      await expect(editor).not.toBeVisible()
      expect(await value(page)).toBeNull()
    })
  })

  test('scalar asset declarations show no multi-select UI', async ({ page }) => {
    // The default beforeEach schema (concrete ASSET) governs here: re-register
    // it and confirm the editor keeps the single-pick surface.
    await page.evaluate(() => {
      window.__dinksterTest!.app.registerSchemas([{
        type: 'AssetWidgetTest', displayName: 'Asset Widget', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'ASSET' }, optional: false,
          widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: null } }],
      }])
      const tab = window.__dinksterTest!.app.activeTab()!
      ;(tab.store as unknown as {
        dispatch(invocation: { command: string; params: unknown }): { ok: boolean }
      }).dispatch({
        command: 'node.setValue',
        params: { graphId: 'g0', nodeId: 'asset', inputId: 'image', value: { digest: `blake3:${'b'.repeat(64)}`, name: 'old.png', size: 3, mediaType: 'image/png', virtualPath: '' } },
      })
    })
    await openAsset(page)
    const editor = page.getByTestId('asset-editor')
    await expect(editor).toBeVisible()
    // Apply exists for scalar picks too, but there are no multi-select chips.
    await expect(editor.getByTestId('asset-apply')).toBeVisible()
    await expect(editor.getByTestId('asset-chip')).toHaveCount(0)
  })
})
