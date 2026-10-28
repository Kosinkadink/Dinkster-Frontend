import { createEffect, createSignal, createUniqueId, onCleanup, Show, untrack } from 'solid-js'
import type { DinksterConnection, MountLocations, MountSettings } from '@dinkster/client'
import { ProductButton, ProductCheckbox, ProductTextInput } from './ProductControls.js'
import { ProductField, ProductNotice } from './ProductForm.js'
import { ProductSelect } from './ProductSelect.js'
import { useAppMessage } from './locale.js'
import type { UploadDestinationChoice } from './upload-destination.js'

export function UploadDestination(props: {
  readonly connection: Pick<DinksterConnection, 'fetchMountSettings' | 'fetchMountLocations' | 'onMountsChanged'>
  readonly machine: string
  readonly value: UploadDestinationChoice
  readonly disabled?: boolean
  readonly onChange: (value: UploadDestinationChoice) => void
}) {
  const message = useAppMessage()
  const id = createUniqueId()
  const [settings, setSettings] = createSignal<MountSettings>()
  const [locations, setLocations] = createSignal<MountLocations>()
  const [error, setError] = createSignal('')
  let generation = 0
  const load = async (): Promise<void> => {
    const request = ++generation
    setError('')
    try {
      const [next, paths] = await Promise.all([props.connection.fetchMountSettings(), props.connection.fetchMountLocations()])
      if (request !== generation) return
      setSettings(next)
      setLocations(paths)
    } catch {
      if (request === generation) { setSettings(undefined); setLocations(undefined); setError(message('uploadDestination.unavailable')) }
    }
  }
  createEffect(() => {
    const connection = props.connection
    setSettings(undefined)
    setLocations(undefined)
    onCleanup(connection.onMountsChanged(() => { void load() }))
    onCleanup(() => { generation++ })
    untrack(() => { void load() })
  })
  const writable = () => locations()?.activeMounts?.filter((mount) => mount.mode === 'readwrite' && mount.state !== 'failed' &&
    settings()?.mounts.some((configured) => configured.id === mount.id && configured.mode === 'readwrite')) ?? []
  const selected = () => writable().find((mount) => mount.id === props.value.mount)
  const unavailable = () => Boolean(props.value.mount) && selected() === undefined
  return <section class="runtime-settings-body upload-destination" data-testid="upload-destination">
    <ProductField controlId={`${id}-mount`} label={message('uploadDestination.folder')} layout="stack"
      description={message('uploadDestination.machine', { machine: props.machine })}>
      <ProductSelect id={`${id}-mount`} testId="upload-destination-mount" selectedId={props.value.mount ?? ''}
        ariaLabel={message('uploadDestination.folder')} disabled={props.disabled === true}
        options={[
          { id: '', value: '', label: message('uploadDestination.default') },
          ...writable().map((mount) => ({ id: mount.id, value: mount.id, label: `${mount.id} - ${mount.path}` })),
          ...(unavailable() ? [{ id: props.value.mount!, value: props.value.mount!, label: message('uploadDestination.missing', { mount: props.value.mount! }), disabled: true }] : []),
        ]}
        onSelect={(option) => props.onChange({ ...props.value, mount: option.value, folder: '' })} />
    </ProductField>
    <ProductField controlId={`${id}-folder`} label={message('uploadDestination.subfolder')} layout="stack">
      <ProductTextInput id={`${id}-folder`} data-testid="upload-destination-folder" value={props.value.folder ?? ''}
        disabled={props.disabled} onInput={(event) => props.onChange({ ...props.value, folder: event.currentTarget.value })} />
    </ProductField>
    <ProductField controlId={`${id}-remember`} label={message('uploadDestination.remember')} layout="row">
      <ProductCheckbox id={`${id}-remember`} testId="upload-destination-remember" checked={props.value.remember}
        disabled={props.disabled === true} ariaLabel={message('uploadDestination.remember')}
        onChange={(remember) => props.onChange({ ...props.value, remember })} />
    </ProductField>
    <Show when={selected()} keyed>{(mount) => <ProductNotice tone="info">{message('uploadDestination.selected', { path: mount.path, folder: props.value.folder ?? '' })}</ProductNotice>}</Show>
    <Show when={settings()?.restartRequired}><ProductNotice tone="warning">{message('uploadDestination.restart')}</ProductNotice></Show>
    <Show when={unavailable()}><ProductNotice tone="error">{message('uploadDestination.missing', { mount: props.value.mount! })}</ProductNotice></Show>
    <Show when={error()}><ProductNotice tone="warning">{error()} <ProductButton type="button" disabled={props.disabled} onClick={() => void load()}>{message('projectFolders.refresh')}</ProductButton></ProductNotice></Show>
  </section>
}
