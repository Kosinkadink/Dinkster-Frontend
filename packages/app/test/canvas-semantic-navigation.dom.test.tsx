import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Scene } from '@dinkster/canvas'
import {
  CANVAS_SEMANTIC_WINDOW_SIZE,
  CanvasSemanticNavigator,
  buildCanvasSemanticItems,
  type CanvasSemanticItem,
} from '../src/CanvasSemanticNavigator.js'

afterEach(() => document.body.replaceChildren())

const concrete = (name: string) => ({ kind: 'concrete', name } as const)

const scene = ({
  graphId: 'g0',
  nodes: [
    {
      id: 'source', x: 20, y: 30, node: { id: 'source', type: 'Source', values: {} },
      layout: {
        title: 'Source', width: 180, height: 100,
        pins: [{ portId: 'image', direction: 'out', y: 50, type: concrete('IMAGE'), address: { port: 'image' } }],
        rows: [{ kind: 'ports', y: 30, height: 24, output: { portId: 'image', label: 'Image', type: concrete('IMAGE'), index: 0 } }],
      },
      isSubgraph: false,
    },
    {
      id: 'sink', x: 260, y: 30, node: { id: 'sink', type: 'Sink', values: {}, mode: 'muted' },
      layout: {
        title: 'Sink', width: 180, height: 100,
        pins: [{ portId: 'image', direction: 'in', y: 50, type: concrete('IMAGE'), optional: true, address: { port: 'image' } }],
        rows: [{ kind: 'ports', y: 30, height: 24, input: { portId: 'image', label: 'Image', type: concrete('IMAGE'), optional: true } }],
      },
      isSubgraph: false,
    },
  ],
  links: [{
    id: 'link-1',
    from: { kind: 'port', node: 'source', port: 'image' },
    to: { kind: 'port', node: 'sink', port: 'image' },
    x1: 200, y1: 80, x2: 260, y2: 80, typeName: 'IMAGE',
  }],
  reroutes: [], valueSources: [], selectors: [], netStubs: [], boundaryNodes: [], diagnostics: [],
  groups: [{ id: 'group-1', title: 'Image pipeline', x: 0, y: 0, width: 480, height: 180 }],
}) as unknown as Scene

describe('buildCanvasSemanticItems', () => {
  it('derives names, typed ports, connectivity, groups, and state without viewport input', () => {
    const items = buildCanvasSemanticItems({
      scene,
      states: { source: { state: 'running', value: 0.5 } },
      badges: { sink: [{ id: 'core.problem.blocking-warning', glyph: '!', color: '#000000' }] },
      portProblems: { sink: { image: 'blocking-warning' } },
      outputTexts: { source: { text: 'Estimated locally\nfloat: 3.5\nint: 3', estimate: true } },
    })

    expect(items.map((item) => item.label)).toEqual([
      'Node: Source, 0 inputs, 1 output, in Image pipeline, running 50 percent, live result estimated locally: float: 3.5, int: 3',
      'Output: Image of Source, IMAGE, 1 connection',
      'Node: Sink, 1 input, 0 outputs, in Image pipeline, muted, blocking warning',
      'Input: Image of Sink, IMAGE, optional, blocking-warning, 1 connection',
      'Link: Source.Image to Sink.Image, IMAGE',
      'Group: Image pipeline, 2 nodes',
    ])
  })

  it('announces preview errors instead of presenting them as live results', () => {
    const items = buildCanvasSemanticItems({
      scene,
      states: {},
      badges: {},
      portProblems: {},
      outputTexts: { source: { text: 'Preview error\nInvalid expression: unexpected token', error: true } },
    })

    expect(items[0]?.label).toContain('preview error: Invalid expression: unexpected token')
    expect(items[0]?.label).not.toContain('live result')
  })

  it('announces minimized state and hidden connected endpoint counts without exposing hidden pins', () => {
    const minimized = ({
      ...scene,
      nodes: scene.nodes.map((node) => ({
        ...node,
        layout: {
          ...node.layout,
          minimized: true,
          rows: [],
          pins: node.layout.pins.map((pin) => ({ ...pin, label: 'Retained label', minimized: true })),
        },
      })),
    }) as unknown as Scene
    const items = buildCanvasSemanticItems({
      scene: minimized,
      states: {},
      badges: {},
      portProblems: {},
      outputTexts: {},
    })

    expect(items.find((item) => item.key === 'node:source')?.label)
      .toContain('minimized, 0 hidden connected inputs, 1 hidden connected output')
    expect(items.find((item) => item.key === 'node:sink')?.label)
      .toContain('minimized, 1 hidden connected input, 0 hidden connected outputs')
    expect(items.some((item) => item.category === 'port')).toBe(false)
    expect(items.find((item) => item.key === 'link:link-1')?.label)
      .toContain('Source.Retained label to Sink.Retained label')
  })

  it('covers every non-node scene citizen in deterministic scene order', () => {
    const citizens = ({
      graphId: 'g0', nodes: [], links: [], diagnostics: [],
      boundaryNodes: [{
        side: 'inputs', x: 0, y: 0,
        layout: {
          title: 'Inputs', width: 160, height: 80, rows: [],
          pins: [{ portId: 'prompt', direction: 'out', y: 40, type: concrete('STRING'), address: { port: 'prompt' } }],
        },
      }],
      reroutes: [{ id: 'r1', x: 10, y: 10, typeName: 'IMAGE' }],
      valueSources: [{ id: 'v1', title: 'Seed', x: 20, y: 20, width: 100, height: 30, specState: 'declared', conflict: true }],
      selectors: [{ id: 's1', title: 'Sampler', x: 30, y: 30, width: 100, height: 60, random: false, candidates: ['a', 'b'] }],
      netStubs: [{ id: 'n1', role: 'get', name: 'latent', x: 40, y: 40, width: 100, height: 30, typeName: 'LATENT' }],
      groups: [{ id: 'g1', title: 'Empty group', x: 0, y: 0, width: 200, height: 100 }],
    }) as unknown as Scene

    const items = buildCanvasSemanticItems({ scene: citizens, states: {}, badges: {}, portProblems: {}, outputTexts: {} })

    expect(items.map((item) => item.label)).toEqual([
      'Inputs boundary, 1 port',
      'Output: prompt of inputs boundary, STRING, not connected',
      'Reroute: r1, IMAGE',
      'Value source: Seed, declared, conflict',
      'Selector: Sampler, fixed, 2 candidates',
      'Named net get: latent, LATENT',
      'Group: Empty group, 0 nodes',
    ])
    expect(items.map((item) => item.target.kind)).toEqual([
      'boundary', 'port', 'reroute', 'valueSource', 'selector', 'net', 'group',
    ])
  })

  it('counts widget-tap and boundary endpoint connectivity by retained pin identity', () => {
    const connected = ({
      graphId: 'g0',
      nodes: [{
        id: 'source', x: 0, y: 0, node: { id: 'source', type: 'Source', values: {} }, isSubgraph: false,
        layout: {
          title: 'Tap source', width: 160, height: 80,
          rows: [{ kind: 'widget', y: 30, height: 24, inputId: 'amount', valueKey: 'amount', label: 'Amount', type: concrete('FLOAT') }],
          pins: [{ portId: 'amount', direction: 'out', y: 42, type: concrete('FLOAT'), address: { port: 'amount' }, widgetTap: true }],
        },
      }, {
        id: 'sink', x: 220, y: 0, node: { id: 'sink', type: 'Sink', values: {} }, isSubgraph: false,
        layout: {
          title: 'Sink', width: 160, height: 80,
          rows: [{ kind: 'ports', y: 30, height: 24, input: { portId: 'amount', label: 'Amount', type: concrete('FLOAT') } }],
          pins: [{ portId: 'amount', direction: 'in', y: 42, type: concrete('FLOAT'), address: { port: 'amount' } }],
        },
      }],
      boundaryNodes: [{
        side: 'inputs', x: -200, y: 0,
        layout: {
          title: 'Inputs', width: 160, height: 80,
          rows: [{ kind: 'ports', y: 30, height: 24, output: { portId: 'feed', label: 'Feed', type: concrete('FLOAT'), index: 0 } }],
          pins: [{ portId: 'feed', direction: 'out', y: 42, type: concrete('FLOAT'), address: { port: 'feed' } }],
        },
      }, {
        side: 'outputs', x: 440, y: 0,
        layout: {
          title: 'Outputs', width: 160, height: 80,
          rows: [{ kind: 'ports', y: 30, height: 24, input: { portId: 'result', label: 'Result', type: concrete('FLOAT') } }],
          pins: [{ portId: 'result', direction: 'in', y: 42, type: concrete('FLOAT'), address: { port: 'result' } }],
        },
      }],
      links: [{
        id: 'tap', from: { kind: 'widgetTap', node: 'source', input: 'amount' },
        to: { kind: 'port', node: 'sink', port: 'amount' }, x1: 160, y1: 42, x2: 220, y2: 42,
      }, {
        id: 'boundary-input', from: { kind: 'boundary', side: 'inputs', item: 'feed' },
        to: { kind: 'port', node: 'sink', port: 'amount' }, x1: -40, y1: 42, x2: 220, y2: 42,
      }, {
        id: 'boundary-output', from: { kind: 'widgetTap', node: 'source', input: 'amount' },
        to: { kind: 'boundary', side: 'outputs', item: 'result' }, x1: 160, y1: 42, x2: 440, y2: 42,
      }],
      reroutes: [], valueSources: [], selectors: [], netStubs: [], groups: [], diagnostics: [],
    }) as unknown as Scene

    const items = buildCanvasSemanticItems({ scene: connected, states: {}, badges: {}, portProblems: {}, outputTexts: {} })

    expect(items.find((item) => item.key === 'port:source:out:amount:tap')?.label)
      .toBe('Output: Amount of Tap source, FLOAT, 2 connections')
    expect(items.find((item) => item.key === 'port:source:out:amount:tap')?.target)
      .toEqual({ kind: 'port', nodeId: 'source', id: 'amount', direction: 'out', widgetTap: true })
    expect(items.find((item) => item.key === 'port:sink:in:amount')?.label)
      .toBe('Input: Amount of Sink, FLOAT, 2 connections')
    expect(items.find((item) => item.key === 'boundary-port:inputs:feed')?.label)
      .toBe('Output: Feed of inputs boundary, FLOAT, 1 connection')
    expect(items.find((item) => item.key === 'boundary-port:outputs:result')?.label)
      .toBe('Input: Result of outputs boundary, FLOAT, 1 connection')
    expect(items.find((item) => item.key === 'link:tap')?.label)
      .toContain('Tap source.Amount to Sink.Amount')
    expect(items.find((item) => item.key === 'link:boundary-input')?.label)
      .toContain('inputs boundary.Feed to Sink.Amount')
  })

  it('a hidden collapsed-net delivery counts as a pin connection but is not a navigable link', () => {
    const collapsed = ({
      ...scene,
      links: [{
        id: 'net1:0', netId: 'net1', netName: 'latents', hidden: true,
        from: { kind: 'port', node: 'source', port: 'image' },
        to: { kind: 'port', node: 'sink', port: 'image' },
        x1: 200, y1: 80, x2: 260, y2: 80, typeName: 'IMAGE',
      }],
    }) as unknown as Scene

    const items = buildCanvasSemanticItems({ scene: collapsed, states: {}, badges: {}, portProblems: {}, outputTexts: {} })

    expect(items.find((item) => item.key === 'link:net1:0')).toBeUndefined()
    expect(items.find((item) => item.key === 'port:sink:in:image')?.label)
      .toBe('Input: Image of Sink, IMAGE, optional, 1 connection')
  })
})

describe('CanvasSemanticNavigator', () => {
  it('reports the active semantic port only while the navigator has focus', () => {
    const items: CanvasSemanticItem[] = [
      { key: 'node:n1', category: 'node', label: 'Node', target: { kind: 'node', id: 'n1' } },
      { key: 'port:n1:in:value', category: 'port', label: 'Input value', target: { kind: 'port', nodeId: 'n1', id: 'value', direction: 'in' } },
    ]
    const activeChange = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <CanvasSemanticNavigator
        owner="tab:g0"
        items={items}
        selectionVersion={0}
        isSelected={() => false}
        onActivate={() => {}}
        onExit={() => {}}
        onFocusChange={() => {}}
        onActiveChange={activeChange}
      />
    ), root)
    const navigator = root.querySelector<HTMLElement>('[role="listbox"]')!

    expect(activeChange).toHaveBeenLastCalledWith(undefined)
    navigator.focus()
    expect(activeChange).toHaveBeenLastCalledWith(items[0])
    navigator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(activeChange).toHaveBeenLastCalledWith(items[1])
    navigator.blur()
    expect(activeChange).toHaveBeenLastCalledWith(undefined)
    dispose()
  })

  it('keeps a constant DOM window and moves the reading cursor without activation', () => {
    const items: CanvasSemanticItem[] = Array.from({ length: 30 }, (_, index) => ({
      key: `node:${index}`,
      category: 'node',
      label: `Node ${index + 1}`,
      target: { kind: 'node', id: String(index) },
    }))
    const [selectionVersion, setSelectionVersion] = createSignal(0)
    const selected = new Set<string>()
    const activate = vi.fn()
    const exit = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <CanvasSemanticNavigator
        owner="tab:g0"
        items={items}
        selectionVersion={selectionVersion()}
        isSelected={(target) => target.kind === 'node' && selected.has(target.id)}
        onActivate={activate}
        onExit={exit}
        onFocusChange={() => {}}
      />
    ), root)
    const navigator = root.querySelector<HTMLElement>('[role="listbox"]')!
    const expectActiveOwned = (): void => {
      const id = navigator.getAttribute('aria-activedescendant')
      expect(id).not.toBeNull()
      const active = document.getElementById(id!)
      expect(active).not.toBeNull()
      expect(active?.getAttribute('role')).toBe('option')
      expect(navigator.contains(active)).toBe(true)
    }

    expect(root.querySelectorAll('[role="option"]')).toHaveLength(CANVAS_SEMANTIC_WINDOW_SIZE)
    expect(root.querySelector('[role="option"]')?.getAttribute('aria-posinset')).toBe('1')
    expect(root.querySelector('[role="option"]')?.getAttribute('aria-setsize')).toBe('30')
    expectActiveOwned()

    navigator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(activate).not.toHaveBeenCalled()
    expect(root.querySelector('[data-active="true"]')?.textContent).toBe('Node 2')

    for (let index = 0; index < 13; index += 1) {
      navigator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    }
    expect(root.querySelector('[data-active="true"]')?.textContent).toBe('Node 15')
    expectActiveOwned()

    navigator.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(root.querySelectorAll('[role="option"]')).toHaveLength(CANVAS_SEMANTIC_WINDOW_SIZE)
    expect(root.querySelector('[data-active="true"]')?.textContent).toBe('Node 30')
    expect(root.querySelector('[data-active="true"]')?.getAttribute('aria-posinset')).toBe('30')
    expectActiveOwned()

    navigator.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(activate).toHaveBeenCalledWith(items[29])
    selected.add('29')
    setSelectionVersion((value) => value + 1)
    expect(root.querySelector('[data-active="true"]')?.getAttribute('aria-selected')).toBe('true')

    navigator.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(exit).toHaveBeenCalledOnce()
    dispose()
  })

  it('returns focus to the canvas from an empty scene', () => {
    const exit = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <CanvasSemanticNavigator
        owner="tab:g0"
        items={[]}
        selectionVersion={0}
        isSelected={() => false}
        onActivate={() => {}}
        onExit={exit}
        onFocusChange={() => {}}
      />
    ), root)

    root.querySelector<HTMLElement>('[role="listbox"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(exit).toHaveBeenCalledOnce()
    dispose()
  })

  it('clears deferred focus ownership when the navigator unmounts', async () => {
    const focusChange = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <CanvasSemanticNavigator
        owner="tab:g0"
        items={[]}
        selectionVersion={0}
        isSelected={() => false}
        onActivate={() => {}}
        onExit={() => {}}
        onFocusChange={focusChange}
      />
    ), root)

    root.querySelector<HTMLElement>('[role="listbox"]')!.focus()
    expect(focusChange).toHaveBeenLastCalledWith(true)
    focusChange.mockClear()
    dispose()
    expect(focusChange).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(focusChange).toHaveBeenCalledExactlyOnceWith(false)
  })
})
