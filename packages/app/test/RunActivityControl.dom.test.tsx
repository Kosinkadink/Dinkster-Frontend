// @vitest-environment happy-dom

import { asConnectionId, asLineageId, asPromptId, type CompileArtifact } from '@dinkster/core'
import type { ExecutionState } from '@dinkster/client'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunActivityControl } from '../src/RunControls.js'

const job = (connection: string, prompt: string, lineage: string, status: ExecutionState['status']): ExecutionState => ({
  ref: { connection: asConnectionId(connection), prompt: asPromptId(prompt) },
  key: `${connection}:${prompt}`,
  artifact: { snapshot: { lineage: asLineageId(lineage) }, scope: { kind: 'full' }, prompt: {} } as unknown as CompileArtifact,
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
  queuedAt: 1,
})

const titles: Readonly<Record<string, string>> = { long: 'Long run', mixed: 'Mixed run' }

afterEach(() => document.body.replaceChildren())

describe('RunActivityControl', () => {
  it('cancels the one running job from its X, opens the list instead while two run, and is absent while nothing runs', () => {
    const cancel = vi.fn()
    const openList = vi.fn()
    const [executions, setExecutions] = createSignal<readonly ExecutionState[]>([
      job('local', 'waiting', 'mixed', 'queued'),
      job('local', 'working', 'long', 'running'),
    ])
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => (
      <RunActivityControl
        executions={executions()}
        title={(entry) => titles[entry.artifact!.snapshot.lineage]!}
        cancelling={new Set()}
        onCancel={cancel}
        onOpenList={openList}
      />
    ), root)

    expect(root.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('1 running, 1 queued')
    const x = () => root.querySelector<HTMLButtonElement>('[data-testid="cancel-execution"]')!
    expect(x().getAttribute('aria-label')).toBe('Cancel Long run')
    x().click()
    expect(cancel).toHaveBeenCalledOnce()
    expect(cancel.mock.calls[0]![0].ref.prompt).toBe('working')
    expect(openList).not.toHaveBeenCalled()

    setExecutions([job('local', 'working', 'long', 'running'), job('second', 'elsewhere', 'mixed', 'running')])
    expect(x().getAttribute('aria-label')).toBe('Show running jobs')
    x().click()
    expect(openList).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()

    setExecutions([job('local', 'waiting', 'mixed', 'queued'), job('local', 'done', 'long', 'completed')])
    expect(root.querySelector('[data-testid="run-activity-control"]')).toBeNull()
    unmount()
  })
})
