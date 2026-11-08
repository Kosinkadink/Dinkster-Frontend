import { createMemo, createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeMediaOverlay, NodeModel3dOverlay, NodeOutputPager, visibleOutputPagerRect } from '../src/CanvasHost.js'

afterEach(() => document.body.replaceChildren())

describe('NodeOutputPager', () => {
  it('requires enough visible intersection to keep projected controls focusable', () => {
    const canvas = { left: 10, top: 20, width: 800, height: 600 }
    expect(visibleOutputPagerRect({ x: -300, y: 100, width: 500, height: 200 }, canvas)).toEqual({ x: 10, y: 100, width: 190, height: 200 })
    expect(visibleOutputPagerRect({ x: -300, y: 100, width: 400, height: 200 }, canvas)).toBeUndefined()
    expect(visibleOutputPagerRect({ x: 100, y: 590, width: 300, height: 100 }, canvas)).toBeUndefined()
    expect(visibleOutputPagerRect({ x: 900, y: 100, width: 300, height: 200 }, canvas)).toBeUndefined()
  })

  it('exposes pointer and keyboard-operable paging/open controls and forwards wheel input', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      x: 10, y: 20, left: 10, top: 20, right: 810, bottom: 620,
      width: 800, height: 600, toJSON: () => ({}),
    })
    const previous = vi.fn()
    const next = vi.fn()
    const open = vi.fn()
    const wheel = vi.fn()
    const active = vi.fn()
    canvas.addEventListener('wheel', wheel)
    const dispose = render(() => (
      <NodeOutputPager
        title="Save Image"
        index={1}
        count={3}
        rect={{ x: 100, y: 120, width: 300, height: 220 }}
        canvas={canvas}
        onPrevious={previous}
        onNext={next}
        onOpen={open}
        onActiveChange={active}
      />
    ), root)

    const previousButton = root.querySelector<HTMLButtonElement>('[aria-label="Previous image for Save Image"]')!
    previousButton.focus()
    expect(active).toHaveBeenLastCalledWith(true)
    previousButton.click()
    root.querySelector<HTMLButtonElement>('[aria-label="Next image for Save Image"]')!.click()
    root.querySelector<HTMLButtonElement>('[aria-label="Open image 2 of 3 for Save Image"]')!.click()
    expect(previous).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledOnce()
    expect(root.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Save Image execution images')
    root.querySelector('[data-testid="node-output-pager"]')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 80 }))
    expect(wheel).toHaveBeenCalledOnce()
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    expect(active).toHaveBeenLastCalledWith(false)
    previousButton.focus()
    active.mockClear()
    dispose()
    expect(active).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(active).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('retains focused controls when the owner replaces paging callbacks', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const [index, setIndex] = createSignal(0)
    const dispose = render(() => {
      const callbacks = createMemo(() => {
        const page = index()
        return { next: () => setIndex(page + 1), previous: () => setIndex(page - 1) }
      })
      return <NodeOutputPager title="Batch" index={index()} count={9}
        rect={{ x: 0, y: 0, width: 300, height: 200 }} canvas={document.createElement('canvas')}
        onPrevious={callbacks().previous} onNext={callbacks().next} />
    }, root)
    const next = root.querySelector<HTMLButtonElement>('[aria-label="Next image for Batch"]')!
    next.focus()
    next.click()
    expect(index()).toBe(1)
    expect(root.querySelector('[aria-label="Next image for Batch"]')).toBe(next)
    expect(document.activeElement).toBe(next)
    next.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(index()).toBe(2)
    expect(document.activeElement).toBe(next)
    dispose()
  })

  it('pages video artifacts without exposing the image viewer action', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const canvas = document.createElement('canvas')
    const previous = vi.fn()
    const next = vi.fn()
    const dispose = render(() => (
      <NodeOutputPager
        title="Save Video"
        index={1}
        count={3}
        mediaKind="video"
        rect={{ x: 100, y: 120, width: 300, height: 220 }}
        canvas={canvas}
        onPrevious={previous}
        onNext={next}
      />
    ), root)

    root.querySelector<HTMLButtonElement>('[aria-label="Previous video for Save Video"]')!.click()
    root.querySelector<HTMLButtonElement>('[aria-label="Next video for Save Video"]')!.click()
    expect(previous).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledOnce()
    expect(root.querySelector('[aria-label="video 2 of 3 for Save Video"]')).not.toBeNull()
    expect(root.querySelector('[aria-label^="Open video"]')).toBeNull()
    expect(root.querySelector('[data-media-kind="video"]')).not.toBeNull()
    dispose()
  })

  it('retains focus and active state when paging replaces the projected controls', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const canvas = document.createElement('canvas')
    const active = vi.fn()
    const [state, setState] = createSignal({ index: 0 })
    const dispose = render(() => (
      <Show when={state()} keyed>{(current) => (
        <NodeOutputPager
          title="Save Image"
          index={current.index}
          count={3}
          outputKey="save:images"
          rect={{ x: 100, y: 120, width: 300, height: 220 }}
          canvas={canvas}
          onPrevious={() => setState(({ index }) => ({ index: index - 1 }))}
          onNext={() => setState(({ index }) => ({ index: index + 1 }))}
          onActiveChange={active}
        />
      )}</Show>
    ), root)

    const next = root.querySelector<HTMLButtonElement>('[aria-label="Next image for Save Image"]')!
    next.focus()
    next.click()
    await Promise.resolve()
    expect(root.querySelector('[aria-label="image 2 of 3 for Save Image"]')).not.toBeNull()
    expect(document.activeElement).toBe(root.querySelector('[aria-label="Next image for Save Image"]'))
    expect(active).not.toHaveBeenLastCalledWith(false)

    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await Promise.resolve()
    expect(root.querySelector('[aria-label="image 1 of 3 for Save Image"]')).not.toBeNull()
    expect(document.activeElement).toBe(root.querySelector('[aria-label="Next image for Save Image"]'))
    expect(active).not.toHaveBeenLastCalledWith(false)
    dispose()
  })

  it('downloads a single recorded image without showing paging controls', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const canvas = document.createElement('canvas')
    const dispose = render(() => (
      <NodeOutputPager
        title="Save Image"
        index={0}
        count={1}
        download={{ src: 'blob:recorded-image', name: 'result.png' }}
        rect={{ x: 100, y: 120, width: 300, height: 220 }}
        canvas={canvas}
        onPrevious={() => {}}
        onNext={() => {}}
      />
    ), root)

    const download = root.querySelector<HTMLAnchorElement>('a[download="result.png"]')
    expect(download?.href).toBe('blob:recorded-image')
    expect(root.querySelector('button')).toBeNull()
    dispose()
  })
})

describe('NodeMediaOverlay', () => {
  it('reports a production video element error to the source failure authority', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const canvas = document.createElement('canvas')
    const onMediaError = vi.fn()
    const active = vi.fn()
    const dispose = render(() => (
      <NodeMediaOverlay
        media={{
          kind: 'video',
          mime: 'video/webm',
          src: 'blob:bounded-preview',
          download: { src: 'blob:bounded-preview', name: 'preview.webm', previewOnly: true },
          count: 3,
        }}
        rect={{ x: 10, y: 20, width: 300, height: 180 }}
        scale={1}
        canvas={canvas}
        onMediaError={onMediaError}
        onActiveChange={active}
      />
    ), root)

    const video = root.querySelector('video')!
    const download = root.querySelector<HTMLAnchorElement>('.app-preview-download')!
    expect(download.getAttribute('href')).toBe('blob:bounded-preview')
    expect(download.download).toBe('preview.webm')
    expect(root.querySelector('.node-media-count')).toBeNull()
    video.focus()
    expect(active).toHaveBeenLastCalledWith(true)
    video.dispatchEvent(new Event('error'))
    expect(root.textContent).toContain('Video preview unavailable')
    expect(onMediaError).toHaveBeenCalledOnce()
    active.mockClear()
    dispose()
    expect(active).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(active).toHaveBeenCalledExactlyOnceWith(false)
  })
})

describe('NodeModel3dOverlay', () => {
  it('keeps a failed poster output downloadable', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const canvas = document.createElement('canvas')
    const dispose = render(() => (
      <NodeModel3dOverlay
        media={{
          kind: 'model3d',
          mime: 'model/gltf-binary',
          src: 'blob:mesh',
          status: 'failed',
          download: { src: 'blob:mesh', name: 'mesh.glb' },
        }}
        rect={{ x: 10, y: 20, width: 300, height: 180 }}
        scale={1}
        canvas={canvas}
      />
    ), root)

    expect(root.querySelector<HTMLAnchorElement>('a[download="mesh.glb"]')?.href).toBe('blob:mesh')
    dispose()
  })
})
