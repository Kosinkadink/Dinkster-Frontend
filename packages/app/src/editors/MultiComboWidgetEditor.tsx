import type { Component } from 'solid-js'
import { WidgetEditorController, type WidgetEditorProps } from '../WidgetEditorController.js'
import { createComboImplementation } from './ComboEditorImplementation.js'

const MultiComboImplementation = createComboImplementation(true)

export const MultiComboWidgetEditor: Component<WidgetEditorProps> = (props) => <WidgetEditorController {...props} implementation={MultiComboImplementation} />
