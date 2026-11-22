import type { ExecutionState } from '@dinkster/client'

/** Active work only; completed history never contributes to the queue count. */
export function executionActivity(executions: Iterable<ExecutionState>): {
  readonly running: number
  readonly waiting: number
} {
  let running = 0
  let waiting = 0
  for (const execution of executions) {
    if (execution.status === 'running') running += 1
    else if (execution.status === 'queued') waiting += 1
  }
  return { running, waiting }
}
