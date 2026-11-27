/**
 * What a closed row shows for its value, painted by the product's registry
 * painter over the core widget views, and what pointing at the row reads
 * out. Text is measured at 6 px a character.
 */
import { createRegistryPainter, defaultTokens, paintToolboxIcon, widgetValueText, type CanvasIconName, type LayoutRow, type WidgetPaintArgs } from '@dinkster/canvas'
import { registerCatalog, type Json, type WidgetSpec } from '@dinkster/core'
import { createWidgetRegistry, registerCoreWidgets, widgetRegistrationDoors } from '@dinkster/widgets'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import english from '../src/locales/en.json'
import { resolveCanvasTooltip, WIDGET_READOUT_ITEMS, type CanvasTooltipContext } from '../src/tooltips.js'
import { assetRowThumbnails, type PreviewLoader } from '../src/node-previews.js'
import { wiredEditorSummaries } from '../src/InNodeEditorSpaces.js'
import { createSaveTargetScene } from '../../canvas/gallery/save-target-box.js'

beforeAll(() => {
  registerCatalog('en', english)
  vi.stubGlobal('Path2D', class Path2D { constructor(readonly d: string) {} })
})
afterAll(() => vi.unstubAllGlobals())

const registry = createWidgetRegistry()
registerCoreWidgets(widgetRegistrationDoors(registry))
const painter = createRegistryPainter(registry)
const LABEL = 'v'

function fakeCtx() {
  const texts: { text: string; font: string; color: string; x: number }[] = []
  const fills: string[] = []
  const images: unknown[] = []
  const imageRects: { x: number; width: number }[] = []
  const paths: string[] = []
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '12px system-ui', globalAlpha: 1, textAlign: 'left',
    beginPath() {}, save() {}, restore() {}, translate() {}, scale() {}, arc() {}, moveTo() {}, lineTo() {},
    stroke(path?: { d: string }) { if (path) paths.push(path.d) }, rect() {}, clip() {}, roundRect() {}, fill() {}, setLineDash() {}, closePath() {},
    drawImage(image: unknown, x: number, _y: number, width: number) { images.push(image); imageRects.push({ x, width }) },
    fillRect() { fills.push(String(this.fillStyle)) },
    measureText: (text: string) => ({ width: text.length * 6 }),
    fillText(text: string, x: number) { texts.push({ text, font: this.font, color: String(this.fillStyle), x }) },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, fills, images, imageRects, paths }
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

const specOf = (widgetType: string, options: Record<string, Json> = {}, extra: Partial<WidgetSpec> = {}): WidgetSpec =>
  ({ widgetType, options, ...extra })

const rowOf = (spec: WidgetSpec): Extract<LayoutRow, { kind: 'widget' }> => ({
  kind: 'widget', y: 0, height: 24, inset: 0, inputId: 'v', valueKey: 'v', address: { port: 'v' }, label: LABEL,
  type: { kind: 'concrete', name: spec.widgetType }, viewId: registry.kind(spec.widgetType)!.defaultView(spec),
  rows: 1, spec,
})

/** The value text a row paints, beside its label, and the color squares it paints. */
function paintRow(spec: WidgetSpec, value: Json, width: number, companion?: WidgetPaintArgs['companion']) {
  const { ctx, texts, fills } = fakeCtx()
  const frozen = deepFreeze(value)
  painter({
    ctx, row: rowOf(spec), value: frozen, x: 0, y: 0, width, rowHeight: 24,
    connected: companion !== undefined, tokens: defaultTokens,
    ...(companion !== undefined ? { companion } : {}),
  })
  const shown = texts.filter((call) => call.text !== LABEL && call.text !== '')
  return { text: shown.map((call) => call.text).join(' | '), italic: shown.some((call) => call.font.startsWith('italic')), fills }
}

const image = (name: string, fill = 'a'): Json => ({
  digest: `blake3:${fill.repeat(64)}`, name, size: 12, mediaType: 'image/png', virtualPath: `input/${name}`,
})
const samplers = [
  { value: 'euler', label: 'Euler' },
  { value: 'dpmpp_2m', label: 'DPM++ 2M' },
  { value: 'dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
]
const floatList = specOf('LIST', {}, { element: { widgetType: 'FLOAT', options: { step: 0.1 } } })
const stringList = specOf('LIST', {}, { element: { widgetType: 'STRING', options: {} } })
const videoEdit = specOf('VIDEO_EDIT', { features: ['trim', 'crop'] })

describe('closed file rows', () => {
  it('keeps empty file text muted and italic with a thumbnail-only host summary', () => {
    const spec = specOf('ASSET', { accept: ['image/png'] })
    const painted = fakeCtx()
    painter({ ctx: painted.ctx, row: rowOf(spec), value: null, x: 0, y: 0, width: 460,
      rowHeight: 24, connected: false, tokens: defaultTokens, editorSummary: {},
    })
    expect(painted.texts.find((call) => call.text === 'Choose image')).toMatchObject({ color: defaultTokens.colors.label })
    expect(painted.texts.find((call) => call.text === 'Choose image')?.font).toContain('italic')
    expect(painted.images).toEqual([])
  })

  it.each([false, true])('separates pictures from the previous entry and groups them with their name (wired %s)', (wired) => {
    const value = [image('a.png'), { ...(image('sound.wav') as Record<string, Json>), mediaType: 'audio/wav' }, image('clip.webm')]
    const spec = specOf('ASSET')
    const painted = fakeCtx()
    const bitmap = {} as CanvasImageSource
    painter({ ctx: painted.ctx, row: rowOf(spec), value, x: 0, y: 0, width: 600,
      rowHeight: 24, connected: wired, tokens: defaultTokens,
      editorSummary: { thumbnails: [bitmap, undefined, bitmap] },
      ...(wired ? { companion: { value, state: 'expected' as const } } : {}),
    })
    for (const [index, name] of ['a.png', 'clip.webm'].entries()) {
      const picture = painted.imageRects[index]!
      expect(painted.texts.find((call) => call.text === name)!.x - picture.x - picture.width).toBe(4)
    }
    const sound = painted.texts.find((call) => call.text === 'sound.wav')!
    // Nine characters and the comma at 6 px each, then an 8 px entry gap.
    expect(painted.imageRects[1]!.x - (sound.x + 10 * 6)).toBe(8)
    expect(painted.images).toHaveLength(2)
  })

  it('keeps previews attached to each field and each carried name, including unknown and sound values', () => {
    const first = image('a.png')
    const second = image('b.png', 'b')
    const audio = { ...(image('sound.wav', 'c') as Record<string, Json>), mediaType: 'audio/wav' }
    const bitmap = {} as CanvasImageSource
    const loader: PreviewLoader = {
      sourceFor: () => undefined,
      peekSource: () => undefined,
      inputAssetSource: (digest) => ({ key: digest, load: async () => ({ image: bitmap }) }),
      resolve: (source) => source.key === (first as Record<string, Json>)['digest'] ? { image: bitmap } : undefined,
      resolveFrame: () => undefined,
    }
    const images = (value: Json) => assetRowThumbnails(value, loader, registry)
    const row = rowOf(specOf('ASSET'))
    const rows = ['stored', 'incoming', 'unknown', 'sound'].map((id) => ({ ...row, inputId: id, valueKey: id }))
    const result = wiredEditorSummaries([{ id: 'n', layout: { rows }, node: { values: { stored: first, incoming: first, unknown: first, sound: audio } } }], {
      wired: (_id, key) => key === 'incoming' || key === 'unknown',
      carried: (_id, key) => key === 'incoming' ? [second, audio, first] : undefined,
    }, 'Not known', images)
    expect(result).toEqual({ n: {
      stored: { thumbnails: [bitmap] },
      incoming: { value: [second, audio, first], thumbnails: [null, undefined, bitmap] },
    } })
    expect(images(audio)).toBeUndefined()
    expect(images(null)).toBeUndefined()
    expect(images([])).toBeUndefined()
    expect(images(image(''))).toBeUndefined()
    expect(assetRowThumbnails([audio, first, first, first], loader, registry, 40)).toEqual([undefined, bitmap, bitmap, null])
    expect(assetRowThumbnails([audio, first, first, first], loader, registry, 41)).toEqual([undefined, bitmap, bitmap, bitmap])
  })

  it.each([
    [['image/png', 'image/jpeg'], undefined, 'image'],
    [['video/mp4'], undefined, 'film'],
    [['audio/wav'], undefined, 'audio-lines'],
    [['model/gltf-binary'], undefined, 'box'],
    [[], 'model/checkpoint', 'box'],
    [[], 'media/model3d', 'box'],
    [['image/png', 'audio/wav'], undefined, 'file'],
    [[], undefined, 'file'],
  ] as const)('shows the icon of accepted kinds %j (%s), even without a file', (accept, kind, icon) => {
    const spec = specOf('ASSET', { accept: [...accept] }, kind === undefined ? {} : { kind })
    const { ctx, paths } = fakeCtx()
    const expected = fakeCtx()
    paintToolboxIcon(expected.ctx, icon as CanvasIconName, 0, 0, 16, '#fff')
    for (const value of [null, image('shot.png')]) {
      paths.length = 0
      painter({ ctx, row: rowOf(spec), value, x: 0, y: 0, width: 600, rowHeight: 24, connected: false, tokens: defaultTokens })
      expect(paths.slice(0, expected.paths.length)).toEqual(expected.paths)
    }
  })

  it('fits each thumbnail with its name, reserves pending pictures, and drops pictures for count-only summaries', () => {
    const first = {} as CanvasImageSource
    const second = {} as CanvasImageSource
    const value = [image('a.png'), image('b.png', 'b'), image('c.png', 'c'), image('d.png', 'd')]
    const spec = specOf('ASSET')
    const render = (width: number, thumbnails: NonNullable<WidgetPaintArgs['editorSummary']>, companion?: WidgetPaintArgs['companion']) => {
      const result = fakeCtx()
      painter({ ctx: result.ctx, row: rowOf(spec), value, x: 0, y: 0, width, rowHeight: 24,
        connected: companion !== undefined, tokens: defaultTokens, editorSummary: thumbnails,
        ...(companion === undefined ? {} : { companion }),
      })
      return { text: result.texts.filter((call) => call.text !== LABEL).map((call) => call.text).join(''), images: result.images }
    }
    for (const companion of [undefined, { value, state: 'expected' as const }]) {
      const full = render(600, { thumbnails: [first, second, undefined, null] }, companion)
      expect(full).toEqual({ text: 'a.png, b.png, c.png, d.png', images: [first, second] })
      const pending = render(250, { thumbnails: [null, second, undefined, null] }, companion)
      const ready = render(250, { thumbnails: [first, second, undefined, second] }, companion)
      expect(pending.text).toBe(ready.text)
      expect(ready.text).toContain('+')
      const narrow = Array.from({ length: 20 }, (_, index) => render(90 + index * 4, { thumbnails: [first, second, first, second] }, companion))
      expect(narrow.find((shown) => shown.text === '4 assets')).toEqual({ text: '4 assets', images: [] })
    }
    const long = [image('a-very-long-checkpoint-name.png'), image('b.png', 'b')]
    const result = fakeCtx()
    painter({ ctx: result.ctx, row: rowOf(spec), value: long, x: 0, y: 0, width: 260, rowHeight: 24,
      connected: false, tokens: defaultTokens, editorSummary: { thumbnails: [first, second] },
    })
    expect(result.texts.map((call) => call.text).join('')).toContain('... +1')
    expect(result.images).toEqual([first])
  })
})

describe('a closed row shows its stored value for each retained kind', () => {
  it.each([
    ['MULTI_COMBO empty', specOf('MULTI_COMBO', { options: samplers }), [], 'No selections'],
    // Labels in stored order; a value no longer offered keeps its own text in place.
    ['MULTI_COMBO', specOf('MULTI_COMBO', { options: samplers }), ['dpmpp_2m', 'lms_old', 'euler'], 'DPM++ 2M, lms_old, Euler'],
    ['LIST empty', floatList, [], 'Empty'],
    // Written as stored, never rounded to the 0.1 step.
    ['LIST', floatList, [0.25, 0.30000000000000004], '0.25, 0.30000000000000004'],
    ['LIST of one empty string', stringList, [''], '""'],
    ['MARKDOWN blank', specOf('MARKDOWN'), ' \n\t', 'Empty'],
    ['MARKDOWN one line', specOf('MARKDOWN'), '# Heading', '# Heading'],
    // CRLF is one break; the blank first and last lines count.
    ['MARKDOWN', specOf('MARKDOWN'), '\n# Heading\r\nbody\n', '# Heading (4 lines)'],
    ['MARKDOWN with markup', specOf('MARKDOWN'), '<b>bold</b>', '<b>bold</b>'],
    ['ASSET empty', specOf('ASSET', { accept: ['image/png'] }), null, 'Choose image'],
    ['ASSET one', specOf('ASSET'), image('shot.png'), 'shot.png'],
    ['ASSET with repeated names', specOf('ASSET'), [image('shot.png'), image('shot.png', 'b')], 'shot.png, shot.png'],
    ['AUDIO_RECORD empty', specOf('AUDIO_RECORD'), null, 'No clip'],
    ['WEBCAM empty', specOf('WEBCAM'), null, 'No frame'],
    ['MOUNT default', specOf('MOUNT'), null, 'Default output mount'],
    ['MOUNT', specOf('MOUNT'), 'renders', 'renders'],
    ['LOAD_3D', specOf('LOAD_3D'), { camera: { fov: 35 } }, 'Open 3D viewport'],
    // x 0 and y 0 are a valid corner, not an empty value.
    ['BOUNDING_BOX at the origin', specOf('BOUNDING_BOX'), { x: 0, y: 0, width: 512, height: 512 }, 'x 0, y 0; 512 x 512'],
    ['BOUNDING_BOX with no width', specOf('BOUNDING_BOX'), { x: 0, y: 0, width: 0, height: 512 }, 'Invalid value'],
    ['BOUNDING_BOX below zero', specOf('BOUNDING_BOX'), { x: -4, y: 0, width: 8, height: 8 }, 'Invalid value'],
    ['IMAGECOMPARE', specOf('IMAGECOMPARE'), null, 'Open image comparison'],
    ['CAMERA_ANGLE_VIEW', specOf('CAMERA_ANGLE_VIEW'), 'front', 'Open camera angle'],
    ['SAVE_TARGET default', specOf('SAVE_TARGET'), null, 'Default output'],
    ['SAVE_TARGET', specOf('SAVE_TARGET'), { mount: 'renders', prefix: 'session/frame' }, 'renders/session/frame'],
    ['VIDEO_EDIT empty', videoEdit, {}, 'No edits'],
    // Unknown fields are kept and never shown.
    ['VIDEO_EDIT', videoEdit, { trim: { start_time: 1.5, duration: 2 }, crop: { x: 8, y: 12, width: 512, height: 768 }, vendor: { note: 'x' } },
      'Trim 1.5s + 2s; crop 512 x 768 at 8,12'],
    ['VIDEO_EDIT crop only', videoEdit, { crop: { x: 8, y: 12, width: 512, height: 768 } }, 'Crop 512 x 768 at 8,12'],
    // No end time is worked out for a trim without its duration.
    ['VIDEO_EDIT without duration', videoEdit, { trim: { start_time: 1.5 } }, 'Trim'],
    ['VIDEO_EDIT with a fractional crop', videoEdit, { crop: { x: 8, y: 12, width: 512.5, height: 768 } }, 'Invalid value'],
    ['COLOR', specOf('COLOR'), '#32e6c5', '#32e6c5'],
  ] as const)('%s', (_name, spec, value, expected) => {
    expect(paintRow(spec, value as Json, 600).text).toBe(expected)
  })

  it('draws a COLOR with its square', () => {
    expect(paintRow(specOf('COLOR'), '#32e6c5', 600).fills).toContain('#32e6c5')
  })
})

describe('a value that does not fit gives way in order', () => {
  const widths = Array.from({ length: 80 }, (_, index) => 60 + index * 6)
  const formsOf = (spec: WidgetSpec, value: Json) => [...new Set(widths.map((width) => paintRow(spec, value, width).text))]

  it.each([
    ['LOAD_3D', {}],
    ['IMAGECOMPARE', null],
    ['CAMERA_ANGLE_VIEW', 'front'],
  ] as const)('draws the %s opener upright, keeps its label first and never paints a lone ellipsis', (kind, value) => {
    for (const width of [600, 180, 140, 120]) {
      const { ctx, texts } = fakeCtx()
      const spec = specOf(kind)
      painter({
        ctx, row: { ...rowOf(spec), label: 'populated' }, value, x: 0, y: 0,
        width, rowHeight: 24, connected: false, tokens: defaultTokens,
      })
      expect(texts[0]?.text).toBe('populated')
      expect(texts.some((call) => call.text === '...')).toBe(false)
      const opener = texts.filter((call) => call.text.startsWith('Open'))
      if (width === 600) expect(opener).toHaveLength(1)
      for (const call of opener) {
        expect(call.font.startsWith('italic')).toBe(false)
        expect(call.color).toBe(defaultTokens.colors.value)
      }
    }
  })

  it('shows whole choices and the count of the rest, then the count alone', () => {
    const spec = specOf('MULTI_COMBO', { options: samplers })
    const forms = formsOf(spec, ['dpmpp_2m_sde', 'euler', 'dpmpp_2m'])
    expect(forms).toContain('DPM++ 2M SDE, Euler, DPM++ 2M')
    expect(forms).toContain('DPM++ 2M SDE, Euler +1')
    expect(forms).toContain('3 selected')
    for (const form of forms) {
      const more = /\+(\d+)$/u.exec(form)
      // +N is the number of choices not shown; a cut name still counts as shown.
      if (more) expect(Number(more[1])).toBe(3 - form.replace(/ \+\d+$/u, '').split(', ').length)
      else expect(['DPM++ 2M SDE, Euler, DPM++ 2M', '3 selected']).toContain(form.endsWith('...') ? '3 selected' : form)
    }
  })

  it('falls back from the trim and crop numbers to their names as one unit', () => {
    const forms = formsOf(videoEdit, { trim: { start_time: 1.5, duration: 2 }, crop: { x: 8, y: 12, width: 512, height: 768 } })
    expect(forms).toContain('Trim 1.5s + 2s; crop 512 x 768 at 8,12')
    expect(forms).toContain('Trim + crop')
    // The detailed form is never cut; only the short one is.
    for (const form of forms.filter((text) => text.endsWith('...')))
      expect('Trim + crop'.startsWith(form.slice(0, -3))).toBe(true)
  })

  it('keeps the mount and last segment of a long save prefix', () => {
    const forms = formsOf(specOf('SAVE_TARGET'), { mount: 'renders', prefix: 'a-long-session/nested/frame' })
    expect(forms).toContain('renders/a-long-session/nested/frame')
    expect(forms).toContain('renders/.../frame')
    expect(formsOf(specOf('SAVE_TARGET'), { mount: 'renders', prefix: 'frame' }).some((text) => text.includes('/.../'))).toBe(false)
  })

})

describe('a value arriving down a wire uses the same summary', () => {
  it('composes mapped Save inputs from their own wires, defaults and stored values without revealing dormant values', () => {
    const measure = (spec: WidgetSpec) => {
      const viewId = registry.kind(spec.widgetType)!.defaultView(spec)
      const view = registry.viewsFor(spec.widgetType).find((view) => view.id === viewId)!
      return { viewId, rows: view.measure(spec).rows }
    }
    const scene = createSaveTargetScene(defaultTokens, (text) => text.length * 6, measure,
      { x: 0, y: 0 }, { mount: 'stored-mount', prefix: 'stored/name' }, { mapped: true })
    const node = scene.nodes.find((node) => node.node.values['filename_prefix'] === 'stored/name')!
    const summary = (wired: readonly string[], arriving: Readonly<Record<string, Json>>) => wiredEditorSummaries([node], {
      wired: (_node, id) => wired.includes(id), carried: (_node, id) => arriving[id],
    }, 'Not known yet')[node.id]?.['target']
    expect(summary(['mount'], { mount: 'incoming-mount' })?.value).toEqual({ mount: 'incoming-mount', prefix: 'stored/name' })
    expect(summary(['filename_prefix'], { filename_prefix: 'incoming/name' })?.value).toEqual({ mount: 'stored-mount', prefix: 'incoming/name' })
    expect(summary(['mount', 'filename_prefix'], { mount: null, filename_prefix: '' })?.value).toEqual({ prefix: '' })
    expect(summary(['mount'], {})).toEqual({ text: 'Not known yet', placeholder: true, value: null })
    expect(summary(['filename_prefix'], {})).toEqual({ text: 'Not known yet', placeholder: true, value: null })
    expect(summary([], {})?.value).toEqual({ mount: 'stored-mount', prefix: 'stored/name' })
    const defaults = wiredEditorSummaries([{ ...node, node: { values: {} } }], {
      wired: () => false, carried: () => undefined,
    }, 'Not known yet')
    expect(defaults[node.id]?.['target']?.value).toEqual({ prefix: 'ComfyUI' })
    expect(node.node.values).toMatchObject({ mount: 'stored-mount', filename_prefix: 'stored/name' })
    expect(node.node.values).not.toHaveProperty('target')
  })

  it('shows the known incoming list, not the stored one, and keeps the estimate mark', () => {
    const stored = ['dpmpp_2m', 'euler', 'dpmpp_2m_sde']
    const spec = specOf('MULTI_COMBO', { options: samplers })
    const known = paintRow(spec, stored, 600, { value: ['euler'], state: 'expected' })
    expect(known.text).toBe('Euler')
    expect(known.italic).toBe(true)
    expect(paintRow(spec, stored, 600, { value: ['euler', 'dpmpp_2m'], state: 'estimate' }).text)
      .toBe('\u2248 Euler, DPM++ 2M')
  })
})

describe('pointing at a row reads out its whole value without changing it', () => {
  const context: CanvasTooltipContext = {
    widgetReadout: (row, value) => registry.viewsFor(row.spec.widgetType)
      .find((view) => view.id === row.viewId)?.readout?.(value, row.spec),
  }
  const readout = (spec: WidgetSpec, value: Json, companion?: { value: Json; state: 'expected' }, tooltipLines?: number) => {
    const values = deepFreeze({ v: value })
    const target = {
      kind: 'widget',
      connected: companion !== undefined,
      hit: { node: { node: { type: 'Node', values } }, row: rowOf(spec) },
      ...(companion !== undefined ? { companion } : {}),
    }
    return resolveCanvasTooltip(target, { detailed: false }, { ...context, ...(tooltipLines !== undefined ? { tooltipLines } : {}) })?.lines
  }

  it('lists each item with its position, repeated and comma-bearing items included', () => {
    expect(readout(specOf('ASSET'), [image('shot.png'), image('shot.png', 'b')]))
      .toEqual(['Value: 2 assets', '1. shot.png', '2. shot.png'])
    expect(readout(stringList, ['', 'a, b'])).toEqual(['Value: 2 items', '1. ""', '2. a, b'])
    expect(readout(floatList, [0.30000000000000004])).toEqual(['Value: 1 item', '1. 0.30000000000000004'])
    expect(readout(specOf('MULTI_COMBO', { options: samplers }), ['euler', 'gone']))
      .toEqual(['Value: 2 selected', '1. Euler', '2. gone'])
  })

  it('reads out a long list up to its limit, then how many more', () => {
    const lines = readout(stringList, Array.from({ length: WIDGET_READOUT_ITEMS + 5 }, (_, index) => `item ${index + 1}`))!
    expect(lines).toHaveLength(WIDGET_READOUT_ITEMS + 2)
    expect(lines[0]).toBe(`Value: ${WIDGET_READOUT_ITEMS + 5} items`)
    expect(lines.at(-2)).toBe(`${WIDGET_READOUT_ITEMS}. item ${WIDGET_READOUT_ITEMS}`)
    expect(lines.at(-1)).toBe('and 5 more')
  })

  it('lists only as many items as fit on screen under the title, then how many more', () => {
    const items = (count: number) => Array.from({ length: count }, (_, index) => `item ${index + 1}`)
    expect(readout(stringList, items(4), undefined, 6)).toEqual(['Value: 4 items', '1. item 1', '2. item 2', '3. item 3', '4. item 4'])
    expect(readout(stringList, items(5), undefined, 6)).toEqual(['Value: 5 items', '1. item 1', '2. item 2', '3. item 3', 'and 2 more'])
    expect(readout(stringList, ['a', 'b', 'c'], { value: ['only'], state: 'expected' }, 6)).toEqual([
      'Arriving: 1 item', '1. only',
      'Stored: 3 items. Used again when the wire is removed.', '1. a', 'and 2 more',
    ])
    for (const count of [4, 30]) {
      expect(readout(stringList, ['saved a', 'saved b', 'saved c'], { value: items(count), state: 'expected' }, 6)).toEqual([
        `Arriving: ${count} items`, '1. item 1', `and ${count - 1} more`,
        'Stored: 3 items. Used again when the wire is removed.', 'and 3 more',
      ])
    }
    expect(readout(stringList, ['saved'], { value: items(4), state: 'expected' }, 3)).toEqual([
      'Arriving: 4 items', 'Stored: 1 item. Used again when the wire is removed.',
    ])
    expect(readout(stringList, ['saved'], { value: items(4), state: 'expected' }, 2)).toEqual([
      'Arriving: 4 items',
    ])
    expect(readout(stringList, ['saved'], { value: items(4), state: 'expected' }, 1)).toEqual([])
  })

  it('fits complete wrapped items and keeps both remainder counts visible', () => {
    const target = {
      kind: 'widget', connected: true,
      hit: { node: { node: { type: 'Node', values: { v: ['saved a', 'saved b', 'saved c'] } } }, row: rowOf(stringList) },
      companion: { state: 'expected', value: ['long first item', 'long second item', 'short third item', 'last item'] },
    }
    const tip = resolveCanvasTooltip(target, { detailed: false }, context)!
    const measure = (text: string) => text.includes('long ') ? 4 : text.startsWith('Stored:') ? 2 : 1
    expect(tip.fit!(10, measure).lines).toEqual([
      'Arriving: 4 items', '1. long first item', 'and 3 more',
      'Stored: 3 items. Used again when the wire is removed.', 'and 3 more',
    ])
    expect(tip.fit!(14, measure).lines).toEqual([
      'Arriving: 4 items', '1. long first item', '2. long second item', 'and 2 more',
      'Stored: 3 items. Used again when the wire is removed.', 'and 3 more',
    ])
    expect(tip.fit!(6, measure).lines).toEqual([
      'Arriving: 4 items', 'and 4 more',
      'Stored: 3 items. Used again when the wire is removed.', 'and 3 more',
    ])
  })

  it('never writes out the object of a row that only opens an editor', () => {
    expect(readout(specOf('LOAD_3D'), { camera: { fov: 35 } })).toEqual([])
    expect(readout(specOf('CAMERA_ANGLE_VIEW'), 'front')).toEqual([])
  })

  it('reads the full save prefix and names a project-default target without inventing a mount', () => {
    const spec = specOf('SAVE_TARGET', { suffix: '.png' })
    const naming = 'Subfolders and filename stem only. The writer adds numbering and .png.'
    expect(readout(spec, { mount: 'renders', prefix: 'a-long-session/nested/frame' }))
      .toEqual(['Value: renders/a-long-session/nested/frame', naming])
    expect(readout(spec, { prefix: 'nested/frame' }))
      .toEqual(['Value: Project default/nested/frame', naming])
  })

  it('reads the incoming value first and the stored one under it', () => {
    expect(readout(stringList, ['a', 'b', 'c'], { value: ['only'], state: 'expected' })).toEqual([
      'Arriving: 1 item', '1. only',
      'Stored: 3 items. Used again when the wire is removed.', '1. a', '2. b', '3. c',
    ])
    const curve = (count: number): Json => ({ interpolation: 'linear', points: Array.from({ length: count }, (_, i) => ({ position: i / (count - 1), value: i % 2 })) })
    expect(readout(specOf('CURVE'), curve(5), { value: curve(8), state: 'expected' })).toEqual([
      'Arriving: 8 points, Linear', 'Stored: 5 points, Linear. Used again when the wire is removed.',
    ])
  })

  it('keeps the stored-value explanation when items are capped or the room is limited', () => {
    const stored = Array.from({ length: 25 }, (_, index) => `saved ${index + 1}`)
    const companion = { value: ['only'], state: 'expected' as const }
    const full = readout(stringList, stored, companion)!
    expect(full[2]).toBe('Stored: 25 items. Used again when the wire is removed.')
    expect(full.at(-1)).toBe('and 5 more')
    expect(readout(stringList, stored, companion, 6)).toEqual([
      'Arriving: 1 item', '1. only',
      'Stored: 25 items. Used again when the wire is removed.', '1. saved 1', 'and 24 more',
    ])
  })
})

describe('a value named beside the open row reads as the closed row would, in full', () => {
  const valueText = (spec: WidgetSpec, value: Json) => widgetValueText(registry, rowOf(spec).viewId, value, spec)

  it('writes the whole summary, never JSON', () => {
    expect(valueText(specOf('BOUNDING_BOX'), { x: 0, y: 0, width: 1024, height: 768 })).toBe('x 0, y 0; 1024 x 768')
    expect(valueText(specOf('MULTI_COMBO', { options: samplers }), ['dpmpp_2m_sde', 'euler', 'gone'])).toBe('DPM++ 2M SDE, Euler, gone')
    expect(valueText(specOf('MULTI_COMBO', { options: samplers }), [])).toBe('No selections')
    expect(valueText(specOf('MARKDOWN'), '\n# Heading\nbody')).toBe('# Heading (3 lines)')
  })

  it('names no value for a row that only opens an editor, and nothing for a kind it cannot read', () => {
    expect(valueText(specOf('LOAD_3D'), { camera: { fov: 35 } })).toBeNull()
    expect(widgetValueText(registry, 'no.such.view', 1, specOf('UNKNOWN_KIND'))).toBeUndefined()
  })
})
