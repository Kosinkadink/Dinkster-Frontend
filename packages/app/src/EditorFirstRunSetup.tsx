import { createResource, createSignal, Show } from 'solid-js'
import { SetupForm, type SetupStatus } from './SetupForm.js'
import { setupInProgress } from './setup-job.js'
import { readHomeStatus } from './shell-route.js'

/** Offer local setup only for a confirmed first run or a job already in progress. */
export function EditorFirstRunSetup(props: {
  readonly backendUrl: string
  readonly onStatusChange?: (status: SetupStatus | undefined) => void
}) {
  const [completed, setCompleted] = createSignal(false)
  const [firstRun] = createResource(() => props.backendUrl, async (backendUrl) => {
    const url = new URL(backendUrl || '/', location.href)
    if (url.origin !== location.origin || url.pathname.replace(/\/$/, '') !== '') return false
    try {
      const state = await readHomeStatus()
      if (state === undefined || state.open) return false
      const installations = await fetch('/supervisor/installations', { cache: 'no-store' })
      if (!installations.ok) return false
      const rows = await installations.json()
      if (!Array.isArray(rows.installations)) return false
      return rows.installations.length === 0 || await setupInProgress()
    } catch {
      return false
    }
  })
  const visible = () => !firstRun.loading && firstRun() === true && !completed()
  return <Show when={visible()}>
    <div class="editor-first-run-setup"><SetupForm surface="editor" onStatusChange={props.onStatusChange} onInstallation={() => setCompleted(true)} /></div>
  </Show>
}
