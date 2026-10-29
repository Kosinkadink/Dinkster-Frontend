// @vitest-environment happy-dom

import { asConnectionId, asLineageId, asPromptId, type CompileArtifact } from '@dinkster/core'
import type { ExecutionState } from '@dinkster/client'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionActivityCard, executionBlockedSummary, executionExpandedSummary, executionNodeSummary, executionProgress, executionRegionIterationRows } from '../src/ExecutionActivityCard.js'

const entry = (over: Partial<ExecutionState> = {}): ExecutionState => ({
  ref: { connection: asConnectionId('backend-long-identity'), prompt: asPromptId('prompt-long-identity') },
  key: 'backend-long-identity:prompt-long-identity',
  artifact: {
    snapshot: { lineage: asLineageId('lineage-long-identity') },
    scope: { kind: 'partial' },
    prompt: {
      done: {},
      cached: {},
      active: {},
      failed: {},
    },
  } as unknown as CompileArtifact,
  status: 'running',
  nodes: {
    done: { state: 'done' },
    cached: { state: 'cached' },
    active: { state: 'running', value: 0.42 },
    failed: { state: 'error' },
  },
  regions: {},
  outputs: {},
  artifacts: [],
  artifactsHydrated: false,
  previews: {},
  activities: [],
  errors: [{ message: 'failed node' }],
  queuedAt: 1,
  ...over,
} as unknown as ExecutionState)

afterEach(() => document.body.replaceChildren())

describe('ExecutionActivityCard', () => {
  it('presents status, progress, partial scope, node facts, full identity, and overlay relation as text', () => {
    const current = entry()
    expect(executionProgress(current)).toEqual({ finished: 2, total: 4, value: 0.605 })
    expect(executionNodeSummary(current)).toBe('1 done, 1 cached, 1 failed')
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <ExecutionActivityCard entry={current} title="A workflow with a very long name" testId="activity" relation="pinned" />, root)

    expect(root.textContent).toContain('A workflow with a very long name')
    expect(root.textContent).toContain('prompt-long-identity')
    expect(root.textContent).toContain('Running')
    expect(root.textContent).toContain('Partial run')
    expect(root.textContent).toContain('1 done, 1 cached, 1 failed')
    expect(root.textContent).toContain('Workflow progress 61%')
    expect(root.textContent).toContain('1 error')
    expect(root.textContent).toContain('Pinned to canvas')
    expect(root.querySelector('progress')?.getAttribute('value')).toBe('0.605')
  })

  it('weights completed, cached, and concurrent active work without counting skipped nodes', () => {
    const current = entry({
      nodes: {
        done: { state: 'done' },
        cached: { state: 'cached' },
        skipped: { state: 'skipped' },
        active: { state: 'running', value: 0.25 },
        parallel: { state: 'running', value: 1.5 },
        invalid: { state: 'running', value: -0.5 },
      },
      artifact: {
        ...entry().artifact,
        prompt: Object.fromEntries(['done', 'cached', 'skipped', 'active', 'parallel', 'invalid'].map((id) => [id, {}])),
      } as unknown as CompileArtifact,
    })

    expect(executionProgress(current)).toEqual({ finished: 2, total: 6, value: 3.25 / 6 })
  })

  it('uses region expansion counts and stays indeterminate until out-of-order expansion arrives', () => {
    const artifact = {
      ...entry().artifact,
      prompt: {},
      dinksterGraph: {
        nodes: {
          root: { nodeType: 'Root', inputs: {} },
          region: {
            region: {
              kind: 'map',
              ports: {},
              inputs: {},
              body: { nodes: { body: { nodeType: 'Body', inputs: {} } } },
              outputs: {},
            },
          },
        },
      },
    } as unknown as CompileArtifact
    const nodes = {
      root: { state: 'cached' as const },
      'region[0]/body': { state: 'done' as const },
      'region[1]/body': { state: 'running' as const, value: 0.5 },
      'unknown-runtime-node': { state: 'done' as const },
    }

    expect(executionProgress(entry({ artifact, nodes, regions: {} }))).toBeUndefined()
    expect(executionProgress(entry({
      artifact,
      nodes,
      regions: { region: { kind: 'map', binding: 'zip', iterations: 2 } },
    }))).toEqual({ finished: 2, total: 3, value: 2.5 / 3 })

    const whileArtifact = {
      ...artifact,
      dinksterGraph: {
        nodes: {
          root: { nodeType: 'Root', inputs: {} },
          region: {
            region: {
              kind: 'while',
              ports: {},
              inputs: {},
              body: { nodes: { body: { nodeType: 'Body', inputs: {} } } },
              outputs: {},
            },
          },
        },
      },
    } as unknown as CompileArtifact
    expect(executionProgress(entry({
      artifact: whileArtifact,
      nodes,
      regions: { region: { kind: 'while', binding: 'zip', iterations: null } },
    }))).toBeUndefined()
    expect(executionProgress(entry({
      artifact: whileArtifact,
      nodes,
      regions: { region: { kind: 'while', binding: 'zip', iterations: null, finishedIterations: 2 } },
    }))).toEqual({ finished: 2, total: 3, value: 2.5 / 3 })
  })

  it('shows fixed loop placeholders and live per-item lifecycle states', () => {
    const current = entry({
      regions: {
        region: {
          kind: 'map', binding: 'zip', iterations: 3,
          iterationStates: { 0: 'completed', 1: 'running' },
        },
      },
    })
    expect(executionRegionIterationRows(current)).toEqual([
      { runtimeId: 'region', kind: 'map', iteration: 0, state: 'completed' },
      { runtimeId: 'region', kind: 'map', iteration: 1, state: 'running' },
      { runtimeId: 'region', kind: 'map', iteration: 2, state: 'waiting' },
    ])
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <ExecutionActivityCard entry={current} title="Loop workflow" testId="activity" />, root)
    expect([...root.querySelectorAll('.execution-region-iteration')].map((row) => row.textContent)).toEqual([
      'map region - item 1completed',
      'map region - item 2running',
      'map region - item 3waiting',
    ])
  })

  it('shows blocked messages and expanded child completion as activity facts', () => {
    const current = entry({
      nodes: {
        'parent.0.0.left': { state: 'done', parentRuntimeNodeId: 'parent', displayRuntimeNodeId: 'parent' },
        'parent.0.0.right': { state: 'running', parentRuntimeNodeId: 'parent', displayRuntimeNodeId: 'parent' },
      },
      blockedNodes: {
        'parent.0.0.child': { origin: 'source/value', message: 'source produced no value', displayRuntimeNodeId: 'parent' },
      },
      expandedNodes: {
        'parent.0.0.child': {
          children: ['parent.0.0.left', 'parent.0.0.right'], childCount: 2, displayRuntimeNodeId: 'parent',
        },
      },
    })
    expect(executionBlockedSummary(current)).toEqual(['source produced no value'])
    expect(executionExpandedSummary(current)).toEqual(['1/2 expanded children'])
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <ExecutionActivityCard entry={current} title="Semantics workflow" testId="activity" />, root)
    expect(root.querySelector('.execution-blocked')?.textContent).toBe('Blocked: source produced no value')
    expect(root.querySelector('.execution-expanded')?.textContent).toBe('1/2 expanded children')
  })

  it('keeps incomplete external executions truthful and disables frozen-view entry', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const external = entry({ status: 'queued' })
    delete (external as { artifact?: CompileArtifact }).artifact
    render(() => <ExecutionActivityCard entry={external} title="External workflow" testId="activity" />, root)

    expect(root.textContent).toContain('Queued')
    expect(root.textContent).toContain('Snapshot unavailable - submitted by another client')
    const open = root.querySelector<HTMLButtonElement>('.execution-open')!
    expect(open.disabled).toBe(true)
    expect(open.textContent).toBe('Snapshot unavailable')
  })

  it('shows agent attribution while leaving local human runs unchanged', () => {
    const agentRoot = document.createElement('div')
    const localRoot = document.createElement('div')
    const compactRoot = document.createElement('div')
    document.body.append(agentRoot, localRoot, compactRoot)

    render(() => <ExecutionActivityCard
      entry={entry({ submittedBy: { principalId: 'queue-agent', kind: 'agent' } })}
      title="Agent workflow"
      testId="agent-activity"
    />, agentRoot)
    render(() => <ExecutionActivityCard
      entry={entry({ submittedBy: { principalId: 'local', kind: 'human' } })}
      title="Local workflow"
      testId="local-activity"
    />, localRoot)
    render(() => <ExecutionActivityCard
      entry={entry({ submittedBy: { principalId: 'queue-agent', kind: 'agent' } })}
      title="Compact workflow"
      testId="compact-activity"
      compact
    />, compactRoot)

    expect(agentRoot.querySelector('.execution-attribution')?.textContent).toContain('queued by queue-agent')
    expect(agentRoot.querySelector('.execution-attribution .collab-agent')?.textContent).toBe('agent')
    expect(localRoot.querySelector('.execution-attribution')).toBeNull()
    expect(localRoot.textContent).not.toContain('queued by')
    expect(compactRoot.querySelector('.execution-attribution')).toBeNull()
    expect(compactRoot.querySelector('article')?.title).toBe('queued by queue-agent')
  })

  it('routes explicit open and pin or follow actions without making the whole card interactive', () => {
    const open = vi.fn()
    const pin = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const [relation, setRelation] = createSignal<'latest' | 'pinned'>('latest')
    render(() => <ExecutionActivityCard entry={entry({ status: 'completed' })} title="Workflow" testId="activity" relation={relation()} onOpen={open} onPin={pin} />, root)

    root.querySelector<HTMLButtonElement>('.execution-open')!.click()
    root.querySelector<HTMLButtonElement>('.execution-pin')!.click()
    expect(open).toHaveBeenCalledOnce()
    expect(pin).toHaveBeenCalledOnce()
    expect(root.querySelector('.execution-open')?.getAttribute('aria-label')).toBe('Open Workflow, execution prompt-long-identity, completed')
    expect(root.querySelector('.execution-pin')?.getAttribute('aria-label')).toBe('Pin this execution to the canvas')
    expect(root.querySelector('.execution-pin')?.getAttribute('aria-pressed')).toBe('false')
    expect(root.textContent).toContain('Following latest')
    setRelation('pinned')
    expect(root.querySelector('.execution-pin')?.getAttribute('aria-label')).toBe('Follow latest execution')
    expect(root.querySelector('.execution-pin')?.getAttribute('aria-pressed')).toBe('true')
    expect(root.querySelectorAll('button[title]')).toHaveLength(0)
  })
})
