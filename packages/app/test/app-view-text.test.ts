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
    const measurements = [25_000, 50_000].map((size) => {
      const sources = ['['.repeat(2 * size), '*'.repeat(2 * size + 1), '[*'.repeat(size), `${'['.repeat(size)}](${'x'.repeat(size)})`]
      return sources.map((source) => {
        let scanned = 0
        const parsed = parseAppViewText(source, (characters) => { scanned += characters })
        expect(parsed.reduce((length, segment) => length + segment.text.length, 0)).toBeLessThanOrEqual(source.length)
        expect(scanned).toBeGreaterThanOrEqual(source.length)
        expect(scanned).toBeLessThanOrEqual(3 * source.length)
        return { parsed, scanned }
      })
    })
    expect(measurements[1]![0]!.parsed).toEqual([{ text: '['.repeat(100_000) }])
    for (let index = 0; index < 4; index += 1) {
      expect(measurements[1]![index]!.scanned).toBeLessThanOrEqual(3 * measurements[0]![index]!.scanned)
    }
  })
})
