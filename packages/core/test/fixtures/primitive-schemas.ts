/**
 * The six primitive entries as dinkster-nodes declares them: one fixed-type
 * primitive per widget type, and the general one typed by a type variable.
 * Each output's known value names the input it passes on.
 */
import type { InputSpec, NodeSchema, TypeExpr, WidgetSpec } from '../../src/schema/model.js'

const concrete = (name: string): TypeExpr => ({ kind: 'concrete', name })
const variable: TypeExpr = { kind: 'variable', templateId: 'value' }

const valueInput = (type: TypeExpr, widget?: WidgetSpec): InputSpec =>
  ({ kind: 'input', id: 'value', type, optional: false, ...(widget ? { widget } : {}) }) as InputSpec

const primitive = (type: string, displayName: string, value: InputSpec, output: TypeExpr): NodeSchema => ({
  type,
  displayName,
  category: 'utilities',
  source: 'v3',
  isOutputNode: false,
  body: [value, { kind: 'output', id: 'value', type: output, knownValue: { input: 'value' } }],
}) as NodeSchema

export const PRIMITIVE_SCHEMAS: readonly NodeSchema[] = [
  primitive('dinkster.utilities.primitive_int', 'Int',
    valueInput(concrete('INT'), { widgetType: 'INT', options: {}, default: 0, controller: 'after_generate' }), concrete('INT')),
  primitive('dinkster.utilities.primitive_float', 'Float',
    valueInput(concrete('FLOAT'), { widgetType: 'FLOAT', options: {}, default: 0 }), concrete('FLOAT')),
  primitive('dinkster.utilities.primitive_string', 'Text',
    valueInput(concrete('STRING'), { widgetType: 'STRING', options: {}, default: '' }), concrete('STRING')),
  primitive('dinkster.utilities.primitive_boolean', 'Boolean',
    valueInput(concrete('BOOLEAN'), { widgetType: 'BOOLEAN', options: {}, default: false }), concrete('BOOLEAN')),
  primitive('dinkster.utilities.primitive_choice', 'Choice', valueInput(concrete('COMBO')), concrete('COMBO')),
  primitive('dinkster.utilities.primitive', 'Primitive', valueInput(variable), variable),
]

/** Resolve a primitive type, then fall back to `resolve`. */
export const withPrimitives = (resolve: (type: string) => NodeSchema | undefined) =>
  (type: string): NodeSchema | undefined => PRIMITIVE_SCHEMAS.find((schema) => schema.type === type) ?? resolve(type)
