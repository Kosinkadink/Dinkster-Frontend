import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js'
import type { NodePreview } from '@dinkster/canvas'
import { ProductSlider } from './ProductSlider.js'
import { audioNumber } from './audio-preview.js'
import { mediaMetadataOf } from './media-metadata.js'
import { useAppMessage } from './locale.js'
import './audio-controls.css'

export const [audioPlayhead, setAudioPlayhead] = createSignal<{ identity: string; time: number; duration: number }>()

/** Shared Canvas/App transport. Its gain, loop and playhead are never graph values. */
export function AudioTransport(props: {
  readonly media: NodePreview
  readonly interactive?: boolean
  readonly onActiveChange?: (active: boolean) => void
  readonly onMediaError?: () => void
}) {
  const message = useAppMessage()
  let element: HTMLAudioElement | undefined
  let abort: AbortController | undefined
  let start = 0
  let span = 0
  let resume = false
  let focused = false
  let urls: string[] = []
  const [src, setSrc] = createSignal<string>()
  const [waveform, setWaveform] = createSignal<string>()
  const [time, setTime] = createSignal(0)
  const [nativeDuration, setNativeDuration] = createSignal(0)
  const [playing, setPlaying] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [diagnostic, setDiagnostic] = createSignal('')
  const [batch, setBatch] = createSignal(0)
  const [loop, setLoop] = createSignal(false)
  const [gain, setGain] = createSignal(1)
  const meta = () => props.media.audio?.meta ?? {}
  const duration = () => props.media.audio ? audioNumber(meta(), 'duration') ?? 0 : nativeDuration()
  const batches = () => Math.max(1, Math.trunc(audioNumber(meta(), 'batch') ?? 1))
  const publish = () => {
    const identity = props.media.audio?.identity ?? props.media.src ?? ''
    setAudioPlayhead({ identity, time: time(), duration: duration() })
  }
  const release = () => { for (const url of urls) URL.revokeObjectURL(url); urls = [] }
  const blobUrl = (bytes: ArrayBuffer, type: string) => {
    const url = URL.createObjectURL(new Blob([bytes], { type }))
    urls.push(url)
    return url
  }
  const active = () => props.onActiveChange?.(focused || playing())
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
    setDiagnostic('')
    setTime(position)
    publish()
    const deadline = setTimeout(() => {
      request.abort()
      resume = false
      setSrc(undefined)
      setBusy(false)
      setDiagnostic('Audio window request timed out. Scrub to retry.')
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
      setDiagnostic(result.diagnostics.join('; '))
    } catch (error) {
      if (!request.signal.aborted) { setSrc(undefined); setDiagnostic(error instanceof Error ? error.message : String(error)) }
    } finally {
      clearTimeout(deadline)
      if (!request.signal.aborted) setBusy(false)
    }
  }
  createEffect(on(() => props.media.audio ?? props.media.src, () => {
    const media = props.media
    abort?.abort()
    element?.pause()
    release()
    setBatch(media.audio?.initialBatch ?? 0); setTime(0); setNativeDuration(0); setWaveform(undefined); setPlaying(false)
    start = 0; span = 0; resume = false
    if (media.audio) void load(0, batch(), false)
    else { setSrc(media.src || undefined); setDiagnostic('Waveform and window playback require an executed AUDIO value.'); setBusy(false) }
  }))
  const play = async () => {
    try { await element?.play() }
    catch (error) { setDiagnostic(`Audio playback unavailable: ${error instanceof Error ? error.message : String(error)}`) }
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
    if (audioPlayhead()?.identity === (props.media.audio?.identity ?? props.media.src ?? '')) setAudioPlayhead(undefined)
    queueMicrotask(() => props.onActiveChange?.(false))
  })
  return <div class="audio-transport" classList={{ interactive: props.interactive !== false }}
    onFocusIn={() => { focused = true; active() }}
    onFocusOut={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { focused = false; active() } }}>
    <div class="audio-waveform">
      <Show when={waveform()} fallback={<span>Audio waveform</span>}>
        {(url) => <img src={url()} alt="Server audio waveform" onError={() => setDiagnostic('Audio waveform could not be decoded by this browser')} />}
      </Show>
      <span class="audio-playhead" style={{ left: `${duration() > 0 ? Math.min(100, time() / duration() * 100) : 0}%` }} />
    </div>
    <audio ref={element} src={src()} preload="metadata" onError={() => {
      setDiagnostic('Audio window cannot be played by this browser')
      if (!props.media.audio) props.onMediaError?.()
    }}
      onLoadedMetadata={() => { setNativeDuration(Number.isFinite(element?.duration) ? element!.duration : 0); if (element) element.volume = gain(); if (resume) { resume = false; void play() } }}
      onTimeUpdate={() => { setTime(start + (element?.currentTime ?? 0)); publish() }}
      onPlay={() => { setPlaying(true); active() }} onPause={() => { setPlaying(false); active() }} onEnded={ended} />
    <Show when={props.interactive !== false}>
      <div class="audio-transport-row">
        <button type="button" disabled={busy() || !src()} aria-label={playing() ? 'Pause audio' : 'Play audio'} onClick={() => {
          if (playing()) element?.pause()
          else if (element?.ended && props.media.audio) void load(0, batch(), true)
          else void play()
        }}>{playing() ? 'Pause' : 'Play'}</button>
        <ProductSlider ariaLabel="Audio position" min={0} max={duration()} step={0.01} value={time()} disabled={duration() <= 0 || (props.media.audio !== undefined && props.media.audio.canScrub !== true)}
          onInput={(position) => { void load(Math.min(position, Math.max(0, duration() - 0.01)), batch(), playing() || resume) }} />
        <span>{time().toFixed(1)} / {duration() > 0 ? duration().toFixed(1) : '?'}s</span>
      </div>
      <div class="audio-transport-row">
        <label><input type="checkbox" checked={loop()} onChange={(event) => setLoop(event.currentTarget.checked)} /> Loop</label>
        <label class="audio-gain">Gain <ProductSlider ariaLabel="Audio gain" min={0} max={1} step={0.01} value={gain()} onInput={(value) => { setGain(value); if (element) element.volume = value }} /></label>
        <Show when={batches() > 1}>
          <button type="button" aria-label="Previous audio batch" disabled={batch() === 0 || props.media.audio?.canSelectBatch !== true} onClick={() => { setBatch(batch() - 1); void load(0, batch(), false) }}>Previous</button>
          <span>Batch {batch() + 1}/{batches()}</span>
          <button type="button" aria-label="Next audio batch" disabled={batch() + 1 >= batches() || props.media.audio?.canSelectBatch !== true} onClick={() => { setBatch(batch() + 1); void load(0, batch(), false) }}>Next</button>
          <Show when={props.media.audio?.canSelectBatch !== true}><small>Batch selection not advertised by backend.</small></Show>
        </Show>
      </div>
    </Show>
    <div class="audio-facts"><For each={mediaMetadataOf('core.audio', meta())?.fields.filter((field) => ['sampleRateHz', 'channels', 'layout', 'durationSeconds'].includes(field.id))}>{(field) => <span>{message(`mediaInspector.metadata.${field.id}`)}: {field.value === undefined ? message('mediaInspector.metadata.notReported') : field.value}</span>}</For></div>
    <Show when={props.media.audio}><small>Window preview only. Loop and gain do not change the value.</small></Show>
    <Show when={busy() || diagnostic()}><div class="audio-diagnostic" role="status">{busy() ? 'Loading audio window...' : diagnostic()}</div></Show>
  </div>
}
