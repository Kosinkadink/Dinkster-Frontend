/**
 * Native type relations. Advisory, not load-bearing: the UI uses them to
 * highlight legal drop targets and diagnostics use it to warn, but documents
 * are never rejected on type grounds (dynamic types can drift; a stale doc
 * must stay loadable and fixable). Structural invariants (one driver per
 * input, endpoints resolve) are what commands enforce.
 */

import { canonicalTypeIdOf, cardinalityOf, listTypeId, parseAssetTypeId, parseListTypeId, parseStreamTypeId, typeExprFromTypeId, type Cardinality, type TypeExpr } from './model.js'

export const containsRecord = (type: TypeExpr): boolean => type.kind === 'record' ||
  ((type.kind === 'list' || type.kind === 'asset' || type.kind === 'stream') && containsRecord(type.element)) ||
  (type.kind === 'tuple' && type.elements.some(containsRecord))

/** Declared fields are checked without reading values or converting their types. */
export function recordConnectionProblem(from: TypeExpr, to: TypeExpr): string | undefined {
  if (from.kind === 'wildcard' || from.kind === 'variable' || to.kind === 'wildcard' || to.kind === 'variable') return undefined
  if (to.kind === 'record') {
    if (from.kind !== 'record') return `Expected record ${to.name}, got ${canonicalTypeIdOf(from) ?? from.kind}.`
    const sameRecord = from.name === to.name
    for (const wanted of to.fields) {
      const found = from.fields.find((field) => sameRecord ? field.id === wanted.id : field.name === wanted.name)
      if (found === undefined) return `Missing record field: ${wanted.name}.`
      const nested = recordConnectionProblem(found.type, wanted.type)
      if (nested !== undefined) return `Record field '${wanted.name}': ${nested}`
      if (wanted.type.kind !== 'record' && !recordFieldTypeFits(found.type, wanted.type)) {
        return `Record field '${wanted.name}': Expected ${canonicalTypeIdOf(wanted.type)}, got ${canonicalTypeIdOf(found.type)}.`
      }
    }
  } else if (from.kind === 'record' && !['wildcard', 'variable', 'union'].includes(to.kind)) {
    return `Expected ${canonicalTypeIdOf(to) ?? to.kind}, got record ${from.name}.`
  } else if (from.kind === to.kind) {
    if ((from.kind === 'list' || from.kind === 'asset' || from.kind === 'stream') && 'element' in to) {
      return recordConnectionProblem(from.element, to.element!)
    }
    if (from.kind === 'tuple' && to.kind === 'tuple' && from.elements.length === to.elements.length) {
      for (const [index, element] of from.elements.entries()) {
        const problem = recordConnectionProblem(element, to.elements[index]!)
        if (problem !== undefined) return problem
      }
    }
  }
  return undefined
}

export const recordFieldTypeFits = (from: TypeExpr, to: TypeExpr): boolean => {
  if (from.kind !== to.kind) return false
  if (from.kind === 'record' && to.kind === 'record') return recordConnectionProblem(from, to) === undefined
  if ((from.kind === 'list' || from.kind === 'asset' || from.kind === 'stream') && 'element' in to) return recordFieldTypeFits(from.element, to.element!)
  if (from.kind === 'tuple' && to.kind === 'tuple') return from.elements.length === to.elements.length && from.elements.every((element, index) => recordFieldTypeFits(element, to.elements[index]!))
  if (from.kind === 'wildcard') return true
  return canonicalTypeIdOf(from) !== undefined && canonicalTypeIdOf(from) === canonicalTypeIdOf(to)
}

/** A whole-list input lifts its declared element type only for a list source. */
export const admittedInputType = (type: TypeExpr, acceptsList: boolean, sourceCardinality: Cardinality): TypeExpr =>
  acceptsList && type.kind !== 'list' && sourceCardinality === 'list'
    ? { kind: 'list', element: type }
    : type

/**
 * The concrete atom names a type expression can denote; undefined means
 * unrestricted (wildcard, an unconstrained variable, or an OPEN structured
 * type - one whose element is not recursively closed). Closed lists/assets
 * denote their canonical 'list<...>'/'asset<...>' id, so they participate in
 * atom-set arithmetic like any other atom. Callers that must distinguish
 * "open list" from "anything" check `kind === 'list'` / cardinality
 * separately (the solver does). Shared by advisory compatibility checks and
 * the solver's domain math.
 */
export const atomNamesOf = (t: TypeExpr): readonly string[] | undefined => {
  switch (t.kind) {
    case 'concrete':
    case 'record':
      return [t.name]
    case 'union':
      return t.names
    case 'wildcard':
      return undefined // matches anything
    case 'variable':
      if (!t.allowedTypes || t.allowedTypes.length === 0) return undefined
      return t.allowedTypes.flatMap((a) => atomNamesOf(a) ?? [])
    case 'tuple_element':
    case 'record_field':
      return undefined
    case 'tuple': {
      const positions = t.elements.map(atomNamesOf)
      if (positions.some((position) => position === undefined)) return undefined
      return positions.reduce<string[][]>((products, position) => products.flatMap((product) => position!.map((atom) => [...product, atom])), [[]])
        .map((product) => `tuple<${product.join(',')}>`)
    }
    case 'list':
    case 'asset':
    case 'stream': {
      if (t.kind === 'list' && t.element.kind === 'wildcard') return [listTypeId('*')]
      // list<union(A,B)> denotes {list<A>, list<B>} - element atoms lifted
      // through the constructor (recursively, so nested closed structures
      // yield 'list<asset<...>>' and kin). Open element -> undefined (NOT
      // "all atoms": structural checks in typesCompatible/the solver keep an
      // open list from matching scalars).
      const inner = atomNamesOf(t.element)
      return inner === undefined ? undefined : inner.map((name) => `${t.kind}<${name}>`)
    }
  }
}

/**
 * Can an output of type `from` legally feed an input of type `to`?
 * Wildcards and unconstrained variables match everything. Cardinality is
 * structural: a definitely-list side never feeds a definitely-scalar side
 * (no implicit coercion, DESIGN 3.13). List-vs-list recurses on elements;
 * otherwise the concrete name sets must intersect. On top of the direct
 * check, the ONE engine-side asset coercion step (typed assets, wire v12)
 * is legal: see assetCoercible.
 */
export function typesCompatible(from: TypeExpr, to: TypeExpr): boolean {
  return typesDirectlyCompatible(from, to) || assetCoercible(from, to)
}

/** Direct compatibility without the engine's optional asset coercion step. */
export function typesDirectlyCompatible(from: TypeExpr, to: TypeExpr): boolean {
  if (from.kind === 'wildcard' || to.kind === 'wildcard') return true
  if (from.kind !== 'variable' && to.kind !== 'variable' && recordConnectionProblem(from, to) !== undefined) return false
  if (from.kind === 'record' && to.kind === 'record') return true
  if (from.kind === 'tuple' && to.kind === 'tuple') {
    return from.elements.length === to.elements.length && from.elements.every((element, index) => typesDirectlyCompatible(element, to.elements[index]!))
  }
  if ((from.kind === 'tuple' || to.kind === 'tuple') && from.kind !== 'variable' && to.kind !== 'variable') return false
  const ca = cardinalityOf(from)
  const cb = cardinalityOf(to)
  if (ca !== 'unknown' && cb !== 'unknown' && ca !== cb) return false
  if (from.kind === to.kind && (from.kind === 'list' || from.kind === 'asset' || from.kind === 'stream'))
    return typesDirectlyCompatible(from.element, (to as TypeExpr & { kind: 'list' | 'asset' | 'stream' }).element)
  // One structured side against a closed atom set: peel the constructor and
  // compare elements (atoms that don't parse as that constructor's ids
  // can't match it). Same shape for list and asset.
  for (const kind of ['list', 'asset', 'stream'] as const) {
    if (from.kind !== kind && to.kind !== kind) continue
    const structured = from.kind === kind ? (from as TypeExpr & { kind: 'list' | 'asset' | 'stream' }) : (to as TypeExpr & { kind: 'list' | 'asset' | 'stream' })
    const other = from.kind === kind ? to : from
    if (other.kind === 'list' || other.kind === 'asset' || other.kind === 'stream') return false
    const atoms = atomNamesOf(other)
    if (atoms === undefined) return true // unconstrained variable
    const parse = kind === 'list' ? parseListTypeId : kind === 'asset' ? parseAssetTypeId : parseStreamTypeId
    const elems = atoms.map(parse).filter((n): n is string => n !== undefined)
    return elems.some((n) => typesDirectlyCompatible(structured.element, typeExprFromTypeId(n)))
  }
  const a = atomNamesOf(from)
  const b = atomNamesOf(to)
  if (a === undefined || b === undefined) return true
  return a.some((n) => b.includes(n))
}

/**
 * The type ids the ONE engine-side asset coercion step can turn a value of
 * `typeId` into at input resolution (typed assets, backend joint contract):
 * decode asset<T> -> [T], lift/merge list<asset<T>> -> [list<T>, T] (merge
 * is registry-gated server-side; the frontend cannot see the merge-provider
 * registry, so it is treated as maybe-legal here and the server refuses a
 * missing provider at document validation). Everything else -> []. The
 * SINGLE owner of the coercion vocabulary on this side of the wire.
 */
export const coercionTargetsOf = (typeId: string): readonly string[] => {
  const decode = parseAssetTypeId(typeId)
  if (decode !== undefined) return [decode]
  const inner = parseListTypeId(typeId)
  const element = inner === undefined ? undefined : parseAssetTypeId(inner)
  return element === undefined ? [] : [listTypeId(element), element]
}

/**
 * Can the one asset coercion step bridge `from` into `to`? Directional
 * (outputs are never coerced) and strictly single-step: coerced forms are
 * compared DIRECTLY, so asset<asset<T>> chains never pass. Structured
 * (possibly OPEN) forms peel the constructor - asset<T> can feed a concrete
 * input by binding T - while closed atom forms (canonical parametric ids out
 * of resolved variables or union members) go through coercionTargetsOf. The
 * registry-gated merge (list<asset<T>> -> scalar T) counts as maybe-legal:
 * the merge-provider registry is server-side, so backend document validation
 * owns the final refusal.
 */
export function assetCoercible(from: TypeExpr, to: TypeExpr): boolean {
  // Structural forms first: peel the constructor, compare DIRECTLY (the
  // recursion never re-enters coercion, keeping the single-step limit).
  if (from.kind === 'asset') return typesDirectlyCompatible(from.element, to) // decode
  if (from.kind === 'list' && from.element.kind === 'asset') {
    const decoded = from.element.element
    return (
      typesDirectlyCompatible({ kind: 'list', element: decoded }, to) || // lift
      typesDirectlyCompatible(decoded, to) // registry-gated merge
    )
  }
  const fromAtoms = atomNamesOf(from)
  if (fromAtoms === undefined) return false
  return fromAtoms.some((fa) =>
    coercionTargetsOf(fa).some((target) => typesDirectlyCompatible(typeExprFromTypeId(target), to)),
  )
}
