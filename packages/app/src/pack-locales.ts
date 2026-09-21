import type { SchemaRegistry } from '@dinkster/client'
import {
  schemaForEditorRole,
  type InputSpec,
  type InterfaceItem,
  type NodeSchema,
  type PackInfo,
  type WidgetSpec,
} from '@dinkster/core'

export interface PackLocalePort {
  readonly displayName?: string
  readonly doc?: string
}

export interface PackLocaleNode {
  readonly displayName?: string
  readonly description?: string
  readonly inputs?: Readonly<Record<string, PackLocalePort>>
  readonly outputs?: Readonly<Record<string, PackLocalePort>>
  readonly combos?: Readonly<Record<string, Readonly<Record<string, string>>>>
}

export interface PackLocaleCatalog {
  readonly nodes?: Readonly<Record<string, PackLocaleNode>>
  readonly blueprints?: Readonly<Record<string, { readonly name?: string; readonly description?: string }>>
  readonly guides?: Readonly<Record<string, { readonly title: string }>>
  readonly searchTerms?: Readonly<Record<string, readonly string[]>>
}

const asRecord = (value: unknown, where: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} must be an object`)
  }
  return value as Record<string, unknown>
}

const rejectUnknownFields = (
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  where: string,
): void => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort()
  if (unknown.length > 0) throw new Error(`${where} has unknown fields: ${unknown.join(', ')}`)
}

const text = (value: unknown, where: string): string => {
  if (typeof value !== 'string' || value === '') throw new Error(`${where} must be a non-empty string`)
  return value
}

const optionalText = (value: unknown, where: string): string | undefined =>
  value === undefined ? undefined : text(value, where)

const PACK_LOCALE_NAME = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/

const decodeTable = <T>(
  value: unknown,
  where: string,
  decode: (entry: unknown, where: string) => T,
): Readonly<Record<string, T>> | undefined => {
  if (value === undefined) return undefined
  const entries = Object.entries(asRecord(value, where))
  return Object.fromEntries(entries.map(([key, entry]) => {
    if (key.length > 64 || !PACK_LOCALE_NAME.test(key)) {
      throw new Error(`${where} key ${key} is not a valid name`)
    }
    return [key, decode(entry, `${where}.${key}`)]
  }))
}

/** Strictly decode the closed pack catalog vocabulary. */
export function decodePackLocaleCatalog(value: unknown): PackLocaleCatalog {
  const root = asRecord(value, 'catalog')
  rejectUnknownFields(root, ['nodes', 'blueprints', 'guides', 'searchTerms'], 'catalog')

  const decodePort = (value: unknown, where: string): PackLocalePort => {
    const port = asRecord(value, where)
    rejectUnknownFields(port, ['displayName', 'doc'], where)
    if (Object.keys(port).length === 0) throw new Error(`${where} must translate displayName or doc`)
    const displayName = optionalText(port['displayName'], `${where}.displayName`)
    const doc = optionalText(port['doc'], `${where}.doc`)
    return {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(doc !== undefined ? { doc } : {}),
    }
  }

  const nodes = decodeTable(root['nodes'], 'catalog.nodes', (value, where): PackLocaleNode => {
    const node = asRecord(value, where)
    rejectUnknownFields(node, ['displayName', 'description', 'inputs', 'outputs', 'combos'], where)
    if (Object.keys(node).length === 0) throw new Error(`${where} must be non-empty`)
    const displayName = optionalText(node['displayName'], `${where}.displayName`)
    const description = optionalText(node['description'], `${where}.description`)
    const inputs = decodeTable(node['inputs'], `${where}.inputs`, decodePort)
    const outputs = decodeTable(node['outputs'], `${where}.outputs`, decodePort)
    const combos = decodeTable(node['combos'], `${where}.combos`, (value, comboWhere) => {
      const options = asRecord(value, comboWhere)
      if (Object.keys(options).length === 0) throw new Error(`${comboWhere} must be non-empty`)
      return Object.fromEntries(Object.entries(options).map(([option, label]) => {
        if (option === '') throw new Error(`${comboWhere} keys must be non-empty strings`)
        return [option, text(label, `${comboWhere}.${option}`)]
      }))
    })
    return {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(inputs !== undefined ? { inputs } : {}),
      ...(outputs !== undefined ? { outputs } : {}),
      ...(combos !== undefined ? { combos } : {}),
    }
  })

  const blueprints = decodeTable(root['blueprints'], 'catalog.blueprints', (value, where) => {
    const blueprint = asRecord(value, where)
    rejectUnknownFields(blueprint, ['name', 'description'], where)
    if (Object.keys(blueprint).length === 0) throw new Error(`${where} must be non-empty`)
    const name = optionalText(blueprint['name'], `${where}.name`)
    const description = optionalText(blueprint['description'], `${where}.description`)
    return {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
    }
  })

  const guides = decodeTable(root['guides'], 'catalog.guides', (value, where) => {
    const guide = asRecord(value, where)
    if (Object.keys(guide).length !== 1 || !Object.hasOwn(guide, 'title')) {
      throw new Error(`${where} must contain only title`)
    }
    return { title: text(guide['title'], `${where}.title`) }
  })

  const searchTerms = decodeTable(root['searchTerms'], 'catalog.searchTerms', (value, where) => {
    if (!Array.isArray(value) || value.length === 0) throw new Error(`${where} must be a non-empty array`)
    return value.map((entry, index) => text(entry, `${where}[${index}]`))
  })

  return {
    ...(nodes !== undefined ? { nodes } : {}),
    ...(blueprints !== undefined ? { blueprints } : {}),
    ...(guides !== undefined ? { guides } : {}),
    ...(searchTerms !== undefined ? { searchTerms } : {}),
  }
}

const normalizedLocale = (locale: string): string => locale.replaceAll('_', '-').toLowerCase()

/** Available wire keys from highest to lowest preference. */
export function preferredPackLocaleKeys(
  activeLocale: string,
  available: Iterable<string>,
): readonly string[] {
  const keys = [...available].filter((key) => key === normalizedLocale(key))
  const active = normalizedLocale(activeLocale)
  const base = active.split('-', 1)[0]!
  const candidates = [
    active,
    base,
    ...keys.filter((key) => key.startsWith(`${base}-`) && key !== active).sort(),
    'en',
  ]
  return [...new Set(candidates)].filter((key) => keys.includes(key))
}

const first = <T>(
  catalogs: readonly PackLocaleCatalog[],
  pick: (catalog: PackLocaleCatalog) => T | undefined,
): T | undefined => {
  for (const catalog of catalogs) {
    const value = pick(catalog)
    if (value !== undefined) return value
  }
  return undefined
}

const translatedWidget = (
  widget: WidgetSpec | undefined,
  labelsFor: (value: string) => string | undefined,
): WidgetSpec | undefined => {
  if (widget === undefined || (widget.widgetType !== 'COMBO' && widget.widgetType !== 'MULTI_COMBO')) return widget
  const options = widget.options['options']
  if (!Array.isArray(options)) return widget
  let changed = false
  const translated = options.map((option) => {
    if (typeof option === 'string') {
      const label = labelsFor(option)
      if (label === undefined) return option
      changed = true
      return { value: option, label }
    }
    if (option !== null && typeof option === 'object' && !Array.isArray(option) && 'value' in option) {
      const value = (option as { value: unknown }).value
      if (typeof value !== 'string') return option
      const label = labelsFor(value)
      if (label === undefined) return option
      changed = true
      return { ...option, label }
    }
    return option
  })
  return changed ? { ...widget, options: { ...widget.options, options: translated } } : widget
}

const translatedInput = (
  input: InputSpec,
  portFor: (id: string) => PackLocalePort | undefined,
  comboLabelFor: (id: string, value: string) => string | undefined,
): InputSpec => {
  const port = portFor(input.id)
  const widget = translatedWidget(input.widget, (value) => comboLabelFor(input.id, value))
  const dynamic = input.dynamic
  const translatedDynamic = dynamic?.kind === 'dynamicCombo'
    ? {
        ...dynamic,
        options: dynamic.options.map((option) => ({
          ...option,
          inputs: option.inputs.map((nested) => translatedInput(nested, portFor, comboLabelFor)),
        })),
      }
    : dynamic?.kind === 'dynamicSlot'
      ? {
          ...dynamic,
          inputs: dynamic.inputs.map((nested) => translatedInput(nested, portFor, comboLabelFor)),
          ...(dynamic.variants !== undefined ? {
            variants: dynamic.variants.map((variant) => ({
              ...variant,
              inputs: variant.inputs.map((nested) => translatedInput(nested, portFor, comboLabelFor)),
            })),
          } : {}),
        }
      : dynamic?.kind === 'autogrow'
        ? { ...dynamic, template: dynamic.template.map((nested) => translatedInput(nested, portFor, comboLabelFor)) }
        : undefined
  return {
    ...input,
    ...(port?.displayName !== undefined ? { displayName: port.displayName } : {}),
    ...(port?.doc !== undefined ? { tooltip: port.doc } : {}),
    ...(widget === undefined ? {} : { widget }),
    ...(translatedDynamic === undefined ? {} : { dynamic: translatedDynamic }),
  }
}

const translateSchema = (
  schema: NodeSchema,
  catalogs: readonly PackLocaleCatalog[],
): NodeSchema => {
  const nodeFor = (catalog: PackLocaleCatalog) => catalog.nodes?.[schema.type]
  const portFor = (direction: 'inputs' | 'outputs', id: string): PackLocalePort | undefined => {
    const displayName = first(catalogs, (catalog) => nodeFor(catalog)?.[direction]?.[id]?.displayName)
    const doc = first(catalogs, (catalog) => nodeFor(catalog)?.[direction]?.[id]?.doc)
    return displayName === undefined && doc === undefined
      ? undefined
      : {
          ...(displayName !== undefined ? { displayName } : {}),
          ...(doc !== undefined ? { doc } : {}),
        }
  }
  const comboLabelFor = (id: string, value: string): string | undefined =>
    first(catalogs, (catalog) => nodeFor(catalog)?.combos?.[id]?.[value])
  const items = schema.items.map((item): InterfaceItem => {
    if (item.kind === 'input') return translatedInput(item, (id) => portFor('inputs', id), comboLabelFor)
    if (item.kind !== 'output') return item
    const port = portFor('outputs', item.id)
    return {
      ...item,
      ...(port?.displayName !== undefined ? { displayName: port.displayName } : {}),
      ...(port?.doc !== undefined ? { tooltip: port.doc } : {}),
    }
  })
  const description = first(catalogs, (catalog) => nodeFor(catalog)?.description)
  const translatedTerms = first(catalogs, (catalog) => catalog.searchTerms?.[schema.type]) ?? []
  const searchTerms = [...new Set([...translatedTerms, ...(schema.searchTerms ?? [])])]
  return {
    ...schema,
    displayName: first(catalogs, (catalog) => nodeFor(catalog)?.displayName) ?? schema.displayName,
    ...(description !== undefined ? { description } : {}),
    items,
    ...(searchTerms.length > 0 ? { searchTerms } : {}),
  }
}

/** Overlay presentation only; registry and document identity remain unchanged. */
export function overlayPackLocales(
  registry: SchemaRegistry,
  catalogsByPack: ReadonlyMap<string, readonly PackLocaleCatalog[]>,
): SchemaRegistry {
  const schemas = new Map([...registry.schemas].map(([type, schema]): [string, NodeSchema] => {
    const catalogs = schema.pack === undefined ? undefined : catalogsByPack.get(schema.pack)
    return [type, catalogs === undefined ? schema : translateSchema(schema, catalogs)]
  }))
  const packs = registry.packs === undefined
    ? undefined
    : new Map([...registry.packs].map(([packId, pack]): [string, PackInfo] => {
        const catalogs = catalogsByPack.get(packId)
        if (catalogs === undefined || pack.blueprints === undefined) return [packId, pack]
        return [packId, {
          ...pack,
          blueprints: pack.blueprints.map((blueprint) => {
            const description = first(catalogs, (catalog) => catalog.blueprints?.[blueprint.id]?.description)
            return {
              ...blueprint,
              name: first(catalogs, (catalog) => catalog.blueprints?.[blueprint.id]?.name) ?? blueprint.name,
              ...(description !== undefined ? { description } : {}),
            }
          }),
        }]
      }))
  return {
    ...registry,
    schemas,
    ...(packs === undefined ? {} : { packs }),
    resolve: Object.assign((type: string) => {
      const canonical = schemas.get(type)
      if (canonical !== undefined) return canonical
      const resolved = registry.resolve(type)
      return resolved === undefined ? undefined : schemas.get(resolved.type)
    }, {
      forEditorRole: (role: string) => schemaForEditorRole(schemas.values(), role),
    }),
  }
}
