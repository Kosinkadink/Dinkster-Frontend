import { describe, expect, it } from 'vitest'
import { LivenessDerivation, type RoutedNode, type WouldRunEdges } from '../src/compile/liveness.js'

describe('routed liveness projection', () => {

  it('derives nested inactive-exclusive cones while preserving shared and other-root producers', () => {
    const edge = (producer: string) => [producer, 0] as const
    const nodes = new Map<string, RoutedNode>([
      ['outer', { inputs: { off: edge('outerOff'), on: edge('inner'), shared: edge('shared') }, selectorProjection: { inactive: ['off'] } }],
      ['inner', { inputs: { off: edge('innerOn'), on: edge('innerOff') }, selectorProjection: { inactive: ['on'] } }],
      ['otherRoot', { inputs: { input: edge('otherUsed') } }],
      ['outerOff', { inputs: { shared: edge('shared'), elsewhere: edge('otherUsed'), exclusive: edge('outerOnly') } }],
      ['innerOn', { inputs: { shared: edge('shared') } }],
      ['innerOff', { inputs: { input: edge('innerOnly') } }],
      ['shared', { inputs: {} }],
      ['otherUsed', { inputs: {} }],
      ['outerOnly', { inputs: {} }],
      ['innerOnly', { inputs: {} }],
    ])
    // Presence of the projection map selects would-run behavior; these edges
    // also model routed bypass/reroute/tap/net successors per destination.
    const routed: WouldRunEdges = new Map()
    const result = new LivenessDerivation().derive(nodes, ['outer', 'otherRoot'], routed)

    expect([...result.included].sort()).toEqual(['inner', 'innerOn', 'otherRoot', 'otherUsed', 'outer', 'shared'])
    expect([...result.inactiveExclusive.get('outer') ?? []].sort()).toEqual(['outerOff', 'outerOnly'])
    expect([...result.inactiveExclusive.get('inner') ?? []].sort()).toEqual(['innerOff', 'innerOnly'])
  })

  it('keeps an unknown pick neutral by omitting a projection', () => {
    const nodes = new Map<string, RoutedNode>([
      ['selector', { inputs: { off: ['falseSource', 0], on: ['trueSource', 0] } }],
      ['falseSource', { inputs: {} }],
      ['trueSource', { inputs: {} }],
    ])
    const result = new LivenessDerivation().derive(nodes, ['selector'], new Map())
    expect([...result.included].sort()).toEqual(['falseSource', 'selector', 'trueSource'])
    expect(result.inactiveExclusive.size).toBe(0)
  })
})
