import { createEffect, createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js'
import {
  createPageLoad,
  ProductEmptyState,
  ProductErrorBanner,
  ProductList,
  ProductListRow,
  ProductNotice,
  ProductPageAnswer,
  ProductPageLoad,
  ProductPath,
  ProductProjectFacts,
  ProductProjectHeader,
  ProductProjectListHeader,
  ProductProjectRows,
  ProductProjectSection,
  ProductProjectsView,
  ProductTextButton,
  ProductToast,
} from '@dinkster/ui'
import { activeLocale, formatByteSize } from '@dinkster/core'
import { requestFailure, requestFetch } from '@dinkster/client'
import { useAppMessage } from '../locale.js'
import { useSignal } from '../solid-adapter.js'
import { SetupForm, type SetupStatus } from '../SetupForm.js'
import { failureMessage } from '../request-failure.js'
import type { EngineState, PageInstallation, ProjectsSource } from './ProjectsPage.js'
import { InstallationSandbox } from './InstallationSandbox.js'
import { createInstallationJobs, InstallationRestore } from './InstallationRestore.js'
import { setupJobActive } from '../setup-job.js'

const fetchRequest = requestFetch((url, init) => fetch(url, init))

interface InstallationFacts {
  readonly host: { readonly kind: 'local' | 'wsl'; readonly distribution?: string }
  readonly build: { readonly version: string; readonly variant: string; readonly label: string } | null
}

interface InstallationSpace {
  readonly space: { readonly allocatedBytes: number | null; readonly store: string | null }
}

interface InstallationHistory {
  readonly current: number | null
  readonly history: readonly {
    readonly id: number
    readonly kind?: 'activation' | 'import'
    readonly generation: number
    readonly reason: string
    readonly timestamp: string
    readonly snapshot: { readonly engine: { readonly version: string } }
  }[]
}

function SelectedInstallationHistory(props: { readonly root: string; readonly revision?: number | undefined; readonly onRestore: (entry: number) => void; readonly disabled: boolean }) {
  const message = useAppMessage()
  const locale = useSignal(activeLocale)
  const page = createPageLoad<InstallationHistory>()
  const read = async () => {
    try {
      const response = await fetchRequest(`/supervisor/installations/history?${new URLSearchParams({ root: props.root })}`, { cache: 'no-store' })
      if (!response.ok) throw await requestFailure(response)
      return await response.json() as InstallationHistory
    } catch (failure) {
      throw new Error(failureMessage(failure))
    }
  }
  const refresh = () => { void page.load(read) }
  createEffect(() => { void props.revision; refresh() })
  onMount(() => {
    globalThis.addEventListener('focus', refresh)
    onCleanup(() => globalThis.removeEventListener('focus', refresh))
  })
  const title = (entry: InstallationHistory['history'][number]) => {
    const reason = entry.kind === 'import' ? 'import' : entry.reason
    const key = `installations.history.event.${reason}`
    const label = message(key, { version: entry.snapshot.engine.version })
    return label === key ? message('installations.history.recorded', { version: entry.snapshot.engine.version }) : label
  }

  return <ProductProjectSection title={message('installations.history.title')}>
    <ProductPageLoad page={page} read={read} loadingLabel={message('installations.history.loading')}>
      {(record) => <Show when={record.history.length} fallback={<Show when={!page.error()}><ProductEmptyState message={message('installations.history.empty')} /></Show>}>
        <ProductList label={message('installations.history.title')}>
          <For each={[...record.history].reverse()}>{(entry) => <ProductListRow title={title(entry)}
            description={<time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleString(locale().tag, { dateStyle: 'medium', timeStyle: 'short' })}</time>}
            trailing={entry.kind !== 'import' && entry.generation === record.current ? message('installations.history.current') : undefined}
            action={entry.kind !== 'import' && entry.generation === record.current ? undefined : <ProductTextButton
              label={message('installations.restore.title')} disabled={props.disabled || page.pending() || Boolean(page.error())}
              onClick={() => props.onRestore(entry.id)} />} />}</For>
        </ProductList>
      </Show>}
    </ProductPageLoad>
  </ProductProjectSection>
}

function SelectedInstallationFacts(props: { readonly root: string; readonly revision?: number | undefined }) {
  const message = useAppMessage()
  const page = createPageLoad<InstallationFacts>()
  const space = createPageLoad<InstallationSpace>()
  const [dismissedSpace, setDismissedSpace] = createSignal<Error>()
  const read = async () => {
    try {
      const response = await fetchRequest(`/supervisor/installations/facts?${new URLSearchParams({ root: props.root })}`, { cache: 'no-store' })
      if (!response.ok) throw await requestFailure(response)
      return await response.json() as InstallationFacts
    } catch (failure) {
      throw new Error(failureMessage(failure))
    }
  }
  const readSpace = async () => {
    try {
      const response = await fetchRequest(`/supervisor/installations/space?${new URLSearchParams({ root: props.root })}`, { cache: 'no-store' })
      if (!response.ok) throw await requestFailure(response)
      return await response.json() as InstallationSpace
    } catch (failure) {
      throw new Error(failureMessage(failure))
    }
  }
  const refresh = () => { void page.load(read); void space.load(readSpace) }
  createEffect(() => { void props.revision; refresh() })
  onMount(() => {
    globalThis.addEventListener('focus', refresh)
    onCleanup(() => globalThis.removeEventListener('focus', refresh))
  })

  return <>
    <Show when={space.error() !== dismissedSpace() && space.error()}>{(error) =>
      <ProductErrorBanner onDismiss={() => setDismissedSpace(error())}>{error().message}</ProductErrorBanner>}</Show>
    <ProductPageLoad page={page} read={read} loadingLabel={message('installations.factsLoading')}>
    {(facts) => <ProductProjectFacts label={message('installations.facts')} columns={[
      [
        { label: message('setup.folder'), value: <ProductPath value={props.root} /> },
        { label: message('installations.host'), value: facts.host.kind === 'wsl' ? 'WSL2' : message('resources.thisComputer'), detail: facts.host.distribution },
        { label: message('setup.build'), value: facts.build?.label ?? message('installations.noSelectedBuild') },
      ],
      [
        { label: message('installations.version'), value: facts.build?.version ?? message('installations.noSelectedBuild') },
        { label: message('installations.size'), value: <Show when={!space.pending()} fallback={message('installations.sizeLoading')}>
          <Show when={!space.error() && space.value()?.space.allocatedBytes !== null && space.value()} fallback={message('installations.sizeUnknown')}>
            {(result) => formatByteSize(result().space.allocatedBytes!)}
          </Show>
        </Show>, action: <Show when={space.error()}><ProductTextButton label={message('common.tryAgain')} disabled={space.pending()} onClick={() => { void space.load(readSpace) }} /></Show> },
      ],
    ]} />}
  </ProductPageLoad>
    <Show when={page.value() && space.value() && !space.error() && !space.pending()}>
      <ProductNotice>{message(space.value()!.space.store === null ? 'installations.sizeScope' : 'installations.sizeSharedScope')}</ProductNotice>
    </Show>
  </>
}

export function InstallationsView(props: {
  readonly source: Pick<ProjectsSource, 'installations'>
  readonly onEngine?: (engine: { state?: EngineState; open?: PageInstallation; notSetUp: boolean }) => void
  readonly onSetupStatusChange?: (status: SetupStatus | undefined) => void
}) {
  const message = useAppMessage()
  const heading = createUniqueId()
  const page = createPageLoad<Awaited<ReturnType<ProjectsSource['installations']>>>()
  const read = () => props.source.installations()
  const refresh = () => page.load(read)
  const [chosen, setChosen] = createSignal<string>()
  const [settingUp, setSettingUp] = createSignal(false)
  const [narrowDetail, setNarrowDetail] = createSignal(false)
  const [restoring, setRestoring] = createSignal<{ root: string; entry: number }>()
  const [dismissedJob, setDismissedJob] = createSignal<string>()
  const [dismissedRead, setDismissedRead] = createSignal<Error>()
  const [notification, setNotification] = createSignal<{ message: string }>()
  const [revisions, setRevisions] = createSignal<ReadonlyMap<string, number>>(new Map())
  const jobs = createInstallationJobs((job) => {
    setRevisions((previous) => new Map(previous).set(job.root, (previous.get(job.root) ?? 0) + 1))
    if (job.state === 'completed') setNotification({ message: `${job.root}: ${message('installations.restore.state.completed')}` })
    void refresh()
  })
  const restoreJob = () => jobs.page.value()?.operation === 'restore' ? jobs.page.value() : undefined
  const jobFor = (root: string) => restoreJob()?.root === root ? restoreJob() : undefined
  const rowDetail = (row: PageInstallation) => {
    const job = jobFor(row.root)
    if (!job) return stateLabel(row)
    const value = job.progress
    const status = message(`installations.restore.state.${job.state}`)
    return setupJobActive(job) && value?.total && value.total > 0
      ? `${status} - ${Math.round(Math.min(1, Math.max(0, value.completed / value.total)) * 100)}%` : status
  }
  const selected = () => page.value()?.all.find((row) => row.root === chosen()) ?? page.value()?.all[0]
  const showSetup = () => settingUp() || page.value()?.settingUp || page.value()?.all.length === 0
  const state = (installation: PageInstallation) => {
    const found = page.value()
    if (!found?.engine) return 'unknown'
    return found.open?.root === installation.root && found.open.engine === installation.engine ? found.engine : 'stopped'
  }
  const stateLabel = (installation: PageInstallation) => message(`installations.state.${state(installation)}`)
  void refresh()
  createEffect(() => {
    const found = page.value()
    if (found) props.onEngine?.({
      ...(found.engine ? { state: found.engine } : {}),
      ...(found.open ? { open: found.open } : {}),
      notSetUp: found.all.length === 0,
    })
  })
  onMount(() => {
    const reread = () => { void refresh() }
    globalThis.addEventListener('focus', reread)
    onCleanup(() => globalThis.removeEventListener('focus', reread))
  })

  return (
    <ProductProjectsView
      narrowPanel={page.error() && !page.value() || showSetup() || narrowDetail() ? 'detail' : 'list'}
      back={{ label: message('projects.place.installations'), onSelect: () => { setSettingUp(false); setNarrowDetail(false) } }}
      list={<>
        <ProductProjectListHeader id={heading} title={message('projects.place.installations')}
          newLabel={message('setup.start')} onNew={() => { setSettingUp(true); setNarrowDetail(true) }} />
        <ProductPageAnswer page={page}>
          <ProductProjectRows labelledBy={heading} loadingLabel={message('installations.loading')}
            projects={page.value()?.all.map((row) => {
              const job = jobFor(row.root)
              const value = job?.progress
              return { id: row.root, name: row.name, detail: rowDetail(row),
                state: job?.state === 'failed' ? 'failed' as const : setupJobActive(job) ? 'opening' as const : undefined,
                progress: setupJobActive(job) ? { label: rowDetail(row), value: value?.total && value.total > 0 ? Math.min(1, Math.max(0, value.completed / value.total)) : undefined } : undefined }
            })}
            action={(row) => <Show when={jobFor(row.id) && setupJobActive(jobFor(row.id))}>
              <ProductTextButton label={message('setup.cancel')} disabled={jobs.changing() || jobFor(row.id)?.state === 'cancelling'}
                onClick={() => { void jobs.cancel() }} />
            </Show>}
            selected={showSetup() ? undefined : selected()?.root}
            onSelect={(root) => { setChosen(root); setSettingUp(false); setNarrowDetail(true) }} />
        </ProductPageAnswer>
      </>}
    >
      <ProductPageLoad page={page} read={read} loadingLabel={message('installations.loading')} arrival="fade">
        <Show when={jobs.page.error() !== dismissedRead() && jobs.page.error()}>{(error) =>
          <ProductErrorBanner onDismiss={() => setDismissedRead(error())}>{error().message}</ProductErrorBanner>}</Show>
        <Show when={jobs.page.error()}><ProductTextButton label={message('setup.retry')} onClick={() => { void jobs.refresh() }} /></Show>
        <Show when={!restoring() && jobs.error()}>{(error) => <ProductErrorBanner onDismiss={jobs.dismissError}>{error()}</ProductErrorBanner>}</Show>
        <Show when={restoreJob()?.id !== dismissedJob() && restoreJob()?.error}>{(error) =>
          <ProductErrorBanner onDismiss={() => setDismissedJob(restoreJob()?.id)}>{error().message}</ProductErrorBanner>}</Show>
        <Show when={!showSetup()} fallback={
          <SetupForm surface="projects" onStatusChange={props.onSetupStatusChange} onInstallation={(installation) => {
            setChosen(installation.root)
            setSettingUp(false)
            void refresh()
          }} />
        }>
          <Show when={selected()} fallback={<ProductEmptyState message={message('projects.open.noInstallation')} />}>
            {(installation) => <div class="projects-page-detail">
              <ProductProjectHeader title={installation().name} subtitle={stateLabel(installation())} />
              <Show when={installation().root} keyed>{(root) => <>
                <SelectedInstallationFacts root={root} revision={revisions().get(root)} />
                <InstallationSandbox root={root} engine={installation().engine} />
                <SelectedInstallationHistory root={root} revision={revisions().get(root)} disabled={jobs.blocked()}
                  onRestore={(entry) => setRestoring({ root, entry })} />
              </>}</Show>
            </div>}
          </Show>
        </Show>
      </ProductPageLoad>
      <Show when={restoring()} keyed>{(target) => <InstallationRestore root={target.root} entry={target.entry} jobs={jobs}
        onDismiss={() => setRestoring(undefined)} />}</Show>
      <ProductToast notification={notification()} onDismiss={() => setNotification(undefined)} />
    </ProductProjectsView>
  )
}
