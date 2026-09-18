import { expect, test, type Page } from './fixtures.js'

const activeDoc = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

async function rowPoint(page: Page, inputId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((inputId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'widgets')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  }, inputId)
}

async function nodeRowPoint(page: Page, nodeId: string, inputId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, inputId }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  }, { nodeId, inputId })
}

async function nodeHeaderPoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nodeId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: rect.top + (node.y + 12) * viewport.scale + viewport.y,
    }
  }, nodeId)
}

async function toolboxButtonPoint(page: Page, buttonId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((buttonId) => {
    const renderer = window.__dinksterTest!.renderer!
    const button = renderer.getToolboxLayout()?.buttons.find((entry) => entry.button.id === buttonId)
    if (button === undefined) throw new Error(`toolbox button ${buttonId} is not visible`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    return {
      x: rect.left + (button.x + button.size / 2) * viewport.scale + viewport.x,
      y: rect.top + (button.y + button.size / 2) * viewport.scale + viewport.y,
    }
  }, buttonId)
}

async function openEditor(page: Page, inputId: string) {
  // Synchronize the prior expanded surface before issuing another canvas hit.
  await expect(page.getByTestId('widget-modal-surface')).toHaveCount(0)
  await expect(page.getByTestId('widget-popover-layer')).toHaveCount(0)
  await page.getByTestId('graph-canvas').focus()
  const point = await rowPoint(page, inputId)
  await page.mouse.click(point.x, point.y)
}

async function stepperPoint(page: Page, inputId: string, side: 'left' | 'right') {
  return page.evaluate(({ inputId, side }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'widgets')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const inset = row.inset!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      // Stay inside the capsule's 12px edge zone after its pin clearance.
      x: rect.left + node.x + (side === 'left' ? inset + 6 : node.layout.width - inset - 6),
      y: rect.top + node.y + row.y + row.height / 2,
    }
  }, { inputId, side })
}

test.beforeEach(async ({ page }) => {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 33,
    epoch: 1,
    dinkster: { version: 'widget-editors-e2e', schemaWire: 33, graphFeatures: ['decimalInt'] },
    nodes: {},
  } }))
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(() => {
    const widget = (id: string, widgetType: string, defaultValue: unknown, options: Record<string, unknown> = {}) => ({
      kind: 'input', id, type: { kind: 'concrete', name: widgetType === 'COMBO' ? 'core.combo' : widgetType }, optional: false,
      widget: { widgetType, options, default: defaultValue },
    })
    window.__dinksterTest!.app.registerSchemas([{
      type: 'WidgetEditorsTest', displayName: 'Widget Editors', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        widget('count', 'INT', 5, { min: 0, max: 100, step: 5 }),
        widget('amount', 'FLOAT', 1.5, { min: 0, max: 10 }),
        widget('title', 'STRING', 'old'),
        widget('notes', 'STRING', 'first', { multiline: true }),
        widget('enabled', 'BOOLEAN', false),
        widget('color', 'COLOR', '#11223380'),
        widget('choice', 'COMBO', 'dinkster.alpha', { options: [
          { value: 'dinkster.alpha', label: 'alpha', info: 'Fast baseline' },
          { value: 'dinkster.beta', label: 'beta', info: 'Detailed decoder' },
          { value: 'dinkster.gamma', label: 'gamma', info: 'Advanced solver', folder: 'Advanced/Diffusion' },
        ] }),
        widget('empty', 'COMBO', '', { options: [] }),
        widget('asset', 'ASSET', null, { accept: ['image/png'] }),
        widget('video_edit', 'VIDEO_EDIT', {}, { features: ['trim', 'crop'] }),
        { ...widget('strict_duration', 'BOOLEAN', false), type: { kind: 'concrete', name: 'core.boolean' } },
      ],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'widget-editors', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        widgets: { id: 'widgets', type: 'WidgetEditorsTest', values: {
          video_edit: {
            imported: { future: ['keep', 7] },
            trim: { start_time: 1.25, duration: 3.5, future_trim: true },
            crop: { x: 100, y: 40, width: 1280, height: 720, future_crop: 'keep' },
          },
          strict_duration: false,
        } },
        other: { id: 'other', type: 'WidgetEditorsTest', values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 3 } },
      view: { graphs: { g0: { nodes: {
        widgets: { position: { x: 100, y: 100 } },
        other: { position: { x: 600, y: 100 } },
      } } } },
    }, 'Widget Editors')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
})

test('VIDEO_EDIT trim and crop preserve imported JSON and commit strict_duration separately', async ({ page }, testInfo) => {
  const before = (await activeDoc(page)).graphs.g0!.nodes.widgets!.values
  await openEditor(page, 'video_edit')
  const editor = page.getByTestId('video-edit-editor')
  await expect(editor).toBeVisible()
  await expect(page.getByTestId('video-edit-preview-unavailable')).toBeVisible()
  await expect(page.getByTestId('video-edit-filmstrip')).toBeVisible()
  await expect(page.getByTestId('video-crop-stage')).toBeVisible()
  await page.getByTestId('video-trim-duration-seconds').fill('0')
  await page.getByTestId('video-crop-width').fill('0')
  await page.getByTestId('video-trim-strict').check()
  const modal = page.getByTestId('widget-modal-surface')
  await expect(modal.getByTestId('video-edit-apply')).toBeVisible()
  expect(await editor.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true)
  await page.getByTestId('widget-editor').evaluate((element) => { element.scrollTop = 0 })
  const screenshotPath = testInfo.outputPath('video-edit-trim-crop.png')
  await modal.screenshot({ path: screenshotPath, animations: 'disabled' })
  await testInfo.attach('video-edit-trim-crop', { path: screenshotPath, contentType: 'image/png' })
  await page.getByTestId('widget-editor').evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(page.getByTestId('video-crop-width')).toBeInViewport()
  await expect(page.getByRole('button', { name: 'Full frame', exact: true })).toBeInViewport()
  await modal.screenshot({ path: testInfo.outputPath('video-edit-crop-scrolled.png'), animations: 'disabled' })
  await page.getByTestId('video-edit-apply').click()

  const values = (await activeDoc(page)).graphs.g0!.nodes.widgets!.values
  expect(values.video_edit).toEqual({
    imported: { future: ['keep', 7] },
    trim: { start_time: 1.25, duration: 0, future_trim: true },
    crop: { x: 100, y: 40, width: 0, height: 720, future_crop: 'keep' },
  })
  expect(values.strict_duration).toBe(true)
  await page.getByTestId('graph-canvas').focus()
  await page.keyboard.press('Control+z')
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values).toEqual(before)
})

test('INT commits exact integers, rejects malformed text, and does not clamp or step', async ({ page }) => {
  const value = async () => (await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count
  await openEditor(page, 'count')
  let input = page.getByTestId('widget-editor').locator('input')
  await input.fill('42'); await input.press('Enter')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect(await value()).toBe(42)

  // Fractional text cannot silently change the entered value through rounding.
  await openEditor(page, 'count'); input = page.getByTestId('widget-editor').locator('input')
  await input.fill('2.7'); await input.press('Enter')
  await expect(page.getByTestId('widget-editor')).toBeVisible()
  await expect(page.getByTestId('widget-editor-error')).toContainText('exact integer')
  expect(await value()).toBe(42)
  await input.press('Escape')

  // Non-numeric text never commits: the stored value is retained verbatim
  // and the editor STAYS OPEN (nothing closed it), so Escape then discards.
  await openEditor(page, 'count'); input = page.getByTestId('widget-editor').locator('input')
  await input.fill('not a number'); await input.press('Enter')
  await expect(page.getByTestId('widget-editor')).toBeVisible()
  await expect(page.getByTestId('widget-editor-error')).toContainText('exact integer')
  await input.press('Escape')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect(await value()).toBe(42)

  // Escape cancels a pending edit outright.
  await openEditor(page, 'count'); input = page.getByTestId('widget-editor').locator('input')
  await input.fill('77'); await input.press('Escape')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect(await value()).toBe(42)

  // Current behavior intentionally asserted: min/max metadata does not clamp
  // (out-of-range commits verbatim; validation surfaces warnings instead)
  // and `step` metadata has no editor behavior.
  await openEditor(page, 'count'); input = page.getByTestId('widget-editor').locator('input')
  await input.fill('999'); await input.press('Enter')
  expect(await value()).toBe(999)
})

test('uint64 INT values edit, step, reload, and compile without precision loss', async ({ page }, testInfo) => {
  await page.evaluate(() => {
    const test = window.__dinksterTest!
    test.app.registerSchemas([{
      type: 'ExactSeedE2E', displayName: 'Exact Seed', category: 'test', source: 'v3', isOutputNode: true,
      items: [{
        kind: 'input', id: 'seed', type: { kind: 'concrete', name: 'core.int' }, optional: false,
        widget: {
          widgetType: 'INT',
          options: { min: 0, max: '18446744073709551615', step: 1 },
          default: 0,
          controller: 'after_generate',
        },
      }],
    }])
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'exact-seed-e2e', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        widgets: { id: 'widgets', type: 'ExactSeedE2E', values: { seed: '18446744073709551614' } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { widgets: { position: { x: 180, y: 160 }, size: { width: 400, height: 70 } } } } } },
    }, 'Exact Seed')
    ;(test.app as any).shell.statusBarVisible.set(false)
    test.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .find((node) => node.id === 'widgets')?.layout.rows
    .some((row) => row.kind === 'widget' && row.inputId === 'seed'))).toBe(true)
  const increment = await stepperPoint(page, 'seed', 'right')
  await page.mouse.click(increment.x, increment.y)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.widgets!.values.seed))
    .toBe('18446744073709551615')

  await openEditor(page, 'seed')
  const editor = page.getByTestId('widget-editor')
  await expect(editor.locator('input')).toHaveValue('18446744073709551615')
  await expect(page.getByTestId('widget-numeric-constraints')).toContainText('18446744073709551615')
  const screenshotPath = testInfo.outputPath('uint64-exact-integer-editor.png')
  await page.screenshot({ path: screenshotPath, animations: 'disabled' })
  await testInfo.attach('uint64-exact-integer-editor', { path: screenshotPath, contentType: 'image/png' })
  await page.keyboard.press('Escape')

  const proof = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const exported = JSON.stringify(app.activeTab()!.store.doc)
    app.openDocument(JSON.parse(exported), 'Reloaded Exact Seed')
    const tab = app.activeTab()!
    const result = app.compileTab(tab)
    if (result === undefined || !result.ok) throw new Error(`compile failed: ${JSON.stringify(result?.diagnostics)}`)
    return {
      stored: tab.store.doc.graphs.g0.nodes.widgets.values.seed,
      submitted: result.artifact.prompt.widgets.inputs.seed,
    }
  })
  expect(proof).toEqual({
    stored: '18446744073709551615',
    submitted: { $int: '18446744073709551615' },
  })
})

test('unbounded INT stepping crosses the JavaScript safe-integer boundary exactly', async ({ page }) => {
  await page.evaluate(() => {
    const test = window.__dinksterTest!
    test.app.registerSchemas([{
      type: 'UnboundedIntE2E', displayName: 'Unbounded Integer', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'seed', type: { kind: 'concrete', name: 'core.int' }, optional: false,
        widget: { widgetType: 'INT', options: {}, default: 0 },
      }],
    }])
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'unbounded-int-e2e', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        widgets: { id: 'widgets', type: 'UnboundedIntE2E', values: { seed: Number.MAX_SAFE_INTEGER } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { widgets: { position: { x: 180, y: 160 } } } } } },
    }, 'Unbounded Integer')
    test.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  const increment = await stepperPoint(page, 'seed', 'right')
  await page.mouse.click(increment.x, increment.y)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.widgets!.values.seed))
    .toBe('9007199254740992')

  const decrement = await stepperPoint(page, 'seed', 'left')
  await page.mouse.click(decrement.x, decrement.y)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.widgets!.values.seed))
    .toBe(Number.MAX_SAFE_INTEGER)
})

test('FR15 an empty numeric commit never writes zero', async ({ page }) => {
  const value = async () => (await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count
  await openEditor(page, 'count')
  let input = page.getByTestId('widget-editor').locator('input')
  await input.fill('42'); await input.press('Enter')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect(await value()).toBe(42)

  // Number('') is 0 - an empty or whitespace commit must error, not write 0.
  for (const raw of ['', '   ']) {
    await openEditor(page, 'count'); input = page.getByTestId('widget-editor').locator('input')
    await input.fill(raw); await input.press('Enter')
    await expect(page.getByTestId('widget-editor')).toBeVisible()
    await expect(page.getByTestId('widget-editor-error')).toContainText('finite number')
    await input.press('Escape')
    await expect(page.getByTestId('widget-editor')).toHaveCount(0)
    expect(await value()).toBe(42)
  }
})

test('FR15 non-finite numeric text never commits through the editor', async ({ page }) => {
  const value = async () => (await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count
  await openEditor(page, 'count')
  let input = page.getByTestId('widget-editor').locator('input')
  await input.fill('7'); await input.press('Enter')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect(await value()).toBe(7)

  // Non-finite forms must error visibly instead of committing as integers.
  for (const raw of ['Infinity', '-Infinity', '1e999']) {
    await openEditor(page, 'count'); input = page.getByTestId('widget-editor').locator('input')
    await input.fill(raw); await input.press('Enter')
    await expect(page.getByTestId('widget-editor')).toBeVisible()
    await expect(page.getByTestId('widget-editor-error')).toContainText('exact integer')
    await input.press('Escape')
    await expect(page.getByTestId('widget-editor')).toHaveCount(0)
    expect(await value()).toBe(7)
  }
})

test('FR15 Enter during an IME composition never commits an editor', async ({ page }) => {
  const value = async () => (await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count
  await openEditor(page, 'count')
  const input = page.getByTestId('widget-editor').locator('input')
  await input.fill('55')
  // A composing Enter (isComposing: true) selects the IME candidate; it must
  // not commit or close the editor.
  await input.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
  })
  await expect(page.getByTestId('widget-editor')).toBeVisible()
  expect(await value()).toBeUndefined()
  // A real Enter after composition commits normally.
  await input.press('Enter')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect(await value()).toBe(55)
})

test('FR15 a composing Enter never commits the COMBO, multiline, or COLOR editors', async ({ page }) => {
  // Each surface wires its own Enter handler, so each guard is pinned
  // through its own rendered editor (SAVE_TARGET lives in save-target.spec.ts).
  const values = async () => (await activeDoc(page)).graphs.g0!.nodes.widgets!.values

  // COMBO: a composing Enter selects the IME candidate, not the highlighted option.
  await openEditor(page, 'choice')
  const search = page.getByTestId('combo-search')
  await search.fill('be'); await search.press('ArrowDown')
  await search.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
  })
  await expect(page.getByTestId('combo-dropdown')).toBeVisible()
  expect((await values()).choice).toBeUndefined()
  await search.press('Enter')
  await expect(page.getByTestId('combo-dropdown')).not.toBeVisible()
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect((await values()).choice).toBe('dinkster.beta')

  // Multiline: the modifier commit (Ctrl+Enter) is composition-guarded too.
  await openEditor(page, 'notes')
  const textarea = page.getByTestId('widget-editor').locator('textarea')
  await textarea.fill('composed text')
  await textarea.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }))
  })
  await expect(page.getByTestId('widget-editor')).toBeVisible()
  expect((await values()).notes).toBeUndefined()
  await textarea.press('Control+Enter')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect((await values()).notes).toBe('composed text')

  // COLOR: the hex-text Enter path carries the same guard.
  await openEditor(page, 'color')
  const colorText = page.getByTestId('color-text')
  await colorText.fill('#00ff3380')
  await colorText.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
  })
  await expect(page.getByTestId('color-editor')).toBeVisible()
  expect((await values()).color).toBeUndefined()
  await colorText.press('Enter')
  await expect(page.getByTestId('color-editor')).toHaveCount(0)
  expect((await values()).color).toBe('#00ff3380')
})

test('numeric compact stepping stays primary while the optional popover supports exact commit/cancel', async ({ page }) => {
  await openEditor(page, 'count')
  const editor = page.getByTestId('widget-editor')
  const dialog = page.getByRole('dialog', { name: 'Edit count INT' })
  await expect(dialog).toBeVisible()
  await expect(editor).toHaveAttribute('data-editor-surface', 'popover')
  await expect(page.getByTestId('widget-modal-surface')).toHaveCount(0)
  await expect(page.getByTestId('widget-editor-step-controls')).toHaveCount(0)
  await expect(page.getByTestId('widget-editor-label')).toHaveText('count')
  await expect(page.getByTestId('widget-editor-type')).toHaveText('INT')
  await expect(page.getByTestId('widget-editor-type')).toHaveCSS('background-color', 'rgb(123, 31, 162)')
  await expect(page.getByTestId('widget-editor-type')).toHaveCSS('color', 'rgb(255, 255, 255)')
  await expect(page.getByTestId('widget-numeric-constraints')).toContainText('Minimum0')
  await expect(page.getByTestId('widget-numeric-constraints')).toContainText('Maximum100')
  await expect(page.getByTestId('widget-numeric-constraints')).toContainText('Step5')

  await editor.locator('input').fill('44')
  await page.getByTestId('widget-editor-cancel').click()
  await expect(editor).toHaveCount(0)
  await expect(page.getByTestId('graph-canvas')).toBeFocused()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBeUndefined()

  await openEditor(page, 'count')
  await editor.locator('input').fill('45')
  await page.getByTestId('widget-editor-commit').click()
  await expect(editor).toHaveCount(0)
  await expect(page.getByTestId('graph-canvas')).toBeFocused()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBe(45)
  await page.keyboard.press('Control+z')
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBeUndefined()
})

test('numeric editors select all while native arrows collapse the selection', async ({ page }) => {
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await openEditor(page, 'count')
  const dialog = page.getByRole('dialog', { name: 'Edit count INT' })
  const numeric = dialog.locator('input')
  await expect(dialog).toHaveAttribute('aria-label', 'Edit count INT')
  await expect(numeric).toBeFocused()
  expect(await numeric.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd, el.value.length])).toEqual([0, 1, 1])
  await numeric.pressSequentially('42')
  await expect(numeric).toHaveValue('42')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await numeric.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('graph-canvas')).toBeFocused()

  await openEditor(page, 'count')
  const left = page.getByRole('dialog', { name: 'Edit count INT' }).locator('input')
  await left.press('ArrowLeft')
  expect(await left.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 0])
  await left.press('Escape')

  await openEditor(page, 'count')
  const right = page.getByRole('dialog', { name: 'Edit count INT' }).locator('input')
  const length = await right.evaluate((el: HTMLInputElement) => el.value.length)
  await right.press('ArrowRight')
  expect(await right.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([length, length])
  await right.press('Escape')

  await openEditor(page, 'title')
  const text = page.getByRole('dialog', { name: 'Edit title STRING' }).locator('input')
  await expect(text).toBeFocused()
  const textSelection = await text.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd, el.value.length])
  expect(textSelection[0]).toBe(textSelection[1])
  expect(textSelection.slice(0, 2)).not.toEqual([0, textSelection[2]])
  await text.press('Escape')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)

  await openEditor(page, 'count')
  const committed = page.getByRole('dialog', { name: 'Edit count INT' }).locator('input')
  await committed.pressSequentially('77')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await committed.press('Enter')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBe(77)
})

test('widget popover keeps interior chrome open, Cancel and Escape discard, and canvas click-away commits', async ({ page }) => {
  await openEditor(page, 'count')
  const editor = page.getByTestId('widget-editor')
  await editor.locator('input').fill('73')
  await page.getByTestId('widget-editor-meta').click()
  await expect(editor).toBeVisible()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBeUndefined()

  await page.getByTestId('widget-editor-cancel').click()
  await expect(editor).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBeUndefined()

  await openEditor(page, 'count')
  await page.getByTestId('widget-editor').locator('input').fill('74')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBeUndefined()

  await openEditor(page, 'count')
  await page.getByTestId('widget-editor').locator('input').fill('75')
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  const before = await page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())
  const canvas = (await page.getByTestId('graph-canvas').boundingBox())!
  const start = { x: canvas.x + canvas.width - 140, y: canvas.y + canvas.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  await page.mouse.move(start.x + 70, start.y + 35, { steps: 5 })
  await page.mouse.up()
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  await expect(page.getByTestId('graph-canvas')).toBeFocused()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())).toEqual({
    x: before.x + 70,
    y: before.y + 35,
    scale: before.scale,
  })
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBe(75)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)
  await page.keyboard.press('Control+z')
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBeUndefined()
})

test('one outside click commits the first editor and opens a second widget on the same or another node', async ({ page }) => {
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await openEditor(page, 'title')
  await page.getByTestId('widget-editor').locator('input').fill('first title')
  const sameNode = await rowPoint(page, 'count')
  await page.mouse.click(sameNode.x, sameNode.y)
  await expect(page.getByRole('dialog', { name: 'Edit count INT' })).toBeVisible()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.title).toBe('first title')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)

  await page.getByTestId('widget-editor').locator('input').fill('61')
  const otherNode = await nodeRowPoint(page, 'other', 'amount')
  await page.mouse.click(otherNode.x, otherNode.y)
  await expect(page.getByRole('dialog', { name: 'Edit amount FLOAT' })).toBeVisible()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBe(61)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 2)
  await page.keyboard.press('Escape')
})

test('invalid popover text is dropped on click-away without a document write', async ({ page }) => {
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await openEditor(page, 'count')
  await page.getByTestId('widget-editor').locator('input').fill('invalid')
  const canvas = (await page.getByTestId('graph-canvas').boundingBox())!
  await page.mouse.click(canvas.x + canvas.width - 40, canvas.y + canvas.height - 40)
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBeUndefined()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
})

test('the initiating click-away press still selects a node or activates its toolbar', async ({ page }) => {
  const canvas = page.getByTestId('graph-canvas')
  await page.mouse.click(...Object.values(await nodeHeaderPoint(page, 'widgets')) as [number, number])
  await expect(canvas).toHaveAttribute('data-selection', '1')

  await openEditor(page, 'count')
  await page.getByTestId('widget-editor').locator('input').fill('62')
  const more = await toolboxButtonPoint(page, 'core.more')
  await page.mouse.click(more.x, more.y)
  await expect(page.getByTestId('context-menu')).toBeVisible()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBe(62)
  await page.keyboard.press('Escape')

  await openEditor(page, 'title')
  await page.getByTestId('widget-editor').locator('input').fill('selected another node')
  const other = await nodeHeaderPoint(page, 'other')
  await page.mouse.click(other.x, other.y)
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.title).toBe('selected another node')
  await expect(canvas).toHaveAttribute('data-selection', '1')
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getToolboxLayout()?.x ?? 0)).toBeGreaterThan(500)
})

test('a composing Escape does not close the STRING popover or write its draft', async ({ page }) => {
  await openEditor(page, 'title')
  const input = page.getByTestId('widget-editor').locator('input')
  await input.fill('composing draft')
  await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })
  await expect(page.getByTestId('widget-editor')).toBeVisible()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.title).toBeUndefined()
  await input.press('Escape')
})

test('Tab reaches popover Cancel and Enter discards STRING and COLOR drafts', async ({ page }) => {
  await openEditor(page, 'title')
  await page.getByTestId('widget-editor').locator('input').fill('discarded text')
  await page.keyboard.press('Tab')
  const closeString = page.getByTestId('widget-editor-cancel')
  await expect(closeString).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.title).toBeUndefined()

  await openEditor(page, 'color')
  await page.getByTestId('color-text').fill('#abcdef')
  await page.keyboard.press('Tab')
  const closeColor = page.getByTestId('color-editor').getByRole('button', { name: 'Cancel' })
  await expect(closeColor).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('color-editor')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.color).toBeUndefined()
})

test('widget popover is anchored, non-draggable, Escape-restoring, and fits a sub-320px viewport', async ({ page }) => {
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 650, y: 0, scale: 1 }))
  await page.getByTestId('rail-toggle').click()
  await expect(page.getByTestId('rail-toggle')).toHaveAttribute('aria-pressed', 'false')
  await openEditor(page, 'count')
  const dialog = page.getByRole('dialog', { name: 'Edit count INT' })
  const editor = page.getByTestId('widget-editor')
  await page.setViewportSize({ width: 1200, height: 900 })
  const moderate = await dialog.boundingBox()
  const canvas = await page.getByTestId('graph-canvas').boundingBox()
  expect(moderate!.x + moderate!.width).toBeLessThanOrEqual(canvas!.x + canvas!.width)
  const header = editor.getByTestId('widget-editor-header')
  await header.hover({ position: { x: 20, y: 10 } })
  const headerBox = await header.boundingBox()
  await page.mouse.down()
  await expect(editor).toBeVisible()
  await page.mouse.move(headerBox!.x + 90, headerBox!.y + 40)
  await expect(editor).toBeVisible()
  await page.mouse.up()
  expect(await dialog.boundingBox()).toEqual(moderate)
  await expect(editor.getByTestId('widget-editor-resize-handle')).toHaveCount(0)

  await page.setViewportSize({ width: 280, height: 240 })
  // Let responsive metadata reflow and ResizeObserver clamping settle.
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  ))
  await expect.poll(async () => {
    const bounds = await dialog.boundingBox()
    return bounds === null ? Number.POSITIVE_INFINITY : bounds.x + bounds.width
  }).toBeLessThanOrEqual(280)
  const before = await dialog.boundingBox()
  expect(before!.x).toBeGreaterThanOrEqual(0)
  expect(before!.y).toBeGreaterThanOrEqual(0)
  expect(before!.x + before!.width).toBeLessThanOrEqual(280)
  expect(before!.y + before!.height).toBeLessThanOrEqual(240)
  expect(await editor.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto')

  await page.setViewportSize({ width: 1200, height: 900 })
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBeGreaterThan(before!.width)
  const expanded = await dialog.boundingBox()
  const expandedCanvas = await page.getByTestId('graph-canvas').boundingBox()
  expect(expanded!.x + expanded!.width).toBeLessThanOrEqual(expandedCanvas!.x + expandedCanvas!.width)
  expect(expanded!.y + expanded!.height).toBeLessThanOrEqual(900)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('graph-canvas')).toBeFocused()
})

test('INT and single-line STRING popover blur does not commit while in-node multiline blur does', async ({ page }) => {
  await openEditor(page, 'count')
  const int = page.getByTestId('widget-editor').locator('input')
  await int.fill('12'); await int.blur()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBeUndefined()
  await expect(page.getByTestId('widget-editor')).toBeVisible()
  await page.getByTestId('widget-editor-cancel').click()
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)

  await openEditor(page, 'title')
  const str = page.getByTestId('widget-editor').locator('input')
  await str.fill('not committed by blur'); await str.blur()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.title).toBeUndefined()
  await page.getByTestId('widget-editor-cancel').click()
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)

  // The in-node multiline textarea keeps its established blur-commit path.
  await openEditor(page, 'notes')
  const textarea = page.getByTestId('widget-editor').locator('textarea')
  await textarea.fill('multi\nblur'); await textarea.blur()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.notes).toBe('multi\nblur')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
})

test('FLOAT rejects non-finite input and preserves precision including scientific notation', async ({ page }) => {
  const value = async () => (await activeDoc(page)).graphs.g0!.nodes.widgets!.values.amount
  // Non-finite parses (Number('Infinity') is Infinity) but never commits:
  // JSON has no representation for it and the stored value must survive.
  for (const bad of ['Infinity', '-Infinity', 'NaN']) {
    await openEditor(page, 'amount')
    const input = page.getByTestId('widget-editor').locator('input')
    await input.fill(bad); await input.press('Enter')
    await input.press('Escape')
    await expect(page.getByTestId('widget-editor')).toHaveCount(0)
    expect(await value(), bad).toBeUndefined()
  }
  // Full double precision survives the text round trip; no rounding to a
  // display precision happens at commit.
  await openEditor(page, 'amount')
  let input = page.getByTestId('widget-editor').locator('input')
  await input.fill('0.1234567890123456'); await input.press('Enter')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect(await value()).toBe(0.1234567890123456)
  // Scientific notation is ordinary Number syntax.
  await openEditor(page, 'amount'); input = page.getByTestId('widget-editor').locator('input')
  await input.fill('1e-3'); await input.press('Enter')
  expect(await value()).toBe(0.001)
})

test('a very long STRING commits intact and its compact row truncates rather than growing', async ({ page }) => {
  const long = 'x'.repeat(5000)
  await openEditor(page, 'title')
  const input = page.getByTestId('widget-editor').locator('input')
  await input.fill(long); await input.press('Enter')
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.title).toBe(long)
  // The node body must not balloon: the widget row keeps its one-row height.
  const row = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'widgets')!
    const r = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'title')!
    return { height: r.height, width: node.layout.width }
  })
  expect(row.height).toBeLessThan(60)
  expect(row.width).toBeLessThan(1000)
})

test('FLOAT commits fractions, Enter commits, Escape cancels, and typed commits clamp to bounds', async ({ page }) => {
  await openEditor(page, 'amount')
  let input = page.getByTestId('widget-editor').locator('input')
  await input.fill('2.75'); await input.press('Enter')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.amount).toBe(2.75)
  await openEditor(page, 'amount'); input = page.getByTestId('widget-editor').locator('input')
  await input.fill('8.25'); await input.press('Escape')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.amount).toBe(2.75)
  await openEditor(page, 'amount'); input = page.getByTestId('widget-editor').locator('input')
  // Typed commits clamp to schema bounds without applying step quantization.
  await input.fill('12.5'); await input.press('Enter')
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.amount).toBe(10)
})

test('numeric row edge steppers use schema defaults and bounds; each click is one undo step', async ({ page }) => {
  const count = async () => (await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count
  const amount = async () => (await activeDoc(page)).graphs.g0!.nodes.widgets!.values.amount

  await page.mouse.click(...Object.values(await stepperPoint(page, 'count', 'right')) as [number, number])
  expect(await count()).toBe(10)
  await expect(page.getByTestId('widget-popover-layer')).toHaveCount(0)
  await page.keyboard.press('Control+z')
  expect(await count()).toBeUndefined()

  await page.mouse.click(...Object.values(await stepperPoint(page, 'amount', 'right')) as [number, number])
  expect(await amount()).toBeCloseTo(1.6)
  await expect(page.getByTestId('widget-popover-layer')).toHaveCount(0)
  await page.mouse.click(...Object.values(await stepperPoint(page, 'amount', 'left')) as [number, number])
  expect(await amount()).toBeCloseTo(1.5)
  await expect(page.getByTestId('widget-popover-layer')).toHaveCount(0)

  // A center click retains the text editor behavior.
  await openEditor(page, 'count')
  await expect(page.getByTestId('widget-editor')).toBeVisible()
  await page.getByTestId('widget-editor').locator('input').fill('100')
  await page.getByTestId('widget-editor').locator('input').press('Enter')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  await page.mouse.click(...Object.values(await stepperPoint(page, 'count', 'right')) as [number, number])
  expect(await count()).toBe(100)
})

test('numeric edge controls step an intrinsic default while body activation remains deliberate', async ({ page }) => {
  await page.evaluate(() => {
    window.__dinksterTest!.app.registerSchemas([{
      type: 'IntrinsicNumericTest', displayName: 'Intrinsic Numeric', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'value', type: { kind: 'concrete', name: 'FLOAT' }, optional: false,
        widget: { widgetType: 'FLOAT', options: { min: 2, max: 4, step: 0.5 } },
      }],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'intrinsic-numeric', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { widgets: { id: 'widgets', type: 'IntrinsicNumericTest', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { widgets: { position: { x: 100, y: 100 } } } } } },
    }, 'Intrinsic Numeric')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.mouse.click(...Object.values(await stepperPoint(page, 'value', 'right')) as [number, number])
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.value).toBe(2.5)
  await expect(page.getByTestId('widget-popover-layer')).toHaveCount(0)
  await page.mouse.click(...Object.values(await stepperPoint(page, 'value', 'left')) as [number, number])
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.value).toBe(2)
  await expect(page.getByTestId('widget-popover-layer')).toHaveCount(0)
  await openEditor(page, 'value')
  await expect(page.getByTestId('widget-editor')).toBeVisible()
  await expect(page.getByTestId('widget-numeric-constraints')).toContainText('Minimum2')
  await expect(page.getByTestId('widget-numeric-constraints')).toContainText('Maximum4')
  await expect(page.getByTestId('widget-numeric-constraints')).toContainText('Step0.5')
})

test('tap companions keep INT and STRING defaults, edits, and dormant sink values in the same neutral presentation', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.evaluate(() => {
    const widget = (id: string, widgetType: string, defaultValue: unknown) => ({
      kind: 'input', id, type: { kind: 'concrete', name: widgetType }, optional: false,
      widget: { widgetType, options: {}, default: defaultValue },
    })
    window.__dinksterTest!.app.registerSchemas([{
      type: 'PassThroughTest', displayName: 'Pass Through', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        widget('number', 'INT', 0),
        widget('text', 'STRING', ''),
        {
          ...widget('configuration_strength_after_generation', 'FLOAT', 1.3),
          widget: { widgetType: 'FLOAT', options: { step: 0.01 }, default: 1.3 },
        },
      ],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'pass-through', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          source: { id: 'source', type: 'PassThroughTest', values: {} },
          sink: { id: 'sink', type: 'PassThroughTest', values: {} },
        },
        links: {
          number: { id: 'number', from: { node: 'source', tap: 'number' }, to: { node: 'sink', port: 'number' } },
          text: { id: 'text', from: { node: 'source', tap: 'text' }, to: { node: 'sink', port: 'text' } },
          cfg: {
            id: 'cfg',
            from: { node: 'source', tap: 'configuration_strength_after_generation' },
            to: { node: 'sink', port: 'configuration_strength_after_generation' },
          },
        },
        nets: {}, reroutes: {}, nextOrdinal: 10,
      } },
      view: { graphs: { g0: { nodes: { source: { position: { x: 100, y: 100 } }, sink: { position: { x: 620, y: 100 } } } } } },
    }, 'Pass Through')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  const companions = () => page.evaluate(() => structuredClone((window.__dinksterTest!.renderer as any).companions))
  await expect.poll(companions).toEqual({ sink: {
    number: { value: 0 }, text: { value: '' }, configuration_strength_after_generation: { value: 1.3 },
  } })
  await expect.poll(() => page.evaluate(() => 'status' in window.__dinksterTest!.app.activeTab()!.store)).toBe(true)
  const proxy = page.getByTestId('canvas-widget-a11y')
    .filter({ has: page.getByText('Pass Through, configuration_strength_after_generation', { exact: true }) })
    .last()
  await proxy.focus()
  await expect(page.getByTestId('app-tooltip')).toContainText('Current expected value: 1.30')
  await expect(page.getByTestId('app-tooltip')).toContainText('Dormant stored value under connection: 1.30')
  expect(await proxy.evaluate((element) => getComputedStyle(element.parentElement!).pointerEvents)).toBe('none')
  const sourcePoint = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'source')!
    const row = node.layout.rows.find((candidate) =>
      candidate.kind === 'widget' && candidate.inputId === 'configuration_strength_after_generation')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + node.x + node.layout.width / 2, y: canvas.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.click(sourcePoint.x, sourcePoint.y)
  await expect(page.getByTestId('widget-editor')).toBeVisible()
  await expect(page.getByTestId('canvas-widget-a11y')).toHaveCount(0)
  await page.getByTestId('widget-editor').locator('input').press('Escape')
  await page.keyboard.press('Control+,')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await expect(page.getByTestId('canvas-widget-a11y')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'source', inputId: 'number', value: 0 } })
    tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'source', inputId: 'text', value: '' } })
  })
  await expect.poll(companions).toEqual({ sink: {
    number: { value: 0 }, text: { value: '' }, configuration_strength_after_generation: { value: 1.3 },
  } })
  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'source', inputId: 'number', value: 7 } })
    tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'source', inputId: 'text', value: 'changed' } })
    tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'sink', inputId: 'number', value: 99 } })
    tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'sink', inputId: 'text', value: 'dormant' } })
    tab.store.dispatch({ command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'sink', inputId: 'configuration_strength_after_generation', value: 8,
    } })
  })
  await expect.poll(companions).toEqual({ sink: {
    number: { value: 7 }, text: { value: 'changed' }, configuration_strength_after_generation: { value: 1.3 },
  } })
  await proxy.focus()
  await expect(page.getByTestId('app-tooltip')).toContainText('Current expected value: 1.30')
  await expect(page.getByTestId('app-tooltip')).toContainText('Dormant stored value under connection: 8.00')
  const clip = await page.evaluate(() => {
    const nodes = window.__dinksterTest!.renderer!.getScene().nodes.filter((node) => node.id === 'source' || node.id === 'sink')
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const left = Math.min(...nodes.map((node) => node.x)) - 12
    const top = Math.min(...nodes.map((node) => node.y)) - 12
    const right = Math.max(...nodes.map((node) => node.x + node.layout.width)) + 12
    const bottom = Math.max(...nodes.map((node) => node.y + node.layout.height)) + 12
    return { x: canvas.left + left, y: canvas.top + top, width: right - left, height: bottom - top }
  })
  const screenshotPath = test.info().outputPath('neutral-tap-companions.png')
  await page.screenshot({ path: screenshotPath, clip, animations: 'disabled' })
  await test.info().attach('neutral-tap-companions', {
    path: screenshotPath,
    contentType: 'image/png',
  })
  expect(pageErrors).toEqual([])
})

test('a changed producer exposes stale/unproven companion wording while styling interactions stay mutation-free', async ({ page }, testInfo) => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
  })
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2)
  await page.evaluate(() => {
    const concreteInt = { kind: 'concrete', name: 'INT' } as const
    window.__dinksterTest!.app.registerSchemas([{
      type: 'UnprovenSourceTest', displayName: 'Unproven Source', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        { kind: 'input', id: 'value', type: concreteInt, optional: false, widget: { widgetType: 'INT', options: {}, default: 512 } },
        { kind: 'output', id: 'out', type: concreteInt },
      ],
    }, {
      type: 'UnprovenSinkTest', displayName: 'Unproven Sink', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'width', type: concreteInt, optional: false,
        widget: { widgetType: 'INT', options: {}, default: 512 },
      }],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'unproven-companion', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          source: { id: 'source', type: 'UnprovenSourceTest', values: {} },
          sink: { id: 'sink', type: 'UnprovenSinkTest', values: { width: 640 } },
        },
        links: { width: { id: 'width', from: { node: 'source', port: 'out' }, to: { node: 'sink', port: 'width' } } },
        nets: {}, reroutes: {}, nextOrdinal: 5,
      } },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 100, y: 100 } }, sink: { position: { x: 500, y: 100 } },
      } } } },
    }, 'Unproven Companion')
  })
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store && tab.store.doc.lineage === 'unproven-companion'
  })).toBe(true)
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.some((node) => node.id === 'sink'),
  )).toBe(true)
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error('synthetic companion compile failed')
    const ref = { connection: compiled.artifact.connection, prompt: 'synthetic-unproven-companion' }
    const store = app.store as unknown as {
      register(execution: { connection: string; prompt: string }, artifact: unknown, now: number): void
      apply(event: unknown): void
    }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    store.apply({
      kind: 'nodeStates', execution: ref, timestamp: Date.now(),
      nodes: { source: { state: 'done', outputs: { out: { typeId: 'core.int', value: 512 } } } },
    })
    store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() })
  })

  const companions = () => page.evaluate(() => structuredClone((window.__dinksterTest!.renderer as any).companions))
  await expect.poll(companions).toEqual({ sink: { width: { value: 512 } } })
  const geometry = () => page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'sink')!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'width')!
    return { nodeWidth: node.layout.width, rowY: row.y, rowHeight: row.height, inset: row.inset }
  })
  const expectedGeometry = await geometry()
  const revisionBefore = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)

  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'node.setValue', params: { graphId: 'g0', nodeId: 'source', inputId: 'value', value: 513 },
    })
  })
  await expect.poll(companions).toEqual({ sink: { width: { value: 512, stale: true } } })
  expect(await geometry()).toEqual(expectedGeometry)
  const revisionAfterEdit = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)

  const proxy = page.getByTestId('canvas-widget-a11y')
    .filter({ has: page.getByText('Unproven Sink, width', { exact: true }) })
  await proxy.focus()
  await expect(page.getByTestId('app-tooltip')).toContainText('Stale/unproven value: 512')
  await expect(page.getByTestId('app-tooltip')).toContainText('Dormant stored value under connection: 640')
  expect(await proxy.evaluate((element) => getComputedStyle(element.parentElement!).pointerEvents)).toBe('none')

  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'sink')!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'width')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  })
  await proxy.blur()
  await page.mouse.move(1, 1)
  await expect(page.getByTestId('app-tooltip')).toBeHidden()
  await page.mouse.move(point.x, point.y)
  await expect(page.getByTestId('app-tooltip')).toContainText('Stale/unproven value: 512')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revisionAfterEdit)
  expect(revisionAfterEdit).toBe(revisionBefore + 1)

  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1.5 }))
  const screenshotPath = testInfo.outputPath('stale-unproven-companion-dpr-zoom.png')
  await page.screenshot({ path: screenshotPath, animations: 'disabled' })
  await testInfo.attach('stale-unproven-companion-dpr-zoom', {
    path: screenshotPath,
    contentType: 'image/png',
  })
})

test('single-line STRING commits, cancels, and accepts empty string', async ({ page }) => {
  await openEditor(page, 'title'); let input = page.getByTestId('widget-editor').locator('input')
  await input.fill('new title'); await input.press('Enter')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  await openEditor(page, 'title'); input = page.getByTestId('widget-editor').locator('input')
  await input.fill('cancelled'); await input.press('Escape')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.title).toBe('new title')
  await openEditor(page, 'title'); input = page.getByTestId('widget-editor').locator('input')
  await input.fill(''); await input.press('Enter')
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.title).toBe('')
})

test('multiline STRING preserves newlines, modifier-Enter commits, and Escape cancels', async ({ page }) => {
  await openEditor(page, 'notes'); let textarea = page.getByTestId('widget-editor').locator('textarea')
  await expect(textarea).toBeVisible(); await textarea.fill('line one\nline two'); await textarea.press('Control+Enter')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.notes).toBe('line one\nline two')
  await openEditor(page, 'notes'); textarea = page.getByTestId('widget-editor').locator('textarea')
  await textarea.fill('discard'); await textarea.press('Escape')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.notes).toBe('line one\nline two')
})

test('BOOLEAN toggles once per click and one undo restores it', async ({ page }) => {
  await openEditor(page, 'enabled')
  await expect(page.getByTestId('widget-modal-surface')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.enabled).toBe(true)
  await page.keyboard.press('Control+z')
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.enabled).toBeUndefined()
})

test('COLOR commits exact string text without validation, undoes once, and cancels', async ({ page }) => {
  const value = async () => (await activeDoc(page)).graphs.g0!.nodes.widgets!.values.color
  await openEditor(page, 'color')
  let input = page.getByTestId('color-text')
  await expect(input).toHaveValue('#11223380')
  await input.fill('#00ff3380')
  await input.press('Enter')
  await expect(page.getByTestId('color-editor')).toHaveCount(0)
  expect(await value()).toBe('#00ff3380')

  await page.keyboard.press('Control+z')
  expect(await value()).toBeUndefined()

  await openEditor(page, 'color')
  input = page.getByTestId('color-text')
  await input.fill('Not-A-Normalized-Color')
  await input.press('Enter')
  await expect(page.getByTestId('color-editor')).toHaveCount(0)
  expect(await value()).toBe('Not-A-Normalized-Color')

  await page.keyboard.press('Control+z')
  expect(await value()).toBeUndefined()

  await openEditor(page, 'color')
  input = page.getByTestId('color-text')
  await input.fill('#abcdef')
  await input.press('Escape')
  await expect(page.getByTestId('color-editor')).toHaveCount(0)
  expect(await value()).toBeUndefined()
})

test('COLOR anchored popover is non-draggable and retains its specialized picker', async ({ page }) => {
  await openEditor(page, 'color')
  const dialog = page.getByRole('dialog', { name: 'Edit color COLOR' })
  const editor = page.getByTestId('color-editor')
  await expect(editor.getByTestId('widget-editor-label')).toHaveText('color')
  await expect(editor.getByTestId('widget-editor-type')).toHaveText('COLOR')
  const before = await dialog.boundingBox()
  const header = editor.getByTestId('widget-editor-header')
  const headerBox = await header.boundingBox()
  await page.mouse.move(headerBox!.x + 20, headerBox!.y + headerBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(headerBox!.x + 120, headerBox!.y + headerBox!.height / 2)
  await page.mouse.up()
  expect(await dialog.boundingBox()).toEqual(before)
  await expect(editor.getByTestId('widget-editor-resize-handle')).toHaveCount(0)

  const square = await page.getByTestId('color-saturation-value').boundingBox()
  await page.mouse.move(square!.x + square!.width * 0.75, square!.y + square!.height * 0.25)
  await page.mouse.down()
  await page.mouse.move(square!.x + square!.width * 0.9, square!.y + square!.height * 0.4)
  await page.mouse.up()
  await expect(page.getByTestId('color-text')).not.toHaveValue('#11223380')
  await expect(page.getByTestId('color-text')).toHaveValue(/^#[0-9a-f]{6}80$/)
  await page.getByTestId('color-text').fill('#11223344')
  await page.mouse.click(square!.x + square!.width * 0.5, square!.y + square!.height * 0.5)
  await expect(page.getByTestId('color-text')).toHaveValue(/^#[0-9a-f]{6}44$/)
  const picked = await page.getByTestId('color-text').inputValue()
  await editor.getByRole('button', { name: 'Commit' }).click()
  await expect(editor).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.color).toBe(picked)

  await openEditor(page, 'color')
  await page.mouse.click(900, 700)
  await expect(editor).not.toBeVisible()
})

test('static COMBO popover filters, navigates folders, cancels, and handles no options', async ({ page }, testInfo) => {
  await openEditor(page, 'choice')
  const combo = page.getByTestId('combo-dropdown')
  await expect(page.getByRole('dialog', { name: 'Edit choice COMBO' })).toBeVisible()
  await expect(combo.getByTestId('widget-editor-label')).toHaveText('choice')
  await expect(combo.getByTestId('widget-editor-type')).toHaveText('COMBO')
  let search = page.getByTestId('combo-search')
  await search.fill('be')
  await expect(page.getByTestId('combo-option')).toContainText('Detailed decoder')
  await page.getByTestId('combo-option').dispatchEvent('click')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.choice).toBe('dinkster.beta')

  const point = await rowPoint(page, 'choice')
  await page.mouse.click(point.x, point.y, { button: 'right' })
  const reset = page.locator('[data-item-id="core.widget.reset"]')
  await expect(reset).toContainText('Reset to Default')
  await expect(reset).not.toHaveClass(/disabled/)
  await reset.click()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.choice).toBe('dinkster.alpha')

  await page.keyboard.press('Control+z')
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.choice).toBe('dinkster.beta')
  await page.keyboard.press('Control+y')
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await expect(page.locator('[data-item-id="core.widget.reset"]')).toHaveClass(/disabled/)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('context-menu')).not.toBeVisible()

  await openEditor(page, 'choice')
  await expect(page.getByTestId('combo-dropdown')).toContainText('Detailed decoder')
  const rootScreenshot = testInfo.outputPath('structured-combo-root.png')
  await page.screenshot({ path: rootScreenshot, animations: 'disabled' })
  await testInfo.attach('structured-combo-root', { path: rootScreenshot, contentType: 'image/png' })
  await page.getByTestId('combo-folder').dispatchEvent('click')
  await page.getByTestId('combo-folder').dispatchEvent('click')
  await expect(page.getByTestId('combo-folder-navigation')).toContainText('Advanced / Diffusion')
  await expect(page.getByTestId('combo-option')).toContainText('Advanced solver')
  const screenshotPath = testInfo.outputPath('structured-combo-folder.png')
  await page.screenshot({ path: screenshotPath, animations: 'disabled' })
  await testInfo.attach('structured-combo-folder', { path: screenshotPath, contentType: 'image/png' })
  await page.getByTestId('combo-option').dispatchEvent('click')
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.choice).toBe('dinkster.gamma')
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await page.locator('[data-item-id="core.widget.reset"]').click()

  await openEditor(page, 'choice'); search = page.getByTestId('combo-search'); await search.fill('gamma'); await search.press('Escape')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.choice).toBe('dinkster.alpha')
  await openEditor(page, 'empty')
  await expect(page.getByTestId('combo-dropdown')).toContainText('No matching options')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
})

test('ASSET dedicated editor uses the shared modal header', async ({ page }) => {
  await openEditor(page, 'asset')
  const modal = page.getByTestId('widget-modal-surface')
  await expect(page.getByTestId('asset-editor')).toBeVisible()
  await expect(modal).toHaveAccessibleName('Edit asset asset')
  await expect(modal.locator('.dock-title')).toHaveText('asset asset')
})

test('huge COMBO lists render a capped window with paging rows and still commit from the full list', async ({ page }, testInfo) => {
  await page.evaluate(() => {
    window.__dinksterTest!.app.registerSchemas([{
      type: 'HugeComboTest', displayName: 'Huge Combo', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'choice', type: { kind: 'concrete', name: 'core.combo' }, optional: false,
        widget: {
          widgetType: 'COMBO',
          options: { options: Array.from({ length: 1200 }, (_, index) => `option-${index}`) },
          default: 'option-600',
        },
      }],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'huge-combo', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        huge: { id: 'huge', type: 'HugeComboTest', values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { huge: { position: { x: 100, y: 100 } } } } } },
    }, 'Huge Combo')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.getByTestId('graph-canvas').focus()
  const point = await nodeRowPoint(page, 'huge', 'choice')
  await page.mouse.click(point.x, point.y)

  // The 1200-entry list renders a capped window around the deep default.
  const combo = page.getByTestId('combo-dropdown')
  await expect(combo).toBeVisible()
  await expect(page.getByTestId('combo-option')).toHaveCount(300)
  await expect(combo.locator('.combo-option.active')).toHaveText('option-600')
  await expect(page.getByTestId('combo-earlier')).toHaveText('450 earlier options')
  await expect(page.getByTestId('combo-more')).toHaveText('450 more options - type to narrow')
  const screenshotPath = testInfo.outputPath('huge-combo-window.png')
  await page.screenshot({ path: screenshotPath, animations: 'disabled' })
  await testInfo.attach('huge-combo-window', { path: screenshotPath, contentType: 'image/png' })

  // Paging jumps the highlight across the window boundary.
  await page.getByTestId('combo-more').dispatchEvent('click')
  await expect(combo.locator('.combo-option.active')).toHaveText('option-750')
  await expect(page.getByTestId('combo-option')).toHaveCount(300)

  // Narrowing below the cap renders every match without paging rows.
  await page.getByTestId('combo-search').fill('option-99')
  await expect(page.getByTestId('combo-option')).toHaveCount(11)
  await expect(page.getByTestId('combo-earlier')).toHaveCount(0)
  await expect(page.getByTestId('combo-more')).toHaveCount(0)

  // Enter commits the highlighted option from the full filtered list.
  await page.getByTestId('combo-search').press('ArrowDown')
  await page.getByTestId('combo-search').press('Enter')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.huge!.values.choice).toBe('option-990')
})
