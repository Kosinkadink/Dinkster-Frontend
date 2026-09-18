import type { AssetRef } from '@dinkster/core'
import type {
  IngestedLogicalModelDescription,
  LogicalModel,
  LogicalModelDiagnostic,
  LogicalModelIngestionResult,
  LogicalModelSourceKind,
  LogicalModelVariant,
  SourceRef,
  VariantDescription,
  VariantConflict,
} from './logical-model.js'

const SOURCE_KINDS = new Set(['builtin-catalog', 'local-scan', 'resolver', 'template-metadata', 'provider'])
const AVAILABILITY = new Set(['installed', 'downloadable', 'unavailable', 'resolving'])
const COMPATIBILITY = new Set(['compatible', 'incompatible', 'unknown'])
const HOSTILE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const DIGEST = /^blake3:[0-9a-f]{64}$/

const plainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean => {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key))
}

const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('\0') && !HOSTILE_KEYS.has(value)

const validText = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0')
const safeSize = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const decodeSource = (value: unknown): SourceRef | undefined => {
  if (!plainRecord(value) || !exactKeys(value, ['sourceId', 'sourceKind', 'label'])) return undefined
  if (!validId(value['sourceId']) || !SOURCE_KINDS.has(value['sourceKind'] as string) || !validText(value['label'])) return undefined
  return value as unknown as SourceRef
}

const decodeAdapter = (value: unknown): { source: unknown; descriptions: readonly unknown[] } | undefined => {
  if (!plainRecord(value) || !exactKeys(value, ['source', 'descriptions']) || !Array.isArray(value['descriptions'])) return undefined
  return { source: value['source'], descriptions: value['descriptions'] }
}

const decodeAssetRef = (value: unknown): AssetRef | undefined => {
  if (!plainRecord(value) || !exactKeys(value, ['digest', 'name', 'size', 'mediaType', 'virtualPath'])) return undefined
  if (typeof value['digest'] !== 'string' || !DIGEST.test(value['digest']) || !validText(value['name']) ||
    !safeSize(value['size']) || !validText(value['mediaType']) || !validText(value['virtualPath'])) return undefined
  return value as AssetRef
}

const optionalString = (body: Record<string, unknown>, key: string): boolean =>
  !Object.hasOwn(body, key) || body[key] === undefined || validText(body[key])

const decodeVariant = (value: unknown, logicalId: string): VariantDescription | undefined => {
  if (!plainRecord(value) || !exactKeys(value,
    ['variantId', 'logicalId', 'providers', 'availability', 'compatibility'],
    ['dtype', 'precision', 'quantization', 'format', 'size', 'digest', 'localRef'])) return undefined
  if (!validId(value['variantId']) || value['logicalId'] !== logicalId ||
    !optionalString(value, 'dtype') || !optionalString(value, 'precision') || !optionalString(value, 'quantization') || !optionalString(value, 'format') ||
    (value['size'] !== undefined && !safeSize(value['size'])) ||
    (value['digest'] !== undefined && (typeof value['digest'] !== 'string' || !DIGEST.test(value['digest']))) ||
    !Array.isArray(value['providers']) ||
    !AVAILABILITY.has(value['availability'] as string)) return undefined

  const providers = value['providers'].map(decodeSource)
  if (providers.some((provider) => provider === undefined) ||
    new Set(providers.map((provider) => provider!.sourceId)).size !== providers.length) return undefined

  const compatibility = value['compatibility']
  if (!plainRecord(compatibility) || !exactKeys(compatibility, ['status'], ['reason']) ||
    !COMPATIBILITY.has(compatibility['status'] as string) ||
    (compatibility['reason'] !== undefined && !validText(compatibility['reason']))) return undefined

  const localRef = value['localRef'] === undefined ? undefined : decodeAssetRef(value['localRef'])
  if ((value['availability'] === 'installed') !== (localRef !== undefined) ||
    (localRef !== undefined && value['digest'] !== undefined && localRef.digest !== value['digest'])) return undefined
  const digest = value['digest'] === undefined ? localRef?.digest : value['digest'] as string
  return {
    variantId: value['variantId'],
    logicalId,
    ...(value['dtype'] !== undefined ? { dtype: value['dtype'] as string } : {}),
    ...(value['precision'] !== undefined ? { precision: value['precision'] as string } : {}),
    ...(value['quantization'] !== undefined ? { quantization: value['quantization'] as string } : {}),
    ...(value['format'] !== undefined ? { format: value['format'] as string } : {}),
    ...(value['size'] !== undefined ? { size: value['size'] as number } : {}),
    ...(digest !== undefined ? { digest } : {}),
    providers: providers as SourceRef[],
    availability: value['availability'] as VariantDescription['availability'],
    compatibility: {
      status: compatibility['status'] as VariantDescription['compatibility']['status'],
      ...(compatibility['reason'] !== undefined ? { reason: compatibility['reason'] as string } : {}),
    },
    ...(localRef !== undefined ? { localRef } : {}),
  }
}

const decodeDescription = (value: unknown): IngestedLogicalModelDescription | undefined => {
  if (!plainRecord(value) || !exactKeys(value, ['logicalId', 'displayName', 'kind', 'aliases', 'variants']) ||
    !validId(value['logicalId']) || !validText(value['displayName']) || !validText(value['kind']) ||
    !Array.isArray(value['aliases']) || !value['aliases'].every(validText) || !Array.isArray(value['variants'])) return undefined
  const variants = value['variants'].map((variant) => decodeVariant(variant, value['logicalId'] as string))
  if (variants.some((variant) => variant === undefined)) return undefined
  const variantKeys = variants.map((variant) => JSON.stringify([variant!.variantId, variant!.digest ?? null]))
  if (new Set(variantKeys).size !== variantKeys.length) return undefined
  return {
    logicalId: value['logicalId'],
    displayName: value['displayName'],
    kind: value['kind'],
    aliases: [...new Set(value['aliases'] as string[])],
    variants: variants as VariantDescription[],
  }
}

interface MutableVariant {
  variantId: string
  variantIds: Set<string>
  logicalId: string
  dtype?: string
  precision?: string
  quantization?: string
  format?: string
  size?: number
  scalarOrders: Map<string, number>
  digest?: string
  providers: Map<string, SourceRef>
  signals: Map<string, VariantDescription['availability']>
  localRefs: Map<string, AssetRef>
  factOrders: Map<string, number>
  compatibility: VariantDescription['compatibility']
  compatibilityOrder: number
  conflicts: VariantConflict[]
  sourceKinds: Set<LogicalModelSourceKind>
  resolverLocalSources: Set<string>
}

interface MutableModel {
  logicalId: string
  displayName: string
  kind: string
  aliases: string[]
  variants: MutableVariant[]
  exactVariants: Map<string, Map<string, MutableVariant>>
}

const diagnostic = (
  diagnostics: LogicalModelDiagnostic[],
  code: string,
  sourceId: string,
  message: string,
  logicalId?: string,
  variantId?: string,
): void => {
  diagnostics.push({ code, sourceId, message, ...(logicalId !== undefined ? { logicalId } : {}), ...(variantId !== undefined ? { variantId } : {}) })
}

const sameCompatibility = (
  left: VariantDescription['compatibility'],
  right: VariantDescription['compatibility'],
): boolean => left.status === right.status && left.reason === right.reason

const mergeAvailabilityEvidence = (
  target: MutableVariant,
  incoming: VariantDescription,
  source: SourceRef,
  diagnostics: LogicalModelDiagnostic[],
  order: number,
): void => {
  for (const provider of incoming.providers) target.providers.set(provider.sourceId, provider)
  const signal = target.signals.get(source.sourceId)
  if (signal === undefined) {
    target.signals.set(source.sourceId, incoming.availability)
    target.factOrders.set(source.sourceId, order)
    if (incoming.localRef !== undefined) {
      target.localRefs.set(source.sourceId, incoming.localRef)
      if (source.sourceKind === 'resolver') target.resolverLocalSources.add(source.sourceId)
    }
  } else {
    const localRef = target.localRefs.get(source.sourceId)
    if (signal !== incoming.availability || (localRef === undefined) !== (incoming.localRef === undefined) ||
      (localRef !== undefined && incoming.localRef !== undefined && JSON.stringify(localRef) !== JSON.stringify(incoming.localRef))) {
      diagnostic(diagnostics, 'variant-metadata-conflict', source.sourceId,
        'concrete variant has contradictory availability or localRef', incoming.logicalId, incoming.variantId)
    }
  }
  target.sourceKinds.add(source.sourceKind)
}

const mergeVariant = (
  target: MutableVariant,
  incoming: VariantDescription,
  source: SourceRef,
  diagnostics: LogicalModelDiagnostic[],
  order: number,
): void => {
  target.variantIds.add(incoming.variantId)
  if (incoming.variantId < target.variantId) target.variantId = incoming.variantId
  const scalar = (key: 'dtype' | 'precision' | 'quantization' | 'format' | 'size'): void => {
    const value = incoming[key]
    if (value === undefined) return
    const current = target[key]
    if (current === undefined) {
      Object.assign(target, { [key]: value })
      target.scalarOrders.set(key, order)
    } else if (current !== value) {
      diagnostic(diagnostics, 'variant-metadata-conflict', source.sourceId,
        `concrete variant has contradictory ${key}`, incoming.logicalId, incoming.variantId)
      if (order < (target.scalarOrders.get(key) ?? Number.POSITIVE_INFINITY)) {
        Object.assign(target, { [key]: value })
        target.scalarOrders.set(key, order)
      }
    }
  }
  scalar('dtype')
  scalar('precision')
  scalar('quantization')
  scalar('format')
  scalar('size')
  if (target.digest === undefined && incoming.digest !== undefined) target.digest = incoming.digest
  mergeAvailabilityEvidence(target, incoming, source, diagnostics, order)
  if (!sameCompatibility(target.compatibility, incoming.compatibility)) {
    diagnostic(diagnostics, 'variant-metadata-conflict', source.sourceId,
      'concrete variant has contradictory compatibility', incoming.logicalId, incoming.variantId)
    if (order < target.compatibilityOrder) {
      target.compatibility = incoming.compatibility
      target.compatibilityOrder = order
    }
  }
}

const combineVariants = (
  target: MutableVariant,
  source: MutableVariant,
  diagnostics: LogicalModelDiagnostic[],
): void => {
  for (const variantId of source.variantIds) target.variantIds.add(variantId)
  if (source.variantId < target.variantId) target.variantId = source.variantId
  for (const key of ['dtype', 'precision', 'quantization', 'format', 'size'] as const) {
    if (source[key] === undefined) continue
    const sourceOrder = source.scalarOrders.get(key)!
    const conflict = target[key] !== undefined && target[key] !== source[key]
    if (conflict) diagnostic(diagnostics, 'variant-metadata-conflict', '<merged-source>',
      `concrete variant has contradictory ${key}`, target.logicalId, target.variantId)
    if (target[key] === undefined || sourceOrder < (target.scalarOrders.get(key) ?? Number.POSITIVE_INFINITY)) {
      target[key] = source[key] as never
      target.scalarOrders.set(key, sourceOrder)
    }
  }
  for (const [sourceId, provider] of source.providers) target.providers.set(sourceId, provider)
  for (const [sourceId, signal] of source.signals) {
    const current = target.signals.get(sourceId)
    const currentRef = target.localRefs.get(sourceId)
    const incomingRef = source.localRefs.get(sourceId)
    const sourceOrder = source.factOrders.get(sourceId)!
    const targetOrder = target.factOrders.get(sourceId)
    if (current !== undefined && (current !== signal || (currentRef === undefined) !== (incomingRef === undefined) ||
      (currentRef !== undefined && incomingRef !== undefined && JSON.stringify(currentRef) !== JSON.stringify(incomingRef)))) {
      diagnostic(diagnostics, 'variant-metadata-conflict', sourceId,
        'concrete variant has contradictory availability or localRef', target.logicalId, target.variantId)
    }
    if (current === undefined || targetOrder === undefined || sourceOrder < targetOrder) {
      target.signals.set(sourceId, signal)
      target.factOrders.set(sourceId, sourceOrder)
      if (incomingRef !== undefined) target.localRefs.set(sourceId, incomingRef)
      else target.localRefs.delete(sourceId)
      if (source.resolverLocalSources.has(sourceId)) target.resolverLocalSources.add(sourceId)
      else target.resolverLocalSources.delete(sourceId)
    }
  }
  if (!sameCompatibility(target.compatibility, source.compatibility)) {
    diagnostic(diagnostics, 'variant-metadata-conflict', '<merged-source>',
      'concrete variant has contradictory compatibility', target.logicalId, target.variantId)
    if (source.compatibilityOrder < target.compatibilityOrder) {
      target.compatibility = source.compatibility
      target.compatibilityOrder = source.compatibilityOrder
    }
  }
  target.conflicts.push(...source.conflicts)
  for (const sourceKind of source.sourceKinds) target.sourceKinds.add(sourceKind)
}

const newVariant = (
  incoming: VariantDescription,
  source: SourceRef,
  diagnostics: LogicalModelDiagnostic[],
  order: number,
): MutableVariant => {
  const result: MutableVariant = {
    variantId: incoming.variantId,
    variantIds: new Set([incoming.variantId]),
    logicalId: incoming.logicalId,
    scalarOrders: new Map(),
    providers: new Map(),
    signals: new Map(),
    localRefs: new Map(),
    factOrders: new Map(),
    compatibility: incoming.compatibility,
    compatibilityOrder: order,
    conflicts: [],
    sourceKinds: new Set(),
    resolverLocalSources: new Set(),
  }
  mergeVariant(result, incoming, source, diagnostics, order)
  return result
}

const availabilityOf = (variant: MutableVariant): LogicalModelVariant['availability'] => {
  if (variant.localRefs.size > 0) return 'installed'
  if ([...variant.signals.values()].includes('resolving')) return 'resolving'
  if ([...variant.signals.values()].includes('downloadable')) return 'downloadable'
  return 'unavailable'
}

const selectedLocalRef = (variant: MutableVariant): AssetRef | undefined =>
  [...variant.localRefs.entries()]
    .sort(([leftSourceId, left], [rightSourceId, right]) =>
      left.virtualPath < right.virtualPath ? -1 : left.virtualPath > right.virtualPath ? 1 :
        leftSourceId < rightSourceId ? -1 : leftSourceId > rightSourceId ? 1 :
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    [0]?.[1]

const basename = (variant: MutableVariant): string | undefined => {
  const ref = selectedLocalRef(variant)
  return ref?.name.replace(/\\/g, '/').split('/').pop()
}

const finalizeVariant = (variant: MutableVariant): LogicalModelVariant => {
  const localRef = selectedLocalRef(variant)
  return {
    variantId: variant.variantId,
    logicalId: variant.logicalId,
    ...(variant.dtype !== undefined ? { dtype: variant.dtype } : {}),
    ...(variant.precision !== undefined ? { precision: variant.precision } : {}),
    ...(variant.quantization !== undefined ? { quantization: variant.quantization } : {}),
    ...(variant.format !== undefined ? { format: variant.format } : {}),
    ...(variant.size !== undefined ? { size: variant.size } : {}),
    ...(variant.digest !== undefined ? { digest: variant.digest } : {}),
    providers: [...variant.providers.values()].sort((left, right) =>
      left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0),
    availability: availabilityOf(variant),
    compatibility: variant.compatibility,
    ...(localRef !== undefined ? { localRef } : {}),
    conflicts: variant.conflicts,
  }
}

/**
 * Validate fixture-provided descriptions and group them without transport,
 * persistence, or guessed identity. Malformed descriptions are diagnosed and
 * excluded; a conflicting kind invalidates that logical model as a whole.
 */
export function ingestLogicalModels(adapters: readonly unknown[]): LogicalModelIngestionResult {
  const diagnostics: LogicalModelDiagnostic[] = []
  const occurrenceOrders = new WeakMap<VariantDescription, number>()
  let nextOccurrenceOrder = 0
  const models = new Map<string, MutableModel>()
  const authoritativeDigestVariants = new Map<string, Set<MutableVariant>>()
  const invalidModels = new Set<string>()
  const conflictedDigests = new Set<string>()

  const invalidateAuthoritativeModel = (logicalId: string): void => {
    invalidModels.add(logicalId)
    models.delete(logicalId)
    for (const [digest, variants] of authoritativeDigestVariants) {
      for (const variant of variants) if (variant.logicalId === logicalId) variants.delete(variant)
      if (variants.size === 0) authoritativeDigestVariants.delete(digest)
    }
  }

  const decoded: { source: SourceRef; descriptions: IngestedLogicalModelDescription[] }[] = []
  for (const rawAdapter of adapters) {
    const adapter = decodeAdapter(rawAdapter)
    if (adapter === undefined) {
      diagnostic(diagnostics, 'malformed-adapter', '<invalid-source>', 'adapter must be a plain exact-shape object')
      continue
    }
    const source = decodeSource(adapter.source)
    const fallbackSourceId = plainRecord(adapter.source) && typeof adapter.source['sourceId'] === 'string'
      ? adapter.source['sourceId']
      : '<invalid-source>'
    if (source === undefined) {
      diagnostic(diagnostics, validId(fallbackSourceId) ? 'malformed-source' : 'hostile-key', fallbackSourceId, 'adapter source is malformed')
      continue
    }
    const descriptions: IngestedLogicalModelDescription[] = []
    for (const raw of adapter.descriptions) {
      const rawLogicalId = plainRecord(raw) && typeof raw['logicalId'] === 'string' ? raw['logicalId'] : undefined
      const description = decodeDescription(raw)
      if (description === undefined) {
        let code = 'malformed-description'
        if (rawLogicalId !== undefined && (!validId(rawLogicalId) || rawLogicalId.includes('\0'))) code = 'invalid-id'
        else if (plainRecord(raw) && Array.isArray(raw['variants'])) {
          const variants = raw['variants'].filter(plainRecord)
          const ids = variants.map((entry) => entry['variantId'])
          const keys = variants.map((entry) => JSON.stringify([entry['variantId'], entry['digest'] ?? null]))
          if (ids.some((id) => typeof id === 'string' && id.includes('\0'))) code = 'invalid-id'
          else if (new Set(keys).size !== keys.length) code = 'duplicate-id'
        }
        diagnostic(diagnostics, code, source.sourceId, 'logical model description is malformed', rawLogicalId)
        continue
      }
      for (const variant of description.variants) occurrenceOrders.set(variant, nextOccurrenceOrder++)
      descriptions.push(description)
    }
    decoded.push({ source, descriptions })
  }

  const ensureModel = (
    description: IngestedLogicalModelDescription,
    source: SourceRef,
    authoritative: boolean,
  ): MutableModel | undefined => {
    if (authoritative && invalidModels.has(description.logicalId)) return undefined
    let model = models.get(description.logicalId)
    if (model !== undefined && model.kind !== description.kind) {
      diagnostic(diagnostics, 'conflicting-kind', source.sourceId,
        'logical model descriptions disagree on kind', description.logicalId)
      if (authoritative) invalidateAuthoritativeModel(description.logicalId)
      return undefined
    }
    if (model === undefined) {
      model = {
        logicalId: description.logicalId,
        displayName: description.displayName,
        kind: description.kind,
        aliases: [],
        variants: [],
        exactVariants: new Map(),
      }
      models.set(description.logicalId, model)
    }
    model.displayName = description.displayName
    for (const alias of description.aliases) if (!model.aliases.includes(alias)) model.aliases.push(alias)
    return model
  }

  const exactBucket = (model: MutableModel, variantId: string): Map<string, MutableVariant> => {
    let bucket = model.exactVariants.get(variantId)
    if (bucket === undefined) {
      bucket = new Map()
      model.exactVariants.set(variantId, bucket)
    }
    return bucket
  }
  const digestKey = (digest: string | undefined): string => digest ?? '<digestless>'

  for (const { source, descriptions } of decoded.filter((adapter) => adapter.source.sourceKind !== 'local-scan')) {
    for (const description of descriptions) {
      const model = ensureModel(description, source, true)
      if (model === undefined) continue
      for (const incoming of description.variants) {
        if (incoming.digest !== undefined && conflictedDigests.has(incoming.digest)) {
          diagnostic(diagnostics, 'digest-logical-conflict', source.sourceId,
            'digest was quarantined after conflicting logical identity claims', incoming.logicalId, incoming.variantId)
          invalidateAuthoritativeModel(incoming.logicalId)
          break
        }
        const bucket = exactBucket(model, incoming.variantId)
        const exact = bucket.get(digestKey(incoming.digest))
        const digestTargets = incoming.digest === undefined
          ? undefined
          : authoritativeDigestVariants.get(incoming.digest)
        const conflictingTargets = digestTargets === undefined
          ? []
          : [...digestTargets].filter((target) => target.logicalId !== incoming.logicalId)
        if (conflictingTargets.length > 0) {
          diagnostic(diagnostics, 'digest-logical-conflict', source.sourceId,
            'one digest cannot identify variants under different logical models', incoming.logicalId, incoming.variantId)
          conflictedDigests.add(incoming.digest!)
          for (const target of conflictingTargets) invalidateAuthoritativeModel(target.logicalId)
          invalidateAuthoritativeModel(incoming.logicalId)
          break
        }
        let target = exact
        if (target === undefined) {
          target = newVariant(incoming, source, diagnostics, occurrenceOrders.get(incoming)!)
          model.variants.push(target)
        } else {
          mergeVariant(target, incoming, source, diagnostics, occurrenceOrders.get(incoming)!)
        }
        bucket.set(digestKey(incoming.digest), target)
        if (incoming.digest !== undefined) {
          const variants = authoritativeDigestVariants.get(incoming.digest) ?? new Set<MutableVariant>()
          variants.add(target)
          authoritativeDigestVariants.set(incoming.digest, variants)
        }
      }
    }
  }

  for (const model of models.values()) {
    const byVariantId = new Map<string, MutableVariant[]>()
    for (const variant of model.variants) {
      const siblings = byVariantId.get(variant.variantId) ?? []
      siblings.push(variant)
      byVariantId.set(variant.variantId, siblings)
    }
    for (const [variantId, siblings] of byVariantId) {
      const digestless = siblings.filter((variant) => variant.digest === undefined)
      const concrete = siblings.filter((variant) => variant.digest !== undefined)
      if (digestless.length !== 1) continue
      if (concrete.length === 1) {
        combineVariants(concrete[0]!, digestless[0]!, diagnostics)
        model.variants.splice(model.variants.indexOf(digestless[0]!), 1)
      } else if (concrete.length > 1) {
        diagnostic(diagnostics, 'ambiguous-digestless-variant', '<merged-source>',
          'digestless variant cannot identify one concrete sibling', model.logicalId, variantId)
      }
    }
  }

  for (const { source, descriptions } of decoded.filter((adapter) => adapter.source.sourceKind === 'local-scan')) {
    for (const description of descriptions) {
      for (const incoming of description.variants) {
        const authoritativeTargets = incoming.digest === undefined
          ? []
          : [...(authoritativeDigestVariants.get(incoming.digest) ?? [])].filter((target) =>
            target.sourceKinds.has('builtin-catalog') ||
            [...target.resolverLocalSources].some((sourceId) => target.localRefs.get(sourceId)?.digest === incoming.digest))
        if (authoritativeTargets.length > 0) {
          for (const authoritativeTarget of authoritativeTargets) {
            const authoritativeModel = models.get(authoritativeTarget.logicalId)
            if (authoritativeModel === undefined) continue
            for (const alias of description.aliases) {
              if (!authoritativeModel.aliases.includes(alias)) authoritativeModel.aliases.push(alias)
            }
            mergeAvailabilityEvidence(authoritativeTarget, incoming, source, diagnostics, occurrenceOrders.get(incoming)!)
          }
          continue
        }
        const model = ensureModel(description, source, false)
        if (model === undefined) continue
        const bucket = exactBucket(model, incoming.variantId)
        const key = `local:${digestKey(incoming.digest)}`
        let target = bucket.get(key)
        if (target === undefined) {
          target = newVariant(incoming, source, diagnostics, occurrenceOrders.get(incoming)!)
          model.variants.push(target)
          bucket.set(key, target)
        } else {
          mergeVariant(target, incoming, source, diagnostics, occurrenceOrders.get(incoming)!)
        }
      }
    }
  }

  for (const model of models.values()) {
    for (let left = 0; left < model.variants.length; left++) {
      const leftVariant = model.variants[left]!
      const leftName = basename(leftVariant)
      if (leftName === undefined || leftVariant.digest === undefined) continue
      for (let right = left + 1; right < model.variants.length; right++) {
        const rightVariant = model.variants[right]!
        if (basename(rightVariant) !== leftName || rightVariant.digest === undefined || rightVariant.digest === leftVariant.digest) continue
        leftVariant.conflicts.push({ code: 'basename-digest-conflict', basename: leftName, otherVariantId: rightVariant.variantId })
        rightVariant.conflicts.push({ code: 'basename-digest-conflict', basename: leftName, otherVariantId: leftVariant.variantId })
      }
    }
  }

  const finalized: LogicalModel[] = [...models.values()].map((model) => ({
    logicalId: model.logicalId,
    displayName: model.displayName,
    kind: model.kind,
    aliases: model.aliases,
    variants: model.variants.map(finalizeVariant).sort((left, right) => {
      if (left.variantId !== right.variantId) return left.variantId < right.variantId ? -1 : 1
      const leftDigest = left.digest ?? ''
      const rightDigest = right.digest ?? ''
      return leftDigest < rightDigest ? -1 : leftDigest > rightDigest ? 1 : 0
    }),
  })).sort((left, right) => left.logicalId < right.logicalId ? -1 : left.logicalId > right.logicalId ? 1 : 0)
  return { models: finalized, diagnostics }
}
