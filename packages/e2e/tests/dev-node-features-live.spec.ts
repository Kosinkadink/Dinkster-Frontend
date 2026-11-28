import { join } from 'node:path'
import type { Diagnostic } from '@dinkster/core'
import { expect, nativeTest as test, type Page, waitForWorkspaceReady } from './fixtures.js'

test('a late numeric lookup makes one shared correction and tells both viewers', async ({ page, browser }) => {
  await page.goto('/')
  await waitForWorkspaceReady(page)
  const peerContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
  const peer = await peerContext.newPage()
  let sharedTab: string | undefined
  let releaseLookup: (() => void) | undefined
  try {
    await peer.goto('/')
    await waitForWorkspaceReady(peer)
    expect(await page.evaluate(async () => {
      const app = window.__dinksterTest!.app
      app.settings.set('automaticFixes.numberOutsideLimits', 'ask')
      return app.openDocument({
        format: 'dinkster-workflow', formatVersion: 1, lineage: crypto.randomUUID(), root: 'g0',
        graphs: { g0: { id: 'g0', name: 'Late numeric limit', nodes: {
          picker: { id: 'picker', type: 'dev.lookups.lora_picker', values: {
            category_filter: 'All', strength: 4.25, frames: 8,
          } },
        }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
        view: { graphs: { g0: { nodes: { picker: { position: { x: 80, y: 100 } } } } } },
      }, 'Late numeric limit')
    })).toEqual([])
    const shared = await page.evaluate(async () => {
      const app = window.__dinksterTest!.app as NonNullable<typeof window.__dinksterTest>['app'] & {
        collabFor(tab: string): { descriptor: { sessionId: string } } | undefined
      }
      const error = await app.shareActiveTab()
      const tab = app.activeTab()!
      return { error, tab: tab.id, session: app.collabFor(tab.id)?.descriptor.sessionId }
    })
    expect(shared.error).toBeUndefined()
    sharedTab = shared.tab
    expect(shared.session).toBeTruthy()
    expect(await peer.evaluate(async (session) => {
      const app = window.__dinksterTest!.app as unknown as {
        settings: { set(key: string, value: string): void }
        joinCollabSession(id: string): Promise<string | undefined>
      }
      app.settings.set('automaticFixes.numberOutsideLimits', 'ask')
      return app.joinCollabSession(session)
    }, shared.session!)).toBeUndefined()
    for (const viewer of [page, peer]) {
      await expect.poll(() => viewer.evaluate(() => {
        const app = window.__dinksterTest!.app
        const backend = app.backends.get()[0]! as unknown as { lookups: Pick<import('@dinkster/client').LookupClient, 'entry'> }
        return backend.lookups.entry({ function: 'dinkster_nodes_dev.lookups.strength_limit', args: ['All'] })?.state
      })).toBe('ready')
      expect(await viewer.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.picker!.values.strength)).toBe(4.25)
    }
    const lookupReleased = new Promise<void>((resolve) => { releaseLookup = resolve })
    let lookupHeld = false
    await peer.route('**/api/lookups', async (route) => {
      const request = route.request()
      const body = request.method() === 'POST' ? request.postDataJSON() as { function?: string; args?: unknown } : undefined
      if (body?.function !== 'dinkster_nodes_dev.lookups.strength_limit' || JSON.stringify(body.args) !== '["sdxl"]') {
        await route.continue()
        return
      }
      // Hold the real answer until the other viewer's correction arrives first.
      const response = await route.fetch()
      const bytes = await response.body()
      lookupHeld = true
      await lookupReleased
      await route.fulfill({ response, body: bytes })
    })
    const beforeRevision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
    expect(await page.evaluate(async () => {
      const app = window.__dinksterTest!.app as NonNullable<typeof window.__dinksterTest>['app'] & {
        dispatchEditTo: NonNullable<typeof window.__dinksterTest>['app']['dispatchTo']
      }
      return (await app.dispatchEditTo(app.activeTab()!, {
        command: 'node.setValue', params: { graphId: 'g0', nodeId: 'picker', inputId: 'category_filter', value: 'sdxl' },
      })).ok
    })).toBe(true)
    await expect.poll(() => lookupHeld).toBe(true)
    for (const viewer of [page, peer]) {
      await expect.poll(() => viewer.evaluate(() => {
        const tab = window.__dinksterTest!.app.activeTab()!
        return { revision: tab.store.revision, strength: tab.store.doc.graphs.g0!.nodes.picker!.values.strength }
      })).toEqual({ revision: beforeRevision + 2, strength: 2 })
    }
    releaseLookup!()
    for (const viewer of [page, peer]) {
      await expect.poll(() => viewer.evaluate(() => {
        const app = window.__dinksterTest!.app
        const tab = app.activeTab()!
        return {
          revision: tab.store.revision,
          strength: tab.store.doc.graphs.g0!.nodes.picker!.values.strength,
          corrections: (app.adjustmentNotices.get().get(tab.id) as { adjustments: readonly { kind: string }[] } | undefined)
            ?.adjustments.filter((item) => item.kind === 'numberOutsideLimits').length ?? 0,
        }
      })).toEqual({ revision: beforeRevision + 2, strength: 2, corrections: 1 })
      await expect(viewer.getByTestId('fixes-notice')).toBeVisible()
    }
  } finally {
    releaseLookup?.()
    if (sharedTab !== undefined) {
      const error = await page.evaluate((tab) =>
        (window.__dinksterTest!.app as unknown as { endCollabSession(id: string): Promise<string | undefined> }).endCollabSession(tab), sharedTab)
      expect(error).toBeUndefined()
    }
    await peerContext.close()
  }
})

const proofDir = process.env['DINKSTER_FEATURE_PROOF_DIR']

async function pinPoint(page: Page, nodeId: string, portId: string, direction: 'in' | 'out') {
  return page.evaluate(({ nodeId, portId, direction }) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((item) => item.id === nodeId)!
    const pin = node.layout.pins.find((item) => item.portId === portId && item.direction === direction)!
    const viewport = renderer.getViewport()
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (node.x - viewport.x + (direction === 'out' ? node.layout.width : 0)) * viewport.scale,
      y: rect.top + (node.y - viewport.y + pin.y) * viewport.scale,
    }
  }, { nodeId, portId, direction })
}

test('required served slot can be cleared, reselected and execute a connected value', async ({ page, request }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()
    .some((backend) => backend.registry.get()?.schemas.has('dev.features.slot')))).toBe(true)
  expect(await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get().find((item) => item.registry.get()?.schemas.has('dev.features.slot'))!
    return app.openTemplate('dinkster-nodes-dev', 'node-features', 'Node Feature Examples', backend.id)
  })).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .some((node) => node.id === 'slot'))).toBe(true)
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))

  const source = await pinPoint(page, 'slot', 'source', 'in')
  await page.mouse.click(source.x, source.y, { button: 'right' })
  await page.locator('[data-item-id="core.slot.specialize.clear"]').click()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc
    .graphs.root!.nodes.slot!.dynamic?.source)).toEqual({})
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .find((node) => node.id === 'slot')!.layout.pins.some((pin) => pin.portId === 'source' && pin.direction === 'in'))).toBe(true)
  await expect.poll(() => page.evaluate(() => {
    const store = window.__dinksterTest!.app.activeTab()!.store
    return 'status' in store ? (store.status as { get(): string }).get() : undefined
  })).toBe('live')
  expect(await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    return { shared: await app.shareActiveTab(), saved: await app.saveWorkflow(app.activeTab()!.id) }
  })).toEqual({
    shared: undefined,
    saved: true,
  })
  await test.info().attach('required-slot-cleared.png', {
    body: await page.screenshot({ ...(proofDir === undefined ? {} : { path: join(proofDir, 'required-slot-cleared.png') }) }),
    contentType: 'image/png',
  })

  const submissions: string[] = []
  page.on('request', (outgoing) => {
    if (outgoing.method() === 'POST' && new URL(outgoing.url()).pathname === '/api/jobs') submissions.push(outgoing.url())
  })
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queueSelection(app.activeTab()!, ['slot'])
  })
  expect(submissions).toHaveLength(0)
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const compiled = app.compileTab(app.activeTab()!)
    return compiled !== undefined && !compiled.ok ? (compiled.diagnostics as readonly Diagnostic[]).map((diagnostic) => diagnostic.code) : []
  }))
    .toContain('prompt.missing_dynamic_choice')

  const cleared = await pinPoint(page, 'slot', 'source', 'in')
  await page.mouse.click(cleared.x, cleared.y, { button: 'right' })
  await expect(page.locator('[data-item-id="core.slot.specialize.text"]')).toBeVisible()
  await test.info().attach('required-slot-variant-menu.png', {
    body: await page.screenshot({ ...(proofDir === undefined ? {} : { path: join(proofDir, 'required-slot-variant-menu.png') }) }),
    contentType: 'image/png',
  })
  await page.locator('[data-item-id="core.slot.specialize.text"]').click()
  const output = await pinPoint(page, 'representations', 'text', 'out')
  const input = await pinPoint(page, 'slot', 'source', 'in')
  await page.mouse.move(output.x, output.y)
  await page.mouse.down()
  await page.mouse.move(input.x, input.y, { steps: 10 })
  await page.mouse.up()
  await test.info().attach('required-slot-connected.png', { body: await page.screenshot(), contentType: 'image/png' })
  await expect.poll(() => page.evaluate(() => Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!.links)
    .some((link) => 'node' in link.to && link.to.node === 'slot' && 'node' in link.from && link.from.node === 'representations'))).toBe(true)

  const text = `Connected slot ${Date.now()}`
  const row = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'representations')!
    const widget = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'text')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + widget.y + widget.height / 2 }
  })
  await page.mouse.click(row.x, row.y)
  const editor = page.getByTestId('widget-editor').locator('input, textarea')
  await editor.fill(text)
  await editor.press('Enter')

  const jobRequest = page.waitForRequest((outgoing) => outgoing.method() === 'POST' && new URL(outgoing.url()).pathname === '/api/jobs')
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queueSelection(app.activeTab()!, ['slot'])
  })
  const submitted = (await jobRequest).postDataJSON() as { clientId: string; jobId: string; graph: { nodes: Record<string, unknown> } }
  expect(submitted.graph.nodes.slot).toMatchObject({ slotVariants: { source: 'text' } })
  await expect.poll(async () => {
    const response = await request.get(`/api/jobs/${encodeURIComponent(submitted.clientId)}/${encodeURIComponent(submitted.jobId)}`)
    return (await response.json() as { state: string }).state
  }, { timeout: 30_000 }).toBe('completed')
  const response = await request.get(`/api/jobs/${encodeURIComponent(submitted.clientId)}/${encodeURIComponent(submitted.jobId)}`)
  const job = await response.json() as { executed: string[]; outputs: Record<string, Record<string, { value: unknown }>> }
  expect(job.executed).toContain('slot')
  expect(job.outputs.slot!.text!.value).toBe(`text: ${text}`)
  await test.info().attach('required-slot-executed.json', { body: JSON.stringify(job, null, 2), contentType: 'application/json' })
  await test.info().attach('required-slot-executed.png', {
    body: await page.screenshot({ ...(proofDir === undefined ? {} : { path: join(proofDir, 'required-slot-executed.png') }) }),
    contentType: 'image/png',
  })
})
