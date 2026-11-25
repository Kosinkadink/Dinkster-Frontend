import { createResource, createSignal, Show } from 'solid-js'
import { SetupForm } from './SetupForm.js'

/** Only a confirmed empty local supervisor can offer installation on this computer. */
export function EditorFirstRunSetup(props: { readonly backendUrl: string }) {
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
      return !state.open && Array.isArray(rows.installations) && rows.installations.length === 0
    } catch {
      return false
    }
  })
  return <Show when={!firstRun.loading && firstRun() === true && !completed()}>
    <div class="editor-first-run-setup"><SetupForm surface="editor" onInstallation={() => setCompleted(true)} /></div>
  </Show>
}
