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
import { defaultWidgetPainter, drawsPassedValueAsEditor, fitSummary, fitSummaryParts, summaryPartsWidth, summaryThumbnailReserve, paintSummaryParts, paintCompanionValue, PARKED_EDITOR_VIEWS, paintStaleValueStrikethrough, paintValueSwatch, type CompanionSummary, type SummaryFit, type WidgetPaintArgs, type WidgetPainter } from './renderer.js'
import type { DesignTokens } from './tokens.js'
import { fitText, measureWidth, paintCenteredText, shareRowWidth, wrapText } from './text-fit.js'
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

/** A view's value text with what its style lets the painter do when it does not fit. */
function summaryFitOf(run: string, style: Readonly<Record<string, unknown>>): SummaryFit {
  const items = stringList(style['items'])
  const shorter = stringList(style['shorter'])
  return {
    text: run.split('\n')[0] ?? '',
    ...(items !== undefined ? { items } : {}),
    ...(typeof style['suffix'] === 'string' ? { suffix: style['suffix'] } : {}),
    ...(typeof style['count'] === 'string' ? { count: style['count'] } : {}),
    ...(shorter !== undefined ? { shorter } : {}),
  }
}

/** A row's value text, whether it is the row's empty-state message, and any color square before it. */
interface RowSummary extends CompanionSummary {
  readonly placeholder: boolean
  readonly labelFirst: boolean
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
        summary = {
          ...summaryFitOf(run, style),
          placeholder: style['placeholder'] === true,
          labelFirst: style['labelFirst'] === true || style['placeholder'] === true,
          ...(typeof style['swatch'] === 'string' ? { swatch: style['swatch'] } : {}),
        }
      },
      hitRegion: () => {},
    }, value, spec, { focused: false, connected: false, readonly: true })
  } catch {
    return undefined
  }
  return summary
}

/**
 * The whole text a closed row reads for `value`, unfitted, for a place with
 * room such as the side part's value lines. Null when the view names the
 * editor it opens rather than a value; undefined when it draws no value text
 * or cannot draw this value.
 */
export function widgetValueText(registry: WidgetRegistry, viewId: string, value: Json, spec: WidgetSpec): string | null | undefined {
  const view = registry.viewsFor(spec.widgetType).find((candidate) => candidate.id === viewId)
  if (view === undefined) return undefined
  try {
    if (view.readout?.(value, spec).length === 0) return null
  } catch {
    return undefined
  }
  const summary = compactSummary(view, value, spec)
  return summary?.items?.join(', ') || summary?.text || undefined
}

/** Kind icon of each row that opens an editor, raised in the `raised-editors` look. */
const RAISED_ROW_ICONS: Readonly<Record<string, NonNullable<ToolboxButton['icon']>>> = {
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
}

type WidgetRow = WidgetPaintArgs['row']

/** The icon a raised opener row shows before its name, if any. */
function openerIconOf(row: WidgetRow, tokens: DesignTokens): NonNullable<ToolboxButton['icon']> | undefined {
  if (row.viewId === 'core.asset') {
    const accept = Array.isArray(row.spec.options['accept']) ? row.spec.options['accept'].filter((item): item is string => typeof item === 'string') : []
    const family = row.spec.kind?.startsWith('model/') === true ? 'model'
      : row.spec.kind?.startsWith('media/') === true ? row.spec.kind.slice('media/'.length)
      : accept.length > 0 && accept.every((item) => item.startsWith(`${accept[0]!.split('/', 1)[0]}/`)) ? accept[0]!.split('/', 1)[0]
      : undefined
    return family === 'image' || family === 'mask' ? 'image' : family === 'video' ? 'film'
      : family === 'audio' ? 'audio-lines' : family === 'model' || family === 'model3d' ? 'box' : 'file'
  }
  return tokens.widgetRowLook === 'raised-editors'
    ? PARKED_EDITOR_VIEWS.has(row.viewId) ? undefined : RAISED_ROW_ICONS[row.viewId]
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
      const assetIcon = row.viewId === 'core.asset' ? openerIconOf(row, tokens) : undefined
      if (row.viewId !== 'core.compositor') {
        ctx.fillStyle = assetIcon === undefined ? tokens.colors.widgetBackground : tokens.colors.widgetRaised
        ctx.beginPath()
        ctx.roundRect(chrome.x, chrome.y, chrome.width, chrome.height, chrome.radius)
        ctx.fill()
        if (assetIcon !== undefined) {
          ctx.strokeStyle = tokens.colors.nodeIdleOutline
          ctx.lineWidth = paint.opener.stroke
          ctx.stroke()
          paintToolboxIcon(ctx, assetIcon, x + paint.opener.iconInset, y + rowHeight / 2 - paint.opener.iconSize / 2, paint.opener.iconSize, tokens.colors.value)
          paintToolboxIcon(ctx, 'chevron-right', x + width - paint.opener.trailingInset - paint.opener.iconSize,
            y + rowHeight / 2 - paint.opener.iconSize / 2, paint.opener.iconSize, tokens.colors.label)
        }
      }
      ctx.fillStyle = tokens.colors.label
      ctx.textAlign = 'left'
      const compact = tokens.widgetRowLook === 'raised-editors'
        ? compactSummary(view, args.companion.value, row.spec)
        : undefined
      const summary = compact === undefined ? undefined : {
        ...compact,
        ...(args.editorSummary?.text === undefined ? {} : { text: args.editorSummary.text }),
        ...(!row.unfolded && args.editorSummary?.thumbnails !== undefined ? { thumbnails: args.editorSummary.thumbnails } : {}),
      }
      const formatted = summary?.text ?? formatWidgetValue(args.companion.value, row.spec)
      const numeric = (row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT') && row.viewId !== 'core.integerColor'
      const field = assetIcon === undefined ? widgetFieldBounds(width, rowHeight, numeric, row.controllerMode !== undefined, tokens.rowGeometry)
        : { left: paint.opener.iconReserve, right: width - paint.opener.trailingReserve }
      const lead = subgraphMarkReserve(row)
      const picturesWidth = summaryThumbnailReserve(ctx, summary?.thumbnails)
      const companionZone = shareRowWidth(field.right - field.left, lead + measureWidth(ctx, row.label) + paint.labelWidthPadding, measureWidth(ctx, formatted) + picturesWidth + paint.labelWidthPadding)
      paintCenteredText(ctx, fitText(ctx, row.label, Math.max(0, companionZone - lead - paint.labelClipPadding)), x + field.left + lead + (numeric ? tokens.rowGeometry.stepperLabelInset : paint.labelInset), y + rowHeight / 2, tokens.fontSize)
      paintSubgraphMark(args, true, numeric)
      paintCompanionValue(args, summary, field)
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
    // Folded editors keep their header in place; pictures precede the value at the right.
    const sketchSize = Math.max(0, chrome.height - paint.curve.inset * 2)
    const sketch = rowsRaisedForEditors && row.viewId === 'core.curve' && !row.unfolded
      ? { y: chrome.y + paint.curve.inset, size: sketchSize }
      : undefined
    const nameY = y + rowHeight / 2
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
      paintToolboxIcon(ctx, openerIcon, x + paint.opener.iconInset,
        nameY - paint.opener.iconSize / 2, paint.opener.iconSize, tokens.colors.value)
      // An editor shown in the node points down while it is unfolded under this row.
      paintToolboxIcon(ctx, row.unfolded ? 'chevron-down' : 'chevron-right', x + width - paint.opener.trailingInset - paint.opener.iconSize,
        (sketch === undefined ? y + rowHeight / 2 : chrome.y + chrome.height / 2) - paint.opener.iconSize / 2, paint.opener.iconSize, tokens.colors.label)
    }
    const geometry = tokens.rowGeometry
    // The name sits as far from the opener icon as a row's mode icon from its label.
    const leftControl = openerIcon === undefined ? (numeric ? geometry.stepperZone : 0) : paint.opener.iconReserve
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
    const valuePreview = args.editorSummary?.text !== undefined
      ? args.editorSummary.text
      : assetSummary !== undefined
      ? assetSummary.text
      : sketch !== undefined
        ? compactSummary(view, resolved, row.spec)?.text
      : row.viewId === 'core.toggle' && row.spec.widgetType === 'BOOLEAN'
        ? compactBooleanValue(resolved, row.spec.options)
      : resolved === null || typeof resolved === 'object'
        ? undefined
        : formatWidgetValue(resolved, row.spec)
    const rowFont = ctx.font
    const colorValue = row.viewId === 'core.color' || row.viewId === 'core.integerColor'
    if (colorValue) ctx.font = `${tokens.fontSize}px ${tokens.fontMono}`
    const naturalValueWidth = row.viewId === 'core.integerColor'
      ? measureWidth(ctx, '#ffffff') + paint.colorValueReserve
      : valuePreview === undefined
        ? usableWidth * paint.structuredValueRatio
        : measureWidth(ctx, valuePreview.split('\n')[0] ?? '') + paint.valueWidthPadding + wordReserve
        + (sketch === undefined ? 0 : sketch.size + paint.curve.gap)
        + (row.viewId === 'core.color' ? paint.swatchReserve : 0)
        + (args.editorSummary?.thumbnail !== undefined && !row.unfolded ? paint.valueThumbnail.size + paint.valueThumbnail.gap : 0)
        + (!row.unfolded ? summaryThumbnailReserve(ctx, args.editorSummary?.thumbnails) : 0)
        + (row.viewId === 'core.toggle' && row.spec.widgetType === 'BOOLEAN' ? paint.toggleReserve : 0)
    ctx.font = rowFont
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
    // Empty editor rows and valueless openers keep their label whole while
    // it fits; what they ask for takes what is left and is cut first.
    const labelFirst = (args.editorSummary?.placeholder ?? (row.viewId !== 'core.asset' && RAISED_ROW_ICONS[row.viewId] === undefined
      ? undefined
      : (assetSummary ?? compactSummary(view, resolved, row.spec))?.labelFirst)) === true
    const labelWidth = multiline
      ? 0
      : labelFirst
        ? Math.min(naturalLabelWidth, Math.max(0, fieldWidth - modeIconReserve))
        : shareRowWidth(fieldWidth - modeIconReserve, naturalLabelWidth, naturalValueWidth, true)
    const paintLabel = () => {
      ctx.fillStyle = tokens.colors.label
      ctx.textAlign = 'left'
      paintCenteredText(ctx,
        ellipsize(ctx, row.label, Math.max(0, (multiline ? width : labelWidth) - lead - paint.labelClipPadding)),
        x + lead + (multiline ? 0 : leftControl) + (numeric && openerIcon === undefined ? geometry.stepperLabelInset : paint.labelInset),
        multiline ? chrome.y + multilineLabelHeight / 2 : nameY,
        tokens.fontSize,
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

    let sketchStyle: Readonly<Record<string, unknown>> | undefined
    let sketchLeft = x + valueRight
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
          if (style['role'] === 'curveSketch') {
            sketchStyle = style
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
            // The interpolation sits under the name and stops before the picture.
            if (sketch === undefined) return
            const joinLeft = x + lead + leftControl + paint.labelInset
            ctx.fillStyle = tokens.colors.valueMark
            ctx.textAlign = 'left'
            paintCenteredText(ctx, ellipsize(ctx, viewRun, Math.max(0, sketchLeft - joinLeft - paint.labelValueGap)),
              joinLeft, nameY + paint.curve.lineStep, tokens.fontSize)
            return
          }
          const summary = viewStyle['role'] === 'widgetValue' ? args.editorSummary : undefined
          const run = summary?.text ?? viewRun
          const style = summary === undefined ? viewStyle : { ...viewStyle,
            placeholder: summary.placeholder ?? (summary.text === undefined && viewStyle['placeholder'] === true),
          }
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
            const valueFont = ctx.font
            const colorCode = row.viewId === 'core.color' || typeof style['swatch'] === 'string'
            if (colorCode && (role === undefined || role === 'widgetValue') && style['placeholder'] !== true) ctx.font = `${tokens.fontSize}px ${tokens.fontMono}`
            const marked = valueWord !== undefined && (role === undefined || role === 'widgetValue')
            const swatch = typeof style['swatch'] === 'string' && alignRight ? style['swatch'] : undefined
            const items = stringList(style['items'])
            // Unfolded, the editor shows the picture itself, so the row drops its small copy.
            const thumbnail = alignRight && !row.unfolded ? summary?.thumbnail : undefined
            const markReserve = (modeIcon !== undefined && role === 'widgetValue' && alignRight ? modeIconReserve : 0)
              + (sketch !== undefined && role === 'widgetValue' ? sketch.size + paint.curve.gap : 0)
              + (swatch !== undefined ? paint.valueSwatch.size + paint.valueSwatch.gap : 0)
              + (thumbnail !== undefined ? paint.valueThumbnail.size + paint.valueThumbnail.gap : 0)
            const iconReserve = markReserve + (marked ? wordReserve : 0)
            const fitWidth = Math.max(0, availableWidth - iconReserve)
            const line = run.split('\n')[0] ?? ''
            const fitted = fitSummary(ctx, summaryFitOf(run, style), fitWidth)
            const parts = alignRight && !row.unfolded && summary?.thumbnails !== undefined
              ? fitSummaryParts(ctx, { ...summaryFitOf(run, style), thumbnails: summary.thumbnails }, fitWidth)
              : undefined
            // An empty text or opener cut to fewer than three letters
            // before its ellipsis is not drawn at all.
            const text = items === undefined && (style['placeholder'] === true || labelFirst) && fitted !== line
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
              if (parts !== undefined) paintSummaryParts(ctx, parts, textX, textY, tokens)
              else if (!(alignRight && paintValueParts(ctx, style['parts'], textX, textY, fitWidth, tokens))) paintCenteredText(ctx, text, textX, textY, tokens.fontSize)
              if (centered && sketchStyle !== undefined) {
                sketchLeft = textX - measureWidth(ctx, text) - paint.curve.gap - sketch.size
                paintCurveSketch(ctx, { ...sketch, x: sketchLeft }, sketchStyle, tokens)
              }
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
                const wordRight = alignRight ? textX - (parts === undefined ? measureWidth(ctx, text) : summaryPartsWidth(ctx, parts)) - markReserve - paint.valueWordGap : textX - paint.valueWordGap
                ctx.textAlign = 'right'
                ctx.fillStyle = tokens.colors.label
                const codeFont = ctx.font
                ctx.font = valueFont
                paintCenteredText(ctx, valueWord!, wordRight, textY, tokens.fontSize)
                if (automaticDot > 0) {
                  const radius = paint.automaticDot.radius
                  ctx.fillStyle = tokens.colors.warningMark
                  ctx.beginPath()
                  ctx.arc(wordRight - measureWidth(ctx, valueWord!) - paint.automaticDot.gap - radius, textY, radius, 0, Math.PI * 2)
                  ctx.fill()
                }
                ctx.font = codeFont
              }
              // A host's editor summary is what the editor shows, an arriving value included, so it is never struck.
              if (args.connected && summary === undefined && (role === undefined || role === 'widgetValue')) {
                paintStaleValueStrikethrough(ctx, text, textX, textY, alignRight ? 'right' : 'left', tokens.colors.value)
              }
              ctx.restore()
            }
            ctx.font = valueFont
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
    if (style['interpolation'] === 'step' && points.length > 0) {
      let previous = samples[0]!
      const firstPoint = at(0, previous)
      line.moveTo(firstPoint.x, firstPoint.y)
      for (const [position, value] of points) {
        if (position! <= 0 || position! > 1) continue
        const next = Math.max(0, Math.min(1, value!))
        const before = at(position!, previous)
        const after = at(position!, next)
        line.lineTo(before.x, before.y)
        line.lineTo(after.x, after.y)
        previous = next
      }
      line.lineTo(left + span, at(0, previous).y)
    } else {
      samples.forEach((sample, index) => {
        const point = at(index / (samples.length - 1), sample)
        if (index === 0) line.moveTo(point.x, point.y)
        else line.lineTo(point.x, point.y)
      })
    }
    ctx.lineWidth = paint.lineWidth
    ctx.lineJoin = 'round'
    // Before the first point and after the last the curve holds that point's value, drawn muted.
    const first = held.length === 2 ? at(Math.max(0, Math.min(1, held[0]!)), 0).x : left
    const last = held.length === 2 ? at(Math.max(0, Math.min(1, held[1]!)), 0).x : left + span
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
    if (position! < 0 || position! > 1 || value! < 0 || value! > 1) continue
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
    paintCenteredText(ctx, index === last ? tail : part.text, x, y, tokens.fontSize)
    if (part.look === 'gone') paintStaleValueStrikethrough(ctx, part.text, x, y, 'right', tokens.colors.label)
    x -= widths[index]!
  }
  ctx.font = baseFont
  ctx.fillStyle = valueColor
  return true
}
