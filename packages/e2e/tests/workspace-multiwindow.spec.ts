import type { Dialog, Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

async function disableNativeDiscovery(page: Page): Promise<void> {
  await page.route('/api/nodes*', (route) => route.fulfill({ status: 502, body: 'no native backend' }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
}

const tabIds = (page: Page): Promise<string[]> => page.evaluate(() =>
  window.__dinksterTest!.app.tabs.get().map((tab) => tab.id))

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
