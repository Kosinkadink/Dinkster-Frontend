import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import { DINKSTER_SCHEMA_WIRE_VERSION } from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { App } from '../src/App.js'
import { AppState } from '../src/app-state.js'
import { prepareWorkflowApp } from './fixtures/workflow-app.js'

vi.mock('../src/CanvasHost.js', async (original) => ({
  ...await original<typeof import('../src/CanvasHost.js')>(),
  CanvasHost: () => <div />,
}))

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
  localStorage.clear()
  vi.restoreAllMocks()
})

it.each(['primary', 'workflow', 'panel', 'missing-panel'] as const)(
  'shows the active engine services beside the brand in a %s window with the status bar hidden',
  async (kind) => {
    const app = prepareWorkflowApp(new AppState())
    app.shell.statusBarVisible.set(false)
    const host = document.createElement('div')
    document.body.append(host)
    const context = kind === 'primary' ? { id: 'primary', kind: 'primary' as const }
      : kind === 'workflow' ? { id: 'workflow', kind: 'workflow' as const, workflowId: app.activeTab()!.id }
        : { id: 'panel', kind: 'panel' as const, panelId: kind === 'panel' ? 'problems' : 'missing', returnPlacement: 'dock' as const }
    dispose = render(() => <App app={app} desktopWindow={{ context, layout: { windows: [context] } }} />, host)
    const backend = app.backends.get()[0]!
    for (const [name, label] of [['qa', 'QA services'], ['production', undefined], ['custom', 'Custom services'], ['invalid', undefined], [undefined, undefined]] as const) {
      backend.registry.set(buildDinksterRegistry(backend.id, { nodes: {}, dinkster: {
        version: 'test', schemaWire: DINKSTER_SCHEMA_WIRE_VERSION,
        ...(name === undefined ? {} : { services: { name } }),
      } }))
      await vi.waitFor(() => {
        const badge = host.querySelector('[data-testid="services-badge"]')
        if (label === undefined) expect(badge).toBeNull()
        else {
          expect(badge?.textContent).toBe(label)
          expect(badge?.parentElement?.querySelector('.brand-wordmark, .brand-symbol')).not.toBeNull()
          expect(badge?.closest('footer')).toBeNull()
        }
      })
    }
  },
)
