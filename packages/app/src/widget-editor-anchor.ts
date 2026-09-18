import { assetMultiSelect } from '@dinkster/core'
import type { LayoutRow, SceneValueSource } from '@dinkster/canvas'
import type { Tab } from './app-state.js'
import type { WidgetEditorState } from './WidgetEditor.js'

/** The scene-node shape the anchor check reads. */
export interface WidgetEditorAnchorNode {
  readonly id: string
  readonly layout: { readonly rows: readonly LayoutRow[] }
}

/** True across an unchanged session or an equivalent session replacement. */
export function tabDocumentUnchanged(owner: Tab, ownerRevision: number | undefined, current: Tab): boolean {
  if (owner.id !== current.id) return false
  return owner === current
    ? ownerRevision === current.store.revision
    : ownerRevision === owner.store.revision && JSON.stringify(owner.store.doc) === JSON.stringify(current.store.doc)
}

/**
 * Whether an open editor's input row still exists with the same write
 * contract in a rebuilt scene. Rows match on valueKey (the persisted key
 * editors read and write), not inputId: dynamic rows elaborate the two
 * differently. Multiline STRING input drafts survive document changes and
 * reconcile at commit. ASSET staging can also survive document changes, but
 * its multi-select decision must remain stable. Other drafts require an
 * unchanged document.
 */
export function widgetEditorAnchorAlive(
  ed: WidgetEditorState | undefined,
  nodes: readonly WidgetEditorAnchorNode[],
  tabId: string,
  graphId: string,
  currentMergeableTypes: readonly string[] | undefined,
  documentUnchanged = false,
  valueSources: readonly Pick<SceneValueSource, 'id' | 'effective'>[] = [],
): boolean {
  if (ed === undefined) return false
  if (ed.tab.id !== tabId || ed.graphId !== graphId) return false
  const target = ed.target
  if (target.kind === 'valueSource') {
    const source = valueSources.find((item) => item.id === target.valueSourceId)
    return documentUnchanged && source !== undefined &&
      JSON.stringify(source.effective.spec) === JSON.stringify(ed.spec)
  }
  const node = nodes.find((item) => item.id === target.nodeId)
  if (node === undefined) return false
  const row = node.layout.rows.find((item) => item.kind === 'widget' && item.valueKey === target.valueKey)
  if (row === undefined || row.kind !== 'widget') return false
  const sameContract = JSON.stringify(row.spec) === JSON.stringify(ed.spec) &&
    JSON.stringify(row.type) === JSON.stringify(ed.declaredType) &&
    JSON.stringify(row.familyOwner ?? null) === JSON.stringify(target.familyOwner ?? null) &&
    JSON.stringify(row.inputFamilyOwner ?? null) === JSON.stringify(target.inputFamilyOwner ?? null) &&
    JSON.stringify(row.materialize ?? null) === JSON.stringify(target.materialize ?? null) &&
    JSON.stringify(row.selector ?? null) === JSON.stringify(target.selector ?? null) &&
    JSON.stringify(row.sourceFilename ?? null) === JSON.stringify(ed.sourceFilename ?? null)
  if (!sameContract) return false
  if (ed.multiline && ed.spec?.widgetType === 'STRING') return true
  if (ed.spec?.widgetType !== 'ASSET') return documentUnchanged
  const multiAtOpen = ed.declaredType !== undefined && assetMultiSelect(ed.declaredType, ed.mergeableTypes)
  const multiNow = row.type !== undefined && assetMultiSelect(row.type, currentMergeableTypes)
  return multiAtOpen === multiNow
}
