/** Shared zoom limits and curve for every canvas navigation surface. */
export const MIN_SCALE = 0.05
export const MAX_SCALE = 4

export type WheelNavigationMode = 'zoom' | 'pan'

export interface WheelNavigationViewport {
  readonly x: number
  readonly y: number
  readonly scale: number
}

export interface WheelNavigationInput {
  readonly screenX: number
  readonly screenY: number
  readonly deltaX: number
  readonly deltaY: number
  readonly deltaMode: number
  readonly pageWidth: number
  readonly pageHeight: number
  readonly ctrlKey: boolean
}

const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2
const WHEEL_LINE_PX = 16

function wheelPanDelta(delta: number, deltaMode: number, pageSize: number): number {
  if (deltaMode === DOM_DELTA_LINE) return delta * WHEEL_LINE_PX
  if (deltaMode === DOM_DELTA_PAGE) return delta * pageSize
  return delta
}

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

export function wheelZoomScale(scale: number, deltaY: number): number {
  return clampScale(scale * Math.exp(-deltaY * 0.0012))
}

/** Apply one wheel event using the selected graph/image navigation policy. */
export function wheelNavigationViewport(
  viewport: WheelNavigationViewport,
  input: WheelNavigationInput,
  mode: WheelNavigationMode,
): WheelNavigationViewport {
  if (mode === 'pan' && !input.ctrlKey) {
    return {
      x: viewport.x - wheelPanDelta(input.deltaX, input.deltaMode, input.pageWidth),
      y: viewport.y - wheelPanDelta(input.deltaY, input.deltaMode, input.pageHeight),
      scale: viewport.scale,
    }
  }
  const scale = wheelZoomScale(viewport.scale, input.deltaY)
  return {
    x: input.screenX - ((input.screenX - viewport.x) / viewport.scale) * scale,
    y: input.screenY - ((input.screenY - viewport.y) / viewport.scale) * scale,
    scale,
  }
}
