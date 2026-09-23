import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile/compile.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { GraphDef, Json, JsonObject, NodeData, WorkflowDocument } from '../src/format/document.js'
import { importLitegraph } from '../src/format/import-litegraph.js'
import { asConnectionId, isPortEndpoint } from '../src/ids.js'
import { planReplacement } from '../src/replace/plan.js'
import { comfyAliasCatalogFromDinksterWire } from '../src/schema/comfy-alias.js'
import { parseDinksterNodes, type DinksterNodesPayload } from '../src/schema/dinkster-wire.js'
import type { NodeSchema } from '../src/schema/model.js'

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/workflows/minimax-h3/${name}`, import.meta.url), 'utf8'))

const wire = fixture('catalog-wire40.json') as DinksterNodesPayload
const native = parseDinksterNodes(wire)
expect(native.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
const aliases = comfyAliasCatalogFromDinksterWire(wire, native.schemas)
expect(aliases.diagnostics.filter((item) => item.severity === 'error')).toEqual([])

const nativeByAlias = new Map<string, NodeSchema>()
for (const schema of native.schemas.values()) for (const alias of schema.aliases ?? []) nativeByAlias.set(alias, schema)

const resolve = (type: string): NodeSchema | undefined => {
  const maintained = aliases.catalog.recordsByNodeClass.get(type) ?? aliases.catalog.recordsBySourceType.get(type)
  if (maintained) return aliases.catalog.sourceSchemas.get(maintained.source.nodeType)
  return native.schemas.get(type) ?? nativeByAlias.get(type)
}

const nativeResolve = (type: string): NodeSchema | undefined => native.schemas.get(type) ?? nativeByAlias.get(type)

const errorDiagnostics = (items: readonly { readonly severity: string }[]) => items.filter((item) => item.severity === 'error')

const nodesOfType = (graph: GraphDef, type: string): NodeData[] => Object.values(graph.nodes).filter((node) => node.type === type)

const onlyNode = (graph: GraphDef, type: string): NodeData => {
  const nodes = nodesOfType(graph, type)
  expect(nodes, `expected one ${type} node`).toHaveLength(1)
  return nodes[0]!
}

const directSource = (graph: GraphDef, node: NodeData, port: string): NodeData => {
  const link = Object.values(graph.links).find((candidate) => isPortEndpoint(candidate.to) && candidate.to.node === node.id && candidate.to.port === port)
  expect(link, `expected a direct source for ${node.type}.${port}`).toBeDefined()
  expect(isPortEndpoint(link!.from), `expected a node source for ${node.type}.${port}`).toBe(true)
  return graph.nodes[isPortEndpoint(link!.from) ? link!.from.node : '']!
}

function assertCommonValues(graph: GraphDef): void {
  expect(nodesOfType(graph, 'dinkster.load_vae').map((node) => node.values.vae)).toEqual([
    'minimax_h3_video_vae_int8_convrot.safetensors',
    'minimax_h3_audio_vae_fp32.safetensors',
  ])
  expect(onlyNode(graph, 'dinkster.load_clip').values).toMatchObject({
    text_encoder: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    type: 'minimax',
  })
  expect(onlyNode(graph, 'dinkster.ksampler_select').values.sampler_name).toBe('dinkster.res_multistep')
  expect(onlyNode(graph, 'dinkster.basic_scheduler').values).toMatchObject({
    scheduler: 'dinkster.simple',
    denoise: 1,
  })
}

function assertOfficialValues(name: (typeof cases)[number], document: WorkflowDocument): void {
  const graph = document.graphs[document.root]!
  assertCommonValues(graph)
  const model = onlyNode(graph, 'dinkster.load_diffusion_model')
  const lora = onlyNode(graph, 'dinkster.load_lora_model_only')
  const noise = onlyNode(graph, 'dinkster.random_noise')

  if (name === 'video_minimax_h3_t2v.json' || name === 'video_minimax_h3_i2v.json') {
    expect(model.values.diffusion_model).toBe('minimax_h3_fl2va_pruned_int8_convrot.safetensors')
    expect(lora.values).toMatchObject({
      lora: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
      strength_model: 1,
    })
    expect(noise.values.noise_seed).toBe(1)
    expect(onlyNode(graph, 'dinkster.resolution_selector').values).toMatchObject({
      aspect_ratio: name.includes('i2v') ? '1:1 (Square)' : '16:9 (Widescreen)',
      megapixels: 0.4,
      multiple: 32,
    })
    expect(onlyNode(graph, 'dinkster.minimax_h3_image_to_video').values).toMatchObject({
      width: 1344,
      height: 768,
      length: 73,
      prompt: expect.stringContaining('Vaporwave title sequence look'),
    })
    expect(nodesOfType(graph, 'dinkster.int').map((node) => node.values.value)).toEqual([20, 6])
    if (name.includes('i2v')) expect(onlyNode(graph, 'dinkster.load_image').values.image).toBe('transparent_rgb_gaming_mouse.png')
    return
  }

  expect(model.values.diffusion_model).toBe('minimax_h3_ref2va_pruned_int8_convrot.safetensors')
  expect(lora.values).toMatchObject({
    lora: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
    strength_model: 1,
  })
  expect(onlyNode(graph, 'dinkster.minimax_h3_reference_to_video').values).toMatchObject({
    width: 1344,
    height: 768,
    length: 124,
    ref_image_size: 'match',
  })
  expect(nodesOfType(graph, 'dinkster.int').map((node) => node.values.value)).toEqual([20, 4])

  if (name === 'video_minimax_h3_r2v.json') {
    expect(noise.values.noise_seed).toBe(261662374822964)
    expect(onlyNode(graph, 'dinkster.string_multiline').values.value).toEqual(expect.stringContaining('Use <Picture 2> and <Picture 1> as reference frames'))
    const reference = onlyNode(graph, 'dinkster.minimax_h3_reference_to_video')
    const orderedImages = Object.values(graph.links)
      .flatMap((link) => {
        if (!isPortEndpoint(link.to) || link.to.node !== reference.id || link.to.port !== 'ref_images.ref_images' || !isPortEndpoint(link.from)) return []
        return [
          {
            member: link.to.members?.[0] ?? '',
            image: graph.nodes[link.from.node]!.values.image,
          },
        ]
      })
      .sort((left, right) => left.member.localeCompare(right.member))
      .map(({ image }) => image)
    expect(orderedImages).toEqual(['red_superboy_on_city_roof.png', 'mecha_dragon_lightning.png'])
    return
  }

  expect(noise.values.noise_seed).toBe(148096032077131)
  expect(onlyNode(graph, 'dinkster.string_multiline').values.value).toEqual(expect.stringContaining('[Shot 4] At 00:05.000'))
  const guides = nodesOfType(graph, 'dinkster.minimax_h3_add_guide')
  expect(guides).toHaveLength(3)
  const guideInputs = guides.map((guide) => {
    const image = directSource(graph, guide, 'image')
    const expression = directSource(graph, guide, 'frame_idx')
    const seconds = directSource(graph, expression, 'values.a')
    return [image.values.image, seconds.values.value]
  })
  expect(guideInputs).toEqual(
    expect.arrayContaining([
      ['h3_frame_ref_2.png', 1.5],
      ['h3_frame_ref_3.png', 3],
      ['h3_frame_ref_4.png', 5],
    ]),
  )
}

function replaceMaintainedAliases(document: WorkflowDocument): WorkflowDocument {
  const store = new DocumentStore(document, coreCommandRegistry(), 200, undefined, () => ({
    kind: 'initial',
    schemaResolverFor: () => resolve,
  }))
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let replaced = false
    for (const [graphId, graph] of Object.entries(store.doc.graphs)) {
      for (const [nodeId, node] of Object.entries(graph.nodes)) {
        const record = aliases.catalog.recordsBySourceType.get(node.type)
        if (!record) continue
        if (node.type === 'comfy.ComfyMathExpression') expect(node.dynamic?.['values']?.members).toContain('a')
        const planned = planReplacement(store.doc, graphId, nodeId, record.replacement, resolve)
        expect(errorDiagnostics(planned.diagnostics), JSON.stringify(planned.diagnostics)).toEqual([])
        expect(planned.plan).toBeDefined()
        const dispatched = store.dispatch({
          command: 'node.replace',
          params: { plan: planned.plan! } as unknown as Json,
        })
        expect(dispatched.ok, JSON.stringify({ nodeId, node, record: record.id, dispatched })).toBe(true)
        replaced = true
        break
      }
      if (replaced) break
    }
    if (!replaced) return store.doc
  }
  throw new Error('maintained aliases did not converge')
}

const cases = ['video_minimax_h3_t2v.json', 'video_minimax_h3_i2v.json', 'video_minimax_h3_r2v.json', 'video_minimax_h3_multiframe_reference.json'] as const

describe('official MiniMax H3 workflows', () => {
  it.each(cases)('imports %s verbatim as an executable native document', (name) => {
    const imported = importLitegraph(fixture(name) as JsonObject, resolve, (type) => aliases.catalog.recordsByNodeClass.has(type))
    expect(errorDiagnostics(imported.diagnostics), JSON.stringify(imported.diagnostics)).toEqual([])
    const document = replaceMaintainedAliases(imported.document!)
    assertOfficialValues(name, document)
    expect(
      Object.values(document.graphs)
        .flatMap((graph) => Object.values(graph.nodes))
        .filter((node) => aliases.catalog.recordsBySourceType.has(node.type)),
    ).toEqual([])

    const compiled = compile({
      document,
      revision: 1,
      resolve: nativeResolve,
      scope: { kind: 'full' },
      connection: asConnectionId(`minimax-h3-${name}`),
      schemaHash: 'minimax-h3-official-fixture',
    })
    expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
  })
})
