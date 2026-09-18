import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import { timelineSeek, timelineTicks, timelineTimeLabel } from './timeline-view.js'
import './timeline-viewport.css'

const LABEL_WIDTH = 144

export interface TimelineViewScale {
  readonly pixelsPerSecond: number
  readonly width: number
}

/** A controlled view over caller-owned timing, with no document or media state. */
export function TimelineViewport(props: {
  readonly duration: number | undefined
  readonly frameDuration: number | undefined
  readonly time: number
  readonly onSeek: (seconds: number) => void
  readonly unavailable?: string
  readonly children: (scale: TimelineViewScale) => JSX.Element
}) {
  const [zoom, setZoom] = createSignal(1)
  const [availableWidth, setAvailableWidth] = createSignal(640)
  const [scrollLeft, setScrollLeft] = createSignal(0)
  let scroll!: HTMLDivElement
  const valid = () => props.duration !== undefined && Number.isFinite(props.duration) && props.duration > 0 &&
    props.frameDuration !== undefined && Number.isFinite(props.frameDuration) && props.frameDuration > 0 &&
    Number.isFinite(props.time)
  const refusal = () => props.unavailable ?? (!valid() ? 'Timeline timing unavailable. An authoritative duration and frame rate are required.' : undefined)
  const duration = () => props.duration ?? 0
  const width = () => availableWidth() * zoom()
  const scale = createMemo(() => ({ width: width(), pixelsPerSecond: width() / duration() }))
  const ticks = createMemo(() => timelineTicks(duration(), width()).filter((time) => {
    const left = time * scale().pixelsPerSecond - scrollLeft()
    return left >= 0 && left + timelineTimeLabel(time).length * 8 + 6 <= availableWidth()
  }))
  const position = () => Math.max(0, Math.min(duration(), props.time))
  const positionText = () => String(Number(position().toFixed(6)))
  const seek = (seconds: number) => {
    if (refusal() !== undefined || !Number.isFinite(seconds)) return
    props.onSeek(timelineSeek(seconds, duration(), props.frameDuration!))
  }
  onMount(() => {
    const resize = () => setAvailableWidth(Math.max(160, scroll.clientWidth - LABEL_WIDTH))
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(scroll)
    onCleanup(() => observer.disconnect())
  })
  const keyboardSeek = (event: KeyboardEvent) => {
    let next: number
    switch (event.key) {
      case 'ArrowLeft': case 'ArrowDown': next = position() - props.frameDuration!; break
      case 'ArrowRight': case 'ArrowUp': next = position() + props.frameDuration!; break
      case 'Home': next = 0; break
      case 'End': next = duration(); break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    seek(next)
  }
  return <section class="timeline-viewport" aria-label="Timeline viewport" style={{ '--timeline-label-width': `${LABEL_WIDTH}px` }}>
    <header class="timeline-view-toolbar">
      <strong>Timeline</strong>
      <label>Playhead (seconds)<input type="number" aria-label="Playhead seconds"
        min="0" max={duration()} step="any" value={positionText()}
        disabled={refusal() !== undefined} onChange={(event) => {
          seek(event.currentTarget.valueAsNumber)
          event.currentTarget.value = positionText()
        }} /></label>
      <div class="timeline-zoom" role="group" aria-label="Timeline zoom">
        <button type="button" aria-label="Zoom out timeline" disabled={zoom() === 1} onClick={() => setZoom(zoom() / 2)}>-</button>
        <output aria-label="Timeline zoom level">{zoom()}x</output>
        <button type="button" aria-label="Zoom in timeline" disabled={zoom() === 16} onClick={() => setZoom(zoom() * 2)}>+</button>
        <button type="button" onClick={() => { setZoom(1); scroll.scrollLeft = 0; setScrollLeft(0) }}>Fit timeline</button>
      </div>
    </header>
    <Show when={refusal()}>{(message) => <p class="timeline-refusal" role="status">{message()}</p>}</Show>
    <div class="timeline-scroll" ref={scroll} onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}>
      <Show when={refusal() === undefined}>
        <div class="timeline-content" style={{ width: `${width() + LABEL_WIDTH}px` }}>
          <div class="timeline-ruler-row">
            <div class="timeline-lane-label">Time (seconds)</div>
            <div class="timeline-ruler" role="slider" tabIndex={0} aria-label="Timeline playhead"
              aria-valuemin={0} aria-valuemax={duration()} aria-valuenow={position()}
              aria-valuetext={timelineTimeLabel(position())} on:keydown={keyboardSeek}
              onPointerDown={(event) => {
                if (event.button !== 0) return
                event.currentTarget.focus()
                const bounds = event.currentTarget.getBoundingClientRect()
                seek((event.clientX - bounds.left) / bounds.width * duration())
              }}>
              <For each={ticks()}>{(time) => <span class="timeline-tick" aria-hidden="true"
                style={{ left: `${time / duration() * 100}%` }}>{timelineTimeLabel(time)}</span>}</For>
              <div class="timeline-playhead" aria-hidden="true" style={{ left: `${position() * scale().pixelsPerSecond}px` }} />
            </div>
          </div>
          <div class="timeline-lanes">{props.children(scale())}</div>
          <div class="timeline-playhead" aria-hidden="true" style={{ left: `${LABEL_WIDTH + position() * scale().pixelsPerSecond}px` }} />
        </div>
      </Show>
    </div>
  </section>
}

/** Lane contents are rendered directly from the authoritative document by the caller. */
export function TimelineLane(props: { readonly label: string; readonly description?: string; readonly children: JSX.Element }) {
  return <section class="timeline-lane" aria-label={props.label}>
    <div class="timeline-lane-label"><strong>{props.label}</strong><Show when={props.description}><small>{props.description}</small></Show></div>
    <div class="timeline-lane-content">{props.children}</div>
  </section>
}
