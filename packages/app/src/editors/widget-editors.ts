import type { WidgetRegistry } from '@dinkster/core'
import { AssetWidgetEditor } from './AssetWidgetEditor.js'
import { AudioRecordWidgetEditor } from './AudioRecordWidgetEditor.js'
import { BoundingBoxWidgetEditor } from './BoundingBoxWidgetEditor.js'
import { CameraAngleWidgetEditor } from './CameraAngleWidgetEditor.js'
import { ColorWidgetEditor } from './ColorWidgetEditor.js'
import { ColorsWidgetEditor } from './ColorsWidgetEditor.js'
import { ComboWidgetEditor } from './ComboWidgetEditor.js'
import { Load3dWidgetEditor } from './Load3dWidgetEditor.js'
import { ImageCompareWidgetEditor } from './ImageCompareWidgetEditor.js'
import { MultiComboWidgetEditor } from './MultiComboWidgetEditor.js'
import { MarkdownWidgetEditor } from './MarkdownWidgetEditor.js'
import { MountWidgetEditor } from './MountWidgetEditor.js'
import { ResolutionWidgetEditor } from './ResolutionWidgetEditor.js'
import { SaveTargetWidgetEditor } from './SaveTargetWidgetEditor.js'
import { ScalarWidgetEditor } from './ScalarWidgetEditor.js'
import { VideoEditWidgetEditor } from './VideoEditWidgetEditor.js'
import { WebcamWidgetEditor } from './WebcamWidgetEditor.js'

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
  ['WEBCAM', WebcamWidgetEditor],
  ['LOAD_3D', Load3dWidgetEditor],
  ['MOUNT', MountWidgetEditor],
  ['VIDEO_EDIT', VideoEditWidgetEditor],
  ['BOUNDING_BOX', BoundingBoxWidgetEditor],
  ['IMAGECOMPARE', ImageCompareWidgetEditor],
  ['CAMERA_ANGLE_VIEW', CameraAngleWidgetEditor],
  ['RESOLUTION_PREVIEW', ResolutionWidgetEditor],
  ['SAVE_TARGET', SaveTargetWidgetEditor],
])

export const coreEditorFor = (widgetType: string): unknown => coreWidgetEditors.get(widgetType)

export function registerCoreWidgetEditors(registry: WidgetRegistry): void {
  for (const [widgetType, editor] of coreWidgetEditors) registry.registerEditor(widgetType, editor)
}
