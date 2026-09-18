/**
 * Registry-backed WidgetPainter: routes widget rows through WidgetView
 * drawCompact via a SceneBuilder -> Canvas2D adapter, falling back to the
 * default painter for unknown kinds/views.
 *
 * SceneBuilder coordinate convention: x/w are fractions of the row
 * content width (0..1); y/h are row units. Views stay resolution- and
 * layout-independent; the adapter owns pixels.
 */

import { formatWidgetValue, type Json, type WidgetRegistry } from '@dinkster/core'
import { controllerChipRect, controllerChipTextRight, CONTROLLER_CHIP_TEXT_GAP, EDGE_ACTION_GLYPH_HALF, edgeActionCenterX, WIDGET_EDGE_CONTROL_WIDTH, widgetFieldBounds } from './controller-chip.js'
import { widgetChromeRect } from './layout.js'
import { defaultWidgetPainter, paintCompanionValue, paintStaleValueStrikethrough, type WidgetPainter } from './renderer.js'
import { fitText, measureWidth, shareRowWidth, wrapText } from './text-fit.js'

const TEXT_PAD = 2

function compactAssetValue(value: Json, valid: boolean): string {
  if (!valid || value === null) return 'no asset'
  if (Array.isArray(value)) {
    if (value.length === 0) return 'no asset'
    return value.length === 1
      ? String((value[0] as { name: string }).name)
      : `${value.length} assets`
  }
  return String((value as { name: string }).name)
}

function compactBooleanValue(value: Json, options: Readonly<Record<string, unknown>>): string {
  const custom = options[value === true ? 'labelOn' : 'labelOff']
  return typeof custom === 'string' && custom !== '' ? custom : String(value)
}

/** Measured ASCII ellipsis shared by every registry-backed compact view.
 * Cached: see text-fit.ts (memoized measure + binary-search truncation). */
export const ellipsize = fitText

export function createRegistryPainter(registry: WidgetRegistry): WidgetPainter {
  return (args) => {
    const { ctx, row, value, x, y, width, rowHeight, tokens } = args
    const view = registry.viewsFor(row.spec.widgetType).find((v) => v.id === row.viewId)
    const kind = registry.kind(row.spec.widgetType)
    if (!view || !kind) {
      defaultWidgetPainter(args)
      return
    }
    if (args.companion !== undefined) {
      // Companion (propagated) display bypasses the kind view entirely: one
      // shared read-only style for every widget kind, drawn over the shared
      // row chrome - never the view's interactive presentation.
      const chrome = widgetChromeRect(x, y, width, row.height)
      ctx.fillStyle = tokens.colors.widgetBackground
      ctx.beginPath()
      ctx.roundRect(chrome.x, chrome.y, chrome.width, chrome.height, chrome.radius)
      ctx.fill()
      ctx.fillStyle = tokens.colors.label
      ctx.textAlign = 'left'
      const formatted = formatWidgetValue(args.companion.value, row.spec)
      const numeric = row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT'
      const field = widgetFieldBounds(width, rowHeight, numeric, row.controllerMode !== undefined)
      const companionZone = shareRowWidth(field.right - field.left, measureWidth(ctx, row.label) + 12, measureWidth(ctx, formatted) + 12)
      ctx.fillText(fitText(ctx, row.label, Math.max(0, companionZone - 8)), x + field.left + 6, y + rowHeight / 2)
      paintCompanionValue(args)
      return
    }
    const resolved: Json = value !== undefined ? value : (kind.defaultValue(row.spec) as Json)
    // Draw the shared row chrome (label) then let the view draw its content.
    const chrome = widgetChromeRect(x, y, width, row.height)
    ctx.fillStyle = tokens.colors.widgetBackground
    ctx.beginPath()
    ctx.roundRect(chrome.x, chrome.y, chrome.width, chrome.height, chrome.radius)
    ctx.fill()
    ctx.fillStyle = tokens.colors.label
    ctx.textAlign = 'left'
    const numeric = row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT'
    const leftControl = numeric ? WIDGET_EDGE_CONTROL_WIDTH : 0
    const combo = row.viewId === 'core.select' && row.spec.widgetType === 'COMBO'
    const rightControl = numeric || combo ? WIDGET_EDGE_CONTROL_WIDTH : 0
    const usableWidth = Math.max(0, width - leftControl - rightControl)
    const naturalLabelWidth = measureWidth(ctx, row.label) + 12
    // Deficit-proportional label/value split (text-fit.ts): when both fit,
    // the label takes exactly its natural width; when they do not, each side
    // shrinks in proportion to its natural width with the label biased to
    // give up more, clamped to readability floors. Primitive values expose
    // their natural width; structured values (asset refs, color swatch +
    // hex, ...) keep a conservative reserve because their content need is
    // view-specific.
    const valuePreview = row.viewId === 'core.asset' && row.spec.widgetType === 'ASSET'
      ? compactAssetValue(resolved, kind.valueSchema.validate(resolved))
      : row.viewId === 'core.toggle' && row.spec.widgetType === 'BOOLEAN'
        ? compactBooleanValue(resolved, row.spec.options)
      : resolved === null || typeof resolved === 'object'
        ? undefined
        : formatWidgetValue(resolved, row.spec)
    const naturalValueWidth = valuePreview === undefined
      ? usableWidth * 0.55
      : measureWidth(ctx, valuePreview.split('\n')[0] ?? '') + 16
        + (row.viewId === 'core.color' ? 16 : 0)
        + (row.viewId === 'core.toggle' && row.spec.widgetType === 'BOOLEAN' ? 12 : 0)
    const controller = row.controllerMode !== undefined
      ? controllerChipRect(width, rowHeight)
      : undefined
    const valueRight = controller === undefined ? width - rightControl : controllerChipTextRight(width, rowHeight)
    const fieldWidth = Math.max(0, valueRight - leftControl)
    const multiline = row.viewId === 'core.text'
    const multilineLabelHeight = tokens.multilineText.labelHeight
    const multilineGutter = tokens.multilineText.scrollbarWidth + tokens.multilineText.scrollbarInset
    const labelWidth = multiline
      ? 0
      : shareRowWidth(fieldWidth, naturalLabelWidth, naturalValueWidth, true)
    const paintLabel = () => {
      ctx.fillStyle = tokens.colors.label
      ctx.textAlign = 'left'
      ctx.fillText(
        ellipsize(ctx, row.label, Math.max(0, (multiline ? width : labelWidth) - 8)),
        x + (multiline ? 0 : leftControl) + 6,
        multiline ? chrome.y + multilineLabelHeight / 2 : y + rowHeight / 2,
      )
    }
    const sliderMin = row.spec.options['min']
    const sliderMax = row.spec.options['max']
    const declaredSlider = numeric && row.spec.options['display'] === 'slider' &&
      typeof sliderMin === 'number' && Number.isFinite(sliderMin) &&
      typeof sliderMax === 'number' && Number.isFinite(sliderMax) && sliderMax > sliderMin
    if (!declaredSlider) paintLabel()
    const contentOffset = multiline ? 0 : labelWidth + leftControl
    const contentStart = x + contentOffset
    const contentWidth = multiline ? Math.max(0, width - multilineGutter) : Math.max(0, valueRight - contentOffset)
    const multilineHeight = tokens.multilineText.lineHeight
    const multilineTop = chrome.y + multilineLabelHeight
    const multilineBottom = chrome.y + chrome.height
    const multilinePadding = tokens.multilineText.padding

    let multilineExtraRows = 0
    let multilineVisualRows = 0
    view.drawCompact(
      {
        rect: (rx, ry, rw, rh, style) => {
          if (style['role'] === 'widgetBackground') return // chrome already drawn
          if (style['role'] === 'numericRangeFill') {
            if (!declaredSlider) return
            const rawFraction = Number(style['fraction'])
            if (!Number.isFinite(rawFraction)) return
            const fraction = Math.max(0, Math.min(1, rawFraction))
            ctx.save()
            ctx.beginPath()
            ctx.roundRect(chrome.x, chrome.y, chrome.width, chrome.height, chrome.radius)
            ctx.clip()
            ctx.fillStyle = tokens.colors.widgetRangeFill
            ctx.fillRect(chrome.x, chrome.y, chrome.width * fraction, chrome.height)
            ctx.restore()
            return
          }
          if (style['role'] === 'toggleAffordance') {
            const checked = style['checked'] === true
            const trackX = contentStart + contentWidth - 22
            const trackY = y + rowHeight / 2 - 5
            ctx.fillStyle = checked
              ? tokens.colors.widgetAffordanceActive
              : tokens.colors.widgetAffordance
            ctx.beginPath()
            ctx.roundRect(trackX, trackY, 20, 10, 5)
            ctx.fill()
            ctx.fillStyle = tokens.colors.value
            ctx.beginPath()
            ctx.roundRect(trackX + (checked ? 11 : 1), trackY + 1, 8, 8, 4)
            ctx.fill()
            return
          }
          if (style['role'] === 'comboChevron') {
            const center = x + edgeActionCenterX(width, 'trailing')
            const middle = y + rowHeight / 2
            ctx.save()
            ctx.strokeStyle = tokens.colors.widgetAffordance
            ctx.lineWidth = 1.5
            ctx.beginPath()
            ctx.moveTo(center - EDGE_ACTION_GLYPH_HALF, middle - 2)
            ctx.lineTo(center, middle + 1)
            ctx.lineTo(center + EDGE_ACTION_GLYPH_HALF, middle - 2)
            ctx.stroke()
            ctx.restore()
            return
          }
          if (style['role'] === 'curveSample') {
            ctx.fillStyle = tokens.colors.widgetAffordanceActive
          }
          const unitHeight = multiline ? multilineHeight : rowHeight
          const rectTop = multiline
            ? multilineTop + multilinePadding + ry * unitHeight
            : y + ry * unitHeight + 2
          const rectBottom = rectTop + rh * unitHeight - (multiline ? 0 : 4)
          const clipTop = Math.max(multiline ? multilineTop : y, rectTop)
          const clipBottom = Math.min(multiline ? multilineBottom - multilinePadding : y + row.height, rectBottom)
          if (clipBottom <= clipTop) return
          if (style['role'] !== 'curveSample') {
            ctx.fillStyle = String(style['fill'] ?? tokens.colors.widgetBackground)
          }
          const rectHeight = rh * unitHeight - (multiline ? 0 : 4)
          const rectWidth = style['fixedAspect'] === 'square' ? rectHeight : rw * contentWidth
          ctx.save()
          ctx.beginPath()
          ctx.rect(contentStart + rx * contentWidth, clipTop, rectWidth, clipBottom - clipTop)
          ctx.clip()
          ctx.fillRect(contentStart + rx * contentWidth, rectTop, rectWidth, rectHeight)
          ctx.restore()
        },
        text: (tx, ty, run, style) => {
          ctx.fillStyle = tokens.colors.value
          const alignRight = style['align'] === 'right'
          ctx.textAlign = alignRight ? 'right' : 'left'
          const px = contentStart + tx * contentWidth
          const reserveLeft = Number(style['reserveLeft'] ?? 0)
          const reserveRight = Number(style['reserveRight'] ?? 0)
          const defaultWidth = alignRight ? (tx > 0 ? tx : 1) : 1 - tx
          const zoneWidth = Math.max(0, Number(style['width'] ?? defaultWidth) * contentWidth - reserveLeft - reserveRight)
          const zoneRight = alignRight ? px - reserveRight : px + reserveLeft + zoneWidth
          const availableWidth = Math.max(0, zoneWidth - TEXT_PAD * 2)
          if (!multiline) {
            const text = ellipsize(ctx, run.split('\n')[0] ?? '', availableWidth)
            const lineTop = y + ty * rowHeight + 2
            const lineBottom = y + (ty + 1) * rowHeight - 2
            const clipTop = Math.max(y, lineTop)
            const clipBottom = Math.min(y + row.height, lineBottom)
            if (clipBottom > clipTop) {
              ctx.save()
              const placeholder = style['placeholder'] === true
              ctx.fillStyle = placeholder ? tokens.colors.label : tokens.colors.value
              if (placeholder) ctx.font = `italic ${ctx.font}`
              ctx.beginPath()
              ctx.rect(alignRight ? zoneRight - zoneWidth : px + reserveLeft, clipTop, zoneWidth, clipBottom - clipTop)
              ctx.clip()
              const textX = alignRight ? zoneRight - TEXT_PAD : px + reserveLeft + TEXT_PAD
              const textY = y + (ty + 0.5) * rowHeight
              ctx.fillText(text, textX, textY)
              const role = style['role']
              if (args.connected && (role === undefined || role === 'widgetValue')) {
                paintStaleValueStrikethrough(ctx, text, textX, textY, alignRight ? 'right' : 'left', tokens.colors.value)
              }
              ctx.restore()
            }
            ctx.textAlign = 'left'
            return
          }
          const previousFont = ctx.font
          ctx.font = `${tokens.multilineText.fontSize}px ${tokens.fontFamily}`
          const placeholder = style['placeholder'] === true
          if (placeholder) {
            ctx.fillStyle = tokens.colors.label
            ctx.font = `italic ${ctx.font}`
          }
          const multilineAvailableWidth = Math.max(0, zoneWidth - multilinePadding * 2)
          // Native schemas carry the input label separately from WidgetSpec;
          // use it when the placeholder-marked view has no display_name.
          const texts = wrapText(ctx, placeholder && run === '' ? row.label : run, multilineAvailableWidth)
          const firstVisualRow = ty + multilineExtraRows
          multilineExtraRows += texts.length - 1
          multilineVisualRows = Math.max(multilineVisualRows, firstVisualRow + texts.length)
          for (const [index, text] of texts.entries()) {
            const visualRow = firstVisualRow + index
            const lineTop = multilineTop + multilinePadding + visualRow * multilineHeight
            const lineBottom = lineTop + multilineHeight
            const clipTop = Math.max(multilineTop + multilinePadding, lineTop)
            const clipBottom = Math.min(multilineBottom - multilinePadding, lineBottom)
            if (clipBottom <= clipTop) continue
            ctx.save()
            ctx.beginPath()
            ctx.rect(alignRight ? zoneRight - zoneWidth : px + reserveLeft, clipTop, zoneWidth, clipBottom - clipTop)
            ctx.clip()
            const textX = alignRight ? zoneRight - multilinePadding : px + reserveLeft + multilinePadding
            const textY = lineTop + multilineHeight / 2
            ctx.fillText(text, textX, textY)
            const role = style['role']
            if (args.connected && (role === undefined || role === 'widgetValue')) {
              paintStaleValueStrikethrough(ctx, text, textX, textY, alignRight ? 'right' : 'left', tokens.colors.value)
            }
            ctx.restore()
          }
          ctx.font = previousFont
          ctx.textAlign = 'left'
        },
        hitRegion: () => {
        },
      },
      resolved,
      row.spec,
      { focused: false, connected: args.connected, readonly: true },
    )
    if (declaredSlider) paintLabel()
    const visibleHeight = Math.max(0, multilineBottom - multilineTop - multilinePadding * 2)
    const contentHeight = multilineVisualRows * multilineHeight
    if (multiline && args.hovered && contentHeight > visibleHeight) {
      const scrollbarWidth = tokens.multilineText.scrollbarWidth
      const trackHeight = Math.max(0, multilineBottom - multilineTop)
      const thumbHeight = Math.min(
        trackHeight,
        Math.max(scrollbarWidth * 2, trackHeight * visibleHeight / contentHeight),
      )
      const scrollbarX = x + width - tokens.multilineText.scrollbarInset - scrollbarWidth
      ctx.fillStyle = tokens.colors.canvasBackground
      ctx.beginPath()
      ctx.roundRect(scrollbarX, multilineTop, scrollbarWidth, trackHeight, scrollbarWidth / 2)
      ctx.fill()
      ctx.fillStyle = tokens.colors.widgetAffordance
      ctx.beginPath()
      ctx.roundRect(scrollbarX, multilineTop, scrollbarWidth, thumbHeight, scrollbarWidth / 2)
      ctx.fill()
    }
  }
}
