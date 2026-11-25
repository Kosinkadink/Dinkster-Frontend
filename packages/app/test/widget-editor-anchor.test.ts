import { describe, expect, it } from 'vitest'
import type { TypeExpr, WidgetSpec, WorkflowDocument } from '@dinkster/core'
import type { LayoutRow } from '@dinkster/canvas'
import type { Tab } from '../src/app-state.js'
import { inRowValueKept, tabDocumentUnchanged, widgetEditorAnchorAlive, type WidgetEditorAnchorNode } from '../src/widget-editor-anchor.js'
import type { WidgetEditorState } from '../src/WidgetEditor.js'

const assetSpec: WidgetSpec = { widgetType: 'ASSET', options: { accept: ['image/*'], kind: 'media/image' } }
const assetType = { kind: 'concrete', name: 'ASSET' } as unknown as TypeExpr
const imageType = { kind: 'concrete', name: 'comfy.IMAGE' } as unknown as TypeExpr

function widgetRow(overrides: Partial<Extract<LayoutRow, { kind: 'widget' }>> = {}): LayoutRow {
  return {
    kind: 'widget',
    y: 0,
    height: 24,
    inset: 4,
    inputId: 'files',
    valueKey: 'files',
    label: 'Files',
    type: assetType,
    viewId: 'core.asset',
    rows: 1,
    spec: assetSpec,
    ...overrides,
  } as LayoutRow
}

function node(rows: LayoutRow[], id = 'n0', at = { x: 0, y: 0 }): WidgetEditorAnchorNode {
  return { id, ...at, layout: { width: 108, rows } }
}

function editorState(overrides: Partial<WidgetEditorState> = {}): WidgetEditorState {
  return {
    tab: { id: 't0' } as Tab,
    graphId: 'g0',
    target: { kind: 'input', nodeId: 'n0', valueKey: 'files' },
    label: 'Files',
    spec: assetSpec,
    declaredType: assetType,
    multiline: false,
    rect: { x: 0, y: 0, width: 100, height: 24 },
    initial: null,
    ...overrides,
  }
}

function tab(id: string, revision: number, doc: unknown): Tab {
  return { id, store: { revision, doc } } as unknown as Tab
}

describe('tabDocumentUnchanged', () => {
  it('tracks revisions within a session', () => {
    const current = tab('t0', 3, { lineage: 'same' })
    expect(tabDocumentUnchanged(current, 3, current)).toBe(true)
    expect(tabDocumentUnchanged(current, 2, current)).toBe(false)
  })

  it('accepts an equivalent same-lineage session replacement', () => {
    const owner = tab('t0', 3, { lineage: 'same', graphs: {} })
    expect(tabDocumentUnchanged(owner, 3, tab('t0', 0, { lineage: 'same', graphs: {} }))).toBe(true)
    expect(tabDocumentUnchanged(owner, 2, tab('t0', 0, { lineage: 'same', graphs: {} }))).toBe(false)
    expect(tabDocumentUnchanged(owner, 3, tab('t0', 0, { lineage: 'same', graphs: { changed: true } }))).toBe(false)
    expect(tabDocumentUnchanged(owner, 3, tab('other', 0, { lineage: 'same', graphs: {} }))).toBe(false)
  })
})

describe('widgetEditorAnchorAlive', () => {
  it('keeps the editor when the same static row survives the rebuild', () => {
    expect(widgetEditorAnchorAlive(editorState(), [node([widgetRow()])], 't0', 'g0', undefined)).toBe(true)
  })

  it('retains a raw fallback only with an unchanged document and declared row contract', () => {
    const spec: WidgetSpec = { widgetType: 'pack.size', options: { min: 1, max: 12 } }
    const ed = editorState({ spec: undefined, anchorSpec: spec, multiline: true })
    const nodes = [node([widgetRow({ spec })])]
    expect(widgetEditorAnchorAlive(ed, nodes, 't0', 'g0', undefined, true)).toBe(true)
    expect(widgetEditorAnchorAlive(ed, nodes, 't0', 'g0', undefined, false)).toBe(false)
    const changed = [node([widgetRow({ spec: { ...spec, options: { min: 1, max: 9 } } })])]
    expect(widgetEditorAnchorAlive(ed, changed, 't0', 'g0', undefined, true)).toBe(false)
    expect(widgetEditorAnchorAlive(ed, [node([])], 't0', 'g0', undefined, true)).toBe(false)
  })

  it('matches dynamic rows on valueKey, whose elaborated id differs from inputId', () => {
    const ed = editorState({ target: { kind: 'input', nodeId: 'n0', valueKey: 'files.item[2]' } })
    const rebuilt = node([widgetRow({ inputId: 'files', valueKey: 'files.item[2]' })])
    expect(widgetEditorAnchorAlive(ed, [rebuilt], 't0', 'g0', undefined)).toBe(true)
  })

  it('closes when the rebuilt row carries a different widget spec', () => {
    const rebuilt = node([widgetRow({ spec: { widgetType: 'ASSET', options: { accept: ['video/*'], kind: 'media/video' } } })])
    expect(widgetEditorAnchorAlive(editorState(), [rebuilt], 't0', 'g0', undefined)).toBe(false)
  })

  it('closes when the rebuilt row declares a different type', () => {
    const rebuilt = node([widgetRow({ type: { kind: 'list', element: assetType } as never })])
    expect(widgetEditorAnchorAlive(editorState(), [rebuilt], 't0', 'g0', undefined)).toBe(false)
  })

  it('closes when the rebuilt row belongs to a different family owner', () => {
    const rebuilt = node([widgetRow({ familyOwner: { graphId: 'g0', nodeId: 'other', construct: 'c0' } } as never)])
    expect(widgetEditorAnchorAlive(editorState(), [rebuilt], 't0', 'g0', undefined)).toBe(false)
  })

  it('closes when the node is gone from the rebuilt scene', () => {
    expect(widgetEditorAnchorAlive(editorState(), [node([widgetRow()], 'other')], 't0', 'g0', undefined)).toBe(false)
  })

  it('closes when the rebuild belongs to another tab or graph', () => {
    const nodes = [node([widgetRow()])]
    expect(widgetEditorAnchorAlive(editorState(), nodes, 't1', 'g0', undefined)).toBe(false)
    expect(widgetEditorAnchorAlive(editorState(), nodes, 't0', 'g1', undefined)).toBe(false)
  })

  it('keeps a single-line STRING draft only while the document is unchanged', () => {
    const spec: WidgetSpec = { widgetType: 'STRING', options: {} }
    const type = { kind: 'concrete', name: 'STRING' } as unknown as TypeExpr
    const ed = editorState({ spec, declaredType: type, multiline: false })
    const nodes = [node([widgetRow({ spec, type } as never)])]
    expect(widgetEditorAnchorAlive(ed, nodes, 't0', 'g0', undefined, true)).toBe(true)
    expect(widgetEditorAnchorAlive(ed, nodes, 't0', 'g0', undefined, false)).toBe(false)
  })

  it('keeps a field open in its row across document changes while its row stays in place', () => {
    const spec: WidgetSpec = { widgetType: 'INT', options: { min: 1, max: 10000 } }
    const type = { kind: 'concrete', name: 'INT' } as unknown as TypeExpr
    // The field box: the row's 100 px box at inset 4, 2 px in from its top and bottom.
    const ed = editorState({ spec, declaredType: type, rect: { x: 54, y: 82, width: 100, height: 20 }, inRow: { look: 'flat-title', nodeTop: 0, nodeBottom: 200, storedAtOpen: 20 } })
    const row = widgetRow({ spec, type, y: 30 } as never)
    expect(widgetEditorAnchorAlive(ed, [node([row], 'n0', { x: 50, y: 50 })], 't0', 'g0', undefined, false)).toBe(true)
    expect(widgetEditorAnchorAlive(ed, [node([row], 'n0', { x: 60, y: 50 })], 't0', 'g0', undefined, false)).toBe(false)
    expect(widgetEditorAnchorAlive(ed, [node([widgetRow({ spec, type, y: 56 } as never)], 'n0', { x: 50, y: 50 })], 't0', 'g0', undefined, false)).toBe(false)
  })

  it('closes a selector open in its row when its choice changes elsewhere', () => {
    const spec: WidgetSpec = { widgetType: 'COMBO', options: { options: ['scale dimensions', 'scale by multiplier'] } }
    const type = { kind: 'concrete', name: 'COMBO' } as unknown as TypeExpr
    const selector = { construct: 'resize_type', ancestors: [] }
    const ed = editorState({
      spec, declaredType: type, initial: 'scale dimensions',
      target: { kind: 'input', nodeId: 'n0', valueKey: 'files', selector },
      rect: { x: 54, y: 82, width: 100, height: 20 },
      inRow: { look: 'flat-title', nodeTop: 0, nodeBottom: 200, storedAtOpen: null },
    })
    const row = (derivedValue: string) => widgetRow({ spec, type, y: 30, selector, derivedValue } as never)
    expect(widgetEditorAnchorAlive(ed, [node([row('scale dimensions')], 'n0', { x: 50, y: 50 })], 't0', 'g0', undefined, false)).toBe(true)
    expect(widgetEditorAnchorAlive(ed, [node([row('scale by multiplier')], 'n0', { x: 50, y: 50 })], 't0', 'g0', undefined, false)).toBe(false)
  })

  it('keeps a multiline STRING draft across document changes while its row contract survives', () => {
    const spec: WidgetSpec = { widgetType: 'STRING', options: { multiline: true } }
    const type = { kind: 'concrete', name: 'STRING' } as unknown as TypeExpr
    const ed = editorState({ spec, declaredType: type, multiline: true })
    const nodes = [node([widgetRow({ spec, type } as never)])]
    expect(widgetEditorAnchorAlive(ed, nodes, 't0', 'g0', undefined, false)).toBe(true)
  })

  it('closes when a registry change flips the multi-select decision', () => {
    // Opened multi (scalar merge arm on), rebuilt registry dropped the
    // merge provider: committing would apply stale multi semantics.
    const ed = editorState({ declaredType: imageType, mergeableTypes: ['comfy.IMAGE'] })
    const rebuilt = node([widgetRow({ type: imageType } as never)])
    expect(widgetEditorAnchorAlive(ed, [rebuilt], 't0', 'g0', undefined)).toBe(false)
    expect(widgetEditorAnchorAlive(ed, [rebuilt], 't0', 'g0', ['comfy.LATENT'])).toBe(false)
    // The reverse flip (single at open, multi now) also closes.
    const single = editorState({ declaredType: imageType, mergeableTypes: [] })
    expect(widgetEditorAnchorAlive(single, [rebuilt], 't0', 'g0', ['comfy.IMAGE'])).toBe(false)
  })

  it('survives registry churn that does not affect the multi-select decision', () => {
    const ed = editorState({ declaredType: imageType, mergeableTypes: ['comfy.IMAGE', 'comfy.LATENT'] })
    const rebuilt = node([widgetRow({ type: imageType } as never)])
    expect(widgetEditorAnchorAlive(ed, [rebuilt], 't0', 'g0', ['comfy.IMAGE'])).toBe(true)
    const singleEd = editorState({ declaredType: imageType })
    expect(widgetEditorAnchorAlive(singleEd, [rebuilt], 't0', 'g0', ['comfy.LATENT'])).toBe(true)
  })

  it('closes when the source-filename binding changes', () => {
    const binding = { inputId: 'files', role: 'media' } as never
    const ed = editorState({ sourceFilename: binding })
    expect(widgetEditorAnchorAlive(ed, [node([widgetRow({ sourceFilename: binding } as never)])], 't0', 'g0', undefined)).toBe(true)
    expect(widgetEditorAnchorAlive(ed, [node([widgetRow()])], 't0', 'g0', undefined)).toBe(false)
    expect(widgetEditorAnchorAlive(editorState(), [node([widgetRow({ sourceFilename: binding } as never)])], 't0', 'g0', undefined)).toBe(false)
  })
})

describe('inRowValueKept', () => {
  const doc = (values: Record<string, unknown>) =>
    ({ graphs: { g0: { nodes: { n0: { values } } } } }) as unknown as WorkflowDocument
  const spec: WidgetSpec = { widgetType: 'INT', options: {} }

  it('closes a field in its row only when its own stored value changes', () => {
    const ed = editorState({ spec, target: { kind: 'input', nodeId: 'n0', valueKey: 'seed' }, inRow: { look: 'flat-title', nodeTop: 0, nodeBottom: 0, storedAtOpen: 7 } })
    expect(inRowValueKept(ed, doc({ seed: 7, cfg: 9 }))).toBe(true)
    expect(inRowValueKept(ed, doc({ seed: 8 }))).toBe(false)
  })

  it('treats a value that was never stored as unchanged until one is stored', () => {
    const ed = editorState({ spec, target: { kind: 'input', nodeId: 'n0', valueKey: 'seed' }, inRow: { look: 'flat-title', nodeTop: 0, nodeBottom: 0, storedAtOpen: null } })
    expect(inRowValueKept(ed, doc({}))).toBe(true)
    expect(inRowValueKept(ed, doc({ seed: 3 }))).toBe(false)
  })

  it('leaves the card alone', () => {
    expect(inRowValueKept(editorState(), doc({ files: 'changed' }))).toBe(true)
  })
})
