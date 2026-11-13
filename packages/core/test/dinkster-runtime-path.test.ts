import { describe, expect, it } from 'vitest'
import { parseDinksterRuntimePath } from '../src/events/dinkster.js'

// Closed grammar from Dinkster DESIGN 3.13 (backend commit 95106fd):
//   path    = segment ("/" segment)*
//   segment = nodeId | nodeId "[" decimal-index "]"
// Node ids can never contain '/', '[' or ']' (banned at wire decode and
// validation), so parsing is mechanical.

describe('parseDinksterRuntimePath', () => {
  it('parses nested iteration paths', () => {
    expect(parseDinksterRuntimePath('outer[0]/inner[2]/node')).toEqual([
      { nodeId: 'outer', iteration: 0 },
      { nodeId: 'inner', iteration: 2 },
      { nodeId: 'node' },
    ])
    expect(parseDinksterRuntimePath('r[3]/node')).toEqual([
      { nodeId: 'r', iteration: 3 },
      { nodeId: 'node' },
    ])
  })
})
