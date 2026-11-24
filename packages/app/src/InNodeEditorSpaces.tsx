import type { AssetRef, Json, JsonObject } from '@dinkster/core'
import { canvasPaintTokens, clampPictureHeight, defaultTokens, IN_NODE_EDITORS, type EditorSummary, type EditorSummaryMap, type LayoutRow } from '@dinkster/canvas'
import { audioRecordKind, webcamKind } from '@dinkster/widgets'
import {
  CanvasAnglePicture,
  CanvasEditorButtons,
  CanvasEditorChoice,
  CanvasEditorLine,
  CanvasEditorNote,
  CanvasEditorNumber,
  CanvasEditorPicture,
  CanvasEditorSpace,
  CanvasRecorderStrip,
  canvasEditorIcons,
} from '@dinkster/ui'
import { createEffect, createSignal, on, onCleanup, Show, untrack, type JSX } from 'solid-js'
import { useAppMessage } from './locale.js'
import { frameFromVideo, webcamError, type WebcamDimensions } from './webcam.js'
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
  /** Where the editor's value is kept: its own row, or for an editor row the one row it writes. */
  readonly valueKey: string
  readonly value: Json | undefined
  /** The editor's input has a wire, so the wire decides its value. */
  readonly wired: boolean
  /** The parts of the widget whose rows have a wire, such as a 3D view's camera. */
  readonly wiredParts: ReadonlySet<string>
  /** What the wire brought in the last run, when it is known. */
  readonly carried: Json | undefined
  /** What each wired part's wire brought in the last run, when it is known. */
  readonly carriedParts: Readonly<Record<string, Json | undefined>>
}

/** How the scene's wires reach an editor's input. */
export interface EditorWires {
  readonly wired: (nodeId: string, inputId: string) => boolean
  readonly carried: (nodeId: string, valueKey: string) => Json | undefined
}

/** The spaces of the scene's unfolded editors, each with its editor button row. */
export function editorSpaceItems(nodes: readonly {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly layout: { readonly width: number; readonly height: number; readonly minimized?: boolean; readonly rows: readonly LayoutRow[] }
  readonly node: { readonly values?: Readonly<Record<string, Json>> }
}[], wires: EditorWires): EditorSpaceItem[] {
  return nodes.flatMap((node) => {
    if (node.layout.minimized === true) return []
    return node.layout.rows.flatMap((row) => {
      if (row.kind !== 'editorSpace') return []
      const field = node.layout.rows.find((item): item is FieldRow => item.kind === 'widget' && item.valueKey === row.valueKey)
      if (field === undefined) return []
      const written = field.editor === true && field.parts !== undefined ? Object.values(field.parts.writes) : []
      const valueKey = written.length === 1 ? written[0]! : row.valueKey
      const parts = field.parts === undefined ? [] : [...Object.entries(field.parts.reads), ...Object.entries(field.parts.writes)]
      return [{
        key: `${node.id}:${row.valueKey}`,
        nodeId: node.id,
        row,
        field,
        node: { x: node.x, y: node.y, width: node.layout.width, height: node.layout.height },
        // The controls stop at the editor's outline, above the row's bottom band.
        space: { x: row.inset, y: row.y, width: row.width ?? node.layout.width - row.inset * 2, height: row.height - defaultTokens.rowGeometry.fieldInsetY },
        valueKey,
        value: node.node.values?.[valueKey],
        wired: wires.wired(node.id, row.inputId),
        wiredParts: new Set(parts.flatMap(([part, partRow]) => wires.wired(node.id, partRow) ? [part] : [])),
        carried: wires.carried(node.id, row.valueKey),
        carriedParts: Object.fromEntries(parts.flatMap(([part, partRow]) =>
          wires.wired(node.id, partRow) ? [[part, wires.carried(node.id, partRow)]] : [])),
      }]
    })
  })
}

/**
 * What the row of an editor shown in the node shows while a wire decides its
 * value, folded or not: what the wire brought in the last run, read by its
 * name when it has one, or `notKnown` in the placeholder color before one.
 * The value stored under the wire is not shown.
 */
export function wiredEditorSummaries(nodes: readonly {
  readonly id: string
  readonly layout: { readonly rows: readonly LayoutRow[] }
}[], wires: EditorWires, notKnown: string): EditorSummaryMap {
  return Object.fromEntries(nodes.flatMap((node) => {
    const summaries = Object.fromEntries(node.layout.rows.flatMap((row): [string, EditorSummary][] => {
      if (row.kind !== 'widget' || IN_NODE_EDITORS[row.viewId] === undefined || !wires.wired(node.id, row.inputId)) return []
      const carried = wires.carried(node.id, row.valueKey)
      if (carried === undefined) return [[row.valueKey, { text: notKnown, placeholder: true, value: null }]]
      const named = typeof carried === 'object' && carried !== null && !Array.isArray(carried) ? (carried as JsonObject)['name'] : undefined
      const name = typeof carried === 'string' ? carried : typeof named === 'string' ? named : undefined
      return [[row.valueKey, name === undefined || name === '' ? { value: carried } : { text: name, value: carried }]]
    }))
    return Object.keys(summaries).length === 0 ? [] : [[node.id, summaries]]
  }))
}

/**
 * The controls of one unfolded editor, laid over its space at the canvas's
 * normal size and scaled with the canvas. Wheel turns go to the canvas and
 * never to the controls (a 3D view does not zoom on them), so the canvas
 * zooms and pans over an editor as over the rest of the node.
 */
export function NodeEditorSpaceOverlay(props: {
  readonly item: EditorSpaceItem
  readonly rect: EditorWorldRect
  readonly scale: number
  readonly canvas: HTMLCanvasElement
  /** The canvas paints the node at a dragged picture height, and stores it when the drag ends. */
  readonly pictureHeight: {
    readonly preview: (height: number | undefined) => void
    readonly commit: (height: number) => void
  }
  /** Screen rectangles the canvas draws in front of the editor, cut out of it. */
  readonly covers: readonly EditorWorldRect[]
  readonly children: JSX.Element
}) {
  // The picture's bottom edge is dragged, or stepped with the arrow keys, like a text box's.
  const [dragged, setDragged] = createSignal<number>()
  const stored = () => props.item.row.picture?.height ?? 0
  const shown = () => dragged() ?? stored()
  const grown = () => shown() - stored()
  let drag: { readonly pointerId: number; readonly y: number; readonly height: number } | undefined
  const resizeBar = (event: Event): HTMLElement | undefined =>
    event.target instanceof Element ? event.target.closest<HTMLElement>('.dinkster-canvas-editor-resize') ?? undefined : undefined
  const press = (event: PointerEvent): void => {
    const bar = resizeBar(event)
    if (bar === undefined || event.button !== 0 || props.item.row.picture === undefined) return
    event.preventDefault()
    event.stopPropagation()
    bar.setPointerCapture(event.pointerId)
    drag = { pointerId: event.pointerId, y: event.clientY, height: stored() }
  }
  const move = (event: PointerEvent): void => {
    if (drag?.pointerId !== event.pointerId) return
    const height = clampPictureHeight(drag.height + (event.clientY - drag.y) / props.scale)
    setDragged(height)
    props.pictureHeight.preview(height)
  }
  const release = (event: PointerEvent): void => {
    if (drag?.pointerId !== event.pointerId) return
    drag = undefined
    const height = dragged()
    setDragged(undefined)
    if (height === undefined || height === stored()) props.pictureHeight.preview(undefined)
    else props.pictureHeight.commit(height)
  }
  const step = (event: KeyboardEvent): void => {
    if (resizeBar(event) === undefined || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    event.stopPropagation()
    const height = clampPictureHeight(stored() + (event.key === 'ArrowDown' ? canvasPaintTokens.node.previewEdge.keyStep : -canvasPaintTokens.node.previewEdge.keyStep))
    if (height !== stored()) props.pictureHeight.commit(height)
  }
  const forwardWheel = (event: WheelEvent): void => {
    event.preventDefault()
    event.stopPropagation()
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
      data-view-id={props.item.row.viewId}
      style={overlayClipStyle({ ...props.rect, height: props.rect.height + grown() * props.scale }, props.canvas, props.covers)}
      ref={(element) => {
        element.addEventListener('wheel', forwardWheel, { capture: true, passive: false })
        element.addEventListener('pointerdown', press, { capture: true })
      }}
      onPointerMove={move} onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release} onKeyDown={step}>
      <div class="node-editor-space-world" style={{
        width: `${props.item.space.width}px`,
        height: `${props.item.space.height + grown()}px`,
        transform: `scale(${props.scale})`,
        '--node-editor-picture-height': `${shown()}px`,
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
    navigator.mediaDevices?.addEventListener?.('devicechange', this.onDeviceChange)
  }

  /** The microphone list follows the devices the browser reports, with no button to look for them. */
  private readonly onDeviceChange = (): void => {
    void this.findMicrophones()
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
    // A device that went away is no longer the chosen one.
    if (!found.some((device) => device.deviceId === this.device())) this.setDevice('')
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
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange)
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
          onOpen={() => void recorder.findMicrophones()}
          onChange={(label) => {
            const index = recorder.devices().findIndex((device, at) => deviceLabel(device, at) === label)
            recorder.setDevice(index < 0 ? '' : recorder.devices()[index]!.deviceId)
          }} />
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

export type StoredFrame = AssetRef & JsonObject

const isFrame = (value: Json | undefined): value is StoredFrame =>
  value !== undefined && value !== null && webcamKind.valueSchema.validate(value)

/** A stored picture's object URL while it is shown; nothing while it loads or when it cannot be read. */
function useAssetUrl(asset: () => StoredFrame | undefined, fetchBytes: (() => ((asset: StoredFrame, signal: AbortSignal) => Promise<ArrayBuffer | undefined>) | undefined)) {
  const [url, setUrl] = createSignal<string>()
  createEffect(on(() => asset()?.digest, () => {
    const shown = asset()
    const fetch = fetchBytes()
    setUrl(undefined)
    if (shown === undefined || fetch === undefined) return
    const abort = new AbortController()
    let owned: string | undefined
    void fetch(shown, abort.signal).then((bytes) => {
      if (abort.signal.aborted || bytes === undefined) return
      owned = URL.createObjectURL(new Blob([bytes], { type: shown.mediaType }))
      setUrl(owned)
    }).catch(() => undefined)
    onCleanup(() => {
      abort.abort()
      if (owned !== undefined) URL.revokeObjectURL(owned)
    })
  }))
  return url
}

/** What the webcam editor needs from its host. */
export interface WebcamPorts {
  /** Undefined when the backend cannot take uploads. */
  readonly upload: ((file: File, signal: AbortSignal) => Promise<StoredFrame>) | undefined
  readonly fetchBytes: ((frame: StoredFrame, signal: AbortSignal) => Promise<ArrayBuffer | undefined>) | undefined
  /** The node's width and height for the frame, when its rows give them. */
  readonly size: () => WebcamDimensions
  /** Writes the node's value as one Undo step. */
  readonly commit: (value: StoredFrame) => void
}

type CameraState = 'off' | 'starting' | 'live' | 'capturing' | 'error'

/**
 * The webcam's controls in the node: the picture, Start camera (or Capture
 * frame and Stop while the camera is live) and what is stored. The camera
 * runs only while these controls are shown, so folding the editor, leaving
 * the screen or zooming out turns it off. A wired image is the wire's: the
 * camera does not start, and the picture shows the last run's image.
 */
export function WebcamSpace(props: {
  readonly value: Json | undefined
  readonly ports: WebcamPorts
  readonly wired: boolean
  /** What the wire brought in the last run, when it is known. */
  readonly carried: Json | undefined
  /** Something is drawn in front of the editor; a live camera turns off. */
  readonly covered: boolean
}) {
  const message = useAppMessage()
  const [camera, setCamera] = createSignal<CameraState>('off')
  const [error, setError] = createSignal<string>()
  let stream: MediaStream | undefined
  let video: HTMLVideoElement | undefined
  let abort: AbortController | undefined
  const stored = () => isFrame(props.value) ? props.value : undefined
  const carried = () => isFrame(props.carried) ? props.carried : undefined
  const shown = useAssetUrl(() => props.wired ? carried() : stored(), () => props.ports.fetchBytes)
  const live = () => camera() === 'live' || camera() === 'capturing'
  const release = () => {
    abort?.abort()
    abort = undefined
    for (const track of stream?.getTracks() ?? []) track.stop()
    stream = undefined
    if (video !== undefined) video.srcObject = null
  }
  onCleanup(release)
  const start = async () => {
    if (props.wired || camera() !== 'off' && camera() !== 'error') return
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(webcamError(new DOMException('Camera capture requires a secure browser context.', 'NotSupportedError')))
      setCamera('error')
      return
    }
    setError(undefined)
    setCamera('starting')
    try {
      const opened = await navigator.mediaDevices.getUserMedia({ audio: false, video: true })
      if (camera() !== 'starting') {
        for (const track of opened.getTracks()) track.stop()
        return
      }
      stream = opened
      setCamera('live')
    } catch (reason) {
      setError(webcamError(reason))
      setCamera('error')
    }
  }
  const stop = () => {
    release()
    setCamera('off')
  }
  // Covered, the camera turns off as it does when its node leaves the screen.
  createEffect(() => {
    if (props.covered && untrack(camera) !== 'off' && untrack(camera) !== 'error') stop()
  })
  const capture = async () => {
    const upload = props.ports.upload
    if (camera() !== 'live' || video === undefined || upload === undefined) return
    setCamera('capturing')
    setError(undefined)
    abort = new AbortController()
    const signal = abort.signal
    try {
      const file = await frameFromVideo(video, props.ports.size())
      const frame = await upload(file, signal)
      if (signal.aborted) return
      props.ports.commit(frame)
      setCamera('live')
    } catch (reason) {
      if (signal.aborted) return
      setError(webcamError(reason))
      setCamera('live')
    }
  }
  const pictureMessage = () => {
    if (props.wired) return carried() === undefined ? message('inNodeWebcam.notKnown') : undefined
    if (camera() === 'error') return error()
    if (live() || camera() === 'starting') return undefined
    return stored() === undefined ? message('inNodeWebcam.noFrame') : undefined
  }
  const note = () => {
    if (props.wired) return carried() === undefined ? message('inNodeWebcam.byWire') : message('inNodeWebcam.lastRun')
    if (props.ports.upload === undefined) return message('inNodeWebcam.native')
    if (camera() !== 'error' && error() !== undefined) return error()
    return stored() === undefined ? message('inNodeWebcam.nothingStored') : message('inNodeWebcam.stored', { name: stored()!.name ?? stored()!.digest })
  }
  const noteTone = () => props.wired ? (carried() === undefined ? 'muted' : undefined)
    : props.ports.upload === undefined || (stored() === undefined && error() === undefined) ? 'muted'
      : camera() !== 'error' && error() !== undefined ? 'problem' : undefined
  return (
    <>
      <CanvasEditorPicture resizeLabel={message('inNodeEditor.pictureHeight')}
        loading={camera() === 'starting'}
        {...(pictureMessage() === undefined ? {} : { message: pictureMessage()! })}>
        <Show when={live()} fallback={
          <Show when={pictureMessage() === undefined && camera() !== 'starting' ? shown() : undefined}>
            {(url) => <img src={url()} alt={message('webcam.preview')} />}
          </Show>
        }>
          <video ref={(element) => {
            video = element
            element.srcObject = stream ?? null
            void element.play().catch(() => undefined)
          }} muted playsinline autoplay />
        </Show>
      </CanvasEditorPicture>
      <CanvasEditorButtons buttons={live()
        ? [
            { label: message(camera() === 'capturing' ? 'webcam.capturing' : 'webcam.capture'), icon: canvasEditorIcons.capture,
              pending: camera() === 'capturing', disabled: props.ports.upload === undefined, onClick: () => void capture() },
            { label: message('inNodeWebcam.stop'), icon: canvasEditorIcons.stop, intent: 'remove', onClick: stop },
          ]
        : [{ label: message('inNodeWebcam.start'), icon: canvasEditorIcons.capture,
            disabled: props.wired || camera() === 'starting' || props.ports.upload === undefined, onClick: () => void start() }]} />
      <CanvasEditorNote tone={noteTone()}>{note()}</CanvasEditorNote>
    </>
  )
}

export const CAMERA_ANGLE_PARTS = ['horizontal_angle', 'vertical_angle', 'zoom'] as const
export type CameraAnglePart = typeof CAMERA_ANGLE_PARTS[number]

/** One field of a camera angle: its number when known, and whether a wire decides it. */
export interface CameraAngleField {
  readonly value: number | undefined
  readonly wired: boolean
}

const CAMERA_SIDES = ['front', 'frontRight', 'right', 'backRight', 'back', 'backLeft', 'left', 'frontLeft'] as const

/** The camera's place in a few words: its side in steps of 45 degrees, its height, and its zoom. */
export function cameraAngleWords(message: ReturnType<typeof useAppMessage>, horizontal: number, vertical: number, zoom: number): string {
  const side = CAMERA_SIDES[Math.round((((horizontal % 360) + 360) % 360) / 45) % 8]!
  // The heights are the node's own shot bands: low-angle, eye-level, elevated and high-angle.
  const height = vertical < -15 ? 'below' : vertical < 15 ? 'level' : vertical < 45 ? 'littleAbove' : 'highAbove'
  return message('inNodeCameraAngle.place', {
    side: message(`inNodeCameraAngle.side.${side}`),
    height: message(`inNodeCameraAngle.height.${height}`),
    zoom: zoom.toFixed(1),
  })
}

/**
 * The camera angle's picture in the node, above the node's own three number
 * fields: dragging the ring's dot writes horizontal_angle and the elevation's
 * dot vertical_angle, each drag one change when it ends. A wired angle's dot
 * is hollow at the value its wire brought and does not move, or missing
 * before a run; the line under the picture names the camera's place.
 */
export function CameraAngleSpace(props: {
  readonly fields: Readonly<Record<CameraAnglePart, CameraAngleField>>
  readonly commit: (part: 'horizontal_angle' | 'vertical_angle', value: number) => void
}) {
  const message = useAppMessage()
  const [draft, setDraft] = createSignal<{ readonly part: 'horizontal_angle' | 'vertical_angle'; readonly value: number }>()
  const value = (part: CameraAnglePart): number | undefined => {
    const moving = draft()
    return moving !== undefined && moving.part === part ? moving.value : props.fields[part].value
  }
  const angle = (part: 'horizontal_angle' | 'vertical_angle') => ({ degrees: value(part), fixed: props.fields[part].wired })
  const place = () => {
    const [horizontal, vertical, zoom] = CAMERA_ANGLE_PARTS.map(value)
    return horizontal === undefined || vertical === undefined || zoom === undefined
      ? undefined : cameraAngleWords(message, horizontal, vertical, zoom)
  }
  return (
    <>
      <CanvasEditorPicture resizeLabel={message('inNodeEditor.pictureHeight')}>
        <CanvasAnglePicture label={message('cameraAngleWidget.preview')}
          horizontal={angle('horizontal_angle')} vertical={angle('vertical_angle')}
          onMove={(part, degrees) => setDraft({ part: part === 'horizontal' ? 'horizontal_angle' : 'vertical_angle', value: degrees })}
          onMoveEnd={() => {
            const moved = draft()
            setDraft(undefined)
            if (moved !== undefined && moved.value !== props.fields[moved.part].value) props.commit(moved.part, moved.value)
          }} />
      </CanvasEditorPicture>
      <CanvasEditorNote tone={place() === undefined ? 'muted' : undefined}>{place() ?? message('inNodeCameraAngle.notKnown')}</CanvasEditorNote>
    </>
  )
}
