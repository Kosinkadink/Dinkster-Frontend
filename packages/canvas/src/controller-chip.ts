/** Geometry shared by widget painting and interaction for after-generate chips. */

/** Numeric steppers retain this zone at the right edge of a widget row. */
export const WIDGET_EDGE_CONTROL_WIDTH = 12

/** Half-extent shared by the 6px numeric and combo edge glyphs. */
export const EDGE_ACTION_GLYPH_HALF = 3

/** Chip chrome is inset equally from the top and bottom of a widget row. */
export const CONTROLLER_CHIP_VERTICAL_INSET = 4

/** Gap between right-aligned widget value text and controller chip chrome. */
export const CONTROLLER_CHIP_TEXT_GAP = 6

/** Clearance between trailing controls; intentionally matches the text gap. */
export const TRAILING_ACTION_GAP = CONTROLLER_CHIP_TEXT_GAP

/** Row-local center for an action glyph in either unchanged edge zone. */
export function edgeActionCenterX(rowWidth: number, side: 'leading' | 'trailing'): number {
  const inset = WIDGET_EDGE_CONTROL_WIDTH / 2
  return side === 'leading' ? inset : rowWidth - inset
}

/**
 * Controller rows keep a stable label/value split as the numeric value gains
 * digits. Wide rows reserve enough value space for a safe integer; narrow
 * rows preserve a readable label and clip the value at one deterministic
 * boundary instead of moving the controller on every write.
 */
export interface ControllerChipRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Normal right edge for numeric values, immediately left of their stepper. */
export function controllerChipTextRight(rowWidth: number, rowHeight: number): number {
  return controllerChipRect(rowWidth, rowHeight).x - CONTROLLER_CHIP_TEXT_GAP
}

/** Stable text rails shared by ordinary and companion widget painters. */
export function widgetFieldBounds(
  rowWidth: number,
  rowHeight: number,
  numeric: boolean,
  controller: boolean,
): { left: number; right: number } {
  return {
    left: numeric ? WIDGET_EDGE_CONTROL_WIDTH : 6,
    right: controller
      ? controllerChipTextRight(rowWidth, rowHeight)
      : numeric ? rowWidth - WIDGET_EDGE_CONTROL_WIDTH : rowWidth - 6,
  }
}

/** Row-local rectangle used for both painting and pointer hit testing. */
export function controllerChipRect(rowWidth: number, rowHeight: number): ControllerChipRect {
  const size = Math.max(0, rowHeight - CONTROLLER_CHIP_VERTICAL_INSET * 2)
  return {
    x: Math.max(
      WIDGET_EDGE_CONTROL_WIDTH,
      rowWidth - WIDGET_EDGE_CONTROL_WIDTH - TRAILING_ACTION_GAP - size,
    ),
    y: CONTROLLER_CHIP_VERTICAL_INSET,
    width: size,
    height: size,
  }
}

/** Full rectangle containment after hitTest has selected the widget row. */
export function controllerChipContains(
  localX: number,
  localY: number,
  rowWidth: number,
  rowHeight: number,
): boolean {
  const rect = controllerChipRect(rowWidth, rowHeight)
  return localX >= rect.x && localX <= rect.x + rect.width
    && localY >= rect.y && localY <= rect.y + rect.height
}
