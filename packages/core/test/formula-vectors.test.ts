import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  FORMULA_LANGUAGE_VERSION,
  Formula,
  FormulaRefused,
  FormulaTable,
  UNKNOWN,
  type FormulaNameKind,
  type FormulaScalar,
  type FormulaTableValue,
  type FormulaValue,
  type Unknown,
} from '../src/mirror/formula.js'

// The engine checks the same file (Dinkster tests/fixtures/formula_v1.json),
// so a formula gives the same answer in the editor and when a run is submitted.
const VECTORS_SHA256 = 'a50e41758bc77c607b6e01c30511264d325fb8e2a5a6a2536dd288b4a8a69ca6'
const vectorBytes = readFileSync(new URL('./fixtures/formula_v1.json', import.meta.url))

type Encoded = Readonly<Record<string, unknown>>

interface VectorCase {
  readonly id: string
  readonly formula: string
  readonly outcome: 'value' | 'unknown' | 'failed' | 'refused'
  readonly value?: Encoded
  readonly scope?: {
    readonly names?: Readonly<Record<string, FormulaNameKind>>
    readonly inputs?: readonly string[]
    readonly assets?: readonly string[]
    readonly tables?: Readonly<Record<string, Encoded>>
    readonly derived?: Readonly<Record<string, string>>
    readonly in_member?: boolean
  }
  readonly values?: {
    readonly values?: Readonly<Record<string, Encoded | 'unknown'>>
    readonly linked?: Readonly<Record<string, boolean>>
    readonly linked_types?: Readonly<Record<string, string | null>>
    readonly group_sizes?: Readonly<Record<string, number>>
    readonly member_index?: number | null
    readonly member_key?: string | null
    readonly facts?: readonly (readonly [string, string, Encoded])[]
  }
}

function decode(data: Encoded): FormulaTableValue {
  const [[tag, body]] = Object.entries(data) as [[string, unknown]]
  switch (tag) {
    case 'none':
      return null
    case 'bool':
      return body as boolean
    case 'int': {
      const hex = body as string
      return hex.startsWith('-') ? -BigInt(hex.slice(1)) : BigInt(hex)
    }
    case 'float': {
      const view = new DataView(new ArrayBuffer(8))
      view.setBigUint64(0, BigInt(`0x${body as string}`))
      return view.getFloat64(0)
    }
    case 'text':
      return body as string
    case 'list':
      return Object.freeze((body as Encoded[]).map((item) => decode(item) as FormulaScalar))
    case 'table':
      return new FormulaTable(
        (body as [Encoded, Encoded][]).map(([key, value]) => [decode(key) as string | bigint, decode(value)]),
      )
  }
  throw new Error(`bad encoding ${JSON.stringify(data)}`)
}

/** Equal in value and type, floats bit for bit. */
function same(actual: FormulaValue, expected: FormulaTableValue): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      actual.every((item: FormulaScalar, index) => same(item, expected[index]!))
    )
  }
  if (typeof actual !== typeof expected || Array.isArray(actual)) return false
  return Object.is(actual, expected)
}

function show(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? `${item}n` : item))
}

function run(testCase: VectorCase): string | undefined {
  const scopeData = testCase.scope ?? {}
  const scope = {
    names: new Map(Object.entries(scopeData.names ?? {})),
    inputs: new Set(scopeData.inputs ?? []),
    assets: new Set(scopeData.assets ?? []),
    tables: new Map(Object.entries(scopeData.tables ?? {}).map(([name, table]) => [name, decode(table)])),
    derived: new Map(Object.entries(scopeData.derived ?? {})),
    inMember: scopeData.in_member ?? false,
  }
  const valuesData = testCase.values ?? {}
  const values = {
    values: new Map<string, FormulaValue | Unknown>(
      Object.entries(valuesData.values ?? {}).map(([name, value]) => [
        name,
        value === 'unknown' ? UNKNOWN : (decode(value) as FormulaValue),
      ]),
    ),
    linked: new Map(Object.entries(valuesData.linked ?? {})),
    linkedTypes: new Map(Object.entries(valuesData.linked_types ?? {})),
    groupSizes: new Map(Object.entries(valuesData.group_sizes ?? {})),
    memberIndex: valuesData.member_index ?? null,
    memberKey: valuesData.member_key ?? null,
    facts: new Map(
      (valuesData.facts ?? []).map(([fact, name, value]) => [`${fact}(${name})`, decode(value) as FormulaValue]),
    ),
  }
  const expected = testCase.outcome
  let formula: Formula
  try {
    formula = Formula.parse(testCase.formula, scope)
  } catch (error) {
    if (!(error instanceof FormulaRefused)) return `threw ${String(error)}`
    return expected === 'refused' ? undefined : `refused (${error.message}), expected ${expected}`
  }
  if (expected === 'refused') return 'accepted, expected refused'
  const result = formula.evaluate(values)
  if (result.kind === 'unknown') return expected === 'unknown' ? undefined : `unknown, expected ${expected}`
  if (result.kind === 'failed') {
    return expected === 'failed' ? undefined : `failed (${result.reason}), expected ${expected}`
  }
  if (expected !== 'value') return `value ${show(result.value)}, expected ${expected}`
  const wanted = decode(testCase.value!)
  return same(result.value, wanted) ? undefined : `value ${show(result.value)}, expected ${show(wanted)}`
}

describe('formula vector file', () => {
  it('is the file the engine checks, for this language version', () => {
    expect(createHash('sha256').update(vectorBytes).digest('hex')).toBe(VECTORS_SHA256)
    expect((JSON.parse(vectorBytes.toString('ascii')) as { language: number }).language).toBe(
      FORMULA_LANGUAGE_VERSION,
    )
  })

  it('gives every answer the engine gives', () => {
    const cases = (JSON.parse(vectorBytes.toString('ascii')) as { cases: VectorCase[] }).cases
    expect(cases.length).toBeGreaterThan(5000)
    const mismatches = cases.flatMap((testCase) => {
      const problem = run(testCase)
      return problem === undefined ? [] : [`${testCase.id} ${JSON.stringify(testCase.formula)}: ${problem}`]
    })
    expect(mismatches.slice(0, 50).join('\n')).toBe('')
    expect(mismatches).toHaveLength(0)
  })
})
