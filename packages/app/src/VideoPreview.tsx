import { For, Show, createEffect, createSignal, on, onCleanup } from 'solid-js'
import type { NodePreview } from '@dinkster/canvas'
import { ProductSlider } from './ProductSlider.js'
import { DEFAULT_VIDEO_PREFERENCES, videoInspectionOf, type VideoInspection, type VideoPreferences } from './video-preview.js'
import './video-preview.css'

export function VideoPreview(props: {
  readonly media: NodePreview
  readonly preferences?: VideoPreferences | undefined
  readonly onPreferences?: ((preferences: VideoPreferences) => void) | undefined
  readonly onActiveChange?: ((active: boolean) => void) | undefined
  readonly onMediaError?: (() => void) | undefined
  readonly onDimensions?: (dimensions: { width: number; height: number }) => void
  readonly appView?: boolean
  readonly overview?: boolean
}) {
  let video: HTMLVideoElement | undefined
  let poster: HTMLCanvasElement | undefined
  let focused = false
  let frameRequest: AbortController | undefined
  let thumbsRequest: AbortController | undefined
  let selectionRequest: AbortController | undefined
  let selection = 0
  let selectedUrl: string | undefined
  const [localPreferences, setLocalPreferences] = createSignal(DEFAULT_VIDEO_PREFERENCES)
  const preferences = () => props.preferences ?? localPreferences()
  const [inspection, setInspection] = createSignal<VideoInspection>()
  const [src, setSrc] = createSignal<string>()
  const [mime, setMime] = createSignal<string>()
  const [position, setPosition] = createSignal(0)
  const [duration, setDuration] = createSignal(0)
  const [playing, setPlaying] = createSignal(false)
  const [inspecting, setInspecting] = createSignal(false)
  const [frame, setFrame] = createSignal<string>()
  const [indexedFrame, setIndexedFrame] = createSignal<number>()
  const [thumbs, setThumbs] = createSignal<string>()
  const [hovering, setHovering] = createSignal(false)
  const [error, setError] = createSignal('')
  const [color, setColor] = createSignal<string>()
  const [playbackColor, setPlaybackColor] = createSignal<string>()
  const [thumbColor, setThumbColor] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [framePending, setFramePending] = createSignal(false)
  const fps = () => inspection()?.fps
  const total = () => inspection()?.duration ?? duration()
  const lastFrame = () => inspection()?.frameCountKind === 'exact' ? (inspection()?.frameCount ?? Infinity) - 1 : Infinity
  const frameLabel = () => indexedFrame() === undefined ? 'Frame unknown' : `Frame ${indexedFrame()}`
  const canSelectFrame = () => inspection()?.canSelectFrame === true && !busy()
  const canStep = () => canSelectFrame() && !framePending()
  const canPlay = () => mime()?.startsWith('video/') !== false && src() !== undefined
  const releaseFrame = (): void => {
    frameRequest?.abort()
    setFramePending(false)
    if (frame()) URL.revokeObjectURL(frame()!)
    setFrame(undefined)
    setIndexedFrame(undefined)
  }
  const releaseThumbs = (): void => {
    thumbsRequest?.abort()
    thumbsRequest = undefined
    if (thumbs()) URL.revokeObjectURL(thumbs()!)
    setThumbs(undefined)
    setThumbColor(undefined)
  }
  const sync = (): void => {
    if (video === undefined) return
    setDuration(Number.isFinite(video.duration) ? video.duration : 0)
    if (!inspecting()) setPosition(video.currentTime)
    setPlaying(!video.paused)
    props.onActiveChange?.(focused || !video.paused)
  }
  const play = async (): Promise<void> => {
    if (!video) return
    setInspecting(false)
    releaseFrame()
    setColor(playbackColor())
    try { await video.play() } catch { setError('Autoplay was blocked. Use Play to start the preview.') }
  }
  const changePreference = (key: keyof VideoPreferences): void => {
    const next = { ...preferences(), [key]: !preferences()[key] }
    setLocalPreferences(next)
    props.onPreferences?.(next)
  }
  createEffect(on(() => props.media.src, () => {
    selection++
    selectionRequest?.abort()
    releaseFrame()
    releaseThumbs()
    if (selectedUrl) URL.revokeObjectURL(selectedUrl)
    selectedUrl = undefined
    setInspection(videoInspectionOf(props.media))
    setSrc(props.media.src)
    setMime(props.media.mime ?? (props.media.image === undefined ? 'video/mp4' : 'image/png'))
    setPosition(0)
    setDuration(0)
    setInspecting(false)
    setError('')
    setColor(props.media.colorTransform)
    setPlaybackColor(props.media.colorTransform)
    setBusy(false)
  }))
  createEffect(() => {
    if (video === undefined) return
    video.loop = preferences().loop
    video.muted = props.overview === true || preferences().muted
  })
  createEffect(on(() => preferences().autoplay, (autoplay) => {
    if (autoplay && canPlay()) void play()
    else video?.pause()
  }))
  createEffect(() => {
    const image = props.media.image
    if (poster === undefined || image === undefined) return
    poster.width = props.media.width ?? 1
    poster.height = props.media.height ?? 1
    poster.getContext('2d')?.drawImage(image, 0, 0, poster.width, poster.height)
  })
  const seek = async (selector: number | `${number}s`): Promise<void> => {
    if (busy()) return
    setInspecting(true)
    video?.pause()
    releaseFrame()
    setColor(playbackColor())
    if (typeof selector === 'string') {
      const time = Number(selector.slice(0, -1))
      setPosition(time)
      if (video && Number.isFinite(video.duration)) video.currentTime = Math.min(time, video.duration)
    }
    const source = inspection()
    if (!source?.canSelectFrame) {
      setError('Frame selector is not advertised; showing browser seek only.')
      return
    }
    frameRequest?.abort()
    const controller = new AbortController()
    frameRequest = controller
    setFramePending(true)
    try {
      const result = await source.request('frame', { frame: selector, signal: controller.signal })
      if (controller.signal.aborted) return
      if (!result.available) { setError(`Frame unavailable: ${result.error} (${result.status}, ${result.reason})`); return }
      if (result.mime !== 'image/png') { setError('Frame unavailable: expected a PNG rendition'); return }
      if (frame()) URL.revokeObjectURL(frame()!)
      setFrame(URL.createObjectURL(new Blob([result.bytes], { type: result.mime })))
      setIndexedFrame(typeof selector === 'number' ? selector : undefined)
      setColor(result.colorTransform)
      setError('')
    } catch (error) {
      if (!controller.signal.aborted) setError(`Frame unavailable: ${String(error)}`)
    } finally {
      if (frameRequest === controller) setFramePending(false)
    }
  }
  const step = (delta: number): void => {
    if (!canStep()) return
    const current = indexedFrame()
    const index = current === undefined ? 0 : Math.max(0, Math.min(current + delta, lastFrame()))
    void seek(index)
  }
  const showThumbs = async (): Promise<void> => {
    setHovering(true)
    const source = inspection()
    if (busy() || source?.thumbnailCount === undefined || thumbs() !== undefined || thumbsRequest !== undefined) return
    const generation = selection
    const controller = new AbortController()
    thumbsRequest = controller
    try {
      const result = await source.request('thumbs', { thumbs: source.thumbnailCount, signal: controller.signal })
      if (controller.signal.aborted || generation !== selection) return
      if (!result.available) { setError(`Thumbnails unavailable: ${result.error} (${result.status}, ${result.reason})`); return }
      if (result.mime !== 'image/png') { setError('Thumbnails unavailable: expected a PNG strip'); return }
      setThumbs(URL.createObjectURL(new Blob([result.bytes], { type: result.mime })))
      setThumbColor(result.colorTransform)
    } catch (error) {
      if (!controller.signal.aborted && generation === selection) setError(`Thumbnails unavailable: ${String(error)}`)
    }
  }
  const select = async (index: number): Promise<void> => {
    const source = inspection()
    if (!source || index < 0 || index >= source.count) return
    const request = ++selection
    selectionRequest?.abort()
    const controller = new AbortController()
    selectionRequest = controller
    video?.pause()
    releaseFrame()
    releaseThumbs()
    setBusy(true)
    setError('')
    try {
      const result = await source.select(index, controller.signal)
      if (request !== selection) return
      releaseThumbs()
      if (selectedUrl) URL.revokeObjectURL(selectedUrl)
      selectedUrl = URL.createObjectURL(new Blob([result.bytes], { type: result.mime }))
      setInspection(result.inspection)
      setMime(result.mime)
      setSrc(selectedUrl)
      setPosition(0)
      setInspecting(false)
      setColor(result.colorTransform)
      setPlaybackColor(result.colorTransform)
    } catch (error) {
      if (request === selection) setError(`Video ${index + 1} unavailable: ${String(error)}`)
    } finally {
      if (request === selection) setBusy(false)
      if (selectionRequest === controller) selectionRequest = undefined
    }
  }
  onCleanup(() => {
    selection++
    selectionRequest?.abort()
    video?.pause()
    releaseFrame()
    releaseThumbs()
    if (selectedUrl) URL.revokeObjectURL(selectedUrl)
    queueMicrotask(() => props.onActiveChange?.(false))
  })
  return (
    <div class="video-preview" role="group" aria-label="Video preview controls" aria-live="off" tabindex="0"
      onPointerEnter={() => void showThumbs()} onPointerLeave={() => setHovering(false)}
      onFocusIn={() => { focused = true; void showThumbs(); props.onActiveChange?.(true) }}
      onFocusOut={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        focused = false
        setHovering(false)
        props.onActiveChange?.(playing())
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
        if (event.key === ',' || event.key === '.') { event.preventDefault(); event.stopPropagation(); step(event.key === ',' ? -1 : 1) }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault(); event.stopPropagation(); void select((inspection()?.index ?? 0) + (event.key === 'ArrowLeft' ? -1 : 1))
        }
      }}>
      <div class="video-preview-picture">
        <Show when={canPlay()} fallback={
          <Show when={src() === props.media.src && props.media.image !== undefined} fallback={<img src={src()} alt="Video poster" />}>
            <canvas ref={poster} data-testid={props.appView ? 'app-preview-image' : undefined} class="app-preview-image" aria-label="Video poster" />
          </Show>
        }>
          <video ref={video} src={src()} data-testid={props.appView ? 'app-preview-video' : undefined}
            aria-label="Video preview" playsinline preload="metadata" loop={preferences().loop}
            muted={props.overview === true || preferences().muted}
            onLoadedMetadata={(event) => {
              sync()
              props.onDimensions?.({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })
              if (preferences().autoplay) void play()
            }} onTimeUpdate={sync} onPlay={sync} onPause={sync}
            onError={() => { setError('Video preview unavailable: the browser could not decode this rendition.'); props.onMediaError?.() }} />
        </Show>
        <Show when={frame()}>{(url) => <img class="video-preview-frame" src={url()} alt={`Video ${frameLabel()}`} />}</Show>
        <Show when={hovering() && thumbs()}>{(url) => <div class="video-preview-thumbs"><img src={url()} alt={`${inspection()?.thumbnailCount} video timeline thumbnails`} /><Show when={thumbColor()}>{(label) => <span>Thumbnails: {label()}</span>}</Show></div>}</Show>
      </div>
      <div class="video-preview-controls">
        <ProductSlider ariaLabel="Video position" min={0} max={total()} step={0.01}
          value={position()} disabled={busy() || total() <= 0} onInput={(value) => { void seek(`${value}s`) }} />
        <div class="video-preview-buttons">
          <button type="button" disabled={!canPlay() || busy()} aria-label={playing() ? 'Pause video' : 'Play video'} title="Play preview from its playback time, not the indexed inspection frame" onClick={() => { if (playing()) video?.pause(); else void play() }}>{playing() ? 'Pause' : 'Play'}</button>
          {/* Pending requests use aria-disabled to retain keyboard focus. */}
          <button type="button" aria-label="Previous frame" title="Previous frame (,)" disabled={!canSelectFrame()} aria-disabled={!canStep()} onClick={() => step(-1)}>,</button>
          <button type="button" aria-label="Next frame" title="Next frame (.)" disabled={!canSelectFrame()} aria-disabled={!canStep()} onClick={() => step(1)}>.</button>
          <For each={['loop', 'muted', 'autoplay'] as const}>{(key) => <button type="button" aria-label={key === 'muted' ? 'Mute video' : `${key === 'loop' ? 'Loop' : 'Autoplay'} video`} aria-pressed={preferences()[key]} onClick={() => changePreference(key)}>{key === 'muted' ? 'Mute' : key === 'loop' ? 'Loop' : 'Auto'}</button>}</For>
        </div>
        <div class="video-preview-readout" data-testid="video-timing">
          {indexedFrame() === undefined ? `${position().toFixed(2)}s` : 'Time unknown'} / {inspection()?.duration === undefined ? 'Duration unknown' : `${total().toFixed(2)}s`}
          {' | '}{frameLabel()}
          {inspection()?.frameCount === undefined ? ' / count unknown' : ` / ${inspection()!.frameCount} (${inspection()?.frameCountKind ?? 'quality unknown'})`}
          {' | '}<span title="Reported FPS; not used to convert time and frame index">{fps() === undefined ? 'FPS unknown' : `${fps()!.toFixed(3)} fps`}</span>
        </div>
        <span class="video-preview-readout">{inspection()?.canSelectFrame
          ? 'Frame stepping starts at 0 after playback or time seek.'
          : 'Frame selector unavailable: not advertised.'}</span>
        <Show when={(inspection()?.count ?? 0) > 1}>
          <div class="video-preview-navigation" aria-label="Video outputs">
            <button type="button" aria-label="Previous video" disabled={busy() || inspection()!.index === 0} onClick={() => void select(inspection()!.index - 1)}>Previous</button>
            <span>{inspection()!.index + 1} / {inspection()!.count}</span>
            <For each={Array.from({ length: Math.min(9, inspection()!.count) }, (_, offset) => Math.max(0, Math.min(inspection()!.index - 4, inspection()!.count - 9)) + offset)}>{(index) =>
              <button class="video-preview-dot" type="button" aria-label={`Video ${index + 1}`} aria-pressed={inspection()!.index === index} disabled={busy()} onClick={() => void select(index)} />
            }</For>
            <button type="button" aria-label="Next video" disabled={busy() || inspection()!.index === inspection()!.count - 1} onClick={() => void select(inspection()!.index + 1)}>Next</button>
          </div>
        </Show>
        <Show when={color()}>{(label) => <span class="video-preview-readout" data-testid="video-color-transform">Preview color: {label()}</span>}</Show>
        <Show when={inspection()?.notice}>{(notice) => <span class="video-preview-notice" role="status">{notice()}</span>}</Show>
        <Show when={error()}>{(message) => <span class="video-preview-notice" role="status">{message()}</span>}</Show>
        <Show when={busy()}><span role="status">Loading video...</span></Show>
      </div>
      <Show when={props.media.download && src()}>
        <a class="app-preview-download" data-testid={props.appView ? 'app-preview-download' : undefined}
          href={frame() ?? src()} download={`preview.${frame() || !canPlay() ? 'png' : mime() === 'video/webm' ? 'webm' : 'mp4'}`}>Download preview</a>
      </Show>
    </div>
  )
}
