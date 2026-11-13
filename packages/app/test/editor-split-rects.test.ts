/**
 * Editor split geometry (#165): pure pixel rects for group panes and
 * dividers inside the center region, plus tab-drag drop-zone resolution.
 */
import { describe, expect, it } from 'vitest'
import {
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  type EditorGroup,
  type EditorLayoutNode,
  type EditorSplit,
} from '../src/editor-layout.js'
import { computeSplitRects, splitDropPreviewRect, splitDropTargetAt, splitRatioAtPointer, SPLIT_DIVIDER_THICKNESS, type SplitRect } from '../src/editor-split-rects.js'

const group = (id: string, tabIds: readonly string[] = ['t']): EditorGroup => ({
  kind: 'group',
  id,
  tabIds,
  activeTabId: tabIds[0] ?? '',
})

const split = (
  first: EditorLayoutNode,
  second: EditorLayoutNode,
  direction: 'row' | 'column' = 'row',
  ratio = 0.5,
): EditorSplit => ({ kind: 'split', direction, ratio, first, second })

const region: SplitRect = { x: 0, y: 0, width: 806, height: 600 }

describe('computeSplitRects', () => {
  it('a single group fills the container and yields no dividers', () => {
    const rects = computeSplitRects(group('g1'), region)
    expect(rects.groups).toEqual([{ id: 'g1', rect: region }])
    expect(rects.dividers).toEqual([])
  })

  it('a row split places panes left/right of a full-height divider', () => {
    const rects = computeSplitRects(split(group('g1'), group('g2')), region)
    // usable = 806 - 6 = 800, first = 400
    expect(rects.groups).toEqual([
      { id: 'g1', rect: { x: 0, y: 0, width: 400, height: 600 } },
      { id: 'g2', rect: { x: 406, y: 0, width: 400, height: 600 } },
    ])
    expect(rects.dividers).toEqual([
      {
        path: [],
        direction: 'row',
        ratio: 0.5,
        rect: { x: 400, y: 0, width: SPLIT_DIVIDER_THICKNESS, height: 600 },
        area: region,
      },
    ])
  })

  it('a column split stacks panes above/below a full-width divider', () => {
    const rects = computeSplitRects(split(group('g1'), group('g2'), 'column', 0.25), {
      x: 10,
      y: 20,
      width: 400,
      height: 306,
    })
    // usable = 300, first = 75
    expect(rects.groups).toEqual([
      { id: 'g1', rect: { x: 10, y: 20, width: 400, height: 75 } },
      { id: 'g2', rect: { x: 10, y: 101, width: 400, height: 225 } },
    ])
    expect(rects.dividers[0]).toMatchObject({
      direction: 'column',
      rect: { x: 10, y: 95, width: 400, height: SPLIT_DIVIDER_THICKNESS },
    })
  })

  it('nested splits carry setSplitRatioAt paths and their own areas', () => {
    const tree = split(split(group('g1'), group('g2'), 'column'), group('g3'))
    const rects = computeSplitRects(tree, region)
    expect(rects.groups.map((pane) => pane.id)).toEqual(['g1', 'g2', 'g3'])
    expect(rects.dividers.map((divider) => divider.path)).toEqual([['first'], []])
    const inner = rects.dividers[0]!
    expect(inner.area).toEqual({ x: 0, y: 0, width: 400, height: 600 })
    expect(rects.dividers[1]!.area).toEqual(region)
  })

})

describe('splitRatioAtPointer', () => {
  const divider = computeSplitRects(split(group('g1'), group('g2')), region).dividers[0]!

  it('maps the pointer position along the split axis to a clamped ratio', () => {
    expect(splitRatioAtPointer(divider, 403, 300)).toBe(0.5)
    expect(splitRatioAtPointer(divider, 203, 300)).toBe(0.25)
    expect(splitRatioAtPointer(divider, -500, 300)).toBe(SPLIT_RATIO_MIN)
    expect(splitRatioAtPointer(divider, 5000, 300)).toBe(SPLIT_RATIO_MAX)
  })

  it('uses the vertical axis for column dividers', () => {
    const column = computeSplitRects(split(group('g1'), group('g2'), 'column'), region).dividers[0]!
    // usable = 600 - 6 = 594; (300 - 3) / 594 = 0.5
    expect(splitRatioAtPointer(column, 0, 300)).toBe(0.5)
    expect(splitRatioAtPointer(column, 0, -100)).toBe(SPLIT_RATIO_MIN)
  })

})

describe('splitDropTargetAt', () => {
  const rects = computeSplitRects(split(group('g1'), group('g2')), region)
  // g1 pane: 0..400 wide, 600 tall; bands: x = min(100, 160) = 100, y = min(150, 160) = 150

  it('resolves edge bands, center, and the containing pane', () => {
    expect(splitDropTargetAt(rects, 50, 300)).toEqual({ groupId: 'g1', zone: 'left' })
    expect(splitDropTargetAt(rects, 350, 300)).toEqual({ groupId: 'g1', zone: 'right' })
    expect(splitDropTargetAt(rects, 200, 50)).toEqual({ groupId: 'g1', zone: 'top' })
    expect(splitDropTargetAt(rects, 200, 550)).toEqual({ groupId: 'g1', zone: 'bottom' })
    expect(splitDropTargetAt(rects, 200, 300)).toEqual({ groupId: 'g1', zone: 'center' })
    expect(splitDropTargetAt(rects, 606, 300)).toEqual({ groupId: 'g2', zone: 'center' })
  })

})

describe('drop previews and operations', () => {
  const pane: SplitRect = { x: 100, y: 50, width: 200, height: 100 }

  it('previews the claimed half, or the whole pane for center', () => {
    expect(splitDropPreviewRect(pane, 'left')).toEqual({ x: 100, y: 50, width: 100, height: 100 })
    expect(splitDropPreviewRect(pane, 'right')).toEqual({ x: 200, y: 50, width: 100, height: 100 })
    expect(splitDropPreviewRect(pane, 'top')).toEqual({ x: 100, y: 50, width: 200, height: 50 })
    expect(splitDropPreviewRect(pane, 'bottom')).toEqual({ x: 100, y: 100, width: 200, height: 50 })
    expect(splitDropPreviewRect(pane, 'center')).toEqual(pane)
  })

})
