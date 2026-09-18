// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollectionSource } from '@dinkster/core'
import { CollectionPanel } from '../src/CollectionPanel.js'

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

afterEach(() => document.body.replaceChildren())

describe('CollectionPanel grouped rows', () => {
  it('renders a collapsed count row and expands individual runs in order', async () => {
    const activate = vi.fn()
    const source: CollectionSource = {
      id: 'runs',
      label: 'Runs',
      page: async () => ({
        items: [{
          id: 'noop:digest:old',
          title: 'latest run',
          badges: ['completed', 'x2'],
          children: [
            { id: 'new', title: 'new run' },
            { id: 'old', title: 'old run' },
          ],
        }],
      }),
    }
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <CollectionPanel sources={[source]} onActivate={(_source, entry) => activate(entry.id)} />, root)
    await flush()

    expect(root.querySelectorAll('[data-testid="collection-entry"]')).toHaveLength(1)
    expect(root.textContent).toContain('x2')
    const expand = root.querySelector<HTMLButtonElement>('[data-testid="collection-expand"]')!
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    expand.click()
    expect(expand.getAttribute('aria-expanded')).toBe('true')
    expect([...root.querySelectorAll('.collection-child .collection-title')].map((el) => el.textContent))
      .toEqual(['new run', 'old run'])
    const parent = root.querySelector<HTMLElement>('[data-entry="noop:digest:old"]')!
    const firstChild = root.querySelector<HTMLElement>('[data-entry="new"]')!
    parent.focus()
    parent.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await flush()
    expect(document.activeElement).toBe(firstChild)
    expect(firstChild.tabIndex).toBe(0)
    firstChild.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(activate).toHaveBeenCalledWith('new')
  })

  it('requires an explicit second activation before deleting a run record', async () => {
    const action = vi.fn()
    const source: CollectionSource = {
      id: 'runs',
      label: 'Runs',
      page: async () => ({ items: [{
        id: 'run-1',
        title: 'Completed run',
        actions: [{ id: 'delete', label: 'Delete record' }],
      }] }),
    }
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <CollectionPanel sources={[source]} onAction={(_source, entry, id) => action(entry.id, id)} />, root)
    await flush()

    root.querySelector<HTMLElement>('[data-entry="run-1"]')!.click()
    const remove = root.querySelector<HTMLButtonElement>('[data-action="delete"]')!
    remove.click()
    expect(remove.textContent).toBe('Confirm delete')
    expect(remove.getAttribute('aria-pressed')).toBe('true')
    expect(action).not.toHaveBeenCalled()
    remove.click()
    expect(action).toHaveBeenCalledWith('run-1', 'delete')
  })

  it('cancels inline delete confirmation whenever selection changes', async () => {
    const action = vi.fn()
    const source: CollectionSource = {
      id: 'runs',
      label: 'Runs',
      page: async () => ({ items: [
        { id: 'run-1', title: 'First run', actions: [{ id: 'delete', label: 'Delete record' }] },
        { id: 'run-2', title: 'Second run', actions: [{ id: 'delete', label: 'Delete record' }] },
      ] }),
    }
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <CollectionPanel sources={[source]} onAction={(_source, entry, id) => action(entry.id, id)} />, root)
    await flush()

    root.querySelector<HTMLElement>('[data-entry="run-1"]')!.click()
    root.querySelector<HTMLButtonElement>('[data-action="delete"]')!.click()
    expect(root.querySelector<HTMLButtonElement>('[data-action="delete"]')!.textContent).toBe('Confirm delete')

    root.querySelector<HTMLElement>('[data-entry="run-2"]')!.click()
    root.querySelector<HTMLElement>('[data-entry="run-1"]')!.click()
    const remove = root.querySelector<HTMLButtonElement>('[data-action="delete"]')!
    expect(remove.textContent).toBe('Delete record')
    remove.click()
    expect(remove.textContent).toBe('Confirm delete')
    expect(action).not.toHaveBeenCalled()
  })
})
