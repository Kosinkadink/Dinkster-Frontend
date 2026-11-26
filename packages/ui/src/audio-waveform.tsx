import { Show, createEffect, createSignal, createUniqueId, on } from 'solid-js'

export function ProductAudioWaveform(props: {
  readonly value: number
  readonly duration: number
  readonly label: string
  readonly path?: string
  readonly image?: string | undefined
  readonly disabled?: boolean
  readonly interactive?: boolean
  readonly onSeek: (seconds: number) => void
  readonly onImageError?: () => void
}) {
  const clip = createUniqueId()
  const [position, setPosition] = createSignal(props.value)
  let track!: SVGSVGElement
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
    <svg
      ref={track}
      class="dinkster-audio-waveform"
      viewBox="0 0 288 72"
      preserveAspectRatio="none"
      role={props.interactive === false ? 'img' : 'slider'}
      tabindex={available() ? 0 : undefined}
      aria-label={props.label}
      aria-valuemin={props.interactive === false ? undefined : 0}
      aria-valuemax={props.interactive === false ? undefined : props.duration}
      aria-valuenow={props.interactive === false ? undefined : position()}
      aria-valuetext={
        props.interactive === false
          ? undefined
          : `${position().toFixed(1)} of ${props.duration.toFixed(1)} seconds`
      }
      aria-orientation={props.interactive === false ? undefined : 'horizontal'}
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
      </defs>
      <Show when={props.image} fallback={<path d={props.path} />}>
        {(image) => (
          <image
            href={image()}
            width={288}
            height={72}
            preserveAspectRatio="none"
            onError={() => props.onImageError?.()}
          />
        )}
      </Show>
      <g class="dinkster-audio-waveform-played" clip-path={`url(#${clip})`}>
        <Show when={props.image} fallback={<path d={props.path} />}>
          {(image) => (
            <image
              href={image()}
              width={288}
              height={72}
              preserveAspectRatio="none"
            />
          )}
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
  )
}
