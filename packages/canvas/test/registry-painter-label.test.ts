/**
 * Deficit-proportional label/value split in the registry painter
 * (text-fit.ts): when both natural widths fit, the label takes exactly what
 * it needs and the value gets the rest - no truncation. When they do not,
 * each side gives up space in proportion to its natural width (label biased
 * to give up more), clamped to readability floors so neither zone vanishes.
 */
import { registerCatalog, setLocale, type WidgetKind, type WidgetRegistry, type WidgetView } from '@dinkster/core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRegistryPainter, subgraphMarkRect } from '../src/registry-painter.js'
import { fitItems } from '../src/renderer.js'
import type { WidgetPaintArgs } from '../src/renderer.js'
import { canvasPaintTokens, defaultTokens } from '../src/tokens.js'
import { widgetChromeRect, type LayoutRow } from '../src/layout.js'

beforeAll(() => {
  vi.stubGlobal('Path2D', class Path2D { constructor(readonly d: string) {} })
})
afterAll(() => vi.unstubAllGlobals())

function fakeCtx(charWidth = 6) {
  const texts: string[] = []
  const textCalls: Array<{ text: string; x: number; y: number; align: CanvasTextAlign; fill: string; font: string }> = []
  const clips: Array<{ x: number; y: number; width: number; height: number }> = []
  const fills: { x: number; y: number; width: number; height: number; fillStyle: string }[] = []
  const roundedFills: { x: number; y: number; width: number; height: number; radius: number; fillStyle: string }[] = []
  const strokes: Array<{ points: Array<{ x: number; y: number }>; strokeStyle: string }> = []
  const transforms: Array<{ method: 'translate' | 'scale'; x: number; y: number }> = []
  const images: Array<{ image: unknown; x: number; y: number; width: number; height: number }> = []
  let pendingRect: { x: number; y: number; width: number; height: number; radius: number } | undefined
  const arcs: Array<{ x: number; y: number; fillStyle: string }> = []
  let pendingArc: { x: number; y: number } | undefined
  let pendingPoints: Array<{ x: number; y: number }> = []
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '12px system-ui',
    globalAlpha: 1,
    textAlign: 'left',
    beginPath: () => { pendingPoints = []; pendingRect = undefined; pendingArc = undefined },
    save: () => {},
    restore: () => {},
    translate: (x: number, y: number) => { transforms.push({ method: 'translate', x, y }) },
    scale: (x: number, y: number) => { transforms.push({ method: 'scale', x, y }) },
    arc: (x: number, y: number) => { pendingArc = { x, y } },
    moveTo: (x: number, y: number) => { pendingPoints.push({ x, y }) },
    lineTo: (x: number, y: number) => { pendingPoints.push({ x, y }) },
    stroke() { strokes.push({ points: [...pendingPoints], strokeStyle: String(this.strokeStyle) }) },
    rect: (x: number, y: number, width: number, height: number) => { pendingRect = { x, y, width, height, radius: 0 } },
    clip: () => { if (pendingRect) clips.push(pendingRect) },
    roundRect: (x: number, y: number, width: number, height: number, radius: number) => { pendingRect = { x, y, width, height, radius } },
    fill() {
      if (pendingRect) roundedFills.push({ ...pendingRect, fillStyle: String(this.fillStyle) })
      if (pendingArc) arcs.push({ ...pendingArc, fillStyle: String(this.fillStyle) })
    },
    fillRect(x: number, y: number, width: number, height: number) {
      fills.push({ x, y, width, height, fillStyle: String(this.fillStyle) })
    },
    measureText: (t: string) => ({ width: t.length * charWidth }),
    drawImage: (image: unknown, x: number, y: number, width: number, height: number) => { images.push({ image, x, y, width, height }) },
    fillText(text: string, x: number, y: number) {
      texts.push(text)
      textCalls.push({ text, x, y, align: this.textAlign as CanvasTextAlign, fill: String(this.fillStyle), font: this.font })
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, textCalls, clips, fills, roundedFills, strokes, arcs, transforms, images }
}

const LABEL = 'control_after_generate'

const rowWith = (value: unknown): Extract<LayoutRow, { kind: 'widget' }> => ({
  kind: 'widget',
  y: 0,
  height: 24,
  inset: 9.5,
  inputId: 'ctrl',
  valueKey: 'ctrl',
  address: { port: 'ctrl' },
  label: LABEL,
  type: { kind: 'concrete', name: 'INT' },
  viewId: 'core.number',
  rows: 1,
  spec: { widgetType: 'INT', options: {}, default: value as never },
})

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
  drawCompact: (scene, value) => { scene.text(0, 0, String(value), { align: 'right' }) },
}
const registry: WidgetRegistry = {
  registerKind: () => () => {},
  registerView: () => () => {},
  registerEditor: () => () => {},
  registerPreviewRenderer: () => () => {},
  kind: (type) => (type === stubKind.type ? stubKind : undefined),
  viewsFor: (kindType) => (kindType === stubKind.type ? [stubView] : []),
  editorFor: () => undefined,
  previewRendererFor: () => undefined,
}

const paint = (value: unknown, width: number): string[] => {
  const { ctx, texts } = fakeCtx()
  const args: WidgetPaintArgs = {
    ctx,
    row: rowWith(value),
    value: value as never,
    x: 0,
    y: 0,
    width,
    rowHeight: 24,
    connected: false,
    tokens: defaultTokens,
  }
  createRegistryPainter(registry)(args)
  return texts
}

const paintString = (value: string, width: number): string[] => {
  return paintStringDetails(value, width).texts
}

const paintStringDetails = (value: string, width: number) => {
  const stringKind: WidgetKind = {
    ...stubKind,
    type: 'STRING',
    defaultValue: () => '',
    defaultView: () => 'core.line',
  }
  const lineView: WidgetView = {
    ...stubView,
    id: 'core.line',
    kind: 'STRING',
    drawCompact: (scene, resolved) => {
      scene.text(1, 0, String(resolved), { role: 'widgetValue', align: 'right', width: 1 })
    },
  }
  const stringRegistry: WidgetRegistry = {
    ...registry,
    kind: (type) => type === 'STRING' ? stringKind : undefined,
    viewsFor: (type) => type === 'STRING' ? [lineView] : [],
  }
  const painted = fakeCtx()
  createRegistryPainter(stringRegistry)({
    ctx: painted.ctx,
    row: {
      ...rowWith(value),
      inputId: 'text',
      valueKey: 'text',
      address: { port: 'text' },
      label: 'text',
      type: { kind: 'concrete', name: 'STRING' },
      viewId: 'core.line',
      spec: { widgetType: 'STRING', options: {}, default: '' },
    },
    value,
    x: 0,
    y: 0,
    width,
    rowHeight: 24,
    connected: false,
    tokens: defaultTokens,
  })
  return painted
}

const paintMultilineDetails = (
  height: number,
  width: number,
  value = 'one\ntwo\nthree\nfour\nfive',
  hovered = false,
) => {
  const stringKind: WidgetKind = {
    ...stubKind,
    type: 'STRING',
    defaultValue: () => '',
    defaultView: () => 'core.text',
  }
  const textView: WidgetView = {
    ...stubView,
    id: 'core.text',
    kind: 'STRING',
    measure: () => ({ rows: 2 }),
    drawCompact: (scene, resolved) => {
      const empty = resolved === ''
      for (const [index, line] of (empty ? [''] : String(resolved).split('\n')).entries()) {
        scene.rect(0.9, index, 0.1, 1, { fill: `line-${index}` })
        scene.text(0, index, line, {
          role: 'widgetValue', width: 1, ...(empty ? { placeholder: true } : {}),
        })
      }
    },
  }
  const stringRegistry: WidgetRegistry = {
    ...registry,
    kind: (type) => type === 'STRING' ? stringKind : undefined,
    viewsFor: (type) => type === 'STRING' ? [textView] : [],
  }
  const painted = fakeCtx()
  createRegistryPainter(stringRegistry)({
    ctx: painted.ctx,
    row: {
      ...rowWith(value),
      height,
      inputId: 'text',
      valueKey: 'text',
      address: { port: 'text' },
      label: 'text',
      type: { kind: 'concrete', name: 'STRING' },
      viewId: 'core.text',
      rows: 2,
      spec: { widgetType: 'STRING', options: { multiline: true }, default: '' },
    },
    value,
    x: 0,
    y: 0,
    width,
    rowHeight: 24,
    connected: false,
    hovered,
    tokens: defaultTokens,
  })
  return painted
}

describe('registry painter label/value split', () => {
  it.each([true, false])('paints the BOOLEAN toggle track and %s thumb position', (checked) => {
    const toggleView: WidgetView = {
      ...stubView, id: 'core.toggle', kind: 'BOOLEAN',
      drawCompact: (scene) => {
        scene.rect(1, 0, 0, 1, { role: 'toggleAffordance', checked })
        scene.text(1, 0, checked ? 'true' : 'false', {
          role: 'widgetValue', align: 'right', width: 1, reserveRight: 24,
        })
      },
    }
    const toggleKind: WidgetKind = {
      ...stubKind, type: 'BOOLEAN', defaultValue: () => false, defaultView: () => 'core.toggle',
    }
    const toggleRegistry: WidgetRegistry = {
      ...registry,
      kind: (type) => type === 'BOOLEAN' ? toggleKind : undefined,
      viewsFor: (type) => type === 'BOOLEAN' ? [toggleView] : [],
    }
    const painted = fakeCtx()
    createRegistryPainter(toggleRegistry)({
      ctx: painted.ctx,
      row: {
        ...rowWith(checked), label: 'enabled', viewId: 'core.toggle',
        spec: { widgetType: 'BOOLEAN', options: {}, default: false },
      },
      value: checked, x: 10, y: 20, width: 150, rowHeight: 24,
      connected: false, tokens: defaultTokens,
    })
    const track = painted.roundedFills.find((fill) => fill.fillStyle === (checked
      ? defaultTokens.colors.widgetAffordanceActive
      : defaultTokens.colors.widgetAffordance))
    const thumb = painted.roundedFills.find((fill) => fill.fillStyle === defaultTokens.colors.value)
    expect(track).toMatchObject({ width: 20, height: 10 })
    expect(thumb).toMatchObject({ width: 8, height: 8 })
    expect(thumb!.x).toBe(checked ? track!.x + 11 : track!.x + 1)
  })

  it('clips declared slider fill to the whole chrome independent of label width and paints text afterward', () => {
    const rangeView: WidgetView = {
      ...stubView,
      drawCompact: (scene) => {
        scene.rect(0, 0, 0.75, 1, { role: 'numericRangeFill', fraction: 0.75 })
        scene.text(1, 0, '75', { role: 'widgetValue', align: 'right', width: 1 })
      },
    }
    const painted = fakeCtx()
    createRegistryPainter({ ...registry, viewsFor: () => [rangeView] })({
      ctx: painted.ctx, row: {
        ...rowWith(75),
        label: 'A deliberately long slider label',
        spec: { widgetType: 'INT', options: { display: 'slider', min: 0, max: 100 }, default: 75 },
      }, value: 75, x: 10, y: 20,
      width: 150, rowHeight: 24, connected: false, tokens: defaultTokens,
    })
    const fill = painted.fills.find((candidate) => candidate.fillStyle === defaultTokens.colors.widgetRangeFillAccent)!
    const chrome = widgetChromeRect(10, 20, 150, 24, defaultTokens.rowGeometry.fieldInsetY)
    const clip = painted.clips.find((candidate) => candidate.y === chrome.y && candidate.height === chrome.height)!
    expect(clip).toMatchObject(chrome)
    expect(fill).toMatchObject({ x: chrome.x, y: chrome.y, height: chrome.height })
    expect(fill.width).toBeCloseTo(0.75 * chrome.width)
    expect(painted.textCalls.findIndex((call) => call.text === '75')).toBeGreaterThan(-1)
    expect(painted.textCalls.find((call) => call.text !== '75')?.fill)
      .toBe(defaultTokens.colors.label)
  })

  it('refuses a numeric range role when the widget does not declare slider display', () => {
    const rangeView: WidgetView = {
      ...stubView,
      drawCompact: (scene) => scene.rect(0, 0, 0.5, 1, { role: 'numericRangeFill', fraction: 0.5 }),
    }
    const painted = fakeCtx()
    createRegistryPainter({ ...registry, viewsFor: () => [rangeView] })({
      ctx: painted.ctx, row: {
        ...rowWith(50),
        spec: { widgetType: 'INT', options: { min: 0, max: 100 }, default: 50 },
      }, value: 50, x: 10, y: 20,
      width: 150, rowHeight: 24, connected: false, tokens: defaultTokens,
    })
    expect(painted.fills.some((candidate) => candidate.fillStyle === defaultTokens.colors.widgetRangeFill)).toBe(false)
  })

  it('reserves a permanent multiline scrollbar gutter and paints a slim thumb only for overflow', () => {
    const fits = paintMultilineDetails(74, 160, 'one\ntwo')
    const idle = paintMultilineDetails(74, 160)
    const scrollbar = idle.roundedFills.find((fill) =>
      fill.fillStyle === defaultTokens.colors.widgetAffordance && fill.width === defaultTokens.multilineText.scrollbarWidth,
    )

    // The text starts at the x of the label over it.
    const label = idle.textCalls.find((call) => call.text === 'text' && call.y < 24)!
    expect(label.x).toBe(6)
    expect(idle.textCalls.find((call) => call.text === 'one')).toMatchObject({ x: label.x })
    expect(idle.clips.filter((clip) => clip.x === 0).map((clip) => clip.width)).toContain(152)
    expect(fits.roundedFills.some((fill) => fill.fillStyle === defaultTokens.colors.widgetAffordance)).toBe(false)
    expect(scrollbar).toMatchObject({ x: 152, y: 19, width: 6, radius: 3 })
    expect(scrollbar!.y + scrollbar!.height).toBeLessThanOrEqual(72)
  })

  it('draws the subgraph icon before a field\'s name across its whole 14 px box', () => {
    const painted = fakeCtx()
    const row = { ...rowWith(5), subgraphMark: { item: 'ctrl', label: LABEL } }
    createRegistryPainter(registry)({
      ctx: painted.ctx, row, value: 5, x: 10, y: 20, width: 200, rowHeight: 24, connected: false, tokens: defaultTokens,
    })
    const mark = subgraphMarkRect(row, 200, 24, defaultTokens, false, true)
    expect(mark.size).toBe(14)
    const at = painted.transforms.findIndex((call) =>
      call.method === 'translate' && call.x === 10 + mark.x && call.y === 20 + mark.y)
    // Lucide's 24-unit box drawn at 14 px, starting at the box's corner.
    expect(painted.transforms[at + 1]).toEqual({ method: 'scale', x: 14 / 24, y: 14 / 24 })
  })

  it('paints an empty multiline placeholder in muted italic type', () => {
    const painted = paintMultilineDetails(76, 160, '')
    const placeholder = painted.textCalls.find((call) => call.text === 'text' && call.y > 24)!
    expect(placeholder).toMatchObject({ x: 6, y: 35, fill: defaultTokens.colors.label })
    expect(placeholder.font).toBe('italic 14px "Noto Sans", sans-serif')
  })

  it('paints the COLOR compact view swatch as a filled square', () => {
    const color = '#3366cc80'
    const colorRow: Extract<LayoutRow, { kind: 'widget' }> = {
      ...rowWith(color),
      inputId: 'color', valueKey: 'color', label: 'color', viewId: 'core.color',
      spec: { widgetType: 'COLOR', options: {}, default: color },
    }
    const colorKind: WidgetKind = {
      ...stubKind, type: 'COLOR', defaultValue: () => color, defaultView: () => 'core.color',
    }
    const colorView: WidgetView = {
      ...stubView, id: 'core.color', kind: 'COLOR',
      drawCompact: (scene, value) => {
        scene.rect(0, 0, 1, 1, { role: 'widgetBackground' })
        scene.rect(0, 0.2, 0.12, 0.6, { fill: String(value), fixedAspect: 'square' })
        scene.text(1, 0, String(value).toUpperCase(), { align: 'right', width: 1, reserveLeft: 16 })
      },
    }
    const colorRegistry: WidgetRegistry = {
      ...registry,
      kind: (type) => type === 'COLOR' ? colorKind : undefined,
      viewsFor: (type) => type === 'COLOR' ? [colorView] : [],
    }
    const { ctx, fills } = fakeCtx()
    createRegistryPainter(colorRegistry)({
      ctx, row: colorRow, value: color, x: 0, y: 0, width: 160, rowHeight: 24,
      connected: false, tokens: defaultTokens,
    })
    expect(fills).toHaveLength(1)
    expect(fills[0]!.fillStyle).toBe(color)
    expect(fills[0]!.width).toBeCloseTo(12.4)
    expect(fills[0]!.height).toBeCloseTo(12.4)
    expect(fills[0]!.y).toBeCloseTo(5.8)
    expect(fills[0]!.x).toBeGreaterThanOrEqual(0)
    expect(fills[0]!.x + fills[0]!.width).toBeLessThanOrEqual(160)
  })

  it('a long label beside a short value renders in full at comfortable widths', () => {
    const texts = paint(20, 240)
    expect(texts).toContain(LABEL) // no '...' - the value did not need the space
    expect(texts).toContain('20')
  })

  it('a narrow row still truncates the label and keeps the value zone', () => {
    const texts = paint(20, 120)
    const label = texts.find((t) => t.startsWith(LABEL.slice(0, 3)))
    expect(label).toBeDefined()
    expect(label).not.toBe(LABEL)
    expect(label!.endsWith('...')).toBe(true)
    expect(texts).toContain('20') // value survives at its minimum reserve
  })

  it.each([
    { look: 'raised-editors' as const, width: 121 },
    { look: 'raised-editors' as const, width: 160 },
    { look: 'inset-raised' as const, width: 160 },
  ])('keeps a short ASSET placeholder whole with $look controls and a long label', ({ look, width }) => {
    const tokens = { ...defaultTokens, widgetRowLook: look }
    const assetKind: WidgetKind = {
      ...stubKind, type: 'ASSET', defaultValue: () => null, defaultView: () => 'core.asset',
    }
    const assetView: WidgetView = {
      ...stubView, id: 'core.asset', kind: 'ASSET',
      drawCompact: (scene) => scene.text(1, 0, 'no asset', {
        role: 'widgetValue', align: 'right', width: 1, placeholder: true,
      }),
    }
    const assetRegistry: WidgetRegistry = {
      ...registry,
      kind: (type) => type === 'ASSET' ? assetKind : undefined,
      viewsFor: (type) => type === 'ASSET' ? [assetView] : [],
    }
    const painted = fakeCtx(width === 121 ? 6.05 : 6)
    createRegistryPainter(assetRegistry)({
      ctx: painted.ctx,
      row: {
        ...rowWith(null), label: 'checkpoint model name', viewId: 'core.asset',
        spec: { widgetType: 'ASSET', options: {}, default: null },
      },
      value: null, x: 0, y: 0, width, rowHeight: 24, connected: false, tokens,
    })
    expect(painted.texts).toContain('no asset')
    if (width !== 121) expect(painted.texts[0]).toMatch(/\.\.\.$/)
    const placeholder = painted.textCalls.find((call) => call.text === 'no asset')!
    expect(placeholder.fill).toBe(defaultTokens.colors.label)
    expect(placeholder.font).toContain('italic')

    const malformed = fakeCtx()
    createRegistryPainter(assetRegistry)({
      ctx: malformed.ctx,
      row: {
        ...rowWith(null), label: 'checkpoint model name', viewId: 'core.asset',
        spec: { widgetType: 'ASSET', options: {}, default: null },
      },
      value: { bad: true }, x: 0, y: 0, width, rowHeight: 24, connected: false, tokens,
    })
    expect(malformed.texts).toContain('no asset')
  })

  it('paints the host summary of a folded editor row in place of the view text, an empty one whole', () => {
    const editorKind: WidgetKind = {
      ...stubKind, type: 'LOAD_3D', defaultValue: () => null, defaultView: () => 'core.load3d',
    }
    const editorView: WidgetView = {
      ...stubView, id: 'core.load3d', kind: 'LOAD_3D',
      drawCompact: (scene) => scene.text(1, 0, '3D viewport', { role: 'widgetValue', align: 'right', width: 1 }),
    }
    const editorRegistry: WidgetRegistry = {
      ...registry,
      kind: (type) => type === 'LOAD_3D' ? editorKind : undefined,
      viewsFor: (type) => type === 'LOAD_3D' ? [editorView] : [],
    }
    const paintSummary = (editorSummary: WidgetPaintArgs['editorSummary']) => {
      const painted = fakeCtx()
      createRegistryPainter(editorRegistry)({
        ctx: painted.ctx,
        row: {
          ...rowWith(null), label: 'viewport camera state', viewId: 'core.load3d',
          spec: { widgetType: 'LOAD_3D', options: {}, default: null },
        },
        value: { camera: 'state' }, x: 0, y: 0, width: 160, rowHeight: 24, connected: false,
        tokens: { ...defaultTokens, widgetRowLook: 'raised-editors' },
        ...(editorSummary === undefined ? {} : { editorSummary }),
      })
      return painted
    }
    const empty = paintSummary({ text: 'No model', placeholder: true })
    expect(empty.texts).not.toContain('3D viewport')
    const placeholder = empty.textCalls.find((call) => call.text === 'No model')!
    expect(placeholder.fill).toBe(defaultTokens.colors.label)
    expect(placeholder.font).toContain('italic')
    // A named value shares the row with a long label like any value.
    const named = paintSummary({ text: 'chair.glb' }).textCalls.find((call) => call.text.startsWith('cha'))!
    expect(named.fill).toBe(defaultTokens.colors.value)
    expect(named.font).not.toContain('italic')
    expect(paintSummary(undefined).texts.some((text) => text.startsWith('3D'))).toBe(true)
    // A thumbnail is drawn just before the text, at its token size.
    const thumbnail = {} as CanvasImageSource
    const withPicture = paintSummary({ text: 'No model', thumbnail })
    const call = withPicture.textCalls.find((text) => text.text.startsWith('No'))!
    const { size, gap } = canvasPaintTokens.widget.valueThumbnail
    expect(withPicture.images).toEqual([{ image: thumbnail, x: Math.round(call.x - call.text.length * 6 - gap - size), y: Math.round(call.y - size / 2), width: size, height: size }])
    expect(paintSummary({ text: 'No model', placeholder: true }).images).toEqual([])
  })

  it('measures a custom BOOLEAN label from the text the view paints', () => {
    const booleanKind: WidgetKind = {
      ...stubKind, type: 'BOOLEAN', defaultValue: () => false, defaultView: () => 'core.toggle',
    }
    const booleanView: WidgetView = {
      ...stubView, id: 'core.toggle', kind: 'BOOLEAN',
      drawCompact: (scene) => {
        scene.rect(1, 0, 0, 1, { role: 'toggleAffordance', checked: true })
        scene.text(1, 0, 'On', {
          role: 'widgetValue', align: 'right', width: 1, reserveRight: 24,
        })
      },
    }
    const booleanRegistry: WidgetRegistry = {
      ...registry,
      kind: (type) => type === 'BOOLEAN' ? booleanKind : undefined,
      viewsFor: (type) => type === 'BOOLEAN' ? [booleanView] : [],
    }
    const painted = fakeCtx()
    createRegistryPainter(booleanRegistry)({
      ctx: painted.ctx,
      row: {
        ...rowWith(true), label: 'enable model optimization', viewId: 'core.toggle',
        spec: { widgetType: 'BOOLEAN', options: { labelOn: 'On' }, default: false },
      },
      value: true, x: 0, y: 0, width: 112, rowHeight: 24, connected: false, tokens: defaultTokens,
    })
    expect(painted.texts).toContain('On')
  })

  it('a value too long to fit beside the label floor falls back to proportional sharing', () => {
    const texts = paint(1.2345678901234568e+23, 220)
    const label = texts.find((t) => t.startsWith(LABEL.slice(0, 3)))
    expect(label).toBeDefined()
    expect(label!.replace(/\.\.\.$/, '').length).toBeGreaterThan(6)
    // ... and the value zone keeps enough room to show real digits too.
    const value = texts.find((t) => t.startsWith('1.23'))
    expect(value).toBeDefined()
    expect(value!.endsWith('...')).toBe(true)
  })

  it('keeps the text label beside a long single-line STRING value', () => {
    const long = 'beautiful scenery nature glass bottle landscape, '.repeat(20)
    // 121px is the painter width at the production 140px node minimum after
    // the standard 9.5px row inset on both sides.
    for (const width of [121, 160, 428, 720]) {
      const texts = paintString(long, width)
      expect(texts, `width ${width}`).toContain('text')
      const value = texts.find((text) => text.startsWith('beautiful'))
      expect(value, `width ${width}`).toBeDefined()
      expect(value!.endsWith('...'), `width ${width}`).toBe(true)
    }
  })

  it('clips the long STRING value after the complete label at every row width', () => {
    const long = 'beautiful scenery nature glass bottle landscape, '.repeat(20)
    for (const width of [121, 160, 428, 720]) {
      const painted = paintStringDetails(long, width)
      const label = painted.textCalls.find((call) => call.text === 'text')!
      const value = painted.textCalls.find((call) => call.text.startsWith('beautiful'))!
      const clip = painted.clips.at(-1)!
      expect(label.align).toBe('left')
      expect(value.align).toBe('right')
      expect(label.x + 4 * 6).toBeLessThanOrEqual(clip.x)
      expect(clip.x).toBeGreaterThanOrEqual(0)
      expect(clip.x + clip.width).toBeLessThanOrEqual(width)
      expect(value.x).toBeLessThanOrEqual(width)
    }
  })

  it.each([
    [76, 3, 3],
    [88, 3, 3],
    [100, 4, 4],
    [120, 5, 5],
  ] as const)('clips multiline text and rect operations to a %ipx allocation', (height, textRows, rectRows) => {
    for (const width of [121, 320]) {
      const painted = paintMultilineDetails(height, width)
      expect(painted.texts).toEqual(['text', ...['one', 'two', 'three', 'four', 'five'].slice(0, textRows)])
      expect(painted.fills).toHaveLength(rectRows)
      expect(painted.textCalls[0]).toMatchObject({ text: 'text', y: 10, align: 'left' })
      expect(painted.textCalls.slice(1).every((call) => call.x >= 0 && call.x <= width)).toBe(true)
      expect(painted.clips.every((clip) => clip.y >= 0 && clip.y + clip.height <= height)).toBe(true)
      if (height === 88) {
        expect(painted.clips.some((clip) => clip.y === 65 && clip.height === 16)).toBe(true)
      }
    }
  })

  it('wraps a long canonical line into measured visual rows without ellipsizing', () => {
    const painted = paintMultilineDetails(100, 160, 'alpha beta gamma delta epsilon\nsecond canonical')
    expect(painted.texts.some((text) => text.endsWith('...'))).toBe(false)
    expect(painted.texts).toContain('text')
    expect(painted.texts).toContain('alpha beta gamma delta')
    expect(painted.texts).toContain('epsilon')
    expect(painted.texts).toContain('second canonical')
    const values = painted.textCalls.filter((call) => call.text.includes('alpha') || call.text.includes('epsilon') || call.text === 'second canonical')
    expect(values.map((call) => call.y)).toEqual([35, 55, 75])
    const label = painted.textCalls.find((call) => call.text === 'text')!
    const valueClip = painted.clips.find((clip) => clip.y === 25 && clip.x === 0)!
    expect(valueClip).toMatchObject({ x: 0, width: 152 })
    expect(valueClip.x).toBeLessThan(label.x)
  })

  it('keeps the following canonical line at row one after consuming trailing wrap whitespace', () => {
    const painted = paintMultilineDetails(76, 160, `alpha${' '.repeat(30)}\nsecond canonical`)
    const values = painted.textCalls.filter((call) => call.text.trimEnd() === 'alpha' || call.text === 'second canonical')
    expect(values.map((call) => ({ text: call.text.trimEnd(), y: call.y }))).toEqual([
      { text: 'alpha', y: 35 },
      { text: 'second canonical', y: 55 },
    ])
  })
})

describe('an automatic value', () => {
  beforeAll(() => {
    registerCatalog('en', { 'automaticField.auto': 'auto' })
    registerCatalog('zh', { 'automaticField.auto': 'zidong' })
  })
  const paintAutomatic = (value: number | undefined, automatic: NonNullable<Extract<LayoutRow, { kind: 'widget' }>['automatic']>, kept?: string) => {
    const { ctx, textCalls, arcs } = fakeCtx()
    createRegistryPainter(registry)({
      ctx,
      row: { ...rowWith(24), label: 'frame_rate', automatic, ...(kept === undefined ? {} : { kept }) },
      value,
      x: 0,
      y: 0,
      width: 280,
      rowHeight: 24,
      connected: false,
      tokens: defaultTokens,
    })
    const shown = String(value ?? automatic.value)
    const word = textCalls.find((call) => call.text !== 'frame_rate' && call.text !== shown)
    return { value: textCalls.find((call) => call.text === shown)!, word, arcs }
  }
  const gap = canvasPaintTokens.widget.valueWordGap

  it('shows the word auto, a gap, then the worked-out value, dimmed, with no dot', () => {
    const { value, word, arcs } = paintAutomatic(undefined, { value: 30, state: 'worked-out' })
    expect(value.text).toBe('30')
    expect(value.fill).toBe(defaultTokens.colors.label)
    expect(word).toMatchObject({ align: 'right', fill: defaultTokens.colors.label })
    // Right-aligned at 6 px a character: the word ends one gap before the value starts.
    expect(gap).toBeGreaterThanOrEqual(8)
    expect(value.x - 2 * 6 - word!.x).toBe(gap)
    expect(arcs).toEqual([])
  })

  it('puts a warning dot before auto when the default is used', () => {
    const { value, word, arcs } = paintAutomatic(undefined, { value: 24, state: 'default', reason: 'failed' })
    expect([word?.text, value.text]).toEqual(['auto', '24'])
    expect(arcs).toHaveLength(1)
    expect(arcs[0]!.fillStyle).toBe(defaultTokens.colors.warningMark)
    // Right-aligned value: the dot sits left of the word.
    expect(arcs[0]!.x).toBeLessThan(word!.x - 4 * 6)
  })

  it('draws the word in the current language, as the open field does', () => {
    setLocale('zh')
    try {
      expect(paintAutomatic(undefined, { value: 30, state: 'worked-out' }).word?.text).toBe('zidong')
    } finally {
      setLocale('en')
    }
  })

  it('reads the kept word only, with no auto and no dot, on a row kept for its wire', () => {
    const { value, word, arcs } = paintAutomatic(undefined, { value: 24, state: 'default', reason: 'failed' }, 'Kept for the wire on its output.')
    expect(word?.text).not.toBe('auto')
    expect(value.text).toBe('24')
    expect(value.x - 2 * 6 - word!.x).toBe(gap)
    expect(arcs).toEqual([])
  })

  it('shows a stored value as any value', () => {
    const { value, arcs } = paintAutomatic(25, { value: 24, state: 'worked-out' })
    expect(value.text).toBe('25')
    expect(value.fill).toBe(defaultTokens.colors.value)
    expect(arcs).toEqual([])
  })
})

describe('a row of items shows as many as fit and counts the rest', () => {
  it('lists every item when all fit, else the ones that fit and +N, cutting the first only when it alone is too wide', () => {
    const { ctx } = fakeCtx()
    expect(fitItems(ctx, ['1', '0.5', '0.25', '12'], 200)).toBe('1, 0.5, 0.25, 12')
    // '1, 0.5 +2' is 54 px and '1, 0.5, 0.25 +1' is 90 px.
    expect(fitItems(ctx, ['1', '0.5', '0.25', '12'], 60)).toBe('1, 0.5 +2')
    const cut = fitItems(ctx, ['checkpoint-name', 'x'], 60)
    expect(cut.endsWith('... +1')).toBe(true)
    expect(cut.length * 6).toBeLessThanOrEqual(60)
  })
})
