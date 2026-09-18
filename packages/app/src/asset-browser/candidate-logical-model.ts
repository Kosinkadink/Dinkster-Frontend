import type { CandidateV1 } from '@dinkster/client'
import type { LogicalModelAdapter, SourceRef, VariantDescription } from './logical-model.js'

const providerRef = (candidate: CandidateV1, provider: CandidateV1['providerSources'][number]): SourceRef => ({
  sourceId: JSON.stringify([provider.source.providerId, provider.source.sourceId]),
  sourceKind: 'provider',
  label: `${provider.source.providerId} / ${provider.source.sourceId}`,
})

const variantDescription = (candidate: CandidateV1): VariantDescription => ({
  variantId: candidate.variantId,
  logicalId: candidate.logicalId,
  dtype: candidate.dtype,
  quantization: candidate.quantization,
  format: candidate.format,
  ...(candidate.size !== undefined ? { size: candidate.size } : {}),
  digest: candidate.digest,
  providers: candidate.providerSources.map((provider) => providerRef(candidate, provider)),
  availability: candidate.availability.status === 'local'
    ? 'installed'
    : candidate.availability.status,
  compatibility: {
    status: candidate.compatibility.status,
    ...(candidate.compatibility.reason !== '' ? { reason: candidate.compatibility.reason } : {}),
  },
  ...(candidate.availability.status === 'local' && candidate.assetRef !== undefined
    ? { localRef: candidate.assetRef }
    : {}),
})

export function candidateLogicalModelAdapter(
  candidates: readonly CandidateV1[],
  sourceId = 'federated-candidates',
): LogicalModelAdapter {
  return {
    source: { sourceId, sourceKind: 'resolver', label: 'Federated candidates' },
    descriptions: candidates.map((candidate) => ({
      logicalId: candidate.logicalId,
      displayName: candidate.family,
      kind: candidate.assetKind,
      aliases: [],
      variants: [variantDescription(candidate)],
    })),
  }
}
