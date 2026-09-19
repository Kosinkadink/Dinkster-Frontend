import type { Component } from 'solid-js'
import { WidgetEditorController, type WidgetEditorProps } from '../WidgetEditorController.js'
import { createComboImplementation } from './ComboEditorImplementation.js'

const ComboImplementation = createComboImplementation(false)

export const ComboWidgetEditor: Component<WidgetEditorProps> = (props) => <WidgetEditorController {...props} implementation={ComboImplementation} />
