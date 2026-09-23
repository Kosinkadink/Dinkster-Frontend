import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from 'solid-js'
import {
  LocalDocumentTypeSession,
  connectDocumentSession,
  createVideoDocument,
  normalizeCollabDocumentKind,
  videoDocumentTypeAdapter,
  type CollabSessionDescriptor,
  type CommandInvocation,
  type DocumentCommandOutcome,
  type Json,
  type ReadonlySignal,
  type SharedDocumentSession,
  type VideoDocument,
} from '@dinkster/core'
import type { AppState } from './app-state.js'
import { COLLAB_SCOPE } from './collab.js'
import { activeProjectId } from './projects.js'
import { useAppMessage } from './locale.js'
import { useSignal } from './solid-adapter.js'
import { TimelineLane, TimelineViewport } from './TimelineViewport.js'

interface VideoSession {
  readonly doc: VideoDocument
  readonly document: ReadonlySignal<VideoDocument>
  readonly revision: number
  readonly canUndo: boolean
  readonly canRedo: boolean
  dispatch(invocation: CommandInvocation): DocumentCommandOutcome<VideoDocument>
  undo(): boolean
  redo(): boolean
  onOp(listener: () => void): () => void
  close?(): void
}

interface OpenVideoDocument {
  readonly id: string
  title: string
  session: VideoSession
  stop: () => void
  collaboration?: {
    readonly descriptor: CollabSessionDescriptor
    readonly baseUrl: string
    readonly session: SharedDocumentSession<VideoDocument>
  }
}

interface PersistedVideoDocument {
  readonly id: string
  readonly title: string
  readonly document: VideoDocument
}

export interface VideoWorkspaceTab {
  readonly id: string
  readonly lineage: string
  readonly kind: 'video'
  readonly title: string
  readonly shared: boolean
  readonly activate: () => void
  readonly close: () => void
}

const storageKey = (): string =>
  `dinkster.video-documents.v1:${activeProjectId()}`
const newId = (): string =>
  `video-${Date.now()}-${Math.floor(Math.random() * 0x1000000).toString(36)}`
const tabId = (id: string): string => `video:${id}`

type VideoJsonObject = Readonly<Record<string, Json>>

const videoRecord = (value: unknown): VideoJsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as VideoJsonObject)
    : undefined

const timeSeconds = (value: unknown): number | undefined => {
  const time = videoRecord(value)
  const rawValue = time?.['value']
  const rate = time?.['rate']
  return time?.['OTIO_SCHEMA'] === 'RationalTime.1' &&
    typeof rawValue === 'number' &&
    typeof rate === 'number' &&
    Number.isFinite(rawValue) &&
    Number.isFinite(rate) &&
    rate > 0
    ? rawValue / rate
    : undefined
}

const rangeDuration = (value: unknown): number | undefined => {
  const range = videoRecord(value)
  return range?.['OTIO_SCHEMA'] === 'TimeRange.1'
    ? timeSeconds(range['duration'])
    : undefined
}

const timelineItemDuration = (value: unknown): number | undefined => {
  const item = videoRecord(value)
  if (item === undefined) return undefined
  const kind =
    typeof item['OTIO_SCHEMA'] === 'string'
      ? item['OTIO_SCHEMA'].split('.', 1)[0]
      : ''
  if (kind === 'Transition') return 0
  if (item['source_range'] !== null && item['source_range'] !== undefined)
    return rangeDuration(item['source_range'])
  const children = item['children']
  if (Array.isArray(children)) {
    const durations = children.map(timelineItemDuration)
    if (durations.some((duration) => duration === undefined)) return undefined
    return kind === 'Stack'
      ? Math.max(0, ...(durations as number[]))
      : durations.reduce<number>((total, duration) => total + duration!, 0)
  }
  if (kind === 'Timeline') return timelineItemDuration(item['tracks'])
  if (kind === 'Clip') {
    const references = videoRecord(item['media_references'])
    const active =
      typeof item['active_media_reference_key'] === 'string'
        ? item['active_media_reference_key']
        : 'DEFAULT_MEDIA'
    return rangeDuration(videoRecord(references?.[active])?.['available_range'])
  }
  return undefined
}

function recoveredDocuments(): readonly PersistedVideoDocument[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(storageKey()) ?? '[]',
    )
    if (!Array.isArray(value)) return []
    return value.flatMap((candidate): PersistedVideoDocument[] => {
      if (candidate === null || typeof candidate !== 'object') return []
      const raw = candidate as {
        id?: unknown
        title?: unknown
        document?: unknown
      }
      if (typeof raw.id !== 'string' || typeof raw.title !== 'string') return []
      const loaded = videoDocumentTypeAdapter.load(raw.document)
      return loaded.document === undefined
        ? []
        : [{ id: raw.id, title: raw.title, document: loaded.document }]
    })
  } catch {
    return []
  }
}

export function VideoDocumentWorkspace(props: {
  readonly activeId: string
  readonly createRequest: number
  readonly app: AppState
  readonly onTabsChange: (tabs: readonly VideoWorkspaceTab[]) => void
  readonly onReady?: (() => void) | undefined
  readonly onActivate: (id: string) => void
}) {
  const message = useAppMessage()
  const [documents, setDocuments] = createSignal<readonly OpenVideoDocument[]>(
    [],
  )
  const [error, setError] = createSignal<string>()
  const [sharedOpen, setSharedOpen] = createSignal(false)
  const [sharedSessions, setSharedSessions] = createSignal<
    readonly CollabSessionDescriptor[]
  >([])
  const [busy, setBusy] = createSignal(false)
  let handledCreate = props.createRequest

  const persist = (): void => {
    try {
      localStorage.setItem(
        storageKey(),
        JSON.stringify(
          documents().map((entry) => ({
            id: entry.id,
            title: entry.title,
            document: entry.session.doc,
          })),
        ),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const attach = (
    id: string,
    title: string,
    session: VideoSession,
    collaboration?: OpenVideoDocument['collaboration'],
  ): OpenVideoDocument => {
    const stop = session.document.subscribe(() => {
      setDocuments((current) => [...current])
      persist()
    })
    return {
      id,
      title,
      session,
      stop,
      ...(collaboration === undefined ? {} : { collaboration }),
    }
  }

  const closeEntry = (entry: OpenVideoDocument): void => {
    entry.stop()
    entry.session.close?.()
    setDocuments((current) =>
      current.filter((candidate) => candidate !== entry),
    )
    persist()
  }

  const createDocument = (): void => {
    const id = newId()
    const entry = attach(
      id,
      message('videoWorkspace.untitled'),
      new LocalDocumentTypeSession(
        createVideoDocument(message('videoWorkspace.untitled')),
        videoDocumentTypeAdapter,
      ),
    )
    setDocuments((current) => [...current, entry])
    persist()
    props.onActivate(tabId(id))
  }

  const adoptShared = async (
    descriptor: CollabSessionDescriptor,
    baseUrl: string,
  ): Promise<void> => {
    if (
      normalizeCollabDocumentKind(descriptor.documentKind) !==
      videoDocumentTypeAdapter.kind
    ) {
      throw new Error('collaboration session is not a video document')
    }
    const connection = props.app.collabTransport.connect({
      baseUrl,
      sessionId: descriptor.sessionId,
      actorId: props.app.collabActorId,
    })
    try {
      const session = await connectDocumentSession(
        connection,
        videoDocumentTypeAdapter,
        {
          actorId: props.app.collabActorId,
          onError: setError,
        },
      )
      const previous = documents().find(
        (entry) => entry.id === descriptor.documentId,
      )
      const entry = attach(
        descriptor.documentId,
        previous?.title ?? descriptor.documentId,
        session,
        { descriptor, baseUrl, session },
      )
      previous?.stop()
      previous?.session.close?.()
      setDocuments((current) =>
        previous === undefined
          ? [...current, entry]
          : current.map((candidate) =>
              candidate === previous ? entry : candidate,
            ),
      )
      persist()
      props.onActivate(tabId(entry.id))
    } catch (cause) {
      connection.close()
      throw cause
    }
  }

  const share = async (entry: OpenVideoDocument): Promise<void> => {
    const backend = props.app.collabBackend()
    if (backend?.protocol !== 'dinkster' || entry.collaboration !== undefined)
      return
    setBusy(true)
    setError(undefined)
    let created: CollabSessionDescriptor | undefined
    try {
      created = await props.app.collabTransport.create(backend.baseUrl, {
        scope: COLLAB_SCOPE,
        documentId: entry.id,
        documentKind: 'video',
        snapshot: entry.session.doc,
      })
      await adoptShared(created, backend.baseUrl)
    } catch (cause) {
      if (created !== undefined)
        void props.app.collabTransport
          .end(backend.baseUrl, created.sessionId)
          .catch(() => undefined)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const browseShared = async (): Promise<void> => {
    const backend = props.app.collabBackend()
    if (backend?.protocol !== 'dinkster') return
    setBusy(true)
    setError(undefined)
    try {
      const sessions = await props.app.collabTransport.list(
        backend.baseUrl,
        COLLAB_SCOPE,
      )
      setSharedSessions(
        sessions.filter(
          (descriptor) =>
            normalizeCollabDocumentKind(descriptor.documentKind) ===
            videoDocumentTypeAdapter.kind,
        ),
      )
      setSharedOpen(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  onMount(() => {
    const restored = recoveredDocuments().map((entry) =>
      attach(
        entry.id,
        entry.title,
        new LocalDocumentTypeSession(entry.document, videoDocumentTypeAdapter),
      ),
    )
    setDocuments(restored)
    props.onReady?.()
  })
  onCleanup(() => {
    for (const entry of documents()) {
      entry.stop()
      entry.session.close?.()
    }
  })
  createEffect(() => {
    if (props.createRequest === handledCreate) return
    handledCreate = props.createRequest
    createDocument()
  })
  createEffect(() => {
    props.onTabsChange(
      documents().map((entry) => ({
        id: tabId(entry.id),
        lineage: entry.id,
        kind: 'video',
        title: entry.title,
        shared: entry.collaboration !== undefined,
        activate: () => props.onActivate(tabId(entry.id)),
        close: () => closeEntry(entry),
      })),
    )
  })

  return (
    <section
      class="video-document-workspace"
      data-testid="video-document-workspace"
      hidden={!props.activeId.startsWith('video:')}
    >
      <For each={documents()}>
        {(entry) => (
          <VideoDocumentPanel
            entry={entry}
            active={() => props.activeId === tabId(entry.id)}
            busy={busy}
            onPersist={persist}
            onMetadataChange={() => setDocuments((current) => [...current])}
            onShare={() => share(entry)}
            onError={setError}
          />
        )}
      </For>
      <Show
        when={props.activeId.startsWith('video:') && documents().length === 0}
      >
        <div class="video-document-empty">
          <p>{message('videoWorkspace.empty')}</p>
          <button type="button" class="primary" onClick={createDocument}>
            {message('videoWorkspace.new')}
          </button>
        </div>
      </Show>
      <Show when={props.activeId.startsWith('video:')}>
        <button
          type="button"
          onClick={() => void browseShared()}
          disabled={busy()}
        >
          {message('videoWorkspace.shared')}
        </button>
      </Show>
      <Show when={error()}>
        {(value) => (
          <div role="alert" class="video-document-error">
            {value()}
          </div>
        )}
      </Show>
      <Show when={sharedOpen()}>
        <div
          class="video-document-shared-dialog"
          role="dialog"
          aria-label={message('videoWorkspace.shared')}
        >
          <header>
            <strong>{message('videoWorkspace.shared')}</strong>
            <button type="button" onClick={() => setSharedOpen(false)}>
              {message('common.close')}
            </button>
          </header>
          <For
            each={sharedSessions()}
            fallback={<p>{message('videoWorkspace.sharedEmpty')}</p>}
          >
            {(descriptor) => (
              <button
                type="button"
                onClick={() => {
                  const backend = props.app.collabBackend()
                  if (backend?.protocol === 'dinkster')
                    void adoptShared(descriptor, backend.baseUrl)
                      .then(() => setSharedOpen(false))
                      .catch((cause) => setError(String(cause)))
                }}
              >
                {descriptor.documentId}
              </button>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}

function VideoDocumentPanel(props: {
  readonly entry: OpenVideoDocument
  readonly active: () => boolean
  readonly busy: () => boolean
  readonly onPersist: () => void
  readonly onMetadataChange: () => void
  readonly onShare: () => Promise<void>
  readonly onError: (error: string | undefined) => void
}) {
  const message = useAppMessage()
  const documentValue = useSignal(props.entry.session.document)
  const [playhead, setPlayhead] = createSignal(0)
  const [draft, setDraft] = createSignal(
    JSON.stringify(props.entry.session.doc, null, 2),
  )
  const [changed, setChanged] = createSignal(false)
  const tracks = createMemo(() => {
    const timeline = videoRecord(documentValue().timeline)
    const stack = videoRecord(timeline?.['tracks'])
    return Array.isArray(stack?.['children'])
      ? stack['children'].flatMap((track) => {
          const value = videoRecord(track)
          return value === undefined ? [] : [value]
        })
      : []
  })
  const duration = createMemo(() => timelineItemDuration(documentValue().timeline))
  createEffect(() => {
    const document = documentValue()
    if (!changed()) setDraft(JSON.stringify(document, null, 2))
  })
  const canUndo = (): boolean => {
    documentValue()
    return props.entry.session.canUndo
  }
  const canRedo = (): boolean => {
    documentValue()
    return props.entry.session.canRedo
  }
  const apply = (): void => {
    try {
      const document = JSON.parse(draft()) as Json
      const outcome = props.entry.session.dispatch({
        command: 'video.document.replace',
        params: { document },
      })
      if (!outcome.ok)
        throw new Error(
          outcome.diagnostics[0]?.message ?? 'video document was refused',
        )
      setDraft(JSON.stringify(outcome.doc, null, 2))
      setChanged(false)
      props.onError(undefined)
      props.onPersist()
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <section class="video-document-panel" hidden={!props.active()}>
      <header>
        <input
          value={props.entry.title}
          aria-label={message('videoWorkspace.name')}
          onChange={(event) => {
            props.entry.title = event.currentTarget.value
            props.onMetadataChange()
            props.onPersist()
          }}
        />
        <button
          type="button"
          disabled={!canUndo()}
          onClick={() => props.entry.session.undo()}
        >
          {message('imageDocument.editor.action.undo')}
        </button>
        <button
          type="button"
          disabled={!canRedo()}
          onClick={() => props.entry.session.redo()}
        >
          {message('imageDocument.editor.action.redo')}
        </button>
        <button
          type="button"
          disabled={props.busy() || props.entry.collaboration !== undefined}
          onClick={() => void props.onShare()}
        >
          {message('imageDocument.workspace.action.share')}
        </button>
      </header>
      <p>{message('videoWorkspace.description')}</p>
      <TimelineViewport
        duration={duration()}
        frameDuration={1 / documentValue().settings.rate}
        time={playhead()}
        onSeek={setPlayhead}
      >
        {(scale) => (
          <For each={tracks()}>
            {(track, trackIndex) => (
              <TimelineLane
                label={
                  typeof track['name'] === 'string'
                    ? track['name']
                    : `Track ${trackIndex() + 1}`
                }
                {...(typeof track['kind'] === 'string'
                  ? { description: track['kind'] }
                  : {})}
              >
                <div class="video-document-timeline-items">
                  <For each={Array.isArray(track['children']) ? track['children'] : []}>
                    {(item, itemIndex) => {
                      const value = videoRecord(item)
                      const itemDuration = timelineItemDuration(value) ?? 0
                      return (
                        <span
                          class="video-document-timeline-item"
                          style={{
                            width: `${Math.max(2, itemDuration * scale.pixelsPerSecond)}px`,
                          }}
                          title={
                            typeof value?.['name'] === 'string'
                              ? value['name']
                              : `Item ${itemIndex() + 1}`
                          }
                        >
                          {typeof value?.['name'] === 'string'
                            ? value['name']
                            : itemIndex() + 1}
                        </span>
                      )
                    }}
                  </For>
                </div>
              </TimelineLane>
            )}
          </For>
        )}
      </TimelineViewport>
      <textarea
        data-testid="video-document-json"
        value={draft()}
        onInput={(event) => {
          setDraft(event.currentTarget.value)
          setChanged(true)
        }}
      />
      <button
        type="button"
        class="primary"
        disabled={!changed()}
        onClick={apply}
      >
        {message('common.apply')}
      </button>
    </section>
  )
}
