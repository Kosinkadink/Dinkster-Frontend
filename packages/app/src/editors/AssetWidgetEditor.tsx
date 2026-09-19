import { createEffect, createMemo, createSignal as createSolidSignal, For, onCleanup, Show, type Component } from 'solid-js'
import { assetMultiSelect, type CollectionEntry, type JsonObject } from '@dinkster/core'
import { AssetDtoV1Client, type AssetGuessCandidate, type CandidateV1 } from '@dinkster/client'
import { Check, RotateCw, Upload, X } from 'lucide-solid'
import { assetCollectionSource, assetEntryPickable, assetItemOf } from '../asset-browser/collection-adapter.js'
import { assetSourcesStatus, committableAssetRef, formatSize, mediaKindForAccept, VIEW_PREFERENCE_KEY } from '../asset-browser/helpers.js'
import { mountAssetSources } from '../asset-browser/mountAssetSource.js'
import { localMountScanAdapter } from '../asset-browser/local-mount-logical-model.js'
import { ingestLogicalModels } from '../asset-browser/logical-model-merge.js'
import { candidateLogicalModelAdapter } from '../asset-browser/candidate-logical-model.js'
import { allAssetsCollectionSource, mountPresentationClass } from '../asset-browser/cross-mount-collection-source.js'
import type { LogicalModel } from '../asset-browser/logical-model.js'
import { logicalModelAssetRefOf, logicalModelCollectionSource, logicalModelEntrySelectable, logicalModelEntryVisible, logicalModelPickDetailOf, type LogicalModelPickDetail } from '../asset-browser/logical-model-collection-source.js'
import { AssetEntryFallback } from '../asset-browser/presentation.js'
import { isModel3dMime, model3dMimeFor } from '../model3d-mime.js'
import { Model3dPosterImage } from '../Model3dPosterImage.js'
import { AudioRecorder } from '../AudioRecorder.js'
import { ProductActionFooter, ProductNotice } from '../ProductForm.js'
import { AssetSelectionDetails, LogicalModelVariantFacts } from '../asset-browser/rail.js'
import type { AssetBrowserItem, AssetSourceAdapter } from '../asset-browser/types.js'
import { CollectionPanel, type CollectionPanelState } from '../CollectionPanel.js'
import { Icon } from '../Icon.js'
import { assetGuessCandidateToRef } from '../dialog-requests.js'
import { SearchState } from '../SearchSurface.js'
import { WidgetEditorController, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'

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

const withArticle = (noun: string): string => (/^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`)
const GENERIC_ASSET_VOCABULARY: AssetPickerVocabulary = { singular: 'asset', plural: 'assets', titlePlural: 'Assets', modalType: 'asset', uploadSingular: 'file', uploadPlural: 'files' }
const LATENT_ASSET_VOCABULARY: AssetPickerVocabulary = { singular: 'latent', plural: 'latents', titlePlural: 'Latents', modalType: 'latent asset', uploadSingular: 'latent', uploadPlural: 'latents' }
const MODEL_ASSET_VOCABULARY: AssetPickerVocabulary = { singular: 'model', plural: 'models', titlePlural: 'Models', modalType: 'asset', uploadSingular: 'model file', uploadPlural: 'model files' }

const isAssetRef = (value: unknown): value is AssetRef => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const asset = value as Partial<AssetRef>
  return typeof asset.digest === 'string' && typeof asset.name === 'string' && typeof asset.size === 'number' && typeof asset.mediaType === 'string' && typeof asset.virtualPath === 'string'
}
const isAssetRefArray = (value: unknown): value is readonly AssetRef[] => Array.isArray(value) && value.every(isAssetRef)

export function unresolvedAssetBasename(requested: string): string {
  return requested.split(/[\\/]/).filter(Boolean).at(-1) ?? requested
}

export function mediaAcceptsFile(accept: readonly string[], mediaType: string): boolean {
  if (mediaType === '') return false
  return accept.some((pattern) => pattern === mediaType || pattern === '*/*' || (pattern.endsWith('/*') && mediaType.startsWith(pattern.slice(0, -1))))
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

export function backendSupportsAssetAcquisition(): boolean { return false }

interface AssetImplementationProps extends WidgetEditorImplementationProps {
  setDismissBlocked: (blocked: () => boolean) => void
  setRequestClose: (handler: (close: () => void) => void) => void
}

const AssetEditorImplementation: Component<AssetImplementationProps> = (implementationProps) => {
  const props = implementationProps.editor
  const ed = props.ed
  const close = implementationProps.close
  const commitEditorValue = implementationProps.commitValue
  let live = true
  onCleanup(() => { live = false })
  // The tab owns backend affinity, so asset bytes use that tab's native
  // connection uses the editing tab's native client. Never fall back to the
  // default backend: identical digests are not proof that two
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


  implementationProps.setDismissBlocked(assetUploading)
  implementationProps.setRequestClose((finish) => { assetUploadAbort?.abort(); finish() })
  return (
    <>
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

    </>
  )
}

export const AssetWidgetEditor: Component<WidgetEditorProps> = (props) => {
  const accept = (): readonly string[] => {
    const value = props.ed.spec?.options['accept']
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  }
  const kind = () => typeof props.ed.spec?.kind === 'string' && props.ed.spec.kind !== '' ? props.ed.spec.kind : mediaKindForAccept(accept())
  const vocabulary = () => kind()?.startsWith('model/') === true ? MODEL_ASSET_VOCABULARY : kind() === 'data/latent' ? LATENT_ASSET_VOCABULARY : GENERIC_ASSET_VOCABULARY
  const [dismissBlocked, setDismissBlocked] = createSolidSignal(false)
  let requestClose: (close: () => void) => void = (close) => close()
  const Implementation: Component<WidgetEditorImplementationProps> = (implementationProps) => {
    const bindDismissBlocked = (blocked: () => boolean): void => {
      createEffect(() => setDismissBlocked(blocked()))
    }
    return (
      <AssetEditorImplementation
        {...implementationProps}
        setDismissBlocked={bindDismissBlocked}
        setRequestClose={(handler) => { requestClose = handler }}
      />
    )
  }
  return (
    <WidgetEditorController
      {...props}
      implementation={Implementation}
      modal={{
        type: 'ASSET',
        displayType: kind() === 'data/latent' && props.ed.label.toLowerCase().includes('latent') ? 'asset' : vocabulary().modalType,
        dismissBlocked,
        onRequestClose: (close) => requestClose(close),
        help: <>{kind()?.startsWith('model/') === true ? `Browse models for ${props.ed.label}.` : `Browse or upload ${withArticle(vocabulary().singular)}${kind() === 'data/latent' ? '.' : ` for ${props.ed.label}.`}`} {' '}Cancel or close leaves the stored value unchanged.</>,
      }}
    />
  )
}
