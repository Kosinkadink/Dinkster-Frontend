import { mkdir } from 'node:fs/promises'
import { expect, selectProductOption, test, type Page } from './fixtures.js'

const PROOF = '/tmp/dinkster-31-form-language'
const RUNTIME = 'http://runtime-form.test'

async function installStartup(page: Page): Promise<void> {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'form-language-e2e', schemaWire: 1 },
    nodes: {},
  } }))
  await page.route('/api/diagnostics*', (route) => route.fulfill({ json: { diagnostics: [] } }))
}

async function openNumericWidget(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.app.registerSchemas([{
      type: 'FormLanguageWidget', displayName: 'Form language', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'count', type: { kind: 'concrete', name: 'INT' }, optional: false,
        widget: { widgetType: 'INT', options: { min: 0, max: 100, step: 5 }, default: 5 },
      }],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'form-language', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { form: { id: 'form', type: 'FormLanguageWidget', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { form: { position: { x: 180, y: 160 } } } } } },
    }, 'Form language')
  })
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab?.id === 'form-language' && 'status' in tab.store
  })).toBe(true)
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'form')?.layout.rows
      .some((row) => row.kind === 'widget' && row.inputId === 'count'),
  )).toBe(true)
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'form')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'count')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + node.x + node.layout.width / 2, y: canvas.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
}

test.beforeAll(async () => mkdir(PROOF, { recursive: true }))

test('settings validation stays associated and contained at wide and narrow sizes', async ({ page }) => {
  await installStartup(page)
  await page.setViewportSize({ width: 1600, height: 950 })
  await page.goto('/')
  await expect(page.getByTestId('settings-button')).toBeVisible()
  await page.evaluate(() => (window.__dinksterTest!.app as any).settings.register({
    id: 'proof.maximumSuggestions',
    name: 'Maximum visible suggestions',
    description: 'Controls how many ranked suggestions remain visible before the list scrolls.',
    category: 'interaction',
    type: 'number',
    defaultValue: 8,
    min: 1,
    max: 20,
    step: 1,
  }))
  await page.getByTestId('settings-button').click()
  await page.getByRole('searchbox', { name: 'Search settings' }).fill('Maximum visible suggestions')
  const row = page.locator('[data-setting-id="proof.maximumSuggestions"]')
  const input = row.getByRole('spinbutton')
  await input.fill('999')
  await input.press('Enter')
  await expect(row.getByRole('alert')).toHaveText('Enter 20 or less.')
  await expect(input).toHaveAttribute('aria-describedby', /proof\.maximumSuggestions-message/)
  await page.screenshot({ path: `${PROOF}/after-settings-1600x950.png`, fullPage: true })

  await page.setViewportSize({ width: 360, height: 640 })
  await expect(row).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
  await page.screenshot({ path: `${PROOF}/after-settings-360x640.png`, fullPage: true })
  await input.press('Escape')
  await expect(input).toHaveValue('8')
  await expect(input).not.toHaveAttribute('aria-invalid', 'true')
  await expect(row.getByRole('alert')).toHaveCount(0)
})

test('runtime fields and actions use the shared panel language', async ({ page }) => {
  await installStartup(page)
  await page.route(`${RUNTIME}/api/nodes*`, (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'runtime-form-e2e', schemaWire: 1 },
    nodes: {},
  } }))
  await page.route(`${RUNTIME}/api/settings*`, (route) => route.fulfill({ json: {
    categories: { granted: ['memory-headroom', 'worker-comfy-args', 'jobs'], available: ['memory-headroom', 'worker-comfy-args', 'jobs'] },
    settings: {
      'memory-headroom': { value: '256M', source: 'default', mutability: 'live', writable: true, persistence: { available: true, persisted: true } },
      'worker-comfy-args': { value: ['--preview-size', '512'], source: 'runtime', mutability: 'on-worker-restart', writable: true, persistence: { available: false, persisted: false } },
      jobs: { value: { maxRunningJobs: 2 }, source: 'default', mutability: 'live', writable: true, persistence: { available: true, persisted: true } },
    },
  } }))
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/')
  await expect(page.getByTestId('backends-sidebar-toggle')).toBeVisible()
  await page.getByTestId('backends-sidebar-toggle').click()
  await page.getByTestId('backend-url-input').fill(RUNTIME)
  await page.getByTestId('backend-add').click()
  await selectProductOption(page, page.getByTestId('tab-target'), RUNTIME)
  const backend = page.locator('.backend-card', { hasText: RUNTIME })
  await backend.locator('.runtime-settings-toggle').click()
  const workerArguments = backend.locator('details[data-category="worker-comfy-args"]')
  await expect(workerArguments).toBeVisible()
  await expect(backend.locator('.product-action-footer')).toHaveCount(3)
  await expect(workerArguments.getByRole('status')).toContainText('in-memory only')
  await workerArguments.locator('.product-action-footer').scrollIntoViewIfNeeded()
  await expect(workerArguments.locator('.product-action-footer')).toBeInViewport()
  await page.screenshot({ path: `${PROOF}/after-runtime-1366x768.png`, fullPage: true })

  const jobs = backend.locator('details[data-category="jobs"]')
  await jobs.locator('.product-action-footer').scrollIntoViewIfNeeded()
  await expect(jobs.locator('.product-action-footer')).toBeInViewport()
  await page.screenshot({ path: `${PROOF}/after-runtime-tail-1366x768.png`, fullPage: true })
})

test('widget validation and a busy asset decision remain usable on a narrow viewport', async ({ page }) => {
  await installStartup(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/')
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  await openNumericWidget(page)
  const editor = page.getByTestId('widget-editor')
  const input = editor.getByRole('textbox', { name: 'Value' })
  await input.fill('not a number')
  await input.press('Enter')
  await expect(editor.getByRole('alert')).toContainText('exact integer')
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await page.screenshot({ path: `${PROOF}/after-widget-1366x768.png`, fullPage: true })
  await page.getByTestId('widget-editor-cancel').click()

  await page.setViewportSize({ width: 360, height: 640 })
  await page.evaluate(() => {
    ;(window.__dinksterTest!.app as any).assetConsent.set({
      assets: Array.from({ length: 7 }, (_, index) => ({
        digest: `blake3:proof-${index}`,
        name: index === 0 ? 'A very long checkpoint filename that must wrap without hiding the action footer.safetensors' : `Required model ${index + 1}.safetensors`,
        status: 'missing',
        sources: [`https://models.example/collection/${index + 1}`],
        fetchable: true,
        kind: 'model',
        size: 1_048_576 * (index + 1),
      })),
      busy: true,
      retry: async () => {},
    })
  })
  const dialog = page.getByTestId('asset-consent-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('modal-close')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('asset-consent-cancel')).toHaveText('Dismiss')
  await expect(dialog.locator('.product-action-footer')).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
  await page.screenshot({ path: `${PROOF}/after-asset-modal-360x640.png`, fullPage: true })

  const lastAsset = dialog.getByTestId('asset-consent-row').last()
  await lastAsset.scrollIntoViewIfNeeded()
  await expect(lastAsset).toBeInViewport()
  await expect(dialog.locator('.product-action-footer')).toBeInViewport()
  await page.screenshot({ path: `${PROOF}/after-asset-modal-tail-360x640.png`, fullPage: true })
})
