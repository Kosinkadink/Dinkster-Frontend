// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import Folder from 'lucide-solid/icons/folder'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TabDragGhost,
  TAB_DRAG_GHOST_OFFSET_X,
  TAB_DRAG_GHOST_OFFSET_Y,
} from '../src/TabDragGhost.js'

afterEach(() => {
  document.body.replaceChildren()
})

function mount(props: {
  readonly title: string
  readonly icon?: Parameters<typeof TabDragGhost>[0]['icon']
  readonly x: number
  readonly y: number
  readonly refused?: boolean
}) {
  const root = document.createElement('div')
  document.body.append(root)
  const dispose = render(() => <TabDragGhost {...props} />, root)
  return { root, dispose }
}

describe('tab drag ghost', () => {
  it('renders the dragged tab title at a fixed offset from the pointer', () => {
    const view = mount({ title: 'Activity log', x: 320, y: 140 })
    const ghost = view.root.querySelector<HTMLElement>('[data-testid="tab-drag-ghost"]')!

    expect(ghost.querySelector('.tab-drag-ghost-title')?.textContent).toBe('Activity log')
    expect(ghost.style.left).toBe(`${320 + TAB_DRAG_GHOST_OFFSET_X}px`)
    expect(ghost.style.top).toBe(`${140 + TAB_DRAG_GHOST_OFFSET_Y}px`)
    expect(ghost.getAttribute('aria-hidden')).toBe('true')
    expect(ghost.dataset['refused']).toBe('false')
    expect(ghost.querySelector('.tab-drag-ghost-icon')).toBeNull()
    view.dispose()
  })

  it('renders the tab icon when the dragged tab has one', () => {
    const view = mount({ title: 'Library', icon: Folder, x: 10, y: 20 })

    expect(view.root.querySelector('.tab-drag-ghost-icon svg')).not.toBeNull()
    view.dispose()
  })

  it('signals a refused target', () => {
    const view = mount({ title: 'Queue', x: 0, y: 0, refused: true })

    expect(
      view.root.querySelector<HTMLElement>('[data-testid="tab-drag-ghost"]')?.dataset['refused'],
    ).toBe('true')
    view.dispose()
  })
})
