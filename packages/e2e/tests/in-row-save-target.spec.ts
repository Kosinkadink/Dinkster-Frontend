import { expect, nativeTest as test, waitForWorkspaceReady, type Page, type Route } from './fixtures.js'

const READY = {
  outputMount: 'output',
  activeOutputMount: 'output',
  mounts: [
    { id: 'output', mode: 'readwrite', state: 'ready' },
    { id: 'archive', mode: 'readwrite', state: 'ready' },
    { id: 'reference', mode: 'read', state: 'ready' },
    { id: 'offline', mode: 'readwrite', state: 'missing' },
  ],
}

type Mounts = (route: Route) => Promise<void> | void

/**
 * A Save image node with a required target and a Gallery node whose target
 * may be empty, both edited in their rows and both declaring Project default
 * with the name ComfyUI as their default. A Source node can wire a target
 * into the Save image node.
 */
async function openTargets(page: Page, mounts: Mounts = (route) => route.fulfill({ json: READY }), options: { wired?: boolean } = {}): Promise<void> {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'save-target-fixture', schemaWire: 1 }, nodes: {},
  } }))
  await page.route('/api/mounts*', mounts)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await waitForWorkspaceReady(page)
  const close = page.locator('.template-gallery-close')
  if ((await close.count()) > 0 && (await close.first().isVisible())) await close.first().click()
  await page.evaluate(async (wired) => {
    const target = (optional: boolean) => ({
      kind: 'input', id: 'target', type: { kind: 'concrete', name: 'dinkster.save_target' }, optional,
      ...(optional ? {} : { tooltip: 'Where the saved images are written.' }),
      widget: { widgetType: 'SAVE_TARGET', options: { suffix: '.png' }, default: { prefix: 'ComfyUI' } },
    })
    const image = { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false }
    window.__dinksterTest!.app.registerSchemas([
      { type: 'SaveImage', displayName: 'Save image', category: 'test', source: 'v3', isOutputNode: true, items: [image, target(false), { kind: 'input', id: 'quality', type: { kind: 'concrete', name: 'INT' }, optional: false, widget: { widgetType: 'INT', options: { min: 1, max: 100 }, default: 90 } }] },
      { type: 'Gallery', displayName: 'Gallery', category: 'test', source: 'v3', isOutputNode: true, items: [image, target(true)] },
      { type: 'TargetSource', displayName: 'Target source', category: 'test', source: 'v3', isOutputNode: false, items: [{ kind: 'output', id: 'target', type: { kind: 'concrete', name: 'dinkster.save_target' } }] },
    ] as never)
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'save-target-box', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        save: { id: 'save', type: 'SaveImage', values: { target: { mount: 'output', prefix: 'renders/portrait' }, quality: 90 } },
        gallery: { id: 'gallery', type: 'Gallery', values: { target: { mount: 'output', prefix: 'gallery/shots' } } },
        ...(wired ? { source: { id: 'source', type: 'TargetSource', values: {} } } : {}),
      }, links: wired ? { l1: { id: 'l1', from: { node: 'source', port: 'target' }, to: { node: 'save', port: 'target' } } } : {}, nets: {}, reroutes: {}, nextOrdinal: 4 } },
      view: { graphs: { g0: { nodes: {
        save: { position: { x: 80, y: 80 } },
        gallery: { position: { x: 80, y: 360 } },
        ...(wired ? { source: { position: { x: -300, y: 80 } } } : {}),
      } } } },
    } as never, 'Save targets')
    window.__dinksterTest!.renderer!.setViewport({ x: 100, y: 0, scale: 1 })
  }, options.wired === true)
}

async function rowPoint(page: Page, nodeId: string, inputId: string): Promise<{ x: number; y: number }> {
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

const target = (page: Page, nodeId = 'save') => page.evaluate((nodeId) => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes[nodeId]!.values['target'], nodeId)
const undo = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
const box = (page: Page) => page.locator('.widget-in-row-field .dinkster-canvas-target-box')
const mount = (page: Page) => page.locator('.dinkster-canvas-target-choice')
const prefix = (page: Page) => page.getByRole('textbox', { name: 'Relative filename prefix' })
const side = (page: Page) => page.locator('.widget-in-row-field .dinkster-canvas-field-side')
const rowValue = (page: Page) => page.locator('.widget-in-row-field .dinkster-canvas-field-input')

async function openRow(page: Page, nodeId = 'save'): Promise<void> {
  const point = await rowPoint(page, nodeId, 'target')
  await page.mouse.click(point.x, point.y)
  await expect(box(page)).toBeVisible()
}

async function pickMount(page: Page, id: string): Promise<void> {
  await mount(page).click()
  await page.getByRole('option', { name: id, exact: true }).click()
  await expect(page.getByRole('listbox', { name: 'Writable mount' })).toHaveCount(0)
}

test('a picked mount and typed name are stored together on leaving, as one undo step; Escape stores nothing', async ({ page }, testInfo) => {
  await openTargets(page)
  const stored = { mount: 'output', prefix: 'renders/portrait' }
  const leaves: readonly [string, (page: Page) => Promise<void>, { mount: string; prefix: string }][] = [
    ['Enter', (page) => page.keyboard.press('Enter'), { mount: 'archive', prefix: 'renders/final' }],
    ['Tab', (page) => page.keyboard.press('Tab'), { mount: 'archive', prefix: 'renders/tab' }],
    ['a click outside', async (page) => { await page.mouse.click(900, 700) }, { mount: 'archive', prefix: 'renders/click' }],
  ]
  for (const [how, leave, expected] of leaves) {
    await openRow(page)
    await expect(prefix(page)).toBeFocused()
    await expect(rowValue(page)).toHaveValue('output/renders/portrait')
    await expect(side(page)).toContainText('Enter keeps output/renders/portrait')
    // Under the divider, the input's tooltip comes before the naming help.
    await expect(side(page).locator('.dinkster-canvas-target-help')).toHaveText(['Where the saved images are written.', 'Subfolders and filename stem only. The writer adds numbering and .png.'])
    await pickMount(page, 'archive')
    await prefix(page).fill(expected.prefix)
    await expect(rowValue(page)).toHaveValue(`archive/${expected.prefix}`)
    await expect(side(page)).toContainText(`Enter stores archive/${expected.prefix}`)
    if (how === 'Enter') await page.screenshot({ path: testInfo.outputPath('changed.png') })
    expect(await target(page), how).toEqual(stored)
    await leave(page)
    await expect.poll(() => target(page), how).toEqual(expected)
    if (how === 'Tab') {
      // Tab opens the next row of the node.
      await expect(page.locator('.widget-in-row-field input')).toHaveAttribute('aria-label', 'quality')
      await page.keyboard.press('Escape')
    }
    await expect(box(page)).toHaveCount(0)
    expect(await undo(page), how).toBe(true)
    expect(await target(page), how).toEqual(stored)
  }
  await openRow(page)
  await pickMount(page, 'archive')
  await prefix(page).fill('renders/escaped')
  await page.keyboard.press('Escape')
  await expect(box(page)).toHaveCount(0)
  expect(await target(page)).toEqual(stored)
})

test('while mounts load, when none is ready and when they cannot be read, nothing is stored', async ({ page }) => {
  let release: (() => void) | undefined
  const cases: readonly [string, Mounts, string][] = [
    ['loading', async (route) => { await new Promise<void>((resolve) => { release = resolve }); await route.fulfill({ json: READY }) }, 'Loading mounts'],
    ['none', (route) => route.fulfill({ json: { mounts: [{ id: 'reference', mode: 'read', state: 'ready' }, { id: 'offline', mode: 'readwrite', state: 'missing' }] } }), 'No mount ready'],
    ['failed', (route) => route.fulfill({ status: 500, json: { error: 'mount settings unavailable' } }), 'Could not load'],
  ]
  for (const [state, handler, words] of cases) {
    await openTargets(page, handler)
    await openRow(page)
    await expect(mount(page), state).toHaveAttribute('data-state', state)
    await expect(mount(page), state).toContainText(words)
    if (state === 'none') await expect(side(page)).toContainText('No ready writable mounts. Add or reconnect a writable folder in mount settings.')
    // The error's own sentence leads the side part; the box holds only the few words.
    if (state === 'failed') {
      await expect(side(page).locator('.dinkster-canvas-target-error')).not.toBeEmpty()
      await expect(side(page).locator('p').first()).toHaveClass('dinkster-canvas-target-error')
      await expect(box(page).locator('.dinkster-canvas-target-note')).toHaveCount(0)
    }
    // The list does not open, and a typed name cannot be stored.
    await mount(page).click({ force: true })
    await expect(page.getByRole('listbox', { name: 'Writable mount' }), state).toHaveCount(0)
    await prefix(page).fill('renders/other')
    await expect(side(page), state).toContainText('Enter keeps output/renders/portrait')
    await page.keyboard.press('Enter')
    await expect(box(page), state).toHaveCount(0)
    expect(await target(page), state).toEqual({ mount: 'output', prefix: 'renders/portrait' })
    release?.()
    release = undefined
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
})

test('a stored mount this machine lacks stays stored until another mount or Use project default is picked', async ({ page }) => {
  await openTargets(page)
  await page.evaluate(() => window.__dinksterTest!.app.dispatchTo(window.__dinksterTest!.app.activeTab()!, {
    command: 'node.setValue', params: { graphId: 'g0', nodeId: 'save', inputId: 'target', value: { mount: 'usb1', prefix: 'renders/portrait' } },
  }))
  await openRow(page)
  await expect(mount(page)).toHaveAttribute('data-unavailable', 'true')
  await expect(mount(page)).toContainText('usb1')
  await expect(side(page)).toContainText('usb1 is not on this machine. Saving to output.')
  await prefix(page).fill('renders/renamed')
  await expect(side(page)).toContainText('Enter keeps usb1/renders/portrait')
  // In the list the missing mount is dimmed and cannot be picked.
  await mount(page).click()
  const missing = page.getByRole('option', { name: 'usb1 (not on this machine)' })
  await expect(missing).toHaveAttribute('aria-disabled', 'true')
  await missing.click({ force: true })
  await expect(page.getByRole('listbox', { name: 'Writable mount' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox', { name: 'Writable mount' })).toHaveCount(0)
  await expect(box(page)).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(box(page)).toHaveCount(0)
  expect(await target(page)).toEqual({ mount: 'usb1', prefix: 'renders/portrait' })
  // Use project default puts the box on Project default; leaving stores no mount.
  await openRow(page)
  await side(page).getByRole('button', { name: 'Use project default' }).click()
  await expect(mount(page)).toContainText('Project default')
  await expect(side(page)).not.toContainText('not on this machine')
  await expect(side(page)).toContainText('Enter stores output/renders/portrait')
  await page.keyboard.press('Enter')
  await expect.poll(() => target(page)).toEqual({ prefix: 'renders/portrait' })
})

test('a name that cannot be used is not stored and the earlier target stays', async ({ page }) => {
  await openTargets(page)
  for (const bad of ['../escape', 'a//b', 'back\\slash', './here']) {
    await openRow(page)
    await prefix(page).fill(bad)
    await expect(prefix(page), bad).toHaveAttribute('aria-invalid', 'true')
    await expect(box(page), bad).toContainText('Enter a relative prefix with no empty, dot or parent segments and no backslashes.')
    await expect(side(page), bad).toContainText('Enter keeps output/renders/portrait')
    await page.keyboard.press('Enter')
    await expect(box(page), bad).toHaveCount(0)
    expect(await target(page), bad).toEqual({ mount: 'output', prefix: 'renders/portrait' })
  }
})

test('Project default stores no mount, an empty target opens on it with the default name, and the default is a link', async ({ page }) => {
  await openTargets(page)
  // Picking Project default stores only the name; the row names the mount it means here.
  await openRow(page, 'gallery')
  await expect(side(page).locator('.dinkster-canvas-target-help')).toHaveText(['Subfolders and filename stem only. The writer adds numbering and .png.'])
  await expect(page.getByRole('button', { name: 'Clear destination' })).toHaveCount(0)
  await mount(page).click()
  await expect(page.getByRole('option').first()).toHaveText('Project default (output)')
  await page.getByRole('option', { name: 'Project default (output)' }).click()
  await expect(mount(page)).toContainText('Project default')
  await expect(rowValue(page)).toHaveValue('output/gallery/shots')
  await expect(side(page)).toContainText('Enter stores output/gallery/shots')
  await page.mouse.click(900, 700)
  await expect.poll(() => target(page, 'gallery')).toEqual({ prefix: 'gallery/shots' })
  expect(await undo(page)).toBe(true)
  expect(await target(page, 'gallery')).toEqual({ mount: 'output', prefix: 'gallery/shots' })
  // An empty target opens as Project default with the node's default name and is kept as it is.
  await page.evaluate(() => window.__dinksterTest!.app.dispatchTo(window.__dinksterTest!.app.activeTab()!, {
    command: 'node.setValue', params: { graphId: 'g0', nodeId: 'gallery', inputId: 'target', value: null },
  }))
  await openRow(page, 'gallery')
  await expect(mount(page)).toContainText('Project default')
  await expect(prefix(page)).toHaveValue('ComfyUI')
  await expect(side(page)).toContainText('Enter keeps output/ComfyUI')
  await page.keyboard.press('Enter')
  await expect(box(page)).toHaveCount(0)
  expect(await target(page, 'gallery')).toBeNull()
  // The default is a link that puts the default back in the box; leaving stores it.
  await openRow(page, 'save')
  await expect(side(page)).toContainText('Enter keeps output/renders/portrait')
  await side(page).getByRole('button', { name: 'output/ComfyUI' }).click()
  await expect(box(page)).toBeVisible()
  await expect(mount(page)).toContainText('Project default')
  await expect(prefix(page)).toHaveValue('ComfyUI')
  await expect(side(page)).toContainText('Enter stores output/ComfyUI')
  await page.keyboard.press('Enter')
  await expect.poll(() => target(page)).toEqual({ prefix: 'ComfyUI' })
})

test('a row with a wire does not open', async ({ page }) => {
  await openTargets(page, undefined, { wired: true })
  const point = await rowPoint(page, 'save', 'target')
  await page.mouse.click(point.x, point.y)
  await page.waitForTimeout(300)
  await expect(box(page)).toHaveCount(0)
  await expect(page.getByTestId('save-target-editor')).toHaveCount(0)
})

test('the keyboard walks the dropdown and the name, and Escape closes the list before the box', async ({ page }) => {
  await openTargets(page)
  await openRow(page, 'gallery')
  await expect(prefix(page)).toBeFocused()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(mount(page)).toBeFocused()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(prefix(page)).toBeFocused()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(mount(page)).toBeFocused()
  // The list opens from the dropdown on the picked mount; Down and Enter pick, the box stays open.
  await page.keyboard.press('Space')
  await expect(page.getByRole('listbox', { name: 'Writable mount' })).toBeVisible()
  await expect(mount(page)).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('listbox', { name: 'Writable mount' })).toHaveCount(0)
  await expect(box(page)).toBeVisible()
  await expect(mount(page)).toContainText('archive')
  // Up from archive reaches Project default.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(mount(page)).toContainText('Project default')
  // Escape closes the list first, then the box, which stores nothing.
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('listbox', { name: 'Writable mount' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox', { name: 'Writable mount' })).toHaveCount(0)
  await expect(box(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(box(page)).toHaveCount(0)
  expect(await target(page, 'gallery')).toEqual({ mount: 'output', prefix: 'gallery/shots' })
})
