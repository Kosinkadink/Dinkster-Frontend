import { createSignal } from '@dinkster/core'
import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppState, ImageEditorTarget, Tab } from '../src/app-state.js'
import { ImageEditor } from '../src/ImageEditor.js'
import { encodePng } from '../src/image-png.js'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each(['close', 'replace', 'tab', 'dispose'] as const)('settles obsolete mask source bodies on %s without cancelling a replacement', async (action) => {
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
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => ({
    ok: true, status: 200, arrayBuffer: () => new Promise<ArrayBuffer>((resolve, reject) => {
      activeBodies++
      let settled = false
      const settle = () => { if (!settled) { settled = true; activeBodies-- } }
      reads.push({ url: String(url), signal: init?.signal, finish: (bytes) => { settle(); resolve(bytes) } })
      init?.signal?.addEventListener('abort', () => { settle(); reject(init.signal!.reason) }, { once: true })
    }),
  }) as Response)
  const app = {
    imageEditorTarget, activeTabId, tabs: createSignal([{ id: 'first' } as Tab]),
    backendForTab: () => ({ protocol: 'dinkster', connection: { assetUrl: (digest: string) => `/api/assets/${digest}` } }),
    closeImageEditor: () => imageEditorTarget.set(undefined), retainEditorAssets: async () => {},
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
    else if (action === 'tab') activeTabId.set('second')
    else dispose()
    expect(reads[0]!.signal?.aborted).toBe(true)
    if (action === 'replace') {
      await vi.waitFor(() => expect(reads).toHaveLength(2))
      expect(activeBodies).toBe(1)
      expect(reads[1]!.signal?.aborted).toBe(false)
      const bytes = await encodePng(2, 1, new Uint8ClampedArray([1, 7, 3, 255, 4, 8, 2, 0]))
      reads[1]!.finish(new Uint8Array(bytes).buffer)
      await vi.waitFor(() => expect(apply()?.disabled).toBe(false))
      expect(root.querySelector('small')?.textContent).toBe('new.png')
      expect(root.querySelector('canvas')?.width).toBe(2)
      expect(root.querySelector('canvas')?.height).toBe(1)
    }
    expect(activeBodies).toBe(0)
    expect(root.querySelector('[role="alert"]')).toBeNull()
    expect(reads.map((read) => read.url)).toEqual(action === 'replace'
      ? [`/api/assets/${source.digest}`, `/api/assets/${next.sourceRef.digest}`] : [`/api/assets/${source.digest}`])
  } finally { for (const read of reads) read.finish(new ArrayBuffer(0)); dispose() }
})
