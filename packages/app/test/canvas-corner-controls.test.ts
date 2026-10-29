import { describe, expect, it } from 'vitest'
import { minimapMenuPlacement } from '../src/minimap.js'
import { shellStyles as styles } from './fixtures/styles.js'

describe('canvas corner controls', () => {
  it('flips the settings menu above the cluster only when the stage has no room beside it', () => {
    // Plenty of stage to the left of the cluster: open beside.
    expect(minimapMenuPlacement({ left: 870, top: 662 }, { left: 72, top: 90 })).toEqual({ above: false })
    // Exactly menu width + gap + margin still fits beside.
    expect(minimapMenuPlacement({ left: 226, top: 400 }, { left: 0, top: 0 })).toEqual({ above: false })
    // One pixel less does not: open above, capped to the space over the cluster.
    expect(minimapMenuPlacement({ left: 225, top: 400 }, { left: 0, top: 0 }))
      .toEqual({ above: true, maxHeight: 384 })
    // An open side panel shrinks the stage even in a wide window.
    expect(minimapMenuPlacement({ left: 82, top: 240 }, { left: 72, top: 90 }))
      .toEqual({ above: true, maxHeight: 134 })
    // The cap never collapses below a usable scrolling height.
    expect(minimapMenuPlacement({ left: 10, top: 60 }, { left: 0, top: 0 }))
      .toEqual({ above: true, maxHeight: 120 })
  })

  it('uses the semantic CSS projection for navigation chrome', () => {
    const start = styles.indexOf('.minimap {')
    const end = styles.indexOf('.workflow-queue-control {', start)
    const chrome = styles.slice(start, end)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(chrome).toContain('background: var(--dinkster-surface-panel)')
    expect(styles).toMatch(/\.product-button\s*\{[^}]*color:\s*var\(--dinkster-text-primary\)/s)
    expect(chrome).toContain('border: 1px solid var(--dinkster-border-strong)')
    expect(styles).toMatch(/:is\(button,[^}]*:focus-visible\s*\{[^}]*outline:\s*var\(--dinkster-focus-ring-width\) solid var\(--dinkster-border-focus\)/s)
    expect(chrome).toContain('transition: transform var(--dinkster-motion-fast) var(--dinkster-motion-easing)')
    expect(chrome).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
  })
})
