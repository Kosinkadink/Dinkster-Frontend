import {
  MAX_INTEGER_WIDGET_VALUE,
  MIN_INTEGER_WIDGET_VALUE,
  effectiveWidgetDefault,
  formatWidgetValue,
  isCanonicalUnsafeInteger,
  numericStepConstraints,
  type WidgetSpec,
} from '@dinkster/core'

/** One labelled line of an open row's side part. */
export interface RowFieldFact {
  readonly key: 'range' | 'step' | 'default'
  readonly text: string
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
 * default. Each line appears only when there is something to show.
 */
export function numberFieldFacts(spec: WidgetSpec): readonly RowFieldFact[] {
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
  if (range !== undefined) facts.push({ key: 'range', text: range })
  facts.push({ key: 'step', text: String(constraints.step) })
  const fallback = effectiveWidgetDefault(spec)
  if (fallback !== undefined) facts.push({ key: 'default', text: formatWidgetValue(fallback, spec) })
  return facts
}
