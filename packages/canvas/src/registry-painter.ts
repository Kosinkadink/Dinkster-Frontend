/**
 * Registry-backed WidgetPainter: routes widget rows through WidgetView
 * drawCompact via a SceneBuilder -> Canvas2D adapter, falling back to the
 * default painter for unknown kinds/views.
 *
 * SceneBuilder coordinate convention: x/w are fractions of the row
 * content width (0..1); y/h are row units. Views stay resolution- and
 * layout-independent; the adapter owns pixels.
 */

import { formatWidgetValue, type Json, type WidgetRegistry, type WidgetSpec, type WidgetView } from '@dinkster/core'
import { controllerChipRect, controllerChipTextRight, EDGE_ACTION_GLYPH_HALF, edgeActionCenterX, widgetFieldBounds } from './controller-chip.js'
import { widgetChromeRect } from './layout.js'
import { defaultWidgetPainter, fitItems, paintCompanionValue, PARKED_EDITOR_VIEWS, paintStaleValueStrikethrough, paintSwatchRow, paintValueSwatch, type CompanionSummary, type WidgetPaintArgs, type WidgetPainter } from './renderer.js'
import type { DesignTokens } from './tokens.js'
import { fitText, measureWidth, shareRowWidth, wrapText } from './text-fit.js'
import { canvasPaintTokens } from './tokens.js'
import { paintSeedModeIcon, paintToolboxIcon } from './icons.js'
import type { ToolboxButton } from './toolbox.js'

const paint = canvasPaintTokens.widget
/** The word before an automatic value. */
const AUTOMATIC_WORD = 'auto'
const TEXT_PAD = paint.textPadding

function compactBooleanValue(value: Json, options: Readonly<Record<string, unknown>>): string {
  const custom = options[value === true ? 'labelOn' : 'labelOff']
  return typeof custom === 'string' && custom !== '' ? custom : String(value)
}

const stringList = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined

/** A row's value text, whether it is the row's empty-state message, and any color square before it. */
interface RowSummary extends CompanionSummary {
  readonly placeholder: boolean
}

/**
 * The value text a view draws for `value` on its own row, so a value passed
 * down a wire reads the same as a stored one. Undefined when the view draws
 * no value text or cannot draw this value.
 */
function compactSummary(view: WidgetView, value: Json, spec: WidgetSpec): RowSummary | undefined {
  let summary: RowSummary | undefined
  try {
    view.drawCompact({
      rect: () => {},
      text: (_x, _y, run, style) => {
        if (summary !== undefined || style['role'] !== 'widgetValue') return
        const text = run.split('\n')[0] ?? ''
        summary = {
          text,
          placeholder: style['placeholder'] === true,
          ...(typeof style['swatch'] === 'string' ? { swatch: style['swatch'] } : {}),
          ...(stringList(style['items']) !== undefined ? { items: stringList(style['items'])! } : {}),
          ...(stringList(style['swatches']) !== undefined ? { swatches: stringList(style['swatches'])! } : {}),
        }
      },
      hitRegion: () => {},
    }, value, spec, { focused: false, connected: false, readonly: true })
  } catch {
    return undefined
  }
  return summary
}

/** Kind icon of each row that opens an editor, raised in the `raised-editors` look. */
const RAISED_ROW_ICONS: Readonly<Record<string, NonNullable<ToolboxButton['icon']>>> = {
  'core.asset': 'image',
  'core.audioRecord': 'mic',
  'core.webcam': 'camera',
  'core.load3d': 'box',
  'core.boundingBox': 'crop',
  'core.imageCompare': 'columns-2',
  'core.saveTarget': 'folder-output',
  'core.videoEdit': 'film',
  'core.list': 'list',
  'core.colors': 'palette',
  'core.curve': 'spline',
  'core.cameraAngle': 'rotate-3d',
  'core.compositor': 'layers',
  'core.resolution': 'ruler',
}

type WidgetRow = WidgetPaintArgs['row']

/** The icon a raised opener row shows before its name, if any. */
function openerIconOf(row: WidgetRow, tokens: DesignTokens): NonNullable<ToolboxButton['icon']> | undefined {
  return tokens.widgetRowLook === 'raised-editors'
    ? PARKED_EDITOR_VIEWS.has(row.viewId) ? undefined : RAISED_ROW_ICONS[row.viewId]
    : row.viewId === 'core.asset' ? 'image'
      : row.viewId === 'core.color' || row.viewId === 'core.integerColor' ? 'palette'
      : undefined
}

/** Space a field's name gives up to the subgraph mark before it. */
const subgraphMarkReserve = (row: WidgetRow): number =>
  row.subgraphMark === undefined ? 0 : paint.subgraphMark.size + paint.subgraphMark.gap

/**
 * Row-local square of the cyan subgraph icon before the name of a field
 * shown on the subgraph node without a wire. Shared by painting and pointer
 * hit testing; `companion` is whether the row shows a value arriving by wire,
 * `numeric` whether it is a number row with steppers.
 */
export function subgraphMarkRect(
  row: WidgetRow,
  width: number,
  rowHeight: number,
  tokens: DesignTokens,
  companion: boolean,
  numeric: boolean,
): { readonly x: number; readonly y: number; readonly size: number } {
  const geometry = tokens.rowGeometry
  const size = paint.subgraphMark.size
  if (companion) {
    const field = widgetFieldBounds(width, rowHeight, numeric, row.controllerMode !== undefined, geometry)
    return { x: field.left + (numeric ? geometry.stepperLabelInset : paint.labelInset), y: (rowHeight - size) / 2, size }
  }
  const opener = openerIconOf(row, tokens)
  const multiline = row.viewId === 'core.text'
  const leftControl = multiline ? 0 : opener !== undefined ? paint.opener.iconReserve : numeric ? geometry.stepperZone : 0
  return {
    x: leftControl + (numeric && opener === undefined ? geometry.stepperLabelInset : paint.labelInset),
    y: multiline ? geometry.fieldInsetY + (tokens.multilineText.labelHeight - size) / 2 : (rowHeight - size) / 2,
    size,
  }
}

function paintSubgraphMark(args: WidgetPaintArgs, companion: boolean, numeric: boolean): void {
  const { ctx, row, x, y, width, rowHeight, tokens } = args
  if (row.subgraphMark === undefined) return
  const rect = subgraphMarkRect(row, width, rowHeight, tokens, companion, numeric)
  const alpha = ctx.globalAlpha
  // The mark keeps its full color on a dimmed (driven) row.
  if (args.markAlpha !== undefined) ctx.globalAlpha = args.markAlpha
  paintToolboxIcon(ctx, 'boxes', x + rect.x, y + rect.y, rect.size, tokens.colors.subgraphMark)
  ctx.globalAlpha = alpha
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
      if (row.viewId !== 'core.compositor') {
        ctx.fillStyle = tokens.colors.widgetBackground
        ctx.beginPath()
        ctx.roundRect(chrome.x, chrome.y, chrome.width, chrome.height, chrome.radius)
        ctx.fill()
      }
      ctx.fillStyle = tokens.colors.label
      ctx.textAlign = 'left'
      const summary = tokens.widgetRowLook === 'raised-editors'
        ? compactSummary(view, args.companion.value, row.spec)
        : undefined
      const formatted = summary?.text ?? formatWidgetValue(args.companion.value, row.spec)
      const numeric = (row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT') && row.viewId !== 'core.integerColor'
      const field = widgetFieldBounds(width, rowHeight, numeric, row.controllerMode !== undefined, tokens.rowGeometry)
      const lead = subgraphMarkReserve(row)
      const companionZone = shareRowWidth(field.right - field.left, lead + measureWidth(ctx, row.label) + paint.labelWidthPadding, measureWidth(ctx, formatted) + paint.labelWidthPadding)
      ctx.fillText(fitText(ctx, row.label, Math.max(0, companionZone - lead - paint.labelClipPadding)), x + field.left + lead + (numeric ? tokens.rowGeometry.stepperLabelInset : paint.labelInset), y + rowHeight / 2)
      paintSubgraphMark(args, true, numeric)
      paintCompanionValue(args, summary)
      return
    }
    // A field with nothing stored that declares automatic shows the value it
    // has in use, after the word "auto".
    const automatic = value === undefined ? row.automatic : undefined
    const resolved: Json = value !== undefined ? value : automatic !== undefined ? automatic.value : (kind.defaultValue(row.spec) as Json)
    const automaticDot = automatic?.state === 'default' ? paint.automaticDot.radius * 2 + paint.automaticDot.gap : 0
    const automaticWord = automatic === undefined ? 0 : measureWidth(ctx, AUTOMATIC_WORD) + paint.automaticWordGap
    const automaticReserve = automaticWord + automaticDot
    // Draw the shared row chrome (label) then let the view draw its content.
    const chrome = widgetChromeRect(x, y, width, row.height, tokens.rowGeometry.fieldInsetY)
    if (row.viewId !== 'core.compositor') {
      ctx.fillStyle = tokens.colors.widgetBackground
      ctx.beginPath()
      ctx.roundRect(chrome.x, chrome.y, chrome.width, chrome.height, chrome.radius)
      ctx.fill()
    }
    ctx.fillStyle = tokens.colors.label
    ctx.textAlign = 'left'
    const numeric = (row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT') && row.viewId !== 'core.integerColor'
    const inRow = tokens.widgetEditing === 'in-row'
    // In-row editing draws a number's after-run mode as an icon before its value instead of the chip.
    const modeIcon = inRow && numeric && row.controllerMode !== undefined ? row.controllerMode : undefined
    const rowsRaisedForEditors = tokens.widgetRowLook === 'raised-editors'
    const openerIcon = openerIconOf(row, tokens)
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
      paintToolboxIcon(ctx, 'chevron-right', x + width - paint.opener.trailingInset - paint.opener.iconSize,
        y + (rowHeight - paint.opener.iconSize) / 2, paint.opener.iconSize, tokens.colors.label)
    }
    const geometry = tokens.rowGeometry
    const leftControl = openerIcon !== undefined ? paint.opener.iconReserve : numeric ? geometry.stepperZone : 0
    const combo = (row.viewId === 'core.select' && row.spec.widgetType === 'COMBO')
      || (rowsRaisedForEditors && row.viewId === 'core.mount')
    const rightControl = openerIcon !== undefined ? paint.opener.trailingReserve : numeric || combo ? geometry.stepperZone : geometry.textEndInset
    const usableWidth = Math.max(0, width - leftControl - rightControl)
    const lead = subgraphMarkReserve(row)
    const naturalLabelWidth = lead + measureWidth(ctx, row.label) + paint.labelWidthPadding
    // Deficit-proportional label/value split (text-fit.ts): when both fit,
    // the label takes exactly its natural width; when they do not, each side
    // shrinks in proportion to its natural width with the label biased to
    // give up more, clamped to readability floors. Primitive values expose
    // their natural width; structured values (asset refs, color swatch +
    // hex, ...) keep a conservative reserve because their content need is
    // view-specific.
    const assetSummary = row.viewId === 'core.asset' && row.spec.widgetType === 'ASSET'
      ? compactSummary(view, resolved, row.spec)
      : undefined
    const valuePreview = assetSummary !== undefined
      ? assetSummary.text
      : row.viewId === 'core.toggle' && row.spec.widgetType === 'BOOLEAN'
        ? compactBooleanValue(resolved, row.spec.options)
      : resolved === null || typeof resolved === 'object'
        ? undefined
        : formatWidgetValue(resolved, row.spec)
    const naturalValueWidth = row.viewId === 'core.integerColor'
      ? measureWidth(ctx, '#ffffff') + paint.colorValueReserve
      : valuePreview === undefined
        ? usableWidth * paint.structuredValueRatio
        : measureWidth(ctx, valuePreview.split('\n')[0] ?? '') + paint.valueWidthPadding + automaticReserve
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
    const modeIconReserve = modeIcon === undefined ? 0 : paint.modeIconLead + modeIconSize + paint.modeIconGap
    let labelWidth = multiline
      ? 0
      : shareRowWidth(fieldWidth - modeIconReserve, naturalLabelWidth, naturalValueWidth, true)
    if (assetSummary?.placeholder === true && valuePreview !== undefined) {
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
        ellipsize(ctx, row.label, Math.max(0, (multiline ? width : labelWidth) - lead - paint.labelClipPadding)),
        x + lead + (multiline ? 0 : leftControl) + (numeric && openerIcon === undefined ? geometry.stepperLabelInset : paint.labelInset),
        multiline ? chrome.y + multilineLabelHeight / 2 : y + rowHeight / 2,
      )
      paintSubgraphMark(args, false, numeric)
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
    const multilineTextInset = tokens.multilineText.textInset

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
            if (rowsRaisedForEditors) {
              // The curve fills the row's second line from the row's start,
              // clear of the row's edges and of the summary above it.
              const plotLeft = chrome.x + paint.curve.insetX
              const plotWidth = Math.max(0, chrome.width - paint.curve.insetX * 2)
              const plotTop = y + rowHeight + paint.curve.inset
              const plotHeight = Math.max(0, chrome.y + chrome.height - paint.curve.inset - plotTop)
              ctx.fillRect(plotLeft + rx * plotWidth,
                plotTop + ry / paint.curve.sourceRows * plotHeight,
                Math.min(rw, 1 - rx) * plotWidth,
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
            const role = style['role']
            const marked = automatic !== undefined && (role === undefined || role === 'widgetValue')
            const swatch = typeof style['swatch'] === 'string' && alignRight ? style['swatch'] : undefined
            const items = stringList(style['items'])
            const swatches = alignRight ? stringList(style['swatches']) : undefined
            const markReserve = (modeIcon !== undefined && role === 'widgetValue' && alignRight ? modeIconReserve : 0)
              + (swatch !== undefined ? paint.valueSwatch.size + paint.valueSwatch.gap : 0)
            const iconReserve = markReserve + (marked ? automaticReserve : 0)
            const fitWidth = Math.max(0, availableWidth - iconReserve)
            const text = swatches !== undefined ? ''
              : items !== undefined ? fitItems(ctx, items, fitWidth)
              : ellipsize(ctx, run.split('\n')[0] ?? '', fitWidth)
            const lineTop = y + ty * rowHeight + geometry.fieldInsetY
            const lineBottom = y + (ty + 1) * rowHeight - geometry.fieldInsetY
            const clipTop = Math.max(y, lineTop)
            const clipBottom = Math.min(y + row.height, lineBottom)
            if (clipBottom > clipTop) {
              ctx.save()
              const placeholder = style['placeholder'] === true
              // A dragged plain number shows its moving value in the accent; a slider shows its fill instead.
              const draggedValue = inRow && args.dragging === true && !declaredSlider && role === 'widgetValue'
              // An automatic value and its word are dimmed, as a placeholder is.
              ctx.fillStyle = placeholder ? tokens.colors.label : draggedValue ? tokens.colors.widgetAffordanceActive
                : marked ? tokens.colors.label : tokens.colors.value
              if (placeholder) ctx.font = `italic ${ctx.font}`
              ctx.beginPath()
              ctx.rect(alignRight ? zoneRight - zoneWidth : px + reserveLeft, clipTop, zoneWidth, clipBottom - clipTop)
              ctx.clip()
              const before = marked ? automaticReserve : 0
              const textX = alignRight ? zoneRight - TEXT_PAD : px + reserveLeft + TEXT_PAD + before
              const textY = y + (ty + 0.5) * rowHeight
              ctx.fillText(text, textX, textY)
              if (swatches !== undefined) paintSwatchRow(ctx, swatches, textX, textY, fitWidth, tokens, ctx.fillStyle as string)
              if (modeIcon !== undefined && role === 'widgetValue' && alignRight) {
                // Marks about a value come before it, so values line up at the right.
                paintSeedModeIcon(ctx, modeIcon, textX - measureWidth(ctx, text) - paint.modeIconGap - modeIconSize,
                  textY - modeIconSize / 2, modeIconSize, tokens.colors.valueMark)
              }
              if (swatch !== undefined) {
                paintValueSwatch(ctx, swatch, textX - measureWidth(ctx, text) - paint.valueSwatch.gap - paint.valueSwatch.size,
                  textY - paint.valueSwatch.size / 2, tokens)
              }
              if (marked) {
                // Marks about a value come before it, so values line up at the right.
                const wordRight = alignRight ? textX - measureWidth(ctx, text) - markReserve - paint.automaticWordGap : textX - paint.automaticWordGap
                ctx.textAlign = 'right'
                ctx.fillStyle = tokens.colors.label
                ctx.fillText(AUTOMATIC_WORD, wordRight, textY)
                if (automaticDot > 0) {
                  const radius = paint.automaticDot.radius
                  ctx.fillStyle = tokens.colors.warningMark
                  ctx.beginPath()
                  ctx.arc(wordRight - measureWidth(ctx, AUTOMATIC_WORD) - paint.automaticDot.gap - radius, textY, radius, 0, Math.PI * 2)
                  ctx.fill()
                }
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
          const multilineAvailableWidth = Math.max(0, zoneWidth - multilineTextInset - multilinePadding)
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
            const textX = alignRight ? zoneRight - multilinePadding : px + reserveLeft + multilineTextInset
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
    // Text that does not fit shows the quiet scrollbar; the box never grows to fit.
    if (multiline && contentHeight > visibleHeight) {
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
