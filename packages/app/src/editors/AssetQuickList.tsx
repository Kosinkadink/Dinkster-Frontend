import { createEffect, createMemo, createSignal, onCleanup, Show, type Component } from 'solid-js'
import { assetMultiSelect, isAssetWidgetInput, type CollectionEntry, type WidgetSpec, type TypeExpr } from '@dinkster/core'
import { CanvasRowField, CanvasRowPopup, ProductButton, ProductSegmented } from '@dinkster/ui'
import { CollectionPanel } from '../CollectionPanel.js'
import { ProductNotice } from '../ProductForm.js'
import { ProductSelect } from '../ProductSelect.js'
import { ProductFileInput } from '../ProductControls.js'
import { assetCollectionSource, assetEntryPickable, assetItemOf } from '../asset-browser/collection-adapter.js'
import { assetUploadPolicy, committableAssetRef, mediaKindForAccept } from '../asset-browser/helpers.js'
import { mountAssetSource, mountAssetSources } from '../asset-browser/mountAssetSource.js'
import { AssetEntryContent } from '../asset-browser/presentation.js'
import type { AssetSourceAdapter } from '../asset-browser/types.js'
import { safeLocalStorage } from '../collections.js'
import { activeProjectId } from '../projects.js'
import { useAppMessage } from '../locale.js'
import { tabDocumentUnchanged } from '../widget-editor-anchor.js'
import type { WidgetEditorImplementationProps } from '../WidgetEditorController.js'
import { placeRow, rowPlacement, visibleCanvas } from './row-placement.js'

export function assetQuickListAllowed(spec: WidgetSpec | undefined, type: TypeExpr | undefined, mergeableTypes?: readonly string[]): boolean {
  return spec !== undefined && isAssetWidgetInput({ widget: spec }) && spec.selection !== true && !spec.kind?.startsWith('model/') &&
    !(type !== undefined && assetMultiSelect(type, mergeableTypes))
}

export const AssetQuickList: Component<WidgetEditorImplementationProps & {
  readonly browse: () => void
  readonly add: (file: File) => void
}> = (props) => {
  const host = props.editor
  const message = useAppMessage()
  const ed = host.ed
  const inRow = ed.inRow!
  const backend = host.app.backendForTab(ed.tab)
  const project = activeProjectId()
  const openedTab = ed.tab
  const store = openedTab.store
  const revision = store.revision
  const registry = host.app.registryForTab(openedTab)
  let live = true
  let connectionChanged = false
  const unsubscribe = backend.connection.status.subscribe(() => { connectionChanged = true })
  onCleanup(() => { live = false; unsubscribe() })
  const current = () => live && !connectionChanged && openedTab.store === store && store.revision === revision &&
    tabDocumentUnchanged(openedTab, revision, ed.tab) && host.app.tabs.get().includes(ed.tab) &&
    host.app.backendForTab(ed.tab) === backend && host.app.registryForTab(ed.tab) === registry && activeProjectId() === project
  const acceptValue = ed.spec?.options['accept']
  const accept = Array.isArray(acceptValue) ? acceptValue.filter((item): item is string => typeof item === 'string') : []
  const kind = ed.spec?.kind ?? mediaKindForAccept(accept)
  const policy = assetUploadPolicy(kind, registry?.uploadLimits)
  const matchesStoredAsset = (entry: CollectionEntry): boolean => {
    const ref = assetItemOf(entry)
    const initial = ed.initial
    return typeof initial === 'object' && initial !== null && 'digest' in initial && 'virtualPath' in initial &&
      initial.digest === ref?.digest && initial.virtualPath === ref?.virtualPath
  }
  const storage = safeLocalStorage()
  const scopeKey = `dinkster.asset-quick-scope:${kind ?? accept.join(',')}`
  let savedScope = 'all-mounts'
  try { savedScope = storage?.getItem(scopeKey) ?? savedScope } catch { /* An unavailable preference does not prevent picking. */ }
  const [adapters, setAdapters] = createSignal<readonly AssetSourceAdapter[]>()
  const [error, setError] = createSignal<string>()
  const [query, setQuery] = createSignal('')
  const [input, setInput] = createSignal<HTMLInputElement>()
  const bounds = visibleCanvas(host.boundary)
  let frame!: HTMLDivElement
  let chooser!: HTMLInputElement
  let addButton!: HTMLButtonElement
  void mountAssetSources(backend.connection, kind).then((sources) => {
    if (current()) setAdapters(sources)
  }).catch((reason: unknown) => {
    if (current()) { setAdapters([]); setError(reason instanceof Error ? reason.message : String(reason)) }
  })
  const sources = createMemo(() => {
    const mounts = adapters()
    if (mounts === undefined || mounts.length === 0) return []
    const ids = mounts.map((mount) => mount.id.slice('mount:'.length))
    return [mountAssetSource(backend.connection, ids), ...mounts].map((adapter) => ({
      ...assetCollectionSource(adapter, { assetUrl: (digest) => backend.connection.assetUrl(digest), ...(kind === undefined ? {} : { fixedKind: kind }) }),
      folders: false,
    }))
  })
  const placement = createMemo(() => rowPlacement({ rect: ed.rect, ...inRow }, host.viewport(), bounds(), { width: 0, height: 0 }))
  createEffect(() => placeRow(frame, placement()))
  host.bindClickAway?.(() => { if (props.commitPending()) return false; props.close(); return true })
  onCleanup(() => host.bindClickAway?.(undefined))
  const handOff = (file?: File): void => {
    if (!current() || props.commitPending()) return
    inRow.handOff?.()
    if (file === undefined) props.browse()
    else props.add(file)
  }
  return <div ref={frame} class="widget-in-row-field" data-testid="widget-editor" data-editor-mode="ASSET" data-editor-surface="asset-quick-list"
    onKeyDown={(event) => {
      if (event.isComposing || event.defaultPrevented) return
      if (event.key === 'Escape') { event.preventDefault(); props.close(); if (ed.target.kind === 'input') host.focusRow?.(ed.target) }
      if (event.key === 'Tab' && !props.commitPending() &&
        (event.shiftKey ? event.target === input() : event.target === addButton)) {
        event.preventDefault(); props.close(); if (ed.target.kind === 'input') host.moveRow?.(ed.target, event.shiftKey ? -1 : 1)
      }
    }}>
    <CanvasRowField look={inRow.look} rowWidth={placement().rowWidth} place={placement().place} zoomed={placement().scale > 1}
      label={ed.label} value={query()} onInput={setQuery} inputLabel={ed.label} placeholder={message('assets.quickList.placeholder')}
      inputRef={(element) => { setInput(element); queueMicrotask(() => element.focus()) }} />
    <CanvasRowPopup row={placement().screen} bounds={bounds()} scale={placement().scale}>
      <div class="asset-quick-list">
        <Show when={error()}>{(value) => <ProductNotice tone="error">{value()}</ProductNotice>}</Show>
        <Show when={adapters() !== undefined} fallback={<p role="status">{message('assets.quickList.loading')}</p>}>
          <Show when={sources().length > 0} fallback={<p>{message('assets.quickList.empty')}</p>}>
            <CollectionPanel sources={sources()} initialSourceId={sources().some((source) => source.id === savedScope) ? savedScope : 'all-mounts'}
              search={{ query, input }} recursive sort="newest" pageSize={24} pagination="scroll"
              modeKey={`dinkster.asset-quick-view:${kind ?? 'file'}`} defaultMode={kind === 'media/image' ? 'grid' : 'list'}
              navigation={({ selectedId, select, mode, setMode }) => <div class="asset-view-controls">
                <Show when={(adapters()?.length ?? 0) > 1}>
                  <ProductSelect testId="asset-quick-mount" ariaLabel={message('assets.mounts.label')} selectedId={selectedId()}
                    options={sources().map((source) => ({ id: source.id, label: source.id === 'all-mounts' ? message('assets.mounts.all') : source.label, value: source.id }))}
                    onSelect={(option) => { select(option.value); try { storage?.setItem(scopeKey, option.value) } catch { /* Picking does not require saved preferences. */ } }} />
                </Show>
                <span class="asset-scope">{message('assets.order.newest')}</span>
                <ProductSegmented label={message('assets.view.label')} value={mode()} onChange={(value) => setMode(value as 'list' | 'grid')}
                  options={[{ value: 'list', label: message('assets.view.names') }, { value: 'grid', label: message('assets.view.pictures') }]} />
              </div>}
              entryContent={(entry) => <AssetEntryContent entry={entry()} />}
              initialSelection={matchesStoredAsset}
              detailRail={(entry) => <Show when={entry}>{(focused) => <div class="asset-quick-caption" data-testid="asset-quick-caption">
                <span>{focused().title}</span><small>{assetItemOf(focused())?.virtualPath}</small>
              </div>}</Show>}
              pick={{ pickable: assetEntryPickable(accept, kind),
                selected: matchesStoredAsset,
                onPick: (entry) => {
                  const item = assetItemOf(entry)
                  const ref = item === undefined ? undefined : committableAssetRef(item)
                  if (!current()) { setError(message('assets.quickList.changed')); return }
                  if (ref !== undefined) void props.commitValue(ref)
                } }} />
          </Show>
        </Show>
        <Show when={props.commitError()}>{(value) => <ProductNotice tone="error">{value()}</ProductNotice>}</Show>
        <ProductButton onClick={() => handOff()}>{message('assets.quickList.browse')}</ProductButton>
        <ProductButton ref={addButton} intent="add" onClick={() => chooser.click()}>
          {message(policy.maxBytes === undefined ? 'assets.quickList.add' : 'assets.quickList.upload')}
          <span class="asset-scope">{policy.label === undefined ? message('assets.quickList.anySize') : message('assets.quickList.limit', { size: policy.label })}</span>
        </ProductButton>
      </div>
    </CanvasRowPopup>
    <ProductFileInput ref={chooser} accept={accept.join(',')} onChange={(event) => {
      const file = event.currentTarget.files?.[0]
      event.currentTarget.value = ''
      if (file !== undefined) handOff(file)
    }} />
  </div>
}
