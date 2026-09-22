import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { MountDescriptor, MountSettings } from '@dinkster/client'
import {
  DESKTOP_ENGINE_ACCELERATORS,
  desktopBridge,
  desktopEngineAcceleratorLabel,
  type DesktopInfo,
  type DesktopProjectEngineChannel,
  type DesktopProjectEngineInfo,
  type DesktopRemoteWorker,
  type DesktopRemoteWorkerMemory,
  type DesktopSystemCheck,
} from './desktop-bridge.js'
import { MountFolderForm } from './MountFolderForm.js'
import { useAppMessage } from './locale.js'

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

const DESKTOP_PROJECT_CHANNELS: readonly DesktopProjectEngineChannel[] = ['stable', 'github-live']
const DESKTOP_PROJECT_CELLS = [
  'win-cu128',
  'linux-cu128',
  'mac-arm64',
  'linux-cpu',
  'win-cpu',
  'linux-rocm',
  'windows-rocm',
  'linux-xpu',
  'windows-xpu',
] as const

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
  const [project, setProject] = createSignal<DesktopProjectEngineInfo>()
  const [projectChannel, setProjectChannel] = createSignal<DesktopProjectEngineChannel>('stable')
  const [projectCell, setProjectCell] = createSignal<string>('linux-cpu')
  const [projectRemoveOpen, setProjectRemoveOpen] = createSignal(false)
  const [projectDeleteData, setProjectDeleteData] = createSignal(false)
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
    void loadProject().catch((error: unknown) => setStatusMessage({ raw: error instanceof Error ? error.message : String(error) }))
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

  const loadProject = async (): Promise<void> => {
    const next = await bridge!.projectEngine()
    const first = project() === undefined
    setProject(next)
    if (first) {
      setProjectChannel(next.channel ?? 'stable')
      setProjectCell(next.cell ?? 'linux-cpu')
    }
  }

  // The journal reports generation identifiers as host strings; only a real
  // numeric previous generation can be activated again.
  const journalReturnGeneration = (previous: string): number | undefined => {
    if (!/^[1-9]\d*$/.test(previous)) return undefined
    const parsed = Number(previous)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }

  const installProjectEngine = async (): Promise<void> => {
    await perform(async () => {
      await bridge!.installProjectEngine(projectChannel(), projectCell())
      await loadProject()
    })
  }

  const activateGeneration = async (generation: number): Promise<void> => {
    await perform(async () => {
      await bridge!.activateProjectGeneration(generation)
      await loadProject()
    })
  }

  const removeProject = async (): Promise<void> => {
    const current = project()
    if (!current) return
    const deleteData = projectDeleteData()
    await perform(async () => {
      // Data deletion needs the exact reported path repeated; removal alone
      // never touches the data root.
      if (deleteData) await bridge!.removeProject(true, current.dataRoot)
      else await bridge!.removeProject(false)
      closeProjectRemove()
      await loadProject()
    }, 'desktopManagement.project.removed')
  }

  const closeProjectRemove = (): void => {
    setProjectRemoveOpen(false)
    setProjectDeleteData(false)
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
                  <button type="button" disabled={busy() || current().variant === accelerator} onClick={() => void perform(() => bridge!.selectEngine(current().engineCommit, accelerator))}>
                    {message('desktopManagement.environment.use', { accelerator: desktopEngineAcceleratorLabel(accelerator) })}
                  </button>
                )}</For>
              </div>
              <Show when={current().releases.some((release) => !release.active)}>
                <div class="desktop-release-list">
                  <h4>{message('desktopManagement.environment.releases')}</h4>
                  <For each={current().releases}>{(release) =>
                    <div>
                      <span><strong>{release.commit.slice(0, 12)}</strong> - {release.variant} - {formatBytes(release.bytes)}</span>
                      <button type="button" disabled={busy() || release.active} onClick={() => void perform(() => bridge!.selectEngine(release.commit, release.variant))}>{message(release.active ? 'desktopManagement.environment.active' : 'desktopManagement.environment.restore')}</button>
                    </div>
                  }</For>
                </div>
              </Show>
            </section>

            <section class="desktop-management-section desktop-management-wide">
              <div>
                <h3>{message('desktopManagement.project.title')}</h3>
                <p>{message('desktopManagement.project.description')}</p>
              </div>
              <Show when={project()} fallback={<p class="desktop-management-note">{message('desktopManagement.project.loading')}</p>}>
                {(currentProject) => <div class="desktop-project">
                  <div class="desktop-project-facts">
                    <div><span>{message('desktopManagement.project.projectId')}</span><code>{currentProject().projectId}</code></div>
                    <div><span>{message('desktopManagement.project.dataRoot')}</span><code>{currentProject().dataRoot}</code></div>
                    <Show when={currentProject().channel !== undefined}>
                      <div><span>{message('desktopManagement.project.channel')}</span><code>{currentProject().channel}</code></div>
                    </Show>
                    <Show when={currentProject().installRoot !== undefined}>
                      <div><span>{message('desktopManagement.project.installRoot')}</span><code>{currentProject().installRoot}</code></div>
                    </Show>
                    <Show when={currentProject().port !== undefined}>
                      <div><span>{message('desktopManagement.project.port')}</span><code>{currentProject().port}</code></div>
                    </Show>
                    <Show when={currentProject().cell !== undefined}>
                      <div><span>{message('desktopManagement.project.cell')}</span><code>{currentProject().cell}</code></div>
                    </Show>
                    <Show when={currentProject().availableEngineCommit !== undefined}>
                      <div><span>{message('desktopManagement.project.availableCommit')}</span><code>{currentProject().availableEngineCommit}</code></div>
                    </Show>
                    <div><span>{message('desktopManagement.project.mirror')}</span><strong>{message(currentProject().mirrorConfigured ? 'desktopManagement.project.mirrorReady' : 'desktopManagement.project.mirrorMissing')}</strong></div>
                  </div>
                  <Show when={currentProject().journal}>
                    {(journal) => {
                      const returnGeneration = journalReturnGeneration(journal().previousGeneration)
                      return <div class="desktop-project-journal" data-stage={journal().stage}>
                        <p>{message(journal().stage === 'building'
                          ? 'desktopManagement.project.journalBuilding'
                          : journal().stage === 'switching'
                            ? 'desktopManagement.project.journalSwitching'
                            : 'desktopManagement.project.journalFailed', { previous: journal().previousGeneration, target: journal().targetGeneration })}</p>
                        <Show when={journal().error !== undefined}><code>{journal().error}</code></Show>
                        {returnGeneration !== undefined
                          && <button type="button" disabled={busy()} onClick={() => void activateGeneration(returnGeneration)}>
                            {message('desktopManagement.project.returnToPrevious')}
                          </button>}
                      </div>
                    }}
                  </Show>
                  <div class="desktop-project-generations">
                    <h4>{message('desktopManagement.project.generations')}</h4>
                    <For each={currentProject().generations}>{(generation) =>
                      <div>
                        <span>
                          <strong>{message('desktopManagement.project.generationLabel', { generation: generation.generation })}</strong>
                          {' '}- {generation.baseId} - <code>{generation.engineCommit}</code> - {generation.cell} - {message(`desktopManagement.project.status.${generation.status}`)}
                        </span>
                        <Show when={!generation.current}>
                          <button type="button" disabled={busy()} onClick={() => void activateGeneration(generation.generation)}>
                            {message('desktopManagement.project.activate')}
                          </button>
                        </Show>
                      </div>
                    }</For>
                  </div>
                  <div class="desktop-project-install">
                    <label>
                      <span>{message('desktopManagement.project.channel')}</span>
                      <select
                        aria-label={message('desktopManagement.project.channel')}
                        value={projectChannel()}
                        onChange={(event) => setProjectChannel(event.currentTarget.value as DesktopProjectEngineChannel)}
                      >
                        <For each={DESKTOP_PROJECT_CHANNELS}>{(channel) => <option value={channel}>{channel}</option>}</For>
                      </select>
                    </label>
                    <label>
                      <span>{message('desktopManagement.project.cell')}</span>
                      <select aria-label={message('desktopManagement.project.cell')} value={projectCell()} onChange={(event) => setProjectCell(event.currentTarget.value)}>
                        <For each={DESKTOP_PROJECT_CELLS}>{(cell) => <option value={cell}>{cell}</option>}</For>
                      </select>
                      <small>{message('desktopManagement.project.cellHelp')}</small>
                    </label>
                    <div class="desktop-management-actions">
                      <button type="button" disabled={busy() || !currentProject().mirrorConfigured} onClick={() => void installProjectEngine()}>
                        {message('desktopManagement.project.install')}
                      </button>
                    </div>
                    <Show when={!currentProject().mirrorConfigured}>
                      <p class="desktop-management-note">{message('desktopManagement.project.mirrorRequired')}</p>
                    </Show>
                  </div>
                  <p class="desktop-management-note">{message('desktopManagement.project.dataSafety')}</p>
                  <Show when={projectRemoveOpen()} fallback={
                    <div class="desktop-management-actions">
                      <button type="button" disabled={busy()} onClick={() => setProjectRemoveOpen(true)}>{message('desktopManagement.project.remove')}</button>
                    </div>
                  }>
                    <div class="desktop-project-remove-panel">
                      <p>{message('desktopManagement.project.removeWarning', { dataRoot: currentProject().dataRoot })}</p>
                      <label class="desktop-project-delete-data">
                        <input
                          type="checkbox"
                          checked={projectDeleteData()}
                          aria-label={message('desktopManagement.project.deleteData', { dataRoot: currentProject().dataRoot })}
                          onChange={(event) => setProjectDeleteData(event.currentTarget.checked)}
                        />
                        <span>{message('desktopManagement.project.deleteData', { dataRoot: currentProject().dataRoot })}</span>
                      </label>
                      <div class="desktop-management-actions">
                        <button type="button" disabled={busy()} onClick={closeProjectRemove}>{message('desktopManagement.project.removeCancel')}</button>
                        <button type="button" disabled={busy()} onClick={() => void removeProject()}>
                          {message(projectDeleteData() ? 'desktopManagement.project.removeConfirmDelete' : 'desktopManagement.project.removeConfirm')}
                        </button>
                      </div>
                    </div>
                  </Show>
                </div>}
              </Show>
            </section>

            <section class="desktop-management-section desktop-management-wide">
              <div>
                <h3>{message('desktopManagement.snapshots.title')}</h3>
                <p>{message('desktopManagement.snapshots.description')}</p>
              </div>
              <div class="desktop-management-actions">
                <button type="button" disabled={busy()} onClick={() => void perform(async () => {
                  const path = await bridge!.exportSnapshot()
                  if (path) setStatusMessage({ key: 'desktopManagement.snapshots.saved', params: { path } })
                })}>{message('desktopManagement.snapshots.export')}</button>
                <button type="button" disabled={busy()} onClick={() => void perform(async () => {
                  const restored = await bridge!.importSnapshot()
                  if (restored) setStatusMessage({ key: 'desktopManagement.snapshots.restored' })
                })}>{message('desktopManagement.snapshots.restore')}</button>
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
                <button type="button" disabled={busy() || workerFormOpen() || current().remoteWorkerProtocol === undefined} onClick={() => openWorkerForm()}>{message('desktopManagement.worker.add')}</button>
              </div>
              <div class="desktop-worker-list">
                <Show when={workers().length > 0} fallback={<p class="desktop-management-note">{message('desktopManagement.worker.empty')}</p>}>
                  <For each={workers()}>{(worker) =>
                    <article class="desktop-worker-card">
                      <div class="desktop-worker-card-heading">
                        <div><strong>{worker.name}</strong><code>{worker.endpoint}</code></div>
                        <div class="desktop-management-actions">
                          <button type="button" disabled={busy() || current().remoteWorkerProtocol === undefined} onClick={() => openWorkerForm(worker)}>{message('desktopManagement.worker.edit')}</button>
                          <button type="button" disabled={busy() || current().remoteWorkerProtocol === undefined} onClick={() => void removeWorker(worker.name)}>
                            {message(removingWorker() === worker.name ? 'desktopManagement.worker.confirmRemove' : 'desktopManagement.worker.remove')}
                          </button>
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
                    <input value={workerName()} disabled={editingWorker() !== undefined} onInput={(event) => setWorkerName(event.currentTarget.value)} placeholder={message('desktopManagement.worker.profilePlaceholder')} required />
                    <small>{message('desktopManagement.worker.profileHelp')}</small>
                  </label>
                  <label>
                    <span>{message('desktopManagement.worker.address')}</span>
                    <input value={workerEndpoint()} onInput={(event) => setWorkerEndpoint(event.currentTarget.value)} placeholder={message('desktopManagement.worker.addressPlaceholder')} required />
                    <small>{message('desktopManagement.worker.addressHelp')}</small>
                  </label>
                  <label class="desktop-worker-path-field">
                    <span>{message('desktopManagement.worker.tokenFile')}</span>
                    <div><input value={workerTokenFile()} readOnly placeholder={message('desktopManagement.worker.tokenPlaceholder')} required /><button type="button" disabled={busy()} onClick={() => void chooseWorkerFile('token')}>{message('desktopManagement.worker.choose')}</button></div>
                    <small>{message(workerTransportChanged() && workerTokenFileGrant() === undefined ? 'desktopManagement.worker.tokenAuthorize' : 'desktopManagement.worker.tokenHelp')}</small>
                  </label>
                  <label class="desktop-worker-path-field">
                    <span>{message('desktopManagement.worker.tlsFile')} <small>{message('desktopManagement.optional')}</small></span>
                    <div><input value={workerTlsCaFile()} readOnly placeholder={message('desktopManagement.worker.tlsPlaceholder')} /><button type="button" disabled={busy()} onClick={() => void chooseWorkerFile('tls-ca')}>{message('desktopManagement.worker.choose')}</button><Show when={workerTlsCaFile()}><button type="button" disabled={busy()} onClick={() => { setWorkerTlsCaFile(''); setWorkerTlsCaFileGrant(undefined) }}>{message('desktopManagement.worker.clear')}</button></Show></div>
                    <small>{message(workerTransportChanged() && workerTlsCaFile() && workerTlsCaFileGrant() === undefined ? 'desktopManagement.worker.tlsAuthorize' : 'desktopManagement.worker.tlsHelp')}</small>
                  </label>
                  <div class="desktop-worker-form-field">
                    <span>{message('desktopManagement.worker.nodes')} <small>{message('desktopManagement.optional')}</small></span>
                    <select
                      aria-label={message('desktopManagement.worker.nodePolicy')}
                      value={workerNodesRestricted() ? 'allowlist' : 'all'}
                      onChange={(event) => setWorkerNodesRestricted(event.currentTarget.value === 'allowlist')}
                    >
                      <option value="all">{message('desktopManagement.worker.nodesAll')}</option>
                      <option value="allowlist">{message('desktopManagement.worker.nodesListed')}</option>
                    </select>
                    <textarea
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
                    <textarea value={workerMemory()} onInput={(event) => setWorkerMemory(event.currentTarget.value)} placeholder={message('desktopManagement.worker.memoryPlaceholder')} rows="2" />
                    <small>{message('desktopManagement.worker.memoryHelp')}</small>
                  </label>
                  <div class="desktop-worker-form-actions">
                    <button type="button" disabled={busy()} onClick={closeWorkerForm}>{message('desktopManagement.worker.cancel')}</button>
                    <button type="submit" disabled={busy() || current().remoteWorkerProtocol === undefined || !workerTransportAuthorized() || workerName().length === 0 || !workerEndpoint().trim() || !workerTokenFile()}>{message('desktopManagement.worker.save')}</button>
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
                <button type="button" disabled={busy()} onClick={() => void perform(async () => setCheck(await bridge!.systemCheck()))}>{message('desktopManagement.system.run')}</button>
                <button type="button" disabled={busy()} onClick={() => void perform(() => bridge!.clearCache(), 'desktopManagement.system.cacheCleared')}>{message('desktopManagement.system.clearCache')}</button>
              </div>
            </section>

            <section class="desktop-management-section">
              <div>
                <h3>{message('desktopManagement.updates.title')}</h3>
                <p>{current().update.detail}</p>
              </div>
              <div class="desktop-management-actions">
                <button type="button" disabled={busy() || current().update.state === 'checking'} onClick={() => void perform(() => bridge!.checkForUpdates())}>{message('desktopManagement.updates.check')}</button>
                <Show when={current().update.state === 'ready'}>
                  <button type="button" disabled={busy()} onClick={() => void perform(() => bridge!.installUpdate())}>{message('desktopManagement.updates.install')}</button>
                </Show>
              </div>
            </section>

            <section class="desktop-management-section">
              <div>
                <h3>{message('desktopManagement.support.title')}</h3>
                <p>{message('desktopManagement.support.description')}</p>
              </div>
              <button type="button" disabled={busy()} onClick={() => void perform(async () => {
                const path = await bridge!.exportSupportReport()
                if (path) setStatusMessage({ key: 'desktopManagement.support.saved', params: { path } })
              })}>{message('desktopManagement.support.export')}</button>
            </section>
          </>}
        </Show>
      </Show>
      <Show when={statusMessage()}><p class="desktop-management-message" role="status">{statusMessageText()}</p></Show>
    </section>
  )
}
