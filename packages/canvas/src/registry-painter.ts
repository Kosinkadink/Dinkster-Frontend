/**
 * Registry-backed WidgetPainter: routes widget rows through WidgetView
 * drawCompact via a SceneBuilder -> Canvas2D adapter, falling back to the
 * default painter for unknown kinds/views.
 *
 * SceneBuilder coordinate convention: x/w are fractions of the row
 * content width (0..1); y/h are row units. Views stay resolution- and
 * layout-independent; the adapter owns pixels.
 */

import { formatWidgetValue, t as translate, type Json, type WidgetRegistry, type WidgetSpec, type WidgetView } from '@dinkster/core'
import { controllerChipRect, controllerChipTextRight, EDGE_ACTION_GLYPH_HALF, edgeActionCenterX, widgetFieldBounds } from './controller-chip.js'
import { widgetChromeRect } from './layout.js'
import { companionWords, defaultWidgetPainter, drawsPassedValueAsEditor, fitItems, paintCompanionValue, PARKED_EDITOR_VIEWS, paintStaleValueStrikethrough, paintValueSwatch, type CompanionSummary, type WidgetPaintArgs, type WidgetPainter } from './renderer.js'
import type { DesignTokens } from './tokens.js'
import { fitText, measureWidth, shareRowWidth, wrapText } from './text-fit.js'
import { canvasPaintTokens } from './tokens.js'
import { paintSeedModeIcon, paintToolboxIcon } from './icons.js'
import type { ToolboxButton } from './toolbox.js'

const paint = canvasPaintTokens.widget
/** The word before the value of a row that stays only for the wire on its output. */
const KEPT_WORD = 'inactive'
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

const readOnlyReserve = (row: WidgetRow): number =>
  row.readOnly ? paint.readOnlyMark.size + paint.readOnlyMark.gap : 0

/** Space before the name for the lock and current boundary mark. */
const labelMarkReserve = (row: WidgetRow): number =>
  readOnlyReserve(row) + (row.subgraphMark === undefined ? 0 : paint.subgraphMark.size + paint.subgraphMark.gap)

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
  display?: Pick<WidgetPaintArgs, 'value' | 'connected' | 'companion'>,
): { readonly x: number; readonly y: number; readonly size: number } {
  const geometry = tokens.rowGeometry
  const size = paint.subgraphMark.size
  if (companion) {
    const field = widgetFieldBounds(width, rowHeight, numeric, row.controllerMode !== undefined, geometry)
    return { x: readOnlyReserve(row) + field.left + (numeric ? geometry.stepperLabelInset : paint.labelInset), y: (rowHeight - size) / 2, size }
  }
  const opener = openerIconOf(row, tokens)
  const multiline = row.viewId === 'core.text'
  const curve = tokens.widgetRowLook === 'raised-editors' && row.viewId === 'core.curve' && !row.unfolded
  const chrome = widgetChromeRect(0, 0, width, row.height, geometry.fieldInsetY)
  const sketchShift = curve
    ? paint.curve.inset + Math.max(0, chrome.height - paint.curve.inset * 2) + paint.curve.gap - paint.opener.iconInset
    : 0
  const value = display?.companion === undefined ? display?.value : display.companion.value
  const joined = !display?.connected || value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value))
  const center = curve ? chrome.y + chrome.height / 2 - (joined ? paint.curve.lineStep / 2 : 0) : rowHeight / 2
  const leftControl = multiline ? 0 : opener !== undefined ? sketchShift + paint.opener.iconReserve : numeric ? geometry.stepperZone : 0
  return {
    x: readOnlyReserve(row) + leftControl + (numeric && opener === undefined ? geometry.stepperLabelInset : paint.labelInset),
    y: multiline ? geometry.fieldInsetY + (tokens.multilineText.labelHeight - size) / 2 : center - size / 2,
    size,
  }
}

function paintLabelMarks(args: WidgetPaintArgs, companion: boolean, numeric: boolean): void {
  const { ctx, row, x, y, width, rowHeight, tokens } = args
  const rect = subgraphMarkRect(row, width, rowHeight, tokens, companion, numeric, args)
  if (row.readOnly) {
    paintToolboxIcon(ctx, 'lock', x + rect.x - readOnlyReserve(row), y + rect.y, paint.readOnlyMark.size, tokens.colors.label)
  }
  if (row.subgraphMark === undefined) return
  const alpha = ctx.globalAlpha
  // The mark keeps its full color on a dimmed (driven) row.
  if (args.markAlpha !== undefined) ctx.globalAlpha = args.markAlpha
  paintToolboxIcon(ctx, 'subgraph', x + rect.x, y + rect.y, rect.size, tokens.colors.subgraphMark)
  ctx.globalAlpha = alpha
}

/** Measured ASCII ellipsis shared by every registry-backed compact view.
 * Cached: see text-fit.ts (memoized measure + binary-search truncation). */
export const ellipsize = fitText

export function createRegistryPainter(registry: WidgetRegistry): WidgetPainter {
  const painter: WidgetPainter = (args) => {
    const { ctx, row, value, x, y, width, rowHeight, tokens } = args
    const view = registry.viewsFor(row.spec.widgetType).find((v) => v.id === row.viewId)
    const kind = registry.kind(row.spec.widgetType)
    if (!view || !kind) {
      defaultWidgetPainter(args)
      return
    }
    if (args.companion !== undefined && drawsPassedValueAsEditor(row, args.companion, tokens)) {
      // An editor shown in the node draws a value its wire brings before a run
      // as it draws what a run brought: its own view of that value, muted.
      const { companion, companionAlpha: _alpha, ...wired } = args
      painter({ ...wired, value: companion.value, editorSummary: args.editorSummary ?? { value: companion.value } })
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
      const words = companionWords(args.companion)
      const summary = words === undefined && tokens.widgetRowLook === 'raised-editors'
        ? compactSummary(view, args.companion.value, row.spec)
        : undefined
      const formatted = words ?? summary?.text ?? formatWidgetValue(args.companion.value, row.spec)
      const numeric = (row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT') && row.viewId !== 'core.integerColor'
      const field = widgetFieldBounds(width, rowHeight, numeric, words === undefined && row.controllerMode !== undefined, tokens.rowGeometry)
      const lead = labelMarkReserve(row)
      const companionZone = shareRowWidth(field.right - field.left, lead + measureWidth(ctx, row.label) + paint.labelWidthPadding, measureWidth(ctx, formatted) + paint.labelWidthPadding)
      ctx.fillText(fitText(ctx, row.label, Math.max(0, companionZone - lead - paint.labelClipPadding)), x + field.left + lead + (numeric ? tokens.rowGeometry.stepperLabelInset : paint.labelInset), y + rowHeight / 2)
      paintLabelMarks(args, true, numeric)
      paintCompanionValue(args, summary)
      return
    }
    // A field with nothing stored that declares automatic shows the value it
    // has in use, after the word "auto". A kept row shows its own word before
    // its value instead, and then no "auto".
    const automatic = value === undefined ? row.automatic : undefined
    const resolved: Json = value !== undefined ? value : automatic !== undefined ? automatic.value : (kind.defaultValue(row.spec) as Json)
    // The same word as the open field's mark, in the current language.
    const valueWord = row.kept !== undefined ? KEPT_WORD : automatic !== undefined ? translate('automaticField.auto') : undefined
    const automaticDot = row.kept === undefined && automatic?.state === 'default' ? paint.automaticDot.radius * 2 + paint.automaticDot.gap : 0
    const wordReserve = valueWord === undefined ? 0 : measureWidth(ctx, valueWord) + paint.valueWordGap + automaticDot
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
    // Folded, the raised look draws a curve as a square of its plot at the row's start, before the name.
    const sketchSize = Math.max(0, chrome.height - paint.curve.inset * 2)
    const sketch = rowsRaisedForEditors && row.viewId === 'core.curve' && !row.unfolded
      ? { x: chrome.x + paint.curve.inset, y: chrome.y + paint.curve.inset, size: sketchSize }
      : undefined
    const sketchShift = sketch === undefined ? 0 : sketch.x + sketch.size + paint.curve.gap - x - paint.opener.iconInset
    // Beside the square the name and how the points are joined read as one block, centred on the row;
    // a wired curve not known yet has no joining word, so its name is centred alone.
    const sketchJoined = sketch !== undefined && !(args.connected && (resolved === null || typeof resolved !== 'object' || Array.isArray(resolved)))
    const nameY = sketch === undefined ? y + rowHeight / 2
      : chrome.y + chrome.height / 2 - (sketchJoined ? paint.curve.lineStep / 2 : 0)
    if (openerIcon !== undefined) {
      ctx.fillStyle = tokens.colors.widgetRaised
      ctx.strokeStyle = tokens.colors.nodeIdleOutline
      ctx.lineWidth = paint.opener.stroke
      ctx.beginPath()
      // Unfolded, the row is the header of one box with the editor's space:
      // the space draws the outline around both, so the row has none.
      ctx.roundRect(chrome.x + paint.opener.strokeInset, chrome.y + paint.opener.strokeInset,
        chrome.width - paint.opener.stroke, chrome.height - paint.opener.stroke,
        row.unfolded ? [chrome.radius, chrome.radius, 0, 0] : chrome.radius)
      ctx.fill()
      if (!row.unfolded) ctx.stroke()
      paintToolboxIcon(ctx, openerIcon, x + sketchShift + paint.opener.iconInset,
        nameY - paint.opener.iconSize / 2, paint.opener.iconSize, tokens.colors.value)
      // An editor shown in the node points down while it is unfolded under this row.
      if (!row.readOnly && !row.disabled) {
        paintToolboxIcon(ctx, row.unfolded ? 'chevron-down' : 'chevron-right', x + width - paint.opener.trailingInset - paint.opener.iconSize,
          (sketch === undefined ? y + rowHeight / 2 : chrome.y + chrome.height / 2) - paint.opener.iconSize / 2, paint.opener.iconSize, tokens.colors.label)
      }
    }
    const geometry = tokens.rowGeometry
    // The name sits as far from the opener icon as a row's mode icon from its label.
    const leftControl = openerIcon === undefined ? (numeric ? geometry.stepperZone : 0) : sketchShift + paint.opener.iconReserve
    const combo = (row.viewId === 'core.select' && row.spec.widgetType === 'COMBO')
      || (rowsRaisedForEditors && row.viewId === 'core.mount')
    const rightControl = openerIcon !== undefined ? paint.opener.trailingReserve : numeric || combo ? geometry.stepperZone : geometry.textEndInset
    const usableWidth = Math.max(0, width - leftControl - rightControl)
    const lead = labelMarkReserve(row)
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
    const valuePreview = args.editorSummary?.text !== undefined
      ? args.editorSummary.text
      : assetSummary !== undefined
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
        : measureWidth(ctx, valuePreview.split('\n')[0] ?? '') + paint.valueWidthPadding + wordReserve
        + (row.viewId === 'core.color' ? paint.swatchReserve : 0)
        + (args.editorSummary?.thumbnail !== undefined && !row.unfolded ? paint.valueThumbnail.size + paint.valueThumbnail.gap : 0)
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
    // An empty row that opens an editor keeps its label whole while it fits;
    // what it asks for ("Choose image", "No clip") takes what is left and is
    // cut first.
    const emptyRow = (args.editorSummary?.placeholder ?? (RAISED_ROW_ICONS[row.viewId] === undefined
      ? undefined
      : (assetSummary ?? compactSummary(view, resolved, row.spec))?.placeholder)) === true
    const labelWidth = multiline
      ? 0
      : emptyRow
        ? Math.min(naturalLabelWidth, Math.max(0, fieldWidth - modeIconReserve))
        : shareRowWidth(fieldWidth - modeIconReserve, naturalLabelWidth, naturalValueWidth, true)
    const paintLabel = () => {
      ctx.fillStyle = tokens.colors.label
      ctx.textAlign = 'left'
      ctx.fillText(
        ellipsize(ctx, row.label, Math.max(0, (multiline ? width : labelWidth) - lead - paint.labelClipPadding)),
        x + lead + (multiline ? 0 : leftControl) + (numeric && openerIcon === undefined ? geometry.stepperLabelInset : paint.labelInset),
        multiline ? chrome.y + multilineLabelHeight / 2 : nameY,
      )
      paintLabelMarks({ ...args, value: resolved }, false, numeric)
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

    // The width of a folded curve's count, which the line under its name stops before.
    let sketchValueWidth = 0
    let multilineExtraRows = 0
    let multilineVisualRows = 0
    view.drawCompact(
      {
        rect: (rx, ry, rw, rh, style) => {
          if (style['role'] === 'widgetBackground') return // chrome already drawn
          if (style['role'] === 'numericRangeFill') {
            if (!declaredSlider || row.disabled) return
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
            ctx.fillStyle = checked && !row.disabled
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
            if (row.readOnly || row.disabled) return
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
          if (style['role'] === 'curveSketch') {
            if (sketch !== undefined) paintCurveSketch(ctx, sketch, style, tokens)
            return
          }
          if (style['role'] === 'curveSample') {
            // The unfolded curve is drawn large under its row, and the raised look folds it into its square.
            if (row.unfolded || rowsRaisedForEditors) return
            ctx.fillStyle = tokens.colors.widgetAffordanceActive
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
        text: (tx, ty, viewRun, viewStyle) => {
          if (viewStyle['role'] === 'curveJoin') {
            // How a folded curve's points are joined, under its opener icon and name.
            if (sketch === undefined) return
            const joinLeft = sketchShift + paint.opener.iconInset
            ctx.fillStyle = tokens.colors.valueMark
            ctx.textAlign = 'left'
            ctx.fillText(ellipsize(ctx, viewRun, Math.max(0, valueRight - joinLeft - sketchValueWidth - paint.labelValueGap)),
              x + joinLeft, nameY + paint.curve.lineStep)
            return
          }
          const summary = viewStyle['role'] === 'widgetValue' ? args.editorSummary : undefined
          const run = summary?.text ?? viewRun
          const style = summary === undefined ? viewStyle : { ...viewStyle, placeholder: summary.placeholder === true }
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
            const marked = valueWord !== undefined && (role === undefined || role === 'widgetValue')
            const swatch = typeof style['swatch'] === 'string' && alignRight ? style['swatch'] : undefined
            const items = stringList(style['items'])
            // Unfolded, the editor shows the picture itself, so the row drops its small copy.
            const thumbnail = alignRight && !row.unfolded ? summary?.thumbnail : undefined
            const markReserve = (modeIcon !== undefined && role === 'widgetValue' && alignRight ? modeIconReserve : 0)
              + (swatch !== undefined ? paint.valueSwatch.size + paint.valueSwatch.gap : 0)
              + (thumbnail !== undefined ? paint.valueThumbnail.size + paint.valueThumbnail.gap : 0)
            const iconReserve = markReserve + (marked ? wordReserve : 0)
            const fitWidth = Math.max(0, availableWidth - iconReserve)
            const line = run.split('\n')[0] ?? ''
            const fitted = items !== undefined ? fitItems(ctx, items, fitWidth) : ellipsize(ctx, line, fitWidth)
            // An empty text cut to fewer than three letters before its
            // ellipsis is not drawn at all.
            const text = items === undefined && style['placeholder'] === true && fitted !== line
              && fitted.slice(0, -'...'.length).replace(/\s/g, '').length < 3 ? '' : fitted
            // A folded curve's count sits beside its square, in the middle of the row.
            const centered = sketch !== undefined && style['role'] === 'widgetValue'
            const lineTop = centered ? chrome.y : y + ty * rowHeight + geometry.fieldInsetY
            const lineBottom = centered ? chrome.y + chrome.height : y + (ty + 1) * rowHeight - geometry.fieldInsetY
            const clipTop = Math.max(y, lineTop)
            const clipBottom = Math.min(y + row.height, lineBottom)
            if (clipBottom > clipTop) {
              ctx.save()
              const placeholder = style['placeholder'] === true
              // A dragged plain number shows its moving value in the accent; a slider shows its fill instead.
              const draggedValue = inRow && args.dragging === true && !declaredSlider && role === 'widgetValue'
              // A value with a word before it ("auto", or a kept row's word) is dimmed with its word, as a placeholder is.
              ctx.fillStyle = placeholder ? tokens.colors.label : draggedValue ? tokens.colors.widgetAffordanceActive
                : marked ? tokens.colors.label : tokens.colors.value
              if (placeholder) ctx.font = `italic ${ctx.font}`
              ctx.beginPath()
              ctx.rect(alignRight ? zoneRight - zoneWidth : px + reserveLeft, clipTop, zoneWidth, clipBottom - clipTop)
              ctx.clip()
              const before = marked ? wordReserve : 0
              const textX = alignRight ? zoneRight - TEXT_PAD : px + reserveLeft + TEXT_PAD + before
              const textY = centered ? chrome.y + chrome.height / 2 : y + (ty + 0.5) * rowHeight
              if (!(alignRight && paintValueParts(ctx, style['parts'], textX, textY, fitWidth, tokens))) ctx.fillText(text, textX, textY)
              if (centered) sketchValueWidth = measureWidth(ctx, text) + TEXT_PAD * 2
              if (modeIcon !== undefined && role === 'widgetValue' && alignRight) {
                // Marks about a value come before it, so values line up at the right.
                paintSeedModeIcon(ctx, modeIcon, textX - measureWidth(ctx, text) - paint.modeIconGap - modeIconSize,
                  textY - modeIconSize / 2, modeIconSize, tokens.colors.valueMark)
              }
              if (thumbnail !== undefined) {
                const { size, radius, gap } = paint.valueThumbnail
                const left = Math.round(textX - measureWidth(ctx, text) - gap - size)
                const top = Math.round(textY - size / 2)
                ctx.save()
                ctx.beginPath()
                ctx.roundRect(left, top, size, size, radius)
                ctx.clip()
                ctx.drawImage(thumbnail, left, top, size, size)
                ctx.restore()
              }
              if (swatch !== undefined) {
                paintValueSwatch(ctx, swatch, textX - measureWidth(ctx, text) - paint.valueSwatch.gap - paint.valueSwatch.size,
                  textY - paint.valueSwatch.size / 2, tokens)
              }
              if (marked) {
                // Marks about a value come before it, so values line up at the right.
                const wordRight = alignRight ? textX - measureWidth(ctx, text) - markReserve - paint.valueWordGap : textX - paint.valueWordGap
                ctx.textAlign = 'right'
                ctx.fillStyle = tokens.colors.label
                ctx.fillText(valueWord!, wordRight, textY)
                if (automaticDot > 0) {
                  const radius = paint.automaticDot.radius
                  ctx.fillStyle = tokens.colors.warningMark
                  ctx.beginPath()
                  ctx.arc(wordRight - measureWidth(ctx, valueWord!) - paint.automaticDot.gap - radius, textY, radius, 0, Math.PI * 2)
                  ctx.fill()
                }
              }
              // A host's editor summary is what the editor shows, an arriving value included, so it is never struck.
              if (args.connected && summary === undefined && (role === undefined || role === 'widgetValue')) {
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
      { focused: false, connected: args.connected, readonly: true, ...(args.facts === undefined ? {} : { hostFacts: args.facts }) },
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
  return painter
}

/**
 * A folded curve's square: the unfolded plot in small, with its frame, the
 * "no change" diagonal, the curve (held ends muted) and its points.
 */
function paintCurveSketch(
  ctx: CanvasRenderingContext2D,
  square: { readonly x: number; readonly y: number; readonly size: number },
  style: Readonly<Record<string, unknown>>,
  tokens: DesignTokens,
): void {
  const paint = canvasPaintTokens.widget.curve
  const numbers = (value: unknown): number[] => Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : []
  const samples = numbers(style['samples'])
  const held = numbers(style['held'])
  const points = Array.isArray(style['points']) ? style['points'].map(numbers).filter((point) => point.length === 2) : []
  const left = square.x + paint.plotInset
  const top = square.y + paint.plotInset
  const span = Math.max(0, square.size - paint.plotInset * 2)
  const at = (position: number, value: number) => ({ x: left + position * span, y: top + (1 - value) * span })
  ctx.save()
  ctx.fillStyle = tokens.colors.widgetBackground
  ctx.fillRect(square.x, square.y, square.size, square.size)
  ctx.strokeStyle = tokens.colors.nodeIdleOutline
  ctx.lineWidth = paint.edge
  ctx.strokeRect(square.x + paint.edge / 2, square.y + paint.edge / 2, square.size - paint.edge, square.size - paint.edge)
  ctx.strokeStyle = tokens.colors.valueMark
  ctx.setLineDash([...paint.dash])
  // The identity line, from the plot's lower left to its upper right.
  ctx.beginPath()
  ctx.moveTo(left, top + span)
  ctx.lineTo(left + span, top)
  ctx.stroke()
  ctx.setLineDash([])
  if (samples.length > 1) {
    const line = new Path2D()
    samples.forEach((sample, index) => {
      const point = at(index / (samples.length - 1), sample)
      if (index === 0) line.moveTo(point.x, point.y)
      else line.lineTo(point.x, point.y)
    })
    ctx.lineWidth = paint.lineWidth
    ctx.lineJoin = 'round'
    // Before the first point and after the last the curve holds that point's value, drawn muted.
    const first = held.length === 2 ? at(held[0]!, 0).x : left
    const last = held.length === 2 ? at(held[1]!, 0).x : left + span
    for (const [from, to, color] of [
      [square.x, first, tokens.colors.valueMark],
      [first, last, tokens.colors.widgetAffordanceActive],
      [last, square.x + square.size, tokens.colors.valueMark],
    ] as const) {
      if (to <= from) continue
      ctx.save()
      ctx.beginPath()
      ctx.rect(from, square.y, to - from, square.size)
      ctx.clip()
      ctx.strokeStyle = color
      ctx.stroke(line)
      ctx.restore()
    }
  }
  // Small solid dots on the line, so close points still read apart and hide little of it.
  ctx.fillStyle = tokens.colors.widgetAffordanceActive
  for (const [position, value] of points) {
    const point = at(position!, value!)
    ctx.beginPath()
    ctx.arc(point.x, point.y, paint.pointRadius, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/**
 * One piece of a value drawn in its own look, such as a save target's
 * mounts: 'resolved' is a value the host worked out, drawn in italics;
 * 'gone' is a stored value this machine lacks, struck through.
 */
interface ValuePart {
  readonly text: string
  readonly look?: 'resolved' | 'gone'
}

const valueParts = (value: unknown): readonly ValuePart[] | undefined =>
  Array.isArray(value) && value.length > 0 && value.every((part) =>
    typeof part === 'object' && part !== null && typeof (part as ValuePart).text === 'string'
    && ((part as ValuePart).look === undefined || (part as ValuePart).look === 'resolved' || (part as ValuePart).look === 'gone'))
    ? value as readonly ValuePart[]
    : undefined

/**
 * Draws a value style's `parts` right-aligned at `right`, each in its look,
 * within `fitWidth`, cutting a plain last part with an ellipsis when needed.
 * Returns false, drawing nothing, when there are no parts or they do not
 * fit that way, so the caller draws the plain text.
 */
function paintValueParts(
  ctx: CanvasRenderingContext2D,
  style: unknown,
  right: number,
  y: number,
  fitWidth: number,
  tokens: DesignTokens,
): boolean {
  const parts = valueParts(style)
  if (parts === undefined) return false
  const baseFont = ctx.font
  const valueColor = ctx.fillStyle
  const fontOf = (part: ValuePart): string => (part.look === 'resolved' ? `italic ${baseFont}` : baseFont)
  const gap = measureWidth(ctx, ' ')
  const widths = parts.map((part) => {
    ctx.font = fontOf(part)
    return measureWidth(ctx, part.text)
  })
  ctx.font = baseFont
  const total = widths.reduce((sum, width) => sum + width, 0) + parts.filter((part) => part.look === 'gone').length * gap
  const last = parts.length - 1
  let tail = parts[last]!.text
  if (total > fitWidth) {
    // Only a plain last part is cut, and only while some of it stays.
    if (parts[last]!.look !== undefined) return false
    tail = fitText(ctx, tail, fitWidth - (total - widths[last]!))
    if (tail.length <= 3) return false
    widths[last] = measureWidth(ctx, tail)
  }
  let x = right
  for (let index = last; index >= 0; index--) {
    const part = parts[index]!
    if (part.look === 'gone') x -= gap
    ctx.font = fontOf(part)
    ctx.fillStyle = part.look === 'gone' ? tokens.colors.label : valueColor
    ctx.fillText(index === last ? tail : part.text, x, y)
    if (part.look === 'gone') paintStaleValueStrikethrough(ctx, part.text, x, y, 'right', tokens.colors.label)
    x -= widths[index]!
  }
  ctx.font = baseFont
  ctx.fillStyle = valueColor
  return true
}
