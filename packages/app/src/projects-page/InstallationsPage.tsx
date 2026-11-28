import { createEffect, createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js'
import {
  createPageLoad,
  ProductEmptyState,
  ProductList,
  ProductListRow,
  ProductPageAnswer,
  ProductPageLoad,
  ProductProjectFacts,
  ProductProjectHeader,
  ProductProjectListHeader,
  ProductProjectRows,
  ProductProjectSection,
  ProductProjectsView,
} from '@dinkster/ui'
import { activeLocale } from '@dinkster/core'
import { requestFailure, requestFetch } from '@dinkster/client'
import { useAppMessage } from '../locale.js'
import { useSignal } from '../solid-adapter.js'
import { SetupForm, type SetupStatus } from '../SetupForm.js'
import { failureMessage } from '../request-failure.js'
import type { EngineState, PageInstallation, ProjectsSource } from './ProjectsPage.js'
import { InstallationSandbox } from './InstallationSandbox.js'

const fetchRequest = requestFetch((url, init) => fetch(url, init))

interface InstallationFacts {
  readonly build: { readonly version: string; readonly variant: string } | null
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

function SelectedInstallationHistory(props: { readonly root: string }) {
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
  refresh()
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
            trailing={entry.kind !== 'import' && entry.generation === record.current ? message('installations.history.current') : undefined} />}</For>
        </ProductList>
      </Show>}
    </ProductPageLoad>
  </ProductProjectSection>
}

function SelectedInstallationFacts(props: { readonly root: string }) {
  const message = useAppMessage()
  const page = createPageLoad<InstallationFacts>()
  const read = async () => {
    try {
      const response = await fetchRequest(`/supervisor/installations/facts?${new URLSearchParams({ root: props.root })}`, { cache: 'no-store' })
      if (!response.ok) throw await requestFailure(response)
      return await response.json() as InstallationFacts
    } catch (failure) {
      throw new Error(failureMessage(failure))
    }
  }
  const refresh = () => { void page.load(read) }
  refresh()
  onMount(() => {
    globalThis.addEventListener('focus', refresh)
    onCleanup(() => globalThis.removeEventListener('focus', refresh))
  })

  return <ProductPageLoad page={page} read={read} loadingLabel={message('installations.factsLoading')}>
    {(facts) => <ProductProjectFacts label={message('installations.facts')} columns={[
      [
        { label: message('setup.folder'), value: props.root },
        { label: message('setup.build'), value: facts.build?.variant ?? message('installations.noSelectedBuild') },
      ],
      [{ label: message('installations.version'), value: facts.build?.version ?? message('installations.noSelectedBuild') }],
    ]} />}
  </ProductPageLoad>
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
            projects={page.value()?.all.map((row) => ({ id: row.root, name: row.name, detail: stateLabel(row) }))}
            selected={showSetup() ? undefined : selected()?.root}
            onSelect={(root) => { setChosen(root); setSettingUp(false); setNarrowDetail(true) }} />
        </ProductPageAnswer>
      </>}
    >
      <ProductPageLoad page={page} read={read} loadingLabel={message('installations.loading')} arrival="fade">
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
                <SelectedInstallationFacts root={root} />
                <InstallationSandbox root={root} engine={installation().engine} />
                <SelectedInstallationHistory root={root} />
              </>}</Show>
            </div>}
          </Show>
        </Show>
      </ProductPageLoad>
    </ProductProjectsView>
  )
}
