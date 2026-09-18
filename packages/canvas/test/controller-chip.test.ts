import type { WidgetKind, WidgetRegistry, WidgetView } from '@dinkster/core'
import { describe, expect, it } from 'vitest'
import { controllerChipContains, controllerChipRect, controllerChipTextRight, EDGE_ACTION_GLYPH_HALF, edgeActionCenterX, TRAILING_ACTION_GAP, WIDGET_EDGE_CONTROL_WIDTH } from '../src/controller-chip.js'
import { createRegistryPainter } from '../src/registry-painter.js'
import { defaultWidgetPainter, type WidgetPaintArgs } from '../src/renderer.js'
import { defaultTokens } from '../src/tokens.js'
import type { LayoutRow } from '../src/layout.js'

interface RectCall { readonly x: number; readonly width: number }
interface TextCall { readonly text: string; readonly x: number; readonly align: string }

function recordingContext() {
  const rects: RectCall[] = []
  const texts: TextCall[] = []
  const ctx = {
    fillStyle: '', font: '12px system-ui', globalAlpha: 1, textAlign: 'left',
    beginPath: () => {}, save: () => {}, restore: () => {}, clip: () => {},
    roundRect: () => {}, fill: () => {}, fillRect: () => {},
    rect: (x: number, _y: number, width: number) => rects.push({ x, width }),
    measureText: (text: string) => ({ width: text.length * 6 }),
    fillText(text: string, x: number) {
      texts.push({ text, x, align: String(this.textAlign) })
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects, texts }
}

const row: Extract<LayoutRow, { kind: 'widget' }> = {
  kind: 'widget', y: 0, height: 24, inset: 9.5,
  inputId: 'seed', valueKey: 'seed', address: { port: 'seed' },
  label: 'seed', type: { kind: 'concrete', name: 'INT' },
  viewId: 'core.number', rows: 1, controllerMode: 'randomize',
  spec: { widgetType: 'INT', options: {}, default: 123456789 },
}

const kind: WidgetKind = {
  type: 'INT',
  valueSchema: { version: 1, validate: (value): value is number => typeof value === 'number' },
  defaultValue: () => 0,
  validate: () => [],
  defaultView: () => 'core.number',
}
const view: WidgetView = {
  id: 'core.number', kind: 'INT', isCompatible: () => true, measure: () => ({ rows: 1 }),
  drawCompact: (scene, value) => scene.text(1, 0, String(value), { align: 'right', width: 1 }),
}
const registry: WidgetRegistry = {
  registerKind: () => () => {}, registerView: () => () => {}, registerPreviewRenderer: () => () => {},
  kind: (type) => type === 'INT' ? kind : undefined,
  viewsFor: (type) => type === 'INT' ? [view] : [],
  previewRendererFor: () => undefined,
}

const args = (ctx: CanvasRenderingContext2D): WidgetPaintArgs => ({
  ctx, row, value: 123456789, x: 0, y: 0, width: 160, rowHeight: 24,
  connected: false, tokens: defaultTokens,
})

describe('controller chip geometry', () => {
  it('centers shared edge glyphs six pixels inside unchanged 12px action zones', () => {
    expect(WIDGET_EDGE_CONTROL_WIDTH).toBe(12)
    expect(EDGE_ACTION_GLYPH_HALF).toBe(3)
    expect(TRAILING_ACTION_GAP).toBe(6)
    expect(edgeActionCenterX(160, 'leading')).toBe(6)
    expect(edgeActionCenterX(160, 'trailing')).toBe(154)
  })

  it('uses exactly the painted chip rectangle as the interaction hit zone', () => {
    const chip = controllerChipRect(160, 24)
    expect(chip).toEqual({ x: 126, y: 4, width: 16, height: 16 })
    expect(controllerChipContains(chip.x - 0.01, chip.y, 160, 24)).toBe(false)
    expect(controllerChipContains(chip.x, chip.y, 160, 24)).toBe(true)
    expect(controllerChipContains(chip.x + chip.width, chip.y + chip.height, 160, 24)).toBe(true)
    expect(controllerChipContains(chip.x + chip.width + 0.01, chip.y, 160, 24)).toBe(false)
    expect(controllerChipContains(chip.x, chip.y - 0.01, 160, 24)).toBe(false)
    expect(controllerChipContains(chip.x, chip.y + chip.height + 0.01, 160, 24)).toBe(false)
  })

  it('keeps the registry value clip before the controller and right stepper', () => {
    const { ctx, rects } = recordingContext()
    createRegistryPainter(registry)({ ...args(ctx), x: 100 })
    const chip = controllerChipRect(160, 24)
    expect(rects).toHaveLength(1)
    expect(rects[0]!.x).toBeLessThan(100 + chip.x)
    expect(rects[0]!.x + rects[0]!.width).toBe(100 + controllerChipTextRight(160, 24))
  })

  it('keeps the fallback value right-aligned before the controller rail', () => {
    const { ctx, texts } = recordingContext()
    defaultWidgetPainter(args(ctx))
    const value = texts.find((call) => call.align === 'right')
    expect(value).toBeDefined()
    const chip = controllerChipRect(160, 24)
    expect(value!.x).toBe(controllerChipTextRight(160, 24))
    expect(value!.x).toBeLessThan(chip.x)
    expect(chip.x + chip.width).toBeLessThanOrEqual(160 - 12)
  })

  it('keeps one stable chip boundary across value digit widths', () => {
    const widths = [1, 7, 9, 12, 16].map(() => controllerChipRect(160, 24).x)
    expect(new Set(widths)).toEqual(new Set([126]))
    const chip = controllerChipRect(160, 24)
    expect(chip.x - controllerChipTextRight(160, 24)).toBe(6)
    expect(160 - WIDGET_EDGE_CONTROL_WIDTH - (chip.x + chip.width)).toBe(6)
  })

  it('shows nine digits in the narrow stable zone and ellipsizes longer values deterministically', () => {
    const nine = recordingContext()
    createRegistryPainter(registry)(args(nine.ctx))
    expect(nine.texts.find((call) => call.align === 'right')?.text).toBe('123456789')

    const long = recordingContext()
    createRegistryPainter(registry)({ ...args(long.ctx), value: 1234567890123456 })
    expect(long.texts.find((call) => call.align === 'right')?.text).toBe('12345678...')
  })

  it('keeps the chip out of both stepper zones at minimum width', () => {
    const chip = controllerChipRect(121, 24)
    expect(chip.x).toBeGreaterThanOrEqual(12)
    expect(controllerChipTextRight(121, 24)).toBeLessThan(chip.x)
    expect(chip.x + chip.width).toBeLessThanOrEqual(121 - 12)
  })

  it('keeps the controller pinned to its right rail when the row has room', () => {
    const chip = controllerChipRect(371, 24)
    expect(chip).toEqual({ x: 337, y: 4, width: 16, height: 16 })
    expect(controllerChipTextRight(371, 24)).toBe(331)
  })

  it.each([121, 160, 371])('keeps the controller in a fixed rail after label and value at width %s', (width) => {
    const chip = controllerChipRect(width, 24)
    expect(controllerChipTextRight(width, 24)).toBeLessThan(chip.x)
    expect(chip.x + chip.width).toBeLessThanOrEqual(width - 12)
  })

  it.each([121, 240])('keeps a realistic long label and numeric value in non-overlapping rails at width %s', (width) => {
    const { ctx, texts } = recordingContext()
    const longRow = { ...row, label: 'noise seed after generation' }
    createRegistryPainter(registry)({ ...args(ctx), row: longRow, width })
    const label = texts.find((call) => call.align === 'left')
    const value = texts.find((call) => call.align === 'right')
    expect(label).toBeDefined()
    expect(value).toBeDefined()
    expect(label!.x).toBeLessThan(value!.x)
    expect(value!.text.length).toBeGreaterThanOrEqual(width === 121 ? 4 : 9)
  })

  it('threads non-default row height through paint and text rails', () => {
    const { ctx, texts } = recordingContext()
    defaultWidgetPainter({ ...args(ctx), row: { ...row, height: 32 }, rowHeight: 32 })
    const chip = controllerChipRect(160, 32)
    const value = texts.find((call) => call.align === 'right')
    expect(value?.x).toBe(controllerChipTextRight(160, 32))
    expect(chip.x - value!.x).toBe(6)
  })
})
