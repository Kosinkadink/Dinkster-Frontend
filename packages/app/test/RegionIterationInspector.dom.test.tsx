import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DinksterValuesClient, ExecutionState, ValuePeekOptions, ValuePeekResult, ValueQuery } from '@dinkster/client'
import { asGraphDefId, asLineageId, asNodeId, registerCatalog, setLocale, type CompileArtifact, type WorkflowDocument } from '@dinkster/core'
import { RegionIterationInspector } from '../src/RegionIterationInspector.js'

let root: HTMLDivElement
let dispose: (() => void) | undefined
beforeEach(() => {
  setLocale('en')
  root = document.createElement('div')
  document.body.append(root)
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  root.remove()
  setLocale('en')
})

const workflow: WorkflowDocument = {
  format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('lineage'), root: asGraphDefId('root'),
  graphs: {
    root: {
      id: asGraphDefId('root'), name: 'Root', links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      nodes: { outer: { id: asNodeId('outer'), type: '#body', values: {}, region: { kind: 'map', elementPorts: [] } } },
    },
    body: {
      id: asGraphDefId('body'), name: 'Body', links: {}, nets: {}, reroutes: {}, nextOrdinal: 3,
      nodes: {
        source: { id: asNodeId('source'), type: 'Source', title: 'Renamed source', values: {} },
        sink: { id: asNodeId('sink'), type: 'Sink', values: {} },
      },
    },
  },
  view: { graphs: {} },
} as WorkflowDocument

const execution: ExecutionState = {
  ref: { connection: 'backend', prompt: 'job-7' }, key: 'backend:job-7', status: 'completed',
  artifact: {
    connection: 'backend', prompt: {
      'outer.source': { class_type: 'Source', inputs: {}, outputIds: ['value'] },
      'outer.sink': { class_type: 'Sink', inputs: {} },
    },
    provenance: {
      fromSource: { outer: ['outer'] },
      toSource: { 'outer.source': 'outer.source', 'outer.sink': 'outer.sink' },
    },
  } as unknown as CompileArtifact,
  nodes: {
    'outer[0]/source': { state: 'running', value: 0.375, outputs: { value: { typeId: 'core.int', value: 4 } } },
    'outer[0]/sink': { state: 'done' },
    'outer[1]/source': { state: 'cached', outputs: { value: { typeId: 'core.int', value: 4 } } },
  },
  regions: { outer: { kind: 'map', binding: 'zip', iterations: 2, finishedIterations: 2 } },
  outputs: {}, artifacts: [], artifactsHydrated: true, previews: {}, activities: [], logs: [], logsDropped: 0,
  errors: [], queuedAt: 1,
} as unknown as ExecutionState

const mount = (peek: DinksterValuesClient['peek'] | undefined, currentExecution = execution): void => {
  dispose = render(() => <RegionIterationInspector
    execution={currentExecution}
    regionOccurrence={{ instancePath: [], node: asNodeId('outer') }}
    document={workflow}
    resolveSchema={(type) => type === 'Sink' ? { displayName: 'Output sink' } : undefined}
    values={peek === undefined ? undefined : { peek } as DinksterValuesClient}
  />, root)
}

describe('RegionIterationInspector', () => {
  it('queries exact iteration output identity and exposes cached and absent-output states', async () => {
    const peek = vi.fn(async (query: ValueQuery): Promise<ValuePeekResult> => ({
      available: true,
      descriptor: { typeId: 'core.int', fingerprint: `${query.nodeId}:value`, value: 4 },
      renditions: [],
    }))
    mount(peek)
    await vi.waitFor(() => expect(root.textContent).toContain('outer[0]/source:value'))
    expect(root.textContent).toContain('2 observed of 2 iterations')
    expect(root.textContent).toContain('Renamed source')
    expect(root.textContent).toContain('Running')
    expect(root.textContent).toContain('Progress: 38%')
    expect(root.querySelector('progress')).toHaveProperty('value', 0.375)

    const selects = root.querySelectorAll('select')
    selects[0]!.value = JSON.stringify([{ nodeId: 'outer', iteration: 1 }])
    selects[0]!.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(root.textContent).toContain('Cached or coalesced'))
    expect(peek).toHaveBeenLastCalledWith(
      { jobId: 'job-7', nodeId: 'outer[1]/source', outputId: 'value' },
      { signal: expect.any(AbortSignal) },
    )

    selects[0]!.value = JSON.stringify([{ nodeId: 'outer', iteration: 0 }])
    selects[0]!.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(root.textContent).toContain('Renamed source'))
    const nodeSelect = root.querySelectorAll('select')[1]!
    nodeSelect.value = 'outer[0]/sink'
    nodeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(root.textContent).toContain('This body node has no inspectable outputs.')
  })

  it('aborts stale reads and renders structured refusals from the current selection', async () => {
    let resolveOld!: (result: ValuePeekResult) => void
    const peek = vi.fn((query: ValueQuery, _options?: ValuePeekOptions): Promise<ValuePeekResult> => query.nodeId.endsWith('[0]/source')
      ? new Promise((resolve) => { resolveOld = resolve })
      : Promise.resolve({ available: false, reason: 'not-retained', status: 410, error: 'Value is no longer retained' }))
    mount(peek)
    await vi.waitFor(() => expect(peek).toHaveBeenCalledTimes(1))
    const firstSignal = peek.mock.calls[0]![1]?.signal
    const iterationSelect = root.querySelector('select')!
    iterationSelect.value = JSON.stringify([{ nodeId: 'outer', iteration: 1 }])
    iterationSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(firstSignal?.aborted).toBe(true)
    await vi.waitFor(() => expect(root.textContent).toContain('Value is no longer retained'))
    resolveOld({ available: true, descriptor: { typeId: 'core.int', fingerprint: 'stale', value: 99 }, renditions: [] })
    await Promise.resolve()
    expect(root.textContent).not.toContain('stale')
  })

  it('makes an unavailable execution owner visible without querying', () => {
    mount(undefined)
    expect(root.textContent).toContain('The execution owner is unavailable.')
  })

  it('keeps an absent lifecycle total unknown instead of deriving it from observed iterations', () => {
    mount(undefined, {
      ...execution,
      nodes: {
        'outer[0]/source': execution.nodes['outer[0]/source']!,
        'outer[3]/source': execution.nodes['outer[1]/source']!,
      },
      regions: { outer: { kind: 'map', binding: 'zip', iterations: null } },
    })
    expect(root.textContent).toContain('2 iterations observed; total unknown')
    expect(root.textContent).not.toContain('2 observed of 2 iterations')
  })

  it('updates the mounted title and state when the host locale changes', async () => {
    registerCatalog('de-DE', {
      'regionInspector.title': 'Iterationsprufung',
      'regionInspector.state.running': 'Wird ausgefuhrt',
    })
    mount(undefined)
    expect(root.textContent).toContain('Iteration inspection')
    expect(root.textContent).toContain('Running')

    setLocale('de-DE')
    await vi.waitFor(() => expect(root.textContent).toContain('Iterationsprufung'))
    expect(root.textContent).toContain('Wird ausgefuhrt')
  })
})
