/**
 * Expanded widget editors: anchored popovers for text/number/JSON, COLOR,
 * SAVE_TARGET, and COMBO controls; ASSET alone uses a native product dialog.
 *
 * The host owns what the editor cannot know: when to open/close (hit-testing,
 * scene changes,
 * hotkeys), the WidgetEditorState anchor it constructs from the hit, and
 * in-place BOOLEAN toggles (no overlay). This component owns every per-open
 * ephemeral: combo query/highlight, remote option fetches, color HSV state,
 * asset preview/upload/browse, save-target mount list, validation errors,
 * and modal validation state. The host mounts it under a KEYED Show, so a fresh
 * WidgetEditorState remounts the component - opening IS the reset.
 */

import { createEffect, createMemo, createSignal as createSolidSignal, For, onCleanup, Show } from 'solid-js'
import {
  assetMultiSelect,
  canonicalTypeIdOf,
  isCanonicalUnsafeInteger,
  jsonSameValue,
  numericStepConstraints,
  semanticDesignTokens,
  type CollectionEntry,
  type CommandInvocation,
  type EditorSizing,
  type HostUiProviderV1,
  type Json,
  type JsonObject,
  type MaterializeFrame,
  type OutputDescriptorsSpec,
  type SourceFilenameSpec,
  type TypeExpr,
  type WidgetSpec,
} from '@dinkster/core'
import { defaultTokens, typeColor, type DynamicEditOwner } from '@dinkster/canvas'
import { AssetDtoV1Client, type AssetDtoV1WireContract, type AssetGuessCandidate, type CandidateV1 } from '@dinkster/client'
import {
  colorKind,
  hexToHsv,
  hsvToHex,
  isSaveTarget,
  saveTargetIssues,
  saveTargetPresentation,
  type TextCompletion,
  type TextCompletionInventoryLoadingState,
  type TextCompletionInventoryRequestHandle,
  type TextCompletionInventorySettledState,
  type TextWidgetEditorContext,
  type TextWidgetEditorExtension,
} from '@dinkster/widgets'
import { Check, ChevronLeft, ChevronRight, Folder, RotateCw, Upload, X } from 'lucide-solid'
import { assetCollectionSource, assetEntryPickable, assetItemOf } from './asset-browser/collection-adapter.js'
import { assetSourcesStatus, committableAssetRef, formatSize, mediaKindForAccept, VIEW_PREFERENCE_KEY } from './asset-browser/helpers.js'
import { mountAssetSources } from './asset-browser/mountAssetSource.js'
import { localMountScanAdapter } from './asset-browser/local-mount-logical-model.js'
import { ingestLogicalModels } from './asset-browser/logical-model-merge.js'
import { candidateLogicalModelAdapter } from './asset-browser/candidate-logical-model.js'
import { allAssetsCollectionSource, mountPresentationClass } from './asset-browser/cross-mount-collection-source.js'
import type { LogicalModel } from './asset-browser/logical-model.js'
import {
  logicalModelAssetRefOf,
  logicalModelCollectionSource,
  logicalModelEntrySelectable,
  logicalModelEntryVisible,
  logicalModelPickDetailOf,
  type LogicalModelPickDetail,
} from './asset-browser/logical-model-collection-source.js'
import { AssetEntryFallback } from './asset-browser/presentation.js'
import { isModel3dMime, model3dMimeFor } from './model3d-mime.js'
import { Model3dPosterImage } from './Model3dPosterImage.js'
import { AudioRecorder } from './AudioRecorder.js'
import { ProductActionFooter, ProductField, ProductNotice, productFieldIds } from './ProductForm.js'
import { ProductSelect } from './ProductSelect.js'
import { OutputDescriptorEditor } from './OutputDescriptorEditor.js'
import { AssetSelectionDetails, LogicalModelVariantFacts } from './asset-browser/rail.js'
import type { AssetBrowserItem, AssetSourceAdapter } from './asset-browser/types.js'
import { CollectionPanel, type CollectionPanelState } from './CollectionPanel.js'
import type { AppState, Tab } from './app-state.js'
import {
  clampComboHighlight,
  comboMenuEntries,
  comboRenderWindow,
  scrollComboHighlightIntoView,
  type ComboHighlightSource,
  type ComboOption,
  type ComboRenderWindow,
} from './combo-search.js'
import { Icon } from './Icon.js'
import { ModalSurface } from './ModalSurface.js'
import { assetGuessCandidateToRef } from './dialog-requests.js'
import { comboOptions, remoteComboRefreshCanAdvance } from './app-view-rows.js'
import {
  createSuggestionInteraction,
  SuggestionSurface,
  type SuggestionSurfaceItem,
  type SuggestionSurfaceState,
} from './SuggestionSurface.js'
import { SearchState } from './SearchSurface.js'
import { parseNumericCommit, resolveTextCommit, widgetCommitError } from './widget-commit.js'
import { placeFloatingSurface } from './floating-surface.js'
import { HostUiProviderHost } from './host-ui.js'
import { useAppMessage } from './locale.js'
import { VideoEditEditor } from './VideoEditEditor.js'
import { videoEditContext } from './video-edit-context.js'
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

export function isInNodeTextEditor(ed: WidgetEditorState): boolean {
  return videoDocumentCommandOf(ed) === undefined && ed.outputDescriptors === undefined &&
    ed.target.kind === 'input' && ed.spec?.widgetType === 'STRING' && ed.multiline
}

interface AssetRef extends JsonObject {
  readonly digest: string
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly virtualPath: string
}

interface AssetPreview {
  readonly kind: 'image' | 'video' | 'model3d'
  readonly src: string
  readonly name: string
  /** Distinguishes GLB from splat PLY for the model3d poster render. */
  readonly mime?: string
}

const GENERIC_UPLOAD_MAX_BYTES = 16 * 1024 * 1024
const IMAGE_UPLOAD_MAX_BYTES = 256 * 1024 * 1024
const MEDIA_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024
const LATENT_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024

interface AssetPickerVocabulary {
  readonly singular: string
  readonly plural: string
  readonly titlePlural: string
  readonly modalType: string
  readonly uploadSingular: string
  readonly uploadPlural: string
}

/** Prefix a noun with its indefinite article ("an asset", "a file"). */
const withArticle = (noun: string): string => (/^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`)

const GENERIC_ASSET_VOCABULARY: AssetPickerVocabulary = {
  singular: 'asset',
  plural: 'assets',
  titlePlural: 'Assets',
  modalType: 'asset',
  uploadSingular: 'file',
  uploadPlural: 'files',
}

const LATENT_ASSET_VOCABULARY: AssetPickerVocabulary = {
  singular: 'latent',
  plural: 'latents',
  titlePlural: 'Latents',
  modalType: 'latent asset',
  uploadSingular: 'latent',
  uploadPlural: 'latents',
}

const MODEL_ASSET_VOCABULARY: AssetPickerVocabulary = {
  singular: 'model',
  plural: 'models',
  titlePlural: 'Models',
  modalType: 'asset',
  uploadSingular: 'model file',
  uploadPlural: 'model files',
}

const isAssetRef = (value: unknown): value is AssetRef => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const asset = value as Partial<AssetRef>
  return typeof asset.digest === 'string' && typeof asset.name === 'string' &&
    typeof asset.size === 'number' && typeof asset.mediaType === 'string' &&
    typeof asset.virtualPath === 'string'
}
const isAssetRefArray = (value: unknown): value is readonly AssetRef[] =>
  Array.isArray(value) && value.every(isAssetRef)

export function unresolvedAssetBasename(requested: string): string {
  return requested.split(/[\\/]/).filter(Boolean).at(-1) ?? requested
}

export function mediaAcceptsFile(accept: readonly string[], mediaType: string): boolean {
  if (mediaType === '') return false
  return accept.some((pattern) => pattern === mediaType || pattern === '*/*' ||
    (pattern.endsWith('/*') && mediaType.startsWith(pattern.slice(0, -1))))
}

function assetPickerState(state: CollectionPanelState, vocabulary: AssetPickerVocabulary) {
  if (state.kind === 'loading') return <SearchState kind="loading" title={`Loading ${vocabulary.plural}`} detail={`Searching ${state.sourceLabel}.`} />
  if (state.kind === 'error') return <SearchState kind="error" title={`${vocabulary.titlePlural} unavailable`} detail={state.message ?? `Unable to load ${state.sourceLabel}.`} />
  if (state.kind === 'no-compatible') return <SearchState kind="empty" title={`No available ${vocabulary.plural}`} detail="Choose another source or adjust the picker requirements." />
  if (state.kind === 'no-match') return <SearchState kind="empty" title={`No matching ${vocabulary.plural}`} detail="Try another search or remove an active filter." />
  return <SearchState kind="empty" title={`No ${vocabulary.plural} yet`} detail={`No matching ${vocabulary.plural} are available in ${state.sourceLabel}.`} />
}

function mediaUploadName(name: string): string {
  const basename = unresolvedAssetBasename(name).trim().replace(/[\u0000-\u001f\u007f]/g, '')
  const bounded = Array.from(basename).slice(0, 255).join('')
  return bounded === '' || bounded === '.' || bounded === '..' ? 'upload' : bounded
}

/** No backend capability exists yet for provider-backed asset acquisition. */
export function backendSupportsAssetAcquisition(): boolean {
  // Missing contract: provider metadata plus approve/execute/progress APIs
  // and a writable destination mount. Do not infer this from guessAssets.
  return false
}

export function WidgetEditor(props: {
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
}) {
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
  const scalarFieldIds = productFieldIds('widget-editor-value')
  const colorFieldIds = productFieldIds('color-editor-value')
  const saveTargetPrefixIds = productFieldIds('save-target-prefix')
  const backendTickSignal = ed.spec?.remote ? props.app.backendsTick : undefined
  const [backendTick, setBackendTick] = createSolidSignal(backendTickSignal?.get() ?? 0)
  const unsubscribeBackendTick = backendTickSignal?.subscribe(setBackendTick)
  if (unsubscribeBackendTick) onCleanup(unsubscribeBackendTick)
  const popoverAnchor = editorScreenAnchor(ed.rect, props.viewport())
  const inNode = isInNodeTextEditor(ed)
  const inNodeAnchor = () => editorScreenAnchor(ed.rect, props.viewport())
  /** This editor was closed/superseded; late async results must not act. */
  let live = true
  onCleanup(() => { live = false })

  // Expanded controls are optional, anchored popovers. Keep them close to the
  // compact row without bringing back draggable/resizable card machinery.
  // ASSET is the one exception: its collection browser remains a native modal.
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

  const [widgetEditorError, setWidgetEditorError] = createSolidSignal<string | undefined>(undefined)
  const inputFamilyOptions = ed.spec?.optionSource === undefined ? [] : comboOptions(ed.spec)
  const inputFamilyMemberIds = ed.target.kind === 'input' ? ed.target.inputFamilyOwner?.memberIds : undefined
  const editableInputFamilyOptions = inputFamilyMemberIds !== undefined
    ? inputFamilyOptions.filter((option) => inputFamilyMemberIds[String(option.value)] !== undefined)
    : inputFamilyOptions
  const initialMemberLabels: { [member: string]: string } = Object.fromEntries(
    inputFamilyOptions.map((option) => [option.value, option.label]),
  )
  const [memberLabels, setMemberLabels] = createSolidSignal(initialMemberLabels)
  const memberLabelError = createMemo(() => {
    const labels = Object.values(memberLabels()).map((label) => label.trim())
    if (labels.some((label) => label.length === 0)) return message('inputFamily.error.emptyLabel')
    return new Set(labels).size === labels.length ? undefined : message('inputFamily.labels.duplicate')
  })
  const memberLabelsChanged = createMemo(() => editableInputFamilyOptions.some((option) =>
    memberLabels()[option.value]?.trim() !== option.label))
  const persistedMemberId = (member: string | number): string => {
    const value = String(member)
    return inputFamilyMemberIds?.[value] ?? value
  }

  const commitMemberLabels = (): void => {
    if (ed.target.kind !== 'input' || ed.spec?.optionSource === undefined || memberLabelError() !== undefined) return
    const graphId = ed.target.inputFamilyOwner?.graphId ?? ed.graphId
    const nodeId = ed.target.inputFamilyOwner?.nodeId ?? ed.target.nodeId
    const construct = ed.target.inputFamilyOwner?.construct ?? ed.spec.optionSource.inputFamily
    const labels = Object.fromEntries(editableInputFamilyOptions.map((option) => [
      persistedMemberId(option.value),
      memberLabels()[option.value]?.trim() ?? option.label,
    ]))
    close()
    props.app.dispatchTo(ed.tab, {
      command: 'dynamic.labelMembers',
      params: { graphId, nodeId, construct, labels },
    } as unknown as CommandInvocation)
  }

  interface TextCompletionEntry extends SuggestionSurfaceItem {
    readonly completion: TextCompletion
    readonly provider?: TextWidgetEditorExtension
  }
  interface TextCompletionSessionContext {
    readonly text: string
    readonly caret: number
    readonly isCurrent?: () => boolean
  }
  type TextCompletionInventoryReadyState = Extract<TextCompletionInventorySettledState, { readonly status: 'ready' }>
  type TextCompletionSession =
    | { readonly status: 'idle' }
    | (TextCompletionSessionContext & Exclude<
        TextCompletionInventoryLoadingState | TextCompletionInventorySettledState,
        TextCompletionInventoryReadyState
      >)
    | (TextCompletionSessionContext & Omit<TextCompletionInventoryReadyState, 'items'> & {
        readonly entries: readonly TextCompletionEntry[]
      })
  const [textCompletionSession, setTextCompletionSession] = createSolidSignal<TextCompletionSession>({ status: 'idle' })
  const textCompletionEntries = createMemo<readonly TextCompletionEntry[]>(() => {
    const session = textCompletionSession()
    return session.status === 'ready' ? session.entries : []
  })
  const textCompletionOpen = (): boolean => textCompletionSession().status !== 'idle'
  const textCompletionSurfaceState = createMemo<SuggestionSurfaceState<TextCompletionEntry>>(() => {
    const session = textCompletionSession()
    if (session.status === 'loading') return { status: 'loading' }
    if (session.status === 'ready') return { status: 'ready', items: session.entries }
    if (session.status === 'error') return { status: 'error', message: session.message }
    return { status: 'empty' }
  })
  const textCompletionInteraction = createSuggestionInteraction<TextCompletionEntry>()
  let textCompletionController: AbortController | undefined
  let textCompletionSerial = 0
  type TextControl = HTMLInputElement | HTMLTextAreaElement
  let textCompletionAnchor: TextControl | undefined

  const textCompletionContext = (): TextWidgetEditorContext | undefined => {
    if (ed.spec?.widgetType !== 'STRING' || ed.target.kind !== 'input') return undefined
    const nodeType = ed.tab.store.doc.graphs[ed.graphId]?.nodes[ed.target.nodeId]?.type
    if (nodeType === undefined) return undefined
    return {
      graphId: ed.graphId,
      nodeId: ed.target.nodeId,
      inputId: ed.target.valueKey,
      nodeType,
      spec: ed.spec,
      ...(ed.inputFamilyMembers === undefined ? {} : { inputFamilyMembers: ed.inputFamilyMembers }),
    }
  }

  const closeTextCompletions = (): void => {
    textCompletionSerial += 1
    textCompletionController?.abort()
    textCompletionController = undefined
    setTextCompletionSession({ status: 'idle' })
    textCompletionInteraction.reset()
  }

  const openTextCompletionSession = (
    handle: TextCompletionInventoryRequestHandle,
    request: TextCompletionSessionContext & {
      readonly textarea: TextControl
      readonly providerByCompletion?: ReadonlyMap<TextCompletion, TextWidgetEditorExtension>
    },
  ): void => {
    const serial = ++textCompletionSerial
    const sessionContext: TextCompletionSessionContext = {
      text: request.text,
      caret: request.caret,
      ...(request.isCurrent === undefined ? {} : { isCurrent: request.isCurrent }),
    }
    setTextCompletionSession({ ...handle.loading, ...sessionContext })
    textCompletionInteraction.reset()
    void handle.settled.then((settled) => {
      if (!live || serial !== textCompletionSerial) return
      if (request.textarea.value !== request.text ||
        (request.textarea.selectionStart ?? request.textarea.value.length) !== request.caret) {
        setTextCompletionSession({ status: 'idle' })
        return
      }
      if (settled === undefined) {
        setTextCompletionSession({ status: 'idle' })
      } else if (settled.status === 'ready') {
        const entries = [...settled.items]
          .sort((a, b) => a.sourceOrder - b.sourceOrder)
          .filter((item) => item.filterText.startsWith(settled.query))
          .map(({ completion }) => {
            const provider = request.providerByCompletion?.get(completion)
            return {
              id: provider === undefined ? `inventory:${completion.id}` : `${provider.id}:${completion.id}`,
              label: completion.label,
              ...(completion.detail === undefined ? {} : { detail: completion.detail }),
              completion,
              ...(provider === undefined ? {} : { provider }),
            }
          })
        const ready = { status: settled.status, scopeId: settled.scopeId, query: settled.query }
        setTextCompletionSession(entries.length === 0
          ? { status: 'empty', scopeId: settled.scopeId, query: settled.query, ...sessionContext }
          : { ...ready, ...sessionContext, entries })
      } else {
        setTextCompletionSession({ ...settled, ...sessionContext })
      }
      textCompletionInteraction.reset()
    })
  }

  const requestTextCompletions = (textarea: TextControl, trigger: string): void => {
    const context = textCompletionContext()
    if (context === undefined) return
    textCompletionController?.abort()
    textCompletionController = undefined
    const controller = new AbortController()
    textCompletionController = controller
    const text = textarea.value
    const caret = textarea.selectionStart ?? text.length
    const liveInventory = props.app.liveEmbeddingAndLoraInventory.load({
      text,
      caret,
      signal: controller.signal,
    })
    if (liveInventory !== undefined) {
      openTextCompletionSession(liveInventory, {
        textarea,
        text,
        caret,
        isCurrent: () => props.app.liveEmbeddingAndLoraInventory.isScopeCurrent(liveInventory.loading.scopeId),
      })
      return
    }
    const providers = props.app.textEditorExtensionRegistry.providersFor(context)
    if (providers.length === 0) {
      closeTextCompletions()
      return
    }
    const providerByCompletion = new Map<TextCompletion, TextWidgetEditorExtension>()
    const scopeId = `text-editor-extensions:${providers.map((provider) => provider.id).join(',')}`
    const settled: Promise<TextCompletionInventorySettledState | undefined> = Promise.all(
      providers.map(async (provider) => {
        try {
          return await provider.complete({ ...context, text, caret, trigger, signal: controller.signal })
        } catch (error) {
          if (!controller.signal.aborted) {
            console.error(`text editor extension '${provider.id}' completion failed`, error)
          }
          return []
        }
      }),
    ).then((results) => {
      if (controller.signal.aborted) return undefined
      const activeProviders = new Set<TextWidgetEditorExtension>(
        props.app.textEditorExtensionRegistry.providersFor(context),
      )
      let sourceOrder = 0
      const items = results.flatMap((completions, index) => {
        const provider = providers[index]!
        if (!activeProviders.has(provider)) return []
        return completions.map((completion) => {
          providerByCompletion.set(completion, provider)
          return {
            completion,
            filterText: completion.label.normalize('NFKC').toLocaleLowerCase(),
            sourceOrder: sourceOrder++,
          }
        })
      })
      return items.length === 0
        ? undefined
        : { status: 'ready', scopeId, query: '', items }
    })
    openTextCompletionSession(
      {
        loading: { status: 'loading', scopeId, query: '' },
        settled,
      },
      { textarea, text, caret, providerByCompletion },
    )
  }

  const acceptTextCompletion = (textarea: TextControl, entry: TextCompletionEntry): void => {
    const session = textCompletionSession()
    if (session.status !== 'ready') return
    const context = textCompletionContext()
    const providerIsCurrent = entry.provider === undefined || (
      context !== undefined && props.app.textEditorExtensionRegistry.providersFor(context).includes(entry.provider)
    )
    if (textarea.value !== session.text || (textarea.selectionStart ?? textarea.value.length) !== session.caret ||
      session.isCurrent?.() === false ||
      !providerIsCurrent) {
      closeTextCompletions()
      return
    }
    const item = entry.completion
    const { start, end, text } = item.replacement
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > textarea.value.length) {
      console.error(`text editor extension returned an invalid replacement range for '${item.id}'`)
      closeTextCompletions()
      return
    }
    textarea.value = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`
    const caret = start + text.length
    textarea.setSelectionRange(caret, caret)
    closeTextCompletions()
  }

  onCleanup(() => closeTextCompletions())

  const close = (): void => props.onClose()

  /** All expanded editors converge on the same undoable document command. */
  const commitEditorValue = (value: Json): void => {
    // Chrome fires blur when a focused field is detached, so an Escape-close
    // (or any unmount) would otherwise re-enter here and commit the discarded
    // text. Closed editors never commit.
    if (!live) return
    if (ed.outputDescriptors === undefined && ed.spec?.widgetType === 'STRING' && typeof value === 'string' && ed.target.kind === 'input') {
      const graphId = ed.target.familyOwner?.graphId ?? ed.graphId
      const nodeId = ed.target.familyOwner?.nodeId ?? ed.target.nodeId
      const inputId = ed.target.familyOwner?.valueKey ?? ed.target.valueKey
      const currentStored = ed.tab.store.doc.graphs[graphId]?.nodes[nodeId]?.values[inputId]
      const resolution = resolveTextCommit(ed.initial, value, currentStored)
      close()
      if (resolution.kind === 'none') return
      if (resolution.kind === 'splice') {
        props.app.dispatchTo(ed.tab, {
          command: 'text.splice',
          params: { graphId, nodeId, inputId, ...resolution.splice },
        })
        return
      }
    } else {
      close()
    }
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

  const videoContext = ed.spec?.widgetType === 'VIDEO_EDIT' && ed.target.kind === 'input'
    ? videoEditContext(props.app, ed.tab, ed.target.familyOwner?.graphId ?? ed.graphId,
        ed.target.familyOwner?.nodeId ?? ed.target.nodeId, ed.instancePath)
    : undefined
  const videoRevision = ed.spec?.widgetType === 'VIDEO_EDIT' ? ed.tab.store.revision : undefined
  const videoInitial = videoContext?.initial ?? (ed.initial === undefined ? {} : ed.initial)
  const commitVideoEdit = (value: Json, strictDuration: boolean): void => {
    if (!live || videoContext?.editDisabledReason) return
    if (ed.tab.execution || ed.tab.store.revision !== videoRevision) { close(); return }
    if (ed.target.kind === 'valueSource') {
      if (jsonSameValue(value, videoInitial)) close()
      else commitEditorValue(value)
      return
    }
    const graphId = ed.target.familyOwner?.graphId ?? ed.graphId
    const nodeId = ed.target.familyOwner?.nodeId ?? ed.target.nodeId
    const inputId = ed.target.familyOwner?.valueKey ?? ed.target.valueKey
    const invocations: CommandInvocation[] = jsonSameValue(value, videoInitial) ? [] : [{
      command: 'node.setValue',
      params: { graphId, nodeId, inputId, value },
    }]
    if (videoContext?.strictDuration !== undefined && videoContext.strictDisabledReason === undefined && strictDuration !== videoContext.strictDuration) {
      invocations.push({
        command: 'node.setValue',
        params: { graphId, nodeId, inputId: 'strict_duration', value: strictDuration },
      })
    }
    close()
    if (invocations.length === 0) return
    const action: CommandInvocation = invocations.length === 1
      ? invocations[0]!
      : { command: 'batch', params: { invocations } } as unknown as CommandInvocation
    props.app.dispatchTo(ed.tab, withMaterializeFrames(graphId, nodeId, ed.target.materialize, action))
  }

  const commitEditor = (raw: Json, closeOnInvalid = false, skipUnchanged = false): void => {
    if (!live) return // blur-on-detach must not resurrect a closed editor
    setWidgetEditorError(undefined)
    let value: Json = raw
    if (ed.spec === undefined) {
      // Raw JSON fallback: unparseable text never commits (the stored value
      // is retained verbatim - P2 - so a typo cannot corrupt it).
      try {
        value = JSON.parse(String(raw)) as Json
      } catch (error) {
        if (closeOnInvalid) {
          close()
          return
        }
        setWidgetEditorError(error instanceof Error ? error.message : 'Invalid JSON')
        return
      }
    } else if (ed.spec.widgetType === 'INT') {
      const parsed = parseNumericCommit(String(raw), 'INT')
      if (!parsed.ok) {
        if (closeOnInvalid) {
          close()
          return
        }
        setWidgetEditorError(parsed.error)
        return
      }
      value = parsed.value
    } else if (ed.spec.widgetType === 'FLOAT') {
      const parsed = parseNumericCommit(String(raw), 'FLOAT', ed.spec.options['round'])
      if (!parsed.ok) {
        if (closeOnInvalid) {
          close()
          return
        }
        setWidgetEditorError(parsed.error)
        return
      }
      const min = ed.spec.options['min']
      const max = ed.spec.options['max']
      value = Math.min(
        typeof max === 'number' && Number.isFinite(max) ? max : Infinity,
        Math.max(typeof min === 'number' && Number.isFinite(min) ? min : -Infinity, parsed.value),
      )
    }
    if (ed.spec !== undefined) {
      const error = widgetCommitError(props.app.widgetRegistryForTab(ed.tab).kind(ed.spec.widgetType), value, ed.spec)
      if (error !== undefined) {
        if (closeOnInvalid) {
          close()
          return
        }
        setWidgetEditorError(error)
        return
      }
    }
    if (skipUnchanged) {
      let initial = ed.initial
      if (ed.spec === undefined) {
        try {
          initial = JSON.parse(String(ed.initial)) as Json
        } catch {
          initial = undefined
        }
      }
      if (jsonSameValue(value, initial)) {
        close()
        return
      }
    }
    if (ed.target.kind === 'valueSource') {
      commitEditorValue(value)
      return
    }
    // DynamicCombo selector rows switch branches through dedicated dynamic
    // state (single home), never node.values.
    if (ed.target.selector !== undefined) {
      const owner = ed.target.selector.owner
      props.app.dispatchTo(
        ed.tab,
        owner !== undefined ? withMaterializeFrames(owner.graphId, owner.nodeId, ed.target.materialize, {
          command: 'dynamic.selectOption',
          params: { graphId: owner.graphId, nodeId: owner.nodeId, construct: owner.construct, option: String(value), ...(owner.ancestors !== undefined ? { ancestors: owner.ancestors } : {}) },
        }) : withMaterializeFrames(ed.graphId, ed.target.nodeId, ed.target.materialize, {
          command: 'dynamic.selectOption',
          params: {
            graphId: ed.graphId,
            nodeId: ed.target.nodeId,
            construct: ed.target.selector.construct,
            ...(ed.target.selector.ancestors.length > 0
              ? { ancestors: ed.target.selector.ancestors.map((a) => ({ construct: a.construct, member: a.member })) }
              : {}),
            option: String(value),
          },
        }),
      )
      close()
      return
    }
    commitEditorValue(value)
  }

  // -- color editor -----------------------------------------------------------
  const [colorText, setColorText] = createSolidSignal('#ffffff')
  const [colorHue, setColorHue] = createSolidSignal(0)
  const [colorError, setColorError] = createSolidSignal<string | undefined>(undefined)

  if (ed.spec?.widgetType === 'COLOR') {
    const initial = typeof ed.initial === 'string'
      ? ed.initial
      : typeof ed.spec.default === 'string'
        ? ed.spec.default
        : '#ffffff'
    setColorText(initial)
    setColorHue(hexToHsv(initial)?.h ?? 0)
  }

  const commitColor = (): void => {
    if (ed.spec?.widgetType !== 'COLOR') return
    const diagnostics = colorKind.validate(colorText(), ed.spec)
    if (diagnostics.length > 0) {
      setColorError(diagnostics[0]!.message)
      return
    }
    commitEditorValue(colorText())
  }

  const pickHsv = (h: number, s: number, v: number): void => {
    setColorHue(h)
    setColorText(hsvToHex(h, s, v, colorText()))
    setColorError(undefined)
  }

  const pickSaturationValue = (event: PointerEvent): void => {
    const el = event.currentTarget as HTMLElement
    if (event.type === 'pointerdown') el.setPointerCapture(event.pointerId)
    if (event.type !== 'pointerdown' && !el.hasPointerCapture(event.pointerId)) return
    event.preventDefault()
    const rect = el.getBoundingClientRect()
    pickHsv(colorHue(), Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / rect.height)))
  }

  const pickHue = (event: PointerEvent): void => {
    const el = event.currentTarget as HTMLElement
    if (event.type === 'pointerdown') el.setPointerCapture(event.pointerId)
    if (event.type !== 'pointerdown' && !el.hasPointerCapture(event.pointerId)) return
    event.preventDefault()
    const rect = el.getBoundingClientRect()
    const hsv = hexToHsv(colorText()) ?? { h: colorHue(), s: 0, v: 1 }
    pickHsv(Math.max(0, Math.min(359.999, ((event.clientX - rect.left) / rect.width) * 360)), hsv.s, hsv.v)
  }

  // -- combo options ----------------------------------------------------------
  const [comboQuery, setComboQuery] = createSolidSignal('')
  const [comboIndex, setComboIndex] = createSolidSignal(0)
  const [comboFolder, setComboFolder] = createSolidSignal<readonly string[]>([])
  const [multiComboValues, setMultiComboValues] = createSolidSignal<string[]>(
    ed.spec?.widgetType === 'MULTI_COMBO' && Array.isArray(ed.initial) && ed.initial.every((value) => typeof value === 'string')
      ? [...ed.initial]
      : [],
  )
  let multiComboDraftGeneration = 0
  const mutateMultiComboValues = (update: (values: string[]) => string[]): void => {
    multiComboDraftGeneration += 1
    setMultiComboValues(update)
  }
  let comboHighlightSource: ComboHighlightSource = 'programmatic'
  let comboEl: HTMLDivElement | undefined

  // Specs with a declarative `remote` source fetch their options through the
  // scoped client when the editor opens (cached + deduped there, so N nodes
  // sharing one source cause one request). Static options render immediately;
  // remote values replace them when they land.
  interface RemoteSource {
    readonly client: ReturnType<AppState['backendForTab']>['scopedClient']
    readonly route: string
    readonly authority: number
  }
  type RemoteState =
    | { readonly state: 'loading'; readonly source: RemoteSource }
    | { readonly state: 'ready'; readonly source: RemoteSource; readonly options: readonly { value: string; label: string }[] }
    | { readonly state: 'stale'; readonly source: RemoteSource; readonly options: readonly { value: string; label: string }[]; readonly message: string }
    | { readonly state: 'unavailable'; readonly source: RemoteSource; readonly message: string }
  const [remoteCombo, setRemoteCombo] = createSolidSignal<RemoteState | undefined>(undefined)
  // Guards against a slow response for an earlier fetch landing after a
  // refresh: only the newest request may publish its result.
  let remoteRequestToken = 0
  let remoteRequestAbort: AbortController | undefined
  onCleanup(() => remoteRequestAbort?.abort())

  const remoteComboState = (): RemoteState | undefined => {
    backendTick()
    const state = remoteCombo()
    const route = ed.spec?.remote?.route
    if (!state || !route) return undefined
    const client = props.app.backendForTab(ed.tab).scopedClient
    return state.source.client === client &&
      state.source.route === route &&
      state.source.authority === client.remoteChoiceAuthority()
      ? state
      : undefined
  }

  const loadRemoteOptions = (spec: WidgetSpec | undefined, refresh = false): void => {
    const token = ++remoteRequestToken
    remoteRequestAbort?.abort()
    const abort = new AbortController()
    remoteRequestAbort = abort
    const remote = spec?.remote
    if (!remote) {
      comboHighlightSource = 'programmatic'
      setRemoteCombo(undefined)
      return
    }
    const previous = remoteComboState()
    const policyControl = refresh ? remote.controlAfterRefresh : undefined
    const advances = policyControl === undefined && remoteComboRefreshCanAdvance(refresh, previous?.state)
    const refreshPlan = advances ? props.app.prepareComboRefresh(ed.tab, remote.route) : undefined
    const policyTarget = policyControl !== undefined && ed.target.kind === 'input'
      ? {
          graphId: ed.target.familyOwner?.graphId ?? ed.graphId,
          nodeId: ed.target.familyOwner?.nodeId ?? ed.target.nodeId,
          inputId: ed.target.familyOwner?.valueKey ?? ed.target.valueKey,
        }
      : undefined
    const policyExpected = policyTarget
      ? ed.tab.store.doc.graphs[policyTarget.graphId]?.nodes[policyTarget.nodeId]?.values[policyTarget.inputId]
      : undefined
    const policyGeneration = policyTarget
      ? props.app.widgetValueMutationGeneration(
          ed.tab, policyTarget.graphId, policyTarget.nodeId, policyTarget.inputId,
        )
      : undefined
    const policyMultiDraftGeneration = policyControl !== undefined && spec?.widgetType === 'MULTI_COMBO'
      ? multiComboDraftGeneration
      : undefined
    const client = refreshPlan?.backend.scopedClient ?? props.app.backendForTab(ed.tab).scopedClient
    const source = { client, route: remote.route, authority: client.remoteChoiceAuthority() }
    comboHighlightSource = 'programmatic'
    if (!refresh || (previous?.state !== 'ready' && previous?.state !== 'stale')) {
      setRemoteCombo({ state: 'loading', source })
    }
    // Remote options come from the editing tab's backend: model lists etc.
    // differ per server. The editor only ever opens on the active tab.
    client
      .remoteChoices(remote.route, {
        refresh,
        signal: abort.signal,
        ...(remote.timeoutMs !== undefined ? { timeoutMs: remote.timeoutMs } : {}),
        ...(remote.maxRetries !== undefined ? { maxRetries: remote.maxRetries } : {}),
        ...(remote.refreshMs !== undefined ? { refreshMs: remote.refreshMs } : {}),
      })
      .then((result) => {
        if (!live || token !== remoteRequestToken) return
        if (client.remoteChoiceAuthority() !== source.authority) return
        const options = result.map((value) => ({ value, label: value }))
        comboHighlightSource = 'programmatic'
        setRemoteCombo({ state: 'ready', source, options })
        if (policyControl !== undefined && ed.target.kind === 'input' && policyTarget && result.length > 0) {
          const current = ed.tab.store.doc.graphs[policyTarget.graphId]?.nodes[policyTarget.nodeId]?.values[policyTarget.inputId]
          const generation = props.app.widgetValueMutationGeneration(
            ed.tab, policyTarget.graphId, policyTarget.nodeId, policyTarget.inputId,
          )
          const multiDraftUnchanged = policyMultiDraftGeneration === undefined ||
            multiComboDraftGeneration === policyMultiDraftGeneration
          if (current === policyExpected && generation === policyGeneration && multiDraftUnchanged) {
            props.app.dispatchTo(ed.tab, withMaterializeFrames(
              policyTarget.graphId,
              policyTarget.nodeId,
              ed.target.materialize,
              {
              command: 'node.setValue',
              params: {
                graphId: policyTarget.graphId,
                nodeId: policyTarget.nodeId,
                inputId: policyTarget.inputId,
                value: spec?.widgetType === 'MULTI_COMBO'
                  ? [policyControl === 'first' ? result[0]! : result[result.length - 1]!]
                  : policyControl === 'first' ? result[0]! : result[result.length - 1]!,
              },
              },
            ))
            if (spec?.widgetType === 'MULTI_COMBO') close()
          }
        } else if (refresh) {
          props.app.completeComboRefresh(refreshPlan, options.map((option) => option.value))
        }
      })
      .catch((e: unknown) => {
        if (!live || token !== remoteRequestToken) return
        const message = e instanceof Error ? e.message : String(e)
        comboHighlightSource = 'programmatic'
        setRemoteCombo(previous?.state === 'ready' || previous?.state === 'stale'
          ? { state: 'stale', source, options: previous.options, message }
          : { state: 'unavailable', source, message })
      })
  }

  const editorComboOptions = (spec: WidgetSpec | undefined): readonly ComboOption[] => {
    const remote = remoteComboState()
    const available = remote?.state === 'ready' || remote?.state === 'stale'
      ? remote.options
      : spec ? comboOptions(spec) : []
    if (!spec?.remote || typeof ed.initial !== 'string' || available.some((option) => option.value === ed.initial)) {
      return available
    }
    return [{ value: ed.initial, label: ed.initial }, ...available]
  }

  const visibleComboEntries = createMemo(() =>
    comboMenuEntries(editorComboOptions(ed.spec), comboFolder(), comboQuery()))

  createEffect(() => {
    const index = comboIndex()
    const clamped = clampComboHighlight(index, visibleComboEntries().length)
    if (clamped === index) return
    comboHighlightSource = 'programmatic'
    setComboIndex(clamped)
  })

  // Sticky block-anchored window: while the entry total is unchanged and the
  // highlight stays inside the current window, the window is reused as-is, so
  // neither arrow presses inside it nor pointer hover over rendered rows can
  // shift rows under a stationary pointer. Paging, Home/End, and arrows that
  // leave the window re-anchor via comboRenderWindow. hiddenAfter is part of
  // the equality comparison because filtering can change the total while
  // leaving start and end untouched.
  const comboWindow = createMemo<ComboRenderWindow, undefined>(
    (previous) => {
      const total = visibleComboEntries().length
      const index = comboIndex()
      if (previous !== undefined && previous.end + previous.hiddenAfter === total
        && index >= previous.start && index < previous.end) {
        return previous
      }
      return comboRenderWindow(total, index)
    },
    undefined,
    { equals: (a, b) => a.start === b.start && a.end === b.end && a.hiddenAfter === b.hiddenAfter },
  )
  const renderedComboEntries = createMemo(() => visibleComboEntries().slice(comboWindow().start, comboWindow().end))

  if (ed.spec?.widgetType === 'COMBO' || ed.spec?.widgetType === 'MULTI_COMBO') {
    loadRemoteOptions(ed.spec)
    const options = comboOptions(ed.spec)
    const selected = options.find((option) => option.value === ed.initial)
    const rootFolder = selected?.folder?.split('/')[0]
    const initialIndex = comboMenuEntries(options, [], '').findIndex((entry) =>
      entry.kind === 'option' ? entry.option.value === ed.initial : entry.label === rootFolder,
    )
    setComboIndex(Math.max(0, initialIndex))
  }

  let remoteInitialHighlightApplied = false
  /** The first ready remote list arrives after open, so only then can the current value row be selected. */
  createEffect(() => {
    const remote = remoteComboState()
    if ((ed.spec?.widgetType !== 'COMBO' && ed.spec?.widgetType !== 'MULTI_COMBO') || remote?.state !== 'ready' || remoteInitialHighlightApplied) return
    remoteInitialHighlightApplied = true
    if (comboQuery() !== '') return
    const current = remote.options.findIndex((option) => option.value === String(ed.initial))
    comboHighlightSource = 'programmatic'
    setComboIndex(Math.max(0, current))
  })

  /**
   * Keep initial, remote-arrival, and keyboard selection visible. Pointer
   * hover must not scroll: moving a different row under a stationary pointer
   * would fire mouseenter again and turn a single hover into runaway scrolling.
   */
  createEffect(() => {
    comboQuery()
    comboFolder()
    comboIndex()
    remoteComboState()
    const source = comboHighlightSource
    queueMicrotask(() => {
      scrollComboHighlightIntoView(comboEl, source)
    })
  })

  const onComboKeyDown = (event: KeyboardEvent): void => {
    const entries = visibleComboEntries()
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      comboHighlightSource = 'keyboard'
      setComboIndex((index) => clampComboHighlight(index + 1, entries.length))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      comboHighlightSource = 'keyboard'
      setComboIndex((index) => clampComboHighlight(index - 1, entries.length))
    } else if (event.key === 'Home') {
      event.preventDefault()
      comboHighlightSource = 'keyboard'
      setComboIndex(clampComboHighlight(0, entries.length))
    } else if (event.key === 'End') {
      event.preventDefault()
      comboHighlightSource = 'keyboard'
      setComboIndex(clampComboHighlight(entries.length - 1, entries.length))
    } else if (event.key === 'Enter') {
      if (event.isComposing) return
      event.preventDefault()
      const entry = entries[clampComboHighlight(comboIndex(), entries.length)]
      if (entry?.kind === 'folder') {
        comboHighlightSource = 'programmatic'
        setComboFolder(entry.path)
        setComboIndex(0)
      } else if (entry?.kind === 'option') {
        if (ed.spec?.widgetType === 'MULTI_COMBO') mutateMultiComboValues((values) => [...values, String(entry.option.value)])
        else commitEditor(entry.option.value)
      }
    } else if (event.key === 'Backspace' && comboQuery() === '' && comboFolder().length > 0) {
      event.preventDefault()
      comboHighlightSource = 'programmatic'
      setComboFolder((folder) => folder.slice(0, -1))
      setComboIndex(0)
    }
  }

  const openComboFolder = (path: readonly string[]): void => {
    comboHighlightSource = 'programmatic'
    setComboFolder(path)
    setComboIndex(0)
  }

  const multiComboLabel = (value: string): string =>
    editorComboOptions(ed.spec).find((option) => option.value === value)?.label ?? value

  const ComboFolderNavigation = () => (
    <Show when={comboFolder().length > 0}>
      <div class="combo-folder-navigation" data-testid="combo-folder-navigation">
        <button
          type="button"
          aria-label="Back to parent folder"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => openComboFolder(comboFolder().slice(0, -1))}
        >
          <Icon icon={ChevronLeft} /> Back
        </button>
        <span>{comboFolder().join(' / ')}</span>
      </div>
    </Show>
  )

  /** Jump the highlight across a window boundary; the window follows it. */
  const pageComboTo = (index: number): void => {
    comboHighlightSource = 'keyboard'
    setComboIndex(clampComboHighlight(index, visibleComboEntries().length))
  }

  const ComboMenuRows = (menuProps: { readonly multi: boolean }) => (
    <>
      <Show when={comboWindow().hiddenBefore > 0}>
        <button
          type="button"
          class="combo-status combo-page"
          data-testid="combo-earlier"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => pageComboTo(comboWindow().start - 1)}
        >
          {`${comboWindow().hiddenBefore} earlier options`}
        </button>
      </Show>
      <For each={renderedComboEntries()} fallback={<div class="combo-status">No matching options</div>}>
      {(entry, index) => (
        <button
          type="button"
          classList={{
            'combo-menu-entry': true,
            'combo-folder': entry.kind === 'folder',
            'combo-option': entry.kind === 'option',
            active: comboWindow().start + index() === comboIndex(),
          }}
          data-testid={menuProps.multi ? entry.kind === 'folder' ? 'multi-combo-folder' : 'multi-combo-option' : entry.kind === 'folder' ? 'combo-folder' : 'combo-option'}
          role="option"
          aria-selected={entry.kind === 'option' && comboWindow().start + index() === comboIndex()}
          aria-label={entry.kind === 'folder' ? `Open folder ${entry.label}` : undefined}
          onMouseEnter={() => {
            comboHighlightSource = 'pointer'
            setComboIndex(comboWindow().start + index())
          }}
          onMouseDown={(event) => {
            event.preventDefault()
          }}
          onClick={() => {
            if (entry.kind === 'folder') {
              openComboFolder(entry.path)
            } else if (menuProps.multi) {
              mutateMultiComboValues((values) => [...values, String(entry.option.value)])
            } else {
              commitEditor(entry.option.value)
            }
          }}
        >
          <Show when={entry.kind === 'folder'} fallback={
            <span class="combo-option-copy">
              <strong>{entry.kind === 'option' ? entry.option.label : ''}</strong>
              <Show when={entry.kind === 'option' && (entry.option.info !== undefined || (comboQuery().trim() !== '' && entry.option.folder !== undefined))}>
                <span class="combo-option-info">
                  {entry.kind === 'option'
                    ? [comboQuery().trim() !== '' ? entry.option.folder : undefined, entry.option.info].filter(Boolean).join(' - ')
                    : ''}
                </span>
              </Show>
            </span>
          }>
            <Icon icon={Folder} />
            <span>{entry.kind === 'folder' ? entry.label : ''}</span>
            <Icon icon={ChevronRight} />
          </Show>
        </button>
      )}
      </For>
      <Show when={comboWindow().hiddenAfter > 0}>
        <button
          type="button"
          class="combo-status combo-page"
          data-testid="combo-more"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => pageComboTo(comboWindow().end)}
        >
          {`${comboWindow().hiddenAfter} more options - type to narrow`}
        </button>
      </Show>
    </>
  )

  const multiComboOovSeverity = (value: string): 'error' | 'warning' | undefined => {
    if (ed.spec?.widgetType !== 'MULTI_COMBO') return undefined
    const remote = remoteComboState()
    const options = remote?.state === 'ready' || remote?.state === 'stale'
      ? remote.options.map((option) => option.value)
      : comboOptions(ed.spec).map((option) => option.value)
    if (options.includes(value)) return undefined
    return ed.spec.remote ? 'warning' : 'error'
  }

  // -- asset editor -----------------------------------------------------------
  // The tab owns backend affinity, so asset bytes use that tab's native
  // connection exactly as remote combos use its scoped client. Never fall
  // back to the default backend: identical digests are not proof that two
  // configured servers share a vault.
  const [assetPreview, setAssetPreview] = createSolidSignal<AssetPreview | undefined>(undefined)
  const [assetPreviewFailed, setAssetPreviewFailed] = createSolidSignal(false)
  /** Natural pixel size of the previewed media, measured on load; feeds the
   * caption under the preview. */
  const [assetPreviewDims, setAssetPreviewDims] = createSolidSignal<{ readonly width: number; readonly height: number } | undefined>(undefined)
  /** The browsed item behind the staged selection, when the pick came from
   * the collection browser: feeds the Details disclosure. Uploads and
   * reopened stored values have only an AssetRef, so this stays unset. */
  const [assetSelectedItem, setAssetSelectedItem] = createSolidSignal<AssetBrowserItem | undefined>(undefined)
  /** The model variant behind the staged selection, when the pick came
   * from the logical model picker: feeds the Details disclosure. */
  const [assetSelectedModel, setAssetSelectedModel] = createSolidSignal<LogicalModelPickDetail | undefined>(undefined)
  const [assetError, setAssetError] = createSolidSignal<string | undefined>(undefined)
  const [assetUploading, setAssetUploading] = createSolidSignal(false)
  let assetUploadInput: HTMLInputElement | undefined
  let assetUploadTrigger: HTMLButtonElement | undefined
  const restoreAssetUploadFocus = (): void => {
    queueMicrotask(() => {
      if (live) assetUploadTrigger?.focus()
    })
  }
  // The pending batch's abort handle. Cancel stays USABLE during an upload
  // and aborts through this - without it a server that never answers the
  // POST would leave the dismissal-locked editor with no recovery path.
  let assetUploadAbort: AbortController | undefined
  // The editor does not only close through Cancel: a document/schema/scene
  // rebuild unmounts it from the host. Cleanup must abort the owned batch
  // too, or a stalled POST would outlive its editor indefinitely (the live
  // guard only suppresses the commit, not the network operation).
  onCleanup(() => assetUploadAbort?.abort())
  // undefined = discovery not settled; [] = settled with nothing browsable.
  const [assetSources, setAssetSources] = createSolidSignal<readonly AssetSourceAdapter[] | undefined>(undefined)
  const [assetSourcesError, setAssetSourcesError] = createSolidSignal<string | undefined>(undefined)
  const [logicalModels, setLogicalModels] = createSolidSignal<readonly LogicalModel[] | undefined>(undefined)
  const [logicalModelsError, setLogicalModelsError] = createSolidSignal<string | undefined>(undefined)
  const [logicalModelsLoading, setLogicalModelsLoading] = createSolidSignal(false)
  const unresolvedAsset = typeof ed.initial === 'string' ? ed.initial : undefined
  const [assetMatchCandidates, setAssetMatchCandidates] = createSolidSignal<readonly AssetGuessCandidate[]>([])
  const [assetMatchPending, setAssetMatchPending] = createSolidSignal(false)
  const [assetMatchError, setAssetMatchError] = createSolidSignal<string | undefined>(undefined)
  const assetAccept = (): readonly string[] => {
    const accept = ed.spec?.options['accept']
    return Array.isArray(accept) ? accept.filter((value): value is string => typeof value === 'string') : []
  }
  // The wire decoder emits the semantic kind as top-level WidgetSpec.kind.
  // A homogeneous media MIME list supplies the same scope when an older
  // schema omitted it; model kinds are never inferred from names or paths.
  const assetKind = (): string | undefined => {
    const kind = ed.spec?.kind
    return typeof kind === 'string' && kind !== '' ? kind : undefined
  }
  const assetBrowseKind = (): string | undefined => assetKind() ?? mediaKindForAccept(assetAccept())
  const assetVocabulary = (): AssetPickerVocabulary =>
    assetBrowseKind()?.startsWith('model/') === true
      ? MODEL_ASSET_VOCABULARY
      : assetBrowseKind() === 'data/latent' ? LATENT_ASSET_VOCABULARY : GENERIC_ASSET_VOCABULARY
  // Multi-select (typed-assets pin (5)): the declared outer type gates it -
  // list<asset<T>> / list<dinkster.asset> pick N descriptors committed as ONE
  // array value, and a scalar concrete T with a registered batch-merge
  // provider (mergeableTypes membership) picks N descriptors the engine
  // decodes-each-then-merges into ONE batched T. Every other declaration
  // stays single-select: a pick stages one descriptor and the footer Apply
  // commits it. asset<list<T>> stays single-select (decoder multi-ness).
  const assetMulti = ed.spec?.widgetType === 'ASSET' &&
    ed.declaredType !== undefined && assetMultiSelect(ed.declaredType, ed.mergeableTypes)
  const sourceUpload = ed.spec?.widgetType === 'ASSET' && ed.spec.allowUpload === true &&
    ed.sourceFilename !== undefined
  const uploadKind = ed.sourceFilename?.kind ?? assetBrowseKind()
  const classifiedMediaKind = ed.spec?.widgetType === 'ASSET' &&
    (uploadKind === 'media/image' || uploadKind === 'media/audio' || uploadKind === 'media/video')
    ? uploadKind
    : undefined
  const classifiedLatent = ed.spec?.widgetType === 'ASSET' && uploadKind === 'data/latent'
  const assetUploadMaxBytes = classifiedMediaKind === 'media/image'
    ? IMAGE_UPLOAD_MAX_BYTES
    : classifiedMediaKind !== undefined
      ? MEDIA_UPLOAD_MAX_BYTES
      : classifiedLatent ? LATENT_UPLOAD_MAX_BYTES : GENERIC_UPLOAD_MAX_BYTES
  // Display copy exists only for kinds with a deliberate, user-facing limit.
  // Model kinds fall into the generic enforcement bucket, whose 16 MiB bound
  // is not an authoritative model limit, so they render no limit copy
  // (enforcement still applies through assetUploadMaxBytes).
  const assetUploadLimitLabel = classifiedMediaKind === 'media/image'
    ? '256 MiB per file'
    : classifiedMediaKind !== undefined || classifiedLatent
      ? '1 GiB per file'
      : uploadKind?.startsWith('model/') === true ? undefined : '16 MiB per file'
  // The SCALAR MERGE arm specifically (multi-select whose declaration is
  // NOT list-outer): an empty selection cannot commit `[]` there - the
  // declared type is scalar T, and a bare empty array would compile as raw
  // junk the merge provider rejects (zero batches). Applying empty in this
  // mode commits null (unset), mirroring the scalar clear semantics;
  // list-outer declarations keep the pinned `[]` commit.
  const assetScalarMerge = assetMulti &&
    ed.declaredType !== undefined && !assetMultiSelect(ed.declaredType)
  const [assetSelection, setAssetSelection] = createSolidSignal<readonly AssetRef[]>(
    isAssetRefArray(ed.initial) ? ed.initial : isAssetRef(ed.initial) ? [ed.initial] : [],
  )
  const sameAssetRef = (a: AssetRef, b: AssetRef): boolean =>
    a.digest === b.digest && a.virtualPath === b.virtualPath
  /** Append in selection order; picking an already-selected asset removes it. */
  const toggleAssetSelection = (ref: AssetRef): void => {
    setAssetSelection((current) =>
      current.some((r) => sameAssetRef(r, ref))
        ? current.filter((r) => !sameAssetRef(r, ref))
        : [...current, ref],
    )
  }
  const removeAssetSelection = (ref: AssetRef, index: number): void => {
    if (!sourceUpload) {
      toggleAssetSelection(ref)
      return
    }
    setAssetSelection((current) => [...current.slice(0, index), ...current.slice(index + 1)])
  }
  /** Generic picks deduplicate; source lists preserve upload order and duplicates. */
  const addAssetSelection = (ref: AssetRef): void => {
    setAssetSelection((current) =>
      sourceUpload ? [...current, ref] : current.some((r) => sameAssetRef(r, ref)) ? current : [...current, ref],
    )
  }
  let ownedAssetUrl: string | undefined
  let assetPreviewRequest = 0
  const replaceAssetPreview = (preview: AssetPreview, ownedUrl?: string): void => {
    if (ownedAssetUrl !== undefined && ownedAssetUrl !== ownedUrl) URL.revokeObjectURL(ownedAssetUrl)
    ownedAssetUrl = ownedUrl
    setAssetPreviewFailed(false)
    setAssetPreviewDims(undefined)
    setAssetPreview(preview)
  }
  /** Drop the staged preview: cancels any in-flight preview fetch and
   * releases the owned object URL. */
  const clearAssetPreview = (): void => {
    assetPreviewRequest += 1
    if (ownedAssetUrl !== undefined) URL.revokeObjectURL(ownedAssetUrl)
    ownedAssetUrl = undefined
    setAssetPreviewFailed(false)
    setAssetPreviewDims(undefined)
    setAssetPreview(undefined)
  }
  const publishLocalAssetPreview = (file: File): void => {
    const model3dMime = model3dMimeFor(file.name, file.type)
    const kind = file.type.startsWith('image/')
      ? 'image'
      : file.type.startsWith('video/')
        ? 'video'
        : model3dMime !== undefined ? 'model3d' : undefined
    if (kind === undefined) return
    assetPreviewRequest += 1
    const url = URL.createObjectURL(file)
    replaceAssetPreview({ kind, src: url, name: file.name, ...(model3dMime === undefined ? {} : { mime: model3dMime }) }, url)
  }
  const publishAssetRefPreview = async (ref: AssetRef): Promise<void> => {
    const kind = ref.mediaType.startsWith('image/')
      ? 'image'
      : ref.mediaType.startsWith('video/')
        ? 'video'
        : isModel3dMime(ref.mediaType) ? 'model3d' : undefined
    if (kind === undefined) {
      clearAssetPreview()
      return
    }
    const backend = props.app.backendForTab(ed.tab)
    if (backend.protocol !== 'dinkster') {
      clearAssetPreview()
      setAssetError('Asset previews require a native Dinkster backend')
      return
    }
    const request = ++assetPreviewRequest
    if (kind === 'video' || kind === 'model3d') {
      replaceAssetPreview({
        kind,
        src: backend.connection.assetUrl(ref.digest),
        name: ref.name,
        ...(kind === 'model3d' ? { mime: ref.mediaType } : {}),
      })
      return
    }
    try {
      const bytes = await backend.connection.fetchAssetBytes(ref.digest)
      if (!live || request !== assetPreviewRequest || bytes === undefined) return
      const url = URL.createObjectURL(new Blob([bytes], { type: ref.mediaType }))
      replaceAssetPreview({ kind, src: url, name: ref.name }, url)
    } catch (error) {
      if (live && request === assetPreviewRequest) setAssetError(error instanceof Error ? error.message : String(error))
    }
  }
  onCleanup(() => {
    if (ownedAssetUrl) URL.revokeObjectURL(ownedAssetUrl)
  })

  const usesLogicalModelSource = (): boolean => assetBrowseKind()?.startsWith('model/') === true
  let logicalModelLoad = 0
  let logicalModelAbort: AbortController | undefined
  onCleanup(() => logicalModelAbort?.abort())
  const loadLogicalModels = async (sources: readonly AssetSourceAdapter[]): Promise<void> => {
    const kind = assetBrowseKind()
    if (!usesLogicalModelSource() || kind === undefined) return
    const load = ++logicalModelLoad
    logicalModelAbort?.abort()
    const abort = new AbortController()
    logicalModelAbort = abort
    setLogicalModelsLoading(true)
    setLogicalModelsError(undefined)
    try {
      const localAdapter = await localMountScanAdapter(sources, kind, assetAccept())
      const candidateItems: CandidateV1[] = []
      let candidateError: string | undefined
      if (props.federatedAssets !== undefined && ed.target.kind === 'input') {
        const targetGraphId = ed.target.familyOwner?.graphId ?? ed.graphId
        const targetNodeId = ed.target.familyOwner?.nodeId ?? ed.target.nodeId
        const inputId = ed.target.familyOwner?.valueKey ?? ed.target.valueKey
        const node = ed.tab.store.doc.graphs[targetGraphId]?.nodes[targetNodeId]
        if (node !== undefined) {
          const client = new AssetDtoV1Client('', props.federatedAssets)
          try {
            let cursor: string | undefined
            do {
              const page = await client.candidates({
                context: {
                  assetKind: kind,
                  schema: { nodeType: node.type, inputId },
                  accept: assetAccept(),
                },
                ...(cursor !== undefined ? { cursor } : {}),
                limit: 100,
              }, abort.signal)
              if (!live || load !== logicalModelLoad) return
              candidateItems.push(...page.items)
              cursor = page.nextCursor
            } while (cursor !== undefined)
          } catch (error) {
            if (abort.signal.aborted) return
            candidateError = error instanceof Error ? error.message : String(error)
          }
        }
      }
      const result = ingestLogicalModels([
        ...(candidateItems.length > 0 ? [candidateLogicalModelAdapter(candidateItems)] : []),
        localAdapter,
      ])
      if (!live || load !== logicalModelLoad) return
      setLogicalModels(result.models)
      const errors = [...(candidateError !== undefined ? [candidateError] : []), ...result.diagnostics.map((entry) => entry.message)]
      if (errors.length > 0) setLogicalModelsError(errors.join('; '))
    } catch (error) {
      if (live && load === logicalModelLoad) setLogicalModelsError(error instanceof Error ? error.message : String(error))
    } finally {
      if (live && load === logicalModelLoad) setLogicalModelsLoading(false)
    }
  }

  if (ed.spec?.widgetType === 'ASSET') {
    const backend = props.app.backendForTab(ed.tab)
    const asset = isAssetRef(ed.initial) ? ed.initial : isAssetRefArray(ed.initial) ? ed.initial[0] : undefined
    if (asset !== undefined) void publishAssetRefPreview(asset)
    if (backend.protocol !== 'dinkster') {
      setAssetSourcesError('Asset browsing requires a native Dinkster backend')
    } else {
      void mountAssetSources(backend.connection, assetBrowseKind()).then((sources) => {
        if (!live) return
        setAssetSources(sources)
        void loadLogicalModels(sources)
      }).catch((reason: unknown) => { if (live) setAssetSourcesError(reason instanceof Error ? reason.message : String(reason)) })
    }
  }

  /**
   * Upload one file and stage/commit it. Returns false when the batch must
   * stop: a validation or upload failure (its error must stay visible - a
   * later success would clear it) or an editor that closed mid-flight.
   * The CALLER owns the assetUploading flag so a multi-file batch stays
   * busy end to end instead of flickering between files.
   */
  const pickAsset = async (file: File): Promise<boolean> => {
    if (ed.spec?.widgetType !== 'ASSET') return false
    const accept = Array.isArray(ed.spec.options['accept'])
      ? ed.spec.options['accept'].filter((value): value is string => typeof value === 'string')
      : []
    // Browsers do not reliably assign a MIME type to .latent or .safetensors;
    // the classified upload route validates their bytes authoritatively.
    // 3D files (.glb, .ply) get their type inferred from the name so accept
    // validation and the committed ref carry a previewable media type.
    const effectiveType = model3dMimeFor(file.name, file.type) ?? file.type
    if (accept.length > 0 && !mediaAcceptsFile(accept, effectiveType) && !(classifiedLatent && file.type === '')) {
      setAssetError(`Unsupported file type: ${effectiveType || 'unknown'}`)
      return false
    }
    if (file.size > assetUploadMaxBytes) {
      setAssetError(`File exceeds the ${assetUploadLimitLabel?.replace(' per file', '') ?? formatSize(assetUploadMaxBytes)} upload limit`)
      return false
    }
    const backend = props.app.backendForTab(ed.tab)
    if (backend.protocol !== 'dinkster') {
      setAssetError('Asset uploads require a native Dinkster backend')
      return false
    }
    setAssetError(undefined)
    publishLocalAssetPreview(file)
    try {
      const canonical = classifiedMediaKind !== undefined
        ? await backend.connection.uploadMediaAsset(file, {
            scope: 'local',
            kind: classifiedMediaKind,
            name: mediaUploadName(file.name),
            ...(assetUploadAbort !== undefined ? { signal: assetUploadAbort.signal } : {}),
          })
        : classifiedLatent
          ? await backend.connection.uploadLatentAsset(file, {
              scope: 'local',
              name: mediaUploadName(file.name),
              ...(assetUploadAbort !== undefined ? { signal: assetUploadAbort.signal } : {}),
            })
        : undefined
      const digest = canonical === undefined
        ? await backend.connection.uploadAsset(file, assetUploadAbort?.signal)
        : canonical.digest
      if (!live) return false
      const ref: AssetRef = canonical ?? {
          digest,
          name: file.name,
          size: file.size,
          mediaType: effectiveType,
          virtualPath: '',
        }
      // Uploads stage into the selection like browsed picks; the footer
      // Apply button commits. The local file preview is already showing.
      if (assetMulti) {
        addAssetSelection(ref)
        void publishAssetRefPreview(ref)
      } else {
        setAssetSelection([ref])
      }
      setAssetSelectedItem(undefined)
      setAssetSelectedModel(undefined)
      return true
    } catch (error) {
      if (live) {
        setAssetError(error instanceof Error ? error.message : String(error))
      }
      return false
    }
  }

  const pickBrowsedAsset = (item: AssetBrowserItem): void => {
    // Refuse picks while an upload batch is pending: the staged selection
    // must not shift out from under the in-flight POST.
    if (assetUploading()) return
    // Same guard the pick predicate uses: commit derives its descriptor
    // from committableAssetRef, so pickable and committable cannot drift.
    const ref = committableAssetRef(item)
    if (ed.spec?.widgetType !== 'ASSET' || ref === undefined) return
    setAssetSelectedItem(item)
    setAssetSelectedModel(undefined)
    pickAssetRef(ref)
  }

  /** Stage a pick into the selection panel; the footer Apply button
   * commits. Multi-select toggles membership; single-select replaces. */
  const pickAssetRef = (ref: AssetRef): void => {
    if (assetUploading()) return
    if (assetMulti) {
      const adding = !assetSelection().some((selected) => sameAssetRef(selected, ref))
      toggleAssetSelection(ref)
      if (adding) void publishAssetRefPreview(ref)
      return
    }
    setAssetSelection([ref])
    void publishAssetRefPreview(ref)
  }

  const pickLogicalModelRef = (ref: AssetRef, detail: LogicalModelPickDetail): void => {
    if (assetUploading()) return
    setAssetSelectedItem(undefined)
    if (!assetMulti) {
      setAssetSelectedModel(detail)
      setAssetSelection([ref])
      void publishAssetRefPreview(ref)
      return
    }
    const removing = assetSelection().some((selected) => selected.digest === ref.digest)
    setAssetSelectedModel(removing ? undefined : detail)
    setAssetSelection((current) =>
      removing
        ? current.filter((selected) => selected.digest !== ref.digest)
        : [...current, ref],
    )
  }

  const pickLogicalModelEntry = (detail: LogicalModelPickDetail): void => {
    const ref = detail.variant.localRef
    if (ref !== undefined) {
      pickLogicalModelRef(ref, detail)
      return
    }
    if (assetUploading()) return
    setAssetSelectedItem(undefined)
    setAssetSelectedModel(detail)
    if (!assetMulti) {
      setAssetSelection([])
      clearAssetPreview()
    }
  }

  const retryAssetMatch = async (): Promise<void> => {
    if (unresolvedAsset === undefined) return
    const backend = props.app.backendForTab(ed.tab)
    if (backend.protocol !== 'dinkster') {
      setAssetMatchError('Retry matching requires a native Dinkster backend')
      return
    }
    setAssetMatchPending(true)
    setAssetMatchError(undefined)
    setAssetMatchCandidates([])
    try {
      const matches = await backend.connection.guessAssets([unresolvedAsset])
      if (!live) return
      setAssetMatchCandidates(matches.flatMap((match) =>
        match.candidates.filter((candidate) => assetGuessCandidateToRef(candidate) !== undefined),
      ))
    } catch (error) {
      if (live) setAssetMatchError(error instanceof Error ? error.message : String(error))
    } finally {
      if (live) setAssetMatchPending(false)
    }
  }

  /** Details render only while their pick is still in the selection: a
   * removed chip or replaced pick must not leave stale facts behind. */
  const selectionDetailItem = (): AssetBrowserItem | undefined => {
    const item = assetSelectedItem()
    if (item?.digest === undefined) return undefined
    return assetSelection().some((ref) => ref.digest === item.digest) ? item : undefined
  }
  const selectionDetailModel = (): LogicalModelPickDetail | undefined => {
    const detail = assetSelectedModel()
    if (detail !== undefined && detail.variant.localRef === undefined) return detail
    const digest = detail?.variant.localRef?.digest
    const selection = assetSelection()
    if (digest !== undefined && selection.some((ref) => ref.digest === digest)) return detail
    const selectedDigests = new Set(selection.map((ref) => ref.digest))
    for (const model of logicalModels() ?? []) {
      const variant = model.variants.find((candidate) =>
        candidate.localRef !== undefined && selectedDigests.has(candidate.localRef.digest))
      if (variant !== undefined) return { modelName: model.displayName, aliases: model.aliases, variant }
    }
    return undefined
  }
  const selectedUncommittableModel = (): LogicalModelPickDetail | undefined => {
    const detail = assetSelectedModel()
    return detail?.variant.localRef === undefined ? detail : undefined
  }

  const pickMatchedAsset = (candidate: AssetGuessCandidate): void => {
    const ref = assetGuessCandidateToRef(candidate)
    if (ref === undefined) return
    setAssetSelectedItem(undefined)
    setAssetSelectedModel(undefined)
    pickAssetRef({ ...ref })
  }

  const abortAssetUploadAndClose = (): void => {
    assetUploadAbort?.abort()
    close()
  }

  // The asset picker is the common collection surface in pick mode: mount
  // adapters wrap into CollectionSources (asset items ride as opaque entry
  // refs), and the widget's MIME accept + semantic kind become the pick
  // predicate. Details render in the editor's own selection rail.
  const assetUrlOf = (): ((digest: string) => string) | undefined => {
    const backend = props.app.backendForTab(ed.tab)
    return backend.protocol === 'dinkster' ? (digest) => backend.connection.assetUrl(digest) : undefined
  }
  const assetPanelSources = createMemo(() => {
    const adapters = assetSources() ?? []
    const assetUrl = assetUrlOf()
    const fixedKind = assetBrowseKind()
    if (usesLogicalModelSource()) {
      return logicalModels() === undefined ? [] : [logicalModelCollectionSource(() => logicalModels() ?? [])]
    }
    if (fixedKind?.startsWith('media/') === true) {
      const imported = adapters.filter((adapter) => mountPresentationClass({ id: adapter.id.replace(/^mount:/, ''), kind: fixedKind }) === 'input')
      const generated = adapters.filter((adapter) => mountPresentationClass({ id: adapter.id.replace(/^mount:/, ''), kind: fixedKind }) === 'output')
      return [
        allAssetsCollectionSource(adapters, [], assetUrl, { fixedKind, failWhenAllSourcesFail: true }),
        ...(imported.length > 0 ? [allAssetsCollectionSource(imported, [], assetUrl, { id: 'imported-assets', label: 'Imported', fixedKind, failWhenAllSourcesFail: true })] : []),
        ...(generated.length > 0 ? [allAssetsCollectionSource(generated, [], assetUrl, { id: 'generated-assets', label: 'Generated', fixedKind, failWhenAllSourcesFail: true })] : []),
      ]
    }
    return adapters.map((adapter) =>
      assetCollectionSource(adapter, {
        ...(assetUrl !== undefined ? { assetUrl } : {}),
        ...(fixedKind !== undefined ? { fixedKind } : {}),
      }),
    )
  })
  const pickAssetEntry = (entry: CollectionEntry): void => {
    if (usesLogicalModelSource()) {
      const detail = logicalModelPickDetailOf(entry)
      if (detail !== undefined) pickLogicalModelEntry(detail)
      return
    }
    const item = assetItemOf(entry)
    if (item) pickBrowsedAsset(item)
  }
  // Reopening the editor shows the CURRENT asset(s) selected (rail
  // populated): digest is content identity; a stored virtualPath
  // additionally pins the exact row when the same bytes appear at several
  // paths. Uploaded assets store virtualPath '' and match by digest alone.
  // Multi-select matches against the LIVE selection so browse-side rows
  // reflect toggles made during this open.
  const matchesRef = (entry: CollectionEntry, current: AssetRef): boolean => {
    const item = assetItemOf(entry)
    return item?.digest === current.digest && (current.virtualPath === '' || item?.virtualPath === current.virtualPath)
  }
  const matchesCurrentAsset = (entry: CollectionEntry): boolean => {
    if (usesLogicalModelSource()) {
      const ref = logicalModelAssetRefOf(entry)
      if (ref !== undefined && assetSelection().some((selected) => selected.digest === ref.digest)) return true
      const detail = logicalModelPickDetailOf(entry)
      const selected = selectedUncommittableModel()
      return !assetMulti && detail !== undefined && selected !== undefined &&
        detail.variant.logicalId === selected.variant.logicalId &&
        detail.variant.variantId === selected.variant.variantId &&
        detail.variant.digest === selected.variant.digest
    }
    return assetSelection().some((ref) => matchesRef(entry, ref))
  }

  // -- save target editor -----------------------------------------------------
  // Structured save destinations (schema wire v5). The picker sources mount
  // choices from the editing tab's backend (GET /api/mounts) exactly as
  // remote combos use its scoped client, filtered to ready readwrite mounts -
  // the only ones the backend will write into. The list is fetched fresh on
  // every editor open: grants/revokes apply live server-side and the payload
  // is tiny, so a stale 5-minute cache would only manufacture wrong choices.
  // Real host paths from the mount descriptors are never read, shown, or
  // stored - the document holds {mount, prefix} data only.
  type SaveTargetMounts =
    | { readonly state: 'loading' }
    | { readonly state: 'ready'; readonly mounts: readonly string[] }
    | { readonly state: 'error'; readonly message: string }
  const [saveTargetMounts, setSaveTargetMounts] = createSolidSignal<SaveTargetMounts>({ state: 'loading' })
  const [saveTargetMount, setSaveTargetMount] = createSolidSignal('')
  const [saveTargetPrefix, setSaveTargetPrefix] = createSolidSignal('')
  const [saveTargetError, setSaveTargetError] = createSolidSignal<string | undefined>(undefined)
  let saveTargetEdited = false
  const saveTargetInitial = ed.spec?.widgetType === 'SAVE_TARGET'
    ? isSaveTarget(ed.initial) ? ed.initial : isSaveTarget(ed.spec.default) ? ed.spec.default : undefined
    : undefined

  if (ed.spec?.widgetType === 'SAVE_TARGET') {
    setSaveTargetMount(saveTargetInitial?.mount ?? '')
    setSaveTargetPrefix(saveTargetInitial?.prefix ?? '')
    const client = props.app.backendForTab(ed.tab).scopedClient
    client
      .query('/api/mounts', {}, { refresh: true })
      .then((result) => {
        if (!live) return
        const rows = (result as { mounts?: unknown } | null)?.mounts
        if (!Array.isArray(rows)) throw new Error('/api/mounts did not return a mount list')
        const eligible = rows
          .filter((row): row is { id: unknown; mode?: unknown; state?: unknown } => typeof row === 'object' && row !== null)
          .filter((row) => row.mode === 'readwrite' && row.state === 'ready')
          .map((row) => String(row.id))
        setSaveTargetMounts({ state: 'ready', mounts: eligible })
        // Nothing chosen yet (unset optional target without a default):
        // preselect the first writable mount instead of an empty commit trap.
        if (saveTargetMount() === '' && eligible.length > 0) setSaveTargetMount(eligible[0]!)
      })
      .catch((e: unknown) => {
        if (!live) return
        setSaveTargetMounts({ state: 'error', message: e instanceof Error ? e.message : String(e) })
      })
  }

  /**
   * Mount options for the select: eligible mounts, plus the CURRENT mount
   * when it is not (currently) writable here - hiding it would silently
   * data-trap a document authored against another mount set. The backend
   * stays authoritative: an unavailable mount fails the job with a reasoned
   * error at execution, so offering it for explicit re-commit is safe.
   */
  const saveTargetMountOptions = (): readonly { id: string; unavailable: boolean }[] => {
    const mounts = saveTargetMounts()
    if (mounts.state !== 'ready') return []
    const options = mounts.mounts.map((id) => ({ id, unavailable: false }))
    const current = saveTargetMount()
    if (current !== '' && !mounts.mounts.includes(current)) options.unshift({ id: current, unavailable: true })
    return options
  }

  const commitSaveTarget = (): void => {
    if (ed.spec?.widgetType !== 'SAVE_TARGET') return
    const candidate = { mount: saveTargetMount(), prefix: saveTargetPrefix().trim() }
    const issues = saveTargetIssues(candidate)
    if (issues.length > 0) {
      // Invalid input never commits: the stored value stays untouched and
      // the reason is visible (the backend would refuse the same way).
      setSaveTargetError(issues.join('; '))
      return
    }
    commitEditorValue(candidate)
  }

  const clickAway = (): void => {
    if (!live) return
    if (ed.hostUi !== undefined) {
      close()
      return
    }
    const type = ed.spec?.widgetType
    if (type === 'ASSET') return
    if (type === 'COMBO') {
      close()
      return
    }
    if (type === 'COLOR') {
      const value = colorText()
      if (value === String(ed.initial ?? '')) {
        close()
        return
      }
      if (colorKind.validate(value, ed.spec!).length > 0) {
        close()
        return
      }
      commitEditorValue(value)
      return
    }
    if (type === 'SAVE_TARGET') {
      if (!saveTargetEdited) {
        close()
        return
      }
      const value = { mount: saveTargetMount(), prefix: saveTargetPrefix().trim() }
      if (saveTargetInitial !== undefined && value.mount === saveTargetInitial.mount && value.prefix === saveTargetInitial.prefix) {
        close()
        return
      }
      if (saveTargetIssues(value).length > 0) {
        close()
        return
      }
      commitEditorValue(value)
      return
    }
    if (ed.outputDescriptors !== undefined) { close(); return }
    const clickAwayCommits = ed.spec === undefined
      || type === 'INT'
      || type === 'FLOAT'
      || (type === 'STRING' && !ed.multiline)
    if (!clickAwayCommits) {
      close()
      return
    }
    const field = popoverEl?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
    if (field === undefined || field === null || field.value === String(ed.initial ?? '')) {
      close()
      return
    }
    commitEditor(field.value, true, true)
  }

  props.bindClickAway?.(clickAway)
  onCleanup(() => props.bindClickAway?.(undefined))

  const saveTargetDisplay = () => ed.spec?.widgetType === 'SAVE_TARGET'
    ? saveTargetPresentation(ed.spec, ed.declaredType)
    : undefined

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
  const modalType = videoDocumentCommand !== undefined ? 'VIDEO_DOCUMENT' : ed.spec?.widgetType ?? 'JSON'
  const modalDisplayType = createMemo(() => modalType === 'VIDEO_DOCUMENT'
    ? message('videoDocument.type')
    : modalType === 'ASSET'
      ? assetBrowseKind() === 'data/latent' && ed.label.toLowerCase().includes('latent')
        ? 'asset'
        : assetVocabulary().modalType
      : modalType)
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
  const InNodeEditor = () => {
    const anchor = () => inNodeAnchor()
    const scale = () => props.viewport().scale
    return (
      <div
        class="widget-editor widget-editor-in-node"
        data-testid="widget-editor"
        data-editor-target="input"
        data-editor-mode="STRING"
        data-editor-surface="in-node"
        role="dialog"
        aria-label={`Edit ${ed.label} STRING`}
        style={{
          left: `${anchor().x}px`,
          top: `${anchor().y}px`,
          width: `${anchor().width}px`,
          height: `${anchor().height}px`,
          padding: `${2 * scale()}px 0`,
          'border-radius': `${4 * scale()}px`,
        }}
      >
        <div class="widget-editor-in-node-surface">
          <span
            class="widget-editor-in-node-label"
            style={{
              width: '100%',
              height: `${defaultTokens.multilineText.labelHeight * scale()}px`,
              'font-size': `${defaultTokens.fontSize * scale()}px`,
              'padding-left': `${6 * scale()}px`,
            }}
          >{ed.label}</span>
          <textarea
            aria-label={`Edit ${ed.label}`}
            aria-autocomplete="list"
            aria-controls={textCompletionOpen() ? textCompletionInteraction.listboxId : undefined}
            aria-describedby={textCompletionOpen() ? textCompletionInteraction.statusId : undefined}
            aria-expanded={textCompletionOpen()}
            aria-activedescendant={textCompletionInteraction.activeOptionId(textCompletionEntries())}
            ref={(el) => {
              textCompletionAnchor = el
              queueMicrotask(() => el.focus())
            }}
            value={String(ed.initial ?? '')}
            style={{
              'font-family': defaultTokens.fontFamily,
              'font-size': `${defaultTokens.multilineText.fontSize * scale()}px`,
              'line-height': `${defaultTokens.multilineText.lineHeight * scale()}px`,
              padding: `${defaultTokens.multilineText.padding * scale()}px`,
              width: `calc(100% - ${defaultTokens.multilineText.scrollbarInset * scale()}px)`,
              'align-self': 'flex-start',
              'scrollbar-gutter': 'stable',
              '--multiline-scrollbar-width': `${defaultTokens.multilineText.scrollbarWidth * scale()}px`,
            }}
            onInput={(e) => {
              const input = e as InputEvent
              void requestTextCompletions(
                e.currentTarget,
                typeof input.data === 'string'
                  ? input.data
                  : e.currentTarget.value.at((e.currentTarget.selectionStart ?? 0) - 1) ?? '',
              )
            }}
            onClick={(e) => void requestTextCompletions(e.currentTarget, '')}
            onKeyUp={(e) => {
              if (textCompletionEntries().length > 0 && ['ArrowUp', 'ArrowDown', 'Tab', 'Enter', 'Escape'].includes(e.key)) return
              if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
                void requestTextCompletions(e.currentTarget, '')
              }
            }}
            onBlur={(e) => {
              // Opening and clicking away without changing text is not an
              // edit: avoid a phantom undo step or ghost materialization.
              if (e.currentTarget.value === String(ed.initial ?? '')) close()
              else commitEditor(e.currentTarget.value)
            }}
            onKeyDown={(e) => {
              if (!e.isComposing && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                commitEditor(e.currentTarget.value)
                return
              }
              const entries = textCompletionEntries()
              if (textCompletionInteraction.onKeyDown(
                e,
                entries,
                e.currentTarget,
                (entry) => acceptTextCompletion(e.currentTarget, entry),
                closeTextCompletions,
              )) return
              if (e.isComposing) return
            }}
          />
          <Show when={textCompletionOpen() && textCompletionAnchor !== undefined}>
            <SuggestionSurface
              ariaLabel="Text suggestions"
              anchor={textCompletionAnchor!}
              {...(props.boundary !== undefined ? { boundary: props.boundary } : {})}
              state={textCompletionSurfaceState()}
              interaction={textCompletionInteraction}
              onAccept={(entry) => acceptTextCompletion(textCompletionAnchor!, entry)}
            />
          </Show>
        </div>
      </div>
    )
  }
  const EditorContent = () => ed.outputDescriptors !== undefined ? (
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
  ) : (
    <Show
      when={ed.spec?.widgetType === 'COMBO' || ed.spec?.widgetType === 'MULTI_COMBO' || ed.spec?.widgetType === 'COLOR' || ed.spec?.widgetType === 'ASSET' || ed.spec?.widgetType === 'SAVE_TARGET' || ed.spec?.widgetType === 'VIDEO_EDIT' || videoDocumentCommand !== undefined}
      fallback={
        <div
          ref={bindPopover}
          class="widget-editor floating-surface widget-editor-popover"
          data-testid="widget-editor"
          data-editor-target={ed.target.kind}
          data-editor-mode={ed.spec ? ed.spec.widgetType : 'raw'}
          data-editor-surface="popover"
          role="dialog"
          aria-label={`Edit ${ed.label} ${modalDisplayType()}`}
          style={popoverStyle}
        >
          <EditorHeader type={ed.spec?.widgetType ?? 'JSON'} />
          <ProductField
            controlId="widget-editor-value"
            label="Value"
            layout="compact"
            message={widgetEditorError()}
            messageTestId="widget-editor-error"
            invalid={widgetEditorError() !== undefined}
          >
            <Show
              when={ed.multiline}
              fallback={
                <input
                  id="widget-editor-value"
                  aria-labelledby={scalarFieldIds.label}
                  aria-autocomplete={ed.spec?.widgetType === 'STRING' ? 'list' : undefined}
                  aria-controls={textCompletionOpen() ? textCompletionInteraction.listboxId : undefined}
                  aria-describedby={widgetEditorError() !== undefined
                    ? scalarFieldIds.message
                    : textCompletionOpen() ? textCompletionInteraction.statusId : undefined}
                  aria-invalid={widgetEditorError() === undefined ? undefined : 'true'}
                  aria-expanded={ed.spec?.widgetType === 'STRING' ? textCompletionOpen() : undefined}
                  aria-activedescendant={ed.spec?.widgetType === 'STRING'
                    ? textCompletionInteraction.activeOptionId(textCompletionEntries())
                    : undefined}
                  ref={(el) => {
                    if (ed.spec?.widgetType === 'STRING') textCompletionAnchor = el
                    queueMicrotask(() => {
                      el.focus()
                      if (ed.spec?.widgetType === 'INT' || ed.spec?.widgetType === 'FLOAT') el.select()
                    })
                  }}
                  value={String(ed.initial ?? '')}
                  placeholder={typeof ed.spec?.options['placeholder'] === 'string' ? ed.spec.options['placeholder'] : undefined}
                  onInput={(e) => {
                    setWidgetEditorError(undefined)
                    if (ed.spec?.widgetType !== 'STRING') return
                    const input = e as InputEvent
                    void requestTextCompletions(
                      e.currentTarget,
                      typeof input.data === 'string'
                        ? input.data
                        : e.currentTarget.value.at((e.currentTarget.selectionStart ?? 0) - 1) ?? '',
                    )
                  }}
                  onClick={(e) => {
                    if (ed.spec?.widgetType === 'STRING') void requestTextCompletions(e.currentTarget, '')
                  }}
                  onKeyUp={(e) => {
                    if (ed.spec?.widgetType !== 'STRING') return
                    if (textCompletionEntries().length > 0 && ['ArrowUp', 'ArrowDown', 'Tab', 'Enter', 'Escape'].includes(e.key)) return
                    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                      void requestTextCompletions(e.currentTarget, '')
                    }
                  }}
                  onKeyDown={(e) => {
                    if (ed.spec?.widgetType === 'STRING' && textCompletionInteraction.onKeyDown(
                      e,
                      textCompletionEntries(),
                      e.currentTarget,
                      (entry) => acceptTextCompletion(e.currentTarget, entry),
                      closeTextCompletions,
                    )) return
                    if (e.key === 'Enter') { if (e.isComposing) return; e.preventDefault(); commitEditor(e.currentTarget.value) }
                  }}
                />
              }
            >
              <textarea
                id="widget-editor-value"
                aria-labelledby={scalarFieldIds.label}
                aria-describedby={widgetEditorError() === undefined ? undefined : scalarFieldIds.message}
                aria-invalid={widgetEditorError() === undefined ? undefined : 'true'}
                ref={(el) => queueMicrotask(() => el.focus())}
                value={String(ed.initial ?? '')}
                placeholder={typeof ed.spec?.options['placeholder'] === 'string' ? ed.spec.options['placeholder'] : undefined}
                onInput={() => setWidgetEditorError(undefined)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { if (e.isComposing) return; e.preventDefault(); commitEditor(e.currentTarget.value) }
                }}
              />
            </Show>
          </ProductField>
          <Show when={textCompletionOpen() && textCompletionAnchor !== undefined}>
            <SuggestionSurface
              ariaLabel="Text suggestions"
              anchor={textCompletionAnchor!}
              {...(props.boundary !== undefined ? { boundary: props.boundary } : {})}
              state={textCompletionSurfaceState()}
              interaction={textCompletionInteraction}
              onAccept={(entry) => acceptTextCompletion(textCompletionAnchor!, entry)}
            />
          </Show>
          <div class="widget-editor-meta" data-testid="widget-editor-meta">
            <Show when={ed.spec?.widgetType === 'INT' || ed.spec?.widgetType === 'FLOAT'}>
              <dl class="widget-numeric-constraints" data-testid="widget-numeric-constraints" aria-label="Numeric constraints">
                <dt>Minimum</dt>
                <dd>{Number.isFinite(ed.spec!.options['min']) || isCanonicalUnsafeInteger(ed.spec!.options['min']) ? String(ed.spec!.options['min']) : 'unbounded'}</dd>
                <dt>Maximum</dt>
                <dd>{Number.isFinite(ed.spec!.options['max']) || isCanonicalUnsafeInteger(ed.spec!.options['max']) ? String(ed.spec!.options['max']) : 'unbounded'}</dd>
                <dt>Step</dt>
                <dd>
                  {(Number.isFinite(ed.spec!.options['step']) && Number(ed.spec!.options['step']) > 0) || isCanonicalUnsafeInteger(ed.spec!.options['step'])
                    ? String(ed.spec!.options['step'])
                    : `${numericStepConstraints(ed.spec!).step} (default)`}
                </dd>
              </dl>
            </Show>
            <Show when={ed.multiline}>{ed.spec ? 'Ctrl+Enter to commit' : 'JSON'}</Show>
          </div>
          <ProductActionFooter>
            <button type="button" data-testid="widget-editor-cancel" onPointerDown={(e) => e.preventDefault()} onClick={close}>
              <Icon icon={X} /> Cancel
            </button>
            <button
              type="button"
              class="primary"
              data-testid="widget-editor-commit"
              onPointerDown={(e) => e.preventDefault()}
              onClick={(e) => {
                const field = e.currentTarget.closest('.widget-editor')?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
                if (field) commitEditor(field.value)
              }}
            >
              <Icon icon={Check} /> Commit
            </button>
          </ProductActionFooter>
        </div>
      }
    >
      <>
        <Show when={ed.spec?.widgetType === 'COLOR'}>
          <div
            ref={bindPopover}
            class="widget-editor floating-surface widget-editor-popover color-editor"
            data-testid="color-editor"
            data-editor-surface="popover"
            role="dialog"
            aria-label={`Edit ${ed.label} COLOR`}
            style={popoverStyle}
          >
            <EditorHeader type="COLOR" />
            <div
              class="color-saturation-value"
              data-testid="color-saturation-value"
              data-editor-interactive
              style={{ 'background-color': `hsl(${colorHue()} 100% 50%)` }}
              onPointerDown={pickSaturationValue}
              onPointerMove={pickSaturationValue}
            />
            <div
              class="color-hue"
              data-testid="color-hue"
              data-editor-interactive
              onPointerDown={pickHue}
              onPointerMove={pickHue}
            />
            <ProductField
              controlId="color-editor-value"
              label="Color value"
              layout="compact"
              class="color-value-field"
              message={colorError()}
              messageTestId="color-error"
              invalid={colorError() !== undefined}
            >
              <input
                id="color-editor-value"
                data-testid="color-text"
                aria-labelledby={colorFieldIds.label}
                aria-describedby={colorError() === undefined ? undefined : colorFieldIds.message}
                aria-invalid={colorError() === undefined ? undefined : 'true'}
                value={colorText()}
                ref={(el) => queueMicrotask(() => { el.focus(); el.select() })}
                onInput={(e) => { setColorText(e.currentTarget.value); setColorError(undefined) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (e.isComposing) return
                    e.preventDefault()
                    commitColor()
                  }
                }}
              />
            </ProductField>
            <ProductActionFooter class="color-editor-footer">
              <button type="button" onPointerDown={(e) => e.preventDefault()} onClick={close}><Icon icon={X} /> Cancel</button>
              <button type="button" class="primary" onPointerDown={(e) => e.preventDefault()} onClick={commitColor}><Icon icon={Check} /> Commit</button>
            </ProductActionFooter>
          </div>
        </Show>
        <Show when={ed.spec?.widgetType === 'ASSET'}>
          {/* Escape and outside dismissal refuse while an upload batch runs;
              explicit Cancel remains the recovery path and aborts the owned
              upload before closing. The host's window-capture dismissal runs
              before this body sees the event, so the refusal is advertised
              through data-dismiss-blocked. */}
          <div class="widget-editor asset-editor widget-modal-editor" data-testid="asset-editor" data-dismiss-blocked={assetUploading() ? 'uploading' : undefined}>
            <div class="asset-editor-context" data-testid="asset-schema-metadata" aria-label="Asset requirements">
              <strong>{assetMulti ? `Multiple ${assetVocabulary().plural}` : `Single ${assetVocabulary().singular}`}</strong>
              <Show when={assetBrowseKind()}>{(kind) => <span>{kind()}</span>}</Show>
              <Show when={assetAccept().length > 0}>
                <span>{assetAccept().join(', ')}</span>
              </Show>
              <Show when={assetUploadLimitLabel}>{(label) => <span>{label()}</span>}</Show>
            </div>
            <Show when={unresolvedAsset !== undefined}>
              <section class="asset-unresolved-import" data-testid="asset-unresolved-import" aria-label="Missing model resolution">
                <header class="asset-section-heading">
                  <div>
                    <span class="asset-section-eyebrow">Unresolved import</span>
                    <h3>Choose a local replacement</h3>
                  </div>
                  <button
                    type="button"
                    data-testid="asset-retry-match"
                    disabled={assetMatchPending() || assetUploading()}
                    onClick={() => { void retryAssetMatch() }}
                  >
                    <Icon icon={RotateCw} /> {assetMatchPending() ? 'Matching...' : 'Retry matching'}
                  </button>
                </header>
                <p>The imported reference is not available. Select an exact local asset below.</p>
                <dl class="widget-modal-metadata">
                  <dt>Requested</dt><dd>{unresolvedAsset}</dd>
                  <dt>File name</dt><dd>{unresolvedAssetBasename(unresolvedAsset!)}</dd>
                  <dt>Expected kind</dt><dd>{assetKind() ?? 'unspecified'}</dd>
                  <dt>Accepted types</dt><dd>{assetAccept().length > 0 ? assetAccept().join(', ') : 'unspecified'}</dd>
                </dl>
                <Show when={assetMatchError()}>{(message) => (
                  <ProductNotice tone="error" testId="asset-match-error">{message()}</ProductNotice>
                )}</Show>
                <Show when={!assetMatchPending() && assetMatchCandidates().length === 0 && assetMatchError() === undefined}>
                  <SearchState kind="empty" title="No exact local matches" detail="Retry matching or search the assets below." />
                </Show>
                <div class="asset-match-candidates">
                  <For each={assetMatchCandidates()}>
                    {(candidate) => (
                      <button type="button" data-testid="asset-match-candidate" disabled={assetUploading()} onClick={() => pickMatchedAsset(candidate)}>
                        <span class="asset-match-candidate-copy">
                          <strong>{candidate.name}</strong>
                          <span>{candidate.virtualPath}</span>
                        </span>
                        <span class="asset-match-candidate-size">{candidate.size} bytes</span>
                        <code title={candidate.digest}>{candidate.digest}</code>
                      </button>
                    )}
                  </For>
                </div>
                <section class="asset-acquisition" aria-label="Download provider">
                  <Show when={!backendSupportsAssetAcquisition()}>
                    <div>
                      <h4>Download unavailable</h4>
                      <p data-testid="asset-acquisition-unavailable">This backend provides no download source or acquisition contract.</p>
                    </div>
                    <button type="button" data-testid="asset-download" disabled>Download</button>
                  </Show>
                </section>
              </section>
            </Show>
            <Show when={assetError()}>{(message) => <ProductNotice tone="error" class="asset-error">{message()}</ProductNotice>}</Show>
            <div class="asset-editor-body">
            <section class="asset-browser-section" aria-label={assetVocabulary().titlePlural}>
              <header class="asset-section-heading">
                <div>
                  <span class="asset-section-eyebrow">Browse</span>
                  <h3>{assetVocabulary().titlePlural}</h3>
                </div>
                <Show when={usesLogicalModelSource()}>
                  <button type="button" data-testid="logical-model-refresh" disabled={logicalModelsLoading()} onClick={() => { void loadLogicalModels(assetSources() ?? []) }}>
                    <Icon icon={RotateCw} /> Refresh
                  </button>
                </Show>
              </header>
              <Show when={assetSourcesError()}>{(message) => <ProductNotice tone="error" class="asset-error">{message()}</ProductNotice>}</Show>
              <Show when={assetSourcesStatus(assetSources(), assetSourcesError()) === 'loading'}>
                <SearchState kind="loading" title={`Loading ${assetVocabulary().singular} sources`} detail="Discovering readable mounts on this backend." />
              </Show>
              <Show when={assetSourcesStatus(assetSources(), assetSourcesError()) === 'empty'}>
                <SearchState
                  kind="empty"
                  title={`No browsable ${assetVocabulary().singular} sources`}
                  detail={usesLogicalModelSource() ? 'No mounted models are available.' : `You can still upload ${withArticle(assetVocabulary().singular)} below.`}
                />
              </Show>
              <Show when={assetSourcesStatus(assetSources(), assetSourcesError()) === 'ready'}>
                <Show when={usesLogicalModelSource()}>
                  <Show when={logicalModelsError()}>{(message) => <ProductNotice tone="error" class="asset-error">{message()}</ProductNotice>}</Show>
                </Show>
                <Show when={!usesLogicalModelSource() || logicalModels() !== undefined} fallback={
                  <Show when={logicalModelsLoading()}>
                    <SearchState kind="loading" title="Loading models" detail="Grouping variants from available sources." />
                  </Show>
                }>
                  <CollectionPanel
                    variant="select"
                    sources={assetPanelSources()}
                    pick={{
                      pickable: usesLogicalModelSource()
                        ? logicalModelEntrySelectable
                        : assetEntryPickable(assetAccept(), assetBrowseKind()),
                      onPick: pickAssetEntry,
                      ...(usesLogicalModelSource() ? { visible: logicalModelEntryVisible } : {}),
                      selected: matchesCurrentAsset,
                      multi: assetMulti,
                    }}
                    initialSelection={matchesCurrentAsset}
                    modeKey={usesLogicalModelSource() ? `${VIEW_PREFERENCE_KEY}.models` : VIEW_PREFERENCE_KEY}
                    defaultMode={usesLogicalModelSource()
                      ? 'list'
                      : assetBrowseKind()?.startsWith('media/') === true ? 'grid' : 'list'}
                    searchPriority="primary"
                    searchLabel={`Search ${assetVocabulary().plural}`}
                    searchPlaceholder={`Search ${assetVocabulary().plural}`}
                    renderState={(state) => assetPickerState(state, assetVocabulary())}
                    entryFallback={(entry) => <AssetEntryFallback entry={entry} />}
                  />
                </Show>
              </Show>
            </section>
            <section class="asset-selection-summary" data-testid="asset-selection-summary" aria-label="Selection">
              <header class="asset-section-heading">
                <div>
                  <span class="asset-section-eyebrow">Selection</span>
                  <h3>{assetMulti
                    ? `${assetSelection().length} selected`
                    : assetSelection()[0]?.name ?? selectedUncommittableModel()?.modelName ?? 'Nothing selected'}</h3>
                </div>
                <Show when={!assetMulti ? assetSelection()[0]?.size ?? selectedUncommittableModel()?.variant.size : undefined}>
                  {(size) => <span>{formatSize(size())}</span>}
                </Show>
              </header>
              <Show when={!assetMulti && assetSelection().length === 0 && selectedUncommittableModel() === undefined}>
                <p class="asset-selection-empty" data-testid="asset-selection-empty">
                  {usesLogicalModelSource()
                    ? `Click ${withArticle(assetVocabulary().singular)} in the list to select it.`
                    : `Click ${withArticle(assetVocabulary().singular)} in the list to select it, or upload ${withArticle(assetVocabulary().uploadSingular)}.`}
                </p>
              </Show>
              <Show when={assetPreview()}>
                {(preview) => (
                  <Show when={preview().kind !== 'model3d'} fallback={
                    <Model3dPosterImage src={preview().src} name={preview().name} mime={preview().mime} />
                  }>
                  <Show when={preview().kind === 'video'} fallback={
                    <Show when={!assetPreviewFailed()} fallback={
                      <div class="asset-preview asset-preview-fallback" data-testid="asset-image-fallback" role="status">
                        <span>Image preview unavailable.</span>
                        <a href={preview().src} download={preview().name}>Open or download image</a>
                      </div>
                    }>
                      <img
                        class="asset-preview"
                        src={preview().src}
                        alt="Asset preview"
                        onError={() => setAssetPreviewFailed(true)}
                        onLoad={(event) => {
                          const { naturalWidth, naturalHeight } = event.currentTarget
                          if (naturalWidth > 0 && naturalHeight > 0) setAssetPreviewDims({ width: naturalWidth, height: naturalHeight })
                        }}
                      />
                    </Show>
                  }>
                    <Show when={!assetPreviewFailed()} fallback={
                      <div class="asset-preview asset-preview-fallback" data-testid="asset-video-fallback" role="status">
                        <span>Video preview unavailable.</span>
                        <a href={preview().src} download={preview().name}>Download video</a>
                      </div>
                    }>
                      <video
                        class="asset-preview"
                        data-testid="asset-video-preview"
                        src={preview().src}
                        controls
                        playsinline
                        preload="metadata"
                        onError={() => setAssetPreviewFailed(true)}
                        onLoadedMetadata={(event) => {
                          const { videoWidth, videoHeight } = event.currentTarget
                          if (videoWidth > 0 && videoHeight > 0) setAssetPreviewDims({ width: videoWidth, height: videoHeight })
                        }}
                      >
                        <a href={preview().src} download={preview().name}>Download video</a>
                      </video>
                    </Show>
                  </Show>
                  </Show>
                )}
              </Show>
              <Show when={!assetPreviewFailed() ? assetPreviewDims() : undefined}>
                {(dims) => (
                  <div class="asset-preview-caption" data-testid="asset-preview-caption">{dims().width} x {dims().height}</div>
                )}
              </Show>
              <Show when={assetMulti}>
                <div class="asset-multi-selection" data-testid="asset-multi-selection">
                  <Show when={assetSelection().length === 0}>
                    <span class="asset-selection-empty">
                      {usesLogicalModelSource()
                        ? `No ${assetVocabulary().plural} selected. Click items in the list.`
                        : `No ${assetVocabulary().plural} selected. Click items in the list or upload ${assetVocabulary().uploadPlural}.`}
                    </span>
                  </Show>
                  <For each={assetSelection()}>
                    {(ref, index) => (
                      <span class="asset-chip" data-testid="asset-chip">
                        <span>{ref.name}</span>
                        <button
                          type="button"
                          class="asset-chip-remove"
                          aria-label={`Remove ${ref.name}`}
                          onClick={() => removeAssetSelection(ref, index())}
                        >
                          <Icon icon={X} />
                        </button>
                      </span>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={selectionDetailItem()} keyed>
                {(item) => <AssetSelectionDetails item={item} dimensions={assetPreviewDims()} adapters={assetSources() ?? []} backendId={String(props.app.backendForTab(ed.tab).id)} />}
              </Show>
              <Show when={selectionDetailModel()} keyed>
                {(detail) => <LogicalModelVariantFacts detail={detail} acquisitionSupported={backendSupportsAssetAcquisition()} />}
              </Show>
              <Show when={assetSelection().length > 0 || selectedUncommittableModel() !== undefined}>
                {/* Remove only stages an empty selection: nothing commits
                    before the footer commit, Cancel restores the stored
                    value. */}
                <button
                  type="button"
                  class="asset-selection-remove"
                  data-testid="asset-selection-remove"
                  disabled={assetUploading()}
                  onClick={() => { setAssetSelection([]); setAssetSelectedItem(undefined); setAssetSelectedModel(undefined); clearAssetPreview() }}
                >
                  <Icon icon={X} /> Remove
                </button>
              </Show>
            </section>
            </div>
            <Show when={classifiedMediaKind === 'media/audio' && ed.spec?.allowUpload === true}>
              <AudioRecorder disabled={assetUploading()} onSave={async (file) => {
                const abort = new AbortController()
                assetUploadAbort = abort
                setAssetUploading(true)
                try { return await pickAsset(file) }
                finally {
                  if (assetUploadAbort === abort) assetUploadAbort = undefined
                  if (live) setAssetUploading(false)
                }
              }} />
            </Show>
            <ProductActionFooter
              status={<span role="status">{assetUploading() ? `Uploading ${assetVocabulary().uploadPlural}...` : assetUploadLimitLabel !== undefined ? `Uploads up to ${assetUploadLimitLabel}` : ''}</span>}
            >
              <button
                ref={(element) => { assetUploadTrigger = element }}
                type="button"
                class="asset-upload-trigger"
                data-testid="asset-upload-trigger"
                aria-label={`Upload ${assetVocabulary().uploadSingular}`}
                disabled={assetUploading() || usesLogicalModelSource()}
                onClick={() => assetUploadInput?.click()}
              >
                <Icon icon={Upload} /> {assetUploading() ? 'Uploading...' : assetMulti ? `Upload ${assetVocabulary().uploadPlural}...` : `Upload ${assetVocabulary().uploadSingular}...`}
              </button>
              <input
                ref={(element) => { assetUploadInput = element }}
                type="file"
                hidden
                multiple={assetMulti}
                accept={Array.isArray(ed.spec?.options['accept']) ? (ed.spec!.options['accept'] as string[]).join(',') : ''}
                disabled={assetUploading() || usesLogicalModelSource()}
                onCancel={restoreAssetUploadFocus}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? [])
                  event.currentTarget.value = ''
                  // Sequential on purpose: parallel uploads would race the
                  // shared error slot. The batch stops at the first failed
                  // or refused file (its error must stay visible) and when
                  // the editor closes mid-flight.
                  void (async () => {
                    const abort = new AbortController()
                    assetUploadAbort = abort
                    setAssetUploading(true)
                    try {
                      for (const file of assetMulti ? files : files.slice(0, 1)) {
                        if (!live || abort.signal.aborted || !(await pickAsset(file))) break
                      }
                    } finally {
                      if (assetUploadAbort === abort) assetUploadAbort = undefined
                      if (live) {
                        setAssetUploading(false)
                        restoreAssetUploadFocus()
                      }
                    }
                  })()
                }}
              />
              {/* Cancel stays enabled DURING an upload as the lock's escape
                  hatch: it aborts the pending batch, then closes (staging
                  discarded, stored value untouched). */}
              <button type="button" onClick={abortAssetUploadAndClose}>Cancel</button>
              <button
                type="button"
                class="primary"
                data-testid="asset-apply"
                disabled={assetUploading() || (!assetMulti && selectedUncommittableModel() !== undefined)}
                onClick={() => {
                  const selection = assetSelection()
                  if (!assetMulti) {
                    commitEditorValue(selection[0] ?? null)
                    return
                  }
                  const committed = usesLogicalModelSource()
                    ? selection.filter((ref, index) => selection.findIndex((candidate) => candidate.digest === ref.digest) === index)
                    : selection
                  commitEditorValue(assetScalarMerge && committed.length === 0 ? null : [...committed])
                }}
              >
                <Icon icon={Check} /> {assetMulti
                  ? `Use ${assetSelection().length} ${assetSelection().length === 1 ? assetVocabulary().singular : assetVocabulary().plural}`
                  : `Use ${assetVocabulary().singular}`}
              </button>
            </ProductActionFooter>
          </div>
        </Show>
        <Show when={ed.spec?.widgetType === 'SAVE_TARGET'}>
          <div
            ref={bindPopover}
            class="widget-editor floating-surface widget-editor-popover save-target-editor"
            data-testid="save-target-editor"
            data-mounts={saveTargetMounts().state}
            data-editor-surface="popover"
            role="dialog"
            aria-label={`Edit ${ed.label} SAVE_TARGET`}
            style={popoverStyle}
          >
            <EditorHeader type={saveTargetDisplay()!.canonicalType} />
            <dl class="widget-editor-meta save-target-metadata" aria-label="Save target output metadata">
              <dt>Output format</dt>
              <dd data-testid="save-target-output-format">{saveTargetDisplay()!.outputFormat}</dd>
            </dl>
            <Show when={saveTargetMounts().state === 'loading'}>
              <ProductNotice tone="status">loading mounts...</ProductNotice>
            </Show>
            <Show when={saveTargetMounts().state === 'error'}>
              <ProductNotice tone="error" testId="save-target-mounts-error">mount list failed to load</ProductNotice>
            </Show>
            <Show when={saveTargetMounts().state === 'ready' && saveTargetMountOptions().length === 0}>
              <ProductNotice tone="status" testId="save-target-no-mounts">no writable mounts available</ProductNotice>
            </Show>
            <ProductField controlId="save-target-mount-control" label="Mount" layout="compact">
              <ProductSelect
                id="save-target-mount-control"
                testId="save-target-mount"
                ariaLabel="Mount"
                disabled={saveTargetMounts().state !== 'ready' || saveTargetMountOptions().length === 0}
                selectedId={saveTargetMount()}
                options={saveTargetMountOptions().map((option) => ({ id: option.id, label: option.unavailable ? `${option.id} (unavailable)` : option.id, value: option.id }))}
                onSelect={(option) => {
                  saveTargetEdited = true
                  setSaveTargetMount(option.value)
                  setSaveTargetError(undefined)
                }}
              />
            </ProductField>
            <ProductField
              controlId="save-target-prefix"
              label="Prefix"
              layout="compact"
              message={saveTargetError()}
              messageTestId="save-target-error"
              invalid={saveTargetError() !== undefined}
            >
              <span class="save-target-prefix-row">
                <input
                  id="save-target-prefix"
                  data-testid="save-target-prefix"
                  aria-labelledby={saveTargetPrefixIds.label}
                  aria-describedby={saveTargetError() === undefined ? undefined : saveTargetPrefixIds.message}
                  aria-invalid={saveTargetError() === undefined ? undefined : 'true'}
                  ref={(el) => queueMicrotask(() => el.focus())}
                  value={saveTargetPrefix()}
                  onInput={(e) => {
                    saveTargetEdited = true
                    setSaveTargetPrefix(e.currentTarget.value)
                    setSaveTargetError(undefined)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (e.isComposing) return
                      e.preventDefault()
                      commitSaveTarget()
                    }
                  }}
                />
                {/* The suffix is the node's extension: display context only, never stored. */}
                <Show when={typeof ed.spec?.options['suffix'] === 'string' && ed.spec!.options['suffix'] !== ''}>
                  <span class="save-target-suffix" data-testid="save-target-suffix">{ed.spec!.options['suffix'] as string}</span>
                </Show>
              </span>
            </ProductField>
            <ProductActionFooter>
              <button
                type="button"
                data-testid="save-target-save"
                disabled={saveTargetMounts().state !== 'ready'}
                onClick={commitSaveTarget}
              >save</button>
              {/* Null = unset: the node's schema default target applies at execution. */}
              <button type="button" onClick={() => commitEditorValue(null)}>clear</button>
              <button type="button" onClick={close}>cancel</button>
            </ProductActionFooter>
          </div>
        </Show>
        <Show when={ed.spec?.widgetType === 'VIDEO_EDIT'}>
          <div
            class="widget-editor widget-modal-editor video-edit-modal"
            data-testid="widget-editor"
            data-editor-mode="VIDEO_EDIT"
            data-editor-surface="modal"
          >
            <EditorHeader type="VIDEO_EDIT" />
            <VideoEditEditor
              value={videoInitial}
              spec={ed.spec!}
              {...videoContext}
              onCommit={commitVideoEdit}
              onCancel={close}
            />
          </div>
        </Show>
        <Show when={videoDocumentCommand !== undefined}>
          <div
            class="widget-editor widget-modal-editor video-document-modal"
            data-testid="widget-editor"
            data-editor-mode="VIDEO_DOCUMENT"
            data-editor-surface="modal"
          >
            <EditorHeader type="VIDEO_DOCUMENT" />
            <VideoDocumentEditor
              command={videoDocumentCommand!}
              value={typeof ed.initial === 'string' ? ed.initial : videoDocumentCommand === 'import_otio' ? '' : '{}'}
              {...videoDocumentContext()}
              onCommit={commitEditorValue}
              onCancel={close}
            />
          </div>
        </Show>
        <Show when={ed.spec?.widgetType === 'COMBO'}>
          <div
            ref={(el) => {
              comboEl = el
              bindPopover(el)
            }}
            class="widget-editor floating-surface widget-editor-popover combo-dropdown"
            classList={{ 'input-family-combo': ed.spec?.optionSource !== undefined }}
            data-testid="combo-dropdown"
            data-remote={remoteComboState()?.state ?? 'static'}
            data-editor-surface="popover"
            role="dialog"
            aria-label={`Edit ${ed.label} COMBO`}
            style={popoverStyle}
          >
            <EditorHeader type="COMBO" />
            <Show when={ed.spec?.optionSource !== undefined && editableInputFamilyOptions.length > 0}>
              <fieldset class="input-family-labels" data-testid="input-family-labels">
                <legend>{message('inputFamily.labels.title')}</legend>
                <For each={editableInputFamilyOptions}>
                  {(option) => (
                    <label class="input-family-label-row">
                      <span>{message('inputFamily.stableId', { id: persistedMemberId(option.value) })}</span>
                      <input
                        data-testid={`input-family-label-${persistedMemberId(option.value)}`}
                        aria-label={`${message('inputFamily.labels.item')}: ${persistedMemberId(option.value)}`}
                        value={memberLabels()[option.value] ?? option.label}
                        onInput={(event) => setMemberLabels((labels) => ({
                          ...labels,
                          [option.value]: event.currentTarget.value,
                        }))}
                      />
                    </label>
                  )}
                </For>
                <Show when={memberLabelError()}>
                  <ProductNotice tone="error" testId="input-family-label-error">
                    {memberLabelError()}
                  </ProductNotice>
                </Show>
                <button
                  type="button"
                  data-testid="input-family-label-apply"
                  disabled={!memberLabelsChanged() || memberLabelError() !== undefined}
                  onClick={commitMemberLabels}
                >{message('inputFamily.labels.apply')}</button>
              </fieldset>
            </Show>
            <ProductField controlId="combo-search-control" label="Search options" layout="compact">
              <input
                id="combo-search-control"
                data-testid="combo-search"
                placeholder="Search options..."
                ref={(el) => queueMicrotask(() => el.focus())}
                value={comboQuery()}
                onInput={(event) => {
                  comboHighlightSource = 'keyboard'
                  setComboQuery(event.currentTarget.value)
                  setComboIndex(0)
                }}
                onKeyDown={onComboKeyDown}
              />
            </ProductField>
            <ComboFolderNavigation />
            <div class="combo-options" role="listbox">
              <Show when={remoteComboState()?.state === 'loading'}>
                <div class="combo-status">loading remote options...</div>
              </Show>
              <Show when={remoteComboState()?.state === 'stale'}>
                <div class="combo-status">remote options stale</div>
              </Show>
              <Show when={remoteComboState()?.state === 'unavailable'}>
                <div class="combo-status">remote options unavailable</div>
              </Show>
              <ComboMenuRows multi={false} />
            </div>
            <Show when={ed.spec?.remote?.refreshButton === true}>
              <button type="button" class="combo-refresh" data-testid="remote-refresh" onMouseDown={(event) => event.preventDefault()} onClick={() => loadRemoteOptions(ed.spec, true)}>
                refresh
              </button>
            </Show>
          </div>
        </Show>
        <Show when={ed.spec?.widgetType === 'MULTI_COMBO'}>
          <div
            ref={(el) => {
              comboEl = el
              bindPopover(el)
            }}
            class="widget-editor floating-surface widget-editor-popover combo-dropdown multi-combo-dropdown"
            data-testid="multi-combo-dropdown"
            data-remote={remoteComboState()?.state ?? 'static'}
            data-chip={ed.spec?.options['chip'] === true ? 'true' : ed.spec?.options['chip'] === false ? 'false' : 'absent'}
            data-editor-surface="popover"
            role="dialog"
            aria-label={`Edit ${ed.label} MULTI_COMBO`}
            style={popoverStyle}
          >
            <EditorHeader type="MULTI_COMBO" />
            <div class="multi-combo-values" data-testid="multi-combo-values">
              <For each={multiComboValues()} fallback={<span class="combo-status">No selections</span>}>
                {(value, index) => (
                  <button
                    type="button"
                    class="multi-combo-value"
                    classList={{ chip: ed.spec?.options['chip'] === true }}
                    data-testid="multi-combo-value"
                    data-oov={multiComboOovSeverity(value)}
                    aria-label={`Remove ${multiComboLabel(value)}`}
                    onClick={() => mutateMultiComboValues((values) => values.filter((_value, candidate) => candidate !== index()))}
                  >
                    {multiComboLabel(value)}
                  </button>
                )}
              </For>
            </div>
            <ProductField controlId="multi-combo-search-control" label="Search options" layout="compact">
              <input
                id="multi-combo-search-control"
                data-testid="multi-combo-search"
                placeholder={typeof ed.spec?.options['placeholder'] === 'string' ? ed.spec.options['placeholder'] : 'Search options...'}
                ref={(el) => queueMicrotask(() => el.focus())}
                value={comboQuery()}
                onInput={(event) => {
                  comboHighlightSource = 'keyboard'
                  setComboQuery(event.currentTarget.value)
                  setComboIndex(0)
                }}
                onKeyDown={onComboKeyDown}
              />
            </ProductField>
            <ComboFolderNavigation />
            <div class="combo-options" role="listbox" aria-multiselectable="true">
              <Show when={remoteComboState()?.state === 'loading'}><div class="combo-status">loading remote options...</div></Show>
              <Show when={remoteComboState()?.state === 'stale'}><div class="combo-status">remote options stale</div></Show>
              <Show when={remoteComboState()?.state === 'unavailable'}><div class="combo-status">remote options unavailable</div></Show>
              <ComboMenuRows multi />
            </div>
            <Show when={ed.spec?.remote?.refreshButton === true}>
              <button type="button" class="combo-refresh" data-testid="multi-combo-refresh" onClick={() => loadRemoteOptions(ed.spec, true)}>refresh</button>
            </Show>
            <ProductActionFooter>
              <button type="button" data-testid="multi-combo-cancel" onClick={close}><Icon icon={X} /> Cancel</button>
              <button type="button" data-testid="multi-combo-clear" onClick={() => mutateMultiComboValues(() => [])}>Clear</button>
              <button type="button" class="primary" data-testid="multi-combo-apply" onClick={() => commitEditor(multiComboValues())}><Icon icon={Check} /> Apply</button>
            </ProductActionFooter>
          </div>
        </Show>
      </>
    </Show>
  )

  return (
    <Show
      when={ed.hostUi !== undefined}
      fallback={
        <Show
          when={inNode}
          fallback={
            <Show
              when={ed.spec?.widgetType === 'ASSET' || ed.spec?.widgetType === 'VIDEO_EDIT' || videoDocumentCommand !== undefined}
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
                dismissBlocked={assetUploading()}
                onRequestClose={() => { assetUploadAbort?.abort(); close() }}
                {...(props.onAssetBackdropPointerDown !== undefined
                  ? { onBackdropPointerDown: props.onAssetBackdropPointerDown }
                  : {})}
              >
                <p id="widget-editor-description" class="widget-modal-help">
                  {videoDocumentCommand !== undefined
                    ? message('videoDocument.help')
                    : ed.spec?.widgetType === 'VIDEO_EDIT'
                      ? 'Edit the one-clip trim and crop node inputs. Cancel or close leaves the stored values unchanged.'
                    : <>{usesLogicalModelSource()
                        ? `Browse models for ${ed.label}.`
                        : `Browse or upload ${withArticle(assetVocabulary().singular)}${assetBrowseKind() === 'data/latent' ? '.' : ` for ${ed.label}.`}`}
                      {' '}Cancel or close leaves the stored value unchanged.</>}
                </p>
                <EditorContent />
              </ModalSurface>
            </Show>
          }
        >
          <div class="palette-layer widget-popover-layer" data-testid="widget-popover-layer">
            <InNodeEditor />
          </div>
        </Show>
      }
    >
      <div class="palette-layer widget-popover-layer" data-testid="widget-popover-layer">
        <HostUiEditor />
      </div>
    </Show>
  )
}
