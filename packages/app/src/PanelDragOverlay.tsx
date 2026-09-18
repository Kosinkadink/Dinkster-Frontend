import { For, Show, type Component, type JSX } from 'solid-js'
import { DOCK_ZONE_IDS, type DockZoneId } from './dock-layout.js'
import {
  panelDragTargetGeometry,
  type PanelDragModel,
  type PanelDragRect,
  type PanelDragTarget,
} from './panel-drag.js'
import { TabDragGhost } from './TabDragGhost.js'

const rectStyle = (rect: PanelDragRect): JSX.CSSProperties => ({
  left: `${rect.left}px`,
  top: `${rect.top}px`,
  width: `${Math.max(0, rect.right - rect.left)}px`,
  height: `${Math.max(0, rect.bottom - rect.top)}px`,
})

const targetZone = (target: PanelDragTarget): DockZoneId | undefined =>
  target.kind === 'floating' ? undefined : target.zone

const targetLabel = (target: PanelDragTarget): string | undefined => {
  if (target.kind === 'tab') return undefined
  if (target.kind === 'floating') return 'Release to float panel'
  if (target.kind === 'split') {
    return target.zone === 'bottom' ? 'Dock in right half' : 'Dock in lower half'
  }
  return `Dock in ${target.zone} zone`
}

/** One fixed top layer owns the canvas shield, ghost bars, highlight, caret, and cursor ghost. */
export function PanelDragOverlay(props: {
  readonly drag: PanelDragModel
  readonly ghostTitle: string
  readonly ghostIcon?: Component | undefined
}) {
  return (
    <div class="panel-drag-layer" data-testid="panel-drag-layer" aria-hidden="true">
      <div
        class="panel-drag-canvas-shield"
        data-testid="panel-drag-canvas-shield"
        style={rectStyle(props.drag.snapshot.canvasRect)}
      />
      <For each={DOCK_ZONE_IDS.filter((zone) => !props.drag.snapshot.zones[zone].open)}>
        {(zone) => (
          <div
            class="panel-drag-ghost"
            classList={{
              'panel-drag-ghost-active': props.drag.preview !== undefined
                && targetZone(props.drag.preview.target) === zone,
            }}
            data-testid={`panel-drag-ghost-${zone}`}
            data-zone={zone}
            style={rectStyle(props.drag.snapshot.zones[zone].ghostRect)}
          />
        )}
      </For>
      <Show when={props.drag.preview} keyed>
        {(preview) => {
          const geometry = panelDragTargetGeometry(props.drag.snapshot, props.drag.panelId, preview.target)
          return (
            <>
              <div
                class="panel-drag-target"
                data-testid="panel-drag-target"
                data-allowed={preview.allowed}
                data-kind={preview.target.kind}
                data-zone={targetZone(preview.target)}
                style={rectStyle(geometry.rect)}
              >
                <Show when={targetLabel(preview.target)}>{(label) => (
                  <span class="panel-drag-target-label">{label()}</span>
                )}</Show>
              </div>
              <Show when={geometry.caret}>{(caret) => (
                <div class="panel-drag-caret" data-testid="panel-drag-caret" style={rectStyle(caret())} />
              )}</Show>
            </>
          )
        }}
      </Show>
      <Show when={props.drag.started && !props.drag.rolledBack}>
        <TabDragGhost
          title={props.ghostTitle}
          icon={props.ghostIcon}
          x={props.drag.point.x}
          y={props.drag.point.y}
          refused={props.drag.preview?.allowed === false}
        />
      </Show>
    </div>
  )
}
