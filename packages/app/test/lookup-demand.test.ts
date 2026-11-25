/**
 * What a finished run's automatic values do to the answers the editor keeps:
 * a call the run got another answer from is asked again, and nothing else is.
 */
import { describe, expect, it } from 'vitest'
import { createLookupClient } from '@dinkster/client'
import { EMPTY_CONNECTIVITY, elaborateInterface, type NodeSchema } from '@dinkster/core'
import { LookupDemand, lookupAnswersOf, recordRunAnswers } from '../src/lookup-demand.js'

describe('recorded run answers', () => {
  it('asks again only for the call whose field the run worked out to another value', async () => {
    const asked: unknown[] = []
    const answers: Record<string, unknown> = { sd: 99, sdxl: 30 }
    const client = createLookupClient({
      baseUrl: '',
      fetchFn: async (_url, init) => {
        const { args } = JSON.parse(String(init?.body)) as { args: [string] }
        asked.push(args[0])
        return new Response(JSON.stringify({ answer: answers[args[0]] }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    const call = (category: string) => ({ nodeType: 'dev.rate', node: category, function: 'pack.rate_of', args: [category] })
    await client.request(call('sd'))
    await client.request(call('sdxl'))
    answers['sd'] = 25
    recordRunAnswers(client, [
      { runtimeNodeId: 'n0', inputId: 'fps', lookup: 'pack.rate_of', args: ['sd'] },
      { runtimeNodeId: 'n1', inputId: 'fps', lookup: 'pack.rate_of', args: ['sdxl'] },
      { runtimeNodeId: 'n3', inputId: 'fps', lookup: 'pack.rate_of', args: ['sdxl'] },
    ], [
      // n0 got another answer; n1 got the one kept; n2 made no call the editor kept;
      // n3's default says nothing of the answer; n1's other field made no call.
      { runtimeNodeId: 'n0', inputId: 'fps', value: 25, workedOut: true },
      { runtimeNodeId: 'n1', inputId: 'fps', value: 30, workedOut: true },
      { runtimeNodeId: 'n2', inputId: 'fps', value: 12, workedOut: true },
      { runtimeNodeId: 'n3', inputId: 'fps', value: 24, workedOut: false },
      { runtimeNodeId: 'n1', inputId: 'other', value: 24, workedOut: true },
    ])
    expect(await client.request(call('sd'))).toEqual({ state: 'ready', answer: 25 })
    expect(await client.request(call('sdxl'))).toEqual({ state: 'ready', answer: 30 })
    expect(asked).toEqual(['sd', 'sdxl', 'sd'])
  })

  it('asks an old call shown on screen once, without cancelling it as the scene is drawn again', async () => {
    const pending: Array<(answer: unknown) => void> = []
    let aborted = 0
    const client = createLookupClient({
      baseUrl: '',
      fetchFn: (_url, init) => new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted += 1; reject(new DOMException('aborted', 'AbortError')) })
        pending.push((answer) => resolve(new Response(JSON.stringify({ answer }), { status: 200, headers: { 'content-type': 'application/json' } })))
      }),
    })
    const schema: NodeSchema = {
      type: 'dev.rate', displayName: 'Rate', category: 'test', source: 'v3', isOutputNode: true,
      body: [{ kind: 'input', id: 'fps', type: { kind: 'concrete', name: 'INT' }, optional: false,
        widget: { widgetType: 'INT', options: {}, default: 24 }, automatic: { lookup: 'pack.rate_of', args: [{ formula: '100' }] } }],
    }
    const demand = new LookupDemand(client)
    const show = () => demand.show([{ nodeType: 'dev.rate', node: 'n0',
      items: elaborateInterface(schema, { values: {} }, EMPTY_CONNECTIVITY, { lookupAnswers: lookupAnswersOf(client) }).items }])
    const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve() }
    show()
    await settle()
    pending.shift()!(99)
    await settle()
    expect(client.entry({ function: 'pack.rate_of', args: [100] })).toEqual({ state: 'ready', answer: 99 })
    client.answerRecorded({ function: 'pack.rate_of', args: [100] }, 25)
    // Every change the client reports draws the scene again.
    show()
    await settle()
    show()
    show()
    await settle()
    expect([pending.length, aborted]).toEqual([1, 0])
    pending.shift()!(25)
    await settle()
    expect(client.entry({ function: 'pack.rate_of', args: [100] })).toEqual({ state: 'ready', answer: 25 })
  })
})
