import { For, Match, Show, Switch, mergeProps, type JSX } from 'solid-js'
import {
  ChevronDown,
  ChevronRight,
  Eye,
  GripVertical,
  TriangleAlert,
} from 'lucide-solid'
import { ProductIcon } from './controls.js'

/** One input or output of a subgraph node, as the Boundary panel lists it. */
export interface BoundaryTreeRow {
  readonly kind: 'row'
  readonly id: string
  readonly side: 'input' | 'output'
  readonly label: string
  /** The type's color, as pins of that type are drawn on the canvas. */
  readonly color: string
  /** The inner node the row goes to or comes from, in quiet text. */
  readonly target?: string
  /** The row has a "Show" condition. */
  readonly condition?: boolean
  /** The row is inert: it stays in its place and says why. */
  readonly problem?: string
}

/** Two to four input rows that share one line on the subgraph node. */
export interface BoundaryTreeLine {
  readonly kind: 'line'
  readonly id: string
  readonly rows: readonly BoundaryTreeRow[]
}

/** A box that opens and closes. Layout only: its rows keep their ids and values. */
export interface BoundaryTreeSection {
  readonly kind: 'section'
  readonly id: string
  readonly label: string
  readonly open: boolean
  /** False: the open box shows no name, only the tab that closes it. */
  readonly nameWhileOpen?: boolean
  readonly rows: readonly BoundaryTreeEntry[]
}

/** A row of a construct's template: what each member or option holds. */
export interface BoundaryTreeTemplateRow {
  readonly label: string
  readonly side: 'input' | 'output'
  readonly color: string
}

/** A whole group, choice, type choice or described row shown on the node. */
export interface BoundaryTreeConstruct {
  readonly kind: 'construct'
  readonly id: string
  readonly construct: 'group' | 'choice' | 'typeChoice' | 'described'
  readonly side: 'input' | 'output'
  readonly label: string
  readonly color?: string
  readonly target?: string
  /** What the construct is, in quiet text, such as "growing group". */
  readonly note: string
  /** A line before the template, such as the definition's own members. */
  readonly interior?: string
  /** The heading of the template, such as "Each member" or "Options". */
  readonly templateLabel: string
  readonly template: readonly BoundaryTreeTemplateRow[]
  readonly problem?: string
}

export type BoundaryTreeEntry =
  | BoundaryTreeRow
  | BoundaryTreeLine
  | BoundaryTreeSection
  | BoundaryTreeConstruct

/**
 * Where a dragged row would go: an empty slot that opens among the rows of a
 * section (or the top level), or the pocket at the right end of a line.
 */
export type BoundaryTreeDrop =
  | { readonly kind: 'slot'; readonly section?: string; readonly index: number }
  | { readonly kind: 'pocket'; readonly line: string }

/** A row being dragged: it lifts out of the list until it is dropped. */
export interface BoundaryTreeDrag {
  readonly id: string
  readonly drop?: BoundaryTreeDrop
}

export const defaultBoundaryTreeStrings = {
  rows: 'Rows on the subgraph node',
  move: 'Drag to move',
  open: 'Open section',
  close: 'Close section',
  condition: 'Has a Show condition',
  problem: 'Has a problem',
  closedRows: (count: number) => (count === 1 ? '1 row' : `${count} rows`),
}

export type BoundaryTreeStrings = typeof defaultBoundaryTreeStrings

const rowCount = (entries: readonly BoundaryTreeEntry[]): number =>
  entries.reduce(
    (count, entry) =>
      count +
      (entry.kind === 'section'
        ? rowCount(entry.rows)
        : entry.kind === 'line'
          ? entry.rows.length
          : 1),
    0,
  )

const findEntry = (
  entries: readonly BoundaryTreeEntry[],
  id: string,
): BoundaryTreeRow | BoundaryTreeEntry | undefined => {
  for (const entry of entries) {
    if (entry.id === id) return entry
    if (entry.kind === 'section') {
      const found = findEntry(entry.rows, id)
      if (found) return found
    }
    if (entry.kind === 'line') {
      const found = entry.rows.find((row) => row.id === id)
      if (found) return found
    }
  }
  return undefined
}

/** Pixels a press moves before it becomes a drag. */
const DRAG_THRESHOLD = 4

function Dot(props: { color: string | undefined }) {
  return (
    <svg class="boundary-tree-dot" viewBox="0 0 8 8" aria-hidden="true">
      <circle cx={4} cy={4} r={4} fill={props.color ?? 'currentColor'} />
    </svg>
  )
}

/**
 * The Boundary panel's rows as one ordered tree: rows, lines of fields,
 * sections and whole constructs in the order the subgraph node draws them.
 * An output keeps its own line, label and grip at the right end, where its
 * pin is on the node.
 */
export function BoundaryTree(props: {
  readonly entries: readonly BoundaryTreeEntry[]
  readonly selected?: string | undefined
  readonly drag?: BoundaryTreeDrag | undefined
  readonly onSelect?: ((id: string) => void) | undefined
  /** A press on a row's body that moves past the drag threshold: the row with this id is picked up. */
  readonly onDragStart?: ((id: string) => void) | undefined
  readonly onToggle?: ((sectionId: string) => void) | undefined
  readonly strings?: Partial<BoundaryTreeStrings> | undefined
}) {
  const strings = mergeProps(defaultBoundaryTreeStrings, () => props.strings)
  // A press that moves past the threshold drags; one that does not selects.
  let pressDragged = false
  const select = (id: string) => () => {
    if (pressDragged) {
      pressDragged = false
      return
    }
    props.onSelect?.(id)
  }
  const press = (id: string) => (event: PointerEvent) => {
    if (event.button !== 0) return
    if ((event.target as Element).closest('.boundary-tree-chevron, .boundary-tree-tab, a, button, input')) return
    event.stopPropagation()
    pressDragged = false
    const start = { x: event.clientX, y: event.clientY }
    const move = (moved: PointerEvent) => {
      if (Math.hypot(moved.clientX - start.x, moved.clientY - start.y) < DRAG_THRESHOLD) return
      pressDragged = true
      stop()
      props.onDragStart?.(id)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }
  const dragged = () =>
    props.drag === undefined
      ? undefined
      : findEntry(props.entries, props.drag.id)
  const isDragged = (id: string) => props.drag?.id === id

  const Grip = () => (
    <span class="boundary-tree-grip" title={strings.move}>
      <ProductIcon icon={GripVertical} />
    </span>
  )

  const Marks = (markProps: {
    condition?: boolean | undefined
    problem?: string | undefined
  }) => (
    <>
      <Show when={markProps.condition}>
        <span class="boundary-tree-mark" title={strings.condition}>
          <ProductIcon icon={Eye} />
        </span>
      </Show>
      <Show when={markProps.problem}>
        <span
          class="boundary-tree-mark"
          data-mark="problem"
          title={markProps.problem}
        >
          <ProductIcon icon={TriangleAlert} />
        </span>
      </Show>
    </>
  )

  const Row = (rowProps: {
    row: BoundaryTreeRow
    level: number
    lifted?: boolean
  }) => (
    <div
      class={
        rowProps.lifted
          ? 'boundary-tree-row boundary-tree-lifted'
          : 'boundary-tree-row'
      }
      role="treeitem"
      aria-level={rowProps.level}
      aria-selected={props.selected === rowProps.row.id}
      data-side={rowProps.row.side}
      data-inert={rowProps.row.problem ? '' : undefined}
      onPointerDown={press(rowProps.row.id)}
      onClick={select(rowProps.row.id)}
    >
      <Show
        when={rowProps.row.side === 'output'}
        fallback={
          <>
            <Grip />
            <Dot color={rowProps.row.color} />
            <span class="boundary-tree-label">{rowProps.row.label}</span>
            <Marks
              condition={rowProps.row.condition}
              problem={rowProps.row.problem}
            />
            <Show when={rowProps.row.target}>
              <span class="boundary-tree-target">{rowProps.row.target}</span>
            </Show>
          </>
        }
      >
        <Show when={rowProps.row.target}>
          <span class="boundary-tree-target" data-align="start">
            {rowProps.row.target}
          </span>
        </Show>
        <Marks
          condition={rowProps.row.condition}
          problem={rowProps.row.problem}
        />
        <span class="boundary-tree-label">{rowProps.row.label}</span>
        <Dot color={rowProps.row.color} />
        <Grip />
      </Show>
    </div>
  )

  const Line = (lineProps: { line: BoundaryTreeLine; level: number }) => {
    const pocket = () =>
      props.drag?.drop?.kind === 'pocket' &&
      props.drag.drop.line === lineProps.line.id
    return (
      <div
        class="boundary-tree-line"
        role="treeitem"
        aria-level={lineProps.level}
        aria-selected={props.selected === lineProps.line.id}
        data-pocket={pocket() ? '' : undefined}
        onPointerDown={press(lineProps.line.id)}
        onClick={select(lineProps.line.id)}
      >
        <span class="boundary-tree-line-grip">
          <Grip />
        </span>
        <For each={lineProps.line.rows.filter((row) => !isDragged(row.id))}>
          {(row) => (
            <span
              class="boundary-tree-cell"
              role="treeitem"
              aria-level={lineProps.level + 1}
              aria-selected={props.selected === row.id}
              data-inert={row.problem ? '' : undefined}
              onPointerDown={press(row.id)}
              onClick={(event) => {
                event.stopPropagation()
                select(row.id)()
              }}
            >
              <Dot color={row.color} />
              <span class="boundary-tree-label" title={row.label}>
                {row.label}
              </span>
              <Marks condition={row.condition} problem={row.problem} />
            </span>
          )}
        </For>
        <Show when={pocket() && dragged()?.kind === 'row'}>
          <span class="boundary-tree-pocket">
            <Dot color={(dragged() as BoundaryTreeRow).color} />
            <span class="boundary-tree-label">
              {(dragged() as BoundaryTreeRow).label}
            </span>
          </span>
        </Show>
      </div>
    )
  }

  const Construct = (constructProps: {
    construct: BoundaryTreeConstruct
    level: number
  }) => (
    <div
      class="boundary-tree-box"
      role="treeitem"
      aria-level={constructProps.level}
      aria-selected={props.selected === constructProps.construct.id}
      aria-expanded={true}
      data-construct={constructProps.construct.construct}
      data-inert={constructProps.construct.problem ? '' : undefined}
    >
      <div
        class="boundary-tree-row boundary-tree-header"
        data-side={constructProps.construct.side}
        aria-selected={props.selected === constructProps.construct.id}
        onPointerDown={press(constructProps.construct.id)}
        onClick={select(constructProps.construct.id)}
      >
        <Show when={constructProps.construct.side === 'input'}>
          <Grip />
        </Show>
        <Dot color={constructProps.construct.color} />
        <span class="boundary-tree-label boundary-tree-name">
          {constructProps.construct.label}
        </span>
        <span class="boundary-tree-note">{constructProps.construct.note}</span>
        <Marks problem={constructProps.construct.problem} />
        <Show when={constructProps.construct.target}>
          <span class="boundary-tree-target">
            {constructProps.construct.target}
          </span>
        </Show>
        <Show when={constructProps.construct.side === 'output'}>
          <Grip />
        </Show>
      </div>
      <Show when={constructProps.construct.interior}>
        <div class="boundary-tree-interior">
          {constructProps.construct.interior}
        </div>
      </Show>
      <div class="boundary-tree-template" role="group">
        <span class="boundary-tree-template-label">
          {constructProps.construct.templateLabel}
        </span>
        <For each={constructProps.construct.template}>
          {(row) => (
            <span class="boundary-tree-template-row" data-side={row.side}>
              <Dot color={row.color} />
              <span class="boundary-tree-label">{row.label}</span>
            </span>
          )}
        </For>
      </div>
    </div>
  )

  const Section = (sectionProps: {
    section: BoundaryTreeSection
    level: number
  }) => {
    const named = () =>
      sectionProps.section.nameWhileOpen !== false || !sectionProps.section.open
    return (
      <div
        class="boundary-tree-box"
        role="treeitem"
        aria-level={sectionProps.level}
        aria-selected={props.selected === sectionProps.section.id}
        aria-expanded={sectionProps.section.open}
        aria-label={sectionProps.section.label}
        data-open={sectionProps.section.open ? '' : undefined}
        data-named={named() ? '' : undefined}
      >
        <Show
          when={named()}
          fallback={
            <span
              class="boundary-tree-tab"
              title={strings.close}
              onClick={() => props.onToggle?.(sectionProps.section.id)}
            >
              <ProductIcon icon={ChevronDown} />
            </span>
          }
        >
          <div
            class="boundary-tree-row boundary-tree-header"
            data-side="input"
            aria-selected={props.selected === sectionProps.section.id}
            onPointerDown={press(sectionProps.section.id)}
            onClick={select(sectionProps.section.id)}
          >
            <Grip />
            <span
              class="boundary-tree-chevron"
              title={sectionProps.section.open ? strings.close : strings.open}
              onClick={(event) => {
                event.stopPropagation()
                props.onToggle?.(sectionProps.section.id)
              }}
            >
              <ProductIcon
                icon={sectionProps.section.open ? ChevronDown : ChevronRight}
              />
            </span>
            <span class="boundary-tree-label boundary-tree-name">
              {sectionProps.section.label}
            </span>
            <Show when={!sectionProps.section.open}>
              <span class="boundary-tree-note">
                {strings.closedRows(rowCount(sectionProps.section.rows))}
              </span>
            </Show>
          </div>
        </Show>
        <Show when={sectionProps.section.open}>
          <div class="boundary-tree-children" role="group">
            <Entries
              entries={sectionProps.section.rows}
              section={sectionProps.section.id}
              level={sectionProps.level + 1}
            />
          </div>
        </Show>
      </div>
    )
  }

  const Slot = () => (
    <div class="boundary-tree-slot">
      <Show when={dragged()?.kind === 'row'}>
        <Row row={dragged() as BoundaryTreeRow} level={1} lifted />
      </Show>
    </div>
  )

  function Entries(entriesProps: {
    entries: readonly BoundaryTreeEntry[]
    section?: string
    level: number
  }): JSX.Element {
    const slotAt = () => {
      const drop = props.drag?.drop
      return drop?.kind === 'slot' && drop.section === entriesProps.section
        ? drop.index
        : undefined
    }
    const visible = () =>
      entriesProps.entries.filter((entry) => !isDragged(entry.id))
    return (
      <>
        <For each={visible()}>
          {(entry, index) => (
            <>
              <Show when={slotAt() === index()}>
                <Slot />
              </Show>
              <Switch>
                <Match when={entry.kind === 'row'}>
                  <Row
                    row={entry as BoundaryTreeRow}
                    level={entriesProps.level}
                  />
                </Match>
                <Match when={entry.kind === 'line'}>
                  <Line
                    line={entry as BoundaryTreeLine}
                    level={entriesProps.level}
                  />
                </Match>
                <Match when={entry.kind === 'section'}>
                  <Section
                    section={entry as BoundaryTreeSection}
                    level={entriesProps.level}
                  />
                </Match>
                <Match when={entry.kind === 'construct'}>
                  <Construct
                    construct={entry as BoundaryTreeConstruct}
                    level={entriesProps.level}
                  />
                </Match>
              </Switch>
            </>
          )}
        </For>
        <Show when={slotAt() !== undefined && slotAt()! >= visible().length}>
          <Slot />
        </Show>
      </>
    )
  }

  return (
    <div
      class="boundary-tree"
      role="tree"
      aria-label={strings.rows}
      data-dragging={props.drag ? '' : undefined}
    >
      <Entries entries={props.entries} level={1} />
    </div>
  )
}
