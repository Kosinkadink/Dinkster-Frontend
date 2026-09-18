import { describe, expect, it } from 'vitest'
import { parseAppViewText } from '../src/app-view-text.js'

describe('restricted App view text', () => {
  it('parses bold, italic, nested marks, and safe links', () => {
    expect(parseAppViewText('A **bold and *italic*** [link](https://example.test/help)')).toEqual([
      { text: 'A ' },
      { text: 'bold and ', bold: true },
      { text: 'italic', bold: true, italic: true },
      { text: ' ' },
      { text: 'link', href: 'https://example.test/help' },
    ])
  })

  it('leaves raw HTML, unsafe links, and unmatched marks as inert text', () => {
    expect(parseAppViewText('<img src=x> [run](javascript:alert(1)) *open')).toEqual([
      { text: '<img src=x> [run](javascript:alert(1)) *open' },
    ])
  })

  it('scans large malformed marker runs in linear time', () => {
    const brackets = '['.repeat(100_000)
    const repeatedUnsafeLink = `${'['.repeat(50_000)}](${'x'.repeat(50_000)})`
    const sources = [brackets, '*'.repeat(100_001), '[*'.repeat(50_000), repeatedUnsafeLink]
    const started = performance.now()
    const parsed = sources.map(parseAppViewText)

    expect(performance.now() - started).toBeLessThan(2_000)
    expect(parsed[0]).toEqual([{ text: brackets }])
    expect(parsed.map((segments) => segments.reduce((length, segment) => length + segment.text.length, 0))
      .every((length, index) => length <= sources[index]!.length)).toBe(true)
  })
})
