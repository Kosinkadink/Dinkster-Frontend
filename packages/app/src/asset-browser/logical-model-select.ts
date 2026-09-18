import type { AssetRef } from '@dinkster/core'
import type { LogicalModel, LogicalModelVariant, SourceRef } from './logical-model.js'

export interface AutoSelectionPolicy {
  readonly precisionOrder: readonly string[]
  readonly trustedVariantId?: string
  readonly expectedDigest?: string
}

export interface AutoSelectionResult {
  readonly mode: 'binding' | 'recommendation' | 'none'
  readonly choice: LogicalModelVariant | undefined
  readonly requiresExplicitConfirmation: boolean
  readonly reasonCodes: readonly string[]
}

export type ExplicitSelectionResult =
  | { readonly ok: true; readonly choice: LogicalModelVariant; readonly compatibility: LogicalModelVariant['compatibility'] }
  | { readonly ok: false; readonly code: 'variant-not-found' }

export interface AcquisitionIntent {
  readonly logicalId: string
  readonly variantId: string
  readonly providers: readonly SourceRef[]
  readonly expected?: { readonly size?: number; readonly digest?: string }
}

export type SelectionBinding =
  | { readonly kind: 'installed'; readonly assetRef: AssetRef }
  | { readonly kind: 'acquisition'; readonly intent: AcquisitionIntent }
  | { readonly kind: 'unavailable'; readonly availability: 'unavailable' | 'resolving' }

export function selectLogicalModelAuto(model: LogicalModel, policy: AutoSelectionPolicy): AutoSelectionResult {
  if (policy.precisionOrder.some((precision) => typeof precision !== 'string' || precision.includes('\0')) ||
    new Set(policy.precisionOrder).size !== policy.precisionOrder.length ||
    (policy.trustedVariantId !== undefined && (policy.trustedVariantId.length === 0 || policy.trustedVariantId.includes('\0'))) ||
    (policy.expectedDigest !== undefined && !/^blake3:[0-9a-f]{64}$/.test(policy.expectedDigest))) {
    throw new Error('invalid Auto selection policy')
  }
  const precisionRank = new Map(policy.precisionOrder.map((precision, index) => [precision, index]))
  const compare = (left: LogicalModelVariant, right: LogicalModelVariant): number => {
    const availabilityRank = (variant: LogicalModelVariant): number => variant.availability === 'installed' ? 0 : 1
    const availabilityDifference = availabilityRank(left) - availabilityRank(right)
    if (availabilityDifference !== 0) return availabilityDifference
    const leftRank = left.precision === undefined ? Number.MAX_SAFE_INTEGER : (precisionRank.get(left.precision) ?? Number.MAX_SAFE_INTEGER)
    const rightRank = right.precision === undefined ? Number.MAX_SAFE_INTEGER : (precisionRank.get(right.precision) ?? Number.MAX_SAFE_INTEGER)
    if (leftRank !== rightRank) return leftRank - rightRank
    return left.variantId < right.variantId ? -1 : left.variantId > right.variantId ? 1 : 0
  }
  const compatible = model.variants
    .filter((variant) => variant.compatibility.status === 'compatible' &&
      (variant.availability === 'installed' || variant.availability === 'downloadable'))
    .sort(compare)
  const trusted = policy.trustedVariantId === undefined
    ? undefined
    : compatible.find((variant) => variant.variantId === policy.trustedVariantId)
  const expected = policy.expectedDigest === undefined
    ? undefined
    : compatible.find((variant) => variant.digest === policy.expectedDigest)
  if (trusted !== undefined && expected !== undefined && trusted !== expected) {
    return {
      mode: 'recommendation',
      choice: compatible[0],
      requiresExplicitConfirmation: true,
      reasonCodes: ['recommendation-conflicting-admission-signals', 'requires-explicit-confirmation'],
    }
  }
  const admitted = trusted ?? expected
  if (admitted !== undefined) {
    return {
      mode: 'binding',
      choice: admitted,
      requiresExplicitConfirmation: false,
      reasonCodes: [trusted !== undefined ? 'binding-explicit-mapping' : 'binding-expected-digest'],
    }
  }
  if (compatible.length === 1) {
    return {
      mode: 'binding',
      choice: compatible[0],
      requiresExplicitConfirmation: false,
      reasonCodes: ['binding-single-compatible-candidate'],
    }
  }
  if (compatible.length > 1) {
    return {
      mode: 'recommendation',
      choice: compatible[0],
      requiresExplicitConfirmation: true,
      reasonCodes: [
        'recommendation-multiple-compatible',
        compatible[0]!.availability === 'installed' ? 'compatible-installed' : 'compatible-downloadable',
        'requires-explicit-confirmation',
      ],
    }
  }
  return {
    mode: 'none',
    choice: undefined,
    requiresExplicitConfirmation: false,
    reasonCodes: ['no-compatible-available-variant'],
  }
}

export function selectLogicalModelVariant(model: LogicalModel, variantId: string): ExplicitSelectionResult {
  const choice = model.variants.find((variant) => variant.variantId === variantId)
  return choice === undefined
    ? { ok: false, code: 'variant-not-found' }
    : { ok: true, choice, compatibility: choice.compatibility }
}

export function bindLogicalModelSelection(variant: LogicalModelVariant): SelectionBinding {
  if (variant.availability === 'installed' && variant.localRef !== undefined) {
    return { kind: 'installed', assetRef: variant.localRef }
  }
  if (variant.availability === 'downloadable') {
    const expected = {
      ...(variant.size !== undefined ? { size: variant.size } : {}),
      ...(variant.digest !== undefined ? { digest: variant.digest } : {}),
    }
    return {
      kind: 'acquisition',
      intent: {
        logicalId: variant.logicalId,
        variantId: variant.variantId,
        providers: variant.providers,
        ...(Object.keys(expected).length > 0 ? { expected } : {}),
      },
    }
  }
  return { kind: 'unavailable', availability: variant.availability === 'resolving' ? 'resolving' : 'unavailable' }
}
