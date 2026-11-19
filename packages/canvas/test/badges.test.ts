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
import { badgeRect, BYPASSED_BADGE, ERROR_BADGE, executionErrorBadge, hitTestBadge, layoutNodeBadges, nodeBadgeBounds, LOG_INFO_BADGE, MUTED_BADGE, SUBGRAPH_BADGE, type BadgeMap, type NodeBadge } from '../src/badges.js'
import { buildScene, nodeStatesForGraph, type Scene } from '../src/scene.js'
import { executionNodePresentation } from '../src/badges.js'
import type { NodeProgress } from '@dinkster/core'
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

describe('execution node presentation', () => {
  const projected: Record<string, NodeProgress> = {
    queued: { state: 'pending' },
    active: { state: 'running', value: 0.37, max: 80 },
    finished: { state: 'done' },
    reused: { state: 'cached' },
    omitted: { state: 'skipped' },
    failed: { state: 'error' },
  }

  it('keeps only running and failed paint in editable workflows without changing progress', () => {
    const presentation = executionNodePresentation(projected, false, defaultTokens)
    expect(presentation.states).toEqual({
      active: { state: 'running', value: 0.37, max: 80 },
      failed: { state: 'error' },
    })
    expect(Object.keys(presentation.badges)).toEqual(['active', 'failed'])
    expect(presentation.badges.active).toEqual([expect.objectContaining({
      glyph: 'Running', placement: 'below', icon: 'play',
      color: defaultTokens.stateColors.running,
    })])
    expect(presentation.badges.failed).toEqual([expect.objectContaining({
      glyph: 'Failed', placement: 'below', icon: 'triangle-alert',
      color: defaultTokens.stateColors.error,
    })])
    expect(Object.keys(projected)).toHaveLength(6)
  })

  it('keeps every frozen state with its corresponding bottom label and theme paint', () => {
    const tokens = {
      ...defaultTokens,
      stateColors: { pending: 'queued-paint', running: 'running-paint', done: 'done-paint', cached: 'cached-paint', skipped: 'skipped-paint', error: 'error-paint' },
    }
    const presentation = executionNodePresentation(projected, true, tokens)
    expect(presentation.states).toEqual(projected)
    expect(Object.fromEntries(Object.entries(presentation.badges).map(([id, badges]) =>
      [id, badges.map((badge) => [badge.glyph, badge.placement, badge.icon, badge.color])],
    ))).toEqual({
      queued: [['Queued', 'below', 'clock', 'queued-paint']],
      active: [['Running', 'below', 'play', 'running-paint']],
      finished: [['Finished', 'below', 'check', 'done-paint']],
      reused: [['Cached', 'below', 'database', 'cached-paint']],
      omitted: [['Skipped', 'below', 'ban', 'skipped-paint']],
      failed: [['Failed', 'below', 'triangle-alert', 'error-paint']],
    })
    expect(executionNodePresentation({}, true, defaultTokens)).toEqual({ states: {}, badges: {} })
    expect(executionNodePresentation({}, false, defaultTokens)).toEqual({ states: {}, badges: {} })
  })

  it('filters collapsed occurrences after severity aggregation and running progress averaging', () => {
    const scene = sceneOf('exec-subgraph')
    for (const [runtime, expected] of [
      [{ a: { state: 'done', value: 1 }, b: { state: 'running', value: 0.2 }, c: { state: 'running', value: 0.6 } }, { state: 'running', value: 0.4 }],
      [{ a: { state: 'done' }, b: { state: 'error' }, c: { state: 'running', value: 0.6 } }, { state: 'error' }],
    ] as const) {
      const mapped = nodeStatesForGraph(runtime, scene, (id) => id === 'n0' ? ['a', 'b', 'c'] : [])
      const presentation = executionNodePresentation(mapped, false, defaultTokens)
      expect(presentation.states).toEqual({ n0: expected })
      expect(Object.keys(presentation.badges)).toEqual(['n0'])
    }
  })
})

describe('attached tab geometry', () => {
  const scene = sceneOf('exec-basic')
  const original = scene.nodes[0]!
  const tokens = { ...defaultTokens, badgeLayout: 'tabs' as const }
  const badges: NodeBadge[] = Array.from({ length: 9 }, (_, index) => ({
    id: `detail.${index}`, glyph: `Detail ${index + 1}`, placement: 'below',
    variant: 'label', color: '#345678',
  }))

  it('keeps lanes bounded, retains every overflow entry and expands hovered strips on top', () => {
    const node = { ...original, x: 41, y: 83, layout: { ...original.layout, width: 112 } }
    const options = { tokens, outset: 4 }
    const entries = layoutNodeBadges(node, badges, options)
    expect(entries).toHaveLength(3)
    expect(entries[0]!.badge.id).toBe('detail.0')
    expect(entries[0]!.compact).toBe(true)
    expect(entries[2]!.badge.glyph).toBe('+7')
    expect(entries[2]!.overflow).toEqual(badges.slice(2))
    for (const entry of entries) {
      expect(entry.x).toBeGreaterThanOrEqual(53)
      expect(entry.x + entry.width).toBeLessThanOrEqual(141)
      expect(entry.y).toBe(83 + node.layout.height + 3)
    }
    const hovered = layoutNodeBadges(node, badges, { ...options, hoveredId: 'detail.1' })
    expect(hovered.at(-1)!.badge.id).toBe('detail.1')
    expect(hovered.at(-1)!.compact).toBe(false)
    expect(hovered.at(-1)!.width).toBeGreaterThan(entries[1]!.width)
    expect(hovered.at(-1)!.x + hovered.at(-1)!.width).toBeLessThanOrEqual(141)
    const stacked = { ...scene, nodes: [node] }
    const expanded = hovered.at(-1)!
    const hit = hitTestBadge(stacked, { [node.id]: badges }, expanded.x + 1, expanded.y + 1, () => hovered)
    expect(hit?.badge.id).toBe('detail.1')
    const overflow = entries[2]!
    expect(hitTestBadge(stacked, { [node.id]: badges }, overflow.x + 1, overflow.y + 1, () => entries)?.overflow).toEqual(badges.slice(2))
  })

  it('includes top and bottom lanes with hover stroke and live node coordinates', () => {
    const node = { ...original, x: -37, y: 19, layout: { ...original.layout, width: 112 } }
    const list = [{ ...badges[0]!, placement: 'above' as const }, ...badges]
    const bounds = nodeBadgeBounds(node, list, { tokens, outset: 4 })
    expect(bounds.x).toBe(-37)
    expect(bounds.y).toBe(-0.5)
    expect(bounds.width).toBe(112)
    expect(bounds.y + bounds.height).toBe(19 + node.layout.height + 19.5)
    const shifted = nodeBadgeBounds({ ...node, x: 64, y: 72 }, list, { tokens, outset: 4 })
    expect(shifted.x - bounds.x).toBe(101)
    expect(shifted.y - bounds.y).toBe(53)
    expect(shifted.width).toBe(bounds.width)
    expect(shifted.height).toBe(bounds.height)
  })

  it('preserves chip rectangles unless tabs are explicitly selected', () => {
    const list = [SUBGRAPH_BADGE, ...badges]
    const entries = layoutNodeBadges(original, list, { tokens: defaultTokens })
    expect(entries.map(({ x, y, width, height }) => ({ x, y, width, height })))
      .toEqual(list.map((_, index) => badgeRect(original, index, list)))
  })
})

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
