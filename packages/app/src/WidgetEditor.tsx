import type { Component } from 'solid-js'
import { PainterWidgetEditor } from './editors/PainterWidgetEditor.js'
import { ScalarWidgetEditor } from './editors/ScalarWidgetEditor.js'
import { coreEditorFor } from './editors/widget-editors.js'
import {
  WidgetEditorController,
  type WidgetEditorProps,
} from './WidgetEditorController.js'

export * from './WidgetEditorController.js'
export {
  mediaAcceptsFile,
  unresolvedAssetBasename,
} from './editors/AssetWidgetEditor.js'
export { isInNodeTextEditor } from './editors/ScalarWidgetEditor.js'

export function WidgetEditor(props: WidgetEditorProps) {
  if (props.ed.hostUi !== undefined || props.ed.outputDescriptors !== undefined) {
    return <WidgetEditorController {...props} />
  }
  const target = props.ed.target
  if (target.kind === 'input' && (target.familyOwner?.valueKey ?? target.valueKey) === 'mask') {
    const graphId = target.familyOwner?.graphId ?? props.ed.graphId
    const nodeId = target.familyOwner?.nodeId ?? target.nodeId
    const node = props.ed.tab.store.doc.graphs[graphId]?.nodes[nodeId]
    const schema = node && props.app.registryForTab?.(props.ed.tab)?.resolve(node.type)
    if (node?.type === 'Painter' || schema?.replacements?.some((rule) => rule.from === 'Painter')) {
      return <PainterWidgetEditor {...props} />
    }
  }
  const registry = props.app.widgetRegistryForTab?.(props.ed.tab) ?? props.app.widgetRegistry
  const registered = registry?.editorFor?.(props.ed.spec?.widgetType ?? '') ?? coreEditorFor(props.ed.spec?.widgetType ?? '')
  const Editor = (typeof registered === 'function' ? registered : ScalarWidgetEditor) as Component<WidgetEditorProps>
  return <Editor {...props} />
}
