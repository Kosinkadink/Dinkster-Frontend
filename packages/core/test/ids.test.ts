import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { asNodeId, occurrenceKey, parseOccurrenceKey } from '../src/ids.js'

describe('occurrence keys', () => {

  it('round-trips arbitrary id strings (property)', () => {
    const idArb = fc.string({ minLength: 1 }).map(asNodeId)
    fc.assert(
      fc.property(fc.array(idArb, { maxLength: 5 }), idArb, (instancePath, node) => {
        const occ = { instancePath, node }
        expect(parseOccurrenceKey(occurrenceKey(occ))).toEqual(occ)
      }),
    )
  })

  it('never emits backend-reserved characters, whatever the source ids (property)', () => {
    // The Dinkster backend bans '/', '[' and ']' in document node ids (its
    // runtime iteration-path grammar owns them) and reserves '$region'.
    // Flattened runtime ids must be safe by construction, not by validation.
    const idArb = fc.string({ minLength: 1 }).map(asNodeId)
    fc.assert(
      fc.property(fc.array(idArb, { maxLength: 5 }), idArb, (instancePath, node) => {
        const key = occurrenceKey({ instancePath, node })
        expect(key).not.toMatch(/[/[\]]/)
        expect(key).not.toBe('$region')
      }),
    )
    // Pinned adversarial ids: separators, brackets, the reserved body id.
    for (const bad of ['a/b', 'r[3]', '$region', 'x.y', '..']) {
      const key = occurrenceKey({ instancePath: [asNodeId(bad)], node: asNodeId(bad) })
      expect(key).not.toMatch(/[/[\]]/)
      expect(parseOccurrenceKey(key)).toEqual({
        instancePath: [asNodeId(bad)],
        node: asNodeId(bad),
      })
    }
  })
})
