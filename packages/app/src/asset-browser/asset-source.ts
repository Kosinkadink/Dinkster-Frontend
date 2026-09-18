import type { CanonicalAssetRef } from './helpers.js'

const CANONICAL_DIGEST = /^blake3:[0-9a-f]{64}$/

declare const verifiedAssetDigestBrand: unique symbol

/** Content identity admitted only after a source has verified the bytes. */
export type VerifiedAssetDigest = string & { readonly [verifiedAssetDigestBrand]: true }

export interface AssetContentIdentity {
  readonly digest: VerifiedAssetDigest
}

export interface AssetForeignId {
  readonly namespace: string
  readonly value: string
}

export interface AssetProvenance {
  readonly source: string
  readonly value: string
}

/** Labels and provenance are lookup aids, never content or location authority. */
export interface AssetReferenceMetadata {
  readonly name: string
  readonly foreignIds?: readonly AssetForeignId[]
  readonly tags?: readonly string[]
  readonly provenance?: readonly AssetProvenance[]
}

/** Location authority is supplied by a catalog or mount grant. */
export interface AuthorizedAssetLocation {
  readonly virtualPath: string
}

export interface CanonicalAssetMetadata {
  readonly size: number
  readonly mediaType: string
}

/**
 * A source match deliberately keeps raw and partial metadata at this edge.
 * Resolution promotes only a verified canonical digest and an authorized
 * location. Size and mediaType become canonical metadata only as a complete,
 * valid pair; otherwise their lossless foreign envelope remains authoritative.
 */
export interface AssetSourceMatch {
  readonly sourceId: string
  /** Stable and unique within one source; ordering only, never authority. */
  readonly matchId: string
  readonly digest?: unknown
  readonly digestVerified: boolean
  readonly reference: AssetReferenceMetadata
  readonly location?: AuthorizedAssetLocation
  readonly size?: unknown
  readonly mediaType?: unknown
  readonly envelope: ForeignAssetEnvelope
}

export interface AssetResolutionCandidate {
  readonly sourceId: string
  readonly matchId: string
  readonly identity: AssetContentIdentity
  readonly reference: AssetReferenceMetadata
  readonly location: AuthorizedAssetLocation
  readonly metadata?: CanonicalAssetMetadata
  readonly envelope: ForeignAssetEnvelope
}

export type AssetResolution =
  | { readonly status: 'resolved'; readonly identity: AssetContentIdentity; readonly candidates: readonly [AssetResolutionCandidate, ...AssetResolutionCandidate[]]; readonly selected: AssetResolutionCandidate }
  | { readonly status: 'unresolved'; readonly candidates: readonly [] }
  | { readonly status: 'ambiguous'; readonly identities: readonly [AssetContentIdentity, AssetContentIdentity, ...AssetContentIdentity[]]; readonly candidates: readonly [AssetResolutionCandidate, ...AssetResolutionCandidate[]] }

export interface AssetResolveRequest {
  readonly reference: AssetReferenceMetadata
  readonly digest?: string
  readonly signal?: AbortSignal
}

export interface AssetCatalogRequest {
  readonly text: string
  readonly tags?: readonly string[]
  readonly cursor?: string
  readonly limit: number
  readonly signal?: AbortSignal
}

export interface AssetCatalogItem {
  readonly id: string
  readonly candidate: AssetSourceMatch
}

export interface AssetCatalogPage {
  readonly items: readonly AssetCatalogItem[]
  readonly cursor?: string
}

/** Mock, future backend-wire, and ComfyUI adapters implement this seam. */
export interface AssetSource {
  readonly id: string
  readonly label: string
  resolve(request: AssetResolveRequest): Promise<readonly AssetSourceMatch[]>
  query(request: AssetCatalogRequest): Promise<AssetCatalogPage>
}

const verifiedIdentity = (match: AssetSourceMatch): AssetContentIdentity | undefined => {
  if (!match.digestVerified || typeof match.digest !== 'string' || !CANONICAL_DIGEST.test(match.digest)) return undefined
  return { digest: match.digest as VerifiedAssetDigest }
}

const canonicalMetadata = (match: AssetSourceMatch): CanonicalAssetMetadata | undefined => {
  if (typeof match.size !== 'number' || !Number.isSafeInteger(match.size) || match.size < 0) return undefined
  if (typeof match.mediaType !== 'string' || match.mediaType.trim() === '') return undefined
  return { size: match.size, mediaType: match.mediaType }
}

const candidateOf = (match: AssetSourceMatch): AssetResolutionCandidate | undefined => {
  const identity = verifiedIdentity(match)
  if (identity === undefined || match.location === undefined || match.location.virtualPath.trim() === '') return undefined
  const metadata = canonicalMetadata(match)
  return {
    sourceId: match.sourceId,
    matchId: match.matchId,
    identity,
    reference: match.reference,
    location: match.location,
    ...(metadata !== undefined ? { metadata } : {}),
    envelope: match.envelope,
  }
}

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

/**
 * Resolve verified candidates without filename selection. Same-digest
 * duplicates are content-equivalent and sort by virtualPath, then source id,
 * reference name, and source-local match id using code-unit ordering. Complete
 * metadata and its values are final tie-breakers for a source that violates
 * match-id uniqueness. The first row is the stable authorized location;
 * different digests remain ambiguous.
 */
export function resolveAssetCandidates(matches: readonly AssetSourceMatch[]): AssetResolution {
  const candidates = matches.flatMap((match) => {
    const candidate = candidateOf(match)
    return candidate === undefined ? [] : [candidate]
  }).sort((left, right) =>
    compareText(left.location.virtualPath, right.location.virtualPath) ||
    compareText(left.sourceId, right.sourceId) ||
    compareText(left.reference.name, right.reference.name) ||
    compareText(left.matchId, right.matchId) ||
    Number(right.metadata !== undefined) - Number(left.metadata !== undefined) ||
    compareText(left.metadata?.mediaType ?? '', right.metadata?.mediaType ?? '') ||
    ((left.metadata?.size ?? -1) - (right.metadata?.size ?? -1)))
  if (candidates.length === 0) return { status: 'unresolved', candidates: [] }

  const byDigest = new Map<string, AssetContentIdentity>()
  for (const candidate of candidates) byDigest.set(candidate.identity.digest, candidate.identity)
  const identities = [...byDigest.values()].sort((left, right) => compareText(left.digest, right.digest))
  const tuple = candidates as [AssetResolutionCandidate, ...AssetResolutionCandidate[]]
  if (identities.length === 1) {
    return { status: 'resolved', identity: identities[0]!, candidates: tuple, selected: tuple[0] }
  }
  return {
    status: 'ambiguous',
    identities: identities as [AssetContentIdentity, AssetContentIdentity, ...AssetContentIdentity[]],
    candidates: tuple,
  }
}

/** Aggregate adapter matches while making the adapter id, not its payload, the source identity. */
export async function resolveFromAssetSources(sources: readonly AssetSource[], request: AssetResolveRequest): Promise<AssetResolution> {
  const pages = await Promise.all(sources.map(async (source) =>
    (await source.resolve(request)).map((match): AssetSourceMatch => ({ ...match, sourceId: source.id }))))
  return resolveAssetCandidates(pages.flat())
}

/** Build the executable five-field value only from a complete promoted candidate. */
export function canonicalAssetRef(candidate: AssetResolutionCandidate): CanonicalAssetRef | undefined {
  if (candidate.metadata === undefined) return undefined
  return {
    digest: candidate.identity.digest,
    name: candidate.reference.name,
    size: candidate.metadata.size,
    mediaType: candidate.metadata.mediaType,
    virtualPath: candidate.location.virtualPath,
  }
}

/** Open foreign records preserve every known and future field. */
export interface ForeignAssetRecord {
  readonly [field: string]: unknown
}

export interface ComfyAssetApiRecord extends ForeignAssetRecord {
  readonly id: string
  readonly name: string
  readonly hash: string | null
  readonly asset_hash: string | null
  readonly loader_path: string | null
  readonly display_name: string | null
  readonly size: number | null
  readonly mime_type: string | null
  readonly tags: readonly string[]
  readonly user_metadata: unknown
  readonly metadata: unknown
  readonly is_immutable: boolean
}

export interface ComfyWorkflowModelRecord extends ForeignAssetRecord {
  readonly name: string
  readonly url: string
  readonly directory: string
  readonly hash?: string
  readonly hash_type?: string
}

/**
 * The foreign object is retained by identity and never normalized or cloned.
 * Unknown fields and values therefore round-trip exactly through this layer.
 */
export interface ForeignAssetEnvelope<T extends ForeignAssetRecord = ForeignAssetRecord> {
  readonly kind: string
  readonly foreign: T
  readonly derivedCandidate?: AssetSourceMatch
}

export function createForeignAssetEnvelope<T extends ForeignAssetRecord>(
  kind: string,
  foreign: T,
  derivedCandidate?: AssetSourceMatch,
): ForeignAssetEnvelope<T> {
  return { kind, foreign, ...(derivedCandidate !== undefined ? { derivedCandidate } : {}) }
}

export function foreignRecordOf<T extends ForeignAssetRecord>(envelope: ForeignAssetEnvelope<T>): T {
  return envelope.foreign
}

export interface AssetCatalogQueryState {
  readonly sourceId: string
  readonly text: string
  readonly tags: readonly string[]
}

interface AssetCatalogStateCommon {
  readonly query: AssetCatalogQueryState
  readonly items: readonly AssetCatalogItem[]
  readonly requestId: number
  readonly cursor?: string
  readonly selectedId?: string
}

export type AssetCatalogState = AssetCatalogStateCommon & (
  | { readonly status: 'idle' | 'loading' | 'ready'; readonly error?: never }
  | { readonly status: 'error'; readonly error: string }
)

export type AssetCatalogAction =
  | { readonly type: 'queryChanged'; readonly query: AssetCatalogQueryState }
  | { readonly type: 'loadStarted'; readonly requestId: number }
  | { readonly type: 'loadSucceeded'; readonly requestId: number; readonly items: readonly AssetCatalogItem[]; readonly append: boolean; readonly cursor?: string }
  | { readonly type: 'loadFailed'; readonly requestId: number; readonly error: string }
  | { readonly type: 'selectionChanged'; readonly id?: string }

export function reduceAssetCatalog(state: AssetCatalogState, action: AssetCatalogAction): AssetCatalogState {
  if (action.type === 'queryChanged') {
    return { query: action.query, status: 'idle', items: [], requestId: state.requestId + 1 }
  }
  if (action.type === 'selectionChanged') {
    const id = action.id !== undefined && state.items.some((item) => item.id === action.id) ? action.id : undefined
    if (id !== undefined) return { ...state, selectedId: id }
    const { selectedId: _selectedId, ...rest } = state
    return rest
  }
  if (action.requestId !== state.requestId) return state
  if (action.type === 'loadStarted') {
    const { error: _error, ...rest } = state
    return { ...rest, status: 'loading' }
  }
  if (action.type === 'loadSucceeded') {
    const { error: _error, cursor: _cursor, ...rest } = state
    return {
      ...rest,
      status: 'ready',
      items: action.append ? [...state.items, ...action.items] : action.items,
      ...(action.cursor !== undefined ? { cursor: action.cursor } : {}),
    }
  }
  const { error: _error, ...rest } = state
  return { ...rest, status: 'error', error: action.error }
}

/** Framework-free query/selection store. Product UI wiring is intentionally absent. */
export class AssetCatalogStore {
  private readonly sources: ReadonlyMap<string, AssetSource>
  private state: AssetCatalogState

  constructor(sources: readonly AssetSource[], sourceId: string, private readonly limit = 50) {
    this.sources = new Map(sources.map((source) => [source.id, source]))
    this.state = { query: { sourceId, text: '', tags: [] }, status: 'idle', items: [], requestId: 0 }
  }

  getState(): AssetCatalogState {
    return this.state
  }

  setQuery(query: { readonly sourceId?: string; readonly text: string; readonly tags?: readonly string[] }): void {
    this.state = reduceAssetCatalog(this.state, {
      type: 'queryChanged',
      query: { sourceId: query.sourceId ?? this.state.query.sourceId, text: query.text, tags: query.tags ?? [] },
    })
  }

  select(id?: string): void {
    this.state = reduceAssetCatalog(this.state, { type: 'selectionChanged', ...(id !== undefined ? { id } : {}) })
  }

  async loadMore(): Promise<void> {
    if (this.state.status === 'loading') return
    if (this.state.status === 'ready' && this.state.cursor === undefined) return
    const source = this.sources.get(this.state.query.sourceId)
    const append = this.state.cursor !== undefined
    const requestId = this.state.requestId
    this.state = reduceAssetCatalog(this.state, { type: 'loadStarted', requestId })
    if (source === undefined) {
      this.state = reduceAssetCatalog(this.state, { type: 'loadFailed', requestId, error: `Unknown asset source: ${this.state.query.sourceId}` })
      return
    }
    const request: AssetCatalogRequest = {
      text: this.state.query.text,
      tags: this.state.query.tags,
      limit: this.limit,
      ...(this.state.cursor !== undefined ? { cursor: this.state.cursor } : {}),
    }
    try {
      const page = await source.query(request)
      this.state = reduceAssetCatalog(this.state, {
        type: 'loadSucceeded', requestId, items: page.items, append,
        ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
      })
    } catch (error) {
      this.state = reduceAssetCatalog(this.state, {
        type: 'loadFailed', requestId, error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
