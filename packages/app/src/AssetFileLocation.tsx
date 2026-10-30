import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import type { DinksterConnection } from '@dinkster/client'
import { desktopFileBridge } from './desktop-bridge.js'
import { ProductButton } from './ProductControls.js'
import { ProductNotice } from './ProductForm.js'
import { useAppMessage } from './locale.js'

export function AssetFileLocation(props: {
  readonly connection: Pick<DinksterConnection, 'fetchAssetLocations'>
  readonly backendUrl: string
  readonly backendLabel?: string | undefined
  readonly digest: string
  readonly project: string
  readonly isCurrent?: () => boolean
}) {
  const message = useAppMessage()
  const [paths, setPaths] = createSignal<readonly string[]>([])
  const [canReveal, setCanReveal] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  let generation = 0
  createEffect(() => {
    const connection = props.connection
    const digest = props.digest
    const url = new URL(props.backendUrl || '/', window.location.href).href
    const project = props.project
    const request = ++generation
    onCleanup(() => { generation++ })
    setPaths([])
    setCanReveal(false)
    setBusy(false)
    setError('')
    if (!/^blake3:[a-f0-9]{64}$/.test(digest) || !project) return
    void connection.fetchAssetLocations(digest).then((locations) => {
      if (request === generation) setPaths(locations)
    }).catch((failure: unknown) => {
      if (request === generation) setError(String(failure instanceof Error ? failure.message : failure))
    })
    const bridge = desktopFileBridge()
    if (bridge?.fileCapabilities && bridge.revealFile) {
      void bridge.fileCapabilities(url).then((capabilities) => {
        if (request === generation) setCanReveal(capabilities.reveal)
      }).catch(() => undefined)
    }
  })
  const act = async (path?: string): Promise<void> => {
    if (busy() || props.isCurrent?.() === false) return
    const request = generation
    const identity = { digest: props.digest, scope: 'local' as const, project: props.project }
    const url = new URL(props.backendUrl || '/', window.location.href).href
    setBusy(true)
    setError('')
    try {
      if (path !== undefined) await navigator.clipboard.writeText(path)
      else if (canReveal()) await desktopFileBridge()!.revealFile!(url, identity)
    } catch (failure) {
      if (request === generation) setError(String(failure instanceof Error ? failure.message : failure))
    } finally {
      if (request === generation) setBusy(false)
    }
  }
  return <section class="runtime-settings-body asset-file-location" data-testid="asset-file-location">
    <Show when={props.backendLabel}>{(machine) => <p>{message('assetLocation.machine', { machine: machine() })}</p>}</Show>
    <Show when={error()}><ProductNotice tone="error">{error()}</ProductNotice></Show>
    <Show when={canReveal()}><ProductButton type="button" disabled={busy()} onClick={() => void act()}>{message('assetLocation.reveal')}</ProductButton></Show>
    <For each={paths()}>{(path) => <div class="asset-file-location-path">
      <code>{path}</code>
      <ProductButton type="button" disabled={busy()} onClick={() => void act(path)}>{message('assetLocation.copy')}</ProductButton>
    </div>}</For>
  </section>
}
