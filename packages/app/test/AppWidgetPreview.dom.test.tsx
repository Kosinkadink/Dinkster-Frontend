// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Json, WidgetRegistry, WidgetView } from '@dinkster/core'
import { AppWidgetPreview } from '../src/AppWidgetPreview.js'
import type { ParamRow } from '../src/app-view-rows.js'

const context = new Proxy({} as CanvasRenderingContext2D, {
  get: (_target, property) => property === 'measureText'
    ? (text: string) => ({ width: text.length * 6 })
    : () => undefined,
  set: () => true,
})

const row = (): Extract<ParamRow, { kind: 'live' }> => ({
  kind: 'live',
  entry: { graphId: 'g0', nodeId: 'n1', inputId: 'amount' },
  node: { id: 'n1', type: 'Custom', values: {} },
  item: {
    kind: 'input',
    spec: {
      kind: 'input', id: 'amount', displayName: 'Amount',
      type: { kind: 'concrete', name: 'CUSTOM' }, optional: false,
      widget: { widgetType: 'CUSTOM', options: {}, default: 4 },
    },
    address: { port: 'amount' },
  },
  valueKey: 'amount',
  label: 'Amount',
  context: 'Custom',
  spec: { widgetType: 'CUSTOM', options: {}, default: 4 },
  value: 4,
  linked: false,
  derived: false,
} as Extract<ParamRow, { kind: 'live' }>)

const registry = (view: WidgetView | undefined): WidgetRegistry => ({
  registerKind: () => () => undefined,
  registerView: () => () => undefined,
  registerPreviewRenderer: () => () => undefined,
  kind: () => ({
    type: 'CUSTOM',
    valueSchema: { version: 1, validate: (value: unknown): value is Json => typeof value === 'number' },
    defaultValue: () => 9,
    validate: () => [],
    defaultView: () => 'custom.literal',
  }),
  viewsFor: () => view === undefined ? [] : [view],
  previewRendererFor: () => undefined,
})

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('AppWidgetPreview', () => {
  it('routes a custom WidgetView through the registry-backed canvas painter', async () => {
    const drawCompact = vi.fn((builder, _value: unknown) => builder.text(0, 0, 'literal', {}))
    const view = {
      id: 'custom.literal', kind: 'CUSTOM', isCompatible: () => true,
      measure: () => ({ rows: 1 }), drawCompact,
    } satisfies WidgetView
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AppWidgetPreview row={row()} registry={registry(view)} />, root)
    await Promise.resolve()

    expect(root.querySelector('canvas')?.getAttribute('data-widget-view')).toBe('custom.literal')
    expect(drawCompact).toHaveBeenCalled()
    expect(drawCompact.mock.calls[0]![1]).toBe(9)
    dispose()
  })

  it('uses ordinary canvas row geometry for a multi-row custom view', async () => {
    const view = {
      id: 'custom.literal', kind: 'CUSTOM', isCompatible: () => true,
      measure: () => ({ rows: 2.8 }), drawCompact: () => undefined,
    } satisfies WidgetView
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AppWidgetPreview row={row()} registry={registry(view)} />, root)
    await Promise.resolve()

    expect(root.querySelector('canvas')?.style.height).toBe('48px')
    dispose()
  })

  it('renders no preview when the widget kind has no WidgetView', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AppWidgetPreview row={row()} registry={registry(undefined)} />, root)
    expect(root.querySelector('canvas')).toBeNull()
    dispose()
  })
})
