import { expect, test, type Page } from '@playwright/test'

const catalog = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'audit-f7-proof', schemaWire: 1 },
  packs: {},
  nodes: {},
}

async function prepare(page: Page): Promise<void> {
  await page.route('/api/**', (route) => { throw new Error(`unexpected unmocked API request: ${route.request().url()}`) })
  await page.route('/api/settings', (route) => route.fulfill({ json: { categories: { granted: [], available: [] }, settings: {} } }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: catalog }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'proof' }, devices: [] } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('/api/composition', (route) => route.fulfill({ json: { packs: {} } }))
  await page.route('/api/mounts', (route) => route.fulfill({ json: { mounts: [] } }))
  await page.goto('/')
  await expect(page.getByTestId('settings-button')).toBeVisible()
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })
}

const tabClose = (page: Page, tabId: string) =>
  page.locator(`.tab[data-tab-id="${tabId}"]`).getByTestId('tab-close')

async function activeSnapshot(page: Page) {
  return page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return { id: tab.id, title: tab.title, revision: tab.store.revision, document: JSON.stringify(tab.store.doc) }
  })
}

async function openAssetEditor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'DialogSeamProof', displayName: 'Dialog seam proof', category: 'proof', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'images',
        type: { kind: 'list', element: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.IMAGE' } } },
        optional: false, widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: [] },
      }],
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'dialog-seam-proof', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { asset: { id: 'asset', type: 'DialogSeamProof', values: { images: [] } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { asset: { position: { x: 100, y: 100 } } } } } },
    }, 'Dialog seam proof')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'asset')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'images')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('asset-editor')).toBeVisible()
}

test('product close confirmation preserves every decision boundary and keyboard path', async ({ page }) => {
  await prepare(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    app.markTabDirty(app.activeTab()!.id)
  })
  const dirty = await activeSnapshot(page)
  const close = tabClose(page, dirty.id)
  const dialogName = `Close "${dirty.title}" and discard unsaved changes?`
  const dirtyGeometry = await page.locator(`.tab[data-tab-id="${dirty.id}"]`).evaluate((tab) => {
    const affordance = tab.querySelector('.tab-affordance')!.getBoundingClientRect()
    const dot = tab.querySelector('.tab-dirty')!.getBoundingClientRect()
    return { affordanceCenter: affordance.left + affordance.width / 2, dotCenter: dot.left + dot.width / 2 }
  })
  expect(dirtyGeometry.dotCenter).toBe(dirtyGeometry.affordanceCenter)

  await close.focus()
  await close.press('Enter')
  const dialog = page.getByRole('dialog', { name: dialogName, exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.dock-title')).toHaveText(`Close "${dirty.title}"?`)
  await expect(dialog.locator('.close-tab-confirm > p')).toHaveText(`Close "${dirty.title}" and discard unsaved changes?`)
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
  const confirm = dialog.getByRole('button', { name: 'Close and discard', exact: true })
  await expect(cancel).toBeFocused()
  for (const button of [cancel, confirm]) {
    expect(await button.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(32)
  }
  await expect(cancel).toHaveCSS('outline-style', 'solid')
  await cancel.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(close).toBeFocused()
  expect(await activeSnapshot(page)).toEqual(dirty)

  await close.press('Enter')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(close).toBeFocused()
  expect(await activeSnapshot(page)).toEqual(dirty)

  await close.click()
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('modal-close').click()
  await expect(dialog).toHaveCount(0)
  await expect(close).toBeFocused()
  expect(await activeSnapshot(page)).toEqual(dirty)

  await close.press('Enter')
  await expect(dialog).toBeVisible()
  await page.mouse.click(5, 5)
  await expect(dialog).toHaveCount(0)
  await expect(close).toBeFocused()
  expect(await activeSnapshot(page)).toEqual(dirty)

  await close.press('Enter')
  await expect(dialog).toBeVisible()
  await page.evaluate((id) => (window.__dinksterTest!.app as any).closeTab(id), dirty.id)
  await expect(dialog).toHaveCount(0)
  await expect(page.locator(`.tab[data-tab-id="${dirty.id}"]`)).toHaveCount(0)

  const confirmTarget = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const tab = app.createWorkflow()
    const original = app.requestCloseTab.bind(app)
    ;(window as unknown as { __closeRequests?: number }).__closeRequests = 0
    app.requestCloseTab = (id: string, decide: () => boolean) => {
      ;(window as unknown as { __closeRequests?: number }).__closeRequests!++
      return original(id, decide)
    }
    return { id: tab.id, title: tab.title }
  })
  await page.waitForFunction((tabId) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === tabId)
    return tab !== undefined && 'status' in tab.store
  }, confirmTarget.id)
  const confirmClose = tabClose(page, confirmTarget.id)
  await confirmClose.focus()
  await confirmClose.press('Enter')
  const confirmDialog = page.getByRole('dialog', {
    name: `Close "${confirmTarget.title}" and discard unsaved changes?`, exact: true,
  })
  await expect(confirmDialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await expect(confirmDialog).toHaveCount(0)
  await expect(page.locator(`.tab[data-tab-id="${confirmTarget.id}"]`)).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __closeRequests?: number }).__closeRequests)).toBe(1)

  const cleanId = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const tab = app.createWorkflow()
    return tab.id
  })
  await page.waitForFunction((tabId) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === tabId)
    return tab !== undefined && 'status' in tab.store
  }, cleanId)
  await page.evaluate((tabId) => (window.__dinksterTest!.app as any).markTabClean(tabId), cleanId)
  await tabClose(page, cleanId).click()
  await expect(page.locator(`.tab[data-tab-id="${cleanId}"]`)).toHaveCount(0)
  await expect(page.locator('dialog[data-modal="close-tab"]')).toHaveCount(0)
})

test('a pending close decision does not transfer to a same-id replacement document', async ({ page }) => {
  await prepare(page)
  const workflow = (title: string) => ({
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'replace-proof', root: 'g0',
    graphs: { g0: { id: 'g0', name: title, nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
    view: { graphs: { g0: { nodes: {} } } },
  })
  const first = await page.evaluate((doc) => {
    const app = window.__dinksterTest!.app as any
    app.openDocument(doc, 'Replace proof')
    const tab = app.activeTab()!
    return { id: tab.id, title: tab.title }
  }, workflow('original'))
  await page.waitForFunction((tabId) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === tabId)
    return tab !== undefined && 'status' in tab.store
  }, first.id)
  const close = tabClose(page, first.id)
  await close.focus()
  await close.press('Enter')
  const dialog = page.getByRole('dialog', { name: `Close "${first.title}" and discard unsaved changes?`, exact: true })
  await expect(dialog).toBeVisible()

  // An editor-kind switch replaces the Tab object but keeps the same
  // document session: the confirmation must survive it.
  await page.evaluate((tabId) => {
    ;(window.__dinksterTest!.app as any).setTabEditorKind(tabId, 'app')
  }, first.id)
  await expect(dialog).toBeVisible()

  await page.evaluate((doc) => {
    window.__dinksterTest!.app.openDocument(doc, 'Replacement document')
  }, workflow('replacement'))
  await expect(page.locator('dialog[data-modal="close-tab"]')).toHaveCount(0)
  const survivor = page.locator(`.tab[data-tab-id="${first.id}"]`)
  await expect(survivor).toHaveCount(1)
  await expect(survivor).toContainText('Replacement document')
})

test('native dialog hosts retain only browser modality while product CSS owns visible chrome', async ({ page }) => {
  await prepare(page)

  const searchTrigger = page.getByTestId('topbar-search')
  await searchTrigger.click()
  const search = page.getByRole('dialog', { name: 'Search Dinkster', exact: true })
  await expect(search).toBeVisible()
  const { backdrop, expectedBackdrop, ...dialogChrome } = await search.evaluate((element) => {
    const probe = document.createElement('div')
    probe.style.backgroundColor = 'color-mix(in srgb, var(--dinkster-surface-canvas) 72%, transparent)'
    document.body.append(probe)
    const expectedBackdrop = getComputedStyle(probe).backgroundColor
    probe.remove()
    return {
      tag: element.tagName,
      open: (element as HTMLDialogElement).open,
      border: getComputedStyle(element).borderTopWidth,
      margin: getComputedStyle(element).marginTop,
      background: getComputedStyle(element).backgroundColor,
      backdrop: getComputedStyle(element, '::backdrop').backgroundColor,
      expectedBackdrop,
    }
  })
  expect(dialogChrome).toEqual({ tag: 'DIALOG', open: true, border: '0px', margin: '0px', background: 'rgba(0, 0, 0, 0)' })
  expect(backdrop).toBe(expectedBackdrop)
  await search.evaluate((element) => element.addEventListener('cancel', () => {
    ;(window as unknown as { __searchCancelCount?: number }).__searchCancelCount =
      ((window as unknown as { __searchCancelCount?: number }).__searchCancelCount ?? 0) + 1
  }))
  await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="settings-button"]')!.focus())
  await expect(page.getByTestId('universal-search-input')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(search).toHaveCount(0)
  await expect(searchTrigger).toBeFocused()
  expect(await page.evaluate(() => (window as unknown as { __searchCancelCount?: number }).__searchCancelCount ?? 0)).toBe(1)

  await searchTrigger.click()
  await expect(search).toBeVisible()
  await page.mouse.click(5, 5)
  await expect(search).toHaveCount(0)
  await expect(searchTrigger).toBeFocused()

  await page.getByTestId('settings-button').click()
  const modal = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(modal).toBeVisible()
  const { expectedBorder, expectedBackground, expectedBackdrop: expectedModalBackdrop, ...modalChrome } = await modal.evaluate((element) => {
    const probe = document.createElement('div')
    probe.style.border = '1px solid var(--dinkster-border-strong)'
    probe.style.backgroundColor = 'var(--dinkster-surface-panel)'
    document.body.append(probe)
    const expectedBorder = getComputedStyle(probe).borderTop
    const expectedBackground = getComputedStyle(probe).backgroundColor
    probe.style.backgroundColor = 'color-mix(in srgb, var(--dinkster-surface-canvas) 72%, transparent)'
    const expectedBackdrop = getComputedStyle(probe).backgroundColor
    probe.remove()
    return {
      tag: element.tagName,
      open: (element as HTMLDialogElement).open,
      border: getComputedStyle(element).borderTop,
      padding: getComputedStyle(element).padding,
      background: getComputedStyle(element).backgroundColor,
      authoredMargin: Array.from(document.styleSheets)
        .flatMap((sheet) => Array.from(sheet.cssRules))
        .find((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText === '.modal-surface')
        ?.style.margin,
      backdrop: getComputedStyle(element, '::backdrop').backgroundColor,
      expectedBorder,
      expectedBackground,
      expectedBackdrop,
    }
  })
  expect(modalChrome).toEqual({
    tag: 'DIALOG', open: true, border: expectedBorder, padding: '0px',
    background: expectedBackground, authoredMargin: 'auto', backdrop: expectedModalBackdrop,
  })
  await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="rail-toggle"]')!.focus())
  await expect(modal.locator(':focus')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)

  let releaseUpload: (() => void) | undefined
  let uploadStarted = false
  await page.route('/api/assets/*', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: '' }))
  await page.route('/api/assets/media*', async (route) => {
    uploadStarted = true
    await new Promise<void>((resolve) => { releaseUpload = resolve })
    await route.fulfill({ status: 201, json: {
      asset: {
        digest: `blake3:${'a'.repeat(64)}`,
        name: 'held.png',
        size: 8,
        mediaType: 'image/png',
        virtualPath: '',
      },
      kind: 'media/image',
    } })
  })
  await openAssetEditor(page)
  const assetDialog = page.getByRole('dialog', { name: 'Edit images asset', exact: true })
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await assetDialog.locator('input[type=file]').setInputFiles({
    name: 'held.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
  })
  await expect.poll(() => uploadStarted).toBe(true)
  await expect(assetDialog.getByTestId('modal-close')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(assetDialog).toBeVisible()
  await page.mouse.click(5, 5)
  await expect(assetDialog).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  releaseUpload!()
  await expect(assetDialog.getByTestId('modal-close')).toBeEnabled()
  await assetDialog.getByRole('button', { name: 'cancel' }).click()
  await expect(assetDialog).toHaveCount(0)
})
