import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coverageRow, renderCoverage } from './comfy-subgraph-coverage.mjs'

test('keeps backend alias blockers distinct from a successful subgraph import', () => {
  const row = coverageRow('example.json', { nodes: [], links: [], definitions: { subgraphs: [
    { id: 'inner', nodes: [], inputs: [], outputs: [], links: [] },
  ] } }, { subgraphCount: 1, statusCounts: { quarantine: 2 }, translationReady: false }, () => undefined)
  assert.equal(row['subgraph-import'], 'definitions')
  assert.equal(row['backend-alias'], 'missing-backend-alias')
  assert.equal(row.imported, true)
  assert.equal(row.baselineSubgraphCount, 1)
  const markdown = renderCoverage({ inputs: { templateRevision: 'current', backendTemplateRevision: 'baseline', schemaSource: 'none' },
    summary: { imported: 1, workflows: 1, subgraphsImported: 1, subgraphWorkflows: 1 }, workflows: [row] })
  assert.match(markdown, /\| subgraph-import \| backend-alias \|/)
  assert.match(markdown, /\| definitions \| missing-backend-alias \|/)
})

test('reports malformed imports and missing backend census entries honestly', () => {
  const row = coverageRow('new.json', { nodes: [], definitions: { subgraphs: [{ id: 'broken' }] } }, undefined, () => undefined)
  assert.equal(row['subgraph-import'], 'blocked')
  assert.equal(row['backend-alias'], 'not-in-backend-report')
  assert.equal(row.imported, false)
})
