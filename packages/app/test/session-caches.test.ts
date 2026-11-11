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
import { beforeEach, describe, expect, it } from 'vitest'
import type { DinksterNodesPayload } from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { AppState, type Backend, type Tab } from '../src/app-state.js'

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
  app = new AppState()
})

function nativeSetup(): { backend: Extract<Backend, { protocol: 'dinkster' }>; tab: Tab } {
  const added = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
  if (!added || added.protocol !== 'dinkster') throw new Error('addBackend rejected')
  added.registry.set(buildDinksterRegistry(added.id, nodesPayload))
  expect(app.openDocument(chainDoc(3), 'Chain')).toEqual([])
  const tab = app.activeTab()!
  app.setTabTarget(tab.id, added.id)
  return { backend: added, tab }
}

describe('session-keyed caches (AP4)', () => {
  it('compileTabCached never answers a same-lineage replacement with the old session compile', () => {
    const { backend, tab } = nativeSetup()
    const first = app.compileTabCached(tab)
    expect(first).toBeDefined()
    // Cache hit for the SAME session at the same revision.
    expect(app.compileTabCached(tab)).toBe(first)

    // Replace with a same-lineage document whose content differs; the new
    // session restarts at the same revision the entry was cached at - the
    // exact collision an id-keyed cache would answer stale.
    expect(app.openDocument(chainDoc(999), 'Chain (changed)')).toEqual([])
    const replacement = app.activeTab()!
    expect(replacement.id).toBe(tab.id)
    expect(replacement.store.revision).toBe(tab.store.revision)
    app.setTabTarget(replacement.id, backend.id)

    const second = app.compileTabCached(replacement)
    expect(second).toBeDefined()
    expect(second).not.toBe(first) // fresh compile, not the old session's
  })

  it('the semantic hash of a replaced live tab reflects the replacement document', () => {
    const { tab } = nativeSetup()
    // Prime the hash cache through the public seam that consumes it: a
    // frozen tab's sync status hashes the LIVE lineage tab.
    // (No execution here, so exercise semanticHashOf indirectly via a
    // second cached read after replacement - the observable contract is
    // that two content-different sessions never share a hash entry.)
    const hashOf = (t: Tab): string =>
      (app as unknown as { semanticHashOfTab: (t: Tab) => string }).semanticHashOfTab(t)
    const before = hashOf(tab)
    expect(hashOf(tab)).toBe(before) // cached for this session

    expect(app.openDocument(chainDoc(999), 'Chain (changed)')).toEqual([])
    const replacement = app.activeTab()!
    expect(replacement.id).toBe(tab.id)
    expect(replacement.store.revision).toBe(tab.store.revision)

    expect(hashOf(replacement)).not.toBe(before) // content differs -> hash differs
  })
})
