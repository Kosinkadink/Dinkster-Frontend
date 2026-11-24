import {
  MAX_INTEGER_WIDGET_VALUE,
  MIN_INTEGER_WIDGET_VALUE,
  effectiveWidgetDefault,
  formatWidgetValue,
  isCanonicalUnsafeInteger,
  numericStepConstraints,
  type LookedState,
  type LookedWidgetField,
  type WidgetSpec,
} from '@dinkster/core'

/** One labelled line of an open row's side part. */
export interface RowFieldFact {
  readonly key: 'range' | 'step' | 'default'
  readonly text: string
  /** A lookup for this line is loading: the shared spinner goes before the text. */
  readonly busy?: true
  /** A dimmed line under the text, such as a lookup that could not refresh. */
  readonly note?: string
}

/**
 * What a limit's lookup says in place of its number while no answer for the
 * current arguments is in use; undefined when one is.
 */
function lookupWords(state: LookedState | undefined): { readonly text: string; readonly busy?: true } | undefined {
  switch (state?.state) {
    case undefined:
    case 'ready':
    case 'stale':
      return undefined
    case 'loading': return { text: 'loading...', busy: true }
    case 'waiting': return { text: `waiting for ${state.input}` }
    case 'paused': return state.kept ? undefined : { text: 'paused' }
    case 'off': return { text: 'not loaded in preview' }
    case 'unavailable': return { text: state.reason === 'file-unchecked' ? 'waiting for the file to be checked' : 'not available' }
  }
}

/**
 * Limits that only repeat the largest or smallest number a whole-number field
 * can hold, as many seeds declare. They say nothing, so they read as no limit.
 */
const TYPE_LIMITS: readonly bigint[] = [MIN_INTEGER_WIDGET_VALUE, 2n ** 63n - 1n, MAX_INTEGER_WIDGET_VALUE]

const declaredLimit = (value: unknown, integer: boolean): { exact: number | bigint; text: string } | undefined => {
  if (isCanonicalUnsafeInteger(value)) {
    const exact = BigInt(value)
    return integer && TYPE_LIMITS.includes(exact) ? undefined : { exact, text: value }
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  // A type limit parsed from JSON arrives rounded to the nearest number.
  if (integer && TYPE_LIMITS.some((limit) => Number(limit) === value)) return undefined
  return { exact: value, text: Number.isInteger(value) ? BigInt(value).toString() : String(value) }
}

/**
 * The limits an open number shows beside the node, in order: range, step,
 * default. Each line appears only when there is something to show. A limit
 * from a lookup changes only its own line, never to a warning: the line says
 * what the lookup is doing until an answer is in use.
 */
export function numberFieldFacts(
  spec: WidgetSpec,
  looked: Readonly<Partial<Record<LookedWidgetField, LookedState>>> = {},
): readonly RowFieldFact[] {
  const constraints = numericStepConstraints(spec)
  const facts: RowFieldFact[] = []
  const min = declaredLimit(spec.options['min'], constraints.integer)
  const max = declaredLimit(spec.options['max'], constraints.integer)
  // An inverted range is ignored when stepping, so it is not shown either.
  const inverted = min !== undefined && max !== undefined && min.exact > max.exact
  const range = inverted
    ? undefined
    : min !== undefined && max !== undefined
      ? `${min.text} to ${max.text}`
      : min !== undefined
        ? `${min.text} or more`
        : max !== undefined
          ? `${max.text} or less`
          : undefined
  const stale = (fields: readonly LookedWidgetField[]): { readonly note?: string } =>
    fields.some((field) => looked[field]?.state === 'stale') ? { note: 'could not update' } : {}
  const rangeWords = lookupWords(looked.min) ?? lookupWords(looked.max)
  if (rangeWords !== undefined) facts.push({ key: 'range', ...rangeWords })
  else if (range !== undefined) facts.push({ key: 'range', text: range, ...stale(['min', 'max']) })
  const stepWords = lookupWords(looked.step)
  facts.push(stepWords !== undefined ? { key: 'step', ...stepWords } : { key: 'step', text: String(constraints.step), ...stale(['step']) })
  const fallback = effectiveWidgetDefault(spec)
  if (fallback !== undefined) facts.push({ key: 'default', text: formatWidgetValue(fallback, spec) })
  return facts
}
