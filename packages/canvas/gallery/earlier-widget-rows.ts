/**
 * The gallery's Before for widget rows: wraps a registry so its views draw
 * a row the way they did before the `raised-editors` look, for side by side
 * comparison. A color's square sits by the name, empty colors read
 * "0 colors", and an empty number reads "null". Only gallery pages use it.
 */

import type { SceneBuilder, WidgetRegistry, WidgetView } from '@dinkster/core'

function earlierView(view: WidgetView): WidgetView {
  return {
    ...view,
    drawCompact(ctx, value, spec, state) {
      const scene: SceneBuilder = {
        rect: (x, y, w, h, style) => ctx.rect(x, y, w, h, style),
        hitRegion: (x, y, w, h, action) => ctx.hitRegion(x, y, w, h, action),
        text: (x, y, run, style) => {
          if (style['role'] !== 'widgetValue') return ctx.text(x, y, run, style)
          if (typeof style['swatch'] === 'string') {
            const { swatch, ...rest } = style
            ctx.rect(0, 0.2, 0.12, 0.6, { fill: swatch, fixedAspect: 'square' })
            return ctx.text(x, y, run, { ...rest, reserveLeft: 16 })
          }
          if (view.id === 'core.colors' && run === 'No colors') {
            const { placeholder: _placeholder, ...rest } = style
            return ctx.text(x, y, '0 colors', rest)
          }
          if (
            (view.kind === 'INT' || view.kind === 'FLOAT') &&
            value === null
          ) {
            const { placeholder: _placeholder, ...rest } = style
            return ctx.text(x, y, 'null', rest)
          }
          ctx.text(x, y, run, style)
        },
      }
      view.drawCompact(scene, value, spec, state)
    },
  }
}

export function earlierWidgetRows(registry: WidgetRegistry): WidgetRegistry {
  return {
    ...registry,
    viewsFor: (kind) => registry.viewsFor(kind).map(earlierView),
  }
}
