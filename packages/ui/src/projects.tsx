import {
  For,
  Index,
  Show,
  createContext,
  createMemo,
  createUniqueId,
  mergeProps,
  useContext,
  type JSX,
} from 'solid-js'
import { ChevronLeft, Plus, TriangleAlert } from 'lucide-solid'
import { ProductButton, ProductIcon, ProductTextButton } from './controls.js'
import { ProductDisclosure } from './account.js'

/** One project in the projects page's list. */
export interface ProductProjectEntry {
  id: string
  name: string
  /** When it was last opened, or what is happening to it now. */
  detail: string
  /** Why the detail says what it does, shown on hover, such as why a project opens in its own editor. */
  reason?: string | undefined
  /** Opening shows progress under the row; failed marks it with a warning. */
  state?: 'opening' | 'failed' | 'draft' | undefined
}

const ProjectBack = createContext<() => JSX.Element>()

/** The projects page body: the list on the left and one project on the right. */
export function ProductProjectsView(props: {
  list?: JSX.Element
  children: JSX.Element
  narrowPanel?: 'list' | 'detail'
  back?: { label: string; onSelect: () => void; disabled?: boolean }
}) {
  let backButton: HTMLDivElement | undefined
  return (
    <ProjectBack.Provider
      value={() => (
        <Show when={props.back}>
          {(back) => (
            <div class="dinkster-projects-back" ref={backButton}>
              <ProductTextButton
                label={back().label}
                icon={ChevronLeft}
                disabled={back().disabled}
                onClick={() => back().onSelect()}
              />
            </div>
          )}
        </Show>
      )}
    >
      <div
        class="dinkster-projects-viewport"
        onKeyDown={(event) => {
          if (
            event.key !== 'Escape' ||
            event.defaultPrevented ||
            props.back?.disabled ||
            !backButton?.getClientRects().length
          )
            return
          if (
            (event.target as Element).closest(
              'input, textarea, select, [contenteditable="true"], dialog, [role="menu"]',
            )
          )
            return
          event.preventDefault()
          props.back?.onSelect()
        }}
      >
        <div
          class="dinkster-projects"
          data-list={props.list ? undefined : 'none'}
          data-narrow-panel={props.narrowPanel ?? 'detail'}
        >
          <Show when={props.list}>
            <div class="dinkster-projects-panel dinkster-projects-list">
              {props.list}
            </div>
          </Show>
          <div class="dinkster-projects-panel dinkster-projects-detail">
            {props.children}
          </div>
        </div>
      </div>
    </ProjectBack.Provider>
  )
}

/**
 * The project list. Selection follows the arrow keys, as in a list box; the
 * selected project shows on the right. `projects` is undefined while loading.
 */
export function ProductProjectList(props: {
  title: string
  newLabel: string
  onNew: () => void
  projects: readonly ProductProjectEntry[] | undefined
  selected: string | undefined
  onSelect: (id: string) => void
  loadingLabel: string
  /** A separate action cell keeps controls out of selection options. */
  action?: ((project: ProductProjectEntry) => JSX.Element) | undefined
  /**
   * Deleted projects, under a closed disclosure after the last project. Their
   * rows cannot be selected; only Restore acts. Absent when there are none.
   */
  deleted?: {
    title: string
    restoreLabel: string
    rows: readonly { id: string; name: string; detail: string }[]
    onRestore: (id: string) => void
  }
}) {
  const heading = createUniqueId()
  return (
    <>
      <ProductProjectListHeader
        id={heading}
        title={props.title}
        newLabel={props.newLabel}
        onNew={props.onNew}
      />
      <ProductProjectRows
        labelledBy={heading}
        projects={props.projects}
        selected={props.selected}
        onSelect={props.onSelect}
        loadingLabel={props.loadingLabel}
        action={props.action}
        deleted={props.deleted}
      />
    </>
  )
}

/** The known project-list heading and action stay outside loaded rows. */
export function ProductProjectListHeader(props: {
  id: string
  title: string
  newLabel: string
  onNew: () => void
}) {
  return (
    <header class="dinkster-projects-list-header">
      <h1 id={props.id} class="dinkster-title">
        {props.title}
      </h1>
      <ProductButton onClick={() => props.onNew()}>
        <ProductIcon icon={Plus} />
        {props.newLabel}
      </ProductButton>
    </header>
  )
}

/** Rows can arrive separately, labelled by their persistent heading. */
export function ProductProjectRows(props: {
  labelledBy: string
  projects: readonly ProductProjectEntry[] | undefined
  selected: string | undefined
  onSelect: (id: string) => void
  loadingLabel: string
  /** Present for the grid's lifetime, even when no row currently has an action. */
  action?: ((project: ProductProjectEntry) => JSX.Element) | undefined
  deleted?:
    | {
        title: string
        restoreLabel: string
        rows: readonly { id: string; name: string; detail: string }[]
        onRestore: (id: string) => void
      }
    | undefined
}) {
  let list!: HTMLUListElement
  const entries = createMemo(
    () => new Map(props.projects?.map((project) => [project.id, project])),
  )
  const move = (event: KeyboardEvent) => {
    const cell = (event.target as HTMLElement).closest('[role="gridcell"]')
    const actionColumn = cell?.hasAttribute('data-project-action')
    if (props.action && event.key === 'ArrowLeft' && actionColumn) {
      event.preventDefault()
      cell?.parentElement
        ?.querySelector<HTMLElement>('[data-project-selection]')
        ?.focus()
      return
    }
    if (props.action && event.target !== cell && !actionColumn) return
    if (props.action && event.key === 'ArrowRight') {
      const action = cell?.parentElement?.querySelector<HTMLButtonElement>(
        'button:not(:disabled)',
      )
      if (action) {
        event.preventDefault()
        action.focus()
      }
      return
    }
    const projects = props.projects ?? []
    const selection = cell?.parentElement?.querySelector(
      '[data-project-selection]',
    )
    const index = props.action
      ? [...list.querySelectorAll('[data-project-selection]')].indexOf(
          selection!,
        )
      : projects.findIndex((project) => project.id === props.selected)
    const next =
      event.key === 'ArrowDown'
        ? Math.min(projects.length - 1, index + 1)
        : event.key === 'ArrowUp'
          ? Math.max(0, index - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? projects.length - 1
              : undefined
    if (next === undefined || !projects[next]) return
    event.preventDefault()
    const nextSelection = list.querySelectorAll<HTMLElement>(
      '[data-project-selection]',
    )[next]
    if (!actionColumn) props.onSelect(projects[next].id)
    const nextAction = actionColumn
      ? nextSelection?.parentElement?.querySelector<HTMLButtonElement>(
          'button:not(:disabled)',
        )
      : undefined
    ;(nextAction ?? nextSelection)?.focus()
  }
  return (
    <div class="dinkster-projects-row-group">
      <Show
        when={props.projects}
        fallback={
          <div class="dinkster-projects-rows" role="status">
            <span class="dinkster-visually-hidden">{props.loadingLabel}</span>
            <Index each={[0, 1, 2, 3, 4]}>
              {() => <div class="dinkster-skeleton" data-shape="row" />}
            </Index>
          </div>
        }
      >
        {(projects) => (
          <ul
            ref={list}
            class="dinkster-projects-rows"
            role={props.action ? 'grid' : 'listbox'}
            aria-labelledby={props.labelledBy}
            onKeyDown={move}
          >
            <For each={projects().map((project) => project.id)}>
              {(id) => {
                const project = mergeProps(() => entries().get(id)!)
                const copy = () => (
                  <>
                    <span class="dinkster-project-row-name">
                      {project.name}
                    </span>
                    <span
                      class="dinkster-project-row-detail"
                      title={project.reason}
                    >
                      <Show when={project.state === 'failed'}>
                        <ProductIcon icon={TriangleAlert} />
                      </Show>
                      {project.detail}
                    </span>
                  </>
                )
                return (
                  <li
                    class="dinkster-project-row"
                    role={props.action ? 'row' : 'option'}
                    aria-selected={project.id === props.selected}
                    tabindex={
                      props.action
                        ? undefined
                        : project.id === props.selected
                          ? 0
                          : -1
                    }
                    data-project-selection={props.action ? undefined : ''}
                    data-state={project.state}
                    data-actions={props.action ? '' : undefined}
                    onClick={() => {
                      if (!props.action) props.onSelect(project.id)
                    }}
                  >
                    <Show when={props.action} fallback={copy()}>
                      {(action) => (
                        <>
                          <div
                            class="dinkster-project-row-copy"
                            role="gridcell"
                            data-project-selection=""
                            tabindex={project.id === props.selected ? 0 : -1}
                            onClick={() => props.onSelect(project.id)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                props.onSelect(project.id)
                              }
                            }}
                          >
                            {copy()}
                          </div>
                          <div
                            class="dinkster-project-row-action"
                            role="gridcell"
                            data-project-action=""
                            on:click={{
                              capture: true,
                              handleEvent: (event) => {
                                const cell = event.currentTarget
                                const button = (
                                  event.target as HTMLElement
                                ).closest('button')
                                if (
                                  !button ||
                                  document.activeElement !== button
                                )
                                  return
                                queueMicrotask(() => {
                                  if (
                                    cell.isConnected &&
                                    (button.disabled || !button.isConnected) &&
                                    (document.activeElement === button ||
                                      document.activeElement === document.body)
                                  ) {
                                    cell.parentElement
                                      ?.querySelector<HTMLElement>(
                                        '[data-project-selection]',
                                      )
                                      ?.focus()
                                  }
                                })
                              },
                            }}
                          >
                            {action()(project)}
                          </div>
                        </>
                      )}
                    </Show>
                    <Show when={project.state === 'opening'}>
                      <span class="dinkster-progress" aria-hidden="true" />
                    </Show>
                  </li>
                )
              }}
            </For>
          </ul>
        )}
      </Show>
      <Show when={props.deleted?.rows.length ? props.deleted : undefined}>
        {(deleted) => (
          <ProductDisclosure title={deleted().title}>
            <ul
              class="dinkster-projects-rows"
              data-testid="deleted-projects"
              aria-label={deleted().title}
            >
              <For each={deleted().rows}>
                {(row) => {
                  const name = createUniqueId()
                  return (
                    <li class="dinkster-project-row" data-state="deleted">
                      <span id={name} class="dinkster-project-row-name">
                        {row.name}
                      </span>
                      <span class="dinkster-project-row-detail">
                        {row.detail}
                      </span>
                      <ProductTextButton
                        label={deleted().restoreLabel}
                        aria-describedby={name}
                        onClick={() => deleted().onRestore(row.id)}
                      />
                    </li>
                  )
                }}
              </For>
            </ul>
          </ProductDisclosure>
        )}
      </Show>
    </div>
  )
}

/** The selected project's name, when it was opened, and its actions. */
export function ProductProjectHeader(props: {
  title: string
  subtitle?: string | undefined
  actions?: JSX.Element
}) {
  const back = useContext(ProjectBack)
  return (
    <header class="dinkster-project-header">
      {back?.()}
      <div class="dinkster-project-header-copy">
        <h2 class="dinkster-title">{props.title}</h2>
        <Show when={props.subtitle}>
          <p class="dinkster-description">{props.subtitle}</p>
        </Show>
      </div>
      <div class="dinkster-actions">{props.actions}</div>
    </header>
  )
}

/** One fact of a project, such as where its files are, with an optional action on it. */
export interface ProductProjectFact {
  label: string
  value: JSX.Element
  detail?: string | undefined
  action?: JSX.Element
}

/**
 * A project's facts in two equal boxes, one per column, so each action sits
 * at the right edge of the box that holds its fact. An empty column draws no
 * box and leaves its half of the width empty.
 */
export function ProductProjectFacts(props: {
  label: string
  columns: readonly [
    readonly ProductProjectFact[],
    readonly ProductProjectFact[],
  ]
}) {
  return (
    <div class="dinkster-project-facts" role="group" aria-label={props.label}>
      <Index each={props.columns}>
        {(column) => (
          <Show when={column().length > 0}>
            <dl class="dinkster-project-facts-box">
              <For each={column()}>
                {(item) => (
                  <div class="dinkster-project-fact">
                    <dt>{item.label}</dt>
                    <dd>
                      <div class="dinkster-project-fact-value">
                        {item.value}
                        <Show when={item.detail}>
                          <span class="dinkster-project-fact-detail">
                            {' - '}
                            {item.detail}
                          </span>
                        </Show>
                      </div>
                      {item.action}
                    </dd>
                  </div>
                )}
              </For>
            </dl>
          </Show>
        )}
      </Index>
    </div>
  )
}

/** A titled part of the project detail, such as its workflows, with a count or action at its end. */
export function ProductProjectSection(props: {
  title: string
  aside?: JSX.Element
  children?: JSX.Element
}) {
  const id = createUniqueId()
  return (
    <section class="dinkster-project-section" aria-labelledby={id}>
      <header class="dinkster-project-section-header">
        <h3 id={id} class="dinkster-project-section-title">
          {props.title}
        </h3>
        {props.aside}
      </header>
      {props.children}
    </section>
  )
}

/** Tiles in rows: `wide` for workflow previews, `narrow` for output pictures. */
export function ProductTileGrid(props: {
  size: 'wide' | 'narrow'
  children: JSX.Element
}) {
  return (
    <div class="dinkster-tile-grid" data-size={props.size}>
      {props.children}
    </div>
  )
}

/** A placeholder in the shape of what is loading. */
export function ProductSkeleton(props: {
  shape: 'row' | 'title' | 'line' | 'tile'
}) {
  return (
    <div
      class="dinkster-skeleton"
      data-shape={props.shape}
      aria-hidden="true"
    />
  )
}
