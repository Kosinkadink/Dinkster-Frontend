import { createEffect, createMemo, createSignal, Show } from 'solid-js'
import type { AppLogEntry } from './app-state.js'
import { ActivityLog } from './ActivityLog.js'
import { ExecutionLogPanel, type ExecutionLogPanelProps } from './ExecutionLogPanel.js'
import { ProductButton } from './ProductControls.js'
import { ProductSelect } from './ProductSelect.js'
import { useAppMessage } from './locale.js'

export function LogPanel(props: ExecutionLogPanelProps & {
  readonly entries: () => readonly AppLogEntry[]
  readonly clearArmed: () => boolean
  readonly onClear: () => void
}) {
  const message = useAppMessage()
  const [scope, setScope] = createSignal(props.active() === undefined ? 'app' : 'run')
  const selectedKey = createMemo(() => props.active()?.key)
  createEffect(() => setScope(selectedKey() === undefined ? 'app' : 'run'))
  createEffect(() => {
    if (props.filterRequest?.() !== undefined) setScope('run')
  })

  return (
    <section class="combined-log" data-testid="log-panel">
      <div class="execution-log-controls">
        <ProductSelect
          testId="log-scope"
          ariaLabel={message('log.field.scope')}
          selectedId={scope()}
          options={[
            { id: 'run', label: message('log.scope.run'), value: 'run' },
            { id: 'app', label: message('log.scope.app'), value: 'app' },
          ]}
          onSelect={(option) => setScope(option.value)}
        />
        <Show when={scope() === 'app'}>
          <ProductButton size="compact" variant="ghost" data-testid="logs-clear" onClick={props.onClear}>
            {message('shell.action.clear')}
          </ProductButton>
        </Show>
      </div>
      <div class="combined-log-feed" hidden={scope() !== 'app'}>
        <ActivityLog entries={props.entries} clearArmed={props.clearArmed} />
      </div>
      <div class="combined-log-feed" hidden={scope() !== 'run'}>
        <ExecutionLogPanel {...props} />
      </div>
    </section>
  )
}
