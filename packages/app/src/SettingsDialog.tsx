/**
 * Generic settings editor. Rendering switches only on the registry's public
 * type discriminator, so adding a setting never requires editing this dialog.
 *
 * This is a placement-agnostic BODY (registered as the 'settings' modal
 * panel): the shell's modal host (a native <dialog>) owns the backdrop,
 * dialog chrome, title, close button, and Escape-to-close. The body swallows
 * keys while a keybinding capture is active or a nonempty search is cleared.
 * Controls that own Escape handle it before the body fallback.
 */
import { createMemo, createSignal, For, onMount, Show } from 'solid-js'
import { activeLocale, type MessageParams } from '@dinkster/core'
import type { AppCommand, CommandRegistry, KeybindingRegistry, SettingDefinition, SettingsRegistry } from './settings.js'
import { captureKeydown, initialSettingsCategory } from './settings.js'
import { buildSettingsSearchIndex, querySettingsIndex, searchableSettingsDefinitions, type SettingsSearchItem } from './settings-search.js'
import { useAppMessage } from './locale.js'
import { useSignal } from './solid-adapter.js'
import { ProductCheckbox } from './ProductControls.js'
import { ProductField, productFieldIds } from './ProductForm.js'
import { ProductNumberInput } from './ProductNumberInput.js'
import { ProductSelect } from './ProductSelect.js'

function fallbackCategoryLabel(category: string): string {
  return category
    .replaceAll('.', ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean)
    .map((part) => `${part[0]?.toLocaleUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ')
}

function SettingField(props: {
  readonly definition: SettingDefinition
  readonly settings: SettingsRegistry
  readonly changed: () => void
  readonly locale: () => void
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
  const describedBy = () => [description() === undefined ? undefined : ids.description, validation() === undefined ? undefined : ids.message].filter(Boolean).join(' ') || undefined
  const value = () => { props.changed(); return props.settings.get(definition.id) }
  const modified = () => !Object.is(value(), definition.defaultValue)
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
  return (
    <ProductField
      controlId={controlId}
      label={name()}
      description={description()}
      metadata={<code>{definition.id}</code>}
      message={validationMessage()}
      invalid={validation() !== undefined}
      dataAttributes={{ 'data-setting-id': definition.id }}
      actions={<Show when={modified()}><button type="button" aria-label={messageText('settingsDialog.action.resetSettingAria', { name: name() })} onClick={resetValue}>{messageText('settingsDialog.action.reset')}</button></Show>}
    >
      <Show when={definition.type === 'boolean'}><ProductCheckbox id={controlId} ariaLabelledBy={ids.label} ariaDescribedBy={describedBy()} ariaInvalid={validation() !== undefined} checked={value() as boolean} onChange={setValue} /></Show>
      <Show when={definition.type === 'number'}><ProductNumberInput id={controlId} ariaLabelledBy={ids.label} ariaDescribedBy={describedBy()} ariaInvalid={validation() !== undefined} value={String(value())} min={definition.min} max={definition.max} step={definition.step} onCommit={commitNumber} onRevert={() => setValidation(undefined)} /></Show>
      <Show when={definition.type === 'string'}><input
        id={controlId}
        aria-labelledby={ids.label}
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
      <Show when={definition.type === 'combo'}><ProductSelect id={controlId} ariaLabelledBy={ids.label} ariaDescribedBy={describedBy()} ariaInvalid={validation() !== undefined} selectedId={String(value())} options={options().map((option) => ({ id: option.value, label: option.label, value: option.value }))} onSelect={(option) => setValue(option.value)} /></Show>
    </ProductField>
  )
}

export function SettingsDialog(props: {
  readonly settings: SettingsRegistry
  readonly commands: CommandRegistry
  readonly keybindings: KeybindingRegistry
  readonly request?: { readonly category: string; readonly id: string } | undefined
  readonly onRequestConsumed?: () => void
}) {
  const message = useAppMessage()
  let root!: HTMLDivElement
  let searchInput!: HTMLInputElement
  const changed = useSignal(props.settings.changed)
  const locale = useSignal(activeLocale)
  const [query, setQuery] = createSignal('')
  const definitions = () => { changed(); return searchableSettingsDefinitions(props.settings.list()) }
  const categories = () => [...new Set(definitions().map((d) => props.settings.categoryOf(d))), 'keybindings']
  // Derived categories are intentionally specific (for example canvas.grid), so select a real category rather than inventing a parent grouping.
  const [category, setCategory] = createSignal(initialSettingsCategory(definitions(), (d) => props.settings.categoryOf(d)))
  const [searchCategory, setSearchCategory] = createSignal<string>()
  const [capture, setCapture] = createSignal<{ readonly command: string; readonly pending: string }>()
  if (props.request) {
    setCategory(props.request.category)
  }
  onMount(() => {
    const request = props.request
    if (!request) return
    queueMicrotask(() => {
      root.querySelector<HTMLElement>(`[data-setting-id="${CSS.escape(request.id)}"] input, [data-setting-id="${CSS.escape(request.id)}"] [role="checkbox"], [data-setting-id="${CSS.escape(request.id)}"] [role="combobox"], [data-command-id="${CSS.escape(request.id)}"] button`)?.focus()
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
    () => { locale(); return buildSettingsSearchIndex(definitions(), (d) => props.settings.categoryOf(d), props.commands.list()) },
    undefined,
    { equals: sameIndex },
  )
  const searchGroups = createMemo(() => querySettingsIndex(index(), query()))
  const totalMatches = createMemo(() => searchGroups().reduce((total, group) => total + group.matches.length, 0))
  const matchCounts = createMemo(() => new Map(searchGroups().map((group) => [group.category, group.matches.length])))
  const shownSearchGroups = createMemo(() => {
    const narrowed = searchCategory()
    return narrowed === undefined ? searchGroups() : searchGroups().filter((group) => group.category === narrowed)
  })
  const matchCount = (candidate: string): number => matchCounts().get(candidate) ?? 0
  const categoryLabel = (candidate: string): string => {
    const key = `settingsDialog.category.${candidate.replaceAll('.', '_')}`
    const translated = message(key)
    return translated === key ? fallbackCategoryLabel(candidate) : translated
  }
  const shownMatchCount = createMemo(() => shownSearchGroups().reduce((total, group) => total + group.matches.length, 0))
  const searchSummary = (): string => {
    const count = shownMatchCount()
    const narrowed = searchCategory()
    return message(
      narrowed === undefined ? 'settingsDialog.search.summary' : 'settingsDialog.search.summaryInCategory',
      { count, query: query().trim(), category: narrowed === undefined ? '' : categoryLabel(narrowed) },
    )
  }
  const visible = () => definitions().filter((d) => props.settings.categoryOf(d) === category())
  const conflicts = () => { changed(); return props.keybindings.conflicts() }
  const selectCategory = (next: string): void => {
    if (searching()) setSearchCategory(next)
    else setCategory(next)
  }
  const clearSearch = (): void => {
    setQuery('')
    setSearchCategory(undefined)
    searchInput.focus()
  }
  const settingRow = (d: SettingDefinition) => {
    return <SettingField definition={d} settings={props.settings} changed={changed} locale={locale} />
  }
  const keybindingRow = (command: AppCommand) => {
    const controlId = `keybinding-${command.id}`
    const commandLabel = () => { locale(); return command.label }
    const combo = () => { changed(); return props.keybindings.combo(command.id) }
    const conflict = () => combo() ? conflicts().get(combo()!) : undefined
    const conflictMessage = () => {
      const ids = conflict()
      return ids === undefined ? undefined : message('settingsDialog.keybinding.conflict', { commands: ids.filter((id) => id !== command.id).join(', ') })
    }
    const captureText = () => capture()?.command === command.id ? capture()?.pending || message('settingsDialog.keybinding.pressKeys') : combo() ?? message('settingsDialog.keybinding.unbound')
    const ids = productFieldIds(controlId)
    return <ProductField
      controlId={controlId}
      label={commandLabel()}
      metadata={<code>{command.id}</code>}
      invalid={!!conflict()}
      dataAttributes={{ 'data-command-id': command.id }}
      actions={<>
        <button type="button" aria-label={message('settingsDialog.keybinding.resetAria', { name: commandLabel() })} onClick={() => { props.keybindings.reset(command.id); props.settings.changed.get() }}>{message('settingsDialog.action.reset')}</button>
        <button type="button" aria-label={message('settingsDialog.keybinding.clearAria', { name: commandLabel() })} onClick={() => { props.keybindings.set(command.id, null); props.settings.changed.get() }}>{message('settingsDialog.action.clear')}</button>
      </>}
      message={conflictMessage()}
    >
      <button
        id={controlId}
        type="button"
        class="binding-capture"
        aria-label={message('settingsDialog.keybinding.shortcutAria', { name: commandLabel(), shortcut: captureText() })}
        aria-invalid={conflict() ? 'true' : undefined}
        aria-describedby={conflict() ? ids.message : undefined}
        onClick={() => setCapture({ command: command.id, pending: '' })}
      >{captureText()}</button>
    </ProductField>
  }

  return (
    <div class="settings-editor" ref={root} onKeyDown={(e) => {
      const activeCapture = capture()
      if (activeCapture) {
        e.preventDefault(); e.stopPropagation()
        const result = captureKeydown(e)
        if (result.kind === 'pending') setCapture({ ...activeCapture, pending: result.combo })
        else if (result.kind === 'cancel') setCapture(undefined)
        else { props.keybindings.set(activeCapture.command, result.combo); setCapture(undefined); props.settings.changed.get() }
        return
      }
      if (e.key !== 'Escape' || e.defaultPrevented || !searching()) return
      e.preventDefault()
      e.stopPropagation()
      clearSearch()
    }}>
      <div class="settings-searchbar" role="search" aria-label={message('settingsDialog.search.regionAria')}>
        <input
          ref={searchInput}
          class="settings-search"
          type="search"
          aria-label={message('settingsDialog.search.label')}
          placeholder={message('settingsDialog.search.placeholder')}
          autocomplete="off"
          value={query()}
          onInput={(e) => { setQuery(e.currentTarget.value); setSearchCategory(undefined) }}
        />
        <Show when={searching()}><button type="button" class="settings-search-clear" aria-label={message('settingsDialog.search.clearAria')} onClick={clearSearch}>{message('settingsDialog.action.clear')}</button></Show>
      </div>
        <div class="settings-body">
          <nav classList={{ 'settings-categories': true, searching: searching() }} aria-label={message('settingsDialog.category.regionAria')}>
            <Show when={searching()}><button type="button" aria-label={message('settingsDialog.search.allResultsAria', { count: totalMatches() })} aria-current={searchCategory() === undefined ? 'page' : undefined} classList={{ active: searchCategory() === undefined }} onClick={() => setSearchCategory(undefined)}><span>{message('settingsDialog.search.allResults')}</span><span class="settings-category-count" aria-hidden="true">{totalMatches()}</span></button></Show>
            <For each={categories()}>{(c) => <button type="button" aria-label={searching() ? message('settingsDialog.search.categoryResultsAria', { category: categoryLabel(c), count: matchCount(c) }) : categoryLabel(c)} aria-current={(searching() ? searchCategory() === c : category() === c) ? 'page' : undefined} disabled={searching() && matchCount(c) === 0} classList={{ active: searching() ? searchCategory() === c : category() === c }} onClick={() => selectCategory(c)}><span>{categoryLabel(c)}</span><Show when={searching()}><span class="settings-category-count" aria-hidden="true">{matchCount(c)}</span></Show></button>}</For>
          </nav>
          <main class="settings-content">
            <Show when={searching()} fallback={<Show when={category() !== 'keybindings'} fallback={
              <div class="keybinding-table">
                <For each={props.commands.list()}>{keybindingRow}</For>
              </div>
            }>
              <For each={visible()}>{settingRow}</For>
            </Show>}>
              <div class="settings-results">
                <p class="settings-result-status" role="status" aria-live="polite">{searchSummary()}</p>
                <Show when={shownMatchCount() > 0} fallback={<div class="settings-empty-results"><strong>{message('settingsDialog.search.emptyTitle')}</strong><span>{message('settingsDialog.search.emptyBody')}</span></div>}>
                  <For each={shownSearchGroups()}>{(group) => {
                    const headingId = `settings-result-group-${group.category}`
                    return <section class="settings-result-group" data-category={group.category} aria-labelledby={headingId}>
                      <h2><button type="button" id={headingId} class="settings-result-heading" aria-label={message('settingsDialog.search.showOnlyCategoryAria', { category: categoryLabel(group.category), count: group.matches.length })} onClick={() => setSearchCategory(group.category)}><span>{categoryLabel(group.category)}</span><span class="settings-category-count" aria-hidden="true">{group.matches.length}</span></button></h2>
                      <For each={group.matches}>{(match) => match.source === 'setting' ? settingRow(match.definition) : keybindingRow(match.command)}</For>
                    </section>
                  }}</For>
                </Show>
              </div>
            </Show>
          </main>
        </div>
    </div>
  )
}
