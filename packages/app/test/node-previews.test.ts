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
import { createPreviewLoader, deriveNodePreviewSurface, type PreviewLoader, type PreviewSource } from '../src/node-previews.js'

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
    assetUrlForExecution: (_ref, digest) => `http://backend/api/assets/${digest}`,
    assetUrlForInput: (digest) => `http://backend/api/assets/${digest}`,
    fetchRecordedOutput: async () => new Response(new Uint8Array([1, 2, 3])),
    onDecoded: over?.onDecoded ?? (() => {}),
    ...(over?.renderModel3dPoster !== undefined ? { renderModel3dPoster: over.renderModel3dPoster } : {}),
  })

const preview = (): NodePreview => ({ image: {} as CanvasImageSource, width: 1, height: 1 })

const flush = () => new Promise((r) => setTimeout(r, 0))

const outputImage = (name: string) => ({
  typeId: 'ASSET', fingerprint: `blake3:${'d'.repeat(64)}`,
  meta: { digest: `blake3:${'d'.repeat(64)}`, mediaType: 'image/png', name },
})

describe('sourceFor', () => {

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
      outputs: { n1: { images: outputImage('out.png') } },
    })
    expect(loader().sourceFor(e, ['n1'], true)?.key).toMatch(/^frame:k1:n1:5:\d+$/)
  })

  it('a finished node prefers the output image, routed through the execution backend', () => {
    const e = exec({
      previews: { n1: { payload: new Blob(['f']), timestamp: 5 } },
      outputs: { n1: { images: outputImage('out.png') } },
    })
    expect(loader().sourceFor(e, ['n1'], false)?.key).toContain(`http://backend/api/assets/blake3:${'d'.repeat(64)}`)
  })

  it('selects any finished output page and carries its real index/count', () => {
    const e = exec({
      outputs: { n1: { images: { typeId: 'list<ASSET>', elements: ['first.png', 'second.png', 'third.png'].map(outputImage) } } },
    })
    const source = loader().sourceFor(e, ['n1'], false, 1)
    expect(source?.key).toContain('second.png')
    expect(source?.output).toEqual({ index: 1, count: 3 })
  })

  it('clamps a stale finished output page when the inventory shrinks', () => {
    const e = exec({ outputs: { n1: { images: outputImage('only.png') } } })
    const source = loader().sourceFor(e, ['n1'], false, 7)
    expect(source?.key).toContain('only.png')
    expect(source?.output).toEqual({ index: 0, count: 1 })
  })

  it('falls back to the last frame when no output image exists', () => {
    const e = exec({ previews: { n1: { payload: new Blob(['f']), timestamp: 5 } } })
    expect(loader().sourceFor(e, ['n1'], false)?.key).toMatch(/^frame:k1:n1:5:\d+$/)
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

  it('displays an associated image without fetching the original and downloads the saved file explicitly', async () => {
    const originalDigest = `blake3:${'5'.repeat(64)}`
    const previewDigest = `blake3:${'6'.repeat(64)}`
    const fetchRecordedOutput = vi.fn(async () => new Response(new Uint8Array([7, 8, 9])))
    class FakeImage {
      src = ''
      naturalWidth = 12
      naturalHeight = 8
      decode = async () => {}
    }
    vi.stubGlobal('Image', FakeImage)
    try {
      const l = createPreviewLoader({
        assetUrlForInput: () => '', onDecoded: () => {},
        assetUrlForExecution: (_ref, digest) => `http://backend/api/assets/${digest}`,
        fetchRecordedOutput,
      })
      const artifacts = Array.from({ length: 65 }, (_, index) => ({
        nodeId: 'save', digest: originalDigest, name: `frame-${index}.exr`, size: 2048,
        mediaType: 'image/x-exr', virtualPath: `mounts/output/frame-${index}.exr`,
        preview: { digest: previewDigest, name: 'preview.webp', size: 32, mediaType: 'image/webp', virtualPath: `previews/${'6'.repeat(64)}/preview.webp` },
      }))
      const source = l.sourceFor(exec({ artifacts }), ['save'], false, 64)!
      expect(source.output).toEqual({ index: 64, count: 65 })
      const loaded = await source.load()
      expect(loaded.image).toBeInstanceOf(FakeImage)
      expect(loaded).toMatchObject({ width: 12, height: 8 })
      expect(fetchRecordedOutput).toHaveBeenCalledExactlyOnceWith(`http://backend/api/assets/${previewDigest}`, undefined)
      expect(loaded.download).toMatchObject({ src: `http://backend/api/assets/${originalDigest}`, name: 'frame-64.exr' })
      expect(loaded.download?.previewOnly).toBeUndefined()
      const signal = new AbortController().signal
      const blob = await loaded.download!.load!(signal)
      expect(fetchRecordedOutput).toHaveBeenLastCalledWith(`http://backend/api/assets/${originalDigest}`, { signal })
      expect(blob.type).toBe('image/x-exr')
      expect(source.key).not.toBe(l.sourceFor(exec({ artifacts }), ['save'], false, 63)!.key)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('preserves the original download when an optional associated preview fails', async () => {
    const fetchRecordedOutput = vi.fn(async () => new Response('', { status: 404 }))
    const l = createPreviewLoader({
      assetUrlForInput: () => '', onDecoded: () => {},
      assetUrlForExecution: (_ref, digest) => `http://backend/api/assets/${digest}`,
      fetchRecordedOutput,
    })
    const loaded = await l.sourceFor(exec({ artifacts: [{
      nodeId: 'save', digest: `blake3:${'7'.repeat(64)}`, name: 'original.exr', size: 123,
      mediaType: 'image/x-exr', virtualPath: 'mounts/output/original.exr',
      preview: { digest: `blake3:${'8'.repeat(64)}`, name: 'preview.jpg', size: 24, mediaType: 'image/jpeg', virtualPath: `previews/${'8'.repeat(64)}/preview.jpg` },
    }] }), ['save'], false)!.load()
    expect(loaded).toMatchObject({ status: 'failed', statusMessage: 'Preview unavailable', download: { src: `http://backend/api/assets/blake3:${'7'.repeat(64)}`, name: 'original.exr' } })
    expect(fetchRecordedOutput).toHaveBeenCalledExactlyOnceWith(`http://backend/api/assets/blake3:${'8'.repeat(64)}`, undefined)
  })

  it('fetches cross-origin recorded audio only for an explicit download and sanitizes the filename', async () => {
    const digest = `blake3:${'4'.repeat(64)}`
    const url = `https://outputs.example/api/assets/${digest}`
    const fetchRecordedOutput = vi.fn(async () => new Response(new Uint8Array([7, 8, 9])))
    const l = createPreviewLoader({
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
      outputs: { save: { images: outputImage('pass-through.png') } },
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
      key: expect.stringContaining(`http://backend/api/assets/blake3:${'d'.repeat(64)}`),
      runtimeId: 'save',
    })
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

  it('a TRANSIENT failure stays retryable', async () => {
    const l = loader()
    const s = l.peekSource(values, exec({}), candidates, 'scene1')!
    l.resolve({ key: s.key, load: () => Promise.reject(Object.assign(new Error('net'), { transient: true })) })
    await flush()
    expect(l.peekSource(values, exec({}), candidates, 'scene1')).toBeDefined()
  })

  it.each([409, 404] as const)('retries a temporarily unavailable preferred output but keeps a permanent fallback: %s', async (status) => {
    let published = false
    const requests: string[] = []
    const values = new DinksterValuesClient({ baseUrl: 'http://backend', clientId: 'client', fetchFn: async (url) => {
      const query = new URL(url).searchParams
      const output = query.get('outputId')!
      requests.push(output)
      if (output === 'IMAGE' && !published) return new Response(JSON.stringify({
        available: false, reason: status === 409 ? 'not-complete' : 'not-retained', error: 'unavailable',
      }), { status, headers: { 'Content-Type': 'application/json' } })
      if (!query.has('rendition')) return new Response(JSON.stringify({
        available: true, descriptor: { typeId: output, fingerprint: output },
        renditions: [{ kind: 'png', mime: 'image/png', default: true }],
      }), { headers: { 'Content-Type': 'application/json' } })
      return new Response(new Uint8Array([output === 'IMAGE' ? 48 : 64]), { headers: {
        'Content-Type': 'image/png', 'X-Dinkster-Fingerprint': output, 'X-Dinkster-Rendition': 'png',
      } })
    } })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preferred')
    vi.stubGlobal('createImageBitmap', async (blob: Blob) => ({ width: 64, height: new Uint8Array(await blob.arrayBuffer())[0] }))
    const l = loader()
    const source = l.peekSource(values, exec({}), [
      { node: 'producer', output: 'IMAGE' }, { node: 'producer', output: 'MASK' },
    ], 'scene')!
    try {
      l.resolve(source)
      await vi.waitFor(() => expect(requests).toContain('IMAGE'))
      await flush()
      published = true
      await vi.waitFor(() => expect(l.resolve(source)).toMatchObject({ width: 64, height: status === 409 ? 48 : 64 }))
      expect(requests.every((output) => output === 'IMAGE' || output === 'MASK')).toBe(true)
    } finally { l.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() }
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
          : new Response(JSON.stringify({ available: true, descriptor: { typeId: kind.toUpperCase(), fingerprint: 'fp' }, renditions: [{ kind: renditionKind, mime, default: true }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
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

  it('keeps completed native imagery authoritative over a late frame, but shows running and frame-only previews', async () => {
    const frame = new Blob(['late-frame'])
    const frameBitmap = { width: 3, height: 2 }
    const outputBitmap = { width: 64, height: 48 }
    vi.stubGlobal('createImageBitmap', vi.fn(async (blob: Blob) => blob === frame ? frameBitmap : outputBitmap))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:native-output')
    const values = new DinksterValuesClient({ baseUrl: 'http://owner', clientId: 'client', fetchFn: async (url) =>
      new URL(url).searchParams.has('rendition')
        ? new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'image/png' } })
        : Response.json({ available: true, descriptor: { typeId: 'IMAGE', fingerprint: 'native-image' }, renditions: [{ kind: 'png', mime: 'image/png', default: true }] }),
    })
    const l = loader()
    const e = { ...exec({ previews: { n1: { payload: frame, timestamp: 5 } }, outputs: { n1: { IMAGE: { typeId: 'IMAGE', fingerprint: 'native-image' } } } }), nodes: {} }
    const args = { ...surfaceArgs(e, l, false), values, runtimeIdsOf: () => ['n1'] }
    try {
      deriveNodePreviewSurface(args)
      await flush(); await flush()
      expect(deriveNodePreviewSurface(args).preview).toMatchObject(outputBitmap)
      expect(deriveNodePreviewSurface(args).source).toMatchObject({ runtimeId: 'n1', outputId: 'IMAGE' })
      expect(deriveNodePreviewSurface(args).preview).toMatchObject({ ...outputBitmap, state: 'cached' })
      const edited = { ...args, exactProducer: () => false }
      expect(deriveNodePreviewSurface(edited).preview).toMatchObject({ ...outputBitmap, state: 'cached' })
      expect(deriveNodePreviewSurface({ ...edited, frozen: true }).preview).not.toHaveProperty('state')
      expect(deriveNodePreviewSurface({ ...args, frozen: true }).preview).not.toHaveProperty('state')
      expect(deriveNodePreviewSurface({ ...args, exactProducer: () => true }).preview).not.toHaveProperty('state')
      deriveNodePreviewSurface({ ...args, running: true })
      await flush()
      expect(deriveNodePreviewSurface({ ...args, running: true }).preview).toMatchObject(frameBitmap)
      expect(deriveNodePreviewSurface({ ...args, running: true }).preview).not.toHaveProperty('state')
      expect(deriveNodePreviewSurface({ ...args, exec: { ...e, outputs: {} } }).preview).toMatchObject(frameBitmap)
      const partial = {
        ...args, retainedRuntimeIds: new Set(['n1']),
        exec: { ...e, key: 'partial-run', ref: { ...e.ref, prompt: asPromptId('partial-job') } },
      }
      deriveNodePreviewSurface(partial)
      await flush(); await flush()
      expect(deriveNodePreviewSurface(partial).preview).toMatchObject({ ...frameBitmap, state: 'cached' })
    } finally {
      l.dispose()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
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
    exactProducer: () => true,
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
