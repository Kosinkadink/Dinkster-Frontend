import type { Json, WidgetSpec } from '@dinkster/core'

export interface VideoEditObject extends Record<string, Json> {
  trim?: Record<string, Json>
  crop?: Record<string, Json>
}

export interface VideoSourceFacts {
  readonly width: number
  readonly height: number
  readonly duration: number
  readonly fps: number
  readonly frameCount?: number
  readonly frameCountKind?: string
}

export const isVideoEditObject = (value: unknown): value is VideoEditObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function videoSourceDimensions(meta: Readonly<Record<string, unknown>> | undefined): Pick<VideoSourceFacts, 'width' | 'height'> | undefined {
  const effective = meta?.['effective']
  if (!isVideoEditObject(effective)) return undefined
  const { width, height } = effective
  return typeof width === 'number' && Number.isSafeInteger(width) && width > 0 &&
    typeof height === 'number' && Number.isSafeInteger(height) && height > 0 ? { width, height } : undefined
}

export function videoSourceFacts(meta: Readonly<Record<string, unknown>> | undefined): VideoSourceFacts | undefined {
  const effective = meta?.['effective']
  if (!isVideoEditObject(effective)) return undefined
  const rational = (value: unknown): number | undefined => {
    if (!Array.isArray(value) || value.length !== 2 || !value.every((part) => typeof part === 'number' && Number.isFinite(part)) || value[1] <= 0) return undefined
    const result = value[0] / value[1]
    return result > 0 ? result : undefined
  }
  const dimensions = videoSourceDimensions(meta)
  const { frame_count: frameCount, frame_count_kind: frameCountKind } = effective
  const duration = rational(effective.duration)
  const fps = rational(effective.fps)
  if (dimensions === undefined || duration === undefined || fps === undefined) return undefined
  return {
    ...dimensions, duration, fps,
    ...(typeof frameCount === 'number' && Number.isSafeInteger(frameCount) && frameCount > 0 ? { frameCount } : {}),
    ...(typeof frameCountKind === 'string' ? { frameCountKind } : {}),
  }
}

/** Presentation ticks follow average fps, not the effective VFR frame order. */
export const videoFrameCount = (facts: Pick<VideoSourceFacts, 'duration' | 'fps'>): number =>
  Math.max(1, Math.ceil(facts.duration * facts.fps))

export function videoEditFeatures(spec: WidgetSpec): ReadonlySet<'trim' | 'crop'> {
  const raw = spec.options['features']
  if (!Array.isArray(raw)) return new Set(['trim', 'crop'])
  return new Set(raw.filter((feature): feature is 'trim' | 'crop' => feature === 'trim' || feature === 'crop'))
}

export function updateVideoEditSection(
  value: VideoEditObject,
  section: 'trim' | 'crop',
  fields: Readonly<Record<string, number>>,
): VideoEditObject {
  const current = value[section]
  return {
    ...value,
    [section]: {
      ...(isVideoEditObject(current) ? current : {}),
      ...fields,
    },
  }
}

export function normalizedVideoCrop(
  width: number,
  height: number,
  crop: Readonly<{ x: number; y: number; width: number; height: number }>,
): { x: number; y: number; width: number; height: number } {
  if (crop.width <= 0 || crop.height <= 0) return { x: 0, y: 0, width, height }
  const x = Math.floor(Math.min(Math.max(crop.x, 0), width - 1) / 2) * 2
  const y = Math.floor(Math.min(Math.max(crop.y, 0), height - 1) / 2) * 2
  if (x === 0 && y === 0 && crop.width >= width && crop.height >= height) return { x: 0, y: 0, width, height }
  const croppedWidth = Math.floor(Math.min(crop.width, width - x) / 2) * 2
  const croppedHeight = Math.floor(Math.min(crop.height, height - y) / 2) * 2
  if (croppedWidth <= 0 || croppedHeight <= 0) return { x: 0, y: 0, width, height }
  return { x, y, width: croppedWidth, height: croppedHeight }
}

export function trimFrameWindow(
  startTime: number,
  duration: number,
  facts: Pick<VideoSourceFacts, 'duration' | 'fps' | 'frameCount'>,
): { start: number; end: number; playheadMax: number } {
  const count = videoFrameCount(facts)
  const seconds = Math.max(0, startTime < 0 ? facts.duration + startTime : startTime)
  const start = Math.min(Math.round(seconds * facts.fps), count)
  const requestedEnd = duration === 0 ? facts.duration : seconds + Math.max(0, duration)
  const end = duration === 0 ? count : Math.max(start, Math.min(Math.ceil(requestedEnd * facts.fps), count))
  return { start, end, playheadMax: Math.max(start, end - 1) }
}
