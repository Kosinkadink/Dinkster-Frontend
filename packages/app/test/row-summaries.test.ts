/**
 * What a closed row shows for its value, painted by the product's registry
 * painter over the core widget views, and what pointing at the row reads
 * out. Text is measured at 6 px a character.
 */
import { createRegistryPainter, defaultTokens, type LayoutRow, type WidgetPaintArgs } from '@dinkster/canvas'
import { registerCatalog, type Json, type WidgetSpec } from '@dinkster/core'
import { createWidgetRegistry, registerCoreWidgets, widgetRegistrationDoors } from '@dinkster/widgets'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import english from '../src/locales/en.json'
import { resolveCanvasTooltip, WIDGET_READOUT_ITEMS, type CanvasTooltipContext } from '../src/tooltips.js'

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
  const texts: { text: string; font: string }[] = []
  const fills: string[] = []
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '12px system-ui', globalAlpha: 1, textAlign: 'left',
    beginPath() {}, save() {}, restore() {}, translate() {}, scale() {}, arc() {}, moveTo() {}, lineTo() {},
    stroke() {}, rect() {}, clip() {}, roundRect() {}, fill() {}, setLineDash() {}, closePath() {},
    fillRect() { fills.push(String(this.fillStyle)) },
    measureText: (text: string) => ({ width: text.length * 6 }),
    fillText(text: string) { texts.push({ text, font: this.font }) },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, fills }
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

describe('a closed row shows its stored value for each of the 16 kinds', () => {
  it.each([
    ['MULTI_COMBO empty', specOf('MULTI_COMBO', { options: samplers }), [], 'No selections'],
    // Labels in stored order; a value no longer offered keeps its own text in place.
    ['MULTI_COMBO', specOf('MULTI_COMBO', { options: samplers }), ['dpmpp_2m', 'lms_old', 'euler'], 'DPM++ 2M, lms_old, Euler'],
    ['LIST empty', floatList, [], 'Empty'],
    // Written as stored, never rounded to the 0.1 step.
    ['LIST', floatList, [0.25, 0.30000000000000004], '0.25, 0.30000000000000004'],
    ['LIST of one empty string', stringList, [''], '""'],
    ['COLORS empty', specOf('COLORS'), [], 'No colors'],
    ['MARKDOWN blank', specOf('MARKDOWN'), ' \n\t', 'Empty'],
    ['MARKDOWN one line', specOf('MARKDOWN'), '# Heading', '# Heading'],
    // CRLF is one break; the blank first and last lines count.
    ['MARKDOWN', specOf('MARKDOWN'), '\n# Heading\r\nbody\n', '# Heading (4 lines)'],
    ['MARKDOWN with markup', specOf('MARKDOWN'), '<b>bold</b>', '<b>bold</b>'],
    ['ASSET empty', specOf('ASSET', { accept: ['image/png'] }), null, 'Choose image'],
    ['ASSET one', specOf('ASSET'), image('shot.png'), 'shot.png'],
    ['ASSET with repeated names', specOf('ASSET'), [image('shot.png'), image('shot.png', 'b')], 'shot.png, shot.png'],
    ['AUDIO_RECORD empty', specOf('AUDIO_RECORD'), null, 'Record audio'],
    ['WEBCAM empty', specOf('WEBCAM'), null, 'Capture frame'],
    ['MOUNT default', specOf('MOUNT'), null, 'Default output mount'],
    ['MOUNT', specOf('MOUNT'), 'renders', 'renders'],
    ['LOAD_3D', specOf('LOAD_3D'), { camera: { fov: 35 } }, 'Open 3D viewport'],
    // x 0 and y 0 are a valid corner, not an empty value.
    ['BOUNDING_BOX at the origin', specOf('BOUNDING_BOX'), { x: 0, y: 0, width: 512, height: 512 }, 'x 0, y 0; 512 x 512'],
    ['BOUNDING_BOX with no width', specOf('BOUNDING_BOX'), { x: 0, y: 0, width: 0, height: 512 }, 'Invalid value'],
    ['BOUNDING_BOX below zero', specOf('BOUNDING_BOX'), { x: -4, y: 0, width: 8, height: 8 }, 'Invalid value'],
    ['IMAGECOMPARE', specOf('IMAGECOMPARE'), null, 'Open image comparison'],
    ['CAMERA_ANGLE_VIEW', specOf('CAMERA_ANGLE_VIEW'), 'front', 'Open camera angle'],
    ['RESOLUTION_PREVIEW', specOf('RESOLUTION_PREVIEW'), null, 'Resolution preview'],
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

  it('draws a populated COLORS row as its squares in stored order and a COLOR with its square', () => {
    const colors = ['#111111', '#222222', '#111111']
    const painted = paintRow(specOf('COLORS'), colors, 600)
    expect(painted.text).toBe('')
    expect(painted.fills.filter((fill) => fill.startsWith('#1') || fill.startsWith('#2'))).toEqual(colors)
    expect(paintRow(specOf('COLOR'), '#32e6c5', 600).fills).toContain('#32e6c5')
  })
})

describe('a value that does not fit gives way in order', () => {
  const widths = Array.from({ length: 80 }, (_, index) => 60 + index * 6)
  const formsOf = (spec: WidgetSpec, value: Json) => [...new Set(widths.map((width) => paintRow(spec, value, width).text))]

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

  it('keeps a save target\'s mount and last part before cutting', () => {
    const forms = formsOf(specOf('SAVE_TARGET'), { mount: 'renders', prefix: 'portraits/2026/session/frame' })
    expect(forms).toContain('renders/portraits/2026/session/frame')
    expect(forms).toContain('renders/.../frame')
    // The full prefix is never cut; only the shortened form is.
    for (const form of forms.filter((text) => text.endsWith('...') && text !== 'renders/.../frame'))
      expect('renders/.../frame'.startsWith(form.slice(0, -3))).toBe(true)
  })
})

describe('a value arriving down a wire uses the same summary', () => {
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
      'Current expected value: 1 item', '1. only',
      'Dormant stored value under connection: 3 items', '1. a', 'and 2 more',
    ])
  })

  it('never writes out the object of a row that only opens an editor', () => {
    expect(readout(specOf('LOAD_3D'), { camera: { fov: 35 } })).toEqual([])
    expect(readout(specOf('CAMERA_ANGLE_VIEW'), 'front')).toEqual([])
  })

  it('reads the incoming value first and the stored one under it', () => {
    expect(readout(stringList, ['a', 'b', 'c'], { value: ['only'], state: 'expected' })).toEqual([
      'Current expected value: 1 item', '1. only',
      'Dormant stored value under connection: 3 items', '1. a', '2. b', '3. c',
    ])
  })
})
