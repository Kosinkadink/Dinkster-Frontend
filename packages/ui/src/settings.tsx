import { For, Show, createUniqueId, type ComponentProps, type JSX } from 'solid-js'
import { Ellipsis } from 'lucide-solid'
import { ProductTextButton } from './controls.js'
import { ProductMenu } from './menu.js'
import { ProductSearch } from './search.js'

/** Page chrome shared by the gallery and the persisted settings editor. */
export function ProductSettingsPage(props: {
  title: string
  groupsLabel: string
  groups: readonly { id: string; label: string }[]
  group: string
  onGroup: (id: string) => void
  search: ComponentProps<typeof ProductSearch>
  children: JSX.Element
}) {
  const heading = createUniqueId()
  return <div class="dinkster-settings" role="region" aria-labelledby={heading} data-searching={props.search.query.trim() !== ''}>
    <aside class="dinkster-settings-sidebar">
      <h1 id={heading} class="dinkster-title">{props.title}</h1>
      <nav aria-label={props.groupsLabel}>
        <For each={props.groups}>{(group) => <a
          class="dinkster-list-row dinkster-settings-group"
          href={`#${encodeURIComponent(group.id)}`}
          aria-current={group.id === props.group ? 'page' : undefined}
          onClick={(event) => { event.preventDefault(); props.onGroup(group.id) }}
        >{group.label}</a>}</For>
      </nav>
    </aside>
    <div class="dinkster-settings-main">
      <ProductSearch {...props.search} resultsVisible={props.search.query.trim() !== ''} />
      <Show when={props.search.query.trim() === ''}>
        <div class="dinkster-settings-content">{props.children}</div>
      </Show>
    </div>
  </div>
}

/** Related settings share one quiet box without individual row borders. */
export function ProductSettingsSection(props: { title: string; children: JSX.Element }) {
  const heading = createUniqueId()
  return <section class="dinkster-settings-section" aria-labelledby={heading}>
    <h2 id={heading}>{props.title}</h2>
    {props.children}
  </section>
}

/** The host owns the control, validation and persistence; this row owns their presentation. */
export function ProductSettingRow(props: {
  id: string
  label: string
  description?: string | undefined
  error?: string | undefined
  modified: boolean
  resetLabel: string
  menuLabel: string
  resetDefaultLabel: string
  copyIdLabel: string
  onReset: () => void
  onCopyId: () => void
  children: JSX.Element
}) {
  return <div class="dinkster-setting-row" data-setting-id={props.id} data-modified={props.modified}>
    <div class="dinkster-setting-copy">
      <label for={props.id} id={`${props.id}-label`}>{props.label}</label>
      <Show when={props.description}><p id={`${props.id}-description`}>{props.description}</p></Show>
      <Show when={props.error}><p id={`${props.id}-error`} class="dinkster-field-error" role="alert">{props.error}</p></Show>
    </div>
    <div class="dinkster-setting-control">
      <Show when={props.modified}><ProductTextButton label={props.resetLabel} onClick={props.onReset} /></Show>
      {props.children}
    </div>
    <span class="dinkster-setting-menu">
      <ProductMenu label={props.menuLabel} icon={Ellipsis} iconOnly fill="quiet" align="end" items={[
        { label: props.resetDefaultLabel, disabled: !props.modified, onSelect: props.onReset },
        { label: props.copyIdLabel, description: props.id, onSelect: props.onCopyId },
      ]} />
    </span>
  </div>
}
