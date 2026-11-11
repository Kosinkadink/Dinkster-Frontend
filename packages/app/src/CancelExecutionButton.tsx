import { Show } from 'solid-js'
import { executionKey } from '@dinkster/core'
import type { ExecutionState } from '@dinkster/client'
import type { AppState } from './app-state.js'
import { ProductButton } from './ProductControls.js'
import { useAppMessage } from './locale.js'
import { useSignal } from './solid-adapter.js'

function canCancelExecution(execution: ExecutionState | undefined): boolean {
  return execution?.status === 'running' || execution?.status === 'queued'
}

export function CancelExecutionButton(props: {
  readonly app: AppState
  readonly execution: ExecutionState | undefined
}) {
  const message = useAppMessage()
  const pending = useSignal(props.app.cancellingExecutions)
  const cancelling = () => props.execution !== undefined && pending().has(executionKey(props.execution.ref))
  return <Show when={canCancelExecution(props.execution)}>
    <ProductButton
      type="button"
      variant="danger"
      size="compact"
      data-testid="cancel-execution"
      aria-label={message('execution.cancel.action')}
      loading={cancelling()}
      onClick={() => { if (props.execution) void props.app.cancelExecution(props.execution.ref) }}
    >{message(cancelling() ? 'execution.cancel.pending' : 'execution.cancel.action')}</ProductButton>
  </Show>
}
