import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { compositorRecipeFingerprint, EMPTY_COMPOSITOR_RECIPE, type CompositorRecipe } from '../src/compositor.js'
import { DocumentStore } from '../src/commands/store.js'
import type { GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asNodeId } from '../src/ids.js'
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

})

const compositorSchema: NodeSchema = {
  type: 'dinkster.image.image_compositor',
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
      type: 'dinkster.image.image_compositor',
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

})
