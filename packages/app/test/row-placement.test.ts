/**
 * Where an open field's side part goes: it stays whole and on the visible
 * canvas, which never moves for it.
 */
import { describe, expect, it } from 'vitest'
import { rowPlacement, type RowBox } from '../src/editors/row-placement.js'

// A 100 x 20 field at world 50, 400 on a node from y 300 to 460.
const row: RowBox = { rect: { x: 50, y: 400, width: 100, height: 20 }, look: 'original', nodeTop: 300, nodeBottom: 460 }
const canvas = (width: number, height: number) => ({ x: 0, y: 0, width, height })
const at = (scale: number) => ({ x: 0, y: 0, scale })

describe('rowPlacement', () => {
  it('opens beside the row at its top when there is room', () => {
    const placed = rowPlacement(row, at(1), canvas(800, 600), { width: 200, height: 120 })
    expect(placed).toMatchObject({ place: 'right', sideTop: 0 })
    expect(placed.sideMaxHeight).toBeUndefined()
  })

  it('slides up beside the row just far enough to end at the bottom edge', () => {
    // 120 tall from 400 would end at 520; the canvas ends at 490.
    const placed = rowPlacement(row, at(1), canvas(800, 490), { width: 200, height: 120 })
    expect(placed).toMatchObject({ place: 'right', sideTop: -30 })
  })

  it('slides down from the top edge and never leaves the row', () => {
    // The row's top is 10 px above the visible canvas; the side part starts
    // at the canvas top. With the whole row above the canvas it stays
    // beside the row's last pixel.
    expect(rowPlacement(row, at(1), { x: 0, y: 410, width: 800, height: 400 }, { width: 200, height: 120 }))
      .toMatchObject({ place: 'right', sideTop: 10 })
    expect(rowPlacement(row, at(1), { x: 0, y: 470, width: 800, height: 400 }, { width: 200, height: 120 }))
      .toMatchObject({ place: 'right', sideTop: 19 })
  })

  it('takes the visible height and scrolls when it is taller than the canvas', () => {
    const placed = rowPlacement(row, at(1), { x: 0, y: 380, width: 800, height: 90 }, { width: 200, height: 300 })
    expect(placed).toMatchObject({ place: 'right', sideTop: -20, sideMaxHeight: 90 })
  })

  it('goes under the node, or above it when there is no room below', () => {
    const narrow = canvas(200, 700)
    expect(rowPlacement(row, at(1), narrow, { width: 200, height: 120 }))
      .toMatchObject({ place: 'below-node', sideTop: 60 })
    expect(rowPlacement(row, at(1), canvas(200, 520), { width: 200, height: 120 }))
      .toMatchObject({ place: 'above-node', sideTop: -220 })
  })

  it('keeps its normal size under the node when zoomed in', () => {
    // At 2x the box is drawn at twice its size, so 60 world units under the
    // row's top are 60 units of the box, not 120.
    expect(rowPlacement(row, at(2), canvas(300, 2000), { width: 200, height: 120 }))
      .toMatchObject({ place: 'below-node', sideTop: 60 })
  })

  it('goes over the field when zoomed out and there is no room under it', () => {
    // At 0.5 the field is at screen 200, still 20 tall; the canvas ends at 300.
    expect(rowPlacement(row, at(0.5), canvas(800, 400), { width: 100, height: 120 }))
      .toMatchObject({ place: 'below-field', sideTop: 20 })
    expect(rowPlacement(row, at(0.5), canvas(800, 300), { width: 100, height: 120 }))
      .toMatchObject({ place: 'above-field', sideTop: -120 })
  })

  it('scrolls on the side with more room when it fits neither under nor over', () => {
    // Field at screen 200 to 220 on a 260 tall canvas: 40 below, 200 above.
    expect(rowPlacement(row, at(0.5), canvas(800, 260), { width: 100, height: 240 }))
      .toMatchObject({ place: 'above-field', sideTop: -200, sideMaxHeight: 200 })
  })
})
