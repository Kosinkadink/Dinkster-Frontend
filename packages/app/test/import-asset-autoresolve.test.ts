import { describe, expect, it } from 'vitest'
import type { AssetGuessCandidate, AssetGuessConfidence, AssetGuessMatch } from '@dinkster/client'
import type { ImportAssetReference } from '../src/dialog-requests.js'
import { importAssetBasenamesForNames, importAssetDigestHintsForNames, importAssetMatchesForNames, planImportAssetAutoresolution } from '../src/import-asset-autoresolve.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const ref = (name: string): ImportAssetReference => ({ graphId: 'g0', nodeId: 'n1', inputId: 'model', name })
const candidate = (name: string, digest = A, confidence: AssetGuessConfidence = 'path', virtualPath = `models/${name}`): AssetGuessCandidate => ({
  digest: `blake3:${digest}`, name, confidence, held: true, virtualPath, size: 42, mediaType: 'application/octet-stream',
})
const match = (query: string, candidates: readonly AssetGuessCandidate[]): AssetGuessMatch => ({ query, candidates })
const plan = (name: string, matches: readonly AssetGuessMatch[], hints: readonly { name: string; digest: string }[] = []) =>
  planImportAssetAutoresolution([ref(name)], matches, hints)

describe('planImportAssetAutoresolution', () => {
  it('routes canonical hints to original names while leaving basename exploration unhinted', () => {
    const digest = `blake3:${A.toUpperCase()}`
    expect(importAssetDigestHintsForNames(
      ['folder/model.safetensors', 'other.bin'],
      [
        { name: 'model.safetensors', digest },
        { name: 'unused.bin', digest: `blake3:${B}` },
      ],
    )).toEqual({ 'folder/model.safetensors': digest.toLowerCase() })
  })

  it('keeps an original-name hint separate when that name is also another import basename', () => {
    const names = ['model.safetensors', 'folder/model.safetensors']
    expect(importAssetBasenamesForNames(names)).toEqual(['model.safetensors'])
    expect(importAssetDigestHintsForNames(names, [
      { name: 'model.safetensors', digest: `blake3:${A}` },
      { name: 'folder/model.safetensors', digest: `blake3:${B}` },
    ])).toEqual({
      'model.safetensors': `blake3:${A}`,
      'folder/model.safetensors': `blake3:${B}`,
    })
    const originalMatches = [
      match('model.safetensors', [candidate('renamed-a.bin', A, 'digest')]),
      match('folder/model.safetensors', [candidate('renamed-b.bin', B, 'digest')]),
    ]
    const basenameMatches = [match('model.safetensors', [candidate('model.safetensors', B, 'path')])]
    expect(importAssetMatchesForNames(['folder/model.safetensors'], originalMatches, basenameMatches)[0]!.candidates).toEqual([
      candidate('renamed-b.bin', B, 'digest'),
      { ...candidate('model.safetensors', B, 'path'), confidence: 'name' },
    ])
  })

  it('omits malformed and conflicting workflow hints from the wire', () => {
    expect(importAssetDigestHintsForNames(['model.safetensors'], [
      { name: 'model.safetensors', digest: `blake3:${A}` },
      { name: 'model.safetensors', digest: `blake3:${B}` },
      { name: 'model.safetensors', digest: 'sha256:' + A },
    ])).toEqual({})
  })

  it('prefers a complete digest-confidence hit over lower evidence with the same workflow digest', () => {
    const result = plan('model.safetensors', [match('model.safetensors', [
      candidate('model.safetensors', A, 'name', 'a/name-tier.bin'),
      candidate('renamed.bin', A, 'digest', 'z/digest-tier.bin'),
    ])], [{ name: 'model.safetensors', digest: `blake3:${A}` }])
    expect(result.auto['model.safetensors']?.virtualPath).toBe('z/digest-tier.bin')
  })

  it('auto-resolves a digest hit and deterministically picks among same-digest duplicates', () => {
    const result = plan('model.safetensors', [match('model.safetensors', [
      candidate('model.safetensors', A, 'name', 'z/model.safetensors'),
      candidate('model.safetensors', A, 'other', 'a/model.safetensors'),
    ])], [{ name: 'model.safetensors', digest: `blake3:${A}` }])
    expect(result.auto['model.safetensors']?.virtualPath).toBe('a/model.safetensors')
    expect(result.prompt['model.safetensors']).toBeUndefined()
  })

  it('reports digest conflict instead of falling back to filename similarity', () => {
    expect(plan('model.safetensors', [match('model.safetensors', [candidate('model.safetensors', B)])], [
      { name: 'model.safetensors', digest: `blake3:${A}` },
    ]).prompt['model.safetensors']).toBe('digest-conflict')
  })

  it('reports conflicting authoritative hints instead of depending on metadata order', () => {
    const matches = [match('model.safetensors', [candidate('model.safetensors', A), candidate('model.safetensors', B)])]
    const hints = [{ name: 'model.safetensors', digest: `blake3:${A}` }, { name: 'model.safetensors', digest: `blake3:${B}` }]
    expect(plan('model.safetensors', matches, hints).prompt['model.safetensors']).toBe('digest-conflict')
    expect(plan('model.safetensors', matches, [...hints].reverse()).prompt['model.safetensors']).toBe('digest-conflict')
  })

  it('reports no match when a digest hint has no complete candidates', () => {
    expect(plan('model.safetensors', [], [{ name: 'model.safetensors', digest: `blake3:${A}` }]).prompt['model.safetensors']).toBe('no-match')
  })

  it('auto-resolves a unique-digest path tier and rejects distinct path digests as ambiguous', () => {
    expect(plan('dir/model.safetensors', [match('dir/model.safetensors', [candidate('model.safetensors')])]).auto['dir/model.safetensors']).toBeDefined()
    expect(plan('dir/model.safetensors', [match('dir/model.safetensors', [candidate('one', A), candidate('two', B)])]).prompt['dir/model.safetensors']).toBe('ambiguous')
  })

  it('uses a basename query as a name-tier signal under the original name', () => {
    const result = plan('SD1.5/model.safetensors', [match('model.safetensors', [candidate('model.safetensors', A, 'path')])])
    expect(result.auto['SD1.5/model.safetensors']?.confidence).toBe('name')
    expect(result.provenance[0]?.original).toBe('SD1.5/model.safetensors')
  })

  it.each(['name-insensitive', 'stem', 'other'] as const)('never auto-resolves the %s tier', (confidence) => {
    expect(plan('model.safetensors', [match('model.safetensors', [candidate('model.safetensors', A, confidence)])]).prompt['model.safetensors']).toBe('weak-match')
  })

  it('ignores incomplete candidates for both auto-resolution and ambiguity', () => {
    const { virtualPath: _path, ...incomplete } = candidate('model.safetensors')
    const result = plan('model.safetensors', [match('model.safetensors', [incomplete, candidate('model.safetensors', B)])])
    expect(result.auto['model.safetensors']?.digest).toBe(`blake3:${B}`)
  })

  it('returns no-match when every candidate is incomplete', () => {
    const { mediaType: _mediaType, ...incomplete } = candidate('model.safetensors')
    expect(plan('model.safetensors', [match('model.safetensors', [incomplete])]).prompt['model.safetensors']).toBe('no-match')
  })

  it('treats hostile names as data without mutating map prototypes', () => {
    const result = plan('__proto__', [match('__proto__', [candidate('__proto__')])])
    expect(Object.getPrototypeOf(result.auto)).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(result.auto, '__proto__')).toBe(true)
  })
})
