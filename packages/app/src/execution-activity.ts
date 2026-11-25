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

/** The clock time a frozen view names a run by: 24-hour hours and minutes, such as 14:02. */
export function runClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
}
