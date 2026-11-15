import { createSignal } from '@dinkster/core'
import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppState, ImageEditorTarget, Tab } from '../src/app-state.js'
import { ImageEditor } from '../src/ImageEditor.js'
import { encodePng } from '../src/image-png.js'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each(['accepted', 'refused', 'close', 'session', 'owner', 'dispose'] as const)('waits for independent mask session ownership before publishing decoded pixels: %s', async (action) => {
  vi.stubGlobal('ImageData', class {
    constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
  })
  const draw = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData: draw } as unknown as CanvasRenderingContext2D)
  const source = { digest: `blake3:${'a'.repeat(64)}`, name: 'owned.png', size: 3, mediaType: 'image/png', virtualPath: '' }
  const target: ImageEditorTarget = { tabId: 'first', graphId: 'g0', nodeId: 'n0', inputId: 'image', sourceRef: source }
  const imageEditorTarget = createSignal<ImageEditorTarget | undefined>(target)
  let admit!: () => void
  const admission = new Promise<void>((resolve) => { admit = resolve })
  let ownerCurrent = true
  const retainEditorAssets = vi.fn(async (_target: unknown, _backend: unknown, _value: unknown, publish: () => boolean) => {
    await admission
    if (action === 'refused') throw new Error('Editor ownership refused')
    publish()
  })
  const bytes = await encodePng(2, 1, new Uint8ClampedArray([1, 7, 3, 255, 4, 8, 2, 0]))
  const app = {
    imageEditorTarget, activeTabId: createSignal('first'), tabs: createSignal([{ id: 'first', store: {} } as Tab]),
    backendForTab: () => ({ protocol: 'dinkster', connection: { fetchAssetBytes: async () => new Uint8Array(bytes).buffer } }),
    closeImageEditor: () => imageEditorTarget.set(undefined), retainEditorAssets,
    workflowAssetReader: () => ({ current: () => ownerCurrent, read: async <T,>(consume: () => Promise<T>) => consume() }),
  } as unknown as AppState
  const root = document.createElement('div'); document.body.append(root)
  const dispose = render(() => <ImageEditor app={app} />, root)
  const apply = () => Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Bake to asset')
  try {
    await vi.waitFor(() => expect(retainEditorAssets).toHaveBeenCalledTimes(1))
    expect(draw).not.toHaveBeenCalled()
    expect(apply()?.disabled).toBe(true)
    if (action === 'close') imageEditorTarget.set(undefined)
    if (action === 'session') app.tabs.set([])
    if (action === 'owner') ownerCurrent = false
    if (action === 'dispose') dispose()
    admit()
    await vi.waitFor(() => expect(retainEditorAssets.mock.settledResults[0]?.type).toBe(action === 'refused' ? 'rejected' : 'fulfilled'))
    if (action === 'accepted') {
      await vi.waitFor(() => expect(apply()?.disabled).toBe(false))
      expect(root.querySelector('canvas')?.width).toBe(2)
      expect(root.querySelector('canvas')?.height).toBe(1)
      expect(draw).toHaveBeenCalled()
    } else {
      expect(draw).not.toHaveBeenCalled()
      expect(apply()?.disabled ?? true).toBe(true)
    }
    if (action === 'refused') expect(root.querySelector('[role="alert"]')?.textContent).toContain('Editor ownership refused')
  } finally { admit(); dispose() }
})

it.each(['close', 'replace', 'session', 'tab', 'dispose'] as const)('settles obsolete mask source bodies on %s without cancelling a replacement', async (action) => {
  vi.stubGlobal('ImageData', class {
    constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    putImageData() {},
  } as unknown as CanvasRenderingContext2D)
  const source = { digest: `blake3:${'a'.repeat(64)}`, name: 'old.png', size: 3, mediaType: 'image/png', virtualPath: '' }
  const first: ImageEditorTarget = { tabId: 'first', graphId: 'g0', nodeId: 'n0', inputId: 'image', sourceRef: source }
  const next: ImageEditorTarget = { ...first, sourceRef: { ...source, digest: `blake3:${'b'.repeat(64)}`, name: 'new.png' } }
  const imageEditorTarget = createSignal<ImageEditorTarget | undefined>(first)
  const activeTabId = createSignal('first')
  let activeBodies = 0
  const reads: { url: string; signal: AbortSignal | null | undefined; finish: (bytes: ArrayBuffer) => void }[] = []
  const fetchAssetBytes = async (digest: string, signal?: AbortSignal) => new Promise<ArrayBuffer>((resolve, reject) => {
    activeBodies++
    let settled = false
    const settle = () => { if (!settled) { settled = true; activeBodies-- } }
    reads.push({ url: `/api/assets/${digest}`, signal, finish: (bytes) => { settle(); resolve(bytes) } })
    signal?.addEventListener('abort', () => { settle(); reject(signal.reason) }, { once: true })
  })
  const app = {
    imageEditorTarget, activeTabId, tabs: createSignal([{ id: 'first', store: {} } as Tab]),
    backendForTab: () => ({ protocol: 'dinkster', connection: { fetchAssetBytes } }),
    closeImageEditor: () => imageEditorTarget.set(undefined),
    retainEditorAssets: async (_target: unknown, _backend: unknown, _value: unknown, publish: () => boolean) => { publish() },
    workflowAssetReader: () => ({ current: () => true, read: async <T,>(consume: () => Promise<T>) => consume() }),
  } as unknown as AppState
  const root = document.createElement('div'); document.body.append(root)
  const dispose = render(() => <ImageEditor app={app} />, root)
  const apply = () => Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Bake to asset')
  try {
    await vi.waitFor(() => expect(reads).toHaveLength(1))
    expect(activeBodies).toBe(1)
    expect(apply()?.disabled).toBe(true)
    if (action === 'close') Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Cancel')!.click()
    else if (action === 'replace') imageEditorTarget.set(next)
    else if (action === 'session') app.tabs.update((tabs) => tabs.map((tab) => ({ ...tab, store: {} as Tab['store'] })))
    else if (action === 'tab') activeTabId.set('second')
    else dispose()
    expect(reads[0]!.signal?.aborted).toBe(true)
    if (action === 'replace' || action === 'session') {
      await vi.waitFor(() => expect(reads).toHaveLength(2))
      expect(activeBodies).toBe(1)
      expect(reads[1]!.signal?.aborted).toBe(false)
      const bytes = await encodePng(2, 1, new Uint8ClampedArray([1, 7, 3, 255, 4, 8, 2, 0]))
      reads[1]!.finish(new Uint8Array(bytes).buffer)
      await vi.waitFor(() => expect(apply()?.disabled).toBe(false))
      expect(root.querySelector('small')?.textContent).toBe(action === 'replace' ? 'new.png' : 'old.png')
      expect(root.querySelector('canvas')?.width).toBe(2)
      expect(root.querySelector('canvas')?.height).toBe(1)
      app.tabs.update((tabs) => tabs.map((tab) => ({ ...tab, title: 'Renamed' })))
      expect(apply()?.disabled).toBe(false)
      Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Invert')!.click()
      app.tabs.update((tabs) => tabs.map((tab) => ({ ...tab, store: {} as Tab['store'] })))
      expect(apply()?.disabled).toBe(false)
      expect(Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Undo mask edit')!.disabled).toBe(false)
    }
    expect(activeBodies).toBe(0)
    expect(root.querySelector('[role="alert"]')).toBeNull()
    expect(reads.map((read) => read.url)).toEqual(action === 'replace' || action === 'session'
      ? [`/api/assets/${source.digest}`, `/api/assets/${action === 'replace' ? next.sourceRef.digest : source.digest}`] : [`/api/assets/${source.digest}`])
  } finally { for (const read of reads) read.finish(new ArrayBuffer(0)); dispose() }
})
