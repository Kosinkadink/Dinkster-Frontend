
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  countExpressionNodes,
  evaluateExpression,
  ExpressionMirrorError,
  MAX_EXPRESSION_LENGTH,
  MAX_EXPRESSION_NODES,
  MAX_VECTOR_LENGTH,
  validateExpressionText,
  type ExpressionScalar,
  type ExpressionValue,
} from '../src/mirror/expression.js'

const fixtureText = readFileSync(
  new URL('./fixtures/math_expression_v1.json', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n')

interface CorpusCase {
  readonly id: string
  readonly mirror_class: 'exact' | 'bounded'
  readonly expression: string
  readonly inputs: Readonly<Record<string, unknown>>
  readonly outputs: Readonly<Record<string, unknown>>
  readonly float_bits: string | readonly string[]
  readonly int_strings?: string | readonly string[]
}

interface Corpus {
  readonly format_version: number
  readonly grammar_version: number
  readonly mirror_relative_tolerance: number
  readonly cases: readonly CorpusCase[]
}

/**
 * JSON.parse with source access: an integer-literal source becomes a bigint
 * (Python int), anything with a decimal point or exponent stays a number
 * (Python float). Plain JSON.parse would collapse 3.0 to the int 3.
 */
function parseTyped(text: string): Corpus {
  return JSON.parse(text, function reviver(_key, value, context?: { source?: string }) {
    if (typeof value === 'number' && context?.source !== undefined && /^-?[0-9]+$/.test(context.source)) {
      return BigInt(context.source)
    }
    return value
  }) as Corpus
}

const corpus = parseTyped(fixtureText)

function doubleFromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8))
  view.setBigUint64(0, BigInt(`0x${hex}`))
  return view.getFloat64(0)
}

function asScalar(value: unknown): ExpressionScalar {
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  throw new Error(`unexpected corpus scalar: ${String(value)}`)
}

function asValue(value: unknown): ExpressionValue {
  if (Array.isArray(value)) return value.map(asScalar)
  return asScalar(value)
}

function expectedInts(testCase: CorpusCase): bigint[] {
  const raw = testCase.int_strings ?? testCase.outputs['ints'] ?? testCase.outputs['int']
  const items = Array.isArray(raw) ? raw : [raw]
  return items.map((item) => (typeof item === 'string' ? BigInt(item) : (item as bigint)))
}

describe('math expression parity corpus', () => {

  for (const testCase of corpus.cases) {
    it(`${testCase.id} (${testCase.mirror_class})`, () => {
      const inputs = new Map(
        Object.entries(testCase.inputs).map(([name, value]) => [name, asValue(value)]),
      )
      const result = evaluateExpression(testCase.expression, inputs)
      const bits = Array.isArray(testCase.float_bits) ? testCase.float_bits : [testCase.float_bits]
      const expectedFloats = bits.map(doubleFromBits)
      const ints = expectedInts(testCase)
      const rawBooleans = testCase.outputs['booleans'] ?? testCase.outputs['boolean']
      const booleans = (Array.isArray(rawBooleans) ? rawBooleans : [rawBooleans]) as boolean[]

      const actualFloats = result.kind === 'vector' ? result.floats : [result.float]
      const actualInts = result.kind === 'vector' ? result.ints : [result.int]
      const actualBooleans = result.kind === 'vector' ? result.booleans : [result.boolean]

      expect(result.kind).toBe('floats' in testCase.outputs ? 'vector' : 'scalar')
      expect(actualFloats.length).toBe(expectedFloats.length)
      for (let index = 0; index < expectedFloats.length; index += 1) {
        const expected = expectedFloats[index]!
        const actual = actualFloats[index]!
        if (testCase.mirror_class === 'exact') {
          expect(Object.is(actual, expected), `float[${index}] bits differ: ${actual} vs ${expected}`).toBe(true)
        } else {
          const bound = corpus.mirror_relative_tolerance * Math.max(Math.abs(expected), Number.MIN_VALUE)
          expect(Math.abs(actual - expected)).toBeLessThanOrEqual(bound)
        }
      }
      expect(actualInts).toEqual(ints)
      expect(actualBooleans).toEqual(booleans)
    })
  }
})

function scalar(expression: string, inputs: Record<string, ExpressionValue> = {}) {
  const result = evaluateExpression(expression, new Map(Object.entries(inputs)))
  if (result.kind !== 'scalar') throw new Error('expected a scalar result')
  return result
}

function rejects(expression: string, inputs: Record<string, ExpressionValue> = {}): void {
  expect(() => evaluateExpression(expression, new Map(Object.entries(inputs)))).toThrow(
    ExpressionMirrorError,
  )
}

describe('Python numeric semantics', () => {
  it('keeps int arithmetic exact beyond double precision', () => {
    expect(scalar('a * a + 1', { a: 94906265n }).int).toBe(94906265n * 94906265n + 1n)
  })

  it('treats bools as ints in arithmetic', () => {
    expect(scalar('a + a', { a: true }).int).toBe(2n)
    expect(scalar('a * 2.5', { a: true }).float).toBe(2.5)
    expect(scalar('-a', { a: true }).int).toBe(-1n)
  })

  it('rejects bool operands for shifts, bitwise operators, and inversion', () => {
    rejects('a << 1', { a: true })
    rejects('1 << a', { a: true })
    rejects('a | 1', { a: true })
    rejects('~a', { a: true })
    rejects('values[a]', { a: true, b: 1n })
  })

  it('floors integer division and follows the divisor sign for modulo', () => {
    expect(scalar('a // b', { a: -7n, b: 3n }).int).toBe(-3n)
    expect(scalar('a % b', { a: -7n, b: 3n }).int).toBe(2n)
    expect(scalar('a % b', { a: 7n, b: -3n }).int).toBe(-2n)
    expect(scalar('a % b', { a: -7.5, b: 3.0 }).float).toBe(1.5)
    expect(scalar('a % b', { a: 7.5, b: -3.0 }).float).toBe(-1.5)
  })

  it('compares ints to floats exactly, not through double conversion', () => {
    expect(scalar('a == b', { a: 9007199254740993n, b: 9007199254740992.0 }).boolean).toBe(false)
    expect(scalar('a > b', { a: 9007199254740993n, b: 9007199254740992.0 }).boolean).toBe(true)
    expect(scalar('a == b', { a: 10n ** 400n, b: 1.5 }).boolean).toBe(false)
    expect(scalar('a > b', { a: 10n ** 400n, b: 1.5 }).boolean).toBe(true)
  })

  it('supports chained comparisons', () => {
    expect(scalar('a < b <= c', { a: 1n, b: 2n, c: 2n }).boolean).toBe(true)
    expect(scalar('a < b <= c', { a: 3n, b: 2n, c: 2n }).boolean).toBe(false)
  })

  it('returns operands from and/or', () => {
    expect(scalar('a or b', { a: 0n, b: 2.5 }).float).toBe(2.5)
    expect(scalar('a and b', { a: 1n, b: 2.5 }).float).toBe(2.5)
    expect(scalar('a and b', { a: 0.0, b: 2.5 }).float).toBe(0)
  })

  it('rounds two-argument ties to even like CPython dtoa rounding', () => {
    expect(scalar('round(a, 2)', { a: 0.125 }).float).toBe(0.12)
    expect(scalar('round(a, 2)', { a: 0.375 }).float).toBe(0.38)
    expect(scalar('round(a, 2)', { a: 2.675 }).float).toBe(2.67)
    expect(scalar('round(a, 1)', { a: -0.05 }).float).toBe(-0.1)
    expect(scalar('round(a, -2)', { a: 25012.5 }).float).toBe(25000)
    expect(scalar('round(a, -1)', { a: 25n }).int).toBe(20n)
    expect(scalar('round(a, -1)', { a: 35n }).int).toBe(40n)
  })

  it('indexes the implicit ordered values list, including negative indices', () => {
    expect(scalar('values[0] * 100 + values[-1]', { a: 7n, b: 2.5, c: 3n }).int).toBe(703n)
  })

  it('unwraps a single sequence argument for sum, min, and max', () => {
    expect(scalar('sum(values) + min(values) + max(values)', { a: 1n, b: 2n, c: 3n }).int).toBe(10n)
  })

  it('truncates the int output toward zero', () => {
    expect(scalar('a', { a: -4.5 }).int).toBe(-4n)
    expect(scalar('a', { a: 4.5 }).int).toBe(4n)
  })
})

describe('expression text validation', () => {
  it('uses the canonical grammar for valid and invalid text', () => {
    expect(validateExpressionText('sin(a) + b', ['a', 'b'])).toEqual({ kind: 'valid' })
    expect(validateExpressionText('a +', ['a'])).toEqual({
      kind: 'invalid',
      message: 'Invalid expression: unexpected token',
    })
    expect(validateExpressionText('future(a)', ['a'])).toEqual({
      kind: 'unresolved',
      message: "Unknown function 'future'",
    })
  })

  it('does not mistake value-dependent runtime failures for invalid syntax', () => {
    expect(validateExpressionText('a / b', ['a', 'b'])).toEqual({ kind: 'valid' })
    expect(validateExpressionText('values[a]', ['a', 'b'])).toEqual({ kind: 'valid' })
    expect(validateExpressionText('', ['a'])).toEqual({
      kind: 'invalid',
      message: 'Invalid expression: expression cannot be empty',
    })
  })
})

describe('failure modes collapse to ExpressionMirrorError', () => {
  it('rejects oversized expressions, node counts, and vectors', () => {
    rejects(`a ${'+ a '.repeat(2000)}`, { a: 1n })
    expect(`a${' + a'.repeat(85)}`.length).toBeLessThan(MAX_EXPRESSION_LENGTH)
    expect(countExpressionNodes(`a${' + a'.repeat(63)}`)).toBeLessThanOrEqual(MAX_EXPRESSION_NODES)
    rejects(`a${' + a'.repeat(85)}`, { a: 1n })
    rejects('a', { a: new Array<bigint>(MAX_VECTOR_LENGTH + 1).fill(1n) })
  })

  it('rejects unknown names, functions, bad arity, and bad input names', () => {
    rejects('z + 1')
    rejects('hypot(a, b)', { a: 1n, b: 2n })
    rejects('sqrt(a, a)', { a: 4n })
    rejects('a + 1', { aa: 1n })
    rejects('a + 1', { A: 1n })
  })

  it('rejects inherited Object.prototype members as function names', () => {
    rejects('constructor() or 1')
    rejects('toString() or 1')
    rejects('hasOwnProperty() or 1')
    rejects('valueOf() or 1')
    rejects('__proto__()')
    rejects('__proto__(a)', { a: 1n })
  })

  it('rejects non-finite results, zero division, and overflow limits', () => {
    rejects('a / b', { a: 1n, b: 0n })
    rejects('a // b', { a: 1.0, b: 0.0 })
    rejects('a ** b', { a: 10n, b: 5000n })
    rejects('a ** b', { a: 10n, b: 4000n })
    rejects('a << b', { a: 1n, b: 1001n })
    rejects('exp(a)', { a: 1000n })
    rejects('sqrt(a)', { a: -1n })
    rejects('float(a)', { a: 10n ** 400n })
  })

  it('rejects mismatched vector lengths and non-scalar values', () => {
    rejects('a + b', { a: [1n, 2n], b: [1n, 2n, 3n] })
    rejects('a', { a: 'text' as unknown as ExpressionValue })
  })

  it('rejects syntax outside the grammar', () => {
    rejects('')
    rejects('  ')
    rejects('(a, b)', { a: 1n, b: 2n })
    rejects('[a]', { a: 1n })
    rejects('"text"')
    rejects('a\n+ 1', { a: 1n })
    rejects('lambda: 1')
    rejects('a.real', { a: 1n })
    rejects('f"{a}"', { a: 1n })
    rejects('None + 1')
    rejects('1j + 1')
  })
})

describe('Python lexical forms', () => {
  it('skips comments like the Python tokenizer', () => {
    expect(scalar('1 # comment').int).toBe(1n)
    expect(scalar('1#c').int).toBe(1n)
    expect(scalar('# c\n1').int).toBe(1n)
    expect(scalar('(1 # c\n + 2)').int).toBe(3n)
    rejects('1 # c\n + 2')
  })

  it('allows only trivia after an unbracketed newline ends the expression', () => {
    expect(scalar('1\n# trailing').int).toBe(1n)
    expect(scalar('1 # first\n# trailing').int).toBe(1n)
    expect(scalar('1\n\n# c\n  \n').int).toBe(1n)
    rejects('1\n# c\n2')
    rejects('1\n\\\n2')
  })

  it('treats carriage returns as line terminators (Python universal newlines)', () => {
    expect(scalar('# c\r1').int).toBe(1n)
    expect(scalar('1 \\\r+ 2').int).toBe(3n)
    expect(scalar('(1 # c\r+ 2)').int).toBe(3n)
    expect(scalar('1\r').int).toBe(1n)
    rejects('1\r+ 2')
    rejects('1 # c\r+ 2')
    rejects('1\r\n+ 2')
    rejects('1 \\\r')
  })

  it('rejects indentation before the first token of a logical line', () => {
    rejects(' 1')
    rejects('\t1')
    rejects(' (1)')
    rejects('\n 1')
    rejects('# c\n 1')
    rejects(' \\\n1')
    rejects('\\\n 1')
    expect(scalar(' \n1').int).toBe(1n)
    expect(scalar(' # c\n1').int).toBe(1n)
    expect(scalar(' \\\n# c\n1').int).toBe(1n)
    expect(scalar('(1 +\n 2)').int).toBe(3n)
  })

  it('joins explicit line continuations', () => {
    expect(scalar('1 \\\n+ 2').int).toBe(3n)
    expect(scalar('1 \\\r\n+ 2').int).toBe(3n)
    expect(scalar('1 \\\n ').int).toBe(1n)
    rejects('1 \\\n')
    rejects('1 \\ \n+ 2')
    rejects('1 \\')
    rejects('1 \\\n\n+ 2')
  })

})

describe('parser nesting and resource limits', () => {

  it('collapses deeply nested input to ExpressionMirrorError, never a crash', () => {
    rejects('('.repeat(300) + '1' + ')'.repeat(300))
    rejects('('.repeat(2000) + '1' + ')'.repeat(2000))
    rejects('-'.repeat(4000) + '1')
  })
})

describe('unary scalar discipline', () => {
  it('requires a scalar operand for not, like every other unary operator', () => {
    rejects('not values', { a: 1n })
    expect(scalar('not a', { a: 0n }).boolean).toBe(true)
    expect(scalar('not a', { a: 2n }).boolean).toBe(false)
  })
})

describe('int / int true division is correctly rounded', () => {
  it('divides arbitrarily large cancelling operands exactly', () => {
    expect(scalar('10**400 / 10**400').float).toBe(1)
    expect(scalar('(10**400 + 1) / 10**400').float).toBe(1)
    expect(scalar('2**1030 / 2**1000').float).toBe(1073741824)
  })

  it('matches Python rounding on inexact quotients', () => {
    expect(scalar('7 / 3').float).toBe(2.3333333333333335)
    expect(scalar('-7 / 3').float).toBe(-2.3333333333333335)
    expect(scalar('1 / 3').float).toBe(0.3333333333333333)
    expect(scalar('123456789123456789123456789 / 987654321').float).toBe(1.249999989859375e17)
    expect(scalar('(2**53 + 1) / 1').float).toBe(9007199254740992)
    expect(scalar('(2**53 + 3) / 1').float).toBe(9007199254740996)
  })

})
