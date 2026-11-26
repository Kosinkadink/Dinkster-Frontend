import { For, Show, createMemo, createSignal } from 'solid-js'
import { captureKeydown, KeybindingRegistry, SettingsRegistry } from '../../app/src/settings.js'
import { useSignal } from '../../app/src/solid-adapter.js'
import { ProductNumberInput } from '../../app/src/ProductNumberInput.js'
import {
  ProductButton, ProductPage, ProductSelect, ProductSettingRow,
  ProductSettingsPage, ProductSettingsSection, ProductShortcut, ProductSwitch,
  ProductTextArea, ProductTextInput, ProductToast, ProductErrorBanner, type ProductSearchGroup,
} from '../src/index.js'

interface Setting {
  id: string
  label: string
  group: string
  section: string
  value: string | number | boolean
  description?: string
  options?: readonly string[]
  multiline?: boolean
  unit?: string
}

const groups = [
  ['general', 'General'], ['canvas', 'Canvas'], ['runs', 'Runs'], ['shortcuts', 'Shortcuts'],
  ['storage', 'Storage'], ['packs', 'Packs'], ['engine', 'This engine'],
  ['experimental', 'Experimental'], ['advanced', 'Advanced'],
].map(([id, label]) => ({ id: id!, label: label! }))

const settings: readonly Setting[] = [
  { id: 'dinkster.locale', label: 'Language', group: 'general', section: 'Appearance', value: 'Automatic', options: ['Automatic', 'English', 'Chinese'] },
  { id: 'dinkster.theme', label: 'Theme', group: 'general', section: 'Appearance', value: 'Dark', options: ['Dark', 'Light'] },
  { id: 'shell.activityBar.visible', label: 'Activity bar visible', group: 'general', section: 'Workspace', value: true },
  { id: 'tooltips.delayMs', label: 'Tooltip delay', group: 'general', section: 'Workspace', value: 500, unit: 'ms', description: 'Between 0 and 5000 milliseconds.' },
  { id: 'canvas.grid.visible', label: 'Show dot grid', group: 'canvas', section: 'View', value: true },
  { id: 'canvas.smoothWheelZoom', label: 'Smooth wheel zoom', group: 'canvas', section: 'View', value: true, description: 'Glide briefly between wheel zoom steps.' },
  { id: 'canvas.scrollBehavior', label: 'Scroll behaviour', group: 'canvas', section: 'View', value: 'Zoom', options: ['Zoom', 'Pan'], description: 'What the wheel and a two-finger scroll do on the canvas.' },
  { id: 'canvas.bookmarkTransitions', label: 'Animate bookmark jumps', group: 'canvas', section: 'View', value: true },
  { id: 'canvas.minimap.visible', label: 'Show minimap', group: 'canvas', section: 'Minimap', value: true },
  { id: 'canvas.minimap.size', label: 'Size', group: 'canvas', section: 'Minimap', value: 'Small', options: ['Small', 'Medium', 'Large'] },
  { id: 'canvas.minimap.groups', label: 'Show frames and groups', group: 'canvas', section: 'Minimap', value: true },
  { id: 'canvas.minimap.bookmarks', label: 'Show bookmark numbers', group: 'canvas', section: 'Minimap', value: false },
  { id: 'execution.previews', label: 'Live sampling previews', group: 'runs', section: 'Previews', value: 'Off', options: ['Off', 'Cheap', 'Quality', 'Auto'] },
  { id: 'execution.mirrorPreviews', label: 'Mirror previews', group: 'runs', section: 'Previews', value: true },
  { id: 'storage.limit', label: 'Storage limit', group: 'storage', section: 'Local library', value: 100, unit: 'GB' },
  { id: 'pack.example.enabled', label: 'Enable example pack feature', group: 'packs', section: 'Example pack', value: true, description: 'Gallery fixture, not a live pack setting.' },
  { id: 'engine.logging', label: 'Log level', group: 'engine', section: 'Local engine', value: 'Info', options: ['Debug', 'Info', 'Warning'], description: 'Gallery fixture, not a live engine setting.' },
  { id: 'features.appView.enabled', label: 'App view', group: 'experimental', section: 'Features', value: false },
  { id: 'diagnostics.frameRate', label: 'Show frame rate', group: 'advanced', section: 'Diagnostics', value: false },
  { id: 'search.registryUrl', label: 'Node registry address', group: 'advanced', section: 'Registries', value: 'https://registry.dinkster.org/static' },
  { id: 'pack.example.prompt', label: 'Default prompt', group: 'packs', section: 'Example pack', value: 'A quiet mountain valley', multiline: true },
]

const commands = [
  { id: 'workflow.queue', label: 'Run workflow', keys: 'Ctrl+Enter' },
  { id: 'workflow.save', label: 'Save workflow', keys: 'Ctrl+S' },
  { id: 'workflow.open', label: 'Open workflow library', keys: 'Ctrl+O' },
  { id: 'workflow.cancel', label: 'Cancel current run', keys: '' },
]

/** In-memory examples exercise the shared page; no application preferences are written. */
export function SettingsGallery() {
  const [group, setGroup] = createSignal('canvas')
  const [query, setQuery] = createSignal('')
  const [current, setCurrent] = createSignal('')
  const [values, setValues] = createSignal<Record<string, string | number | boolean>>({ 'canvas.smoothWheelZoom': false })
  const preferences = new SettingsRegistry({ getItem: () => null, setItem: () => {} })
  const keybindings = new KeybindingRegistry(preferences)
  for (const command of commands) keybindings.register({ command: command.id, combo: command.keys })
  keybindings.set('workflow.open', 'Ctrl+Shift+O')
  const changed = useSignal(preferences.changed)
  const combo = (id: string) => { changed(); return keybindings.combo(id) ?? '' }
  const [capture, setCapture] = createSignal<string>()
  const [pendingKeys, setPendingKeys] = createSignal('')
  const [toast, setToast] = createSignal<{ message: string }>()
  const [copyError, setCopyError] = createSignal('')
  const value = (setting: Setting) => values()[setting.id] ?? setting.value
  const update = (id: string, next: string | number | boolean) => setValues((old) => ({ ...old, [id]: next }))
  const copyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id)
      setCopyError('')
      setToast({ message: `Copied ${id}` })
    } catch {
      setCopyError('The browser could not copy the ID. Use a secure browser connection and try again.')
    }
  }
  const settingMenu = (setting: Setting) => ({
    label: `Actions for ${setting.label}`,
    get items() { return [
      { label: 'Reset to default', disabled: value(setting) === setting.value, onSelect: () => update(setting.id, setting.value) },
      { label: 'Copy setting ID', description: setting.id, onSelect: () => { void copyId(setting.id) } },
    ] },
  })
  const error = (setting: Setting) => typeof setting.value === 'number' && (!Number.isFinite(Number(value(setting))) || Number(value(setting)) < 0 || Number(value(setting)) > 5000) ? 'Enter a number between 0 and 5000.' : undefined
  const control = (setting: Setting, searching = false) => {
    const attributes = () => ({ id: setting.id, 'aria-label': setting.label, 'aria-describedby': error(setting) ? `${setting.id}-error` : !searching && setting.description ? `${setting.id}-description` : undefined, 'aria-invalid': error(setting) ? 'true' as const : undefined })
    return <>
      <Show when={typeof setting.value === 'boolean'}><ProductSwitch id={setting.id} label={setting.label} checked={value(setting) as boolean} onChange={(next) => update(setting.id, next)} /></Show>
      <Show when={setting.options}><ProductSelect {...attributes()} value={String(value(setting))} onChange={(event) => update(setting.id, event.currentTarget.value)}><For each={setting.options}>{(option) => <option>{option}</option>}</For></ProductSelect></Show>
      <Show when={typeof setting.value === 'number'}><ProductNumberInput id={setting.id} ariaLabel={setting.label} ariaInvalid={error(setting) !== undefined} ariaDescribedBy={attributes()['aria-describedby']} value={value(setting) as number} min={0} max={5000} unit={setting.unit} onCommit={(raw) => update(setting.id, Number(raw))} /></Show>
      <Show when={typeof setting.value === 'string' && !setting.options && !setting.multiline}><ProductTextInput {...attributes()} value={String(value(setting))} onInput={(event) => update(setting.id, event.currentTarget.value)} /></Show>
      <Show when={setting.multiline}><ProductTextArea {...attributes()} value={String(value(setting))} onInput={(event) => update(setting.id, event.currentTarget.value)} /></Show>
      <Show when={searching && error(setting)}>{(message) => <p id={`${setting.id}-error`} class="dinkster-field-error" role="alert">{message()}</p>}</Show>
    </>
  }
  const shortcutError = (id: string) => combo(id) && keybindings.conflicts().get(combo(id)) ? `Also used by ${commands.filter((other) => other.id !== id && combo(other.id) === combo(id)).map((other) => other.label).join(', ')}.` : undefined
  const shortcutControl = (command: typeof commands[number]) => <ProductButton id={command.id}
    aria-label={`Record shortcut for ${command.label}`} aria-describedby={shortcutError(command.id) ? `${command.id}-warning` : undefined}
    onClick={() => { setPendingKeys(''); setCapture(command.id) }}>
    <Show when={capture() !== command.id} fallback={<Show when={pendingKeys()} fallback={<>Press the keys, <span class="dinkster-setting-cancel">Esc cancels</span></>}>{(keys) => <ProductShortcut keys={keys()} />}</Show>}><Show when={combo(command.id)} fallback="Set">{(keys) => <ProductShortcut keys={keys()} />}</Show></Show>
  </ProductButton>
  const shortcutMenu = (command: typeof commands[number]) => ({
    label: `Actions for ${command.label}`,
    get items() { return [
      { label: 'Reset to default', disabled: combo(command.id) === keybindings.defaultCombo(command.id), onSelect: () => keybindings.reset(command.id) },
      { label: 'Copy command ID', description: command.id, onSelect: () => { void copyId(command.id) } },
    ] },
  })
  const sections = () => [...new Set(settings.filter((setting) => setting.group === group()).map((setting) => setting.section))]
  const searchGroups = createMemo<readonly ProductSearchGroup[]>(() => {
    if (query().trim() === '') return []
    const words = query().toLocaleLowerCase().trim().split(/\s+/)
    const matches = settings.filter((setting) => words.every((word) => `${setting.label} ${setting.id} ${setting.group} ${setting.section}`.toLocaleLowerCase().includes(word)))
    const shortcuts = commands.filter((command) => words.every((word) => `${command.label} ${command.id} Shortcuts`.toLocaleLowerCase().includes(word)))
    return [{ key: 'settings', label: `${matches.length} ${matches.length === 1 ? 'setting' : 'settings'}`, rows: matches.map((setting) => ({
      key: setting.id, title: setting.label, detail: `${groups.find((entry) => entry.id === setting.group)?.label} - ${setting.section}`,
      control: control(setting, true), menu: settingMenu(setting),
    })) }, { key: 'shortcuts', label: 'Shortcuts', rows: shortcuts.map((command) => ({ key: command.id, title: command.label, detail: 'Shortcuts - Workflow', control: <>{shortcutControl(command)}<Show when={shortcutError(command.id)}>{(message) => <p id={`${command.id}-warning`} class="dinkster-setting-warning" role="status">{message()}</p>}</Show></>, menu: shortcutMenu(command) })) }].filter((group) => group.rows.length > 0)
  })
  const chooseGroup = (id: string) => { setGroup(id); setQuery(''); setCapture(undefined) }
  const activate = (id: string) => {
    if (commands.some((command) => command.id === id)) {
      chooseGroup('shortcuts')
      queueMicrotask(() => document.getElementById(id)?.focus())
      return
    }
    const setting = settings.find((entry) => entry.id === id)
    if (!setting) return
    if (typeof setting.value === 'boolean') update(id, !value(setting))
    else {
      chooseGroup(setting.group)
      queueMicrotask(() => document.getElementById(id)?.focus())
    }
  }
  const row = (setting: Setting) => {
    return <ProductSettingRow id={setting.id} label={setting.label} description={setting.description} error={error(setting)}
      fullWidth={typeof setting.value === 'string' && !setting.options} modified={value(setting) !== setting.value} resetLabel="Reset" menuLabel={`Actions for ${setting.label}`}
      resetDefaultLabel="Reset to default" copyIdLabel="Copy setting ID"
      onReset={() => update(setting.id, setting.value)} onCopyId={() => { void copyId(setting.id) }}>
      {control(setting)}
    </ProductSettingRow>
  }
  const record = (event: KeyboardEvent) => {
    const id = capture()
    if (!id) return
    event.preventDefault(); event.stopPropagation()
    const result = captureKeydown(event)
    if (result.kind === 'cancel') setCapture(undefined)
    else if (result.kind === 'pending') setPendingKeys(result.combo)
    else if (result.kind === 'complete') {
      keybindings.set(id, result.combo); setCapture(undefined)
    }
  }
  return <ProductPage table title="Settings page" description="Shared page and controls with in-memory settings, shortcuts and service examples.">
    <Show when={copyError()}><ProductErrorBanner onDismiss={() => setCopyError('')}>{copyError()}</ProductErrorBanner></Show>
    <div class="dinkster-settings-example" onKeyDown={record}>
      <ProductSettingsPage title="Settings" groupsLabel="Settings groups" groups={groups} group={group()} onGroup={chooseGroup}
        search={{ label: 'Search settings', placeholder: 'Search settings', get query() { return query() }, onQuery: (next) => { setCapture(undefined); setQuery(next); setCurrent('') }, get groups() { return searchGroups() }, get current() { return current() }, onCurrent: setCurrent, onActivate: activate, onClose: () => setQuery(''), empty: { title: 'No matching settings', detail: 'Try a setting name or its ID.' } }}>
        <Show when={group() === 'shortcuts'} fallback={<For each={sections()}>{(section) => <ProductSettingsSection title={section}><For each={settings.filter((setting) => setting.group === group() && setting.section === section)}>{row}</For></ProductSettingsSection>}</For>}>
          <ProductSettingsSection title="Workflow"><For each={commands}>{(command) => <ProductSettingRow
            id={command.id} label={command.label} modified={combo(command.id) !== keybindings.defaultCombo(command.id)}
            warning={shortcutError(command.id)}
            resetLabel="Reset" menuLabel={`Actions for ${command.label}`} resetDefaultLabel="Reset to default" copyIdLabel="Copy command ID"
            onReset={() => keybindings.reset(command.id)} onCopyId={() => { void copyId(command.id) }}>
            {shortcutControl(command)}
          </ProductSettingRow>}</For></ProductSettingsSection>
        </Show>
      </ProductSettingsPage>
    </div>
    <ProductToast notification={toast()} onDismiss={() => setToast(undefined)} />
  </ProductPage>
}
