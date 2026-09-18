import { describe, expect, it } from 'vitest'
import { defaultTokens, typeColor } from '@dinkster/canvas'
import {
  CANVAS_MEDIA_DOM_LIMIT,
  boundedVisibleOverlayKeys,
  contrastingTextColor,
  mediaScreenRect,
  retainActiveOverlayKeys,
} from '../src/widget-editor-position.js'

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

  it('returns undefined when the projected preview is fully offscreen', () => {
    expect(mediaScreenRect(
      { x: 1000, y: 1000, width: 200, height: 300 },
      { x: 10, y: 20, width: 180, height: 100 },
      { x: 0, y: 0, scale: 1 },
      { left: 0, top: 0, width: 400, height: 300 },
    )).toBeUndefined()
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

  it('canonicalizes duplicate keys before applying the cap and combines priority', () => {
    const items = [
      ...Array.from({ length: CANVAS_MEDIA_DOM_LIMIT }, (_, index) => ({ id: `media-${index}`, preferred: false })),
      { id: 'media-0', preferred: true },
      { id: `media-${CANVAS_MEDIA_DOM_LIMIT}`, preferred: true },
      { id: `media-${CANVAS_MEDIA_DOM_LIMIT}`, preferred: false },
    ]

    const keys = boundedVisibleOverlayKeys(items, (item) => item.id, () => true, (item) => item.preferred)

    expect(keys).toHaveLength(CANVAS_MEDIA_DOM_LIMIT)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys[0]).toBe('media-0')
    expect(keys).toContain(`media-${CANVAS_MEDIA_DOM_LIMIT}`)
    expect(keys).not.toContain(`media-${CANVAS_MEDIA_DOM_LIMIT - 1}`)
  })

  it('returns unique stable source order when fewer keys than the cap are visible', () => {
    const items = [
      { id: 'first', visible: true },
      { id: 'hidden', visible: false },
      { id: 'first', visible: true },
      { id: 'second', visible: true },
    ]

    expect(boundedVisibleOverlayKeys(
      items,
      (item) => item.id,
      (item) => item.visible,
      () => false,
    )).toEqual(['first', 'second'])
  })

  it('removes active ownership for stale source keys', () => {
    const active = new Set(['media:playing', 'pager:open', 'media:stale'])
    const live = new Set(['media:playing', 'pager:open'])

    expect(retainActiveOverlayKeys(active, new Set(active))).toBe(active)
    expect([...retainActiveOverlayKeys(active, live)]).toEqual(['media:playing', 'pager:open'])
  })
})
