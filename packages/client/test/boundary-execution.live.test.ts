import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  asConnectionId,
  compile,
  createLocalSession,
  coreCommandRegistry,
  buttonAvailability,
  documentNodeResolver,
  DocumentStore,
  documentResolver,
  lifecycleCanonicalHash,
  lifecycleFlattenFingerprint,
  loadDocument,
  planFlattenBoundaryRoutes,
  planFlattenOccurrenceTopology,
  runPress,
  type ActionHost,
  type CommandInvocation,
  type Json,
  type NodeSchema,
  type WorkflowDocument,
} from '@dinkster/core'
import { DinksterConnection } from '../src/index.js'

const LIVE_URL = process.env['DINKSTER_BOUNDARY_LIVE_URL']
const types: Record<string, string> = {
  'Boundary sample': 'boundary-sample.sample',
  ImageSource: 'boundary-sample.image',
  MaskSource: 'boundary-sample.mask',
  FloatSource: 'boundary-sample.float',
  IntSource: 'boundary-sample.int',
  NumberSink: 'boundary-sample.sink',
}

describe.skipIf(!LIVE_URL)('live Boundary sample execution', () => {
  for (const calculation of ['formula', 'lookup'] as const) for (const depth of [0, 1, 2]) {
    it(`boundary/${calculation}/native-depth-${depth}`, async () => {
      const connection = new DinksterConnection({ id: asConnectionId('automatic-live'), baseUrl: LIVE_URL!, clientId: `automatic-${process.pid}` })
      const registry = await connection.fetchSchemas()
      const type = `boundary-sample.${calculation}`
      const primitive: NodeSchema = {
        type: 'dinkster.utilities.primitive_int', displayName: 'Int', category: 'utilities', source: 'v3', isOutputNode: false,
        body: [
          { kind: 'input', id: 'value', type: { kind: 'concrete', name: 'INT' }, optional: false,
            widget: { widgetType: 'INT', options: {}, default: 0 } },
          { kind: 'output', id: 'value', type: { kind: 'concrete', name: 'INT' }, knownValue: { input: 'value' } },
        ],
      }
      const resolve = (id: string) => id === primitive.type ? primitive : registry.resolve(id)
      const graph = (id: string, nodes: unknown, body?: unknown) => ({ id, name: id, nodes, links: {}, nets: {}, reroutes: {}, nextOrdinal: 100,
        ...(body === undefined ? {} : { boundary: { body } }) })
      const bind = (id: string, node: string, port: string) => ({ kind: 'input', id, promoted: true, binds: { kind: 'port', node, port } })
      const seed = depth === 0 ? 'seed' : depth === 1 ? 'start' : 'control'
      const total = depth === 0 ? 'total' : depth === 1 ? 'sum' : 'result'
      const document = { format: 'dinkster-workflow', formatVersion: 1, lineage: `native-${calculation}-${depth}`, root: 'root', view: { graphs: {} }, graphs: {
        root: graph('root', {
          first: { id: 'first', type: depth === 0 ? type : depth === 1 ? '#detail' : '#portrait', values: { [seed]: 21 } },
          second: { id: 'second', type: depth === 0 ? type : depth === 1 ? '#detail' : '#portrait', values: { [seed]: 13 } },
          literal: { id: 'literal', type: primitive.type, values: { value: 47 } },
          runtime: { id: 'runtime', type: 'boundary-sample.int', values: {} },
        }),
        ...(depth > 0 ? { detail: graph('detail', { sample: { id: 'sample', type, values: { seed: 3 } },
          other: { id: 'other', type, values: { seed: 17, bias: 13 } } },
        [bind('start', 'sample', 'seed'), bind('sum', 'sample', 'total'), bind('offset', 'sample', 'bias')]) } : {}),
        ...(depth === 2 ? { portrait: graph('portrait', { detail: { id: 'detail', type: '#detail', values: { start: 7 } } },
          [bind('control', 'detail', 'start'), bind('result', 'detail', 'sum'), bind('weight', 'detail', 'offset')]) } : {}),
      } } as unknown as WorkflowDocument
      const storeFor = (doc: WorkflowDocument) => new DocumentStore(doc, coreCommandRegistry(), 200, undefined,
        () => ({ kind: 'initial', schemaResolverFor: (current) => documentResolver(current, resolve) }))
      const store = storeFor(document)
      const edit = (target: DocumentStore, command: string, params: Record<string, Json>) => {
        const result = target.dispatch({ command, params })
        expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      }
      const suffix = depth === 0 ? '' : depth === 1 ? '.sample' : '.detail.sample'
      const first = `first${suffix}`, second = `second${suffix}`
      type Receipt = { seed: number; bias: number; total: number }
      const run = async (doc: WorkflowDocument, expected: Record<string, Receipt>, absent: readonly string[] = []) => {
        const compiled = compile({ document: doc, revision: 1, resolve, scope: { kind: 'full' },
          connection: registry.connection, schemaHash: registry.hash, graphFeatures: registry.graphFeatures ?? [] })
        expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
        if (!compiled.ok) throw new Error('Automatic workflow did not compile')
        const submitted = await connection.submit(compiled.artifact)
        expect(submitted.ok, JSON.stringify(!submitted.ok && submitted.diagnostics)).toBe(true)
        if (!submitted.ok) throw new Error('Automatic workflow was refused')
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
          const job = await connection.fetchJob(submitted.execution.prompt)
          if (job?.state === 'failed' || job?.state === 'cancelled') throw new Error(JSON.stringify(job))
          if (job?.state === 'completed') {
            const outputs = job.outputs as unknown as Record<string, Record<string, { value: unknown }>>
            const actual: Record<string, Receipt> = {}
            for (const [nodeId, receipt] of Object.entries(expected)) {
              expect(outputs[nodeId]?.result?.value, nodeId).toBe(receipt.total)
              const query = { jobId: submitted.execution.prompt, nodeId, outputId: 'receipt' }
              const peek = await connection.values().peek(query)
              expect(peek.available, JSON.stringify(peek)).toBe(true)
              if (!peek.available) throw new Error('Automatic receipt unavailable')
              const text = await connection.values().rendition(query, 'text', { descriptor: peek.descriptor })
              expect(text.available, JSON.stringify(text)).toBe(true)
              if (!text.available) throw new Error('Automatic receipt text unavailable')
              actual[nodeId] = JSON.parse(new TextDecoder().decode(text.bytes)) as Receipt
              expect(actual[nodeId], nodeId).toEqual(receipt)
            }
            for (const nodeId of absent) expect(outputs[nodeId]).toBeUndefined()
            console.info('Boundary calculation receipt', JSON.stringify({ calculation, depth, jobId: submitted.execution.prompt, expected, actual, absent }))
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error('Automatic workflow did not complete')
      }
      const sibling = { seed: 13, bias: 7, total: 33 }
      await run(store.doc, { [first]: { seed: 21, bias: 7, total: 49 }, [second]: sibling })
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: seed, value: 31 })
      const edited = store.doc
      expect(store.doc.graphs.detail).toEqual(document.graphs.detail)
      expect(store.doc.graphs.portrait).toEqual(document.graphs.portrait)
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(document)
      expect(store.redo()).toBe(true)
      expect(store.doc).toEqual(edited)
      await run(loadDocument(JSON.parse(JSON.stringify(edited))).document!, { [first]: { seed: 31, bias: 7, total: 69 }, [second]: sibling })
      edit(store, 'node.setValues', { graphId: 'root', nodeId: 'first', values: {}, unset: [seed] })
      await run(store.doc, { [first]: { seed: depth === 2 ? 7 : 3, bias: 7, total: depth === 2 ? 21 : 13 }, [second]: sibling })
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(edited)
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: total, value: 19 })
      await run(store.doc, { [first]: { seed: 31, bias: 7, total: 19 }, [second]: sibling })
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(edited)
      for (const source of ['literal', 'runtime']) for (const target of [seed, total]) {
        const wired = storeFor(edited)
        edit(wired, 'link.connect', { graphId: 'root', from: { node: source, port: source === 'literal' ? 'value' : 'number' }, to: { node: 'first', port: target } })
        const connected = wired.doc
        const value = source === 'literal' ? 47 : 2
        const expected = target === seed
          ? { seed: value, bias: 7, total: source === 'literal' ? 101 : 5 }
          : { seed: 31, bias: 7, total: value }
        await run(loadDocument(JSON.parse(JSON.stringify(connected))).document!, { [first]: expected, [second]: sibling })
        edit(wired, 'link.disconnect', { graphId: 'root', linkId: Object.keys(connected.graphs.root!.links)[0]! })
        expect(wired.doc.graphs.root!.nodes.first!.values).toEqual({ [seed]: 31 })
        const disconnected = wired.doc
        expect(wired.undo()).toBe(true)
        expect(wired.doc).toEqual(connected)
        expect(wired.redo()).toBe(true)
        expect(wired.doc).toEqual(disconnected)
        await run(loadDocument(JSON.parse(JSON.stringify(disconnected))).document!, { [first]: { seed: 31, bias: 7, total: 69 }, [second]: sibling })
      }
      if (depth === 0) return
      const fanout = storeFor(edited)
      edit(fanout, 'boundary.addBinding', { graphId: 'detail', itemId: 'start', node: 'other', port: 'seed' })
      const withFanout = fanout.doc
      const extraSuffix = depth === 1 ? '.other' : '.detail.other'
      await run(withFanout, { [first]: { seed: 31, bias: 7, total: 69 }, [second]: sibling,
        [`first${extraSuffix}`]: { seed: 31, bias: 13, total: 75 }, [`second${extraSuffix}`]: { seed: 13, bias: 13, total: 39 } })
      const incompatible = fanout.dispatch({ command: 'boundary.addBinding', params: {
        graphId: 'detail', itemId: 'start', node: 'other', port: 'text',
      } })
      expect(incompatible.ok).toBe(false)
      expect(incompatible.diagnostics.map((item) => item.code)).toContain('boundary.fanoutTypeMismatch')
      expect(fanout.doc).toBe(withFanout)
      const detached = storeFor(edited)
      edit(detached, 'occurrence.localize', { graphId: 'root', nodeId: 'first' })
      const privateGraph = detached.doc.graphs.root!.nodes.first!.type.slice(1)
      edit(detached, 'node.setValue', { graphId: privateGraph, nodeId: depth === 1 ? 'sample' : 'detail', inputId: depth === 1 ? 'bias' : 'offset', value: 19 })
      expect(detached.doc.graphs.detail).toEqual(edited.graphs.detail)
      expect(detached.doc.graphs.portrait).toEqual(edited.graphs.portrait)
      await run(loadDocument(JSON.parse(JSON.stringify(detached.doc))).document!, { [first]: { seed: 31, bias: 19, total: 81 }, [second]: sibling })
      for (const mode of ['active', 'muted', 'bypassed'] as const) {
        const doc: WorkflowDocument = { ...edited, graphs: { ...edited.graphs, root: { ...edited.graphs.root!, nodes: {
          ...edited.graphs.root!.nodes, first: { ...edited.graphs.root!.nodes.first!, ...(mode === 'active' ? {} : { mode }) },
        } } } }
        const flattened = storeFor(doc)
        const beforeFlatten = flattened.doc
        const root = doc.graphs.root!, node = root.nodes.first!, body = doc.graphs[node.type.slice(1)]!
        const resolver = documentResolver(doc, resolve)
        const plan = planFlattenBoundaryRoutes(body, resolver, node, root)
        const topology = planFlattenOccurrenceTopology(doc, resolver, { instancePath: [], node: node.id })
        const topologyParams = topology.plan === undefined ? {} : { occurrenceTopologyPlan: topology.plan,
          occurrenceTopologyPlanDigest: lifecycleCanonicalHash(topology.plan) }
        const selectionFingerprint = lifecycleFlattenFingerprint(doc, 'root', 'first', {
          boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaPlanDigest: plan.schemaPlanDigest, ...topologyParams,
        })
        const outcome = flattened.dispatch({ command: 'subgraph.flatten', params: {
          graphId: 'root', instancePath: [], nodeId: 'first', placementCenter: { x: 100, y: 100 },
          resolvedGeometry: { occurrence: { id: 'first', kind: 'node', x: 0, y: 0, width: 200, height: 200 },
            body: Object.keys(body.nodes).map((id) => ({ id, kind: 'node', x: 0, y: 0, width: 200, height: 200 })) },
          boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaSnapshot: plan.schemaSnapshot,
          schemaPlanDigest: plan.schemaPlanDigest, selectionFingerprint, ...topologyParams,
        } } as unknown as CommandInvocation)
        if (mode === 'bypassed') {
          expect(outcome.ok).toBe(false)
          expect(outcome.diagnostics.map((item) => item.code)).toContain('subgraph.flatten.modeUnsupported')
          expect(flattened.doc).toBe(beforeFlatten)
          continue
        }
        expect(outcome.ok, JSON.stringify(outcome.diagnostics)).toBe(true)
        const replacements = Object.values(flattened.doc.graphs.root!.nodes).filter((candidate) =>
          root.nodes[candidate.id] === undefined && candidate.type === (depth === 1 ? type : '#detail'))
        const replacement = replacements.find((candidate) => depth === 2 || candidate.values['seed'] === 31)!
        expect(replacement).toBeDefined()
        const path = depth === 1 ? replacement.id : `${replacement.id}.sample`
        const other = depth === 1 ? replacements.find((candidate) => candidate.id !== replacement.id)!.id : `${replacement.id}.other`
        const result = flattened.doc
        expect(flattened.undo()).toBe(true)
        expect(flattened.doc.graphs).toEqual({ ...doc.graphs, root: { ...root, nextOrdinal: result.graphs.root!.nextOrdinal } })
        expect(flattened.redo()).toBe(true)
        expect(flattened.doc).toEqual(result)
        await run(loadDocument(JSON.parse(JSON.stringify(result))).document!, mode === 'muted'
          ? { [second]: sibling, [`second${extraSuffix}`]: { seed: 17, bias: 13, total: 47 } }
          : { [path]: { seed: 31, bias: 7, total: 69 }, [other]: { seed: 17, bias: 13, total: 47 },
            [second]: sibling, [`second${extraSuffix}`]: { seed: 17, bias: 13, total: 47 } }, mode === 'muted' ? [path, other] : [])
      }
    }, 120_000)
  }

  for (const depth of [1, 2] as const) {
    it(`boundary/plain-pin/native-depth-${depth}`, async () => {
      const connection = new DinksterConnection({ id: asConnectionId('pin-live'), baseUrl: LIVE_URL!, clientId: `pins-${process.pid}` })
      const registry = await connection.fetchSchemas()
      const primitive: NodeSchema = {
        type: 'dinkster.utilities.primitive_float', displayName: 'Float', category: 'utilities', source: 'v3', isOutputNode: false,
        body: [
          { kind: 'input', id: 'value', type: { kind: 'concrete', name: 'FLOAT' }, optional: false,
            widget: { widgetType: 'FLOAT', options: {}, default: 0 } },
          { kind: 'output', id: 'value', type: { kind: 'concrete', name: 'FLOAT' }, knownValue: { input: 'value' } },
        ],
      }
      const resolve = (type: string) => type === primitive.type ? primitive : registry.resolve(type)
      const document = JSON.parse(readFileSync(new URL('./fixtures/boundary-sample.json', import.meta.url), 'utf8')) as WorkflowDocument
      if (depth === 1) {
        delete (document.graphs as Record<string, unknown>).portrait
        for (const id of ['first', 'second']) Object.assign(document.graphs.root!.nodes[id]!, { type: '#detail' })
      }
      for (const graph of Object.values(document.graphs)) for (const node of Object.values(graph.nodes)) {
        if (types[node.type]) Object.assign(node, { type: types[node.type] })
      }
      Object.assign(document.graphs.detail!.nodes, {
        other: { ...structuredClone(document.graphs.detail!.nodes.sample), id: 'other' },
        receiver: { id: 'receiver', type: 'boundary-sample.sink', values: {} },
        otherReceiver: { id: 'otherReceiver', type: 'boundary-sample.sink', values: {} },
      })
      Object.assign(document.graphs.root!.nodes, {
        literal: { id: 'literal', type: primitive.type, values: { value: 0.65 } },
        runtime: { id: 'runtime', type: 'boundary-sample.float', values: {} },
      })
      const store = new DocumentStore(document, coreCommandRegistry(), 200, undefined,
        () => ({ kind: 'initial', schemaResolverFor: (doc) => documentResolver(doc, resolve) }))
      const edit = (command: string, params: Record<string, Json>) => {
        const outcome = store.dispatch({ command, params })
        expect(outcome.ok, JSON.stringify(outcome.diagnostics)).toBe(true)
      }
      const prefix = depth === 1 ? '' : 'detail.'
      const imageNodes = [`first.${prefix}sample`, `first.${prefix}other`]
      const run = async (doc: WorkflowDocument, numbers: readonly (number | null)[], images: readonly string[]) => {
        const compiled = compile({ document: doc, revision: 1, resolve, scope: { kind: 'full' },
          connection: registry.connection, schemaHash: registry.hash, graphFeatures: registry.graphFeatures ?? [] })
        expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
        if (!compiled.ok) throw new Error('Pin workflow did not compile')
        const submitted = await connection.submit(compiled.artifact)
        expect(submitted.ok, JSON.stringify(!submitted.ok && submitted.diagnostics)).toBe(true)
        if (!submitted.ok) throw new Error('Pin workflow was refused')
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
          const job = await connection.fetchJob(submitted.execution.prompt)
          if (job?.state === 'failed' || job?.state === 'cancelled') throw new Error(JSON.stringify(job))
          if (job?.state === 'completed') {
            const outputs = job.outputs as unknown as Record<string, Record<string, { value: string }>>
            expect(['first', 'second'].flatMap((instance) => ['receiver', 'otherReceiver'].map((node) =>
              JSON.parse(outputs[`${instance}.${prefix}${node}`]!.received!.value)))).toEqual(numbers)
            for (const instance of ['first', 'second']) for (const node of ['sample', 'other']) {
              const nodeId = `${instance}.${prefix}${node}`
              const query = { jobId: submitted.execution.prompt, nodeId, outputId: 'receipt' }
              const peek = await connection.values().peek(query)
              expect(peek.available, JSON.stringify(peek)).toBe(true)
              if (!peek.available) throw new Error('Pin receipt is unavailable')
              const rendition = await connection.values().rendition(query, 'text', { descriptor: peek.descriptor })
              expect(rendition.available, JSON.stringify(rendition)).toBe(true)
              if (!rendition.available) throw new Error('Pin receipt is unavailable')
              const receipt = JSON.parse(new TextDecoder().decode(rendition.bytes)) as { image: number[] | null }
              expect(receipt.image, nodeId).toEqual(images.includes(nodeId) ? [0.125, 0.25, 0.5] : null)
            }
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error('Pin workflow did not complete')
      }
      edit('boundary.addItem', { graphId: 'detail', side: 'inputs', itemId: 'number', node: 'receiver', port: 'number' })
      edit('boundary.addBinding', { graphId: 'detail', itemId: 'number', node: 'otherReceiver', port: 'number' })
      edit('boundary.addBinding', { graphId: 'detail', itemId: 'image', node: 'other', port: 'image' })
      if (depth === 2) edit('boundary.addItem', { graphId: 'portrait', side: 'inputs', itemId: 'amount', node: 'detail', port: 'number' })
      const field = depth === 1 ? 'number' : 'amount'
      edit('link.connect', { graphId: 'root', from: { node: 'imageA', port: 'image' }, to: { node: 'first', port: 'image' } })
      edit('link.connect', { graphId: 'root', from: { node: 'literal', port: 'value' }, to: { node: 'first', port: field } })
      await run(store.doc, [0.65, 0.65, null, null], imageNodes)
      const disconnect = (port: string) => {
        const link = Object.values(store.doc.graphs.root!.links).find((item) => 'port' in item.to && item.to.node === 'first' && item.to.port === port)!
        edit('link.disconnect', { graphId: 'root', linkId: link.id })
      }
      disconnect(field)
      edit('link.connect', { graphId: 'root', from: { node: 'runtime', port: 'number' }, to: { node: 'first', port: field } })
      await run(store.doc, [0.9, 0.9, null, null], imageNodes)
      disconnect(field)
      expect(store.undo()).toBe(true)
      expect(store.redo()).toBe(true)
      await run(loadDocument(JSON.parse(JSON.stringify(store.doc))).document!, [null, null, null, null], imageNodes)
      disconnect('image')
      const shared = store.doc.graphs.detail
      const outer = store.doc.graphs.portrait
      edit('occurrence.localize', { graphId: 'root', nodeId: 'first' })
      const copy = store.doc.graphs.root!.nodes.first!.type.slice(1)
      edit('node.add', { graphId: copy, type: 'boundary-sample.image', position: { x: 0, y: 0 } })
      const source = Object.values(store.doc.graphs[copy]!.nodes).find((node) => node.type === 'boundary-sample.image')!
      edit('link.connect', { graphId: copy, from: { node: source.id, port: 'image' },
        to: { node: depth === 1 ? 'sample' : 'detail', port: 'image' } })
      expect(store.doc.graphs.detail).toEqual(shared)
      expect(store.doc.graphs.portrait).toEqual(outer)
      expect(store.undo()).toBe(true)
      expect(store.redo()).toBe(true)
      await run(loadDocument(JSON.parse(JSON.stringify(store.doc))).document!, [null, null, null, null], depth === 1 ? [imageNodes[0]!] : imageNodes)
    }, 120_000)
  }

  for (const depth of [1, 2]) {
    it(`boundary/construct-links/native-depth-${depth}`, async () => {
      const connection = new DinksterConnection({ id: asConnectionId('construct-links-live'), baseUrl: LIVE_URL!, clientId: `construct-links-${process.pid}` })
      const registry = await connection.fetchSchemas()
      const primitive: NodeSchema = {
        type: 'dinkster.utilities.primitive_float', displayName: 'Float', category: 'utilities', source: 'v3', isOutputNode: false,
        body: [
          { kind: 'input', id: 'value', type: { kind: 'concrete', name: 'FLOAT' }, optional: false,
            widget: { widgetType: 'FLOAT', options: {}, default: 0 } },
          { kind: 'output', id: 'value', type: { kind: 'concrete', name: 'FLOAT' }, knownValue: { input: 'value' } },
        ],
      }
      const resolve = (type: string) => type === primitive.type ? primitive : registry.resolve(type)
      const document = JSON.parse(readFileSync(new URL('./fixtures/boundary-sample.json', import.meta.url), 'utf8')) as WorkflowDocument
      if (depth === 1) {
        delete (document.graphs as Record<string, unknown>).portrait
        for (const id of ['first', 'second']) Object.assign(document.graphs.root!.nodes[id]!, { type: '#detail' })
      }
      for (const graph of Object.values(document.graphs)) for (const node of Object.values(graph.nodes)) {
        if (types[node.type]) Object.assign(node, { type: types[node.type] })
      }
      Object.assign(document.graphs.root!.nodes, {
        literal: { id: 'literal', type: primitive.type, values: { value: 0.57 } },
        runtime: { id: 'runtime', type: 'boundary-sample.float', values: {} },
      })
      const store = new DocumentStore(document, coreCommandRegistry(), 200, undefined,
        () => ({ kind: 'initial', schemaResolverFor: (doc) => documentResolver(doc, resolve) }))
      const edit = (command: string, params: Record<string, Json>) => {
        const result = store.dispatch({ command, params })
        expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      }
      const wire = (node: string, port: string, input: string) => edit('link.connect', {
        graphId: 'root', from: { node, port }, to: { node: 'first', port: input },
      })
      const disconnect = (port: string) => {
        const link = Object.values(store.doc.graphs.root!.links).find((item) =>
          'port' in item.to && item.to.node === 'first' && item.to.port === port)!
        edit('link.disconnect', { graphId: 'root', linkId: link.id })
      }
      edit('dynamic.materialize', { graphId: 'root', nodeId: 'first', frames: [{ construct: 'layers', members: ['layer0'] }] })
      edit('node.setValues', { graphId: 'root', nodeId: 'first', values: {
        'layers.layer0.strength': 0.27, 'mode.mix': 0.67, 'mode.text': 'linked choice dormant text',
      } })
      const baseline = store.doc
      const suffix = depth === 1 ? '.sample' : '.detail.sample'
      const first = `first${suffix}`, second = `second${suffix}`
      const run = async (phase: string, value: number, image: boolean) => {
        const loaded = loadDocument(JSON.parse(JSON.stringify(store.doc))).document!
        expect(loaded).toEqual(store.doc)
        expect(loaded.graphs.detail).toEqual(baseline.graphs.detail)
        expect(loaded.graphs.portrait).toEqual(baseline.graphs.portrait)
        expect(loaded.graphs.root!.nodes.second).toEqual(baseline.graphs.root!.nodes.second)
        expect(loaded.graphs.root!.nodes.first!.values).toEqual(baseline.graphs.root!.nodes.first!.values)
        const compiled = compile({ document: loaded, revision: 1, resolve, scope: { kind: 'full' },
          connection: registry.connection, schemaHash: registry.hash, graphFeatures: registry.graphFeatures ?? [] })
        expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
        if (!compiled.ok) throw new Error('Construct links did not compile')
        const submitted = await connection.submit(compiled.artifact)
        expect(submitted.ok, JSON.stringify(!submitted.ok && submitted.diagnostics)).toBe(true)
        if (!submitted.ok) throw new Error('Construct links were refused')
        console.info('Boundary construct link submission', JSON.stringify({ depth, phase, jobId: submitted.execution.prompt }))
        const expected = {
          [first]: { layers: [{ key: 'layer0', strength: 0.1, image: null }, { key: 'layer1', strength: 0.4, image: null },
            { key: 'layer2', strength: phase === 'disconnected' ? 0.27 : value, image: null }],
          mode: { key: image ? 'image' : 'text', mix: value, picture: image ? [0.125, 0.25, 0.5] : null,
            text: image ? null : 'linked choice dormant text' }, strength: 0.2 },
          [second]: { layers: [{ key: 'layer0', strength: 0.1, image: null }, { key: 'layer1', strength: 0.4, image: null }],
            mode: { key: 'text', mix: 0.3, picture: null, text: 'second text' }, strength: 0.8 },
        }
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
          const job = await connection.fetchJob(submitted.execution.prompt)
          if (job?.state === 'failed' || job?.state === 'cancelled') throw new Error(JSON.stringify(job))
          if (job?.state === 'completed') {
            const actual: Record<string, unknown> = {}
            for (const nodeId of [first, second]) {
              const query = { jobId: submitted.execution.prompt, nodeId, outputId: 'receipt' }
              const peek = await connection.values().peek(query)
              expect(peek.available, JSON.stringify(peek)).toBe(true)
              if (!peek.available) throw new Error('Construct link receipt unavailable')
              const text = await connection.values().rendition(query, 'text', { descriptor: peek.descriptor })
              expect(text.available, JSON.stringify(text)).toBe(true)
              if (!text.available) throw new Error('Construct link text unavailable')
              const receipt = JSON.parse(new TextDecoder().decode(text.bytes))
              actual[nodeId] = receipt
              console.info('Boundary construct link node receipt', JSON.stringify({ depth, phase, jobId: submitted.execution.prompt, nodeId, expected: expected[nodeId], actual: receipt }))
              expect(receipt, nodeId).toMatchObject(expected[nodeId]!)
            }
            console.info('Boundary construct link receipt', JSON.stringify({ depth, phase, jobId: submitted.execution.prompt, expected, actual }))
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error('Construct links did not complete')
      }
      wire('literal', 'value', 'layers.layer0.strength')
      wire('literal', 'value', 'mode.mix')
      wire('imageA', 'image', 'mode.picture')
      await run('literal', 0.57, true)
      disconnect('layers.layer0.strength')
      disconnect('mode.mix')
      wire('runtime', 'number', 'layers.layer0.strength')
      wire('runtime', 'number', 'mode.mix')
      await run('runtime', 0.9, true)
      const linked = store.doc
      edit('dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'text' })
      expect(store.doc.graphs.root!.links).toEqual(linked.graphs.root!.links)
      const text = store.doc
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(linked)
      expect(store.redo()).toBe(true)
      expect(store.doc).toEqual(text)
      await run('inactive-image', 0.9, false)
      disconnect('layers.layer0.strength')
      disconnect('mode.mix')
      const disconnected = store.doc
      expect(store.undo()).toBe(true)
      expect(store.redo()).toBe(true)
      expect(store.doc).toEqual(disconnected)
      edit('dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'image' })
      await run('disconnected', 0.67, true)
    }, 120_000)
  }

  for (const depth of [1, 2]) {
    it(`boundary/standalone-option-links/native-depth-${depth}`, async () => {
      const connection = new DinksterConnection({ id: asConnectionId('standalone-option-live'),
        baseUrl: LIVE_URL!, clientId: `standalone-option-${process.pid}` })
      const registry = await connection.fetchSchemas()
      const primitive: NodeSchema = {
        type: 'dinkster.utilities.primitive_string', displayName: 'String', category: 'utilities', source: 'v3', isOutputNode: false,
        body: [
          { kind: 'input', id: 'value', type: { kind: 'concrete', name: 'STRING' }, optional: false,
            widget: { widgetType: 'STRING', options: {}, default: '' } },
          { kind: 'output', id: 'value', type: { kind: 'concrete', name: 'STRING' }, knownValue: { input: 'value' } },
        ],
      }
      const resolve = (type: string) => type === primitive.type ? primitive : registry.resolve(type)
      const document = JSON.parse(readFileSync(new URL('./fixtures/boundary-sample.json', import.meta.url), 'utf8')) as WorkflowDocument
      if (depth === 1) {
        delete (document.graphs as Record<string, unknown>).portrait
        for (const id of ['first', 'second']) Object.assign(document.graphs.root!.nodes[id]!, { type: '#detail' })
      }
      for (const graph of Object.values(document.graphs)) {
        for (const node of Object.values(graph.nodes)) if (types[node.type]) Object.assign(node, { type: types[node.type] })
        if (graph.boundary !== undefined) Object.assign(graph, { boundary: { body: graph.boundary.body
          .filter((row) => !('id' in row && row.id === 'mode')) } })
      }
      Object.assign(document.graphs.detail!.nodes, { extra: {
        ...structuredClone(document.graphs.detail!.nodes.sample!), id: 'extra',
        values: { ...document.graphs.detail!.nodes.sample!.values, strength: 0.53,
          'mode.text': 'native private extra caption', 'mode.mix': 0.73 },
      } })
      const caption = depth === 1 ? 'caption' : 'heading'
      const picture = depth === 1 ? 'photo' : 'picture'
      Object.assign(document.graphs.root!.nodes.first!, {
        values: { strength: 0.2, count: 3, [caption]: 'native first leaf caption' }, dynamic: {},
      })
      Object.assign(document.graphs.root!.nodes.second!, {
        values: { strength: 0.8, count: 2, [caption]: 'native sibling leaf caption' }, dynamic: {},
      })
      Object.assign(document.graphs.root!.nodes, {
        literal: { id: 'literal', type: primitive.type, values: { value: 'native literal leaf caption' } },
        runtime: { id: 'runtime', type: 'boundary-sample.formula', values: { seed: 23, bias: 11 } },
      })
      const store = new DocumentStore(document, coreCommandRegistry(), 200, undefined,
        () => ({ kind: 'initial', schemaResolverFor: (current) => documentResolver(current, resolve) }))
      const edit = (command: string, params: Record<string, Json>) => {
        const before = store.doc
        const result = store.dispatch({ command, params })
        expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
        const after = store.doc
        expect(store.undo()).toBe(true)
        expect(store.doc.graphs).toEqual({ ...before.graphs, root: { ...before.graphs.root!,
          nextOrdinal: after.graphs.root!.nextOrdinal, actorCursors: after.graphs.root!.actorCursors } })
        expect(store.redo()).toBe(true)
        expect(store.doc).toEqual(after)
      }
      const select = (nodeId: string, option: string) => edit('dynamic.selectOption', {
        graphId: 'detail', nodeId, construct: 'mode', option,
      })
      for (const id of ['sample', 'extra']) select(id, 'text')
      for (const [itemId, port] of [['caption', 'mode.text'], ['photo', 'mode.picture']] as const) {
        edit('boundary.addItem', { graphId: 'detail', side: 'inputs', itemId, node: 'sample', port })
        const before = store.doc
        const refused = store.dispatch({ command: 'boundary.addBinding', params: {
          graphId: 'detail', itemId, node: 'extra', port: port === 'mode.text' ? 'mode.picture' : 'mode.text',
        } })
        expect(refused.ok).toBe(false)
        expect(refused.diagnostics.map((item) => item.code)).toContain('boundary.fanoutTypeMismatch')
        expect(store.doc).toBe(before)
        edit('boundary.addBinding', { graphId: 'detail', itemId, node: 'extra', port })
      }
      if (depth === 2) for (const [itemId, port] of [['heading', 'caption'], ['picture', 'photo']] as const) {
        edit('boundary.addItem', { graphId: 'portrait', side: 'inputs', itemId, node: 'detail', port })
      }
      const wire = (node: string, port: string, input: string) => edit('link.connect', {
        graphId: 'root', from: { node, port }, to: { node: 'first', port: input },
      })
      edit('link.connect', { graphId: 'root', from: { node: 'first', port: 'output91' },
        to: { node: 'sink', port: 'number' } })
      const sibling = store.doc.graphs.root!.nodes.second
      const path = (instance: string, extra: boolean) => `${instance}${depth === 2 ? '.detail' : ''}.${extra ? 'extra' : 'sample'}`
      const expected = (second: boolean, extra: boolean, image: boolean, text: string, pixels: boolean) => ({
        description: {}, image: null, mask: null, source: null, strength: extra ? 0.53 : second ? 0.8 : 0.2,
        layers: [{ key: 'layer0', strength: 0.1, image: null }, { key: 'layer1', strength: 0.4, image: null }],
        mode: { key: image ? 'image' : 'text', mix: extra ? 0.73 : 0.3,
          picture: image && pixels ? [0.125, 0.25, 0.5] : null, text: image ? null : text },
        nested: [{ key: 'n0', weights: [{ key: 'w0', value: 0.3 }] },
          { key: 'n1', weights: [{ key: 'w0', value: 0.3 }, { key: 'w1', value: 0.3 }] }],
      })
      const run = async (phase: string, text: string, imageTargets: readonly boolean[]) => {
        const loaded = loadDocument(JSON.parse(JSON.stringify(store.doc))).document!
        expect(loaded).toEqual(store.doc)
        expect(loaded.graphs.root!.nodes.second).toEqual(sibling)
        const compiled = compile({ document: loaded, revision: 1, resolve, scope: { kind: 'full' },
          connection: registry.connection, schemaHash: registry.hash, graphFeatures: registry.graphFeatures ?? [] })
        expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
        if (!compiled.ok) throw new Error('Standalone option workflow did not compile')
        const expectedReceivers = Object.fromEntries([false, true].flatMap((second) => [false, true].map((extra) => [
          path(second ? 'second' : 'first', extra), expected(second, extra, imageTargets[extra ? 1 : 0]!,
            second ? 'native sibling leaf caption' : text, !second),
        ])))
        const submitted = await connection.submit(compiled.artifact)
        expect(submitted.ok, JSON.stringify(!submitted.ok && submitted.diagnostics)).toBe(true)
        if (!submitted.ok) throw new Error('Standalone option workflow was refused')
        console.info('Boundary standalone option submission', JSON.stringify({ depth, phase, jobId: submitted.execution.prompt }))
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
          const job = await connection.fetchJob(submitted.execution.prompt)
          if (job?.state === 'failed' || job?.state === 'cancelled') throw new Error(JSON.stringify(job))
          if (job?.state === 'completed') {
            const outputs = job.outputs as unknown as Record<string, Record<string, { value: unknown }>>
            const actual: Record<string, unknown> = {}
            for (const [nodeId, receipt] of Object.entries(expectedReceivers)) {
              const query = { jobId: submitted.execution.prompt, nodeId, outputId: 'receipt' }
              const peek = await connection.values().peek(query)
              expect(peek.available, JSON.stringify(peek)).toBe(true)
              if (!peek.available) throw new Error('Standalone option receipt unavailable')
              const text = await connection.values().rendition(query, 'text', { descriptor: peek.descriptor })
              expect(text.available, JSON.stringify(text)).toBe(true)
              if (!text.available) throw new Error('Standalone option receipt text unavailable')
              actual[nodeId] = JSON.parse(new TextDecoder().decode(text.bytes))
              console.info('Boundary standalone option node receipt', JSON.stringify({ depth, phase,
                jobId: submitted.execution.prompt, nodeId, expected: receipt, actual: actual[nodeId] }))
              expect(actual[nodeId], nodeId).toEqual(receipt)
              expect(outputs[nodeId]?.output91?.value).toBe(91)
            }
            expect(outputs.sink?.received?.value).toBe('91')
            console.info('Boundary standalone option receipt', JSON.stringify({ depth, phase,
              jobId: submitted.execution.prompt, expected: expectedReceivers, actual }))
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error('Standalone option workflow did not complete')
      }
      await run('stored', 'native first leaf caption', [false, false])
      wire('literal', 'value', caption)
      await run('literal', 'native literal leaf caption', [false, false])
      wire('runtime', 'receipt', caption)
      await run('runtime', '{"seed": 23, "bias": 11, "total": 57}', [false, false])
      select('sample', 'image')
      select('extra', 'image')
      wire('imageA', 'image', picture)
      await run('image-both', '', [true, true])
      select('extra', 'text')
      await run('image-primary-only', '{"seed": 23, "bias": 11, "total": 57}', [true, false])
      select('sample', 'text')
      await run('image-inactive', '{"seed": 23, "bias": 11, "total": 57}', [false, false])
      select('extra', 'image')
      await run('image-secondary-only', '{"seed": 23, "bias": 11, "total": 57}', [false, true])
      select('extra', 'text')
      const link = Object.values(store.doc.graphs.root!.links).find((entry) =>
        'port' in entry.to && entry.to.node === 'first' && entry.to.port === caption)!
      edit('link.disconnect', { graphId: 'root', linkId: link.id })
      await run('disconnected', 'native first leaf caption', [false, false])
    }, 120_000)
  }

  for (const depth of [1, 2]) {
    it(`boundary/construct-lifecycle/native-depth-${depth}`, async () => {
      const connection = new DinksterConnection({ id: asConnectionId('construct-lifecycle-live'),
        baseUrl: LIVE_URL!, clientId: `construct-lifecycle-${process.pid}` })
      const registry = await connection.fetchSchemas()
      const document = JSON.parse(readFileSync(new URL('./fixtures/boundary-sample.json', import.meta.url), 'utf8')) as WorkflowDocument
      if (depth === 1) {
        delete (document.graphs as Record<string, unknown>).portrait
        for (const id of ['first', 'second']) Object.assign(document.graphs.root!.nodes[id]!, { type: '#detail' })
      }
      for (const graph of Object.values(document.graphs)) for (const node of Object.values(graph.nodes)) {
        if (types[node.type]) Object.assign(node, { type: types[node.type] })
      }
      Object.assign(document.graphs.root!.nodes.first!, {
        values: { strength: 0.2, count: 3, 'layers.layer0.strength': 0.29, 'layers.layer1.strength': 0.83,
          'mode.mix': 0.61, 'mode.text': 'lifecycle private caption' },
        dynamic: { layers: { members: ['layer1', 'layer0'] }, mode: { selected: 'text' } },
      })
      Object.assign(document.graphs.root!.nodes.second!, {
        values: { strength: 0.8, count: 2, 'layers.layer0.strength': 0.91, 'mode.mix': 0.43 },
        dynamic: { layers: { members: ['layer0'] }, mode: { selected: 'image' } },
      })
      Object.assign(document.graphs.root!.links, {
        memberInput: { id: 'memberInput', from: { node: 'imageA', port: 'image' },
          to: { node: 'first', port: 'layers.layer0.image' } },
        memberOutput: { id: 'memberOutput', from: { node: 'first', port: 'layers.layer0.result' },
          to: { node: 'sink', port: 'number' } },
      })
      const storeFor = (doc: WorkflowDocument) => new DocumentStore(doc, coreCommandRegistry(), 200, undefined,
        () => ({ kind: 'initial', schemaResolverFor: (current) => documentResolver(current, registry.resolve) }))
      const expected = (sibling: boolean, mix = 0.61) => ({
        description: {}, image: null, mask: null, source: null, strength: sibling ? 0.8 : 0.2,
        layers: [{ key: 'layer0', strength: 0.1, image: null }, { key: 'layer1', strength: 0.4, image: null },
          ...(sibling ? [{ key: 'layer2', strength: 0.91, image: null }] : [
            { key: 'layer3', strength: 0.83, image: null },
            { key: 'layer2', strength: 0.29, image: [0.125, 0.25, 0.5] },
          ])],
        mode: { key: sibling ? 'image' : 'text', mix: sibling ? 0.43 : mix,
          picture: null, text: sibling ? null : 'lifecycle private caption' },
        nested: [{ key: 'n0', weights: [{ key: 'w0', value: 0.3 }] },
          { key: 'n1', weights: [{ key: 'w0', value: 0.3 }, { key: 'w1', value: 0.3 }] }],
      })
      const second = depth === 1 ? 'second.sample' : 'second.detail.sample'
      const run = async (phase: string, doc: WorkflowDocument, first: string, muted = false, mix = 0.61) => {
        const loaded = loadDocument(JSON.parse(JSON.stringify(doc))).document!
        expect(loaded).toEqual(doc)
        expect(loaded.graphs.detail).toEqual(document.graphs.detail)
        expect(loaded.graphs.portrait).toEqual(document.graphs.portrait)
        expect(loaded.graphs.root!.nodes.second).toEqual(document.graphs.root!.nodes.second)
        const compiled = compile({ document: loaded, revision: 1, resolve: registry.resolve, scope: { kind: 'full' },
          connection: registry.connection, schemaHash: registry.hash, graphFeatures: registry.graphFeatures ?? [] })
        expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
        if (!compiled.ok) throw new Error('Construct lifecycle did not compile')
        if (muted) expect(compiled.artifact.prompt.sink!.inputs.number).toEqual({
          $absent: { reason: expect.stringContaining('muted') },
        })
        else expect(compiled.artifact.prompt.sink!.inputs.number).toEqual([first, 3])
        const submitted = await connection.submit(compiled.artifact)
        expect(submitted.ok, JSON.stringify(!submitted.ok && submitted.diagnostics)).toBe(true)
        if (!submitted.ok) throw new Error('Construct lifecycle was refused')
        console.info('Boundary construct lifecycle submission', JSON.stringify({ depth, phase, jobId: submitted.execution.prompt }))
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
          const job = await connection.fetchJob(submitted.execution.prompt)
          if (job?.state === 'failed' || job?.state === 'cancelled') throw new Error(JSON.stringify(job))
          if (job?.state === 'completed') {
            const outputs = job.outputs as unknown as Record<string, Record<string, { value: unknown }>>
            const actual: Record<string, unknown> = {}
            if (muted) expect(outputs[first]).toBeUndefined()
            for (const nodeId of muted ? [second] : [first, second]) {
              const query = { jobId: submitted.execution.prompt, nodeId, outputId: 'receipt' }
              const peek = await connection.values().peek(query)
              expect(peek.available, JSON.stringify(peek)).toBe(true)
              if (!peek.available) throw new Error('Construct lifecycle receipt unavailable')
              const text = await connection.values().rendition(query, 'text', { descriptor: peek.descriptor })
              expect(text.available, JSON.stringify(text)).toBe(true)
              if (!text.available) throw new Error('Construct lifecycle text unavailable')
              actual[nodeId] = JSON.parse(new TextDecoder().decode(text.bytes))
              console.info('Boundary construct lifecycle node receipt', JSON.stringify({ depth, phase,
                jobId: submitted.execution.prompt, nodeId, expected: expected(nodeId === second, mix), actual: actual[nodeId] }))
              expect(actual[nodeId], nodeId).toEqual(expected(nodeId === second, mix))
              expect(outputs[nodeId]?.output91?.value).toBe(91)
            }
            expect(outputs.sink?.received?.value).toBe(muted ? 'null' : '0.29')
            console.info('Boundary construct lifecycle receipt', JSON.stringify({ depth, phase,
              jobId: submitted.execution.prompt, actual, sink: outputs.sink?.received?.value }))
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error('Construct lifecycle did not complete')
      }
      const first = depth === 1 ? 'first.sample' : 'first.detail.sample'
      await run('baseline', document, first)
      const detached = storeFor(document)
      for (const invocation of [
        { command: 'occurrence.localize', params: { graphId: 'root', nodeId: 'first' } },
        { command: 'node.setValues', params: { graphId: 'root', nodeId: 'first', values: {}, unset: ['mode.mix'] } },
      ]) expect(detached.dispatch(invocation as CommandInvocation).ok).toBe(true)
      const privateGraph = detached.doc.graphs.root!.nodes.first!.type.slice(1)
      expect(detached.dispatch({ command: 'node.setValue', params: { graphId: privateGraph,
        nodeId: depth === 1 ? 'sample' : 'detail', inputId: 'mode.mix', value: 0.79 } }).ok).toBe(true)
      const privateEdit = detached.doc
      for (let step = 0; step < 3; step++) expect(detached.undo()).toBe(true)
      expect(detached.doc).toEqual(document)
      for (let step = 0; step < 3; step++) expect(detached.redo()).toBe(true)
      expect(detached.doc).toEqual(privateEdit)
      await run('detached-private-edit', detached.doc, first, false, 0.79)
      for (const mode of ['active', 'muted', 'bypassed'] as const) {
        const session = storeFor(document)
        if (mode !== 'active') expect(session.dispatch({ command: 'node.setMode',
          params: { graphId: 'root', nodeIds: ['first'], mode } }).ok).toBe(true)
        const before = session.doc, root = before.graphs.root!, node = root.nodes.first!, body = before.graphs[node.type.slice(1)]!
        const resolve = documentResolver(before, registry.resolve)
        const plan = planFlattenBoundaryRoutes(body, resolve, node, root)
        const topology = planFlattenOccurrenceTopology(before, resolve, { instancePath: [], node: node.id })
        const topologyParams = topology.plan === undefined ? {} : { occurrenceTopologyPlan: topology.plan,
          occurrenceTopologyPlanDigest: lifecycleCanonicalHash(topology.plan) }
        const fingerprint = lifecycleFlattenFingerprint(before, 'root', 'first', { boundaryPlan: plan.boundaryPlan,
          statePlan: plan.statePlan, schemaPlanDigest: plan.schemaPlanDigest, ...topologyParams })
        const result = session.dispatch({ command: 'subgraph.flatten', params: {
          graphId: 'root', instancePath: [], nodeId: 'first', placementCenter: { x: 100, y: 100 },
          resolvedGeometry: { occurrence: { id: 'first', kind: 'node', x: 0, y: 0, width: 200, height: 200 },
            body: Object.keys(body.nodes).map((id) => ({ id, kind: 'node', x: 0, y: 0, width: 200, height: 200 })) },
          boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaSnapshot: plan.schemaSnapshot,
          schemaPlanDigest: plan.schemaPlanDigest, selectionFingerprint: fingerprint, ...topologyParams,
        } } as unknown as CommandInvocation)
        if (mode === 'bypassed') {
          expect(result.ok).toBe(false)
          expect(result.diagnostics.map((item) => item.code)).toContain('subgraph.flatten.modeUnsupported')
          expect(session.doc).toBe(before)
          continue
        }
        expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
        const flattened = session.doc
        const replacement = Object.values(flattened.graphs.root!.nodes).find((entry) => root.nodes[entry.id] === undefined)!
        expect(replacement).toBeDefined()
        expect(session.undo()).toBe(true)
        expect(session.doc.graphs).toEqual({ ...before.graphs, root: { ...root, nextOrdinal: flattened.graphs.root!.nextOrdinal } })
        expect(session.redo()).toBe(true)
        expect(session.doc).toEqual(flattened)
        await run(`${mode}-flatten`, flattened, depth === 1 ? replacement.id : `${replacement.id}.sample`, mode === 'muted')
        if (mode === 'muted') {
          expect(session.dispatch({ command: 'node.setMode', params: { graphId: 'root',
            nodeIds: [replacement.id], mode: 'active' } }).ok).toBe(true)
          await run('muted-reactivated', session.doc, depth === 1 ? replacement.id : `${replacement.id}.sample`)
        }
      }
    }, 120_000)
  }

  for (const depth of [1, 2]) {
    it(`boundary/buttons/native-depth-${depth}`, async () => {
      const connection = new DinksterConnection({ id: asConnectionId('button-live'), baseUrl: LIVE_URL!, clientId: `buttons-${process.pid}` })
      const registry = await connection.fetchSchemas()
      const graph = (id: string, nodes: unknown) => ({ id, name: id, nodes, links: {}, nets: {}, reroutes: {}, nextOrdinal: 100, boundary: { body: [] } })
      const node = (id: string, type: string, values = {}) => ({ id, type, values })
      const document = {
        format: 'dinkster-workflow', formatVersion: 1, lineage: `native-buttons-${depth}`, root: 'root', view: { graphs: {} },
        graphs: {
          root: graph('root', { first: node('first', depth === 1 ? '#detail' : '#portrait'), second: node('second', depth === 1 ? '#detail' : '#portrait'), source: node('source', 'boundary-sample.float') }),
          detail: graph('detail', { inner: node('inner', 'boundary-sample.button-counter', { amount: 3, delta: 7 }), extra: node('extra', 'boundary-sample.button-counter', { amount: 2, delta: 13 }) }),
          ...(depth === 2 ? { portrait: graph('portrait', { detail: node('detail', '#detail') }) } : {}),
        },
      } as unknown as WorkflowDocument
      const session = createLocalSession(document, coreCommandRegistry([], registry.resolve), { schemaResolverFor: (doc) => documentResolver(doc, registry.resolve) })
      const dispatch = (command: string, params: Record<string, Json>) => {
        const result = session.dispatch({ command, params })
        expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      }
      dispatch('boundary.addItem', { graphId: 'detail', side: 'inputs', node: 'inner', port: 'amount', itemId: 'gain' })
      dispatch('boundary.addBinding', { graphId: 'detail', itemId: 'gain', node: 'extra', port: 'amount' })
      dispatch('boundary.showButton', { graphId: 'detail', node: 'inner', button: 'increase' })
      if (depth === 2) {
        dispatch('boundary.addItem', { graphId: 'portrait', side: 'inputs', node: 'detail', port: 'gain', itemId: 'boost' })
        dispatch('boundary.showButton', { graphId: 'portrait', node: 'detail', button: 'increase' })
      }
      const field = depth === 1 ? 'gain' : 'boost'
      for (const [nodeId, value] of [['first', 10], ['second', 80]] as const) dispatch('node.setValue', { graphId: 'root', nodeId, inputId: field, value })
      const definition = session.doc.graphs.detail
      const unavailable = () => { throw new Error('This button must not call a host service') }
      const host: ActionHost = {
        commands: coreCommandRegistry([], registry.resolve), schemaResolverFor: (doc) => documentResolver(doc, registry.resolve),
        schemaOf: (doc, graphId, item) => documentNodeResolver(doc, registry.resolve)(graphId, item),
        lookup: unavailable, call: unavailable, pick: unavailable, ask: unavailable, openPicker: unavailable,
        editorFor: unavailable, pasteImage: unavailable, copy: unavailable, download: unavailable, queue: unavailable,
        interrupt: unavailable, openLink: unavailable, random: unavailable,
      }
      const target = { graphId: 'root', nodeId: 'first', button: 'increase' }
      const run = async (doc: WorkflowDocument, firstValue: number) => {
        const compiled = compile({ document: doc, revision: 1, resolve: registry.resolve, scope: { kind: 'full' }, connection: registry.connection, schemaHash: registry.hash, graphFeatures: registry.graphFeatures ?? [] })
        expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
        if (!compiled.ok) throw new Error('Button workflow did not compile')
        const submitted = await connection.submit(compiled.artifact)
        expect(submitted.ok, JSON.stringify(!submitted.ok && submitted.diagnostics)).toBe(true)
        if (!submitted.ok) throw new Error('Button workflow was refused')
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
          const job = await connection.fetchJob(submitted.execution.prompt)
          if (job?.state === 'failed' || job?.state === 'cancelled') throw new Error(JSON.stringify(job))
          if (job?.state === 'completed') {
            const outputs = job.outputs as unknown as Record<string, Record<string, { value: unknown }>>
            const prefix = depth === 1 ? '' : 'detail.'
            for (const [instance, value] of [['first', firstValue], ['second', 80]] as const) {
              for (const [inner, delta] of [['inner', 7], ['extra', 13]] as const) {
                expect(outputs[`${instance}.${prefix}${inner}`]?.result?.value).toBe(value)
                expect(outputs[`${instance}.${prefix}${inner}`]?.private_delta?.value).toBe(delta)
              }
            }
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error('Button workflow did not complete')
      }
      const before = session.doc
      expect(await runPress(session, target, host)).toMatchObject({ kind: 'done' })
      expect(session.doc.graphs.detail).toEqual(definition)
      expect(session.doc.graphs.root!.nodes.first!.values[field]).toBe(17)
      expect(session.undo()).toBe(true)
      expect(session.doc).toEqual(before)
      expect(session.redo()).toBe(true)
      await run(session.doc, 17)
      dispatch('link.connect', { graphId: 'root', from: { node: 'source', port: 'number' }, to: { node: 'first', port: field } })
      const wired = session.doc
      expect(buttonAvailability(wired, target, host).enabled).toBe(false)
      expect(await runPress(session, target, host)).toMatchObject({ kind: 'failed' })
      expect(session.doc).toBe(wired)
      await run(wired, 0.9)
      const linkId = Object.keys(wired.graphs.root!.links)[0]!
      dispatch('link.disconnect', { graphId: 'root', linkId })
      const loaded = loadDocument(JSON.parse(JSON.stringify(session.doc)))
      expect(loaded.document, JSON.stringify(loaded.diagnostics)).toBeDefined()
      const reopened = createLocalSession(loaded.document!, coreCommandRegistry([], registry.resolve), { schemaResolverFor: (doc) => documentResolver(doc, registry.resolve) })
      expect(await runPress(reopened, target, host)).toMatchObject({ kind: 'done' })
      expect(reopened.doc.graphs.detail).toEqual(definition)
      await run(reopened.doc, 24)
    })
  }

  for (const level of [0, 1, 2] as const) {
    it(`boundary/constructs/${level === 0 ? 'plain-reference' : level === 1 ? 'one-level' : 'two-levels'}`, async () => {
      const connection = new DinksterConnection({
        id: asConnectionId('boundary-live'),
        baseUrl: LIVE_URL!,
        clientId: `boundary-${process.pid}`,
      })
      const registry = await connection.fetchSchemas()
      const source = JSON.parse(
        readFileSync(
          new URL('./fixtures/boundary-sample.json', import.meta.url),
          'utf8',
        ),
      ) as WorkflowDocument
      if (level !== 2) {
        const graphs = { ...source.graphs }
        delete graphs.portrait
        for (const id of ['first', 'second']) {
          const node = graphs.root!.nodes[id]!
          Object.assign(node, {
            type: level === 1 ? '#detail' : 'Boundary sample',
          })
          if (level === 0)
            Object.assign(node, {
              dynamic: {
                ...structuredClone(graphs.detail!.nodes.sample!.dynamic),
                ...node.dynamic,
              },
              values: {
                ...graphs.detail!.nodes.sample!.values,
                ...node.values,
              },
            })
        }
        if (level === 0) delete graphs.detail
        Object.assign(source, { graphs })
      }
      for (const graph of Object.values(source.graphs)) {
        for (const node of Object.values(graph.nodes)) {
          if (types[node.type]) Object.assign(node, { type: types[node.type] })
        }
      }
      Object.assign(source.graphs.root!.nodes, {
        integer: { id: 'integer', type: 'boundary-sample.int', values: {} },
      })
      const store = new DocumentStore(
        source,
        coreCommandRegistry(),
        200,
        undefined,
        () => ({
          kind: 'initial',
          schemaResolverFor: (doc) => documentResolver(doc, registry.resolve),
        }),
      )
      const dispatch = (command: string, params: Record<string, Json>) => {
        const result = store.dispatch({ command, params })
        expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      }
      const set = (inputId: string, value: Json) =>
        dispatch('node.setValue', {
          graphId: 'root',
          nodeId: 'first',
          inputId,
          value,
        })
      const wire = (
        node: string,
        port: string,
        target: string,
        input: string,
      ) =>
        dispatch('link.connect', {
          graphId: 'root',
          from: { node, port },
          to: { node: target, port: input },
        })
      const path =
        level === 0
          ? 'first'
          : level === 1
            ? 'first.sample'
            : 'first.detail.sample'
      const secondPath =
        level === 0
          ? 'second'
          : level === 1
            ? 'second.sample'
            : 'second.detail.sample'
      const run = async (document: WorkflowDocument = store.doc, firstPath = path, includeFirst = true) => {
        const compiled = compile({
          document,
          revision: store.revision,
          resolve: registry.resolve,
          scope: { kind: 'full' },
          connection: registry.connection,
          schemaHash: registry.hash,
          graphFeatures: registry.graphFeatures ?? [],
        })
        expect(
          compiled.ok,
          JSON.stringify(!compiled.ok && compiled.diagnostics),
        ).toBe(true)
        if (!compiled.ok) throw new Error('Boundary sample did not compile')
        const submitted = await connection.submit(compiled.artifact)
        expect(
          submitted.ok,
          JSON.stringify(!submitted.ok && submitted.diagnostics),
        ).toBe(true)
        if (!submitted.ok) throw new Error('Boundary sample was refused')
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
          const job = await connection.fetchJob(submitted.execution.prompt)
          if (job?.state === 'failed' || job?.state === 'cancelled')
            throw new Error(JSON.stringify(job))
          if (job?.state === 'completed') {
            const outputs = job.outputs as unknown as Record<
              string,
              Record<string, { value: unknown }>
            >
            const value = (node: string, output: string) =>
              outputs[node]?.[output]?.value
            const receipt = async (nodeId: string) => {
              const query = {
                jobId: submitted.execution.prompt,
                nodeId,
                outputId: 'receipt',
              }
              const peek = await connection.values().peek(query)
              expect(peek.available, JSON.stringify(peek)).toBe(true)
              if (!peek.available)
                throw new Error('Boundary receipt unavailable')
              const text = await connection
                .values()
                .rendition(query, 'text', { descriptor: peek.descriptor })
              expect(text.available, JSON.stringify(text)).toBe(true)
              if (!text.available)
                throw new Error('Boundary receipt text unavailable')
              return JSON.parse(new TextDecoder().decode(text.bytes))
            }
            return {
              value,
              receipt,
              first: includeFirst ? await receipt(firstPath) : null,
              second: await receipt(secondPath),
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error('Boundary sample execution did not complete')
      }

      wire('imageA', 'image', 'first', 'image')
      wire('maskB', 'mask', 'first', 'mask')
      wire('first', 'outputs.o2', 'sink', 'number')
      const before = await run()
      expect(before.first).toMatchObject({
        strength: 0.2,
        image: [0.125, 0.25, 0.5],
        mask: [0.75],
        mode: { key: 'image' },
      })
      expect(before.second).toMatchObject({
        strength: 0.8,
        image: null,
        mask: null,
        mode: { key: 'text', text: 'second text' },
      })
      expect(
        [0, 1, 2].map((index) => before.value(path, `outputs.o${index}`)),
      ).toEqual([10, 20, 30])
      expect(before.value(secondPath, 'outputs.o2')).toBeUndefined()
      expect(before.value(path, 'output91')).toBe(91)
      expect(before.value(secondPath, 'output91')).toBe(91)
      expect(before.value('sink', 'received')).toBe('30.0')

      if (level === 2) {
        dispatch('boundary.unbind', {
          graphId: 'detail',
          side: 'inputs',
          itemId: 'strength',
          node: 'sample',
          port: 'strength',
        })
        const broken = await run()
        expect(broken.first.strength).toBe(0.3)
        expect(broken.second.strength).toBe(0.3)
        expect(broken.value(path, 'output91')).toBe(91)
        expect(broken.value(secondPath, 'output91')).toBe(91)
        expect(broken.value('sink', 'received')).toBe('30.0')
        expect(store.undo()).toBe(true)
        const restored = await run()
        expect(restored.first.strength).toBe(0.2)
        expect(restored.second.strength).toBe(0.8)
      }

      const loaded = loadDocument(JSON.parse(JSON.stringify(store.doc)))
      expect(loaded.document, JSON.stringify(loaded.diagnostics)).toBeDefined()
      expect((await run(loaded.document!)).first).toEqual(before.first)
      set('count', 1)
      expect(Object.keys(store.doc.graphs.root!.links)).toHaveLength(2)
      const shrunk = await run()
      expect(shrunk.value(path, 'outputs.o1')).toBeUndefined()
      expect(shrunk.value(path, 'outputs.o2')).toBeUndefined()
      expect(shrunk.value('sink', 'received')).toBe('null')
      expect(shrunk.value(secondPath, 'outputs.o1')).toBe(20)
      expect(store.undo()).toBe(true)
      expect((await run()).value('sink', 'received')).toBe('30.0')
      expect(store.redo()).toBe(true)
      set('count', 3)
      const regrown = await run()
      expect(regrown.value(path, 'outputs.o2')).toBe(30)
      expect(regrown.value('sink', 'received')).toBe('null')
      set('count', 4)
      expect((await run()).value(path, 'outputs.o3')).toBe(40)
      const beforeRefusal = store.doc
      const refusal = store.dispatch({
        command: 'link.connect',
        params: {
          graphId: 'root',
          from: { node: 'integer', port: 'number' },
          to: { node: 'first', port: 'count' },
        },
      })
      expect(refusal.ok).toBe(false)
      expect(store.doc).toBe(beforeRefusal)

      dispatch('dynamic.materialize', {
        graphId: 'root',
        nodeId: 'first',
        frames: [{ construct: 'layers', members: ['layer0', 'layer1'] }],
      })
      dispatch('node.setValues', {
        graphId: 'root',
        nodeId: 'first',
        values: {
          'layers.layer0.strength': 0.2,
          'layers.layer1.strength': 0.8,
        },
      })
      const grouped = await run()
      expect(grouped.first.layers).toEqual(
        level === 0
          ? [
              { key: 'layer0', strength: 0.2, image: null },
              { key: 'layer1', strength: 0.8, image: null },
            ]
          : [
              { key: 'layer0', strength: 0.1, image: null },
              { key: 'layer1', strength: 0.4, image: null },
              { key: 'layer2', strength: 0.2, image: null },
              { key: 'layer3', strength: 0.8, image: null },
            ],
      )
      expect(grouped.second.layers).toEqual([
        { key: 'layer0', strength: 0.1, image: null },
        { key: 'layer1', strength: 0.4, image: null },
      ])
      wire('imageA', 'image', 'first', 'layers.layer0.image')
      wire('first', 'layers.layer0.result', 'sink', 'number')
      const memberRun = await run()
      expect(memberRun.first.layers[level === 0 ? 0 : 2]).toEqual({
        key: level === 0 ? 'layer0' : 'layer2',
        strength: 0.2,
        image: [0.125, 0.25, 0.5],
      })
      expect(memberRun.value('sink', 'received')).toBe('0.2')
      dispatch('dynamic.moveMember', {
        graphId: 'root',
        nodeId: 'first',
        construct: 'layers',
        member: 'layer1',
        index: 0,
      })
      const reordered = await run()
      expect(
        reordered.first.layers.map((member: { key: string }) => member.key),
      ).toEqual(
        level === 0
          ? ['layer1', 'layer0']
          : ['layer0', 'layer1', 'layer3', 'layer2'],
      )
      expect(reordered.value('sink', 'received')).toBe('0.2')

      dispatch('node.setValues', {
        graphId: level === 0 ? 'root' : 'detail',
        nodeId: level === 0 ? 'first' : 'sample',
        values: {
          'nested.n0.weights.w0': 0.2,
          'nested.n1.weights.w0': 0.8,
          'nested.n1.weights.w1': 0.9,
        },
      })
      expect((await run()).first.nested).toEqual([
        { key: 'n0', weights: [{ key: 'w0', value: 0.2 }] },
        {
          key: 'n1',
          weights: [
            { key: 'w0', value: 0.8 },
            { key: 'w1', value: 0.9 },
          ],
        },
      ])
      set('mode.text', 'outer dormant text')
      dispatch('dynamic.selectOption', {
        graphId: 'root',
        nodeId: 'first',
        construct: 'mode',
        option: 'text',
      })
      const chosen = await run()
      expect(chosen.first.mode).toMatchObject({
        key: 'text',
        text: 'outer dormant text',
      })
      expect(chosen.second.mode).toMatchObject({
        key: 'text',
        text: 'second text',
      })
      dispatch('dynamic.selectOption', {
        graphId: 'root',
        nodeId: 'first',
        construct: 'mode',
        option: 'image',
      })
      expect((await run()).first.mode).toMatchObject({
        key: 'image',
        text: null,
      })
      dispatch('dynamic.selectOption', {
        graphId: 'root',
        nodeId: 'first',
        construct: 'mode',
        option: 'text',
      })
      expect((await run()).first.mode).toMatchObject({
        key: 'text',
        text: 'outer dormant text',
      })

      dispatch('dynamic.specializeSlot', {
        graphId: 'root',
        nodeId: 'first',
        construct: 'source',
        variant: 'mask',
      })
      set('source.gain', 0.8)
      wire('maskB', 'mask', 'first', 'source')
      const typed = await run()
      expect(typed.first.source).toEqual({
        variant: 'mask',
        pixels: [0.75],
        gain: 0.8,
      })
      expect(typed.second.source).toBeNull()

      set(
        'description',
        '{"entries":[{"id":"text","label":"Caption A","kind":"text"},{"id":"number","label":"Result B","kind":"number"}]}',
      )
      set('description.text', 'outer caption')
      wire('first', 'description.number', 'sink', 'number')
      const described = await run()
      expect(described.first.description).toEqual({
        text: 'outer caption',
        number: null,
      })
      expect(described.second.description).toEqual({})
      expect(described.value('sink', 'received')).toBe('47.0')
      set(
        'description',
        '{"entries":[{"id":"text","label":"Caption renamed","kind":"text"},{"id":"number","label":"Result renamed","kind":"number"}]}',
      )
      expect((await run()).value('sink', 'received')).toBe('47.0')
      const reloaded = loadDocument(JSON.parse(JSON.stringify(store.doc)))
      expect(
        reloaded.document,
        JSON.stringify(reloaded.diagnostics),
      ).toBeDefined()
      expect((await run(reloaded.document!)).first).toEqual((await run()).first)

      for (const [feature, output, expected] of [
        ['output', 'result', '0.2'], ['output', 'output91', '91.0'],
        ['counted-outputs', 'outputs.o2', '30.0'], ['member-outputs', 'layers.layer0.result', '0.35'],
        ['described-outputs', 'description.number', '47.0'],
      ] as const) {
        const document = structuredClone(store.doc)
        Object.assign(document.graphs.root!.nodes, {
          otherSink: { id: 'otherSink', type: 'boundary-sample.sink', values: {} },
        })
        const outputs = new DocumentStore(document, coreCommandRegistry(), 200, undefined, () => ({
          kind: 'initial', schemaResolverFor: (doc) => documentResolver(doc, registry.resolve),
        }))
        if (feature === 'member-outputs') expect(outputs.dispatch({ command: 'node.setValue', params: {
          graphId: 'root', nodeId: 'first', inputId: 'layers.layer0.strength', value: 0.35,
        } }).ok).toBe(true)
        for (const target of ['sink', 'otherSink']) expect(outputs.dispatch({ command: 'link.connect', params: {
          graphId: 'root', from: { node: 'first', port: output }, to: { node: target, port: 'number' },
        } }).ok).toBe(true)
        const sharedOutput = await run(outputs.doc)
        expect(sharedOutput.value('sink', 'received'), `boundary/${feature}/fan-out`).toBe(expected)
        expect(sharedOutput.value('otherSink', 'received'), `boundary/${feature}/fan-out`).toBe(expected)
        expect(sharedOutput.value(path, 'result')).toBe(0.2)
        expect(sharedOutput.second.strength).toBe(0.8)
        expect(outputs.undo()).toBe(true)
        const undoneOutput = await run(outputs.doc)
        expect(undoneOutput.value('sink', 'received')).toBe(expected)
        expect(undoneOutput.value('otherSink', 'received')).toBe('null')
        expect(outputs.redo()).toBe(true)
        const reopenedOutput = loadDocument(JSON.parse(JSON.stringify(outputs.doc)))
        expect(reopenedOutput.document).toBeDefined()
        const restoredOutput = await run(reopenedOutput.document!)
        expect(restoredOutput.value('sink', 'received')).toBe(expected)
        expect(restoredOutput.value('otherSink', 'received')).toBe(expected)
        if (level > 0) {
          const stable = outputs.doc
          const refusal = outputs.dispatch({ command: 'boundary.addBinding', params: {
            graphId: 'detail', itemId: 'output91', node: 'sample', port: 'result',
          } })
          expect(refusal.ok).toBe(false)
          expect(refusal.diagnostics.map((diagnostic) => diagnostic.code)).toContain('boundary.itemMissing')
          expect(outputs.doc).toBe(stable)
        }
      }

      if (level > 0) {
        const lifecycleBaseline = store.doc
        const lifecycleRun = await run()
        const fanoutSource = structuredClone(lifecycleBaseline)
        const sample = fanoutSource.graphs.detail!.nodes.sample!
        Object.assign(fanoutSource.graphs.detail!.nodes, {
          incompatible: { ...structuredClone(sample), id: 'incompatible' },
          extra: { ...structuredClone(sample), id: 'extra', values: {
            ...sample.values, 'mode.mix': 0.17, 'layers.layer0.strength': 0.6, 'layers.layer1.strength': 0.9,
            'nested.n0.weights.w0': 0.55,
          } },
        })
        const fanout = new DocumentStore(fanoutSource, coreCommandRegistry(), 200, undefined, () => ({
          kind: 'initial', schemaResolverFor: (doc) => documentResolver(doc, registry.resolve),
        }))
        for (const itemId of ['strength', 'mode', 'layers', 'source', 'description', 'nested']) {
          const result = fanout.dispatch({ command: 'boundary.addBinding', params: {
            graphId: 'detail', itemId, node: 'extra', port: itemId,
          } })
          expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
        }
        expect(fanout.dispatch({ command: 'node.setValue', params: {
          graphId: 'root', nodeId: 'first', inputId: 'mode.mix', value: 0.84,
        } }).ok).toBe(true)
        expect(fanout.dispatch({ command: 'dynamic.materialize', params: {
          graphId: 'root', nodeId: 'first', frames: [
            { construct: 'nested', members: ['n0'] }, { construct: 'nested.n0.weights', members: ['w0', 'w1'] },
          ],
        } }).ok).toBe(true)
        expect(fanout.dispatch({ command: 'node.setValues', params: {
          graphId: 'root', nodeId: 'first', values: { 'nested.n0.weights.w0': 0.25, 'nested.n0.weights.w1': 0.85 },
        } }).ok).toBe(true)
        const extraPath = level === 1 ? 'first.extra' : 'first.detail.extra'
        const secondExtraPath = level === 1 ? 'second.extra' : 'second.detail.extra'
        const shared = await run(fanout.doc)
        const extra = await shared.receipt(extraPath)
        const secondExtra = await shared.receipt(secondExtraPath)
        expect(shared.first.strength).toBe(0.2)
        expect(extra.strength).toBe(0.2)
        expect(shared.second.strength).toBe(0.8)
        expect(secondExtra.strength).toBe(0.8)
        expect(shared.first.mode).toMatchObject({ key: 'text', mix: 0.84, text: 'outer dormant text' })
        expect(extra.mode).toMatchObject({ key: 'text', mix: 0.84, text: 'outer dormant text' })
        expect(shared.first.layers).toEqual([
          { key: 'layer0', strength: 0.1, image: null }, { key: 'layer1', strength: 0.4, image: null },
          { key: 'layer3', strength: 0.8, image: null }, { key: 'layer2', strength: 0.2, image: [0.125, 0.25, 0.5] },
        ])
        expect(extra.layers).toEqual([
          { key: 'layer0', strength: 0.6, image: null }, { key: 'layer1', strength: 0.9, image: null },
          { key: 'layer3', strength: 0.8, image: null }, { key: 'layer2', strength: 0.2, image: [0.125, 0.25, 0.5] },
        ])
        expect(shared.second.layers).toEqual([
          { key: 'layer0', strength: 0.1, image: null }, { key: 'layer1', strength: 0.4, image: null },
        ])
        expect(secondExtra.layers).toEqual([
          { key: 'layer0', strength: 0.6, image: null }, { key: 'layer1', strength: 0.9, image: null },
        ])
        expect(secondExtra.mode).toMatchObject({ key: 'text', text: 'second text', mix: 0.17 })
        expect(shared.second.mode).toMatchObject({ key: 'text', text: 'second text', mix: 0.3 })
        expect(shared.first.source).toEqual({ variant: 'mask', pixels: [0.75], gain: 0.8 })
        expect(extra.source).toEqual({ variant: 'mask', pixels: [0.75], gain: 0.8 })
        expect(shared.second.source).toBeNull()
        expect(secondExtra.source).toBeNull()
        expect(shared.first.description).toEqual({ text: 'outer caption', number: null })
        expect(extra.description).toEqual({ text: 'outer caption', number: null })
        expect(shared.second.description).toEqual({})
        expect(secondExtra.description).toEqual({})
        expect(shared.first.nested).toEqual([
          { key: 'n0', weights: [{ key: 'w0', value: 0.2 }] },
          { key: 'n1', weights: [{ key: 'w0', value: 0.8 }, { key: 'w1', value: 0.9 }] },
          { key: 'n2', weights: [{ key: 'w0', value: 0.25 }, { key: 'w1', value: 0.85 }] },
        ])
        expect(extra.nested).toEqual([
          { key: 'n0', weights: [{ key: 'w0', value: 0.55 }] },
          { key: 'n1', weights: [{ key: 'w0', value: 0.8 }, { key: 'w1', value: 0.9 }] },
          { key: 'n2', weights: [{ key: 'w0', value: 0.25 }, { key: 'w1', value: 0.85 }] },
        ])
        expect(shared.second.nested).toEqual([
          { key: 'n0', weights: [{ key: 'w0', value: 0.2 }] },
          { key: 'n1', weights: [{ key: 'w0', value: 0.8 }, { key: 'w1', value: 0.9 }] },
        ])
        expect(secondExtra.nested).toEqual([
          { key: 'n0', weights: [{ key: 'w0', value: 0.55 }] },
          { key: 'n1', weights: [{ key: 'w0', value: 0.8 }, { key: 'w1', value: 0.9 }] },
        ])
        const stable = fanout.doc
        for (const [itemId, port] of [['mode', 'nested'], ['source', 'mode'], ['description', 'layers'], ['nested', 'layers']] as const) {
          const mismatch = fanout.dispatch({ command: 'boundary.addBinding', params: {
            graphId: 'detail', itemId, node: 'incompatible', port,
          } })
          expect(mismatch.ok).toBe(false)
          expect(mismatch.diagnostics.map((diagnostic) => diagnostic.code)).toContain('boundary.constructShapeMismatch')
          expect(fanout.doc).toBe(stable)
        }
        expect(fanout.dispatch({ command: 'boundary.unbind', params: {
          graphId: 'detail', side: 'inputs', itemId: 'mode', kind: 'construct', node: 'sample', port: 'mode',
        } }).ok).toBe(true)
        const unbound = await run(fanout.doc)
        expect(unbound.first.mode).toMatchObject({ key: 'image', mix: 0.3, text: null })
        expect((await unbound.receipt(extraPath)).mode).toEqual(extra.mode)
        expect((await unbound.receipt(secondExtraPath)).mode).toEqual(secondExtra.mode)
        expect(fanout.undo()).toBe(true)
        const undoFanout = await run(fanout.doc)
        expect(undoFanout.first.mode).toEqual(shared.first.mode)
        expect((await undoFanout.receipt(extraPath)).mode).toEqual(extra.mode)
        expect(fanout.redo()).toBe(true)
        const fanoutReload = loadDocument(JSON.parse(JSON.stringify(fanout.doc)))
        expect(fanoutReload.document).toBeDefined()
        const restoredFanout = await run(fanoutReload.document!)
        expect(restoredFanout.first.mode).toMatchObject({ key: 'image', mix: 0.3, text: null })
        expect((await restoredFanout.receipt(extraPath)).mode).toEqual(extra.mode)
        expect(restoredFanout.second.mode).toEqual(unbound.second.mode)
        expect((await restoredFanout.receipt(secondExtraPath)).mode).toEqual(secondExtra.mode)
        for (const observed of [unbound, undoFanout, restoredFanout]) {
          const observedExtra = await observed.receipt(extraPath)
          const observedSecondExtra = await observed.receipt(secondExtraPath)
          for (const feature of ['source', 'description', 'nested']) {
            expect(observed.first[feature]).toEqual(shared.first[feature])
            expect(observed.second[feature]).toEqual(shared.second[feature])
            expect(observedExtra[feature]).toEqual(extra[feature])
            expect(observedSecondExtra[feature]).toEqual(secondExtra[feature])
          }
        }
        const session = () => new DocumentStore(lifecycleBaseline, coreCommandRegistry(), 200, undefined, () => ({
          kind: 'initial', schemaResolverFor: (doc) => documentResolver(doc, registry.resolve),
        }))
        const detached = session()
        expect(detached.dispatch({ command: 'occurrence.localize', params: { graphId: 'root', nodeId: 'first' } }).ok).toBe(true)
        const copyId = detached.doc.graphs.root!.nodes.first!.type.slice(1)
        expect(copyId).not.toBe(level === 1 ? 'detail' : 'portrait')
        expect((await run(detached.doc)).first).toEqual(lifecycleRun.first)
        expect(detached.dispatch({ command: 'node.setValue', params: {
          graphId: copyId, nodeId: level === 1 ? 'sample' : 'detail', inputId: 'mode.mix', value: 0.7,
        } }).ok).toBe(true)
        const edited = await run(detached.doc)
        expect(edited.first.mode.mix).toBe(0.7)
        expect(edited.second.mode.mix).toBe(0.3)
        expect(edited.first.strength).toBe(0.2)
        expect(edited.second.strength).toBe(0.8)
        expect(detached.doc.graphs[level === 1 ? 'detail' : 'portrait']).toEqual(lifecycleBaseline.graphs[level === 1 ? 'detail' : 'portrait'])
        expect(detached.undo()).toBe(true)
        expect(detached.undo()).toBe(true)
        expect((await run(detached.doc)).first).toEqual(lifecycleRun.first)

        for (const mode of ['active', 'muted', 'bypassed'] as const) {
          const flattened = session()
          if (mode !== 'active') expect(flattened.dispatch({ command: 'node.setMode', params: { graphId: 'root', nodeIds: ['first'], mode } }).ok).toBe(true)
          const document = flattened.doc
          const root = document.graphs.root!
          const node = root.nodes.first!
          const body = document.graphs[node.type.slice(1)]!
          const beforeFlatten = mode === 'bypassed' ? undefined : await run(document, path, mode !== 'muted')
          const resolve = documentResolver(document, registry.resolve)
          const plan = planFlattenBoundaryRoutes(body, resolve, node, root)
          const topology = planFlattenOccurrenceTopology(document, resolve, { instancePath: [], node: node.id })
          const topologyParams = topology.plan === undefined ? {} : {
            occurrenceTopologyPlan: topology.plan, occurrenceTopologyPlanDigest: lifecycleCanonicalHash(topology.plan),
          }
          const selectionFingerprint = lifecycleFlattenFingerprint(document, 'root', 'first', {
            boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaPlanDigest: plan.schemaPlanDigest, ...topologyParams,
          })
          const invocation = { command: 'subgraph.flatten', params: {
            graphId: 'root', instancePath: [], nodeId: 'first', placementCenter: { x: 100, y: 100 },
            resolvedGeometry: {
              occurrence: { id: 'first', kind: 'node', x: 0, y: 0, width: 200, height: 200 },
              body: Object.keys(body.nodes).map((id) => ({ id, kind: 'node', x: 0, y: 0, width: 200, height: 200 })),
            },
            boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaSnapshot: plan.schemaSnapshot,
            schemaPlanDigest: plan.schemaPlanDigest, selectionFingerprint, ...topologyParams,
          } } as unknown as CommandInvocation
          const outcome = flattened.dispatch(invocation)
          if (mode === 'bypassed') {
            expect(outcome.ok).toBe(false)
            expect(outcome.diagnostics.map((entry) => entry.code)).toContain('subgraph.flatten.modeUnsupported')
            expect(flattened.doc).toBe(document)
            continue
          }
          expect(outcome.ok, JSON.stringify(outcome.diagnostics)).toBe(true)
          const replacement = Object.values(flattened.doc.graphs.root!.nodes).find((candidate) =>
            root.nodes[candidate.id] === undefined && candidate.type === (level === 1 ? 'boundary-sample.sample' : '#detail'))!
          expect(replacement).toBeDefined()
          const replacementPath = level === 1 ? replacement.id : `${replacement.id}.sample`
          const after = await run(flattened.doc, replacementPath, mode !== 'muted')
          expect(after.second).toEqual(lifecycleRun.second)
          if (mode === 'active') {
            expect(after.first).toEqual(lifecycleRun.first)
            expect(after.value('sink', 'received')).toBe('47.0')
            expect([0, 1, 2, 3].map((index) => after.value(replacementPath, `outputs.o${index}`))).toEqual([10, 20, 30, 40])
          } else {
            expect(after.value(replacementPath, 'output91')).toBeUndefined()
            expect(after.value('sink', 'received')).toBe('null')
          }
          expect(flattened.undo()).toBe(true)
          const undone = await run(flattened.doc, path, mode !== 'muted')
          expect(undone.first).toEqual(beforeFlatten!.first)
          expect(undone.second).toEqual(lifecycleRun.second)
          expect(undone.value('sink', 'received')).toBe(beforeFlatten!.value('sink', 'received'))
          expect(flattened.redo()).toBe(true)
          const redone = await run(flattened.doc, replacementPath, mode !== 'muted')
          expect(redone.first).toEqual(after.first)
          expect(redone.second).toEqual(lifecycleRun.second)
          expect(redone.value('sink', 'received')).toBe(after.value('sink', 'received'))
        }
      }
    }, 120_000)
  }
})
