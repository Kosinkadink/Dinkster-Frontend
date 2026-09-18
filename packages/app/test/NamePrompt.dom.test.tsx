// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NamePrompt } from '../src/NamePrompt.js'

afterEach(() => document.body.replaceChildren())

function mount() {
  const root = document.createElement('div')
  document.body.append(root)
  const commit = vi.fn()
  const cancel = vi.fn()
  render(() => <NamePrompt x={1} y={2} testid="subgraph-extract-prompt" placeholder="Subgraph name..." initial="Extracted Subgraph" onCommit={commit} onCancel={cancel} />, root)
  const input = root.querySelector('input')!
  return { input, commit, cancel }
}

describe('subgraph extraction name prompt contract', () => {
  it('commits the entered name on Enter', () => {
    const { input, commit, cancel } = mount()
    input.value = 'Reusable Body'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(commit).toHaveBeenCalledWith('Reusable Body')
    expect(cancel).not.toHaveBeenCalled()
  })

  it('cancels without committing on Escape', () => {
    const { input, commit, cancel } = mount()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(cancel).toHaveBeenCalledOnce()
    expect(commit).not.toHaveBeenCalled()
  })
})
