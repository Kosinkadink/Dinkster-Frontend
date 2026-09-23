import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { MountDescriptor, MountSettings } from '@dinkster/client'
import {
  DESKTOP_ENGINE_ACCELERATORS,
  desktopBridge,
  desktopEngineAcceleratorLabel,
  type DesktopInfo,
  type DesktopRemoteWorker,
  type DesktopRemoteWorkerMemory,
  type DesktopSystemCheck,
} from './desktop-bridge.js'
import { MountFolderForm } from './MountFolderForm.js'
import { useAppMessage } from './locale.js'
import { ProductButton, ProductTextArea, ProductTextInput } from './ProductControls.js'
import { ProductSelect } from './ProductSelect.js'

export interface DesktopMountConnection {
  fetchMountSettings(): Promise<MountSettings>
  addMount(id: string, path: string, mode: 'read' | 'readwrite'): Promise<MountDescriptor>
}

type StatusMessage = { readonly key: string; readonly params?: Record<string, string | number> } | { readonly raw: string }

class CatalogMessageError extends Error {
  constructor(readonly key: string, readonly params?: Record<string, string | number>) {
    super(key)
  }
}

const formatBytes = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function DesktopManagementDialog(props: { readonly connection: DesktopMountConnection | undefined }) {
  const bridge = desktopBridge()
  const message = useAppMessage()
  const [info, setInfo] = createSignal<DesktopInfo>()
  const [busy, setBusy] = createSignal(false)
  const [statusMessage, setStatusMessage] = createSignal<StatusMessage>()
  const [check, setCheck] = createSignal<DesktopSystemCheck>()
  const [mounts, setMounts] = createSignal<readonly MountDescriptor[]>([])
  const [workers, setWorkers] = createSignal<readonly DesktopRemoteWorker[]>([])
  const [workerFormOpen, setWorkerFormOpen] = createSignal(false)
  const [editingWorker, setEditingWorker] = createSignal<string>()
  const [removingWorker, setRemovingWorker] = createSignal<string>()
  const [workerName, setWorkerName] = createSignal('')
  const [workerEndpoint, setWorkerEndpoint] = createSignal('')
  const [workerTokenFile, setWorkerTokenFile] = createSignal('')
  const [workerTokenFileGrant, setWorkerTokenFileGrant] = createSignal<string>()
  const [workerTlsCaFile, setWorkerTlsCaFile] = createSignal('')
  const [workerTlsCaFileGrant, setWorkerTlsCaFileGrant] = createSignal<string>()
  const [workerNodes, setWorkerNodes] = createSignal('')
  const [workerNodesRestricted, setWorkerNodesRestricted] = createSignal(false)
  const [workerMemory, setWorkerMemory] = createSignal('')
  const workerTransportChanged = (): boolean => {
    const current = workers().find((worker) => worker.name === editingWorker())
    return current !== undefined
      && (current.endpoint !== workerEndpoint().trim() || (current.tlsCaFile ?? '') !== workerTlsCaFile())
  }
  const workerTransportAuthorized = (): boolean => !workerTransportChanged()
    || (workerTokenFileGrant() !== undefined && (!workerTlsCaFile() || workerTlsCaFileGrant() !== undefined))

  const statusMessageText = (): string => {
    const current = statusMessage()
    return current === undefined ? '' : 'raw' in current ? current.raw : message(current.key, current.params)
  }
  const systemGpuLabel = (current: DesktopSystemCheck): string => {
    const gpu = current.gpu
    if (!gpu.available) return message('desktopManagement.system.noGpu')
    return message('desktopManagement.system.gpuAvailable', {
      name: gpu.name ?? 'NVIDIA GPU',
      driver: gpu.driver ? message('desktopManagement.system.driver', { driver: gpu.driver }) : '',
      memory: gpu.memoryMiB ? message('desktopManagement.system.vram', { memory: gpu.memoryMiB }) : '',
    })
  }

  const perform = async (action: () => Promise<unknown>, successKey?: string): Promise<void> => {
    setBusy(true)
    setStatusMessage(undefined)
    try {
      await action()
      if (successKey) setStatusMessage({ key: successKey })
      setInfo(await bridge?.info())
    } catch (error) {
      setStatusMessage(error instanceof CatalogMessageError
        ? { key: error.key, ...(error.params ? { params: error.params } : {}) }
        : { raw: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const refreshMounts = (): void => {
    void props.connection?.fetchMountSettings().then((settings) => setMounts(settings.mounts)).catch(() => undefined)
  }

  onMount(() => {
    if (!bridge) return
    void bridge.info().then(setInfo).catch((error: unknown) => setStatusMessage({ raw: error instanceof Error ? error.message : String(error) }))
    const dispose = bridge.onInfo(setInfo)
    onCleanup(dispose)
    void bridge.systemCheck().then(setCheck).catch(() => undefined)
    void bridge.remoteWorkers().then(setWorkers).catch((error: unknown) => setStatusMessage({ raw: error instanceof Error ? error.message : String(error) }))
    refreshMounts()
  })

  const openWorkerForm = (worker?: DesktopRemoteWorker): void => {
    setEditingWorker(worker?.name)
    setWorkerName(worker?.name ?? '')
    setWorkerEndpoint(worker?.endpoint ?? '')
    setWorkerTokenFile(worker?.tokenFile ?? '')
    setWorkerTokenFileGrant(undefined)
    setWorkerTlsCaFile(worker?.tlsCaFile ?? '')
    setWorkerTlsCaFileGrant(undefined)
    setWorkerNodes(worker?.nodes?.join(', ') ?? '')
    setWorkerNodesRestricted(worker?.nodes !== undefined)
    setWorkerMemory(worker?.memory.map(({ device, size }) => `${device}=${size}`).join('\n') ?? '')
    setRemovingWorker(undefined)
    setWorkerFormOpen(true)
  }

  const closeWorkerForm = (): void => {
    setWorkerFormOpen(false)
    setEditingWorker(undefined)
  }

  const listValues = (value: string): string[] => value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)

  const memoryValues = (value: string): DesktopRemoteWorkerMemory[] => value
    .split(/[,\n]/)
    .filter((entry) => entry !== '')
    .map((entry) => {
      const separator = entry.lastIndexOf('=')
      if (separator <= 0 || separator === entry.length - 1) {
        throw new CatalogMessageError('desktopManagement.worker.memoryInvalid', { entry })
      }
      return { device: entry.slice(0, separator), size: entry.slice(separator + 1).trim() }
    })

  const chooseWorkerFile = async (kind: 'token' | 'tls-ca'): Promise<void> => {
    await perform(async () => {
      const choice = await bridge!.chooseRemoteWorkerFile(kind)
      if (choice) {
        if (kind === 'token') {
          setWorkerTokenFile(choice.path)
          setWorkerTokenFileGrant(choice.grant)
        } else {
          setWorkerTlsCaFile(choice.path)
          setWorkerTlsCaFileGrant(choice.grant)
        }
      }
    })
  }

  const saveWorker = async (): Promise<void> => {
    await perform(async () => {
      const nodes = listValues(workerNodes())
      const tokenFileGrant = workerTokenFileGrant()
      const tlsCaFileGrant = workerTlsCaFileGrant()
      await bridge!.saveRemoteWorker({
        name: workerName(),
        endpoint: workerEndpoint().trim(),
        tokenFile: workerTokenFile(),
        ...(tokenFileGrant ? { tokenFileGrant } : {}),
        ...(workerTlsCaFile() ? { tlsCaFile: workerTlsCaFile() } : {}),
        ...(tlsCaFileGrant ? { tlsCaFileGrant } : {}),
        ...(workerNodesRestricted() ? { nodes } : {}),
        memory: memoryValues(workerMemory()),
      })
      setWorkers(await bridge!.remoteWorkers())
      closeWorkerForm()
    }, 'desktopManagement.worker.saved')
  }

  const removeWorker = async (name: string): Promise<void> => {
    if (removingWorker() !== name) {
      setRemovingWorker(name)
      return
    }
    await perform(async () => {
      await bridge!.removeRemoteWorker(name)
      setWorkers(await bridge!.remoteWorkers())
      setRemovingWorker(undefined)
      if (editingWorker() === name) closeWorkerForm()
    }, 'desktopManagement.worker.removed')
  }

  return (
    <section class="desktop-management" aria-live="polite">
      <Show when={bridge} fallback={<p>{message('desktopManagement.unavailable')}</p>}>
        <Show when={info()} fallback={<p>{message('desktopManagement.loading')}</p>}>
          {(current) => <>
            <div class="desktop-management-summary">
              <div><span>{message('desktopManagement.summary.desktop')}</span><strong>{message('desktopManagement.summary.version', { version: current().appVersion })}</strong></div>
              <div><span>{message('desktopManagement.summary.engine')}</span><strong>{current().engineCommit.slice(0, 12)}</strong></div>
              <div><span>{message('desktopManagement.summary.environment')}</span><strong>{desktopEngineAcceleratorLabel(current().variant)}</strong></div>
              <div><span>{message('desktopManagement.summary.storage')}</span><strong>{formatBytes(current().storageBytes)}</strong></div>
            </div>

            <section class="desktop-management-section">
              <div>
                <h3>{message('desktopManagement.environment.title')}</h3>
                <p>{message('desktopManagement.environment.description')}</p>
              </div>
              <div class="desktop-management-actions">
                <For each={DESKTOP_ENGINE_ACCELERATORS}>{(accelerator) => (
                  <ProductButton type="button" disabled={busy() || current().variant === accelerator} onClick={() => void perform(() => bridge!.selectEngine(current().engineCommit, accelerator))}>
                    {message('desktopManagement.environment.use', { accelerator: desktopEngineAcceleratorLabel(accelerator) })}
                  </ProductButton>
                )}</For>
              </div>
              <Show when={current().releases.some((release) => !release.active)}>
                <div class="desktop-release-list">
                  <h4>{message('desktopManagement.environment.releases')}</h4>
                  <For each={current().releases}>{(release) =>
                    <div>
                      <span><strong>{release.commit.slice(0, 12)}</strong> - {release.variant} - {formatBytes(release.bytes)}</span>
                      <ProductButton type="button" disabled={busy() || release.active} onClick={() => void perform(() => bridge!.selectEngine(release.commit, release.variant))}>{message(release.active ? 'desktopManagement.environment.active' : 'desktopManagement.environment.restore')}</ProductButton>
                    </div>
                  }</For>
                </div>
              </Show>
            </section>

            <section class="desktop-management-section desktop-management-wide">
              <div>
                <h3>{message('desktopManagement.snapshots.title')}</h3>
                <p>{message('desktopManagement.snapshots.description')}</p>
              </div>
              <div class="desktop-management-actions">
                <ProductButton type="button" disabled={busy()} onClick={() => void perform(async () => {
                  const path = await bridge!.exportSnapshot()
                  if (path) setStatusMessage({ key: 'desktopManagement.snapshots.saved', params: { path } })
                })}>{message('desktopManagement.snapshots.export')}</ProductButton>
                <ProductButton type="button" disabled={busy()} onClick={() => void perform(async () => {
                  const restored = await bridge!.importSnapshot()
                  if (restored) setStatusMessage({ key: 'desktopManagement.snapshots.restored' })
                })}>{message('desktopManagement.snapshots.restore')}</ProductButton>
              </div>
            </section>

            <section class="desktop-management-section desktop-management-wide">
              <div>
                <h3>{message('desktopManagement.folders.title')}</h3>
                <p>{message('desktopManagement.folders.description')}</p>
              </div>
              <Show when={props.connection} fallback={<p class="desktop-management-note">{message('desktopManagement.folders.unavailable')}</p>}>
                {(connection) => <>
                  <MountFolderForm
                    connection={connection()}
                    chooseDirectory={() => bridge!.chooseDirectory()}
                    onGranted={refreshMounts}
                  />
                  <div class="desktop-mount-list">
                    <For each={mounts()}>{(mount) => <span>{mount.id} - {mount.state} - {mount.mode}</span>}</For>
                  </div>
                </>}
              </Show>
            </section>

            <section class="desktop-management-section desktop-management-wide">
              <div>
                <h3>{message('desktopManagement.worker.title')}</h3>
                <p>{message('desktopManagement.worker.description')}</p>
                <Show when={current().remoteWorkerProtocol} fallback={<p class="desktop-management-note">{message('desktopManagement.worker.unavailable')}</p>}>
                  {(protocol) => <p class="desktop-management-note">{message('desktopManagement.worker.protocol', { protocol: protocol(), revision: current().engineCommit.slice(0, 12) })}</p>}
                </Show>
              </div>
              <div class="desktop-management-actions">
                <ProductButton type="button" variant="primary" disabled={busy() || workerFormOpen() || current().remoteWorkerProtocol === undefined} onClick={() => openWorkerForm()}>{message('desktopManagement.worker.add')}</ProductButton>
              </div>
              <div class="desktop-worker-list">
                <Show when={workers().length > 0} fallback={<p class="desktop-management-note">{message('desktopManagement.worker.empty')}</p>}>
                  <For each={workers()}>{(worker) =>
                    <article class="desktop-worker-card">
                      <div class="desktop-worker-card-heading">
                        <div><strong>{worker.name}</strong><code>{worker.endpoint}</code></div>
                        <div class="desktop-management-actions">
                          <ProductButton type="button" disabled={busy() || current().remoteWorkerProtocol === undefined} onClick={() => openWorkerForm(worker)}>{message('desktopManagement.worker.edit')}</ProductButton>
                          <ProductButton type="button" variant="danger" disabled={busy() || current().remoteWorkerProtocol === undefined} onClick={() => void removeWorker(worker.name)}>
                            {message(removingWorker() === worker.name ? 'desktopManagement.worker.confirmRemove' : 'desktopManagement.worker.remove')}
                          </ProductButton>
                        </div>
                      </div>
                      <div class="desktop-worker-facts">
                        <span>{message(worker.tlsCaFile ? 'desktopManagement.worker.tlsPinned' : 'desktopManagement.worker.plainTransport')}</span>
                        <span>{worker.nodes === undefined
                          ? message('desktopManagement.worker.nodesAll')
                          : worker.nodes.length === 0
                            ? message('desktopManagement.worker.nodesNone')
                            : message('desktopManagement.worker.nodesCount', { count: worker.nodes.length })}</span>
                        <span>{worker.memory.length
                          ? message('desktopManagement.worker.memoryCount', { count: worker.memory.length })
                          : message('desktopManagement.worker.memoryNone')}</span>
                      </div>
                    </article>
                  }</For>
                </Show>
              </div>
              <Show when={workerFormOpen()}>
                <form class="desktop-worker-form" onSubmit={(event) => { event.preventDefault(); void saveWorker() }}>
                  <div class="desktop-worker-form-heading">
                    <h4>{editingWorker() ? message('desktopManagement.worker.editTitle', { worker: editingWorker()! }) : message('desktopManagement.worker.addTitle')}</h4>
                    <p>{message('desktopManagement.worker.formDescription')}</p>
                  </div>
                  <label>
                    <span>{message('desktopManagement.worker.profileName')}</span>
                    <ProductTextInput value={workerName()} disabled={editingWorker() !== undefined} onInput={(event) => setWorkerName(event.currentTarget.value)} placeholder={message('desktopManagement.worker.profilePlaceholder')} required />
                    <small>{message('desktopManagement.worker.profileHelp')}</small>
                  </label>
                  <label>
                    <span>{message('desktopManagement.worker.address')}</span>
                    <ProductTextInput value={workerEndpoint()} onInput={(event) => setWorkerEndpoint(event.currentTarget.value)} placeholder={message('desktopManagement.worker.addressPlaceholder')} required />
                    <small>{message('desktopManagement.worker.addressHelp')}</small>
                  </label>
                  <label class="desktop-worker-path-field">
                    <span>{message('desktopManagement.worker.tokenFile')}</span>
                    <div><ProductTextInput value={workerTokenFile()} readOnly placeholder={message('desktopManagement.worker.tokenPlaceholder')} required /><ProductButton type="button" disabled={busy()} onClick={() => void chooseWorkerFile('token')}>{message('desktopManagement.worker.choose')}</ProductButton></div>
                    <small>{message(workerTransportChanged() && workerTokenFileGrant() === undefined ? 'desktopManagement.worker.tokenAuthorize' : 'desktopManagement.worker.tokenHelp')}</small>
                  </label>
                  <label class="desktop-worker-path-field">
                    <span>{message('desktopManagement.worker.tlsFile')} <small>{message('desktopManagement.optional')}</small></span>
                    <div><ProductTextInput value={workerTlsCaFile()} readOnly placeholder={message('desktopManagement.worker.tlsPlaceholder')} /><ProductButton type="button" disabled={busy()} onClick={() => void chooseWorkerFile('tls-ca')}>{message('desktopManagement.worker.choose')}</ProductButton><Show when={workerTlsCaFile()}><ProductButton type="button" variant="ghost" disabled={busy()} onClick={() => { setWorkerTlsCaFile(''); setWorkerTlsCaFileGrant(undefined) }}>{message('desktopManagement.worker.clear')}</ProductButton></Show></div>
                    <small>{message(workerTransportChanged() && workerTlsCaFile() && workerTlsCaFileGrant() === undefined ? 'desktopManagement.worker.tlsAuthorize' : 'desktopManagement.worker.tlsHelp')}</small>
                  </label>
                  <div class="desktop-worker-form-field">
                    <span>{message('desktopManagement.worker.nodes')} <small>{message('desktopManagement.optional')}</small></span>
                    <ProductSelect
                      ariaLabel={message('desktopManagement.worker.nodePolicy')}
                      selectedId={workerNodesRestricted() ? 'allowlist' : 'all'}
                      options={[
                        { id: 'all', label: message('desktopManagement.worker.nodesAll'), value: false },
                        { id: 'allowlist', label: message('desktopManagement.worker.nodesListed'), value: true },
                      ]}
                      onSelect={(option) => setWorkerNodesRestricted(option.value)}
                    />
                    <ProductTextArea
                      aria-label={message('desktopManagement.worker.nodes')}
                      disabled={!workerNodesRestricted()}
                      value={workerNodes()}
                      onInput={(event) => setWorkerNodes(event.currentTarget.value)}
                      placeholder={message('desktopManagement.worker.nodesPlaceholder')}
                      rows="2"
                    />
                    <small>{workerNodesRestricted()
                      ? message('desktopManagement.worker.nodesRestrictedHelp')
                      : message('desktopManagement.worker.nodesAllHelp')}</small>
                  </div>
                  <label>
                    <span>{message('desktopManagement.worker.memory')} <small>{message('desktopManagement.optional')}</small></span>
                    <ProductTextArea value={workerMemory()} onInput={(event) => setWorkerMemory(event.currentTarget.value)} placeholder={message('desktopManagement.worker.memoryPlaceholder')} rows="2" />
                    <small>{message('desktopManagement.worker.memoryHelp')}</small>
                  </label>
                  <div class="desktop-worker-form-actions">
                    <ProductButton type="button" variant="ghost" disabled={busy()} onClick={closeWorkerForm}>{message('desktopManagement.worker.cancel')}</ProductButton>
                    <ProductButton type="submit" variant="primary" disabled={busy() || current().remoteWorkerProtocol === undefined || !workerTransportAuthorized() || workerName().length === 0 || !workerEndpoint().trim() || !workerTokenFile()}>{message('desktopManagement.worker.save')}</ProductButton>
                  </div>
                </form>
              </Show>
            </section>

            <section class="desktop-management-section desktop-management-wide">
              <div>
                <h3>{message('desktopManagement.system.title')}</h3>
                <Show when={check()} fallback={<p>{message('desktopManagement.system.checking')}</p>}>
                  {(result) => <div class="desktop-system-check">
                    <span><strong>{message('desktopManagement.system.engine')}</strong>{result().engineDetail}</span>
                    <span><strong>{message('desktopManagement.system.gpu')}</strong>{systemGpuLabel(result())}</span>
                    <span><strong>{message('desktopManagement.system.disk')}</strong>{message('desktopManagement.system.diskSpace', { free: formatBytes(result().freeBytes), total: formatBytes(result().totalBytes) })}</span>
                    <span><strong>{message('desktopManagement.system.platform')}</strong>{result().platform} / {result().architecture}</span>
                  </div>}
                </Show>
              </div>
              <div class="desktop-management-actions">
                <ProductButton type="button" disabled={busy()} onClick={() => void perform(async () => setCheck(await bridge!.systemCheck()))}>{message('desktopManagement.system.run')}</ProductButton>
                <ProductButton type="button" variant="danger" disabled={busy()} onClick={() => void perform(() => bridge!.clearCache(), 'desktopManagement.system.cacheCleared')}>{message('desktopManagement.system.clearCache')}</ProductButton>
              </div>
            </section>

            <section class="desktop-management-section">
              <div>
                <h3>{message('desktopManagement.updates.title')}</h3>
                <p>{current().update.detail}</p>
              </div>
              <div class="desktop-management-actions">
                <ProductButton type="button" disabled={busy() || current().update.state === 'checking'} onClick={() => void perform(() => bridge!.checkForUpdates())}>{message('desktopManagement.updates.check')}</ProductButton>
                <Show when={current().update.state === 'ready'}>
                  <ProductButton type="button" variant="primary" disabled={busy()} onClick={() => void perform(() => bridge!.installUpdate())}>{message('desktopManagement.updates.install')}</ProductButton>
                </Show>
              </div>
            </section>

            <section class="desktop-management-section">
              <div>
                <h3>{message('desktopManagement.support.title')}</h3>
                <p>{message('desktopManagement.support.description')}</p>
              </div>
              <ProductButton type="button" disabled={busy()} onClick={() => void perform(async () => {
                const path = await bridge!.exportSupportReport()
                if (path) setStatusMessage({ key: 'desktopManagement.support.saved', params: { path } })
              })}>{message('desktopManagement.support.export')}</ProductButton>
            </section>
          </>}
        </Show>
      </Show>
      <Show when={statusMessage()}><p class="desktop-management-message" role="status">{statusMessageText()}</p></Show>
    </section>
  )
}
