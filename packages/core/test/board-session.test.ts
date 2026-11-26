import { describe, expect, it } from 'vitest'
import {
  connectSharedBoardSession, createLocalBoardSession, emptyBoard, loadBoard,
  type BoardSession, type CollabClientOp, type CollabConnection,
  type CollabConnectionEvent, type CollabServerOp, type CollabSessionDescriptor, type PostOpOutcome,
} from '../src/index.js'
import { applyOps } from '../src/commands/patch.js'
import type { Json } from '../src/format/document.js'

class Server {
  document = emptyBoard()
  revision = 0
  floor = 0
  loseReply = false
  refuseNext = false
  readonly operations: CollabServerOp[] = []
  readonly clients: { online: boolean; emit: (event: CollabConnectionEvent) => void }[] = []

  descriptor(): CollabSessionDescriptor {
    return { protocolVersion: 1, sessionId: 'board-session', scope: 'project-a',
      documentId: this.document.lineage, documentKind: 'board', revision: this.revision, snapshotRevision: this.revision }
  }

  connect() {
    const listeners = new Set<(event: CollabConnectionEvent) => void>()
    const client = { online: true, emit: (event: CollabConnectionEvent) => {
      if (client.online) for (const listener of listeners) listener(event)
    } }
    this.clients.push(client)
    const connection: CollabConnection = {
      sessionId: 'board-session',
      postOp: async (request: CollabClientOp): Promise<PostOpOutcome> => {
        if (!client.online) throw new Error('disconnected')
        const previous = this.operations.find((operation) => operation.opId === request.opId)
        if (previous !== undefined) return { kind: 'accepted', op: previous }
        if (this.refuseNext) {
          this.refuseNext = false
          return { kind: 'refused', code: 'invalid', message: 'edit refused' }
        }
        if (request.baseRevision !== this.revision) return { kind: 'stale-base', revision: this.revision }
        const next = loadBoard(applyOps(this.document as unknown as Json, request.patch))
        if (next.document === undefined) throw new Error('invalid Board patch')
        this.document = next.document
        this.revision += 1
        const operation = { ...request, revision: this.revision, timestamp: this.revision }
        this.operations.push(operation)
        for (const other of this.clients) other.emit({ kind: 'op', op: operation })
        if (this.loseReply) {
          this.loseReply = false
          throw new Error('response lost after ordering')
        }
        return { kind: 'accepted', op: operation }
      },
      fetchSnapshot: async () => ({ revision: this.revision, document: this.document }),
      fetchOps: async (after) => after < this.floor ? { kind: 'resync-required', snapshotRevision: this.revision }
        : { kind: 'ops', ops: this.operations.filter((operation) => operation.revision > after) },
      putSnapshot: async (revision) => revision === this.revision ? { kind: 'ok' } : { kind: 'conflict' },
      sendPresence: () => {},
      onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
      close: () => { client.online = false; listeners.clear() },
    }
    return {
      connection,
      disconnect: () => { client.emit({ kind: 'disconnected' }); client.online = false },
      reconnect: () => { client.online = true; client.emit({ kind: 'connected', descriptor: this.descriptor() }) },
    }
  }
}

function note(session: BoardSession, text: string): string {
  const result = session.dispatch({ command: 'board.item.add', params: { items: [
    { kind: 'note', text, rect: { x: 10, y: 30, width: 100, height: 60 } },
  ] } })
  if (!result.ok) throw new Error(result.diagnostics[0]?.message)
  return result.created[0]!
}

const move = (session: BoardSession, id: string, x: number) =>
  session.dispatch({ command: 'board.item.move', params: { moves: [{ id, x, y: 30 }] } })

async function pair(server: Server) {
  const left = server.connect()
  const right = server.connect()
  const conflicts: { origin: string; message: string }[] = []
  const options = { retryDelay: async () => {}, onConflict: (value: { origin: string; message: string }) => conflicts.push(value) }
  const a = await connectSharedBoardSession(left.connection, server.descriptor(), { ...options, actorId: 'a' })
  const b = await connectSharedBoardSession(right.connection, server.descriptor(), { ...options, actorId: 'b' })
  const settle = async () => {
    await Promise.all([a.settle(), b.settle()])
    await Promise.all([a.settle(), b.settle()])
  }
  return { a, b, left, right, conflicts, settle }
}

describe('Board sessions', () => {
  it('allocates non-recycled item identities locally', () => {
    const session = createLocalBoardSession(emptyBoard())
    const first = note(session, 'First')
    session.dispatch({ command: 'board.item.remove', params: { ids: [first] } })
    const second = note(session, 'Second')
    expect(second).not.toBe(first)
    expect(session.undo()).toBe(true)
    expect(session.redo()).toBe(true)
    expect(session.doc.order).toEqual([second])
  })

  it('rebases concurrent additions without changing returned ids, and undoes each without removing the other', async () => {
    const server = new Server()
    const { a, b, settle } = await pair(server)
    const first = note(a, 'Left')
    const second = note(b, 'Right')
    await settle()
    expect(first).not.toBe(second)
    expect(server.document.order).toEqual([first, second])
    expect(a.doc).toEqual(server.document)
    expect(b.doc).toEqual(server.document)
    expect(a.undo()).toBe(true)
    await settle()
    expect(b.doc.order).toEqual([second])
    expect(b.undo()).toBe(true)
    await settle()
    expect(server.document.order).toEqual([])
    expect(a.redo()).toBe(true)
    expect(b.redo()).toBe(true)
    await settle()
    expect(new Set(server.document.order)).toEqual(new Set([first, second]))
    expect(a.doc).toEqual(b.doc)
    a.close(); b.close()
  })

  it('owns pending caller input and carries a section member once through concurrent moves', async () => {
    const server = new Server()
    const { a, b, left, settle } = await pair(server)
    const addition = a.dispatch({ command: 'board.item.add', params: { items: [
      { kind: 'section', name: 'Section', rect: { x: 0, y: 0, width: 300, height: 200 } },
      { kind: 'note', text: 'Member', rect: { x: 20, y: 40, width: 100, height: 60 } },
    ] } })
    if (!addition.ok) throw new Error('setup refused')
    const [section, member] = addition.created as [string, string]
    await settle()
    left.disconnect()
    const moves = [{ id: section, x: 500, y: 30 }]
    a.dispatch({ command: 'board.item.move', params: { moves } })
    moves[0]!.x = 999
    b.dispatch({ command: 'board.note.edit', params: { id: member, text: 'Foreign text' } })
    await b.settle()
    left.reconnect()
    await settle()
    expect(server.document.items[section]!.rect.x).toBe(500)
    expect(server.document.items[member]).toMatchObject({ sectionId: section, text: 'Foreign text', rect: { x: 520, y: 70 } })
    expect(a.undo()).toBe(true)
    await settle()
    expect(b.doc.items[member]).toMatchObject({ sectionId: section, text: 'Foreign text', rect: { x: 20, y: 40 } })
    a.close(); b.close()
  })

  it('refuses an undo over a foreign move, then allows it after that move is undone', async () => {
    const server = new Server()
    const { a, b, settle, conflicts } = await pair(server)
    const id = note(a, 'Move me')
    await settle()
    move(a, id, 140)
    await settle()
    move(b, id, 260)
    await settle()
    expect(a.undo()).toBe(false)
    expect(a.doc.items[id]!.rect.x).toBe(260)
    expect(conflicts.at(-1)?.origin).toBe('board.undo')
    expect(b.undo()).toBe(true)
    await settle()
    expect(a.doc.items[id]!.rect.x).toBe(140)
    expect(a.undo()).toBe(true)
    await settle()
    expect(server.document.items[id]!.rect.x).toBe(10)
    a.close(); b.close()
  })

  it('drops a disconnected move after a foreign deletion, and resyncs from a pruned checkpoint', async () => {
    const server = new Server()
    const { a, b, left, settle, conflicts } = await pair(server)
    const id = note(a, 'Removed remotely')
    await settle()
    left.disconnect()
    move(a, id, 100)
    b.dispatch({ command: 'board.item.remove', params: { ids: [id] } })
    const survivor = note(b, 'Survivor')
    await b.settle()
    left.reconnect()
    await settle()
    expect(a.doc.order).toEqual([survivor])
    expect(conflicts.some((conflict) => conflict.origin === 'board.item.move')).toBe(true)
    left.disconnect()
    move(b, survivor, 450)
    await b.settle()
    server.floor = server.revision
    left.reconnect()
    await settle()
    expect(a.doc).toEqual(server.document)
    expect(a.doc.items[survivor]!.rect.x).toBe(450)
    expect(a.canUndo).toBe(false)
    a.close(); b.close()
  })

  it('recovers a lost accepted response once, and removes refused edits without poisoning the next command', async () => {
    const server = new Server()
    const { a, b, settle, conflicts } = await pair(server)
    server.loseReply = true
    const id = note(a, 'Exactly once')
    await settle()
    expect(server.revision).toBe(1)
    expect(server.document.order).toEqual([id])
    server.refuseNext = true
    move(a, id, 100)
    await settle()
    expect(a.doc.items[id]!.rect.x).toBe(10)
    expect(conflicts.at(-1)?.message).toBe('edit refused')
    move(a, id, 350)
    await settle()
    expect(b.doc.items[id]!.rect.x).toBe(350)
    expect(server.revision).toBe(2)
    a.close(); b.close()
  })
})
