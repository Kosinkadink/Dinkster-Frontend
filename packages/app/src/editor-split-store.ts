/**
 * Persistence for the center-region editor split layout (editor-layout.ts),
 * following the DockLayout pattern: ONE versioned, project-scoped string
 * setting, validated at the read boundary. The stored tree may reference
 * tabs that are no longer open; renderers repair against the live open-tab
 * list (repairEditorLayout) on every read, so nothing here needs to track
 * tab lifecycle.
 *
 * Binding is two-way without feedback loops: `seen` holds the encoded value
 * last observed in settings. Writes update `seen` before settings.set so
 * their own changed tick pulls nothing; a settings-driven edit (another
 * window, a reset) changes the stored value first, so the tick pulls it into
 * the live signal.
 */
import { createSignal, type Signal } from '@dinkster/core'
import {
  decodeEditorLayout,
  encodeEditorLayout,
  singleGroupLayout,
  type EditorLayout,
} from './editor-layout.js'
import type { SettingsRegistry } from './settings.js'

export const EDITOR_SPLIT_LAYOUT_SETTING = 'editor.splitLayout'

export class EditorSplitStore {
  readonly layout: Signal<EditorLayout>

  /** Encoded value last observed in settings - the loop breaker. */
  private seen: string

  /** True while applying a settings-driven fallback that must not persist. */
  private muted = false

  constructor(private readonly settings: SettingsRegistry) {
    settings.register({
      id: EDITOR_SPLIT_LAYOUT_SETTING,
      name: 'Editor split layout',
      category: 'shell',
      type: 'string',
      defaultValue: '',
      projectScoped: true,
    })
    const stored = settings.get<string>(EDITOR_SPLIT_LAYOUT_SETTING)
    this.seen = stored
    this.layout = createSignal(decodeEditorLayout(stored) ?? singleGroupLayout())
    this.layout.subscribe((next) => this.write(next))
    settings.changed.subscribe(() => this.pull())
  }

  private write(next: EditorLayout): void {
    if (this.muted) return
    const encoded = encodeEditorLayout(next)
    if (encoded === this.seen) return
    this.seen = encoded
    this.settings.set(EDITOR_SPLIT_LAYOUT_SETTING, encoded)
  }

  private pull(): void {
    const value = this.settings.get<string>(EDITOR_SPLIT_LAYOUT_SETTING)
    if (value === this.seen) return
    this.seen = value
    const decoded = decodeEditorLayout(value)
    if (decoded !== undefined) {
      this.layout.set(decoded)
      return
    }
    // '' is the registered default, so it means a reset: return to a single
    // group without persisting. Anything else is malformed and ignored - the
    // prior state survives.
    if (value !== '') return
    this.muted = true
    try {
      this.layout.set(singleGroupLayout())
    } finally {
      this.muted = false
    }
  }
}
