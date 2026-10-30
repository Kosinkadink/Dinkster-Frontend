/**
 * Native backend discovery: identify an engine or supervisor from a URL.
 *
 * Probe order (each step is conclusive when it matches, otherwise falls
 * through to the next):
 *
 *   1. GET /supervisor/status - a valid supervisor answer is a Dinkster
 *      deployment (engine may still be starting; the supervisor poll
 *      narrates that after add).
 *   2. GET /api/nodes - a native engine self-identifies: 200 with a nodes
 *      table is 'dinkster'; the supervisor's 503
 *      engine-not-ready gate is 'dinkster' (supervised).
 * Anything that answered but matched no protocol is 'unrecognized' - the
 * canonical case being an SPA dev server answering 200 text/html for every
 * path (routing fallthrough), which the shape checks reject. 'unreachable'
 * means no probe got any server answer at all.
 *
 * The two probes run concurrently and are judged in priority order, so a
 * dead server costs one timeout. Both probe bodies are small.
 *
 * Framework-free; fetch and timeout are injectable. Never throws.
 */
import type { FetchLike } from './connection-contract.js'
import { parseEngineNotReady, parseSupervisorStatus } from './supervisor.js'

export type BackendDiscovery =
  | { readonly kind: 'dinkster'; readonly supervised: boolean }
  | { readonly kind: 'unrecognized'; readonly detail: string }
  | { readonly kind: 'unreachable'; readonly detail: string }

export interface DiscoveryOptions {
  readonly fetchFn?: FetchLike
  /** Per-probe timeout in ms (default 4000). */
  readonly timeoutMs?: number
}

/** One probe answer, or undefined when the request itself failed. */
interface ProbeAnswer {
  readonly status: number
  readonly contentType: string
  readonly body: unknown
}

const probe = async (
  fetchFn: FetchLike,
  url: string,
  timeoutMs: number,
): Promise<ProbeAnswer | { readonly error: string }> => {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) })
    const contentType = res.headers.get('content-type') ?? ''
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = undefined // non-JSON body: the shape checks below reject it
    }
    return { status: res.status, contentType, body }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** Native /api/nodes 200 shape: an object carrying a nodes table and/or the
 * dinkster identity header. An SPA's HTML (json-parse failure -> undefined)
 * and arbitrary JSON both fail this. */
const looksLikeNativeNodes = (body: unknown): boolean => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false
  const b = body as { nodes?: unknown; dinkster?: unknown }
  return (
    (typeof b.nodes === 'object' && b.nodes !== null && !Array.isArray(b.nodes)) ||
    (typeof b.dinkster === 'object' && b.dinkster !== null && !Array.isArray(b.dinkster))
  )
}

/**
 * Identify the protocol a server at `baseUrl` speaks. `baseUrl` is either
 * empty/'' (same origin), a path prefix ('/b2'), or an absolute origin -
 * exactly the strings addBackend accepts.
 */
export async function discoverBackend(
  baseUrl: string,
  options: DiscoveryOptions = {},
): Promise<BackendDiscovery> {
  const fetchFn = options.fetchFn ?? ((url: string, init?: RequestInit) => fetch(url, init))
  const timeoutMs = options.timeoutMs ?? 4000
  const base = baseUrl.replace(/\/+$/, '')
  let sawServer = false
  let lastError = ''
  let htmlFallthrough = false

  const note = (answer: ProbeAnswer | { error: string }): ProbeAnswer | undefined => {
    if ('error' in answer) {
      lastError = answer.error
      return undefined
    }
    sawServer = true
    if (answer.contentType.includes('text/html')) htmlFallthrough = true
    return answer
  }

  const [supAnswer, nodesAnswer] = await Promise.all([
    probe(fetchFn, `${base}/supervisor/status`, timeoutMs),
    probe(fetchFn, `${base}/api/nodes`, timeoutMs),
  ])

  const sup = note(supAnswer)
  const nodes = note(nodesAnswer)

  // 1. Supervisor?
  if (sup && sup.status === 200 && parseSupervisorStatus(sup.body)) {
    return { kind: 'dinkster', supervised: true }
  }

  // 2. Native engine?
  if (nodes) {
    if (nodes.status === 200 && looksLikeNativeNodes(nodes.body)) {
      return { kind: 'dinkster', supervised: false }
    }
    if (nodes.status === 503 && parseEngineNotReady(nodes.body)) {
      return { kind: 'dinkster', supervised: true }
    }
  }

  if (sawServer) {
    return {
      kind: 'unrecognized',
      detail: htmlFallthrough
        ? 'server answered with HTML, not a backend protocol (is this URL routed to the app instead of a backend?)'
        : 'server answered but did not identify a Dinkster engine or supervisor',
    }
  }
  return { kind: 'unreachable', detail: lastError || 'no response' }
}
