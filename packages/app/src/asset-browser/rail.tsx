/**
 * Asset detail surfaces: the Assets panel and picker both show a compact
 * selection summary with a "Details" disclosure. The disclosure contains
 * the asset's facts and opt-in safetensors metadata inspection.
 *
 * Each caller keys the disclosure on the selected item, so cleanup prevents
 * a slow inspection from attaching one asset's metadata or failure to the
 * next selection.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import type { CollectionEntry } from '@dinkster/core'
import type { DinksterConnection } from '@dinkster/client'
import { AssetFileLocation } from '../AssetFileLocation.js'
import { CollectionImage } from '../CollectionImage.js'
import { activeProjectId } from '../projects.js'
import { ProductNotice } from '../ProductForm.js'
import { ProductButton } from '../ProductControls.js'
import { ProductEmptyState } from '../ProductSurfaces.js'
import { useAppMessage } from '../locale.js'
import type { AssetBrowserItem, AssetSourceAdapter } from './types.js'
import { committableAssetRef, formatSize, isBrowserPreviewable } from './helpers.js'
import { inspectAssetMetadata, METADATA_INSPECTION_UNSUPPORTED } from './metadata.js'
import { assetEntryKindOf, assetItemOf, assetKindOf } from './collection-adapter.js'
import { DigestValue } from './presentation.js'
import {
  logicalModelVariantName,
  type LogicalModelPickDetail,
} from './logical-model-collection-source.js'

const likelyModel = (item: AssetBrowserItem | undefined): boolean =>
  !!item?.digest && !!item?.kind?.startsWith('model/') && (item.mediaType?.includes('safetensors') || item.name.toLowerCase().endsWith('.safetensors'))

function selectionItemOf(entry: CollectionEntry | undefined): AssetBrowserItem | undefined {
  const mounted = assetItemOf(entry)
  if (mounted !== undefined) return mounted
  if (entry === undefined || entry.folder !== undefined) return undefined
  const ref = typeof entry.ref === 'object' && entry.ref !== null ? entry.ref as Record<string, unknown> : {}
  const name = typeof ref['name'] === 'string' ? ref['name'] : entry.title
  const digest = typeof ref['digest'] === 'string' ? ref['digest'] : undefined
  const kind = assetEntryKindOf(entry)
  return {
    id: entry.id,
    name,
    ...(kind !== undefined ? { kind } : {}),
    ...(typeof ref['mediaType'] === 'string' ? { mediaType: ref['mediaType'] } : {}),
    ...(typeof ref['size'] === 'number' ? { size: ref['size'] } : {}),
    ...(digest !== undefined ? { digest } : {}),
    source: { id: 'all-assets', label: 'All assets' },
    ...(typeof ref['virtualPath'] === 'string' ? { virtualPath: ref['virtualPath'] } : {}),
    rawRef: entry.ref,
  }
}

const selectionDetailsOf = (entry: CollectionEntry | undefined): NonNullable<CollectionEntry['details']> =>
  (entry?.details ?? []).flatMap((fact) => {
    if (['Name', 'Kind', 'Size', 'Media type', 'Virtual path', 'Digest'].includes(fact.label)) return []
    return [{ ...fact, label: fact.label === 'Source' ? 'Provider source' : fact.label }]
  })

interface AssetDimensions {
  readonly width: number
  readonly height: number
}

function AssetFacts(props: {
  readonly item: AssetBrowserItem
  readonly dimensions?: AssetDimensions | undefined
  readonly metadata: unknown
  readonly metadataState: string
  readonly inspect?: (() => void) | undefined
  readonly additionalFacts?: NonNullable<CollectionEntry['details']> | undefined
}): JSX.Element {
  const message = useAppMessage()
  return (
    <>
      <dl>
        <dt>{message('assets.fact.name')}</dt><dd>{props.item.name}</dd>
        <dt>{message('assets.fact.kind')}</dt><dd>{assetKindOf(props.item) ?? message('assets.value.unknown')}</dd>
        <dt>{message('assets.fact.mediaType')}</dt><dd>{props.item.mediaType ?? message('assets.value.unknown')}</dd>
        <Show when={props.dimensions}>{(dimensions) => <><dt>{message('assets.fact.resolution')}</dt><dd>{dimensions().width} x {dimensions().height}</dd></>}</Show>
        <dt>{message('assets.fact.size')}</dt><dd>{formatSize(props.item.size)}</dd>
        <dt>{message('assets.fact.source')}</dt><dd>{props.item.source.id === 'all-assets' ? message('assets.source.all') : props.item.source.label}</dd>
        <Show when={props.item.source.id.startsWith('mount:')}><dt>{message('assets.fact.mount')}</dt><dd>{props.item.source.id.slice('mount:'.length)}</dd></Show>
        <dt>{message('assets.fact.virtualPath')}</dt><dd>{props.item.virtualPath ?? ''}</dd>
        <Show when={props.item.digest}>{(digest) => <><dt>{message('assets.fact.digest')}</dt><dd class="asset-digest"><DigestValue digest={digest()} /></dd></>}</Show>
        <For each={props.additionalFacts}>{(fact) => <><dt>{fact.label}</dt><dd>{fact.text}</dd></>}</For>
      </dl>
      <Show when={likelyModel(props.item) && props.inspect !== undefined}>
        <button type="button" onClick={props.inspect}>{message('assets.metadata.inspect')}</button>
        <Show when={props.metadataState !== 'idle'}>
          <pre>{props.metadataState === 'ready'
            ? JSON.stringify(props.metadata, null, 2)
            : props.metadataState === 'loading'
              ? message('assets.metadata.loading')
              : props.metadataState === METADATA_INSPECTION_UNSUPPORTED
                ? message('assets.metadata.unsupported')
                : props.metadataState}</pre>
        </Show>
      </Show>
    </>
  )
}

function AssetEntrySelectionContent(props: {
  readonly item: AssetBrowserItem
  readonly preview?: CollectionEntry | undefined
  readonly adapters: readonly AssetSourceAdapter[]
  readonly backendId: string
  readonly additionalFacts: NonNullable<CollectionEntry['details']>
}) {
  const message = useAppMessage()
  const [dimensions, setDimensions] = createSignal<AssetDimensions>()
  const [previewFailed, setPreviewFailed] = createSignal(false)
  return (
    <>
      <header class="asset-section-heading">
        <div>
          <span class="asset-section-eyebrow">{message('assets.selection.title')}</span>
          <h3>{props.item.name}</h3>
        </div>
        <Show when={props.item.size !== undefined}><span>{formatSize(props.item.size)}</span></Show>
      </header>
      <Show when={props.preview}>
        {(entry) => <CollectionImage entry={entry()} class="asset-preview"
          alt={message('assets.preview.alt', { name: props.item.name })}
          fallback={<Show when={previewFailed()}><div class="asset-preview asset-preview-fallback" data-testid="asset-image-fallback" role="status">{message('assets.preview.unavailable')}</div></Show>}
          onError={() => setPreviewFailed(true)}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget
            if (naturalWidth > 0 && naturalHeight > 0) setDimensions({ width: naturalWidth, height: naturalHeight })
          }} />}
      </Show>
      <Show when={!previewFailed() ? dimensions() : undefined}>
        {(value) => <div class="asset-preview-caption" data-testid="asset-preview-caption">{value().width} x {value().height}</div>}
      </Show>
      <AssetSelectionDetails item={props.item} dimensions={dimensions()} adapters={props.adapters} backendId={props.backendId} additionalFacts={props.additionalFacts} />
    </>
  )
}

function ModelVisibilityAction(props: {
  readonly item: AssetBrowserItem
  readonly connection: Pick<DinksterConnection, 'hideModel'>
  readonly isCurrent: () => boolean
  readonly onChanged?: (() => void) | undefined
}) {
  const message = useAppMessage()
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [hidden, setHidden] = createSignal(false)
  const [error, setError] = createSignal(false)
  let generation = 0
  createEffect(() => {
    props.connection
    props.item
    generation++
    setConfirming(false); setBusy(false); setHidden(false); setError(false)
  })
  onCleanup(() => { generation++ })
  const hide = async () => {
    if (busy() || !props.isCurrent()) return
    const owner = generation
    const asset = props.item.rawRef
    if (typeof asset !== 'object' || asset === null || !props.item.kind) return
    setBusy(true); setError(false)
    try {
      await props.connection.hideModel(asset as Record<string, unknown>, props.item.kind)
      if (owner !== generation || !props.isCurrent()) return
      setHidden(true); setConfirming(false)
      props.onChanged?.()
    } catch {
      if (owner === generation && props.isCurrent()) setError(true)
    } finally { if (owner === generation) setBusy(false) }
  }
  return <section class="model-visibility-action" data-testid="model-visibility-action">
    <Show when={error()}><ProductNotice tone="error">{message('modelVisibility.error')}</ProductNotice></Show>
    <Show when={hidden()} fallback={
      <Show when={confirming()} fallback={<ProductButton class="model-hide-outline" onClick={() => setConfirming(true)}>{message('modelVisibility.hide')}</ProductButton>}>
        <ProductNotice tone="warning">{message('modelVisibility.confirm', { name: props.item.name })}</ProductNotice>
        <div class="project-folder-actions">
          <ProductButton disabled={busy()} onClick={() => setConfirming(false)}>{message('projectFolders.cancel')}</ProductButton>
          <ProductButton variant="danger" disabled={busy()} onClick={() => void hide()}>{message('modelVisibility.hide')}</ProductButton>
        </div>
      </Show>
    }><ProductNotice tone="info">{message('modelVisibility.hidden')}</ProductNotice></Show>
  </section>
}

/** Bind an Assets-panel selection to the same summary and disclosure used by the picker. */
export function AssetEntrySelection(props: {
  readonly entry: CollectionEntry | undefined
  readonly adapters: readonly AssetSourceAdapter[]
  readonly backendId: string
  readonly connection: Pick<DinksterConnection, 'fetchAssetLocations'>
  readonly visibilityConnection?: Pick<DinksterConnection, 'hideModel'>
  readonly onVisibilityChanged?: () => void
  readonly backendUrl: string
  readonly backendLabel?: string | undefined
}) {
  const message = useAppMessage()
  const item = createMemo((): AssetBrowserItem | undefined => selectionItemOf(props.entry))
  return (
    <section class="asset-selection-summary asset-browser-selection" data-testid="asset-selection-summary" aria-label={message('assets.selection.title')}>
      <Show when={item()} keyed fallback={
        <>
          <header class="asset-section-heading">
            <div>
              <span class="asset-section-eyebrow">{message('assets.selection.title')}</span>
              <h3>{message('assets.selection.empty.title')}</h3>
            </div>
          </header>
          <ProductEmptyState testId="asset-selection-empty" title={message('assets.selection.empty.detail')} />
        </>
      }>
        {(selected) => {
          const connection = props.connection
          const backendUrl = props.backendUrl
          const project = activeProjectId()
          return <>
            <Show when={props.visibilityConnection && selected.kind?.startsWith('model/') && selected.virtualPath && selected.rawRef && (selected.digest || (typeof selected.rawRef === 'object' && 'localBinding' in selected.rawRef)) ? props.visibilityConnection : undefined}>{(visibility) => <ModelVisibilityAction
              item={selected} connection={visibility()} onChanged={props.onVisibilityChanged}
              isCurrent={() => props.connection === connection && props.backendUrl === backendUrl && activeProjectId() === project} />}</Show>
            <AssetEntrySelectionContent item={selected} preview={isBrowserPreviewable(selected) ? props.entry : undefined} adapters={props.adapters} backendId={props.backendId} additionalFacts={selectionDetailsOf(props.entry)} />
            <Show when={committableAssetRef(selected)}>{(ref) => <AssetFileLocation
              connection={connection} backendUrl={backendUrl} backendLabel={props.backendLabel}
              digest={ref().digest} project={project}
              isCurrent={() => props.connection === connection && props.backendUrl === backendUrl && activeProjectId() === project} />}</Show>
          </>
        }}
      </Show>
    </section>
  )
}

/**
 * The picker selection panel's closed "Details" disclosure for one picked
 * asset. Callers key this on the item (identity change remounts) so the
 * inspection lifecycle can never mix assets.
 */
export function AssetSelectionDetails(props: {
  readonly item: AssetBrowserItem
  readonly dimensions?: AssetDimensions | undefined
  readonly adapters: readonly AssetSourceAdapter[]
  readonly backendId: string
  readonly additionalFacts?: NonNullable<CollectionEntry['details']> | undefined
}) {
  const message = useAppMessage()
  const [metadata, setMetadata] = createSignal<unknown>()
  const [metadataState, setMetadataState] = createSignal('idle')
  let alive = true
  onCleanup(() => {
    alive = false
  })
  const inspect = (): void => {
    const adapter = props.adapters.find((a) => a.id === props.item.source.id)
    if (!adapter || metadataState() === 'loading') return
    setMetadataState('loading')
    void inspectAssetMetadata({
      backendId: props.backendId,
      source: adapter,
      item: props.item,
      stillCurrent: () => alive,
      apply: (state, value) => {
        setMetadata(value)
        setMetadataState(state)
      },
    })
  }
  const canInspect = (): boolean => props.adapters.some((adapter) => adapter.id === props.item.source.id)
  return (
    <details class="asset-rail-details" data-testid="asset-rail-details">
      <summary aria-label={message('assets.details.forAsset', { name: props.item.name })}>{message('assets.details.title')}</summary>
      <AssetFacts item={props.item} dimensions={props.dimensions} metadata={metadata()} metadataState={metadataState()} inspect={canInspect() ? inspect : undefined} additionalFacts={props.additionalFacts} />
    </details>
  )
}

/** The picker selection panel's facts for one staged model variant. */
export function LogicalModelVariantFacts(props: {
  readonly detail: LogicalModelPickDetail
}) {
  const message = useAppMessage()
  const variant = () => props.detail.variant
  return (
    <details class="logical-model-variant-details" data-testid="logical-model-variant-details">
      <summary aria-label={message('assets.details.forVariant', { model: props.detail.modelName, variant: logicalModelVariantName(props.detail.variant) })}>{message('assets.details.title')}</summary>
      <dl class="logical-model-variant-facts">
        <div><dt>{message('assets.logicalModel.model')}</dt><dd>{props.detail.modelName}</dd></div>
        <div><dt>{message('assets.logicalModel.variant')}</dt><dd>{logicalModelVariantName(variant())}</dd></div>
        <div><dt>{message('assets.logicalModel.availability')}</dt><dd>{variant().availability}</dd></div>
        <Show when={props.detail.aliases.length > 0}>
          <div class="logical-model-alias-fact"><dt>{message('assets.logicalModel.aliases')}</dt><dd>{props.detail.aliases.join(', ')}</dd></div>
        </Show>
        <Show when={variant().dtype}>{(value) => <div><dt>{message('assets.logicalModel.dtype')}</dt><dd>{value()}</dd></div>}</Show>
        <Show when={variant().precision}>{(value) => <div><dt>{message('assets.logicalModel.precision')}</dt><dd>{value()}</dd></div>}</Show>
        <Show when={variant().quantization}>{(value) => <div><dt>{message('assets.logicalModel.quantization')}</dt><dd>{value()}</dd></div>}</Show>
        <Show when={variant().format}>{(value) => <div><dt>{message('assets.logicalModel.format')}</dt><dd>{value()}</dd></div>}</Show>
        <Show when={variant().digest}>{(value) => <div class="logical-model-digest"><dt>{message('assets.fact.digest')}</dt><dd><DigestValue digest={value()} /></dd></div>}</Show>
      </dl>
      <Show when={variant().providers.length > 0}>
        <div class="logical-model-providers" aria-label={message('assets.logicalModel.providers')}>
          <For each={variant().providers}>{(provider) => <span>{provider.label}</span>}</For>
        </div>
      </Show>
      <Show when={variant().compatibility.status === 'incompatible'}>
        <ProductNotice tone="warning" class="logical-model-compatibility">
          <strong>{message('assets.logicalModel.incompatible')}</strong>
          <Show when={variant().compatibility.reason}>{(reason) => `: ${reason()}`}</Show>
        </ProductNotice>
      </Show>
      <Show when={variant().conflicts.length > 0}>
        <ProductNotice tone="warning" class="logical-model-conflict" testId="logical-model-conflict">
          {message('assets.logicalModel.nameConflict')}
        </ProductNotice>
      </Show>
      <Show when={variant().localRef === undefined}>
        <ProductNotice tone="info" testId="logical-model-not-on-disk">
          {message('assets.logicalModel.notOnDisk')}
        </ProductNotice>
      </Show>
    </details>
  )
}
