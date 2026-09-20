/**
 * Shared e2e test base: by default, pins the SAME-ORIGIN backend to the
 * legacy v1 ComfyUI bridge regardless of what the dev proxy fronts.
 *
 * Why: main.tsx runs protocol discovery on the same origin at every load,
 * native-first. This suite was written against a live ComfyUI default and
 * queues real v1 workflows - so if a native engine appears behind the dev
 * proxy (DINKSTER_NATIVE_BACKEND pointed at a live dinkster-serve, or a default
 * engine on :3639), discovery would silently flip every spec's default
 * backend to native and the suite's assumptions with it. These routes make
 * the assumption EXPLICIT and the environment irrelevant: the same-origin
 * native and supervisor probes answer "no native engine here", so
 * discovery conclusively selects v1 via the real /system_stats proxy.
 *
 * The patterns are baseURL-relative, so they match ONLY the same origin:
 * absolute mock origins (http://templates.test) and explicitly added
 * native backends (http://127.0.0.1:8765) are untouched, as are
 * path-prefix backends like /b2. Spec-registered routes are matched before
 * fixture routes (Playwright checks routes in reverse registration
 * order), so a spec can still override these when it needs to.
 *
 * Hosted runs pin these fixtures to legacy discovery even when
 * DINKSTER_E2E_USE_NATIVE=1. Other configs honor that native opt-in.
 * Same-origin native cases use nativeTest or import '@playwright/test'
 * directly and control routing themselves.
 */
import {
  test as base,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test'

const nativeCatalogBackend = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
let nativeCatalogAvailable: Promise<boolean> | undefined

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
  const options = page.getByRole('option')
  for (let index = 0; index < await options.count(); index += 1) {
    const option = options.nth(index)
    if (await option.getAttribute('data-option-id') === optionId) return option
  }
  throw new Error(`No product option has id '${optionId}'`)
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

export const test = base.extend({
  page: async ({ page }, use) => {
    if (process.env['DINKSTER_E2E_FIXTURE_MODE'] === 'legacy' || process.env['DINKSTER_E2E_USE_NATIVE'] !== '1') {
      await page.route('/api/nodes*', (route) =>
        route.fulfill({
          status: 502,
          contentType: 'text/plain',
          body: 'e2e fixture: same-origin native probe pinned off',
        }),
      )
      await page.route('/supervisor/status', (route) =>
        route.fulfill({
          status: 502,
          contentType: 'text/plain',
          body: 'e2e fixture: same-origin supervisor probe pinned off',
        }),
      )
      await page.route('/api/settings', (route) =>
        route.fulfill({
          json: { categories: { granted: [], available: [] }, settings: {} },
        }),
      )
    }
    await use(page)
  },
})

export { base as nativeTest, expect }
export type { Page, Locator, Route, Request } from '@playwright/test'
