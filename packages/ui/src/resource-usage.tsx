import { For, Show, createUniqueId } from 'solid-js'

export interface ProductResourceSample {
  readonly timestamp: number
  readonly used: number
}

export interface ProductResourceSegment {
  readonly label: string
  readonly value: number
  readonly tone: 'models' | 'held' | 'other'
}

/** Values use the caller's unit; timestamps are milliseconds. Unknown facts
 * stay absent rather than occupying a zero-valued legend entry. */
export function ProductResourceUsage(props: {
  readonly label: string
  readonly total: number
  readonly segments: readonly ProductResourceSegment[]
  readonly samples: readonly ProductResourceSample[]
  readonly now: number
  readonly limit?: number
  readonly format: (value: number) => string
  readonly historyLabel: string
  readonly limitLabel: string
  readonly compact?: boolean
}) {
  const clipId = createUniqueId()
  const windowMs = 120_000
  const width = 300
  const height = 72
  const samples = () =>
    props.samples.filter(
      (sample) =>
        sample.timestamp > props.now - windowMs &&
        sample.timestamp <= props.now,
    )
  const x = (stamp: number) =>
    Math.max(
      0,
      Math.min(width, ((stamp - props.now + windowMs) / windowMs) * width),
    )
  const y = (value: number) =>
    height - Math.max(0, Math.min(1, value / props.total)) * height
  const line = () =>
    samples()
      .map(
        (sample, index) =>
          `${index === 0 ? 'M' : 'L'}${x(sample.timestamp)} ${y(sample.used)}`,
      )
      .join(' ')
  const area = () =>
    samples().length < 2
      ? ''
      : `${line()} L${x(samples().at(-1)!.timestamp)} ${height} L${x(samples()[0]!.timestamp)} ${height} Z`
  const percent = (value: number) =>
    props.total > 0 ? (value / props.total) * 100 : 0
  return (
    <section
      class="dinkster-resource-usage"
      aria-label={props.label}
      data-compact={props.compact === true}
    >
      <svg
        class="dinkster-resource-bar"
        viewBox="0 0 100 1"
        preserveAspectRatio="none"
        role="img"
        aria-label={props.segments
          .map((segment) => `${segment.label}: ${props.format(segment.value)}`)
          .join(', ')}
      >
        <For each={props.segments}>
          {(segment, index) => (
            <rect
              data-tone={segment.tone}
              x={props.segments
                .slice(0, index())
                .reduce((sum, item) => sum + percent(item.value), 0)}
              y="0"
              width={percent(segment.value)}
              height="1"
            />
          )}
        </For>
      </svg>
      <dl class="dinkster-resource-legend">
        <For each={props.segments}>
          {(segment) => (
            <div>
              <dt>
                <i data-tone={segment.tone} />
                {segment.label}
              </dt>
              <dd>{props.format(segment.value)}</dd>
            </div>
          )}
        </For>
      </dl>
      <Show when={props.total > 0}>
        <Show when={props.limit !== undefined}>
          <span class="dinkster-resource-limit-label">
            {props.limitLabel} {props.format(props.limit!)}
          </span>
        </Show>
        <div class="dinkster-resource-graph">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            role="img"
            aria-labelledby={`${clipId}-title ${clipId}-description`}
          >
            <title id={`${clipId}-title`}>{props.historyLabel}</title>
            <desc id={`${clipId}-description`}>
              {samples()
                .map(
                  (sample) =>
                    `${new Date(sample.timestamp).toLocaleTimeString()}: ${props.format(sample.used)}`,
                )
                .join('; ')}
            </desc>
            <path class="dinkster-resource-area" d={area()} />
            <path class="dinkster-resource-line" d={line()} />
            <For each={samples().length === 1 ? samples() : []}>
              {(sample) => (
                <circle
                  class="dinkster-resource-point"
                  cx={x(sample.timestamp)}
                  cy={y(sample.used)}
                  r="1"
                />
              )}
            </For>
            <Show when={props.limit !== undefined}>
              <path
                class="dinkster-resource-limit"
                d={`M0 ${y(props.limit!)} H${width}`}
              />
            </Show>
          </svg>
        </div>
        <span class="dinkster-metadata">{props.historyLabel}</span>
      </Show>
    </section>
  )
}
