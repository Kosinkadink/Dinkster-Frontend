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
  type FormulaValues,
  type Unknown,
} from '../src/mirror/formula.js'

// The engine checks the same file (Dinkster tests/fixtures/formula_v1.json),
// so a formula gives the same answer in the editor and when a run is submitted.
const VECTORS_SHA256 = '01491d32e4dd0d17ce33c2914b282e13a54fa89706b0b9cb1e87a4a924a68011'
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
    readonly in_on_edit?: boolean
  }
  readonly values?: EncodedValues
}

interface EncodedValues {
  readonly values?: Readonly<Record<string, Encoded | 'unknown'>>
  readonly linked?: Readonly<Record<string, boolean>>
  readonly linked_types?: Readonly<Record<string, string | null>>
  readonly group_sizes?: Readonly<Record<string, number>>
  readonly member_index?: number | null
  readonly member_key?: string | null
  readonly facts?: readonly (readonly [string, string, Encoded])[]
  readonly previous?: EncodedValues
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

function valuesOf(data: EncodedValues): FormulaValues {
  return {
    values: new Map<string, FormulaValue | Unknown>(
      Object.entries(data.values ?? {}).map(([name, value]) => [
        name,
        value === 'unknown' ? UNKNOWN : (decode(value) as FormulaValue),
      ]),
    ),
    linked: new Map(Object.entries(data.linked ?? {})),
    linkedTypes: new Map(Object.entries(data.linked_types ?? {})),
    groupSizes: new Map(Object.entries(data.group_sizes ?? {})),
    memberIndex: data.member_index ?? null,
    memberKey: data.member_key ?? null,
    facts: new Map((data.facts ?? []).map(([fact, name, value]) => [`${fact}(${name})`, decode(value) as FormulaValue])),
    ...(data.previous !== undefined ? { previous: valuesOf(data.previous) } : {}),
  }
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
    inOnEdit: scopeData.in_on_edit ?? false,
  }
  const values = valuesOf(testCase.values ?? {})
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

  it('names a refused character by code point and character position', () => {
    const scope = { names: new Map() }
    // A no-break space looks like a space to the author.
    expect(() => Formula.parse('1 +\u00a02', scope)).toThrow(/U\+00A0 at position 4/)
    // Positions count characters, so a character outside the Basic Multilingual Plane is one.
    expect(() => Formula.parse("'\u{1f600}' +\r1", scope)).toThrow(/U\+000D at position 6/)
    expect(() => Formula.parse("'\u{1f600}' +\u00e91", scope)).toThrow(/U\+00E9 at position 6/)
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
