/**
 * Framework-free widget commit helpers shared by the expanded widget editor
 * (WidgetEditor.tsx) and the app view's inline controls (AppView.tsx).
 * Deliberately free of solid-js/DOM imports so unit tests can import them
 * directly (same discipline as menu-target.ts / app-view-rows.ts).
 */

import { evaluateExpression, formatWidgetValue, integerWidgetValue, isCanonicalUnsafeInteger, isPrimitiveListWidgetValue, numericStepConstraints, specialValueLabel, spliceDiff, stepNumericValue, transformSplice, type IntegerWidgetValue, type Json, type TextSplice, type WidgetKind, type WidgetSpec } from '@dinkster/core'

export type NumericCommitResult = { readonly ok: true; readonly value: IntegerWidgetValue } | { readonly ok: false; readonly error: string }
type FloatNumericCommitResult = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string }

export type TextCommitResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'splice'; readonly splice: TextSplice }
  | { readonly kind: 'setValue' }

export function resolveTextCommit(openBase: Json | undefined, editorValue: string, currentStored: Json | undefined): TextCommitResult {
  if (typeof openBase !== 'string' || typeof currentStored !== 'string') return { kind: 'setValue' }
  const own = spliceDiff(openBase, editorValue)
  if (own === undefined) return { kind: 'none' }
  const foreign = spliceDiff(openBase, currentStored)
  const transformed = foreign === undefined ? own : transformSplice(own, foreign)
  if (transformed.deleteCount === 0 && transformed.insert === '') return { kind: 'none' }
  if (transformed.offset > currentStored.length || transformed.offset + transformed.deleteCount > currentStored.length) {
    return { kind: 'setValue' }
  }
  return { kind: 'splice', splice: transformed }
}

export function parseNumericCommit(raw: string, widgetType: 'FLOAT', round?: unknown, precision?: unknown): FloatNumericCommitResult
export function parseNumericCommit(raw: string, widgetType: 'INT', round?: unknown, precision?: unknown): NumericCommitResult
export function parseNumericCommit(raw: string, widgetType: 'INT' | 'FLOAT', round?: unknown, precision?: unknown): NumericCommitResult
export function parseNumericCommit(raw: string, widgetType: 'INT' | 'FLOAT', round?: unknown, precision?: unknown): NumericCommitResult {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, error: 'Enter a finite number.' }
  if (widgetType === 'INT') {
    if (/^(?:0|-?[1-9][0-9]*)$/.test(trimmed)) {
      try {
        const value = integerWidgetValue(BigInt(trimmed))
        if (typeof value === 'number' || isCanonicalUnsafeInteger(value)) return { ok: true, value }
      } catch {
        // Fall through to the exact-integer error.
      }
    }
    return { ok: false, error: 'Enter an exact integer from -9223372036854775808 to 18446744073709551615.' }
  }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return { ok: false, error: 'Enter a finite number.' }
  if (typeof round !== 'number' || !Number.isFinite(round) || round <= 0) return { ok: true, value: parsed }
  const quantized = Math.round(parsed / round) * round
  if (!Number.isFinite(quantized)) return { ok: true, value: parsed }
  const places = typeof precision === 'number' && Number.isInteger(precision) && precision >= 0 && precision <= 100
    ? precision : Math.max(0, -Math.floor(Math.log10(round)))
  return { ok: true, value: places <= 100 ? Number(quantized.toFixed(places)) : quantized }
}

/**
 * What Enter would store for the text typed into an in-row number field.
 * `result` is the outcome of typed arithmetic ("= 48"); `problem` says what
 * Enter corrects or keeps. Typing is never refused: a number past a limit or
 * off a whole-number step is corrected, and anything that is not a number
 * keeps the stored value. Text today's parser accepts is read by it, so
 * exact 64-bit integers and forms like 1e-3 behave as in every other field.
 */
export type TypedNumber =
  | { readonly kind: 'store'; readonly value: IntegerWidgetValue; readonly result?: string; readonly problem?: string }
  | { readonly kind: 'keep'; readonly problem: string }

export function resolveTypedNumber(raw: string, spec: WidgetSpec, stored: IntegerWidgetValue): TypedNumber {
  const constraints = numericStepConstraints(spec)
  const widgetType = constraints.integer ? 'INT' : 'FLOAT'
  const keep = (reason: string): TypedNumber =>
    ({ kind: 'keep', problem: `${reason} Enter keeps ${formatWidgetValue(stored, spec)}.` })
  const trimmed = raw.trim()
  const direct = parseNumericCommit(trimmed, widgetType, spec.options['round'], spec.options['precision'])
  let typed: bigint | number
  let result: string | undefined
  let fraction = false
  if (direct.ok) {
    typed = constraints.integer ? BigInt(direct.value) : direct.value as number
  } else {
    if (trimmed === '') return keep('Not a number.')
    // The evaluator follows Python, where ^ is not a power; say so instead of giving a surprise.
    if (trimmed.includes('^')) return keep('Use ** for a power.')
    let evaluated
    try {
      evaluated = evaluateExpression(trimmed, new Map())
    } catch {
      return keep('Not a number.')
    }
    if (evaluated.kind !== 'scalar' || !Number.isFinite(evaluated.float)) return keep('Not a number.')
    if (constraints.integer) {
      fraction = !Number.isInteger(evaluated.float)
      typed = fraction ? BigInt(Math.round(evaluated.float)) : evaluated.int
      result = `= ${fraction ? String(evaluated.float) : evaluated.int.toString()}`
    } else {
      const rounded = parseNumericCommit(String(evaluated.float), 'FLOAT', spec.options['round'], spec.options['precision'])
      typed = rounded.ok ? rounded.value as number : evaluated.float
      result = `= ${String(evaluated.float)}`
    }
  }
  const show = (value: IntegerWidgetValue) => formatWidgetValue(value, spec)
  const store = (value: IntegerWidgetValue, problem?: string): TypedNumber => ({
    kind: 'store',
    value,
    ...(result !== undefined ? { result } : {}),
    ...(problem !== undefined ? { problem } : {}),
  })
  // A declared special value is allowed outside the limits and off the step, so it is stored as typed.
  if (!fraction && specialValueLabel(typed, spec) !== undefined) {
    return store(constraints.integer ? integerWidgetValue(typed as bigint) : typed as number)
  }
  if (!constraints.integer) {
    const value = typed as number
    if (value > constraints.max) return store(constraints.max, `Above ${show(constraints.max)}. Enter uses ${show(constraints.max)}.`)
    if (value < constraints.min) return store(constraints.min, `Below ${show(constraints.min)}. Enter uses ${show(constraints.min)}.`)
    return store(value)
  }
  const value = typed as bigint
  if (constraints.max !== undefined && value > constraints.max) {
    const max = integerWidgetValue(constraints.max)
    return store(max, `Above ${show(max)}. Enter uses ${show(max)}.`)
  }
  if (constraints.min !== undefined && value < constraints.min) {
    const min = integerWidgetValue(constraints.min)
    return store(min, `Below ${show(min)}. Enter uses ${show(min)}.`)
  }
  // Whole numbers snap to the step counted from the field's offset (its lower
  // limit when none is declared), as the stepper does; a value that rounds
  // past a limit steps back inside it.
  const step = constraints.step
  const base = constraints.offset
  const distance = value - base
  const remainder = ((distance % step) + step) % step
  let snapped = base + distance - remainder + (remainder * 2n >= step ? step : 0n)
  if (constraints.max !== undefined && snapped > constraints.max) snapped -= step
  if (constraints.min !== undefined && snapped < constraints.min) snapped += step
  if (snapped !== value || fraction) {
    const uses = integerWidgetValue(snapped)
    return store(uses, `${step === 1n ? 'Whole numbers only.' : `Not a multiple of ${step}.`} Enter uses ${show(uses)}.`)
  }
  return store(integerWidgetValue(value))
}

/**
 * The side part's first line while an open field still holds its stored
 * value and that value is past a limit, or off a whole-number step, that
 * moved after it was stored. Such a value is kept: an unchanged field
 * stores nothing, so this is a plain note, not a problem.
 */
export function storedNumberNote(spec: WidgetSpec, stored: IntegerWidgetValue): string | undefined {
  const resolved = resolveTypedNumber(String(stored), spec, stored)
  if (resolved.kind !== 'store' || resolved.problem === undefined) return undefined
  return `${resolved.problem.slice(0, resolved.problem.indexOf(' Enter uses'))} Kept until you change it.`
}

/**
 * A stepper on an open field steps from what Enter would store at that
 * moment, ten steps with Shift, and gives the text that replaces what was
 * typed. Nothing is stored.
 */
export function stepTypedNumber(raw: string, spec: WidgetSpec, stored: IntegerWidgetValue, direction: -1 | 1, fast: boolean): string {
  const resolved = resolveTypedNumber(raw, spec, stored)
  let value = resolved.kind === 'store' ? resolved.value : stored
  const constraints = numericStepConstraints(spec)
  for (let index = 0; index < (fast ? 10 : 1); index += 1) value = stepNumericValue(value, direction, constraints)
  return String(value)
}

export function parsePrimitiveListCommit(raw: string, spec: WidgetSpec):
  { readonly ok: true; readonly value: Json[] } | { readonly ok: false; readonly error: string } {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return { ok: false, error: 'Enter a valid JSON array.' } }
  if (!isPrimitiveListWidgetValue(value, spec)) {
    return { ok: false, error: `Enter a JSON array of ${spec.element?.widgetType ?? 'primitive'} values. Quote integers outside the safe numeric range.` }
  }
  if (spec.element?.widgetType === 'FLOAT') {
    value = value.map((item) => {
      const parsed = parseNumericCommit(String(item), 'FLOAT', spec.element!.options['round'], spec.element!.options['precision'])
      return parsed.ok ? parsed.value : item
    })
  }
  return { ok: true, value: value as Json[] }
}

/**
 * Shared commit gate for widget value writes (expanded editor + app view).
 * A value failing the kind's SHAPE schema must never fall through to
 * node.setValue (which is schema-blind); only shape-valid values reach the
 * kind's semantic validate. Returns the blocking message, undefined = commit.
 */
export function widgetCommitError(
  kind: WidgetKind | undefined,
  value: Json,
  spec: WidgetSpec,
): string | undefined {
  if (kind === undefined) return undefined
  if (!kind.valueSchema.validate(value, spec)) return `Not a valid ${spec.widgetType} value.`
  // MULTI_COMBO vocabulary diagnostics are presentation-only: static OOV
  // values remain authoritative and editable rather than blocking commits.
  if (spec.widgetType === 'MULTI_COMBO') return undefined
  return kind.validate(value, spec).find((d) => d.severity === 'error')?.message
}
