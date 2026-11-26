import { For, Show, createMemo } from 'solid-js'

export function ProductCountStrip(props: {
  readonly label: string
  readonly segments: readonly {
    readonly label: string
    readonly count: number
    readonly color: string
  }[]
}) {
  const segments = createMemo(() =>
    props.segments.filter((segment) => segment.count > 0),
  )
  const total = createMemo(() =>
    segments().reduce((sum, segment) => sum + segment.count, 0),
  )
  return (
    <Show when={segments().length > 0}>
      <div class="dinkster-count-strip">
        <div class="dinkster-count-bar" aria-hidden="true">
          <For each={segments()}>
            {(segment) => (
              <svg width={`${(segment.count / total()) * 100}%`} height="4">
                <rect width="100%" height="100%" rx="2" fill={segment.color} />
              </svg>
            )}
          </For>
        </div>
        <dl class="dinkster-count-legend" aria-label={props.label}>
          <For each={segments()}>
            {(segment) => (
              <div>
                <dt>
                  <svg aria-hidden="true" width="8" height="8">
                    <rect
                      width="100%"
                      height="100%"
                      rx="2"
                      fill={segment.color}
                    />
                  </svg>
                  {segment.label}
                </dt>
                <dd>{segment.count.toLocaleString()}</dd>
              </div>
            )}
          </For>
        </dl>
      </div>
    </Show>
  )
}
