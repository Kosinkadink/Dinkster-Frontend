import type { WidgetRegistry } from '@dinkster/core'
import { canvasPaintTokens, defaultTokens, type TextMeasurer, type WidgetMeasure } from '@dinkster/canvas'

/** The scene and command paths must measure the same geometry. */
export function canvasMeasures(registry: () => WidgetRegistry): {
  measure: TextMeasurer
  widgetMeasure: WidgetMeasure
} {
  let context: CanvasRenderingContext2D | null | undefined
  const measure: TextMeasurer = (text, role) => {
    context ??= document.createElement('canvas').getContext('2d')!
    context.font = role === 'title' || role === 'renamedTitle'
      ? `${role === 'renamedTitle' ? 'italic ' : ''}${canvasPaintTokens.type.semiboldWeight} ${defaultTokens.titleFontSize}px ${defaultTokens.fontFamily}`
      : `${defaultTokens.fontSize}px ${defaultTokens.fontFamily}`
    return context.measureText(text).width
  }
  const widgetMeasure: WidgetMeasure = (spec) => {
    const kind = registry().kind(spec.widgetType)
    if (!kind) return undefined
    const viewId = kind.defaultView(spec)
    const view = registry().viewsFor(spec.widgetType).find((v) => v.id === viewId)
    if (!view) return undefined
    return { viewId, rows: view.measure(spec).rows }
  }
  return { measure, widgetMeasure }
}
