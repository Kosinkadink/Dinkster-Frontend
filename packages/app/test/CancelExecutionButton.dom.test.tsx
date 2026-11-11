import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import { asPromptId } from '@dinkster/core'
import { AppState } from '../src/app-state.js'
import { CancelExecutionButton } from '../src/CancelExecutionButton.js'
import { useSignal } from '../src/solid-adapter.js'

let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.restoreAllMocks() })

it.each(['queued', 'running', 'completed', 'error', 'interrupted', 'cancelled'] as const)(
  'offers cancellation only for a queued or running job, not %s', (status) => {
    const app = new AppState()
    const backend = app.backends.get()[0]!
    const ref = { connection: backend.id, prompt: asPromptId('job') }
    app.store.apply({ kind: 'started', execution: ref, timestamp: 1 })
    const root = document.createElement('div')
    document.body.append(root)
    dispose = render(() => <CancelExecutionButton app={app} execution={{ ...app.store.get(ref)!, status }} />, root)
    expect(root.querySelector('button') !== null).toBe(status === 'queued' || status === 'running')
  },
)

it.each(['completed', 'failed', 'cancelled', 'running', 'unavailable'] as const)(
  'reports the %s cancellation outcome and releases the pending control', async (outcome) => {
    const app = new AppState()
    const backend = app.backends.get()[0]!
    const ref = { connection: backend.id, prompt: asPromptId('job') }
    app.store.apply({ kind: 'started', execution: ref, timestamp: 1 })
    vi.spyOn(backend.connection, 'cancel').mockImplementation(async () => {
      if (outcome === 'unavailable') throw new Error('offline')
      return outcome
    })
    const root = document.createElement('div')
    document.body.append(root)
    dispose = render(() => {
      const executions = useSignal(app.store.executions)
      return <CancelExecutionButton app={app} execution={(executions(), app.store.get(ref))} />
    }, root)
    const button = root.querySelector('button')!
    expect(button.getAttribute('aria-label')).toBe('Cancel run')
    button.click()
    await vi.waitFor(() => expect(app.cancellingExecutions.get().size).toBe(0))
    expect(button.disabled).toBe(false)
    expect(app.transientStatus.get()).toContain(
      outcome === 'completed' || outcome === 'failed' ? 'already finished'
        : outcome === 'cancelled' ? 'Cancelled'
          : outcome === 'running' ? 'Cancellation requested' : 'Could not cancel',
    )
  },
)
