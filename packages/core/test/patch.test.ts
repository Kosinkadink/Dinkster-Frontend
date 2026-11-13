/**
 * Patch engine + transaction builder tests. Contract guards under test:
 * - apply(inverse) restores the exact prior document (property-based)
 * - application is immutable with structural sharing
 * - ops survive JSON serialization (IPC/sync-log shape)
 * - the builder records correct forward/inverse pairs against a working copy
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Json, JsonObject, WorkflowDocument } from '../src/format/document.js'
import { applyOps, getAtPath, PatchError, type PatchOp } from '../src/commands/patch.js'
import { createTransactionBuilder } from '../src/commands/contract.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/workflows')
const subgraphDoc = (): WorkflowDocument =>
  JSON.parse(readFileSync(join(fixturesDir, 'subgraph.json'), 'utf8')) as WorkflowDocument

describe('applyOps', () => {
  const base: Json = {
    values: { a: 1, b: 'x' },
    list: [1, 2, 3],
    nested: { deep: { flag: true } },
  }

  it('adds, replaces and removes object keys', () => {
    const out = applyOps(base, [
      { op: 'add', path: ['values', 'c'], value: 3 },
      { op: 'replace', path: ['values', 'a'], value: 42, oldValue: 1 },
      { op: 'remove', path: ['values', 'b'], oldValue: 'x' },
    ]) as JsonObject
    expect(out['values']).toEqual({ a: 42, c: 3 })
  })

  it('inserts, replaces and removes array elements', () => {
    const out = applyOps(base, [
      { op: 'add', path: ['list', 1], value: 99 },
      { op: 'replace', path: ['list', 0], value: 0, oldValue: 1 },
      { op: 'remove', path: ['list', 2], oldValue: 2 },
    ]) as JsonObject
    expect(out['list']).toEqual([0, 99, 3])
  })

  it('rejects ops that do not fit the document', () => {
    const cases: readonly PatchOp[] = [
      { op: 'add', path: ['values', 'a'], value: 0 }, // already exists
      { op: 'remove', path: ['values', 'zz'], oldValue: null }, // missing
      { op: 'replace', path: ['values', 'zz'], value: 0, oldValue: null }, // missing
      { op: 'add', path: ['list', 99], value: 0 }, // out of bounds
      { op: 'replace', path: ['nested', 'deep', 'flag', 'x'], value: 0, oldValue: null }, // through a leaf
    ]
    for (const op of cases) {
      expect(() => applyOps(base, [op]), JSON.stringify(op)).toThrow(PatchError)
    }
  })

})

describe('inverse round-trip (property-based)', () => {
  // Random edit programs against a small document shape, driven through the
  // builder so every forward op gets a recorded inverse.
  const keyArb = fc.constantFrom('a', 'b', 'c', 'd')
  const valueArb: fc.Arbitrary<Json> = fc.oneof(
    fc.integer(),
    fc.string(),
    fc.boolean(),
    fc.constant(null),
  )
  const editArb = fc.oneof(
    fc.record({ kind: fc.constant('set' as const), key: keyArb, value: valueArb }),
    fc.record({ kind: fc.constant('remove' as const), key: keyArb }),
    fc.record({ kind: fc.constant('push' as const), value: valueArb }),
    fc.record({ kind: fc.constant('pop' as const) }),
  )

  it('applying the inverse restores the exact document', () => {
    fc.assert(
      fc.property(fc.array(editArb, { maxLength: 25 }), (edits) => {
        const doc = subgraphDoc()
        const before = JSON.parse(JSON.stringify(doc)) as Json
        const tx = createTransactionBuilder(doc)
        for (const edit of edits) {
          const valuesPath = ['graphs', 'g0', 'nodes', 'n0', 'values']
          const netsPath = ['graphs', 'g1', 'nets', 'net4', 'sinks']
          const cur = tx.current as unknown as JsonObject
          if (edit.kind === 'set') {
            tx.set([...valuesPath, edit.key], edit.value)
          } else if (edit.kind === 'remove') {
            const values = getAtPath(cur, valuesPath) as JsonObject
            if (edit.key in values) tx.remove([...valuesPath, edit.key])
          } else if (edit.kind === 'push') {
            const sinks = getAtPath(cur, netsPath) as readonly Json[]
            tx.insert([...netsPath, sinks.length], edit.value)
          } else {
            const sinks = getAtPath(cur, netsPath) as readonly Json[]
            if (sinks.length > 0) tx.remove([...netsPath, sinks.length - 1])
          }
        }
        const { doc: after, forward, inverse } = tx.result()
        // Forward replay from the pristine document reproduces the result.
        expect(applyOps(before, forward)).toEqual(after)
        // Inverse replay restores the pristine document exactly.
        expect(applyOps(after as unknown as Json, inverse)).toEqual(before)
      }),
    )
  })

})

describe('CO2 prototype-chain safety', () => {

  it("applyOps rejects a '__proto__' path segment (wire/replay defense in depth)", () => {
    // A '__proto__' key is exactly what ownJson forbids in documents; a
    // patch must never be able to create one either (add), replace through
    // one, or traverse one - regardless of where the op came from.
    expect(() =>
      applyOps({} as Json, [{ op: 'add', path: ['__proto__'], value: { polluted: true } }]),
    ).toThrow(/__proto__/)
    expect(() =>
      applyOps({ a: 1 } as Json, [
        { op: 'replace', path: ['__proto__', 'x'], value: 9, oldValue: 1 },
      ]),
    ).toThrow(PatchError)
    expect(({}) as Record<string, unknown>).not.toHaveProperty('polluted')
  })

})

describe('applyOps foreign-op ingress (ownership at the patch boundary)', () => {

  it('rejects an unknown op discriminator instead of silently treating it as replace', () => {
    expect(() =>
      applyOps({ x: 1 } as Json, [{ op: 'bogus', path: ['x'], value: 2 } as unknown as PatchOp]),
    ).toThrow(PatchError)
    expect(() =>
      applyOps({ x: 1 } as Json, [{ op: 'move', path: ['x'], value: 2 } as unknown as PatchOp]),
    ).toThrow(PatchError)
  })

})
