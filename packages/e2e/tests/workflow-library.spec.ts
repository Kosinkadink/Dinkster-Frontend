/**
 * Workflow-library write paths against the real Dinkster backend. The UI owns
 * save, browse, and reopen; the bridge is used only for deterministic setup
 * and a document command whose persisted result can be asserted exactly.
 */
import { expect, selectProductOption, test, type Page } from './fixtures.js'

const uniqueName = (label: string): string =>
  `e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

/**
 * Library routes (/api/library, /api/assets) exist only on a NATIVE Dinkster
 * backend, not on the ComfyUI backend the rest of the suite requires. The
 * suite must stay runnable without one, so these tests skip (loudly, not
 * silently pass) when no native server answers.
 */
const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

async function openNamedCopy(page: Page, title: string): Promise<void> {
  const failures = await page.evaluate((name) => {
    const app = window.__dinksterTest!.app
    const doc = structuredClone(app.activeTab()!.store.doc) as unknown as {
      lineage: string
      root: string
      graphs: Record<string, {
        nodes: Record<string, unknown>
      }>
      view: { graphs: Record<string, {
        nodes: Record<string, unknown>
      }> }
    }
    // A distinct lineage prevents this fixture from replacing the startup tab.
    doc.lineage = name
    doc.graphs[doc.root]!.nodes.n0 ??= {
      id: 'n0',
      type: 'dev.image.gradient',
      values: { width: 8, height: 8 },
    }
    doc.view.graphs[doc.root]!.nodes.n0 ??= { position: { x: 120, y: 120 } }
    return app.openDocument(doc, name)
  }, title)
  expect(failures).toEqual([])
}

async function openWorkflows(page: Page): Promise<void> {
  await page.getByTestId('library-toggle').click()
  const library = page.getByTestId('library-overlay')
  await expect(library).toBeVisible()
  const workflowsTab = library.locator('[data-testid=collection-source][data-source=workflows]')
  if (await workflowsTab.isVisible()) await workflowsTab.click()
  else await selectProductOption(page, library.getByTestId('library-source-select'), 'workflows')
}

function workflowRow(page: Page, title: string) {
  return page.getByTestId('collection-entry').filter({ hasText: title })
}

async function targetNativeBackend(page: Page): Promise<void> {
  const alreadyNative = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()
    return tab !== undefined && app.backendForTab(tab).protocol === 'dinkster'
  })
  if (!alreadyNative) {
    await page.getByTestId('backends-toggle').click()
    await page.getByTestId('backend-url-input').fill(NATIVE_BACKEND)
    await page.getByTestId('backend-add').click()
    await expect(page.getByTestId('tab-target')).toBeVisible()
    await selectProductOption(page, page.getByTestId('tab-target'), NATIVE_BACKEND)
  }
  await expect.poll(() => page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()
    return tab === undefined ? undefined : app.backendForTab(tab).protocol
  })).toBe('dinkster')
}

async function saveWorkflow(page: Page): Promise<void> {
  const save = page.locator('[data-testid=context-menu-item][data-item-id="workflow.save"]')
  // The app menu deliberately closes when availability-affecting state
  // changes (backend ticks, document changes). Live-backend activity can
  // race an open menu shut - even between visibility check and click, which
  // detaches the item mid-action - so keep the CLICK inside the reopen loop
  // too: exactly what a user does when a menu closes under them.
  await expect(async () => {
    if (!(await save.isVisible())) await page.getByTestId('dinkster-menu-button').click()
    await expect(save).toBeVisible({ timeout: 1000 })
    await expect(save).not.toHaveClass(/disabled/)
    await save.click({ timeout: 2000 })
  }).toPass({ timeout: 15_000 })
}

test.beforeEach(async ({ page }) => {
  try {
    const probe = await fetch(`${NATIVE_BACKEND}/api/library?scope=local`, { signal: AbortSignal.timeout(2000) })
    test.skip(!probe.ok, `native Dinkster backend at ${NATIVE_BACKEND} did not serve /api/library`)
  } catch {
    test.skip(true, `no native Dinkster backend reachable at ${NATIVE_BACKEND} (set DINKSTER_NATIVE_BACKEND)`)
  }
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
})

test('save new workflow, patch the same record, and reopen modified content', async ({ page }) => {
  const title = uniqueName('save-patch-open')
  await openNamedCopy(page, title)
  await targetNativeBackend(page)

  await expect(page.locator('.tab.active .tab-dirty')).toBeVisible()
  await saveWorkflow(page)
  await expect(page.locator('.tab.active .tab-dirty')).not.toBeVisible()

  await openWorkflows(page)
  await expect(workflowRow(page, title)).toHaveCount(1)
  await page.getByTestId('library-toggle').click()

  const persistedPosition = { x: 431, y: 287 }
  const changed = await page.evaluate((position) => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return (tab.store as unknown as {
      dispatch(invocation: { command: string; params: unknown }): { ok: boolean }
    }).dispatch({
      command: 'node.move',
      params: { graphId: tab.store.doc.root, positions: { n0: position } },
    }).ok
  }, persistedPosition)
  expect(changed).toBe(true)
  await expect(page.locator('.tab.active .tab-dirty')).toBeVisible()

  await saveWorkflow(page)
  await expect(page.locator('.tab.active .tab-dirty')).not.toBeVisible()
  await openWorkflows(page)
  // A linked tab must PATCH its original record, never POST a duplicate.
  await expect(workflowRow(page, title)).toHaveCount(1)
  await page.getByTestId('library-toggle').click()

  await page.locator('.tab.active').hover()
  await page.locator('.tab.active').getByTestId('tab-close').click()
  // Library browsing follows the active tab's backend, just like save does.
  await targetNativeBackend(page)
  await openWorkflows(page)
  await workflowRow(page, title).click()
  await expect(page.getByTestId('library-overlay')).not.toBeVisible()
  await expect(page.locator('.tab.active .tab-select')).toHaveText(title)
  await expect(page.locator('.tab.active .tab-dirty')).not.toBeVisible()
  expect(await page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return {
      node: doc.graphs[doc.root]!.nodes.n0?.id,
      position: doc.view.graphs[doc.root]!.nodes.n0!.position,
    }
  })).toEqual({ node: 'n0', position: persistedPosition })
})

test('failed new save surfaces a Problem, stays dirty, and retries successfully', async ({ page }) => {
  const title = uniqueName('save-retry')
  await openNamedCopy(page, title)
  await targetNativeBackend(page)

  const createRoute = '**/api/library'
  await page.route(createRoute, async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 500, body: 'injected save failure' })
    } else {
      await route.continue()
    }
  })
  await saveWorkflow(page)
  await expect(page.getByTestId('problems-panel')).toContainText('library.saveFailed')
  await expect(page.getByTestId('problems-panel')).toContainText('POST /api/library failed: 500')
  await expect(page.locator('.tab.active .tab-dirty')).toBeVisible()

  await page.unroute(createRoute)
  await saveWorkflow(page)
  await expect(page.locator('.tab.active .tab-dirty')).not.toBeVisible()
  await openWorkflows(page)
  await expect(workflowRow(page, title)).toHaveCount(1)
})
