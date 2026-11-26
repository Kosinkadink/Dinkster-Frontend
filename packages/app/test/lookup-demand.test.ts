/**
 * What a finished run's automatic values do to the answers the editor keeps:
 * a call the run got another answer from is asked again, and nothing else is.
 */
import { describe, expect, it } from 'vitest'
import { createLookupClient } from '@dinkster/client'
import { EMPTY_CONNECTIVITY, documentResolver, elaborateInterface, elabInputsOf, type NodeSchema } from '@dinkster/core'
import { LookupDemand, lookupAnswersOf, recordRunAnswers } from '../src/lookup-demand.js'
import { boundarySample } from '../../core/test/fixtures/boundary-sample.js'

describe('recorded run answers', () => {
  it('requests hidden lookup dependencies with native declarations and waits for their answers at both boundary depths', async () => {
    const field = (id: string, automatic?: { lookup: string; args: { formula: string }[] }): NodeSchema['body'][number] => ({
      kind: 'input', id, type: { kind: 'concrete', name: 'FLOAT' }, optional: false,
      widget: { widgetType: 'FLOAT', options: {}, default: 0.1 }, ...(automatic === undefined ? {} : { automatic }),
    })
    const schema: NodeSchema = {
      type: 'Boundary sample', displayName: 'Treatment', category: 'test', source: 'v3', isOutputNode: false,
      body: [field('radius'), field('seed', { lookup: 'pack.seed', args: [{ formula: 'radius' }] }),
        field('unrelated', { lookup: 'pack.unrelated', args: [{ formula: '999' }] }),
        field('strength', { lookup: 'pack.double', args: [{ formula: 'seed' }] })],
    }
    for (const level of [1, 2] as const) {
      const original = boundarySample(level)
      const detail = original.graphs.detail!
      const portrait = original.graphs.portrait
      const doc = { ...original, graphs: { ...original.graphs,
        detail: { ...detail, nodes: { sample: { ...detail.nodes.sample!, values: {}, dynamic: {} } }, boundary: { body: detail.boundary!.body.filter((row) => row.kind === 'input' && ['radius', 'strength'].includes(row.id)) } },
        ...(portrait === undefined ? {} : { portrait: { ...portrait,
          nodes: { detail: { ...portrait.nodes.detail!, values: {} } },
          boundary: { body: portrait.boundary!.body.filter((row) => row.kind === 'input' && ['radius', 'strength'].includes(row.id)) },
        } }),
      } }
      const calls: { nodeType: string; function: string; args: number[] }[] = []
      const pending: Array<() => void> = []
      const client = createLookupClient({ baseUrl: '', fetchFn: async (_url, init) => {
        const call = JSON.parse(String(init?.body)) as typeof calls[number]
        calls.push(call)
        return new Promise<Response>((resolve) => pending.push(() => resolve(new Response(JSON.stringify({ answer: call.function === 'pack.seed' ? call.args[0] : call.args[0]! * 2 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }))))
      } })
      const demand = new LookupDemand(client)
      const derived = documentResolver(doc, (type) => type === schema.type ? schema : undefined)(level === 1 ? '#detail' : '#portrait')!
      const draw = (radius: number, fixed = false, open = false) => {
        const elaborated = elaborateInterface(derived, { values: { radius, ...(fixed ? { strength: 0.9 } : {}) } }, EMPTY_CONNECTIVITY, { lookupAnswers: lookupAnswersOf(client) })
        demand.show([{ nodeType: derived.type, node: 'outer', items: elaborated.items,
          ...(elaborated.lookupDependencies === undefined ? {} : { lookupDependencies: elaborated.lookupDependencies }),
          ...(open ? { openField: 'strength' } : {}),
        }])
        const item = elabInputsOf(elaborated).find((item) => item.spec.id === 'strength')!
        return open ? item.automaticIfEmptied : item.automatic
      }
      const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve() }
      for (const radius of [0.8, 0.2]) {
        expect(draw(radius)).toMatchObject({ state: 'not-known', reason: 'argument-unknown' })
        await settle()
        expect(calls.at(-1)).toMatchObject({ nodeType: 'Boundary sample', function: 'pack.seed', args: [radius] })
        expect(pending).toHaveLength(1)
        pending.shift()!()
        await settle()
        expect(draw(radius)).toMatchObject({ state: 'loading' })
        await settle()
        expect(calls.at(-1)).toMatchObject({ nodeType: 'Boundary sample', function: 'pack.double', args: [radius] })
        expect(pending).toHaveLength(1)
        pending.shift()!()
        await settle()
        expect(draw(radius)).toMatchObject({ state: 'worked-out', value: radius * 2 })
      }
      expect(calls.map((call) => call.function)).toEqual(['pack.seed', 'pack.double', 'pack.seed', 'pack.double'])
      expect(draw(0.6, true)).toBeUndefined()
      await settle()
      expect(calls).toHaveLength(4)
      expect(draw(0.6, true, true)).toMatchObject({ state: 'not-known' })
      await settle()
      expect(calls.at(-1)).toMatchObject({ nodeType: 'Boundary sample', function: 'pack.seed', args: [0.6] })
      demand.dispose()
      client.dispose()
    }
  })

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
