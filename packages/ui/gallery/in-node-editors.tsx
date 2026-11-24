import { For, Show, createEffect, createSignal, onCleanup, untrack, type JSX } from 'solid-js'
import type { WidgetRegistry } from '@dinkster/core'
import {
  CanvasRenderer,
  canvasColorsForTheme,
  canvasPaintTokens,
  canvasTypePaintForTheme,
  createRegistryPainter,
  defaultTokens,
  type DesignTokens,
  type LayoutRow,
  type Scene,
  type TextMeasurer,
  type WidgetMeasure,
} from '@dinkster/canvas'
import { createWidgetRegistry, curveInterpolator, registerCoreWidgets, widgetRegistrationDoors } from '@dinkster/widgets'
import {
  GALLERY_NODE_WIDTH,
  createInNodeEditorScene,
  inNodeEditorExamples,
  type EditorExampleState,
  type InNodeEditorExample,
} from '../../canvas/gallery/in-node-editors.js'
import {
  CanvasAnglePicture,
  CanvasCurvePlot,
  CanvasEditorButtons,
  CanvasEditorChoice,
  CanvasEditorFact,
  CanvasEditorLine,
  CanvasEditorNote,
  CanvasEditorNumber,
  CanvasEditorNumbers,
  CanvasEditorPicture,
  CanvasEditorSection,
  CanvasEditorSpace,
  CanvasRecorderStrip,
  ProductSection,
  canvasEditorIcons,
  type CanvasCurveStrip,
} from '../src/index.js'
import { MARGIN } from './row-editing.js'

type SpaceRow = Extract<LayoutRow, { kind: 'editorSpace' }>

const str = (state: EditorExampleState, key: string): string | undefined =>
  typeof state[key] === 'string' ? (state[key] as string) : undefined
const num = (state: EditorExampleState, key: string): number | undefined =>
  typeof state[key] === 'number' ? (state[key] as number) : undefined

const NO_BACKEND = 'Recording uploads require a native Dinkster backend.'

/** The height the no-backend sentence takes at an editor's inner width, as the page draws it. */
function noBackendHeight(width: number): number {
  const probe = document.createElement('div')
  probe.className = 'dinkster-canvas-editor'
  // Off the page; the editor's own padding is added to the inner width.
  probe.style.left = '-10000px'
  probe.style.width = `${width + canvasPaintTokens.node.editorSpace.pad * 2}px`
  const note = document.createElement('div')
  note.className = 'dinkster-canvas-editor-note'
  note.dataset['wrap'] = 'true'
  note.textContent = NO_BACKEND
  probe.append(note)
  document.body.append(probe)
  const height = note.offsetHeight
  probe.remove()
  return height
}

/** A rounded size, never raw bytes. */
const roundedSize = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

/** A fixed still standing for a picture: a captured frame, a turned model, or the run's images. */
function Still(props: { kind: 'frame' | 'model' | 'live' | 'image-a' | 'compare' }) {
  return (
    <svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect class="dinkster-gallery-still-back" data-kind={props.kind} x="0" y="0" width="320" height="180" />
      <Show when={props.kind === 'compare'}>
        <rect class="dinkster-gallery-still-back" data-kind="image-b" x="160" y="0" width="160" height="180" />
        <line class="dinkster-gallery-still-divider" x1="160" y1="0" x2="160" y2="180" />
        <circle class="dinkster-gallery-still-handle" cx="160" cy="90" r="9" />
      </Show>
      <Show when={props.kind === 'model'}>
        <path class="dinkster-gallery-still-shape" d="M 130 60 L 200 45 L 205 125 L 135 140 Z" />
        <path class="dinkster-gallery-still-light" d="M 130 60 L 200 45 L 180 30 L 112 44 Z" />
      </Show>
      <Show when={props.kind === 'frame' || props.kind === 'live' || props.kind === 'image-a'}>
        <circle class="dinkster-gallery-still-shape" cx="160" cy="82" r="34" />
        <rect class="dinkster-gallery-still-shape" x="112" y="120" width="96" height="60" rx="20" />
      </Show>
    </svg>
  )
}

/** A small stand-in for a stored frame or a last 3D view, drawn in the canvas's own colors. */
function thumbnailOf(kind: 'frame' | 'view', tokens: DesignTokens): HTMLCanvasElement {
  const image = document.createElement('canvas')
  image.width = 32
  image.height = 32
  const context = image.getContext('2d')!
  context.fillStyle = tokens.colors.nodeHeader
  context.fillRect(0, 0, 32, 32)
  context.fillStyle = tokens.colors.selection
  context.beginPath()
  if (kind === 'frame') {
    context.arc(16, 13, 7, 0, Math.PI * 2)
    context.fill()
    context.fillRect(7, 22, 18, 10)
  } else {
    context.moveTo(9, 11); context.lineTo(21, 8); context.lineTo(23, 22); context.lineTo(11, 25)
    context.closePath()
    context.fill()
  }
  return image
}

/** The wired histograms of the curve's examples, as bar heights, by the name an example's state gives. */
const GALLERY_HISTOGRAMS: Readonly<Record<string, readonly number[]>> = {
  rising: Array.from({ length: 30 }, (_, index) => 0.12 + Math.abs(Math.sin(index / 4)) * 0.55),
  falling: Array.from({ length: 30 }, (_, index) => 0.08 + Math.max(0, 1 - index / 22) * 0.8),
}

/** An editor's own number in an example: it steps and is typed in, and keeps what it was given. */
function GalleryNumber(props: { label: string; value: number | undefined; min?: number; max?: number; step?: number; precision?: number }) {
  const [value, setValue] = createSignal(untrack(() => props.value))
  return <CanvasEditorNumber {...props} value={value()} onChange={setValue} />
}

/** An editor's own choice in an example: it opens in place and keeps what is picked. */
function GalleryChoice(props: { label: string; value: string; options: readonly string[] }) {
  const [value, setValue] = createSignal(untrack(() => props.value))
  return <CanvasEditorChoice {...props} value={value()} onChange={setValue} />
}

/** A few numbers of an editor's own in an example, kept as one value. */
function GalleryNumbers(props: { label: string; value: readonly number[] }) {
  const [value, setValue] = createSignal(untrack(() => props.value))
  return <CanvasEditorNumbers label={props.label} count={props.value.length} value={value()} onChange={setValue} />
}

/** What one unfolded editor's controls show in an example, by its view. */
function EditorBody(props: { row: SpaceRow; example: InNodeEditorExample; declared: Readonly<Record<string, unknown>> }): JSX.Element {
  const state = (): EditorExampleState => props.example.states?.[props.row.valueKey] ?? {}
  const stored = () => props.example.values?.[props.row.valueKey] as { name?: string } | undefined
  const picture = (content: JSX.Element, extra: { message?: string; loading?: boolean; actions?: JSX.Element } = {}) => (
    <CanvasEditorPicture
      ref={(element) => { element.style.height = `${props.row.picture?.height ?? 0}px` }}
      resizeLabel="Picture height"
      {...extra}
    >
      {content}
    </CanvasEditorPicture>
  )
  switch (props.row.viewId) {
    case 'core.audioRecord': {
      const status = () => str(state(), 'status') ?? (stored() ? 'ready' : 'idle')
      const recording = () => status() === 'recording'
      const seconds = () => num(state(), 'seconds') ?? 7
      const words: Record<string, string> = {
        idle: 'Microphone off', waiting: 'Waiting for permission', recording: 'Listening...', saving: 'Saving',
        ready: 'Ready', denied: 'Permission denied', uploadFailed: 'Upload failed', noMicrophone: 'No microphone found',
      }
      if (status() === 'noBackend') return <CanvasEditorNote tone="muted" wrap>{NO_BACKEND}</CanvasEditorNote>
      const actions = () => status() === 'ready'
        ? [{ label: 'Play', icon: canvasEditorIcons.play }, { label: 'Remove clip', icon: canvasEditorIcons.remove, intent: 'remove' as const }]
        : status() === 'uploadFailed'
          ? [{ label: 'Upload again', icon: canvasEditorIcons.retry }, { label: 'Discard clip', icon: canvasEditorIcons.remove, intent: 'remove' as const }]
          : recording()
            ? [{ label: 'Discard take', icon: canvasEditorIcons.remove, intent: 'remove' as const }]
            : []
      const wave = () => recording() || status() === 'ready' || status() === 'uploadFailed'
        ? Array.from({ length: 48 }, (_, index) => Math.sin(index * 0.9) * (0.3 + 0.5 * Math.abs(Math.sin(index / 7))))
        : []
      return (
        <>
          <CanvasRecorderStrip
            recording={recording()}
            roundLabel={recording() ? 'Stop' : 'Record'}
            roundDisabled={status() === 'waiting' || status() === 'saving'}
            status={words[status()] ?? status()}
            {...(recording() ? { detail: `${clock(seconds())}, ${roundedSize(num(state(), 'bytes') ?? 0)}` }
              : status() === 'ready' || status() === 'uploadFailed' ? { detail: '0:07' } : {})}
            waveform={wave()}
            actions={actions()}
          />
          <CanvasEditorLine dimmed={recording()}>
            <GalleryChoice label="Microphone" value="Default microphone" options={['Default microphone', 'USB microphone']} />
          </CanvasEditorLine>
          <CanvasEditorLine dimmed={recording()}>
            <GalleryNumber label="Limit (s)" value={60} min={1} max={300} />
          </CanvasEditorLine>
          <Show when={status() === 'uploadFailed'} fallback={
            <CanvasEditorNote tone={stored() ? undefined : 'muted'}>{stored() ? `Stored: ${stored()!.name}` : 'Nothing stored'}</CanvasEditorNote>
          }>
            <CanvasEditorNote tone="problem">{str(state(), 'error')}</CanvasEditorNote>
          </Show>
        </>
      )
    }
    case 'core.webcam': {
      const camera = () => str(state(), 'camera') ?? 'off'
      const message = () => camera() === 'error' ? str(state(), 'error')
        : camera() === 'wired' ? state()['known'] === false ? 'Not known yet' : undefined
          : camera() === 'off' && !stored() ? 'No frame stored yet' : undefined
      return (
        <>
          {picture(
            <Show when={message() === undefined}>
              <Still kind={camera() === 'live' || camera() === 'capturing' ? 'live' : 'frame'} />
            </Show>,
            message() === undefined ? {} : { message: message()! },
          )}
          <CanvasEditorButtons buttons={camera() === 'live' || camera() === 'capturing'
            ? [
                { label: camera() === 'capturing' ? 'Capturing...' : 'Capture frame', icon: canvasEditorIcons.capture, pending: camera() === 'capturing' },
                { label: 'Stop', icon: canvasEditorIcons.stop, intent: 'remove' },
              ]
            : [{ label: 'Start camera', icon: canvasEditorIcons.capture, disabled: camera() === 'wired' }]} />
          <CanvasEditorNote tone={stored() || (camera() === 'wired' && state()['known'] !== false) ? undefined : 'muted'}>
            {camera() === 'wired' ? state()['known'] === false ? 'Comes by wire' : 'The image from the last run'
              : stored() ? `Stored: ${stored()!.name}` : 'Nothing stored'}
          </CanvasEditorNote>
        </>
      )
    }
    case 'core.load3d': {
      const view = () => str(state(), 'view') ?? 'none'
      const wired = () => state()['wired'] === true
      const messages: Record<string, string> = {
        none: 'No model chosen', loading: 'Loading model', unavailable: 'Model unavailable', unknown: 'Not known yet',
      }
      const open = (id: string) => props.row.openSections?.includes(id) === true
      return (
        <>
          {picture(
            <Show when={view() === 'model'}><Still kind="model" /></Show>,
            {
              ...(messages[view()] !== undefined ? { message: messages[view()]! } : {}),
              ...(view() === 'loading' ? { loading: true } : {}),
              ...(!wired() && view() === 'model'
                ? { actions: (
                    <>
                      <Show when={str(state(), 'notice')}>{(notice) => <CanvasEditorNote>{notice()}</CanvasEditorNote>}</Show>
                      <CanvasEditorButtons buttons={[state()['recording'] === true
                        ? { label: 'Stop recording', icon: canvasEditorIcons.stop, intent: 'remove' }
                        : { label: 'Record viewport', icon: canvasEditorIcons.record }]} />
                    </>
                  ) }
                : {}),
            },
          )}
          <CanvasEditorLine dimmed={wired() || view() !== 'model'}>
            <GalleryChoice label="Camera projection" value="Perspective" options={['Perspective', 'Orthographic']} />
          </CanvasEditorLine>
          <CanvasEditorLine dimmed={wired() || view() !== 'model'}>
            <GalleryNumber label="Field of view" value={35} min={10} max={150} />
          </CanvasEditorLine>
          <CanvasEditorSection label="Model placement" open={open('placement')}>
            <CanvasEditorLine><GalleryNumbers label="Position X Y Z" value={[0, 0, 0]} /></CanvasEditorLine>
            <CanvasEditorLine><GalleryNumbers label="Rotation X Y Z W" value={[0, 0, 0, 1]} /></CanvasEditorLine>
            <CanvasEditorLine><GalleryNumbers label="Scale X Y Z" value={[1, 1, 1]} /></CanvasEditorLine>
          </CanvasEditorSection>
          <CanvasEditorSection label="Animation" open={open('animation')}>
            <CanvasEditorLine><GalleryChoice label="Clip" value="Walk" options={['Walk', 'Run', 'Idle']} /></CanvasEditorLine>
            <CanvasEditorLine><GalleryNumber label="Time (s)" value={0.4} min={0} step={0.1} precision={2} /></CanvasEditorLine>
            <CanvasEditorLine><GalleryNumber label="Speed" value={1} min={0} step={0.1} precision={1} /></CanvasEditorLine>
            <CanvasEditorButtons buttons={[{ label: 'Play animation', icon: canvasEditorIcons.play }]} />
          </CanvasEditorSection>
        </>
      )
    }
    case 'core.imageCompare': {
      const images = () => num(state(), 'images') ?? 0
      return (
        <>
          {picture(
            <Show when={images() > 0}><Still kind={images() === 2 ? 'compare' : 'image-a'} /></Show>,
            images() === 0 ? { message: 'Run to compare' } : {},
          )}
          <CanvasEditorLine dimmed={images() < 2}><GalleryNumber label="Wipe divider (%)" value={50} min={0} max={100} /></CanvasEditorLine>
          <CanvasEditorLine dimmed={images() < 1}>
            <GalleryChoice label="Image A frame" value={images() > 0 ? '1 of 1' : 'No images'} options={images() > 0 ? ['1 of 1'] : []} />
          </CanvasEditorLine>
          <CanvasEditorLine dimmed={images() < 2}>
            <GalleryChoice label="Image B frame" value={images() > 1 ? '1 of 1' : 'No images'} options={images() > 1 ? ['1 of 1'] : []} />
          </CanvasEditorLine>
        </>
      )
    }
    case 'core.cameraAngle': {
      const wired = () => str(state(), 'wired')
      const known = () => state()['known'] !== false
      return (
        <>
          {picture(
            <CanvasAnglePicture
              horizontal={{ degrees: wired() === 'horizontal_angle' && !known() ? undefined : wired() === 'horizontal_angle' ? 120 : 45,
                fixed: wired() === 'horizontal_angle' }}
              vertical={{ degrees: 20, fixed: false }}
            />,
          )}
          <CanvasEditorNote tone={wired() !== undefined && !known() ? 'muted' : undefined}>
            {wired() !== undefined && !known() ? 'Not known yet'
              : wired() === 'horizontal_angle' ? 'Back right, a little above, zoom 5.0' : 'Front right, a little above, zoom 5.0'}
          </CanvasEditorNote>
        </>
      )
    }
    case 'core.curve': {
      const value = props.example.values?.[props.row.valueKey] as
        { interpolation?: 'linear' | 'monotone_cubic'; points?: { position: number; value: number }[] } | undefined
      const interpolation = value?.interpolation ?? 'monotone_cubic'
      const points = value?.points ?? []
      const selected = num(state(), 'selected')
      const strip = (key: string): CanvasCurveStrip | undefined => {
        const colors = props.declared[key]
        return Array.isArray(colors) && colors.length === 2 && colors.every((color) => typeof color === 'string')
          ? [colors[0] as string, colors[1] as string] : undefined
      }
      const hover = state()['hover'] as { position: number; value: number } | undefined
      const inputStrip = strip('inputStrip')
      const outputStrip = strip('outputStrip')
      // The host keeps the bars only while the histogram's input has a wire.
      const histogram = props.row.histogram
      const bars = () => histogram?.connected === true ? GALLERY_HISTOGRAMS[String(state()['histogram'])] : undefined
      return (
        <>
          {picture(
            <CanvasCurvePlot points={points} sample={curveInterpolator({ interpolation, points })} selected={selected}
              histogram={bars()}
              inputStrip={inputStrip} outputStrip={outputStrip} {...(hover ? { hover } : {})} />,
          )}
          <CanvasEditorLine>
            <GalleryChoice label="Interpolation" value={interpolation === 'linear' ? 'Linear' : 'Monotone cubic'} options={['Linear', 'Monotone cubic']} />
          </CanvasEditorLine>
          <CanvasEditorLine dimmed={selected === undefined}>
            <GalleryNumber label="Position" value={selected === undefined ? undefined : points[selected]!.position} min={0} max={1} step={0.01} precision={2} />
          </CanvasEditorLine>
          <CanvasEditorLine dimmed={selected === undefined}>
            <GalleryNumber label="Value" value={selected === undefined ? undefined : points[selected]!.value} min={0} max={1} step={0.01} precision={2} />
          </CanvasEditorLine>
          {/* The Delete key on a selected point does the same; a curve keeps at least one point. */}
          <CanvasEditorButtons buttons={[{ label: 'Delete point', icon: canvasEditorIcons.remove, intent: 'remove',
            disabled: selected === undefined || points.length < 2 }]} />
          {/* A curve that declares a histogram has this line, wired or not: its input's pin stands on it. */}
          <Show when={histogram !== undefined}>
            <CanvasEditorNote>Histogram</CanvasEditorNote>
          </Show>
        </>
      )
    }
    default:
      return <></>
  }
}

/** One example: the production renderer's node with each unfolded editor's controls over its space. */
function ExampleCard(props: { example: InNodeEditorExample; theme: 'dark' | 'light'; registry: WidgetRegistry }) {
  let canvas!: HTMLCanvasElement
  const [scene, setScene] = createSignal<Scene>()
  createEffect(() => {
    const theme = props.theme
    const example = props.example
    let disposed = false
    let renderer: CanvasRenderer | undefined
    void document.fonts.load(`${defaultTokens.fontSize}px ${defaultTokens.fontFamily}`).then(() => {
      if (disposed) return
      const tokens: DesignTokens = {
        ...defaultTokens,
        widgetEditing: 'in-row',
        widgetRowLook: 'raised-editors',
        // As the Node boxes page, the page shows the remove cross the editor leaves off until it works.
        memberRemoveCross: true,
        ...canvasTypePaintForTheme(theme),
        colors: canvasColorsForTheme(theme),
      }
      const measureContext = document.createElement('canvas').getContext('2d')!
      const measure: TextMeasurer = (text, role) => {
        const title = role === 'title' || role === 'renamedTitle'
        measureContext.font = `${title ? `${canvasPaintTokens.type.semiboldWeight} ` : ''}${title ? tokens.titleFontSize : tokens.fontSize}px ${tokens.fontFamily}`
        return measureContext.measureText(text).width
      }
      const widgetMeasure: WidgetMeasure = (spec) => {
        const kind = props.registry.kind(spec.widgetType)
        const view = props.registry.viewsFor(spec.widgetType).find((view) => view.id === kind?.defaultView(spec))
        if (!view) return undefined
        // On a backend that cannot take uploads the recorder is its one sentence.
        const noBackend = view.id === 'core.audioRecord' &&
          Object.values(example.states ?? {}).some((state) => state['status'] === 'noBackend')
        const space = (example.width ?? GALLERY_NODE_WIDTH) - tokens.rowGeometry.fieldInsetX * 2 - canvasPaintTokens.node.editorSpace.pad * 2
        return { viewId: view.id, rows: view.measure(spec).rows, ...(noBackend ? { editorControls: noBackendHeight(space) } : {}) }
      }
      const built = createInNodeEditorScene(tokens, measure, widgetMeasure, example, { x: MARGIN, y: MARGIN })
      const node = built.nodes.find((item) => item.id === example.id)!
      canvas.style.width = `${node.layout.width + MARGIN * 2}px`
      canvas.style.height = `${node.layout.height + MARGIN * 2}px`
      renderer = new CanvasRenderer(canvas, tokens, createRegistryPainter(props.registry))
      renderer.setReducedMotion(true)
      renderer.setGridVisible(false)
      renderer.setScene(built)
      const summaries = Object.fromEntries(Object.entries(example.summaries ?? {}).map(([key, summary]) => {
        const kind = example.thumbnails?.[key]
        return [key, kind === undefined ? summary : { ...summary, thumbnail: thumbnailOf(kind, tokens) }]
      }))
      renderer.setEditorSummaries({ [example.id]: summaries })
      renderer.setViewport({ x: 0, y: 0, scale: 1 })
      renderer.renderNow()
      setScene(built)
      canvas.dataset.ready = `${example.id}-${theme}`
    })
    onCleanup(() => {
      disposed = true
      renderer?.dispose()
      delete canvas.dataset.ready
    })
  })
  const spaces = () => {
    const current = scene()
    const node = current?.nodes.find((item) => item.id === props.example.id)
    if (!node) return []
    return node.layout.rows
      .filter((row): row is SpaceRow => row.kind === 'editorSpace')
      .map((row) => {
        const field = node.layout.rows.find((item) => item.kind === 'widget' && item.valueKey === row.valueKey)
        return { row, node, declared: field?.kind === 'widget' ? field.spec.options : {} }
      })
  }
  return (
    <figure class="dinkster-canvas-example">
      <div class="dinkster-canvas-example-stage">
        <canvas ref={canvas} role="img" aria-label={`${props.example.caption} in ${props.theme} theme`}
          data-testid={`in-node-editor-${props.example.id}`} />
        <For each={spaces()}>
          {({ row, node, declared }) => (
            <CanvasEditorSpace ref={(element) => {
              element.style.left = `${node.x + row.inset}px`
              element.style.top = `${node.y + row.y}px`
              element.style.width = `${row.width ?? node.layout.width - row.inset * 2}px`
              element.style.height = `${row.height - defaultTokens.rowGeometry.fieldInsetY}px`
            }}>
              <EditorBody row={row} example={props.example} declared={declared} />
            </CanvasEditorSpace>
          )}
        </For>
      </div>
      <figcaption class="dinkster-metadata">{`Card ${props.example.card}: ${props.example.caption}`}</figcaption>
    </figure>
  )
}

/** Every example of the editors shown in the node, grouped by editor. */
export function InNodeEditorsGallery(props: { theme: 'dark' | 'light' }) {
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  const groups: readonly (readonly [string, (example: InNodeEditorExample) => boolean])[] = [
    ['The palette as color rows', (example) => example.card === 7],
    ['Folding out and back', (example) => example.card >= 8 && example.card <= 10],
    ['Audio record', (example) => example.card >= 12 && example.card <= 15],
    ['Webcam', (example) => example.card >= 16 && example.card <= 19],
    ['3D viewer', (example) => example.card >= 20 && example.card <= 26],
    ['Image comparison', (example) => example.card >= 27 && example.card <= 29],
    ['Camera angle', (example) => example.card >= 30 && example.card <= 32],
    ['Curve', (example) => example.card >= 34],
  ]
  return (
    <For each={groups}>
      {([title, matches]) => (
        <ProductSection title={title}>
          <div class="dinkster-canvas-examples">
            <For each={inNodeEditorExamples.filter(matches)}>
              {(example) => <ExampleCard example={example} theme={props.theme} registry={registry} />}
            </For>
          </div>
        </ProductSection>
      )}
    </For>
  )
}
