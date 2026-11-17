import { createEffect, createSignal, For, onCleanup, Show, untrack } from 'solid-js'
import type { DinksterConnection, ModelLocation, ModelSettingsState } from '@dinkster/client'
import { ProductButton, ProductCheckbox, ProductTextInput } from './ProductControls.js'
import { ProductField, ProductNotice } from './ProductForm.js'
import { ProductSelect } from './ProductSelect.js'
import { useAppMessage } from './locale.js'
import { desktopFileBridge } from './desktop-bridge.js'
import { ModelProvider, type ModelProviderConnection } from './ModelProvider.js'

export function ModelSettings(props: {
  readonly connection: Pick<DinksterConnection, 'fetchModelSettings' | 'updateModelSettings' | 'setModelLocationEnabled' | 'onMountsChanged'>
  readonly providerConnection?: ModelProviderConnection
  readonly backendLabel: string
  readonly backendUrl?: string
  readonly onChanged?: () => void
}) {
  const message = useAppMessage()
  const [state, setState] = createSignal<ModelSettingsState>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const [id, setId] = createSignal('')
  const [path, setPath] = createSignal('')
  const [kind, setKind] = createSignal('')
  const [writable, setWritable] = createSignal(false)
  const [removing, setRemoving] = createSignal<string>()
  const [editing, setEditing] = createSignal<string>()
  let editRevision = ''
  const [nativeChoice, setNativeChoice] = createSignal(false)
  const resetForm = () => { setEditing(undefined); setId(''); setPath(''); setKind(''); setWritable(false) }
  let generation = 0
  let read = 0
  const load = async (): Promise<void> => {
    const request = ++read
    const owner = generation
    try {
      const next = await props.connection.fetchModelSettings()
      if (owner !== generation || request !== read) return
      setState(next)
      setError('')
    } catch (cause) {
      if (owner === generation && request === read) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  createEffect(() => {
    const connection = props.connection
    const backendUrl = props.backendUrl
    generation++
    read++
    setState(undefined)
    setBusy(false)
    setError('')
    setRemoving(undefined)
    resetForm()
    setNativeChoice(false)
    const owner = generation
    const bridge = desktopFileBridge()
    if (backendUrl !== undefined && bridge?.chooseDirectory) {
      void bridge.fileCapabilities(new URL(backendUrl || '/', window.location.href).href).then((capabilities) => {
        if (owner === generation) setNativeChoice(capabilities.nativeFolderChoice)
      }).catch(() => undefined)
    }
    onCleanup(connection.onMountsChanged(() => { if (!busy()) void load() }))
    onCleanup(() => { generation++; read++ })
    untrack(() => { void load() })
  })
  const perform = async (action: () => Promise<ModelSettingsState>): Promise<boolean> => {
    if (busy()) return false
    const owner = generation
    read++
    setBusy(true)
    setError('')
    try {
      const next = await action()
      if (owner !== generation) return false
      setState(next)
      setRemoving(undefined)
      props.onChanged?.()
      return true
    } catch (cause) {
      if (owner === generation) setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally { if (owner === generation) setBusy(false) }
  }
  const save = (locations: readonly ModelLocation[], downloadLocation = state()?.settings.downloadLocation ?? null) => {
    const current = state()
    if (!current) return Promise.resolve(false)
    return perform(() => props.connection.updateModelSettings({ version: 1, locations, downloadLocation }, current.revision))
  }
  const update = (location: ModelLocation) => {
    const current = state()
    if (current) void save(current.settings.locations.map((row) => row.id === location.id ? location : row))
  }
  const remove = () => {
    const current = state()
    const target = removing()
    if (!current || !target) return
    const locations = current.settings.locations.filter((row) => row.id !== target)
    void save(locations, current.settings.downloadLocation === target ? locations.find((row) => row.mode === 'readwrite')?.id ?? null : current.settings.downloadLocation)
  }
  const add = async () => {
    const current = state()
    if (!current || !id().trim() || !path().trim()) return
    if (editing() && current.revision !== editRevision) { setError(message('modelSettings.staleEdit')); return }
    const previous = current.settings.locations.find((row) => row.id === editing())
    const location: ModelLocation = { id: id().trim(), path: path().trim(), mode: writable() ? 'readwrite' : 'read', visibility: previous?.visibility ?? 'default-on',
      ...(kind().trim() ? { kind: kind().trim() } : {}) }
    const locations = editing() ? current.settings.locations.map((row) => row.id === editing() ? location : row) : [...current.settings.locations, location]
    const download = current.settings.downloadLocation === location.id && !writable()
      ? locations.find((row) => row.mode === 'readwrite')?.id ?? null
      : current.settings.downloadLocation ?? (writable() ? location.id : null)
    if (await save(locations, download)) resetForm()
  }
  const choose = async () => {
    if (busy() || !nativeChoice() || props.backendUrl === undefined) return
    const owner = generation
    setBusy(true)
    setError('')
    try {
      const selected = await desktopFileBridge()!.chooseDirectory(new URL(props.backendUrl || '/', window.location.href).href)
      if (owner === generation && selected) setPath(selected)
    } catch (cause) {
      if (owner === generation) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (owner === generation) setBusy(false) }
  }
  const reveal = async (location: string) => {
    const bridge = desktopFileBridge()
    if (busy() || !nativeChoice() || props.backendUrl === undefined || !bridge?.revealModelLocation) return
    const owner = generation
    setBusy(true)
    setError('')
    try { await bridge.revealModelLocation(new URL(props.backendUrl || '/', window.location.href).href, location) }
    catch (cause) { if (owner === generation) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (owner === generation) setBusy(false) }
  }
  const copy = async (value: string) => {
    const owner = generation
    try { await navigator.clipboard.writeText(value) }
    catch (cause) { if (owner === generation) setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const disabled = () => busy() || state()?.changesAllowed !== true
  const visibilityOptions = () => (['always-on', 'default-on', 'opt-in'] as const).map((value) => ({ id: value, value, label: message(`modelSettings.${value}`) }))

  return <section class="runtime-settings project-folder-settings" data-testid="model-settings">
    <div class="runtime-settings-body">
      <div class="runtime-settings-toolbar">
        <div><h3>{message('modelSettings.title')}</h3><p>{message('modelSettings.description', { machine: props.backendLabel })}</p></div>
        <ProductButton disabled={busy()} onClick={() => { resetForm(); void load() }}>{message('projectFolders.refresh')}</ProductButton>
      </div>
      <Show when={error()}><ProductNotice tone="error">{error()}</ProductNotice></Show>
      <Show when={props.providerConnection}>{(connection) => <ModelProvider connection={connection()} {...(props.backendUrl === undefined ? {} : { backendUrl: props.backendUrl })} onChanged={() => props.onChanged?.()} />}</Show>
      <Show when={state()}>{(current) => <>
        <p>{message('modelSettings.project', { project: current().project })}</p>
        <Show when={!current().changesAllowed}><ProductNotice tone="warning">{message('projectFolders.disabled')}</ProductNotice></Show>
        <Show when={current().restartRequired}><ProductNotice tone="warning">{message('modelSettings.restart')}</ProductNotice></Show>
        <ProductField controlId="model-download-location" label={message('modelSettings.download')} layout="stack">
          <ProductSelect id="model-download-location" selectedId={current().settings.downloadLocation ?? ''} disabled={disabled() || !current().settings.locations.some((row) => row.mode === 'readwrite')} options={current().settings.locations.filter((row) => row.mode === 'readwrite').map((row) => ({ id: row.id, value: row.id, label: `${row.id} - ${row.path}` }))} onSelect={(option) => void save(current().settings.locations, option.value)} />
        </ProductField>
        <Show when={current().settings.downloadLocation === null}><ProductNotice tone="info">{message('modelSettings.noDownload')}</ProductNotice></Show>
        <ol class="project-folder-list">
          <For each={current().locations.map((row) => row.id)}>{(locationId) => {
            const location = () => current().locations.find((row) => row.id === locationId)!
            return <li data-model-location={locationId}>
              <div class="project-folder-facts">
                <strong>{locationId}</strong><code>{location().path}</code>
                <span>{location().kind || message('modelSettings.layout')} - {message(location().mode === 'read' ? 'projectFolders.read' : 'projectFolders.readwrite')}</span>
                <Show when={!location().active}><span>{message('modelSettings.inactive')}</span></Show>
                <ProductField controlId={`model-visibility-${locationId}`} label={message('modelSettings.visibility')} layout="stack">
                  <ProductSelect id={`model-visibility-${locationId}`} selectedId={location().visibility} disabled={disabled()} options={visibilityOptions()} onSelect={(option) => update({ id: locationId, path: location().path, mode: location().mode, visibility: option.value, ...(location().kind === undefined ? {} : { kind: location().kind! }) })} />
                </ProductField>
                <label class="project-folder-shared"><ProductCheckbox checked={location().enabled} disabled={disabled() || location().visibility === 'always-on'} ariaLabel={message('modelSettings.enabled', { folder: locationId })} onChange={(enabled) => void perform(() => props.connection.setModelLocationEnabled(locationId, enabled))} />{message('modelSettings.enabled', { folder: locationId })}</label>
              </div>
              <div class="project-folder-actions">
                <ProductButton disabled={busy()} onClick={() => void copy(location().path)}>{message('assetLocation.copy')}</ProductButton>
                <Show when={nativeChoice() && desktopFileBridge()?.revealModelLocation}><ProductButton disabled={busy()} onClick={() => void reveal(locationId)}>{message('modelSettings.reveal')}</ProductButton></Show>
                <ProductButton disabled={disabled()} onClick={() => { setEditing(locationId); editRevision = current().revision; setId(locationId); setPath(location().path); setKind(location().kind ?? ''); setWritable(location().mode === 'readwrite'); setRemoving(undefined) }}>{message('modelSettings.edit')}</ProductButton>
                <ProductButton disabled={disabled()} onClick={() => setRemoving(locationId)}>{message('modelSettings.remove')}</ProductButton>
              </div>
            </li>
          }}</For>
        </ol>
        <Show when={removing()}><div class="project-folder-removal">
          <ProductNotice tone="warning">{message('modelSettings.removeNotice', { folder: removing()! })}</ProductNotice>
          <div class="project-folder-actions">
            <ProductButton disabled={busy()} onClick={() => setRemoving(undefined)}>{message('projectFolders.cancel')}</ProductButton>
            <ProductButton variant="danger" disabled={disabled()} onClick={remove}>{message('modelSettings.remove')}</ProductButton>
          </div>
        </div></Show>
        <Show when={current().changesAllowed}><form class="model-location-form" onSubmit={(event) => { event.preventDefault(); void add() }}>
          <h4>{message(editing() ? 'modelSettings.edit' : 'modelSettings.add')}</h4>
          <Show when={editing()}><ProductNotice tone="warning">{message('modelSettings.editNotice')}</ProductNotice></Show>
          <Show when={nativeChoice()}><ProductButton type="button" disabled={disabled()} onClick={() => void choose()}>{message('desktopManagement.folders.choose')}</ProductButton></Show>
          <ProductField controlId="model-location-id" label={message('desktopManagement.folders.mountName')} layout="stack"><ProductTextInput id="model-location-id" value={id()} readOnly={editing() !== undefined} disabled={disabled()} required onInput={(event) => setId(event.currentTarget.value)} /></ProductField>
          <ProductField controlId="model-location-path" label={message('modelSettings.path')} layout="stack"><ProductTextInput id="model-location-path" value={path()} disabled={disabled()} required onInput={(event) => setPath(event.currentTarget.value)} /></ProductField>
          <ProductField controlId="model-location-kind" label={message('projectFolders.purpose')} description={message('modelSettings.kindHint')} layout="stack"><ProductTextInput id="model-location-kind" aria-describedby="model-location-kind-description" value={kind()} disabled={disabled()} onInput={(event) => setKind(event.currentTarget.value)} /></ProductField>
          <label class="project-folder-shared"><ProductCheckbox checked={writable()} disabled={disabled()} ariaLabel={message('modelSettings.writable')} onChange={setWritable} />{message('modelSettings.writable')}</label>
          <ProductButton type="submit" variant="primary" disabled={disabled() || !id().trim() || !path().trim()}>{message(editing() ? 'modelSettings.save' : 'modelSettings.add')}</ProductButton>
          <Show when={editing()}><ProductButton type="button" disabled={busy()} onClick={resetForm}>{message('projectFolders.cancel')}</ProductButton></Show>
        </form></Show>
      </>}</Show>
    </div>
  </section>
}
