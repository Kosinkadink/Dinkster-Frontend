/**
 * Frozen-view registry ownership: a frozen execution tab must
 * resolve with the EXACT registry its artifact compiled against - never the
 * backend's current registry after a schema change, never the default backend
 * standing in for a removed one, and never a silent wrong-schema fallback.
 * When no matching registry is held, registryForTab answers undefined (the
 * banner renders a visible "schemas unavailable" warning off that).
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asConnectionId, asPromptId, type CompileArtifact, type ExecutionRef } from '@dinkster/core'
import { AppState, type Backend, type Tab } from '../src/app-state.js'
import { historicalRegistry } from './historical-schemas.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const root = join(dirname(fileURLToPath(import.meta.url)), '../../core')

let app: AppState
let basic: Tab
let promptCounter = 0

const addOffline = (url: string): Backend => {
  const backend = app.addBackend(url, undefined, false)
  if (!backend) throw new Error('addBackend rejected')
  vi.spyOn(backend.connection, 'retainAssets').mockImplementation(async (owner, declaration) =>
    ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
  return backend
}

/** Compile the tab against its target backend the way the queue path does. */
const compiledArtifact = (tab: Tab): CompileArtifact => {
  const result = app.compileTab(tab)
  if (!result?.ok) throw new Error('compile failed')
  return result.artifact
}

const refOn = (connection: string): ExecutionRef => ({
  connection: asConnectionId(connection),
  prompt: asPromptId(`p${promptCounter++}`),
})

const frozenTab = (): Tab => {
  const tab = app.tabs.get().find((t) => t.execution)
  if (!tab) throw new Error('no frozen tab open')
  return tab
}

beforeEach(async () => {
  app = createWorkflowApp(null)
  await app.openDocument(JSON.parse(readFileSync(join(root, 'fixtures/workflows/seed-basic.json'), 'utf8')), 'Basic')
  basic = app.activeTab()!
})

afterEach(() => {
  app.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('frozen views keep their compile-time registry', () => {
  it('a schema change on the backend does not re-resolve an open frozen view', async () => {
    app.registry.set(historicalRegistry(asConnectionId('local')))
    const original = app.registry.get()!
    const artifact = compiledArtifact(basic)
    const ref = refOn('local')
    app.registerRun(basic, ref, artifact)
    expect(await app.openExecutionView(ref)).toBe(true)

    // Backend schemas move on reconnect against a newer server.
    app.registry.set(historicalRegistry(asConnectionId('local'), 'changed-schemas'))
    const changed = app.registry.get()!
    expect(changed.hash).not.toBe(original.hash)

    // Frozen view: the exact compile-time registry. Live tab: the current one.
    expect(app.registryForTab(frozenTab())).toBe(original)
    expect(app.registryForTab(basic)).toBe(changed)
  })

  it('removing the run backend never re-resolves the frozen view through the default', async () => {
    app.registry.set(historicalRegistry(asConnectionId('local'), 'changed-schemas'))
    const b = addOffline('http://other:1')
    b.registry.set(historicalRegistry(b.id))
    const bRegistry = b.registry.get()!
    app.setTabTarget(basic.id, b.id)
    const artifact = compiledArtifact(basic)
    expect(artifact.connection).toBe(b.id)
    const ref: ExecutionRef = { connection: b.id, prompt: asPromptId(`p${promptCounter++}`) }
    app.registerRun(basic, ref, artifact)
    expect(await app.openExecutionView(ref)).toBe(true)

    app.removeBackend(b.id)

    // The retained compile-time registry answers - not the default backend's.
    expect(app.registryForTab(frozenTab())).toBe(bRegistry)
    expect(app.registryForTab(frozenTab())).not.toBe(app.registry.get())
  })

})

describe('frozen views pin their execution state', () => {

  it('entry-cap eviction never deletes the state behind an open frozen view', async () => {
    app.registry.set(historicalRegistry(asConnectionId('local')))
    const artifact = compiledArtifact(basic)
    const ref = refOn('local')
    app.registerRun(basic, ref, artifact)
    // Terminal: only terminal entries are eviction candidates.
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 1 })
    expect(await app.openExecutionView(ref)).toBe(true)
    const tab = frozenTab()

    for (let i = 0; i < 250; i++) {
      const churn = refOn('local')
      app.store.apply({ kind: 'started', execution: churn, timestamp: i + 2 })
      app.store.apply({ kind: 'completed', execution: churn, timestamp: i + 2 })
    }
    expect(app.executionForTab(tab)).toBeDefined()

    // Closing the frozen view releases the pin; once enough newer terminal
    // work lands, the run's entry is evictable again.
    app.closeTab(tab.id)
    const base = Date.now()
    for (let i = 0; i < 201; i++) {
      const churn = refOn('local')
      app.store.apply({ kind: 'started', execution: churn, timestamp: base + i })
      app.store.apply({ kind: 'completed', execution: churn, timestamp: base + i })
    }
    expect(app.store.get(ref)).toBeUndefined()
  })

})
