/**
 * Core widget kinds + compact views: INT, FLOAT, STRING, BOOLEAN, COMBO,
 * COLOR, ASSET, SAVE_TARGET.
 *
 * Semantics (WidgetKind) and presentation (WidgetView) are separate by
 * contract. The string kind declares its default view from the multiline
 * hint so view selection stays descriptor-driven.
 */

import type {
  CompactState,
  Diagnostic,
  Json,
  PackActivationApi,
  PreviewRenderer,
  SceneBuilder,
  WidgetKind,
  WidgetRegistry,
  WidgetSpec,
  WidgetView,
  TypeExpr,
  IntegerWidgetValue,
} from '@dinkster/core'
import { canonicalTypeIdOf, diag, EMPTY_COMPOSITOR_RECIPE, formatWidgetValue, isCanonicalUnsafeInteger, isCompositorRecipe, isIntegerWidgetValue, normalizedComboOptions, numericStepConstraints, numericStepPrecision } from '@dinkster/core'

// ---------------------------------------------------------------------------
// Kind helpers
// ---------------------------------------------------------------------------

const numberSchema = {
  version: 1,
  validate: (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v),
}
const stringSchema = {
  version: 1,
  validate: (v: unknown): v is string => typeof v === 'string',
}
const booleanSchema = {
  version: 1,
  validate: (v: unknown): v is boolean => typeof v === 'boolean',
}

export interface AssetRef {
  readonly digest: string
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly virtualPath: string
}

const isAssetRef = (v: unknown): v is AssetRef => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const asset = v as Partial<AssetRef>
  return typeof asset.digest === 'string' && /^blake3:[0-9a-f]{64}$/.test(asset.digest) &&
    typeof asset.name === 'string' && typeof asset.size === 'number' && Number.isSafeInteger(asset.size) && asset.size >= 0 &&
    typeof asset.mediaType === 'string' && typeof asset.virtualPath === 'string'
}

/**
 * Structured save destination (schema wire v5, backend 6b9d874). A save
 * target is DATA - mount id plus relative stem prefix - never a raw host
 * path; real paths exist only on the operator surface (/api/mounts).
 */
export interface SaveTarget {
  readonly mount: string
  readonly prefix: string
}

/** Backend mount-id grammar (names.py family): lowercase, dash/underscore separated. */
const MOUNT_ID_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/

/**
 * Grammar problems for a candidate save target, empty when valid. One
 * validator shared by the widget kind (document diagnostics) and the editor
 * (commit gate), so "what the frontend refuses" cannot drift between them.
 * Mirrors the backend's strict rules: mapping only, mount grammar, relative
 * /-separated prefix whose last segment is the filename STEM (the node owns
 * the extension); absolute paths, backslashes, empty segments, '.', and
 * '..' all refuse.
 */
export function saveTargetIssues(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['save target must be an object {mount, prefix}, not a raw string or other value']
  }
  const target = value as Partial<SaveTarget>
  const issues: string[] = []
  if (typeof target.mount !== 'string' || !MOUNT_ID_RE.test(target.mount)) {
    issues.push(`mount id '${String(target.mount)}' is not a valid mount id`)
  }
  if (typeof target.prefix !== 'string' || target.prefix === '') {
    issues.push('prefix must be a non-empty string')
  } else if (target.prefix.includes('\\')) {
    issues.push('prefix must use / separators, not backslashes')
  } else {
    for (const segment of target.prefix.split('/')) {
      if (segment === '') {
        issues.push('prefix must be relative with no empty segments (no leading, trailing, or doubled /)')
        break
      }
      if (segment === '.' || segment === '..') {
        issues.push(`prefix segment '${segment}' is not allowed`)
        break
      }
    }
  }
  return issues
}

const isSaveTargetShape = (v: unknown): v is SaveTarget => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const target = v as Partial<SaveTarget>
  return typeof target.mount === 'string' && typeof target.prefix === 'string'
}

export const isSaveTarget = (v: unknown): v is SaveTarget => saveTargetIssues(v).length === 0

/** Descriptor-only SAVE_TARGET presentation; no node-name or path inference. */
export function saveTargetPresentation(
  spec: WidgetSpec,
  declaredType?: TypeExpr,
): { readonly canonicalType: string; readonly suffix: string; readonly outputFormat: string } {
  const suffix = typeof spec.options['suffix'] === 'string' ? spec.options['suffix'] : ''
  return {
    canonicalType: (declaredType === undefined ? undefined : canonicalTypeIdOf(declaredType)) ?? spec.widgetType,
    suffix,
    outputFormat: suffix === '' ? 'generic' : suffix,
  }
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

function rangeDiags(value: number, spec: WidgetSpec, type: string): Diagnostic[] {
  const out: Diagnostic[] = []
  const min = spec.options['min']
  const max = spec.options['max']
  if (typeof min === 'number' && value < min) {
    out.push(diag('warning', 'schema', `widget.${type}.belowMin`, `${value} < min ${min}`))
  }
  if (typeof max === 'number' && value > max) {
    out.push(diag('warning', 'schema', `widget.${type}.aboveMax`, `${value} > max ${max}`))
  }
  return out
}

function integerRangeDiags(value: IntegerWidgetValue, spec: WidgetSpec): Diagnostic[] {
  if (typeof value === 'number') {
    return [
      ...(Number.isInteger(value) ? [] : [diag('warning', 'schema', 'widget.INT.notInteger', `${value} is not an integer`)]),
      ...rangeDiags(value, spec, 'INT'),
    ]
  }
  const out: Diagnostic[] = []
  const numeric = BigInt(value)
  const min = spec.options['min']
  const max = spec.options['max']
  if ((Number.isSafeInteger(min) || isCanonicalUnsafeInteger(min)) && numeric < BigInt(min as number | string)) {
    out.push(diag('warning', 'schema', 'widget.INT.belowMin', `${value} < min ${String(min)}`))
  }
  if ((Number.isSafeInteger(max) || isCanonicalUnsafeInteger(max)) && numeric > BigInt(max as number | string)) {
    out.push(diag('warning', 'schema', 'widget.INT.aboveMax', `${value} > max ${String(max)}`))
  }
  return out
}

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export const intKind: WidgetKind<IntegerWidgetValue> = {
  type: 'INT',
  valueSchema: { version: 1, validate: isIntegerWidgetValue },
  defaultValue: (spec) => isIntegerWidgetValue(spec.default)
    ? spec.default
    : isIntegerWidgetValue(spec.options['min']) ? spec.options['min'] : 0,
  validate: (value, spec) => integerRangeDiags(value, spec),
  defaultView: () => 'core.number',
}

export const floatKind: WidgetKind<number> = {
  type: 'FLOAT',
  valueSchema: numberSchema,
  defaultValue: (spec) => num(spec.default, num(spec.options['min'], 0)),
  validate: (value, spec) => rangeDiags(value, spec, 'FLOAT'),
  defaultView: () => 'core.number',
}

export const stringKind: WidgetKind<string> = {
  type: 'STRING',
  valueSchema: stringSchema,
  defaultValue: (spec) => (typeof spec.default === 'string' ? spec.default : ''),
  validate: () => [],
  // The multiline hint picks the DEFAULT view; the user may switch views
  // freely (same value shape) - the old forced multiline/singleline split
  // is a default, not a wall.
  defaultView: (spec) => (spec.options['multiline'] === true ? 'core.text' : 'core.line'),
}

export const booleanKind: WidgetKind<boolean> = {
  type: 'BOOLEAN',
  valueSchema: booleanSchema,
  defaultValue: (spec) => spec.default === true,
  validate: () => [],
  defaultView: () => 'core.toggle',
}

export const comboKind: WidgetKind<Json> = {
  type: 'COMBO',
  // NaN/Infinity are not JSON numbers: they cannot round-trip a document.
  valueSchema: { version: 1, validate: (v: unknown): v is Json => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) },
  defaultValue: (spec) => {
    if (comboKind.valueSchema.validate(spec.default)) return spec.default
    for (const option of normalizedComboOptions(spec)) {
      const value = option.value
      if (comboKind.valueSchema.validate(value)) return value
    }
    return ''
  },
  validate: (value, spec) => {
    // Out-of-vocabulary severity split (v13 joint pin, frontend-owned per
    // the v9 combo contract): a STATIC-only combo's options are the whole
    // vocabulary, so a value outside it is error-grade; a REMOTE combo's
    // static options are a startup-frozen snapshot that may be stale, so
    // membership failure only warns. A remote combo with no static list
    // has no local vocabulary at all - anything validates locally.
    const options = normalizedComboOptions(spec)
    if (options.length === 0 && !Array.isArray(spec.options['options'])) return []
    if (options.some((option) => option.value === value)) return []
    return spec.remote
      ? [diag('warning', 'schema', 'widget.COMBO.unknownOption', `'${String(value)}' is not in the last-known option snapshot (the remote list may have changed)`)]
      : [diag('error', 'schema', 'widget.COMBO.unknownOption', `'${String(value)}' is not in the option list`)]
  },
  defaultView: () => 'core.select',
}

export const multiComboKind: WidgetKind<string[]> = {
  type: 'MULTI_COMBO',
  valueSchema: { version: 1, validate: (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string') },
  defaultValue: (spec) => Array.isArray(spec.default) && spec.default.every((item) => typeof item === 'string') ? [...spec.default] as string[] : [],
  validate: (value, spec) => {
    const raw = spec.options['options']
    if (!Array.isArray(raw)) return []
    const options = normalizedComboOptions(spec).map((option) => option.value)
    return value.filter((item) => !options.includes(item)).map((item) => spec.remote
      ? diag('warning', 'schema', 'widget.MULTI_COMBO.unknownOption', `'${item}' is not in the last-known option snapshot (the remote list may have changed)`)
      : diag('error', 'schema', 'widget.MULTI_COMBO.unknownOption', `'${item}' is not in the option list`))
  },
  defaultView: () => 'core.multiSelect',
}

export const colorKind: WidgetKind<string> = {
  type: 'COLOR',
  valueSchema: stringSchema,
  defaultValue: (spec) => typeof spec.default === 'string' ? spec.default : '#ffffff',
  // COLOR is a presentation hint over canonical core.string. Preserve every
  // string exactly; color parsing and normalization are view-only concerns.
  validate: () => [],
  defaultView: () => 'core.color',
}

export interface CurvePoint {
  readonly position: number
  readonly value: number
}

export interface CurveValue {
  readonly interpolation?: 'linear' | 'monotone_cubic'
  readonly points: readonly CurvePoint[]
}

const hasExactKeys = (value: object, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

export function isCurveValue(value: unknown): value is CurveValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const curve = value as Partial<CurveValue>
  if (curve.interpolation !== undefined && curve.interpolation !== 'linear' && curve.interpolation !== 'monotone_cubic') return false
  if (!hasExactKeys(value, curve.interpolation === undefined ? ['points'] : ['interpolation', 'points'])) return false
  if (!Array.isArray(curve.points) || curve.points.length < 1 || curve.points.length > 4096) return false
  let previous = -Infinity
  return curve.points.every((point) => {
    if (typeof point !== 'object' || point === null || Array.isArray(point)) return false
    if (!hasExactKeys(point, ['position', 'value'])) return false
    const candidate = point as Partial<CurvePoint>
    const valid = typeof candidate.position === 'number' && Number.isFinite(candidate.position) &&
      typeof candidate.value === 'number' && Number.isFinite(candidate.value) && candidate.position > previous
    if (valid) previous = candidate.position!
    return valid
  })
}

// Log-domain slopes keep finite input curves from overflowing during secant construction.
interface SignedLogMagnitude {
  readonly sign: -1 | 0 | 1
  readonly logMagnitude: number
}

const ZERO_SLOPE: SignedLogMagnitude = { sign: 0, logMagnitude: -Infinity }
const LOG_THREE = Math.log(3)

const logDifferenceMagnitude = (left: number, right: number): number => {
  if (left === right) return -Infinity
  if ((left < 0) === (right < 0)) return Math.log(Math.abs(right - left))
  const high = Math.max(Math.abs(left), Math.abs(right))
  const low = Math.min(Math.abs(left), Math.abs(right))
  return Math.log(high) + Math.log1p(low / high)
}

const secant = (left: CurvePoint, right: CurvePoint): SignedLogMagnitude => {
  const direction = Math.sign(right.value - left.value) as -1 | 0 | 1
  return direction === 0
    ? ZERO_SLOPE
    : {
        sign: direction,
        logMagnitude: logDifferenceMagnitude(left.value, right.value) -
          logDifferenceMagnitude(left.position, right.position),
      }
}

const meanSlope = (
  left: SignedLogMagnitude,
  right: SignedLogMagnitude,
): SignedLogMagnitude => {
  if (left.sign === 0 || left.sign !== right.sign) return ZERO_SLOPE
  const high = Math.max(left.logMagnitude, right.logMagnitude)
  const low = Math.min(left.logMagnitude, right.logMagnitude)
  return {
    sign: left.sign,
    logMagnitude: high + Math.log1p(Math.exp(low - high)) - Math.log(2),
  }
}

const ratioLog = (slope: SignedLogMagnitude, base: SignedLogMagnitude): number =>
  slope.sign === 0 || slope.sign !== base.sign
    ? -Infinity
    : slope.logMagnitude - base.logMagnitude

const limitedRatioVector = (leftLog: number, rightLog: number): readonly [number, number] => {
  const high = Math.max(leftLog, rightLog)
  if (high === -Infinity) return [0, 0]
  const left = Math.exp(leftLog - high)
  const right = Math.exp(rightLog - high)
  const magnitude = Math.hypot(left, right)
  return [3 * left / magnitude, 3 * right / magnitude]
}

const scaledSlope = (base: SignedLogMagnitude, ratio: number): SignedLogMagnitude =>
  ratio === 0
    ? ZERO_SLOPE
    : { sign: base.sign, logMagnitude: base.logMagnitude + Math.log(ratio) }

const ordinaryTangentRatios = (
  points: readonly CurvePoint[],
): readonly (readonly [number, number])[] | undefined => {
  const secants = points.slice(1).map((point, index) =>
    (point.value - points[index]!.value) / (point.position - points[index]!.position))
  if (secants.some((value) => !Number.isFinite(value))) return undefined
  const slopes = [secants[0]!]
  for (let index = 1; index < points.length - 1; index += 1) {
    const left = secants[index - 1]!
    const right = secants[index]!
    const slope = left * right <= 0 ? 0 : (left + right) / 2
    if (!Number.isFinite(slope)) return undefined
    slopes.push(slope)
  }
  slopes.push(secants.at(-1)!)
  for (const [index, base] of secants.entries()) {
    if (base === 0) {
      slopes[index] = 0
      slopes[index + 1] = 0
      continue
    }
    const left = slopes[index]! / base
    const right = slopes[index + 1]! / base
    const magnitude = Math.hypot(left, right)
    if (!Number.isFinite(magnitude)) return undefined
    if (magnitude <= 3) continue
    slopes[index] = 3 * left / magnitude * base
    slopes[index + 1] = 3 * right / magnitude * base
    if (!Number.isFinite(slopes[index]) || !Number.isFinite(slopes[index + 1])) return undefined
  }
  const ratios = secants.map((base, index): readonly [number, number] => base === 0
    ? [0, 0]
    : [slopes[index]! / base, slopes[index + 1]! / base])
  return ratios.some(([left, right]) => !Number.isFinite(left) || !Number.isFinite(right))
    ? undefined
    : ratios
}

const logarithmicTangentRatios = (points: readonly CurvePoint[]): readonly (readonly [number, number])[] => {
  const secants = points.slice(1).map((point, index) => secant(points[index]!, point))
  const slopes: SignedLogMagnitude[] = [secants[0]!]
  for (let index = 1; index < points.length - 1; index += 1) {
    slopes.push(meanSlope(secants[index - 1]!, secants[index]!))
  }
  slopes.push(secants.at(-1)!)
  for (const [index, base] of secants.entries()) {
    if (base.sign === 0) {
      slopes[index] = ZERO_SLOPE
      slopes[index + 1] = ZERO_SLOPE
      continue
    }
    const leftLog = ratioLog(slopes[index]!, base)
    const rightLog = ratioLog(slopes[index + 1]!, base)
    const high = Math.max(leftLog, rightLog)
    const magnitude = high <= LOG_THREE
      ? Math.hypot(Math.exp(leftLog), Math.exp(rightLog))
      : Infinity
    if (magnitude <= 3) continue
    const [left, right] = limitedRatioVector(leftLog, rightLog)
    slopes[index] = scaledSlope(base, left)
    slopes[index + 1] = scaledSlope(base, right)
  }
  return secants.map((base, index) => [
    Math.exp(ratioLog(slopes[index]!, base)),
    Math.exp(ratioLog(slopes[index + 1]!, base)),
  ])
}

export function curveInterpolator(curve: CurveValue): (position: number) => number {
  const points = curve.points
  if (points.length === 1) return () => points[0]!.value
  const tangents = (curve.interpolation ?? 'linear') === 'monotone_cubic'
    ? ordinaryTangentRatios(points) ?? logarithmicTangentRatios(points)
    : []
  return (position) => {
    if (position <= points[0]!.position) return points[0]!.value
    if (position >= points.at(-1)!.position) return points.at(-1)!.value
    let low = 0
    let high = points.length - 1
    while (low < high - 1) {
      const middle = (low + high) >> 1
      if (points[middle]!.position <= position) low = middle
      else high = middle
    }
    const left = points[low]!
    const right = points[high]!
    const span = right.position - left.position
    const amount = Number.isFinite(span)
      ? (position - left.position) / span
      : (() => {
          const scale = Math.max(Math.abs(left.position), Math.abs(right.position), Math.abs(position), 1)
          return (position / scale - left.position / scale) /
            (right.position / scale - left.position / scale)
        })()
    if ((curve.interpolation ?? 'linear') === 'linear') {
      return (1 - amount) * left.value + amount * right.value
    }
    const amount2 = amount * amount
    const amount3 = amount2 * amount
    const scale = Math.max(Math.abs(left.value), Math.abs(right.value))
    if (scale === 0) return 0
    const scaledLeft = left.value / scale
    const scaledRight = right.value / scale
    const delta = scaledRight - scaledLeft
    const [leftTangent, rightTangent] = tangents[low]!
    const value = (2 * amount3 - 3 * amount2 + 1) * scaledLeft
      + (amount3 - 2 * amount2 + amount) * leftTangent * delta
      + (-2 * amount3 + 3 * amount2) * scaledRight
      + (amount3 - amount2) * rightTangent * delta
    return Math.max(Math.min(scaledLeft, scaledRight), Math.min(Math.max(scaledLeft, scaledRight), value)) * scale
  }
}

export const curveKind: WidgetKind<Json> = {
  type: 'CURVE',
  valueSchema: { version: 1, validate: (value): value is Json => isCurveValue(value) },
  defaultValue: (spec) => isCurveValue(spec.default)
    ? spec.default as unknown as Json
    : { interpolation: 'monotone_cubic', points: [{ position: 0, value: 0 }, { position: 1, value: 1 }] },
  validate: () => [],
  defaultView: () => 'core.curve',
}

export const compositorKind: WidgetKind<Json> = {
  type: 'COMPOSITOR',
  valueSchema: { version: 1, validate: (value): value is Json => isCompositorRecipe(value) },
  defaultValue: (spec) => isCompositorRecipe(spec.default)
    ? spec.default as unknown as Json
    : EMPTY_COMPOSITOR_RECIPE as unknown as Json,
  validate: () => [],
  defaultView: () => 'core.compositor',
}

/**
 * Multi-select values (typed-assets pin (5)): a list-declared asset input
 * (`list<asset<T>>` / `list<dinkster.asset>`) stores an ARRAY of AssetRefs -
 * N selections are N descriptors in a list literal, no new server surface.
 * The value schema accepts arrays regardless of the declared type so a
 * document always LOADS; a shape/cardinality mismatch is the backend's
 * structural list-into-scalar refusal at submit, never a vanishing value.
 */
export const isAssetRefList = (v: unknown): v is readonly AssetRef[] =>
  Array.isArray(v) && v.every(isAssetRef)

/** Null is the JSON representation of an explicitly cleared optional asset. */
export const assetKind: WidgetKind<Json> = {
  type: 'ASSET',
  valueSchema: { version: 1, validate: (v: unknown): v is Json => v === null || isAssetRef(v) || isAssetRefList(v) },
  defaultValue: (spec) => isAssetRef(spec.default) || isAssetRefList(spec.default) ? spec.default as unknown as Json : null,
  validate: () => [],
  defaultView: () => 'core.asset',
}

/**
 * Null is an explicitly unset optional target (the node's schema default
 * applies at execution). The value schema accepts any {mount, prefix} string
 * pair so a document authored against a different mount set still LOADS;
 * grammar violations surface as validate() warnings instead of vanishing
 * values - the backend refuses them loudly at submit either way.
 */
export const saveTargetKind: WidgetKind<Json> = {
  type: 'SAVE_TARGET',
  valueSchema: { version: 1, validate: (v: unknown): v is Json => v === null || isSaveTargetShape(v) },
  defaultValue: (spec) => (isSaveTarget(spec.default) ? (spec.default as unknown as Json) : null),
  validate: (value) => {
    if (value === null) return []
    return saveTargetIssues(value).map((issue) => diag('warning', 'schema', 'widget.SAVE_TARGET.invalid', issue))
  },
  defaultView: () => 'core.saveTarget',
}

const isJsonObject = (value: unknown): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finiteField = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value))

const integerField = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isSafeInteger(value))

export const videoEditKind: WidgetKind<Json> = {
  type: 'VIDEO_EDIT',
  // Unknown object fields are imported workflow data. They remain valid so
  // editing one known section never makes another producer's data disappear.
  valueSchema: { version: 1, validate: (value): value is Json => isJsonObject(value) },
  defaultValue: (spec) => isJsonObject(spec.default) ? spec.default : {},
  validate: (value) => {
    const edit = value as Record<string, Json>
    const diagnostics: Diagnostic[] = []
    if (edit.trim !== undefined && (!isJsonObject(edit.trim)
      || !finiteField(edit.trim.start_time) || !finiteField(edit.trim.duration))) {
      diagnostics.push(diag('warning', 'schema', 'widget.VIDEO_EDIT.invalidTrim', 'trim must contain finite start_time and duration values'))
    }
    if (edit.crop !== undefined && (!isJsonObject(edit.crop)
      || !integerField(edit.crop.x) || !integerField(edit.crop.y)
      || !integerField(edit.crop.width) || !integerField(edit.crop.height))) {
      diagnostics.push(diag('warning', 'schema', 'widget.VIDEO_EDIT.invalidCrop', 'crop must contain integer x, y, width, and height values'))
    }
    return diagnostics
  },
  defaultView: () => 'core.videoEdit',
}

// ---------------------------------------------------------------------------
// Compact views
// ---------------------------------------------------------------------------

/** Shared compact layout: non-overlapping label/value/control zones. */
function compactRow(
  ctx: SceneBuilder,
  label: string,
  value: string,
  state: CompactState,
  action: string,
  placeholder = false,
  valueStyle: Readonly<Record<string, unknown>> = {},
): void {
  ctx.rect(0, 0, 1, 1, { role: 'widgetBackground', focused: state.focused, connected: state.connected })
  // The view-internal label is usually '' (the painter draws the real row
  // label in its own zone); an empty label must not reserve value space.
  if (label !== '') ctx.text(0, 0, label, { role: 'widgetLabel', width: 0.42 })
  ctx.text(1, 0, value, {
    role: 'widgetValue', align: 'right', width: label === '' ? 1 : 0.58,
    truncated: state.truncated ?? false, ...(placeholder ? { placeholder: true } : {}),
    ...valueStyle,
  })
  if (!state.readonly) ctx.hitRegion(0, 0, 1, 1, action)
}

const fmt = (v: unknown): string =>
  typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0')) : String(v ?? '')

/** FLOAT compact text follows schema step precision and retains trailing 0s. */
export function formatCompactFloat(value: number, spec: WidgetSpec): string {
  return formatWidgetValue(value, spec)
}

export { numericStepPrecision }

function makeCompactView<V extends Json>(id: string, kind: string, rows = 1): WidgetView<V> {
  return {
    id,
    kind,
    isCompatible: () => true,
    measure: () => ({ rows }),
    drawCompact(ctx, value, spec, state) {
      const label = (spec.options['display_name'] as string | undefined) ?? ''
      compactRow(ctx, label, fmt(value), state, `widget.edit`)
    },
  }
}

function numericRangeFraction(value: number, spec: WidgetSpec): number | undefined {
  const min = spec.options['min']
  const max = spec.options['max']
  if (typeof min !== 'number' || typeof max !== 'number'
    || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return undefined
  if (Number.isNaN(value)) return undefined
  if (value <= min) return 0
  if (value >= max) return 1
  const span = max - min
  const fraction = Number.isFinite(span)
    ? (value - min) / span
    : (value / 2 - min / 2) / (max / 2 - min / 2)
  return Math.max(0, Math.min(1, fraction))
}

function drawCompactNumber(
  ctx: SceneBuilder,
  value: number | string,
  spec: WidgetSpec,
  state: CompactState,
  formatted: string,
): void {
  const fraction = spec.options['display'] === 'slider' && typeof value === 'number'
    ? numericRangeFraction(value, spec)
    : undefined
  if (fraction !== undefined) {
    ctx.rect(0, 0, fraction, 1, { role: 'numericRangeFill', fraction })
  }
  const label = (spec.options['display_name'] as string | undefined) ?? ''
  compactRow(ctx, label, formatted, state, 'widget.edit')
}

export const numberView: WidgetView<IntegerWidgetValue> = {
  ...makeCompactView<IntegerWidgetValue>('core.number', 'INT'),
  drawCompact(ctx, value, spec, state) {
    drawCompactNumber(ctx, value, spec, state, String(value))
  },
}
export const floatNumberView: WidgetView<number> = {
  ...makeCompactView<number>('core.number', 'FLOAT'),
  drawCompact(ctx, value, spec, state) {
    drawCompactNumber(ctx, value, spec, state, formatCompactFloat(value, spec))
  },
}
export const lineView: WidgetView<string> = {
  ...makeCompactView<string>('core.line', 'STRING'),
  drawCompact(ctx, value, spec, state) {
    const label = (spec.options['display_name'] as string | undefined) ?? ''
    const placeholder = value === '' && typeof spec.options['placeholder'] === 'string'
    compactRow(ctx, label, placeholder ? spec.options['placeholder'] as string : value, state, 'widget.edit', placeholder)
  },
}
/** Multiline preview: canonical lines are emitted independently for row clipping. */
export const textView: WidgetView<string> = {
  ...makeCompactView<string>('core.text', 'STRING', 2),
  drawCompact(ctx, value, spec, state) {
    const placeholder = value === ''
    const lines = placeholder
      ? [typeof spec.options['placeholder'] === 'string'
          ? spec.options['placeholder']
          : (spec.options['display_name'] as string | undefined) ?? '']
      : value.split('\n')
    ctx.rect(0, 0, 1, Math.max(2, lines.length), {
      role: 'widgetBackground', focused: state.focused, connected: state.connected,
    })
    for (const [row, line] of lines.entries()) {
      ctx.text(0, row, line, {
        role: 'widgetValue', width: 1, truncated: state.truncated ?? false,
        ...(placeholder ? { placeholder: true } : {}),
      })
    }
    if (!state.readonly) ctx.hitRegion(0, 0, 1, Math.max(2, lines.length), 'widget.edit')
  },
}
/** Custom toggle labels (wire v10): labelOn/labelOff replace true/false. */
export const toggleView: WidgetView<boolean> = {
  ...makeCompactView<boolean>('core.toggle', 'BOOLEAN'),
  drawCompact(ctx, value, spec, state) {
    const label = (spec.options['display_name'] as string | undefined) ?? ''
    const custom = spec.options[value ? 'labelOn' : 'labelOff']
    const text = typeof custom === 'string' && custom !== '' ? custom : fmt(value)
    ctx.rect(1, 0, 0, 1, { role: 'toggleAffordance', checked: value })
    compactRow(ctx, label, text, state, 'widget.edit', false, { reserveRight: 24 })
  },
}
export const selectView: WidgetView<Json> = {
  ...makeCompactView<Json>('core.select', 'COMBO'),
  drawCompact(ctx, value, spec, state) {
    const label = (spec.options['display_name'] as string | undefined) ?? ''
    ctx.rect(1, 0, 0, 1, { role: 'comboChevron' })
    compactRow(ctx, label, formatWidgetValue(value, spec), state, 'widget.edit')
  },
}
export const multiSelectView: WidgetView<string[]> = {
  ...makeCompactView<string[]>('core.multiSelect', 'MULTI_COMBO'),
  drawCompact(ctx, value, spec, state) {
    const label = (spec.options['display_name'] as string | undefined) ?? ''
    compactRow(ctx, label, `${value.length} selected`, state, 'widget.edit')
  },
}
export const colorView: WidgetView<string> = {
  ...makeCompactView<string>('core.color', 'COLOR'),
  drawCompact(ctx, value, spec, state) {
    const label = (spec.options['display_name'] as string | undefined) ?? ''
    ctx.rect(0, 0, 1, 1, { role: 'widgetBackground', focused: state.focused, connected: state.connected })
    ctx.text(0, 0, label, { role: 'widgetLabel', width: 0.42 })
    // A compact square leaves the remaining row for the exact stored text;
    // alpha remains visible even though canvas fill colors also consume it.
    ctx.rect(0, 0.2, 0.12, 0.6, { fill: value, fixedAspect: 'square' })
    ctx.text(1, 0, value, {
      role: 'widgetValue', align: 'right', width: 1, reserveLeft: 16, truncated: state.truncated ?? false,
    })
    if (!state.readonly) ctx.hitRegion(0, 0, 1, 1, 'widget.edit')
  },
}
export const curveView: WidgetView<Json> = {
  id: 'core.curve',
  kind: 'CURVE',
  isCompatible: () => true,
  measure: () => ({ rows: 2 }),
  drawCompact(ctx, value, spec, state) {
    const curve = isCurveValue(value) ? value : curveKind.defaultValue(spec) as unknown as CurveValue
    ctx.rect(0, 0, 1, 2, { role: 'widgetBackground', focused: state.focused, connected: state.connected })
    const points = curve.points
    const minX = points[0]?.position ?? 0
    const maxX = points.at(-1)?.position ?? 1
    const spanX = maxX - minX || 1
    const interpolate = curveInterpolator(curve)
    for (let index = 0; index < 64; index += 1) {
      const fraction = index / 63
      const sample = interpolate(minX + fraction * spanX)
      ctx.rect(fraction, 1.8 - Math.max(0, Math.min(1, sample)) * 1.6, 0.02, 0.08,
        { role: 'curveSample' })
    }
    ctx.text(1, 0, `${points.length} points - ${curve.interpolation ?? 'linear'}`, { role: 'widgetValue', align: 'right', width: 1 })
    if (!state.readonly) ctx.hitRegion(0, 0, 1, 2, 'widget.edit')
  },
}
export const compositorView: WidgetView<Json> = {
  id: 'core.compositor',
  kind: 'COMPOSITOR',
  isCompatible: () => true,
  measure: () => ({ rows: 2 }),
  drawCompact(ctx, value, spec, state) {
    const recipe = isCompositorRecipe(value) ? value : undefined
    const label = (spec.options['display_name'] as string | undefined) ?? 'Compositor'
    ctx.rect(0, 0, 1, 2, { role: 'widgetBackground', focused: state.focused, connected: state.connected })
    ctx.text(0, 0, label, { role: 'widgetLabel', width: 1 })
    ctx.text(1, 1, recipe?.documentDigest
      ? `${recipe.commands.length} document edit${recipe.commands.length === 1 ? '' : 's'}`
      : 'Run to load layers', { role: 'widgetValue', align: 'right', width: 1 })
    if (!state.readonly) ctx.hitRegion(0, 0, 1, 2, 'widget.edit')
  },
}
export const assetView: WidgetView<Json> = {
  ...makeCompactView<Json>('core.asset', 'ASSET'),
  drawCompact(ctx, value, spec, state) {
    const label = (spec.options['display_name'] as string | undefined) ?? ''
    const text = isAssetRef(value)
      ? value.name
      : isAssetRefList(value) && value.length > 0
        ? value.length === 1 ? value[0]!.name : `${value.length} assets`
        : 'no asset'
    const populated = isAssetRef(value) || (isAssetRefList(value) && value.length > 0)
    compactRow(ctx, label, text, state, 'widget.edit', !populated)
  },
}
export const saveTargetView: WidgetView<Json> = {
  ...makeCompactView<Json>('core.saveTarget', 'SAVE_TARGET'),
  drawCompact(ctx, value, spec, state) {
    const label = (spec.options['display_name'] as string | undefined) ?? ''
    // The suffix renders as display context (the produced filename ends with
    // it) but is never part of the stored prefix - the document holds the
    // stem only, the node owns the extension.
    const { suffix } = saveTargetPresentation(spec)
    const text = isSaveTargetShape(value) ? `${value.mount}:${value.prefix}${suffix}` : 'default target'
    compactRow(ctx, label, text, state, 'widget.edit')
  },
}
export const videoEditView: WidgetView<Json> = {
  ...makeCompactView<Json>('core.videoEdit', 'VIDEO_EDIT'),
  drawCompact(ctx, value, spec, state) {
    const edit = isJsonObject(value) ? value : {}
    const sections = [edit.trim === undefined ? undefined : 'trim', edit.crop === undefined ? undefined : 'crop'].filter(Boolean)
    compactRow(
      ctx,
      (spec.options['display_name'] as string | undefined) ?? '',
      sections.length === 0 ? 'no edits' : sections.join(' + '),
      state,
      'widget.edit',
      sections.length === 0,
    )
  },
}

const mediaPreviewRenderer = (
  id: string,
  mediaKind: NonNullable<PreviewRenderer['mediaKind']>,
  mimeFamily: string,
): PreviewRenderer => ({
  id,
  mediaKind,
  fallback: true,
  canRender: (channel) => channel.startsWith(`${mimeFamily}/`),
  drawCompact(ctx, frame) {
    ctx.rect(0, 0, 1, 1, { role: 'previewBackground' })
    ctx.text(0.5, 0.5, `${mediaKind} (${frame.channel})`, { role: 'previewFallback', align: 'center' })
  },
})

export const imagePreviewRenderer = mediaPreviewRenderer('core.image-preview', 'image', 'image')
export const videoPreviewRenderer = mediaPreviewRenderer('core.video-preview', 'video', 'video')
// model3d claims the model/* MIME family (model/gltf-binary and model/ply
// gaussian splats today); the host
// renders a poster still in-canvas and mounts an orbit viewport on demand.
export const model3dPreviewRenderer = mediaPreviewRenderer('core.model3d-preview', 'model3d', 'model')

// ---------------------------------------------------------------------------
// Registration (the only wiring; no private hooks)
// ---------------------------------------------------------------------------

export type WidgetRegistrationDoors = Pick<
  PackActivationApi,
  'widgetKind' | 'widgetView' | 'previewRenderer'
>

export const widgetRegistrationDoors = (registry: WidgetRegistry): WidgetRegistrationDoors => ({
  widgetKind: (_id, kind) => registry.registerKind(kind),
  widgetView: (_id, view) => registry.registerView(view),
  previewRenderer: (_id, renderer) => registry.registerPreviewRenderer(renderer),
})

export function registerCoreWidgets(doors: WidgetRegistrationDoors): void {
  for (const kind of [intKind, floatKind, stringKind, booleanKind, comboKind, multiComboKind,
    colorKind, curveKind, compositorKind, assetKind, saveTargetKind, videoEditKind]) {
    doors.widgetKind(kind.type, kind as WidgetKind)
  }
  for (const view of [numberView, floatNumberView, lineView, textView, toggleView, selectView,
    multiSelectView, colorView, curveView, compositorView, assetView, saveTargetView, videoEditView]) {
    doors.widgetView(view.id, view as WidgetView)
  }
  for (const renderer of [imagePreviewRenderer, videoPreviewRenderer, model3dPreviewRenderer]) {
    doors.previewRenderer(renderer.id, renderer)
  }
}
