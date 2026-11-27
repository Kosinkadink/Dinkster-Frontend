import { expect, nativeTest as test, selectProductOption } from './fixtures.js'

test('served dev blueprint copies its graph independently and undoes as one insertion', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()
    .some((backend) => backend.registry.get()?.schemas.has('dev.features.slot')))).toBe(true)
  const openTemplate = () => page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get().find((item) => item.registry.get()?.schemas.has('dev.features.slot'))!
    return app.openTemplate('dinkster-nodes-dev', 'node-features', 'Node Feature Examples', backend.id)
  })
  expect(await openTemplate()).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .some((node) => node.id === 'slot'))).toBe(true)
  const document = () => page.evaluate(() => structuredClone(window.__dinksterTest!.app.activeTab()!.store.doc))
  const before = await document()
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 0.5 }))
  await page.getByTestId('graph-canvas').dblclick({ position: { x: 600, y: 500 } })
  await page.getByTestId('palette-search').fill('Node Feature Examples')
  await page.locator('.dinkster-search-row').filter({ hasText: 'Node Feature Examples' }).click()
  await page.getByTestId('graph-canvas').click({ position: { x: 600, y: 500 } })
  await expect.poll(async () => Object.keys((await document()).graphs).length).toBe(2)
  const inserted = await document()
  const id = Object.keys(inserted.graphs).find((key) => key !== inserted.root)!
  const copy = inserted.graphs[id]!
  expect(Object.keys(inserted.graphs.root!.nodes)).toHaveLength(9)
  expect(Object.keys(copy.nodes)).toHaveLength(8)
  expect(copy.boundary).toEqual({ body: [] })
  expect(copy.nodes).toEqual(before.graphs.root!.nodes)
  expect(copy.links.image).toEqual({
    id: 'image', from: { node: 'source', port: 'image' }, to: { node: 'mirror', port: 'image' },
  })
  expect(Object.values(inserted.graphs.root!.nodes).filter((node) => node.type === `#${id}`)).toHaveLength(1)
  await page.screenshot({ path: testInfo.outputPath('blueprint-inserted.png') })

  expect(await page.evaluate(async (graphId) => {
    const app = window.__dinksterTest!.app
    return (await app.dispatchTo(app.activeTab()!, { command: 'node.setValue', params: {
      graphId, nodeId: 'mirror', inputId: 'gain', value: 1.75,
    } })).ok
  }, id)).toBe(true)
  const edited = await document()
  expect(edited.graphs[id]!.nodes.mirror!.values!.gain).toBe(1.75)
  expect(edited.graphs.root!.nodes.mirror!.values!.gain).toBe(0.5)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  await expect.poll(async () => (await document()).graphs[id]!.nodes.mirror!.values!.gain).toBe(0.5)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  await expect.poll(async () => Object.keys((await document()).graphs).length).toBe(1)
  const undone = await document()
  expect({ ...undone.graphs.root, actorCursors: undefined })
    .toEqual({ ...before.graphs.root, actorCursors: undefined })
  await page.screenshot({ path: testInfo.outputPath('blueprint-undone.png') })
  expect(await openTemplate()).toBe(true)
  await expect.poll(async () => Object.keys((await document()).graphs.root!.nodes).length).toBe(8)
  expect((await document()).graphs.root).toEqual(before.graphs.root)
  await page.screenshot({ path: testInfo.outputPath('blueprint-template-reopened.png') })
})

test('a saved blueprint is detached, placeable, renameable and removable without changing placed subgraphs', async ({ page, context }, testInfo) => {
  const name = `Image helpers ${Date.now().toString(36)}`
  const renamed = `${name} renamed`
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()
    .map((backend) => ({ state: backend.schemaState.get(), ready: backend.registry.get()?.schemas.has('dev.features.slot') }))))
    .toEqual(expect.arrayContaining([expect.objectContaining({ ready: true })]))
  const backendUrl = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
  const fixtureResponse = await page.request.get(`${backendUrl}/api/packs/dinkster-nodes-dev/blueprints/node-features`)
  expect(fixtureResponse.ok()).toBe(true)
  const blueprint = await fixtureResponse.text()
  expect(await page.evaluate(async ({ name, blueprint }) => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get().find((item) => item.registry.get()?.schemas.has('dev.features.slot'))!
    const doc = JSON.parse(blueprint) as import('@dinkster/core').WorkflowDocument
    const body = doc.root
    const root = 'saved-blueprint-test-root'
    const diagnostics = await app.openDocument({
      ...doc, root, lineage: `saved-${name}`,
      graphs: {
        ...doc.graphs,
        [body]: { ...doc.graphs[body]!, name, boundary: { body: [] } },
        [root]: {
          id: root, name: 'Blueprint independence', nodes: { source: { id: 'source', type: `#${body}`, values: {} } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
        },
      },
      view: { ...doc.view, graphs: {
        ...doc.view.graphs,
        [root]: { nodes: { source: { position: { x: 160, y: 160 } } } },
      } },
    }, 'Blueprint independence')
    app.setTabTarget(app.activeTab()!.id, backend.id)
    return diagnostics
  }, { name, blueprint })).toEqual([])
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .some((node) => node.id === 'source'))).toBe(true)
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'source')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + node.x + node.layout.width / 2, y: canvas.top + node.y + node.layout.headerHeight / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await page.mouse.click(point.x, point.y, { button: 'right' })
  const save = page.locator('[data-testid=context-menu-item][data-item-id="core.subgraph.saveBlueprint"]')
  await expect(save).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('saved-blueprint-menu.png') })
  const status = page.getByTestId('status-bar')
  const statusBefore = await status.textContent()
  const connectionBefore = await page.getByTestId('status-connection').boundingBox()
  const created = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/library' && response.request().method() === 'POST')
  await save.click()
  const response = await Promise.race([
    created,
    page.waitForFunction(() => window.__dinksterTest!.app.problems.get().some((item) => item.severity === 'error')).then(async () => {
      throw new Error(JSON.stringify(await page.evaluate(() => window.__dinksterTest!.app.problems.get())))
    }),
  ])
  expect(response.status()).toBe(201)
  const record = await response.json() as { id: string; digest: string; project: string }
  expect(record.project).toBe('default')
  await expect(page.locator('.dinkster-toast')).toHaveText(`Saved blueprint ${name}`)
  await page.screenshot({ path: testInfo.outputPath('saved-blueprint-saved.png') })
  expect(await status.textContent()).toBe(statusBefore)
  expect(await page.getByTestId('status-connection').boundingBox()).toEqual(connectionBefore)
  await expect(status.locator('.transient-status')).toHaveCount(0)
  const bodyResponse = await page.request.get(`${backendUrl}/api/assets/${record.digest}`)
  expect(bodyResponse.ok()).toBe(true)
  const saved = await bodyResponse.json()
  expect(saved.graphs[saved.root].nodes.mirror.values.gain).toBe(0.5)
  expect(await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const body = tab.store.doc.graphs[tab.store.doc.root]!.nodes.source!.type.slice(1)
    return (await app.dispatchTo(tab, { command: 'node.setValue', params: {
      graphId: body, nodeId: 'mirror', inputId: 'gain', value: 1.75,
    } })).ok
  })).toBe(true)
  expect(await (await page.request.get(`${backendUrl}/api/assets/${record.digest}`)).json()).toEqual(saved)

  const canvas = page.getByTestId('graph-canvas')
  await canvas.focus()
  await page.keyboard.press('Control+k')
  const search = page.getByTestId('universal-search-input')
  const blueprints = page.locator('[data-group="core.blueprints"]')
  await search.fill('Node Feature Examples')
  await expect(blueprints.getByRole('option', { name: /Node Feature Examples/ })).toBeVisible()
  await search.fill(name)
  const savedResult = blueprints.getByRole('option', { name: new RegExp(name) })
  await expect(savedResult).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('saved-blueprint-ctrl-k.png') })
  await savedResult.click()
  await canvas.click({ position: { x: 650, y: 400 } })
  await expect.poll(() => page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.keys(doc.graphs[doc.root]!.nodes).length
  })).toBe(2)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  await canvas.dblclick({ position: { x: 650, y: 400 } })
  await page.getByTestId('palette-search').fill(name)
  const result = page.getByTestId('node-palette').locator(`[role=option][data-key="entry:blueprint:saved/${record.id}"]`)
  await expect(result).toContainText(name)
  await expect(result).toHaveCount(1)
  await page.screenshot({ path: testInfo.outputPath('saved-blueprint-search.png') })
  await result.click()
  await canvas.click({ position: { x: 650, y: 400 } })
  await expect.poll(() => page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.keys(doc.graphs[doc.root]!.nodes).length
  })).toBe(2)
  const placed = await page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    const root = doc.graphs[doc.root]!
    const added = Object.values(root.nodes).find((node) => node.id !== 'source')!
    return {
      type: added.type,
      original: doc.graphs[root.nodes.source!.type.slice(1)]!.nodes.mirror!.values!.gain,
      inserted: doc.graphs[added.type.slice(1)]!.nodes.mirror!.values!.gain,
    }
  })
  expect(placed.original).toBe(1.75)
  expect(placed.inserted).toBe(0.5)

  await page.keyboard.press('Control+c')
  await page.mouse.move(point.x + 300, point.y + 300)
  await page.keyboard.press('Control+v')
  await expect.poll(() => page.evaluate((type) => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.values(doc.graphs[doc.root]!.nodes).filter((node) => node.type === type).length
  }, placed.type)).toBe(2)
  expect(await page.evaluate(async (type) => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const nodeId = [...window.__dinksterTest!.controller!.getSelection()][0]!
    const outcome = await app.dispatchTo(tab, { command: 'occurrence.localize', params: {
      graphId: tab.store.doc.root, nodeId,
    } })
    const copy = tab.store.doc.graphs[tab.store.doc.root]!.nodes[nodeId]!
    return { ok: outcome.ok, independent: copy.type !== type,
      gain: tab.store.doc.graphs[copy.type.slice(1)]!.nodes.mirror!.values!.gain }
  }, placed.type)).toEqual({ ok: true, independent: true, gain: 0.5 })

  await page.getByTestId('library-toggle').click()
  const library = page.getByTestId('library-overlay')
  const source = library.locator('[data-testid=collection-source][data-source=blueprints]')
  if (await source.isVisible()) await source.click()
  else await selectProductOption(page, library.getByTestId('library-source-select'), 'blueprints')
  await library.getByTestId('collection-entry').filter({ hasText: name }).click()
  await expect(library.getByTestId('collection-details')).toHaveCount(0)
  const remove = library.locator('[data-testid=collection-action][data-action=remove]')
  await expect(remove).toHaveCSS('color', 'rgb(255, 116, 104)')
  await expect.poll(() => remove.evaluate((button) => getComputedStyle(button).borderColor))
    .toMatch(/^rgba?\(255, 116, 104(?:, 0\.\d+)?\)$/)
  await page.screenshot({ path: testInfo.outputPath('saved-blueprint-library.png') })
  await library.locator('[data-testid=collection-action][data-action=rename]').click()
  await page.getByTestId('library-rename-input').fill(renamed)
  await page.screenshot({ path: testInfo.outputPath('saved-blueprint-rename.png') })
  await page.getByTestId('library-rename-input').press('Enter')
  const row = library.getByTestId('collection-entry').filter({ hasText: renamed })
  await expect(row).toHaveCount(1)
  await page.getByTestId('library-toggle').click()
  await expect(library).not.toBeVisible()
  await canvas.dblclick({ position: { x: 650, y: 550 } })
  await page.getByTestId('palette-search').fill(renamed)
  await expect(result).toContainText(renamed)
  await page.keyboard.press('Escape')
  await canvas.focus()
  await page.keyboard.press('Control+k')
  await search.fill(renamed)
  await expect(savedResult).toContainText(renamed)
  await page.keyboard.press('Escape')
  await page.getByTestId('library-toggle').click()
  if (await source.isVisible()) await source.click()
  else await selectProductOption(page, library.getByTestId('library-source-select'), 'blueprints')
  await row.click()
  await library.locator('[data-testid=collection-action][data-action=remove]').click()
  const confirm = page.getByRole('button', { name: 'Remove blueprint', exact: true })
  await expect(confirm).toBeVisible()
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('saved-blueprint-remove.png') })
  expect((await page.request.get(`${backendUrl}/api/library/${record.id}?scope=local`)).ok()).toBe(true)
  await confirm.click()
  await expect(row).toHaveCount(0)
  await page.getByTestId('library-toggle').click()
  await expect(library).not.toBeVisible()
  await canvas.dblclick({ position: { x: 650, y: 550 } })
  await page.getByTestId('palette-search').fill(renamed)
  await expect(result).toHaveCount(0)
  await page.keyboard.press('Escape')
  await canvas.focus()
  await page.keyboard.press('Control+k')
  await search.fill(renamed)
  await expect(savedResult).toHaveCount(0)
  expect(await page.evaluate((type) => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.values(doc.graphs[doc.root]!.nodes).some((node) => node.type === type)
  }, placed.type)).toBe(true)
})
