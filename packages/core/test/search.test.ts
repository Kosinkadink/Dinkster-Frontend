/**
 * Shared search scorer tests. The contract: one deterministic ranking for
 * every search box - AND token semantics, exact > prefix > word-boundary >
 * substring quality tiers scaled by field weight, typo tolerance only for
 * 4+ character tokens, ties keeping the caller's pre-sorted order, and NO
 * fzf-style letter-scatter subsequence matches.
 */
import { describe, expect, it } from 'vitest'
import { nodeSearchFields, rankSearch, scoreMatch, type SearchField } from '../src/search.js'

const f = (text: string, weight = 1): SearchField => ({ text, weight })

describe('scoreMatch quality tiers', () => {

  it('exact > prefix > word-boundary > substring on the same field', () => {
    const exact = scoreMatch('ksampler', [f('ksampler')])!
    const prefix = scoreMatch('ksamp', [f('ksampler')])!
    const wordPrefix = scoreMatch('samp', [f('advanced sampler')])!
    const substring = scoreMatch('ampl', [f('ksampler')])!
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(wordPrefix)
    expect(wordPrefix).toBeGreaterThan(substring)
  })

  it('field weight scales the score: a name hit beats a category hit', () => {
    const inName = scoreMatch('load', [f('Load Video', 3), f('video', 1)])!
    const inCategory = scoreMatch('video', [f('Load Checkpoint', 3), f('video', 1)])!
    expect(inName).toBeGreaterThan(inCategory)
  })

  it('word boundaries split on non-alphanumerics (dots, dashes, underscores)', () => {
    expect(scoreMatch('add', [f('std.math.add_ints')])).toBeGreaterThan(scoreMatch('dd', [f('std.math.add_ints')])!)
    expect(scoreMatch('ints', [f('std.math.add_ints')])).toBeDefined()
  })

  it('NO subsequence matching: scattered letters do not match', () => {
    // 'kslr' is a subsequence of 'ksampler' but not a substring/typo.
    expect(scoreMatch('kslr', [f('ksampler')])).toBeUndefined()
  })

  it('AND semantics: every token must match some field', () => {
    const fields = [f('Load Video'), f('vhs.load')]
    expect(scoreMatch('load video', fields)).toBeDefined()
    expect(scoreMatch('load audio', fields)).toBeUndefined()
  })

})

describe('typo tolerance', () => {
  it('one edit matches for 4+ character tokens; two edits do not', () => {
    expect(scoreMatch('samplor', [f('advanced sampler')])).toBeDefined() // 1 substitution
    expect(scoreMatch('videp', [f('Load Video')])).toBeDefined() // 1 substitution
    expect(scoreMatch('sampelr', [f('advanced sampler')])).toBeUndefined() // transposition = 2 edits
  })

  it('short tokens never fuzz', () => {
    expect(scoreMatch('vhx', [f('vhs.load')])).toBeUndefined() // 3 chars, 1 edit away from 'vhs'
  })

  it('typo hits rank below any true match', () => {
    const typo = scoreMatch('samplor', [f('sampler')])!
    const substring = scoreMatch('ampl', [f('sampler')])!
    expect(substring).toBeGreaterThan(typo)
  })
})

describe('rankSearch', () => {
  interface Item {
    readonly name: string
    readonly type: string
    readonly category: string
  }
  const items: Item[] = [
    { name: 'Empty Latent Image', type: 'EmptyLatentImage', category: 'latent' },
    { name: 'KSampler', type: 'KSampler', category: 'sampling' },
    { name: 'KSampler (Advanced)', type: 'KSamplerAdvanced', category: 'sampling' },
    { name: 'Load Checkpoint', type: 'CheckpointLoaderSimple', category: 'loaders' },
    { name: 'Load Video', type: 'vhs.load', category: 'video' },
    { name: 'Save Video', type: 'vhs.save', category: 'video' },
  ]
  const fieldsOf = (i: Item): SearchField[] => [f(i.name, 3), f(i.type, 2), f(i.category, 1)]

  it('empty query returns the input order unfiltered', () => {
    expect(rankSearch('', items, fieldsOf)).toEqual(items)
  })

  it('non-matches drop; ties keep input (pre-sorted) order', () => {
    const out = rankSearch('video', items, fieldsOf)
    expect(out.map((i) => i.name)).toEqual(['Load Video', 'Save Video'])
  })

  it('respects the limit after ranking', () => {
    const out = rankSearch('a', items, fieldsOf, { limit: 2 })
    expect(out).toHaveLength(2)
  })

})

describe('node search terms', () => {
  it('finds a node by a search term but ranks an exact display name above it', () => {
    const nodes = [
      { displayName: 'CheckpointLoaderSimple', type: 'test.direct', category: 'test' },
      { displayName: 'Load Checkpoint', type: 'dinkster.load_checkpoint', category: 'loaders', searchTerms: ['CheckpointLoaderSimple'] },
    ]
    expect(rankSearch('CheckpointLoaderSimple', nodes, nodeSearchFields).map((node) => node.type)).toEqual([
      'test.direct',
      'dinkster.load_checkpoint',
    ])
  })
})
