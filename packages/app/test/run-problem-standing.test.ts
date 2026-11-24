import { describe, expect, it } from 'vitest'
import { asConnectionId, compile, type CompileArtifact, type CompileResult, type NodeSchema } from '@dinkster/core'
import { controllerAdvancementPlan } from '../src/app-state.js'
import { drawnAnewInputs, RunStandingMemory, runStandingFor } from '../src/run-problem-standing.js'

const int = { kind: 'concrete', name: 'INT' } as const
const sampler: NodeSchema = {
  type: 'Sampler', displayName: 'Sampler', category: 'test', source: 'v3', isOutputNode: true,
  body: [
    { kind: 'output', id: 'out', type: int },
    { kind: 'input', id: 'seed', type: int, optional: false,
      widget: { widgetType: 'INT', options: { min: 0, max: 1000 }, default: 0, controller: 'after_generate' } },
    { kind: 'input', id: 'steps', type: int, optional: false, widget: { widgetType: 'INT', options: {}, default: 20 } },
    { kind: 'input', id: 'up', type: int, optional: true },
  ],
}
const resolve = (type: string) => type === sampler.type ? sampler : undefined

/** source -> sink, plus an unconnected node; `sink` is the one that failed. */
function documentWith(values: { seed: number; controller: string; steps?: number; loneSteps?: number }) {
  const node = (id: string, steps: number) => ({
    id, type: 'Sampler', values: { seed: values.seed, steps }, controllers: { seed: values.controller },
  })
  return {
    format: 'dinkster-workflow' as const, formatVersion: 1 as const, lineage: 'standing', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'root', nodes: {
      source: node('source', values.steps ?? 20),
      sink: node('sink', 20),
      lone: node('lone', values.loneSteps ?? 20),
    }, links: { l1: { id: 'l1', from: { node: 'source', port: 'out' }, to: { node: 'sink', port: 'up' } } },
    nets: {}, reroutes: {}, nextOrdinal: 4 } },
    view: { graphs: { g0: { nodes: {} } } },
  }
}

function compiled(document: ReturnType<typeof documentWith>): CompileResult {
  return compile({ document: document as never, revision: 0, resolve, scope: { kind: 'full' }, connection: asConnectionId('local'), schemaHash: 'h' })
}

function artifactOf(result: CompileResult): CompileArtifact {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return result.artifact
}

/** The standing the canvas host computes for the current document against a run. */
function standingAgainst(ran: CompileArtifact, current: ReturnType<typeof documentWith>) {
  const live = compiled(current)
  const artifact = artifactOf(live)
  return runStandingFor({ live, ran, drawnAnew: drawnAnewInputs(artifact, controllerAdvancementPlan(artifact.snapshot, artifact)) })
}

describe('run problem standing', () => {
  const ran = artifactOf(compiled(documentWith({ seed: 5, controller: 'randomize' })))

  it('a seed the next queue draws anew is not a change; the same seed fixed at another value is', () => {
    const redrawn = standingAgainst(ran, documentWith({ seed: 812, controller: 'randomize' }))
    expect(redrawn(['sink'])).toBe('same')
    expect(redrawn(['source'])).toBe('same')
    // Without the advancement plan the redrawn seed would read as a change.
    expect(runStandingFor({ live: compiled(documentWith({ seed: 812, controller: 'randomize' })), ran, drawnAnew: new Map() })(['sink'])).toBe('changed')

    const fixed = standingAgainst(ran, documentWith({ seed: 812, controller: 'fixed' }))
    expect(fixed(['sink'])).toBe('changed')
    expect(standingAgainst(ran, documentWith({ seed: 5, controller: 'fixed' }))(['sink'])).toBe('same')
  })

  it('an upstream edit changes the failed node and its upstream, not an unrelated node', () => {
    const edited = standingAgainst(ran, documentWith({ seed: 5, controller: 'randomize', steps: 30 }))
    expect(edited(['sink'])).toBe('changed')
    expect(edited(['source'])).toBe('changed')
    expect(edited(['lone'])).toBe('same')
    // A view node behind several runtime nodes changed when any of them did.
    expect(edited(['lone', 'sink'])).toBe('changed')
  })

  it('cannot tell without a current compile, and keeps the last answer until it can', () => {
    const unknown = runStandingFor({ live: undefined, ran, drawnAnew: new Map() })
    expect(unknown(['sink'])).toBe('unknown')

    const memory = new RunStandingMemory()
    expect(memory.changedSince('run-1', 'sink', 'unknown')).toBe(false)
    expect(memory.changedSince('run-1', 'sink', 'changed')).toBe(true)
    expect(memory.changedSince('run-1', 'sink', 'unknown')).toBe(true)
    // Undo back to the document that ran.
    expect(memory.changedSince('run-1', 'sink', 'same')).toBe(false)
    expect(memory.changedSince('run-1', 'sink', 'changed')).toBe(true)
    // A new run starts every node unchanged.
    expect(memory.changedSince('run-2', 'sink', 'unknown')).toBe(false)
  })
})
