import { expect, nativeAppViewTest as test, type Page } from './fixtures.js'
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
  await page.waitForFunction(() => window.__dinksterTest?.app !== undefined)
  await expect(page.getByTestId('status-bar')).toHaveText(/^connected\s*\d+ node schemas/)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.problems.get()
    .some((problem) => problem.code === 'workflow.startup.ownershipUnconfirmed'))).toBe(false)
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
    let releaseWordmark!: () => void
    const wordmarkReady = new Promise<void>((resolve) => { releaseWordmark = resolve })
    await page.route('**/branding/svg/dinkster-wordmark-color-*.svg', async (route) => {
      await wordmarkReady
      await route.continue()
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__dinksterTest?.app !== undefined)
    const headerBefore = await page.locator('.topbar').boundingBox()
    releaseWordmark()
    await expect.poll(() => page.getByTestId('dinkster-menu-button').locator('img:visible')
      .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
    expect(await page.locator('.topbar').boundingBox()).toEqual(headerBefore)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(page.getByTestId('dinkster-menu-button').getByRole('img', { name: 'Dinkster' })).toBeVisible()
    const expectedCanvas = theme === 'dark' ? 'rgb(17, 19, 22)' : 'rgb(247, 248, 250)'
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
    await page.evaluate(() => Object.assign(window, { dinksterDesktop: {
      locale: async () => 'en',
      status: async () => ({ phase: 'running', detail: 'Ready' }),
      info: async () => ({ appVersion: '0.2.0', engineCommit: 'brand-visual', variant: 'cuda', storageBytes: 0, releases: [], update: { state: 'current', detail: 'Current' } }),
      onInfo: () => () => undefined,
      systemCheck: async () => ({ platform: 'linux', architecture: 'x64', freeBytes: 1, totalBytes: 2, engineReady: true, engineDetail: 'Ready', gpu: { available: false } }),
      remoteWorkers: async () => [],
    } }))
    await openModal(page, 'desktop-management')
    await expect(page.locator('.desktop-management')).toContainText('0.2.0')
    await screenshot(page, `brand-version-${theme}`)
    await page.evaluate(() => (window.__dinksterTest!.app as unknown as {
      readonly modalPanel: { set(value: string): void }
    }).modalPanel.set(''))
    await page.evaluate((selected) => {
      window.__dinksterTest!.app.settings.set('dinkster.theme', selected === 'dark' ? 'light' : 'dark')
    }, theme)
    await expect(page.locator('body')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(247, 248, 250)' : 'rgb(17, 19, 22)')
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
      dinkster: { version: 'visual-fixture', schemaWire: 1 },
      nodes: {},
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
  } else if (path.endsWith('/api/workflows/plan')) {
    await route.fulfill({ json: { packs: [], assets: [], errors: [] } })
  } else if (path.includes('/api/library/retentions/document/') || path.includes('/api/library/retentions/preview/')) {
    await route.fallback()
  } else {
    await route.fulfill({ status: 502, body: 'visual fixture unavailable' })
  }
}

test('populated image workspace at desktop and compact widths', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.getByTestId('image-documents-button').click()
  const workspace = page.getByTestId('image-document-workspace')
  await page.route('/api/assets/media?*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const digest = await request.headerValue('x-dinkster-digest')
    const body = request.postDataBuffer()!
    expect(request.method()).toBe('POST')
    expect(url.searchParams.get('scope')).toBe('local')
    expect(url.searchParams.get('kind')).toBe('media/image')
    expect(digest).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(body.length).toBeGreaterThan(0)
    await route.fulfill({ status: 201, json: {
      kind: 'media/image', asset: { digest, name: url.searchParams.get('name'),
        size: body.length, mediaType: 'image/png', virtualPath: '' },
    } })
  })
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 400
    const context = canvas.getContext('2d')!
    const gradient = context.createLinearGradient(0, 0, 640, 400)
    gradient.addColorStop(0, '#173f6c')
    gradient.addColorStop(1, '#d7a86e')
    context.fillStyle = gradient
    context.fillRect(0, 0, 640, 400)
    return [...new Uint8Array(await (await fetch(canvas.toDataURL('image/png'))).arrayBuffer())]
  })
  await workspace.locator('.image-document-tabs input[type=file]').setInputFiles({
    name: 'Coastline.png', mimeType: 'image/png', buffer: Buffer.from(bytes),
  })
  await expect(page.getByTestId('image-document-editor')).toBeVisible()
  await expect(workspace.locator('.image-document-layer-row')).toHaveCount(1)
  await expect(workspace.locator('.image-document-preview canvas')).toHaveAttribute('width', '640')
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 })
    await screenshot(page, `image-workspace-${width}`)
  }
})

test('App view validation and remote failures keep editable controls', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.route('**/api/choices/panel-state-visual*', (route) => route.fulfill({ status: 503, body: 'visual source unavailable' }))
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'AppNoticeVisual', displayName: 'App feedback', category: 'test', source: 'visual', isOutputNode: true,
      items: [
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

test('Memory lease rows retain device identity, bytes and expiry', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.evaluate(async () => {
    const componentPath = '/src/MemoryPanel.tsx'
    const rendererPath = '/node_modules/.vite/deps/solid-js_web.js'
    const { MemoryPanel } = await import(componentPath)
    const { render } = await import(rendererPath)
    const host = document.createElement('section')
    host.style.cssText = 'position:absolute;top:64px;left:84px;right:24px;bottom:32px;max-width:720px;overflow:auto;z-index:20;background:var(--dinkster-surface-panel)'
    document.querySelector('.canvas-pane')!.append(host)
    const dispose = render(() => MemoryPanel({ label: 'Lease visual', now: () => 0, connection: {
      status: { get: () => 'connected', subscribe: () => () => {} },
      onMemoryStatus: () => () => {},
      fetchMemoryStatus: async () => ({
        devices: {}, memoryGovernor: {}, consumerDetails: {},
        queue: { queued: 3, running: [], maxRunningJobs: 2, paused: false },
        leases: [
          { reservationId: 'reservation-primary-long-identity', device: 'cuda:0', bytes: 1073741824, expiresInSeconds: 12 },
          { reservationId: 'reservation-secondary', device: 'cpu', bytes: 1536, expiresInSeconds: 2 },
        ],
      }),
      fetchRuntimeSettings: async () => ({ categories: { available: [], granted: [] }, settings: {} }),
      updateRuntimeSetting: async () => { throw new Error('Read-only visual fixture') },
    } }), host)
    ;(window as unknown as { disposeLeaseVisual(): void }).disposeLeaseVisual = () => { dispose(); host.remove() }
  })
  const leases = page.getByRole('region', { name: 'Active memory leases' })
  await expect(leases).toContainText('2 active')
  await expect(leases).toContainText('1.0 GiB')
  await expect(leases).toContainText('1.5 KiB')
  await expect(leases).toContainText('12s remaining')
  await expect(leases).toContainText('2s remaining')
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await leases.scrollIntoViewIfNeeded()
    await page.mouse.move(0, 0)
    await screenshot(page, `memory-lease-rows-${width}`)
  }
  await page.evaluate(() => (window as unknown as { disposeLeaseVisual(): void }).disposeLeaseVisual())
})

test('Output descriptor invalid documents keep repair and probe feedback', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  for (const profile of [false, true]) {
    await page.evaluate(async (profile) => {
      const componentPath = '/src/OutputDescriptorEditor.tsx'
      const rendererPath = '/node_modules/.vite/deps/solid-js_web.js'
      const { OutputDescriptorEditor } = await import(componentPath)
      const { render } = await import(rendererPath)
      const host = document.createElement('section')
      host.style.cssText = 'position:absolute;top:64px;left:84px;right:24px;bottom:32px;max-width:520px;overflow:auto;z-index:20;background:var(--dinkster-surface-panel)'
      document.querySelector('.canvas-pane')!.append(host)
      const app = window.__dinksterTest!.app
      const dispose = render(() => OutputDescriptorEditor({
        spec: { input: 'entries', choices: [{ id: 'float', type: { kind: 'concrete', name: 'core.float' } }], minEntries: 0, maxEntries: 3, fixedIds: false,
          ...(profile ? { probe: { input: 'asset', kind: 'model', revision: '1' } } : {}) },
        initial: '{', asset: undefined, staleLinks: [], app, tab: app.activeTab()!, isCurrent: () => true,
        onDisconnect: () => {}, onCommit: () => { host.dataset['committed'] = 'true' }, onClose: () => { host.dataset['closed'] = 'true' },
      }), host)
      ;(window as unknown as { disposeDescriptorVisual(): void }).disposeDescriptorVisual = () => { dispose(); host.remove() }
    }, profile)
    const editor = page.getByTestId('output-descriptor-editor')
    await expect(editor.getByRole('status').first()).toBeVisible()
    await expect(editor.getByTestId('output-descriptors-apply')).toBeDisabled()
    await expect(editor.getByText(profile ? 'Probe the current asset to generate valid outputs.' : 'Use Stored JSON to repair invalid descriptors.', { exact: true })).toBeVisible()
    if (profile) {
      await editor.getByTestId('output-profile-probe').click()
      await expect(editor.getByRole('alert')).toHaveText('Choose an asset before probing.')
    }
    for (const [width, height] of [[1440, 900], [900, 700]] as const) {
      await page.setViewportSize({ width, height })
      await editor.getByTestId('output-descriptors-apply').scrollIntoViewIfNeeded()
      await page.mouse.move(0, 0)
      await screenshot(page, `descriptor-invalid-${profile ? 'profile' : 'editable'}-${width}`)
    }
    if (!profile) {
      await editor.getByRole('button', { name: 'Stored JSON', exact: true }).click()
      await editor.getByRole('textbox', { name: 'Descriptor document', exact: true }).fill('{"entries":[]}')
      await expect(editor.getByRole('status')).toHaveCount(0)
      await expect(editor.getByTestId('output-descriptors-apply')).toBeEnabled()
      await editor.getByTestId('output-descriptors-apply').click()
      await expect(editor.locator('..')).toHaveAttribute('data-committed', 'true')
    } else {
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(editor.locator('..')).toHaveAttribute('data-closed', 'true')
    }
    await page.evaluate(() => (window as unknown as { disposeDescriptorVisual(): void }).disposeDescriptorVisual())
  }
})

test('runtime panel headers and backend add error at desktop and compact widths', async ({ page }) => {
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
    await backends.getByTestId('backend-url-input').fill('http://127.0.0.1:1')
    await backends.getByTestId('backend-add').click()
    await expect(backends.getByRole('alert').filter({ hasText: /could not|failed|unreachable/i }).first()).toBeVisible()
    const header = backends.locator('.product-panel-header').first()
    const headerStyles = await header.evaluate((element) => {
      const style = getComputedStyle(element)
      const title = getComputedStyle(element.querySelector('h2')!)
      return { padding: style.padding, divider: style.borderBottom, font: title.font }
    })
    const fonts = await backends.locator('input, button, select, textarea').evaluateAll((controls) =>
      controls.map((control) => getComputedStyle(control).fontFamily),
    )
    expect(fonts.every((font) => !font.includes('Arial'))).toBe(true)
    await expect(backends.getByTestId('backend-add')).toHaveAttribute('data-variant', 'primary')
    await screenshot(page, `runtime-panel-backends-error-${width}`)
    await openDock(page, 'memory-sidebar-toggle')
    const memory = page.getByTestId('memory-panel').first()
    await expect(memory).toBeVisible()
    expect(await memory.locator('.product-panel-header').evaluate((element) => {
      const style = getComputedStyle(element)
      const title = getComputedStyle(element.querySelector('h2')!)
      return { padding: style.padding, divider: style.borderBottom, font: title.font }
    })).toEqual(headerStyles)
    await screenshot(page, `runtime-panel-memory-${width}`)
  }
})

test('Boundary prompt and definition empty states at desktop and compact widths', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await openRail(page, 'Boundary')
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await page.evaluate(() => (window.__dinksterTest!.app as unknown as {
      createWorkflow(): void
    }).createWorkflow())
    await expect(page.getByTestId('boundary-prompt')).toContainText('Open a subgraph definition')
    await expect(page.getByTestId('boundary-prompt').getByRole('button')).toHaveCount(0)
    await screenshot(page, `boundary-prompt-${width}`)
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
          boundary: { inputs: [], outputs: [] }, nextOrdinal: 1,
        },
      },
      view: { graphs: {
        root: { nodes: { occurrence: { position: { x: 200, y: 100 } } } },
        sub: { nodes: {} },
      } },
      }, 'Boundary visual')
    })).toEqual([])
    const open = page.getByTestId('boundary-prompt').getByRole('button', { name: 'Open Nested workflow', exact: true })
    await expect(open).toBeEnabled()
    await screenshot(page, `boundary-open-definition-${width}`)
    await open.click()
    await expect(page.getByTestId('boundary-prompt')).toHaveCount(0)
    await expect(page.getByTestId('boundary-empty')).toHaveCount(2)
    await expect(page.getByTestId('boundary-empty').first()).toContainText('No workflow inputs are exposed.')
    await expect(page.getByTestId('boundary-empty').last()).toContainText('No workflow outputs are exposed.')
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
  await expect(page.getByTestId('status-bar')).toContainText('disconnected')
  await expect(page.getByTestId('status-bar')).not.toContainText('loading schemas...')
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
    await expect(card.getByTestId('backend-schema-retry')).toBeEnabled()
    await expect(card.getByTestId('output-mount-settings').getByRole('alert')).toContainText('GET /api/mounts failed: 503')
    await expect(card.getByTestId('output-mount-retry')).toBeEnabled()
    await card.getByTestId('output-mount-retry').scrollIntoViewIfNeeded()
    await page.mouse.move(width / 2, height / 2)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('app-tooltip')).toBeHidden()
    await screenshot(page, `metadata-error-backends-${width}`)
    await openRail(page, 'Outputs')
    const outputs = page.getByTestId('outputs-panel')
    await expect(outputs.getByRole('alert')).toContainText('GET /api/nodes failed: 503')
    await expect(outputs.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled()
    await screenshot(page, `metadata-error-outputs-${width}`)
  }
  recover = true
  await page.getByTestId('outputs-panel').getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByTestId('outputs-panel').getByRole('alert')).toHaveCount(0)
  await expect(page.getByTestId('status-bar')).not.toContainText('disconnected')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/)
})

test('Library Assets and Outputs use shared empty and loading states', async ({ page }) => {
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
    await page.getByRole('option', { name: 'History', exact: true }).click()
    mode = state
    await library.getByTestId('library-source-select').click()
    await page.getByRole('option', { name: 'Workflows', exact: true }).click()
    const presentation = library.locator('[data-collection-state]')
    await expect(presentation).toHaveAttribute('data-collection-state', state)
    if (state === 'loading') await expect(presentation.getByRole('status')).toContainText('Loading workflows')
    if (state === 'error') await expect(presentation.getByRole('alert')).toContainText('GET /api/library failed: 503')
    if (state === 'empty') await expect(presentation).toContainText('No saved workflows')
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
  await openRail(page, 'Outputs')
  await expect(page.getByTestId('outputs-panel')).toContainText('No execution selected')
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
  await page.getByRole('button', { name: 'Storage', exact: true }).click()
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

test('Focused panel explains an empty context and absent document', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.evaluate(async () => {
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'focused-empty', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: {} },
    }, 'Empty workflow')
  })
  await openRail(page, 'Focused')
  const panel = page.getByTestId('context-panel')
  await expect(panel.getByTestId('context-no-problems')).toHaveText('None in this context.')
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await screenshot(page, `focused-empty-${width}`)
  }
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { tabs: { set(value: readonly unknown[]): void } }
    app.tabs.set([])
  })
  await expect(panel.getByText('No document is open.', { exact: true })).toBeVisible()
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await screenshot(page, `focused-no-document-${width}`)
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
        items: [
          ...['width', 'height', 'batch_size', 'color'].map((id) => ({
            kind: 'input' as const, id, type: { kind: 'concrete' as const, name: 'INT' }, optional: false,
            widget: { widgetType: 'INT', options: {} },
          })),
          { kind: 'output', id: 'image', type: { kind: 'concrete', name: 'IMAGE' } },
        ],
      },
      {
        type: 'PreviewImage', displayName: 'Preview Image', category: 'visual', source: 'visual', isOutputNode: true,
        items: [{ kind: 'input', id: 'images', type: { kind: 'concrete', name: 'IMAGE' }, optional: false }],
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

test('Canvas badge popovers explain removed sources and selectors', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const diagnostics = (await app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'missing-badge-visual', root: 'root',
      graphs: { root: { id: 'root', name: 'Badge targets', nodes: {}, links: {}, nets: {}, reroutes: {},
        valueSources: { source: { id: 'source', value: 12, spec: { widgetType: 'INT', options: {} } } },
        selectors: { selector: { id: 'selector', title: 'Choice', candidates: [{ id: 'first' }, { id: 'second' }], policy: { kind: 'fixed', candidate: 'first' } } },
        nextOrdinal: 4 } },
      view: { graphs: { root: { nodes: {}, valueSources: { source: { position: { x: 48, y: 80 } } }, selectors: { selector: { position: { x: 48, y: 180 } } } } } },
    }, 'Badge targets'))
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  const clickBadge = async (kind: 'valueSources' | 'selectors'): Promise<void> => {
    await page.waitForFunction((kind) => window.__dinksterTest!.renderer!.getScene()[kind].length > 0, kind)
    const point = await page.evaluate((kind) => {
      const renderer = window.__dinksterTest!.renderer!
      const scene = renderer.getScene()
      const item = scene[kind][0]!
      const viewport = renderer.getViewport()
      const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      const height = kind === 'selectors' ? scene.selectors[0]!.headerHeight : item.height
      return { x: canvas.left + viewport.x + (item.x + item.width - 13) * viewport.scale,
        y: canvas.top + viewport.y + (item.y + height / 2) * viewport.scale }
    }, kind)
    await page.mouse.click(point.x, point.y)
  }
  await clickBadge('valueSources')
  const source = page.getByTestId('value-source-popover')
  await expect(source).toContainText('Value Source:')
  await expect(source).toBeFocused()
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.dispatch({
    command: 'graph.deleteItems', params: { graphId: 'root', valueSourceIds: ['source'] },
  }))
  await expect(source).toHaveText('Value source missing.')
  await expect(source).toBeFocused()
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await page.mouse.move(0, 0)
    await screenshot(page, `canvas-source-missing-${width}`)
  }
  await page.getByTestId('rail-toggle').focus()
  await expect(source).toBeHidden()
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): { id: string }
      tabs: { get(): { id: string }[]; set(tabs: unknown[]): void }
    }
    const id = app.activeTab().id
    app.tabs.set(app.tabs.get().map((tab) => tab.id === id ? { ...tab, execution: { connection: 'visual', prompt: 'visual' } } : tab))
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await clickBadge('selectors')
  const selector = page.getByTestId('selector-exec-popover')
  await expect(selector).toContainText('Selector: Choice')
  await expect(selector).toBeFocused()
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): { store: { dispatch(command: unknown): unknown } }
      tabs: { get(): object[]; set(tabs: unknown[]): void }
    }
    app.activeTab().store.dispatch({ command: 'graph.deleteItems', params: { graphId: 'root', selectorIds: ['selector'] } })
    app.tabs.set(app.tabs.get().map((tab) => ({ ...tab })))
  })
  await expect(selector).toHaveText('Selector missing.')
  await expect(selector).toBeFocused()
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await page.mouse.move(0, 0)
    await screenshot(page, `canvas-selector-missing-${width}`)
  }
  await page.getByTestId('rail-toggle').focus()
  await expect(selector).toBeHidden()
})

test('Editor host and target fallbacks explain unavailable editors', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  for (const [kind, text] of [
    ['curve', 'No curve target is active.'],
    ['image', 'No image target is active.'],
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
    ['unavailable', 'The execution owner is unavailable.'],
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
    host.style.cssText = 'position:absolute;top:64px;right:16px;width:440px;z-index:20'
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

test('Compositor missing runtime state keeps its explanation and Cancel action', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'CompositorEmptyVisual', displayName: 'Create Layered Image', category: 'test', source: 'v3', isOutputNode: true, editorRole: 'compositor',
      items: [{ kind: 'input', id: 'recipe', optional: true, type: { kind: 'concrete', name: 'dinkster.compositor' },
        widget: { widgetType: 'COMPOSITOR', options: {}, default: { version: 2, documentDigest: null, commands: [] } } }],
    }])
    const diagnostics = (await app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'compositor-empty-visual', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Compositor', nodes: { create: { id: 'create', type: 'CompositorEmptyVisual', values: { recipe: { version: 2, documentDigest: null, commands: [] } } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: { g0: { nodes: { create: { position: { x: 120, y: 100 } } } } } },
    }, 'Compositor'))
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
    const editorApp = app as unknown as {
      compositorTargetForInput(tab: unknown, graph: string, node: string, input: string): unknown
      openCompositorEditor(target: unknown): boolean
    }
    const target = editorApp.compositorTargetForInput(app.activeTab()!, 'g0', 'create', 'recipe')
    if (!editorApp.openCompositorEditor(target)) throw new Error('Empty compositor did not open')
  })
  const editor = page.getByTestId('compositor-editor')
  await expect(editor.getByTestId('compositor-empty')).toContainText('Run Create Layered Image to load its sources.')
  await expect(editor.getByTestId('compositor-empty')).toContainText('The layer stack stays in the graph.')
  await expect(editor.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled()
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await page.mouse.move(0, 0)
    await screenshot(page, `compositor-no-runtime-${width}`)
  }
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(editor).toBeHidden()
  await page.evaluate(async () => {
    const componentPath = '/src/CompositorEditor.tsx'
    const rendererPath = '/node_modules/.vite/deps/solid-js_web.js'
    const { CompositorEditor } = await import(componentPath)
    const { render } = await import(rendererPath)
    const host = document.createElement('div')
    host.style.cssText = 'position:absolute;inset:48px 0 0;z-index:20'
    document.querySelector('.canvas-pane')!.append(host)
    const dispose = render(() => CompositorEditor({ app: window.__dinksterTest!.app }), host)
    ;(window as unknown as { disposeCompositorVisual: () => void }).disposeCompositorVisual = () => { dispose(); host.remove() }
  })
  await expect(page.getByText('No compositor target is active.', { exact: true })).toBeVisible()
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await screenshot(page, `compositor-no-target-${width}`)
  }
  await page.evaluate(() => (window as unknown as { disposeCompositorVisual(): void }).disposeCompositorVisual())
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
        dispose = render(() => AssetWidgetEditor({
          app: {
            backendForTab: () => ({ id: 'asset-visual', label: 'Visual fixture', baseUrl: '', protocol: 'dinkster', connection: {
              listMounts: async () => [],
              listLocalAssets: async () => ({ assets: [] }),
              checkAssetAvailability: async () => [],
              onMountsChanged: () => () => {},
              fetchMountSettings: async () => ({ mounts: [], mountChangesAllowed: false }),
              fetchMountLocations: async () => ({ mounts: [], activeMounts: [] }),
            } }),
            dispatchTo: () => { host.dataset['committed'] = 'true' },
            widgetRegistry: { kind: () => undefined },
          },
          ed: {
            tab: {}, graphId: 'g0', target: { kind: 'input', nodeId: 'asset', valueKey: 'file' },
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
    const componentPath = '/src/ConnectionProfiles.tsx'
    const profilesPath = '/src/connection-profiles.ts'
    const rendererPath = '/node_modules/.vite/deps/solid-js_web.js'
    const { ConnectionProfilesSection } = await import(componentPath)
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
    const dispose = render(() => ConnectionProfilesSection({ app: {
      addBackendByUrl: () => new Promise<boolean>((resolve) => { finishConnect = () => resolve(false) }),
    } }), host)
    ;(window as unknown as { connectionVisual: { fail(): void; dispose(): void } }).connectionVisual = {
      fail: () => finishConnect!(),
      dispose: () => { dispose(); host.remove(); desktopWindow.dinksterDesktop = previousBridge },
    }
  })
  const fixture = page.getByRole('region', { name: 'Saved connections fixture' })
  const row = fixture.getByTestId('profile-row')
  await expect(row.getByTestId('profile-credential-badge')).toBeVisible()
  const capture = async (state: string): Promise<void> => {
    for (const [width, height] of [[1440, 900], [900, 700]] as const) {
      await page.setViewportSize({ width, height })
      const lastAction = state === 'token-editor' ? row.getByTestId('profile-token-save') : row.getByTestId('profile-remove')
      await lastAction.scrollIntoViewIfNeeded()
      await expect(lastAction).toBeInViewport()
      const identity = await row.getByText('Studio render server with a long descriptive name', { exact: true }).boundingBox()
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
  await fixture.getByTestId('profile-url-input').fill('file:///invalid-server')
  await fixture.getByTestId('profile-add').click()
  await expect(fixture.getByRole('alert')).toHaveText('A profile needs an absolute http(s) address without embedded credentials.')
  await expect(fixture.getByTestId('profile-row')).toHaveCount(1)
  await expect(fixture.getByTestId('profile-url-input')).toHaveValue('file:///invalid-server')
  for (const [width, height] of [[1440, 900], [900, 700]] as const) {
    await page.setViewportSize({ width, height })
    await fixture.getByRole('alert').scrollIntoViewIfNeeded()
    await page.mouse.move(0, 0)
    await screenshot(page, `connection-profile-invalid-address-${width}`)
  }
  await fixture.getByTestId('profile-name-input').fill('Recovered source')
  await fixture.getByTestId('profile-url-input').fill('https://recovered.example.test')
  await fixture.getByTestId('profile-add').click()
  await expect(fixture.getByRole('alert')).toHaveCount(0)
  await expect(fixture.getByTestId('profile-row')).toHaveCount(2)
  await expect(fixture.getByTestId('profile-row').filter({ hasText: 'Recovered source' })).toContainText('https://recovered.example.test')
  await page.evaluate(() => (window as unknown as { connectionVisual: { dispose(): void } }).connectionVisual.dispose())
})

test('Project rows preserve names, rename drafts and host actions', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.evaluate(async () => {
    const componentPath = '/src/ProjectsDialog.tsx'
    const projectsPath = '/src/projects.ts'
    const rendererPath = '/node_modules/.vite/deps/solid-js_web.js'
    const { ProjectsDialog } = await import(componentPath)
    const { createProject } = await import(projectsPath)
    const { render } = await import(rendererPath)
    createProject('Studio production with a long descriptive project name')
    createProject('Audio experiments')
    const host = document.createElement('section')
    host.style.cssText = 'position:absolute;top:64px;left:84px;right:24px;bottom:32px;max-width:720px;overflow:auto;z-index:20;background:var(--dinkster-surface-panel)'
    host.setAttribute('aria-label', 'Projects fixture')
    document.querySelector('.canvas-pane')!.append(host)
    const dispose = render(() => ProjectsDialog({
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
      items: [{ kind: 'input', id: 'fragment_shader', optional: true, type: { kind: 'concrete', name: 'core.string' },
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
