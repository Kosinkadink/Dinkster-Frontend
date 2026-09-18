import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import { DinksterValuesClient, type RenditionResult } from '@dinkster/client'
import { VideoPreview } from '../src/VideoPreview.js'
import { videoInspectionFor, type VideoInspection, type VideoNodePreview } from '../src/video-preview.js'
import { fetchPeekRendition } from '../src/peek-preview.js'

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function mount(inspection: VideoInspection) {
  const root = document.createElement('div')
  document.body.append(root)
  const [media, setMedia] = createSignal<VideoNodePreview>({ kind: 'video', src: 'blob:initial', mime: 'image/png', videoInspection: inspection })
  const dispose = render(() => <VideoPreview media={media()} preferences={{ autoplay: false, muted: true, loop: true }} />, root)
  disposers.push(dispose)
  return { root, dispose, setMedia }
}

it.each(['success', 'refusal'] as const)('keeps old thumbnail %s bound to the previous selection', async (outcome) => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:new-video').mockReturnValue('blob:new-thumbs')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const selected = deferred<Awaited<ReturnType<VideoInspection['select']>>>()
  const oldThumbs = deferred<RenditionResult>()
  const request = vi.fn<VideoInspection['request']>(() => oldThumbs.promise)
  const initial: VideoInspection = { index: 0, count: 2, canSelectFrame: false, thumbnailCount: 2, request, select: () => selected.promise }
  const nextRequest = vi.fn<VideoInspection['request']>(async () => ({ available: true, bytes: new ArrayBuffer(1), mime: 'image/png', fingerprint: 'new', kind: 'thumbs' }))
  const next: VideoInspection = { ...initial, index: 1, thumbnailCount: 5, request: nextRequest }
  const { root } = mount(initial)
  const controls = root.querySelector('[role="group"]')!
  controls.dispatchEvent(new Event('pointerenter'))
  expect(request).toHaveBeenCalledOnce()
  root.querySelector<HTMLButtonElement>('[aria-label="Next video"]')!.click()
  controls.dispatchEvent(new Event('pointerenter'))
  expect(request).toHaveBeenCalledOnce()
  expect(request.mock.calls[0]![1].signal?.aborted).toBe(true)
  selected.resolve({ bytes: new ArrayBuffer(1), mime: 'image/png', node: 'n', output: 'second', inspection: next })
  await vi.waitFor(() => expect(root.querySelector('.video-preview-navigation')?.textContent).toContain('2 / 2'))
  oldThumbs.resolve(outcome === 'success'
    ? { available: true, bytes: new ArrayBuffer(1), mime: 'image/png', fingerprint: 'old', kind: 'thumbs', colorTransform: 'old color' }
    : { available: false, status: 406, reason: 'unavailable-rendition', error: 'old refusal' })
  await oldThumbs.promise
  expect(root.querySelector('.video-preview-thumbs img')).toBeNull()
  expect(root.textContent).not.toContain('old color')
  expect(root.textContent).not.toContain('old refusal')
  controls.dispatchEvent(new Event('pointerenter'))
  await vi.waitFor(() => expect(root.querySelector('.video-preview-thumbs img')?.getAttribute('src')).toBe('blob:new-thumbs'))
  expect(root.querySelector('.video-preview-thumbs img')?.getAttribute('alt')).toBe('5 video timeline thumbnails')
})

it.each(['disposal', 'replacement'] as const)('cancels output selection on %s before another rendition starts', async (action) => {
  const peekGate = deferred<void>()
  const peekReleased = deferred<void>()
  let hold = false
  let selectionSignal: AbortSignal | null | undefined
  const requests: URL[] = []
  const values = new DinksterValuesClient({ baseUrl: 'http://owner', clientId: 'client', fetchFn: async (input, options) => {
    const url = new URL(String(input))
    requests.push(url)
    if (hold && url.searchParams.get('outputId') === 'second' && !url.searchParams.has('rendition')) {
      selectionSignal = options?.signal
      await peekGate.promise
      peekReleased.resolve()
    }
    if (url.searchParams.has('rendition')) return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } })
    return new Response(JSON.stringify({ available: true, descriptor: { typeId: 'comfy.VIDEO', fingerprint: 'video' }, renditions: [{ kind: 'poster', mime: 'image/png' }] }))
  } })
  const candidates = [{ node: 'n', output: 'first', mediaKind: 'video' }, { node: 'n', output: 'second', mediaKind: 'video' }] as const
  const initial = await fetchPeekRendition(values, 'job', candidates)
  const inspection = (await videoInspectionFor(initial, values, candidates))!
  const selected = vi.spyOn(inspection, 'select')
  const { root, dispose, setMedia } = mount(inspection)
  hold = true
  root.querySelector<HTMLButtonElement>('[aria-label="Next video"]')!.click()
  if (action === 'disposal') dispose()
  else setMedia({ kind: 'video', src: 'blob:replacement', mime: 'image/png' })
  expect(selectionSignal?.aborted).toBe(true)
  const requestCount = requests.length
  peekGate.resolve()
  await peekReleased.promise
  await expect(selected.mock.results[0]!.value).rejects.toThrow()
  expect(requests.slice(requestCount)).toEqual([])
  expect(root.textContent).not.toContain('Video 2 unavailable')
})
