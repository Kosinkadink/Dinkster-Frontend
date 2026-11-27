/**
 * Generic settings editor. Rendering switches only on the registry's public
 * type discriminator, so adding a setting never requires editing this dialog.
 *
 * The shell page host owns the tab and close action. The body swallows keys
 * while a keybinding capture is active or a nonempty search is cleared.
 * Controls that own Escape handle it before the body fallback.
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { activeLocale, type MessageParams } from '@dinkster/core'
import type { DinksterConnection, PackSettings } from '@dinkster/client'
import type { AppCommand, CommandRegistry, KeybindingRegistry, SettingDefinition, SettingsRegistry } from './settings.js'
import { captureKeydown } from './settings.js'
import { buildSettingsSearchIndex, querySettingsIndex, searchableSettingsDefinitions, settingsCategoryLabel, settingsCommandGroups, type SettingsSearchItem } from './settings-search.js'
import { useAppMessage } from './locale.js'
import { useSignal } from './solid-adapter.js'
import { productFieldIds } from './ProductForm.js'
import { ProductNumberInput } from './ProductNumberInput.js'
import { LibraryStorageSettings } from './LibraryStorageSettings.js'
import { ProductButton, ProductTextButton, ProductShortcutCapture, ProductShortcutText, ProductSwitch, ProductSelect, ProductTextInput, ProductSettingRow, ProductSettingsPage, ProductSettingsSection, ProductToast, ProductErrorBanner, productSearchMarks, type ProductSearchGroup } from '@dinkster/ui'
import { AgentPermissionsPanel } from './AgentPermissionsPanel.js'
import { RuntimeSettingsPanel } from './RuntimeSettingsPanel.js'
import type { Backend } from './app-state.js'
import { failureMessage } from './request-failure.js'

export interface PackSettingsClient {
  fetchPackSettings(packId: string): Promise<PackSettings>
  updatePackSettings(
    packId: string,
    values: Readonly<Record<string, string | number | boolean>>,
  ): Promise<PackSettings>
}

function PackSettingsPanel(props: {
  readonly packId: string
  readonly client: PackSettingsClient
  readonly onCopyId: (id: string) => void
}) {
  const message = useAppMessage()
  const [settings, setSettings] = createSignal<PackSettings>()
  const [error, setError] = createSignal<string>()
  const [saving, setSaving] = createSignal(false)
  onMount(() => {
    void props.client.fetchPackSettings(props.packId).then(setSettings).catch((cause: unknown) => {
      setError(failureMessage(cause))
    })
  })
  const update = async (name: string, value: string | number | boolean): Promise<void> => {
    const current = settings()
    if (current === undefined || saving()) return
    setSaving(true)
    setError(undefined)
    try {
      setSettings(await props.client.updatePackSettings(props.packId, { ...current.values, [name]: value }))
    } catch (cause) {
      setError(failureMessage(cause))
    } finally {
      setSaving(false)
    }
  }
  return <Show when={settings()} fallback={
    <p class="pack-settings-status" role="status">
      {error() ?? message('settingsDialog.pack.loading')}
    </p>
  }>{(loaded) => <div class="pack-settings" data-pack-id={props.packId}>
    <p class="pack-settings-status" aria-live="polite">{saving() ? message('settingsDialog.pack.saving') : ''}</p>
    <Show when={error()}>{(text) => <p class="pack-settings-error" role="alert">{text()}</p>}</Show>
    <For each={loaded().schema.required}>{(name) => {
      const field = loaded().schema.properties[name]!
      const controlId = `pack-setting-${props.packId}-${name}`
      const ids = productFieldIds(controlId)
      const value = () => settings()?.values[name] ?? field.default
      const describedBy = field.description === undefined ? undefined : ids.description
      const commitNumber = (raw: string): void => {
        const value = Number(raw)
        if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isSafeInteger(value))) return
        void update(name, value)
      }
      return <div data-pack-setting-id={name}><ProductSettingRow id={name} controlId={controlId}
        label={field.title} description={field.description} modified={!Object.is(value(), field.default)}
        fullWidth={field.type === 'string' && field.enum === undefined}
        resetLabel={message('settingsDialog.action.reset')} menuLabel={message('settingsPage.actions', { name: field.title })}
        copyIdLabel={message('settingsPage.copySettingId')}
        onReset={() => { void update(name, field.default) }} onCopyId={() => props.onCopyId(name)}>
        <Show when={field.type === 'boolean'}>
          <ProductSwitch id={controlId} label={field.title} aria-describedby={describedBy} checked={value() as boolean} disabled={saving()} onChange={(next) => { void update(name, next) }} />
        </Show>
        <Show when={field.type === 'number' || field.type === 'integer'}>
          <ProductNumberInput id={controlId} ariaLabelledBy={ids.label} ariaDescribedBy={describedBy} value={value() as number} min={field.minimum} max={field.maximum} step={field.multipleOf} integer={field.type === 'integer'} disabled={saving()} onCommit={commitNumber} />
        </Show>
        <Show when={field.type === 'string' && field.enum !== undefined}>
          <ProductSelect id={controlId} aria-labelledby={ids.label} aria-describedby={describedBy} disabled={saving()} options={(field.enum ?? []).map((value) => ({ value, label: value }))} value={String(value())} onChange={(next) => { void update(name, next) }} />
        </Show>
        <Show when={field.type === 'string' && field.enum === undefined}>
          <ProductTextInput id={controlId} aria-labelledby={ids.label} aria-describedby={describedBy} disabled={saving()} value={String(value())} onChange={(event) => { void update(name, event.currentTarget.value) }} />
        </Show>
      </ProductSettingRow></div>
    }}</For>
  </div>}</Show>
}

function SettingField(props: {
  readonly definition: SettingDefinition
  readonly settings: SettingsRegistry
  readonly changed: () => void
  readonly locale: () => void
  readonly inline?: boolean
  readonly onCopyId: (id: string) => void
}) {
  const messageText = useAppMessage()
  const definition = props.definition
  const controlId = `setting-${definition.id}`
  const ids = productFieldIds(controlId)
  const [validation, setValidation] = createSignal<{ readonly key: string; readonly params?: MessageParams }>()
  const validationMessage = () => {
    const current = validation()
    return current === undefined ? undefined : messageText(current.key, current.params)
  }
  const [stringDraft, setStringDraft] = createSignal<string>()
  const name = () => { props.locale(); return definition.name }
  const description = () => { props.locale(); return definition.description }
  const options = () => { props.locale(); return definition.options ?? [] }
  const describedBy = () => [props.inline || description() === undefined ? undefined : ids.description, validation() === undefined ? undefined : `${controlId}-error`].filter(Boolean).join(' ') || undefined
  const value = () => { props.changed(); return props.settings.get(definition.id) }
  const modified = () => !Object.is(value(), definition.defaultValue)
  const disabled = () => { props.changed(); return definition.id === 'canvas.detailMinPercent' && props.settings.get('canvas.detailMode') === 'automatic' }
  const setValue = (next: unknown): void => {
    setValidation(undefined)
    props.settings.set(definition.id, next)
  }
  const commitNumber = (raw: string): void => {
    const number = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(number)) {
      setValidation({ key: 'settingsDialog.validation.finiteNumber' })
      return
    }
    if (definition.min !== undefined && number < definition.min) {
      setValidation({ key: 'settingsDialog.validation.minimum', params: { minimum: definition.min } })
      return
    }
    if (definition.max !== undefined && number > definition.max) {
      setValidation({ key: 'settingsDialog.validation.maximum', params: { maximum: definition.max } })
      return
    }
    setValue(number)
  }
  const resetValue = (): void => {
    setValidation(undefined)
    setStringDraft(undefined)
    props.settings.reset(definition.id)
  }
  const control = () => <>
      <Show when={definition.type === 'boolean'}><ProductSwitch id={controlId} label={name()} aria-describedby={describedBy()} checked={value() as boolean} onChange={setValue} /></Show>
      <Show when={definition.type === 'number'}><ProductNumberInput id={controlId} ariaLabel={name()} {...(props.inline ? {} : { ariaLabelledBy: ids.label })} ariaDescribedBy={describedBy()} ariaInvalid={validation() !== undefined} value={String(value())} min={definition.min} max={definition.max} step={definition.step} disabled={disabled()} unit={definition.id === 'tooltips.delayMs' ? 'ms' : ['shell.layout.left.width', 'shell.layout.right.width', 'shell.layout.bottom.height'].includes(definition.id) ? 'px' : undefined} onCommit={commitNumber} onRevert={() => setValidation(undefined)} /></Show>
      <Show when={definition.type === 'string'}><ProductTextInput
        id={controlId}
        aria-label={props.inline ? name() : undefined}
        aria-labelledby={props.inline ? undefined : ids.label}
        aria-describedby={describedBy()}
        aria-invalid={validation() !== undefined ? 'true' : undefined}
        value={stringDraft() ?? String(value())}
        onInput={(event) => setStringDraft(event.currentTarget.value)}
        onChange={(event) => { setValue(event.currentTarget.value); setStringDraft(undefined) }}
        onBlur={() => setStringDraft(undefined)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || stringDraft() === undefined) return
          event.preventDefault()
          event.stopPropagation()
          setValidation(undefined)
          setStringDraft(undefined)
        }}
      /></Show>
      <Show when={definition.type === 'combo'}><ProductSelect id={controlId} aria-label={props.inline ? name() : undefined} aria-labelledby={props.inline ? undefined : ids.label} aria-describedby={describedBy()} options={options()} value={String(value())} onChange={setValue} /></Show>
    </>
  return <Show when={!props.inline} fallback={<div data-setting-id={definition.id}>
    <Show when={modified()}><ProductTextButton label={messageText('settingsDialog.action.reset')} disabled={disabled()} onClick={resetValue} /></Show>
    {control()}
    <Show when={validationMessage()}>{(text) => <p id={`${controlId}-error`} class="dinkster-field-error" role="alert">{text()}</p>}</Show>
  </div>}>
    <ProductSettingRow id={definition.id} controlId={controlId} label={name()}
      description={description() === undefined ? undefined : <ProductShortcutText text={description()!} />}
      error={validationMessage()} fullWidth={definition.type === 'string'} modified={modified()} disabled={disabled()}
      resetLabel={messageText('settingsDialog.action.reset')} menuLabel={messageText('settingsPage.actions', { name: name() })}
      copyIdLabel={messageText('settingsPage.copySettingId')}
      onReset={resetValue} onCopyId={() => props.onCopyId(definition.id)}>{control()}</ProductSettingRow>
  </Show>
}

export function SettingsDialog(props: {
  readonly settings: SettingsRegistry
  readonly commands: CommandRegistry
  readonly keybindings: KeybindingRegistry
  readonly request?: { readonly category: string; readonly id: string } | undefined
  readonly onRequestConsumed?: () => void
  readonly backends?: readonly Backend[]
  readonly onOpenStorage?: () => void
  readonly storageConnection?: Pick<DinksterConnection, 'fetchLibraryStorage' | 'updateLibraryStorageLimit' | 'clearLibraryStorage'> | undefined
  readonly packSettings?: {
    readonly client: PackSettingsClient
    readonly packs: () => readonly { readonly id: string; readonly displayName: string }[]
  } | undefined
}) {
  const message = useAppMessage()
  let root!: HTMLDivElement
  let searchInput!: HTMLInputElement
  const changed = useSignal(props.settings.changed)
  const locale = useSignal(activeLocale)
  const [query, setQuery] = createSignal('')
  const definitions = () => { changed(); return searchableSettingsDefinitions(props.settings.list()) }
  const shortcutCommands = createMemo(() => (changed(), props.commands.list()), undefined, {
    equals: (previous, next) => previous.length === next.length && previous.every((command, index) => command === next[index]),
  })
  const shortcutGroups = createMemo(() => settingsCommandGroups(shortcutCommands()))
  const layoutIds = new Set(['shell.layout.left.width', 'shell.layout.right.width', 'shell.layout.bottom.height', 'shell.dock.layout', 'editor.splitLayout'])
  const groups = () => ['general', 'canvas', 'runs', 'shortcuts', 'storage', 'packs', 'engine', 'experimental', 'advanced'].map((id) => ({ id, label: message(`settingsPage.group.${id}`) }))
  const location = (definition: SettingDefinition): { group: string; section: string } => {
    const id = definition.id
    if (id.startsWith('canvas.')) return { group: 'canvas', section: id.startsWith('canvas.minimap.') ? 'minimap' : 'view' }
    if (id.startsWith('execution.')) return { group: 'runs', section: 'previews' }
    if (id.startsWith('features.')) return { group: 'experimental', section: 'features' }
    if (id === 'dinkster.locale' || id === 'dinkster.theme') return { group: 'general', section: 'appearance' }
    if (id.startsWith('shell.') || id === 'tooltips.delayMs') return { group: 'general', section: 'workspace' }
    if (id === 'diagnostics.frameRate') return { group: 'advanced', section: 'diagnostics' }
    if (id === 'search.registryUrl' || id === 'templates.registryUrl') return { group: 'advanced', section: 'registries' }
    return { group: 'packs', section: props.settings.categoryOf(definition) }
  }
  const sectionLabel = (group: string, section: string) => {
    if (group === 'packs') return settingsCategoryLabel(section, message)
    if (group === 'shortcuts') {
      const key = `settingsPage.commands.${section}`
      const label = message(key)
      return label === key ? settingsCategoryLabel(section, message) : label
    }
    return message(`settingsPage.section.${section}`)
  }
  const [group, setGroup] = createSignal('general')
  const [current, setCurrent] = createSignal('')
  const [capture, setCapture] = createSignal<{ readonly command: string; readonly pending: string }>()
  const [toast, setToast] = createSignal<{ message: string }>()
  const [copyError, setCopyError] = createSignal('')
  const copyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id)
      setCopyError('')
      setToast({ message: message('settingsPage.copiedId', { id }) })
    } catch { setCopyError(message('settingsPage.copyFailed')) }
  }
  const focus = (id: string) => queueMicrotask(() => {
    const control = root.querySelector<HTMLElement>([id === 'shell.dock.layout' || id === 'editor.splitLayout' ? 'settings-reset-layout' : `setting-${id}`, `keybinding-${id}`, id].map((candidate) => `#${CSS.escape(candidate)}`).join(', '))
    control?.focus()
    control?.scrollIntoView?.({ block: 'nearest' })
  })
  createEffect(() => {
    const request = props.request
    if (!request) return
    setQuery('')
    setCapture(undefined)
    const definition = definitions().find((entry) => entry.id === request.id)
    setGroup(definition ? location(definition).group : request.category === 'keybindings' ? 'shortcuts' : request.category.startsWith('backend:') ? 'engine' : request.category.startsWith('pack:') ? 'packs' : request.category)
    focus(request.id)
    queueMicrotask(() => {
      if (props.request !== request) return
      props.onRequestConsumed?.()
    })
  })
  const searching = () => query().trim() !== ''
  const sameIndex = (previous: readonly SettingsSearchItem[], next: readonly SettingsSearchItem[]): boolean =>
    previous.length === next.length && previous.every((item, at) => {
      const candidate = next[at]
      return candidate !== undefined && item.source === candidate.source
        && item.name === candidate.name
        && item.keywords.length === candidate.keywords.length
        && item.keywords.every((keyword, index) => keyword === candidate.keywords[index])
        && (item.source === 'setting' ? item.definition === candidate.definition : item.command === candidate.command)
    })
  const index = createMemo(
    () => {
      locale()
      return buildSettingsSearchIndex(definitions(), (d) => props.settings.categoryOf(d), props.commands.list()).map((item) => {
        const place = item.source === 'setting' ? location(item.definition) : { group: 'shortcuts', section: item.id.split('.')[0]! }
        return { ...item, keywords: [...item.keywords, message(`settingsPage.group.${place.group}`), sectionLabel(place.group, place.section)] }
      })
    },
    undefined,
    { equals: sameIndex },
  )
  const matches = createMemo(() => querySettingsIndex(index(), query()).flatMap((entry) => entry.matches).flatMap((match) => {
    const place = match.source === 'setting' ? location(match.definition) : { group: 'shortcuts', section: match.id.split('.')[0]! }
    let detail = `${message(`settingsPage.group.${place.group}`)} - ${sectionLabel(place.group, place.section)}`
    const titleMatches = productSearchMarks(match.name, query()).length > 0
    const description = match.source === 'setting' ? match.definition.description ?? '' : ''
    const first = productSearchMarks(description, query())[0]
    let note: string | undefined
    if (!titleMatches && first) {
      const start = Math.max(0, first[0] - 24)
      const end = Math.min(description.length, first[1] + 100)
      note = `${start > 0 ? '...' : ''}${description.slice(start, end)}${end < description.length ? '...' : ''}`
    }
    if (!titleMatches && note === undefined && productSearchMarks(detail, query()).length === 0) {
      if (productSearchMarks(match.id, query()).length === 0) return []
      detail += ` - ${match.id}`
    }
    return [{ ...match, detail, note }]
  }))
  const visible = () => definitions().filter((d) => location(d).group === group() && d.id !== 'editor.splitLayout')
  const sections = () => [...new Set(visible().map((d) => location(d).section))]
  const conflicts = () => { changed(); return props.keybindings.conflicts() }
  const selectGroup = (next: string): void => {
    setQuery('')
    setCapture(undefined)
    setGroup(next)
  }
  const clearSearch = (): void => {
    setQuery('')
    searchInput.focus()
  }
  const settingRow = (d: SettingDefinition, inline = false) => <SettingField definition={d} settings={props.settings} changed={changed} locale={locale} inline={inline} onCopyId={(id) => { void copyId(id) }} />
  const keybindingRow = (command: AppCommand, inline = false) => {
    const controlId = `keybinding-${command.id}`
    const commandLabel = () => { locale(); return command.label }
    const combo = () => { changed(); return props.keybindings.combo(command.id) }
    const conflict = () => combo() ? conflicts().get(combo()!) : undefined
    const conflictMessage = () => {
      const ids = conflict()
      return ids === undefined ? undefined : message('settingsDialog.keybinding.conflict', { commands: ids.filter((id) => id !== command.id).map((id) => props.commands.list().find((other) => other.id === id)?.label ?? id).join(', ') })
    }
    const captureText = () => capture()?.command === command.id ? capture()?.pending || message('settingsDialog.keybinding.pressKeys') : combo() ?? message('settingsDialog.keybinding.unbound')
    const modified = () => combo() !== props.keybindings.defaultCombo(command.id)
    const control = () => <ProductShortcutCapture
        id={controlId}
        type="button"
        aria-label={message('settingsDialog.keybinding.shortcutAria', { name: commandLabel(), shortcut: captureText() })}
        aria-describedby={conflict() ? `${controlId}-warning` : undefined}
        keys={combo()} recording={capture()?.command === command.id} pendingKeys={capture()?.pending}
        noneLabel={message('settingsPage.noneShortcut')} recordingLabel={message('settingsPage.pressKeys')} cancelLabel={message('settingsPage.escapeCancels')}
        onClick={() => setCapture({ command: command.id, pending: '' })}
      />
    const menuItems = () => [
      ...(combo() ? [{ label: message('settingsPage.removeShortcut'), onSelect: () => props.keybindings.set(command.id, null) }] : []),
      { label: message('settingsPage.copyCommandId'), description: command.id, onSelect: () => { void copyId(command.id) } },
    ]
    return <div data-command-id={command.id}><Show when={!inline} fallback={<><Show when={modified()}><ProductTextButton label={message('settingsDialog.action.reset')} onClick={() => props.keybindings.reset(command.id)} /></Show>{control()}<Show when={conflictMessage()}>{(text) => <p id={`${controlId}-warning`} class="dinkster-setting-warning" role="status">{text()}</p>}</Show></>}>
      <ProductSettingRow id={command.id} controlId={controlId} label={commandLabel()} modified={modified()} warning={conflictMessage()}
        resetLabel={message('settingsDialog.action.reset')} menuLabel={message('settingsPage.actions', { name: commandLabel() })} copyIdLabel={message('settingsPage.copyCommandId')}
        menuItems={menuItems()}
        onReset={() => props.keybindings.reset(command.id)} onCopyId={() => { void copyId(command.id) }}>{control()}</ProductSettingRow>
    </Show></div>
  }
  const searchGroups = createMemo<readonly ProductSearchGroup[]>(() => searching() && matches().length > 0 ? [{ key: 'settings', label: message('settingsDialog.search.summary', { count: matches().length, query: query().trim() }), rows: matches().map((match) => {
    return { key: `${match.source}:${match.id}`, title: match.name, detail: match.detail, ...(match.note === undefined ? {} : { note: match.note }),
      get modified() { changed(); return match.source === 'setting' ? !Object.is(props.settings.get(match.id), match.definition.defaultValue) : props.keybindings.combo(match.id) !== props.keybindings.defaultCombo(match.id) },
      fullWidth: match.source === 'setting' && match.definition.type === 'string',
      control: match.source === 'setting' ? settingRow(match.definition, true) : keybindingRow(match.command, true),
      menu: { label: message('settingsPage.actions', { name: match.name }), get items() { changed(); return [
        ...(match.source === 'keybinding' && props.keybindings.combo(match.id) ? [{ label: message('settingsPage.removeShortcut'), onSelect: () => props.keybindings.set(match.id, null) }] : []),
        { label: message(match.source === 'setting' ? 'settingsPage.copySettingId' : 'settingsPage.copyCommandId'), description: match.id, onSelect: () => { void copyId(match.id) } },
      ] } },
    }
  }) }] : [])
  const activate = (key: string) => {
    const match = matches().find((entry) => `${entry.source}:${entry.id}` === key)
    if (!match) return
    if (match.source === 'setting' && match.definition.type === 'boolean') props.settings.set(match.id, !props.settings.get<boolean>(match.id))
    else {
      selectGroup(match.source === 'setting' ? location(match.definition).group : 'shortcuts')
      focus(match.id)
    }
  }

  onMount(() => {
    const record = (e: KeyboardEvent) => {
      const activeCapture = capture()
      if (activeCapture) {
        e.preventDefault(); e.stopPropagation()
        const result = captureKeydown(e)
        if (result.kind === 'pending') setCapture({ ...activeCapture, pending: result.combo })
        else if (result.kind === 'cancel') setCapture(undefined)
        else { props.keybindings.set(activeCapture.command, result.combo); setCapture(undefined); props.settings.changed.get() }
        return
      }
    }
    root.addEventListener('keydown', record, true)
    onCleanup(() => root.removeEventListener('keydown', record, true))
  })
  return (
    <div class="dinkster-settings-host" ref={root} onKeyDown={(e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && searching()) { e.preventDefault(); e.stopPropagation(); clearSearch() }
    }}>
      <Show when={copyError()}><ProductErrorBanner onDismiss={() => setCopyError('')}>{copyError()}</ProductErrorBanner></Show>
      <ProductSettingsPage title={message('settingsDialog.search.regionAria')} groupsLabel={message('settingsDialog.category.regionAria')} groups={groups()} group={group()} onGroup={selectGroup}
        search={{ label: message('settingsDialog.search.label'), placeholder: message('settingsDialog.search.placeholder'), get query() { return query() }, onQuery: (next) => { setQuery(next); setCurrent(''); setCapture(undefined) }, get groups() { return searchGroups() }, get current() { return current() }, onCurrent: setCurrent, onActivate: activate, onClose: clearSearch, inputRef: (input) => { searchInput = input }, empty: { title: message('settingsDialog.search.emptyTitle'), detail: message('settingsDialog.search.emptyBody') } }}>
        <For each={sections()}>{(section) => <ProductSettingsSection title={sectionLabel(group(), section)}>
          <For each={visible().filter((d) => location(d).section === section)}>{(d) => settingRow(d)}</For>
          <Show when={group() === 'general' && section === 'workspace' && props.settings.list().some((d) => layoutIds.has(d.id))}><div class="dinkster-setting-row"><div class="dinkster-setting-copy"><label for="settings-reset-layout">{message('settingsPage.panelLayout')}</label></div><div class="dinkster-setting-control"><ProductButton id="settings-reset-layout" onClick={() => { for (const d of props.settings.list()) if (layoutIds.has(d.id)) props.settings.reset(d.id) }}>{message('settingsPage.resetLayout')}</ProductButton></div></div></Show>
        </ProductSettingsSection>}</For>
        <Show when={group() === 'shortcuts'}><For each={shortcutGroups()}>{(area) => <ProductSettingsSection title={sectionLabel('shortcuts', area.id)}><For each={area.commands}>{(command) => keybindingRow(command)}</For></ProductSettingsSection>}</For></Show>
        <Show when={group() === 'storage'}>
          <Show when={props.onOpenStorage}><p class="dinkster-settings-note">{message('storageSettings.mounts')} <ProductTextButton label={message('storageSettings.openStorage')} onClick={() => props.onOpenStorage?.()} /></p></Show>
          <Show when={props.storageConnection} keyed>{(connection) => <LibraryStorageSettings connection={connection} onCopyId={(id) => { void copyId(id) }} />}</Show>
        </Show>
        <Show when={group() === 'packs' && props.packSettings}>{(packSettings) => <For each={packSettings().packs()}>{(pack) => <ProductSettingsSection title={pack.displayName}><PackSettingsPanel packId={pack.id} client={packSettings().client} onCopyId={(id) => { void copyId(id) }} /></ProductSettingsSection>}</For>}</Show>
        <Show when={group() === 'engine'}><For each={(props.backends ?? []).filter((backend): backend is Extract<Backend, { protocol: 'dinkster' }> => backend.protocol === 'dinkster')}>{(backend) => <>
          <RuntimeSettingsPanel connection={backend.connection} backendLabel={backend.label} categories={(category) => !['memory-budgets', 'memory-headroom', 'aimdo-policy'].includes(category)} alwaysOpen settingsPage onCopyId={(id) => { void copyId(id) }} />
          <AgentPermissionsPanel connection={backend.connection} backendLabel={backend.label} />
        </>}</For></Show>
      </ProductSettingsPage>
      <ProductToast notification={toast()} onDismiss={() => setToast(undefined)} />
    </div>
  )
}
