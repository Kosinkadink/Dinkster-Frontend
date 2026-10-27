/**
 * Authored workflow preservation and schema-arrival diagnostics.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DinksterNodesPayload } from '@dinkster/core'
import type { ObjectInfoEntry } from '@dinkster/core/comfy-v1'
import { buildDinksterRegistry } from '@dinkster/client'
import { AppState, type Tab } from '../src/app-state.js'
import { buildSchemaRegistry } from '../src/v1-connection-kind.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const root = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const objectInfo = JSON.parse(readFileSync(join(root, 'fixtures/object_info.json'), 'utf8')) as Record<
  string,
  ObjectInfoEntry
>

let app: AppState

beforeEach(() => {
  app = new AppState()
})

/** Put the fixture schemas on the default backend (fires backendsTick). */
const loadSchemas = (): void => {
  const backend = app.backends.get()[0]!
  backend.registry.set(buildSchemaRegistry(backend.id, objectInfo))
}

/** Minimal native document: one root graph with the given nodes and topology. */
const docJson = (
  lineage: string,
  nodes: Record<string, { type: string; values?: Record<string, unknown> }>,
  links: Record<string, unknown> = {},
  nets: Record<string, unknown> = {},
): unknown => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage,
  root: 'g0',
  graphs: {
    g0: {
      id: 'g0',
      name: 'root',
      nodes: Object.fromEntries(
        Object.entries(nodes).map(([id, n]) => [id, { id, type: n.type, values: n.values ?? {} }]),
      ),
      links,
      nets,
      reroutes: {},
      nextOrdinal: 99,
    },
  },
  view: { graphs: { g0: { nodes: {} } } },
  meta: { title: lineage },
})

/** Historical metadata must not rewrite an authored node. */
const renameRule = {
  from: 'OldEmpty',
  note: 'renamed',
  cases: [
    {
      to: 'EmptyLatentImage',
      inputs: {
        width: { kind: 'copy', input: 'width' },
        height: { kind: 'copy', input: 'height' },
        batch_size: { kind: 'copy', input: 'batch_size' },
      },
      outputs: { out0: 'out0' },
    },
  ],
}

const nodeType = (tab: Tab, id: string): string | undefined =>
  tab.store.doc.graphs[tab.store.doc.root]!.nodes[id]?.type

describe('schema arrival without replacements', () => {
  it('ignores embedded replacement metadata in a constructed registry', () => {
    expect(app.openDocument(docJson('embedded-rules', {
      old: { type: 'OldEmpty', values: { width: 768, height: 320 } },
    }), 'T')).toEqual([])
    const tab = app.activeTab()!
    const authored = structuredClone(tab.store.doc)
    const backend = app.backends.get()[0]!
    const registry = buildSchemaRegistry(backend.id, objectInfo)
    const successor = {
      ...registry.schemas.get('EmptyLatentImage')!,
      replacements: [renameRule],
    }
    backend.registry.set({
      ...registry,
      schemas: new Map([...registry.schemas, [successor.type, successor]]),
    })
    expect(tab.store.doc).toEqual(authored)
    expect(tab.store.revision).toBe(0)
    expect(app.problems.get().some((entry) => entry.code === 'replace.applied')).toBe(false)
  })

  it('reports unresolved nodes when schemas arrive without rewriting the document', () => {
    expect(app.openDocument(docJson('deferred-diagnostics', {
      old: { type: 'OldEmpty', values: { width: 768, height: 320 } },
    }), 'T')).toEqual([])
    const tab = app.activeTab()!
    const authored = structuredClone(tab.store.doc)
    expect(app.problems.get().some((entry) => entry.code === 'schema.unresolvedType')).toBe(false)
    loadSchemas()
    expect(tab.store.doc).toEqual(authored)
    expect(tab.store.canUndo).toBe(false)
    expect(app.problems.get()).toContainEqual(expect.objectContaining({
      code: 'schema.unresolvedType', message: expect.stringContaining('OldEmpty'),
    }))
  })
})

// ---------------------------------------------------------------------------
// Native backends: authored identities + unresolved-type surfacing
// ---------------------------------------------------------------------------

const nodesPayload = JSON.parse(readFileSync(join(root, 'fixtures/dinkster-nodes-comfy.json'), 'utf8')) as DinksterNodesPayload
const dynamicTargetFixture = JSON.parse(readFileSync(
  join(root, 'fixtures/replacements/dynamic-target.json'),
  'utf8',
)) as { schemas: Array<Record<string, unknown> & { nodeType: string }> }

const maintainedAliasPayload = (
  records: readonly {
    readonly nodeClass: string
    readonly sourceType: string
    readonly mappingKind?: 'op' | 'family'
    readonly mapOutput?: boolean
  }[],
): DinksterNodesPayload => {
  const raw = structuredClone(nodesPayload) as any
  const sourceSchemas = records.map(({ sourceType }) => {
    const source = structuredClone(raw.nodes['comfy.EmptyImage'])
    source.nodeType = sourceType
    delete source.aliases
    delete source.pack
    delete source.signature
    return source
  })
  raw.packs.comfy.comfyAliases = {
    format: 'dinkster-comfy-alias/1',
    sourceSchemas,
    records: records.map(({ nodeClass, sourceType, mappingKind = 'op', mapOutput = true }) => ({
      id: `comfy_alias:comfy-core/${nodeClass}`,
      mappingKind,
      carrier: 'comfy.EmptyImage',
      source: {
        pack: 'comfy-core',
        nodeClass,
        nodeType: sourceType,
        revision: 'b78cec87',
      },
      replacement: {
        from: sourceType,
        cases: [{
          to: 'comfy.EmptyImage',
          inputs: {
            width: { kind: 'copy', input: 'width' },
            height: { kind: 'copy', input: 'height' },
            batch_size: { kind: 'copy', input: 'batch_size' },
            color: { kind: 'copy', input: 'color' },
          },
          ...(mapOutput ? { outputs: { image: 'image' } } : {}),
        }],
      },
      confidence: {
        tier: mappingKind === 'op' ? 'exact' : 'parametric',
        evidence: [`tests/${nodeClass}.json`],
      },
      ...(mappingKind === 'family' ? { family: { id: 'image', provider: 'missing-provider' } } : {}),
    })),
  }
  return raw as DinksterNodesPayload
}

const maintainedGroupPayload = (): DinksterNodesPayload => {
  const raw = structuredClone(nodesPayload) as any
  const source = (nativeType: 'comfy.EmptyImage' | 'comfy.PreviewImage', nodeType: string): any => {
    const schema = structuredClone(raw.nodes[nativeType])
    schema.nodeType = nodeType
    delete schema.aliases
    delete schema.pack
    delete schema.signature
    return schema
  }
  const emptyType = 'comfy_group_source:comfy-core/EmptyImage'
  const previewType = 'comfy_group_source:comfy-core/PreviewImage'
  const groupType = 'comfy-group.comfy-core.empty-image-preview'
  const groupSchema = source('comfy.EmptyImage', groupType)
  groupSchema.interface = groupSchema.interface.filter((item: { role: string }) => item.role === 'input')
  raw.packs.comfy.comfyGroups = {
    format: 'dinkster-comfy-group/1',
    sourceSchemas: [
      source('comfy.EmptyImage', emptyType),
      source('comfy.PreviewImage', previewType),
    ],
    groupSchemas: [groupSchema],
    records: [{
      id: 'comfy_group:comfy-core/empty-image-preview',
      mappingKind: 'op',
      carrier: 'comfy.EmptyImage',
      source: { pack: 'comfy-core', name: 'empty-image-preview', revision: 'b78cec87' },
      pattern: {
        groupType,
        anchor: 'preview',
        nodes: {
          image: {
            source: { pack: 'comfy-core', nodeClass: 'EmptyImage', nodeType: emptyType, revision: 'b78cec87' },
            mode: 'active',
          },
          preview: {
            source: { pack: 'comfy-core', nodeClass: 'PreviewImage', nodeType: previewType, revision: 'b78cec87' },
            mode: 'active',
          },
        },
        edges: [{ from: 'image:image', to: 'preview:images' }],
        disconnected: [],
        boundary: { inputs: {}, outputs: {} },
        parameters: {
          width: 'image:width',
          height: 'image:height',
          batch_size: 'image:batch_size',
          color: 'image:color',
        },
        constants: {},
      },
      replacement: {
        from: groupType,
        cases: [{
          to: 'comfy.EmptyImage',
          inputs: {
            width: { kind: 'copy', input: 'width' },
            height: { kind: 'copy', input: 'height' },
            batch_size: { kind: 'copy', input: 'batch_size' },
            color: { kind: 'copy', input: 'color' },
          },
        }],
      },
      confidence: { tier: 'grouped', evidence: ['tests/empty-image-preview.json'] },
    }],
  }
  return raw as DinksterNodesPayload
}

const maintainedDynamicGroupPayload = (): DinksterNodesPayload => {
  const raw = structuredClone(nodesPayload) as any
  const fixtureSchema = (type: string): any => structuredClone(
    dynamicTargetFixture.schemas.find((schema) => schema.nodeType === type)!,
  )
  const native = (schema: any): any => ({
    ...schema,
    pack: 'comfy',
    aliases: [],
    signature: '0000000000000000000000000000000000000000',
  })
  const maskType = { kind: 'concrete', types: ['comfy.MASK'] }
  const input = (id: string, required: boolean, defaultValue?: string): any => ({
    role: 'input',
    id,
    type: maskType,
    required,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  })
  const polarityInput = (): any => ({
    role: 'input',
    id: 'mask_polarity',
    type: { kind: 'concrete', types: ['STRING'] },
    required: false,
    default: 'white',
  })
  const output = (id: string): any => ({ role: 'output', id, type: maskType })
  const sourceType = 'comfy.fixture.MaskSource'
  const passType = 'comfy_group_source:fixture-group/MaskPass'
  const sinkType = 'comfy_group_source:fixture-group/MaskSink'
  const groupType = 'comfy-group.fixture-group.mask-chain'
  const sourceSchema = fixtureSchema('fixture.mask-source')
  sourceSchema.nodeType = sourceType
  const passSchema = {
    schemaVersion: 1,
    nodeType: passType,
    displayName: 'Mask Pass',
    category: 'fixture',
    interface: [input('mask', true), polarityInput(), output('mask')],
  }
  const sinkSchema = {
    schemaVersion: 1,
    nodeType: sinkType,
    displayName: 'Mask Sink',
    category: 'fixture',
    interface: [input('mask', true)],
  }
  const groupSchema = {
    schemaVersion: 1,
    nodeType: groupType,
    displayName: 'Mask Chain',
    category: 'fixture',
    interface: [input('mask', true), polarityInput()],
  }
  raw.dinkster.schemaWire = 1
  raw.nodes = {}
  raw.nodes['fixture.mask-source'] = native(fixtureSchema('fixture.mask-source'))
  raw.nodes['fixture.slot-modern'] = native(fixtureSchema('fixture.slot-modern'))
  raw.packs.comfy.comfyAliases = {
    format: 'dinkster-comfy-alias/1',
    sourceSchemas: [sourceSchema],
    records: [{
      id: 'comfy_alias:fixture-source/MaskSource',
      mappingKind: 'op',
      carrier: 'fixture.mask-source',
      source: {
        pack: 'fixture-source',
        nodeClass: 'MaskSource',
        nodeType: sourceType,
        revision: 'fixture-v1',
      },
      replacement: {
        from: sourceType,
        cases: [{ to: 'fixture.mask-source', outputs: { mask: 'mask' } }],
      },
      confidence: { tier: 'exact', evidence: ['tests/mask-source.json'] },
    }],
  }
  raw.packs.comfy.comfyGroups = {
    format: 'dinkster-comfy-group/1',
    sourceSchemas: [passSchema, sinkSchema],
    groupSchemas: [groupSchema],
    records: [{
      id: 'comfy_group:fixture-group/mask-chain',
      mappingKind: 'op',
      carrier: 'fixture.slot-modern',
      source: { pack: 'fixture-group', name: 'mask-chain', revision: 'fixture-v1' },
      pattern: {
        groupType,
        anchor: 'sink',
        nodes: {
          pass: {
            source: {
              pack: 'fixture-group',
              nodeClass: 'MaskPass',
              nodeType: passType,
              revision: 'fixture-v1',
            },
            mode: 'active',
          },
          sink: {
            source: {
              pack: 'fixture-group',
              nodeClass: 'MaskSink',
              nodeType: sinkType,
              revision: 'fixture-v1',
            },
            mode: 'active',
          },
        },
        edges: [{ from: 'pass:mask', to: 'sink:mask' }],
        disconnected: [],
        boundary: { inputs: { mask: 'pass:mask' }, outputs: {} },
        parameters: { mask_polarity: 'pass:mask_polarity' },
        constants: {},
      },
      replacement: {
        from: groupType,
        cases: [{
          to: 'fixture.slot-modern',
          slotVariants: { mask: 'mask' },
          inputs: {
            mask: { kind: 'link', input: 'mask' },
            'mask.mask_polarity': { kind: 'copy', input: 'mask_polarity' },
          },
        }],
      },
      confidence: { tier: 'grouped', evidence: ['tests/mask-chain.json'] },
    }],
  }
  return raw as DinksterNodesPayload
}

const maintainedTiledGroupPayload = (): DinksterNodesPayload => {
  const raw = structuredClone(nodesPayload) as any
  const concrete = (type: string): any => ({ kind: 'concrete', types: [type] })
  const input = (id: string, type: string, defaultValue?: number | string): any => ({
    role: 'input',
    id,
    type: concrete(type),
    required: defaultValue === undefined,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  })
  const output = (id: string, type: string): any => ({ role: 'output', id, type: concrete(type) })
  const nativeType = 'comfy.TiledUpscale'
  const splitType = 'comfy_group_source:comfy-core/ImageTileSplit'
  const scaleType = 'comfy_group_source:comfy-core/ImageScaleBy'
  const mergeType = 'comfy_group_source:comfy-core/ImageTileMerge'
  const groupType = 'comfy-group.comfy-core.tiled-upscale'
  const imageInput = input('image', 'comfy.IMAGE')
  const imageOutput = output('image', 'comfy.IMAGE')
  const native = structuredClone(raw.nodes['comfy.EmptyImage'])
  native.nodeType = nativeType
  native.displayName = 'Tiled Upscale'
  native.interface = [imageInput, input('tile_size', 'INT', 512), input('scale_by', 'FLOAT', 2), imageOutput]
  native.aliases = []
  native.signature = '0000000000000000000000000000000000000000'
  raw.nodes[nativeType] = native
  const source = (nodeType: string, items: readonly any[]): any => {
    const schema = structuredClone(native)
    schema.nodeType = nodeType
    schema.interface = items
    delete schema.aliases
    delete schema.pack
    delete schema.signature
    return schema
  }
  raw.packs.comfy.comfyGroups = {
    format: 'dinkster-comfy-group/1',
    sourceSchemas: [
      source(splitType, [imageInput, input('tile_size', 'INT', 512), output('tiles', 'comfy.IMAGE')]),
      source(scaleType, [
        imageInput,
        input('upscale_method', 'STRING', 'nearest-exact'),
        input('scale_by', 'FLOAT', 2),
        imageOutput,
      ]),
      source(mergeType, [input('tiles', 'comfy.IMAGE'), input('overlap', 'INT', 32), imageOutput]),
    ],
    groupSchemas: [source(groupType, native.interface)],
    records: [{
      id: 'comfy_group:comfy-core/tiled-upscale',
      mappingKind: 'op',
      carrier: nativeType,
      source: { pack: 'comfy-core', name: 'tiled-upscale', revision: 'b78cec87' },
      pattern: {
        groupType,
        anchor: 'merge',
        nodes: {
          split: {
            source: { pack: 'comfy-core', nodeClass: 'ImageTileSplit', nodeType: splitType, revision: 'b78cec87' },
            mode: 'active',
          },
          upscale: {
            source: { pack: 'comfy-core', nodeClass: 'ImageScaleBy', nodeType: scaleType, revision: 'b78cec87' },
            mode: 'active',
          },
          merge: {
            source: { pack: 'comfy-core', nodeClass: 'ImageTileMerge', nodeType: mergeType, revision: 'b78cec87' },
            mode: 'active',
          },
        },
        edges: [
          { from: 'split:tiles', to: 'upscale:image' },
          { from: 'upscale:image', to: 'merge:tiles' },
        ],
        disconnected: [],
        boundary: { inputs: { image: 'split:image' }, outputs: { image: 'merge:image' } },
        parameters: { tile_size: 'split:tile_size', scale_by: 'upscale:scale_by' },
        constants: { 'upscale:upscale_method': 'nearest-exact', 'merge:overlap': 32 },
      },
      replacement: {
        from: groupType,
        cases: [{
          to: nativeType,
          inputs: {
            image: { kind: 'copy', input: 'image' },
            tile_size: { kind: 'copy', input: 'tile_size' },
            scale_by: { kind: 'copy', input: 'scale_by' },
          },
          outputs: { image: 'image' },
        }],
      },
      confidence: { tier: 'grouped', evidence: ['tests/tiled-upscale.json'] },
    }],
  }
  return raw as DinksterNodesPayload
}

/** Put the native namespaced schemas on the default backend. */
const loadNativeSchemas = (): void => {
  const backend = app.backends.get()[0]!
  backend.registry.set(buildDinksterRegistry(backend.id, nodesPayload))
}

describe('legacy documents against a native backend', () => {
  it.each([
    ['alias', () => maintainedAliasPayload([{ nodeClass: 'EmptyImage', sourceType: 'comfy.LegacyEmptyImage' }]), 'comfy.LegacyEmptyImage'],
    ['group', maintainedGroupPayload, 'comfy-group.comfy-core.empty-image-preview'],
  ] as const)('does not upgrade authored nodes using a historical %s snapshot', (_kind, payload, sourceType) => {
    const backend = app.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, payload()))
    const authored = docJson('historical-snapshot', {
      source: { type: sourceType, values: { width: 61, height: 29, batch_size: 2, color: 7 } },
      sink: { type: 'comfy.PreviewImage' },
    }, {
      image: { id: 'image', from: { node: 'source', port: 'image' }, to: { node: 'sink', port: 'images' } },
    }) as { graphs: Record<string, unknown> }
    expect(app.openDocument(authored, 'Historical source')).toEqual([])
    const tab = app.activeTab()!
    expect(tab.store.doc.graphs).toEqual(authored.graphs)
    expect(tab.store.revision).toBe(0)
    expect(app.problems.get()).toContainEqual(expect.objectContaining({
      code: 'schema.unresolvedType', message: expect.stringContaining(sourceType),
    }))
    expect(app.problems.get().some((problem) => problem.code.startsWith('replace.'))).toBe(false)
    expect(app.compileTab(tab)?.ok).toBe(false)
  })

  it('retains every authored node when a historical dynamic group catalog is present', () => {
    const backend = app.backends.get()[0]!
    const registry = buildDinksterRegistry(backend.id, maintainedDynamicGroupPayload())
    expect(registry.diagnostics).toEqual([])
    backend.registry.set(registry)
    const litegraph = {
      nodes: [
        {
          id: 1,
          type: 'MaskSource',
          outputs: [{ name: 'MASK', links: [1] }],
        },
        {
          id: 2,
          type: 'MaskPass',
          inputs: [{ name: 'mask', link: 1 }],
          outputs: [{ name: 'MASK', links: [2] }],
          widgets_values: ['white'],
        },
        {
          id: 3,
          type: 'MaskSink',
          inputs: [{ name: 'mask', link: 2 }],
        },
      ],
      links: [
        [1, 1, 0, 2, 0, 'MASK'],
        [2, 2, 0, 3, 0, 'MASK'],
      ],
      groups: [],
      version: 0.4,
    }

    expect(app.openDocument(litegraph, 'Dynamic maintained group')).toEqual([])
    const tab = app.activeTab()!
    expect(Object.keys(tab.store.doc.graphs.g0!.nodes).sort()).toEqual(['n1', 'n2', 'n3'])
    expect(nodeType(tab, 'n2')).toBe('MaskPass')
    expect(nodeType(tab, 'n3')).toBe('MaskSink')
    expect(tab.store.doc.graphs.g0!.links.l1).toMatchObject({
      from: { node: 'n1' },
      to: { node: 'n2' },
    })
    expect(tab.store.doc.graphs.g0!.links.l2).toMatchObject({
      from: { node: 'n2' },
      to: { node: 'n3' },
    })
    expect(app.problems.get()).not.toContainEqual(expect.objectContaining({
      code: 'import.comfyGroup.review',
    }))
    expect(app.problems.get()).not.toContainEqual(expect.objectContaining({
      code: 'replace.schemaAuthorityUnavailable',
    }))
  })

  it('does not collapse an exact historical group into a carrier', () => {
    const backend = app.backends.get()[0]!
    const registry = buildDinksterRegistry(backend.id, maintainedGroupPayload())
    backend.registry.set(registry)
    expect(registry).not.toHaveProperty('comfyGroups')

    const litegraph = {
      nodes: [
        {
          id: 1,
          type: 'EmptyImage',
          pos: [0, 0],
          outputs: [{ name: 'IMAGE', links: [1] }],
          widgets_values: [64, 32, 2, 7],
        },
        {
          id: 2,
          type: 'PreviewImage',
          pos: [300, 50],
          inputs: [{ name: 'images', link: 1 }],
        },
      ],
      links: [[1, 1, 0, 2, 0, 'IMAGE']],
      groups: [],
      version: 0.4,
    }
    expect(app.openDocument(litegraph, 'Maintained group')).toEqual([])
    const tab = app.activeTab()!
    expect(Object.keys(tab.store.doc.graphs.g0!.nodes)).toEqual(['n1', 'n2'])
    expect(nodeType(tab, 'n1')).toBe('EmptyImage')
    expect(nodeType(tab, 'n2')).toBe('PreviewImage')
    expect(tab.store.doc.graphs.g0!.nodes.n1!.ext?.['importer.rawWidgetValues']).toEqual([64, 32, 2, 7])
    expect(tab.store.doc.view.graphs.g0!.nodes.n2!.position).toEqual({ x: 300, y: 50 })
    expect(app.problems.get().some((problem) => problem.code.startsWith('import.comfyAlias.'))).toBe(false)
    expect(app.problems.get().some((problem) => problem.code === 'schema.unresolvedType' && problem.message.includes('EmptyImage'))).toBe(true)

    expect(tab.store.canUndo).toBe(false)
    expect(Object.values(tab.store.doc.graphs.g0!.links)).toEqual([
      { id: 'l1', from: { node: 'n1', port: 'IMAGE' }, to: { node: 'n2', port: 'images' } },
    ])
  })

  it('preserves a tiled-upscale chain instead of rewriting it to a carrier', () => {
    const backend = app.backends.get()[0]!
    const registry = buildDinksterRegistry(backend.id, maintainedTiledGroupPayload())
    backend.registry.set(registry)
    expect(registry).not.toHaveProperty('comfyGroups')

    const litegraph = {
      nodes: [
        {
          id: 1,
          type: 'EmptyImage',
          outputs: [{ name: 'IMAGE', links: [1] }],
          widgets_values: [64, 64, 1, 0],
        },
        {
          id: 2,
          type: 'ImageTileSplit',
          inputs: [{ name: 'image', link: 1 }],
          outputs: [{ name: 'TILES', links: [2] }],
          widgets_values: [512],
        },
        {
          id: 3,
          type: 'ImageScaleBy',
          inputs: [{ name: 'image', link: 2 }],
          outputs: [{ name: 'IMAGE', links: [3] }],
          widgets_values: ['nearest-exact', 2],
        },
        {
          id: 4,
          type: 'ImageTileMerge',
          pos: [600, 80],
          inputs: [{ name: 'tiles', link: 3 }],
          outputs: [{ name: 'IMAGE', links: [4] }],
          widgets_values: [32],
        },
        {
          id: 5,
          type: 'PreviewImage',
          inputs: [{ name: 'images', link: 4 }],
        },
      ],
      links: [
        [1, 1, 0, 2, 0, 'IMAGE'],
        [2, 2, 0, 3, 0, 'IMAGE'],
        [3, 3, 0, 4, 0, 'IMAGE'],
        [4, 4, 0, 5, 0, 'IMAGE'],
      ],
      groups: [],
      version: 0.4,
    }

    expect(app.openDocument(litegraph, 'Tiled upscale group')).toEqual([])
    const tab = app.activeTab()!
    expect(Object.keys(tab.store.doc.graphs.g0!.nodes).sort()).toEqual(['n1', 'n2', 'n3', 'n4', 'n5'])
    expect(nodeType(tab, 'n2')).toBe('ImageTileSplit')
    expect(nodeType(tab, 'n3')).toBe('ImageScaleBy')
    expect(nodeType(tab, 'n4')).toBe('ImageTileMerge')
    expect(tab.store.doc.view.graphs.g0!.nodes.n4!.position).toEqual({ x: 600, y: 80 })
    expect(Object.values(tab.store.doc.graphs.g0!.links)).toMatchObject([
      { id: 'l1', from: { node: 'n1' }, to: { node: 'n2' } },
      { id: 'l2', from: { node: 'n2' }, to: { node: 'n3' } },
      { id: 'l3', from: { node: 'n3' }, to: { node: 'n4' } },
      { id: 'l4', from: { node: 'n4' }, to: { node: 'n5' } },
    ])
    expect(Object.values(tab.store.doc.graphs.g0!.nodes).some((node) =>
      node.type.startsWith('comfy-group.') || node.type.startsWith('comfy_group_source:'))).toBe(false)

    expect(tab.store.canUndo).toBe(false)
  })

  it('retains the complete matched source graph without an automatic replacement pass', () => {
    const backend = app.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, maintainedGroupPayload()))
    const litegraph = {
      nodes: [
        {
          id: 1,
          type: 'EmptyImage',
          outputs: [{ name: 'IMAGE', links: [1] }],
          widgets_values: [64, 32, 2, 7],
        },
        {
          id: 2,
          type: 'PreviewImage',
          inputs: [{ name: 'images', link: 1 }],
        },
      ],
      links: [[1, 1, 0, 2, 0, 'IMAGE']],
      groups: [],
      version: 0.4,
    }

    expect(app.openDocument(litegraph, 'Held group')).toEqual([])
    const tab = app.activeTab()!
    expect(Object.keys(tab.store.doc.graphs.g0!.nodes).sort()).toEqual(['n1', 'n2'])
    expect(Object.values(tab.store.doc.graphs.g0!.nodes).some((node) =>
      node.type.startsWith('comfy-group.'))).toBe(false)
    expect(tab.store.revision).toBe(0)
    expect(app.problems.get().some((problem) => problem.code === 'import.comfyGroup.review')).toBe(false)
  })

  it('leaves a class missing from the ordinary registry unresolved instead of using a carrier snapshot', () => {
    const payload = maintainedAliasPayload([
      { nodeClass: 'EmptyImage', sourceType: 'comfy.LegacyEmptyImage' },
      {
        nodeClass: 'FamilyImage',
        sourceType: 'comfy.FamilyImage',
        mappingKind: 'family',
      },
    ])
    const backend = app.backends.get()[0]!
    const registry = buildDinksterRegistry(backend.id, payload)
    backend.registry.set(registry)
    expect(registry.resolve('comfy.LegacyEmptyImage')).toBeUndefined()
    expect(registry).not.toHaveProperty('comfyAliases')
    expect(registry.resolve('comfy.EmptyImage')?.searchTerms ?? []).not.toContain('FamilyImage')

    const litegraph = {
      nodes: [
        { id: 1, type: 'EmptyImage', pos: [0, 0], widgets_values: [64, 64, 1, 0] },
        { id: 2, type: 'FamilyImage', pos: [300, 0], widgets_values: [32, 32, 1, 0] },
      ],
      links: [],
      groups: [],
      version: 0.4,
    }
    expect(app.openDocument(litegraph, 'Maintained aliases')).toEqual([])
    const tab = app.activeTab()!
    expect(nodeType(tab, 'n1')).toBe('EmptyImage')
    expect(nodeType(tab, 'n2')).toBe('FamilyImage')
    expect(tab.store.doc.graphs.g0!.nodes.n1!.ext?.['importer.rawWidgetValues']).toEqual([64, 64, 1, 0])
    expect(app.problems.get().some((problem) => problem.code.startsWith('import.comfyAlias.'))).toBe(false)
    expect(app.problems.get().some((problem) => problem.code === 'schema.unresolvedType' && problem.message.includes('FamilyImage'))).toBe(true)
  })

  it('does not create a maintained alias review cohort during ordinary import', () => {
    const payload = maintainedAliasPayload([
      { nodeClass: 'EmptyImage', sourceType: 'comfy.LegacyEmptyImage' },
      {
        nodeClass: 'UnsafeImage',
        sourceType: 'comfy.UnsafeImage',
        mapOutput: false,
      },
    ])
    const backend = app.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, payload))
    const litegraph = {
      nodes: [
        { id: 1, type: 'EmptyImage', pos: [0, 0], widgets_values: [64, 64, 1, 0] },
        {
          id: 2,
          type: 'UnsafeImage',
          pos: [300, 0],
          outputs: [{ name: 'IMAGE', links: [1] }],
          widgets_values: [32, 32, 1, 0],
        },
        {
          id: 3,
          type: 'PreviewImage',
          pos: [600, 0],
          inputs: [{ name: 'images', link: 1 }],
        },
      ],
      links: [[1, 2, 0, 3, 0, 'IMAGE']],
      groups: [],
      version: 0.4,
    }
    expect(app.openDocument(litegraph, 'Atomic aliases')).toEqual([])
    const tab = app.activeTab()!
    expect(nodeType(tab, 'n1')).toBe('EmptyImage')
    expect(nodeType(tab, 'n2')).toBe('UnsafeImage')
    expect(app.problems.get().filter((problem) => problem.code === 'replace.review')).toHaveLength(0)
    expect(app.problems.get().some((problem) => problem.code === 'schema.unresolvedType' && problem.message.includes('UnsafeImage'))).toBe(true)
  })

  it('keeps unresolved LiteGraph class identities instead of resolving schema aliases', () => {
    loadNativeSchemas()
    const litegraph = {
      nodes: [
        {
          id: 1,
          type: 'EmptyImage',
          pos: [0, 0],
          outputs: [{ name: 'IMAGE', links: [1] }],
          widgets_values: [64, 64, 1, 0],
        },
        {
          id: 2,
          type: 'PreviewImage',
          pos: [300, 0],
          inputs: [{ name: 'images', link: 1 }],
        },
      ],
      links: [[1, 1, 0, 2, 0, 'IMAGE']],
      groups: [],
      version: 0.4,
    }
    expect(app.openDocument(litegraph, 'LiteGraph aliases')).toEqual([])
    const tab = app.activeTab()!
    expect(nodeType(tab, 'n1')).toBe('EmptyImage')
    expect(nodeType(tab, 'n2')).toBe('PreviewImage')
    expect(tab.store.doc.graphs.g0!.nodes.n1!.ext?.['importer.rawWidgetValues']).toEqual([64, 64, 1, 0])
    expect(tab.store.doc.graphs.g0!.links.l1).toMatchObject({
      from: { node: 'n1', port: 'IMAGE' },
      to: { node: 'n2', port: 'images' },
    })
    expect(tab.store.revision).toBe(0)
    expect(app.problems.get().map((problem) => problem.code)).not.toContain('replace.applied')
    expect(app.compileTab(tab)?.ok).toBe(false)
  })

  it('preserves authored bare types and positional output ids without a migration', () => {
    loadNativeSchemas()
    const json = docJson(
      'lin-legacy',
      { n0: { type: 'EmptyImage', values: { width: 64 } }, n1: { type: 'PreviewImage' } },
      { l2: { id: 'l2', from: { node: 'n0', port: 'out0' }, to: { node: 'n1', port: 'images' } } },
    )
    expect(app.openDocument(json, 'Legacy')).toEqual([])
    const tab = app.activeTab()!
    expect(nodeType(tab, 'n0')).toBe('EmptyImage')
    expect(nodeType(tab, 'n1')).toBe('PreviewImage')
    expect(tab.store.doc.graphs.g0!.links.l2!.from).toEqual({ node: 'n0', port: 'out0' })
    expect(tab.store.doc.graphs.g0!.nodes.n0!.values).toEqual({ width: 64 })
    expect(tab.store.revision).toBe(0)
    expect(app.problems.get().some((d) => d.code === 'replace.applied')).toBe(false)
    const result = app.compileTab(tab)
    expect(result?.ok).toBe(false)
  })

  it('reports stock seed classes absent from the exact native registry without upgrading them', () => {
    loadNativeSchemas()
    const codes = app.problems.get().map((d) => d.code)
    expect(codes).not.toContain('replace.applied')
    expect(codes).not.toContain('replace.review')
    expect(codes).toContain('schema.unresolvedType')
  })

  it('does not rewrite stock seed identities or create a migration undo step', () => {
    const documents = app.tabs.get().map((tab) => tab.store.doc)
    loadNativeSchemas()
    for (const [index, tab] of app.tabs.get().entries()) {
      expect(tab.store.doc).toEqual(documents[index])
      expect(tab.store.canUndo).toBe(false)
    }
  })

  it('retargeting a stock seed to native does not rewrite its document', () => {
    loadSchemas()
    const tab = app.tabs.get()[0]!
    const document = tab.store.doc
    expect(nodeType(tab, 'n0')).toBe('EmptyImage')
    expect(app.problems.get().map((d) => d.code)).not.toContain('replace.applied')
    const native = app.addBackend('http://native.test', 'native', false, 'dinkster')!
    native.registry.set(buildDinksterRegistry(native.id, nodesPayload))
    app.setTabTarget(tab.id, native.id)
    expect(tab.store.doc).toEqual(document)
    expect(nodeType(tab, 'n0')).toBe('EmptyImage')
    expect(nodeType(tab, 'n1')).toBe('PreviewImage')
    expect(tab.store.canUndo).toBe(false)
    expect(app.problems.get().map((d) => d.code)).not.toContain('replace.applied')
  })

  it('a persisted stock seed retains authored identities in a later native session', () => {
    const g = globalThis as { localStorage?: Storage }
    const map = new Map<string, string>()
    g.localStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size
      },
    } as Storage
    try {
      const first = new AppState()
      const firstBackend = first.backends.get()[0]!
      firstBackend.registry.set(buildSchemaRegistry(firstBackend.id, objectInfo))
      first.flushPersistTabs()
      const second = new AppState()
      const backend = second.backends.get()[0]!
      backend.registry.set(buildDinksterRegistry(backend.id, nodesPayload))
      const tab = second.tabs.get()[0]!
      expect(tab.store.doc.graphs[tab.store.doc.root]!.nodes.n0!.type).toBe('EmptyImage')
      expect(tab.store.canUndo).toBe(false)
      expect(second.problems.get().map((d) => d.code)).not.toContain('replace.applied')
    } finally {
      delete g.localStorage
    }
  })

  it('an edit made before schemas arrive stays intact without a synthesized migration', () => {
    const tab = app.tabs.get()[0]!
    const outcome = tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'n0', inputId: 'width', value: 128 },
    })
    expect(outcome.ok).toBe(true)
    expect(tab.store.revision).toBeGreaterThan(0)
    const document = tab.store.doc
    const revision = tab.store.revision
    loadNativeSchemas()
    expect(tab.store.doc).toEqual(document)
    expect(tab.store.revision).toBe(revision)
    expect(app.problems.get().some((d) => d.code === 'replace.applied')).toBe(false)
    expect(tab.store.canUndo).toBe(true)
  })
})

describe('unresolved-type reporting', () => {
  it('a type the backend lacks lands in Problems naming type, count, and backend', () => {
    loadNativeSchemas()
    expect(
      app.openDocument(docJson('lin-missing', { a: { type: 'NoSuchNode' }, b: { type: 'NoSuchNode' } }), 'T'),
    ).toEqual([])
    const found = app.problems.get().find((d) => d.code === 'schema.unresolvedType' && d.message.includes('NoSuchNode'))
    expect(found).toBeDefined()
    expect(found!.message).toContain("'NoSuchNode'")
    expect(found!.message).toContain('2 node(s)')
    // Unresolved nodes are excluded from the executed closure (see compile's
    // unknown-schema demotion); the warning must not claim the workflow cannot run.
    expect(found!.message).toContain('excluded from execution')
    expect(found!.message).not.toContain('cannot run')
  })

  it('reports once per open, not again on later backend ticks', () => {
    loadNativeSchemas()
    expect(app.openDocument(docJson('lin-once', { a: { type: 'NoSuchNode' } }), 'T')).toEqual([])
    const count = () => app.problems.get().filter((d) => d.code === 'schema.unresolvedType' && d.message.includes('NoSuchNode')).length
    expect(count()).toBe(1)
    app.backendsTick.update((v) => v + 1)
    expect(count()).toBe(1)
  })

  it('does not report exact registered node IDs as unresolved', () => {
    loadNativeSchemas()
    const before = app.problems.get().filter((d) => d.code === 'schema.unresolvedType')
    expect(
      app.openDocument(docJson('lin-exact', { a: { type: 'comfy.EmptyImage' } }), 'T'),
    ).toEqual([])
    expect(app.problems.get().filter((d) => d.code === 'schema.unresolvedType')).toEqual(before)
  })
})
