import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  asConnectionId,
  compile,
  coreCommandRegistry,
  DocumentStore,
  documentResolver,
  lifecycleCanonicalHash,
  lifecycleFlattenFingerprint,
  loadDocument,
  planFlattenBoundaryRoutes,
  planFlattenOccurrenceTopology,
  type CommandInvocation,
  type Json,
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

      if (level > 0) {
        const lifecycleBaseline = store.doc
        const lifecycleRun = await run()
        const fanoutSource = structuredClone(lifecycleBaseline)
        const sample = fanoutSource.graphs.detail!.nodes.sample!
        Object.assign(fanoutSource.graphs.detail!.nodes, {
          extra: { ...structuredClone(sample), id: 'extra', values: {
            ...sample.values, 'mode.mix': 0.17, 'layers.layer0.strength': 0.6, 'layers.layer1.strength': 0.9,
          } },
        })
        const fanout = new DocumentStore(fanoutSource, coreCommandRegistry(), 200, undefined, () => ({
          kind: 'initial', schemaResolverFor: (doc) => documentResolver(doc, registry.resolve),
        }))
        for (const itemId of ['strength', 'mode', 'layers']) {
          const result = fanout.dispatch({ command: 'boundary.addBinding', params: {
            graphId: 'detail', itemId, node: 'extra', port: itemId,
          } })
          expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
        }
        expect(fanout.dispatch({ command: 'node.setValue', params: {
          graphId: 'root', nodeId: 'first', inputId: 'mode.mix', value: 0.84,
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
        const stable = fanout.doc
        const mismatch = fanout.dispatch({ command: 'boundary.addBinding', params: {
          graphId: 'detail', itemId: 'mode', node: 'extra', port: 'nested',
        } })
        expect(mismatch.ok).toBe(false)
        expect(fanout.doc).toBe(stable)
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
