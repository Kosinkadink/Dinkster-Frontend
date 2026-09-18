/**
 * Companion (propagated) value painting: when a widget row carries a
 * companion, BOTH painters render the companion text in the shared
 * read-only style (companion color, italic, right-aligned) instead of the
 * stored value, and the registry painter never consults the kind view -
 * companion display is one style for every widget kind by contract.
 */
import type { WidgetKind, WidgetRegistry, WidgetView } from '@dinkster/core'
import { describe, expect, it } from 'vitest'
import { controllerChipTextRight } from '../src/controller-chip.js'
import { createRegistryPainter } from '../src/registry-painter.js'
import { defaultWidgetPainter, type WidgetPaintArgs } from '../src/renderer.js'
import { defaultTokens } from '../src/tokens.js'
import type { LayoutRow } from '../src/layout.js'

interface TextCall {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly fill: string
  readonly font: string
  readonly alpha: number
}

/** Minimal Canvas2D stand-in recording fillText calls with active style. */
function fakeCtx(widthOf: (text: string, font: string) => number = (text) => text.length * 6) {
  const calls: TextCall[] = []
  const measured: string[] = []
  const measuredFonts: Array<{ text: string; font: string }> = []
  const strikes: Array<{ from: [number, number]; to: [number, number]; color: string; width: number; dash: number[] }> = []
  const stateStack: Array<{ strokeStyle: string; lineWidth: number; dash: number[] }> = []
  let lineStart: [number, number] = [0, 0]
  let lineEnd: [number, number] = [0, 0]
  let lineDash: number[] = []
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '12px system-ui',
    globalAlpha: 1,
    textAlign: 'left',
    beginPath: () => {},
    save: () => stateStack.push({ strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth, dash: lineDash }),
    restore: () => {
      const saved = stateStack.pop()
      if (saved !== undefined) {
        ctx.strokeStyle = saved.strokeStyle
        ctx.lineWidth = saved.lineWidth
        lineDash = saved.dash
      }
    },
    setLineDash: (dash: number[]) => { lineDash = [...dash] },
    rect: () => {},
    clip: () => {},
    roundRect: () => {},
    fill: () => {},
    fillRect: () => {},
    moveTo: (x: number, y: number) => { lineStart = [x, y] },
    lineTo: (x: number, y: number) => { lineEnd = [x, y] },
    stroke: () => strikes.push({ from: lineStart, to: lineEnd, color: String(ctx.strokeStyle), width: ctx.lineWidth, dash: lineDash }),
    measureText: (t: string) => {
      measured.push(t)
      measuredFonts.push({ text: t, font: ctx.font })
      return { width: widthOf(t, ctx.font) }
    },
    fillText: (text: string, x: number, y: number) => {
      calls.push({ text, x, y, fill: String(ctx.fillStyle), font: ctx.font, alpha: ctx.globalAlpha })
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, strikes, measured, measuredFonts }
}

const row: Extract<LayoutRow, { kind: 'widget' }> = {
  kind: 'widget',
  y: 0,
  height: 24,
  inset: 9.5,
  inputId: 'steps',
  valueKey: 'steps',
  address: { port: 'steps' },
  label: 'steps',
  type: { kind: 'concrete', name: 'INT' },
  viewId: 'core.number',
  rows: 1,
  spec: { widgetType: 'INT', options: {}, default: 20 },
}

const floatRow: Extract<LayoutRow, { kind: 'widget' }> = {
  ...row,
  inputId: 'cfg',
  valueKey: 'cfg',
  label: 'configuration strength',
  type: { kind: 'concrete', name: 'FLOAT' },
  spec: { widgetType: 'FLOAT', options: { step: 0.01 }, default: 1.3 },
}

const argsWith = (
  ctx: CanvasRenderingContext2D,
  extra?: Partial<WidgetPaintArgs>,
): WidgetPaintArgs => ({
  ctx,
  row,
  value: 20,
  x: 0,
  y: 0,
  width: 200,
  rowHeight: 24,
  connected: false,
  tokens: defaultTokens,
  ...extra,
})

// Minimal registry stub: canvas deliberately does not depend on
// @dinkster/widgets, so the test supplies its own kind + view. The view draws
// the stored value ('20') so the tests can assert it is bypassed for
// companions and consulted otherwise.
const stubKind: WidgetKind = {
  type: 'INT',
  valueSchema: { version: 1, validate: (v): v is number => typeof v === 'number' },
  defaultValue: () => 0,
  validate: () => [],
  defaultView: () => 'core.number',
}
const stubView: WidgetView = {
  id: 'core.number',
  kind: 'INT',
  isCompatible: () => true,
  measure: () => ({ rows: 1 }),
  drawCompact: (scene, value) => {
    scene.text(0, 0, 'stored', { role: 'widgetLabel', width: 0.42 })
    scene.rect(0.43, 0, 0.1, 1, { role: 'swatch' })
    scene.text(1, 0, String(value), { role: 'widgetValue', align: 'right', width: 0.58 })
  },
}
const registry: WidgetRegistry = {
  registerKind: () => () => {},
  registerView: () => () => {},
  registerPreviewRenderer: () => () => {},
  kind: (type) => (type === stubKind.type ? stubKind : undefined),
  viewsFor: (kindType) => (kindType === stubKind.type ? [stubView] : []),
  previewRendererFor: () => undefined,
}

describe('companion value painting', () => {
  it('default painter without companion draws the stored value normally', () => {
    const { ctx, calls, strikes } = fakeCtx()
    defaultWidgetPainter(argsWith(ctx))
    const value = calls.find((c) => c.text === '20')!
    expect(value.fill).toBe(defaultTokens.colors.value)
    expect(value.font).not.toContain('italic')
    expect(strikes).toEqual([])
  })

  it('default painter preserves a short value before the label', () => {
    const { ctx, calls } = fakeCtx()
    defaultWidgetPainter({
      ...argsWith(ctx, { width: 121, value: 'no asset' }),
      row: { ...row, label: 'checkpoint model name', spec: { widgetType: 'STRING', options: {} } },
    })
    expect(calls.some((call) => call.text === 'no asset')).toBe(true)
    expect(calls.find((call) => call.text.endsWith('...'))?.text).toMatch(/^che/)
  })

  it('default painter strikes the measured stored value when connected without a companion', () => {
    const { ctx, strikes } = fakeCtx()
    ctx.strokeStyle = '#123456'
    ctx.lineWidth = 4
    defaultWidgetPainter(argsWith(ctx, { connected: true }))
    expect(strikes).toEqual([{
      from: [182, 12],
      to: [194, 12],
      color: defaultTokens.colors.value,
      width: 1.5,
      dash: [],
    }])
    expect(ctx.strokeStyle).toBe('#123456')
    expect(ctx.lineWidth).toBe(4)
  })

  it('default painter with companion draws IT: companion color, italic, stored value hidden', () => {
    const { ctx, calls, strikes } = fakeCtx()
    defaultWidgetPainter(argsWith(ctx, { companion: { value: 7 }, connected: true }))
    expect(calls.some((c) => c.text === '20')).toBe(false) // dormant value not drawn
    const companion = calls.find((c) => c.text === '7')!
    expect(companion.fill).toBe(defaultTokens.colors.companionValue)
    expect(companion.font).toContain('italic')
    expect(companion.alpha).toBe(1) // exact: no stale dimming
    expect(strikes).toEqual([])
  })

  it.each([
    ['legacy stale flag', { value: 'old', stale: true }],
    ['stale state', { value: 'old', state: 'stale' as const }],
  ])('paints %s in the dedicated unproven color at full opacity with a dotted underline', (_name, companionDisplay) => {
    const { ctx, calls, strikes } = fakeCtx()
    defaultWidgetPainter(argsWith(ctx, { companion: companionDisplay, connected: true }))
    const companion = calls.find((c) => c.text === 'old')!
    expect(companion.fill).toBe(defaultTokens.colors.companionUnproven)
    expect(companion.alpha).toBe(1)
    expect(strikes).toEqual([{
      from: [170, 16],
      to: [188, 16],
      color: defaultTokens.colors.companionUnproven,
      width: 1,
      dash: [1, 2],
    }])
    expect(ctx.font).toBe('12px system-ui')
    expect(ctx.globalAlpha).toBe(1)
  })

  it.each([
    ['expected', { value: 7, state: 'expected' as const }],
    ['cached', { value: 7, state: 'cached' as const }],
  ])('keeps %s companions neutral, full-opacity, and without the unproven cue', (_name, companionDisplay) => {
    const { ctx, calls, strikes } = fakeCtx()
    defaultWidgetPainter(argsWith(ctx, { companion: companionDisplay, connected: true }))
    const companion = calls.find((c) => c.text === '7')!
    expect(companion.fill).toBe(defaultTokens.colors.companionValue)
    expect(companion.alpha).toBe(1)
    expect(strikes).toEqual([])
  })

  it('fits companion text with its wider italic metrics rather than the regular metrics', () => {
    const { ctx, calls, measuredFonts } = fakeCtx((text, font) => text.length * (font.includes('italic') ? 20 : 4))
    defaultWidgetPainter(argsWith(ctx, {
      companion: { value: 'WWWW', state: 'expected' }, connected: true, width: 100,
    }))
    expect(measuredFonts).toContainEqual({ text: 'WWWW', font: 'italic 12px system-ui' })
    expect(calls.some((call) => call.text === 'WWWW')).toBe(false)
  })

  it('lets an explicit state override the legacy stale compatibility flag', () => {
    const { ctx, calls, strikes } = fakeCtx()
    defaultWidgetPainter(argsWith(ctx, {
      companion: { value: 7, state: 'expected', stale: true },
      connected: true,
    }))
    expect(calls.find((call) => call.text === '7')?.fill).toBe(defaultTokens.colors.companionValue)
    expect(strikes).toEqual([])
  })

  it('registry painter with companion bypasses the kind view (one shared style)', () => {
    const { ctx, calls, strikes } = fakeCtx()
    createRegistryPainter(registry)(argsWith(ctx, { companion: { value: 42 }, connected: true }))
    const companion = calls.find((c) => c.text === '42')!
    expect(companion.fill).toBe(defaultTokens.colors.companionValue)
    expect(companion.font).toContain('italic')
    // The label still renders through the shared chrome.
    expect(calls.some((c) => c.text === 'steps' && c.fill === defaultTokens.colors.label)).toBe(true)
    // The view's own number formatting ('20', the stored value) never draws.
    expect(calls.some((c) => c.text === '20')).toBe(false)
    expect(strikes).toEqual([])
  })

  it('registry painter without companion still routes through the kind view', () => {
    const { ctx, calls } = fakeCtx()
    createRegistryPainter(registry)(argsWith(ctx))
    expect(calls.some((c) => c.text.includes('20'))).toBe(true)
  })

  it('registry painter strikes compact-view value text when connected without a companion', () => {
    const { ctx, strikes } = fakeCtx()
    createRegistryPainter(registry)(argsWith(ctx, { connected: true }))
    expect(strikes).toEqual([{
      from: [174, 12],
      to: [186, 12],
      color: defaultTokens.colors.value,
      width: 1.5,
      dash: [],
    }])
  })

  it('does not shift companion text geometry across expected, retained, and stale states', () => {
    const positions = (['expected', 'cached', 'stale'] as const).map((state) => {
      const { ctx, calls } = fakeCtx()
      createRegistryPainter(registry)(argsWith(ctx, { companion: { value: 42, state }, connected: true }))
      const call = calls.find((candidate) => candidate.text === '42')!
      return { x: call.x, y: call.y }
    })
    expect(positions).toEqual([{ x: 188, y: 12 }, { x: 188, y: 12 }, { x: 188, y: 12 }])
  })

  it('has WCAG AA contrast in dark and theme-overridden light widget palettes', () => {
    const relativeLuminance = (hex: string): number => {
      const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
        .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
    }
    const contrast = (foreground: string, background: string): number => {
      const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a)
      return (lighter! + 0.05) / (darker! + 0.05)
    }
    expect(contrast(defaultTokens.colors.companionUnproven, defaultTokens.colors.widgetBackground)).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#126aa3', '#f5f5f5')).toBeGreaterThanOrEqual(4.5)
  })

  it.each([
    ['current expected', { companion: { value: 1.3, state: 'expected' as const }, connected: true }],
    ['recipe-proven cached', { companion: { value: 1.3, state: 'cached' as const }, connected: true }],
    ['stale/unproven', { companion: { value: 1.3, state: 'stale' as const }, connected: true }],
  ])('formats %s FLOAT values with descriptor precision', (_name, extra) => {
    const { ctx, calls, measured } = fakeCtx()
    createRegistryPainter(registry)({ ...argsWith(ctx, extra), row: floatRow })
    expect(calls.some((call) => call.text === '1.30')).toBe(true)
    expect(measured).toContain('1.30')
  })

  it('fallback painter measures and paints the identical formatted FLOAT inside controller rails', () => {
    const { ctx, calls, measured } = fakeCtx()
    defaultWidgetPainter({
      ...argsWith(ctx, { companion: { value: 1.3, state: 'cached' }, connected: true }),
      row: { ...floatRow, controllerMode: 'randomize' },
    })
    expect(calls.some((call) => call.text === '1.30')).toBe(true)
    expect(measured).toContain('1.30')
    expect(measured).not.toContain('1.3')
  })

  it('registry companion paint uses the actual non-default row height for controller rails', () => {
    const { ctx, calls } = fakeCtx()
    createRegistryPainter(registry)({
      ...argsWith(ctx, { companion: { value: 1.3, state: 'cached' }, connected: true }),
      row: { ...floatRow, height: 32, controllerMode: 'randomize' },
      rowHeight: 32,
    })
    expect(calls.find((call) => call.text === '1.30')?.x).toBe(controllerChipTextRight(200, 32))
  })

  it('formats dormant struck FLOAT values with the same descriptor precision', () => {
    const { ctx, calls } = fakeCtx()
    createRegistryPainter(registry)({ ...argsWith(ctx, { connected: true, value: 8 }), row: floatRow })
    expect(calls.some((call) => call.text === '8.00')).toBe(true)
  })
})
