import { expect, test, type Page, type Route } from '@playwright/test'

const evidenceDir = process.env['DINKSTER_COLLAB_EVIDENCE_DIR'] ?? '/tmp/dinkster-42-evidence'
const longSessionId = `session-${'s'.repeat(90)}`
const longDocumentId = `document-${'d'.repeat(90)}`

const session = (sessionId = 'session-one', documentId = 'document-one') => ({
  protocolVersion: 1,
  sessionId,
  scope: 'shared',
  documentId,
  revision: 17,
  snapshotRevision: 12,
})

async function appReady(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest?.app !== undefined)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    if (!app.backends.get().some((backend) => backend.protocol === 'dinkster')) {
      app.addBackend('http://collab.test', 'Collaboration test', false, 'dinkster')
    }
  })
}

async function openCollaboration(page: Page): Promise<void> {
  await page.getByTestId('collab-button').click()
  await expect(page.getByTestId('collab-panel')).toBeVisible()
}

async function shareFromActiveTabMenu(page: Page): Promise<void> {
  await page.locator('[data-tab-id]').filter({ has: page.locator('[aria-selected="true"]') }).click({ button: 'right' })
  const share = page.locator('[data-item-id="workflow.share"]')
  await expect(share).toBeVisible()
  await expect(share).toHaveText(/Share/)
  await share.click()
}

async function routeSessions(page: Page, handler: (route: Route) => Promise<void> | void): Promise<void> {
  await page.route(
    (url) => url.pathname.endsWith('/api/sessions') && url.searchParams.get('scope') === 'shared',
    handler,
  )
}

async function installCurrentSession(page: Page, initialStatus: 'live' | 'catching-up' | 'closed' | 'error' = 'live'): Promise<void> {
  await page.evaluate(({ initialStatus, longSessionId, longDocumentId }) => {
    const signal = <T>(initial: T) => {
      let value = initial
      const listeners = new Set<(next: T) => void>()
      return {
        get: () => value,
        set: (next: T) => { value = next; for (const listener of [...listeners]) listener(next) },
        subscribe: (listener: (next: T) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      }
    }
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): { id: string; store: { doc: { root: string } } } | undefined
      collabTabs: { set(value: ReadonlyMap<string, unknown>): void }
    }
    const tab = app.activeTab()!
    const status = signal(initialStatus)
    const remotes = signal(new Map(Array.from({ length: 14 }, (_, index) => {
      const actorId = `remote-${index}-${'r'.repeat(52)}`
      return [actorId, { actorId, graph: tab.store.doc.root, selection: [], reroutes: [] }]
    })))
    const presence = {
      remotes,
      setLocal: () => {},
      blur: () => {},
      dispose: () => {},
    }
    const entry = {
      descriptor: {
        protocolVersion: 1,
        sessionId: longSessionId,
        scope: 'shared',
        documentId: longDocumentId,
        revision: 17,
        snapshotRevision: 12,
      },
      baseUrl: 'http://backend.test/a/deliberately/long/collaboration/path',
      session: { status, doc: { lineage: tab.id } },
      presence,
    }
    app.collabTabs.set(new Map([[tab.id, entry]]))
    ;(window as unknown as { __collabFixture: unknown }).__collabFixture = { app, tabId: tab.id, status }
  }, { initialStatus, longSessionId, longDocumentId })
}

async function installProductionCollabTransport(page: Page): Promise<void> {
  await page.evaluate(() => {
    type FixtureEvent =
      | { readonly kind: 'connected'; readonly descriptor: FixtureDescriptor }
      | { readonly kind: 'session-closed' }
    type FixtureDescriptor = {
      readonly protocolVersion: 1
      readonly sessionId: string
      readonly scope: string
      readonly documentId: string
      readonly revision: number
      readonly snapshotRevision: number
    }
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const sessionId = 'production-watcher-session'
    let snapshot: unknown
    let descriptor: FixtureDescriptor | undefined
    let rejectEnd!: (reason: Error) => void
    const pendingEnd = new Promise<void>((_resolve, reject) => { rejectEnd = reject })
    let snapshotCount = 0
    let revision = 0
    const connections: Array<{
      closed: boolean
      listeners: Set<(event: FixtureEvent) => void>
    }> = []
    const connect = () => {
      const state = {
        closed: false,
        listeners: new Set<(event: FixtureEvent) => void>(),
      }
      connections.push(state)
      return {
        sessionId,
        postOp: async (op: {
          readonly opId: string
          readonly actorId: string
          readonly baseRevision: number
          readonly patch: readonly unknown[]
        }) => ({
          kind: 'accepted' as const,
          op: { ...op, revision: ++revision, timestamp: 1000 },
        }),
        fetchSnapshot: async () => {
          snapshotCount += 1
          if (snapshot === undefined) throw new Error('missing collaboration fixture snapshot')
          return { revision: 0, document: snapshot }
        },
        fetchOps: async () => ({ kind: 'ops' as const, ops: [] }),
        putSnapshot: async () => ({ kind: 'ok' as const }),
        sendPresence: () => {},
        onEvent: (listener: (event: FixtureEvent) => void) => {
          state.listeners.add(listener)
          queueMicrotask(() => {
            if (!state.closed && descriptor !== undefined) listener({ kind: 'connected', descriptor })
          })
          return () => state.listeners.delete(listener)
        },
        close: () => { state.closed = true },
      }
    }
    const transport = {
      create: async (_baseUrl: string, args: { scope: string; documentId: string; snapshot: unknown }) => {
        snapshot = structuredClone(args.snapshot)
        descriptor = {
          protocolVersion: 1,
          sessionId,
          scope: args.scope,
          documentId: args.documentId,
          revision: 0,
          snapshotRevision: 0,
        }
        return descriptor
      },
      list: async () => descriptor === undefined ? [] : [descriptor],
      get: async (_baseUrl: string, requestedSessionId: string) =>
        requestedSessionId === sessionId ? descriptor : undefined,
      end: async () => pendingEnd,
      connect,
    }
    ;(app as unknown as { collabTransport: typeof transport }).collabTransport = transport
    ;(window as unknown as {
      __collabAuthorityFixture: {
        app: typeof app
        tabId: string
        connectionCount(): number
        snapshotCount(): number
        connectionClosed(index: number): boolean | undefined
        emitClosed(): void
        rejectEnd(reason: Error): void
      }
    }).__collabAuthorityFixture = {
      app,
      tabId: tab.id,
      connectionCount: () => connections.length,
      snapshotCount: () => snapshotCount,
      connectionClosed: (index) => connections[index]?.closed,
      emitClosed: () => {
        for (const connection of connections) {
          if (connection.closed) continue
          for (const listener of [...connection.listeners]) listener({ kind: 'session-closed' })
        }
      },
      rejectEnd,
    }
  })
}

test('sharing keeps a local edit undoable with Ctrl+Z', async ({ page }) => {
  await appReady(page)
  await installProductionCollabTransport(page)
  const baseline = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const graphId = tab.store.doc.root
    const count = Object.keys(tab.store.doc.graphs[graphId]!.nodes).length
    const result = tab.store.dispatch({
      command: 'node.add',
      params: { graphId, type: 'ShareUndoProof', position: { x: 10, y: 20 } },
    })
    if (!result.ok) throw new Error(`node.add refused: ${JSON.stringify(result.diagnostics)}`)
    return count
  })
  await shareFromActiveTabMenu(page)
  await openCollaboration(page)
  await expect(page.getByTestId('collab-current-session')).toBeVisible()
  await expect.poll(() => page.evaluate(() =>
    (window.__dinksterTest!.app.activeTab()!.store as unknown as { canUndo: boolean }).canUndo,
  )).toBe(true)
  await page.getByTestId('modal-close').click()
  await page.keyboard.press('Control+z')

  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes).length
  })).toBe(baseline)
})

test('management list distinguishes loading, empty, unavailable, and failure', async ({ page }) => {
  let release!: () => void
  let fail = false
  await routeSessions(page, async (route) => {
    if (fail) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture unavailable' }) })
      return
    }
    await new Promise<void>((resolve) => { release = resolve })
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [] }) })
  })
  await appReady(page)
  await openCollaboration(page)
  await expect(page.getByTestId('collab-loading')).toBeVisible()
  release()
  await expect(page.getByTestId('collab-empty')).toBeVisible()
  await page.screenshot({ path: `${evidenceDir}/after-wide-empty.png`, fullPage: true })

  fail = true
  await page.getByTestId('collab-refresh').click()
  await expect(page.getByTestId('collab-list-error')).toContainText('fixture unavailable')
  await expect(page.getByTestId('collab-empty')).toHaveCount(0)
  await page.screenshot({ path: `${evidenceDir}/after-wide-list-error.png`, fullPage: true })

  await page.getByTestId('modal-close').click()
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    ;(app as unknown as { collabBackend: () => undefined }).collabBackend = () => undefined
  })
  await openCollaboration(page)
  await expect(page.getByTestId('collab-no-backend')).toBeVisible()
  await expect(page.getByTestId('collab-backend-unavailable')).toContainText('Connect a Dinkster backend')
  await page.screenshot({ path: `${evidenceDir}/after-wide-no-backend.png`, fullPage: true })
})

test('wide management view presents status, long identities, participants, and exact state changes', async ({ page }) => {
  await routeSessions(page, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ sessions: [session(longSessionId, longDocumentId)] }),
  }))
  await appReady(page)
  await installCurrentSession(page)
  await openCollaboration(page)

  await expect(page.getByTestId('collab-status')).toHaveText(/Live/)
  await expect(page.getByTestId('collab-current-session')).toContainText(longSessionId)
  await expect(page.getByTestId('collab-session')).toContainText(longDocumentId)
  await expect(page.getByTestId('collab-participant')).toHaveCount(14)
  const participantOverflow = await page.getByTestId('collab-participants').evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(participantOverflow.scrollHeight).toBeGreaterThan(participantOverflow.clientHeight)
  const modalBounds = await page.getByTestId('modal-surface').boundingBox()
  const cardBounds = await page.getByTestId('collab-current-session').boundingBox()
  expect(modalBounds).not.toBeNull()
  expect(cardBounds).not.toBeNull()
  expect(cardBounds!.x + cardBounds!.width).toBeLessThanOrEqual(modalBounds!.x + modalBounds!.width)
  await page.screenshot({ path: `${evidenceDir}/after-wide-live.png`, fullPage: true })
  await page.getByTestId('collab-join').scrollIntoViewIfNeeded()
  await expect(page.getByTestId('collab-join')).toBeVisible()
  await page.screenshot({ path: `${evidenceDir}/after-wide-live-tail.png`, fullPage: true })
  await page.getByTestId('collab-panel').evaluate((element) => { element.scrollTop = 0 })

  for (const [status, label] of [
    ['catching-up', 'Catching up'],
    ['closed', 'Closed'],
    ['error', 'Error'],
    ['live', 'Live'],
  ] as const) {
    await page.evaluate((next) => {
      const fixture = (window as unknown as { __collabFixture: { status: { set(value: string): void } } }).__collabFixture
      fixture.status.set(next)
    }, status)
    await expect(page.getByTestId('collab-status')).toHaveText(new RegExp(label))
    await expect(page.getByTestId('collab-status')).toHaveAttribute('aria-label', `Collaboration status: ${label}`)
    if (status === 'closed') {
      await page.screenshot({ path: `${evidenceDir}/after-wide-closed.png`, fullPage: true })
    }
  }
})

test('production watcher keeps remote close truthful when an in-flight end fails', async ({ page }) => {
  await appReady(page)
  await installProductionCollabTransport(page)
  await shareFromActiveTabMenu(page)
  await openCollaboration(page)
  await expect(page.getByTestId('collab-current-session')).toBeVisible()
  await expect(page.getByTestId('collab-session')).toHaveCount(1)

  await page.getByTestId('collab-end').click()
  await page.getByTestId('collab-end-confirm-button').click()
  await expect(page.getByTestId('collab-end-confirm-button')).toHaveAttribute('aria-busy', 'true')
  await page.evaluate(() => {
    const fixture = (window as unknown as {
      __collabAuthorityFixture: { emitClosed(): void }
    }).__collabAuthorityFixture
    fixture.emitClosed()
  })

  await expect.poll(() => page.evaluate(() => {
    const fixture = (window as unknown as {
      __collabAuthorityFixture: {
        app: { collabFor(tabId: string): unknown }
        tabId: string
      }
    }).__collabAuthorityFixture
    return fixture.app.collabFor(fixture.tabId) === undefined
  })).toBe(true)
  await expect(page.getByTestId('collab-current-session')).toHaveCount(0)
  await expect(page.getByTestId('collab-session')).toHaveCount(0)
  await expect(page.getByTestId('collab-unshared')).toBeFocused()
  await expect(page.getByRole('status').first()).toHaveText(
    'The collaboration session closed. The workflow is available locally.',
  )

  await page.evaluate(() => {
    const fixture = (window as unknown as {
      __collabAuthorityFixture: { rejectEnd(reason: Error): void }
    }).__collabAuthorityFixture
    fixture.rejectEnd(new Error('network lost after remote close'))
  })
  await expect(page.getByTestId('collab-end-error')).toContainText('network lost after remote close')
  await expect(page.getByTestId('collab-unshared')).toBeFocused()
  await expect(page.getByRole('status').first()).toHaveText(
    'The end request failed after the collaboration session closed. The workflow is available locally.',
  )
  await page.screenshot({ path: `${evidenceDir}/after-remote-close-end-failure.png`, fullPage: true })
})

test('production leave immediately rejoins a live session through a fresh connection', async ({ page }) => {
  await appReady(page)
  await installProductionCollabTransport(page)
  await shareFromActiveTabMenu(page)
  await openCollaboration(page)
  await expect(page.getByTestId('collab-current-session')).toBeVisible()
  await expect(page.getByTestId('collab-session')).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => {
    const fixture = (window as unknown as {
      __collabAuthorityFixture: { connectionCount(): number; snapshotCount(): number }
    }).__collabAuthorityFixture
    return [fixture.connectionCount(), fixture.snapshotCount()]
  })).toEqual([1, 1])

  await page.getByTestId('collab-leave').click()

  await expect(page.getByTestId('collab-current-session')).toHaveCount(0)
  await expect(page.getByTestId('collab-empty')).toHaveCount(0)
  await expect(page.getByTestId('collab-session')).toHaveCount(1)
  await expect(page.getByTestId('collab-join')).toBeEnabled()
  await expect(page.getByTestId('collab-unshared')).toBeFocused()
  await expect(page.getByRole('status').first()).toHaveText(
    'You left the collaboration session. The workflow is available locally.',
  )
  await page.screenshot({ path: `${evidenceDir}/after-leave-rejoinable.png`, fullPage: true })

  await expect(page.evaluate(() => {
    const fixture = (window as unknown as {
      __collabAuthorityFixture: { connectionClosed(index: number): boolean | undefined }
    }).__collabAuthorityFixture
    return fixture.connectionClosed(0)
  })).resolves.toBe(true)
  await page.getByTestId('collab-join').click()

  await expect(page.getByTestId('collab-panel')).toHaveCount(0)
  await expect(page.getByTestId('collab-button')).toBeFocused()
  await expect.poll(() => page.evaluate(() => {
    const fixture = (window as unknown as {
      __collabAuthorityFixture: {
        app: {
          collabFor(tabId: string): {
            descriptor: { documentId: string }
            session: { doc: { lineage: string }; status: { get(): string } }
          } | undefined
        }
        tabId: string
        connectionCount(): number
        snapshotCount(): number
        connectionClosed(index: number): boolean | undefined
      }
    }).__collabAuthorityFixture
    const membership = fixture.app.collabFor(fixture.tabId)
    return {
      connectionCount: fixture.connectionCount(),
      snapshotCount: fixture.snapshotCount(),
      firstClosed: fixture.connectionClosed(0),
      secondClosed: fixture.connectionClosed(1),
      documentId: membership?.descriptor.documentId,
      lineage: membership?.session.doc.lineage,
      status: membership?.session.status.get(),
    }
  })).toEqual({
    connectionCount: 2,
    snapshotCount: 2,
    firstClosed: true,
    secondClosed: false,
    documentId: await page.evaluate(() => (window as unknown as {
      __collabAuthorityFixture: { tabId: string }
    }).__collabAuthorityFixture.tabId),
    lineage: await page.evaluate(() => (window as unknown as {
      __collabAuthorityFixture: { tabId: string }
    }).__collabAuthorityFixture.tabId),
    status: 'live',
  })

  await openCollaboration(page)
  await expect(page.getByTestId('collab-current-session')).toBeVisible()
  await expect(page.getByTestId('collab-status')).toHaveText('Live')
})

test('tab context menu shares through the existing action and join failures retain focus', async ({ page }) => {
  await routeSessions(page, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ sessions: [session('first'), session('second')] }),
  }))
  await appReady(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    let resolveShare!: (message: string | undefined) => void
    let resolveJoin!: (message: string | undefined) => void
    const share = new Promise<string | undefined>((resolve) => { resolveShare = resolve })
    const join = new Promise<string | undefined>((resolve) => { resolveJoin = resolve })
    ;(app as unknown as {
      shareActiveTab(): Promise<string | undefined>
      joinCollabSession(sessionId: string): Promise<string | undefined>
    }).shareActiveTab = () => share
    ;(app as unknown as {
      joinCollabSession(sessionId: string): Promise<string | undefined>
    }).joinCollabSession = (sessionId) => sessionId === 'first' ? join : Promise.resolve(undefined)
    ;(window as unknown as { __collabFixture: unknown }).__collabFixture = { resolveShare, resolveJoin }
  })

  await shareFromActiveTabMenu(page)
  await expect(page.getByTestId('transient-status')).toContainText('Sharing')
  await page.screenshot({ path: `${evidenceDir}/after-share-progress.png`, fullPage: true })
  await page.evaluate(() => {
    const fixture = (window as unknown as { __collabFixture: { resolveShare(value: string): void } }).__collabFixture
    fixture.resolveShare('share request refused')
  })
  await expect(page.getByTestId('transient-status')).toContainText('Share failed: share request refused')

  await openCollaboration(page)
  await expect(page.getByTestId('collab-session')).toHaveCount(2)

  const joins = page.getByTestId('collab-join')
  await joins.first().focus()
  await joins.first().click()
  await expect(joins.first()).toContainText('Joining')
  await expect(joins.first()).toHaveAttribute('aria-disabled', 'true')
  await expect(joins.nth(1)).toBeEnabled()
  await page.screenshot({ path: `${evidenceDir}/after-join-progress.png`, fullPage: true })
  await page.evaluate(() => {
    const fixture = (window as unknown as { __collabFixture: { resolveJoin(value: string): void } }).__collabFixture
    fixture.resolveJoin('join request refused')
  })
  await expect(page.getByTestId('collab-join-error')).toContainText('join request refused')
  await expect(joins.first()).toBeFocused()
  await page.screenshot({ path: `${evidenceDir}/after-action-failures.png`, fullPage: true })
})

test('leave and destructive end show progress with focus retention and restoration', async ({ page }) => {
  await routeSessions(page, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ sessions: [session(longSessionId, longDocumentId)] }),
  }))
  await appReady(page)
  await installCurrentSession(page)
  await page.evaluate(() => {
    const fixture = (window as unknown as { __collabFixture: { app: unknown } }).__collabFixture
    const app = fixture.app as {
      collabTabs: { get(): ReadonlyMap<string, unknown>; set(value: ReadonlyMap<string, unknown>): void }
      leaveCollabSession(tabId: string): void
      endCollabSession(tabId: string): Promise<string | undefined>
    }
    let resolveEnd!: (message: string | undefined) => void
    const end = new Promise<string | undefined>((resolve) => { resolveEnd = resolve })
    app.endCollabSession = () => end
    app.leaveCollabSession = (tabId) => {
      const memberships = new Map(app.collabTabs.get())
      memberships.delete(tabId)
      app.collabTabs.set(memberships)
    }
    ;(window as unknown as { __collabFixture: unknown }).__collabFixture = { ...fixture, resolveEnd }
  })
  await openCollaboration(page)

  const end = page.getByTestId('collab-end')
  await end.focus()
  await end.click()
  const confirm = page.getByTestId('collab-end-confirm-button')
  await expect(confirm).toBeFocused()
  await page.screenshot({ path: `${evidenceDir}/after-end-confirmation.png`, fullPage: true })
  await confirm.click()
  await expect(confirm).toContainText('Ending session')
  await expect(confirm).toHaveAttribute('aria-busy', 'true')
  await page.screenshot({ path: `${evidenceDir}/after-end-progress.png`, fullPage: true })
  await page.evaluate(() => {
    const fixture = (window as unknown as { __collabFixture: { resolveEnd(value: string): void } }).__collabFixture
    fixture.resolveEnd('session owner refused the request')
  })
  await expect(page.getByTestId('collab-end-error')).toContainText('session owner refused')
  await expect(confirm).toBeFocused()
  await page.getByTestId('collab-end-cancel').click()
  await expect(page.getByTestId('collab-end')).toBeFocused()

  const leave = page.getByTestId('collab-leave')
  await page.evaluate(() => {
    const button = document.querySelector<HTMLElement>('[data-testid="collab-leave"]')!
    const fixture = (window as unknown as { __collabFixture: Record<string, unknown> }).__collabFixture
    const setTimeout = window.setTimeout.bind(window)
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 0 && fixture['releaseLeave'] === undefined) {
        fixture['releaseLeave'] = () => {
          window.setTimeout = setTimeout
          setTimeout(handler, 0, ...args)
        }
        return 0
      }
      return setTimeout(handler, timeout, ...args)
    }) as typeof window.setTimeout
    fixture['leaveProgressSeen'] = button.getAttribute('aria-busy') === 'true'
    new MutationObserver(() => {
      if (button.getAttribute('aria-busy') === 'true' && button.textContent?.includes('Leaving')) {
        fixture['leaveProgressSeen'] = true
      }
    }).observe(button, { attributes: true, childList: true, subtree: true })
  })
  await leave.click()
  await expect.poll(() => page.evaluate(() => {
    const fixture = (window as unknown as { __collabFixture: { leaveProgressSeen: boolean } }).__collabFixture
    return fixture.leaveProgressSeen
  })).toBe(true)
  await page.screenshot({ path: `${evidenceDir}/after-leave-progress.png`, fullPage: true })
  await page.evaluate(() => {
    const fixture = (window as unknown as { __collabFixture: { releaseLeave(): void } }).__collabFixture
    fixture.releaseLeave()
  })
  await expect(page.getByTestId('collab-unshared')).toBeFocused()
  await expect(page.getByTestId('collab-current-session')).toHaveCount(0)
  await expect(page.getByRole('status').first()).toHaveText(
    'You left the collaboration session. The workflow is available locally.',
  )
})

test('successful end invalidates in-flight discovery and preserves its announcement', async ({ page }) => {
  let releaseFirstList!: () => void
  let listCalls = 0
  await routeSessions(page, async (route) => {
    listCalls += 1
    if (listCalls === 1) {
      await new Promise<void>((resolve) => { releaseFirstList = resolve })
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessions: [session(longSessionId, longDocumentId)] }),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [] }) })
  })
  await appReady(page)
  await installCurrentSession(page)
  await page.evaluate(() => {
    const fixture = (window as unknown as { __collabFixture: { app: unknown } }).__collabFixture
    const app = fixture.app as {
      collabTabs: { set(value: ReadonlyMap<string, unknown>): void }
      endCollabSession(tabId: string): Promise<string | undefined>
    }
    app.endCollabSession = async () => {
      app.collabTabs.set(new Map())
      return undefined
    }
  })
  await openCollaboration(page)

  await page.getByTestId('collab-end').click()
  await page.getByTestId('collab-end-confirm-button').click()
  await expect(page.getByTestId('collab-unshared')).toBeFocused()
  await expect(page.getByRole('status').first()).toHaveText(
    'The collaboration session ended for everyone. The workflow is available locally.',
  )

  releaseFirstList()
  await expect.poll(() => listCalls).toBe(2)
  await expect(page.getByTestId('collab-session')).toHaveCount(0)
  await expect(page.getByTestId('collab-empty')).toBeVisible()
  await expect(page.getByRole('status').first()).toHaveText(
    'The collaboration session ended for everyone. The workflow is available locally.',
  )
})

test('genuine narrow view and 200 percent CSS zoom retain long-content tail access', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await routeSessions(page, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ sessions: [session(longSessionId, longDocumentId), session('second', 'another-document')] }),
  }))
  await appReady(page)
  await installCurrentSession(page, 'catching-up')
  await openCollaboration(page)
  const narrowBounds = await page.getByTestId('modal-surface').boundingBox()
  expect(narrowBounds).not.toBeNull()
  expect(narrowBounds!.x).toBeGreaterThanOrEqual(0)
  expect(narrowBounds!.x + narrowBounds!.width).toBeLessThanOrEqual(390)
  const participantRows = await page.getByTestId('collab-participants').locator('li').evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect()
      return { top: bounds.top, bottom: bounds.bottom }
    }),
  )
  expect(participantRows.every((row, index) => index === 0 || row.top >= participantRows[index - 1]!.bottom)).toBe(true)
  const participantViewportBottom = await page.getByTestId('collab-participants').evaluate(
    (element) => element.getBoundingClientRect().bottom,
  )
  expect(participantRows[2]!.bottom).toBeLessThanOrEqual(participantViewportBottom)
  await page.getByTestId('collab-participants').focus()
  await expect(page.getByTestId('collab-participants')).toBeFocused()
  await page.getByTestId('collab-panel').evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: `${evidenceDir}/after-narrow-catching-up.png`, fullPage: true })
  await page.getByTestId('collab-join').last().scrollIntoViewIfNeeded()
  await expect(page.getByTestId('collab-join').last()).toBeInViewport()
  await page.screenshot({ path: `${evidenceDir}/after-narrow-tail.png`, fullPage: true })

  await page.setViewportSize({ width: 1366, height: 768 })
  await page.evaluate(() => { document.documentElement.style.zoom = '2' })
  await page.evaluate(() => {
    const fixture = (window as unknown as { __collabFixture: { status: { set(value: string): void } } }).__collabFixture
    fixture.status.set('error')
  })
  await page.getByTestId('collab-panel').evaluate((element) => { element.scrollTop = 0 })
  await expect(page.getByTestId('collab-status')).toHaveText(/Error/)
  await page.screenshot({ path: `${evidenceDir}/after-zoom-200-error.png`, fullPage: true })
  const lastJoin = page.getByTestId('collab-join').last()
  await lastJoin.evaluate((target) => {
    target.scrollIntoView({ block: 'center' })
  })
  await expect(lastJoin).toBeInViewport()
  const zoomOverflow = await page.getByTestId('collab-panel').evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(zoomOverflow.scrollHeight).toBeGreaterThan(zoomOverflow.clientHeight)
  expect(zoomOverflow.scrollWidth).toBeLessThanOrEqual(zoomOverflow.clientWidth + 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  const zoomBounds = await page.getByTestId('modal-surface').boundingBox()
  expect(zoomBounds).not.toBeNull()
  expect(zoomBounds!.x).toBeGreaterThanOrEqual(0)
  expect(zoomBounds!.x + zoomBounds!.width).toBeLessThanOrEqual(1366)
  await page.screenshot({ path: `${evidenceDir}/after-zoom-200-tail.png`, fullPage: true })
})

test('reduced motion keeps loading presentation static and reachable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await routeSessions(page, async () => { await new Promise(() => {}) })
  await appReady(page)
  await openCollaboration(page)
  await expect(page.getByTestId('collab-loading')).toBeVisible()
  const duration = await page.getByTestId('collab-loading').locator('.collab-spinner').evaluate(
    (element) => getComputedStyle(element).animationDuration,
  )
  expect(duration).toBe('0s')
  await page.screenshot({ path: `${evidenceDir}/after-reduced-motion-loading.png`, fullPage: true })
})
