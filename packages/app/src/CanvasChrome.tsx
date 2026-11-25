import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js'
import type { CommandOutcome } from '@dinkster/core'
import { AppWindow, Bookmark, ChevronDown, Focus, Frame, Layers, Map as MapIcon, MessageCircleWarning, Palette, Route, Workflow, type LucideIcon } from 'lucide-solid'
import { APP_EDITOR_KIND, GRAPH_EDITOR_KIND } from './editors.js'
import { Icon } from './Icon.js'
import { useAppMessage } from './locale.js'
import { ProductButton, ProductTextInput } from './ProductControls.js'
import { CanvasClosedRow } from '@dinkster/ui'
import { ProductNotice } from './ProductForm.js'

/**
 * The view and lens bar at the top left of the canvas: the view button
 * shows the active view's icon and opens the view menu; the lens button
 * names the lens only while it is not Standard.
 */
export function CanvasViewControls(props: {
  readonly drilled: boolean
  readonly disabled: boolean
  readonly activeView: string
  readonly appViewEnabled: boolean
  readonly activeLens: { readonly id: string; readonly label: string }
  readonly lenses: readonly { readonly id: string; readonly label: string; readonly description: string }[]
  readonly viewMenuOpen: boolean
  readonly lensMenuOpen: boolean
  readonly onToggleViewMenu: () => void
  readonly onToggleLensMenu: () => void
  readonly onSelectView: (kind: string) => void
  readonly onSelectLens: (id: string) => void
  readonly commandScope?: unknown
  readonly onSetAllNetsDisplay: (mode: 'noodle' | 'tags' | 'guide') => CommandOutcome | Promise<CommandOutcome | undefined> | undefined
}) {
  const message = useAppMessage()
  const [pending, setPending] = createSignal(false)
  const [refusal, setRefusal] = createSignal<string>()
  let generation = 0
  let scopeGeneration = 0
  let live = true
  let viewTrigger: HTMLButtonElement | undefined
  onCleanup(() => { live = false; generation++ })
  createEffect(() => {
    props.commandScope
    props.disabled
    scopeGeneration++
    generation++
    setPending(false)
    setRefusal(undefined)
  })
  createEffect(() => {
    props.viewMenuOpen
    generation++
    setRefusal(undefined)
  })
  const setAllNetsDisplay = async (mode: 'noodle' | 'tags' | 'guide'): Promise<void> => {
    if (pending() || props.disabled || !props.viewMenuOpen) return
    const owner = generation
    const scope = scopeGeneration
    setPending(true)
    setRefusal(undefined)
    try {
      const outcome = await props.onSetAllNetsDisplay(mode)
      if (!live || owner !== generation) return
      if (outcome?.ok) {
        props.onToggleViewMenu()
        viewTrigger?.focus()
      } else if (outcome !== undefined) {
        setRefusal(outcome.diagnostics[0]?.message ?? message('widgetEditor.commitRefused'))
      }
    } catch (error) {
      if (live && owner === generation) setRefusal(error instanceof Error ? error.message : String(error))
    } finally {
      if (live && scope === scopeGeneration) setPending(false)
    }
  }
  const appActive = () => props.activeView === APP_EDITOR_KIND
  const viewLabel = () => message(`canvas.viewControls.active.${appActive() ? 'app' : 'graph'}`)
  const lensNamed = () => props.activeLens.id !== 'standard'
  return (
    <div class="canvas-view-controls" classList={{ drilled: props.drilled }}>
      <div class="canvas-view-control">
        <ProductButton variant="ghost"
          ref={viewTrigger}
          type="button"
          class="canvas-chrome-button"
          data-testid="views-switcher"
          data-tooltip-label={props.viewMenuOpen ? undefined : message('canvas.viewControls.view.tooltip')}
          aria-label={message('canvas.viewControls.view.label', { view: viewLabel() })}
          aria-haspopup="menu"
          aria-expanded={props.viewMenuOpen}
          disabled={props.disabled}
          onClick={props.onToggleViewMenu}
        ><Icon icon={appActive() ? AppWindow : Workflow} /></ProductButton>
        <Show when={props.viewMenuOpen}>
          <div class="lens-menu view-menu" role="menu" aria-busy={pending()}>
            <Show when={refusal()}>{(text) => <ProductNotice tone="error" testId="net-display-error">{text()}</ProductNotice>}</Show>
            <div class="lens-menu-heading">{message('canvas.viewControls.heading.views')}</div>
            <ProductButton variant="ghost" role="menuitemradio" aria-checked={props.activeView === GRAPH_EDITOR_KIND} onClick={() => props.onSelectView(GRAPH_EDITOR_KIND)}><strong>{message('canvas.viewControls.active.graph')}</strong></ProductButton>
            <Show when={props.appViewEnabled}>
              <ProductButton variant="ghost" role="menuitemradio" aria-checked={appActive()} onClick={() => props.onSelectView(APP_EDITOR_KIND)}><strong>{message('canvas.viewControls.view.app')}</strong></ProductButton>
            </Show>
            <div class="lens-menu-heading">{message('canvas.viewControls.heading.namedNets')}</div>
            <ProductButton variant="ghost"
              role="menuitem"
              data-testid="net-display-all-noodle"
              disabled={pending()}
              onClick={() => { void setAllNetsDisplay('noodle') }}
            ><strong>{message('canvas.viewControls.namedNets.noodles.label')}</strong><small>{message('canvas.viewControls.namedNets.noodles.description')}</small></ProductButton>
            <ProductButton variant="ghost"
              role="menuitem"
              data-testid="net-display-all-tags"
              disabled={pending()}
              onClick={() => { void setAllNetsDisplay('tags') }}
            ><strong>{message('canvas.viewControls.namedNets.tags.label')}</strong><small>{message('canvas.viewControls.namedNets.tags.description')}</small></ProductButton>
            <ProductButton variant="ghost"
              role="menuitem"
              data-testid="net-display-all-guide"
              disabled={pending()}
              onClick={() => { void setAllNetsDisplay('guide') }}
            ><strong>{message('canvas.viewControls.namedNets.guides.label')}</strong><small>{message('canvas.viewControls.namedNets.guides.description')}</small></ProductButton>
          </div>
        </Show>
      </div>
      <span class="canvas-chrome-divider" aria-hidden="true" />
      <div class="canvas-view-control">
        <ProductButton variant="ghost"
          type="button"
          class="canvas-chrome-button canvas-lens-button"
          data-testid="lens-switcher"
          data-lens-named={lensNamed() ? 'true' : undefined}
          data-tooltip-label={props.lensMenuOpen ? undefined : message('canvas.viewControls.lens.tooltip')}
          aria-label={message('canvas.viewControls.lens.label', { lens: props.activeLens.label })}
          aria-haspopup="menu"
          aria-expanded={props.lensMenuOpen}
          onClick={props.onToggleLensMenu}
        ><Icon icon={Layers} /><Show when={lensNamed()}><span>{props.activeLens.label}</span></Show><Icon icon={ChevronDown} /></ProductButton>
        <Show when={props.lensMenuOpen}>
          <div class="lens-menu" role="menu">
            <div class="lens-menu-heading">{message('canvas.viewControls.heading.lenses')}</div>
            <For each={props.lenses}>{(lens) => <ProductButton variant="ghost" role="menuitemradio" aria-checked={props.activeLens.id === lens.id} onClick={() => props.onSelectLens(lens.id)}><strong>{lens.label}</strong><small>{lens.description}</small></ProductButton>}</For>
          </div>
        </Show>
      </div>
    </div>
  )
}

export type CanvasCornerMenu = 'minimap' | 'zoom'

/** The minimap settings switches, in menu order, by `canvas.minimap.<id>` setting. */
export const MINIMAP_SWITCHES: readonly { readonly id: string; readonly icon: LucideIcon }[] = [
  { id: 'nodes', icon: Palette },
  { id: 'noodles', icon: Route },
  { id: 'groups', icon: Frame },
  { id: 'errors', icon: MessageCircleWarning },
]

/**
 * The minimap and the bar under it, right-justified in the canvas corner.
 * The bar is as wide as its buttons: the minimap switch with its settings
 * arrow, Fit to view, and the zoom percentage, which opens the zoom menu.
 * Both menus open straight above the bar, over the minimap, which dims
 * while one is open.
 */
export function CanvasCornerControls(props: {
  readonly size: string
  readonly minimapVisible: boolean
  /** `canvas.minimap.<id>` switch values, including `bookmarks`. */
  readonly settings: Readonly<Record<string, boolean>>
  /** The view's scale: 1 is 100%. */
  readonly zoom: number
  readonly menu: CanvasCornerMenu | undefined
  /** Height cap (CSS px) that keeps an open menu inside the stage. */
  readonly menuMaxHeight?: number | undefined
  /** The keys bound to Zoom in and Zoom out, shown beside them. */
  readonly shortcuts?: { readonly zoomIn?: string | undefined; readonly zoomOut?: string | undefined }
  readonly ref?: (element: HTMLDivElement) => void
  readonly minimapRef?: (element: HTMLCanvasElement) => void
  readonly onToggleMinimap: () => void
  readonly onToggleSetting: (id: string) => void
  readonly onOpenMenu: (menu: CanvasCornerMenu) => void
  readonly onCloseMenu: () => void
  readonly onFit: () => void
  readonly onZoomBy: (factor: number) => void
  readonly onZoomTo: (scale: number) => void
}) {
  const message = useAppMessage()
  let settingsTrigger: HTMLButtonElement | undefined
  let zoomTrigger: HTMLButtonElement | undefined
  let menuElement: HTMLDivElement | undefined
  const percent = () => Math.round(props.zoom * 100)
  const [typed, setTyped] = createSignal(String(percent()))
  const [typing, setTyping] = createSignal(false)
  // Opening a menu puts the keyboard in it (on the zoom menu, its number);
  // closing returns it to the button that opened it.
  createEffect(on(() => props.menu, (menu, previous) => {
    setTyping(false)
    if (menu !== undefined) {
      queueMicrotask(() => {
        const first = menuElement?.querySelector<HTMLElement>('.dinkster-canvas-closed-row-open') ?? menuElement?.querySelector<HTMLElement>('button')
        first?.focus()
      })
    } else if (previous !== undefined) {
      queueMicrotask(() => (previous === 'zoom' ? zoomTrigger : settingsTrigger)?.focus())
    }
  }, { defer: true }))
  // Pressing the number lays a field over it, holding the number selected;
  // a typed digit starts the field with that digit.
  const startTyping = (first?: string): void => {
    setTyped(first ?? String(percent()))
    setTyping(true)
    queueMicrotask(() => {
      const field = menuElement?.querySelector<HTMLInputElement>('input')
      field?.focus()
      if (first === undefined) field?.select()
    })
  }
  const applyTyped = (): void => {
    const value = Number.parseFloat(typed().replace('%', '').trim())
    if (Number.isFinite(value) && value > 0) props.onZoomTo(value / 100)
    props.onCloseMenu()
  }
  createEffect(() => {
    props.menu
    if (menuElement) menuElement.style.maxHeight = props.menuMaxHeight === undefined ? '' : `${props.menuMaxHeight}px`
  })
  return (
    <div ref={props.ref} class="canvas-corner-controls" data-minimap-size={props.size} data-menu-open={props.menu === undefined ? undefined : 'true'}>
      <canvas
        ref={props.minimapRef}
        class="minimap"
        classList={{ hidden: !props.minimapVisible }}
        data-testid="minimap"
        data-node-colors={props.settings['nodes']}
        data-links={props.settings['noodles']}
        data-groups={props.settings['groups']}
        data-errors={props.settings['errors']}
        data-bookmarks={props.settings['bookmarks']}
      />
      <div class="canvas-corner-anchor">
        <div class="canvas-corner-bar" role="group" aria-label={message('canvas.corner.label')}>
          <span class="canvas-corner-split" data-open={props.menu === 'minimap' ? 'true' : undefined}>
            <ProductButton variant="ghost" type="button" class="canvas-chrome-button" data-testid="minimap-toggle"
              data-tooltip-label={message(props.minimapVisible ? 'canvas.corner.hideMinimap' : 'canvas.corner.showMinimap')}
              aria-label={message(props.minimapVisible ? 'canvas.corner.hideMinimap' : 'canvas.corner.showMinimap')}
              aria-pressed={props.minimapVisible}
              onClick={props.onToggleMinimap}
            ><Icon icon={MapIcon} /></ProductButton>
            <ProductButton variant="ghost" type="button" class="canvas-chrome-button canvas-corner-more" data-testid="minimap-settings"
              ref={settingsTrigger}
              data-tooltip-label={props.menu === 'minimap' ? undefined : message('canvas.corner.minimapSettings')}
              aria-label={message('canvas.corner.minimapSettings')}
              aria-expanded={props.menu === 'minimap'}
              onClick={() => props.menu === 'minimap' ? props.onCloseMenu() : props.onOpenMenu('minimap')}
            ><Icon icon={ChevronDown} /></ProductButton>
          </span>
          <span class="canvas-chrome-divider" aria-hidden="true" />
          <ProductButton variant="ghost" type="button" class="canvas-chrome-button" data-testid="canvas-fit-view"
            data-tooltip-label={message('canvas.corner.fit')}
            aria-label={message('canvas.corner.fitShortcut')}
            onClick={props.onFit}
          ><Icon icon={Focus} /></ProductButton>
          <ProductButton variant="ghost" type="button" class="canvas-chrome-button canvas-zoom-level" data-testid="canvas-zoom-level"
            ref={zoomTrigger}
            data-tooltip-label={props.menu === 'zoom' ? undefined : message('canvas.corner.zoomOptions')}
            aria-label={message('canvas.corner.zoomLabel', { percent: percent() })}
            aria-haspopup="menu"
            aria-expanded={props.menu === 'zoom'}
            onClick={() => props.menu === 'zoom' ? props.onCloseMenu() : props.onOpenMenu('zoom')}
          ><span>{percent()}%</span><Icon icon={ChevronDown} /></ProductButton>
        </div>
        <Show when={props.menu === 'minimap'}>
          <div ref={menuElement} class="minimap-menu">
            <For each={MINIMAP_SWITCHES}>{(item) => {
              const label = () => message(`canvas.corner.minimap.${item.id}`)
              return <ProductButton variant="ghost" type="button" role="switch" class="minimap-setting-row" data-testid={`minimap-toggle-${item.id}`} aria-label={label()} aria-checked={props.settings[item.id] === true} onClick={() => props.onToggleSetting(item.id)}><Icon icon={item.icon} /><span>{label()}</span><span class="minimap-switch" aria-hidden="true"><span /></span></ProductButton>
            }}</For>
            <ProductButton variant="ghost" type="button" role="switch" class="minimap-setting-row" data-testid="minimap-marker-toggle"
              aria-checked={props.settings['bookmarks'] === true}
              data-tooltip-label={message('canvas.corner.minimap.bookmarks.tooltip')}
              aria-label={message('canvas.corner.minimap.bookmarks.label')}
              onClick={() => props.onToggleSetting('bookmarks')}
            ><Icon icon={Bookmark} /><span>{message('canvas.corner.minimap.bookmarks')}</span><span class="minimap-switch" aria-hidden="true"><span /></span></ProductButton>
          </div>
        </Show>
        <Show when={props.menu === 'zoom'}>
          <div ref={menuElement} class="canvas-zoom-menu" role="menu" aria-label={message('canvas.corner.zoomOptions')} data-testid="canvas-zoom-menu" onKeyDown={(event) => {
            // A digit typed anywhere in the menu starts the number field with it.
            if (!typing() && !event.ctrlKey && !event.metaKey && !event.altKey && /^[0-9.]$/.test(event.key)) {
              event.preventDefault()
              startTyping(event.key)
            }
          }}>
            <div class="canvas-zoom-row" data-testid="canvas-zoom-row">
              <Show when={typing()} fallback={
                <CanvasClosedRow
                  label={message('canvas.corner.zoom')}
                  value={`${percent()}%`}
                  onOpen={() => startTyping()}
                  onStep={(direction) => props.onZoomBy(direction > 0 ? 1.2 : 1 / 1.2)}
                  steps={{
                    decrease: { label: message('canvas.corner.zoomOut'), detail: props.shortcuts?.zoomOut },
                    increase: { label: message('canvas.corner.zoomIn'), detail: props.shortcuts?.zoomIn },
                  }}
                />
              }>
                <label class="dinkster-canvas-field-row dinkster-canvas-closed-row canvas-zoom-field">
                  <span class="dinkster-canvas-field-label" aria-hidden="true">{message('canvas.corner.zoom')}</span>
                  <ProductTextInput
                    inputMode="decimal"
                    data-testid="canvas-zoom-input"
                    aria-label={message('canvas.corner.zoomField')}
                    value={typed()}
                    onInput={(event) => setTyped(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        applyTyped()
                      }
                    }}
                  />
                  <span aria-hidden="true">%</span>
                </label>
              </Show>
            </div>
            <ProductButton variant="ghost" type="button" role="menuitem" data-testid="canvas-zoom-in" onClick={() => props.onZoomBy(1.2)}><span>{message('canvas.corner.zoomIn')}</span><Show when={props.shortcuts?.zoomIn}>{(keys) => <span class="menu-shortcut">{keys()}</span>}</Show></ProductButton>
            <ProductButton variant="ghost" type="button" role="menuitem" data-testid="canvas-zoom-out" onClick={() => props.onZoomBy(1 / 1.2)}><span>{message('canvas.corner.zoomOut')}</span><Show when={props.shortcuts?.zoomOut}>{(keys) => <span class="menu-shortcut">{keys()}</span>}</Show></ProductButton>
            <ProductButton variant="ghost" type="button" role="menuitem" data-testid="canvas-zoom-reset" onClick={() => { props.onZoomTo(1); props.onCloseMenu() }}><span>{message('canvas.corner.zoomReset')}</span></ProductButton>
          </div>
        </Show>
      </div>
    </div>
  )
}
