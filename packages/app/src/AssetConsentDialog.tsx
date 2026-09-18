import { createEffect, createSignal, For, Show } from 'solid-js'
import type { MissingAsset } from '@dinkster/client'
import type { AppState } from './app-state.js'
import { useAssetDecisionViewport } from './asset-decision-viewport.js'
import { formatByteSize } from './collections.js'
import { useAppMessage } from './locale.js'
import { ModalSurface } from './ModalSurface.js'
import { ProductCheckbox } from './ProductControls.js'
import { ProductActionFooter, ProductNotice } from './ProductForm.js'
import { useSignal } from './solid-adapter.js'

export interface AssetPlanPresentation {
  readonly source: string
  readonly size?: string
  readonly consentable: boolean
}

type Message = ReturnType<typeof useAppMessage>

export function presentAssetPlan(asset: MissingAsset, message: Message): AssetPlanPresentation {
  const packaged = asset.packagedFrom?.length
    ? message('assetConsent.source.packaged', { packs: asset.packagedFrom.join(', ') })
    : undefined
  const hosts = [...new Set(asset.sources.map((source) => {
    try { return new URL(source).host }
    catch { return source }
  }))]
  return {
    source: packaged ?? (asset.fetchable && hosts.length > 0
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
  createEffect(() => {
    const current = request()
    if (current?.busy) return
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
  const selectionStatus = () => {
    const count = selected().size
    if (request()?.busy) return message('assetConsent.selection.busy', { count })
    return message('assetConsent.selection.ready', { selected: count, available: selectable().length })
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
          <dl class="asset-decision-summary" aria-label={message('assetConsent.summary')}>
            <div><dt>{message('assetConsent.summary.required')}</dt><dd data-testid="asset-consent-required-count">{request()?.assets.length ?? 0}</dd></div>
            <div><dt>{message('assetConsent.summary.available')}</dt><dd data-testid="asset-consent-available-count">{selectable().length}</dd></div>
            <div><dt>{message('assetConsent.summary.selected')}</dt><dd data-testid="asset-consent-selected-count">{selected().size}</dd></div>
          </dl>
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
              <label class="asset-decision-row-copy" for={controlId}>
                <span class="asset-decision-row-heading">
                  <strong id={nameId}>{asset.name}</strong>
                  <span class="asset-decision-state" data-state={display().consentable ? 'available' : 'unresolvable'}>
                    {message(display().consentable ? 'assetConsent.state.available' : 'assetConsent.state.unresolvable')}
                  </span>
                </span>
                <span class="asset-decision-tags">
                  <Show when={asset.kind}><span class="asset-kind">{asset.kind}</span></Show>
                  <span>{asset.status}</span>
                  <Show when={display().size}>{(size) => <span>{size()}</span>}</Show>
                </span>
                <span class="asset-decision-fact asset-decision-digest"><span>{message('assetConsent.fact.digest')}</span><code>{asset.digest}</code></span>
                <span id={detailId} class="asset-decision-source"><span>{message('assetConsent.fact.source')}</span>{display().source}</span>
                <Show when={asset.detail}><small class="asset-decision-warning">{asset.detail}</small></Show>
              </label>
            </li>
          }}</For>
        </ul>
        <Show when={selectable().length === 0}>
          <ProductNotice tone="warning" class="asset-decision-notice">{message('assetConsent.notice.unresolvable')}</ProductNotice>
        </Show>
        <Show when={request()?.busy}>
          <ProductNotice tone="status" class="asset-decision-notice" testId="asset-consent-progress">{message('assetConsent.notice.busy')}</ProductNotice>
        </Show>
        <ProductActionFooter status={<span role="status" aria-live="polite" data-testid="asset-consent-selection-status">{selectionStatus()}</span>}>
          <button type="button" data-testid="asset-consent-cancel" onClick={dismiss}>{message(request()?.busy ? 'assetConsent.action.dismiss' : 'assetConsent.action.cancel')}</button>
          <button type="button" class="primary" data-testid="asset-consent-acquire" disabled={request()?.busy === true || selected().size === 0} onClick={() => void request()?.retry([...selected()])}>
            {message(request()?.busy ? 'assetConsent.action.acquiring' : 'assetConsent.action.acquire')}
          </button>
        </ProductActionFooter>
      </div>
    </ModalSurface>
  </Show>
}
