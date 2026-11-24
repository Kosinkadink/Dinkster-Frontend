import { expect, nativeAppViewTest as test, subgraphMarkPoint, waitForWorkspaceReady, type Page } from './fixtures.js'
import type { Route } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-01T00:00:00Z'))
  await page.route('/api/**', emptyVisualBackend)
  await page.route('https://registry.dinkster.org/static/replacements/index.json', (route) =>
    route.fulfill({ json: { schemaVersion: 1, items: [] } }),
  )
  await page.route('/memory/**', (route) =>
    route.fulfill({ status: 502, body: 'visual fixture unavailable' }),
  )
  await page.route('/supervisor/**', (route) =>
    route.fulfill({ status: 502, body: 'visual fixture unavailable' }),
  )
  await page.routeWebSocket('**/api/events?*', () => {})
})

const screenshot = async (page: Page, name: string, immediate = false): Promise<void> => {
  if (immediate) {
    expect(await page.screenshot({ animations: 'disabled' })).toMatchSnapshot(`${name}.png`, {
      maxDiffPixelRatio: 0.002,
    })
    return
  }
  await expect(page).toHaveScreenshot(`${name}.png`, {
    animations: 'disabled',
    maxDiffPixelRatio: 0.002,
  })
}

const boot = async (page: Page): Promise<void> => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await waitForWorkspaceReady(page)
  await expect(page.getByTestId('status-connection')).toHaveAttribute('data-state', 'connected')
}

for (const theme of ['dark', 'light'] as const) {
  test(`side and bottom panel selected tabs in ${theme} theme`, async ({ page }) => {
    await page.addInitScript((selected) => {
      localStorage.setItem('dinkster.settings', JSON.stringify({ v: 1, values: { 'dinkster.theme': selected } }))
    }, theme)
    await boot(page)
    await closeGallery(page)
    await page.getByTestId('bottom-panel-toggle').click()
    await page.evaluate(() => window.__dinksterTest!.app.dock.dock('node-help', 'bottom'))
    for (const zone of ['right', 'bottom'] as const) {
      const panel = page.getByTestId(`dock-zone-${zone}`)
      const selected = panel.getByRole('tab', { selected: true })
      const inactive = panel.getByRole('tab', { selected: false }).filter({ visible: true }).first()
      await expect(selected).toBeVisible()
      await expect(inactive).toBeVisible()
      const id = await inactive.getAttribute('data-tab-id')
      await inactive.click()
      await expect(panel.locator(`[data-tab-id="${id}"]`)).toHaveAttribute('aria-selected', 'true')
      await panel.locator(`[data-tab-id="${id}"]`).blur()
      await page.mouse.move(600, 400)
      await expect(page.getByTestId('app-tooltip')).toBeHidden()
      await expect(panel).toHaveScreenshot(`panel-tabs-${zone}-${theme}.png`, { animations: 'disabled' })
    }
  })
}

const closeGallery = async (page: Page): Promise<void> => {
  const close = page.locator('.template-gallery-close')
  if ((await close.count()) > 0 && (await close.first().isVisible()))
    await close.first().click()
  else
    await page.evaluate(() =>
      (window.__dinksterTest!.app as unknown as {
        readonly templateGalleryOpen: { set(value: boolean): void }
      }).templateGalleryOpen.set(false),
    )
  await expect(page.getByTestId('template-gallery')).toBeHidden()
}

for (const theme of ['dark', 'light'] as const) {
  test(`brand assets and persisted ${theme} theme`, async ({ page }) => {
    await page.addInitScript((selected) => {
      localStorage.setItem('dinkster.settings', JSON.stringify({ v: 1, values: { 'dinkster.theme': selected } }))
    }, theme)
    let releaseSymbol!: () => void
    const symbolReady = new Promise<void>((resolve) => { releaseSymbol = resolve })
    let delayedSymbols = 0
    await page.route(/\/branding\/svg\/dinkster-symbol-color\.svg(?:\?.*)?$/, async (route) => {
      if (route.request().resourceType() !== 'image') return route.continue()
      delayedSymbols += 1
      await symbolReady
      await route.continue()
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__dinksterTest?.app !== undefined)
    const headerBefore = await page.locator('.dinkster-window-toolbar-host').boundingBox()
    const trigger = page.getByTestId('dinkster-menu-button')
    await expect.poll(() => delayedSymbols).toBeGreaterThan(0)
    const triggerBefore = await trigger.boundingBox()
    const symbolBefore = (await trigger.locator('img:visible').boundingBox())!
    expect(symbolBefore.width).toBe(22)
    expect(symbolBefore.height).toBe(22)
    releaseSymbol()
    await expect.poll(() => trigger.locator('img:visible')
      .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
    expect(await page.locator('.dinkster-window-toolbar-host').boundingBox()).toEqual(headerBefore)
    expect(await trigger.boundingBox()).toEqual(triggerBefore)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(trigger).toHaveAccessibleName('Dinkster')
    await expect(trigger.locator('img:visible')).toHaveAttribute('src', /dinkster-symbol-color\.svg/)
    await expect(trigger.locator('.dinkster-wordmark')).toHaveCount(0)
    const expectedCanvas = theme === 'dark' ? 'rgb(14, 20, 20)' : 'rgb(247, 248, 250)'
    await expect(page.locator('body')).toHaveCSS('background-color', expectedCanvas)
    const manifest = await (await page.request.get('/manifest.webmanifest')).json()
    expect(manifest.name).toBe('Dinkster')
    for (const icon of manifest.icons) {
      const response = await page.request.get(new URL(icon.src, page.url()).href)
      expect(response.ok()).toBe(true)
      expect(response.headers()['content-type']).toContain('image/png')
    }
    await page.evaluate(() => {
      const app = window.__dinksterTest!.app as unknown as {
        readonly backends: { get(): readonly { readonly templatesEnabled: { set(value: boolean): void } }[] }
        readonly templateGalleryOpen: { set(value: boolean): void }
      }
      app.backends.get()[0]!.templatesEnabled.set(true)
      app.templateGalleryOpen.set(true)
    })
    await expect(page.getByTestId('template-gallery')).toBeVisible()
    await screenshot(page, `brand-gallery-${theme}`)
    await closeGallery(page)
    await screenshot(page, `brand-shell-${theme}`)
    await page.evaluate((selected) => {
      window.__dinksterTest!.app.settings.set('dinkster.theme', selected === 'dark' ? 'light' : 'dark')
    }, theme)
    await expect(page.locator('body')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(247, 248, 250)' : 'rgb(14, 20, 20)')
    await expect(trigger.locator('img:visible')).toHaveAttribute('src', /dinkster-symbol-color\.svg/)
    await page.addStyleTag({ content: '.dinkster-window-toolbar-host[data-platform="win32"] { padding-right:148px }' })
    const header = page.locator('.dinkster-window-toolbar-host')
    await header.evaluate((node) => { (node as HTMLElement).dataset['platform'] = 'win32' })
    await page.setViewportSize({ width: 390, height: 900 })
    await expect(trigger).toHaveAccessibleName('Dinkster')
    expect((await trigger.boundingBox())!.width).toBe(44)
    for (const control of await header.locator('button:visible').all()) {
      const box = (await control.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(12)
      expect(box.x + box.width).toBeLessThanOrEqual(242)
      expect(box.y + box.height).toBeLessThanOrEqual(56)
    }
    await page.evaluate(() => {
      const app = window.__dinksterTest!.app
      app.reportProblems(app.activeTab()!.id, [{ severity: 'error', origin: 'runtime', code: 'toolbar.attention', message: 'Toolbar attention fixture.' }])
    })
    const rail = page.getByTestId('rail-toggle')
    const attention = rail.locator('.panel-indicator')
    await expect(attention).toBeVisible()
    await expect(attention).toHaveCSS('position', 'absolute')
    // The keyed badge can be replaced by a problem-list publication between protocol calls.
    const { railBox, iconBox, badgeBox } = await page.evaluate(() => {
      const element = document.querySelector('[data-testid="rail-toggle"]')!
      return {
        railBox: element.getBoundingClientRect().toJSON(),
        iconBox: element.querySelector('svg')!.getBoundingClientRect().toJSON(),
        badgeBox: element.querySelector('.panel-indicator')!.getBoundingClientRect().toJSON(),
      }
    })
    expect(iconBox.width).toBe(20)
    expect(iconBox.height).toBe(18)
    expect(badgeBox.y).toBeLessThan(railBox.y)
    expect(badgeBox.x).toBeGreaterThan(iconBox.x)
    await trigger.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(trigger).toBeFocused()
  })

}

const openDock = async (page: Page, testId: string): Promise<void> => {
  const toggle = page.getByTestId(testId)
  if ((await toggle.getAttribute('aria-pressed')) !== 'true')
    await toggle.click()
}

const openRail = async (page: Page, title: string): Promise<void> => {
  const rail = page.getByTestId('dock-zone-right')
  if (!(await rail.isVisible())) await page.getByTestId('rail-toggle').click()
  const tab = rail.getByRole('tab', { name: title, exact: true })
  if ((await tab.count()) > 0 && (await tab.first().isVisible())) {
    await tab.first().click()
    return
  }
  await rail.getByTestId('dock-zone-overflow-button').click()
  await page
    .getByRole('menuitemradio')
    .filter({ hasText: title })
    .first()
    .click()
}

const openModal = async (page: Page, id: string): Promise<void> => {
  await page.evaluate(
    (panel) => (window.__dinksterTest!.app as unknown as {
      readonly modalPanel: { set(value: string): void }
    }).modalPanel.set(panel),
    id,
  )
}

const emptyVisualBackend = async (route: Route): Promise<void> => {
  const path = new URL(route.request().url()).pathname
  if (path.endsWith('/api/nodes')) {
    await route.fulfill({ json: {
      schemaVersion: 1, epoch: 1,
      dinkster: { version: 'visual-fixture', schemaWire: 2 },
      nodes: {},
    } })
  } else if (path.endsWith('/api/models/providers/huggingface')) {
    await route.fulfill({ json: { provider: 'huggingface', configured: false } })
  } else if (path.endsWith('/api/models/settings')) {
    await route.fulfill({ json: {
      settings: { version: 1, downloadLocation: null, locations: [] },
      locations: [], revision: 'visual', project: 'default', changesAllowed: true,
      restartRequired: false, pendingRemovals: [],
    } })
  } else if (path.endsWith('/api/mounts')) {
    await route.fulfill({ json: { mounts: [] } })
  } else if (path.endsWith('/api/assets/catalog')) {
    await route.fulfill({ json: { assets: [] } })
  } else if (path.endsWith('/api/templates')) {
    await route.fulfill({ json: { templates: [] } })
  } else if (path.endsWith('/api/docs')) {
    await route.fulfill({ json: { docs: [{
      pack: 'guide-fixture', kind: 'guide', id: 'read-a-guide', defaultLocale: 'en',
      locales: { en: { title: 'Read a guide', summary: 'Learn from a connected pack.', digest: `sha256:${'a'.repeat(64)}`, assets: {} } },
    }] } })
  } else if (path.endsWith('/api/sessions')) {
    await route.fulfill({ json: { sessions: [] } })
  } else if (path.endsWith('/api/history/runs')) {
    await route.fulfill({ json: { records: [] } })
  } else if (path.endsWith('/api/projects/default')) {
    await route.fulfill({ json: { project: {
      id: 'default', name: 'Default', created: '2026-01-01T00:00:00Z', revision: 1, deleted: false,
    } } })
  } else if (path.endsWith('/api/projects/default/needs')) {
    await route.fulfill({ json: { packs: [], installed: [], extra: [], unknown: [] } })
  } else if (path.endsWith('/api/workflows/plan')) {
    await route.fulfill({ json: { packs: [], assets: [], errors: [] } })
  } else {
    await route.fulfill({ status: 502, body: 'visual fixture unavailable' })
  }
}

test('stored run outputs load only after selection and retain their original identity', async ({ page }, testInfo) => {
  const records = ['stored-good', 'stored-failed', 'stored-wrong'].map((runId, index) => ({
    runId, jobRef: runId, scope: 'local', clientId: `other-browser-${index}`, jobId: `shared-job-${index}`,
    state: 'completed', priority: 0, submittedAt: 1767225600 - index * 10, finishedAt: 1767225605 - index * 10,
    executed: 1, cached: 0, skipped: 0,
  }))
  const jobs: string[] = []
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  let historyPages = 0
  await page.route('**/api/history?*', (route) => {
    historyPages += 1
    return route.fulfill({ json: { records } })
  })
  await page.route('**/api/history/*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)
    return route.fulfill({ json: records.find((record) => record.runId === id) })
  })
  await page.route('**/api/jobs/by-ref/*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!
    jobs.push(id)
    if (id === 'stored-failed') return route.fulfill({ status: 503 })
    const record = records.find((record) => record.runId === id)!
    if (id === 'stored-good') await released
    return route.fulfill({ json: { ...record, jobRef: id === 'stored-wrong' ? 'another-run' : id,
      outputs: { image: { result: { typeId: 'IMAGE', fingerprint: 'stored-image', meta: { shape: [1, 32, 64, 3] } } } },
    } })
  })
  const values: URL[] = []
  await page.route('**/api/values?*', async (route) => {
    const url = new URL(route.request().url())
    values.push(url)
    if (!url.searchParams.has('rendition')) return route.fulfill({ json: { available: true,
      descriptor: { typeId: 'IMAGE', fingerprint: 'stored-image', meta: { shape: [1, 32, 64, 3] } },
      renditions: [{ kind: 'png', mime: 'image/png' }],
    } })
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32
      const context = canvas.getContext('2d')!; context.fillStyle = '#32e6c5'; context.fillRect(0, 0, 64, 32)
      return canvas.toDataURL('image/png').split(',')[1]!
    })
    return route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64'),
      headers: { 'X-Dinkster-Fingerprint': 'stored-image', 'X-Dinkster-Rendition': 'png' } })
  })
  await boot(page)
  await closeGallery(page)
  await openRail(page, 'Runs')
  await page.getByTestId('runs-scope').click()
  await page.getByRole('option', { name: 'All workflows', exact: true }).click()
  const rows = page.getByTestId('collection-entry')
  await expect(rows).toHaveCount(3)
  expect(jobs).toEqual([])
  await expect(page.locator('.runs-output-thumbnails')).toHaveCount(0)
  const good = rows.filter({ hasText: 'shared-j' }).nth(0)
  await good.click()
  await expect(good).toContainText('Loading retained outputs...')
  await page.mouse.move(600, 400)
  await page.keyboard.press('Escape')
  await page.screenshot({ path: testInfo.outputPath('stored-run-loading.png'), animations: 'disabled' })
  const previousPages = historyPages
  await page.evaluate(() => window.__dinksterTest!.app.backendsTick.update((value) => value + 1))
  await expect.poll(() => historyPages).toBeGreaterThan(previousPages)
  release()
  await expect(good.locator('.output-thumbnail img')).toHaveJSProperty('naturalWidth', 64)
  expect(jobs).toEqual(['stored-good'])
  expect(values.length).toBeGreaterThan(0)
  expect(values.every((url) => url.searchParams.get('clientId') === 'other-browser-0' && url.searchParams.get('jobId') === 'shared-job-0')).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.store.executions.get().size)).toBe(0)
  await page.screenshot({ path: testInfo.outputPath('stored-run-selected.png'), animations: 'disabled' })
  await rows.nth(1).click()
  await expect(rows.nth(1)).toContainText('Could not load outputs:')
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
  await rows.nth(2).click()
  await expect(rows.nth(2)).toContainText('response run identity mismatch')
  await expect(rows.nth(2).locator('.output-thumbnail')).toHaveCount(0)
  await rows.nth(2).scrollIntoViewIfNeeded()
  await page.mouse.move(600, 400)
  await page.keyboard.press('Escape')
  await page.screenshot({ path: testInfo.outputPath('stored-run-error.png'), animations: 'disabled' })
  await page.route('**/api/history?*', (route) => route.fulfill({ json: { records: [] } }))
  await page.getByTestId('runs-scope').click()
  await page.getByRole('option', { name: 'This workflow', exact: true }).click()
  await page.getByTestId('runs-scope').click()
  await page.getByRole('option', { name: 'All workflows', exact: true }).click()
  const empty = page.getByTestId('runs-panel').getByTestId('collection-empty')
  await expect(empty).toHaveText('No finished runs are stored')
  await page.screenshot({ path: testInfo.outputPath('stored-runs-empty.png'), animations: 'disabled' })
  await page.getByTestId('runs-panel').getByTestId('collection-search').fill('absent run')
  await expect(empty).toHaveText('No matches.')
  await page.getByTestId('runs-panel').getByTestId('collection-source-action').click()
  const confirmation = page.getByTestId('runs-clear-confirmation')
  await expect(confirmation).toHaveText('Removes every finished run on this backend, for all workflows. Saved files stay.')
  await page.screenshot({ path: testInfo.outputPath('clear-finished-confirmation-1440.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 900, height: 900 })
  await expect(confirmation).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('clear-finished-confirmation-900.png'), animations: 'disabled' })
})

test('App view validation and remote failures keep editable controls', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.route('**/api/choices/panel-state-visual*', (route) => route.fulfill({ status: 503, body: 'visual source unavailable' }))
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'AppNoticeVisual', displayName: 'App feedback', category: 'test', source: 'visual', isOutputNode: true,
      body: [
        { kind: 'input', id: 'count', type: { kind: 'concrete', name: 'INT' }, optional: false, widget: { widgetType: 'INT', options: {}, default: 5 } },
        { kind: 'input', id: 'choice', type: { kind: 'concrete', name: 'COMBO' }, optional: false, widget: { widgetType: 'COMBO', options: {}, default: 'old', remote: { route: '/api/choices/panel-state-visual', maxRetries: 0 } } },
      ],
    }])
    await app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'app-notice-visual', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { n: { id: 'n', type: 'AppNoticeVisual', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { n: { position: { x: 100, y: 100 } } } } } },
      ext: { 'dinkster.exposed': ['count', 'choice'].map((inputId) => ({ graphId: 'g0', nodeId: 'n', inputId })) },
    }, 'App feedback')
  })
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
  await page.getByTestId('app-view-number').fill('invalid')
  await page.getByTestId('app-view-number').press('Enter')
  await expect(page.getByTestId('app-view-error')).toHaveText('Enter an exact integer from -9223372036854775808 to 18446744073709551615.')
  await page.getByTestId('app-view-combo').click()
  await expect(page.getByTestId('app-view-remote-error')).toBeVisible()
  await page.keyboard.press('Escape')
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await page.mouse.move(0, 0)
    await expect(page.getByTestId('app-view-number')).toHaveValue('invalid')
    await screenshot(page, `app-control-errors-${width}`)
  }
  await page.getByTestId('app-view-number').fill('11')
  await page.getByTestId('app-view-number').press('Enter')
  await expect(page.getByTestId('app-view-error')).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n!.values.count)).toBe(11)
})

test('backend add error and Resources rows at desktop and compact widths', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      addBackend(url: string, label: string, persist: boolean, protocol: string): void
    }
    app.addBackend('/panel-visual', 'Panel visual', false, 'dinkster')
  })
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await openDock(page, 'backends-sidebar-toggle')
    const backends = page.getByTestId('backends-panel')
    await expect(backends.getByRole('heading', { name: 'Backend connections', exact: true })).toBeVisible()
    if (!await backends.getByTestId('backend-url-input').isVisible()) await backends.getByRole('button', { name: 'Add backend', exact: true }).click()
    await backends.getByTestId('backend-url-input').fill('http://127.0.0.1:1')
    await backends.getByTestId('backend-add').click()
    await expect(backends.getByRole('alert').filter({ hasText: /could not|failed|unreachable/i }).first()).toBeVisible()
    const fonts = await backends.locator('input, button, select, textarea').evaluateAll((controls) =>
      controls.map((control) => getComputedStyle(control).fontFamily),
    )
    expect(fonts.every((font) => !font.includes('Arial'))).toBe(true)
    await expect(backends.getByTestId('backend-add')).toHaveAttribute('data-role', 'add')
    await expect(backends.getByTestId('backend-add')).toHaveAttribute('data-fill', 'solid')
    await screenshot(page, `runtime-panel-backends-error-${width}`)
    await openDock(page, 'memory-sidebar-toggle')
    const resources = page.getByTestId('resources-panel')
    await expect(resources).toBeVisible()
    await expect(resources.locator('.dinkster-resource-backend').first()).toBeVisible()
    await expect(resources.getByRole('alert')).toBeVisible()
    await expect(resources.getByText('Loading resources...', { exact: true })).toHaveCount(0)
    await screenshot(page, `runtime-panel-memory-${width}`)
  }
})

test('Boundary is hidden at root and shows definition empty states at desktop and compact widths', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await page.evaluate(() => (window.__dinksterTest!.app as unknown as {
      createWorkflow(): void
    }).createWorkflow())
    await expect(page.getByTestId('boundary-panel')).toHaveCount(0)
    await expect(page.getByTestId('dock-tab-boundary')).toHaveCount(0)
    expect(await page.evaluate(async () => {
      const app = window.__dinksterTest!.app
      // Blank workflow creation starts promotion without waiting for it.
      // Opening the fixture must not race that session replacement.
      await (app as unknown as { enableWorkspaceAuthority(): Promise<void> }).enableWorkspaceAuthority()
      return app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'boundary-visual', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Root', nodes: { occurrence: { id: 'occurrence', type: '#sub', values: {} } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
        },
        sub: {
          id: 'sub', name: 'Nested workflow', nodes: {}, links: {}, nets: {}, reroutes: {},
          boundary: { body: [] }, nextOrdinal: 1,
        },
      },
      view: { graphs: {
        root: { nodes: { occurrence: { position: { x: 200, y: 100 } } } },
        sub: { nodes: {} },
      } },
      }, 'Boundary visual')
    })).toEqual([])
    await expect(page.getByTestId('boundary-panel')).toHaveCount(0)
    await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
    const mark = await subgraphMarkPoint(page, 'occurrence')
    await page.mouse.dblclick(mark.x, mark.y)
    await openRail(page, 'Boundary')
    await expect(page.getByTestId('boundary-prompt')).toHaveCount(0)
    await expect(page.getByTestId('boundary-empty')).toHaveCount(1)
    await expect(page.getByTestId('boundary-empty')).toContainText('No rows yet.')
    await screenshot(page, `boundary-empty-sections-${width}`)
  }
})

test('HTTP metadata errors expose shell status and panel retries', async ({ page }) => {
  let recover = false
  await page.route('**/offline-visual/api/**', async (route) => {
    if (!recover) return route.fulfill({ status: 503, body: 'Metadata fixture unavailable' })
    await emptyVisualBackend(route)
  })
  await boot(page)
  await closeGallery(page)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): { id: string }
      addBackend(url: string, label: string, persist: boolean, protocol: string): { id: string; connection: { status: { set(value: string): void } } }
      setTabTarget(tab: string, backend: string): void
      refreshBackendSchemas(backend: unknown): Promise<void>
    }
    const backend = app.addBackend('/offline-visual', 'Offline visual', false, 'dinkster')!
    app.setTabTarget(app.activeTab()!.id, backend.id)
    backend.connection.status.set('connected')
    await app.refreshBackendSchemas(backend)
  })
  await expect(page.getByTestId('status-connection')).toHaveAttribute('data-state', 'disconnected')
  await expect.poll(() => page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return app.backendForTab(app.activeTab()!).schemaState.get().status
  })).toBe('error')
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    for (const [toggle, name] of [['library-toggle', 'library'], ['assets-toggle', 'assets']] as const) {
      await openDock(page, toggle)
      const state = page.getByTestId('dock-zone-left').getByRole('alert').filter({ hasText: 'Backend data unavailable' })
      await expect(state).toContainText('GET /api/nodes failed: 503')
      await expect(state.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled()
      await page.mouse.move(width / 2, height / 2)
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('app-tooltip')).toBeHidden()
      await screenshot(page, `metadata-error-${name}-${width}`)
    }
    await openDock(page, 'backends-sidebar-toggle')
    const card = page.locator('[data-testid="backend-row"]').filter({ hasText: 'Offline visual' })
    if (!await card.getByTestId('backend-schema-retry').isVisible()) await card.locator('summary').first().click()
    await expect(card.getByTestId('backend-schema-retry')).toBeEnabled()
    await expect(card.getByTestId('output-mount-settings')).toHaveCount(0)
    await card.getByTestId('backend-schema-retry').scrollIntoViewIfNeeded()
    await page.mouse.move(width / 2, height / 2)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('app-tooltip')).toBeHidden()
    await screenshot(page, `metadata-error-backends-${width}`)
  }
  recover = true
  await openDock(page, 'library-toggle')
  await page.getByTestId('dock-zone-left').getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByTestId('dock-zone-left').getByRole('alert')).toHaveCount(0)
  await expect(page.getByTestId('status-connection')).not.toHaveAttribute('data-state', 'disconnected')
  await expect.poll(() => page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return app.backendForTab(app.activeTab()!).registry.get() !== undefined
  })).toBe(true)
})

test('Library Assets and Runs use shared empty and loading states', async ({ page }) => {
  let mode: 'empty' | 'loading' | 'error' = 'empty'
  let release: (() => void) | undefined
  await page.route('**/collection-visual/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/api/mounts')) return route.fulfill({ json: { mounts: [] } })
    if (path.endsWith('/api/library')) {
      if (mode === 'loading') await new Promise<void>((resolve) => { release = resolve })
      return mode === 'error'
        ? route.fulfill({ status: 503, body: 'Library fixture unavailable' })
        : route.fulfill({ json: { records: [] } })
    }
    await emptyVisualBackend(route)
  })
  await boot(page)
  await closeGallery(page)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): { id: string }
      addBackend(url: string, label: string, persist: boolean, protocol: string): { id: string }
      setTabTarget(tab: string, backend: string): void
      refreshBackendSchemas(backend: unknown): Promise<void>
    }
    const backend = app.addBackend('/collection-visual', 'Collection visual', false, 'dinkster')
    app.setTabTarget(app.activeTab().id, backend.id)
    await app.refreshBackendSchemas(backend)
  })
  await openDock(page, 'library-toggle')
  const library = page.getByTestId('library-overlay')
  for (const state of ['empty', 'loading', 'error'] as const) {
    await page.setViewportSize({ width: 1440, height: 900 })
    await library.getByTestId('library-source-select').click()
    await page.getByRole('option', { name: 'Packs', exact: true }).click()
    mode = state
    await library.getByTestId('library-source-select').click()
    await page.getByRole('option', { name: 'Workflows', exact: true }).click()
    const presentation = library.locator('[data-collection-state]')
    await expect(presentation).toHaveAttribute('data-collection-state', state)
    if (state === 'loading') await expect(presentation.getByRole('status')).toContainText('Loading workflows')
    if (state === 'error') await expect(presentation.getByRole('alert')).toContainText('GET /api/library failed: 503')
    if (state === 'empty') {
      await expect(presentation).toContainText('No saved workflows')
      await expect(presentation.locator('img')).toHaveCount(0)
    }
    if (state === 'error') await expect(library.getByTestId('collection-retry')).toBeEnabled()
    for (const [width, height] of [[1440, 900], [900, 700]] as const) {
      await page.setViewportSize({ width, height })
      await page.mouse.move(width / 2, height / 2)
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('app-tooltip')).toBeHidden()
      await screenshot(page, `library-${state}-${width}`)
    }
    if (state === 'loading') { release?.(); await expect(presentation).toHaveAttribute('data-collection-state', 'empty') }
  }
  mode = 'empty'
  await library.getByTestId('collection-retry').click()
  await expect(library.getByTestId('collection-retry')).toHaveCount(0)
  await openDock(page, 'assets-toggle')
  await expect(page.getByTestId('assets-overlay')).toContainText('No assets')
  await openRail(page, 'Runs')
  await expect(page.getByTestId('runs-panel')).toContainText('No runs for this workflow')
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await page.mouse.move(width / 2, height / 2)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('app-tooltip')).toBeHidden()
    await screenshot(page, `assets-outputs-empty-${width}`)
  }
})

test('Storage settings distinguish accounting policy and permission failures', async ({ page }) => {
  let state: 'ready' | 'unavailable' | 'forbidden' = 'ready'
  await page.route('**/api/library/storage', (route) => state === 'forbidden'
    ? route.fulfill({ status: 403, body: 'operator required' })
    : route.fulfill({ json: {
      temporaryBytes: state === 'ready' ? 37 : null, vaultBytes: 513, adoptedBytes: 299,
      reclaimableBytes: null, collectionEnabled: false, blocked: ['owner_completeness_unknown'],
      policyAvailable: state === 'ready', limitBytes: state === 'ready' ? 21474836480 : null,
    } }))
  await boot(page)
  await closeGallery(page)
  await openModal(page, 'settings')
  await page.getByTestId('modal-surface').getByRole('button', { name: 'Storage', exact: true }).click()
  const panel = page.getByTestId('library-storage-settings')
  await expect(panel.getByText('513 bytes', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Clear eligible assets', exact: true })).toBeDisabled()
  await screenshot(page, 'storage-ready-1440')
  await panel.getByRole('button', { name: 'Clear eligible assets', exact: true }).scrollIntoViewIfNeeded()
  await expect(panel.locator('#library-storage-limit')).toHaveValue('21474836480')
  await screenshot(page, 'storage-ready-controls-1440')
  await page.setViewportSize({ width: 900, height: 700 })
  state = 'unavailable'
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(panel.getByText('The saved policy is unavailable, not unlimited. Editing is disabled.', { exact: true })).toBeVisible()
  await expect(panel.getByRole('checkbox')).not.toBeChecked()
  await expect(panel.getByRole('checkbox')).toBeDisabled()
  await screenshot(page, 'storage-unavailable-900')
  state = 'forbidden'
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('403')
  await expect(panel.getByRole('button', { name: 'Apply limit', exact: true })).toBeDisabled()
  await screenshot(page, 'storage-forbidden-900')
})

test('Settings and subgraph cleanup empty states remain usable', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await openModal(page, 'settings')
    await page.getByRole('searchbox', { name: 'Search settings', exact: true }).fill('unmatched-setting-507')
    await expect(page.getByText('No matching settings', { exact: true })).toBeVisible()
    await page.mouse.move(0, 0)
    await screenshot(page, `settings-no-results-${width}`)
    await openModal(page, 'subgraph-definitions')
    await expect(page.getByText('No unused definitions', { exact: true })).toBeVisible()
    await page.getByText('Retained definitions (0)', { exact: true }).click()
    await expect(page.getByText('No reusable subgraph definitions are reachable from the workflow root.', { exact: true })).toBeVisible()
    await page.mouse.move(0, 0)
    await screenshot(page, `subgraph-empty-${width}`)
  }
})

test('Collaboration discovery distinguishes unavailable loading empty and failed reads', async ({ page }) => {
  let mode: 'loading' | 'empty' | 'error' | 'ready' = 'loading'
  let release: (() => void) | undefined
  await page.route('**/collab-visual/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/api/sessions')) {
      if (mode === 'loading') await new Promise<void>((resolve) => { release = resolve })
      return mode === 'error'
        ? route.fulfill({ status: 503, body: 'Session fixture unavailable' })
        : route.fulfill({ json: { sessions: mode === 'ready' ? [{
          protocolVersion: 1, sessionId: 'shared-workflow-session', scope: 'shared',
          documentId: 'A workflow available for collaboration', revision: 17, snapshotRevision: 12,
        }] : [] } })
    }
    if (path.endsWith('/api/mounts')) return route.fulfill({ json: { mounts: [] } })
    await emptyVisualBackend(route)
  })
  await boot(page)
  await closeGallery(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      backends: { set(value: never[]): void }
      backendsTick: { update(change: (value: number) => number): void }
    }
    app.backends.set([])
    app.backendsTick.update((value) => value + 1)
  })
  const capture = async (state: string): Promise<void> => {
    for (const [width, height] of [[1440, 900], [900, 700]] as const) {
      await page.setViewportSize({ width, height })
      await page.mouse.move(0, 0)
      if (state === 'ready') {
        const row = await page.getByTestId('collab-session').locator('.product-list-row').boundingBox()
        const join = await page.getByTestId('collab-join').boundingBox()
        expect(join!.x + join!.width).toBeGreaterThan(row!.x + row!.width - 20)
      }
      await screenshot(page, `collab-discovery-${state}-${width}`)
    }
  }
  await openModal(page, 'collab')
  await expect(page.getByTestId('collab-no-backend')).toContainText('No collaboration backend')
  await expect(page.getByTestId('collab-refresh')).toBeDisabled()
  await capture('unavailable')
  await openModal(page, '')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      addBackend(url: string, label: string, persist: boolean, protocol: string): void
    }
    app.addBackend('/collab-visual', 'Collaboration visual', false, 'dinkster')
  })
  await openModal(page, 'collab')
  await expect(page.getByTestId('collab-loading')).toContainText('Loading shared sessions')
  // Compare the square at zero rotation, not an animation-dependent bounding box.
  await page.getByTestId('collab-loading').locator('.collab-spinner').evaluate((element) => {
    for (const animation of element.getAnimations()) {
      animation.pause()
      animation.currentTime = 0
    }
  })
  const spinner = await page.getByTestId('collab-loading').locator('.collab-spinner').boundingBox()
  expect(spinner!.width).toBeGreaterThan(8)
  expect(spinner!.height).toBe(spinner!.width)
  await page.getByTestId('collab-loading').locator('.collab-spinner').evaluate((element) => {
    for (const animation of element.getAnimations()) animation.play()
  })
  await capture('loading')
  mode = 'empty'
  await expect.poll(() => release !== undefined).toBe(true)
  release?.()
  await expect(page.getByTestId('collab-empty')).toContainText('No shared sessions')
  await capture('empty')
  mode = 'error'
  await page.getByTestId('collab-refresh').click()
  await expect(page.getByTestId('collab-list-error')).toContainText('Sessions could not be loaded')
  await expect(page.getByTestId('collab-refresh')).toHaveAttribute('aria-busy', 'false')
  await capture('error')
  mode = 'empty'
  await page.getByTestId('collab-refresh').click()
  await expect(page.getByTestId('collab-empty')).toContainText('No shared sessions')
  await expect(page.getByTestId('collab-list-error')).toHaveCount(0)
  mode = 'ready'
  await page.getByTestId('collab-refresh').click()
  await expect(page.getByTestId('collab-session')).toContainText('A workflow available for collaboration')
  await expect(page.getByTestId('collab-session')).toContainText('Revision 17')
  await expect(page.getByTestId('collab-join')).toBeEnabled()
  await capture('ready')
})

test('App view explains an empty flow and an empty arrangement group', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.evaluate(async () => {
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'empty-app-visual', root: 'root',
      graphs: { root: { id: 'root', name: 'Empty app', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: { root: { nodes: {} } } },
    }, 'Empty app')
  })
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
  await expect(page.getByTestId('app-view-empty')).toContainText('Nothing is exposed yet.')
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await page.mouse.move(0, 0)
    await screenshot(page, `app-flow-empty-${width}`)
  }
  await page.getByTestId('app-view-arrange-toggle').click()
  await page.getByTestId('app-layout-add-group').click()
  await expect(page.getByText('Move a control, preview, or text block into this group.', { exact: true })).toBeVisible()
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await page.mouse.move(0, 0)
    await screenshot(page, `app-group-empty-${width}`)
  }
})

test('Template gallery presents loading error retry and empty search states', async ({ page }) => {
  let mode: 'loading' | 'empty' | 'error' = 'loading'
  let mountChangesAllowed = false
  let release: (() => void) | undefined
  await page.route('**/gallery-visual/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/api/templates')) {
      if (mode === 'loading') await new Promise<void>((resolve) => { release = resolve })
      return mode === 'error'
        ? route.fulfill({ status: 503, body: 'Template fixture unavailable' })
        : route.fulfill({ json: { templates: [] } })
    }
    if (path.endsWith('/api/mounts')) return route.fulfill({ json: { mounts: [], mountChangesAllowed } })
    if (path.endsWith('/api/settings')) return route.fulfill({ json: { features: { templates: { enabled: true } }, categories: { available: [], granted: [] }, settings: {} } })
    await emptyVisualBackend(route)
  })
  await boot(page)
  await closeGallery(page)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): { id: string }
      addBackend(url: string, label: string, persist: boolean, protocol: string): { id: string }
      setTabTarget(tab: string, backend: string): void
      refreshBackendSchemas(backend: unknown): Promise<void>
      templateGalleryOpen: { set(value: boolean): void }
    }
    const backend = app.addBackend('/gallery-visual', 'Gallery visual', false, 'dinkster')
    app.setTabTarget(app.activeTab().id, backend.id)
    await app.refreshBackendSchemas(backend)
    app.templateGalleryOpen.set(true)
  })
  const gallery = page.getByTestId('template-gallery')
  const capture = async (state: string): Promise<void> => {
    for (const [width, height] of [[1440, 900], [900, 700]] as const) {
      await page.setViewportSize({ width, height })
      if (state === 'folder-form') {
        const grant = gallery.getByRole('button', { name: 'Grant folder', exact: true })
        await grant.scrollIntoViewIfNeeded()
        await expect(grant).toBeInViewport({ ratio: 1 })
      }
      await page.mouse.move(0, 0)
      await screenshot(page, `gallery-${state}-${width}`)
    }
  }
  await expect(gallery.getByRole('status')).toContainText('Loading starter templates...')
  await capture('loading')
  await expect.poll(() => release !== undefined).toBe(true)
  mode = 'error'
  release?.()
  await expect(gallery.getByRole('alert')).toContainText('GET /api/templates failed: 503')
  await expect(gallery.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled()
  await capture('error')
  mode = 'empty'
  await gallery.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(gallery.getByText('No starter templates are available.', { exact: true })).toBeVisible()
  await expect(gallery.getByRole('alert')).toHaveCount(0)
  await expect(gallery.getByText('Grant read-only access to an existing folder. Dinkster indexes models in place without copying them.', { exact: true })).toBeVisible()
  await capture('empty')
  await gallery.getByTestId('template-gallery-search').fill('unmatched-template-507')
  await expect(gallery.getByText('No starter templates match this search.', { exact: true })).toBeVisible()
  await capture('no-matches')
  await gallery.getByTestId('template-gallery-search').press('Escape')
  await expect(gallery.getByTestId('template-gallery-search')).toHaveValue('')
  await expect(gallery.getByText('No starter templates are available.', { exact: true })).toBeVisible()
  await expect(gallery.getByRole('button', { name: 'Grant folder', exact: true })).toHaveCount(0)
  mountChangesAllowed = true
  await closeGallery(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { templateGalleryOpen: { set(value: boolean): void } }
    app.templateGalleryOpen.set(true)
  })
  await expect(gallery.getByRole('button', { name: 'Grant folder', exact: true })).toBeVisible()
  await gallery.getByLabel('Path', { exact: true }).fill('/models/shared')
  await gallery.getByLabel('Mount name', { exact: true }).fill('shared-models')
  await expect(gallery.getByRole('button', { name: 'Grant folder', exact: true })).toBeEnabled()
  await capture('folder-form')
})

test('Problems Selection only explains an empty selection and absent document', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.evaluate(async () => {
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'selection-empty', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: {} },
    }, 'Empty workflow')
  })
  await openRail(page, 'Problems')
  const panel = page.getByTestId('problems-panel')
  await panel.getByRole('checkbox', { name: 'Selection only' }).check()
  await expect(panel.getByTestId('problems-selection')).toHaveText('Nothing selected')
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await screenshot(page, `problems-selection-empty-${width}`)
  }
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { tabs: { set(value: readonly unknown[]): void } }
    app.tabs.set([])
  })
  await expect(panel.getByTestId('problems-selection')).toHaveText('Nothing selected')
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await screenshot(page, `problems-selection-no-document-${width}`)
  }
})

test('Badge popover empty and unavailable states preserve focus and actions', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.evaluate(async () => {
    const bridge = window.__dinksterTest!
    bridge.app.registerSchemas([
      {
        type: 'EmptyImage', displayName: 'Empty Image', category: 'visual', source: 'visual', isOutputNode: false,
        body: [
          ...['width', 'height', 'batch_size', 'color'].map((id) => ({
            kind: 'input' as const, id, type: { kind: 'concrete' as const, name: 'INT' }, optional: false,
            widget: { widgetType: 'INT', options: {} },
          })),
          { kind: 'output', id: 'image', type: { kind: 'concrete', name: 'IMAGE' } },
        ],
      },
      {
        type: 'PreviewImage', displayName: 'Preview Image', category: 'visual', source: 'visual', isOutputNode: true,
        body: [{ kind: 'input', id: 'images', type: { kind: 'concrete', name: 'IMAGE' }, optional: false }],
      },
    ])
    const diagnostics = (await bridge.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'badge-background', root: 'root',
      graphs: { root: { id: 'root', name: 'Badge background', nodes: {
        source: { id: 'source', type: 'EmptyImage', values: { width: 64, height: 64, batch_size: 1, color: 0 } },
        preview: { id: 'preview', type: 'PreviewImage', values: {} },
      }, links: { image: { id: 'image', from: { node: 'source', port: 'image' }, to: { node: 'preview', port: 'images' } } }, nets: {}, reroutes: {}, nextOrdinal: 3 } },
      view: { graphs: { root: { nodes: {
        source: { position: { x: 80, y: 120 } }, preview: { position: { x: 300, y: 120 } },
      } } } },
    }, 'Badge background'))
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
    bridge.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(2)
  for (const [name, badge, text] of [
    ['error', 'core.error', 'No error details recorded.'],
    ['info', 'core.log.info', 'No log records for this run.'],
    ['warning', 'core.log.warning', 'No log records for this run.'],
    ['problem', 'core.problem.error', 'No problem details recorded.'],
    ['subgraph', 'core.subgraph', 'Definition missing.'],
    ['replacement', 'core.deprecated', 'Node missing.'],
  ] as const) {
    await page.evaluate(async (badge) => {
      const target = window as unknown as { disposeBadgeVisual?: () => void }
      target.disposeBadgeVisual?.()
      const componentPath = '/src/BadgePopover.tsx'
      const rendererPath = '/node_modules/.vite/deps/solid-js_web.js'
      const { BadgePopover } = await import(componentPath)
      const { render } = await import(rendererPath)
      const host = document.createElement('div')
      document.querySelector('.canvas-pane')!.append(host)
      const dispose = render(() => BadgePopover({
        anchor: { x: 32, y: 96, nodeId: 'source', badge: { id: badge, glyph: '!', color: '#f00' } },
        errors: () => [], nodeLogs: () => [], problems: () => [],
        subgraphInfo: () => undefined, deprecationInfo: () => undefined,
        onOpenSubgraph: () => {}, onClose: () => {},
        onDismissError: () => { host.dataset['action'] = 'dismiss' },
        onOpenExecutionLog: () => { host.dataset['action'] = 'log' },
      }), host)
      target.disposeBadgeVisual = () => { dispose(); host.remove() }
    }, badge)
    const popover = page.getByTestId('badge-popover')
    await expect(popover).toBeFocused()
    await expect(popover.getByText(text, { exact: true })).toBeVisible()
    for (const [width, height] of [[1440, 900], [900, 700]] as const) {
      await page.setViewportSize({ width, height })
      await page.mouse.move(0, 0)
      await screenshot(page, `badge-${name}-empty-${width}`)
    }
    if (badge === 'core.error') {
      await popover.getByRole('button', { name: 'Dismiss', exact: true }).click()
      await expect(popover.locator('..')).toHaveAttribute('data-action', 'dismiss')
    }
    if (badge === 'core.log.info' || badge === 'core.log.warning') {
      await popover.getByRole('button', { name: 'Open in Execution log', exact: true }).click()
      await expect(popover.locator('..')).toHaveAttribute('data-action', 'log')
    }
  }
  await page.evaluate(() => (window as unknown as { disposeBadgeVisual(): void }).disposeBadgeVisual())
})

test('Editor host and target fallbacks explain unavailable editors', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  for (const [kind, text] of [
    ['curve', 'No curve target is active.'],
    ['unregistered-editor', "No editor registered for kind 'unregistered-editor'"],
  ] as const) {
    await page.evaluate((kind) => {
      const app = window.__dinksterTest!.app
      const tab = app.activeTab() as unknown as { editorKind: string }
      tab.editorKind = kind
      const tabs = app.tabs as unknown as { set(tabs: readonly unknown[]): void }
      tabs.set([...app.tabs.get()])
    }, kind)
    await expect(page.getByText(text, { exact: true })).toBeVisible()
    for (const [width, height] of [[1440, 900], [900, 700]] as const) {
      await page.setViewportSize({ width, height })
      const card = page.locator('.canvas-stage .product-empty-state').filter({ hasText: text })
      await expect(card).toBeVisible()
      const bounds = await card.boundingBox()
      const toolbar = await page.locator('.canvas-stage-toolbar').boundingBox()
      expect(bounds!.y).toBeGreaterThan(toolbar!.y + toolbar!.height)
      await page.mouse.move(0, 0)
      await screenshot(page, `editor-missing-${kind}-${width}`)
    }
  }
})

test('Region iteration states keep unavailable, loading and retained refusal explanations', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  for (const [state, text] of [
    ['empty', 'No retained iteration activity is available for this region.'],
    ['no-outputs', 'This body node has no inspectable outputs.'],
    ['unavailable', 'The execution backend is unavailable.'],
    ['loading', 'Loading retained value...'],
    ['refused', 'This intermediate is no longer retained.'],
  ] as const) {
    await page.evaluate(async (state) => {
      const target = window as unknown as { disposeRegionVisual?: () => void }
      target.disposeRegionVisual?.()
      const componentPath = '/src/RegionIterationInspector.tsx'
      const rendererPath = '/node_modules/.vite/deps/solid-js_web.js'
      const { RegionIterationInspector } = await import(componentPath)
      const { render } = await import(rendererPath)
      const host = document.createElement('div')
      host.style.cssText = 'position:absolute;top:48px;right:16px;width:300px;z-index:20'
      document.querySelector('.canvas-pane')!.append(host)
      const documentFixture = {
        root: 'root', graphs: {
          root: { nodes: { outer: { id: 'outer', type: '#body', values: {} } } },
          body: { nodes: { source: { id: 'source', type: 'Source', title: 'Retained result', values: {} } } },
        },
      }
      const execution = {
        ref: { connection: 'backend', prompt: 'region-visual' },
        artifact: {
          prompt: { 'outer.source': { outputIds: state === 'no-outputs' ? [] : ['value'] } },
          provenance: { fromSource: { outer: ['outer'] }, toSource: { 'outer.source': 'outer.source' } },
        },
        nodes: state === 'empty' ? {} : { 'outer[0]/source': { state: 'done' } },
        regions: { outer: { kind: 'map', binding: 'zip', iterations: 1, finishedIterations: 1 } },
      }
      const dispose = render(() => RegionIterationInspector({
        execution, document: documentFixture,
        regionOccurrence: { instancePath: [], node: 'outer' }, resolveSchema: () => undefined,
        values: state === 'unavailable' ? undefined : {
          peek: () => state === 'loading' ? new Promise(() => {}) : Promise.resolve({
            available: false, reason: 'not-retained', status: 410,
            error: 'This intermediate is no longer retained.',
          }),
        },
      }), host)
      target.disposeRegionVisual = () => { dispose(); host.remove() }
    }, state)
    const inspector = page.getByTestId('region-iteration-inspector')
    await expect(inspector.getByText(text, { exact: true })).toBeVisible()
    if (state === 'loading' || state === 'refused')
      await expect(inspector.getByRole('status')).toContainText(text)
    for (const [width, height] of [[1440, 900], [900, 700]] as const) {
      await page.setViewportSize({ width, height })
      await page.mouse.move(0, 0)
      await screenshot(page, `region-${state}-${width}`)
    }
  }
  await page.evaluate(() => (window as unknown as { disposeRegionVisual(): void }).disposeRegionVisual())
})

test('Workflow queue empty popover preserves disclosure and Escape focus', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.evaluate(async () => {
    const componentPath = '/src/WorkflowQueueControl.tsx'
    const rendererPath = '/node_modules/.vite/deps/solid-js_web.js'
    const { WorkflowQueueControl } = await import(componentPath)
    const { render } = await import(rendererPath)
    const host = document.createElement('div')
    host.style.cssText = 'position:absolute;top:128px;right:16px;width:440px;z-index:20'
    document.querySelector('.canvas-pane')!.append(host)
    const dispose = render(() => WorkflowQueueControl({
      owner: { id: 'queue-visual', title: 'Empty workflow', lineage: 'queue-visual' },
      executions: [], canQueue: true,
      onQueue: () => { host.dataset['queued'] = 'true' }, onOpenExecution: () => {},
    }), host)
    ;(window as unknown as { disposeQueueVisual: () => void }).disposeQueueVisual = () => { dispose(); host.remove() }
  })
  const control = page.locator('[data-testid="workflow-queue-control"][data-owner="queue-visual"]')
  const toggle = control.getByTestId('workflow-queue-toggle')
  await toggle.click()
  const popover = control.getByRole('region', { name: 'Queue for Empty workflow' })
  await expect(popover.getByText('No jobs for this workflow.', { exact: true })).toBeVisible()
  await toggle.evaluate((element) => element.blur())
  await page.mouse.move(0, 0)
  await expect(page.getByTestId('app-tooltip')).toBeHidden()
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await page.mouse.move(0, 0)
    await screenshot(page, `workflow-queue-empty-${width}`)
  }
  await toggle.press('Escape')
  await expect(popover).toBeHidden()
  await expect(toggle).toBeFocused()
  await control.getByTestId('queue-button').click()
  await expect(control.locator('..')).toHaveAttribute('data-queued', 'true')
  await page.evaluate(() => (window as unknown as { disposeQueueVisual(): void }).disposeQueueVisual())
})

test('Asset selection instructions stay readable for the rail and single or multiple picks', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  for (const mode of ['rail', 'single', 'multiple'] as const) {
    await page.evaluate(async (mode) => {
      const rendererPath = '/node_modules/.vite/deps/solid-js_web.js'
      const { render } = await import(rendererPath)
      const host = document.createElement('div')
      document.querySelector('.canvas-pane')!.append(host)
      host.dataset['closed'] = 'false'
      host.dataset['committed'] = 'false'
      host.dataset['assetVisual'] = mode
      let dispose: () => void
      if (mode === 'rail') {
        const componentPath = '/src/asset-browser/rail.tsx'
        const { AssetEntrySelection } = await import(componentPath)
        host.style.cssText = 'position:absolute;top:64px;left:32px;right:32px;z-index:20'
        dispose = render(() => AssetEntrySelection({ entry: undefined, adapters: [], backendId: 'asset-visual' }), host)
      } else {
        const componentPath = '/src/editors/AssetWidgetEditor.tsx'
        const { AssetWidgetEditor } = await import(componentPath)
        const singleType = { kind: 'concrete', name: 'ASSET' }
        const tab = { store: { doc: {}, revision: 0 } }
        const backend = { id: 'asset-visual', label: 'Visual fixture', baseUrl: '', protocol: 'dinkster', connection: {
          status: { subscribe: () => () => {} },
          listMounts: async () => [],
          listLocalAssets: async () => ({ assets: [] }),
          checkAssetAvailability: async () => [],
          onMountsChanged: () => () => {},
          fetchMountSettings: async () => ({ mounts: [], mountChangesAllowed: false }),
          fetchMountLocations: async () => ({ mounts: [], activeMounts: [] }),
        } }
        dispose = render(() => AssetWidgetEditor({
          app: {
            backendForTab: () => backend,
            registryForTab: () => undefined,
            tabs: { get: () => [tab] },
            dispatchTo: () => { host.dataset['committed'] = 'true' },
            widgetRegistry: { kind: () => undefined },
          },
          ed: {
            tab, graphId: 'g0', target: { kind: 'input', nodeId: 'asset', valueKey: 'file' },
            label: 'Reference file', spec: { widgetType: 'ASSET', options: { accept: ['application/octet-stream'] } },
            declaredType: mode === 'multiple' ? { kind: 'list', element: singleType } : singleType,
            multiline: false, rect: { x: 20, y: 20, width: 180, height: 24 }, initial: mode === 'multiple' ? [] : null,
          },
          viewport: () => ({ x: 0, y: 0, scale: 1 }),
          onClose: () => { host.dataset['closed'] = 'true' },
        }), host)
      }
      ;(window as unknown as { disposeAssetVisual: () => void }).disposeAssetVisual = () => { dispose(); host.remove() }
    }, mode)
    const selection = page.getByTestId('asset-selection-summary')
    await expect(selection).toContainText(mode === 'rail' ? 'Click an asset' : mode === 'single' ? 'Click an asset in the list' : 'No assets selected.')
    for (const [width, height] of [[1440, 900], [900, 700]] as const) {
      await page.setViewportSize({ width, height })
      await page.mouse.move(0, 0)
      await screenshot(page, `asset-selection-${mode}-${width}`)
    }
    if (mode !== 'rail') {
      await page.getByTestId('asset-editor').getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(page.locator(`[data-asset-visual="${mode}"]`)).toHaveAttribute('data-closed', 'true')
      await expect(page.locator(`[data-asset-visual="${mode}"]`)).toHaveAttribute('data-committed', 'false')
    }
    await page.evaluate(() => (window as unknown as { disposeAssetVisual(): void }).disposeAssetVisual())
  }
})

test('Saved connection rows retain actions, credential editing and connection failure', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.evaluate(async () => {
    const componentPath = '/src/BackendsPanel.tsx'
    const statePath = '/src/app-state.ts'
    const profilesPath = '/src/connection-profiles.ts'
    const rendererPath = '/node_modules/.vite/deps/solid-js_web.js'
    const { BackendsPanel } = await import(componentPath)
    const { AppState } = await import(statePath)
    const { createConnectionProfile } = await import(profilesPath)
    const { render } = await import(rendererPath)
    const profile = createConnectionProfile('Studio render server with a long descriptive name', 'https://render-studio.example.test:8443/team/production')!
    const desktopWindow = window as unknown as { dinksterDesktop: unknown }
    const previousBridge = desktopWindow.dinksterDesktop
    const host = document.createElement('section')
    host.style.cssText = 'position:absolute;top:64px;left:84px;right:24px;bottom:32px;max-width:720px;overflow:auto;z-index:20;background:var(--dinkster-surface-panel)'
    host.setAttribute('aria-label', 'Saved connections fixture')
    document.querySelector('.canvas-pane')!.append(host)
    desktopWindow.dinksterDesktop = {
      locale: async () => 'en',
      status: async () => ({ phase: 'running', detail: 'Ready' }),
      connectionCredentials: async () => ({ custody: true, profiles: [profile.id] }),
      setConnectionCredential: async () => { host.dataset['savedToken'] = 'true' },
    }
    let finishConnect: (() => void) | undefined
    const app = new AppState()
    app.addBackendByUrl = (url: string, options?: { label?: string }) => url === 'https://recovered.example.test'
      ? Promise.resolve(app.addBackend(url, options?.label, false, 'dinkster'))
      : new Promise<undefined>((resolve) => { finishConnect = () => resolve(undefined) })
    const dispose = render(() => BackendsPanel({ app }), host)
    ;(window as unknown as { connectionVisual: { fail(): void; dispose(): void } }).connectionVisual = {
      fail: () => finishConnect!(),
      dispose: () => { dispose(); app.dispose(); host.remove(); desktopWindow.dinksterDesktop = previousBridge },
    }
  })
  const fixture = page.getByRole('region', { name: 'Saved connections fixture' })
  const row = fixture.getByTestId('backend-row').filter({ hasText: 'Studio render server' })
  await row.locator('summary').click()
  await expect(row.getByTestId('profile-credential-badge')).toBeVisible()
  const capture = async (state: string): Promise<void> => {
    for (const [width, height] of [[1440, 900], [900, 700]] as const) {
      await page.setViewportSize({ width, height })
      const lastAction = state === 'token-editor' ? row.getByTestId('profile-token-save') : row.getByRole('button', { name: 'Actions for Studio render server', exact: false })
      await lastAction.scrollIntoViewIfNeeded()
      await expect(lastAction).toBeInViewport()
      const identity = await row.locator('summary').boundingBox()
      expect(identity!.width).toBeGreaterThan(200)
      const area = await fixture.boundingBox()
      for (const action of await row.getByRole('button').all()) {
        const bounds = await action.boundingBox()
        expect(bounds!.x).toBeGreaterThanOrEqual(area!.x)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(area!.x + area!.width)
      }
      await page.mouse.move(0, 0)
      await screenshot(page, `connection-profile-${state}-${width}`)
    }
  }
  await capture('ready')
  await row.getByTestId('profile-token-edit').click()
  await expect(row.getByTestId('profile-token-editor-input')).toHaveAttribute('type', 'password')
  await expect(row.getByTestId('profile-token-save')).toBeDisabled()
  await capture('token-editor')
  await row.getByTestId('profile-token-editor-input').fill('fixture-token')
  await row.getByTestId('profile-token-save').click()
  await expect(fixture).toHaveAttribute('data-saved-token', 'true')
  await expect(row.getByTestId('profile-token-editor-input')).toBeHidden()
  await row.getByTestId('profile-connect').click()
  await expect(row.getByTestId('profile-connect')).toBeDisabled()
  await expect(row.getByTestId('profile-connect')).toHaveText('Connecting...')
  await capture('connecting')
  await page.evaluate(() => (window as unknown as { connectionVisual: { fail(): void } }).connectionVisual.fail())
  await expect(fixture.getByRole('alert')).toContainText('Studio render server')
  await expect(row.getByTestId('profile-connect')).toBeEnabled()
  await capture('failed')
  await fixture.getByRole('button', { name: 'Add backend', exact: true }).click()
  await fixture.getByTestId('backend-url-input').fill('file:///invalid-server')
  await fixture.getByTestId('backend-add').click()
  await expect(fixture.locator('#backend-add-error')).toHaveText('A profile needs an absolute http(s) address without embedded credentials.')
  await expect(fixture.getByTestId('backend-row')).toHaveCount(2)
  await expect(fixture.getByTestId('backend-url-input')).toHaveValue('file:///invalid-server')
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await fixture.locator('#backend-add-error').scrollIntoViewIfNeeded()
    await page.mouse.move(0, 0)
    await screenshot(page, `connection-profile-invalid-address-${width}`)
  }
  await fixture.getByTestId('profile-name-input').fill('Recovered source')
  await fixture.getByTestId('backend-url-input').fill('https://recovered.example.test')
  await fixture.getByTestId('backend-add').click()
  await expect(fixture.locator('#backend-add-error')).toHaveCount(0)
  await expect(fixture.getByTestId('backend-row')).toHaveCount(3)
  await expect(fixture.getByTestId('backend-row').filter({ hasText: 'Recovered source' })).toContainText('https://recovered.example.test')
  await page.evaluate(() => (window as unknown as { connectionVisual: { dispose(): void } }).connectionVisual.dispose())
})

test('Project rows preserve names, rename drafts and host actions', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.evaluate(async () => {
    const componentPath = '/src/ProjectsDialog.tsx'
    const rendererPath = '/node_modules/.vite/deps/solid-js_web.js'
    const { ProjectsDialog } = await import(componentPath)
    const { render } = await import(rendererPath)
    const records = new Map([
      ['default', { id: 'default', name: 'Default', revision: 1 }],
      ['p-studio', { id: 'p-studio', name: 'Studio production with a long descriptive project name', revision: 1 }],
      ['p-audio', { id: 'p-audio', name: 'Audio experiments', revision: 1 }],
    ])
    const connection = {
      listProjects: async () => ({ items: [...records.values()], cursor: null }),
      registerProject: async (id: string, name: string) => {
        const project = records.get(id) ?? { id, name, revision: 1 }
        records.set(id, project)
        return project
      },
      renameProject: async (id: string, name: string, revision: number) => {
        const project = { id, name, revision: revision + 1 }
        records.set(id, project)
        return project
      },
    }
    const host = document.createElement('section')
    host.style.cssText = 'position:absolute;top:64px;left:84px;right:24px;bottom:32px;max-width:720px;overflow:auto;z-index:20;background:var(--dinkster-surface-panel)'
    host.setAttribute('aria-label', 'Projects fixture')
    document.querySelector('.canvas-pane')!.append(host)
    const dispose = render(() => ProjectsDialog({
      connection,
      onSwitch: (id: string) => { host.dataset['switched'] = id },
      onOpenWindow: (id: string) => { host.dataset['opened'] = id },
    }), host)
    ;(window as unknown as { disposeProjectsVisual(): void }).disposeProjectsVisual = () => { dispose(); host.remove() }
  })
  const fixture = page.getByRole('region', { name: 'Projects fixture' })
  const current = fixture.locator('li[data-project-id="default"]')
  await expect(current).toContainText('Current')
  await expect(current.getByRole('button', { name: 'Switch', exact: true })).toBeDisabled()
  const row = fixture.locator('li[data-project-id]').filter({ hasText: 'Studio production with a long descriptive project name' })
  const id = await row.getAttribute('data-project-id')
  const capture = async (state: string): Promise<void> => {
    for (const [width, height] of [[1440, 900], [900, 700]] as const) {
      await page.setViewportSize({ width, height })
      const bounds = await fixture.boundingBox()
      for (const control of await fixture.locator('button, input').all()) {
        const box = await control.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(bounds!.x)
        expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width)
      }
      await page.mouse.move(0, 0)
      await screenshot(page, `projects-${state}-${width}`)
    }
  }
  await capture('ready')
  await row.getByRole('button', { name: 'Rename', exact: true }).click()
  const rename = fixture.getByRole('textbox', { name: 'Rename Studio production with a long descriptive project name', exact: true })
  await expect(rename).toBeFocused()
  await rename.fill('Studio renamed with a long descriptive project name')
  await capture('renaming')
  await rename.press('Enter')
  const renamed = fixture.locator(`li[data-project-id="${id}"]`)
  await expect(renamed).toContainText('Studio renamed with a long descriptive project name')
  await renamed.getByRole('button', { name: 'New window', exact: true }).click()
  await expect(fixture).toHaveAttribute('data-opened', id!)
  await renamed.getByRole('button', { name: 'Switch', exact: true }).click()
  await expect(fixture).toHaveAttribute('data-switched', id!)
  await expect(fixture.getByTestId('projects-create')).toBeDisabled()
  await fixture.getByRole('textbox', { name: 'New project name', exact: true }).fill('Compositing work')
  await fixture.getByRole('textbox', { name: 'New project name', exact: true }).press('Enter')
  await expect(fixture.locator('li[data-project-id]')).toHaveCount(4)
  await expect(fixture.getByRole('textbox', { name: 'New project name', exact: true })).toBeEmpty()
  await page.evaluate(() => (window as unknown as { disposeProjectsVisual(): void }).disposeProjectsVisual())
})

test('GLSL editor missing-data and refused-preview states preserve editing and diagnostics', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'GlslEmptyVisual', displayName: 'GLSL Shader', category: 'test', source: 'v3', isOutputNode: true, editorRole: 'glsl',
      body: [{ kind: 'input', id: 'fragment_shader', optional: true, type: { kind: 'concrete', name: 'core.string' },
        widget: { widgetType: 'STRING', options: { multiline: true }, default: '#version 300 es\ninvalid shader' } }],
    }])
    const diagnostics = (await app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'glsl-empty-visual', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'GLSL', nodes: { shader: { id: 'shader', type: 'GlslEmptyVisual', values: { fragment_shader: '#version 300 es\ninvalid shader' } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: { g0: { nodes: { shader: { position: { x: 120, y: 100 } } } } } },
    }, 'GLSL'))
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
    const editorApp = app as unknown as {
      glslTargetForInput(tab: unknown, graph: string, node: string, input: string): unknown
      openGlslEditor(target: unknown): boolean
    }
    if (!editorApp.openGlslEditor(editorApp.glslTargetForInput(app.activeTab()!, 'g0', 'shader', 'fragment_shader')))
      throw new Error('GLSL fixture did not open')
  })
  const editor = page.getByTestId('glsl-editor')
  await expect(editor.getByText('Run the node to load authoritative input previews.', { exact: true })).toBeVisible()
  await expect(editor.getByText('No runtime state.', { exact: true })).toBeVisible()
  await expect(editor.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled()
  const capture = async (state: string): Promise<void> => {
    for (const [width, height] of [[1440, 900], [900, 700]] as const) {
      await page.setViewportSize({ width, height })
      await page.mouse.move(0, 0)
      await screenshot(page, `glsl-${state}-${width}`)
    }
  }
  await capture('no-runtime')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = { connection: compiled.artifact.connection, prompt: 'glsl-empty-run' }
    ;(app as unknown as { registerRun(tab: unknown, ref: unknown, artifact: unknown, now: number): void }).registerRun(tab, ref, compiled.artifact, 0)
    const runtimeNodeId = 'shader'
    app.store.apply({ kind: 'preview', execution: ref, timestamp: 1, runtimeNodeId,
      channel: 'application/vnd.dinkster.glsl-state+json', stream: 'glsl-state',
      payload: { width: 8, height: 4, inputs: [{ name: 'u_image0', stream: 'glsl-input-u_image0' }], floats: { u_float0: 0.25 }, ints: {}, bools: {}, curves: {} },
    } as never)
  })
  await expect(editor.getByText('Browser preview unavailable.', { exact: true })).toBeVisible()
  await expect(editor.getByRole('alert')).toContainText('Preview image u_image0 is unavailable')
  await expect(editor.getByText('u_float0', { exact: true })).toBeVisible()
  await capture('preview-unavailable')
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(editor).toBeHidden()
  await page.evaluate(async () => {
    const componentPath = '/src/GlslEditor.tsx'
    const rendererPath = '/node_modules/.vite/deps/solid-js_web.js'
    const { GlslEditor } = await import(componentPath)
    const { render } = await import(rendererPath)
    const host = document.createElement('div')
    host.style.cssText = 'position:absolute;inset:48px 0 0;z-index:20'
    document.querySelector('.canvas-pane')!.append(host)
    const dispose = render(() => GlslEditor({ app: window.__dinksterTest!.app }), host)
    ;(window as unknown as { disposeGlslVisual: () => void }).disposeGlslVisual = () => { dispose(); host.remove() }
  })
  await expect(page.getByText('No GLSL Shader target is active.', { exact: true })).toBeVisible()
  await capture('no-target')
  await page.evaluate(() => (window as unknown as { disposeGlslVisual(): void }).disposeGlslVisual())
})

test('Import resolution keeps the no-candidate explanation and unresolved decision', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  const openResolution = async (): Promise<void> => {
    await page.evaluate(() => {
      const app = window.__dinksterTest!.app as unknown as {
        importAssetResolution: { set(value: unknown): void }
      }
      app.importAssetResolution.set({
        matches: [{ query: 'models/checkpoints/missing-model.safetensors', candidates: [] }],
        reasons: { 'models/checkpoints/missing-model.safetensors': 'no-match' },
        accept: (selected: ReadonlyMap<string, unknown>) => {
          if (selected.size !== 0) throw new Error('No candidate can be selected')
          app.importAssetResolution.set(undefined)
        },
        cancel: () => app.importAssetResolution.set(undefined),
      })
    })
  }
  await openResolution()
  const dialog = page.getByTestId('import-asset-resolution-dialog')
  await expect(dialog.getByTestId('import-asset-empty')).toBeVisible()
  await expect(dialog.getByRole('radio')).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByTestId('import-assets-selection-status')).toContainText('1 name remains unresolved')
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 })
    await expect(dialog.getByTestId('import-assets-cancel')).toBeVisible()
    await expect(dialog.getByTestId('import-assets-accept')).toBeVisible()
    await screenshot(page, `import-resolution-no-candidates-${width}`)
  }
  await dialog.getByTestId('import-assets-cancel').click()
  await expect(dialog).toBeHidden()
  await openResolution()
  await dialog.getByTestId('import-assets-accept').click()
  await expect(dialog).toBeHidden()
})
