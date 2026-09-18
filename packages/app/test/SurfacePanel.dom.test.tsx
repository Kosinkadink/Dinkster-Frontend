// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  asControlSurfaceId,
  asGraphDefId,
  asLineageId,
  asNodeId,
  coreCommandRegistry,
  createSignal,
  DocumentStore,
  registerCatalog,
  setLocale,
  type ControlSurfaceData,
  type WorkflowDocument,
} from '@dinkster/core'
import type { AppState, CanvasBridge, Tab } from '../src/app-state.js'
import { SurfacePanel } from '../src/SurfacePanel.js'

const documentFixture = (): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: asLineageId('surface-locale'),
  root: asGraphDefId('g0'),
  graphs: {
    g0: {
      id: asGraphDefId('g0'),
      name: 'root',
      nodes: { n1: { id: asNodeId('n1'), type: 'RawNodeType', title: 'Raw node title', values: {} } },
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
    },
  },
  view: {
    graphs: {
      g0: {
        nodes: {},
        groups: { grp0: { id: 'grp0', title: 'Raw group title', bounds: { x: 0, y: 0, width: 100, height: 100 } } },
      },
    },
  },
  surfaces: {
    rawSurface: {
      id: asControlSurfaceId('rawSurface'),
      type: 'core.modePanel',
      config: {
        title: 'Raw surface title',
        bindings: [
          { kind: 'node', graphId: 'g0', nodeId: 'n1' },
          { kind: 'group', graphId: 'g0', groupId: 'grp0' },
          { kind: 'future', label: 'Raw future binding' },
        ],
      },
    },
  },
})

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

afterEach(() => {
  setLocale('en')
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('SurfacePanel locale boundary', () => {
  it('relabels mounted chrome while preserving open controls, raw data, and dispatch', async () => {
    registerCatalog('de-DE', {
      'controlSurfaces.action.addModePanel': '[MODUSFELD HINZUFUGEN]',
      'controlSurfaces.action.bindGroup': '[GRUPPE AN OBERFLACHE BINDEN]',
      'controlSurfaces.action.bindSelection': '[AUSWAHL BINDEN]',
      'controlSurfaces.action.deleteSurface': '[OBERFLACHE LOSCHEN]',
      'controlSurfaces.action.removeBinding': '[BINDUNG ENTFERNEN]',
      'controlSurfaces.binding.empty': '[KEINE BINDUNGEN]',
      'controlSurfaces.binding.group': '[GRUPPE: {title}]',
      'controlSurfaces.binding.unknown': '[UNBEKANNTE BINDUNG]',
      'controlSurfaces.config.invalid': '[KONFIGURATION UNGULTIG]',
      'controlSurfaces.config.unknownType': '[UNBEKANNTER OBERFLACHENTYP {type}]',
      'controlSurfaces.empty': '[KEINE OBERFLACHEN]',
      'controlSurfaces.mode.active': '[AKTIV]',
      'controlSurfaces.mode.bypass': '[UMGEHEN]',
      'controlSurfaces.mode.mute': '[STUMM]',
      'controlSurfaces.placeholder.bindGroup': '[GRUPPE BINDEN...]',
      'controlSurfaces.title': '[STEUEROBERFLACHEN]',
      'Raw group title': '[NICHT UBERSETZEN]',
      'Raw node title': '[NICHT UBERSETZEN]',
      'Raw surface title': '[NICHT UBERSETZEN]',
    })
    const store = new DocumentStore(documentFixture(), coreCommandRegistry())
    const tab = {
      id: 'tab0', title: 'Raw workflow', editorKind: 'canvas', store,
      graphStack: createSignal<readonly string[]>(['g0']),
      instancePath: createSignal<readonly string[]>([]),
    } as unknown as Tab
    const dispatchTo = vi.fn()
    const bridge = {
      selectedNodes: () => ['n1'],
      groupMembers: () => ['n1'],
    } as unknown as CanvasBridge
    const app = {
      tabs: createSignal<readonly Tab[]>([tab]),
      activeTabId: createSignal(tab.id),
      selectionTick: createSignal(0),
      canvasBridge: createSignal<CanvasBridge | undefined>(bridge),
      dispatchTo,
    } as unknown as AppState
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <SurfacePanel app={app} />, root)
    const panel = root.querySelector<HTMLElement>('[data-testid="surface-panel"]')!
    const surface = root.querySelector<HTMLElement>('[data-testid="surface-rawSurface"]')!
    const firstBinding = root.querySelector<HTMLElement>('[data-testid="surface-binding-rawSurface-0"]')!
    const groupSelect = root.querySelector<HTMLButtonElement>('[data-testid="surface-bind-group-rawSurface"]')!
    groupSelect.focus()
    groupSelect.click()
    await flush()
    const listbox = document.body.querySelector<HTMLElement>('[role="listbox"]')!

    setLocale('de-DE')
    await flush()

    expect(root.querySelector('h2')?.textContent).toBe('[STEUEROBERFLACHEN]')
    expect(root.querySelector('[data-testid="surface-add"]')?.textContent).toBe('[MODUSFELD HINZUFUGEN]')
    expect(groupSelect.getAttribute('aria-label')).toBe('[GRUPPE AN OBERFLACHE BINDEN]')
    expect(groupSelect.textContent).toContain('[GRUPPE BINDEN...]')
    expect(root.querySelector('[data-testid="surface-apply-active-rawSurface"]')?.textContent).toBe('[AKTIV]')
    expect(root.querySelector('[data-testid="surface-apply-muted-rawSurface"]')?.textContent).toBe('[STUMM]')
    expect(root.querySelector('[data-testid="surface-apply-bypassed-rawSurface"]')?.textContent).toBe('[UMGEHEN]')
    expect(root.querySelector('[data-testid="surface-remove-rawSurface"]')?.getAttribute('aria-label')).toBe('[OBERFLACHE LOSCHEN]')
    expect(root.querySelector('[data-testid="surface-unbind-rawSurface-0"]')?.getAttribute('aria-label')).toBe('[BINDUNG ENTFERNEN]')
    expect(root.textContent).toContain('Raw surface title')
    expect(root.textContent).toContain('Raw node title')
    expect(root.textContent).toContain('[GRUPPE: Raw group title]')
    expect(root.textContent).toContain('[UNBEKANNTE BINDUNG]')
    expect(root.querySelector('[data-testid="surface-panel"]')).toBe(panel)
    expect(root.querySelector('[data-testid="surface-rawSurface"]')).toBe(surface)
    expect(root.querySelector('[data-testid="surface-binding-rawSurface-0"]')).toBe(firstBinding)
    expect(document.body.querySelector('[role="listbox"]')).toBe(listbox)
    expect(document.activeElement).toBe(groupSelect)
    expect(store.revision).toBe(0)

    root.querySelector<HTMLButtonElement>('[data-testid="surface-apply-muted-rawSurface"]')!.click()
    expect(dispatchTo).toHaveBeenCalledWith(tab, {
      command: 'surface.mode.apply',
      params: { surfaceId: 'rawSurface', mode: 'muted', groupMembers: [{ graphId: 'g0', groupId: 'grp0', nodeIds: ['n1'] }] },
    })
    dispose()
  })

  it('localizes empty, invalid, and unknown surface states after mounting', async () => {
    registerCatalog('de-DE', {
      'controlSurfaces.binding.empty': '[KEINE BINDUNGEN]',
      'controlSurfaces.config.invalid': '[KONFIGURATION UNGULTIG]',
      'controlSurfaces.config.unknownType': '[UNBEKANNTER OBERFLACHENTYP {type}]',
      'controlSurfaces.empty': '[KEINE OBERFLACHEN]',
      'controlSurfaces.title': '[STEUEROBERFLACHEN]',
    })
    const mount = (workflow: WorkflowDocument) => {
      const store = new DocumentStore(workflow, coreCommandRegistry())
      const tab = {
        id: 'tab0', title: 'Raw workflow', editorKind: 'canvas', store,
        graphStack: createSignal<readonly string[]>(['g0']),
        instancePath: createSignal<readonly string[]>([]),
      } as unknown as Tab
      const app = {
        tabs: createSignal<readonly Tab[]>([tab]),
        activeTabId: createSignal(tab.id),
        selectionTick: createSignal(0),
        canvasBridge: createSignal<CanvasBridge | undefined>(undefined),
        dispatchTo: vi.fn(),
      } as unknown as AppState
      const root = document.createElement('div')
      document.body.append(root)
      return { root, dispose: render(() => <SurfacePanel app={app} />, root) }
    }

    const empty = documentFixture()
    const emptyPanel = mount({ ...empty, surfaces: {} })
    setLocale('de-DE')
    await flush()
    expect(emptyPanel.root.textContent).toContain('[KEINE OBERFLACHEN]')
    emptyPanel.dispose()
    emptyPanel.root.remove()

    setLocale('en')
    const surfaces: Record<string, ControlSurfaceData> = {
      emptyBindings: {
        id: asControlSurfaceId('emptyBindings'),
        type: 'core.modePanel',
        config: { title: 'Raw empty panel', bindings: [] },
      },
      invalidConfig: {
        id: asControlSurfaceId('invalidConfig'),
        type: 'core.modePanel',
        config: { title: 7 },
      },
      unknownType: {
        id: asControlSurfaceId('unknownType'),
        type: 'raw.futureSurface',
        config: {},
      },
    }
    const populatedPanel = mount({ ...documentFixture(), surfaces })
    setLocale('de-DE')
    await flush()
    expect(populatedPanel.root.textContent).toContain('[KEINE BINDUNGEN]')
    expect(populatedPanel.root.textContent).toContain('[KONFIGURATION UNGULTIG]')
    expect(populatedPanel.root.textContent).toContain('[UNBEKANNTER OBERFLACHENTYP raw.futureSurface]')
    populatedPanel.dispose()
  })
})
