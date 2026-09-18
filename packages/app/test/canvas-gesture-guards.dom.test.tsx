// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { armedPlacementGhost, armedPlacementStatus, installCanvasGestureGuards, palettePickCommitsImmediately, seededPointerWorld, titleCenteredPlacement } from '../src/CanvasHost.js'
import type { PaletteAnchor } from '../src/NodePalette.js'

afterEach(() => {
  document.body.replaceChildren()
})

const selectText = (element: Element): Selection => {
  const range = document.createRange()
  range.selectNodeContents(element)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  return selection
}

describe('canvas gesture guards', () => {
  it('clears a non-collapsed shell selection on canvas pointerdown', () => {
    const shellText = document.createElement('p')
    shellText.textContent = 'selected problem text'
    const canvas = document.createElement('canvas')
    document.body.append(shellText, canvas)
    const selection = selectText(shellText)
    const dispose = installCanvasGestureGuards(canvas)
    let controllerSawPointerDown = false
    canvas.addEventListener('pointerdown', () => { controllerSawPointerDown = true })

    const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true })
    canvas.dispatchEvent(pointerDown)

    expect(selection.rangeCount).toBe(0)
    expect(pointerDown.defaultPrevented).toBe(false)
    expect(controllerSawPointerDown).toBe(true)
    dispose()
  })

  it.each(['input', 'textarea'] as const)('preserves an actively edited %s selection on canvas pointerdown', (tagName) => {
    const input = document.createElement(tagName)
    input.value = 'editable value'
    const canvas = document.createElement('canvas')
    document.body.append(input, canvas)
    input.focus()
    input.setSelectionRange(1, 8)
    const dispose = installCanvasGestureGuards(canvas)

    canvas.dispatchEvent(new Event('pointerdown', { bubbles: true }))

    expect(input.selectionStart).toBe(1)
    expect(input.selectionEnd).toBe(8)
    dispose()
  })

  it('preserves a collapsed shell selection on canvas pointerdown', () => {
    const shellText = document.createElement('p')
    shellText.textContent = 'caret location'
    const canvas = document.createElement('canvas')
    document.body.append(shellText, canvas)
    const range = document.createRange()
    range.setStart(shellText.firstChild!, 3)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const dispose = installCanvasGestureGuards(canvas)

    canvas.dispatchEvent(new Event('pointerdown', { bubbles: true }))

    expect(selection.rangeCount).toBe(1)
    expect(selection.isCollapsed).toBe(true)
    dispose()
  })

  it('prevents native dragstart from the graph canvas', () => {
    const canvas = document.createElement('canvas')
    document.body.append(canvas)
    const dispose = installCanvasGestureGuards(canvas)
    const drag = new Event('dragstart', { bubbles: true, cancelable: true })

    canvas.dispatchEvent(drag)

    expect(drag.defaultPrevented).toBe(true)
    dispose()
  })
})

describe('armed placement presentation', () => {
  it('anchors the exact preview geometry at the title center', () => {
    const geometry = { width: 240, height: 136, headerHeight: 28 }
    expect(titleCenteredPlacement({ x: 100, y: 200 }, geometry)).toEqual({ x: -20, y: 186 })
    expect(armedPlacementGhost('KSampler', { x: 100, y: 200 }, geometry)).toEqual({
      x: -20, y: 186, width: 240, height: 136, title: 'KSampler',
    })
    expect(armedPlacementStatus('KSampler')).toBe('Placing KSampler - click the canvas to place, Esc to cancel')
  })

  it.each([0.5, 1, 2])('keeps the title center under the pointer at zoom %s', (zoom) => {
    const geometry = { width: 180, height: 88, headerHeight: 28 }
    const pointerCss = { x: 500, y: 320 }
    const viewport = { x: 80, y: -40 }
    const pointerWorld = {
      x: (pointerCss.x - viewport.x) / zoom,
      y: (pointerCss.y - viewport.y) / zoom,
    }
    const topLeft = titleCenteredPlacement(pointerWorld, geometry)
    expect((topLeft.x + geometry.width / 2) * zoom + viewport.x).toBe(pointerCss.x)
    expect((topLeft.y + geometry.headerHeight / 2) * zoom + viewport.y).toBe(pointerCss.y)
  })

  it('seeds the arm-time ghost from the last window pointer position inside the canvas', () => {
    const rect = { left: 100, top: 50, right: 900, bottom: 650 }
    const toWorld = (x: number, y: number) => ({ x: x * 2, y: y * 2 })
    expect(seededPointerWorld({ x: 300, y: 250 }, rect, toWorld)).toEqual({ x: 400, y: 400 })
    expect(seededPointerWorld({ x: 100, y: 50 }, rect, toWorld)).toEqual({ x: 0, y: 0 })
    expect(seededPointerWorld({ x: 99, y: 250 }, rect, toWorld)).toBeUndefined()
    expect(seededPointerWorld({ x: 300, y: 651 }, rect, toWorld)).toBeUndefined()
    expect(seededPointerWorld(undefined, rect, toWorld)).toBeUndefined()
  })

  it('arms ordinary nodes and blueprints while preserving immediate link and reroute picks', () => {
    const anchor: PaletteAnchor = { x: 10, y: 20, worldX: 30, worldY: 40 }
    expect(palettePickCommitsImmediately('KSampler', anchor)).toBe(false)
    expect(palettePickCommitsImmediately('blueprint:pack/item', anchor)).toBe(false)
    expect(palettePickCommitsImmediately('KSampler', { ...anchor, linkDrop: {} as never })).toBe(true)
    expect(palettePickCommitsImmediately('KSampler', { ...anchor, splice: {} as never })).toBe(true)
    expect(palettePickCommitsImmediately('__dinkster.reroute', anchor)).toBe(true)
  })
})
