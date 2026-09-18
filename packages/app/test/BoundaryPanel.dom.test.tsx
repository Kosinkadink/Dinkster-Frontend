// @vitest-environment happy-dom

import { registerCatalog, setLocale, type NodeSchema } from '@dinkster/core'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppState, pushGraph } from '../src/app-state.js'
import { BoundaryPanel } from '../src/BoundaryPanel.js'

const schema: NodeSchema = {
  type: 'GrowTest',
  displayName: 'Grow Test',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [
    {
      kind: 'input',
      id: 'amount',
      displayName: 'Amount',
      type: { kind: 'concrete', name: 'FLOAT' },
      optional: false,
      widget: { widgetType: 'core.float', options: {}, default: 1 },
    },
    {
      kind: 'input',
      id: 'items',
      type: { kind: 'wildcard' },
      optional: false,
      dynamic: {
        kind: 'autogrow',
        template: [
          { kind: 'input', id: 'tag', displayName: 'Tag', type: { kind: 'concrete', name: 'STRING' }, optional: true },
          { kind: 'input', id: 'image', displayName: 'Image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
        ],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
      },
    },
  ],
}

const mountPanel = (withWidgetTap = false) => {
  const app = new AppState()
  const backend = app.backends.get()[0]!
  backend.registry.set({
    connection: backend.id,
    hash: 'boundary-panel-test',
    schemas: new Map([[schema.type, schema]]),
    diagnostics: [],
    resolve: (type) => type === schema.type ? schema : undefined,
  })
  const diagnostics = app.openDocument({
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'boundary-panel-component',
    root: 'g0',
    graphs: {
      g0: {
        id: 'g0',
        name: 'root',
        nodes: { occ: { id: 'occ', type: '#sub', values: {} } },
        links: {},
        nets: {},
        reroutes: {},
        nextOrdinal: 2,
      },
      sub: {
        id: 'sub',
        name: 'sub',
        nodes: { n1: { id: 'n1', type: 'GrowTest', values: {} } },
        links: {},
        nets: {},
        reroutes: {},
        boundary: {
          inputs: [{ id: 'items', displayName: 'Items', binds: { kind: 'family', node: 'n1', port: 'items', slots: ['image', 'tag'] } }],
          outputs: withWidgetTap
            ? [{ id: 'amount', displayName: 'Amount', binds: { kind: 'widgetTap', node: 'n1', tap: 'amount' } }]
            : [],
        },
        nextOrdinal: 2,
      },
    },
    view: {
      graphs: {
        g0: { nodes: { occ: { position: { x: 0, y: 0 } } } },
        sub: { nodes: { n1: { position: { x: 10, y: 20 } } } },
      },
    },
  }, 'Boundary component')
  expect(diagnostics).toEqual([])
  const tab = app.activeTab()!
  // Drill in through the real occurrence so navigation survives the
  // document-change reconciler (graphStack.length === instancePath.length + 1).
  pushGraph(tab, 'sub', 'occ')
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <BoundaryPanel app={app} />, root)
  return { app, tab, root, unmount }
}

beforeEach(() => setLocale('en'))
afterEach(() => document.body.replaceChildren())

describe('BoundaryPanel keyboard and accessibility', () => {
  it('exposes a named region, named item group, and labelled product controls in focus order', () => {
    const { root, unmount } = mountPanel()
    const panel = root.querySelector<HTMLElement>('[data-testid="boundary-panel"]')!
    expect(panel.getAttribute('role')).toBe('region')
    expect(panel.getAttribute('aria-label')).toBe('Boundary editor')
    const item = panel.querySelector<HTMLElement>('[data-testid="boundary-item"]')!
    expect(item.getAttribute('role')).toBe('group')
    expect(item.getAttribute('aria-label')).toBe('Input Items')

    const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled)')]
    expect(controls.map((control) => control.getAttribute('data-testid'))).toEqual([
      'boundary-show-on-canvas',
      'boundary-unpin',
      'slot-toggle',
      'slot-toggle',
    ])
    expect(controls.map((control) => control.getAttribute('aria-label') ?? control.textContent?.trim())).toEqual([
      'Show Items destination on canvas',
      'Track all slots',
      'Expose Tag: whole',
      'Expose Image: whole',
    ])
    for (const control of controls) {
      control.focus()
      expect(document.activeElement).toBe(control)
    }
    unmount()
  })

  it('routes an explicit destination action through canonical canvas focus without editing', () => {
    const { app, tab, root, unmount } = mountPanel()
    const revision = tab.store.revision
    root.querySelector<HTMLButtonElement>('[data-testid="boundary-show-on-canvas"]')!.click()
    expect(tab.store.revision).toBe(revision)
    expect(app.diagnosticFocus.get()).toMatchObject({
      tab,
      anchor: { port: { node: 'n1', port: 'items' } },
      portInstancePath: ['occ'],
    })
    unmount()
  })

  it('identifies and focuses an exact widget-output binding', () => {
    const { app, tab, root, unmount } = mountPanel(true)
    const item = root.querySelector<HTMLElement>('[data-binding-kind="widgetTap"]')!
    expect(item.getAttribute('aria-label')).toBe('Output Amount')
    expect(item.querySelector('.boundary-kind')?.textContent).toBe('Widget output')
    expect(item.querySelector('.boundary-bind')?.textContent?.trim()).toBe('n1.amount')

    item.querySelector<HTMLButtonElement>('[data-testid="boundary-show-on-canvas"]')!.click()
    expect(app.diagnosticFocus.get()).toMatchObject({
      tab,
      anchor: { port: { node: 'n1', port: 'amount' } },
      portInstancePath: ['occ'],
    })
    unmount()
  })

  it('edits and clears a user-defined boundary display name', () => {
    const { tab, root, unmount } = mountPanel()
    const input = root.querySelector<HTMLInputElement>('[data-testid="boundary-name-input"]')!
    expect(input.getAttribute('aria-label')).toBe('Input items display name')
    expect(input.value).toBe('Items')

    input.value = 'Batch Masks'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(tab.store.doc.graphs.sub!.boundary!.inputs[0]!.displayName).toBe('Batch Masks')

    let updated = root.querySelector<HTMLInputElement>('[data-testid="boundary-name-input"]')!
    updated.focus()
    updated.value = 'Discarded draft'
    updated.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(updated.value).toBe('Batch Masks')
    expect(tab.store.doc.graphs.sub!.boundary!.inputs[0]!.displayName).toBe('Batch Masks')

    updated = root.querySelector<HTMLInputElement>('[data-testid="boundary-name-input"]')!
    updated.value = '   '
    updated.dispatchEvent(new Event('change', { bubbles: true }))
    expect(tab.store.doc.graphs.sub!.boundary!.inputs[0]!.displayName).toBeUndefined()
    unmount()
  })

  it('toggles a slot with Enter and lets Escape leave the control without another edit', () => {
    const { tab, root, unmount } = mountPanel()
    const panel = root.querySelector<HTMLElement>('[data-testid="boundary-panel"]')!
    const tag = root.querySelector<HTMLButtonElement>('[data-slot-path="tag"]')!
    tag.focus()
    tag.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const item = tab.store.doc.graphs.sub!.boundary!.inputs[0]!
    expect(item.binds.slots).toEqual(['image'])
    const updatedTag = root.querySelector<HTMLButtonElement>('[data-slot-path="tag"]')!
    expect(updatedTag.getAttribute('aria-checked')).toBe('false')

    updatedTag.focus()
    updatedTag.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(panel)
    expect(item.binds.slots).toEqual(['image'])
    unmount()
  })

  it('announces derivation errors and refused empty selections', () => {
    const { root, unmount } = mountPanel()
    const image = root.querySelector<HTMLButtonElement>('[data-slot-path="image"]')!
    image.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(root.querySelector('[data-testid="boundary-diag"]')?.getAttribute('role')).toBe('alert')

    const tag = root.querySelector<HTMLButtonElement>('[data-slot-path="tag"]')!
    tag.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(root.querySelector('[data-testid="boundary-notice"]')?.getAttribute('role')).toBe('status')
    unmount()
  })

  it('presents invalid, unavailable, and empty states without inventing mutations', () => {
    const invalid = mountPanel()
    expect(invalid.tab.store.dispatch({
      command: 'boundary.setSlots',
      params: { graphId: 'sub', side: 'inputs', itemId: 'items', slots: ['unknown'] },
    }).ok).toBe(true)
    const diagnostic = invalid.root.querySelector<HTMLElement>('[data-testid="boundary-diag"]')!
    expect(diagnostic.getAttribute('role')).toBe('alert')
    expect(diagnostic.getAttribute('data-code')).toBe('boundary.slotUnknown')
    invalid.unmount()

    const unavailable = mountPanel()
    unavailable.app.backends.get()[0]!.registry.set(undefined)
    unavailable.app.backendsTick.set(unavailable.app.backendsTick.get() + 1)
    const state = unavailable.root.querySelector<HTMLElement>('[data-testid="boundary-unavailable"]')!
    expect(state.getAttribute('role')).toBe('status')
    expect(state.textContent).toContain('Exposure unavailable')
    unavailable.unmount()

    const empty = mountPanel()
    expect(empty.tab.store.dispatch({
      command: 'boundary.unbind',
      params: { graphId: 'sub', side: 'inputs', itemId: 'items', node: 'n1', port: 'items' },
    }).ok).toBe(true)
    const emptyStates = [...empty.root.querySelectorAll<HTMLElement>('[data-testid="boundary-empty"]')]
    expect(emptyStates.map((element) => [element.getAttribute('data-side'), element.getAttribute('role')])).toEqual([
      ['inputs', 'status'],
      ['outputs', 'status'],
    ])
    empty.unmount()
  })
})

const regionSchema: NodeSchema = {
  type: 'RegionBody',
  displayName: 'Region Body',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [
    { kind: 'input', id: 'item_in', type: { kind: 'concrete', name: 'core.int' }, optional: false },
    { kind: 'input', id: 'state_in', type: { kind: 'concrete', name: 'core.int' }, optional: false },
    { kind: 'input', id: 'capture_in', type: { kind: 'concrete', name: 'core.int' }, optional: false },
    { kind: 'output', id: 'gather_out', type: { kind: 'concrete', name: 'core.int' } },
    { kind: 'output', id: 'state_out', type: { kind: 'concrete', name: 'core.int' } },
    { kind: 'output', id: 'flat_out', type: { kind: 'concrete', name: 'core.int' }, isList: true },
    { kind: 'output', id: 'continue_out', type: { kind: 'concrete', name: 'core.boolean' } },
  ],
}

const mountRegionPanel = (occurrence = 'fold') => {
  const app = new AppState()
  const backend = app.backends.get()[0]!
  backend.registry.set({
    connection: backend.id,
    hash: 'region-panel-test',
    schemas: new Map([[regionSchema.type, regionSchema]]),
    diagnostics: [],
    resolve: (type) => type === regionSchema.type ? regionSchema : undefined,
  })
  expect(app.openDocument({
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'region-panel', root: 'root',
    graphs: {
      root: {
        id: 'root', name: 'root', links: {}, nets: {}, reroutes: {}, nextOrdinal: 3,
        nodes: {
          fold: {
            id: 'fold', type: '#body', values: { item: [], state: 0 },
            region: {
              kind: 'fold', elementPorts: ['item'], statePorts: ['state'],
              outputRoles: { stateResult: { kind: 'state', statePort: 'state' }, flattened: { kind: 'flatten' } },
            },
          },
          while: {
            id: 'while', type: '#body', values: { state: 0 },
            region: {
              kind: 'while', statePorts: ['state'],
              outputRoles: { stateResult: { kind: 'state', statePort: 'state' } },
              continueOutput: 'continue', maxIterations: 10,
            },
          },
        },
      },
      body: {
        id: 'body', name: 'Region body', links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
        nodes: { n1: { id: 'n1', type: 'RegionBody', values: {} } },
        boundary: {
          inputs: [
            { id: 'item', displayName: 'Item', binds: { kind: 'port', node: 'n1', port: 'item_in' } },
            { id: 'state', displayName: 'State', binds: { kind: 'port', node: 'n1', port: 'state_in' } },
            { id: 'capture', displayName: 'Capture', binds: { kind: 'port', node: 'n1', port: 'capture_in' } },
          ],
          outputs: [
            { id: 'gathered', displayName: 'Gathered', binds: { kind: 'port', node: 'n1', port: 'gather_out' } },
            { id: 'stateResult', displayName: 'State Result', binds: { kind: 'port', node: 'n1', port: 'state_out' } },
            { id: 'flattened', displayName: 'Flattened', binds: { kind: 'port', node: 'n1', port: 'flat_out' } },
            { id: 'continue', displayName: 'Continue', binds: { kind: 'port', node: 'n1', port: 'continue_out' } },
          ],
        },
      },
    },
    view: {
      graphs: {
        root: { nodes: { fold: { position: { x: 0, y: 0 } }, while: { position: { x: 200, y: 0 } } } },
        body: { nodes: { n1: { position: { x: 20, y: 20 } } } },
      },
    },
  }, 'Region panel')).toEqual([])
  const tab = app.activeTab()!
  pushGraph(tab, 'body', occurrence)
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <BoundaryPanel app={app} />, root)
  return { app, tab, root, unmount }
}

describe('BoundaryPanel region occurrence context', () => {
  it('shows every role fact and accessible editing group for the drilled occurrence', () => {
    const { root, unmount } = mountRegionPanel()
    const panel = root.querySelector<HTMLElement>('[data-testid="region-panel"]')!
    expect(panel.getAttribute('role')).toBe('group')
    expect(panel.getAttribute('aria-label')).toBe('Fold region settings')
    expect([...root.querySelectorAll('[data-region-role]')].map((item) => item.getAttribute('data-region-role'))).toEqual([
      'element', 'state', 'capture', 'gather', 'state', 'flatten', 'gather',
    ])
    expect([...root.querySelectorAll('[data-region-output="gathered"][data-role-choice]')]
      .map((item) => item.getAttribute('data-role-choice'))).toEqual(['gather', 'compact', 'flatten', 'continue'])
    expect([...root.querySelectorAll('[data-region-output="gathered"][data-role-choice]')]
      .map((item) => [item.getAttribute('data-tooltip-label'), item.getAttribute('data-tooltip-detail')])).toEqual([
      ['Gather output - Collect one value per iteration. If any iteration produces no value, this output is absent.', 'Edits this region occurrence only; the shared definition is unchanged.'],
      ['Compact output - Collect only values produced by present iterations, without gaps.', 'Edits this region occurrence only; the shared definition is unchanged.'],
      ['Flatten output - Concatenate list values from every iteration. If any iteration produces no value, this output is absent.', 'Edits this region occurrence only; the shared definition is unchanged.'],
      ['Continuation output - Use this Boolean output to decide whether a while region runs another iteration.', 'Edits this region occurrence only; the shared definition is unchanged.'],
    ])
    expect(root.querySelector('[data-region-output="stateResult"][data-state-port="state"]')?.getAttribute('data-tooltip-label'))
      .toBe('State output: state - Return the final value carried by state input "state".')
    const groups = [...root.querySelectorAll<HTMLElement>('[role="group"]')].map((group) => group.getAttribute('aria-label'))
    expect(groups).toEqual(expect.arrayContaining(['Input Item role', 'Output State Result role', 'Region binding', 'Maximum iterations']))
    for (const control of panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')) {
      expect(control.getAttribute('aria-label') ?? control.textContent?.trim()).toBeTruthy()
      control.focus()
      expect(document.activeElement).toBe(control)
    }
    unmount()
  })

  it('dispatches exact region commands from each editing control', () => {
    const { tab, root, unmount } = mountRegionPanel()
    const dispatch = vi.spyOn(tab.store, 'dispatch')
    const click = (selector: string) => root.querySelector<HTMLButtonElement>(selector)!.click()
    click('[data-region-input="capture"][data-role-choice="element"]')
    expect(dispatch).toHaveBeenLastCalledWith({ command: 'region.setPortRole', params: {
      graphId: 'root', nodeId: 'fold', side: 'input', portId: 'capture', role: 'element',
    } })
    click('[data-region-output="gathered"][data-role-choice="compact"]')
    expect(dispatch).toHaveBeenLastCalledWith({ command: 'region.setOutputRole', params: {
      graphId: 'root', nodeId: 'fold', outputId: 'gathered', role: 'compact',
    } })
    click('[data-region-output="stateResult"][data-state-port="state"]')
    expect(dispatch).toHaveBeenLastCalledWith({ command: 'region.setOutputRole', params: {
      graphId: 'root', nodeId: 'fold', outputId: 'stateResult', role: 'state', statePort: 'state',
    } })
    click('[data-region-output="continue"][data-role-choice="continue"]')
    expect(dispatch).toHaveBeenLastCalledWith({ command: 'region.setContinueOutput', params: {
      graphId: 'root', nodeId: 'fold', outputId: 'continue',
    } })
    click('[data-region-binding="broadcast"]')
    expect(dispatch).toHaveBeenLastCalledWith({ command: 'region.setBinding', params: {
      graphId: 'root', nodeId: 'fold', binding: 'broadcast',
    } })
    const max = root.querySelector<HTMLInputElement>('[data-testid="region-max-iterations"]')!
    max.value = '12'
    max.dispatchEvent(new Event('change', { bubbles: true }))
    expect(dispatch).toHaveBeenLastCalledWith({ command: 'region.setMaxIterations', params: {
      graphId: 'root', nodeId: 'fold', maxIterations: 12,
    } })
    max.value = ''
    max.dispatchEvent(new InputEvent('input', { bubbles: true }))
    max.dispatchEvent(new Event('change', { bubbles: true }))
    expect(dispatch).toHaveBeenLastCalledWith({ command: 'region.setMaxIterations', params: {
      graphId: 'root', nodeId: 'fold', maxIterations: null,
    } })
    unmount()
  })

  it('updates mounted role explanations when the host locale changes', async () => {
    registerCatalog('de-DE', {
      'boundary.region.output.compact': 'Sammelt nur vorhandene Iterationswerte.',
      'boundary.region.output.compact.title': 'Kompakte Ausgabe',
      'boundary.region.output.explanation': '{role} - {explanation}',
    })
    const { root, unmount } = mountRegionPanel()
    const compact = root.querySelector<HTMLElement>('[data-region-output="gathered"][data-role-choice="compact"]')!
    expect(compact.getAttribute('data-tooltip-label')).toContain('Compact output')

    setLocale('de-DE')
    await vi.waitFor(() => expect(compact.getAttribute('data-tooltip-label'))
      .toBe('Kompakte Ausgabe - Sammelt nur vorhandene Iterationswerte.'))
    unmount()
  })

  it('disables maximum iterations in a frozen execution view', () => {
    const mounted = mountRegionPanel()
    Object.defineProperty(mounted.tab, 'execution', { value: { backendId: 'proof', executionId: 'proof' }, configurable: true })
    mounted.app.tabs.set([...mounted.app.tabs.get()])
    expect(mounted.root.querySelector('[data-testid="boundary-frozen"]')?.getAttribute('role')).toBe('status')
    expect(mounted.root.querySelector<HTMLInputElement>('[data-testid="region-max-iterations"]')!.disabled).toBe(true)
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-testid="boundary-show-on-canvas"]')!.disabled).toBe(false)
    expect([...mounted.root.querySelectorAll<HTMLButtonElement>('.region-role-controls button')].every((button) => button.disabled)).toBe(true)
    mounted.unmount()
  })

  it('distinguishes two occurrences and surfaces a while broadcast refusal legibly', () => {
    const { tab, root, unmount } = mountRegionPanel('while')
    root.querySelector<HTMLButtonElement>('[data-region-binding="broadcast"]')!.click()
    expect(tab.store.doc.graphs.root!.nodes.while!.region?.binding).toBeUndefined()
    const notice = root.querySelector<HTMLElement>('[data-testid="region-notice"]')!
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain('while cannot use broadcast binding')
    expect(tab.store.doc.graphs.root!.nodes.fold!.region?.binding).toBeUndefined()
    unmount()
  })

  it('fails closed for desynchronized or deleted occurrences while ordinary boundary editing remains', () => {
    const desync = mountRegionPanel()
    desync.tab.graphStack.update((stack) => [...stack, 'body'])
    expect(desync.root.querySelector('[data-testid="region-panel"]')).toBeNull()
    expect(desync.root.querySelector('[data-testid="boundary-panel"]')).not.toBeNull()
    expect(desync.root.querySelectorAll('[data-testid="boundary-item"]')).toHaveLength(7)
    desync.unmount()

    const deleted = mountRegionPanel()
    expect(deleted.tab.store.dispatch({ command: 'node.remove', params: { graphId: 'root', nodeIds: ['fold'] } }).ok).toBe(true)
    expect(deleted.root.querySelector('[data-testid="region-panel"]')).toBeNull()
    expect(deleted.tab.graphStack.get()).toEqual(['root'])
    deleted.unmount()
  })
})
