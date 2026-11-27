// @vitest-environment happy-dom

import { asConnectionId, asLineageId, asPromptId, type CompileArtifact, type ExecutionRef } from '@dinkster/core'
import type { ExecutionState, SupervisorStatus } from '@dinkster/client'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowQueueControl, type WorkflowQueueOwner } from '../src/WorkflowQueueControl.js'
import { executionActivity } from '../src/execution-activity.js'
import { EngineRunControl } from '../src/EngineRunControl.js'

const connection = asConnectionId('local')

const owner = (id: string, title: string): WorkflowQueueOwner => ({
  id,
  title,
  lineage: asLineageId(`lineage-${id}`),
})

const execution = (
  runOwner: WorkflowQueueOwner,
  prompt: string,
  status: ExecutionState['status'],
  queuedAt: number,
): ExecutionState => {
  const ref: ExecutionRef = { connection, prompt: asPromptId(prompt) }
  return {
    ref,
    key: `${connection}:${prompt}`,
    artifact: {
      snapshot: { lineage: runOwner.lineage },
      scope: { kind: 'full' },
      prompt: {},
    } as unknown as CompileArtifact,
    status,
    nodes: {},
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
  }
}

afterEach(() => document.body.replaceChildren())

/** The job ids the open list names, through each row's snowflake. */
const listedJobs = (root: HTMLElement): string =>
  [...root.querySelectorAll('.execution-open')].map((button) => button.getAttribute('aria-label')).join(' ')

describe('WorkflowQueueControl', () => {
  it('replaces Run through engine transitions and hides failed lists without removing running progress', () => {
    const alpha = owner('alpha', 'Alpha workflow')
    const [status, setStatus] = createSignal<SupervisorStatus>({ protocol: 1, state: 'ready' })
    const root = document.createElement('div')
    document.body.append(root)
    const entry = execution(alpha, 'alpha-run', 'running', 1)
    const running = { ...entry, artifact: { ...entry.artifact!, prompt: { a: { class_type: 'Test', inputs: {} } } } }
    const unmount = render(() => <WorkflowQueueControl owner={alpha}
      executions={[running]}
      canQueue={status().state === 'ready'} onQueue={() => undefined} onCancel={() => undefined}
      onOpenExecution={() => undefined} hideRunList={status().state === 'failed'}
      runControl={(runButton) => <EngineRunControl status={status()} baseUrl="" onRestart={async () => undefined}>
        {runButton}
      </EngineRunControl>} />, root)
    expect(root.querySelector('[data-testid="queue-button"]')).not.toBeNull()
    for (const state of ['stopped', 'starting'] as const) {
      setStatus({ protocol: 1, state })
      expect(root.querySelector('[data-testid="queue-button"]')).toBeNull()
      expect(root.textContent).toContain(state === 'stopped' ? 'Start engine' : 'Starting engine')
      expect(root.querySelector('[data-testid="workflow-queue-toggle"]')).not.toBeNull()
    }
    root.querySelector<HTMLButtonElement>('[data-testid="workflow-queue-toggle"]')!.click()
    expect(root.querySelector('[role="region"]')).not.toBeNull()
    setStatus({ protocol: 1, state: 'failed' })
    expect(root.textContent).toContain('Engine failed')
    expect(root.querySelector('[data-testid="workflow-queue-toggle"]')).toBeNull()
    expect(root.querySelector('[data-testid="workflow-cancel"]')).toBeNull()
    expect(root.querySelector('[role="region"]')).toBeNull()
    expect(root.querySelector('[data-testid="workflow-progress"]')).not.toBeNull()
    setStatus({ protocol: 1, state: 'ready' })
    expect(root.querySelector('[data-testid="queue-button"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="workflow-queue-toggle"]')).not.toBeNull()
    expect(root.querySelector('[role="region"]')).toBeNull()
    unmount()
  })

  it('counts concurrent running and waiting jobs separately across workflow scopes', () => {
    const alpha = owner('alpha', 'Alpha workflow')
    const beta = owner('beta', 'Beta workflow')
    const alphaEntries = [
      execution(alpha, 'a1', 'running', 1),
      execution(alpha, 'a2', 'running', 2),
      execution(alpha, 'a3', 'queued', 3),
      execution(alpha, 'a4', 'completed', 4),
      execution(alpha, 'a5', 'error', 5),
    ]
    const betaEntries = [
      execution(beta, 'b1', 'running', 6),
      execution(beta, 'b2', 'queued', 7),
      execution(beta, 'b3', 'queued', 8),
    ]
    expect(executionActivity(alphaEntries)).toEqual({ running: 2, waiting: 1 })
    expect(executionActivity(betaEntries)).toEqual({ running: 1, waiting: 2 })
    expect(executionActivity(new Set([...alphaEntries, ...betaEntries])))
      .toEqual({ running: 3, waiting: 3 })
    expect(executionActivity([])).toEqual({ running: 0, waiting: 0 })
  })

  it('switches the visible queue atomically with its workflow owner and never shows another tab entries', () => {
    const alpha = owner('alpha', 'Alpha workflow')
    const beta = owner('beta', 'Beta workflow')
    const alphaRun = execution(alpha, 'alpha-run', 'running', 2)
    const betaRun = execution(beta, 'beta-run', 'queued', 1)
    const [active, setActive] = createSignal(alpha)
    const [entries, setEntries] = createSignal<readonly ExecutionState[]>([alphaRun])
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => (
      <WorkflowQueueControl
        owner={active()}
        executions={entries()}
        canQueue={true}
        onQueue={() => {}}
        onOpenExecution={() => {}}
      />
    ), root)

    root.querySelector<HTMLButtonElement>('[data-testid="workflow-queue-toggle"]')!.click()
    expect(listedJobs(root)).toContain('alpha-run')
    expect(listedJobs(root)).not.toContain('beta-run')

    setActive(beta)
    setEntries([betaRun])
    expect(root.getAttribute('data-owner')).toBeNull()
    expect(root.querySelector('[data-testid="workflow-queue-control"]')?.getAttribute('data-owner')).toBe('beta')
    expect(listedJobs(root)).toContain('beta-run')
    expect(listedJobs(root)).not.toContain('alpha-run')
    unmount()
  })

  it('renders only backend-confirmed execution states and does not fabricate an optimistic queued row', () => {
    const alpha = owner('alpha', 'Alpha workflow')
    const [entries, setEntries] = createSignal<readonly ExecutionState[]>([])
    const queue = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => (
      <WorkflowQueueControl
        owner={alpha}
        executions={entries()}
        canQueue={true}
        onQueue={queue}
        onOpenExecution={() => {}}
      />
    ), root)

    root.querySelector<HTMLButtonElement>('[data-testid="queue-button"]')!.click()
    expect(queue).toHaveBeenCalledOnce()
    expect(root.querySelector('[data-testid="workflow-queue-summary"]')?.textContent).toBe('No active jobs')

    setEntries([execution(alpha, 'accepted-run', 'queued', 1)])
    expect(root.querySelector('[data-testid="workflow-queue-summary"]')?.textContent).toBe('1 queued')
    expect(root.querySelector('[data-testid="workflow-queue-toggle"] [role="img"]')?.textContent).toBe('1')
    root.querySelector<HTMLButtonElement>('[data-testid="workflow-queue-toggle"]')!.click()
    const entry = root.querySelector<HTMLElement>('[data-testid="workflow-queue-entry"]')!
    expect(entry.tagName).toBe('ARTICLE')
    expect(entry.getAttribute('data-status')).toBe('queued')
    expect(entry.textContent).toContain('Queued')
    expect(listedJobs(entry)).toContain('accepted-run')

    setEntries([execution(alpha, 'accepted-run', 'running', 1)])
    expect(root.querySelector('[data-testid="workflow-queue-summary"]')?.textContent).toBe('1 running')
    expect(root.querySelector('[data-testid="workflow-queue-toggle"] [role="img"]')?.textContent).toBe('1')
    expect(root.querySelector('[data-testid="workflow-queue-entry"]')?.getAttribute('data-status')).toBe('running')
    expect(root.textContent).toContain('Running')

    setEntries([
      execution(alpha, 'accepted-run', 'running', 1),
      execution(alpha, 'parallel-run', 'running', 6),
      execution(alpha, 'parallel-run-two', 'running', 7),
      execution(alpha, 'waiting-one', 'queued', 2),
      execution(alpha, 'waiting-two', 'queued', 3),
      execution(alpha, 'finished', 'completed', 4),
      execution(alpha, 'failed', 'error', 5),
    ])
    const toggle = root.querySelector<HTMLButtonElement>('[data-testid="workflow-queue-toggle"]')!
    expect(toggle.getAttribute('aria-label')).toBe('3 running, 2 queued: Hide runs for Alpha workflow')
    expect(toggle.getAttribute('data-running')).toBe('true')
    expect(toggle.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('3 running, 2 queued')
    expect(toggle.querySelector('[role="img"]')?.textContent).toBe('32')

    setEntries([execution(alpha, 'finished', 'completed', 4)])
    expect(toggle.getAttribute('data-running')).toBe('false')
    expect(toggle.querySelector('span[aria-hidden]')).toBeNull()
    expect(toggle.getAttribute('aria-label')).toBe('No active jobs: Hide runs for Alpha workflow')
    unmount()
  })

  it('draws the workflow progress and the running node\'s own progress as two lines along the bottom edge of the Run bar, updated from node events', () => {
    const alpha = owner('alpha', 'Alpha workflow')
    const running = execution(alpha, 'accepted-run', 'running', 1)
    const artifact = {
      ...running.artifact,
      prompt: Object.fromEntries(['a', 'b', 'c', 'd'].map((id) => [id, {}])),
    } as unknown as CompileArtifact
    const [entries, setEntries] = createSignal<readonly ExecutionState[]>([{
      ...running,
      artifact,
      nodes: {
        a: { state: 'done' },
        b: { state: 'cached' },
        c: { state: 'running', value: 0.5, max: 20 },
      },
    }])
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => (
      <WorkflowQueueControl
        owner={alpha}
        executions={entries()}
        canQueue={true}
        onQueue={() => {}}
        onOpenExecution={() => {}}
      />
    ), root)

    const line = root.querySelector('.workflow-queue-buttons [data-testid="workflow-progress"]')!
    expect(line.tagName).toBe('PROGRESS')
    expect(line.getAttribute('aria-valuetext')).toBe('63%, 2 of 4 nodes')
    expect(line.getAttribute('value')).toBe('0.625')
    const node = () => root.querySelector('.workflow-queue-buttons [data-testid="workflow-progress-node"]')!
    expect(node().tagName).toBe('PROGRESS')
    expect(node().getAttribute('value')).toBe('0.5')
    expect(node().hasAttribute('aria-hidden')).toBe(false)
    expect(root.textContent).not.toContain('of 4 nodes')

    setEntries([{
      ...entries()[0]!,
      nodes: { ...entries()[0]!.nodes, c: { state: 'running', value: 0.75, max: 20 } },
    }])
    expect(root.querySelector('[data-testid="workflow-progress"]')?.getAttribute('value')).toBe('0.6875')
    expect(node().getAttribute('value')).toBe('0.75')

    // A running node that reports no progress of its own leaves its line empty.
    setEntries([{ ...entries()[0]!, nodes: { ...entries()[0]!.nodes, c: { state: 'done' }, d: { state: 'running' } } }])
    expect(root.querySelector('[data-testid="workflow-progress"]')?.getAttribute('value')).toBe('0.75')
    expect(node().getAttribute('value')).toBe('0')
    expect(node().getAttribute('aria-hidden')).toBe('true')
    unmount()
  })

  it('cancels this workflow\'s running job from the X after the count, and the count opens the list where each waiting job has its own X', () => {
    const alpha = owner('alpha', 'Alpha workflow')
    const cancel = vi.fn()
    const [entries, setEntries] = createSignal<readonly ExecutionState[]>([
      execution(alpha, 'second-waiting', 'queued', 3),
      execution(alpha, 'first-waiting', 'queued', 2),
      execution(alpha, 'working', 'running', 1),
    ])
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => (
      <WorkflowQueueControl
        owner={alpha}
        executions={entries()}
        canQueue={true}
        onQueue={() => {}}
        onOpenExecution={() => {}}
        onCancel={cancel}
      />
    ), root)

    const x = root.querySelector<HTMLButtonElement>('.workflow-queue-buttons [data-testid="workflow-cancel"]')!
    expect(x.getAttribute('aria-label')).toBe('Cancel Alpha workflow')
    x.click()
    expect(cancel).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'working' }))
    expect(root.querySelector('.workflow-queue-popover')).toBeNull()

    root.querySelector<HTMLButtonElement>('[data-testid="workflow-queue-toggle"]')!.click()
    const rows = [...root.querySelectorAll<HTMLElement>('[data-testid="workflow-queue-entry"]')]
    expect(rows.map((row) => row.querySelector('.run-row-detail')?.textContent)).toEqual([undefined, 'next', '2 in line'])
    expect(rows.map((row) => row.querySelector('.run-row-name')?.textContent)).toEqual(['Running', 'Queued', 'Queued'])
    rows[2]!.querySelector<HTMLButtonElement>('[data-testid="cancel-execution"]')!.click()
    expect(cancel).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'second-waiting' }))

    setEntries([execution(alpha, 'first-waiting', 'queued', 2)])
    expect(root.querySelector('[data-testid="workflow-cancel"]')).toBeNull()
    unmount()
  })

  it('names both controls, supports keyboard disclosure, drops the summary tooltip while the list is open, and restores toggle focus on Escape', async () => {
    const alpha = owner('alpha', 'Alpha workflow')
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => (
      <WorkflowQueueControl
        owner={alpha}
        executions={[execution(alpha, 'alpha-run', 'completed', 1)]}
        canQueue={true}
        onQueue={() => {}}
        onOpenExecution={() => {}}
      />
    ), root)
    const queue = root.querySelector<HTMLButtonElement>('[data-testid="queue-button"]')!
    const toggle = root.querySelector<HTMLButtonElement>('[data-testid="workflow-queue-toggle"]')!
    expect(queue.getAttribute('aria-label')).toBe('Run Alpha workflow')
    expect(toggle.getAttribute('aria-label')).toBe('No active jobs: Show runs for Alpha workflow')
    expect(toggle.dataset['tooltipLabel']).toBe('No active jobs')
    toggle.focus()
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.hasAttribute('data-tooltip-label')).toBe(false)
    root.querySelector('[role="region"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.dataset['tooltipLabel']).toBe('No active jobs')
    expect(document.activeElement).toBe(toggle)
    unmount()
  })
})
