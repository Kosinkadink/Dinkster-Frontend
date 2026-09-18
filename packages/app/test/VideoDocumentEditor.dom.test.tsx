import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCatalog, setLocale } from '@dinkster/core'
import { VideoDocumentEditor, isVideoDocumentEditorCommand } from '../src/VideoDocumentEditor.js'

let root: HTMLDivElement
let dispose: (() => void) | undefined

beforeEach(() => {
  root = document.createElement('div')
  document.body.append(root)
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  root.remove()
  setLocale('en')
})

const control = <T extends HTMLElement = HTMLInputElement>(id: string): T =>
  root.querySelector<T>(`[data-testid="${id}"]`)!

const change = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void => {
  element.value = value
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('VideoDocumentEditor', () => {
  it('covers every video document node input that carries authored text', () => {
    const commands = [
      'make', 'add_clip', 'add_track', 'set_effect', 'transition', 'retime', 'mix_audio',
      'split', 'move', 'trim', 'ripple', 'roll', 'bind_source', 'import_otio',
    ]
    expect(commands.every(isVideoDocumentEditorCommand)).toBe(true)
    expect(isVideoDocumentEditorCommand('render')).toBe(false)
    expect(isVideoDocumentEditorCommand('export_otio')).toBe(false)
  })

  it('renders every command parameter from the backend contract', () => {
    const expected = {
      make: ['width', 'height', 'rate', 'name', 'clips'],
      add_clip: ['track', 'item', 'index'],
      add_track: ['kind', 'name', 'blend', 'opacity'],
      set_effect: ['track', 'clip', 'index', 'effect', 'remove'],
      transition: ['track', 'clip', 'in-offset', 'out-offset'],
      retime: ['track', 'clip', 'scalar'],
      mix_audio: ['track', 'audio-mix'],
      split: ['track', 'clip', 'position'],
      move: ['track', 'clip', 'to-track', 'index'],
      trim: ['track', 'clip', 'start-time', 'duration', 'strict-duration', 'video-edit'],
      ripple: ['track', 'clip', 'start-time', 'duration', 'strict-duration'],
      roll: ['track', 'clip', 'delta'],
      bind_source: ['source', 'reference', 'track', 'clip'],
      import_otio: ['otio'],
    } as const
    for (const [command, fields] of Object.entries(expected)) {
      dispose = render(() => <VideoDocumentEditor command={command} value="{}" onCommit={() => {}} onCancel={() => {}} />, root)
      for (const field of fields) expect(control(`video-document-${field}`)).not.toBeNull()
      dispose()
      dispose = undefined
      root.replaceChildren()
    }
  })

  it('changes one structured field while preserving unknown parameters exactly', () => {
    const commit = vi.fn()
    dispose = render(() => <VideoDocumentEditor
      command="retime"
      value={JSON.stringify({ track: 3, clip: 4, scalar: 0.5, future: { keep: [1, true] } })}
      documentSourceStatus="Connected document"
      onCommit={commit}
      onCancel={() => {}}
    />, root)
    change(control('video-document-scalar'), '-2')
    control<HTMLButtonElement>('video-document-apply').click()
    expect(JSON.parse(commit.mock.calls[0]![0])).toEqual({
      track: 3, clip: 4, scalar: -2, future: { keep: [1, true] },
    })
    expect(root.querySelector('[data-testid="video-document-source-status"]')?.textContent).toContain('Connected document')
  })

  it('preserves nested JSON values and rejects malformed edits', () => {
    const commit = vi.fn()
    dispose = render(() => <VideoDocumentEditor
      command="set_effect"
      value="{}"
      onCommit={commit}
      onCancel={() => {}}
    />, root)
    const effect = control<HTMLTextAreaElement>('video-document-effect')
    change(effect, '{bad')
    expect(control<HTMLButtonElement>('video-document-apply').disabled).toBe(true)
    expect(root.querySelector('[data-testid="video-document-error"]')?.textContent).toContain('valid JSON')
    change(control('video-document-track'), '2')
    expect(effect.value).toBe('{bad')
    expect(control<HTMLButtonElement>('video-document-apply').disabled).toBe(true)
    change(effect, JSON.stringify({ node_type: 'dinkster.image.draw_text', parameters: { text: 'Title', opacity: 0.25 } }))
    control<HTMLButtonElement>('video-document-apply').click()
    expect(JSON.parse(commit.mock.calls[0]![0])).toEqual({
      track: 2,
      effect: { node_type: 'dinkster.image.draw_text', parameters: { text: 'Title', opacity: 0.25 } },
    })
  })

  it('opens an unset parameter input as the command default object', () => {
    const commit = vi.fn()
    dispose = render(() => <VideoDocumentEditor command="trim" value="" onCommit={commit} onCancel={() => {}} />, root)
    expect(root.querySelector('[data-testid="video-document-error"]')).toBeNull()
    expect(control<HTMLButtonElement>('video-document-apply').disabled).toBe(false)
    control<HTMLButtonElement>('video-document-apply').click()
    expect(commit).toHaveBeenCalledWith('{}')
  })

  it('keeps malformed imported parameters unchanged until repaired in advanced JSON', () => {
    const commit = vi.fn()
    dispose = render(() => <VideoDocumentEditor command="trim" value="not json" onCommit={commit} onCancel={() => {}} />, root)
    expect(control<HTMLButtonElement>('video-document-apply').disabled).toBe(true)
    const details = root.querySelector<HTMLDetailsElement>('.video-document-advanced')!
    details.open = true
    const raw = control<HTMLTextAreaElement>('video-document-raw')
    expect(raw.value).toBe('not json')
    raw.value = JSON.stringify({ start_time: -1, duration: 0, extension: 'keep' })
    raw.dispatchEvent(new InputEvent('input', { bubbles: true }))
    control<HTMLButtonElement>('video-document-apply').click()
    expect(JSON.parse(commit.mock.calls[0]![0])).toEqual({ start_time: -1, duration: 0, extension: 'keep' })
  })

  it('stores OTIO text verbatim and reports a typed VIDEO binding', () => {
    const commit = vi.fn()
    const otio = '{\n  "OTIO_SCHEMA": "Timeline.1"\n}\n'
    dispose = render(() => <VideoDocumentEditor command="import_otio" value={otio} onCommit={commit} onCancel={() => {}} />, root)
    control<HTMLButtonElement>('video-document-apply').click()
    expect(commit).toHaveBeenCalledWith(otio)
    dispose()
    dispose = render(() => <VideoDocumentEditor command="bind_source" value="{}" videoInputDriven onCommit={() => {}} onCancel={() => {}} />, root)
    expect(root.querySelector('[data-testid="video-document-video-driven"]')).not.toBeNull()
  })

  it('updates every open-editor string when the active locale changes', () => {
    registerCatalog('de-DE', {
      'common.apply': '[Anwenden]',
      'videoDocument.advanced': '[Erweiterte JSON-Parameter]',
      'videoDocument.command.retime': '[Abtastrate andern]',
      'videoDocument.field.scalar': '[Abtastgeschwindigkeit]',
      'videoDocument.source.connected': '[Dokument verbunden]',
      'videoDocument.type': '[Videodokument]',
    })
    dispose = render(() => <VideoDocumentEditor
      command="retime"
      value='{"scalar":1}'
      documentSourceStatus="Connected document"
      onCommit={() => {}}
      onCancel={() => {}}
    />, root)
    expect(root.textContent).toContain('Advanced JSON parameters')
    expect(root.textContent).toContain('Sampling speed')

    setLocale('de-DE')

    expect(root.textContent).toContain('[Erweiterte JSON-Parameter]')
    expect(root.textContent).toContain('[Abtastgeschwindigkeit]')
    expect(root.textContent).toContain('[Abtastrate andern]')
    expect(root.textContent).toContain('[Anwenden]')
  })
})
