import type { WidgetRegistry } from '@dinkster/core'
import { AssetWidgetEditor } from './AssetWidgetEditor.js'
import { AudioRecordWidgetEditor } from './AudioRecordWidgetEditor.js'
import { ColorWidgetEditor } from './ColorWidgetEditor.js'
import { ColorsWidgetEditor } from './ColorsWidgetEditor.js'
import { ComboWidgetEditor } from './ComboWidgetEditor.js'
import { MultiComboWidgetEditor } from './MultiComboWidgetEditor.js'
import { MarkdownWidgetEditor } from './MarkdownWidgetEditor.js'
import { SaveTargetWidgetEditor } from './SaveTargetWidgetEditor.js'
import { ScalarWidgetEditor } from './ScalarWidgetEditor.js'
import { VideoEditWidgetEditor } from './VideoEditWidgetEditor.js'

const coreWidgetEditors = new Map<string, unknown>([
  ['INT', ScalarWidgetEditor],
  ['FLOAT', ScalarWidgetEditor],
  ['STRING', ScalarWidgetEditor],
  ['MARKDOWN', MarkdownWidgetEditor],
  ['LIST', ScalarWidgetEditor],
  ['COLOR', ColorWidgetEditor],
  ['COLORS', ColorsWidgetEditor],
  ['COMBO', ComboWidgetEditor],
  ['MULTI_COMBO', MultiComboWidgetEditor],
  ['ASSET', AssetWidgetEditor],
  ['AUDIO_RECORD', AudioRecordWidgetEditor],
  ['SAVE_TARGET', SaveTargetWidgetEditor],
  ['VIDEO_EDIT', VideoEditWidgetEditor],
])

export const coreEditorFor = (widgetType: string): unknown => coreWidgetEditors.get(widgetType)

export function registerCoreWidgetEditors(registry: WidgetRegistry): void {
  for (const [widgetType, editor] of coreWidgetEditors) registry.registerEditor(widgetType, editor)
}
