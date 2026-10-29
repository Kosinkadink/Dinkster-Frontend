import { describe, expect, it } from 'vitest'
import { overlappingNodeIds } from '../src/index.js'

describe('overlappingNodeIds', () => {
  it('counts distinct participants in rendered intersections without changing authored bounds', () => {
    const nodes = [
      { id: 'far', x: -400, y: 13, width: 15, height: 17 },
      { id: 'n49', x: 960, y: -80, width: 199, height: 132 },
      { id: 'n52', x: 950, y: 30, width: 205, height: 276 },
      { id: 'inside', x: 975, y: 40, width: 12, height: 5 },
    ]
    const authored = structuredClone(nodes)
    expect(overlappingNodeIds(nodes)).toEqual(['n49', 'n52', 'inside'])
    expect(nodes).toEqual(authored)
  })

  it('excludes edge contact, corner contact, separated axes and zero-area bodies', () => {
    expect(overlappingNodeIds([
      { id: 'a', x: -10, y: -20, width: 40, height: 60 },
      { id: 'edge', x: 30, y: -19, width: 17, height: 23 },
      { id: 'corner', x: 30, y: 40, width: 31, height: 11 },
      { id: 'below', x: -9, y: 80, width: 8, height: 9 },
      { id: 'zero-width', x: 0, y: 0, width: 0, height: 5 },
      { id: 'zero-height', x: 0, y: 0, width: 5, height: 0 },
    ])).toEqual([])
    expect(overlappingNodeIds([])).toEqual([])
  })
})
