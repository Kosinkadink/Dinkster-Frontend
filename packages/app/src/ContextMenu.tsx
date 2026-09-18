/**
 * Registry-resolved context-menu presentation. The host owns open policy and
 * invocation; this component owns cascading panels, focus, keyboard movement,
 * and viewport-aware placement. A keyed host mount resets all per-open state.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { semanticDesignTokens, type MenuActionItem, type MenuItem, type MenuSubmenuItem } from '@dinkster/core'
import { Ban, CirclePlay, Copy, CopyPlus, Eye, FolderOpen, Group, Palette, SlidersHorizontal, Trash2, Ungroup, VolumeX, type LucideIcon } from 'lucide-solid'
import { placeFloatingSurface, type FloatingSurfacePlacement } from './floating-surface.js'
import { Icon } from './Icon.js'
import { menuFlat, type MenuAnchor } from './menu-target.js'

type MenuEntries = ReturnType<typeof menuFlat>

interface PanelPosition {
  readonly x: number
  readonly y: number
  readonly maxWidth: number
  readonly maxHeight: number
}

interface MenuPanel {
  readonly entries: MenuEntries
  readonly parentId?: string
  readonly ownerIndex?: number
}

interface RectLike {
  readonly left: number
  readonly top: number
  readonly right: number
}

const MENU_MARGIN = semanticDesignTokens.space[8]
const SUBMENU_GAP = semanticDesignTokens.space[4]

const MENU_ICONS: Readonly<Record<string, LucideIcon>> = {
  ban: Ban,
  'circle-play': CirclePlay,
  copy: Copy,
  'copy-plus': CopyPlus,
  eye: Eye,
  'folder-open': FolderOpen,
  group: Group,
  palette: Palette,
  'sliders-horizontal': SlidersHorizontal,
  'trash-2': Trash2,
  ungroup: Ungroup,
  'volume-x': VolumeX,
}

export function menuStep(flat: MenuEntries, from: number, delta: -1 | 1): number {
  for (let index = from + delta; index >= 0 && index < flat.length; index += delta) {
    if (flat[index]?.item.disabled !== true) return index
  }
  return from
}

export const menuHasChildren = (item: MenuItem): item is MenuSubmenuItem =>
  item.disabled !== true && item.children !== undefined && item.children.length > 0

export const menuInvokable = (item: MenuItem): item is MenuActionItem =>
  item.disabled !== true && item.action !== undefined

const firstEnabled = (entries: MenuEntries): number => {
  const found = entries.findIndex((entry) => entry.item.disabled !== true)
  return Math.max(0, found)
}

const intrinsicPanelHeight = (element: HTMLElement): number => {
  const style = getComputedStyle(element)
  return element.scrollHeight
    + (Number.parseFloat(style.borderTopWidth) || 0)
    + (Number.parseFloat(style.borderBottomWidth) || 0)
}

const placeRootPanel = (
  panel: { readonly width: number; readonly height: number },
  anchor: { readonly x: number; readonly y: number },
  bounds: { readonly width: number; readonly height: number },
): FloatingSurfacePlacement =>
  placeFloatingSurface({
    surface: panel,
    anchor: { left: anchor.x, top: anchor.y, right: anchor.x, bottom: anchor.y },
    bounds: { left: 0, top: 0, right: bounds.width, bottom: bounds.height },
    direction: 'point',
    margin: MENU_MARGIN,
    gap: 0,
    maxHeight: 400,
  })

export function rootPanelPosition(
  panel: { readonly width: number; readonly height: number },
  anchor: { readonly x: number; readonly y: number },
  bounds: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } {
  const position = placeRootPanel(panel, anchor, bounds)
  return { x: position.left, y: position.top }
}

/** Place one child panel beside its parent row, flipping left when needed. */
const placeSubmenuPanel = (
  panel: { readonly width: number; readonly height: number },
  parent: RectLike,
  bounds: { readonly width: number; readonly height: number },
): FloatingSurfacePlacement =>
  placeFloatingSurface({
    surface: panel,
    anchor: { ...parent, bottom: parent.top },
    bounds: { left: 0, top: 0, right: bounds.width, bottom: bounds.height },
    direction: 'inline',
    margin: MENU_MARGIN,
    gap: SUBMENU_GAP,
    maxHeight: 400,
  })

export function submenuPanelPosition(
  panel: { readonly width: number; readonly height: number },
  parent: RectLike,
  bounds: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } {
  const position = placeSubmenuPanel(panel, parent, bounds)
  return { x: position.left, y: position.top }
}

export function ContextMenu(props: {
  /** The host's keyed Show remounts this component per open; root groups may relabel reactively. */
  menu: MenuAnchor
  /** Invoke a terminal item; the host closes and routes its command/action. */
  onInvoke: (item: MenuActionItem) => void
  onClose: (reason?: 'escape' | 'focusout') => void
}) {
  const rootEntries = createMemo(() => menuFlat(props.menu.groups))
  const [openPath, setOpenPath] = createSignal<readonly MenuSubmenuItem[]>([])
  const [indices, setIndices] = createSignal<readonly number[]>([firstEnabled(rootEntries())])
  const [activeDepth, setActiveDepth] = createSignal(0)
  const [positions, setPositions] = createSignal<readonly PanelPosition[]>([
    { x: props.menu.x, y: props.menu.y, maxWidth: 180, maxHeight: 400 },
  ])
  let focusRoot!: HTMLDivElement
  const panelElements = new Map<number, HTMLDivElement>()
  const itemElements = new Map<string, HTMLDivElement>()
  const rootPanel: MenuPanel = { get entries() { return rootEntries() } }

  // Keep an open submenu on the corresponding items when reactive root
  // groups replace their descriptors, such as after a locale change.
  createEffect(() => {
    let entries = rootEntries()
    setOpenPath((current) => {
      const next: MenuSubmenuItem[] = []
      for (const prior of current) {
        const item = entries.find((entry) => entry.item.id === prior.id)?.item
        if (item === undefined || !menuHasChildren(item)) break
        next.push(item)
        entries = item.children.map((child) => ({ item: child, sep: false }))
      }
      return next.length === current.length && next.every((item, index) => item === current[index])
        ? current
        : next
    })
  })

  // Reuse panels while the same submenu path remains open. Their getters read
  // replacement descriptors without remounting panel DOM or losing scroll.
  const panels = createMemo<readonly MenuPanel[]>((previous) => {
    const next: MenuPanel[] = [rootPanel]
    for (const [index, item] of openPath().entries()) {
      const prior = previous[index + 1]
      const owner = next[index]!
      if (prior?.parentId === item.id) {
        next.push(prior)
      } else {
        let parent = item
        let entries = item.children.map((child) => ({ item: child, sep: false }))
        next.push({
          parentId: item.id,
          get ownerIndex() {
            return owner.entries.findIndex((entry) => entry.item.id === item.id)
          },
          get entries() {
            const current = openPath()[index]
            if (current !== undefined && current !== parent) {
              parent = current
              entries = current.children.map((child) => ({ item: child, sep: false }))
            }
            return entries
          },
        })
      }
    }
    return next
  }, [])

  const panelPosition = (depth: number): PanelPosition =>
    positions()[depth] ?? { x: props.menu.x, y: props.menu.y, maxWidth: 180, maxHeight: 400 }

  const setIndex = (depth: number, index: number): void => {
    setIndices((current) => {
      const next = [...current]
      next[depth] = index
      return next
    })
  }

  const closeAfter = (depth: number): void => {
    setOpenPath((current) => current.length > depth ? current.slice(0, depth) : current)
    setIndices((current) => current.length > depth + 1 ? current.slice(0, depth + 1) : current)
  }

  const openChildren = (depth: number, item: MenuItem, index: number, enter = false): boolean => {
    setIndex(depth, index)
    if (!menuHasChildren(item)) {
      closeAfter(depth)
      return false
    }
    const alreadyOpen = openPath()[depth] === item && openPath().length === depth + 1
    if (!alreadyOpen) {
      setOpenPath((current) => [...current.slice(0, depth), item])
      setIndices((current) => [...current.slice(0, depth + 1), firstEnabled(item.children.map((child) => ({ item: child, sep: false })))])
    }
    if (enter) setActiveDepth(depth + 1)
    return true
  }

  const positionPanels = (): void => {
    const rootElement = panelElements.get(0)
    if (!rootElement) return
    const fixed = getComputedStyle(rootElement).position === 'fixed'
    const offsetParent = fixed ? undefined : rootElement.offsetParent as HTMLElement | null
    const offsetRect = offsetParent?.getBoundingClientRect()
    const bounds = fixed
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: offsetParent?.clientWidth ?? window.innerWidth, height: offsetParent?.clientHeight ?? window.innerHeight }
    const localRect = (element: Element): RectLike => {
      const rect = element.getBoundingClientRect()
      const left = rect.left - (fixed ? 0 : offsetRect?.left ?? 0)
      const top = rect.top - (fixed ? 0 : offsetRect?.top ?? 0)
      return { left, top, right: left + rect.width }
    }
    const next: PanelPosition[] = []
    const rootPosition = placeRootPanel(
      { width: rootElement.offsetWidth, height: intrinsicPanelHeight(rootElement) },
      props.menu,
      bounds,
    )
    next.push({ x: rootPosition.left, y: rootPosition.top, maxWidth: rootPosition.maxWidth, maxHeight: rootPosition.maxHeight })
    for (let depth = 1; depth < panels().length; depth += 1) {
      const panel = panelElements.get(depth)
      const parentIndex = panels()[depth]?.ownerIndex ?? 0
      const parent = itemElements.get(`${depth - 1}:${parentIndex}`)
      if (!panel || !parent) continue
      const parentRect = localRect(parent)
      const placed = placeSubmenuPanel(
        { width: panel.offsetWidth, height: intrinsicPanelHeight(panel) },
        parentRect,
        bounds,
      )
      next[depth] = { x: placed.left, y: placed.top, maxWidth: placed.maxWidth, maxHeight: placed.maxHeight }
    }
    const current = positions()
    const changed = next.length !== current.length || next.some((position, index) => {
      const before = current[index]
      return before?.x !== position.x || before.y !== position.y || before.maxWidth !== position.maxWidth ||
        before.maxHeight !== position.maxHeight
    })
    if (changed) {
      setPositions(next)
      // Descendants above were measured from the currently rendered ancestor
      // positions. Re-measure once those new positions reach the DOM.
      queueMicrotask(positionPanels)
    }
  }

  const schedulePosition = (): void => queueMicrotask(positionPanels)

  createEffect(() => {
    openPath()
    indices()
    schedulePosition()
  })

  onMount(() => {
    schedulePosition()
    const reposition = (): void => schedulePosition()
    window.addEventListener('resize', reposition)
    queueMicrotask(() => focusRoot.focus())
    onCleanup(() => window.removeEventListener('resize', reposition))
  })

  const invokeOrOpen = (depth: number, item: MenuItem, index: number): void => {
    if (openChildren(depth, item, index, true)) return
    if (menuInvokable(item)) props.onInvoke(item)
  }

  const onMenuKeyDown = (event: KeyboardEvent): void => {
    const depth = Math.min(activeDepth(), panels().length - 1)
    const entries = panels()[depth]?.entries ?? []
    const index = Math.min(indices()[depth] ?? 0, Math.max(0, entries.length - 1))
    const entry = entries[index]
    if (event.key === 'Escape') {
      event.preventDefault()
      props.onClose('escape')
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setIndex(depth, menuStep(entries, index, event.key === 'ArrowDown' ? 1 : -1))
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const ordered = event.key === 'Home' ? entries : [...entries].reverse()
      const enabled = ordered.findIndex((candidate) => candidate.item.disabled !== true)
      if (enabled >= 0) setIndex(depth, event.key === 'Home' ? enabled : entries.length - 1 - enabled)
    } else if (event.key === 'ArrowRight' && entry) {
      if (openChildren(depth, entry.item, index, true)) event.preventDefault()
    } else if (event.key === 'ArrowLeft' && depth > 0) {
      event.preventDefault()
      closeAfter(depth - 1)
      setActiveDepth(depth - 1)
    } else if ((event.key === 'Enter' || event.key === ' ') && entry) {
      event.preventDefault()
      invokeOrOpen(depth, entry.item, index)
    }
  }

  const activeItemId = (): string => {
    const depth = Math.min(activeDepth(), panels().length - 1)
    return `context-menu-item-${depth}-${indices()[depth] ?? 0}`
  }

  return (
    <div
      class="context-menu-cascade"
      role="menu"
      tabindex="-1"
      aria-activedescendant={activeItemId()}
      ref={focusRoot}
      onKeyDown={onMenuKeyDown}
      onFocusOut={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          props.onClose('focusout')
        }
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <For each={panels()}>
        {(panel, depthAccessor) => {
          const depth = depthAccessor()
          const parentIndex = panel.ownerIndex ?? 0
          let panelElement: HTMLDivElement | undefined
          onCleanup(() => {
            if (panelElement && panelElements.get(depth) === panelElement) panelElements.delete(depth)
          })
          return (
            <div
              class="context-menu floating-surface"
              classList={{ 'context-submenu': depth > 0 }}
              data-testid={depth === 0 ? 'context-menu' : 'context-submenu'}
              data-menu-depth={depth}
              id={`context-menu-panel-${depth}`}
              role={depth === 0 ? 'presentation' : 'group'}
              aria-labelledby={depth > 0 ? `context-menu-item-${depth - 1}-${parentIndex}` : undefined}
              ref={(element) => {
                panelElement = element
                panelElements.set(depth, element)
                schedulePosition()
              }}
              style={{
                left: `${panelPosition(depth).x}px`,
                top: `${panelPosition(depth).y}px`,
                'max-width': `${panelPosition(depth).maxWidth}px`,
                'max-height': `${panelPosition(depth).maxHeight}px`,
              }}
              onScroll={schedulePosition}
            >
              <For each={panel.entries}>
                {(entry, indexAccessor) => {
                  const index = indexAccessor()
                  const hasChildren = () => menuHasChildren(entry.item)
                  const itemKey = `${depth}:${index}`
                  let itemElement: HTMLDivElement | undefined
                  onCleanup(() => {
                    if (itemElement && itemElements.get(itemKey) === itemElement) itemElements.delete(itemKey)
                  })
                  return (
                    <>
                      <Show when={entry.sep}>
                        <div class="menu-separator" role="separator" />
                      </Show>
                      <div
                        classList={{
                          'menu-item': true,
                          active: index === indices()[depth],
                          checked: entry.item.checked === true,
                          disabled: entry.item.disabled === true,
                          'has-submenu': entry.item.children !== undefined,
                        }}
                        data-testid="context-menu-item"
                        data-item-id={entry.item.id}
                        id={`context-menu-item-${depth}-${index}`}
                        role="menuitem"
                        aria-disabled={entry.item.disabled === true}
                        aria-haspopup={entry.item.children !== undefined ? 'menu' : undefined}
                        aria-expanded={hasChildren() ? openPath()[depth] === entry.item : undefined}
                        aria-controls={hasChildren() && openPath()[depth] === entry.item
                          ? `context-menu-panel-${depth + 1}`
                          : undefined}
                        ref={(element) => {
                          itemElement = element
                          itemElements.set(itemKey, element)
                        }}
                        onMouseDown={(event) => {
                          event.preventDefault()
                          invokeOrOpen(depth, entry.item, index)
                        }}
                        onMouseEnter={() => {
                          setActiveDepth(depth)
                          openChildren(depth, entry.item, index)
                        }}
                      >
                        <span class="menu-check" />
                        <Show when={entry.item.icon === undefined ? undefined : MENU_ICONS[entry.item.icon]}>
                          {(icon) => <span class="menu-icon" data-testid="menu-icon"><Icon icon={icon()} /></span>}
                        </Show>
                        <span class="menu-label">{entry.item.label}</span>
                        <Show when={entry.item.shortcut}>
                          <span class="menu-shortcut" data-testid="menu-shortcut">{entry.item.shortcut}</span>
                        </Show>
                        <Show when={entry.item.hint}>
                          <span class="menu-hint">{entry.item.hint}</span>
                        </Show>
                        <Show when={entry.item.children !== undefined}>
                          <span class="menu-submenu-caret" aria-hidden="true" />
                        </Show>
                      </div>
                    </>
                  )
                }}
              </For>
            </div>
          )
        }}
      </For>
    </div>
  )
}
