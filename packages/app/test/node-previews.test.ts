/**
 * createPreviewLoader unit tests: source selection (running frame vs output
 * thumbnail precedence, occurrence filtering, latest-frame-wins), resolve's
 * decode-once cache + in-flight dedupe + bounded eviction (ImageBitmap
 * close), and the peek negative cache (definitive misses remembered,
 * transient failures retryable, key changes retry naturally).
 */
import { describe, expect, it, vi } from 'vitest'
import type { NodePreview } from '@dinkster/canvas'
import { DinksterValuesClient, type ExecutionState, type FetchLike } from '@dinkster/client'
import { asConnectionId, asPromptId } from '@dinkster/core'
import { createPreviewLoader, deriveNodePreviewSurface, selectedPreviewAssetForRows, type PreviewLoader, type PreviewSource } from '../src/node-previews.js'

const exec = (over: {
  /** Flat one-frame-per-node shorthand, stored under the frame's stream key. */
  previews?: Record<string, { payload: unknown; timestamp: number; channel?: string; stream?: string }>
  /** Full per-stream shape for multi-stream nodes. */
  previewsByStream?: ExecutionState['previews']
  outputs?: Record<string, Record<string, unknown>>
  artifacts?: ExecutionState['artifacts']
}): ExecutionState =>
  ({
    ref: { connection: 'c1', prompt: 'p1' },
    key: 'k1',
    previews:
      over.previewsByStream ??
      Object.fromEntries(
        Object.entries(over.previews ?? {}).map(([id, f]) => [
          id,
          { [f.stream ?? '']: { channel: 'comfy/preview-image', ...f } },
        ]),
      ),
    outputs: over.outputs ?? {},
    artifacts: over.artifacts ?? [],
  }) as unknown as ExecutionState

const loader = (over?: { onDecoded?: () => void; renderModel3dPoster?: (src: string) => Promise<{ image: CanvasImageSource; width: number; height: number }> }) =>
  createPreviewLoader({
    viewUrlForExecution: (_ref, file) => `http://backend/view?f=${file.filename}&sf=${file.subfolder ?? ''}&t=${file.type ?? ''}`,
    assetUrlForExecution: (_ref, digest) => `http://backend/api/assets/${digest}`,
    assetUrlForInput: (digest) => `http://backend/api/assets/${digest}`,
    fetchRecordedOutput: async () => new Response(new Uint8Array([1, 2, 3])),
    onDecoded: over?.onDecoded ?? (() => {}),
    ...(over?.renderModel3dPoster !== undefined ? { renderModel3dPoster: over.renderModel3dPoster } : {}),
  })

const preview = (): NodePreview => ({ image: {} as CanvasImageSource, width: 1, height: 1 })

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('sourceFor', () => {
  it('ignores runtime ids outside the occurrence mapping', () => {
    const e = exec({ previews: { other: { payload: new Blob(['x']), timestamp: 1 } } })
    expect(loader().sourceFor(e, ['n1'], true)).toBeUndefined()
  })

  it('latest frame wins among matching occurrences; non-binary payloads are skipped', () => {
    const e = exec({
      previews: {
        a: { payload: new Blob(['old']), timestamp: 1 },
        b: { payload: new Blob(['new']), timestamp: 2 },
        c: { payload: { notBinary: true }, timestamp: 3 },
      },
    })
    const s = loader().sourceFor(e, ['a', 'b', 'c'], true)
    expect(s?.key).toMatch(/^frame:k1:b:2:\d+$/)
    expect(s?.runtimeId).toBe('b')
  })

  it('a multi-stream node shows its non-audio still even when audio is fresher', () => {
    const e = exec({
      previewsByStream: {
        n1: {
          video: { channel: 'image/jpeg', payload: new Blob(['v']), timestamp: 1, stream: 'video' },
          audio: { channel: 'image/jpeg', payload: new Blob(['a']), timestamp: 9, stream: 'audio' },
        },
      },
    })
    expect(loader().sourceFor(e, ['n1'], true)?.key).toMatch(/^frame:k1:n1:1:\d+$/)
    const audioOnly = exec({
      previewsByStream: {
        n1: { audio: { channel: 'image/jpeg', payload: new Blob(['a']), timestamp: 9, stream: 'audio' } },
      },
    })
    expect(loader().sourceFor(audioOnly, ['n1'], true)?.key).toMatch(/^frame:k1:n1:9:\d+$/)
  })

  it('a stream with a live frame ring outranks a fresher still on another stream', () => {
    const e = {
      ...exec({
        previewsByStream: {
          n1: {
            video: { channel: 'image/jpeg', payload: new Blob(['v']), timestamp: 1, stream: 'video', frameIndex: 0, frameCount: 4, fps: 16 },
            audio: { channel: 'image/jpeg', payload: new Blob(['a']), timestamp: 9, stream: 'audio' },
          },
        },
      }),
      previewRings: { n1: { video: { frameCount: 4, fps: 16, frames: {} } } },
    } as unknown as ExecutionState
    expect(loader().sourceFor(e, ['n1'], true)?.key).toMatch(/^frame:k1:n1:1:\d+$/)
  })

  it('a live animated image/webp frame decodes into cycling animation frames', async () => {
    const videoFrames = [500_000, 500_000, 500_000].map((duration) => ({ duration, close: vi.fn() }))
    class FakeImageDecoder {
      static isTypeSupported = vi.fn(async () => true)
      tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 3 } }
      close = vi.fn()
      decode = async ({ frameIndex }: { frameIndex: number }) => ({ image: videoFrames[frameIndex]! })
    }
    const bitmap = { width: 8, height: 6 }
    const decode = vi.fn(async () => bitmap)
    vi.stubGlobal('ImageDecoder', FakeImageDecoder)
    vi.stubGlobal('createImageBitmap', decode)
    try {
      const e = exec({ previews: { n1: { payload: new Blob(['w']), timestamp: 5, channel: 'image/webp' } } })
      const s = loader().sourceFor(e, ['n1'], true)!
      const loaded = await s.load()
      expect(loaded).toMatchObject({ image: bitmap, width: 8, height: 6 })
      expect(loaded.animation?.frames).toEqual([bitmap, bitmap, bitmap])
      expect(loaded.animation?.fps).toBe(2) // 3 frames over 1.5s of container timing
      for (const frame of videoFrames) expect(frame.close).toHaveBeenCalledTimes(1)
      expect(decode).toHaveBeenCalledTimes(3)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('an animated container without timing falls back to the default fps', async () => {
    const videoFrames = [0, 0].map(() => ({ duration: 0, close: vi.fn() }))
    class FakeImageDecoder {
      static isTypeSupported = vi.fn(async () => true)
      tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 2 } }
      close = vi.fn()
      decode = async ({ frameIndex }: { frameIndex: number }) => ({ image: videoFrames[frameIndex]! })
    }
    vi.stubGlobal('ImageDecoder', FakeImageDecoder)
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1 })))
    try {
      const e = exec({ previews: { n1: { payload: new Blob(['g']), timestamp: 5, channel: 'image/gif' } } })
      const loaded = await loader().sourceFor(e, ['n1'], true)!.load()
      expect(loaded.animation?.fps).toBe(8)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a missing ImageDecoder degrades an animated mime to a plain still', async () => {
    const bitmap = { width: 4, height: 4 }
    const decode = vi.fn(async () => bitmap)
    vi.stubGlobal('createImageBitmap', decode)
    try {
      // jsdom has no ImageDecoder; the webp payload decodes as a first-frame still.
      const e = exec({ previews: { n1: { payload: new Blob(['w']), timestamp: 5, channel: 'image/webp' } } })
      const loaded = await loader().sourceFor(e, ['n1'], true)!.load()
      expect(loaded).toEqual({ image: bitmap, width: 4, height: 4 })
      expect(decode).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a single-frame animated container degrades to a plain still', async () => {
    class FakeImageDecoder {
      static isTypeSupported = vi.fn(async () => true)
      tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 1 } }
      close = vi.fn()
      decode = async () => { throw new Error('decode should not be reached') }
    }
    const bitmap = { width: 4, height: 4 }
    vi.stubGlobal('ImageDecoder', FakeImageDecoder)
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
    try {
      const e = exec({ previews: { n1: { payload: new Blob(['w']), timestamp: 5, channel: 'image/webp' } } })
      const loaded = await loader().sourceFor(e, ['n1'], true)!.load()
      expect(loaded).toEqual({ image: bitmap, width: 4, height: 4 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a rejected support probe degrades to a plain still', async () => {
    class ProbeFailsDecoder {
      static isTypeSupported = vi.fn(async () => { throw new Error('probe blew up') })
    }
    const bitmap = { width: 4, height: 4 }
    vi.stubGlobal('ImageDecoder', ProbeFailsDecoder)
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
    try {
      const e = exec({ previews: { n1: { payload: new Blob(['w']), timestamp: 5, channel: 'image/webp' } } })
      await expect(loader().sourceFor(e, ['n1'], true)!.load())
        .resolves.toEqual({ image: bitmap, width: 4, height: 4 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a decoder constructor failure degrades to a plain still', async () => {
    class ConstructorFailsDecoder {
      static isTypeSupported = vi.fn(async () => true)
      constructor() { throw new Error('no decoder for you') }
    }
    const bitmap = { width: 4, height: 4 }
    vi.stubGlobal('ImageDecoder', ConstructorFailsDecoder)
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
    try {
      const e = exec({ previews: { n1: { payload: new Blob(['w']), timestamp: 5, channel: 'image/webp' } } })
      await expect(loader().sourceFor(e, ['n1'], true)!.load())
        .resolves.toEqual({ image: bitmap, width: 4, height: 4 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a mid-frame decode failure closes earlier frames, closes the decoder, and degrades', async () => {
    const goodFrame = { duration: 100_000, close: vi.fn() }
    let decoderInstance: { close: ReturnType<typeof vi.fn> } | undefined
    class FlakyDecoder {
      static isTypeSupported = vi.fn(async () => true)
      tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 3 } }
      close = vi.fn()
      decode = async ({ frameIndex }: { frameIndex: number }) => {
        if (frameIndex === 0) return { image: goodFrame }
        throw new Error('bad frame')
      }
      constructor() { decoderInstance = this }
    }
    const frameBitmap = { width: 2, height: 2, close: vi.fn() }
    const stillBitmap = { width: 4, height: 4 }
    vi.stubGlobal('ImageDecoder', FlakyDecoder)
    vi.stubGlobal('createImageBitmap', vi.fn(async (input: unknown) => (input === goodFrame ? frameBitmap : stillBitmap)))
    try {
      const e = exec({ previews: { n1: { payload: new Blob(['w']), timestamp: 5, channel: 'image/webp' } } })
      const loaded = await loader().sourceFor(e, ['n1'], true)!.load()
      expect(loaded).toEqual({ image: stillBitmap, width: 4, height: 4 })
      expect(frameBitmap.close).toHaveBeenCalledTimes(1)
      expect(goodFrame.close).toHaveBeenCalledTimes(1)
      expect(decoderInstance?.close).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a superseded animated frame decode is released instead of cached', async () => {
    const readies: Array<() => void> = []
    class GatedDecoder {
      static isTypeSupported = vi.fn(async () => true)
      tracks = {
        ready: new Promise<void>((resolve) => { readies.push(resolve) }),
        selectedTrack: { frameCount: 2 },
      }
      close = vi.fn()
      decode = async () => ({ image: { duration: 100_000, close: vi.fn() } })
    }
    class FakeBitmap {
      close = vi.fn()
    }
    const bitmaps: FakeBitmap[] = []
    vi.stubGlobal('ImageDecoder', GatedDecoder)
    vi.stubGlobal('ImageBitmap', FakeBitmap)
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      const bitmap = new FakeBitmap()
      bitmaps.push(bitmap)
      return bitmap
    }))
    try {
      const l = loader()
      const at = (timestamp: number, tag: string) =>
        exec({ previews: { n1: { payload: new Blob([tag]), timestamp, channel: 'image/webp' } } })
      const older = l.sourceFor(at(1, 'w1'), ['n1'], true)!
      const newer = l.sourceFor(at(2, 'w2'), ['n1'], true)!
      expect(older.key).not.toBe(newer.key)
      l.resolve(older)
      l.resolve(newer)
      await flush()
      expect(readies).toHaveLength(2)
      for (const ready of readies) ready()
      await flush()
      // The older completion is released and dropped; the newer one is cached.
      expect(l.resolve(newer)).toBeDefined()
      expect(bitmaps).toHaveLength(4)
      expect(bitmaps.filter((b) => b.close.mock.calls.length > 0)).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a live video/* frame loads through the DOM media path', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:live-video')
    try {
      const e = exec({ previews: { n1: { payload: new Blob(['m']), timestamp: 5, channel: 'video/mp4' } } })
      const s = loader().sourceFor(e, ['n1'], true)
      expect(s?.mediaKind).toBe('video')
      const loaded = await s!.load()
      expect(loaded).toEqual({ kind: 'video', mime: 'video/mp4', src: 'blob:live-video' })
    } finally {
      create.mockRestore()
    }
  })

  it('a RUNNING node prefers its live frame over an output image', () => {
    const e = exec({
      previews: { n1: { payload: new Blob(['f']), timestamp: 5 } },
      outputs: { n1: { images: [{ filename: 'out.png' }] } },
    })
    expect(loader().sourceFor(e, ['n1'], true)?.key).toMatch(/^frame:k1:n1:5:\d+$/)
  })

  it('a finished node prefers the output image, routed through the execution backend', () => {
    const e = exec({
      previews: { n1: { payload: new Blob(['f']), timestamp: 5 } },
      outputs: { n1: { images: [{ filename: 'out.png', subfolder: 'sub', type: 'output' }] } },
    })
    expect(loader().sourceFor(e, ['n1'], false)?.key).toBe('recorded:img:http://backend/view?f=out.png&sf=sub&t=output:name:out.png')
  })

  it('selects any finished output page and carries its real index/count', () => {
    const e = exec({
      outputs: { n1: { images: [{ filename: 'first.png' }, { filename: 'second.png' }, { filename: 'third.png' }] } },
    })
    const source = loader().sourceFor(e, ['n1'], false, 1)
    expect(source?.key).toBe('recorded:img:http://backend/view?f=second.png&sf=&t=:name:second.png')
    expect(source?.output).toEqual({ index: 1, count: 3 })
  })

  it('clamps a stale finished output page when the inventory shrinks', () => {
    const e = exec({ outputs: { n1: { images: [{ filename: 'only.png' }] } } })
    const source = loader().sourceFor(e, ['n1'], false, 7)
    expect(source?.key).toBe('recorded:img:http://backend/view?f=only.png&sf=&t=:name:only.png')
    expect(source?.output).toEqual({ index: 0, count: 1 })
  })

  it('falls back to the last frame when no output image exists', () => {
    const e = exec({ previews: { n1: { payload: new Blob(['f']), timestamp: 5 } } })
    expect(loader().sourceFor(e, ['n1'], false)?.key).toMatch(/^frame:k1:n1:5:\d+$/)
  })

  it('outputs without a filename or non-array images are ignored', () => {
    const e = exec({ outputs: { n1: { images: [{}] }, n2: { images: 'nope' } } })
    expect(loader().sourceFor(e, ['n1', 'n2'], false)).toBeUndefined()
  })

  it('a native asset output renders by CAS digest through the execution backend', () => {
    const digest = `blake3:${'a'.repeat(64)}`
    const e = exec({
      outputs: {
        n1: {
          assets: {
            typeId: 'list<dinkster.asset>',
            fingerprint: 'fp',
            elements: [
              { typeId: 'dinkster.asset', fingerprint: digest, meta: { digest, mediaType: 'image/png', name: 'out.png' } },
            ],
          },
        },
      },
    })
    const s = loader().sourceFor(e, ['n1'], false)
    expect(s?.key).toBe(`recorded:asset:${digest}:media:image/png:url:http://backend/api/assets/${digest}:name:out.png`)
    expect(s?.runtimeId).toBe('n1')
  })

  it('a native non-image asset output yields no source', () => {
    const digest = `blake3:${'b'.repeat(64)}`
    const e = exec({
      outputs: {
        n1: {
          assets: { typeId: 'dinkster.asset', fingerprint: digest, meta: { digest, mediaType: 'application/json' } },
        },
      },
    })
    expect(loader().sourceFor(e, ['n1'], false)).toBeUndefined()
  })

  it('routes saved images and audio but leaves videos to bounded value renditions', async () => {
    const artifact = (nodeId: string, digit: string, mediaType: string, name: string) => ({
      nodeId,
      digest: `blake3:${digit.repeat(64)}`,
      name,
      size: 4043,
      mediaType,
      virtualPath: `output/${name}`,
    })
    const l = loader()
    const image = l.sourceFor(exec({ artifacts: [artifact('image', 'd', 'image/png', 'result.png')] }), ['image'], false)!
    expect(image).toMatchObject({
      key: `recorded:asset:blake3:${'d'.repeat(64)}:media:image/png:url:http://backend/api/assets/blake3:${'d'.repeat(64)}:name:result.png`,
      runtimeId: 'image',
      mediaKind: 'image',
    })

    const video = l.sourceFor(exec({ artifacts: [
      artifact('other', 'e', 'audio/wav', 'other.wav'),
      artifact('video', 'f', 'video/mp4', 'first.mp4'),
      artifact('video', 'c', 'video/webm', 'second.webm'),
    ] }), ['video'], false, 1)!
    expect(video).toBeUndefined()

    const audio = l.sourceFor(exec({ artifacts: [artifact('audio', 'a', 'audio/wav', 'result.wav')] }), ['audio'], false)!
    expect(audio).toMatchObject({
      key: `recorded:asset:blake3:${'a'.repeat(64)}:media:audio/wav:url:http://backend/api/assets/blake3:${'a'.repeat(64)}:name:result.wav`,
      mediaKind: 'audio',
    })
    const loadedAudio = await audio.load()
    expect(loadedAudio).toMatchObject({ kind: 'audio', mime: 'audio/wav' })
    expect(loadedAudio.src).toBe('')
    expect(loadedAudio.download).toEqual({ src: `http://backend/api/assets/blake3:${'a'.repeat(64)}`, name: 'result.wav', load: expect.any(Function) })
    expect(l.sourceFor(exec({ artifacts: [artifact('data', 'b', 'application/json', 'result.json')] }), ['data'], false)).toBeUndefined()
  })

  it('fetches cross-origin recorded audio only for an explicit download and sanitizes the filename', async () => {
    const digest = `blake3:${'4'.repeat(64)}`
    const url = `https://outputs.example/api/assets/${digest}`
    const fetchRecordedOutput = vi.fn(async () => new Response(new Uint8Array([7, 8, 9])))
    const l = createPreviewLoader({
      viewUrlForExecution: () => '',
      assetUrlForExecution: () => url,
      assetUrlForInput: () => undefined,
      fetchRecordedOutput,
      onDecoded: () => {},
    })
    const source = l.sourceFor(exec({ artifacts: [{
      nodeId: 'save',
      digest,
      name: '../unsafe\\name\n\t\u007f.webm',
      size: 3,
      mediaType: 'audio/wav',
      virtualPath: 'output/unsafe.webm',
    }] }), ['save'], false)!
    const loaded = await source.load()
    expect(fetchRecordedOutput).not.toHaveBeenCalled()
    expect(loaded.src).toBe('')
    expect(loaded.download).toMatchObject({ src: url, name: '_unsafe_name_.webm' })
    const signal = new AbortController().signal
    const blob = await loaded.download!.load!(signal)
    expect(fetchRecordedOutput).toHaveBeenCalledWith(url, { signal })
    expect(blob.type).toBe('audio/wav')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]))
  })

  it('includes the sanitized download name in recorded cache identity', () => {
    const digest = `blake3:${'8'.repeat(64)}`
    const artifact = (name: string) => ({
      nodeId: 'save',
      digest,
      name,
      size: 3,
      mediaType: 'audio/wav',
      virtualPath: `output/${name}`,
    })
    const l = loader()
    const first = l.sourceFor(exec({ artifacts: [artifact('first.webm')] }), ['save'], false)!
    const renamed = l.sourceFor(exec({ artifacts: [artifact('renamed.webm')] }), ['save'], false)!
    expect(first.key).not.toBe(renamed.key)
    expect(renamed.key).toContain(':name:renamed.webm')
  })

  it('keeps selected-input and recorded-output cache identities separate', async () => {
    const digest = `blake3:${'3'.repeat(64)}`
    const url = `http://backend/api/assets/${digest}`
    const poster = { image: {} as CanvasImageSource, width: 512, height: 384 }
    const l = loader({ renderModel3dPoster: () => Promise.resolve(poster) })
    const input = l.inputAssetSource!(digest, 'model/gltf-binary', 'model3d')!
    const output = l.sourceFor(exec({ artifacts: [{
      nodeId: 'save',
      digest,
      name: 'mesh.glb',
      size: 128,
      mediaType: 'model/gltf-binary',
      virtualPath: 'output/mesh.glb',
    }] }), ['save'], false)!
    expect(input.key).not.toBe(output.key)
    expect(await input.load()).not.toHaveProperty('download')
    expect(await output.load()).toHaveProperty('download.name', 'mesh.glb')
  })

  it('routes a saved GLB artifact through a poster-rendering model3d preview', async () => {
    const digest = `blake3:${'9'.repeat(64)}`
    const url = `http://backend/api/assets/${digest}`
    const poster = { image: {} as CanvasImageSource, width: 512, height: 384 }
    const render = vi.fn(() => Promise.resolve(poster))
    const l = loader({ renderModel3dPoster: render })
    const s = l.sourceFor(exec({ artifacts: [{
      nodeId: 'save',
      digest,
      name: 'mesh.glb',
      size: 128,
      mediaType: 'model/gltf-binary',
      virtualPath: 'output/mesh.glb',
    }] }), ['save'], false)!
    expect(s).toMatchObject({
      key: `recorded:asset:${digest}:media:model/gltf-binary:url:${url}:name:mesh.glb`,
      failureKey: `asset-url:${url}`,
      runtimeId: 'save',
      mediaKind: 'model3d',
    })
    const loaded = await s.load()
    expect(loaded).toMatchObject({
      kind: 'model3d', mime: 'model/gltf-binary',
      image: poster.image, width: 512, height: 384,
    })
    expect(loaded.src).toMatch(/^blob:/)
    expect(loaded.download).toEqual({ src: loaded.src, name: 'mesh.glb' })
    expect(render).toHaveBeenCalledWith(loaded.src, 'model/gltf-binary')
  })

  it('routes a saved splat PLY artifact through a poster-rendering model3d preview', async () => {
    const digest = `blake3:${'5'.repeat(64)}`
    const url = `http://backend/api/assets/${digest}`
    const poster = { image: {} as CanvasImageSource, width: 512, height: 384 }
    const render = vi.fn(() => Promise.resolve(poster))
    const l = loader({ renderModel3dPoster: render })
    const s = l.sourceFor(exec({ artifacts: [{
      nodeId: 'save',
      digest,
      name: 'splat.ply',
      size: 256,
      mediaType: 'model/ply',
      virtualPath: 'output/splat.ply',
    }] }), ['save'], false)!
    expect(s).toMatchObject({
      key: `recorded:asset:${digest}:media:model/ply:url:${url}:name:splat.ply`,
      failureKey: `asset-url:${url}`,
      runtimeId: 'save',
      mediaKind: 'model3d',
    })
    const loaded = await s.load()
    expect(loaded).toMatchObject({
      kind: 'model3d', mime: 'model/ply',
      image: poster.image, width: 512, height: 384,
    })
    expect(loaded.src).toMatch(/^blob:/)
    expect(loaded.download).toEqual({ src: loaded.src, name: 'splat.ply' })
    expect(render).toHaveBeenCalledWith(loaded.src, 'model/ply')
  })

  it('a model3d preview whose poster render fails carries a failed status', async () => {
    const digest = `blake3:${'7'.repeat(64)}`
    const l = loader({ renderModel3dPoster: () => Promise.reject(new Error('no webgl')) })
    const s = l.inputAssetSource!(digest, 'model/gltf-binary', 'model3d')!
    await expect(s.load()).resolves.toEqual({
      kind: 'model3d', mime: 'model/gltf-binary', src: `http://backend/api/assets/${digest}`, status: 'failed',
    })
  })

  it('retains download metadata when a recorded model3d poster render fails', async () => {
    const digest = `blake3:${'7'.repeat(64)}`
    const l = loader({ renderModel3dPoster: () => Promise.reject(new Error('no webgl')) })
    const source = l.sourceFor(exec({ artifacts: [{
      nodeId: 'save',
      digest,
      name: 'mesh.glb',
      size: 128,
      mediaType: 'model/gltf-binary',
      virtualPath: 'output/mesh.glb',
    }] }), ['save'], false)!
    const loaded = await source.load()
    expect(loaded).toMatchObject({ kind: 'model3d', status: 'failed' })
    expect(loaded.download).toEqual({ src: loaded.src, name: 'mesh.glb' })
  })

  it('selected model3d input assets key by digest, media type, and URL', async () => {
    const digest = `blake3:${'6'.repeat(64)}`
    const url = `http://backend/api/assets/${digest}`
    const poster = { image: {} as CanvasImageSource, width: 512, height: 384 }
    const l = loader({ renderModel3dPoster: () => Promise.resolve(poster) })
    const s = l.inputAssetSource!(digest, 'model/gltf-binary', 'model3d')!
    expect(s).toMatchObject({
      key: `asset:${digest}:media:model/gltf-binary:url:${url}`,
      failureKey: `asset-url:${url}`,
      mediaKind: 'model3d',
    })
    await expect(s.load()).resolves.toMatchObject({ kind: 'model3d', src: url, width: 512, height: 384 })
  })

  it('scopes saved media URL and failure caches to the execution backend', async () => {
    const digest = `blake3:${'8'.repeat(64)}`
    const artifact = {
      nodeId: 'save',
      digest,
      name: 'saved.webm',
      size: 4043,
      mediaType: 'audio/wav',
      virtualPath: 'output/saved.webm',
    }
    const execution = (connection: string): ExecutionState => ({
      ...exec({ artifacts: [artifact] }),
      ref: { connection: asConnectionId(connection), prompt: asPromptId('p1') },
      key: `${connection}:p1`,
    })
    const l = createPreviewLoader({
      viewUrlForExecution: () => '',
      assetUrlForExecution: (ref, value) => `http://${ref.connection}/api/assets/${value}`,
      assetUrlForInput: () => undefined,
      fetchRecordedOutput: async () => new Response(new Uint8Array([1, 2, 3])),
      onDecoded: () => {},
    })
    const backendA = l.sourceFor(execution('backend-a'), ['save'], false)!
    const backendB = l.sourceFor(execution('backend-b'), ['save'], false)!
    expect(backendA.key).not.toBe(backendB.key)
    expect(backendA.failureKey).toBe(`asset-url:http://backend-a/api/assets/${digest}`)
    expect(backendB.failureKey).toBe(`asset-url:http://backend-b/api/assets/${digest}`)

    expect(l.resolve(backendA)).toBeUndefined()
    await flush()
    expect(l.resolve(backendA)?.download?.src).toBe(`http://backend-a/api/assets/${digest}`)
    expect(l.resolve(backendB)).toBeUndefined()
    await flush()
    expect(l.resolve(backendB)?.download?.src).toBe(`http://backend-b/api/assets/${digest}`)

    l.markUnavailable!(backendA)
    expect(l.unavailable!(backendA)).toBe(true)
    expect(l.unavailable!(backendB)).toBe(false)
    expect(l.resolve(backendB)?.download?.src).toBe(`http://backend-b/api/assets/${digest}`)
    expect(l.sourceFor(execution('backend-b'), ['save'], false)?.key).toBe(backendB.key)
  })

  it('uses a pass-through image instead of downloading a saved original WebM', async () => {
    const digest = `blake3:${'9'.repeat(64)}`
    const execution = exec({
      outputs: { save: { images: [{ filename: 'pass-through.png' }] } },
      artifacts: [{
        nodeId: 'save',
        digest,
        name: 'saved.webm',
        size: 4043,
        mediaType: 'video/webm',
        virtualPath: 'output/saved.webm',
      }],
    })
    const l = loader()
    const source = l.sourceFor(execution, ['save'], false)!
    expect(source).toMatchObject({
      key: 'recorded:img:http://backend/view?f=pass-through.png&sf=&t=:name:pass-through.png',
      runtimeId: 'save',
    })
  })

  it('a v1 output image wins over a native asset on the same node', () => {
    const digest = `blake3:${'c'.repeat(64)}`
    const e = exec({
      outputs: {
        n1: {
          images: [{ filename: 'out.png' }],
          assets: { typeId: 'dinkster.asset', fingerprint: digest, meta: { digest, mediaType: 'image/png' } },
        },
      },
    })
    expect(loader().sourceFor(e, ['n1'], false)?.key).toBe('recorded:img:http://backend/view?f=out.png&sf=&t=:name:out.png')
  })

  it('FR12 a same-timestamp replacement frame gets a new cache identity', () => {
    const l = loader()
    const first = new Blob(['first'])
    const second = new Blob(['second'])
    const firstKey = l.sourceFor(exec({ previews: { n1: { payload: first, timestamp: 5 } } }), ['n1'], true)?.key
    const secondKey = l.sourceFor(exec({ previews: { n1: { payload: second, timestamp: 5 } } }), ['n1'], true)?.key
    const repeatedKey = l.sourceFor(exec({ previews: { n1: { payload: first, timestamp: 5 } } }), ['n1'], true)?.key
    expect(secondKey).not.toBe(firstKey)
    expect(repeatedKey).toBe(firstKey)
  })
})

describe('resolve', () => {
  const src = (key: string, load: () => Promise<NodePreview>): PreviewSource => ({ key, load })

  it('kicks one decode per key, caches it, and fires onDecoded', async () => {
    const onDecoded = vi.fn()
    const l = loader({ onDecoded })
    const load = vi.fn(() => Promise.resolve(preview()))
    expect(l.resolve(src('a', load))).toBeUndefined() // kick
    expect(l.resolve(src('a', load))).toBeUndefined() // deduped while pending
    await flush()
    expect(load).toHaveBeenCalledTimes(1)
    expect(onDecoded).toHaveBeenCalledTimes(1)
    expect(l.resolve(src('a', load))).toBeDefined() // cached
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('a failed non-peek decode is dropped and stays retryable', async () => {
    const l = loader()
    const fail = vi.fn(() => Promise.reject(new Error('bad frame')))
    l.resolve(src('frame:x', fail))
    await flush()
    l.resolve(src('frame:x', fail))
    await flush()
    expect(fail).toHaveBeenCalledTimes(2)
  })

  it('reuses the digest cache for selected input assets and negative-caches failures', async () => {
    const l = loader()
    const digest = `blake3:${'d'.repeat(64)}`
    const input = l.inputAssetSource!(digest, 'image/png', 'image')!
    expect(input.key).toBe(`asset:${digest}`)
    const load = vi.fn(() => Promise.resolve(preview()))
    l.resolve(src(input.key, load))
    await flush()
    expect(l.resolve(input)).toBeDefined()
    expect(load).toHaveBeenCalledTimes(1)

    const missingDigest = `blake3:${'e'.repeat(64)}`
    const missing = l.inputAssetSource!(missingDigest, 'image/png', 'image')!
    const fail = vi.fn(() => Promise.reject(new Error('missing asset')))
    l.resolve({ ...missing, load: fail })
    await flush()
    expect(l.unavailable!(missing)).toBe(true)
    expect(l.resolve({ ...missing, load: fail })).toBeUndefined()
    await flush()
    expect(fail).toHaveBeenCalledTimes(1)

    const otherBackend = { ...missing, failureKey: 'asset-url:http://other/asset', load: () => Promise.resolve(preview()) }
    expect(l.resolve(otherBackend)).toBeUndefined()
    await flush()
    expect(l.resolve(otherBackend)).toBeDefined()
  })

  it('refuses selected videos without requesting original input bytes on either backend', async () => {
    const digest = `blake3:${'f'.repeat(64)}`
    let backend = 'backend-a'
    const l = createPreviewLoader({
      viewUrlForExecution: () => '',
      assetUrlForExecution: () => '',
      assetUrlForInput: (value) => `http://${backend}/api/assets/${value}`,
      onDecoded: () => {},
    })
    const backendA = l.inputAssetSource!(digest, 'video/webm', 'video')!
    backend = 'backend-b'
    const backendB = l.inputAssetSource!(digest, 'video/webm', 'video')!
    expect(backendA.key).toBe(`video-input:${digest}`)
    expect(backendB.key).toBe(backendA.key)
    const unavailable = { kind: 'video', status: 'unavailable', statusMessage: 'Video input preview pending server route' }
    await expect(backendA.load()).resolves.toEqual(unavailable)
    await expect(backendB.load()).resolves.toEqual(unavailable)
  })

  it('evicts beyond the cache bound, closing ImageBitmaps', async () => {
    class FakeBitmap {
      close = vi.fn()
    }
    vi.stubGlobal('ImageBitmap', FakeBitmap)
    try {
      const l = loader()
      const first = new FakeBitmap()
      l.resolve(src('k0', () => Promise.resolve({ image: first as unknown as CanvasImageSource, width: 1, height: 1 })))
      await flush()
      for (let i = 1; i <= 160; i++) {
        l.resolve(src(`k${i}`, () => Promise.resolve(preview())))
      }
      await flush()
      // k0 was the oldest of 161 entries: evicted and closed.
      expect(first.close).toHaveBeenCalledTimes(1)
      const reload = vi.fn(() => Promise.resolve(preview()))
      expect(l.resolve(src('k0', reload))).toBeUndefined()
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('bounds decoded batch pages by RGBA size rather than page count', async () => {
    const l = loader()
    const load = vi.fn(async () => ({ ...preview(), width: 4096, height: 4096 }))
    try {
      for (let index = 0; index < 5; index++) {
        l.resolve(src(`page${index}`, load))
        await flush()
      }
      expect(l.resolve(src('page4', load))).toBeDefined()
      expect(load).toHaveBeenCalledTimes(5)
      expect(l.resolve(src('page0', load))).toBeUndefined()
      expect(load).toHaveBeenCalledTimes(6)
      await flush()
    } finally {
      l.dispose()
    }
  })

  it('bounds retained animation frames by bitmap weight, not just entry count', async () => {
    class FakeBitmap {
      close = vi.fn()
    }
    vi.stubGlobal('ImageBitmap', FakeBitmap)
    try {
      const l = loader()
      // 20 clips of 24 frames: each weighs 25, so the 256-bitmap budget
      // retains ~10 clips instead of all 20 piling up under the entry cap.
      const clips = Array.from({ length: 20 }, () => Array.from({ length: 24 }, () => new FakeBitmap()))
      for (const [i, frames] of clips.entries()) {
        l.resolve(src(`clip${i}`, () => Promise.resolve({
          image: frames[0] as unknown as CanvasImageSource,
          width: 1,
          height: 1,
          animation: { frames: frames as unknown as ImageBitmap[], fps: 8 },
        })))
        await flush()
      }
      const closed = clips.filter((frames) => frames.every((f) => f.close.mock.calls.length > 0)).length
      const retained = clips.filter((frames) => frames.every((f) => f.close.mock.calls.length === 0)).length
      expect(closed).toBe(10)
      expect(retained).toBe(10)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('evicting an animated preview closes its frame bitmaps', async () => {
    class FakeBitmap {
      close = vi.fn()
    }
    vi.stubGlobal('ImageBitmap', FakeBitmap)
    try {
      const l = loader()
      const still = new FakeBitmap()
      const frames = [new FakeBitmap(), new FakeBitmap()]
      l.resolve(src('anim', () => Promise.resolve({
        image: still as unknown as CanvasImageSource,
        width: 1,
        height: 1,
        animation: { frames: frames as unknown as ImageBitmap[], fps: 8 },
      })))
      await flush()
      for (let i = 1; i <= 160; i++) {
        l.resolve(src(`k${i}`, () => Promise.resolve(preview())))
      }
      await flush()
      expect(still.close).toHaveBeenCalledTimes(1)
      for (const frame of frames) expect(frame.close).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('FR12 dispose closes cached bitmaps and drops an in-flight decode', async () => {
    class FakeBitmap {
      close = vi.fn()
    }
    vi.stubGlobal('ImageBitmap', FakeBitmap)
    try {
      const onDecoded = vi.fn()
      const l = loader({ onDecoded })
      const cached = new FakeBitmap()
      l.resolve(src('cached', () => Promise.resolve({ image: cached as unknown as CanvasImageSource, width: 1, height: 1 })))
      await flush()
      onDecoded.mockClear()
      let finish!: (value: NodePreview) => void
      l.resolve(src('pending', () => new Promise((resolve) => { finish = resolve })))
      l.dispose()
      const pending = new FakeBitmap()
      finish({ image: pending as unknown as CanvasImageSource, width: 1, height: 1 })
      await flush()
      expect(cached.close).toHaveBeenCalledTimes(1)
      expect(pending.close).toHaveBeenCalledTimes(1)
      expect(onDecoded).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('peekSource negative cache', () => {
  const values = {} as DinksterValuesClient
  const candidates = [{ node: 'n1', output: 'image' }]

  it('keeps a refused batch page on the selected output and allows paging back', async () => {
    const requests: URL[] = []
    const client = new DinksterValuesClient({ baseUrl: 'http://owner', clientId: 'client', fetchFn: async (url) => {
      const query = new URL(url); requests.push(query)
      if (!query.searchParams.has('rendition')) return new Response(JSON.stringify({ available: true,
        descriptor: { typeId: 'comfy.IMAGE', fingerprint: 'fp', meta: { shape: [9, 32, 48, 3] } },
        renditions: [{ kind: 'png', mime: 'image/png', default: true, version: 'png-test-v1', parameters: ['batch'], defaults: { batch: '0' }, limits: { maxEdge: 1024 } }],
      }))
      if (query.searchParams.get('batch') === '3') return new Response(JSON.stringify({ available: false, reason: 'bad-element', error: 'Element unavailable' }), { status: 404 })
      return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png', 'X-Dinkster-Fingerprint': 'fp', 'X-Dinkster-Rendition': 'png' } })
    } })
    const rendition = vi.spyOn(client, 'rendition')
    const l = loader()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 48, height: 32 })))
    try {
      const sequence = [...candidates, { node: 'wrong-node', output: 'wrong-output' }]
      const first = l.peekSource(client, exec({}), sequence, 'scene')!
      l.resolve(first); await flush(); await flush()
      expect(first.imageBatch?.count).toBe(9)
      expect(first.imageBatch?.imageAt(0).key).toContain('"png-test-v1"')
      const refused = l.peekSource(client, exec({}), sequence, 'scene', 3)!
      l.resolve(refused); await flush(); await flush()
      expect(l.unavailable!(refused)).toBe(true)
      expect(l.peekSource(client, exec({}), sequence, 'scene', 3)?.imageBatch?.count).toBe(9)
      expect(l.resolve(first)?.width).toBe(48)
      expect(requests.every((query) => query.searchParams.get('nodeId') === 'n1' && query.searchParams.get('outputId') === 'image')).toBe(true)
      expect(requests.every((query) => !query.searchParams.has('element'))).toBe(true)
      expect(requests.every((query) => !query.searchParams.has('rendererVersion'))).toBe(true)
      expect(requests.filter((query) => query.searchParams.has('rendition')).map((query) => query.searchParams.get('batch'))).toEqual(['0', '3'])
      expect(rendition.mock.calls.map((call) => call[2]?.rendererVersion)).toEqual(['png-test-v1', 'png-test-v1'])
    } finally { l.dispose(); vi.unstubAllGlobals() }
  })

  it('cancels a pending page even when navigation returns to a cached page', async () => {
    const l = loader()
    const cached: PreviewSource = { key: 'peek:first', cancellationKey: 'batch', load: async () => preview() }
    l.resolve(cached); await flush()
    let signal: AbortSignal | undefined
    let finish!: (preview: NodePreview) => void
    l.resolve({ key: 'peek:next', cancellationKey: 'batch', load: (abort) => { signal = abort; return new Promise((resolve) => { finish = resolve }) } })
    expect(l.resolve(cached)).toBeDefined()
    expect(signal?.aborted).toBe(true)
    finish(preview()); await flush()
    l.dispose()
  })

  it('keys by execution, scene node, and candidate set', () => {
    const s = loader().peekSource(values, exec({}), candidates, 'scene1')
    expect(s?.key).toBe('peek:["k1","scene1",[["n1","image"]]]:batch:0')
    expect(loader().peekSource(values, exec({}), candidates, 'scene1', 1)?.key).not.toBe(s?.key)
    expect(loader().peekSource(values, exec({}), [{ node: 'n1.image', output: 'a' }], 'scene1')?.key)
      .not.toBe(loader().peekSource(values, exec({}), [{ node: 'n1', output: 'image.a' }], 'scene1')?.key)
  })

  it('a DEFINITIVE miss is remembered; the same key is not offered again', async () => {
    const l = loader()
    const declared = [{ ...candidates[0]!, declaredIntent: true as const, mediaKind: 'image' as const }]
    const s = l.peekSource(values, exec({}), declared, 'scene1')!
    l.resolve({ key: s.key, load: () => Promise.reject(Object.assign(new Error('no renditions'), { transient: false, negativeCache: true })) })
    await flush()
    const unavailable = l.peekSource(values, exec({}), declared, 'scene1')!
    expect(l.unavailable!(unavailable)).toBe(true)
    expect(l.resolve(unavailable)).toBeUndefined()
    // A different candidate set changes the key and retries naturally.
    expect(l.peekSource(values, exec({}), [{ node: 'n2', output: 'image' }], 'scene1')).toBeDefined()
  })

  it('a TRANSIENT failure stays retryable', async () => {
    const l = loader()
    const s = l.peekSource(values, exec({}), candidates, 'scene1')!
    l.resolve({ key: s.key, load: () => Promise.reject(Object.assign(new Error('net'), { transient: true })) })
    await flush()
    expect(l.peekSource(values, exec({}), candidates, 'scene1')).toBeDefined()
  })

  it.each([undefined, 'PQ to sRGB'])('fetches and decodes a declared PNG with server color conversion %s', async (colorTransform) => {
    const urls: string[] = []
    const fetchFn: FetchLike = async (url) => {
      urls.push(url)
      const rendition = new URL(url).searchParams.get('rendition')
      if (rendition === null) {
        return new Response(JSON.stringify({
          available: true,
          descriptor: { typeId: 'comfy.IMAGE', fingerprint: 'fp-image' },
          renditions: [{ kind: 'png', mime: 'image/png', default: true }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'X-Dinkster-Type-Id': 'comfy.IMAGE',
          'X-Dinkster-Fingerprint': 'fp-image',
          'X-Dinkster-Rendition': 'png',
          ...(colorTransform === undefined ? {} : { 'X-Dinkster-Color-Transform': colorTransform }),
        },
      })
    }
    const valuesClient = new DinksterValuesClient({ baseUrl: 'http://backend', clientId: 'client-1', fetchFn })
    const bitmap = { width: 64, height: 48 }
    const decode = vi.fn(async () => bitmap)
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:image')
    vi.stubGlobal('createImageBitmap', decode)
    try {
      const source = loader().peekSource(valuesClient, exec({}), candidates, 'scene1')
      expect(source).toBeDefined()
      await expect(source!.load()).resolves.toEqual({
        image: bitmap,
        src: 'blob:image',
        download: { src: 'blob:image', name: 'image.png' },
        width: 64,
        height: 48,
        ...(colorTransform === undefined ? {} : { colorTransform }),
      })
      expect(urls.map((url) => new URL(url).searchParams.get('rendition'))).toEqual([null, 'png'])
      expect(new URL(urls[0]!).searchParams.get('jobId')).toBe('p1')
      expect(new URL(urls[0]!).searchParams.get('nodeId')).toBe('n1')
      expect(new URL(urls[0]!).searchParams.get('outputId')).toBe('image')
      expect(decode).toHaveBeenCalledTimes(1)
    } finally {
      create.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it.each([
    ['video/mp4', 'video'],
    ['video/webm', 'video'],
    ['audio/wav', 'audio'],
  ] as const)('discriminates %s bytes without feeding them to image decode', async (mime, kind) => {
    const renditionKind = kind === 'video' ? 'preview' : kind
    const valuesClient = new DinksterValuesClient({
      baseUrl: 'http://backend', clientId: 'client-1', fetchFn: async (url) =>
        new URL(url).searchParams.has('rendition')
          ? new Response(bytesOfMedia(mime).buffer as ArrayBuffer, { status: 200, headers: { 'Content-Type': mime, 'X-Dinkster-Fingerprint': 'fp', 'X-Dinkster-Rendition': renditionKind } })
          : new Response(JSON.stringify({ available: true, descriptor: { typeId: `comfy.${kind.toUpperCase()}`, fingerprint: 'fp' }, renditions: [{ kind: renditionKind, mime, default: true }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    })
    const decode = vi.fn()
    vi.stubGlobal('createImageBitmap', decode)
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue(`blob:${kind}`)
    try {
      const source = loader().peekSource(valuesClient, exec({}), candidates, 'scene1')!
      const loaded = await source.load()
      if (kind === 'audio') {
        expect(loaded).toMatchObject({ kind: 'audio', src: '', audio: { meta: {} } })
        expect(loaded.audio?.load).toBeTypeOf('function')
      } else expect(loaded).toMatchObject({ kind, src: `blob:${kind}`, mime })
      expect(loaded.download?.previewOnly).toBe(kind === 'video' ? true : undefined)
      expect(decode).not.toHaveBeenCalled()
      expect(create).toHaveBeenCalledTimes(kind === 'audio' ? 0 : 1)
    } finally {
      create.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('revokes cached media object URLs when the preview loader is disposed', async () => {
    const valuesClient = new DinksterValuesClient({
      baseUrl: 'http://backend', clientId: 'client-1', fetchFn: async (url) =>
        new URL(url).searchParams.has('rendition')
          ? new Response(bytesOfMedia().buffer as ArrayBuffer, { status: 200, headers: { 'Content-Type': 'video/mp4', 'X-Dinkster-Fingerprint': 'fp', 'X-Dinkster-Rendition': 'preview' } })
          : new Response(JSON.stringify({ available: true, descriptor: { typeId: 'comfy.VIDEO', fingerprint: 'fp' }, renditions: [{ kind: 'preview', mime: 'video/mp4', default: true }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    })
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:dispose-proof')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.stubGlobal('ImageBitmap', class {})
    try {
      const l = loader()
      l.resolve(l.peekSource(valuesClient, exec({}), candidates, 'scene1')!)
      await flush()
      expect(l.resolve(l.peekSource(valuesClient, exec({}), candidates, 'scene1')!)).toMatchObject({ src: 'blob:dispose-proof' })
      l.dispose()
      expect(revoke).toHaveBeenCalledWith('blob:dispose-proof')
    } finally {
      create.mockRestore()
      revoke.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('a comfy.IMAGE with no declared rendition stays previewless but retryable', async () => {
    const fetchFn = vi.fn<FetchLike>(async () => new Response(JSON.stringify({
      available: true,
      descriptor: { typeId: 'comfy.IMAGE', fingerprint: 'fp-image' },
      renditions: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const valuesClient = new DinksterValuesClient({ baseUrl: 'http://backend', clientId: 'client-1', fetchFn })
    const l = loader()
    const source = l.peekSource(valuesClient, exec({}), candidates, 'scene1')!
    l.resolve(source)
    await flush()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const retry = l.peekSource(valuesClient, exec({}), candidates, 'scene1')!
    expect(l.unavailable!(retry)).toBe(false)
    expect(l.resolve(retry)).toBeUndefined()
    await flush()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})

describe('resolveFrame', () => {
  it('kicks one decode per key, caches the bitmap, and fires onDecoded', async () => {
    const bitmap = { width: 8, height: 6 }
    const decode = vi.fn(async () => bitmap)
    vi.stubGlobal('createImageBitmap', decode)
    try {
      const onDecoded = vi.fn()
      const l = loader({ onDecoded })
      const payload = new Blob(['frame'])
      expect(l.resolveFrame!('frame:k1:n1:ring:0:1', payload)).toBeUndefined() // kick
      expect(l.resolveFrame!('frame:k1:n1:ring:0:1', payload)).toBeUndefined() // deduped while pending
      await flush()
      expect(decode).toHaveBeenCalledTimes(1)
      expect(onDecoded).toHaveBeenCalledTimes(1)
      expect(l.resolveFrame!('frame:k1:n1:ring:0:1', payload)).toBe(bitmap)
      expect(decode).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('an undecodable frame is dropped silently and stays retryable', async () => {
    const decode = vi.fn(() => Promise.reject(new Error('bad frame')))
    vi.stubGlobal('createImageBitmap', decode)
    try {
      const l = loader()
      const payload = new Blob(['x'])
      l.resolveFrame!('frame:k1:n1:ring:0:2', payload)
      await flush()
      expect(l.resolveFrame!('frame:k1:n1:ring:0:2', payload)).toBeUndefined()
      await flush()
      expect(decode).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('deriveNodePreviewSurface frame-ring animation', () => {
  const surfaceArgs = (e: ExecutionState, l: ReturnType<typeof loader>, running = true) => ({
    nodeId: 'n1',
    isSubgraph: false,
    schema: undefined,
    exec: e,
    runtimeIds: ['n1'],
    runtimeIdsOf: undefined,
    running,
    frozen: false,
    exactProducer: undefined,
    companionSources: new Map(),
    values: undefined,
    selectedAsset: undefined,
    loader: l,
    outputKey: 'n1',
  })

  const ringExec = (rings: Record<string, unknown> | undefined, latest: Blob): ExecutionState =>
    ({
      ...exec({ previews: { n1: { payload: latest, timestamp: 5 } } }),
      ...(rings === undefined
        ? {}
        : {
            previewRings: Object.fromEntries(
              Object.entries(rings).map(([id, ring]) => [id, { '': ring }]),
            ),
          }),
    }) as unknown as ExecutionState

  it('attaches the decoded ring as animation on a running node', async () => {
    const bitmap = { width: 8, height: 6 }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
    try {
      const blob0 = new Blob(['f0'])
      const blob2 = new Blob(['f2'])
      const e = ringExec({
        n1: {
          frameCount: 3,
          fps: 16,
          frames: {
            0: { payload: blob0, timestamp: 4, frameIndex: 0, frameCount: 3 },
            2: { payload: blob2, timestamp: 5, frameIndex: 2, frameCount: 3 },
          },
        },
      }, blob2)
      const l = loader()
      const first = deriveNodePreviewSurface(surfaceArgs(e, l))
      // First pass kicks the slot decodes; the ring shape is already there.
      expect(first.preview?.animation?.frames).toEqual([undefined, undefined, undefined])
      await flush()
      const second = deriveNodePreviewSurface(surfaceArgs(e, l))
      expect(second.preview?.animation?.fps).toBe(16)
      expect(second.preview?.animation?.frames).toEqual([bitmap, undefined, bitmap])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('no animation without a ring, and none for a single-frame ring', () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1 })))
    try {
      const l = loader()
      const still = ringExec(undefined, new Blob(['s']))
      expect(deriveNodePreviewSurface(surfaceArgs(still, l)).preview?.animation).toBeUndefined()
      const single = ringExec({
        n1: { frameCount: 1, fps: 16, frames: { 0: { payload: new Blob(['s']), timestamp: 5 } } },
      }, new Blob(['s']))
      expect(deriveNodePreviewSurface(surfaceArgs(single, l)).preview?.animation).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('an absurd frameCount never allocates a frames array', () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1 })))
    try {
      const l = loader()
      const huge = ringExec({
        n1: {
          frameCount: Number.MAX_SAFE_INTEGER,
          fps: 16,
          frames: { 0: { payload: new Blob(['s']), timestamp: 5 } },
        },
      }, new Blob(['s']))
      expect(deriveNodePreviewSurface(surfaceArgs(huge, l)).preview?.animation).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

const bytesOfMedia = (mime = 'video/mp4'): Uint8Array => mime === 'video/mp4'
  ? new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70])
  : mime === 'video/webm'
    ? new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])
    : new TextEncoder().encode('RIFF0000WAVE')

describe('selectedPreviewAssetForRows', () => {
  const assetValue = (mediaType: string) => ({
    digest: `blake3:${'a'.repeat(64)}`,
    name: 'stored.bin',
    size: 42,
    mediaType,
    virtualPath: `input/stored.bin`,
  })
  const rows = [{ widgetType: 'ASSET', valueKey: 'v' }]
  const rendererFor = (kinds: Record<string, 'image' | 'video' | 'model3d'>) =>
    ((mediaType: string) => {
      const mediaKind = kinds[mediaType]
      return mediaKind === undefined ? undefined : { mediaKind }
    }) as Parameters<typeof selectedPreviewAssetForRows>[2]

  it('claims a GLB asset for a registered model3d renderer', () => {
    const got = selectedPreviewAssetForRows(
      { v: assetValue('model/gltf-binary') },
      rows,
      rendererFor({ 'model/gltf-binary': 'model3d' }),
    )
    expect(got).toMatchObject({ mediaType: 'model/gltf-binary', mediaKind: 'model3d', count: 1 })
  })

  it('rejects a model3d claim whose mediaType is outside the model/ family', () => {
    expect(selectedPreviewAssetForRows(
      { v: assetValue('application/octet-stream') },
      rows,
      rendererFor({ 'application/octet-stream': 'model3d' }),
    )).toBeUndefined()
  })
})

describe('represented asset source precedence', () => {
  const representedAsset = {
    digest: `blake3:${'a'.repeat(64)}`,
    name: 'image.png',
    count: 1,
    mediaType: 'image/png',
    mediaKind: 'image' as const,
    outputId: 'image',
  }
  const selectedSource: PreviewSource = {
    key: `asset:${representedAsset.digest}`,
    load: () => Promise.reject(new Error('unused')),
  }
  const currentSource: PreviewSource = {
    key: 'execution:current',
    runtimeId: 'current',
    outputId: 'image',
    load: () => Promise.reject(new Error('unused')),
  }
  const retainedSource: PreviewSource = {
    key: 'execution:retained',
    runtimeId: 'retained',
    outputId: 'image',
    load: () => Promise.reject(new Error('unused')),
  }
  const decoded = { image: {} as CanvasImageSource, width: 4, height: 3 }
  const previewLoader = (): PreviewLoader => ({
    sourceFor: (_exec, runtimeIds) =>
      runtimeIds.includes('current')
        ? currentSource
        : runtimeIds.includes('retained')
          ? retainedSource
          : undefined,
    inputAssetSource: () => selectedSource,
    peekSource: () => undefined,
    resolve: () => decoded,
  })
  const args = (runtimeIds: readonly string[], retainedRuntimeIds?: ReadonlySet<string>) => ({
    nodeId: 'loader',
    isSubgraph: false,
    schema: undefined,
    exec: exec({}),
    runtimeIds,
    runtimeIdsOf: undefined,
    running: false,
    frozen: false,
    exactProducer: undefined,
    ...(retainedRuntimeIds === undefined ? {} : { retainedRuntimeIds }),
    companionSources: new Map(),
    values: undefined,
    selectedAsset: representedAsset,
    loader: previewLoader(),
    outputKey: 'loader',
  })

  it('authoritative current execution imagery wins over the representation', () => {
    const surface = deriveNodePreviewSurface(args(['current']))
    expect(surface.preview).toEqual(decoded)
    expect(surface.source).toBe(currentSource)
  })

  it('the current representation replaces retained cached imagery', () => {
    const surface = deriveNodePreviewSurface(args(['retained'], new Set(['retained'])))
    expect(surface.preview).toEqual({ ...decoded, count: 1, state: 'estimate' })
    expect(surface.source).toMatchObject({ key: selectedSource.key, outputId: 'image' })
    expect(surface.executedOutput).toBeUndefined()
  })
})
