import { createEffect, createMemo, createResource, createRoot, createSignal, For, onCleanup, Show, untrack, type JSX } from 'solid-js'
import { ProductButton, ProductDialog, ProductField, ProductModelDownloads, ProductRadio, ProductTextInput, type ProductModelDownloadRow } from '@dinkster/ui'
import type { AssetConsentRequest, ModelConsentState } from './dialog-requests.js'
import { formatByteSize } from './collections.js'
import { useAppMessage } from './locale.js'
import { ModelProvider } from './ModelProvider.js'
import { modelDownloadTotals } from './model-downloads.js'

const keyOf = (row: ModelConsentState): string => JSON.stringify([row.requirement.name, row.requirement.kind, row.requirement.asset?.digest])

function ModelSourceChoices(props: { readonly sources: readonly string[]; readonly name: string; readonly check: (source: string) => void }) {
  const message = useAppMessage()
  const [source, setSource] = createSignal('')
  return <div class="dinkster-model-download-source">
    <For each={props.sources}>{(url) => <ProductRadio name={props.name} label={url} checked={source() === url} onChange={() => setSource(url)} />}</For>
    <div class="dinkster-model-download-source-check">
      <ProductField label={message('modelDownloads.pasteSource')}>{(attributes) => <ProductTextInput id={attributes.id} type="url" value={source()} onInput={(event) => setSource(event.currentTarget.value)} />}</ProductField>
      <ProductButton disabled={!source()} onClick={() => props.check(source())}>{message('modelDownloads.check')}</ProductButton>
    </div>
  </div>
}

export function ModelDownloadsDialog(props: { readonly request: AssetConsentRequest; readonly onClose: () => void }) {
  const message = useAppMessage()
  const [settings] = createResource(() => props.request.fetchModelSettings, (fetch) => fetch().catch(() => undefined))
  const [unchecked, setUnchecked] = createSignal<ReadonlySet<string>>(new Set())
  const [sourceOpen, setSourceOpen] = createSignal<ReadonlySet<string>>(new Set())
  const [signInOpen, setSignInOpen] = createSignal<ReadonlySet<string>>(new Set())
  const panels = new Map<string, JSX.Element>()
  const disposePanels: (() => void)[] = []
  onCleanup(() => disposePanels.forEach((dispose) => dispose()))
  const models = () => props.request.models ?? []
  const kindLabel = (kind: string) => {
    const name = kind.replace(/^model\//, '')
    const canonical = ({ checkpoints: 'checkpoint', upscale_models: 'upscale', controlnets: 'controlnet', loras: 'lora' } as Record<string, string>)[name] ?? name
    const key = `storagePanel.kind.${canonical}`
    const label = message(key)
    return label === key ? canonical.replaceAll('_', ' ').replaceAll('-', ' ') : label
  }
  const indexOf = (key: string) => models().findIndex((row) => keyOf(row) === key)
  const review = (key: string) => { const index = indexOf(key); if (index >= 0) void props.request.reviewModel?.(index) }
  createEffect(() => {
    const rows = models()
    for (const [index, row] of rows.entries()) {
      if (!row.pending && !row.plan && !row.job && !row.error && !row.interrupted)
        untrack(() => { void props.request.reviewModel?.(index) })
    }
  })
  const refreshAccess = () => {
    for (const [index, row] of models().entries()) {
      if (row.plan?.status === 'provider-grant-required' || row.plan?.status === 'civitai-access-required')
        void props.request.reviewModel?.(index)
    }
  }
  window.addEventListener('focus', refreshAccess)
  onCleanup(() => window.removeEventListener('focus', refreshAccess))
  const details = (key: string): JSX.Element => {
    if (!panels.has(key)) panels.set(key, createRoot((dispose) => {
      disposePanels.push(dispose)
      return <>
      <Show when={sourceOpen().has(key)}><ModelSourceChoices name={key} sources={(() => {
        const plan = models()[indexOf(key)]?.plan
        return plan?.status === 'picker-required' ? plan.sources : []
      })()} check={(source) => {
        props.request.selectModelSource?.(indexOf(key), source)
        review(key)
      }} /></Show>
      <Show when={signInOpen().has(key) && props.request.providerConnection}>{(connection) =>
        <ModelProvider connection={connection()} {...(props.request.providerBackendUrl === undefined ? {} : { backendUrl: props.request.providerBackendUrl })}
          onChanged={() => props.request.providerChanged?.()} />
      }</Show>
      </>
    }))
    return panels.get(key)
  }
  const rows = createMemo(() => models().map((row, index): ProductModelDownloadRow => {
    const key = keyOf(row)
    const plan = row.plan
    const job = row.job
    const selection = job ?? (plan?.status === 'consent-required' ? plan : undefined)
    const size = selection?.size ?? row.requirement.asset?.size
    const metadata = [kindLabel(row.requirement.kind), size !== undefined && formatByteSize(size),
      selection && `${selection.provider === 'huggingface' ? 'Hugging Face' : 'Civitai'}, ${selection.repo}`,
      job?.status === 'completed' && (job.reused ? message('modelDownloads.reused') : message('modelDownloads.saved', { folder: (job.path ?? job.destination).replace(/[\\/][^\\/]*$/, '') })),
    ].filter(Boolean).join(' - ')
    const base = { id: key, name: row.requirement.name, metadata }
    const action = (label: string, onClick: () => void) => ({ label: message(label), disabled: row.pending, onClick })
    const retry = action('modelDownloads.tryAgain', () => review(key))
    if (row.error || row.interrupted || job?.status === 'failed' || job?.status === 'cancelled') return {
      ...base, state: 'failed', reason: row.error ?? job?.error ?? message('modelDownloads.stopped'), action: retry,
    }
    if (job?.status === 'completed' || plan?.status === 'local') return { ...base, state: 'ready', readyLabel: message('modelDownloads.ready') }
    if (row.queued || (job && !['completed', 'failed', 'cancelled'].includes(job.status))) {
      const waiting = row.queued && !job
      const checking = job && !['starting', 'checking-existing', 'downloading', 'cancelling'].includes(job.status)
      return { ...base, state: waiting ? 'waiting' : checking ? 'checking' : 'downloading',
        progressLabel: message(waiting ? 'modelDownloads.waiting' : checking ? 'modelDownloads.checking' : 'modelDownloads.downloading',
          { received: formatByteSize(job?.received ?? 0), total: formatByteSize(job?.size ?? 0) }),
        ...(!waiting && !checking && job?.size ? { progress: job.received / job.size } : {}),
        ...(!checking ? { stop: action('modelDownloads.stop', () => { void props.request.cancelModel?.(index) }) } : {}),
      }
    }
    if (plan?.status === 'consent-required') return { ...base, state: 'available', selected: !unchecked().has(key),
      onSelect: (checked) => setUnchecked((current) => { const next = new Set(current); if (checked) next.delete(key); else next.add(key); return next }),
      detailsLabel: message('modelDownloads.details', { name: row.requirement.name }),
      facts: [
        { label: message('modelDownloads.from'), value: plan.source },
        { label: message('modelDownloads.version'), value: <span class="dinkster-mono">{plan.revision}</span> },
        { label: message('modelDownloads.license'), value: plan.license },
        { label: message('modelDownloads.savesTo'), value: plan.destination },
        { label: message('modelDownloads.checkedBy'), value: <span class="dinkster-mono">{plan.digest ?? plan.sha256}</span> },
      ],
    }
    if (!plan) return { ...base, state: 'checking', progressLabel: message('modelDownloads.lookingUp') }
    switch (plan.status) {
      case 'picker-required': return { ...base, state: 'needs', reason: message(plan.sources.length ? 'modelDownloads.multipleSources' : 'modelDownloads.noSource'),
        action: action('modelDownloads.chooseSource', () => setSourceOpen((current) => new Set(current).add(key))), details: details(key) }
      case 'destination-required': return { ...base, state: 'needs', reason: message('modelDownloads.noFolder'),
        action: action('modelDownloads.chooseFolder', () => props.request.locateModel?.(index)) }
      case 'duplicate': return { ...base, state: 'needs', reason: message('modelDownloads.duplicate'),
        action: action('modelDownloads.chooseOnNode', () => props.request.locateModel?.(index)) }
      case 'folder-disabled': return { ...base, state: 'needs', reason: (() => {
        const folder = settings()?.locations.find((location) => location.id === plan.disabledLocations[0])
        return folder ? message('modelDownloads.alreadyIn', { folder: folder.path }) : plan.detail
      })(),
        action: { ...action('modelDownloads.useFolder', () => { void props.request.enableModelLocation?.(index, plan.disabledLocations[0]!) }), disabled: row.pending || plan.disabledLocations.length === 0 } }
      case 'model-hidden': return { ...base, state: 'needs', reason: message('modelDownloads.hidden'),
        action: action('modelDownloads.show', () => { void props.request.showModel?.(index) }) }
      case 'credential-required': return { ...base, state: 'needs', reason: message('modelDownloads.notSignedIn'),
        action: action('modelDownloads.signIn', () => setSignInOpen((current) => new Set(current).add(key))), details: details(key) }
      case 'provider-grant-required':
      case 'civitai-access-required': {
        const host = plan.status === 'civitai-access-required' || plan.provider === 'civitai' ? 'Civitai' : 'Hugging Face'
        let source: URL | undefined
        try { source = new URL(plan.source ?? row.source ?? '') } catch { /* No provider page was reported. */ }
        const safe = source?.protocol === 'https:' && !source.username && !source.password && ['huggingface.co', 'www.huggingface.co', 'civitai.com', 'www.civitai.com'].includes(source.hostname)
        return { ...base, state: 'needs', reason: message('modelDownloads.noAccess', { host }),
          action: { label: message('modelDownloads.openHost', { host }), disabled: row.pending || !safe,
            onClick: () => { if (safe) window.open(source!.href, '_blank', 'noopener,noreferrer') } } }
      }
    }
  }))
  const selectable = () => rows().filter((row) => row.state === 'available')
  const selected = () => models().filter((row) => !unchecked().has(keyOf(row)) && selectable().some((entry) => entry.id === keyOf(row)))
  const allSelected = () => selectable().every((row) => row.selected)
  const totals = () => modelDownloadTotals(selected())
  const ready = () => models().length > 0 && models().every((row) => !row.pending && (row.plan?.status === 'local' || row.job?.status === 'completed'))
  const active = () => models().some((row) => row.queued || (row.job && !['completed', 'failed', 'cancelled'].includes(row.job.status)))
  const footer = () => active() ? message('modelDownloads.keepGoing') : totals().count ?
    message(totals().insufficient ? totals().freeBytes === undefined ? 'modelDownloads.insufficientUnknown' : 'modelDownloads.insufficient' : totals().freeBytes === undefined ? 'modelDownloads.total' : 'modelDownloads.totalFree', {
      size: formatByteSize(totals().bytes), free: formatByteSize(totals().freeBytes ?? 0),
    }) : rows().some((row) => row.state === 'needs') ? message('modelDownloads.nothing') : ''
  const remaining = () => rows().filter((row) => row.state !== 'ready').length
  const focusedRow = createMemo(() => props.request.focusedModel && models().every((row) =>
    !row.pending && (row.plan !== undefined || row.job !== undefined || row.error !== undefined))
    ? keyOf({ requirement: props.request.focusedModel, pending: false }) : undefined)
  return <ProductDialog title={message('modelDownloads.title')} onDismiss={props.onClose} size="wide">
    <ProductModelDownloads listLabel={message('modelDownloads.list')} summary={message(ready() ? 'modelDownloads.summaryReady' :
      rows().some((row) => row.state === 'needs' || row.state === 'failed') ?
        remaining() === 1 ? 'modelDownloads.summaryNeedsOne' : 'modelDownloads.summaryNeeds' :
        remaining() === 1 ? 'modelDownloads.summaryOne' : 'modelDownloads.summary',
    { name: props.request.workflowTitle ?? message('modelDownloads.workflow'), count: remaining() })}
      rows={rows()} footer={footer()} footerWarning={!active() && totals().insufficient} closeLabel={message('modelDownloads.close')} onClose={props.onClose}
      {...(focusedRow() === undefined ? {} : { focusedRow: focusedRow()! })}
      {...(selectable().length > 1 ? { selection: {
        label: message(allSelected() ? 'modelDownloads.selectNone' : 'modelDownloads.selectAll'),
        onClick: () => {
          const next = new Set(unchecked())
          const clear = allSelected()
          for (const row of selectable()) { if (clear) next.add(row.id); else next.delete(row.id) }
          setUnchecked(next)
        },
      } } : {})}
      {...(selectable().length ? { primary: { label: message(totals().count === 1 ? 'modelDownloads.downloadOne' : 'modelDownloads.download', { count: totals().count }),
        disabled: totals().count === 0 || totals().insufficient, onClick: () => { void props.request.downloadModels?.(models().flatMap((row, index) => selected().includes(row) ? [index] : [])) },
      } } : ready() && props.request.retry ? { primary: { label: message('modelDownloads.run'), onClick: () => { void props.request.retry?.([]) } } } : {})} />
  </ProductDialog>
}
