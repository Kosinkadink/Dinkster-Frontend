import { expect, test } from './fixtures.js'
import { evidencePath } from './evidence-output.js'

test('canvas view menus localize in place without changing registry data or app state', async ({ page, request }) => {
  let schemaRequests = 0
  let diagnosticRequests = 0
  await page.route('/api/nodes*', (route) => {
    schemaRequests += 1
    return route.fulfill({ json: {
      schemaVersion: 1,
      epoch: 1,
      dinkster: { version: 'canvas-view-i18n-e2e', schemaWire: 1 },
      nodes: {},
    } })
  })
  await page.route('/api/diagnostics*', (route) => {
    diagnosticRequests += 1
    return route.fulfill({ json: { diagnostics: [] } })
  })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest?.app !== undefined)
  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  const stateBeforeLocale = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return {
      document: JSON.stringify(tab.store.doc),
      revision: tab.store.revision,
      graphStack: [...tab.graphStack.get()],
      viewport: window.__dinksterTest!.renderer!.getViewport(),
    }
  })

  await page.getByTestId('views-switcher').click()
  const viewMenu = page.locator('.view-menu')
  const graphItem = viewMenu.getByRole('menuitemradio', { name: 'Graph' })
  await graphItem.focus()
  await viewMenu.evaluate((element) => { element.dataset['localeIdentity'] = 'view-menu' })
  await graphItem.evaluate((element) => { element.dataset['localeIdentity'] = 'graph-item' })
  const requestsBeforeLocale = { schema: schemaRequests, diagnostics: diagnosticRequests }
  await page.screenshot({ path: evidencePath('issue-457', 'canvas-view-controls-i18n-en.png'), fullPage: true })

  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'canvas.viewControls.active.app': '[APP-MODUS]',
      'canvas.viewControls.active.graph': '[DIAGRAMM-MODUS]',
      'canvas.viewControls.heading.lenses': '[ANSICHTSLINSEN]',
      'canvas.viewControls.heading.namedNets': '[BENANNTE NETZE]',
      'canvas.viewControls.heading.views': '[EDITORANSICHTEN]',
      'canvas.viewControls.lens.tooltip': '[DARSTELLUNG WAHLEN]',
      'canvas.viewControls.namedNets.guides.description': '[TAGS MIT GESTRICHELTEN LEITKURVEN]',
      'canvas.viewControls.namedNets.guides.label': '[ALLE ALS TAGS UND LEITKURVEN]',
      'canvas.viewControls.namedNets.noodles.description': '[ALLE VERBINDUNGEN ALS KURVEN ZEICHNEN]',
      'canvas.viewControls.namedNets.noodles.label': '[ALLE ALS KURVEN]',
      'canvas.viewControls.namedNets.tags.description': '[NUR SET/GET-TAGS ANZEIGEN]',
      'canvas.viewControls.namedNets.tags.label': '[ALLE ALS TAGS]',
      'canvas.viewControls.view.app': '[APP-ANSICHT]',
      'canvas.viewControls.view.tooltip': '[BEARBEITUNGSANSICHT WAHLEN]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(page.getByTestId('views-switcher')).toContainText('[DIAGRAMM-MODUS]')
  await expect(page.getByTestId('views-switcher')).not.toHaveAttribute('data-tooltip-label', /.+/)
  await expect(viewMenu).toHaveAttribute('data-locale-identity', 'view-menu')
  const retainedGraphItem = viewMenu.locator('[data-locale-identity="graph-item"]')
  await expect(retainedGraphItem).toBeFocused()
  await expect(viewMenu).toContainText('[EDITORANSICHTEN]')
  await expect(viewMenu).toContainText('[APP-ANSICHT]')
  await expect(viewMenu).toContainText('[BENANNTE NETZE]')
  await expect(viewMenu).toContainText('[ALLE ALS KURVEN]')
  await expect(viewMenu).toContainText('[ALLE VERBINDUNGEN ALS KURVEN ZEICHNEN]')
  await expect(viewMenu).toContainText('[ALLE ALS TAGS UND LEITKURVEN]')
  await page.screenshot({ path: evidencePath('issue-457', 'canvas-view-controls-i18n-de-DE.png'), fullPage: true })

  await page.getByTestId('views-switcher').click()
  await expect(page.getByTestId('views-switcher')).toHaveAttribute('data-tooltip-label', '[BEARBEITUNGSANSICHT WAHLEN]')
  await page.evaluate(async ({ i18nModule }) => {
    const { setLocale } = await import(i18nModule)
    setLocale('en')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })
  await page.getByTestId('lens-switcher').click()
  const lensMenu = page.locator('.lens-menu')
  const standardLens = lensMenu.getByRole('menuitemradio', { name: /Standard/ })
  await standardLens.focus()
  await lensMenu.evaluate((element) => { element.dataset['localeIdentity'] = 'lens-menu' })
  await standardLens.evaluate((element) => { element.dataset['localeIdentity'] = 'standard-lens' })
  await page.evaluate(async ({ i18nModule }) => {
    const { setLocale } = await import(i18nModule)
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })
  await expect(lensMenu).toHaveAttribute('data-locale-identity', 'lens-menu')
  const retainedStandardLens = lensMenu.locator('[data-locale-identity="standard-lens"]')
  await expect(retainedStandardLens).toBeFocused()
  await expect(lensMenu).toContainText('[ANSICHTSLINSEN]')
  await expect(lensMenu).toContainText('Standard')
  await expect(lensMenu).toContainText('The standard graph editing view.')
  await expect(page.getByTestId('lens-switcher')).not.toHaveAttribute('data-tooltip-label', /.+/)
  expect({ schema: schemaRequests, diagnostics: diagnosticRequests }).toEqual(requestsBeforeLocale)
  expect(await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return {
      document: JSON.stringify(tab.store.doc),
      revision: tab.store.revision,
      graphStack: [...tab.graphStack.get()],
      viewport: window.__dinksterTest!.renderer!.getViewport(),
    }
  })).toEqual(stateBeforeLocale)
})

test('shell, App View, and runtime settings update from the active locale catalog', async ({ page, request }) => {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'host-i18n-e2e', schemaWire: 1 },
    nodes: {},
  } }))
  await page.route('/api/diagnostics*', (route) => route.fulfill({ json: { diagnostics: [] } }))
  await page.setViewportSize({ width: 1600, height: 950 })
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest?.app !== undefined)
  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
  await page.getByTestId('rail-toggle').click()
  await expect(page.getByTestId('app-view-arrange-toggle')).toContainText('Arrange')
  await expect(page.getByTestId('app-view-empty')).toContainText('Nothing is exposed yet.')
  await expect(page.getByTestId('backends-toggle')).toContainText('Backends')
  await expect(page.getByTestId('review-upgrades-toggle')).toContainText('Review upgrades: off')
  await page.getByTestId('dinkster-menu-button').click()
  await expect(page.locator('[data-item-id="workflow.open"]')).toContainText('Open workflow library')
  await page.screenshot({ path: evidencePath('issue-457', 'host-i18n-app-view-en.png'), fullPage: true })
  await page.getByTestId('dinkster-menu-button').click()
  await page.getByTestId('settings-button').click()
  await expect(page.locator('[data-setting-id="canvas.grid.visible"]')).toContainText('Show dot grid')
  await page.screenshot({ path: evidencePath('issue-457', 'host-i18n-settings-en.png'), fullPage: true })

  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'appView.arrange': '[Anordnen und gestalten]',
      'appView.empty': '[Noch keine Steuerelemente freigegeben.]',
      'appView.queue': '[Arbeitsablauf starten]',
      'command.settings.open': '[Einstellungen offnen]',
      'command.workflow.open': '[Arbeitsablaufbibliothek offnen]',
      'runtimeSettings.access.editable': '[Bearbeitbar]',
      'runtimeSettings.action.apply': '[Anwenden]',
      'runtimeSettings.action.refresh': '[Aktualisieren]',
      'runtimeSettings.action.reset': '[Zurucksetzen]',
      'runtimeSettings.category.jobs': '[Auftragsparallelitat]',
      'runtimeSettings.editor.legend': '[Bearbeite {category}]',
      'runtimeSettings.jobs.maximumRunning': '[Maximal laufende Auftrage]',
      'runtimeSettings.metadata.effectiveValue': '[Wirksamer Wert]',
      'runtimeSettings.metadata.mutability': '[Anderbarkeit]',
      'runtimeSettings.metadata.persistence': '[Speicherung]',
      'runtimeSettings.metadata.source': '[Quelle]',
      'runtimeSettings.panel.description': '[Wirksame Werte und Berechtigungen]',
      'runtimeSettings.panel.title': '[Laufzeiteinstellungen]',
      'runtimeSettings.persistence.persisted': '[Gespeichert]',
      'runtimeSettings.status.clean': '[Keine ungespeicherten Anderungen]',
      'settings.canvas.grid.visible': '[Punktraster anzeigen]',
      'shell.panel.projects.title': '[Projects-DE]',
      'shell.panel.activity.title': '[Akt]',
      'shell.panel.assets.title': '[Dat]',
      'shell.panel.backends.title': '[Srv]',
      'shell.panel.executionLog.title': '[Log]',
      'shell.panel.executions.title': '[Run]',
      'shell.panel.library.title': '[Lib]',
      'shell.panel.memory.title': '[RAM]',
      'shell.panel.outputs.title': '[Out]',
      'shell.panel.settings.title': '[Cfg]',
      'shell.reviewUpgrades.label': '[Prufe Aktualisierungen: {state}]',
      'shell.state.off': '[aus]',
      'shell.toggle.leftPanel': '[Linken Bereich umschalten]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(page.locator('[data-setting-id="canvas.grid.visible"]')).toContainText('[Punktraster anzeigen]')
  await page.screenshot({ path: evidencePath('issue-457', 'host-i18n-settings-de-DE.png'), fullPage: true })
  await page.getByTestId('modal-close').click()
  await expect(page.getByTestId('left-panel-toggle')).toHaveAttribute('aria-label', '[Linken Bereich umschalten]')
  await expect(page.getByTestId('projects-button')).toHaveAttribute('aria-label', '[Projects-DE]')
  await expect(page.getByTestId('library-toggle')).toContainText('[Lib]')
  await expect(page.getByTestId('backends-toggle')).toContainText('[Srv]')
  await expect(page.getByTestId('review-upgrades-toggle')).toContainText('[Prufe Aktualisierungen: [aus]]')
  await expect(page.getByTestId('app-view-arrange-toggle')).toContainText('[Anordnen und gestalten]')
  await expect(page.getByTestId('app-view-empty')).toContainText('[Noch keine Steuerelemente freigegeben.]')
  await expect(page.getByTestId('dinkster-menu-button')).toHaveAttribute('aria-expanded', 'false')
  await page.getByTestId('dinkster-menu-button').click()
  await expect(page.locator('[data-item-id="workflow.open"]')).toContainText('[Arbeitsablaufbibliothek offnen]')
  await page.screenshot({ path: evidencePath('issue-457', 'host-i18n-app-view-de-DE-final.png'), fullPage: true })

  const mainModule = await (await request.get('/src/main.tsx')).text()
  const renderModule = mainModule.match(/from "([^"]*solid-js_web[^"]*)"/)?.[1]
  expect(renderModule).toBeDefined()
  await page.evaluate(async ({ i18nModule, renderModule }) => {
    const { render } = await import(renderModule)
    const runtimeSettingsModule = '/src/RuntimeSettingsPanel.tsx'
    const { RuntimeSettingsPanel } = await import(runtimeSettingsModule)
    const { setLocale } = await import(i18nModule)
    const host = document.createElement('section')
    host.id = 'runtime-i18n-proof'
    host.style.cssText = 'width:640px;margin:48px auto'
    document.body.replaceChildren(host)
    setLocale('en')
    const section = { value: { maxRunningJobs: 2 }, source: 'default', mutability: 'live', writable: true, persistence: { available: true, persisted: true } }
    const connection = {
      fetchRuntimeSettings: async () => ({ categories: { granted: ['jobs'], available: ['jobs'] }, settings: { jobs: section } }),
      updateRuntimeSetting: async (_category: string, value: unknown) => ({ ...section, value }),
    }
    render(() => RuntimeSettingsPanel({ connection, alwaysOpen: true }), host)
  }, { i18nModule: new URL(i18nModule!, page.url()).href, renderModule: new URL(renderModule!, page.url()).href })
  await expect(page.locator('#runtime-i18n-proof')).toContainText('Runtime settings')
  await expect(page.locator('#runtime-i18n-proof')).toContainText('Maximum running jobs')
  await page.screenshot({ path: evidencePath('issue-457', 'host-i18n-runtime-en.png'), fullPage: true })
  await page.evaluate(async ({ i18nModule }) => {
    const { setLocale } = await import(i18nModule)
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })
  await expect(page.locator('#runtime-i18n-proof')).toContainText('[Laufzeiteinstellungen]')
  await expect(page.locator('#runtime-i18n-proof')).toContainText('[Maximal laufende Auftrage]')
  await page.screenshot({ path: evidencePath('issue-457', 'host-i18n-runtime-de-DE.png'), fullPage: true })
})

test('panel host chrome updates in place without backend requests', async ({ page, request }) => {
  let schemaRequests = 0
  let diagnosticRequests = 0
  await page.route('/api/nodes*', (route) => {
    schemaRequests += 1
    return route.fulfill({ json: {
      schemaVersion: 1,
      epoch: 1,
      dinkster: { version: 'shell-panel-host-i18n-e2e', schemaWire: 1 },
      nodes: {},
    } })
  })
  await page.route('/api/diagnostics*', (route) => {
    diagnosticRequests += 1
    return route.fulfill({ json: { diagnostics: [] } })
  })
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest?.app !== undefined)
  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  const mainModule = await (await request.get('/src/main.tsx')).text()
  const renderModule = mainModule.match(/from "([^"]*solid-js_web[^"]*)"/)?.[1]
  expect(renderModule).toBeDefined()

  await page.evaluate(async ({ renderModule }) => {
    const { render } = await import(renderModule)
    const shellChromeModule = '/src/ShellChrome.tsx'
    const { DockZoneHost, FloatingPanelHost } = await import(shellChromeModule)
    const proof = document.createElement('section')
    proof.id = 'shell-panel-host-i18n-proof'
    proof.style.cssText = 'position:fixed;inset:72px 24px 24px 96px;z-index:30;background:#11151d;border:1px solid var(--color-border);display:grid;grid-template-columns:1fr 420px;gap:24px;padding:24px'
    const dock = document.createElement('div')
    dock.style.cssText = 'min-width:0;min-height:520px;position:relative'
    const floating = document.createElement('div')
    floating.style.cssText = 'min-width:0;min-height:520px;position:relative'
    proof.append(dock, floating)
    document.body.append(proof)
    const panel = (id: string, title: string) => ({
      id,
      title,
      placement: 'rail',
      allowedPlacements: ['rail', 'floating', 'window'],
      order: 1,
      component: () => {
        const body = document.createElement('div')
        body.dataset['testid'] = `proof-body-${id}`
        body.style.cssText = 'padding:20px;color:var(--color-text)'
        body.textContent = `${title} raw payload`
        return body
      },
    })
    const first = panel('proof-one', 'Queue alpha')
    const second = panel('proof-two', 'Queue beta')
    const third = panel('proof-three', 'Queue gamma')
    render(() => DockZoneHost({
      zone: 'right',
      ariaLabel: 'Inspector panels',
      sections: [
        { section: 0, panels: [first, second], activeId: first.id },
        { section: 1, panels: [third], activeId: third.id },
      ],
      split: 0.52,
      onSplitChange: () => {},
      onActivate: () => {},
      onRequestClose: () => {},
      onFloat: () => {},
      onOpenWindow: () => {},
    }), dock)
    render(() => FloatingPanelHost({
      panel: panel('proof-floating', 'Floating queue'),
      index: 0,
      onDock: () => {},
      onOpenWindow: () => {},
    }), floating)
  }, { renderModule: new URL(renderModule!, page.url()).href })

  const proof = page.locator('#shell-panel-host-i18n-proof')
  await page.evaluate(() => {
    ;(window as unknown as { __shellProofBodies: readonly Element[] }).__shellProofBodies = [
      ...Array.from(document.querySelectorAll('#shell-panel-host-i18n-proof [data-testid^="proof-body-"]')),
    ]
  })
  const floating = proof.locator('[data-testid="floating-panel"]')
  const floatingDock = floating.locator('.shell-panel-header-action')
  await floatingDock.focus()
  await floatingDock.press('Shift+F10')
  await expect(page.getByTestId('context-menu')).toContainText('Move to new window')
  await expect(proof.locator('[role="tablist"]').nth(0)).toHaveAttribute('aria-label', 'Inspector panels upper section')
  await expect(proof.locator('[role="tablist"]').nth(1)).toHaveAttribute('aria-label', 'Inspector panels lower section')
  await expect(floatingDock).toHaveText('Dock')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('context-menu')).toHaveCount(0)
  await proof.screenshot({ path: evidencePath('issue-457', 'shell-panel-host-i18n-en.png') })
  await floatingDock.focus()
  await floatingDock.press('Shift+F10')
  await expect(page.getByTestId('context-menu')).toContainText('Move to new window')
  const requestsBeforeLocale = { schema: schemaRequests, diagnostics: diagnosticRequests }

  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'command.layout.customize': '[Anordnung andern]',
      'shell.chrome.allTabs': '[Alle Reiter]',
      'shell.chrome.allZoneTabs': '[Reiter in {zone}]',
      'shell.chrome.allZoneTabsWithIndicator': '[Reiter in {zone}; Hinweis {indicator}]',
      'shell.chrome.closeZone': '[Schliesse {zone}]',
      'shell.chrome.dock': '[Andocken]',
      'shell.chrome.float': '[Schweben]',
      'shell.chrome.moveToNewWindow': '[In eigenes Fenster]',
      'shell.chrome.resizeZoneSections': '[Teile {zone} neu]',
      'shell.chrome.section.left': '[{zone}:LINKS]',
      'shell.chrome.section.lower': '[{zone}:UNTEN]',
      'shell.chrome.section.right': '[{zone}:RECHTS]',
      'shell.chrome.section.upper': '[{zone}:OBEN]',
      'shell.chrome.zoneTabs': '[Menu fur {zone}]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(page.getByTestId('customize-layout-button')).toHaveAttribute('aria-label', '[Anordnung andern]')
  await expect(proof.locator('[role="tablist"]').nth(0)).toHaveAttribute('aria-label', '[Inspector panels:OBEN]')
  await expect(proof.locator('[role="tablist"]').nth(1)).toHaveAttribute('aria-label', '[Inspector panels:UNTEN]')
  await expect(proof.getByTestId('dock-section-divider-right')).toHaveAttribute('aria-label', '[Teile Inspector panels neu]')
  await expect(proof.getByTestId('dock-zone-close')).toHaveAttribute('aria-label', '[Schliesse Inspector panels]')
  await expect(floatingDock).toHaveText('[Andocken]')
  await expect(page.getByTestId('context-menu')).toContainText('[Andocken]')
  await expect(page.getByTestId('context-menu')).toContainText('[In eigenes Fenster]')
  expect(await page.evaluate(() => {
    const before = (window as unknown as { __shellProofBodies: readonly Element[] }).__shellProofBodies
    const after = Array.from(document.querySelectorAll('#shell-panel-host-i18n-proof [data-testid^="proof-body-"]'))
    return before.length === after.length && before.every((node, index) => node === after[index])
  })).toBe(true)
  expect({ schema: schemaRequests, diagnostics: diagnosticRequests }).toEqual(requestsBeforeLocale)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('context-menu')).toHaveCount(0)
  await proof.screenshot({ path: evidencePath('issue-457', 'shell-panel-host-i18n-de-DE.png') })
})

test('workflow tab chrome and an open preview menu update without backend requests', async ({ page, request }) => {
  let schemaRequests = 0
  let diagnosticRequests = 0
  await page.route('/api/nodes*', (route) => {
    schemaRequests += 1
    return route.fulfill({ json: {
      schemaVersion: 1,
      epoch: 1,
      dinkster: { version: 'workflow-tabs-i18n-e2e', schemaWire: 1 },
      nodes: {},
    } })
  })
  await page.route('/api/diagnostics*', (route) => {
    diagnosticRequests += 1
    return route.fulfill({ json: { diagnostics: [] } })
  })
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest?.app !== undefined)
  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  const mainModule = await (await request.get('/src/main.tsx')).text()
  const renderModule = mainModule.match(/from "([^"]*solid-js_web[^"]*)"/)?.[1]
  expect(renderModule).toBeDefined()

  await page.evaluate(async ({ renderModule }) => {
    const { render } = await import(renderModule)
    const workflowTabsModule = '/src/WorkflowTabs.tsx'
    const { WorkflowTabs } = await import(workflowTabsModule)
    const proof = document.createElement('section')
    proof.id = 'workflow-tabs-i18n-proof'
    proof.style.cssText = 'position:fixed;inset:0;z-index:40;background:#11151d;padding:96px;color:var(--color-text)'
    document.body.append(proof)
    const tabs = [
      { id: 'one', title: 'Draft alpha' },
      { id: 'two', title: 'Snapshot beta' },
      { id: 'three', title: 'Shared gamma' },
    ]
    render(() => WorkflowTabs({
      tabs,
      activeId: 'one',
      isDirty: (tab: { id: string }) => tab.id === 'one',
      isFrozen: (tab: { id: string }) => tab.id === 'two',
      isShared: (tab: { id: string }) => tab.id === 'three',
      setRoot: () => {},
      onActivate: () => {},
      onClose: () => {},
      onPointerDown: () => {},
      onNew: () => {},
      canShare: () => true,
      onShare: () => {},
      onPopOut: () => {},
      onSplitRight: () => {},
      onSplitDown: () => {},
      onUnsplit: () => {},
      canSplit: () => true,
      previews: () => 'quality',
      onSetPreviews: () => {},
    }), proof)
    ;(window as unknown as { __workflowTabProofNodes: readonly Element[] }).__workflowTabProofNodes = [
      ...Array.from(proof.querySelectorAll('[role="tab"]')),
    ]
  }, { renderModule: new URL(renderModule!, page.url()).href })

  const proof = page.locator('#workflow-tabs-i18n-proof')
  const firstTab = proof.getByRole('tab', { name: 'Draft alpha, unsaved changes' })
  await firstTab.focus()
  await firstTab.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    element.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 8,
      clientY: rect.bottom + 12,
    }))
  })
  await page.getByTestId('context-menu-item').filter({ hasText: 'Live previews' }).hover()
  await expect(page.getByTestId('context-submenu')).toContainText('Inherit global')
  await expect(page.getByTestId('context-submenu').locator('.checked')).toContainText('Quality')
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="context-menu"]')
    const submenu = document.querySelector<HTMLElement>('[data-testid="context-submenu"]')
    if (root === null || submenu === null) throw new Error('Expected the preview menu to be open')
    ;(window as unknown as { __workflowMenuProofNodes: readonly Element[] }).__workflowMenuProofNodes = [root, submenu]
  })
  const requestsBeforeLocale = { schema: schemaRequests, diagnostics: diagnosticRequests }
  await page.screenshot({ path: evidencePath('issue-457', 'workflow-tabs-i18n-en.png'), fullPage: true })

  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'shell.chrome.moveToNewWindow': '[In eigenes Fenster]',
      'shell.workflow.new': '[Neuer Ablauf]',
      'shell.workflowTabs.close': '[Schliesse {title}]',
      'shell.workflowTabs.documents': '[Ablaufdokumente]',
      'shell.workflowTabs.livePreviews': '[Live-Vorschauen]',
      'shell.workflowTabs.openWorkflows': '[Offene Ablaufe]',
      'shell.workflowTabs.preview.auto': '[Automatisch]',
      'shell.workflowTabs.preview.cheap': '[Sparsam]',
      'shell.workflowTabs.preview.inheritGlobal': '[Global ubernehmen]',
      'shell.workflowTabs.preview.off': '[Aus]',
      'shell.workflowTabs.preview.quality': '[Qualitat]',
      'shell.workflowTabs.share': '[Teilen]',
      'shell.workflowTabs.splitDown': '[Nach unten teilen]',
      'shell.workflowTabs.splitRight': '[Nach rechts teilen]',
      'shell.workflowTabs.state.executionSnapshot': '[AUSFUHRUNGSBILD]',
      'shell.workflowTabs.state.shared': '[GETEILT]',
      'shell.workflowTabs.state.unsavedChanges': '[UNGESPEICHERT]',
      'shell.workflowTabs.unsplit': '[Teilung aufheben]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(proof.getByRole('navigation')).toHaveAttribute('aria-label', '[Ablaufdokumente]')
  await expect(proof.getByRole('tablist')).toHaveAttribute('aria-label', '[Offene Ablaufe]')
  await expect(proof.getByRole('tab').nth(0)).toHaveAttribute('aria-label', 'Draft alpha, [UNGESPEICHERT]')
  await expect(proof.getByRole('tab').nth(1)).toHaveAttribute('aria-label', 'Snapshot beta, [AUSFUHRUNGSBILD]')
  await expect(proof.getByRole('tab').nth(2)).toHaveAttribute('aria-label', 'Shared gamma, [GETEILT]')
  await expect(page.getByTestId('context-menu')).toContainText('[Teilen]')
  await expect(page.getByTestId('context-menu')).toContainText('[Nach rechts teilen]')
  await expect(page.getByTestId('context-menu')).toContainText('[In eigenes Fenster]')
  await expect(page.getByTestId('context-menu')).toContainText('[Live-Vorschauen]')
  await expect(page.getByTestId('context-submenu')).toContainText('[Global ubernehmen]')
  await expect(page.getByTestId('context-submenu').locator('.checked')).toContainText('[Qualitat]')
  expect(await page.evaluate(() => {
    const before = (window as unknown as { __workflowTabProofNodes: readonly Element[] }).__workflowTabProofNodes
    const after = Array.from(document.querySelectorAll('#workflow-tabs-i18n-proof [role="tab"]'))
    return before.length === after.length && before.every((node, index) => node === after[index])
  })).toBe(true)
  expect(await page.evaluate(() => {
    const before = (window as unknown as { __workflowMenuProofNodes: readonly Element[] }).__workflowMenuProofNodes
    const after = [
      document.querySelector('[data-testid="context-menu"]'),
      document.querySelector('[data-testid="context-submenu"]'),
    ]
    return {
      rootStable: before[0] === after[0],
      submenuStable: before[1] === after[1],
    }
  })).toEqual({ rootStable: true, submenuStable: true })
  expect({ schema: schemaRequests, diagnostics: diagnosticRequests }).toEqual(requestsBeforeLocale)
  await expect(page.locator('.context-menu-cascade')).toBeFocused()
  await page.screenshot({ path: evidencePath('issue-457', 'workflow-tabs-i18n-de-DE.png'), fullPage: true })
})
