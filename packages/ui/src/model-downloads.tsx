import {
  For,
  Index,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import { Check, ChevronDown, ChevronRight, Folder } from 'lucide-solid'
import { ProductFacts } from './account.js'
import {
  ProductButton,
  ProductCheckbox,
  ProductIcon,
  ProductIconButton,
  ProductTextButton,
} from './controls.js'
import { ProductProgress } from './messages.js'
import { ProductMenu } from './menu.js'

interface RowAction {
  readonly label: string
  readonly onClick: () => void
  readonly disabled?: boolean
}

export type ProductModelDownloadRow = {
  readonly id: string
  readonly name: string
  readonly metadata: string
  readonly folder?: string
} & (
  | {
      readonly state: 'available'
      readonly selected: boolean
      readonly onSelect: (selected: boolean) => void
      readonly detailsLabel: string
      readonly facts: readonly { label: string; value: JSX.Element }[]
      readonly factsAction?: RowAction
      readonly initiallyExpanded?: boolean
    }
  | {
      readonly state: 'needs' | 'failed'
      readonly reason: string
      readonly action: RowAction
      readonly details?: JSX.Element
    }
  | {
      readonly state: 'waiting' | 'downloading' | 'checking'
      readonly progressLabel: string
      readonly progress?: number
      readonly stop?: RowAction
    }
  | { readonly state: 'ready'; readonly readyLabel: string }
)

function ModelRow(props: { readonly row: ProductModelDownloadRow }) {
  const available = () =>
    props.row.state === 'available' ? props.row : undefined
  const needs = () => (props.row.state === 'needs' ? props.row : undefined)
  const failed = () => (props.row.state === 'failed' ? props.row : undefined)
  const progress = () =>
    props.row.state === 'waiting' ||
    props.row.state === 'downloading' ||
    props.row.state === 'checking'
      ? props.row
      : undefined
  const ready = () => (props.row.state === 'ready' ? props.row : undefined)
  const [expanded, setExpanded] = createSignal(
    available()?.initiallyExpanded === true,
  )
  let row!: HTMLLIElement
  let line!: HTMLDivElement
  let name!: HTMLElement
  let disposed = false
  const placeAction = () => {
    if (disposed || !line || !name) return
    line.dataset.actionBelow = 'false'
    if (needs()) {
      const lineHeight = parseFloat(getComputedStyle(name).lineHeight)
      line.dataset.actionBelow = String(
        name.getBoundingClientRect().height > lineHeight * 2,
      )
    }
  }
  createEffect(() => {
    void props.row.name
    void needs()?.action.label
    queueMicrotask(placeAction)
  })
  onMount(() => {
    let width = -1
    const observer = new ResizeObserver(() => {
      const next = line.getBoundingClientRect().width
      if (next === width) return
      width = next
      placeAction()
    })
    observer.observe(line)
    void document.fonts?.ready.then(placeAction)
    onCleanup(() => observer.disconnect())
  })
  onCleanup(() => {
    disposed = true
  })
  return (
    <li
      ref={row}
      class="dinkster-model-download-row"
      data-state={props.row.state}
      data-model={props.row.id}
    >
      <div ref={line} class="dinkster-model-download-line">
        <Show when={available()}>
          {(entry) => (
            <ProductCheckbox
              label=""
              aria-label={props.row.name}
              checked={entry().selected}
              onChange={(event) =>
                entry().onSelect(event.currentTarget.checked)
              }
            />
          )}
        </Show>
        <div class="dinkster-model-download-copy">
          <strong ref={name} class="dinkster-model-download-name">
            <For each={props.row.name.split(/(?<=[_.-])/)}>
              {(part) => (
                <>
                  <span>{part}</span>
                  <wbr />
                </>
              )}
            </For>
          </strong>
          <span class="dinkster-model-download-meta">
            <Show when={needs()}>
              {(entry) => (
                <span class="dinkster-model-download-reason">
                  {entry().reason} -{' '}
                </span>
              )}
            </Show>
            {props.row.metadata}
          </span>
        </div>
        <Show when={props.row.folder}>
          {(folder) => (
            <span class="dinkster-model-download-folder">
              <ProductIcon icon={Folder} />
              {folder()}
            </span>
          )}
        </Show>
        <Show when={available()}>
          {(entry) => (
            <ProductIconButton
              icon={expanded() ? ChevronDown : ChevronRight}
              label={entry().detailsLabel}
              aria-expanded={expanded()}
              onClick={() => {
                const opening = !expanded()
                setExpanded(opening)
                if (opening)
                  queueMicrotask(() =>
                    row.lastElementChild?.scrollIntoView({ block: 'nearest' }),
                  )
              }}
            />
          )}
        </Show>
        <Show when={needs()}>
          {(entry) => (
            <ProductTextButton
              label={entry().action.label}
              disabled={entry().action.disabled === true}
              onClick={() => entry().action.onClick()}
            />
          )}
        </Show>
        <Show when={ready()}>
          {(entry) => (
            <span class="dinkster-model-download-ready">
              <ProductIcon icon={Check} />
              {entry().readyLabel}
            </span>
          )}
        </Show>
      </div>
      <Show when={expanded() && available()}>
        {(entry) => (
          <div class="dinkster-model-download-facts">
            <ProductFacts label={props.row.name} items={entry().facts} />
            <Show when={entry().factsAction}>
              {(action) => (
                <ProductTextButton
                  label={action().label}
                  disabled={action().disabled === true}
                  onClick={action().onClick}
                />
              )}
            </Show>
          </div>
        )}
      </Show>
      <Show when={needs()}>{(entry) => entry().details}</Show>
      <Show when={progress()}>
        {(entry) => (
          <div class="dinkster-model-download-progress">
            <Show when={entry().state !== 'waiting'}>
              <ProductProgress
                label={entry().progressLabel}
                value={entry().progress}
              />
            </Show>
            <div class="dinkster-model-download-progress-caption">
              <span>{entry().progressLabel}</span>
              <Show when={entry().stop}>
                {(stop) => (
                  <ProductTextButton
                    label={stop().label}
                    disabled={stop().disabled === true}
                    onClick={() => stop().onClick()}
                  />
                )}
              </Show>
            </div>
          </div>
        )}
      </Show>
      <Show when={failed()}>
        {(entry) => (
          <div class="dinkster-model-download-failure" role="alert">
            <span>{entry().reason}</span>
            <ProductTextButton
              label={entry().action.label}
              disabled={entry().action.disabled === true}
              onClick={() => entry().action.onClick()}
            />
          </div>
        )}
      </Show>
    </li>
  )
}

/** The dialog's caller owns planning, selection and live jobs, including while it is closed. */
export function ProductModelDownloads(props: {
  readonly summary: string
  readonly listLabel: string
  readonly rows: readonly ProductModelDownloadRow[]
  readonly footer: string
  readonly footerWarning?: boolean
  readonly closeLabel: string
  readonly onClose: () => void
  readonly primary?: RowAction
  readonly selection?: RowAction
  readonly focusedRow?: string
  readonly notice?: JSX.Element
  readonly destination?: {
    readonly label: string
    readonly selectedId: string
    readonly emptyLabel: string
    readonly freeSpace: string
    readonly locations: readonly {
      readonly id: string
      readonly name: string
      readonly path: string
    }[]
    readonly onSelect: (id: string) => void
  }
}) {
  let list!: HTMLUListElement
  createEffect(() => {
    const focused = props.focusedRow
    if (focused !== undefined)
      queueMicrotask(() => {
        const row = Array.from(list.children).find(
          (entry) => (entry as HTMLElement).dataset.model === focused,
        )
        row?.scrollIntoView({ block: 'nearest' })
      })
  })
  return (
    <section class="dinkster-model-downloads" data-testid="model-downloads">
      <header class="dinkster-model-download-header">
        <Show when={props.destination}>
          {(destination) => {
            const selected = () =>
              destination().locations.find(
                (location) => location.id === destination().selectedId,
              )
            return (
              <div class="dinkster-model-download-destination">
                <ProductMenu
                  label={destination().label}
                  triggerName={destination().label}
                  fill="quiet"
                  labelContent={
                    <span class="dinkster-model-download-destination-label">
                      <span>{destination().label}</span>
                      <ProductIcon icon={Folder} />
                      <strong>
                        {selected()?.name ?? destination().emptyLabel}
                      </strong>
                      <span class="dinkster-model-download-destination-path">
                        {selected()?.path}
                      </span>
                      <span class="dinkster-model-download-space">
                        {destination().freeSpace}
                      </span>
                    </span>
                  }
                  items={destination().locations.map((location) => ({
                    label: location.name,
                    description: location.path,
                    checked: location.id === destination().selectedId,
                    onSelect: () => destination().onSelect(location.id),
                  }))}
                />
              </div>
            )
          }}
        </Show>
        {props.notice}
        <div class="dinkster-model-download-summary">
          <p class="dinkster-description">{props.summary}</p>
          <Show when={props.selection}>
            {(selection) => (
              <ProductTextButton
                label={selection().label}
                onClick={selection().onClick}
              />
            )}
          </Show>
        </div>
      </header>
      <ul
        ref={list}
        class="dinkster-model-download-list"
        aria-label={props.listLabel}
      >
        <Index each={props.rows}>{(row) => <ModelRow row={row()} />}</Index>
      </ul>
      <footer class="dinkster-model-download-footer">
        <p
          class="dinkster-description"
          role="status"
          data-warning={props.footerWarning === true}
        >
          {props.footer}
        </p>
        <div class="dinkster-actions">
          <ProductButton onClick={props.onClose}>
            {props.closeLabel}
          </ProductButton>
          <Show when={props.primary}>
            {(primary) => (
              <ProductButton
                fill="solid"
                disabled={primary().disabled === true}
                onClick={() => primary().onClick()}
              >
                {primary().label}
              </ProductButton>
            )}
          </Show>
        </div>
      </footer>
    </section>
  )
}
