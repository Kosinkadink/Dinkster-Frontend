import { For, createSignal, onMount, type JSX } from 'solid-js'
import { asConnectionId, asLineageId, asPromptId, registerCatalog, type CompileArtifact } from '@dinkster/core'
import english from '../../app/src/locales/en.json'
import { RunActivityControl, RunRow, RunSection } from '../../app/src/RunControls.js'
import { WorkflowQueueControl } from '../../app/src/WorkflowQueueControl.js'
import { ProductSegmented } from '../src/index.js'

type ExecutionState = Parameters<typeof RunRow>[0]['entry']

const minute = 60_000
const now = Date.now()
const nodes = Array.from({ length: 10 }, (_, index) => `n${index}`)

/** A job of one workflow as the store holds it: 4 of its 10 nodes done and the fifth a fifth of the way through while it runs. */
function job(prompt: string, lineage: string, status: ExecutionState['status'], queuedAt: number, endedAt?: number): ExecutionState {
  return {
    ref: { connection: asConnectionId('local'), prompt: asPromptId(prompt) },
    key: `local:${prompt}`,
    artifact: {
      snapshot: { lineage: asLineageId(lineage) },
      scope: { kind: 'full' },
      prompt: Object.fromEntries(nodes.map((id) => [id, {}])),
    } as unknown as CompileArtifact,
    status,
    nodes: status === 'running'
      ? { n0: { state: 'done' }, n1: { state: 'done' }, n2: { state: 'cached' }, n3: { state: 'done' }, n4: { state: 'running', value: 0.2, max: 30 } }
      : {},
    blockedNodes: {},
    expandedNodes: {},
    regions: {},
    outputs: {},
    artifacts: [],
    artifactsHydrated: false,
    previews: {},
    activities: [],
    errors: [],
    logs: [],
    logsDropped: 0,
    queuedAt,
    ...(endedAt === undefined ? {} : { startedAt: endedAt - minute, endedAt }),
  }
}

const running = job('long-1', 'long', 'running', now - 3 * minute)
const queued = [job('long-2', 'long', 'queued', now - 2 * minute), job('long-3', 'long', 'queued', now - minute)]
const mixedQueued = job('mixed-2', 'mixed', 'queued', now - 30_000)
const finished = [job('long-0', 'long', 'completed', now - 10 * minute, now - 2 * minute), job('mixed-1', 'mixed', 'completed', now - 12 * minute, now - 9 * minute)]
const all = [running, ...queued, mixedQueued, ...finished]
const titles: Readonly<Record<string, string>> = { long: 'Long run', mixed: 'Mixed run' }
const workflowOf = (entry: ExecutionState): string => titles[entry.artifact?.snapshot.lineage ?? ''] ?? 'Workflow'
const nodeTitle = (): string => 'KSampler'

/** Stands in for the image a finished run made. */
const thumbnail = (entry: ExecutionState): JSX.Element => {
  const index = finished.indexOf(entry)
  return index < 0 ? undefined : <span class="dinkster-run-controls-picture" data-tone={index} />
}

function Example(props: { readonly id: string; readonly caption: string; readonly shape?: string; readonly children: JSX.Element }) {
  return (
    <figure class="dinkster-canvas-example" data-testid={`run-controls-${props.id}`}>
      <div class="dinkster-canvas-example-stage dinkster-run-controls-stage" data-shape={props.shape ?? 'bar'}>{props.children}</div>
      <figcaption class="dinkster-metadata">{props.caption}</figcaption>
    </figure>
  )
}

const topBars = [
  { id: 'top-one', caption: 'Top bar, one job running: the X cancels it and its tooltip names it.', executions: [running] },
  { id: 'top-queued', caption: 'Top bar, one running and two queued.', executions: [running, ...queued] },
  { id: 'top-two', caption: 'Top bar, two jobs running on two engines: the X opens the list.', executions: [running, { ...running, ref: { ...running.ref, connection: asConnectionId('second') }, key: 'second:long-1' }] },
] as const

const runBars = [
  { id: 'run-idle', caption: 'Nothing running: Run and the list button.', executions: [] },
  { id: 'run-running', caption: 'Running, 42%: the 2 px line along the bottom edge, the count, the X.', executions: [running] },
  { id: 'run-queued', caption: 'Running, two more queued.', executions: [running, ...queued] },
] as const

/** The run controls: the top bar's item, the Run bar, the list beside Run and the Runs panel's rows. */
export function RunControlsGallery() {
  registerCatalog('en', english)
  let root: HTMLDivElement | undefined
  const [scope, setScope] = createSignal('all')
  onMount(() => requestAnimationFrame(() => { if (root) root.dataset['ready'] = 'true' }))
  const row = (entry: ExecutionState, name: string, statusInNote: boolean, testId: string, selected?: boolean) => (
    <RunRow entry={entry} name={name} workflow={workflowOf(entry)} statusInNote={statusInNote} all={all}
      cancelling={false} onCancel={() => undefined} onOpen={() => undefined} testId={testId}
      nodeTitle={nodeTitle} thumbnail={thumbnail(entry)} selected={selected} />
  )
  return (
    <div ref={root} class="dinkster-canvas-examples" data-testid="run-controls-gallery">
      <For each={topBars}>{(example) => (
        <Example id={example.id} caption={example.caption}>
          <div class="dinkster-run-controls-topbar">
            <RunActivityControl executions={example.executions} title={workflowOf} cancelling={new Set()}
              onCancel={() => undefined} onOpenList={() => undefined} />
          </div>
        </Example>
      )}</For>
      <For each={runBars}>{(example) => (
        <Example id={example.id} caption={example.caption}>
          <div class="dinkster-canvas-chrome-toolbar" data-side="right">
            <WorkflowQueueControl
              owner={{ id: `gallery-${example.id}`, title: 'Long run', lineage: asLineageId('long') }}
              executions={example.executions}
              canQueue
              onQueue={() => undefined}
              onOpenExecution={() => undefined}
              onCancel={() => undefined}
              nodeTitle={nodeTitle}
            />
          </div>
        </Example>
      )}</For>
      <Example id="list" shape="list" caption="The list beside Run, for this workflow: rows named by their state.">
        <div class="workflow-queue-popover dinkster-run-controls-list">
          <header>Long run: 1 running, 2 queued</header>
          <div class="workflow-queue-list">
            <div class="run-section-rows" role="list" aria-label="Workflow jobs">
              {row(running, 'Running', false, 'run-controls-list-row')}
              <For each={queued}>{(entry) => row(entry, 'Queued', false, 'run-controls-list-row')}</For>
            </div>
            <RunSection title="Finished">{row(finished[0]!, 'Completed', false, 'run-controls-list-row')}</RunSection>
          </div>
        </div>
      </Example>
      <Example id="panel" shape="panel" caption="The Runs panel, all workflows: rows named by their workflow; the chosen finished run is shaded.">
        <div class="dinkster-run-controls-panel">
          <ProductSegmented label="Runs scope" value={scope()} onChange={setScope}
            options={[{ value: 'workflow', label: 'This workflow' }, { value: 'all', label: 'All workflows' }]} />
          <RunSection title="Running (1)">{row(running, 'Long run', true, 'run-controls-panel-row')}</RunSection>
          <RunSection title="Queued (3)">
            <For each={[...queued, mixedQueued]}>{(entry) => row(entry, workflowOf(entry), true, 'run-controls-panel-row')}</For>
          </RunSection>
          <RunSection title="Finished">
            <For each={finished}>{(entry, index) => row(entry, workflowOf(entry), true, 'run-controls-panel-row', index() === 0)}</For>
          </RunSection>
        </div>
      </Example>
    </div>
  )
}
