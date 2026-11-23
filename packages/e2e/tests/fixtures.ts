/** Shared browser settings and startup readiness checks. */
import {
  test as base,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from '../visual.js'
import seedBasic from '../../core/fixtures/workflows/seed-basic.json' with { type: 'json' }
import seedSubgraph from '../../core/fixtures/workflows/seed-subgraph.json' with { type: 'json' }

const nativeCatalogBackend = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
let nativeCatalogAvailable: Promise<boolean> | undefined

export async function mockProjectPacks(page: Page, packs: readonly string[] = []): Promise<void> {
  await page.route('/api/projects/default', (route) => {
    if (route.request().method() !== 'GET') throw new Error(`Unexpected project write: ${route.request().method()}`)
    return route.fulfill({ json: { project: {
      id: 'default', uid: '48bb018e-5b17-4e68-bd81-c6412c4bcd72', name: 'Default',
      created: '2026-01-01T00:00:00Z', revision: 1, deleted: false,
      packs: { extra: packs }, environment: null, accountProject: null,
    } } })
  })
  await page.route('/api/projects/default/needs', (route) => route.fulfill({ json: {
    packs: [], extra: packs, unknown: [], installed: packs.map((pack) => ({ pack, version: null })),
  } }))
}

export async function waitForWorkspaceReady(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app !== undefined &&
    window.__dinksterTest.app.backends.get()[0]?.registry.get() !== undefined &&
    window.__dinksterTest.app.tabs.get().every((tab) => tab.execution !== undefined || 'status' in tab.store))).toBe(true)
}

export async function skipWithoutNativeCatalog(request: APIRequestContext, testInfo: TestInfo): Promise<void> {
  nativeCatalogAvailable ??= request.get(`${nativeCatalogBackend}/api/nodes`, { timeout: 3000 })
    .then(async (response) => {
      const available = response.ok()
      await response.dispose()
      return available
    })
    .catch(() => false)
  testInfo.skip(!await nativeCatalogAvailable, `native catalog backend (${nativeCatalogBackend}) unavailable`)
}

export async function productOption(page: Page, optionId: string): Promise<Locator> {
  const escapedId = await page.evaluate((id) => CSS.escape(id), optionId)
  const option = page.getByRole('option').and(page.locator(`[data-option-id="${escapedId}"]`))
  await expect(option).toHaveCount(1)
  return option
}

export async function selectProductOption(page: Page, control: Locator, optionId: string, selectedId = optionId): Promise<void> {
  await control.click()
  await (await productOption(page, optionId)).click()
  await expect(control).toHaveAttribute('data-selected-id', selectedId)
}

export async function executionDetails(row: Locator): Promise<Locator> {
  const details = row.locator('details.runs-details')
  if (!await details.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await details.locator('summary').click()
  }
  return details.getByTestId('run-details')
}

export async function openRailPanel(page: Page, title: string): Promise<void> {
  const rail = page.getByTestId('dock-zone-right')
  if (!await rail.isVisible()) {
    await page.getByRole('button', { name: /^Toggle right rail/ }).click()
  }
  await expect(rail).toBeVisible()

  const tab = rail.locator('[role="tab"]').filter({ hasText: title })
  await expect(tab).toHaveCount(1)
  if (await tab.isVisible()) {
    await tab.click()
  } else {
    const overflowButtons = rail.getByTestId('dock-zone-overflow-button')
    let activated = false
    for (let index = 0; index < await overflowButtons.count(); index += 1) {
      const button = overflowButtons.nth(index)
      if (!await button.isVisible()) continue
      await button.click()
      const menu = rail.locator('[data-testid="dock-zone-overflow-menu"]:visible')
      await expect(menu).toBeVisible()
      const item = menu.getByRole('menuitemradio').filter({ has: page.getByText(title, { exact: true }) })
      if (await item.count() > 0) {
        await item.click()
        activated = true
        break
      }
      await page.keyboard.press('Escape')
    }
    if (!activated) throw new Error(`No inspector tab is titled '${title}'`)
  }

  await expect(tab).toBeVisible()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

export const nativeTest = base.extend<{ appView: boolean; seedWorkflows: boolean }>({
  appView: [false, { option: true }],
  seedWorkflows: [false, { option: true }],
  page: async ({ page, seedWorkflows }, use) => {
    if (seedWorkflows) {
      const basic = structuredClone(seedBasic)
      basic.graphs.g0.links.l2.from.port = 'IMAGE'
      const subgraph = structuredClone(seedSubgraph)
      subgraph.graphs.g1.boundary.outputs[0]!.binds.port = 'IMAGE'
      await page.addInitScript(({ basic, subgraph }) => {
        if (localStorage.getItem('dinkster.openTabs') !== null) return
        localStorage.setItem('dinkster.openTabs', JSON.stringify({
          v: 1,
          active: basic.lineage,
          tabs: [{ title: 'Basic', doc: basic, documentRevision: 0 }, { title: 'Subgraph', doc: subgraph, documentRevision: 0 }],
        }))
      }, { basic, subgraph })
    }
    await use(page)
  },
  context: async ({ context, appView }, use) => {
    // Historical-schema fixtures do not import identities from the live pack
    // directory. Import integration tests override this with explicit metadata.
    await context.route('**/replacements/index.json', (route) =>
      route.fulfill({ json: { schemaVersion: 1, items: [] } }))
    if (appView) await context.addInitScript(() => {
      const stored = JSON.parse(localStorage.getItem('dinkster.settings') ?? 'null')
      localStorage.setItem('dinkster.settings', JSON.stringify({
        v: 1, values: { ...stored?.values, 'features.appView.enabled': true },
      }))
    })
    await use(context)
  },
})

// Editing and execution tests start with explicit documents, while nativeTest
// exercises the product's schema-independent blank startup.
export const test = nativeTest.extend({ seedWorkflows: true })

export const appViewTest = test.extend({ appView: true })
export const nativeAppViewTest = nativeTest.extend({ appView: true })
export { expect }
export type { Page, Locator, Route, Request, WebSocketRoute } from '../visual.js'
