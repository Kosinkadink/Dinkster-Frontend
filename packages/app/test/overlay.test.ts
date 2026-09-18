/**
 * Execution-overlay binding tests: which execution a tab's canvas overlay
 * shows. Frozen tabs are permanently bound to their execution; live tabs
 * follow their lineage's latest run unless explicitly pinned to one. Pins
 * are VIEW state - per tab, never serialized, never crossing lineages.
 *
 * Executions are registered through REAL compiles of the app's default tab
 * documents (same artifact shape the queue path produces), so lineage/hash
 * plumbing is exercised honestly rather than faked.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  asConnectionId,
  asPromptId,
  compile,
  parseDinksterNodes,
  type CompileArtifact,
  type DinksterNodesPayload,
  type ExecutionRef,
} from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { AppState, type Tab } from '../src/app-state.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const root = join(dirname(fileURLToPath(import.meta.url)), '../../core')
// The stock tabs are authored against native namespaced schemas.
const nodesPayload = JSON.parse(readFileSync(join(root, 'fixtures/dinkster-nodes-comfy.json'), 'utf8')) as DinksterNodesPayload
const { schemas } = parseDinksterNodes(nodesPayload)
const resolve = (type: string) => schemas.get(type)

const CONNECTION = asConnectionId('local')

let app: AppState
let basic: Tab
let subgraph: Tab
let promptCounter = 0

/** Compile a live tab's CURRENT document and register it as an execution. */
const run = (tab: Tab, queuedAt: number): ExecutionRef => {
  const result = compile({
    document: tab.store.doc,
    revision: tab.store.revision,
    resolve,
    scope: { kind: 'full' },
    connection: CONNECTION,
    schemaHash: 'test-schema-hash',
  })
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  const ref: ExecutionRef = { connection: CONNECTION, prompt: asPromptId(`p${promptCounter++}`) }
  app.store.register(ref, result.artifact as CompileArtifact, queuedAt)
  return ref
}

beforeEach(() => {
  app = new AppState()
  // The stock seeds are authored in portable legacy V1 form; deliver the
  // native schemas the way the real app does (registry arrival fires
  // backendsTick) so the silent baseline upgrade migrates them to the
  // canonical types this suite compiles against.
  const backend = app.backends.get()[0]!
  backend.registry.set(buildDinksterRegistry(backend.id, nodesPayload))
  const tabs = app.tabs.get()
  basic = tabs[0]!
  subgraph = tabs[1]!
  expect(basic.store.doc.lineage).not.toBe(subgraph.store.doc.lineage)
})

describe('follow-latest default', () => {
  it('a live tab resolves the newest execution of ITS lineage', () => {
    run(basic, 100)
    const newer = run(basic, 200)
    run(subgraph, 300) // other lineage, newer still: must not win
    expect(app.executionForTab(basic)?.ref).toEqual(newer)
    expect(app.overlayModeForTab(basic)).toBe('latest')
  })

  it('lists executions only for the requested workflow lineage', () => {
    const basicOld = run(basic, 100)
    const subgraphRun = run(subgraph, 200)
    const basicNew = run(basic, 300)
    expect(app.executionsForTab(basic).map((entry) => entry.ref)).toEqual([basicNew, basicOld])
    expect(app.executionsForTab(subgraph).map((entry) => entry.ref)).toEqual([subgraphRun])
  })

  it('a tab with no executions resolves nothing', () => {
    run(subgraph, 100)
    expect(app.executionForTab(basic)).toBeUndefined()
  })
})

describe('pinning', () => {
  it('pin selects an older run and a NEW run does not replace it', () => {
    const older = run(basic, 100)
    run(basic, 200)
    expect(app.pinExecutionOverlay(basic.id, older)).toBe(true)
    expect(app.executionForTab(basic)?.ref).toEqual(older)
    expect(app.overlayModeForTab(basic)).toBe('pinned')
    run(basic, 300) // arrives while pinned
    expect(app.executionForTab(basic)?.ref).toEqual(older)
  })

  it('follow-latest unpins and immediately resolves the newest run', () => {
    const older = run(basic, 100)
    const newest = run(basic, 200)
    app.pinExecutionOverlay(basic.id, older)
    app.followLatestExecution(basic.id)
    expect(app.executionForTab(basic)?.ref).toEqual(newest)
    expect(app.overlayModeForTab(basic)).toBe('latest')
  })

  it('pins are isolated per tab', () => {
    const basicOld = run(basic, 100)
    run(basic, 200)
    const subLatest = run(subgraph, 300)
    app.pinExecutionOverlay(basic.id, basicOld)
    expect(app.executionForTab(subgraph)?.ref).toEqual(subLatest)
    expect(app.overlayModeForTab(subgraph)).toBe('latest')
  })

  it('rejects pinning an execution from another lineage', () => {
    const subRef = run(subgraph, 100)
    expect(app.pinExecutionOverlay(basic.id, subRef)).toBe(false)
    expect(app.overlayPins.get().has(basic.id)).toBe(false)
  })

  it('rejects pinning an unknown execution', () => {
    const ghost: ExecutionRef = { connection: CONNECTION, prompt: asPromptId('nope') }
    expect(app.pinExecutionOverlay(basic.id, ghost)).toBe(false)
  })

  it('rejects pinning on a frozen tab', () => {
    const ref = run(basic, 100)
    app.openExecutionView(ref)
    const frozen = app.activeTab()!
    expect(frozen.execution).toBeDefined()
    expect(app.pinExecutionOverlay(frozen.id, ref)).toBe(false)
  })

  it('running and terminal executions are both pinnable', () => {
    const ref = run(basic, 100)
    app.store.apply({ kind: 'started', execution: ref, timestamp: 110 })
    expect(app.pinExecutionOverlay(basic.id, ref)).toBe(true)
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 120 })
    expect(app.executionForTab(basic)?.status).toBe('completed')
    expect(app.overlayModeForTab(basic)).toBe('pinned')
  })
})

describe('frozen tabs', () => {
  it('a frozen tab always resolves ITS execution, ignoring pins and newer runs', () => {
    const ref = run(basic, 100)
    app.openExecutionView(ref)
    const frozen = app.activeTab()!
    const newer = run(basic, 200)
    app.pinExecutionOverlay(basic.id, newer)
    expect(app.executionForTab(frozen)?.ref).toEqual(ref)
  })

  it('lists only the frozen tab exact execution, not sibling runs of its lineage', () => {
    const frozenRef = run(basic, 100)
    run(basic, 200)
    app.openExecutionView(frozenRef)
    expect(app.executionsForTab(app.activeTab()!).map((entry) => entry.ref)).toEqual([frozenRef])
  })
})

describe('view-state lifecycle', () => {
  it('closing a tab drops its pin entry', () => {
    const ref = run(basic, 100)
    app.pinExecutionOverlay(basic.id, ref)
    app.closeTab(basic.id)
    expect(app.overlayPins.get().has(basic.id)).toBe(false)
  })

  it('replacing a document via openDocument starts unpinned', () => {
    const ref = run(basic, 100)
    app.pinExecutionOverlay(basic.id, ref)
    // Reload the same document (same lineage -> same tab id).
    const json = JSON.parse(
      readFileSync(join(root, 'fixtures/workflows/seed-basic.json'), 'utf8'),
    ) as unknown
    expect(app.openDocument(json, 'Basic reloaded')).toEqual([])
    expect(app.overlayPins.get().has(basic.id)).toBe(false)
    expect(app.overlayModeForTab(app.activeTab()!)).toBe('latest')
  })
})

describe('liveSyncStatus', () => {
  it('reports the pinned run with mode "pinned" and stays in sync with it', () => {
    const older = run(basic, 100)
    run(basic, 200)
    app.pinExecutionOverlay(basic.id, older)
    const status = app.liveSyncStatus(basic)
    expect(status?.ref).toEqual(older)
    expect(status?.mode).toBe('pinned')
    expect(status?.inSync).toBe(true) // document unchanged since that compile
  })

  it('reports the latest run with mode "latest" when unpinned', () => {
    run(basic, 100)
    const newest = run(basic, 200)
    const status = app.liveSyncStatus(basic)
    expect(status?.ref).toEqual(newest)
    expect(status?.mode).toBe('latest')
  })
})
