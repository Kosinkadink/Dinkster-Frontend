import { render } from 'solid-js/web'
import { createSignal } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenditionResult, ValuePeekResult } from '@dinkster/client'
import { VideoEditEditor } from '../src/VideoEditEditor.js'

let root: HTMLDivElement
let dispose: (() => void) | undefined
beforeEach(() => {
  root = document.createElement('div')
  document.body.append(root)
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  root.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const input = (root: HTMLElement, testId: string): HTMLInputElement =>
  root.querySelector(`[data-testid="${testId}"]`)!

const set = (element: HTMLInputElement, value: string): void => {
  element.value = value
  element.dispatchEvent(new InputEvent('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('VideoEditEditor', () => {
  it.each(['-2', '-0.5', '1.25'])('preserves unfinished numeric text before committing %s', (raw) => {
    const commit = vi.fn()
    dispose = render(() => <VideoEditEditor value={{ trim: { start_time: 1.25 } }}
      spec={{ widgetType: 'VIDEO_EDIT', options: { features: ['trim'] } }}
      onCommit={commit} onCancel={() => {}} />, root)
    const field = input(root, 'video-trim-start-seconds')
    for (let length = 1; length <= raw.length; length++) {
      field.value = raw.slice(0, length)
      field.dispatchEvent(new InputEvent('input', { bubbles: true }))
      expect(field.value).toBe(raw.slice(0, length))
    }
    field.dispatchEvent(new Event('change', { bubbles: true }))
    root.querySelector<HTMLButtonElement>('[data-testid="video-edit-apply"]')!.click()
    expect(commit).toHaveBeenCalledWith({ trim: { start_time: Number(raw) } }, false)
  })

  it.each([
    ['video-trim-duration-seconds', 'oops'], ['video-trim-duration-seconds', ''],
    ['video-trim-start-seconds', '-'], ['video-trim-start-seconds', 'Infinity'],
    ['video-crop-width', '1.5'], ['video-crop-x', 'oops'],
    ['video-trim-start-frame', 'NaN'], ['video-trim-end-frame', '1.5'],
  ])('refuses invalid text in %s without changing stored fields (%s)', (id, raw) => {
    const commit = vi.fn()
    const value = { trim: { start_time: 1.25, duration: 3.5 }, crop: { x: 100, width: 1280 } }
    dispose = render(() => <VideoEditEditor value={value} spec={{ widgetType: 'VIDEO_EDIT', options: {} }}
      facts={{ width: 1920, height: 1080, duration: 10, fps: 24 }} onCommit={commit} onCancel={() => {}} />, root)
    const field = input(root, id)
    const original = field.value
    set(field, raw)
    const apply = root.querySelector<HTMLButtonElement>('[data-testid="video-edit-apply"]')!
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(root.querySelector('[data-testid="video-edit-numeric-error"]')).not.toBeNull()
    expect(apply.disabled).toBe(true)
    apply.click()
    expect(commit).not.toHaveBeenCalled()
    set(field, original)
    expect(field.hasAttribute('aria-invalid')).toBe(false)
    expect(apply.disabled).toBe(false)
    set(field, raw)
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(field.value).toBe(original)
    expect(field.hasAttribute('aria-invalid')).toBe(false)
    expect(apply.disabled).toBe(false)
    apply.click()
    expect(commit).toHaveBeenCalledExactlyOnceWith(value, false)
  })

  it('round-trips imported fields, zero sentinels, and strict_duration separately', () => {
    const commit = vi.fn()
    const value = {
      imported: { untouched: ['a', 1] },
      trim: { start_time: 1.25, duration: 3.5, extension: true },
      crop: { x: 100, y: 40, width: 1280, height: 720, extension: 'keep' },
    }
    dispose = render(() => <VideoEditEditor
      value={value}
      spec={{ widgetType: 'VIDEO_EDIT', options: { features: ['trim', 'crop'] } }}
      strictDuration={false}
      facts={{ width: 1920, height: 1080, duration: 10, fps: 24 }}
      onCommit={commit}
      onCancel={() => {}}
    />, root)

    set(input(root, 'video-trim-duration-seconds'), '0')
    set(input(root, 'video-crop-x'), '101')
    expect(input(root, 'video-crop-x').value).toBe('101')
    expect(parseFloat(root.querySelector<HTMLElement>('.video-crop-selection')!.style.left)).toBeCloseTo(100 / 1920 * 100, 4)
    input(root, 'video-trim-strict').click()
    root.querySelector<HTMLButtonElement>('[data-testid="video-edit-apply"]')!.click()

    expect(commit).toHaveBeenCalledWith({
      imported: { untouched: ['a', 1] },
      trim: { start_time: 1.25, duration: 0, extension: true },
      crop: { x: 101, y: 40, width: 1280, height: 720, extension: 'keep' },
    }, true)
  })

  it('shows only requested features and reports unavailable host preview capability', () => {
    dispose = render(() => <VideoEditEditor
      value={{}}
      spec={{ widgetType: 'VIDEO_EDIT', options: { features: ['crop'] } }}
      strictDuration={false}
      onCommit={() => {}}
      onCancel={() => {}}
    />, root)
    expect(root.querySelector('[aria-label="Trim video"]')).toBeNull()
    expect(root.querySelector('[aria-label="Crop video"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="video-edit-preview-unavailable"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="video-edit-facts-unavailable"]')).not.toBeNull()
    expect(root.querySelector<HTMLButtonElement>('[aria-label="Crop nw handle"]')!.disabled).toBe(true)
  })

  it('constrains frame handles and applies ratio presets in even source pixels', () => {
    const commit = vi.fn()
    dispose = render(() => <VideoEditEditor
      value={{ trim: { start_time: 1, duration: 2 }, crop: {} }}
      spec={{ widgetType: 'VIDEO_EDIT', options: {} }}
      strictDuration={true}
      facts={{ width: 1920, height: 1080, duration: 10, fps: 30 }}
      previewUrl="/bounded-preview.webm"
      onCommit={commit}
      onCancel={() => {}}
    />, root)
    set(input(root, 'video-trim-start-frame'), '45')
    expect(input(root, 'video-trim-end-frame').value).toBe('90')
    root.querySelector<HTMLButtonElement>('[aria-label="Crop ratio presets"] button:nth-child(3)')!.click()
    root.querySelector<HTMLButtonElement>('[data-testid="video-edit-apply"]')!.click()
    const result = commit.mock.calls[0]![0]
    expect(result.trim).toEqual({ start_time: 1.5, duration: 1.5 })
    expect(result.crop).toEqual({ x: 420, y: 0, width: 1080, height: 1080 })
    expect(root.querySelector('[data-testid="video-edit-preview-unavailable"]')).toBeNull()
  })

  it('requests only advertised lazy selectors, labels color conversion, and discards stale frames', async () => {
    vi.useFakeTimers()
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:current-frame')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const requests: { kind: string; resolve: (result: RenditionResult) => void; signal: AbortSignal }[] = []
    const values = {
      peek: vi.fn(async (): Promise<ValuePeekResult> => ({
        available: true, descriptor: { typeId: 'comfy.VIDEO', fingerprint: 'source', meta: {
          effective: { width: 1920, height: 1080, duration: [10, 1], fps: [24, 1], frame_count: 17, frame_count_kind: 'estimated' },
        } },
        renditions: [
          { kind: 'frame', mime: 'image/png', version: 'frame-v1', parameters: ['frame'], defaults: { frame: '0' }, limits: { maxOutputFrames: 1 } },
          { kind: 'thumbs', mime: 'image/png', version: 'thumbs-v1', parameters: ['thumbs'], defaults: { thumbs: '4' }, limits: { maxCount: 4 } },
          { kind: 'preview', mime: 'video/mp4' }, { kind: 'original', mime: 'video/mp4' },
        ],
      })),
      rendition: vi.fn((_query, kind, options) => new Promise<RenditionResult>((resolve) => requests.push({ kind, resolve, signal: options!.signal! }))),
    } satisfies NonNullable<import('../src/video-edit-context.js').VideoEditSource>['values']
    dispose = render(() => <VideoEditEditor value={{ trim: { start_time: 1.25, duration: 0 } }} spec={{ widgetType: 'VIDEO_EDIT', options: {} }}
      source={{ values, query: { jobId: 'run', nodeId: 'source', outputId: 'video' } }} onCommit={() => {}} onCancel={() => {}} />, root)
    await vi.advanceTimersByTimeAsync(110)
    expect(values.rendition).toHaveBeenCalledWith({ jobId: 'run', nodeId: 'source', outputId: 'video' }, 'frame', expect.objectContaining({ frame: '1.25s' }))
    expect(values.rendition).toHaveBeenCalledWith(expect.anything(), 'thumbs', { signal: expect.any(AbortSignal) })
    expect(requests.map((request) => request.kind).sort()).toEqual(['frame', 'thumbs'])
    const stale = requests.find((request) => request.kind === 'frame')!
    const playhead = root.querySelector<HTMLInputElement>('[aria-label="Playhead frame"]')!
    set(playhead, '60')
    await vi.advanceTimersByTimeAsync(110)
    expect(values.rendition).toHaveBeenLastCalledWith(expect.anything(), 'frame', expect.objectContaining({ frame: '2.5s' }))
    expect(stale.signal.aborted).toBe(true)
    const media: RenditionResult = { available: true, bytes: new ArrayBuffer(8), mime: 'image/png', kind: 'frame', fingerprint: 'source', colorTransform: 'PQ to sRGB' }
    stale.resolve(media)
    await Promise.resolve()
    expect(createUrl).not.toHaveBeenCalled()
    requests.at(-1)!.resolve(media)
    await Promise.resolve()
    expect(root.querySelector('img[alt="Crop source frame"]')?.getAttribute('src')).toBe('blob:current-frame')
    expect(root.textContent).toContain('PQ to sRGB')
    expect(playhead.max).toBe('239')
    dispose!()
    dispose = undefined
    expect(revoke).toHaveBeenCalledWith('blob:current-frame')
  })

  it.each([{ parameters: undefined }, { parameters: [] as string[] }])('uses provider defaults without unadvertised selectors (%j)', async ({ parameters }) => {
    vi.useFakeTimers()
    const values = {
      peek: vi.fn(async (): Promise<ValuePeekResult> => ({
        available: true, descriptor: { typeId: 'comfy.VIDEO', fingerprint: 'legacy' },
        renditions: ['frame', 'thumbs'].map((kind) => ({ kind, mime: 'image/png', ...(parameters === undefined ? {} : { parameters }) })),
      })),
      rendition: vi.fn(async (): Promise<RenditionResult> => ({ available: false, status: 406, reason: 'unavailable-rendition', error: 'No bounded decoder' })),
    }
    dispose = render(() => <VideoEditEditor value={{ trim: { start_time: 1.25 } }} spec={{ widgetType: 'VIDEO_EDIT', options: { features: ['trim'] } }}
      facts={{ width: 1920, height: 1080, duration: 10, fps: 24 }}
      source={{ values, query: { jobId: 'run', nodeId: 'source', outputId: 'video' } }} onCommit={() => {}} onCancel={() => {}} />, root)
    await vi.advanceTimersByTimeAsync(110)
    expect(values.rendition).toHaveBeenCalledTimes(2)
    for (const kind of ['frame', 'thumbs']) expect(values.rendition).toHaveBeenCalledWith(expect.anything(), kind, { signal: expect.any(AbortSignal) })
    expect(root.querySelector<HTMLInputElement>('[aria-label="Playhead frame"]')!.disabled).toBe(true)
    expect(root.querySelector('[data-testid="video-edit-frame-selection-unavailable"]')!.textContent).toContain('Frame selection is not advertised')
    set(input(root, 'video-trim-start-seconds'), '3')
    await vi.advanceTimersByTimeAsync(110)
    expect(values.rendition).toHaveBeenCalledTimes(2)
  })

  it('ignores stale metadata on source replacement and shows structured preview refusals', async () => {
    vi.useFakeTimers()
    let resolveOld!: (result: ValuePeekResult) => void
    const values = {
      peek: vi.fn(() => new Promise<ValuePeekResult>((resolve) => { resolveOld = resolve })),
      rendition: vi.fn(async (): Promise<RenditionResult> => ({ available: false, status: 406, reason: 'unavailable-rendition', error: 'No bounded decoder' })),
    }
    const [source, setSource] = createSignal({ values, query: { jobId: 'old', nodeId: 'source', outputId: 'video' } })
    dispose = render(() => <VideoEditEditor value={{}} spec={{ widgetType: 'VIDEO_EDIT', options: { features: ['crop'] } }} source={source()} onCommit={() => {}} onCancel={() => {}} />, root)
    const old = resolveOld
    setSource({ values, query: { jobId: 'new', nodeId: 'source', outputId: 'video' } })
    old({ available: false, status: 404, reason: 'bad-element', error: 'Stale error' })
    await Promise.resolve()
    expect(root.textContent).not.toContain('Stale error')
    resolveOld({ available: true, descriptor: { typeId: 'comfy.VIDEO', fingerprint: 'new' }, renditions: [{ kind: 'poster', mime: 'image/png' }] })
    await vi.advanceTimersByTimeAsync(1)
    expect(root.textContent).toContain('406 unavailable-rendition: No bounded decoder')
    expect(values.rendition).toHaveBeenCalledTimes(1)
    expect(values.rendition).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'new' }), 'poster', expect.anything())
  })

  it('keeps unknown fields and untouched crop coordinates when editing one partial field', () => {
    const commit = vi.fn()
    dispose = render(() => <VideoEditEditor value={{ vendor: [1], trim: {}, crop: { x: 13, future: 'keep' } }}
      spec={{ widgetType: 'VIDEO_EDIT', options: { features: ['crop'] } }} facts={{ width: 1920, height: 1080, fps: 24, duration: 10 }}
      onCommit={commit} onCancel={() => {}} />, root)
    set(input(root, 'video-crop-width'), '200')
    root.querySelector<HTMLButtonElement>('[data-testid="video-edit-apply"]')!.click()
    expect(commit).toHaveBeenCalledWith({ vendor: [1], trim: {}, crop: { x: 13, future: 'keep', width: 200 } }, false)
    expect(root.querySelector('[data-testid="video-trim-strict"]')).toBeNull()
  })
})
