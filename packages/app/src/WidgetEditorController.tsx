/**
 * Expanded widget editors: anchored popovers and native product dialogs.
 *
 * The host owns what the editor cannot know: when to open/close (hit-testing,
 * scene changes,
 * hotkeys), the WidgetEditorState anchor it constructs from the hit, and
 * in-place BOOLEAN toggles (no overlay). Editor implementations own their
 * per-open state. The host mounts this under a KEYED Show, so a fresh
 * WidgetEditorState remounts the component - opening IS the reset.
 */

import { createMemo, createSignal, onCleanup, onMount, Show, type Component, type JSX } from 'solid-js'
import {
  canonicalTypeIdOf,
  jsonSameValue,
  semanticDesignTokens,
  type CommandInvocation,
  type EditorSizing,
  type HostUiProviderV1,
  type Json,
  type MaterializeFrame,
  type OutputDescriptorsSpec,
  type SourceFilenameSpec,
  type TypeExpr,
  type WidgetSpec,
} from '@dinkster/core'
import { defaultTokens, typeColor, type DynamicEditOwner } from '@dinkster/canvas'
import { ProductEditorFrame, ProductStringsProvider, type ProductEditorFramePhase } from '@dinkster/ui'
import type { AppState, Tab } from './app-state.js'
import { ModalSurface } from './ModalSurface.js'
import { ProductNotice } from './ProductForm.js'
import { OutputDescriptorEditor } from './OutputDescriptorEditor.js'
import { placeFloatingSurface } from '@dinkster/core/floating-surface'
import { HostUiProviderHost } from './host-ui.js'
import { useAppMessage } from './locale.js'
import {
  dynamicSelectorCommitCommand,
  withMaterializeFrames,
} from './widget-editor-command.js'
import {
  contrastingTextColor,
  editorScreenAnchor,
} from './widget-editor-position.js'

export { parseNumericCommit, widgetCommitError, type NumericCommitResult } from './widget-commit.js'
export { withMaterializeFrames } from './widget-editor-command.js'

/** What a widget editor writes to: a node input, or a value source's value. */
export type EditorTarget =
  | {
      readonly kind: 'input'
      readonly nodeId: string
      /** node.values key (layout row's valueKey), NOT the elab view key. */
      readonly valueKey: string
      /** Ghost/min-fill widget: batch dynamic.materialize with the write. */
      readonly materialize?: readonly MaterializeFrame[]
      /** Derived occurrence values persist on this owner. */
      readonly familyOwner?: { readonly graphId: string; readonly nodeId: string; readonly valueKey?: string }
      /** Structural authored-menu state coordinate, separate from value ownership. */
      readonly optionsTarget?: {
        readonly construct: string
        readonly ancestors: readonly { readonly construct: string; readonly member: string }[]
        readonly owner?: DynamicEditOwner
        readonly materialize?: readonly MaterializeFrame[]
      }
      /** Occurrence-local owner of a COMBO option source's input family. */
      readonly inputFamilyOwner?: {
        readonly graphId: string
        readonly nodeId: string
        readonly construct: string
        readonly memberIds: Readonly<Record<string, string>>
      }
      /** DynamicCombo selector row: commit via dynamic.selectOption instead. */
      readonly selector?: {
        readonly construct: string
        readonly ancestors: readonly { readonly construct: string; readonly member: string }[]
        readonly owner?: DynamicEditOwner
      }
    }
  | { readonly kind: 'valueSource'; readonly valueSourceId: string }

export interface WidgetEditorState {
  /**
   * Mutable on purpose: a workspace promotion replaces the Tab wrapper
   * (same id, new store) while an editor may be open, and the host rebinds
   * this field in place so its draft commits to the live store.
   * Replacing the whole state object instead would remount the keyed
   * editor and discard the draft.
   */
  tab: Tab
  readonly graphId: string
  readonly target: EditorTarget
  /** The same display label painted on the widget row or value source. */
  readonly label: string
  /**
   * Effective widget spec. Undefined = the raw JSON fallback editor (an
   * unconnected, undeclared value source still has an editable value - P2).
   */
  readonly spec: WidgetSpec | undefined
  /** Resolved row view, including a user-selected presentation override. */
  readonly viewId?: string
  /** Declared row contract when an unavailable kind uses the raw editor. */
  readonly anchorSpec?: WidgetSpec
  /**
   * The input's declared schema TypeExpr (widget rows carry it; value
   * sources declare none). ASSET editors gate multi-select on it per the
   * typed-assets pin (5): list-outer declarations pick N descriptors.
   */
  readonly declaredType?: TypeExpr
  /** Execution binding for wire-22 source media inputs. */
  readonly sourceFilename?: SourceFilenameSpec
  /**
   * Atom type ids with a registered batch-merge provider, captured from
   * the owner backend's registry at open time (dinkster.mergeableTypes).
   * Gates the ASSET multi-select SCALAR MERGE arm (typed-assets pin (5)):
   * a scalar concrete T declaration picks N descriptors only when T is a
   * member. Absent = older backend, merge arm off.
   */
  readonly mergeableTypes?: readonly string[]
  readonly multiline: boolean
  /**
   * Set when the row is edited in its own row on the canvas instead of in a
   * card: the node look, the node's bottom edge in world coordinates (the
   * side part goes under the node when neither side has room), and the
   * input's tooltip for the side part.
   */
  readonly inRow?: {
    readonly look: 'original' | 'flat-title'
    readonly nodeTop: number
    readonly nodeBottom: number
    readonly help?: string
    /** The raw stored value when the field opened (null when none was stored). */
    readonly storedAtOpen: Json
    /** A seed's after-run mode. */
    readonly controllerMode?: 'fixed' | 'increment' | 'decrement' | 'randomize'
    /** Where a click opened a text row, in client coordinates. */
    readonly caret?: { readonly x: number; readonly y: number }
  }
  /** Where a click opened a text box, in client coordinates. */
  readonly caret?: { readonly x: number; readonly y: number }
  /** How far a text box's row extends above and below `rect`, in world units; its bar sits near the row's bottom. */
  readonly rowInsetY?: number
  /** Current materialized member names for schema-declared completion sources. */
  readonly inputFamilyMembers?: Readonly<Record<string, readonly string[]>>
  /** Editor anchor rect in canvas world coordinates. */
  readonly rect: { x: number; y: number; width: number; height: number }
  readonly initial: Json | undefined
  /** A known-missing stored ref must not issue an initial preview byte read. */
  readonly missingAssetDigest?: string
  readonly outputDescriptors?: {
    readonly spec: OutputDescriptorsSpec
    readonly asset: unknown
    readonly staleLinks: readonly { readonly linkId: string; readonly outputId: string }[]
    readonly isCurrent: () => boolean
    readonly onDisconnect: (linkId: string) => void
  }
  readonly instancePath?: readonly string[]
  /** Host-decoded declarative editor supplied by the resolved WidgetView. */
  readonly hostUi?: {
    readonly provider: HostUiProviderV1
    readonly data: Json
    readonly sizing?: EditorSizing
  }
}

export interface WidgetEditorProps {
  app: AppState
  /** Visible host region that floating child surfaces must not leave. */
  boundary?: HTMLElement
  /** Plain value: the host's keyed Show remounts this component per open. */
  ed: WidgetEditorState
  /** Main canvas viewport, sampled once to place a newly opened popover. */
  viewport: () => { x: number; y: number; scale: number }
  /**
   * Puts the keyboard on a row of the node with nothing open, as after Enter.
   * A notice is the first line of the row's side part, such as why an editor closed.
   */
  focusRow?: (from: { readonly nodeId: string; readonly valueKey: string }, notice?: string) => void
  /** Opens the next (1) or previous (-1) row of the same node that Tab stops on. */
  moveRow?: (from: { readonly nodeId: string; readonly valueKey: string }, direction: 1 | -1) => void
  /**
   * Registers the synchronous commit-or-close path for an outside press. A
   * handler that returns false keeps the editor open and stops the press.
   */
  bindClickAway?: (handler: (() => unknown) | undefined) => void
  onClose: () => void
}

/**
 * What a full editor tells its frame. The editor keeps its own draft, tools
 * and writes; the frame owns Apply, Cancel and closing.
 */
export interface EditorFrameBinding {
  /** Where the draft stands; Apply is available only for `changed`. */
  readonly phase: () => ProductEditorFramePhase
  /** Footer words in place of the phase's own, such as what to fix. */
  readonly status?: () => string | undefined
  /** What could not load, while the phase is `unavailable`. */
  readonly unavailable?: () => string | undefined
  readonly retry?: () => void
  /**
   * Stores the draft through commitValue or commitCommand, after any work of
   * its own such as an upload. Resolves false or throws when nothing was stored.
   * An editor that can never store leaves it out and its frame offers Close.
   */
  readonly apply?: () => Promise<boolean> | boolean
}

/** The editor frame's words in the app's language. */
export function editorFrameStrings(message: ReturnType<typeof useAppMessage>) {
  return {
    apply: message('common.apply'),
    cancel: message('common.cancel'),
    closeEditor: message('editorFrame.closeEditor'),
    tryAgain: message('editorFrame.tryAgain'),
    loading: message('editorFrame.loadingStatus'),
    editorLoading: message('editorFrame.loading'),
    editorUnavailable: message('editorFrame.unavailable'),
    editorUnavailableStatus: message('editorFrame.unavailableStatus'),
    editorUnchanged: message('editorFrame.unchanged'),
    editorChanged: message('editorFrame.changed'),
    editorInvalid: message('editorFrame.invalid'),
    editorApplying: message('editorFrame.applying'),
    dismissError: message('editorFrame.dismissError'),
  }
}

export interface WidgetEditorImplementationProps {
  bindPopover: (el: HTMLDivElement) => void
  /** A full editor hands its frame its draft's state and its apply action. */
  bindFrame: (binding: EditorFrameBinding) => void
  close: () => void
  commitValue: (value: Json) => Promise<boolean>
  commitCommand: (invocation: CommandInvocation, closeOnAccept?: boolean) => Promise<boolean>
  commitPending: () => boolean
  commitError: () => string | undefined
  editor: WidgetEditorProps
  header: Component<{ type: string }>
  popoverStyle: JSX.CSSProperties
}

export interface WidgetEditorModalConfiguration {
  /** The editor's accessible description. */
  help?: JSX.Element
  /** A few controls: one centered column at the top of the frame, not the whole body. */
  form?: boolean
  dismissBlocked?: () => boolean
  onRequestClose?: (close: () => void) => void
  type: string
}

export interface WidgetEditorControllerProps extends WidgetEditorProps {
  implementation?: Component<WidgetEditorImplementationProps>
  modal?: WidgetEditorModalConfiguration
}

export function WidgetEditorController(props: WidgetEditorControllerProps) {
  const ed = props.ed
  const message = useAppMessage()
  const popoverAnchor = editorScreenAnchor(ed.rect, props.viewport())
  /** This editor was closed/superseded; late async results must not act. */
  let live = true
  onCleanup(() => { live = false })

  // Expanded controls are optional, anchored popovers. Keep them close to the
  // compact row without bringing back draggable/resizable card machinery.
  let popoverEl: HTMLDivElement | undefined
  let popoverResize: ResizeObserver | undefined
  const clampPopover = (): void => {
    const el = popoverEl
    const layer = el?.closest('.widget-popover-layer')
    if (!el || !layer) return
    const margin = semanticDesignTokens.space[4]
    const layerRect = layer.getBoundingClientRect()
    // A narrow shell can legitimately collapse the canvas stage to zero
    // while an editor is open. In that case, keep the editor discoverable in
    // the browser viewport instead of leaving it clipped by the empty stage.
    const useViewport = layer.clientWidth <= margin * 2 || layer.clientHeight <= margin * 2
    const bounds = {
      left: 0,
      top: 0,
      right: useViewport ? window.innerWidth : layer.clientWidth,
      bottom: useViewport ? window.innerHeight : layer.clientHeight,
    }
    const anchorLeft = popoverAnchor.x + (useViewport ? layerRect.left : 0)
    const anchorTop = popoverAnchor.y + (useViewport ? layerRect.top : 0)
    const placement = placeFloatingSurface({
      surface: { width: el.offsetWidth, height: el.offsetHeight },
      anchor: {
        left: anchorLeft,
        top: anchorTop,
        right: anchorLeft + popoverAnchor.width,
        bottom: anchorTop + popoverAnchor.height,
      },
      bounds,
      direction: 'block',
      margin,
      gap: 0,
    })
    el.style.position = useViewport ? 'fixed' : ''
    el.style.maxWidth = `${placement.maxWidth}px`
    el.style.maxHeight = `${placement.maxHeight}px`
    el.style.left = `${placement.left}px`
    el.style.top = `${placement.top}px`
  }
  const bindPopover = (el: HTMLDivElement): void => {
    popoverEl = el
    window.addEventListener('resize', clampPopover)
    if (typeof ResizeObserver !== 'undefined') {
      popoverResize = new ResizeObserver(clampPopover)
      popoverResize.observe(el)
    }
    queueMicrotask(() => {
      clampPopover()
      const layer = el.closest('.widget-popover-layer')
      if (layer) popoverResize?.observe(layer)
    })
  }
  onCleanup(() => {
    popoverResize?.disconnect()
    window.removeEventListener('resize', clampPopover)
  })

  const close = (): void => { live = false; props.onClose() }
  const framed = props.modal !== undefined
  const targetRow = ed.target.kind === 'input' ? { nodeId: ed.target.nodeId, valueKey: ed.target.valueKey } : undefined
  /** Closes the frame and puts the keyboard back on the row it was opened from. */
  const finish = (notice?: string): void => {
    if (live) close()
    if (targetRow !== undefined) props.focusRow?.(targetRow, notice)
  }
  const [commitPending, setCommitPending] = createSignal(false)
  const [commitError, setCommitError] = createSignal<string>()
  const commitCommand = async (invocation: CommandInvocation, closeOnAccept = true): Promise<boolean> => {
    if (!live || commitPending() || ed.tab.execution) return false
    const store = ed.tab.store
    setCommitPending(true)
    setCommitError(undefined)
    try {
      const outcome = await props.app.dispatchTo(ed.tab, invocation)
      // The canvas disposes a frame whose own accepted write rebuilt its row;
      // that write still counts, and the row still gets its notice.
      if (ed.tab.store !== store || (!live && !(framed && outcome.ok))) return false
      if (!outcome.ok) {
        setCommitError(outcome.diagnostics[0]?.message ?? message('widgetEditor.commitRefused'))
        return false
      }
      if (closeOnAccept) {
        if (framed) finish(message('editorFrame.applied'))
        else close()
      }
      return true
    } catch (reason) {
      if (live && ed.tab.store === store) setCommitError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      if (live) {
        setCommitPending(false)
        if (commitError() && popoverEl) popoverEl.scrollTop = 0
      }
    }
  }

  /** All expanded editors converge on the same undoable document command. */
  const commitEditorValue = (value: Json): Promise<boolean> => {
    // Chrome fires blur when a focused field is detached, so an Escape-close
    // (or any unmount) would otherwise re-enter here and commit the discarded
    // text. Closed editors never commit.
    if (!live) return Promise.resolve(false)
    if (ed.target.kind !== 'input') {
      return commitCommand({
        command: 'valueSource.setValue',
        params: { graphId: ed.graphId, valueSourceId: ed.target.valueSourceId, value },
      })
    }
    const selectorCommand = dynamicSelectorCommitCommand(ed, value)
    if (selectorCommand !== undefined) {
      return commitCommand(selectorCommand)
    }
    return commitCommand(
      withMaterializeFrames(ed.target.familyOwner?.graphId ?? ed.graphId, ed.target.familyOwner?.nodeId ?? ed.target.nodeId, ed.target.materialize, {
        command: 'node.setValue',
        params: {
          graphId: ed.target.familyOwner?.graphId ?? ed.graphId,
          nodeId: ed.target.familyOwner?.nodeId ?? ed.target.nodeId,
          inputId: ed.target.familyOwner?.valueKey ?? ed.target.valueKey,
          value,
        },
      }),
    )
  }

  const [frame, setFrame] = createSignal<EditorFrameBinding>()
  const [applying, setApplying] = createSignal(false)
  const frameBusy = (): boolean => applying() || commitPending()
  const framePhase = (): ProductEditorFramePhase => frame()?.phase() ?? 'loading'
  const applyFrame = async (): Promise<boolean> => {
    const binding = frame()
    if (!live || binding?.apply === undefined || frameBusy() || binding.phase() !== 'changed') return false
    setApplying(true)
    setCommitError(undefined)
    try {
      const stored = await binding.apply()
      if (!stored && live && commitError() === undefined) setCommitError(message('widgetEditor.commitRefused'))
      return stored
    } catch (reason) {
      if (live) setCommitError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      if (live) setApplying(false)
    }
  }
  const cancelFrame = (): void => {
    if (!live || frameBusy()) return
    if (props.modal?.onRequestClose !== undefined) props.modal.onRequestClose(() => finish())
    else finish()
  }
  // Ctrl+Enter stores a valid change, then runs the workflow; an unchanged
  // editor closes and runs, and one that can never store stays open and runs.
  // Nothing runs while the draft cannot be applied.
  const onFrameKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing || event.defaultPrevented) return
    event.preventDefault()
    const binding = frame()
    if (binding === undefined || frameBusy()) return
    const queue = props.app.commands.get('workflow.queue')
    const run = (): void => { if (queue?.enabled?.() !== false) queue?.run() }
    const phase = binding.phase()
    if (binding.apply === undefined) run()
    else if (phase === 'unchanged') {
      cancelFrame()
      if (!live) run()
    } else if (phase === 'changed') void applyFrame().then((stored) => { if (stored) run() })
  }
  /** The value the editor writes, as stored now; absent when its owner is gone. */
  const storedTarget = (): { readonly exists: boolean; readonly value: unknown } => {
    const doc = ed.tab.store.doc
    if (ed.target.kind === 'valueSource') {
      const source = doc.graphs[ed.graphId]?.valueSources?.[ed.target.valueSourceId]
      return { exists: source !== undefined, value: source?.value }
    }
    const owner = ed.target.familyOwner
    const node = doc.graphs[owner?.graphId ?? ed.graphId]?.nodes[owner?.nodeId ?? ed.target.nodeId]
    return { exists: node !== undefined, value: node?.values[owner?.valueKey ?? ed.target.valueKey] }
  }
  if (framed) {
    // A draft never overwrites a value someone else stored meanwhile: the
    // editor closes without writing when its value changes or its node goes.
    const atOpen = storedTarget()
    const store = ed.tab.store
    const unsubscribe = store.document.subscribe(() => {
      if (!live || frameBusy() || ed.tab.store !== store) return
      const now = storedTarget()
      if (!now.exists) close()
      else if (!jsonSameValue(now.value as never, atOpen.value as never)) finish(message('editorFrame.targetChanged'))
    })
    onCleanup(unsubscribe)
  }

  const clickAway = (): void => {
    if (!live) return
    if (ed.hostUi !== undefined) {
      close()
      return
    }
    close()
  }

  if (props.implementation === undefined) props.bindClickAway?.(clickAway)
  onCleanup(() => {
    if (props.implementation === undefined) props.bindClickAway?.(undefined)
  })

  const pillBackground = typeColor(defaultTokens, ed.declaredType === undefined
    ? ed.spec?.widgetType ?? 'JSON'
    : canonicalTypeIdOf(ed.declaredType) ?? ed.spec?.widgetType ?? 'JSON')
  const pillStyle = { color: contrastingTextColor(pillBackground), background: pillBackground }
  const EditorHeader = (headerProps: { type: string }) => {
    return (
      <>
      <header class="widget-editor-header" data-testid="widget-editor-header">
        <span data-testid="widget-editor-label">{ed.label}</span>
        <span class="widget-editor-header-actions">
          <span class="widget-editor-type" data-testid="widget-editor-type" style={pillStyle}>{headerProps.type}</span>
        </span>
      </header>
      <Show when={props.modal === undefined && commitError()}>{(error) => <ProductNotice tone="error" testId="widget-commit-error">{error()}</ProductNotice>}</Show>
      </>
    )
  }
  /** "Field - Node": the row's label and the title of the node it belongs to. */
  const frameTitle = (): string => {
    if (ed.target.kind !== 'input') return ed.label
    const owner = ed.target.familyOwner
    const node = ed.tab.store.doc.graphs[owner?.graphId ?? ed.graphId]?.nodes[owner?.nodeId ?? ed.target.nodeId]
    const title = node === undefined ? undefined
      : node.title ?? props.app.registryForTab?.(ed.tab)?.resolve(node.type)?.displayName ?? node.type
    return title === undefined || title === '' ? ed.label : `${ed.label} - ${title}`
  }
  const frameStrings = () => editorFrameStrings(message)
  /**
   * The keyboard starts on the editor's first tool, not on the close button
   * the dialog would pick; an editor that focused a field itself keeps it.
   */
  const focusFirstTool = (anchor: HTMLElement): void => {
    onMount(() => queueMicrotask(() => queueMicrotask(() => {
      const dialog = anchor.closest('dialog')
      const body = dialog?.querySelector<HTMLElement>('.dinkster-editor-frame-body:not([hidden])')
      const active = document.activeElement
      if (!dialog || !body || (active !== dialog && active !== document.body && !dialog.querySelector('.dinkster-editor-frame-header')?.contains(active))) return
      const tool = [...body.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
        .find((element) => element.getClientRects().length > 0)
      ;(tool ?? dialog).focus()
    })))
  }
  const modalType = props.modal?.type ?? ed.spec?.widgetType ?? 'JSON'
  const modalId = `widget-${modalType.toLowerCase().replaceAll('_', '-')}`
  const popoverStyle = {
    left: `${popoverAnchor.x}px`,
    top: `${popoverAnchor.y + popoverAnchor.height}px`,
  }
  const hostUiProblemsOwner = Symbol('widget-editor-host-ui')
  const hostUiPopoverStyle = () => {
    const sizing = ed.hostUi?.sizing
    if (sizing === undefined) return popoverStyle
    const width = Math.min(sizing.max?.width ?? Infinity, Math.max(sizing.min?.width ?? 0, sizing.preferred.width))
    const height = Math.min(sizing.max?.height ?? Infinity, Math.max(sizing.min?.height ?? 0, sizing.preferred.height))
    return {
      ...popoverStyle,
      width: `${width}px`,
      height: `${height}px`,
      ...(sizing.resizable === true ? { resize: 'both' as const } : {}),
    }
  }
  const bindHostUiPopover = (el: HTMLDivElement): void => {
    bindPopover(el)
    queueMicrotask(() => {
      const target = el.querySelector<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')
      ;(target ?? el).focus()
    })
  }
  const HostUiEditor = () => (
    <div
      ref={bindHostUiPopover}
      class="widget-editor floating-surface widget-editor-popover widget-editor-host-ui"
      data-testid="widget-editor"
      data-editor-target={ed.target.kind}
      data-editor-mode={ed.spec?.widgetType ?? 'raw'}
      data-editor-surface="popover"
      role="dialog"
      aria-label={`Edit ${ed.label} ${modalType}`}
      tabIndex={-1}
      style={hostUiPopoverStyle()}
    >
      <EditorHeader type={ed.spec?.widgetType ?? 'JSON'} />
      <div class="widget-editor-host-ui-content" data-testid="widget-editor-host-ui">
        <HostUiProviderHost
          owner={hostUiProblemsOwner}
          provider={ed.hostUi!.provider}
          data={ed.hostUi!.data}
          surface="widget-editor"
          commands={props.app.commands}
          replaceProblems={(owner, diagnostics) => props.app.replaceProblems(owner, diagnostics)}
          errorText="Unable to render extension widget editor."
        />
      </div>
    </div>
  )
  const EditorContent = () => props.implementation !== undefined ? (
    <props.implementation
      bindPopover={bindPopover}
      bindFrame={setFrame}
      close={framed ? () => finish() : close}
      commitValue={commitEditorValue}
      commitCommand={commitCommand}
      commitPending={commitPending}
      commitError={commitError}
      editor={props}
      header={EditorHeader}
      popoverStyle={popoverStyle}
    />
  ) : ed.outputDescriptors !== undefined ? (
    <div ref={bindPopover} class="widget-editor floating-surface widget-editor-popover output-descriptor-popover" data-testid="widget-editor" role="dialog" aria-label="Edit output descriptors" style={popoverStyle}>
      <Show when={commitError()}>{(error) => <ProductNotice tone="error" testId="widget-commit-error">{error()}</ProductNotice>}</Show>
      <OutputDescriptorEditor
        spec={ed.outputDescriptors.spec}
        initial={ed.initial}
        asset={ed.outputDescriptors.asset}
        staleLinks={ed.outputDescriptors.staleLinks}
        app={props.app}
        tab={ed.tab}
        isCurrent={ed.outputDescriptors.isCurrent}
        onDisconnect={ed.outputDescriptors.onDisconnect}
        onCommit={commitEditorValue}
        onClose={close}
      />
    </div>
  ) : null

  return (
    <Show
      when={ed.hostUi !== undefined}
      fallback={
        <Show
          when={props.modal !== undefined}
          fallback={
            <div
              class="palette-layer widget-popover-layer"
              data-testid="widget-popover-layer"
            >
              <div class="widget-commit-content" inert={commitPending()} aria-busy={commitPending()}><EditorContent /></div>
            </div>
          }
        >
          <ModalSurface
                title={frameTitle()}
                variant="editor"
                {...(props.boundary !== undefined ? { bounds: props.boundary } : {})}
                {...(props.modal?.help !== undefined ? { describedBy: 'widget-editor-description' } : {})}
                modalId={modalId}
                testId="widget-modal-surface"
                dismissBlocked={frameBusy() || props.modal?.dismissBlocked?.() === true}
                onRequestClose={cancelFrame}
                onKeyDown={onFrameKeyDown}
              >
                <p id="widget-editor-description" class="dinkster-visually-hidden" ref={focusFirstTool}>
                  {props.modal?.help}
                </p>
                <ProductStringsProvider strings={frameStrings()}>
                  <ProductEditorFrame
                    title={frameTitle()}
                    phase={framePhase()}
                    applying={frameBusy()}
                    form={props.modal?.form === true}
                    {...(frame()?.status?.() !== undefined ? { status: frame()!.status!()! } : {})}
                    {...(commitError() !== undefined ? { error: commitError()!, onDismissError: () => setCommitError(undefined) } : {})}
                    {...(frame()?.unavailable?.() !== undefined ? { unavailableLabel: frame()!.unavailable!()! } : {})}
                    {...(frame()?.retry !== undefined ? { onRetry: () => frame()?.retry?.() } : {})}
                    {...(frame()?.apply !== undefined ? { onApply: () => { void applyFrame() } } : {})}
                    onCancel={cancelFrame}
                  >
                    <EditorContent />
                  </ProductEditorFrame>
                </ProductStringsProvider>
          </ModalSurface>
        </Show>
      }
    >
      <div class="palette-layer widget-popover-layer" data-testid="widget-popover-layer">
        <HostUiEditor />
      </div>
    </Show>
  )
}
