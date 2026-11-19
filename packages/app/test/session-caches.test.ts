import { createWorkflowApp } from './fixtures/workflow-app.js'
/**
 * Session-keyed cache ownership: compileTabCached and
 * semanticHashOfTab (via frozenSyncStatus) validate entries by document
 * revision, but tab ids are lineages - a same-lineage replacement session
 * restarts at the revision an old entry may have been cached at. Caches
 * are keyed by the Tab OBJECT (WeakMap), so a fresh session can never be
 * answered with another session's compile or hash.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DinksterNodesPayload } from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import type { AppState, Backend, Tab } from '../src/app-state.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const nodesPayload = JSON.parse(
  readFileSync(join(coreRoot, 'fixtures/dinkster-nodes.json'), 'utf8'),
) as DinksterNodesPayload

/** Two chained std.math.add_ints (mirrors library.test.ts's CHAIN_DOC). */
const chainDoc = (a: number) => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'lineage-cache-test',
  root: 'g0',
  graphs: {
    g0: {
      id: 'g0',
      name: 'root',
      nodes: {
        n0: { id: 'n0', type: 'std.math.add_ints', values: { a, b: 4 } },
        n1: { id: 'n1', type: 'std.math.add_ints', values: { b: 10 } },
      },
      links: {
        l2: { id: 'l2', from: { node: 'n0', port: 'sum' }, to: { node: 'n1', port: 'a' } },
      },
      nets: {},
      reroutes: {},
      nextOrdinal: 3,
    },
  },
  view: {
    graphs: {
      g0: { nodes: { n0: { position: { x: 0, y: 0 } }, n1: { position: { x: 200, y: 0 } } } },
    },
  },
})

let app: AppState

beforeEach(() => {
  app = createWorkflowApp(null)
})

async function nativeSetup(): Promise<{ backend: Extract<Backend, { protocol: 'dinkster' }>; tab: Tab }> {
  const added = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
  if (!added || added.protocol !== 'dinkster') throw new Error('addBackend rejected')
  added.registry.set(buildDinksterRegistry(added.id, nodesPayload))
  expect((await app.openDocument(chainDoc(3), 'Chain'))).toEqual([])
  const tab = app.activeTab()!
  app.setTabTarget(tab.id, added.id)
  return { backend: added, tab }
}

describe('session-keyed caches (AP4)', () => {
  it('coalesces comparison work after paint without answering edits with stale recipes', async () => {
    const { tab } = await nativeSetup()
    vi.useFakeTimers()
    let frame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => { frame = undefined })
    const compile = vi.spyOn(app, 'compileTab')
    try {
      expect(app.previewComparisonCompile(tab)).toBeUndefined()
      expect(compile).not.toHaveBeenCalled()
      frame!(0)
      await vi.advanceTimersByTimeAsync(99)
      expect(compile).not.toHaveBeenCalled()
      expect((await app.dispatchTo(tab, { command: 'node.setValue', params: {
        graphId: 'g0', nodeId: 'n0', inputId: 'a', value: 19,
      } })).ok).toBe(true)
      expect(app.previewComparisonCompile(tab)).toBeUndefined()
      frame!(100)
      await vi.advanceTimersByTimeAsync(100)
      expect(compile).toHaveBeenCalledTimes(1)
      const ready = app.previewComparisonCompile(tab)
      expect(ready).toEqual(app.compileTab(tab))
      expect(ready).toBeDefined()
      expect((await app.dispatchTo(tab, { command: 'node.move', params: {
        graphId: 'g0', positions: { n0: { x: 197, y: 83 } },
      } })).ok).toBe(true)
      expect(app.previewComparisonCompile(tab)).toBe(ready)
      expect((await app.dispatchTo(tab, { command: 'node.setValue', params: {
        graphId: 'g0', nodeId: 'n0', inputId: 'a', value: 31,
      } })).ok).toBe(true)
      expect(app.previewComparisonCompile(tab)).toBeUndefined()
      // Teardown must not publish a comparison from the retired app.
      app.dispose()
      await vi.runAllTimersAsync()
      expect(compile).toHaveBeenCalledTimes(2)
    } finally {
      app.dispose()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('compileTabCached never answers a same-lineage replacement with the old session compile', async () => {
    const { backend, tab } = (await nativeSetup())
    const first = app.compileTabCached(tab)
    expect(first).toBeDefined()
    // Cache hit for the SAME session at the same revision.
    expect(app.compileTabCached(tab)).toBe(first)

    // Replace with a same-lineage document whose content differs; the new
    // session restarts at the same revision the entry was cached at - the
    // exact collision an id-keyed cache would answer stale.
    expect((await app.openDocument(chainDoc(999), 'Chain (changed)'))).toEqual([])
    const replacement = app.activeTab()!
    expect(replacement.id).toBe(tab.id)
    expect(replacement.store.revision).toBe(tab.store.revision)
    app.setTabTarget(replacement.id, backend.id)

    const second = app.compileTabCached(replacement)
    expect(second).toBeDefined()
    expect(second).not.toBe(first) // fresh compile, not the old session's
  })

})
