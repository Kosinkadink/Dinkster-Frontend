/**
 * Rules of the node body tree that the engine and the editor share
 * (engine: dinkster_schema.body and dinkster_schema.flatten): member keys,
 * what a formula may name in a scope, how a shared row is placed under an
 * option, and the checks a declaration passes when it loads.
 */
import { Formula, FormulaRefused, FormulaTable, type FormulaNameKind, type FormulaScalar, type FormulaScope, type FormulaTableValue } from '../mirror/formula.js'
import {
  isFormulaSpec,
  scopeRowsOf,
  type BodyRow,
  type ChoiceSpec,
  type GroupKeysSpec,
  type GroupSpec,
  type InputSpec,
  type NodeSchema,
  type OptionRow,
  type StateSpec,
  type TypeExpr,
  type UseSpec,
} from './model.js'

/** A row inside 16 boxes loads; a row inside 17 is refused. Every box kind counts. */
export const MAX_BODY_DEPTH = 16
export const MAX_BODY_BOXES = 512
export const MAX_GROUP_MEMBERS = 512

const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const KEY_PATTERN = /^[A-Za-z0-9_]+$/
const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
])

/** A row id every formula can name: an identifier that is not a Python keyword. */
export const isRowId = (value: unknown): value is string =>
  typeof value === 'string' && ID_PATTERN.test(value) && !PYTHON_KEYWORDS.has(value)

/** A section, button or note id: the same characters, and it may be a keyword. */
export const isLayoutId = (value: unknown): value is string =>
  typeof value === 'string' && ID_PATTERN.test(value)

export const isMemberKey = (value: unknown): value is string =>
  typeof value === 'string' && KEY_PATTERN.test(value)

/** An option key is a stored value, never part of a path: printable ASCII words separated by single spaces. */
export const isOptionKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[!-~]+( [!-~]+)*$/.test(value)

export const isVariantKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)

/**
 * A node's tables as formulas read them. JSON does not keep Python's 1 apart
 * from 1.0, so a whole JSON number reads as a whole number and the engine
 * writes a whole float as `{float: 1}`; `{table: [[key, value], ...]}` is a
 * dictionary.
 */
export function formulaTablesOf(tables: Readonly<Record<string, unknown>> | undefined): ReadonlyMap<string, FormulaTableValue> {
  const isFloat = (value: unknown): value is { readonly float: number } =>
    typeof value === 'object' && value !== null && Object.hasOwn(value, 'float')
  const scalar = (value: unknown): FormulaScalar =>
    isFloat(value) ? value.float
      : typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : (value as FormulaScalar)
  const convert = (value: unknown): FormulaTableValue => {
    if (Array.isArray(value)) return value.map(scalar)
    if (typeof value === 'object' && value !== null && !isFloat(value)) {
      const pairs = (value as { table: readonly (readonly [string | number, unknown])[] }).table
      return new FormulaTable(pairs.map(([key, item]) => [typeof key === 'number' ? BigInt(key) : key, convert(item)] as const))
    }
    return scalar(value)
  }
  return new Map(Object.entries(tables ?? {}).map(([name, value]) => [name, convert(value)]))
}

// ---------------------------------------------------------------------------
// Member keys

/** The key of the member at `index` (from 0) under a naming rule. */
export function memberKeyAt(keys: GroupKeysSpec, index: number): string | undefined {
  if (keys.kind === 'named') return keys.names[index]
  return `${keys.prefix}${String(keys.start + index).padStart(keys.pad, '0')}`
}

/** The position a naming rule gives a key, or undefined when the rule cannot make it. */
export function keyPosition(keys: GroupKeysSpec, key: string): number | undefined {
  if (keys.kind === 'named') {
    const index = keys.names.indexOf(key)
    return index < 0 ? undefined : index
  }
  if (!key.startsWith(keys.prefix)) return undefined
  const digits = key.slice(keys.prefix.length)
  if (!/^[0-9]+$/.test(digits)) return undefined
  const position = Number(digits) - keys.start
  if (!Number.isSafeInteger(position) || position < 0 || memberKeyAt(keys, position) !== key) return undefined
  return position
}

/** The most members a group may have: its maximum, its names, and the member budget. */
export function memberLimitOf(group: GroupSpec): number {
  let limit = group.maxMembers ?? MAX_GROUP_MEMBERS
  if (group.keys.kind === 'named') limit = Math.min(limit, group.keys.names.length)
  return Math.min(limit, MAX_GROUP_MEMBERS)
}

/** The rows of one member of a group, as a scope. */
export const memberRowsOf = (group: GroupSpec): readonly BodyRow[] =>
  group.value !== undefined ? [group.value] : group.member ?? []

/** Whether a member has a required input of its own, so the group's minimum binds. */
export const hasRequiredRow = (group: GroupSpec): boolean =>
  scopeRowsOf(memberRowsOf(group)).some((row) => row.kind === 'input' && !row.optional)

/** Every row of a choice that its options can reach: the shared rows, then each option's. */
export const choiceScopeRows = (choice: ChoiceSpec): readonly OptionRow[] => [
  ...choice.shared,
  ...choice.options.flatMap((option) => option.rows),
]

/** One option's scope, through the layout boxes, with the shared rows its `Use` rows place. */
export function optionRows(choice: ChoiceSpec, key: string): readonly OptionRow[] {
  const option = choice.options.find((candidate) => candidate.key === key)
  if (option === undefined) return []
  const shared = new Map(scopeRowsOf(choice.shared).flatMap((row) => 'id' in row ? [[row.id, row] as const] : []))
  const placed = scopeRowsOf(option.rows).flatMap((row) => row.kind === 'use' && shared.has(row.id) ? [shared.get(row.id)!] : [])
  return [...scopeRowsOf(option.rows), ...placed]
}

// ---------------------------------------------------------------------------
// A new node's stored state

/** The stored values a new node starts with: each top-scope field's default. */
export function defaultValuesOf(schema: NodeSchema): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const row of scopeRowsOf(schema.body)) {
    if (row.kind === 'input' && row.hidden !== true && row.widget?.default !== undefined) values[row.id] = row.widget.default
  }
  return values
}

/**
 * The dynamic state a new node starts with: each group that grows by hand
 * stores its first `minMembers` keys, so the members it always shows take
 * part in the run, and each choice stores the option it starts on. It
 * follows the start option and the stored members down the tree.
 */
export function initialDynamicStateOf(schema: NodeSchema): Record<string, { readonly selected?: string; readonly members?: readonly string[]; readonly seq?: number }> {
  const state: Record<string, { selected?: string; members?: readonly string[]; seq?: number }> = {}
  const visit = (rows: readonly OptionRow[], prefix: string, shared?: ReadonlyMap<string, BodyRow>): void => {
    for (const raw of scopeRowsOf(rows)) {
      const row = raw.kind === 'use' ? (shared?.get(raw.id) === undefined ? undefined : applyUse(shared.get(raw.id)!, raw)) : raw
      if (row === undefined || row.kind === 'row') continue
      const path = prefix + row.id
      if (row.kind === 'group') {
        if (typeof row.grows !== 'string' || row.minMembers === 0) continue
        const count = Math.min(row.minMembers, memberLimitOf(row))
        const members = Array.from({ length: count }, (_, index) => memberKeyAt(row.keys, index)!)
        state[path] = { members, ...(row.keys.kind === 'numbered' ? { seq: count } : {}) }
        if (row.member !== undefined) for (const key of members) visit(row.member, `${path}.${key}.`)
      } else if (row.kind === 'choice' && row.leader === undefined) {
        const key = row.required ? row.default ?? row.options[0]?.key : undefined
        const option = row.options.find((candidate) => candidate.key === key)
        if (option === undefined) continue
        state[path] = { selected: option.key }
        visit(option.rows, `${path}.`, new Map(row.shared.filter((item) => item.kind !== 'row').map((item) => [(item as { id: string }).id, item])))
      }
    }
  }
  visit(schema.body, '')
  return state
}

/**
 * Every group and choice a node can hold, by flattened id: through every
 * option and variant, and into the members the node stores. A choice placed
 * by `Use` is as the chosen option places it, else as the first option that
 * does.
 */
export function constructsOf(
  schema: NodeSchema,
  dynamic: Readonly<Record<string, { readonly selected?: string; readonly members?: readonly string[] }>> | undefined,
): ReadonlyMap<string, GroupSpec | ChoiceSpec> {
  const found = new Map<string, GroupSpec | ChoiceSpec>()
  const visit = (rows: readonly OptionRow[], prefix: string, shared?: ReadonlyMap<string, BodyRow>): void => {
    for (const raw of scopeRowsOf(rows)) {
      const row = raw.kind === 'use' ? (shared?.get(raw.id) === undefined ? undefined : applyUse(shared.get(raw.id)!, raw)) : raw
      if (row === undefined || row.kind === 'row') continue
      const path = prefix + row.id
      if (row.kind === 'group') {
        if (!found.has(path)) found.set(path, row)
        if (row.member !== undefined) for (const key of dynamic?.[path]?.members ?? []) visit(row.member, `${path}.${key}.`)
      } else if (row.kind === 'choice') {
        if (!found.has(path)) found.set(path, row)
        const placed = new Map(row.shared.map((item) => [(item as { id: string }).id, item]))
        const selected = dynamic?.[path]?.selected
        const options = [...row.options].sort((a, b) => Number(b.key === selected) - Number(a.key === selected))
        for (const option of options) visit(option.rows, `${path}.`, placed)
      } else if (row.kind === 'typeChoice') {
        visit([...row.rows, ...(row.variants ?? []).flatMap((variant) => variant.rows)], `${path}.`)
      }
    }
  }
  visit(schema.body, '')
  return found
}

// ---------------------------------------------------------------------------
// A shared row placed under one option

/** A shared row as one option places it, with that place's overrides. */
export function applyUse(row: BodyRow, use: UseSpec): BodyRow {
  if (row.kind === 'input') {
    let placed: InputSpec = { ...row }
    if (use.displayName !== undefined) placed = { ...placed, displayName: use.displayName }
    if (use.tooltip !== undefined) placed = { ...placed, tooltip: use.tooltip }
    if (use.widget !== undefined) {
      const { widget: _widget, ...rest } = placed
      placed = use.widget === null ? rest : { ...rest, widget: use.widget }
    }
    if (use.required !== undefined) placed = { ...placed, optional: !use.required }
    if (use.default !== undefined && use.required !== true && placed.widget !== undefined) {
      placed = { ...placed, widget: { ...placed.widget, default: use.default } }
    }
    if (use.required === true && placed.widget?.default !== undefined) {
      const { default: _default, ...widget } = placed.widget
      placed = { ...placed, widget }
    }
    return placed
  }
  if (row.kind === 'choice') {
    let choice: ChoiceSpec = { ...row }
    if (use.displayName !== undefined) choice = { ...choice, displayName: use.displayName }
    if (use.tooltip !== undefined) choice = { ...choice, tooltip: use.tooltip }
    if (use.required !== undefined) choice = { ...choice, required: use.required }
    if (use.only !== undefined) choice = { ...choice, options: choice.options.filter((option) => use.only!.includes(option.key)) }
    if (use.default !== undefined) {
      const { default: _default, ...rest } = choice
      choice = typeof use.default === 'string' ? { ...rest, default: use.default } : rest
    }
    if (use.inside !== undefined && use.inside.length > 0) {
      const inner = new Map(use.inside.map((item) => [item.id, item]))
      choice = {
        ...choice,
        shared: choice.shared.map((item) => useInside(item, inner) as BodyRow),
        options: choice.options.map((option) => ({ ...option, rows: option.rows.map((item) => useInside(item, inner)) })),
      }
    }
    return choice
  }
  return row
}

function useInside(row: OptionRow, inner: ReadonlyMap<string, UseSpec>): OptionRow {
  if (row.kind === 'section') return { ...row, rows: row.rows.map((item) => useInside(item, inner) as BodyRow) }
  if (row.kind === 'row') return { ...row, rows: row.rows.map((item) => useInside(item, inner) as (typeof row.rows)[number]) }
  const override = inner.get(row.id)
  if (override === undefined) return row
  if (row.kind === 'use') return mergeUse(row, override)
  return applyUse(row, override)
}

/** An inner `Use` over a place that is itself a `Use`: the inner one wins. */
function mergeUse(place: UseSpec, override: UseSpec): UseSpec {
  const pick = <K extends keyof UseSpec>(key: K): Pick<UseSpec, K> | object =>
    override[key] !== undefined ? { [key]: override[key] } : place[key] !== undefined ? { [key]: place[key] } : {}
  return {
    kind: 'use',
    id: place.id,
    ...pick('displayName'),
    ...pick('tooltip'),
    ...pick('widget'),
    ...pick('default'),
    ...pick('required'),
    ...pick('only'),
    ...(place.inside !== undefined || override.inside !== undefined
      ? { inside: [...(place.inside ?? []), ...(override.inside ?? [])] }
      : {}),
  } as UseSpec
}

// ---------------------------------------------------------------------------
// What a formula may name

const VALUE_KINDS: Readonly<Record<string, FormulaNameKind>> = {
  INT: 'int',
  FLOAT: 'float',
  BOOLEAN: 'bool',
  STRING: 'text',
  COMBO: 'choice',
}
/** Fields whose value a formula reads differently from the row's type. */
const WIDGET_KINDS: Readonly<Record<string, FormulaNameKind>> = {
  MOUNT: 'opaque',
  CURVE: 'opaque',
  COMPOSITOR: 'opaque',
  CUSTOM: 'opaque',
  MULTI_COMBO: 'text[]',
}

function rowKind(row: InputSpec | StateSpec): FormulaNameKind {
  if (row.kind === 'input' && row.widget !== undefined) {
    const widgets = row.widget.representations?.representations.map((item) => item.widget) ?? [row.widget]
    const kinds = widgets.map((widget) => widget.widgetType.startsWith('CUSTOM') ? 'opaque' : WIDGET_KINDS[widget.widgetType])
    if (kinds.includes('opaque')) return 'opaque'
    if (kinds.includes('text[]')) return 'text[]'
  }
  return row.type.kind === 'concrete' ? VALUE_KINDS[row.type.name] ?? 'opaque' : 'opaque'
}

const isAssetType = (type: TypeExpr): boolean =>
  type.kind === 'asset' || (type.kind === 'concrete' && type.name === 'ASSET')

/** The names one scope's own rows give a formula, and which of them are inputs or assets. */
export interface ScopeNames {
  readonly names: Map<string, FormulaNameKind>
  readonly inputs: Set<string>
  readonly assets: Set<string>
  /** A group whose count is a formula, and its rows across members. */
  readonly counted: Set<string>
}

export function scopeNamesOf(rows: readonly OptionRow[]): ScopeNames {
  const found: ScopeNames = { names: new Map(), inputs: new Set(), assets: new Set(), counted: new Set() }
  const add = (name: string, kind: FormulaNameKind, input: boolean, asset = false): void => {
    if (!found.names.has(name)) found.names.set(name, kind)
    if (input) found.inputs.add(name)
    if (asset) found.assets.add(name)
  }
  const nested = (prefix: string, inner: ScopeNames, acrossMembers: boolean): void => {
    for (const [name, kind] of inner.names) {
      if (inner.counted.has(name)) found.counted.add(`${prefix}.${name}`)
      if (acrossMembers) {
        if (kind !== 'group' && kind !== 'opaque' && !kind.endsWith('[]')) add(`${prefix}.${name}`, `${kind}[]` as FormulaNameKind, false)
        continue
      }
      add(`${prefix}.${name}`, kind, inner.inputs.has(name), inner.assets.has(name))
    }
  }
  for (const row of scopeRowsOf(rows)) {
    switch (row.kind) {
      case 'input':
      case 'state':
        add(row.id, rowKind(row), row.kind === 'input', isAssetType(row.type))
        break
      case 'choice':
        add(row.id, 'choice', false)
        nested(row.id, scopeNamesOf(choiceScopeRows(row)), false)
        break
      case 'group':
        add(row.id, 'group', false)
        if (row.member !== undefined) nested(row.id, scopeNamesOf(row.member), true)
        if (typeof row.grows === 'object' && 'count' in row.grows) {
          for (const name of found.names.keys()) if (name.startsWith(`${row.id}.`)) found.counted.add(name)
          found.counted.add(row.id)
        }
        break
      case 'typeChoice':
        add(row.id, 'opaque', true)
        nested(row.id, scopeNamesOf(row.rows), false)
        break
      case 'described':
        add(row.id, 'opaque', false)
        break
    }
  }
  return found
}

/**
 * What a formula sees from inside nested scopes: each enclosing scope's own
 * rows, the innermost winning when two scopes use one name.
 */
export function framesNamesOf(frames: readonly (readonly OptionRow[])[]): ScopeNames {
  const merged: ScopeNames = { names: new Map(), inputs: new Set(), assets: new Set(), counted: new Set() }
  for (const rows of frames) {
    const inner = scopeNamesOf(rows)
    for (const [name, kind] of inner.names) {
      merged.names.set(name, kind)
      if (inner.counted.has(name)) merged.counted.add(name)
      else merged.counted.delete(name)
      if (inner.inputs.has(name)) merged.inputs.add(name)
      else merged.inputs.delete(name)
      if (inner.assets.has(name)) merged.assets.add(name)
      else merged.assets.delete(name)
    }
  }
  return merged
}

// ---------------------------------------------------------------------------
// Checks when a declaration loads

type IdKind = 'input' | 'output' | 'section' | 'button' | 'note' | 'editor'
type Ids = Record<IdKind, Set<string>>
const newIds = (): Ids => ({ input: new Set(), output: new Set(), section: new Set(), button: new Set(), note: new Set(), editor: new Set() })

/** Whether an output sits anywhere inside a row, so its id is also an output id. */
function holdsOutput(row: OptionRow): boolean {
  switch (row.kind) {
    case 'output':
      return true
    case 'section':
    case 'row':
      return row.rows.some(holdsOutput)
    case 'group':
      return memberRowsOf(row).some(holdsOutput)
    case 'choice':
      return choiceScopeRows(row).some(holdsOutput)
    case 'typeChoice':
      return [...row.rows, ...(row.variants ?? []).flatMap((variant) => variant.rows)].some(holdsOutput)
    case 'described':
      return row.kinds.some((kind) => kind.kind === 'output')
    default:
      return false
  }
}

const claim = (seen: Set<string>, id: string, where: string, kind: string): void => {
  if (seen.has(id)) throw new Error(`${kind} ${where}${id} is declared twice in one scope`)
  seen.add(id)
}

/** The rows of a choice by id, through the layout boxes, for `Use(inside=...)`. */
function choiceRowsById(choice: ChoiceSpec): Map<string, BodyRow> {
  const found = new Map<string, BodyRow>()
  const pending: OptionRow[] = [...choiceScopeRows(choice)]
  while (pending.length > 0) {
    const row = pending.pop()!
    if (row.kind === 'section' || row.kind === 'row') pending.push(...row.rows)
    else if (row.kind !== 'use') found.set(row.id, row)
  }
  return found
}

const OPTIONAL_CHOICE_DEFAULT =
  'an optional choice cannot declare a default; it always starts with nothing chosen. ' +
  'A choice that should start on an option and still offer none is a required choice with an option of its own for none'

function checkUse(use: UseSpec, row: BodyRow, where: string): void {
  if (row.kind !== 'choice') {
    if (use.only !== undefined) throw new Error(`Use ${where}: only applies to a shared choice`)
    if (use.inside !== undefined && use.inside.length > 0) throw new Error(`Use ${where}: inside applies to a shared choice`)
    return
  }
  const keys = row.options.map((option) => option.key)
  const required = use.required ?? row.required
  const fallback = use.default === undefined ? row.default : use.default
  if (!required && fallback !== undefined && fallback !== null) throw new Error(`Use ${where}: ${OPTIONAL_CHOICE_DEFAULT}`)
  for (const key of use.only ?? []) {
    if (!keys.includes(key)) throw new Error(`Use ${where}: only names '${key}', which is not an option`)
  }
  if (use.default !== undefined && use.default !== null) {
    const offered = use.only ?? keys
    if (typeof use.default !== 'string' || !offered.includes(use.default)) {
      throw new Error(`Use ${where}: default ${JSON.stringify(use.default)} is not an offered option`)
    }
  }
  const rows = choiceRowsById(row)
  for (const inner of use.inside ?? []) {
    const innerRow = rows.get(inner.id)
    if (innerRow === undefined) throw new Error(`Use ${where}: inside names '${inner.id}', not a row of the choice`)
    checkUse(inner, innerRow, `${where}.${inner.id}`)
  }
}

/**
 * The checks over a whole body that the engine also makes when a pack loads:
 * one id per row in a scope (a box's id is an input id of the scope around
 * it, and an output id too when it holds an output; layout ids are unique per
 * kind), nesting at most 16 boxes deep and 512 boxes in all, every `Use`
 * naming a shared row, no `key()` in a numbered group's member label, and no
 * formula or argument, the node's own included, that reads across a group
 * whose count is a formula. Throws with the engine's wording on the first refusal.
 */
export function checkBody(
  body: readonly BodyRow[],
  formulas: Pick<FormulaScope, 'tables' | 'derived'> = {},
  node: Pick<NodeSchema, 'validate' | 'titleSuffix' | 'menu'> = {},
): void {
  let boxes = 0
  const box = (depth: number, what: string): void => {
    boxes += 1
    if (boxes > MAX_BODY_BOXES) throw new Error(`a body holds at most ${MAX_BODY_BOXES} boxes`)
    if (depth > MAX_BODY_DEPTH) throw new Error(`${what} nests deeper than ${MAX_BODY_DEPTH}`)
  }
  type Frames = readonly (readonly OptionRow[])[]
  const frameNames = new WeakMap<Frames, ScopeNames>()
  const namesOf = (frames: Frames): ScopeNames => {
    if (!frameNames.has(frames)) frameNames.set(frames, framesNamesOf(frames))
    return frameNames.get(frames)!
  }
  // Frames at or under a group member's rows, where index() and key() may be read.
  const memberFrames = new WeakSet<Frames>()
  const within = (frames: Frames, rows: readonly OptionRow[], member = false): Frames => {
    const next = [...frames, rows]
    if (member || memberFrames.has(frames)) memberFrames.add(next)
    return next
  }
  const counted = (value: unknown, frames: Frames, skip?: ReadonlySet<string>): void =>
    refuseCountedReads(value, namesOf(frames), { ...formulas, inMember: memberFrames.has(frames) }, skip)
  const scope = (rows: readonly OptionRow[], depth: number, where: string, frames: Frames, member = false): void => {
    visit(rows, depth, where, newIds(), new Map(), within(frames, rows, member))
  }
  const visit = (
    rows: readonly OptionRow[],
    depth: number,
    where: string,
    ids: Ids,
    shared: ReadonlyMap<string, BodyRow>,
    frames: Frames,
  ): void => {
    for (const row of rows) {
      if (row.kind === 'use') {
        const target = shared.get(row.id)
        if (target === undefined) throw new Error(`Use ${where}${row.id}: names no shared row of its choice`)
        checkUse(row, target, `${where}${row.id}`)
        counted(row, frames, new Set())
        continue
      }
      if (row.kind === 'group') {
        counted(row, frames, new Set([...CHILD_FIELDS, 'memberLabel']))
      } else {
        counted(row, frames)
        if (row.kind === 'choice') for (const option of row.options) counted(option, frames)
        if (row.kind === 'described') for (const kind of row.kinds) counted(kind, frames)
      }
      switch (row.kind) {
        case 'output':
          claim(ids.output, row.id, where, 'output')
          break
        case 'input':
        case 'state':
        case 'group':
        case 'choice':
        case 'typeChoice':
        case 'described':
          claim(ids.input, row.id, where, 'input')
          if (holdsOutput(row)) claim(ids.output, row.id, where, 'output')
          break
        case 'section':
          claim(ids.section, row.id, where, 'section')
          break
        case 'button':
          claim(ids.button, row.id, where, 'button')
          break
        case 'note':
          claim(ids.note, row.id, where, 'note')
          break
        case 'editor':
          claim(ids.editor, row.id, where, 'editor')
          break
      }
      switch (row.kind) {
        case 'section':
          box(depth + 1, `section ${row.id}`)
          visit(row.rows, depth + 1, where, ids, shared, frames)
          break
        case 'row':
          box(depth + 1, 'a Row')
          visit(row.rows, depth + 1, where, ids, shared, frames)
          break
        case 'group':
          box(depth + 1, `group ${row.id}`)
          scope(memberRowsOf(row), depth + 1, `${where}${row.id}.<key>.`, frames, true)
          counted(row.memberLabel, within(frames, memberRowsOf(row), true), new Set())
          checkMemberLabel(row, [...frames, memberRowsOf(row)], formulas)
          break
        case 'choice': {
          box(depth + 1, `choice ${row.id}`)
          if (!row.required && row.default !== undefined) throw new Error(`choice ${row.id}: ${OPTIONAL_CHOICE_DEFAULT}`)
          const inner = `${where}${row.id}.`
          const choiceIds = newIds()
          const sharedRows = new Map<string, BodyRow>()
          for (const item of row.shared) {
            const kind = item.kind[0]!.toUpperCase() + item.kind.slice(1)
            if (item.kind === 'section' || item.kind === 'row') {
              throw new Error(`choice ${inner.slice(0, -1)}: a ${kind} in shared is layout; write it under the option, where the Use stands, with the Use inside it`)
            }
            if (item.kind === 'note' || item.kind === 'button' || item.kind === 'editor') {
              throw new Error(`choice ${inner.slice(0, -1)}: a ${kind} in shared holds no value to share; write it under each option that shows it`)
            }
            sharedRows.set(item.id, item)
          }
          const choiceFrames = within(frames, choiceScopeRows(row))
          visit(row.shared, depth + 1, inner, choiceIds, new Map(), choiceFrames)
          for (const option of row.options) {
            const used = option.rows.filter((item) => item.kind === 'use').map((item) => item.id)
            if (new Set(used).size !== used.length) throw new Error(`choice ${row.id}: option ${option.key} uses a row twice`)
            // Different options may each hold a layout row with one id: only one
            // option is shown, and a section's saved open state is shared.
            const layout = { section: new Set<string>(), button: new Set<string>(), note: new Set<string>(), editor: new Set<string>() }
            visit(option.rows, depth + 1, inner, { ...choiceIds, ...layout }, sharedRows, choiceFrames)
          }
          break
        }
        case 'typeChoice': {
          box(depth + 1, `type choice ${row.id}`)
          const inner = `${where}${row.id}.`
          const rowIds = newIds()
          visit(row.rows, depth + 1, inner, rowIds, new Map(), within(frames, row.rows))
          for (const variant of row.variants ?? []) {
            const variantIds = Object.fromEntries(
              Object.entries(rowIds).map(([kind, seen]) => [kind, new Set(seen)]),
            ) as Ids
            visit(variant.rows, depth + 1, inner, variantIds, new Map(), within(frames, [...row.rows, ...variant.rows]))
          }
          break
        }
        case 'described':
          box(depth + 1, `described ${row.id}`)
          break
      }
    }
  }
  scope(body, 0, '', [])
  const top: Frames = [body]
  counted([node.validate, node.titleSuffix], top)
  for (const button of node.menu ?? []) counted(button, top)
}

/** Fields that hold rows of their own; their formulas are checked with those rows. */
const CHILD_FIELDS = new Set(['rows', 'member', 'value', 'options', 'shared', 'variants', 'kinds'])

/**
 * Refuses, as the engine does, a formula or a lookup or call argument in a
 * row's own fields that reads the size or the members of a group whose count
 * is a formula: reading the counted members is not built yet.
 */
function refuseCountedReads(
  value: unknown,
  names: ScopeNames,
  formulas: Pick<FormulaScope, 'tables' | 'derived' | 'inMember'>,
  skip: ReadonlySet<string> = CHILD_FIELDS,
): void {
  if (names.counted.size === 0) return
  const formula = (text: string): void => {
    const scope: FormulaScope = { ...formulas, names: names.names, inputs: names.inputs, assets: names.assets }
    for (const name of Formula.parse(text, scope).uses().names) {
      if (!names.counted.has(name)) continue
      const group = [...names.counted].sort((a, b) => a.length - b.length).find((item) => `${name}.`.startsWith(`${item}.`))
      throw new Error(`formula '${text}' reads '${name}': reading the size or the members of group '${group}', whose count is a formula, is not built yet`)
    }
  }
  const walk = (item: unknown, top: boolean): void => {
    if (Array.isArray(item)) {
      for (const entry of item) walk(entry, false)
      return
    }
    if (typeof item !== 'object' || item === null) return
    const fields = item as Record<string, unknown>
    if (isFormulaSpec(item)) return formula(item.formula)
    const called = typeof fields['lookup'] === 'string' ? fields['lookup'] : fields['step'] === 'call' ? fields['function'] : undefined
    if (called !== undefined && Array.isArray(fields['args'])) {
      for (const argument of fields['args']) {
        if (typeof argument === 'string' && names.counted.has(argument)) {
          throw new Error(`${String(called)}: argument '${argument}' reads the members of a group whose count is a formula, which is not built yet`)
        }
      }
    }
    for (const [key, entry] of Object.entries(fields)) {
      if (top && skip.has(key)) continue
      if (top && key === 'leader' && typeof entry === 'string') formula(entry)
      else if (top && key === 'grows' && typeof entry === 'object' && entry !== null && 'count' in entry) formula(String(entry.count))
      else walk(entry, false)
    }
  }
  walk(value, true)
}

/** `key()` would show a numbered member's hidden key, so its label may not use it. */
function checkMemberLabel(
  group: GroupSpec,
  frames: readonly (readonly OptionRow[])[],
  formulas: Pick<FormulaScope, 'tables' | 'derived'>,
): void {
  const label = group.memberLabel
  if (group.keys.kind !== 'numbered' || label === undefined || typeof label === 'string') return
  const names = framesNamesOf(frames)
  const formulaScope: FormulaScope = { ...formulas, names: names.names, inputs: names.inputs, assets: names.assets, inMember: true }
  let calls: ReadonlySet<string>
  try {
    calls = Formula.parse(label.formula, formulaScope).uses().calls
  } catch (error) {
    if (error instanceof FormulaRefused) throw new Error(`group ${group.id} member_label: ${error.message}`)
    throw error
  }
  if (calls.has('key')) {
    throw new Error(`group ${group.id}: a numbered group's member_label cannot use key(); the shown number is the member's position`)
  }
}
