import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import type { ExecutionState, MemoryStatus } from '@dinkster/client'
import { ProductRunIcon } from '@dinkster/ui'
import Workflow from 'lucide-solid/icons/workflow'
import Download from 'lucide-solid/icons/download'
import { backendConnectionStatus, type AppState, type Backend, type Tab } from './app-state.js'
import { executionProgress } from './ExecutionActivityCard.js'
import { FrameRateStatus } from './FrameRateStatus.js'
import { formatBytes, MemoryStatusController, telemetryPresentationState } from './MemoryPanel.js'
import { Icon } from './Icon.js'
import { ProductButton } from './ProductControls.js'
import { useAppMessage } from './locale.js'
import type { PanelIndicator } from './panels.js'
import { useSignal } from './solid-adapter.js'

interface BackgroundTask { readonly key: string; readonly backend: string; readonly text: string }

function BackendTasks(props: { readonly backend: Backend; readonly update: (tasks: readonly BackgroundTask[]) => void }) {
  const message = useAppMessage()
  const composition = useSignal(props.backend.composition)
  const supervisor = useSignal(props.backend.supervisor)
  const connection = useSignal(props.backend.connection.status)
  const [downloads, setDownloads] = createSignal<readonly BackgroundTask[]>([])
  const [scans, setScans] = createSignal<readonly BackgroundTask[]>([])
  createEffect(() => {
    if (connection() !== 'connected') { setDownloads([]); setScans([]); return }
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      await Promise.all([
        props.backend.connection.fetchModelDownloads().then(({ jobs }) => {
          if (live) setDownloads(jobs.filter((job) => !['completed', 'cancelled', 'failed'].includes(job.status)).map((job) => ({
            key: job.jobId, backend: props.backend.label,
            text: message('shell.status.download', { name: job.name, received: formatBytes(job.received), total: formatBytes(job.size) }),
          })))
        }).catch(() => { if (live) setDownloads([]) }),
        props.backend.connection.fetchMountSettings().then(({ mounts }) => {
          if (live) setScans(mounts.filter((mount) => mount.state === 'pending' || mount.state === 'scanning').map((mount) => ({
            key: mount.id, backend: props.backend.label,
            text: mount.scanProgress === undefined ? message('shell.status.scanning', { name: mount.id })
              : message('shell.status.scanProgress', { name: mount.id, done: mount.scanProgress.filesDone, total: mount.scanProgress.filesTotal }),
          })))
        }).catch(() => { if (live) setScans([]) }),
      ])
      if (live) timer = setTimeout(() => { void poll() }, 5000)
    }
    void poll()
    onCleanup(() => { live = false; clearTimeout(timer) })
  })
  createEffect(() => {
    const progress = supervisor()?.progress ?? composition()
    props.update([...downloads(), ...scans(), ...(progress === undefined ? [] : [{
      key: 'composition', backend: props.backend.label,
      text: message('shell.status.composingPacks', { done: progress.done, total: progress.total }),
    }])])
  })
  onCleanup(() => props.update([]))
  return null
}

function MemoryItem(props: { readonly backend: Backend; readonly connected: () => boolean; readonly open: () => void }) {
  const message = useAppMessage()
  const connection = useSignal(props.backend.connection.status)
  const [sample, setSample] = createSignal<MemoryStatus>()
  const [received, setReceived] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())
  onMount(() => {
    const controller = new MemoryStatusController(props.backend.connection, (status) => {
      setSample(status); setReceived(Date.now()); setNow(Date.now())
    }, () => {})
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => { controller.dispose(); clearInterval(timer) })
  })
  const cards = createMemo(() => Object.entries(sample()?.memoryGovernor ?? {}).flatMap(([device, governor]) => {
    const measurement = governor.measured
    if (/^cpu(?:$|:)/.test(device) || measurement === null || measurement.totalBytes <= 0) return []
    const used = measurement.totalBytes - (measurement.driverFreeBytes ?? measurement.freeBytes)
    return [{ device, name: measurement.gpuName ?? device, used, total: measurement.totalBytes, share: used / measurement.totalBytes }]
  }).sort((a, b) => b.share - a.share))
  const state = () => telemetryPresentationState(sample(), connection(), received(), now())
  const label = () => `${message('shell.panel.memory.title')}: ${cards().map((card) => `${card.name}: ${formatBytes(card.used)} / ${formatBytes(card.total)}`).join('; ')}${state() === 'stale' ? ` (${message('shell.status.memoryStale')})` : ''}`
  return <Show when={props.connected() && connection() === 'connected' && cards()[0]}>{(card) =>
    <ProductButton variant="ghost" size="compact" class="status-item status-memory" data-testid="status-memory"
      data-stale={state() === 'stale' ? '' : undefined} aria-label={label()} data-tooltip-label={label()} onClick={props.open}>
      <span aria-hidden="true">{formatBytes(card().used)} / {formatBytes(card().total)}</span>
      <svg class="status-memory-track" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect width={Math.max(0, Math.min(1, card().share)) * 100} height="4" /></svg>
    </ProductButton>
  }</Show>
}

export function StatusBar(props: {
  readonly app: AppState
  readonly backend: () => Backend
  readonly tab: () => Tab | undefined
  readonly problems: () => PanelIndicator | undefined
  readonly context: () => string | undefined
  readonly visible: () => boolean
  readonly placement: () => string | undefined
  readonly transient: () => string | undefined
  readonly extensions: JSX.Element
  readonly openPanel: (id: string) => void
  readonly openRuns: (all: boolean) => void
  readonly openAppLog: () => void
}) {
  const message = useAppMessage()
  const executions = useSignal(props.app.store.executions)
  const backends = useSignal(props.app.backends)
  const backendTick = useSignal(props.app.backendsTick)
  const settings = useSignal(props.app.settings.changed)
  const [tasks, setTasks] = createSignal<ReadonlyMap<string, readonly BackgroundTask[]>>(new Map())
  const allTasks = createMemo(() => [...tasks().values()].flat())
  const run = createMemo(() => {
    executions()
    const pending = props.app.executionList().filter((execution) => execution.ref.connection === props.backend().id)
    const running = pending.filter((execution) => execution.status === 'running').sort((a, b) => (a.startedAt ?? a.queuedAt) - (b.startedAt ?? b.queuedAt))
    const own = props.tab() === undefined ? [] : props.app.executionsForTab(props.tab()!)
    const leading = running.find((execution) => own.some((candidate) => candidate.key === execution.key)) ?? running[0]
    return { leading, own: leading !== undefined && own.some((candidate) => candidate.key === leading.key), running: running.length,
      queued: pending.filter((execution) => execution.status === 'queued').length }
  })
  const workflowTab = () => props.tab() !== undefined && (props.tab()!.editorKind === undefined || props.tab()!.editorKind === 'graph')
  const title = (execution: ExecutionState) => {
    const lineage = execution.artifact?.snapshot.lineage
    return (lineage === undefined ? undefined : props.app.liveTabFor(lineage)?.title) ?? message('shell.status.runningWorkflow')
  }
  const progress = () => run().leading === undefined ? undefined : executionProgress(run().leading!)
  const runWords = () => [
    run().leading === undefined ? (run().queued === 0 ? message('shell.status.idle') : '')
      : progress() === undefined ? message('shell.status.running') : `${Math.round(progress()!.value * 100)}%`,
    run().running > 1 ? message('shell.status.moreRunning', { count: run().running - 1 }) : '',
    run().queued > 0 ? message('shell.status.queued', { count: run().queued }) : '',
  ].filter(Boolean).join(' - ')
  const runTitle = () => run().leading !== undefined && (!run().own || !workflowTab()) ? title(run().leading!) : ''
  const connection = () => { backendTick(); return backendConnectionStatus(props.backend()) }
  const connectionLabel = () => `${props.backend().label}: ${connection()}`
  const backgroundLabel = () => allTasks().map((task) => `${task.backend}: ${task.text}`).join('; ')
  let footer!: HTMLElement
  let row!: HTMLDivElement
  onMount(() => {
    const fit = () => {
      footer.dataset['compact'] = '0'
      for (let level = 1; level <= 6 && row.scrollWidth > row.clientWidth; level++) footer.dataset['compact'] = String(level)
    }
    const resize = new ResizeObserver(fit)
    const mutation = new MutationObserver(fit)
    resize.observe(footer)
    mutation.observe(row, { subtree: true, childList: true, characterData: true })
    fit()
    onCleanup(() => { resize.disconnect(); mutation.disconnect() })
  })
  return <>
    <For each={backends()}>{(backend) => <BackendTasks backend={backend} update={(entries) => setTasks((current) => {
      const next = new Map(current); if (entries.length === 0) next.delete(backend.id); else next.set(backend.id, entries); return next
    })} />}</For>
    <footer ref={footer} class="statusbar statusbar-state" data-testid="status-bar" aria-label={message('shell.applicationStatus')}
      hidden={!props.visible() && props.placement() === undefined && props.transient() === undefined}>
      <div ref={row} class="status-items">
        <Show when={props.placement()}>{(value) => <span class="placement-status" data-testid="placement-status">{value()}</span>}</Show>
        <Show when={props.transient()}>{(value) => <span class="transient-status">{value()}</span>}</Show>
        <ProductButton variant="ghost" size="compact" class="status-item status-connection" data-testid="status-connection"
          data-state={connection()} aria-label={connectionLabel()} data-tooltip-label={connectionLabel()} onClick={() => props.openPanel('backends')}>
          <span class="status-connection-dot" aria-hidden="true" /><span class="status-connection-name">{props.backend().label}</span>
          <Show when={connection() !== 'connected'}><span>{connection()}</span></Show>
        </ProductButton>
        <ProductButton variant="ghost" size="compact" class="status-item status-run" data-testid="status-run"
          aria-label={[runTitle(), runWords()].filter(Boolean).join(' - ')} data-tooltip-label={[runTitle(), runWords()].filter(Boolean).join(' - ')}
          onClick={() => props.openRuns(!workflowTab() || (run().leading !== undefined && !run().own))}>
          <ProductRunIcon icon={Workflow} running={run().running > 0} queued={run().queued > 0} />
          <Show when={runTitle()}><span class="status-run-title">{runTitle()}</span></Show><span>{runWords()}</span>
        </ProductButton>
        <Show when={props.problems()}>{(problem) => <ProductButton variant="ghost" size="compact" class="status-item status-problems"
          data-testid="status-problems" data-severity={problem().severity} aria-label={problem().label} data-tooltip-label={problem().label}
          onClick={() => props.openPanel('problems')}>{message('shell.status.problemCount', { count: problem().count })}</ProductButton>}</Show>
        <Show when={allTasks().length > 0}><ProductButton variant="ghost" size="compact" class="status-item status-background" data-testid="status-background"
          aria-label={backgroundLabel()} data-tooltip-label={backgroundLabel()} onClick={props.openAppLog}>
          <Icon icon={Download} /><span class="status-background-description">{allTasks().length === 1 ? allTasks()[0]!.text : message('shell.status.tasks', { count: allTasks().length })}</span>
          <span class="status-background-count" aria-hidden="true">{allTasks().length}</span>
        </ProductButton></Show>
        <Show when={(backendTick(), props.backend().schemaState.get().status !== 'ready')}>
          <span class="status-catalog">{props.backend().schemaState.get().status === 'error' ? message('backendsPanel.schema.unavailable') : message('shell.status.loadingSchemas')}</span>
        </Show>
        <span class="status-extensions" data-testid="status-trailing">{props.extensions}</span>
        <span class="status-context">
          <Show when={props.context()}>{(context) => <span data-testid="status-workflow-context">{context()}</span>}</Show>
          <Show when={(settings(), props.visible() && props.app.settings.get<boolean>('diagnostics.frameRate'))}><FrameRateStatus /></Show>
        </span>
        <Show when={props.backend()} keyed>{(backend) => <MemoryItem backend={backend} connected={() => connection() === 'connected'} open={() => props.openPanel('memory')} />}</Show>
      </div>
    </footer>
  </>
}
