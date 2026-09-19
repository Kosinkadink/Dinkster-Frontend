import type { WidgetRegistry } from '@dinkster/core'
import { AssetWidgetEditor } from './AssetWidgetEditor.js'
import { ColorWidgetEditor } from './ColorWidgetEditor.js'
import { ComboWidgetEditor } from './ComboWidgetEditor.js'
import { MultiComboWidgetEditor } from './MultiComboWidgetEditor.js'
import { SaveTargetWidgetEditor } from './SaveTargetWidgetEditor.js'
import { ScalarWidgetEditor } from './ScalarWidgetEditor.js'
import { VideoEditWidgetEditor } from './VideoEditWidgetEditor.js'

export function registerCoreWidgetEditors(registry: WidgetRegistry): void {
  registry.registerEditor('INT', ScalarWidgetEditor)
  registry.registerEditor('FLOAT', ScalarWidgetEditor)
  registry.registerEditor('STRING', ScalarWidgetEditor)
  registry.registerEditor('COLOR', ColorWidgetEditor)
  registry.registerEditor('COMBO', ComboWidgetEditor)
  registry.registerEditor('MULTI_COMBO', MultiComboWidgetEditor)
  registry.registerEditor('ASSET', AssetWidgetEditor)
  registry.registerEditor('SAVE_TARGET', SaveTargetWidgetEditor)
  registry.registerEditor('VIDEO_EDIT', VideoEditWidgetEditor)
}
