import { For, Show, createMemo, createSignal, type JSX } from 'solid-js'
import { X } from 'lucide-solid'
import { ProductButton, ProductIconButton } from './controls.js'

/** One change the editor made by itself and reports in the notice. */
export interface FixesNoticeChange {
  /** Unique among the notice's changes. */
  readonly id: string
  /** The kind of fix; changes of one kind are grouped above ten changes. */
  readonly kind: string
  /** The node the change is on: changes with the same target share a row. */
  readonly target: string
  /** The node's name as the canvas shows it. */
  readonly node: string
  /** What changed, such as "steps: 12000 to 10000". */
  readonly text: string
  /**
   * How many changed rows, outputs or replaced nodes the text reports, such
   * as 9 for "Outputs 5-13 added."; 1 when absent.
   */
  readonly count?: number
}

/** The notice's count: changed rows, outputs and replaced nodes, not nodes. */
export const fixesNoticeCount = (
  changes: readonly FixesNoticeChange[],
): number => changes.reduce((total, change) => total + (change.count ?? 1), 0)

/**
 * `ready`: Undo takes back every listed change. `refused`: something changed
 * since, so Undo is off and the notice says why. `undone`: the changes were
 * taken back and can be put back as recorded.
 */
export type FixesNoticeState = 'ready' | 'refused' | 'undone'

export interface FixesNoticeStrings {
  /** "12 things were adjusted" */
  readonly adjusted: (count: number) => string
  /** "Adjustments undone" */
  readonly undone: string
  readonly review: string
  readonly undo: string
  /** "Redo adjustments" */
  readonly redo: string
  readonly dismiss: string
  /** Why Undo is off in the refused state. */
  readonly refused: string
  /** The Review list's heading, "Adjusted in this workflow". */
  readonly heading: string
  /** "12 adjustments across 3 nodes" */
  readonly summary: (changes: number, nodes: number) => string
  /** A kind's group heading with its count, "Numbers corrected to limits (2)". */
  readonly group: (kind: string, count: number) => string
  /** The link to the settings of automatic fixes. */
  readonly settings: string
}

/** Ten changes or fewer are listed one row per node; more are grouped by kind. */
export const FIXES_NOTICE_ROWS_PER_NODE = 10

interface ReviewRow {
  readonly key: string
  readonly target: string
  readonly node: string
  readonly texts: readonly string[]
}

interface ReviewGroup {
  readonly key: string
  readonly heading?: string
  readonly rows: readonly ReviewRow[]
}

/** Rows per node, in the order the nodes first changed, under one group per kind above ten changes. */
export function fixesNoticeGroups(
  changes: readonly FixesNoticeChange[],
  group: FixesNoticeStrings['group'],
): readonly ReviewGroup[] {
  const rowsOf = (list: readonly FixesNoticeChange[], prefix: string) => {
    const rows = new Map<string, { node: string; texts: string[] }>()
    for (const change of list) {
      const row = rows.get(change.target)
      if (row === undefined)
        rows.set(change.target, { node: change.node, texts: [change.text] })
      else row.texts.push(change.text)
    }
    return [...rows].map(([target, row]) => ({
      key: JSON.stringify([prefix, target]),
      target,
      ...row,
    }))
  }
  if (fixesNoticeCount(changes) <= FIXES_NOTICE_ROWS_PER_NODE)
    return [{ key: 'nodes', rows: rowsOf(changes, '') }]
  const kinds = new Map<string, FixesNoticeChange[]>()
  for (const change of changes) {
    const list = kinds.get(change.kind)
    if (list === undefined) kinds.set(change.kind, [change])
    else list.push(change)
  }
  return [...kinds].map(([kind, list]) => ({
    key: JSON.stringify(['kind', kind]),
    heading: group(kind, fixesNoticeCount(list)),
    rows: rowsOf(list, kind),
  }))
}

/**
 * The one quiet line that reports the small fixes the editor made by itself,
 * with Review, one Undo and a cross. Review opens above the line and stays
 * open while changes are added to it; choosing a row keeps it chosen.
 * Escape closes only Review; the cross dismisses the notice.
 */
export function ProductFixesNotice(props: {
  changes: readonly FixesNoticeChange[]
  state: FixesNoticeState
  strings: FixesNoticeStrings
  /** Opens with Review open, as when the status bar count brings it back. */
  reviewOpen?: boolean
  onChoose: (target: string) => void
  onUndo: () => void
  onRedo: () => void
  onDismiss: () => void
  onSettings: () => void
}): JSX.Element {
  const [review, setReview] = createSignal(props.reviewOpen === true)
  const [chosen, setChosen] = createSignal<string>()
  const groups = createMemo(() =>
    fixesNoticeGroups(props.changes, props.strings.group),
  )
  const nodes = () => new Set(props.changes.map((change) => change.target)).size
  const count = () => fixesNoticeCount(props.changes)
  const reviewing = () => review() && props.state !== 'undone'
  return (
    <section
      class="dinkster-fixes-notice"
      data-state={props.state}
      aria-label={
        props.state === 'undone'
          ? props.strings.undone
          : props.strings.adjusted(count())
      }
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !reviewing()) return
        event.stopPropagation()
        setReview(false)
      }}
    >
      <Show when={reviewing()}>
        <div
          class="dinkster-fixes-review"
          role="region"
          aria-label={props.strings.heading}
        >
          <div class="dinkster-fixes-review-heading">
            <span>{props.strings.heading}</span>
            <span class="dinkster-metadata">
              {props.strings.summary(count(), nodes())}
            </span>
          </div>
          <div class="dinkster-fixes-review-list">
            <For each={groups().map((group) => group.key)}>
              {(key) => {
                const group = () =>
                  groups().find((candidate) => candidate.key === key)
                return (
                  <Show when={group()}>
                    {(current) => (
                      <div class="dinkster-fixes-review-group">
                        <Show when={current().heading}>
                          {(heading) => (
                            <span class="dinkster-fixes-review-kind">
                              {heading()}
                            </span>
                          )}
                        </Show>
                        <For each={current().rows.map((row) => row.key)}>
                          {(rowKey) => {
                            const row = () =>
                              current().rows.find(
                                (candidate) => candidate.key === rowKey,
                              )
                            return (
                              <Show when={row()}>
                                {(entry) => (
                                  <button
                                    type="button"
                                    class="dinkster-fixes-review-row"
                                    aria-current={
                                      chosen() === entry().target
                                        ? 'true'
                                        : undefined
                                    }
                                    onClick={() => {
                                      setChosen(entry().target)
                                      props.onChoose(entry().target)
                                    }}
                                  >
                                    <span class="dinkster-fixes-review-node">
                                      {entry().node}
                                    </span>
                                    <span class="dinkster-fixes-review-changes">
                                      <For each={entry().texts}>
                                        {(text) => <span>{text}</span>}
                                      </For>
                                    </span>
                                  </button>
                                )}
                              </Show>
                            )
                          }}
                        </For>
                      </div>
                    )}
                  </Show>
                )
              }}
            </For>
          </div>
          <div class="dinkster-fixes-review-foot">
            <button
              type="button"
              class="dinkster-fixes-settings"
              onClick={() => props.onSettings()}
            >
              {props.strings.settings}
            </button>
          </div>
        </div>
      </Show>
      <div class="dinkster-fixes-line" role="status">
        <span class="dinkster-fixes-title">
          {props.state === 'undone'
            ? props.strings.undone
            : props.strings.adjusted(count())}
        </span>
        <Show
          when={props.state !== 'undone'}
          fallback={
            <ProductButton fill="outline" onClick={() => props.onRedo()}>
              {props.strings.redo}
            </ProductButton>
          }
        >
          <ProductButton
            aria-expanded={reviewing()}
            onClick={() => setReview(!review())}
          >
            {props.strings.review}
          </ProductButton>
          <ProductButton
            disabled={props.state === 'refused'}
            onClick={() => props.onUndo()}
          >
            {props.strings.undo}
          </ProductButton>
        </Show>
        <ProductIconButton
          icon={X}
          label={props.strings.dismiss}
          onClick={() => props.onDismiss()}
        />
      </div>
      <Show when={props.state === 'refused'}>
        <p class="dinkster-fixes-reason">{props.strings.refused}</p>
      </Show>
    </section>
  )
}

/** The status bar's count of adjustments after the notice is dismissed; choosing it brings the notice back. */
export function ProductFixesCount(props: {
  count: number
  /** "12 adjusted" */
  label: string
  onOpen: () => void
  /** `compact`: padded like the other items of a status bar. */
  size?: 'compact'
}): JSX.Element {
  return (
    <button
      type="button"
      class="dinkster-fixes-count"
      data-count={props.count}
      data-size={props.size}
      onClick={() => props.onOpen()}
    >
      {props.label}
    </button>
  )
}
