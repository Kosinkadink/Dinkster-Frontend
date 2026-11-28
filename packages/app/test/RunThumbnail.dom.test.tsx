import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { expect, it } from 'vitest'
import { RunThumbnail } from '../src/RunThumbnail.js'

it('keeps an unavailable picture accessible without tile text and loads a replacement source', async () => {
  const root = document.createElement('div')
  const [url, setUrl] = createSignal('/missing.png')
  const dispose = render(() => <RunThumbnail url={url()} mediaType="image/png" />, root)
  try {
    root.querySelector('img')!.dispatchEvent(new Event('error'))
    const unavailable = root.querySelector('[role="img"]')!
    expect(unavailable.getAttribute('aria-label')).toBe('Image unavailable')
    expect(unavailable.textContent).toBe('')
    setUrl('/present.png')
    await Promise.resolve()
    const image = root.querySelector('img')!
    expect(image.getAttribute('src')).toBe('/present.png')
    image.dispatchEvent(new Event('load'))
    expect(root.querySelector('[aria-label="Image unavailable"]')).toBeNull()
  } finally {
    dispose()
  }
})
