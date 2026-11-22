import type { Page } from '@playwright/test'
import { expect, test, waitForWorkspaceReady as waitForOwnership } from './fixtures.js'
import seedBasic from '../../core/fixtures/workflows/seed-basic.json' with { type: 'json' }
import seedSubgraph from '../../core/fixtures/workflows/seed-subgraph.json' with { type: 'json' }

test.beforeEach(async ({ context }) => {
  await context.route('**/api/library/retentions/document/*?scope=local', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 404 })
    const declaration = route.request().postDataJSON()
    await route.fulfill({ json: { ...declaration, scope: 'local', ownerKind: 'document',
      ownerId: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!),
      revision: declaration.revision + 1 } })
  })
})

async function disableSupervisorDiscovery(page: Page): Promise<void> {
  // Keep the same-origin catalog: ownership admission needs the document schemas.
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
}

async function waitForWorkspaceReady(page: Page): Promise<void> {
  await waitForOwnership(page)
  await page.evaluate(() => window.__dinksterTest!.app.registerSchemas(
    ['TestNode', 'NewLocalNode'].map((type) => ({
      type, displayName: type, category: 'test', source: 'v3', isOutputNode: false, items: [],
    })),
  ))
}

const tabIds = (page: Page): Promise<string[]> => page.evaluate(() =>
  window.__dinksterTest!.app.tabs.get().map((tab) => tab.id))

test('worker saves retain concurrent edits and merge more than sixteen recovery sources without parsing workflows on the page', async ({ page, context }) => {
  await page.goto('/')
  await waitForWorkspaceReady(page)
  const peer = await context.newPage()
  await peer.goto('/')
  await waitForWorkspaceReady(peer)
  await page.evaluate(() => {
    const parse = JSON.parse
    const counts = { workflowParses: 0 }
    Object.assign(window, { persistenceCounts: counts })
    JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
      if (args[0].includes('dinkster-workflow')) counts.workflowParses += 1
      return parse(...args)
    }
  })
  await peer.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('dinkster.openTabs')!)
    for (let index = 0; index < 24; index += 1) {
      localStorage.setItem(`dinkster.openTabsCandidate.recovery-${index}`, JSON.stringify({ ...saved, source: index }))
    }
  })
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.startsWith('dinkster.openTabsCandidate.recovery-')).length)).toBe(0)
  expect(await page.evaluate(() => (window as unknown as {
    persistenceCounts: { workflowParses: number }
  }).persistenceCounts.workflowParses)).toBe(0)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const update = (title: string) => tab.store.dispatch({ command: 'node.setTitle', params: {
      graphId: tab.store.doc.root, nodeId: Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes)[0]!, title,
    } })
    update('First worker snapshot')
    app.flushPersistTabs()
    update('Newer worker snapshot')
  })
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dinkster.openTabs'))).toContain('Newer worker snapshot')
  await peer.reload()
  await waitForWorkspaceReady(peer)
  expect(await peer.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return Object.values(tab.store.doc.graphs[tab.store.doc.root]!.nodes).map((node) => node.title)
  })).toContain('Newer worker snapshot')
})

for (const accepted of [true, false]) {
}

for (const accepted of [true, false]) {
}

for (const accepted of [true, false]) {
  test(`restored startup renders before ownership: ${accepted ? 'accepted' : 'refused'}`, async ({ page }, info) => {
    const digest = `blake3:${'e'.repeat(64)}`
    const document = structuredClone(seedBasic)
    document.graphs.g0.nodes.n0.type = 'dinkster.image.empty_image'
    document.graphs.g0.nodes.n1.type = 'dinkster.image.preview_image'
    document.graphs.g0.links.l2.from.port = 'IMAGE'
    const subgraph = structuredClone(seedSubgraph)
    subgraph.graphs.g0.nodes.n1.type = 'dinkster.image.preview_image'
    subgraph.graphs.g1.nodes.n0.type = 'dinkster.image.empty_image'
    subgraph.graphs.g1.boundary.outputs[0]!.binds.port = 'IMAGE'
    await page.addInitScript(({ document, subgraph, digest }) => {
      localStorage.setItem('dinkster.openTabs', JSON.stringify({
        v: 1, active: document.lineage,
        tabs: [{ title: 'Basic', doc: document, documentRevision: 0 }, { title: 'Subgraph', doc: subgraph, documentRevision: 0 }],
      }))
      const closed = { ...document, lineage: 'closed-recovery', ext: { held: {
        digest, name: 'closed.bin', size: 7, mediaType: 'application/octet-stream', virtualPath: '',
      } } }
      localStorage.setItem('dinkster.openTabsDocumentCandidate.closed-recovery', JSON.stringify({
        v: 1, stageId: 'closed', tab: { title: 'Closed recovery', doc: closed },
      }))
    }, { document, subgraph, digest })
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
    await expect(page.getByRole('tab', { name: /^Basic,/ })).toBeVisible()
    await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/)
    expect(await page.evaluate(() => window.__dinksterTest!.app.tabs.get().every(
      (tab) => !('status' in tab.store)))).toBe(true)
    await expect(page.getByTestId('problems-panel')).toContainText('Workflow ownership unconfirmed.')
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('dinkster.openTabs')!))
    expect(saved.tabs.map((tab: { title: string }) => tab.title)).toEqual(['Basic', 'Subgraph'])
    await page.screenshot({ path: info.outputPath('recovery-pending.png') })
    released = true
    release()
    if (accepted) {
      await waitForWorkspaceReady(page)
      await expect(page.getByRole('tab', { name: /^Basic,/ })).toBeVisible()
      expect(await tabIds(page)).toEqual(saved.tabs.map((tab: { doc: { lineage: string } }) => tab.doc.lineage))
    } else {
      await expect(page.getByTestId('problems-panel')).toContainText('409')
      await expect(page.getByRole('tab', { name: /^Basic,/ })).toBeVisible()
      expect(await page.evaluate(() => window.__dinksterTest!.app.tabs.get().every(
        (tab) => !('status' in tab.store)))).toBe(true)
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('dinkster.openTabs')!).tabs))
        .toEqual(saved.tabs)
    }
    await page.screenshot({ path: info.outputPath(`recovery-${accepted ? 'accepted' : 'refused'}.png`) })
  })
}

for (const accepted of [true, false]) {
}

test('workspace promotion preserves a local edit while ownership acknowledgment is pending', async ({ page }, info) => {
  await page.clock.install()
  await page.goto('/')
  await waitForWorkspaceReady(page)
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
  await page.screenshot({ path: info.outputPath('workspace-default.png') })
  let created!: (id: string) => void
  const lineage = new Promise<string>((resolve) => { created = resolve })
  const acknowledgments: (() => void)[] = []
  let targetRequests = 0
  let requested!: () => void
  const request = new Promise<void>((resolve) => { requested = resolve })
  await page.route('**/api/library/retentions/document/*?scope=local', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 404 })
    const id = await lineage
    const ownerId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!)
    const documentLineage = await page.evaluate((owner) =>
      JSON.parse(localStorage.getItem(`dinkster.workflow-retentions.${owner}`)!).documentLineage as string, ownerId)
    const declaration = route.request().postDataJSON()
    // Journal admission precedes promotion; paused timers exclude persistence debounce requests.
    if (documentLineage === id && ++targetRequests > 1) await new Promise<void>((resolve) => {
      acknowledgments.push(resolve)
      requested()
    })
    await route.fulfill({ json: { ...declaration, scope: 'local', ownerKind: 'document', ownerId, revision: 1 } })
  })
  const id = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { createWorkflow(): { id: string } }
    return app.createWorkflow().id
  })
  created(id)
  await request
  const shared = () => page.evaluate((id) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === id)!
    return 'status' in tab.store
  }, id)
  expect(await shared()).toBe(false)
  await page.clock.runFor(16)
  await page.screenshot({ path: info.outputPath('workspace-pending.png') })
  await page.evaluate((id) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === id)!
    tab.store.dispatch({ command: 'node.add', params: { graphId: tab.store.doc.root,
      type: 'NewLocalNode', position: { x: 20, y: 40 } } })
  }, id)
  acknowledgments.shift()!()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.problems.get().some(
    (problem) => problem.message.includes('ownership was being confirmed')))).toBe(true)
  expect(await shared()).toBe(false)
  expect(await page.evaluate((id) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === id)!
    return Object.values(tab.store.doc.graphs[tab.store.doc.root]!.nodes).map((node) => node.type)
  }, id)).toEqual(['NewLocalNode'])
  await page.clock.runFor(16)
  await page.screenshot({ path: info.outputPath('workspace-stale.png') })
  for (const acknowledge of acknowledgments) acknowledge()
  await page.unroute('**/api/library/retentions/document/*?scope=local')
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app as unknown as { enableWorkspaceAuthority(): Promise<void> }
    await app.enableWorkspaceAuthority()
  })
  await expect.poll(shared).toBe(true)
  await page.clock.runFor(16)
  await page.screenshot({ path: info.outputPath('workspace-accepted.png') })
})

test('two windows converge tab operations and restore the durable inventory', async ({ page, context }) => {
  await page.addInitScript(() => localStorage.removeItem('dinkster.openTabs'))
  await page.goto('/')
  await waitForWorkspaceReady(page)
  await expect.poll(async () => (await tabIds(page)).length).toBeGreaterThan(0)
  const second = await context.newPage()
  await disableSupervisorDiscovery(second)
  await second.goto('/')
  await waitForWorkspaceReady(second)
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

  const committedRevisions = await Promise.all([page, second].map((current, index) => current.evaluate(async ({ id, titleIndex }) => {
    const app = window.__dinksterTest!.app
    const tab = app.tabs.get().find((candidate) => candidate.id === id)!
    const graph = tab.store.doc.graphs[tab.store.doc.root]!
    const nodeId = Object.keys(graph.nodes)[0]!
    tab.store.dispatch({
      command: 'node.setTitle',
      params: { graphId: tab.store.doc.root, nodeId, title: `window-${titleIndex}` },
    })
    await (tab.store as unknown as { settle(): Promise<void> }).settle()
    return tab.store.revision
  }, { id: created, titleIndex: index })))
  // Local submission can settle before a peer receives the committed operation.
  const committedRevision = Math.max(...committedRevisions)
  await Promise.all([page, second].map((current) => expect.poll(() => current.evaluate((id) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === id)!
    return tab.store.revision
  }, created)).toBe(committedRevision)))
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
  await disableSupervisorDiscovery(reopened)
  await reopened.goto('/')
  await waitForWorkspaceReady(reopened)
  await expect.poll(() => tabIds(reopened)).toEqual(expected)
})

test('pagehide stages the latest document while another window holds the persistence lock', async ({ page, context }) => {
  await page.addInitScript(() => localStorage.removeItem('dinkster.openTabs'))
  await page.goto('/')
  await waitForWorkspaceReady(page)
  await page.waitForTimeout(500)
  const blocker = await context.newPage()
  await disableSupervisorDiscovery(blocker)
  await blocker.goto('/')
  await waitForWorkspaceReady(blocker)
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
  await disableSupervisorDiscovery(reopened)
  await reopened.goto('/')
  await waitForWorkspaceReady(reopened)
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
  await waitForWorkspaceReady(page)
  const later = page
  const earlier = await context.newPage()
  await disableSupervisorDiscovery(earlier)
  await earlier.goto('/')
  await waitForWorkspaceReady(earlier)
  await expect.poll(() => tabIds(earlier)).toEqual(await tabIds(later))
  const lineage = (await tabIds(later))[0]!
  const initialRevision = await later.evaluate((id) => {
    const persisted = JSON.parse(localStorage.getItem('dinkster.openTabs')!) as {
      tabs: Array<{ doc: { lineage: string }; documentRevision?: number }>
    }
    return persisted.tabs.find((tab) => tab.doc.lineage === id)!.documentRevision ?? 0
  }, lineage)

  const blocker = await context.newPage()
  await disableSupervisorDiscovery(blocker)
  await blocker.goto('/')
  await waitForWorkspaceReady(blocker)
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

  const edits = [
    { id: lineage, graphName: 'actual-earlier-B' },
    { id: lineage, graphName: 'actual-later-A' },
  ]
  await Promise.all([earlier, later].map((current) => current.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      disableWorkspaceAuthority(keepLocalTabs: boolean): void
    }
    app.disableWorkspaceAuthority(true)
  })))
  // The last submitted same-lineage stage must win, without bypassing its lock.
  for (const [index, current] of [earlier, later].entries()) {
    await current.evaluate(async ({ id, graphName }) => {
      const app = window.__dinksterTest!.app as unknown as {
        openDocument(document: unknown, title: string): readonly unknown[]
        tabs: { get(): ReadonlyArray<{ id: string; store: { doc: { root: string; graphs: Record<string, { name: string }> } } }> }
      }
      const tab = app.tabs.get().find((entry) => entry.id === id)!
      const replacement = structuredClone(tab.store.doc)
      replacement.graphs[replacement.root]!.name = graphName
      await app.openDocument(replacement, graphName)
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))
    }, edits[index]!)
  }

  // pagehide must preserve both edits even when locked document staging cannot run.
  for (const edit of edits) {
    await expect.poll(() => blocker.evaluate(({ id, graphName }) => {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index)
        if (!key?.startsWith('dinkster.openTabsCandidate.')) continue
        const candidate = JSON.parse(localStorage.getItem(key)!) as {
          tabs: ReadonlyArray<{
            doc: { lineage: string; root: string; graphs: Record<string, { name: string }> }
            documentDirty?: true
          }>
        }
        const tab = candidate.tabs.find((entry) => entry.doc.lineage === id)
        if (tab?.documentDirty === true && tab.doc.graphs[tab.doc.root]!.name === graphName) return true
      }
      return false
    }, edit)).toBe(true)
  }

  await blocker.evaluate(() => {
    const state = globalThis as typeof globalThis & { releasePersistenceLock?: () => void }
    state.releasePersistenceLock?.()
  })
  await expect.poll(() => blocker.evaluate(({ id, revision }) => {
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
      advanced: (tab.documentRevision ?? 0) > revision,
      candidates: [...Array(localStorage.length).keys()]
        .map((index) => localStorage.key(index))
        .filter((key) => key?.startsWith('dinkster.openTabsCandidate.')).length,
      covered: typeof persisted.documentCandidateStages?.[id] === 'string',
    }
  }, { id: lineage, revision: initialRevision })).toEqual({
    name: 'actual-later-A', advanced: true, candidates: 0, covered: true,
  })

  await Promise.all([earlier.close(), later.close(), blocker.close()])
  const reopened = await context.newPage()
  await disableSupervisorDiscovery(reopened)
  await reopened.goto('/')
  await waitForWorkspaceReady(reopened)
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
  await waitForWorkspaceReady(page)
  const stale = await context.newPage()
  await disableSupervisorDiscovery(stale)
  await stale.goto('/')
  await waitForWorkspaceReady(stale)
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
  await disableSupervisorDiscovery(reopened)
  await reopened.goto('/')
  await waitForWorkspaceReady(reopened)
  await expect.poll(() => reopened.evaluate((id) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((entry) => entry.id === id)!
    return Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes).length
  }, edited)).toBe(2)
})
