import { expect, test } from '../visual.js'
import { evidencePath } from './evidence-output.js'

test('project opening distinguishes unanswered Dinkster from an installation start failure', async ({ page }) => {
  const project = { id: 'scene-outage', name: 'Mountain lanterns', created: '2026-01-01T00:00:00Z', revision: 1, deleted: false }
  const root = '/installs/nightly'
  let failure: 'project' | 'start' | 'installation' = 'project'
  await page.route('**/supervisor/status', route => route.fulfill({ json: { protocol: 1, role: 'home', state: 'stopped', installations: 1 } }))
  await page.route('**/supervisor/installations', route => route.fulfill({ json: {
    installations: [{ root, frontend: { wire: 2, selected: null, available: true } }],
  } }))
  await page.route('**/supervisor/setup**', route => route.fulfill({ json: { activeJob: null } }))
  await page.route('**/supervisor/engine', route => failure === 'start'
    ? route.abort('connectionrefused')
    : route.fulfill({ status: 500, json: { error: 'engine-failed', message: 'Engine exited before becoming ready' } }))
  await page.route('**/supervisor/engine/log', route => route.fulfill({ json: { available: true, truncated: false, text: 'Engine startup: requested device is unavailable' } }))
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/projects') return route.fulfill({ json: { items: [project], cursor: null } })
    if (path === `/api/projects/${project.id}`) return failure === 'project'
      ? route.abort('connectionrefused') : route.fulfill({ json: { project } })
    return route.fulfill({ status: 503, json: { error: 'engine-not-ready', state: 'stopped' } })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible()
  for (const stage of ['project', 'start', 'installation'] as const) {
    failure = stage
    await page.getByTestId('projects-open').click()
    const sentence = stage === 'installation' ? 'nightly did not start' : 'Dinkster is not answering'
    await expect(page.locator('[role="option"][data-state="failed"]')).toContainText(sentence)
    await expect(page.getByRole('alert')).toContainText(`${sentence}, so Mountain lanterns could not open.`)
    await expect(page.getByTestId('projects-open')).toHaveText('Try again')
    const showLog = page.getByRole('button', { name: 'Show log', exact: true })
    if (stage === 'installation') {
      await expect(showLog).toBeVisible()
      await page.screenshot({ path: evidencePath('issue-1428', 'installation-failed.png') })
      await showLog.click()
      await expect(page.getByRole('dialog')).toContainText('Engine startup: requested device is unavailable')
    } else {
      await expect(showLog).toHaveCount(0)
      await page.screenshot({ path: evidencePath('issue-1428', `dinkster-unanswered-${stage}.png`) })
    }
  }
})

test('Projects and editor discovery stay usable while setup planning is unresolved', async ({ page }) => {
  const project = { id: 'default', name: 'Bookshop diorama', created: '2026-01-01T00:00:00Z', revision: 1, deleted: false }
  let retained: null | { state: string } = null
  let finishPlan!: () => void
  const planning = new Promise<void>((resolve) => { finishPlan = resolve })
  await page.route('**/supervisor/status', (route) => route.fulfill({ json: {
    protocol: 1, role: 'home', state: 'stopped', installations: 1,
  } }))
  await page.route('**/supervisor/installations', (route) => route.fulfill({ json: {
    installations: [{ root: '/installs/bookshop' }],
  } }))
  await page.route('**/supervisor/setup**', async (route) => {
    if (new URL(route.request().url()).pathname === '/supervisor/setup') await planning
    return route.fulfill({ json: { activeJob: retained } })
  })
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/projects') return route.fulfill({ json: { items: [project], cursor: null } })
    if (path === '/api/projects/default') return route.fulfill({ json: { project } })
    return route.fulfill({ status: 503, json: { error: 'engine-not-ready', state: 'stopped' } })
  })
  try {
    for (const state of [null, 'completed', 'cancelled', 'failed']) {
      retained = state === null ? null : { state }
      await page.goto('/')
      await expect(page.getByRole('option', { name: /Bookshop diorama/ })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Bookshop diorama', exact: true })).toBeVisible()
      await expect(page.getByTestId('setup-form')).toBeHidden()
      await page.goto('/?dinksterProject=default')
      await expect(page.getByTestId('engine-start')).toBeVisible()
      await expect(page.getByTestId('setup-form')).toBeHidden()
    }
  } finally {
    finishPlan()
  }
})

test('the native bridge opens Home without owning engine startup and retains its window context', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const project = {
    id: 'scene-native', uid: '48bb018e-5b17-4e68-bd81-c6412c4bcd72', name: 'Native bookshop',
    created: '2026-01-01T00:00:00Z', revision: 1, deleted: false,
    packs: { extra: [] }, environment: null, accountProject: null,
  }
  await page.addInitScript(() => {
    const context = { id: 'native-workflow', kind: 'workflow' as const, workflowId: 'detached-workflow' }
    const desktopWindow = window as Window & { dinksterDesktop?: unknown }
    desktopWindow.dinksterDesktop = {
      locale: async () => 'zh-CN',
      info: async () => ({}),
      windowContext: async () => context,
      windowLayout: async () => ({ windows: [context] }),
      onWindowLayout: () => () => undefined,
      takeDeepLinks: async () => [],
      onDeepLinkPending: () => () => undefined,
      connectionCredentials: async () => ({ custody: false, profiles: [] }),
    }
  })
  await page.route('**/supervisor/status', (route) => route.fulfill({ json: {
    protocol: 1, role: 'home', state: 'stopped', installations: 1,
    open: { root: '/installs/native', engine: 'main' },
  } }))
  await page.route('**/supervisor/installations', (route) => route.fulfill({ json: {
    installations: [{ root: '/installs/native', frontend: { wire: 2, selected: null, available: true } }],
  } }))
  await page.route('**/supervisor/setup**', (route) => route.fulfill({ json: { activeJob: null } }))
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/projects') return route.fulfill({ json: { items: [project], cursor: null } })
    if (path === `/api/projects/${project.id}`) return route.fulfill({ json: { project } })
    return route.fulfill({ status: 503, json: { error: 'engine-not-ready', state: 'stopped' } })
  })

  await page.goto('/')
  await expect(page.getByTestId('projects-page')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  // Desktop's shared chrome installer marks the mounted toolbar after page load.
  await page.locator('.dinkster-window-toolbar-host').evaluate((bar) => { (bar as HTMLElement).dataset['platform'] = 'darwin' })
  await expect(page.locator('.left-sidebar .dinkster-brand-mark')).toBeVisible()
  await expect(page.locator('.dinkster-window-toolbar-brand .dinkster-brand-mark')).toHaveCount(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('heading', { name: project.name, exact: true }).waitFor()
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0)
  await page.screenshot({ path: evidencePath('issue-1304', 'macos-projects-stopped.png') })
  await page.getByRole('option').filter({ hasText: project.name }).click()
  await page.getByTestId('projects-open').click()
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-view', 'editor')
  await expect(page.getByTestId('redock-workflow')).toBeVisible()
  await expect(page.getByTestId('app-shell-page')).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await page.locator('.dinkster-window-toolbar-host').evaluate((bar) => { (bar as HTMLElement).dataset['platform'] = 'darwin' })
  await expect(page.locator('.left-sidebar .dinkster-brand-mark:visible')).toHaveCount(1)
  await expect(page.locator('.dinkster-window-toolbar-brand .dinkster-brand-mark')).toHaveCount(0)
  await page.evaluate(() => window.__dinksterTest!.app.shell.activityBarVisible.set(false))
  await expect(page.locator('.dinkster-window-toolbar-brand .dinkster-brand-mark:visible')).toHaveCount(1)
  await expect(page.locator('.left-sidebar')).toBeHidden()
  await page.screenshot({ path: evidencePath('issue-1304', 'macos-editor-hidden-icon-bar.png') })
  expect(errors).toEqual([])
})

test('cold project opening keeps its authoritative name while the engine refuses project reads', async ({ page }) => {
  let state = 'stopped'
  const root = '/installs/nightly'
  const projects = ['Bookshop diorama', 'Mountain lanterns'].map((name, index) => ({
    id: `scene-${index}`, uid: `48bb018e-5b17-4e68-bd81-c6412c4bcd7${index}`, name,
    created: '2026-01-01T00:00:00Z', revision: 1, deleted: false,
    packs: { extra: [] }, environment: null, accountProject: null,
  }))
  await page.route('**/supervisor/status', (route) => route.fulfill({ json: {
    protocol: 1, role: 'home', state, installations: 1,
    ...(state === 'stopped' ? {} : { open: { root, engine: 'main' } }),
  } }))
  await page.route('**/supervisor/installations', (route) => route.fulfill({ json: {
    installations: [{ root, frontend: { wire: 2, selected: null, available: true } }],
  } }))
  await page.route('**/supervisor/engine', (route) => {
    state = 'starting'
    return route.fulfill({ json: { protocol: 1, role: 'home', state, open: { root, engine: 'main' } } })
  })
  await page.route('**/supervisor/setup**', (route) => route.fulfill({ json: { activeJob: null } }))
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    const project = projects.find((project) => path === `/api/projects/${project.id}`)
    if (path === '/api/projects') return route.fulfill({ json: { items: projects, cursor: null } })
    if (project && state !== 'starting') return route.fulfill({ json: { project } })
    if (path === '/api/nodes' && state === 'ready') return route.fulfill({ json: {
      schemaVersion: 1, epoch: 1, dinkster: { version: 'cold-open', schemaWire: 2 }, nodes: {},
    } })
    return route.fulfill({ status: 503, json: { error: 'engine-not-ready', state } })
  })
  await page.addInitScript(() => {
    const names: string[] = []
    new MutationObserver(() => {
      if (!document.querySelector('[data-testid="app-shell-editor"] [data-testid="learn-toggle"]')) return
      const name = document.querySelector('[data-testid="app-shell-editor"] .dinkster-project-name')?.textContent ?? ''
      if (names.at(-1) !== name) names.push(name)
      document.documentElement.dataset.editorProjectNames = JSON.stringify(names)
    }).observe(document, { childList: true, subtree: true })
  })

  await page.goto('/')
  await page.getByRole('option').filter({ hasText: 'Bookshop diorama' }).click()
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-view', 'editor')
  await expect(page.locator('html')).toHaveAttribute('data-editor-project-names', '["Bookshop diorama"]')
  expect(await page.evaluate(async () => (await fetch('/api/projects/scene-0')).status)).toBe(503)
  await expect(page.getByTestId('app-shell-page')).toHaveCount(0)
  await page.screenshot({ path: evidencePath('issue-1424', 'cold-open-named.png') })

  state = 'ready'
  await expect(page.getByTestId('engine-run-control')).toBeHidden({ timeout: 7000 })
  await expect(page.locator('.dinkster-project-name')).toHaveText('Bookshop diorama')
  await page.locator('.dinkster-project-name').click()
  await page.getByRole('menuitem', { name: 'All projects', exact: true }).click()
  await page.getByRole('option').filter({ hasText: 'Mountain lanterns' }).click()
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-view', 'editor')
  await expect(page.locator('html')).toHaveAttribute('data-editor-project-names', '["Bookshop diorama","Mountain lanterns"]')
  await expect(page.locator('.dinkster-project-name')).toHaveText('Mountain lanterns')
})

test('setup owns engine controls until its registered installation has completed', async ({ page }) => {
  const root = '/install/nightly'
  const plan = {
    id: 'reviewed-plan', root, channel: 'nightly', variant: 'linux-cpu', buildLabel: 'CPU only',
    buildReason: 'Does not use the graphics card and is much slower.', engineRelease: 'release', baseId: 'base',
    detectedCards: [], choices: [], gpus: [], downloadBytes: 2048, runtimeDownloadBytes: 2048,
    freeBytes: 9000, refusal: null,
  }
  let installations = 0
  let job = {
    id: 'setup-job', root, channel: 'nightly', variant: 'linux-cpu', state: 'running',
    progress: null, error: null, installation: null as null | { root: string; engine: string },
  }
  await page.route('**/supervisor/status', (route) => {
    return route.fulfill({ json: { protocol: 1, role: 'home', state: 'stopped', installations } })
  })
  await page.route('**/supervisor/installations', (route) => route.fulfill({ json: {
    installations: installations ? [{ root }] : [],
  } }))
  await page.route('**/supervisor/setup**', (route) => route.fulfill({ json:
    route.request().url().includes('/setup/setup-job') ? job : { plan, activeJob: job },
  }))
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: {
    error: 'engine-not-ready', state: 'stopped', status: '/supervisor/status',
  } }))

  await page.goto('/?dinksterProject=default')
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  const registered = page.waitForResponse((response) => response.url().endsWith('/supervisor/status') && response.ok())
  installations = 1
  expect((await (await registered).json()).installations).toBe(1)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))
  await expect(page.getByTestId('status-connection')).toContainText('setting up')
  await expect(page.getByTestId('engine-run-control')).toBeHidden()
  await expect(page.getByTestId('engine-restart')).toBeHidden()
  await expect(page.getByTestId('engine-banner')).toBeHidden()
  await expect(page.getByText('Setting up Dinkster', { exact: true })).toBeVisible()
  await page.screenshot({ path: evidencePath('issue-1364', 'editor-registered-running.png') })

  job = { ...job, state: 'cancelling' }
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
  await expect(page.getByTestId('status-connection')).toContainText('setting up')
  await expect(page.getByTestId('engine-restart')).toBeHidden()

  job = { ...job, state: 'completed', installation: { root, engine: 'main' } }
  await expect(page.getByTestId('setup-form')).toBeHidden()
  await expect(page.getByTestId('engine-start')).toBeVisible()
  await page.screenshot({ path: evidencePath('issue-1364', 'editor-completed-stopped.png') })
})

test('a post-ready engine death surfaces restart and returns to ready', async ({ page }) => {
  let state: 'ready' | 'failed' | 'starting' = 'ready'
  let probes = 0
  let restarts = 0
  await page.route('**/supervisor/status', (route) => {
    probes += 1
    void route.fulfill({ json: {
      protocol: 1,
      state,
      ...(state === 'failed' ? { detail: 'engine exited with code 3', engine: { exitCode: 3 } } : {}),
    } })
  })
  await page.route('**/supervisor/engine/restart', async (route) => {
    restarts += 1
    state = 'starting'
    await route.fulfill({ status: 202 })
    setTimeout(() => { state = 'ready' }, 100)
  })
  await page.route('**/supervisor/engine/log', (route) => route.fulfill({ json: {
    available: true, text: 'Earlier engine output\n'.repeat(180) + 'Final engine failure', truncated: true,
  } }))
  await page.route('**/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'desktop-recovery-test', schemaWire: 2 },
    nodes: {},
  } }))
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }))

  await page.goto('/')
  await expect.poll(() => probes).toBeGreaterThan(0)
  const editor = page.locator('.canvas-stage').first()
  await expect(editor).toBeVisible()
  const readyBounds = await editor.boundingBox()
  state = 'failed'

  const engine = page.getByTestId('engine-run-control')
  await expect(engine).toHaveAttribute('data-state', 'failed', { timeout: 7000 })
  await expect(page.getByTestId('engine-banner')).toHaveCount(0)
  expect(await editor.boundingBox()).toEqual(readyBounds)
  const failureColors = await page.getByTestId('status-connection').evaluate((element) => ({
    words: getComputedStyle(element).color,
    dot: getComputedStyle(element.querySelector('.status-connection-dot')!).backgroundColor,
    actionWords: getComputedStyle(document.querySelector('[data-testid="engine-failed"]')!).color,
    actionFace: getComputedStyle(document.querySelector('[data-testid="engine-failed"]')!).backgroundColor,
    restart: getComputedStyle(document.querySelector('[data-testid="engine-restart"]')!).backgroundColor,
  }))
  expect(failureColors.words).toBe('rgb(255, 116, 104)')
  expect(failureColors.dot).toBe(failureColors.words)
  expect(failureColors.actionWords).toBe(failureColors.words)
  expect(failureColors.actionFace).toBe('rgb(20, 28, 29)')
  expect(failureColors.restart).toBe('rgb(30, 41, 42)')
  await page.getByTestId('engine-failed').click()
  await expect(page.getByRole('dialog', { name: 'Engine failed' })).toContainText('Engine exited with code 3')
  await page.screenshot({ path: evidencePath('issue-92', 'desktop-engine-recovery.png'), fullPage: true })
  await page.getByRole('button', { name: 'Show log', exact: true }).click()
  const log = page.getByTestId('engine-log-content')
  await expect.poll(() => log.evaluate((element) => element.scrollTop > 0 && element.scrollHeight - element.scrollTop - element.clientHeight <= 1)).toBe(true)
  const dialog = page.getByRole('dialog', { name: 'Engine log', exact: true })
  const heading = dialog.getByRole('heading', { name: 'Engine log', exact: true })
  const headingBounds = await heading.boundingBox()
  await log.evaluate((element) => { element.scrollTop = 0 })
  expect(await heading.boundingBox()).toEqual(headingBounds)
  expect(await dialog.evaluate((element) => element.scrollTop)).toBe(0)
  const dialogBounds = (await dialog.boundingBox())!
  expect(dialogBounds.width).toBe(Math.min(960, page.viewportSize()!.width - 32))
  expect(dialogBounds.x).toBeGreaterThanOrEqual(16)
  expect(dialogBounds.y).toBeGreaterThanOrEqual(16)
  expect(dialogBounds.y + dialogBounds.height).toBeLessThanOrEqual(page.viewportSize()!.height - 16)
  await page.keyboard.press('Escape')
  await page.getByTestId('engine-restart').click()
  await expect.poll(() => restarts).toBe(1)
  await expect(engine).toHaveCount(0, { timeout: 7000 })
  await expect(page.getByTestId('queue-button')).toBeVisible()
  expect(await editor.boundingBox()).toEqual(readyBounds)
  expect(state).toBe('ready')
})

test('with no engine open the status bar and Run say so until an engine opens', async ({ page }) => {
  let status: Record<string, unknown> = { protocol: 1, state: 'stopped', role: 'home', installations: 1 }
  await page.route('**/supervisor/status', (route) => route.fulfill({ json: status }))
  await page.route('**/supervisor/installations', (route) => route.fulfill({ json: { installations: [{ root: '/installs/a' }] } }))
  await page.route('**/supervisor/setup**', (route) => route.fulfill({ json: { activeJob: null } }))
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'engine-not-ready', state: 'stopped', status: '/supervisor/status' } }))
  await page.route('**/api/projects/default', (route) => route.fulfill({ json: { project: {
    id: 'default', uid: '48bb018e-5b17-4e68-bd81-c6412c4bcd72', name: 'Bookshop diorama',
    created: '2026-01-01T00:00:00Z', revision: 1, deleted: false,
    packs: { extra: [] }, environment: null, accountProject: null,
  } } }))
  await page.addInitScript(() => {
    const firstShell = new MutationObserver(() => {
      if (!document.querySelector('[data-testid="learn-toggle"]')) return
      document.documentElement.dataset.firstProjectName = document.querySelector('.dinkster-project-name')?.textContent ?? ''
      firstShell.disconnect()
    })
    firstShell.observe(document, { childList: true, subtree: true })
  })

  await page.goto('/?dinksterProject=default')
  await expect(page.locator('html')).toHaveAttribute('data-first-project-name', 'Bookshop diorama')
  await expect(page.getByTestId('learn-toggle')).toBeVisible()
  const connection = page.getByTestId('status-connection')
  await expect(connection).toHaveAttribute('data-state', 'no-engine')
  await expect(connection).toHaveAttribute('aria-label', 'Local: No engine is running')
  await expect(connection).toContainText('No engine is running')
  await expect(page.getByTestId('status-bar')).not.toContainText('Loading schemas')
  await expect(page.getByTestId('engine-start')).toHaveText('Start engine')
  expect(await page.getByTestId('engine-start').evaluate((element) => ({
    face: getComputedStyle(element).backgroundColor,
    words: getComputedStyle(element).color,
  }))).toEqual({ face: 'rgb(20, 28, 29)', words: 'rgb(50, 230, 165)' })
  await expect(page.getByTestId('queue-button')).toHaveCount(0)
  await expect(page.getByTestId('workflow-queue-toggle')).toBeVisible()

  status = { protocol: 1, state: 'starting', role: 'home', installations: 1, open: { root: '/installs/a', engine: 'main' } }
  await expect(connection).not.toHaveAttribute('data-state', 'no-engine', { timeout: 7000 })
  await expect(page.getByTestId('engine-run-control')).toContainText('Starting engine')
  await expect(page.getByTestId('workflow-queue-toggle')).toBeVisible()
  await expect(page.locator('.dinkster-project-name')).toHaveText('Bookshop diorama')
  await expect(page.getByTestId('learn-toggle')).toBeVisible()
  await expect(connection).toContainText('Dinkster is starting...')
  await expect(page.getByTestId('status-bar')).not.toContainText('Loading schemas')
})
