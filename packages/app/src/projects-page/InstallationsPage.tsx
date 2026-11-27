import { createEffect, createSignal, createUniqueId, onCleanup, onMount, Show } from 'solid-js'
import {
  createPageLoad,
  ProductEmptyState,
  ProductPageAnswer,
  ProductPageLoad,
  ProductProjectFacts,
  ProductProjectHeader,
  ProductProjectListHeader,
  ProductProjectRows,
  ProductProjectsView,
} from '@dinkster/ui'
import { useAppMessage } from '../locale.js'
import { SetupForm, type SetupStatus } from '../SetupForm.js'
import type { EngineState, PageInstallation, ProjectsSource } from './ProjectsPage.js'
import { InstallationSandbox } from './InstallationSandbox.js'

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
              <ProductProjectFacts label={message('installations.facts')} columns={[
                [{ label: message('setup.folder'), value: installation().root }],
                [],
              ]} />
              <Show when={installation().root} keyed>{(root) => <InstallationSandbox root={root} engine={installation().engine} />}</Show>
            </div>}
          </Show>
        </Show>
      </ProductPageLoad>
    </ProductProjectsView>
  )
}
