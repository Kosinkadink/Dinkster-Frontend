import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from 'solid-js'
import type { DinksterConnection, ModelSettingsState, MountDescriptor, MountLocations, MountSettings, MountScanProgress } from '@dinkster/client'
import Ellipsis from 'lucide-solid/icons/ellipsis'
import ChevronLeft from 'lucide-solid/icons/chevron-left'
import { ProductButton, ProductConfirmation, ProductDisclosure, ProductErrorBanner, ProductFacts, ProductList, ProductListRow, ProductLoading, ProductMenu, ProductNotice, ProductProgress, ProductSection, ProductTextButton, ProductToast } from '@dinkster/ui'
import type { AppState, Backend } from './app-state.js'
import { useSignal } from './solid-adapter.js'
import { useAppMessage } from './locale.js'
import { ProductSelect } from './ProductSelect.js'
import { ProductPanelHeader } from './ProductSurfaces.js'
import { ModelSettings } from './ModelSettings.js'
import { MountFolderForm } from './MountFolderForm.js'
import { formatSize } from './asset-browser/helpers.js'

type NativeBackend = Extract<Backend, { protocol: 'dinkster' }>

export function StoragePanel(props: {
  readonly app: AppState
  readonly focusBackend: { readonly id: string; readonly hiddenModels?: boolean; readonly modelLocationId?: string; readonly addModelFolder?: boolean } | undefined
  readonly activeBackend: () => Backend
  readonly onOpenAssets: (backend: Backend, mountId?: string) => void
  readonly onOpenModels?: (backend: Backend, modelLocationId: string) => void
}) {
  const message = useAppMessage()
  const backends = useSignal(props.app.backends)
  const [selected, setSelected] = createSignal<string>()
  createEffect(() => setSelected(props.focusBackend?.id))
  const backend = createMemo(() => backends().find((row) => row.id === selected()) ?? props.activeBackend())
  return <section class="dinkster-panel dinkster-stack" data-testid="storage-panel">
    <ProductPanelHeader title={message('storagePanel.title')} />
    <Show when={backends().length > 1}>
      <ProductSelect ariaLabel={message('storagePanel.backend')} selectedId={backend().id}
        options={backends().map((row) => ({ id: row.id, label: row.label, value: row.id }))}
        onSelect={(option) => setSelected(option.value)} />
    </Show>
    <Show when={backend().protocol === 'dinkster' ? backend() as NativeBackend : undefined} keyed
      fallback={<ProductNotice>{message('storagePanel.noFolders')}</ProductNotice>}>
      {(native) => <StorageFolders connection={native.connection} backendUrl={native.baseUrl}
        focus={props.focusBackend?.id === native.id ? props.focusBackend : undefined} onOpenAssets={(id) => props.onOpenAssets(native, id)}
        onOpenModels={props.onOpenModels ? (id) => props.onOpenModels?.(native, id) : undefined} />}
    </Show>
  </section>
}

export function StorageFolders(props: {
  readonly connection: DinksterConnection
  readonly backendUrl: string
  readonly onOpenAssets: (mountId?: string) => void
  readonly focus?: { readonly hiddenModels?: boolean; readonly modelLocationId?: string; readonly addModelFolder?: boolean } | undefined
  readonly onOpenModels?: ((modelLocationId: string) => void) | undefined
}) {
  const message = useAppMessage()
  const [settings, setSettings] = createSignal<MountSettings>()
  const [locations, setLocations] = createSignal<MountLocations>()
  const [models, setModels] = createSignal<ModelSettingsState>()
  const [error, setError] = createSignal('')
  const [operatorNotice, setOperatorNotice] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [editing, setEditing] = createSignal<'model' | 'models' | 'add-model' | 'folders'>()
  const [editModel, setEditModel] = createSignal<string>()
  const [leaving, setLeaving] = createSignal<{ readonly id: string; readonly model: boolean }>()
  const [replacement, setReplacement] = createSignal('')
  const [notification, setNotification] = createSignal<{ readonly message: string }>()
  let generation = 0
  let read = 0
  const load = async () => {
    const request = ++read
    const owner = generation
    const current = () => owner === generation && request === read
    try {
      const next = await props.connection.fetchMountSettings()
      if (!current()) return
      setSettings(next)
      const [paths, modelState] = await Promise.allSettled([
        props.connection.fetchMountLocations(), props.connection.fetchModelSettings(),
      ])
      if (!current()) return
      setLocations(paths.status === 'fulfilled' ? paths.value : undefined)
      setModels(modelState.status === 'fulfilled' ? modelState.value : undefined)
      setOperatorNotice(paths.status === 'rejected' || modelState.status === 'rejected')
      setError('')
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  createEffect(() => {
    const connection = props.connection
    generation++
    setSettings(undefined)
    setLocations(undefined)
    setModels(undefined)
    setBusy(false)
    setEditing(undefined)
    setLeaving(undefined)
    onCleanup(connection.onMountsChanged(() => { if (!busy()) void load() }))
    onCleanup(() => { generation++; read++ })
    untrack(() => { void load() })
  })
  createEffect(() => {
    const request = props.focus
    if (request !== undefined) setEditing(request.hiddenModels ? 'models' : request.addModelFolder ? 'add-model' : undefined)
  })
  const perform = async (action: () => Promise<unknown>) => {
    if (busy()) return
    const owner = generation
    read++
    setBusy(true)
    setError('')
    try {
      await action()
      if (owner !== generation) return
      setLeaving(undefined)
      await load()
      if (owner === generation) setNotification({ message: message('storagePanel.saved') })
    } catch (cause) {
      if (owner === generation) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (owner === generation) setBusy(false) }
  }
  const selected = () => settings()?.mounts ?? []
  const all = () => (locations()?.mounts.map((row) => ({ ...selected().find((mount) => mount.id === row.id), ...row })) ?? selected())
    .filter((row): row is MountDescriptor & { path?: string } => row.mode !== undefined && row.state !== undefined)
  const modelIds = createMemo(() => new Set(models()?.locations.flatMap((row) => row.mounts) ?? []))
  const usedModels = () => models()?.locations.filter((row) => row.enabled) ?? []
  const unusedModels = () => models()?.locations.filter((row) => !row.enabled) ?? []
  const folders = () => selected().filter((row) => !modelIds().has(row.id) && row.source !== 'shared-models')
  const unusedFolders = () => all().filter((row) => !modelIds().has(row.id) && row.source !== 'shared-models' && !selected().some((chosen) => chosen.id === row.id))
  const unusedCount = () => unusedModels().length + unusedFolders().length
  const path = (mount: MountDescriptor) => all().find((row) => row.id === mount.id)?.path ?? mount.path
  const disabled = () => busy() || settings()?.mountChangesAllowed !== true
  const counts = (ids: readonly string[]) => ids.map((id) => all().find((row) => row.id === id)).filter((row): row is MountDescriptor => row !== undefined)
  const reading = (mounts: readonly MountDescriptor[]) => {
    const progress = mounts.filter((mount) => mount.state === 'scanning').flatMap((mount) => mount.scanProgress ? [mount.scanProgress] : [])
    return progress.length === 0 ? undefined : progress.reduce((sum, row) => ({
      filesDone: sum.filesDone + row.filesDone, filesTotal: sum.filesTotal + row.filesTotal,
      bytesDone: sum.bytesDone + row.bytesDone, bytesTotal: sum.bytesTotal + row.bytesTotal,
      elapsedSeconds: Math.max(sum.elapsedSeconds, row.elapsedSeconds),
    }), { filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, elapsedSeconds: 0 })
  }
  const scan = (progress: MountScanProgress) => <div class="dinkster-stack">
    <ProductProgress label={message('storagePanel.reading', { done: progress.filesDone, total: progress.filesTotal })}
      value={progress.bytesTotal > 0 ? progress.bytesDone / progress.bytesTotal : undefined} />
    <span class="dinkster-metadata">{message('storagePanel.bytesRead', { done: formatSize(progress.bytesDone), total: formatSize(progress.bytesTotal) })}</span>
  </div>
  const kinds = (ids: readonly string[]) => {
    const result = new Map<string, number | undefined>()
    for (const row of counts(ids)) {
      if (!row.kind || row.entryCount === 0) continue
      const previous = result.get(row.kind)
      result.set(row.kind, row.entryCount === undefined || (result.has(row.kind) && previous === undefined)
        ? undefined : (previous ?? 0) + row.entryCount)
    }
    return [...result].map(([kind, count]) => ({ kind, count }))
  }
  const kindLabel = (kind: string) => {
    const key = `storagePanel.kind.${kind.split('/').at(-1)}`
    const label = message(key)
    return label === key ? kind.split('/').at(-1)!.replaceAll('-', ' ') : label
  }
  const setOutput = (mount: MountDescriptor) => void perform(() => props.connection.selectOutputMount(mount.id))
  const useFolder = (id: string) => void perform(() => props.connection.updateProjectFolders([...selected().map((row) => row.id), id], settings()?.outputMount ?? null))
  const move = (id: string, direction: number) => {
    const order = selected().map((row) => row.id)
    const index = order.indexOf(id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= order.length) return
    order.splice(index, 1)
    order.splice(target, 0, id)
    void perform(() => props.connection.updateProjectFolders(order, settings()?.outputMount ?? null))
  }
  const leave = () => {
    const target = leaving()
    if (!target) return
    if (target.model) void perform(() => props.connection.setModelLocationEnabled(target.id, false))
    else {
      const output = target.id === settings()?.outputMount ? replacement() : settings()?.outputMount ?? null
      if (output === '') return
      void perform(() => props.connection.updateProjectFolders(selected().filter((row) => row.id !== target.id).map((row) => row.id), output))
    }
  }
  const mountFailure = (mount: MountDescriptor) => <Show when={mount.state === 'failed'}>
    <ProductNotice tone="warning">{mount.error || mount.state} <ProductTextButton label={message('desktopSetup.retry')} disabled={disabled()}
      onClick={() => { void perform(() => props.connection.retryMount(mount.id)) }} /></ProductNotice>
  </Show>
  const folderPath = (value: string) => {
    const split = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
    return <code class="storage-folder-path" title={value}><span>{value.slice(0, split + 1)}</span><span>{value.slice(split + 1)}</span></code>
  }
  const modelCount = (ids: readonly string[]) => {
    const mounts = counts(ids)
    return mounts.length !== ids.length || mounts.some((mount) => mount.entryCount === undefined)
      ? undefined : mounts.reduce((sum, mount) => sum + mount.entryCount!, 0)
  }
  const modelRow = (location: ModelSettingsState['locations'][number]) => {
    const [opened, setOpened] = createSignal(false)
    createEffect(() => { if (props.focus?.modelLocationId === location.id) setOpened(true) })
    const disclosure = location.enabled ? { get expanded() { return opened() }, onToggle: setOpened } : {}
    return <ProductListRow dataAttributes={{ 'data-model-location': location.id }}
      title={<strong>{location.id}</strong>}
      description={<span class="storage-folder-description">{folderPath(location.path)}
        <Show when={location.mode === 'read'}><span>{message('storagePanel.readOnly')}</span></Show>
        <Show when={models()?.settings.downloadLocation === location.id}><span class="storage-folder-mark">{message('storagePanel.downloads')}</span></Show>
        <Show when={!location.active}><span>{message('modelSettings.inactive')}</span></Show>
      </span>}
      trailing={<Show when={reading(counts(location.mounts))} fallback={<Show when={modelCount(location.mounts) !== undefined}>{message('storagePanel.modelCount', { count: modelCount(location.mounts)! })}</Show>}>
        {(progress) => message('storagePanel.reading', { done: progress().filesDone, total: progress().filesTotal })}
      </Show>}
      {...disclosure}
      status={reading(counts(location.mounts)) || counts(location.mounts).some((mount) => mount.state === 'failed')
        ? <><Show when={reading(counts(location.mounts))}>{(progress) => scan(progress())}</Show><For each={counts(location.mounts)}>{mountFailure}</For></> : undefined}
      action={<ProductMenu icon={Ellipsis} iconOnly fill="quiet" label={message('storagePanel.actions', { folder: location.id })} items={[
        { label: message('modelSettings.edit'), disabled: busy() || models()?.changesAllowed !== true, onSelect: () => { setEditModel(location.id); setEditing('model') } },
        ...(location.enabled && location.visibility !== 'always-on'
          ? [{ label: message('projectFolders.remove'), intent: 'remove' as const, disabled: disabled(), onSelect: () => setLeaving({ id: location.id, model: true }) }]
          : !location.enabled ? [{ label: message('storagePanel.use'), intent: 'add' as const, disabled: disabled(), onSelect: () => { void perform(() => props.connection.setModelLocationEnabled(location.id, true)) } }] : []),
        ...(location.mode === 'readwrite' && models()?.settings.downloadLocation !== location.id
          ? [{ label: message('storagePanel.downloadHere'), disabled: disabled(), onSelect: () => { const state = models()!; void perform(() => props.connection.updateModelSettings({ ...state.settings, downloadLocation: location.id }, state.revision)) } }] : []),
      ]} />}>
        <ProductFacts label={message('storagePanel.kinds')} items={kinds(location.mounts).map((row) => ({ label: kindLabel(row.kind), value: row.count }))} />
        <Show when={kinds(location.mounts).length === 0}><p class="dinkster-metadata">{message('storagePanel.noKinds')}</p></Show>
        <Show when={props.onOpenModels}><ProductTextButton label={message('storagePanel.showModels')} onClick={() => props.onOpenModels?.(location.id)} /></Show>
    </ProductListRow>
  }
  const folderRow = (mount: MountDescriptor, used: boolean) => <ProductListRow dataAttributes={{ 'data-mount-id': mount.id }}
    title={<strong>{mount.id}</strong>} {...(used ? { onActivate: () => props.onOpenAssets(mount.id) } : {})}
    description={<span class="storage-folder-description">
      <Show when={path(mount)}>{(value) => folderPath(value())}</Show>
      <Show when={mount.mode === 'read'}><span>{message('storagePanel.readOnly')}</span></Show>
      <Show when={mount.id === settings()?.outputMount}><span class="storage-folder-mark">{message('storagePanel.saves')}</span></Show>
      <Show when={mount.id === locations()?.importMount}><span class="storage-folder-mark">{message('storagePanel.imports')}</span></Show>
      <Show when={!['ready', 'failed', 'scanning'].includes(mount.state)}><span>{mount.state}</span></Show>
    </span>}
    trailing={<Show when={reading([mount])} fallback={<Show when={mount.entryCount !== undefined}>{message('storagePanel.files', { count: mount.entryCount! })}</Show>}>
      {(progress) => message('storagePanel.reading', { done: progress().filesDone, total: progress().filesTotal })}
    </Show>}
    status={mount.state === 'failed' || reading([mount]) ? <>{mountFailure(mount)}<Show when={reading([mount])}>{(progress) => scan(progress())}</Show></> : undefined}
    action={<ProductMenu icon={Ellipsis} iconOnly fill="quiet" label={message('storagePanel.actions', { folder: mount.id })} items={used ? [
        { label: message('storagePanel.openAssets'), onSelect: () => props.onOpenAssets(mount.id) },
        ...(mount.mode === 'readwrite' && mount.id !== settings()?.outputMount ? [{ label: message('storagePanel.saveHere'), disabled: disabled(), onSelect: () => setOutput(mount) }] : []),
        { label: message('projectFolders.up'), disabled: disabled() || selected()[0]?.id === mount.id, onSelect: () => move(mount.id, -1) },
        { label: message('projectFolders.down'), disabled: disabled() || selected().at(-1)?.id === mount.id, onSelect: () => move(mount.id, 1) },
        { label: message('projectFolders.retry'), disabled: disabled() || mount.state === 'restart-required', onSelect: () => { void perform(() => props.connection.retryMount(mount.id)) } },
        { label: message('projectFolders.remove'), intent: 'remove', disabled: disabled(), onSelect: () => { setReplacement(''); setLeaving({ id: mount.id, model: false }) } },
      ] : [{ label: message('storagePanel.use'), intent: 'add', disabled: disabled(), onSelect: () => useFolder(mount.id) }]} />} />

  return <div class="storage-folders" data-testid="storage-folders">
    <Show when={error()}><ProductErrorBanner onDismiss={() => setError('')}>{error()} <ProductButton disabled={busy()} onClick={() => { void load() }}>{message('projectFolders.refresh')}</ProductButton></ProductErrorBanner></Show>
    <Show when={settings()} fallback={<Show when={!error()}><ProductLoading label={message('projectFolders.loading')} /></Show>}>
      <Show when={operatorNotice()}><ProductNotice>{message('storagePanel.operatorOnly')}</ProductNotice></Show>
      <Show when={settings()?.restartRequired}><ProductNotice tone="warning">{message('modelSettings.restart')}</ProductNotice></Show>
      <Show when={!settings()?.mountChangesAllowed}><ProductNotice>{message('projectFolders.disabled')}</ProductNotice></Show>
      <Show when={leaving()} keyed fallback={<Show when={editing()} fallback={<>
        <p class="dinkster-metadata">{message('storagePanel.folderCount', { count: usedModels().length + folders().length })}</p>
        <div class="storage-group-heading"><h3>{message('storagePanel.models')}</h3><Show when={models()?.changesAllowed}><ProductTextButton intent="add" onClick={() => setEditing('add-model')} label={message('storagePanel.add')} /></Show></div>
        <Show when={usedModels().length > 0}><ProductList label={message('storagePanel.models')} variant="grouped"><For each={usedModels()}>{modelRow}</For></ProductList></Show>
        <Show when={usedModels().length === 0}><p class="dinkster-metadata">{message('storagePanel.noModels')}</p></Show>
        <div class="storage-group-heading"><h3>{message('storagePanel.folders')}</h3><Show when={settings()?.mountChangesAllowed}><ProductTextButton intent="add" onClick={() => setEditing('folders')} label={message('storagePanel.add')} /></Show></div>
        <Show when={folders().length > 0}><ProductList label={message('storagePanel.folders')} variant="grouped"><For each={folders()}>{(mount) => folderRow(mount, true)}</For></ProductList></Show>
        <Show when={folders().length === 0}><p class="dinkster-metadata">{message('storagePanel.noProjectFolders')}</p></Show>
        <Show when={unusedCount() > 0}><ProductDisclosure title={message('storagePanel.unused', { count: unusedCount() })}>
          <ProductList label={message('storagePanel.unused', { count: unusedCount() })} variant="grouped"><For each={unusedModels()}>{modelRow}</For><For each={unusedFolders()}>{(mount) => folderRow(mount, false)}</For></ProductList>
        </ProductDisclosure></Show>
      </>}>
        {(editor) => <>
          <ProductTextButton icon={ChevronLeft} label={message('storagePanel.title')} onClick={() => { setEditing(undefined); void load() }} />
          <Show when={editor() === 'model'}><ModelSettings connection={props.connection} backendLabel="" backendUrl={props.backendUrl} editLocation={editModel()} onChanged={() => { setEditing(undefined); void load() }} /></Show>
          <Show when={editor() === 'add-model'}><ProductSection title={message('storagePanel.addModelFolder')}><ModelSettings variant="storage-add" connection={props.connection} backendLabel="" backendUrl={props.backendUrl} onCancel={() => setEditing(undefined)} onChanged={() => { setEditing(undefined); void load() }} /></ProductSection></Show>
          <Show when={editor() === 'models'}><ModelSettings connection={props.connection} providerConnection={props.connection} visibilityConnection={props.connection} backendLabel="" backendUrl={props.backendUrl} focusHiddenModels={props.focus?.hiddenModels === true} onChanged={() => { void load() }} /></Show>
          <Show when={editor() === 'folders'}><ProductSection title={message('storagePanel.addMount')}><MountFolderForm variant="storage" connection={props.connection} backendUrl={props.backendUrl} onCancel={() => setEditing(undefined)} onGranted={() => { setEditing(undefined); void load() }} /></ProductSection></Show>
        </>}
      </Show>}>
        {(target) => <>
          <Show when={!target.model && target.id === settings()?.outputMount}>
            <ProductSelect ariaLabel={message('projectFolders.replacement')} selectedId={replacement()}
              options={folders().filter((row) => row.mode === 'readwrite' && row.id !== target.id && row.state !== 'failed').map((row) => ({ id: row.id, label: row.id, value: row.id }))}
              onSelect={(option) => setReplacement(option.value)} />
          </Show>
          <ProductConfirmation title={message('projectFolders.remove')} consequence={message('projectFolders.removeNotice', { folder: target.id })}
            actionLabel={message('projectFolders.confirmRemove')} intent="remove" pending={busy()}
            disabled={!target.model && target.id === settings()?.outputMount && !replacement()}
            onCancel={() => setLeaving(undefined)} onConfirm={() => { if (target.model || target.id !== settings()?.outputMount || replacement()) leave() }} />
        </>}
      </Show>
    </Show>
    <ProductToast notification={notification()} onDismiss={() => setNotification(undefined)} />
  </div>
}
