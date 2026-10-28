import { describe, expect, it } from 'vitest'
import { shellStyles as styles } from './fixtures/styles.js'

const block = (startSelector: string, endSelector: string): string => {
  const start = styles.indexOf(startSelector)
  const end = styles.indexOf(endSelector, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return styles.slice(start, end)
}

describe('pop-out, floating, and projects chrome styling', () => {
  it('restricts projects-dialog colors and focus rules to semantic design tokens', () => {
    const projects = block('.projects-dialog {', '.settings-editor {')
    expect(projects).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
    const focus = block(':is(button, input, select, textarea, summary, a, [tabindex]):focus-visible {', '*::-webkit-scrollbar {')
    expect(focus).toContain('outline: var(--dinkster-focus-ring-width) solid var(--dinkster-border-focus)')
    expect(projects).not.toContain('outline: none')
  })
})
