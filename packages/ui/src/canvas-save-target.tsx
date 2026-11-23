import { For, Show, createEffect, createUniqueId, type JSX } from 'solid-js'
import { Check, ChevronDown, Trash2 } from 'lucide-solid'
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
    ...canvasSideLayout(column, bounds, side, scale, Infinity, Infinity),
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
  readonly clear: string
}

/** The part of a save target box the keyboard is on. */
export type CanvasTargetStop = 'mount' | 'prefix' | 'clear'

/**
 * The box under an open save target row: the "Writable mount" dropdown,
 * whose list lies over the box, the relative filename prefix, and, on a
 * target that may be empty, Clear destination on the footer line. Nothing
 * here stores; the caller does when the box is left.
 */
export function CanvasTargetBox(props: {
  words: CanvasTargetWords
  mounts: CanvasTargetMounts
  options: readonly CanvasTargetMount[]
  /** The picked mount's id. */
  mount: string
  listOpen: boolean
  /** Index of the list's candidate in `options`. */
  highlight?: number
  onToggleList?: () => void
  onHighlight?: (index: number) => void
  onPick?: (index: number) => void
  prefix: string
  onPrefix?: (text: string) => void
  /** Why the prefix cannot be used, under the field. */
  prefixProblem?: string
  /** Shows Clear destination on the footer line. */
  onClear?: () => void
  /** The part the keyboard is on, drawn focused even without the browser's focus. */
  focused?: CanvasTargetStop
  onFocusStop?: (stop: CanvasTargetStop) => void
  mountRef?: (element: HTMLButtonElement) => void
  prefixRef?: (element: HTMLInputElement) => void
  clearRef?: (element: HTMLButtonElement) => void
  /** A store is in flight: nothing can be changed. */
  frozen?: boolean
}) {
  const listboxId = createUniqueId()
  const prefixId = createUniqueId()
  const problemId = createUniqueId()
  const optionId = (index: number) => `${listboxId}-${index}`
  const picked = () => props.options.find((option) => option.id === props.mount)
  const ready = () => props.mounts === 'ready'
  let mountButton: HTMLButtonElement | undefined
  createEffect(() => {
    if (!mountButton) return
    const index = props.highlight
    if (props.listOpen && index !== undefined && props.options[index] !== undefined)
      mountButton.setAttribute('aria-activedescendant', optionId(index))
    else mountButton.removeAttribute('aria-activedescendant')
  })
  const value = (): JSX.Element => {
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
    <div class="dinkster-canvas-target-box" data-frozen={props.frozen === true}>
      <div class="dinkster-canvas-target-mount">
        <button
          ref={(element) => {
            mountButton = element
            props.mountRef?.(element)
          }}
          type="button"
          class="dinkster-canvas-target-choice"
          data-state={props.mounts}
          data-unavailable={ready() && picked()?.unavailable === true}
          data-focused={props.focused === 'mount'}
          aria-haspopup="listbox"
          aria-expanded={props.listOpen}
          aria-controls={props.listOpen ? listboxId : undefined}
          aria-disabled={!ready() || props.frozen === true}
          tabindex="-1"
          onFocus={() => props.onFocusStop?.('mount')}
          onClick={() => {
            if (ready() && props.frozen !== true) props.onToggleList?.()
          }}
        >
          <span class="dinkster-canvas-target-label">{props.words.mount}</span>
          <span class="dinkster-canvas-target-value">{value()}</span>
        </button>
        <Show when={props.listOpen && ready()}>
          <div
            id={listboxId}
            class="dinkster-canvas-target-list"
            role="listbox"
            aria-label={props.words.mount}
          >
            <For each={props.options}>
              {(option, index) => (
                <div
                  id={optionId(index())}
                  class="dinkster-canvas-target-option"
                  role="option"
                  aria-selected={option.id === props.mount}
                  aria-disabled={option.unavailable === true}
                  data-active={props.highlight === index()}
                  data-unavailable={option.unavailable === true}
                  onPointerDown={(event) => event.preventDefault()}
                  onPointerMove={() => {
                    if (props.highlight !== index()) props.onHighlight?.(index())
                  }}
                  onClick={() => {
                    if (option.unavailable !== true && props.frozen !== true) props.onPick?.(index())
                  }}
                >
                  <span class="dinkster-canvas-target-option-label">{option.label}</span>
                  <Show when={option.id === props.mount}>
                    <Check class="dinkster-canvas-target-check" aria-hidden="true" />
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
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
        readOnly={props.frozen === true}
        autocomplete="off"
        spellcheck={false}
        tabindex="-1"
        onFocus={() => props.onFocusStop?.('prefix')}
        onInput={(event) => props.onPrefix?.(event.currentTarget.value)}
      />
      <Show when={props.prefixProblem}>
        <p id={problemId} class="dinkster-canvas-target-note">
          {props.prefixProblem}
        </p>
      </Show>
      <Show when={props.onClear}>
        {(clear) => (
          <div class="dinkster-canvas-target-foot">
            <button
              ref={props.clearRef}
              type="button"
              class="dinkster-canvas-target-action"
              data-focused={props.focused === 'clear'}
              disabled={props.frozen === true}
              tabindex="-1"
              onFocus={() => props.onFocusStop?.('clear')}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => clear()()}
            >
              <Trash2 class="dinkster-canvas-target-glyph" aria-hidden="true" />
              {props.words.clear}
            </button>
          </div>
        )}
      </Show>
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
