// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it } from 'vitest'
import { registerCatalog, setLocale } from '@dinkster/core'
import { AppView } from '../src/AppView.js'
import { AppState } from '../src/app-state.js'

afterEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
  setLocale('en')
})

describe('App View queue button component', () => {
  it('replaces the full-run fallback with named partial actions and an accessible target picker', async () => {
    const app = new AppState({ defaultProtocol: 'dinkster' })
    app.registerSchemas([{
      type: 'QueueOutput',
      displayName: 'Queue output',
      category: 'test',
      source: 'v3',
      isOutputNode: true,
      items: [],
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'queue-component', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Workflow', links: {}, nets: {}, reroutes: {}, nextOrdinal: 3,
          nodes: {
            base: { id: 'base', type: 'QueueOutput', title: 'Base result', values: {} },
            upscale: { id: 'upscale', type: 'QueueOutput', title: 'Upscale result', values: {} },
          },
        },
      },
      view: { graphs: { root: { nodes: {} } } },
    }, 'Queue component')

    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <AppView app={app} />, root)
    expect(root.querySelector('[data-testid="app-view-queue"]')?.textContent).toContain('Queue')

    const tab = app.activeTab()!
    tab.store.dispatch({ command: 'app.layout.add', params: {
      item: { id: 'base-action', kind: 'queue', label: 'Generate base', targets: [{ graphId: 'root', nodeId: 'base' }] },
    } })
    tab.store.dispatch({ command: 'app.layout.add', params: {
      item: { id: 'upscale-action', kind: 'queue', label: 'Upscale', targets: [{ graphId: 'root', nodeId: 'upscale' }] },
    } })
    await Promise.resolve()

    expect(root.querySelector('[data-testid="app-view-queue"]')).toBeNull()
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-testid="app-layout-queue-button"]')]
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Generate base', 'Upscale'])
    expect(buttons.every((button) => button.disabled === false)).toBe(true)
    expect(buttons.map((button) => document.getElementById(button.getAttribute('aria-describedby')!)?.textContent)).toEqual(['Ready', 'Ready'])

    ;(root.querySelector('[data-testid="app-view-arrange-toggle"]') as HTMLButtonElement).click()
    await Promise.resolve()
    const targetGroups = [...root.querySelectorAll<HTMLFieldSetElement>('[data-testid="app-layout-queue-targets"]')]
    expect(targetGroups).toHaveLength(2)
    const targetLegend = targetGroups[0]?.querySelector('legend')
    expect(targetLegend?.textContent).toBe('Partial execution targets')
    const arrangedButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-testid="app-layout-queue-button"]')]
    const arrangedStates = arrangedButtons.map((button) => document.getElementById(button.getAttribute('aria-describedby')!))
    expect(arrangedStates.map((state) => state?.textContent)).toEqual(['Ready', 'Ready'])

    registerCatalog('de-DE', {
      'appView.queue.state.ready': 'Bereit',
      'appView.queue.targets': 'Teilziele',
    })
    setLocale('de-DE')
    await Promise.resolve()
    expect(arrangedStates.map((state) => state?.textContent)).toEqual(['Bereit', 'Bereit'])
    expect(targetGroups[0]?.querySelector('legend')).toBe(targetLegend)
    expect(targetLegend?.textContent).toBe('Teilziele')
    expect(targetGroups[0]?.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
    expect(targetGroups[0]?.textContent).toContain('Base result')
    expect(targetGroups[0]?.textContent).toContain('Upscale result')

    dispose()
    app.dispose()
  })
})
