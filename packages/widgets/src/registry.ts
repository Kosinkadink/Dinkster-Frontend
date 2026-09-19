/**
 * WidgetRegistry implementation. Core and packs register through the
 * SAME functions - there is no private core path (architecture: core dogfoods
 * every public registry).
 */

import type { PreviewRenderer, WidgetKind, WidgetRegistry, WidgetView } from '@dinkster/core'

export function createWidgetRegistry(): WidgetRegistry {
  const kinds = new Map<string, WidgetKind>()
  const views = new Map<string, WidgetView[]>()
  const editors = new Map<string, unknown>()
  const previews: PreviewRenderer[] = []
  return {
    registerKind(kind) {
      if (kinds.has(kind.type)) throw new Error(`widget kind '${kind.type}' already registered`)
      kinds.set(kind.type, kind)
      return () => {
        if (kinds.get(kind.type) === kind) kinds.delete(kind.type)
      }
    },
    registerView(view) {
      const list = views.get(view.kind) ?? []
      if (list.some((v) => v.id === view.id)) {
        throw new Error(`widget view '${view.id}' already registered for kind '${view.kind}'`)
      }
      views.set(view.kind, [...list, view])
      return () => {
        views.set(
          view.kind,
          (views.get(view.kind) ?? []).filter((v) => v !== view),
        )
      }
    },
    registerEditor(widgetType, editor) {
      if (editors.has(widgetType)) throw new Error(`widget editor '${widgetType}' already registered`)
      editors.set(widgetType, editor)
      return () => {
        if (editors.get(widgetType) === editor) editors.delete(widgetType)
      }
    },
    registerPreviewRenderer(r) {
      previews.push(r)
      return () => {
        const i = previews.indexOf(r)
        if (i >= 0) previews.splice(i, 1)
      }
    },
    kind: (type) => kinds.get(type),
    viewsFor: (kindType) => views.get(kindType) ?? [],
    editorFor: (widgetType) => editors.get(widgetType),
    previewRendererFor: (channel) =>
      previews.find((r) => r.fallback !== true && r.canRender(channel)) ??
      previews.find((r) => r.fallback === true && r.canRender(channel)),
  }
}
