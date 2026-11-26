import { For, Show, createMemo, createSignal } from 'solid-js'
import { captureKeydown } from '../../app/src/settings.js'
import {
  ProductButton, ProductPage, ProductSelect, ProductSettingRow,
  ProductSettingsPage, ProductSettingsSection, ProductShortcut, ProductSwitch,
  ProductTextArea, ProductTextInput, type ProductSearchGroup,
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
  { id: 'tooltips.delayMs', label: 'Tooltip delay (ms)', group: 'general', section: 'Workspace', value: 500, description: 'Between 0 and 5000 milliseconds.' },
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
  { id: 'storage.limit', label: 'Storage limit (GB)', group: 'storage', section: 'Local library', value: 100 },
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
  const [bindings, setBindings] = createSignal<Record<string, string>>({ 'workflow.open': 'Ctrl+Shift+O' })
  const [capture, setCapture] = createSignal<string>()
  const [status, setStatus] = createSignal('')
  const value = (setting: Setting) => values()[setting.id] ?? setting.value
  const update = (id: string, next: string | number | boolean) => setValues((old) => ({ ...old, [id]: next }))
  const sections = () => [...new Set(settings.filter((setting) => setting.group === group()).map((setting) => setting.section))]
  const searchGroups = createMemo<readonly ProductSearchGroup[]>(() => {
    if (query().trim() === '') return []
    const words = query().toLocaleLowerCase().trim().split(/\s+/)
    const matches = settings.filter((setting) => words.every((word) => `${setting.label} ${setting.id} ${setting.group} ${setting.section}`.toLocaleLowerCase().includes(word)))
    const shortcuts = commands.filter((command) => words.every((word) => `${command.label} ${command.id} Shortcuts`.toLocaleLowerCase().includes(word)))
    return [{ key: 'settings', label: `${matches.length} settings`, rows: matches.map((setting) => ({
      key: setting.id, title: setting.label, detail: `${groups.find((entry) => entry.id === setting.group)?.label} - ${setting.section}`,
      ...(typeof setting.value === 'boolean' ? { toggle: { checked: value(setting) as boolean, label: setting.label, onChange: (next: boolean) => update(setting.id, next) } } : {}),
    })) }, { key: 'shortcuts', label: 'Shortcuts', rows: shortcuts.map((command) => ({ key: command.id, title: command.label, detail: 'Shortcuts - Workflow', keys: (bindings()[command.id] ?? command.keys).split('+').filter(Boolean) })) }].filter((group) => group.rows.length > 0)
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
    const error = () => typeof setting.value === 'number' && (Number(value(setting)) < 0 || Number(value(setting)) > 5000) ? 'Enter a number between 0 and 5000.' : undefined
    const attributes = () => ({ id: setting.id, 'aria-labelledby': `${setting.id}-label`, 'aria-describedby': error() ? `${setting.id}-error` : setting.description ? `${setting.id}-description` : undefined, 'aria-invalid': error() ? 'true' as const : undefined })
    return <ProductSettingRow id={setting.id} label={setting.label} description={setting.description} error={error()}
      modified={value(setting) !== setting.value} resetLabel="Reset" menuLabel={`Actions for ${setting.label}`}
      resetDefaultLabel="Reset to default" copyIdLabel="Copy setting ID"
      onReset={() => update(setting.id, setting.value)} onCopyId={() => { void navigator.clipboard.writeText(setting.id); setStatus(`Copied ${setting.id}`) }}>
      <Show when={typeof setting.value === 'boolean'}><ProductSwitch label={setting.label} checked={value(setting) as boolean} onChange={(next) => update(setting.id, next)} /></Show>
      <Show when={setting.options}><ProductSelect {...attributes()} value={String(value(setting))} onChange={(event) => update(setting.id, event.currentTarget.value)}><For each={setting.options}>{(option) => <option>{option}</option>}</For></ProductSelect></Show>
      <Show when={typeof setting.value !== 'boolean' && !setting.options && !setting.multiline}><ProductTextInput {...attributes()} inputmode={typeof setting.value === 'number' ? 'decimal' : 'text'} value={String(value(setting))} onInput={(event) => update(setting.id, typeof setting.value === 'number' ? Number(event.currentTarget.value) : event.currentTarget.value)} /></Show>
      <Show when={setting.multiline}><ProductTextArea {...attributes()} value={String(value(setting))} onInput={(event) => update(setting.id, event.currentTarget.value)} /></Show>
    </ProductSettingRow>
  }
  const record = (event: KeyboardEvent) => {
    const id = capture()
    if (!id) return
    event.preventDefault(); event.stopPropagation()
    const result = captureKeydown(event)
    if (result.kind === 'cancel') setCapture(undefined)
    else if (result.kind === 'complete') {
      setBindings((old) => ({ ...old, [id]: result.combo })); setCapture(undefined)
    }
  }
  return <ProductPage table title="Settings page" description="Shared page and controls with in-memory settings, shortcuts and service examples.">
    <div class="dinkster-settings-example" onKeyDown={record}>
      <ProductSettingsPage title="Settings" groupsLabel="Settings groups" groups={groups} group={group()} onGroup={chooseGroup}
        search={{ label: 'Search settings', placeholder: 'Search settings', get query() { return query() }, onQuery: (next) => { setQuery(next); setCurrent('') }, get groups() { return searchGroups() }, get current() { return current() }, onCurrent: setCurrent, onActivate: activate, onClose: () => setQuery(''), empty: { title: 'No matching settings', detail: 'Try a setting name or its ID.' } }}>
        <Show when={group() === 'shortcuts'} fallback={<For each={sections()}>{(section) => <ProductSettingsSection title={section}><For each={settings.filter((setting) => setting.group === group() && setting.section === section)}>{row}</For></ProductSettingsSection>}</For>}>
          <ProductSettingsSection title="Workflow"><For each={commands}>{(command) => <ProductSettingRow
            id={command.id} label={command.label} modified={(bindings()[command.id] ?? command.keys) !== command.keys}
            resetLabel="Reset" menuLabel={`Actions for ${command.label}`} resetDefaultLabel="Reset to default" copyIdLabel="Copy command ID"
            onReset={() => setBindings((old) => ({ ...old, [command.id]: command.keys }))} onCopyId={() => { void navigator.clipboard.writeText(command.id) }}>
            <ProductButton id={command.id} aria-label={`Record shortcut for ${command.label}`} onClick={() => setCapture(command.id)}>
              <Show when={capture() !== command.id} fallback="Press the keys, Esc cancels"><Show when={bindings()[command.id] ?? command.keys} fallback="Set">{(keys) => <ProductShortcut keys={keys()} />}</Show></Show>
            </ProductButton>
          </ProductSettingRow>}</For></ProductSettingsSection>
        </Show>
      </ProductSettingsPage>
    </div>
    <p class="dinkster-metadata" role="status">{status()}</p>
  </ProductPage>
}
