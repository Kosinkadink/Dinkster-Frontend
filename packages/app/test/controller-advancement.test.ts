import { beforeEach, describe, expect, it } from 'vitest'
import {
  asConnectionId,
  asPromptId,
  compile,
  type CompileArtifact,
  type ExecutionRef,
  type NodeSchema,
} from '@dinkster/core'
import { AppState, controllerAdvancement, type Tab } from '../src/app-state.js'

;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const schema: NodeSchema = {
  type: 'SeedTest', displayName: 'Seed Test', category: 'test', source: 'v3', isOutputNode: true,
  items: [
    { kind: 'output', id: 'out', type: { kind: 'concrete', name: 'INT' } },
    { kind: 'input', id: 'up', type: { kind: 'concrete', name: 'INT' }, optional: false,
      widget: { widgetType: 'INT', options: { min: 10, max: 20, step: 3 }, default: 10, controller: 'after_generate' } },
    { kind: 'input', id: 'down', type: { kind: 'concrete', name: 'INT' }, optional: false,
      widget: { widgetType: 'INT', options: { step: 2 }, default: 10, controller: 'after_generate' } },
    { kind: 'input', id: 'random', type: { kind: 'concrete', name: 'INT' }, optional: false,
      widget: { widgetType: 'INT', options: { min: 10, max: 20 }, default: 10, controller: 'after_generate' } },
    { kind: 'input', id: 'fixed', type: { kind: 'concrete', name: 'INT' }, optional: false,
      widget: { widgetType: 'INT', options: {}, default: 10, controller: 'after_generate' } },
    { kind: 'input', id: 'plain', type: { kind: 'concrete', name: 'INT' }, optional: false,
      widget: { widgetType: 'INT', options: {}, default: 10 } },
  ],
}
const resolve = (type: string) => type === schema.type ? schema : undefined

function fixture(linked = false) {
  return {
    format: 'dinkster-workflow' as const, formatVersion: 1 as const, lineage: 'controller-test', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'root', nodes: {
      seed: { id: 'seed', type: 'SeedTest', values: { up: 11, down: 11, random: 11, fixed: 11, plain: 11 },
        controllers: { up: 'increment', down: 'decrement', random: 'randomize', fixed: 'fixed' } },
      ...(linked ? { source: { id: 'source', type: 'SeedTest', values: {} } } : {}),
    }, links: linked ? { l1: { id: 'l1', from: { node: 'source', port: 'out' }, to: { node: 'seed', port: 'up' } } } : {},
    nets: {}, reroutes: {}, nextOrdinal: 3 } },
    view: { graphs: { g0: { nodes: {} } } },
  }
}

function compileDoc(document: any): CompileArtifact {
  const result = compile({ document, revision: 0, resolve, scope: { kind: 'full' }, connection: asConnectionId('local'), schemaHash: 'test' })
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return result.artifact
}

describe('controllerAdvancement', () => {
  it('advances increment/decrement/randomize, leaving fixed and controller-less values untouched', () => {
    const document = fixture() as any
    const invocation = controllerAdvancement(document, compileDoc(document), () => 0.5)
    expect(invocation).toEqual({ command: 'batch', params: { invocations: [
      { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'up', value: 14 } },
      { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'down', value: 9 } },
      { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'random', value: 15 } },
    ] } })
  })

  it('advances unsafe integer controller values without precision loss', () => {
    const exactSchema: NodeSchema = {
      type: 'ExactSeed', displayName: 'Exact Seed', category: 'test', source: 'v3', isOutputNode: true,
      items: [
        { kind: 'output', id: 'out', type: { kind: 'concrete', name: 'core.int' } },
        { kind: 'input', id: 'seed', type: { kind: 'concrete', name: 'core.int' }, optional: false,
          widget: { widgetType: 'INT', options: { min: 0, max: '18446744073709551615', step: 1 }, default: 0, controller: 'after_generate' } },
      ],
    }
    const document = {
      ...fixture(),
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        seed: { id: 'seed', type: 'ExactSeed', values: { seed: '18446744073709551614' }, controllers: { seed: 'increment' } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
    } as any
    const result = compile({
      document,
      revision: 0,
      resolve: (type) => type === exactSchema.type ? exactSchema : undefined,
      scope: { kind: 'full' },
      connection: asConnectionId('local'),
      schemaHash: 'test',
      graphFeatures: ['decimalInt'],
    })
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))

    expect(controllerAdvancement(document, result.artifact, () => 0.5)).toEqual({
      command: 'batch', params: { invocations: [
        { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'seed', value: '18446744073709551615' } },
      ] },
    })
  })

  it('advances an unstored input with no explicit default from its intrinsic default', () => {
    // Compile executes such an input as effectiveWidgetDefault (min, else 0),
    // so advancement must step from that same value, not silently skip.
    const noDefault: NodeSchema = {
      ...schema,
      items: [
        { kind: 'output', id: 'out', type: { kind: 'concrete', name: 'INT' } },
        { kind: 'input', id: 'seed', type: { kind: 'concrete', name: 'INT' }, optional: false,
          widget: { widgetType: 'INT', options: { min: 10, max: 20, step: 3 }, controller: 'after_generate' } },
      ],
    }
    const resolveNoDefault = (type: string) => type === noDefault.type ? noDefault : undefined
    const document = {
      ...fixture(),
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        seed: { id: 'seed', type: 'SeedTest', values: {}, controllers: { seed: 'increment' } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
    } as any
    const result = compile({ document, revision: 0, resolve: resolveNoDefault, scope: { kind: 'full' }, connection: asConnectionId('local'), schemaHash: 'test' })
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    const invocation = controllerAdvancement(document, result.artifact, () => 0.5)
    expect(invocation).toEqual({ command: 'batch', params: { invocations: [
      // intrinsic default 10 (min) + step 3; expected stays undefined (unstored).
      { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'seed', value: 13 } },
    ] } })
  })

  it('falls back to the schema controllerInitial when no mode is stored (wire v11); stored state wins', () => {
    // 'fixed' initial mode from the schema keeps an unstored input parked;
    // a stored document mode still overrides the schema seed.
    const initialFixed: NodeSchema = {
      ...schema,
      items: schema.items.map((item) =>
        item.kind === 'input' && (item.id === 'up' || item.id === 'down')
          ? { ...item, widget: { ...item.widget!, controllerInitial: 'fixed' as const } }
          : item),
    }
    const resolveInitial = (type: string) => type === schema.type ? initialFixed : undefined
    const document = fixture() as any
    delete document.graphs.g0.nodes.seed.controllers.up // unstored -> schema 'fixed'
    // 'down' keeps its stored 'decrement', overriding the schema 'fixed'.
    const artifact = (() => {
      const result = compile({ document, revision: 0, resolve: resolveInitial, scope: { kind: 'full' }, connection: asConnectionId('local'), schemaHash: 'test' })
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
      return result.artifact
    })()
    const invocation = controllerAdvancement(document, artifact, () => 0.5)
    expect(invocation).toEqual({ command: 'batch', params: { invocations: [
      { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'down', value: 9 } },
      { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'random', value: 15 } },
    ] } })
  })

  it('does NOT advance an OPTIONAL unstored input with no explicit default', () => {
    // Compile omits such an input from the prompt entirely (the backend's
    // own default applies), so advancement stepping it from an intrinsic
    // value would submit state the run never executed with.
    const optionalNoDefault: NodeSchema = {
      ...schema,
      items: [
        { kind: 'output', id: 'out', type: { kind: 'concrete', name: 'INT' } },
        { kind: 'input', id: 'seed', type: { kind: 'concrete', name: 'INT' }, optional: true,
          widget: { widgetType: 'INT', options: { min: 10, max: 20, step: 3 }, controller: 'after_generate' } },
      ],
    }
    const resolveOptional = (type: string) => type === optionalNoDefault.type ? optionalNoDefault : undefined
    const document = {
      ...fixture(),
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        seed: { id: 'seed', type: 'SeedTest', values: {}, controllers: { seed: 'increment' } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
    } as any
    const result = compile({ document, revision: 0, resolve: resolveOptional, scope: { kind: 'full' }, connection: asConnectionId('local'), schemaHash: 'test' })
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    expect(controllerAdvancement(document, result.artifact, () => 0.5)).toBeUndefined()
    // ...but a STORED value on the same optional input still advances.
    const stored = {
      ...document,
      graphs: { g0: { ...document.graphs.g0, nodes: {
        seed: { ...document.graphs.g0.nodes.seed, values: { seed: 11 } },
      } } },
    }
    const storedResult = compile({ document: stored, revision: 0, resolve: resolveOptional, scope: { kind: 'full' }, connection: asConnectionId('local'), schemaHash: 'test' })
    if (!storedResult.ok) throw new Error(JSON.stringify(storedResult.diagnostics))
    expect(controllerAdvancement(stored, storedResult.artifact, () => 0.5)).toEqual({
      command: 'batch', params: { invocations: [
        { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'seed', value: 14 } },
      ] },
    })
  })

  it('skips a link-driven input even when it has a controller mode', () => {
    const document = fixture(true) as any
    const invocation = controllerAdvancement(document, compileDoc(document), () => 0)
    expect((invocation?.params as any).invocations).not.toContainEqual(expect.objectContaining({ params: expect.objectContaining({ nodeId: 'seed', inputId: 'up' }) }))
  })
})

describe('compiled occurrence controller ownership', () => {
  const INT = { kind: 'concrete', name: 'INT' } as const
  const controlled = (id: string, value: number) => ({
    kind: 'input' as const,
    id,
    type: INT,
    optional: false,
    widget: { widgetType: 'INT' as const, options: { min: 0, max: 100, step: 1 }, default: value, controller: 'after_generate' as const },
  })
  const sourceSchema: NodeSchema = {
    type: 'ControllerSource', displayName: 'Source', category: 'test', source: 'v3', isOutputNode: false,
    items: [{ kind: 'output', id: 'out', type: INT }],
  }
  const promotedSchema: NodeSchema = {
    type: 'PromotedController', displayName: 'Promoted', category: 'test', source: 'v3', isOutputNode: true,
    items: [controlled('seed', 1), { kind: 'output', id: 'out', type: INT }],
  }
  const secondarySchema: NodeSchema = {
    ...promotedSchema,
    type: 'SecondaryController',
    displayName: 'Secondary',
  }
  const branchSchema: NodeSchema = {
    ...promotedSchema,
    type: 'BranchController',
    displayName: 'Branch',
    isOutputNode: false,
  }
  const sinkSchema: NodeSchema = {
    type: 'ControllerSink', displayName: 'Sink', category: 'test', source: 'v3', isOutputNode: true,
    items: [{ kind: 'input', id: 'in', type: INT, optional: false }],
  }
  const dynamicSchema: NodeSchema = {
    type: 'DynamicControllers', displayName: 'Dynamic', category: 'test', source: 'v3', isOutputNode: true,
    items: [
      {
        kind: 'input', id: 'mode', type: INT, optional: true,
        dynamic: { kind: 'dynamicCombo', options: [{ key: 'a', inputs: [controlled('seed', 1)] }] },
      },
      {
        kind: 'input', id: 'slot', type: INT, optional: true,
        dynamic: { kind: 'dynamicSlot', slotType: INT, inputs: [controlled('seed', 1)] },
      },
      {
        kind: 'input', id: 'items', type: INT, optional: true,
        dynamic: {
          kind: 'autogrow',
          template: [controlled('seed', 1)],
          naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
        },
      },
      { kind: 'output', id: 'out', type: INT },
    ],
  }
  const dynamicResolve = (type: string): NodeSchema | undefined =>
    type === sourceSchema.type ? sourceSchema
      : type === promotedSchema.type ? promotedSchema
        : type === secondarySchema.type ? secondarySchema
          : type === branchSchema.type ? branchSchema
            : type === sinkSchema.type ? sinkSchema
              : type === dynamicSchema.type ? dynamicSchema
                : undefined
  const compileControllers = (document: any): CompileArtifact => {
    const result = compile({ document, revision: 0, resolve: dynamicResolve, scope: { kind: 'full' }, connection: asConnectionId('local'), schemaHash: 'test' })
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    return result.artifact
  }
  const graph = (id: string, nodes: Record<string, any>, links: Record<string, any> = {}, boundary?: any) => ({
    id, name: id, nodes, links, nets: {}, reroutes: {}, nextOrdinal: 20, ...(boundary ? { boundary } : {}),
  })
  const document = (graphs: Record<string, any>) => ({
    format: 'dinkster-workflow' as const,
    formatVersion: 1 as const,
    lineage: 'controller-occurrences',
    root: 'g0',
    graphs,
    view: { graphs: {} },
  })
  const promotedBoundary = (node: string) => ({
    inputs: [{ id: 'seed', binds: { kind: 'port', node, port: 'seed' }, promoted: true }],
    outputs: [{ id: 'out', binds: { kind: 'port', node, port: 'out' } }],
  })

  it('advances controllers inside combo branches, slot dependents, and family members', () => {
    const doc = document({
      g0: graph('g0', {
        src: { id: 'src', type: sourceSchema.type, values: {} },
        dynamic: {
          id: 'dynamic', type: dynamicSchema.type,
          values: { 'mode.[a].seed': 3, 'slot.seed': 4, 'items.seed#m0': 5 },
          dynamic: { mode: { selected: 'a' }, items: { members: ['m0'] } },
          controllers: { 'mode.[a].seed': 'increment', 'slot.seed': 'increment', 'items.seed#m0': 'increment' },
        },
      }, {
        slot: { id: 'slot', from: { node: 'src', port: 'out' }, to: { node: 'dynamic', port: 'slot' } },
      }),
    }) as any
    expect(controllerAdvancement(doc, compileControllers(doc), () => 0)).toEqual({
      command: 'batch', params: { invocations: [
        { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'dynamic', inputId: 'mode.[a].seed', value: 4 } },
        { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'dynamic', inputId: 'slot.seed', value: 5 } },
        { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'dynamic', inputId: 'items.seed#m0', value: 6 } },
      ] },
    })
  })

  it('retires only a dynamic controller removed by a schema refresh', () => {
    const doc = document({
      g0: graph('g0', {
        dynamic: {
          id: 'dynamic', type: dynamicSchema.type,
          values: { 'mode.[a].seed': 3, 'items.seed#m0': 5 },
          dynamic: { mode: { selected: 'a' }, items: { members: ['m0'] } },
          controllers: { 'mode.[a].seed': 'increment', 'items.seed#m0': 'increment' },
        },
      }),
    }) as any
    const app = new AppState()
    ;(app.registry as any).set({ schemas: new Map(), resolve: () => undefined, hash: 'test' })
    app.registerSchemas([dynamicSchema])
    expect(app.openDocument(doc, 'Dynamic Controller Retirement')).toEqual([])
    const tab = app.activeTab()!
    const ref = { connection: asConnectionId('local'), prompt: asPromptId('dynamic-controller-retirement') }
    app.registerRun(tab, ref, compileControllers(tab.store.doc), 1)

    const refreshed = structuredClone(dynamicSchema) as any
    delete refreshed.items.find((item: any) => item.id === 'mode').dynamic.options[0].inputs[0].widget.controller
    app.registerSchemas([refreshed])
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })

    expect(tab.store.doc.graphs.g0!.nodes.dynamic!.values).toMatchObject({
      'mode.[a].seed': 3,
      'items.seed#m0': 6,
    })
  })

  it('skips stale dynamic widget semantics per item after a schema refresh', () => {
    const doc = document({
      g0: graph('g0', {
        dynamic: {
          id: 'dynamic', type: dynamicSchema.type,
          values: { 'mode.[a].seed': 3, 'items.seed#m0': 5 },
          dynamic: { mode: { selected: 'a' }, items: { members: ['m0'] } },
          controllers: { 'mode.[a].seed': 'increment', 'items.seed#m0': 'increment' },
        },
      }),
    }) as any
    const app = new AppState()
    ;(app.registry as any).set({ schemas: new Map(), resolve: () => undefined, hash: 'test' })
    app.registerSchemas([dynamicSchema])
    expect(app.openDocument(doc, 'Dynamic Controller Schema Change')).toEqual([])
    const tab = app.activeTab()!
    const ref = { connection: asConnectionId('local'), prompt: asPromptId('dynamic-controller-schema-change') }
    app.registerRun(tab, ref, compileControllers(tab.store.doc), 1)

    const refreshed = structuredClone(dynamicSchema) as any
    refreshed.items.find((item: any) => item.id === 'mode').dynamic.options[0].inputs[0].widget.options.step = 2
    app.registerSchemas([refreshed])
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })

    expect(tab.store.doc.graphs.g0!.nodes.dynamic!.values).toMatchObject({
      'mode.[a].seed': 3,
      'items.seed#m0': 6,
    })
  })

  it('stores modes for active dynamic controller value keys', () => {
    const doc = document({
      g0: graph('g0', {
        src: { id: 'src', type: sourceSchema.type, values: {} },
        dynamic: {
          id: 'dynamic', type: dynamicSchema.type,
          values: { 'mode.[a].seed': 3, 'slot.seed': 4, 'items.seed#m0': 5 },
          dynamic: { mode: { selected: 'a' }, items: { members: ['m0'] } },
        },
      }, {
        slot: { id: 'slot', from: { node: 'src', port: 'out' }, to: { node: 'dynamic', port: 'slot' } },
      }),
    }) as any
    const app = new AppState()
    ;(app.registry as any).set({ schemas: new Map(), resolve: () => undefined, hash: 'test' })
    app.registerSchemas([sourceSchema, dynamicSchema])
    expect(app.openDocument(doc, 'Dynamic Controllers')).toEqual([])
    const tab = app.activeTab()!
    for (const inputId of ['mode.[a].seed', 'slot.seed', 'items.seed#m0']) {
      expect(app.dispatchTo(tab, {
        command: 'node.setController',
        params: { graphId: 'g0', nodeId: 'dynamic', inputId, mode: 'increment' },
      }).ok).toBe(true)
    }
    expect(tab.store.doc.graphs.g0!.nodes.dynamic!.controllers).toEqual({
      'mode.[a].seed': 'increment',
      'slot.seed': 'increment',
      'items.seed#m0': 'increment',
    })
  })

  it('keeps promoted sibling controllers occurrence-local and inherits definition fallbacks', () => {
    const doc = document({
      g0: graph('g0', {
        left: { id: 'left', type: '#sub', values: { seed: 10 }, controllers: { seed: 'decrement' } },
        right: { id: 'right', type: '#sub', values: {} },
      }),
      sub: graph('sub', {
        leaf: { id: 'leaf', type: promotedSchema.type, values: { seed: 5 }, controllers: { seed: 'increment' } },
      }, {}, promotedBoundary('leaf')),
    }) as any
    expect(controllerAdvancement(doc, compileControllers(doc), () => 0)).toEqual({
      command: 'batch', params: { invocations: [
        { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'left', inputId: 'seed', value: 9 } },
        { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'right', inputId: 'seed', value: 6 } },
      ] },
    })
  })

  it.each([
    ['primary', 'secondary'],
    ['secondary', 'primary'],
  ] as const)('uses the primary fan-out target fallback with node order %s,%s', (...order) => {
    const innerNodes = {
      primary: { id: 'primary', type: promotedSchema.type, values: { seed: 10 }, controllers: { seed: 'increment' } },
      secondary: { id: 'secondary', type: secondarySchema.type, values: { seed: 20 }, controllers: { seed: 'decrement' } },
    }
    const doc = document({
      g0: graph('g0', {
        instance: { id: 'instance', type: '#sub', values: {} },
      }),
      sub: graph('sub', Object.fromEntries(order.map((node) => [node, innerNodes[node]])), {}, {
        inputs: [{
          id: 'seed',
          binds: { kind: 'port', node: 'primary', port: 'seed' },
          alsoBinds: [{ kind: 'port', node: 'secondary', port: 'seed' }],
          promoted: true,
        }],
        outputs: [{ id: 'out', binds: { kind: 'port', node: 'primary', port: 'out' } }],
      }),
    }) as any

    expect(controllerAdvancement(doc, compileControllers(doc), () => 0)).toEqual({
      command: 'batch', params: { invocations: [
        { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'instance', inputId: 'seed', value: 11 } },
      ] },
    })
  })

  it.each([
    { order: ['primary', 'secondary'], retiredNode: 'secondary', expected: 11 },
    { order: ['secondary', 'primary'], retiredNode: 'secondary', expected: 11 },
    { order: ['primary', 'secondary'], retiredNode: 'primary', expected: undefined },
    { order: ['secondary', 'primary'], retiredNode: 'primary', expected: undefined },
  ] as const)('revalidates a fan-out owner with $order when $retiredNode retires', ({ order, retiredNode, expected }) => {
    const innerNodes = {
      primary: { id: 'primary', type: promotedSchema.type, values: { seed: 10 }, controllers: { seed: 'increment' } },
      secondary: { id: 'secondary', type: secondarySchema.type, values: { seed: 20 }, controllers: { seed: 'decrement' } },
    }
    const doc = document({
      g0: graph('g0', {
        instance: { id: 'instance', type: '#sub', values: {} },
      }),
      sub: graph('sub', Object.fromEntries(order.map((node) => [node, innerNodes[node]])), {}, {
        inputs: [{
          id: 'seed',
          binds: { kind: 'port', node: 'primary', port: 'seed' },
          alsoBinds: [{ kind: 'port', node: 'secondary', port: 'seed' }],
          promoted: true,
        }],
        outputs: [{ id: 'out', binds: { kind: 'port', node: 'primary', port: 'out' } }],
      }),
    }) as any
    const app = new AppState()
    ;(app.registry as any).set({ schemas: new Map(), resolve: () => undefined, hash: 'test' })
    app.registerSchemas([promotedSchema, secondarySchema])
    expect(app.openDocument(doc, 'Fan-out Controller Retirement')).toEqual([])
    const tab = app.activeTab()!
    const ref = { connection: asConnectionId('local'), prompt: asPromptId('fan-out-controller-retirement') }
    app.registerRun(tab, ref, compileControllers(tab.store.doc), 1)

    const retiredSchema = retiredNode === 'primary' ? promotedSchema : secondarySchema
    const retired: NodeSchema = {
      ...retiredSchema,
      items: retiredSchema.items.map((item) => {
        if (item.kind !== 'input' || item.widget === undefined) return item
        const { controller: _controller, ...widget } = item.widget
        return { ...item, widget }
      }),
    }
    app.registerSchemas([retired])
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })

    expect(tab.store.doc.graphs.g0!.nodes.instance!.values.seed).toBe(expected)
    expect(tab.store.doc.graphs.sub!.nodes.primary!.values.seed).toBe(10)
    expect(tab.store.doc.graphs.sub!.nodes.secondary!.values.seed).toBe(20)
  })

  it('uses terminal delivery to suppress a linked promoted controller', () => {
    const doc = document({
      g0: graph('g0', {
        src: { id: 'src', type: sourceSchema.type, values: {} },
        left: { id: 'left', type: '#sub', values: { seed: 10 }, controllers: { seed: 'increment' } },
        right: { id: 'right', type: '#sub', values: { seed: 20 }, controllers: { seed: 'increment' } },
      }, {
        linked: { id: 'linked', from: { node: 'src', port: 'out' }, to: { node: 'left', port: 'seed' } },
      }),
      sub: graph('sub', {
        leaf: { id: 'leaf', type: promotedSchema.type, values: { seed: 5 }, controllers: { seed: 'increment' } },
      }, {}, promotedBoundary('leaf')),
    }) as any
    expect(controllerAdvancement(doc, compileControllers(doc), () => 0)).toEqual({
      command: 'batch', params: { invocations: [
        { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'right', inputId: 'seed', value: 21 } },
      ] },
    })
  })

  it('advances the outer owner through a nested promoted chain', () => {
    const doc = document({
      g0: graph('g0', {
        outer: { id: 'outer', type: '#wrapper', values: { seed: 20 } },
      }),
      wrapper: graph('wrapper', {
        inner: { id: 'inner', type: '#sub', values: { seed: 10 }, controllers: { seed: 'decrement' } },
      }, {}, promotedBoundary('inner')),
      sub: graph('sub', {
        leaf: { id: 'leaf', type: promotedSchema.type, values: { seed: 5 }, controllers: { seed: 'increment' } },
      }, {}, promotedBoundary('leaf')),
    }) as any
    expect(controllerAdvancement(doc, compileControllers(doc), () => 0)).toEqual({
      command: 'batch', params: { invocations: [
        { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'outer', inputId: 'seed', value: 19 } },
      ] },
    })
  })

  it('advances one shared definition owner once across unpromoted instances', () => {
    const doc = document({
      g0: graph('g0', {
        left: { id: 'left', type: '#sub', values: {} },
        right: { id: 'right', type: '#sub', values: {} },
      }),
      sub: graph('sub', {
        leaf: { id: 'leaf', type: promotedSchema.type, values: { seed: 5 }, controllers: { seed: 'increment' } },
      }, {}, {
        inputs: [{ id: 'seed', binds: { kind: 'port', node: 'leaf', port: 'seed' } }],
        outputs: [{ id: 'out', binds: { kind: 'port', node: 'leaf', port: 'out' } }],
      }),
    }) as any
    expect(controllerAdvancement(doc, compileControllers(doc), () => 0)).toEqual({
      command: 'batch', params: { invocations: [
        { command: 'node.setValue', params: { graphId: 'sub', nodeId: 'leaf', inputId: 'seed', value: 6 } },
      ] },
    })
  })

  const promotedSiblings = () => document({
    g0: graph('g0', {
      left: { id: 'left', type: '#sub', values: { seed: 10 }, controllers: { seed: 'decrement' } },
      right: { id: 'right', type: '#sub', values: {} },
    }),
    sub: graph('sub', {
      leaf: { id: 'leaf', type: promotedSchema.type, values: { seed: 5 }, controllers: { seed: 'increment' } },
    }, {}, promotedBoundary('leaf')),
  }) as any

  const occurrenceCompletionHarness = () => {
    const app = new AppState()
    ;(app.registry as any).set({ schemas: new Map(), resolve: () => undefined, hash: 'test' })
    app.registerSchemas([sourceSchema, promotedSchema, dynamicSchema])
    expect(app.openDocument(promotedSiblings(), 'Promoted Controllers')).toEqual([])
    const tab = app.activeTab()!
    const ref = { connection: asConnectionId('local'), prompt: asPromptId('promoted-controller-run') }
    app.registerRun(tab, ref, compileControllers(tab.store.doc), 1)
    return { app, tab, ref }
  }

  it('applies promoted occurrence owners on completion without mutating the definition', () => {
    const { app, tab, ref } = occurrenceCompletionHarness()
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    expect(tab.store.doc.graphs.g0!.nodes.left!.values.seed).toBe(9)
    expect(tab.store.doc.graphs.g0!.nodes.right!.values.seed).toBe(6)
    expect(tab.store.doc.graphs.sub!.nodes.leaf!.values.seed).toBe(5)
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.left!.values.seed).toBe(10)
    expect(tab.store.doc.graphs.g0!.nodes.right!.values.seed).toBeUndefined()
  })

  it('invalidates only occurrences whose effective fallback value changed after queueing', () => {
    const { app, tab, ref } = occurrenceCompletionHarness()
    tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'sub', nodeId: 'leaf', inputId: 'seed', value: 7 } })
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    expect(tab.store.doc.graphs.g0!.nodes.left!.values.seed).toBe(9)
    expect(tab.store.doc.graphs.g0!.nodes.right!.values.seed).toBeUndefined()
    expect(tab.store.doc.graphs.sub!.nodes.leaf!.values.seed).toBe(7)
  })

  it('does not apply an unstored initial mode after the live schema parks it', () => {
    const initial: NodeSchema = {
      ...promotedSchema,
      type: 'InitialModeController',
      items: promotedSchema.items.map((item) => item.kind === 'input'
        ? { ...item, widget: { ...item.widget!, controllerInitial: 'increment' as const } }
        : item),
    }
    const doc = document({
      g0: graph('g0', {
        seed: { id: 'seed', type: initial.type, values: { seed: 10 } },
      }),
    }) as any
    const app = new AppState()
    ;(app.registry as any).set({ schemas: new Map(), resolve: () => undefined, hash: 'test' })
    app.registerSchemas([initial])
    expect(app.openDocument(doc, 'Initial Mode Schema Change')).toEqual([])
    const tab = app.activeTab()!
    const queued = compile({ document: tab.store.doc, revision: 0, resolve: (type) => type === initial.type ? initial : undefined, scope: { kind: 'full' }, connection: asConnectionId('local'), schemaHash: 'test' })
    if (!queued.ok) throw new Error(JSON.stringify(queued.diagnostics))
    const ref = { connection: asConnectionId('local'), prompt: asPromptId('initial-mode-schema-change') }
    app.registerRun(tab, ref, queued.artifact, 1)

    const parked: NodeSchema = {
      ...initial,
      items: initial.items.map((item) => item.kind === 'input'
        ? { ...item, widget: { ...item.widget!, controllerInitial: 'fixed' as const } }
        : item),
    }
    app.registerSchemas([parked])
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values.seed).toBe(10)
  })

  const selectorCompletionHarness = (policy: { kind: 'fixed'; candidate: string } | { kind: 'random' }) => {
    const doc = document({
      g0: {
        ...graph('g0', {
          a: { id: 'a', type: branchSchema.type, values: { seed: 10 }, controllers: { seed: 'increment' } },
          b: { id: 'b', type: branchSchema.type, values: { seed: 20 }, controllers: { seed: 'increment' } },
          other: { id: 'other', type: promotedSchema.type, values: { seed: 30 }, controllers: { seed: 'increment' } },
          sink: { id: 'sink', type: sinkSchema.type, values: {} },
        }, {
          la: { id: 'la', from: { node: 'a', port: 'out' }, to: { selector: 'choice', candidate: 'a' } },
          lb: { id: 'lb', from: { node: 'b', port: 'out' }, to: { selector: 'choice', candidate: 'b' } },
          selected: { id: 'selected', from: { selector: 'choice' }, to: { node: 'sink', port: 'in' } },
        }),
        selectors: {
          choice: { id: 'choice', candidates: [{ id: 'a' }, { id: 'b' }], policy },
        },
      },
    }) as any
    const app = new AppState()
    ;(app.registry as any).set({ schemas: new Map(), resolve: () => undefined, hash: 'test' })
    app.registerSchemas([promotedSchema, branchSchema, sinkSchema])
    expect(app.openDocument(doc, 'Selector Controller Replay')).toEqual([])
    const tab = app.activeTab()!
    const queued = compile({
      document: tab.store.doc,
      revision: 0,
      resolve: dynamicResolve,
      scope: { kind: 'full' },
      connection: asConnectionId('local'),
      schemaHash: 'test',
      ...(policy.kind === 'random' ? { pickCandidate: () => 0 } : {}),
    })
    if (!queued.ok) throw new Error(JSON.stringify(queued.diagnostics))
    const ref = { connection: asConnectionId('local'), prompt: asPromptId(`selector-controller-${policy.kind}`) }
    app.registerRun(tab, ref, queued.artifact, 1)
    return { app, tab, ref }
  }

  it.each(['fixed', 'random'] as const)('replays a queued selector candidate over a new %s-to-fixed choice', (kind) => {
    const { app, tab, ref } = selectorCompletionHarness(kind === 'fixed'
      ? { kind: 'fixed', candidate: 'a' }
      : { kind: 'random' })
    expect(tab.store.dispatch({
      command: 'selector.setPolicy',
      params: { graphId: 'g0', selectorId: 'choice', policy: { kind: 'fixed', candidate: 'b' } },
    }).ok).toBe(true)
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    expect(tab.store.doc.graphs.g0!.nodes.a!.values.seed).toBe(11)
    expect(tab.store.doc.graphs.g0!.nodes.b!.values.seed).toBe(20)
  })

  it('skips only a controller whose queued selector candidate was removed', () => {
    const { app, tab, ref } = selectorCompletionHarness({ kind: 'fixed', candidate: 'a' })
    expect(tab.store.dispatch({
      command: 'selector.removeCandidate',
      params: { graphId: 'g0', selectorId: 'choice', candidateId: 'a' },
    }).ok).toBe(true)
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    expect(tab.store.doc.graphs.g0!.nodes.a!.values.seed).toBe(10)
    expect(tab.store.doc.graphs.g0!.nodes.b!.values.seed).toBe(20)
    expect(tab.store.doc.graphs.g0!.nodes.other!.values.seed).toBe(31)
  })
})

describe('COMBO control-after-generate', () => {
  it('cycles with wraparound and chooses random options uniformly', () => {
    const comboSchema: NodeSchema = {
      type: 'ComboController', displayName: 'Combo Controller', category: 'test', source: 'v3', isOutputNode: true,
      items: [
        { kind: 'output', id: 'out', type: { kind: 'concrete', name: 'core.string' } },
        ...(['up', 'down', 'random'] as const).map((id) => ({
          kind: 'input' as const, id, type: { kind: 'concrete' as const, name: 'core.combo' }, optional: false,
          widget: { widgetType: 'COMBO', options: { options: ['alpha', 'beta', 'gamma'] }, controller: 'after_generate' as const },
        })),
      ],
    }
    const resolveCombo = (type: string) => type === comboSchema.type ? comboSchema : undefined
    const document = {
      format: 'dinkster-workflow' as const, formatVersion: 1 as const, lineage: 'combo-controller', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        combo: { id: 'combo', type: comboSchema.type, values: { up: 'gamma', down: 'alpha', random: 'beta' },
          controllers: { up: 'increment', down: 'decrement', random: 'randomize' } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: {} } } },
    } as any
    const result = compile({ document, revision: 0, resolve: resolveCombo, scope: { kind: 'full' }, connection: asConnectionId('local'), schemaHash: 'test' })
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    expect(controllerAdvancement(document, result.artifact, () => 0.99)).toEqual({
      command: 'batch', params: { invocations: [
        { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'combo', inputId: 'up', value: 'alpha' } },
        { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'combo', inputId: 'down', value: 'gamma' } },
        { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'combo', inputId: 'random', value: 'gamma' } },
      ] },
    })
  })
})

describe('FLOAT controller advancement (shared canvas stepper semantics)', () => {
  // FLOAT advancement mirrors the canvas edge-zone stepper (core
  // numeric-step): default step 0.1, decimal quantization, min/max
  // clamping, and grid-quantized randomization - never integer seed math.
  const floatSchema: NodeSchema = {
    type: 'FloatSeed', displayName: 'Float Seed', category: 'test', source: 'v3', isOutputNode: true,
    items: [
      { kind: 'output', id: 'out', type: { kind: 'concrete', name: 'FLOAT' } },
      { kind: 'input', id: 'up', type: { kind: 'concrete', name: 'FLOAT' }, optional: false,
        widget: { widgetType: 'FLOAT', options: {}, default: 0.2, controller: 'after_generate' } },
      { kind: 'input', id: 'frac', type: { kind: 'concrete', name: 'FLOAT' }, optional: false,
        widget: { widgetType: 'FLOAT', options: { min: 0, max: 1, step: 0.25 }, default: 0.5, controller: 'after_generate' } },
      { kind: 'input', id: 'clampUp', type: { kind: 'concrete', name: 'FLOAT' }, optional: false,
        widget: { widgetType: 'FLOAT', options: { min: 0.1, max: 0.9, step: 0.1 }, default: 0.5, controller: 'after_generate' } },
      { kind: 'input', id: 'clampDown', type: { kind: 'concrete', name: 'FLOAT' }, optional: false,
        widget: { widgetType: 'FLOAT', options: { min: 0.1, max: 0.9, step: 0.1 }, default: 0.5, controller: 'after_generate' } },
      { kind: 'input', id: 'random', type: { kind: 'concrete', name: 'FLOAT' }, optional: false,
        widget: { widgetType: 'FLOAT', options: { min: 0.1, max: 0.9, step: 0.1 }, default: 0.5, controller: 'after_generate' } },
    ],
  }
  const resolveFloat = (type: string) => type === floatSchema.type ? floatSchema : undefined
  const floatFixture = () => ({
    format: 'dinkster-workflow' as const, formatVersion: 1 as const, lineage: 'float-controller-test', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'root', nodes: {
      seed: { id: 'seed', type: 'FloatSeed', values: { up: 0.2, frac: 0.5, clampUp: 0.9, clampDown: 0.1, random: 0.5 },
        controllers: { up: 'increment', frac: 'increment', clampUp: 'increment', clampDown: 'decrement', random: 'randomize' } },
    }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
    view: { graphs: { g0: { nodes: {} } } },
  })
  const compileFloat = (document: any): CompileArtifact => {
    const result = compile({ document, revision: 0, resolve: resolveFloat, scope: { kind: 'full' }, connection: asConnectionId('local'), schemaHash: 'test' })
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    return result.artifact
  }

  it('steps by the FLOAT default 0.1 / an explicit fractional step, quantized and clamped', () => {
    const document = floatFixture() as any
    const invocation = controllerAdvancement(document, compileFloat(document), () => 0.5)
    expect(invocation).toEqual({ command: 'batch', params: { invocations: [
      // default step 0.1: 0.2 -> 0.3 exactly, never 0.30000000000000004
      { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'up', value: 0.3 } },
      // explicit fractional step
      { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'frac', value: 0.75 } },
      // clamped at max / min instead of escaping the bounds
      { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'clampUp', value: 0.9 } },
      { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'clampDown', value: 0.1 } },
      // randomize on the 0.1 grid inside [0.1, 0.9]: midpoint draw -> 0.5
      { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'random', value: 0.5 } },
    ] } })
  })

  it('randomizes within fractional bounds to finite grid values at the extremes', () => {
    const document = floatFixture() as any
    const artifact = compileFloat(document)
    for (const draw of [0, 0.25, 0.75, 0.999999]) {
      const invocation = controllerAdvancement(document, artifact, () => draw)
      const random = (invocation?.params as any).invocations
        .find((entry: any) => entry.params.inputId === 'random').params.value as number
      expect(Number.isFinite(random)).toBe(true)
      expect(random).toBeGreaterThanOrEqual(0.1)
      expect(random).toBeLessThanOrEqual(0.9)
      expect(random).toBe(Math.round(random * 10) / 10) // on the 0.1 grid
    }
  })
})

describe('completion integration', () => {
  let app: AppState
  let tab: Tab
  let artifact: CompileArtifact
  let ref: ExecutionRef

  beforeEach(() => {
    app = new AppState()
    expect(app.settings.get('features.seedController.enabled')).toBe(true)
    ;(app.registry as any).set({ schemas: new Map(), resolve: () => undefined, hash: 'test' })
    app.registerSchemas([schema])
    expect(app.openDocument(fixture(), 'Controller Test')).toEqual([])
    tab = app.activeTab()!
    artifact = compileDoc(tab.store.doc)
    ref = { connection: asConnectionId('local'), prompt: asPromptId('controller-run') }
    app.registerRun(tab, ref, artifact, 1)
  })

  const baseline = { up: 11, down: 11, random: 11, fixed: 11, plain: 11 }

  it('applies all completion changes in one undo step and never advances one run twice', () => {
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: 14, down: 9 })
    const once = { ...tab.store.doc.graphs.g0!.nodes.seed!.values }
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 3 })
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toEqual(once)
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toEqual(baseline)
  })

  it.each(['error', 'interrupted'] as const)('does not advance an %s run, and consumes its plan', (kind) => {
    app.store.apply({ kind, execution: ref, timestamp: 2, ...(kind === 'error' ? { detail: { exceptionType: 'Error', exceptionMessage: 'failed', traceback: [] } } : {}) } as any)
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toEqual(baseline)
    // A spurious later completion of the same key must find no plan.
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 3 })
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toEqual(baseline)
  })

  it('does not capture a plan when the feature is disabled at queue time', () => {
    app.settings.set('features.seedController.enabled', false)
    const other = { connection: asConnectionId('local'), prompt: asPromptId('disabled-run') }
    app.registerRun(tab, other, artifact, 2)
    app.store.apply({ kind: 'completed', execution: other, timestamp: 3 })
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toEqual(baseline)
  })

  it('does not advance when the feature is disabled after queueing (mid-run)', () => {
    app.settings.set('features.seedController.enabled', false)
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toEqual(baseline)
  })

  it('preserves an input edited after queueing while untouched controls advance', () => {
    tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'up', value: 100 } })
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    // 'up' fails the compare-and-set (queue-time value was 11); 'down' advances.
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: 100, down: 9 })
  })

  it('does not advance an input that becomes driven after queueing', () => {
    expect(tab.store.dispatch({
      command: 'node.add',
      params: { graphId: 'g0', type: schema.type, position: { x: 0, y: 0 } },
    }).ok).toBe(true)
    expect(tab.store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: { node: 'n3', port: 'out' }, to: { node: 'seed', port: 'up' } },
    }).ok).toBe(true)
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: 11, down: 9 })
  })

  it('preserves the latest of many rapid manual steps and applies queue advancement only once', () => {
    const count = 20
    for (let value = 12; value < 12 + count; value++) {
      expect(tab.store.dispatch({
        command: 'node.setValue',
        params: { graphId: 'g0', nodeId: 'seed', inputId: 'up', value },
      }).ok).toBe(true)
    }
    const manual = 11 + count
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: manual, down: 9 })
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 3 })
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: manual, down: 9 })
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: manual, down: 11 })
    for (let i = 0; i < count; i++) expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values.up).toBe(11)
  })

  it('preserves rapid manual ABA stepping that returns to the queued value', () => {
    expect(tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'seed', inputId: 'up', value: 14 },
    }).ok).toBe(true)
    expect(tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'seed', inputId: 'up', value: 11 },
    }).ok).toBe(true)
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    // Value equality alone would advance up to 14 and lose the manual +/-.
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: 11, down: 9 })
  })

  it('tracks optimistic value ABA in a delayed-onOp acknowledgement simulation', () => {
    const original = tab.store
    const delayed = new Proxy(original, {
      get(target, property) {
        if (property === 'onOp') return () => () => undefined
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    ;(tab as unknown as { store: typeof delayed }).store = delayed
    const delayedArtifact = compileDoc(delayed.doc)
    const delayedRef = { connection: asConnectionId('local'), prompt: asPromptId('controller-delayed-op') }
    app.registerRun(tab, delayedRef, delayedArtifact, 2)
    expect(delayed.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'seed', inputId: 'up', value: 14 },
    }).ok).toBe(true)
    expect(delayed.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'seed', inputId: 'up', value: 11 },
    }).ok).toBe(true)
    app.store.apply({ kind: 'completed', execution: delayedRef, timestamp: 3 })
    expect(delayed.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: 11, down: 9 })
  })

  it('does not advance an input parked to fixed after queueing (mode compare-and-set)', () => {
    tab.store.dispatch({ command: 'node.setController', params: { graphId: 'g0', nodeId: 'seed', inputId: 'up', mode: 'fixed' } })
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    // 'up' was queued under 'increment' but is now parked; 'down' advances.
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: 11, down: 9 })
  })

  it('skips a step whose mode changed between two non-fixed modes after queueing', () => {
    // The queued plan is 'decrement' math; applying it under the new
    // 'increment' intent would move the value the wrong way.
    tab.store.dispatch({ command: 'node.setController', params: { graphId: 'g0', nodeId: 'seed', inputId: 'down', mode: 'increment' } })
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: 14, down: 11 })
  })

  it('does not advance when the live schema no longer marks the widget as a controller', () => {
    // A schema epoch change that removes controlAfterGenerate retires the
    // control: a plan queued under the old schema cannot prove the intent
    // still stands, even though the stored mode string is unchanged.
    const stripped: NodeSchema = {
      ...schema,
      items: schema.items.map((item) => {
        if (item.kind !== 'input' || item.widget?.controller === undefined) return item
        const { controller: _controller, ...widget } = item.widget
        return { ...item, widget }
      }),
    }
    app.registerSchemas([stripped]) // layers over the live registry by type
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toEqual(baseline)
  })

  it('treats clearing a stored mode back to the default as a mode change', () => {
    // 'down' queued under stored 'decrement'; clearing the stored mode makes
    // the effective mode 'randomize' (the historical default) - a different
    // intent, so the queued decrement is stale and must not apply.
    tab.store.dispatch({ command: 'node.setController', params: { graphId: 'g0', nodeId: 'seed', inputId: 'down', mode: null } })
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: 14, down: 11 })
  })

  it('still advances when an unstored mode is stored explicitly as the same effective mode', () => {
    // Queued with NO stored mode (effective 'randomize'); storing 'randomize'
    // explicitly changes the raw token (undefined -> 'randomize') but not the
    // effective mode - the CAS compares EFFECTIVE modes, so the plan stands.
    // Degenerate [42, 42] bounds make the randomized value deterministic.
    const pinned: NodeSchema = {
      type: 'PinnedSeed', displayName: 'Pinned Seed', category: 'test', source: 'v3', isOutputNode: true,
      items: [
        { kind: 'output', id: 'out', type: { kind: 'concrete', name: 'INT' } },
        { kind: 'input', id: 'random', type: { kind: 'concrete', name: 'INT' }, optional: false,
          widget: { widgetType: 'INT', options: { min: 42, max: 42 }, default: 7, controller: 'after_generate' } },
      ],
    }
    app.registerSchemas([pinned])
    const doc = {
      format: 'dinkster-workflow' as const, formatVersion: 1 as const, lineage: 'mode-cas-unstored', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        seed: { id: 'seed', type: 'PinnedSeed', values: { random: 7 } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: {} } } },
    }
    expect(app.openDocument(doc as any, 'Mode CAS')).toEqual([])
    const modeTab = app.activeTab()!
    const resolvePinned = (type: string) => type === pinned.type ? pinned : undefined
    const result = compile({ document: modeTab.store.doc, revision: 0, resolve: resolvePinned, scope: { kind: 'full' }, connection: asConnectionId('local'), schemaHash: 'test' })
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    const modeRef = { connection: asConnectionId('local'), prompt: asPromptId('mode-cas-run') }
    app.registerRun(modeTab, modeRef, result.artifact, 2)
    modeTab.store.dispatch({ command: 'node.setController', params: { graphId: 'g0', nodeId: 'seed', inputId: 'random', mode: 'randomize' } })
    app.store.apply({ kind: 'completed', execution: modeRef, timestamp: 3 })
    expect(modeTab.store.doc.graphs.g0!.nodes.seed!.values.random).toBe(42)
  })

  it('skips a node deleted after queueing without disturbing anything else', () => {
    tab.store.dispatch({ command: 'node.remove', params: { graphId: 'g0', nodeIds: ['seed'] } })
    expect(() => app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })).not.toThrow()
    expect(tab.store.doc.graphs.g0!.nodes.seed).toBeUndefined()
  })

  it('never advances a closed session', () => {
    const before = tab.store.revision
    app.closeTab(tab.id)
    expect(() => app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })).not.toThrow()
    expect(tab.store.revision).toBe(before)
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toEqual(baseline)
  })

  it('never advances a replacement session that shares the lineage', () => {
    expect(app.openDocument(fixture(), 'Controller Test (reopened)')).toEqual([])
    const replacement = app.activeTab()!
    expect(replacement.store).not.toBe(tab.store)
    expect(replacement.store.doc.lineage).toBe(tab.store.doc.lineage)
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    expect(replacement.store.doc.graphs.g0!.nodes.seed!.values).toEqual(baseline)
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toEqual(baseline)
  })

  it('advances exactly once when the completion event beat registration', () => {
    const fast = { connection: asConnectionId('local'), prompt: asPromptId('fast-run') }
    app.store.apply({ kind: 'completed', execution: fast, timestamp: 2 })
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toEqual(baseline) // no plan yet
    app.registerRun(tab, fast, artifact, 3) // plan installed before register republishes
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: 14, down: 9 })
    const once = { ...tab.store.doc.graphs.g0!.nodes.seed!.values }
    app.store.apply({ kind: 'completed', execution: fast, timestamp: 4 })
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toEqual(once)
  })

  it.each(['error', 'interrupted'] as const)('drops the plan when an %s event beat registration', (kind) => {
    const fast = { connection: asConnectionId('local'), prompt: asPromptId('failed-fast-run') }
    app.store.apply({ kind, execution: fast, timestamp: 2, ...(kind === 'error' ? { detail: { exceptionType: 'Error', exceptionMessage: 'failed', traceback: [] } } : {}) } as any)
    app.registerRun(tab, fast, artifact, 3) // register republishes the terminal state: plan must drop
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toEqual(baseline)
    app.store.apply({ kind: 'completed', execution: fast, timestamp: 4 }) // spurious - no plan left
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toEqual(baseline)
  })

  it('survives provisional loss: a revived run still advances exactly once on completion', () => {
    app.store.markLost(ref, 2) // reconcile verdict: interrupted, but provisional
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toEqual(baseline)
    app.store.apply({ kind: 'started', execution: ref, timestamp: 3 }) // live event revives it
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 4 })
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: 14, down: 9 })
    const once = { ...tab.store.doc.graphs.g0!.nodes.seed!.values }
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 5 })
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toEqual(once)
  })

  it('preserves an edit made between compile and registration (snapshot is the baseline)', () => {
    const late = { connection: asConnectionId('local'), prompt: asPromptId('late-register-run') }
    // artifact (compiled in beforeEach) snapshots up=11; the edit lands
    // during the simulated submission await, before registration.
    tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'up', value: 100 } })
    app.registerRun(tab, late, artifact, 2)
    app.store.apply({ kind: 'completed', execution: late, timestamp: 3 })
    expect(tab.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: 100, down: 9 })
  })

  it('treats a widget-default (unstored) value as its own compare-and-set token', () => {
    const doc = fixture() as any
    doc.lineage = 'controller-test-default'
    delete doc.graphs.g0.nodes.seed.values.up // default 10 in effect, raw stored value undefined
    expect(app.openDocument(doc, 'Default Seed')).toEqual([])
    const defaultTab = app.activeTab()!
    const defaultRef = { connection: asConnectionId('local'), prompt: asPromptId('default-run') }
    app.registerRun(defaultTab, defaultRef, compileDoc(defaultTab.store.doc), 2)
    app.store.apply({ kind: 'completed', execution: defaultRef, timestamp: 3 })
    // increment from the effective default 10 by step 3
    expect(defaultTab.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: 13, down: 9 })
  })

  it('preserves a value stored over the default after queueing (undefined token mismatch)', () => {
    const doc = fixture() as any
    doc.lineage = 'controller-test-default-edit'
    delete doc.graphs.g0.nodes.seed.values.up
    expect(app.openDocument(doc, 'Default Seed Edited')).toEqual([])
    const defaultTab = app.activeTab()!
    const defaultRef = { connection: asConnectionId('local'), prompt: asPromptId('default-edit-run') }
    app.registerRun(defaultTab, defaultRef, compileDoc(defaultTab.store.doc), 2)
    defaultTab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'up', value: 10 } })
    app.store.apply({ kind: 'completed', execution: defaultRef, timestamp: 3 })
    // Same effective number, but the raw stored value changed undefined -> 10:
    // the user's explicit choice wins over the queue-time plan.
    expect(defaultTab.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: 10, down: 9 })
  })
})

describe('control_after_refresh advancement', () => {
  const route = '/remote/options'
  const combo = (id: string) => ({
    kind: 'input' as const,
    id,
    type: { kind: 'concrete' as const, name: 'core.combo' },
    optional: false,
    widget: {
      widgetType: 'COMBO', options: {}, default: 'a', controller: 'after_refresh' as const,
      remote: { route, refreshButton: true, controlAfterRefresh: 'first' as const },
    },
  })
  const comboSchema: NodeSchema = {
    type: 'RefreshCombo', displayName: 'Refresh Combo', category: 'test', source: 'v3', isOutputNode: false,
    items: [combo('up'), combo('down'), combo('random'), combo('fixed'), combo('shrunk')],
  }
  const sourceSchema: NodeSchema = {
    type: 'ComboSource', displayName: 'Combo Source', category: 'test', source: 'v3', isOutputNode: false,
    items: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'core.combo' } }],
  }
  const comboFixture = () => ({
    format: 'dinkster-workflow' as const, formatVersion: 1 as const, lineage: 'combo-refresh-test', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'root', nodes: {
      source: { id: 'source', type: 'ComboSource', values: {} },
      combo: {
        id: 'combo', type: 'RefreshCombo',
        values: { up: 'c', down: 'a', random: 'b', fixed: 'b', shrunk: 'removed' },
        controllers: { up: 'increment', down: 'decrement', random: 'randomize', fixed: 'fixed', shrunk: 'increment' },
      },
    }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
    view: { graphs: { g0: { nodes: {} } } },
  })

  function comboHarness() {
    const app = new AppState()
    ;(app.registry as unknown as { set(value: unknown): void }).set({ schemas: new Map(), resolve: () => undefined, hash: 'combo-test' })
    app.registerSchemas([comboSchema, sourceSchema])
    expect(app.openDocument(comboFixture(), 'Combo Refresh')).toEqual([])
    return { app, tab: app.activeTab()! }
  }

  it('advances increment/decrement with wrap, randomize uniformly, and leaves fixed untouched', () => {
    const { app, tab } = comboHarness()
    const plan = app.prepareComboRefresh(tab, route)
    app.completeComboRefresh(plan, ['a', 'b', 'c'], () => 0.5)
    expect(tab.store.doc.graphs.g0!.nodes.combo!.values).toEqual({
      up: 'a', down: 'c', random: 'b', fixed: 'b', shrunk: 'a',
    })
  })

  it('uses first/last wrap anchors when refreshed options no longer contain the stored value', () => {
    const { app, tab } = comboHarness()
    tab.store.dispatch({ command: 'node.setController', params: { graphId: 'g0', nodeId: 'combo', inputId: 'shrunk', mode: 'decrement' } })
    const plan = app.prepareComboRefresh(tab, route)
    app.completeComboRefresh(plan, ['new-a', 'new-b'], () => 0)
    expect(tab.store.doc.graphs.g0!.nodes.combo!.values.shrunk).toBe('new-b')
  })

  it('compare-and-set preserves a user edit made while the source is stale', () => {
    const { app, tab } = comboHarness()
    const plan = app.prepareComboRefresh(tab, route)
    tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'combo', inputId: 'up', value: 'user-edit' } })
    app.completeComboRefresh(plan, ['a', 'b', 'c'], () => 0)
    expect(tab.store.doc.graphs.g0!.nodes.combo!.values).toMatchObject({ up: 'user-edit', down: 'c' })
  })

  it('suppresses plans while disabled and consumes an in-flight plan when disabled', () => {
    const { app, tab } = comboHarness()
    app.settings.set('features.seedController.enabled', false)
    expect(app.prepareComboRefresh(tab, route)).toBeUndefined()
    app.settings.set('features.seedController.enabled', true)
    const plan = app.prepareComboRefresh(tab, route)
    app.settings.set('features.seedController.enabled', false)
    const baseline = { ...tab.store.doc.graphs.g0!.nodes.combo!.values }
    app.completeComboRefresh(plan, ['a', 'b', 'c'], () => 0)
    expect(tab.store.doc.graphs.g0!.nodes.combo!.values).toEqual(baseline)
  })

  it('skips an input that becomes link-driven while the source is stale', () => {
    const { app, tab } = comboHarness()
    const plan = app.prepareComboRefresh(tab, route)
    expect(tab.store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: { node: 'source', port: 'out' }, to: { node: 'combo', port: 'up' } },
    }).ok).toBe(true)
    app.completeComboRefresh(plan, ['a', 'b', 'c'], () => 0)
    expect(tab.store.doc.graphs.g0!.nodes.combo!.values).toMatchObject({ up: 'c', down: 'c' })
  })

  it('skips an input that becomes a named-net sink while the source is stale', () => {
    const { app, tab } = comboHarness()
    const plan = app.prepareComboRefresh(tab, route)
    expect(tab.store.dispatch({
      command: 'net.create',
      params: { graphId: 'g0', name: 'models', source: { node: 'source', port: 'out' } },
    }).ok).toBe(true)
    const netId = Object.keys(tab.store.doc.graphs.g0!.nets)[0]!
    expect(tab.store.dispatch({
      command: 'net.connectInput', params: { graphId: 'g0', netId, to: { node: 'combo', port: 'up' } },
    }).ok).toBe(true)
    app.completeComboRefresh(plan, ['a', 'b', 'c'], () => 0)
    expect(tab.store.doc.graphs.g0!.nodes.combo!.values).toMatchObject({ up: 'c', down: 'c' })
  })

  it('suppresses completion after the schema registry identity changes', () => {
    const { app, tab } = comboHarness()
    const plan = app.prepareComboRefresh(tab, route)
    app.registerSchemas([{ ...comboSchema, displayName: 'Refresh Combo v2' }])
    const baseline = { ...tab.store.doc.graphs.g0!.nodes.combo!.values }
    app.completeComboRefresh(plan, ['a', 'b', 'c'], () => 0)
    expect(tab.store.doc.graphs.g0!.nodes.combo!.values).toEqual(baseline)
  })

  it('applies one fresh completion at most once and batches all values into one undo step', () => {
    const { app, tab } = comboHarness()
    const baseline = { ...tab.store.doc.graphs.g0!.nodes.combo!.values }
    const plan = app.prepareComboRefresh(tab, route)
    app.completeComboRefresh(plan, ['a', 'b', 'c'], () => 0)
    const once = { ...tab.store.doc.graphs.g0!.nodes.combo!.values }
    app.completeComboRefresh(plan, ['x', 'y'], () => 0)
    expect(tab.store.doc.graphs.g0!.nodes.combo!.values).toEqual(once)
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.combo!.values).toEqual(baseline)
  })

  it('preparing a stale refresh does not mutate; only completion with fresh options applies', () => {
    const { app, tab } = comboHarness()
    const baseline = { ...tab.store.doc.graphs.g0!.nodes.combo!.values }
    expect(tab.store.doc.graphs.g0!.nodes.combo!.values).toEqual(baseline)
    const abandonedRefresh = app.prepareComboRefresh(tab, route)
    expect(tab.store.doc.graphs.g0!.nodes.combo!.values).toEqual(baseline)
    const freshRefresh = app.prepareComboRefresh(tab, route)
    app.completeComboRefresh(freshRefresh, ['a', 'b', 'c'], () => 0)
    expect(tab.store.doc.graphs.g0!.nodes.combo!.values).not.toEqual(baseline)
    expect(abandonedRefresh).toBeDefined()
  })
})
