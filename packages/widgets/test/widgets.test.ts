/**
 * Widget registry + core kinds. Everything goes through the public
 * contract; these tests double as its first consumer alongside the canvas.
 */
import { describe, expect, it } from 'vitest'
import { effectiveWidgetDefault, formatWidgetValue, type PreviewRenderer, type SceneBuilder, type WidgetSpec } from '@dinkster/core'
import {
  createWidgetRegistry,
  formatCompactFloat,
  hexToHsv,
  hsvToHex,
  hsvToRgb,
  numericStepPrecision,
  registerCoreWidgets,
  rgbToHsv,
} from '../src/index.js'

const spec = (widgetType: string, options: Record<string, unknown> = {}, dflt?: unknown): WidgetSpec => ({
  widgetType,
  options,
  ...(dflt !== undefined ? { default: dflt } : {}),
})

function registry() {
  const r = createWidgetRegistry()
  registerCoreWidgets(r)
  return r
}

/** Records emitted primitives for assertion. */
function recordingBuilder() {
  const ops: { op: string; args: unknown[] }[] = []
  const builder: SceneBuilder = {
    rect: (...args) => void ops.push({ op: 'rect', args }),
    text: (...args) => void ops.push({ op: 'text', args }),
    hitRegion: (...args) => void ops.push({ op: 'hitRegion', args }),
  }
  return { ops, builder }
}

describe('color conversion', () => {
  it('round-trips representative RGB colors through HSV', () => {
    for (const rgb of [[0, 0, 0], [255, 255, 255], [255, 0, 0], [17, 34, 51], [12, 200, 91]]) {
      const hsv = rgbToHsv(rgb[0]!, rgb[1]!, rgb[2]!)
      expect(hsvToRgb(hsv.h, hsv.s, hsv.v)).toEqual({ r: rgb[0], g: rgb[1], b: rgb[2] })
    }
  })

  it('syncs supported hex forms and preserves an alpha pair verbatim', () => {
    expect(hexToHsv('#123')).toEqual(rgbToHsv(17, 34, 51))
    const hsv = hexToHsv('#11223344')!
    expect(hsvToHex(hsv.h, 1, 1, '#11223344')).toMatch(/^#[0-9a-f]{6}44$/)
    expect(hsvToHex(hsv.h, hsv.s, hsv.v, '#112233AA')).toBe('#112233AA')
    expect(hexToHsv('#invalid')).toBeUndefined()
  })

  it('FR-7 non-finite and out-of-range components clamp to well-formed colors', () => {
    // Pointer math against a zero-width element yields NaN; the conversions
    // must never mint '#NaNNaNNaN' or negative channels into document state.
    expect(hsvToHex(Number.NaN, Number.NaN, Number.NaN)).toBe('#000000')
    expect(hsvToHex(0, 2, 1)).toBe('#ff0000') // s clamps to 1
    expect(hsvToHex(0, -1, 0.5)).toMatch(/^#[0-9a-f]{6}$/) // s clamps to 0 (grey)
    expect(hsvToRgb(Number.POSITIVE_INFINITY, 1, 1)).toEqual({ r: 255, g: 0, b: 0 }) // hue -> 0
    const hsv = rgbToHsv(Number.NaN, -20, 999)
    expect(hsv.h).toBeGreaterThanOrEqual(0)
    expect(hsv.s).toBeGreaterThanOrEqual(0)
    expect(hsv.s).toBeLessThanOrEqual(1)
    expect(hsv.v).toBeLessThanOrEqual(1)
  })
})

describe('compact FLOAT precision', () => {
  it.each([
    [1, 0, '0.0'],
    [0.1, 0, '0.0'],
    [0.01, 0, '0.00'],
    [1e-5, -1.2, '-1.20000'],
    [2.5e-3, 9007199254740991, '9007199254740991.0000'],
    [1e3, 1e21, '1000000000000000000000.0'],
  ])('formats step %s and value %s as %s without changing the value', (step, value, expected) => {
    const before = value
    expect(formatCompactFloat(value, spec('FLOAT', { step }))).toBe(expected)
    expect(value).toBe(before)
  })

  it('derives decimal precision from ordinary and scientific notation', () => {
    expect(numericStepPrecision(1)).toBe(0)
    expect(numericStepPrecision(0.01)).toBe(2)
    expect(numericStepPrecision(1e-7)).toBe(7)
    expect(numericStepPrecision(2.5e-3)).toBe(4)
    expect(numericStepPrecision(1e3)).toBe(0)
  })

  it('uses one descriptor formatter for editable and display-only numeric states', () => {
    expect(formatWidgetValue(1.3, spec('FLOAT', { step: 0.1 }))).toBe('1.3')
    expect(formatWidgetValue(1.3, spec('FLOAT', { step: 0.01 }))).toBe('1.30')
    expect(formatWidgetValue(8, spec('FLOAT', { step: 0.1 }))).toBe('8.0')
    expect(formatWidgetValue(8.7, spec('INT', { step: 1 }))).toBe('9')
  })

  it('formats COMBO labels without changing canonical stored values', () => {
    const combo = spec('COMBO', {
      options: [{ value: 'dinkster.euler', label: 'euler' }, { value: 'dinkster.karras', label: 'karras' }],
    })
    expect(formatWidgetValue('dinkster.euler', combo)).toBe('euler')
    expect(formatWidgetValue('dinkster.unknown', combo)).toBe('dinkster.unknown')
    expect(formatWidgetValue(['dinkster.euler', 'dinkster.karras'], { ...combo, widgetType: 'MULTI_COMBO' })).toBe('euler, karras')
  })
})

/**
 * Reusable compact-view invariant harness. Add a case to the matrix below
 * for each new compact kind so widths, text zones, and fixed shapes stay
 * covered without widget-specific geometry assertions.
 */
function expectCompactLayout(
  widgetType: string,
  value: Parameters<ReturnType<typeof registry>['viewsFor']>[0] | unknown,
  options: Record<string, unknown> = {},
): void {
  const view = registry().viewsFor(widgetType)[0]!
  for (const width of [80, 120, 240]) {
    const { ops, builder } = recordingBuilder()
    view.drawCompact(builder, value as never, spec(widgetType, { display_name: 'Long widget label', ...options }), {
      focused: false, connected: false, readonly: false,
    })
    const texts = ops.filter((op) => op.op === 'text')
    expect(texts.length, `${widgetType} at ${width}px emits text`).toBeGreaterThan(0)
    for (const text of texts) {
      const style = text.args[3] as { width?: number }
      expect(style.width, `${widgetType} text has an explicit clip zone`).toBeGreaterThan(0)
      expect(Number(style.width) * width, `${widgetType} text zone fits row`).toBeLessThanOrEqual(width)
    }
    for (const rect of ops.filter((op) => op.op === 'rect')) {
      const style = rect.args[4] as { fixedAspect?: string }
      if (style.fixedAspect !== undefined) expect(style.fixedAspect).toBe('square')
    }
  }
}

describe('registry', () => {
  it('CL10 validates numeric, combo, and asset defaults', () => {
    const r = registry()
    expect(r.kind('INT')!.defaultValue(spec('INT', {}, Number.NaN))).toBe(0)
    expect(r.kind('FLOAT')!.defaultValue(spec('FLOAT', {}, Number.POSITIVE_INFINITY))).toBe(0)
    expect(r.kind('COMBO')!.defaultValue(spec('COMBO', { options: [['value', 'Label']] }))).toBe('value')
    expect(r.kind('COMBO')!.defaultValue(spec('COMBO', {
      options: [{ value: 'dinkster.euler', label: 'euler', info: 'Euler sampler', folder: 'Basic' }],
    }))).toBe('dinkster.euler')
    expect(r.kind('COMBO')!.defaultValue(spec('COMBO', { options: [[{}, 'bad'], ['ok', 'Good']] }, {}))).toBe('ok')
    const asset = { digest: `blake3:${'a'.repeat(64)}`, name: 'x', size: -1, mediaType: 'image/png', virtualPath: 'x' }
    expect(r.kind('ASSET')!.valueSchema.validate(asset)).toBe(false)
  })

  it('CL10 COMBO refuses non-JSON numbers as defaults and options', () => {
    const combo = registry().kind('COMBO')!
    expect(combo.valueSchema.validate(Number.NaN)).toBe(false)
    expect(combo.valueSchema.validate(Number.POSITIVE_INFINITY)).toBe(false)
    // A NaN explicit default and a NaN first option both fall through to the
    // first JSON-representable option.
    expect(combo.defaultValue(spec('COMBO', { options: [7, 'ok'] }, Number.NaN))).toBe(7)
    expect(combo.defaultValue(spec('COMBO', { options: [Number.NaN, 'ok'] }))).toBe('ok')
  })

  it('registers every core kind with at least one view each', () => {
    const r = registry()
    for (const type of ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO', 'COLOR', 'ASSET', 'SAVE_TARGET']) {
      expect(r.kind(type), type).toBeDefined()
      expect(r.viewsFor(type).length, type).toBeGreaterThan(0)
    }
  })

  it('rejects duplicate kind and view registration', () => {
    const r = registry()
    expect(() => registerCoreWidgets(r)).toThrow(/already registered/)
  })

  it('registers, resolves, and removes DOM editors by widget type', () => {
    const r = createWidgetRegistry()
    const editor = () => undefined
    const dispose = r.registerEditor('pack.TIMELINE', editor)
    expect(r.editorFor('pack.TIMELINE')).toBe(editor)
    expect(() => r.registerEditor('pack.TIMELINE', () => undefined)).toThrow(/already registered/)
    dispose()
    expect(r.editorFor('pack.TIMELINE')).toBeUndefined()
  })

  it('kind and view disposers permit re-registration and remove views', () => {
    const r = createWidgetRegistry()
    const kind = registry().kind('INT')!
    const view = registry().viewsFor('INT')[0]!
    const disposeKind = r.registerKind(kind)
    const disposeView = r.registerView(view)
    expect(r.kind('INT')).toBe(kind)
    expect(r.viewsFor('INT')).toEqual([view])

    disposeKind()
    disposeView()
    expect(r.kind('INT')).toBeUndefined()
    expect(r.viewsFor('INT')).toEqual([])
    expect(() => r.registerKind(kind)).not.toThrow()
    expect(() => r.registerView(view)).not.toThrow()
  })

  it('a stale kind disposer never removes a NEWER registration of the same type', () => {
    // Dispose-then-re-register is the pack reload story: the old pack's
    // disposer may fire late (async teardown), after the new pack already
    // registered. The identity guard makes that late call a no-op.
    const r = createWidgetRegistry()
    const original = registry().kind('INT')!
    const replacement = { ...original }
    const disposeOriginal = r.registerKind(original)
    disposeOriginal()
    r.registerKind(replacement)
    disposeOriginal() // stale: fires again after the replacement registered
    expect(r.kind('INT')).toBe(replacement)
  })

  it('view disposers remove by identity, leaving sibling views of the same kind intact', () => {
    const r = createWidgetRegistry()
    const base = registry().viewsFor('INT')[0]!
    const alt = { ...base, id: 'pack.alt-number' }
    const disposeBase = r.registerView(base)
    r.registerView(alt)
    disposeBase()
    expect(r.viewsFor('INT')).toEqual([alt])
    // The freed id is registrable again (reload story for views).
    expect(() => r.registerView(base)).not.toThrow()
    expect(r.viewsFor('INT')).toEqual([alt, base])
  })

  it('selects the first matching preview renderer and removes it with its disposer', () => {
    const r = createWidgetRegistry()
    const renderer = (id: string, channel: string): PreviewRenderer => ({
      id,
      mediaKind: channel.startsWith('video/') ? 'video' : 'image',
      canRender: (candidate) => candidate === channel,
      drawCompact: () => {},
    })
    const first = renderer('first', 'image/png')
    const second = renderer('second', 'image/png')
    const disposeFirst = r.registerPreviewRenderer(first)
    r.registerPreviewRenderer(second)
    expect(r.previewRendererFor('image/png')).toBe(first)
    expect(r.previewRendererFor('video/mp4')).toBeUndefined()
    disposeFirst()
    expect(r.previewRendererFor('image/png')).toBe(second)
  })

  it('registers consumed core image, video, and model3d preview renderers by MIME channel', () => {
    const r = registry()
    expect(r.previewRendererFor('image/png')?.mediaKind).toBe('image')
    expect(r.previewRendererFor('video/webm')?.mediaKind).toBe('video')
    expect(r.previewRendererFor('model/gltf-binary')?.mediaKind).toBe('model3d')
    expect(r.previewRendererFor('model/gltf-binary')?.id).toBe('core.model3d-preview')
    expect(r.previewRendererFor('audio/wav')).toBeUndefined()
    expect(r.previewRendererFor('application/json')).toBeUndefined()
  })

  it('prefers the first normal renderer over broad fallbacks and restores the fallback on disposal', () => {
    const r = registry()
    const exact: PreviewRenderer = {
      id: 'pack.exact-webm',
      mediaKind: 'video',
      canRender: (channel) => channel === 'video/webm',
      drawCompact: () => {},
    }
    const second: PreviewRenderer = {
      id: 'pack.second-webm',
      canRender: exact.canRender,
      drawCompact: () => {},
    }
    const disposeExact = r.registerPreviewRenderer(exact)
    const disposeSecond = r.registerPreviewRenderer(second)

    expect(r.previewRendererFor('video/mp4')?.id).toBe('core.video-preview')
    expect(r.previewRendererFor('video/webm')).toBe(exact)
    disposeExact()
    expect(r.previewRendererFor('video/webm')).toBe(second)
    disposeSecond()
    expect(r.previewRendererFor('video/webm')?.id).toBe('core.video-preview')
  })

  it('every kind default view resolves to a registered compatible view', () => {
    const r = registry()
    const specs: Record<string, WidgetSpec> = {
      INT: spec('INT', { min: 0 }),
      FLOAT: spec('FLOAT'),
      STRING: spec('STRING', { multiline: true }),
      BOOLEAN: spec('BOOLEAN'),
      COMBO: spec('COMBO', { options: ['a', 'b'] }),
      COLOR: spec('COLOR'),
      ASSET: spec('ASSET', { accept: ['image/png'] }),
    }
    for (const [type, s] of Object.entries(specs)) {
      const kind = r.kind(type)!
      const viewId = kind.defaultView(s)
      const view = r.viewsFor(type).find((v) => v.id === viewId)
      expect(view, `${type} -> ${viewId}`).toBeDefined()
      expect(view!.isCompatible(s)).toBe(true)
    }
  })
})

describe('kind semantics', () => {
  it('defaults come from spec.default, then options, then kind fallback', () => {
    const r = registry()
    expect(r.kind('INT')!.defaultValue(spec('INT', { min: 5 }))).toBe(5)
    expect(r.kind('INT')!.defaultValue(spec('INT', { min: 5 }, 20))).toBe(20)
    expect(r.kind('STRING')!.defaultValue(spec('STRING'))).toBe('')
    expect(r.kind('COMBO')!.defaultValue(spec('COMBO', { options: ['euler', 'ddim'] }))).toBe('euler')
    expect(r.kind('BOOLEAN')!.defaultValue(spec('BOOLEAN', {}, true))).toBe(true)
  })

  it('INT validates range and integrality as warnings', () => {
    const kind = registry().kind('INT')!
    expect(kind.validate(3, spec('INT', { min: 0, max: 10 }))).toEqual([])
    expect(kind.validate(11, spec('INT', { min: 0, max: 10 }))).toHaveLength(1)
    expect(kind.validate(1.5, spec('INT', {}))).toHaveLength(1)
    expect(kind.valueSchema.validate(Number.MAX_SAFE_INTEGER + 1)).toBe(false)
    expect(kind.valueSchema.validate('9007199254740992')).toBe(true)
  })

  it('INT returns an out-of-range default unchanged', () => {
    const kind = registry().kind('INT')!
    // documents current behavior: no clamping - see feature-coverage-audit
    expect(kind.defaultValue(spec('INT', { min: 0, max: 10 }, 20))).toBe(20)
  })

  it('FLOAT validates finite numbers, defaults, and range diagnostics', () => {
    const kind = registry().kind('FLOAT')!
    expect(kind.valueSchema.validate(1.25)).toBe(true)
    expect(kind.valueSchema.validate('1.25')).toBe(false)
    expect(kind.valueSchema.validate(Number.POSITIVE_INFINITY)).toBe(false)
    expect(kind.defaultValue(spec('FLOAT', { min: 0.5 }))).toBe(0.5)
    expect(kind.defaultValue(spec('FLOAT', { min: 0.5 }, 2.25))).toBe(2.25)
    expect(kind.validate(-1, spec('FLOAT', { min: 0, max: 10 }))[0]?.code).toBe('widget.FLOAT.belowMin')
    expect(kind.validate(11, spec('FLOAT', { min: 0, max: 10 }))[0]?.code).toBe('widget.FLOAT.aboveMax')
  })

  it('STRING validates values and handles defaults for both views', () => {
    const kind = registry().kind('STRING')!
    expect(kind.valueSchema.validate('')).toBe(true)
    expect(kind.valueSchema.validate('a\nb')).toBe(true)
    expect(kind.valueSchema.validate(1)).toBe(false)
    expect(kind.defaultValue(spec('STRING'))).toBe('')
    expect(kind.defaultValue(spec('STRING', {}, 'hello'))).toBe('hello')
    expect(kind.defaultView(spec('STRING'))).toBe('core.line')
  })

  it('BOOLEAN has strict validation and false or explicit defaults', () => {
    const kind = registry().kind('BOOLEAN')!
    expect(kind.valueSchema.validate(true)).toBe(true)
    expect(kind.valueSchema.validate(false)).toBe(true)
    expect(kind.valueSchema.validate(1)).toBe(false)
    expect(kind.valueSchema.validate('true')).toBe(false)
    expect(kind.defaultValue(spec('BOOLEAN'))).toBe(false)
    expect(kind.defaultValue(spec('BOOLEAN', {}, true))).toBe(true)
  })

  it('COMBO validates against static options but not remote sources', () => {
    const kind = registry().kind('COMBO')!
    expect(kind.validate('euler', spec('COMBO', { options: ['euler'] }))).toEqual([])
    expect(kind.validate('nope', spec('COMBO', { options: ['euler'] }))).toHaveLength(1)
    const remote: WidgetSpec = { widgetType: 'COMBO', options: {}, remote: { route: '/models' } }
    expect(kind.validate('anything', remote)).toEqual([])
  })

  it('COMBO validates numeric and tuple-like options and reports unknown values', () => {
    const kind = registry().kind('COMBO')!
    const comboSpec = spec('COMBO', {
      options: [1, 2, ['stored', 'Display label'], { value: 'dinkster.euler', label: 'euler' }],
    })
    expect(kind.validate(2, comboSpec)).toEqual([])
    expect(kind.validate('stored', comboSpec)).toEqual([])
    expect(kind.validate('dinkster.euler', comboSpec)).toEqual([])
    expect(kind.validate('euler', comboSpec)[0]?.code).toBe('widget.COMBO.unknownOption')
    expect(kind.validate('Display label', comboSpec)[0]?.code).toBe('widget.COMBO.unknownOption')
    expect(kind.validate(3, comboSpec)[0]?.message).toContain('not in the option list')
  })

  it('COMBO handles empty and remote option sources', () => {
    const kind = registry().kind('COMBO')!
    const empty = spec('COMBO', { options: [] })
    expect(kind.defaultValue(empty)).toBe('')
    expect(kind.validate('', empty)[0]?.code).toBe('widget.COMBO.unknownOption')
    const remote = {
      route: '/models', refreshButton: true, controlAfterRefresh: 'first' as const, timeoutMs: 500,
      maxRetries: 2, refreshMs: 1_000,
    }
    const remoteSpec: WidgetSpec = { widgetType: 'COMBO', options: {}, remote }
    expect(kind.defaultValue({ ...remoteSpec, default: 'kept' })).toBe('kept')
    expect(kind.validate('kept', remoteSpec)).toEqual([])
    expect(remoteSpec.remote).toBe(remote)
  })

  it('COLOR preserves and accepts every string without color validation', () => {
    const kind = registry().kind('COLOR')!
    for (const value of ['#fff', '#ABC', '#00ff33', '#AABBCC', '#11223344', '#aBcDeF80', 'red', '', 'Not-A-Normalized-Color']) {
      expect(kind.valueSchema.validate(value), value).toBe(true)
      expect(kind.validate(value, spec('COLOR')), value).toEqual([])
    }
    expect(kind.valueSchema.validate(123)).toBe(false)
    expect(kind.defaultValue(spec('COLOR'))).toBe('#ffffff')
    expect(kind.defaultValue(spec('COLOR', {}, '#00ff3380'))).toBe('#00ff3380')
    expect(kind.defaultValue(spec('COLOR', {}, 'Not-A-Normalized-Color'))).toBe('Not-A-Normalized-Color')
    expect(kind.defaultView(spec('COLOR'))).toBe('core.color')
  })

  it('ASSET validates references and uses null for absent or invalid defaults', () => {
    const kind = registry().kind('ASSET')!
    const asset = {
      digest: `blake3:${'a'.repeat(64)}`,
      name: 'cat.png', size: 42, mediaType: 'image/png', virtualPath: 'input/cat.png',
    }
    expect(kind.valueSchema.validate(asset)).toBe(true)
    expect(kind.valueSchema.validate({ ...asset, digest: undefined })).toBe(false)
    expect(kind.valueSchema.validate({ ...asset, digest: 'sha256:bad' })).toBe(false)
    expect(kind.valueSchema.validate('cat.png')).toBe(false)
    expect(kind.valueSchema.validate(null)).toBe(true)
    expect(kind.defaultValue(spec('ASSET'))).toBeNull()
    expect(kind.defaultValue(spec('ASSET', {}, asset))).toEqual(asset)
    expect(kind.defaultValue(spec('ASSET', {}, { ...asset, size: Infinity }))).toBeNull()
    expect(kind.defaultView(spec('ASSET'))).toBe('core.asset')
  })

  it('ASSET accepts AssetRef arrays (multi-select on list-of-asset declarations)', () => {
    const kind = registry().kind('ASSET')!
    const asset = {
      digest: `blake3:${'a'.repeat(64)}`,
      name: 'cat.png', size: 42, mediaType: 'image/png', virtualPath: 'input/cat.png',
    }
    // The value schema is SHAPE only, deliberately declaration-agnostic: an
    // array under a scalar declaration still LOADS - cardinality mismatch is
    // the backend's structural refusal at submit, never a vanishing value.
    expect(kind.valueSchema.validate([asset])).toBe(true)
    expect(kind.valueSchema.validate([asset, { ...asset, digest: `blake3:${'b'.repeat(64)}` }])).toBe(true)
    expect(kind.valueSchema.validate([])).toBe(true)
    expect(kind.valueSchema.validate([asset, 'cat.png'])).toBe(false)
    expect(kind.valueSchema.validate([asset, null])).toBe(false)
    expect(kind.valueSchema.validate([{ ...asset, digest: 'sha256:bad' }])).toBe(false)
    // An array default is as legal as a scalar one (same shape rule as the
    // value schema); a malformed member falls back to null like any other
    // unusable default.
    expect(kind.defaultValue(spec('ASSET', {}, [asset]))).toEqual([asset])
    expect(kind.defaultValue(spec('ASSET', {}, [asset, 'cat.png']))).toBeNull()
  })

  it('SAVE_TARGET stores {mount, prefix} pairs or null; grammar violations warn instead of vanishing', () => {
    const kind = registry().kind('SAVE_TARGET')!
    const target = { mount: 'comfy-output', prefix: 'ComfyUI' }
    // Value schema is SHAPE only (string pair or null): documents authored
    // against other mount sets still load; grammar surfaces via validate().
    expect(kind.valueSchema.validate(target)).toBe(true)
    expect(kind.valueSchema.validate(null)).toBe(true)
    expect(kind.valueSchema.validate('output/ComfyUI')).toBe(false)
    expect(kind.valueSchema.validate({ mount: 'renders' })).toBe(false)
    expect(kind.valueSchema.validate({ mount: 7, prefix: 'x' })).toBe(false)
    expect(kind.validate(target, spec('SAVE_TARGET'))).toEqual([])
    expect(kind.validate(null, spec('SAVE_TARGET'))).toEqual([])
    expect(kind.validate({ mount: 'renders', prefix: 'a/b/stem' }, spec('SAVE_TARGET'))).toEqual([])
    const invalidPrefixes = [
      '/abs/path',      // absolute
      'a\\b',           // backslash separator
      'a//b',           // empty segment
      'a/./b',          // '.' segment
      'a/../b',         // traversal
      'trailing/',      // trailing slash = empty last segment
      '',               // empty
    ]
    for (const prefix of invalidPrefixes) {
      const diags = kind.validate({ mount: 'renders', prefix }, spec('SAVE_TARGET'))
      expect(diags.length, `prefix '${prefix}'`).toBeGreaterThan(0)
      expect(diags[0]!.code, `prefix '${prefix}'`).toBe('widget.SAVE_TARGET.invalid')
    }
    for (const mount of ['Renders', 'comfy output', '-renders', 'renders-', 'a.b', '']) {
      expect(kind.validate({ mount, prefix: 'ok' }, spec('SAVE_TARGET')).length, `mount '${mount}'`).toBeGreaterThan(0)
    }
    // Defaults: grammar-valid default is kept, anything else is null (unset).
    expect(kind.defaultValue(spec('SAVE_TARGET'))).toBeNull()
    expect(kind.defaultValue(spec('SAVE_TARGET', {}, target))).toEqual(target)
    expect(kind.defaultValue(spec('SAVE_TARGET', {}, { mount: 'x', prefix: '../up' }))).toBeNull()
    expect(kind.defaultValue(spec('SAVE_TARGET', {}, 'output/raw'))).toBeNull()
    expect(kind.defaultView(spec('SAVE_TARGET'))).toBe('core.saveTarget')
  })

  it('STRING default view follows the multiline hint', () => {
    const kind = registry().kind('STRING')!
    expect(kind.defaultView(spec('STRING'))).toBe('core.line')
    expect(kind.defaultView(spec('STRING', { multiline: true }))).toBe('core.text')
  })
})

describe('display/submission default agreement', () => {
  // Compile stages core's effectiveWidgetDefault when a widget input has no
  // stored value and no schema default: what the canvas SHOWS must be what
  // executes. This pins the agreement kind by kind so the two default
  // tables (display in kinds.ts, submission in core widget-defaults.ts)
  // cannot silently diverge.
  it('display defaults equal submission defaults for kinds with an intrinsic value', () => {
    const r = registry()
    for (const s of [
      spec('INT'),
      spec('INT', { min: 5 }),
      spec('FLOAT'),
      spec('FLOAT', { min: -1.5 }),
      spec('STRING'),
      spec('BOOLEAN'),
      spec('COLOR'),
      spec('CURVE'),
      spec('COMPOSITOR'),
      spec('COMBO', { options: ['a', 'b'] }),
      spec('COMBO', { options: [['v1', 'Label'], 'v2'] }),
      spec('INT', {}, 17),
      spec('STRING', {}, 'x'),
      spec('BOOLEAN', {}, true),
    ]) {
      expect(effectiveWidgetDefault(s), `${s.widgetType} ${JSON.stringify(s.options)}`)
        .toEqual(r.kind(s.widgetType)!.defaultValue(s))
    }
  })

  it('kinds whose display default is a placeholder have NO submission default', () => {
    // ASSET/SAVE_TARGET display null ("explicitly unset") and an empty/remote
    // COMBO displays '' - placeholders a user can see through, not values a
    // prompt may execute with. Submission keeps the missing-input warning.
    expect(effectiveWidgetDefault(spec('ASSET'))).toBeUndefined()
    expect(effectiveWidgetDefault(spec('SAVE_TARGET'))).toBeUndefined()
    expect(effectiveWidgetDefault(spec('COMBO'))).toBeUndefined()
    expect(effectiveWidgetDefault(spec('COMBO', { options: [] }))).toBeUndefined()
  })
})

describe('VIDEO_EDIT', () => {
  it('accepts empty, partial, sentinel, and imported values without dropping unknown fields', () => {
    const kind = registry().kind('VIDEO_EDIT')!
    const widget = spec('VIDEO_EDIT', { features: ['trim', 'crop'] })
    for (const value of [
      {},
      { trim: {} },
      { trim: { start_time: 1.25, duration: 0 } },
      { crop: { x: 100, y: 40, width: 0, height: -1 } },
      { imported: { future: true }, trim: { vendor_field: 'keep' } },
    ]) {
      expect(kind.valueSchema.validate(value), JSON.stringify(value)).toBe(true)
      expect(kind.validate(value, widget), JSON.stringify(value)).toEqual([])
    }
    expect(kind.valueSchema.validate([])).toBe(false)
    expect(kind.validate({ trim: { duration: Number.NaN } }, widget)[0]!.code).toBe('widget.VIDEO_EDIT.invalidTrim')
    expect(kind.validate({ crop: { x: 1.5 } }, widget)[0]!.code).toBe('widget.VIDEO_EDIT.invalidCrop')
  })
})

describe('compact views', () => {
  it('all representative compact views satisfy shared layout invariants across widths', () => {
    const long = 'a value long enough to require measured truncation'
    expectCompactLayout('INT', 123456789)
    expectCompactLayout('FLOAT', 12345.6789)
    expectCompactLayout('STRING', `${long}\nsecond line`, { multiline: true })
    expectCompactLayout('COMBO', long, { options: [long] })
    expectCompactLayout('COLOR', '#11223344')
    expectCompactLayout('COMPOSITOR', { version: 2, documentDigest: null, commands: [] })
  })

  it('drawCompact emits primitives and a hit region when editable', () => {
    const r = registry()
    const view = r.viewsFor('INT').find((v) => v.id === 'core.number')!
    const { ops, builder } = recordingBuilder()
    view.drawCompact(builder, 42, spec('INT'), { focused: false, connected: false, readonly: false })
    expect(ops.some((o) => o.op === 'text' && (o.args[2] as string) === '42')).toBe(true)
    expect(ops.some((o) => o.op === 'hitRegion')).toBe(true)
  })

  it('readonly rows emit no hit region', () => {
    const r = registry()
    const view = r.viewsFor('BOOLEAN').find((v) => v.id === 'core.toggle')!
    const { ops, builder } = recordingBuilder()
    view.drawCompact(builder, true, spec('BOOLEAN'), { focused: false, connected: false, readonly: true })
    expect(ops.some((o) => o.op === 'hitRegion')).toBe(false)
  })

  it('editable BOOLEAN rows emit a hit region', () => {
    const view = registry().viewsFor('BOOLEAN').find((v) => v.id === 'core.toggle')!
    const { ops, builder } = recordingBuilder()
    view.drawCompact(builder, false, spec('BOOLEAN'), { focused: false, connected: false, readonly: false })
    expect(ops.some((o) => o.op === 'hitRegion')).toBe(true)
  })

  it('FLOAT compact rows have INT measure and hit-region parity', () => {
    const r = registry()
    const intView = r.viewsFor('INT')[0]!
    const floatView = r.viewsFor('FLOAT')[0]!
    expect(floatView.measure(spec('FLOAT', { step: 0.25 }))).toEqual(intView.measure(spec('INT')))
    const { ops, builder } = recordingBuilder()
    floatView.drawCompact(builder, 1.25, spec('FLOAT', { step: 0.25 }), {
      focused: false, connected: false, readonly: false,
    })
    expect(ops.some((o) => o.op === 'text' && o.args[2] === '1.25')).toBe(true)
    expect(ops.some((o) => o.op === 'hitRegion')).toBe(true)
  })

  it('single-line STRING remains one row and passes truncation state through', () => {
    const view = registry().viewsFor('STRING').find((v) => v.id === 'core.line')!
    expect(view.measure(spec('STRING'))).toEqual({ rows: 1 })
    const { ops, builder } = recordingBuilder()
    view.drawCompact(builder, 'a very long string', spec('STRING'), {
      focused: false, connected: false, readonly: false, truncated: true,
    })
    const text = ops.find((o) => o.op === 'text' && o.args[2] === 'a very long string')!
    expect((text.args[3] as { truncated: boolean }).truncated).toBe(true)
  })

  it('STRING placeholders paint only empty values and preserve explicit empty versus absence', () => {
    const line = registry().viewsFor('STRING').find((v) => v.id === 'core.line')!
    const declared = recordingBuilder()
    line.drawCompact(declared.builder, '', spec('STRING', { placeholder: 'Describe a scene' }), {
      focused: false, connected: false, readonly: false,
    })
    expect(declared.ops).toContainEqual(expect.objectContaining({
      op: 'text', args: expect.arrayContaining(['Describe a scene', expect.objectContaining({ placeholder: true })]),
    }))
    const explicitEmpty = recordingBuilder()
    line.drawCompact(explicitEmpty.builder, '', spec('STRING', { placeholder: '' }), {
      focused: false, connected: false, readonly: false,
    })
    expect(explicitEmpty.ops.find((op) => op.op === 'text')?.args[3]).toMatchObject({ placeholder: true })
    const absent = recordingBuilder()
    line.drawCompact(absent.builder, '', spec('STRING'), {
      focused: false, connected: false, readonly: false,
    })
    expect(absent.ops.find((op) => op.op === 'text')?.args[3]).not.toHaveProperty('placeholder')
    const populated = recordingBuilder()
    line.drawCompact(populated.builder, 'literal', spec('STRING', { placeholder: 'ignored' }), {
      focused: false, connected: false, readonly: false,
    })
    expect(populated.ops.find((op) => op.op === 'text')?.args[2]).toBe('literal')
  })

  it('SAVE_TARGET compact row shows mount:prefix plus display suffix; the suffix never joins the value', () => {
    const r = registry()
    const view = r.viewsFor('SAVE_TARGET').find((v) => v.id === 'core.saveTarget')!
    const withValue = recordingBuilder()
    view.drawCompact(withValue.builder, { mount: 'renders', prefix: 'project/stem' }, spec('SAVE_TARGET', { suffix: '.png' }), {
      focused: false, connected: false, readonly: false,
    })
    const valueText = withValue.ops.filter((o) => o.op === 'text').map((o) => o.args[2])
    expect(valueText).toContain('renders:project/stem.png')
    expect(withValue.ops.some((o) => o.op === 'hitRegion')).toBe(true)
    // Null = unset optional target: the schema default applies server-side.
    const empty = recordingBuilder()
    view.drawCompact(empty.builder, null, spec('SAVE_TARGET', { suffix: '.png' }), {
      focused: false, connected: false, readonly: false,
    })
    expect(empty.ops.filter((o) => o.op === 'text').map((o) => o.args[2])).toContain('default target')
  })

  it('COLOR compact row paints a swatch and exact stored text', () => {
    const view = registry().viewsFor('COLOR').find((candidate) => candidate.id === 'core.color')!
    const { ops, builder } = recordingBuilder()
    view.drawCompact(builder, '#00ff3380', spec('COLOR'), {
      focused: false, connected: false, readonly: false,
    })
    expect(ops.some((op) => op.op === 'rect' && (op.args[4] as { fill?: string }).fill === '#00ff3380')).toBe(true)
    expect(ops.some((op) => op.op === 'text' && op.args[2] === '#00ff3380')).toBe(true)
    expect(ops.some((op) => op.op === 'hitRegion')).toBe(true)
  })

  it('multiline preview measures two rows and emits every canonical line', () => {
    const r = registry()
    const view = r.viewsFor('STRING').find((v) => v.id === 'core.text')!
    expect(view.measure(spec('STRING', { multiline: true }))).toEqual({ rows: 2 })
    const { ops, builder } = recordingBuilder()
    view.drawCompact(builder, 'a\nb\nc\nd', spec('STRING', { multiline: true }), {
      focused: false,
      connected: false,
      readonly: false,
    })
    const values = ops.filter((o) => o.op === 'text').map((o) => o.args[2])
    expect(values).toEqual(['a', 'b', 'c', 'd'])
    expect(ops.filter((o) => o.op === 'text').map((o) => o.args[1])).toEqual([0, 1, 2, 3])
  })

  it('multiline preview emits its display name as presentation-only placeholder for an empty value', () => {
    const view = registry().viewsFor('STRING').find((v) => v.id === 'core.text')!
    const { ops, builder } = recordingBuilder()
    view.drawCompact(builder, '', spec('STRING', { multiline: true, display_name: 'prompt' }), {
      focused: false,
      connected: false,
      readonly: false,
    })
    expect(ops.filter((o) => o.op === 'text')).toEqual([
      expect.objectContaining({
        args: [0, 0, 'prompt', expect.objectContaining({ role: 'widgetValue', placeholder: true })],
      }),
    ])
  })

  it('BOOLEAN toggle renders labelOn/labelOff when present, true/false otherwise (wire v10)', () => {
    const view = registry().viewsFor('BOOLEAN').find((v) => v.id === 'core.toggle')!
    const draw = (value: boolean, options: Record<string, unknown>): unknown[] => {
      const { ops, builder } = recordingBuilder()
      view.drawCompact(builder, value, spec('BOOLEAN', options), { focused: false, connected: false, readonly: false })
      return ops.filter((o) => o.op === 'text').map((o) => o.args[2])
    }
    expect(draw(true, { labelOn: 'enable', labelOff: 'disable' })).toContain('enable')
    expect(draw(false, { labelOn: 'enable', labelOff: 'disable' })).toContain('disable')
    expect(draw(true, {})).toContain('true')
    expect(draw(false, { labelOn: 'enable' })).toContain('false') // one-sided label falls back per side
  })

  it.each([true, false])('BOOLEAN toggle emits its %s state as a compact affordance', (value) => {
    const view = registry().viewsFor('BOOLEAN').find((candidate) => candidate.id === 'core.toggle')!
    const { ops, builder } = recordingBuilder()
    view.drawCompact(builder, value, spec('BOOLEAN'), {
      focused: false, connected: false, readonly: false,
    })
    expect(ops).toContainEqual(expect.objectContaining({
      op: 'rect',
      args: expect.arrayContaining([expect.objectContaining({ role: 'toggleAffordance', checked: value })]),
    }))
  })

  it('COMBO emits a dropdown chevron affordance', () => {
    const view = registry().viewsFor('COMBO').find((candidate) => candidate.id === 'core.select')!
    const { ops, builder } = recordingBuilder()
    view.drawCompact(builder, 'euler', spec('COMBO', { options: ['euler', 'ddim'] }), {
      focused: false, connected: false, readonly: false,
    })
    expect(ops).toContainEqual(expect.objectContaining({
      op: 'rect',
      args: expect.arrayContaining([expect.objectContaining({ role: 'comboChevron' })]),
    }))
    const value = ops.find((op) => op.op === 'text' && op.args[2] === 'euler')
    expect(value?.args[3]).not.toHaveProperty('reserveRight')
  })

  it.each([
    [{ display: 'slider', min: 0, max: 10 }, 5, 0.5],
    [{ display: 'slider', min: 0, max: 10 }, -5, 0],
    [{ display: 'slider', min: 0, max: 10 }, 15, 1],
    [{ display: 'slider', max: 10 }, 5, undefined],
    [{ display: 'slider', min: 0 }, 5, undefined],
    [{ display: 'slider', min: 5, max: 5 }, 5, undefined],
    [{ display: 'slider', min: 10, max: 0 }, 5, undefined],
    [{ display: 'slider', min: 0, max: Number.POSITIVE_INFINITY }, 5, undefined],
    [{ display: 'slider', min: -Number.MAX_VALUE, max: Number.MAX_VALUE }, 0, 0.5],
    [{ min: 0, max: 10 }, 5, undefined],
    [{ display: 'number', min: 0, max: 10 }, 5, undefined],
    [{ display: 'knob', min: 0, max: 10 }, 5, undefined],
    [{ display: 'gradientslider', min: 0, max: 10 }, 5, undefined],
  ] as const)('numeric compact range affordance for options %j and value %s is %s', (options, value, fraction) => {
    const view = registry().viewsFor('INT').find((candidate) => candidate.id === 'core.number')!
    const { ops, builder } = recordingBuilder()
    view.drawCompact(builder, value, spec('INT', options), {
      focused: false, connected: false, readonly: false,
    })
    const fill = ops.find((op) => op.op === 'rect'
      && (op.args[4] as { role?: string }).role === 'numericRangeFill')
    if (fraction === undefined) expect(fill).toBeUndefined()
    else expect(fill?.args[4]).toMatchObject({ role: 'numericRangeFill', fraction })
  })

  it('omits the numeric range affordance for a non-finite value', () => {
    const view = registry().viewsFor('FLOAT').find((candidate) => candidate.id === 'core.number')!
    const { ops, builder } = recordingBuilder()
    view.drawCompact(builder, Number.NaN, spec('FLOAT', { display: 'slider', min: 0, max: 1 }), {
      focused: false, connected: false, readonly: false,
    })
    expect(ops.some((op) => op.op === 'rect'
      && (op.args[4] as { role?: string }).role === 'numericRangeFill')).toBe(false)
  })

  it('FLOAT emits the same bounded range affordance without changing its formatted value', () => {
    const view = registry().viewsFor('FLOAT').find((candidate) => candidate.id === 'core.number')!
    const { ops, builder } = recordingBuilder()
    view.drawCompact(builder, 0.25, spec('FLOAT', { display: 'slider', min: 0, max: 1, step: 0.01 }), {
      focused: false, connected: false, readonly: false,
    })
    expect(ops.find((op) => op.op === 'rect'
      && (op.args[4] as { role?: string }).role === 'numericRangeFill')?.args[4])
      .toMatchObject({ fraction: 0.25 })
    expect(ops.some((op) => op.op === 'text' && op.args[2] === '0.25')).toBe(true)
  })

  it.each([
    ['', ['']],
    ['a\n', ['a', '']],
    ['\na', ['', 'a']],
    ['a\n\nc', ['a', '', 'c']],
  ] as const)('multiline preview preserves empty and trailing lines %#', (value, expected) => {
    const view = registry().viewsFor('STRING').find((v) => v.id === 'core.text')!
    const { ops, builder } = recordingBuilder()
    view.drawCompact(builder, value, spec('STRING', { multiline: true }), {
      focused: false, connected: false, readonly: false,
    })
    const texts = ops.filter((o) => o.op === 'text')
    expect(texts.map((o) => o.args[2])).toEqual(expected)
  })
})
