import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { coverageRow, renderCoverage } from './comfy-subgraph-coverage.mjs'

test('reports a structurally retained subgraph separately from missing native schemas', () => {
  const row = coverageRow('example.json', { nodes: [], links: [], definitions: { subgraphs: [
    { id: 'inner', nodes: [{ id: 1, type: 'MissingNative', widgets_values: [7] }], inputs: [], outputs: [], links: [] },
  ] } }, () => undefined)
  assert.equal(row['subgraph-import'], 'definitions')
  assert.equal(row.missingSchemas, 1)
  assert.equal(row.imported, true)
  assert.equal(row.errorFree, false)
  const markdown = renderCoverage({ inputs: { templateRevision: 'current', schemaSource: 'nodes.json' },
    summary: { imported: 1, errorFree: 0, workflows: 1, subgraphsImported: 1, subgraphWorkflows: 1 }, workflows: [row] })
  assert.match(markdown, /\| subgraph-import \| Missing schemas \| Unresolved \| Errors \|/)
  assert.match(markdown, /Error-free imports: 0\/1/)
  assert.match(markdown, /\| definitions \| 1 \|/)
})

test('reports malformed imports as blocked even without missing schemas', () => {
  const row = coverageRow('new.json', { nodes: [], definitions: { subgraphs: [{ id: 'broken' }] } }, () => undefined)
  assert.equal(row['subgraph-import'], 'blocked')
  assert.equal(row.missingSchemas, 0)
  assert.ok(row.errors > 0)
  assert.equal(row.imported, false)
  assert.equal(row.errorFree, false)
})

test('accepts exact ordinary schemas without rewriting authored classes', () => {
  const schema = { type: 'NativeOutput', displayName: 'Output', category: 'test', source: 'v3', isOutputNode: true, items: [] }
  const row = coverageRow('native.json', { nodes: [{ id: 1, type: 'NativeOutput' }], links: [] }, (type) => type === schema.type ? schema : undefined)
  assert.equal(row['subgraph-import'], 'not-needed')
  assert.equal(row.missingSchemas, 0)
  assert.equal(row.errors, 0)
  assert.equal(row.errorFree, true)
})

test('does not certify unresolved boundaries when all node schemas are present', () => {
  const schema = { type: 'NativeOutput', displayName: 'Output', category: 'test', source: 'v3', isOutputNode: true, items: [] }
  const row = coverageRow('boundary.json', { nodes: [], links: [], definitions: { subgraphs: [{
    id: 'inner', nodes: [{ id: 1, type: 'NativeOutput', inputs: [{ name: 'missing', link: 1 }] }],
    inputs: [{ id: 'input', type: 'INT', linkIds: [1] }], outputs: [],
    links: [[1, -10, 0, 1, 0, 'INT']],
  }] } }, (type) => type === schema.type ? schema : undefined)
  assert.equal(row.imported, true)
  assert.equal(row.missingSchemas, 0)
  assert.equal(row.errors, 0)
  assert.ok(row.diagnostics.includes('import.subgraphs.boundaryUnresolved'))
  assert.equal(row.unresolved, 1)
  assert.equal(row.errorFree, false)
})

test('rejects an invalid native catalog before scanning templates', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-coverage-'))
  try {
    const nodes = join(directory, 'nodes.json')
    writeFileSync(nodes, JSON.stringify({ schemaVersion: 999, nodes: {} }))
    const child = spawnSync(process.execPath, ['--import', 'tsx',
      fileURLToPath(new URL('./comfy-subgraph-coverage.mjs', import.meta.url)),
      '--templates', join(directory, 'absent'), '--nodes', nodes,
    ], { encoding: 'utf8' })
    assert.equal(child.status, 1)
    assert.match(child.stderr, /Invalid native catalog/)
    assert.match(child.stderr, /schema.dinkster.wireVersion/)
    assert.doesNotMatch(child.stderr, /not a git repository/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
