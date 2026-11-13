import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { expect, it, vi } from 'vitest'
import * as viewer from '../src/model3d-viewer.js'

it('does not start obsolete selection reads after the viewer loads', async () => {
  const { Model3dPosterImage } = await import('../src/Model3dPosterImage.js')
  const reads: string[] = []
  const renderer = vi.spyOn(viewer, 'renderModel3dPosterUrl').mockImplementation(async (src) => {
    reads.push(src)
    return `blob:poster-${src}`
  })
  const removed = document.createElement('div')
  const replaced = document.createElement('div')
  const live = document.createElement('div')
  document.body.append(removed, replaced, live)
  const [src, setSrc] = createSignal('old.glb')
  const disposeRemoved = render(() => <Model3dPosterImage src="removed.glb" name="Removed" />, removed)
  const disposeReplaced = render(() => <Model3dPosterImage src={src()} name="Selected" />, replaced)
  const disposeLive = render(() => <Model3dPosterImage src="live.glb" name="Live" />, live)
  try {
    disposeRemoved()
    setSrc('new.glb')
    expect(reads).toEqual([])
    await vi.waitFor(() => {
      expect(replaced.querySelector('img')?.getAttribute('src')).toBe('blob:poster-new.glb')
      expect(live.querySelector('img')?.getAttribute('src')).toBe('blob:poster-live.glb')
    })
    expect([...reads].sort()).toEqual(['live.glb', 'new.glb'])
    expect(removed.children).toHaveLength(0)
  } finally {
    disposeReplaced()
    disposeLive()
    renderer.mockRestore()
    document.body.replaceChildren()
  }
})
