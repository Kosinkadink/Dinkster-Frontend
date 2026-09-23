import { describe, expect, it, vi } from 'vitest'
import {
  IMAGE_DOCUMENT_FORMAT_VERSION,
  IMAGE_FIXED_POINT_SCALE,
  IMAGE_OPACITY_MAX,
  LocalDocumentTypeSession,
  asConnectionId,
  asImageLayerId,
  asImageLineageId,
  asImageResourceId,
  canonicalJson,
  imageDocumentTypeAdapter,
  imageOutputPolicyOf,
  sha256Hex,
  type ImageDocument,
  type ImageDocumentCommandInvocation,
  type Json,
} from '@dinkster/core'
import { exportImageDocumentRecipe, imageDocumentRecipeCommands } from '../src/image-document-graph.js'
import type { AppState } from '../src/app-state.js'

function document(): ImageDocument {
  return {
    format: 'dinkster-image',
    formatVersion: IMAGE_DOCUMENT_FORMAT_VERSION,
    lineage: asImageLineageId('recipe-parity'),
    canvas: {
      width: 8,
      height: 6,
      colorSpace: 'srgb',
      channelDepth: 8,
      compositing: 'premultiplied-alpha',
    },
    allocation: { nextOrdinal: 2 },
    rootLayerIds: [asImageLayerId('l1')],
    layers: {
      l1: {
        id: asImageLayerId('l1'),
        kind: 'raster',
        name: 'Pixels',
        visible: true,
        opacity: IMAGE_OPACITY_MAX,
        transform: { a: IMAGE_FIXED_POINT_SCALE, b: 0, c: 0, d: IMAGE_FIXED_POINT_SCALE, tx: 0, ty: 0 },
        blendMode: 'normal',
        clipping: 'none',
        maskIds: [],
        resourceId: asImageResourceId('r0'),
        sourceRect: { x: 0, y: 0, width: 8, height: 6 },
      },
    },
    masks: {},
    resources: {
      r0: {
        id: asImageResourceId('r0'),
        kind: 'raster',
        digest: `blake3:${'a'.repeat(64)}`,
        byteSize: 192,
        mediaType: 'image/png',
        width: 8,
        height: 6,
        colorSpace: 'srgb',
        channelDepth: 8,
        alphaMode: 'straight',
      },
    },
  }
}

function executeGraphRecipe(source: ImageDocument, commands: readonly Json[]): ImageDocument {
  const result = structuredClone(source)
  for (const value of commands) {
    const command = value as { readonly op: string; readonly id?: string; readonly changes?: Record<string, Json> }
    if (command.op === 'canvas') Object.assign(result.canvas, command.changes)
    else if (command.op === 'layer' && command.id !== undefined) Object.assign(result.layers[command.id]!, command.changes)
    else if (command.op === 'mask' && command.id !== undefined) Object.assign(result.masks[command.id]!, command.changes)
    else throw new Error(`unsupported test recipe operation: ${command.op}`)
  }
  return result
}

describe('ImageDocument graph recipe parity', () => {
  for (const invocation of [
    { command: 'image.canvas.crop', params: { x: 2, y: 1, width: 5, height: 4 } },
    { command: 'image.canvas.resize', params: { width: 5, height: 9 } },
  ] satisfies readonly ImageDocumentCommandInvocation[]) {
    it(`matches workspace and graph execution for ${invocation.command}`, () => {
      const source = document()
      const workspace = new LocalDocumentTypeSession(
        source,
        imageDocumentTypeAdapter,
      )
      expect(workspace.dispatch(invocation).ok).toBe(true)
      const commands = imageDocumentRecipeCommands(source, workspace.doc)
      expect(executeGraphRecipe(source, commands)).toEqual(workspace.doc)
      expect(executeGraphRecipe(source, commands).resources).toEqual(source.resources)
    })
  }

  it('maps output policy to graph encoding without changing layer commands', () => {
    const source = document()
    const workspace = new LocalDocumentTypeSession(
      source,
      imageDocumentTypeAdapter,
    )
    expect(workspace.dispatch({ command: 'image.output.update', params: { format: 'webp', quality: 73 } }).ok).toBe(true)
    expect(imageDocumentRecipeCommands(source, workspace.doc)).toEqual([])
    expect(imageOutputPolicyOf(workspace.doc)).toEqual({ format: 'webp', quality: 73 })
    expect(executeGraphRecipe(source, [])).toEqual(source)
  })

  it('refuses a flattened substitute when raster structure changed', () => {
    const source = document()
    const edited: ImageDocument = { ...structuredClone(source), rootLayerIds: [], layers: {} }
    expect(() => imageDocumentRecipeCommands(source, edited)).toThrow('added or removed layers')
  })

  it('exports only to the exact unchanged source tab, graph and backend', async () => {
    const source = document()
    const graph = { id: 'g0', name: 'Source', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 }
    const tab = {
      id: 'source-tab',
      graphStack: { get: () => [] },
      store: { doc: { root: 'g0', graphs: { g0: graph } } },
    }
    const dispatchTo = vi.fn(() => ({ ok: true, diagnostics: [] }))
    const app = {
      activeTab: () => tab,
      backendForTab: () => ({ id: 'backend-a' }),
      dispatchTo,
    } as unknown as AppState
    const origin = {
      connectionId: asConnectionId('backend-a'),
      sourceTabId: 'source-tab',
      graphId: 'g0',
      sourceNodeId: 'source',
      sourceOutputId: 'layers',
      expectedGraphFingerprint: sha256Hex(canonicalJson(graph)),
      document: source,
    }
    await exportImageDocumentRecipe(app, origin, source)
    expect(dispatchTo).toHaveBeenCalledWith(tab, { command: 'image.documentRecipeExport', params: expect.objectContaining({
      graphId: 'g0', sourceNodeId: 'source', sourceOutputId: 'layers', commands: '[]', format: 'png', quality: 90,
    }) })
    await expect(exportImageDocumentRecipe(app, { ...origin, sourceTabId: 'other' }, source)).rejects.toThrow('source workflow')
    await expect(exportImageDocumentRecipe(app, { ...origin, expectedGraphFingerprint: 'stale' }, source)).rejects.toThrow('source graph changed')
    await expect(exportImageDocumentRecipe(app, { ...origin, connectionId: asConnectionId('other') }, source)).rejects.toThrow('source backend changed')
  })
})
