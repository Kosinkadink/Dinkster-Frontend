import { loadDocument, type WorkflowDocument } from '@dinkster/core'
import type { WorkerPortLike } from './shared-worker-authority.js'

export interface WorkspaceTabRecord {
  readonly id: string
  readonly title: string
  readonly document: WorkflowDocument
  readonly editorKind?: string
  readonly stock?: true
}

export interface WorkspaceTabMutation {
  readonly opId: string
  readonly actorId: string
  readonly sequence: number
  readonly baseRevision: number
  readonly additions: readonly WorkspaceTabRecord[]
  readonly removals: readonly string[]
  readonly updates: readonly {
    readonly id: string
    readonly title: string
    readonly editorKind: string | null
    readonly stock: boolean
  }[]
  readonly order: readonly string[]
  readonly active: string
}

export interface WorkspaceTabSnapshot {
  readonly revision: number
  readonly tabs: readonly WorkspaceTabRecord[]
  readonly active: string
  readonly operationWatermarks: Readonly<Record<string, number>>
}

export type WorkspaceWorkerRequest =
  | {
      readonly id: number
      readonly kind: 'open'
      readonly tabs: readonly WorkspaceTabRecord[]
      readonly active: string
      readonly revision: number
      readonly operationWatermarks: Readonly<Record<string, number>>
    }
  | { readonly id: number; readonly kind: 'mutate'; readonly mutation: WorkspaceTabMutation }
  | { readonly id: number; readonly kind: 'heartbeat' }
  | { readonly id: number; readonly kind: 'close' }

export type WorkspaceWorkerResponse =
  | { readonly kind: 'response'; readonly id: number; readonly value: WorkspaceTabSnapshot | undefined }
  | { readonly kind: 'error'; readonly id: number; readonly message: string }
  | { readonly kind: 'snapshot'; readonly snapshot: WorkspaceTabSnapshot }

const clone = <T>(value: T): T => structuredClone(value)
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512

function decodeRecord(value: unknown): WorkspaceTabRecord {
  if (value === null || typeof value !== 'object') throw new Error('invalid workspace tab')
  const row = value as Record<string, unknown>
  if (!validId(row['id']) || typeof row['title'] !== 'string') throw new Error('invalid workspace tab identity')
  const loaded = loadDocument(row['document'])
  if (loaded.document === undefined || loaded.document.lineage !== row['id']) {
    throw new Error('workspace tab document does not match its identity')
  }
  return {
    id: row['id'],
    title: row['title'],
    document: loaded.document,
    ...(typeof row['editorKind'] === 'string' && row['editorKind'].length > 0 ? { editorKind: row['editorKind'] } : {}),
    ...(row['stock'] === true ? { stock: true as const } : {}),
  }
}

export class SharedWorkerTabAuthority {
  static readonly PORT_LEASE_MS = 90_000
  private tabs: WorkspaceTabRecord[] | undefined
  private active = ''
  private revision = 0
  private readonly ports = new Set<WorkerPortLike>()
  private readonly seen = new Set<string>()
  private readonly operationWatermarks = new Map<string, number>()
  private readonly lastSeen = new Map<WorkerPortLike, number>()

  connect(port: WorkerPortLike): void {
    port.addEventListener('message', (event) => this.receive(port, event.data))
    port.start?.()
  }

  private receive(port: WorkerPortLike, raw: unknown): void {
    let request: WorkspaceWorkerRequest
    try {
      this.lastSeen.set(port, Date.now())
      this.pruneExpired(port)
      request = clone(raw) as WorkspaceWorkerRequest
      if (request === null || typeof request !== 'object' || !Number.isSafeInteger(request.id) || request.id < 0) {
        throw new Error('invalid workspace request')
      }
      const value = this.dispatch(port, request)
      this.send(port, { kind: 'response', id: request.id, value })
    } catch (error) {
      const id = raw !== null && typeof raw === 'object' && Number.isSafeInteger((raw as { id?: unknown }).id)
        ? (raw as { id: number }).id
        : 0
      this.send(port, { kind: 'error', id, message: error instanceof Error ? error.message : String(error) })
    }
  }

  private dispatch(port: WorkerPortLike, request: WorkspaceWorkerRequest): WorkspaceTabSnapshot | undefined {
    if (request.kind === 'open') {
      if (!Number.isSafeInteger(request.revision) || request.revision < 0) throw new Error('invalid workspace revision')
      const replaced = this.tabs !== undefined && request.revision > this.revision
      if (this.tabs === undefined || request.revision > this.revision) {
        this.tabs = this.decodeUnique(request.tabs)
        this.active = this.tabs.some((tab) => tab.id === request.active) ? request.active : (this.tabs[0]?.id ?? '')
        this.revision = request.revision
        this.seen.clear()
        this.operationWatermarks.clear()
        for (const [actorId, sequence] of Object.entries(request.operationWatermarks)) {
          if (validId(actorId) && Number.isSafeInteger(sequence) && sequence >= 0) {
            this.operationWatermarks.set(actorId, sequence)
          }
        }
      }
      this.ports.add(port)
      const snapshot = this.snapshot()
      if (replaced) for (const peer of this.ports) {
        if (peer !== port) this.send(peer, { kind: 'snapshot', snapshot })
      }
      return snapshot
    }
    if (!this.ports.has(port) || this.tabs === undefined) throw new Error('workspace connection is not open')
    if (request.kind === 'heartbeat') return undefined
    if (request.kind === 'close') {
      this.disconnect(port)
      return undefined
    }
    const mutation = clone(request.mutation)
    if (!validId(mutation.opId)) throw new Error('invalid workspace operation id')
    if (!validId(mutation.actorId) || !Number.isSafeInteger(mutation.sequence) || mutation.sequence < 0 ||
      !Number.isSafeInteger(mutation.baseRevision) || mutation.baseRevision < 0) {
      throw new Error('invalid workspace operation order')
    }
    if ((this.operationWatermarks.get(mutation.actorId) ?? -1) >= mutation.sequence) return this.snapshot()
    if (this.seen.has(mutation.opId)) return this.snapshot()
    this.applyMutation(mutation)
    this.seen.add(mutation.opId)
    this.operationWatermarks.set(mutation.actorId, mutation.sequence)
    this.revision += 1
    const snapshot = this.snapshot()
    for (const peer of this.ports) if (peer !== port) this.send(peer, { kind: 'snapshot', snapshot })
    return snapshot
  }

  private applyMutation(mutation: WorkspaceTabMutation): void {
    const removals = new Set(mutation.removals.filter(validId))
    const byId = new Map(this.tabs!.filter((tab) => !removals.has(tab.id)).map((tab) => [tab.id, tab]))
    for (const value of mutation.updates) {
      const current = byId.get(value.id)
      if (!current || typeof value.title !== 'string') continue
      byId.set(value.id, {
        id: current.id,
        title: value.title,
        document: current.document,
        ...(value.editorKind ? { editorKind: value.editorKind } : {}),
        ...(value.stock ? { stock: true as const } : {}),
      })
    }
    for (const value of mutation.additions) {
      const record = decodeRecord(value)
      if (!byId.has(record.id)) byId.set(record.id, record)
    }
    const desired: string[] = []
    const ordered = new Set<string>()
    for (const id of mutation.order) {
      if (!validId(id) || ordered.has(id) || !byId.has(id)) continue
      ordered.add(id)
      desired.push(id)
    }
    for (const id of byId.keys()) if (!ordered.has(id)) desired.push(id)
    this.tabs = desired.map((id) => byId.get(id)!)
    this.active = byId.has(mutation.active)
      ? mutation.active
      : byId.has(this.active) ? this.active : (this.tabs[0]?.id ?? '')
  }

  private decodeUnique(values: readonly WorkspaceTabRecord[]): WorkspaceTabRecord[] {
    const records: WorkspaceTabRecord[] = []
    const ids = new Set<string>()
    for (const value of values) {
      const record = decodeRecord(value)
      if (ids.has(record.id)) continue
      ids.add(record.id)
      records.push(record)
    }
    return records
  }

  private snapshot(): WorkspaceTabSnapshot {
    return clone({
      revision: this.revision,
      tabs: this.tabs ?? [],
      active: this.active,
      operationWatermarks: Object.fromEntries(this.operationWatermarks),
    })
  }

  private disconnect(port: WorkerPortLike): void {
    this.ports.delete(port)
    this.lastSeen.delete(port)
    if (this.ports.size === 0) {
      this.tabs = undefined
      this.active = ''
      this.revision = 0
      this.seen.clear()
      this.operationWatermarks.clear()
    }
  }

  private pruneExpired(except: WorkerPortLike): void {
    const expiredBefore = Date.now() - SharedWorkerTabAuthority.PORT_LEASE_MS
    for (const [port, seen] of this.lastSeen) {
      if (port !== except && seen < expiredBefore) this.disconnect(port)
    }
  }

  private send(port: WorkerPortLike, response: WorkspaceWorkerResponse): void {
    port.postMessage(clone(response))
  }
}
