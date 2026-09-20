/**
 * The editor registry makes the center region a set of projections over
 * shared document state. Editors mutate only by dispatching maintained
 * commands. A tab is conceptually
 * (document, editorKind); graph, app view, and image editors use the same
 * descriptor registry rather than shell JSX branches.
 *
 * Editors are NOT panels: panels (panels.ts) are shell chrome AROUND the
 * center region (docks/rails/bottom); editors own the center. The two
 * vocabularies stay separate on purpose.
 *
 * Extension packs register through the same public API as core, clearly
 * delineated by their descriptor - same discipline as PanelRegistry,
 * CommandRegistry, and the widget registry.
 */

import type { JSX } from 'solid-js'
import { createSignal, type EditorBinding, type Signal } from '@dinkster/core'

/** The built-in node-graph editor kind. */
export const GRAPH_EDITOR_KIND = 'graph'

/**
 * The built-in form-style app view renders the
 * document's exposed parameters as public controls over the same substrate
 * as the graph editor.
 */
export const APP_EDITOR_KIND = 'app'

/** Built-in image editor. Mask editing is one capability within it. */
export const IMAGE_EDITOR_KIND = 'image'

/** Built-in editor for one dinkster.curve input. */
export const CURVE_EDITOR_KIND = 'curve'

/** Built-in editor for one first-party GLSL Shader source input. */
export const GLSL_EDITOR_KIND = 'glsl'

/**
 * Binding an editor instance receives from its hosting split group. Without
 * one (pop-out windows, tests) an editor binds to the app's global active
 * tab and considers itself focused.
 */
export interface EditorHostContext {
  /** The tab this instance renders: its group's active tab. Reactive. */
  readonly tabId: () => string
  /**
   * True while this instance's group is the focused group. Window-level
   * keyboard shortcuts and singleton publications (canvasBridge) must gate
   * on this so simultaneously visible editors never double-handle.
   */
  readonly focused: () => boolean
}

export interface EditorKindDescriptor {
  /** Stable kind id, e.g. 'graph'. Tabs reference editors by this id. */
  readonly id: string
  readonly title: string
  /**
   * Renders the editor for one center-region group. Mounted once per kind
   * per group and kept alive across same-kind tab switches (the component
   * binds to the group's active tab through `host`, like CanvasHost), so
   * per-tab view state such as the canvas viewport survives switching.
   */
  readonly component: (host?: EditorHostContext) => JSX.Element
}

export interface EditorBindingContext {
  readonly editorRole?: string
  readonly nodeId?: string
  readonly widgetType?: string
  readonly valueType?: string
}

export class EditorBindingRegistry {
  private readonly bindings = new Map<string, EditorBinding>()
  readonly changed: Signal<number> = createSignal(0)

  register(binding: EditorBinding): () => void {
    if (this.bindings.has(binding.id)) throw new Error(`editor binding already registered: ${binding.id}`)
    this.bindings.set(binding.id, Object.freeze({ ...binding, match: Object.freeze({ ...binding.match }) }))
    this.changed.update((value) => value + 1)
    return () => {
      this.bindings.delete(binding.id)
      this.changed.update((value) => value + 1)
    }
  }

  resolve(context: EditorBindingContext): EditorBinding | undefined {
    return [...this.bindings.values()]
      .filter((binding) => Object.entries(binding.match).every(([key, value]) =>
        value === undefined || context[key as keyof EditorBindingContext] === value))
      .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id))[0]
  }

  all(): readonly EditorBinding[] {
    return [...this.bindings.values()]
      .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id))
  }
}

export class EditorRegistry {
  private readonly editors = new Map<string, EditorKindDescriptor>()
  /** Bumped on every register/unregister. */
  readonly changed: Signal<number> = createSignal(0)

  /** Register an editor kind; returns the unregister function. Duplicate ids refuse loudly. */
  register(desc: EditorKindDescriptor): () => void {
    if (this.editors.has(desc.id)) throw new Error(`editor kind already registered: ${desc.id}`)
    this.editors.set(desc.id, desc)
    this.changed.update((v) => v + 1)
    return () => {
      this.editors.delete(desc.id)
      this.changed.update((v) => v + 1)
    }
  }

  get(id: string): EditorKindDescriptor | undefined {
    return this.editors.get(id)
  }

  kinds(): readonly EditorKindDescriptor[] {
    return [...this.editors.values()]
  }
}
