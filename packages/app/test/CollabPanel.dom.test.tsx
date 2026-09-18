// @vitest-environment happy-dom

import {
  createSignal as createCoreSignal,
  type CollabConnection,
  type CollabConnectionEvent,
  type CollabSessionDescriptor,
  type SharedSessionStatus,
} from '@dinkster/core'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppState, type CollabTabState, type Tab } from '../src/app-state.js'
import type { CollabTransport } from '../src/collab.js'
import { CollabPanel } from '../src/CollabPanel.js'
import { SettingsRegistry } from '../src/settings.js'

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }
const nextTask = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); await flush() }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const descriptor = (sessionId = 'session-one', documentId = 'document-one'): CollabSessionDescriptor => ({
  protocolVersion: 1,
  sessionId,
  scope: 'shared',
  documentId,
  revision: 17,
  snapshotRevision: 12,
})

function membership(
  status: ReturnType<typeof createCoreSignal<SharedSessionStatus>>,
  remoteIds: readonly (string | {
    readonly actorId: string
    readonly identity?: { readonly kind: 'human' | 'agent'; readonly displayName?: string; readonly owner?: string; readonly harness?: string }
    readonly proposals?: readonly { readonly id: string; readonly settingId: string; readonly value: boolean | number | string | null; readonly note?: string }[]
  })[] = [],
  session = descriptor(),
): CollabTabState {
  const remotes = createCoreSignal(new Map(remoteIds.map((remote) => {
    const value = typeof remote === 'string' ? { actorId: remote } : remote
    return [value.actorId, value]
  })))
  return {
    descriptor: session,
    baseUrl: 'http://backend.test/a/long/collaboration/path',
    session: { status, doc: { lineage: session.documentId } },
    presence: { remotes },
  } as unknown as CollabTabState
}

function mount(options: {
  readonly backend?: boolean
  readonly sessions?: readonly CollabSessionDescriptor[]
  readonly current?: CollabTabState
  readonly list?: () => Promise<readonly CollabSessionDescriptor[]>
  readonly join?: (sessionId: string) => Promise<string | undefined>
  readonly end?: (tabId: string) => Promise<string | undefined>
  readonly tab?: 'none'
} = {}) {
  const tab = {
    id: options.current?.session.doc.lineage ?? 'document-one',
    title: 'A workflow with a deliberately long title that still wraps',
  } as Tab
  const tabs = createCoreSignal<readonly Tab[]>(options.tab === 'none' ? [] : [tab])
  const activeTabId = createCoreSignal<string | undefined>(options.tab === 'none' ? undefined : tab.id)
  const collabTabs = createCoreSignal<ReadonlyMap<string, CollabTabState>>(
    options.current === undefined ? new Map() : new Map([[tab.id, options.current]]),
  )
  const list = vi.fn(options.list ?? (async () => options.sessions ?? []))
  const join = vi.fn(options.join ?? (async () => undefined))
  const leave = vi.fn((tabId: string) => {
    const next = new Map(collabTabs.get())
    next.delete(tabId)
    collabTabs.set(next)
  })
  const end = vi.fn(options.end ?? (async (tabId: string) => {
    leave(tabId)
    return undefined
  }))
  const requestClose = vi.fn()
  const settings = new SettingsRegistry(undefined)
  settings.register({ id: 'canvas.grid.visible', name: 'Show canvas grid', type: 'boolean', defaultValue: true })
  const app = {
    tabs,
    activeTabId,
    collabTabs,
    readOnlyCollabDocument: createCoreSignal<ReturnType<AppState['readOnlyCollabDocument']['get']>>(undefined),
    dismissCollabDocument: () => app.readOnlyCollabDocument.set(undefined),
    collabActorId: 'local-actor-with-a-deliberately-long-identity',
    collabBackend: () => options.backend === false ? undefined : {},
    listCollabSessions: list,
    joinCollabSession: join,
    leaveCollabSession: leave,
    endCollabSession: end,
    settings,
  } as unknown as AppState
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <CollabPanel app={app} requestClose={requestClose} />, root)
  return { root, app, tabs, activeTabId, collabTabs, list, join, leave, end, requestClose, unmount }
}

function mountProductionRace() {
  let snapshot: unknown
  let snapshotCount = 0
  let currentDescriptor: CollabSessionDescriptor | undefined
  let rejectEnd!: (reason: Error) => void
  const pendingEnd = new Promise<void>((_resolve, reject) => { rejectEnd = reject })
  const connections: Array<{
    closed: boolean
    listeners: Set<(event: CollabConnectionEvent) => void>
  }> = []
  const connect = (): CollabConnection => {
    const state = {
      closed: false,
      listeners: new Set<(event: CollabConnectionEvent) => void>(),
    }
    connections.push(state)
    return {
      sessionId: 'production-watcher-session',
      postOp: async () => ({ kind: 'error', message: 'unexpected operation in management proof' }),
      fetchSnapshot: async () => {
        snapshotCount += 1
        if (snapshot === undefined) throw new Error('missing collaboration fixture snapshot')
        return { revision: 0, document: snapshot }
      },
      fetchOps: async () => ({ kind: 'ops', ops: [] }),
      putSnapshot: async () => ({ kind: 'ok' }),
      sendPresence: () => {},
      onEvent: (listener) => {
        state.listeners.add(listener)
        queueMicrotask(() => {
          if (!state.closed && currentDescriptor !== undefined) {
            listener({ kind: 'connected', descriptor: currentDescriptor })
          }
        })
        return () => state.listeners.delete(listener)
      },
      close: () => { state.closed = true },
    }
  }
  const transport: CollabTransport = {
    create: async (_baseUrl, args) => {
      snapshot = structuredClone(args.snapshot)
      currentDescriptor = {
        ...descriptor('production-watcher-session', args.documentId),
        revision: 0,
        snapshotRevision: 0,
      }
      return currentDescriptor
    },
    list: async () => currentDescriptor === undefined ? [] : [currentDescriptor],
    get: async (_baseUrl, sessionId) => sessionId === 'production-watcher-session' ? currentDescriptor : undefined,
    end: () => pendingEnd,
    connect,
  }
  const app = new AppState({ collabTransport: transport })
  app.addBackend('http://collab.test', 'Collaboration test', false, 'dinkster')
  const root = document.createElement('div')
  document.body.append(root)
  const requestClose = vi.fn()
  const unmount = render(() => <CollabPanel app={app} requestClose={requestClose} />, root)
  return {
    app,
    root,
    unmount,
    requestClose,
    rejectEnd,
    connectionCount: () => connections.length,
    snapshotCount: () => snapshotCount,
    connectionClosed: (index: number) => connections[index]?.closed,
    emitClosed: () => {
      for (const connection of connections) {
        if (connection.closed) continue
        for (const listener of [...connection.listeners]) listener({ kind: 'session-closed' })
      }
    },
  }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('CollabPanel', () => {
  it('distinguishes initial loading, no backend, empty, and list failure', async () => {
    const loadingList = deferred<readonly CollabSessionDescriptor[]>()
    const loading = mount({ list: () => loadingList.promise })
    expect(loading.root.querySelector('[data-testid="collab-loading"]')).not.toBeNull()
    expect(loading.root.querySelector('[data-testid="collab-refresh"]')?.getAttribute('aria-disabled')).toBe('true')
    loadingList.resolve([])
    await flush()
    expect(loading.root.querySelector('[data-testid="collab-empty"]')?.textContent).toContain('No shared sessions')
    loading.unmount()
    loading.root.remove()

    const unavailable = mount({ backend: false })
    await flush()
    expect(unavailable.list).not.toHaveBeenCalled()
    expect(unavailable.root.querySelector('[data-testid="collab-no-backend"]')?.textContent).toContain('No collaboration backend')
    expect(unavailable.root.querySelector('[data-testid="collab-unshared"]')?.textContent).toContain('Not shared')
    expect(unavailable.root.querySelector('[data-testid="collab-share"]')).toBeNull()
    unavailable.unmount()
    unavailable.root.remove()

    const failed = mount({ list: async () => { throw new Error('backend unavailable') } })
    await flush()
    expect(failed.root.querySelector('[data-testid="collab-list-error"]')?.textContent).toContain('backend unavailable')
    expect(failed.root.querySelector('[data-testid="collab-empty"]')).toBeNull()
  })

  it('explains why sharing is unavailable without a tab or for execution snapshots', async () => {
    const view = mount({ tab: 'none' })
    await flush()
    const message = () => view.root.querySelector('[data-testid="collab-unshared"]')?.textContent
    expect(message()).toContain('Open a workflow to share it from its tab menu.')

    const frozen = { id: 'frozen-tab', title: 'Snapshot', execution: {} } as Tab
    view.tabs.set([frozen])
    view.activeTabId.set(frozen.id)
    await flush()
    expect(message()).toContain('Execution snapshots cannot be shared.')

    const local = { id: 'local-tab', title: 'Local' } as Tab
    view.tabs.set([local])
    view.activeTabId.set(local.id)
    await flush()
    expect(message()).toContain('This workflow is local. Open its tab menu to start sharing.')
  })

  it('presents authoritative statuses, long identities, and bounded participant overflow', async () => {
    const status = createCoreSignal<SharedSessionStatus>('live')
    const longSession = descriptor(
      `session-${'s'.repeat(90)}`,
      `document-${'d'.repeat(90)}`,
    )
    const current = membership(status, Array.from({ length: 12 }, (_, index) => `remote-${index}-${'r'.repeat(50)}`), longSession)
    const mounted = mount({ current, sessions: [longSession] })
    await flush()

    expect(mounted.root.querySelector('[data-testid="collab-current-session"]')?.textContent).toContain(longSession.sessionId)
    expect(mounted.root.querySelector('[data-testid="collab-session"]')?.textContent).toContain(longSession.documentId)
    expect(mounted.root.querySelectorAll('[data-testid="collab-participant"]')).toHaveLength(12)
    const participants = mounted.root.querySelector<HTMLElement>('[data-testid="collab-participants"]')!
    expect(participants.querySelector('[data-actor-id^="remote-11-"]')?.textContent).toContain('remote')
    expect(participants.tabIndex).toBe(0)
    expect(participants.getAttribute('aria-label')).toBe('Participants in this collaboration session')

    for (const [next, label] of [
      ['catching-up', 'Catching up'],
      ['closed', 'Closed'],
      ['error', 'Error'],
      ['live', 'Live'],
    ] as const) {
      status.set(next)
      await flush()
      const badge = mounted.root.querySelector('[data-testid="collab-status"]')!
      expect(badge.textContent).toContain(label)
      expect(badge.getAttribute('aria-label')).toBe(`Collaboration status: ${label}`)
    }
  })

  it('identifies agent participants and who runs them', async () => {
    const current = membership(createCoreSignal<SharedSessionStatus>('live'), [{
      actorId: 'agent-actor-id',
      identity: { kind: 'agent', displayName: 'headless-demo', owner: 'Ada', harness: 'cli' },
    }])
    const mounted = mount({ current })
    await flush()

    const participant = mounted.root.querySelector('[data-testid="collab-participant"]')!
    expect(participant.textContent).toContain('headless-demo')
    expect(participant.textContent).toContain('agent')
    expect(participant.textContent).toContain('run by Ada (cli)')
    expect(participant.textContent).not.toContain('agent-actor-id')
  })

  it('reviews, applies, and locally dismisses agent setting proposals', async () => {
    const current = membership(createCoreSignal<SharedSessionStatus>('live'), [{
      actorId: 'agent-settings',
      identity: { kind: 'agent', displayName: 'settings helper' },
      proposals: [
        { id: 'valid', settingId: 'canvas.grid.visible', value: false, note: 'Reduce visual clutter' },
        { id: 'unknown', settingId: 'future.setting', value: true },
        { id: 'invalid', settingId: 'canvas.grid.visible', value: 7 },
      ],
    }])
    const mounted = mount({ current })
    await flush()

    const cards = mounted.root.querySelectorAll<HTMLElement>('[data-testid="collab-proposal"]')
    expect(cards).toHaveLength(3)
    expect(cards[0]!.textContent).toContain('settings helper')
    expect(cards[0]!.textContent).toContain('Show canvas grid')
    expect(cards[0]!.textContent).toContain('canvas.grid.visible')
    expect(cards[0]!.textContent).toContain('Current valuetrue')
    expect(cards[0]!.textContent).toContain('Proposed valuefalse')
    expect(cards[0]!.textContent).toContain('Reduce visual clutter')

    cards[0]!.querySelector<HTMLButtonElement>('[data-testid="collab-proposal-apply"]')!.click()
    await flush()
    expect(mounted.app.settings.get('canvas.grid.visible')).toBe(false)
    expect(cards[0]!.querySelector('[data-testid="collab-proposal-apply"]')?.textContent).toBe('Applied')

    expect(cards[1]!.textContent).toContain('Not available in this client')
    expect(cards[1]!.querySelector<HTMLButtonElement>('[data-testid="collab-proposal-apply"]')!.disabled).toBe(true)
    expect(cards[2]!.textContent).toContain('Invalid value')
    expect(cards[2]!.querySelector<HTMLButtonElement>('[data-testid="collab-proposal-apply"]')!.disabled).toBe(true)

    cards[0]!.querySelector<HTMLButtonElement>('[data-testid="collab-proposal-dismiss"]')!.click()
    await flush()
    expect(mounted.root.querySelector('[data-proposal-id="valid"]')).toBeNull()
    expect(current.presence.remotes.get().get('agent-settings')?.proposals).toHaveLength(3)
  })

  it('keeps join progress and failures scoped to the exact action', async () => {
    const firstJoin = deferred<string | undefined>()
    const sessions = [descriptor('first'), descriptor('second')]
    const mounted = mount({
      sessions,
      join: (sessionId) => sessionId === 'first' ? firstJoin.promise : Promise.resolve(undefined),
    })
    await flush()

    const joins = mounted.root.querySelectorAll<HTMLButtonElement>('[data-testid="collab-join"]')
    joins[0]!.focus()
    joins[0]!.click()
    expect(joins[0]!.textContent).toContain('Joining')
    expect(joins[0]!.getAttribute('aria-disabled')).toBe('true')
    expect(joins[1]!.getAttribute('aria-disabled')).toBe('false')
    firstJoin.resolve('join request refused')
    await flush()
    expect(mounted.root.querySelector('[data-testid="collab-join-error"]')?.textContent).toContain('join request refused')
    expect(document.activeElement).toBe(joins[0])
  })

  it('shows leave progress and moves focus to the truthful local state', async () => {
    const mounted = mount({ current: membership(createCoreSignal<SharedSessionStatus>('live')) })
    await flush()
    const leave = mounted.root.querySelector<HTMLButtonElement>('[data-testid="collab-leave"]')!
    leave.click()
    expect(leave.textContent).toContain('Leaving')
    expect(leave.getAttribute('aria-busy')).toBe('true')
    await nextTask()

    expect(mounted.leave).toHaveBeenCalledWith('document-one')
    expect(mounted.root.querySelector('[data-testid="collab-unshared"]')).toBe(document.activeElement)
    expect(mounted.root.querySelector('[data-testid="collab-current-session"]')).toBeNull()
    expect(mounted.root.querySelector('[role="status"]')?.textContent).toContain('You left the collaboration session')
  })

  it('rejoins a live server descriptor through a fresh connection after leaving', async () => {
    const mounted = mountProductionRace()
    await flush()

    await mounted.app.shareActiveTab()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="collab-refresh"]')!.click()
    await nextTask()
    const tabId = mounted.app.activeTab()!.id
    expect(mounted.app.collabFor(tabId)).toBeDefined()
    expect(mounted.root.querySelector('[data-testid="collab-session"]')).not.toBeNull()
    expect(mounted.connectionCount()).toBe(1)
    expect(mounted.snapshotCount()).toBe(1)

    mounted.root.querySelector<HTMLButtonElement>('[data-testid="collab-leave"]')!.click()
    await nextTask()

    expect(mounted.app.collabFor(tabId)).toBeUndefined()
    expect(mounted.connectionClosed(0)).toBe(true)
    expect(mounted.root.querySelector('[data-testid="collab-current-session"]')).toBeNull()
    expect(mounted.root.querySelector('[data-testid="collab-empty"]')).toBeNull()
    expect(mounted.root.querySelectorAll('[data-testid="collab-session"]')).toHaveLength(1)
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-testid="collab-join"]')?.disabled).toBe(false)
    expect(mounted.root.querySelector('[data-testid="collab-unshared"]')).toBe(document.activeElement)
    expect(mounted.root.querySelector('[role="status"]')?.textContent).toContain(
      'You left the collaboration session. The workflow is available locally.',
    )

    mounted.root.querySelector<HTMLButtonElement>('[data-testid="collab-join"]')!.click()
    await nextTask()

    const rejoined = mounted.app.collabFor(tabId)
    expect(mounted.connectionCount()).toBe(2)
    expect(mounted.snapshotCount()).toBe(2)
    expect(mounted.connectionClosed(0)).toBe(true)
    expect(mounted.connectionClosed(1)).toBe(false)
    expect(rejoined?.descriptor.documentId).toBe(tabId)
    expect(rejoined?.session.doc.lineage).toBe(tabId)
    expect(rejoined?.session.status.get()).toBe('live')
    expect(mounted.requestClose).toHaveBeenCalledOnce()
  })

  it('announces membership fallback and restores focus to the local workflow', async () => {
    const mounted = mount({
      current: membership(createCoreSignal<SharedSessionStatus>('live')),
      sessions: [descriptor()],
    })
    await flush()
    mounted.root.querySelector<HTMLElement>('[data-testid="collab-participants"]')!.focus()

    mounted.collabTabs.set(new Map())
    await flush()

    expect(mounted.root.querySelector('[data-testid="collab-unshared"]')).toBe(document.activeElement)
    expect(mounted.root.querySelector('[data-testid="collab-session"]')).toBeNull()
    expect(mounted.root.querySelector('[role="status"]')?.textContent).toContain(
      'The collaboration session closed. The workflow is available locally.',
    )
  })

  it('keeps remote fallback and an in-flight end failure visible and truthful', async () => {
    const mounted = mountProductionRace()
    await flush()

    await mounted.app.shareActiveTab()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="collab-refresh"]')!.click()
    await nextTask()
    const tabId = mounted.app.activeTab()!.id
    expect(mounted.app.collabFor(tabId)).toBeDefined()
    expect(mounted.root.querySelector('[data-testid="collab-session"]')).not.toBeNull()

    mounted.root.querySelector<HTMLButtonElement>('[data-testid="collab-end"]')!.click()
    await flush()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="collab-end-confirm-button"]')!.click()
    mounted.emitClosed()
    await nextTask()

    expect(mounted.app.collabFor(tabId)).toBeUndefined()
    expect(mounted.root.querySelector('[data-testid="collab-unshared"]')).toBe(document.activeElement)
    expect(mounted.root.querySelector('[data-testid="collab-session"]')).toBeNull()
    expect(mounted.root.querySelector('[role="status"]')?.textContent).toContain(
      'The collaboration session closed. The workflow is available locally.',
    )

    mounted.rejectEnd(new Error('network lost after remote close'))
    await nextTask()

    expect(mounted.root.querySelector('[data-testid="collab-end-error"]')?.textContent).toContain(
      'network lost after remote close',
    )
    expect(mounted.root.querySelector('[data-testid="collab-unshared"]')).toBe(document.activeElement)
    expect(mounted.root.querySelector('[role="status"]')?.textContent).toContain(
      'The end request failed after the collaboration session closed. The workflow is available locally.',
    )
  })

  it('invalidates stale discovery after end and preserves the action success announcement', async () => {
    const firstList = deferred<readonly CollabSessionDescriptor[]>()
    let listCalls = 0
    const current = membership(createCoreSignal<SharedSessionStatus>('live'))
    const mounted = mount({
      current,
      list: () => ++listCalls === 1 ? firstList.promise : Promise.resolve([]),
    })
    await flush()

    mounted.root.querySelector<HTMLButtonElement>('[data-testid="collab-end"]')!.click()
    await flush()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="collab-end-confirm-button"]')!.click()
    await flush()
    expect(mounted.root.querySelector('[role="status"]')?.textContent).toContain(
      'The collaboration session ended for everyone. The workflow is available locally.',
    )

    firstList.resolve([descriptor()])
    await nextTask()

    expect(listCalls).toBe(2)
    expect(mounted.root.querySelector('[data-testid="collab-session"]')).toBeNull()
    expect(mounted.root.querySelector('[data-testid="collab-empty"]')).not.toBeNull()
    expect(mounted.root.querySelector('[role="status"]')?.textContent).toContain(
      'The collaboration session ended for everyone. The workflow is available locally.',
    )
  })

  it('requires end confirmation and retains or restores focus across failure and cancel', async () => {
    const ending = deferred<string | undefined>()
    const mounted = mount({
      current: membership(createCoreSignal<SharedSessionStatus>('live')),
      end: () => ending.promise,
    })
    await flush()

    const end = mounted.root.querySelector<HTMLButtonElement>('[data-testid="collab-end"]')!
    end.focus()
    end.click()
    await flush()
    const confirm = mounted.root.querySelector<HTMLButtonElement>('[data-testid="collab-end-confirm-button"]')!
    expect(document.activeElement).toBe(confirm)
    expect(mounted.end).not.toHaveBeenCalled()

    confirm.click()
    expect(confirm.textContent).toContain('Ending session')
    expect(confirm.getAttribute('aria-busy')).toBe('true')
    ending.resolve('session owner refused the request')
    await flush()
    expect(mounted.root.querySelector('[data-testid="collab-end-error"]')?.textContent).toContain('session owner refused')
    expect(mounted.root.querySelector('[data-testid="collab-end-confirm"]')).not.toBeNull()
    expect(document.activeElement).toBe(confirm)

    mounted.root.querySelector<HTMLButtonElement>('[data-testid="collab-end-cancel"]')!.click()
    await flush()
    const restored = mounted.root.querySelector<HTMLButtonElement>('[data-testid="collab-end"]')!
    expect(document.activeElement).toBe(restored)
  })

  it('closes after an authoritative join success and announces state changes', async () => {
    const mounted = mount({ sessions: [descriptor()] })
    await flush()
    mounted.root.querySelector<HTMLButtonElement>('[data-testid="collab-join"]')!.click()
    await flush()

    expect(mounted.requestClose).toHaveBeenCalledOnce()
    expect(mounted.root.querySelector('[role="status"]')?.textContent).toContain('Joined session session-one')
  })

  it('shows an unsupported document checkpoint as read-only text', async () => {
    const mounted = mount()
    mounted.app.readOnlyCollabDocument.set({
      descriptor: { ...descriptor(), documentKind: 'example.notes' },
      document: createCoreSignal({ text: '<script>not executable</script>' }),
    })
    await flush()
    const preview = mounted.root.querySelector('[data-testid="collab-read-only"]')!
    expect(preview.textContent).toContain('example.notes')
    expect(preview.querySelector('pre')?.textContent).toContain('<script>not executable</script>')
    expect(preview.querySelector('script')).toBeNull()
    expect(preview.querySelector('input, textarea, [contenteditable]')).toBeNull()
    preview.querySelector<HTMLButtonElement>('button')!.click()
    await flush()
    expect(mounted.root.querySelector('[data-testid="collab-read-only"]')).toBeNull()
  })
})
