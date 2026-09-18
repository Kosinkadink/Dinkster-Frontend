import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from './fixtures.js'

const proofDir = '/tmp/app-view-layout-flow'
const gridProofDir = '/tmp/app-view-layout-grid'
const mobileProofDir = '/tmp/app-view-layout-mobile'

async function registerSchema(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.app.registerSchemas([{
      type: 'AppLayoutTest',
      displayName: 'App Layout Test',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'prompt',
          type: { kind: 'concrete', name: 'STRING' },
          optional: false,
          widget: { widgetType: 'STRING', options: {}, default: 'portrait' },
        },
        {
          kind: 'input',
          id: 'negative',
          type: { kind: 'concrete', name: 'STRING' },
          optional: false,
          widget: { widgetType: 'STRING', options: {}, default: '' },
        },
      ],
    }])
  })
}

async function selectAppView(page: Page): Promise<void> {
  if (await page.getByTestId('app-view').count()) return
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
}

async function enterArrange(page: Page): Promise<void> {
  if (await page.getByTestId('app-view-arrange-toggle').getAttribute('aria-pressed') === 'true') return
  await page.getByTestId('app-view-arrange-toggle').click()
  await expect(page.getByTestId('app-view-arrange-toggle')).toHaveAttribute('aria-pressed', 'true')
}

async function waitForOwnedTab(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === 'app-view-layout-test')
    return tab !== undefined && 'status' in tab.store
  })
}

test.beforeEach(async ({ page }) => {
  mkdirSync(proofDir, { recursive: true })
  mkdirSync(gridProofDir, { recursive: true })
  mkdirSync(mobileProofDir, { recursive: true })
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await registerSchema(page)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'app-view-layout-test',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0',
          name: 'root',
          nodes: { app: { id: 'app', type: 'AppLayoutTest', values: {} } },
          links: {},
          nets: {},
          reroutes: {},
          nextOrdinal: 2,
        },
      },
      view: { graphs: { g0: { nodes: { app: { position: { x: 100, y: 100 } } } } } },
      ext: {
        'dinkster.exposed': [{ graphId: 'g0', nodeId: 'app', inputId: 'prompt', label: 'Prompt' }],
      },
    }, 'App Layout Test')
  })
  await waitForOwnedTab(page)
  await selectAppView(page)
})

test('authors text and a group, renders the clean flow, and restores it after reload', async ({ page }) => {
  expect(await page.getByTestId('app-view').evaluate((element) => getComputedStyle(element).maxWidth)).toBe('720px')
  await enterArrange(page)
  await expect(page.getByTestId('app-layout-palette')).toBeVisible()
  await page.getByTestId('app-layout-add-text').click()
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await page.getByTestId('app-layout-text-input').fill('Build **great** things with [docs](https://example.com).')
  await page.getByTestId('app-layout-text-input').blur()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)
  await page.getByTestId('app-layout-text-role').selectOption('heading')

  await page.getByTestId('app-layout-add-group').click()
  await page.getByTestId('app-layout-group-title').fill('Controls')
  await page.getByTestId('app-layout-group-title').blur()
  await page.getByTestId('app-view-row').getByTestId('app-layout-parent').selectOption({ label: 'Controls' })

  const authored = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'])
  expect(authored).toMatchObject({
    version: 1,
    mobile: { customized: false, items: [] },
    desktop: { items: expect.arrayContaining([
      expect.objectContaining({ kind: 'text', role: 'heading' }),
      expect.objectContaining({ kind: 'group', title: 'Controls' }),
      expect.objectContaining({ kind: 'control', ref: { graphId: 'g0', nodeId: 'app', inputId: 'prompt' } }),
    ]) },
  })
  await page.screenshot({ path: `${proofDir}/01-arrange-text-group.png`, animations: 'disabled' })

  await page.getByTestId('app-view-arrange-toggle').click()
  await expect(page.getByTestId('app-layout-palette')).toHaveCount(0)
  await expect(page.getByTestId('app-layout-text')).toHaveRole('heading')
  await expect(page.getByTestId('app-layout-text').locator('strong')).toHaveText('great')
  const link = page.getByTestId('app-layout-text').getByRole('link', { name: 'docs' })
  await expect(link).toHaveAttribute('href', 'https://example.com/')
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(page.getByTestId('app-layout-group').getByTestId('app-view-row')).toHaveCount(1)
  await page.screenshot({ path: `${proofDir}/02-use-text-group.png`, animations: 'disabled' })

  await setEditorContainerWidth(page, 600)
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'mobile')
  const groupPlacement = page.getByTestId('app-layout-mobile-placement').filter({ has: page.getByTestId('app-layout-group') })
  await expect(groupPlacement).toHaveCount(1)
  expect(await groupPlacement.evaluate((element) => {
    const mobile = element.parentElement!.getBoundingClientRect()
    const group = element.querySelector('[data-testid="app-layout-group"]')!.getBoundingClientRect()
    return Math.abs(element.getBoundingClientRect().width - mobile.width) < 1 &&
      Math.abs(group.width - mobile.width) < 1
  })).toBe(true)
  await setEditorContainerWidth(page, 900)

  await page.evaluate(() => {
    ;(window.__dinksterTest!.app as unknown as { flushPersistTabs(): void }).flushPersistTabs()
  })
  await page.reload()
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await registerSchema(page)
  await waitForOwnedTab(page)
  await selectAppView(page)
  await expect(page.getByTestId('app-view-arrange-toggle')).toHaveAttribute('aria-pressed', 'false')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'])).toEqual(authored)
  await expect(page.getByTestId('app-layout-group').getByTestId('app-view-row')).toHaveCount(1)
  await expect(page.getByTestId('app-layout-text').locator('strong')).toHaveText('great')
})

test('an unexposed placed control is hidden in use mode and removable in arrange mode', async ({ page }) => {
  await enterArrange(page)
  await page.getByTestId('app-layout-add-group').click()
  await page.getByTestId('app-layout-group-title').fill('Controls')
  await page.getByTestId('app-layout-group-title').blur()
  await page.getByTestId('app-view-row').getByTestId('app-layout-parent').selectOption({ label: 'Controls' })

  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'params.unexpose',
      params: { graphId: 'g0', nodeId: 'app', inputId: 'prompt' },
    })
  })
  await expect(page.getByTestId('app-layout-missing')).toContainText('control is no longer exposed')
  await page.getByTestId('app-view-arrange-toggle').click()
  await expect(page.getByTestId('app-layout-missing')).toHaveCount(0)
  await expect(page.getByTestId('app-view-row')).toHaveCount(0)

  await enterArrange(page)
  await page.getByTestId('app-layout-missing').getByTestId('app-layout-remove').click()
  await expect(page.getByTestId('app-layout-missing')).toHaveCount(0)
})

test('places promoted controls so text can be ordered between them', async ({ page }) => {
  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'params.expose',
      params: { graphId: 'g0', nodeId: 'app', inputId: 'negative', label: 'Negative prompt' },
    })
  })
  await enterArrange(page)
  await page.getByTestId('app-layout-add-text').click()
  await page.getByTestId('app-layout-text-input').fill('Between controls')
  await page.getByTestId('app-layout-text-input').blur()

  const prompt = page.getByTestId('app-view-row').nth(0)
  const negative = page.getByTestId('app-view-row').nth(1)
  await prompt.getByRole('button', { name: 'Place Prompt in flow' }).click()
  await negative.getByRole('button', { name: 'Place Negative prompt in flow' }).click()

  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await page.getByTestId('app-layout-text-editor').getByRole('button', { name: 'Move text down' }).click()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)

  expect(await page.evaluate(() => {
    const layout = window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'] as {
      desktop: { items: { kind: string; ref?: { inputId?: string } }[] }
    }
    return layout.desktop.items.map((item) => item.kind === 'control' ? item.ref?.inputId : item.kind)
  })).toEqual(['prompt', 'text', 'negative'])

  await page.getByTestId('app-view-arrange-toggle').click()
  const flowText = await page.locator('.app-view-rows').innerText()
  expect(flowText.indexOf('Prompt')).toBeLessThan(flowText.indexOf('Between controls'))
  expect(flowText.indexOf('Between controls')).toBeLessThan(flowText.indexOf('Negative prompt'))
})

test('places, drags, keyboard-moves, resizes, collides, and cancels grid placements', async ({ page }) => {
  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'params.expose',
      params: { graphId: 'g0', nodeId: 'app', inputId: 'negative', label: 'Negative prompt' },
    })
  })
  await enterArrange(page)

  let revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await page.getByRole('button', { name: 'Place Prompt in grid' }).click()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)
  revision += 1
  await page.getByRole('button', { name: 'Place Negative prompt in grid' }).click()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)
  revision += 1
  await expect(page.getByTestId('app-layout-grid-placement')).toHaveCount(2)
  await expect(page.getByTestId('app-layout-grid')).toHaveClass(/arrange/)
  expect(await page.getByTestId('app-view').evaluate((element) => getComputedStyle(element).maxWidth)).toBe('1120px')

  const prompt = page.getByLabel('Grid placement: Prompt', { exact: true })
  const negative = page.getByLabel('Grid placement: Negative prompt', { exact: true })
  const promptBox = await prompt.boundingBox()
  const negativeBox = await negative.boundingBox()
  const dragBox = await negative.getByTestId('app-layout-grid-drag').boundingBox()
  if (promptBox === null || negativeBox === null || dragBox === null) throw new Error('grid drag geometry unavailable')
  await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    dragBox.x + dragBox.width / 2 + promptBox.x - negativeBox.x,
    dragBox.y + dragBox.height / 2 + promptBox.y - negativeBox.y,
    { steps: 6 },
  )
  await expect(page.getByTestId('app-layout-grid-ghost')).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await page.screenshot({ path: `${gridProofDir}/01-arrange-mid-drag.png`, animations: 'disabled' })
  await page.mouse.up()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)
  revision += 1

  expect(await page.evaluate(() => {
    const items = (window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'] as any).desktop.items
    const byInput = Object.fromEntries(items.filter((item: any) => item.kind === 'control').map((item: any) => [item.ref.inputId, item]))
    return { promptY: byInput.prompt.y, negativeY: byInput.negative.y }
  })).toEqual({ promptY: 2, negativeY: 0 })

  await negative.focus()
  await page.keyboard.press('ArrowRight')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)
  revision += 1
  await expect(negative).toHaveAttribute('data-grid-x', '1')

  await negative.focus()
  await page.keyboard.down('ArrowRight')
  await page.keyboard.down('ArrowRight')
  await page.keyboard.down('ArrowRight')
  await expect(page.getByTestId('app-layout-grid-ghost')).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await page.keyboard.up('ArrowRight')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)
  revision += 1
  await expect(negative).toHaveAttribute('data-grid-x', '4')

  await negative.focus()
  await page.keyboard.press('Shift+ArrowDown')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)
  revision += 1
  await expect(negative).toHaveAttribute('data-grid-h', '3')

  await negative.focus()
  await page.keyboard.down('ArrowLeft')
  await expect(page.getByTestId('app-layout-grid-ghost')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.up('ArrowLeft')
  await expect(page.getByTestId('app-layout-grid-ghost')).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await expect(negative).toHaveAttribute('data-grid-x', '4')

  const corner = negative.getByTestId('app-layout-grid-resize-corner')
  const cornerBox = await corner.boundingBox()
  if (cornerBox === null) throw new Error('grid resize geometry unavailable')
  await page.mouse.move(cornerBox.x + cornerBox.width / 2, cornerBox.y + cornerBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(cornerBox.x + cornerBox.width / 2 + 90, cornerBox.y + cornerBox.height / 2 + 76, { steps: 4 })
  await expect(page.getByTestId('app-layout-grid-ghost')).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await page.mouse.up()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)
  revision += 1
  await expect(negative).toHaveAttribute('data-grid-w', '7')
  await expect(negative).toHaveAttribute('data-grid-h', '4')
  expect(await page.evaluate(() => {
    const items = (window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'] as any).desktop.items
      .filter((item: any) => Number.isInteger(item.x))
    return items.every((left: any, index: number) => items.slice(index + 1).every((right: any) =>
      left.x + left.w <= right.x || right.x + right.w <= left.x ||
      left.y + left.h <= right.y || right.y + right.h <= left.y))
  })).toBe(true)

  const cancelHandle = negative.getByTestId('app-layout-grid-drag')
  const cancelBox = await cancelHandle.boundingBox()
  if (cancelBox === null) throw new Error('grid cancel geometry unavailable')
  await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(cancelBox.x + cancelBox.width / 2 + 90, cancelBox.y + cancelBox.height / 2 + 76)
  await expect(page.getByTestId('app-layout-grid-ghost')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('app-layout-grid-ghost')).toHaveCount(0)
  await page.mouse.up()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await page.screenshot({ path: `${gridProofDir}/02-arrange-grid.png`, animations: 'disabled' })
})

test('preserves grid and flow text drafts when another grid placement changes', async ({ page }) => {
  await enterArrange(page)

  await page.getByTestId('app-layout-add-text').click()
  let flowEditor = page.getByTestId('app-layout-flow').getByTestId('app-layout-text-input')
  await flowEditor.fill('Grid text')
  await flowEditor.blur()
  await page.getByRole('button', { name: 'Place Grid text in grid' }).click()

  await page.getByTestId('app-layout-add-text').click()
  flowEditor = page.getByTestId('app-layout-flow').getByTestId('app-layout-text-input')
  await flowEditor.fill('Flow text')
  await flowEditor.blur()
  await page.getByRole('button', { name: 'Place Prompt in grid' }).click()

  const gridEditor = page.getByLabel('Grid placement: Grid text', { exact: true })
    .getByTestId('app-layout-text-input')
  expect(await page.evaluate(() => {
    const items = (window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'] as any).desktop.items
    return items.filter((item: any) => item.kind === 'text').map((item: any) => item.text)
  })).toEqual(['Grid text', 'Flow text'])

  const movePrompt = async (x: number): Promise<void> => page.evaluate((nextX) => {
    const store = window.__dinksterTest!.app.activeTab()!.store
    const prompt = ((store.doc.ext?.['dinkster.appLayout'] as any).desktop.items as any[])
      .find((item) => item.kind === 'control' && item.ref.inputId === 'prompt')
    store.dispatch({
      command: 'app.layout.setGrid',
      params: { id: prompt.id, grid: { x: nextX, y: 2, w: 6, h: 2 } },
    })
  }, x)

  await gridEditor.fill('Uncommitted grid draft')
  await movePrompt(6)
  await expect(gridEditor).toHaveValue('Uncommitted grid draft')

  await flowEditor.fill('Uncommitted flow draft')
  await movePrompt(5)
  await expect(flowEditor).toHaveValue('Uncommitted flow draft')
})

test('renders mixed grid and flow in row-major DOM order and restores it after reload', async ({ page }) => {
  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'params.expose',
      params: { graphId: 'g0', nodeId: 'app', inputId: 'negative', label: 'Negative prompt' },
    })
  })
  await enterArrange(page)
  await page.getByTestId('app-layout-add-text').click()
  await page.getByTestId('app-layout-text-input').fill('Flow-only instructions')
  await page.getByTestId('app-layout-text-input').blur()
  await page.getByRole('button', { name: 'Place Prompt in grid' }).click()
  await page.getByRole('button', { name: 'Place Negative prompt in grid' }).click()

  const ids = await page.evaluate(() => {
    const store = window.__dinksterTest!.app.activeTab()!.store
    const items = (store.doc.ext?.['dinkster.appLayout'] as any).desktop.items
    const controls = Object.fromEntries(items.filter((item: any) => item.kind === 'control').map((item: any) => [item.ref.inputId, item.id]))
    store.dispatch({ command: 'app.layout.setGrid', params: { id: controls.prompt, grid: { x: 6, y: 0, w: 6, h: 2 } } })
    store.dispatch({ command: 'app.layout.setGrid', params: { id: controls.negative, grid: { x: 0, y: 0, w: 6, h: 2 } } })
    return controls
  })
  expect(ids).toMatchObject({ prompt: expect.any(String), negative: expect.any(String) })
  const authored = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'])

  await page.getByTestId('app-view-arrange-toggle').click()
  await expect(page.getByTestId('app-layout-grid')).not.toHaveClass(/arrange/)
  await expect(page.getByTestId('app-layout-grid-drag')).toHaveCount(0)
  await expect(page.getByTestId('app-layout-flow')).toContainText('Flow-only instructions')
  expect(await page.getByTestId('app-layout-grid').getByTestId('app-view-label').allTextContents()).toEqual([
    'Negative promptAppLayoutTest',
    'PromptAppLayoutTest',
  ])
  const appText = await page.getByTestId('app-view').innerText()
  expect(appText.indexOf('Negative prompt')).toBeLessThan(appText.indexOf('Prompt'))
  expect(appText.indexOf('Prompt')).toBeLessThan(appText.indexOf('Flow-only instructions'))
  await page.screenshot({ path: `${gridProofDir}/03-use-mixed-grid-flow.png`, animations: 'disabled' })

  await page.evaluate(() => {
    ;(window.__dinksterTest!.app as unknown as { flushPersistTabs(): void }).flushPersistTabs()
  })
  await page.reload()
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await registerSchema(page)
  await waitForOwnedTab(page)
  await selectAppView(page)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'])).toEqual(authored)
  await expect(page.getByTestId('app-layout-grid-placement')).toHaveCount(2)
  await expect(page.getByTestId('app-layout-flow')).toContainText('Flow-only instructions')
})

async function authorMobileFixture(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'params.expose',
      params: { graphId: 'g0', nodeId: 'app', inputId: 'negative', label: 'Negative prompt' },
    })
  })
  await enterArrange(page)
  await page.getByTestId('app-layout-add-text').click()
  await page.getByTestId('app-layout-text-input').fill('Mobile instructions')
  await page.getByTestId('app-layout-text-input').blur()
  await page.getByRole('button', { name: 'Place Prompt in grid' }).click()
  await page.getByRole('button', { name: 'Place Negative prompt in grid' }).click()
  await page.evaluate(() => {
    const store = window.__dinksterTest!.app.activeTab()!.store
    const items = (store.doc.ext?.['dinkster.appLayout'] as any).desktop.items
    const controls = Object.fromEntries(items.filter((item: any) => item.kind === 'control')
      .map((item: any) => [item.ref.inputId, item.id]))
    store.dispatch({ command: 'app.layout.setGrid', params: { id: controls.negative, grid: { x: 0, y: 0, w: 6, h: 2 } } })
    store.dispatch({ command: 'app.layout.setGrid', params: { id: controls.prompt, grid: { x: 6, y: 0, w: 6, h: 2 } } })
  })
  await page.getByTestId('app-view-arrange-toggle').click()
}

async function setEditorContainerWidth(page: Page, width: number): Promise<void> {
  await page.locator('.canvas-stage').evaluate((element, nextWidth) => {
    element.style.width = `${nextWidth}px`
  }, width)
  await expect.poll(() => page.locator('.canvas-stage').evaluate((element) => element.getBoundingClientRect().width))
    .toBe(width)
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

test('preserves a focused widget draft across the mobile threshold in both directions', async ({ page }) => {
  await setEditorContainerWidth(page, 900)
  const editor = page.getByTestId('app-view-text')
  await editor.fill('Wide uncommitted draft')
  await expect(editor).toBeFocused()

  await setEditorContainerWidth(page, 600)
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'desktop')
  await expect(editor).toHaveValue('Wide uncommitted draft')
  await expect(editor).toBeFocused()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0?.nodes.app?.values?.prompt)).toBeUndefined()

  await page.getByTestId('app-view-queue').focus()
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'mobile')
  await expect(editor).toHaveValue('Wide uncommitted draft')

  await editor.fill('Mobile uncommitted draft')
  await expect(editor).toBeFocused()
  await setEditorContainerWidth(page, 900)
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'mobile')
  await expect(editor).toHaveValue('Mobile uncommitted draft')
  await expect(editor).toBeFocused()

  await page.getByTestId('app-view-queue').focus()
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'desktop')
  await expect(editor).toHaveValue('Mobile uncommitted draft')
})

test('applies a deferred responsive switch when the focused placement is removed', async ({ page }) => {
  await setEditorContainerWidth(page, 900)
  const editor = page.getByTestId('app-view-text')
  await editor.fill('Draft on removed placement')
  await expect(editor).toBeFocused()

  await setEditorContainerWidth(page, 600)
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'desktop')
  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'params.unexpose',
      params: { graphId: 'g0', nodeId: 'app', inputId: 'prompt' },
    })
  })

  await expect(editor).toHaveCount(0)
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'mobile')
})

test('ignores another App View portal draft scope', async ({ page }) => {
  await setEditorContainerWidth(page, 900)
  await page.evaluate(() => {
    const otherDraft = document.createElement('input')
    otherDraft.dataset['testid'] = 'other-app-view-draft'
    otherDraft.dataset['appViewDraftScope'] = 'other-app-view'
    document.body.append(otherDraft)
    otherDraft.focus()
  })
  await expect(page.getByTestId('other-app-view-draft')).toBeFocused()

  await setEditorContainerWidth(page, 600)
  await expect(page.getByTestId('other-app-view-draft')).toBeFocused()
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'mobile')
})

test('commits an authored text draft before an explicit breakpoint switch', async ({ page }) => {
  await setEditorContainerWidth(page, 900)
  await enterArrange(page)
  await page.getByTestId('app-layout-add-text').click()
  const editor = page.getByTestId('app-layout-text-input')
  await editor.fill('Breakpoint-safe draft')
  await expect(editor).toBeFocused()

  await page.getByTestId('app-layout-breakpoint-mobile').click()
  await expect(page.getByTestId('app-layout-breakpoint-mobile')).toHaveAttribute('aria-pressed', 'true')
  await expect(editor).toHaveValue('Breakpoint-safe draft')
  expect(await page.evaluate(() => {
    const items = (window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'] as any).desktop.items
    return items.find((item: any) => item.kind === 'text')?.text
  })).toBe('Breakpoint-safe draft')
})

test('preserves a focused mobile draft when another placement moves', async ({ page }) => {
  await authorMobileFixture(page)
  await setEditorContainerWidth(page, 600)
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'mobile')
  const prompt = page.getByTestId('app-view-row').filter({
    has: page.getByTestId('app-view-label').filter({ hasText: /^Prompt/ }),
  }).getByTestId('app-view-text')
  await prompt.fill('Uncommitted mobile draft')
  await expect(prompt).toBeFocused()
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)

  await page.evaluate(() => {
    const store = window.__dinksterTest!.app.activeTab()!.store
    const items = (store.doc.ext?.['dinkster.appLayout'] as any).desktop.items
    const text = items.find((item: any) => item.kind === 'text')
    store.dispatch({ command: 'app.layout.moveMobile', params: { id: text.id, index: 0 } })
  })

  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)
  await expect(prompt).toHaveValue('Uncommitted mobile draft')
  await expect(prompt).toBeFocused()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0?.nodes.app?.values?.prompt)).toBeUndefined()
  expect(await page.evaluate(() => (window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'] as any).mobile.customized)).toBe(true)
})

test('updates another mobile placement while preserving the focused draft', async ({ page }) => {
  await authorMobileFixture(page)
  await setEditorContainerWidth(page, 600)
  const prompt = page.getByTestId('app-view-row').filter({
    has: page.getByTestId('app-view-label').filter({ hasText: /^Prompt/ }),
  }).getByTestId('app-view-text')
  await prompt.fill('Uncommitted mobile draft')
  await expect(prompt).toBeFocused()

  await page.evaluate(() => {
    const store = window.__dinksterTest!.app.activeTab()!.store
    const items = (store.doc.ext?.['dinkster.appLayout'] as any).desktop.items
    const text = items.find((item: any) => item.kind === 'text')
    store.dispatch({
      command: 'app.layout.setText',
      params: { id: text.id, text: 'Updated mobile instructions' },
    })
  })

  await expect(page.getByTestId('app-layout-text')).toHaveText('Updated mobile instructions')
  await expect(prompt).toHaveValue('Uncommitted mobile draft')
  await expect(prompt).toBeFocused()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0?.nodes.app?.values?.prompt)).toBeUndefined()
})

test('removes mobile placements with and without a focused draft', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await authorMobileFixture(page)
  await setEditorContainerWidth(page, 600)
  await enterArrange(page)
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'mobile')

  await page.getByTestId('app-layout-add-text').click()
  const addedEditor = page.getByTestId('app-layout-text-input').last()
  await addedEditor.fill('Second removable text')
  await addedEditor.blur()
  await expect(page.getByTestId('app-layout-mobile-placement')).toHaveCount(4)

  const prompt = page.getByTestId('app-view-row').filter({
    has: page.getByTestId('app-view-label').filter({ hasText: /^Prompt/ }),
  }).getByTestId('app-view-text')
  await prompt.fill('Uncommitted removal draft')
  await expect(prompt).toBeFocused()

  await page.evaluate(() => {
    const store = window.__dinksterTest!.app.activeTab()!.store
    const items = (store.doc.ext?.['dinkster.appLayout'] as any).desktop.items
    const text = items.find((item: any) => item.kind === 'text' && item.text === 'Mobile instructions')
    store.dispatch({ command: 'app.layout.remove', params: { id: text.id } })
  })

  await expect(page.getByTestId('app-layout-mobile-placement')).toHaveCount(3)
  await expect(prompt).toHaveValue('Uncommitted removal draft')
  await expect(prompt).toBeFocused()
  expect(pageErrors).toEqual([])

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(page.locator('body')).toBeFocused()
  await page.getByTestId('app-layout-text-editor').getByTestId('app-layout-remove')
    .evaluate((button) => (button as HTMLButtonElement).click())
  await expect(page.getByTestId('app-layout-mobile-placement')).toHaveCount(2)
  await expect(page.getByTestId('app-layout-text-input')).toHaveCount(0)
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'mobile')
  expect(pageErrors).toEqual([])
})

test('uses container-width mobile order and supports customize, resize, and reset', async ({ page }) => {
  await authorMobileFixture(page)
  await setEditorContainerWidth(page, 600)
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'mobile')
  await expect(page.getByTestId('app-layout-grid')).toHaveCount(0)
  let mobile = page.getByTestId('app-layout-mobile-placement')
  await expect(mobile).toHaveCount(3)
  const mobileWidth = await page.getByTestId('app-layout-mobile').evaluate((element) => element.getBoundingClientRect().width)
  expect(await mobile.evaluateAll((elements, expectedWidth) => elements.every((element) =>
    Math.abs(element.getBoundingClientRect().width - expectedWidth) < 1), mobileWidth)).toBe(true)
  expect(await mobile.allInnerTexts()).toEqual(expect.arrayContaining([
    expect.stringContaining('Negative prompt'),
    expect.stringContaining('Prompt'),
    expect.stringContaining('Mobile instructions'),
  ]))
  const automaticText = await page.getByTestId('app-layout-mobile').innerText()
  expect(automaticText.indexOf('Negative prompt')).toBeLessThan(automaticText.indexOf('Prompt'))
  expect(automaticText.indexOf('Prompt')).toBeLessThan(automaticText.indexOf('Mobile instructions'))

  await enterArrange(page)
  await expect(page.getByTestId('app-layout-breakpoint-mobile')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('app-view').evaluate((element) => getComputedStyle(element).maxWidth)).resolves.toBe('520px')
  const instructions = page.getByTestId('app-layout-mobile-placement').filter({ hasText: 'Mobile instructions' })
  const first = page.getByTestId('app-layout-mobile-placement').first()
  let revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await instructions.getByTestId('app-layout-mobile-drag').dragTo(first)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)
  revision += 1
  expect(await page.evaluate(() => (window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'] as any).mobile.customized)).toBe(true)
  await expect(page.getByTestId('app-layout-reset-mobile')).toBeVisible()

  await instructions.focus()
  await page.keyboard.down('ArrowDown')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await page.keyboard.up('ArrowDown')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)
  await page.getByTestId('app-view').evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: `${mobileProofDir}/01-arrange-mobile.png`, animations: 'disabled' })

  await setEditorContainerWidth(page, 900)
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'mobile')
  await page.getByTestId('app-view-arrange-toggle').click()
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'desktop')
  await expect(page.getByTestId('app-layout-grid-placement')).toHaveCount(2)

  await setEditorContainerWidth(page, 600)
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'mobile')
  const customizedText = await page.getByTestId('app-layout-mobile').innerText()
  expect(customizedText.indexOf('Negative prompt')).toBeLessThan(customizedText.indexOf('Mobile instructions'))
  expect(customizedText.indexOf('Mobile instructions')).toBeLessThan(customizedText.indexOf('Prompt'))

  await enterArrange(page)
  const beforeReset = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await page.getByTestId('app-layout-reset-mobile').click()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(beforeReset + 1)
  expect(await page.evaluate(() => (window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'] as any).mobile)).toEqual({
    customized: false,
    items: [],
  })
  await page.getByTestId('app-view-arrange-toggle').click()
  const resetText = await page.getByTestId('app-layout-mobile').innerText()
  expect(resetText.indexOf('Negative prompt')).toBeLessThan(resetText.indexOf('Prompt'))
  expect(resetText.indexOf('Prompt')).toBeLessThan(resetText.indexOf('Mobile instructions'))
  await page.screenshot({ path: `${mobileProofDir}/02-use-narrow.png`, animations: 'disabled' })
})

test('renders the mobile presentation in a narrow workflow pop-out', async ({ page }) => {
  await authorMobileFixture(page)
  const popupPromise = page.waitForEvent('popup')
  await page.getByTestId('tab-bar').locator('.tab', { hasText: 'App Layout Test' }).click({ button: 'right' })
  await page.getByTestId('context-menu').locator('[data-item-id="workflow.openWindow"]').click()
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded')
  await expect(popup.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await registerSchema(popup)
  await popup.setViewportSize({ width: 560, height: 800 })
  if (await popup.getByTestId('rail-toggle').getAttribute('aria-pressed') === 'true') {
    await popup.getByTestId('rail-toggle').click()
  }
  await popup.getByTestId('rail-toggle').blur()
  await popup.mouse.move(300, 700)
  await expect(popup.getByTestId('app-tooltip')).toHaveCount(0)
  await expect(popup.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'mobile')
  await expect(popup.getByTestId('app-layout-mobile-placement')).toHaveCount(3)
  await expect(popup.getByTestId('app-layout-grid')).toHaveCount(0)
  await popup.screenshot({ path: `${mobileProofDir}/03-use-popout.png`, animations: 'disabled' })
  await popup.close()
})
