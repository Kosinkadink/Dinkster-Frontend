import { t, type Json, type WidgetRegistry } from '@dinkster/core'
import { canvasPaintTokens, compactSummary, defaultTokens, type TextMeasurer, type WidgetMeasure } from '@dinkster/canvas'

/**
 * The height of the recorder's one sentence on a backend that cannot take
 * uploads, wrapped at the narrowest editor space, as the editor draws it.
 */
const noUploadsHeights = new Map<string, number>()
function noUploadsHeight(): number {
  const sentence = t('audioRecordWidget.native')
  const known = noUploadsHeights.get(sentence)
  if (known !== undefined) return known
  const space = canvasPaintTokens.node.editorSpace
  const probe = document.createElement('div')
  probe.className = 'dinkster-canvas-editor'
  probe.style.left = '-10000px'
  probe.style.width = `${space.minWidth - defaultTokens.rowGeometry.fieldInsetX * 2}px`
  const note = document.createElement('div')
  note.className = 'dinkster-canvas-editor-note'
  note.dataset['wrap'] = 'true'
  note.textContent = sentence
  probe.append(note)
  document.body.append(probe)
  const height = note.offsetHeight
  probe.remove()
  // An unstyled page measures nothing; measure again once the styles are in.
  if (height > 0) noUploadsHeights.set(sentence, height)
  return height
}

/**
 * The scene and command paths must measure the same geometry. `uploadsRefused`
 * says the backend cannot take uploads, so a recorder is only its sentence.
 */
export function canvasMeasures(registry: () => WidgetRegistry, uploadsRefused?: () => boolean): {
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
    const rows = view.measure(spec).rows
    const summary = (value: Json): string | undefined => compactSummary(view, value, spec)?.text
    return viewId === 'core.audioRecord' && uploadsRefused?.() === true
      ? { viewId, rows, editorControls: noUploadsHeight(), summary } : { viewId, rows, summary }
  }
  return { measure, widgetMeasure }
}
