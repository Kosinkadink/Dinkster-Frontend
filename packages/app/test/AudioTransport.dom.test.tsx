import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'solid-js/web'
import { createSignal as createSolidSignal } from 'solid-js'
import { createSignal, registerCatalog, setLocale } from '@dinkster/core'
import type { NodePreview } from '@dinkster/canvas'
import type { AppState } from '../src/app-state.js'
import { AudioTransport } from '../src/AudioTransport.js'
import { CurveEditor } from '../src/CurveEditor.js'
import { NodeMediaOverlay } from '../src/CanvasHost.js'
import { AppPreviewSurface } from '../src/AppPreviewSurface.js'
import type { PreviewLoader } from '../src/node-previews.js'

describe('shared audio transport lifecycle', () => {
  let root: HTMLDivElement
  let dispose: () => void
  let load: ReturnType<typeof vi.fn<NonNullable<NodePreview['audio']>['load']>>
  const next = async () => { await Promise.resolve(); await Promise.resolve() }
  beforeEach(() => {
    setLocale('en')
    root = document.createElement('div'); document.body.append(root)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:window')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    load = vi.fn(async (start) => ({ start, duration: 3, window: new ArrayBuffer(16), waveform: new ArrayBuffer(16), diagnostics: [] }))
    dispose = render(() => <AudioTransport media={{ kind: 'audio', src: '', audio: { identity: 'audio', canScrub: true, canSelectBatch: true, meta: { duration: 10, batch: 2, channels: 6, layout: '5.1', sample_rate: 48000 }, load } }} />, root)
  })
  afterEach(() => { dispose(); root.remove(); setLocale('en'); vi.restoreAllMocks() })
  it.each([false, true].flatMap((appView) => [false, true].map((bounded) => ({ appView, bounded }))))(
    'forwards only source decode failures (App: $appView, bounded: $bounded)', async ({ appView, bounded }) => {
      dispose()
      const failure = vi.fn()
      const media = { kind: 'audio' as const, src: 'blob:legacy', ...(bounded ? { audio: { identity: 'audio', meta: {}, load } } : {}) }
      const source = { key: 'audio', load: async () => media }
      dispose = render(() => appView
        ? <AppPreviewSurface ariaLabelledBy="audio-title" surface={{ source, preview: media }} loader={{ markUnavailable: failure } as unknown as PreviewLoader} />
        : <NodeMediaOverlay media={media} rect={{ x: 0, y: 0, width: 500, height: 300 }} scale={1}
          canvas={document.createElement('canvas')} onMediaError={failure} />, root)
      await next()
      root.querySelector('audio')!.dispatchEvent(new Event('error'))
      if (bounded) {
        expect(failure).not.toHaveBeenCalled()
        expect(root.textContent).toContain('Audio window cannot be played by this browser')
      } else if (appView) expect(failure).toHaveBeenCalledExactlyOnceWith(source)
      else expect(failure).toHaveBeenCalledOnce()
    },
  )
  it('scrubs effective time, cancels superseded work, pages batches and releases URLs', async () => {
    await next()
    expect(load).toHaveBeenCalledTimes(1)
    const firstSignal = load.mock.calls[0]![2]
    root.querySelector<HTMLElement>('[aria-label="Audio position"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
    await next()
    expect(firstSignal.aborted).toBe(true)
    expect(load.mock.calls.at(-1)![0]).toBe(0.1)
    root.querySelector<HTMLButtonElement>('[aria-label="Next audio batch"]')!.click(); await next()
    expect(load.mock.calls.at(-1)!.slice(0, 2)).toEqual([0, 1])
    expect(root.textContent).toContain('Batch 2/2')
    const signal = load.mock.calls.at(-1)![2]
    dispose()
    expect(signal.aborted).toBe(true)
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })
  it('keeps a pending seek visible while the previous window emits time updates', async () => {
    await next()
    let finish!: (value: Awaited<ReturnType<NonNullable<NodePreview['audio']>['load']>>) => void
    load.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const slider = root.querySelector<HTMLElement>('[aria-label="Audio position"]')!
    const audio = root.querySelector('audio')!
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
    audio.dispatchEvent(new Event('timeupdate'))
    expect(slider.getAttribute('aria-valuenow')).toBe('0.1')
    finish({ start: 0.1, duration: 3, window: new ArrayBuffer(16), diagnostics: [] })
    await next()
    audio.currentTime = 0.25
    audio.dispatchEvent(new Event('timeupdate'))
    expect(slider.getAttribute('aria-valuenow')).toBe('0.35')
  })
  it('keeps a late failed window from replacing a newer successful selection', async () => {
    await next()
    let finish!: (value: Awaited<ReturnType<NonNullable<NodePreview['audio']>['load']>>) => void
    load.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const slider = root.querySelector<HTMLElement>('[aria-label="Audio position"]')!
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
    await next()
    finish({ start: 0.1, duration: 3, diagnostics: ['obsolete failure'] }); await next()
    expect(root.textContent).not.toContain('obsolete failure')
    expect(root.querySelector('audio')?.getAttribute('src')).toBe('blob:window')
  })
  it('retains the playhead when the same audio source is refreshed and resets for a different source', async () => {
    dispose()
    const audio = { identity: 'first', canScrub: true, meta: { duration: 10 }, load }
    const [media, setMedia] = createSolidSignal<NodePreview>({ kind: 'audio', src: '', audio })
    dispose = render(() => <AudioTransport media={media()} />, root)
    await next()
    const slider = root.querySelector<HTMLElement>('[aria-label="Audio position"]')!
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
    await next()
    expect(slider.getAttribute('aria-valuenow')).toBe('0.1')
    setMedia({ kind: 'audio', src: '', audio: { ...audio } })
    await next()
    expect(slider.getAttribute('aria-valuenow')).toBe('0.1')
    setMedia({ kind: 'audio', src: '', audio: { ...audio, identity: 'second' } })
    await next()
    expect(slider.getAttribute('aria-valuenow')).toBe('0')
  })
  it('advances windows on end and loops the effective timeline rather than one window', async () => {
    await next()
    const audio = root.querySelector('audio')!
    Object.defineProperty(audio, 'duration', { value: 3 })
    audio.dispatchEvent(new Event('loadedmetadata'))
    audio.dispatchEvent(new Event('ended')); await next()
    expect(load.mock.calls.at(-1)!.slice(0, 2)).toEqual([3, 0])
    root.querySelector<HTMLElement>('[aria-label="Audio position"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await next()
    const loop = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    loop.checked = true; loop.dispatchEvent(new Event('change', { bubbles: true }))
    audio.dispatchEvent(new Event('ended')); await next()
    expect(load.mock.calls.at(-1)!.slice(0, 2)).toEqual([0, 0])
  })
  it('does not mistake a window duration for an unknown effective duration', async () => {
    dispose()
    dispose = render(() => <AudioTransport media={{ kind: 'audio', src: '', audio: { identity: 'unknown', meta: { duration: null, frames: null, shape: [1, 2, null] }, load } }} />, root)
    await next()
    const audio = root.querySelector('audio')!
    Object.defineProperty(audio, 'duration', { value: 3 })
    audio.dispatchEvent(new Event('loadedmetadata'))
    expect(root.querySelector('[aria-label="Audio position"]')?.getAttribute('aria-disabled')).toBe('true')
    expect(root.textContent).toContain('0.0 / ?s')
    expect(root.textContent).toContain('Duration (s): Not reported')
    expect(root.textContent).not.toMatch(/NaN|Infinity/)
    const requests = load.mock.calls.length
    audio.dispatchEvent(new Event('ended')); await next()
    expect(load).toHaveBeenCalledTimes(requests)
  })
  it('uses stable metadata identities while shared labels follow the active locale', async () => {
    await next()
    registerCatalog('de-DE', {
      'mediaInspector.metadata.channels': '[Kanale]',
      'mediaInspector.metadata.durationSeconds': '[Dauer (s)]',
      'mediaInspector.metadata.layout': '[Anordnung]',
      'mediaInspector.metadata.sampleRateHz': '[Abtastrate (Hz)]',
    })
    const facts = root.querySelector('.audio-facts')!
    setLocale('de-DE')
    expect(root.querySelector('.audio-facts')).toBe(facts)
    expect(facts.textContent).toContain('[Abtastrate (Hz)]: 48000')
    expect(facts.textContent).toContain('[Kanale]: 6')
    expect(facts.textContent).toContain('[Anordnung]: 5.1')
    expect(facts.textContent).toContain('[Dauer (s)]: 10')
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('uses the advertised batch default while keeping absent controls disabled', async () => {
    dispose()
    dispose = render(() => <AudioTransport media={{ kind: 'audio', src: '', audio: { identity: 'limited', initialBatch: 1, meta: { batch: 4, duration: 12 }, load } }} />, root)
    await next()
    expect(load.mock.calls.at(-1)!.slice(0, 2)).toEqual([0, 1])
    expect(root.querySelector<HTMLButtonElement>('[aria-label="Next audio batch"]')!.disabled).toBe(true)
    expect(root.querySelector('[aria-label="Audio position"]')?.getAttribute('aria-disabled')).toBe('true')
    expect(root.textContent).toContain('Batch selection not advertised by backend')
  })
  it('applies canonical curve positions without an unrelated audio seconds mode', async () => {
    await next()
    const request = { tabId: 'tab', graphId: 'g', nodeId: 'envelope', inputId: 'curve', instancePath: [], openedValue: { points: [{ position: 0, value: 0 }, { position: 1, value: 1 }] } }
    const tab = { id: 'tab', store: { document: createSignal({}) } }
    const dispatch = vi.fn(() => ({ ok: true }))
    const app = {
      curveEditorTarget: createSignal(request), tabs: createSignal([tab]), activeTabId: createSignal('tab'), store: { executions: createSignal(new Map()) },
      curveTargetForInput: () => request, executionForTab: () => undefined, dispatchTo: dispatch, closeCurveEditor: vi.fn(),
    } as unknown as AppState
    const curve = document.createElement('div'); root.append(curve)
    const closeCurve = render(() => <CurveEditor app={app} />, curve)
    const surface = curve.querySelector('svg')!
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 600 } as DOMRect)
    surface.dispatchEvent(new MouseEvent('dblclick', { clientX: 500, clientY: 300, bubbles: true }))
    expect(curve.querySelector('[data-testid="curve-point-value"]')?.textContent).toContain('Position0.5000')
    Array.from(curve.querySelectorAll('button')).find((button) => button.textContent === 'Apply')!.click()
    expect(dispatch).toHaveBeenCalledWith(tab, {
      command: 'node.setValue', params: { graphId: 'g', nodeId: 'envelope', inputId: 'curve', value: {
        interpolation: 'linear', points: [{ position: 0, value: 0 }, { position: 0.5, value: 0.5 }, { position: 1, value: 1 }],
      } },
    })
    expect(request.openedValue.points).toEqual([{ position: 0, value: 0 }, { position: 1, value: 1 }])
    closeCurve()
  })
  it.each([
    { accepted: false, replace: false },
    { accepted: true, replace: false },
    { accepted: false, replace: true },
  ])('waits for curve apply and isolates replacement targets: %j', async ({ accepted, replace }) => {
    const request = { tabId: 'tab', graphId: 'g', nodeId: 'envelope', inputId: 'curve', instancePath: [], openedValue: { points: [{ position: 0, value: 0 }, { position: 1, value: 1 }] } }
    const target = createSignal<typeof request | undefined>(request)
    const tab = { id: 'tab', store: { document: createSignal({}) } }
    let settle!: () => void
    const dispatch = vi.fn(() => new Promise((resolve) => {
      settle = () => resolve({ ok: accepted, diagnostics: [] })
    }))
    const app = {
      curveEditorTarget: target, tabs: createSignal([tab]), activeTabId: createSignal('tab'), store: { executions: createSignal(new Map()) },
      curveTargetForInput: () => target.get(), executionForTab: () => undefined, dispatchTo: dispatch,
      closeCurveEditor: () => target.set(undefined),
    } as unknown as AppState
    const curve = document.createElement('div'); root.append(curve)
    const closeCurve = render(() => <CurveEditor app={app} />, curve)
    const apply = Array.from(curve.querySelectorAll('button')).find((button) => button.textContent === 'Apply')!
    apply.click()
    expect(apply.disabled).toBe(true)
    expect(target.get()).toBe(request)
    apply.click()
    expect(dispatch).toHaveBeenCalledOnce()
    const replacement = { ...request }
    if (replace) target.set(replacement)
    settle()
    await next()
    expect(target.get()).toBe(replace ? replacement : accepted ? undefined : request)
    if (!accepted && !replace) expect(curve.textContent).toContain('Curve update was refused')
    if (replace) expect(curve.textContent).not.toContain('Curve update was refused')
    closeCurve()
  })
})
