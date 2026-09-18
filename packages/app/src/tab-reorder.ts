/** Geometry captured when a horizontal tab drag starts. */
export interface TabDragSlot {
  readonly id: string
  readonly left: number
  readonly right: number
}

export type TabDragPointerDisposition = 'start' | 'owner' | 'foreign'

/** Only an unowned pointer may start a session; an owner is never displaced. */
export function tabDragPointerDisposition(
  ownerPointerId: number | undefined,
  incomingPointerId: number,
): TabDragPointerDisposition {
  if (ownerPointerId === undefined) return 'start'
  return ownerPointerId === incomingPointerId ? 'owner' : 'foreign'
}

export type TabDragReleaseAction = 'click' | 'commit' | 'rollback'

export interface TabDragPreview {
  readonly order: readonly string[]
  /** Position immediately before the dragged tab in the live order. */
  readonly insertionIndex: number
}

export interface TabDragModel {
  readonly pointerId: number
  readonly tabId: string
  readonly startX: number
  readonly started: boolean
  readonly rolledBack: boolean
  readonly preview: TabDragPreview | undefined
}

export function beginTabDragModel(pointerId: number, tabId: string, startX: number): TabDragModel {
  return { pointerId, tabId, startX, started: false, rolledBack: false, preview: undefined }
}

/**
 * Advance one pointer-owned horizontal drag. Crossing the threshold creates
 * feedback even when the tab has not crossed a neighbor yet.
 */
export function moveTabDragModel(
  model: TabDragModel,
  pointerId: number,
  clientX: number,
  currentOrder: readonly string[],
  slots: readonly TabDragSlot[],
): TabDragModel {
  if (pointerId !== model.pointerId || model.rolledBack) return model
  if (!model.started && Math.abs(clientX - model.startX) < 4) return model
  const order = tabOrderAtPointer(currentOrder, model.tabId, slots, clientX)
  return {
    ...model,
    started: true,
    preview: { order, insertionIndex: order.indexOf(model.tabId) },
  }
}

/** Capture loss removes both lift and insertion feedback but retains owner state. */
export function rollbackTabDragModel(model: TabDragModel, pointerId: number): TabDragModel {
  if (pointerId !== model.pointerId || !model.started) return model
  return { ...model, rolledBack: true, preview: undefined }
}

/** A capture-lost drag rolls back even when its owner eventually releases. */
export function tabDragReleaseAction(model: TabDragModel): TabDragReleaseAction {
  return !model.started ? 'click' : model.rolledBack ? 'rollback' : 'commit'
}

/**
 * Compute a live tab-order preview from the pointer's horizontal position.
 * The dragged tab crosses another tab when the pointer crosses that tab's
 * center. Unknown/missing ids are ignored so a concurrent close cannot
 * manufacture an entry.
 */
export function tabOrderAtPointer(
  order: readonly string[],
  draggedId: string,
  slots: readonly TabDragSlot[],
  clientX: number,
): readonly string[] {
  if (!order.includes(draggedId)) return order
  const remaining = order.filter((id) => id !== draggedId)
  const centers = new Map(slots.map((slot) => [slot.id, (slot.left + slot.right) / 2]))
  const target = remaining.reduce(
    (index, id) => index + (clientX >= (centers.get(id) ?? Number.POSITIVE_INFINITY) ? 1 : 0),
    0,
  )
  return [...remaining.slice(0, target), draggedId, ...remaining.slice(target)]
}

/** Apply an id order while retaining the exact tab objects and any new tabs. */
export function applyTabOrder<T extends { readonly id: string }>(
  tabs: readonly T[],
  order: readonly string[],
): readonly T[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]))
  const ordered = order.flatMap((id) => {
    const tab = byId.get(id)
    if (!tab) return []
    byId.delete(id)
    return [tab]
  })
  return [...ordered, ...tabs.filter((tab) => byId.has(tab.id))]
}
