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

it.each([false, true])('replaces same-URL ownership without publishing the old poster, render started=%s', async (started) => {
  const { Model3dPosterImage } = await import('../src/Model3dPosterImage.js')
  let admit!: () => void
  let finish!: () => void
  let active = false
  let renders = 0
  const old = { key: 'old', current: () => true, read: async <T,>(consume: () => Promise<T>) => {
    active = true
    try {
      await new Promise<void>((resolve) => { admit = resolve })
      return await consume()
    } finally { active = false }
  } }
  const next = { key: 'next', current: () => true, read: async <T,>(consume: () => Promise<T>) => consume() }
  const renderer = vi.spyOn(viewer, 'renderModel3dPosterUrl').mockImplementation(async () => {
    if (++renders === 1 && started) {
      await new Promise<void>((resolve) => { finish = resolve })
      return 'blob:obsolete-poster'
    }
    return 'blob:current-poster'
  })
  const [reader, setReader] = createSignal(old)
  const root = document.createElement('div'); document.body.append(root)
  const dispose = render(() => <Model3dPosterImage src="same.glb" name="Model" assetReader={reader()} />, root)
  try {
    await vi.waitFor(() => expect(admit).toBeTypeOf('function'))
    if (started) {
      admit()
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    }
    setReader(next)
    await vi.waitFor(() => expect(root.querySelector('img')?.getAttribute('src')).toBe('blob:current-poster'))
    expect(active).toBe(true)
    if (started) finish()
    else admit()
    await vi.waitFor(() => expect(active).toBe(false))
    expect(root.querySelector('img')?.getAttribute('src')).toBe('blob:current-poster')
    expect(renders).toBe(started ? 2 : 1)
  } finally { admit?.(); finish?.(); dispose(); renderer.mockRestore(); root.remove() }
})
