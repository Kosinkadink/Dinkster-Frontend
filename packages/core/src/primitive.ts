/**
 * Primitive nodes: a node whose output declares a known value from one of
 * its fields. That field's effective range and options are worked out from
 * the fields the output feeds, with the same merge rules as every other
 * derived widget, and the node's own limit fields (named by the known
 * value's `limits`) take precedence over the derived ones when they hold a
 * value known before the run. The result is never stored: a conflict is a
 * diagnostic, never a change to the value or the wires.
 */

import { diag, type Diagnostic } from './diagnostics.js'
import type { Json, NodeData } from './format/document.js'
import { specMergeFor } from './value-source.js'
import {
  inputsOf,
  outputsOf,
  type InputSpec,
  type KnownValueLimit,
  type NodeSchema,
  type BodyRow,
  type OptionRow,
  type OutputSpec,
  type WidgetSpec,
} from './schema/model.js'

/** The value field of a primitive node and the output that passes it on. */
export interface PrimitiveShape {
  readonly value: InputSpec
  readonly output: OutputSpec
  /** Limit name to the id of the input that holds it. */
  readonly limits: Readonly<Partial<Record<KnownValueLimit, string>>>
}

/** The primitive shape of a schema, when one of its outputs declares a known value. */
export function primitiveOf(schema: NodeSchema): PrimitiveShape | undefined {
  for (const output of outputsOf(schema)) {
    const known = output.knownValue
    if (known === undefined) continue
    const value = inputsOf(schema).find((input) => input.id === known.input)
    if (value === undefined) continue
    return { value, output, limits: known.limits ?? {} }
  }
  return undefined
}

/**
 * The primitive a wire dragged off a field makes: the one whose value has
 * the field's own type (Int for a whole number, Choice for a dropdown),
 * otherwise the general one whose type follows what it is wired to.
 */
export function primitiveForField(schemas: Iterable<NodeSchema>, field: InputSpec): NodeSchema | undefined {
  const typeName = field.widget?.widgetType ?? (field.type.kind === 'concrete' ? field.type.name : undefined)
  let general: NodeSchema | undefined
  for (const schema of [...schemas].sort((a, b) => a.type.localeCompare(b.type))) {
    const shape = primitiveOf(schema)
    if (shape === undefined || outputsOf(schema).length !== 1) continue
    const value = shape.value.type
    const output = shape.output.type
    if (value.kind === 'concrete' && output.kind === 'concrete' && value.name === typeName && output.name === typeName) return schema
    if (value.kind === 'variable' && output.kind === 'variable') general ??= schema
  }
  return general
}

/**
 * The schema with the primitive's value field drawn as its effective widget
 * and, when the fed fields share one, under their label.
 */
export function withPrimitiveValue(schema: NodeSchema, shape: PrimitiveShape, effective: EffectivePrimitiveSpec): NodeSchema {
  if (effective.spec === undefined && effective.label === undefined) return schema
  const patch = <T extends BodyRow | OptionRow>(rows: readonly T[]): T[] => rows.map((row): T => {
    if (row.kind === 'section' || row.kind === 'row') return { ...row, rows: patch(row.rows) }
    if (row.kind !== 'input' || row.id !== shape.value.id) return row
    return {
      ...row,
      ...(effective.spec !== undefined ? { widget: effective.spec } : {}),
      ...(effective.label !== undefined && row.displayName === undefined ? { displayName: effective.label } : {}),
    }
  })
  return { ...schema, body: patch(schema.body) }
}

const NUMERIC_LIMITS: readonly (readonly [KnownValueLimit, string])[] = [['min', 'min'], ['max', 'max'], ['step', 'step']]

/**
 * The limits a primitive holds itself: each named limit field whose stored
 * value is a number. An empty field, or one fed by a wire, counts as not
 * set, so that limit is derived from the fed fields.
 */
export function explicitPrimitiveLimits(
  shape: PrimitiveShape,
  node: NodeData,
  wired: (inputId: string) => boolean,
): Readonly<Record<string, number>> {
  const options: Record<string, number> = {}
  for (const [limit, option] of NUMERIC_LIMITS) {
    const inputId = shape.limits[limit]
    if (inputId === undefined || wired(inputId)) continue
    const value = node.values[inputId]
    if (typeof value === 'number' && Number.isFinite(value)) options[option] = value
  }
  return options
}

/** The primitive's own Default, when it holds one and no wire feeds it. */
export function explicitPrimitiveDefault(
  shape: PrimitiveShape,
  node: NodeData,
  wired: (inputId: string) => boolean,
): Json | undefined {
  const inputId = shape.limits.default
  if (inputId === undefined || wired(inputId)) return undefined
  const value = node.values[inputId]
  return value === null || value === '' ? undefined : value
}

export interface EffectivePrimitiveSpec {
  /** The value field's widget: declared, narrowed by the fed fields, then by the primitive's own limits. */
  readonly spec?: WidgetSpec
  /** The fed fields' shared label, when they all have the same one. */
  readonly label?: string
  /** Which numeric limits came from the fed fields rather than the primitive's own fields. */
  readonly derived: ReadonlySet<string>
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * The effective widget of a primitive's value field. `fed` are the inputs
 * the output reaches (direct, through reroutes and through subgraph
 * boundaries); their widgets narrow the declared widget, and `explicit`
 * options win over both. Pure: no stored state changes.
 */
export function effectivePrimitiveSpec(
  nodeId: string,
  shape: PrimitiveShape,
  fed: readonly InputSpec[],
  explicit: Readonly<Record<string, number>>,
  explicitDefault?: Json,
): EffectivePrimitiveSpec {
  const diagnostics: Diagnostic[] = []
  const data = { node: nodeId }
  const declared = shape.value.widget
  const fedWidgets = fed.flatMap((input) => input.widget === undefined ? [] : [input.widget])
  const labels = new Set(fed.map((input) => input.displayName ?? input.id))
  const label = labels.size === 1 ? [...labels][0] : undefined

  const widgetType = declared?.widgetType ?? fedWidgets[0]?.widgetType
  if (widgetType === undefined) {
    // A choice that feeds no field with options is typed in as text.
    const typed = shape.value.type.kind === 'concrete' && shape.value.type.name === 'COMBO'
    return { ...(typed ? { spec: { widgetType: 'STRING', options: {} } } : {}), ...(label !== undefined ? { label } : {}), derived: new Set(), diagnostics }
  }
  const merge = specMergeFor(widgetType)
  let options: Record<string, unknown> = { ...(declared?.options ?? {}) }
  let base = declared
  for (const widget of fedWidgets) {
    if (widget.widgetType !== widgetType) {
      diagnostics.push(diag('warning', 'schema', 'primitive.widgetType.conflict',
        `${nodeId}: it feeds fields of different kinds ('${widgetType}' and '${widget.widgetType}')`, { data }))
      continue
    }
    if (base === undefined) {
      base = widget
      options = { ...widget.options }
      continue
    }
    const merged = merge(options, widget.options)
    if ('conflict' in merged) {
      diagnostics.push(diag('warning', 'schema', 'primitive.options.conflict', `${nodeId}: ${merged.conflict}`, { data }))
      continue
    }
    options = merged.options
  }

  const derived = new Set(NUMERIC_LIMITS.map(([, option]) => option).filter((option) =>
    options[option] !== undefined && explicit[option] === undefined))
  if (Object.keys(explicit).length > 0) {
    const check = merge(options, explicit)
    if ('conflict' in check) {
      diagnostics.push(diag('warning', 'schema', 'primitive.limits.incompatible',
        `${nodeId}: its own limits do not fit the fields it feeds: ${check.conflict}`, { data }))
    }
    options = { ...options, ...explicit }
  }
  // Reset goes to the primitive's own Default, else the default every fed
  // field shares, else the declared default moved into the effective range.
  const fedDefaults = new Set(fedWidgets.map((widget) => JSON.stringify(widget.default ?? null)))
  const shared = fedWidgets.length > 0 && fedDefaults.size === 1 ? fedWidgets[0]!.default : undefined
  const fallback = declared?.default
  const clamp = (value: unknown): unknown => {
    if (typeof value !== 'number') return value
    const min = typeof options['min'] === 'number' ? options['min'] : -Infinity
    const max = typeof options['max'] === 'number' ? options['max'] : Infinity
    return Math.min(Math.max(value, min), max)
  }
  const resetTo = explicitDefault ?? shared ?? (fallback === undefined ? undefined : clamp(fallback))
  const { default: _declaredDefault, ...rest } = base ?? { widgetType }
  const spec: WidgetSpec = { ...rest, widgetType, options, ...(resetTo !== undefined ? { default: resetTo } : {}) }
  return { spec, ...(label !== undefined ? { label } : {}), derived, diagnostics }
}
