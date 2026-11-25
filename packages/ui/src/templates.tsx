import {
  For,
  Index,
  Show,
  createEffect,
  createUniqueId,
  type JSX,
} from 'solid-js'
import { Check, Download, Search } from 'lucide-solid'
import { ProductIcon, ProductTextInput } from './controls.js'

/** One template on the Templates page. */
export interface ProductTemplateEntry {
  id: string
  name: string
  /** The line under the name: the model family, or that it needs no models. */
  family: string
  /** Address of a result made with the template. Without one, its workflow is drawn instead. */
  picture?: string | undefined
  /** A video result's length, such as 0:05. */
  length?: string | undefined
  /** How much is left to download, such as 6.4 GB. Absent when every model is here. */
  missing?: string | undefined
  /** While its models download, how far along they are, from 0 to 1. */
  progress?: number | undefined
}

/** One group on the left of the Templates page, such as Image or SDXL. */
export interface ProductTemplateGroup {
  id: string
  label: string
  count: number
}

/** The picture of a template: its result, or its workflow drawn when it has none. */
function TemplatePicture(props: {
  entry: ProductTemplateEntry
  drawing: (entry: ProductTemplateEntry) => JSX.Element
  marks?: boolean
}) {
  let progress: HTMLSpanElement | undefined
  createEffect(() => {
    if (progress && props.entry.progress !== undefined)
      progress.style.width = `${Math.round(props.entry.progress * 100)}%`
  })
  return (
    <span class="dinkster-template-picture">
      <Show when={props.entry.picture} fallback={props.drawing(props.entry)}>
        {(picture) => <img src={picture()} alt="" />}
      </Show>
      <Show when={props.marks}>
        <Show when={props.entry.length}>
          <span class="dinkster-template-mark" data-place="end">
            {props.entry.length}
          </span>
        </Show>
        <Show
          when={
            props.entry.progress !== undefined ? (
              `${Math.round(props.entry.progress * 100)}%`
            ) : (
              props.entry.missing
            )
          }
        >
          {(amount) => (
            <span class="dinkster-template-mark">
              <ProductIcon icon={Download} />
              {amount()}
            </span>
          )}
        </Show>
        <Show when={props.entry.progress !== undefined}>
          <span
            ref={progress}
            class="dinkster-template-progress"
            aria-hidden="true"
          />
        </Show>
      </Show>
    </span>
  )
}

/**
 * Template tiles to pick from. One click selects, a double click or Enter
 * opens; the arrow keys move the selection across and down the rows.
 */
export function ProductTemplateTiles(props: {
  label: string
  templates: readonly ProductTemplateEntry[]
  selected: string | undefined
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  drawing: (entry: ProductTemplateEntry) => JSX.Element
}) {
  let list!: HTMLUListElement
  const move = (event: KeyboardEvent) => {
    const templates = props.templates
    const index = templates.findIndex(
      (template) => template.id === props.selected,
    )
    if (event.key === 'Enter' && templates[index]) {
      event.preventDefault()
      props.onOpen(templates[index].id)
      return
    }
    const tiles = [...list.querySelectorAll<HTMLElement>('[role="option"]')]
    const top = tiles[0]?.offsetTop
    const columns = Math.max(
      1,
      tiles.filter((tile) => tile.offsetTop === top).length,
    )
    const next =
      event.key === 'ArrowRight'
        ? index + 1
        : event.key === 'ArrowLeft'
          ? index - 1
          : event.key === 'ArrowDown'
            ? index + columns
            : event.key === 'ArrowUp'
              ? index - columns
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? templates.length - 1
                  : undefined
    if (next === undefined) return
    event.preventDefault()
    const target = templates[Math.min(templates.length - 1, Math.max(0, next))]
    if (!target) return
    props.onSelect(target.id)
    tiles[templates.indexOf(target)]?.focus()
  }
  const focusable = (id: string, index: number) =>
    props.templates.some((template) => template.id === props.selected)
      ? id === props.selected
      : index === 0
  return (
    <ul
      ref={list}
      class="dinkster-template-tiles"
      role="listbox"
      aria-label={props.label}
      onKeyDown={move}
    >
      <For each={props.templates}>
        {(template, index) => (
          <li
            class="dinkster-template-tile"
            role="option"
            aria-selected={template.id === props.selected}
            tabindex={focusable(template.id, index()) ? 0 : -1}
            onClick={() => props.onSelect(template.id)}
            onDblClick={() => props.onOpen(template.id)}
          >
            <TemplatePicture entry={template} drawing={props.drawing} marks />
            <span class="dinkster-template-caption">
              <span class="dinkster-template-name">{template.name}</span>
              <span class="dinkster-template-family">{template.family}</span>
            </span>
          </li>
        )}
      </For>
    </ul>
  )
}

/**
 * The Templates page: groups on the left, the search and the tiles in the
 * middle, and the selected template on the right. `templates` is undefined
 * while loading.
 */
export function ProductTemplatesPage(props: {
  title: string
  groups: readonly {
    label: string
    rows: readonly ProductTemplateGroup[]
  }[]
  group: string
  onGroup: (id: string) => void
  searchLabel: string
  search: string
  onSearch: (value: string) => void
  /** The way out, such as a "Blank workflow" button. */
  leave: JSX.Element
  templates: readonly ProductTemplateEntry[] | undefined
  selected: string | undefined
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  drawing: (entry: ProductTemplateEntry) => JSX.Element
  loadingLabel: string
  /** Shown in place of the tiles when no template is in the group or matches the search. */
  empty: string
  children?: JSX.Element
}) {
  const heading = createUniqueId()
  const moveGroup = (event: KeyboardEvent) => {
    const rows = props.groups.flatMap((group) => group.rows)
    const index = rows.findIndex((row) => row.id === props.group)
    const next =
      event.key === 'ArrowDown'
        ? index + 1
        : event.key === 'ArrowUp'
          ? index - 1
          : undefined
    const target = next === undefined ? undefined : rows[next]
    if (!target) return
    event.preventDefault()
    props.onGroup(target.id)
    ;(event.currentTarget as HTMLElement)
      .closest('.dinkster-templates-groups')
      ?.querySelector<HTMLElement>(`[data-group="${CSS.escape(target.id)}"]`)
      ?.focus()
  }
  return (
    <div class="dinkster-templates" role="region" aria-labelledby={heading}>
      <div class="dinkster-templates-groups">
        <h1 id={heading} class="dinkster-title">
          {props.title}
        </h1>
        <For each={props.groups}>
          {(group) => {
            const label = createUniqueId()
            return (
              <>
                <span id={label} class="dinkster-templates-group-label">
                  {group.label}
                </span>
                <ul
                  class="dinkster-list-rows"
                  role="listbox"
                  aria-labelledby={label}
                  onKeyDown={moveGroup}
                >
                  <For each={group.rows}>
                    {(row) => (
                      <li
                        class="dinkster-list-row"
                        role="option"
                        data-group={row.id}
                        aria-selected={row.id === props.group}
                        tabindex={row.id === props.group ? 0 : -1}
                        onClick={() => props.onGroup(row.id)}
                      >
                        <span class="dinkster-list-row-name">{row.label}</span>
                        <span class="dinkster-list-row-detail">{row.count}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </>
            )
          }}
        </For>
      </div>
      <div class="dinkster-templates-main">
        <div class="dinkster-templates-bar">
          <span class="dinkster-templates-search">
            <ProductIcon icon={Search} />
            <ProductTextInput
              type="search"
              aria-label={props.searchLabel}
              placeholder={props.searchLabel}
              value={props.search}
              onInput={(event) => props.onSearch(event.currentTarget.value)}
            />
          </span>
          {props.leave}
        </div>
        <Show
          when={props.templates}
          fallback={
            <div class="dinkster-template-tiles" role="status">
              <span class="dinkster-visually-hidden">{props.loadingLabel}</span>
              <Index each={[0, 1, 2, 3, 4, 5]}>
                {() => (
                  <div class="dinkster-template-tile" aria-hidden="true">
                    <span class="dinkster-template-picture" />
                    <span class="dinkster-template-caption">
                      <span class="dinkster-skeleton" data-shape="line" />
                    </span>
                  </div>
                )}
              </Index>
            </div>
          }
        >
          {(templates) => (
            <Show
              when={templates().length > 0}
              fallback={<p class="dinkster-templates-empty">{props.empty}</p>}
            >
              <ProductTemplateTiles
                label={props.title}
                templates={templates()}
                selected={props.selected}
                onSelect={props.onSelect}
                onOpen={props.onOpen}
                drawing={props.drawing}
              />
            </Show>
          )}
        </Show>
      </div>
      <Show when={props.children}>
        <aside class="dinkster-template-detail">
          {props.children}
        </aside>
      </Show>
    </div>
  )
}

/** One model a template needs, and whether it is on this computer. */
export interface ProductTemplateModel {
  name: string
  size?: string | undefined
  here: boolean
}

/**
 * The selected template: its picture with a switch to its workflow, what it
 * is, the models it needs, where it comes from, and its actions.
 */
export function ProductTemplateDetail(props: {
  template: ProductTemplateEntry
  drawing: (entry: ProductTemplateEntry) => JSX.Element
  /** Which view the picture shows; without a result picture only the workflow is shown. */
  view: 'result' | 'workflow'
  onView: (view: 'result' | 'workflow') => void
  viewLabels: { result: string; workflow: string }
  /** The second line, such as "SDXL - Image". */
  summary: string
  description?: string | undefined
  needs?:
    | {
        label: string
        /** Such as "1 of 3 on this computer". */
        summary: string
        hereLabel: string
        missingLabel: string
        models: readonly ProductTemplateModel[]
      }
    | undefined
  facts: readonly { label: string; value: string; detail?: string }[]
  actions: JSX.Element
}) {
  const heading = createUniqueId()
  const view = () => (props.template.picture ? props.view : 'workflow')
  const views = ['result', 'workflow'] as const
  const switchView = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next = view() === 'result' ? 'workflow' : 'result'
    props.onView(next)
    ;(event.currentTarget as HTMLElement)
      .querySelector<HTMLElement>(`[data-view="${next}"]`)
      ?.focus()
  }
  return (
    <>
      <TemplatePicture
        entry={
          view() === 'workflow'
            ? { ...props.template, picture: undefined }
            : props.template
        }
        drawing={props.drawing}
      />
      <Show when={props.template.picture}>
        <div
          class="dinkster-template-views"
          role="tablist"
          aria-label={props.template.name}
          onKeyDown={switchView}
        >
          <For each={views}>
            {(option) => (
              <span
                class="dinkster-template-view"
                role="tab"
                data-view={option}
                aria-selected={view() === option}
                tabindex={view() === option ? 0 : -1}
                onClick={() => props.onView(option)}
              >
                {props.viewLabels[option]}
              </span>
            )}
          </For>
        </div>
      </Show>
      <header class="dinkster-template-heading">
        <h2 id={heading} class="dinkster-title">
          {props.template.name}
        </h2>
        <span class="dinkster-description">{props.summary}</span>
      </header>
      <Show when={props.description}>
        <p class="dinkster-description">{props.description}</p>
      </Show>
      <Show when={props.needs}>
        {(needs) => (
          <section class="dinkster-template-box" aria-label={needs().label}>
            <header class="dinkster-template-box-header">
              <span>{needs().label}</span>
              <span>{needs().summary}</span>
            </header>
            <ul class="dinkster-template-models">
              <For each={needs().models}>
                {(model) => (
                  <li class="dinkster-template-model">
                    <span class="dinkster-template-model-name" title={model.name}>
                      {model.name}
                    </span>
                    <span class="dinkster-template-model-size">
                      {model.size}
                    </span>
                    <span
                      class="dinkster-template-model-state"
                      data-state={model.here ? 'here' : 'missing'}
                    >
                      <Show when={model.here}>
                        <ProductIcon icon={Check} />
                      </Show>
                      {model.here ? needs().hereLabel : needs().missingLabel}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        )}
      </Show>
      <dl class="dinkster-template-box">
        <For each={props.facts}>
          {(fact) => (
            <div class="dinkster-template-fact">
              <dt>{fact.label}</dt>
              <dd>
                {fact.value}
                <Show when={fact.detail}>
                  <span class="dinkster-template-fact-detail">
                    {' '}
                    {fact.detail}
                  </span>
                </Show>
              </dd>
            </div>
          )}
        </For>
      </dl>
      <div class="dinkster-template-actions">{props.actions}</div>
    </>
  )
}

/**
 * A template's models downloading, in place of its download button: quiet
 * text with how far along it is and the same thin line as its tile.
 */
export function ProductTemplateDownload(props: {
  /** Such as "Downloading 2 models, 41%". */
  label: string
  /** From 0 to 1. */
  progress: number
  /** A way to stop the download, such as a text button. */
  stop?: JSX.Element
}) {
  let line: HTMLSpanElement | undefined
  createEffect(() => {
    if (line) line.style.width = `${Math.round(props.progress * 100)}%`
  })
  return (
    <span class="dinkster-template-download" role="status">
      <span class="dinkster-template-download-label">
        {props.label}
        {props.stop}
      </span>
      <span class="dinkster-template-download-track" aria-hidden="true">
        <span ref={line} class="dinkster-template-progress" />
      </span>
    </span>
  )
}
