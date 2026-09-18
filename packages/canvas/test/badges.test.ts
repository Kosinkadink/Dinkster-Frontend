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
  parseObjectInfo,
  type ObjectInfoEntry,
  type WorkflowDocument,
} from '@dinkster/core'
import {
  BADGE_RIGHT_INSET,
  BADGE_SIZE,
  BADGE_STRIDE,
  badgeRect,
  BYPASSED_BADGE,
  ERROR_BADGE,
  executionErrorBadge,
  hitTestBadge,
  LOG_INFO_BADGE,
  logWarningBadge,
  MUTED_BADGE,
  PROBLEM_BLOCKING_WARNING_BADGE,
  PROBLEM_ERROR_BADGE,
  PROBLEM_WARNING_BADGE,
  SUBGRAPH_BADGE,
  type BadgeMap,
} from '../src/badges.js'
import { buildScene, type Scene } from '../src/scene.js'
import { defaultTokens } from '../src/tokens.js'
import type { TextMeasurer, WidgetMeasure } from '../src/layout.js'

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(coreRoot, rel), 'utf8'))

const { schemas } = parseObjectInfo(readJson('fixtures/object_info.json') as Record<string, ObjectInfoEntry>)
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

describe('badgeRect', () => {
  const scene = sceneOf('exec-basic')
  const n0 = scene.nodes.find((n) => n.id === 'n0')!

  it('index 0 is rightmost, centered in the header', () => {
    const r = badgeRect(n0, 0)
    expect(r.x).toBe(n0.x + n0.layout.width - BADGE_RIGHT_INSET)
    expect(r.y).toBe(n0.y + n0.layout.headerHeight / 2 - BADGE_SIZE / 2)
    expect(r.width).toBe(BADGE_SIZE)
    expect(r.height).toBe(BADGE_SIZE)
  })

  it('later indices step LEFT by the stride', () => {
    expect(badgeRect(n0, 1).x).toBe(badgeRect(n0, 0).x - BADGE_STRIDE)
    expect(badgeRect(n0, 2).x).toBe(badgeRect(n0, 0).x - 2 * BADGE_STRIDE)
  })

  it('allocates readable widths and spacing for word badges', () => {
    const badges = [ERROR_BADGE, MUTED_BADGE, BYPASSED_BADGE]
    const error = badgeRect(n0, 0, badges)
    const muted = badgeRect(n0, 1, badges)
    const bypassed = badgeRect(n0, 2, badges)

    expect(error.width).toBeGreaterThan(BADGE_SIZE)
    expect(muted.width).toBeGreaterThan(BADGE_SIZE)
    expect(bypassed.width).toBeGreaterThan(muted.width)
    expect(error.x + error.width).toBe(n0.x + n0.layout.width - BADGE_RIGHT_INSET + BADGE_SIZE)
    expect(error.x - (muted.x + muted.width)).toBe(BADGE_STRIDE - BADGE_SIZE)
    expect(muted.x - (bypassed.x + bypassed.width)).toBe(BADGE_STRIDE - BADGE_SIZE)
  })

  it('places above-node badges in a separate right-aligned lane', () => {
    const header = ERROR_BADGE
    const above = { id: 'test.arm', glyph: 'COMFYUI', variant: 'label' as const, placement: 'above' as const, color: '#6a4fa3' }
    const badges = [header, above]
    const headerRect = badgeRect(n0, 0, badges)
    const aboveRect = badgeRect(n0, 1, badges)

    expect(headerRect.y).toBe(n0.y + n0.layout.headerHeight / 2 - BADGE_SIZE / 2)
    expect(aboveRect.y + aboveRect.height).toBe(n0.y)
    expect(aboveRect.x + aboveRect.width).toBe(n0.x + n0.layout.width)
  })

  it('places below-node badges in a left-aligned lane on the bottom edge', () => {
    const badges = [executionErrorBadge(1), logWarningBadge(2), LOG_INFO_BADGE]
    const error = badgeRect(n0, 0, badges)
    const warning = badgeRect(n0, 1, badges)
    const info = badgeRect(n0, 2, badges)

    // Left-aligned, flowing right: error, warning, info.
    const gap = BADGE_STRIDE - BADGE_SIZE
    expect(error.x).toBe(n0.x)
    expect(error.y).toBe(n0.y + n0.layout.height)
    expect(warning.x).toBe(error.x + error.width + gap)
    expect(info.x).toBe(warning.x + warning.width + gap)
    expect(info.y).toBe(error.y)
    expect(error.width).toBeGreaterThan(BADGE_SIZE) // word badge
    expect(info.width).toBe(BADGE_SIZE) // compact dot
  })

  it('the below lane offsets independently of header and above badges', () => {
    const badges = [ERROR_BADGE, { id: 'test.arm', glyph: 'N', placement: 'above' as const, color: '#286a55' }, LOG_INFO_BADGE]
    // LOG_INFO_BADGE is the only below badge: no preceding width in ITS lane.
    expect(badgeRect(n0, 2, badges).x).toBe(n0.x)
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

  it('hits the full width of a word badge', () => {
    const wordBadges: BadgeMap = { n0: [ERROR_BADGE] }
    const r = badgeRect(n0, 0, wordBadges.n0)
    const hit = hitTestBadge(scene, wordBadges, r.x + 1, r.y + 1)
    expect(hit?.badge).toBe(ERROR_BADGE)
    expect(hit?.rect).toEqual(r)
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

describe('document problem badges', () => {
  it('keep error, blocking warning, advisory warning, and runtime identities distinct', () => {
    expect(new Set([
      ERROR_BADGE.id,
      PROBLEM_ERROR_BADGE.id,
      PROBLEM_BLOCKING_WARNING_BADGE.id,
      PROBLEM_WARNING_BADGE.id,
    ]).size).toBe(4)
    expect(PROBLEM_ERROR_BADGE.color).not.toBe(PROBLEM_WARNING_BADGE.color)
    expect(PROBLEM_BLOCKING_WARNING_BADGE.color).not.toBe(PROBLEM_WARNING_BADGE.color)
  })
})
