import type { WidgetKind, WidgetRegistry, WidgetView } from '@dinkster/core'
import { describe, expect, it } from 'vitest'
import { createRegistryPainter } from '../src/registry-painter.js'
import { type WidgetPaintArgs } from '../src/renderer.js'
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
  registerKind: () => () => {}, registerView: () => () => {}, registerEditor: () => () => {}, registerPreviewRenderer: () => () => {},
  kind: (type) => type === 'INT' ? kind : undefined,
  viewsFor: (type) => type === 'INT' ? [view] : [],
  editorFor: () => undefined,
  previewRendererFor: () => undefined,
}

const args = (ctx: CanvasRenderingContext2D): WidgetPaintArgs => ({
  ctx, row, value: 123456789, x: 0, y: 0, width: 160, rowHeight: 24,
  connected: false, tokens: defaultTokens,
})

describe('controller chip geometry', () => {

  it('shows nine digits in the narrow stable zone and ellipsizes longer values deterministically', () => {
    const nine = recordingContext()
    createRegistryPainter(registry)(args(nine.ctx))
    expect(nine.texts.find((call) => call.align === 'right')?.text).toBe('123456789')

    const long = recordingContext()
    createRegistryPainter(registry)({ ...args(long.ctx), value: 1234567890123456 })
    expect(long.texts.find((call) => call.align === 'right')?.text).toBe('12345678...')
  })

})
