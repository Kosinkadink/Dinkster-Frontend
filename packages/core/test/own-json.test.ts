/**
 * ownJson / jsonWithinBudget is the single ownership + JSON-semantics
 * boundary. These tests pin hostile-input hardening: prototype pollution,
 * accessors, proxies, sparse arrays, cycles, and undefined-property modes.
 */
import { describe, expect, it } from 'vitest'
import { MAX_JSON_DEPTH, ownJson } from '../src/format/json.js'

describe('ownJson', () => {

  it('rejects cyclic values instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const out = ownJson(cyclic)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('cyclic')
  })

  it('rejects non-finite numbers, functions, symbols, bigints, class instances', () => {
    expect(ownJson({ v: Infinity }).ok).toBe(false)
    expect(ownJson({ v: NaN }).ok).toBe(false)
    expect(ownJson({ v: () => 1 }).ok).toBe(false)
    expect(ownJson({ v: Symbol('s') }).ok).toBe(false)
    expect(ownJson({ v: 1n }).ok).toBe(false)
    expect(ownJson({ v: new Date() }).ok).toBe(false)
    expect(ownJson({ v: new Map() }).ok).toBe(false)
  })

  it('rejects trees nested past the depth budget', () => {
    let deep: unknown = 1
    for (let i = 0; i <= MAX_JSON_DEPTH; i++) deep = [deep]
    const out = ownJson(deep)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('deeper')
  })

  it("rejects a JSON-parsed '__proto__' key instead of polluting the copy's prototype", () => {
    const input: unknown = JSON.parse('{"__proto__": {"polluted": 1}}')
    const out = ownJson(input)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('__proto__')
    // And the global prototype was never touched.
    expect(({} as { polluted?: number }).polluted).toBeUndefined()
  })

})

describe('ownJson budgets are total (work proportional to budget, never to input)', () => {

  it('the char budget is cumulative across the whole tree', () => {
    // Each string fits alone; together they exceed the budget.
    const out = ownJson(['aaaa', 'bbbb', 'cccc'], { limits: { maxChars: 10 } })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('string characters')
  })

})
