import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from 'solid-js'
import type { DinksterConnection, ModelSettingsState, MountDescriptor, MountLocations, MountSettings } from '@dinkster/client'
import { ProductButton, ProductConfirmation, ProductDisclosure, ProductErrorBanner, ProductLoading, ProductMenu, ProductNotice, ProductSection, ProductToast } from '@dinkster/ui'
import type { AppState, Backend } from './app-state.js'
import { useSignal } from './solid-adapter.js'
import { useAppMessage } from './locale.js'
import { ProductSelect } from './ProductSelect.js'
import { ProductPanelHeader } from './ProductSurfaces.js'
import { ModelSettings } from './ModelSettings.js'
import { MountFolderForm } from './MountFolderForm.js'
import { OutputMountSettings } from './OutputMountSettings.js'

type NativeBackend = Extract<Backend, { protocol: 'dinkster' }>

export function StoragePanel(props: {
  readonly app: AppState
  readonly backendId: string | undefined
  readonly activeBackend: () => Backend
  readonly onOpenAssets: (backend: Backend) => void
}) {
  const message = useAppMessage()
  const backends = useSignal(props.app.backends)
  const [selected, setSelected] = createSignal<string>()
  createEffect(() => setSelected(props.backendId))
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
      {(native) => <StorageFolders connection={native.connection} backendUrl={native.baseUrl} onOpenAssets={() => props.onOpenAssets(native)} />}
    </Show>
  </section>
}

export function StorageFolders(props: {
  readonly connection: DinksterConnection
  readonly backendUrl: string
  readonly onOpenAssets: () => void
}) {
  const message = useAppMessage()
  const [settings, setSettings] = createSignal<MountSettings>()
  const [locations, setLocations] = createSignal<MountLocations>()
  const [models, setModels] = createSignal<ModelSettingsState>()
  const [error, setError] = createSignal('')
  const [operatorNotice, setOperatorNotice] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [editing, setEditing] = createSignal<'models' | 'folders' | 'output'>()
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
  const perform = async (action: () => Promise<unknown>) => {
    if (busy()) return
    const owner = generation
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
  const modelCard = (location: ModelSettingsState['locations'][number]) => <article class="storage-folder" data-model-location={location.id}>
    <div class="storage-folder-heading">
      <div class="storage-folder-copy"><strong>{location.id}</strong><code>{location.path}</code></div>
      <ProductMenu label={message('storagePanel.actions', { folder: location.id })} items={[
        { label: message('modelSettings.edit'), disabled: busy(), onSelect: () => setEditing('models') },
        ...(location.enabled && location.visibility !== 'always-on'
          ? [{ label: message('projectFolders.remove'), intent: 'remove' as const, disabled: disabled(), onSelect: () => setLeaving({ id: location.id, model: true }) }]
          : !location.enabled ? [{ label: message('storagePanel.use'), intent: 'add' as const, disabled: disabled(), onSelect: () => { void perform(() => props.connection.setModelLocationEnabled(location.id, true)) } }] : []),
        ...(location.mode === 'readwrite' && models()?.settings.downloadLocation !== location.id
          ? [{ label: message('storagePanel.downloadHere'), disabled: disabled(), onSelect: () => { const state = models()!; void perform(() => props.connection.updateModelSettings({ ...state.settings, downloadLocation: location.id }, state.revision)) } }] : []),
      ]} />
    </div>
    <Show when={location.enabled}>
      <ProductDisclosure title={message('storagePanel.kinds')}>
        <dl class="dinkster-facts"><For each={kinds(location.mounts)}>{(row) => <div class="dinkster-fact"><dt>{kindLabel(row.kind)}</dt><dd>{row.count}</dd></div>}</For></dl>
        <Show when={kinds(location.mounts).length === 0}><p class="dinkster-metadata">{message('storagePanel.noKinds')}</p></Show>
      </ProductDisclosure>
    </Show>
    <Show when={location.mode === 'read'}><span class="dinkster-metadata">{message('storagePanel.readOnly')}</span></Show>
    <Show when={models()?.settings.downloadLocation === location.id}><span class="storage-folder-mark">{message('storagePanel.downloads')}</span></Show>
    <Show when={!location.active}><span class="dinkster-metadata">{message('modelSettings.inactive')}</span></Show>
  </article>
  const folderCard = (mount: MountDescriptor, used: boolean) => <article class="storage-folder" data-mount-id={mount.id}>
    <div class="storage-folder-heading">
      <div class="storage-folder-copy"><strong>{mount.id}</strong><Show when={path(mount)}>{(value) => <code>{value()}</code>}</Show></div>
      <ProductMenu label={message('storagePanel.actions', { folder: mount.id })} items={used ? [
        { label: message('storagePanel.openAssets'), onSelect: props.onOpenAssets },
        ...(mount.mode === 'readwrite' && mount.id !== settings()?.outputMount ? [{ label: message('storagePanel.saveHere'), disabled: disabled(), onSelect: () => setOutput(mount) }] : []),
        { label: message('projectFolders.up'), disabled: disabled() || selected()[0]?.id === mount.id, onSelect: () => move(mount.id, -1) },
        { label: message('projectFolders.down'), disabled: disabled() || selected().at(-1)?.id === mount.id, onSelect: () => move(mount.id, 1) },
        { label: message('projectFolders.retry'), disabled: disabled() || mount.state === 'restart-required', onSelect: () => { void perform(() => props.connection.retryMount(mount.id)) } },
        { label: message('projectFolders.remove'), intent: 'remove', disabled: disabled(), onSelect: () => { setReplacement(''); setLeaving({ id: mount.id, model: false }) } },
      ] : [{ label: message('storagePanel.use'), intent: 'add', disabled: disabled(), onSelect: () => useFolder(mount.id) }]} />
    </div>
    <div class="storage-folder-summary">
      <Show when={mount.kind}><span>{kindLabel(mount.kind!)}</span></Show>
      <Show when={mount.entryCount !== undefined}><span>{message('storagePanel.files', { count: mount.entryCount! })}</span></Show>
      <Show when={mount.state !== 'ready'}><span>{mount.state}</span></Show>
      <Show when={mount.mode === 'read'}><span>{message('storagePanel.readOnly')}</span></Show>
      <Show when={used}><ProductButton onClick={props.onOpenAssets}>{message('storagePanel.openAssets')}</ProductButton></Show>
    </div>
    <Show when={mount.id === settings()?.outputMount}><span class="storage-folder-mark">{message('storagePanel.saves')}</span></Show>
    <Show when={mount.id === locations()?.importMount}><span class="storage-folder-mark">{message('storagePanel.imports')}</span></Show>
    <Show when={mount.scanProgress}>{(progress) => <p class="dinkster-metadata">{message('projectFolders.scanning', { done: progress().filesDone, total: progress().filesTotal })}</p>}</Show>
  </article>

  return <div class="storage-folders" data-testid="storage-folders">
    <Show when={error()}><ProductErrorBanner onDismiss={() => setError('')}>{error()} <ProductButton disabled={busy()} onClick={() => { void load() }}>{message('projectFolders.refresh')}</ProductButton></ProductErrorBanner></Show>
    <Show when={settings()} fallback={<Show when={!error()}><ProductLoading label={message('projectFolders.loading')} /></Show>}>
      <Show when={operatorNotice()}><ProductNotice>{message('storagePanel.operatorOnly')}</ProductNotice></Show>
      <Show when={settings()?.restartRequired}><ProductNotice tone="warning">{message('modelSettings.restart')}</ProductNotice></Show>
      <Show when={!settings()?.mountChangesAllowed}><ProductNotice>{message('projectFolders.disabled')}</ProductNotice></Show>
      <Show when={leaving()} fallback={<Show when={editing()} fallback={<>
        <p class="dinkster-metadata">{message('storagePanel.folderCount', { count: usedModels().length + folders().length })}</p>
        <div class="storage-group-heading"><h3>{message('storagePanel.models')}</h3><Show when={models()?.changesAllowed}><ProductButton intent="add" onClick={() => setEditing('models')}>{message('storagePanel.add')}</ProductButton></Show></div>
        <For each={usedModels()}>{modelCard}</For>
        <Show when={usedModels().length === 0}><p class="dinkster-metadata">{message('storagePanel.noModels')}</p></Show>
        <div class="storage-group-heading"><h3>{message('storagePanel.folders')}</h3><Show when={settings()?.mountChangesAllowed}><ProductButton intent="add" onClick={() => setEditing('folders')}>{message('storagePanel.add')}</ProductButton></Show></div>
        <For each={folders()}>{(mount) => folderCard(mount, true)}</For>
        <Show when={folders().length === 0}><p class="dinkster-metadata">{message('storagePanel.noProjectFolders')}</p></Show>
        <Show when={unusedCount() > 0}><ProductDisclosure title={message('storagePanel.unused', { count: unusedCount() })}>
          <For each={unusedModels()}>{modelCard}</For><For each={unusedFolders()}>{(mount) => folderCard(mount, false)}</For>
        </ProductDisclosure></Show>
        <ProductButton onClick={() => setEditing('output')}>{message('storagePanel.defaultSave')}</ProductButton>
      </>}>
        {(editor) => <>
          <ProductButton onClick={() => { setEditing(undefined); void load() }}>{message('storagePanel.back')}</ProductButton>
          <Show when={editor() === 'models'}><ModelSettings connection={props.connection} providerConnection={props.connection} visibilityConnection={props.connection} backendLabel="" backendUrl={props.backendUrl} onChanged={() => { void load() }} /></Show>
          <Show when={editor() === 'folders'}><ProductSection title={message('storagePanel.addFolder')}><MountFolderForm connection={props.connection} backendUrl={props.backendUrl} onGranted={() => { setEditing(undefined); void load() }} /></ProductSection></Show>
          <Show when={editor() === 'output'}><OutputMountSettings connection={props.connection} /></Show>
        </>}
      </Show>}>
        {(target) => <>
          <Show when={!target().model && target().id === settings()?.outputMount}>
            <ProductSelect ariaLabel={message('projectFolders.replacement')} selectedId={replacement()}
              options={folders().filter((row) => row.mode === 'readwrite' && row.id !== target().id && row.state !== 'failed').map((row) => ({ id: row.id, label: row.id, value: row.id }))}
              onSelect={(option) => setReplacement(option.value)} />
          </Show>
          <ProductConfirmation title={message('projectFolders.remove')} consequence={message('projectFolders.removeNotice', { folder: target().id })}
            actionLabel={message('projectFolders.confirmRemove')} intent="remove" pending={busy()}
            onCancel={() => setLeaving(undefined)} onConfirm={() => { if (target().model || target().id !== settings()?.outputMount || replacement()) leave() }} />
        </>}
      </Show>
    </Show>
    <ProductToast notification={notification()} onDismiss={() => setNotification(undefined)} />
  </div>
}
