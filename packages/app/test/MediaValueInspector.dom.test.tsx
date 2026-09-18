import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ValuePeekOptions, ValuePeekResult, ValueQuery } from '@dinkster/client'
import { registerCatalog, setLocale, type ValueDiagnostic } from '@dinkster/core'
import { MediaDiagnostics, MediaValueInspector } from '../src/MediaValueInspector.js'

let root: HTMLDivElement
let dispose: (() => void) | undefined
beforeEach(() => {
  setLocale('en')
  root = document.createElement('div')
  document.body.append(root)
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  root.remove()
  setLocale('en')
})

function toggle(root: HTMLElement, open: boolean): void {
  const details = root.querySelector('details')!
  details.open = open
  details.dispatchEvent(new Event('toggle'))
}

const image: ValuePeekResult = { available: true, descriptor: { typeId: 'comfy.IMAGE', fingerprint: 'original-image', meta: { channels: { alpha: 'straight' } } }, renditions: [] }

describe('MediaValueInspector', () => {
  it('fetches only a descriptor on explicit inspection and preserves the runtime identity', async () => {
    const query = { jobId: 'remote-run', nodeId: 'region[3]/image', outputId: 'rgba' }
    const peek = vi.fn().mockResolvedValue(image)
    dispose = render(() => <MediaValueInspector values={{ peek }} query={query} />, root)
    expect(peek).not.toHaveBeenCalled()
    toggle(root, true)
    await vi.waitFor(() => expect(root.textContent).toContain('straight'))
    expect(peek).toHaveBeenCalledExactlyOnceWith(query, { signal: expect.any(AbortSignal) })
    expect(root.textContent).toContain('region[3]/image')
    expect(root.textContent).toContain('original-image')
    expect(root.querySelectorAll('img,video,audio,canvas,input')).toHaveLength(0)
    toggle(root, false)
    expect(peek.mock.calls[0]![1].signal.aborted).toBe(true)
  })

  it('ignores a response from a previous execution and displays current refusals', async () => {
    const [query, setQuery] = createSignal<ValueQuery>({ jobId: 'old-run', nodeId: 'image', outputId: 'output' })
    let resolveOld!: (result: ValuePeekResult) => void
    const peek = vi.fn((query: ValueQuery, _options?: ValuePeekOptions): Promise<ValuePeekResult> => query.jobId === 'old-run'
      ? new Promise((resolve) => { resolveOld = resolve })
      : Promise.resolve({ available: false, reason: 'not-retained', status: 410, error: 'Value is no longer retained' }))
    dispose = render(() => <MediaValueInspector values={{ peek }} query={query()} />, root)
    toggle(root, true)
    setQuery({ ...query(), jobId: 'new-run' })
    expect(peek.mock.calls[0]![1]?.signal?.aborted).toBe(true)
    await vi.waitFor(() => expect(root.textContent).toContain('not-retained'))
    resolveOld(image)
    await Promise.resolve()
    expect(root.textContent).not.toContain('original-image')
  })

  it('makes a missing execution owner visible without fetching', () => {
    dispose = render(() => <MediaValueInspector values={undefined} query={{ jobId: 'run', nodeId: 'image', outputId: 'output' }} />, root)
    toggle(root, true)
    expect(root.textContent).toContain('Execution owner unavailable.')
  })

  it('relabels an open inspector and diagnostics in place without translating runtime data or refetching', async () => {
    registerCatalog('de-DE', {
      'HDR PQ': '[translated raw color]',
      'mediaInspector.diagnostics.actualPolarity': '[Tatsachliche Polaritat]',
      'mediaInspector.diagnostics.diagnostic': '[Diagnose]',
      'mediaInspector.diagnostics.expectedPolarity': '[Erwartete Polaritat]',
      'mediaInspector.diagnostics.inputId': '[Eingabe-ID]',
      'mediaInspector.diagnostics.title': '[Mediendialog]',
      'mediaInspector.fact.fingerprint': '[Fingerabdruck]',
      'mediaInspector.fact.outputId': '[Ausgabe-ID]',
      'mediaInspector.fact.runtimeNode': '[Laufzeitknoten]',
      'mediaInspector.metadata.alpha': '[Alpha]',
      'mediaInspector.metadata.bitDepth': '[Bittiefe]',
      'mediaInspector.metadata.codec': '[Codec]',
      'mediaInspector.metadata.colorSpace': '[Farbraum]',
      'mediaInspector.metadata.container': '[Behalter]',
      'mediaInspector.metadata.durationSeconds': '[Dauer (s)]',
      'mediaInspector.metadata.fps': '[Bilder/s]',
      'mediaInspector.metadata.frameCount': '[Bildanzahl]',
      'mediaInspector.metadata.no': '[Nein]',
      'mediaInspector.metadata.notReported': '[Nicht gemeldet]',
      'mediaInspector.metadata.pixelFormat': '[Pixelformat]',
      'mediaInspector.metadata.storageDtype': '[Speichertyp]',
      'mediaInspector.summary.inspect': '[Pruefe {nodeId} :: {outputId}]',
      'transparency': '[translated raw polarity]',
    })
    const query = { jobId: 'raw-run', nodeId: 'region[2]/video', outputId: 'frames' }
    const descriptor: ValuePeekResult = { available: true, descriptor: {
      typeId: 'comfy.VIDEO', fingerprint: 'raw-fingerprint', meta: {
        container: 'mkv', probe: { video_codec: 'hevc', pix_fmt: 'yuv420p10le', alpha: false, bit_depth: 10, color_space: 'HDR PQ' },
        effective: { duration: [7, 2], fps: [30000, 1001], frame_count: 105 },
      },
    }, renditions: [] }
    const diagnostic: ValueDiagnostic = {
      code: 'mask_polarity_mismatch', nodeId: 'region[2]/video', inputId: 'mask-source', expected: 'coverage', actual: 'transparency',
    }
    const peek = vi.fn().mockResolvedValue(descriptor)
    dispose = render(() => <><MediaValueInspector values={{ peek }} query={query} /><MediaDiagnostics diagnostics={[diagnostic]} /></>, root)
    toggle(root, true)
    await vi.waitFor(() => expect(root.textContent).toContain('raw-fingerprint'))
    const details = root.querySelector('details')!
    const summary = root.querySelector('summary')!
    const diagnostics = root.querySelector('.media-diagnostics')!
    const rows = [...root.querySelectorAll('.output-facts > div')]
    summary.focus()

    setLocale('de-DE')

    expect(root.querySelector('details')).toBe(details)
    expect(root.querySelector('summary')).toBe(summary)
    expect(root.querySelector('.media-diagnostics')).toBe(diagnostics)
    expect([...root.querySelectorAll('.output-facts > div')]).toEqual(rows)
    expect(details.open).toBe(true)
    expect(document.activeElement).toBe(summary)
    expect(summary.textContent).toBe('[Pruefe region[2]/video :: frames]')
    expect(diagnostics.getAttribute('aria-label')).toBe('[Mediendialog]')
    expect(root.textContent).toContain('[Nicht gemeldet]')
    expect(root.textContent).toContain('[Nein]')
    expect(root.textContent).toContain('Type')
    expect(root.textContent).toContain('comfy.VIDEO')
    expect(root.textContent).toContain('raw-fingerprint')
    expect(root.textContent).toContain('mask_polarity_mismatch')
    expect(root.textContent).toContain('mask-source')
    expect(root.textContent).toContain('coverage')
    expect(root.textContent).toContain('transparency')
    expect(root.textContent).not.toContain('[translated raw')
    expect(peek).toHaveBeenCalledTimes(1)
  })
})
