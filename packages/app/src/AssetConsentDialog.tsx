import { createEffect, createSignal, For, Index, Show } from 'solid-js'
import type { MissingAsset } from '@dinkster/client'
import type { AppState } from './app-state.js'
import { useAssetDecisionViewport } from './asset-decision-viewport.js'
import { formatByteSize } from './collections.js'
import { useAppMessage } from './locale.js'
import { ModalSurface } from './ModalSurface.js'
import { ProductButton, ProductCheckbox } from './ProductControls.js'
import { ModelProvider } from './ModelProvider.js'
import { ProductActionFooter, ProductNotice } from './ProductForm.js'
import { useSignal } from './solid-adapter.js'

export interface AssetPlanPresentation {
  readonly source: string
  readonly size?: string
  readonly consentable: boolean
}

type Message = ReturnType<typeof useAppMessage>
const cancellableModelPhases = new Set(['starting', 'checking-existing', 'downloading', 'verifying'])

export function presentAssetPlan(asset: MissingAsset, message: Message): AssetPlanPresentation {
  const packaged = asset.packagedFrom?.length
    ? message('assetConsent.source.packaged', { packs: asset.packagedFrom.join(', ') })
    : undefined
  const hosts = [...new Set(asset.sources.map((source) => {
    try { return new URL(source).host }
    catch { return source }
  }))]
  return {
    source: asset.disabledLocations?.length ? message('assetConsent.folderDisabled') : packaged ?? (asset.fetchable && hosts.length > 0
      ? message('assetConsent.source.download', { hosts: hosts.join(', ') })
      : message('assetConsent.source.unresolvable')),
    ...(asset.size !== undefined ? { size: formatByteSize(asset.size) } : {}),
    consentable: asset.fetchable,
  }
}

export function AssetConsentDialog(props: { app: AppState }) {
  const message = useAppMessage()
  let decisionEl: HTMLDivElement | undefined
  useAssetDecisionViewport(() => decisionEl)
  const request = useSignal(props.app.assetConsent)
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set())
  let previousAssets: readonly MissingAsset[] | undefined
  createEffect(() => {
    const current = request()
    if (current?.busy || current?.assets === previousAssets) return
    previousAssets = current?.assets
    const assets = current?.assets ?? []
    setSelected(new Set(assets.filter((asset) => asset.fetchable).map((asset) => asset.digest)))
  })
  // An explicit busy-state dismissal hides the dialog without cancelling the active retry.
  const cancel = () => {
    if (!request()?.busy) props.app.assetConsent.set(undefined)
  }
  const dismiss = () => props.app.assetConsent.set(undefined)
  const toggle = (digest: string, checked: boolean) => {
    const next = new Set(selected())
    if (checked) next.add(digest); else next.delete(digest)
    setSelected(next)
  }
  const selectable = () => (request()?.assets ?? []).filter((asset) => asset.fetchable)
  const models = () => request()?.models ?? []
  const nextDownload = () => models().findIndex((entry) => entry.plan?.status === 'consent-required' && !entry.pending)
  const modelsReady = () => models().every((entry) => !entry.pending && (entry.plan?.status === 'local' || entry.job?.status === 'completed'))
  const canRun = () => modelsReady() && (models().length > 0 || selected().size > 0)
  const selectionStatus = () => {
    const count = selected().size
    if (request()?.enablingLocation) return message('assetConsent.enablingFolder', { folder: request()!.enablingLocation! })
    if (request()?.busy) return message('assetConsent.selection.busy', { count })
    return models().length ? message('modelConsent.footer') : message('assetConsent.selection.ready', { selected: count, available: selectable().length })
  }
  return <Show when={request()}>
    <ModalSurface
      title={message('assetConsent.title')}
      ariaLabel={message('assetConsent.ariaLabel')}
      describedBy="asset-consent-intro"
      modalId="asset-consent"
      testId="asset-consent-dialog"
      dismissBlocked={request()?.busy === true}
      onRequestClose={cancel}
    >
      <div ref={decisionEl} class="asset-decision asset-consent-decision" aria-busy={request()?.busy === true ? 'true' : 'false'}>
        <section class="asset-decision-intro">
          <span class="asset-decision-eyebrow">{message('assetConsent.eyebrow')}</span>
          <p id="asset-consent-intro">{message('assetConsent.intro')}</p>
          <Show when={models().length === 0 || (request()?.assets.length ?? 0) > 0}><dl class="asset-decision-summary" aria-label={message('assetConsent.summary')}>
            <div><dt>{message('assetConsent.summary.required')}</dt><dd data-testid="asset-consent-required-count">{(request()?.assets.length ?? 0) + models().length}</dd></div>
            <div><dt>{message('assetConsent.summary.available')}</dt><dd data-testid="asset-consent-available-count">{selectable().length}</dd></div>
            <div><dt>{message('assetConsent.summary.selected')}</dt><dd data-testid="asset-consent-selected-count">{selected().size}</dd></div>
          </dl></Show>
        </section>
        <Show when={selectable().length > 0 && !request()?.busy}>
          <ProductNotice tone="warning" class="asset-decision-notice">{message('assetConsent.notice.available')}</ProductNotice>
        </Show>
        <ul class="asset-decision-list" tabindex="0" aria-label={message('assetConsent.listAriaLabel')}>
          <For each={request()?.assets ?? []}>{(asset, index) => {
            const display = () => presentAssetPlan(asset, message)
            const controlId = `asset-consent-choice-${index()}`
            const nameId = `${controlId}-name`
            const detailId = `${controlId}-detail`
            return <li
              class="asset-decision-row"
              classList={{ unresolvable: !display().consentable, selected: selected().has(asset.digest) }}
              data-testid="asset-consent-row"
              data-state={display().consentable ? 'available' : 'unresolvable'}
            >
              <ProductCheckbox
                id={controlId}
                class="asset-decision-checkbox"
                testId="asset-consent-checkbox"
                ariaLabelledBy={nameId}
                ariaDescribedBy={detailId}
                disabled={!display().consentable || request()?.busy === true}
                checked={selected().has(asset.digest)}
                onChange={(checked) => toggle(asset.digest, checked)}
              />
              <div class="asset-decision-row-copy"><label class="asset-decision-row-copy" for={controlId}>
                <span class="asset-decision-row-heading">
                  <strong id={nameId}>{asset.name}</strong>
                  <span class="asset-decision-state" data-state={display().consentable ? 'available' : 'unresolvable'}>
                    {message(asset.disabledLocations?.length ? 'assetConsent.state.folderDisabled' : display().consentable ? 'assetConsent.state.available' : 'assetConsent.state.unresolvable')}
                  </span>
                </span>
                <span class="asset-decision-tags">
                  <Show when={asset.kind}><span class="asset-kind">{asset.kind}</span></Show>
                  <span>{asset.status}</span>
                  <Show when={display().size}>{(size) => <span>{size()}</span>}</Show>
                </span>
                <span class="asset-decision-fact asset-decision-digest"><span>{message('assetConsent.fact.digest')}</span><code>{asset.digest}</code></span>
                <span id={detailId} class="asset-decision-source"><span>{message('assetConsent.fact.source')}</span><span class="asset-decision-source-details">{display().source}<For each={asset.sources}>{(source) => <code>{source}</code>}</For></span></span>
                <Show when={asset.destination}>{(destination) => <span class="asset-decision-fact" data-testid="asset-consent-destination"><span>{message('assetConsent.fact.destination')}</span><code>{destination()}</code></span>}</Show>
                <Show when={asset.detail}><small class="asset-decision-warning">{asset.detail}</small></Show>
              </label>
              <Show when={asset.disabledLocations?.length}>
                <div class="asset-decision-source-details">
                  <For each={asset.disabledLocations}>{(location) => <ProductButton disabled={request()?.busy === true || !request()?.enableLocation} onClick={() => void request()?.enableLocation?.(location)}>{message('assetConsent.enableFolder', { folder: location })}</ProductButton>}</For>
                </div>
              </Show></div>
            </li>
          }}</For>
          <Index each={models()}>{(state, index) => {
            const metadata = () => {
              const plan = state().plan
              return state().job ?? (plan?.status === 'consent-required' ? plan : undefined)
            }
            const phase = () => {
              const job = state().job
              if (state().interrupted) return message('modelConsent.interrupted')
              if (job) return message(`modelConsent.phase.${job.status}`)
              const plan = state().plan
              if (plan) return message(`modelConsent.plan.${plan.status}`)
              return message('modelConsent.reviewFirst')
            }
            const cancellable = () => { return cancellableModelPhases.has(state().job?.status ?? '') }
            return <li class="asset-decision-row" data-testid="model-consent-row">
              <div class="asset-decision-row-copy">
                <strong>{state().requirement.name}</strong>
                <span class="asset-kind">{state().requirement.kind}</span>
                <ProductNotice tone="status" testId="model-consent-phase">{phase()}</ProductNotice>
                <Show when={state().job?.error}>{(error) => <ProductNotice tone="error">{['credential-required', 'provider-grant-required', 'model-hidden'].includes(error()) ? message(`modelConsent.plan.${error()}`) : error()}</ProductNotice>}</Show>
                <Show when={metadata()}>{(selection) => <>
                  <For each={[
                    ['modelConsent.provider', selection().provider], ['modelConsent.project', selection().project],
                    ['assetConsent.fact.source', selection().source], ['modelConsent.repository', selection().repo],
                    ['modelConsent.revision', selection().revision], ['modelConsent.file', selection().file],
                    ['modelConsent.sha256', selection().sha256], ['modelConsent.license', selection().license],
                    ['assetConsent.fact.destination', selection().destination],
                  ] as const}>{([label, value]) => <span class="asset-decision-fact"><span>{message(label)}</span><code>{value}</code></span>}</For>
                  <span class="asset-decision-source">{formatByteSize(selection().size)}</span>
                </>}</Show>
                <Show when={state().job}>{(job) => <>
                  <span role="status" data-testid="model-consent-bytes">{message('modelConsent.bytes', { received: job().received, total: job().size })}</span>
                  <Show when={job().path}>{(path) => <span class="asset-decision-fact"><span>{message('modelConsent.actualPath')}</span><code>{path()}</code></span>}</Show>
                  <Show when={job().reused}><span>{message('modelConsent.reused')}</span></Show>
                  <Show when={job().renamed}><span>{message('modelConsent.renamed')}</span></Show>
                  <Show when={job().indexingPending}><ProductNotice tone="info">{message('modelConsent.indexingPending')}</ProductNotice></Show>
                </>}</Show>
                <Show when={state().error}><ProductNotice tone="error">{state().error}</ProductNotice></Show>
                <Show when={state().plan?.status === 'folder-disabled'}><ProductNotice tone="warning">{message('assetConsent.folderDisabled')}</ProductNotice></Show>
                <div class="asset-decision-source-details">
                  <ProductButton disabled={state().pending || request()?.busy} onClick={() => void request()?.reviewModel?.(index)}>{message(state().job || state().interrupted ? 'modelConsent.reconnect' : 'modelConsent.review')}</ProductButton>
                  <Show when={nextDownload() === index}>
                    <ProductButton variant="primary" disabled={state().pending || request()?.busy} data-testid="model-consent-download" onClick={() => void request()?.downloadModel?.(index)}>{message('modelConsent.download')}</ProductButton>
                  </Show>
                  <Show when={cancellable()}><ProductButton disabled={state().pending || request()?.busy} data-testid="model-consent-cancel" onClick={() => void request()?.cancelModel?.(index)}>{message('modelConsent.cancel')}</ProductButton></Show>
                </div>
              </div>
            </li>
          }}</Index>
        </ul>
        <Show when={request()?.providerConnection && models().some((entry) =>
          ['credential-required', 'provider-grant-required'].includes(entry.job?.error ?? entry.plan?.status ?? ''))}>
          <ModelProvider connection={request()!.providerConnection!}
            {...(request()?.providerBackendUrl === undefined ? {} : { backendUrl: request()!.providerBackendUrl! })}
            onChanged={() => request()?.providerChanged?.()} />
        </Show>
        <Show when={selectable().length === 0 && request()?.assets.some((asset) => !asset.disabledLocations?.length)}>
          <ProductNotice tone="warning" class="asset-decision-notice">{message('assetConsent.notice.unresolvable')}</ProductNotice>
        </Show>
        <Show when={request()?.busy}>
          <ProductNotice tone="status" class="asset-decision-notice" testId="asset-consent-progress">{request()?.enablingLocation ? message('assetConsent.enablingFolder', { folder: request()!.enablingLocation! }) : message('assetConsent.notice.busy')}</ProductNotice>
        </Show>
        <ProductActionFooter status={<span role="status" aria-live="polite" data-testid="asset-consent-selection-status">{selectionStatus()}</span>}>
          <ProductButton data-testid="asset-consent-cancel" onClick={dismiss}>{message(request()?.busy || models().length ? 'assetConsent.action.dismiss' : 'assetConsent.action.cancel')}</ProductButton>
          <Show when={nextDownload() < 0}>
            <ProductButton variant="primary" data-testid="asset-consent-acquire" disabled={request()?.busy === true || !canRun()} onClick={() => void request()?.retry([...selected()])}>
              {message(request()?.enablingLocation ? 'assetConsent.action.enabling' : request()?.busy ? 'assetConsent.action.acquiring' : models().length ? 'modelConsent.runOnce' : 'assetConsent.action.acquire')}
            </ProductButton>
          </Show>
        </ProductActionFooter>
      </div>
    </ModalSurface>
  </Show>
}
