import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile/compile.js'
import type { JsonObject } from '../src/format/document.js'
import { importLitegraph } from '../src/format/import-litegraph.js'
import { asConnectionId } from '../src/ids.js'

const officialFixtureHashes = {
  'video_minimax_h3_t2v.json': 'aeadcae30ac27d8f3bedebada670ddbc5af03efc69ec2312cc859efbf660ff45',
  'video_minimax_h3_i2v.json': 'cb269e456bc741e659919cb92019fcc9a605476af1d23868b33fa740e75a9db8',
  'video_minimax_h3_r2v.json': '466802086b46da86aaba5afe73e72f7d18dcc46f5ab79b6fad966131b840ccd8',
  'video_minimax_h3_multiframe_reference.json': '343de410ba8dda40553db5da3021b78d9b6e22a33e32f848bac41acce20a1db5',
}
const workflowTemplatesRevision = 'fc427f00097817d3f7d8099c5259837fa51e1267'

interface SourceGraph {
  readonly nodes: readonly { readonly id: number; readonly type: string }[]
}

describe('official MiniMax H3 workflows', () => {
  it.each(Object.entries(officialFixtureHashes))('preserves authored classes in %s without replacement catalogs', (name, hash) => {
    const text = readFileSync(new URL(`../fixtures/workflows/minimax-h3/${name}`, import.meta.url), 'utf8')
    expect(createHash('sha256').update(text).digest('hex'), workflowTemplatesRevision).toBe(hash)
    const workflow = JSON.parse(text) as JsonObject & SourceGraph & {
      readonly definitions?: { readonly subgraphs: readonly (SourceGraph & { readonly id: string })[] }
    }
    const resolve = () => undefined
    const imported = importLitegraph(workflow, resolve)
    expect(imported.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    const document = imported.document!
    const subgraphs = workflow.definitions?.subgraphs ?? []
    const subgraphIds = new Set(subgraphs.map((graph) => graph.id))
    for (const [graphId, source] of [[document.root, workflow], ...subgraphs.map((graph) => [graph.id, graph] as const)] as const) {
      const graph = document.graphs[graphId]!
      const materialized = source.nodes.filter((node) => !['PrimitiveNode', 'Reroute'].includes(node.type))
      expect(Object.keys(graph.nodes)).toEqual(materialized.map((node) => `n${node.id}`))
      for (const node of materialized.filter((node) => !['Note', 'MarkdownNote'].includes(node.type))) {
        expect(graph.nodes[`n${node.id}`]!.type).toBe(subgraphIds.has(node.type) ? `#${node.type}` : node.type)
      }
    }
    const compiled = compile({ document, revision: 0, resolve, scope: { kind: 'full' }, connection: asConnectionId('minimax-source'), schemaHash: 'empty' })
    expect(compiled.ok).toBe(false)
    if (compiled.ok) throw new Error('Unregistered authored classes must not compile')
    expect(compiled.diagnostics.some((item) => item.code === 'compile.schema.unknown')).toBe(true)
  })
})
