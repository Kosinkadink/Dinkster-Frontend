import { createSignal, For, Show } from 'solid-js'
import { activeLocale } from '@dinkster/core'
import { ProductBrandMark, ProductButton, ProductDialog, ProductErrorBanner, ProductField, ProductLoading, ProductSelect, ProductTextButton, ProductTextInput } from '@dinkster/ui'
import { createArrival } from './arrival.js'
import { desktopFileBridge } from './desktop-bridge.js'
import { useAppMessage } from './locale.js'
import { formatBytes } from './projects-page/project-facts.js'
import { createSetupController, setupJobActive, type SetupJob } from './setup-job.js'
import './styles/setup.css'

/** The projects page and empty editor use the same process-owned setup job. */
export function SetupForm(props: {
  readonly surface: 'projects' | 'editor'
  readonly onInstallation?: (installation: NonNullable<SetupJob['installation']>) => void
}) {
  const message = useAppMessage()
  const setup = createSetupController({
    onInstallation: (installation) => props.onInstallation?.(installation),
  })
  const arrival = createArrival({ get latest() { return setup.plan() }, get loading() { return setup.planning() } })
  const [folder, setFolder] = createSignal<string>()
  const [choosingBuild, setChoosingBuild] = createSignal(false)
  const [folderBusy, setFolderBusy] = createSignal(false)
  const [folderError, setFolderError] = createSignal<string>()
  const [dismissed, setDismissed] = createSignal<string>()
  const problem = () => setup.error()?.message ?? folderError() ?? setup.job()?.error?.message ?? setup.plan()?.refusal?.message
  const busy = () => setup.changing() || setup.planning() || setupJobActive(setup.job()) || folderBusy()
  const bytes = (value: number) => formatBytes(value, activeLocale.get().tag)
  const download = () => {
    const plan = arrival.value()!
    return plan.downloadBytes !== null ? bytes(plan.downloadBytes)
      : plan.runtimeDownloadBytes !== null ? message('setup.runtimeBytes', { size: bytes(plan.runtimeDownloadBytes) })
      : message('setup.downloadUnknown')
  }
  const replanRoot = async (root: string) => {
    const plan = setup.plan()!
    await setup.refresh({ root, channel: plan.channel, ...(plan.variant ? { variant: plan.variant } : {}) })
    if (!setup.error()) setFolder(undefined)
  }
  const chooseFolder = async () => {
    setFolderError(undefined)
    setFolderBusy(true)
    try {
      const bridge = desktopFileBridge()
      const url = new URL('/', location.href).href
      if (bridge && (await bridge.fileCapabilities(url)).nativeFolderChoice) {
        const selected = await bridge.chooseDirectory(url)
        if (selected) await replanRoot(selected)
      } else setFolder(setup.plan()!.root)
    } catch (failure) {
      setFolderError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setFolderBusy(false)
    }
  }
  const jobLine = () => {
    const job = setup.job()!
    return message(`setup.state.${job.state}`)
  }
  const progress = () => {
    const value = setup.job()?.progress
    if (!value) return undefined
    const completed = value.unit === 'bytes' ? bytes(value.completed) : String(value.completed)
    const total = value.total === null ? undefined : value.unit === 'bytes' ? bytes(value.total) : String(value.total)
    return total === undefined ? message('setup.progressMeasured', { stage: value.stage, completed })
      : message('setup.progressTotal', { stage: value.stage, completed, total })
  }

  return (
    <div class="setup-host" data-surface={props.surface} data-testid="setup-form">
      <Show when={arrival.value()} fallback={
        <Show when={setup.error()} fallback={<Show when={arrival.loading()}><ProductLoading label={message('setup.loading')} /></Show>}>
          <Show when={setup.error()?.message !== dismissed()}><ProductErrorBanner onDismiss={() => setDismissed(setup.error()?.message)}>{setup.error()?.message}</ProductErrorBanner></Show>
          <ProductButton onClick={() => void setup.refresh()}>{message('setup.retry')}</ProductButton>
        </Show>
      }>
        {(plan) => <section class="setup-form setup-arrival">
          <Show when={problem() && problem() !== dismissed()}><ProductErrorBanner onDismiss={() => setDismissed(problem())}>{problem()}</ProductErrorBanner></Show>
          <Show when={props.surface === 'editor'}><ProductBrandMark /></Show>
          <h1 class="dinkster-title">{message(props.surface === 'editor' ? 'setup.editorTitle' : 'projects.setup.title')}</h1>
          <dl class="setup-facts">
            <dt>{message('setup.folder')}</dt>
            <dd><span>{setupJobActive(setup.job()) ? setup.job()!.root : plan().root}</span><ProductTextButton label={message('setup.chooseFolder')} disabled={busy()} onClick={() => { setDismissed(undefined); void chooseFolder() }} /></dd>
            <dt>{message('setup.build')}</dt>
            <dd><div><span>{setupJobActive(setup.job()) && setup.job()!.variant !== plan().variant ? setup.job()!.variant : plan().buildLabel ?? message('setup.buildUnknown')}</span><Show when={plan().buildReason}><p class="dinkster-description">{plan().buildReason}</p></Show></div>
              <Show when={(plan().choices?.length ?? 0) > 1}><ProductTextButton label={message('setup.changeBuild')} disabled={busy()} onClick={() => setChoosingBuild(!choosingBuild())} /></Show>
            </dd>
            <Show when={choosingBuild()}>
              <dt>{message('setup.chooseBuild')}</dt><dd><ProductSelect aria-label={message('setup.chooseBuild')} value={plan().variant ?? ''} disabled={busy()} onChange={(event) => {
                void setup.refresh({ root: plan().root, channel: plan().channel, variant: event.currentTarget.value })
              }}><For each={plan().choices ?? []}>{(choice) => <option value={choice.variant} title={choice.reason}>{choice.label}</option>}</For></ProductSelect></dd>
            </Show>
            <dt>{message('setup.download')}</dt><dd><span>{download()}<span class="dinkster-description">{message('setup.free', { size: bytes(plan().freeBytes) })}</span></span></dd>
          </dl>
          <Show when={plan().downloadBytes === null}><p class="dinkster-description">{message('setup.totalUnknown')}</p></Show>
          <Show when={plan().refusal?.code === 'library-held'}><p class="dinkster-description">{message('setup.libraryHeld')}</p></Show>
          <Show when={setup.job()}><div class="setup-job" role="status">
            <strong>{jobLine()}</strong>
            <Show when={progress()}><p class="dinkster-description">{progress()}</p></Show>
          </div></Show>
          <div class="dinkster-actions setup-actions">
            <Show when={setupJobActive(setup.job())} fallback={
              <>
                <Show when={setup.error() || plan().refusal}><ProductButton disabled={busy()} onClick={() => { setDismissed(undefined); void setup.refresh() }}>{message('setup.retry')}</ProductButton></Show>
                <Show when={setup.job()?.state !== 'completed'}><ProductButton intent="add" fill="solid" disabled={!setup.canStart() || folderBusy()} onClick={() => { setDismissed(undefined); void setup.start() }}>{message('setup.start')}</ProductButton></Show>
              </>
            }><ProductButton disabled={setup.changing() || setup.job()?.state === 'cancelling'} onClick={() => void setup.cancel()}>{message('setup.cancel')}</ProductButton></Show>
          </div>
          <Show when={props.surface === 'editor'}><p class="dinkster-description">{message('setup.editorNote')}</p></Show>
        </section>}
      </Show>
      <Show when={folder() !== undefined}>
        <ProductDialog title={message('setup.chooseFolder')} pending={setup.planning()} onDismiss={() => { if (!setup.planning()) setFolder(undefined) }}>
          <form class="dinkster-stack" onSubmit={(event) => { event.preventDefault(); void replanRoot(folder()!) }}>
            <ProductField label={message('setup.folder')} error={setup.error()?.message ?? ''}>{(attributes) => <ProductTextInput {...attributes} value={folder()} onInput={(event) => setFolder(event.currentTarget.value)} disabled={setup.planning()} required />}</ProductField>
            <div class="dinkster-actions"><ProductButton type="submit" disabled={setup.planning() || folder() === setup.plan()?.root}>{message('setup.reviewFolder')}</ProductButton><ProductButton disabled={setup.planning()} onClick={() => setFolder(undefined)}>{message('setup.cancel')}</ProductButton></div>
          </form>
        </ProductDialog>
      </Show>
    </div>
  )
}
