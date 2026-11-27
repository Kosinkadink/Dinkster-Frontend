import type { FetchLike } from './connection-contract.js'

export class RequestFailure extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status?: number,
    readonly serverMessage?: string,
    options?: ErrorOptions,
  ) {
    super(`${method} ${path} failed${status === undefined ? ': no answer' : `: ${status}`}`, options)
    this.name = 'RequestFailure'
  }
}

const failures = new WeakMap<Response, RequestFailure>()
const listeners = new Set<(failure: RequestFailure) => void>()
const observedFetches = new WeakSet<FetchLike>()
const history: RequestFailure[] = []

export function subscribeRequestFailures(listener: (failure: RequestFailure) => void, replay = false): () => void {
  if (replay) for (const failure of history) listener(failure)
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function report(failure: RequestFailure): void {
  history.push(new RequestFailure(failure.method, failure.path, failure.status))
  if (history.length > 500) history.shift()
  for (const listener of listeners) listener(failure)
}

/** Observe failures without changing status-dependent recovery or consuming the response. */
export function requestFetch(fetchFn: FetchLike): FetchLike {
  if (observedFetches.has(fetchFn)) return fetchFn
  const observed: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    const path = new URL(url, 'http://dinkster.invalid').pathname
    let response: Response
    let timeoutReported = false
    const onAbort = () => {
      if (init?.signal?.reason?.name === 'TimeoutError') {
        timeoutReported = true
        report(new RequestFailure(method, path, undefined, undefined, { cause: init.signal.reason }))
      }
    }
    init?.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      response = await fetchFn(url, init)
    } catch (cause) {
      if (init?.signal?.aborted && init.signal.reason?.name === 'AbortError') throw cause
      const failure = new RequestFailure(method, path, undefined, undefined, { cause })
      if (!timeoutReported) report(failure)
      throw failure
    } finally {
      init?.signal?.removeEventListener('abort', onAbort)
    }
    if (!response.ok) {
      const failure = new RequestFailure(method, path, response.status)
      failures.set(response, failure)
      report(failure)
    }
    return response
  }
  observedFetches.add(observed)
  return observed
}

export async function requestFailure(response: Response, readMessage: boolean | 'error' = true): Promise<RequestFailure> {
  const detail = failures.get(response)
  let serverMessage: string | undefined
  if (readMessage && !response.bodyUsed && response.headers.get('content-type')?.includes('application/json')) {
    const body: unknown = await response.json().catch(() => undefined)
    if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string') {
      serverMessage = body.message.trim() || undefined
    } else if (readMessage === 'error' && typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
      serverMessage = body.error.trim() || undefined
    }
  }
  return new RequestFailure(detail?.method ?? 'GET', detail?.path ?? new URL(response.url || '/', 'http://dinkster.invalid').pathname, response.status, serverMessage)
}

export function requestFailureReason(error: unknown, reasons = {
  unanswered: 'The engine did not answer.',
  access: 'You do not have access.',
  server: 'The engine reported an error.',
}): string | undefined {
  if (error instanceof Error && error.name === 'TimeoutError') return reasons.unanswered
  if (error instanceof RequestFailure) {
    if (error.serverMessage !== undefined) return error.serverMessage
    if (error.status === undefined) return reasons.unanswered
  }
  if (!(error instanceof Error) || !('status' in error) || typeof error.status !== 'number') return undefined
  if ('serverError' in error && typeof error.serverError === 'string' && error.serverError.trim() !== '') return error.serverError
  if ('body' in error && typeof error.body === 'object' && error.body !== null) {
    for (const key of ['message', 'detail'] as const) {
      const value: unknown = (error.body as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
  }
  if (error.status === 401 || error.status === 403) return reasons.access
  if (error.status >= 500 && error.status <= 599) return reasons.server
  return undefined
}
