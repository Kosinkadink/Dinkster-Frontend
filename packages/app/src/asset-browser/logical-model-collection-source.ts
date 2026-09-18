import {
  localCollectionSource,
  type AssetRef,
  type CollectionEntry,
  type CollectionSource,
  type SearchField,
} from '@dinkster/core'
import { formatSize } from './helpers.js'
import type { LogicalModel, LogicalModelVariant } from './logical-model.js'

const shortDigest = (digest: string): string => `${digest.slice(0, 15)}...`

const digestLike = (value: string): boolean => /^(blake3:)?[0-9a-f]{64}$/i.test(value)

export const logicalModelVariantName = (variant: LogicalModelVariant): string =>
  variant.localRef?.name ?? (digestLike(variant.variantId) ? shortDigest(variant.variantId) : variant.variantId)

export interface LogicalModelPickDetail {
  readonly modelName: string
  readonly aliases: readonly string[]
  readonly variant: LogicalModelVariant
}

interface LogicalModelVariantEntryRef {
  readonly kind: 'logical-model-variant'
  readonly detail: LogicalModelPickDetail
}

interface LogicalModelGroupEntryRef {
  readonly kind: 'logical-model-group'
  readonly modelName: string
  readonly aliases: readonly string[]
  readonly variants: readonly LogicalModelVariant[]
}

type LogicalModelEntryRef = LogicalModelVariantEntryRef | LogicalModelGroupEntryRef

const logicalModelEntryRef = (entry: CollectionEntry | undefined): LogicalModelEntryRef | undefined => {
  const ref = entry?.ref
  if (typeof ref !== 'object' || ref === null || !('kind' in ref)) return undefined
  const kind = (ref as { readonly kind?: unknown }).kind
  return kind === 'logical-model-variant' || kind === 'logical-model-group'
    ? ref as LogicalModelEntryRef
    : undefined
}

const variantEntry = (model: LogicalModel, variant: LogicalModelVariant, grouped: boolean): CollectionEntry => ({
  id: `logical-model-variant:${JSON.stringify([model.logicalId, variant.variantId, variant.digest ?? null])}`,
  title: grouped ? logicalModelVariantName(variant) : model.displayName,
  badges: [variant.availability, ...(variant.size !== undefined ? [formatSize(variant.size)] : [])],
  ref: {
    kind: 'logical-model-variant',
    detail: { modelName: model.displayName, aliases: model.aliases, variant },
  } satisfies LogicalModelVariantEntryRef,
})

export function logicalModelEntries(models: readonly LogicalModel[]): readonly CollectionEntry[] {
  return models.flatMap((model) => {
    if (model.variants.length === 0) return []
    if (model.variants.length === 1) return [variantEntry(model, model.variants[0]!, false)]
    return [{
      id: `logical-model-group:${JSON.stringify(model.logicalId)}`,
      title: model.displayName,
      badges: [`${model.variants.length} variants`],
      children: model.variants.map((variant) => variantEntry(model, variant, true)),
      ref: {
        kind: 'logical-model-group',
        modelName: model.displayName,
        aliases: model.aliases,
        variants: model.variants,
      } satisfies LogicalModelGroupEntryRef,
    }]
  })
}

const searchFields = (entry: CollectionEntry): readonly SearchField[] => {
  const ref = logicalModelEntryRef(entry)
  if (ref?.kind === 'logical-model-variant') {
    return [
      { text: ref.detail.modelName, weight: 3 },
      { text: logicalModelVariantName(ref.detail.variant), weight: 3 },
      ...ref.detail.aliases.map((text) => ({ text, weight: 2 })),
    ]
  }
  if (ref?.kind === 'logical-model-group') {
    return [
      { text: ref.modelName, weight: 3 },
      ...ref.aliases.map((text) => ({ text, weight: 2 })),
      ...ref.variants.map((variant) => ({ text: logicalModelVariantName(variant), weight: 3 })),
    ]
  }
  return [{ text: entry.title, weight: 3 }]
}

export function logicalModelCollectionSource(models: () => readonly LogicalModel[]): CollectionSource {
  return localCollectionSource({
    id: 'logical-models',
    label: 'Models',
    corpus: () => logicalModelEntries(models()),
    fieldsOf: searchFields,
  })
}

export const logicalModelPickDetailOf = (entry: CollectionEntry | undefined): LogicalModelPickDetail | undefined => {
  const ref = logicalModelEntryRef(entry)
  return ref?.kind === 'logical-model-variant' ? ref.detail : undefined
}

export const logicalModelAssetRefOf = (entry: CollectionEntry | undefined): AssetRef | undefined =>
  logicalModelPickDetailOf(entry)?.variant.localRef

export const logicalModelEntrySelectable = (entry: CollectionEntry): boolean =>
  logicalModelPickDetailOf(entry) !== undefined

export const logicalModelEntryVisible = (entry: CollectionEntry): boolean =>
  logicalModelEntryRef(entry) !== undefined
