import { describe, expect, it, vi } from 'vitest'
import { DinksterValuesClient, type RenditionInfo } from '@dinkster/client'
import { audioPreview, AUDIO_WINDOW_BYTES } from '../src/audio-preview.js'
import { fetchPeekRendition, type PeekValues } from '../src/peek-preview.js'

const query = { jobId: 'job', nodeId: 'audio', outputId: 'out' }
const meta = Object.freeze({ sample_rate: 48000, channels: 17, layout: '17c', duration: 7200, batch: 3 })
const descriptor = Object.freeze({ typeId: 'core.audio', fingerprint: 'source', meta })
const renditions: readonly RenditionInfo[] = [
  { kind: 'waveform', mime: 'image/png', version: 'wave-v1', parameters: ['batch', 'waveform'], defaults: { batch: '0' }, limits: { width: 2048, height: 512, pixels: 262144 } },
  { kind: 'window', mime: 'audio/wav', version: 'window-v1', parameters: ['batch', 'window'], defaults: { batch: '0' }, limits: { durationSeconds: 30, sampleValues: 8388608 } },
]
const values = (): PeekValues => ({
  peek: vi.fn(async () => ({ available: true as const, descriptor, renditions })),
  rendition: vi.fn(async (_query, kind) => ({ available: true as const, fingerprint: 'source', kind, mime: kind === 'waveform' ? 'image/png' : 'audio/wav', bytes: new ArrayBuffer(32), ...(kind === 'waveform' ? { waveform: 'sampled-peak' } : {}) })),
})

describe('bounded audio previews', () => {
  it('peeks metadata without fetching the default full audio or changing source facts', async () => {
    const client = values()
    const result = await fetchPeekRendition(client, 'job', [{ node: 'audio', output: 'out' }])
    expect(result.audio?.descriptor).toBe(descriptor)
    expect(client.rendition).not.toHaveBeenCalled()
  })
  it('requests fixed waveform pixels and a bounded effective window for any channel layout', async () => {
    const client = values()
    const signal = new AbortController().signal
    const result = await audioPreview(client, query, descriptor, renditions).load(5000, 2, signal)
    expect(client.rendition).toHaveBeenCalledWith(query, 'waveform', { batch: 2, rendererVersion: 'wave-v1', waveform: { width: 512, height: 128 }, signal })
    expect(client.rendition).toHaveBeenCalledWith(query, 'window', { batch: 2, rendererVersion: 'window-v1', window: { start: 5000, duration: 3 }, signal })
    expect(result.diagnostics).toEqual(['Waveform: sampled peaks (not exhaustive)'])
    expect(descriptor.meta).toEqual(meta)
  })
  it('uses effective facts without replacing or rewriting source probe metadata', async () => {
    const effective = Object.freeze({
      sample_rate: 24000, channels: 3, layout: '2.1', duration: 1, frames: 24000, batch: 1, stream_index: 0,
      shape: Object.freeze([1, 3, 24000]), codec_version: 2,
      probe: Object.freeze({ sample_rate: 96000, channels: 2, layout: 'stereo', duration: 120 }),
    })
    const audio = audioPreview(values(), query, { ...descriptor, meta: effective }, renditions)
    expect((await audio.load(0, 0, new AbortController().signal)).duration).toBe(1)
    await expect(audio.load(2, 0, new AbortController().signal)).rejects.toThrow('outside the effective timeline')
    expect(audio.meta).toBe(effective)
    expect(audio.meta['probe']).toEqual({ sample_rate: 96000, channels: 2, layout: 'stereo', duration: 120 })
  })
  it('keeps unknown duration defined while requesting one bounded window', async () => {
    const client = values()
    const audio = audioPreview(client, query, { ...descriptor, meta: { ...meta, duration: null, frames: null, shape: [1, 17, null] } }, renditions)
    const result = await audio.load(0, 0, new AbortController().signal)
    expect(result.duration).toBe(3)
    expect(result.diagnostics).toContain('Audio duration not reported: seeking and continuous playback are unavailable')
    expect(client.rendition).toHaveBeenCalledWith(query, 'window', expect.objectContaining({ window: { start: 0, duration: 3 } }))
  })
  it('shrinks high-channel windows to the sample budget and clips the final window', async () => {
    const client = values()
    const audio = audioPreview(client, { ...query, element: [4] }, { ...descriptor, meta: { ...meta, channels: 512 } }, renditions)
    const result = await audio.load(0, 1, new AbortController().signal)
    expect(result.duration * 48000 * 512 * 4).toBeLessThan(AUDIO_WINDOW_BYTES)
    expect(client.rendition).toHaveBeenCalledWith({ ...query, element: [4] }, 'window', expect.objectContaining({ batch: 1 }))
    expect((await audio.load(7199.9, 0, new AbortController().signal)).duration).toBeCloseTo(0.1)
  })
  it('keeps nested list descent and tensor batch separate on the actual HTTP request', async () => {
    const urls: URL[] = []
    const client = new DinksterValuesClient({ baseUrl: 'http://audio.test', clientId: 'client', fetchFn: async (url) => {
      const parsed = new URL(String(url)); urls.push(parsed)
      return new Response(new ArrayBuffer(16), { headers: { 'Content-Type': parsed.searchParams.get('rendition') === 'waveform' ? 'image/png' : 'audio/wav' } })
    } })
    const selected = Object.freeze({ ...query, element: Object.freeze([1, 2]) })
    await audioPreview(client, selected, descriptor, renditions).load(1.25, 3, new AbortController().signal)
    expect(urls).toHaveLength(2)
    for (const url of urls) {
      expect(url.searchParams.get('element')).toBe('1,2')
      expect(url.searchParams.get('batch')).toBe('3')
      expect(url.searchParams.has('rendererVersion')).toBe(false)
    }
  })
  it('takes defaults and stricter sample/pixel bounds from each provider', async () => {
    const client = values()
    const audio = audioPreview(client, query, descriptor, [
      { ...renditions[0]!, defaults: { batch: '1' }, limits: { width: 128, height: 32, pixels: 1024 } },
      { ...renditions[1]!, defaults: { batch: '1' }, limits: { durationSeconds: 1, sampleValues: 48000 } },
    ])
    expect(audio.initialBatch).toBe(1)
    const result = await audio.load(10, 1, new AbortController().signal)
    expect(result.duration * 48000 * 17).toBeLessThanOrEqual(48000)
    expect(client.rendition).toHaveBeenCalledWith(query, 'waveform', expect.objectContaining({ waveform: { width: 128, height: 8 }, rendererVersion: 'wave-v1' }))
  })
  it('does not infer selectors from a kind alone or malformed capability metadata', async () => {
    const client = values()
    const audio = audioPreview(client, query, descriptor, [
      ...renditions.map(({ kind, mime }) => ({ kind, mime })),
      { ...renditions[0]!, limits: { width: 0.5, height: 128, pixels: 1024 } },
      { ...renditions[1]!, limits: { durationSeconds: Number.NaN, sampleValues: 1024 } },
    ])
    expect(audio.canScrub).toBe(false)
    expect(audio.canSelectBatch).toBe(false)
    expect((await audio.load(0, 0, new AbortController().signal)).diagnostics).toHaveLength(2)
    expect(client.rendition).not.toHaveBeenCalled()
  })
  it('omits unadvertised batch and does not label absent waveform headers as sampled peaks', async () => {
    const client = values()
    client.rendition = vi.fn<PeekValues['rendition']>(async (_query, kind) => ({ available: true, fingerprint: 'source', kind, mime: kind === 'waveform' ? 'image/png' : 'audio/wav', bytes: new ArrayBuffer(16) }))
    const audio = audioPreview(client, query, descriptor, renditions.map((info) => ({ ...info, parameters: [info.kind] })))
    expect(audio.canSelectBatch).toBe(false)
    const result = await audio.load(0, 0, new AbortController().signal)
    for (const call of vi.mocked(client.rendition).mock.calls) expect(call[2]).not.toHaveProperty('batch')
    expect(result.diagnostics).toContain('Waveform sampling method not reported')
    vi.mocked(client.rendition).mockClear()
    expect((await audio.load(0, 1, new AbortController().signal)).diagnostics.join(';')).toContain('does not advertise batch selection')
    expect(client.rendition).not.toHaveBeenCalled()
  })
  it('does not request unadvertised capabilities and exposes structured refusals', async () => {
    const client = values()
    const missing = await audioPreview(client, query, descriptor, [{ kind: 'wav', mime: 'audio/wav', default: true }]).load(0, 0, new AbortController().signal)
    expect(client.rendition).not.toHaveBeenCalled()
    expect(missing.diagnostics).toHaveLength(2)
    expect(missing.window).toBeUndefined()
    client.rendition = vi.fn(async () => ({ available: false as const, reason: 'bad-element', status: 404, error: 'batch absent' }))
    const refused = await audioPreview(client, query, descriptor, renditions).load(0, 4, new AbortController().signal)
    expect(refused.diagnostics.join(' ')).toContain('bad-element (404) - batch absent')
    expect(refused.window).toBeUndefined()
  })
})
