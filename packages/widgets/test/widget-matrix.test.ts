import { describe, expect, it } from 'vitest'
import { effectiveWidgetDefault, type CompactState, type Json, type SceneBuilder, type WidgetSpec } from '@dinkster/core'
import { createWidgetRegistry, registerCoreWidgets, widgetRegistrationDoors } from '../src/index.js'

const asset = { digest: `blake3:${'a'.repeat(64)}`, name: 'cat.png', size: 12, mediaType: 'image/png', virtualPath: 'input/cat.png' }

const cases: Array<{
  type: string
  options: Record<string, unknown>
  explicit: Json
  intrinsic: Json | undefined
  invalid: unknown
  invalidCode?: string
  view: string
}> = [
  { type: 'INT', options: { min: 2, max: 9 }, explicit: 5, intrinsic: 2, invalid: 10, invalidCode: 'widget.INT.aboveMax', view: 'core.number' },
  { type: 'FLOAT', options: { min: 0.5, max: 2 }, explicit: 1.25, intrinsic: 0.5, invalid: -1, invalidCode: 'widget.FLOAT.belowMin', view: 'core.number' },
  { type: 'STRING', options: {}, explicit: 'hello', intrinsic: '', invalid: 3, view: 'core.line' },
  { type: 'MARKDOWN', options: {}, explicit: '## Heading\n\n**bold**', intrinsic: '', invalid: 3, view: 'core.markdown' },
  { type: 'BOOLEAN', options: {}, explicit: true, intrinsic: false, invalid: 'true', view: 'core.toggle' },
  { type: 'COMBO', options: { options: ['euler', 'ddim'] }, explicit: 'ddim', intrinsic: 'euler', invalid: 'unknown', invalidCode: 'widget.COMBO.unknownOption', view: 'core.select' },
  { type: 'MULTI_COMBO', options: { options: ['euler', 'ddim'] }, explicit: ['ddim', 'euler', 'ddim'], intrinsic: [], invalid: ['unknown'], invalidCode: 'widget.MULTI_COMBO.unknownOption', view: 'core.multiSelect' },
  { type: 'COLOR', options: {}, explicit: '#12345678', intrinsic: '#ffffff', invalid: 42, view: 'core.color' },
  { type: 'COLORS', options: {}, explicit: ['#A1B2C3dd', '#f00', '#A1B2C3dd'], intrinsic: [], invalid: ['#fff', 3], view: 'core.colors' },
  { type: 'CURVE', options: {}, explicit: { interpolation: 'linear', points: [{ position: 0, value: 0 }, { position: 1, value: 1 }] }, intrinsic: { interpolation: 'monotone_cubic', points: [{ position: 0, value: 0 }, { position: 1, value: 1 }] }, invalid: { points: [{ position: 1, value: 0 }, { position: 1, value: 1 }] }, view: 'core.curve' },
  { type: 'COMPOSITOR', options: {}, explicit: { version: 2, documentDigest: `blake3:${'a'.repeat(64)}`, commands: [{ op: 'layer', id: 'layer-0', changes: { visible: false } }] }, intrinsic: { version: 2, documentDigest: null, commands: [] }, invalid: { version: 2, documentDigest: 'bad', commands: [] }, view: 'core.compositor' },
  { type: 'ASSET', options: {}, explicit: asset, intrinsic: undefined, invalid: { ...asset, size: -1 }, view: 'core.asset' },
  { type: 'AUDIO_RECORD', options: {}, explicit: { ...asset, name: 'recording.webm', mediaType: 'audio/webm' }, intrinsic: undefined, invalid: asset, view: 'core.audioRecord' },
  { type: 'MOUNT', options: {}, explicit: 'archive', intrinsic: null, invalid: 'Invalid/Mount', invalidCode: 'widget.MOUNT.invalid', view: 'core.mount' },
]

const registry = createWidgetRegistry()
const registeredFamilies: string[] = []
const doors = widgetRegistrationDoors(registry)
registerCoreWidgets({
  ...doors,
  widgetKind(id, kind) {
    registeredFamilies.push(kind.type)
    return doors.widgetKind(id, kind)
  },
})

const dispositions = [
  { type: 'INT', compact: 'core.number', expanded: 'exact numeric popover' },
  { type: 'FLOAT', compact: 'core.number', expanded: 'exact numeric popover' },
  { type: 'STRING', compact: 'core.line/core.text', expanded: 'text popover' },
  { type: 'BOOLEAN', compact: 'core.toggle', expanded: 'inline toggle; no modal' },
  { type: 'COMBO', compact: 'core.select', expanded: 'searchable option popover' },
  { type: 'MULTI_COMBO', compact: 'core.multiSelect', expanded: 'ordered multi-select popover' },
  { type: 'LIST', compact: 'core.list', expanded: 'typed JSON array popover' },
  { type: 'COLOR', compact: 'core.color', expanded: 'HSV and hex popover' },
  { type: 'CURVE', compact: 'core.curve', expanded: 'curve editor' },
  { type: 'COMPOSITOR', compact: 'core.compositor', expanded: 'image editor compositor mode' },
  { type: 'ASSET', compact: 'core.asset', expanded: 'product asset modal' },
  { type: 'MOUNT', compact: 'core.mount', expanded: 'writable mount selection popover' },
  { type: 'VIDEO_EDIT', compact: 'core.videoEdit', expanded: 'trim and crop modal' },
  { type: 'BUTTON', compact: 'core.button', expanded: 'registered command action popover' },
  { type: 'MARKDOWN', compact: 'core.markdown', expanded: 'safe preview and source popover' },
  { type: 'AUDIO_RECORD', compact: 'core.audioRecord', expanded: 'explicit recording and staged audio asset modal' },
  { type: 'COLORS', compact: 'core.colors', expanded: 'ordered palette draft popover' },
] as const

describe('registered widget disposition inventory', () => {
  it('copies COLORS defaults without truncation or normalization and draws ordered compact swatches', () => {
    const defaults = ['#A1B2C3dd', '#f00', '#A1B2C3dd', '#ffffff', '#000000']
    const spec: WidgetSpec = { widgetType: 'COLORS', options: {}, default: defaults }
    const kind = registry.kind('COLORS')!
    const copied = kind.defaultValue(spec) as string[]
    expect(copied).toEqual(defaults)
    expect(copied).not.toBe(defaults)
    copied.reverse()
    expect(defaults).toEqual(['#A1B2C3dd', '#f00', '#A1B2C3dd', '#ffffff', '#000000'])
    expect(kind.defaultValue({ ...spec, default: ['#fff', 3] })).toEqual([])
    expect(effectiveWidgetDefault({ ...spec, default: ['#fff', 3] })).toEqual([])
    const rec = recordingBuilder()
    const view = registry.viewsFor('COLORS')[0]!
    view.drawCompact(rec.builder, defaults, spec, { focused: false, connected: false, readonly: false })
    expect(rec.rects.filter((rect) => rect.style['fill'] !== undefined).map((rect) => rect.style['fill'])).toEqual(defaults.slice(0, 4))
    expect(rec.texts.map((text) => text.run)).toContain('5 colors')
    expect(rec.actions).toEqual(['widget.edit'])
    const readonly = recordingBuilder()
    view.drawCompact(readonly.builder, defaults, spec, { focused: false, connected: true, readonly: true })
    expect(readonly.actions).toEqual([])
  })

  it('validates list elements and keeps display and submission defaults aligned', () => {
    for (const [widgetType, values] of [
      ['STRING', ['red', 'blue']], ['INT', [-7, '18446744073709551615']], ['FLOAT', [0.125, -3.75]],
    ] as const) {
      const spec: WidgetSpec = { widgetType: 'LIST', options: {}, element: { widgetType, options: {} }, default: values }
      const kind = registry.kind('LIST')!
      expect(kind.defaultValue(spec)).toEqual(values)
      expect(effectiveWidgetDefault(spec)).toEqual(values)
      expect(kind.validate([...values], spec)).toEqual([])
      expect(kind.validate([[values[0]]], spec).some((diagnostic) => diagnostic.severity === 'error')).toBe(true)
      expect(kind.defaultView(spec)).toBe('core.list')
      expect(kind.defaultValue({ ...spec, default: values[0] })).toEqual([])
      expect(effectiveWidgetDefault({ ...spec, default: values[0] })).toEqual([])
    }
  })

  it('gives every registered core family an explicit compact and expanded/modal disposition', () => {
    expect(dispositions.map(({ type }) => type).sort()).toEqual(registeredFamilies.sort())
    for (const disposition of dispositions) {
      expect(registry.kind(disposition.type), disposition.type).toBeDefined()
      expect(registry.viewsFor(disposition.type).length, disposition.type).toBeGreaterThan(0)
      expect(disposition.compact).not.toBe('')
      expect(disposition.expanded).not.toBe('')
    }
  })
})

const specOf = (entry: typeof cases[number], withDefault = false): WidgetSpec => ({
  widgetType: entry.type,
  options: entry.options,
  ...(withDefault ? { default: entry.explicit } : {}),
})

describe.each(cases)('$type widget kind matrix', (entry) => {
  it('elaborates the registered kind, view, explicit default, and intrinsic default', () => {
    const kind = registry.kind(entry.type)!
    const spec = specOf(entry, true)
    expect(kind.type).toBe(entry.type)
    expect(kind.defaultView(spec)).toBe(entry.view)
    expect(kind.defaultValue(spec)).toEqual(entry.explicit)
    expect(effectiveWidgetDefault(specOf(entry))).toEqual(entry.intrinsic)
  })

  it('accepts its value and rejects or diagnoses malformed values', () => {
    const kind = registry.kind(entry.type)!
    const spec = specOf(entry)
    expect(kind.valueSchema.validate(entry.explicit), 'valid value schema').toBe(true)
    if (entry.invalidCode) {
      if (kind.valueSchema.validate(entry.invalid)) {
        expect(kind.validate(entry.invalid as never, spec).map((d) => d.code)).toContain(entry.invalidCode)
      } else {
        expect(kind.valueSchema.validate(entry.invalid)).toBe(false)
      }
    } else {
      // STRING, BOOLEAN, and ASSET reject wrong shapes in valueSchema; their
      // semantic validator is intentionally inapplicable after shape failure.
      expect(kind.valueSchema.validate(entry.invalid)).toBe(false)
    }
  })
})

describe('STRING and COMBO variants', () => {
  it('selects both STRING views from the multiline hint', () => {
    const kind = registry.kind('STRING')!
    expect(kind.defaultView({ widgetType: 'STRING', options: {} })).toBe('core.line')
    expect(kind.defaultView({ widgetType: 'STRING', options: { multiline: true } })).toBe('core.text')
  })

  it.each([
    ['remote', { widgetType: 'COMBO', options: {}, remote: { route: '/models' } }, undefined],
    // Static options alongside a remote route ARE local truth: the widget
    // displays the first static option, so compile uses it too.
    ['static plus remote', { widgetType: 'COMBO', options: { options: ['cached'] }, remote: { route: '/models' } }, 'cached'],
    ['empty static', { widgetType: 'COMBO', options: { options: [] } }, undefined],
  ] as const)('%s COMBO compile-time intrinsic value matches its display', (_name, comboSpec, expected) => {
    expect(effectiveWidgetDefault(comboSpec)).toBe(expected)
    const found = registry.kind('COMBO')!.validate('server-value', comboSpec)
    // v13 out-of-vocabulary severity split: no local vocabulary at all
    // (remote-only) accepts anything; a static snapshot beside a remote
    // route is a startup-frozen, possibly stale authority (warning); a
    // static-only list is the WHOLE vocabulary (error).
    if (!('remote' in comboSpec)) {
      expect(found.map((d) => [d.code, d.severity])).toContainEqual(['widget.COMBO.unknownOption', 'error'])
    } else if ('options' in comboSpec.options && Array.isArray(comboSpec.options.options)) {
      expect(found.map((d) => [d.code, d.severity])).toContainEqual(['widget.COMBO.unknownOption', 'warning'])
    } else {
      expect(found).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// Compact display: the REAL registered views draw through a recording
// SceneBuilder, so a per-kind display regression (COLOR losing its swatch,
// ASSET no longer naming the file, SAVE_TARGET dropping the suffix) fails
// here - not just in a fake-view plumbing test.
// ---------------------------------------------------------------------------

function recordingBuilder() {
  const texts: Array<{ run: string; style: Readonly<Record<string, unknown>> }> = []
  const rects: Array<{ style: Readonly<Record<string, unknown>> }> = []
  const actions: string[] = []
  const builder: SceneBuilder = {
    rect: (_x, _y, _w, _h, style) => void rects.push({ style }),
    text: (_x, _y, run, style) => void texts.push({ run, style }),
    hitRegion: (_x, _y, _w, _h, action) => void actions.push(action),
  }
  return { builder, texts, rects, actions }
}

const editable: CompactState = { focused: false, connected: false, readonly: false }
const readonly: CompactState = { focused: false, connected: true, readonly: true }

const displayed = (texts: Array<{ run: string; style: Readonly<Record<string, unknown>> }>): string[] =>
  texts.filter((t) => t.style['role'] === 'widgetValue').map((t) => t.run)

describe('compact display through the real registered views', () => {
  const draw = (viewId: string, widgetType: string, value: Json, options: Record<string, unknown> = {}, state: CompactState = editable) => {
    const view = registry.viewsFor(widgetType).find((candidate) => candidate.id === viewId)!
    const rec = recordingBuilder()
    view.drawCompact(rec.builder, value as never, { widgetType, options }, state)
    return rec
  }

  it.each([
    ['core.number', 'INT', 7, {}, '7'],
    ['core.number', 'FLOAT', 1.25, {}, '1.3'],
    ['core.line', 'STRING', 'hello', {}, 'hello'],
    ['core.markdown', 'MARKDOWN', '## Heading\nsecond line', {}, '## Heading'],
    ['core.text', 'STRING', 'first\nsecond', {}, ['first', 'second']],
    ['core.toggle', 'BOOLEAN', true, {}, 'true'],
    ['core.toggle', 'BOOLEAN', true, { labelOn: 'Enabled' }, 'Enabled'],
    ['core.select', 'COMBO', 'euler', { options: ['euler', 'ddim'] }, 'euler'],
    ['core.multiSelect', 'MULTI_COMBO', ['ddim', 'euler', 'ddim'], { options: ['euler', 'ddim'] }, '3 selected'],
    ['core.compositor', 'COMPOSITOR', { version: 2, documentDigest: `blake3:${'a'.repeat(64)}`, commands: [{ op: 'layer' }] }, {}, '1 document edit'],
    ['core.compositor', 'COMPOSITOR', { version: 2, documentDigest: null, commands: [] }, {}, 'Run to load layers'],
    ['core.asset', 'ASSET', asset, {}, 'cat.png'],
    ['core.asset', 'ASSET', null, {}, 'no asset'],
    // Multi-select values (list-of-asset declarations): one name, else a count.
    ['core.asset', 'ASSET', [asset], {}, 'cat.png'],
    ['core.asset', 'ASSET', [asset, { ...asset, name: 'dog.png' }], {}, '2 assets'],
    ['core.asset', 'ASSET', [], {}, 'no asset'],
  ] as const)('%s (%s) displays %j as %j', (viewId, widgetType, value, options, expected) => {
    const rec = draw(viewId, widgetType, value as Json, options as Record<string, unknown>)
    expect(displayed(rec.texts)).toEqual(Array.isArray(expected) ? expected : [expected])
    // An editable row offers exactly the edit action; the display never eats it.
    expect(rec.actions).toEqual(['widget.edit'])
  })

  it('marks only the empty ASSET compact value as a placeholder', () => {
    const empty = draw('core.asset', 'ASSET', null)
    expect(empty.texts.find((text) => text.run === 'no asset')?.style['placeholder']).toBe(true)
    const populated = draw('core.asset', 'ASSET', asset)
    expect(populated.texts.find((text) => text.run === 'cat.png')?.style['placeholder']).toBeUndefined()
    const sameName = draw('core.asset', 'ASSET', { ...asset, name: 'no asset' })
    expect(sameName.texts.find((text) => text.run === 'no asset')?.style['placeholder']).toBeUndefined()
  })

  it('marks an empty multiline STRING display name as a placeholder without changing populated lines', () => {
    const empty = draw('core.text', 'STRING', '', { multiline: true, display_name: 'prompt' })
    expect(displayed(empty.texts)).toEqual(['prompt'])
    expect(empty.texts[0]?.style['placeholder']).toBe(true)

    const populated = draw('core.text', 'STRING', 'prompt', { multiline: true, display_name: 'prompt' })
    expect(displayed(populated.texts)).toEqual(['prompt'])
    expect(populated.texts[0]?.style['placeholder']).toBeUndefined()
  })

  it('COLOR paints a swatch filled with the stored color plus the uppercased text', () => {
    const rec = draw('core.color', 'COLOR', '#12345678')
    expect(displayed(rec.texts)).toEqual(['#12345678'.toUpperCase()])
    expect(rec.rects.some((r) => r.style['fill'] === '#12345678')).toBe(true)
  })

  it.each([
    ['core.number', 'INT', 7, {}],
    ['core.line', 'STRING', 'hello', {}],
    ['core.select', 'COMBO', 'euler', { options: ['euler'] }],
    ['core.color', 'COLOR', '#123456', {}],
    ['core.compositor', 'COMPOSITOR', { version: 2, documentDigest: null, commands: [] }, {}],
    ['core.asset', 'ASSET', asset, {}],
    ['core.audioRecord', 'AUDIO_RECORD', null, {}],
    ['core.toggle', 'BOOLEAN', false, {}],
    ['core.text', 'STRING', 'x', {}],
  ] as const)('%s registers NO hit region when read-only (connected row)', (viewId, widgetType, value, options) => {
    const rec = draw(viewId, widgetType, value as Json, options as Record<string, unknown>, readonly)
    expect(rec.actions).toEqual([])
  })
})
