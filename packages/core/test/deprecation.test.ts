/**
 * Deprecation pointer-chain resolution. Pointers are name-only display
 * hints that CHAIN (A -> B -> C when B is itself deprecated); the UI must
 * steer to the TERMINAL type, degrade gracefully on dangling pointers
 * (packs load independently), and never loop on cross-pack cycles.
 */
import { describe, expect, it } from 'vitest'
import { resolveDeprecationPointer, type DeprecationInfo, type NodeSchema } from '../src/index.js'

const schema = (type: string, deprecation?: DeprecationInfo): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  items: [],
  isOutputNode: false,
  ...(deprecation !== undefined ? { deprecation } : {}),
})

const registry = (...schemas: NodeSchema[]) => {
  const map = new Map(schemas.map((s) => [s.type, s]))
  return (type: string) => map.get(type)
}

const deprecated = (type: string, replacement: string): NodeSchema =>
  schema(type, { message: `use ${replacement}`, replacement })

describe('resolveDeprecationPointer', () => {

  it('resolves a direct terminal A -> B', () => {
    const r = resolveDeprecationPointer(deprecated('a', 'b'), registry(schema('b')))
    expect(r).toEqual({ terminal: 'b', path: ['b'], status: 'ok' })
  })

  it('resolves transitively to the terminal: A -> B -> C', () => {
    const r = resolveDeprecationPointer(
      deprecated('a', 'b'),
      registry(deprecated('b', 'c'), schema('c')),
    )
    expect(r).toEqual({ terminal: 'c', path: ['b', 'c'], status: 'ok' })
  })

  it('a dangling target reports the last named type', () => {
    const r = resolveDeprecationPointer(
      deprecated('a', 'b'),
      registry(deprecated('b', 'ghost.pack.node')),
    )
    expect(r).toEqual({ terminal: 'ghost.pack.node', path: ['b', 'ghost.pack.node'], status: 'dangling' })
  })

  it('a cycle back to the origin stops without looping', () => {
    const r = resolveDeprecationPointer(
      deprecated('a', 'b'),
      registry(deprecated('b', 'a'), deprecated('a', 'b')),
    )
    expect(r).toEqual({ terminal: 'a', path: ['b'], status: 'cycle' })
  })

})
