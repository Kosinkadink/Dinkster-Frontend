import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExecutedImageViewer, executionOutputProvenance } from '../src/ExecutedImageViewer.js'
import type { ExecutedImage } from '../src/executed-image-inventory.js'

beforeEach(() => {
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  })
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  })
})

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const images: ExecutedImage[] = [
  { key: 'a', runtimeId: 'node-1', outputId: 'images', descriptorIndex: 0, url: '/a.png', name: 'a.png', kind: 'v1', mediaType: 'image (legacy descriptor)', subfolder: 'long/output/path', fileType: 'output' },
  { key: 'b', runtimeId: 'node-2', outputId: 'image', descriptorIndex: 0, url: '/b.png', digest: `blake3:${'b'.repeat(64)}`, virtualPath: 'mounts/output/ComfyUI_00001.png', kind: 'asset', mediaType: 'image/png' },
]

const provenance = {
  backendId: 'backend-with-a-complete-identity', backendLabel: 'Removed render backend', backendAvailable: false,
  executionId: 'execution-with-a-complete-identity', executionStatus: 'Completed',
}

describe('executionOutputProvenance', () => {
  const execution = {
    ref: { connection: 'backend-id', prompt: 'execution-id' },
    status: 'completed',
  } as any

  it('treats a configured but disconnected backend as unavailable', () => {
    const disconnected = executionOutputProvenance(execution, {
      label: 'Configured disconnected owner',
      connection: { status: { get: () => 'disconnected' } },
    })
    expect(disconnected.backendLabel).toBe('Configured disconnected owner')
    expect(disconnected.backendAvailable).toBe(false)

    const connected = executionOutputProvenance(execution, {
      label: 'Connected owner',
      connection: { status: { get: () => 'connected' } },
    })
    expect(connected.backendAvailable).toBe(true)
  })
})

function mount(initialIndex = 0, onReveal?: (image: ExecutedImage) => void) {
  const root = document.createElement('div')
  document.body.append(root)
  const close = vi.fn()
  const dispose = render(() => <ExecutedImageViewer images={images} initialIndex={initialIndex} provenance={provenance} {...(onReveal === undefined ? {} : { onReveal })} onRequestClose={close} />, root)
  return { root, close, dispose }
}

describe('ExecutedImageViewer', () => {
  it('pages in single mode by buttons and Arrow keys with truthful position labels', () => {
    const mounted = mount()
    expect(mounted.root.querySelector('[data-testid="output-viewer-position"]')?.textContent).toBe('1 / 2')
    const next = mounted.root.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!
    next.click()
    expect(mounted.root.querySelector('[data-testid="output-viewer-position"]')?.textContent).toBe('2 / 2')
    expect(mounted.root.querySelector('img')?.getAttribute('alt')).toContain('Image 2 of 2, node node-2, output image, descriptor 1')
    mounted.root.querySelector('dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(mounted.root.querySelector('[data-testid="output-viewer-position"]')?.textContent).toBe('1 / 2')
    mounted.dispose()
  })

  it('switches grid/single modes, selects a thumbnail, and exposes fit/100/zoom controls', () => {
    const mounted = mount(1)
    mounted.root.querySelector<HTMLButtonElement>('[aria-label="Show all images"]')!.click()
    expect(mounted.root.querySelectorAll('[data-testid="output-viewer-grid"] button')).toHaveLength(2)
    expect(mounted.root.querySelectorAll('[data-testid="output-viewer-grid"] button')[1]?.getAttribute('aria-pressed')).toBe('true')
    mounted.root.querySelector<HTMLButtonElement>('[aria-label*="Image 1 of 2"]')!.click()
    expect(mounted.root.querySelector('[data-testid="output-viewer-position"]')?.textContent).toBe('1 / 2')
    mounted.root.querySelector<HTMLButtonElement>('[aria-label="100%"]')!.click()
    expect(mounted.root.querySelector('[data-testid="output-viewer-image"]')?.getAttribute('data-scale')).toBe('100')
    const image = mounted.root.querySelector<HTMLImageElement>('[data-testid="output-viewer-image"] img')!
    Object.defineProperties(image, { naturalWidth: { value: 640 }, naturalHeight: { value: 480 } })
    image.dispatchEvent(new Event('load'))
    expect(image.style.width).toBe('640px')
    expect(image.style.height).toBe('480px')
    expect(mounted.root.querySelector('.output-facts')?.textContent).toContain('Resolution640 x 480')
    mounted.root.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click()
    expect(mounted.root.querySelector('[data-testid="output-viewer-image"]')?.getAttribute('data-scale')).toBe('125')
    expect(image.style.width).toBe('800px')
    expect(image.style.height).toBe('600px')
    mounted.root.querySelector<HTMLButtonElement>('[aria-label="Fit image"]')!.click()
    expect(mounted.root.querySelector('[data-testid="output-viewer-image"]')?.getAttribute('data-scale')).toBe('fit')
    mounted.dispose()
  })

  it('shows an explicit unavailable state when image decode fails', () => {
    const mounted = mount()
    mounted.root.querySelector('img')!.dispatchEvent(new Event('error'))
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain('Image unavailable')
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain('a.png')
    expect(mounted.root.querySelector('.output-facts')?.textContent).toContain('Unavailable')
    mounted.dispose()
  })

  it('shows complete execution and selected-output provenance without truncating identities', () => {
    const mounted = mount()
    expect(mounted.root.querySelector('[aria-label="Execution provenance"]')?.textContent).toContain(provenance.backendId)
    expect(mounted.root.querySelector('[aria-label="Execution provenance"]')?.textContent).toContain(provenance.executionId)
    expect(mounted.root.querySelector('[aria-label="Execution provenance"] [role="status"]')?.textContent).toContain('removed or disconnected')
    const facts = mounted.root.querySelector('.output-facts')?.textContent ?? ''
    expect(facts).toContain('node-1')
    expect(facts).toContain('images')
    expect(facts).toContain('Legacy output file')
    expect(facts).toContain('long/output/path')
    mounted.root.querySelector('img')!.dispatchEvent(new Event('load'))
    expect(mounted.root.querySelector('.output-facts')?.textContent).toContain('Available')
    mounted.dispose()
  })

  it('shows the mounted path and offers the Desktop reveal action', () => {
    const reveal = vi.fn()
    const mounted = mount(1, reveal)
    expect(mounted.root.querySelector('.output-facts')?.textContent).toContain('mounts/output/ComfyUI_00001.png')
    expect(mounted.root.querySelectorAll('.output-facts wbr')).toHaveLength(2)
    const revealButton = [...mounted.root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Show in folder')
    revealButton!.click()
    expect(reveal).toHaveBeenCalledWith(images[1])
    mounted.dispose()
  })

  it('middle-truncates an asset digest while preserving copy access to the full value', () => {
    const mounted = mount(1)
    const digest = images[1]!.digest!
    const code = mounted.root.querySelector('.output-facts code')!
    expect(code.textContent).toBe(`${digest.slice(0, 12)}...${digest.slice(-8)}`)
    expect(code.getAttribute('title')).toBe(digest)
    expect(mounted.root.querySelector('.output-facts [aria-label="Copy digest"]')).not.toBeNull()
    mounted.dispose()
  })

  it('keeps compare sides independent and leaves range arrow keys with the range input', () => {
    const mounted = mount()
    const button = (text: string) => [...mounted.root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text)!
    button('Compare slider').click()
    mounted.root.querySelector<HTMLButtonElement>('[aria-label="Next left image"]')!.click()
    expect(mounted.root.querySelector<HTMLInputElement>('[aria-label="Left image number"]')!.value).toBe('2')
    expect(mounted.root.querySelector<HTMLInputElement>('[aria-label="Right image number"]')!.value).toBe('2')
    const range = mounted.root.querySelector<HTMLInputElement>('[aria-label="Compare split"]')!
    range.value = '35'; range.dispatchEvent(new Event('input', { bubbles: true }))
    expect(mounted.root.querySelector<HTMLElement>('figure')!.style.clipPath).toBe('inset(0 65% 0 0)')
    range.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(mounted.root.querySelector<HTMLInputElement>('[aria-label="Left image number"]')!.value).toBe('2')
    button('Side by side').click()
    mounted.root.querySelector<HTMLButtonElement>('[aria-label="Previous right image"]')!.click()
    expect(mounted.root.querySelector<HTMLInputElement>('[aria-label="Left image number"]')!.value).toBe('2')
    expect(mounted.root.querySelector<HTMLInputElement>('[aria-label="Right image number"]')!.value).toBe('1')
    mounted.dispose()
  })

  it('restores blank and clamped compare selections even when the selected index does not change', () => {
    const mounted = mount()
    ;[...mounted.root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Compare slider')!.click()
    for (const [side, expected, invalid] of [['Left', '1', '0'], ['Right', '2', '99']] as const) {
      const input = mounted.root.querySelector<HTMLInputElement>(`[aria-label="${side} image number"]`)!
      for (const value of ['', invalid, `${expected}.5`]) {
        input.value = value
        input.dispatchEvent(new Event('change', { bubbles: true }))
        expect(input.value).toBe(expected)
        expect(input.checkValidity()).toBe(true)
      }
    }
    mounted.dispose()
  })

  it('bounds huge batches to four mounted grid requests, cancels hidden tiles, and revokes URLs', async () => {
    const root = document.createElement('div'); document.body.append(root)
    const requests: { index: number; signal: AbortSignal }[] = []
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:batch')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const dispose = render(() => <ExecutedImageViewer images={[]} initialIndex={0} provenance={provenance} onRequestClose={() => {}}
      batch={{ count: 1000000, imageAt: (index) => ({ ...images[0]!, key: `batch-${index}`, kind: 'rendition', batchIndex: index,
        load: async (signal) => {
          requests.push({ index, signal })
          return { available: true, bytes: new ArrayBuffer(1), mime: 'image/png', kind: 'png', fingerprint: 'batch', colorTransform: 'PQ to sRGB' }
        },
      }) }} />, root)
    await Promise.resolve(); await Promise.resolve()
    expect(root.textContent).toContain('PQ to sRGB (display only)')
    root.querySelector<HTMLButtonElement>('[aria-label="Show all images"]')!.click()
    await Promise.resolve(); await Promise.resolve()
    expect(root.querySelectorAll('[role="listitem"]')).toHaveLength(4)
    expect(requests.filter((request) => !request.signal.aborted)).toHaveLength(4)
    const next = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Next grid page')!
    next.click()
    await Promise.resolve(); await Promise.resolve()
    expect(requests.filter((request) => !request.signal.aborted).map((request) => request.index)).toEqual([4, 5, 6, 7])
    dispose()
    expect(requests.every((request) => request.signal.aborted)).toBe(true)
    expect(revoke).toHaveBeenCalledTimes(create.mock.calls.length)
  })
})
