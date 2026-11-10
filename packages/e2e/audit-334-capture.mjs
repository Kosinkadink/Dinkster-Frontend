// Screenshot and control-style capture for the frontend component audit.
// Run from packages/e2e with the private audit stack up:
//   node audit-334-capture.mjs
// Environment: AUDIT_BASE (default http://127.0.0.1:15630), AUDIT_OUT (screenshot dir),
// AUDIT_ONLY (comma list of passes to run: main, offline, narrow; other passes keep
// their previous entries in capture-results.json).
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env['AUDIT_BASE'] ?? 'http://127.0.0.1:15630'
const OUT = process.env['AUDIT_OUT'] ?? '/home/kosin/comfy-vibe-station/lanes/frontend-components-334-report/notes/audits/2026-09-22-frontend-components/screenshots'
const ONLY = new Set((process.env['AUDIT_ONLY'] ?? 'main,offline,narrow').split(','))
const RESULTS_FILE = path.join(OUT, '..', 'capture-results.json')
fs.mkdirSync(OUT, { recursive: true })

const controlProbe = (rootSelector) => {
  const root = rootSelector ? document.querySelector(rootSelector) : document.body
  if (!root) return { missing: rootSelector }
  const body = getComputedStyle(document.body)
  const rows = []
  const els = root.querySelectorAll('button, input, select, textarea, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="option"], dialog, a[href]')
  for (const el of els) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    const cs = getComputedStyle(el)
    rows.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') ?? '',
      role: el.getAttribute('role') ?? '',
      classes: el.className && typeof el.className === 'string' ? el.className : '',
      testid: el.getAttribute('data-testid') ?? '',
      inlineStyle: el.getAttribute('style') ?? '',
      appearance: cs.appearance,
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      bodyFontSize: body.fontSize,
      fontMatchesBody: cs.fontFamily === body.fontFamily,
      color: cs.color,
      background: cs.backgroundColor,
      border: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
      radius: cs.borderTopLeftRadius,
      padding: cs.paddingTop + ' ' + cs.paddingRight,
      height: Math.round(rect.height),
      width: Math.round(rect.width),
      text: (el.textContent ?? '').trim().slice(0, 40),
    })
  }
  return { count: rows.length, rows }
}

const activeProbe = (rootSelector) => {
  const el = document.activeElement
  if (!el || el === document.body) return { none: true }
  const root = rootSelector ? document.querySelector(rootSelector) : null
  const cs = getComputedStyle(el)
  const rect = el.getBoundingClientRect()
  return {
    inRoot: root ? root.contains(el) : null,
    tag: el.tagName.toLowerCase(),
    classes: typeof el.className === 'string' ? el.className : '',
    testid: el.getAttribute('data-testid') ?? '',
    role: el.getAttribute('role') ?? '',
    text: (el.textContent ?? '').trim().slice(0, 40),
    outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor + ' offset ' + cs.outlineOffset,
    boxShadow: cs.boxShadow,
    focusVisible: el.matches(':focus-visible'),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
  }
}

const results = []
const errors = []

async function newPage(browser, viewport, { offline = false } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: 'dark' })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push({ where: currentId, error: String(e) }))
  page.on('console', (m) => { if (m.type() === 'error') errors.push({ where: currentId, console: m.text().slice(0, 300) }) })
  if (offline) {
    // Playwright globs match the full URL, so a bare '/api/**' matches nothing;
    // match on the parsed pathname instead. Answering the /api, /memory and
    // /supervisor prefixes with 502 also starves the WebSocket ticket request,
    // so the app boots against a dead backend.
    await page.route((url) => /^\/(api|memory|supervisor)(\/|$)/.test(url.pathname), (route) =>
      route.fulfill({ status: 502, contentType: 'text/plain', body: 'audit: backend unavailable' }))
  }
  await page.goto(BASE + '/', { waitUntil: 'load' })
  await page.waitForFunction(() => Boolean(window.__dinksterTest?.app), null, { timeout: 30000 })
  await page.waitForTimeout(offline ? 4000 : 3500)
  return { context, page }
}

let currentId = 'boot'
async function safe(label, fn) {
  try { await fn() } catch (error) { errors.push({ where: label, step: String(error).split('\n')[0] }); console.log('step failed', label, String(error).split('\n')[0]) }
}

async function capture(page, id, { root = null, focusTabs = 0, note = '' } = {}) {
  currentId = id
  await page.waitForTimeout(400)
  const file = `${id}.png`
  await page.screenshot({ path: path.join(OUT, file), animations: 'disabled' })
  const controls = await page.evaluate(controlProbe, root)
  const entry = { id, file, root, note, controls }
  if (focusTabs > 0) {
    const focusTrail = []
    for (let i = 0; i < focusTabs; i += 1) {
      await page.keyboard.press('Tab')
      focusTrail.push(await page.evaluate(activeProbe, root))
    }
    entry.focusTrail = focusTrail
    await page.waitForTimeout(150)
    const focusFile = `${id}--focus.png`
    await page.screenshot({ path: path.join(OUT, focusFile), animations: 'disabled' })
    entry.focusFile = focusFile
  }
  results.push(entry)
  console.log('captured', id)
  return entry
}

async function closeGallery(page) {
  const startBlank = page.locator('.template-gallery-close')
  if (await startBlank.count() > 0 && await startBlank.first().isVisible()) await startBlank.first().click()
  else await page.evaluate(() => window.__dinksterTest.app.templateGalleryOpen.set(false))
  await page.waitForTimeout(400)
}

async function openDock(page, toggleTestId) {
  const toggle = page.getByTestId(toggleTestId)
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click()
  await page.waitForTimeout(600)
}

async function focusDockToggle(page, toggleTestId) {
  await page.getByTestId(toggleTestId).focus()
}

async function openRail(page, title) {
  const rail = page.getByTestId('dock-zone-right')
  if (!await rail.isVisible()) await page.getByTestId('rail-toggle').click()
  const tab = rail.locator('[role="tab"]').filter({ hasText: title })
  if (await tab.count() === 0 || !await tab.first().isVisible()) {
    const overflow = rail.getByTestId('dock-zone-overflow-button')
    if (await overflow.count() > 0) {
      await overflow.first().click()
      const item = rail.locator('[data-testid="dock-zone-overflow-menu"] [role="menuitemradio"]').filter({ hasText: title })
      await item.first().click()
    }
  } else {
    await tab.first().click()
  }
  await page.waitForTimeout(500)
}

async function openModal(page, id) {
  await page.evaluate((panelId) => window.__dinksterTest.app.modalPanel.set(panelId), id)
  await page.waitForTimeout(700)
}

async function closeModal(page) {
  await page.evaluate(() => window.__dinksterTest.app.modalPanel.set(''))
  await page.waitForTimeout(300)
}

const demoWorkflow = {
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'audit-334-demo', root: 'g0',
  graphs: { g0: { id: 'g0', name: 'Audit demo', nodes: {
    gen: { id: 'gen', type: 'dinkster.image.generate', values: { width: 64, height: 64, batch_size: 1, channels: 'rgb', color_source: 'hex', operation: 'solid', color_a: '#336699' } },
    prev: { id: 'prev', type: 'dinkster.preview_image', values: {} },
  }, links: { l1: { id: 'l1', from: { node: 'gen', port: 'image' }, to: { node: 'prev', port: 'images' } } }, nets: {}, reroutes: {}, nextOrdinal: 3 } },
  view: { graphs: { g0: { nodes: { gen: { position: { x: 80, y: 120 } }, prev: { position: { x: 480, y: 120 } } } } } },
}

async function openDemoWorkflow(page) {
  await page.evaluate((doc) => {
    window.__dinksterTest.app.openDocument(doc, 'Audit demo')
  }, demoWorkflow)
  await page.waitForTimeout(1200)
}

const videoWorkflow = {
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'audit-334-video', root: 'g0',
  graphs: { g0: { id: 'g0', name: 'Video document', nodes: {
    source: { id: 'source', type: 'dinkster.video_document.make', values: { params: '{}' } },
    edit: { id: 'edit', type: 'dinkster.video_document.retime', values: { params: JSON.stringify({ track: 1, clip: 2, scalar: 0.5 }) } },
  }, links: { document: { id: 'document', from: { node: 'source', port: 'document' }, to: { node: 'edit', port: 'document' } } }, nets: {}, reroutes: {}, nextOrdinal: 3 } },
  view: { graphs: { g0: { nodes: { source: { position: { x: 60, y: 80 } }, edit: { position: { x: 500, y: 80 } } } } } },
}

async function clickWidgetRow(page, nodeId, inputId) {
  await page.evaluate(() => window.__dinksterTest.renderer?.setViewport({ x: 0, y: 0, scale: 1 }))
  await page.waitForTimeout(300)
  const point = await page.evaluate(([node, input]) => {
    const renderer = window.__dinksterTest.renderer
    const n = renderer.getScene().nodes.find((c) => c.id === node)
    if (!n) return null
    const row = n.layout.rows.find((c) => c.kind === 'widget' && c.inputId === input)
    if (!row) return { rows: n.layout.rows.map((r) => r.kind + ':' + (r.inputId ?? '')) }
    const rect = document.querySelector('[data-testid=graph-canvas]').getBoundingClientRect()
    return { x: rect.left + n.x + n.layout.width / 2, y: rect.top + n.y + row.y + row.height / 2 }
  }, [nodeId, inputId])
  if (!point || point.x === undefined) { console.log('widget row not found', nodeId, inputId, JSON.stringify(point)); return false }
  await page.mouse.click(point.x, point.y)
  await page.waitForTimeout(700)
  return true
}

async function selectNode(page, nodeId) {
  await page.evaluate(() => window.__dinksterTest.renderer?.setViewport({ x: 0, y: 0, scale: 1 }))
  await page.waitForTimeout(200)
  const point = await page.evaluate((node) => {
    const renderer = window.__dinksterTest.renderer
    const n = renderer.getScene().nodes.find((c) => c.id === node)
    if (!n) return null
    const rect = document.querySelector('[data-testid=graph-canvas]').getBoundingClientRect()
    return { x: rect.left + n.x + 40, y: rect.top + n.y + 12 }
  }, nodeId)
  if (!point) return false
  await page.mouse.click(point.x, point.y)
  await page.waitForTimeout(500)
  return true
}

const browser = await chromium.launch()
const wide = { width: 1440, height: 900 }

// ---------------------------------------------------------------- main pass
if (ONLY.has('main')) {
  const { context, page } = await newPage(browser, wide)

  // Starter gallery (shown on first load) and the shell around it.
  await capture(page, '01-shell-start-gallery', { root: '[data-testid="template-gallery"]', note: 'first load, starter gallery open' })
  await page.getByTestId('template-gallery-search').focus()
  await capture(page, '02-gallery-search-focus', { root: '[data-testid="template-gallery"]', focusTabs: 3 })
  await page.getByTestId('template-gallery-search').fill('zzzz-no-such-template')
  await capture(page, '03-gallery-empty-search', { root: '[data-testid="template-gallery"]', note: 'no matching templates' })
  await page.getByTestId('template-gallery-search').fill('')
  await closeGallery(page)
  await capture(page, '04-shell-blank-canvas', { root: '.shell', note: 'blank Untitled workflow' })
  await page.getByTestId('dinkster-menu-button').focus()
  await capture(page, '05-shell-topbar-focus', { root: '.shell', focusTabs: 6 })

  // Dock panels.
  const dock = [
    ['library-toggle', 'library'],
    ['learn-toggle', 'learn'],
    ['assets-toggle', 'assets'],
    ['backends-sidebar-toggle', 'backends'],
    ['memory-sidebar-toggle', 'memory'],
    ['p2p-sidebar-toggle', 'p2p'],
  ]
  let n = 10
  for (const [toggle, id] of dock) {
    await openDock(page, toggle)
    await focusDockToggle(page, toggle)
    await capture(page, `${n}-dock-${id}`, { root: '[data-testid="dock-panel"]', focusTabs: 5 })
    n += 1
  }
await safe('library-empty', async () => {
  // Library empty search state.
  await openDock(page, 'library-toggle')
  const librarySearch = page.locator('[data-testid="dock-panel"] input[type="search"], [data-testid="dock-panel"] input').first()
  if (await librarySearch.count() > 0) {
    await librarySearch.fill('zzzz-no-such-node')
    await capture(page, '16-dock-library-empty-search', { root: '[data-testid="dock-panel"]', note: 'library search with no matches' })
    await librarySearch.fill('')
  }
})
await safe('backends-form', async () => {
  // Backends: add-backend form and a failing URL.
  await openDock(page, 'backends-sidebar-toggle')
  const urlInput = page.getByTestId('backend-url-input')
  if (await urlInput.count() > 0) {
    await urlInput.fill('http://127.0.0.1:1')
    await urlInput.focus()
    await capture(page, '17-dock-backends-add-form', { root: '[data-testid="dock-panel"]', focusTabs: 2, note: 'address typed, submit enabled' })
    await page.getByTestId('backend-add').click()
    await page.waitForTimeout(4000)
    await capture(page, '18-dock-backends-add-error', { root: '[data-testid="dock-panel"]', note: 'unreachable backend URL submitted' })
  }

})
  // Bottom panels (empty before any run).
  await openDock(page, 'logs-toggle')
  await focusDockToggle(page, 'logs-toggle')
  await capture(page, '20-bottom-activity', { root: '[data-testid="dock-zone-bottom"]', focusTabs: 4 })
  await openDock(page, 'execution-log-toggle')
  await focusDockToggle(page, 'execution-log-toggle')
  await capture(page, '21-bottom-execution-log-empty', { root: '[data-testid="dock-zone-bottom"]', focusTabs: 4 })

  // Rail panels before a run (empty states).
  const rail = ['Executions', 'Outputs', 'Extensions', 'Boundary', 'Focused', 'Help', 'Problems']
  n = 30
  for (const title of rail) {
    await openRail(page, title)
    await capture(page, `${n}-rail-${title.toLowerCase().replace(/\s+/g, '-')}-empty`, { root: '[data-testid="dock-zone-right"]', focusTabs: 4 })
    n += 1
  }

await safe('populated', async () => {
  // Populated states: open a demo workflow, select a node, queue it.
  await openDemoWorkflow(page)
  await capture(page, '40-canvas-demo-workflow', { root: '.shell', note: 'two-node native workflow' })
  await selectNode(page, 'gen')
  await openRail(page, 'Focused')
  await capture(page, '41-rail-focused-selected', { root: '[data-testid="dock-zone-right"]', focusTabs: 3 })
  await openRail(page, 'Help')
  await capture(page, '42-rail-node-help-selected', { root: '[data-testid="dock-zone-right"]', focusTabs: 3 })
  await page.getByTestId('queue-button').click()
  await page.waitForTimeout(6000)
  await openRail(page, 'Executions')
  await capture(page, '43-rail-executions-after-run', { root: '[data-testid="dock-zone-right"]', focusTabs: 3 })
  await openRail(page, 'Outputs')
  await capture(page, '44-rail-outputs-after-run', { root: '[data-testid="dock-zone-right"]', focusTabs: 3 })
  await openRail(page, 'Problems')
  await capture(page, '45-rail-problems-after-run', { root: '[data-testid="dock-zone-right"]', focusTabs: 3 })
  await openDock(page, 'execution-log-toggle')
  await capture(page, '46-bottom-execution-log-after-run', { root: '[data-testid="dock-zone-bottom"]', focusTabs: 3 })
  await openDock(page, 'logs-toggle')
  await capture(page, '47-bottom-activity-after-run', { root: '[data-testid="dock-zone-bottom"]', focusTabs: 3 })

})
await safe('overlays', async () => {
  // Canvas overlays: context menu, node palette, universal search, app view.
  const canvas = await page.getByTestId('graph-canvas').boundingBox()
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height - 120, { button: 'right' })
  await page.waitForTimeout(500)
  await capture(page, '50-canvas-context-menu', { root: '.shell', focusTabs: 2 })
  await page.keyboard.press('Escape')
  await page.mouse.dblclick(canvas.x + canvas.width / 2, canvas.y + canvas.height - 120)
  await page.waitForTimeout(800)
  await capture(page, '51-node-palette', { root: '.shell', focusTabs: 3 })
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.__dinksterTest.app.searchOpen.set(true))
  await page.waitForTimeout(600)
  await capture(page, '52-universal-search', { root: '.shell', focusTabs: 2 })
  await page.keyboard.type('sett')
  await page.waitForTimeout(500)
  await capture(page, '53-universal-search-results', { root: '.shell' })
  await page.keyboard.press('Escape')
  await page.getByTestId('views-switcher').click()
  await page.waitForTimeout(400)
  await capture(page, '54-views-switcher-menu', { root: '.shell' })
  const appViewItem = page.getByRole('menuitemradio', { name: 'App view' })
  if (await appViewItem.count() > 0) {
    await appViewItem.click()
    await page.waitForTimeout(1000)
    await capture(page, '55-app-view-empty', { root: '.shell', focusTabs: 4 })
    const arrange = page.getByTestId('app-view-arrange-toggle')
    if (await arrange.count() > 0) {
      await arrange.click()
      await page.waitForTimeout(600)
      await capture(page, '56-app-view-arrange', { root: '.shell', focusTabs: 3 })
    }
    await page.getByTestId('views-switcher').click()
    await page.getByRole('menuitemradio', { name: 'Graph' }).click()
    await page.waitForTimeout(600)
  } else {
    await page.keyboard.press('Escape')
  }

})
  // Modal dialogs.
  const modals = ['settings', 'customize-layout', 'projects', 'subgraph-definitions', 'collab', 'desktop-management']
  n = 60
  for (const id of modals) {
    await openModal(page, id)
    await capture(page, `${n}-modal-${id}`, { root: 'dialog[open], .modal-surface, [role="dialog"]', focusTabs: 5 })
    n += 1
    await closeModal(page)
  }
await safe('settings-sections', async () => {
  // Settings sections: click through each section tab.
  await openModal(page, 'settings')
  const sectionTabs = page.locator('.settings-categories button')
  const sectionCount = await sectionTabs.count()
  console.log('settings sections', sectionCount)
  for (let i = 1; i < sectionCount; i += 1) {
    if (![1, 2, 6, 8, 10, 11].includes(i) && i !== sectionCount - 1) continue
    await sectionTabs.nth(i).click()
    await page.waitForTimeout(400)
    const name = ((await sectionTabs.nth(i).textContent()) ?? `section-${i}`).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    await capture(page, `${66 + i}-modal-settings-${name}`, { root: 'dialog[open], [role="dialog"]' })
  }
  const settingsSearch = page.locator('dialog[open] input, [role="dialog"] input').first()
  await settingsSearch.fill('grid')
  await page.waitForTimeout(400)
  await capture(page, '79a-modal-settings-search-results', { root: 'dialog[open], [role="dialog"]' })
  await settingsSearch.fill('zzzz-no-setting')
  await page.waitForTimeout(400)
  await capture(page, '79b-modal-settings-search-empty', { root: 'dialog[open], [role="dialog"]' })
  await settingsSearch.fill('')
  await closeModal(page)

})
await safe('image-document', async () => {
  // Image document workspace.
  await page.getByTestId('image-documents-button').click()
  await page.waitForTimeout(1500)
  await capture(page, '80-image-document-workspace', { root: '.shell', focusTabs: 5 })

})
await safe('video-document', async () => {
  // Video document editor.
  await page.evaluate((doc) => window.__dinksterTest.app.openDocument(doc, 'Video document'), videoWorkflow)
  await page.waitForTimeout(1200)
  const opened = await clickWidgetRow(page, 'edit', 'params')
  if (opened) await capture(page, '81-video-document-editor', { root: '.video-document-modal, [data-testid="video-document-editor"]', focusTabs: 5 })
  await page.keyboard.press('Escape')

})
  await context.close()
}

// ------------------------------------------------------- backend unavailable
if (ONLY.has('offline')) {
  const { context, page } = await newPage(browser, wide, { offline: true })
  await closeGallery(page)
  await capture(page, '90-offline-shell', { root: '.shell', note: 'all /api requests answer 502' })
  for (const [toggle, id] of [['backends-sidebar-toggle', 'backends'], ['memory-sidebar-toggle', 'memory'], ['p2p-sidebar-toggle', 'p2p'], ['library-toggle', 'library'], ['learn-toggle', 'learn'], ['assets-toggle', 'assets']]) {
    await openDock(page, toggle)
    await capture(page, `91-offline-dock-${id}`, { root: '[data-testid="dock-panel"]' })
  }
  await openRail(page, 'Problems')
  await capture(page, '92-offline-rail-problems', { root: '[data-testid="dock-zone-right"]' })
  await openModal(page, 'desktop-management')
  await capture(page, '93-offline-modal-desktop-management', { root: 'dialog[open], [role="dialog"]' })
  await closeModal(page)
  await context.close()
}

// -------------------------------------------------------------- narrow pass
if (ONLY.has('narrow')) {
  const narrow = { width: 900, height: 700 }
  const { context, page } = await newPage(browser, narrow)
  await capture(page, '95-narrow-gallery', { root: '[data-testid="template-gallery"]' })
  await closeGallery(page)
  await openDock(page, 'library-toggle')
  await capture(page, '96-narrow-library', { root: '.shell' })
  await openDock(page, 'backends-sidebar-toggle')
  await openRail(page, 'Executions')
  await capture(page, '97-narrow-backends-and-rail', { root: '.shell' })
  await openModal(page, 'settings')
  await capture(page, '98-narrow-settings', { root: 'dialog[open], [role="dialog"]' })
  await closeModal(page)
  await openModal(page, 'collab')
  await capture(page, '99-narrow-collab', { root: 'dialog[open], [role="dialog"]' })
  await closeModal(page)
  await context.close()
}

await browser.close()
// Keep entries from passes that did not run this time so partial reruns stay complete.
const previous = fs.existsSync(RESULTS_FILE) ? JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')) : { results: [], errors: [] }
const rerunIds = new Set(results.map((entry) => entry.id))
const merged = previous.results.filter((entry) => !rerunIds.has(entry.id)).concat(results)
merged.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
const mergedErrors = previous.errors.filter((entry) => !rerunIds.has(entry.where) && !(entry.where === 'boot' && ONLY.has('main'))).concat(errors)
fs.writeFileSync(RESULTS_FILE, JSON.stringify({ base: BASE, results: merged, errors: mergedErrors }, null, 1))
console.log('done', results.length, 'captures this run,', merged.length, 'total,', errors.length, 'page errors this run')
