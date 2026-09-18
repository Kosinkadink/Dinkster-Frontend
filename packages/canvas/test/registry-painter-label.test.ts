/**
 * Deficit-proportional label/value split in the registry painter
 * (text-fit.ts): when both natural widths fit, the label takes exactly what
 * it needs and the value gets the rest - no truncation. When they do not,
 * each side gives up space in proportion to its natural width (label biased
 * to give up more), clamped to readability floors so neither zone vanishes.
 */
import type { WidgetKind, WidgetRegistry, WidgetView } from '@dinkster/core'
import { describe, expect, it } from 'vitest'
import { createRegistryPainter } from '../src/registry-painter.js'
import type { WidgetPaintArgs } from '../src/renderer.js'
import { defaultTokens } from '../src/tokens.js'
import { widgetChromeRect, type LayoutRow } from '../src/layout.js'

function fakeCtx() {
  const texts: string[] = []
  const textCalls: Array<{ text: string; x: number; y: number; align: CanvasTextAlign; fill: string; font: string }> = []
  const clips: Array<{ x: number; y: number; width: number; height: number }> = []
  const fills: { x: number; y: number; width: number; height: number; fillStyle: string }[] = []
  const roundedFills: { x: number; y: number; width: number; height: number; radius: number; fillStyle: string }[] = []
  const strokes: Array<{ points: Array<{ x: number; y: number }>; strokeStyle: string }> = []
  let pendingRect: { x: number; y: number; width: number; height: number; radius: number } | undefined
  let pendingPoints: Array<{ x: number; y: number }> = []
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '12px system-ui',
    globalAlpha: 1,
    textAlign: 'left',
    beginPath: () => { pendingPoints = []; pendingRect = undefined },
    save: () => {},
    restore: () => {},
    moveTo: (x: number, y: number) => { pendingPoints.push({ x, y }) },
    lineTo: (x: number, y: number) => { pendingPoints.push({ x, y }) },
    stroke() { strokes.push({ points: [...pendingPoints], strokeStyle: String(this.strokeStyle) }) },
    rect: (x: number, y: number, width: number, height: number) => { pendingRect = { x, y, width, height, radius: 0 } },
    clip: () => { if (pendingRect) clips.push(pendingRect) },
    roundRect: (x: number, y: number, width: number, height: number, radius: number) => { pendingRect = { x, y, width, height, radius } },
    fill() {
      if (pendingRect) roundedFills.push({ ...pendingRect, fillStyle: String(this.fillStyle) })
    },
    fillRect(x: number, y: number, width: number, height: number) {
      fills.push({ x, y, width, height, fillStyle: String(this.fillStyle) })
    },
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillText(text: string, x: number, y: number) {
      texts.push(text)
      textCalls.push({ text, x, y, align: this.textAlign as CanvasTextAlign, fill: String(this.fillStyle), font: this.font })
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, textCalls, clips, fills, roundedFills, strokes }
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
  registerPreviewRenderer: () => () => {},
  kind: (type) => (type === stubKind.type ? stubKind : undefined),
  viewsFor: (kindType) => (kindType === stubKind.type ? [stubView] : []),
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

  it('paints a COMBO down chevron in the reserved right edge', () => {
    const selectView: WidgetView = {
      ...stubView, id: 'core.select', kind: 'COMBO',
      drawCompact: (scene) => {
        scene.rect(1, 0, 0, 1, { role: 'comboChevron' })
        scene.text(1, 0, 'euler', {
          role: 'widgetValue', align: 'right', width: 1,
        })
      },
    }
    const selectKind: WidgetKind = {
      ...stubKind, type: 'COMBO', defaultValue: () => '', defaultView: () => 'core.select',
    }
    const selectRegistry: WidgetRegistry = {
      ...registry,
      kind: (type) => type === 'COMBO' ? selectKind : undefined,
      viewsFor: (type) => type === 'COMBO' ? [selectView] : [],
    }
    const painted = fakeCtx()
    createRegistryPainter(selectRegistry)({
      ctx: painted.ctx,
      row: {
        ...rowWith('euler'), label: 'sampler', viewId: 'core.select',
        spec: { widgetType: 'COMBO', options: { options: ['euler'] }, default: 'euler' },
      },
      value: 'euler', x: 10, y: 20, width: 150, rowHeight: 24,
      connected: false, tokens: defaultTokens,
    })
    expect(painted.strokes).toContainEqual({
      points: [{ x: 151, y: 30 }, { x: 154, y: 33 }, { x: 157, y: 30 }],
      strokeStyle: defaultTokens.colors.widgetAffordance,
    })
    const value = painted.textCalls.find((call) => call.text === 'euler')
    expect(value).toMatchObject({ x: 146, align: 'right' })
    expect(painted.clips).toContainEqual({ x: 64, y: 22, width: 84, height: 20, radius: 0 })
  })

  it('keeps the shared companion-driven COMBO presentation free of a chevron', () => {
    const selectView: WidgetView = {
      ...stubView, id: 'core.select', kind: 'COMBO',
      drawCompact: (scene) => {
        scene.rect(1, 0, 0, 1, { role: 'comboChevron' })
        scene.text(1, 0, 'stored', { role: 'widgetValue', align: 'right', width: 1 })
      },
    }
    const selectKind: WidgetKind = {
      ...stubKind, type: 'COMBO', defaultValue: () => '', defaultView: () => 'core.select',
    }
    const selectRegistry: WidgetRegistry = {
      ...registry,
      kind: (type) => type === 'COMBO' ? selectKind : undefined,
      viewsFor: (type) => type === 'COMBO' ? [selectView] : [],
    }
    const painted = fakeCtx()
    createRegistryPainter(selectRegistry)({
      ctx: painted.ctx,
      row: {
        ...rowWith('stored'), label: 'sampler', viewId: 'core.select',
        spec: { widgetType: 'COMBO', options: { options: ['stored', 'driven'] }, default: 'stored' },
      },
      value: 'stored', companion: { value: 'driven', state: 'cached' },
      x: 10, y: 20, width: 150, rowHeight: 24,
      connected: true, tokens: defaultTokens,
    })
    expect(painted.strokes).toEqual([])
    expect(painted.texts).toContain('driven')
    expect(painted.texts).not.toContain('stored')
    expect(painted.roundedFills.find((fill) => fill.fillStyle === defaultTokens.colors.widgetBackground)).toEqual({
      ...widgetChromeRect(10, 20, 150, 24), fillStyle: defaultTokens.colors.widgetBackground,
    })
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
    const fill = painted.fills.find((candidate) => candidate.fillStyle === defaultTokens.colors.widgetRangeFill)!
    const chrome = widgetChromeRect(10, 20, 150, 24)
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

  it.each([
    { display: 'slider', min: 0 },
    { display: 'slider', min: 1, max: 1 },
    { display: 'slider', min: 2, max: 1 },
    { display: 'slider', min: 0, max: Number.POSITIVE_INFINITY },
  ])('refuses a numeric range role for unusable declared-slider bounds %#', (options) => {
    const rangeView: WidgetView = {
      ...stubView,
      drawCompact: (scene) => scene.rect(0, 0, 0.5, 1, { role: 'numericRangeFill', fraction: 0.5 }),
    }
    const painted = fakeCtx()
    createRegistryPainter({ ...registry, viewsFor: () => [rangeView] })({
      ctx: painted.ctx, row: {
        ...rowWith(50), spec: { widgetType: 'INT', options, default: 50 },
      }, value: 50, x: 10, y: 20,
      width: 150, rowHeight: 24, connected: false, tokens: defaultTokens,
    })
    expect(painted.fills.some((candidate) => candidate.fillStyle === defaultTokens.colors.widgetRangeFill)).toBe(false)
  })

  it('does not add compact affordance paint to a plain STRING row', () => {
    const painted = paintStringDetails('hello', 160)
    expect(painted.fills).toEqual([])
    expect(painted.roundedFills.filter((fill) => fill.fillStyle !== defaultTokens.colors.widgetBackground)).toEqual([])
    expect(painted.strokes).toEqual([])
  })

  it('paints compact and multiline chrome from the shared geometry', () => {
    const compact = paintStringDetails('hello', 160)
    expect(compact.roundedFills.find((fill) => fill.fillStyle === defaultTokens.colors.widgetBackground)).toEqual({
      ...widgetChromeRect(0, 0, 160, 24), fillStyle: defaultTokens.colors.widgetBackground,
    })

    const multiline = paintMultilineDetails(96, 160, 'one\ntwo')
    expect(multiline.roundedFills.find((fill) => fill.fillStyle === defaultTokens.colors.widgetBackground)).toEqual({
      ...widgetChromeRect(0, 0, 160, 96), fillStyle: defaultTokens.colors.widgetBackground,
    })
  })

  it('floats the multiline label above a gutter-reserved padded 14px content strip', () => {
    const painted = paintMultilineDetails(74, 160, 'one\ntwo')
    const label = painted.textCalls.find((call) => call.text === 'text')!
    const one = painted.textCalls.find((call) => call.text === 'one')!
    const two = painted.textCalls.find((call) => call.text === 'two')!

    expect(label).toMatchObject({ x: 6, y: 11, font: '12px system-ui' })
    expect(one).toMatchObject({ x: 6, y: 36, font: '14px system-ui, sans-serif' })
    expect(two).toMatchObject({ x: 6, y: 56, font: '14px system-ui, sans-serif' })
    expect(painted.clips.filter((clip) => clip.x === 0).map((clip) => clip.width)).toContain(152)
  })

  it('reserves a permanent multiline scrollbar gutter and paints a slim thumb only for hovered overflow', () => {
    const idle = paintMultilineDetails(74, 160)
    const hovered = paintMultilineDetails(74, 160, 'one\ntwo\nthree\nfour\nfive', true)
    const scrollbar = hovered.roundedFills.find((fill) =>
      fill.fillStyle === defaultTokens.colors.widgetAffordance && fill.width === defaultTokens.multilineText.scrollbarWidth,
    )

    expect(idle.textCalls.find((call) => call.text === 'one')).toMatchObject({ x: 6 })
    expect(idle.clips.filter((clip) => clip.x === 0).map((clip) => clip.width)).toContain(152)
    expect(idle.roundedFills.some((fill) => fill.fillStyle === defaultTokens.colors.widgetAffordance)).toBe(false)
    expect(scrollbar).toMatchObject({ x: 152, y: 20, width: 6, radius: 3 })
    expect(scrollbar!.y + scrollbar!.height).toBeLessThanOrEqual(72)
  })

  it('paints an empty multiline placeholder in muted italic type', () => {
    const painted = paintMultilineDetails(76, 160, '')
    const placeholder = painted.textCalls.find((call) => call.text === 'text' && call.y > 24)!
    expect(placeholder).toMatchObject({ x: 6, y: 36, fill: defaultTokens.colors.label })
    expect(placeholder.font).toBe('italic 14px system-ui, sans-serif')
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
    expect(fills[0]!.width).toBeCloseTo(10.4)
    expect(fills[0]!.height).toBeCloseTo(10.4)
    expect(fills[0]!.y).toBeCloseTo(6.8)
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

  it('keeps a short ASSET placeholder whole while truncating its long label', () => {
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
    const painted = fakeCtx()
    createRegistryPainter(assetRegistry)({
      ctx: painted.ctx,
      row: {
        ...rowWith(null), label: 'checkpoint model name', viewId: 'core.asset',
        spec: { widgetType: 'ASSET', options: {}, default: null },
      },
      value: null, x: 0, y: 0, width: 112, rowHeight: 24, connected: false, tokens: defaultTokens,
    })
    expect(painted.texts).toContain('no asset')
    expect(painted.texts[0]).toMatch(/\.\.\.$/)
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
      value: { bad: true }, x: 0, y: 0, width: 112, rowHeight: 24, connected: false, tokens: defaultTokens,
    })
    expect(malformed.texts).toContain('no asset')
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
    const texts = paint(1.2345678901234568e+23, 200)
    const label = texts.find((t) => t.startsWith(LABEL.slice(0, 3)))
    expect(label).toBeDefined()
    expect(label!.replace(/\.\.\.$/, '').length).toBeGreaterThan(6)
    // ... and the value zone keeps enough room to show real digits too.
    const value = texts.find((t) => t.startsWith('1.23'))
    expect(value).toBeDefined()
    expect(value!.endsWith('...')).toBe(true)
  })

  it('the value keeps more of its glyphs than the old hard 30% cap allowed', () => {
    // Old split: value zone = max(48, 30% of usable) regardless of need.
    // usable = 276; a 106px value under the old cap got 82.8px; under
    // deficit sharing with a 144px label it fits entirely (250 <= 276).
    const texts = paint(123456789012345, 300)
    expect(texts).toContain(LABEL)
    expect(texts).toContain('123456789012345')
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

  it('leaves short single-line STRING values compact and readable', () => {
    expect(paintString('text, watermark', 280)).toEqual(['text', 'text, watermark'])
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
      expect(painted.textCalls[0]).toMatchObject({ text: 'text', y: 11, align: 'left' })
      expect(painted.textCalls.slice(1).every((call) => call.x >= 0 && call.x <= width)).toBe(true)
      expect(painted.clips.every((clip) => clip.y >= 0 && clip.y + clip.height <= height)).toBe(true)
      if (height === 88) {
        expect(painted.clips.some((clip) => clip.y === 66 && clip.height === 14)).toBe(true)
      }
    }
  })

  it('keeps multiline text in the value color', () => {
    const painted = paintMultilineDetails(76, 160)
    const values = painted.textCalls.filter((call) => call.text === 'one' || call.text === 'two')
    expect(values).toHaveLength(2)
    expect(values.every((call) => call.fill === defaultTokens.colors.value)).toBe(true)
  })

  it('wraps a long canonical line into measured visual rows without ellipsizing', () => {
    const painted = paintMultilineDetails(100, 160, 'alpha beta gamma delta epsilon\nsecond canonical')
    expect(painted.texts.some((text) => text.endsWith('...'))).toBe(false)
    expect(painted.texts).toContain('text')
    expect(painted.texts).toContain('alpha beta gamma delta')
    expect(painted.texts).toContain('epsilon')
    expect(painted.texts).toContain('second canonical')
    const values = painted.textCalls.filter((call) => call.text.includes('alpha') || call.text.includes('epsilon') || call.text === 'second canonical')
    expect(values.map((call) => call.y)).toEqual([36, 56, 76])
    const label = painted.textCalls.find((call) => call.text === 'text')!
    const valueClip = painted.clips.find((clip) => clip.y === 26 && clip.x === 0)!
    expect(valueClip).toMatchObject({ x: 0, width: 152 })
    expect(valueClip.x).toBeLessThan(label.x)
  })

  it('keeps the following canonical line at row one after consuming trailing wrap whitespace', () => {
    const painted = paintMultilineDetails(76, 160, `alpha${' '.repeat(30)}\nsecond canonical`)
    const values = painted.textCalls.filter((call) => call.text.trimEnd() === 'alpha' || call.text === 'second canonical')
    expect(values.map((call) => ({ text: call.text.trimEnd(), y: call.y }))).toEqual([
      { text: 'alpha', y: 36 },
      { text: 'second canonical', y: 56 },
    ])
  })
})
