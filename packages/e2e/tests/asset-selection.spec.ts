import { expect, nativeTest as test, type Page } from './fixtures.js'

async function acknowledgeRetentions(page: Page): Promise<void> {
  await page.route('/api/library/retentions/document/*?scope=local', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 404 })
    const declaration = route.request().postDataJSON()
    return route.fulfill({ json: { ...declaration, scope: 'local', ownerKind: 'document',
      ownerId: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!), revision: declaration.revision + 1 } })
  })
}

for (const accepted of [true, false]) {
  test(`recorded widget draft waits for ownership: ${accepted ? 'accepted' : 'refused'}`, async ({ page }, info) => {
    let release!: () => void
    let started = false
    let uploaded: Buffer = Buffer.alloc(0)
    let playbackReads = 0
    const digest = `blake3:${'c'.repeat(64)}`
    const gate = new Promise<void>((resolve) => { release = resolve })
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
        const context = new AudioContext()
        const tone = context.createOscillator()
        const output = context.createMediaStreamDestination()
        tone.connect(output)
        tone.start()
        await context.resume()
        const track = output.stream.getAudioTracks()[0]!
        const stop = track.stop.bind(track)
        track.stop = () => { tone.stop(); void context.close(); stop() }
        return output.stream
      } })
    })
    await page.route('/api/**', (route) => route.fulfill({ status: 503 }))
    await page.route('/api/nodes*', (route) => route.fulfill({ json: {
      schemaVersion: 1, epoch: 1, dinkster: { version: 'recording-ownership', schemaWire: 1 },
      nodes: { Recorder: { schemaVersion: 1, displayName: 'Audio recording', interface: [
        { role: 'input', id: 'audio', type: { kind: 'concrete', types: ['AUDIO'] }, widget: { type: 'AUDIO_RECORD' } },
      ] } },
    } }))
    await page.route('/api/assets/media?*', (route) => {
      uploaded = route.request().postDataBuffer() ?? Buffer.alloc(0)
      return route.fulfill({ json: { kind: 'media/audio', asset: {
        digest, name: 'recording.webm', size: uploaded.length, mediaType: 'audio/webm', virtualPath: 'imports/recording.webm',
      } } })
    })
    await page.route(`/api/assets/${encodeURIComponent(digest)}`, (route) => {
      playbackReads++
      return route.fulfill({ contentType: 'audio/webm', body: uploaded })
    })
    await page.route('/api/library/retentions/document/*?scope=local', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 404 })
      const declaration = route.request().postDataJSON()
      if (declaration.digests.includes(digest)) {
        started = true
        await gate
        if (!accepted) return route.fulfill({ status: 503, body: 'ownership refused' })
      }
      return route.fulfill({ json: { ...declaration, scope: 'local', ownerKind: 'document',
        ownerId: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!), revision: declaration.revision + 1 } })
    })
    await page.goto('/')
    await expect(page.getByTestId('status-bar')).toContainText('1 node schemas')
    await page.evaluate(() => {
      window.__dinksterTest!.app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'recording-owner', root: 'g0',
        graphs: { g0: { id: 'g0', name: 'root', nodes: { source: { id: 'source', type: 'Recorder', values: { audio: null } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
        view: { graphs: { g0: { nodes: { source: { position: { x: 100, y: 100 } } } } } },
      }, 'Recording ownership')
      window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    })
    await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(1)
    const point = await page.evaluate(() => {
      const renderer = window.__dinksterTest!.renderer!
      const node = renderer.getScene().nodes[0]!
      const row = node.layout.rows.find((row) => row.kind === 'widget')!
      const viewport = renderer.getViewport()
      const rect = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
      return { x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x, y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y }
    })
    await page.mouse.click(point.x, point.y)
    const editor = page.getByTestId('audio-record-editor')
    await expect(editor).toBeVisible()
    await editor.getByRole('button', { name: 'Record microphone', exact: true }).click()
    await expect(editor.getByTestId('audio-recorded-bytes')).toHaveText(/Recorded [1-9][0-9]* bytes/)
    await editor.getByRole('button', { name: 'Stop recording', exact: true }).click()
    await editor.getByRole('button', { name: 'Save recording', exact: true }).click()
    await expect.poll(() => started).toBe(true)
    await expect(editor.getByRole('button', { name: 'Use asset', exact: true })).toBeDisabled()
    await expect(editor).not.toContainText('recording.webm')
    expect(playbackReads).toBe(0)
    await page.screenshot({ path: info.outputPath('recording-pending.png') })
    release()
    if (accepted) {
      await expect(editor).toContainText('recording.webm')
      await expect(editor.getByRole('button', { name: 'Use asset', exact: true })).toBeEnabled()
      await expect(editor.locator('audio')).toHaveCount(1)
      expect(playbackReads).toBe(1)
    } else {
      await expect(editor).toContainText('PUT retained assets failed: 503')
      await expect(editor).toContainText('Clip retained for retry')
      await expect(editor.locator('audio')).toHaveCount(0)
      expect(playbackReads).toBe(0)
    }
    await page.screenshot({ path: info.outputPath(`recording-${accepted ? 'accepted' : 'refused'}.png`) })
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.source!.values.audio)).toBeNull()
  })
}

for (const accepted of [true, false]) {
  test(`staged asset picker waits for ownership: ${accepted ? 'accepted' : 'refused'}`, async ({ page }, info) => {
    const asset = { digest: `blake3:${'b'.repeat(64)}`, name: 'chosen.vae', size: 42, mediaType: 'application/octet-stream', virtualPath: 'vae/chosen.vae' }
    let release!: () => void
    let started = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    await page.route('/api/**', (route) => route.fulfill({ status: 503 }))
    await page.route('/api/nodes*', (route) => route.fulfill({ json: {
      schemaVersion: 1, epoch: 1, dinkster: { version: 'picker-ownership', schemaWire: 1 },
      nodes: { Picker: { schemaVersion: 1, displayName: 'Asset picker', interface: [
        { role: 'input', id: 'source', type: { kind: 'concrete', types: ['ASSET'] }, widget: { type: 'ASSET', accept: [], kind: 'model/vae' } },
      ] } },
    } }))
    await page.route('/api/mounts', (route) => route.fulfill({ json: { mounts: [{ id: 'vae', mode: 'read', state: 'ready', kind: 'model/vae' }] } }))
    await page.route('/api/mounts/vae/entries*', (route) => route.fulfill({ json: { entries: [{ ...asset, kind: 'model/vae' }] } }))
    await page.route('/api/assets/catalog*', (route) => route.fulfill({ json: { assets: [] } }))
    await page.route('/api/mounts/locations*', (route) => route.fulfill({ json: { locations: [{ path: asset.virtualPath }] } }))
    await page.route('/api/library/retentions/document/*?scope=local', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 404 })
      const declaration = route.request().postDataJSON()
      if (declaration.digests.includes(asset.digest)) {
        started = true
        await gate
        if (!accepted) return route.fulfill({ status: 503, body: 'ownership refused' })
      }
      return route.fulfill({ json: { ...declaration, scope: 'local', ownerKind: 'document',
        ownerId: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!), revision: declaration.revision + 1 } })
    })
    await page.goto('/')
    await expect(page.getByTestId('status-bar')).toContainText('1 node schemas')
    await page.evaluate(() => {
      window.__dinksterTest!.app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'picker-owner', root: 'g0',
        graphs: { g0: { id: 'g0', name: 'root', nodes: { source: { id: 'source', type: 'Picker', values: { source: null } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
        view: { graphs: { g0: { nodes: { source: { position: { x: 100, y: 100 } } } } } },
      }, 'Picker ownership')
      window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    })
    await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(1)
    const point = await page.evaluate(() => {
      const renderer = window.__dinksterTest!.renderer!
      const node = renderer.getScene().nodes[0]!
      const row = node.layout.rows.find((row) => row.kind === 'widget')!
      const viewport = renderer.getViewport()
      const rect = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
      return { x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x, y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y }
    })
    await page.mouse.click(point.x, point.y)
    await page.getByTestId('collection-entry').filter({ hasText: 'chosen.vae' }).click()
    await expect.poll(() => started).toBe(true)
    await expect(page.getByTestId('asset-apply')).toBeDisabled()
    await expect(page.getByTestId('asset-selection-summary')).toContainText('Nothing selected')
    await page.screenshot({ path: info.outputPath('picker-pending.png') })
    release()
    if (accepted) {
      await expect(page.getByTestId('asset-selection-summary')).toContainText('chosen.vae')
      await expect(page.getByTestId('asset-apply')).toBeEnabled()
    } else {
      await expect(page.getByTestId('asset-editor')).toContainText('503')
      await expect(page.getByTestId('asset-selection-summary')).toContainText('Nothing selected')
    }
    await page.screenshot({ path: info.outputPath(`picker-${accepted ? 'accepted' : 'refused'}.png`) })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.source!.values.source)).toBeNull()
  })
}

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
  await acknowledgeRetentions(page)
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
  await expect(page.getByTestId('asset-selection-editor')).toContainText('old/source')
  await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toBeDisabled()
  await expect(page.locator('[data-entry="datasets/portraits"]')).toBeVisible()
  await expect(page.locator('[data-entry="datasets/landscapes"]')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('source-choice-options.png') })
  await page.locator('[data-entry="datasets/landscapes"]').click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await value()).toBe('old/source')
  await open()
  await page.locator('[data-entry="datasets/portraits"]').click()
  await page.getByRole('button', { name: 'Use selection', exact: true }).click()
  expect(await value()).toBe('datasets/portraits')
  expect(new URL(queries[0]!).searchParams.get('kind')).toBe('directory/dataset')
  expect(new URL(queries[0]!).searchParams.get('project')).toBe('default')
  await open()
  await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('source-choice-ready.png') })
  await page.keyboard.press('Escape')
  fail = true
  await open()
  await expect(page.getByTestId('asset-selection-editor')).toContainText('GET asset selections failed: 503')
  await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toBeDisabled()
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
  let closedFinished = false
  let staleFinished = false
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
    if (requestMode === 'closed') closedFinished = true
    if (requestMode === 'stale') staleFinished = true
  })
  await acknowledgeRetentions(page)
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
    const back = page.getByRole('button', { name: 'Back to source options', exact: true })
    if (await back.isVisible()) await back.click()
    await expect(page.getByTestId('asset-selection-editor')).toBeVisible()
  }
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(1)
  await open()
  await expect.poll(() => closedStarted).toBe(true)
  await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  expect(await value()).toEqual(asset)
  mode = 'ready'
  await open()
  await expect(page.locator('[data-entry="pixel_space"]')).toBeVisible()
  await expect(page.locator('[data-entry="paired/taesd"]')).toBeVisible()
  await expect(page.locator('[data-entry="nested/new.vae"]')).toBeVisible()
  release()
  await expect.poll(() => closedFinished).toBe(true)
  await expect(page.locator('[data-entry="late/retired.vae"]')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('vae-reference-and-source-options.png') })
  await page.locator('[data-entry="paired/taesd"]').click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await value()).toEqual(asset)
  await open()
  await page.locator('[data-entry="pixel_space"]').click()
  await page.getByRole('button', { name: 'Use selection', exact: true }).click()
  expect(await value()).toBe('pixel_space')
  mode = 'stale'
  await open()
  await expect.poll(() => staleStarted).toBe(true)
  await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toBeDisabled()
  mode = 'new'
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.refreshBackendSchemas(app.backendForTab(app.activeTab()!))
  })
  await expect(page.locator('[data-entry="new-epoch.vae"]')).toBeVisible()
  await expect(page.locator('[data-entry="pixel_space"]')).toHaveCount(0)
  releaseStale()
  await expect.poll(() => staleFinished).toBe(true)
  await expect(page.locator('[data-entry="new-epoch.vae"]')).toBeVisible()
  await expect(page.locator('[data-entry="pixel_space"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Use selection', exact: true })).toBeDisabled()
  await page.locator('[data-entry="new-epoch.vae"]').click()
  await page.getByRole('button', { name: 'Use selection', exact: true }).click()
  expect(await value()).toBe('new-epoch.vae')
})
