import { For, Show, createMemo, createSignal } from 'solid-js'
import { LockKeyhole } from 'lucide-solid'
import { captureKeydown, KeybindingRegistry, SettingsRegistry } from '../../app/src/settings.js'
import { settingsCommandGroups } from '../../app/src/settings-search.js'
import { AutomaticFixField, automaticFixGroups } from '../../app/src/SettingsDialog.js'
import { automaticFixKinds, automaticFixLabel, automaticFixPreference, registerAutomaticFixSettings } from '../../app/src/automatic-fixes.js'
import { useAppMessage } from '../../app/src/locale.js'
import { useSignal } from '../../app/src/solid-adapter.js'
import { ProductNumberInput } from '../../app/src/ProductNumberInput.js'
import {
  ProductButton, ProductByteSizeInput, ProductConfirmation, ProductDialog, ProductIcon, ProductPage, ProductSelect, ProductSettingRow, ProductTextButton,
  ProductSettingsPage, ProductSettingsSection, ProductShortcutCapture, ProductShortcutText, ProductSwitch,
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
  locked?: boolean
  list?: boolean
}

const groups = [
  ['general', 'General'], ['canvas', 'Canvas'], ['automaticFixes', 'Automatic fixes'], ['runs', 'Runs'], ['shortcuts', 'Shortcuts'],
  ['storage', 'Storage'], ['packs', 'Packs'], ['engine', 'This engine'],
  ['experimental', 'Experimental'], ['advanced', 'Advanced'],
].map(([id, label]) => ({ id: id!, label: label! }))

const settings: readonly Setting[] = [
  { id: 'dinkster.locale', label: 'Language', group: 'general', section: 'Appearance', value: 'Automatic', options: ['Automatic', 'English', 'Chinese'] },
  { id: 'dinkster.theme', label: 'Theme', group: 'general', section: 'Appearance', value: 'Dark', options: ['Dark', 'Light'] },
  { id: 'shell.activityBar.visible', label: 'Activity bar visible', group: 'general', section: 'Workspace', value: true },
  { id: 'tooltips.delayMs', label: 'Tooltip delay', group: 'general', section: 'Workspace', value: 500, unit: 'ms' },
  { id: 'shell.layout.left.width', label: 'Left panel size', group: 'general', section: 'Workspace', value: 380, unit: 'px' },
  { id: 'shell.layout.right.width', label: 'Right panel size', group: 'general', section: 'Workspace', value: 380, unit: 'px' },
  { id: 'shell.layout.bottom.height', label: 'Bottom panel size', group: 'general', section: 'Workspace', value: 240, unit: 'px' },
  { id: 'canvas.grid.visible', label: 'Show dot grid', group: 'canvas', section: 'View', value: true },
  { id: 'canvas.detailMode', label: 'Hide node details', group: 'canvas', section: 'View', value: 'Automatic', options: ['Automatic', 'Below a fixed zoom'], description: 'Automatic keeps details longer when fewer nodes are on screen.' },
  { id: 'canvas.detailMinPercent', label: 'Fixed zoom (%)', group: 'canvas', section: 'View', value: 30, description: '10 to 75. Details stay visible at this zoom and above.' },
  { id: 'canvas.smoothWheelZoom', label: 'Smooth wheel zoom', group: 'canvas', section: 'View', value: true, description: 'Glide briefly between wheel zoom steps.' },
  { id: 'canvas.scrollBehavior', label: 'Canvas scroll behavior', group: 'canvas', section: 'View', value: 'Zoom', options: ['Zoom', 'Pan'], description: 'Zoom makes wheel and two-finger scroll zoom about the pointer. Pan makes ordinary scrolling move the canvas while `Ctrl+wheel` or trackpad pinch zooms.' },
  { id: 'canvas.bookmarkTransitions', label: 'Animate bookmark jumps', group: 'canvas', section: 'View', value: true },
  { id: 'canvas.minimap.visible', label: 'Show minimap', group: 'canvas', section: 'Minimap', value: true },
  { id: 'canvas.minimap.size', label: 'Size', group: 'canvas', section: 'Minimap', value: 'Small', options: ['Small', 'Medium', 'Large'] },
  { id: 'canvas.minimap.nodes', label: 'Colors', group: 'canvas', section: 'Minimap', value: true },
  { id: 'canvas.minimap.noodles', label: 'Links', group: 'canvas', section: 'Minimap', value: true },
  { id: 'canvas.minimap.groups', label: 'Frames and groups', group: 'canvas', section: 'Minimap', value: true },
  { id: 'canvas.minimap.errors', label: 'Errors', group: 'canvas', section: 'Minimap', value: true },
  { id: 'canvas.minimap.bookmarks', label: 'Bookmark numbers', group: 'canvas', section: 'Minimap', value: false },
  { id: 'execution.previews', label: 'Live sampling previews', group: 'runs', section: 'Previews', value: 'Off', options: ['Off', 'Cheap', 'Quality', 'Auto'] },
  { id: 'execution.mirrorPreviews', label: 'Mirror previews', group: 'runs', section: 'Previews', value: true },
  { id: 'storage.limited', label: 'Limit the space run files may use', group: 'storage', section: 'Limit', value: true },
  { id: 'storage.limit', label: 'Keep at most', group: 'storage', section: 'Limit', value: 10737418240, unit: 'GB' },
  { id: 'pack.dinkster-nodes-dev.showTips', label: 'Show example tips', group: 'packs', section: 'Dinkster nodes (dev)', value: false, description: 'An example stored pack preference; it does not change node execution.' },
  { id: 'pack.example.enabled', label: 'Enable example pack feature', group: 'packs', section: 'Example pack', value: true, description: 'Gallery fixture, not a live pack setting.' },
  { id: 'engine.dtype.diffusion', label: 'Diffusion model precision', group: 'engine', section: 'Local engine - applies to workers started from now on', value: 'Auto', options: ['Auto', 'FP16', 'BF16', 'FP32'] },
  { id: 'engine.dtype.textEncoder', label: 'Text encoder precision', group: 'engine', section: 'Local engine - applies to workers started from now on', value: 'Auto', options: ['Auto', 'FP16', 'BF16', 'FP32'] },
  { id: 'engine.dtype.vae', label: 'VAE precision', group: 'engine', section: 'Local engine - applies to workers started from now on', value: 'Auto', options: ['Auto', 'FP16', 'BF16', 'FP32'] },
  { id: 'engine.fp8', label: 'Native FP8 matrix multiplication', group: 'engine', section: 'Local engine - applies to workers started from now on', value: false },
  { id: 'engine.jobs', label: 'Maximum running jobs', group: 'engine', section: 'Local engine - applies immediately', value: 1 },
  { id: 'engine.arguments', label: 'Worker arguments', group: 'engine', section: 'Local engine - applies to workers started from now on', value: '', list: true },
  { id: 'engine.logging', label: 'Default log level', group: 'engine', section: 'Local engine - applies immediately', value: 'Info', options: ['Debug', 'Info', 'Warning', 'Error', 'Critical'] },
  { id: 'engine.loggers', label: 'Logger overrides', group: 'engine', section: 'Local engine - applies immediately', value: '', list: true },
  { id: 'studio.dtype.diffusion', label: 'Diffusion model precision', group: 'engine', section: 'Studio server', value: 'Auto', locked: true },
  { id: 'studio.dtype.textEncoder', label: 'Text encoder precision', group: 'engine', section: 'Studio server', value: 'BF16', locked: true },
  { id: 'studio.dtype.vae', label: 'VAE precision', group: 'engine', section: 'Studio server', value: 'FP16', locked: true },
  { id: 'studio.fp8', label: 'Native FP8 matrix multiplication', group: 'engine', section: 'Studio server', value: false, locked: true },
  { id: 'studio.jobs', label: 'Maximum running jobs', group: 'engine', section: 'Studio server', value: 2, locked: true },
  { id: 'studio.arguments', label: 'Worker arguments', group: 'engine', section: 'Studio server', value: 'None', locked: true },
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
  { id: 'edit.undo', label: 'Undo', keys: 'Ctrl+Z' },
  { id: 'view.zoomIn', label: 'Zoom in', keys: 'Alt+=' },
]

/** In-memory examples exercise the shared page; no application preferences are written. */
export function SettingsGallery() {
  const message = useAppMessage()
  const [group, setGroup] = createSignal('canvas')
  const [query, setQuery] = createSignal('')
  const [current, setCurrent] = createSignal('')
  const [values, setValues] = createSignal<Record<string, string | number | boolean>>({ 'canvas.smoothWheelZoom': false })
  const preferences = new SettingsRegistry({ getItem: () => null, setItem: () => {} })
  registerAutomaticFixSettings(preferences)
  const keybindings = new KeybindingRegistry(preferences)
  for (const command of commands) keybindings.register({ command: command.id, combo: command.keys })
  keybindings.set('workflow.open', 'Ctrl+Shift+O')
  const changed = useSignal(preferences.changed)
  const combo = (id: string) => { changed(); return keybindings.combo(id) ?? '' }
  const [capture, setCapture] = createSignal<string>()
  const [pendingKeys, setPendingKeys] = createSignal('')
  const [toast, setToast] = createSignal<{ message: string }>()
  const [copyError, setCopyError] = createSignal('')
  const [editingList, setEditingList] = createSignal<string>()
  const [listDraft, setListDraft] = createSignal('')
  const [confirmClear, setConfirmClear] = createSignal(false)
  const [cleared, setCleared] = createSignal(false)
  const value = (setting: Setting) => values()[setting.id] ?? setting.value
  const disabled = (setting: Setting) => setting.id === 'canvas.detailMinPercent' && (values()['canvas.detailMode'] ?? 'Automatic') === 'Automatic'
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
      { label: setting.group === 'engine' ? 'Copy ID' : 'Copy setting ID', description: setting.id, onSelect: () => { void copyId(setting.id) } },
    ] },
  })
  const error = (setting: Setting) => typeof setting.value === 'number' && setting.unit !== 'GB' && (!Number.isFinite(Number(value(setting))) || Number(value(setting)) < 0 || Number(value(setting)) > 5000) ? 'Enter a number between 0 and 5000.' : undefined
  const control = (setting: Setting, searching = false) => {
    const attributes = () => ({ id: setting.id, 'aria-label': setting.label, 'aria-describedby': error(setting) ? `${setting.id}-error` : !searching && setting.description ? `${setting.id}-description` : undefined, 'aria-invalid': error(setting) ? 'true' as const : undefined })
    return <Show when={!setting.locked} fallback={<output id={setting.id} class="dinkster-setting-locked">{typeof value(setting) === 'boolean' ? value(setting) ? 'On' : 'Off' : String(value(setting))}</output>}>
      <Show when={setting.list} fallback={<>
      <Show when={typeof setting.value === 'boolean'}><ProductSwitch id={setting.id} label={setting.label} checked={value(setting) as boolean} onChange={(next) => update(setting.id, next)} /></Show>
      <Show when={setting.options}><ProductSelect {...attributes()} options={(setting.options ?? []).map((value) => ({ value, label: value }))} value={String(value(setting))} onChange={(next) => update(setting.id, next)} /></Show>
      <Show when={typeof setting.value === 'number'}><Show when={setting.unit === 'GB'} fallback={<ProductNumberInput id={setting.id} ariaLabel={setting.label} ariaInvalid={error(setting) !== undefined} ariaDescribedBy={attributes()['aria-describedby']} value={value(setting) as number} min={setting.id === 'canvas.detailMinPercent' ? 10 : 0} max={setting.id === 'canvas.detailMinPercent' ? 75 : 5000} disabled={disabled(setting)} unit={setting.unit} onCommit={(raw) => update(setting.id, Number(raw))} />}><ProductByteSizeInput {...attributes()} value={value(setting) as number} minimum={1} onCommit={(bytes) => update(setting.id, bytes)} /></Show></Show>
      <Show when={typeof setting.value === 'string' && !setting.options && !setting.multiline}><ProductTextInput {...attributes()} value={String(value(setting))} onInput={(event) => update(setting.id, event.currentTarget.value)} /></Show>
      <Show when={setting.multiline}><ProductTextArea {...attributes()} value={String(value(setting))} onInput={(event) => update(setting.id, event.currentTarget.value)} /></Show>
      </>}>
        <Show when={editingList() === setting.id} fallback={<><span class="dinkster-setting-none">{String(value(setting)).trim() === '' ? 'None' : `${String(value(setting)).split('\n').filter((line) => line.trim()).length} items`}</span><ProductTextButton id={setting.id} label="Edit" aria-label={`Edit ${setting.label.toLowerCase()}`} onClick={() => { setListDraft(String(value(setting))); setEditingList(setting.id) }} /></>}>
          <ProductTextArea {...attributes()} value={listDraft()} onInput={(event) => setListDraft(event.currentTarget.value)} />
          <ProductTextButton label="Done" onClick={() => { update(setting.id, listDraft()); setEditingList(undefined) }} />
          <ProductTextButton label="Cancel" onClick={() => setEditingList(undefined)} />
        </Show>
      </Show>
      <Show when={searching && error(setting)}>{(message) => <p id={`${setting.id}-error`} class="dinkster-field-error" role="alert">{message()}</p>}</Show>
    </Show>
  }
  const shortcutError = (id: string) => combo(id) && keybindings.conflicts().get(combo(id)) ? message('settingsDialog.keybinding.conflict', { commands: commands.filter((other) => other.id !== id && combo(other.id) === combo(id)).map((other) => other.label).join(', ') }) : undefined
  const shortcutControl = (command: typeof commands[number]) => <ProductShortcutCapture id={command.id}
    aria-label={`Record shortcut for ${command.label}`} aria-describedby={shortcutError(command.id) ? `${command.id}-warning` : undefined}
    keys={combo(command.id)} recording={capture() === command.id} pendingKeys={pendingKeys()}
    noneLabel="None" recordingLabel="Press the keys" cancelLabel="Esc cancels"
    onClick={() => { setPendingKeys(''); setCapture(command.id) }} />
  const shortcutMenu = (command: typeof commands[number]) => ({
    label: `Actions for ${command.label}`,
    get items() { return [
      ...(combo(command.id) ? [{ label: message('settingsPage.removeShortcut'), onSelect: () => keybindings.set(command.id, null) }] : []),
      { label: 'Copy command ID', description: command.id, onSelect: () => { void copyId(command.id) } },
    ] },
  })
  const limited = createMemo(() => (values()['storage.limited'] ?? true) === true)
  const visible = (setting: Setting) => setting.id !== 'storage.limit' || limited()
  const sections = () => [...new Set(settings.filter((setting) => setting.group === group()).map((setting) => setting.section))]
  const searchGroups = createMemo<readonly ProductSearchGroup[]>(() => {
    if (query().trim() === '') return []
    const words = query().toLocaleLowerCase().trim().split(/\s+/)
    const matches = settings.filter((setting) => visible(setting) && words.every((word) => `${setting.label} ${setting.id} ${setting.group} ${setting.section} ${setting.description ?? ''}`.toLocaleLowerCase().includes(word)))
    const fixMatches = automaticFixKinds.filter((kind) => words.every((word) => `${message(`automaticFixes.kind.${kind.id}`)} ${kind.setting} Automatic fixes ${automaticFixLabel(kind.id, false, message)}`.toLocaleLowerCase().includes(word)))
    const shortcuts = commands.filter((command) => words.every((word) => `${command.label} ${command.id} Shortcuts`.toLocaleLowerCase().includes(word)))
    return [{ key: 'settings', label: `${matches.length} ${matches.length === 1 ? 'setting' : 'settings'}`, rows: matches.map((setting) => {
      const path = `${groups.find((entry) => entry.id === setting.group)?.label} - ${setting.section}`
      const nameMatches = words.some((word) => setting.label.toLocaleLowerCase().includes(word))
      const descriptionMatches = setting.description && words.some((word) => setting.description!.toLocaleLowerCase().includes(word))
      const pathMatches = words.some((word) => path.toLocaleLowerCase().includes(word))
      return { key: setting.id, title: setting.label, detail: nameMatches || descriptionMatches || pathMatches ? path : `${setting.id} - ${path}`,
        ...(!nameMatches && descriptionMatches ? { note: setting.description! } : {}),
        get modified() { return setting.group !== 'engine' && value(setting) !== setting.value },
        fullWidth: typeof setting.value === 'string' && !setting.options,
        control: <><Show when={setting.group !== 'engine' && value(setting) !== setting.value}><ProductTextButton label="Reset" disabled={disabled(setting)} onClick={() => update(setting.id, setting.value)} /></Show>{control(setting, true)}</>, menu: settingMenu(setting),
      }
    }) }, { key: 'fixes', label: 'Automatic fixes', rows: fixMatches.map((kind) => ({ key: kind.setting, title: message(`automaticFixes.kind.${kind.id}`), detail: `Automatic fixes - ${message(`automaticFixes.group.${automaticFixGroups.find((group) => (group.kinds as readonly string[]).includes(kind.id))!.id}`)}`, get modified() { changed(); return automaticFixPreference(preferences, kind) !== 'apply' }, control: <AutomaticFixField kind={kind} settings={preferences} changed={changed} inline onCopyId={(id) => { void copyId(id) }} /> })) }, { key: 'shortcuts', label: 'Shortcuts', rows: shortcuts.map((command) => ({ key: command.id, title: command.label, get modified() { return combo(command.id) !== keybindings.defaultCombo(command.id) }, detail: `Shortcuts - ${message(`settingsPage.commands.${command.id.split('.')[0]}`)}`, control: <><Show when={combo(command.id) !== keybindings.defaultCombo(command.id)}><ProductTextButton label="Reset" onClick={() => keybindings.reset(command.id)} /></Show>{shortcutControl(command)}<Show when={shortcutError(command.id)}>{(message) => <p id={`${command.id}-warning`} class="dinkster-setting-warning" role="status">{message()}</p>}</Show></>, menu: shortcutMenu(command) })) }].filter((group) => group.rows.length > 0)
  })
  const chooseGroup = (id: string) => { setGroup(id); setQuery(''); setCapture(undefined) }
  const activate = (id: string) => {
    if (automaticFixKinds.some((kind) => kind.setting === id)) {
      chooseGroup('automaticFixes')
      queueMicrotask(() => document.getElementById(`setting-${id}`)?.focus())
      return
    }
    if (commands.some((command) => command.id === id)) {
      chooseGroup('shortcuts')
      queueMicrotask(() => document.getElementById(id)?.focus())
      return
    }
    const setting = settings.find((entry) => entry.id === id)
    if (!setting) return
    if (setting.locked) return
    if (typeof setting.value === 'boolean') update(id, !value(setting))
    else {
      chooseGroup(setting.group)
      queueMicrotask(() => document.getElementById(id)?.focus())
    }
  }
  const row = (setting: Setting) => {
    return <ProductSettingRow id={setting.id} label={setting.label} description={setting.description ? <ProductShortcutText text={setting.description} /> : undefined} error={error(setting)} disabled={disabled(setting)}
      fullWidth={!setting.locked && (setting.list ? editingList() === setting.id : typeof setting.value === 'string' && !setting.options)} modified={setting.group !== 'engine' && value(setting) !== setting.value} resetLabel="Reset" menuLabel={`Actions for ${setting.label}`}
      copyIdLabel="Copy setting ID"
      menuItems={settingMenu(setting).items}
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
        <Show when={group() === 'automaticFixes'}><For each={automaticFixGroups}>{(section) => <ProductSettingsSection title={message(`automaticFixes.group.${section.id}`)}>
          <For each={section.kinds}>{(id) => <AutomaticFixField kind={automaticFixKinds.find((kind) => kind.id === id)!} settings={preferences} changed={changed} inline={false} onCopyId={(id) => { void copyId(id) }} />}</For>
        </ProductSettingsSection>}</For></Show>
        <Show when={group() === 'storage'}>
          <p class="dinkster-settings-note">Mounts and model folders are in the Storage panel. <ProductTextButton label="Open Storage" onClick={() => setToast({ message: 'The Storage panel opens in the application.' })} /></p>
          <ProductSettingsSection title="Run files kept by this engine, all projects">
            <dl class="dinkster-settings-facts">
              <div><dt>Total</dt><dd>{cleared() ? '9.3 GB' : '12.4 GB'}</dd></div>
              <div><dt>Outputs</dt><dd>8.2 GB</dd></div>
              <div><dt>Can be cleared</dt><dd>{cleared() ? '0 B' : '3.1 GB'} <ProductTextButton label="Clear" disabled={cleared()} onClick={() => setConfirmClear(true)} /></dd></div>
            </dl>
          </ProductSettingsSection>
          <ProductSettingsSection title="Studio server - run files">
            <dl class="dinkster-settings-facts">
              <div><dt>Total</dt><dd>6.8 GB</dd></div>
              <div><dt>Outputs</dt><dd>5.2 GB</dd></div>
              <div><dt>Can be cleared</dt><dd>Not known</dd></div>
            </dl>
            <p class="dinkster-settings-note">The engine cannot tell which files are still in use, so nothing can be cleared.</p>
          </ProductSettingsSection>
        </Show>
        <Show when={group() === 'shortcuts'} fallback={<For each={sections()}>{(section) => <ProductSettingsSection title={<><Show when={section === 'Studio server'}><ProductIcon icon={LockKeyhole} /></Show>{section}</>}>
          <Show when={section === 'Studio server'}><p class="dinkster-settings-note">This server does not allow changing these settings from here.</p></Show>
          <For each={settings.filter((setting) => setting.group === group() && setting.section === section && visible(setting))}>{row}</For>
          <Show when={group() === 'general' && section === 'Workspace'}><div class="dinkster-setting-row"><div class="dinkster-setting-copy"><label for="gallery-reset-layout">Panel layout</label></div><div class="dinkster-setting-control"><ProductButton id="gallery-reset-layout" onClick={() => { for (const setting of settings) if (setting.id.startsWith('shell.layout.')) update(setting.id, setting.value) }}>Reset layout</ProductButton></div></div></Show>
          <Show when={section === 'Limit' && limited() && (cleared() ? 9.3 : 12.4) * 1024 ** 3 > Number(values()['storage.limit'] ?? 10737418240)}><p class="dinkster-settings-note">Files in use are kept, so the total can stay above the limit.</p></Show>
        </ProductSettingsSection>}</For>}>
          <For each={settingsCommandGroups(commands)}>{(area) => <ProductSettingsSection title={message(`settingsPage.commands.${area.id}`)}><For each={area.commands}>{(command) => <ProductSettingRow
            id={command.id} label={command.label} modified={combo(command.id) !== keybindings.defaultCombo(command.id)}
            warning={shortcutError(command.id)}
            resetLabel="Reset" menuLabel={`Actions for ${command.label}`} copyIdLabel="Copy command ID"
            menuItems={shortcutMenu(command).items}
            onReset={() => keybindings.reset(command.id)} onCopyId={() => { void copyId(command.id) }}>
            {shortcutControl(command)}
          </ProductSettingRow>}</For></ProductSettingsSection>}</For>
        </Show>
      </ProductSettingsPage>
    </div>
    <Show when={confirmClear()}><ProductDialog title="Clear run files?" onDismiss={() => setConfirmClear(false)}>
      <ProductConfirmation consequence="Removes 3.1 GB of files that no run or project is using. This cannot be undone." actionLabel="Clear" intent="remove"
        onCancel={() => setConfirmClear(false)} onConfirm={() => { setCleared(true); setConfirmClear(false) }} />
    </ProductDialog></Show>
    <ProductToast notification={toast()} onDismiss={() => setToast(undefined)} />
  </ProductPage>
}
