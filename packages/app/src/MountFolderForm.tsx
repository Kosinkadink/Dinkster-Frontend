import { createEffect, createMemo, createSignal, on, onCleanup, Show } from 'solid-js'
import type { MountDescriptor, MountGrantOptions } from '@dinkster/client'
import { useAppMessage } from './locale.js'
import { desktopFileBridge } from './desktop-bridge.js'
import { ProductButton, ProductCheckbox, ProductTextInput } from './ProductControls.js'
import { ProductSelect } from './ProductSelect.js'
import { ProductField } from './ProductForm.js'
import { activeProjectId } from './projects.js'

export interface MountFolderConnection {
  addMount(id: string, path: string, mode: 'read' | 'readwrite', options?: MountGrantOptions): Promise<MountDescriptor>
}

type StatusMessage = { readonly key: string } | { readonly raw: string }

/**
 * Folder grant form shared by the desktop management dialog and the
 * browser template gallery. Only a shell-reported capability enables the native
 * picker; otherwise the operator types a path on the backend machine.
 */
export function MountFolderForm(props: {
  readonly connection: MountFolderConnection
  readonly backendUrl?: string
  readonly onGranted?: () => void
}) {
  const message = useAppMessage()
  const connection = createMemo(() => props.connection)
  const backendUrl = createMemo(() => props.backendUrl)
  const [mountPath, setMountPath] = createSignal('')
  const [mountId, setMountId] = createSignal('')
  const [mode, setMode] = createSignal<'read' | 'readwrite'>('read')
  const [kind, setKind] = createSignal('')
  const [shared, setShared] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [status, setStatus] = createSignal<StatusMessage>()
  const [nativeChoice, setNativeChoice] = createSignal(false)
  let generation = 0
  createEffect(on(() => [backendUrl(), connection()] as const, ([url]) => {
    const bridge = desktopFileBridge()
    let active = true
    setNativeChoice(false)
    setMountPath('')
    setMountId('')
    setMode('read')
    setKind('')
    setShared(false)
    setStatus(undefined)
    setBusy(false)
    generation++
    onCleanup(() => { active = false; generation++ })
    if (url === undefined || !bridge?.chooseDirectory) return
    void bridge.fileCapabilities(new URL(url || '/', window.location.href).href).then((capabilities) => {
      if (active) setNativeChoice(capabilities.nativeFolderChoice)
    }).catch(() => undefined)
  }))

  const enterPath = (next: string): void => {
    setMountPath(next)
    const folder = next.split(/[\\/]/).filter(Boolean).at(-1) ?? 'models'
    setMountId(folder.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'models')
  }

  const choose = async (): Promise<void> => {
    const url = props.backendUrl
    if (!nativeChoice() || url === undefined) return
    const request = generation
    setBusy(true)
    setStatus(undefined)
    try {
      const path = await desktopFileBridge()!.chooseDirectory(new URL(url || '/', window.location.href).href)
      if (request === generation && path) enterPath(path)
    } catch (error) {
      if (request === generation) setStatus({ raw: error instanceof Error ? error.message : String(error) })
    } finally {
      if (request === generation) setBusy(false)
    }
  }

  const addMount = async (): Promise<void> => {
    const path = mountPath().trim()
    if (busy() || !mountId().trim() || !path) return
    const request = generation
    setBusy(true)
    setStatus(undefined)
    try {
      await props.connection.addMount(mountId().trim(), path, mode(), { project: activeProjectId(), shared: shared(), kind: kind().trim() })
      if (request !== generation) return
      setMountPath('')
      setMountId('')
      setStatus({ key: 'desktopManagement.folders.granted' })
      props.onGranted?.()
    } catch (error) {
      if (request === generation) setStatus({ raw: error instanceof Error ? error.message : String(error) })
    } finally {
      if (request === generation) setBusy(false)
    }
  }

  const statusText = (): string => {
    const current = status()
    return current === undefined ? '' : 'raw' in current ? current.raw : message(current.key)
  }

  return (
    <>
      <div class="project-folder-grant-options">
        <ProductField controlId="folder-purpose" label={message('projectFolders.purpose')} layout="stack">
          <ProductTextInput id="folder-purpose" value={kind()} placeholder={message('projectFolders.purposeHint')} disabled={busy()} onInput={(event) => setKind(event.currentTarget.value)} />
        </ProductField>
        <ProductField controlId="folder-access" label={message('projectFolders.access')} layout="stack">
          <ProductSelect id="folder-access" selectedId={mode()} disabled={busy()} options={[
            { id: 'read', label: message('projectFolders.read'), value: 'read' as const },
            { id: 'readwrite', label: message('projectFolders.readwrite'), value: 'readwrite' as const },
          ]} onSelect={(option) => setMode(option.value)} />
        </ProductField>
        <label class="project-folder-shared"><ProductCheckbox checked={shared()} disabled={busy()} ariaLabel={message('projectFolders.shared')} onChange={setShared} />{message('projectFolders.shared')}</label>
        <p>{message('projectFolders.projectOnly')}</p>
      </div>
      <Show when={nativeChoice()} fallback={
        <form class="desktop-mount-form desktop-mount-form-typed" onSubmit={(event) => { event.preventDefault(); void addMount() }}>
          <label for="desktop-mount-path">{message('importAssetResolution.fact.path')}</label>
          <ProductTextInput id="desktop-mount-path" value={mountPath()} onInput={(event) => enterPath(event.currentTarget.value)} required />
          <label for="desktop-mount-id">{message('desktopManagement.folders.mountName')}</label>
          <ProductTextInput id="desktop-mount-id" value={mountId()} onInput={(event) => setMountId(event.currentTarget.value)} required />
          <ProductButton type="submit" variant="primary" disabled={busy() || !mountId().trim() || !mountPath().trim()}>{message('desktopManagement.folders.grant')}</ProductButton>
        </form>
      }>
        <div class="desktop-management-actions">
          <ProductButton type="button" disabled={busy()} onClick={() => void choose()}>{message('desktopManagement.folders.choose')}</ProductButton>
        </div>
        <Show when={mountPath()}>
          <form class="desktop-mount-form" onSubmit={(event) => { event.preventDefault(); void addMount() }}>
            <label for="desktop-mount-id">{message('desktopManagement.folders.mountName')}</label>
            <ProductTextInput id="desktop-mount-id" value={mountId()} onInput={(event) => setMountId(event.currentTarget.value)} required />
            <code>{mountPath()}</code>
            <ProductButton type="submit" variant="primary" disabled={busy() || !mountId().trim()}>{message('desktopManagement.folders.grant')}</ProductButton>
          </form>
        </Show>
      </Show>
      <Show when={status()}>
        <p class="desktop-management-message" role="status">{statusText()}</p>
      </Show>
    </>
  )
}
