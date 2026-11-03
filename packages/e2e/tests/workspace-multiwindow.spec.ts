import type { Dialog, Page } from '@playwright/test'
import type { NodeSchema } from '@dinkster/core'
import { expect, test } from './fixtures.js'
import seedBasic from '../../core/fixtures/workflows/seed-basic.json' with { type: 'json' }

test.beforeEach(async ({ context }) => {
  await context.route('**/api/library/retentions/document/*?scope=local', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 404 })
    const declaration = route.request().postDataJSON()
    await route.fulfill({ json: { ...declaration, scope: 'local', ownerKind: 'document',
      ownerId: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!),
      revision: declaration.revision + 1 } })
  })
})

async function disableNativeDiscovery(page: Page): Promise<void> {
  await page.route('/api/nodes*', (route) => route.fulfill({ status: 502, body: 'no native backend' }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
}

const tabIds = (page: Page): Promise<string[]> => page.evaluate(() =>
  window.__dinksterTest!.app.tabs.get().map((tab) => tab.id))

for (const accepted of [true, false]) {
  test(`ordinary asset edits wait for ownership: ${accepted ? 'accepted' : 'refused'}`, async ({ page }, info) => {
    await disableNativeDiscovery(page)
    await page.goto('/')
    await page.waitForFunction(() => window.__dinksterTest !== undefined)
    await page.evaluate(() => {
      const app = window.__dinksterTest!.app
      const schema: NodeSchema = {
        type: 'AssetLoader', displayName: 'Asset Loader', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'file', optional: false,
          type: { kind: 'asset', element: { kind: 'concrete', name: 'DATA' } } }],
      }
      app.registry.set({ connection: app.connection.id, schemas: new Map([[schema.type, schema]]),
        diagnostics: [], hash: 'asset-fixture', resolve: (type: string) => type === schema.type ? schema : undefined })
      app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'ordinary-assets', root: 'g0',
        graphs: { g0: { id: 'g0', name: 'Root', nodes: { n0: { id: 'n0', type: 'AssetLoader', values: {
          file: { digest: `blake3:${'a'.repeat(64)}`, name: 'before.bin', size: 7,
            mediaType: 'application/octet-stream', virtualPath: '' },
        } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
        view: { graphs: { g0: { nodes: { n0: { position: { x: 100, y: 100 } } } } } },
      }, 'Retained asset edit')
    })
    await expect(page.getByTestId('tab-bar').getByText('Retained asset edit', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => {
      const store = window.__dinksterTest!.app.activeTab()!.store
      const invocation = { command: 'node.setValue', params: {
        graphId: 'g0', nodeId: 'n0', inputId: 'file', value: {
          digest: `blake3:${'c'.repeat(64)}`, name: 'unadmitted.bin', size: 7,
          mediaType: 'application/octet-stream', virtualPath: '',
        },
      } }
      const direct = store.dispatch(invocation)
      const prepared = store.prepareDispatch(invocation)
      return { direct: direct.ok, prepared: prepared.ok && prepared.commit().ok,
        value: store.doc.graphs.g0!.nodes.n0!.values.file }
    })).toMatchObject({ direct: false, prepared: false, value: { name: 'before.bin' } })
    let release!: () => void
    const acknowledgment = new Promise<void>((resolve) => { release = resolve })
    let requested!: () => void
    const request = new Promise<void>((resolve) => { requested = resolve })
    await page.route('**/api/library/retentions/document/*?scope=local', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 404 })
      const declaration = route.request().postDataJSON()
      if (declaration.digests.includes(`blake3:${'b'.repeat(64)}`)) {
        requested()
        await acknowledgment
        if (!accepted) return route.fulfill({ status: 409, json: { error: 'Ownership refused' } })
      }
      await route.fulfill({ json: { ...declaration, scope: 'local', ownerKind: 'document',
        ownerId: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!), revision: 1 } })
    })
    const mutation = page.evaluate(async () => {
      const app = window.__dinksterTest!.app
      return (await app.dispatchTo(app.activeTab()!, { command: 'node.setValue', params: {
        graphId: 'g0', nodeId: 'n0', inputId: 'file', value: {
          digest: `blake3:${'b'.repeat(64)}`, name: 'after.bin', size: 7,
          mediaType: 'application/octet-stream', virtualPath: '',
        },
      } })).ok
    })
    await request
    expect(await page.evaluate(() => {
      const app = window.__dinksterTest!.app
      app.flushPersistTabs(true)
      return app.activeTab()!.store.doc.graphs.g0!.nodes.n0!.values.file
    })).toMatchObject({ name: 'before.bin' })
    await page.screenshot({ path: info.outputPath('ordinary-pending.png') })
    release()
    expect(await mutation).toBe(accepted)
    expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n0!.values.file))
      .toMatchObject({ name: accepted ? 'after.bin' : 'before.bin' })
    await page.screenshot({ path: info.outputPath(`ordinary-${accepted ? 'accepted' : 'refused'}.png`) })
  })
}

for (const accepted of [true, false]) {
  test(`foreign shared edits wait for ownership: ${accepted ? 'accepted' : 'refused'}`, async ({ page, context }, info) => {
    await page.goto('/')
    await page.waitForFunction(() => window.__dinksterTest !== undefined)
    const viewer = await context.newPage()
    await disableNativeDiscovery(viewer)
    await viewer.goto('/')
    await viewer.waitForFunction(() => window.__dinksterTest !== undefined)
    await expect.poll(() => viewer.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc))
      .toEqual(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc))
    let acknowledge!: () => void
    const acknowledgment = new Promise<void>((resolve) => { acknowledge = resolve })
    let requested!: () => void
    const request = new Promise<void>((resolve) => { requested = resolve })
    await viewer.route('**/api/library/retentions/document/*?scope=local', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 404 })
      const declaration = route.request().postDataJSON()
      requested()
      await acknowledgment
      await route.fulfill({ status: accepted ? 200 : 409, json: accepted
        ? { ...declaration, scope: 'local', ownerKind: 'document',
          ownerId: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!), revision: 1 }
        : { error: 'Ownership refused' } })
    })
    const original = await viewer.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)
    expect(await page.evaluate(() => {
      const tab = window.__dinksterTest!.app.activeTab()!
      return tab.store.dispatch({ command: 'node.setTitle', params: {
        graphId: tab.store.doc.root, nodeId: 'n0', title: 'Incoming shared title',
      } }).ok
    })).toBe(true)
    await request
    expect(await viewer.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)).toEqual(original)
    await viewer.screenshot({ path: info.outputPath('foreign-pending.png') })
    acknowledge()
    if (accepted) await expect.poll(() => viewer.evaluate(() =>
      window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n0!.title)).toBe('Incoming shared title')
    else {
      await expect.poll(() => viewer.evaluate(() => window.__dinksterTest!.app.problems.get().some(
        (problem) => problem.message.includes('sync failed')))).toBe(true)
      expect(await viewer.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)).toEqual(original)
    }
    await viewer.screenshot({ path: info.outputPath(`foreign-${accepted ? 'accepted' : 'refused'}.png`) })
  })
}

for (const accepted of [true, false]) {
  test(`restored startup waits for ownership: ${accepted ? 'accepted' : 'refused'}`, async ({ page }, info) => {
    const digest = `blake3:${'e'.repeat(64)}`
    await page.addInitScript(({ document, digest }) => {
      const closed = { ...document, lineage: 'closed-recovery', ext: { held: {
        digest, name: 'closed.bin', size: 7, mediaType: 'application/octet-stream', virtualPath: '',
      } } }
      localStorage.setItem('dinkster.openTabsDocumentCandidate.closed-recovery', JSON.stringify({
        v: 1, stageId: 'closed', tab: { title: 'Closed recovery', doc: closed },
      }))
    }, { document: seedBasic, digest })
    let release!: () => void
    const acknowledgment = new Promise<void>((resolve) => { release = resolve })
    let requests = 0
    let recoveryRequested = false
    let released = false
    await page.route('**/api/library/retentions/document/*?scope=local', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 404 })
      const declaration = route.request().postDataJSON()
      if (declaration.digests.includes(digest)) recoveryRequested = true
      if (!released) { requests += 1; await acknowledgment }
      if (!accepted) return route.fulfill({ status: 409, body: 'Ownership refused' })
      await route.fulfill({ json: { ...declaration, scope: 'local', ownerKind: 'document',
        ownerId: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!), revision: 1 } })
    })
    await page.goto('/')
    await expect.poll(() => requests).toBeGreaterThan(0)
    await expect.poll(() => recoveryRequested).toBe(true)
    expect(await page.evaluate(() => window.__dinksterTest)).toBeUndefined()
    await expect(page.getByRole('tab', { name: /^Basic,/ })).toHaveCount(0)
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('dinkster.openTabs')!))
    expect(saved.tabs.map((tab: { title: string }) => tab.title)).toEqual(['Basic', 'Subgraph'])
    await page.screenshot({ path: info.outputPath('recovery-pending.png') })
    const failure = accepted ? undefined : page.waitForEvent('pageerror')
    released = true
    release()
    if (accepted) {
      await page.waitForFunction(() => window.__dinksterTest !== undefined)
      await expect(page.getByRole('tab', { name: /^Basic,/ })).toBeVisible()
      expect(await tabIds(page)).toEqual(saved.tabs.map((tab: { doc: { lineage: string } }) => tab.doc.lineage))
    } else {
      expect((await failure!).message).toContain('409')
      expect(await page.evaluate(() => window.__dinksterTest)).toBeUndefined()
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('dinkster.openTabs')!).tabs))
        .toEqual(saved.tabs)
    }
    await page.screenshot({ path: info.outputPath(`recovery-${accepted ? 'accepted' : 'refused'}.png`) })
  })
}

for (const accepted of [true, false]) {
  test(`incoming workspace tabs wait for ownership: ${accepted ? 'accepted' : 'refused'}`, async ({ page, context }, info) => {
    await page.goto('/')
    await page.waitForFunction(() => window.__dinksterTest !== undefined)
    const viewer = await context.newPage()
    await disableNativeDiscovery(viewer)
    await viewer.goto('/')
    await viewer.waitForFunction(() => window.__dinksterTest !== undefined)
    await expect.poll(() => tabIds(viewer)).toEqual(await tabIds(page))
    await expect.poll(() => viewer.evaluate(() => window.__dinksterTest!.app.tabs.get().every(
      (tab) => 'status' in tab.store))).toBe(true)
    const previous = await tabIds(viewer)
    await viewer.screenshot({ path: info.outputPath('incoming-default.png') })
    let acknowledge!: () => void
    const acknowledgment = new Promise<void>((resolve) => { acknowledge = resolve })
    let requested!: () => void
    const request = new Promise<void>((resolve) => { requested = resolve })
    await viewer.route('**/api/library/retentions/document/*?scope=local', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 404 })
      const declaration = route.request().postDataJSON()
      requested()
      await acknowledgment
      if (accepted) await route.fulfill({ json: { ...declaration, scope: 'local', ownerKind: 'document',
        ownerId: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!), revision: 1 } })
      else await route.fulfill({ status: 409, body: 'Ownership refused' })
    })
    const id = await page.evaluate(() => {
      const app = window.__dinksterTest!.app as unknown as { createWorkflow(): { id: string } }
      return app.createWorkflow().id
    })
    await request
    expect(await tabIds(viewer)).toEqual(previous)
    await viewer.screenshot({ path: info.outputPath('incoming-pending.png') })
    await acknowledge()
    if (accepted) await expect.poll(() => tabIds(viewer)).toContain(id)
    else {
      await expect.poll(() => viewer.evaluate(() => window.__dinksterTest!.app.problems.get().some(
        (problem) => problem.message.includes('Shared tab ownership unavailable')))).toBe(true)
      expect(await tabIds(viewer)).toEqual(previous)
    }
    await viewer.screenshot({ path: info.outputPath(`incoming-${accepted ? 'accepted' : 'refused'}.png`) })
  })
}

test('workspace promotion preserves a local edit while ownership acknowledgment is pending', async ({ page }, info) => {
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  await page.screenshot({ path: info.outputPath('workspace-default.png') })
  let acknowledge!: () => Promise<void>
  let requested!: () => void
  const request = new Promise<void>((resolve) => { requested = resolve })
  await page.route('**/api/library/retentions/document/*?scope=local', async (route) => {
    const declaration = route.request().postDataJSON()
    await new Promise<void>((done) => {
      acknowledge = async () => {
        await route.fulfill({ json: { ...declaration, scope: 'local', ownerKind: 'document',
          ownerId: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!), revision: 1 } })
        done()
      }
      requested()
    })
  })
  const id = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { createWorkflow(): { id: string } }
    return app.createWorkflow().id
  })
  await request
  const shared = () => page.evaluate((id) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === id)!
    return 'status' in tab.store
  }, id)
  expect(await shared()).toBe(false)
  await page.screenshot({ path: info.outputPath('workspace-pending.png') })
  await page.evaluate((id) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === id)!
    tab.store.dispatch({ command: 'node.add', params: { graphId: tab.store.doc.root,
      type: 'NewLocalNode', position: { x: 20, y: 40 } } })
  }, id)
  await acknowledge()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.problems.get().some(
    (problem) => problem.message.includes('ownership was being confirmed')))).toBe(true)
  expect(await shared()).toBe(false)
  expect(await page.evaluate((id) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === id)!
    return Object.values(tab.store.doc.graphs[tab.store.doc.root]!.nodes).map((node) => node.type)
  }, id)).toEqual(['NewLocalNode'])
  await page.screenshot({ path: info.outputPath('workspace-stale.png') })
  await page.unroute('**/api/library/retentions/document/*?scope=local')
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app as unknown as { enableWorkspaceAuthority(): Promise<void> }
    await app.enableWorkspaceAuthority()
  })
  await expect.poll(shared).toBe(true)
  await page.screenshot({ path: info.outputPath('workspace-accepted.png') })
})

test('two windows converge tab operations and restore the durable inventory', async ({ page, context }) => {
  await page.addInitScript(() => localStorage.removeItem('dinkster.openTabs'))
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  await expect.poll(async () => (await tabIds(page)).length).toBeGreaterThan(0)
  const second = await context.newPage()
  await disableNativeDiscovery(second)
  await second.goto('/')
  await second.waitForFunction(() => window.__dinksterTest !== undefined)
  await expect.poll(() => tabIds(second)).toEqual(await tabIds(page))

  const created = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { createWorkflow(): { id: string } }
    return app.createWorkflow().id
  })
  await expect.poll(() => tabIds(second)).toContain(created)
  await Promise.all([page, second].map((current) => expect.poll(() => current.evaluate((id) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === id)
    return tab !== undefined && 'status' in tab.store
  }, created)).toBe(true)))

  await second.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      tabs: { get(): readonly unknown[]; set(value: readonly unknown[]): void }
    }
    app.tabs.set([...app.tabs.get()].reverse())
  })
  await expect.poll(async () => await tabIds(page)).toEqual(await tabIds(second))

  await page.evaluate(async (id) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === id)!
    tab.store.dispatch({
      command: 'node.add',
      params: { graphId: tab.store.doc.root, type: 'TestNode', position: { x: 0, y: 0 } },
    })
    await (tab.store as unknown as { settle(): Promise<void> }).settle()
  }, created)
  await expect.poll(() => second.evaluate((id) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === id)!
    return Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes).length
  }, created)).toBe(1)

  await Promise.all([page, second].map((current, index) => current.evaluate(async ({ id, titleIndex }) => {
    const app = window.__dinksterTest!.app
    const tab = app.tabs.get().find((candidate) => candidate.id === id)!
    const graph = tab.store.doc.graphs[tab.store.doc.root]!
    const nodeId = Object.keys(graph.nodes)[0]!
    tab.store.dispatch({
      command: 'node.setTitle',
      params: { graphId: tab.store.doc.root, nodeId, title: `window-${titleIndex}` },
    })
    await (tab.store as unknown as { settle(): Promise<void> }).settle()
  }, { id: created, titleIndex: index })))
  const documents = await Promise.all([page, second].map((current) => current.evaluate((id) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === id)!
    return JSON.stringify(tab.store.doc)
  }, created)))
  expect(documents[0]).toBe(documents[1])

  await second.evaluate((id) => {
    const app = window.__dinksterTest!.app as unknown as { closeTab(tabId: string): void }
    app.closeTab(id)
  }, created)
  await expect.poll(() => tabIds(page)).not.toContain(created)
  const expected = await tabIds(page)
  await page.waitForTimeout(500)
  await Promise.all([page.close(), second.close()])

  const reopened = await context.newPage()
  await disableNativeDiscovery(reopened)
  await reopened.goto('/')
  await reopened.waitForFunction(() => window.__dinksterTest !== undefined)
  await expect.poll(() => tabIds(reopened)).toEqual(expected)
})

test('pagehide stages the latest document while another window holds the persistence lock', async ({ page, context }) => {
  await page.addInitScript(() => localStorage.removeItem('dinkster.openTabs'))
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  await page.waitForTimeout(500)
  const blocker = await context.newPage()
  await disableNativeDiscovery(blocker)
  await blocker.goto('/')
  await blocker.waitForFunction(() => window.__dinksterTest !== undefined)
  await blocker.evaluate(async () => {
    const state = globalThis as typeof globalThis & { releasePersistenceLock?: () => void }
    void navigator.locks.request('dinkster.openTabs.commit', async () => {
      await new Promise<void>((resolve) => {
        state.releasePersistenceLock = resolve
      })
    })
    await new Promise<void>((resolve) => {
      const poll = (): void => {
        if (state.releasePersistenceLock) resolve()
        else setTimeout(poll, 0)
      }
      poll()
    })
  })

  const edited = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      createWorkflow(): { id: string; store: { doc: { root: string }; dispatch(invocation: unknown): unknown } }
    }
    const tab = app.createWorkflow()
    tab.store.dispatch({
      command: 'node.add',
      params: { graphId: tab.store.doc.root, type: 'TestNode', position: { x: 0, y: 0 } },
    })
    return tab.id
  })
  await page.goto('about:blank')
  await expect.poll(() => blocker.evaluate((id) => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (!key?.startsWith('dinkster.openTabsCandidate.')) continue
      const candidate = JSON.parse(localStorage.getItem(key)!) as {
        tabs: ReadonlyArray<{ doc: { lineage: string; root: string; graphs: Record<string, { nodes: Record<string, unknown> }> } }>
      }
      const tab = candidate.tabs.find((entry) => entry.doc.lineage === id)
      if (tab && Object.keys(tab.doc.graphs[tab.doc.root]!.nodes).length === 1) return true
    }
    return false
  }, edited)).toBe(true)
  await blocker.evaluate(() => {
    const state = globalThis as typeof globalThis & { releasePersistenceLock?: () => void }
    state.releasePersistenceLock?.()
  })
  await blocker.close()
  const reopened = await context.newPage()
  await disableNativeDiscovery(reopened)
  await reopened.goto('/')
  await reopened.waitForFunction(() => window.__dinksterTest !== undefined)
  await expect.poll(() => reopened.evaluate((id) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((entry) => entry.id === id)!
    return Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes).length
  }, edited)).toBe(1)
})

test('concurrent dirty pagehide candidates are all reconciled before restart', async ({ page, context }) => {
  await page.addInitScript(() => {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index)
      if (key?.startsWith('dinkster.openTabs')) localStorage.removeItem(key)
    }
  })
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  const later = page
  const earlier = await context.newPage()
  await disableNativeDiscovery(earlier)
  await earlier.goto('/')
  await earlier.waitForFunction(() => window.__dinksterTest !== undefined)
  await expect.poll(() => tabIds(earlier)).toEqual(await tabIds(later))
  const lineage = (await tabIds(later))[0]!

  const blocker = await context.newPage()
  await disableNativeDiscovery(blocker)
  await blocker.goto('/')
  await blocker.waitForFunction(() => window.__dinksterTest !== undefined)
  await later.waitForTimeout(500)
  await blocker.evaluate(async () => {
    const state = globalThis as typeof globalThis & { releasePersistenceLock?: () => void }
    void navigator.locks.request('dinkster.openTabs.commit', async () => {
      await new Promise<void>((resolve) => {
        state.releasePersistenceLock = resolve
      })
    })
    await new Promise<void>((resolve) => {
      const poll = (): void => {
        if (state.releasePersistenceLock) resolve()
        else setTimeout(poll, 0)
      }
      poll()
    })
  })
  await blocker.evaluate(() => {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index)
      if (key?.startsWith('dinkster.openTabsCandidate.')) localStorage.removeItem(key)
    }
  })

  const edit = async (current: Page, name: string): Promise<void> => {
    await current.evaluate(({ id, graphName }) => {
      const app = window.__dinksterTest!.app as unknown as {
        disableWorkspaceAuthority(keepLocalTabs: boolean): void
        openDocument(document: unknown, title: string): readonly unknown[]
        tabs: { get(): ReadonlyArray<{ id: string; store: { doc: { root: string; graphs: Record<string, { name: string }> } } }> }
      }
      app.disableWorkspaceAuthority(true)
      const tab = app.tabs.get().find((entry) => entry.id === id)!
      const replacement = structuredClone(tab.store.doc)
      replacement.graphs[replacement.root]!.name = graphName
      app.openDocument(replacement, graphName)
    }, { id: lineage, graphName: name })
  }
  await edit(later, 'actual-later-A')
  await edit(earlier, 'actual-earlier-B')
  let releaseDialog: ((dialog: Dialog) => void) | undefined
  const writePaused = new Promise<Dialog>((resolve) => {
    releaseDialog = resolve
  })
  later.once('dialog', (dialog) => releaseDialog?.(dialog))
  await later.evaluate(() => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key.startsWith('dinkster.openTabsDocumentCandidate.') && value.includes('actual-later-A')) {
        alert('candidate-write-paused')
      }
      setItem.call(this, key, value)
    }
  })
  const laterPagehide = later.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))
  })
  const dialog = await writePaused
  expect(dialog.message()).toBe('candidate-write-paused')
  await earlier.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))
  })

  await expect.poll(() => blocker.evaluate((id) => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key !== `dinkster.openTabsDocumentCandidate.${encodeURIComponent(id)}`) continue
      const candidate = JSON.parse(localStorage.getItem(key)!) as {
        stageId: string
        tab: {
          doc: { lineage: string; root: string; graphs: Record<string, { name: string }> }
          documentRevision?: number
          documentDirty?: true
        }
      }
      return {
        name: candidate.tab.doc.graphs[candidate.tab.doc.root]!.name,
        revision: candidate.tab.documentRevision ?? 0,
        dirty: candidate.tab.documentDirty === true,
      }
    }
    return undefined
  }, lineage)).toEqual({ name: 'actual-earlier-B', revision: 0, dirty: true })
  await dialog.accept()
  await laterPagehide
  await expect.poll(() => blocker.evaluate((id) => {
    const key = `dinkster.openTabsDocumentCandidate.${encodeURIComponent(id)}`
    const candidate = JSON.parse(localStorage.getItem(key)!) as {
      tab: { doc: { root: string; graphs: Record<string, { name: string }> } }
    }
    return candidate.tab.doc.graphs[candidate.tab.doc.root]!.name
  }, lineage)).toBe('actual-later-A')

  await blocker.evaluate(() => {
    const state = globalThis as typeof globalThis & { releasePersistenceLock?: () => void }
    state.releasePersistenceLock?.()
  })
  await expect.poll(() => blocker.evaluate((id) => {
    const persisted = JSON.parse(localStorage.getItem('dinkster.openTabs')!) as {
      documentCandidateStages?: Record<string, string>
      tabs: Array<{
        doc: { lineage: string; root: string; graphs: Record<string, { name: string }> }
        documentRevision?: number
      }>
    }
    const tab = persisted.tabs.find((entry) => entry.doc.lineage === id)!
    return {
      name: tab.doc.graphs[tab.doc.root]!.name,
      revision: tab.documentRevision ?? 0,
      candidates: [...Array(localStorage.length).keys()]
        .map((index) => localStorage.key(index))
        .filter((key) => key?.startsWith('dinkster.openTabsCandidate.')).length,
      covered: typeof persisted.documentCandidateStages?.[id] === 'string',
    }
  }, lineage)).toEqual({ name: 'actual-later-A', revision: 1, candidates: 0, covered: true })

  await Promise.all([earlier.close(), later.close(), blocker.close()])
  const reopened = await context.newPage()
  await disableNativeDiscovery(reopened)
  await reopened.goto('/')
  await reopened.waitForFunction(() => window.__dinksterTest !== undefined)
  await expect.poll(() => reopened.evaluate((id) => {
    const app = window.__dinksterTest!.app as unknown as {
      tabs: { get(): ReadonlyArray<{ id: string; store: { doc: { root: string; graphs: Record<string, { name: string }> } } }> }
    }
    const tab = app.tabs.get().find((entry) => entry.id === id)!
    return tab.store.doc.graphs[tab.store.doc.root]!.name
  }, lineage)).toBe('actual-later-A')
})

test('a reconnect fallback cannot overwrite a fresher document at the same workspace revision', async ({ page, context }) => {
  await page.addInitScript(() => localStorage.removeItem('dinkster.openTabs'))
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  const stale = await context.newPage()
  await disableNativeDiscovery(stale)
  await stale.goto('/')
  await stale.waitForFunction(() => window.__dinksterTest !== undefined)
  await expect.poll(() => tabIds(stale)).toEqual(await tabIds(page))
  // Edit a workflow created empty here: the startup tab set depends on
  // same-origin discovery (a conclusive v1 answer seeds two-node fixture
  // workflows; anything else opens one blank tab), so the node counts
  // asserted below are only stable for a document this test owns.
  const edited = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { createWorkflow(): { id: string } }
    return app.createWorkflow().id
  })
  await expect.poll(() => tabIds(stale)).toContain(edited)
  await Promise.all([page, stale].map((current) => expect.poll(() => current.evaluate((id) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === id)
    return tab !== undefined && 'status' in tab.store
  }, edited)).toBe(true)))

  await stale.evaluate(async () => {
    const app = window.__dinksterTest!.app as unknown as {
      disableWorkspaceAuthority(keepLocalTabs: boolean): void
      enableWorkspaceAuthority(): Promise<void>
    }
    for (let count = 0; count < 3; count += 1) {
      app.disableWorkspaceAuthority(true)
      await app.enableWorkspaceAuthority()
    }
    app.disableWorkspaceAuthority(true)
  })
  await page.evaluate(async (id) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((entry) => entry.id === id)!
    tab.store.dispatch({
      command: 'node.add',
      params: { graphId: tab.store.doc.root, type: 'TestNode', position: { x: 0, y: 0 } },
    })
    await (tab.store as unknown as { settle(): Promise<void> }).settle()
  }, edited)
  await page.waitForTimeout(500)
  await stale.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.activeTabId.set(app.activeTabId.get())
  })
  await stale.waitForTimeout(500)
  await expect.poll(() => page.evaluate((id) => {
    const persisted = JSON.parse(localStorage.getItem('dinkster.openTabs')!) as {
      tabs: ReadonlyArray<{ doc: { lineage: string; root: string; graphs: Record<string, { nodes: Record<string, unknown> }> } }>
    }
    const tab = persisted.tabs.find((entry) => entry.doc.lineage === id)!
    return Object.keys(tab.doc.graphs[tab.doc.root]!.nodes).length
  }, edited)).toBe(1)

  await stale.evaluate(async (id) => {
    const app = window.__dinksterTest!.app as unknown as {
      enableWorkspaceAuthority(): Promise<void>
      tabs: { get(): ReadonlyArray<{ id: string; store: { doc: { root: string }; dispatch(invocation: unknown): unknown; settle(): Promise<void> } }> }
    }
    await app.enableWorkspaceAuthority()
    const tab = app.tabs.get().find((entry) => entry.id === id)!
    tab.store.dispatch({
      command: 'node.add',
      params: { graphId: tab.store.doc.root, type: 'TestNode', position: { x: 20, y: 20 } },
    })
    await tab.store.settle()
  }, edited)
  await stale.waitForTimeout(500)

  await Promise.all([page.close(), stale.close()])
  const reopened = await context.newPage()
  await disableNativeDiscovery(reopened)
  await reopened.goto('/')
  await reopened.waitForFunction(() => window.__dinksterTest !== undefined)
  await expect.poll(() => reopened.evaluate((id) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((entry) => entry.id === id)!
    return Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes).length
  }, edited)).toBe(2)
})
