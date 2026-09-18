// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import Folder from 'lucide-solid/icons/folder'
import { afterEach, describe, expect, it } from 'vitest'
import {
  beginPanelDragModel,
  createPanelDragSnapshot,
  movePanelDragModel,
  rollbackPanelDragModel,
  type PanelDragModel,
  type PanelDragRect,
} from '../src/panel-drag.js'
import { PanelDragOverlay } from '../src/PanelDragOverlay.js'
import { TAB_DRAG_GHOST_OFFSET_X, TAB_DRAG_GHOST_OFFSET_Y } from '../src/TabDragGhost.js'

const rect = (left: number, top: number, right: number, bottom: number): PanelDragRect =>
  ({ left, top, right, bottom })

const snapshot = () => createPanelDragSnapshot({
  viewportRect: rect(0, 0, 1000, 800),
  centerRect: rect(72, 48, 700, 772),
  canvasRect: rect(72, 88, 700, 620),
  zoneSizes: { left: 280, right: 300, bottom: 200 },
  zoneOrders: { left: [[]], right: [['queue', 'outputs']], bottom: [[]] },
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
          ],
        },
      }],
    },
  },
})

const pendingDrag = (): PanelDragModel =>
  beginPanelDragModel(7, 'outputs', { x: 800, y: 60 }, snapshot(), {
    zones: ['right'], floating: false,
  })

afterEach(() => {
  document.body.replaceChildren()
})

function mount(initial: PanelDragModel) {
  const root = document.createElement('div')
  document.body.append(root)
  const [drag, setDrag] = createSignal(initial)
  const dispose = render(() => (
    <PanelDragOverlay drag={drag()} ghostTitle="Outputs" ghostIcon={Folder} />
  ), root)
  const ghost = () => root.querySelector<HTMLElement>('[data-testid="tab-drag-ghost"]')
  return { root, setDrag, ghost, dispose }
}

describe('panel drag overlay cursor ghost', () => {
  it('shows no ghost before the drag threshold is crossed', () => {
    const view = mount(pendingDrag())

    expect(view.root.querySelector('[data-testid="panel-drag-layer"]')).not.toBeNull()
    expect(view.ghost()).toBeNull()
    view.dispose()
  })

  it('follows the pointer with the dragged panel title and icon once started', () => {
    const view = mount(pendingDrag())
    view.setDrag((drag) => movePanelDragModel(drag, 7, { x: 720, y: 60 }))

    const ghost = view.ghost()!
    expect(ghost.querySelector('.tab-drag-ghost-title')?.textContent).toBe('Outputs')
    expect(ghost.querySelector('.tab-drag-ghost-icon svg')).not.toBeNull()
    expect(ghost.style.left).toBe(`${720 + TAB_DRAG_GHOST_OFFSET_X}px`)
    expect(ghost.style.top).toBe(`${60 + TAB_DRAG_GHOST_OFFSET_Y}px`)
    expect(ghost.dataset['refused']).toBe('false')

    view.setDrag((drag) => movePanelDragModel(drag, 7, { x: 500, y: 300 }))
    expect(view.ghost()!.style.left).toBe(`${500 + TAB_DRAG_GHOST_OFFSET_X}px`)
    expect(view.ghost()!.style.top).toBe(`${300 + TAB_DRAG_GHOST_OFFSET_Y}px`)
    view.dispose()
  })

  it('marks the ghost refused in step with the target highlight', () => {
    const view = mount(pendingDrag())
    view.setDrag((drag) => movePanelDragModel(drag, 7, { x: 500, y: 790 }))

    expect(
      view.root.querySelector<HTMLElement>('[data-testid="panel-drag-target"]')?.dataset['allowed'],
    ).toBe('false')
    expect(view.ghost()!.dataset['refused']).toBe('true')
    view.dispose()
  })

  it('labels a split target with the half it creates', () => {
    const view = mount(pendingDrag())
    view.setDrag((drag) => movePanelDragModel(drag, 7, { x: 850, y: 600 }))

    const target = view.root.querySelector<HTMLElement>('[data-testid="panel-drag-target"]')!
    expect(target.dataset['kind']).toBe('split')
    expect(target.querySelector('.panel-drag-target-label')?.textContent).toBe('Dock in lower half')
    view.dispose()
  })

  it('removes the ghost when the drag rolls back', () => {
    const view = mount(pendingDrag())
    view.setDrag((drag) => movePanelDragModel(drag, 7, { x: 720, y: 60 }))
    expect(view.ghost()).not.toBeNull()

    view.setDrag((drag) => rollbackPanelDragModel(drag, 7))
    expect(view.ghost()).toBeNull()
    view.dispose()
  })
})
