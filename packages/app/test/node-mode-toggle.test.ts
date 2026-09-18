import { describe, expect, it } from 'vitest'
import { toggledSelectionCollapsed, toggledSelectionMode, type NodeMode } from '../src/app-state.js'

const toggle = (modes: readonly NodeMode[], target: 'muted' | 'bypassed'): NodeMode[] => {
  const next = toggledSelectionMode(modes, target)
  return modes.map(() => next)
}

describe('selection mode toggles', () => {
  it('toggles active to muted and back', () => {
    const muted = toggle(['active'], 'muted')
    expect(muted).toEqual(['muted'])
    expect(toggle(muted, 'muted')).toEqual(['active'])
  })

  it('toggles active to bypassed and back', () => {
    const bypassed = toggle(['active'], 'bypassed')
    expect(bypassed).toEqual(['bypassed'])
    expect(toggle(bypassed, 'bypassed')).toEqual(['active'])
  })

  it('applies mute to every node in a mixed selection', () => {
    expect(toggle(['muted', 'active'], 'muted')).toEqual(['muted', 'muted'])
  })

  it('applies bypass instead of active to an all-muted selection', () => {
    expect(toggle(['muted', 'muted'], 'bypassed')).toEqual(['bypassed', 'bypassed'])
  })
})

describe('selection minimized-state toggle', () => {
  it('minimizes mixed and expanded selections', () => {
    expect(toggledSelectionCollapsed([false, true])).toBe(true)
    expect(toggledSelectionCollapsed([false, false])).toBe(true)
  })

  it('restores only an all-minimized selection', () => {
    expect(toggledSelectionCollapsed([true, true])).toBe(false)
  })
})
