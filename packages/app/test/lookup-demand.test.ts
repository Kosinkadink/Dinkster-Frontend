/**
 * What a finished run's automatic values do to the answers the editor keeps:
 * a call the run got another answer from is asked again, and nothing else is.
 */
import { describe, expect, it } from 'vitest'
import { createLookupClient } from '@dinkster/client'
import { EMPTY_CONNECTIVITY, asConnectionId, asPortId, compile, coreCommandRegistry, documentResolver, DocumentStore, elaborateInterface, elabInputsOf, loadDocument, parseDinksterSchema, type NodeSchema } from '@dinkster/core'
import { LookupDemand, lookupAnswersOf, recordRunAnswers } from '../src/lookup-demand.js'
import { buildParamRows } from '../src/app-view-rows.js'
import { boundarySample } from '../../core/test/fixtures/boundary-sample.js'

describe('recorded run answers', () => {
  it('keeps remote option answers and stored selections occurrence-local through boundary edits and failed refreshes', async () => {
    const { schema } = parseDinksterSchema('Picker', { body: [
      { kind: 'input', id: 'category', type: { kind: 'concrete', types: ['COMBO'] },
        pin: false, sent: false, widget: { type: 'COMBO', options: ['sd', 'sdxl', 'broken'] } },
      { kind: 'input', id: 'lora', type: { kind: 'concrete', types: ['COMBO'] },
        widget: { type: 'COMBO', options: { lookup: 'pack.loras', args: ['category'] } } },
    ] } as never)
    const resolve = (type: string) => type === 'Picker' ? { ...schema!, isOutputNode: true } : undefined
    const binding = (id: string, node: string, port: string) => ({
      kind: 'input', id, binds: { kind: 'port', node, port }, promoted: true,
    })
    for (const level of [0, 1, 2] as const) {
      const category = level === 1 ? 'kind' : 'category'
      const selection = level === 0 ? 'lora' : level === 1 ? 'pick' : 'list'
      const original = boundarySample(level)
      const doc = { ...original, graphs: {
        root: { ...original.graphs.root!, nodes: Object.fromEntries(['first', 'second'].map((id) => [id, {
          id, type: level === 0 ? 'Picker' : level === 1 ? '#detail' : '#portrait',
          values: { [category]: id === 'first' ? 'sd' : 'sdxl', [selection]: `kept-${id}` },
        }])) },
        ...(level > 0 ? { detail: { ...original.graphs.detail!, nodes: {
          sample: { id: 'sample', type: 'Picker', values: { category: 'sd' } },
        }, boundary: { body: [binding('kind', 'sample', 'category'), binding('pick', 'sample', 'lora')] } } } : {}),
        ...(level === 2 ? { portrait: { ...original.graphs.portrait!, nodes: {
          detail: { id: 'detail', type: '#detail', values: { kind: 'sdxl' } },
        }, boundary: { body: [binding('category', 'detail', 'kind'), binding('list', 'detail', 'pick')] } } } : {}),
      } } as unknown as typeof original
      const store = new DocumentStore(doc, coreCommandRegistry(), 200, undefined, () => ({
        kind: 'initial', schemaResolverFor: (current) => documentResolver(current, resolve),
      }))
      for (const nodeId of ['first', 'second']) expect(store.dispatch({ command: 'params.expose', params: {
        graphId: 'root', nodeId, inputId: selection,
      } }).ok).toBe(true)
      const baseline = store.doc
      const pending: { args: readonly string[]; answer: (status: number, body: unknown) => void; aborted: boolean }[] = []
      const client = createLookupClient({ baseUrl: '', fetchFn: (_url, init) => {
        const call = JSON.parse(String(init?.body)) as { nodeType: string; function: string; args: string[] }
        expect(call.nodeType).toBe('Picker')
        expect(call.function).toBe('pack.loras')
        return new Promise<Response>((resolve, reject) => {
          const request = { args: call.args, aborted: false, answer: (status: number, body: unknown) =>
            resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) }
          init?.signal?.addEventListener('abort', () => { request.aborted = true; reject(new DOMException('aborted', 'AbortError')) })
          pending.push(request)
        })
      } })
      const demand = new LookupDemand(client)
      const answers = lookupAnswersOf(client)
      const draw = () => {
        const derived = documentResolver(store.doc, resolve)
        demand.show(['first', 'second'].map((id) => {
          const node = store.doc.graphs.root!.nodes[id]!
          return { nodeType: node.type, node: id,
            items: elaborateInterface(derived(node.type)!, node, EMPTY_CONNECTIVITY, { lookupAnswers: answers }).items }
        }))
        return buildParamRows(store.doc, resolve, answers).map((row) => {
          if (row.kind !== 'live') throw new Error('remote option row is unavailable')
          expect(row.entry.graphId).toBe('root')
          expect(row.entry.inputId).toBe(selection)
          return { node: row.entry.nodeId, value: row.value, state: row.item.looked!.options!.state,
            options: row.spec!.options['options'] }
        })
      }
      const checkPrompt = (document = store.doc) => {
        const result = compile({ document, revision: store.revision, resolve,
          scope: { kind: 'full' }, connection: asConnectionId('lookup-ownership'), schemaHash: 'lookup-ownership', lookupAnswers: answers })
        expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
        if (!result.ok) throw new Error('remote option document did not compile')
        const suffix = level === 0 ? '' : level === 1 ? '.sample' : '.detail.sample'
        expect(result.artifact.prompt).toEqual({
          [`first${suffix}`]: { class_type: 'Picker', inputs: { lora: 'kept-first' }, outputIds: [] },
          [`second${suffix}`]: { class_type: 'Picker', inputs: { lora: 'kept-second' }, outputIds: [] },
        })
      }
      const settle = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve() }
      try {
        expect(draw().map((row) => [row.node, row.value, row.state])).toEqual([
          ['first', 'kept-first', 'loading'], ['second', 'kept-second', 'loading'],
        ])
        checkPrompt()
        await settle()
        expect(pending.map((request) => request.args[0]).sort()).toEqual(['sd', 'sdxl'])
        const oldFirst = pending.find((request) => request.args[0] === 'sd')!
        const sibling = pending.find((request) => request.args[0] === 'sdxl')!
        sibling.answer(200, { answer: ['sdxl-only'] })
        await settle()
        expect(draw()[1]).toEqual({ node: 'second', value: 'kept-second', state: 'ready', options: ['sdxl-only'] })
        expect(store.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'first', inputId: category, value: 'broken' } }).ok).toBe(true)
        draw()
        await settle()
        expect(oldFirst.aborted).toBe(true)
        const broken = pending.find((request) => request.args[0] === 'broken')!
        oldFirst.answer(200, { answer: ['late-old-sd'] })
        broken.answer(504, { error: 'lookup-timeout' })
        await settle()
        expect(draw()).toEqual([
          { node: 'first', value: 'kept-first', state: 'unavailable', options: undefined },
          { node: 'second', value: 'kept-second', state: 'ready', options: ['sdxl-only'] },
        ])
        checkPrompt()
        expect(store.undo()).toBe(true)
        expect(store.doc).toEqual(baseline)
        draw()
        await settle()
        const fresh = pending.filter((request) => request.args[0] === 'sd').at(-1)!
        expect(fresh).not.toBe(oldFirst)
        fresh.answer(200, { answer: ['sd-fresh'] })
        await settle()
        expect(draw()[0]).toEqual({ node: 'first', value: 'kept-first', state: 'ready', options: ['sd-fresh'] })
        demand.refresh('Picker', 'first', { lookup: 'pack.loras', args: ['sd'] })
        await settle()
        const refresh = pending.filter((request) => request.args[0] === 'sd').at(-1)!
        expect(refresh).not.toBe(fresh)
        refresh.answer(504, { error: 'lookup-timeout' })
        await settle()
        expect(draw()).toEqual([
          { node: 'first', value: 'kept-first', state: 'stale', options: ['sd-fresh'] },
          { node: 'second', value: 'kept-second', state: 'ready', options: ['sdxl-only'] },
        ])
        expect(store.doc).toEqual(baseline)
        expect(pending.filter((request) => request.args[0] === 'sdxl')).toHaveLength(1)
        checkPrompt()
        expect(store.redo()).toBe(true)
        const reopened = loadDocument(JSON.parse(JSON.stringify(store.doc))).document!
        expect(reopened).toEqual(store.doc)
        checkPrompt(reopened)
        expect(store.doc.graphs.detail).toEqual(doc.graphs.detail)
        expect(store.doc.graphs.portrait).toEqual(doc.graphs.portrait)
      } finally {
        demand.dispose()
        client.dispose()
      }
    }
  })

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

      const quietDoc = { ...doc, graphs: { ...doc.graphs,
        detail: { ...doc.graphs.detail!, boundary: { body: doc.graphs.detail!.boundary!.body.map((row) => row.kind === 'input' && row.id === 'strength' ? { ...row, id: 'amount' } : row) } },
        ...(doc.graphs.portrait === undefined ? {} : { portrait: { ...doc.graphs.portrait,
          boundary: { body: doc.graphs.portrait.boundary!.body.map((row) => row.kind === 'input' && row.id === 'strength' && row.binds.kind === 'port'
            ? { ...row, id: 'mix', binds: { ...row.binds, port: asPortId('amount') } } : row) },
        } }),
      } }
      for (const [formula, expected] of [
        ['"Ready" if True else fixed(seed, 1)', 'Ready'],
        ['"Wired" if linked(seed) else "Unwired"', 'Unwired'],
        ['fixed(seed, 1) if True else "Ready"', '0.7'],
      ]) {
        const quietSchema = { ...schema, body: schema.body.map((row) => {
          if (row.kind !== 'input' || row.id !== 'strength') return row
          const { automatic: _automatic, ...field } = row
          return { ...field, labelFormula: { formula: formula! } }
        }) }
        const asked: unknown[] = []
        const quietClient = createLookupClient({ baseUrl: '', fetchFn: async (_url, init) => {
          asked.push(JSON.parse(String(init?.body)))
          return new Response(JSON.stringify({ answer: 0.7 }), { status: 200, headers: { 'content-type': 'application/json' } })
        } })
        const quietDemand = new LookupDemand(quietClient)
        const quietDerived = documentResolver(quietDoc, (type) => type === schema.type ? quietSchema : undefined)(level === 1 ? '#detail' : '#portrait')!
        const quietDraw = () => {
          const elaborated = elaborateInterface(quietDerived, { values: {} }, EMPTY_CONNECTIVITY, { lookupAnswers: lookupAnswersOf(quietClient) })
          quietDemand.show([{ nodeType: quietDerived.type, node: 'quiet', items: elaborated.items,
            ...(elaborated.lookupDependencies === undefined ? {} : { lookupDependencies: elaborated.lookupDependencies }),
          }])
          return elabInputsOf(elaborated).find((item) => item.spec.id === (level === 1 ? 'amount' : 'mix'))!.spec.displayName
        }
        quietDraw()
        await settle()
        expect(quietDraw()).toBe(expected)
        expect(asked).toEqual(expected === '0.7' ? [{ nodeType: 'Boundary sample', function: 'pack.seed', args: [0.1] }] : [])
        quietDemand.dispose()
        quietClient.dispose()
      }
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
