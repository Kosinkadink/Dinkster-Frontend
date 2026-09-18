import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCatalog, setLocale } from '@dinkster/core'
import { render } from 'solid-js/web'
import { AudioRecorder, type AudioRecordingProvider } from '../src/AudioRecorder.js'

describe('explicit audio recording', () => {
  let root: HTMLDivElement
  let dispose: () => void
  let recorder: MediaRecorder
  let provider: AudioRecordingProvider
  let stopTrack: ReturnType<typeof vi.fn>
  let save: ReturnType<typeof vi.fn>
  const click = (text: string) => { Array.from(root.querySelectorAll('button')).find((button) => button.textContent === text)!.click() }
  const flush = async () => { await Promise.resolve(); await Promise.resolve() }
  beforeEach(() => {
    setLocale('en')
    vi.useFakeTimers()
    root = document.createElement('div'); document.body.append(root)
    stopTrack = vi.fn()
    recorder = {
      state: 'inactive', mimeType: 'audio/webm;codecs=opus',
      start: vi.fn(() => { Object.assign(recorder, { state: 'recording' }) }),
      stop: vi.fn(() => { Object.assign(recorder, { state: 'inactive' }); queueMicrotask(() => { recorder.ondataavailable?.call(recorder, { data: new Blob(['clip'], { type: 'audio/webm' }) } as BlobEvent); recorder.onstop?.call(recorder, new Event('stop')) }) }),
    } as unknown as MediaRecorder
    provider = {
      devices: vi.fn(async () => []),
      open: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }) as unknown as MediaStream),
      recorder: vi.fn(() => recorder),
    }
    save = vi.fn(async () => true)
    dispose = render(() => <AudioRecorder provider={provider} onSave={save} />, root)
  })
  afterEach(() => { dispose(); root.remove(); setLocale('en'); vi.useRealTimers() })
  it('never captures on mount or discovery and reports absent devices and denied permission', async () => {
    expect(provider.open).not.toHaveBeenCalled()
    click('Find microphones'); await flush()
    expect(root.textContent).toContain('No microphone devices found')
    expect(provider.open).not.toHaveBeenCalled()
    vi.mocked(provider.open).mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
    click('Record microphone'); await flush()
    expect(root.textContent).toContain('Microphone permission denied')
    expect(save).not.toHaveBeenCalled()
  })
  it('stops at the selected duration, releases the microphone and saves only on explicit Save', async () => {
    click('Record microphone'); await flush()
    expect(recorder.start).toHaveBeenCalledWith(250)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(root.textContent).toContain('Recording ready')
    expect(root.textContent).toContain('Use asset commits it')
    expect(root.textContent).not.toContain('Record microphone')
    registerCatalog('de-DE', { 'audioRecorder.ready': 'Aufnahme bereit ({bytes} Bytes).' })
    setLocale('de-DE')
    expect(root.textContent).toContain('Aufnahme bereit (4 Bytes).')
    expect(root.textContent).not.toContain('Recording ready')
    setLocale('en')
    expect(save).not.toHaveBeenCalled()
    click('Save recording'); await flush()
    expect(save).toHaveBeenCalledOnce()
    expect(save.mock.calls[0]![0]).toBeInstanceOf(File)
    expect(save.mock.calls[0]![0]).toMatchObject({ name: 'recording.webm', type: 'audio/webm' })
    expect(root.textContent).toContain('Recording saved to the asset selection')
  })
  it('cancels pending permission and releases a late stream without saving', async () => {
    let complete!: (stream: MediaStream) => void
    vi.mocked(provider.open).mockReturnValueOnce(new Promise((resolve) => { complete = resolve }))
    click('Record microphone'); click('Discard recording')
    complete({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream)
    await flush()
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(provider.recorder).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })
  it('discards active recordings and closes active hardware on unmount', async () => {
    click('Record microphone'); await flush(); click('Discard recording'); await vi.advanceTimersByTimeAsync(0)
    expect(root.textContent).toContain('Recording cancelled')
    expect(save).not.toHaveBeenCalled()
    click('Record microphone'); await flush(); dispose()
    expect(stopTrack).toHaveBeenCalledTimes(2)
  })
  it('times out permission without allowing a late stream to record', async () => {
    let complete!: (stream: MediaStream) => void
    vi.mocked(provider.open).mockReturnValueOnce(new Promise((resolve) => { complete = resolve }))
    click('Record microphone'); await vi.advanceTimersByTimeAsync(30_000)
    expect(root.textContent).toContain('permission request timed out')
    complete({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream); await flush()
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(provider.recorder).not.toHaveBeenCalled()
  })
  it('refuses oversized recordings without uploading or retaining a clip', async () => {
    click('Record microphone'); await flush()
    const data = new Blob(['oversized'])
    Object.defineProperty(data, 'size', { value: 32 * 1024 * 1024 + 1 })
    recorder.ondataavailable!.call(recorder, { data } as BlobEvent)
    await vi.advanceTimersByTimeAsync(0)
    expect(root.textContent).toContain('Recording exceeds the 32 MiB limit')
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(save).not.toHaveBeenCalled()
    expect(root.textContent).not.toContain('Save recording')
  })
  it('retains an unsuccessful upload for explicit retry', async () => {
    save.mockResolvedValueOnce(false)
    click('Record microphone'); await flush(); click('Stop recording'); await vi.advanceTimersByTimeAsync(0)
    click('Save recording'); await flush()
    expect(root.textContent).toContain('Clip retained for retry')
    click('Save recording'); await flush()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[0]![0]).toBe(save.mock.calls[1]![0])
  })
})
