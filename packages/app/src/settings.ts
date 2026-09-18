/**
 * Extensible user settings and application command/keybinding registries.
 *
 * These registries deliberately contain no SolidJS types. Extensions and
 * tests can use them without a component owner, while the small `changed`
 * signal gives the shell one honest invalidation boundary. Persistence stores
 * only overrides: changing a default in a later build therefore reaches every
 * user who never made an explicit choice.
 */
import { createSignal, t, type Json, type ReadonlySignal } from '@dinkster/core'

export type SettingType = 'boolean' | 'number' | 'string' | 'combo' | (string & {})
export interface SettingOption { readonly value: string; readonly label: string }
export interface SettingDefinition<T = unknown> {
  readonly id: string
  readonly name: string
  readonly category?: string
  readonly type: SettingType
  readonly defaultValue: T
  readonly description?: string
  readonly options?: readonly SettingOption[]
  readonly min?: number
  readonly max?: number
  readonly step?: number
  /**
   * Overrides live in the active project's envelope instead of the global
   * one, so each project keeps its own value (shell layout is the canonical
   * case). In the default project both envelopes are the same storage key,
   * so legacy overrides keep working unchanged.
   */
  readonly projectScoped?: boolean
}

interface SettingsEnvelope { readonly v: 1; readonly values: Readonly<Record<string, unknown>> }
export const SETTINGS_STORAGE_KEY = 'dinkster.settings'

export class SettingsRegistry {
  private readonly definitions = new Map<string, SettingDefinition>()
  private values: Record<string, unknown> = {}
  /** Project-scoped overrides; aliases `values` when the envelopes share a key. */
  private projectValues: Record<string, unknown>
  private readonly changedSignal = createSignal(0)
  private batchDepth = 0
  private batchDirty = false

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage,
    private readonly projectStorageKey: string = SETTINGS_STORAGE_KEY,
  ) {
    this.values = this.load(SETTINGS_STORAGE_KEY)
    this.projectValues = projectStorageKey === SETTINGS_STORAGE_KEY ? this.values : this.load(projectStorageKey)
  }

  private load(key: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(this.storage?.getItem(key) ?? 'null') as Partial<SettingsEnvelope> | null
      if (parsed?.v === 1 && parsed.values && typeof parsed.values === 'object') return { ...parsed.values }
    } catch {
      // Corrupt or unavailable storage must never prevent the shell starting.
    }
    return {}
  }

  private overridesFor(definition: SettingDefinition): Record<string, unknown> {
    return definition.projectScoped === true ? this.projectValues : this.values
  }

  get changed(): ReadonlySignal<number> { return this.changedSignal }

  /** Reload an envelope changed by another window. */
  refreshFromStorage(key: string | null): void {
    if (key !== null && key !== SETTINGS_STORAGE_KEY && key !== this.projectStorageKey) return
    if (key === null || key === SETTINGS_STORAGE_KEY) {
      this.values = this.load(SETTINGS_STORAGE_KEY)
    }
    if (this.projectStorageKey === SETTINGS_STORAGE_KEY) {
      this.projectValues = this.values
    } else if (key === null || key === this.projectStorageKey) {
      this.projectValues = this.load(this.projectStorageKey)
    }
    this.changedSignal.update((n) => n + 1)
  }

  /** Suppress definition change publication until an extension transaction settles. */
  beginBatch(): (commit: boolean) => void {
    this.batchDepth += 1
    let finished = false
    return (commit) => {
      if (finished) return
      finished = true
      this.batchDepth -= 1
      if (this.batchDepth === 0) {
        const dirty = this.batchDirty
        this.batchDirty = false
        if (commit && dirty) this.changedSignal.update((n) => n + 1)
      }
    }
  }

  register<T>(definition: SettingDefinition<T>): () => void {
    if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(definition.id)) throw new Error(`invalid setting id '${definition.id}'`)
    if (this.definitions.has(definition.id)) throw new Error(`setting '${definition.id}' already registered`)
    this.definitions.set(definition.id, definition)
    this.notifyDefinitionChange()
    return () => {
      if (this.definitions.delete(definition.id)) this.notifyDefinitionChange()
    }
  }

  list(): readonly SettingDefinition[] { return [...this.definitions.values()] }
  categoryOf(definition: SettingDefinition): string {
    return definition.category ?? definition.id.split('.').slice(0, -1).join('.')
  }
  get<T>(id: string): T {
    const definition = this.definitions.get(id)
    if (!definition) throw new Error(`unknown setting '${id}'`)
    const overrides = this.overridesFor(definition)
    const override = overrides[id]
    // Validate at the read boundary so stale or tampered persistence cannot
    // violate consumer types, while reads remain free of storage side effects.
    return (Object.hasOwn(overrides, id) && this.isUsableValue(id, override)
      ? override
      : definition.defaultValue) as T
  }
  isUsableValue(id: string, value: unknown): boolean {
    const definition = this.definitions.get(id)
    if (definition === undefined) return false
    return this.isUsableOverride(definition, value)
  }
  set<T>(id: string, value: T): void {
    const definition = this.definitions.get(id)
    if (!definition) throw new Error(`unknown setting '${id}'`)
    const overrides = this.overridesFor(definition)
    const isDefault = Object.is(value, definition.defaultValue)
    if (isDefault) delete overrides[id]
    else overrides[id] = value
    this.persist(definition.projectScoped === true, id, isDefault ? undefined : value)
    this.changedSignal.update((n) => n + 1)
  }
  reset(id: string): void { this.set(id, this.definitions.get(id)?.defaultValue) }

  private notifyDefinitionChange(): void {
    if (this.batchDepth > 0) this.batchDirty = true
    else this.changedSignal.update((n) => n + 1)
  }

  private isUsableOverride(definition: SettingDefinition, value: unknown): boolean {
    switch (definition.type) {
      case 'boolean': return typeof value === 'boolean'
      case 'number':
        return typeof value === 'number'
          && Number.isFinite(value)
          && (definition.min === undefined || value >= definition.min)
          && (definition.max === undefined || value <= definition.max)
      case 'string': return typeof value === 'string'
      case 'combo': return typeof value === 'string'
        && (definition.options === undefined || definition.options.some((option) => option.value === value))
      default: return true
    }
  }

  /**
   * Patch only the changed setting into the freshly read stored envelope:
   * another window sharing this envelope may have persisted newer values for
   * other settings, and rewriting the whole envelope from this window's
   * in-memory copy would silently discard them.
   */
  private persist(projectScoped: boolean, id: string, value: unknown): void {
    try {
      const key = projectScoped && this.projectStorageKey !== SETTINGS_STORAGE_KEY
        ? this.projectStorageKey
        : SETTINGS_STORAGE_KEY
      const stored = this.load(key)
      if (value === undefined) delete stored[id]
      else stored[id] = value
      this.storage?.setItem(key, JSON.stringify({ v: 1, values: stored }))
    } catch {
      // Full/private storage leaves the in-memory setting usable.
    }
  }
}

export interface AppCommand {
  readonly id: string
  readonly label: string
  readonly run: (payload?: Json) => void
  /** Invocation-time availability shared by every command surface. */
  readonly enabled?: () => boolean
}
export interface KeybindingDefinition { readonly command: string; readonly combo: string; readonly allowInInput?: boolean }

export class CommandRegistry {
  private readonly commands = new Map<string, AppCommand>()
  register(command: AppCommand): () => void {
    if (this.commands.has(command.id)) throw new Error(`command '${command.id}' already registered`)
    this.commands.set(command.id, command)
    return () => void this.commands.delete(command.id)
  }
  get(id: string): AppCommand | undefined { return this.commands.get(id) }
  list(): readonly AppCommand[] { return [...this.commands.values()] }
}

/** Canonical, platform-neutral spelling used by defaults, overrides, and events. */
export function normalizeCombo(combo: string): string {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean)
  const key = parts.pop()?.toLowerCase() ?? ''
  const modifiers = new Set(parts.map((p) => p.toLowerCase() === 'cmd' ? 'meta' : p.toLowerCase()))
  return [...(['ctrl', 'meta', 'alt', 'shift'] as const).filter((m) => modifiers.has(m)), key].join('+')
}

export function comboFromEvent(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string {
  let key = event.key.toLowerCase()
  if (key === ' ') key = 'space'
  const modifiers = [event.ctrlKey && 'ctrl', event.metaKey && 'meta', event.altKey && 'alt', event.shiftKey && 'shift'].filter(Boolean)
  return [...modifiers, key].join('+')
}

export type KeyCaptureResult =
  | { readonly kind: 'pending'; readonly combo: string }
  | { readonly kind: 'complete'; readonly combo: string }
  | { readonly kind: 'cancel' }

export function captureKeydown(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): KeyCaptureResult {
  // Escape is reserved for leaving capture so a mistaken click never traps keyboard users.
  if (event.key === 'Escape') return { kind: 'cancel' }
  const modifier = ['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)
  // Some browsers do not mark a modifier held until after its own keydown, so include the key being pressed in the pending display.
  const combo = comboFromEvent({
    ...event,
    key: modifier ? '' : event.key,
    ctrlKey: event.ctrlKey || event.key === 'Control',
    shiftKey: event.shiftKey || event.key === 'Shift',
    altKey: event.altKey || event.key === 'Alt',
    metaKey: event.metaKey || event.key === 'Meta',
  }).replace(/\+$/, '')
  return modifier ? { kind: 'pending', combo } : { kind: 'complete', combo }
}

export function isTextTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false
  const element = target as { readonly tagName?: string; readonly isContentEditable?: boolean }
  return (element.tagName !== undefined && ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) || element.isContentEditable === true
}

/**
 * Every focus-owning overlay root: ARIA dialogs and menus, the palette, the
 * context menu (tabindex, no menu role), the badge/value-source popovers,
 * the widget-editor cards (incl. the seed-controller menu), the minimap
 * settings menu, and native text scopes such as Problems. Shared by the
 * shell command dispatcher and the canvas's own shortcut keys so both
 * suppress identically.
 */
const NATIVE_TEXT_SCOPE = '[data-native-text-scope]'
const OVERLAY_ROOTS =
  `[role="dialog"], [role="menu"], .palette-layer, .node-palette, .context-menu, .badge-popover, .floating-surface, .minimap-menu, ${NATIVE_TEXT_SCOPE}`

export function isNativeTextScopeTarget(target: EventTarget | null): boolean {
  return (target as Element | null)?.closest?.(NATIVE_TEXT_SCOPE) != null
}

/** A focusless browser selection inside native shell text still owns Copy. */
function hasNativeTextScopeSelection(): boolean {
  const selection = document.getSelection?.()
  if (selection == null || selection.isCollapsed || selection.rangeCount === 0 || selection.toString() === '') return false
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index)
    const start = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer as Element
      : range.startContainer.parentElement
    const scope = start?.closest(NATIVE_TEXT_SCOPE)
    if (scope !== null && scope !== undefined && scope.contains(range.endContainer)) return true
  }
  return false
}

/**
 * True when a keydown must NOT trigger app shortcuts: typing in a field,
 * a modal dialog is open (its keyboard owns the body too), or the event
 * target is inside a popover/menu or native text surface.
 */
export function shortcutSuppressed(event: KeyboardEvent): boolean {
  if (isTextTarget(event.target)) return true
  if (document.querySelector('[aria-modal="true"]') !== null) return true
  if (hasNativeTextScopeSelection()) return true
  if (isNativeTextScopeTarget(event.target)) return true
  const target = event.target as Element | null
  return target?.closest?.(OVERLAY_ROOTS) != null
}

export class KeybindingRegistry {
  private readonly defaults = new Map<string, KeybindingDefinition>()
  private overridesRaw: string | undefined
  private overridesCache = new Map<string, string | null>()
  constructor(private readonly settings: SettingsRegistry) {
    settings.register({ id: 'keybindings.overrides', get name() { return t('settings.keybindings.overrides') }, category: 'keybindings', type: 'string', defaultValue: '{}' })
  }
  private overrides(): Map<string, string | null> {
    const raw = this.settings.get<string>('keybindings.overrides')
    if (raw === this.overridesRaw) return this.overridesCache
    this.overridesRaw = raw
    this.overridesCache = new Map()
    try {
      const values = JSON.parse(raw) as Record<string, string | null>
      for (const [id, combo] of Object.entries(values)) this.overridesCache.set(id, combo)
    } catch { /* malformed legacy override is equivalent to no overrides */ }
    return this.overridesCache
  }
  register(binding: KeybindingDefinition): () => void {
    if (this.defaults.has(binding.command)) throw new Error(`binding for '${binding.command}' already registered`)
    this.defaults.set(binding.command, { ...binding, combo: normalizeCombo(binding.combo) })
    return () => void this.defaults.delete(binding.command)
  }
  combo(command: string): string | undefined {
    const override = this.overrides().get(command)
    return override === null ? undefined : override ?? this.defaults.get(command)?.combo
  }
  defaultCombo(command: string): string | undefined { return this.defaults.get(command)?.combo }
  set(command: string, combo: string | null): void {
    this.overrides().set(command, combo === null ? null : normalizeCombo(combo))
    this.save()
  }
  reset(command: string): void { this.overrides().delete(command); this.save() }
  conflicts(): ReadonlyMap<string, readonly string[]> {
    const byCombo = new Map<string, string[]>()
    for (const command of this.defaults.keys()) {
      const combo = this.combo(command)
      if (combo) byCombo.set(combo, [...(byCombo.get(combo) ?? []), command])
    }
    return new Map([...byCombo].filter(([, ids]) => ids.length > 1))
  }
  match(event: KeyboardEvent): string | undefined {
    const combo = comboFromEvent(event)
    for (const [command, definition] of this.defaults) {
      if (this.combo(command) === combo && (!isTextTarget(event.target) || definition.allowInInput)) return command
    }
    return undefined
  }
  private save(): void {
    const raw = JSON.stringify(Object.fromEntries(this.overrides()))
    this.overridesRaw = raw
    this.settings.set('keybindings.overrides', raw)
  }
}

export function initialSettingsCategory(
  definitions: readonly SettingDefinition[],
  categoryOf: (definition: SettingDefinition) => string,
): string {
  return definitions.length > 0 ? categoryOf(definitions[0]!) : 'keybindings'
}
