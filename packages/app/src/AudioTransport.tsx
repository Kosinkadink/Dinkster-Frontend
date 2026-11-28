import { createEffect, createMemo, createSignal, on, onCleanup, Show } from 'solid-js'
import type { NodePreview } from '@dinkster/canvas'
import { ChevronLeft, ChevronRight, Pause, Play, Repeat, Volume2 } from 'lucide-solid'
import { ProductAudioWaveform, ProductIcon, ProductIconButton } from '@dinkster/ui'
import { ProductSlider } from './ProductSlider.js'
import { audioNumber } from './audio-preview.js'
import { useAppMessage } from './locale.js'
import { failureMessage } from './request-failure.js'

/** Shared Canvas/App transport. Its gain, loop and playhead are never graph values. */
export function AudioTransport(props: {
  readonly media: NodePreview
  readonly interactive?: boolean
  readonly onActiveChange?: (active: boolean) => void
}) {
  const message = useAppMessage()
  let element: HTMLAudioElement | undefined
  let abort: AbortController | undefined
  let start = 0
  let span = 0
  let resume = false
  let focused = false
  let urls: string[] = []
  let detached = Promise.resolve()
  const [src, setSrc] = createSignal<string>()
  const [waveform, setWaveform] = createSignal<string>()
  const [time, setTime] = createSignal(0)
  const [nativeDuration, setNativeDuration] = createSignal(0)
  const [playing, setPlaying] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal('')
  const [batch, setBatch] = createSignal(0)
  const [loop, setLoop] = createSignal(false)
  const [gain, setGain] = createSignal(1)
  const meta = () => props.media.audio?.meta ?? {}
  const duration = () => props.media.audio ? audioNumber(meta(), 'duration') ?? 0 : nativeDuration()
  const batches = () => Math.max(1, Math.trunc(audioNumber(meta(), 'batch') ?? 1))
  const release = () => { for (const url of urls) URL.revokeObjectURL(url); urls = [] }
  const blobUrl = (bytes: ArrayBuffer, type: string) => {
    const url = URL.createObjectURL(new Blob([bytes], { type }))
    urls.push(url)
    return url
  }
  const active = () => props.onActiveChange?.(focused || playing())
  const canSeek = () => !failure() && duration() > 0 && (props.media.audio === undefined || props.media.audio.canScrub === true)
  const seek = (position: number) => { void load(Math.min(position, Math.max(0, duration() - 0.01)), batch(), playing() || resume) }
  const clock = (seconds: number) => {
    const whole = Math.max(0, Math.floor(seconds))
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
  }
  const load = async (position: number, selectedBatch: number, autoplay: boolean) => {
    const audio = props.media.audio
    if (!audio) {
      if (element) element.currentTime = position
      return
    }
    abort?.abort()
    const request = new AbortController()
    abort = request
    element?.pause()
    resume = autoplay
    setBusy(true)
    setFailure('')
    setTime(position)
    const deadline = setTimeout(() => {
      request.abort()
      resume = false
      setSrc(undefined)
      setBusy(false)
      setFailure(failureMessage(new DOMException('Audio request timed out', 'TimeoutError'), message('audioPreview.loadFailed')))
    }, 10_000)
    request.signal.addEventListener('abort', () => clearTimeout(deadline), { once: true })
    try {
      const result = await audio.load(position, selectedBatch, request.signal)
      if (request.signal.aborted) return
      release()
      start = result.start
      span = result.duration
      setSrc(result.window ? blobUrl(result.window, 'audio/wav') : undefined)
      setWaveform(result.waveform ? blobUrl(result.waveform, 'image/png') : undefined)
      if (!result.window) setFailure(result.diagnostics.join('; ') || message('audioPreview.unavailable'))
    } catch (error) {
      if (!request.signal.aborted) { setSrc(undefined); setFailure(failureMessage(error, message('audioPreview.loadFailed'))) }
    } finally {
      clearTimeout(deadline)
      if (!request.signal.aborted) setBusy(false)
    }
  }
  createEffect(on(createMemo(() => props.media.audio?.identity ?? props.media.src), () => {
    const media = props.media
    let current = true
    let detach: (() => void) | undefined
    onCleanup(() => { current = false; detach?.() })
    abort?.abort()
    element?.pause()
    release()
    setBatch(media.audio?.initialBatch ?? 0); setTime(0); setNativeDuration(0); setWaveform(undefined); setPlaying(false)
    setFailure(''); setBusy(false)
    start = 0; span = 0; resume = false
    if (media.audio) {
      void detached.then(() => { if (current) void load(0, batch(), false) })
    }
    else {
      setSrc(undefined)
      const consume = async (): Promise<void> => {
        await detached
        if (!current) return
        setSrc(media.src || undefined)
        await new Promise<void>((resolve) => {
          const audio = element!
          detach = () => {
            const empty = audio.networkState === HTMLMediaElement.NETWORK_EMPTY
            detached = new Promise<void>((done) => {
              const reset = () => { audio.removeEventListener('emptied', reset); done(); resolve() }
              if (!empty) audio.addEventListener('emptied', reset, { once: true })
              // Reset native resource selection before allowing a replacement to attach.
              audio.pause()
              setSrc(undefined)
              audio.removeAttribute('src')
              audio.load()
              if (empty) reset()
            })
          }
          setSrc(media.src || undefined)
          setBusy(false)
        })
      }
      void consume().catch((error: unknown) => {
        if (current) { setFailure(failureMessage(error, message('audioPreview.loadFailed'))); setBusy(false) }
      })
    }
  }))
  const play = async () => {
    try { await element?.play() }
    catch { setFailure(message('audioPreview.cannotPlay')) }
  }
  const ended = () => {
    setPlaying(false); active()
    if (props.media.audio) {
      const next = start + Math.min(span, nativeDuration() || span)
      if (duration() > next + 0.01) void load(next, batch(), true)
      else if (loop()) void load(0, batch(), true)
    } else if (loop()) { if (element) element.currentTime = 0; void play() }
  }
  onCleanup(() => {
    abort?.abort(); element?.pause(); release()
    queueMicrotask(() => props.onActiveChange?.(false))
  })
  return <div class="audio-transport" classList={{ interactive: props.interactive !== false }}
    onFocusIn={() => { focused = true; active() }}
    onFocusOut={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { focused = false; active() } }}>
    <div class="audio-waveform">
      <Show when={!failure()} fallback={<div class="audio-preview-failure" role="status">{failure()}</div>}>
        <ProductAudioWaveform image={waveform()} value={time()} duration={duration()} ariaLabel={message('audioPreview.waveform')}
          showTime={false} interactive={false} onImageError={() => setWaveform(undefined)} onSeek={seek} />
      </Show>
    </div>
    <audio ref={element} src={src()} preload="metadata" onError={() => {
      if (src()) setFailure(message('audioPreview.cannotPlay'))
    }}
      onLoadedMetadata={() => { setNativeDuration(Number.isFinite(element?.duration) ? element!.duration : 0); if (element) element.volume = gain(); if (resume) { resume = false; void play() } }}
      onTimeUpdate={() => { if (!busy()) setTime(start + (element?.currentTime ?? 0)) }}
      onPlay={() => { setPlaying(true); active() }} onPause={() => { setPlaying(false); active() }} onEnded={ended} />
    <Show when={props.interactive !== false}>
      <div class="audio-transport-row">
        <ProductIconButton label={message(playing() ? 'audioPreview.pause' : 'audioPreview.play')} icon={playing() ? Pause : Play}
          pending={busy()} disabled={!src() || !!failure()} onClick={() => {
          if (playing()) element?.pause()
          else if (element?.ended && props.media.audio) void load(0, batch(), true)
          else void play()
        }} />
        <ProductSlider ariaLabel={message('audioPreview.position')} min={0} max={duration()} step={0.01} value={time()} disabled={!canSeek()} onInput={seek} />
        <span class="dinkster-audio-time">{clock(time())}<Show when={duration() > 0}> / {clock(duration())}</Show></span>
      </div>
      <div class="audio-transport-row">
        <ProductIconButton label={message('audioPreview.loop')} icon={Repeat} aria-pressed={loop()} onClick={() => setLoop(!loop())} />
        <span class="audio-volume-icon" title={message('audioPreview.volume')}><ProductIcon icon={Volume2} /></span>
        <ProductSlider ariaLabel={message('audioPreview.volume')} min={0} max={1} step={0.01} value={gain()} onInput={(value) => { setGain(value); if (element) element.volume = value }} />
        <Show when={batches() > 1}>
          <div class="audio-batch-stepper">
            <ProductIconButton label={message('audioPreview.previous')} icon={ChevronLeft} disabled={batch() === 0 || props.media.audio?.canSelectBatch !== true} onClick={() => { setBatch(batch() - 1); void load(0, batch(), false) }} />
            <span>{message('audioPreview.batch', { index: batch() + 1, count: batches() })}</span>
            <ProductIconButton label={message('audioPreview.next')} icon={ChevronRight} disabled={batch() + 1 >= batches() || props.media.audio?.canSelectBatch !== true} onClick={() => { setBatch(batch() + 1); void load(0, batch(), false) }} />
          </div>
        </Show>
      </div>
    </Show>
  </div>
}
