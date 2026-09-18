export interface RunAttribution {
  readonly principalId?: string | undefined
  readonly kind?: 'human' | 'agent' | undefined
}

export const runAttributionLabel = (attribution: RunAttribution): string | undefined =>
  attribution.kind === 'agent' ||
  (attribution.principalId !== undefined && attribution.principalId !== 'local')
    ? `queued by ${attribution.principalId ?? 'unknown'}`
    : undefined
