import { describe, expect, it } from 'vitest'
import { callPackFunction } from '../src/pack-functions.js'

/** A streamed response cut at the given byte offsets, as a network delivers it. */
function streamed(bytes: Uint8Array, cuts: readonly number[]): Response {
  const parts = [0, ...cuts, bytes.length]
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < parts.length - 1; index++) controller.enqueue(bytes.slice(parts[index], parts[index + 1]))
      controller.close()
    },
  }), { headers: { 'Content-Type': 'application/x-ndjson' } })
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('callPackFunction', () => {
  it('sends whole numbers and decimals apart and reads progress, then the answer', async () => {
    let sent: unknown
    const lines = [
      { progress: 0.25, text: 'Translating' },
      { answer: { text: 'hello', count: 3, ratio: { $float: 2 }, huge: { $int: '9007199254740993' }, part: 0.5 }, notes: ['Kept as written: playa.'] },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n'
    const progress: [number, string][] = []
    const answer = await callPackFunction({
      baseUrl: '/b',
      fetchFn: async (url, init) => {
        sent = [url, JSON.parse(String(init?.body))]
        return streamed(encode(lines), [7, 40])
      },
    }, { nodeType: 'dev.buttons.translate', function: 'mod.translate_now', args: ['hola', 1n, 2, 0.5, 9007199254740993n], writes: ['text'] },
    (fraction, text) => progress.push([fraction, text]), new AbortController().signal)
    expect(sent).toEqual(['/b/api/node-functions/call', {
      nodeType: 'dev.buttons.translate', function: 'mod.translate_now',
      args: ['hola', 1, { $float: 2 }, 0.5, { $int: '9007199254740993' }], writes: ['text'],
    }])
    expect(progress).toEqual([[0.25, 'Translating']])
    expect(answer).toEqual({
      kind: 'answer',
      fields: { text: 'hello', count: 3n, ratio: 2, huge: 9007199254740993n, part: 0.5 },
      notes: ['Kept as written: playa.'],
    })
  })

  it('reads a file that follows its line, whatever the chunks', async () => {
    const file = new Uint8Array([10, 0, 255, 10, 7])
    const head = encode(`${JSON.stringify({ file: file.length, notes: [] })}\n`)
    const bytes = new Uint8Array([...head, ...file])
    const answer = await callPackFunction({ baseUrl: '', fetchFn: async () => streamed(bytes, [3, head.length + 1, head.length + 3]) },
      { nodeType: 't', function: 'f', args: [], download: 'x.bin' }, () => {}, new AbortController().signal)
    expect(answer).toEqual({ kind: 'file', bytes: file, notes: [] })
  })

  it('reports a refusal, a pause and a short file as failures', async () => {
    const call = (response: Response) => callPackFunction({ baseUrl: '', fetchFn: async () => response },
      { nodeType: 't', function: 'f', args: [], writes: ['a'] }, () => {}, new AbortController().signal)
    expect(await call(streamed(encode('{"error":"failed","message":"No sheet named video in this file."}\n'), [])))
      .toEqual({ kind: 'failed', message: 'No sheet named video in this file.' })
    expect(await call(new Response('{"error":"paused"}', { status: 429 }))).toEqual({ kind: 'failed', message: 'Paused. Try again in a moment.' })
    expect(await call(streamed(encode('{"file":10,"notes":[]}\nabc'), [])))
      .toEqual({ kind: 'failed', message: 'The file did not arrive whole.' })
  })
})
