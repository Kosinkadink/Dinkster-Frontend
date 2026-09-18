import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { minimapMenuPlacement } from '../src/minimap.js'

const source = readFileSync(new URL('../src/CanvasHost.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

describe('canvas corner controls', () => {
  it('groups minimap toggle, settings, and zoom controls on the corner bar with accessible labels', () => {
    expect(source).toContain('class="canvas-corner-controls"')
    expect(source).toContain('class="canvas-corner-bar"')
    expect(source).toContain('role="group" aria-label="Minimap controls"')
    expect(source).toContain('role="group" aria-label="Canvas view controls"')
    expect(source).toContain('data-testid="canvas-zoom-out"')
    expect(source).toContain('data-testid="canvas-zoom-level"')
    expect(source).toContain('data-testid="canvas-fit-view"')
    expect(source).toContain('data-testid="canvas-zoom-in"')
    expect(source).toContain('data-tooltip-label="Zoom out"')
    expect(source).toContain('data-tooltip-label="Fit graph to view"')
    expect(source).toContain('data-tooltip-label="Zoom in"')
    expect(source).toContain('data-tooltip-label="Minimap settings"')
    expect(source).toContain('data-tooltip-label="Reset zoom to 100%"')
    expect(source).toContain('data-tooltip-label="Show bookmark numbers on the minimap"')
    // Setting rows show their labels as text; a tooltip would duplicate the
    // label and the row focused on menu open would spawn one over the menu.
    expect(source).toContain('aria-label={label} aria-checked={enabled()}')
    expect(source).not.toContain('data-tooltip-label={label}')
    // The visibility toggle is one stateful button whose accessible name
    // tracks the state it would produce.
    expect(source).toContain('data-testid="minimap-toggle"')
    expect(source).toMatch(/data-testid="minimap-toggle"[^>]*aria-pressed=\{minimapVisible\(\)\}/)
    expect(source).toContain("minimapVisible() ? 'Hide minimap' : 'Show minimap'")
  })

  it('keeps the overlay wrapper click-through and gives controls usable targets and states', () => {
    expect(styles).toMatch(/\.canvas-corner-controls\s*\{[^}]*pointer-events:\s*none/s)
    expect(styles).toMatch(/\.canvas-corner-controls\s+(?:button|\.canvas-corner-button)[^{]*\{[^}]*min-width:\s*36px[^}]*min-height:\s*36px/s)
    expect(styles).toContain('.canvas-corner-button:focus-visible')
    expect(styles).toContain('.canvas-corner-button:active:not(:disabled)')
    expect(styles).toMatch(/\.minimap-setting-row\s*\{[^}]*min-height:\s*36px/s)
    expect(styles).toContain('.minimap-setting-row:active')
  })

  it('stacks the minimap above the corner bar and keeps the settings menu beside the cluster', () => {
    // Column flow makes overlap between the minimap and the bar impossible
    // by construction; nothing is absolutely positioned over the map.
    expect(styles).toMatch(/\.canvas-corner-controls\s*\{[^}]*flex-direction:\s*column/s)
    expect(styles).toMatch(/\.canvas-corner-controls\s*\{[^}]*width:\s*min\(260px,/s)
    expect(styles).toMatch(/\.minimap\s*\{[^}]*height:\s*150px/s)
    expect(styles).not.toMatch(/\.minimap-menu\s*\{[^}]*inset:\s*0/s)
    expect(styles).toMatch(/\.minimap-menu\s*\{[^}]*right:\s*calc\(100% \+ 8px\)/s)
    const compactStart = styles.indexOf('@media (max-width: 520px) {', styles.indexOf('.canvas-corner-controls {'))
    const compactEnd = styles.indexOf('.canvas-view-controls {', compactStart)
    const compact = styles.slice(compactStart, compactEnd)
    expect(compactStart).toBeGreaterThanOrEqual(0)
    expect(compactEnd).toBeGreaterThan(compactStart)
    expect(compact).toMatch(/\.minimap\s*\{[^}]*height:\s*122px/s)
    // When the stage leaves no room beside the cluster the menu opens above,
    // driven by measurement in the host, not by a viewport media query.
    expect(styles).toMatch(/\.minimap-menu\.above\s*\{[^}]*bottom:\s*calc\(100% \+ 8px\)/s)
    expect(compact).not.toContain('.minimap-menu')
    // While the menu is open the cluster outranks the floating top toolbar
    // (z-index 7); the popover must never be painted over by other chrome.
    expect(styles).toMatch(/\.canvas-corner-controls:has\(\.minimap-menu\)\s*\{[^}]*z-index:\s*9/s)
  })

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
    expect(chrome).toContain('color: var(--dinkster-text-secondary)')
    expect(chrome).toContain('border: 1px solid var(--dinkster-border-strong)')
    expect(chrome).toContain('outline: var(--dinkster-focus-ring-width) solid var(--dinkster-border-focus)')
    expect(chrome).toContain('transition: transform var(--dinkster-motion-fast) var(--dinkster-motion-easing)')
    expect(chrome).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
  })
})
