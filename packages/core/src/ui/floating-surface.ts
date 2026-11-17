export interface FloatingSurfaceRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface FloatingSurfaceSize {
  readonly width: number
  readonly height: number
}

export interface FloatingSurfacePlacement {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly maxWidth: number
  readonly maxHeight: number
}

export type FloatingSurfaceDirection = 'block' | 'inline' | 'point'

/** Horizontal alignment of a point-anchored surface: its left edge on the
 * anchor ('start', default) or its horizontal center on the anchor
 * ('center'). Edge clamping applies after alignment either way. */
export type FloatingSurfaceAlign = 'start' | 'center'

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max))

export function placeFloatingSurface(input: {
  readonly surface: FloatingSurfaceSize
  readonly anchor: FloatingSurfaceRect
  readonly bounds: FloatingSurfaceRect
  readonly direction: FloatingSurfaceDirection
  readonly align?: FloatingSurfaceAlign
  readonly margin: number
  readonly gap: number
  readonly maxHeight?: number
  readonly preferredHeight?: number
}): FloatingSurfacePlacement {
  const leftBound = input.bounds.left + input.margin
  const rightBound = input.bounds.right - input.margin
  const topBound = input.bounds.top + input.margin
  const bottomBound = input.bounds.bottom - input.margin
  const maxWidth = Math.max(0, rightBound - leftBound)
  const width = Math.min(input.surface.width, maxWidth)
  const boundedMaxHeight = Math.min(
    input.maxHeight ?? Number.POSITIVE_INFINITY,
    Math.max(0, bottomBound - topBound),
  )

  if (input.direction === 'block') {
    const availableAfter = Math.max(0, bottomBound - input.anchor.bottom - input.gap)
    const availableBefore = Math.max(0, input.anchor.top - input.gap - topBound)
    const preferredHeight = Math.min(
      input.preferredHeight ?? input.surface.height,
      boundedMaxHeight,
    )
    const after = availableAfter >= preferredHeight || availableAfter >= availableBefore
    const maxHeight = Math.min(boundedMaxHeight, after ? availableAfter : availableBefore)
    const height = Math.min(input.surface.height, maxHeight)
    return {
      left: clamp(input.anchor.left, leftBound, rightBound - width),
      top: after
        ? input.anchor.bottom + input.gap
        : clamp(input.anchor.top - input.gap - height, topBound, bottomBound - height),
      width,
      maxWidth,
      maxHeight,
    }
  }

  const height = Math.min(input.surface.height, boundedMaxHeight)
  if (input.direction === 'inline') {
    const availableAfter = Math.max(0, rightBound - input.anchor.right - input.gap)
    const availableBefore = Math.max(0, input.anchor.left - input.gap - leftBound)
    const after = availableAfter >= width || availableAfter >= availableBefore
    const rawLeft = after
      ? input.anchor.right + input.gap
      : input.anchor.left - input.gap - width
    return {
      left: clamp(rawLeft, leftBound, rightBound - width),
      top: clamp(input.anchor.top, topBound, bottomBound - height),
      width,
      maxWidth,
      maxHeight: boundedMaxHeight,
    }
  }

  const anchorLeft = input.align === 'center'
    ? (input.anchor.left + input.anchor.right) / 2 - width / 2
    : input.anchor.left
  return {
    left: clamp(anchorLeft, leftBound, rightBound - width),
    top: clamp(input.anchor.top, topBound, bottomBound - height),
    width,
    maxWidth,
    maxHeight: boundedMaxHeight,
  }
}
