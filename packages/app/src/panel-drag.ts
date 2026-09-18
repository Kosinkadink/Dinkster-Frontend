import { DOCK_ZONE_IDS, MAX_ZONE_SECTIONS, type DockZoneId } from './dock-layout.js'

export const PANEL_DRAG_THRESHOLD = 4
export const DOCK_EDGE_TARGET_SIZE = 24
const GHOST_BAR_SIZE = 6

export interface PanelDragPoint {
  readonly x: number
  readonly y: number
}

export interface PanelDragRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface PanelDragTabSlot {
  readonly id: string
  readonly rect: PanelDragRect
}

export interface PanelDragTabStripSnapshot {
  readonly rect: PanelDragRect
  readonly slots: readonly PanelDragTabSlot[]
}

export interface PanelDragSectionGeometry {
  /** Index of this rendered section in the zone's DockZoneState.sections. */
  readonly section: number
  readonly bodyRect: PanelDragRect
  readonly tabStrip: PanelDragTabStripSnapshot
  readonly appendRects?: readonly PanelDragRect[]
}

export interface PanelDragVisibleZoneGeometry {
  readonly rect: PanelDragRect
  readonly sections: readonly PanelDragSectionGeometry[]
}

export interface PanelDragSnapshotInput {
  readonly viewportRect: PanelDragRect
  readonly centerRect: PanelDragRect
  readonly canvasRect: PanelDragRect
  readonly zoneSizes: Readonly<Record<DockZoneId, number>>
  /** Tab ids per state section, in section order. */
  readonly zoneOrders: Readonly<Record<DockZoneId, readonly (readonly string[])[]>>
  readonly visibleZones?: Partial<Record<DockZoneId, PanelDragVisibleZoneGeometry>>
}

export interface PanelDragSectionSnapshot {
  readonly section: number
  readonly bodyRect: PanelDragRect
  readonly tabStrip: PanelDragTabStripSnapshot
  readonly appendRects: readonly PanelDragRect[]
}

export interface PanelDragZoneSnapshot {
  readonly zone: DockZoneId
  readonly open: boolean
  readonly edgeRect: PanelDragRect
  readonly ghostRect: PanelDragRect
  readonly previewRect: PanelDragRect
  /** Tab ids per state section, in section order. */
  readonly sectionOrders: readonly (readonly string[])[]
  readonly sections: readonly PanelDragSectionSnapshot[]
  /**
   * Drop area that creates a second section: the far half of a lone
   * section's body (lower half for the side zones, right half for the
   * bottom zone). Undefined when the zone is closed, already sectioned,
   * or has nothing else to leave behind.
   */
  readonly splitRect: PanelDragRect | undefined
}

export interface PanelDragSnapshot {
  readonly viewportRect: PanelDragRect
  readonly canvasRect: PanelDragRect
  readonly zones: Readonly<Record<DockZoneId, PanelDragZoneSnapshot>>
}

export type PanelDragTarget =
  | { readonly kind: 'tab'; readonly zone: DockZoneId; readonly section: number; readonly index: number }
  | { readonly kind: 'zone'; readonly zone: DockZoneId; readonly section: number; readonly index: number }
  | { readonly kind: 'split'; readonly zone: DockZoneId; readonly section: number }
  | { readonly kind: 'edge'; readonly zone: DockZoneId; readonly index: number }
  | { readonly kind: 'floating' }

export interface PanelDragLegality {
  readonly zones: readonly DockZoneId[]
  readonly floating: boolean
}

export interface PanelDragPreview {
  readonly target: PanelDragTarget
  readonly allowed: boolean
}

export interface PanelDragModel {
  readonly pointerId: number
  readonly panelId: string
  readonly start: PanelDragPoint
  /** Last pointer position accepted by a move; drives the cursor ghost. */
  readonly point: PanelDragPoint
  readonly started: boolean
  readonly rolledBack: boolean
  readonly snapshot: PanelDragSnapshot
  readonly legality: PanelDragLegality
  readonly preview: PanelDragPreview | undefined
}

export type PanelDragPointerDisposition = 'start' | 'owner' | 'foreign'
export type PanelDragReleaseAction = 'click' | 'commit' | 'refuse' | 'rollback'

export interface PanelDragReleaseGeometry {
  readonly snapshot: PanelDragSnapshot
  readonly point: PanelDragPoint
}

export interface PanelDragTargetGeometry {
  readonly rect: PanelDragRect
  readonly caret: PanelDragRect | undefined
}

const rectWidth = (rect: PanelDragRect): number => Math.max(0, rect.right - rect.left)
const rectHeight = (rect: PanelDragRect): number => Math.max(0, rect.bottom - rect.top)

const intersectRect = (first: PanelDragRect, second: PanelDragRect): PanelDragRect | undefined => {
  const intersection = {
    left: Math.max(first.left, second.left),
    top: Math.max(first.top, second.top),
    right: Math.min(first.right, second.right),
    bottom: Math.min(first.bottom, second.bottom),
  }
  return rectWidth(intersection) > 0 && rectHeight(intersection) > 0 ? intersection : undefined
}

const zonePreviewRect = (
  center: PanelDragRect,
  zone: DockZoneId,
  requestedSize: number,
): PanelDragRect => {
  const size = zone === 'bottom'
    ? Math.min(Math.max(0, requestedSize), rectHeight(center))
    : Math.min(Math.max(0, requestedSize), rectWidth(center))
  if (zone === 'left') return { ...center, right: center.left + size }
  if (zone === 'right') return { ...center, left: center.right - size }
  return { ...center, top: center.bottom - size }
}

const edgeRect = (viewport: PanelDragRect, zone: DockZoneId): PanelDragRect => {
  if (zone === 'left') {
    return { ...viewport, right: viewport.left + DOCK_EDGE_TARGET_SIZE, bottom: viewport.bottom - DOCK_EDGE_TARGET_SIZE }
  }
  if (zone === 'right') {
    return { ...viewport, left: viewport.right - DOCK_EDGE_TARGET_SIZE, bottom: viewport.bottom - DOCK_EDGE_TARGET_SIZE }
  }
  return { ...viewport, top: viewport.bottom - DOCK_EDGE_TARGET_SIZE }
}

const ghostRect = (preview: PanelDragRect, zone: DockZoneId): PanelDragRect => {
  if (zone === 'left') return { ...preview, right: preview.left + GHOST_BAR_SIZE }
  if (zone === 'right') return { ...preview, left: preview.right - GHOST_BAR_SIZE }
  return { ...preview, top: preview.bottom - GHOST_BAR_SIZE }
}

/** The far half of a lone section's body, where a drop opens a second section. */
const splitRectOf = (zone: DockZoneId, body: PanelDragRect): PanelDragRect =>
  zone === 'bottom'
    ? { ...body, left: (body.left + body.right) / 2 }
    : { ...body, top: (body.top + body.bottom) / 2 }

/** Build the immutable geometry used for every move in one pointer session. */
export function createPanelDragSnapshot(input: PanelDragSnapshotInput): PanelDragSnapshot {
  const zones = {} as Record<DockZoneId, PanelDragZoneSnapshot>
  for (const zone of DOCK_ZONE_IDS) {
    const visible = input.visibleZones?.[zone]
    const fallback = zonePreviewRect(input.centerRect, zone, input.zoneSizes[zone])
    const previewRect = visible?.rect ?? fallback
    const sectionOrders = input.zoneOrders[zone]
    const sections = (visible?.sections ?? []).map((section) => ({
      section: section.section,
      bodyRect: section.bodyRect,
      tabStrip: {
        rect: section.tabStrip.rect,
        slots: section.tabStrip.slots.flatMap((slot) => {
          const rect = intersectRect(slot.rect, section.tabStrip.rect)
          return rect === undefined ? [] : [{ ...slot, rect }]
        }),
      },
      appendRects: section.appendRects ?? [],
    }))
    const lone = sections.length === 1 && sectionOrders.length < MAX_ZONE_SECTIONS
      ? sections[0]
      : undefined
    zones[zone] = {
      zone,
      open: visible !== undefined,
      edgeRect: edgeRect(input.viewportRect, zone),
      ghostRect: ghostRect(fallback, zone),
      previewRect,
      sectionOrders,
      sections,
      splitRect: lone === undefined ? undefined : splitRectOf(zone, lone.bodyRect),
    }
  }
  return { viewportRect: input.viewportRect, canvasRect: input.canvasRect, zones }
}

export function panelDragPointerDisposition(
  ownerPointerId: number | undefined,
  incomingPointerId: number,
): PanelDragPointerDisposition {
  if (ownerPointerId === undefined) return 'start'
  return ownerPointerId === incomingPointerId ? 'owner' : 'foreign'
}

export function beginPanelDragModel(
  pointerId: number,
  panelId: string,
  start: PanelDragPoint,
  snapshot: PanelDragSnapshot,
  legality: PanelDragLegality,
): PanelDragModel {
  return {
    pointerId,
    panelId,
    start,
    point: start,
    started: false,
    rolledBack: false,
    snapshot,
    legality,
    preview: undefined,
  }
}

const contains = (rect: PanelDragRect, point: PanelDragPoint): boolean =>
  point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom

const sectionOrder = (zone: PanelDragZoneSnapshot, section: number): readonly string[] =>
  zone.sectionOrders[section] ?? []

const remainingOrder = (order: readonly string[], panelId: string): readonly string[] =>
  order.filter((id) => id !== panelId)

const tabInsertionIndex = (
  zone: PanelDragZoneSnapshot,
  section: PanelDragSectionSnapshot,
  panelId: string,
  clientX: number,
): number => {
  const order = remainingOrder(sectionOrder(zone, section.section), panelId)
  const slots = section.tabStrip.slots
    .filter((slot) => slot.id !== panelId && order.includes(slot.id))
    .sort((a, b) => a.rect.left - b.rect.left)
  const next = slots.find((slot) => clientX < (slot.rect.left + slot.rect.right) / 2)
  return next === undefined ? order.length : order.indexOf(next.id)
}

export function resolvePanelDragTarget(
  snapshot: PanelDragSnapshot,
  panelId: string,
  point: PanelDragPoint,
): PanelDragTarget | undefined {
  for (const zoneId of DOCK_ZONE_IDS) {
    const zone = snapshot.zones[zoneId]
    for (const section of zone.sections) {
      if (section.appendRects.some((rect) => contains(rect, point))) {
        return {
          kind: 'zone',
          zone: zoneId,
          section: section.section,
          index: remainingOrder(sectionOrder(zone, section.section), panelId).length,
        }
      }
    }
  }
  for (const zoneId of DOCK_ZONE_IDS) {
    const zone = snapshot.zones[zoneId]
    for (const section of zone.sections) {
      if (contains(section.tabStrip.rect, point)) {
        return {
          kind: 'tab',
          zone: zoneId,
          section: section.section,
          index: tabInsertionIndex(zone, section, panelId, point.x),
        }
      }
    }
  }
  for (const zoneId of DOCK_ZONE_IDS) {
    const zone = snapshot.zones[zoneId]
    if (zone.splitRect === undefined || !contains(zone.splitRect, point)) continue
    // Splitting only means something when the zone keeps at least one
    // other tab in its existing section.
    if (zone.sectionOrders.flat().some((id) => id !== panelId)) {
      return { kind: 'split', zone: zoneId, section: zone.sectionOrders.length }
    }
  }
  for (const zoneId of DOCK_ZONE_IDS) {
    const zone = snapshot.zones[zoneId]
    for (const section of zone.sections) {
      if (contains(section.bodyRect, point)) {
        return {
          kind: 'zone',
          zone: zoneId,
          section: section.section,
          index: remainingOrder(sectionOrder(zone, section.section), panelId).length,
        }
      }
    }
  }
  for (const zoneId of DOCK_ZONE_IDS) {
    const zone = snapshot.zones[zoneId]
    if (contains(zone.edgeRect, point)) {
      return { kind: 'edge', zone: zoneId, index: remainingOrder(sectionOrder(zone, 0), panelId).length }
    }
  }
  return contains(snapshot.canvasRect, point) ? { kind: 'floating' } : undefined
}

const targetAllowed = (target: PanelDragTarget, legality: PanelDragLegality): boolean =>
  target.kind === 'floating' ? legality.floating : legality.zones.includes(target.zone)

export function movePanelDragModel(
  model: PanelDragModel,
  pointerId: number,
  point: PanelDragPoint,
): PanelDragModel {
  if (pointerId !== model.pointerId || model.rolledBack) return model
  if (!model.started && Math.hypot(point.x - model.start.x, point.y - model.start.y) < PANEL_DRAG_THRESHOLD) {
    return model
  }
  const target = resolvePanelDragTarget(model.snapshot, model.panelId, point)
  return {
    ...model,
    point,
    started: true,
    preview: target === undefined ? undefined : { target, allowed: targetAllowed(target, model.legality) },
  }
}

/** Invalidated geometry and interrupted capture both end in the same rollback state. */
export function rollbackPanelDragModel(model: PanelDragModel, pointerId: number): PanelDragModel {
  if (pointerId !== model.pointerId || model.rolledBack) return model
  return { ...model, rolledBack: true, preview: undefined }
}

const sameSemanticTarget = (first: PanelDragTarget, second: PanelDragTarget): boolean => {
  if (first.kind !== second.kind) return false
  if (first.kind === 'floating' || second.kind === 'floating') return true
  if (first.zone !== second.zone) return false
  if (first.kind === 'split' || second.kind === 'split') return true
  if (first.kind === 'edge' || second.kind === 'edge') return first.index === second.index
  return first.section === second.section && first.index === second.index
}

export function panelDragReleaseAction(
  model: PanelDragModel,
  currentGeometry?: PanelDragReleaseGeometry,
): PanelDragReleaseAction {
  if (model.rolledBack) return 'rollback'
  if (!model.started) return 'click'
  if (model.preview === undefined) return 'rollback'
  if (currentGeometry === undefined) return 'rollback'
  const currentTarget = resolvePanelDragTarget(
    currentGeometry.snapshot,
    model.panelId,
    currentGeometry.point,
  )
  if (currentTarget === undefined || !sameSemanticTarget(model.preview.target, currentTarget)) return 'rollback'
  return model.preview.allowed ? 'commit' : 'refuse'
}

export function panelDragTargetGeometry(
  snapshot: PanelDragSnapshot,
  panelId: string,
  target: PanelDragTarget,
): PanelDragTargetGeometry {
  if (target.kind === 'floating') return { rect: snapshot.canvasRect, caret: undefined }
  const zone = snapshot.zones[target.zone]
  if (target.kind === 'edge') return { rect: zone.previewRect, caret: undefined }
  if (target.kind === 'split') return { rect: zone.splitRect ?? zone.previewRect, caret: undefined }
  const section = zone.sections.find((candidate) => candidate.section === target.section)
  if (section === undefined) return { rect: zone.previewRect, caret: undefined }
  if (target.kind === 'zone') return { rect: section.bodyRect, caret: undefined }
  const order = remainingOrder(sectionOrder(zone, section.section), panelId)
  const slots = section.tabStrip.slots
    .filter((slot) => slot.id !== panelId && order.includes(slot.id))
    .sort((a, b) => a.rect.left - b.rect.left)
  const next = slots.find((slot) => order.indexOf(slot.id) >= target.index)
  const x = next?.rect.left ?? slots.at(-1)?.rect.right ?? section.tabStrip.rect.left + 8
  return {
    rect: section.tabStrip.rect,
    caret: {
      left: x - 1,
      right: x + 2,
      top: section.tabStrip.rect.top + 4,
      bottom: section.tabStrip.rect.bottom - 4,
    },
  }
}
