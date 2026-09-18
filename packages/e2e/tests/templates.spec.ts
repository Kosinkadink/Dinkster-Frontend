import { expect, selectProductOption, test, type Page } from './fixtures.js'

const MOCK = 'http://templates.test'
const TEMPLATE_DOC = {
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'template-lineage', root: 'g0',
  graphs: { g0: { id: 'g0', name: 'Template', nodes: {
    expectedA: { id: 'expectedA', type: 'demo.node', values: {} },
    expectedB: { id: 'expectedB', type: 'demo.node', values: {} },
  }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
  view: { graphs: { g0: { nodes: {
    expectedA: { position: { x: 0, y: 0 } }, expectedB: { position: { x: 200, y: 0 } },
  } } } },
}

async function openTemplatesPanel(page: Page): Promise<void> {
  await page.route(`${MOCK}/api/nodes*`, (route) => void route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'test', schemaWire: 22 },
    packs: { demo: { displayName: 'Demo Pack', assets: [{ id: 'model', name: 'Demo Model', digest: 'blake3:x', kind: 'model/checkpoint', size: 1024 }] } },
    nodes: { 'demo.node': { displayName: 'Demo Node', pack: 'demo', signature: 's', interface: [] } },
  } }))
  await page.route(`${MOCK}/api/templates*`, (route) => {
    const q = new URL(route.request().url()).searchParams.get('q')?.toLowerCase() ?? ''
    const rows = [
      { pack: 'demo', id: 'starter', name: 'Starter Image', description: 'Two expected nodes', tags: ['image'], assets: ['model'], digest: 'sha256:a' },
      { pack: 'demo', id: 'audio', name: 'Audio Flow', digest: 'sha256:b' },
    ].filter((row) => JSON.stringify(row).toLowerCase().includes(q))
    void route.fulfill({ json: { templates: rows } })
  })
  await page.route(`${MOCK}/api/packs/demo/templates/starter`, (route) => void route.fulfill({ json: TEMPLATE_DOC }))

  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.getByTestId('backends-toggle').click()
  await page.getByTestId('backend-url-input').fill(MOCK)
  await page.getByTestId('backend-add').click()
  await selectProductOption(page, page.getByTestId('tab-target'), MOCK)
  const library = page.getByTestId('library-overlay')
  if (!await library.isVisible()) await page.getByTestId('library-toggle').click()
  await expect(library).toBeVisible()
  const templates = library.locator('[data-testid=collection-source][data-source=templates]')
  if (await templates.isVisible()) await templates.click()
  else await selectProductOption(page, library.getByTestId('library-source-select'), 'templates')
  await expect(page.getByTestId('collection-entry')).toHaveCount(2)
}

test('searches templates and opens the body as a new document', async ({ page }) => {
  await openTemplatesPanel(page)
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  const starter = page.getByRole('option', { name: /Starter Image/ })
  await expect(starter).not.toHaveAttribute('title')
  await starter.hover()
  await expect(page.getByTestId('app-tooltip')).toContainText('Starter Image', { timeout: 1_500 })
  await starter.focus()
  await expect(page.getByTestId('app-tooltip')).toContainText('Two expected nodes')
  await page.getByTestId('collection-search').fill('starter')
  const search = page.getByTestId('collection-search')
  const clearSearch = page.getByRole('button', { name: 'Clear search templates', exact: true })
  await expect(clearSearch).toBeVisible()
  await expect(search).toHaveAttribute('type', 'search')
  await expect(search).toHaveAttribute('role', 'combobox')
  await expect(clearSearch).toHaveCount(1)
  await search.focus()
  await page.keyboard.press('Tab')
  await expect(clearSearch).toBeFocused()
  await page.keyboard.press('Space')
  await expect(search).toHaveValue('')
  await expect(search).toBeFocused()
  await expect(clearSearch).toHaveCount(0)
  await search.fill('starter')
  await search.press('Escape')
  await expect(search).toHaveValue('')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await search.fill('starter')
  await expect(page.getByTestId('collection-entry')).toHaveCount(1)
  await page.getByTestId('collection-entry').click()
  await expect(page.getByTestId('collection-entry')).toContainText('Demo Model - model/checkpoint - 1 KiB')
  await page.locator('[data-testid=collection-action][data-action=open]').click()
  await expect(page.getByTestId('library-overlay')).not.toBeVisible()
  expect(await page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes))).toEqual(['expectedA', 'expectedB'])
})

test('Enter on a nested entry action clicks the action, not the row', async ({ page }) => {
  // The action button lives INSIDE the roving row. If the row's keydown
  // swallowed Enter, activation would toggle the selection off (templates
  // have no click-activation), the action strip would vanish, and the
  // template could never open by keyboard. Native button Enter must win.
  await openTemplatesPanel(page)
  await page.getByTestId('collection-search').fill('starter')
  await expect(page.getByTestId('collection-entry')).toHaveCount(1)
  await page.getByTestId('collection-entry').click()
  const action = page.locator('[data-testid=collection-action][data-action=open]')
  await action.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('library-overlay')).not.toBeVisible()
  expect(await page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes))).toEqual(['expectedA', 'expectedB'])
})
