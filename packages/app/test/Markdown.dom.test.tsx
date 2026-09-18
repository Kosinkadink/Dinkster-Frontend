// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '../src/help/Markdown.js'
import { parseMarkdown } from '../src/help/markdownParser.js'

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

describe('Markdown Solid renderer', () => {
  it('renders safe links and descriptor-resolved image and video assets', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const blocks = parseMarkdown(`[Safe](https://example.com) [Unsafe](javascript:alert(1))

![Diagram](assets/diagram.webp)

\`\`\`dinkster-media
asset = "assets/demo.mp4"
poster = "assets/poster.webp"
caption = "A demo"
\`\`\``)
    dispose = render(() => <Markdown blocks={blocks} assets={{
      'assets/diagram.webp': { url: '/asset/image', mediaType: 'image/webp' },
      'assets/demo.mp4': { url: '/asset/video', mediaType: 'video/mp4' },
      'assets/poster.webp': { url: '/asset/poster', mediaType: 'image/webp' },
    }} />, host)

    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
    expect(host.querySelectorAll('a')).toHaveLength(1)
    expect(host.querySelector('img')).toMatchObject({ alt: 'Diagram' })
    expect(host.querySelector('video')?.controls).toBe(true)
    expect(host.querySelector('video')?.autoplay).toBe(false)
    expect(host.querySelector('video')?.getAttribute('src')).toBe('/asset/video')
    expect(host.querySelector('figcaption')?.textContent).toBe('A demo')
  })

  it('never emits raw HTML or unresolved asset elements', () => {
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <Markdown blocks={parseMarkdown('<script>alert(1)</script> ![Missing](assets/missing.png)')} />, host)
    expect(host.querySelector('script')).toBeNull()
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain('Missing')
  })

  it('requires descriptor media types to match image and video uses', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const blocks = parseMarkdown(`![Wrong image](assets/video.mp4)

\`\`\`dinkster-media
asset = "assets/image.webp"
poster = "assets/video.mp4"
caption = "Wrong video"
\`\`\`

\`\`\`dinkster-media
asset = "assets/video.mp4"
poster = "assets/video.mp4"
caption = "Valid video"
\`\`\``)
    dispose = render(() => <Markdown blocks={blocks} assets={{
      'assets/video.mp4': { url: '/asset/video', mediaType: 'video/mp4' },
      'assets/image.webp': { url: '/asset/image', mediaType: 'image/webp' },
    }} />, host)

    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelectorAll('video')).toHaveLength(1)
    expect(host.querySelector('video')?.getAttribute('poster')).toBeNull()
    expect(host.textContent).toContain('Wrong image')
    expect(host.textContent).toContain('Wrong video')
    expect(host.textContent).toContain('Valid video')
  })

  it('renders a template action only when the host supplies one', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const blocks = parseMarkdown('```dinkster-example\ntemplate = "map-and-gather"\ncaption = "Try the workflow"\n```')
    dispose = render(() => <Markdown blocks={blocks} />, host)
    expect(host.querySelector('button')).toBeNull()
    expect(host.textContent).toContain('template = "map-and-gather"')

    dispose()
    const open = vi.fn()
    dispose = render(() => <Markdown blocks={blocks} templateAction={{ label: 'Open template', open }} />, host)
    const button = host.querySelector('button')!
    expect(host.textContent).toContain('Try the workflow')
    button.click()
    expect(open).toHaveBeenCalledWith('map-and-gather')
  })
})
