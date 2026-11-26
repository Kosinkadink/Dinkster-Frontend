import {
  connectSharedBoardSession, createLocalBoardSession, createSignal,
  type BoardDocument, type BoardSession, type CollabSessionDescriptor, type SharedBoardSession,
} from '@dinkster/core'
import type { CollabTransport } from './collab.js'

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
  private epoch = 0
  private disposed = false

  constructor(private readonly options: {
    readonly transport: CollabTransport
    readonly project: string
    readonly actorId: string
    readonly backend: () => string | undefined
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
    const entry = this.entries.get().find((entry) => entry.id === id)
    entry?.shared?.session.close()
    this.entries.update((entries) => entries.filter((entry) => entry.id !== id))
  }

  dispose(): void {
    this.disposed = true
    for (const cancel of this.adopting.keys()) cancel()
    for (const entry of this.entries.get()) entry.shared?.session.close()
    this.entries.set([])
  }
}
