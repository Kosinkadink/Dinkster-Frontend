import { For, Show, type JSX } from 'solid-js'
import {
  Camera,
  ChevronRight,
  Circle,
  Play,
  RotateCcw,
  Square,
  Trash2,
  type LucideIcon,
} from 'lucide-solid'
import { ProductButton, ProductIcon, ProductIconButton, ProductSpinner } from './controls.js'

/**
 * The controls of an editor shown in the node, laid over the space the
 * canvas leaves for it under its editor button row. Everything here is drawn
 * at the canvas's normal size; the host places it on the space and scales it
 * with the canvas. The text comes from the caller.
 */
export function CanvasEditorSpace(props: {
  ref?: (element: HTMLDivElement) => void
  /** The editor's state, for the look of what it holds (for example dimmed rows). */
  state?: string
  children: JSX.Element
}) {
  return (
    <div class="dinkster-canvas-editor" data-state={props.state} ref={(element) => props.ref?.(element)}>
      {props.children}
    </div>
  )
}

/**
 * The picture area of an editor. Its content is the caller's (a still, a live
 * view, a drawing); `message` covers it in a few words when there is nothing
 * to show, with a spinner while something loads. The bar on its bottom edge
 * is dragged to change its height.
 */
export function CanvasEditorPicture(props: {
  ref?: (element: HTMLDivElement) => void
  message?: string
  loading?: boolean
  /** Controls drawn on the picture, at its top right. */
  actions?: JSX.Element
  onResizeStart?: (event: PointerEvent) => void
  resizeLabel?: string
  children?: JSX.Element
}) {
  return (
    <div class="dinkster-canvas-editor-picture" ref={(element) => props.ref?.(element)}>
      {props.children}
      <Show when={props.message !== undefined || props.loading}>
        <div class="dinkster-canvas-editor-picture-message" role="status">
          <Show when={props.loading}>
            <ProductSpinner />
          </Show>
          <span>{props.message}</span>
        </div>
      </Show>
      <Show when={props.actions}>
        <div class="dinkster-canvas-editor-picture-actions">{props.actions}</div>
      </Show>
      <div
        class="dinkster-canvas-editor-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label={props.resizeLabel}
        onPointerDown={(event) => props.onResizeStart?.(event)}
      />
    </div>
  )
}

/** One line of an editor's own controls, as tall as a canvas row. */
export function CanvasEditorLine(props: { dimmed?: boolean; children: JSX.Element }) {
  return (
    <div class="dinkster-canvas-editor-line" data-dimmed={props.dimmed === true ? 'true' : undefined}>
      {props.children}
    </div>
  )
}

/** A line naming what the editor stores, or a message about it; `tone` colors a problem. */
export function CanvasEditorNote(props: { tone?: 'problem' | 'muted' | undefined; wrap?: boolean; children: JSX.Element }) {
  return (
    <div class="dinkster-canvas-editor-note" data-tone={props.tone} data-wrap={props.wrap === true ? 'true' : undefined}>
      {props.children}
    </div>
  )
}

/** A closed or open section of an editor's own rows, drawn like a closed box of the node. */
export function CanvasEditorSection(props: {
  label: string
  open: boolean
  onToggle?: (open: boolean) => void
  children?: JSX.Element
}) {
  return (
    <details
      class="dinkster-canvas-editor-section"
      open={props.open}
      onToggle={(event) => {
        const open = event.currentTarget.open
        if (open !== props.open) props.onToggle?.(open)
      }}
    >
      <summary>
        <ProductIcon icon={ChevronRight} />
        {props.label}
      </summary>
      <div class="dinkster-canvas-editor-section-rows">{props.children}</div>
    </details>
  )
}

/** The action icons the brief names, so every editor uses the same ones. */
export const canvasEditorIcons = {
  record: Circle,
  stop: Square,
  play: Play,
  remove: Trash2,
  capture: Camera,
  retry: RotateCcw,
} as const satisfies Record<string, LucideIcon>

/**
 * The recorder's strip: the round button (Record, or Stop while recording),
 * the status over the time, the waveform and the action icons at the right.
 */
export function CanvasRecorderStrip(props: {
  recording: boolean
  /** The round button's label: Record or Stop. */
  roundLabel: string
  roundDisabled?: boolean
  onRound?: () => void
  status: string
  /** The time and rounded size, such as "0:07, 47 KB". */
  detail?: string
  /** Samples from -1 to 1; empty draws a flat line. */
  waveform: readonly number[]
  actions?: readonly { label: string; icon: LucideIcon; intent?: 'remove'; disabled?: boolean; onClick?: () => void }[]
}) {
  const points = () => {
    const samples = props.waveform.length > 1 ? props.waveform : [0, 0]
    return samples.map((value, index) => `${(index / (samples.length - 1)) * 100},${50 - Math.max(-1, Math.min(1, value)) * 45}`).join(' ')
  }
  return (
    <div class="dinkster-canvas-recorder" data-recording={props.recording ? 'true' : 'false'}>
      <ProductIconButton
        label={props.roundLabel}
        icon={props.recording ? canvasEditorIcons.stop : canvasEditorIcons.record}
        intent={props.recording ? 'remove' : 'add'}
        disabled={props.roundDisabled === true}
        onClick={() => props.onRound?.()}
      />
      <div class="dinkster-canvas-recorder-status">
        <span>{props.status}</span>
        <Show when={props.detail}>
          <span class="dinkster-canvas-recorder-detail">{props.detail}</span>
        </Show>
      </div>
      <svg class="dinkster-canvas-recorder-wave" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polyline points={points()} />
      </svg>
      <For each={props.actions ?? []}>
        {(action) => (
          <ProductIconButton
            label={action.label}
            icon={action.icon}
            {...(action.intent === 'remove' ? { intent: 'remove' as const } : {})}
            disabled={action.disabled === true}
            onClick={() => action.onClick?.()}
          />
        )}
      </For>
    </div>
  )
}

/** A row of an editor's buttons, each with its icon and label; `iconOnly` names the button only for assistive technology. */
export function CanvasEditorButtons(props: {
  buttons: readonly { label: string; icon?: LucideIcon; iconOnly?: boolean; intent?: 'add' | 'remove'; disabled?: boolean; pending?: boolean; onClick?: () => void }[]
}) {
  return (
    <div class="dinkster-canvas-editor-buttons">
      <For each={props.buttons}>
        {(button) => button.iconOnly === true && button.icon !== undefined ? (
          <ProductIconButton
            label={button.label}
            icon={button.icon}
            {...(button.intent === 'remove' ? { intent: 'remove' as const } : {})}
            disabled={button.disabled === true}
            onClick={() => button.onClick?.()}
          />
        ) : (
          <ProductButton
            {...(button.intent === undefined ? {} : { intent: button.intent })}
            disabled={button.disabled === true}
            pending={button.pending === true}
            onClick={() => button.onClick?.()}
          >
            <Show when={button.icon}>{(icon) => <ProductIcon icon={icon()} />}</Show>
            {button.label}
          </ProductButton>
        )}
      </For>
    </div>
  )
}

/** A name and its value on one editor line, such as "Image A frame: 3". */
export function CanvasEditorFact(props: { label: string; children: JSX.Element }) {
  return (
    <div class="dinkster-canvas-editor-fact">
      <span class="dinkster-canvas-editor-fact-label">{props.label}</span>
      <span class="dinkster-canvas-editor-fact-value">{props.children}</span>
    </div>
  )
}
