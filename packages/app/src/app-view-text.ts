export interface AppViewTextSegment {
  readonly text: string
  readonly bold?: true
  readonly italic?: true
  readonly href?: string
}

interface Marks {
  readonly bold?: true
  readonly italic?: true
  readonly href?: string
}

interface SegmentBuilder extends Marks {
  readonly chunks: string[]
}

interface Delimiters {
  readonly star: Int32Array
  readonly bold: Int32Array
  readonly labelEnd: Int32Array
  readonly paren: Int32Array
  readonly links: Map<number, { readonly end: number; readonly href?: string }>
}

const MAX_NESTING = 16

const safeLink = (value: string): string | undefined => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

const sameMarks = (left: Marks, right: Marks): boolean =>
  left.bold === right.bold && left.italic === right.italic && left.href === right.href

const append = (
  segments: SegmentBuilder[],
  source: string,
  start: number,
  end: number,
  marks: Marks,
): void => {
  if (start === end) return
  const previous = segments.at(-1)
  if (previous !== undefined && sameMarks(previous, marks)) previous.chunks.push(source.slice(start, end))
  else segments.push({ chunks: [source.slice(start, end)], ...marks })
}

const delimiterIndexes = (source: string): Delimiters => {
  const star = new Int32Array(source.length + 2).fill(-1)
  const bold = new Int32Array(source.length + 2).fill(-1)
  const labelEnd = new Int32Array(source.length + 2).fill(-1)
  const paren = new Int32Array(source.length + 2).fill(-1)
  let nextStar = -1
  let nextBold = -1
  let nextLabelEnd = -1
  let nextParen = -1
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (source[index] === '*') nextStar = index
    if (source[index] === '*' && source[index + 1] === '*') nextBold = index
    if (source[index] === ']' && source[index + 1] === '(') nextLabelEnd = index
    if (source[index] === ')') nextParen = index
    star[index] = nextStar
    bold[index] = nextBold
    labelEnd[index] = nextLabelEnd
    paren[index] = nextParen
  }
  return { star, bold, labelEnd, paren, links: new Map() }
}

const parseRange = (
  source: string,
  start: number,
  end: number,
  marks: Marks,
  segments: SegmentBuilder[],
  delimiters: Delimiters,
  depth: number,
): void => {
  if (depth === MAX_NESTING) {
    append(segments, source, start, end, marks)
    return
  }
  let offset = start
  while (offset < end) {
    if (source.startsWith('**', offset)) {
      let close = delimiters.bold[offset + 2] ?? -1
      if (close !== -1 && close + 1 < end) {
        if (close + 2 < end && source[close + 2] === '*') close += 1
        parseRange(source, offset + 2, close, { ...marks, bold: true }, segments, delimiters, depth + 1)
        offset = close + 2
        continue
      }
    }
    if (source[offset] === '*') {
      const close = delimiters.star[offset + 1] ?? -1
      if (close !== -1 && close < end) {
        parseRange(source, offset + 1, close, { ...marks, italic: true }, segments, delimiters, depth + 1)
        offset = close + 1
        continue
      }
    }
    if (source[offset] === '[') {
      const labelEnd = delimiters.labelEnd[offset + 1] ?? -1
      if (labelEnd !== -1 && labelEnd < end) {
        let link = delimiters.links.get(labelEnd)
        if (link === undefined) {
          const linkEnd = delimiters.paren[labelEnd + 2] ?? -1
          const href = linkEnd === -1 ? undefined : safeLink(source.slice(labelEnd + 2, linkEnd))
          link = {
            end: linkEnd,
            ...(href === undefined ? {} : { href }),
          }
          delimiters.links.set(labelEnd, link)
        }
        if (link.href !== undefined && link.end < end) {
          parseRange(source, offset + 1, labelEnd, { ...marks, href: link.href }, segments, delimiters, depth + 1)
          offset = link.end + 1
          continue
        }
      }
    }
    let textEnd = offset + 1
    while (textEnd < end && source[textEnd] !== '*' && source[textEnd] !== '[') textEnd += 1
    append(segments, source, offset, textEnd, marks)
    offset = textEnd
  }
}

/** Parses bold, italic, and http/https links without interpreting HTML. */
export function parseAppViewText(source: string): readonly AppViewTextSegment[] {
  const segments: SegmentBuilder[] = []
  parseRange(source, 0, source.length, {}, segments, delimiterIndexes(source), 0)
  return segments.map(({ chunks, ...marks }) => ({ text: chunks.join(''), ...marks }))
}
