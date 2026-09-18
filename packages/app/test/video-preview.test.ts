import { describe, expect, it, vi } from 'vitest'
import { DinksterValuesClient, type RenditionInfo } from '@dinkster/client'
import { fetchPeekRendition } from '../src/peek-preview.js'
import { videoInspectionFor, videoTiming } from '../src/video-preview.js'

describe('video inspection contract', () => {
  it('reads rational effective timing without inventing unknown frame rates', () => {
    expect(videoTiming({ effective: { duration: [7, 2], fps: [30000, 1001], frame_count: 105 } }))
      .toEqual({ duration: 3.5, fps: 30000 / 1001, frameCount: 105 })
    expect(videoTiming({ effective: { duration: [1, 0], fps: [-1, 2], frame_count: 1.5 } })).toEqual({})
    expect(videoTiming(undefined)).toEqual({})
    expect(videoTiming({ effective: { duration: null, fps: null, frame_count: null, frame_count_kind: null } })).toEqual({})
    expect(videoTiming({ effective: { duration: [1, 1], fps: [24, 1], frame_count: 24, frame_count_kind: 'estimated' } }))
      .toEqual({ duration: 1, fps: 24, frameCount: 24, frameCountKind: 'estimated' })
  })

  it('pages VIDEO outputs and honors selector capabilities, defaults, limits and versions', async () => {
    const calls: URL[] = []
    let frameInfo: RenditionInfo = { kind: 'frame', mime: 'image/png', version: 'frame-v2', parameters: ['frame'], defaults: { frame: '0' }, limits: { maxOutputFrames: 1 } }
    let thumbsInfo: RenditionInfo | undefined
    const values = new DinksterValuesClient({ baseUrl: 'http://owner', clientId: 'client', fetchFn: async (input) => {
      const url = new URL(String(input))
      calls.push(url)
      const kind = url.searchParams.get('rendition')
      if (kind !== null) return new Response(new TextEncoder().encode('0000ftyp'), {
        headers: { 'Content-Type': 'video/mp4', 'X-Dinkster-Rendition': kind, 'X-Dinkster-Fingerprint': 'video' },
      })
      const list = url.searchParams.get('outputId') === 'clips' && !url.searchParams.has('element')
      return new Response(JSON.stringify({ available: true,
        descriptor: list ? { typeId: 'list<comfy.VIDEO>', fingerprint: 'list', length: 2 }
          : { typeId: 'comfy.VIDEO', fingerprint: 'video', meta: { effective: { fps: [24, 1], frame_count: 24 } } },
        renditions: list ? [] : [{ kind: 'original', mime: 'video/mp4', default: true }, { kind: 'preview', mime: 'video/mp4' }, frameInfo, ...(thumbsInfo === undefined ? [] : [thumbsInfo])],
      }), { headers: { 'Content-Type': 'application/json' } })
    } })
    const rendition = vi.spyOn(values, 'rendition')
    const candidates = [{ node: 'r[2]/n', output: 'clips', mediaKind: 'video' }, { node: 'r[2]/n', output: 'other', mediaKind: 'video' }] as const
    const refresh = async () => (await videoInspectionFor(await fetchPeekRendition(values, 'job', candidates), values, candidates))!
    const inspection = await refresh()
    expect(inspection).toMatchObject({ count: 3, index: 0, fps: 24, frameCount: 24, canSelectFrame: true })
    const second = await inspection.select(1)
    expect(second.video?.query).toEqual({ jobId: 'job', nodeId: 'r[2]/n', outputId: 'clips', element: [1] })
    expect(second.inspection.index).toBe(1)
    await second.inspection.request('frame', { frame: 12 })
    expect(rendition).toHaveBeenLastCalledWith(second.video!.query, 'frame', { frame: 12, rendererVersion: 'frame-v2' })
    expect(calls.at(-1)?.searchParams.get('frame')).toBe('12')
    expect(calls.at(-1)?.searchParams.get('element')).toBe('1')
    const third = await inspection.select(2)
    expect(third.video?.query.outputId).toBe('other')
    const count = calls.length
    expect(await third.inspection.request('thumbs', { thumbs: 8 })).toMatchObject({ available: false, reason: 'unadvertised-rendition' })
    expect(calls).toHaveLength(count)
    await expect(inspection.select(3)).rejects.toThrow('out of range')
    frameInfo = { kind: 'frame', mime: 'image/png' }
    thumbsInfo = { kind: 'thumbs', mime: 'image/png' }
    const legacy = await refresh()
    expect(legacy.canSelectFrame).toBe(false)
    expect(legacy.thumbnailCount).toBeUndefined()
    rendition.mockClear()
    expect(await legacy.request('frame', { frame: 0 })).toMatchObject({ available: false, reason: 'unadvertised-rendition' })
    expect(await legacy.request('thumbs', { thumbs: 8 })).toMatchObject({ available: false, reason: 'unadvertised-rendition' })
    expect(rendition).not.toHaveBeenCalled()
    thumbsInfo = { ...thumbsInfo, version: 'thumbs-v3', parameters: ['thumbs'], defaults: { thumbs: '9' }, limits: { maxCount: 3 } }
    const bounded = await refresh()
    expect(bounded.thumbnailCount).toBe(3)
    await bounded.request('thumbs', { thumbs: bounded.thumbnailCount! })
    expect(rendition).toHaveBeenLastCalledWith(expect.objectContaining({ element: [0] }), 'thumbs', { thumbs: 3, rendererVersion: 'thumbs-v3' })
    thumbsInfo = { ...thumbsInfo, defaults: { thumbs: 'not-a-count' } }
    expect((await refresh()).thumbnailCount).toBeUndefined()
    expect(calls.every((url) => url.hostname === 'owner' && url.searchParams.get('clientId') === 'client' &&
      url.searchParams.get('rendition') !== 'original' && !url.searchParams.has('rendererVersion') && !url.searchParams.has('batch'))).toBe(true)
  })

  it('keeps initial output enumeration within the loader cancellation lifetime', async () => {
    const values = new DinksterValuesClient({ baseUrl: 'http://owner', clientId: 'client' })
    const controller = new AbortController()
    const peek = vi.spyOn(values, 'peek').mockImplementation(async () => {
      controller.abort()
      return { available: false, status: 0, reason: 'aborted', error: 'Aborted' }
    })
    const initial = {
      bytes: new ArrayBuffer(1), mime: 'image/png', node: 'n', output: 'video',
      video: { query: { jobId: 'job', nodeId: 'n', outputId: 'video' }, descriptor: { typeId: 'comfy.VIDEO', fingerprint: 'video' }, renditions: [] },
    }
    await expect(videoInspectionFor(initial, values, [{ node: 'n', output: 'video' }], undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(peek).toHaveBeenCalledOnce()
    expect(peek.mock.calls[0]![1]?.signal).toBe(controller.signal)
  })
})
