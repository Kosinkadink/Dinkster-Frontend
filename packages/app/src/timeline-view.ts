/** View coordinates only; serialized timeline timing belongs to the backend. */
export function timelineTicks(duration: number, width: number): readonly number[] {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(width) || width <= 0) return []
  const target = duration / Math.max(1, Math.min(100, Math.floor(width / 100)))
  const power = 10 ** Math.floor(Math.log10(target))
  const step = [1, 2, 5, 10].find((multiple) => multiple * power >= target)! * power
  return Array.from({ length: Math.floor(duration / step) + 1 }, (_, index) => index * step)
}

export function timelineTimeLabel(seconds: number): string {
  return `${Number(seconds.toFixed(6))} s`
}

export function timelineSeek(seconds: number, duration: number, frameDuration: number): number {
  if (seconds <= 0) return 0
  if (seconds >= duration) return duration
  return Math.min(duration, Math.round(seconds / frameDuration) * frameDuration)
}
