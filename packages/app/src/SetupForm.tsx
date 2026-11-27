import { createEffect, createSignal, createUniqueId, For, onCleanup, Show } from 'solid-js'
import { activeLocale } from '@dinkster/core'
import { ProductBrandMark, ProductButton, ProductDialog, ProductField, ProductMenu, ProductNotice, ProductPageLoad, ProductProgress, ProductTextButton, ProductTextInput } from '@dinkster/ui'
import { desktopFileBridge } from './desktop-bridge.js'
import { useAppMessage } from './locale.js'
import { formatBytes } from './projects-page/project-facts.js'
import { createSetupController, setupJobActive, type SetupJob } from './setup-job.js'
import './styles/setup.css'

export type SetupStatus = 'not-set-up' | 'setting-up'

/** The projects page and empty editor use the same process-owned setup job. */
export function SetupForm(props: {
  readonly surface: 'projects' | 'editor'
  readonly onInstallation?: (installation: NonNullable<SetupJob['installation']>) => void
  readonly onStatusChange?: ((status: SetupStatus | undefined) => void) | undefined
}) {
  const message = useAppMessage()
  const setup = createSetupController({
    onInstallation: (installation) => props.onInstallation?.(installation),
  })
  createEffect(() => {
    props.onStatusChange?.(setupJobActive(setup.job()) ? 'setting-up' : 'not-set-up')
    onCleanup(() => props.onStatusChange?.(undefined))
  })
  const [folder, setFolder] = createSignal<string>()
  const folderForm = createUniqueId()
  const [folderBusy, setFolderBusy] = createSignal(false)
  const [folderError, setFolderError] = createSignal<string>()
  const problem = () => (setup.page.error() ? undefined : setup.error()?.message) ?? folderError() ?? setup.job()?.error?.message
  const busy = () => setup.changing() || setup.planning() || setupJobActive(setup.job()) || folderBusy()
  const canChange = () => !setupJobActive(setup.job()) && setup.job()?.state !== 'completed'
  const bytes = (value: number) => formatBytes(value, activeLocale.get().tag)
  const buildLabel = () => {
    const plan = setup.plan()
    const job = setup.job()
    return setupJobActive(job) && job!.variant !== plan?.variant
      ? plan?.choices?.find((choice) => choice.variant === job!.variant)?.label
      : plan?.buildLabel
  }
  const cardNames = () => {
    const variant = setupJobActive(setup.job()) ? setup.job()!.variant : setup.plan()?.variant
    if (variant?.endsWith('-cpu')) return []
    const counts = new Map<string, number>()
    for (const card of setup.plan()?.detectedCards ?? []) counts.set(card.name, (counts.get(card.name) ?? 0) + 1)
    return [...counts].map(([name, count]) => count > 1 ? `${count} x ${name}` : name)
  }
  const download = () => {
    const plan = setup.plan()!
    return plan.downloadBytes !== null ? bytes(plan.downloadBytes)
      : plan.downloadEstimate ? message('setup.estimatedBytes', { size: bytes(plan.downloadEstimate.bytes) })
      : plan.runtimeDownloadBytes !== null ? message('setup.runtimeBytes', { size: bytes(plan.runtimeDownloadBytes) })
      : undefined
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
    const key = `setup.stage.${value.stage}`
    const translated = message(key)
    const stage = translated === key ? message('setup.stage.unknown') : translated
    if (value.unit !== 'bytes') return stage
    const completed = bytes(value.completed)
    return value.total === null ? message('setup.progressMeasured', { stage, completed })
      : message('setup.progressTotal', { stage, completed, total: bytes(value.total) })
  }
  const progressValue = () => {
    const value = setup.job()?.progress
    return value?.unit === 'bytes' && value.total !== null && value.total > 0
      ? Math.min(1, Math.max(0, value.completed / value.total)) : undefined
  }

  return (
    <div class="setup-host" data-surface={props.surface} data-testid="setup-form">
      <ProductPageLoad page={setup.page} read={() => setup.readPlan()} loadingLabel={message('setup.loading')} arrival="fade">
      <Show when={setup.plan()}>
        {(plan) => <section class="setup-form">
          <Show when={props.surface === 'editor'}><ProductBrandMark /></Show>
          <h1 class="dinkster-title">{message(props.surface === 'editor' ? 'setup.editorTitle' : 'projects.setup.title')}</h1>
          <dl class="setup-facts">
            <dt>{message('setup.folder')}</dt>
            <dd><span>{setupJobActive(setup.job()) ? setup.job()!.root : plan().root}</span><Show when={canChange()}><ProductTextButton label={message('setup.chooseFolder')} disabled={busy()} onClick={() => { void chooseFolder() }} /></Show></dd>
            <Show when={plan().buildLabel || setupJobActive(setup.job())}><dt>{message('setup.build')}</dt>
            <dd><div><Show when={buildLabel()}>{(label) => <span>{label()}</span>}</Show><For each={cardNames()}>{(name) => <p class="dinkster-description">{name}</p>}</For></div>
              <Show when={canChange() && (plan().choices?.length ?? 0) > 1}><ProductMenu fill="quiet" align="end" label={message('setup.changeBuild')} items={(plan().choices ?? []).map((choice) => ({
                label: choice.label,
                description: choice.reason,
                checked: choice.variant === plan().variant,
                disabled: busy(),
                onSelect: () => { void setup.refresh({ root: plan().root, channel: plan().channel, variant: choice.variant }) },
              }))} /></Show>
            </dd></Show>
            <Show when={download()}>{(size) => <><dt>{message('setup.download')}</dt><dd><span>{message('setup.downloadSpace', { size: size(), free: bytes(plan().freeBytes) })}</span></dd></>}</Show>
          </dl>
          <Show when={setup.job()}><div class="setup-job" role="status">
            <strong>{jobLine()}</strong>
            <Show when={setupJobActive(setup.job())}><ProductProgress label={progress() ?? jobLine()} value={progressValue()} /></Show>
            <Show when={setupJobActive(setup.job()) && progress()}><p class="dinkster-description">{progress()}</p></Show>
          </div></Show>
          <Show when={plan().refusal}>{(refusal) => <ProductNotice tone="warning">
            <Show when={refusal().code === 'library-held'} fallback={refusal().message}>
              {message('setup.libraryHeld')}<br />{message('setup.libraryHeldAction')}
            </Show>
          </ProductNotice>}</Show>
          <Show when={!plan().refusal && !setupJobActive(setup.job()) && plan().downloadBytes === null && plan().downloadEstimate && plan().downloadEstimate!.bytes > plan().freeBytes}>
            <ProductNotice tone="warning">{message('setup.estimatedSpaceWarning', { size: bytes(plan().downloadEstimate!.bytes), free: bytes(plan().freeBytes) })}</ProductNotice>
          </Show>
          <Show when={problem()}><ProductNotice tone="error">{problem()}</ProductNotice></Show>
          <div class="dinkster-actions setup-actions">
            <Show when={setupJobActive(setup.job())} fallback={
              <>
                <Show when={setup.error() || plan().refusal}><ProductButton disabled={busy()} onClick={() => { void setup.refresh() }}>{message('setup.retry')}</ProductButton></Show>
                <Show when={!plan().refusal && setup.job()?.state !== 'completed'}><ProductButton intent="add" fill="solid" disabled={!setup.canStart() || folderBusy()} onClick={() => { void setup.start() }}>{message('setup.start')}</ProductButton></Show>
              </>
            }><ProductButton disabled={setup.changing() || setup.job()?.state === 'cancelling'} onClick={() => void setup.cancel()}>{message('setup.cancel')}</ProductButton></Show>
          </div>
          <Show when={props.surface === 'editor' && setup.job()?.state !== 'completed'}><p class="dinkster-description">{message('setup.editorNote')}</p></Show>
        </section>}
      </Show>
      </ProductPageLoad>
      <Show when={folder() !== undefined}>
        <ProductDialog title={message('setup.chooseFolder')} pending={setup.planning()} onDismiss={() => { if (!setup.planning()) setFolder(undefined) }}
          action={<ProductButton type="submit" form={folderForm} fill="solid" disabled={setup.planning() || folder() === setup.plan()?.root}>{message('setup.reviewFolder')}</ProductButton>}>
          <form id={folderForm} class="dinkster-stack" onSubmit={(event) => { event.preventDefault(); void replanRoot(folder()!) }}>
            <ProductField label={message('setup.folder')} error={setup.error()?.message ?? ''}>{(attributes) => <ProductTextInput {...attributes} value={folder()} onInput={(event) => setFolder(event.currentTarget.value)} disabled={setup.planning()} required />}</ProductField>
          </form>
        </ProductDialog>
      </Show>
    </div>
  )
}
