/**
 * A button's declared steps, read from the schema wire into typed steps.
 *
 * The closed list matches the engine's (`dinkster_schema.body`). A step kind
 * the editor does not know refuses the whole button before any press, so a
 * press never runs part of an unknown list.
 */

import { parseDinksterSchema } from '../schema/dinkster-wire.js'
import type { InputSpec, StepSpec } from '../schema/model.js'

/** A literal, a formula over the button's scope, or a call to a lookup. */
export type StepValue =
  | { readonly kind: 'literal'; readonly value: unknown }
  | { readonly kind: 'formula'; readonly text: string }
  | { readonly kind: 'lookup'; readonly function: string; readonly args: readonly Argument[] }

/** A field id of the node or a formula, as a lookup or a call takes it. */
export type Argument = string | { readonly formula: string }

export type Step =
  | { readonly step: 'set'; readonly field: string; readonly value: StepValue }
  | { readonly step: 'toggle'; readonly field: string }
  | { readonly step: 'reset'; readonly field: string }
  | { readonly step: 'swap'; readonly a: string; readonly b: string }
  | { readonly step: 'append'; readonly field: string; readonly value: StepValue; readonly separator: string }
  | { readonly step: 'randomize'; readonly field: string; readonly low?: StepValue; readonly high?: StepValue }
  | { readonly step: 'setMode'; readonly field: string; readonly mode: 'fixed' | 'increment' | 'decrement' | 'randomize' }
  | { readonly step: 'addMember'; readonly group: string; readonly values: Readonly<Record<string, StepValue>> }
  | { readonly step: 'removeMember'; readonly group: string; readonly which: 'first' | 'last' | { readonly formula: string } }
  | { readonly step: 'clearMembers'; readonly group: string }
  | { readonly step: 'setEach'; readonly group: string; readonly field: string; readonly value: StepValue }
  | { readonly step: 'disconnect'; readonly input: string }
  | { readonly step: 'addNode'; readonly nodeType: string; readonly to: string; readonly values: Readonly<Record<string, StepValue>> }
  | { readonly step: 'pick'; readonly name: string; readonly options: StepValue }
  | { readonly step: 'ask'; readonly title: string; readonly rows: readonly InputSpec[] }
  | { readonly step: 'openPicker' | 'openEditor' | 'pasteImage'; readonly field: string }
  | {
      readonly step: 'call'
      readonly function: string
      readonly args: readonly Argument[]
      readonly writes: readonly string[]
      readonly download?: string
    }
  | { readonly step: 'queue'; readonly toHere: boolean }
  | { readonly step: 'interrupt' }
  | { readonly step: 'copy'; readonly value: StepValue }
  | { readonly step: 'download'; readonly value: StepValue; readonly filename: string }
  | { readonly step: 'openLink'; readonly url: StepValue }

/** Steps that act outside the workflow; they run after its one commit. */
export const isOutsideStep = (step: Step): boolean =>
  step.step === 'queue' || step.step === 'interrupt' || step.step === 'copy' ||
  step.step === 'download' || step.step === 'openLink' || (step.step === 'call' && step.download !== undefined)

const MODES = new Set(['fixed', 'increment', 'decrement', 'randomize'])

const text = (raw: unknown, where: string): string => {
  if (typeof raw !== 'string' || raw === '') throw new Error(`${where} must be text`)
  return raw
}

const isObject = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw)

function argument(raw: unknown, where: string): Argument {
  if (typeof raw === 'string') return raw
  if (isObject(raw) && typeof raw['formula'] === 'string') return { formula: raw['formula'] }
  throw new Error(`${where} holds field ids and formulas`)
}

function value(raw: unknown, where: string): StepValue {
  if (!isObject(raw)) throw new Error(`${where} must be a value, a formula or a lookup`)
  if ('value' in raw) return { kind: 'literal', value: raw['value'] }
  if (typeof raw['formula'] === 'string') return { kind: 'formula', text: raw['formula'] }
  if (typeof raw['lookup'] === 'string') {
    const args = raw['args'] ?? []
    if (!Array.isArray(args)) throw new Error(`${where}.args must be a list`)
    return { kind: 'lookup', function: raw['lookup'], args: args.map((item) => argument(item, `${where}.args`)) }
  }
  throw new Error(`${where} must be a value, a formula or a lookup`)
}

function values(raw: unknown, where: string): Readonly<Record<string, StepValue>> {
  if (raw === undefined) return {}
  if (!isObject(raw)) throw new Error(`${where} must be an object`)
  return Object.fromEntries(Object.entries(raw).map(([key, item]) => [key, value(item, `${where}.${key}`)]))
}

/** Ask rows are input rows; the schema reader decodes them as it decodes a body. */
function askRows(raw: unknown, where: string): readonly InputSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${where} needs at least one row`)
  // The engine writes Ask rows as input entries without the body row's kind.
  const body = raw.map((row: unknown) => (isObject(row) ? { kind: 'input', ...row } : row))
  const parsed = parseDinksterSchema('ask', { schemaVersion: 2, nodeType: 'ask', body } as never)
  const rows = parsed.schema?.body ?? []
  if (rows.length !== raw.length || rows.some((row) => row.kind !== 'input')) {
    throw new Error(`${where} are Input rows`)
  }
  return rows as readonly InputSpec[]
}

/** Decode one wire step; an unknown kind or a malformed field throws. */
export function decodeStep(spec: StepSpec): Step {
  const where = `step ${spec.step}`
  switch (spec.step) {
    case 'set':
      return { step: 'set', field: text(spec['field'], `${where}.field`), value: value(spec['value'], `${where}.value`) }
    case 'toggle':
    case 'reset':
      return { step: spec.step, field: text(spec['field'], `${where}.field`) }
    case 'swap':
      return { step: 'swap', a: text(spec['a'], `${where}.a`), b: text(spec['b'], `${where}.b`) }
    case 'append':
      return {
        step: 'append',
        field: text(spec['field'], `${where}.field`),
        value: value(spec['value'], `${where}.value`),
        separator: spec['separator'] === undefined ? ', ' : String(spec['separator']),
      }
    case 'randomize':
      return {
        step: 'randomize',
        field: text(spec['field'], `${where}.field`),
        ...(spec['low'] !== undefined ? { low: value(spec['low'], `${where}.low`) } : {}),
        ...(spec['high'] !== undefined ? { high: value(spec['high'], `${where}.high`) } : {}),
      }
    case 'setMode': {
      const mode = spec['mode']
      if (typeof mode !== 'string' || !MODES.has(mode)) throw new Error(`${where}.mode is fixed, increment, decrement or randomize`)
      return { step: 'setMode', field: text(spec['field'], `${where}.field`), mode: mode as 'fixed' }
    }
    case 'addMember':
      return { step: 'addMember', group: text(spec['group'], `${where}.group`), values: values(spec['values'], `${where}.values`) }
    case 'removeMember': {
      const which = spec['which']
      if (which !== 'first' && which !== 'last' && !(isObject(which) && typeof which['formula'] === 'string')) {
        throw new Error(`${where}.which is first, last or a formula`)
      }
      return {
        step: 'removeMember',
        group: text(spec['group'], `${where}.group`),
        which: typeof which === 'string' ? which : { formula: (which as { formula: string }).formula },
      }
    }
    case 'clearMembers':
      return { step: 'clearMembers', group: text(spec['group'], `${where}.group`) }
    case 'setEach':
      return {
        step: 'setEach',
        group: text(spec['group'], `${where}.group`),
        field: text(spec['field'], `${where}.field`),
        value: value(spec['value'], `${where}.value`),
      }
    case 'disconnect':
      return { step: 'disconnect', input: text(spec['input'], `${where}.input`) }
    case 'addNode':
      return {
        step: 'addNode',
        nodeType: text(spec['nodeType'], `${where}.nodeType`),
        to: text(spec['to'], `${where}.to`),
        values: values(spec['values'], `${where}.values`),
      }
    case 'pick':
      return { step: 'pick', name: text(spec['name'], `${where}.name`), options: value(spec['options'], `${where}.options`) }
    case 'ask':
      return { step: 'ask', title: text(spec['title'], `${where}.title`), rows: askRows(spec['rows'], `${where}.rows`) }
    case 'openPicker':
    case 'openEditor':
    case 'pasteImage':
      return { step: spec.step, field: text(spec['field'], `${where}.field`) }
    case 'call': {
      const args = spec['args'] ?? []
      const writes = spec['writes'] ?? []
      if (!Array.isArray(args) || !Array.isArray(writes)) throw new Error(`${where} args and writes are lists`)
      const download = spec['download']
      if ((download === undefined) === (writes.length === 0)) throw new Error(`${where} either writes fields or downloads a file`)
      return {
        step: 'call',
        function: text(spec['function'], `${where}.function`),
        args: args.map((item) => argument(item, `${where}.args`)),
        writes: writes.map((item) => text(item, `${where}.writes`)),
        ...(download !== undefined ? { download: text(download, `${where}.download`) } : {}),
      }
    }
    case 'queue':
      return { step: 'queue', toHere: spec['toHere'] === true }
    case 'interrupt':
      return { step: 'interrupt' }
    case 'copy':
      return { step: 'copy', value: value(spec['value'], `${where}.value`) }
    case 'download':
      return { step: 'download', value: value(spec['value'], `${where}.value`), filename: text(spec['filename'], `${where}.filename`) }
    case 'openLink':
      return { step: 'openLink', url: value(spec['url'], `${where}.url`) }
    default:
      throw new Error(`${spec.step} is not a step the editor runs`)
  }
}

/** Decode a button's steps; refuse the list when one is unknown or an outside step comes too early. */
export function decodeSteps(specs: readonly StepSpec[]): readonly Step[] {
  const steps = specs.map(decodeStep)
  let outside = false
  for (const step of steps) {
    if (isOutsideStep(step)) outside = true
    else if (outside) throw new Error(`${step.step} changes the workflow after a step that acts outside it`)
  }
  return steps
}
