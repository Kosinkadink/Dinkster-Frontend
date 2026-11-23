/**
 * Calls a node's declared pack function for a button's `Call` step:
 * `POST /api/node-functions/call`. The backend streams one JSON line per
 * progress report and ends with the answer, a refusal, or a file line
 * followed by the file's bytes.
 *
 * Numbers keep their kind across JSON as the engine writes them: a whole
 * number outside JavaScript's safe range is `{"$int": "digits"}` and a
 * decimal with no fraction `{"$float": n}`. Here whole numbers are bigints
 * and decimals numbers, as the step runner and formulas read them.
 */

import type { CallAnswer, CallArg, CallRequest } from '@dinkster/core'

export const PACK_FUNCTION_ROUTE = '/api/node-functions/call'
const FILE_MAX_BYTES = 64 * 1024 * 1024
const PAUSED_MESSAGE = 'Paused. Try again in a moment.'
const FAILED_MESSAGE = 'The pack could not do this.'

export interface PackFunctionClientConfig {
  /** HTTP base, no trailing slash. '' = same origin. */
  readonly baseUrl: string
  readonly fetchFn?: (url: string, init?: RequestInit) => Promise<Response>
}

/** An argument as the engine reads it. */
export function argToWire(value: CallArg): unknown {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : { $int: value.toString() }
  }
  if (typeof value === 'number') return Number.isInteger(value) ? { $float: value } : value
  if (Array.isArray(value)) return value.map(argToWire)
  return value
}

/** A value of an answer: whole numbers become bigints, decimals stay numbers. */
export function valueFromWire(value: unknown): unknown {
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : value
  if (Array.isArray(value)) return value.map(valueFromWire)
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length === 1 && typeof record['$int'] === 'string' && /^-?[0-9]+$/.test(record['$int'])) return BigInt(record['$int'])
    if (keys.length === 1 && typeof record['$float'] === 'number') return record['$float']
    return Object.fromEntries(keys.map((key) => [key, valueFromWire(record[key])]))
  }
  return value
}

const notesOf = (line: Record<string, unknown>): readonly string[] =>
  Array.isArray(line['notes']) ? line['notes'].filter((note): note is string => typeof note === 'string') : []

const failed = (message: unknown): CallAnswer =>
  ({ kind: 'failed', message: typeof message === 'string' && message !== '' ? message : FAILED_MESSAGE })

/** One press's call. Aborting the signal stops waiting; the backend tells the function it was cancelled. */
export async function callPackFunction(
  config: PackFunctionClientConfig,
  request: CallRequest,
  progress: (fraction: number, text: string) => void,
  signal: AbortSignal,
): Promise<CallAnswer> {
  const body = JSON.stringify({
    nodeType: request.nodeType,
    function: request.function,
    args: request.args.map(argToWire),
    ...(request.download !== undefined ? { download: request.download } : { writes: request.writes ?? [] }),
  })
  const response = await (config.fetchFn ?? fetch)(`${config.baseUrl}${PACK_FUNCTION_ROUTE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal,
    redirect: 'error',
  })
  if (!response.ok) {
    if (response.status === 429) return failed(PAUSED_MESSAGE)
    const refusal = await response.json().catch(() => ({})) as Record<string, unknown>
    return failed(refusal['message'])
  }
  if (response.body === null) return failed(undefined)

  const reader = response.body.getReader()
  let buffer = new Uint8Array(0)
  const append = (chunk: Uint8Array): void => {
    const next = new Uint8Array(buffer.length + chunk.length)
    next.set(buffer)
    next.set(chunk, buffer.length)
    buffer = next
  }
  const more = async (): Promise<boolean> => {
    const { done, value } = await reader.read()
    if (value !== undefined) append(value)
    return !done
  }
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const end = buffer.indexOf(10)
      if (end < 0) {
        if (!(await more())) return failed(undefined)
        continue
      }
      const line = JSON.parse(decoder.decode(buffer.subarray(0, end))) as Record<string, unknown>
      buffer = buffer.subarray(end + 1)
      if (typeof line['progress'] === 'number') {
        progress(line['progress'], typeof line['text'] === 'string' ? line['text'] : '')
      } else if (typeof line['error'] === 'string') {
        return failed(line['message'])
      } else if (typeof line['answer'] === 'object' && line['answer'] !== null) {
        return { kind: 'answer', fields: valueFromWire(line['answer']) as Record<string, unknown>, notes: notesOf(line) }
      } else if (typeof line['file'] === 'number') {
        const size = line['file']
        if (size > FILE_MAX_BYTES) return failed('The file is larger than 64 MiB, so it was not delivered.')
        while (buffer.length < size) {
          if (!(await more())) return failed('The file did not arrive whole.')
        }
        return { kind: 'file', bytes: buffer.slice(0, size), notes: notesOf(line) }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
