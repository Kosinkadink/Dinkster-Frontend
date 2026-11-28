import { createEffect, createMemo, createSignal as createSolidSignal, For, onCleanup, Show, type Component, type JSX } from 'solid-js'
import { assetMultiSelect, formatByteSize, rankSearch, type CollectionEntry, type CollectionPageRequest, type Json, type JsonObject } from '@dinkster/core'
import { ProductModelList, ProductTextButton, ProductTextInput, type ProductModel, type ProductModelVersion } from '@dinkster/ui'
import type { AssetGuessCandidate } from '@dinkster/client'
import { failureMessage } from '../request-failure.js'
import { FileImportError } from '../desktop-bridge.js'
import { Check, RotateCw, X } from 'lucide-solid'
import { AssetBrowserNavigation } from '../asset-browser/AssetBrowserNavigation.js'
import { assetCollectionSource, assetEntryPickable, assetItemOf } from '../asset-browser/collection-adapter.js'
import { assetSourcesStatus, assetUploadPolicy, committableAssetRef, mediaKindForAccept, VIEW_PREFERENCE_KEY } from '../asset-browser/helpers.js'
import { importAssetFile } from '../asset-browser/import-file.js'
import { mountAssetSource, mountAssetSources } from '../asset-browser/mountAssetSource.js'
import { localAssetSource } from '../asset-browser/localAssetSource.js'
import { localMountScanAdapter } from '../asset-browser/local-mount-logical-model.js'
import { ingestLogicalModels } from '../asset-browser/logical-model-merge.js'
import type { LogicalModel, LogicalModelVariant } from '../asset-browser/logical-model.js'
import { logicalModelVariantName, type LogicalModelPickDetail } from '../asset-browser/logical-model-collection-source.js'
import { AssetEntryContent, AssetEntryFallback } from '../asset-browser/presentation.js'
import { isModel3dMime, model3dMimeFor } from '../model3d-mime.js'
import { Model3dPosterImage } from '../Model3dPosterImage.js'
import { PreviewDownload } from '../PreviewDownload.js'
import { VideoPreview } from '../VideoPreview.js'
import { AudioRecorder } from '../AudioRecorder.js'
import { ProductActionFooter, ProductNotice } from '../ProductForm.js'
import { ProductButton, ProductFileInput } from '../ProductControls.js'
import { ProductSelect } from '../ProductSelect.js'
import { ProductEmptyState } from '../ProductSurfaces.js'
import { AssetSelectionDetails, LogicalModelVariantFacts } from '../asset-browser/rail.js'
import type { AssetBrowserItem, AssetSourceAdapter } from '../asset-browser/types.js'
import { CollectionPanel, type CollectionPanelState } from '../CollectionPanel.js'
import { Icon } from '../Icon.js'
import { assetGuessCandidateToRef } from '../dialog-requests.js'
import { SearchState } from '../SearchSurface.js'
import { WidgetEditorController, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'
import { AssetSelectionEditor } from './AssetSelectionEditor.js'
import { UploadDestination } from '../UploadDestination.js'
import { activeProjectId } from '../projects.js'
import { readUploadDestination, saveUploadDestination } from '../upload-destination.js'
import { AssetFileLocation } from '../AssetFileLocation.js'
import { useAppMessage } from '../locale.js'
import { tabDocumentUnchanged } from '../widget-editor-anchor.js'
import { AssetQuickList, assetQuickListAllowed } from './AssetQuickList.js'
import type { Backend } from '../app-state.js'
import type { WidgetEditorState } from '../WidgetEditorController.js'
import { rowPlacement, visibleCanvas } from './row-placement.js'

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
  readonly mime?: string
}

function AssetVideoPreview(props: {
  readonly preview: AssetPreview
  readonly onError: (error?: unknown) => void
  readonly onDimensions: (dimensions: { width: number; height: number }) => void
}) {
  const [preferences, setPreferences] = createSolidSignal({ autoplay: false, muted: false, loop: false })
  return <div class="asset-video-preview" data-testid="asset-video-preview">
    <VideoPreview media={{ kind: 'video', src: props.preview.src, ...(props.preview.mime ? { mime: props.preview.mime } : {}) }}
      preferences={preferences()} onPreferences={setPreferences} onMediaError={() => props.onError()}
      onDimensions={(dimensions) => {
        if (dimensions.width > 0 && dimensions.height > 0) props.onDimensions(dimensions)
      }} />
  </div>
}

interface AssetPickerVocabulary {
  readonly singular: string
  readonly plural: string
  readonly titlePlural: string
}

const withArticle = (noun: string): string => (/^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`)

const assetPickerNoun = (kind: string | undefined): string =>
  kind?.startsWith('model/') === true ? 'model'
    : kind === 'data/latent' ? 'latent'
      : kind === 'media/image' ? 'image'
        : kind === 'media/video' ? 'video'
          : kind === 'media/audio' ? 'audio' : 'file'

const isAssetRef = (value: unknown): value is AssetRef => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const asset = value as Partial<AssetRef>
  return typeof asset.digest === 'string' && typeof asset.name === 'string' && typeof asset.size === 'number' && typeof asset.mediaType === 'string' && typeof asset.virtualPath === 'string'
}
const isAssetRefArray = (value: unknown): value is readonly AssetRef[] => Array.isArray(value) && value.every(isAssetRef)

export function unresolvedAssetBasename(requested: string): string {
  return requested.split(/[\\/]/).filter(Boolean).at(-1) ?? requested
}

export { mediaAcceptsFile } from '../asset-browser/helpers.js'

function assetPickerState(state: CollectionPanelState, vocabulary: AssetPickerVocabulary, noun: string) {
  if (state.kind === 'loading') return <SearchState kind="loading" title={`Loading ${vocabulary.plural}`} detail={`Searching ${state.sourceLabel}.`} />
  const plural = noun === 'audio' ? noun : `${noun}s`
  return <ProductEmptyState title={state.query ? `No ${plural} match "${state.query}".` : `No ${plural} found.`} />
}

export interface AssetFilePickerProps {
  readonly state: Pick<WidgetEditorState, 'spec' | 'declaredType' | 'mergeableTypes' | 'sourceFilename' | 'initial' | 'missingAssetDigest' | 'stagedFile'>
  readonly backend: () => Backend
  readonly uploadLimits?: Readonly<Record<string, number>> | null
  /** The host still owns the selection on the same backend. */
  readonly current: () => boolean
  /** An automatic import may commit only while its original target is unchanged. */
  readonly unchanged: () => boolean
  readonly close: () => void
  readonly commitValue: (value: Json) => Promise<boolean>
  setDismissBlocked: (blocked: () => boolean) => void
  setRequestClose: (handler: (close: () => void) => void) => void
  commitImportedFile?: boolean | undefined
}

export const AssetFilePicker: Component<AssetFilePickerProps> = (props) => {
  const message = useAppMessage()
  const ed = props.state
  const close = props.close
  const commitEditorValue = props.commitValue
  let live = true
  onCleanup(() => { live = false })
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
  let assetScroll: HTMLDivElement | undefined
  createEffect(() => {
    if (assetError() === undefined) return
    queueMicrotask(() => {
      if (live) assetScroll?.querySelector('.asset-error')?.scrollIntoView({ block: 'nearest' })
    })
  })
  const [assetUploading, setAssetUploading] = createSolidSignal(false)
  const uploadBackend = props.backend()
  const project = activeProjectId()
  let connectionChanged = false
  const unsubscribeConnection = uploadBackend.connection.status.subscribe(() => { connectionChanged = true })
  onCleanup(unsubscribeConnection)
  const pickerContextCurrent = (): boolean =>
    live && !connectionChanged && props.unchanged() && activeProjectId() === project
  const [destination, setDestination] = createSolidSignal(readUploadDestination(String(uploadBackend.id), project))
  const [destinationOpen, setDestinationOpen] = createSolidSignal(false)
  const [uploadedLocation, setUploadedLocation] = createSolidSignal('')
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
  const [recursive, setRecursive] = createSolidSignal(true)
  const [sort, setSort] = createSolidSignal<NonNullable<CollectionPageRequest['sort']>>('newest')
  const [assetSourcesError, setAssetSourcesError] = createSolidSignal<string | undefined>(undefined)
  const [mountDiscoveryError, setMountDiscoveryError] = createSolidSignal<string | undefined>(undefined)
  const [logicalModels, setLogicalModels] = createSolidSignal<readonly LogicalModel[] | undefined>(undefined)
  const [logicalModelsError, setLogicalModelsError] = createSolidSignal<string | undefined>(undefined)
  const [logicalModelsLoading, setLogicalModelsLoading] = createSolidSignal(false)
  const [modelQuery, setModelQuery] = createSolidSignal('')
  const [modelFolder, setModelFolder] = createSolidSignal('')
  const [inspectedModel, setInspectedModel] = createSolidSignal<{ modelId: string; versionId: string }>()
  const unresolvedAsset = ed.spec?.selection !== true && typeof ed.initial === 'string' ? ed.initial : undefined
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
  const assetVocabulary = (): AssetPickerVocabulary => {
    const singular = assetPickerNoun(assetBrowseKind())
    const plural = singular === 'audio' ? singular : `${singular}s`
    return { singular, plural, titlePlural: plural[0]!.toUpperCase() + plural.slice(1) }
  }
  // Multi-select (typed-assets pin (5)): the declared outer type gates it -
  // list<asset<T>> / list<ASSET> pick N descriptors committed as ONE
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
  const policy = assetUploadPolicy(uploadKind, props.uploadLimits)
  const assetUploadLimitLabel = policy.label === undefined ? undefined : `${policy.label} per file`
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
  const stageAssetSelection = async (
    change: (current: readonly AssetRef[]) => readonly AssetRef[],
    published: () => void = () => {},
  ): Promise<boolean> => {
    if (!live || !props.current() || activeProjectId() !== project) return false
    setAssetSelection(change(assetSelection()))
    setAssetError(undefined)
    published()
    return true
  }
  const sameAssetRef = (a: AssetRef, b: AssetRef): boolean =>
    a.digest === b.digest && a.virtualPath === b.virtualPath
  /** Append in selection order; picking an already-selected asset removes it. */
  const toggleAssetSelection = (ref: AssetRef, published?: () => void): Promise<boolean> =>
    stageAssetSelection((current) =>
      current.some((r) => sameAssetRef(r, ref))
        ? current.filter((r) => !sameAssetRef(r, ref))
        : [...current, ref],
      published,
    )
  const removeAssetSelection = (ref: AssetRef, index: number): void => {
    if (!sourceUpload) {
      void toggleAssetSelection(ref)
      return
    }
    void stageAssetSelection((current) => [...current.slice(0, index), ...current.slice(index + 1)])
  }
  /** Generic picks deduplicate; source lists preserve upload order and duplicates. */
  const addAssetSelection = (ref: AssetRef): Promise<boolean> =>
    stageAssetSelection((current) =>
      sourceUpload ? [...current, ref] : current.some((r) => sameAssetRef(r, ref)) ? current : [...current, ref],
    )
  let ownedAssetUrl: string | undefined
  let assetPreviewRequest = 0
  let assetPreviewAbort: AbortController | undefined
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
    assetPreviewAbort?.abort()
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
    assetPreviewAbort?.abort()
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
    const backend = props.backend()
    if (backend.protocol !== 'dinkster') {
      clearAssetPreview()
      setAssetError('Asset previews require a native Dinkster backend')
      return
    }
    const request = ++assetPreviewRequest
    assetPreviewAbort?.abort()
    const abort = new AbortController()
    assetPreviewAbort = abort
    try {
      const bytes = await backend.connection.fetchAssetBytes(ref.digest, abort.signal)
      if (!live || request !== assetPreviewRequest || abort.signal.aborted || bytes === undefined ||
        props.backend() !== backend || activeProjectId() !== project) return
      const url = URL.createObjectURL(new Blob([bytes], { type: ref.mediaType }))
      replaceAssetPreview({ kind, src: url, name: ref.name,
        ...(kind === 'model3d' ? { mime: ref.mediaType } : {}),
      }, url)
    } catch (error) {
      if (live && request === assetPreviewRequest) setAssetError(failureMessage(error))
    }
  }
  onCleanup(() => {
    assetPreviewAbort?.abort()
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
      const sourceErrors: string[] = []
      const scoped = modelFolder() === '' ? sources : sources.filter((source) => source.id === modelFolder())
      const localAdapter = await localMountScanAdapter(scoped, kind, assetAccept(), {
        signal: abort.signal,
        onSourceError: (message) => sourceErrors.push(message),
      })
      const result = ingestLogicalModels([localAdapter])
      if (!live || load !== logicalModelLoad) return
      setLogicalModels(result.models)
      const errors = [...sourceErrors, ...result.diagnostics.map((entry) => entry.message)]
      if (errors.length > 0) setLogicalModelsError(errors.join('; '))
    } catch (error) {
      if (live && load === logicalModelLoad) setLogicalModelsError(failureMessage(error))
    } finally {
      if (live && load === logicalModelLoad) setLogicalModelsLoading(false)
    }
  }

  if (ed.spec?.widgetType === 'ASSET') {
    const backend = props.backend()
    const asset = isAssetRef(ed.initial) ? ed.initial : isAssetRefArray(ed.initial) ? ed.initial[0] : undefined
    if (asset !== undefined && backend.protocol === 'dinkster') {
      void stageAssetSelection((current) => current, () => {
        if (asset.digest !== ed.missingAssetDigest) void publishAssetRefPreview(asset)
      })
    }
    if (backend.protocol !== 'dinkster') {
      setAssetSourcesError('Asset browsing requires a native Dinkster backend')
    } else {
      const local = usesLogicalModelSource() ? [localAssetSource(backend.connection)] : []
      if (local.length > 0) setAssetSources(local)
      void mountAssetSources(backend.connection, assetBrowseKind()).then((sources) => {
        if (!live) return
        const combined = [...local, ...sources]
        setAssetSources(combined)
        void loadLogicalModels(combined)
      }).catch((reason: unknown) => {
        if (!live) return
        setAssetSources(local)
        setMountDiscoveryError(failureMessage(reason, 'Folders could not be loaded.'))
        void loadLogicalModels(local)
      })
    }
  }

  /**
   * Upload one file and stage/commit it. Returns false when the batch must
   * stop: a validation or upload failure (its error must stay visible - a
   * later success would clear it) or an editor that closed mid-flight.
   * The CALLER owns the assetUploading flag so a multi-file batch stays
   * busy end to end instead of flickering between files.
   */
  const pickAsset = async (file: File, signal: AbortSignal): Promise<boolean> => {
    if (ed.spec?.widgetType !== 'ASSET') return false
    const backend = props.backend()
    if (backend.protocol !== 'dinkster') {
      setAssetError('Asset uploads require a native Dinkster backend')
      return false
    }
    if (!props.current()) return false
    setAssetError(undefined)
    publishLocalAssetPreview(file)
    const current = (): boolean => live && !signal.aborted &&
      props.backend() === backend && activeProjectId() === project
    try {
      const choice = destination()
      const result = await importAssetFile(file, {
        baseUrl: backend.baseUrl, connection: backend.connection, accept: assetAccept(), kind: uploadKind,
        policy, destination: choice, current, signal,
      })
      if (result === undefined) return false
      const { asset: ref, existing } = result
      if (!classifiedLatent || existing) {
        setUploadedLocation(`${existing ? 'Using existing file; no copy made. ' : ''}${backend.label}: ${ref.virtualPath}`)
        if (!existing) {
          try { saveUploadDestination(String(backend.id), project, choice) } catch { /* A successful import remains usable when preference storage is full. */ }
        }
      }
      // Uploads stage into the selection like browsed picks; the footer
      // Apply button commits. The local file preview is already showing.
      if (assetMulti) {
        if (!await addAssetSelection(ref)) return false
        void publishAssetRefPreview(ref)
      } else {
        if (!await stageAssetSelection(() => [ref])) return false
      }
      setAssetSelectedItem(undefined)
      setAssetSelectedModel(undefined)
      return true
    } catch (error) {
      if (current()) {
        setAssetError(error instanceof FileImportError ? error.message : failureMessage(error))
      }
      return false
    }
  }

  /**
   * Upload chosen files in order. Sequential on purpose: parallel uploads
   * would race the shared error slot. The batch stops at the first failed or
   * refused file (its error must stay visible) and when the editor closes
   * mid-flight.
   */
  const uploadFiles = (files: readonly File[]): void => {
    void (async () => {
      const abort = new AbortController()
      assetUploadAbort = abort
      setAssetUploading(true)
      try {
        for (const file of assetMulti ? files : files.slice(0, 1)) {
          if (!live || abort.signal.aborted || !(await pickAsset(file, abort.signal))) break
          if (props.commitImportedFile && !assetMulti && pickerContextCurrent()) {
            await commitEditorValue(assetSelection()[0]!)
          }
        }
      } finally {
        if (assetUploadAbort === abort) assetUploadAbort = undefined
        if (live) {
          setAssetUploading(false)
          setDestination(readUploadDestination(String(uploadBackend.id), project))
          restoreAssetUploadFocus()
        }
      }
    })()
  }
  // A button's PasteImage opens the picker with the clipboard image already uploading.
  if (ed.stagedFile !== undefined) queueMicrotask(() => uploadFiles([ed.stagedFile!]))

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
      void toggleAssetSelection(ref, () => {
        if (assetSelection().some((selected) => sameAssetRef(selected, ref))) void publishAssetRefPreview(ref)
      })
      return
    }
    void stageAssetSelection(() => [ref], () => { void publishAssetRefPreview(ref) })
  }

  const pickLogicalModelRef = (ref: AssetRef, detail: LogicalModelPickDetail): void => {
    if (assetUploading()) return
    setAssetSelectedItem(undefined)
    if (!assetMulti) {
      void stageAssetSelection(() => [ref], () => {
        setAssetSelectedModel(detail)
        void publishAssetRefPreview(ref)
      })
      return
    }
    void stageAssetSelection((current) =>
      current.some((selected) => selected.digest === ref.digest)
        ? current.filter((selected) => selected.digest !== ref.digest)
        : [...current, ref],
      () => setAssetSelectedModel(assetSelection().some((selected) => selected.digest === ref.digest) ? detail : undefined),
    )
  }

  const retryAssetMatch = async (): Promise<void> => {
    if (unresolvedAsset === undefined) return
    const backend = props.backend()
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
      if (live) setAssetMatchError(failureMessage(error))
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
    const backend = props.backend()
    return backend.protocol === 'dinkster' ? (digest) => backend.connection.assetUrl(digest) : undefined
  }
  const assetPanelSources = createMemo(() => {
    const adapters = assetSources() ?? []
    const assetUrl = assetUrlOf()

    const fixedKind = assetBrowseKind()
    if (usesLogicalModelSource()) return []
    if (adapters.length === 0) return []
    const connection = props.backend().connection
    return [mountAssetSource(connection, adapters.map((adapter) => adapter.id.slice('mount:'.length))), ...adapters].map((adapter) => ({
      ...assetCollectionSource(adapter, {
        ...(assetUrl !== undefined ? { assetUrl } : {}),
        ...(fixedKind !== undefined ? { fixedKind } : {}),
      }),
      label: adapter.id === 'all-mounts' ? message('assets.mounts.all') : adapter.label,
      filters: [],
    }))
  })
  const modelId = (model: LogicalModel): string => JSON.stringify([model.kind, model.logicalId])
  const modelVersionId = (variant: LogicalModelVariant): string => JSON.stringify([variant.variantId, variant.digest ?? null])
  const modelRows = createMemo<readonly ProductModel[]>(() => rankSearch(modelQuery(), logicalModels() ?? [], (model) => [
    { text: model.displayName, weight: 3 },
    ...model.aliases.map((text) => ({ text, weight: 2 })),
    ...model.variants.map((variant) => ({ text: logicalModelVariantName(variant), weight: 3 })),
  ]).filter((model) => model.variants.length > 0).map((model) => ({
    id: modelId(model), name: model.displayName, kind: model.kind,
    versions: model.variants.map((variant): ProductModelVersion => ({
      id: modelVersionId(variant), name: logicalModelVariantName(variant),
      state: variant.localRef !== undefined ? 'installed'
        : variant.availability === 'downloadable' ? 'not-downloaded'
          : variant.availability === 'resolving' ? 'checking' : 'unavailable',
      ...(variant.size !== undefined ? { size: formatByteSize(variant.size) } : {}),
      ...(variant.precision !== undefined ? { precision: variant.precision } : {}),
    })),
  })))
  const modelDetail = (id: string, versionId: string): LogicalModelPickDetail | undefined => {
    const model = logicalModels()?.find((candidate) => modelId(candidate) === id)
    const variant = model?.variants.find((candidate) => modelVersionId(candidate) === versionId)
    return model !== undefined && variant !== undefined
      ? { modelName: model.displayName, aliases: model.aliases, variant } : undefined
  }
  const inspectedModelDetail = (): LogicalModelPickDetail | undefined => {
    const keys = inspectedModel()
    return keys !== undefined ? modelDetail(keys.modelId, keys.versionId) : undefined
  }
  const selectedModelKeys = createMemo(() => (logicalModels() ?? []).flatMap((model) => model.variants
    .filter((variant) => variant.localRef !== undefined && assetSelection().some((ref) => ref.digest === variant.localRef?.digest))
    .map((variant) => ({ modelId: modelId(model), versionId: modelVersionId(variant) }))))
  const pickAssetEntry = (entry: CollectionEntry): void => {
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
    return assetSelection().some((ref) => matchesRef(entry, ref))
  }


  props.setDismissBlocked(assetUploading)
  props.setRequestClose((finish) => { assetUploadAbort?.abort(); finish() })
  const renderFooter = (summary?: JSX.Element, validFolder: () => boolean = () => true) => <ProductActionFooter
    status={<div class="asset-import-line">
      <Show when={!usesLogicalModelSource()}>
        <ProductTextButton data-testid="asset-upload-trigger" ref={(element) => { assetUploadTrigger = element }}
          label={assetUploading() ? 'Uploading...' : message('assets.quickList.add')}
          disabled={assetUploading() || !validFolder()} onClick={() => assetUploadInput?.click()} />
        {summary}
        <Show when={assetUploadLimitLabel}>{(label) => <span>{message('uploadDestination.limit', { limit: label() })}</span>}</Show>
      </Show>
    </div>}>
    <ProductFileInput ref={(element) => { assetUploadInput = element }} multiple={assetMulti}
      accept={Array.isArray(ed.spec?.options['accept']) ? (ed.spec!.options['accept'] as string[]).join(',') : ''}
      disabled={assetUploading() || usesLogicalModelSource() || !validFolder()}
      onCancel={() => { setDestination(readUploadDestination(String(uploadBackend.id), project)); restoreAssetUploadFocus() }}
      onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? [])
        event.currentTarget.value = ''
        uploadFiles(files)
      }} />
    <button type="button" onClick={abortAssetUploadAndClose}>Cancel</button>
    <button type="button" class="primary" data-testid="asset-apply" disabled={assetUploading()}
      onClick={() => {
        if (!pickerContextCurrent()) { setAssetError(message('widgetEditor.commitRefused')); return }
        const selection = assetSelection()
        if (!assetMulti) { commitEditorValue(selection[0] ?? null); return }
        const committed = usesLogicalModelSource()
          ? selection.filter((ref, index) => selection.findIndex((candidate) => candidate.digest === ref.digest) === index)
          : selection
        commitEditorValue(assetScalarMerge && committed.length === 0 ? null : [...committed])
      }}>
      <Icon icon={Check} /> {assetMulti
        ? `Use ${assetSelection().length} ${assetSelection().length === 1 ? assetVocabulary().singular : assetVocabulary().plural}`
        : `Use ${assetVocabulary().singular}`}
    </button>
  </ProductActionFooter>
  const destinationPicker = {
    get expanded() { return destinationOpen() },
    onToggle: () => setDestinationOpen((open) => !open),
    footer: renderFooter,
  }
  return (
    <>
          {/* Escape and outside dismissal refuse while an upload batch runs;
              explicit Cancel remains the recovery path and aborts the owned
              upload before closing. The host's window-capture dismissal runs
              before this body sees the event, so the refusal is advertised
              through data-dismiss-blocked. */}
          <div class="widget-editor asset-editor widget-modal-editor" classList={{ 'asset-file-picker': !usesLogicalModelSource() }} data-testid="asset-editor" data-dismiss-blocked={assetUploading() ? 'uploading' : undefined}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.defaultPrevented && destinationOpen()) {
                event.preventDefault(); event.stopPropagation(); setDestinationOpen(false)
                queueMicrotask(() => assetUploadTrigger?.parentElement?.querySelector<HTMLButtonElement>('[aria-expanded]')?.focus())
              }
            }}>
            <div class="asset-editor-scroll" ref={assetScroll}>
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
                        <span class="asset-match-candidate-size">{formatByteSize(candidate.size!)}</span>
                        <code title={candidate.digest}>{candidate.digest}</code>
                      </button>
                    )}
                  </For>
                </div>
                <ProductNotice tone="info" testId="asset-not-on-disk">{message('assets.logicalModel.notOnDisk')}</ProductNotice>
              </section>
            </Show>
            <Show when={assetError()}>{(message) => <ProductNotice tone="error" class="asset-error">{message()}</ProductNotice>}</Show>
            <div class="asset-editor-body">
            <section class="asset-browser-section" aria-label={assetVocabulary().titlePlural}>
              <Show when={usesLogicalModelSource()}>
                <ProductButton data-testid="logical-model-refresh" disabled={logicalModelsLoading()} onClick={() => { void loadLogicalModels(assetSources() ?? []) }}>
                  <Icon icon={RotateCw} /> Refresh
                </ProductButton>
              </Show>
              <Show when={assetSourcesError()}>{(message) => <ProductNotice tone="error" class="asset-error">{message()}</ProductNotice>}</Show>
              <Show when={mountDiscoveryError()}>{(message) => <ProductNotice tone="error" class="asset-error">{message()}</ProductNotice>}</Show>
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
                  <Show when={usesLogicalModelSource()} fallback={<CollectionPanel
                    variant="select"
                    sources={assetPanelSources()}
                    pageSize={60}
                    pagination="scroll"
                    recursive={recursive()}
                    sort={sort()}
                    navigation={({ selectedId, select, folder, navigate, mode, setMode, firstLoadFailed }) =>
                        <AssetBrowserNavigation sources={assetPanelSources()} selectedId={selectedId()} select={select}
                          folder={folder()} navigate={navigate} recursive={recursive()} setRecursive={setRecursive}
                          mode={mode()} setMode={setMode} firstLoadFailed={firstLoadFailed()} />}
                    entryContent={(entry) => <AssetEntryContent entry={entry()} />}
                    toolbarActions={<ProductSelect testId="asset-sort-select"
                      ariaLabel={message('assets.order.label')} selectedId={sort()}
                      options={(['newest', 'name', 'path'] as const).map((value) => ({ id: value, label: message(`assets.order.${value}`), value }))}
                      onSelect={(option) => setSort(option.value)} />}
                    pick={{
                      pickable: assetEntryPickable(assetAccept(), assetBrowseKind()),
                      onPick: pickAssetEntry,
                      selected: matchesCurrentAsset,
                      multi: assetMulti,
                    }}
                    initialSelection={matchesCurrentAsset}
                    modeKey={VIEW_PREFERENCE_KEY}
                    defaultMode={assetBrowseKind()?.startsWith('media/') === true ? 'grid' : 'list'}
                    searchPriority="primary"
                    searchLabel={`Search ${assetVocabulary().plural}`}
                    searchPlaceholder={`Search ${assetVocabulary().plural}`}
                    renderState={(state) => assetPickerState(state, assetVocabulary(), assetPickerNoun(assetBrowseKind()))}
                    entryFallback={(entry) => <AssetEntryFallback entry={entry} />}
                  />}>
                    <ProductTextInput type="search" aria-label={message('assets.models.search')} placeholder={message('assets.models.search')} value={modelQuery()}
                      onInput={(event) => setModelQuery(event.currentTarget.value)} />
                    <ProductSelect testId="asset-model-folder" ariaLabel={message('assets.models.folder')} selectedId={modelFolder()}
                      options={[
                        { id: '', value: '', label: message('assets.models.allFolders') },
                        ...(assetSources() ?? []).filter((source) => source.id.startsWith('mount:'))
                          .map((source) => ({ id: source.id, value: source.id, label: source.label })),
                      ]}
                      onSelect={(option) => {
                        setModelFolder(option.value)
                        setLogicalModels(undefined)
                        setInspectedModel(undefined)
                        void loadLogicalModels(assetSources() ?? [])
                      }} />
                    <ProductModelList label={message('assets.models.title')} models={modelRows()} selected={selectedModelKeys()} inlineDetails={false}
                      onSelect={(modelId, versionId) => setInspectedModel({ modelId, versionId })}
                      onChoose={(id, versionId) => {
                        const detail = modelDetail(id, versionId)
                        if (detail?.variant.localRef !== undefined) pickLogicalModelRef(detail.variant.localRef, detail)
                      }} />
                    <Show when={modelRows().length === 0 && !logicalModelsLoading()}>
                      <SearchState kind="empty" title={modelQuery().trim() ? 'No matching models' : 'No models yet'}
                        detail={modelQuery().trim() ? 'Try another search.' : 'No mounted models are available.'} />
                    </Show>
                  </Show>
                </Show>
              </Show>
            </section>
            <section class="asset-selection-summary" data-testid="asset-selection-summary" aria-label="Selection">
              <header class="asset-section-heading">
                <div>
                  <h3>{assetMulti && assetSelection().length > 0
                    ? `${assetSelection().length} selected`
                    : assetSelection()[0]?.name ?? 'Nothing selected'}</h3>
                </div>
                <Show when={!assetMulti ? assetSelection()[0]?.size : undefined}>
                  {(size) => <span>{formatByteSize(size())}</span>}
                </Show>
              </header>
              <Show when={assetPreview()}>
                {(preview) => (
                  <Show when={preview().kind !== 'model3d'} fallback={
                    <Model3dPosterImage src={preview().src} name={preview().name} mime={preview().mime} />
                  }>
                  <Show when={preview().kind === 'video'} fallback={
                    <Show when={!assetPreviewFailed()} fallback={
                      <div class="asset-preview asset-preview-fallback" data-testid="asset-image-fallback" role="status">
                        <span>Image preview unavailable.</span>
                        <PreviewDownload class="" download={preview()} label="Open or download image" />
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
                        <PreviewDownload class="" download={preview()} label="Download video" />
                      </div>
                    }>
                      <AssetVideoPreview
                        preview={preview()}
                        onError={(error) => {
                          if (error !== undefined) setAssetError(failureMessage(error, 'Video preview unavailable.'))
                          setAssetPreviewFailed(true)
                        }}
                        onDimensions={setAssetPreviewDims}
                      />
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
                {(item) => <AssetSelectionDetails item={item} dimensions={assetPreviewDims()} adapters={assetSources() ?? []} backendId={String(props.backend().id)} />}
              </Show>
              <Show when={inspectedModelDetail() ?? selectionDetailModel()} keyed>
                {(detail) => <LogicalModelVariantFacts detail={detail} />}
              </Show>
              <Show when={assetSelection().length > 0}>
                {/* Clearing only stages an empty selection: nothing commits
                    before the footer commit, Cancel restores the stored
                    value. */}
                <button
                  type="button"
                  class="asset-selection-remove"
                  data-testid="asset-selection-remove"
                  disabled={assetUploading()}
                  onClick={() => { void stageAssetSelection(() => [], () => { setAssetSelectedItem(undefined); setAssetSelectedModel(undefined); setInspectedModel(undefined); clearAssetPreview() }) }}
                >
                  <Icon icon={X} /> {message('assets.selection.clear')}
                </button>
              </Show>
            </section>
            </div>
            <Show when={uploadBackend.protocol === 'dinkster' ? uploadBackend : undefined} keyed>
              {(backend) => <For each={assetSelection()}>{(ref) => <AssetFileLocation connection={backend.connection}
                backendUrl={backend.baseUrl} digest={ref.digest} project={project}
                isCurrent={() => live && props.backend() === backend && activeProjectId() === project} />}</For>}
            </Show>
            <Show when={classifiedMediaKind === 'media/audio' && ed.spec?.allowUpload === true}>
              <AudioRecorder disabled={assetUploading()} onSave={async (file) => {
                const abort = new AbortController()
                assetUploadAbort = abort
                setAssetUploading(true)
                try { return await pickAsset(file, abort.signal) }
                finally {
                  if (assetUploadAbort === abort) assetUploadAbort = undefined
                  if (live) {
                    setAssetUploading(false)
                    setDestination(readUploadDestination(String(uploadBackend.id), project))
                  }
                }
              }} />
            </Show>
            <Show when={uploadedLocation()}><ProductNotice tone="status">{uploadedLocation()}</ProductNotice></Show>
            </div>
            <Show when={!classifiedLatent && !usesLogicalModelSource() && uploadBackend.protocol === 'dinkster' ? uploadBackend : undefined}
              keyed fallback={renderFooter()}>
              {(backend) => <UploadDestination connection={backend.connection} machine={backend.label} value={destination()}
                disabled={assetUploading()} onChange={setDestination} picker={destinationPicker} />}
            </Show>
          </div>

    </>
  )
}

const AssetEditorImplementation: Component<WidgetEditorImplementationProps & Pick<AssetFilePickerProps,
  'setDismissBlocked' | 'setRequestClose' | 'commitImportedFile'>> = (props) => {
  const host = props.editor
  const ed = host.ed
  const backend = host.app.backendForTab(ed.tab)
  const openedTab = ed.tab
  const store = openedTab.store
  const document = store.doc
  const revision = store.revision
  const registry = host.app.registryForTab(openedTab)
  const current = (): boolean => host.app.backendForTab(ed.tab) === backend
  const unchanged = (): boolean => openedTab.store === store && store.doc === document && store.revision === revision &&
    (ed.tab === openedTab || host.app.liveTabContinuing(store) === ed.tab) &&
    tabDocumentUnchanged(openedTab, revision, ed.tab) && host.app.tabs.get().includes(ed.tab) &&
    current() && host.app.registryForTab(ed.tab) === registry
  return <AssetFilePicker state={ed} backend={() => host.app.backendForTab(ed.tab)}
    {...(registry?.uploadLimits === undefined ? {} : { uploadLimits: registry.uploadLimits })}
    current={current} unchanged={unchanged} close={props.close} commitValue={props.commitValue}
    setDismissBlocked={props.setDismissBlocked} setRequestClose={props.setRequestClose}
    commitImportedFile={props.commitImportedFile} />
}

const AssetPickerWidgetEditor: Component<WidgetEditorProps & { commitImportedFile?: boolean | undefined }> = (props) => {
  const accept = (): readonly string[] => {
    const value = props.ed.spec?.options['accept']
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  }
  const kind = () => typeof props.ed.spec?.kind === 'string' && props.ed.spec.kind !== '' ? props.ed.spec.kind : mediaKindForAccept(accept())
  const [dismissBlocked, setDismissBlocked] = createSolidSignal(false)
  const fileSelectionAllowed = () => kind() === 'model/vae' && props.ed.declaredType?.kind === 'union' &&
    props.ed.declaredType.names.includes('ASSET')
  const initialFiles = props.ed.spec?.selection !== true || (fileSelectionAllowed() && isAssetRef(props.ed.initial))
  const [browseFiles, setBrowseFiles] = createSolidSignal(initialFiles)
  const [filesVisited, setFilesVisited] = createSolidSignal(initialFiles)
  const [sourceVisited, setSourceVisited] = createSolidSignal(!initialFiles)
  const [backendTick, setBackendTick] = createSolidSignal(0)
  if (props.ed.spec?.selection === true) {
    setBackendTick(props.app.backendsTick.get())
    const unsubscribe = props.app.backendsTick.subscribe(setBackendTick)
    onCleanup(unsubscribe)
  }
  const sourceBackend = createMemo(() => {
    backendTick()
    return props.app.backendForTab(props.ed.tab)
  })
  const sourceAuthority = () => {
    backendTick()
    return sourceBackend().scopedClient.remoteChoiceAuthority()
  }
  let requestClose: (close: () => void) => void = (close) => close()
  const Implementation: Component<WidgetEditorImplementationProps> = (implementationProps) => {
    const bindDismissBlocked = (blocked: () => boolean): void => {
      createEffect(() => setDismissBlocked(blocked()))
    }
    return (
      <>
      <Show when={filesVisited()}><div class="asset-editor-mode" hidden={!browseFiles()}>
        <Show when={props.ed.spec?.selection === true}>
          <ProductButton onClick={() => { setSourceVisited(true); setBrowseFiles(false) }}>Back to source options</ProductButton>
        </Show>
        <AssetEditorImplementation
          {...implementationProps}
          commitImportedFile={props.commitImportedFile}
          setDismissBlocked={bindDismissBlocked}
          setRequestClose={(handler) => { requestClose = handler }}
        />
      </div></Show>
      <Show when={sourceVisited()}><div class="asset-editor-mode" hidden={browseFiles()}>
        <Show when={sourceBackend().connection} fallback={<ProductNotice tone="error">Source selections require a native Dinkster backend.</ProductNotice>}>
          {(connection) =>
          <AssetSelectionEditor
            connection={connection()}
            kind={kind()!} initial={props.ed.initial}
            authority={sourceAuthority} project={activeProjectId()}
            commit={implementationProps.commitValue} close={implementationProps.close}
            browseFiles={fileSelectionAllowed() ? () => { setFilesVisited(true); setBrowseFiles(true) } : undefined}
          />
          }
        </Show>
      </div></Show>
      </>
    )
  }
  return (
    <WidgetEditorController
      {...props}
      implementation={Implementation}
      modal={{
        type: 'ASSET',
        title: `Choose ${assetPickerNoun(kind())}`,
        dismissBlocked,
        onRequestClose: (close) => requestClose(close),
        help: undefined,
      }}
    />
  )
}

export const AssetWidgetEditor: Component<WidgetEditorProps> = (props) => {
  const [picker, setPicker] = createSolidSignal(props.ed.inRow === undefined || props.ed.stagedFile !== undefined ||
    !assetQuickListAllowed(props.ed.spec, props.ed.declaredType, props.ed.mergeableTypes))
  const [file, setFile] = createSolidSignal<File>()
  const QuickList: Component<WidgetEditorImplementationProps> = (implementation) => {
    const ed = props.ed
    const inRow = ed.inRow!
    const backend = props.app.backendForTab(ed.tab)
    const openedTab = ed.tab
    const store = openedTab.store
    const revision = store.revision
    const registry = props.app.registryForTab(openedTab)
    const current = (): boolean => openedTab.store === store && store.revision === revision &&
      tabDocumentUnchanged(openedTab, revision, ed.tab) && props.app.tabs.get().includes(ed.tab) &&
      props.app.backendForTab(ed.tab) === backend && props.app.registryForTab(ed.tab) === registry
    const bounds = visibleCanvas(props.boundary)
    const placement = createMemo(() => rowPlacement({ rect: ed.rect, ...inRow }, props.viewport(), bounds(), { width: 0, height: 0 }))
    return <AssetQuickList state={ed} backend={backend} current={current} placement={placement} bounds={bounds} look={inRow.look}
      {...(registry?.uploadLimits === undefined ? {} : { uploadLimits: registry.uploadLimits })}
      {...(inRow.handOff === undefined ? {} : { handOff: inRow.handOff })}
      {...(props.bindClickAway === undefined ? {} : { bindClickAway: props.bindClickAway })}
      focusRow={() => { if (ed.target.kind === 'input') props.focusRow?.(ed.target) }}
      moveRow={(direction) => { if (ed.target.kind === 'input') props.moveRow?.(ed.target, direction) }}
      close={implementation.close} commitValue={implementation.commitValue}
      commitPending={implementation.commitPending} commitError={implementation.commitError}
      browse={() => setPicker(true)} add={(chosen) => {
        if (props.onAssetFileImport !== undefined) {
          props.onAssetFileImport(chosen)
          implementation.close()
        } else {
          setFile(chosen)
          setPicker(true)
        }
      }} />
  }
  return <Show when={picker()} fallback={<WidgetEditorController {...props} implementation={QuickList} />}>
    <AssetPickerWidgetEditor {...props} ed={file() === undefined ? props.ed : { ...props.ed, stagedFile: file()! }}
      commitImportedFile={file() !== undefined} />
  </Show>
}
