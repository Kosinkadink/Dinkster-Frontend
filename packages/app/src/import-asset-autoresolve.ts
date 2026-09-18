import type { AssetGuessCandidate, AssetGuessMatch } from '@dinkster/client'
import { assetGuessCandidateToRef, type ImportAssetReference } from './dialog-requests.js'

export type ImportAssetPromptReason = 'digest-conflict' | 'ambiguous' | 'no-match' | 'weak-match'

export interface ImportAssetDigestHint {
  readonly name: string
  readonly digest: string
}

export interface ImportAssetProvenance {
  readonly original: string
  readonly query: string
  readonly candidate: AssetGuessCandidate
  readonly digestHint?: string
}

export interface ImportAssetAutoresolutionPlan {
  readonly auto: Readonly<Record<string, AssetGuessCandidate>>
  readonly prompt: Readonly<Record<string, ImportAssetPromptReason>>
  readonly provenance: readonly ImportAssetProvenance[]
}

export const importAssetBasename = (name: string): string => name.split(/[\\/]/).pop() ?? name

export const importAssetBasenamesForNames = (names: readonly string[]): readonly string[] =>
  [...new Set(names.map(importAssetBasename).filter((basename, index) => basename !== names[index]))]

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)

const sorted = (candidates: readonly AssetGuessCandidate[]): readonly AssetGuessCandidate[] =>
  [...candidates].sort((a, b) => {
    const left = `${a.virtualPath ?? ''}\u0000${a.name}\u0000${a.mediaType ?? ''}\u0000${a.size ?? -1}\u0000${a.digest}`
    const right = `${b.virtualPath ?? ''}\u0000${b.name}\u0000${b.mediaType ?? ''}\u0000${b.size ?? -1}\u0000${b.digest}`
    return left < right ? -1 : left > right ? 1 : 0
  })

export function importAssetDigestHintsForNames(
  names: readonly string[],
  digestHints: readonly ImportAssetDigestHint[],
): Readonly<Record<string, string>> {
  const entries: Array<readonly [string, string]> = []
  for (const name of names) {
    const basename = importAssetBasename(name)
    const valid = digestHints.filter((hint) => /^blake3:[0-9a-f]{64}$/i.test(hint.digest))
    const exact = valid.filter((hint) => hint.name === name)
    const hints = exact.length > 0 ? exact : valid.filter((hint) => importAssetBasename(hint.name) === basename)
    const digests = new Set(hints.map((hint) => hint.digest.toLowerCase()))
    if (digests.size === 1) entries.push([name, [...digests][0]!])
  }
  return Object.fromEntries(entries)
}

export function importAssetMatchesForNames(
  names: readonly string[],
  matches: readonly AssetGuessMatch[],
  basenameMatches: readonly AssetGuessMatch[] = matches,
): readonly AssetGuessMatch[] {
  const matchesByQuery: Record<string, readonly AssetGuessCandidate[]> = Object.create(null) as Record<string, readonly AssetGuessCandidate[]>
  for (const match of matches) matchesByQuery[match.query] = match.candidates
  const basenamesByQuery: Record<string, readonly AssetGuessCandidate[]> = Object.create(null) as Record<string, readonly AssetGuessCandidate[]>
  for (const match of basenameMatches) basenamesByQuery[match.query] = match.candidates
  return names.map((name) => {
    const basename = importAssetBasename(name)
    const original = own(matchesByQuery, name) ? matchesByQuery[name]! : []
    const basenameCandidates = basename !== name && own(basenamesByQuery, basename)
      ? basenamesByQuery[basename]!.map((candidate) => ({ ...candidate, confidence: 'name' as const }))
      : []
    return { query: name, candidates: [...original, ...basenameCandidates] }
  })
}

export function planImportAssetAutoresolution(
  refs: readonly ImportAssetReference[],
  matches: readonly AssetGuessMatch[],
  digestHints: readonly ImportAssetDigestHint[],
  basenameMatches: readonly AssetGuessMatch[] = matches,
): ImportAssetAutoresolutionPlan {
  const auto: Record<string, AssetGuessCandidate> = Object.create(null) as Record<string, AssetGuessCandidate>
  const prompt: Record<string, ImportAssetPromptReason> = Object.create(null) as Record<string, ImportAssetPromptReason>
  const provenance: ImportAssetProvenance[] = []

  for (const name of new Set(refs.map((ref) => ref.name))) {
    const basename = importAssetBasename(name)
    const candidates = importAssetMatchesForNames([name], matches, basenameMatches)[0]!.candidates
    const complete = candidates.filter((candidate) => assetGuessCandidateToRef(candidate) !== undefined)
    const exactHints = digestHints.filter((candidate) => candidate.name === name)
    const hints = exactHints.length > 0
      ? exactHints
      : digestHints.filter((candidate) => importAssetBasename(candidate.name) === basename)
    const hintDigests = new Set(hints.map((hint) => hint.digest.toLowerCase()))

    if (hints.length > 0) {
      if (hintDigests.size > 1) {
        prompt[name] = 'digest-conflict'
        continue
      }
      const hintDigest = hints[0]!.digest
      const hits = sorted(complete.filter((candidate) => candidate.digest.toLowerCase() === hintDigest.toLowerCase()))
      const digestTier = hits.filter((candidate) => candidate.confidence === 'digest')
      const chosen = digestTier[0] ?? hits[0]
      if (chosen) {
        auto[name] = chosen
        provenance.push({ original: name, query: chosen.confidence === 'name' && basename !== name ? basename : name, candidate: chosen, digestHint: hintDigest })
      } else prompt[name] = complete.length === 0 ? 'no-match' : 'digest-conflict'
      continue
    }

    const path = complete.filter((candidate) => candidate.confidence === 'path')
    const exactName = complete.filter((candidate) => candidate.confidence === 'name' && candidate.name === basename)
    const tier = path.length > 0 ? path : exactName
    if (tier.length > 0) {
      const digests = new Set(tier.map((candidate) => candidate.digest))
      if (digests.size === 1) {
        const chosen = sorted(tier)[0]!
        auto[name] = chosen
        provenance.push({ original: name, query: path.includes(chosen) ? name : basename, candidate: chosen })
      } else prompt[name] = 'ambiguous'
    } else if (complete.length > 0) prompt[name] = 'weak-match'
    else prompt[name] = 'no-match'
  }
  return { auto, prompt, provenance }
}
