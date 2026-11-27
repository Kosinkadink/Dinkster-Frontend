import { describe, expect, it } from 'vitest'
import { BoardStore, boardMediaKindOf, boardPaintOrder, emptyBoard, exposedKey, loadBoard, type BoardCardSource, type BoardItemInput } from '../src/index.js'

const digest = (n: number): string => `blake3:${n.toString(16).padStart(64, '0')}`

const everyKind: readonly BoardItemInput[] = [
  { kind: 'section', rect: { x: 0, y: 0, width: 900, height: 500 }, name: 'Round 1' },
  { kind: 'picture', rect: { x: 40, y: 60, width: 300, height: 188 }, asset: { digest: digest(1), mediaType: 'image/png', name: 'Diner 04', width: 1216, height: 760, origin: { kind: 'produced', job: 'job-1', node: '9' } } },
  { kind: 'video', rect: { x: 400, y: 60, width: 320, height: 180 }, asset: { digest: digest(2), mediaType: 'video/mp4', name: 'Push in', width: 1280, height: 720, duration: 5 } },
  { kind: 'sound', rect: { x: 1000, y: 60, width: 260, height: 72 }, asset: { digest: digest(3), mediaType: 'audio/flac', name: 'Rain', duration: 42 } },
  { kind: 'note', rect: { x: 1000, y: 200, width: 260, height: 80 }, text: 'Keep the rain on the window.' },
]

describe('board document', () => {
  it('keeps each card input independent through editing, save, reopen and undo', () => {
    const input = { graphId: 'graph/one', nodeId: 'node', inputId: 'value' }
    const otherInput = { graphId: 'graph', nodeId: 'one/node', inputId: 'value' }
    const sourceValues = { [exposedKey(input)]: { text: 'Original', options: [1, 3] } }
    const cases: readonly { kind: 'workflow' | 'blueprint'; source: BoardCardSource }[] = [
      { kind: 'workflow', source: { kind: 'library', recordId: 'saved-workflow' } },
      { kind: 'blueprint', source: { kind: 'library', recordId: 'saved-blueprint' } },
      { kind: 'blueprint', source: { kind: 'pack', packId: 'example.pack', blueprintId: 'rain', digest: `sha256:${'a'.repeat(64)}` } },
    ]
    for (const { kind, source } of cases) {
      const store = new BoardStore(emptyBoard())
      expect(store.dispatch({ command: 'board.item.add', params: { items: ['left', 'right'].map((id, index) => ({
        id, kind, name: 'Rain', source, values: sourceValues,
        rect: { x: index * 500, y: 0, width: 340, height: 240 },
      })) } }).ok).toBe(true)
      const before = store.doc
      const change = { text: 'Changed', options: [2, 5] }
      expect(store.dispatch({ command: 'board.card.input', params: { id: 'left', input, value: change } }).ok).toBe(true)
      change.options.push(9)
      expect(store.dispatch({ command: 'board.card.controller', params: { id: 'left', key: exposedKey(input), mode: 'fixed' } }).ok).toBe(true)
      expect(store.dispatch({ command: 'board.card.input', params: { id: 'left', input: otherInput, value: null } }).ok).toBe(true)
      const reopened = new BoardStore(JSON.parse(JSON.stringify(store.doc)))
      expect(reopened.doc.items['left']).toMatchObject({ source, values: {
        [exposedKey(input)]: { text: 'Changed', options: [2, 5] }, [exposedKey(otherInput)]: null,
      } })
      expect(reopened.doc.items['right']).toEqual(before.items['right'])
      expect(reopened.doc.items['left']).toMatchObject({ controllers: { [exposedKey(input)]: 'fixed' } })
      expect(sourceValues[exposedKey(input)]).toEqual({ text: 'Original', options: [1, 3] })
      expect(reopened.dispatch({ command: 'board.card.input', params: { id: 'left', input } }).ok).toBe(true)
      const reset = reopened.doc.items['left']!
      expect('values' in reset && Object.hasOwn(reset.values, exposedKey(input))).toBe(false)
      expect('controllers' in reset && Object.hasOwn(reset.controllers ?? {}, exposedKey(input))).toBe(false)
      expect(reopened.dispatch({ command: 'board.card.controller', params: { id: 'left', key: exposedKey(input), mode: 'increment' } }).ok).toBe(true)
      expect(reopened.dispatch({ command: 'board.card.input', params: { id: 'left', input } }).ok).toBe(true)
      expect(reopened.undo()).toBe(true)
      expect(reopened.doc.items['left']).toMatchObject({ controllers: { [exposedKey(input)]: 'increment' } })
      expect(reopened.undo()).toBe(true)
      expect(reopened.undo()).toBe(true)
      expect(reopened.doc).toEqual(store.doc)
      expect(store.undo()).toBe(true)
      expect(store.undo()).toBe(true)
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(before)
      expect(store.redo()).toBe(true)
      expect(store.doc.items['left']).toMatchObject({ values: { [exposedKey(input)]: { text: 'Changed', options: [2, 5] } } })
    }
  })

  it('saves and reopens every item kind unchanged, in order', () => {
    const store = new BoardStore(emptyBoard())
    const lineage = store.doc.lineage
    expect(lineage).not.toBe(emptyBoard().lineage)
    const added = store.dispatch({ command: 'board.item.add', params: { items: everyKind } })
    expect(added.ok && added.created).toEqual(['section-1', 'picture-1', 'video-1', 'sound-1', 'note-1'])
    const reopened = loadBoard(JSON.parse(JSON.stringify(store.doc)))
    expect(reopened.diagnostics).toEqual([])
    expect(reopened.document).toEqual(store.doc)
    expect(reopened.document!.lineage).toBe(lineage)
    expect(reopened.document!.items['picture-1']).toMatchObject({ asset: { name: 'Diner 04', width: 1216, origin: { kind: 'produced', job: 'job-1' } } })
    expect(reopened.document!.items['note-1']).toMatchObject({ text: 'Keep the rain on the window.' })
  })

  it('refuses a whole board with one bad item instead of dropping it', () => {
    const store = new BoardStore(emptyBoard())
    store.dispatch({ command: 'board.item.add', params: { items: everyKind } })
    const saved = JSON.parse(JSON.stringify(store.doc))
    saved.items['picture-1'].asset.digest = 'sha256:abc'
    expect(loadBoard(saved).document).toBeUndefined()
    const unlisted = JSON.parse(JSON.stringify(store.doc))
    unlisted.order.pop()
    expect(loadBoard(unlisted).diagnostics[0]!.code).toBe('board.order.invalid')
    const newer = { ...JSON.parse(JSON.stringify(store.doc)), formatVersion: 2 }
    expect(loadBoard(newer).diagnostics[0]!.code).toBe('board.version.future')
    expect(loadBoard({ ...store.doc, lineage: '' }).document).toBeUndefined()
    expect(loadBoard({ ...store.doc, camera: { x: 0, y: 0 } }).document).toBeUndefined()
    saved.items['picture-1'].asset.digest = digest(1)
    saved.items['picture-1'].playing = true
    expect(loadBoard(saved).document).toBeUndefined()
  })

  it('moves what a section holds with it, and nothing outside it', () => {
    const store = new BoardStore(emptyBoard())
    store.dispatch({ command: 'board.item.add', params: { items: everyKind } })
    const moved = store.dispatch({ command: 'board.item.move', params: { moves: [{ id: 'section-1', x: 100, y: -50 }] } })
    expect(moved.ok).toBe(true)
    const items = store.doc.items
    expect(items['section-1']!.rect).toMatchObject({ x: 100, y: -50 })
    expect(items['picture-1']!.rect).toMatchObject({ x: 140, y: 10 })
    expect(items['video-1']!.rect).toMatchObject({ x: 500, y: 10 })
    expect(items['sound-1']!.rect).toMatchObject({ x: 1000, y: 60 })
    expect(store.undo()).toBe(true)
    expect(store.doc.items['picture-1']!.rect).toMatchObject({ x: 40, y: 60 })
  })

  it('sizes, edits, removes, and undoes and redoes each step', () => {
    const store = new BoardStore(emptyBoard())
    store.dispatch({ command: 'board.item.add', params: { items: everyKind } })
    const initial = store.doc
    expect(store.dispatch({ command: 'board.item.resize', params: { id: 'picture-1', rect: { x: 40, y: 60, width: 600, height: 375 } } }).ok).toBe(true)
    expect(store.dispatch({ command: 'board.note.edit', params: { id: 'note-1', text: 'Wider shot next.' } }).ok).toBe(true)
    expect(store.dispatch({ command: 'board.section.rename', params: { id: 'section-1', name: 'Round 2' } }).ok).toBe(true)
    expect(store.dispatch({ command: 'board.item.remove', params: { ids: ['video-1', 'sound-1'] } }).ok).toBe(true)
    expect(store.doc.order).toEqual(['section-1', 'picture-1', 'note-1'])
    expect(store.dispatch({ command: 'board.item.resize', params: { id: 'picture-1', rect: { x: 0, y: 0, width: 4, height: 4 } } }).ok).toBe(false)
    for (let step = 0; step < 4; step += 1) expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(initial)
    store.redo()
    expect(store.doc.items['picture-1']!.rect.width).toBe(600)
  })

  it('keeps section membership through overlap, resize, save and undo, changing it only on item drops', () => {
    const store = new BoardStore(emptyBoard())
    store.dispatch({ command: 'board.item.add', params: { items: everyKind } })
    expect(store.doc.items['picture-1']!.sectionId).toBe('section-1')
    store.dispatch({ command: 'board.item.move', params: { moves: [{ id: 'section-1', x: 950, y: 0 }] } })
    expect(store.doc.items['sound-1']!.sectionId).toBeUndefined()
    const reopened = new BoardStore(JSON.parse(JSON.stringify(store.doc)))
    reopened.dispatch({ command: 'board.item.move', params: { moves: [{ id: 'section-1', x: 1900, y: 0 }] } })
    expect(reopened.doc.items['sound-1']!.rect.x).toBe(1000)
    expect(reopened.doc.items['picture-1']!.rect.x).toBe(1940)
    reopened.dispatch({ command: 'board.item.resize', params: { id: 'section-1', rect: { x: 900, y: 0, width: 2000, height: 500 } } })
    expect(reopened.doc.items['sound-1']!.sectionId).toBeUndefined()
    reopened.dispatch({ command: 'board.item.move', params: { moves: [{ id: 'sound-1', x: 1100, y: 70 }] } })
    expect(reopened.doc.items['sound-1']!.sectionId).toBe('section-1')
    reopened.dispatch({ command: 'board.item.move', params: { moves: [{ id: 'sound-1', x: 40, y: 70 }] } })
    expect(reopened.doc.items['sound-1']!.sectionId).toBeUndefined()
    reopened.undo()
    expect(reopened.doc.items['sound-1']!.sectionId).toBe('section-1')
    reopened.dispatch({ command: 'board.item.remove', params: { ids: ['section-1'] } })
    expect(reopened.doc.items['sound-1']!.sectionId).toBeUndefined()
    reopened.undo()
    expect(reopened.doc.items['sound-1']!.sectionId).toBe('section-1')
  })

  it('captures existing items when a section is created, and rejects missing or cyclic parents', () => {
    const store = new BoardStore(emptyBoard())
    store.dispatch({ command: 'board.item.add', params: { items: everyKind.slice(1) } })
    store.dispatch({ command: 'board.item.add', params: { items: [everyKind[0]!] } })
    expect(store.doc.items['picture-1']!.sectionId).toBe('section-1')
    expect(store.doc.items['sound-1']!.sectionId).toBeUndefined()
    store.dispatch({ command: 'board.item.add', params: { items: [{ kind: 'section', name: 'Outer', rect: { x: -20, y: -20, width: 1000, height: 600 } }] } })
    expect(store.doc.items['picture-1']!.sectionId).toBe('section-1')
    expect(store.doc.items['section-1']!.sectionId).toBe('section-2')
    store.dispatch({ command: 'board.item.move', params: { moves: [{ id: 'section-2', x: 80, y: 80 }] } })
    expect(store.doc.items['picture-1']!.rect.x).toBe(140)
    const saved = JSON.parse(JSON.stringify(store.doc))
    saved.items['section-1'].sectionId = 'section-1'
    expect(loadBoard(saved).document).toBeUndefined()
    saved.items['section-1'].sectionId = 'missing'
    expect(loadBoard(saved).document).toBeUndefined()
  })

  it('paints sections under everything, and knows which media it can show', () => {
    const store = new BoardStore(emptyBoard())
    store.dispatch({ command: 'board.item.add', params: { items: [everyKind[4]!, everyKind[0]!] } })
    expect(boardPaintOrder(store.doc).map((item) => item.kind)).toEqual(['section', 'note'])
    expect([boardMediaKindOf('image/webp'), boardMediaKindOf('video/webm'), boardMediaKindOf('audio/mpeg; codecs=mp3'), boardMediaKindOf('model/gltf-binary')])
      .toEqual(['picture', 'video', 'sound', undefined])
  })
})
