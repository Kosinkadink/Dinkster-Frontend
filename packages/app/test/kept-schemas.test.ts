import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { DINKSTER_SCHEMA_WIRE_VERSION, type ConnectionId, type DinksterNodesPayload } from '@dinkster/core'
import { KEPT_PROJECTS_PER_BACKEND, keepSchemas, keptRegistry, readKeptSchemas } from '../src/kept-schemas.js'

const INT = { kind: 'concrete', types: ['INT'] }
const kept = (wire: number): DinksterNodesPayload => ({
  schemaVersion: wire,
  epoch: 7,
  nodes: {
    'std.math.add_ints': {
      nodeType: 'std.math.add_ints', schemaVersion: wire, version: 1,
      displayName: 'Add Ints', category: 'math', description: '', idempotent: true,
      body: [
        { kind: 'input', id: 'a', required: true, type: INT },
        { kind: 'output', id: 'sum', type: INT },
      ],
    },
  },
})

describe('keptRegistry', () => {
  it('draws from a copy in this build\'s wire version but never carries its epoch', () => {
    const registry = keptRegistry('backend-1' as ConnectionId, kept(DINKSTER_SCHEMA_WIRE_VERSION))
    expect(registry?.resolve('std.math.add_ints')?.displayName).toBe('Add Ints')
    expect(registry?.epoch).toBeUndefined()
  })

  it('refuses a copy kept under another schema wire version', () => {
    expect(keptRegistry('backend-1' as ConnectionId, kept(DINKSTER_SCHEMA_WIRE_VERSION - 1))).toBeUndefined()
  })
})

describe('kept node tables', () => {
  it('keeps the most recently used projects per backend and drops the rest', async () => {
    const table = kept(DINKSTER_SCHEMA_WIRE_VERSION)
    const local = 'http://127.0.0.1:3639'
    const other = 'http://127.0.0.1:4000'
    await keepSchemas(other, 'p0', table)
    for (let index = 0; index < KEPT_PROJECTS_PER_BACKEND; index++) await keepSchemas(local, `p${index}`, table)
    // Opening p0 makes it the most recently used, so p1 is the one dropped.
    expect(await readKeptSchemas(local, 'p0')).toMatchObject(table)
    await keepSchemas(local, 'new', table)
    expect(await readKeptSchemas(local, 'p1')).toBeUndefined()
    for (const project of ['p0', 'p2', `p${KEPT_PROJECTS_PER_BACKEND - 1}`, 'new']) {
      expect(await readKeptSchemas(local, project)).toMatchObject(table)
    }
    // Another backend's projects do not count against this one.
    expect(await readKeptSchemas(other, 'p0')).toMatchObject(table)
    expect(await readKeptSchemas(local, undefined)).toBeUndefined()
  })
})
