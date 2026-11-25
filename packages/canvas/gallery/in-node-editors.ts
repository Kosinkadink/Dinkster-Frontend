import {
  defaultValuesOf,
  documentResolver,
  loadDocument,
  type BodyRow,
  type InputSpec,
  type Json,
  type NodeSchema,
  type NodeViewState,
  type OutputSpec,
  type TypeExpr,
} from '@dinkster/core'
import {
  buildScene,
  type DesignTokens,
  type EditorSummaryMap,
  type Scene,
  type TextMeasurer,
  type WidgetMeasure,
} from '../src/index.js'

const concrete = (name: string): TypeExpr => ({ kind: 'concrete', name })
const socket = (id: string, type: string, optional = false): InputSpec =>
  ({ kind: 'input', id, type: concrete(type), optional })
const field = (id: string, widgetType: string, value: Json, options: Record<string, unknown> = {}, type = widgetType): InputSpec => ({
  kind: 'input',
  id,
  type: concrete(type),
  optional: false,
  widget: { widgetType, options, default: value },
})
const editor = (id: string, widgetType: string, options: Record<string, unknown> = {}, socketless = false): InputSpec => ({
  kind: 'input',
  id,
  type: concrete(widgetType),
  optional: false,
  ...(socketless ? { socketless: true } : {}),
  widget: { widgetType, options },
})
const output = (id: string, type = id): OutputSpec => ({ kind: 'output', id, type: concrete(type) })
const schema = (type: string, body: readonly BodyRow[]): NodeSchema =>
  ({ type, displayName: type, category: 'gallery', source: 'v3', isOutputNode: false, body })

/** The nodes of the page, declared as their packs declare them. */
/** The width the app gives these nodes, so each card shows what the app shows. */
export const GALLERY_NODE_WIDTH = 280

export const inNodeEditorSchemas: readonly NodeSchema[] = [
  schema('Record Audio', [editor('audio', 'AUDIO_RECORD', { unfolded: true }), output('AUDIO')]),
  schema('Record two clips', [editor('first', 'AUDIO_RECORD'), editor('second', 'AUDIO_RECORD'), output('AUDIO')]),
  schema('Record clips', [
    {
      kind: 'group', id: 'clips', displayName: 'Clips', value: editor('clip', 'AUDIO_RECORD'),
      keys: { kind: 'numbered', prefix: 'clip', start: 0, pad: 0 }, grows: 'button', minMembers: 1,
      reorderable: true, addLabel: 'Add clip',
    },
    output('AUDIO'),
  ]),
  schema('Webcam Capture', [
    editor('image', 'WEBCAM'),
    field('width', 'INT', 0, { min: 0, max: 4096 }),
    field('height', 'INT', 0, { min: 0, max: 4096 }),
    field('capture_on_queue', 'BOOLEAN', true),
    output('IMAGE'),
  ]),
  schema('Load 3D', [
    field('model_file', 'ASSET', null, { kind: 'media/model3d' }, 'ASSET'),
    editor('image', 'LOAD_3D', { unfolded: true }, true),
    field('width', 'INT', 1024, { min: 1, max: 4096 }),
    field('height', 'INT', 1024, { min: 1, max: 4096 }),
    output('image', 'IMAGE'),
    output('mask', 'MASK'),
    output('normal', 'IMAGE'),
    {
      kind: 'section', id: 'more_outputs', displayName: 'More outputs', collapsedByDefault: true,
      rows: [
        output('mesh_path', 'STRING'),
        output('camera_info', 'LOAD3D_CAMERA'),
        output('recording_video', 'VIDEO'),
        output('model_3d', 'MODEL_3D'),
        output('model_3d_info', 'MODEL_3D_INFO'),
      ],
    },
  ]),
  schema('Preview 3D (Advanced)', [
    socket('model_3d', 'MODEL_3D'),
    socket('camera_info', 'LOAD3D_CAMERA', true),
    editor('viewport', 'LOAD_3D', { unfolded: true }, true),
  ]),
  schema('Compare Images', [
    socket('image_a', 'IMAGE', true),
    socket('image_b', 'IMAGE', true),
    editor('comparison', 'IMAGECOMPARE', {}, true),
  ]),
  schema('Camera angle', [
    socket('image', 'IMAGE'),
    editor('angle_view', 'CAMERA_ANGLE_VIEW', {}, true),
    field('horizontal_angle', 'INT', 45, { min: 0, max: 360 }),
    field('vertical_angle', 'INT', 20, { min: -30, max: 60 }),
    field('zoom', 'FLOAT', 5, { min: 0, max: 10, step: 0.1 }),
    output('conditioning', 'STRING'),
  ]),
  schema('Curve editor', [
    socket('histogram', 'HISTOGRAM', true),
    editor('curve', 'CURVE'),
    output('curve', 'CURVE'),
  ]),
  // A node turns the strips on in its curve's declaration, each with its colors from low to high.
  schema('Brightness curve', [
    editor('curve', 'CURVE', { inputStrip: ['#000000', '#ffffff'], outputStrip: ['#000000', '#ffffff'] }),
    output('curve', 'CURVE'),
  ]),
  // A curve from a color to the same color strips both axes in it.
  schema('Red channel curve', [
    editor('curve', 'CURVE', { inputStrip: ['#000000', '#ff0000'], outputStrip: ['#000000', '#ff0000'] }),
    output('curve', 'CURVE'),
  ]),
  // Its output is an amount, not a color, so only the input has a strip.
  schema('Saturation by brightness', [
    editor('curve', 'CURVE', { inputStrip: ['#000000', '#ffffff'] }),
    output('curve', 'CURVE'),
  ]),
  ...[16, undefined].map((maxMembers) => schema(maxMembers === undefined ? 'Palette' : 'Palette of 16', [
    {
      kind: 'group', id: 'colors', displayName: 'Colors', value: field('color', 'COLOR', '#ffffff'),
      keys: { kind: 'numbered', prefix: 'color', start: 0, pad: 0 }, grows: 'filled', minMembers: 0,
      ...(maxMembers !== undefined ? { maxMembers } : {}), reorderable: true,
    },
    output('colors', 'STRING'),
  ])),
]

/** What the unfolded editor's own controls show in an example; the page draws them over the space. */
export type EditorExampleState = Readonly<Record<string, Json>>

/** One example of the page: a card of the drawing, drawn by the product's renderer. */
export interface InNodeEditorExample {
  readonly id: string
  /** The drawing's card it shows. */
  readonly card: number
  readonly caption: string
  readonly type: string
  readonly values?: Readonly<Record<string, Json>>
  readonly view?: Pick<NodeViewState, 'editors' | 'sections' | 'pictureHeights'>
  /** Inputs a wire comes into, by input id and its type. */
  readonly wired?: Readonly<Record<string, string>>
  /** Members of a growing group, by group id. */
  readonly members?: Readonly<Record<string, readonly string[]>>
  /** Per editor value key: what its controls show. */
  readonly states?: Readonly<Record<string, EditorExampleState>>
  /** Per editor value key: what its folded row reads, as the host derives it. */
  readonly summaries?: EditorSummaryMap[string]
  /** Per wired value key: the value its wire carries before a run, from a Primitive or a widget tap. */
  readonly carried?: Readonly<Record<string, Json>>
  /** Per editor value key: the small picture its row shows before the text. */
  readonly thumbnails?: Readonly<Record<string, 'frame' | 'view'>>
  readonly width?: number
  /**
   * Where the editor is shown when it is not the node's own: on the Inputs
   * panel of the subgraph the node is in, as the field of an input that
   * promotes it, entered from no subgraph node so the panel shows the
   * defaults a new one starts with. Or in a general Primitive node whose
   * output feeds the example node's field, so the Primitive takes that
   * field's widget; the Primitive holds the example's values.
   */
  readonly place?: 'inputsPanel' | 'primitive'
}

const asset = (name: string, mediaType: string, extra: Record<string, Json> = {}): Json =>
  ({ digest: `blake3:${'a'.repeat(64)}`, name, mediaType, size: 47_104, virtualPath: `input/${name}`, ...extra })
const unfold = (...keys: string[]): Pick<NodeViewState, 'editors'> =>
  ({ editors: Object.fromEntries(keys.map((key) => [key, { unfolded: true }])) })
const fold = (...keys: string[]): Pick<NodeViewState, 'editors'> =>
  ({ editors: Object.fromEntries(keys.map((key) => [key, { unfolded: false }])) })
const clip = asset('recording.webm', 'audio/webm')
const frame = asset('webcam.png', 'image/png')

export const inNodeEditorExamples: readonly InNodeEditorExample[] = [
  { id: 'palette-max', card: 7, caption: 'A palette whose group declares 16 colors, at its limit: no add member', type: 'Palette of 16',
    members: { colors: Array.from({ length: 16 }, (_, index) => `color${index}`) },
    values: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`colors.color${index}`,
      `#${((index * 0x3d1f7b) & 0xffffff).toString(16).padStart(6, '0')}`])) },
  { id: 'palette-open', card: 7, caption: 'A palette with no declared maximum: three colors, the third wired, and the add member', type: 'Palette',
    members: { colors: ['color0', 'color1', 'color2'] },
    values: { 'colors.color0': '#ff6600', 'colors.color1': '#2255aa', 'colors.color2': '#33cc99' },
    wired: { 'colors.color2': 'COLOR' } },
  { id: 'palette-fresh', card: 7, caption: 'A fresh palette: no colors yet, only the add member', type: 'Palette' },
  { id: 'webcam-folded', summaries: { image: { text: 'webcam.png' } }, thumbnails: { image: 'frame' }, card: 8, caption: 'Folded: the editor button row with the stored frame', type: 'Webcam Capture',
    values: { image: frame } },
  { id: 'webcam-unfolded', summaries: { image: { text: 'webcam.png' } }, thumbnails: { image: 'frame' }, card: 8, caption: 'Clicked: the webcam folds out under the same row and the rows below move down', type: 'Webcam Capture',
    values: { image: frame }, view: unfold('image'), states: { image: { camera: 'off' } } },
  { id: 'two-recorders', summaries: { second: { text: '0:07 clip' } }, card: 9, caption: 'Two recorders in one node: the first unfolded, the second folded', type: 'Record two clips',
    values: { second: clip }, view: unfold('first'), states: { first: { status: 'idle' } } },
  { id: 'group-member', summaries: { 'clips.clip0': { text: 'No clip', placeholder: true }, 'clips.clip1': { text: '0:07 clip' }, 'clips.clip2': { text: 'No clip', placeholder: true } }, card: 10, caption: 'A growing group: every member starts folded; the second is unfolded and the third moved down. Wider than the other cards by the room the grips and crosses need', type: 'Record clips',
    members: { clips: ['clip0', 'clip1', 'clip2'] }, values: { 'clips.clip1': clip }, view: unfold('clips.clip1'),
    // As wide as the node grows for an editor unfolded in a group: the editor's own width plus the group's insets, grip and cross.
    width: 324, states: { 'clips.clip1': { status: 'ready' } } },
  { id: 'audio-idle', card: 12, caption: 'Idle: Record, Microphone off', type: 'Record Audio', states: { audio: { status: 'idle' } } },
  { id: 'audio-waiting', card: 12, caption: 'Waiting for permission', type: 'Record Audio', states: { audio: { status: 'waiting' } } },
  { id: 'audio-recording', summaries: { audio: { text: 'Recording 0:07' } }, card: 13, caption: 'Recording: Stop, time and size; Microphone and Limit dimmed', type: 'Record Audio',
    states: { audio: { status: 'recording', seconds: 7, bytes: 47_104 } } },
  { id: 'audio-recording-folded', summaries: { audio: { text: 'Recording 0:07' } }, card: 13, caption: 'Folded while it records: the row reads Recording with the time', type: 'Record Audio',
    view: fold('audio'), states: { audio: { status: 'recording', seconds: 7, bytes: 47_104 } } },
  { id: 'audio-saving', card: 14, caption: 'Stopped: Saving while the clip uploads', type: 'Record Audio', states: { audio: { status: 'saving' } } },
  { id: 'audio-ready', summaries: { audio: { text: '0:07 clip' } }, card: 14, caption: 'Stored: Ready, Play, Record and the bin', type: 'Record Audio', values: { audio: clip },
    states: { audio: { status: 'ready' } } },
  { id: 'audio-folded', summaries: { audio: { text: '0:07 clip' } }, card: 14, caption: 'Folded with a stored clip: its length', type: 'Record Audio', values: { audio: clip }, view: fold('audio') },
  { id: 'audio-denied', card: 15, caption: 'Permission denied', type: 'Record Audio', states: { audio: { status: 'denied' } } },
  { id: 'audio-upload-failed', summaries: { audio: { text: 'No clip', placeholder: true } }, card: 15, caption: 'Upload failed: the clip is kept and plays, nothing is stored', type: 'Record Audio',
    states: { audio: { status: 'uploadFailed', error: 'HTTP 503: storage is busy' } } },
  { id: 'audio-no-mic', card: 15, caption: 'No microphone found', type: 'Record Audio', states: { audio: { status: 'noMicrophone' } } },
  { id: 'audio-no-backend', card: 15, caption: 'A backend that cannot take uploads', type: 'Record Audio', states: { audio: { status: 'noBackend' } } },
  { id: 'webcam-start', card: 16, caption: 'No frame stored: the camera starts only with Start camera', type: 'Webcam Capture',
    view: unfold('image'), states: { image: { camera: 'off' } } },
  { id: 'webcam-live', card: 16, caption: 'Started: the picture is live; Capture frame and Stop', type: 'Webcam Capture',
    view: unfold('image'), states: { image: { camera: 'live' } } },
  { id: 'webcam-capturing', summaries: { image: { text: 'webcam.png' } }, thumbnails: { image: 'frame' }, card: 17, caption: 'Capturing... then stored at once', type: 'Webcam Capture', values: { image: frame },
    view: unfold('image'), states: { image: { camera: 'capturing' } } },
  { id: 'webcam-thumbnail', summaries: { image: { text: 'webcam.png' } }, thumbnails: { image: 'frame' }, card: 18, caption: 'Folded: the stored frame small beside its name', type: 'Webcam Capture', values: { image: frame } },
  { id: 'webcam-refused', card: 19, caption: "A refused camera shows the browser's error", type: 'Webcam Capture',
    view: unfold('image'), states: { image: { camera: 'error', error: 'NotAllowedError: Permission denied' } } },
  { id: 'webcam-wired-before', summaries: { image: { text: 'Not known yet', placeholder: true } }, card: 19, caption: 'A wired image before a run: Not known yet; Start camera dimmed', type: 'Webcam Capture',
    view: unfold('image'), wired: { image: 'WEBCAM' }, states: { image: { camera: 'wired', known: false } } },
  { id: 'webcam-wired-after', summaries: { image: { text: 'webcam_00001.png' } }, thumbnails: { image: 'frame' }, card: 19, caption: 'After a run: the picture shows the image the wire brought, and the row reads its name', type: 'Webcam Capture',
    view: unfold('image'), wired: { image: 'WEBCAM' }, states: { image: { camera: 'wired' } } },
  { id: 'load3d-live', thumbnails: { image: 'view' }, summaries: { image: { text: 'chair.glb' } }, card: 20, caption: 'Unfolded: the model in the live view, with Record viewport', type: 'Load 3D',
    values: { model_file: asset('chair.glb', 'model/gltf-binary') }, states: { image: { view: 'model' } } },
  { id: 'load3d-folded', thumbnails: { image: 'view' }, summaries: { image: { text: 'chair.glb' } }, card: 21, caption: 'Folded: the last view small beside the model name', type: 'Load 3D',
    values: { model_file: asset('chair.glb', 'model/gltf-binary') }, view: fold('image') },
  { id: 'load3d-outputs', thumbnails: { image: 'view' }, summaries: { image: { text: 'chair.glb' } }, card: 22, caption: 'Three outputs listed; five in More outputs, closed', type: 'Load 3D',
    values: { model_file: asset('chair.glb', 'model/gltf-binary') }, view: fold('image') },
  { id: 'load3d-none', summaries: { image: { text: 'No model', placeholder: true } }, card: 23, caption: 'No model chosen: the rows under the view are dimmed', type: 'Load 3D', states: { image: { view: 'none' } } },
  { id: 'load3d-loading', summaries: { image: { text: 'chair.glb' } }, card: 23, caption: 'Loading model', type: 'Load 3D',
    values: { model_file: asset('chair.glb', 'model/gltf-binary') }, states: { image: { view: 'loading' } } },
  { id: 'load3d-unavailable', summaries: { image: { text: 'chair.glb' } }, card: 23, caption: 'Model unavailable', type: 'Load 3D',
    values: { model_file: asset('chair.glb', 'model/gltf-binary') }, states: { image: { view: 'unavailable' } } },
  { id: 'load3d-sections', thumbnails: { image: 'view' }, summaries: { image: { text: 'robot.glb' } }, card: 24, caption: 'Model placement and Animation open while a recording runs', type: 'Load 3D',
    values: { model_file: asset('robot.glb', 'model/gltf-binary') },
    view: { sections: { 'image.placement': { collapsed: false }, 'image.animation': { collapsed: false } } },
    states: { image: { view: 'model', recording: true, animated: true } } },
  { id: 'preview3d-before', summaries: { viewport: { text: 'Not known yet', placeholder: true } }, card: 25, caption: 'A model and camera by wire, before a run: Not known yet', type: 'Preview 3D (Advanced)',
    wired: { model_3d: 'MODEL_3D', camera_info: 'LOAD3D_CAMERA' }, states: { viewport: { view: 'unknown', wired: true } } },
  { id: 'preview3d-after', thumbnails: { viewport: 'view' }, summaries: { viewport: { text: 'model_3d.glb' } }, card: 25, caption: "After a run: that run's model from the wired camera, not turned by dragging", type: 'Preview 3D (Advanced)',
    wired: { model_3d: 'MODEL_3D', camera_info: 'LOAD3D_CAMERA' }, states: { viewport: { view: 'model', wired: true } } },
  { id: 'load3d-capture', thumbnails: { image: 'view' }, summaries: { image: { text: 'chair.glb' } }, card: 26, caption: 'Queued with an unchanged view: no new pictures, the stored capture is used', type: 'Load 3D',
    values: { model_file: asset('chair.glb', 'model/gltf-binary') }, states: { image: { view: 'model', notice: 'Last capture used' } } },
  { id: 'compare-two', summaries: { comparison: { text: '2 images' } }, card: 27, caption: 'Both images of the last run with the divider', type: 'Compare Images',
    wired: { image_a: 'IMAGE', image_b: 'IMAGE' }, view: unfold('comparison'), states: { comparison: { images: 2 } } },
  { id: 'compare-folded', summaries: { comparison: { text: '2 images' } }, card: 28, caption: 'Folded: how many images it has', type: 'Compare Images',
    wired: { image_a: 'IMAGE', image_b: 'IMAGE' }, states: { comparison: { images: 2 } } },
  { id: 'compare-before', summaries: { comparison: { text: 'No images', placeholder: true } }, card: 29, caption: 'Before a run: Run to compare', type: 'Compare Images',
    wired: { image_a: 'IMAGE', image_b: 'IMAGE' }, view: unfold('comparison'), states: { comparison: { images: 0 } } },
  { id: 'compare-one', summaries: { comparison: { text: '1 image' } }, card: 29, caption: 'One image: it fills the picture; Wipe divider dimmed', type: 'Compare Images',
    wired: { image_a: 'IMAGE' }, view: unfold('comparison'), states: { comparison: { images: 1 } } },
  { id: 'angle-unfolded', summaries: { angle_view: { text: '45, 20, zoom 5.0' } }, card: 30, caption: 'The picture above the three number fields; its dots are dragged', type: 'Camera angle',
    view: unfold('angle_view'), states: { angle_view: {} } },
  { id: 'angle-folded', summaries: { angle_view: { text: '45, 20, zoom 5.0' } }, card: 31, caption: 'Folded: the two angles and the zoom; the three fields stay', type: 'Camera angle' },
  { id: 'angle-wired-before', summaries: { angle_view: { text: 'Not known yet', placeholder: true } }, card: 32, caption: 'A wired angle before a run: no dot, Not known yet', type: 'Camera angle',
    wired: { horizontal_angle: 'INT' }, view: unfold('angle_view'), states: { angle_view: { wired: 'horizontal_angle', known: false } } },
  { id: 'angle-wired-after', summaries: { angle_view: { text: '120, 20, zoom 5.0' } }, card: 32, caption: "After a run: a hollow dot at the wire's value", type: 'Camera angle',
    wired: { horizontal_angle: 'INT' }, view: unfold('angle_view'), states: { angle_view: { wired: 'horizontal_angle', known: true } } },
  { id: 'curve-unfolded', card: 34, caption: 'The curve large in the node, a point selected', type: 'Curve editor',
    values: { curve: { interpolation: 'monotone_cubic', points: [{ position: 0, value: 0 }, { position: 0.4, value: 0.6 }, { position: 1, value: 1 }] } },
    view: unfold('curve'), states: { curve: { selected: 1 } } },
  { id: 'curve-strips', card: 34, caption: 'Both strips declared, black to white; the pointer shows where a point would go',
    type: 'Brightness curve',
    values: { curve: { interpolation: 'monotone_cubic', points: [{ position: 0, value: 0 }, { position: 0.35, value: 0.5 }, { position: 1, value: 1 }] } },
    view: unfold('curve'), states: { curve: { hover: { position: 0.7, value: 0.45 } } } },
  { id: 'curve-red', card: 34, caption: 'A red channel curve: both strips black to red', type: 'Red channel curve',
    values: { curve: { interpolation: 'monotone_cubic', points: [{ position: 0, value: 0 }, { position: 0.5, value: 0.35 }, { position: 1, value: 0.9 }] } },
    view: unfold('curve') },
  { id: 'curve-input-strip', card: 34, caption: 'Saturation by brightness: only the input strip, black to white',
    type: 'Saturation by brightness',
    values: { curve: { interpolation: 'monotone_cubic', points: [{ position: 0, value: 0.2 }, { position: 0.5, value: 0.8 }, { position: 1, value: 0.3 }] } },
    view: unfold('curve') },
  { id: 'curve-pulled-in', card: 34, caption: 'End points pulled in from the borders: the curve holds their values out to the edges',
    type: 'Curve editor',
    values: { curve: { interpolation: 'monotone_cubic', points: [{ position: 0.2, value: 0.1 }, { position: 0.5, value: 0.6 }, { position: 0.8, value: 0.9 }] } },
    view: unfold('curve') },
  { id: 'curve-folded', card: 35, caption: 'Folded: the curve small in a square with its points, how it is joined under its icon and name', type: 'Curve editor',
    values: { curve: { interpolation: 'monotone_cubic', points: [{ position: 0, value: 0 }, { position: 0.4, value: 0.6 }, { position: 1, value: 1 }] } } },
  { id: 'curve-folded-pulled-in', card: 35, caption: 'Folded with its end points pulled in: the held ends are muted', type: 'Curve editor',
    values: { curve: { interpolation: 'linear', points: [{ position: 0.2, value: 0.1 }, { position: 0.5, value: 0.6 }, { position: 0.8, value: 0.9 }] } } },
  { id: 'curve-folded-wired-before', card: 35, caption: 'Folded, fed by a wire, before a run: Not known yet', type: 'Curve editor',
    wired: { curve: 'CURVE' }, summaries: { curve: { text: 'Not known yet', placeholder: true, value: null } } },
  { id: 'curve-folded-wired-after', card: 35, caption: 'Folded, fed by a wire, after a run: the curve the wire brought, its points muted with the row', type: 'Curve editor',
    wired: { curve: 'CURVE' },
    summaries: { curve: { value: { interpolation: 'monotone_cubic', points: [{ position: 0, value: 0.1 }, { position: 0.5, value: 0.8 }, { position: 1, value: 0.6 }] } } } },
  { id: 'curve-folded-primitive', card: 35, caption: 'Folded, fed by a Primitive holding 3 points, before a run: the curve it holds, muted with the row', type: 'Curve editor',
    wired: { curve: 'CURVE' },
    carried: { curve: { interpolation: 'monotone_cubic', points: [{ position: 0, value: 0.2 }, { position: 0.6, value: 0.4 }, { position: 1, value: 0.9 }] } } },
  { id: 'curve-histogram-before', card: 36, caption: 'A histogram wired in, before a run: its line reads Histogram: not known yet', type: 'Curve editor',
    values: { curve: { interpolation: 'linear', points: [{ position: 0, value: 0.1 }, { position: 0.5, value: 0.45 }, { position: 1, value: 0.95 }] } },
    wired: { histogram: 'HISTOGRAM' }, view: unfold('curve') },
  { id: 'curve-histogram', card: 36, caption: "A histogram wired in: after a run, behind the line", type: 'Curve editor',
    values: { curve: { interpolation: 'linear', points: [{ position: 0, value: 0.1 }, { position: 0.5, value: 0.45 }, { position: 1, value: 0.95 }] } },
    wired: { histogram: 'HISTOGRAM' }, view: unfold('curve'), states: { curve: { histogram: true } } },
  { id: 'panel-curve', card: 37, caption: "On a subgraph's Inputs panel: the curve folded out under its field, and the panel grown downward", type: 'Curve editor',
    place: 'inputsPanel', values: { curve: { interpolation: 'monotone_cubic', points: [{ position: 0, value: 0 }, { position: 0.4, value: 0.6 }, { position: 1, value: 1 }] } },
    view: unfold('curve') },
  { id: 'primitive-curve', card: 38, caption: "In a Primitive wired to a Curve editor's curve: the Primitive takes the curve's widget and folds it out like any node", type: 'Curve editor',
    place: 'primitive', values: { value: { interpolation: 'monotone_cubic', points: [{ position: 0, value: 0 }, { position: 0.4, value: 0.6 }, { position: 1, value: 1 }] } },
    view: unfold('value') },
]

/**
 * The general Primitive as its pack declares it: one value whose type, and
 * so its widget, follows the field its output feeds, and a default under
 * Limits.
 */
const primitiveSchema: NodeSchema = schema('Primitive', [
  { kind: 'input', id: 'value', displayName: 'Value', type: { kind: 'variable', templateId: 'value' }, optional: true },
  { kind: 'section', id: 'limits', displayName: 'Limits', collapsedByDefault: true, rows: [
    { kind: 'input', id: 'default', displayName: 'Default', type: { kind: 'variable', templateId: 'value' }, optional: true },
  ] },
  { kind: 'output', id: 'value', displayName: 'Value', type: { kind: 'variable', templateId: 'value' }, knownValue: { input: 'value', limits: { default: 'default' } } },
] as readonly BodyRow[])

const SOURCE = 'Wire source'

/** One example's node laid out by the production scene builder, with a source for each wire. */
export function createInNodeEditorScene(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  example: InNodeEditorExample,
  position: { x: number; y: number },
): Scene {
  const target = inNodeEditorSchemas.find((item) => item.type === example.type)!
  if (example.place === 'inputsPanel') return createInputsPanelScene(tokens, measure, widgetMeasure, example, target, position)
  if (example.place === 'primitive') return createPrimitiveScene(tokens, measure, widgetMeasure, example, target, position)
  const wired = Object.entries(example.wired ?? {})
  const source: NodeSchema = schema(SOURCE, wired.map(([id, type]) => output(id.replaceAll('.', '_'), type)))
  const id = example.id
  const loaded = loadDocument({
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'canvas-gallery',
    root: 'gallery',
    graphs: {
      gallery: {
        id: 'gallery',
        name: 'Gallery',
        nextOrdinal: 3,
        nodes: {
          [id]: {
            id,
            type: target.type,
            values: { ...defaultValuesOf(target), ...(example.values ?? {}) },
            ...(example.members !== undefined
              ? { dynamic: Object.fromEntries(Object.entries(example.members).map(([group, members]) => [group, { members }])) }
              : {}),
          },
          ...(wired.length > 0 ? { [SOURCE]: { id: SOURCE, type: SOURCE, values: {} } } : {}),
        },
        links: Object.fromEntries(wired.map(([port]) => [`wire-${port}`, {
          id: `wire-${port}`,
          from: { node: SOURCE, port: port.replaceAll('.', '_') },
          to: { node: id, port },
        }])),
        nets: {},
        reroutes: {},
      },
    },
    view: {
      graphs: {
        gallery: {
          nodes: {
            [id]: { position, size: { width: example.width ?? GALLERY_NODE_WIDTH, height: 0 }, ...(example.view ?? {}) },
            ...(wired.length > 0 ? { [SOURCE]: { position: { x: -400, y: position.y }, size: { width: 160, height: 0 } } } : {}),
          },
        },
      },
    },
  } as never)
  if (!loaded.document) throw new Error(`Invalid gallery document: ${JSON.stringify(loaded)}`)
  return buildScene({
    document: loaded.document,
    graphId: 'gallery',
    resolve: (type) => type === SOURCE ? source : type === target.type ? target : undefined,
    tokens,
    measure,
    widgetMeasure,
  })
}

/**
 * The example's node inside a subgraph whose Inputs panel promotes each of
 * its editors, laid out by the production scene builder for that subgraph.
 * The panel stands at `position`. The subgraph is entered from no node, so
 * the panel's fields show the example's values as the defaults inside.
 */
function createInputsPanelScene(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  example: InNodeEditorExample,
  target: NodeSchema,
  position: { x: number; y: number },
): Scene {
  const editors = target.body.flatMap((row) => row.kind === 'input' && row.widget !== undefined ? [row.id] : [])
  const loaded = loadDocument({
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'canvas-gallery',
    root: 'gallery',
    graphs: {
      gallery: {
        id: 'gallery', name: 'Gallery', nextOrdinal: 2, links: {}, nets: {}, reroutes: {},
        nodes: { outer: { id: 'outer', type: '#inside', values: {} } },
      },
      inside: {
        id: 'inside', name: 'Inside', nextOrdinal: 2, links: {}, nets: {}, reroutes: {},
        nodes: { [example.id]: { id: example.id, type: target.type, values: { ...defaultValuesOf(target), ...(example.values ?? {}) } } },
        boundary: {
          inputs: editors.map((id) => ({ id, promoted: true, binds: { kind: 'port', node: example.id, port: id } })),
          outputs: [],
        },
      },
    },
    view: {
      graphs: {
        gallery: { nodes: { outer: { position: { x: 0, y: 0 } } } },
        inside: {
          nodes: { [example.id]: { position: { x: position.x + 2000, y: position.y } } },
          boundary: { inputs: { position }, outputs: { position: { x: position.x + 4000, y: position.y } } },
          ...(example.view?.editors !== undefined ? { inputsPanel: { editors: example.view.editors } } : {}),
        },
      },
    },
  } as never)
  if (!loaded.document) throw new Error(`Invalid gallery document: ${JSON.stringify(loaded)}`)
  return buildScene({
    document: loaded.document,
    graphId: 'inside',
    resolve: documentResolver(loaded.document, (type) => type === target.type ? target : undefined),
    tokens,
    measure,
    widgetMeasure,
  })
}

/**
 * A general Primitive at `position` whose output feeds the example node's
 * first editor, laid out by the production scene builder. The fed node
 * stands to the right, off the card.
 */
function createPrimitiveScene(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  example: InNodeEditorExample,
  target: NodeSchema,
  position: { x: number; y: number },
): Scene {
  const fed = target.body.flatMap((row) => row.kind === 'input' && row.widget !== undefined ? [row.id] : [])[0]!
  const loaded = loadDocument({
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'canvas-gallery',
    root: 'gallery',
    graphs: {
      gallery: {
        id: 'gallery', name: 'Gallery', nextOrdinal: 3, nets: {}, reroutes: {},
        nodes: {
          [example.id]: { id: example.id, type: primitiveSchema.type, values: example.values ?? {} },
          fed: { id: 'fed', type: target.type, values: defaultValuesOf(target) },
        },
        links: { primitive: { id: 'primitive', from: { node: example.id, port: 'value' }, to: { node: 'fed', port: fed } } },
      },
    },
    view: {
      graphs: {
        gallery: {
          nodes: {
            [example.id]: { position, size: { width: example.width ?? GALLERY_NODE_WIDTH, height: 0 }, ...(example.view ?? {}) },
            fed: { position: { x: position.x + 2000, y: position.y }, size: { width: GALLERY_NODE_WIDTH, height: 0 } },
          },
        },
      },
    },
  } as never)
  if (!loaded.document) throw new Error(`Invalid gallery document: ${JSON.stringify(loaded)}`)
  return buildScene({
    document: loaded.document,
    graphId: 'gallery',
    resolve: (type) => type === primitiveSchema.type ? primitiveSchema : type === target.type ? target : undefined,
    tokens,
    measure,
    widgetMeasure,
  })
}
