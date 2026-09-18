import {
  touchNavViewport,
  wheelNavigationViewport,
  type TouchNavPoint,
  type WheelNavigationInput,
  type WheelNavigationMode,
} from '@dinkster/canvas'
import type { ImageEditPoint } from './image-mask-tool.js'

export interface ImagePointerSampleSource {
  readonly clientX: number
  readonly clientY: number
  readonly pointerType: string
  readonly pressure: number
  readonly tiltX: number
  readonly tiltY: number
  readonly twist: number
  readonly timeStamp: number
  readonly getCoalescedEvents?: () => readonly ImagePointerSampleSource[]
}

export interface ImageSampleBounds {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  readonly imageWidth: number
  readonly imageHeight: number
}

export interface ImageNavigationViewport {
  readonly panX: number
  readonly panY: number
  readonly scale: number
}

export interface ImageNavigationBounds {
  readonly width: number
  readonly height: number
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum))

export function imagePointerSamples(
  event: ImagePointerSampleSource,
  bounds: ImageSampleBounds,
): readonly ImageEditPoint[] {
  if (bounds.width <= 0 || bounds.height <= 0 || bounds.imageWidth <= 0 || bounds.imageHeight <= 0) return []
  const coalesced = event.getCoalescedEvents?.() ?? []
  const samples = coalesced.length > 0 ? coalesced : [event]
  const pen = event.pointerType === 'pen'
  return samples.map((sample) => ({
    x: (sample.clientX - bounds.left) * bounds.imageWidth / bounds.width,
    y: (sample.clientY - bounds.top) * bounds.imageHeight / bounds.height,
    time: Math.max(0, Number.isFinite(sample.timeStamp) ? sample.timeStamp : 0),
    pressure: pen ? clamp(sample.pressure, 0, 1) : 1,
    tiltX: pen ? clamp(sample.tiltX, -90, 90) : 0,
    tiltY: pen ? clamp(sample.tiltY, -90, 90) : 0,
    twist: pen ? clamp(sample.twist, 0, 359) : 0,
  }))
}

const canvasViewport = (
  viewport: ImageNavigationViewport,
  bounds: ImageNavigationBounds,
) => ({
  x: bounds.width / 2 + viewport.panX,
  y: bounds.height / 2 + viewport.panY,
  scale: viewport.scale,
})

const imageViewport = (
  viewport: { readonly x: number; readonly y: number; readonly scale: number },
  bounds: ImageNavigationBounds,
): ImageNavigationViewport => ({
  panX: viewport.x - bounds.width / 2,
  panY: viewport.y - bounds.height / 2,
  scale: viewport.scale,
})

export function imageWheelNavigationViewport(
  viewport: ImageNavigationViewport,
  input: WheelNavigationInput,
  bounds: ImageNavigationBounds,
  mode: WheelNavigationMode,
): ImageNavigationViewport {
  return imageViewport(wheelNavigationViewport(canvasViewport(viewport, bounds), input, mode), bounds)
}

export class ImageTouchNavigation {
  private readonly points = new Map<number, TouchNavPoint>()

  start(pointerId: number, point: TouchNavPoint): boolean {
    if (this.points.has(pointerId)) return true
    if (this.points.size >= 2) return false
    this.points.set(pointerId, point)
    return true
  }

  has(pointerId: number): boolean {
    return this.points.has(pointerId)
  }

  move(
    pointerId: number,
    point: TouchNavPoint,
    viewport: ImageNavigationViewport,
    bounds: ImageNavigationBounds,
  ): ImageNavigationViewport | undefined {
    const previous = this.points.get(pointerId)
    if (previous === undefined) return undefined
    const other = [...this.points.entries()].find(([id]) => id !== pointerId)?.[1]
    this.points.set(pointerId, point)
    if (other === undefined) {
      return {
        panX: viewport.panX + point.x - previous.x,
        panY: viewport.panY + point.y - previous.y,
        scale: viewport.scale,
      }
    }
    return imageViewport(
      touchNavViewport(canvasViewport(viewport, bounds), previous, other, point, other),
      bounds,
    )
  }

  end(pointerId: number): void {
    this.points.delete(pointerId)
  }

  clear(): readonly number[] {
    const pointerIds = [...this.points.keys()]
    this.points.clear()
    return pointerIds
  }
}
