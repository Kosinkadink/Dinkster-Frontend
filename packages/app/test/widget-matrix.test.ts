import { describe, expect, it } from 'vitest'
import {
  asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId, coreCommandRegistry, DocumentStore, loadDocument,
  type Json, type WorkflowDocument,
} from '@dinkster/core'

const asset = { digest: `blake3:${'b'.repeat(64)}`, name: 'dog.png', size: 21, mediaType: 'image/png', virtualPath: 'input/dog.png' }
const values: Array<[string, Json]> = [
  ['INT', 7], ['FLOAT', 1.5], ['STRING line', 'one'], ['STRING text', 'one\ntwo'],
  ['BOOLEAN', true], ['COMBO static', 'euler'], ['COMBO remote', 'server-model'],
  ['COMBO static plus remote', 'fresh-model'], ['COLOR', '#12345678'], ['ASSET', asset],
  ['SAVE_TARGET', { mount: 'output', prefix: 'jobs/dog' }],
]

const document = (): WorkflowDocument => ({
  format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('widget-matrix'), root: asGraphDefId('g0'),
  graphs: { g0: { id: asGraphDefId('g0'), name: 'widgets', nodes: {
    n0: { id: asNodeId('n0'), type: 'WidgetNode', values: { value_key: 'before' } },
  }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
  view: { graphs: {} },
})

describe.each(values)('%s document value matrix', (_kind, value) => {
  it('writes under valueKey and undo/redo restores the exact value', () => {
    const store = new DocumentStore(document(), coreCommandRegistry())
    expect(store.dispatch({ command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'n0', inputId: 'value_key', value,
    } }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n0!.values.value_key).toEqual(value)
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n0!.values.value_key).toBe('before')
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n0!.values.value_key).toEqual(value)
  })

  it('survives JSON save and load without changing the value', () => {
    // Write through the REAL command path, then round-trip what the store
    // actually holds: a broken node.setValue cannot hide behind a manually
    // manufactured document.
    const store = new DocumentStore(document(), coreCommandRegistry())
    expect(store.dispatch({ command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'n0', inputId: 'value_key', value,
    } }).ok).toBe(true)
    const loaded = loadDocument(JSON.parse(JSON.stringify(store.doc)))
    expect(loaded.document, JSON.stringify(loaded.diagnostics)).toBeDefined()
    expect(loaded.document!.graphs.g0!.nodes.n0!.values.value_key).toEqual(value)
  })
})

it('SAVE_TARGET dormant value and concrete producer link survive save and reopen together', () => {
  const doc = document()
  const graph = doc.graphs.g0!
  ;(graph.nodes as Record<string, typeof graph.nodes[string]>)['producer'] = {
    id: asNodeId('producer'),
    type: 'SaveTargetProducer',
    values: {},
  }
  ;(graph.nodes.n0!.values as Record<string, Json>)['value_key'] = { mount: 'output', prefix: 'jobs/cat' }
  ;(graph.links as Record<string, typeof graph.links[string]>)['target-link'] = {
    id: asLinkId('target-link'),
    from: { node: asNodeId('producer'), port: asPortId('target') },
    to: { node: asNodeId('n0'), port: asPortId('value_key') },
  }

  const loaded = loadDocument(JSON.parse(JSON.stringify(doc)))
  expect(loaded.document, JSON.stringify(loaded.diagnostics)).toBeDefined()
  expect(loaded.document!.graphs.g0!.nodes.n0!.values.value_key).toEqual({ mount: 'output', prefix: 'jobs/cat' })
  expect(loaded.document!.graphs.g0!.links['target-link']).toEqual({
    id: 'target-link',
    from: { node: 'producer', port: 'target' },
    to: { node: 'n0', port: 'value_key' },
  })
})
