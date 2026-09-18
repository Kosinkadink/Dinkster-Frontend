import { describe, expect, it } from 'vitest'
import {
  applyTabOrder,
  beginTabDragModel,
  moveTabDragModel,
  rollbackTabDragModel,
  tabDragPointerDisposition,
  tabDragReleaseAction,
  tabOrderAtPointer,
  type TabDragSlot,
} from '../src/tab-reorder.js'

const order = ['a', 'b', 'c', 'd'] as const
const slots: readonly TabDragSlot[] = order.map((id, index) => ({
  id,
  left: index * 100,
  right: index * 100 + 100,
}))

describe('tab pointer reorder', () => {
  it('never lets a foreign pointer displace the session owner', () => {
    expect(tabDragPointerDisposition(undefined, 7)).toBe('start')
    expect(tabDragPointerDisposition(7, 7)).toBe('owner')
    expect(tabDragPointerDisposition(7, 8)).toBe('foreign')
  })

  it('commits only an uninterrupted drag and rolls back capture loss', () => {
    const pending = beginTabDragModel(7, 'b', 150)
    const dragging = moveTabDragModel(pending, 7, 275, order, slots)
    expect(tabDragReleaseAction(pending)).toBe('click')
    expect(tabDragReleaseAction(dragging)).toBe('commit')
    expect(tabDragReleaseAction(rollbackTabDragModel(dragging, 7))).toBe('rollback')
  })

  it('crossing the pointer threshold immediately exposes lift and insertion feedback', () => {
    const pending = beginTabDragModel(7, 'b', 150)
    expect(moveTabDragModel(pending, 7, 153, order, slots).preview).toBeUndefined()

    const dragging = moveTabDragModel(pending, 7, 154, order, slots)
    expect(dragging.started).toBe(true)
    expect(dragging.preview).toEqual({ order, insertionIndex: 1 })
  })

  it('tracks an insertion indicator while the pointer is between tab centers', () => {
    const pending = beginTabDragModel(7, 'b', 150)
    const dragging = moveTabDragModel(pending, 7, 300, order, slots)
    expect(dragging.preview).toEqual({ order: ['a', 'c', 'b', 'd'], insertionIndex: 2 })
  })

  it('capture-loss rollback clears lift and insertion feedback', () => {
    const pending = beginTabDragModel(7, 'b', 150)
    const dragging = moveTabDragModel(pending, 7, 300, order, slots)
    const rolledBack = rollbackTabDragModel(dragging, 7)
    expect(rolledBack.started).toBe(true)
    expect(rolledBack.rolledBack).toBe(true)
    expect(rolledBack.preview).toBeUndefined()
  })

  it('moves left and right when the pointer crosses tab centers', () => {
    expect(tabOrderAtPointer(order, 'b', slots, 25)).toEqual(['b', 'a', 'c', 'd'])
    expect(tabOrderAtPointer(order, 'b', slots, 275)).toEqual(['a', 'c', 'b', 'd'])
    expect(tabOrderAtPointer(order, 'b', slots, 450)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('keeps the original order before a neighboring center is crossed', () => {
    expect(tabOrderAtPointer(order, 'b', slots, 149)).toEqual(order)
    expect(tabOrderAtPointer(order, 'b', slots, 249)).toEqual(order)
  })

  it('ignores an unknown dragged id', () => {
    expect(tabOrderAtPointer(order, 'missing', slots, 450)).toBe(order)
  })

  it('applies the preview with exact objects and retains concurrent additions', () => {
    const a = { id: 'a', value: 1 }
    const b = { id: 'b', value: 2 }
    const c = { id: 'c', value: 3 }
    expect(applyTabOrder([a, b, c], ['c', 'a'])).toEqual([c, a, b])
    expect(applyTabOrder([a, b, c], ['c', 'a'])[0]).toBe(c)
  })
})
