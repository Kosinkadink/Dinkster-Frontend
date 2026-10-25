/**
 * Framework-free widget commit helpers shared by the expanded widget editor
 * (WidgetEditor.tsx) and the app view's inline controls (AppView.tsx).
 * Deliberately free of solid-js/DOM imports so unit tests can import them
 * directly (same discipline as menu-target.ts / app-view-rows.ts).
 */

import { integerWidgetValue, isCanonicalUnsafeInteger, isPrimitiveListWidgetValue, spliceDiff, transformSplice, type IntegerWidgetValue, type Json, type TextSplice, type WidgetKind, type WidgetSpec } from '@dinkster/core'

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
  if (!kind.valueSchema.validate(value)) return `Not a valid ${spec.widgetType} value.`
  // MULTI_COMBO vocabulary diagnostics are presentation-only: static OOV
  // values remain authoritative and editable rather than blocking commits.
  if (spec.widgetType === 'MULTI_COMBO') return undefined
  return kind.validate(value, spec).find((d) => d.severity === 'error')?.message
}
