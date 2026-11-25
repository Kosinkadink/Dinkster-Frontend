import { describe, expect, it } from 'vitest'
import { defaultTokens, typeColor } from '@dinkster/canvas'
import { CANVAS_MEDIA_DOM_LIMIT, boundedVisibleOverlayKeys, contrastingTextColor, mediaScreenRect, overlayClipStyle } from '../src/widget-editor-position.js'

describe('widget editor type pill contrast', () => {
  it('uses socket colors with readable contrast for known and namespaced types', () => {
    const int = typeColor(defaultTokens, 'INT')
    const image = typeColor(defaultTokens, 'comfy.IMAGE')
    expect(int).toBe(defaultTokens.typeColors.INT)
    expect(image).toBe(defaultTokens.typeColors.IMAGE)
    expect(contrastingTextColor(int)).toBe('#ffffff')
    expect(contrastingTextColor(image)).toBe('#000000')
    expect(contrastingTextColor(typeColor(defaultTokens, 'COLOR'))).toMatch(/^#(?:000000|ffffff)$/)
  })
})

describe('mediaScreenRect', () => {
  it.each([0.5, 0.75, 1, 1.5])('maps node preview geometry at scale %s', (scale) => {
    expect(mediaScreenRect(
      { x: 100, y: 50, width: 200, height: 300 },
      { x: 10, y: 20, width: 180, height: 100 },
      { x: -20, y: 30, scale },
      { left: 8, top: 12, width: 400, height: 300 },
    )).toEqual({
      x: 8 + (100 + 10) * scale - 20,
      y: 12 + (50 + 20) * scale + 30,
      width: 180 * scale,
      height: 100 * scale,
    })
  })

})

describe('overlayClipStyle', () => {
  const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 }) } as HTMLCanvasElement
  const rect = { x: 100, y: 100, width: 200, height: 150 }

  it('cuts what is drawn in front out of the overlay, kept inside the canvas', () => {
    // The overlay's lower 50 px are below the canvas; the cover pokes out above and to the right of it.
    expect(overlayClipStyle(rect, canvas, [{ x: 250, y: 80, width: 100, height: 100 }])['clip-path'])
      .toBe('path(evenodd, "M 0 0 H 200 V 100 H 0 Z M 150 0 H 200 V 80 H 150 Z")')
    expect(overlayClipStyle(rect, canvas)['clip-path']).toBe('inset(0px 0px 50px 0px)')
  })
})

describe('boundedVisibleOverlayKeys', () => {
  it('caps visible media DOM and gives focused or selected items priority', () => {
    const items = Array.from({ length: CANVAS_MEDIA_DOM_LIMIT + 8 }, (_, index) => ({
      id: `media-${index}`,
      visible: index !== 2,
      preferred: index === CANVAS_MEDIA_DOM_LIMIT + 4,
    }))

    const keys = boundedVisibleOverlayKeys(
      items,
      (item) => item.id,
      (item) => item.visible,
      (item) => item.preferred,
    )

    expect(keys).toHaveLength(CANVAS_MEDIA_DOM_LIMIT)
    expect(keys[0]).toBe('media-0')
    expect(keys).toContain(`media-${CANVAS_MEDIA_DOM_LIMIT + 4}`)
    expect(keys).not.toContain('media-2')
    expect(keys).not.toContain(`media-${CANVAS_MEDIA_DOM_LIMIT + 3}`)
  })

})
