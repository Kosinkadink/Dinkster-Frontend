import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'solid-js/web'
import { PreviewDownload } from '../src/PreviewDownload.js'

describe('explicit recorded download', () => {
  let root: HTMLDivElement
  let dispose: () => void
  let load: ReturnType<typeof vi.fn<(signal: AbortSignal) => Promise<Blob>>>
  let downloads: HTMLAnchorElement[]
  const flush = async () => { await Promise.resolve(); await Promise.resolve() }
  const click = () => root.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  beforeEach(() => {
    root = document.createElement('div'); document.body.append(root)
    downloads = []
    load = vi.fn(async () => new Blob(['recorded bytes']))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this) })
    dispose = render(() => <PreviewDownload class="download" label="Download output"
      download={{ src: 'https://remote.test/audio', name: 'recording.wav', load }} />, root)
  })
  afterEach(() => { dispose(); root.remove(); vi.restoreAllMocks() })
  it('waits for a click, saves owned bytes with the filename, and releases the URL', async () => {
    expect(load).not.toHaveBeenCalled()
    click(); await flush()
    expect(load).toHaveBeenCalledOnce()
    const anchor = downloads[0]!
    expect(anchor.href).toBe('blob:download')
    expect(anchor.download).toBe('recording.wav')
    dispose()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:download')
  })
  it('refuses late completion after unmount and cancels the request', async () => {
    let finish!: (blob: Blob) => void
    load.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    click()
    const signal = load.mock.calls[0]![0]
    dispose()
    expect(signal.aborted).toBe(true)
    finish(new Blob(['late'])); await flush()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })
  it('shows failures without navigating and permits an explicit retry', async () => {
    load.mockRejectedValueOnce(new Error('HTTP 404'))
    click(); await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('HTTP 404')
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    click(); await flush()
    expect(load).toHaveBeenCalledTimes(2)
    expect(root.querySelector('[role="alert"]')).toBeNull()
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce()
  })
})
