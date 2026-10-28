import { expect, nativeTest as test } from './fixtures.js'

test('native source choices preserve names, cancel, unavailable values and backend failures', async ({ page }, testInfo) => {
  let fail = false
  const queries: string[] = []
  await page.route('/api/**', (route) => route.fulfill({ status: 503 }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'source-choice-contract', schemaWire: 1 },
    nodes: { SourceChoice: { schemaVersion: 1, displayName: 'Source choice', interface: [
      { role: 'input', id: 'source', type: { kind: 'concrete', types: ['COMBO'] }, default: 'old/source', widget: { type: 'ASSET', accept: [], kind: 'directory/dataset', selection: true } },
    ] } },
  } }))
  await page.route('/api/assets/selections*', (route) => {
    queries.push(route.request().url())
    return fail ? route.fulfill({ status: 503 }) : route.fulfill({ json: { kind: 'directory/dataset', options: [
      { name: 'datasets/portraits', shape: 'directory' }, { name: 'datasets/landscapes', shape: 'directory' },
    ] } })
  })
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('1 node schemas')
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'source-choice', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { source: { id: 'source', type: 'SourceChoice', values: { source: 'old/source' } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: { g0: { nodes: { source: { position: { x: 100, y: 100 } } } } } },
    }, 'Source choices')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  const value = () => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.source!.values.source)
  const open = async () => {
    const point = await page.evaluate(() => {
      const renderer = window.__dinksterTest!.renderer!
      const node = renderer.getScene().nodes.find((node) => node.id === 'source')!
      const row = node.layout.rows.find((row) => row.kind === 'widget')!
      const viewport = renderer.getViewport()
      const rect = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
      return { x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x, y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y }
    })
    await page.mouse.click(point.x, point.y)
    await expect(page.getByTestId('asset-selection-editor')).toBeVisible()
  }
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(1)
  await open()
  await expect(page.getByTestId('asset-selection-choice')).toHaveText('old/source (unavailable)')
  await expect(page.getByTestId('asset-selection-apply')).toBeDisabled()
  await page.getByTestId('asset-selection-choice').click()
  await expect(page.getByRole('option')).toHaveText(['old/source (unavailable)', 'datasets/portraits', 'datasets/landscapes'])
  await page.screenshot({ path: testInfo.outputPath('source-choice-options.png') })
  await page.locator('[data-option-id="datasets/landscapes"]').click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await value()).toBe('old/source')
  await open()
  await page.getByTestId('asset-selection-choice').click()
  await page.locator('[data-option-id="datasets/portraits"]').click()
  await page.getByTestId('asset-selection-apply').click()
  expect(await value()).toBe('datasets/portraits')
  expect(new URL(queries[0]!).searchParams.get('kind')).toBe('directory/dataset')
  expect(new URL(queries[0]!).searchParams.get('project')).toBe('default')
  await open()
  await expect(page.getByTestId('asset-selection-apply')).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('source-choice-ready.png') })
  await page.keyboard.press('Escape')
  fail = true
  await open()
  await expect(page.getByTestId('asset-selection-editor')).toContainText('Source choices are unavailable')
  await expect(page.getByTestId('asset-selection-apply')).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('source-choice-error.png') })
  await page.keyboard.press('Escape')
  expect(await value()).toBe('datasets/portraits')
})

test('VAE source picker preserves file identity and rejects closed-editor and stale-schema replies', async ({ page }, testInfo) => {
  const asset = { digest: `blake3:${'a'.repeat(64)}`, name: 'explicit.vae', size: 42, mediaType: 'application/octet-stream', virtualPath: 'mounts/vae/explicit.vae' }
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let releaseStale!: () => void
  const staleGate = new Promise<void>((resolve) => { releaseStale = resolve })
  let mode: 'closed' | 'ready' | 'stale' | 'new' = 'closed'
  let closedStarted = false
  let staleStarted = false
  await page.route('/api/**', (route) => route.fulfill({ status: 503 }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'vae-source-contract', schemaWire: 1 },
    nodes: { VaeSource: { schemaVersion: 1, displayName: 'VAE source', interface: [
      { role: 'input', id: 'source', type: { kind: 'union', types: ['COMBO', 'ASSET'] }, widget: { type: 'ASSET', accept: [], kind: 'model/vae', selection: true } },
    ] } },
  } }))
  await page.route('/api/assets/selections*', async (route) => {
    const requestMode = mode
    if (requestMode === 'closed') { closedStarted = true; await gate }
    if (requestMode === 'stale') { staleStarted = true; await staleGate }
    await route.fulfill({ json: { kind: 'model/vae', options: requestMode === 'closed'
      ? [{ name: 'late/retired.vae', shape: 'file' }]
      : requestMode === 'new' ? [{ name: 'new-epoch.vae', shape: 'file' }]
      : [{ name: 'pixel_space', shape: 'literal' }, { name: 'paired/taesd', shape: 'pair' }, { name: 'nested/new.vae', shape: 'file' }],
    } })
  })
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('1 node schemas')
  await page.evaluate((asset) => {
    window.__dinksterTest!.app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'vae-source', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { source: { id: 'source', type: 'VaeSource', values: { source: asset } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: { g0: { nodes: { source: { position: { x: 100, y: 100 } } } } } },
    }, 'VAE sources')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, asset)
  const value = () => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.source!.values.source)
  const open = async () => {
    const point = await page.evaluate(() => {
      const renderer = window.__dinksterTest!.renderer!
      const node = renderer.getScene().nodes.find((node) => node.id === 'source')!
      const row = node.layout.rows.find((row) => row.kind === 'widget')!
      const viewport = renderer.getViewport()
      const rect = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
      return { x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x, y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y }
    })
    await page.mouse.click(point.x, point.y)
    await expect(page.getByTestId('asset-selection-editor')).toBeVisible()
  }
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(1)
  await open()
  await expect.poll(() => closedStarted).toBe(true)
  await expect(page.getByTestId('asset-selection-choice')).toHaveText('explicit.vae')
  await expect(page.getByTestId('asset-selection-apply')).toBeDisabled()
  await page.keyboard.press('Escape')
  expect(await value()).toEqual(asset)
  mode = 'ready'
  await open()
  await page.getByTestId('asset-selection-choice').click()
  await expect(page.getByRole('option')).toHaveText(['explicit.vae', 'pixel_space', 'paired/taesd', 'nested/new.vae'])
  const late = page.waitForResponse((response) => response.url().includes('/api/assets/selections') && response.request().method() === 'GET')
  release()
  await late
  await expect(page.getByRole('option')).toHaveText(['explicit.vae', 'pixel_space', 'paired/taesd', 'nested/new.vae'])
  await page.screenshot({ path: testInfo.outputPath('vae-reference-and-source-options.png') })
  await page.locator('[data-option-id="paired/taesd"]').click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await value()).toEqual(asset)
  await open()
  await page.getByTestId('asset-selection-choice').click()
  await page.locator('[data-option-id="pixel_space"]').click()
  await page.getByTestId('asset-selection-apply').click()
  expect(await value()).toBe('pixel_space')
  mode = 'stale'
  await open()
  await expect.poll(() => staleStarted).toBe(true)
  await expect(page.getByTestId('asset-selection-apply')).toBeDisabled()
  mode = 'new'
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.refreshBackendSchemas(app.backendForTab(app.activeTab()!))
  })
  await page.getByTestId('asset-selection-choice').click()
  await expect(page.getByRole('option')).toHaveText(['pixel_space (unavailable)', 'new-epoch.vae'])
  const stale = page.waitForResponse((response) => response.url().includes('/api/assets/selections') && response.request().method() === 'GET')
  releaseStale()
  await stale
  await expect(page.getByRole('option')).toHaveText(['pixel_space (unavailable)', 'new-epoch.vae'])
  await expect(page.getByTestId('asset-selection-apply')).toBeDisabled()
  await page.locator('[data-option-id="new-epoch.vae"]').click()
  await page.getByTestId('asset-selection-apply').click()
  expect(await value()).toBe('new-epoch.vae')
})
