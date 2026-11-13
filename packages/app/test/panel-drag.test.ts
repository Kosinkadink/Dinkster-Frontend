import { describe, expect, it } from 'vitest'
import { beginPanelDragModel, createPanelDragSnapshot, movePanelDragModel, panelDragReleaseAction, resolvePanelDragTarget, rollbackPanelDragModel, type PanelDragRect, type PanelDragSnapshot } from '../src/panel-drag.js'

const rect = (left: number, top: number, right: number, bottom: number): PanelDragRect =>
  ({ left, top, right, bottom })

const snapshot = (): PanelDragSnapshot => createPanelDragSnapshot({
  viewportRect: rect(0, 0, 1000, 800),
  centerRect: rect(72, 48, 1000, 772),
  canvasRect: rect(72, 88, 700, 620),
  zoneSizes: { left: 280, right: 300, bottom: 200 },
  zoneOrders: {
    left: [['library']],
    right: [['queue', 'hidden', 'outputs', 'problems']],
    bottom: [['logs']],
  },
  visibleZones: {
    right: {
      rect: rect(700, 48, 1000, 772),
      sections: [{
        section: 0,
        bodyRect: rect(700, 88, 1000, 772),
        tabStrip: {
          rect: rect(700, 48, 940, 88),
          slots: [
            { id: 'queue', rect: rect(700, 48, 760, 88) },
            { id: 'outputs', rect: rect(760, 48, 840, 88) },
            { id: 'problems', rect: rect(840, 48, 930, 88) },
          ],
        },
        appendRects: [rect(940, 48, 972, 88)],
      }],
    },
  },
})

/** Right zone already split: two rendered sections stacked at y=430..470. */
const sectionedSnapshot = (): PanelDragSnapshot => createPanelDragSnapshot({
  viewportRect: rect(0, 0, 1000, 800),
  centerRect: rect(72, 48, 1000, 772),
  canvasRect: rect(72, 88, 700, 620),
  zoneSizes: { left: 280, right: 300, bottom: 200 },
  zoneOrders: {
    left: [['library']],
    right: [['queue', 'outputs'], ['problems']],
    bottom: [['logs']],
  },
  visibleZones: {
    right: {
      rect: rect(700, 48, 1000, 772),
      sections: [
        {
          section: 0,
          bodyRect: rect(700, 88, 1000, 430),
          tabStrip: {
            rect: rect(700, 48, 1000, 88),
            slots: [
              { id: 'queue', rect: rect(700, 48, 760, 88) },
              { id: 'outputs', rect: rect(760, 48, 840, 88) },
            ],
          },
        },
        {
          section: 1,
          bodyRect: rect(700, 470, 1000, 772),
          tabStrip: {
            rect: rect(700, 430, 1000, 470),
            slots: [{ id: 'problems', rect: rect(700, 430, 760, 470) }],
          },
        },
      ],
    },
  },
})

describe('panel drag targeting', () => {
  it('maps a tab strip to persisted insertion indexes while retaining hidden ids', () => {
    const geometry = snapshot()
    expect(resolvePanelDragTarget(geometry, 'outputs', { x: 710, y: 60 })).toEqual({
      kind: 'tab', zone: 'right', section: 0, index: 0,
    })
    expect(resolvePanelDragTarget(geometry, 'outputs', { x: 800, y: 60 })).toEqual({
      kind: 'tab', zone: 'right', section: 0, index: 2,
    })
    expect(resolvePanelDragTarget(geometry, 'outputs', { x: 920, y: 60 })).toEqual({
      kind: 'tab', zone: 'right', section: 0, index: 3,
    })
  })

  it('maps an open zone body to append and screen edges to hidden-zone reveal', () => {
    const geometry = snapshot()
    expect(resolvePanelDragTarget(geometry, 'outputs', { x: 850, y: 300 })).toEqual({
      kind: 'zone', zone: 'right', section: 0, index: 3,
    })
    expect(resolvePanelDragTarget(geometry, 'outputs', { x: 500, y: 790 })).toEqual({
      kind: 'edge', zone: 'bottom', index: 1,
    })
    expect(resolvePanelDragTarget(geometry, 'outputs', { x: 5, y: 300 })).toEqual({
      kind: 'edge', zone: 'left', index: 1,
    })
    expect(resolvePanelDragTarget(geometry, 'outputs', { x: 995, y: 30 })).toEqual({
      kind: 'edge', zone: 'right', index: 3,
    })
  })

  it('maps a lone section\'s far half to a split target for a new section', () => {
    const geometry = snapshot()
    expect(resolvePanelDragTarget(geometry, 'outputs', { x: 850, y: 600 })).toEqual({
      kind: 'split', zone: 'right', section: 1,
    })
    // The near half still appends to the existing section.
    expect(resolvePanelDragTarget(geometry, 'outputs', { x: 850, y: 300 })!.kind).toBe('zone')
  })

  it('never offers a split that would leave the existing section empty', () => {
    const geometry = createPanelDragSnapshot({
      viewportRect: rect(0, 0, 1000, 800),
      centerRect: rect(72, 48, 1000, 772),
      canvasRect: rect(72, 88, 700, 620),
      zoneSizes: { left: 280, right: 300, bottom: 200 },
      zoneOrders: { left: [[]], right: [['outputs']], bottom: [[]] },
      visibleZones: {
        right: {
          rect: rect(700, 48, 1000, 772),
          sections: [{
            section: 0,
            bodyRect: rect(700, 88, 1000, 772),
            tabStrip: {
              rect: rect(700, 48, 940, 88),
              slots: [{ id: 'outputs', rect: rect(700, 48, 760, 88) }],
            },
          }],
        },
      },
    })
    // The zone's only tab cannot split its own zone; another panel can.
    expect(resolvePanelDragTarget(geometry, 'outputs', { x: 850, y: 600 })).toEqual({
      kind: 'zone', zone: 'right', section: 0, index: 0,
    })
    expect(resolvePanelDragTarget(geometry, 'library', { x: 850, y: 600 })).toEqual({
      kind: 'split', zone: 'right', section: 1,
    })
  })

  it('targets each rendered section independently once a zone is split', () => {
    const geometry = sectionedSnapshot()
    expect(resolvePanelDragTarget(geometry, 'library', { x: 710, y: 450 })).toEqual({
      kind: 'tab', zone: 'right', section: 1, index: 0,
    })
    expect(resolvePanelDragTarget(geometry, 'library', { x: 850, y: 600 })).toEqual({
      kind: 'zone', zone: 'right', section: 1, index: 1,
    })
    expect(resolvePanelDragTarget(geometry, 'library', { x: 850, y: 300 })).toEqual({
      kind: 'zone', zone: 'right', section: 0, index: 2,
    })
  })

  it('ignores hidden tab boxes and maps their strip tail and the overflow button to append', () => {
    const geometry = createPanelDragSnapshot({
      viewportRect: rect(0, 0, 1000, 800),
      centerRect: rect(72, 48, 700, 772),
      canvasRect: rect(72, 88, 700, 620),
      zoneSizes: { left: 280, right: 300, bottom: 200 },
      zoneOrders: { left: [[]], right: [['first', 'second', 'hidden-tail']], bottom: [[]] },
      visibleZones: {
        right: {
          rect: rect(700, 48, 1000, 772),
          sections: [{
            section: 0,
            bodyRect: rect(700, 88, 1000, 772),
            tabStrip: {
              rect: rect(700, 48, 816, 88),
              slots: [
                { id: 'first', rect: rect(700, 48, 760, 88) },
                { id: 'second', rect: rect(760, 48, 800, 88) },
                { id: 'hidden-tail', rect: rect(0, 0, 0, 0) },
              ],
            },
            appendRects: [rect(816, 48, 848, 88)],
          }],
        },
      },
    })

    expect(geometry.zones.right.sections[0]!.tabStrip.slots).toEqual([
      { id: 'first', rect: rect(700, 48, 760, 88) },
      { id: 'second', rect: rect(760, 48, 800, 88) },
    ])
    expect(resolvePanelDragTarget(geometry, 'first', { x: 765, y: 60 })).toEqual({
      kind: 'tab', zone: 'right', section: 0, index: 0,
    })
    expect(resolvePanelDragTarget(geometry, 'first', { x: 808, y: 60 })).toEqual({
      kind: 'tab', zone: 'right', section: 0, index: 2,
    })
    expect(resolvePanelDragTarget(geometry, 'first', { x: 820, y: 60 })).toEqual({
      kind: 'zone', zone: 'right', section: 0, index: 2,
    })
  })

  it('uses the canvas as a floating target only after dock targets are exhausted', () => {
    const geometry = snapshot()
    expect(resolvePanelDragTarget(geometry, 'queue', { x: 400, y: 300 })).toEqual({ kind: 'floating' })
    expect(resolvePanelDragTarget(geometry, 'queue', { x: 500, y: 30 })).toBeUndefined()
  })

})

describe('panel pointer session', () => {

  it('keeps movement below four pixels as a click and starts at the threshold', () => {
    const pending = beginPanelDragModel(7, 'outputs', { x: 800, y: 60 }, snapshot(), {
      zones: ['right'], floating: false,
    })
    expect(movePanelDragModel(pending, 7, { x: 802, y: 63 }).started).toBe(false)
    const dragging = movePanelDragModel(pending, 7, { x: 804, y: 60 })
    expect(dragging.started).toBe(true)
    expect(dragging.preview?.target.kind).toBe('tab')
    expect(panelDragReleaseAction(pending)).toBe('click')
  })

  it('marks illegal zones and floating targets as refused without losing their preview', () => {
    const pending = beginPanelDragModel(7, 'outputs', { x: 800, y: 60 }, snapshot(), {
      zones: ['right'], floating: false,
    })
    const bottom = movePanelDragModel(pending, 7, { x: 500, y: 790 })
    expect(bottom.preview).toEqual({
      target: { kind: 'edge', zone: 'bottom', index: 1 },
      allowed: false,
    })
    expect(panelDragReleaseAction(bottom, {
      snapshot: bottom.snapshot,
      point: { x: 500, y: 790 },
    })).toBe('refuse')
    const floating = movePanelDragModel(bottom, 7, { x: 400, y: 300 })
    expect(floating.preview).toEqual({ target: { kind: 'floating' }, allowed: false })
  })

  it('commits one allowed target and rolls back missing targets or invalidated geometry', () => {
    const pending = beginPanelDragModel(7, 'outputs', { x: 800, y: 60 }, snapshot(), {
      zones: ['right', 'bottom'], floating: true,
    })
    const bottom = movePanelDragModel(pending, 7, { x: 500, y: 790 })
    expect(panelDragReleaseAction(bottom, {
      snapshot: bottom.snapshot,
      point: { x: 500, y: 790 },
    })).toBe('commit')
    const outside = movePanelDragModel(bottom, 7, { x: 500, y: 30 })
    expect(panelDragReleaseAction(outside)).toBe('rollback')
    const invalidated = rollbackPanelDragModel(bottom, 7)
    expect(invalidated.preview).toBeUndefined()
    expect(invalidated.snapshot).toBe(bottom.snapshot)
    expect(panelDragReleaseAction(invalidated)).toBe('rollback')
    expect(movePanelDragModel(invalidated, 7, { x: 500, y: 790 })).toBe(invalidated)
  })

  it('commits a split release and rolls back when the point drifts off the half', () => {
    const geometry = snapshot()
    const pending = beginPanelDragModel(7, 'outputs', { x: 800, y: 60 }, geometry, {
      zones: ['right'], floating: false,
    })
    const point = { x: 850, y: 600 }
    const dragging = movePanelDragModel(pending, 7, point)
    expect(dragging.preview).toEqual({
      target: { kind: 'split', zone: 'right', section: 1 },
      allowed: true,
    })
    expect(panelDragReleaseAction(dragging, { snapshot: geometry, point })).toBe('commit')
    expect(panelDragReleaseAction(dragging, { snapshot: geometry, point: { x: 850, y: 300 } })).toBe('rollback')
  })

  it('rolls back when release geometry no longer resolves to the previewed target', () => {
    const geometry = snapshot()
    const pending = beginPanelDragModel(7, 'outputs', { x: 800, y: 60 }, geometry, {
      zones: ['right'], floating: true,
    })
    const point = { x: 850, y: 300 }
    const dragging = movePanelDragModel(pending, 7, point)
    expect(dragging.preview?.target).toEqual({ kind: 'zone', zone: 'right', section: 0, index: 3 })
    expect(panelDragReleaseAction(dragging, { snapshot: geometry, point })).toBe('commit')

    const withoutRightZone = createPanelDragSnapshot({
      viewportRect: rect(0, 0, 1000, 800),
      centerRect: rect(72, 48, 1000, 772),
      canvasRect: rect(72, 88, 700, 620),
      zoneSizes: { left: 280, right: 300, bottom: 200 },
      zoneOrders: {
        left: [['library']],
        right: [['queue', 'hidden', 'outputs', 'problems']],
        bottom: [['logs']],
      },
    })
    expect(panelDragReleaseAction(dragging, { snapshot: withoutRightZone, point })).toBe('rollback')
  })
})
