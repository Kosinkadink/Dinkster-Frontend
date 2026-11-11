import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { compositorRecipeFingerprint, EMPTY_COMPOSITOR_RECIPE, type CompositorRecipe } from '../src/compositor.js'
import { createLocalSession, type SessionOp } from '../src/commands/session.js'
import { DocumentStore } from '../src/commands/store.js'
import type { GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asLinkId, asNetId, asNodeId, asPortId } from '../src/ids.js'
import type { NodeSchema } from '../src/schema/model.js'

const SOURCE = `blake3:${'a'.repeat(64)}`
const REPLACEMENT = `blake3:${'b'.repeat(64)}`
const sourceRef = { digest: SOURCE, name: 'source.png', size: 10, mediaType: 'image/png', virtualPath: '' }
const replacementRef = { digest: REPLACEMENT, name: 'edited.png', size: 20, mediaType: 'image/png', virtualPath: '' }

const schema: NodeSchema = {
  type: 'LoadImage',
  displayName: 'Load Image',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [{
    kind: 'input',
    id: 'image',
    type: { kind: 'asset', element: { kind: 'concrete', name: 'IMAGE' } },
    optional: false,
    widget: { widgetType: 'ASSET', options: {} },
  }],
}

function document(graph: GraphDef): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('image-command'),
    root: asGraphDefId('g0'),
    graphs: { g0: graph },
    view: { graphs: {} },
  }
}

function graph(): GraphDef {
  return {
    id: asGraphDefId('g0'),
    name: 'root',
    nodes: {
      image: { id: asNodeId('image'), type: 'LoadImage', values: { image: sourceRef } },
      source: { id: asNodeId('source'), type: 'Source', values: {} },
    },
    links: {},
    nets: {},
    reroutes: {},
    nextOrdinal: 1,
  }
}

const invocation = {
  command: 'image.applyAsset',
  params: {
    graphId: 'g0',
    nodeId: 'image',
    inputId: 'image',
    expectedSourceDigest: SOURCE,
    asset: replacementRef,
  },
}

function store(graphDef = graph(), resolvedSchema = schema): DocumentStore {
  return new DocumentStore(document(graphDef), coreCommandRegistry([], (type) => type === resolvedSchema.type ? resolvedSchema : undefined))
}

describe('image.applyAsset', () => {
  it('admits typed image assets and refuses hidden inputs', () => {
    for (const hidden of [false, true]) {
      const native: NodeSchema = { ...schema, items: [{
        kind: 'input', id: 'image', optional: false, ...(hidden ? { hidden: true } : {}),
        type: { kind: 'asset', element: { kind: 'concrete', name: 'IMAGE' } },
        widget: { widgetType: 'ASSET', options: {} },
      }] }
      const target = new DocumentStore(document(graph()), coreCommandRegistry([], () => native))
      expect(target.dispatch(invocation).ok).toBe(!hidden)
      expect(target.revision).toBe(hidden ? 0 : 1)
      expect(target.doc.graphs.g0!.nodes.image!.values.image).toEqual(hidden ? sourceRef : replacementRef)
    }
  })

  it('atomically replaces one current writable image AssetRef with undo support', () => {
    const target = store()
    const outcome = target.dispatch(invocation)
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.forward).toHaveLength(1)
    expect(target.doc.graphs.g0!.nodes.image!.values.image).toEqual(replacementRef)
    expect(target.revision).toBe(1)
    expect(target.undo()).toBe(true)
    expect(target.doc.graphs.g0!.nodes.image!.values.image).toEqual(sourceRef)
  })

  it('accepts the canonical image asset type', () => {
    const nativeSchema = {
      ...schema,
      items: [{ ...schema.items[0]!, type: { kind: 'asset', element: { kind: 'concrete', name: 'IMAGE' } } }],
    } as NodeSchema
    expect(store(graph(), nativeSchema).dispatch(invocation).ok).toBe(true)
  })

  it('rejects stale sources, incomplete refs, wrong media, and unknown extra params', () => {
    const cases = [
      { ...invocation.params, expectedSourceDigest: `blake3:${'c'.repeat(64)}` },
      { ...invocation.params, asset: { digest: REPLACEMENT } },
      { ...invocation.params, asset: { ...replacementRef, mediaType: 'video/mp4' } },
      { ...invocation.params, extra: true },
    ]
    for (const params of cases) {
      const target = store()
      expect(target.dispatch({ command: invocation.command, params }).ok).toBe(false)
      expect(target.revision).toBe(0)
    }
  })

  it('rejects linked and net-driven image inputs', () => {
    const linked: GraphDef = {
      ...graph(),
      links: {
        link: {
          id: asLinkId('link'),
          from: { node: asNodeId('source'), port: asPortId('out') },
          to: { node: asNodeId('image'), port: asPortId('image') },
        },
      },
    }
    expect(store(linked).dispatch(invocation).ok).toBe(false)

    const netDriven: GraphDef = {
      ...graph(),
      nets: {
        net: {
          id: asNetId('net'),
          name: 'Image',
          source: { node: asNodeId('source'), port: asPortId('out') },
          sinks: [{ node: asNodeId('image'), port: asPortId('image') }],
        },
      },
    }
    expect(store(netDriven).dispatch(invocation).ok).toBe(false)
  })

  it('requires the exact typed image Asset input schema', () => {
    const target = new DocumentStore(document(graph()), coreCommandRegistry([], () => ({
      ...schema,
      items: [{ ...schema.items[0]!, type: { kind: 'concrete', name: 'ASSET' } }],
    } as NodeSchema)))
    expect(target.dispatch(invocation).ok).toBe(false)
    expect(target.revision).toBe(0)
  })
})

const compositorSchema: NodeSchema = {
  type: 'CreateLayeredImage',
  displayName: 'Create Layered Image',
  category: 'test',
  source: 'v3',
  isOutputNode: true,
  items: [{
    kind: 'input',
    id: 'compositor',
    type: { kind: 'concrete', name: 'COMPOSITOR' },
    optional: true,
    widget: { widgetType: 'COMPOSITOR', options: {}, default: EMPTY_COMPOSITOR_RECIPE },
  }],
}

const compositorRecipe: CompositorRecipe = {
  version: 2,
  documentDigest: `blake3:${'a'.repeat(64)}`,
  commands: [{ op: 'layer', id: 'layer-1', changes: { visible: false } }],
}

const compositorGraph = (value?: unknown): GraphDef => ({
  id: asGraphDefId('g0'),
  name: 'root',
  nodes: {
    compositor: {
      id: asNodeId('compositor'),
      type: 'CreateLayeredImage',
      values: value === undefined ? {} : { compositor: value as never },
    },
    source: { id: asNodeId('source'), type: 'Source', values: {} },
  },
  links: {},
  nets: {},
  reroutes: {},
  nextOrdinal: 1,
})

const compositorInvocation = {
  command: 'image.compositorApply',
  params: {
    graphId: 'g0',
    nodeId: 'compositor',
    inputId: 'compositor',
    instancePath: [] as string[],
    expectedRecipeFingerprint: compositorRecipeFingerprint(undefined)!,
    recipe: compositorRecipe as unknown as Json,
  },
}

const compositorRegistry = (resolved: NodeSchema = compositorSchema) =>
  coreCommandRegistry([], (type) => type === resolved.type ? resolved : undefined)

describe('image.compositorApply', () => {
  it('atomically applies one exact recipe with forward patch, undo, and redo', () => {
    const target = new DocumentStore(document(compositorGraph()), compositorRegistry())
    const outcome = target.dispatch(compositorInvocation)
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.forward).toEqual([{
      op: 'add',
      path: ['graphs', 'g0', 'nodes', 'compositor', 'values', 'compositor'],
      value: compositorRecipe,
    }])
    expect(target.revision).toBe(1)
    expect(target.doc.graphs.g0!.nodes.compositor!.values.compositor).toEqual(compositorRecipe)
    expect(target.undo()).toBe(true)
    expect(target.doc.graphs.g0!.nodes.compositor!.values.compositor).toBeUndefined()
    expect(target.redo()).toBe(true)
    expect(target.doc.graphs.g0!.nodes.compositor!.values.compositor).toEqual(compositorRecipe)
  })

  it('publishes the same single replace as a local collaboration wire patch', () => {
    const session = createLocalSession(document(compositorGraph()), compositorRegistry(), { clock: () => 42 })
    const ops: SessionOp[] = []
    session.onOp((op) => ops.push(op))
    expect(session.dispatch(compositorInvocation).ok).toBe(true)
    expect(ops).toEqual([expect.objectContaining({
      baseRevision: 0,
      revision: 1,
      origin: 'image.compositorApply',
      patch: [{
        op: 'add',
        path: ['graphs', 'g0', 'nodes', 'compositor', 'values', 'compositor'],
        value: compositorRecipe,
      }],
      timestamp: 42,
    })])
  })

  it('rejects stale or malformed recipes without writing', () => {
    const current = { ...compositorRecipe, commands: [{ op: 'layer', id: 'layer-1', changes: { visible: true } }] }
    const stale = new DocumentStore(document(compositorGraph(current)), compositorRegistry())
    const staleOutcome = stale.dispatch(compositorInvocation)
    expect(staleOutcome.ok).toBe(false)
    expect(staleOutcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('image.compositorRecipeChanged')
    expect(stale.revision).toBe(0)
    expect(stale.doc.graphs.g0!.nodes.compositor!.values.compositor).toEqual(current)

    const malformedCurrent = new DocumentStore(document(compositorGraph({ version: 1 })), compositorRegistry())
    const expectedMalformed = {
      ...compositorInvocation,
      params: { ...compositorInvocation.params, expectedRecipeFingerprint: `sha256:${'0'.repeat(64)}` },
    }
    const currentOutcome = malformedCurrent.dispatch(expectedMalformed)
    expect(currentOutcome.ok).toBe(false)
    expect(currentOutcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('image.compositorRecipeInvalid')
    expect(malformedCurrent.revision).toBe(0)

    const malformedReplacement = new DocumentStore(document(compositorGraph()), compositorRegistry())
    const replacementOutcome = malformedReplacement.dispatch({
      ...compositorInvocation,
      params: { ...compositorInvocation.params, recipe: { version: 2, documentDigest: null, commands: [], extra: true } },
    })
    expect(replacementOutcome.ok).toBe(false)
    expect(malformedReplacement.revision).toBe(0)
  })

  it('requires a direct concrete COMPOSITOR input in the selected graph occurrence', () => {
    const wrongWidget = {
      ...compositorSchema,
      items: [{ ...compositorSchema.items[0]!, widget: { widgetType: 'STRING', options: {} } }],
    } as NodeSchema
    expect(new DocumentStore(document(compositorGraph()), compositorRegistry(wrongWidget))
      .dispatch(compositorInvocation).ok).toBe(false)

    const wrongType = {
      ...compositorSchema,
      items: [{ ...compositorSchema.items[0]!, type: { kind: 'concrete', name: 'STRING' } }],
    } as NodeSchema
    expect(new DocumentStore(document(compositorGraph()), compositorRegistry(wrongType))
      .dispatch(compositorInvocation).ok).toBe(false)

    const invalidOccurrence = {
      ...compositorInvocation,
      params: { ...compositorInvocation.params, instancePath: ['missing'] },
    }
    expect(new DocumentStore(document(compositorGraph()), compositorRegistry())
      .dispatch(invalidOccurrence).ok).toBe(false)

    const base = compositorGraph()
    const promoted: GraphDef = {
      ...base,
      nodes: { ...base.nodes, compositor: { ...base.nodes.compositor!, type: '#body' } },
    }
    expect(new DocumentStore(document(promoted), coreCommandRegistry([], () => compositorSchema))
      .dispatch(compositorInvocation).ok).toBe(false)
  })

  it('rejects definition link and net drivers', () => {
    const base = compositorGraph()
    const linked: GraphDef = {
      ...base,
      links: { link: {
        id: asLinkId('link'),
        from: { node: asNodeId('source'), port: asPortId('out') },
        to: { node: asNodeId('compositor'), port: asPortId('compositor') },
      } },
    }
    const linkedTarget = new DocumentStore(document(linked), compositorRegistry())
    expect(linkedTarget.dispatch(compositorInvocation).ok).toBe(false)
    expect(linkedTarget.revision).toBe(0)

    const netDriven: GraphDef = {
      ...base,
      nets: { net: {
        id: asNetId('net'),
        name: 'Recipe',
        source: { node: asNodeId('source'), port: asPortId('out') },
        sinks: [{ node: asNodeId('compositor'), port: asPortId('compositor') }],
      } },
    }
    const netTarget = new DocumentStore(document(netDriven), compositorRegistry())
    expect(netTarget.dispatch(compositorInvocation).ok).toBe(false)
    expect(netTarget.revision).toBe(0)
  })
})
