import {
  Show,
  createEffect,
  createSignal,
  createUniqueId,
  on,
} from 'solid-js'
import { useFieldFocus } from './field-focus.js'

export function ProductAudioWaveform(props: {
  readonly value: number
  readonly duration: number
  readonly ariaLabel: string
  readonly path?: string
  readonly image?: string | undefined
  readonly disabled?: boolean
  readonly interactive?: boolean
  readonly onSeek: (seconds: number) => void
  readonly onImageError?: () => void
}) {
  useFieldFocus()
  const clip = createUniqueId()
  const mask = createUniqueId()
  const ink = createUniqueId()
  const bars = Array.from(
    { length: 72 },
    (_, index) => `M${index * 4 + 2} 0V72`,
  ).join(' ')
  const [position, setPosition] = createSignal(props.value)
  let track!: SVGSVGElement
  const time = (seconds: number) => {
    const whole = Math.max(0, Math.floor(seconds))
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
  }
  createEffect(
    on(
      () => [props.value, props.duration] as const,
      ([value]) => setPosition(Math.max(0, Math.min(props.duration, value))),
    ),
  )
  const available = () =>
    props.interactive !== false && !props.disabled && props.duration > 0
  const fraction = () =>
    props.duration > 0
      ? Math.min(1, Math.max(0, position() / props.duration))
      : 0
  const seek = (seconds: number) => {
    if (!available()) return
    const value = Math.min(
      props.duration,
      Math.max(0, Math.round(seconds * 100) / 100),
    )
    setPosition(value)
    props.onSeek(value)
  }
  const pointer = (event: PointerEvent) => {
    const bounds = track.getBoundingClientRect()
    if (bounds.width > 0)
      seek(((event.clientX - bounds.left) / bounds.width) * props.duration)
  }
  return (
    <div class="dinkster-audio-position">
      <svg
        ref={track}
        class="dinkster-audio-waveform"
        viewBox="0 0 288 72"
        preserveAspectRatio="none"
        role={props.interactive === false ? 'img' : 'slider'}
        tabindex={available() ? 0 : undefined}
        aria-label={props.ariaLabel}
        aria-valuemin={props.interactive === false ? undefined : 0}
        aria-valuemax={
          props.interactive === false ? undefined : props.duration
        }
        aria-valuenow={props.interactive === false ? undefined : position()}
        aria-valuetext={
          props.interactive === false
            ? undefined
            : `${position().toFixed(1)} of ${props.duration.toFixed(1)} seconds`
        }
        aria-orientation={
          props.interactive === false ? undefined : 'horizontal'
        }
        aria-disabled={props.interactive === false ? undefined : !available()}
        onPointerDown={(event) => {
          if (event.button !== 0 || !available()) return
          event.preventDefault()
          event.stopPropagation()
          track.focus()
          track.setPointerCapture?.(event.pointerId)
          pointer(event)
        }}
        onPointerMove={(event) => {
          if (track.hasPointerCapture?.(event.pointerId)) pointer(event)
        }}
        onPointerUp={(event) => {
          track.releasePointerCapture?.(event.pointerId)
        }}
        onKeyDown={(event) => {
          const step = 0.01
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? props.duration
                : event.key === 'ArrowRight' || event.key === 'ArrowUp'
                  ? position() + step
                  : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
                    ? position() - step
                    : event.key === 'PageUp'
                      ? position() + step * 10
                      : event.key === 'PageDown'
                        ? position() - step * 10
                        : undefined
          if (next === undefined || !available()) return
          event.preventDefault()
          event.stopPropagation()
          seek(next)
        }}
      >
        <defs>
          <clipPath id={clip}>
            <rect width={fraction() * 288} height={72} />
          </clipPath>
          <filter id={ink} color-interpolation-filters="sRGB">
            {/* The server PNG has bright envelope ink on an opaque dark background. */}
            <feColorMatrix
              type="matrix"
              values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0.2126 0.7152 0.0722 0 -0.3"
            />
            <feComponentTransfer>
              <feFuncA type="linear" slope="5" />
            </feComponentTransfer>
          </filter>
          <mask
            id={mask}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="288"
            height="72"
          >
            <image
              href={props.image}
              width={288}
              height={72}
              preserveAspectRatio="none"
              filter={`url(#${ink})`}
              onError={() => props.onImageError?.()}
            />
            <image
              href={props.image}
              width={288}
              height={72}
              preserveAspectRatio="none"
              filter={`url(#${ink})`}
              transform="translate(0 72) scale(1 -1)"
            />
          </mask>
        </defs>
        <Show when={props.image} fallback={<path d={props.path} />}>
          <path d={bars} mask={`url(#${mask})`} />
        </Show>
        <g class="dinkster-audio-waveform-played" clip-path={`url(#${clip})`}>
          <Show when={props.image} fallback={<path d={props.path} />}>
            <path d={bars} mask={`url(#${mask})`} />
          </Show>
        </g>
        <line
          class="dinkster-audio-waveform-playhead"
          x1={fraction() * 288}
          x2={fraction() * 288}
          y1={0}
          y2={72}
        />
      </svg>
      <span class="dinkster-audio-time">
        {time(position())} /{' '}
        {props.duration > 0 ? time(Math.round(props.duration)) : '--:--'}
      </span>
    </div>
  )
}
