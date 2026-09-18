export type MarkdownInline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'emphasis'; readonly children: readonly MarkdownInline[] }
  | { readonly kind: 'strong'; readonly children: readonly MarkdownInline[] }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly MarkdownInline[] }
  | { readonly kind: 'image'; readonly asset: string; readonly alt: string }

export interface MarkdownListItem {
  readonly children: readonly MarkdownBlock[]
}

export type MarkdownBlock =
  | { readonly kind: 'heading'; readonly depth: number; readonly children: readonly MarkdownInline[] }
  | { readonly kind: 'paragraph'; readonly children: readonly MarkdownInline[] }
  | { readonly kind: 'code'; readonly language?: string; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly start?: number; readonly items: readonly MarkdownListItem[] }
  | { readonly kind: 'quote'; readonly children: readonly MarkdownBlock[] }
  | { readonly kind: 'table'; readonly head: readonly (readonly MarkdownInline[])[]; readonly rows: readonly (readonly (readonly MarkdownInline[])[])[] }
  | { readonly kind: 'media'; readonly asset: string; readonly poster?: string; readonly caption?: string }
  | { readonly kind: 'template'; readonly template: string; readonly caption?: string; readonly source: string }

const SAFE_LINK = /^(?:https:|mailto:|dinkster:)/i
const ASSET_PATH = /^assets\/(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^?#]+$/
const LIST_ITEM = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/

const stripRawHtml = (source: string): string => source
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<[^>]*>/g, '')

const appendText = (nodes: MarkdownInline[], text: string): void => {
  if (text === '') return
  const previous = nodes.at(-1)
  if (previous?.kind === 'text') nodes[nodes.length - 1] = { kind: 'text', text: previous.text + text }
  else nodes.push({ kind: 'text', text })
}

const closingDelimiter = (source: string, delimiter: string, from: number): number => {
  let index = source.indexOf(delimiter, from)
  while (index >= 0 && source[index - 1] === '\\') index = source.indexOf(delimiter, index + delimiter.length)
  return index
}

export function parseMarkdownInline(raw: string): readonly MarkdownInline[] {
  const source = stripRawHtml(raw)
  const nodes: MarkdownInline[] = []
  let index = 0
  while (index < source.length) {
    if (source[index] === '\\' && index + 1 < source.length) {
      appendText(nodes, source[index + 1]!)
      index += 2
      continue
    }
    if (source.startsWith('![', index)) {
      const labelEnd = source.indexOf('](', index + 2)
      const targetEnd = labelEnd < 0 ? -1 : source.indexOf(')', labelEnd + 2)
      if (labelEnd >= 0 && targetEnd >= 0) {
        const alt = source.slice(index + 2, labelEnd)
        const asset = source.slice(labelEnd + 2, targetEnd).trim()
        if (ASSET_PATH.test(asset)) nodes.push({ kind: 'image', asset, alt })
        else appendText(nodes, alt)
        index = targetEnd + 1
        continue
      }
    }
    if (source[index] === '[') {
      const labelEnd = source.indexOf('](', index + 1)
      const targetEnd = labelEnd < 0 ? -1 : source.indexOf(')', labelEnd + 2)
      if (labelEnd >= 0 && targetEnd >= 0) {
        const label = source.slice(index + 1, labelEnd)
        const href = source.slice(labelEnd + 2, targetEnd).trim()
        if (SAFE_LINK.test(href)) nodes.push({ kind: 'link', href, children: parseMarkdownInline(label) })
        else nodes.push(...parseMarkdownInline(label))
        index = targetEnd + 1
        continue
      }
    }
    if (source[index] === '`') {
      const end = closingDelimiter(source, '`', index + 1)
      if (end >= 0) {
        nodes.push({ kind: 'code', text: source.slice(index + 1, end) })
        index = end + 1
        continue
      }
    }
    const strong = source.startsWith('**', index) ? '**' : source.startsWith('__', index) ? '__' : undefined
    if (strong !== undefined) {
      const end = closingDelimiter(source, strong, index + 2)
      if (end > index + 2) {
        nodes.push({ kind: 'strong', children: parseMarkdownInline(source.slice(index + 2, end)) })
        index = end + 2
        continue
      }
    }
    const emphasis = source[index] === '*' || source[index] === '_' ? source[index]! : undefined
    if (emphasis !== undefined) {
      const end = closingDelimiter(source, emphasis, index + 1)
      if (end > index + 1) {
        nodes.push({ kind: 'emphasis', children: parseMarkdownInline(source.slice(index + 1, end)) })
        index = end + 1
        continue
      }
    }
    appendText(nodes, source[index]!)
    index += 1
  }
  return nodes
}

const tableCells = (line: string): string[] => {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  let escaped = false
  for (const char of trimmed) {
    if (char === '|' && !escaped) {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
    escaped = char === '\\' && !escaped
    if (char !== '\\') escaped = false
  }
  cells.push(current.trim())
  return cells
}

const isTableDivider = (line: string): boolean => {
  const cells = tableCells(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

const mediaBlock = (lines: readonly string[]): MarkdownBlock | undefined => {
  const values: Record<string, string> = {}
  for (const line of lines) {
    if (line.trim() === '') continue
    const match = /^\s*(asset|poster|caption)\s*=\s*"([^"\r\n]*)"\s*$/.exec(line)
    if (match === null || values[match[1]!] !== undefined) return undefined
    values[match[1]!] = match[2]!
  }
  if (!ASSET_PATH.test(values['asset'] ?? '')) return undefined
  if (values['poster'] !== undefined && !ASSET_PATH.test(values['poster'])) return undefined
  return {
    kind: 'media',
    asset: values['asset']!,
    ...(values['poster'] !== undefined ? { poster: values['poster'] } : {}),
    ...(values['caption'] !== undefined ? { caption: values['caption'] } : {}),
  }
}

const templateBlock = (lines: readonly string[]): MarkdownBlock | undefined => {
  const values: Record<string, string> = {}
  for (const line of lines) {
    if (line.trim() === '') continue
    const match = /^\s*(template|caption)\s*=\s*"([^"\r\n]*)"\s*$/.exec(line)
    if (match === null || values[match[1]!] !== undefined) return undefined
    values[match[1]!] = match[2]!
  }
  const template = values['template']
  if (template === undefined || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(template)) return undefined
  return {
    kind: 'template',
    template,
    ...(values['caption'] !== undefined ? { caption: values['caption'] } : {}),
    source: lines.join('\n'),
  }
}

const parseList = (
  lines: readonly string[],
  startIndex: number,
  indent: number,
): { readonly block: MarkdownBlock; readonly next: number } => {
  const first = LIST_ITEM.exec(lines[startIndex]!)!
  const ordered = /\d/.test(first[2]![0]!)
  const start = ordered ? Number.parseInt(first[2]!, 10) : undefined
  const items: MarkdownListItem[] = []
  let index = startIndex
  while (index < lines.length) {
    const match = LIST_ITEM.exec(lines[index]!)
    if (match === null || match[1]!.length !== indent || /\d/.test(match[2]![0]!) !== ordered) break
    const children: MarkdownBlock[] = []
    if (match[3] !== '') children.push({ kind: 'paragraph', children: parseMarkdownInline(match[3]!) })
    index += 1
    while (index < lines.length) {
      const nested = LIST_ITEM.exec(lines[index]!)
      if (nested === null || nested[1]!.length <= indent) break
      const parsed = parseList(lines, index, nested[1]!.length)
      children.push(parsed.block)
      index = parsed.next
    }
    items.push({ children })
    if (lines[index]?.trim() === '') break
  }
  return {
    block: { kind: 'list', ordered, ...(start !== undefined && start !== 1 ? { start } : {}), items },
    next: index,
  }
}

export function parseMarkdown(markdown: string): readonly MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.trim() === '') {
      index += 1
      continue
    }
    const fence = /^\s*```([^\s`]*)\s*$/.exec(line)
    if (fence !== null) {
      const content: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) content.push(lines[index++]!)
      const closed = index < lines.length
      if (closed) index += 1
      const language = fence[1] || undefined
      const media = language === 'dinkster-media' && closed ? mediaBlock(content) : undefined
      const template = language === 'dinkster-example' && closed ? templateBlock(content) : undefined
      blocks.push(media ?? template ?? { kind: 'code', ...(language !== undefined ? { language } : {}), text: content.join('\n') })
      continue
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', depth: heading[1]!.length, children: parseMarkdownInline(heading[2]!) })
      index += 1
      continue
    }
    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1]!)) {
      const head = tableCells(line).map(parseMarkdownInline)
      const rows: (readonly (readonly MarkdownInline[])[])[] = []
      index += 2
      while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim() !== '') {
        rows.push(tableCells(lines[index]!).map(parseMarkdownInline))
        index += 1
      }
      blocks.push({ kind: 'table', head, rows })
      continue
    }
    const list = LIST_ITEM.exec(line)
    if (list !== null) {
      const parsed = parseList(lines, index, list[1]!.length)
      blocks.push(parsed.block)
      index = parsed.next
      continue
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^\s*>/.test(lines[index]!)) quote.push(lines[index++]!.replace(/^\s*> ?/, ''))
      blocks.push({ kind: 'quote', children: parseMarkdown(quote.join('\n')) })
      continue
    }
    const paragraph = [line.trim()]
    index += 1
    while (
      index < lines.length && lines[index]!.trim() !== '' &&
      !/^\s*```/.test(lines[index]!) && !/^(#{1,6})\s+/.test(lines[index]!) &&
      LIST_ITEM.exec(lines[index]!) === null && !/^\s*>/.test(lines[index]!) &&
      !(lines[index]!.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1]!))
    ) paragraph.push(lines[index++]!.trim())
    blocks.push({ kind: 'paragraph', children: parseMarkdownInline(paragraph.join(' ')) })
  }
  return blocks
}
