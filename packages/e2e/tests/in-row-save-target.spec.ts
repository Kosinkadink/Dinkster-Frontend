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
    schemaVersion: 2, epoch: 1, dinkster: { version: 'save-target-fixture', schemaWire: 2 }, nodes: {},
  } }))
  await page.route('/api/mounts*', mounts)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await waitForWorkspaceReady(page)
  await page.evaluate(async (wired) => {
    const target = (optional: boolean) => ({
      kind: 'input', id: 'target', type: { kind: 'concrete', name: 'dinkster.save_target' }, optional,
      ...(optional ? {} : { tooltip: 'Where the saved images are written.' }),
      widget: { widgetType: 'SAVE_TARGET', options: { suffix: '.png' }, default: { prefix: 'ComfyUI' } },
    })
    const image = { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false }
    window.__dinksterTest!.app.registerSchemas([
      { type: 'SaveImage', displayName: 'Save image', category: 'test', source: 'v3', isOutputNode: true, body: [image, target(false), { kind: 'input', id: 'quality', type: { kind: 'concrete', name: 'INT' }, optional: false, widget: { widgetType: 'INT', options: { min: 1, max: 100 }, default: 90 } }] },
      { type: 'Gallery', displayName: 'Gallery', category: 'test', source: 'v3', isOutputNode: true, body: [image, target(true)] },
      { type: 'TargetSource', displayName: 'Target source', category: 'test', source: 'v3', isOutputNode: false, body: [{ kind: 'output', id: 'target', type: { kind: 'concrete', name: 'dinkster.save_target' } }] },
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
const box = (page: Page) => page.locator('.node-editor-space-overlay .dinkster-canvas-target-box')
const mount = (page: Page) => box(page).getByRole('button', { name: /^Mount/ })
const prefix = (page: Page) => box(page).getByRole('textbox', { name: 'Name', exact: true })

async function openRow(page: Page, nodeId = 'save'): Promise<void> {
  const open = page.locator('.node-editor-space-overlay')
  if (await open.count()) {
    const current = await open.getAttribute('data-node-id')
    if (current === nodeId) { await prefix(page).focus(); return }
    const point = await rowPoint(page, current!, 'target')
    await page.mouse.click(point.x, point.y)
    await expect(box(page)).toHaveCount(0)
  }
  const point = await rowPoint(page, nodeId, 'target')
  await page.mouse.click(point.x, point.y)
  await expect(box(page)).toBeVisible()
}

async function pickMount(page: Page, id: string): Promise<void> {
  await mount(page).click()
  await page.getByRole('option', { name: id, exact: true }).click()
  await expect(page.getByRole('listbox', { name: 'Mount options', exact: true })).toHaveCount(0)
}

test('an unfolded Save target draft stays in its document when an equal target opens in another tab', async ({ page }) => {
  await openTargets(page)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const document = app.activeTab()!.store.doc
    await app.openDocument({ ...document, view: { ...document.view, graphs: { ...document.view?.graphs,
      g0: { ...document.view?.graphs['g0'], nodes: { ...document.view?.graphs['g0']?.nodes,
        save: { position: { x: 80, y: 80 }, editors: { target: { unfolded: true } } },
      } },
    } } }, 'Unfolded Save targets')
  })
  const name = page.locator('.node-editor-space-overlay[data-node-id="save"] input')
  await expect(name).toHaveValue('renders/portrait')
  await name.fill('../do-not-share')
  await expect(name).toHaveAttribute('aria-invalid', 'true')
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.openDocument({ ...app.activeTab()!.store.doc, lineage: 'another-save-target-document' }, 'Other Save targets')
  })
  await expect(name).toHaveValue('renders/portrait')
  expect(await target(page)).toEqual({ mount: 'output', prefix: 'renders/portrait' })
})

test('a picked mount and typed name are stored together on leaving, as one undo step; Escape stores nothing', async ({ page }, testInfo) => {
  await openTargets(page)
  const stored = { mount: 'output', prefix: 'renders/portrait' }
  const leaves: readonly [string, (page: Page) => Promise<void>, { mount: string; prefix: string }][] = [
    ['Enter', (page) => page.keyboard.press('Enter'), { mount: 'archive', prefix: 'renders/final' }],
    ['Tab', async (page) => {
      await page.keyboard.press('Tab')
      await expect(box(page).getByRole('button', { name: 'Reset to default' })).toBeFocused()
      expect(await target(page)).toEqual(stored)
      await page.keyboard.press('Tab')
    }, { mount: 'archive', prefix: 'renders/tab' }],
    ['a click outside', async (page) => { await page.mouse.click(900, 700) }, { mount: 'archive', prefix: 'renders/click' }],
  ]
  for (const [how, leave, expected] of leaves) {
    await openRow(page)
    await expect(prefix(page)).toBeFocused()
    await expect(box(page).locator('.dinkster-canvas-target-name')).toHaveAttribute('title', 'Where the saved images are written.\n\nSubfolders and filename stem only. The writer adds numbering and .png.')
    await pickMount(page, 'archive')
    await prefix(page).fill(expected.prefix)
    if (how === 'Enter') await page.screenshot({ path: testInfo.outputPath('changed.png') })
    expect(await target(page), how).toEqual(stored)
    await leave(page)
    await expect.poll(() => target(page), how).toEqual(expected)
    await expect(box(page)).toBeVisible()
    expect(await undo(page), how).toBe(true)
    expect(await target(page), how).toEqual(stored)
  }
  await openRow(page)
  await pickMount(page, 'archive')
  await prefix(page).fill('renders/escaped')
  await page.keyboard.press('Escape')
  await expect(prefix(page)).toHaveValue('renders/portrait')
  await expect(mount(page)).toContainText('output')
  expect(await target(page)).toEqual(stored)
})

test('while mounts load, when none is ready and when they cannot be read, nothing is stored', async ({ page }) => {
  let release: (() => void) | undefined
  const cases: readonly [string, Mounts, string][] = [
    ['loading', async (route) => { await new Promise<void>((resolve) => { release = resolve }); await route.fulfill({ json: READY }) }, 'Loading mounts'],
    ['none', (route) => route.fulfill({ json: { activeOutputMount: 'offline', mounts: [{ id: 'reference', mode: 'read', state: 'ready' }, { id: 'offline', mode: 'readwrite', state: 'missing' }] } }), 'No mount ready'],
    ['failed', (route) => route.fulfill({ status: 500, json: { error: 'mount settings unavailable' } }), 'Could not load'],
  ]
  for (const [state, handler, words] of cases) {
    await openTargets(page, handler)
    await page.evaluate(() => window.__dinksterTest!.app.dispatchTo(window.__dinksterTest!.app.activeTab()!, {
      command: 'node.setValue', params: { graphId: 'g0', nodeId: 'save', inputId: 'target', value: { prefix: 'renders/portrait' } },
    }))
    await openRow(page)
    await expect(mount(page), state).toHaveAttribute('data-state', state)
    await expect(mount(page), state).toContainText(words)
    if (state === 'none') await expect(box(page).locator('.dinkster-canvas-editor-note')).toContainText('No writable mount.')
    if (state === 'failed') {
      await expect(box(page).locator('.dinkster-canvas-editor-note')).toContainText('Mounts unavailable.')
      await expect(box(page).locator('.dinkster-canvas-editor-note')).toHaveAttribute('data-tone', 'problem')
      await expect(box(page).locator('.dinkster-canvas-target-note')).toHaveCount(0)
    }
    // The list does not open, and a typed name cannot be stored.
    await mount(page).click({ force: true })
    await expect(page.getByRole('listbox', { name: 'Mount options', exact: true }), state).toHaveCount(0)
    await prefix(page).fill('renders/other')
    await page.keyboard.press('Enter')
    await expect(box(page), state).toBeVisible()
    expect(await target(page), state).toEqual({ prefix: 'renders/portrait' })
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
  await expect(mount(page)).toHaveAttribute('data-tone', 'warning')
  await expect(mount(page)).toContainText('usb1')
  await expect(box(page).locator('.dinkster-canvas-editor-note')).toContainText('usb1 not found.')
  await prefix(page).fill('renders/renamed')
  // In the list the missing mount is dimmed and cannot be picked.
  await mount(page).click()
  const missing = page.getByRole('option', { name: /usb1 \(not on this machine\)/ })
  await expect(missing).toHaveAttribute('aria-disabled', 'true')
  await expect(missing).toBeVisible()
  await missing.click({ force: true })
  await expect(page.getByRole('listbox', { name: 'Mount options', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox', { name: 'Mount options', exact: true })).toHaveCount(0)
  await expect(box(page)).toBeVisible()
  await prefix(page).focus()
  await page.keyboard.press('Enter')
  expect(await target(page)).toEqual({ mount: 'usb1', prefix: 'renders/portrait' })
  await page.keyboard.press('Escape')
  // Use project default puts the box on Project default; leaving stores no mount.
  await box(page).getByRole('button', { name: 'Details', exact: true }).press('Enter')
  const note = page.getByRole('dialog', { name: 'usb1 is not on this machine.', exact: true })
  await expect(note.getByRole('button', { name: 'Use project default' })).toBeFocused()
  await note.getByRole('button', { name: 'Use project default' }).press('Enter')
  await expect(note).toHaveCount(0)
  await expect(mount(page)).toContainText('Project default')
  await expect(box(page).locator('.dinkster-canvas-editor-note')).toHaveCount(0)
  await expect(prefix(page)).toBeFocused()
  expect(await target(page)).toEqual({ mount: 'usb1', prefix: 'renders/portrait' })
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
    await page.keyboard.press('Enter')
    await expect(prefix(page), bad).toHaveValue(bad)
    expect(await target(page), bad).toEqual({ mount: 'output', prefix: 'renders/portrait' })
    await page.keyboard.press('Escape')
    await expect(prefix(page)).toHaveValue('renders/portrait')
  }
})

test('Project default stores no mount, an empty target shows its default name, and Reset changes only the draft', async ({ page }) => {
  await openTargets(page)
  // Picking Project default stores only the name; the row names the mount it means here.
  await openRow(page, 'gallery')
  await expect(page.getByRole('button', { name: 'Clear destination' })).toHaveCount(0)
  await mount(page).click()
  await expect(page.getByRole('option').first()).toHaveText('Project default (output)')
  await page.getByRole('option', { name: 'Project default (output)' }).click()
  await expect(mount(page)).toContainText('Project default')
  expect(await target(page, 'gallery')).toEqual({ mount: 'output', prefix: 'gallery/shots' })
  await page.mouse.click(900, 700)
  await expect.poll(() => target(page, 'gallery')).toEqual({ prefix: 'gallery/shots' })
  expect(await undo(page)).toBe(true)
  expect(await target(page, 'gallery')).toEqual({ mount: 'output', prefix: 'gallery/shots' })
  // Inspecting an empty target shows its declared name without storing it.
  await page.evaluate(() => window.__dinksterTest!.app.dispatchTo(window.__dinksterTest!.app.activeTab()!, {
    command: 'node.setValue', params: { graphId: 'g0', nodeId: 'gallery', inputId: 'target', value: null },
  }))
  await openRow(page, 'gallery')
  await expect(mount(page)).toContainText('Project default')
  await expect(prefix(page)).toHaveValue('ComfyUI')
  await page.keyboard.press('Enter')
  expect(await target(page, 'gallery')).toBeNull()
  // Reset changes the draft, not the stored target, and keeps Name focused.
  await openRow(page, 'save')
  await box(page).getByRole('button', { name: 'Reset to default' }).press('Enter')
  await expect(box(page)).toBeVisible()
  await expect(mount(page)).toContainText('Project default')
  await expect(prefix(page)).toHaveValue('ComfyUI')
  await expect(prefix(page)).toBeFocused()
  expect(await target(page)).toEqual({ mount: 'output', prefix: 'renders/portrait' })
  await page.keyboard.press('Enter')
  await expect.poll(() => target(page)).toEqual({ prefix: 'ComfyUI' })
})

test('in a project with no default output mount, Project default says a run cannot save but nothing is refused', async ({ page }) => {
  await openTargets(page, (route) => route.fulfill({ json: { ...READY, activeOutputMount: null } }))
  await openRow(page, 'gallery')
  await mount(page).click()
  await page.getByRole('option', { name: 'Project default (no output mount)' }).click()
  await expect(box(page).locator('.dinkster-canvas-editor-note')).toContainText('No output mount.')
  await expect(box(page).locator('.dinkster-canvas-editor-note')).toHaveAttribute('data-tone', 'problem')
  await box(page).getByRole('button', { name: 'Details', exact: true }).press('Space')
  const note = page.getByRole('dialog', { name: 'This project has no default output mount.', exact: true })
  await expect(note.getByRole('button', { name: 'Open Storage' })).toBeFocused()
  await expect(note.getByRole('button', { name: 'Open Storage' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(box(page).getByRole('button', { name: 'Details', exact: true })).toBeFocused()
  await expect(mount(page)).toHaveAttribute('data-tone', 'error')
  await prefix(page).focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => target(page, 'gallery')).toEqual({ prefix: 'gallery/shots' })
  // A stored mount this machine lacks names both facts and offers no Use project default.
  await page.evaluate(() => window.__dinksterTest!.app.dispatchTo(window.__dinksterTest!.app.activeTab()!, {
    command: 'node.setValue', params: { graphId: 'g0', nodeId: 'save', inputId: 'target', value: { mount: 'usb1', prefix: 'renders/portrait' } },
  }))
  await openRow(page, 'save')
  await expect(box(page).locator('.dinkster-canvas-editor-note')).toContainText('No output mount.')
  await box(page).getByRole('button', { name: 'Details', exact: true }).click()
  const both = page.getByRole('dialog', { name: 'usb1 is missing and this project has no default output mount.', exact: true })
  await expect(both).toBeVisible()
  await expect(both.getByRole('button', { name: 'Use project default' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(mount(page)).toHaveAttribute('data-tone', 'error')
  await pickMount(page, 'archive')
  await expect(box(page).locator('.dinkster-canvas-editor-note')).toHaveCount(0)
  await expect(mount(page)).not.toHaveAttribute('data-tone')
  await prefix(page).focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => target(page)).toEqual({ mount: 'archive', prefix: 'renders/portrait' })
})

test('a whole target wire permits read-only inspection without editing its stored fallback', async ({ page }) => {
  await openTargets(page, undefined, { wired: true })
  await openRow(page)
  await expect(prefix(page)).toHaveAttribute('readonly', '')
  await expect(mount(page)).toHaveAttribute('aria-disabled', 'true')
  await expect(box(page).getByRole('button', { name: 'Reset to default' })).toHaveCount(0)
  await prefix(page).focus()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('cannot/replace')
  await page.keyboard.press('Enter')
  await mount(page).click({ force: true })
  await expect(page.getByRole('listbox', { name: 'Mount options', exact: true })).toHaveCount(0)
  expect(await target(page)).toEqual({ mount: 'output', prefix: 'renders/portrait' })
  await expect(page.getByTestId('save-target-editor')).toHaveCount(0)
})

test('the keyboard walks Mount and Name, and Escape closes the list before resetting the draft', async ({ page }) => {
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
  await expect(page.getByRole('listbox', { name: 'Mount options', exact: true })).toBeVisible()
  await expect(mount(page)).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('listbox', { name: 'Mount options', exact: true })).toHaveCount(0)
  await expect(box(page)).toBeVisible()
  await expect(mount(page)).toContainText('archive')
  // Up from archive reaches Project default.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(mount(page)).toContainText('Project default')
  // Escape closes the list first, then restores the stored draft without folding.
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('listbox', { name: 'Mount options', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox', { name: 'Mount options', exact: true })).toHaveCount(0)
  await expect(box(page)).toBeVisible()
  await expect(mount(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(box(page)).toBeVisible()
  await expect(mount(page)).toContainText('output')
  expect(await target(page, 'gallery')).toEqual({ mount: 'output', prefix: 'gallery/shots' })
})
