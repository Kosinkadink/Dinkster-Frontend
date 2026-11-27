import { createEffect, createSignal, createUniqueId, For, onCleanup, Show } from 'solid-js'
import { formatByteSize } from '@dinkster/core'
import { ProductBrandMark, ProductButton, ProductDialog, ProductDisclosure, ProductFacts, ProductField, ProductMenu, ProductNotice, ProductPageLoad, ProductPanel, ProductProgress, ProductTextButton, ProductTextInput } from '@dinkster/ui'
import { desktopFileBridge } from './desktop-bridge.js'
import { useAppMessage } from './locale.js'
import { createSetupController, setupJobActive, type SetupJob, type UnusableGraphicsCard } from './setup-job.js'
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
  const variant = () => setupJobActive(setup.job()) ? setup.job()!.variant : setup.plan()?.variant
  const choice = () => setup.plan()?.choices?.find((choice) => choice.variant === variant())
  const graphicsVendor = () => setupJobActive(setup.job()) ? choice()?.vendor : setup.plan()?.graphicsVendor
  const buildLabel = () => {
    const plan = setup.plan()
    const job = setup.job()
    return setupJobActive(job) && job!.variant !== plan?.variant
      ? plan?.choices?.find((choice) => choice.variant === job!.variant)?.label
      : plan?.buildLabel
  }
  const cardNames = () => {
    const plan = setup.plan()
    if (graphicsVendor() === null) return []
    const assigned = choice()?.gpus ?? (variant() === plan?.variant ? plan?.gpus : undefined)
    const counts = new Map<string, number>()
    for (const card of plan?.detectedCards ?? []) {
      if (!assigned?.includes(card.id) || (graphicsVendor() && (card.vendor ?? 'nvidia') !== graphicsVendor())) continue
      counts.set(card.name, (counts.get(card.name) ?? 0) + 1)
    }
    return [...counts].map(([name, count]) => count > 1 ? `${count} x ${name}` : name)
  }
  const repairable = () => setup.plan()?.unusableCards?.some((card) =>
    card.reason === 'driver-too-old' || card.reason === 'detection-tool-missing' || card.reason === 'detection-tool-failed') ?? false
  const graphicsSelected = () => Boolean(graphicsVendor())
  const graphicsWarning = () => !graphicsSelected() && Boolean(setup.plan()?.unusableCards?.length)
  const cpuChoice = () => setup.plan()?.choices?.find((choice) => choice.vendor === null)
  const cardLines = (description: boolean) => {
    const groups = new Map<string, { card: UnusableGraphicsCard; count: number }>()
    for (const card of setup.plan()?.unusableCards ?? []) {
      if (description && card.reason === 'no-published-build') continue
      const key = JSON.stringify([card.name, card.vendor, card.reason, card.minimumDriver, card.driver, card.tool])
      const group = groups.get(key)
      if (group) group.count++
      else groups.set(key, { card, count: 1 })
    }
    return [...groups.values()].map(({ card, count }) => {
      const vendor = card.vendor ? { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' }[card.vendor] : ''
      const name = card.name || message(vendor ? 'setup.graphics.unnamedVendor' : 'setup.graphics.unnamed', { vendor })
      const params = {
        name: count > 1 ? `${count} x ${name}` : name,
        vendor, minimum: card.minimumDriver ?? '', driver: card.driver ?? '', tool: card.tool ?? '',
        system: message(`setup.graphics.system.${setup.plan()?.system}`),
      }
      const reason = description && card.reason.startsWith('detection-tool-') ? 'detection-unchecked' : card.reason
      const suffix = !vendor && reason === 'no-published-build' ? '-unknown'
        : !description && reason === 'driver-too-old' && card.driver ? '-known' : ''
      return message(`setup.graphics.${description ? 'unused' : 'warning'}.${reason}${suffix}`, params)
    })
  }
  const checkAgain = () => {
    const plan = setup.plan()!
    void setup.refresh(graphicsWarning() && repairable() ? { root: plan.root, channel: plan.channel } : undefined)
  }
  const download = () => {
    const plan = setup.plan()!
    return plan.downloadBytes !== null ? formatByteSize(plan.downloadBytes)
      : plan.downloadEstimate ? message('setup.estimatedBytes', { size: formatByteSize(plan.downloadEstimate.bytes) })
      : plan.runtimeDownloadBytes !== null ? message('setup.runtimeBytes', { size: formatByteSize(plan.runtimeDownloadBytes) })
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
    const completed = formatByteSize(value.completed)
    return value.total === null ? message('setup.progressMeasured', { stage, completed })
      : message('setup.progressTotal', { stage, completed, total: formatByteSize(value.total) })
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
          <div class="setup-facts">
          <ProductPanel fill="quiet">
          <dl class="setup-facts-rows">
            <dt>{message('setup.folder')}</dt>
            <dd><span>{setupJobActive(setup.job()) ? setup.job()!.root : plan().root}</span><Show when={canChange()}><ProductTextButton label={message('setup.chooseFolder')} disabled={busy()} onClick={() => { void chooseFolder() }} /></Show></dd>
          </dl>
          </ProductPanel>
          <ProductPanel fill="quiet">
          <dl class="setup-facts-rows">
            <Show when={plan().buildLabel || graphicsWarning() || setupJobActive(setup.job())}><dt>{message('setup.build')}</dt>
            <dd><div>
              <Show when={buildLabel()} fallback={<Show when={!variant()}><span class="dinkster-description">{message('setup.notChosen')}</span></Show>}>{(label) => <span>{label()}</span>}</Show>
              <For each={cardNames()}>{(name) => <p class="dinkster-description">{name}</p>}</For>
              <Show when={graphicsSelected()}><For each={cardLines(true)}>{(line) => <p class="dinkster-description">{line}</p>}</For></Show>
            </div>
              <Show when={canChange() && plan().variant && (plan().choices?.length ?? 0) > 1}><ProductMenu fill="quiet" align="end" label={message('setup.changeBuild')} items={(plan().choices ?? []).map((choice) => ({
                label: choice.label,
                description: choice.reason,
                checked: choice.variant === plan().variant,
                disabled: busy(),
                onSelect: () => { void setup.refresh({ root: plan().root, channel: plan().channel, variant: choice.variant }) },
              }))} /></Show>
            </dd></Show>
            <Show when={download()}>{(size) => <><dt>{message('setup.download')}</dt><dd><span>{message('setup.downloadSpace', { size: size(), free: formatByteSize(plan().freeBytes) })}</span></dd></>}</Show>
          </dl>
          <Show when={variant() === plan().variant && plan().buildDetails}>{(details) =>
            <ProductDisclosure title={message('setup.details')}>
              <ProductFacts label={message('setup.buildVersions')} items={[
                { label: message('setup.python'), value: details().python },
                { label: message('setup.pytorch'), value: details().pytorch },
                { label: message('setup.cuda'), value: details().cuda ?? message('setup.cudaNotUsed') },
                { label: message('shell.applicationTitle'), value: details().dinkster },
              ]} />
            </ProductDisclosure>
          }</Show>
          </ProductPanel>
          </div>
          <Show when={graphicsWarning()}><ProductNotice tone="warning">
            {message(repairable() ? plan().variant ? 'setup.graphics.cpuRepair' : 'setup.graphics.repair' : 'setup.graphics.cpu')}
            <For each={cardLines(false)}>{(line) => <><br /><span class="dinkster-description">{line}</span></>}</For>
          </ProductNotice></Show>
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
            <ProductNotice tone="warning">{message('setup.estimatedSpaceWarning', { size: formatByteSize(plan().downloadEstimate!.bytes), free: formatByteSize(plan().freeBytes) })}</ProductNotice>
          </Show>
          <Show when={problem()}><ProductNotice tone="error">{problem()}</ProductNotice></Show>
          <div class="dinkster-actions setup-actions">
            <Show when={setupJobActive(setup.job())} fallback={
              <>
                <Show when={setup.error() || plan().refusal || canChange() && graphicsWarning() && repairable()}><ProductButton disabled={busy()} onClick={checkAgain}>{message('setup.retry')}</ProductButton></Show>
                <Show when={canChange() && !plan().variant && !plan().refusal && cpuChoice()}>{(cpu) => <ProductButton disabled={busy()} onClick={() => { void setup.refresh({ root: plan().root, channel: plan().channel, variant: cpu().variant }) }}>{message('setup.useCpu')}</ProductButton>}</Show>
                <Show when={plan().variant && !plan().refusal && setup.job()?.state !== 'completed'}><ProductButton intent="add" fill="solid" disabled={!setup.canStart() || folderBusy()} onClick={() => { void setup.start() }}>{message('setup.start')}</ProductButton></Show>
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
