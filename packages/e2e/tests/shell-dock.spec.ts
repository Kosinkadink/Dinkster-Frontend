/**
 * Shell layout (promises.md "Shell layout"): three tabbed dock zones with
 * host-owned chrome, all toggleable, drag-resizable, and persisted
 * per-browser via settings. Wide regions share flex space with the canvas;
 * narrow side sheets preserve tabs and status. The thin status bar is not
 * the bottom panel and never toggles with it.
 */
import { expect, test, type Locator } from './fixtures.js'

async function expectWholeTabs(tablist: Locator, tabs: Locator): Promise<void> {
  const strip = (await tablist.boundingBox())!
  for (const tab of await tabs.all()) {
    const box = await tab.boundingBox()
    if (box === null) {
      expect(await tab.isVisible()).toBe(false)
      continue
    }
    expect(await tab.isVisible()).toBe(true)
    expect(box.x).toBeGreaterThanOrEqual(strip.x - 1)
    expect(box.x + box.width).toBeLessThanOrEqual(strip.x + strip.width + 1)
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
})

test('bottom zone repairs its rendered active tab across when flips and runtime registration', async ({ page }) => {
  await page.getByTestId('logs-toggle').click()
  const zone = page.getByTestId('dock-zone-bottom')
  await expect(zone.getByRole('tablist', { name: 'Bottom panels' })).toBeVisible()

  await page.evaluate(() => {
    const bridge = window as unknown as {
      __dinksterTest: { app: {
        panels: {
          changed: { get(): number; set(value: number): void }
          register(descriptor: unknown): () => void
        }
      } }
      __dockConditionalVisible?: boolean
    }
    bridge.__dockConditionalVisible = true
    const panels = bridge.__dinksterTest.app.panels
    const descriptor = {
      id: 'runtime-bottom',
      title: 'Runtime bottom',
      placement: 'bottom',
      allowedPlacements: ['bottom'],
      order: 25,
      toggleTestId: 'runtime-bottom-toggle',
      when: () => bridge.__dockConditionalVisible === true,
      component: () => {
        const body = document.createElement('div')
        body.dataset['testid'] = 'runtime-bottom-body'
        body.textContent = 'Runtime bottom body'
        return body
      },
    }
    const unregister = panels.register(descriptor)
    ;(window as unknown as { __unregisterRuntimeBottom?: () => void }).__unregisterRuntimeBottom = unregister
  })

  await page.getByTestId('runtime-bottom-toggle').click()
  const runtime = zone.getByRole('tab', { name: 'Runtime bottom' })
  const logs = zone.getByRole('tab', { name: 'Activity' })
  await expect(runtime).toHaveAttribute('aria-selected', 'true')
  await expect(runtime).toHaveAttribute('tabindex', '0')
  await expect(logs).toHaveAttribute('tabindex', '-1')
  await expect(page.getByTestId('runtime-bottom-body')).toBeVisible()

  await page.evaluate(() => {
    const bridge = window as unknown as {
      __dinksterTest: { app: { panels: { changed: { get(): number; set(value: number): void } } } }
      __dockConditionalVisible?: boolean
    }
    bridge.__dockConditionalVisible = false
    const changed = bridge.__dinksterTest.app.panels.changed
    changed.set(changed.get() + 1)
  })
  await expect(runtime).toHaveCount(0)
  await expect(logs).toHaveAttribute('aria-selected', 'true')
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      dock: { effective(): { zones: { bottom: { sections: readonly { activeTab?: string; tabs: readonly string[] }[] } } } }
    }
    return app.dock.effective().zones.bottom.sections[0]
  })).toMatchObject({ activeTab: 'runtime-bottom', tabs: expect.arrayContaining(['runtime-bottom']) })

  await page.evaluate(() => {
    const bridge = window as unknown as {
      __dinksterTest: { app: { panels: { changed: { get(): number; set(value: number): void } } } }
      __dockConditionalVisible?: boolean
    }
    bridge.__dockConditionalVisible = true
    const changed = bridge.__dinksterTest.app.panels.changed
    changed.set(changed.get() + 1)
  })
  await expect(runtime).toHaveAttribute('aria-selected', 'true')

  await page.evaluate(() => (window as unknown as { __unregisterRuntimeBottom: () => void }).__unregisterRuntimeBottom())
  await expect(runtime).toHaveCount(0)
  await expect(logs).toHaveAttribute('aria-selected', 'true')
})

test('a zone with no renderable tabs hides without losing its saved open state', async ({ page }) => {
  await page.evaluate(() => {
    const bridge = window as unknown as {
      __dinksterTest: { app: {
        panels: {
          changed: { get(): number; set(value: number): void }
          register(descriptor: unknown): () => void
          setPlacement(id: string, placement: string): boolean
        }
      } }
      __dockSoleVisible?: boolean
    }
    bridge.__dockSoleVisible = true
    const panels = bridge.__dinksterTest.app.panels
    panels.setPlacement('logs', 'floating')
    panels.setPlacement('execution-log', 'floating')
    panels.register({
      id: 'runtime-bottom-only',
      title: 'Runtime bottom only',
      placement: 'bottom',
      allowedPlacements: ['bottom'],
      order: 25,
      toggleTestId: 'runtime-bottom-only-toggle',
      when: () => bridge.__dockSoleVisible === true,
      component: () => {
        const body = document.createElement('div')
        body.textContent = 'Runtime bottom only body'
        return body
      },
    })
  })

  const regionToggle = page.getByTestId('bottom-panel-toggle')
  await page.getByTestId('runtime-bottom-only-toggle').click()
  await expect(page.getByTestId('bottom-panel')).toBeVisible()
  await expect(regionToggle).toHaveAttribute('aria-pressed', 'true')
  await expect(regionToggle).toBeEnabled()

  await page.evaluate(() => {
    const bridge = window as unknown as {
      __dinksterTest: { app: { panels: { changed: { get(): number; set(value: number): void } } } }
      __dockSoleVisible?: boolean
    }
    bridge.__dockSoleVisible = false
    const changed = bridge.__dinksterTest.app.panels.changed
    changed.set(changed.get() + 1)
  })

  await expect(page.getByTestId('bottom-panel')).toHaveCount(0)
  await expect(regionToggle).toHaveAttribute('aria-pressed', 'false')
  await expect(regionToggle).toBeDisabled()
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      dock: { effective(): { zones: { bottom: { open: boolean } } } }
    }
    return app.dock.effective().zones.bottom.open
  })).toBe(true)

  await page.evaluate(() => {
    const bridge = window as unknown as {
      __dinksterTest: { app: { panels: { changed: { get(): number; set(value: number): void } } } }
      __dockSoleVisible?: boolean
    }
    bridge.__dockSoleVisible = true
    const changed = bridge.__dinksterTest.app.panels.changed
    changed.set(changed.get() + 1)
  })
  await expect(page.getByTestId('bottom-panel')).toBeVisible()
  await expect(regionToggle).toHaveAttribute('aria-pressed', 'true')
  await expect(regionToggle).toBeEnabled()
})

test('left zone hosts multiple tabs and each toggle activates or closes its panel', async ({ page }) => {
  // Nothing docked by default.
  await expect(page.getByTestId('dock-panel')).not.toBeVisible()

  // Library opens in the dock.
  await page.getByTestId('library-toggle').click()
  const dock = page.getByTestId('dock-panel')
  const zone = page.getByTestId('dock-zone-left')
  await expect(dock).toHaveAttribute('data-active-panel', 'library')
  await expect(page.getByTestId('library-overlay')).toBeVisible()
  await expect(zone.getByRole('tab', { name: 'Library' })).toHaveAttribute('aria-selected', 'true')
  await expect(zone.getByRole('tab', { name: 'Backends' })).toBeVisible()
  const tablist = zone.getByRole('tablist', { name: 'Primary dock panels' })
  const guidesInstalled = await page.getByRole('button', { name: 'Learning guides' }).count() > 0
  const overflowButton = zone.getByTestId('dock-zone-overflow-button')
  if (guidesInstalled) await expect(overflowButton).toBeVisible()
  else {
    await expect(overflowButton).not.toBeVisible()
    await expectWholeTabs(tablist, zone.locator('[role="tab"]'))
  }

  // Switching to Backends selects its tab while both tabs remain available.
  await page.getByTestId('backends-sidebar-toggle').click()
  await expect(dock).toHaveAttribute('data-active-panel', 'backends')
  await expect(page.getByTestId('backends-panel')).toBeVisible()
  await expect(page.getByTestId('library-overlay')).not.toBeVisible()
  await expect(zone.getByRole('tab', { name: 'Library' })).toBeVisible()
  await expect(zone.getByRole('tab', { name: 'Backends' })).toHaveAttribute('aria-selected', 'true')

  // The statusbar Backends button closes the active zone.
  await page.getByTestId('backends-toggle').click()
  await expect(dock).not.toBeVisible()

  // Re-open and close via the zone header X.
  await page.getByTestId('library-toggle').click()
  await expect(page.getByTestId('library-overlay')).toBeVisible()
  await zone.getByTestId('dock-zone-close').click()
  await expect(dock).not.toBeVisible()
  await expect(page.getByTestId('library-toggle')).toBeFocused()
})

test('a dock tab floats its panel through the right-click context menu, not a chrome button', async ({ page }) => {
  await page.getByTestId('library-toggle').click()
  const zone = page.getByTestId('dock-zone-left')
  const tab = zone.getByRole('tab', { name: 'Library' })
  await expect(tab).toBeVisible()

  // No literal Float or pop-out button remains anywhere in the zone chrome.
  await expect(zone.locator('[data-testid^="panel-float-"]')).toHaveCount(0)
  await expect(zone.locator('[data-testid^="panel-popout-"]')).toHaveCount(0)

  // Trailing header actions are not tabs: right-clicking them must not open
  // the placement menu.
  const menuProbe = page.getByTestId('context-menu')
  await zone.getByTestId('dock-zone-close').click({ button: 'right' })
  await expect(menuProbe).toHaveCount(0)

  // Right-clicking the tab opens the styled menu with the placement moves.
  await tab.click({ button: 'right' })
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('[data-item-id="panel.float"]')).toContainText('Float')
  await expect(menu.locator('[data-item-id="panel.openWindow"]')).toContainText('Move to new window')

  // Invoking Float moves the panel to a floating overlay, as the button did.
  await menu.locator('[data-item-id="panel.float"]').click()
  await expect(menu).not.toBeVisible()
  const floating = page.locator('[data-testid="floating-panel"][data-panel="library"]')
  await expect(floating).toBeVisible()
  await expect(zone.getByRole('tab', { name: 'Library' })).toHaveCount(0)

  // The floating chrome keeps Dock as a visible button but carries no
  // move-to-new-window button; the header context menu owns both moves.
  await expect(floating.getByRole('button', { name: 'Dock' })).toBeVisible()
  await expect(floating.getByRole('button', { name: /to a new window/ })).toHaveCount(0)
  await floating.locator('.floating-panel-header').click({ button: 'right' })
  const floatingMenu = page.getByTestId('context-menu')
  await expect(floatingMenu).toBeVisible()
  await expect(floatingMenu.locator('[data-item-id="panel.dock"]')).toContainText('Dock')
  await expect(floatingMenu.locator('[data-item-id="panel.openWindow"]')).toContainText('Move to new window')

  // Invoking Dock from the menu returns the panel to its zone.
  await floatingMenu.locator('[data-item-id="panel.dock"]').click()
  await expect(floatingMenu).not.toBeVisible()
  await expect(floating).toHaveCount(0)
  await expect(zone.getByRole('tab', { name: 'Library' })).toBeVisible()
})

test('the floating header menu opens at the pointer and is keyboard reachable', async ({ page }) => {
  await page.getByTestId('library-toggle').click()
  const zone = page.getByTestId('dock-zone-left')
  await zone.getByRole('tab', { name: 'Library' }).click({ button: 'right' })
  await page.getByTestId('context-menu').locator('[data-item-id="panel.float"]').click()
  const floating = page.locator('[data-testid="floating-panel"][data-panel="library"]')
  await expect(floating).toBeVisible()

  // Pointer path: the menu opens at the viewport point of the right-click,
  // not displaced into the panel's own coordinate space.
  const header = floating.locator('.floating-panel-header')
  const box = (await header.boundingBox())!
  const offset = { x: 40, y: Math.min(12, box.height / 2) }
  await header.click({ button: 'right', position: offset })
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()
  const menuBox = (await menu.boundingBox())!
  expect(Math.abs(menuBox.x - (box.x + offset.x))).toBeLessThan(24)
  expect(Math.abs(menuBox.y - (box.y + offset.y))).toBeLessThan(24)
  // While the menu is open the panel raises above sibling floating panels
  // (z-index 81 over the shared 80) so the menu is never painted over.
  expect(await floating.evaluate((el) => getComputedStyle(el).zIndex)).toBe('81')
  await page.keyboard.press('Escape')
  await expect(menu).not.toBeVisible()
  expect(await floating.evaluate((el) => getComputedStyle(el).zIndex)).toBe('80')

  // Keyboard path: Shift+F10 on the focused Dock button opens the menu
  // anchored to the header; Escape returns focus to the Dock button.
  const dock = floating.getByRole('button', { name: 'Dock' })
  await dock.focus()
  await page.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  await expect(menu.locator('[data-item-id="panel.dock"]')).toContainText('Dock')
  await expect(menu.locator('[data-item-id="panel.openWindow"]')).toContainText('Move to new window')
  await page.keyboard.press('Escape')
  await expect(menu).not.toBeVisible()
  await expect(dock).toBeFocused()
})

test('the dock tab context menu is keyboard reachable and floats the panel', async ({ page }) => {
  await page.getByTestId('library-toggle').click()
  const zone = page.getByTestId('dock-zone-left')
  const tab = zone.getByRole('tab', { name: 'Library' })
  await tab.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()

  // Escape dismisses and returns focus to the tab.
  await page.keyboard.press('Escape')
  await expect(menu).not.toBeVisible()
  await expect(tab).toBeFocused()

  // Reopen and invoke the first item (Float) with Enter.
  await page.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-testid="floating-panel"][data-panel="library"]')).toBeVisible()
})

test('a panel floated and docked back finishes loading and keeps reacting', async ({ page }) => {
  // The Assets panel only browses on a native Dinkster backend, so mock the
  // backend surface plus deterministic mount discovery, then reload so the
  // app detects the mocked protocol.
  await page.route('/supervisor/status', (route) => void route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => void route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => void route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'shell-dock-e2e', schemaWire: 16 },
    nodes: {},
  } }))
  await page.route('**/api/mounts', (route) => void route.fulfill({ json: { mounts: [
    { id: 'alpha', mode: 'read', state: 'ready' },
  ] } }))
  await page.route('**/api/mounts/*/entries?*', (route) => void route.fulfill({ json: { entries: [
    { virtualPath: 'images/amber.png', name: 'amber.png', digest: 'blake3:amber', size: 10, mediaType: 'image/png', kind: 'media/image' },
  ] } }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.protocol ?? 'pending')).toBe('dinkster')
  await page.getByTestId('assets-toggle').click()
  const zone = page.getByTestId('dock-zone-left')
  await expect(zone.getByTestId('assets-overlay').getByTestId('collection-search')).toBeVisible()

  // Float the panel, then dock it back through the context menus.
  await zone.getByRole('tab', { name: 'Assets' }).click({ button: 'right' })
  await page.getByTestId('context-menu').locator('[data-item-id="panel.float"]').click()
  const floating = page.locator('[data-testid="floating-panel"][data-panel="assets"]')
  await expect(floating).toBeVisible()
  await floating.locator('.floating-panel-header').click({ button: 'right' })
  await page.getByTestId('context-menu').locator('[data-item-id="panel.dock"]').click()
  await expect(floating).toHaveCount(0)

  // The redocked body must finish source discovery again instead of
  // sticking on the bootstrap state forever (#188).
  const docked = zone.getByTestId('assets-overlay')
  const search = docked.getByTestId('collection-search')
  await expect(search).toBeVisible()
  await expect(docked.getByText('Loading asset sources')).toHaveCount(0)

  // Zone membership changes after the return must not freeze the body:
  // another panel joins the zone, and the redocked search still reacts.
  await page.getByTestId('library-toggle').click()
  await zone.getByRole('tab', { name: 'Assets' }).click()
  await search.fill('amber')
  await expect(docked.getByTestId('collection-search-clear')).toBeVisible()
  await expect(docked.getByRole('option', { name: /amber\.png/ })).toBeVisible()
})

test('extensions, boundary, and control surfaces panels can float and move to a new window', async ({ page }) => {
  // All three descriptors allow floating and window placement like every
  // other zone-hosted panel.
  const allowed = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      panels: { all(): { id: string; allowedPlacements: readonly string[] }[] }
    }
    const wanted = new Set(['extensions', 'boundary', 'surfaces'])
    return Object.fromEntries(app.panels.all()
      .filter((panel) => wanted.has(panel.id))
      .map((panel) => [panel.id, [...panel.allowedPlacements].sort().join(',')]))
  })
  expect(allowed).toEqual({
    extensions: 'bottom,dock,floating,rail,window',
    boundary: 'bottom,dock,floating,rail,window',
    surfaces: 'bottom,dock,floating,rail,window',
  })

  // Extensions floats through its tab context menu and docks back cleanly.
  const zone = page.getByTestId('dock-zone-right')
  await zone.getByRole('tab', { name: 'Extensions' }).click({ button: 'right' })
  const menu = page.getByTestId('context-menu')
  await expect(menu.locator('[data-item-id="panel.float"]')).toContainText('Float')
  await expect(menu.locator('[data-item-id="panel.openWindow"]')).toContainText('Move to new window')
  await menu.locator('[data-item-id="panel.float"]').click()
  const floating = page.locator('[data-testid="floating-panel"][data-panel="extensions"]')
  await expect(floating).toBeVisible()
  await floating.locator('.floating-panel-header').click({ button: 'right' })
  await page.getByTestId('context-menu').locator('[data-item-id="panel.dock"]').click()
  await expect(floating).toHaveCount(0)
  await expect(zone.getByRole('tab', { name: 'Extensions' })).toBeVisible()
})

test('a floating when-gated panel hides while disabled and returns when re-enabled', async ({ page }) => {
  const setGate = (value: boolean) => page.evaluate((enabled) => {
    const app = window.__dinksterTest!.app as unknown as {
      settings: { set(id: string, value: boolean): void }
    }
    app.settings.set('features.controlSurfaces.enabled', enabled)
  }, value)

  await setGate(true)
  const zone = page.getByTestId('dock-zone-right')
  // Clipped tabs stay attached but display:none, which hides them from
  // role queries, so the attach wait uses a CSS locator.
  const tab = zone.locator('[role="tab"][data-tab-id="surfaces"]')
  await tab.waitFor({ state: 'attached' })
  // A full strip clips trailing tabs into the all-tabs overflow; activating
  // the panel there renders its tab in the strip.
  if (!await tab.isVisible()) {
    await zone.getByTestId('dock-zone-overflow-button').click()
    await zone.getByTestId('dock-zone-overflow-menu')
      .getByRole('menuitemradio', { name: 'Control surfaces' }).click()
  }
  await expect(tab).toBeVisible()
  await tab.click({ button: 'right' })
  await page.getByTestId('context-menu').locator('[data-item-id="panel.float"]').click()
  const floating = page.locator('[data-testid="floating-panel"][data-panel="surfaces"]')
  await expect(floating).toBeVisible()

  // Disabling the feature hides the floating overlay without dropping the
  // placement override; re-enabling brings the same floating panel back.
  await setGate(false)
  await expect(floating).toHaveCount(0)
  await setGate(true)
  await expect(floating).toBeVisible()
})

test('logs live in the toggleable bottom panel; the status bar stays put', async ({ page }) => {
  await expect(page.getByTestId('bottom-panel')).not.toBeVisible()
  await expect(page.getByTestId('status-bar')).toBeVisible()

  await page.getByTestId('logs-toggle').click()
  const zone = page.getByTestId('dock-zone-bottom')
  await expect(page.getByTestId('bottom-panel')).toHaveAttribute('data-active-panel', 'logs')
  await expect(page.getByTestId('logs-panel')).toBeVisible()
  await expect(zone.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true')
  // Opening the bottom panel never opens the left dock.
  await expect(page.getByTestId('dock-panel')).not.toBeVisible()

  // The status bar is a separate always-on strip below the bottom panel.
  await expect(page.getByTestId('status-bar')).toBeVisible()
  const panel = (await page.getByTestId('bottom-panel').boundingBox())!
  const status = (await page.getByTestId('status-bar').boundingBox())!
  expect(panel.y + panel.height).toBeLessThanOrEqual(status.y + 1)

  // Close via the header X; the status bar survives.
  await zone.getByTestId('dock-zone-close').click()
  await expect(page.getByTestId('bottom-panel')).not.toBeVisible()
  await expect(page.getByTestId('status-bar')).toBeVisible()
  await expect(page.getByTestId('logs-toggle')).toBeFocused()
})

test('dock-zone membership selects the top or bottom left-rail cluster', async ({ page }) => {
  const rail = (await page.locator('.left-sidebar').boundingBox())!
  const dockGroup = (await page.getByTestId('dock-toggle-group').boundingBox())!
  const bottomGroup = (await page.getByTestId('bottom-toggle-group').boundingBox())!
  const logs = (await page.getByTestId('logs-toggle').boundingBox())!
  const executionLog = (await page.getByTestId('execution-log-toggle').boundingBox())!
  const settings = (await page.getByTestId('settings-button').boundingBox())!

  expect(dockGroup.y).toBeLessThan(bottomGroup.y)
  expect(bottomGroup.y).toBeGreaterThan(rail.y + rail.height / 2)
  // Settings is the permanent bottom-most rail action. Bottom-placement
  // panels (Activity, then Execution log) form the cluster immediately
  // above it.
  const activityGap = await page.getByTestId('settings-button').evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).marginTop),
  )
  const activityInset = await page.locator('.left-sidebar').evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).paddingBottom),
  )
  expect(logs.y).toBeLessThan(executionLog.y)
  expect(Math.abs(executionLog.y + executionLog.height + activityGap - settings.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(settings.y + settings.height - (rail.y + rail.height - activityInset))).toBeLessThanOrEqual(1)

  await page.evaluate(() => {
    const panels = (window.__dinksterTest!.app as unknown as {
      panels: { register(descriptor: unknown): () => void }
    }).panels
    panels.register({
      id: 'runtime-placement-test',
      title: 'Runtime placement test',
      placement: 'dock',
      allowedPlacements: ['dock', 'bottom'],
      order: 99,
      toggleTestId: 'runtime-placement-toggle',
      component: () => document.createElement('div'),
    })
  })
  const runtimeToggle = page.getByTestId('runtime-placement-toggle')
  await expect(runtimeToggle).toBeAttached()
  expect(await runtimeToggle.evaluate((element) => element.parentElement?.dataset['testid'])).toBe('dock-toggle-group')

  await page.evaluate(() => {
    const dock = (window.__dinksterTest!.app as unknown as {
      dock: { dock(id: string, zone: 'bottom'): void }
    }).dock
    dock.dock('runtime-placement-test', 'bottom')
  })
  await expect.poll(() => runtimeToggle.evaluate((element) => element.parentElement?.dataset['testid'])).toBe('bottom-toggle-group')
})

test('bottom panel and rail toggles are independent of the dock', async ({ page }) => {
  await page.getByTestId('library-toggle').click()
  await page.getByTestId('logs-toggle').click()
  await expect(page.getByTestId('dock-panel')).toBeVisible()
  await expect(page.getByTestId('bottom-panel')).toBeVisible()
  await expect(page.getByTestId('queue-rail')).toBeVisible()

  // Closing the rail leaves dock and bottom open.
  await page.getByTestId('rail-toggle').click()
  await expect(page.getByTestId('queue-rail')).not.toBeVisible()
  await expect(page.getByTestId('dock-panel')).toBeVisible()
  await expect(page.getByTestId('bottom-panel')).toBeVisible()
  await page.getByTestId('rail-toggle').click()
  await expect(page.getByTestId('queue-rail')).toBeVisible()
})

test('open dock shrinks the canvas instead of covering it', async ({ page }) => {
  const canvas = page.getByTestId('graph-canvas')
  const before = (await canvas.boundingBox())!

  await page.getByTestId('library-toggle').click()
  await expect(page.getByTestId('library-overlay')).toBeVisible()
  const after = (await canvas.boundingBox())!

  // Canvas moved right and narrowed by the dock width; it is still there.
  expect(after.x).toBeGreaterThan(before.x + 200)
  expect(after.width).toBeLessThan(before.width - 200)

  const dock = (await page.getByTestId('dock-panel').boundingBox())!
  expect(dock.x + dock.width).toBeLessThanOrEqual(after.x + 1)
})

test('open bottom panel shrinks the canvas instead of covering it', async ({ page }) => {
  const canvas = page.getByTestId('graph-canvas')
  const before = (await canvas.boundingBox())!

  await page.getByTestId('logs-toggle').click()
  await expect(page.getByTestId('bottom-panel')).toBeVisible()
  const after = (await canvas.boundingBox())!

  expect(after.height).toBeLessThan(before.height - 100)
  const panel = (await page.getByTestId('bottom-panel').boundingBox())!
  expect(after.y + after.height).toBeLessThanOrEqual(panel.y + 1)
})

test('narrow side surfaces preserve tabs and status without document overflow', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 })
  const tabs = page.getByTestId('tab-bar')
  const status = page.getByTestId('status-bar')

  await page.getByTestId('library-toggle').click()
  const dock = page.getByTestId('dock-panel')
  await expect(dock).toBeVisible()
  await expect(tabs).toBeVisible()
  await expect(status).toBeVisible()
  await expect(page.getByTestId('graph-canvas')).toBeHidden()

  const dockBox = (await dock.boundingBox())!
  const tabsBox = (await tabs.boundingBox())!
  expect(dockBox.y).toBeGreaterThanOrEqual(tabsBox.y + tabsBox.height - 1)
  expect(dockBox.x + dockBox.width).toBeLessThanOrEqual(480)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(480)

  const inspector = page.getByRole('complementary', { name: 'Inspector panels' })
  await expect(inspector).toBeVisible()
  const inspectorBox = (await inspector.boundingBox())!
  expect(inspectorBox.y).toBeGreaterThanOrEqual(dockBox.y + dockBox.height - 1)
  expect(inspectorBox.x + inspectorBox.width).toBeLessThanOrEqual(480)

  await page.getByTestId('rail-toggle').click()
  await expect(inspector).toBeHidden()
  await expect(dock).toBeVisible()
  const expandedDockBox = (await dock.boundingBox())!
  expect(expandedDockBox.height).toBeGreaterThan(dockBox.height)
})

test('dock is drag-resizable within bounds via the grab rail', async ({ page }) => {
  await page.getByTestId('library-toggle').click()
  const dock = page.getByTestId('dock-panel')
  const before = (await dock.boundingBox())!

  const rail = (await page.getByTestId('dock-resize').boundingBox())!
  await page.mouse.move(rail.x + rail.width / 2, rail.y + 200)
  await page.mouse.down()
  await page.mouse.move(rail.x + rail.width / 2 + 150, rail.y + 200)
  await page.mouse.up()

  const wider = (await dock.boundingBox())!
  expect(wider.width).toBeGreaterThan(before.width + 100)

  // Dragging far left clamps at the minimum width, not zero.
  await page.mouse.move(wider.x + wider.width, rail.y + 200)
  await page.mouse.down()
  await page.mouse.move(50, rail.y + 200)
  await page.mouse.up()
  const clamped = (await dock.boundingBox())!
  expect(clamped.width).toBeGreaterThanOrEqual(260)
})

test('rail and bottom panel are drag-resizable within bounds', async ({ page }) => {
  // Rail: drag its left-edge handle leftward to widen.
  const rail = page.getByTestId('queue-rail')
  const railBefore = (await rail.boundingBox())!
  const railHandle = (await page.getByTestId('rail-resize').boundingBox())!
  await page.mouse.move(railHandle.x + railHandle.width / 2, railHandle.y + 200)
  await page.mouse.down()
  await page.mouse.move(railHandle.x + railHandle.width / 2 - 150, railHandle.y + 200)
  await page.mouse.up()
  const railAfter = (await rail.boundingBox())!
  expect(railAfter.width).toBeGreaterThan(railBefore.width + 100)

  // Bottom: drag its top-edge handle upward to grow, then far down to clamp.
  await page.getByTestId('logs-toggle').click()
  const panel = page.getByTestId('bottom-panel')
  const panelBefore = (await panel.boundingBox())!
  const topHandle = (await page.getByTestId('bottom-resize').boundingBox())!
  await page.mouse.move(topHandle.x + 300, topHandle.y + topHandle.height / 2)
  await page.mouse.down()
  await page.mouse.move(topHandle.x + 300, topHandle.y + topHandle.height / 2 - 120)
  await page.mouse.up()
  const grown = (await panel.boundingBox())!
  expect(grown.height).toBeGreaterThan(panelBefore.height + 80)

  const grownHandle = (await page.getByTestId('bottom-resize').boundingBox())!
  await page.mouse.move(grownHandle.x + 300, grownHandle.y + grownHandle.height / 2)
  await page.mouse.down()
  await page.mouse.move(grownHandle.x + 300, grownHandle.y + 2000)
  await page.mouse.up()
  const clamped = (await panel.boundingBox())!
  expect(clamped.height).toBeGreaterThanOrEqual(110)
})

test('layout persists across reload: open panels, rail state, and sizes', async ({ page }) => {
  await page.getByTestId('library-toggle').click()
  await page.getByTestId('logs-toggle').click()
  await page.getByTestId('rail-toggle').click() // close the rail

  // Resize the dock so a persisted width is observable.
  const handle = (await page.getByTestId('dock-resize').boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 200)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 150, handle.y + 200)
  await page.mouse.up()
  const dockWidth = (await page.getByTestId('dock-panel').boundingBox())!.width

  await page.reload()
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByTestId('dock-panel')).toHaveAttribute('data-active-panel', 'library')
  await expect(page.getByTestId('bottom-panel')).toHaveAttribute('data-active-panel', 'logs')
  await expect(page.getByTestId('queue-rail')).not.toBeVisible()
  const restored = (await page.getByTestId('dock-panel').boundingBox())!.width
  expect(Math.abs(restored - dockWidth)).toBeLessThanOrEqual(2)

  // And the toggles restore the defaults for the next test's fresh context.
  await page.getByTestId('rail-toggle').click()
  await expect(page.getByTestId('queue-rail')).toBeVisible()
})

test('Ctrl+O opens the library dock', async ({ page }) => {
  await page.keyboard.press('Control+o')
  await expect(page.getByTestId('dock-panel')).toHaveAttribute('data-active-panel', 'library')
  await expect(page.getByTestId('library-overlay')).toBeVisible()
})

test('topbar Customize layout button opens the existing modal', async ({ page }) => {
  const button = page.getByRole('button', { name: 'Customize layout' })
  await expect(button).toBeVisible()
  await button.click()
  await expect(page.getByRole('dialog', { name: 'Customize Layout' })).toBeVisible()
  await expect(page.getByTestId('customize-layout')).toBeVisible()
})

test('Customize Layout toggles supported regions and persists status bar visibility', async ({ page }) => {
  await page.getByTestId('library-toggle').click()
  await page.getByTestId('logs-toggle').click()
  await page.getByTestId('dinkster-menu-button').click()
  await page.locator('[data-item-id="layout.customize"]').click()
  await expect(page.getByTestId('customize-layout')).toBeVisible()
  await expect(page.locator('[data-modal="customize-layout"]')).toContainText('Visibility')
  await expect(page.locator('[data-modal="customize-layout"]')).toHaveJSProperty('open', true)

  const region = (id: string) => page.locator(`[data-layout-region="${id}"]`).getByRole('checkbox')
  await expect(page.locator('[data-layout-region]')).toHaveCount(5)
  expect(await page.locator('[data-layout-region]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-layout-region')))).toEqual([
    'activity-bar', 'primary-dock', 'bottom-panel', 'right-rail', 'status-bar',
  ])
  await expect(region('activity-bar')).toHaveAttribute('aria-checked', 'true')
  await expect(region('primary-dock')).toHaveAttribute('aria-checked', 'true')
  await expect(region('bottom-panel')).toHaveAttribute('aria-checked', 'true')
  await expect(region('right-rail')).toHaveAttribute('aria-checked', 'true')
  await expect(region('status-bar')).toHaveAttribute('aria-checked', 'true')

  await page.getByTestId('status-bar').evaluate((element) => { element.dataset['mountedMarker'] = 'same-status-bar' })
  const statusContent = await page.getByTestId('status-bar').textContent()
  await region('activity-bar').click()
  await region('primary-dock').click()
  await region('bottom-panel').click()
  await region('right-rail').click()
  await region('status-bar').click()
  await expect(page.locator('.left-sidebar')).toBeHidden()
  await expect(page.getByTestId('dock-panel')).not.toBeVisible()
  await expect(page.getByTestId('bottom-panel')).not.toBeVisible()
  await expect(page.getByTestId('queue-rail')).not.toBeVisible()
  await expect(page.getByTestId('status-bar')).toBeHidden()
  await expect(page.getByTestId('status-bar')).toHaveAttribute('data-mounted-marker', 'same-status-bar')
  expect(await page.getByTestId('status-bar').textContent()).toBe(statusContent)

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('customize-layout')).not.toBeVisible()
  await expect(page.getByTestId('dinkster-menu-button')).toBeFocused()
  await page.reload()
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByTestId('status-bar')).toBeHidden()

  await page.getByTestId('dinkster-menu-button').click()
  await page.locator('[data-item-id="layout.customize"]').click()
  await page.getByTestId('layout-reset').click()
  await expect(page.getByTestId('status-bar')).toBeVisible()
  await expect(page.locator('.left-sidebar')).toBeVisible()
  await expect(region('right-rail')).toHaveAttribute('aria-checked', 'true')

  await page.keyboard.press('Escape')
  await page.getByTestId('topbar-search').click()
  await page.getByTestId('universal-search-input').fill('> Customize layout')
  await page.getByTestId('universal-search-input').press('Enter')
  await expect(page.getByTestId('customize-layout')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('topbar-search')).toBeFocused()
})

test('right-zone tab strip shrinks tabs with ellipsis instead of a native scrollbar', async ({ page }) => {
  // Drag the rail to its minimum width so the default tabs plus the zone
  // actions compete for horizontal space.
  const handle = (await page.getByTestId('rail-resize').boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 200)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 400, handle.y + 200)
  await page.mouse.up()

  // The strip never scrolls, so no native scrollbar sliver can render.
  const zone = page.getByTestId('dock-zone-right')
  const tablist = zone.getByRole('tablist', { name: 'Inspector panels' })
  expect(['auto', 'scroll']).not.toContain(await tablist.evaluate((element) => getComputedStyle(element).overflowX))

  // Tabs shrink only to their ellipsis floor, never to zero-width slivers,
  // and each label carries its full title for the product tooltip.
  const tabs = zone.locator('[role="tab"]')
  expect(await tabs.count()).toBeGreaterThanOrEqual(3)
  for (const tab of await tabs.all()) {
    const label = tab.locator('.tab-title')
    await expect(label).toHaveAttribute('data-tooltip-label', (await label.textContent())!)
  }
  await expectWholeTabs(tablist, tabs)
  const hiddenTitles: string[] = []
  for (const tab of await tabs.all()) {
    if (!await tab.isVisible()) hiddenTitles.push((await tab.textContent())!)
  }
  expect(hiddenTitles.length).toBeGreaterThan(0)
  await expect(zone.getByTestId('dock-zone-close')).toBeVisible()

  // At the minimum width the floors cannot all fit. No partial tab remains,
  // and the all-tabs menu keeps every hidden tab reachable by pointer.
  await zone.getByTestId('dock-zone-overflow-button').click()
  const menu = zone.getByTestId('dock-zone-overflow-menu')
  await expect(menu).toBeVisible()
  const items = menu.getByRole('menuitemradio')
  expect(await items.count()).toBe(await tabs.count())
  expect(await items.allTextContents()).toEqual(await tabs.allTextContents())

  // Activating a hidden tab closes the menu and makes that tab wholly visible.
  const title = hiddenTitles.at(-1)!
  await menu.getByRole('menuitemradio', { name: title, exact: true }).click()
  await expect(menu).not.toBeVisible()
  const activeTab = zone.locator('[role="tab"][aria-selected="true"]')
  await expect(activeTab).toHaveText(title)
  await expect(activeTab).toBeVisible()
  await expectWholeTabs(tablist, tabs)

  // Reopening: the active tab's menu item is visibly checked, not merely
  // announced - its background differs from unchecked siblings.
  const overflowButton = zone.getByTestId('dock-zone-overflow-button')
  await overflowButton.click()
  const checked = menu.locator('[role="menuitemradio"][aria-checked="true"]')
  await expect(checked).toHaveText(title)
  const background = (element: Element) => getComputedStyle(element).backgroundColor
  expect(await checked.evaluate(background))
    .not.toBe(await menu.locator('[role="menuitemradio"][aria-checked="false"]').first().evaluate(background))

  // The trigger's tooltip must not sit over the open menu: the label is
  // suppressed while open, so hovering the trigger shows no tooltip.
  await expect(overflowButton).not.toHaveAttribute('data-tooltip-label')
  await overflowButton.hover()
  await expect(page.getByTestId('app-tooltip')).toBeHidden()

  // Escape closes the menu and returns focus to the trigger; a pointer press
  // outside closes it too.
  await page.keyboard.press('Escape')
  await expect(menu).not.toBeVisible()
  await expect(overflowButton).toBeFocused()
  await expect(overflowButton).toHaveAttribute('data-tooltip-label', 'All tabs')
  await overflowButton.click()
  await expect(menu).toBeVisible()
  const canvas = (await page.getByTestId('graph-canvas').boundingBox())!
  await page.mouse.move(canvas.x + 40, canvas.y + 40)
  await page.mouse.down()
  await page.mouse.up()
  await expect(menu).not.toBeVisible()

  // Keyboard-resizing the rail to its maximum clears the clip while the menu
  // is open; no pointer press is involved, so the resize alone must both hide
  // the chrome and drop the open state. Reclipping to the minimum must not
  // resurrect the menu without a fresh activation.
  await overflowButton.click()
  await expect(menu).toBeVisible()
  await page.getByTestId('rail-resize').focus()
  await page.keyboard.press('End')
  await expect(overflowButton).not.toBeVisible()
  await expect(menu).not.toBeVisible()
  await page.keyboard.press('Home')
  await expect(overflowButton).toBeVisible()
  await expect(menu).not.toBeVisible()
})
