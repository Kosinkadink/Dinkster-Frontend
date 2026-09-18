import type { CanvasRenderer, InteractionController, OccurrenceMutationPlanner } from '@dinkster/canvas'
import { createEffect, onCleanup } from 'solid-js'

export interface CanvasTestHandles {
  renderer: CanvasRenderer
  controller: InteractionController
  setOccurrencePlanner: (planner: OccurrenceMutationPlanner | undefined) => void
}

export function bindFocusedCanvasTestBridge(
  bridge: Partial<CanvasTestHandles>,
  handles: CanvasTestHandles,
  focused: () => boolean,
): void {
  createEffect(() => {
    if (!focused()) return
    bridge.renderer = handles.renderer
    bridge.controller = handles.controller
    bridge.setOccurrencePlanner = handles.setOccurrencePlanner
  })
  onCleanup(() => {
    if (bridge.renderer !== handles.renderer) return
    delete bridge.renderer
    delete bridge.controller
    delete bridge.setOccurrencePlanner
  })
}
