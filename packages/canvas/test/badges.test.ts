/**
 * Badge layer tests: badgeRect/hitTestBadge geometry must agree with what the
 * renderer draws, badge order is index 0 = rightmost, and hits resolve to the
 * TOPMOST node (last drawn) like ordinary hit-testing.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  documentResolver,
  loadDocument,
  type WorkflowDocument,
} from '@dinkster/core'
import { historicalSchemas as schemas } from './historical-schemas.js'
import { badgeRect, BYPASSED_BADGE, ERROR_BADGE, executionErrorBadge, hitTestBadge, LOG_INFO_BADGE, MUTED_BADGE, SUBGRAPH_BADGE, type BadgeMap } from '../src/badges.js'
import { buildScene, type Scene } from '../src/scene.js'
import { defaultTokens } from '../src/tokens.js'
import type { TextMeasurer, WidgetMeasure } from '../src/layout.js'

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(coreRoot, rel), 'utf8'))

const measure: TextMeasurer = (text) => text.length * 6
const widgetMeasure: WidgetMeasure = () => ({ viewId: 'core.line', rows: 1 })

function sceneOf(workflow: string, graphId = 'g0'): Scene {
  const doc = loadDocument(readJson(`fixtures/workflows/${workflow}.json`)).document as WorkflowDocument
  return buildScene({
    document: doc,
    graphId,
    resolve: documentResolver(doc, (t) => schemas.get(t)),
    tokens: defaultTokens,
    measure,
    widgetMeasure,
  })
}

describe('hitTestBadge', () => {
  const scene = sceneOf('exec-basic')
  const n0 = scene.nodes.find((n) => n.id === 'n0')!
  const badges: BadgeMap = { n0: [ERROR_BADGE, SUBGRAPH_BADGE] }

  it('hits the badge at its rect center and returns the rect', () => {
    const r = badgeRect(n0, 0, badges.n0)
    const hit = hitTestBadge(scene, badges, r.x + r.width / 2, r.y + r.height / 2)
    expect(hit?.node.id).toBe('n0')
    expect(hit?.badge.id).toBe(ERROR_BADGE.id)
    expect(hit?.rect).toEqual(r)
  })

  it('resolves the second badge one stride to the left', () => {
    const r = badgeRect(n0, 1, badges.n0)
    const hit = hitTestBadge(scene, badges, r.x + 1, r.y + 1)
    expect(hit?.badge.id).toBe(SUBGRAPH_BADGE.id)
  })

  it('does not let presentation-only mode badges intercept node gestures', () => {
    const modeBadges: BadgeMap = { n0: [MUTED_BADGE, BYPASSED_BADGE] }
    for (const index of [0, 1]) {
      const r = badgeRect(n0, index, modeBadges.n0)
      expect(hitTestBadge(scene, modeBadges, r.x + 1, r.y + 1)).toBeUndefined()
    }
  })

  it('misses just outside a badge and on nodes without badges', () => {
    const r = badgeRect(n0, 0, badges.n0)
    expect(hitTestBadge(scene, badges, r.x - 1, r.y)).toBeUndefined()
    const n1 = scene.nodes.find((n) => n.id === 'n1')!
    const r1 = badgeRect(n1, 0)
    expect(hitTestBadge(scene, badges, r1.x + 1, r1.y + 1)).toBeUndefined()
  })

  it('prefers the topmost (last-drawn) node when badges overlap', () => {
    const [a, b] = [scene.nodes[0]!, scene.nodes[1]!]
    // Stack b exactly on a (same position AND layout) so badge rects coincide.
    const stacked: Scene = { ...scene, nodes: [a, { ...b, x: a.x, y: a.y, layout: a.layout }] }
    const both: BadgeMap = { [a.id]: [ERROR_BADGE], [b.id]: [ERROR_BADGE] }
    const r = badgeRect(a, 0)
    const hit = hitTestBadge(stacked, both, r.x + 2, r.y + 2)
    expect(hit?.node.id).toBe(b.id)
  })

  it('hits a below-lane badge under the node body', () => {
    const belowBadges: BadgeMap = { n0: [executionErrorBadge(2), LOG_INFO_BADGE] }
    const error = badgeRect(n0, 0, belowBadges.n0)
    const info = badgeRect(n0, 1, belowBadges.n0)
    expect(hitTestBadge(scene, belowBadges, error.x + 1, error.y + 1)?.badge.id).toBe('core.error')
    expect(hitTestBadge(scene, belowBadges, info.x + 1, info.y + 1)?.badge.id).toBe('core.log.info')
  })

  it('does not hit a lower node badge hidden behind a later-drawn node body', () => {
    const lower = scene.nodes[0]!
    const badge = { id: 'test.arm', glyph: 'N', placement: 'above' as const, color: '#286a55' }
    const rect = badgeRect(lower, 0, [badge])
    const blocker = { ...scene.nodes[1]!, x: rect.x, y: rect.y }
    const stacked: Scene = { ...scene, nodes: [lower, blocker] }

    expect(hitTestBadge(stacked, { [lower.id]: [badge] }, rect.x + 1, rect.y + 1)).toBeUndefined()
  })
})
