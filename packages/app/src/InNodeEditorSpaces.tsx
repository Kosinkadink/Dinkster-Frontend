import type { AssetRef, Json, JsonObject } from '@dinkster/core'
import { defaultTokens, type LayoutRow } from '@dinkster/canvas'
import { audioRecordKind } from '@dinkster/widgets'
import {
  CanvasEditorButtons,
  CanvasEditorChoice,
  CanvasEditorLine,
  CanvasEditorNote,
  CanvasEditorNumber,
  CanvasEditorSpace,
  CanvasRecorderStrip,
  canvasEditorIcons,
} from '@dinkster/ui'
import { createSignal, onCleanup, Show, type JSX } from 'solid-js'
import { useAppMessage } from './locale.js'
import { overlayClipStyle, type EditorWorldRect } from './widget-editor-position.js'

type SpaceRow = Extract<LayoutRow, { kind: 'editorSpace' }>
type FieldRow = Extract<LayoutRow, { kind: 'widget' }>

/** An unfolded editor's space in a node of the canvas, in world coordinates. */
export interface EditorSpaceItem {
  readonly key: string
  readonly nodeId: string
  readonly row: SpaceRow
  /** The editor button row the space hangs under. */
  readonly field: FieldRow
  readonly node: EditorWorldRect
  /** The space within the node. */
  readonly space: EditorWorldRect
  readonly value: Json | undefined
}

/** The spaces of the scene's unfolded editors, each with its editor button row. */
export function editorSpaceItems(nodes: readonly {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly layout: { readonly width: number; readonly height: number; readonly minimized?: boolean; readonly rows: readonly LayoutRow[] }
  readonly node: { readonly values?: Readonly<Record<string, Json>> }
}[]): EditorSpaceItem[] {
  return nodes.flatMap((node) => {
    if (node.layout.minimized === true) return []
    return node.layout.rows.flatMap((row) => {
      if (row.kind !== 'editorSpace') return []
      const field = node.layout.rows.find((item): item is FieldRow => item.kind === 'widget' && item.valueKey === row.valueKey)
      if (field === undefined) return []
      return [{
        key: `${node.id}:${row.valueKey}`,
        nodeId: node.id,
        row,
        field,
        node: { x: node.x, y: node.y, width: node.layout.width, height: node.layout.height },
        space: { x: row.inset, y: row.y, width: row.width ?? node.layout.width - row.inset * 2, height: row.height },
        value: node.node.values?.[row.valueKey],
      }]
    })
  })
}

/**
 * The controls of one unfolded editor, laid over its space at the canvas's
 * normal size and scaled with the canvas. Wheel turns go to the canvas, so
 * the canvas zooms and pans over an editor as over the rest of the node.
 */
export function NodeEditorSpaceOverlay(props: {
  readonly item: EditorSpaceItem
  readonly rect: EditorWorldRect
  readonly scale: number
  readonly canvas: HTMLCanvasElement
  readonly children: JSX.Element
}) {
  const forwardWheel = (event: WheelEvent): void => {
    event.preventDefault()
    props.canvas.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: event.clientX,
      clientY: event.clientY,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    }))
  }
  return (
    <div class="node-editor-space-overlay" data-node-id={props.item.nodeId} data-value-key={props.item.row.valueKey}
      data-view-id={props.item.row.viewId} style={overlayClipStyle(props.rect, props.canvas)} onWheel={forwardWheel}>
      <div class="node-editor-space-world" style={{
        width: `${props.item.space.width}px`,
        height: `${props.item.space.height}px`,
        transform: `scale(${props.scale})`,
      }}>
        <CanvasEditorSpace ref={(element) => {
          element.style.inset = '0'
        }}>
          {props.children}
        </CanvasEditorSpace>
      </div>
    </div>
  )
}

/** Whether an editor's controls are live at this zoom; below it the canvas draws only its panel. */
export const editorSpaceInteractive = (scale: number): boolean => scale >= defaultTokens.mediaControlMinScale

export type AudioClip = AssetRef & JsonObject

/** What a recorder needs from its host: storing a take and writing the node's value. */
export interface AudioRecordPorts {
  /** Undefined when the backend cannot take uploads. */
  readonly upload: ((file: File, signal: AbortSignal) => Promise<AudioClip>) | undefined
  readonly fetchBytes: ((clip: AudioClip, signal: AbortSignal) => Promise<ArrayBuffer | undefined>) | undefined
  /** Writes the node's value as one Undo step. */
  readonly commit: (value: AudioClip | null) => void
}

export type AudioRecordStatus = 'idle' | 'waiting' | 'recording' | 'saving' | 'uploadFailed' | 'denied' | 'noMicrophone' | 'failed'

const WAVE_SAMPLES = 48
const SAMPLE_MS = 100
const MAX_BYTES = 32 * 1024 * 1024

const downsample = (samples: readonly number[], count: number): number[] => {
  if (samples.length <= count) return [...samples]
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index * samples.length) / count)
    const end = Math.max(start + 1, Math.floor(((index + 1) * samples.length) / count))
    let peak = 0
    for (let at = start; at < end; at += 1) peak = Math.max(peak, Math.abs(samples[at]!))
    return index % 2 === 0 ? peak : -peak
  })
}

/**
 * One node's microphone recorder. The host keeps it by tab, node and value
 * key, outside the editor's controls, so a take goes on while its editor is
 * folded or off the screen. A take is stored when it stops and written to
 * the node's value as one Undo step.
 */
export class AudioRecordController {
  readonly status: () => AudioRecordStatus
  private readonly setStatus: (status: AudioRecordStatus) => void
  readonly seconds: () => number
  private readonly setSeconds: (seconds: number) => void
  readonly bytes: () => number
  private readonly setBytes: (bytes: number) => void
  readonly waveform: () => readonly number[]
  private readonly setWaveform: (samples: readonly number[]) => void
  readonly error: () => string | undefined
  private readonly setError: (error: string | undefined) => void
  readonly devices: () => readonly { readonly deviceId: string; readonly label: string }[]
  private readonly setDevices: (devices: readonly { readonly deviceId: string; readonly label: string }[]) => void
  readonly device: () => string
  readonly setDevice: (deviceId: string) => void
  readonly limit: () => number
  readonly setLimit: (seconds: number) => void
  /** How long the stored clip is, when this recorder made it. */
  readonly clipSeconds: () => number | undefined
  private readonly setClipSeconds: (seconds: number | undefined) => void
  readonly playing: () => boolean
  private readonly setPlaying: (playing: boolean) => void

  private generation = 0
  private stream: MediaStream | undefined
  private recorder: MediaRecorder | undefined
  private context: AudioContext | undefined
  private ticker: ReturnType<typeof setInterval> | undefined
  private take: File | undefined
  private upload: AbortController | undefined
  private audio: HTMLAudioElement | undefined
  private audioUrl: string | undefined

  constructor(private ports: AudioRecordPorts) {
    ;[this.status, this.setStatus] = createSignal<AudioRecordStatus>('idle')
    ;[this.seconds, this.setSeconds] = createSignal(0)
    ;[this.bytes, this.setBytes] = createSignal(0)
    ;[this.waveform, this.setWaveform] = createSignal<readonly number[]>([])
    ;[this.error, this.setError] = createSignal<string>()
    ;[this.devices, this.setDevices] = createSignal<readonly { readonly deviceId: string; readonly label: string }[]>([])
    ;[this.device, this.setDevice] = createSignal('')
    ;[this.limit, this.setLimit] = createSignal(60)
    ;[this.clipSeconds, this.setClipSeconds] = createSignal<number>()
    ;[this.playing, this.setPlaying] = createSignal(false)
  }

  /** The host's latest ports: the node's value is written where it is now. */
  setPorts(ports: AudioRecordPorts): void {
    this.ports = ports
  }

  get canUpload(): boolean {
    return this.ports.upload !== undefined
  }

  async findMicrophones(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return
    const found = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput')
    this.setDevices(found.map((device) => ({ deviceId: device.deviceId, label: device.label })))
    if (found.length === 0) this.setStatus('noMicrophone')
    else if (this.status() === 'noMicrophone') this.setStatus('idle')
  }

  async record(): Promise<void> {
    const status = this.status()
    if (status === 'waiting' || status === 'recording' || status === 'saving' || !this.canUpload) return
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.setStatus('noMicrophone')
      return
    }
    this.stopPlaying()
    const request = ++this.generation
    this.take = undefined
    this.setError(undefined)
    this.setBytes(0)
    this.setSeconds(0)
    this.setWaveform([])
    this.setStatus('waiting')
    let opened: MediaStream
    try {
      const device = this.device()
      opened = await navigator.mediaDevices.getUserMedia({ audio: device ? { deviceId: { exact: device } } : true })
    } catch (reason) {
      if (request !== this.generation) return
      const name = reason instanceof Error ? reason.name : ''
      this.setStatus(name === 'NotAllowedError' ? 'denied' : name === 'NotFoundError' ? 'noMicrophone' : 'failed')
      return
    }
    if (request !== this.generation) {
      for (const track of opened.getTracks()) track.stop()
      return
    }
    this.stream = opened
    const recorder = new MediaRecorder(opened)
    this.recorder = recorder
    const chunks: Blob[] = []
    let bytes = 0
    const samples: number[] = []
    const context = typeof AudioContext === 'undefined' ? undefined : new AudioContext()
    this.context = context
    const analyser = context?.createAnalyser()
    if (context !== undefined && analyser !== undefined) {
      context.createMediaStreamSource(opened).connect(analyser)
      // Made after the permission prompt, the context may start suspended and read silence.
      void context.resume()
    }
    const frame = new Float32Array(analyser?.fftSize ?? 0)
    const started = Date.now()
    recorder.ondataavailable = (event) => {
      if (request !== this.generation) return
      bytes += event.data.size
      if (event.data.size > 0) chunks.push(event.data)
      this.setBytes(bytes)
      if (bytes > MAX_BYTES) this.stop()
    }
    recorder.onerror = () => {
      if (request !== this.generation) return
      this.release()
      this.setStatus('failed')
    }
    recorder.onstop = () => {
      if (request !== this.generation) return
      this.release()
      if (bytes === 0) {
        this.setStatus('failed')
        return
      }
      const type = (recorder.mimeType || chunks[0]?.type || 'audio/webm').split(';', 1)[0]!.trim().toLowerCase()
      const extension = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm'
      this.take = new File([new Blob(chunks, { type })], `recording.${extension}`, { type })
      this.setWaveform(downsample(samples, WAVE_SAMPLES))
      this.setClipSeconds(this.seconds())
      void this.store()
    }
    recorder.start(250)
    this.setStatus('recording')
    this.ticker = setInterval(() => {
      const seconds = (Date.now() - started) / 1000
      this.setSeconds(seconds)
      if (analyser !== undefined) {
        analyser.getFloatTimeDomainData(frame)
        let peak = 0
        for (const value of frame) peak = Math.max(peak, Math.abs(value))
        samples.push(samples.length % 2 === 0 ? peak : -peak)
        this.setWaveform(samples.slice(-WAVE_SAMPLES))
      }
      if (seconds >= this.limit()) this.stop()
    }, SAMPLE_MS)
  }

  /** Ends the take; it is then stored and written to the node. */
  stop(): void {
    clearInterval(this.ticker)
    this.ticker = undefined
    if (this.recorder?.state === 'recording') this.recorder.stop()
  }

  /** Drops the take being recorded or the one that failed to upload; the node keeps its value. */
  discard(): void {
    this.generation += 1
    this.upload?.abort()
    if (this.recorder?.state === 'recording') this.recorder.stop()
    this.release()
    this.take = undefined
    this.setWaveform([])
    this.setError(undefined)
    this.setStatus('idle')
  }

  /** Stores the finished take and writes it to the node's value. */
  async store(): Promise<void> {
    const take = this.take
    const upload = this.ports.upload
    if (take === undefined || upload === undefined) return
    const request = this.generation
    this.upload?.abort()
    const abort = new AbortController()
    this.upload = abort
    this.setError(undefined)
    this.setStatus('saving')
    try {
      const clip = await upload(take, abort.signal)
      if (request !== this.generation || abort.signal.aborted) return
      this.take = undefined
      this.ports.commit(clip)
      this.setStatus('idle')
    } catch (reason) {
      if (request !== this.generation || abort.signal.aborted) return
      this.setError(reason instanceof Error ? reason.message : String(reason))
      this.setStatus('uploadFailed')
    }
  }

  /** Clears the node's value; the clip stays in the project's assets. */
  remove(): void {
    this.stopPlaying()
    this.setWaveform([])
    this.setClipSeconds(undefined)
    this.ports.commit(null)
  }

  async play(clip: AudioClip): Promise<void> {
    if (this.playing()) {
      this.stopPlaying()
      return
    }
    const fetchBytes = this.ports.fetchBytes
    if (fetchBytes === undefined) return
    const request = this.generation
    this.setPlaying(true)
    try {
      const bytes = await fetchBytes(clip, new AbortController().signal)
      if (request !== this.generation || !this.playing() || bytes === undefined) {
        this.setPlaying(false)
        return
      }
      this.audioUrl = URL.createObjectURL(new Blob([bytes], { type: clip.mediaType }))
      const audio = new Audio(this.audioUrl)
      this.audio = audio
      audio.onended = () => this.stopPlaying()
      await audio.play()
    } catch {
      this.stopPlaying()
    }
  }

  stopPlaying(): void {
    this.audio?.pause()
    this.audio = undefined
    if (this.audioUrl !== undefined) URL.revokeObjectURL(this.audioUrl)
    this.audioUrl = undefined
    this.setPlaying(false)
  }

  dispose(): void {
    this.discard()
    this.stopPlaying()
  }

  private release(): void {
    clearInterval(this.ticker)
    this.ticker = undefined
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = undefined
    this.recorder = undefined
    void this.context?.close()
    this.context = undefined
  }
}

const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
const roundedSize = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const isClip = (value: Json | undefined): value is AudioClip =>
  value !== null && audioRecordKind.valueSchema.validate(value)

/** The recorder's controls in the node: the strip, the microphone, the limit and what is stored. */
export function AudioRecordSpace(props: { readonly controller: AudioRecordController; readonly value: Json | undefined }) {
  const message = useAppMessage()
  const recorder = props.controller
  const stored = () => isClip(props.value) ? props.value : undefined
  const shown = (): AudioRecordStatus | 'ready' => recorder.status() === 'idle' && stored() !== undefined ? 'ready' : recorder.status()
  const recording = () => recorder.status() === 'recording'
  const busy = () => recorder.status() === 'waiting' || recorder.status() === 'saving'
  const defaultLabel = () => message('inNodeAudio.defaultMicrophone')
  const deviceLabel = (device: { readonly deviceId: string; readonly label: string }, index: number) =>
    device.label || message('inNodeAudio.microphoneNumber', { number: index + 1 })
  const choices = () => [defaultLabel(), ...recorder.devices().map(deviceLabel)]
  const chosen = () => {
    const index = recorder.devices().findIndex((device) => device.deviceId === recorder.device())
    return index < 0 ? defaultLabel() : deviceLabel(recorder.devices()[index]!, index)
  }
  const actions = () => {
    const status = shown()
    if (status === 'ready') {
      const clip = stored()!
      return [
        { label: message(recorder.playing() ? 'inNodeAudio.stopPlaying' : 'inNodeAudio.play'),
          icon: recorder.playing() ? canvasEditorIcons.stop : canvasEditorIcons.play, onClick: () => void recorder.play(clip) },
        { label: message('inNodeAudio.removeClip'), icon: canvasEditorIcons.remove, intent: 'remove' as const, onClick: () => recorder.remove() },
      ]
    }
    if (status === 'uploadFailed') {
      return [
        { label: message('inNodeAudio.uploadAgain'), icon: canvasEditorIcons.retry, onClick: () => void recorder.store() },
        { label: message('inNodeAudio.discardClip'), icon: canvasEditorIcons.remove, intent: 'remove' as const, onClick: () => recorder.discard() },
      ]
    }
    if (status === 'recording') {
      return [{ label: message('inNodeAudio.discardTake'), icon: canvasEditorIcons.remove, intent: 'remove' as const, onClick: () => recorder.discard() }]
    }
    return []
  }
  const detail = () => {
    if (recording()) return `${clock(recorder.seconds())}, ${roundedSize(recorder.bytes())}`
    const seconds = recorder.clipSeconds()
    return (shown() === 'ready' || shown() === 'uploadFailed') && seconds !== undefined ? clock(seconds) : undefined
  }
  return (
    <Show when={recorder.canUpload} fallback={<CanvasEditorNote tone="muted" wrap>{message('audioRecordWidget.native')}</CanvasEditorNote>}>
      <CanvasRecorderStrip
        recording={recording()}
        roundLabel={message(recording() ? 'inNodeAudio.stop' : 'inNodeAudio.record')}
        roundDisabled={busy()}
        onRound={() => recording() ? recorder.stop() : void recorder.record()}
        status={message(`inNodeAudio.status.${shown()}`)}
        {...(detail() === undefined ? {} : { detail: detail()! })}
        waveform={recorder.waveform()}
        actions={actions()}
      />
      <CanvasEditorLine dimmed={recording() || busy()}>
        <CanvasEditorChoice label={message('inNodeAudio.microphone')} value={chosen()} options={choices()}
          onChange={(label) => {
            const index = recorder.devices().findIndex((device, at) => deviceLabel(device, at) === label)
            recorder.setDevice(index < 0 ? '' : recorder.devices()[index]!.deviceId)
          }} />
        <CanvasEditorButtons buttons={[{ label: message('inNodeAudio.findMicrophones'), icon: canvasEditorIcons.retry, iconOnly: true,
          onClick: () => void recorder.findMicrophones() }]} />
      </CanvasEditorLine>
      <CanvasEditorLine dimmed={recording() || busy()}>
        <CanvasEditorNumber label={message('inNodeAudio.limit')} value={recorder.limit()} min={1} max={300}
          onChange={(seconds) => recorder.setLimit(Math.round(seconds))} />
      </CanvasEditorLine>
      <Show when={shown() === 'uploadFailed'} fallback={
        <CanvasEditorNote tone={stored() === undefined ? 'muted' : undefined}>
          {stored() === undefined ? message('inNodeAudio.nothingStored') : message('inNodeAudio.stored', { name: stored()!.name ?? stored()!.digest })}
        </CanvasEditorNote>
      }>
        <CanvasEditorNote tone="problem">{recorder.error()}</CanvasEditorNote>
      </Show>
    </Show>
  )
}

/** Keeps one recorder per tab, node and value key for as long as the host lives. */
export function createAudioRecorders(): {
  readonly get: (key: string, ports: AudioRecordPorts) => AudioRecordController
} {
  const recorders = new Map<string, AudioRecordController>()
  onCleanup(() => {
    for (const recorder of recorders.values()) recorder.dispose()
    recorders.clear()
  })
  return {
    get: (key, ports) => {
      const existing = recorders.get(key)
      if (existing !== undefined) {
        existing.setPorts(ports)
        return existing
      }
      const created = new AudioRecordController(ports)
      recorders.set(key, created)
      return created
    },
  }
}
