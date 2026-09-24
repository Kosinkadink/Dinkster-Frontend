import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Prompt } from '../src/compile/artifact.js'
import { compile } from '../src/compile/compile.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { GraphDef, Json, JsonObject, NodeData, WorkflowDocument } from '../src/format/document.js'
import { importLitegraph, resolveImportedAssetLiterals } from '../src/format/import-litegraph.js'
import { asConnectionId, isPortEndpoint } from '../src/ids.js'
import { planReplacement } from '../src/replace/plan.js'
import { comfyAliasCatalogFromDinksterWire } from '../src/schema/comfy-alias.js'
import { parseDinksterNodes, type DinksterNodesPayload } from '../src/schema/dinkster-wire.js'
import type { NodeSchema } from '../src/schema/model.js'

const fixtureUrl = (name: string): URL => new URL(`../fixtures/workflows/minimax-h3/${name}`, import.meta.url)
const fixtureText = (name: string): string => readFileSync(fixtureUrl(name), 'utf8')
const fixture = (name: string): unknown => JSON.parse(fixtureText(name))

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

const assetRef = (name: string): JsonObject => ({
  digest: `blake3:${createHash('sha256').update(name).digest('hex')}`,
  name,
  size: 1,
  mediaType: name.endsWith('.png') ? 'image/png' : 'application/x-safetensors',
  virtualPath: name.endsWith('.png') ? `mounts/comfy-input/${name}` : `mounts/comfy-models/${name}`,
})

const errorDiagnostics = (items: readonly { readonly severity: string }[]) => items.filter((item) => item.severity === 'error')

const nodesOfType = (graph: GraphDef, type: string): NodeData[] => Object.values(graph.nodes).filter((node) => node.type === type)

// The official t2v/i2v templates nest their generation graph in one legacy
// subgraph; the importer preserves that authored definition when its boundary
// cannot be resolved against the current node schemas. Translated nodes land
// in both the subgraph's graph and the root, so document-wide unique lookups
// span every graph while link walks stay scoped to the flat graphs.
const documentNodes = (document: WorkflowDocument, type: string): NodeData[] =>
  Object.values(document.graphs).flatMap((graph) => nodesOfType(graph, type))

const onlyDocumentNode = (document: WorkflowDocument, type: string): NodeData => {
  const nodes = documentNodes(document, type)
  expect(nodes, `expected one ${type} node`).toHaveLength(1)
  return nodes[0]!
}

const mainGraph = (document: WorkflowDocument): GraphDef => {
  const candidates = Object.values(document.graphs).filter((graph) => nodesOfType(graph, 'dinkster.load_diffusion_model').length > 0)
  expect(candidates, `expected exactly one graph holding the diffusion model in ${Object.keys(document.graphs).join(', ')}`).toHaveLength(1)
  return candidates[0]!
}

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

function assertCommonValues(document: WorkflowDocument): void {
  expect(documentNodes(document, 'dinkster.load_vae').map((node) => node.values.vae)).toEqual([
    'minimax_h3_video_vae_int8_convrot.safetensors',
    'minimax_h3_audio_vae_fp32.safetensors',
  ])
  expect(onlyDocumentNode(document, 'dinkster.load_clip').values).toMatchObject({
    text_encoder: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    type: 'minimax',
  })
  expect(onlyDocumentNode(document, 'dinkster.ksampler_select').values.sampler_name).toBe('dinkster.res_multistep')
  expect(onlyDocumentNode(document, 'dinkster.basic_scheduler').values).toMatchObject({
    scheduler: 'dinkster.simple',
    denoise: 1,
  })
}

interface VariantExpectation {
  readonly enabled: boolean
  readonly fastSteps: number
  readonly lora: string
}

function assertOfficialValues(name: (typeof cases)[number], document: WorkflowDocument, variant?: VariantExpectation): void {
  assertCommonValues(document)
  const model = onlyDocumentNode(document, 'dinkster.load_diffusion_model')
  const lora = onlyDocumentNode(document, 'dinkster.load_lora_model_only')
  const noise = onlyDocumentNode(document, 'dinkster.random_noise')

  if (name === 'video_minimax_h3_t2v.json' || name === 'video_minimax_h3_i2v.json') {
    expect(model.values.diffusion_model).toBe('minimax_h3_fl2va_pruned_int8_convrot.safetensors')
    expect(lora.values).toMatchObject({
      lora: variant?.lora ?? 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
      strength_model: 1,
    })
    expect(noise.values.noise_seed).toBe(1)
    expect(onlyDocumentNode(document, 'dinkster.resolution_selector').values).toMatchObject({
      aspect_ratio: name.includes('i2v') ? '1:1 (Square)' : '16:9 (Widescreen)',
      megapixels: 0.4,
      multiple: 32,
    })
    expect(onlyDocumentNode(document, 'dinkster.minimax_h3_image_to_video').values).toMatchObject({
      width: 1344,
      height: 768,
      length: 73,
      prompt: expect.stringContaining('Vaporwave title sequence look'),
    })
    expect(documentNodes(document, 'dinkster.int').map((node) => node.values.value)).toEqual([20, variant?.fastSteps ?? 6])
    expect(onlyDocumentNode(document, 'dinkster.boolean').values.value).toBe(variant?.enabled ?? false)
    if (name.includes('i2v')) expect(onlyDocumentNode(document, 'dinkster.load_image').values.image).toBe('transparent_rgb_gaming_mouse.png')
    return
  }

  expect(model.values.diffusion_model).toBe('minimax_h3_ref2va_pruned_int8_convrot.safetensors')
  expect(lora.values).toMatchObject({
    lora: variant?.lora ?? 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
    strength_model: 1,
  })
  expect(onlyDocumentNode(document, 'dinkster.minimax_h3_reference_to_video').values).toMatchObject({
    width: 1344,
    height: 768,
    length: 124,
    ref_image_size: 'match',
  })
  expect(documentNodes(document, 'dinkster.int').map((node) => node.values.value)).toEqual([20, variant?.fastSteps ?? 4])
  expect(onlyDocumentNode(document, 'dinkster.boolean').values.value).toBe(variant?.enabled ?? false)

  if (name === 'video_minimax_h3_r2v.json') {
    expect(noise.values.noise_seed).toBe(261662374822964)
    expect(onlyDocumentNode(document, 'dinkster.string_multiline').values.value).toEqual(expect.stringContaining('Use <Picture 2> and <Picture 1> as reference frames'))
    const reference = onlyDocumentNode(document, 'dinkster.minimax_h3_reference_to_video')
    const graph = mainGraph(document)
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
  expect(onlyDocumentNode(document, 'dinkster.string_multiline').values.value).toEqual(expect.stringContaining('[Shot 4] At 00:05.000'))
  const graph = mainGraph(document)
  const guides = nodesOfType(graph, 'dinkster.minimax_h3_add_guide')
  expect(guides).toHaveLength(3)
  const guideInputs = guides.map((guide) => {
    const image = directSource(graph, guide, 'image')
    const expression = directSource(graph, guide, 'frame_idx')
    const seconds = directSource(graph, expression, 'values.a')
    return [image.values.image, seconds.values.value, expression.values.expression]
  })
  expect(guideInputs).toEqual(
    expect.arrayContaining([
      ['h3_frame_ref_2.png', 1.5, 'round (a * 24)'],
      ['h3_frame_ref_3.png', 3, 'round (a * 24)'],
      ['h3_frame_ref_4.png', 5, 'round (a * 24)'],
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

function assertPreservedSubgraph(
  name: (typeof cases)[number],
  imported: { readonly diagnostics: readonly { readonly code: string }[]; readonly document?: WorkflowDocument },
): void {
  const definitions = (fixture(name) as JsonObject)['definitions'] as JsonObject | undefined
  const subgraphs = definitions?.['subgraphs'] as readonly JsonObject[] | undefined
  const subgraphId = subgraphs?.[0]?.['id'] as string | undefined
  const unresolved = imported.diagnostics.filter((item) => item.code === 'import.subgraphs.boundaryUnresolved')
  if (subgraphId === undefined) {
    expect(unresolved, name).toEqual([])
    return
  }
  expect(unresolved, name).toHaveLength(1)
  expect(Object.keys(imported.document!.graphs), name).toContain(subgraphId)
}

const cases = ['video_minimax_h3_t2v.json', 'video_minimax_h3_i2v.json', 'video_minimax_h3_r2v.json', 'video_minimax_h3_multiframe_reference.json'] as const
const workflowTemplatesRevision = 'fc427f00097817d3f7d8099c5259837fa51e1267'

const officialFixtureHashes: Readonly<Record<(typeof cases)[number], string>> = {
  'video_minimax_h3_t2v.json': 'aeadcae30ac27d8f3bedebada670ddbc5af03efc69ec2312cc859efbf660ff45',
  'video_minimax_h3_i2v.json': 'cb269e456bc741e659919cb92019fcc9a605476af1d23868b33fa740e75a9db8',
  'video_minimax_h3_r2v.json': '466802086b46da86aaba5afe73e72f7d18dcc46f5ab79b6fad966131b840ccd8',
  'video_minimax_h3_multiframe_reference.json': '343de410ba8dda40553db5da3021b78d9b6e22a33e32f848bac41acce20a1db5',
}

const variants = [
  {
    name: 'video_minimax_h3_t2v.json', label: 'no-LoRA', enabled: false, fastSteps: 6,
    lora: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
  },
  {
    name: 'video_minimax_h3_t2v.json', label: '8-step', enabled: true, fastSteps: 8,
    lora: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
  },
  {
    name: 'video_minimax_h3_t2v.json', label: '4-step', enabled: true, fastSteps: 4,
    lora: 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
  },
  {
    name: 'video_minimax_h3_i2v.json', label: 'no-LoRA', enabled: false, fastSteps: 6,
    lora: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
  },
  {
    name: 'video_minimax_h3_i2v.json', label: '8-step', enabled: true, fastSteps: 8,
    lora: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
  },
  {
    name: 'video_minimax_h3_i2v.json', label: '4-step', enabled: true, fastSteps: 4,
    lora: 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
  },
  {
    name: 'video_minimax_h3_r2v.json', label: 'no-LoRA', enabled: false, fastSteps: 4,
    lora: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
  },
  {
    name: 'video_minimax_h3_r2v.json', label: '4-step', enabled: true, fastSteps: 4,
    lora: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
  },
  {
    name: 'video_minimax_h3_multiframe_reference.json', label: 'no-LoRA', enabled: false, fastSteps: 4,
    lora: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
  },
  {
    name: 'video_minimax_h3_multiframe_reference.json', label: '4-step', enabled: true, fastSteps: 4,
    lora: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
  },
] as const satisfies readonly ({ readonly name: (typeof cases)[number]; readonly label: string } & VariantExpectation)[]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function configureVariant(source: unknown, variant: VariantExpectation): JsonObject {
  const workflow = structuredClone(source)
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!isRecord(value)) return
    const widgets = value.widgets_values
    if (Array.isArray(widgets)) {
      if (value.type === 'LoraLoaderModelOnly') widgets[0] = variant.lora
      if (value.type === 'PrimitiveBoolean') widgets[0] = variant.enabled
      if (value.type === 'PrimitiveInt' && typeof widgets[0] === 'number' && widgets[0] !== 20)
        widgets[0] = variant.fastSteps
    }
    for (const child of Object.values(value)) visit(child)
  }
  visit(workflow)
  return workflow as JsonObject
}

function assertVariantExecution(prompt: Prompt, variant: VariantExpectation): void {
  const entriesOfType = (type: string) => Object.entries(prompt).filter(([, node]) => node.class_type === type)
  const linkedNode = (input: unknown) => Array.isArray(input) ? prompt[String(input[0])] : undefined
  const diffusion = entriesOfType('dinkster.load_diffusion_model')
  const lora = entriesOfType('dinkster.load_lora_model_only')
  expect(diffusion).toHaveLength(1)
  expect(lora).toHaveLength(1)

  const modelSelect = entriesOfType('dinkster.value.select').find(([, node]) =>
    Array.isArray(node.inputs.on_false) && node.inputs.on_false[0] === diffusion[0]![0]
    && Array.isArray(node.inputs.on_true) && node.inputs.on_true[0] === lora[0]![0])
  expect(modelSelect, 'expected false=base and true=LoRA model routing').toBeDefined()
  expect(linkedNode(modelSelect?.[1].inputs.condition)).toMatchObject({
    class_type: 'dinkster.boolean',
    inputs: { value: variant.enabled },
  })

  const scheduler = entriesOfType('dinkster.basic_scheduler')
  expect(scheduler).toHaveLength(1)
  const stepSelect = linkedNode(scheduler[0]![1].inputs.steps)
  expect(stepSelect).toMatchObject({ class_type: 'dinkster.value.select' })
  expect(linkedNode(stepSelect?.inputs.on_false)).toMatchObject({
    class_type: 'dinkster.int', inputs: { value: 20 },
  })
  expect(linkedNode(stepSelect?.inputs.on_true)).toMatchObject({
    class_type: 'dinkster.int', inputs: { value: variant.fastSteps },
  })
  expect(linkedNode(stepSelect?.inputs.condition)).toMatchObject({
    class_type: 'dinkster.boolean', inputs: { value: variant.enabled },
  })
}

describe('official MiniMax H3 workflows', () => {
  it.each(cases)('matches the pinned ComfyUI fixture hash for %s', (name) => {
    expect(createHash('sha256').update(fixtureText(name)).digest('hex'), workflowTemplatesRevision).toBe(officialFixtureHashes[name])
  })

  it.each(cases)('imports %s verbatim as an executable native document', (name) => {
    const imported = importLitegraph(fixture(name) as JsonObject, resolve, (type) => aliases.catalog.recordsByNodeClass.has(type))
    expect(errorDiagnostics(imported.diagnostics), JSON.stringify(imported.diagnostics)).toEqual([])
    assertPreservedSubgraph(name, imported)
    const document = replaceMaintainedAliases(imported.document!)
    assertOfficialValues(name, document)
    expect(
      Object.values(document.graphs)
        .flatMap((graph) => Object.values(graph.nodes))
        .filter((node) => aliases.catalog.recordsBySourceType.has(node.type)),
    ).toEqual([])

    const resolved = resolveImportedAssetLiterals(document, nativeResolve, assetRef)
    expect(resolved.unresolved).toEqual([])
    const resolvedGraph = mainGraph(resolved.document)
    expect(onlyNode(resolvedGraph, 'dinkster.load_diffusion_model').values.diffusion_model).toEqual(assetRef(
      name === 'video_minimax_h3_t2v.json' || name === 'video_minimax_h3_i2v.json'
        ? 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'
        : 'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
    ))
    expect(onlyNode(resolvedGraph, 'dinkster.load_clip').values.text_encoder).toEqual(assetRef('qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'))
    const compiled = compile({
      document: resolved.document,
      revision: 1,
      resolve: nativeResolve,
      scope: { kind: 'full' },
      connection: asConnectionId(`minimax-h3-${name}`),
      schemaHash: 'minimax-h3-official-fixture',
    })
    expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
  })

  it.each(variants)('imports the $label variant of $name through the same native path', ({ name, label: _label, ...variant }) => {
    const imported = importLitegraph(configureVariant(fixture(name), variant), resolve, (type) => aliases.catalog.recordsByNodeClass.has(type))
    expect(errorDiagnostics(imported.diagnostics), JSON.stringify(imported.diagnostics)).toEqual([])
    assertPreservedSubgraph(name, imported)
    const document = replaceMaintainedAliases(imported.document!)
    assertOfficialValues(name, document, variant)
    expect(
      Object.values(document.graphs)
        .flatMap((graph) => Object.values(graph.nodes))
        .filter((node) => aliases.catalog.recordsBySourceType.has(node.type)),
    ).toEqual([])

    const resolved = resolveImportedAssetLiterals(document, nativeResolve, assetRef)
    expect(resolved.unresolved).toEqual([])
    const compiled = compile({
      document: resolved.document,
      revision: 1,
      resolve: nativeResolve,
      scope: { kind: 'full' },
      connection: asConnectionId(`minimax-h3-${name}-${variant.enabled}-${variant.fastSteps}`),
      schemaHash: 'minimax-h3-official-variant',
    })
    expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
    if (!compiled.ok) throw new Error('unreachable')
    const assetInputs = Object.values(compiled.artifact.prompt).flatMap((node) =>
      Object.entries(node.inputs).filter(([input]) => ['diffusion_model', 'vae', 'text_encoder', 'lora', 'image'].includes(input)).map(([, value]) => value))
    expect(assetInputs.every((value) => Array.isArray(value) || typeof value !== 'string')).toBe(true)
    expect(assetInputs.some((value) => !Array.isArray(value) && typeof value === 'object' && value !== null && 'digest' in value)).toBe(true)
    if (name === 'video_minimax_h3_i2v.json') {
      expect(Object.values(compiled.artifact.prompt).filter((node) => node.class_type === 'dinkster.image.resize')).toEqual([])
    }
    assertVariantExecution(compiled.artifact.prompt, variant)
  })
})
