import { createEffect, createResource, createSignal, onCleanup, Show } from 'solid-js'
import { SetupForm } from './SetupForm.js'
import { setupInProgress } from './setup-job.js'

/** Offer local setup only for a confirmed first run or a job already in progress. */
export function EditorFirstRunSetup(props: {
  readonly backendUrl: string
  readonly onVisibilityChange?: (visible: boolean) => void
}) {
  const [completed, setCompleted] = createSignal(false)
  const [firstRun] = createResource(() => props.backendUrl, async (backendUrl) => {
    const url = new URL(backendUrl || '/', location.href)
    if (url.origin !== location.origin || url.pathname.replace(/\/$/, '') !== '') return false
    try {
      const [status, installations] = await Promise.all([
        fetch('/supervisor/status', { cache: 'no-store' }),
        fetch('/supervisor/installations', { cache: 'no-store' }),
      ])
      if (!status.ok || !installations.ok) return false
      const state = await status.json()
      const rows = await installations.json()
      if (state.open || !Array.isArray(rows.installations)) return false
      return rows.installations.length === 0 || await setupInProgress()
    } catch {
      return false
    }
  })
  const visible = () => !firstRun.loading && firstRun() === true && !completed()
  createEffect(() => {
    props.onVisibilityChange?.(visible())
    onCleanup(() => props.onVisibilityChange?.(false))
  })
  return <Show when={visible()}>
    <div class="editor-first-run-setup"><SetupForm surface="editor" onInstallation={() => setCompleted(true)} /></div>
  </Show>
}
