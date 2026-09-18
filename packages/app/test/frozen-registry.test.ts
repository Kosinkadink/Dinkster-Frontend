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
import { AppState, type Backend, type Tab } from '../src/app-state.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const root = join(dirname(fileURLToPath(import.meta.url)), '../../core')
// The stock tabs are authored against native namespaced schemas.
const nodesPayload = JSON.parse(readFileSync(join(root, 'fixtures/dinkster-nodes-comfy.json'), 'utf8')) as DinksterNodesPayload
// A second schema payload with a DIFFERENT content hash (epoch bumped).
const changedNodesPayload = { ...nodesPayload, epoch: 99 } as DinksterNodesPayload

let app: AppState
let basic: Tab
let promptCounter = 0

const addOffline = (url: string): Backend => {
  const backend = app.addBackend(url, undefined, false)
  if (!backend) throw new Error('addBackend rejected')
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

beforeEach(() => {
  app = new AppState()
  basic = app.tabs.get()[0]!
})

describe('frozen views keep their compile-time registry', () => {
  it('a schema change on the backend does not re-resolve an open frozen view', () => {
    app.registry.set(buildDinksterRegistry(asConnectionId('local'), nodesPayload))
    const original = app.registry.get()!
    const artifact = compiledArtifact(basic)
    const ref = refOn('local')
    app.registerRun(basic, ref, artifact)
    expect(app.openExecutionView(ref)).toBe(true)

    // Backend schemas move (epoch bump / reconnect against a newer server).
    app.registry.set(buildDinksterRegistry(asConnectionId('local'), changedNodesPayload))
    const changed = app.registry.get()!
    expect(changed.hash).not.toBe(original.hash)

    // Frozen view: the exact compile-time registry. Live tab: the current one.
    expect(app.registryForTab(frozenTab())).toBe(original)
    expect(app.registryForTab(basic)).toBe(changed)
  })

  it('removing the run backend never re-resolves the frozen view through the default', () => {
    app.registry.set(buildDinksterRegistry(asConnectionId('local'), changedNodesPayload))
    const b = addOffline('http://other:1')
    b.registry.set(buildDinksterRegistry(b.id, nodesPayload))
    const bRegistry = b.registry.get()!
    app.setTabTarget(basic.id, b.id)
    const artifact = compiledArtifact(basic)
    expect(artifact.connection).toBe(b.id)
    const ref: ExecutionRef = { connection: b.id, prompt: asPromptId(`p${promptCounter++}`) }
    app.registerRun(basic, ref, artifact)
    expect(app.openExecutionView(ref)).toBe(true)

    app.removeBackend(b.id)

    // The retained compile-time registry answers - not the default backend's.
    expect(app.registryForTab(frozenTab())).toBe(bRegistry)
    expect(app.registryForTab(frozenTab())).not.toBe(app.registry.get())
  })

  it('a same-hash impostor registry never replaces the compile-time association', () => {
    app.registry.set(buildDinksterRegistry(asConnectionId('local'), nodesPayload))
    const original = app.registry.get()!
    const artifact = compiledArtifact(basic)
    // Between compile and registration the backend registry is REPLACED by a
    // different object carrying the SAME raw hash but different effective
    // schemas (what extra-schema layering does). Registration must not adopt
    // it over the compile-time registry.
    const impostor = { ...original, schemas: new Map(), resolve: () => undefined }
    app.registry.set(impostor)
    const ref = refOn('local')
    app.registerRun(basic, ref, artifact)
    expect(app.openExecutionView(ref)).toBe(true)

    expect(app.registryForTab(frozenTab())).toBe(original)
    expect(app.registryForTab(frozenTab())).not.toBe(impostor)
  })

  it('an unmatchable schema hash answers undefined - never another registry', () => {
    app.registry.set(buildDinksterRegistry(asConnectionId('local'), nodesPayload))
    const { schemas } = parseDinksterNodes(nodesPayload)
    // Registered around the app (store.register directly), so nothing was
    // retained and the recorded hash matches no registry the app holds.
    const result = compile({
      document: basic.store.doc,
      revision: basic.store.revision,
      resolve: (type) => schemas.get(type),
      scope: { kind: 'full' },
      connection: asConnectionId('local'),
      schemaHash: 'hash-of-a-registry-this-session-never-held',
    })
    if (!result.ok) throw new Error('compile failed')
    const ref = refOn('local')
    app.store.register(ref, result.artifact as CompileArtifact, 0)
    expect(app.openExecutionView(ref)).toBe(true)

    expect(app.registryForTab(frozenTab())).toBeUndefined()
  })

  it('a still-matching current registry serves a run registered without retention', () => {
    app.registry.set(buildDinksterRegistry(asConnectionId('local'), nodesPayload))
    const current = app.registry.get()!
    const { schemas } = parseDinksterNodes(nodesPayload)
    const result = compile({
      document: basic.store.doc,
      revision: basic.store.revision,
      resolve: (type) => schemas.get(type),
      scope: { kind: 'full' },
      connection: asConnectionId('local'),
      schemaHash: current.hash,
    })
    if (!result.ok) throw new Error('compile failed')
    const ref = refOn('local')
    app.store.register(ref, result.artifact as CompileArtifact, 0)
    expect(app.openExecutionView(ref)).toBe(true)

    expect(app.registryForTab(frozenTab())).toBe(current)
  })
})

describe('frozen views pin their execution state', () => {
  it('entry-cap eviction never deletes the state behind an open frozen view', () => {
    app.registry.set(buildDinksterRegistry(asConnectionId('local'), nodesPayload))
    const artifact = compiledArtifact(basic)
    const ref = refOn('local')
    app.registerRun(basic, ref, artifact)
    // Terminal: only terminal entries are eviction candidates.
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 1 })
    expect(app.openExecutionView(ref)).toBe(true)
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

  it('a document whose lineage collides with a frozen tab id releases the pin on displacement', () => {
    app.registry.set(buildDinksterRegistry(asConnectionId('local'), nodesPayload))
    const artifact = compiledArtifact(basic)
    const ref = refOn('local')
    app.registerRun(basic, ref, artifact)
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 1 })
    expect(app.openExecutionView(ref)).toBe(true)
    const frozenId = frozenTab().id

    // Lineages are unrestricted strings, so a loaded document can collide
    // with the frozen tab id and displace the frozen view.
    const json = JSON.parse(readFileSync(join(root, 'fixtures/workflows/seed-basic.json'), 'utf8')) as { lineage: string }
    json.lineage = frozenId
    expect(app.openDocument(json, 'Impostor')).toEqual([])
    const replaced = app.tabs.get().filter((t) => t.id === frozenId)
    expect(replaced).toHaveLength(1)
    expect(replaced[0]!.execution).toBeUndefined()

    // The displaced frozen view released its pin: the run is evictable again.
    const base = Date.now()
    for (let i = 0; i < 201; i++) {
      const churn = refOn('local')
      app.store.apply({ kind: 'started', execution: churn, timestamp: base + i })
      app.store.apply({ kind: 'completed', execution: churn, timestamp: base + i })
    }
    expect(app.store.get(ref)).toBeUndefined()
  })
})
