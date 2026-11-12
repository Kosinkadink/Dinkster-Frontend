/** Shared browser settings and isolated ownership acknowledgments. */
import {
  test as base,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test'
import seedBasic from '../../core/fixtures/workflows/seed-basic.json' with { type: 'json' }
import seedSubgraph from '../../core/fixtures/workflows/seed-subgraph.json' with { type: 'json' }

const nativeCatalogBackend = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
let nativeCatalogAvailable: Promise<boolean> | undefined

export async function waitForStartupOwnership(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app !== undefined &&
    window.__dinksterTest.app.backends.get()[0]?.registry.get() !== undefined &&
    window.__dinksterTest.app.tabs.get().every((tab) => tab.execution !== undefined || 'status' in tab.store) &&
    !window.__dinksterTest.app.problems.get().some((problem) =>
      problem.code === 'workflow.startup.ownershipUnconfirmed'))).toBe(true)
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

export const nativeTest = base.extend<{ appView: boolean; retentionApi: boolean }>({
  appView: [false, { option: true }],
  // Live retention proofs opt out; ordinary browser fixtures model document
  // declarations while source-bound result claims use the live backend.
  retentionApi: [true, { option: true }],
  context: async ({ context, appView, retentionApi }, use) => {
    // Historical-schema fixtures do not import identities from the live pack
    // directory. Import integration tests override this with explicit metadata.
    await context.route('**/replacements/index.json', (route) =>
      route.fulfill({ json: { schemaVersion: 1, items: [] } }))
    if (retentionApi) {
      const owners = new Map<string, { scope: string; ownerKind: string; ownerId: string;
        revision: number; complete: boolean; digests: string[] }>()
      const sourceOwners = new Set<string>()
      await context.route('**/api/library/retentions/*/*?scope=*', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        const parts = url.pathname.split('/')
        const scope = url.searchParams.get('scope')!
        const ownerKind = parts.at(-2)!
        const ownerId = decodeURIComponent(parts.at(-1)!)
        const key = JSON.stringify([url.origin, scope, ownerKind, ownerId])
        // Claims and later reads/releases share the server's sealed source roots.
        if (sourceOwners.has(key) || (request.method() === 'PUT' &&
          typeof request.postDataJSON()?.sourceToken === 'string')) {
          sourceOwners.add(key)
          return route.fallback()
        }
        const previous = owners.get(key)
        if (request.method() === 'GET') {
          return route.fulfill(previous === undefined ? { status: 404 } : { json: previous })
        }
        if (request.method() !== 'PUT' && request.method() !== 'DELETE') return route.fulfill({ status: 405 })
        const declaration = request.method() === 'PUT' ? request.postDataJSON()
          : { revision: Number(url.searchParams.get('revision')), complete: true, digests: [] }
        if (declaration.revision !== (previous?.revision ?? 0)) return route.fulfill({ status: 409 })
        if (typeof declaration.complete !== 'boolean' || !Array.isArray(declaration.digests) ||
          declaration.digests.length > 4096 || !declaration.digests.every((digest: unknown) =>
            typeof digest === 'string' && /^blake3:[0-9a-f]{64}$/.test(digest))) {
          return route.fulfill({ status: 422 })
        }
        const acknowledged = { scope, ownerKind, ownerId, revision: declaration.revision + 1,
          complete: declaration.complete, digests: [...new Set<string>(declaration.digests)].sort() }
        owners.set(key, acknowledged)
        return route.fulfill({ json: acknowledged })
      })
    }
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
export const test = nativeTest.extend({
  page: async ({ page }, use) => {
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
    await use(page)
  },
})

export const appViewTest = test.extend({ appView: true })
export const nativeAppViewTest = nativeTest.extend({ appView: true })
export { expect }
export type { Page, Locator, Route, Request, WebSocketRoute } from '@playwright/test'
