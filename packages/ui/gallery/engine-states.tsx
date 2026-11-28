import { For, createSignal, type ComponentProps } from 'solid-js'
import type { LineageId } from '@dinkster/core'
import { EngineRunControl } from '../../app/src/EngineRunControl.js'
import { WorkflowQueueControl } from '../../app/src/WorkflowQueueControl.js'

const states = ['ready', 'starting', 'stopped', 'failed'] as const

function EngineStateExample(props: { readonly state: typeof states[number] }) {
  const [status, setStatus] = createSignal<ComponentProps<typeof EngineRunControl>['status']>({
    protocol: 1,
    state: props.state,
    ...(props.state === 'starting' ? { progress: { done: 5, total: 8 } } : {}),
    ...(props.state === 'failed' ? { detail: 'The engine exited before it was ready (exit code 1).' } : {}),
  })
  const owner = { id: `engine-${props.state}`, title: 'Workflow', lineage: 'gallery' as LineageId }
  return (
    <figure class="engine-state-gallery-example" data-testid={`engine-state-${props.state}`}>
      <figcaption>{props.state === 'ready' ? 'Ready' : props.state === 'starting' ? 'Starting' : props.state === 'stopped' ? 'Stopped' : 'Failed'}</figcaption>
      <div class="engine-state-gallery-stage">
          <WorkflowQueueControl owner={owner} executions={[]} canQueue={status().state === 'ready'}
            onQueue={() => undefined} onOpenExecution={() => undefined}
            hideRunList={status().state === 'failed'}
            runControl={(runButton) => <EngineRunControl status={status()} baseUrl="" onRestart={async () => {
              setStatus({ protocol: 1, state: 'starting', progress: { done: 0, total: 8 } })
            }}>{runButton()}</EngineRunControl>} />
      </div>
    </figure>
  )
}

export function EngineStatesGallery() {
  return <div class="engine-state-gallery" data-testid="engine-states-gallery">
    <For each={states}>{(state) => <EngineStateExample state={state} />}</For>
  </div>
}
