import { describe, expect, it } from 'vitest'
import { DINKSTER_SCHEMA_WIRE_VERSION, type ConnectionId, type DinksterNodesPayload } from '@dinkster/core'
import { keptRegistry } from '../src/kept-schemas.js'

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
