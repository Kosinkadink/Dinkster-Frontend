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

export function subscribeRequestFailures(listener: (failure: RequestFailure) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function report(failure: RequestFailure): void {
  for (const listener of listeners) listener(failure)
}

/** Observe failures without changing status-dependent recovery or consuming the response. */
export function requestFetch(fetchFn: FetchLike): FetchLike {
  return async (url, init) => {
    const method = init?.method ?? 'GET'
    const path = new URL(url, 'http://dinkster.invalid').pathname
    let response: Response
    try {
      response = await fetchFn(url, init)
    } catch (cause) {
      if (init?.signal?.aborted && init.signal.reason?.name === 'AbortError') throw cause
      const failure = new RequestFailure(method, path, undefined, undefined, { cause })
      report(failure)
      throw failure
    }
    if (!response.ok) {
      const failure = new RequestFailure(method, path, response.status)
      failures.set(response, failure)
      report(failure)
    }
    return response
  }
}

export async function requestFailure(response: Response, readMessage = true): Promise<RequestFailure> {
  const detail = failures.get(response)
  let serverMessage: string | undefined
  if (readMessage && !response.bodyUsed && response.headers.get('content-type')?.includes('application/json')) {
    const body: unknown = await response.json().catch(() => undefined)
    if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string') {
      serverMessage = body.message.trim() || undefined
    }
  }
  return new RequestFailure(detail?.method ?? 'GET', detail?.path ?? new URL(response.url || '/', 'http://dinkster.invalid').pathname, response.status, serverMessage)
}

export function requestFailureReason(error: unknown, reasons = {
  unanswered: 'The engine did not answer.',
  access: 'You do not have access.',
  server: 'The engine reported an error.',
}): string | undefined {
  if (error instanceof RequestFailure) {
    if (error.serverMessage !== undefined) return error.serverMessage
    if (error.status === undefined) return reasons.unanswered
  }
  if (!(error instanceof Error) || !('status' in error) || typeof error.status !== 'number') return undefined
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
