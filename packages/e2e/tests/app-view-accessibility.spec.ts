import { expect, test, type Page } from './fixtures.js'

async function selectAppView(page: Page): Promise<void> {
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
}

async function setEditorWidth(page: Page, width: number): Promise<void> {
  await page.locator('.canvas-stage').evaluate((element, nextWidth) => {
    element.style.width = `${nextWidth}px`
  }, width)
  await expect(page.getByTestId('app-view')).toHaveAttribute(
    'data-app-breakpoint',
    width < 640 ? 'mobile' : 'desktop',
  )
}

async function injectPreview(page: Page, color = '#2563eb'): Promise<void> {
  await page.evaluate(async (fillColor) => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = { connection: compiled.artifact.connection, prompt: 'app-view-a11y-preview' }
    const store = app.store as unknown as {
      register(ref: unknown, artifact: unknown, now: number): void
      apply(event: unknown): void
    }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    store.apply({
      kind: 'nodeStates', execution: ref, timestamp: Date.now(),
      nodes: { widgets: { state: 'running' } },
    })
    const canvas = new OffscreenCanvas(320, 180)
    const context = canvas.getContext('2d')!
    context.fillStyle = fillColor
    context.fillRect(0, 0, 320, 180)
    const payload = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()
    store.apply({
      kind: 'preview', execution: ref, timestamp: Date.now(),
      runtimeNodeId: 'widgets', channel: 'image/png', payload,
    })
  }, color)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(() => {
    const widget = (id: string, widgetType: string, defaultValue: unknown) => ({
      kind: 'input', id, type: { kind: 'concrete', name: widgetType }, optional: false,
      widget: { widgetType, options: {}, default: defaultValue },
    })
    window.__dinksterTest!.app.registerSchemas([{
      type: 'AppViewA11yTest', displayName: 'Accessible App', category: 'test', source: 'v3', isOutputNode: false,
      items: [widget('prompt', 'STRING', 'portrait'), widget('steps', 'INT', 20)],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'app-view-a11y-test', root: 'g0',
      meta: { title: 'Accessible App View', description: 'Keyboard and screen reader proof' },
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { widgets: { id: 'widgets', type: 'AppViewA11yTest', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      } },
      view: { graphs: { g0: { nodes: { widgets: { position: { x: 100, y: 100 } } } } } },
      ext: {
        'dinkster.exposed': [
          { graphId: 'g0', nodeId: 'widgets', inputId: 'prompt', label: 'Prompt' },
          { graphId: 'g0', nodeId: 'widgets', inputId: 'steps', label: 'Steps' },
        ],
        'dinkster.exposedPreviews': [{ graphId: 'g0', nodeId: 'widgets', label: 'Result' }],
        'dinkster.appLayout': {
          version: 1,
          desktop: { items: [
            { id: 'steps', kind: 'control', ref: { graphId: 'g0', nodeId: 'widgets', inputId: 'steps' }, x: 6, y: 2, w: 5, h: 2 },
            { id: 'result', kind: 'preview', ref: { graphId: 'g0', nodeId: 'widgets' }, x: 0, y: 5, w: 12, h: 4 },
            { id: 'intro', kind: 'text', role: 'heading', text: 'Read the [guide](https://example.com).', x: 0, y: 0, w: 12, h: 1 },
            { id: 'settings', kind: 'group', title: 'Settings', children: ['prompt', 'group-stale'], x: 0, y: 2, w: 6, h: 3 },
            { id: 'prompt', kind: 'control', ref: { graphId: 'g0', nodeId: 'widgets', inputId: 'prompt' } },
            { id: 'group-stale', kind: 'control', ref: { graphId: 'g0', nodeId: 'widgets', inputId: 'removed-from-group' } },
            { id: 'grid-stale', kind: 'control', ref: { graphId: 'g0', nodeId: 'widgets', inputId: 'removed-from-grid' }, x: 6, y: 9, w: 6, h: 2 },
            { id: 'stale', kind: 'control', ref: { graphId: 'g0', nodeId: 'widgets', inputId: 'removed' } },
          ] },
          mobile: { customized: true, items: [], order: ['steps', 'intro', 'settings', 'result', 'grid-stale', 'stale'] },
        },
      },
    }, 'Accessible App View')
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === 'app-view-a11y-test')
    return tab !== undefined && 'status' in tab.store
  })
  await injectPreview(page)
  await selectAppView(page)
  await expect(page.getByTestId('app-preview-image')).toBeVisible()
})

test('focus and DOM order follow desktop and mobile reading order', async ({ page }) => {
  const gridPlacements = page.getByTestId('app-layout-grid').locator(':scope > [role="listitem"]')
  await expect(gridPlacements).toHaveCount(4)
  expect(await gridPlacements.evaluateAll((elements) => elements.map((element) =>
    element.getAttribute('aria-label')?.replace(/\. Use arrow keys.*$/, '')))).toEqual([
    'Grid placement: Read the [guide](https://example.com).',
    'Grid placement: Settings',
    'Grid placement: Steps',
    'Grid placement: Result',
  ])
  expect(await gridPlacements.first().getAttribute('aria-keyshortcuts')).toBeNull()
  expect(await gridPlacements.evaluateAll((elements) => elements.every((element, index) => {
    if (index === 0) return true
    const previous = elements[index - 1]!.getBoundingClientRect()
    const current = element.getBoundingClientRect()
    return current.top > previous.top || (Math.abs(current.top - previous.top) < 1 && current.left >= previous.left)
  }))).toBe(true)

  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible()
  await expect(page.getByRole('spinbutton', { name: 'Steps' })).toBeVisible()
  const preview = page.getByRole('region', { name: 'Result' })
  await expect(preview).toHaveAttribute('aria-live', 'polite')
  await expect(preview.getByRole('img', { name: 'Image preview' })).toBeVisible()
  const previewAnnouncement = preview.getByTestId('app-preview-announcement')
  await expect(previewAnnouncement).toHaveText('Preview updated. Revision 1.')
  await injectPreview(page, '#16a34a')
  await expect(previewAnnouncement).toHaveText('Preview updated. Revision 2.')
  await expect(page.getByTestId('app-layout-group')).toHaveAttribute('aria-label', 'Group: Settings')

  await page.getByTestId('app-view-arrange-toggle').focus()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('app-view-queue')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'guide' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('spinbutton', { name: 'Steps' })).toBeFocused()

  await page.evaluate(() => {
    const store = window.__dinksterTest!.app.activeTab()!.store
    for (const id of ['steps', 'result', 'intro', 'settings']) {
      store.dispatch({ command: 'app.layout.setGrid', params: { id, grid: null } })
    }
  })
  await expect(page.getByTestId('app-layout-flow').locator(':scope > [role="listitem"]')).toHaveCount(4)
  await page.getByTestId('app-view-arrange-toggle').focus()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('app-view-queue')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('spinbutton', { name: 'Steps' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'guide' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeFocused()

  await page.getByTestId('app-view-queue').focus()
  await setEditorWidth(page, 600)
  const mobilePlacements = page.getByTestId('app-layout-mobile').locator(':scope > [role="listitem"]')
  await expect(mobilePlacements).toHaveCount(4)
  const mobileText = await page.getByTestId('app-layout-mobile').innerText()
  expect(mobileText.indexOf('Steps')).toBeLessThan(mobileText.indexOf('Read the guide'))
  expect(mobileText.indexOf('Read the guide')).toBeLessThan(mobileText.indexOf('Settings'))
  expect(mobileText.indexOf('Settings')).toBeLessThan(mobileText.indexOf('Result'))

  await page.getByTestId('app-view-arrange-toggle').focus()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('app-view-queue')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('spinbutton', { name: 'Steps' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'guide' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeFocused()
})

test('arrange controls expose state and keyboard-complete grid and mobile gestures', async ({ page }) => {
  await page.getByTestId('app-view-arrange-toggle').click()
  await expect(page.getByTestId('app-view-arrange-toggle')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('group', { name: 'Layout preview breakpoint' })).toBeVisible()
  await expect(page.getByTestId('app-layout-breakpoint-desktop')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('app-layout-breakpoint-mobile')).toHaveAttribute('aria-pressed', 'false')

  const steps = page.getByRole('listitem', { name: /Grid placement: Steps/ })
  await expect(steps).toHaveAttribute('aria-keyshortcuts', /Shift\+ArrowRight/)
  await expect(steps).toHaveAttribute('aria-description', 'Use arrow keys to move and Shift plus arrow keys to resize. Escape cancels.')
  await expect(steps.getByRole('button', { name: 'Move Steps with arrow keys' })).toHaveAttribute('tabindex', '0')
  await expect(steps.getByRole('button', { name: 'Return Steps to flow' })).toHaveAttribute('tabindex', '0')
  await expect(steps.getByTestId('app-layout-grid-resize-right')).toHaveAttribute('tabindex', '0')
  await expect(steps.getByTestId('app-layout-grid-resize-bottom')).toHaveAttribute('tabindex', '0')

  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await steps.focus()
  await page.keyboard.down('ArrowRight')
  await expect(page.locator('.app-view-assistive-text[role="status"]').filter({ hasText: 'Steps: column 8' })).toBeAttached()
  await page.keyboard.press('Escape')
  await page.keyboard.up('ArrowRight')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await expect(steps).toHaveAttribute('data-grid-x', '6')

  const widthHandle = steps.getByTestId('app-layout-grid-resize-right')
  await widthHandle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(steps).toHaveAttribute('data-grid-w', '4')
  await expect(widthHandle).toBeFocused()

  const stale = page.getByTestId('app-layout-flow').getByRole('listitem').filter({ hasText: 'Unavailable' })
  await expect(stale).toHaveAttribute('aria-label', 'Unavailable placement: control is no longer exposed')
  await expect(stale.getByRole('button', { name: 'Remove unavailable placement' })).toBeVisible()
  const groupedStale = page.locator('.app-layout-group-child[role="listitem"]').filter({ has: page.getByTestId('app-layout-missing') })
  await expect(groupedStale).toHaveAttribute('aria-label', 'Unavailable placement: control is no longer exposed')
  await expect(page.locator('[data-app-grid-id="grid-stale"]')).toHaveAttribute(
    'aria-label',
    'Grid placement: Unavailable placement: control is no longer exposed',
  )
  await expect(page.getByRole('textbox', { name: 'Text content' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Group title' })).toBeVisible()

  await page.getByTestId('app-layout-breakpoint-mobile').click()
  await expect(page.getByTestId('app-layout-breakpoint-mobile')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('app-layout-breakpoint-desktop')).toHaveAttribute('aria-pressed', 'false')
  const mobileSteps = page.getByRole('listitem', { name: /Mobile placement: Steps/ })
  await expect(mobileSteps).toHaveAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown Escape')
  await expect(mobileSteps).toHaveAttribute('aria-description', 'Use Up and Down arrow keys to reorder. Escape cancels.')
  await expect(mobileSteps.getByTestId('app-layout-mobile-drag')).toHaveAttribute('aria-hidden', 'true')
  await expect(mobileSteps.getByRole('button', { name: 'Move Steps down in mobile layout' })).toBeVisible()
  await expect(page.locator('[data-mobile-id="grid-stale"]')).toHaveAttribute(
    'aria-label',
    'Mobile placement: Unavailable placement: control is no longer exposed',
  )

  const mobileRevision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await mobileSteps.focus()
  await page.keyboard.down('ArrowDown')
  await expect(page.locator('.app-view-assistive-text[role="status"]').filter({ hasText: 'Steps: position 2' })).toBeAttached()
  await page.keyboard.press('Escape')
  await page.keyboard.up('ArrowDown')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(mobileRevision)
})
