import { describe, expect, it } from 'vitest'
import { mediaMetadataOf } from '../src/media-metadata.js'

describe('mediaMetadataOf', () => {
  it.each([
    { name: 'FFmpeg integer defaults', color: { primaries: 1, transfer: 13, range: 2 }, expected: ['1', '13', '2'] },
    { name: 'reserved and unknown nonnegative integers', color: { primaries: 0, transfer: 12345, range: 67890 }, expected: ['0', '12345', '67890'] },
    { name: 'legacy string declarations', color: { primaries: 'srgb', transfer: 'srgb', range: 'full' }, expected: ['srgb', 'srgb', 'full'] },
  ])('preserves IMAGE $name without inferring missing alpha', ({ color, expected }) => {
    const meta = Object.freeze({ channels: Object.freeze({ layout: 'rgba', alpha: 'straight' }), dtype: 'float32', color: Object.freeze(color), storage_dtype: 'fp32' })
    const snapshot = JSON.stringify(meta)
    expect(mediaMetadataOf('comfy.IMAGE', meta)?.fields.map((field) => field.value)).toEqual([
      'fp32', 'rgba', 'straight', 'float32', ...expected,
    ])
    expect(JSON.stringify(meta)).toBe(snapshot)
    expect(mediaMetadataOf('asset<comfy.IMAGE>', undefined)?.fields.every((field) => field.value === undefined)).toBe(true)
  })

  it('reports MASK polarity and semantic without changing either', () => {
    expect(mediaMetadataOf('comfy.MASK', { polarity: 'coverage', semantic: 'selection', dtype: 'float32' })?.fields).toContainEqual({
      id: 'polarity', value: 'coverage',
    })
    expect(mediaMetadataOf('comfy.MASK', { polarity: false, semantic: null })?.fields).toContainEqual({
      id: 'semantic', value: undefined,
    })
  })

  it('shows AUDIO metadata without loading a waveform', () => {
    expect(mediaMetadataOf('comfy.AUDIO', { sample_rate: 48000, channels: 2, layout: 'stereo', duration: 0, dtype: 'float32' })?.fields.map((field) => field.value)).toEqual([
      undefined, '48000', '2', 'stereo', '0', 'float32',
    ])
  })

  it('distinguishes VIDEO source probe from effective lazy duration and preserves rational facts', () => {
    const meta = { container: 'mkv', probe: { video_codec: 'hevc', pix_fmt: 'yuv420p10le', alpha: false, bit_depth: 10, color_space: 'HDR PQ', duration: [10, 1] }, effective: { duration: [7, 2], fps: [30000, 1001], frame_count: 105 } }
    const before = JSON.stringify(meta)
    expect(mediaMetadataOf('comfy.VIDEO', meta)?.fields.map((field) => field.value)).toEqual([
      undefined, 'mkv', 'hevc', 'yuv420p10le', false, '10', 'HDR PQ', '7/2', '30000/1001', '105',
    ])
    expect(JSON.stringify(meta)).toBe(before)
  })

  it('rejects non-media types and displays malformed optional facts as unavailable', () => {
    expect(mediaMetadataOf('comfy.LATENT', {})).toBeUndefined()
    expect(mediaMetadataOf('list<comfy.IMAGE>', {})).toBeUndefined()
    expect(mediaMetadataOf('comfy.VIDEO', { probe: [], effective: { duration: [1, 0], fps: [NaN, 1] } })?.fields.every((field) => field.value === undefined)).toBe(true)
  })
})
