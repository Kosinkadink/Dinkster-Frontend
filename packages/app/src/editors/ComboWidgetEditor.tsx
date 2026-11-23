import type { Component } from 'solid-js'
import { WidgetEditorController, type WidgetEditorProps } from '../WidgetEditorController.js'
import { createComboImplementation } from './ComboEditorImplementation.js'
import { InRowListImplementation } from './InRowListEditor.js'

const ComboImplementation = createComboImplementation(false)

export const ComboWidgetEditor: Component<WidgetEditorProps> = (props) => <WidgetEditorController {...props} implementation={props.ed.inRow === undefined ? ComboImplementation : InRowListImplementation} />
