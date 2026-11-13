
import { describe, expect, it } from 'vitest'
import { decodePresence, encodePresence } from '../src/presence-payload.js'

describe('settings proposals in presence', () => {
  it('round-trips proposals while frames without them remain unchanged', () => {
    const without = encodePresence({ graph: 'g0', cursor: undefined, selection: [] })
    expect(without).not.toHaveProperty('proposals')
    expect(decodePresence(without)).not.toHaveProperty('proposals')

    const encoded = encodePresence({
      graph: 'g0', cursor: undefined, selection: [],
      proposals: [{ id: 'proposal-1', settingId: 'canvas.grid.visible', value: false, note: 'Use a cleaner canvas' }],
    })
    expect(decodePresence(encoded)).toMatchObject({
      proposals: [{ id: 'proposal-1', settingId: 'canvas.grid.visible', value: false, note: 'Use a cleaner canvas' }],
    })
  })

})
