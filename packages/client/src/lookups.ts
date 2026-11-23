/**
 * Calls a node's declared lookups through the host (`POST /api/lookups`).
 *
 * One request serves every node asking the same function with equal typed
 * arguments. An answer is kept until an explicit trigger (Refresh, a changed
 * catalog, a watched asset kind, a run): there is no timer. Each node has at
 * most one request in flight; a node's later request waits for its earlier
 * one. A consumer that stops waiting cancels the call only when nobody else
 * waits for it. Answers are kept per exact arguments, so an answer for old
 * arguments is never shown as the answer for new ones.
 */

export const LOOKUPS_PATH = '/api/lookups'
export const LOOKUP_ANSWER_MAX_BYTES = 1024 * 1024
/** Guards against a connection that never answers; the host bounds the call itself. */
const LOOKUP_NETWORK_LIMIT_MS = 120_000

export type LookupScalar = bigint | number | boolean | string
/** A typed argument: a value, a list of values, or an asset's wire object. */
export type LookupArg = LookupScalar | readonly LookupScalar[] | Readonly<Record<string, unknown>>

export interface LookupCall {
  /** A node type that declares the lookup; the host checks it does. */
  readonly nodeType: string
  /** The node occurrence asking, for one request in flight per node. */
  readonly node: string
  /** The lookup's wire name, as declared. */
  readonly function: string
  readonly args: readonly LookupArg[]
}

export type LookupFailure =
  | 'failed'
  | 'timeout'
  | 'wrong-shape'
  | 'invalid-arguments'
  | 'unknown'
  | 'file-unchecked'
  | 'offline'

export type LookupEntry =
  | { readonly state: 'loading'; readonly answer?: unknown }
  | { readonly state: 'ready'; readonly answer: unknown }
  | { readonly state: 'stale'; readonly answer: unknown; readonly reason: LookupFailure }
  | { readonly state: 'unavailable'; readonly reason: LookupFailure }
  | { readonly state: 'paused'; readonly answer?: unknown }

export type LookupResult =
  | { readonly state: 'ready'; readonly value: unknown }
  | { readonly state: 'failed'; readonly reason: LookupFailure }
  | { readonly state: 'paused' }

export interface LookupPartition {
  readonly backend: string
  readonly epoch: number
  readonly principal: number
}

export interface LookupRequestOptions {
  readonly signal?: AbortSignal
  /** Ask again even when a current answer is kept (the list's Refresh). */
  readonly refresh?: boolean
}

export interface LookupClient {
  /** The current answer for these arguments, asking the host when there is none. */
  request(call: LookupCall, options?: LookupRequestOptions): Promise<LookupEntry>
  /** For button steps: a stale answer is a failure, and `options` answers are shape checked. */
  resolve(call: LookupCall, use: 'options' | 'value', options: { readonly signal: AbortSignal }): Promise<LookupResult>
  /** What to show for these arguments now, without asking. */
  entry(call: Pick<LookupCall, 'function' | 'args'>): LookupEntry | undefined
  /** Whether a kept answer was made old by a trigger and should be asked for again. */
  isOld(call: Pick<LookupCall, 'function' | 'args'>): boolean
  subscribe(listener: () => void): () => void
  /** Make the kept answers of these functions (all when absent) old. */
  invalidate(functions?: readonly string[]): void
  /** A different backend, catalog or user: drop every answer and call. */
  setPartition(partition: LookupPartition): void
  dispose(): void
}

export interface LookupClientConfig {
  /** HTTP base, no trailing slash. '' = same origin. */
  readonly baseUrl: string
  readonly fetchFn?: (url: string, init?: RequestInit) => Promise<Response>
}

const FAILURE_CODES: Readonly<Record<string, LookupFailure>> = {
  'lookup-failed': 'failed',
  'lookup-timeout': 'timeout',
  'lookup-wrong-shape': 'wrong-shape',
  'lookup-invalid-arguments': 'invalid-arguments',
  'lookup-unknown': 'unknown',
  'lookup-file-unchecked': 'file-unchecked',
}

class LookupFault extends Error {
  constructor(readonly reason: LookupFailure) {
    super(reason)
  }
}
class Paused extends Error {}
class Superseded extends Error {}

interface Inflight {
  readonly controller: AbortController
  /** What was shown before, restored when every waiter leaves. */
  readonly before: LookupEntry | undefined
  readonly promise: Promise<LookupEntry>
  waiters: number
}

interface Kept {
  state: LookupEntry
  /** The last ready answer for exactly these arguments. */
  answer?: { readonly value: unknown }
  old: boolean
  inflight?: Inflight
}

/** JSON with whole numbers past 2^53 written as their digits. */
export function lookupArgsJson(value: unknown): string {
  const marks: string[] = []
  const text = JSON.stringify(value, (_, item: unknown) => {
    if (typeof item !== 'bigint') return item
    marks.push(item.toString())
    return `\u0000bigint${marks.length - 1}\u0000`
  })
  return text.replace(/"\\u0000bigint(\d+)\\u0000"/g, (_, index: string) => marks[Number(index)]!)
}

const keyOf = (call: Pick<LookupCall, 'function' | 'args'>): string => lookupArgsJson([call.function, call.args])

const isOption = (item: unknown): boolean => {
  if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') return true
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
  const value = (item as { value?: unknown }).value
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** Whether an answer has the shape of a field's options. */
export const isLookupOptions = (answer: unknown): answer is readonly unknown[] =>
  Array.isArray(answer) && answer.every(isOption)

const aborted = (): DOMException => new DOMException('lookup request aborted', 'AbortError')

export function createLookupClient(config: LookupClientConfig): LookupClient {
  const fetchFn = config.fetchFn ?? ((url: string, init?: RequestInit) => fetch(url, init))
  let partition: LookupPartition = { backend: config.baseUrl, epoch: 0, principal: 0 }
  let kept = new Map<string, Kept>()
  const nodeQueues = new Map<string, Promise<unknown>>()
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const settle = (entry: Kept, state: LookupEntry): LookupEntry => {
    entry.state = state
    notify()
    return state
  }

  const ask = async (call: LookupCall, signal: AbortSignal): Promise<unknown> => {
    const limit = AbortSignal.timeout(LOOKUP_NETWORK_LIMIT_MS)
    const both = AbortSignal.any([signal, limit])
    let response: Response
    try {
      response = await fetchFn(`${config.baseUrl}${LOOKUPS_PATH}`, {
        method: 'POST',
        redirect: 'error',
        signal: both,
        headers: { 'content-type': 'application/json', 'if-match': String(partition.epoch) },
        body: lookupArgsJson({ nodeType: call.nodeType, function: call.function, args: call.args }),
      })
    } catch (error) {
      if (signal.aborted) throw aborted()
      throw new LookupFault(limit.aborted ? 'timeout' : 'offline')
    }
    if (response.status === 429) throw new Paused()
    if (response.status === 412) throw new Superseded()
    const text = await response.text()
    if (new TextEncoder().encode(text).length > LOOKUP_ANSWER_MAX_BYTES + 64) throw new LookupFault('wrong-shape')
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new LookupFault(response.ok ? 'wrong-shape' : 'failed')
    }
    if (!response.ok) {
      const code = (body as { error?: unknown } | null)?.error
      throw new LookupFault(typeof code === 'string' ? (FAILURE_CODES[code] ?? 'failed') : 'failed')
    }
    if (typeof body !== 'object' || body === null || !('answer' in body)) throw new LookupFault('wrong-shape')
    return (body as { answer: unknown }).answer
  }

  const start = (key: string, entry: Kept, call: LookupCall): Inflight => {
    const controller = new AbortController()
    const owner = kept
    const before = entry.answer || entry.state.state !== 'loading' ? entry.state : undefined
    entry.state = entry.answer ? { state: 'loading', answer: entry.answer.value } : { state: 'loading' }
    const previous = nodeQueues.get(call.node) ?? Promise.resolve()
    const run = async (): Promise<LookupEntry> => {
      await previous.catch(() => undefined)
      if (controller.signal.aborted) throw aborted()
      try {
        const answer = await ask(call, controller.signal)
        if (kept !== owner) throw aborted()
        entry.answer = { value: answer }
        entry.old = false
        return settle(entry, { state: 'ready', answer })
      } catch (error) {
        if (controller.signal.aborted || kept !== owner) throw aborted()
        if (error instanceof Paused) {
          return settle(entry, entry.answer ? { state: 'paused', answer: entry.answer.value } : { state: 'paused' })
        }
        if (error instanceof Superseded) {
          owner.delete(key)
          return settle(entry, { state: 'unavailable', reason: 'unknown' })
        }
        const reason = error instanceof LookupFault ? error.reason : 'failed'
        return settle(
          entry,
          entry.answer
            ? { state: 'stale', answer: entry.answer.value, reason }
            : { state: 'unavailable', reason },
        )
      } finally {
        if (entry.inflight?.controller === controller) delete entry.inflight
      }
    }
    const promise = run()
    const queued = promise.catch(() => undefined)
    nodeQueues.set(call.node, queued)
    void queued.then(() => {
      if (nodeQueues.get(call.node) === queued) nodeQueues.delete(call.node)
    })
    notify()
    return { controller, before, promise, waiters: 0 }
  }

  const join = async (key: string, entry: Kept, inflight: Inflight, signal?: AbortSignal): Promise<LookupEntry> => {
    if (signal?.aborted) throw aborted()
    inflight.waiters += 1
    let left = false
    const leave = (): void => {
      if (left) return
      left = true
      inflight.waiters -= 1
      if (inflight.waiters === 0 && entry.inflight === inflight) {
        inflight.controller.abort()
        delete entry.inflight
        if (inflight.before) {
          entry.state = inflight.before
        } else if (kept.get(key) === entry) {
          kept.delete(key)
        }
        notify()
      }
    }
    try {
      if (!signal) return await inflight.promise
      return await new Promise<LookupEntry>((resolve, reject) => {
        const onAbort = (): void => {
          leave()
          reject(aborted())
        }
        signal.addEventListener('abort', onAbort, { once: true })
        inflight.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
      })
    } finally {
      if (!left) {
        left = true
        inflight.waiters -= 1
      }
    }
  }

  const request = (call: LookupCall, options: LookupRequestOptions = {}): Promise<LookupEntry> => {
    const key = keyOf(call)
    let entry = kept.get(key)
    // A failed or paused answer stays until a trigger: Try again, other
    // arguments, or an invalidation. Showing it never asks again by itself.
    if (entry && !entry.inflight && !entry.old && !options.refresh) return Promise.resolve(entry.state)
    if (!entry) {
      entry = { state: { state: 'loading' }, old: false }
      kept.set(key, entry)
    }
    if (!entry.inflight) entry.inflight = start(key, entry, call)
    return join(key, entry, entry.inflight, options.signal)
  }

  return {
    request,
    async resolve(call, use, options) {
      const entry = await request(call, { signal: options.signal })
      if (entry.state === 'paused') return { state: 'paused' }
      if (entry.state === 'ready') {
        if (use === 'options' && !isLookupOptions(entry.answer)) return { state: 'failed', reason: 'wrong-shape' }
        return { state: 'ready', value: entry.answer }
      }
      return { state: 'failed', reason: entry.state === 'loading' ? 'failed' : entry.reason }
    },
    entry(call) {
      return kept.get(keyOf(call))?.state
    },
    isOld(call) {
      return kept.get(keyOf(call))?.old ?? false
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    invalidate(functions) {
      const names = functions ? new Set(functions) : undefined
      let changed = false
      for (const [key, entry] of kept) {
        const name = (JSON.parse(key) as [string])[0]
        if (names && !names.has(name)) continue
        if (entry.answer) {
          entry.old = true
          changed = true
        } else if (!entry.inflight) {
          kept.delete(key)
          changed = true
        }
      }
      if (changed) notify()
    },
    setPartition(next) {
      if (
        next.backend === partition.backend &&
        next.epoch === partition.epoch &&
        next.principal === partition.principal
      ) {
        return
      }
      partition = next
      const dropped = kept
      kept = new Map()
      for (const entry of dropped.values()) entry.inflight?.controller.abort()
      notify()
    },
    dispose() {
      for (const entry of kept.values()) entry.inflight?.controller.abort()
      kept = new Map()
      listeners.clear()
    },
  }
}
