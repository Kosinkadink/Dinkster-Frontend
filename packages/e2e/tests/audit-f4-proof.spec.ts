import { expect, test, type Page } from '@playwright/test'

const digest = (character: string): string => `blake3:${character.repeat(64)}`

const catalog = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'audit-f4-proof', schemaWire: 21 },
  packs: {},
  nodes: {},
}

async function installAssetDocument(page: Page, multi: boolean): Promise<void> {
  await page.evaluate(({ multi }) => {
    const app = window.__dinksterTest!.app
    const type = multi
      ? { kind: 'list', element: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.IMAGE' } } }
      : { kind: 'asset', element: { kind: 'concrete', name: 'comfy.IMAGE' } }
    app.registerSchemas([{
      type: 'FileAcquisitionProof', displayName: 'File acquisition proof', category: 'proof', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'image', type, optional: false,
        widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: null } }],
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: `file-proof-${multi ? 'multi' : 'scalar'}`, root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { asset: { id: 'asset', type: 'FileAcquisitionProof', values: { image: multi ? [] : null } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { asset: { position: { x: 100, y: 100 } } } } } },
    }, 'File acquisition proof')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, { multi })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })
}

async function openAsset(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'asset')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'image')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('asset-editor')).toBeVisible()
}

test('proves product upload control and hidden workflow picker lifecycle', async ({ page }) => {
  await page.route('/api/**', (route) => { throw new Error(`unexpected unmocked API request: ${route.request().url()}`) })
  await page.route('/api/settings', (route) => route.fulfill({ json: { categories: { granted: [], available: [] }, settings: {} } }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: catalog }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'proof' }, devices: [] } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('/api/composition', (route) => route.fulfill({ json: { packs: {} } }))
  await page.route('/api/mounts', (route) => route.fulfill({ json: { mounts: [] } }))
  await page.route('/api/assets/*', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: '' }))

  let posts = 0
  let mode: 'success' | 'held' | 'failure' = 'success'
  let releaseHeld: (() => void) | undefined
  await page.route('/api/assets/media*', async (route) => {
    posts++
    if (mode === 'held') await new Promise<void>((resolve) => { releaseHeld = resolve })
    if (mode === 'failure') {
      await route.fulfill({ status: 500, body: 'proof failure' })
      return
    }
    const name = new URL(route.request().url()).searchParams.get('name') ?? 'uploaded.png'
    await route.fulfill({ status: 201, json: {
      asset: {
        digest: digest(String((posts % 9) + 1)),
        name,
        size: route.request().postDataBuffer()?.length ?? 0,
        mediaType: route.request().headers()['content-type'] ?? 'image/png',
        virtualPath: '',
      },
      kind: 'media/image',
    } })
  })

  await page.goto('/')
  await expect(page.getByTestId('settings-button')).toBeVisible()
  await page.evaluate(() => {
    HTMLInputElement.prototype.click = function () {
      this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    }
  })

  await installAssetDocument(page, true)
  await openAsset(page)
  const editor = page.getByTestId('asset-editor')
  const trigger = editor.getByTestId('asset-upload-trigger')
  const input = editor.locator('input[type=file]')
  await expect(trigger).toHaveRole('button')
  await expect(trigger).toHaveAccessibleName('Upload file')
  await expect(trigger).toBeEnabled()
  await expect(input).toBeHidden()
  expect(await trigger.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(32)

  await input.evaluate((element) => element.addEventListener('click', () => {
    ;(window as unknown as { __fileTriggerClicks?: number }).__fileTriggerClicks =
      ((window as unknown as { __fileTriggerClicks?: number }).__fileTriggerClicks ?? 0) + 1
  }))
  await trigger.focus()
  await trigger.press('Enter')
  await expect(trigger).toBeFocused()
  expect(await page.evaluate(() => (window as unknown as { __fileTriggerClicks?: number }).__fileTriggerClicks)).toBe(1)

  const png = { name: 'same.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') }
  await input.setInputFiles(png)
  await expect(trigger).toBeEnabled()
  await expect(trigger).toBeFocused()
  expect(posts).toBe(1)
  await input.setInputFiles(png)
  await expect.poll(() => posts).toBe(2)
  await expect(trigger).toBeFocused()

  await trigger.evaluate((element) => element.blur())
  await input.dispatchEvent('cancel')
  await expect(trigger).toBeFocused()

  mode = 'held'
  await input.setInputFiles({ ...png, name: 'held.png' })
  await expect(trigger).toBeDisabled()
  await expect(trigger).toHaveText('Uploading...')
  await expect.poll(() => releaseHeld !== undefined).toBe(true)
  releaseHeld!()
  mode = 'success'
  await expect(trigger).toBeEnabled()
  await expect(trigger).toBeFocused()
  expect(posts).toBe(3)

  mode = 'failure'
  await input.setInputFiles([
    { ...png, name: 'first.png' },
    { ...png, name: 'second.png' },
  ])
  await expect(editor).toContainText('POST /api/assets/media failed: 500')
  await expect(trigger).toBeEnabled()
  expect(posts).toBe(4)
  await editor.getByRole('button', { name: 'cancel' }).click()
  await expect(editor).not.toBeVisible()

  mode = 'success'
  await installAssetDocument(page, false)
  await openAsset(page)
  const scalarEditor = page.getByTestId('asset-editor')
  await expect(scalarEditor.locator('input[type=file]')).not.toHaveAttribute('multiple')
  await scalarEditor.locator('input[type=file]').setInputFiles({ ...png, name: 'scalar.png' })
  await expect(scalarEditor).toBeVisible()
  await expect(scalarEditor.getByTestId('asset-apply')).toBeEnabled()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.asset!.values.image)).toBeNull()
  await scalarEditor.getByTestId('asset-apply').click()
  await expect(scalarEditor).not.toBeVisible()
  expect(posts).toBe(5)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.asset!.values.image)).toMatchObject({ name: 'scalar.png' })

  await page.reload()
  await expect(page.getByTestId('settings-button')).toBeVisible()
  await page.evaluate(() => {
    HTMLInputElement.prototype.click = function () {
      this.dispatchEvent(new MouseEvent('click', { cancelable: true }))
    }
    const app = window.__dinksterTest!.app as any
    app.importWorkflowFile = async (file: File) => {
      ;(window as unknown as { __importedWorkflowName?: string }).__importedWorkflowName = file.name
      return true
    }
  })
  const changeLifecycle = await page.evaluate(() => {
    ;(window.__dinksterTest!.app as any).commands.get('workflow.importFile')!.run()
    const picker = document.querySelector<HTMLInputElement>('body > input[type=file]')!
    const before = document.querySelectorAll('body > input[type=file]').length
    Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['{}'], 'workflow.json', { type: 'application/json' })] })
    picker.dispatchEvent(new Event('change'))
    return { before, after: document.querySelectorAll('body > input[type=file]').length }
  })
  expect(changeLifecycle).toEqual({ before: 1, after: 0 })
  expect(await page.evaluate(() => (window as unknown as { __importedWorkflowName?: string }).__importedWorkflowName)).toBe('workflow.json')

  const cancelLifecycle = await page.evaluate(() => {
    ;(window.__dinksterTest!.app as any).commands.get('workflow.importFile')!.run()
    const before = document.querySelectorAll('body > input[type=file]').length
    document.querySelector<HTMLInputElement>('body > input[type=file]')!.dispatchEvent(new Event('cancel'))
    return { before, after: document.querySelectorAll('body > input[type=file]').length }
  })
  expect(cancelLifecycle).toEqual({ before: 1, after: 0 })

  const refocusLifecycle = await page.evaluate(async () => {
    ;(window.__dinksterTest!.app as any).commands.get('workflow.importFile')!.run()
    const before = document.querySelectorAll('body > input[type=file]').length
    window.dispatchEvent(new Event('focus'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { before, after: document.querySelectorAll('body > input[type=file]').length }
  })
  expect(refocusLifecycle).toEqual({ before: 1, after: 0 })
  expect(await page.evaluate(() => {
    for (let invocation = 0; invocation < 3; invocation++) {
      ;(window.__dinksterTest!.app as any).commands.get('workflow.importFile')!.run()
      document.querySelector<HTMLInputElement>('body > input[type=file]')!.dispatchEvent(new Event('cancel'))
    }
    return document.querySelectorAll('body > input[type=file]').length
  })).toBe(0)

  const problemsBeforeOpenFailure = await page.evaluate(() => window.__dinksterTest!.app.problems.get().length)
  await page.evaluate(() => {
    HTMLInputElement.prototype.click = () => { throw new Error('picker blocked by proof') }
    ;(window.__dinksterTest!.app as any).commands.get('workflow.importFile')!.run()
  })
  await expect(page.locator('body > input[type=file]')).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get().length)).toBe(problemsBeforeOpenFailure + 1)
  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get().some((problem) =>
    problem.code === 'workflow.importFailed' && problem.message.includes('failed to open workflow file picker: picker blocked by proof')))).toBe(true)
  await expect(page.getByTestId('transient-status')).toContainText('picker blocked by proof')
})
