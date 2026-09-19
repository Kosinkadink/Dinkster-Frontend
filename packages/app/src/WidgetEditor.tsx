import type { Component } from 'solid-js'
import { ScalarWidgetEditor } from './editors/ScalarWidgetEditor.js'
import {
  WidgetEditorController,
  type WidgetEditorProps,
} from './WidgetEditorController.js'

export * from './WidgetEditorController.js'

export function WidgetEditor(props: WidgetEditorProps) {
  if (props.ed.hostUi !== undefined || props.ed.outputDescriptors !== undefined) {
    return <WidgetEditorController {...props} />
  }
  const registry = props.app.widgetRegistryForTab?.(props.ed.tab) ?? props.app.widgetRegistry
  const registered = registry?.editorFor?.(props.ed.spec?.widgetType ?? '')
  const Editor = (typeof registered === 'function' ? registered : ScalarWidgetEditor) as Component<WidgetEditorProps>
  return <Editor {...props} />
}
