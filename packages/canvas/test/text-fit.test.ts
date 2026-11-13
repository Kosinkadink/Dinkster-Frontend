/**
 * Text fit utilities: memoized measurement, binary-search truncation, and
 * the deficit-proportional row split. The measure cache keys on the ctx
 * OBJECT plus font, so contexts with different metrics never cross-poison.
 */
import { describe, expect, it } from 'vitest'
import { fitText, measureWidth, shareRowWidth, wrapText } from '../src/text-fit.js'

function countingCtx(pxPerChar = 6): { ctx: CanvasRenderingContext2D; calls: () => number } {
  let calls = 0
  const ctx = {
    font: '12px system-ui',
    measureText: (t: string) => {
      calls += 1
      return { width: t.length * pxPerChar }
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls: () => calls }
}

describe('measureWidth', () => {

  it('two contexts with different metrics never share entries', () => {
    const a = countingCtx(6)
    const b = countingCtx(10)
    expect(measureWidth(a.ctx, 'abc')).toBe(18)
    expect(measureWidth(b.ctx, 'abc')).toBe(30)
  })

})

describe('fitText', () => {

  it('truncates with an ASCII ellipsis to exactly the widest fitting prefix', () => {
    const { ctx } = countingCtx()
    // 6px/char: 'abcdefghij' = 60px. At 42px, prefix+'...' must be <= 7 chars.
    expect(fitText(ctx, 'abcdefghij', 42)).toBe('abcd...')
  })

  it('matches the naive strip-one-character loop on every width', () => {
    const { ctx } = countingCtx()
    const text = 'the quick brown fox jumps'
    const naive = (t: string, w: number): string => {
      if (w <= 0) return ''
      if (t.length * 6 <= w) return t
      if (18 > w) return ''
      let end = t.length
      while (end > 0 && (end + 3) * 6 > w) end -= 1
      return `${t.slice(0, end)}...`
    }
    for (let w = 0; w <= text.length * 6 + 6; w += 1) {
      expect(fitText(ctx, text, w)).toBe(naive(text, w))
    }
  })

})

describe('wrapText', () => {
  it('wraps at word boundaries without ellipsizing', () => {
    const { ctx } = countingCtx()
    expect(wrapText(ctx, 'alpha beta gamma', 60)).toEqual(['alpha beta', 'gamma'])
  })

  it('breaks an overlong token at measured character boundaries', () => {
    const { ctx } = countingCtx()
    expect(wrapText(ctx, 'abcdefghij', 24)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('preserves an empty canonical line', () => {
    const { ctx } = countingCtx()
    expect(wrapText(ctx, '', 60)).toEqual([''])
  })

  it('does not carry boundary whitespace onto the next visual line', () => {
    const { ctx } = countingCtx()
    expect(wrapText(ctx, 'alpha beta', 30)).toEqual(['alpha', 'beta'])
    expect(wrapText(ctx, 'alpha   beta', 30)).toEqual(['alpha', 'beta'])
    expect(wrapText(ctx, '  alpha', 42)).toEqual(['  alpha'])
  })

  it('consumes trailing spaces across the width boundary without a phantom row', () => {
    const { ctx } = countingCtx()
    expect(wrapText(ctx, `alpha${' '.repeat(12)}`, 30)).toEqual(['alpha'])
  })

  it('never splits a supplementary code point', () => {
    const { ctx } = countingCtx()
    const emoji = '\u{1f600}'
    expect(wrapText(ctx, emoji.repeat(3), 24)).toEqual([emoji.repeat(2), emoji])
  })
})

describe('shareRowWidth', () => {
  it('when both fit, the label gets exactly its natural width', () => {
    expect(shareRowWidth(300, 100, 150)).toBe(100)
  })

  it('under deficit both zones shrink; the label gives up more per px', () => {
    const label = shareRowWidth(200, 150, 150)
    const value = 200 - label
    expect(label).toBeLessThan(150)
    expect(value).toBeLessThan(150)
    expect(150 - label).toBeGreaterThan(150 - value) // label bias
  })

  it('the label never drops below its floor while space allows', () => {
    const label = shareRowWidth(200, 60, 500)
    expect(label).toBeGreaterThanOrEqual(44)
  })

  it('the value never drops below its floor while space allows', () => {
    const label = shareRowWidth(200, 500, 60)
    expect(200 - label).toBeGreaterThanOrEqual(56)
  })

  it('preserves a short value and ellipsizes the label into the remainder', () => {
    expect(shareRowWidth(120, 100, 40, true)).toBe(75)
  })

})
