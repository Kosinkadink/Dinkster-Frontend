import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { CollabSessionDescriptor, SharedSessionStatus } from '@dinkster/core'
import type { AppState, CollabTabState, Tab } from './app-state.js'
import { actorColor, actorLabel } from './collab-presence.js'
import { CollabParticipants } from './CollabParticipants.js'
import { ProductActionFooter, ProductNotice } from './ProductForm.js'
import { useSignal } from './solid-adapter.js'
import { useAppMessage } from './locale.js'

type CollabActionKey = 'refresh' | 'leave' | 'end' | `join:${string}`
type SessionListState = 'loading' | 'ready' | 'unavailable' | 'error'

const actionError = (error: unknown): string => error instanceof Error ? error.message : String(error)

const statusLabel = (status: SharedSessionStatus): string => {
  switch (status) {
    case 'live': return 'Live'
    case 'catching-up': return 'Catching up'
    case 'closed': return 'Closed'
    case 'error': return 'Error'
    default: return status
  }
}

const statusDetail = (status: SharedSessionStatus): string => {
  switch (status) {
    case 'live': return 'Edits are synchronized with everyone in this session.'
    case 'catching-up': return 'Receiving changes before live editing resumes.'
    case 'closed': return 'This session has ended. Keep the current workflow by leaving the session.'
    case 'error': return 'Synchronization stopped. Leave to keep the current workflow locally.'
    default: return 'Session status reported by the collaboration service.'
  }
}

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const settingValueLabel = (value: unknown): string => JSON.stringify(value) ?? 'undefined'

export function CollabPanel(props: { app: AppState; requestClose: () => void }) {
  const message = useAppMessage()
  const tabs = useSignal(props.app.tabs)
  const activeTabId = useSignal(props.app.activeTabId)
  const collabTabs = useSignal(props.app.collabTabs)
  const readOnlyDocument = useSignal(props.app.readOnlyCollabDocument)
  const activeTab = (): Tab | undefined => tabs().find((tab) => tab.id === activeTabId())
  const activeCollab = (): CollabTabState | undefined => {
    const tab = activeTab()
    return tab === undefined ? undefined : collabTabs().get(tab.id)
  }
  const backend = () => props.app.collabBackend()

  const [pending, setPending] = createSignal<ReadonlySet<CollabActionKey>>(new Set())
  const [failures, setFailures] = createSignal<ReadonlyMap<CollabActionKey, string>>(new Map())
  const [announcement, setAnnouncement] = createSignal('')
  const [sessions, setSessions] = createSignal<readonly CollabSessionDescriptor[]>([])
  const [listState, setListState] = createSignal<SessionListState>('loading')
  const [confirmingEnd, setConfirmingEnd] = createSignal<string>()
  let unsharedState: HTMLElement | undefined
  let currentSessionCard: HTMLElement | undefined
  let endButton: HTMLButtonElement | undefined
  let confirmEndButton: HTMLButtonElement | undefined
  let panel: HTMLDivElement | undefined
  let refreshRevision = 0
  let refreshQueued = false
  const closedSessions = new Set<string>()

  const isPending = (key: CollabActionKey): boolean => pending().has(key)
  const setActionPending = (key: CollabActionKey, value: boolean): void => {
    setPending((current) => {
      const next = new Set(current)
      if (value) next.add(key)
      else next.delete(key)
      return next
    })
  }
  const setFailure = (key: CollabActionKey, message: string | undefined): void => {
    setFailures((current) => {
      const next = new Map(current)
      if (message === undefined) next.delete(key)
      else next.set(key, message)
      return next
    })
  }
  const failureFor = (key: CollabActionKey): string | undefined => failures().get(key)
  const focusSoon = (target: () => HTMLElement | undefined): void => {
    queueMicrotask(() => target()?.focus())
  }

  const refresh = async (
    initial = false,
    preserveAnnouncement = false,
    supersedePending = false,
  ): Promise<void> => {
    if (isPending('refresh')) {
      if (supersedePending) {
        refreshRevision += 1
        refreshQueued = true
      }
      return
    }
    if (backend() === undefined) {
      setSessions([])
      setListState('unavailable')
      setFailure('refresh', undefined)
      return
    }
    const revision = ++refreshRevision
    setActionPending('refresh', true)
    setFailure('refresh', undefined)
    if (sessions().length === 0) setListState('loading')
    if (!initial && !preserveAnnouncement) setAnnouncement('Refreshing shared sessions.')
    try {
      const next = (await props.app.listCollabSessions()).filter((session) => !closedSessions.has(session.sessionId))
      if (revision !== refreshRevision) return
      setSessions(next)
      setListState('ready')
      if (!preserveAnnouncement) {
        setAnnouncement(next.length === 1 ? '1 shared session available.' : `${next.length} shared sessions available.`)
      }
    } catch (error) {
      if (revision !== refreshRevision) return
      setListState('error')
      setFailure('refresh', actionError(error))
      if (!preserveAnnouncement) setAnnouncement('Shared sessions could not be loaded.')
    } finally {
      setActionPending('refresh', false)
      if (refreshQueued) {
        refreshQueued = false
        void refresh(false, true)
      }
    }
  }

  createEffect<CollabTabState | undefined>((previous) => {
    const current = activeCollab()
    if (previous === undefined && current !== undefined) {
      setFailure('leave', undefined)
      setFailure('end', undefined)
    }
    if (
      previous !== undefined && current === undefined &&
      activeTab()?.id === previous.session.doc.lineage
    ) {
      const leaving = isPending('leave')
      setConfirmingEnd(undefined)
      if (!leaving) {
        setAnnouncement('The collaboration session closed. The workflow is available locally.')
        closedSessions.add(previous.descriptor.sessionId)
        setSessions((sessions) => sessions.filter((session) => session.sessionId !== previous.descriptor.sessionId))
      }
      void refresh(false, true, true)
      focusSoon(() => unsharedState)
    }
    return current
  }, activeCollab())

  const runAction = async (
    key: CollabActionKey,
    progress: string,
    success: string,
    operation: () => Promise<string | undefined>,
    onSuccess?: () => void,
    failureAnnouncement?: () => string | undefined,
  ): Promise<void> => {
    if (isPending(key)) return
    setActionPending(key, true)
    setFailure(key, undefined)
    setAnnouncement(progress)
    const announceFailure = (): void => {
      setAnnouncement(
        failureAnnouncement?.() ?? `${progress.replace(/\.$/, '')} failed.`,
      )
    }
    try {
      const error = await operation()
      if (error !== undefined) {
        setFailure(key, error)
        announceFailure()
        return
      }
      setAnnouncement(success)
      onSuccess?.()
    } catch (error) {
      setFailure(key, actionError(error))
      announceFailure()
    } finally {
      setActionPending(key, false)
    }
  }

  const leave = (tabId: string): void => {
    void runAction(
      'leave',
      'Leaving this session.',
      'You left the collaboration session. The workflow is available locally.',
      async () => {
        await nextTask()
        props.app.leaveCollabSession(tabId)
        return undefined
      },
      () => {
        setConfirmingEnd(undefined)
        void refresh(false, true, true)
        focusSoon(() => unsharedState)
      },
    )
  }

  const end = (tabId: string, sessionId: string): void => {
    void runAction(
      'end',
      'Ending this session for everyone.',
      'The collaboration session ended for everyone. The workflow is available locally.',
      () => props.app.endCollabSession(tabId),
      () => {
        setConfirmingEnd(undefined)
        closedSessions.add(sessionId)
        setSessions((current) => current.filter((session) => session.sessionId !== sessionId))
        void refresh(false, true, true)
        focusSoon(() => unsharedState)
      },
      () => closedSessions.has(sessionId)
        ? 'The end request failed after the collaboration session closed. The workflow is available locally.'
        : undefined,
    )
  }

  const join = (sessionId: string): void => {
    const key = `join:${sessionId}` as const
    void runAction(
      key,
      `Joining session ${sessionId}.`,
      `Joined session ${sessionId}.`,
      () => props.app.joinCollabSession(sessionId),
      () => {
        if (props.app.readOnlyCollabDocument.get()?.descriptor.sessionId !== sessionId) props.requestClose()
      },
    )
  }

  const askToEnd = (sessionId: string): void => {
    setConfirmingEnd(sessionId)
    setFailure('end', undefined)
    setAnnouncement('Confirm ending this session for everyone.')
    focusSoon(() => confirmEndButton)
  }

  const cancelEnd = (): void => {
    setConfirmingEnd(undefined)
    setFailure('end', undefined)
    setAnnouncement('Ending the session was canceled.')
    focusSoon(() => endButton)
  }

  onMount(() => {
    const fitPanelToViewport = (): void => {
      if (panel === undefined) return
      const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1
      const header = panel.closest('dialog')?.querySelector<HTMLElement>('.dock-header')
      const headerHeight = (header?.getBoundingClientRect().height ?? 40) / zoom
      panel.style.maxHeight = `${Math.max(160, window.innerHeight / zoom - headerHeight - 32)}px`
    }
    const rootStyleObserver = new MutationObserver(fitPanelToViewport)
    rootStyleObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    window.addEventListener('resize', fitPanelToViewport)
    fitPanelToViewport()
    void refresh(true)
    onCleanup(() => {
      rootStyleObserver.disconnect()
      window.removeEventListener('resize', fitPanelToViewport)
    })
  })

  return (
    <div ref={panel} class="collab-panel" data-testid="collab-panel">
      <p class="collab-announcer" role="status" aria-live="polite" aria-atomic="true">{announcement()}</p>

      <section class="collab-current" aria-labelledby="collab-current-heading">
        <header class="collab-section-heading">
          <div>
            <span class="collab-eyebrow">Active workflow</span>
            <h2 id="collab-current-heading">This workflow</h2>
          </div>
        </header>
        <Show
          when={activeCollab()}
          keyed
          fallback={
            <article ref={unsharedState} class="collab-unshared" data-testid="collab-unshared" tabindex="-1">
              <strong>Not shared</strong>
              <p>{
                activeTab() === undefined ? 'Open a workflow to share it from its tab menu.'
                : activeTab()!.execution !== undefined ? 'Execution snapshots cannot be shared.'
                : 'This workflow is local. Open its tab menu to start sharing.'
              }</p>
              <Show when={backend() === undefined}>
                <ProductNotice tone="info" testId="collab-backend-unavailable">
                  Connect a Dinkster backend to host collaboration sessions.
                </ProductNotice>
              </Show>
            </article>
          }
        >
          {(entry) => {
            const status = useSignal(entry.session.status)
            const remotes = useSignal(entry.presence.remotes)
            const settingsRevision = useSignal(props.app.settings.changed)
            const [appliedProposals, setAppliedProposals] = createSignal<ReadonlySet<string>>(new Set())
            const [dismissedProposals, setDismissedProposals] = createSignal<ReadonlySet<string>>(new Set())
            const proposals = () => [...remotes().values()].flatMap((remote) =>
              remote.identity?.kind === 'agent'
                ? (remote.proposals ?? []).map((proposal) => ({ remote, proposal, key: JSON.stringify([remote.actorId, proposal.id]) }))
                : [],
            ).filter(({ key }) => !dismissedProposals().has(key))
            const updateProposalState = (
              setter: (value: (current: ReadonlySet<string>) => ReadonlySet<string>) => void,
              key: string,
            ): void => setter((current) => new Set(current).add(key))
            const tabId = entry.session.doc.lineage
            const ending = () => confirmingEnd() === entry.descriptor.sessionId
            return (
              <article
                ref={currentSessionCard}
                class="collab-session-card collab-current-card"
                data-testid="collab-current-session"
                data-status={status()}
                tabindex="-1"
              >
                <header class="collab-session-card-heading">
                  <div class="collab-session-identity">
                    <h3>{activeTab()?.title ?? entry.descriptor.documentId}</h3>
                    <code>{entry.descriptor.documentId}</code>
                  </div>
                  <span
                    class="collab-status"
                    data-testid="collab-status"
                    data-status={status()}
                    role="status"
                    aria-live="polite"
                    aria-label={`Collaboration status: ${statusLabel(status())}`}
                  >
                    <span aria-hidden="true" />{statusLabel(status())}
                  </span>
                </header>
                <p class="collab-status-detail">{statusDetail(status())}</p>
                <dl class="collab-facts">
                  <div><dt>Session</dt><dd><code>{entry.descriptor.sessionId}</code></dd></div>
                  <div><dt>Backend</dt><dd><code>{entry.baseUrl || 'This server'}</code></dd></div>
                </dl>

                <section class="collab-participant-section" aria-labelledby="collab-participants-heading">
                  <header>
                    <h4 id="collab-participants-heading">Participants</h4>
                    <span>{remotes().size + 1} here now</span>
                  </header>
                  <ul
                    class="collab-participants"
                    data-testid="collab-participants"
                    tabindex="0"
                    aria-label="Participants in this collaboration session"
                  >
                    <li>
                      <span class="collab-swatch" style={{ background: actorColor(props.app.collabActorId) }} />
                      <code>{actorLabel(props.app.collabActorId)}</code>
                      <span class="collab-you">You</span>
                    </li>
                    <For each={[...remotes().values()]}>
                      {(remote) => (
                        <li data-testid="collab-participant" data-actor-id={remote.actorId}>
                          <span class="collab-swatch" style={{ background: actorColor(remote.actorId) }} />
                          <span class="collab-participant-identity">
                            <code>{remote.identity?.displayName ?? actorLabel(remote.actorId)}</code>
                            <Show when={remote.activity}>{(activity) => (
                              <span class="collab-participant-identity" data-testid="agent-activity" aria-live="polite">
                                <small>{message('collab.agentActivity.status', { tool: activity().tool, status: activity().status })}</small>
                                <For each={activity().pendingAsks}>{(ask) => <small>{message('collab.agentActivity.ask', { prompt: ask.prompt })}</small>}</For>
                              </span>
                            )}</Show>
                            <Show when={remote.identity?.kind === 'agent' && (remote.identity.owner !== undefined || remote.identity.harness !== undefined)}>
                              <small>
                                {remote.identity?.owner !== undefined ? `run by ${remote.identity.owner}` : ''}
                                {remote.identity?.harness !== undefined ? `${remote.identity.owner !== undefined ? ' ' : ''}(${remote.identity.harness})` : ''}
                              </small>
                            </Show>
                          </span>
                          <Show when={remote.identity?.kind === 'agent'}>
                            <span class="collab-agent">agent</span>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>

                <Show when={proposals().length > 0}>
                  <section class="collab-proposal-section" aria-labelledby="collab-proposals-heading" data-testid="collab-proposals">
                    <header><h4 id="collab-proposals-heading">Proposals</h4></header>
                    <ul class="collab-proposals">
                      <For each={proposals()}>
                        {({ remote, proposal, key }) => {
                          const definition = () => {
                            settingsRevision()
                            return props.app.settings.list().find((item) => item.id === proposal.settingId)
                          }
                          const valid = () => props.app.settings.isUsableValue(proposal.settingId, proposal.value)
                          const applied = () => appliedProposals().has(key)
                          return (
                            <li class="collab-proposal-card" data-testid="collab-proposal" data-proposal-id={proposal.id}>
                              <header>
                                <span class="collab-proposal-agent">
                                  <strong>{remote.identity?.displayName ?? actorLabel(remote.actorId)}</strong>
                                  <span class="collab-agent">agent</span>
                                </span>
                                <code>{proposal.settingId}</code>
                              </header>
                              <strong class="collab-proposal-setting">{definition()?.name ?? proposal.settingId}</strong>
                              <Show when={definition() === undefined}>
                                <p class="collab-proposal-error">Not available in this client</p>
                              </Show>
                              <Show when={definition() !== undefined && !valid()}>
                                <p class="collab-proposal-error">Invalid value</p>
                              </Show>
                              <dl class="collab-proposal-values">
                                <div><dt>Current value</dt><dd><code>{definition() === undefined ? 'Unavailable' : settingValueLabel(props.app.settings.get(proposal.settingId))}</code></dd></div>
                                <div><dt>Proposed value</dt><dd><code>{settingValueLabel(proposal.value)}</code></dd></div>
                              </dl>
                              <Show when={proposal.note !== undefined}><p class="collab-proposal-note">{proposal.note}</p></Show>
                              <div class="collab-proposal-actions">
                                <button
                                  type="button"
                                  class="collab-primary-action"
                                  data-testid="collab-proposal-apply"
                                  disabled={definition() === undefined || !valid() || applied()}
                                  onClick={() => {
                                    props.app.settings.set(proposal.settingId, proposal.value)
                                    updateProposalState(setAppliedProposals, key)
                                  }}
                                >{applied() ? 'Applied' : 'Apply'}</button>
                                <button
                                  type="button"
                                  data-testid="collab-proposal-dismiss"
                                  onClick={() => updateProposalState(setDismissedProposals, key)}
                                >Dismiss</button>
                              </div>
                            </li>
                          )
                        }}
                      </For>
                    </ul>
                  </section>
                </Show>

                <Show when={ending()} fallback={
                  <div class="collab-current-actions">
                    <button
                      type="button"
                      data-testid="collab-leave"
                      data-action-state={isPending('leave') ? 'pending' : 'idle'}
                      aria-busy={isPending('leave')}
                      aria-disabled={isPending('leave')}
                      onClick={() => leave(tabId)}
                    >
                      <Show when={isPending('leave')}><span class="collab-spinner" aria-hidden="true" /></Show>
                      {isPending('leave') ? 'Leaving...' : 'Leave session'}
                    </button>
                    <button
                      ref={endButton}
                      type="button"
                      class="danger"
                      data-testid="collab-end"
                      onClick={() => askToEnd(entry.descriptor.sessionId)}
                    >
                      End for everyone
                    </button>
                  </div>
                }>
                  <div class="collab-end-confirm" data-testid="collab-end-confirm" role="group" aria-label="Confirm ending session">
                    <ProductNotice tone="warning">
                      Everyone will be disconnected. Their current workflow stays open locally.
                    </ProductNotice>
                    <ProductActionFooter>
                      <button type="button" data-testid="collab-end-cancel" disabled={isPending('end')} onClick={cancelEnd}>Cancel</button>
                      <button
                        ref={confirmEndButton}
                        type="button"
                        class="danger"
                        data-testid="collab-end-confirm-button"
                        data-action-state={isPending('end') ? 'pending' : 'idle'}
                        aria-busy={isPending('end')}
                        aria-disabled={isPending('end')}
                        onClick={() => end(tabId, entry.descriptor.sessionId)}
                      >
                        <Show when={isPending('end')}><span class="collab-spinner" aria-hidden="true" /></Show>
                        {isPending('end') ? 'Ending session...' : 'End session for everyone'}
                      </button>
                    </ProductActionFooter>
                  </div>
                </Show>
              </article>
            )
          }}
        </Show>
        <Show when={failureFor('leave')}>{(message) => (
          <ProductNotice tone="error" testId="collab-leave-error">Leave failed: {message()}</ProductNotice>
        )}</Show>
        <Show when={failureFor('end')}>{(message) => (
          <ProductNotice tone="error" testId="collab-end-error">End failed: {message()}</ProductNotice>
        )}</Show>
      </section>

      <Show when={readOnlyDocument()} keyed>{(preview) => {
        const document = useSignal(preview.document)
        const status = preview.session === undefined ? undefined : useSignal(preview.session.status)
        return <section class="collab-read-only" aria-label="Read-only shared document" data-testid="collab-read-only">
          <header class="collab-section-heading">
            <h2>{preview.descriptor.documentId}</h2>
            <button type="button" onClick={() => props.app.dismissCollabDocument()}>Dismiss</button>
          </header>
          <p>No editor is available for <code>{preview.descriptor.documentKind}</code>. {status === undefined
            ? 'This is a read-only checkpoint, not a live session.'
            : `The registered adapter provides a synchronized read-only view. Session: ${status()}.`}</p>
          <pre tabindex="0" aria-label="Document JSON">{JSON.stringify(document(), null, 2)}</pre>
        </section>
      }}</Show>

      <section class="collab-join" aria-labelledby="collab-join-heading" aria-busy={isPending('refresh')}>
        <header class="collab-section-heading collab-list-heading">
          <div>
            <span class="collab-eyebrow">Available now</span>
            <h2 id="collab-join-heading">Shared sessions</h2>
          </div>
          <button
            type="button"
            data-testid="collab-refresh"
            data-action-state={isPending('refresh') ? 'pending' : 'idle'}
            aria-busy={isPending('refresh')}
            aria-disabled={isPending('refresh') || backend() === undefined}
            disabled={backend() === undefined}
            onClick={() => void refresh()}
          >
            <Show when={isPending('refresh')}><span class="collab-spinner" aria-hidden="true" /></Show>
            {isPending('refresh') ? 'Refreshing...' : 'Refresh'}
          </button>
        </header>

        <Show when={listState() === 'loading'}>
          <div class="collab-list-state" data-testid="collab-loading" data-state="loading">
            <span class="collab-spinner" aria-hidden="true" />
            <div><strong>Loading shared sessions</strong><span>Checking this backend for sessions you can join.</span></div>
          </div>
        </Show>
        <Show when={listState() === 'unavailable'}>
          <div class="collab-list-state" data-testid="collab-no-backend" data-state="unavailable">
            <strong>No collaboration backend</strong>
            <span>Connect a Dinkster backend to discover and host shared sessions.</span>
          </div>
        </Show>
        <Show when={listState() === 'error'}>
          <ProductNotice tone="error" testId="collab-list-error">
            Sessions could not be loaded: {failureFor('refresh')}
          </ProductNotice>
        </Show>
        <Show when={listState() === 'ready' && sessions().length === 0}>
          <div class="collab-list-state" data-testid="collab-empty" data-state="empty">
            <strong>No shared sessions</strong>
            <span>Refresh when someone else starts a session.</span>
          </div>
        </Show>
        <Show when={listState() === 'ready' && sessions().length > 0}>
          <ul class="collab-session-list" data-testid="collab-session-list">
            <For each={sessions()}>
              {(session) => {
                const key = `join:${session.sessionId}` as const
                return (
                  <li class="collab-session-card" data-testid="collab-session" data-session-id={session.sessionId}>
                    <div class="collab-session-row-heading">
                      <div class="collab-session-identity">
                        <strong>{session.documentId}</strong>
                        <code>{session.sessionId}</code>
                      </div>
                      <span class="collab-revision">Revision {session.revision}</span>
                    </div>
                    <button
                      type="button"
                      class="collab-primary-action"
                      data-testid="collab-join"
                      data-action-state={isPending(key) ? 'pending' : 'idle'}
                      aria-busy={isPending(key)}
                      aria-disabled={isPending(key)}
                      onClick={() => join(session.sessionId)}
                    >
                      <Show when={isPending(key)}><span class="collab-spinner" aria-hidden="true" /></Show>
                      {isPending(key) ? 'Joining...' : 'Join session'}
                    </button>
                    <Show when={failureFor(key)}>{(message) => (
                      <ProductNotice tone="error" testId="collab-join-error">Join failed: {message()}</ProductNotice>
                    )}</Show>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
      </section>
    </div>
  )
}
