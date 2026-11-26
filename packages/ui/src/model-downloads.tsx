import { Index, Show, createSignal, type JSX } from 'solid-js'
import { Check, ChevronDown, ChevronRight } from 'lucide-solid'
import { ProductFacts } from './account.js'
import {
  ProductButton,
  ProductCheckbox,
  ProductIcon,
  ProductIconButton,
  ProductTextButton,
} from './controls.js'
import { ProductProgress } from './messages.js'

interface RowAction {
  readonly label: string
  readonly onClick: () => void
  readonly disabled?: boolean
}

export type ProductModelDownloadRow = {
  readonly id: string
  readonly name: string
  readonly metadata: string
} & (
  | {
      readonly state: 'available'
      readonly selected: boolean
      readonly onSelect: (selected: boolean) => void
      readonly detailsLabel: string
      readonly facts: readonly { label: string; value: JSX.Element }[]
      readonly initiallyExpanded?: boolean
    }
  | {
      readonly state: 'needs' | 'failed'
      readonly reason: string
      readonly action: RowAction
      readonly details?: JSX.Element
    }
  | {
      readonly state: 'downloading' | 'checking'
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
    props.row.state === 'downloading' || props.row.state === 'checking'
      ? props.row
      : undefined
  const ready = () => (props.row.state === 'ready' ? props.row : undefined)
  const [expanded, setExpanded] = createSignal(
    available()?.initiallyExpanded === true,
  )
  return (
    <li
      class="dinkster-model-download-row"
      data-state={props.row.state}
      data-model={props.row.id}
    >
      <div class="dinkster-model-download-line">
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
          <strong class="dinkster-model-download-name">{props.row.name}</strong>
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
        <Show when={available()}>
          {(entry) => (
            <ProductIconButton
              icon={expanded() ? ChevronDown : ChevronRight}
              label={entry().detailsLabel}
              aria-expanded={expanded()}
              onClick={() => setExpanded(!expanded())}
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
          <ProductFacts label={props.row.name} items={entry().facts} />
        )}
      </Show>
      <Show when={needs()}>{(entry) => entry().details}</Show>
      <Show when={progress()}>
        {(entry) => (
          <div class="dinkster-model-download-progress">
            <ProductProgress
              label={entry().progressLabel}
              value={entry().progress}
            />
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
  readonly spaceShort?: boolean
  readonly closeLabel: string
  readonly onClose: () => void
  readonly primary?: RowAction
}) {
  return (
    <section class="dinkster-model-downloads" data-testid="model-downloads">
      <p class="dinkster-description">{props.summary}</p>
      <ul class="dinkster-model-download-list" aria-label={props.listLabel}>
        <Index each={props.rows}>{(row) => <ModelRow row={row()} />}</Index>
      </ul>
      <footer class="dinkster-model-download-footer">
        <p
          class="dinkster-description"
          data-warning={props.spaceShort ? '' : undefined}
          role="status"
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
                disabled={props.spaceShort || primary().disabled === true}
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
