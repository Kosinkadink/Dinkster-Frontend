import { createSignal, onCleanup, onMount } from 'solid-js'
import { useAppMessage } from './locale.js'

/** Page animation-frame cadence, not GPU presentation or canvas paint time. */
export function FrameRateStatus() {
  const message = useAppMessage()
  const [sample, setSample] = createSignal<{ fps: number; slowest: number }>()
  onMount(() => {
    let frame: number | undefined
    let previous: number | undefined
    let start: number | undefined
    let intervals = 0
    let slowest = 0
    const reset = () => {
      previous = start = undefined
      intervals = slowest = 0
      setSample(undefined)
    }
    const tick = (timestamp: number) => {
      frame = undefined
      if (document.hidden) return
      if (previous !== undefined) {
        intervals++
        slowest = Math.max(slowest, timestamp - previous)
      }
      start ??= timestamp
      previous = timestamp
      const elapsed = timestamp - start
      if (elapsed >= 1000) {
        setSample({ fps: Math.round(intervals * 1000 / elapsed), slowest })
        start = timestamp
        intervals = slowest = 0
      }
      frame = requestAnimationFrame(tick)
    }
    const visibility = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      reset()
      if (!document.hidden) frame = requestAnimationFrame(tick)
    }
    visibility()
    document.addEventListener('visibilitychange', visibility)
    onCleanup(() => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', visibility)
    })
  })
  return <span data-testid="frame-rate" aria-live="off">
    {sample() ? message('shell.status.frameRate', {
      fps: sample()!.fps,
      slowest: sample()!.slowest.toFixed(1),
    }) : message('shell.status.frameRateMeasuring')}
  </span>
}
