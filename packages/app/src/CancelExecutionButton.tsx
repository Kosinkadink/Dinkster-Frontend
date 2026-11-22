import { Show } from 'solid-js'
import { ProductWindowAction } from '@dinkster/ui'
import Square from 'lucide-solid/icons/square'
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
  readonly toolbar?: boolean
}) {
  const message = useAppMessage()
  const pending = useSignal(props.app.cancellingExecutions)
  const cancelling = () => {
    return props.execution !== undefined && pending().has(executionKey(props.execution.ref))
  }
  return (
    <Show when={canCancelExecution(props.execution)}>
      <Show when={props.toolbar} fallback={<ProductButton
        type="button"
        variant="danger"
        size="compact"
        data-testid="cancel-execution"
        aria-label={message('execution.cancel.action')}
        loading={cancelling()}
        onClick={() => { if (props.execution) void props.app.cancelExecution(props.execution.ref) }}
      >{message(cancelling() ? 'execution.cancel.pending' : 'execution.cancel.action')}</ProductButton>}>
        <ProductWindowAction
          label={message('execution.cancel.action')}
          icon={Square}
          intent="remove"
          pending={cancelling()}
          data-testid="cancel-execution"
          onClick={() => { if (props.execution) void props.app.cancelExecution(props.execution.ref) }}
        />
      </Show>
    </Show>
  )
}
