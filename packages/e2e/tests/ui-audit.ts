/**
 * Layout audit helper: machine-checkable geometry invariants for DOM
 * surfaces (editor cards, dialogs, panels), so visual wreckage cannot hide
 * behind behaviorally green tests.
 *
 * Born from the 2026-07-25 asset editor field failure: every behavioral
 * assertion passed while the real editor rendered a 30px item sliver, a
 * 220x184px Choose button overlapping it, 68px-tall toolbar selects, and an
 * 18px search input. Each of those states violates an invariant below.
 *
 * The audit returns human-readable findings; specs assert the list is
 * empty, so a failure prints exactly what is visually wrong and where.
 */
import type { Page } from './fixtures.js'

export interface LayoutFinding {
  element: string
  finding: string
}

/** Audit every interactive element inside rootSelector. */
export function auditLayout(page: Page, rootSelector: string): Promise<LayoutFinding[]> {
  return page.evaluate((selector) => {
    const findings: { element: string; finding: string }[] = []
    const describe = (el: Element): string => {
      const tag = el.tagName.toLowerCase()
      const tid = el.getAttribute('data-testid')
      const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''
      const text = (el.textContent ?? '').trim().slice(0, 24)
      return `<${tag}${tid ? ` data-testid=${tid}` : ''}${cls}>${text ? ` "${text}"` : ''}`
    }
    const root = document.querySelector(selector)
    if (!root) return [{ element: selector, finding: 'root element not found' }]
    const rootRect = root.getBoundingClientRect()

    // The surface itself must sit inside the viewport.
    if (rootRect.left < -2 || rootRect.top < -2 || rootRect.right > window.innerWidth + 2 || rootRect.bottom > window.innerHeight + 2) {
      findings.push({ element: describe(root), finding: `extends outside the viewport (${Math.round(rootRect.left)},${Math.round(rootRect.top)} to ${Math.round(rootRect.right)},${Math.round(rootRect.bottom)} in ${window.innerWidth}x${window.innerHeight})` })
    }

    // No hidden horizontal overflow: content pushed out of a card is a
    // layout bug even when overflow: auto technically makes it scrollable.
    const overflowCandidates = [root, ...Array.from(root.querySelectorAll('*'))]
    for (const el of overflowCandidates) {
      const style = getComputedStyle(el)
      if (style.display === 'none') continue
      // Screen-reader descriptions are deliberately clipped to a 1px box and
      // have no visual layout to audit.
      if (style.clip !== 'auto' && el.clientWidth <= 1 && el.clientHeight <= 1) continue
      if (el !== root && style.overflowX === 'visible') continue
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        findings.push({ element: describe(el), finding: `horizontal overflow: content is ${el.scrollWidth}px wide inside ${el.clientWidth}px` })
      }
    }

    // Rect visible after clipping by every non-visible-overflow ancestor:
    // scrolled-out rows in a list are legitimately invisible, not findings.
    const clippedRect = (el: Element): DOMRect | null => {
      let rect = el.getBoundingClientRect()
      let ancestor = el.parentElement
      while (ancestor && root.contains(ancestor)) {
        const style = getComputedStyle(ancestor)
        if (style.overflow !== 'visible' || style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          const a = ancestor.getBoundingClientRect()
          const left = Math.max(rect.left, a.left); const top = Math.max(rect.top, a.top)
          const right = Math.min(rect.right, a.right); const bottom = Math.min(rect.bottom, a.bottom)
          if (right - left <= 0 || bottom - top <= 0) return null
          rect = new DOMRect(left, top, right - left, bottom - top)
        }
        ancestor = ancestor.parentElement
      }
      return rect
    }

    const interactive = Array.from(root.querySelectorAll('button, select, input, textarea, [role=option], [role=listbox]'))
    const visible: { el: Element; raw: DOMRect; clipped: DOMRect }[] = []
    for (const el of interactive) {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const raw = el.getBoundingClientRect()
      if (raw.width <= 0 || raw.height <= 0) continue
      const clipped = clippedRect(el)
      if (!clipped) continue
      visible.push({ el, raw, clipped })

      const role = el.getAttribute('role')
      if (role === 'listbox') {
        if (raw.width < 100) findings.push({ element: describe(el), finding: `list surface is a ${Math.round(raw.width)}px sliver (minimum 100px)` })
        continue
      }
      // Every control must be large enough to read and hit.
      if (raw.width < 24) findings.push({ element: describe(el), finding: `control is ${Math.round(raw.width)}px wide (minimum 24px)` })
      if (raw.height < 16) findings.push({ element: describe(el), finding: `control is ${Math.round(raw.height)}px tall (minimum 16px)` })
      // And single-line controls must not be stretched into blocks. Options
      // (tiles) and textareas are legitimately tall.
      const tag = el.tagName.toLowerCase()
      const singleLine = tag === 'select' || tag === 'button' || (tag === 'input' && (el as HTMLInputElement).type !== 'file')
      if (role !== 'option' && singleLine && raw.height > 48) {
        findings.push({ element: describe(el), finding: `control stretched to ${Math.round(raw.height)}px tall (maximum 48px)` })
      }
    }

    // No two visible controls may overlap unless one contains the other.
    for (let i = 0; i < visible.length; i++) {
      for (let j = i + 1; j < visible.length; j++) {
        const a = visible[i]!; const b = visible[j]!
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue
        const left = Math.max(a.clipped.left, b.clipped.left); const top = Math.max(a.clipped.top, b.clipped.top)
        const right = Math.min(a.clipped.right, b.clipped.right); const bottom = Math.min(a.clipped.bottom, b.clipped.bottom)
        if (right - left > 6 && bottom - top > 6) {
          findings.push({ element: describe(a.el), finding: `overlaps ${describe(b.el)} by ${Math.round(right - left)}x${Math.round(bottom - top)}px` })
        }
      }
    }
    return findings
  }, rootSelector)
}
