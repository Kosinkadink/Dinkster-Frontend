import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'solid-js/web'
import { createSignal, registerCatalog, setLocale } from '@dinkster/core'
import type { NodePreview } from '@dinkster/canvas'
import type { AppState } from '../src/app-state.js'
import { AudioTransport, audioPlayhead, setAudioPlayhead } from '../src/AudioTransport.js'
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
  afterEach(() => { dispose(); root.remove(); setAudioPlayhead(undefined); setLocale('en'); vi.restoreAllMocks() })
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
  it('does not project process-global audio onto an unrelated editable curve', async () => {
    await next()
    const audio = root.querySelector('audio')!
    audio.currentTime = 2
    audio.dispatchEvent(new Event('timeupdate'))
    expect(audioPlayhead()?.time).toBe(2)
    const request = { tabId: 'tab', graphId: 'g', nodeId: 'envelope', inputId: 'curve', instancePath: [], openedValue: { points: [{ position: 0, value: 0 }, { position: 1, value: 1 }] } }
    const app = {
      curveEditorTarget: createSignal(request), tabs: createSignal([{ id: 'tab', store: { document: createSignal({}) } }]), activeTabId: createSignal('tab'), store: { executions: createSignal(new Map()) },
      curveTargetForInput: () => request, executionForTab: () => undefined,
    } as unknown as AppState
    const curve = document.createElement('div'); root.append(curve)
    const closeCurve = render(() => <CurveEditor app={app} />, curve)
    expect(curve.querySelector('[aria-label="Curve point 2"]')?.getAttribute('cx')).toBe('982')
    expect(curve.textContent).toContain('Position and value range from 0 to 1')
    expect(curve.textContent).not.toContain('Follow audio')
    expect(curve.querySelector('[data-testid="curve-audio-playhead"]')).toBeNull()
    expect(request.openedValue.points).toEqual([{ position: 0, value: 0 }, { position: 1, value: 1 }])
    closeCurve()
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
  it('loads the executed envelope curve and follows only its exact audio source', async () => {
    const request = {
      tabId: 'tab', graphId: 'g', nodeId: 'editor', inputId: 'curve', instancePath: ['sub'],
      openedStoredValue: undefined, openedSchemaDefault: undefined,
      openedValue: { points: [{ position: 0, value: 0 }, { position: 1, value: 1 }] },
      follow: { envelopeNodeId: 'envelope', audioNodeId: 'audio', audioOutputId: 'audio' },
    }
    const documentSignal = createSignal({})
    const tab = { id: 'tab', store: { document: documentSignal } }
    const prompt = {
      'audio-input': { class_type: 'Int', inputs: { value: 1 } },
      'audio-run': { class_type: 'Audio', inputs: { source: ['audio-input', 0] } },
      'envelope-run': { class_type: 'Envelope', inputs: {} },
    }
    const artifact = {
      connection: 'local', schemaHash: 'same', prompt,
      provenance: {
        toSource: { 'audio-run': 'sub.audio', 'envelope-run': 'sub.envelope' },
        fromSource: { 'sub.audio': ['audio-run'], 'sub.envelope': ['envelope-run'] },
        outputAliases: {
          'audio-run': { audio: 'audio-result' },
          'envelope-run': { curve: 'curve-result' },
        },
      },
    }
    const execution = {
      ref: { connection: 'local', prompt: 'run' }, status: 'completed', artifact,
      nodes: { 'audio-run': {}, 'envelope-run': {} }, outputs: {},
    }
    const curve = { interpolation: 'linear', points: [{ position: 0, value: 0.2 }, { position: 3, value: 0.8 }] }
    const values = {
      peek: vi.fn(async () => ({
        available: true,
        descriptor: { typeId: 'dinkster.curve', fingerprint: 'curve' },
        renditions: [{ kind: 'curve-points', mime: 'application/json', default: true, cacheKey: 'curve-points', limits: { points: 4096 } }],
      })),
      rendition: vi.fn(async () => ({
        available: true, bytes: new TextEncoder().encode(JSON.stringify(curve)).buffer,
        mime: 'application/json', kind: 'curve-points', reportedKind: 'curve-points',
        typeId: 'dinkster.curve', fingerprint: 'curve',
      })),
    }
    let relation = true
    let liveArtifact = artifact
    const executionState = createSignal(new Map([['run', execution]]))
    const app = {
      curveEditorTarget: createSignal(request), tabs: createSignal([tab]), activeTabId: createSignal('tab'),
      store: { executions: executionState },
      curveTargetForInput: () => relation ? request : undefined,
      executionForTab: () => execution,
      backendFor: () => ({ protocol: 'dinkster', connection: { values: () => values } }),
      compileTabCached: () => ({ ok: true, artifact: liveArtifact }),
    } as unknown as AppState
    const host = document.createElement('div'); root.append(host)
    const closeCurve = render(() => <CurveEditor app={app} />, host)
    await vi.waitFor(() => expect(host.textContent).toContain('Following the executed envelope'))
    expect(values.peek).toHaveBeenCalledWith({ jobId: 'run', nodeId: 'envelope-run', outputId: 'curve-result' }, expect.anything())
    expect(values.rendition).toHaveBeenCalledWith({ jobId: 'run', nodeId: 'envelope-run', outputId: 'curve-result' }, 'curve-points', expect.anything())
    expect(host.querySelectorAll('[aria-label^="Curve point"]')).toHaveLength(2)
    expect(host.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(true)

    setAudioPlayhead({ identity: JSON.stringify({ jobId: 'other', nodeId: 'audio', outputId: 'audio' }), time: 1, duration: 4 })
    expect(host.querySelector('[data-testid="curve-audio-playhead"]')).toBeNull()
    setAudioPlayhead({ identity: JSON.stringify({ jobId: 'run', nodeId: 'audio-run', outputId: 'audio-result' }), time: 1, duration: 4 })
    expect(host.querySelector('[data-testid="curve-audio-playhead"]')).not.toBeNull()
    expect(host.textContent).toContain('Linked audio 1.00s / 4.00s')

    liveArtifact = {
      ...artifact,
      prompt: {
        ...prompt,
        'audio-input': { class_type: 'Int', inputs: { value: 2 } },
      },
    }
    executionState.set(new Map([['run', execution]]))
    await vi.waitFor(() => expect(host.textContent).toContain('Run this exact envelope and audio source'))
    expect(host.querySelectorAll('[aria-label^="Curve point"]')).toHaveLength(0)
    expect(host.querySelector('[data-testid="curve-audio-playhead"]')).toBeNull()

    liveArtifact = artifact
    executionState.set(new Map([['run', execution]]))
    await vi.waitFor(() => expect(host.textContent).toContain('Following the executed envelope'))

    values.rendition.mockResolvedValueOnce({
      available: true, bytes: new TextEncoder().encode(JSON.stringify(curve)).buffer,
      mime: 'application/json', kind: 'curve-points', reportedKind: 'curve-points',
      typeId: 'dinkster.curve', fingerprint: 'different-execution',
    })
    executionState.set(new Map([['run', execution]]))
    await vi.waitFor(() => expect(host.textContent).toContain('does not match the executed curve'))
    expect(host.querySelectorAll('[aria-label^="Curve point"]')).toHaveLength(0)

    relation = false
    documentSignal.set({ changed: true })
    await vi.waitFor(() => expect(host.textContent).toContain('curve relation is no longer available'))
    expect(host.querySelector('[data-testid="curve-audio-playhead"]')).toBeNull()
    closeCurve()
  })
})
