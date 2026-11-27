import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js'
import { RequestFailure, type DinksterConnection, type ModelSettingsState, type MountDescriptor, type MountLocations, type MountSettings, type MountScanProgress } from '@dinkster/client'
import { canvasTypePaintForTheme, modelKindColorMap } from '@dinkster/canvas'
import { formatByteProgress, semanticTokensForTheme } from '@dinkster/core'
import Ellipsis from 'lucide-solid/icons/ellipsis'
import ChevronLeft from 'lucide-solid/icons/chevron-left'
import Download from 'lucide-solid/icons/download'
import Star from 'lucide-solid/icons/star'
import Lock from 'lucide-solid/icons/lock'
import Plus from 'lucide-solid/icons/plus'
import CircleAlert from 'lucide-solid/icons/circle-alert'
import { ProductButton, ProductConfirmation, ProductCountStrip, ProductDisclosure, ProductErrorBanner, ProductField, ProductIcon, ProductList, ProductListRow, ProductLoading, ProductMenu, ProductNotice, ProductProgress, ProductSection, ProductSelect, ProductTextButton, ProductToast } from '@dinkster/ui'
import type { AppState, Backend } from './app-state.js'
import { useSignal } from './solid-adapter.js'
import { useAppMessage } from './locale.js'
import { ModelSettings } from './ModelSettings.js'
import { MountFolderForm } from './MountFolderForm.js'
import { failureMessage, folderFailureMessage } from './request-failure.js'

type NativeBackend = Extract<Backend, { protocol: 'dinkster' }>

function FolderPath(props: { readonly value: string }) {
  const split = () => Math.max(props.value.lastIndexOf('/'), props.value.lastIndexOf('\\'))
  const [shortened, setShortened] = createSignal(false)
  let path!: HTMLElement
  let prefix!: HTMLSpanElement
  let suffix!: HTMLSpanElement
  const measure = () => setShortened(prefix.scrollWidth + suffix.scrollWidth > path.clientWidth)
  onMount(() => {
    const observer = new ResizeObserver(measure)
    observer.observe(path)
    void document.fonts?.ready.then(measure)
    onCleanup(() => observer.disconnect())
  })
  createEffect(() => { props.value; queueMicrotask(measure) })
  return <code ref={path} class="storage-folder-path" title={props.value}>
    <span ref={prefix}>{split() < 0 ? '' : props.value.slice(0, split())}</span>
    <Show when={shortened()}><span>...</span></Show>
    <span ref={suffix}>{split() < 0 ? props.value : props.value.slice(split())}</span>
  </code>
}

export function StoragePanel(props: {
  readonly app: AppState
  readonly focusBackend: { readonly id: string; readonly hiddenModels?: boolean; readonly modelLocationId?: string; readonly addModelFolder?: boolean } | undefined
  readonly activeBackend: () => Backend
  readonly onOpenAssets: (backend: Backend, mountId?: string) => void
  readonly onOpenModels?: (backend: Backend, modelLocationId: string) => void
}) {
  const message = useAppMessage()
  const backends = useSignal(props.app.backends)
  const settingsTick = useSignal(props.app.settings.changed)
  const theme = (): 'dark' | 'light' => (settingsTick(), props.app.settings.get('dinkster.theme'))
  const [selected, setSelected] = createSignal<string>()
  createEffect(() => setSelected(props.focusBackend?.id))
  const backend = createMemo(() => backends().find((row) => row.id === selected()) ?? props.activeBackend())
  return <section class="dinkster-panel dinkster-stack" data-testid="storage-panel">
    <Show when={backends().length > 1}>
      <ProductSelect aria-label={message('storagePanel.backend')} value={backend().id}
        options={backends().map((row) => ({ label: row.label, value: row.id }))}
        onChange={setSelected} />
    </Show>
    <Show when={backend().protocol === 'dinkster' ? backend() as NativeBackend : undefined} keyed
      fallback={<ProductNotice>{message('storagePanel.noFolders')}</ProductNotice>}>
      {(native) => <StorageFolders connection={native.connection} backendUrl={native.baseUrl} theme={theme()}
        onFailure={(detail) => props.app.recordHostLog('error', 'Storage', detail)}
        focus={props.focusBackend?.id === native.id ? props.focusBackend : undefined} onOpenAssets={(id) => props.onOpenAssets(native, id)}
        onOpenModels={props.onOpenModels ? (id) => props.onOpenModels?.(native, id) : undefined} />}
    </Show>
  </section>
}

export function StorageFolders(props: {
  readonly connection: DinksterConnection
  readonly backendUrl: string
  readonly theme?: 'dark' | 'light'
  readonly onOpenAssets: (mountId?: string) => void
  readonly onFailure?: ((detail: string) => void) | undefined
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
      for (const mount of next.mounts) {
        if (mount.state === 'failed' && mount.error) props.onFailure?.(mount.error)
      }
      const [paths, modelState] = await Promise.allSettled([
        props.connection.fetchMountLocations(), props.connection.fetchModelSettings(),
      ])
      if (!current()) return
      setLocations(paths.status === 'fulfilled' ? paths.value : undefined)
      setModels(modelState.status === 'fulfilled' ? modelState.value : undefined)
      setOperatorNotice(paths.status === 'rejected' || modelState.status === 'rejected')
      setError('')
    } catch (cause) {
      if (current()) setError(failureMessage(cause, message('request.storageLoadFailed')))
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
      if (owner === generation) {
        if (leaving()) {
          props.onFailure?.(cause instanceof RequestFailure ? cause.serverMessage ?? cause.message : String(cause))
          const reason = cause instanceof RequestFailure ? new RequestFailure(cause.method, cause.path, cause.status) : cause
          setError(failureMessage(reason, '').trim() || message('request.reason.server'))
        } else setError(failureMessage(cause, message('request.storageSaveFailed')))
      }
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
  const scan = (progress: MountScanProgress) => {
    const bytes = formatByteProgress(progress.bytesDone, progress.bytesTotal)
    return <div class="dinkster-stack">
      <ProductProgress label={message('storagePanel.reading', { done: progress.filesDone, total: progress.filesTotal })}
        value={progress.bytesTotal > 0 ? progress.bytesDone / progress.bytesTotal : undefined} />
      <span class="dinkster-metadata">{message('storagePanel.bytesRead', { done: bytes.received, total: bytes.total })}</span>
    </div>
  }
  const kinds = (ids: readonly string[]) => {
    const result = new Map<string, number | undefined>()
    for (const row of counts(ids)) {
      if (row.entryCount === 0) continue
      const kind = row.kind && Object.hasOwn(modelKindColorMap, row.kind) ? row.kind : 'other'
      const previous = result.get(kind)
      result.set(kind, row.entryCount === undefined || (result.has(kind) && previous === undefined)
        ? undefined : (previous ?? 0) + row.entryCount)
    }
    const theme = props.theme ?? 'dark'
    const colors = canvasTypePaintForTheme(theme).typeColors
    return [...result].flatMap(([kind, count]) => count === undefined ? [] : [{
      kind, label: message(`storagePanel.kind.${kind.split('/').at(-1)}`), count,
      color: kind === 'other' ? semanticTokensForTheme(theme).text.muted : colors[modelKindColorMap[kind]!]!,
    }]).sort((left, right) => left.kind === 'other' ? 1 : right.kind === 'other' ? -1 : right.count - left.count || left.label.localeCompare(right.label))
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
    <ProductNotice tone="warning">{folderFailureMessage(mount.error)} <ProductTextButton label={message('common.tryAgain')} disabled={disabled()}
      onClick={() => { void perform(() => props.connection.retryMount(mount.id)) }} /></ProductNotice>
  </Show>
  const modelCount = (ids: readonly string[]) => {
    const mounts = counts(ids)
    return mounts.length !== ids.length || mounts.some((mount) => mount.entryCount === undefined)
      ? undefined : mounts.reduce((sum, mount) => sum + mount.entryCount!, 0)
  }
  const removalQuestion = (id: string, model: boolean) => <ProductConfirmation
    title={message('projectFolders.removeTitle', { folder: id })}
    consequence={message('projectFolders.removeNotice')}
    actionLabel={message('projectFolders.remove')} intent="neutral" surface="inherit" pending={busy()}
    disabled={!model && id === settings()?.outputMount && !replacement()}
    onCancel={() => { setError(''); setLeaving(undefined) }} onConfirm={leave}>
    <Show when={!model && id === settings()?.outputMount} fallback={<Show when={error()}><p class="dinkster-field-error" role="alert"><ProductIcon icon={CircleAlert} />{message('storagePanel.stopFailed', { folder: id, reason: error() })}</p></Show>}>
      <ProductField label={message('storagePanel.replacement')} error={error() ? message('storagePanel.stopFailed', { folder: id, reason: error() }) : ''}>
        {(attributes) => <ProductSelect {...attributes} value={replacement()} disabled={busy()}
          options={[
            { label: message('storagePanel.chooseMount'), value: '', disabled: true },
            ...folders().filter((row) => row.mode === 'readwrite' && row.id !== id && row.state !== 'failed').map((row) => ({ label: row.id, value: row.id })),
          ]}
          onChange={setReplacement} />}
      </ProductField>
    </Show>
  </ProductConfirmation>
  const modelRow = (location: ModelSettingsState['locations'][number]) => {
    const [opened, setOpened] = createSignal(false)
    createEffect(() => { if (props.focus?.modelLocationId === location.id) setOpened(true) })
    const disclosure = location.enabled ? { get expanded() { return opened() }, onToggle: setOpened } : {}
    return <Show when={leaving()?.model === true && leaving()?.id === location.id} fallback={<ProductListRow dataAttributes={{ 'data-model-location': location.id }}
      title={<strong>{location.id}</strong>}
      description={<span class="storage-folder-description"><FolderPath value={location.path} />
        <Show when={location.mode === 'read'}><span class="storage-folder-role"><ProductIcon icon={Lock} />{message('storagePanel.readOnly')}</span></Show>
        <Show when={models()?.settings.downloadLocation === location.id}><span class="storage-folder-role storage-folder-mark"><ProductIcon icon={Download} />{message('storagePanel.downloads')}</span></Show>
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
          ? [{ label: message('projectFolders.remove'), disabled: disabled(), onSelect: () => setLeaving({ id: location.id, model: true }) }]
          : !location.enabled ? [{ label: message('storagePanel.use'), intent: 'add' as const, disabled: disabled(), onSelect: () => { void perform(() => props.connection.setModelLocationEnabled(location.id, true)) } }] : []),
        ...(location.mode === 'readwrite' && models()?.settings.downloadLocation !== location.id
          ? [{ label: message('storagePanel.downloadHere'), disabled: disabled(), onSelect: () => { const state = models()!; void perform(() => props.connection.updateModelSettings({ ...state.settings, downloadLocation: location.id }, state.revision)) } }] : []),
      ]} />}>
        <ProductCountStrip label={message('storagePanel.kinds')} segments={kinds(location.mounts)} />
        <Show when={kinds(location.mounts).length === 0}><p class="dinkster-metadata">{message('storagePanel.noKinds')}</p></Show>
        <Show when={props.onOpenModels}><ProductTextButton label={message('storagePanel.showModels')} onClick={() => props.onOpenModels?.(location.id)} /></Show>
    </ProductListRow>}>
      <li class="dinkster-row" data-model-location={location.id}>{removalQuestion(location.id, true)}</li>
    </Show>
  }
  const folderRow = (mount: MountDescriptor, used: boolean) => <Show when={leaving()?.model === false && leaving()?.id === mount.id} fallback={<ProductListRow dataAttributes={{ 'data-mount-id': mount.id }}
    title={<strong>{mount.id}</strong>} {...(used ? { onActivate: () => props.onOpenAssets(mount.id) } : {})}
    description={<span class="storage-folder-description">
      <Show when={path(mount)}>{(value) => <FolderPath value={value()} />}</Show>
      <Show when={mount.mode === 'read'}><span class="storage-folder-role"><ProductIcon icon={Lock} />{message('storagePanel.readOnly')}</span></Show>
      <Show when={mount.id === settings()?.outputMount}><span class="storage-folder-role storage-folder-mark"><ProductIcon icon={Star} />{message('storagePanel.saves')}</span></Show>
      <Show when={mount.id === locations()?.importMount}><span class="storage-folder-role storage-folder-mark"><ProductIcon icon={Download} />{message('storagePanel.imports')}</span></Show>
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
        { label: message('storagePanel.readAgain'), disabled: disabled() || mount.state === 'restart-required', onSelect: () => { void perform(() => props.connection.retryMount(mount.id)) } },
        { label: message('projectFolders.remove'), disabled: disabled(), onSelect: () => { setReplacement(''); setLeaving({ id: mount.id, model: false }) } },
      ] : [{ label: message('storagePanel.use'), intent: 'add', disabled: disabled(), onSelect: () => useFolder(mount.id) }]} />} />}>
      <li class="dinkster-row" data-mount-id={mount.id}>{removalQuestion(mount.id, false)}</li>
    </Show>

  return <div class="storage-folders" data-testid="storage-folders">
    <Show when={error() && !leaving()}><ProductErrorBanner onDismiss={() => setError('')}>{error()} <ProductButton disabled={busy()} onClick={() => { void load() }}>{message('projectFolders.refresh')}</ProductButton></ProductErrorBanner></Show>
    <Show when={settings()} fallback={<Show when={!error()}><ProductLoading label={message('projectFolders.loading')} /></Show>}>
      <Show when={operatorNotice()}><ProductNotice>{message('storagePanel.operatorOnly')}</ProductNotice></Show>
      <Show when={settings()?.restartRequired}><ProductNotice tone="warning">{message('modelSettings.restart')}</ProductNotice></Show>
      <Show when={!settings()?.mountChangesAllowed}><ProductNotice>{message('projectFolders.disabled')}</ProductNotice></Show>
      <Show when={editing()} fallback={<>
        <div class="storage-group-heading"><h3>{message('storagePanel.models')}</h3><Show when={models()?.changesAllowed}><ProductTextButton icon={Plus} disabled={busy()} onClick={() => setEditing('add-model')} label={message('storagePanel.add')} /></Show></div>
        <Show when={usedModels().length > 0}><ProductList label={message('storagePanel.models')} variant="grouped"><For each={usedModels()}>{modelRow}</For></ProductList></Show>
        <Show when={usedModels().length === 0}><p class="dinkster-metadata">{message('storagePanel.noModels')}</p></Show>
        <div class="storage-group-heading"><h3>{message('storagePanel.folders')}</h3><Show when={settings()?.mountChangesAllowed}><ProductTextButton icon={Plus} disabled={busy()} onClick={() => setEditing('folders')} label={message('storagePanel.add')} /></Show></div>
        <Show when={folders().length > 0}><ProductList label={message('storagePanel.folders')} variant="grouped"><For each={folders()}>{(mount) => folderRow(mount, true)}</For></ProductList></Show>
        <Show when={folders().length === 0}><p class="dinkster-metadata">{message('storagePanel.noProjectFolders')}</p></Show>
        <Show when={unusedCount() > 0}><ProductDisclosure title={message('storagePanel.unused', { count: unusedCount() })}>
          <ProductList label={message('storagePanel.unused', { count: unusedCount() })} variant="grouped"><For each={unusedModels()}>{modelRow}</For><For each={unusedFolders()}>{(mount) => folderRow(mount, false)}</For></ProductList>
        </ProductDisclosure></Show>
      </>}>
        {(editor) => <>
          <ProductTextButton icon={ChevronLeft} label={message('storagePanel.title')} onClick={() => { setEditing(undefined); void load() }} />
          <Show when={editor() === 'model'}><ModelSettings connection={props.connection} backendLabel="" backendUrl={props.backendUrl} editLocation={editModel()} onChanged={() => { setEditing(undefined); void load() }} /></Show>
          <Show when={editor() === 'add-model'}><ProductSection title={message('storagePanel.addModelFolder')}><ModelSettings variant="storage-add" connection={props.connection} backendLabel="" backendUrl={props.backendUrl} onFailure={props.onFailure} onCancel={() => setEditing(undefined)} onChanged={() => { setEditing(undefined); void load() }} /></ProductSection></Show>
          <Show when={editor() === 'models'}><ModelSettings connection={props.connection} providerConnection={props.connection} visibilityConnection={props.connection} backendLabel="" backendUrl={props.backendUrl} focusHiddenModels={props.focus?.hiddenModels === true} onChanged={() => { void load() }} /></Show>
          <Show when={editor() === 'folders'}><ProductSection title={message('storagePanel.addMount')}><MountFolderForm variant="storage" connection={props.connection} backendUrl={props.backendUrl} onFailure={props.onFailure} onCancel={() => setEditing(undefined)} onGranted={() => { setEditing(undefined); void load() }} /></ProductSection></Show>
        </>}
      </Show>
    </Show>
    <ProductToast notification={notification()} onDismiss={() => setNotification(undefined)} />
  </div>
}
