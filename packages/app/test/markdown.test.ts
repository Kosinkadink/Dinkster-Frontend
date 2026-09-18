import { describe, expect, it } from 'vitest'
import { parseMarkdown, parseMarkdownInline } from '../src/help/markdownParser.js'

describe('constrained Markdown parser', () => {
  it('parses the supported block and inline structures', () => {
    const blocks = parseMarkdown(`# Heading

Use **strong**, *emphasis*, \`code\`, [site](https://example.com), and ![diagram](assets/diagram.webp).

> Quoted help

| Input | Meaning |
| --- | --- |
| value | A value |

3. First
4. Second`)
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'quote', 'table', 'list'])
    expect(blocks[1]).toMatchObject({ kind: 'paragraph' })
    const inline = blocks[1]?.kind === 'paragraph' ? blocks[1].children : []
    expect(inline.find((item) => item.kind === 'strong')).toEqual({ kind: 'strong', children: [{ kind: 'text', text: 'strong' }] })
    expect(inline.find((item) => item.kind === 'link')).toMatchObject({ kind: 'link', href: 'https://example.com' })
    expect(inline.find((item) => item.kind === 'image')).toEqual({ kind: 'image', asset: 'assets/diagram.webp', alt: 'diagram' })
    expect(blocks[4]).toMatchObject({ kind: 'list', ordered: true, start: 3, items: [{}, {}] })
  })

  it('strips raw HTML and refuses unsafe or relative links and images', () => {
    const inline = parseMarkdownInline('<img src=x onerror=alert(1)>before [bad](javascript:alert(1)) [relative](/admin) ![outside](../secret.png) [mail](mailto:a@example.com)')
    expect(JSON.stringify(inline)).not.toContain('javascript:')
    expect(JSON.stringify(inline)).not.toContain('onerror')
    expect(inline).toContainEqual({ kind: 'link', href: 'mailto:a@example.com', children: [{ kind: 'text', text: 'mail' }] })
    expect(inline).not.toContainEqual(expect.objectContaining({ kind: 'image' }))
  })

  it('retains nested list structure', () => {
    const blocks = parseMarkdown(`- Parent
  - Child
    1. Grandchild
- Sibling`)
    expect(blocks).toMatchObject([{ kind: 'list', ordered: false, items: [
      { children: [{ kind: 'paragraph' }, { kind: 'list', ordered: false, items: [
        { children: [{ kind: 'paragraph' }, { kind: 'list', ordered: true }] },
      ] }] },
      { children: [{ kind: 'paragraph' }] },
    ] }])
  })

  it('treats an unterminated fence as code through the end of the page', () => {
    expect(parseMarkdown('```ts\nconst unsafe = "<b>text</b>"')).toEqual([
      { kind: 'code', language: 'ts', text: 'const unsafe = "<b>text</b>"' },
    ])
    expect(parseMarkdown('```dinkster-media\nasset = "assets/demo.mp4"')).toEqual([
      { kind: 'code', language: 'dinkster-media', text: 'asset = "assets/demo.mp4"' },
    ])
  })

  it('renders escaped inline punctuation literally', () => {
    expect(parseMarkdownInline('Use \\*literal\\* and \\[brackets\\].')).toEqual([
      { kind: 'text', text: 'Use *literal* and [brackets].' },
    ])
  })

  it('decodes the frozen dinkster-media asset spelling without autoplay', () => {
    expect(parseMarkdown('```dinkster-media\nasset = "assets/loops/demo.mp4"\nposter = "assets/loops/poster.webp"\ncaption = "Map over a list"\n```')).toEqual([
      { kind: 'media', asset: 'assets/loops/demo.mp4', poster: 'assets/loops/poster.webp', caption: 'Map over a list' },
    ])
    expect(parseMarkdown('```dinkster-media\nsrc = "assets/demo.mp4"\n```')[0]?.kind).toBe('code')
    expect(parseMarkdown('```dinkster-media\nasset = "../demo.mp4"\n```')[0]?.kind).toBe('code')
  })

  it('decodes template examples and leaves unsupported examples as code', () => {
    expect(parseMarkdown('```dinkster-example\ntemplate = "map-and-gather"\ncaption = "Open the example"\n```')).toEqual([
      {
        kind: 'template',
        template: 'map-and-gather',
        caption: 'Open the example',
        source: 'template = "map-and-gather"\ncaption = "Open the example"',
      },
    ])
    expect(parseMarkdown('```dinkster-example\nblueprint = "starter"\n```')[0]).toMatchObject({ kind: 'code', language: 'dinkster-example' })
    expect(parseMarkdown('```dinkster-example\ntemplate = "bad/id"\n```')[0]).toMatchObject({ kind: 'code', language: 'dinkster-example' })
  })
})
