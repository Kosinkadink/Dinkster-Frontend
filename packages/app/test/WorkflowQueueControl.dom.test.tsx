// @vitest-environment happy-dom

import { asConnectionId, asLineageId, asPromptId, type CompileArtifact, type ExecutionRef } from '@dinkster/core'
import type { ExecutionState } from '@dinkster/client'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowQueueControl, type WorkflowQueueOwner } from '../src/WorkflowQueueControl.js'

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

describe('WorkflowQueueControl', () => {
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
    expect(root.textContent).toContain('alpha-run')
    expect(root.textContent).not.toContain('beta-run')

    setActive(beta)
    setEntries([betaRun])
    expect(root.getAttribute('data-owner')).toBeNull()
    expect(root.querySelector('[data-testid="workflow-queue-control"]')?.getAttribute('data-owner')).toBe('beta')
    expect(root.textContent).toContain('beta-run')
    expect(root.textContent).not.toContain('alpha-run')
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
    expect(root.querySelector('[data-testid="workflow-queue-summary"]')?.textContent).toBe('No jobs')

    setEntries([execution(alpha, 'accepted-run', 'queued', 1)])
    expect(root.querySelector('[data-testid="workflow-queue-summary"]')?.textContent).toBe('1 queued')
    root.querySelector<HTMLButtonElement>('[data-testid="workflow-queue-toggle"]')!.click()
    const entry = root.querySelector<HTMLElement>('[data-testid="workflow-queue-entry"]')!
    expect(entry.tagName).toBe('ARTICLE')
    expect(entry.getAttribute('data-status')).toBe('queued')
    expect(entry.textContent).toContain('Queued')
    expect(entry.textContent).toContain('accepted-run')

    setEntries([execution(alpha, 'accepted-run', 'running', 1)])
    expect(root.querySelector('[data-testid="workflow-queue-summary"]')?.textContent).toBe('1 running')
    expect(root.querySelector('[data-testid="workflow-queue-entry"]')?.getAttribute('data-status')).toBe('running')
    expect(root.textContent).toContain('Running')
    unmount()
  })

  it('shows aggregate workflow progress beside the execution controls and updates from node events', () => {
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

    expect(root.querySelector('[data-testid="workflow-progress"]')?.textContent).toContain('Workflow 63%')
    expect(root.querySelector('[data-testid="workflow-progress"]')?.textContent).toContain('2 of 4 nodes')
    expect(root.querySelector('progress')?.getAttribute('value')).toBe('0.625')

    setEntries([{
      ...entries()[0]!,
      nodes: { ...entries()[0]!.nodes, c: { state: 'running', value: 0.75, max: 20 } },
    }])
    expect(root.querySelector('progress')?.getAttribute('value')).toBe('0.6875')
    unmount()
  })

  it('names both controls, supports keyboard disclosure, and restores toggle focus on Escape', async () => {
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
    expect(queue.getAttribute('aria-label')).toBe('Queue Alpha workflow')
    expect(toggle.getAttribute('aria-label')).toBe('Show queue for Alpha workflow')
    toggle.focus()
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    root.querySelector('[role="region"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
    unmount()
  })
})
