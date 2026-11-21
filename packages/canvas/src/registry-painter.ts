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
import { controllerChipRect, controllerChipTextRight, EDGE_ACTION_GLYPH_HALF, edgeActionCenterX, widgetFieldBounds } from './controller-chip.js'
import { widgetChromeRect } from './layout.js'
import { defaultWidgetPainter, paintCompanionValue, paintStaleValueStrikethrough, type WidgetPainter } from './renderer.js'
import { fitText, measureWidth, shareRowWidth, wrapText } from './text-fit.js'
import { canvasPaintTokens } from './tokens.js'
import { paintSeedModeIcon, paintToolboxIcon } from './icons.js'

const paint = canvasPaintTokens.widget
const TEXT_PAD = paint.textPadding

function compactAssetValue(value: Json, valid: boolean): string {
  if (!valid || value === null) return 'no asset'
  if (typeof value === 'string') return value
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
      const chrome = widgetChromeRect(x, y, width, row.height, tokens.rowGeometry.fieldInsetY)
      ctx.fillStyle = tokens.colors.widgetBackground
      ctx.beginPath()
      ctx.roundRect(chrome.x, chrome.y, chrome.width, chrome.height, chrome.radius)
      ctx.fill()
      ctx.fillStyle = tokens.colors.label
      ctx.textAlign = 'left'
      const formatted = formatWidgetValue(args.companion.value, row.spec)
      const numeric = row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT'
      const field = widgetFieldBounds(width, rowHeight, numeric, row.controllerMode !== undefined, tokens.rowGeometry)
      const companionZone = shareRowWidth(field.right - field.left, measureWidth(ctx, row.label) + paint.labelWidthPadding, measureWidth(ctx, formatted) + paint.labelWidthPadding)
      ctx.fillText(fitText(ctx, row.label, Math.max(0, companionZone - paint.labelClipPadding)), x + field.left + (numeric ? tokens.rowGeometry.stepperLabelInset : paint.labelInset), y + rowHeight / 2)
      paintCompanionValue(args)
      return
    }
    const resolved: Json = value !== undefined ? value : (kind.defaultValue(row.spec) as Json)
    // Draw the shared row chrome (label) then let the view draw its content.
    const chrome = widgetChromeRect(x, y, width, row.height, tokens.rowGeometry.fieldInsetY)
    ctx.fillStyle = tokens.colors.widgetBackground
    ctx.beginPath()
    ctx.roundRect(chrome.x, chrome.y, chrome.width, chrome.height, chrome.radius)
    ctx.fill()
    ctx.fillStyle = tokens.colors.label
    ctx.textAlign = 'left'
    const numeric = row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT'
    const inRow = tokens.widgetEditing === 'in-row'
    // In-row editing draws a number's after-run mode as an icon before its value instead of the chip.
    const modeIcon = inRow && numeric && row.controllerMode !== undefined ? row.controllerMode : undefined
    const openerIcon = tokens.widgetRowLook !== 'inset'
      ? row.viewId === 'core.asset' ? 'image'
        : row.viewId === 'core.color' || row.viewId === 'core.integerColor' ? 'palette'
        : tokens.widgetRowLook === 'inset-raised-collections'
          ? row.viewId === 'core.multiSelect' ? 'list-checks'
            : row.viewId === 'core.list' ? 'list'
            : row.viewId === 'core.colors' ? 'palette'
            : row.viewId === 'core.curve' ? 'spline' : undefined
          : undefined
      : undefined
    if (openerIcon !== undefined) {
      ctx.fillStyle = tokens.colors.widgetRaised
      ctx.strokeStyle = tokens.colors.nodeIdleOutline
      ctx.lineWidth = paint.opener.stroke
      ctx.beginPath()
      ctx.roundRect(chrome.x + paint.opener.strokeInset, chrome.y + paint.opener.strokeInset,
        chrome.width - paint.opener.stroke, chrome.height - paint.opener.stroke, chrome.radius)
      ctx.fill()
      ctx.stroke()
      paintToolboxIcon(ctx, openerIcon, x + paint.opener.iconInset,
        y + (rowHeight - paint.opener.iconSize) / 2, paint.opener.iconSize, tokens.colors.value)
      paintToolboxIcon(ctx, 'chevron-right', x + width - paint.opener.trailingReserve,
        y + (rowHeight - paint.opener.iconSize) / 2, paint.opener.iconSize, tokens.colors.label)
    }
    const geometry = tokens.rowGeometry
    const leftControl = openerIcon !== undefined ? paint.opener.iconReserve : numeric ? geometry.stepperZone : 0
    const combo = row.viewId === 'core.select' && row.spec.widgetType === 'COMBO'
    const rightControl = openerIcon !== undefined ? paint.opener.trailingReserve : numeric || combo ? geometry.stepperZone : geometry.textEndInset
    const usableWidth = Math.max(0, width - leftControl - rightControl)
    const naturalLabelWidth = measureWidth(ctx, row.label) + paint.labelWidthPadding
    // Deficit-proportional label/value split (text-fit.ts): when both fit,
    // the label takes exactly its natural width; when they do not, each side
    // shrinks in proportion to its natural width with the label biased to
    // give up more, clamped to readability floors. Primitive values expose
    // their natural width; structured values (asset refs, color swatch +
    // hex, ...) keep a conservative reserve because their content need is
    // view-specific.
    const valuePreview = row.viewId === 'core.asset' && row.spec.widgetType === 'ASSET'
      ? compactAssetValue(resolved, kind.valueSchema.validate(resolved, row.spec))
      : row.viewId === 'core.toggle' && row.spec.widgetType === 'BOOLEAN'
        ? compactBooleanValue(resolved, row.spec.options)
      : resolved === null || typeof resolved === 'object'
        ? undefined
        : formatWidgetValue(resolved, row.spec)
    const naturalValueWidth = row.viewId === 'core.integerColor'
      ? measureWidth(ctx, '#ffffff') + paint.colorValueReserve
      : valuePreview === undefined
        ? usableWidth * paint.structuredValueRatio
        : measureWidth(ctx, valuePreview.split('\n')[0] ?? '') + paint.valueWidthPadding
        + (row.viewId === 'core.color' ? paint.swatchReserve : 0)
        + (row.viewId === 'core.toggle' && row.spec.widgetType === 'BOOLEAN' ? paint.toggleReserve : 0)
    const controller = row.controllerMode !== undefined && modeIcon === undefined
      ? controllerChipRect(width, rowHeight, geometry)
      : undefined
    const valueRight = controller === undefined ? width - rightControl : controllerChipTextRight(width, rowHeight, geometry)
    const fieldWidth = Math.max(0, valueRight - leftControl)
    const multiline = row.viewId === 'core.text'
    const multilineLabelHeight = tokens.multilineText.labelHeight
    const multilineGutter = tokens.multilineText.scrollbarWidth + tokens.multilineText.scrollbarInset
    // The mode icon always shows; the label and value share the rest of the row.
    const modeIconSize = paint.modeIconSize
    const modeIconReserve = modeIcon === undefined ? 0 : modeIconSize + paint.modeIconGap
    let labelWidth = multiline
      ? 0
      : shareRowWidth(fieldWidth - modeIconReserve, naturalLabelWidth, naturalValueWidth, true)
    if (row.viewId === 'core.asset' && valuePreview === 'no asset') {
      // The empty-state message takes priority even when opener controls leave
      // less than the ordinary label floor. Round up for fitText's pixel floor.
      const font = ctx.font
      ctx.font = `italic ${font}`
      const italicWidth = measureWidth(ctx, valuePreview)
      ctx.font = font
      const placeholderWidth = Math.ceil(Math.max(italicWidth, measureWidth(ctx, valuePreview))) + TEXT_PAD * 2
      labelWidth = Math.min(labelWidth, Math.max(0, fieldWidth - placeholderWidth))
    }
    const paintLabel = () => {
      ctx.fillStyle = tokens.colors.label
      ctx.textAlign = 'left'
      ctx.fillText(
        ellipsize(ctx, row.label, Math.max(0, (multiline ? width : labelWidth) - paint.labelClipPadding)),
        x + (multiline ? 0 : leftControl) + (numeric && openerIcon === undefined ? geometry.stepperLabelInset : paint.labelInset),
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
            ctx.fillStyle = inRow ? tokens.colors.widgetRangeFillAccent : tokens.colors.widgetRangeFill
            ctx.fillRect(chrome.x, chrome.y, chrome.width * fraction, chrome.height)
            if (inRow && args.dragging === true) {
              // A bright edge marks the fill while the pointer holds it.
              ctx.fillStyle = tokens.colors.widgetAffordanceActive
              ctx.fillRect(chrome.x + chrome.width * fraction - paint.dragLineStroke, chrome.y, paint.dragLineStroke, chrome.height)
            }
            ctx.restore()
            return
          }
          if (style['role'] === 'toggleAffordance') {
            const checked = style['checked'] === true
            const trackX = contentStart + contentWidth - paint.toggle.trailingInset
            const trackY = y + rowHeight / 2 - paint.toggle.halfHeight
            ctx.fillStyle = checked
              ? tokens.colors.widgetAffordanceActive
              : tokens.colors.widgetAffordance
            ctx.beginPath()
            ctx.roundRect(trackX, trackY, paint.toggle.width, paint.toggle.height, paint.toggle.radius)
            ctx.fill()
            ctx.fillStyle = tokens.colors.value
            ctx.beginPath()
            ctx.roundRect(
              trackX + (checked ? paint.toggle.checkedOffset : paint.toggle.thumbInset),
              trackY + paint.toggle.thumbInset,
              paint.toggle.thumbSize,
              paint.toggle.thumbSize,
              paint.toggle.thumbRadius,
            )
            ctx.fill()
            return
          }
          if (style['role'] === 'comboChevron') {
            const center = x + edgeActionCenterX(width, 'trailing', geometry)
            const middle = y + rowHeight / 2
            ctx.save()
            ctx.strokeStyle = tokens.colors.widgetAffordance
            ctx.lineWidth = paint.chevron.stroke
            ctx.beginPath()
            ctx.moveTo(center - EDGE_ACTION_GLYPH_HALF, middle + paint.chevron.topOffset)
            ctx.lineTo(center, middle + paint.chevron.bottomOffset)
            ctx.lineTo(center + EDGE_ACTION_GLYPH_HALF, middle + paint.chevron.topOffset)
            ctx.stroke()
            ctx.restore()
            return
          }
          if (style['role'] === 'curveSample') {
            ctx.fillStyle = tokens.colors.widgetAffordanceActive
            if (tokens.widgetRowLook === 'inset-raised-collections') {
              // Keep the trace below the summary; field padding erases thin samples.
              const plotHeight = rowHeight - paint.curve.inset * 2
              ctx.fillRect(contentStart + rx * contentWidth,
                y + rowHeight + paint.curve.inset + ry / paint.curve.sourceRows * plotHeight,
                Math.min(rw, 1 - rx) * contentWidth,
                Math.max(paint.curve.minSampleHeight, rh / paint.curve.sourceRows * plotHeight))
              return
            }
          }
          const unitHeight = multiline ? multilineHeight : rowHeight
          const rectTop = multiline
            ? multilineTop + multilinePadding + ry * unitHeight
            : y + ry * unitHeight + geometry.fieldInsetY
          const rectBottom = rectTop + rh * unitHeight - (multiline ? 0 : geometry.fieldInsetY * 2)
          const clipTop = Math.max(multiline ? multilineTop : y, rectTop)
          const clipBottom = Math.min(multiline ? multilineBottom - multilinePadding : y + row.height, rectBottom)
          if (clipBottom <= clipTop) return
          if (style['role'] !== 'curveSample') {
            ctx.fillStyle = String(style['fill'] ?? tokens.colors.widgetBackground)
          }
          const rectHeight = rh * unitHeight - (multiline ? 0 : geometry.fieldInsetY * 2)
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
            const iconReserve = modeIcon !== undefined && style['role'] === 'widgetValue' && alignRight ? modeIconReserve : 0
            const text = ellipsize(ctx, run.split('\n')[0] ?? '', Math.max(0, availableWidth - iconReserve))
            const lineTop = y + ty * rowHeight + geometry.fieldInsetY
            const lineBottom = y + (ty + 1) * rowHeight - geometry.fieldInsetY
            const clipTop = Math.max(y, lineTop)
            const clipBottom = Math.min(y + row.height, lineBottom)
            if (clipBottom > clipTop) {
              ctx.save()
              const placeholder = style['placeholder'] === true
              const role = style['role']
              // A dragged plain number shows its moving value in the accent; a slider shows its fill instead.
              const draggedValue = inRow && args.dragging === true && !declaredSlider && role === 'widgetValue'
              ctx.fillStyle = placeholder ? tokens.colors.label : draggedValue ? tokens.colors.widgetAffordanceActive : tokens.colors.value
              if (placeholder) ctx.font = `italic ${ctx.font}`
              ctx.beginPath()
              ctx.rect(alignRight ? zoneRight - zoneWidth : px + reserveLeft, clipTop, zoneWidth, clipBottom - clipTop)
              ctx.clip()
              const textX = alignRight ? zoneRight - TEXT_PAD : px + reserveLeft + TEXT_PAD
              const textY = y + (ty + 0.5) * rowHeight
              ctx.fillText(text, textX, textY)
              if (modeIcon !== undefined && role === 'widgetValue' && alignRight) {
                // Marks about a value come before it, so values line up at the right.
                paintSeedModeIcon(ctx, modeIcon, textX - measureWidth(ctx, text) - paint.modeIconGap - modeIconSize,
                  textY - modeIconSize / 2, modeIconSize, tokens.colors.label)
              }
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
        Math.max(scrollbarWidth * paint.scrollbarMinThumbRatio, trackHeight * visibleHeight / contentHeight),
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
