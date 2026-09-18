import { describe, expect, it } from 'vitest'
import { nodeTitleInvocation } from '../src/CanvasHost.js'

describe('node rename command boundary', () => {
  it('dispatches node.setTitle for a custom display name', () => {
    expect(nodeTitleInvocation('g0', 'n1', '  My Sampler  ', 'KSampler')).toEqual({
      command: 'node.setTitle',
      params: { graphId: 'g0', nodeId: 'n1', title: 'My Sampler' },
    })
  })

  it('clears the override when the entered name equals the original display name', () => {
    expect(nodeTitleInvocation('g0', 'n1', ' KSampler ', 'KSampler')).toEqual({
      command: 'node.setTitle',
      params: { graphId: 'g0', nodeId: 'n1', title: null },
    })
  })
})
