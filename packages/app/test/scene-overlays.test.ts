import { describe, expect, it, vi } from 'vitest'
import {
  BYPASSED_BADGE,
  DEPRECATED_BADGE,
  executionErrorBadge,
  LOG_INFO_BADGE,
  logWarningBadge,
  MUTED_BADGE,
  PROBLEM_BLOCKING_WARNING_BADGE,
  PROBLEM_ERROR_BADGE,
  PROBLEM_WARNING_BADGE,
  SUBGRAPH_BADGE,
  type Scene,
} from '@dinkster/canvas'
import { asGraphDefId, asLinkId, asNodeId, asPortId, parseDinksterNodes, type CompileArtifact, type GraphDef, type NodeDecorationContribution, type NodeSchema, type PreviewRenderer, type ReplacementScanItem, type WorkflowDocument } from '@dinkster/core'
import type { ExecutionState } from '@dinkster/client'
import { createWidgetRegistry, registerCoreWidgets, widgetRegistrationDoors } from '@dinkster/widgets'
import { applyNodeDecorations, deriveSceneOverlays, representedPreviewAssetForNode, retainProvenExecution, selectedPreviewAssetForNode } from '../src/scene-overlays.js'
import type { PreviewLoader, PreviewSource } from '../src/node-previews.js'

// The derivation reads scene.nodes (id/isSubgraph/node.type), execution
// nodes/outputs/previews/artifact, and schema type/pack/deprecation;
// fixtures carry exactly those (cast through unknown - full scenes would
// drag in layout/link state irrelevant to overlay content).
const scene = (nodes: { id: string; type?: string; isSubgraph?: boolean; regionKind?: 'map' | 'fold' | 'while'; mode?: 'active' | 'muted' | 'bypassed' }[]): Scene =>
  ({
    nodes: nodes.map((n) => ({
      id: n.id,
      isSubgraph: n.isSubgraph ?? false,
      regionKind: n.regionKind,
      node: { type: n.type ?? 'core.plain', values: {}, mode: n.mode },
    })),
  }) as unknown as Scene

const exec = (over: Partial<Record<string, unknown>> = {}): ExecutionState =>
  ({ nodes: {}, outputs: {}, artifacts: [], previews: {}, activities: [], logs: [], errors: [], ...over }) as unknown as ExecutionState

/** A run error report entry anchored to one occurrence. */
const runError = (node: string, instancePath: readonly string[] = [], over: Record<string, unknown> = {}) =>
  ({ severity: 'error', origin: 'runtime', code: 'runtime.X', message: 'failed', anchor: { occurrence: { instancePath, node } }, ...over })

const modeDecoration: NodeDecorationContribution = {
  id: 'core.node.mode',
  decorate: (node) => node.mode === 'muted'
    ? { badges: [MUTED_BADGE] }
    : node.mode === 'bypassed'
      ? { badges: [BYPASSED_BADGE] }
      : undefined,
}

const schemaTable = (schemas: Record<string, { pack?: string; deprecation?: { message: string }; executionArms?: readonly ('native' | 'comfyui')[] }>) => {
  return (type: string): NodeSchema | undefined =>
    schemas[type] ? ({ type, ...schemas[type] } as unknown as NodeSchema) : undefined
}

const noLoader: PreviewLoader = {
  sourceFor: () => undefined,
  peekSource: () => undefined,
  resolve: () => undefined,
}

const previewRegistry = createWidgetRegistry()
registerCoreWidgets(widgetRegistrationDoors(previewRegistry))

const base = {
  scene: scene([]),
  exec: undefined,
  graphId: 'g0',
  doc: undefined,
  def: undefined,
  instancePath: [] as readonly string[],
  frozen: false,
  exactProducer: undefined,
  replacements: [] as readonly ReplacementScanItem[],
  resolveSchema: undefined,
  previewRendererFor: previewRegistry.previewRendererFor,
  loader: noLoader,
  values: undefined,
}

const scalarExpressionRegistry = () => parseDinksterNodes({
  schemaVersion: 1,
  nodes: {
    'e2e.identity.int': {
      schemaVersion: 1,
      nodeType: 'e2e.identity.int',
      version: 1,
      displayName: 'Integer',
      category: 'test',
      interface: [
        {
          role: 'input', id: 'source', required: false,
          type: { kind: 'concrete', types: ['core.int'] }, default: 0,
        },
        {
          role: 'output', id: 'result',
          type: { kind: 'concrete', types: ['core.int'] },
          knownValue: { input: 'source' },
        },
      ],
    },
    'dinkster.math.expression': {
      schemaVersion: 1,
      nodeType: 'dinkster.math.expression',
      version: 1,
      displayName: 'Math Expression',
      category: 'math',
      interface: [
        {
          role: 'input', id: 'expression', required: true,
          type: { kind: 'concrete', types: ['core.string'] },
          default: 'a + b', widget: { type: 'STRING', multiline: true },
        },
        {
          role: 'inputFamily', id: 'values', required: true, minMembers: 1,
          memberNames: 'abcdefghijklmnopqrstuvwxyz'.split(''),
          template: [{
            role: 'input', id: 'value', required: true,
            type: { kind: 'union', types: ['core.float', 'core.int', 'core.boolean'] },
          }],
        },
        { role: 'output', id: 'float', type: { kind: 'concrete', types: ['core.float'] } },
        { role: 'output', id: 'int', type: { kind: 'concrete', types: ['core.int'] } },
        { role: 'output', id: 'boolean', type: { kind: 'concrete', types: ['core.boolean'] } },
      ],
      mirror: {
        kind: 'expression', precision: 'bounded',
        tolerance: { relative: 1e-12 }, grammarVersion: 1,
      },
    },
  },
})

describe('selected asset preview qualification', () => {
  const node = (stored: unknown) => ({
    node: { values: { image: stored } },
    layout: { rows: [{ kind: 'widget', valueKey: 'image', spec: { widgetType: 'ASSET' } }] },
  }) as unknown as Scene['nodes'][number]
  const image = (digit: string) => ({ digest: `blake3:${digit.repeat(64)}`, name: 'image.png', size: 10, mediaType: 'image/png', virtualPath: 'image.png' })

  it('accepts one image AssetRef and the first element of a nonempty list', () => {
    expect(selectedPreviewAssetForNode(node(image('1')), previewRegistry.previewRendererFor)).toEqual({
      digest: `blake3:${'1'.repeat(64)}`, name: 'image.png', count: 1, mediaType: 'image/png', mediaKind: 'image',
    })
    expect(selectedPreviewAssetForNode(node([image('2'), image('3')]), previewRegistry.previewRendererFor)).toEqual({
      digest: `blake3:${'2'.repeat(64)}`, name: 'image.png', count: 2, mediaType: 'image/png', mediaKind: 'image',
    })
  })

  it('dispatches exact MIME channels and keeps audio and unregistered assets out of selected-input previews', () => {
    const previewRendererFor = vi.fn(previewRegistry.previewRendererFor)
    expect(selectedPreviewAssetForNode(node({ ...image('4'), name: 'clip.webm', mediaType: 'video/webm' }), previewRendererFor)).toEqual({
      digest: `blake3:${'4'.repeat(64)}`, name: 'clip.webm', count: 1, mediaType: 'video/webm', mediaKind: 'video',
    })
    expect(previewRendererFor).toHaveBeenCalledWith('video/webm')
    expect(selectedPreviewAssetForNode(node({ ...image('5'), mediaType: 'audio/wav' }), previewRendererFor)).toBeUndefined()
    expect(selectedPreviewAssetForNode(node({ ...image('6'), mediaType: 'text/plain' }), previewRendererFor)).toBeUndefined()
  })

  it('requires renderer metadata to match the AssetRef MIME family', () => {
    const renderer = (mediaKind?: PreviewRenderer['mediaKind']): PreviewRenderer => ({
      id: 'test.preview',
      ...(mediaKind === undefined ? {} : { mediaKind }),
      canRender: () => true,
      drawCompact: () => {},
    })
    expect(selectedPreviewAssetForNode(node(image('7')), () => renderer('video'))).toBeUndefined()
    expect(selectedPreviewAssetForNode(
      node({ ...image('8'), name: 'clip.webm', mediaType: 'video/webm' }),
      () => renderer('image'),
    )).toBeUndefined()
    expect(selectedPreviewAssetForNode(node(image('9')), () => renderer())).toBeUndefined()
  })

  it('rejects empty lists, a non-previewable first element, and non-asset values', () => {
    expect(selectedPreviewAssetForNode(node([]), previewRegistry.previewRendererFor)).toBeUndefined()
    expect(selectedPreviewAssetForNode(node([{ ...image('4'), mediaType: 'text/plain' }, image('5')]), previewRegistry.previewRendererFor)).toBeUndefined()
    expect(selectedPreviewAssetForNode(node('image.png'), previewRegistry.previewRendererFor)).toBeUndefined()
  })

  it.each(['digest', 'name', 'size', 'mediaType', 'virtualPath'] as const)('rejects an AssetRef missing %s', (field) => {
    const incomplete = { ...image('6') }
    delete incomplete[field]
    expect(selectedPreviewAssetForNode(node(incomplete), previewRegistry.previewRendererFor)).toBeUndefined()
  })

  it('rejects malformed digests and invalid sizes', () => {
    expect(selectedPreviewAssetForNode(node({ ...image('7'), digest: 'blake3:short' }), previewRegistry.previewRendererFor)).toBeUndefined()
    expect(selectedPreviewAssetForNode(node({ ...image('8'), size: -1 }), previewRegistry.previewRendererFor)).toBeUndefined()
    expect(selectedPreviewAssetForNode(node({ ...image('9'), size: Number.MAX_SAFE_INTEGER + 1 }), previewRegistry.previewRendererFor)).toBeUndefined()
  })
})

describe('represented output previews', () => {
  const digest = `blake3:${'a'.repeat(64)}`
  const stored = { digest, name: 'image.png', size: 10, mediaType: 'image/png', virtualPath: 'image.png' }
  const representedSchema = (over: Record<string, unknown> = {}): NodeSchema => ({
    type: 'test.loader',
    displayName: 'Loader',
    category: 'test',
    source: 'v3',
    isOutputNode: false,
    items: [
      {
        kind: 'input', id: 'image', type: { kind: 'asset', element: { kind: 'concrete', name: 'dinkster.image' } },
        optional: false, widget: { widgetType: 'ASSET', options: {}, default: null },
      },
      {
        kind: 'output', id: 'image', type: { kind: 'concrete', name: 'dinkster.image' },
        represents: { input: 'image', rendition: 'decoded-image', ...over },
      },
    ],
  } as NodeSchema)
  const representedScene = (dynamic?: Record<string, { selected?: string }>): Scene => {
    const value = scene([{ id: 'loader', type: 'test.loader' }])
    Object.assign(value.nodes[0]! as object, {
      node: { id: 'loader', type: 'test.loader', values: { image: stored }, dynamic },
      layout: {
        width: 280,
        rows: [{ kind: 'widget', inputId: 'image', valueKey: 'image', spec: { widgetType: 'ASSET' } }],
      },
    })
    return value
  }
  const source: PreviewSource = { key: `asset:${digest}`, load: () => Promise.reject(new Error('unused')) }
  const decoded = { image: {} as CanvasImageSource, width: 4, height: 3 }
  const representedBase = () => ({
    ...base,
    scene: representedScene(),
    def: {
      id: 'g0',
      name: 'root',
      nodes: { loader: { id: 'loader', type: 'test.loader', values: {} } },
      links: {},
      nets: {},
      reroutes: {},
      nextOrdinal: 2,
    } as unknown as GraphDef,
    resolveSchema: (type: string) => type === 'test.loader' ? representedSchema() : undefined,
    mirrorPreviews: true,
    loader: {
      ...noLoader,
      inputAssetSource: () => source,
      resolve: (candidate: PreviewSource) => candidate.key === source.key ? decoded : undefined,
    },
  })

  it('attributes a supported selected asset to the exact represented output', () => {
    expect(representedPreviewAssetForNode(
      representedScene().nodes[0]!,
      representedSchema(),
      previewRegistry.previewRendererFor,
    )).toEqual({
      digest,
      name: 'image.png',
      count: 1,
      mediaType: 'image/png',
      mediaKind: 'image',
      outputId: 'image',
    })
  })

  it('requires a supported rendition and every stored applies selection', () => {
    expect(representedPreviewAssetForNode(
      representedScene().nodes[0]!,
      representedSchema({ rendition: 'future-rendition' }),
      previewRegistry.previewRendererFor,
    )).toBeUndefined()
    const scoped = representedSchema({ applies: { mode: ['load'], color: ['rgb'] } })
    expect(representedPreviewAssetForNode(
      representedScene({ mode: { selected: 'load' } }).nodes[0]!,
      scoped,
      previewRegistry.previewRendererFor,
    )).toBeUndefined()
    expect(representedPreviewAssetForNode(
      representedScene({ mode: { selected: 'load' }, color: { selected: 'rgb' } }).nodes[0]!,
      scoped,
      previewRegistry.previewRendererFor,
    )?.outputId).toBe('image')
  })

  it('renders the represented asset as an estimate, not as a selected-input preview', () => {
    const model = deriveSceneOverlays(representedBase())
    expect(model.previews['loader']).toEqual({ ...decoded, count: 1, state: 'estimate' })
    expect(model.previewSources['loader']?.outputId).toBe('image')
    expect(model.selectedInputPreviews['loader']).toBeUndefined()
  })

  it('falls back to the unattributed selected-input preview when mirrors are disabled', () => {
    const model = deriveSceneOverlays({ ...representedBase(), mirrorPreviews: false })
    expect(model.previews['loader']).toEqual({ ...decoded, count: 1 })
    expect(model.previewSources['loader']?.outputId).toBeUndefined()
    expect(model.selectedInputPreviews['loader']?.name).toBe('image.png')
  })
})

describe('selected image asset overlay', () => {
  const digest = `blake3:${'f'.repeat(64)}`
  const assetScene = scene([{ id: 'n1' }]) as unknown as { nodes: Array<Record<string, unknown>> }
  assetScene.nodes[0]!.node = { type: 'core.asset', values: { image: { digest, name: 'image.png', size: 1, mediaType: 'image/png', virtualPath: 'image.png' } } }
  assetScene.nodes[0]!.layout = { rows: [{ kind: 'widget', valueKey: 'image', spec: { widgetType: 'ASSET' } }] }
  const inputSource: PreviewSource = { key: `asset:${digest}`, load: async () => ({ image: {} as CanvasImageSource, width: 1, height: 1 }) }

  it('shows input loading/count without execution, but an executed source wins', () => {
    const inputAssetSource = vi.fn(() => inputSource)
    const inputLoader: PreviewLoader = { ...noLoader, inputAssetSource, resolve: () => undefined }
    const input = deriveSceneOverlays({ ...base, scene: assetScene as unknown as Scene, loader: inputLoader })
    expect(input.previews.n1).toEqual({ status: 'loading', count: 1 })
    expect(input.selectedInputPreviews.n1).toEqual({
      name: 'image.png',
      count: 1,
      preview: { status: 'loading', count: 1 },
    })

    const executed: PreviewSource = { key: 'executed', runtimeId: 'n1', load: inputSource.load }
    const decoded = { image: {} as CanvasImageSource, width: 2, height: 2 }
    const outputLoader: PreviewLoader = {
      ...inputLoader,
      sourceFor: () => executed,
      resolve: (source) => source === executed ? decoded : undefined,
    }
    const output = deriveSceneOverlays({
      ...base,
      scene: assetScene as unknown as Scene,
      exec: exec({ nodes: { n1: {} } }),
      loader: outputLoader,
    })
    expect(output.previews.n1).toBe(decoded)
    expect(output.selectedInputPreviews).toEqual({})
    expect(inputAssetSource).toHaveBeenCalledTimes(1)
    expect(inputAssetSource).toHaveBeenCalledWith(digest, 'image/png', 'image')
  })

  it('reports decoded and unavailable selected-input state without changing the painted preview', () => {
    const decoded = { image: {} as CanvasImageSource, width: 320, height: 180 }
    const decodedModel = deriveSceneOverlays({
      ...base,
      scene: assetScene as unknown as Scene,
      loader: { ...noLoader, inputAssetSource: () => inputSource, resolve: () => decoded },
    })
    expect(decodedModel.previews.n1).toEqual({ ...decoded, count: 1 })
    expect(decodedModel.selectedInputPreviews.n1).toEqual({
      name: 'image.png', count: 1, preview: { ...decoded, count: 1 },
    })

    const unavailableModel = deriveSceneOverlays({
      ...base,
      scene: assetScene as unknown as Scene,
      loader: { ...noLoader, inputAssetSource: () => inputSource, resolve: () => undefined, unavailable: () => true },
    })
    expect(unavailableModel.selectedInputPreviews.n1).toEqual({
      name: 'image.png', count: 1, preview: { status: 'unavailable', count: 1 },
    })
  })

  it('dispatches a selected VIDEO AssetRef through the shared media preview model', () => {
    const videoScene = scene([{ id: 'video' }]) as unknown as { nodes: Array<Record<string, unknown>> }
    const videoDigest = `blake3:${'a'.repeat(64)}`
    videoScene.nodes[0]!.node = { type: 'core.asset', values: { video: {
      digest: videoDigest, name: 'clip.webm', size: 4043, mediaType: 'video/webm', virtualPath: 'clip.webm',
    } } }
    videoScene.nodes[0]!.layout = { rows: [{ kind: 'widget', valueKey: 'video', spec: { widgetType: 'ASSET' } }] }
    const videoSource: PreviewSource = {
      key: `asset:${videoDigest}`,
      mediaKind: 'video',
      load: async () => ({ kind: 'video', mime: 'video/webm', src: `/api/assets/${videoDigest}` }),
    }
    const inputAssetSource = vi.fn(() => videoSource)
    const previewRendererFor = vi.fn(previewRegistry.previewRendererFor)
    const loading = deriveSceneOverlays({
      ...base,
      scene: videoScene as unknown as Scene,
      previewRendererFor,
      loader: { ...noLoader, inputAssetSource, resolve: () => undefined },
    })
    expect(loading.previews.video).toEqual({ status: 'loading', kind: 'video', count: 1 })

    const decoded = { kind: 'video' as const, mime: 'video/webm', src: `/api/assets/${videoDigest}` }
    const ready = deriveSceneOverlays({
      ...base,
      scene: videoScene as unknown as Scene,
      loader: { ...noLoader, inputAssetSource, resolve: () => decoded },
    })
    expect(ready.previews.video).toEqual({ ...decoded, count: 1 })
    expect(ready.selectedInputPreviews).toEqual({})
    expect(previewRendererFor).toHaveBeenCalledWith('video/webm')
    expect(inputAssetSource).toHaveBeenCalledWith(videoDigest, 'video/webm', 'video')
  })
})

describe('executed image paging overlay', () => {
  it('uses artifact node ids to map an otherwise absent runtime occurrence', () => {
    const source: PreviewSource = {
      key: `asset:blake3:${'a'.repeat(64)}`,
      runtimeId: 'saved',
      mediaKind: 'video',
      load: async () => ({ kind: 'video', mime: 'video/mp4', src: '/api/assets/saved' }),
    }
    const sourceFor = vi.fn((_execution, runtimeIds: readonly string[]) =>
      runtimeIds.includes('saved') ? source : undefined)
    const decoded = { kind: 'video' as const, mime: 'video/mp4', src: '/api/assets/saved' }
    const model = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'saved' }]),
      exec: exec({
        key: 'artifact-only',
        artifacts: [{
          nodeId: 'saved',
          digest: `blake3:${'a'.repeat(64)}`,
          name: 'saved.mp4',
          size: 4043,
          mediaType: 'video/mp4',
          virtualPath: 'output/saved.mp4',
        }],
      }),
      loader: { ...noLoader, sourceFor, resolve: () => decoded },
    })

    expect(sourceFor).toHaveBeenCalledWith(expect.anything(), ['saved'], false, undefined)
    expect(model.previews.saved).toEqual(decoded)
    expect(model.previewSources.saved).toBe(source)
  })

  it('uses the page key/index only for a finished executed-image source', () => {
    const images = [
      { key: 'a', runtimeId: 'n1', outputId: 'images', descriptorIndex: 0, url: '/a', kind: 'v1' as const, mediaType: 'image (legacy descriptor)', name: 'a.png' },
      { key: 'b', runtimeId: 'n1', outputId: 'images', descriptorIndex: 1, url: '/b', kind: 'v1' as const, mediaType: 'image (legacy descriptor)', name: 'b.png' },
    ]
    const source: PreviewSource = {
      key: 'b', runtimeId: 'n1', output: { index: 1, count: 2 },
      load: async () => ({ image: {} as CanvasImageSource, width: 2, height: 2 }),
    }
    const sourceFor = vi.fn(() => source)
    const outputPreviewIndex = vi.fn(() => 1)
    const model = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({ key: 'run', nodes: { n1: { state: 'done' } } }),
      outputPreviewKeyPrefix: 'document',
      outputPreviewIndex,
      loader: { ...noLoader, inventoryFor: () => images, sourceFor, resolve: () => undefined },
    })
    expect(model.executedImages.n1).toMatchObject({ images, index: 1, count: 2 })
    expect(model.executedImages.n1?.key).toContain('document\u0000run\u0000g0\u0000[]\u0000n1')
    expect(model.previews.n1).toEqual({ status: 'loading', count: 2, index: 1 })
    expect(sourceFor).toHaveBeenCalledWith(expect.anything(), ['n1'], false, 1)

    const live = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({ key: 'run', nodes: { n1: { state: 'running' } } }),
      loader: {
        ...noLoader,
        inventoryFor: () => images,
        sourceFor: () => ({ key: source.key, runtimeId: source.runtimeId, load: source.load }),
      },
    })
    expect(live.executedImages).toEqual({})
  })
})

describe('region execution feedback overlay', () => {
  it('renders the projected iteration counter as a non-interactive header badge', () => {
    const model = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'r', isSubgraph: true, regionKind: 'map' }]),
      exec: exec({
        regions: { r: { kind: 'map', binding: 'zip', iterations: 3 } },
        nodes: { 'r[1]/body': { state: 'running', value: 0.5 } },
      }),
    })
    expect(model.states).toEqual({ r: { state: 'running', value: 0.5 } })
    expect(model.badges.r).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'core.region.iteration',
        glyph: 'iteration 2 of 3',
        variant: 'label',
        interactive: false,
      }),
    ]))
  })
})

describe('recorded text output overlay', () => {
  it('projects a string result and preserves stale truthfulness', () => {
    const model = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({ nodes: { n1: { state: 'done', outputs: { text: { typeId: 'core.string', value: 'hello' } } } } }),
      exactProducer: () => false,
    })
    expect(model.outputTexts).toEqual({ n1: { text: 'hello', stale: true } })
  })

  it('gives an active image preview precedence over recorded text', () => {
    const decoded = { image: {} as CanvasImageSource, width: 2, height: 2 }
    const source: PreviewSource = { key: 'executed', runtimeId: 'n1', load: async () => decoded }
    const model = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({ nodes: { n1: { state: 'done', outputs: { text: { typeId: 'core.string', value: 'hidden' } } } } }),
      frozen: true,
      loader: { ...noLoader, sourceFor: () => source, resolve: () => decoded },
    })
    expect(model.previews.n1).toBe(decoded)
    expect(model.outputTexts.n1).toBeUndefined()
  })

  it('projects valid scalar expression mirrors and producer preview errors', () => {
    const parsed = scalarExpressionRegistry()
    expect(parsed.diagnostics).toEqual([])
    const derive = (expression: string) => {
      const def = {
        id: 'g0', name: 'root', links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
        nodes: {
          math: {
            id: 'math', type: 'dinkster.math.expression',
            values: { expression, 'values.a': 3, 'values.b': 0.5, 'values.c': true },
            dynamic: { values: { members: ['a', 'b', 'c'] } },
          },
        },
      } as unknown as GraphDef
      const mathScene = scene([{ id: 'math', type: 'dinkster.math.expression' }])
      Object.assign(mathScene.nodes[0]!, { node: def.nodes.math })
      return deriveSceneOverlays({
        ...base,
        scene: mathScene,
        def,
        resolveSchema: (type) => parsed.schemas.get(type),
        mirrorPreviews: true,
      })
    }

    expect(derive('a + b if c else 0').outputTexts.math).toEqual({
      text: 'Estimated locally\nfloat: 3.5\nint: 3\nboolean: true',
      estimate: true,
    })
    expect(derive('a +').outputTexts.math).toEqual({
      text: 'Preview error\nInvalid expression: unexpected token',
      error: true,
    })
  })
})

describe('scalar mirror propagation overlays', () => {
  const parsed = scalarExpressionRegistry()
  const resolveScalar = (type: string) => parsed.schemas.get(type)
  const chain = (): GraphDef => ({
    id: asGraphDefId('g0'),
    name: 'root',
    nodes: {
      primitive: {
        id: asNodeId('primitive'), type: 'e2e.identity.int', values: { source: 2 },
      },
      third: {
        id: asNodeId('third'), type: 'dinkster.math.expression',
        values: { expression: 'not a' }, dynamic: { values: { members: ['a'] } },
      },
      first: {
        id: asNodeId('first'), type: 'dinkster.math.expression',
        values: { expression: 'a + 0.5' }, dynamic: { values: { members: ['a'] } },
      },
      second: {
        id: asNodeId('second'), type: 'dinkster.math.expression',
        values: { expression: 'a + 1' }, dynamic: { values: { members: ['a'] } },
      },
    },
    links: {
      l1: {
        id: asLinkId('l1'), from: { node: asNodeId('primitive'), port: asPortId('result') },
        to: { node: asNodeId('first'), port: asPortId('values.a') },
      },
      l2: {
        id: asLinkId('l2'), from: { node: asNodeId('first'), port: asPortId('float') },
        to: { node: asNodeId('second'), port: asPortId('values.a') },
      },
      l3: {
        id: asLinkId('l3'), from: { node: asNodeId('second'), port: asPortId('boolean') },
        to: { node: asNodeId('third'), port: asPortId('values.a') },
      },
    },
    nets: {},
    reroutes: {},
    nextOrdinal: 10,
  } as unknown as GraphDef)
  const derive = (def: GraphDef, over: Partial<Parameters<typeof deriveSceneOverlays>[0]> = {}) =>
    deriveSceneOverlays({
      ...base,
      scene: scene([
        { id: 'primitive', type: 'e2e.identity.int' },
        { id: 'third', type: 'dinkster.math.expression' },
        { id: 'first', type: 'dinkster.math.expression' },
        { id: 'second', type: 'dinkster.math.expression' },
      ]),
      def,
      resolveSchema: resolveScalar,
      mirrorPreviews: true,
      ...over,
    })

  it('renders an unordered three-deep chain and its downstream companions', () => {
    const model = derive(chain())
    expect(model.companions.first?.['values.a']).toEqual({ value: 2 })
    expect(model.outputTexts.first?.text).toContain('float: 2.5')
    expect(model.outputTexts.second?.text).toContain('float: 3.5')
    expect(model.outputTexts.third?.text).toContain('boolean: false')
    expect(model.companions.second?.['values.a']).toEqual({ value: 2.5, state: 'estimate' })
    expect(model.companions.third?.['values.a']).toEqual({ value: true, state: 'estimate' })
  })

  it('shows an invalid producer error and clears only its downstream suffix', () => {
    const current = chain()
    const def = {
      ...current,
      nodes: {
        ...current.nodes,
        second: {
          ...current.nodes.second!,
          values: { ...current.nodes.second!.values, expression: 'a / 0' },
        },
      },
    } as GraphDef
    const model = derive(def)
    expect(model.outputTexts.first?.text).toContain('float: 2.5')
    expect(model.outputTexts.second).toEqual({
      text: 'Preview error\nDivision by zero',
      error: true,
    })
    expect(model.outputTexts.third).toBeUndefined()
    expect(model.companions.second?.['values.a']).toEqual({ value: 2.5, state: 'estimate' })
    expect(model.companions.third).toBeUndefined()
  })

  it('feeds exact and retained values but never stale values into new estimates', () => {
    const firstOutputs = {
      float: { typeId: 'core.float', value: 9 },
      int: { typeId: 'core.int', value: 9 },
      boolean: { typeId: 'core.boolean', value: true },
    }
    const exact = derive(chain(), {
      exec: exec({ nodes: { first: { state: 'done', outputs: firstOutputs } } }),
      exactProducer: () => true,
    })
    expect(exact.companions.second?.['values.a']).toEqual({ value: 9 })
    expect(exact.outputTexts.first).toBeUndefined()
    expect(exact.outputTexts.second?.text).toContain('float: 10')

    const cached = derive(chain(), {
      exec: exec({ nodes: { first: { state: 'cached', outputs: firstOutputs } } }),
      retainedRuntimeIds: new Set(['first']),
    })
    expect(cached.companions.second?.['values.a']).toEqual({ value: 9, state: 'cached' })
    expect(cached.outputTexts.first).toBeUndefined()
    expect(cached.outputTexts.second?.text).toContain('float: 10')

    const stale = derive(chain(), {
      exec: exec({ nodes: { first: { state: 'done', outputs: firstOutputs } } }),
      exactProducer: () => false,
    })
    expect(stale.companions.second?.['values.a']).toEqual({ value: 2.5, state: 'estimate' })
    expect(stale.outputTexts.first?.text).toContain('float: 2.5')
    expect(stale.outputTexts.second?.text).toContain('float: 3.5')
  })
})

const artifact = (over: Partial<CompileArtifact> = {}): CompileArtifact => ({
  connection: 'backend-a',
  schemaHash: 'schema-a',
  scope: { kind: 'full' },
  snapshot: {
    lineage: 'lineage-a', root: 'root',
    graphs: { root: { nodes: { a: { id: 'a', type: 'Source' }, b: { id: 'b', type: 'Source' } }, links: {}, nets: {} } },
  },
  prompt: {
    a: { class_type: 'Source', inputs: { value: 1 } },
    b: { class_type: 'Source', inputs: { value: 2 } },
  },
  provenance: { toSource: { a: 'a', b: 'b' }, fromSource: { a: ['a'], b: ['b'] } },
  choices: [],
  ...over,
} as unknown as CompileArtifact)

const resolveSchema = (type: string): NodeSchema | undefined =>
  type === 'Source' ? ({ type, items: [] } as unknown as NodeSchema) : undefined

const execution = (prompt: string, queuedAt: number, art: CompileArtifact, over: Partial<ExecutionState> = {}): ExecutionState => ({
  ref: { connection: art.connection, prompt }, key: `${art.connection}:${prompt}`, artifact: art,
  status: 'completed', nodes: {}, outputs: {}, previews: {}, errors: [], queuedAt, ...over,
} as ExecutionState)

describe('retainProvenExecution', () => {
  it('retains unchanged branches from the newest valid prior run and marks them cached', () => {
    const live = artifact()
    const current = execution('n+1', 30, artifact({ scope: { kind: 'partial', targets: [] }, prompt: { b: artifact().prompt.b! } }), {
      nodes: { b: { state: 'done', outputs: { out: { typeId: 'core.int', value: 22 } } } },
      outputs: { b: { images: ['current'] } },
    })
    const old = execution('n', 10, artifact(), {
      nodes: { a: { state: 'done', outputs: { out: { typeId: 'core.int', value: 11 } } } },
      outputs: { a: { image: { typeId: 'dinkster.asset', meta: { digest: `blake3:${'a'.repeat(64)}`, mediaType: 'image/png' } } } },
    })
    const newer = execution('n-newer', 20, artifact(), {
      nodes: { a: { state: 'done', outputs: { out: { typeId: 'core.int', value: 12 } } } },
      outputs: { a: { image: { typeId: 'dinkster.asset', meta: { digest: `blake3:${'b'.repeat(64)}`, mediaType: 'image/png' } } } },
    })
    const retained = retainProvenExecution(current, [old, newer, current], live, [], resolveSchema)
    expect(retained.execution.nodes.a).toMatchObject({ state: 'cached', outputs: { out: { value: 12 } } })
    expect(retained.execution.outputs.a).toEqual(newer.outputs.a)
    expect(retained.execution.previews.a).toBeUndefined()
    expect(retained.execution.nodes.b).toBe(current.nodes.b)
    expect(retained.execution.outputs.b).toBe(current.outputs.b)
    expect(retained.retainedRuntimeIds).toEqual(new Set(['a']))
  })

  it.each([
    ['different backend', { connection: 'backend-b' }],
    ['schema change', { schemaHash: 'schema-b' }],
    ['random selector', { choices: [{ graph: 'root', selector: 's', policy: 'random', candidate: 'x' }] }],
    ['missing provenance', { provenance: { toSource: {}, fromSource: {} } }],
  ])('rejects retention for %s', (_name, change) => {
    const live = artifact()
    const current = execution('n+1', 20, artifact({ scope: { kind: 'partial', targets: [] }, prompt: {} }))
    const priorArtifact = artifact(change as Partial<CompileArtifact>)
    const prior = execution('n', 10, priorArtifact, {
      nodes: { a: { state: 'done', outputs: { out: { typeId: 'core.int', value: 1 } } } },
      previews: { a: { channel: 'preview', payload: {}, timestamp: 1 } as never },
    })
    const retained = retainProvenExecution(current, [prior, current], live, [], resolveSchema)
    expect(retained.execution.nodes.a).toBeUndefined()
    expect(retained.execution.previews.a).toBeUndefined()
    expect(retained.retainedRuntimeIds.size).toBe(0)
  })

  it('invalidates an edited dependency while retaining an independent branch', () => {
    const live = artifact({ prompt: {
      a: { class_type: 'Source', inputs: { value: 9 } },
      b: { class_type: 'Source', inputs: { value: 2 } },
    } })
    const current = execution('n+1', 20, artifact({ scope: { kind: 'partial', targets: [] }, prompt: {} }))
    const prior = execution('n', 10, artifact(), { nodes: {
      a: { state: 'done' }, b: { state: 'done' },
    } })
    const retained = retainProvenExecution(current, [prior, current], live, [], resolveSchema)
    expect(retained.execution.nodes.a).toBeUndefined()
    expect(retained.execution.nodes.b?.state).toBe('cached')
    expect(retained.retainedRuntimeIds).toEqual(new Set(['b']))
  })

  it('retains an independent branch while rejecting a random selector cone', () => {
    const random = {
      choices: [{ graph: 'root', selector: 's', policy: 'random', candidate: 'x' }],
      provenance: {
        toSource: { a: 'a', b: 'b' },
        fromSource: { a: ['a'], b: ['b'] },
        randomSelectorInputs: { b: ['value'] },
      },
    } as Partial<CompileArtifact>
    const live = artifact(random)
    const current = execution('n+1', 20, artifact({ ...random, scope: { kind: 'partial', targets: [] }, prompt: {} }))
    const prior = execution('n', 10, artifact(random), {
      nodes: {
        a: { state: 'done', outputs: { out: { typeId: 'core.int', value: 1 } } },
        b: { state: 'done', outputs: { out: { typeId: 'core.int', value: 2 } } },
      },
    })
    const retained = retainProvenExecution(current, [prior, current], live, [], resolveSchema)
    expect(retained.execution.nodes.a).toMatchObject({ state: 'cached' })
    expect(retained.execution.nodes.b).toBeUndefined()
  })

  it('rejects recyclable V1 filenames while retaining digest assets and in-memory frames', () => {
    const live = artifact()
    const current = execution('n+1', 30, artifact({ scope: { kind: 'partial', targets: [] }, prompt: {} }))
    const frame = { '': { channel: 'preview', payload: new ArrayBuffer(1), timestamp: 20 } }
    const filename = execution('filename', 20, artifact(), {
      nodes: { a: { state: 'done' } },
      outputs: { a: { images: [{ filename: 'ComfyUI_temp_00001.png', type: 'temp' }] } },
      previews: { a: frame },
    })
    const digest = execution('digest', 10, artifact(), {
      nodes: { b: { state: 'done' } },
      outputs: { b: { image: { typeId: 'dinkster.asset', meta: { digest: `blake3:${'c'.repeat(64)}`, mediaType: 'image/png' } } } },
    })
    const retained = retainProvenExecution(current, [filename, digest, current], live, [], resolveSchema)
    expect(retained.execution.outputs.a).toBeUndefined()
    expect(retained.execution.previews.a).toBe(frame)
    expect(retained.execution.outputs.b).toEqual(digest.outputs.b)
    expect(retained.execution.nodes.a?.state).toBe('cached')
    expect(retained.execution.nodes.b?.state).toBe('cached')
    expect(retained.retainedRuntimeIds).toEqual(new Set(['a', 'b']))
  })

  it('retains proven prior results while the current partial run is still queued or running', () => {
    const live = artifact()
    const frame = { '': { channel: 'preview', payload: new ArrayBuffer(1), timestamp: 10 } }
    const prior = execution('n', 10, artifact(), {
      nodes: { a: { state: 'done' } },
      outputs: { a: { image: { typeId: 'dinkster.asset', meta: { digest: `blake3:${'a'.repeat(64)}`, mediaType: 'image/png' } } } },
      previews: { a: frame },
    })
    for (const status of ['queued', 'running', 'error', 'interrupted'] as const) {
      const current = execution('n+1', 20, artifact({ scope: { kind: 'partial', targets: [] }, prompt: { b: artifact().prompt.b! } }), { status })
      const retained = retainProvenExecution(current, [prior, current], live, [], resolveSchema)
      expect(retained.execution.outputs.a).toEqual(prior.outputs.a)
      expect(retained.execution.previews.a).toBe(frame)
      expect(retained.execution.nodes.a?.state).toBe('cached')
      expect(retained.retainedRuntimeIds).toEqual(new Set(['a']))
      expect(retained.execution.status).toBe(status)
    }
  })

  it('retains the frame of a proven node whose only visual is an in-memory preview', () => {
    const live = artifact()
    const frame = { '': { channel: 'preview', payload: new ArrayBuffer(1), timestamp: 10 } }
    const prior = execution('n', 10, artifact(), {
      nodes: { a: { state: 'done' } },
      previews: { a: frame },
    })
    const current = execution('n+1', 20, artifact({ scope: { kind: 'partial', targets: [] }, prompt: {} }))
    const retained = retainProvenExecution(current, [prior, current], live, [], resolveSchema)
    expect(retained.execution.previews.a).toBe(frame)
    expect(retained.execution.nodes.a?.state).toBe('cached')
    expect(retained.retainedRuntimeIds).toEqual(new Set(['a']))
  })

  it('strips recyclable siblings from a retained digest output and never revives a preview after the node ran', () => {
    const live = artifact()
    const current = execution('n+1', 30, artifact({ scope: { kind: 'partial', targets: [] }, prompt: {} }), {
      nodes: { b: { state: 'done' } },
    })
    const prior = execution('n', 10, artifact(), {
      nodes: { a: { state: 'done' }, b: { state: 'done' } },
      outputs: {
        a: {
          images: [{ filename: 'recycled.png', type: 'temp' }],
          image: { typeId: 'dinkster.asset', meta: { digest: `blake3:${'d'.repeat(64)}`, mediaType: 'image/png' } },
        },
        b: { image: { typeId: 'dinkster.asset', meta: { digest: `blake3:${'e'.repeat(64)}`, mediaType: 'image/png' } } },
      },
    })
    const retained = retainProvenExecution(current, [prior, current], live, [], resolveSchema)
    expect(retained.execution.outputs.a).toEqual({ image: prior.outputs.a!.image })
    expect(retained.execution.outputs.a!.images).toBeUndefined()
    expect(retained.execution.outputs.b).toBeUndefined()
    expect(retained.execution.nodes.b).toBe(current.nodes.b)
  })

  it('never marks a current-run frame cached and selects all retained fields from one newest candidate', () => {
    const live = artifact()
    const currentFrame = { channel: 'preview', payload: new ArrayBuffer(2), timestamp: 30 } as never
    const priorFrame = { channel: 'preview', payload: new ArrayBuffer(1), timestamp: 10 } as never
    const current = execution('n+1', 30, artifact({ scope: { kind: 'partial', targets: [] }, prompt: {} }), {
      previews: { a: currentFrame },
    })
    const newer = execution('newer', 20, artifact(), { nodes: { b: { state: 'done' } } })
    const older = execution('older', 10, artifact(), {
      nodes: { a: { state: 'done' }, b: { state: 'done' } },
      outputs: { b: { image: { typeId: 'dinkster.asset', meta: { digest: `blake3:${'f'.repeat(64)}`, mediaType: 'image/png' } } } },
      previews: { a: priorFrame },
    })
    const retained = retainProvenExecution(current, [older, newer, current], live, [], resolveSchema)
    expect(retained.execution.previews.a).toBe(currentFrame)
    expect(retained.execution.nodes.a).toBeUndefined()
    expect(retained.execution.nodes.b?.state).toBe('cached')
    expect(retained.execution.outputs.b).toBeUndefined()
    expect(retained.retainedRuntimeIds.has('a')).toBe(false)
  })

  it('ignores a skipped candidate digest and continues to an older successful occurrence', () => {
    const live = artifact()
    const current = execution('n+1', 30, artifact({ scope: { kind: 'partial', targets: [] }, prompt: {} }))
    const skipped = execution('skipped', 20, artifact(), {
      nodes: { a: { state: 'skipped' } },
      outputs: { a: { image: { typeId: 'dinkster.asset', meta: { digest: `blake3:${'1'.repeat(64)}`, mediaType: 'image/png' } } } },
    })
    const done = execution('done', 10, artifact(), {
      nodes: { a: { state: 'done' } },
      outputs: { a: { image: { typeId: 'dinkster.asset', meta: { digest: `blake3:${'2'.repeat(64)}`, mediaType: 'image/png' } } } },
    })
    const retained = retainProvenExecution(current, [done, skipped, current], live, [], resolveSchema)
    expect(retained.execution.outputs.a).toEqual(done.outputs.a)
    expect(retained.execution.nodes.a?.state).toBe('cached')
  })

  it('retains proven prior results into a whole run until each node re-reports', () => {
    const live = artifact()
    const frame = { '': { channel: 'preview', payload: new ArrayBuffer(1), timestamp: 10 } }
    const prior = execution('n', 10, artifact(), {
      nodes: { a: { state: 'done' }, b: { state: 'done' } },
      outputs: { a: { image: { typeId: 'dinkster.asset', meta: { digest: `blake3:${'a'.repeat(64)}`, mediaType: 'image/png' } } } },
      previews: { b: frame },
    })
    const current = execution('n+1', 20, artifact(), { status: 'queued' })
    const retained = retainProvenExecution(current, [prior, current], live, [], resolveSchema)
    expect(retained.execution.nodes.a?.state).toBe('cached')
    expect(retained.execution.outputs.a).toEqual(prior.outputs.a)
    expect(retained.execution.previews.b).toBe(frame)
    expect(retained.execution.nodes.b?.state).toBe('cached')
    expect(retained.retainedRuntimeIds).toEqual(new Set(['a', 'b']))
  })

  it('yields whole-run retention to current-run data as nodes re-report', () => {
    const live = artifact()
    const prior = execution('n', 10, artifact(), {
      nodes: { a: { state: 'done' }, b: { state: 'done' } },
      outputs: {
        a: { image: { typeId: 'dinkster.asset', meta: { digest: `blake3:${'a'.repeat(64)}`, mediaType: 'image/png' } } },
        b: { image: { typeId: 'dinkster.asset', meta: { digest: `blake3:${'b'.repeat(64)}`, mediaType: 'image/png' } } },
      },
    })
    const current = execution('n+1', 20, artifact(), {
      status: 'running',
      nodes: { a: { state: 'running' } },
    })
    const retained = retainProvenExecution(current, [prior, current], live, [], resolveSchema)
    expect(retained.execution.nodes.a).toBe(current.nodes.a)
    expect(retained.execution.outputs.a).toBeUndefined()
    expect(retained.execution.nodes.b?.state).toBe('cached')
    expect(retained.execution.outputs.b).toEqual(prior.outputs.b)
    expect(retained.retainedRuntimeIds).toEqual(new Set(['b']))
  })

  it('keeps current execution identity when nothing is retained', () => {
    const current = execution('n+1', 20, artifact())
    const retained = retainProvenExecution(current, [current], artifact(), [], resolveSchema)
    expect(retained.execution).toBe(current)
    expect(retained.retainedRuntimeIds.size).toBe(0)
  })

  it('rejects whole-run retention for controller-sensitive nodes', () => {
    const controlledArtifact = artifact({
      snapshot: {
        lineage: 'lineage-a', root: 'root',
        graphs: { root: { nodes: {
          a: { id: 'a', type: 'Controlled', controllers: { seed: 'randomize' } },
          b: { id: 'b', type: 'Sink' },
        }, links: {}, nets: {} } },
      } as never,
      prompt: {
        a: { class_type: 'Controlled', inputs: { seed: 1 } },
        b: { class_type: 'Sink', inputs: { value: ['a', 0] } },
      },
    })
    const resolver = (type: string): NodeSchema | undefined => type === 'Controlled'
      ? ({ type, items: [{ kind: 'input', id: 'seed', widget: {
          widgetType: 'INT', controller: 'after_generate', controllerInitial: 'randomize',
        } }] } as unknown as NodeSchema)
      : type === 'Sink' ? ({ type, items: [] } as unknown as NodeSchema) : undefined
    const current = execution('n+1', 20, controlledArtifact, { status: 'queued' })
    const prior = execution('n', 10, controlledArtifact, { nodes: { a: { state: 'done' }, b: { state: 'done' } } })
    const retained = retainProvenExecution(current, [prior, current], controlledArtifact, [], resolver)
    expect(retained.execution).toBe(current)
    expect(retained.retainedRuntimeIds.size).toBe(0)
  })

  it.each([
    ['missing schema', undefined, 'a'],
    ['malformed occurrence provenance', resolveSchema, 'bad..key'],
    ['unresolvable instance path', resolveSchema, 'missing.a'],
  ])('fails closed when controller sensitivity has %s', (_name, resolver, occurrence) => {
    const live = artifact({ provenance: { toSource: { a: occurrence }, fromSource: { [occurrence]: ['a'] } } })
    const current = execution('n+1', 20, artifact({ scope: { kind: 'partial', targets: [] }, prompt: {} }))
    const prior = execution('n', 10, artifact(), { nodes: { a: { state: 'done' } } })
    const retained = retainProvenExecution(current, [prior, current], live, [], resolver)
    expect(retained.execution).toBe(current)
    expect(retained.retainedRuntimeIds.size).toBe(0)
  })

  it('propagates non-fixed controller sensitivity to downstream recipes', () => {
    const controlledArtifact = artifact({
      snapshot: {
        lineage: 'lineage-a', root: 'root',
        graphs: { root: { nodes: {
          a: { id: 'a', type: 'Controlled', controllers: { seed: 'randomize' } },
          b: { id: 'b', type: 'Sink' },
        }, links: {}, nets: {} } },
      } as never,
      prompt: {
        a: { class_type: 'Controlled', inputs: { seed: 1 } },
        b: { class_type: 'Sink', inputs: { value: ['a', 0] } },
      },
    })
    const resolver = (type: string): NodeSchema | undefined => type === 'Controlled'
      ? ({ type, items: [{ kind: 'input', id: 'seed', widget: {
          widgetType: 'INT', controller: 'after_generate', controllerInitial: 'randomize',
        } }] } as unknown as NodeSchema)
      : type === 'Sink' ? ({ type, items: [] } as unknown as NodeSchema) : undefined
    const current = execution('n+1', 20, artifact({ scope: { kind: 'partial', targets: [] }, prompt: {} }))
    const prior = execution('n', 10, controlledArtifact, { nodes: { b: { state: 'done' } } })
    const retained = retainProvenExecution(current, [prior, current], controlledArtifact, [], resolver)
    expect(retained.execution).toBe(current)
    expect(retained.retainedRuntimeIds.size).toBe(0)
  })
})

describe('deriveSceneOverlays', () => {
  it('yields an empty model without an execution', () => {
    const m = deriveSceneOverlays({ ...base, scene: scene([{ id: 'n1' }]) })
    expect(m.states).toEqual({})
    expect(m.previews).toEqual({})
    expect(m.selectorResolutions).toBeUndefined()
    expect(m.ownRuntimeIds).toBeUndefined()
    expect(m.badges).toEqual({})
    expect(m.portProblems).toEqual({})
  })

  it('abstains from occurrence-keyed overlays when the instance path is unknown', () => {
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({ nodes: { n1: { state: 'error' } } }),
      instancePath: undefined,
    })
    expect(m.states).toEqual({}) // never guess which occurrence is meant
    expect(m.ownRuntimeIds).toBeUndefined()
  })

  it('projects run states onto the root view and badges errored nodes', () => {
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }, { id: 'n2' }]),
      exec: exec({ nodes: { n1: { state: 'error' } }, errors: [runError('n1')] }),
    })
    expect(m.states['n1']?.state).toBe('error')
    expect(m.states['n2']).toBeUndefined()
    expect(m.badges['n1']).toContainEqual(executionErrorBadge(1))
    expect(m.badges['n2']).toBeUndefined()
    expect(m.ownRuntimeIds!('n1')).toEqual(['n1'])
  })

  it('attributes activity-only runtime nodes before node state arrives', () => {
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({
        activities: [{
          kind: 'lazy_demand',
          nodeId: 'n1',
          round: 1,
          status: 'waiting',
          requestedInputs: ['branch'],
          newInputs: ['branch'],
          demandedInputs: ['branch'],
          producerNodes: ['source'],
        }],
      }),
    })
    expect(m.states).toEqual({})
    expect(m.ownRuntimeIds!('n1')).toEqual(['n1'])
  })

  it('names muted and bypassed modes on-node while active nodes stay unbadged', () => {
    const target = scene([
      { id: 'muted', mode: 'muted' },
      { id: 'bypassed', mode: 'bypassed' },
      { id: 'active', mode: 'active' },
    ])
    const m = deriveSceneOverlays({
      ...base,
      scene: target,
    })
    const decorated = applyNodeDecorations({
      scene: target, documentId: 'lineage', graphId: 'root', contributions: [modeDecoration], badges: m.badges,
    })

    expect(decorated.badges.muted).toEqual([MUTED_BADGE])
    expect(decorated.badges.bypassed).toEqual([BYPASSED_BADGE])
    expect(decorated.badges.active).toBeUndefined()
    expect(MUTED_BADGE.glyph).toBe('Muted')
    expect(BYPASSED_BADGE.glyph).toBe('Bypassed')
  })

  it('composes a mode badge with existing overlay badges', () => {
    const target = scene([{ id: 'muted-error', mode: 'muted' }])
    const m = deriveSceneOverlays({
      ...base,
      scene: target,
      exec: exec({ nodes: { 'muted-error': { state: 'error' } }, errors: [runError('muted-error')] }),
    })
    const decorated = applyNodeDecorations({
      scene: target, documentId: 'lineage', graphId: 'root', contributions: [modeDecoration], badges: m.badges,
    })

    expect(decorated.badges['muted-error']).toEqual([executionErrorBadge(1), MUTED_BADGE])
    expect(executionErrorBadge(1).glyph).toBe('Error')
  })

  it('applies decorations in id order and rolls back a failing contribution', () => {
    const target = scene([{ id: 'proof' }, { id: 'other' }])
    const results: Array<readonly [string, unknown?]> = []
    let getterCalls = 0
    const decorated = applyNodeDecorations({
      scene: target,
      documentId: 'lineage',
      graphId: 'root',
      badges: { proof: [executionErrorBadge(1)] },
      contributions: [
        {
          id: 'z.valid',
          decorate: (node) => node.id === 'proof' ? {
            badges: [{ id: 'pack.proof', glyph: 'Pack', variant: 'label', interactive: false, color: '#7b3fb2' }],
            color: '#123456', titleSuffix: 'decorated', status: 'ready',
          } : undefined,
        },
        {
          id: 'a.invalid',
          decorate: (node) => node.id === 'other'
            ? { badges: [{ id: 'pack.invalid', glyph: 'Bad', color: 'purple' }] }
            : { badges: [{ id: 'pack.partial', glyph: 'Partial', color: '#112233' }] },
        },
        {
          id: 'b.accessor',
          decorate: () => ({
            get badges() {
              getterCalls += 1
              return []
            },
          }),
        },
      ],
      onResult: (id, error) => results.push([id, error]),
    })

    expect(decorated.badges.proof).toEqual([
      executionErrorBadge(1),
      { id: 'pack.proof', glyph: 'Pack', variant: 'label', interactive: false, color: '#7b3fb2' },
    ])
    expect(decorated.badges.other).toBeUndefined()
    expect(decorated.presentation.proof).toEqual({ color: '#123456', titleSuffix: 'decorated', status: 'ready' })
    expect(getterCalls).toBe(0)
    expect(results.map(([id, error]) => [id, error === undefined])).toEqual([
      ['a.invalid', false],
      ['b.accessor', false],
      ['z.valid', true],
    ])
  })

  it('derives unstored falsy widget-tap companions from the effective schema defaults', () => {
    const def = {
      id: 'g0', name: 'root',
      nodes: {
        source: { id: 'source', type: 'Source', values: {} },
        sink: { id: 'sink', type: 'Sink', values: {} },
      },
      links: {
        number: { id: 'number', from: { node: 'source', tap: 'number#raw' }, to: { node: 'sink', port: 'number' } },
        text: { id: 'text', from: { node: 'source', tap: 'text' }, to: { node: 'sink', port: 'text' } },
      },
      nets: {}, reroutes: {}, nextOrdinal: 10,
    } as unknown as GraphDef
    const source = {
      type: 'Source', displayName: 'Source', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        { kind: 'input', id: 'number#raw', type: { kind: 'concrete', name: 'INT' }, optional: false, widget: { widgetType: 'INT', options: {}, default: 0 } },
        { kind: 'input', id: 'text', type: { kind: 'concrete', name: 'STRING' }, optional: false, widget: { widgetType: 'STRING', options: {}, default: '' } },
      ],
    } as unknown as NodeSchema
    const m = deriveSceneOverlays({
      ...base,
      def,
      resolveSchema: (type) => type === 'Source' ? source : undefined,
    })
    expect(m.companions).toEqual({ sink: { number: { value: 0 }, text: { value: '' } } })
  })

  it('adds document problem badges without replacing the runtime error badge', () => {
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({ nodes: { n1: { state: 'error' } }, errors: [runError('n1')] }),
      nodeProblems: {
        n1: [
          { kind: 'error', diagnostics: [] },
          { kind: 'blocking-warning', diagnostics: [] },
          { kind: 'warning', diagnostics: [] },
        ],
      },
    })
    expect(m.badges['n1']).toEqual([
      executionErrorBadge(1),
      PROBLEM_ERROR_BADGE,
      PROBLEM_BLOCKING_WARNING_BADGE,
      PROBLEM_WARNING_BADGE,
    ])
    expect(PROBLEM_ERROR_BADGE.glyph).toBe('Error')
  })

  it('does not duplicate a pure runtime diagnostic as a document-error badge', () => {
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({ nodes: { n1: { state: 'error' } }, errors: [runError('n1')] }),
      nodeProblems: {
        n1: [{
          kind: 'error',
          diagnostics: [{ severity: 'error', origin: 'runtime', code: 'runtime.X', message: 'failed' }],
        }],
      },
    })

    expect(m.badges['n1']).toEqual([executionErrorBadge(1)])
  })

  it('derives bottom warning and info badges from node-attributed log records', () => {
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }]),
      exec: exec({
        logs: [
          { level: 'warning', message: 'low vram', timestamp: 1, runtimeNodeId: 'n1', seq: 1 },
          { level: 'warning', message: 'seed reused', timestamp: 2, runtimeNodeId: 'n1', seq: 2 },
          { level: 'info', message: 'loaded', timestamp: 3, runtimeNodeId: 'n1', seq: 3 },
          { level: 'info', message: 'decoded', timestamp: 4, runtimeNodeId: 'n2', seq: 4 },
          { level: 'info', message: 'run-scoped, no node', timestamp: 5, seq: 5 },
        ],
      }),
    })
    expect(m.badges['n1']).toEqual([logWarningBadge(2), LOG_INFO_BADGE])
    expect(m.badges['n2']).toEqual([LOG_INFO_BADGE])
    expect(m.badges['n3']).toBeUndefined()
    expect(m.runLogsByNode.get('n1')?.map((entry) => entry.message))
      .toEqual(['low vram', 'seed reused', 'loaded'])
    expect(m.runLogsByNode.get('n2')?.map((entry) => entry.message)).toEqual(['decoded'])
    expect(m.runLogsByNode.has('n3')).toBe(false)
  })

  it('attributes media warning badges to exact nested occurrences without marking execution failed', () => {
    const execution = exec({
      valueDiagnostics: [
        { code: 'alpha_dropped', nodeId: 'left.image', outputId: 'rgb', inputIds: ['rgba'] },
        { code: 'alpha_dropped', nodeId: 'left.image', outputId: 'rgb', inputId: 'rgba' },
        { code: 'mask_polarity_mismatch', nodeId: 'right.image', inputId: 'mask', expected: 'coverage', actual: 'transparency' },
      ],
    })
    const result = deriveSceneOverlays({ ...base, scene: scene([{ id: 'image' }]), instancePath: ['left'], exec: execution })
    expect(result.badges['image']?.map((badge) => badge.glyph)).toEqual(['Alpha dropped: rgb'])
    expect(result.badges['image']?.[0]).toMatchObject({ placement: 'below', interactive: false })
    expect(result.states['image']).toBeUndefined()
    expect(result.runErrorsByNode.size).toBe(0)
    const unknown = deriveSceneOverlays({ ...base, scene: scene([{ id: 'image' }]), instancePath: undefined, exec: execution })
    expect(unknown.badges['image']).toBeUndefined()
  })

  it('counts anchored error diagnostics in the bottom error badge', () => {
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({
        nodes: { n1: { state: 'error' } },
        errors: [
          { severity: 'error', origin: 'runtime', code: 'runtime.A', message: 'first', anchor: { occurrence: { instancePath: [], node: 'n1' } } },
          { severity: 'error', origin: 'runtime', code: 'runtime.B', message: 'second', anchor: { occurrence: { instancePath: [], node: 'n1' } } },
        ],
      }),
    })
    expect(m.badges['n1']).toEqual([executionErrorBadge(2)])
    expect(executionErrorBadge(2).glyph).toBe('Error 2')
  })

  it('shows no error badge for an errored state without an anchored report entry', () => {
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({ nodes: { n1: { state: 'error' } } }),
    })
    expect(m.states['n1']?.state).toBe('error')
    expect(m.badges['n1']).toBeUndefined()
    expect(m.runErrorsByNode.size).toBe(0)
  })

  it('badges an anchored report entry even without projected error state', () => {
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({ errors: [runError('n1')] }),
    })
    expect(m.states['n1']).toBeUndefined()
    expect(m.badges['n1']).toEqual([executionErrorBadge(1)])
  })

  it('skips non-error severities and unanchored entries in the error badge', () => {
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({
        errors: [
          runError('n1'),
          runError('n1', [], { severity: 'warning' }),
          { severity: 'error', origin: 'runtime', code: 'runtime.J', message: 'job-level, no anchor' },
        ],
      }),
    })
    expect(m.badges['n1']).toEqual([executionErrorBadge(1)])
  })

  it('anchors nested errors to the subgraph instance at the root and to the leaf inside it', () => {
    const errors = [
      runError('deep', ['sub1', 'inner']),
      runError('leaf', ['sub1']),
      runError('other', ['sub2']),
    ]
    const root = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'sub1', isSubgraph: true, type: '#def' }, { id: 'sub2', isSubgraph: true, type: '#def' }]),
      exec: exec({ errors }),
    })
    expect(root.badges['sub1']).toContainEqual(executionErrorBadge(2))
    expect(root.badges['sub2']).toContainEqual(executionErrorBadge(1))

    const insideSub1 = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'inner', isSubgraph: true, type: '#def' }, { id: 'leaf' }]),
      exec: exec({ errors }),
      instancePath: ['sub1'],
    })
    expect(insideSub1.badges['inner']).toContainEqual(executionErrorBadge(1))
    expect(insideSub1.badges['leaf']).toEqual([executionErrorBadge(1)])
    // sub2's error belongs to a sibling branch and never leaks here.
    expect(insideSub1.runErrorsByNode.size).toBe(2)
  })

  it('exposes the same anchored diagnostics the badge counts through runErrorsByNode', () => {
    const first = runError('n1', [], { code: 'runtime.A', message: 'first' })
    const second = runError('n1', [], { code: 'runtime.B', message: 'second' })
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({ errors: [first, second] }),
    })
    expect(m.badges['n1']).toEqual([executionErrorBadge(2)])
    expect(m.runErrorsByNode.get('n1')).toEqual([first, second])
  })

  it('a dismissed error badge disappears while log badges stay', () => {
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({
        nodes: { n1: { state: 'error' } },
        errors: [runError('n1')],
        logs: [{ level: 'warning', message: 'low vram', timestamp: 1, runtimeNodeId: 'n1', seq: 1 }],
      }),
      dismissedErrorNodes: new Set(['n1']),
    })
    expect(m.badges['n1']).toEqual([logWarningBadge(1)])
  })

  it('passes shared port problem projection through without re-resolving diagnostics', () => {
    const portProblems = { n1: { input: 'error' as const } }
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      portProblems,
    })

    expect(m.portProblems).toBe(portProblems)
  })

  it('badges subgraphs, schema deprecations, and replacement-scan hits', () => {
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([
        { id: 's', isSubgraph: true, type: '#def' },
        { id: 'old', type: 'core.old' },
        { id: 'swap', type: 'core.swap' },
      ]),
      resolveSchema: schemaTable({ 'core.old': { deprecation: { message: 'gone' } }, 'core.swap': {} }),
      replacements: [
        { graphId: 'g0', nodeId: 'swap' } as unknown as ReplacementScanItem,
        { graphId: 'other', nodeId: 'old' } as unknown as ReplacementScanItem,
      ],
    })
    expect(m.badges['s']).toContain(SUBGRAPH_BADGE)
    expect(m.badges['old']).toContain(DEPRECATED_BADGE)
    expect(m.badges['swap']).toContain(DEPRECATED_BADGE)
    // replaceItems filters to the CURRENT graph.
    expect([...m.replaceItems.keys()]).toEqual(['swap'])
  })

  it('derives linked occurrence counts from the document without storing them', () => {
    const doc = {
      graphs: {
        g0: { nodes: { first: { type: '#shared' }, plain: { type: 'core.plain' } } },
        other: { nodes: { second: { type: '#shared' } } },
        shared: { nodes: {} },
      },
    } as unknown as WorkflowDocument
    const model = deriveSceneOverlays({
      ...base,
      doc,
      scene: scene([{ id: 'first', isSubgraph: true, type: '#shared' }]),
    })
    expect(model.badges.first).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'core.subgraph', glyph: '2', icon: 'boxes', variant: 'label' }),
    ]))
  })

  it('does not badge ordinary nodes with implementation arms or packs', () => {
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'a', type: 'vhs.load' }]),
      resolveSchema: schemaTable({ 'vhs.load': { pack: 'vhs', executionArms: ['native', 'comfyui'] } }),
      exec: exec({ nodes: { a: { state: 'done', executionArm: 'comfyui', provider: 'vision.vhs', pack: 'vhs' } } }),
    })
    expect(m.badges['a']).toBeUndefined()
  })

  it('resolves recorded selector choices on frozen tabs only, filtered to the current graph', () => {
    const artifact = {
      choices: [
        { graph: 'g0', selector: 'sel', candidate: 'c1' },
        { graph: 'other', selector: 'x', candidate: 'y' },
      ],
      provenance: {},
    }
    const frozen = deriveSceneOverlays({ ...base, frozen: true, exec: exec({ artifact }) })
    expect(frozen.selectorResolutions).toEqual(new Map([['sel', 'c1']]))
    // Live tabs never get resolutions - the document is editable.
    const live = deriveSceneOverlays({ ...base, frozen: false, exec: exec({ artifact }) })
    expect(live.selectorResolutions).toBeUndefined()
    // No choice in this graph: undefined, not an empty map.
    const elsewhere = deriveSceneOverlays({
      ...base,
      frozen: true,
      graphId: 'g9',
      exec: exec({ artifact }),
    })
    expect(elsewhere.selectorResolutions).toBeUndefined()
  })

  it('collects previews from the loader and omits in-flight decodes', () => {
    const decoded = { kind: 'image' } as never
    const src: PreviewSource = { key: 'k', load: () => Promise.reject(new Error('unused')) }
    const loader: PreviewLoader = {
      sourceFor: (_e, ids) => (ids.includes('n1') ? src : undefined),
      peekSource: () => undefined,
      resolve: (s) => (s === src ? decoded : undefined),
    }
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }, { id: 'n2' }]),
      exec: exec({ nodes: { n1: {}, n2: {} } }),
      loader,
    })
    expect(m.previews).toEqual({ n1: decoded })
  })

  it('wraps a decoded retained preview as cached without mutating the shared decode', () => {
    const decoded = { image: {} as CanvasImageSource, width: 32, height: 16 }
    const src: PreviewSource = { key: 'asset:blake3:digest', runtimeId: 'n1', load: () => Promise.reject(new Error('unused')) }
    const loader: PreviewLoader = {
      sourceFor: () => src,
      peekSource: () => undefined,
      resolve: () => decoded,
    }
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({ nodes: { n1: { state: 'cached' } } }),
      retainedRuntimeIds: new Set(['n1']),
      loader,
    })
    expect(m.previews.n1).toEqual({ ...decoded, state: 'cached' })
    expect(m.previews.n1).not.toBe(decoded)
    expect(decoded).not.toHaveProperty('state')
  })

  it('does not label a current backend-cached preview as retained', () => {
    const decoded = { image: {} as CanvasImageSource, width: 32, height: 16 }
    const src: PreviewSource = { key: 'asset:current', runtimeId: 'n1', load: () => Promise.reject(new Error('unused')) }
    const loader: PreviewLoader = { sourceFor: () => src, peekSource: () => undefined, resolve: () => decoded }
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({ nodes: { n1: { state: 'cached' } } }),
      loader,
    })
    expect(m.previews.n1).toBe(decoded)
  })

  it('selects a current preview source before retained occurrences and decorates only the selected runtime id', () => {
    const current = { image: {} as CanvasImageSource, width: 20, height: 10 }
    const retained = { image: {} as CanvasImageSource, width: 30, height: 15 }
    const loader: PreviewLoader = {
      sourceFor: (_exec, ids) => ids.includes('current')
        ? { key: 'current', runtimeId: 'current', load: async () => current }
        : ids.includes('old') ? { key: 'old', runtimeId: 'old', load: async () => retained } : undefined,
      peekSource: () => undefined,
      resolve: (source) => source.runtimeId === 'current' ? current : retained,
    }
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'group', isSubgraph: true }]),
      exec: exec({
        nodes: { current: { state: 'cached' }, old: { state: 'cached' } },
        artifact: { provenance: { toSource: { current: 'group.a', old: 'group.b' } } },
      }),
      retainedRuntimeIds: new Set(['old']),
      loader,
    })
    expect(m.previews.group).toBe(current)
  })

  it('never labels a peek source retained without selected runtime provenance', () => {
    const decoded = { image: {} as CanvasImageSource, width: 20, height: 10 }
    const peek: PreviewSource = { key: 'peek:k', load: async () => decoded }
    const loader: PreviewLoader = { sourceFor: () => undefined, peekSource: () => peek, resolve: () => decoded }
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({ nodes: { n1: { state: 'cached', outputs: { out: { typeId: 'std.image' } } } } }),
      retainedRuntimeIds: new Set(['n1']),
      loader,
      values: { valuesClient: true } as never,
    })
    expect(m.previews.n1).toBe(decoded)
  })

  it('falls back to native peek only when a values client exists and the loader missed', () => {
    const peekSource = vi.fn(() => undefined)
    const loader: PreviewLoader = { ...noLoader, peekSource }
    const withValues = { valuesClient: true } as never
    // The node ran and recorded a non-scalar output -> peek candidates exist
    // (inline scalars are deliberately filtered; they never need imagery).
    const e = exec({ nodes: { n1: { outputs: { out: { typeId: 'std.image' } } } } })
    deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: e,
      loader,
      values: withValues,
    })
    expect(peekSource).toHaveBeenCalledTimes(1)
    peekSource.mockClear()
    // No values client (live/non-native run): never peek.
    deriveSceneOverlays({ ...base, scene: scene([{ id: 'n1' }]), exec: e, loader })
    expect(peekSource).not.toHaveBeenCalled()
  })

  it('keeps a direct ASSET preview source ahead of native peek', () => {
    const direct: PreviewSource = { key: 'asset:blake3:digest', load: () => Promise.reject(new Error('unused')) }
    const decoded = { kind: 'image' } as never
    const peekSource = vi.fn(() => undefined)
    const loader: PreviewLoader = {
      sourceFor: () => direct,
      peekSource,
      resolve: (source) => source === direct ? decoded : undefined,
    }
    const m = deriveSceneOverlays({
      ...base,
      scene: scene([{ id: 'n1' }]),
      exec: exec({ nodes: { n1: { outputs: { assets: {} } } } }),
      loader,
      values: { valuesClient: true } as never,
    })
    expect(m.previews).toEqual({ n1: decoded })
    expect(peekSource).not.toHaveBeenCalled()
  })
})

describe('glsl image estimate overlay', () => {
  const GLSL_SOURCE = 'void main() {}'
  const imageProducerSchema: NodeSchema = {
    type: 'ImageSource',
    displayName: 'Image Source',
    category: 'test',
    source: 'v3',
    isOutputNode: false,
    items: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'dinkster.image' } }],
  } as unknown as NodeSchema
  const adjustSchema: NodeSchema = {
    type: 'test.adjust',
    displayName: 'Adjust',
    category: 'test',
    source: 'v3',
    isOutputNode: false,
    mirror: { kind: 'glsl', precision: 'bounded', tolerance: { perChannel: 1 / 255 }, source: GLSL_SOURCE },
    items: [
      { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'dinkster.image' }, optional: false },
      {
        kind: 'input',
        id: 'factor',
        type: { kind: 'concrete', name: 'core.float' },
        optional: false,
        widget: { widgetType: 'NUMBER', options: {}, default: 1.5 },
      },
      { kind: 'output', id: 'image', type: { kind: 'concrete', name: 'dinkster.image' } },
    ],
  } as unknown as NodeSchema
  const resolveMirrorSchemas = (type: string): NodeSchema | undefined =>
    type === 'ImageSource' ? imageProducerSchema : type === 'test.adjust' ? adjustSchema : undefined

  const defNode = (id: string, type: string) => ({ id: asNodeId(id), type, values: {} })
  const imageLink = (id: string, fromNode: string, toNode: string) => ({
    id: asLinkId(id),
    from: { node: asNodeId(fromNode), port: asPortId('image') },
    to: { node: asNodeId(toNode), port: asPortId('image') },
  })
  /** src (producer) -> a1 (mirrored adjust) -> a2 (mirrored adjust). */
  const chainDef = {
    id: asGraphDefId('g0'),
    name: 'g',
    nodes: { src: defNode('src', 'ImageSource'), a1: defNode('a1', 'test.adjust'), a2: defNode('a2', 'test.adjust') },
    links: {
      l1: {
        id: asLinkId('l1'),
        from: { node: asNodeId('src'), port: asPortId('out') },
        to: { node: asNodeId('a1'), port: asPortId('image') },
      },
      l2: imageLink('l2', 'a1', 'a2'),
    },
    nets: {},
    reroutes: {},
    nextOrdinal: 100,
  } as unknown as GraphDef

  const decodedUpstream = { image: {} as CanvasImageSource, width: 4, height: 3 }
  const srcSource: PreviewSource = { key: 'preview:src', outputId: 'out', load: () => Promise.reject(new Error('unused')) }
  const upstreamLoader: PreviewLoader = {
    ...noLoader,
    sourceFor: (_exec, runtimeIds) => runtimeIds.includes('src') ? srcSource : undefined,
    resolve: (source) => source === srcSource ? decodedUpstream : undefined,
  }
  const estimateBitmap = {} as ImageBitmap
  const mirrorBase = () => ({
    ...base,
    scene: scene([{ id: 'src', type: 'ImageSource' }, { id: 'a1', type: 'test.adjust' }, { id: 'a2', type: 'test.adjust' }]),
    exec: exec({ nodes: { src: {} } }),
    def: chainDef,
    resolveSchema: resolveMirrorSchemas,
    mirrorPreviews: true,
    loader: upstreamLoader,
  })

  it('propagates estimates in dependency order regardless of scene and document order', () => {
    const estimate = vi.fn(() => ({ image: estimateBitmap, width: 4, height: 3 }))
    const unordered = mirrorBase()
    const m = deriveSceneOverlays({
      ...unordered,
      scene: scene([{ id: 'a2', type: 'test.adjust' }, { id: 'a1', type: 'test.adjust' }, { id: 'src', type: 'ImageSource' }]),
      def: {
        ...chainDef,
        nodes: { a2: chainDef.nodes.a2!, a1: chainDef.nodes.a1!, src: chainDef.nodes.src! },
      },
      imageEstimator: { estimate, dispose: () => {} },
    })
    expect(m.previews['a1']).toEqual({
      kind: 'image',
      image: estimateBitmap,
      width: 4,
      height: 3,
      state: 'estimate',
    })
    expect(m.previews['a2']).toEqual(expect.objectContaining({ state: 'estimate' }))
    expect(m.previewSources['a1']).toMatchObject({ outputId: 'image', mediaKind: 'image' })
    expect(m.previewSources['a2']).toMatchObject({ outputId: 'image', mediaKind: 'image' })
    expect(estimate).toHaveBeenCalledTimes(2)
    expect(estimate).toHaveBeenNthCalledWith(1, {
      nodeId: 'a1',
      nodeType: 'test.adjust',
      binding: {
        source: GLSL_SOURCE,
        images: [{ name: 'u_image', inputId: 'image', driver: { node: 'src', output: 'out' } }],
        scalars: [{ name: 'factor', glslType: 'float', value: 1.5 }],
      },
      image: decodedUpstream.image,
      imageKey: srcSource.key,
      width: 4,
      height: 3,
    })
    expect(estimate).toHaveBeenNthCalledWith(2, {
      nodeId: 'a2',
      nodeType: 'test.adjust',
      binding: {
        source: GLSL_SOURCE,
        images: [{ name: 'u_image', inputId: 'image', driver: { node: 'a1', output: 'image' } }],
        scalars: [{ name: 'factor', glslType: 'float', value: 1.5 }],
      },
      image: estimateBitmap,
      imageKey: m.previewSources['a1']!.key,
      width: 4,
      height: 3,
    })
    expect(m.previewSources['a1']!.key).toMatch(/^mirror:sha256:[0-9a-f]{64}$/)
  })

  it('does not propagate a mirror whose represented output is ambiguous', () => {
    const ambiguousSchema = {
      ...adjustSchema,
      type: 'test.ambiguous-adjust',
      items: [
        ...adjustSchema.items,
        { kind: 'output', id: 'other', type: { kind: 'concrete', name: 'dinkster.image' } },
      ],
    } as NodeSchema
    const ambiguousDef = {
      ...chainDef,
      nodes: { ...chainDef.nodes, a1: defNode('a1', 'test.ambiguous-adjust') },
    } as GraphDef
    const estimate = vi.fn(() => ({ image: estimateBitmap, width: 4, height: 3 }))
    const m = deriveSceneOverlays({
      ...mirrorBase(),
      scene: scene([{ id: 'src', type: 'ImageSource' }, { id: 'a1', type: 'test.ambiguous-adjust' }, { id: 'a2', type: 'test.adjust' }]),
      def: ambiguousDef,
      resolveSchema: (type) => type === 'test.ambiguous-adjust' ? ambiguousSchema : resolveMirrorSchemas(type),
      imageEstimator: { estimate, dispose: () => {} },
    })
    expect(m.previews['a1']).toEqual(expect.objectContaining({ state: 'estimate' }))
    expect(m.previewSources['a1']).toBeUndefined()
    expect(m.previews['a2']).toBeUndefined()
    expect(estimate).toHaveBeenCalledTimes(1)
  })

  it('loses only the estimate when the estimator throws', () => {
    const estimate = vi.fn(() => { throw new Error('estimator failure') })
    const m = deriveSceneOverlays({ ...mirrorBase(), imageEstimator: { estimate, dispose: () => {} } })
    expect(estimate).toHaveBeenCalledTimes(1)
    expect(m.previews['a1']).toBeUndefined()
    // The rest of overlay derivation survived the throw.
    expect(m.previews['src']).toBeDefined()
  })

  it('shows nothing while the estimator is still computing', () => {
    const m = deriveSceneOverlays({
      ...mirrorBase(),
      imageEstimator: { estimate: () => undefined, dispose: () => {} },
    })
    expect(m.previews['a1']).toBeUndefined()
  })

  it('never estimates with the setting off or on frozen tabs', () => {
    const estimate = vi.fn(() => ({ image: estimateBitmap, width: 4, height: 3 }))
    const estimator = { estimate, dispose: () => {} }
    const off = deriveSceneOverlays({ ...mirrorBase(), mirrorPreviews: false, imageEstimator: estimator })
    expect(off.previews['a1']).toBeUndefined()
    const frozen = deriveSceneOverlays({ ...mirrorBase(), frozen: true, imageEstimator: estimator })
    expect(frozen.previews['a1']).toBeUndefined()
    expect(estimate).not.toHaveBeenCalled()
  })

  it('a node override off suppresses that node alone when the setting is on', () => {
    const estimate = vi.fn(() => ({ image: estimateBitmap, width: 4, height: 3 }))
    const overridden = {
      ...chainDef,
      nodes: { ...chainDef.nodes, a1: { ...chainDef.nodes[asNodeId('a1')]!, mirrorPreviews: false } },
    } as GraphDef
    const m = deriveSceneOverlays({ ...mirrorBase(), def: overridden, imageEstimator: { estimate, dispose: () => {} } })
    expect(m.previews['a1']).toBeUndefined()
    expect(estimate).not.toHaveBeenCalled()
  })

  it('a node override on estimates that node alone when the setting is off', () => {
    const estimate = vi.fn(() => ({ image: estimateBitmap, width: 4, height: 3 }))
    const overridden = {
      ...chainDef,
      nodes: { ...chainDef.nodes, a1: { ...chainDef.nodes[asNodeId('a1')]!, mirrorPreviews: true } },
    } as GraphDef
    const m = deriveSceneOverlays({
      ...mirrorBase(),
      mirrorPreviews: false,
      def: overridden,
      imageEstimator: { estimate, dispose: () => {} },
    })
    expect(m.previews['a1']).toEqual(expect.objectContaining({ state: 'estimate' }))
    expect(estimate).toHaveBeenCalledTimes(1)
    // a2 has no override: it follows the disabled setting.
    expect(m.previews['a2']).toBeUndefined()
  })

  it('a node override never bypasses the frozen-tab rule', () => {
    const estimate = vi.fn(() => ({ image: estimateBitmap, width: 4, height: 3 }))
    const overridden = {
      ...chainDef,
      nodes: { ...chainDef.nodes, a1: { ...chainDef.nodes[asNodeId('a1')]!, mirrorPreviews: true } },
    } as GraphDef
    const m = deriveSceneOverlays({
      ...mirrorBase(),
      frozen: true,
      def: overridden,
      imageEstimator: { estimate, dispose: () => {} },
    })
    expect(m.previews['a1']).toBeUndefined()
    expect(estimate).not.toHaveBeenCalled()
  })

  it('yields to current-proof imagery on the mirrored node itself', () => {
    const a1Source: PreviewSource = { key: 'preview:a1', outputId: 'image', load: () => Promise.reject(new Error('unused')) }
    const decodedOwn = { image: {} as CanvasImageSource, width: 2, height: 2 }
    const estimate = vi.fn(() => ({ image: estimateBitmap, width: 4, height: 3 }))
    const m = deriveSceneOverlays({
      ...mirrorBase(),
      exec: exec({ nodes: { src: {}, a1: {} } }),
      loader: {
        ...noLoader,
        sourceFor: (_exec, runtimeIds) =>
          runtimeIds.includes('src') ? srcSource : runtimeIds.includes('a1') ? a1Source : undefined,
        resolve: (source) => source === srcSource ? decodedUpstream : source === a1Source ? decodedOwn : undefined,
      },
      imageEstimator: { estimate, dispose: () => {} },
    })
    expect(m.previews['a1']).toBe(decodedOwn)
    // a1's REAL imagery is fair game for a2's estimate; a1 itself was
    // never estimated.
    expect(estimate).toHaveBeenCalledTimes(1)
    expect(estimate).toHaveBeenCalledWith(expect.objectContaining({ imageKey: 'preview:a1', width: 2, height: 2 }))
    expect(m.previews['a2']).toEqual(expect.objectContaining({ state: 'estimate' }))
  })

  describe('output attribution', () => {
    const twoOutputSchema: NodeSchema = {
      ...imageProducerSchema,
      type: 'TwoOutputSource',
      items: [
        { kind: 'output', id: 'out', type: { kind: 'concrete', name: 'dinkster.image' } },
        { kind: 'output', id: 'other', type: { kind: 'concrete', name: 'dinkster.image' } },
      ],
    } as unknown as NodeSchema
    /** src (two image outputs; mirror wired to `out`) -> a1 (mirrored adjust). */
    const twoOutputDef = {
      ...chainDef,
      nodes: { src: defNode('src', 'TwoOutputSource'), a1: defNode('a1', 'test.adjust') },
      links: {
        l1: {
          id: asLinkId('l1'),
          from: { node: asNodeId('src'), port: asPortId('out') },
          to: { node: asNodeId('a1'), port: asPortId('image') },
        },
      },
    } as unknown as GraphDef
    const twoOutputBase = (source: PreviewSource) => ({
      ...base,
      scene: scene([{ id: 'src', type: 'TwoOutputSource' }, { id: 'a1', type: 'test.adjust' }]),
      exec: exec({ nodes: { src: {} } }),
      def: twoOutputDef,
      resolveSchema: (type: string): NodeSchema | undefined =>
        type === 'TwoOutputSource' ? twoOutputSchema : resolveMirrorSchemas(type),
      mirrorPreviews: true,
      loader: {
        ...noLoader,
        sourceFor: (_exec: ExecutionState, runtimeIds: readonly string[]) =>
          runtimeIds.includes('src') ? source : undefined,
        resolve: (candidate: PreviewSource) => candidate === source ? decodedUpstream : undefined,
      },
    })

    it('never estimates from unattributed imagery of a multi-output producer', () => {
      const estimate = vi.fn(() => ({ image: estimateBitmap, width: 4, height: 3 }))
      const m = deriveSceneOverlays({
        ...twoOutputBase({ key: 'preview:src', load: () => Promise.reject(new Error('unused')) }),
        imageEstimator: { estimate, dispose: () => {} },
      })
      expect(m.previews['a1']).toBeUndefined()
      expect(estimate).not.toHaveBeenCalled()
    })

    it('never estimates from a one-output producer showing its selected input asset', () => {
      // A selected ASSET input is the producer's INPUT, not its produced
      // output; a crop/transform node with one output must not feed the
      // downstream mirror its raw input as if it had executed.
      const digest = `blake3:${'a'.repeat(64)}`
      const assetScene = scene([{ id: 'src', type: 'ImageSource' }, { id: 'a1', type: 'test.adjust' }])
      Object.assign(assetScene.nodes[0]! as object, {
        node: { type: 'ImageSource', values: { image: { digest, name: 'image.png', size: 10, mediaType: 'image/png', virtualPath: 'image.png' } } },
        layout: { rows: [{ kind: 'widget', valueKey: 'image', spec: { widgetType: 'ASSET' } }] },
      })
      const assetSource: PreviewSource = { key: `asset:${digest}`, mediaKind: 'image', load: () => Promise.reject(new Error('unused')) }
      const estimate = vi.fn(() => ({ image: estimateBitmap, width: 4, height: 3 }))
      const m = deriveSceneOverlays({
        ...base,
        scene: assetScene,
        def: chainDef,
        resolveSchema: resolveMirrorSchemas,
        mirrorPreviews: true,
        loader: {
          ...noLoader,
          inputAssetSource: () => assetSource,
          resolve: (candidate: PreviewSource) => candidate === assetSource ? decodedUpstream : undefined,
        },
        imageEstimator: { estimate, dispose: () => {} },
      })
      // The asset preview itself renders; the downstream estimate must not.
      expect(m.previews['src']).toEqual(expect.objectContaining({ width: 4, height: 3 }))
      expect(m.previews['a1']).toBeUndefined()
      expect(estimate).not.toHaveBeenCalled()
    })

    it('feeds an exact-output-attributed representation into a downstream mirror', () => {
      const digest = `blake3:${'a'.repeat(64)}`
      const representedSchema = {
        ...imageProducerSchema,
        type: 'RepresentedSource',
        items: [
          {
            kind: 'input', id: 'image', type: { kind: 'asset', element: { kind: 'concrete', name: 'dinkster.image' } },
            optional: false, widget: { widgetType: 'ASSET', options: {}, default: null },
          },
          {
            kind: 'output', id: 'out', type: { kind: 'concrete', name: 'dinkster.image' },
            represents: { input: 'image', rendition: 'decoded-image' },
          },
        ],
      } as NodeSchema
      const representedDef = {
        ...chainDef,
        nodes: { ...chainDef.nodes, src: defNode('src', 'RepresentedSource') },
      } as GraphDef
      const representedScene = scene([{ id: 'src', type: 'RepresentedSource' }, { id: 'a1', type: 'test.adjust' }])
      Object.assign(representedScene.nodes[0]! as object, {
        node: {
          id: 'src', type: 'RepresentedSource',
          values: { image: { digest, name: 'image.png', size: 10, mediaType: 'image/png', virtualPath: 'image.png' } },
        },
        layout: {
          width: 280,
          rows: [{ kind: 'widget', inputId: 'image', valueKey: 'image', spec: { widgetType: 'ASSET' } }],
        },
      })
      const assetSource: PreviewSource = { key: `asset:${digest}`, mediaKind: 'image', load: () => Promise.reject(new Error('unused')) }
      const estimate = vi.fn(() => ({ image: estimateBitmap, width: 4, height: 3 }))
      const m = deriveSceneOverlays({
        ...base,
        scene: representedScene,
        def: representedDef,
        resolveSchema: (type) => type === 'RepresentedSource' ? representedSchema : resolveMirrorSchemas(type),
        mirrorPreviews: true,
        loader: {
          ...noLoader,
          inputAssetSource: () => assetSource,
          resolve: (candidate) => candidate.key === assetSource.key ? decodedUpstream : undefined,
        },
        imageEstimator: { estimate, dispose: () => {} },
      })

      expect(m.previews['src']).toEqual(expect.objectContaining({ state: 'estimate' }))
      expect(m.previewSources['src']?.outputId).toBe('out')
      expect(m.previews['a1']).toEqual(expect.objectContaining({ state: 'estimate' }))
      expect(m.previewSources['a1']?.outputId).toBe('image')
      expect(estimate).toHaveBeenCalledTimes(1)
    })

    it('estimates when the displayed preview is attributed to the driven output', () => {
      const estimate = vi.fn(() => ({ image: estimateBitmap, width: 4, height: 3 }))
      const m = deriveSceneOverlays({
        ...twoOutputBase({ key: 'preview:src', outputId: 'out', load: () => Promise.reject(new Error('unused')) }),
        imageEstimator: { estimate, dispose: () => {} },
      })
      expect(m.previews['a1']).toEqual(expect.objectContaining({ state: 'estimate' }))
      expect(estimate).toHaveBeenCalledTimes(1)
    })

    it('never estimates when the displayed preview is attributed to a different output', () => {
      const estimate = vi.fn(() => ({ image: estimateBitmap, width: 4, height: 3 }))
      const m = deriveSceneOverlays({
        ...twoOutputBase({ key: 'preview:src', outputId: 'other', load: () => Promise.reject(new Error('unused')) }),
        imageEstimator: { estimate, dispose: () => {} },
      })
      expect(m.previews['a1']).toBeUndefined()
      expect(estimate).not.toHaveBeenCalled()
    })
  })
})
