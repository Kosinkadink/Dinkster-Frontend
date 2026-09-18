import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

const block = (startSelector: string, endSelector: string): string => {
  const start = styles.indexOf(startSelector)
  const end = styles.indexOf(endSelector, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return styles.slice(start, end)
}

describe('pop-out, floating, and projects chrome styling', () => {
  it('styles the projects dialog with design tokens, including button and input states', () => {
    const projects = block('.projects-dialog {', '.settings-editor {')
    expect(projects).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
    expect(projects).toContain('.projects-dialog-actions button:focus-visible')
    expect(projects).toContain('.projects-dialog input:focus-visible')
    expect(projects).not.toContain('outline: none')
  })

  it('gives detached and missing-panel window states interactive button styling', () => {
    const detached = block('.detached-workspace-state {', '.seed-controller-menu {')
    expect(detached).toContain('.native-panel-window-missing button')
    expect(detached).toMatch(/\.detached-workspace-state button:hover/)
    expect(detached).toMatch(/\.native-panel-window-missing button:hover/)
    expect(detached).toMatch(/\.detached-workspace-state button:focus-visible/)
    expect(detached).toMatch(/\.native-panel-window-missing button:focus-visible/)
    expect(detached).toMatch(/cursor: pointer/)
  })
})
