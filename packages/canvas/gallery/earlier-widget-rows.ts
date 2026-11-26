/**
 * The gallery's Before for widget rows: wraps a registry so its views draw
 * a row the way they did before the `raised-editors` look, for side by side
 * comparison. A color's square sits by the name, a list shows its code,
 * empty rows keep their earlier messages, and an empty number reads "null".
 * Only gallery pages use it.
 */

import {
  t,
  type SceneBuilder,
  type WidgetRegistry,
  type WidgetView,
} from '@dinkster/core'

/** Earlier empty-state messages, by view; `undefined` keeps the view's own. */
const earlierEmptyText: Readonly<Record<string, string>> = {
  'core.asset': 'no asset',
  'core.audioRecord': 'no recording',
  'core.webcam': 'no camera frame',
  'core.videoEdit': 'no edits',
}

function earlierView(view: WidgetView): WidgetView {
  return {
    ...view,
    drawCompact(ctx, value, spec, state) {
      const scene: SceneBuilder = {
        rect: (x, y, w, h, style) => {
          if (view.id === 'core.mount' && style['role'] === 'comboChevron')
            return
          ctx.rect(x, y, w, h, style)
        },
        hitRegion: (x, y, w, h, action) => ctx.hitRegion(x, y, w, h, action),
        text: (x, y, run, style) => {
          if (style['role'] !== 'widgetValue') return ctx.text(x, y, run, style)
          const {
            swatch,
            items: _items,
            placeholder,
            ...plain
          } = style
          // The earlier square showed whatever text the color held.
          const square =
            typeof swatch === 'string'
              ? swatch
              : view.id === 'core.color'
                ? run
                : undefined
          if (square !== undefined) {
            ctx.rect(0, 0.2, 0.12, 0.6, { fill: square, fixedAspect: 'square' })
            return ctx.text(x, y, run, { ...plain, reserveLeft: 16 })
          }
          if (view.id === 'core.list')
            return ctx.text(x, y, JSON.stringify(value), plain)
          if (view.id === 'core.saveTarget' && value === null)
            return ctx.text(x, y, t('saveTargetWidget.title'), plain)
          if ((view.kind === 'INT' || view.kind === 'FLOAT') && value === null)
            return ctx.text(x, y, 'null', plain)
          const empty =
            placeholder === true ? earlierEmptyText[view.id] : undefined
          ctx.text(x, y, empty ?? run, style)
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
