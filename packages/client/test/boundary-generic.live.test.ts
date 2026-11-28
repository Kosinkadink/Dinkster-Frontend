import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  asConnectionId, asNodeId, compile, coreCommandRegistry, DocumentStore, documentResolver,
  lifecycleCanonicalHash, lifecycleFlattenFingerprint, loadDocument, parseDinksterNodes,
  planFlattenBoundaryRoutes, planFlattenOccurrenceTopology,
  type GraphDef, type Json, type WorkflowDocument,
} from '@dinkster/core'
import { DinksterConnection } from '../src/index.js'

const LIVE_URL = process.env['DINKSTER_BOUNDARY_LIVE_URL']
const PREPARE = process.env['DINKSTER_GENERIC_PREPARE']

describe.skipIf(!LIVE_URL && !PREPARE)('native generic boundary delivery', () => {
  for (const depth of [1, 2]) it(`independent types through ${depth} renamed boundaries`, async () => {
    const connection = new DinksterConnection({ id: asConnectionId('generic-boundary'),
      baseUrl: LIVE_URL ?? 'http://127.0.0.1:5793', clientId: `generic-${process.pid}` })
    const registry = PREPARE
      ? parseDinksterNodes(JSON.parse(readFileSync(PREPARE, 'utf8')))
      : await connection.fetchSchemas()
    const resolve = 'resolve' in registry ? registry.resolve : (type: string) => registry.schemas.get(type)
    const schemaHash = 'hash' in registry ? registry.hash : 'generic-boundary'
    const graphFeatures = 'graphFeatures' in registry ? registry.graphFeatures ?? [] : []
    const node = (id: string, type: string, extra = {}) => ({ id: asNodeId(id), type, values: {}, ...extra }) as GraphDef['nodes'][string]
    const graph = (id: string, nodes: GraphDef['nodes']): GraphDef => ({
      id, name: id, nodes, links: {}, nets: {}, reroutes: {}, nextOrdinal: 100,
    } as GraphDef)
    const port = depth === 1 ? 'rows' : 'payload'
    const detail = graph('detail', {
      inner: node('inner', 'boundary-sample.generic-members', { values: { 'items.item0.value': 0.17, 'items.item1.value': 0.63 }, dynamic: { items: { members: ['item1', 'item0'] } } }),
      alpha: node('alpha', 'boundary-sample.generic'), beta: node('beta', 'boundary-sample.generic'),
    })
    Object.assign(detail, { boundary: { body: [
      { kind: 'input', id: 'rows', binds: { kind: 'construct', node: 'inner', port: 'items' } },
      ...['alpha', 'beta'].flatMap(id => [
        { kind: 'input', id, binds: { kind: 'port', node: id, port: 'value' } },
        { kind: 'output', id: `${id}Result`, binds: { kind: 'port', node: id, port: 'result' } },
      ]),
    ] } })
    const portrait = graph('portrait', { detail: node('detail', '#detail') })
    Object.assign(portrait, { boundary: { body: [
      { kind: 'input', id: 'payload', binds: { kind: 'construct', node: 'detail', port: 'rows' } },
      ...['alpha', 'beta'].flatMap(id => [
        { kind: 'input', id: `renamed${id}`, binds: { kind: 'port', node: 'detail', port: id } },
        { kind: 'output', id: `renamed${id}Result`, binds: { kind: 'port', node: 'detail', port: `${id}Result` } },
      ]),
    ] } })
    const root = graph('root', {
      first: node('first', depth === 1 ? '#detail' : '#portrait', { dynamic: { [port]: { members: ['item2', 'item3'] } } }),
      second: node('second', depth === 1 ? '#detail' : '#portrait', { dynamic: { [port]: { members: ['item2', 'item3'] } } }),
      image: node('image', 'boundary-sample.image'), mask: node('mask', 'boundary-sample.mask'),
      number: node('number', 'boundary-sample.float'),
      ...Object.fromEntries(['first0', 'first1', 'second0', 'second1'].map(id => [id, node(id, 'boundary-sample.generic')])),
    })
    const document: WorkflowDocument = { format: 'dinkster-workflow', formatVersion: 1, lineage: 'generic-native',
      root: 'root', view: { graphs: {} }, graphs: { root, detail, ...(depth === 2 ? { portrait } : {}) } } as unknown as WorkflowDocument
    const storeFor = (doc: WorkflowDocument) => new DocumentStore(doc, coreCommandRegistry(), 200, undefined,
      () => ({ kind: 'initial', schemaResolverFor: current => documentResolver(current, resolve) }))
    const edit = (store: DocumentStore, command: string, params: Record<string, Json>) => {
      const before = store.doc, result = store.dispatch({ command, params })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      const after = store.doc
      expect(store.undo()).toBe(true)
      const undone = structuredClone(store.doc)
      for (const [id, graph] of Object.entries(before.graphs)) Object.assign(undone.graphs[id]!, { nextOrdinal: graph.nextOrdinal })
      expect(undone).toEqual(before); expect(store.redo()).toBe(true); expect(store.doc).toEqual(after)
    }
    const store = storeFor(document)
    const wire = (source: string, output: string, owner: string, input: string) => edit(store, 'link.connect', {
      graphId: 'root', from: { node: source, port: output }, to: { node: owner, port: input },
    })
    for (const [owner, member, source] of [['first', 'item2', 'image'], ['first', 'item3', 'mask'],
      ['second', 'item2', 'mask'], ['second', 'item3', 'image']] as const) {
      wire(source, source === 'image' ? 'image' : 'mask', owner, `${port}.${member}.value`)
      wire(owner, `${port}.${member}.result`, `${owner}${member === 'item2' ? '0' : '1'}`, 'value')
    }
    for (const [owner, input, source, output] of [['first', 'alpha', 'number', 'number'], ['first', 'beta', 'image', 'image'],
      ['second', 'alpha', 'mask', 'mask'], ['second', 'beta', 'number', 'number']] as const) {
      wire(source, output, owner, depth === 1 ? input : `renamed${input}`)
    }
    const baseline = store.doc, prefix = depth === 1 ? '' : 'detail.'
    const image = { shape: [1, 1, 1, 3], dtype: 'float32', values: [[[[0.125, 0.25, 0.5]]]] }
    const mask = { shape: [1, 1, 1], dtype: 'float32', values: [[[0.75]]] }
    const memberReceipt = (first: unknown, second: unknown) => ({ items: [
      { key: 'item1', value: 0.63 }, { key: 'item0', value: 0.17 },
      { key: 'item4', value: first }, { key: 'item5', value: second },
    ] })
    const cases: { phase: string; doc: WorkflowDocument; first: string; extra: boolean; missing: boolean; rewired: boolean }[] = []
    const add = (phase: string, target: DocumentStore, first = `first.${prefix}`, extra = false, missing = false, rewired = false) =>
      cases.push({ phase, doc: target.doc, first, extra, missing, rewired })
    add('baseline', store)
    const disconnected = storeFor(baseline)
    const sourceLink = Object.values(baseline.graphs.root!.links).find(link => 'port' in link.to && link.to.node === 'first' && link.to.port === `${port}.item2.value`)!
    edit(disconnected, 'link.disconnect', { graphId: 'root', linkId: sourceLink.id }); add('disconnected', disconnected, undefined, false, true)
    const privateStore = storeFor(baseline)
    edit(privateStore, 'occurrence.localize', { graphId: 'root', nodeId: 'first' })
    const detached = privateStore.doc
    edit(privateStore, 'link.connect', { graphId: 'root', from: { node: 'mask', port: 'mask' }, to: { node: 'first', port: `${port}.item2.value` } })
    add('private-rewired', privateStore, undefined, false, false, true)
    for (const mode of ['active', 'muted'] as const) {
      const source = structuredClone(baseline)
      if (mode === 'muted') Object.assign(source.graphs.root!.nodes.first!, { mode })
      const target = storeFor(source), occurrence = source.graphs.root!.nodes.first!, body = source.graphs[occurrence.type.slice(1)]!
      const resolver = documentResolver(source, resolve), plan = planFlattenBoundaryRoutes(body, resolver, occurrence, source.graphs.root!)
      const topology = planFlattenOccurrenceTopology(source, resolver, { instancePath: [], node: asNodeId('first') })
      const topologyParams = topology.plan === undefined ? {} : { occurrenceTopologyPlan: topology.plan, occurrenceTopologyPlanDigest: lifecycleCanonicalHash(topology.plan) }
      const params = { graphId: 'root', nodeId: 'first', instancePath: [], placementCenter: { x: 100, y: 100 },
        resolvedGeometry: { occurrence: { id: 'first', kind: 'node', x: 0, y: 0, width: 200, height: 200 },
          body: Object.keys(body.nodes).map(id => ({ id, kind: 'node', x: 0, y: 0, width: 200, height: 200 })) },
        boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaSnapshot: plan.schemaSnapshot, schemaPlanDigest: plan.schemaPlanDigest, ...topologyParams }
      Object.assign(params, { selectionFingerprint: lifecycleFlattenFingerprint(source, 'root', 'first', {
        boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaPlanDigest: plan.schemaPlanDigest, ...topologyParams,
      }) })
      edit(target, 'subgraph.flatten', params as unknown as Record<string, Json>)
      const inner = Object.values(target.doc.graphs.root!.nodes).find(node => source.graphs.root!.nodes[node.id] === undefined && (depth === 2 || node.type === 'boundary-sample.generic-members'))!
      add(`flatten-${mode}`, target, depth === 1 ? '' : `${inner.id}.`)
    }
    const fanout = storeFor(baseline), graphCopy = structuredClone(fanout.doc)
    Object.assign(graphCopy.graphs.detail!.nodes, { extra: { ...structuredClone(graphCopy.graphs.detail!.nodes.inner!), id: 'extra' } })
    const extraStore = storeFor(graphCopy)
    edit(extraStore, 'boundary.addBinding', { graphId: 'detail', itemId: 'rows', node: 'extra', port: 'items' })
    add('fanout', extraStore, undefined, true)
    const prompts: unknown[] = []
    for (const entry of cases) {
      expect(loadDocument(JSON.parse(JSON.stringify(entry.doc))).document).toEqual(entry.doc)
      expect(entry.doc.graphs.root!.nodes.second).toEqual(baseline.graphs.root!.nodes.second)
      if (!entry.extra) expect(entry.doc.graphs.detail).toEqual(baseline.graphs.detail)
      const compiled = compile({ document: entry.doc, revision: 1, resolve, scope: { kind: 'full' },
        connection: asConnectionId('generic-boundary'), schemaHash, graphFeatures })
      expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
      if (!compiled.ok) throw Error('Generic packet did not compile')
      const prompt = compiled.artifact.prompt, muted = entry.phase === 'flatten-muted'
      expect(prompts).not.toContainEqual(prompt); prompts.push(prompt)
      const first = Object.keys(prompt).find(id => prompt[id]!.class_type === 'boundary-sample.generic-members' && !id.startsWith('second.'))
      const second = `second.${prefix}inner`
      const expected: Record<string, unknown> = {
        [second]: memberReceipt(mask, image), second0: { value: mask }, second1: { value: image },
        first0: { value: muted || entry.missing ? null : entry.rewired ? mask : image }, first1: { value: muted ? null : mask },
        [`second.${prefix}alpha`]: { value: mask }, [`second.${prefix}beta`]: { value: 0.9 },
      }
      if (!muted) {
        expect(first).toBeDefined()
        expected[first!] = memberReceipt(entry.missing ? null : entry.rewired ? mask : image, mask)
        const scalarNodes = entry.phase === 'flatten-active' && depth === 1
          ? Object.values(entry.doc.graphs.root!.nodes).filter(node => baseline.graphs.root!.nodes[node.id] === undefined && node.type === 'boundary-sample.generic').map(node => node.id)
          : [`${entry.first}alpha`, `${entry.first}beta`]
        expect(scalarNodes).toHaveLength(2)
        expect(prompt[scalarNodes[0]!]!.inputs).toEqual({ value: ['number', 0] })
        expect(prompt[scalarNodes[1]!]!.inputs).toEqual({ value: ['image', 0] })
        expected[scalarNodes[0]!] = { value: 0.9 }
        expected[scalarNodes[1]!] = { value: image }
      }
      if (entry.extra) {
        expected[`first.${prefix}extra`] = memberReceipt(image, mask)
        expected[`second.${prefix}extra`] = memberReceipt(mask, image)
      }
      expect(Object.keys(expected).sort()).toEqual(Object.keys(prompt).filter(id => ['boundary-sample.generic', 'boundary-sample.generic-members'].includes(prompt[id]!.class_type)).sort())
      console.info('Boundary generic prepared', JSON.stringify({ depth, phase: entry.phase, document: entry.doc, prompt, expected }))
      if (PREPARE) continue
      const submitted = await connection.submit(compiled.artifact)
      expect(submitted.ok, JSON.stringify(!submitted.ok && submitted.diagnostics)).toBe(true)
      if (!submitted.ok) throw Error('Generic packet submission refused')
      console.info('Boundary generic submission', JSON.stringify({ depth, phase: entry.phase, jobId: submitted.execution.prompt }))
      const deadline = Date.now() + 30_000
      let completed = false
      while (Date.now() < deadline) {
        const job = await connection.fetchJob(submitted.execution.prompt)
        if (job?.state === 'failed' || job?.state === 'cancelled') throw Error(JSON.stringify(job))
        if (job?.state === 'completed') {
          const outputs = job.outputs as unknown as Record<string, Record<string, { value: unknown }>>
          for (const id of Object.keys(expected).filter(id => prompt[id]!.class_type === 'boundary-sample.generic-members')) {
            expect(outputs[id]?.['items.item0.result']?.value).toBe(0.17)
            expect(outputs[id]?.['items.item1.result']?.value).toBe(0.63)
          }
          console.info('Boundary generic outputs', JSON.stringify({ depth, phase: entry.phase, jobId: submitted.execution.prompt, outputs }))
          for (const [nodeId, wanted] of Object.entries(expected)) {
            const query = { jobId: submitted.execution.prompt, nodeId, outputId: 'receipt' }
            const peek = await connection.values().peek(query)
            expect(peek.available).toBe(true)
            if (!peek.available) throw Error('Generic receipt unavailable')
            const rendition = await connection.values().rendition(query, 'text', { descriptor: peek.descriptor })
            expect(rendition.available).toBe(true)
            if (!rendition.available) throw Error('Generic receipt bytes unavailable')
            const actual = JSON.parse(new TextDecoder().decode(rendition.bytes))
            expect(actual).toEqual(wanted)
            console.info('Boundary generic receipt', JSON.stringify({ depth, phase: entry.phase, jobId: submitted.execution.prompt, nodeId, actual }))
          }
          completed = true; break
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(completed).toBe(true)
    }
    const original = compile({ document: baseline, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('generic-boundary'), schemaHash, graphFeatures })
    const localized = compile({ document: detached, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('generic-boundary'), schemaHash, graphFeatures })
    expect(localized.ok && localized.artifact.prompt).toEqual(original.ok && original.artifact.prompt)
  })
})
