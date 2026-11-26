import {
  BOARD_MAX_NAME, boardMediaKindOf, connectSharedBoardSession, createLocalBoardSession, createSignal, planBoardCommand,
  type BoardAsset, type BoardDocument, type BoardItemInput, type BoardSession, type CollabSessionDescriptor, type SharedBoardSession,
} from '@dinkster/core'
import type { AssetUploadDestination, DinksterConnection } from '@dinkster/client'
import type { CollabTransport } from './collab.js'

type BoardMediaConnection = Pick<DinksterConnection, 'uploadMediaAsset' | 'checkAssetAvailability'>

export interface BoardEntry {
  readonly id: string
  readonly title: string
  readonly baseUrl: string
  readonly session: BoardSession
  readonly shared?: {
    readonly descriptor: CollabSessionDescriptor
    readonly session: SharedBoardSession
  }
}

/** Board documents share the existing transport, without pretending to be workflows. */
export class BoardWorkspace {
  readonly entries = createSignal<readonly BoardEntry[]>([])
  readonly scope: string
  private readonly pending = new Set<string>()
  private readonly adopting = new Map<() => void, string>()
  private readonly cancellations = new Map<string, number>()
  private readonly importing = new Map<AbortController, string>()
  private epoch = 0
  private disposed = false

  constructor(private readonly options: {
    readonly transport: CollabTransport
    readonly project: string
    readonly actorId: string
    readonly backend: () => string | undefined
    readonly mediaConnection: (baseUrl: string) => BoardMediaConnection | undefined
    readonly onConflict: (id: string, message: string) => void
  }) {
    this.scope = `shared:board:${options.project}`
  }

  open(document: BoardDocument, title: string, baseUrl: string): BoardEntry {
    if (this.disposed) throw new Error('Board workspace is closed')
    const existing = this.entries.get().find((entry) => entry.id === document.lineage)
    if (existing) return existing
    const entry = { id: document.lineage, title, baseUrl, session: createLocalBoardSession(document) }
    this.entries.update((entries) => [...entries, entry])
    return entry
  }

  /** Refuse mismatched source context and missing bytes before placing recorded Assets. */
  async placeMedia(id: string, source: {
    readonly project: string
    readonly baseUrl: string
    readonly assets: readonly BoardAsset[]
  }, point: { readonly x: number; readonly y: number }): Promise<readonly string[]> {
    const entry = this.mediaEntry(id)
    if (source.project !== this.options.project || source.baseUrl !== entry.baseUrl)
      throw new Error('Media must come from this Board\'s project and backend')
    const assets = structuredClone(source.assets)
    const items = this.mediaItems(entry, assets, point)
    const connection = this.options.mediaConnection(entry.baseUrl)
    if (!connection) throw new Error('This Board\'s backend is unavailable')
    const abort = new AbortController()
    this.importing.set(abort, id)
    try {
      const availability = await connection.checkAssetAvailability([...new Set(assets.map((asset) => asset.digest))], {
        scope: 'local', signal: abort.signal,
      })
      this.assertMediaCurrent(entry, abort, connection)
      if (assets.some((asset) => !availability.some((row) => row.digest === asset.digest && row.status === 'available')))
        throw new Error('Some media is unavailable; nothing was placed')
      return this.commitMedia(entry, items)
    } finally { this.importing.delete(abort) }
  }

  /** Upload the whole batch before placing it as one undoable Board edit. */
  async importMedia(id: string, files: readonly File[], point: { readonly x: number; readonly y: number },
    destination: AssetUploadDestination = {},
  ): Promise<readonly string[]> {
    const entry = this.mediaEntry(id)
    const batch = files.map((file) => {
      const kind = boardMediaKindOf(file.type)
      if (!kind) throw new Error(`Unsupported Board media: ${file.name}`)
      if (file.size > (kind === 'picture' ? 256 : 1024) * 1024 * 1024)
        throw new Error(`File exceeds the Board media upload limit: ${file.name}`)
      return { file, kind }
    })
    if (batch.length === 0) throw new Error('No media to import')
    const connection = this.options.mediaConnection(entry.baseUrl)
    if (!connection) throw new Error('This Board\'s backend is unavailable')
    const target = { ...destination }
    const location = { ...point }
    const abort = new AbortController()
    this.importing.set(abort, id)
    const assets: BoardAsset[] = []
    try {
      for (const { file, kind } of batch) {
        this.assertMediaCurrent(entry, abort, connection)
        const asset = await connection.uploadMediaAsset(file, {
          ...target, scope: 'local', name: file.name, signal: abort.signal,
          kind: kind === 'picture' ? 'media/image' : kind === 'video' ? 'media/video' : 'media/audio',
        })
        this.assertMediaCurrent(entry, abort, connection)
        if (boardMediaKindOf(asset.mediaType) !== kind) throw new Error('Uploaded media has an unexpected kind')
        assets.push({ digest: asset.digest, mediaType: asset.mediaType, name: asset.name.slice(0, BOARD_MAX_NAME) })
      }
      return this.commitMedia(entry, this.mediaItems(entry, assets, location))
    } finally { this.importing.delete(abort) }
  }

  private mediaEntry(id: string): BoardEntry {
    const entry = this.entries.get().find((candidate) => candidate.id === id)
    if (this.disposed || !entry) throw new Error('Board is not open')
    return entry
  }

  private assertMediaCurrent(entry: BoardEntry, abort: AbortController, connection: BoardMediaConnection): void {
    abort.signal.throwIfAborted()
    if (this.disposed || !this.entries.get().includes(entry) ||
        this.options.mediaConnection(entry.baseUrl) !== connection)
      throw new Error('Board changed while importing; nothing was placed')
  }

  private cancelImports(id: string): void {
    for (const [abort, owner] of this.importing) if (owner === id) abort.abort()
  }

  private mediaItems(entry: BoardEntry, assets: readonly BoardAsset[], point: { readonly x: number; readonly y: number }): readonly BoardItemInput[] {
    const items = assets.map((asset, index): BoardItemInput => {
      const kind = boardMediaKindOf(asset.mediaType)
      if (!kind) throw new Error(`Unsupported Board media: ${asset.name}`)
      const ratio = asset.width && asset.height ? asset.width / asset.height : 280 / 175
      const height = kind === 'sound' ? 80 : Math.max(16, 280 / ratio)
      const width = kind === 'sound' ? 320 : height * ratio
      return { kind, asset, rect: { x: point.x + index * 24, y: point.y + index * 24, width, height } }
    })
    const plan = planBoardCommand(entry.session.doc, { command: 'board.item.add', params: { items } })
    if (!plan.ok) throw new Error(plan.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
    return items
  }

  private commitMedia(entry: BoardEntry, items: readonly BoardItemInput[]): readonly string[] {
    const result = entry.session.dispatch({ command: 'board.item.add', params: { items } })
    if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
    return result.created
  }

  async discover(): Promise<readonly CollabSessionDescriptor[]> {
    const baseUrl = this.options.backend()
    if (this.disposed || baseUrl === undefined) return []
    return (await this.options.transport.list(baseUrl, this.scope))
      .filter((descriptor) => descriptor.scope === this.scope && descriptor.documentKind === 'board')
  }

  async share(id: string): Promise<BoardEntry> {
    if (this.disposed) throw new Error('Board workspace is closed')
    const entry = this.entries.get().find((entry) => entry.id === id)
    if (!entry) throw new Error('Board is not open')
    if (entry.shared) return entry
    if (this.pending.has(id)) throw new Error('Board publication is already in progress')
    this.pending.add(id)
    const revision = entry.session.revision
    const snapshot = entry.session.doc
    try {
      const descriptor = await this.options.transport.create(entry.baseUrl, {
        scope: this.scope, documentKind: 'board', documentId: entry.id, snapshot,
      })
      try {
        return await this.adopt(descriptor, entry.baseUrl, entry.title, () =>
          this.entries.get().includes(entry) && entry.session.revision === revision && entry.session.doc === snapshot)
      } catch (error) {
        void this.options.transport.end(entry.baseUrl, descriptor.sessionId).catch(() => undefined)
        throw error
      }
    } finally { this.pending.delete(id) }
  }

  async join(sessionId: string): Promise<BoardEntry> {
    if (this.disposed) throw new Error('Board workspace is closed')
    const baseUrl = this.options.backend()
    if (baseUrl === undefined) throw new Error('No Dinkster backend connected')
    const existing = this.entries.get().find((entry) =>
      entry.baseUrl === baseUrl && entry.shared?.descriptor.sessionId === sessionId)
    if (existing) return existing
    const key = `join:${sessionId}`
    if (this.pending.has(key)) throw new Error('Joining this Board is already in progress')
    this.pending.add(key)
    const epoch = this.epoch
    try {
      const descriptor = await this.options.transport.get(baseUrl, sessionId)
      if (!descriptor) throw new Error('That Board session no longer exists')
      if (this.entries.get().some((entry) => entry.id === descriptor.documentId))
        throw new Error('This Board is already open; close it before joining another session')
      return await this.adopt(descriptor, baseUrl, descriptor.documentId, () =>
        (this.cancellations.get(descriptor.documentId) ?? 0) <= epoch &&
        this.options.backend() === baseUrl && !this.entries.get().some((entry) => entry.id === descriptor.documentId))
    } finally { this.pending.delete(key) }
  }

  private async adopt(
    descriptor: CollabSessionDescriptor, baseUrl: string, title: string, current: () => boolean,
  ): Promise<BoardEntry> {
    if (descriptor.documentKind !== 'board' || descriptor.scope !== this.scope)
      throw new Error('That session does not belong to this project\'s Boards')
    const assertCurrent = () => {
      if (this.disposed || !current()) throw new Error('Board changed while joining; the current document was kept')
    }
    assertCurrent()
    const transport = this.options.transport
    const actorId = await transport.bindActor?.(baseUrl, descriptor.sessionId, this.options.actorId) ?? this.options.actorId
    assertCurrent()
    const connection = transport.connect({ baseUrl, sessionId: descriptor.sessionId, actorId })
    let session: SharedBoardSession | undefined
    const cancel = () => { if (session) session.close(); else connection.close() }
    this.adopting.set(cancel, descriptor.documentId)
    try {
      session = await connectSharedBoardSession(connection, descriptor, {
        actorId, onConflict: ({ message }) => this.options.onConflict(descriptor.documentId, message),
      })
      assertCurrent()
      await session.settle()
      assertCurrent()
      if (session.status.get() === 'closed' || session.status.get() === 'error')
        throw new Error('The shared Board could not be opened')
      const entry: BoardEntry = { id: descriptor.documentId, title, baseUrl, session, shared: { descriptor, session } }
      this.cancelImports(entry.id)
      this.entries.update((entries) => entries.some((candidate) => candidate.id === entry.id)
        ? entries.map((candidate) => candidate.id === entry.id ? entry : candidate) : [...entries, entry])
      return entry
    } catch (error) {
      cancel()
      throw error
    } finally { this.adopting.delete(cancel) }
  }

  leave(id: string): void {
    const entry = this.entries.get().find((entry) => entry.id === id)
    if (!entry?.shared) return
    const local: BoardEntry = { id, title: entry.title, baseUrl: entry.baseUrl, session: createLocalBoardSession(entry.session.doc) }
    this.cancelImports(id)
    entry.shared.session.close()
    this.entries.update((entries) => entries.map((candidate) => candidate === entry ? local : candidate))
  }

  async end(id: string): Promise<void> {
    const entry = this.entries.get().find((entry) => entry.id === id)
    if (!entry?.shared) throw new Error('This Board is not shared')
    await this.options.transport.end(entry.baseUrl, entry.shared.descriptor.sessionId)
    if (this.entries.get().includes(entry)) this.leave(id)
  }

  close(id: string): void {
    this.cancellations.set(id, ++this.epoch)
    for (const [cancel, owner] of this.adopting) if (owner === id) cancel()
    this.cancelImports(id)
    const entry = this.entries.get().find((entry) => entry.id === id)
    entry?.shared?.session.close()
    this.entries.update((entries) => entries.filter((entry) => entry.id !== id))
  }

  dispose(): void {
    this.disposed = true
    for (const abort of this.importing.keys()) abort.abort()
    for (const cancel of this.adopting.keys()) cancel()
    for (const entry of this.entries.get()) entry.shared?.session.close()
    this.entries.set([])
  }
}
