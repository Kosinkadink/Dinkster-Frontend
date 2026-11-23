import { expect, nativeTest as test, waitForWorkspaceReady } from './fixtures.js'


test('save destination writes the selected relative prefix through the real backend', async ({ page, request }, testInfo) => {
  const mountsResponse = await request.get(`${process.env['DINKSTER_NATIVE_BACKEND']}/api/mounts`)
  expect(mountsResponse.ok()).toBe(true)
  const settings = await mountsResponse.json() as { mounts: Array<{ id: string; mode: string; state: string }> }
  const writable = settings.mounts.filter((mount) => mount.mode === 'readwrite' && mount.state === 'ready')
  expect(writable.length).toBeGreaterThan(0)
  const chosenMount = writable[writable.length - 1]!.id
  await page.goto('/')
  await expect(page.getByTestId('status-connection')).toHaveAttribute('data-state', 'connected', { timeout: 20_000 })
  await waitForWorkspaceReady(page)
  await page.evaluate(async () => {
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'save-target-live', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Save destination', nodes: {
        gradient: { id: 'gradient', type: 'dev.image.gradient', values: { width: 3, height: 2 } },
        save: { id: 'save', type: 'dev.image.save_pgm', values: {} },
        gallery: { id: 'gallery', type: 'dev.gallery.assets', values: {} },
      }, links: { image: { id: 'image', from: { node: 'gradient', port: 'image' }, to: { node: 'save', port: 'image' } } }, nets: {}, reroutes: {}, nextOrdinal: 4 } },
      view: { graphs: { g0: { nodes: {
        gradient: { position: { x: 40, y: 100 } }, save: { position: { x: 420, y: 100 } }, gallery: { position: { x: 800, y: 100 } },
      } } } },
    } as never, 'Save destination')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  const open = async (id: string, inputId: string) => {
    const point = await page.evaluate(({ id, inputId }) => {
      const node = window.__dinksterTest!.renderer!.getScene().nodes.find((entry) => entry.id === id)!
      const row = node.layout.rows.find((entry) => entry.kind === 'widget' && entry.inputId === inputId)!
      const bounds = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      return { x: bounds.left + node.x + node.layout.width / 2, y: bounds.top + node.y + row.y + row.height / 2 }
    }, { id, inputId })
    await page.mouse.click(point.x, point.y)
    await expect(page.locator('.widget-in-row-field .dinkster-canvas-target-box')).toBeVisible()
  }
  const capture = async (name: string) => {
    const path = testInfo.outputPath(`${name}.png`)
    await page.locator('.widget-in-row-field').screenshot({ path })
    await testInfo.attach(name, { path, contentType: 'image/png' })
  }
  await open('save', 'target')
  await expect(page.locator('[data-editor-mode="raw"]')).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get().filter((problem) => problem.message.includes('SAVE_TARGET')))).toEqual([])
  const mount = page.locator('.dinkster-canvas-target-choice')
  await expect(mount).toHaveAttribute('data-state', 'ready')
  await expect(page.getByRole('button', { name: 'Clear destination' })).toHaveCount(0)
  await capture('save-target-default')
  await mount.click()
  await page.getByRole('listbox', { name: 'Writable mount' }).getByRole('option', { name: chosenMount, exact: true }).click()
  await expect(mount).toContainText(chosenMount)
  await page.getByRole('textbox', { name: 'Relative filename prefix' }).fill('../escape')
  await expect(page.getByRole('textbox', { name: 'Relative filename prefix' })).toHaveAttribute('aria-invalid', 'true')
  await capture('save-target-invalid')
  const prefix = `editor-proof/session-${Date.now()}`
  await page.getByRole('textbox', { name: 'Relative filename prefix' }).fill(prefix)
  await capture('save-target-edited')
  const before = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.save!.values)
  await page.keyboard.press('Enter')
  await expect(page.locator('.widget-in-row-field')).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.save!.values.target)).toEqual({ mount: chosenMount, prefix })
  await page.evaluate(async () => { const app = window.__dinksterTest!.app; await app.queueSelection(app.activeTab()!, ['save']) })
  await expect(page.getByTestId('execution-row').first().locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
  const result = await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const execution = [...app.store.executions.get().values()].sort((a, b) => b.queuedAt - a.queuedAt)[0]!
    const artifact = execution.artifact as typeof execution.artifact & { provenance: { toSource: Record<string, string>; outputAliases?: Record<string, Record<string, string>> } }
    const runtimeId = Object.keys(artifact.provenance.toSource).find((id) => artifact.provenance.toSource[id] === 'save')!
    const backend = app.backendForTab(app.activeTab()!)
    if (backend.protocol !== 'dinkster') throw new Error('Expected native backend')
    const values = (backend.connection as unknown as import('@dinkster/client').DinksterConnection).values()
    return Promise.all(['path', 'digest'].map(async (output) => {
      const peek = await values.peek({ jobId: execution.ref.prompt, nodeId: runtimeId, outputId: artifact.provenance.outputAliases?.[runtimeId]?.[output] ?? output })
      if (!peek.available) throw new Error('Saved output unavailable')
      return peek.descriptor.value
    }))
  })
  expect(result[0]).toMatch(new RegExp(`^mounts/${chosenMount}/${prefix}_\\d+\\.pgm$`))
  expect(result[1]).toBe('blake3:e406c3047d1c2460457e21d4a3efde41e812eb249fc80646ed5a4761d22b4da8')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.save!.values)).toEqual(before)
  // Project default stores the name without a mount.
  await open('gallery', 'destination')
  await mount.click()
  await page.getByRole('listbox', { name: 'Writable mount' }).getByRole('option').first().click()
  await expect(mount).toContainText('Project default')
  await page.getByRole('textbox', { name: 'Relative filename prefix' }).fill('gallery/proof')
  await capture('save-target-project-default')
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.gallery!.values.destination)).toEqual({ prefix: 'gallery/proof' })
})
