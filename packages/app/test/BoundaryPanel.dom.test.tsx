// @vitest-environment happy-dom

import { boundaryItems, registerCatalog, setLocale, type NodeSchema, type WorkflowDocument } from '@dinkster/core'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppState, pushGraph, truncateGraphStack } from '../src/app-state.js'
import { BoundaryPanel } from '../src/BoundaryPanel.js'
import { prepareWorkflowApp } from './fixtures/workflow-app.js'

const apps: AppState[] = []

const blend: NodeSchema = {
  type: 'BlendTest',
  displayName: 'Blend',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  body: [
    { kind: 'input', id: 'image', displayName: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
    { kind: 'input', id: 'mask', displayName: 'mask', type: { kind: 'concrete', name: 'MASK' }, optional: true },
    {
      kind: 'input', id: 'strength', displayName: 'strength', type: { kind: 'concrete', name: 'FLOAT' }, optional: false,
      widget: { widgetType: 'FLOAT', options: { min: 0, max: 1, step: 0.05 }, default: 0.5 },
    },
    {
      kind: 'input', id: 'mode', displayName: 'mode', type: { kind: 'concrete', name: 'COMBO' }, optional: false,
      widget: { widgetType: 'COMBO', options: { options: ['as is', 'screen'] }, default: 'as is' },
    },
    { kind: 'output', id: 'out', displayName: 'image', type: { kind: 'concrete', name: 'IMAGE' } },
  ],
}

const blendDocument = (extra: { valueSource?: boolean } = {}): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'boundary-panel-component',
  root: 'g0',
  graphs: {
    g0: {
      id: 'g0', name: 'root', links: {}, nets: {}, reroutes: {}, nextOrdinal: 3,
      nodes: {
        occ: { id: 'occ', type: '#sub', values: {} },
        occ2: { id: 'occ2', type: '#sub', values: {} },
      },
    },
    sub: {
      id: 'sub', name: 'Soften', links: {}, nets: {}, reroutes: {}, nextOrdinal: 3,
      nodes: {
        n1: { id: 'n1', type: 'BlendTest', values: { strength: 0.45 } },
        n2: { id: 'n2', type: 'BlendTest', title: 'Blur', values: {} },
      },
      ...(extra.valueSource ? { valueSources: { v0: { id: 'v0', title: 'Literal amount', value: 23 } } } : {}),
      boundary: {
        body: [
          { kind: 'input', id: 'image', binds: { kind: 'port', node: 'n1', port: 'image' }, alsoBinds: [{ kind: 'port', node: 'n2', port: 'image' }] },
          { kind: 'input', id: 'mask', binds: { kind: 'port', node: 'n1', port: 'mask' } },
          { kind: 'input', id: 'strength', displayName: 'Strength', binds: { kind: 'port', node: 'n1', port: 'strength' }, promoted: true },
          { kind: 'input', id: 'mode', binds: { kind: 'port', node: 'n1', port: 'mode' }, promoted: true },
          { kind: 'output', id: 'out', binds: { kind: 'port', node: 'n1', port: 'out' } },
          ...(extra.valueSource ? [{ kind: 'output', id: 'amount', displayName: 'Amount', binds: { kind: 'valueSource', valueSource: 'v0', type: { kind: 'concrete', name: 'INT' } } }] : []),
        ],
      },
    },
  },
  view: {
    graphs: {
      g0: { nodes: { occ: { position: { x: 0, y: 0 } }, occ2: { position: { x: 300, y: 0 } } } },
      sub: { nodes: { n1: { position: { x: 10, y: 20 } }, n2: { position: { x: 10, y: 300 } } } },
    },
  },
} as unknown as WorkflowDocument)

const mountPanel = async (options: { valueSource?: boolean; inside?: boolean } = {}) => {
  const app = prepareWorkflowApp(new AppState())
  apps.push(app)
  const backend = app.backends.get()[0]!
  backend.registry.set({
    connection: backend.id,
    hash: 'boundary-panel-test',
    schemas: new Map([[blend.type, blend]]),
    diagnostics: [],
    resolve: (type) => type === blend.type ? blend : undefined,
  })
  expect(await app.openDocument(blendDocument(options), 'Boundary component')).toEqual([])
  const tab = app.activeTab()!
  // Drill in through the real occurrence so navigation survives the
  // document-change reconciler (graphStack.length === instancePath.length + 1).
  if (options.inside !== false) pushGraph(tab, 'sub', 'occ')
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <BoundaryPanel app={app} />, root)
  return { app, tab, root, unmount }
}

const rowOf = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLButtonElement>(`[data-testid="boundary-item"][data-boundary-id="${id}"]`)!
const select = (root: HTMLElement, id: string) => rowOf(root, id).click()
const settings = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-testid="boundary-settings"]')
const idle = (root: HTMLElement) => vi.waitFor(() => expect(root.querySelector('[aria-busy="true"]')).toBeNull())
const itemOf = (app: AppState, id: string) => {
  const boundary = app.activeTab()!.store.doc.graphs.sub!.boundary
  return [...boundaryItems(boundary, 'inputs'), ...boundaryItems(boundary, 'outputs')].find((item) => item.id === id)
}

beforeEach(() => setLocale('en'))
afterEach(() => {
  for (const app of apps.splice(0)) app.dispose()
  vi.restoreAllMocks()
  document.body.replaceChildren()
  localStorage.clear()
})

const delayDispatch = (app: AppState) => {
  const dispatch = app.dispatchTo.bind(app)
  const releases: Array<(accepted: boolean) => void> = []
  vi.spyOn(app, 'dispatchTo').mockImplementation((tab, invocation) => new Promise<ReturnType<AppState['dispatchTo']>>((resolve) => {
    releases.push((accepted) => resolve(accepted ? dispatch(tab, invocation) : {
      ok: false,
      diagnostics: [{ severity: 'error', origin: 'command', code: 'command.refused', message: 'Boundary edit refused for test' }],
    }))
  }) as unknown as ReturnType<AppState['dispatchTo']>)
  return releases
}

describe('BoundaryPanel rows and settings', () => {
  it('lists the rows in stored order with the inner node, and shows the selected row in one settings area', async () => {
    const { app, tab, root, unmount } = await mountPanel()
    expect(root.querySelector('[data-testid="boundary-title"]')?.textContent).toBe('Soften')
    expect(root.querySelector('[data-testid="boundary-used-in"]')?.textContent).toBe('used in 2 places')
    const rows = [...root.querySelectorAll<HTMLElement>('[data-testid="boundary-item"]')]
    expect(rows.map((row) => [row.dataset.boundaryId, row.dataset.side])).toEqual([
      ['image', 'inputs'], ['mask', 'inputs'], ['strength', 'inputs'], ['mode', 'inputs'], ['out', 'outputs'],
    ])
    expect(rowOf(root, 'strength').textContent).toBe('StrengthBlend')
    expect(rowOf(root, 'image').textContent).toBe('imageBlend')
    expect(settings(root)).toBeNull()
    expect(root.querySelector('[data-testid="boundary-pick"]')).not.toBeNull()

    select(root, 'strength')
    expect(rowOf(root, 'strength').getAttribute('aria-selected')).toBe('true')
    expect(app.boundaryFocus.get()).toEqual({ tabId: tab.id, graphId: 'sub', item: 'strength' })
    expect(settings(root)!.dataset.boundaryId).toBe('strength')
    expect(root.querySelector('[data-testid="boundary-show-on-canvas"]')?.textContent).toBe('strength on Blend')
    expect(root.querySelector('[data-testid="boundary-empty-rule"]')).toBeNull()

    select(root, 'mask')
    expect(rowOf(root, 'strength').getAttribute('aria-selected')).toBe('false')
    expect(root.querySelectorAll('[data-testid="boundary-settings"]')).toHaveLength(1)
    expect(root.querySelector('[data-testid="boundary-empty-rule"]')?.textContent).toBe('May be left empty. The nodes inside decide that.')
    expect(root.querySelector('[data-testid="boundary-limit-min"]')).toBeNull()
    select(root, 'image')
    expect(root.querySelector('[data-testid="boundary-empty-rule"]')?.textContent).toBe('Must be plugged in. The nodes inside decide that.')
    select(root, 'out')
    expect(settings(root)!.textContent).toContain('From')
    expect(root.querySelector('[data-testid="boundary-show-select"]')).toBeNull()
    unmount()
  })

  it('retains a refused name draft, prevents duplicate commits and clears only after accepted retry', async () => {
    const { app, tab, root, unmount } = await mountPanel()
    select(root, 'strength')
    const releases = delayDispatch(app)
    const input = () => root.querySelector<HTMLInputElement>('[data-testid="boundary-name-input"]')!
    input().value = '  Mix  '
    input().dispatchEvent(new Event('change', { bubbles: true }))
    input().dispatchEvent(new Event('blur'))
    expect(input().disabled).toBe(true)
    expect(input().value).toBe('  Mix  ')
    expect(itemOf(app, 'strength')!.displayName).toBe('Strength')
    releases[0]!(false)
    await vi.waitFor(() => expect(input().disabled).toBe(false))
    expect(input().value).toBe('  Mix  ')
    expect(root.querySelector('[data-testid="boundary-notice"]')?.textContent).toBe('Boundary edit refused for test')
    expect(releases).toHaveLength(1)
    input().dispatchEvent(new Event('blur'))
    releases[1]!(true)
    await vi.waitFor(() => expect(input().value).toBe('Mix'))
    expect(root.querySelector('[data-testid="boundary-notice"]')).toBeNull()
    expect(itemOf(app, 'strength')!.displayName).toBe('Mix')
    expect(tab.store.undo()).toBe(true)
    expect(itemOf(app, 'strength')!.displayName).toBe('Strength')
    unmount()
  })

  it.each([false, true])('does not clear a newer pending draft after navigation (old acceptance: %s)', async (accepted) => {
    const { app, tab, root, unmount } = await mountPanel()
    select(root, 'strength')
    const releases = delayDispatch(app)
    const input = () => root.querySelector<HTMLInputElement>('[data-testid="boundary-name-input"]')!
    input().value = 'Old draft'
    input().dispatchEvent(new Event('change', { bubbles: true }))
    truncateGraphStack(tab, 1)
    pushGraph(tab, 'sub', 'occ')
    expect(input().value).toBe('Strength')
    expect(input().disabled).toBe(false)
    input().value = 'New draft'
    input().dispatchEvent(new Event('change', { bubbles: true }))
    releases[0]!(accepted)
    await Promise.resolve()
    expect(input().value).toBe('New draft')
    expect(input().disabled).toBe(true)
    expect(root.querySelector('[data-testid="boundary-notice"]')).toBeNull()
    releases[1]!(true)
    await vi.waitFor(() => expect(input().disabled).toBe(false))
    expect(input().value).toBe('New draft')
    expect(itemOf(app, 'strength')!.displayName).toBe('New draft')
    unmount()
  })

  it('edits and clears a label, and Escape drops a draft without an edit', async () => {
    const { app, root, unmount } = await mountPanel()
    select(root, 'mode')
    const input = () => root.querySelector<HTMLInputElement>('[data-testid="boundary-name-input"]')!
    expect(root.querySelector(`label[for="${input().id}"]`)?.textContent).toBe('Label')
    expect(input().value).toBe('')
    expect(input().placeholder).toBe('mode')

    input().value = 'Blend mode'
    input().dispatchEvent(new Event('change', { bubbles: true }))
    await idle(root)
    expect(itemOf(app, 'mode')!.displayName).toBe('Blend mode')
    expect(rowOf(root, 'mode').textContent).toContain('Blend mode')

    input().focus()
    input().value = 'Discarded draft'
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(input().value).toBe('Blend mode')
    expect(itemOf(app, 'mode')!.displayName).toBe('Blend mode')

    input().value = '   '
    input().dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(itemOf(app, 'mode')!.displayName).toBeUndefined())
    unmount()
  })

  it('sets help text, limits, a default and a condition, each as one undo step', async () => {
    const { app, tab, root, unmount } = await mountPanel()
    select(root, 'strength')
    const change = async (testId: string, value: string) => {
      const input = root.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!
      input.value = value
      input.dispatchEvent(new InputEvent('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await idle(root)
    }
    await change('boundary-help-input', 'How much of the blur is mixed in')
    expect(itemOf(app, 'strength')!.tooltip).toBe('How much of the blur is mixed in')

    await change('boundary-limit-min', '0.1')
    await change('boundary-limit-max', '0.8')
    expect(itemOf(app, 'strength')!.limits).toEqual({ min: 0.1, max: 0.8 })
    expect(settings(root)!.textContent).toContain('inside allows 0 to 1')

    await change('boundary-default-input', '0.6')
    expect(tab.store.doc.graphs.sub!.nodes.n1!.values.strength).toBe(0.6)

    root.querySelector<HTMLButtonElement>('[data-testid="boundary-show-select"]')!.click()
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].filter((option) => option.closest('[data-testid="boundary-panel"]') === null)
    expect(options.map((option) => option.textContent)).toEqual([
      'Always', 'When image is plugged in', 'When mask is plugged in', 'When mode is plugged in', 'When mode is as is', 'When mode is screen',
    ])
    options[2]!.click()
    await idle(root)
    expect(itemOf(app, 'strength')!.visible).toEqual({ formula: 'linked(mask)' })
    expect(rowOf(root, 'strength').querySelector('[data-mark="condition"]')).not.toBeNull()

    expect(tab.store.undo()).toBe(true)
    expect(itemOf(app, 'strength')!.visible).toBeUndefined()
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc.graphs.sub!.nodes.n1!.values.strength).toBe(0.45)
    expect(tab.store.undo()).toBe(true)
    expect(itemOf(app, 'strength')!.limits).toEqual({ min: 0.1 })
    unmount()
  })

  it('refuses a limit wider than the inner field with a sentence naming its range', async () => {
    const { app, root, unmount } = await mountPanel()
    select(root, 'strength')
    const max = root.querySelector<HTMLInputElement>('[data-testid="boundary-limit-max"]')!
    max.value = '2'
    max.dispatchEvent(new InputEvent('input', { bubbles: true }))
    max.dispatchEvent(new Event('change', { bubbles: true }))
    await idle(root)
    expect(itemOf(app, 'strength')!.limits).toBeUndefined()
    const notice = root.querySelector<HTMLElement>('[data-testid="boundary-notice"]')!
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain('never widen it')
    expect(notice.textContent).toContain('0 to 1')
    unmount()
  })

  it('shows a row problem in words with a warning mark', async () => {
    const { app, tab, root, unmount } = await mountPanel()
    expect(tab.store.dispatch({ command: 'boundary.setVisible', params: { graphId: 'sub', itemId: 'strength', formula: 'linked(mask)' } }).ok).toBe(true)
    expect(tab.store.dispatch({
      command: 'boundary.unbind', params: { graphId: 'sub', side: 'inputs', itemId: 'mask', node: 'n1', port: 'mask' },
    }).ok).toBe(true)
    expect(rowOf(root, 'strength').querySelector('[data-mark="problem"]')).not.toBeNull()
    select(root, 'strength')
    const problem = root.querySelector<HTMLElement>('[data-testid="boundary-diag"]')!
    expect(problem.getAttribute('role')).toBe('alert')
    expect(problem.dataset.code).toBe('boundary.visibleBroken')
    expect(problem.textContent).toContain('reads an input that is no longer on the subgraph node')
    expect(root.querySelector<HTMLButtonElement>('[data-testid="boundary-show-select"]')!.textContent).toBe('When linked(mask)')
    expect(app.boundaryFocus.get()?.item).toBe('strength')
    unmount()
  })

  it('removes a row in one batch, extra bindings first and the primary last, after a confirmation', async () => {
    const { app, tab, root, unmount } = await mountPanel()
    const dispatch = vi.spyOn(app, 'dispatchTo')
    select(root, 'image')
    expect(root.querySelector('[data-testid="boundary-show-on-canvas"]')?.textContent).toBe('image on Blend, and 1 more')
    root.querySelector<HTMLButtonElement>('[data-testid="boundary-remove"]')!.click()
    expect(dispatch).not.toHaveBeenCalled()
    expect(root.querySelector('[data-testid="boundary-remove-confirm"]')?.textContent).toContain('This changes it in 2 places.')
    root.querySelector<HTMLButtonElement>('[data-testid="boundary-remove-yes"]')!.click()
    await idle(root)
    expect(dispatch).toHaveBeenLastCalledWith(tab, { command: 'batch', params: { invocations: [
      { command: 'boundary.unbind', params: { graphId: 'sub', side: 'inputs', itemId: 'image', node: 'n2', port: 'image' } },
      { command: 'boundary.unbind', params: { graphId: 'sub', side: 'inputs', itemId: 'image', node: 'n1', port: 'image' } },
    ] } })
    expect(itemOf(app, 'image')).toBeUndefined()
    expect(settings(root)).toBeNull()
    expect(tab.store.undo()).toBe(true)
    expect(itemOf(app, 'image')).toMatchObject({ binds: { node: 'n1' }, alsoBinds: [{ node: 'n2' }] })
    unmount()
  })

  it('routes the destination through canonical canvas focus without editing', async () => {
    const { app, tab, root, unmount } = await mountPanel()
    select(root, 'strength')
    const revision = tab.store.revision
    root.querySelector<HTMLButtonElement>('[data-testid="boundary-show-on-canvas"]')!.click()
    expect(tab.store.revision).toBe(revision)
    expect(app.diagnosticFocus.get()).toMatchObject({
      tab,
      anchor: { port: { node: 'n1', port: 'strength' } },
      portInstancePath: ['occ'],
    })
    unmount()
  })

  it('names a literal binding and offers source navigation without editing the definition', async () => {
    const { tab, root, unmount } = await mountPanel({ valueSource: true })
    expect(rowOf(root, 'amount').textContent).toContain('Literal amount')
    select(root, 'amount')
    const revision = tab.store.revision
    const button = root.querySelector<HTMLButtonElement>('[data-testid="boundary-show-on-canvas"]')!
    expect(button.textContent).toBe('Literal amount')
    expect(button.getAttribute('aria-label')).toBe('Show Literal amount on the canvas')
    expect(root.querySelector('[data-testid="boundary-remove"]')).toBeNull()
    button.click()
    expect(tab.store.revision).toBe(revision)
    expect(tab.instancePath.get()).toEqual(['occ'])
    unmount()
  })

  it('offers a definition prompt and opens through the real occurrence without editing the document', async () => {
    const { app, tab, root, unmount } = await mountPanel({ inside: false })
    const revision = tab.store.revision
    expect(root.querySelector('[data-testid="boundary-prompt"]')?.textContent).toContain('Open a subgraph definition')
    const open = root.querySelector<HTMLButtonElement>('[data-testid="boundary-prompt"] button')!
    expect(open.textContent).toBe('Open Soften')
    open.click()
    expect(tab.graphStack.get()).toEqual(['g0', 'sub'])
    expect(tab.instancePath.get()).toEqual(['occ'])
    expect(tab.store.revision).toBe(revision)
    expect(root.querySelector('[data-testid="boundary-prompt"]')).toBeNull()
    expect(root.querySelector('[data-testid="boundary-item"]')).not.toBeNull()

    app.createWorkflow()
    expect(root.querySelector('[data-testid="boundary-prompt"]')?.textContent).toContain('Open a subgraph on the canvas')
    expect(root.querySelector('[data-testid="boundary-prompt"] button')).toBeNull()
    unmount()
  })

  it('shows the rows of the one selected subgraph node outside, and Goes to opens the subgraph', async () => {
    const { app, tab, root, unmount } = await mountPanel({ inside: false })
    app.canvasSelection.set({ nodes: ['occ2'], links: [], groups: [] })
    expect(root.querySelector('[data-testid="boundary-panel"]')?.getAttribute('data-outside')).toBe('true')
    select(root, 'strength')
    const name = root.querySelector<HTMLInputElement>('[data-testid="boundary-name-input"]')!
    name.value = 'Mix'
    name.dispatchEvent(new Event('change', { bubbles: true }))
    await idle(root)
    expect(itemOf(app, 'strength')!.displayName).toBe('Mix')
    expect(tab.graphStack.get()).toEqual(['g0'])
    root.querySelector<HTMLButtonElement>('[data-testid="boundary-show-on-canvas"]')!.click()
    expect(tab.graphStack.get()).toEqual(['g0', 'sub'])
    expect(tab.instancePath.get()).toEqual(['occ2'])

    truncateGraphStack(tab, 1)
    app.canvasSelection.set({ nodes: ['occ', 'occ2'], links: [], groups: [] })
    expect(root.querySelector('[data-testid="boundary-prompt"]')).not.toBeNull()
    unmount()
  })

  it('moves the selection with the arrow keys', async () => {
    const { app, root, unmount } = await mountPanel()
    select(root, 'image')
    rowOf(root, 'image').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(app.boundaryFocus.get()?.item).toBe('mask')
    expect(document.activeElement).toBe(rowOf(root, 'mask'))
    unmount()
  })

  it('reads only in a frozen execution view', async () => {
    const { tab, app, root, unmount } = await mountPanel()
    select(root, 'strength')
    Object.defineProperty(tab, 'execution', { value: { backendId: 'proof', executionId: 'proof' }, configurable: true })
    app.tabs.set([...app.tabs.get()])
    expect(root.querySelector('[data-testid="boundary-frozen"]')?.getAttribute('role')).toBe('status')
    for (const testId of ['boundary-name-input', 'boundary-help-input', 'boundary-remove']) {
      expect([testId, root.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)?.disabled]).toEqual([testId, true])
    }
    expect(root.querySelector<HTMLButtonElement>('[data-testid="boundary-show-on-canvas"]')!.disabled).toBe(false)
    unmount()
  })

  it('shows one empty state when nothing is on the subgraph node', async () => {
    const { tab, root, unmount } = await mountPanel()
    for (const [side, itemId, node] of [['inputs', 'image', 'n2'], ['inputs', 'image', 'n1'], ['inputs', 'mask', 'n1'], ['inputs', 'strength', 'n1'], ['inputs', 'mode', 'n1'], ['outputs', 'out', 'n1']] as const) {
      expect(tab.store.dispatch({ command: 'boundary.unbind', params: { graphId: 'sub', side, itemId, node, port: itemId } }).ok).toBe(true)
    }
    const empty = root.querySelectorAll<HTMLElement>('[data-testid="boundary-empty"]')
    expect(empty).toHaveLength(1)
    expect(empty[0]!.getAttribute('role')).toBe('status')
    unmount()
  })
})

const regionSchema: NodeSchema = {
  type: 'RegionBody',
  displayName: 'Region Body',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  body: [
    { kind: 'input', id: 'item_in', type: { kind: 'concrete', name: 'INT' }, optional: false },
    { kind: 'input', id: 'state_in', type: { kind: 'concrete', name: 'INT' }, optional: false },
    { kind: 'input', id: 'capture_in', type: { kind: 'concrete', name: 'INT' }, optional: false },
    { kind: 'output', id: 'gather_out', type: { kind: 'concrete', name: 'INT' } },
    { kind: 'output', id: 'state_out', type: { kind: 'concrete', name: 'INT' } },
    { kind: 'output', id: 'flat_out', type: { kind: 'concrete', name: 'INT' }, isList: true },
    { kind: 'output', id: 'continue_out', type: { kind: 'concrete', name: 'BOOLEAN' } },
  ],
}

const mountRegionPanel = async (occurrence = 'fold') => {
  const app = prepareWorkflowApp(new AppState())
  apps.push(app)
  const backend = app.backends.get()[0]!
  backend.registry.set({
    connection: backend.id,
    hash: 'region-panel-test',
    schemas: new Map([[regionSchema.type, regionSchema]]),
    diagnostics: [],
    resolve: (type) => type === regionSchema.type ? regionSchema : undefined,
  })
  expect((await app.openDocument({
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
          body: [
            { kind: 'input', id: 'item', displayName: 'Item', binds: { kind: 'port', node: 'n1', port: 'item_in' } },
            { kind: 'input', id: 'state', displayName: 'State', binds: { kind: 'port', node: 'n1', port: 'state_in' } },
            { kind: 'input', id: 'capture', displayName: 'Capture', binds: { kind: 'port', node: 'n1', port: 'capture_in' } },
            { kind: 'output', id: 'gathered', displayName: 'Gathered', binds: { kind: 'port', node: 'n1', port: 'gather_out' } },
            { kind: 'output', id: 'stateResult', displayName: 'State Result', binds: { kind: 'port', node: 'n1', port: 'state_out' } },
            { kind: 'output', id: 'flattened', displayName: 'Flattened', binds: { kind: 'port', node: 'n1', port: 'flat_out' } },
            { kind: 'output', id: 'continue', displayName: 'Continue', binds: { kind: 'port', node: 'n1', port: 'continue_out' } },
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
  }, 'Region panel'))).toEqual([])
  const tab = app.activeTab()!
  pushGraph(tab, 'body', occurrence)
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <BoundaryPanel app={app} />, root)
  return { app, tab, root, unmount }
}

describe('BoundaryPanel region occurrence context', () => {
  it('awaits occurrence edits and keeps stale refusal out of another occurrence', async () => {
    const { app, tab, root, unmount } = (await mountRegionPanel())
    const releases = delayDispatch(app)
    const cross = () => root.querySelector<HTMLButtonElement>('[data-region-binding="cross"]')!
    cross().click()
    expect(cross().disabled).toBe(true)
    expect(tab.store.doc.graphs.root!.nodes.fold!.region?.binding).toBeUndefined()
    releases[0]!(false)
    await vi.waitFor(() => expect(root.querySelector('[data-testid="region-notice"]')?.textContent).toBe('Boundary edit refused for test'))
    expect(cross().disabled).toBe(false)
    cross().click()
    releases[1]!(true)
    await vi.waitFor(() => expect(cross().disabled).toBe(false))
    expect(tab.store.doc.graphs.root!.nodes.fold!.region?.binding).toBe('cross')
    expect(tab.store.doc.graphs.root!.nodes.while!.region?.binding).toBeUndefined()
    expect(root.querySelector('[data-testid="region-notice"]')).toBeNull()
    cross().click()
    truncateGraphStack(tab, 1)
    pushGraph(tab, 'body', 'while')
    const max = root.querySelector<HTMLInputElement>('[data-testid="region-max-iterations"]')!
    max.value = '17'
    max.dispatchEvent(new Event('change', { bubbles: true }))
    releases[2]!(false)
    await Promise.resolve()
    expect(cross().disabled).toBe(true)
    expect(root.querySelector('[data-testid="region-notice"]')).toBeNull()
    releases[3]!(true)
    await vi.waitFor(() => expect(cross().disabled).toBe(false))
    expect(tab.store.doc.graphs.root!.nodes.while!.region?.maxIterations).toBe(17)
    expect(root.querySelector('[data-testid="region-notice"]')).toBeNull()
    unmount()
  })

  it('dispatches exact region commands from each editing control', async () => {
    const { app, tab, root, unmount } = (await mountRegionPanel())
    const dispatch = vi.spyOn(app, 'dispatchTo')
    const click = async (selector: string, row?: string) => {
      if (row !== undefined) select(root, row)
      root.querySelector<HTMLButtonElement>(selector)!.click()
      await vi.waitFor(() => expect(root.querySelector('[aria-busy="true"]')).toBeNull())
    }
    await click('[data-region-input="capture"][data-role-choice="element"]', 'capture')
    expect(dispatch).toHaveBeenLastCalledWith(tab, { command: 'region.setPortRole', params: {
      graphId: 'root', nodeId: 'fold', side: 'input', portId: 'capture', role: 'element',
    } })
    await click('[data-region-output="gathered"][data-role-choice="compact"]', 'gathered')
    expect(dispatch).toHaveBeenLastCalledWith(tab, { command: 'region.setOutputRole', params: {
      graphId: 'root', nodeId: 'fold', outputId: 'gathered', role: 'compact',
    } })
    await click('[data-region-output="stateResult"][data-state-port="state"]', 'stateResult')
    expect(dispatch).toHaveBeenLastCalledWith(tab, { command: 'region.setOutputRole', params: {
      graphId: 'root', nodeId: 'fold', outputId: 'stateResult', role: 'state', statePort: 'state',
    } })
    await click('[data-region-output="continue"][data-role-choice="continue"]', 'continue')
    expect(dispatch).toHaveBeenLastCalledWith(tab, { command: 'region.setContinueOutput', params: {
      graphId: 'root', nodeId: 'fold', outputId: 'continue',
    } })
    await click('[data-region-binding="broadcast"]')
    expect(dispatch).toHaveBeenLastCalledWith(tab, { command: 'region.setBinding', params: {
      graphId: 'root', nodeId: 'fold', binding: 'broadcast',
    } })
    const max = root.querySelector<HTMLInputElement>('[data-testid="region-max-iterations"]')!
    max.value = '12'
    max.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(root.querySelector('[aria-busy="true"]')).toBeNull())
    expect(dispatch).toHaveBeenLastCalledWith(tab, { command: 'region.setMaxIterations', params: {
      graphId: 'root', nodeId: 'fold', maxIterations: 12,
    } })
    max.value = ''
    max.dispatchEvent(new InputEvent('input', { bubbles: true }))
    max.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(root.querySelector('[aria-busy="true"]')).toBeNull())
    expect(dispatch).toHaveBeenLastCalledWith(tab, { command: 'region.setMaxIterations', params: {
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
    const { root, unmount } = (await mountRegionPanel())
    select(root, 'gathered')
    const compact = root.querySelector<HTMLElement>('[data-region-output="gathered"][data-role-choice="compact"]')!
    expect(compact.getAttribute('data-tooltip-label')).toContain('Compact output')

    setLocale('de-DE')
    await vi.waitFor(() => expect(compact.getAttribute('data-tooltip-label'))
      .toBe('Kompakte Ausgabe - Sammelt nur vorhandene Iterationswerte.'))
    unmount()
  })

  it('disables maximum iterations in a frozen execution view', async () => {
    const mounted = (await mountRegionPanel())
    select(mounted.root, 'item')
    Object.defineProperty(mounted.tab, 'execution', { value: { backendId: 'proof', executionId: 'proof' }, configurable: true })
    mounted.app.tabs.set([...mounted.app.tabs.get()])
    expect(mounted.root.querySelector('[data-testid="boundary-frozen"]')?.getAttribute('role')).toBe('status')
    expect(mounted.root.querySelector<HTMLInputElement>('[data-testid="region-max-iterations"]')!.disabled).toBe(true)
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-testid="boundary-show-on-canvas"]')!.disabled).toBe(false)
    const roles = [...mounted.root.querySelectorAll<HTMLButtonElement>('.region-role-controls button')]
    expect(roles).toHaveLength(3)
    expect(roles.every((button) => button.disabled)).toBe(true)
    mounted.unmount()
  })

  it('distinguishes two occurrences and surfaces a while broadcast refusal legibly', async () => {
    const { tab, root, unmount } = (await mountRegionPanel('while'))
    root.querySelector<HTMLButtonElement>('[data-region-binding="broadcast"]')!.click()
    await vi.waitFor(() => expect(root.querySelector('[data-testid="region-notice"]')).not.toBeNull())
    expect(tab.store.doc.graphs.root!.nodes.while!.region?.binding).toBeUndefined()
    const notice = root.querySelector<HTMLElement>('[data-testid="region-notice"]')!
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain('while cannot use broadcast binding')
    expect(tab.store.doc.graphs.root!.nodes.fold!.region?.binding).toBeUndefined()
    unmount()
  })

  it('fails closed for desynchronized or deleted occurrences while ordinary boundary editing remains', async () => {
    const desync = (await mountRegionPanel())
    desync.tab.graphStack.update((stack) => [...stack, 'body'])
    expect(desync.root.querySelector('[data-testid="region-panel"]')).toBeNull()
    expect(desync.root.querySelector('[data-testid="boundary-panel"]')).not.toBeNull()
    expect(desync.root.querySelectorAll('[data-testid="boundary-item"]')).toHaveLength(7)
    desync.unmount()

    const deleted = (await mountRegionPanel())
    expect(deleted.tab.store.dispatch({ command: 'node.remove', params: { graphId: 'root', nodeIds: ['fold'] } }).ok).toBe(true)
    expect(deleted.root.querySelector('[data-testid="region-panel"]')).toBeNull()
    expect(deleted.tab.graphStack.get()).toEqual(['root'])
    deleted.unmount()
  })
})
