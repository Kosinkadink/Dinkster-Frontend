import { For, Show, createEffect, createSignal, createUniqueId, type JSX } from 'solid-js'
import { Check, ChevronDown } from 'lucide-solid'
import { CanvasEditorButtons, CanvasEditorChoiceList } from './canvas-editor.js'
import {
  CanvasSideLink,
  CanvasSidePart,
  canvasSideLayout,
  type CanvasBox,
  type CanvasPanelPlace,
  type CanvasSideLayout,
  type CanvasSideSize,
} from './canvas-field.js'

/**
 * Where an open save target's box and side part go. The box hangs under
 * the row, or over it when only there is room, at the row's normal size;
 * the row and box are one column and the side part sits beside it, or
 * under or over it, as `canvasSideLayout` places it. `row` and `bounds`
 * are screen boxes; `box` and `side` are at normal size.
 */
export function canvasTargetLayout(
  row: CanvasBox,
  bounds: CanvasBox,
  box: number,
  side: CanvasSideSize,
  scale: number,
  edges?: { readonly left: boolean; readonly right: boolean },
): CanvasSideLayout & { readonly panelPlace: CanvasPanelPlace } {
  const height = box * Math.max(1, scale)
  const below = bounds.y + bounds.height - (row.y + row.height)
  const above = row.y - bounds.y
  const panelPlace: CanvasPanelPlace =
    below >= height || below >= above ? 'below' : 'above'
  const column = {
    x: row.x,
    y: panelPlace === 'below' ? row.y : row.y - height,
    width: row.width,
    height: row.height + height,
  }
  return {
    panelPlace,
    ...canvasSideLayout(column, bounds, side, scale, Infinity, Infinity, edges),
  }
}

/** One mount in a save target's mount list. */
export interface CanvasTargetMount {
  /** The mount's id, or '' for Project default. */
  readonly id: string
  readonly label: string
  /** What the closed dropdown shows when this entry is picked, when it is shorter than the label. */
  readonly closedLabel?: string
  /** A stored mount that is no longer ready: listed dimmed, never picked. */
  readonly unavailable?: boolean
}

/**
 * Where a save target's mounts stand: still being read, read with none
 * ready, not readable, or read. The box says it in a few words; the side
 * part holds any sentence.
 */
export type CanvasTargetMounts = 'loading' | 'none' | 'failed' | 'ready'

/** The words a save target box shows, from the caller's catalog. */
export interface CanvasTargetWords {
  readonly mount: string
  readonly prefix: string
  readonly loading: string
  readonly none: string
  /** The dropdown's value when the mounts could not be read. */
  readonly failed: string
}

/** The part of a save target box the keyboard is on. */
export type CanvasTargetStop = 'mount' | 'prefix'

/**
 * The box under an open save target row: the "Writable mount" dropdown,
 * whose list lies over the box, and the relative filename prefix. Nothing
 * here stores; the caller does when the box is left.
 */
export function CanvasTargetBox(props: {
  /** Uses the shared editor space's padding and row heights. */
  inNode?: boolean
  mountWired?: boolean
  prefixWired?: boolean
  mountReadOnly?: boolean
  prefixReadOnly?: boolean
  mountDisabled?: boolean
  prefixDisabled?: boolean
  mountText?: string | undefined
  words: CanvasTargetWords
  mounts: CanvasTargetMounts
  options: readonly CanvasTargetMount[]
  /** The picked mount's id. */
  mount: string
  /** The dropdown's outline and value take the color of the side part's sentence about the mount. */
  tone?: 'warning' | 'error'
  listOpen: boolean
  /** Index of the list's candidate in `options`. */
  highlight?: number
  onToggleList?: () => void
  onHighlight?: (index: number) => void
  onPick?: (index: number) => void
  prefix: string
  onPrefix?: (text: string) => void
  /** Naming help shown on the Name row. */
  help?: string | undefined
  /** Why the prefix cannot be used, under the field. */
  prefixProblem?: string
  mountProblem?: JSX.Element
  reset?: { readonly label: string; readonly onClick: () => void }
  /** The part the keyboard is on, drawn focused even without the browser's focus. */
  focused?: CanvasTargetStop
  onFocusStop?: (stop: CanvasTargetStop) => void
  mountRef?: (element: HTMLButtonElement) => void
  prefixRef?: (element: HTMLInputElement) => void
  /** A store is in flight: nothing can be changed. */
  frozen?: boolean
}) {
  const prefixId = createUniqueId()
  const problemId = createUniqueId()
  const legacyListboxId = createUniqueId()
  const optionId = (index: number) => `${legacyListboxId}-${index}`
  const [listboxId, setListboxId] = createSignal(legacyListboxId)
  const [query, setQuery] = createSignal('')
  const shown = () => props.options.map((option, index) => ({ option, index }))
    .filter(({ option }) => option.label.toLowerCase().includes(query().toLowerCase()))
  const picked = () => props.options.find((option) => option.id === props.mount)
  const ready = () => props.mounts === 'ready'
  const mountBlocked = () => props.frozen === true || props.mountWired === true || props.mountReadOnly === true || props.mountDisabled === true
  const prefixBlocked = () => props.frozen === true || props.prefixWired === true || props.prefixReadOnly === true || props.prefixDisabled === true
  let mountButton: HTMLButtonElement | undefined
  createEffect(() => { if (props.listOpen) setQuery('') })
  createEffect(() => {
    if (!mountButton || props.inNode) return
    const index = props.highlight
    if (props.listOpen && index !== undefined && props.options[index] !== undefined)
      mountButton.setAttribute('aria-activedescendant', optionId(index))
    else mountButton.removeAttribute('aria-activedescendant')
  })
  const value = (): JSX.Element => {
    if (props.mountText !== undefined) return <span class="dinkster-canvas-target-value-text">{props.mountText}</span>
    switch (props.mounts) {
      case 'loading':
        return (
          <>
            <span class="dinkster-spinner dinkster-canvas-target-spinner" aria-hidden="true" />
            <span class="dinkster-canvas-target-value-text">{props.words.loading}</span>
          </>
        )
      case 'none':
        return <span class="dinkster-canvas-target-value-text">{props.words.none}</span>
      case 'failed':
        return <span class="dinkster-canvas-target-value-text">{props.words.failed}</span>
      case 'ready':
        return (
          <>
            <span class="dinkster-canvas-target-value-text">{picked()?.closedLabel ?? picked()?.label ?? props.mount}</span>
            <ChevronDown class="dinkster-canvas-target-glyph" aria-hidden="true" />
          </>
        )
    }
  }
  return (
    <div class="dinkster-canvas-target-box" data-in-node={props.inNode === true} data-frozen={props.frozen === true}>
      <div class="dinkster-canvas-target-mount" data-wired={props.mountWired === true} data-disabled={props.mountDisabled === true} inert={props.mountWired === true || props.mountDisabled === true}>
        <button
          ref={(element) => {
            mountButton = element
            props.mountRef?.(element)
          }}
          type="button"
          class="dinkster-canvas-target-choice"
          data-state={props.mounts}
          data-tone={props.tone}
          data-focused={props.focused === 'mount'}
          aria-haspopup="listbox"
          aria-expanded={props.listOpen}
          aria-controls={props.listOpen ? listboxId() : undefined}
          aria-disabled={!ready() || mountBlocked()}
          tabindex={props.inNode && !mountBlocked() ? 0 : -1}
          onFocus={() => props.onFocusStop?.('mount')}
          onClick={() => {
            if (ready() && !mountBlocked()) { setQuery(''); props.onToggleList?.() }
          }}
        >
          <span class="dinkster-canvas-target-label">{props.words.mount}</span>
          <span class="dinkster-canvas-target-value">{value()}</span>
        </button>
        <Show when={props.listOpen && ready() && !mountBlocked()}>
          <Show when={props.inNode} fallback={
            <div id={legacyListboxId} class="dinkster-canvas-target-list" role="listbox" aria-label={props.words.mount}>
              <For each={props.options}>{(option, index) =>
                <div id={optionId(index())} class="dinkster-canvas-target-option" role="option"
                  aria-selected={option.id === props.mount} aria-disabled={option.unavailable === true}
                  data-active={props.highlight === index()} data-unavailable={option.unavailable === true}
                  onPointerDown={(event) => event.preventDefault()}
                  onPointerMove={() => { if (props.highlight !== index()) props.onHighlight?.(index()) }}
                  onClick={() => { if (option.unavailable !== true && props.frozen !== true) props.onPick?.(index()) }}>
                  <span class="dinkster-canvas-target-option-label">{option.label}</span>
                  <Show when={option.id === props.mount}><Check class="dinkster-canvas-target-check" aria-hidden="true" /></Show>
                </div>
              }</For>
            </div>
          }>
          <CanvasEditorChoiceList anchor={mountButton!} onClose={() => { if (props.listOpen) props.onToggleList?.() }}
            look="flat-title" label={props.words.mount} inputLabel={props.words.mount}
            query={query()} onQuery={(text) => { setQuery(text); const first = shown()[0]; if (first) props.onHighlight?.(first.index) }}
            placeholder={picked()?.label ?? props.mount}
            inputRef={(element) => queueMicrotask(() => element.focus())}
            ref={(element) => { const id = element.querySelector('[role="listbox"]')?.id; if (id) setListboxId(id) }}
            options={shown().map(({ option }) => ({ key: option.id, label: option.label, saved: option.id === props.mount, disabled: option.unavailable === true }))}
            highlight={shown().findIndex(({ index }) => index === props.highlight)}
            onHighlight={(index) => { const entry = shown()[index]; if (entry) props.onHighlight?.(entry.index) }}
            onPick={(index) => {
              const entry = shown()[index]
              if (entry && !entry.option.unavailable && !props.frozen) props.onPick?.(entry.index)
            }}
            frozen={props.frozen === true}
            onKeyDown={(event) => {
              if (event.isComposing) return
              if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
                event.preventDefault(); event.stopPropagation()
                const entry = shown().find(({ index }) => index === props.highlight)
                if (entry && !entry.option.unavailable && !props.frozen) { mountButton?.focus(); props.onPick?.(entry.index) }
              } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault(); event.stopPropagation()
                const entries = shown()
                const current = entries.findIndex(({ index }) => index === props.highlight)
                const entry = entries[(current + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length]
                if (entry) props.onHighlight?.(entry.index)
              }
            }} />
          </Show>
        </Show>
      </div>
      <Show when={props.mountProblem}>
        {props.mountProblem}
      </Show>
      <div class="dinkster-canvas-target-name" data-wired={props.prefixWired === true} data-disabled={props.prefixDisabled === true} inert={props.prefixWired === true || props.prefixDisabled === true} title={props.help}>
        <label class="dinkster-canvas-target-caption" for={prefixId}>
          {props.words.prefix}
        </label>
        <input
          ref={props.prefixRef}
          id={prefixId}
          class="dinkster-canvas-target-input"
          type="text"
          value={props.prefix}
          data-focused={props.focused === 'prefix'}
          aria-invalid={props.prefixProblem !== undefined}
          aria-errormessage={props.prefixProblem === undefined ? undefined : problemId}
          readOnly={prefixBlocked()}
          autocomplete="off"
          spellcheck={false}
          tabindex={props.inNode && !prefixBlocked() ? 0 : -1}
          onFocus={() => props.onFocusStop?.('prefix')}
          onInput={(event) => { if (!prefixBlocked()) props.onPrefix?.(event.currentTarget.value) }}
        />
      </div>
      <Show when={props.prefixProblem}>
        <p id={problemId} class="dinkster-canvas-target-note">
          {props.prefixProblem}
        </p>
      </Show>
      <Show when={props.reset}>{(reset) =>
        <div class="dinkster-canvas-target-reset">
          <CanvasEditorButtons buttons={[{ label: reset().label, disabled: props.frozen === true, onClick: () => reset().onClick() }]} />
        </div>
      }</Show>
    </div>
  )
}

/**
 * An open save target's side part: an error first, such as why the mounts
 * could not be read, then a problem, such as a stored mount that is not on
 * this machine, then what leaving the box does ("Enter keeps" or "Enter
 * stores" and the target), an action such as "Use project default", and
 * the default, a link when `onDefault` puts it back; under the divider the
 * input's own tooltip, when it declares one, and the naming help.
 */
export function CanvasTargetSide(props: {
  error?: string
  problem?: string
  enter: { readonly verb: string; readonly target: string }
  action?: { readonly label: string; readonly onClick: () => void }
  defaultLabel: string
  defaultText: string
  onDefault?: () => void
  tooltip?: string
  naming: string
}) {
  return (
    <>
      <CanvasSidePart
        {...(props.problem === undefined ? {} : { problem: props.problem })}
        facts={[{
          key: props.defaultLabel,
          value: props.onDefault === undefined
            ? props.defaultText
            : <CanvasSideLink onClick={() => props.onDefault?.()}>{props.defaultText}</CanvasSideLink>,
        }]}
      >
        <Show when={props.error}>
          <p class="dinkster-canvas-target-error" role="alert">
            {props.error}
          </p>
        </Show>
        <p class="dinkster-canvas-target-enter">
          {props.enter.verb} <span class="dinkster-canvas-target-enter-value">{props.enter.target}</span>
        </p>
        <Show when={props.action}>
          {(action) => (
            <p class="dinkster-canvas-target-enter">
              <CanvasSideLink onClick={() => action().onClick()}>{action().label}</CanvasSideLink>
            </p>
          )}
        </Show>
      </CanvasSidePart>
      <div class="dinkster-canvas-side-help">
        <Show when={props.tooltip}>
          <p class="dinkster-canvas-target-help">{props.tooltip}</p>
        </Show>
        <p class="dinkster-canvas-target-help">{props.naming}</p>
      </div>
    </>
  )
}
