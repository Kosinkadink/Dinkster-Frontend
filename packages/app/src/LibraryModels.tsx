import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from 'solid-js'
import type { DinksterConnection, ModelSettingsState, MountDescriptor } from '@dinkster/client'
import { formatByteSize } from '@dinkster/core'
import { ProductButton, ProductConfirmation, ProductErrorBanner, ProductModelList, ProductProgress, type ProductModel } from '@dinkster/ui'
import { ProductTextInput } from './ProductControls.js'
import { ProductSelect } from './ProductSelect.js'
import { ProductEmptyState } from './ProductSurfaces.js'
import { useAppMessage } from './locale.js'
import { mountAssetSource } from './asset-browser/mountAssetSource.js'
import { localMountScanAdapter } from './asset-browser/local-mount-logical-model.js'
import { ingestLogicalModels } from './asset-browser/logical-model-merge.js'
import { logicalModelVariantName } from './asset-browser/logical-model-collection-source.js'
import { committableAssetRef, type CanonicalAssetRef } from './asset-browser/helpers.js'
import type { LogicalModel, LogicalModelVariant } from './asset-browser/logical-model.js'
import type { AssetBrowserItem } from './asset-browser/types.js'

export function LibraryModels(props: {
  readonly connection: DinksterConnection
  readonly focus?: { readonly modelLocationId: string } | undefined
  readonly onOpenStorage: (locationId?: string) => void
  readonly onAddModelFolder: () => void
}) {
  const message = useAppMessage()
  const [settings, setSettings] = createSignal<ModelSettingsState>()
  const [mounts, setMounts] = createSignal<readonly MountDescriptor[]>([])
  const [models, setModels] = createSignal<readonly LogicalModel[]>([])
  const [observed, setObserved] = createSignal<readonly AssetBrowserItem[]>([])
  const [query, setQuery] = createSignal('')
  const [kind, setKind] = createSignal('')
  const [folder, setFolder] = createSignal('')
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [confirmation, setConfirmation] = createSignal<{
    readonly modelId: string
    readonly versionId: string
    readonly name: string
    readonly kind: string
    readonly asset: CanonicalAssetRef
  }>()
  const [hideError, setHideError] = createSignal(false)
  const cancelHide = () => {
    setConfirmation(undefined)
    setHideError(false)
    setBusy(false)
  }
  let generation = 0
  let request = 0
  let controller: AbortController | undefined
  let appliedFocus: typeof props.focus

  const load = async (connection: DinksterConnection): Promise<void> => {
    const owner = generation
    const sequence = ++request
    controller?.abort()
    const abort = new AbortController()
    controller = abort
    const current = () => owner === generation && sequence === request && !abort.signal.aborted
    try {
      const [nextSettings, discovered] = await Promise.all([connection.fetchModelSettings(), connection.listMounts()])
      if (!current()) return
      setSettings(nextSettings)
      setMounts(discovered)
      const allowed = new Set(nextSettings.locations.filter((location) => location.enabled).flatMap((location) => location.mounts))
      const sources = discovered.filter((mount) => allowed.has(mount.id) && (mount.state === 'ready' || mount.state === 'scanning'))
        .map((mount) => mountAssetSource(connection, mount.id))
      const errors: string[] = []
      const cached = await Promise.all(sources.map(async (source) => {
        const items: AssetBrowserItem[] = []
        let cursor: string | undefined
        try {
          do {
            abort.signal.throwIfAborted()
            const page = await source.page({ query: '', recursive: true, limit: 200, signal: abort.signal, ...(cursor ? { cursor } : {}) })
            items.push(...page.items)
            cursor = page.cursor
          } while (cursor !== undefined)
        } catch (cause) {
          abort.signal.throwIfAborted()
          errors.push(`${source.label}: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
        return { ...source, page: async () => ({ items }) }
      }))
      const items = (await Promise.all(cached.map((source) => source.page()))).flatMap((page) => page.items)
      const kinds = [...new Set(items.flatMap((item) => item.kind?.startsWith('model/') ? [item.kind] : []))]
      const adapters = await Promise.all(kinds.map((value) => localMountScanAdapter(cached, value, [], { signal: abort.signal })))
      if (!current()) return
      setObserved(items)
      setModels(adapters.flatMap((adapter) => ingestLogicalModels([adapter]).models))
      setError(errors.join('\n'))
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current()) setLoading(false)
    }
  }
  createEffect(() => {
    const connection = props.connection
    generation++
    appliedFocus = undefined
    setSettings(undefined)
    setMounts([])
    setModels([])
    setObserved([])
    setQuery('')
    setKind('')
    setFolder('')
    setLoading(true)
    setError('')
    cancelHide()
    onCleanup(connection.onMountsChanged(() => { void load(connection) }))
    onCleanup(() => { generation++; controller?.abort() })
    untrack(() => { void load(connection) })
  })
  const locations = () => settings()?.locations.filter((location) => location.enabled) ?? []
  const providersFor = (variant: LogicalModelVariant) => locations().filter((location) =>
    (folder() === '' || location.id === folder()) && variant.providers.some((provider) => location.mounts.some((mount) => provider.sourceId === `mount:${mount}`)))
  createEffect(() => {
    const focus = props.focus
    if (!settings() || focus === undefined || focus === appliedFocus) return
    appliedFocus = focus
    setQuery('')
    setKind('')
    setFolder(locations().some((location) => location.id === focus.modelLocationId) ? focus.modelLocationId : '')
  })
  createEffect(() => {
    if (settings() && folder() !== '' && !locations().some((location) => location.id === folder())) setFolder('')
  })
  const localRef = (model: LogicalModel, variant: LogicalModelVariant) => {
    const providers = new Set(providersFor(variant).flatMap((location) => location.mounts.map((mount) => `mount:${mount}`)))
    const item = observed().find((candidate) => candidate.kind === model.kind && candidate.digest === variant.digest && providers.has(candidate.source.id))
    return item ? committableAssetRef(item) : undefined
  }
  const visible = createMemo(() => models().flatMap((model) => {
    if (kind() !== '' && model.kind !== kind()) return []
    const search = query().trim().toLocaleLowerCase()
    if (search && ![model.displayName, ...model.aliases].some((name) => name.toLocaleLowerCase().includes(search))) return []
    const variants = model.variants.filter((variant) => providersFor(variant).length > 0)
    return variants.length ? [{ ...model, variants }] : []
  }).sort((left, right) => left.displayName.localeCompare(right.displayName)))
  const versionKey = (variant: LogicalModelVariant) => JSON.stringify([variant.variantId, variant.digest ?? null])
  const rows = createMemo<readonly ProductModel[]>(() => visible().map((model) => ({
    id: JSON.stringify([model.kind, model.logicalId]), name: model.displayName, kind: model.kind.split('/').at(-1)!,
    versions: model.variants.map((variant) => ({
      id: versionKey(variant), name: logicalModelVariantName(variant),
      ...(variant.size !== undefined ? { size: formatByteSize(variant.size) } : {}),
      ...(variant.precision ? { precision: variant.precision } : {}),
      state: 'installed',
      facts: [
        { label: message('library.models.file'), value: localRef(model, variant)?.virtualPath || logicalModelVariantName(variant), monospace: true },
        { label: message('library.models.folder'), value: providersFor(variant).map((location) => location.path).join('\n'), monospace: true },
        { label: message('library.models.aliases'), value: model.aliases.join(', ') },
      ],
    })),
  })))
  const resolve = (modelId: string, versionId: string) => {
    const model = visible().find((candidate) => JSON.stringify([candidate.kind, candidate.logicalId]) === modelId)
    const variant = model?.variants.find((candidate) => versionKey(candidate) === versionId)
    return model && variant ? { model, variant } : undefined
  }
  createEffect(() => {
    query(); kind(); folder()
    cancelHide()
  })
  const askHide = (modelId: string, versionId: string) => {
    const selected = resolve(modelId, versionId)
    if (!selected) return
    const asset = localRef(selected.model, selected.variant)
    if (!asset) return
    setHideError(false)
    setConfirmation({ modelId, versionId, name: selected.model.displayName, kind: selected.model.kind, asset })
  }
  const hide = async () => {
    const selected = confirmation()
    if (!selected || busy()) return
    const owner = generation
    const connection = props.connection
    const current = () => owner === generation && confirmation() === selected
    setBusy(true)
    setHideError(false)
    try {
      await connection.hideModel(selected.asset, selected.kind)
      if (!current()) return
      cancelHide()
      await load(connection)
    } catch {
      if (current()) setHideError(true)
    } finally { if (current()) setBusy(false) }
  }
  const copyName = async (modelId: string, versionId: string) => {
    const selected = resolve(modelId, versionId)
    if (!selected) return
    const owner = generation
    try {
      await navigator.clipboard.writeText(localRef(selected.model, selected.variant)?.name ?? selected.model.displayName)
    } catch (cause) {
      if (owner === generation) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const folderCount = () => new Set(visible().flatMap((model) => model.variants.flatMap((variant) => providersFor(variant).map((location) => location.id)))).size
  return <section class="library-models" aria-label={message('library.models.title')} aria-busy={loading() || busy()}>
    <Show when={error()}>{(detail) => <ProductErrorBanner onDismiss={() => setError('')}>{detail()}</ProductErrorBanner>}</Show>
    <Show when={!loading()} fallback={<ProductEmptyState tone="loading" title={message('library.models.loading')} />}>
      <Show when={locations().length > 0} fallback={<ProductEmptyState title={message('library.models.empty')} action={
        <ProductButton intent="add" onClick={props.onAddModelFolder}>{message('library.models.addFolder')}</ProductButton>
      } />}>
        <div class="library-model-filters">
          <ProductTextInput type="search" aria-label={message('library.search', { source: message('library.models.title').toLocaleLowerCase() })} value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
          <ProductSelect ariaLabel={message('library.models.kind')} selectedId={kind()} options={[
            { id: '', label: message('library.models.allKinds'), value: '' },
            ...[...new Set(models().map((model) => model.kind))].sort().map((value) => ({ id: value, label: value.split('/').at(-1)!, value })),
          ]} onSelect={(option) => setKind(option.value)} />
          <ProductSelect ariaLabel={message('library.models.folder')} selectedId={folder()} options={[
            { id: '', label: message('library.models.allFolders'), value: '' },
            ...locations().map((location) => ({ id: location.id, label: location.id, value: location.id })),
          ]} onSelect={(option) => setFolder(option.value)} />
        </div>
        <For each={mounts().filter((mount) => mount.state === 'scanning' && locations().some((location) => (folder() === '' || location.id === folder()) && location.mounts.includes(mount.id)))}>
          {(mount) => <div role="status">
            {message('library.models.reading', { folder: mount.id })}
            <Show when={mount.scanProgress}>{(progress) => <>
              <span>{message('library.models.readCount', { done: progress().filesDone, total: progress().filesTotal })}</span>
              <ProductProgress label={mount.id} value={progress().bytesTotal > 0 ? progress().bytesDone / progress().bytesTotal : undefined} />
            </>}</Show>
          </div>}
        </For>
        <div class="library-model-items">
          <Show when={rows().length > 0} fallback={<ProductEmptyState title={message('library.models.noMatch')} />}>
            <ProductModelList label={message('library.models.title')} models={rows()}
              onSelect={(modelId, versionId) => {
                const current = confirmation()
                if (current && (current.modelId !== modelId || current.versionId !== versionId)) cancelHide()
              }}
              onShowFolder={(modelId, versionId) => {
                const selected = resolve(modelId, versionId)
                if (selected) props.onOpenStorage(providersFor(selected.variant)[0]?.id)
              }}
              onCopyName={(modelId, versionId) => { void copyName(modelId, versionId) }}
              onHide={askHide}
              renderActions={(modelId, versionId) => {
                const current = confirmation()
                if (!current || current.modelId !== modelId || current.versionId !== versionId) return undefined
                return <ProductConfirmation surface="inherit"
                  title={message('modelVisibility.hideTitle', { name: current.name })}
                  consequence={message('modelVisibility.confirm')}
                  actionLabel={message('modelVisibility.hide')} intent="remove"
                  pending={busy()} error={hideError() ? message('modelVisibility.error') : undefined}
                  onCancel={cancelHide} onConfirm={() => { void hide() }} />
              }} />
          </Show>
        </div>
        <footer class="library-model-footer">{message('library.models.count', {
          models: message(visible().length === 1 ? 'library.models.oneModel' : 'library.models.manyModels', { count: visible().length }),
          folders: message(folderCount() === 1 ? 'library.models.oneFolder' : 'library.models.manyFolders', { count: folderCount() }),
        })}</footer>
      </Show>
    </Show>
  </section>
}
