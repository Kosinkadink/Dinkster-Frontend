/**
 * Structured save-target widget (schema wire v5, backend 6b9d874).
 *
 * The document stores {mount, prefix} DATA - never a raw host path - and the
 * picker sources its mount choices from GET /api/mounts filtered to ready
 * readwrite mounts. The route is intercepted at the network layer (like the
 * remote-combo suite) so these specs assert the real scoped-client behavior
 * without requiring a native backend restarted onto wire v5.
 */
import { expect, test, type Page } from './fixtures.js'

interface SaveTarget {
  mount: string
  prefix: string
}

const MOUNTS_PAYLOAD = {
  mounts: [
    // Only these two are eligible: readwrite AND ready.
    { id: 'comfy-output', path: '/srv/out', mode: 'readwrite', source: 'derived', state: 'ready', entryCount: 3 },
    { id: 'renders', path: '/srv/renders', mode: 'readwrite', source: 'config', state: 'ready' },
    // Excluded rows, one per exclusion reason.
    { id: 'comfy-input', path: '/srv/in', mode: 'read', source: 'derived', state: 'ready' },
    { id: 'scratch', path: '/srv/scratch', mode: 'readwrite', source: 'config', state: 'scanning' },
    { id: 'pending-mount', path: '/srv/p', mode: 'readwrite', source: 'config', state: 'pending' },
    { id: 'broken', path: '/srv/broken', mode: 'readwrite', source: 'config', state: 'failed' },
  ],
}

const value = (page: Page): Promise<SaveTarget | null> =>
  page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.save!.values.target as SaveTarget | null)

// No return-type annotation: page.route's return type differs across
// Playwright versions (void vs Disposable) and callers only await it.
const interceptMounts = (page: Page, payload: unknown = MOUNTS_PAYLOAD) =>
  page.route('**/api/mounts*', (route) => void route.fulfill({ json: payload }))

async function openSaveTarget(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'save')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'target')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('save-target-editor')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'save-target-e2e', schemaWire: 1 },
    nodes: {},
  } }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(() => {
    window.__dinksterTest!.app.registerSchemas([{
      type: 'SaveTargetTest', displayName: 'Save Target', category: 'test', source: 'v3', isOutputNode: true,
      items: [{ kind: 'input', id: 'target', type: { kind: 'concrete', name: 'dinkster.save_target' }, optional: true,
        widget: { widgetType: 'SAVE_TARGET', options: { suffix: '.png' }, default: { mount: 'comfy-output', prefix: 'ComfyUI' } } }],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'save-target', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { save: { id: 'save', type: 'SaveTargetTest', values: { target: { mount: 'comfy-output', prefix: 'ComfyUI' } } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { save: { position: { x: 100, y: 100 } } } } } },
    }, 'Save Target')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
})

test('picker lists ONLY ready readwrite mounts; the suffix shows as context', async ({ page }) => {
  await interceptMounts(page)
  await openSaveTarget(page)
  await expect(page.getByTestId('save-target-editor')).toHaveAttribute('data-mounts', 'ready')
  await expect(page.getByTestId('save-target-editor').getByTestId('widget-editor-label')).toHaveText('target')
  await expect(page.getByTestId('save-target-editor').getByTestId('widget-editor-type')).toHaveText('dinkster.save_target')
  await expect(page.getByTestId('save-target-output-format')).toHaveText('.png')
  await page.getByTestId('save-target-mount').click()
  await expect(page.getByRole('listbox').getByRole('option')).toHaveText(['comfy-output', 'renders'])
  await page.getByTestId('save-target-mount').press('Escape')
  // The node owns the extension; the editor shows it but it is not part of
  // the editable prefix.
  await expect(page.getByTestId('save-target-suffix')).toHaveText('.png')
  await expect(page.getByTestId('save-target-prefix')).toHaveValue('ComfyUI')
})

test('commit stores exactly {mount, prefix}; the suffix never joins the stored value', async ({ page }) => {
  await interceptMounts(page)
  await openSaveTarget(page)
  await expect(page.getByTestId('save-target-editor')).toHaveAttribute('data-mounts', 'ready')
  await page.getByTestId('save-target-mount').click()
  await page.getByRole('option', { name: 'renders' }).click()
  await page.getByTestId('save-target-prefix').fill('project/day/stem')
  await page.getByTestId('save-target-save').click()
  await expect(page.getByTestId('save-target-editor')).not.toBeVisible()
  expect(await value(page)).toEqual({ mount: 'renders', prefix: 'project/day/stem' })
  // Undo restores the prior target through the command pipeline.
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect(await value(page)).toEqual({ mount: 'comfy-output', prefix: 'ComfyUI' })
})

test('Enter in the prefix field commits like the save button', async ({ page }) => {
  await interceptMounts(page)
  await openSaveTarget(page)
  await expect(page.getByTestId('save-target-editor')).toHaveAttribute('data-mounts', 'ready')
  await page.getByTestId('save-target-prefix').fill('sub/other')
  await page.getByTestId('save-target-prefix').press('Enter')
  await expect(page.getByTestId('save-target-editor')).not.toBeVisible()
  expect(await value(page)).toEqual({ mount: 'comfy-output', prefix: 'sub/other' })
})

test('FR15 Enter during an IME composition never commits the save target', async ({ page }) => {
  await interceptMounts(page)
  const before = await value(page)
  await openSaveTarget(page)
  await expect(page.getByTestId('save-target-editor')).toHaveAttribute('data-mounts', 'ready')
  const prefix = page.getByTestId('save-target-prefix')
  await prefix.fill('composed/stem')
  // A composing Enter selects the IME candidate; the editor must stay open
  // with the stored value untouched.
  await prefix.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
  })
  await expect(page.getByTestId('save-target-editor')).toBeVisible()
  expect(await value(page)).toEqual(before)
  // A real Enter after composition commits normally.
  await prefix.press('Enter')
  await expect(page.getByTestId('save-target-editor')).not.toBeVisible()
  expect(await value(page)).toEqual({ mount: 'comfy-output', prefix: 'composed/stem' })
})

test('invalid prefixes NEVER commit: the error is visible and the stored value survives', async ({ page }) => {
  await interceptMounts(page)
  const before = await value(page)
  await openSaveTarget(page)
  await expect(page.getByTestId('save-target-editor')).toHaveAttribute('data-mounts', 'ready')
  for (const prefix of ['../up', '/abs/path', 'a\\b', 'a//b', 'a/./b', 'trailing/', '']) {
    await page.getByTestId('save-target-prefix').fill(prefix)
    await page.getByTestId('save-target-save').click()
    await expect(page.getByTestId('save-target-error'), `prefix '${prefix}'`).toBeVisible()
    await expect(page.getByTestId('save-target-editor'), `prefix '${prefix}'`).toBeVisible()
    expect(await value(page), `prefix '${prefix}'`).toEqual(before)
  }
  // Typing again clears the stale error; a valid value still commits.
  await page.getByTestId('save-target-prefix').fill('fixed/stem')
  await expect(page.getByTestId('save-target-error')).not.toBeVisible()
  await page.getByTestId('save-target-save').click()
  expect(await value(page)).toEqual({ mount: 'comfy-output', prefix: 'fixed/stem' })
})

test('Escape and cancel both close without committing', async ({ page }) => {
  await interceptMounts(page)
  const before = await value(page)
  await openSaveTarget(page)
  await page.getByTestId('save-target-prefix').fill('would/be/lost')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('save-target-editor')).not.toBeVisible()
  expect(await value(page)).toEqual(before)
  await openSaveTarget(page)
  await page.getByTestId('save-target-prefix').fill('also/lost')
  await page.getByTestId('save-target-editor').getByRole('button', { name: 'cancel' }).click()
  await expect(page.getByTestId('save-target-editor')).not.toBeVisible()
  expect(await value(page)).toEqual(before)
})

test('clear commits null (unset optional target -> schema default applies server-side)', async ({ page }) => {
  await interceptMounts(page)
  await openSaveTarget(page)
  await page.getByTestId('save-target-editor').getByRole('button', { name: 'clear' }).click()
  await expect(page.getByTestId('save-target-editor')).not.toBeVisible()
  expect(await value(page)).toBeNull()
})

test('mount fetch failure is visible, disables save, and preserves the value', async ({ page }) => {
  await page.route('**/api/mounts*', (route) => void route.fulfill({ status: 500, body: 'nope' }))
  const before = await value(page)
  await openSaveTarget(page)
  await expect(page.getByTestId('save-target-editor')).toHaveAttribute('data-mounts', 'error')
  await expect(page.getByTestId('save-target-mounts-error')).toBeVisible()
  await expect(page.getByTestId('save-target-save')).toBeDisabled()
  await page.getByTestId('save-target-editor').getByRole('button', { name: 'cancel' }).click()
  expect(await value(page)).toEqual(before)
})

test('with no writable mounts, the current mount is offered as unavailable instead of a data trap', async ({ page }) => {
  await interceptMounts(page, {
    mounts: [{ id: 'comfy-input', path: '/srv/in', mode: 'read', source: 'derived', state: 'ready' }],
  })
  await openSaveTarget(page)
  await expect(page.getByTestId('save-target-editor')).toHaveAttribute('data-mounts', 'ready')
  // The stored mount is not writable HERE, but hiding it would strand the
  // document; it stays selectable, labeled, and the backend remains the
  // authority at execution time.
  await page.getByTestId('save-target-mount').click()
  await expect(page.getByRole('listbox').getByRole('option')).toHaveText(['comfy-output (unavailable)'])
})

test('raw string values never reach the document through this editor', async ({ page }) => {
  await interceptMounts(page)
  await openSaveTarget(page)
  await expect(page.getByTestId('save-target-editor')).toHaveAttribute('data-mounts', 'ready')
  await page.getByTestId('save-target-prefix').fill('ok/stem')
  await page.getByTestId('save-target-save').click()
  const stored = await value(page)
  expect(typeof stored).toBe('object')
  expect(stored).toEqual({ mount: 'comfy-output', prefix: 'ok/stem' })
})
