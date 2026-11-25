import { createRoot, createSignal } from 'solid-js'
import { Images } from 'lucide-solid'
import { describe, expect, it } from 'vitest'
import { createPageTabHost, type PageTab } from '../src/page-tabs.js'

interface Workflow {
  readonly id: string
  readonly title: string
}

function fixture(
  run: (
    host: ReturnType<typeof createPageTabHost<Workflow>>,
    enabled: (value: boolean) => void,
  ) => void | Promise<void>,
) {
  return createRoot(async (dispose) => {
    const [tabs, setTabs] = createSignal<readonly (Workflow | PageTab)[]>([
      { id: 'left', title: 'Left' },
    ])
    const [activeId, setActiveId] = createSignal('left')
    const [enabled, setEnabled] = createSignal(true)
    const host = createPageTabHost<Workflow>({
      tabs,
      setTabs,
      activeId,
      setActiveId,
    })
    host.register({
      id: 'board',
      title: 'Board',
      icon: Images,
      component: () => null,
      enabled,
    })
    try {
      await run(host, setEnabled)
    } finally {
      dispose()
    }
  })
}

describe('page tab host', () => {
  it('opens by page id once, preserves opening parameters and focuses the existing tab', () =>
    fixture((host) => {
      const parameters = { pick: 'image' }
      const first = host.open('board', parameters)!
      host.setTabs([...host.tabs(), { id: 'right', title: 'Right' }])
      host.setActiveId('right')
      expect(host.open('board', { pick: 'audio' })).toBe(first)
      expect(host.tabs().map((tab) => tab.id)).toEqual([
        'left',
        first.id,
        'right',
      ])
      expect(host.activeId()).toBe(first.id)
      expect(first.parameters).toBe(parameters)
      expect(host.open('missing')).toBeUndefined()
    }))

  it('replaces a middle page in place, activates its workflow, and deduplicates an already published workflow', () =>
    fixture((host) => {
      const page = host.open('board')!
      host.setTabs([
        { id: 'opened', title: 'Old title' },
        ...host.tabs(),
        { id: 'right', title: 'Right' },
      ])
      expect(
        host.replaceWithWorkflow(page, { id: 'opened', title: 'Opened' }),
      ).toBe(true)
      expect(host.tabs()).toEqual([
        { id: 'left', title: 'Left' },
        { id: 'opened', title: 'Opened' },
        { id: 'right', title: 'Right' },
      ])
      expect(host.activeId()).toBe('opened')
      const reopened = host.open('board')!
      expect(
        host.replaceWithWorkflow(page, { id: 'late', title: 'Late' }),
      ).toBe(false)
      expect(host.activeId()).toBe(reopened.id)
      host.close(reopened.id)
      expect(host.tabs().map((tab) => tab.id)).toEqual([
        'left',
        'opened',
        'right',
      ])
    }))

  it('removes disabled and unregistered pages, repairs selection, and never reopens them on reenable', () =>
    fixture(async (host, setEnabled) => {
      const page = host.open('board')!
      host.setTabs([...host.tabs(), { id: 'right', title: 'Right' }])
      await Promise.resolve()
      setEnabled(false)
      expect(host.tabs().map((tab) => tab.id)).toEqual(['left', 'right'])
      expect(host.activeId()).toBe('right')
      expect(host.open('board')).toBeUndefined()
      setEnabled(true)
      expect(host.tabs().map((tab) => tab.id)).toEqual(['left', 'right'])
      const remove = createRoot((dispose) => {
        const unregister = host.register({
          id: 'picker',
          title: 'Picker',
          icon: Images,
          component: () => null,
        })
        return () => {
          unregister()
          dispose()
        }
      })
      host.open('picker')
      remove()
      expect(host.activeId()).toBe('right')
      expect(host.open('picker')).toBeUndefined()
      host.close(page.id)
      host.close('left')
      host.close('right')
      expect(host.tabs()).toEqual([])
      expect(host.activeId()).toBe('')
    }))
})
