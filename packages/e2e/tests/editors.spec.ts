/**
 * Editor seam (docs/editors.md): the center region resolves the active tab's
 * editorKind through EditorRegistry. The pinned lifecycle contract is that
 * the ONE registered graph editor never remounts across same-kind tab
 * switches, registry churn for other kinds, or the no-active-tab default -
 * per-tab canvas view state (viewport, gestures) lives in CanvasHost and a
 * remount would silently reset it.
 *
 * CanvasHost assigns window.__dinksterTest.renderer once per mount, so strict
 * in-page identity of that object across operations proves "never
 * remounted" without reaching into component internals.
 */
import { expect, test } from './fixtures.js'

declare global {
  interface Window {
    __rendererProbe?: unknown
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('graph editor mounts once and never remounts across tab switches, registry churn, or no active tab', async ({
  page,
}) => {
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(2)

  // Capture the mounted CanvasHost's renderer identity in-page.
  await page.evaluate(() => {
    window.__rendererProbe = window.__dinksterTest!.renderer
  })
  const rendererUnchanged = () =>
    page.evaluate(
      () => window.__rendererProbe !== undefined && window.__rendererProbe === window.__dinksterTest!.renderer,
    )
  expect(await rendererUnchanged()).toBe(true)

  // Same-kind tab switches: the registry returns the same descriptor object,
  // so the keyed Show must not re-render the editor.
  await page.getByTestId('tab-bar').locator('.tab', { hasText: 'Subgraph' }).click()
  expect(await rendererUnchanged()).toBe(true)
  await page.getByTestId('tab-bar').locator('.tab', { hasText: 'Basic' }).click()
  expect(await rendererUnchanged()).toBe(true)

  // Registry churn for an UNRELATED kind bumps editors.changed; the graph
  // descriptor is untouched, so the mounted editor must survive both ticks.
  await page.evaluate(() => {
    const unregister = window.__dinksterTest!.app.editors.register({
      id: 'e2e-temp-editor',
      title: 'Temp',
      component: () => null,
    })
    unregister()
  })
  expect(await rendererUnchanged()).toBe(true)

  // No active tab: editor-kind resolution defaults to the graph kind (the
  // canvas host owns the empty state), so the editor must stay mounted.
  const previousActive = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const previous = app.activeTabId.get()
    app.activeTabId.set('')
    return previous
  })
  expect(await rendererUnchanged()).toBe(true)
  await expect(page.getByTestId('editor-missing')).toHaveCount(0)
  await page.evaluate((id) => window.__dinksterTest!.app.activeTabId.set(id), previousActive)
  expect(await rendererUnchanged()).toBe(true)
})

test('unknown editor kind shows the loud missing-editor fallback, not blank space', async ({ page }) => {
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  // Force the active tab onto a kind nothing registered. Mutating the tab
  // object directly is test-only surgery: tabs are created through makeTab
  // and there is no user path to an unknown kind today (that is the point -
  // this pins the failure mode for when future kinds CAN appear).
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const active = app.activeTab() as unknown as { editorKind: string }
    active.editorKind = 'not-a-registered-kind'
    const tabs = app.tabs as unknown as { set(tabs: readonly unknown[]): void }
    tabs.set([...app.tabs.get()])
  })
  await expect(page.getByTestId('editor-missing')).toContainText("No editor registered for kind 'not-a-registered-kind'")
  await expect(page.getByTestId('graph-canvas')).toHaveCount(0)
})
