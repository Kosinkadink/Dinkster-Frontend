import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import type { MemoryStatus } from '@dinkster/client'
import { ProductRunActivity, ProductRunIcon } from '@dinkster/ui'
import Workflow from 'lucide-solid/icons/workflow'
import Snowflake from 'lucide-solid/icons/snowflake'
import Download from 'lucide-solid/icons/download'
import { backendConnectionStatus, type AppState, type Backend, type Tab } from './app-state.js'
import { executionProgress, executionStatusLabel } from './ExecutionActivityCard.js'
import { APP_EDITOR_KIND, GRAPH_EDITOR_KIND } from './editors.js'
import { executionActivity } from './execution-activity.js'
import { FrameRateStatus } from './FrameRateStatus.js'
import { MemoryStatusController } from './memory-status.js'
import { Icon } from './Icon.js'
import { ProductButton } from './ProductControls.js'
import { useAppMessage } from './locale.js'
import type { PanelIndicator } from './panels.js'
import { useSignal } from './solid-adapter.js'

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'Not reported'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const sign = bytes < 0 ? '-' : ''
  let value = Math.abs(bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${sign}${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

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
    const progress = connection() === 'connected' ? supervisor()?.progress ?? composition() : undefined
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
  const stale = () => sample() !== undefined && connection() === 'connected' && now() - received() > 6000
  const label = () => `${message('shell.panel.memory.title')}: ${cards().map((card) => `${card.name}: ${formatBytes(card.used)} / ${formatBytes(card.total)}`).join('; ')}${stale() ? ` (${message('shell.status.memoryStale')})` : ''}`
  return <Show when={props.connected() && connection() === 'connected' && cards()[0]}>{(card) =>
    <ProductButton variant="ghost" size="compact" class="status-item status-memory" data-testid="status-memory"
      data-stale={stale() ? '' : undefined} aria-label={label()} data-tooltip-label={label()} onClick={props.open}>
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
  readonly openRuns: () => void
  readonly openAppLog: () => void
}) {
  const message = useAppMessage()
  const executions = useSignal(props.app.store.executions)
  const backends = useSignal(props.app.backends)
  const backendTick = useSignal(props.app.backendsTick)
  const settings = useSignal(props.app.settings.changed)
  const [tasks, setTasks] = createSignal<ReadonlyMap<string, readonly BackgroundTask[]>>(new Map())
  const allTasks = createMemo(() => [...tasks().values()].flat())
  const workflowTab = () => {
    const tab = props.tab()
    return tab !== undefined && (tab.editorKind === GRAPH_EDITOR_KIND || tab.editorKind === APP_EDITOR_KIND)
  }
  const run = createMemo(() => {
    executions()
    const tab = props.tab()
    const own = tab === undefined ? [] : props.app.executionsForTab(tab)
    const running = own.filter((execution) => execution.status === 'running')
    return { ...executionActivity(own), leading: running.length === 1 ? running[0] : undefined,
      frozen: tab?.execution === undefined ? undefined : own[0] }
  })
  const busy = () => run().running > 0 || run().waiting > 0
  const activityLabel = () => message('runs.activity', { running: run().running, waiting: run().waiting })
  const runWords = () => {
    const frozen = run().frozen
    if (frozen !== undefined && !busy()) {
      return frozen.status === 'completed' && frozen.startedAt !== undefined && frozen.endedAt !== undefined
        ? message('shell.status.completedIn', { seconds: Math.round((frozen.endedAt - frozen.startedAt) / 1000) })
        : executionStatusLabel(frozen.status)
    }
    const progress = run().leading === undefined ? undefined : executionProgress(run().leading!)
    return progress === undefined ? '' : `${Math.round(progress.value * 100)}%`
  }
  const runTitle = () => props.tab()?.execution !== undefined ? message('shell.status.frozen')
    : busy() ? props.tab()!.title : message('shell.status.idle')
  const runLabel = () => `${props.tab()?.title}: ${busy() ? activityLabel() : message('shell.status.noActivity')}${props.tab()?.execution === undefined ? '' : ` - ${message('shell.status.frozen')}`}${runWords() === '' ? '' : ` - ${runWords()}`}`
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
        <Show when={workflowTab()}>
          <ProductButton variant="ghost" size="compact" class="status-item status-run" data-testid="status-run"
            aria-label={runLabel()} data-tooltip-label={runLabel()} onClick={props.openRuns}>
            <Show when={props.tab()?.execution !== undefined}><Icon icon={Snowflake} /><span>{message('shell.status.frozen')}</span></Show>
            <Show when={busy()} fallback={<Show when={props.tab()?.execution === undefined}><ProductRunIcon icon={Workflow} /></Show>}>
              <ProductRunActivity running={run().running} waiting={run().waiting} label={activityLabel()} />
            </Show>
            <Show when={props.tab()?.execution === undefined}><span classList={{ 'status-run-title': busy() }}>{runTitle()}</span></Show>
            <Show when={runWords()}>{(words) => <span>{words()}</span>}</Show>
          </ProductButton>
        </Show>
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
