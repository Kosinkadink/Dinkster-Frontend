import { expect, it, vi } from 'vitest'
import { asLinkId, asNodeId, asPortId, coreCommandRegistry, DocumentStore, importLitegraph, parseDinksterSchema, type CompileArtifact, type Json } from '@dinkster/core'
import type { AppState, Tab } from '../src/app-state.js'
import { readEditorCurve } from '../src/in-node-editor-source.js'
import { frameBitmap, readImageCompareInput } from '../src/image-compare-frames.js'

const carriedCurve = { interpolation: 'linear', points: [{ position: 0, value: 0.12 }, { position: 0.3, value: 0.83 }, { position: 1, value: 0.44 }] }
const dormantCurve = { interpolation: 'linear', points: [{ position: 0, value: 0.9 }, { position: 1, value: 0.2 }] }

function fixture(value: Json, tap = false) {
  const schema = parseDinksterSchema('EditorSourceFixture', { body: [
    { kind: 'input', id: 'input', type: { kind: 'concrete', types: ['CURVE'] }, widget: { type: 'CURVE' } },
  ] }).schema!
  const doc = importLitegraph({ nodes: [{ id: 1, type: schema.type }], links: [] }, () => schema).document!
  const graph = doc.graphs.g0!
  const store = new DocumentStore({ ...doc, graphs: { g0: { ...graph,
    nodes: { ...graph.nodes, n1: { ...graph.nodes.n1!, values: { input: dormantCurve } },
      source: { id: asNodeId('source'), type: schema.type, values: { input: value } } },
    links: { wire: { id: asLinkId('wire'), from: tap ? { node: asNodeId('source'), tap: asPortId('input') }
      : { node: asNodeId('source'), port: asPortId('output') }, to: { node: asNodeId('n1'), port: asPortId('input') } } },
  } } }, coreCommandRegistry())
  const artifact = { snapshot: store.doc, schemaHash: 'schema', connection: 'owner',
    prompt: { runtime: { class_type: schema.type, inputs: { input: value } } },
    provenance: { toSource: { runtime: 'source' }, fromSource: {}, outputAliases: { runtime: { output: 'actual-output' } } },
  } as unknown as CompileArtifact
  let live = artifact
  let finish: (() => void) | undefined
  let pause: Promise<void> | undefined
  const values = {
    read: async <T,>(_query: unknown, _descriptor: unknown, consume: () => Promise<T>) => consume(),
    peek: async (query: unknown) => {
      expect(query).toEqual({ jobId: 'job', nodeId: 'runtime', outputId: 'actual-output' })
      return { available: true, descriptor: { typeId: 'CURVE', fingerprint: 'curve' },
        renditions: [{ kind: 'curve-points', mime: 'application/json' }] }
    },
    rendition: async () => {
      await pause
      return { available: true, mime: 'application/json', fingerprint: 'curve', bytes: new TextEncoder().encode(JSON.stringify(value)).buffer }
    },
  }
  const connection = { values: () => values, fetchAssetBytes: async () => {
    await pause
    return new Uint8Array([2, 4, 6]).buffer
  } }
  const app = { registryForTab: () => ({ resolve: () => schema }),
    backendForTab: () => ({ id: 'owner', protocol: 'dinkster', connection }),
    executionForTab: () => ({ key: 'owner:job', ref: { connection: 'owner', prompt: 'job' }, status: 'completed',
      artifact, nodes: { runtime: { state: 'completed' } }, outputs: {} }),
    compileTabCached: () => ({ ok: true, artifact: live }),
  } as unknown as AppState
  const tab = { store, graphStack: { get: () => ['g0'] }, instancePath: { get: () => [] } } as unknown as Tab
  return { app, tab, at: { graphId: 'g0', nodeId: 'n1', inputId: 'input' },
    stale: () => { live = { ...artifact, prompt: { runtime: { class_type: schema.type, inputs: { input: 99 } } } } },
    pause: () => { pause = new Promise<void>((resolve) => { finish = resolve }) }, finish: () => finish!() }
}

it('reads the exact run curve rendition, but never a stale run or dormant value', async () => {
  const { app, tab, at, stale } = fixture(carriedCurve)
  expect(await readEditorCurve(app, tab, at, new AbortController().signal)).toEqual(carriedCurve)
  stale()
  expect(await readEditorCurve(app, tab, at, new AbortController().signal)).toBeUndefined()
  expect(tab.store.doc.graphs.g0!.nodes.n1!.values.input).toEqual(dormantCurve)
})

it('does not publish a curve rendition when rewired while the read was pending', async () => {
  const setup = fixture(carriedCurve)
  setup.pause()
  const read = readEditorCurve(setup.app, setup.tab, setup.at, new AbortController().signal)
  setup.tab.store.dispatch({ command: 'link.disconnect', params: { graphId: 'g0', linkId: 'wire' } })
  setup.finish()
  expect(await read).toBeUndefined()
})

it('reads a known tapped image without any comparison execution and rejects a cancelled read', async () => {
  const asset = { digest: `blake3:${'a'.repeat(64)}`, name: 'known.png', size: 3, mediaType: 'image/png', virtualPath: 'known.png' }
  const setup = fixture(asset, true)
  const frames = await readImageCompareInput(setup.app, setup.tab, setup.at, new AbortController().signal)
  expect(frames).toHaveLength(1)
  expect([...new Uint8Array(await (frames[0]!.payload as Blob).arrayBuffer())]).toEqual([2, 4, 6])
  setup.pause()
  const abort = new AbortController()
  const read = readImageCompareInput(setup.app, setup.tab, setup.at, abort.signal)
  abort.abort()
  setup.finish()
  expect(await read).toEqual([])
})

it('renders typed numeric image taps before a run with portable channel rounding and first-batch selection', async () => {
  vi.stubGlobal('ImageData', class {
    constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
  })
  vi.stubGlobal('createImageBitmap', async (image: ImageData) => image)
  try {
    const setup = fixture({ $typed: { type: 'IMAGE', value: [
      [[[0.25, 0.75, -1, 0.5], [2, 0, 0.1, 1]]],
      [[[0, 1, 0, 1], [0, 0, 1, 1]]],
    ] } }, true)
    const frames = await readImageCompareInput(setup.app, setup.tab, setup.at, new AbortController().signal)
    expect(frames).toHaveLength(1)
    const picture = await frameBitmap(frames[0]!)
    expect(picture).toMatchObject({ width: 2, height: 1, data: new Uint8ClampedArray([64, 191, 0, 128, 255, 0, 26, 255]) })
    const malformed = fixture({ $typed: { type: 'IMAGE', value: [[[[1, 0, 0]], [[0, 1]]]] } }, true)
    expect(await readImageCompareInput(malformed.app, malformed.tab, malformed.at, new AbortController().signal)).toEqual([])
  } finally {
    vi.unstubAllGlobals()
  }
})
