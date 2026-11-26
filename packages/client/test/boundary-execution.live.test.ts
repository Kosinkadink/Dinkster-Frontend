import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  asConnectionId,
  compile,
  coreCommandRegistry,
  DocumentStore,
  documentResolver,
  loadDocument,
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
      const run = async (document: WorkflowDocument = store.doc) => {
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
              first: await receipt(path),
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
    }, 120_000)
  }
})
