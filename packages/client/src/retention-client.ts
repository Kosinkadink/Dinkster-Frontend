import type { FetchLike } from './connection-contract.js'
import { EngineNotReadyError, parseEngineNotReady } from './supervisor.js'

export type RetentionHolderClass = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export interface RetentionClientStatus {
  readonly clientId: string
  readonly generation: string
  readonly revision: number
  readonly connected: boolean
  readonly pendingRequests: number
  readonly activeStreams: number
  readonly complete: boolean
  readonly holders: Readonly<Record<string, readonly Record<string, unknown>[]>>
}

function status(value: unknown): RetentionClientStatus {
  const invalid = (): never => { throw new Error('Retention client census is malformed') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  const v = value as Record<string, unknown>
  if (typeof v['clientId'] !== 'string' || !/^[0-9a-f]{32}$/.test(v['clientId']) ||
    typeof v['generation'] !== 'string' || !/^[0-9a-f]{32}$/.test(v['generation']) ||
    !['revision', 'pendingRequests', 'activeStreams'].every((key) =>
      Number.isSafeInteger(v[key]) && (v[key] as number) >= (key === 'revision' ? 1 : 0)) ||
    typeof v['connected'] !== 'boolean' || typeof v['complete'] !== 'boolean' ||
    typeof v['holders'] !== 'object' || v['holders'] === null || Array.isArray(v['holders'])) return invalid()
  const holders = v['holders'] as Record<string, unknown>
  if (Object.keys(holders).length !== 8 || !Array.from({ length: 8 }, (_, i) => String(i + 1)).every((key) =>
    Array.isArray(holders[key]) && (holders[key] as unknown[]).every((owner) =>
      typeof owner === 'object' && owner !== null && !Array.isArray(owner) &&
      typeof (owner as Record<string, unknown>)['complete'] === 'boolean'))) return invalid()
  return value as RetentionClientStatus
}

const generationHeader = 'X-Dinkster-Retention-Generation'

/** One backend/principal's enrollment, shared by its HTTP and event transports. */
export class RetentionClient {
  private generation: string | undefined
  private opening: Promise<string | undefined> | undefined
  private unsupported = false
  private gate: Promise<void> | undefined
  private windows: Promise<unknown> = Promise.resolve()
  private readonly streams = new Set<() => () => void>()
  private readonly endpoint: string
  private reconnecting: Promise<void> | undefined

  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
    private readonly storage?: Pick<Storage, 'getItem' | 'setItem'>,
  ) {
    this.endpoint = `${baseUrl.replace(/\/+$/, '')}/api/library/retention-clients`
    try {
      const saved = storage?.getItem(this.storageKey)
      if (saved !== null && saved !== undefined) {
        if (!/^[0-9a-f]{32}$/.test(saved)) throw new Error('Stored retention generation is malformed')
        this.generation = saved
      }
    } catch {
      // Unreadable storage cannot authorize adopting any existing owner.
    }
  }

  private get storageKey(): string { return `dinkster.retention-generation.${this.baseUrl}` }

  private async request(method: string, body?: unknown): Promise<Response> {
    const headers = new Headers({ 'Content-Type': 'application/json' })
    if (this.generation !== undefined) headers.set(generationHeader, this.generation)
    const response = await this.fetchFn(this.endpoint, {
      method, headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (response.status === 503) {
      const gate = parseEngineNotReady(await response.clone().json().catch(() => undefined))
      if (gate !== undefined) throw new EngineNotReadyError(gate.state)
    }
    return response
  }

  private async census(): Promise<RetentionClientStatus> {
    const response = await this.request('GET')
    if (!response.ok) throw new Error(`GET retention client failed: ${response.status}`)
    const current = status(await response.json())
    if (current.generation !== this.generation) throw new Error('Retention client generation differs')
    return current
  }

  /** A saved generation is reopened only from its freshly read revision. */
  async enroll(): Promise<string | undefined> {
    if (this.unsupported) return undefined
    this.opening ??= (async () => {
      const previous = this.generation === undefined ? undefined : await this.census()
      const response = await this.request('POST', { revision: previous?.revision ?? 0 })
      // Engines without a library have no census route and cannot collect.
      if (response.status === 404 && previous === undefined) {
        this.unsupported = true
        return undefined
      }
      if (!response.ok) throw new Error(`POST retention client failed: ${response.status}`)
      const current = status(await response.json())
      if (!current.connected || current.complete || current.pendingRequests !== 0 || current.activeStreams !== 0 ||
        (previous !== undefined && (current.clientId !== previous.clientId || current.generation === previous.generation ||
          current.revision !== previous.revision + 1))) throw new Error('Retention client reopen acknowledgment differs')
      this.generation = current.generation
      try { this.storage?.setItem(this.storageKey, current.generation) } catch { /* Session-only identity. */ }
      return current.generation
    })()
    try { return await this.opening } catch (error) {
      this.opening = undefined
      throw error
    }
  }

  private belongsToBackend(url: string): boolean {
    const origin = globalThis.location?.href ?? 'http://same-origin.invalid'
    const base = new URL(`${this.baseUrl.replace(/\/+$/, '')}/`, origin)
    const target = new URL(url, origin)
    return target.origin === base.origin && target.pathname.startsWith(base.pathname)
  }

  private enrolledFetch(url: string, init?: RequestInit): Promise<Response> {
    if (!this.belongsToBackend(url)) throw new Error('Retention generation cannot leave its backend')
    const headers = new Headers(init?.headers)
    if (this.generation !== undefined) headers.set(generationHeader, this.generation)
    return this.fetchFn(url, { ...init, headers, redirect: 'error' })
  }

  readonly fetch: FetchLike = async (url, init) => {
    if (!this.belongsToBackend(url)) throw new Error('Retention generation cannot leave its backend')
    try { await this.enroll() } catch (error) {
      // Only a supervisor's explicit startup gate proves these probes cannot reach asset handlers.
      if (error instanceof EngineNotReadyError &&
        (url === `${this.baseUrl}/supervisor/status` || url === `${this.baseUrl}/supervisor/engine/restart`)) {
        return this.fetchFn(url, { ...init, redirect: 'error' })
      }
      throw error
    }
    while (this.gate !== undefined) await this.gate
    init?.signal?.throwIfAborted()
    return this.enrolledFetch(url, init)
  }

  async socketUrl(url: string): Promise<string> {
    const target = new URL(url, globalThis.location?.href ?? 'http://same-origin.invalid')
    const httpUrl = new URL(target)
    httpUrl.protocol = httpUrl.protocol === 'wss:' ? 'https:' : httpUrl.protocol === 'ws:' ? 'http:' : httpUrl.protocol
    if (!this.belongsToBackend(httpUrl.href.replace('http://same-origin.invalid', ''))) {
      throw new Error('Retention generation cannot leave its backend')
    }
    await this.enroll()
    while (this.gate !== undefined) await this.gate
    if (this.unsupported) return url
    this.reconnecting ??= (async () => {
      const current = await this.census()
      if (!current.connected) {
        this.opening = undefined
        await this.enroll()
      }
    })()
    try { await this.reconnecting } finally { this.reconnecting = undefined }
    while (this.gate !== undefined) await this.gate
    target.searchParams.set('retentionGeneration', this.generation!)
    return url.startsWith('/') ? `${target.pathname}${target.search}` : target.href
  }

  /** Suspend must cancel automatic reconnect; its return value resumes that same lifetime. */
  registerStream(suspend: () => () => void): () => void {
    this.streams.add(suspend)
    if (this.gate !== undefined) {
      const resume = suspend()
      void this.gate.then(resume)
    }
    return () => this.streams.delete(suspend)
  }

  /** Only this callback may observe the backend while its streams are suspended. */
  collect<T>(operation: (fetchFn: FetchLike) => Promise<T>): Promise<T> {
    const pending = this.windows.then(async () => {
      await this.enroll()
      const resumes: (() => void)[] = []
      let release!: () => void
      this.gate = new Promise<void>((resolve) => { release = resolve })
      try {
        for (const suspend of [...this.streams]) resumes.push(suspend())
        if (!this.unsupported) {
          const deadline = AbortSignal.timeout(10_000)
          let current = await this.census()
          while (current.pendingRequests > 0 || current.activeStreams > 0) {
            deadline.throwIfAborted()
            await new Promise((resolve) => setTimeout(resolve, 25))
            current = await this.census()
          }
          if (Object.values(current.holders).every((owners) => owners.every((owner) => owner['complete'] === true))) {
            const response = await this.request('PUT', { revision: current.revision, holders: current.holders })
            // Another observing request can win the race; evaluated eligibility remains blocked.
            if (!response.ok && response.status !== 409) throw new Error(`PUT retention client failed: ${response.status}`)
          }
        }
        return await operation((url, init) => this.enrolledFetch(url, init))
      } finally {
        this.gate = undefined
        release()
        for (const resume of resumes) resume()
      }
    })
    this.windows = pending.catch(() => {})
    return pending
  }

  /** Disconnect invalidates acknowledgment; it never releases durable owners. */
  async disconnect(): Promise<void> {
    if (this.opening === undefined || this.unsupported) return
    await this.opening
    const response = await this.request('DELETE', {})
    if (!response.ok) throw new Error(`DELETE retention client failed: ${response.status}`)
    this.opening = undefined
  }
}
