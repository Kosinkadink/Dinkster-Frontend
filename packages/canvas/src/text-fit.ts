/**
 * Shared text measurement + fit-to-width for canvas painters.
 *
 * measureText is the hottest call in widget painting: every visible row used
 * to measure its label and value with a strip-one-character loop per repaint.
 * This module memoizes exact measureText results per context+font and finds
 * truncation points by binary search over prefix length (O(log n) measures,
 * each cached), so steady-state repaints answer entirely from the cache.
 * The prepare-once/answer-cheap idea follows pretext; full glyph-run
 * preparation remains unnecessary because measured multiline wrapping uses
 * the same memoized widths and binary-searches each visual line.
 *
 * Caches key on the ctx OBJECT (WeakMap) plus ctx.font, so two canvases (or
 * two tests stubbing measureText differently) never poison each other, and a
 * dropped canvas releases its cache. Call resetTextMetrics(ctx) if font
 * metrics change under a fixed font string (e.g. a webfont finishing load).
 */

const MAX_ENTRIES = 8192
const ELLIPSIS = '...'

/** Compact multiline rhythm shared by canvas previews and the DOM editor. */
export function multilineLineHeight(fontSize: number): number {
  return Math.ceil(fontSize * 4 / 3)
}

interface FontCache {
  readonly widths: Map<string, number>
  readonly fits: Map<string, string>
}

const caches = new WeakMap<CanvasRenderingContext2D, FontCache>()

function cacheFor(ctx: CanvasRenderingContext2D): FontCache {
  let c = caches.get(ctx)
  if (!c) caches.set(ctx, (c = { widths: new Map(), fits: new Map() }))
  return c
}

/** Drop cached metrics for one context (webfont load changed real metrics). */
export function resetTextMetrics(ctx: CanvasRenderingContext2D): void {
  caches.delete(ctx)
}

/** FIFO-ish eviction: Map iteration order is insertion order; visible rows
 * re-insert every frame, so the oldest quarter is the least likely needed. */
function evict(map: Map<string, unknown>): void {
  if (map.size < MAX_ENTRIES) return
  let drop = MAX_ENTRIES >> 2
  for (const key of map.keys()) {
    map.delete(key)
    if (--drop <= 0) break
  }
}

/** Memoized ctx.measureText(text).width for the context's CURRENT font. */
export function measureWidth(ctx: CanvasRenderingContext2D, text: string): number {
  const cache = cacheFor(ctx).widths
  const key = `${ctx.font}\u0000${text}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const w = ctx.measureText(text).width
  evict(cache)
  cache.set(key, w)
  return w
}

/**
 * Truncate a single-line run to fit maxWidth, appending '...' when shortened.
 * Exact (verifies with real measurements), found via binary search on prefix
 * length. Width quantizes down to whole pixels so cache keys stay hot across
 * subpixel layout jitter without ever overflowing the requested width.
 */
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  const w = Math.floor(maxWidth)
  // NaN survives Math.floor and every <= comparison: a non-finite width is
  // unusable and must not seed the fit cache under a NaN key.
  if (!Number.isFinite(w) || w <= 0) return ''
  const cache = cacheFor(ctx).fits
  const key = `${ctx.font}\u0000${w}\u0000${text}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const out = computeFit(ctx, text, w)
  evict(cache)
  cache.set(key, out)
  return out
}

function computeFit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (measureWidth(ctx, text) <= width) return text
  if (measureWidth(ctx, ELLIPSIS) > width) return ''
  // Longest prefix whose width plus the ellipsis fits. Assumes width is
  // non-decreasing in prefix length (true for any practical run).
  let lo = 0 // known to fit (bare ellipsis checked above)
  let hi = text.length - 1 // full text already failed
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (measureWidth(ctx, `${text.slice(0, mid)}${ELLIPSIS}`) <= width) lo = mid
    else hi = mid - 1
  }
  return `${text.slice(0, lo)}${ELLIPSIS}`
}

/**
 * Wrap one canonical line into measured visual lines. Word boundaries are
 * preferred, while a single overlong token breaks at the widest fitting
 * character so canvas text can never create horizontal overflow.
 */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const width = Math.floor(maxWidth)
  if (text === '') return ['']
  if (!Number.isFinite(width) || width <= 0) return ['']
  const lines: string[] = []
  let remaining = Array.from(text)
  while (measureWidth(ctx, remaining.join('')) > width) {
    let lo = 0
    let hi = remaining.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (measureWidth(ctx, remaining.slice(0, mid).join('')) <= width) lo = mid
      else hi = mid - 1
    }
    const fit = Math.max(1, lo)
    let whitespace = -1
    for (let index = 0; index <= fit; index += 1) {
      if (remaining[index] === ' ' || remaining[index] === '\t') whitespace = index
    }
    const end = whitespace > 0 ? whitespace : fit
    lines.push(remaining.slice(0, end).join(''))
    let next = whitespace > 0 ? whitespace + 1 : fit
    while (remaining[next] === ' ' || remaining[next] === '\t') next += 1
    remaining = remaining.slice(next)
  }
  if (remaining.length > 0) lines.push(remaining.join(''))
  return lines
}

/** Readability floors: below these, a zone shows nothing useful. */
const MIN_LABEL = 44
const MIN_VALUE = 56
const LABEL_VALUE_GAP = 5
/** The label absorbs this multiple of its proportional deficit share: values
 * are what you read; full names live in the tooltip/editor. */
const LABEL_BIAS = 1.5

/**
 * Deficit-proportional label/value split for one widget row.
 *
 * When both natural widths fit, the label takes exactly what it needs and the
 * value gets the rest - no truncation. When they do not fit, each side gives
 * up space in proportion to its natural width (label biased to give up more),
 * clamped to readability floors. Pathologically narrow rows fall back to a
 * floor-proportional split so neither side vanishes entirely.
 *
 * With preserveValue enabled, a value that fits beside the label floor gets
 * its full natural width plus the label/value gap. The label gives up space
 * first, matching BaseWidget's default allocation policy. Values that cannot
 * fit keep the deficit-proportional behavior unchanged.
 *
 * Returns the label zone width; the value zone is usable minus label.
 */
export function shareRowWidth(
  usable: number,
  naturalLabel: number,
  naturalValue: number,
  preserveValue = false,
): number {
  if (naturalLabel + naturalValue <= usable) return naturalLabel
  if (preserveValue && naturalValue <= usable - MIN_LABEL - LABEL_VALUE_GAP) {
    return Math.min(naturalLabel, usable - naturalValue - LABEL_VALUE_GAP)
  }
  const minLabel = Math.min(naturalLabel, MIN_LABEL)
  const minValue = Math.min(naturalValue, MIN_VALUE)
  if (usable <= minLabel + minValue) {
    return usable * (minLabel / Math.max(1, minLabel + minValue))
  }
  const deficit = naturalLabel + naturalValue - usable
  const labelShare = (naturalLabel * LABEL_BIAS) / (naturalLabel * LABEL_BIAS + naturalValue)
  const label = naturalLabel - deficit * labelShare
  const value = naturalValue - deficit * (1 - labelShare)
  if (label < minLabel) return minLabel
  if (value < minValue) return Math.min(naturalLabel, usable - minValue)
  return label
}
