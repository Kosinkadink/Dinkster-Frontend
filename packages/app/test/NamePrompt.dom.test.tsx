// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { createSignal, Show } from 'solid-js'
import { asGraphDefId, asLineageId, type CommandOutcome } from '@dinkster/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NamePrompt } from '../src/NamePrompt.js'

afterEach(() => document.body.replaceChildren())

const acceptedOutcome: CommandOutcome = {
  ok: true, diagnostics: [], forward: [], inverse: [],
  doc: {
    format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('name-prompt'), root: asGraphDefId('g0'),
    graphs: { g0: { id: asGraphDefId('g0'), name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 } },
    view: { graphs: {} },
  },
}

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
  it('keeps the exact draft pending and refused, then closes after accepted retry', async () => {
    const { input, commit, cancel } = mount()
    await Promise.resolve()
    let settle!: (outcome: CommandOutcome) => void
    commit.mockImplementation(() => new Promise<CommandOutcome>((resolve) => { settle = resolve }))
    input.value = '  Reusable Body  '
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(input.readOnly).toBe(true)
    expect(input.parentElement?.getAttribute('aria-busy')).toBe('true')
    expect(commit).toHaveBeenCalledOnce()
    expect(cancel).not.toHaveBeenCalled()
    settle({ ok: false, diagnostics: [{ severity: 'error', origin: 'command', code: 'command.retention.refused', message: 'Name change refused' }] })
    await vi.waitFor(() => expect(input.readOnly).toBe(false))
    expect(input.value).toBe('  Reusable Body  ')
    expect(input.parentElement?.querySelector('[role="alert"]')?.textContent).toBe('Name change refused')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(cancel).not.toHaveBeenCalled()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(input.parentElement?.querySelector('[role="alert"]')).toBeNull()
    settle(acceptedOutcome)
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(commit).toHaveBeenLastCalledWith('  Reusable Body  ')
  })

  it.each([false, true])('ignores old completion after a keyed replacement (accepted: %s)', async (accepted) => {
    const root = document.createElement('div')
    document.body.append(root)
    const [owner, replace] = createSignal({ initial: 'Original' })
    const releases: Array<(outcome: CommandOutcome) => void> = []
    const cancel = vi.fn()
    const unmount = render(() => <Show when={owner()} keyed>{(current) => <NamePrompt
      x={1} y={2} testid="name" placeholder="Name" initial={current.initial}
      onCommit={() => new Promise((resolve) => releases.push(resolve))} onCancel={cancel}
    />}</Show>, root)
    await Promise.resolve()
    const input = () => root.querySelector('input')!
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    replace({ initial: 'Next original' })
    await Promise.resolve()
    input().value = 'New draft'
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    releases[0]!(accepted ? acceptedOutcome : { ok: false, diagnostics: [] })
    await Promise.resolve()
    expect(cancel).not.toHaveBeenCalled()
    expect(input().readOnly).toBe(true)
    expect(input().value).toBe('New draft')
    releases[1]!(acceptedOutcome)
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    unmount()
  })

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
