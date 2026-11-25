/**
 * The formula language that the editor and the engine both evaluate
 * (engine: dinkster_schema.formula). A formula means what Python says it
 * means, on a closed subset where the browser gives exactly the same answer.
 * Both sides load test/fixtures/formula_v1.json and must agree on every case.
 *
 * Besides a value, a formula has three outcomes. Refused is decided when the
 * pack loads (FormulaRefused). Unknown means a name it needs has no value
 * yet. Failed means the values make it impossible. Operands are worked out
 * in Python's order and the first one that is unknown or failed decides,
 * except where `and`, `or` and `x if c else y` never look at an operand and
 * where `known(x)` asks about one.
 *
 * Python ints are bigint, floats are number, booleans are boolean, text is
 * string counted in code points, a list is a frozen array and None is null.
 */
import {
  ExpressionMirrorError,
  bitLength,
  compareScalars,
  decompose,
  divideHalfEven,
  floatFloorDiv,
  floatMod,
  intTrueDivide,
  roundFloatToDigits,
  roundHalfEvenToInt,
  roundIntToDigits,
} from './expression.js'

export const FORMULA_LANGUAGE_VERSION = 1
export const MAX_FORMULA_LENGTH = 4096
export const MAX_FORMULA_PARTS = 256
export const MAX_FORMULA_BRACKET_DEPTH = 200
export const MAX_FORMULA_INTEGER_BITS = 16384
export const MAX_FORMULA_SHIFT = 1000
export const MAX_FORMULA_EXPONENT = 4000
export const MAX_FORMULA_LIST_LENGTH = 4096
export const MAX_FORMULA_TEXT_LITERAL = 4096
export const MAX_FORMULA_TEXT_VALUE = 65536
const MAX_ROUND_DIGITS = 32n
const MAX_FIXED_DIGITS = 12n

export const FORMULA_ASSET_FACTS = ['width', 'height', 'frames', 'fps', 'duration', 'kind', 'filename'] as const

const VALUE_KINDS = ['int', 'float', 'bool', 'text', 'choice'] as const
type ValueKind = (typeof VALUE_KINDS)[number]
/** The kind of a name a formula may use; `<kind>[]` is a group row across members. */
export type FormulaNameKind = ValueKind | `${ValueKind}[]` | 'opaque' | 'group'

/** A constant from a node's tables, or a dictionary inside one. Keys are text or whole numbers. */
export class FormulaTable {
  readonly entries: ReadonlyMap<string, FormulaTableValue>

  constructor(entries: Iterable<readonly [string | bigint, FormulaTableValue]>) {
    this.entries = new Map([...entries].map(([key, value]) => [tableKey(key)!, value]))
  }
}
export type FormulaTableValue = FormulaScalar | readonly FormulaScalar[] | FormulaTable
export type FormulaScalar = bigint | number | boolean | string | null
export type FormulaValue = FormulaScalar | readonly FormulaScalar[]

export const UNKNOWN: unique symbol = Symbol('unknown')
export type Unknown = typeof UNKNOWN

export type FormulaOutcome =
  | { readonly kind: 'value'; readonly value: FormulaValue }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'failed'; readonly reason: string }

export class FormulaRefused extends Error {}

/** What a formula may name, known when the pack loads. */
export interface FormulaScope {
  readonly names: ReadonlyMap<string, FormulaNameKind>
  readonly inputs?: ReadonlySet<string>
  readonly assets?: ReadonlySet<string>
  readonly tables?: ReadonlyMap<string, FormulaTableValue>
  readonly derived?: ReadonlyMap<string, string>
  readonly inMember?: boolean
  /** Allows `previous()`, in the formulas of steps applied with the user's own change of a field. */
  readonly inOnEdit?: boolean
}

/** The state a formula is evaluated against. A missing name is unknown. */
export interface FormulaValues {
  readonly values?: ReadonlyMap<string, FormulaValue | Unknown>
  readonly linked?: ReadonlyMap<string, boolean>
  readonly linkedTypes?: ReadonlyMap<string, string | null>
  readonly groupSizes?: ReadonlyMap<string, number>
  readonly memberIndex?: number | null
  readonly memberKey?: string | null
  /** Keyed by `fact(name)`, such as `fps(video)`. */
  readonly facts?: ReadonlyMap<string, FormulaValue>
  /** The state before the user's change, for `previous()`; without it `previous()` is unknown. */
  readonly previous?: FormulaValues
}

// ---------------------------------------------------------------------------
// Values

type Value = FormulaScalar | readonly FormulaScalar[] | FormulaTable

class Stop {
  constructor(readonly outcome: { readonly kind: 'unknown' } | { readonly kind: 'failed'; readonly reason: string }) {}
}
const STOP_UNKNOWN = new Stop({ kind: 'unknown' })

function failed(reason: string): never {
  throw new Stop({ kind: 'failed', reason })
}

function refuse(reason: string): never {
  throw new FormulaRefused(reason)
}

function codePoints(text: string): string[] {
  return Array.from(text)
}

function textLength(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

function isList(value: Value): value is readonly FormulaScalar[] {
  return Array.isArray(value)
}

function isNumber(value: Value): value is bigint | number | boolean {
  return typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean'
}

function isWhole(value: Value): value is bigint | boolean {
  return typeof value === 'bigint' || typeof value === 'boolean'
}

function whole(value: bigint | boolean): bigint {
  return typeof value === 'boolean' ? (value ? 1n : 0n) : value
}

function typeName(value: Value): string {
  if (value === null) return 'None'
  if (value instanceof FormulaTable) return 'table'
  if (isList(value)) return 'list'
  switch (typeof value) {
    case 'boolean':
      return 'boolean'
    case 'bigint':
      return 'whole number'
    case 'number':
      return 'float'
    default:
      return 'text'
  }
}

function check<T extends Value>(value: T): T {
  if (typeof value === 'bigint') {
    if (bitLength(value) > MAX_FORMULA_INTEGER_BITS) failed(`whole number exceeds ${MAX_FORMULA_INTEGER_BITS} bits`)
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) failed('result is not a finite number')
  } else if (typeof value === 'string') {
    if (value.length > MAX_FORMULA_TEXT_VALUE && textLength(value) > MAX_FORMULA_TEXT_VALUE) {
      failed(`text exceeds ${MAX_FORMULA_TEXT_VALUE} characters`)
    }
  } else if (isList(value)) {
    if (value.length > MAX_FORMULA_LIST_LENGTH) failed(`list exceeds ${MAX_FORMULA_LIST_LENGTH} items`)
  }
  return value
}

function number(value: Value, what: string): bigint | number | boolean {
  if (!isNumber(value)) failed(`${what} needs a number, got ${typeName(value)}`)
  return value
}

function text(value: Value, what: string): string {
  if (typeof value !== 'string') failed(`${what} needs text, got ${typeName(value)}`)
  return value
}

function list(value: Value, what: string): readonly FormulaScalar[] {
  if (!isList(value)) failed(`${what} needs a list, got ${typeName(value)}`)
  return value
}

function listItem(value: Value): FormulaScalar {
  if (value === null || isNumber(value) || typeof value === 'string') return value
  failed(`a list holds numbers, booleans and text, not ${typeName(value)}`)
}

function toFloat(value: bigint | number | boolean): number {
  if (typeof value === 'number') return value
  const converted = Number(whole(value))
  if (!Number.isFinite(converted)) failed('number too large')
  return converted
}

function truthy(value: Value): boolean {
  if (value === null) return false
  if (value instanceof FormulaTable) return value.entries.size > 0
  if (isList(value)) return value.length > 0
  if (typeof value === 'bigint') return value !== 0n
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value.length > 0
  return value
}

/** Python == across every kind of value; a table equals no list item. */
function equal(left: Value, right: Value): boolean {
  if (isNumber(left) && isNumber(right)) return compareScalars(left, right) === 0
  if (isList(left) && isList(right)) {
    return left.length === right.length && left.every((item, index) => equal(item, right[index]!))
  }
  if (typeof left === 'string' && typeof right === 'string') return left === right
  return left === null && right === null
}

/** Python's dict key for a lookup: 1, 1.0 and True are one key. */
function tableKey(key: Value): string | undefined {
  if (typeof key === 'string') return `s:${key}`
  if (typeof key === 'bigint' || typeof key === 'boolean') return `i:${whole(key)}`
  if (typeof key === 'number') return Number.isInteger(key) ? `i:${BigInt(key)}` : undefined
  failed('a table key is text or a whole number')
}

// ---------------------------------------------------------------------------
// Arithmetic with Python's meaning

function arith(symbol: string, left: Value, right: Value): Value {
  if (symbol === '+') {
    if (typeof left === 'string' && typeof right === 'string') return left + right
    if (isList(left) && isList(right)) return Object.freeze([...left, ...right])
  }
  if (symbol === '<<' || symbol === '>>' || symbol === '|' || symbol === '^' || symbol === '&') {
    if (!isWhole(left) || !isWhole(right)) failed(`${symbol} needs whole numbers`)
    if (typeof left === 'boolean' && typeof right === 'boolean' && symbol !== '<<' && symbol !== '>>') {
      if (symbol === '|') return left || right
      if (symbol === '&') return left && right
      return left !== right
    }
    const a = whole(left)
    const b = whole(right)
    if (symbol === '<<' || symbol === '>>') {
      if (b < 0n || b > BigInt(MAX_FORMULA_SHIFT)) failed(`shift amount must be between 0 and ${MAX_FORMULA_SHIFT}`)
      if (symbol === '<<' && BigInt(bitLength(a)) + b > BigInt(MAX_FORMULA_INTEGER_BITS + 1)) {
        failed(`whole number exceeds ${MAX_FORMULA_INTEGER_BITS} bits`)
      }
      return symbol === '<<' ? a << b : a >> b
    }
    if (symbol === '|') return a | b
    if (symbol === '&') return a & b
    return a ^ b
  }
  const a = number(left, symbol)
  const b = number(right, symbol)
  if (symbol === '**') {
    if (!isWhole(a) || !isWhole(b)) failed('** needs whole numbers on both sides')
    const base = whole(a)
    const exponent = whole(b)
    if (exponent < 0n || exponent > BigInt(MAX_FORMULA_EXPONENT)) {
      failed(`exponent must be between 0 and ${MAX_FORMULA_EXPONENT}`)
    }
    if ((base > 1n || base < -1n) && BigInt(bitLength(base) - 1) * exponent > BigInt(MAX_FORMULA_INTEGER_BITS)) {
      failed(`whole number exceeds ${MAX_FORMULA_INTEGER_BITS} bits`)
    }
    return base ** exponent
  }
  if (isWhole(a) && isWhole(b)) {
    const x = whole(a)
    const y = whole(b)
    switch (symbol) {
      case '+':
        return x + y
      case '-':
        return x - y
      case '*':
        return x * y
      case '/':
        if (y === 0n) failed('division by zero')
        return intTrueDivide(x, y)
      case '//': {
        if (y === 0n) failed('division by zero')
        let quotient = x / y
        if (x % y !== 0n && x < 0n !== y < 0n) quotient -= 1n
        return quotient
      }
      case '%': {
        if (y === 0n) failed('division by zero')
        let remainder = x % y
        if (remainder !== 0n && remainder < 0n !== y < 0n) remainder += y
        return remainder
      }
    }
  }
  const x = toFloat(a)
  const y = toFloat(b)
  switch (symbol) {
    case '+':
      return x + y
    case '-':
      return x - y
    case '*':
      return x * y
    case '/':
      if (y === 0) failed('division by zero')
      return x / y
    case '//':
      if (y === 0) failed('division by zero')
      return floatFloorDiv(x, y)
    case '%':
      if (y === 0) failed('division by zero')
      return floatMod(x, y)
  }
  throw new Error(`unhandled operator ${symbol}`)
}

function ordered(symbol: string, left: Value, right: Value): boolean {
  if (!isNumber(left) || !isNumber(right)) failed(`${symbol} compares numbers only`)
  const order = compareScalars(left, right)
  switch (symbol) {
    case '<':
      return order < 0
    case '<=':
      return order <= 0
    case '>':
      return order > 0
    default:
      return order >= 0
  }
}

function contains(container: Value, item: Value): boolean {
  if (typeof container === 'string') return container.includes(text(item, 'in'))
  if (isList(container)) return container.some((element) => equal(element, item))
  if (container instanceof FormulaTable) {
    if (item === null || isList(item) || item instanceof FormulaTable) failed('a table key is text or a whole number')
    const key = tableKey(item)
    return key !== undefined && container.entries.has(key)
  }
  failed(`in needs text, a list or a table, got ${typeName(container)}`)
}

function subscript(container: Value, index: Value): Value {
  if (container instanceof FormulaTable) {
    if (index === null || isList(index) || index instanceof FormulaTable) failed('a table key is text or a whole number')
    const key = tableKey(index)
    if (key === undefined || !container.entries.has(key)) failed('table has no such key')
    return container.entries.get(key)!
  }
  if (typeof container !== 'string' && !isList(container)) {
    failed(`x[i] needs text, a list or a table, got ${typeName(container)}`)
  }
  if (!isWhole(index)) failed('an index is a whole number')
  const items: readonly Value[] = typeof container === 'string' ? codePoints(container) : container
  let position = whole(index)
  if (position < 0n) position += BigInt(items.length)
  if (position < 0n || position >= BigInt(items.length)) failed('index out of range')
  return items[Number(position)]!
}

function bind(kind: FormulaNameKind, value: FormulaValue | Unknown): Value | Unknown {
  if (value === UNKNOWN) return UNKNOWN
  if (kind.endsWith('[]')) {
    const itemKind = kind.slice(0, -2) as FormulaNameKind
    const bound = (value as readonly (FormulaScalar | Unknown)[]).map((item) => bind(itemKind, item))
    if (bound.includes(UNKNOWN)) return UNKNOWN
    return Object.freeze(bound as FormulaScalar[])
  }
  if (kind === 'float' && (typeof value === 'bigint' || typeof value === 'boolean')) return Number(whole(value))
  if (kind === 'int' && typeof value === 'boolean') return whole(value)
  return value
}

// ---------------------------------------------------------------------------
// Functions

function pyRound(x: Value, digits?: Value): Value {
  const value = number(x, 'round')
  if (digits === undefined || digits === null) {
    if (typeof value === 'number') return roundHalfEvenToInt(value)
    return whole(value)
  }
  if (!isWhole(digits)) failed('round() digits is a whole number')
  const n = whole(digits)
  if (n < -MAX_ROUND_DIGITS || n > MAX_ROUND_DIGITS) {
    failed(`round() digits must be between -${MAX_ROUND_DIGITS} and ${MAX_ROUND_DIGITS}`)
  }
  if (typeof value === 'number') return roundFloatToDigits(value, n)
  return roundIntToDigits(whole(value), n)
}

function minMax(name: 'min' | 'max', args: readonly Value[]): Value {
  const items: readonly Value[] = args.length === 1 ? list(args[0]!, name) : args
  if (items.length === 0) failed(`${name}() of an empty list`)
  let best = number(items[0]!, name)
  for (const item of items.slice(1)) {
    const value = number(item, name)
    const order = compareScalars(value, best)
    if (name === 'min' ? order < 0 : order > 0) best = value
  }
  return best
}

function sum(items: Value): Value {
  let total: Value = 0n
  for (const item of list(items, 'sum')) total = check(arith('+', number(total, 'sum'), number(item, 'sum')))
  return total
}

function clamp(x: Value, low: Value, high: Value): Value {
  const value = number(x, 'clamp')
  const lo = number(low, 'clamp')
  const hi = number(high, 'clamp')
  if (compareScalars(value, lo) < 0) return lo
  if (compareScalars(value, hi) > 0) return hi
  return value
}

function floorCeil(x: Value, name: 'floor' | 'ceil'): bigint {
  const value = number(x, name)
  if (typeof value !== 'number') return whole(value)
  return BigInt(name === 'floor' ? Math.floor(value) : Math.ceil(value))
}

function sqrt(x: Value): number {
  const value = toFloat(number(x, 'sqrt'))
  if (value < 0) failed('sqrt() of a negative number')
  return Math.sqrt(value)
}

function pyInt(x: Value): bigint {
  const value = number(x, 'int')
  if (typeof value === 'number') return BigInt(Math.trunc(value))
  return whole(value)
}

function lines(t: Value): readonly string[] {
  const all = text(t, 'lines').replace(/\r\n?/g, '\n').split('\n')
  return Object.freeze(all.map((line) => strip(line)).filter((line) => line !== ''))
}

function strip(t: string): string {
  return t.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '')
}

function split(t: Value, sep: Value): readonly string[] {
  const separator = text(sep, 'split')
  if (separator === '') failed('split() with an empty separator')
  return Object.freeze(text(t, 'split').split(separator))
}

function replace(t: Value, old: Value, replacement: Value): string {
  const source = text(t, 'replace')
  const target = text(old, 'replace')
  const by = text(replacement, 'replace')
  if (target === '') return by + codePoints(source).join(by) + (source === '' ? '' : by)
  return source.split(target).join(by)
}

function join(sep: Value, items: Value): string {
  const separator = text(sep, 'join')
  return list(items, 'join')
    .map((item) => text(item, 'join'))
    .join(separator)
}

function pyStr(x: Value): string {
  if (typeof x === 'bigint') return x.toString()
  if (typeof x === 'boolean') return x ? 'True' : 'False'
  if (typeof x === 'string') return x
  failed(`str() takes a whole number, boolean or text, got ${typeName(x)}`)
}

/** Python's format(float(x), ".Nf"): the exact value of the double, half to even. */
function fixed(x: Value, digits: Value): string {
  const value = toFloat(number(x, 'fixed'))
  if (!isWhole(digits) || whole(digits) < 0n || whole(digits) > MAX_FIXED_DIGITS) {
    failed(`fixed() digits must be between 0 and ${MAX_FIXED_DIGITS}`)
  }
  const n = Number(whole(digits))
  const negative = value < 0 || Object.is(value, -0)
  const { mantissa, exponent } = decompose(Math.abs(value))
  let numerator = mantissa * 10n ** BigInt(n)
  let denominator = 1n
  if (exponent >= 0) numerator <<= BigInt(exponent)
  else denominator <<= BigInt(-exponent)
  const scaled = divideHalfEven(numerator, denominator).toString().padStart(n + 1, '0')
  const integer = scaled.slice(0, scaled.length - n)
  const fraction = scaled.slice(scaled.length - n)
  return `${negative ? '-' : ''}${integer}${n > 0 ? `.${fraction}` : ''}`
}

function pyNumber(t: Value): bigint | number {
  const source = text(t, 'number')
  const match = /^[+-]?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.exec(source)
  if (match === null) failed(`number() cannot read ${JSON.stringify(source)}`)
  if (match[1] === undefined && match[2] === undefined) {
    if (source.length > MAX_FORMULA_INTEGER_BITS) failed(`whole number exceeds ${MAX_FORMULA_INTEGER_BITS} bits`)
    return BigInt(source)
  }
  return Number(source)
}

function position(items: Value, x: Value): bigint {
  const index = list(items, 'position').findIndex((item) => equal(item, x))
  if (index < 0) failed('position() did not find the item')
  return BigInt(index)
}

function range(n: Value): readonly bigint[] {
  if (!isWhole(n)) failed('range() takes a whole number')
  const count = whole(n)
  if (count > BigInt(MAX_FORMULA_LIST_LENGTH)) failed(`range() is at most ${MAX_FORMULA_LIST_LENGTH}`)
  const result: bigint[] = []
  for (let index = 0n; index < count; index += 1n) result.push(index)
  return Object.freeze(result)
}

function get(table: Value, key: Value, fallback: Value): Value {
  if (!(table instanceof FormulaTable)) failed(`get() needs a table, got ${typeName(table)}`)
  if (key === null || isList(key) || key instanceof FormulaTable) failed('a table key is text or a whole number')
  const entry = tableKey(key)
  return entry !== undefined && table.entries.has(entry) ? table.entries.get(entry)! : fallback
}

function signOf(x: Value): bigint {
  const value = number(x, 'sign')
  return BigInt(compareScalars(value, 0n))
}

function abs(x: Value): Value {
  const value = number(x, 'abs')
  if (typeof value === 'number') return Math.abs(value)
  const integer = whole(value)
  return integer < 0n ? -integer : integer
}

function lengthOf(x: Value): bigint {
  if (typeof x === 'string') return BigInt(textLength(x))
  if (isList(x)) return BigInt(x.length)
  failed(`len() needs text, a list or a group, got ${typeName(x)}`)
}

const FUNCTIONS: Readonly<Record<string, (...args: Value[]) => Value>> = {
  abs,
  sign: signOf,
  floor: (x) => floorCeil(x, 'floor'),
  ceil: (x) => floorCeil(x, 'ceil'),
  round: (x, digits) => pyRound(x!, digits),
  min: (...args) => minMax('min', args),
  max: (...args) => minMax('max', args),
  clamp,
  sum,
  sqrt,
  mod: (a, b) => arith('%', a!, b!),
  lerp: (a, b, t) => arith('+', a!, check(arith('*', check(arith('-', b!, a!)), t!))),
  int: pyInt,
  float: (x) => toFloat(number(x!, 'float')),
  len: lengthOf,
  lower: (t) => text(t!, 'lower').replace(/[A-Z]/g, (c) => c.toLowerCase()),
  upper: (t) => text(t!, 'upper').replace(/[a-z]/g, (c) => c.toUpperCase()),
  strip: (t) => strip(text(t!, 'strip')),
  startswith: (t, p) => text(t!, 'startswith').startsWith(text(p!, 'startswith')),
  endswith: (t, p) => text(t!, 'endswith').endsWith(text(p!, 'endswith')),
  replace,
  split,
  lines,
  join,
  str: pyStr,
  fixed,
  number: pyNumber,
  any: (items) => list(items!, 'any').some(truthy),
  all: (items) => list(items!, 'all').every(truthy),
  count: (items, x) => BigInt(list(items!, 'count').filter((item) => equal(item, x!)).length),
  position,
  range,
  get,
}

/** Fewest and most arguments of each function; null for no limit. */
const ARITY: Readonly<Record<string, readonly [number, number | null]>> = {
  abs: [1, 1],
  sign: [1, 1],
  floor: [1, 1],
  ceil: [1, 1],
  round: [1, 2],
  min: [1, null],
  max: [1, null],
  clamp: [3, 3],
  sum: [1, 1],
  sqrt: [1, 1],
  mod: [2, 2],
  lerp: [3, 3],
  int: [1, 1],
  float: [1, 1],
  len: [1, 1],
  lower: [1, 1],
  upper: [1, 1],
  strip: [1, 1],
  startswith: [2, 2],
  endswith: [2, 2],
  replace: [3, 3],
  split: [2, 2],
  lines: [1, 1],
  join: [2, 2],
  str: [1, 1],
  fixed: [2, 2],
  number: [1, 1],
  any: [1, 1],
  all: [1, 1],
  count: [2, 2],
  position: [2, 2],
  range: [1, 1],
  get: [3, 3],
  linked: [1, 1],
  linked_type: [1, 1],
  index: [0, 0],
  key: [0, 0],
  known: [1, 1],
  previous: [1, 1],
  ...Object.fromEntries(FORMULA_ASSET_FACTS.map((fact) => [fact, [1, 1] as const])),
}
const NAME_FACTS = new Set<string>(['linked', 'linked_type', ...FORMULA_ASSET_FACTS])

// ---------------------------------------------------------------------------
// Reading the text: a Python expression subset with Python's tree shape

type Node =
  | { readonly type: 'constant'; readonly value: FormulaScalar }
  | { readonly type: 'name'; readonly name: string }
  | { readonly type: 'attribute'; readonly value: Node; readonly attr: string }
  | { readonly type: 'binary'; readonly op: string; readonly left: Node; readonly right: Node }
  | { readonly type: 'unary'; readonly op: string; readonly operand: Node }
  | { readonly type: 'bool'; readonly op: 'and' | 'or'; readonly values: readonly Node[] }
  | { readonly type: 'compare'; readonly left: Node; readonly ops: readonly string[]; readonly comparators: readonly Node[] }
  | { readonly type: 'if'; readonly test: Node; readonly body: Node; readonly orelse: Node }
  | { readonly type: 'call'; readonly func: Node; readonly args: readonly Node[] }
  | { readonly type: 'subscript'; readonly value: Node; readonly index: Node }
  | { readonly type: 'list'; readonly items: readonly Node[] }
  | {
      readonly type: 'comprehension'
      readonly element: Node
      readonly target: string
      readonly iterable: Node
      readonly conditions: readonly Node[]
    }

type Token =
  | { readonly kind: 'number'; readonly value: bigint | number; readonly start: number; readonly end: number }
  | { readonly kind: 'text'; readonly value: string; readonly start: number; readonly end: number }
  | { readonly kind: 'name'; readonly value: string; readonly start: number; readonly end: number }
  | { readonly kind: 'op'; readonly value: string; readonly start: number; readonly end: number }
  | { readonly kind: 'newline'; readonly value: string; readonly start: number; readonly end: number }
  | { readonly kind: 'end'; readonly value: ''; readonly start: number; readonly end: number }

const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
])
const OPERATORS = [
  '**', '//', '<<', '>>', '<=', '>=', '==', '!=', '->', ':=', '+', '-', '*', '/', '%', '@', '<', '>',
  '|', '&', '^', '~', '(', ')', '[', ']', '{', '}', ',', ':', '.', ';', '=', '!',
]
const WHITESPACE = ' \t\n\r\f'
const NUMBER = new RegExp(
  '^(?:0[xX](?:_?[0-9a-fA-F])+(?![0-9a-zA-Z_.])' +
    '|(?:(?:[0-9](?:_?[0-9])*)?\\.[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*\\.(?![0-9]))(?:[eE][+-]?[0-9](?:_?[0-9])*)?' +
    '|[0-9](?:_?[0-9])*[eE][+-]?[0-9](?:_?[0-9])*' +
    '|(?:[1-9](?:_?[0-9])*|0)(?![0-9_]))',
)

function trimWhitespace(source: string): string {
  let start = 0
  let end = source.length
  while (start < end && WHITESPACE.includes(source[start]!)) start += 1
  while (end > start && WHITESPACE.includes(source[end - 1]!)) end -= 1
  return source.slice(start, end)
}

function readText(source: string, start: number): { value: string; end: number } {
  const quote = source[start]!
  if (source.startsWith(quote.repeat(3), start)) refuse('text literals cannot be triple-quoted')
  let index = start + 1
  let value = ''
  let length = 0
  for (;;) {
    if (index >= source.length) refuse('a text literal is not closed')
    const char = source[index]!
    if (char === quote) break
    if (char === '\n' || char === '\r') refuse('a text literal is one line')
    if (char === '\\') {
      const escaped = source[index + 1] ?? ''
      const map: Record<string, string> = { '\\': '\\', '"': '"', "'": "'", n: '\n', t: '\t', r: '\r' }
      if (!(escaped in map)) refuse(`escape \\${escaped} is not allowed`)
      value += map[escaped]
      index += 2
    } else {
      const point = source.codePointAt(index)!
      const width = point > 0xffff ? 2 : 1
      value += source.slice(index, index + width)
      index += width
    }
    length += 1
  }
  if (length > MAX_FORMULA_TEXT_LITERAL) refuse(`a text literal exceeds ${MAX_FORMULA_TEXT_LITERAL} characters`)
  return { value, end: index + 1 }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let depth = 0
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (char === ' ' || char === '\t' || char === '\f') {
      index += 1
      continue
    }
    if (char === '\n' || char === '\r') {
      const width = char === '\r' && source[index + 1] === '\n' ? 2 : 1
      if (depth === 0) tokens.push({ kind: 'newline', value: '\n', start: index, end: index + width })
      index += width
      continue
    }
    const previous = tokens[tokens.length - 1]
    const touching = previous !== undefined && previous.end === index
    if (char === '"' || char === "'") {
      // Python reads a name touching a quote as a prefix (b'', f'') unless it is a keyword.
      if (touching && previous.kind === 'name' && !PYTHON_KEYWORDS.has(previous.value)) {
        refuse('text literals take no prefix')
      }
      if (previous !== undefined && previous.kind === 'text') refuse('two text literals cannot stand side by side')
      const { value, end } = readText(source, index)
      tokens.push({ kind: 'text', value, start: index, end })
      index = end
      continue
    }
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[index + 1] ?? ''))) {
      const match = NUMBER.exec(source.slice(index))
      if (match === null) refuse('number is not allowed')
      const raw = match[0]
      const after = source[index + raw.length] ?? ''
      if (/[A-Za-z0-9_]/.test(after)) refuse('a name cannot follow a number directly')
      const digits = raw.replaceAll('_', '')
      const value = /^0[xX]/.test(digits) || !/[.eE]/.test(digits) ? BigInt(digits) : Number(digits)
      tokens.push({ kind: 'number', value, start: index, end: index + raw.length })
      index += raw.length
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index))![0]
      tokens.push({ kind: 'name', value: name, start: index, end: index + name.length })
      index += name.length
      continue
    }
    if (char === '#') refuse('comments are not allowed')
    if (char === '\\') refuse('line continuations are not allowed')
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index))
    if (operator === undefined) refuse(`invalid character ${JSON.stringify(char)}`)
    if (operator === '(' || operator === '[' || operator === '{') {
      depth += 1
      if (depth > MAX_FORMULA_BRACKET_DEPTH) refuse(`brackets nest deeper than ${MAX_FORMULA_BRACKET_DEPTH}`)
    } else if (operator === ')' || operator === ']' || operator === '}') {
      depth -= 1
      if (depth < 0) refuse('unmatched bracket')
    }
    tokens.push({ kind: 'op', value: operator, start: index, end: index + operator.length })
    index += operator.length
  }
  if (depth !== 0) refuse('a bracket is not closed')
  tokens.push({ kind: 'end', value: '', start: source.length, end: source.length })
  return tokens
}

class Parser {
  private index = 0

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token {
    return this.tokens[this.index]!
  }

  private isOp(value: string): boolean {
    const token = this.peek()
    return token.kind === 'op' && token.value === value
  }

  private isKeyword(value: string): boolean {
    const token = this.peek()
    return token.kind === 'name' && token.value === value
  }

  private take(): Token {
    const token = this.peek()
    this.index += 1
    return token
  }

  private expectOp(value: string): void {
    if (!this.isOp(value)) refuse(`invalid formula: expected ${value}`)
    this.index += 1
  }

  parseFormula(): Node {
    const node = this.expressions()
    if (this.peek().kind !== 'end') refuse('invalid formula: unexpected text after the formula')
    return node
  }

  /** expressions: expression (',' expression)* [','] -> a list when there is a comma */
  private expressions(): Node {
    const first = this.expression()
    if (!this.isOp(',')) return first
    const items = [first]
    while (this.isOp(',')) {
      this.index += 1
      if (this.atExpressionEnd()) break
      items.push(this.expression())
    }
    return { type: 'list', items }
  }

  private atExpressionEnd(): boolean {
    const token = this.peek()
    return token.kind === 'end' || token.kind === 'newline' || (token.kind === 'op' && [')', ']', '}'].includes(token.value))
  }

  private expression(): Node {
    if (this.isKeyword('lambda')) refuse('syntax Lambda is not allowed')
    const body = this.disjunction()
    if (!this.isKeyword('if')) return body
    this.index += 1
    const test = this.disjunction()
    if (!this.isKeyword('else')) refuse('invalid formula: expected else')
    this.index += 1
    const orelse = this.expression()
    return { type: 'if', test, body, orelse }
  }

  private disjunction(): Node {
    const first = this.conjunction()
    if (!this.isKeyword('or')) return first
    const values = [first]
    while (this.isKeyword('or')) {
      this.index += 1
      values.push(this.conjunction())
    }
    return { type: 'bool', op: 'or', values }
  }

  private conjunction(): Node {
    const first = this.inversion()
    if (!this.isKeyword('and')) return first
    const values = [first]
    while (this.isKeyword('and')) {
      this.index += 1
      values.push(this.inversion())
    }
    return { type: 'bool', op: 'and', values }
  }

  private inversion(): Node {
    if (this.isKeyword('not')) {
      this.index += 1
      return { type: 'unary', op: 'not', operand: this.inversion() }
    }
    return this.comparison()
  }

  private comparisonOperator(): string | undefined {
    const token = this.peek()
    if (token.kind === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(token.value)) {
      this.index += 1
      return token.value
    }
    if (token.kind === 'name' && token.value === 'in') {
      this.index += 1
      return 'in'
    }
    if (token.kind === 'name' && token.value === 'not') {
      const next = this.tokens[this.index + 1]!
      if (next.kind === 'name' && next.value === 'in') {
        this.index += 2
        return 'not in'
      }
    }
    if (token.kind === 'name' && token.value === 'is') refuse('comparison Is is not allowed')
    return undefined
  }

  private comparison(): Node {
    const left = this.bitOr()
    const ops: string[] = []
    const comparators: Node[] = []
    for (let op = this.comparisonOperator(); op !== undefined; op = this.comparisonOperator()) {
      ops.push(op)
      comparators.push(this.bitOr())
    }
    return ops.length === 0 ? left : { type: 'compare', left, ops, comparators }
  }

  private binaryLevel(operators: readonly string[], next: () => Node): Node {
    let left = next()
    for (let token = this.peek(); token.kind === 'op' && operators.includes(token.value); token = this.peek()) {
      this.index += 1
      left = { type: 'binary', op: token.value, left, right: next() }
    }
    return left
  }

  private bitOr(): Node {
    return this.binaryLevel(['|'], () => this.bitXor())
  }

  private bitXor(): Node {
    return this.binaryLevel(['^'], () => this.bitAnd())
  }

  private bitAnd(): Node {
    return this.binaryLevel(['&'], () => this.shift())
  }

  private shift(): Node {
    return this.binaryLevel(['<<', '>>'], () => this.sum())
  }

  private sum(): Node {
    return this.binaryLevel(['+', '-'], () => this.term())
  }

  private term(): Node {
    const node = this.binaryLevel(['*', '/', '//', '%', '@'], () => this.factor())
    return node
  }

  private factor(): Node {
    const token = this.peek()
    if (token.kind === 'op' && (token.value === '+' || token.value === '-' || token.value === '~')) {
      this.index += 1
      return { type: 'unary', op: token.value, operand: this.factor() }
    }
    return this.power()
  }

  private power(): Node {
    const base = this.primary()
    if (!this.isOp('**')) return base
    this.index += 1
    return { type: 'binary', op: '**', left: base, right: this.factor() }
  }

  private primary(): Node {
    let node = this.atom()
    for (;;) {
      if (this.isOp('.')) {
        this.index += 1
        const name = this.take()
        if (name.kind !== 'name' || PYTHON_KEYWORDS.has(name.value)) refuse('invalid formula: expected a name after .')
        node = { type: 'attribute', value: node, attr: name.value }
      } else if (this.isOp('(')) {
        this.index += 1
        node = { type: 'call', func: node, args: this.callArguments() }
      } else if (this.isOp('[')) {
        this.index += 1
        node = { type: 'subscript', value: node, index: this.subscriptIndex() }
      } else {
        return node
      }
    }
  }

  private callArguments(): Node[] {
    const args: Node[] = []
    while (!this.isOp(')')) {
      if (this.isOp('*') || this.isOp('**')) refuse('unpacking is not allowed')
      const argument = this.expression()
      if (this.isOp('=')) refuse('keyword arguments are not allowed')
      if (this.isKeyword('for') || this.isKeyword('async')) refuse('syntax GeneratorExp is not allowed')
      if (this.isOp(':=')) refuse('syntax NamedExpr is not allowed')
      args.push(argument)
      if (!this.isOp(',')) break
      this.index += 1
    }
    this.expectOp(')')
    return args
  }

  private subscriptIndex(): Node {
    const items: Node[] = []
    let comma = false
    for (;;) {
      if (this.isOp(':')) refuse('slices are not allowed')
      if (this.isOp('*')) refuse('unpacking is not allowed')
      items.push(this.expression())
      if (this.isOp(':')) refuse('slices are not allowed')
      if (!this.isOp(',')) break
      comma = true
      this.index += 1
      if (this.isOp(']')) break
    }
    this.expectOp(']')
    return comma ? { type: 'list', items } : items[0]!
  }

  private atom(): Node {
    const token = this.take()
    if (token.kind === 'number' || token.kind === 'text') return { type: 'constant', value: token.value }
    if (token.kind === 'name') {
      if (token.value === 'True') return { type: 'constant', value: true }
      if (token.value === 'False') return { type: 'constant', value: false }
      if (token.value === 'None') return { type: 'constant', value: null }
      if (PYTHON_KEYWORDS.has(token.value)) refuse(`invalid formula: unexpected ${token.value}`)
      return { type: 'name', name: token.value }
    }
    if (token.kind === 'op' && token.value === '(') {
      if (this.isOp(')')) {
        this.index += 1
        return { type: 'list', items: [] }
      }
      if (this.isOp('*')) refuse('unpacking is not allowed')
      const first = this.expression()
      if (this.isKeyword('for') || this.isKeyword('async')) refuse('syntax GeneratorExp is not allowed')
      if (this.isOp(':=')) refuse('syntax NamedExpr is not allowed')
      if (this.isOp(')')) {
        this.index += 1
        return first
      }
      const items = [first]
      while (this.isOp(',')) {
        this.index += 1
        if (this.isOp(')')) break
        if (this.isOp('*')) refuse('unpacking is not allowed')
        items.push(this.expression())
      }
      this.expectOp(')')
      return { type: 'list', items }
    }
    if (token.kind === 'op' && token.value === '[') {
      if (this.isOp(']')) {
        this.index += 1
        return { type: 'list', items: [] }
      }
      if (this.isOp('*')) refuse('unpacking is not allowed')
      const first = this.expression()
      if (this.isOp(':=')) refuse('syntax NamedExpr is not allowed')
      if (this.isKeyword('async')) refuse('a comprehension has one for')
      if (this.isKeyword('for')) return this.comprehension(first)
      const items = [first]
      while (this.isOp(',')) {
        this.index += 1
        if (this.isOp(']')) break
        if (this.isOp('*')) refuse('unpacking is not allowed')
        items.push(this.expression())
      }
      this.expectOp(']')
      return { type: 'list', items }
    }
    if (token.kind === 'op' && token.value === '{') refuse('syntax Dict or Set is not allowed')
    if (token.kind === 'op' && token.value === '.') refuse('syntax Ellipsis is not allowed')
    refuse('invalid formula: unexpected token')
  }

  private comprehension(element: Node): Node {
    this.index += 1
    const target = this.take()
    if (target.kind !== 'name' || PYTHON_KEYWORDS.has(target.value)) refuse('a comprehension binds one name')
    if (!this.isKeyword('in')) refuse('a comprehension binds one name')
    this.index += 1
    const iterable = this.disjunction()
    const conditions: Node[] = []
    while (this.isKeyword('if')) {
      this.index += 1
      conditions.push(this.disjunction())
    }
    if (this.isKeyword('for') || this.isKeyword('async')) refuse('a comprehension has one for')
    this.expectOp(']')
    if (conditions.length > 1) refuse('a comprehension has one for and at most one if')
    return { type: 'comprehension', element, target: target.value, iterable, conditions }
  }
}

function dotted(node: Node): string | undefined {
  if (node.type === 'name') return node.name
  if (node.type === 'attribute') {
    const base = dotted(node.value)
    return base === undefined ? undefined : `${base}.${node.attr}`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// The whole-text check

const NAME_PART = /^[A-Za-z_][A-Za-z0-9_]*$/

class Checker {
  parts = 0
  readonly derivedUsed = new Set<string>()

  constructor(
    private readonly scope: FormulaScope,
    private readonly derivedStack: readonly string[],
    private locals: ReadonlySet<string> = new Set(),
    private inComprehension = false,
    private inPrevious = false,
  ) {}

  private count(n = 1): void {
    this.parts += n
    if (this.parts > MAX_FORMULA_PARTS) refuse(`formula exceeds ${MAX_FORMULA_PARTS} parts`)
  }

  private name(name: string, asValue = true): void {
    if (this.locals.has(name)) return
    if (this.scope.derived?.has(name)) {
      if (this.derivedStack.includes(name)) refuse(`derived formula ${name} refers to itself`)
      this.derivedUsed.add(name)
      return
    }
    if (this.scope.tables?.has(name)) return
    const kind = this.scope.names.get(name)
    if (kind === undefined) refuse(`unknown name ${name}`)
    if (asValue && kind === 'opaque') refuse(`${name} has no value in a formula; ask about it with a fact`)
    if (asValue && kind === 'group') refuse(`group ${name} has no value in a formula; use len(${name})`)
  }

  visit(node: Node): void {
    const path = dotted(node)
    if (path !== undefined) {
      this.count()
      if (node.type === 'name' || this.scope.names.has(path)) {
        this.name(path)
        return
      }
      refuse(`unknown name ${path}`)
    }
    switch (node.type) {
      case 'constant':
        this.count()
        return
      case 'attribute':
        return refuse('syntax Attribute is not allowed')
      case 'binary':
        if (node.op === '@') refuse('operator MatMult is not allowed')
        this.count()
        this.visit(node.left)
        this.visit(node.right)
        return
      case 'unary':
        this.count()
        this.visit(node.operand)
        return
      case 'bool':
        this.count(node.values.length - 1)
        for (const value of node.values) this.visit(value)
        return
      case 'compare':
        this.count(node.ops.length)
        this.visit(node.left)
        for (const comparator of node.comparators) this.visit(comparator)
        return
      case 'if':
        this.count()
        this.visit(node.test)
        this.visit(node.body)
        this.visit(node.orelse)
        return
      case 'subscript':
        this.count()
        this.visit(node.value)
        this.visit(node.index)
        return
      case 'list':
        this.count()
        for (const item of node.items) this.visit(item)
        return
      case 'comprehension':
        this.comprehension(node)
        return
      case 'call':
        this.call(node)
        return
    }
  }

  private comprehension(node: Extract<Node, { type: 'comprehension' }>): void {
    if (this.inComprehension) refuse('comprehensions cannot nest')
    if (this.scope.names.has(node.target) || this.scope.tables?.has(node.target) || this.scope.derived?.has(node.target)) {
      refuse(`comprehension name ${node.target} is already a row, table or formula`)
    }
    this.count()
    this.inComprehension = true
    this.visit(node.iterable)
    this.inComprehension = false
    const inner = new Checker(this.scope, this.derivedStack, new Set([...this.locals, node.target]), true, this.inPrevious)
    inner.parts = this.parts + 1
    if (inner.parts > MAX_FORMULA_PARTS) refuse(`formula exceeds ${MAX_FORMULA_PARTS} parts`)
    inner.visit(node.element)
    for (const condition of node.conditions) inner.visit(condition)
    for (const name of inner.derivedUsed) this.derivedUsed.add(name)
    this.parts = inner.parts
  }

  private call(node: Extract<Node, { type: 'call' }>): void {
    if (node.func.type !== 'name' || this.locals.has(node.func.name)) refuse("only the language's functions can be called")
    const name = node.func.name
    const arity = ARITY[name]
    if (arity === undefined) refuse(`unknown function ${name}`)
    const [fewest, most] = arity
    if (node.args.length < fewest || (most !== null && node.args.length > most)) {
      refuse(`${name}() takes the wrong number of arguments`)
    }
    this.count()
    if ((name === 'index' || name === 'key') && !this.scope.inMember) {
      refuse(`${name}() is only allowed inside a group member's rows`)
    }
    if (name === 'previous') {
      if (!this.scope.inOnEdit) refuse("previous() is only allowed in a step applied with a field's change")
      if (this.inPrevious) refuse('previous() cannot hold another previous()')
      this.inPrevious = true
      try {
        this.visit(node.args[0]!)
      } finally {
        this.inPrevious = false
      }
      return
    }
    if (NAME_FACTS.has(name)) {
      const target = dotted(node.args[0]!)
      const allowed =
        name === 'linked' || name === 'linked_type'
          ? (this.scope.inputs ?? new Set<string>())
          : new Set([...(this.scope.assets ?? []), ...(this.scope.inputs ?? [])])
      if (target === undefined || !allowed.has(target)) refuse(`${name}() takes the name of an input`)
      this.count()
      return
    }
    if (name === 'len') {
      const target = dotted(node.args[0]!)
      if (target !== undefined && this.scope.names.get(target) === 'group') {
        this.count()
        return
      }
    }
    if (name === 'known') {
      const argument = node.args[0]!
      const target = dotted(argument)
      if (target !== undefined) {
        this.count()
        this.name(target, this.scope.names.get(target) !== 'opaque')
        return
      }
      if (
        !(
          argument.type === 'call' &&
          argument.func.type === 'name' &&
          (FORMULA_ASSET_FACTS as readonly string[]).includes(argument.func.name)
        )
      ) {
        refuse('known() takes a name or a fact')
      }
    }
    for (const argument of node.args) this.visit(argument)
  }
}

// ---------------------------------------------------------------------------
// A checked formula

export class Formula {
  private constructor(
    readonly text: string,
    private readonly scope: FormulaScope,
    private readonly tree: Node,
    private readonly derived: ReadonlyMap<string, Formula>,
  ) {}

  /** Check `text` against `scope`; throws FormulaRefused when it is outside the language. */
  static parse(text: string, scope: FormulaScope): Formula {
    return Formula.compile(text, scope, [], new Map())
  }

  private static compile(
    text: string,
    scope: FormulaScope,
    stack: readonly string[],
    done: Map<string, Formula>,
  ): Formula {
    const source = trimWhitespace(text)
    if (source === '') refuse('a formula cannot be empty')
    if (textLength(text) > MAX_FORMULA_LENGTH) refuse(`formula exceeds ${MAX_FORMULA_LENGTH} characters`)
    for (const name of scope.names.keys()) {
      if (!name.split('.').every((part) => NAME_PART.test(part) && !PYTHON_KEYWORDS.has(part))) {
        refuse(`row id ${name} cannot be named in a formula`)
      }
    }
    refuseCharacter(
      text,
      /[\0]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.exec(text),
      'a formula cannot hold NUL or a lone surrogate',
    )
    refuseCharacter(text, /\r(?!\n)/.exec(text), 'a carriage return must be followed by a line feed')
    refuseCharacter(
      text,
      /[^\x20-\x7e\t\n\r\f]/.exec(blankTextLiterals(text)),
      'outside text literals a formula holds printable ASCII only',
    )
    const tree = new Parser(tokenize(source)).parseFormula()
    const checker = new Checker(scope, stack)
    checker.visit(tree)
    const derived = new Map<string, Formula>()
    for (const name of [...checker.derivedUsed].sort()) {
      if (!done.has(name)) done.set(name, Formula.compile(scope.derived!.get(name)!, scope, [...stack, name], done))
      derived.set(name, done.get(name)!)
    }
    return new Formula(text, scope, tree, derived)
  }

  evaluate(values: FormulaValues): FormulaOutcome {
    return new Evaluator(this.scope, values, new Map()).outcome(this)
  }

  /**
   * The row names and the functions this formula reads, its derived formulas
   * included. Comprehension names and table names are not rows.
   */
  uses(): { readonly names: ReadonlySet<string>; readonly calls: ReadonlySet<string> } {
    const names = new Set<string>()
    const calls = new Set<string>()
    const walk = (node: Node, locals: ReadonlySet<string>): void => {
      const path = dotted(node)
      if (path !== undefined) {
        if (!locals.has(path) && this.scope.names.has(path)) names.add(path)
        return
      }
      switch (node.type) {
        case 'constant':
        case 'name':
        case 'attribute':
          return
        case 'binary':
          walk(node.left, locals)
          walk(node.right, locals)
          return
        case 'unary':
          walk(node.operand, locals)
          return
        case 'bool':
          for (const value of node.values) walk(value, locals)
          return
        case 'compare':
          walk(node.left, locals)
          for (const comparator of node.comparators) walk(comparator, locals)
          return
        case 'if':
          walk(node.test, locals)
          walk(node.body, locals)
          walk(node.orelse, locals)
          return
        case 'subscript':
          walk(node.value, locals)
          walk(node.index, locals)
          return
        case 'list':
          for (const item of node.items) walk(item, locals)
          return
        case 'comprehension': {
          walk(node.iterable, locals)
          const inner = new Set([...locals, node.target])
          walk(node.element, inner)
          for (const condition of node.conditions) walk(condition, inner)
          return
        }
        case 'call':
          if (node.func.type === 'name') calls.add(node.func.name)
          for (const argument of node.args) walk(argument, locals)
          return
      }
    }
    walk(this.tree, new Set())
    for (const derived of this.derived.values()) {
      const inner = derived.uses()
      for (const name of inner.names) names.add(name)
      for (const call of inner.calls) calls.add(call)
    }
    return { names, calls }
  }

  /** @internal */
  get node(): Node {
    return this.tree
  }

  /** @internal */
  derivedFormula(name: string): Formula | undefined {
    return this.derived.get(name)
  }
}

const TEXT_LITERAL = /'(?:[^'\\\n]|\\[^\n])*'|"(?:[^"\\\n]|\\[^\n])*"/g

/** Refuse at the first character `match` found, named by code point and 1-based character position. */
function refuseCharacter(text: string, match: RegExpExecArray | null, rule: string): void {
  if (match === null) return
  const point = text.codePointAt(match.index)!
  const position = textLength(text.slice(0, match.index)) + 1
  refuse(`U+${point.toString(16).toUpperCase().padStart(4, '0')} at position ${position}: ${rule}`)
}

function blankTextLiterals(source: string): string {
  return source.replace(TEXT_LITERAL, (match) => ' '.repeat(match.length))
}

// ---------------------------------------------------------------------------
// Working a formula out

class Evaluator {
  private readonly locals = new Map<string, Value>()

  constructor(
    private readonly scope: FormulaScope,
    private readonly values: FormulaValues,
    private readonly derivedResults: Map<string, FormulaOutcome>,
  ) {}

  outcome(formula: Formula): FormulaOutcome {
    try {
      const result = this.eval(formula.node, formula)
      if (result instanceof FormulaTable) failed("a formula's result cannot be a table")
      return { kind: 'value', value: result }
    } catch (error) {
      if (error instanceof Stop) return error.outcome
      if (error instanceof ExpressionMirrorError) return { kind: 'failed', reason: error.message }
      if (error instanceof RangeError) return { kind: 'failed', reason: 'formula too deep' }
      throw error
    }
  }

  private lookup(name: string, formula: Formula): Value {
    if (this.locals.has(name)) return this.locals.get(name)!
    const derived = formula.derivedFormula(name)
    if (derived !== undefined) {
      if (!this.derivedResults.has(name)) {
        this.derivedResults.set(name, new Evaluator(this.scope, this.values, this.derivedResults).outcome(derived))
      }
      const result = this.derivedResults.get(name)!
      if (result.kind !== 'value') throw new Stop(result)
      return result.value
    }
    const table = this.scope.tables?.get(name)
    if (table !== undefined) return table
    const kind = this.scope.names.get(name)!
    // A stored None is a value; only a missing name is unknown.
    const stored = this.values.values?.get(name)
    const value = bind(kind, stored === undefined ? UNKNOWN : stored)
    if (value === UNKNOWN) throw STOP_UNKNOWN
    return check(value)
  }

  private eval(node: Node, formula: Formula): Value {
    const path = dotted(node)
    if (path !== undefined) return this.lookup(path, formula)
    switch (node.type) {
      case 'constant':
        return check(node.value)
      case 'binary': {
        const left = this.eval(node.left, formula)
        const right = this.eval(node.right, formula)
        return check(arith(node.op, left, right))
      }
      case 'unary': {
        const operand = this.eval(node.operand, formula)
        if (node.op === 'not') return !truthy(operand)
        if (node.op === '~') {
          if (!isWhole(operand)) failed('~ needs a whole number')
          return ~whole(operand)
        }
        const value = number(operand, node.op)
        if (node.op === '+') return typeof value === 'boolean' ? whole(value) : value
        return check(typeof value === 'number' ? -value : -whole(value))
      }
      case 'bool': {
        let result: Value = null
        for (const item of node.values) {
          result = this.eval(item, formula)
          if (truthy(result) !== (node.op === 'and')) return result
        }
        return result
      }
      case 'compare': {
        let left = this.eval(node.left, formula)
        for (let index = 0; index < node.ops.length; index += 1) {
          const right = this.eval(node.comparators[index]!, formula)
          const op = node.ops[index]!
          let holds: boolean
          if (op === '==' || op === '!=') {
            if (left instanceof FormulaTable || right instanceof FormulaTable) failed('tables cannot be compared')
            holds = equal(left, right) === (op === '==')
          }
          else if (op === 'in' || op === 'not in') holds = contains(right, left) === (op === 'in')
          else holds = ordered(op, left, right)
          if (!holds) return false
          left = right
        }
        return true
      }
      case 'if':
        return this.eval(truthy(this.eval(node.test, formula)) ? node.body : node.orelse, formula)
      case 'subscript': {
        const container = this.eval(node.value, formula)
        const index = this.eval(node.index, formula)
        return check(subscript(container, index))
      }
      case 'list':
        return check(Object.freeze(node.items.map((item) => listItem(this.eval(item, formula)))))
      case 'comprehension': {
        const items = list(this.eval(node.iterable, formula), 'a comprehension')
        const results: FormulaScalar[] = []
        for (const item of items) {
          this.locals.set(node.target, item)
          try {
            if (node.conditions.every((condition) => truthy(this.eval(condition, formula)))) {
              results.push(listItem(this.eval(node.element, formula)))
            }
          } finally {
            this.locals.delete(node.target)
          }
        }
        return check(Object.freeze(results))
      }
      case 'call':
        return this.call(node, formula)
      case 'name':
      case 'attribute':
        throw new Error('unreachable')
    }
  }

  private call(node: Extract<Node, { type: 'call' }>, formula: Formula): Value {
    const name = (node.func as Extract<Node, { type: 'name' }>).name
    if (NAME_FACTS.has(name)) {
      const target = dotted(node.args[0]!)!
      if (name === 'linked') return this.values.linked?.get(target) ?? false
      if (name === 'linked_type') return this.values.linkedTypes?.get(target) ?? null
      const fact = this.values.facts?.get(`${name}(${target})`)
      if (fact === undefined) throw STOP_UNKNOWN
      return check(fact)
    }
    if (name === 'index' || name === 'key') {
      const value = name === 'index' ? this.values.memberIndex : this.values.memberKey
      if (value === undefined || value === null) throw STOP_UNKNOWN
      return typeof value === 'number' ? BigInt(value) : value
    }
    if (name === 'previous') {
      if (this.values.previous === undefined) throw STOP_UNKNOWN
      const before = new Evaluator(this.scope, this.values.previous, new Map())
      for (const [local, value] of this.locals) before.locals.set(local, value)
      return before.eval(node.args[0]!, formula)
    }
    if (name === 'known') {
      try {
        this.eval(node.args[0]!, formula)
      } catch (error) {
        if (error instanceof Stop) return false
        if (error instanceof ExpressionMirrorError) return false
        throw error
      }
      return true
    }
    if (name === 'len') {
      const target = dotted(node.args[0]!)
      if (target !== undefined && this.scope.names.get(target) === 'group') {
        const size = this.values.groupSizes?.get(target)
        if (size === undefined) throw STOP_UNKNOWN
        return BigInt(size)
      }
    }
    const args = node.args.map((argument) => this.eval(argument, formula))
    return check(FUNCTIONS[name]!(...args))
  }
}
