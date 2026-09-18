import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import type { Json, WidgetSpec } from '@dinkster/core'
import type { RenditionOptions, ValuePeekResult } from '@dinkster/client'
import type { VideoEditSource } from './video-edit-context.js'
import { Check, X } from 'lucide-solid'
import { Icon } from './Icon.js'
import { ProductActionFooter, ProductNotice } from './ProductForm.js'
import { ProductNumberInput } from './ProductNumberInput.js'
import {
  isVideoEditObject,
  normalizedVideoCrop,
  trimFrameWindow,
  updateVideoEditSection,
  videoEditFeatures,
  videoFrameCount,
  videoSourceDimensions,
  videoSourceFacts,
  type VideoEditObject,
  type VideoSourceFacts,
} from './video-edit.js'

export interface VideoEditEditorProps {
  readonly value: Json
  readonly spec: WidgetSpec
  readonly strictDuration?: boolean
  readonly strictDisabledReason?: string
  readonly facts?: VideoSourceFacts
  readonly previewUrl?: string
  readonly source?: VideoEditSource
  readonly sourceReason?: string
  readonly editDisabledReason?: string
  readonly onCommit: (value: Json, strictDuration: boolean) => void
  readonly onCancel: () => void
}

const number = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const even = (value: number): number => Math.floor(value / 2) * 2

export function VideoEditEditor(props: VideoEditEditorProps) {
  const initial = isVideoEditObject(props.value) ? props.value : {}
  const [draft, setDraft] = createSignal<VideoEditObject>(initial)
  const [strictDuration, setStrictDuration] = createSignal(props.strictDuration ?? false)
  const [playhead, setPlayhead] = createSignal(0)
  const [peek, setPeek] = createSignal<ValuePeekResult>()
  const [playPreview, setPlayPreview] = createSignal(false)
  const [decodeError, setDecodeError] = createSignal<string>()
  const [numericErrors, setNumericErrors] = createSignal<Record<string, string | undefined>>({})
  const numericError = () => Object.values(numericErrors()).find((error) => error !== undefined)
  const clearNumericError = (field: string) => setNumericErrors((errors) => ({ ...errors, [field]: undefined }))
  const commitNumber = (field: string, raw: string, update: (value: number) => void, integer = false) => {
    const value = Number(raw)
    const valid = raw.trim() !== '' && Number.isFinite(value) && (!integer || Number.isSafeInteger(value))
    setNumericErrors((errors) => ({ ...errors, [field]: valid ? undefined : `${field} must be a finite ${integer ? 'integer' : 'number'}.` }))
    if (valid) update(value)
  }
  const editError = () => props.editDisabledReason ?? (!isVideoEditObject(props.value)
    ? 'The imported VIDEO_EDIT is not an object. It is preserved; repair it in the raw value editor.' : undefined)
  createEffect(() => {
    const source = props.source
    setPeek(undefined)
    if (!source) return
    const abort = new AbortController()
    onCleanup(() => abort.abort())
    void source.values.peek(source.query, { signal: abort.signal }).then((result) => {
      if (!abort.signal.aborted) setPeek(result)
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) setPeek({ available: false, status: 0, reason: 'http-error', error: String(error) })
    })
  })
  const facts = createMemo(() => {
    const result = peek()
    return props.facts ?? (result?.available ? videoSourceFacts(result.descriptor.meta) : undefined)
  })
  const dimensions = createMemo(() => {
    const result = peek()
    return props.facts ?? (result?.available ? videoSourceDimensions(result.descriptor.meta) : undefined)
  })
  const features = createMemo(() => videoEditFeatures(props.spec))
  const trim = createMemo(() => isVideoEditObject(draft().trim) ? draft().trim! : {})
  const crop = createMemo(() => isVideoEditObject(draft().crop) ? draft().crop! : {})
  const trimFrames = createMemo(() => facts() === undefined ? undefined : trimFrameWindow(
    features().has('trim') ? number(trim().start_time) : 0,
    features().has('trim') ? number(trim().duration) : 0, facts()!,
  ))
  const cropRect = createMemo(() => dimensions() === undefined ? undefined : normalizedVideoCrop(
    dimensions()!.width,
    dimensions()!.height,
    { x: number(crop().x), y: number(crop().y), width: number(crop().width), height: number(crop().height) },
  ))
  createEffect(() => {
    const window = trimFrames()
    if (window) setPlayhead((value) => Math.max(window.start, Math.min(value, window.playheadMax)))
  })
  const rendition = (request: () => { kind: string; options?: RenditionOptions } | undefined) => {
    const [state, setState] = createSignal<{ url?: string; error?: string; color?: string }>({})
    createEffect(() => {
      const source = props.source
      const result = peek()
      const selected = request()
      setState({})
      if (!source || !result?.available || !selected) return
      if (!result.renditions.some((item) => item.kind === selected.kind)) {
        setState({ error: `${selected.kind} rendition is not advertised by this backend.` })
        return
      }
      const abort = new AbortController()
      let url: string | undefined
      const timer = setTimeout(() => {
        void source.values.rendition(source.query, selected.kind, { ...selected.options, signal: abort.signal }).then((media) => {
          if (abort.signal.aborted) return
          if (!media.available) { setState({ error: `${media.status} ${media.reason}: ${media.error}` }); return }
          if (!(selected.kind === 'preview' ? media.mime === 'video/mp4' : media.mime === 'image/png')) {
            setState({ error: 'The backend returned an unsupported preview format.' }); return
          }
          url = URL.createObjectURL(new Blob([media.bytes], { type: media.mime }))
          setState({ url, ...(media.colorTransform === undefined ? {} : { color: media.colorTransform }) })
        }).catch((error: unknown) => { if (!abort.signal.aborted) setState({ error: String(error) }) })
      }, selected.kind === 'frame' ? 100 : 0)
      onCleanup(() => { clearTimeout(timer); abort.abort(); if (url) URL.revokeObjectURL(url) })
    })
    return state
  }
  const frameSelectable = () => {
    const result = peek()
    return result?.available && result.renditions.find((item) => item.kind === 'frame')?.parameters?.includes('frame') === true
  }
  const frame = rendition(() => {
    const result = peek()
    if (!result?.available) return undefined
    return result.renditions.some((item) => item.kind === 'frame')
      ? { kind: 'frame', ...(frameSelectable() ? { options: { frame: facts() ? `${playhead() / facts()!.fps}s` as const : 0 } } : {}) }
      : { kind: 'poster' }
  })
  const thumbs = rendition(() => features().has('trim') ? { kind: 'thumbs' } : undefined)
  const preview = rendition(() => playPreview() ? { kind: 'preview' } : undefined)
  const previewUrl = () => preview().url ?? props.previewUrl
  const previewAvailable = () => { const result = peek(); return result?.available && result.renditions.some((item) => item.kind === 'preview') }
  const sourceError = () => {
    const result = peek()
    return result && !result.available ? `${result.status} ${result.reason}: ${result.error}` : props.sourceReason
  }
  const updateTrim = (fields: Readonly<Record<string, number>>) => setDraft((value) => updateVideoEditSection(value, 'trim', fields))
  const updateCrop = (fields: Readonly<Record<string, number>>) => setDraft((value) => updateVideoEditSection(value, 'crop', fields))
  const setTrimFrame = (field: 'start' | 'end', frame: number) => {
    if (facts() === undefined) return
    const window = trimFrames()!
    const start = field === 'start' ? Math.max(0, Math.min(frame, window.end - 1)) : window.start
    const end = field === 'end' ? Math.max(start + 1, Math.min(frame, videoFrameCount(facts()!))) : window.end
    updateTrim({ start_time: start / facts()!.fps, duration: end === videoFrameCount(facts()!) ? 0 : (end - start) / facts()!.fps })
  }
  const applyCrop = (candidate: Readonly<{ x: number; y: number; width: number; height: number }>) => {
    if (dimensions() === undefined) return
    updateCrop(normalizedVideoCrop(dimensions()!.width, dimensions()!.height, candidate))
  }
  const ratioCrop = (ratio: number) => {
    if (dimensions() === undefined) return
    const sourceRatio = dimensions()!.width / dimensions()!.height
    const width = even(sourceRatio > ratio ? dimensions()!.height * ratio : dimensions()!.width)
    const height = even(sourceRatio > ratio ? dimensions()!.height : dimensions()!.width / ratio)
    applyCrop({ x: even((dimensions()!.width - width) / 2), y: even((dimensions()!.height - height) / 2), width, height })
  }
  const moveCropEdge = (edge: string, px: number, py: number) => {
    if (!cropRect()) return
    let { x, y, width, height } = cropRect()!
    if (edge.includes('w')) { const next = Math.max(0, Math.min(px, x + width - 2)); width += x - next; x = next }
    if (edge.includes('e')) width = Math.max(2, px - x)
    if (edge.includes('n')) { const next = Math.max(0, Math.min(py, y + height - 2)); height += y - next; y = next }
    if (edge.includes('s')) height = Math.max(2, py - y)
    applyCrop({ x, y, width, height })
  }
  const pointerCrop = (event: PointerEvent, edge: string) => {
    if (dimensions() === undefined || event.buttons !== 1) return
    const target = event.currentTarget as HTMLElement
    const box = target.parentElement!.parentElement!.getBoundingClientRect()
    moveCropEdge(edge, even((event.clientX - box.left) / box.width * dimensions()!.width), even((event.clientY - box.top) / box.height * dimensions()!.height))
  }
  const keyboardCrop = (event: KeyboardEvent, edge: string) => {
    const rect = cropRect()
    if (!rect || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const step = event.shiftKey ? 10 : 2
    moveCropEdge(edge,
      (edge.includes('w') ? rect.x : rect.x + rect.width) + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
      (edge.includes('n') ? rect.y : rect.y + rect.height) + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0))
  }

  return (
    <div class="video-edit-editor" data-testid="video-edit-editor">
      <Show when={editError()}><ProductNotice tone="error">{editError()}</ProductNotice></Show>
      <Show when={decodeError()}><ProductNotice tone="error">{decodeError()}</ProductNotice></Show>
      <Show when={numericError()}><ProductNotice tone="error" testId="video-edit-numeric-error">{numericError()}</ProductNotice></Show>
      <Show when={sourceError() || (!frame().url && !previewUrl())}>
        <ProductNotice tone="status" testId="video-edit-preview-unavailable">
          {sourceError() ?? frame().error ?? (props.source && !peek() ? 'Loading source metadata...' : 'Lazy source preview is unavailable on this backend.')}
        </ProductNotice>
      </Show>
      <Show when={dimensions() === undefined || (features().has('trim') && facts() === undefined)}>
        <ProductNotice tone="status" testId="video-edit-facts-unavailable">
          Source timing or dimensions are unavailable. Trim handles require timing; crop handles require dimensions. Numeric fields remain editable.
        </ProductNotice>
      </Show>
      <Show when={dimensions()}>{(source) => <p class="video-edit-source-facts" data-testid="video-edit-source-facts">
        {source().width} x {source().height} source pixels
        <Show when={facts()} fallback=" | Source timing unavailable">{(timing) => <>
          {' | '}{timing().duration.toFixed(3)} s | {timing().fps.toFixed(3)} fps (average)
          {' | Frame positions are approximate for variable-frame-rate video.'}
        </>}</Show>
      </p>}</Show>
      <p class="video-edit-source-facts">Draft controls overlay the source preview. Apply and run the node for the rendered trim/crop result.</p>
      <Show when={peek()?.available && !frameSelectable()}>
        <ProductNotice tone="status" testId="video-edit-frame-selection-unavailable">Frame selection is not advertised. Only the provider's default source frame or poster can be shown.</ProductNotice>
      </Show>
      <Show when={frame().color || thumbs().color || preview().color}>
        <ProductNotice tone="status">Preview color transform: {frame().color ?? thumbs().color ?? preview().color}</ProductNotice>
      </Show>
      <Show when={!features().has('crop') && frame().url}>{(url) => <img class="video-edit-source-frame" src={url()} alt="Selected source frame" onError={() => setDecodeError('The source frame could not be displayed.')} />}</Show>
      <button type="button" disabled={!previewAvailable()} onClick={() => setPlayPreview((value) => !value)}>
        {playPreview() ? 'Close bounded preview' : 'Load bounded source preview'}
      </button>
      <Show when={preview().error}><ProductNotice tone="status">{preview().error}</ProductNotice></Show>
      <Show when={previewUrl()}>{(url) => <video aria-label="Bounded source preview" src={url()} controls muted preload="metadata" onError={() => setDecodeError('The bounded video preview could not be played.')} />}</Show>

      <Show when={features().has('trim')}>
        <section class="video-edit-section" aria-label="Trim video">
          <header><strong>Trim</strong><span>One clip - seconds stored, frames shown</span></header>
          <div class="video-edit-filmstrip" data-testid="video-edit-filmstrip">
            <Show when={thumbs().url} fallback={<span class="video-edit-empty-strip">Filmstrip unavailable</span>}>{(url) => <img src={url()} alt="Source thumbnails" />}</Show>
            <input
              aria-label="Playhead frame"
              type="range"
              min={trimFrames()?.start ?? 0}
              max={trimFrames()?.playheadMax ?? 0}
              value={playhead()}
              disabled={trimFrames() === undefined || !frameSelectable()}
              onInput={(event) => setPlayhead(Number(event.currentTarget.value))}
            />
          </div>
          <div class="video-edit-fields">
            <label>Start seconds<ProductNumberInput testId="video-trim-start-seconds" step="0.001" value={number(trim().start_time)} commitUnchanged ariaInvalid={numericErrors()['Start seconds'] !== undefined} onRevert={() => clearNumericError('Start seconds')} onCommit={(raw) => commitNumber('Start seconds', raw, (value) => updateTrim({ start_time: value }))} /></label>
            <label>Duration seconds<ProductNumberInput testId="video-trim-duration-seconds" min="0" step="0.001" value={number(trim().duration)} commitUnchanged ariaInvalid={numericErrors()['Duration seconds'] !== undefined} onRevert={() => clearNumericError('Duration seconds')} onCommit={(raw) => commitNumber('Duration seconds', raw, (value) => updateTrim({ duration: Math.max(0, value) }))} /></label>
            <label>Start frame<ProductNumberInput testId="video-trim-start-frame" integer disabled={trimFrames() === undefined} value={trimFrames()?.start ?? 0} commitUnchanged ariaInvalid={numericErrors()['Start frame'] !== undefined} onRevert={() => clearNumericError('Start frame')} onCommit={(raw) => commitNumber('Start frame', raw, (value) => setTrimFrame('start', value), true)} /></label>
            <label>End frame<ProductNumberInput testId="video-trim-end-frame" integer disabled={trimFrames() === undefined} value={trimFrames()?.end ?? 0} commitUnchanged ariaInvalid={numericErrors()['End frame'] !== undefined} onRevert={() => clearNumericError('End frame')} onCommit={(raw) => commitNumber('End frame', raw, (value) => setTrimFrame('end', value), true)} /></label>
            <Show when={props.strictDuration !== undefined}><label class="video-edit-check"><input data-testid="video-trim-strict" type="checkbox" disabled={props.strictDisabledReason !== undefined} checked={strictDuration()} onChange={(event) => setStrictDuration(event.currentTarget.checked)} /> Strict duration</label></Show>
            <Show when={props.strictDisabledReason}><span>{props.strictDisabledReason}</span></Show>
          </div>
          <div class="video-edit-trim-handles" data-testid="video-trim-handles">
            <input aria-label="Trim start handle" type="range" min="0" max={facts() ? videoFrameCount(facts()!) - 1 : 0} value={trimFrames()?.start ?? 0} disabled={trimFrames() === undefined} onInput={(event) => setTrimFrame('start', Number(event.currentTarget.value))} />
            <input aria-label="Trim end handle" type="range" min="1" max={facts() ? videoFrameCount(facts()!) : 1} value={trimFrames()?.end ?? 0} disabled={trimFrames() === undefined} onInput={(event) => setTrimFrame('end', Number(event.currentTarget.value))} />
          </div>
          <Show when={thumbs().error}><p class="video-edit-source-facts">{thumbs().error}</p></Show>
        </section>
      </Show>

      <Show when={features().has('crop')}>
        <section class="video-edit-section" aria-label="Crop video">
          <header><strong>Crop</strong><span>Source pixels - chroma-even</span></header>
          <div class="video-crop-stage" data-testid="video-crop-stage" style={{ 'aspect-ratio': dimensions() ? `${dimensions()!.width} / ${dimensions()!.height}` : '16 / 9' }}>
            <Show when={frame().url}>{(url) => <img src={url()} alt="Crop source frame" onError={() => setDecodeError('The crop source frame could not be displayed.')} />}</Show>
            <div class="video-crop-selection" style={cropRect() === undefined ? undefined : {
              left: `${cropRect()!.x / dimensions()!.width * 100}%`,
              top: `${cropRect()!.y / dimensions()!.height * 100}%`,
              width: `${cropRect()!.width / dimensions()!.width * 100}%`,
              height: `${cropRect()!.height / dimensions()!.height * 100}%`,
            }}>
              <For each={['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']}>{(edge) => (
                <button
                  type="button"
                  class={`video-crop-handle ${edge}`}
                  aria-label={`Crop ${edge} handle`}
                  disabled={dimensions() === undefined}
                  onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
                  onPointerMove={(event) => pointerCrop(event, edge)}
                  onKeyDown={(event) => keyboardCrop(event, edge)}
                />
              )}</For>
            </div>
          </div>
          <div class="video-edit-fields crop">
            <For each={['x', 'y', 'width', 'height'] as const}>{(field) => (
              <label>{field}<ProductNumberInput testId={`video-crop-${field}`} integer step="1" value={number(crop()[field])} commitUnchanged ariaInvalid={numericErrors()[`Crop ${field}`] !== undefined} onRevert={() => clearNumericError(`Crop ${field}`)} onCommit={(raw) => commitNumber(`Crop ${field}`, raw, (value) => updateCrop({ [field]: value }), true)} /></label>
            )}</For>
          </div>
          <div class="video-crop-ratios" aria-label="Crop ratio presets">
            <button type="button" disabled={dimensions() === undefined} onClick={() => ratioCrop(16 / 9)}>16:9</button>
            <button type="button" disabled={dimensions() === undefined} onClick={() => ratioCrop(4 / 3)}>4:3</button>
            <button type="button" disabled={dimensions() === undefined} onClick={() => ratioCrop(1)}>1:1</button>
            <button type="button" disabled={dimensions() === undefined} onClick={() => updateCrop({ x: 0, y: 0, width: 0, height: 0 })}>Full frame</button>
          </div>
        </section>
      </Show>

      <ProductActionFooter>
        <button type="button" onClick={props.onCancel}><Icon icon={X} /> Cancel</button>
        <button type="button" class="primary" data-testid="video-edit-apply" disabled={editError() !== undefined || numericError() !== undefined} onClick={() => props.onCommit(draft(), strictDuration())}><Icon icon={Check} /> Apply</button>
      </ProductActionFooter>
    </div>
  )
}
