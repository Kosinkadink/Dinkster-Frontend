import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import {
  createPageLoad, ProductButton, ProductCodeBlock, ProductDialog, ProductDisclosure,
  ProductErrorBanner, ProductField, ProductNotice, ProductPageLoad, ProductSelect,
} from '@dinkster/ui'
import { RequestFailure, requestFailure, requestFetch } from '@dinkster/client'
import type { SetupJob } from '../setup-job.js'
import { setupJobActive } from '../setup-job.js'
import { failureMessage } from '../request-failure.js'
import { useAppMessage } from '../locale.js'

const fetchRequest = requestFetch((url, init) => fetch(url, init))

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    const response = await fetchRequest(`/supervisor/${path}`, { ...init, cache: 'no-store' })
    if (!response.ok) throw await requestFailure(response)
    return await response.json()
  } catch (failure) {
    throw new Error(failureMessage(failure), { cause: failure })
  }
}

/** The page observes process-owned work independently of the selected detail or review. */
export function createInstallationJobs(onTerminal: (job: SetupJob) => void) {
  const message = useAppMessage()
  const page = createPageLoad<SetupJob | null>()
  const [changing, setChanging] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [unresolved, setUnresolved] = createSignal(false)
  let disposed = false
  let observed = false
  let discoveryAttempts = 0
  let previousId: string | undefined
  const reconciled = new Set<string>()
  const read = async () => {
    const tracked = page.value()
    if (setupJobActive(tracked)) {
      try {
        return await request<SetupJob>(`installations/jobs/${encodeURIComponent(tracked!.id)}`)
      } catch (failure) {
        const cause = (failure as Error).cause
        if (!(cause instanceof RequestFailure) || cause.status !== 404) throw failure
        // The supervisor's process-owned registry can disappear on restart.
        setError((failure as Error).message)
      }
    }
    if (unresolved()) discoveryAttempts--
    const { activeJob } = await request<{ activeJob: SetupJob | null }>('setup/active')
    if (unresolved()) {
      if (activeJob && activeJob.id !== previousId) { setUnresolved(false); discoveryAttempts = 0 }
      else if (discoveryAttempts <= 0) throw new Error(message('installations.restore.unresolved'))
    }
    return setupJobActive(activeJob)
      ? request<SetupJob>(`installations/jobs/${encodeURIComponent(activeJob!.id)}`) : activeJob
  }
  const refresh = () => page.load(read)
  const blocked = () => changing() || unresolved() || page.pending() || Boolean(page.error()) || setupJobActive(page.value())
  async function start(planId: string): Promise<boolean> {
    if (blocked()) return false
    setChanging(true)
    setError(undefined)
    try {
      const job = await request<SetupJob>('installations/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId }),
      })
      if (!disposed) await page.load(async () => job)
      return true
    } catch (failure) {
      // Discover an ambiguous start; repeating POST would reuse unreviewed authority.
      if (!disposed) {
        const cause = (failure as Error).cause
        if (!(cause instanceof RequestFailure) || cause.status === undefined || cause.status >= 500) {
          previousId = page.value()?.id
          discoveryAttempts = 8
          setUnresolved(true)
        }
        await refresh()
        setError((failure as Error).message)
      }
      return false
    } finally {
      if (!disposed) setChanging(false)
    }
  }
  async function cancel() {
    const job = page.value()
    if (changing() || job?.operation !== 'restore' || !setupJobActive(job) || job.state === 'cancelling') return
    setChanging(true)
    setError(undefined)
    try {
      const result = await request<SetupJob>(`installations/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' })
      if (!disposed) await page.load(async () => result)
    } catch (failure) {
      if (!disposed) { await refresh(); setError((failure as Error).message) }
    } finally {
      if (!disposed) setChanging(false)
    }
  }
  createEffect(() => {
    const job = page.value()
    if (job === undefined) return
    if (job?.operation === 'restore' && !setupJobActive(job) && !reconciled.has(job.id)) {
      reconciled.add(job.id)
      if (observed) onTerminal(job)
    }
    observed = true
    if ((!setupJobActive(job) && !(unresolved() && discoveryAttempts > 0)) || page.pending() || changing()) return
    const timer = setTimeout(() => { void refresh() }, 750)
    onCleanup(() => clearTimeout(timer))
  })
  onMount(() => {
    globalThis.addEventListener('focus', refresh)
    onCleanup(() => globalThis.removeEventListener('focus', refresh))
  })
  onCleanup(() => { disposed = true })
  void refresh()
  return { page, refresh, blocked, changing, error, dismissError: () => setError(undefined), start, cancel }
}

interface RestorePlan {
  readonly root: string
  readonly entry: number
  readonly exact: boolean
  readonly missing: readonly unknown[]
  readonly alternatives: readonly {
    readonly planId: string
    readonly snapshot: { readonly engine: { readonly version: string } }
    readonly substitutions: readonly { readonly field: string; readonly before: unknown; readonly after: unknown }[]
  }[]
}

export function InstallationRestore(props: {
  readonly root: string
  readonly entry: number
  readonly jobs: ReturnType<typeof createInstallationJobs>
  readonly onDismiss: () => void
}) {
  const message = useAppMessage()
  const page = createPageLoad<RestorePlan>()
  const [choice, setChoice] = createSignal('')
  const [invalid, setInvalid] = createSignal(false)
  const [dismissedJobRead, setDismissedJobRead] = createSignal<Error>()
  const read = async () => {
    setChoice('')
    setInvalid(false)
    const result = await request<{ plan: RestorePlan }>(`installations/restore?${new URLSearchParams({ root: props.root, entry: String(props.entry) })}`)
    return result.plan
  }
  const selected = () => page.value()?.alternatives.find((row) => row.planId === choice())
  const apply = async () => {
    const alternative = selected()
    if (!alternative || invalid() || page.pending() || page.error() || props.jobs.blocked()) return
    if (await props.jobs.start(alternative.planId)) props.onDismiss()
    else setInvalid(true)
  }
  void page.load(read)
  return <ProductDialog title={message('installations.restore.title')} pending={props.jobs.changing()} onDismiss={props.onDismiss}
    action={<ProductButton fill="solid" disabled={!selected() || invalid() || page.pending() || Boolean(page.error()) || props.jobs.blocked()}
      onClick={() => { void apply() }}>{message('installations.restore.apply')}</ProductButton>}>
    <ProductNotice>{message('installations.restore.explanation', { root: props.root })}</ProductNotice>
    <Show when={props.jobs.error()}>{(error) => <ProductErrorBanner onDismiss={props.jobs.dismissError}>{error()}</ProductErrorBanner>}</Show>
    <Show when={props.jobs.page.error()}>{(error) => <>
      <Show when={error() !== dismissedJobRead()}><ProductErrorBanner onDismiss={() => setDismissedJobRead(error())}>{error().message}</ProductErrorBanner></Show>
      <ProductButton disabled={props.jobs.page.pending()} onClick={() => { void props.jobs.refresh() }}>{message('setup.retry')}</ProductButton>
    </>}</Show>
    <Show when={invalid()}><ProductNotice>{message('installations.restore.reviewAgain')}</ProductNotice>
      <ProductButton disabled={props.jobs.blocked()} onClick={() => { void page.load(read) }}>{message('installations.restore.review')}</ProductButton></Show>
    <ProductPageLoad page={page} read={read} loadingLabel={message('installations.restore.loading')}>
      {(plan) => <>
        <ProductNotice>{message(plan.exact ? 'installations.restore.exact' : 'installations.restore.changed')}</ProductNotice>
        <Show when={plan.missing.length}><ProductDisclosure title={message('installations.restore.missing')}>
          <ProductCodeBlock value={JSON.stringify(plan.missing, null, 2)} />
        </ProductDisclosure></Show>
        <Show when={plan.alternatives.length} fallback={<ProductNotice>{message('installations.restore.unavailable')}</ProductNotice>}>
          <ProductField label={message('installations.restore.alternative')}>{(attributes) => <ProductSelect {...attributes} value={choice()}
            disabled={props.jobs.changing() || invalid() || page.pending()} onChange={setChoice}
            options={[{ value: '', label: message('installations.restore.choose') }, ...plan.alternatives.map((row, index) => ({
              value: row.planId, label: message('installations.restore.option', { number: index + 1, version: row.snapshot.engine.version }),
            }))]} />}</ProductField>
          <Show when={selected()}>{(alternative) => <For each={alternative().substitutions}>{(change) =>
            <ProductDisclosure title={change.field}><ProductCodeBlock label={message('installations.restore.before')} value={JSON.stringify(change.before, null, 2) ?? 'null'} />
              <ProductCodeBlock label={message('installations.restore.after')} value={JSON.stringify(change.after, null, 2) ?? 'null'} /></ProductDisclosure>
          }</For>}</Show>
        </Show>
      </>}
    </ProductPageLoad>
  </ProductDialog>
}
