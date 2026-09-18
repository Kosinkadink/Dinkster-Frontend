/**
 * Editor split layout model (#105): pure group/split tree with one focused
 * group, repaired against the open-tab list at the read boundary so
 * tab-close code stays tree-blind.
 */
import { describe, expect, it } from 'vitest'
import {
  clampSplitRatio,
  decodeEditorLayout,
  dissolveGroup,
  encodeEditorLayout,
  findGroup,
  focusedGroup,
  focusGroup,
  layoutGroups,
  MAX_SPLIT_DEPTH,
  moveTabToGroup,
  nextGroupId,
  repairEditorLayout,
  setActiveTab,
  setGroupTabOrder,
  setSplitRatioAt,
  singleGroupLayout,
  splitGroup,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  type EditorGroup,
  type EditorLayout,
  type EditorLayoutNode,
  type EditorSplit,
} from '../src/editor-layout.js'

const group = (id: string, tabIds: readonly string[], activeTabId = tabIds[0] ?? ''): EditorGroup => ({
  kind: 'group',
  id,
  tabIds,
  activeTabId,
})

const split = (
  first: EditorLayoutNode,
  second: EditorLayoutNode,
  direction: 'row' | 'column' = 'row',
  ratio = 0.5,
): EditorSplit => ({ kind: 'split', direction, ratio, first, second })

const layout = (root: EditorLayoutNode, focusedGroupId: string): EditorLayout => ({ root, focusedGroupId })

const twoGroups = (): EditorLayout =>
  layout(split(group('group-1', ['a', 'b']), group('group-2', ['c'])), 'group-1')

describe('structure helpers', () => {
  it('singleGroupLayout defaults, and falls back when the active tab is not open there', () => {
    expect(singleGroupLayout()).toEqual({
      root: { kind: 'group', id: 'group-1', tabIds: [], activeTabId: '' },
      focusedGroupId: 'group-1',
    })
    expect(singleGroupLayout(['a', 'b'], 'b').root).toMatchObject({ activeTabId: 'b' })
    expect(singleGroupLayout(['a', 'b'], 'ghost').root).toMatchObject({ activeTabId: 'a' })
  })

  it('layoutGroups walks reading order and findGroup/focusedGroup resolve ids', () => {
    const tree = layout(split(split(group('g1', ['a']), group('g2', ['b'])), group('g3', ['c'])), 'g2')
    expect(layoutGroups(tree.root).map((g) => g.id)).toEqual(['g1', 'g2', 'g3'])
    expect(findGroup(tree, 'g3')?.tabIds).toEqual(['c'])
    expect(findGroup(tree, 'nope')).toBeUndefined()
    expect(focusedGroup(tree).id).toBe('g2')
    expect(focusedGroup(layout(tree.root, 'gone')).id).toBe('g1')
  })

  it('nextGroupId picks the smallest unused numbered id', () => {
    expect(nextGroupId(twoGroups())).toBe('group-3')
    expect(nextGroupId(layout(split(group('group-2', ['a']), group('group-3', ['b'])), 'group-2'))).toBe('group-1')
  })

  it('clampSplitRatio bounds ratios and rescues non-finite values', () => {
    expect(clampSplitRatio(0.5)).toBe(0.5)
    expect(clampSplitRatio(0)).toBe(SPLIT_RATIO_MIN)
    expect(clampSplitRatio(1)).toBe(SPLIT_RATIO_MAX)
    expect(clampSplitRatio(Number.NaN)).toBe(0.5)
    expect(clampSplitRatio(Number.POSITIVE_INFINITY)).toBe(0.5)
  })
})

describe('splitGroup', () => {
  it('moves the tab into a new second group and focuses it', () => {
    const next = splitGroup(singleGroupLayout(['a', 'b']), 'group-1', 'row', 'b')
    expect(next.root).toEqual(
      split(group('group-1', ['a']), group('group-2', ['b'])),
    )
    expect(next.focusedGroupId).toBe('group-2')
  })

  it('can pull the tab from a different group; an emptied source prunes away', () => {
    const start = twoGroups()
    const next = splitGroup(start, 'group-1', 'column', 'c')
    const ids = layoutGroups(next.root).map((g) => g.id)
    expect(ids).toEqual(['group-1', 'group-3'])
    expect(findGroup(next, 'group-3')?.tabIds).toEqual(['c'])
    expect(next.focusedGroupId).toBe('group-3')
  })

  it('refuses unknown groups or tabs, and a sole tab splitting its own group', () => {
    const start = twoGroups()
    expect(splitGroup(start, 'ghost', 'row', 'a')).toBe(start)
    expect(splitGroup(start, 'group-1', 'row', 'ghost')).toBe(start)
    expect(splitGroup(start, 'group-2', 'row', 'c')).toBe(start)
  })

  it('refuses only splits whose result would exceed MAX_SPLIT_DEPTH', () => {
    let tree = singleGroupLayout(['t1', 't2', 't3', 't4', 't5', 't6'])
    for (let n = 0; n < MAX_SPLIT_DEPTH; n += 1) {
      tree = splitGroup(tree, tree.focusedGroupId, 'row', `t${n + 2}`)
    }
    expect(layoutGroups(tree.root)).toHaveLength(MAX_SPLIT_DEPTH + 1)
    // Splitting the deepest group would nest one level too far.
    expect(splitGroup(tree, tree.focusedGroupId, 'row', 't6')).toBe(tree)
    // A shallow branch still has headroom even though the tree is at max depth.
    const shallow = splitGroup(tree, 'group-1', 'row', 't6')
    expect(shallow).not.toBe(tree)
    expect(layoutGroups(shallow.root)).toHaveLength(MAX_SPLIT_DEPTH + 2)
  })

  it('keeps the source group active tab sensible after the move', () => {
    const start = layout(group('g1', ['a', 'b', 'c'], 'b'), 'g1')
    const next = splitGroup(start, 'g1', 'row', 'b')
    expect(findGroup(next, 'g1')).toMatchObject({ tabIds: ['a', 'c'], activeTabId: 'c' })
  })

  it('position first puts the new group on the left/top side', () => {
    const next = splitGroup(singleGroupLayout(['a', 'b']), 'group-1', 'row', 'b', 'first')
    expect(next.root).toEqual(split(group('group-2', ['b']), group('group-1', ['a'])))
    expect(next.focusedGroupId).toBe('group-2')
    const down = splitGroup(singleGroupLayout(['a', 'b']), 'group-1', 'column', 'b', 'first')
    expect(down.root).toEqual(split(group('group-2', ['b']), group('group-1', ['a']), 'column'))
  })
})

describe('setGroupTabOrder', () => {
  it('reorders the strip with a permutation of the current tabs', () => {
    const start = layout(split(group('g1', ['a', 'b', 'c'], 'b'), group('g2', ['d'])), 'g1')
    const next = setGroupTabOrder(start, 'g1', ['c', 'a', 'b'])
    expect(findGroup(next, 'g1')).toMatchObject({ tabIds: ['c', 'a', 'b'], activeTabId: 'b' })
    expect(findGroup(next, 'g2')?.tabIds).toEqual(['d'])
    expect(next.focusedGroupId).toBe('g1')
  })

  it('refuses non-permutations and unknown groups', () => {
    const start = layout(group('g1', ['a', 'b']), 'g1')
    expect(setGroupTabOrder(start, 'g1', ['a'])).toBe(start)
    expect(setGroupTabOrder(start, 'g1', ['a', 'ghost'])).toBe(start)
    expect(setGroupTabOrder(start, 'g1', ['a', 'a'])).toBe(start)
    expect(setGroupTabOrder(start, 'ghost', ['a', 'b'])).toBe(start)
  })
})

describe('dissolveGroup', () => {
  it('merges into the previous group in reading order, carrying the active tab and focus', () => {
    const next = dissolveGroup(twoGroups(), 'group-2')
    expect(next.root).toEqual(group('group-1', ['a', 'b', 'c'], 'c'))
    expect(next.focusedGroupId).toBe('group-1')
  })

  it('the first group merges into the next one', () => {
    const next = dissolveGroup(twoGroups(), 'group-1')
    expect(next.root).toEqual(group('group-2', ['c', 'a', 'b'], 'a'))
    expect(next.focusedGroupId).toBe('group-2')
  })

  it('refuses unknown groups and the only group', () => {
    const start = twoGroups()
    expect(dissolveGroup(start, 'ghost')).toBe(start)
    const single = singleGroupLayout(['a'])
    expect(dissolveGroup(single, 'group-1')).toBe(single)
  })
})

describe('moveTabToGroup', () => {
  it('moves between groups, activates the tab, and focuses the target', () => {
    const next = moveTabToGroup(twoGroups(), 'a', 'group-2')
    expect(findGroup(next, 'group-1')).toMatchObject({ tabIds: ['b'], activeTabId: 'b' })
    expect(findGroup(next, 'group-2')).toMatchObject({ tabIds: ['c', 'a'], activeTabId: 'a' })
    expect(next.focusedGroupId).toBe('group-2')
  })

  it('collapses the split when the source group empties', () => {
    const next = moveTabToGroup(twoGroups(), 'c', 'group-1')
    expect(next.root).toEqual(group('group-1', ['a', 'b', 'c'], 'c'))
    expect(next.focusedGroupId).toBe('group-1')
  })

  it('reorders within a group at a clamped index', () => {
    const start = layout(group('g1', ['a', 'b', 'c']), 'g1')
    expect((moveTabToGroup(start, 'c', 'g1', 0).root as EditorGroup).tabIds).toEqual(['c', 'a', 'b'])
    expect((moveTabToGroup(start, 'a', 'g1', 99).root as EditorGroup).tabIds).toEqual(['b', 'c', 'a'])
  })

  it('refuses unknown tabs or targets', () => {
    const start = twoGroups()
    expect(moveTabToGroup(start, 'ghost', 'group-2')).toBe(start)
    expect(moveTabToGroup(start, 'a', 'ghost')).toBe(start)
  })
})

describe('activation and focus', () => {
  it('setActiveTab sets only known group/tab pairs', () => {
    const start = twoGroups()
    expect(findGroup(setActiveTab(start, 'group-1', 'b'), 'group-1')?.activeTabId).toBe('b')
    expect(setActiveTab(start, 'group-1', 'c')).toBe(start)
    expect(setActiveTab(start, 'ghost', 'a')).toBe(start)
  })

  it('focusGroup refuses unknown groups', () => {
    const start = twoGroups()
    expect(focusGroup(start, 'group-2').focusedGroupId).toBe('group-2')
    expect(focusGroup(start, 'ghost')).toBe(start)
  })
})

describe('setSplitRatioAt', () => {
  it('sets and clamps the ratio at a path', () => {
    const tree = layout(split(split(group('g1', ['a']), group('g2', ['b']), 'row', 0.5), group('g3', ['c'])), 'g1')
    const next = setSplitRatioAt(tree, ['first'], 0.99)
    expect(((next.root as EditorSplit).first as EditorSplit).ratio).toBe(SPLIT_RATIO_MAX)
    expect((setSplitRatioAt(tree, [], 0.3).root as EditorSplit).ratio).toBe(0.3)
  })

  it('refuses paths that do not land on a split', () => {
    const tree = twoGroups()
    expect(setSplitRatioAt(tree, ['first'], 0.3)).toBe(tree)
    const single = singleGroupLayout(['a'])
    expect(setSplitRatioAt(single, [], 0.3)).toBe(single)
  })
})

describe('repairEditorLayout', () => {
  it('drops unknown tabs and duplicates (first group wins), restoring active tabs', () => {
    const tree = layout(split(group('g1', ['a', 'gone'], 'gone'), group('g2', ['a', 'b'])), 'g1')
    const next = repairEditorLayout(tree, ['a', 'b'])
    expect(findGroup(next, 'g1')).toMatchObject({ tabIds: ['a'], activeTabId: 'a' })
    expect(findGroup(next, 'g2')).toMatchObject({ tabIds: ['b'], activeTabId: 'b' })
  })

  it('drops a duplicate within one group, keeping the first occurrence', () => {
    const tree = layout(group('g1', ['a', 'a', 'b'], 'b'), 'g1')
    expect(repairEditorLayout(tree, ['a', 'b']).root).toMatchObject({ tabIds: ['a', 'b'], activeTabId: 'b' })
  })

  it('appends orphan open tabs to the focused group in open order', () => {
    const tree = layout(split(group('g1', ['a']), group('g2', ['b'])), 'g2')
    const next = repairEditorLayout(tree, ['a', 'b', 'new1', 'new2'])
    expect(findGroup(next, 'g2')).toMatchObject({ tabIds: ['b', 'new1', 'new2'], activeTabId: 'b' })
  })

  it('adopts orphans into the first group when the focused group is gone, and activates one if empty', () => {
    const tree = layout(split(group('g1', ['gone']), group('g2', ['b'])), 'g1')
    const next = repairEditorLayout(tree, ['b', 'x'])
    expect(layoutGroups(next.root).map((g) => g.id)).toEqual(['g1', 'g2'])
    expect(findGroup(next, 'g1')).toMatchObject({ tabIds: ['x'], activeTabId: 'x' })
    expect(next.focusedGroupId).toBe('g1')
  })

  it('prunes emptied groups and collapses the remaining split', () => {
    const tree = layout(split(group('g1', ['gone']), group('g2', ['b'])), 'g2')
    const next = repairEditorLayout(tree, ['b'])
    expect(next.root).toMatchObject({ kind: 'group', id: 'g2', tabIds: ['b'] })
    expect(next.focusedGroupId).toBe('g2')
  })

  it('yields a fresh single group when nothing survives', () => {
    const tree = layout(split(group('g1', ['gone']), group('g2', ['also-gone'])), 'g1')
    expect(repairEditorLayout(tree, [])).toEqual(singleGroupLayout())
  })

  it('moves focus to a surviving group when the focused one prunes away', () => {
    const tree = layout(split(group('g1', ['gone']), group('g2', ['b'])), 'g1')
    expect(repairEditorLayout(tree, ['b']).focusedGroupId).toBe('g2')
  })
})

describe('encode/decode read boundary (FR11)', () => {
  it('round-trips a split tree', () => {
    const tree = layout(split(group('g1', ['a', 'b'], 'b'), group('g2', ['c']), 'column', 0.3), 'g2')
    expect(decodeEditorLayout(encodeEditorLayout(tree))).toEqual(tree)
  })

  it('refuses garbage, wrong versions, and structural tampering', () => {
    expect(decodeEditorLayout('')).toBeUndefined()
    expect(decodeEditorLayout('not json')).toBeUndefined()
    expect(decodeEditorLayout('{"v":2,"root":{},"focusedGroupId":"g1"}')).toBeUndefined()
    expect(decodeEditorLayout(JSON.stringify({ v: 1, root: { kind: 'mystery' }, focusedGroupId: 'g1' }))).toBeUndefined()
    expect(decodeEditorLayout(JSON.stringify({ v: 1, root: group('g1', ['a']), focusedGroupId: 42 }))).toBeUndefined()
    expect(
      decodeEditorLayout(
        JSON.stringify({ v: 1, root: { kind: 'group', id: 'g1', tabIds: ['a', 1], activeTabId: 'a' }, focusedGroupId: 'g1' }),
      ),
    ).toBeUndefined()
  })

  it('refuses duplicate group ids and duplicate tab ids, across and within groups', () => {
    expect(
      decodeEditorLayout(encodeEditorLayout(layout(split(group('g1', ['a']), group('g1', ['b'])), 'g1'))),
    ).toBeUndefined()
    expect(
      decodeEditorLayout(encodeEditorLayout(layout(split(group('g1', ['a']), group('g2', ['a'])), 'g1'))),
    ).toBeUndefined()
    expect(
      decodeEditorLayout(encodeEditorLayout(layout(group('g1', ['a', 'a']), 'g1'))),
    ).toBeUndefined()
  })

  it('refuses over-deep trees', () => {
    let node: EditorLayoutNode = group('g0', ['t0'])
    for (let n = 1; n <= MAX_SPLIT_DEPTH; n += 1) node = split(node, group(`g${n}`, [`t${n}`]))
    expect(decodeEditorLayout(encodeEditorLayout(layout(node, 'g0')))).toEqual(layout(node, 'g0'))
    const tooDeep = split(node, group('gx', ['tx']))
    expect(decodeEditorLayout(encodeEditorLayout(layout(tooDeep, 'g0')))).toBeUndefined()
  })

  it('restores invariants: clamps ratios, fixes stray active tabs, re-homes lost focus', () => {
    const raw = JSON.stringify({
      v: 1,
      root: {
        kind: 'split',
        direction: 'row',
        ratio: 7,
        first: { kind: 'group', id: 'g1', tabIds: ['a'], activeTabId: 'ghost' },
        second: { kind: 'group', id: 'g2', tabIds: ['b'], activeTabId: 'b' },
      },
      focusedGroupId: 'gone',
    })
    const decoded = decodeEditorLayout(raw)!
    expect((decoded.root as EditorSplit).ratio).toBe(SPLIT_RATIO_MAX)
    expect(findGroup(decoded, 'g1')?.activeTabId).toBe('a')
    expect(decoded.focusedGroupId).toBe('g1')
  })
})
