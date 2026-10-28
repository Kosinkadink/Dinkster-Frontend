import { createEffect, createSignal, For, onCleanup, Show, untrack } from 'solid-js'
import type { DinksterConnection, MountLocations, MountSettings } from '@dinkster/client'
import { MountFolderForm } from './MountFolderForm.js'
import { ProductButton } from './ProductControls.js'
import { ProductField, ProductNotice } from './ProductForm.js'
import { ProductSelect } from './ProductSelect.js'
import { useAppMessage } from './locale.js'

export function ProjectFolderSettings(props: {
  readonly connection: Pick<DinksterConnection, 'fetchMountSettings' | 'fetchMountLocations' | 'updateProjectFolders' | 'addMount' | 'retryMount' | 'onMountsChanged'>
  readonly backendLabel: string
  readonly backendUrl?: string
  readonly onChanged?: () => void
}) {
  const message = useAppMessage()
  const [settings, setSettings] = createSignal<MountSettings>()
  const [locations, setLocations] = createSignal<MountLocations>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const [locationError, setLocationError] = createSignal('')
  const [removing, setRemoving] = createSignal<string>()
  const [replacement, setReplacement] = createSignal('')
  let dragged: string | undefined
  let generation = 0
  let connectionGeneration = 0
  onCleanup(() => { generation++ })

  const load = async (): Promise<void> => {
    const request = ++generation
    const connection = props.connection
    setError('')
    try {
      const next = await connection.fetchMountSettings()
      if (request !== generation) return
      setSettings(next)
      // Physical locations stay in this operator-only surface, never asset DTOs.
      setLocations(undefined)
      setLocationError('')
      try {
        const paths = await connection.fetchMountLocations()
        if (request === generation) setLocations(paths)
      } catch {
        if (request === generation) setLocationError(message('projectFolders.locationsUnavailable'))
      }
    } catch (cause) {
      if (request === generation) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  createEffect(() => {
    const connection = props.connection
    connectionGeneration++
    setBusy(false)
    setSettings(undefined)
    setLocations(undefined)
    setRemoving(undefined)
    onCleanup(connection.onMountsChanged(() => { void load() }))
    onCleanup(() => { generation++; connectionGeneration++ })
    untrack(() => { void load() })
  })
  const perform = async (action: () => Promise<void>): Promise<void> => {
    if (busy()) return
    const request = connectionGeneration
    setBusy(true)
    setError('')
    try {
      await action()
      if (request !== connectionGeneration) return
      setRemoving(undefined)
      await load()
      if (request === connectionGeneration) props.onChanged?.()
    } catch (cause) {
      if (request === connectionGeneration) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (request === connectionGeneration) setBusy(false) }
  }
  const ids = (): string[] => settings()?.mounts.map((mount) => mount.id) ?? []
  const move = (id: string, index: number): void => {
    const order = ids()
    const from = order.indexOf(id)
    if (from < 0 || index < 0 || index >= order.length || from === index) return
    order.splice(from, 1)
    order.splice(index, 0, id)
    void perform(() => props.connection.updateProjectFolders(order, settings()?.outputMount ?? null))
  }
  const path = (id: string): string => locations()?.mounts.find((row) => row.id === id)?.path ?? message('projectFolders.locationsUnavailable')
  const replacements = () => settings()?.mounts.filter((mount) => mount.mode === 'readwrite' && mount.id !== removing() && mount.state !== 'failed') ?? []
  const remove = (): void => {
    const id = removing()
    if (!id) return
    const output = settings()?.outputMount === id ? replacement() : settings()?.outputMount ?? null
    if (output === '') return
    void perform(() => props.connection.updateProjectFolders(ids().filter((item) => item !== id), output))
  }
  const disabled = () => busy() || settings()?.mountChangesAllowed !== true

  return <section class="runtime-settings project-folder-settings" data-testid="project-folder-settings">
    <div class="runtime-settings-body">
      <div class="runtime-settings-toolbar">
        <div><h3>{message('projectFolders.title')}</h3><p>{message('projectFolders.description', { machine: props.backendLabel })}</p></div>
        <ProductButton type="button" disabled={busy()} onClick={() => void load()}>{message('projectFolders.refresh')}</ProductButton>
      </div>
      <Show when={error()}><ProductNotice tone="error">{error()}</ProductNotice></Show>
      <Show when={settings()} fallback={<Show when={!error()}><p>{message('projectFolders.loading')}</p></Show>}>
        {(current) => <>
          <Show when={!current().mountChangesAllowed}><ProductNotice tone="warning">{message('projectFolders.disabled')}</ProductNotice></Show>
          <Show when={current().restartRequired}><ProductNotice tone="warning">{message('projectFolders.restart', { output: current().activeOutputMount ?? message('projectFolders.none') })}</ProductNotice></Show>
          <Show when={current().pendingRemovals?.length}><ProductNotice tone="warning">{message('projectFolders.pendingRemovals', { folders: current().pendingRemovals!.join(', ') })}</ProductNotice></Show>
          <Show when={locationError()}><ProductNotice tone="info">{locationError()}</ProductNotice></Show>
          <ol class="project-folder-list">
            <For each={current().mounts}>{(mount, index) => <li
              data-mount-id={mount.id}
              draggable={!disabled()}
              onDragStart={(event) => { dragged = mount.id; event.dataTransfer?.setData('text/plain', mount.id) }}
              onDragEnd={() => { dragged = undefined }}
              onDragOver={(event) => { if (dragged && !disabled()) event.preventDefault() }}
              onDrop={(event) => { event.preventDefault(); if (dragged && !disabled()) move(dragged, index()); dragged = undefined }}
            >
              <div class="project-folder-facts">
                <strong>{mount.id}</strong><code>{path(mount.id)}</code>
                <span>{props.backendLabel} - {mount.kind || message('projectFolders.anyKind')} - {message(mount.mode === 'read' ? 'projectFolders.read' : 'projectFolders.readwrite')}</span>
                <span>{mount.state}{mount.id === current().outputMount ? ` - ${message('projectFolders.output')}` : ''}</span>
                <Show when={mount.scanProgress}>{(progress) => <span>{message('projectFolders.scanning', { done: progress().filesDone, total: progress().filesTotal })}</span>}</Show>
              </div>
              <div class="project-folder-actions">
                <ProductButton type="button" size="compact" disabled={disabled() || index() === 0} aria-label={message('projectFolders.moveUp', { folder: mount.id })} onClick={() => move(mount.id, index() - 1)}>{message('projectFolders.up')}</ProductButton>
                <ProductButton type="button" size="compact" disabled={disabled() || index() === current().mounts.length - 1} aria-label={message('projectFolders.moveDown', { folder: mount.id })} onClick={() => move(mount.id, index() + 1)}>{message('projectFolders.down')}</ProductButton>
                <ProductButton type="button" size="compact" disabled={disabled() || mount.state === 'restart-required'} onClick={() => void perform(() => props.connection.retryMount(mount.id))}>{message('projectFolders.retry')}</ProductButton>
                <ProductButton type="button" size="compact" disabled={disabled()} onClick={() => { setRemoving(mount.id); setReplacement('') }}>{message('projectFolders.remove')}</ProductButton>
              </div>
            </li>}</For>
          </ol>
          <Show when={removing()}>{(id) => <div class="project-folder-removal">
            <ProductNotice tone="warning">{message('projectFolders.removeNotice', { folder: id() })}</ProductNotice>
            <Show when={id() === current().outputMount}>
              <ProductField controlId="folder-replacement" label={message('projectFolders.replacement')} layout="stack">
                <ProductSelect id="folder-replacement" selectedId={replacement()} options={replacements().map((mount) => ({ id: mount.id, label: mount.id, value: mount.id }))} onSelect={(option) => setReplacement(option.value)} />
              </ProductField>
            </Show>
            <div class="project-folder-actions">
              <ProductButton type="button" disabled={busy()} onClick={() => setRemoving(undefined)}>{message('projectFolders.cancel')}</ProductButton>
              <ProductButton type="button" variant="danger" disabled={disabled() || (id() === current().outputMount && !replacement())} onClick={remove}>{message('projectFolders.confirmRemove')}</ProductButton>
            </div>
          </div>}</Show>
          <Show when={current().mountChangesAllowed}><MountFolderForm connection={props.connection} {...(props.backendUrl === undefined ? {} : { backendUrl: props.backendUrl })} onGranted={() => { void load(); props.onChanged?.() }} /></Show>
        </>}
      </Show>
    </div>
  </section>
}
