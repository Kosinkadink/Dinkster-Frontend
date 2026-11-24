import type { AssetRef, Json, JsonObject } from '@dinkster/core'
import {
  CanvasEditorButtons,
  CanvasEditorChoice,
  CanvasEditorLine,
  CanvasEditorNote,
  CanvasEditorNumber,
  CanvasEditorNumbers,
  CanvasEditorPicture,
  CanvasEditorSection,
  canvasEditorIcons,
} from '@dinkster/ui'
import { createEffect, createMemo, createSignal, on, onCleanup, Show, untrack } from 'solid-js'
import { Load3dSourceError, type Load3dSource, type Load3dSourceProblem } from './load3d-source.js'
import { useAppMessage } from './locale.js'
import type { Model3dCameraState, Model3dTransform, Model3dViewerHandle } from './model3d-viewer.js'

/** What the 3D view in a node needs from its host. */
export interface Load3dPorts {
  /** Reads the model the view shows. */
  readonly open: (signal: AbortSignal) => Promise<Load3dSource>
  /** Undefined when the backend cannot take uploads. */
  readonly upload: ((file: File, signal: AbortSignal) => Promise<AssetRef & JsonObject>) | undefined
  /** Writes the node's value as one Undo step. */
  readonly commit: (value: Json) => void
  /** Opens or closes one of the editor's own sections, kept with the node. */
  readonly setSection: (id: string, open: boolean) => void
}

type ViewState = 'loading' | 'ready' | Load3dSourceProblem
type RecordState = 'idle' | 'recording' | 'saving' | 'failed'

const object = (value: unknown): Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, Json> : {}
const plain = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json

/**
 * The 3D view's controls in the node: the view, dragged to orbit, Camera
 * projection, Field of view, and the Model placement and Animation sections.
 * Letting go of the camera or typing a placement number stores the view in
 * the node's value as one Undo step, with nothing uploaded. Only a view that
 * is live runs a WebGL context; the others show a still picture of the same
 * view, and pressing one makes it live. A view that gives pictures records
 * the viewport, stored when the recording stops.
 */
export function Load3dSpace(props: {
  readonly value: Json | undefined
  /** Changes when what the view reads changes, which reads it again. */
  readonly sourceKey: string
  readonly ports: Load3dPorts
  /** The node gives image, mask and normal pictures, so it records the viewport. */
  readonly captures: boolean
  /** This view may run a live WebGL view now. */
  readonly live: boolean
  /** Asks to make this still view live. */
  readonly onWake: () => void
  readonly openSections: readonly string[]
  /** The camera comes by wire: the view does not turn and shows the wire's camera. */
  readonly cameraWired: boolean
  /** The placement comes by wire. */
  readonly placementWired: boolean
}) {
  const message = useAppMessage()
  const [state, setState] = createSignal<ViewState>('loading')
  const [camera, setCamera] = createSignal<Model3dCameraState>()
  const [transform, setTransform] = createSignal<Model3dTransform>()
  const [clips, setClips] = createSignal<readonly { name: string; duration: number }[]>([])
  const [clip, setClip] = createSignal(0)
  const [time, setTime] = createSignal(0)
  const [speed, setSpeed] = createSignal(1)
  const [playing, setPlaying] = createSignal(false)
  const [poster, setPoster] = createSignal<ImageBitmap>()
  const [record, setRecord] = createSignal<RecordState>('idle')
  const [recordError, setRecordError] = createSignal<string>()
  let container: HTMLDivElement | undefined
  let viewer: Model3dViewerHandle | undefined
  let source: Load3dSource | undefined
  let take: Blob | undefined
  let recorder: MediaRecorder | undefined
  let upload: AbortController | undefined
  // The value this view last wrote, so a change from elsewhere (Undo) moves the view.
  let written: string | undefined

  const stored = () => object(props.value)
  const storedCamera = (): Model3dCameraState | undefined => {
    const wired = source?.inputValue('camera_info')
    const value = wired ?? stored()['camera_info']
    return value === undefined || value === null ? undefined : value as unknown as Model3dCameraState
  }
  const storedTransform = (): Model3dTransform | undefined => {
    const models = source?.inputValue('model_3d_info') ?? stored()['model_3d_info']
    return Array.isArray(models) && models[0] ? models[0] as unknown as Model3dTransform : undefined
  }
  const size = (part: 'width' | 'height'): number => {
    const value = source?.inputValue(part)
    return typeof value === 'number' ? value : 1024
  }

  /** Stores the view as it is now: the camera unless a wire gives it, and the placement. */
  const storeView = (): void => {
    if (viewer === undefined) return
    const value = stored()
    const models = Array.isArray(value['model_3d_info']) ? value['model_3d_info'] : []
    const next: Record<string, Json> = {
      ...value,
      ...(props.cameraWired ? {} : { camera_info: { ...object(value['camera_info']), ...object(plain(viewer.cameraState())) } }),
      ...(props.placementWired ? {} : { model_3d_info: [{ ...object(models[0]), ...object(plain(viewer.modelTransform())) }, ...models.slice(1)] }),
    }
    // A press that did not move the camera stores nothing.
    if (JSON.stringify(next) === JSON.stringify(value)) return
    written = JSON.stringify(next)
    props.ports.commit(next)
  }

  const release = (): void => {
    if (recorder?.state === 'recording') recorder.stop()
    recorder = undefined
    viewer?.dispose()
    viewer = undefined
    source?.release()
    source = undefined
    setCamera(undefined)
    setTransform(undefined)
    setClips([])
    setPlaying(false)
  }

  // A still picture is drawn again when the stored view changes; a live view moves instead.
  // A memo, so the view is read again only when what it reads really changes, not on every scene refresh.
  const reading = createMemo(() => JSON.stringify([props.sourceKey, props.live, props.live ? null : props.value ?? null]))
  createEffect(on(reading, () => {
    const live = untrack(() => props.live)
    const abort = new AbortController()
    setState('loading')
    onCleanup(() => {
      setPoster((image) => { image?.close(); return undefined })
      abort.abort()
      release()
    })
    void (async () => {
      const read = await props.ports.open(abort.signal)
      if (abort.signal.aborted) { read.release(); return }
      source = read
      const view = { ...(storedCamera() === undefined ? {} : { camera: storedCamera()! }), ...(storedTransform() === undefined ? {} : { transform: storedTransform()! }) }
      const { mountModel3dViewer, renderModel3dPoster } = await import('./model3d-viewer.js')
      if (abort.signal.aborted) return
      if (!live) {
        const still = await renderModel3dPoster(read.src, read.mime, { ...read.options, ...view })
        if (abort.signal.aborted) { still.image.close(); return }
        setPoster(still.image)
        setState('ready')
        return
      }
      if (container === undefined) return
      const mounted = await mountModel3dViewer(container, read.src, read.mime, { ...read.options, ...view })
      if (abort.signal.aborted) { mounted.dispose(); return }
      viewer = mounted
      written = JSON.stringify(props.value ?? null)
      setCamera(mounted.cameraState())
      setTransform(mounted.modelTransform())
      setClips(mounted.animationClips())
      mounted.onViewReleased(storeView)
      setState('ready')
    })().catch((reason: unknown) => {
      if (abort.signal.aborted) return
      setState(reason instanceof Load3dSourceError ? reason.problem : 'unavailable')
    })
  }))

  // A value written from elsewhere, such as by Undo, moves the live view to it.
  createEffect(on(() => props.value, (value) => {
    if (viewer === undefined || JSON.stringify(value ?? null) === written) return
    written = JSON.stringify(value ?? null)
    const cameraState = storedCamera()
    const placement = storedTransform()
    if (cameraState !== undefined) viewer.setCameraState(cameraState)
    if (placement !== undefined) viewer.setModelTransform(placement)
    setCamera(viewer.cameraState())
    setTransform(viewer.modelTransform())
  }, { defer: true }))

  onCleanup(() => upload?.abort())

  const changeCamera = (update: Partial<Model3dCameraState>): void => {
    if (viewer === undefined || props.cameraWired) return
    viewer.setCameraState({ ...viewer.cameraState(), ...update })
    setCamera(viewer.cameraState())
    storeView()
  }
  const changePlacement = (field: 'position' | 'quaternion' | 'scale', numbers: readonly number[]): void => {
    if (viewer === undefined || props.placementWired) return
    const current = viewer.modelTransform()
    const [x, y, z, w] = numbers as [number, number, number, number?]
    if (field === 'quaternion' && Math.hypot(x, y, z, w ?? 0) === 0) return
    viewer.setModelTransform({ ...current, [field]: field === 'quaternion' ? { x, y, z, w: w! } : { x, y, z } })
    setTransform(viewer.modelTransform())
    storeView()
  }
  const animate = (index: number, at: number, play: boolean, rate: number): void => {
    viewer?.setAnimation(index, at, play, rate)
    setClip(index)
    setTime(at)
    setPlaying(play)
    setSpeed(rate)
  }

  /** Uploads the finished recording and stores it on the node; a failed upload keeps it to try again. */
  const storeRecording = async (): Promise<void> => {
    const send = props.ports.upload
    if (take === undefined || send === undefined) return
    upload?.abort()
    const abort = new AbortController()
    upload = abort
    setRecord('saving')
    setRecordError(undefined)
    try {
      const file = new File([take], 'viewport-recording.webm', { type: take.type })
      const ref = await send(file, abort.signal)
      if (abort.signal.aborted) return
      take = undefined
      props.ports.commit({ ...stored(), recording: plain(ref) })
      setRecord('idle')
    } catch (reason) {
      if (abort.signal.aborted) return
      setRecordError(reason instanceof Error ? reason.message : String(reason))
      setRecord('failed')
    }
  }
  const toggleRecording = (): void => {
    if (record() === 'recording') {
      if (recorder?.state === 'recording') recorder.stop()
      return
    }
    if (viewer === undefined || typeof MediaRecorder === 'undefined') return
    try {
      const capture = viewer.recordingStream(size('width'), size('height'))
      const current = new MediaRecorder(capture.stream)
      recorder = current
      const chunks: Blob[] = []
      current.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
      current.onstop = () => {
        capture.stop()
        if (recorder !== current) return
        recorder = undefined
        take = new Blob(chunks, { type: current.mimeType })
        void storeRecording()
      }
      current.onerror = () => {
        capture.stop()
        if (recorder !== current) return
        recorder = undefined
        setRecordError(message('load3dWidget.recordingFailed'))
        setRecord('failed')
      }
      current.start()
      setRecord('recording')
      setRecordError(undefined)
    } catch (reason) {
      setRecordError(reason instanceof Error ? reason.message : String(reason))
      setRecord('failed')
    }
  }
  const discardRecording = (): void => {
    upload?.abort()
    take = undefined
    setRecordError(undefined)
    setRecord('idle')
  }

  const pictureMessage = (): string | undefined => {
    const shown = state()
    if (shown === 'ready') return undefined
    if (shown === 'native') return message('load3dWidget.native')
    return message(`inNodeLoad3d.${shown}`)
  }
  const ready = () => state() === 'ready'
  // A still view shows the stored view's settings; pressing the editor makes it live to change them.
  const shownCamera = () => camera() ?? (state() === 'ready' ? storedCamera() : undefined)
  const shownTransform = () => transform() ?? (state() === 'ready' ? storedTransform() : undefined)
  const wake = () => { if (!props.live && state() === 'ready') props.onWake() }
  const recordActions = () => {
    const status = record()
    if (status === 'saving') return [{ label: message('inNodeLoad3d.saving'), icon: canvasEditorIcons.record, pending: true }]
    if (status === 'failed' && take !== undefined) {
      return [
        { label: message('inNodeAudio.uploadAgain'), icon: canvasEditorIcons.retry, iconOnly: true, onClick: () => void storeRecording() },
        { label: message('inNodeAudio.discardClip'), icon: canvasEditorIcons.remove, iconOnly: true, intent: 'remove' as const, onClick: discardRecording },
      ]
    }
    return [status === 'recording'
      ? { label: message('load3dWidget.stopRecording'), icon: canvasEditorIcons.stop, intent: 'remove' as const, onClick: toggleRecording }
      : { label: message('load3dWidget.record'), icon: canvasEditorIcons.record, disabled: props.ports.upload === undefined, onClick: toggleRecording }]
  }
  const rounded = (numbers: readonly (number | undefined)[]): readonly number[] => numbers.map((number) => Number((number ?? 0).toFixed(3)))
  const clipName = (index: number) => clips()[index]?.name || message('load3dWidget.animationNumber', { number: index + 1 })
  return (
    <div class="node-load3d-editor" onPointerDown={wake}>
      <CanvasEditorPicture resizeLabel={message('inNodeEditor.pictureHeight')}
        loading={state() === 'loading'}
        {...(pictureMessage() === undefined ? {} : { message: pictureMessage()! })}
        {...(props.captures && !props.cameraWired && ready() ? {
          actions: (
            <>
              <Show when={record() === 'failed' && recordError() !== undefined}>
                <CanvasEditorNote tone="problem">{recordError()}</CanvasEditorNote>
              </Show>
              <CanvasEditorButtons buttons={recordActions()} />
            </>
          ),
        } : {})}>
        <div class="node-load3d-view" data-live={props.live ? 'true' : 'false'} data-wired={props.cameraWired ? 'true' : undefined}
          ref={(element) => { container = element }}>
          <Show when={!props.live ? poster() : undefined}>
            {(image) => <canvas
              ref={(element) => {
                // Sized here, before drawing: setting a canvas's size afterwards clears it.
                element.width = image().width
                element.height = image().height
                element.getContext('2d')?.drawImage(image(), 0, 0)
              }} />}
          </Show>
        </div>
      </CanvasEditorPicture>
      <CanvasEditorLine dimmed={!ready() || props.cameraWired}>
        <CanvasEditorChoice label={message('load3dWidget.camera')}
          value={message(shownCamera()?.cameraType === 'orthographic' ? 'load3dWidget.orthographic' : 'load3dWidget.perspective')}
          options={[message('load3dWidget.perspective'), message('load3dWidget.orthographic')]}
          onChange={(label) => changeCamera({ cameraType: label === message('load3dWidget.orthographic') ? 'orthographic' : 'perspective' })} />
      </CanvasEditorLine>
      <CanvasEditorLine dimmed={!ready() || props.cameraWired || shownCamera()?.cameraType === 'orthographic'}>
        <CanvasEditorNumber label={message('load3dWidget.fov')} value={shownCamera()?.fov} min={1} max={179} step={1}
          onChange={(fov) => changeCamera({ fov })} />
      </CanvasEditorLine>
      <CanvasEditorSection label={message('inNodeLoad3d.placement')} open={props.openSections.includes('placement')}
        onToggle={(open) => props.ports.setSection('placement', open)}>
        <CanvasEditorLine dimmed={!ready() || props.placementWired}>
          <CanvasEditorNumbers label={message('inNodeLoad3d.position')} count={3}
            value={rounded([shownTransform()?.position.x, shownTransform()?.position.y, shownTransform()?.position.z])}
            onChange={(numbers) => changePlacement('position', numbers)} />
        </CanvasEditorLine>
        <CanvasEditorLine dimmed={!ready() || props.placementWired}>
          <CanvasEditorNumbers label={message('inNodeLoad3d.rotation')} count={4}
            value={rounded([shownTransform()?.quaternion.x, shownTransform()?.quaternion.y, shownTransform()?.quaternion.z, shownTransform()?.quaternion.w ?? 1])}
            onChange={(numbers) => changePlacement('quaternion', numbers)} />
        </CanvasEditorLine>
        <CanvasEditorLine dimmed={!ready() || props.placementWired}>
          <CanvasEditorNumbers label={message('inNodeLoad3d.scale')} count={3}
            value={rounded([shownTransform()?.scale.x ?? 1, shownTransform()?.scale.y ?? 1, shownTransform()?.scale.z ?? 1])}
            onChange={(numbers) => changePlacement('scale', numbers)} />
        </CanvasEditorLine>
      </CanvasEditorSection>
      {/* Nothing of the animation is stored; its rows are there only for a model with clips. */}
      <CanvasEditorSection label={message('inNodeLoad3d.animation')} open={props.openSections.includes('animation')}
        onToggle={(open) => props.ports.setSection('animation', open)}>
        <CanvasEditorLine dimmed={clips().length === 0}>
          <CanvasEditorChoice label={message('inNodeLoad3d.clip')} value={clips().length === 0 ? '' : clipName(clip())}
            options={clips().map((_entry, index) => clipName(index))}
            onChange={(label) => {
              const index = clips().findIndex((_entry, at) => clipName(at) === label)
              if (index >= 0) animate(index, 0, playing(), speed())
            }} />
        </CanvasEditorLine>
        <CanvasEditorLine dimmed={clips().length === 0}>
          <CanvasEditorNumber label={message('inNodeLoad3d.time')} value={clips().length === 0 ? undefined : time()} min={0}
            max={clips()[clip()]?.duration ?? 0} step={0.1} precision={2}
            onChange={(at) => animate(clip(), at, playing(), speed())} />
        </CanvasEditorLine>
        <CanvasEditorLine dimmed={clips().length === 0}>
          <CanvasEditorNumber label={message('inNodeLoad3d.speed')} value={clips().length === 0 ? undefined : speed()} min={0.1} step={0.1} precision={1}
            onChange={(rate) => animate(clip(), viewer?.animationTime() ?? time(), playing(), rate)} />
        </CanvasEditorLine>
        <CanvasEditorButtons buttons={[{
          label: message(playing() ? 'load3dWidget.pauseAnimation' : 'load3dWidget.playAnimation'),
          icon: playing() ? canvasEditorIcons.stop : canvasEditorIcons.play,
          disabled: clips().length === 0,
          onClick: () => animate(clip(), viewer?.animationTime() ?? time(), !playing(), speed()),
        }]} />
      </CanvasEditorSection>
    </div>
  )
}
