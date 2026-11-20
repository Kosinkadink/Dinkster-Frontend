import {
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

const declaredLimit = (value: unknown): string | undefined =>
  (typeof value === 'number' && Number.isFinite(value)) || isCanonicalUnsafeInteger(value)
    ? String(value)
    : undefined

/**
 * The limits an open number shows beside the node, in order: range, step,
 * default. Text has none. Each line appears only when there is something to
 * show.
 */
export function rowFieldFacts(spec: WidgetSpec): readonly RowFieldFact[] {
  const numeric = spec.widgetType === 'INT' || spec.widgetType === 'FLOAT'
  const facts: RowFieldFact[] = []
  if (numeric) {
    const min = declaredLimit(spec.options['min'])
    const max = declaredLimit(spec.options['max'])
    if (min !== undefined && max !== undefined) facts.push({ key: 'range', text: `${min} to ${max}` })
    const constraints = numericStepConstraints(spec)
    facts.push({ key: 'step', text: String(constraints.step) })
  }
  const fallback = effectiveWidgetDefault(spec)
  if (numeric && fallback !== undefined) facts.push({ key: 'default', text: formatWidgetValue(fallback, spec) })
  return facts
}
