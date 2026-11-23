/**
 * Badge layer tests: layoutNodeBadges places tabs and the title mark by the
 * ruled geometry, hitTestBadge agrees with it, and hits resolve to the
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
import { BYPASSED_BADGE, DEPRECATED_BADGE, ERROR_BADGE, executionErrorBadge, hitTestBadge, layoutNodeBadges, nodeBadgeBounds, LOG_INFO_BADGE, MUTED_BADGE, SUBGRAPH_BADGE, subgraphBadge, type BadgeMap, type NodeBadge } from '../src/badges.js'
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
      glyph: 'Failed', placement: 'below', icon: 'circle-x',
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
      failed: [['Failed', 'below', 'circle-x', 'error-paint']],
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

describe('badge layout', () => {
  const scene = sceneOf('exec-basic')
  const original = scene.nodes[0]!
  const tokens = defaultTokens
  // 5 px a character: unlike the 11 px fallback, so a layout that ignores the measure fails.
  const measureLabel = (text: string) => text.length * 5
  const badges: NodeBadge[] = Array.from({ length: 9 }, (_, index) => ({
    id: `detail.${index}`, glyph: `Detail ${index + 1}`, placement: 'below', icon: 'info', color: '#345678',
  }))

  it('starts top tabs at the right edge and bottom tabs at the left edge, 3 px off the painted outline', () => {
    const node = { ...original, x: 40, y: 100, layout: { ...original.layout, width: 300 } }
    const list = [MUTED_BADGE, DEPRECATED_BADGE, ERROR_BADGE, { id: 'pack.plain', glyph: 'Plain', placement: 'below' as const, color: '#345678' }]
    const entries = layoutNodeBadges(node, list, { tokens, outset: 2, measureLabel })
    const rects = Object.fromEntries(entries.map(({ badge, x, y, width, height }) => [badge.id, { x, y, width, height }]))
    // Width: two 6 px paddings, a 14 px icon and a 4 px gap, and the words; no icon, no icon space.
    expect(rects[MUTED_BADGE.id]).toEqual({ x: 340 - 55, y: 100 - 2 - 3 - 20, width: 55, height: 20 })
    expect(rects[DEPRECATED_BADGE.id]).toEqual({ x: 340 - 55 - 2 - 80, y: 75, width: 80, height: 20 })
    const bottom = 100 + node.layout.height + 2 + 3
    expect(rects[ERROR_BADGE.id]).toEqual({ x: 40, y: bottom, width: 55, height: 20 })
    expect(rects['pack.plain']).toEqual({ x: 40 + 55 + 2, y: bottom, width: 37, height: 20 })
  })

  it('keeps only the subgraph mark in the title bar, at its right end, with its count after the icon', () => {
    const node = { ...original, x: 40, y: 100, layout: { ...original.layout, width: 300 } }
    const [mark] = layoutNodeBadges(node, [SUBGRAPH_BADGE, MUTED_BADGE], { tokens, measureLabel })
    expect(mark).toMatchObject({ x: 340 - tokens.padX - 20, y: 100 + node.layout.headerHeight / 2 - 10, width: 20, height: 20 })
    const [counted] = layoutNodeBadges(node, [subgraphBadge(12)], { tokens, measureLabel })
    // 3 px padding each side, the 14 px icon, a 3 px gap and "12".
    expect(counted).toMatchObject({ x: 340 - tokens.padX - 33, width: 33 })
  })

  it('keeps lanes bounded, retains every overflow entry and expands hovered strips on top', () => {
    // Room for three icon-only tabs of 26 px and the 34 px "+6" tab, with 2 px gaps.
    const node = { ...original, x: 41, y: 83, layout: { ...original.layout, width: 118 } }
    const options = { tokens, outset: 4 }
    const entries = layoutNodeBadges(node, badges, options)
    expect(entries).toHaveLength(4)
    expect(entries[0]!.badge.id).toBe('detail.0')
    expect(entries[0]!.compact).toBe(true)
    expect(entries[3]!.badge.glyph).toBe('+6')
    expect(entries[3]!.overflow).toEqual(badges.slice(3))
    for (const entry of entries) {
      expect(entry.x).toBeGreaterThanOrEqual(41)
      expect(entry.x + entry.width).toBeLessThanOrEqual(159)
      expect(entry.y).toBe(83 + node.layout.height + 7)
    }
    const hovered = layoutNodeBadges(node, badges, { ...options, hoveredId: 'detail.1' })
    expect(hovered.at(-1)!.badge.id).toBe('detail.1')
    expect(hovered.at(-1)!.compact).toBe(false)
    expect(hovered.at(-1)!.width).toBeGreaterThan(entries[1]!.width)
    expect(hovered.at(-1)!.x + hovered.at(-1)!.width).toBeLessThanOrEqual(159)
    const stacked = { ...scene, nodes: [node] }
    const expanded = hovered.at(-1)!
    const hit = hitTestBadge(stacked, { [node.id]: badges }, expanded.x + 1, expanded.y + 1, () => hovered)
    expect(hit?.badge.id).toBe('detail.1')
    const overflow = entries[3]!
    expect(hitTestBadge(stacked, { [node.id]: badges }, overflow.x + 1, overflow.y + 1, () => entries)?.overflow).toEqual(badges.slice(3))
  })

  it('keeps a hovered top tab growing leftward from its right edge', () => {
    const node = { ...original, x: 0, y: 0, layout: { ...original.layout, width: 112 } }
    const top = badges.map((badge) => ({ ...badge, placement: 'above' as const }))
    const entries = layoutNodeBadges(node, top, { tokens })
    expect(entries[0]!.x + entries[0]!.width).toBe(112)
    const hovered = layoutNodeBadges(node, top, { tokens, hoveredId: 'detail.0' }).at(-1)!
    expect(hovered.compact).toBe(false)
    expect(hovered.x + hovered.width).toBe(112)
  })

  it('includes top and bottom lanes with live node coordinates', () => {
    const node = { ...original, x: -37, y: 19, layout: { ...original.layout, width: 112 } }
    const list = [{ ...badges[0]!, placement: 'above' as const }, ...badges]
    const bounds = nodeBadgeBounds(node, list, { tokens, outset: 4 })
    expect(bounds.x).toBe(-37)
    expect(bounds.y).toBe(19 - 4 - 3 - 20)
    expect(bounds.width).toBe(112)
    expect(bounds.y + bounds.height).toBe(19 + node.layout.height + 4 + 3 + 20)
    const shifted = nodeBadgeBounds({ ...node, x: 64, y: 72 }, list, { tokens, outset: 4 })
    expect(shifted.x - bounds.x).toBe(101)
    expect(shifted.y - bounds.y).toBe(53)
    expect(shifted.width).toBe(bounds.width)
    expect(shifted.height).toBe(bounds.height)
  })

  it('caps a tab\'s words at 120 px', () => {
    const node = { ...original, x: 0, y: 0, layout: { ...original.layout, width: 600 } }
    const [entry] = layoutNodeBadges(node, [{ id: 'long', glyph: 'A label much longer than any tab may show', icon: 'info', color: '#345678' }], { tokens, measureLabel })
    expect(entry!.width).toBe(12 + 14 + 4 + 120)
    expect(entry!.compact).toBe(false)
  })
})

describe('hitTestBadge', () => {
  const scene = sceneOf('exec-basic')
  const n0 = scene.nodes.find((n) => n.id === 'n0')!
  const layout = (node: (typeof scene.nodes)[number], list: readonly NodeBadge[]) => layoutNodeBadges(node, list, { tokens: defaultTokens })
  const rectOf = (node: (typeof scene.nodes)[number], list: readonly NodeBadge[], id: string) => {
    const entry = layout(node, list).find((candidate) => candidate.badge.id === id)!
    return { x: entry.x, y: entry.y, width: entry.width, height: entry.height }
  }
  const badges: BadgeMap = { n0: [ERROR_BADGE, SUBGRAPH_BADGE] }

  it('hits the badge at its rect center and returns the rect', () => {
    const r = rectOf(n0, badges.n0!, ERROR_BADGE.id)
    const hit = hitTestBadge(scene, badges, r.x + r.width / 2, r.y + r.height / 2, layout)
    expect(hit?.node.id).toBe('n0')
    expect(hit?.badge.id).toBe(ERROR_BADGE.id)
    expect(hit?.rect).toEqual(r)
  })

  it('hits the subgraph mark inside the title bar', () => {
    const r = rectOf(n0, badges.n0!, SUBGRAPH_BADGE.id)
    expect(r.y).toBeGreaterThan(n0.y)
    expect(hitTestBadge(scene, badges, r.x + 1, r.y + 1, layout)?.badge.id).toBe(SUBGRAPH_BADGE.id)
  })

  it('does not let presentation-only mode badges intercept node gestures', () => {
    const modeBadges: BadgeMap = { n0: [MUTED_BADGE, BYPASSED_BADGE] }
    for (const badge of modeBadges.n0!) {
      const r = rectOf(n0, modeBadges.n0!, badge.id)
      expect(hitTestBadge(scene, modeBadges, r.x + 1, r.y + 1, layout)).toBeUndefined()
    }
  })

  it('misses just outside a badge and on nodes without badges', () => {
    const r = rectOf(n0, badges.n0!, ERROR_BADGE.id)
    expect(hitTestBadge(scene, badges, r.x - 1, r.y + 1, layout)).toBeUndefined()
    const n1 = scene.nodes.find((n) => n.id === 'n1')!
    const r1 = rectOf(n1, [ERROR_BADGE], ERROR_BADGE.id)
    expect(hitTestBadge(scene, badges, r1.x + 1, r1.y + 1, layout)).toBeUndefined()
  })

  it('prefers the topmost (last-drawn) node when badges overlap', () => {
    const [a, b] = [scene.nodes[0]!, scene.nodes[1]!]
    // Stack b exactly on a (same position AND layout) so badge rects coincide.
    const stacked: Scene = { ...scene, nodes: [a, { ...b, x: a.x, y: a.y, layout: a.layout }] }
    const both: BadgeMap = { [a.id]: [ERROR_BADGE], [b.id]: [ERROR_BADGE] }
    const r = rectOf(a, [ERROR_BADGE], ERROR_BADGE.id)
    const hit = hitTestBadge(stacked, both, r.x + 2, r.y + 2, layout)
    expect(hit?.node.id).toBe(b.id)
  })

  it('hits each tab of the bottom lane', () => {
    const belowBadges: BadgeMap = { n0: [executionErrorBadge(2), LOG_INFO_BADGE] }
    const error = rectOf(n0, belowBadges.n0!, 'core.error')
    const info = rectOf(n0, belowBadges.n0!, 'core.log.info')
    expect(info.x).toBeGreaterThan(error.x)
    expect(hitTestBadge(scene, belowBadges, error.x + 1, error.y + 1, layout)?.badge.id).toBe('core.error')
    expect(hitTestBadge(scene, belowBadges, info.x + 1, info.y + 1, layout)?.badge.id).toBe('core.log.info')
  })

  it('does not hit a lower node badge hidden behind a later-drawn node body', () => {
    const lower = scene.nodes[0]!
    const badge = { id: 'test.arm', glyph: 'N', placement: 'above' as const, color: '#286a55' }
    const rect = rectOf(lower, [badge], badge.id)
    const blocker = { ...scene.nodes[1]!, x: rect.x, y: rect.y }
    const stacked: Scene = { ...scene, nodes: [lower, blocker] }

    expect(hitTestBadge(stacked, { [lower.id]: [badge] }, rect.x + 1, rect.y + 1, layout)).toBeUndefined()
  })
})
