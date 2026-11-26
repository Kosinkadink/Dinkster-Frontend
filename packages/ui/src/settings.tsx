import { For, Show, createSignal, createUniqueId, onCleanup, onMount, splitProps, type ComponentProps, type JSX } from 'solid-js'
import { Ellipsis } from 'lucide-solid'
import { ProductButton, ProductTextButton } from './controls.js'
import { ProductMenu } from './menu.js'
import { ProductSearch } from './search.js'
import { ProductShortcut } from './shortcut.js'

/** The caller owns recording, cancellation and stored bindings. */
export function ProductShortcutCapture(props: Omit<ComponentProps<typeof ProductButton>, 'children' | 'intent' | 'fill' | 'pending' | 'density'> & {
  keys?: string | readonly string[] | undefined
  recording?: boolean | undefined
  pendingKeys?: string | readonly string[] | undefined
  noneLabel: string
  recordingLabel: string
  cancelLabel: string
}) {
  const [local, button] = splitProps(props, ['keys', 'recording', 'pendingKeys', 'noneLabel', 'recordingLabel', 'cancelLabel'])
  return <ProductButton {...button} data-shortcut-capture data-recording={local.recording}>
    <Show when={local.recording} fallback={<Show when={local.keys && local.keys.length > 0} fallback={<span class="dinkster-setting-none">{local.noneLabel}</span>}><ProductShortcut keys={local.keys!} size="settings" /></Show>}>
      <Show when={local.pendingKeys && local.pendingKeys.length > 0} fallback={<span>{local.recordingLabel}</span>}><ProductShortcut keys={local.pendingKeys!} size="settings" /></Show>
      <span class="dinkster-setting-cancel">{local.cancelLabel}</span>
    </Show>
  </ProductButton>
}

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
  let navigation!: HTMLElement
  const [cutStart, setCutStart] = createSignal(false)
  const [cutEnd, setCutEnd] = createSignal(false)
  const measure = () => {
    setCutStart(navigation.scrollLeft > 1)
    setCutEnd(navigation.scrollLeft + navigation.clientWidth < navigation.scrollWidth - 1)
  }
  onMount(() => {
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(navigation)
    onCleanup(() => observer.disconnect())
  })
  return <div class="dinkster-settings" role="region" aria-labelledby={heading} data-searching={props.search.query.trim() !== ''}>
    <aside class="dinkster-settings-sidebar">
      <h1 id={heading} class="dinkster-title">{props.title}</h1>
      <nav ref={navigation} aria-label={props.groupsLabel} onScroll={measure} data-cut-start={cutStart()} data-cut-end={cutEnd()}>
        <For each={props.groups}>{(group) => <a
          class="dinkster-list-row dinkster-settings-group"
          href={`#${encodeURIComponent(group.id)}`}
          aria-current={props.search.query.trim() === '' && group.id === props.group ? 'page' : undefined}
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
  controlId?: string
  label: string
  description?: JSX.Element
  error?: string | undefined
  warning?: string | undefined
  fullWidth?: boolean
  modified: boolean
  resetLabel: string
  menuLabel: string
  resetDefaultLabel: string
  copyIdLabel: string
  menuItems?: ComponentProps<typeof ProductMenu>['items'] | undefined
  onReset: () => void
  onCopyId: () => void
  children: JSX.Element
}) {
  const controlId = () => props.controlId ?? props.id
  return <div class="dinkster-setting-row" data-setting-id={props.id} data-modified={props.modified} data-full-width={props.fullWidth}>
    <div class="dinkster-setting-copy">
      <label for={controlId()} id={`${controlId()}-label`}>{props.label}</label>
      <Show when={props.description}><p id={`${controlId()}-description`}>{props.description}</p></Show>
      <Show when={props.error}><p id={`${controlId()}-error`} class="dinkster-field-error" role="alert">{props.error}</p></Show>
      <Show when={props.warning}><p id={`${controlId()}-warning`} class="dinkster-setting-warning" role="status">{props.warning}</p></Show>
    </div>
    <div class="dinkster-setting-control">
      <Show when={props.modified}><ProductTextButton label={props.resetLabel} onClick={props.onReset} /></Show>
      {props.children}
    </div>
    <span class="dinkster-setting-menu">
      <ProductMenu label={props.menuLabel} icon={Ellipsis} iconOnly fill="quiet" align="end" items={props.menuItems ?? [
        { label: props.resetDefaultLabel, disabled: !props.modified, onSelect: props.onReset },
        { label: props.copyIdLabel, description: props.id, onSelect: props.onCopyId },
      ]} />
    </span>
  </div>
}
