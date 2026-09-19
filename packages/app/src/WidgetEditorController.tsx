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

import { createMemo, onCleanup, Show, type Component, type JSX } from 'solid-js'
import {
  canonicalTypeIdOf,
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
import type { AssetDtoV1WireContract } from '@dinkster/client'
import type { AppState, Tab } from './app-state.js'
import { ModalSurface } from './ModalSurface.js'
import { OutputDescriptorEditor } from './OutputDescriptorEditor.js'
import { placeFloatingSurface } from './floating-surface.js'
import { HostUiProviderHost } from './host-ui.js'
import { useAppMessage } from './locale.js'
import { VideoDocumentEditor, isVideoDocumentEditorCommand } from './VideoDocumentEditor.js'
import {
  contrastingTextColor,
  editorScreenAnchor,
} from './widget-editor-position.js'

export { parseNumericCommit, widgetCommitError, type NumericCommitResult } from './widget-commit.js'

/**
 * Wrap a command with a preceding dynamic.materialize when the target widget
 * is a ghost/min-fill member: ONE batch, so materialization is atomic with
 * the write that caused it (one undo step; a rejected write persists nothing).
 */
export function withMaterializeFrames(
  graphId: string,
  nodeId: string,
  frames: readonly MaterializeFrame[] | undefined,
  action: CommandInvocation,
): CommandInvocation {
  if (frames === undefined || frames.length === 0) return action
  return {
    command: 'batch',
    params: {
      invocations: [
        {
          command: 'dynamic.materialize',
          params: {
            graphId,
            nodeId,
            frames: frames.map((f) => ({ construct: f.construct, members: [...f.members] })),
          },
        },
        { command: action.command, params: action.params },
      ],
    },
  } as CommandInvocation
}

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
  /** Current materialized member names for schema-declared completion sources. */
  readonly inputFamilyMembers?: Readonly<Record<string, readonly string[]>>
  /** Editor anchor rect in canvas world coordinates. */
  readonly rect: { x: number; y: number; width: number; height: number }
  readonly initial: Json | undefined
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

function videoDocumentCommandOf(ed: WidgetEditorState): string | undefined {
  if (ed.target.kind !== 'input') return undefined
  const graphId = ed.target.familyOwner?.graphId ?? ed.graphId
  const nodeId = ed.target.familyOwner?.nodeId ?? ed.target.nodeId
  const inputId = ed.target.familyOwner?.valueKey ?? ed.target.valueKey
  const type = ed.tab.store?.doc?.graphs[graphId]?.nodes[nodeId]?.type
  if (type === undefined || !type.startsWith('dinkster.video_document.')) return undefined
  const command = type.slice('dinkster.video_document.'.length)
  return ((inputId === 'params' && command !== 'import_otio') || (inputId === 'otio' && command === 'import_otio')) &&
    isVideoDocumentEditorCommand(command) ? command : undefined
}

export interface WidgetEditorProps {
  app: AppState
  federatedAssets?: AssetDtoV1WireContract
  /** Visible host region that floating child surfaces must not leave. */
  boundary?: HTMLElement
  /** Plain value: the host's keyed Show remounts this component per open. */
  ed: WidgetEditorState
  /** Main canvas viewport, sampled once to place a newly opened popover. */
  viewport: () => { x: number; y: number; scale: number }
  /** Registers the synchronous commit-or-close path for an outside press. */
  bindClickAway?: (handler: (() => void) | undefined) => void
  /** Lets the canvas activate an exposed ASSET row after this modal closes. */
  onAssetBackdropPointerDown?: (event: PointerEvent) => void
  onClose: () => void
}

export interface WidgetEditorImplementationProps {
  bindPopover: (el: HTMLDivElement) => void
  close: () => void
  commitValue: (value: Json) => void
  editor: WidgetEditorProps
  header: Component<{ type: string }>
  popoverStyle: JSX.CSSProperties
}

export interface WidgetEditorModalConfiguration {
  displayType?: string
  help: JSX.Element
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
  const videoDocumentCommand = videoDocumentCommandOf(ed)
  const videoDocumentContext = createMemo(() => {
    if (videoDocumentCommand === undefined || ed.target.kind !== 'input') return undefined
    const graphId = ed.target.familyOwner?.graphId ?? ed.graphId
    const nodeId = ed.target.familyOwner?.nodeId ?? ed.target.nodeId
    const graph = ed.tab.store.doc.graphs[graphId]
    const linked = (inputId: string) => graph !== undefined && (
      Object.values(graph.links).some((link) => 'node' in link.to && 'port' in link.to && link.to.node === nodeId && link.to.port === inputId) ||
      Object.values(graph.nets).some((net) => net.sinks.some((sink) => sink.node === nodeId && sink.port === inputId))
    )
    const needsDocument = !['make', 'import_otio'].includes(videoDocumentCommand)
    return {
      videoInputDriven: linked('video'),
      ...(needsDocument ? {
        documentSourceStatus: message(linked('document')
          ? 'videoDocument.source.connected'
          : 'videoDocument.source.missing'),
      } : {}),
    }
  })
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
    const layer = el?.parentElement
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
      if (el.parentElement) popoverResize?.observe(el.parentElement)
    })
  }
  onCleanup(() => {
    popoverResize?.disconnect()
    window.removeEventListener('resize', clampPopover)
  })

  const close = (): void => props.onClose()

  /** All expanded editors converge on the same undoable document command. */
  const commitEditorValue = (value: Json): void => {
    // Chrome fires blur when a focused field is detached, so an Escape-close
    // (or any unmount) would otherwise re-enter here and commit the discarded
    // text. Closed editors never commit.
    if (!live) return
    close()
    if (ed.target.kind !== 'input') {
      props.app.dispatchTo(ed.tab, {
        command: 'valueSource.setValue',
        params: { graphId: ed.graphId, valueSourceId: ed.target.valueSourceId, value },
      })
      return
    }
    props.app.dispatchTo(
      ed.tab,
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

  const commitEditor = (value: Json): void => {
    if (!live) return // blur-on-detach must not resurrect a closed editor
    commitEditorValue(value)
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
      <header class="widget-editor-header" data-testid="widget-editor-header">
        <span data-testid="widget-editor-label">{ed.label}</span>
        <span class="widget-editor-header-actions">
          <span class="widget-editor-type" data-testid="widget-editor-type" style={pillStyle}>{headerProps.type}</span>
        </span>
      </header>
    )
  }
  const modalType = props.modal?.type ?? (videoDocumentCommand !== undefined ? 'VIDEO_DOCUMENT' : ed.spec?.widgetType ?? 'JSON')
  const modalDisplayType = createMemo(() => props.modal?.displayType ?? (modalType === 'VIDEO_DOCUMENT'
    ? message('videoDocument.type')
    : modalType))
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
      aria-label={`Edit ${ed.label} ${modalDisplayType()}`}
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
  const EditorContent = () => videoDocumentCommand !== undefined ? (
    <div
      class="widget-editor widget-modal-editor video-document-modal"
      data-testid="widget-editor"
      data-editor-mode="VIDEO_DOCUMENT"
      data-editor-surface="modal"
    >
      <EditorHeader type="VIDEO_DOCUMENT" />
      <VideoDocumentEditor
        command={videoDocumentCommand}
        value={typeof ed.initial === 'string' ? ed.initial : videoDocumentCommand === 'import_otio' ? '' : '{}'}
        {...videoDocumentContext()}
        onCommit={commitEditorValue}
        onCancel={close}
      />
    </div>
  ) : props.implementation !== undefined ? (
    <props.implementation
      bindPopover={bindPopover}
      close={close}
      commitValue={commitEditorValue}
      editor={props}
      header={EditorHeader}
      popoverStyle={popoverStyle}
    />
  ) : ed.outputDescriptors !== undefined ? (
    <div ref={bindPopover} class="widget-editor floating-surface widget-editor-popover output-descriptor-popover" data-testid="widget-editor" role="dialog" aria-label="Edit output descriptors" style={popoverStyle}>
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
          when={props.modal !== undefined || videoDocumentCommand !== undefined}
          fallback={
            <div
              class="palette-layer widget-popover-layer"
              data-testid="widget-popover-layer"
            >
              <EditorContent />
            </div>
          }
        >
          <ModalSurface
                title={`${ed.label} ${modalDisplayType()}`}
                ariaLabel={`Edit ${ed.label} ${modalDisplayType()}`}
                describedBy="widget-editor-description"
                modalId={modalId}
                testId="widget-modal-surface"
                closeLabel={`Close ${ed.label} ${modalDisplayType()} editor`}
                dismissBlocked={props.modal?.dismissBlocked?.() === true}
                onRequestClose={() => {
                  if (props.modal?.onRequestClose !== undefined) {
                    props.modal.onRequestClose(close)
                    return
                  }
                  close()
                }}
                {...(props.onAssetBackdropPointerDown !== undefined
                  ? { onBackdropPointerDown: props.onAssetBackdropPointerDown }
                  : {})}
              >
                <p id="widget-editor-description" class="widget-modal-help">
                  {props.modal?.help ?? message('videoDocument.help')}
                </p>
                <EditorContent />
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
