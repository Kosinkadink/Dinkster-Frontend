import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IMAGE_FIXED_POINT_SCALE, IMAGE_OPACITY_MAX,
  applyOps, invertOps, type CollabConnection, type CollabServerOp,
  type CollabSessionDescriptor, type DocumentTypeAdapter, type Json, type PatchOp,
} from '@dinkster/core'
import { createAgentDocument } from '../src/api.js'
import { agentDocumentTypes, commandsForDocumentKind } from '../src/catalog.js'
import { createToolHandlers } from '../src/mcp.js'

const transport = vi.hoisted(() => ({
  sessions: new Map<string, { descriptor: CollabSessionDescriptor; connection: CollabConnection }>(),
}))
vi.mock('@dinkster/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@dinkster/client')>(),
  CollabHttpConnection: vi.fn(function (options: { sessionId: string }) {
    return transport.sessions.get(options.sessionId)!.connection
  }),
  getCollabSession: vi.fn(async (_baseUrl: string, sessionId: string) => transport.sessions.get(sessionId)?.descriptor),
}))

const noteAdapter: DocumentTypeAdapter<{ count: number }> = {
  kind: 'example.notes',
  commandIds: new Set(['node.add']),
  load(value) {
    if (value === null || typeof value !== 'object' || !('count' in value) || typeof value.count !== 'number') {
      return { diagnostics: [{ severity: 'error', origin: 'command', code: 'note.invalid', message: 'Expected a count' }] }
    }
    return { document: { count: value.count }, diagnostics: [] }
  },
  check: () => [],
  execute(document) {
    const forward: PatchOp[] = [{ op: 'replace', path: ['count'], value: document.count + 1, oldValue: document.count }]
    return { ok: true, doc: { count: document.count + 1 }, forward, inverse: invertOps(forward), diagnostics: [] }
  },
}

const image: Json = {
  format: 'dinkster-image', formatVersion: 1, lineage: 'image-agent',
  canvas: { width: 8, height: 6, colorSpace: 'srgb', channelDepth: 8, compositing: 'premultiplied-alpha' },
  allocation: { nextOrdinal: 2 }, rootLayerIds: ['l1'], masks: {},
  layers: { l1: {
    id: 'l1', kind: 'raster', name: 'Pixels', visible: true, opacity: IMAGE_OPACITY_MAX,
    transform: { a: IMAGE_FIXED_POINT_SCALE, b: 0, c: 0, d: IMAGE_FIXED_POINT_SCALE, tx: 0, ty: 0 },
    blendMode: 'normal', clipping: 'none', maskIds: [], resourceId: 'r0',
    sourceRect: { x: 0, y: 0, width: 8, height: 6 },
  } },
  resources: { r0: {
    id: 'r0', kind: 'raster', digest: `blake3:${'a'.repeat(64)}`, byteSize: 192,
    mediaType: 'image/png', width: 8, height: 6, colorSpace: 'srgb', channelDepth: 8, alphaMode: 'straight',
  } },
}

const hosts: ReturnType<typeof createToolHandlers>[] = []
beforeAll(() => { agentDocumentTypes.register(noteAdapter) })
beforeEach(() => { transport.sessions.clear() })
afterEach(() => { for (const host of hosts.splice(0)) host.close() })

function session(documentKind: string | undefined, document: unknown) {
  const descriptor: CollabSessionDescriptor = {
    protocolVersion: 1, sessionId: 'test', scope: 'shared', documentId: 'document',
    revision: 0, snapshotRevision: 0,
    ...(documentKind === undefined ? {} : { documentKind }),
  }
  let current = document as Json
  const log: CollabServerOp[] = []
  const connection: CollabConnection = {
    sessionId: descriptor.sessionId,
    fetchSnapshot: async () => ({ revision: log.length, document: current }),
    fetchOps: async (after) => ({ kind: 'ops', ops: log.filter((op) => op.revision > after) }),
    async postOp(op) {
      expect(op.baseRevision).toBe(log.length)
      current = applyOps(current, op.patch)
      const accepted = { ...op, revision: log.length + 1, timestamp: 1 }
      log.push(accepted)
      return { kind: 'accepted', op: accepted }
    },
    putSnapshot: async () => ({ kind: 'ok' }),
    sendPresence: vi.fn(),
    onEvent(listener) { listener({ kind: 'connected', descriptor }); return () => {} },
    close: vi.fn(),
  }
  transport.sessions.set(descriptor.sessionId, { descriptor, connection })
  const host = createToolHandlers('http://test.invalid', 'agent-test')
  hosts.push(host)
  return { host, connection, log, document: () => current }
}

describe('document-kind command routing', () => {
  it.each([undefined, 'workflow', 'dinkster.workflow'])('routes %s to the full workflow registry', async (kind) => {
    const server = session(kind, createAgentDocument('workflow-agent'))
    const catalog = await server.host.handlers.commands_list(kind === undefined ? {} : { documentKind: kind })
    expect(catalog).toEqual(commandsForDocumentKind('dinkster.workflow'))
    await expect(server.host.handlers.command_dispatch({
      sessionId: 'test', command: 'node.add', params: { graphId: 'g0', type: 'Test', position: { x: 0, y: 0 } },
    })).resolves.toMatchObject({ ok: true })
    expect(server.document()).toMatchObject({ graphs: { g0: { nodes: expect.any(Object) } } })
    expect(server.log).toHaveLength(1)
  })

  it.each(['image', 'dinkster.image'])('routes %s to image commands and identity', async (kind) => {
    const server = session(kind, image)
    expect(await server.host.handlers.commands_list({ documentKind: kind })).toEqual(commandsForDocumentKind('dinkster.image'))
    await expect(server.host.handlers.command_dispatch({
      sessionId: 'test', command: 'image.layer.update', params: { layerId: 'l1', name: 'Agent layer' },
    })).resolves.toMatchObject({ ok: true })
    expect(server.document()).toMatchObject({ layers: { l1: { name: 'Agent layer' } } })
    expect(server.connection.sendPresence).toHaveBeenCalledWith(expect.objectContaining({ graph: 'image-agent', identity: expect.objectContaining({ kind: 'agent' }) }))
    await expect(server.host.handlers.command_dispatch({ sessionId: 'test', command: 'node.add', params: {} }))
      .resolves.toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'command.unknown' })] })
    expect(server.log).toHaveLength(1)
  })

  it('uses the synthetic adapter even when a command ID also exists in workflow', async () => {
    const server = session('example.notes', { count: 0 })
    await expect(server.host.handlers.commands_list({ documentKind: 'example.notes' }))
      .resolves.toEqual([expect.objectContaining({ id: 'node.add', documentKind: 'example.notes' })])
    await expect(server.host.handlers.command_dispatch({ sessionId: 'test', command: 'node.add', params: {} }))
      .resolves.toMatchObject({ ok: true })
    await expect(server.host.handlers.document_get({ sessionId: 'test' })).resolves.toEqual({ count: 1 })
    expect(server.connection.sendPresence).toHaveBeenCalledWith(expect.objectContaining({ graph: 'document' }))
    expect(server.log).toHaveLength(1)
  })

  it('refuses an unregistered document kind without reading or mutating it', async () => {
    const server = session('missing.document', { arbitrary: true })
    const read = vi.spyOn(server.connection, 'fetchSnapshot')
    await expect(server.host.handlers.commands_list({ documentKind: 'missing.document' })).rejects.toThrow('No document adapter')
    await expect(server.host.handlers.command_dispatch({ sessionId: 'test', command: 'node.add', params: {} })).rejects.toThrow('No document adapter')
    expect(read).not.toHaveBeenCalled()
    expect(server.log).toEqual([])
    expect(server.connection.close).toHaveBeenCalled()
  })
})
