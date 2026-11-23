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
import { createWidgetRegistry, registerCoreWidgets, widgetRegistrationDoors } from '@dinkster/widgets'
import {
  createInNodeEditorScene,
  inNodeEditorExamples,
  type EditorExampleState,
  type InNodeEditorExample,
} from '../../canvas/gallery/in-node-editors.js'
import {
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

/** The orbit and elevation drawing of the camera angle, with its dots. */
function AnglePicture(props: { horizontal?: number; vertical: number; hollow?: boolean }) {
  const dot = (cx: number, cy: number, hollow: boolean) => (
    <circle class="dinkster-gallery-angle-dot" data-hollow={hollow ? 'true' : 'false'} cx={cx} cy={cy} r="6" />
  )
  const h = () => ((props.horizontal ?? 0) * Math.PI) / 180
  const v = () => (props.vertical * Math.PI) / 180
  return (
    <svg viewBox="0 0 320 150" aria-hidden="true">
      <circle class="dinkster-gallery-angle-ring" cx="80" cy="75" r="55" />
      <line class="dinkster-gallery-angle-ring" x1="190" y1="120" x2="300" y2="120" />
      <path class="dinkster-gallery-angle-ring" d="M 190 120 A 100 100 0 0 1 240 33" />
      <Show when={props.horizontal !== undefined}>{dot(80 + Math.sin(h()) * 55, 75 - Math.cos(h()) * 55, props.hollow === true)}</Show>
      {dot(190 + Math.cos(v()) * 95, 120 - Math.sin(v()) * 95, false)}
    </svg>
  )
}

/** The curve drawn large, with its grid, points and an optional histogram behind the line. */
function CurvePicture(props: { points: readonly { position: number; value: number }[]; selected?: number; histogram?: boolean }) {
  const x = (position: number) => 10 + position * 300
  const y = (value: number) => 170 - value * 160
  return (
    <svg viewBox="0 0 320 180" aria-hidden="true">
      <For each={[0.25, 0.5, 0.75]}>
        {(at) => (
          <>
            <line class="dinkster-gallery-curve-grid" x1={x(at)} y1="10" x2={x(at)} y2="170" />
            <line class="dinkster-gallery-curve-grid" x1="10" y1={y(at)} x2="310" y2={y(at)} />
          </>
        )}
      </For>
      <Show when={props.histogram}>
        <For each={Array.from({ length: 30 }, (_, index) => index)}>
          {(index) => {
            const height = 20 + Math.abs(Math.sin(index / 4)) * 90
            return <rect class="dinkster-gallery-curve-histogram" x={x(index / 30)} y={170 - height} width="9" height={height} />
          }}
        </For>
      </Show>
      <polyline class="dinkster-gallery-curve-line" points={props.points.map((point) => `${x(point.position)},${y(point.value)}`).join(' ')} />
      <For each={props.points}>
        {(point, index) => (
          <circle class="dinkster-gallery-curve-point" data-selected={index() === props.selected ? 'true' : 'false'}
            cx={x(point.position)} cy={y(point.value)} r="5" />
        )}
      </For>
    </svg>
  )
}

/** An editor's own number in an example: it steps and is typed in, and keeps what it was given. */
function GalleryNumber(props: { label: string; value: number; min?: number; max?: number; step?: number; precision?: number }) {
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
function EditorBody(props: { row: SpaceRow; example: InNodeEditorExample }): JSX.Element {
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
            <CanvasEditorButtons buttons={[{ label: 'Find microphones', icon: canvasEditorIcons.retry, iconOnly: true }]} />
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
            <CanvasEditorLine><GalleryNumbers label="Model position X Y Z" value={[0, 0, 0]} /></CanvasEditorLine>
            <CanvasEditorLine><GalleryNumbers label="Model rotation X Y Z W" value={[0, 0, 0, 1]} /></CanvasEditorLine>
            <CanvasEditorLine><GalleryNumbers label="Model scale X Y Z" value={[1, 1, 1]} /></CanvasEditorLine>
          </CanvasEditorSection>
          <CanvasEditorSection label="Animation" open={open('animation')}>
            <CanvasEditorLine><GalleryChoice label="Animation clip" value="Walk" options={['Walk', 'Run', 'Idle']} /></CanvasEditorLine>
            <CanvasEditorLine><GalleryNumber label="Animation time (s)" value={0.4} min={0} step={0.1} precision={2} /></CanvasEditorLine>
            <CanvasEditorLine><GalleryNumber label="Animation speed" value={1} min={0} step={0.1} precision={1} /></CanvasEditorLine>
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
            <AnglePicture
              {...(wired() === 'horizontal_angle' && !known() ? {} : { horizontal: wired() === 'horizontal_angle' ? 120 : 45 })}
              vertical={20}
              hollow={wired() === 'horizontal_angle'}
            />,
          )}
          <CanvasEditorNote tone={wired() !== undefined && !known() ? 'muted' : undefined}>
            {wired() !== undefined && !known() ? 'Not known yet' : 'Front right, a little above, zoom 5.0'}
          </CanvasEditorNote>
        </>
      )
    }
    case 'core.curve': {
      const value = props.example.values?.[props.row.valueKey] as { points?: { position: number; value: number }[] } | undefined
      const points = value?.points ?? []
      const selected = num(state(), 'selected')
      return (
        <>
          {picture(
            <CurvePicture points={points} {...(selected === undefined ? {} : { selected })} histogram={state()['histogram'] === true} />,
          )}
          <CanvasEditorLine>
            <GalleryChoice label="Interpolation" value={state()['histogram'] === true ? 'Linear' : 'Monotone cubic'} options={['Linear', 'Monotone cubic']} />
          </CanvasEditorLine>
          <CanvasEditorLine dimmed={selected === undefined}>
            <GalleryNumber label="Position" value={selected === undefined ? 0 : points[selected]!.position} min={0} max={1} step={0.01} precision={2} />
            <CanvasEditorButtons buttons={[{ label: 'Delete point', icon: canvasEditorIcons.remove, iconOnly: true, intent: 'remove', disabled: selected === undefined }]} />
          </CanvasEditorLine>
          <CanvasEditorLine dimmed={selected === undefined}>
            <GalleryNumber label="Value" value={selected === undefined ? 0 : points[selected]!.value} min={0} max={1} step={0.01} precision={2} />
          </CanvasEditorLine>
          <CanvasEditorNote tone="muted">
            {state()['histogram'] === true ? 'Histogram from the selected run' : 'Drag a point to move it. Double-click to add one.'}
          </CanvasEditorNote>
          <CanvasEditorNote tone="muted">Click a point to select it.</CanvasEditorNote>
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
        const space = (example.width ?? 300) - tokens.rowGeometry.fieldInsetX * 2 - canvasPaintTokens.node.editorSpace.pad * 2
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
      .map((row) => ({ row, node }))
  }
  return (
    <figure class="dinkster-canvas-example">
      <div class="dinkster-canvas-example-stage">
        <canvas ref={canvas} role="img" aria-label={`${props.example.caption} in ${props.theme} theme`}
          data-testid={`in-node-editor-${props.example.id}`} />
        <For each={spaces()}>
          {({ row, node }) => (
            <CanvasEditorSpace ref={(element) => {
              element.style.left = `${node.x + row.inset}px`
              element.style.top = `${node.y + row.y}px`
              element.style.width = `${node.layout.width - row.inset * 2}px`
              element.style.height = `${row.height}px`
            }}>
              <EditorBody row={row} example={props.example} />
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
