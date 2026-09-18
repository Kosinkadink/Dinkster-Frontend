import { createEffect, createSignal, For, Show } from 'solid-js'
import type { AssetGuessCandidate, AssetGuessConfidence } from '@dinkster/client'
import type { AppState } from './app-state.js'
import { useAssetDecisionViewport } from './asset-decision-viewport.js'
import { formatByteSize } from './collections.js'
import { assetGuessCandidateToRef } from './dialog-requests.js'
import { useAppMessage } from './locale.js'
import { ModalSurface } from './ModalSurface.js'
import { ProductRadio } from './ProductControls.js'
import { ProductActionFooter, ProductNotice } from './ProductForm.js'
import { useSignal } from './solid-adapter.js'

const tierLabelKey = (tier: AssetGuessConfidence): string => ({
  digest: 'importAssetResolution.confidence.digest', path: 'importAssetResolution.confidence.path', name: 'importAssetResolution.confidence.name', 'name-insensitive': 'importAssetResolution.confidence.nameInsensitive', stem: 'importAssetResolution.confidence.stem', other: 'importAssetResolution.confidence.other',
})[tier]

const reasonLabelKey = {
  'digest-conflict': 'importAssetResolution.reason.digestConflict.detail',
  ambiguous: 'importAssetResolution.reason.ambiguous.detail',
  'no-match': 'importAssetResolution.reason.noMatch.detail',
  'weak-match': 'importAssetResolution.reason.weakMatch.detail',
} as const

const reasonHeadingKey = {
  'digest-conflict': 'importAssetResolution.reason.digestConflict.heading',
  ambiguous: 'importAssetResolution.reason.ambiguous.heading',
  'no-match': 'importAssetResolution.reason.noMatch.heading',
  'weak-match': 'importAssetResolution.reason.weakMatch.heading',
} as const

export function ImportAssetResolutionDialog(props: { app: AppState }) {
  const message = useAppMessage()
  let decisionEl: HTMLDivElement | undefined
  useAssetDecisionViewport(() => decisionEl)
  const request = useSignal(props.app.importAssetResolution)
  const [selected, setSelected] = createSignal<ReadonlyMap<string, AssetGuessCandidate>>(new Map())
  createEffect(() => {
    const initial = new Map<string, AssetGuessCandidate>()
    for (const match of request()?.matches ?? []) {
      const top = match.candidates[0]
      if (top && assetGuessCandidateToRef(top) && (top.confidence === 'path' || top.confidence === 'name')) initial.set(match.query, top)
    }
    setSelected(initial)
  })
  const cancel = () => request()?.cancel()
  const choose = (query: string, candidate?: AssetGuessCandidate) => {
    const next = new Map(selected())
    if (candidate) next.set(query, candidate); else next.delete(query)
    setSelected(next)
  }
  const unresolvedCount = () => (request()?.matches.length ?? 0) - selected().size
  const selectionStatus = () => message('importAssetResolution.selectionStatus', { selected: selected().size, unresolved: unresolvedCount() })
  return <Show when={request()}><ModalSurface
    title={message('importAssetResolution.title')}
    ariaLabel={message('importAssetResolution.ariaLabel')}
    describedBy="import-asset-resolution-intro"
    modalId="import-asset-resolution"
    testId="import-asset-resolution-dialog"
    onRequestClose={cancel}
  >
    <div ref={decisionEl} class="asset-decision import-asset-resolution-dialog">
      <section class="asset-decision-intro">
        <span class="asset-decision-eyebrow">{message('importAssetResolution.eyebrow')}</span>
        <p id="import-asset-resolution-intro">{message('importAssetResolution.intro')}</p>
        <dl class="asset-decision-summary" aria-label={message('importAssetResolution.summary')}>
          <div><dt>{message('importAssetResolution.summary.needsReview')}</dt><dd data-testid="import-assets-review-count">{request()?.matches.length ?? 0}</dd></div>
          <div><dt>{message('importAssetResolution.summary.selected')}</dt><dd data-testid="import-assets-selected-count">{selected().size}</dd></div>
          <div><dt>{message('importAssetResolution.summary.unresolved')}</dt><dd data-testid="import-assets-unresolved-count">{unresolvedCount()}</dd></div>
        </dl>
      </section>
      <ProductNotice tone="info" class="asset-decision-notice">{message('importAssetResolution.notice')}</ProductNotice>
      <div class="asset-decision-list import-asset-list" tabindex="0" aria-label={message('importAssetResolution.listAriaLabel')}>
        <For each={request()?.matches ?? []}>{(match, rowIndex) => {
          const reason = () => request()?.reasons[match.query] ?? 'no-match'
          const reasonId = `import-asset-reason-${rowIndex()}`
          return <fieldset class="import-asset-row" data-testid="import-asset-row" role="radiogroup" aria-describedby={reasonId}>
            <legend><span>{message('importAssetResolution.originalValue')}</span><code>{match.query}</code></legend>
            <div class="import-asset-reason" data-tone={reason() === 'no-match' || reason() === 'digest-conflict' ? 'danger' : 'warning'}>
              <strong>{message(reasonHeadingKey[reason()])}</strong>
              <span id={reasonId} data-testid="import-asset-reason">{message(reasonLabelKey[reason()])}</span>
            </div>
            <ProductRadio class="asset-decision-option import-asset-unresolved" checked={!selected().has(match.query)} onSelect={() => choose(match.query)} ariaLabel={message('importAssetResolution.leaveUnresolved.title')}>
              <span class="asset-decision-option-copy"><strong>{message('importAssetResolution.leaveUnresolved.title')}</strong><small>{message('importAssetResolution.leaveUnresolved.detail')}</small></span>
            </ProductRadio>
            <Show when={match.candidates.length === 0}><div class="import-asset-empty" data-testid="import-asset-empty"><strong>{message('importAssetResolution.noCandidates.title')}</strong><span>{message('importAssetResolution.noCandidates.detail')}</span></div></Show>
            <For each={match.candidates}>{(candidate) => {
              const complete = assetGuessCandidateToRef(candidate) !== undefined
              return <ProductRadio
                class="asset-decision-option import-asset-candidate"
                disabled={!complete}
                checked={selected().get(match.query) === candidate}
                onSelect={() => choose(match.query, candidate)}
              >
                <span class="asset-decision-option-copy">
                  <span class="asset-decision-option-heading"><strong>{candidate.name}</strong><span class="asset-decision-confidence" data-confidence={candidate.confidence}>{message(tierLabelKey(candidate.confidence))}</span></span>
                  <span class="asset-decision-tags">
                    <span class="asset-decision-availability" data-held={candidate.held ? 'true' : 'false'}>{message(candidate.held ? 'importAssetResolution.availability.local' : 'importAssetResolution.availability.notHeld')}</span>
                    <Show when={candidate.kind}><span>{candidate.kind}</span></Show>
                    <Show when={candidate.mountId}><span>{message('importAssetResolution.mount', { id: candidate.mountId! })}</span></Show>
                    <Show when={candidate.size !== undefined}><span>{formatByteSize(candidate.size!)}</span></Show>
                  </span>
                  <span class="asset-decision-fact asset-decision-digest"><span>{message('importAssetResolution.fact.digest')}</span><code>{candidate.digest}</code></span>
                  <span class="asset-decision-fact"><span>{message('importAssetResolution.fact.path')}</span><code>{candidate.virtualPath ?? message('importAssetResolution.fact.notProvided')}</code></span>
                  <Show when={candidate.mediaType}><span class="asset-decision-fact"><span>{message('importAssetResolution.fact.mediaType')}</span><code>{candidate.mediaType}</code></span></Show>
                  <Show when={!candidate.held && candidate.declaredBy?.length}><small>{message('importAssetResolution.declaredBy', { packs: candidate.declaredBy!.join(', ') })}</small></Show>
                  <Show when={!complete}><small class="asset-decision-warning">{message('importAssetResolution.warning.incomplete')}</small></Show>
                  <Show when={candidate.confidence === 'stem'}><small class="asset-decision-warning">{message('importAssetResolution.warning.extension')}</small></Show>
                </span>
              </ProductRadio>
            }}</For>
          </fieldset>
        }}</For>
      </div>
      <ProductActionFooter status={<span role="status" aria-live="polite" data-testid="import-assets-selection-status">{selectionStatus()}</span>}>
        <button type="button" data-testid="import-assets-cancel" onClick={cancel}>{message('importAssetResolution.action.skip')}</button>
        <button type="button" class="primary" data-testid="import-assets-accept" onClick={() => request()?.accept(selected())}>{message('importAssetResolution.action.accept')}</button>
      </ProductActionFooter>
    </div>
  </ModalSurface></Show>
}
