/**
 * Add-node palette: search, filters, keyboard navigation, and the
 * highlighted-entry preview (rendered node + interface listing).
 *
 * The host owns what the palette cannot know: when to open/close (controller
 * gestures), the entry
 * corpus (registry + document subgraphs + pack blueprints), what happens on
 * a pick (insert command, link-drop connect, ghost cleanup), and the
 * recently-inserted list. This component owns every per-open ephemeral:
 * query, highlight, category/kind/port filters, preview painting, and
 * anchor clamping. All of that state dies with the component when the host
 * clears the anchor - closing IS the reset.
 */

import { createEffect, createMemo, createSignal as createSolidSignal, createUniqueId, For, on, onCleanup, onMount, Show } from 'solid-js'
import {
  CanvasRenderer,
  createRegistryPainter,
  defaultTokens,
  presentedType,
  typeExprCanonicalLabel,
  typeIdDisplayLabel,
  type LinkDropContext,
  type LinkDoubleClickContext,
  type TextMeasurer,
  type WidgetMeasure,
} from '@dinkster/canvas'
import {
  autoConnectTarget,
  hasKnownLinkDropAnchorType,
  hintsMatchLinkDrop,
  hintsMatchAnyPortFilters,
  hintsMatchPortFilters,
  inputsOf,
  isDeprecated,
  outputsOf,
  parseSearchFilters,
  rankSearch,
  schemaInputTypes,
  schemaMatchesLinkDrop,
  schemaMatchesAnyPortFilters,
  schemaMatchesPortFilters,
  schemaOutputTypes,
  semanticDesignTokens,
  type NodeSchema,
  type PackBlueprintDescriptor,
  type TypeExpr,
  type WidgetRegistry,
} from '@dinkster/core'
import { placeFloatingSurface } from './floating-surface.js'
import { useAppMessage } from './locale.js'
import { palettePreviewLayout } from './palette-node-preview.js'
import { SearchInput, SearchResultGroup, SearchResultRow, SearchState } from './SearchSurface.js'

/**
 * Where the palette opens: canvas-pane CSS px for the panel anchor plus the
 * world position where the pick will land. `linkDrop` narrows the corpus to
 * compatible entries and makes the pick also connect the dangling noodle.
 */
export interface PaletteAnchor {
  readonly x: number
  readonly y: number
  readonly worldX: number
  readonly worldY: number
  readonly linkDrop?: LinkDropContext
  /** Existing link being replaced by a selected node. */
  readonly splice?: LinkDoubleClickContext
  readonly initialInputTypes?: readonly string[]
  readonly initialOutputTypes?: readonly string[]
}

export interface PaletteEntry {
  readonly type: string
  readonly name: string
  readonly category: string
  readonly description?: string
  readonly pack?: string
  /** Entry kind for kind: filters and chips. */
  readonly kind: 'node' | 'subgraph' | 'blueprint' | 'utility'
  /** Schema backing in:/out: port filters (subgraphs: boundary-derived). */
  readonly schema?: NodeSchema
  /** Blueprint backing: descriptor for hints + lazy body fetch on insert. */
  readonly blueprint?: { readonly packId: string; readonly descriptor: PackBlueprintDescriptor }
  readonly fields: readonly { readonly text: string; readonly weight: number }[]
}

/**
 * Duplicate display names need canonical context; unique names do not. Pack
 * is presentation metadata (the host resolves its display name), while type
 * remains the selection identity.
 */
export function paletteEntryIdentity(
  entry: PaletteEntry,
  duplicateNames: ReadonlySet<string>,
): { readonly visible?: string; readonly accessible: string } {
  if (!duplicateNames.has(entry.name)) return { accessible: entry.name }
  const context = [...(entry.pack === undefined ? [] : [entry.pack]), entry.category, entry.type]
  return {
    visible: context.join(' - '),
    accessible: [entry.name, ...context].join(', '),
  }
}

export function duplicatePaletteNames(entries: readonly PaletteEntry[]): ReadonlySet<string> {
  const owner = new Map<string, string>()
  const duplicates = new Set<string>()
  for (const entry of entries) {
    const prior = owner.get(entry.name)
    if (prior !== undefined && prior !== entry.type) duplicates.add(entry.name)
    else if (prior === undefined) owner.set(entry.name, entry.type)
  }
  return duplicates
}

export function recentFirst<T>(entries: readonly T[], typeOf: (entry: T) => string, recent: readonly string[], limit: number): T[] {
  return [...entries].sort((a, b) => {
    const ai = recent.indexOf(typeOf(a))
    const bi = recent.indexOf(typeOf(b))
    return (ai < 0 ? recent.length : ai) - (bi < 0 ? recent.length : bi)
  }).slice(0, limit)
}

/** Creation-time eligibility: every schema-backed pick must have a target on its fresh elaborated surface. */
export function paletteEntryMatchesLinkDrop(entry: PaletteEntry, drop: LinkDropContext): boolean {
  if (!hasKnownLinkDropAnchorType(drop.anchorType)) return false
  if (entry.kind === 'utility') return true
  if (entry.schema !== undefined) return schemaMatchesLinkDrop(entry.schema, drop.anchorType, drop.seeking)
  if (entry.blueprint === undefined) return false
  const descriptor = entry.blueprint.descriptor
  return hintsMatchLinkDrop(
    {
      ...(descriptor.boundaryInputs !== undefined ? { inputs: descriptor.boundaryInputs } : {}),
      ...(descriptor.boundaryOutputs !== undefined ? { outputs: descriptor.boundaryOutputs } : {}),
    },
    drop.anchorType,
    drop.seeking,
  )
}

export interface CategoryFolder {
  readonly name: string
  readonly path: string
  readonly count: number
  readonly children: readonly CategoryFolder[]
}

/** Build a stable slash-delimited folder tree without any UI dependency. */
export function buildCategoryTree(categories: readonly string[]): { folders: CategoryFolder[]; uncategorized: number } {
  interface MutableFolder { name: string; path: string; count: number; children: Map<string, MutableFolder> }
  const roots = new Map<string, MutableFolder>()
  let uncategorized = 0
  for (const raw of categories) {
    const parts = raw.split('/').map((part) => part.trim()).filter(Boolean)
    if (parts.length === 0) { uncategorized++; continue }
    let map = roots
    let path = ''
    for (const name of parts) {
      path = path ? `${path}/${name}` : name
      let folder = map.get(name)
      if (!folder) {
        folder = { name, path, count: 0, children: new Map() }
        map.set(name, folder)
      }
      folder.count++
      map = folder.children
    }
  }
  const freeze = (map: Map<string, MutableFolder>): CategoryFolder[] =>
    [...map.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((folder) => ({ ...folder, children: freeze(folder.children) }))
  return { folders: freeze(roots), uncategorized }
}

export function SearchableTypeFilter(props: {
  label: string
  testid: string
  /** Canonical option VALUES - these are matched against type ids, so they must never be display aliases. */
  options: readonly string[]
  selected: ReadonlySet<string>
  onChange: (selected: ReadonlySet<string>) => void
  /** Optional display mapping for option rows; selection still commits the canonical value. */
  labelOf?: (option: string) => string
}) {
  const message = useAppMessage()
  const [query, setQuery] = createSolidSignal('')
  const [open, setOpen] = createSolidSignal(false)
  const panelId = `palette-type-popover-${createUniqueId()}`
  let root!: HTMLDivElement
  let trigger!: HTMLButtonElement
  let panel: HTMLDivElement | undefined
  let search: HTMLInputElement | undefined
  let optionsList: HTMLDivElement | undefined
  let panelResize: ResizeObserver | undefined
  const optionsId = `${panelId}-options`
  const labelOf = (option: string): string => props.labelOf?.(option) ?? option
  // Search matches the displayed label or the canonical value, so 'clip'
  // finds an aliased 'dinkster.clip' option and 'dinkster' still works.
  const filtered = () => props.options.filter((option) => {
    const q = query().toLowerCase()
    return option.toLowerCase().includes(q) || labelOf(option).toLowerCase().includes(q)
  })
  const toggle = (option: string): void => {
    const next = new Set(props.selected)
    if (next.has(option)) next.delete(option); else next.add(option)
    props.onChange(next)
  }
  const place = (): void => {
    if (!panel || !optionsList) return
    const triggerRect = trigger.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    const paletteRect = root.closest('.node-palette')?.getBoundingClientRect()
    const bounds = paletteRect === undefined
      ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
      : {
          left: Math.max(0, paletteRect.left),
          top: Math.max(0, paletteRect.top),
          right: Math.min(window.innerWidth, paletteRect.right),
          bottom: Math.min(window.innerHeight, paletteRect.bottom),
        }
    panel.style.width = ''
    panel.style.maxHeight = ''
    optionsList.style.maxHeight = ''
    const placement = placeFloatingSurface({
      surface: { width: panel.offsetWidth, height: panel.scrollHeight },
      anchor: triggerRect,
      bounds,
      direction: 'block',
      margin: semanticDesignTokens.space[8],
      gap: semanticDesignTokens.space[4],
    })
    panel.style.left = `${placement.left - rootRect.left}px`
    panel.style.top = `${placement.top - rootRect.top}px`
    panel.style.bottom = 'auto'
    panel.style.width = `${placement.width}px`
    panel.style.maxHeight = `${placement.maxHeight}px`
    const chromeHeight = panel.offsetHeight - optionsList.offsetHeight
    optionsList.style.maxHeight = `${Math.max(0, placement.maxHeight - chromeHeight)}px`
  }
  const close = (restoreFocus: boolean): void => {
    if (panel !== undefined) panelResize?.unobserve(panel)
    setOpen(false)
    panel = undefined
    search = undefined
    optionsList = undefined
    if (restoreFocus) trigger.focus()
  }
  const show = (): void => {
    setOpen(true)
    queueMicrotask(() => {
      place()
      search?.focus()
    })
  }
  const optionButtons = (): HTMLButtonElement[] =>
    panel ? Array.from(panel.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')) : []
  const focusOption = (index: number): void => {
    const options = optionButtons()
    options[(index + options.length) % options.length]?.focus()
  }
  const optionKeyDown = (event: KeyboardEvent, option: string): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggle(option)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const options = optionButtons()
    const index = options.indexOf(event.currentTarget as HTMLButtonElement)
    focusOption(index + (event.key === 'ArrowDown' ? 1 : -1))
  }

  onMount(() => {
    const outside = (event: PointerEvent): void => {
      if (!open()) return
      const target = event.target
      if (target instanceof Node && root.contains(target)) return
      close(false)
    }
    const reposition = (): void => { if (open()) place() }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    if (typeof ResizeObserver !== 'undefined') {
      panelResize = new ResizeObserver(reposition)
    }
    onCleanup(() => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      panelResize?.disconnect()
    })
  })
  createEffect(() => {
    query()
    if (open()) queueMicrotask(place)
  })

  return (
    <div
      class="palette-type-filter"
      ref={root}
      data-testid={props.testid}
      data-expanded={open()}
      onFocusOut={(event) => {
        const next = event.relatedTarget
        if (next instanceof Node && root.contains(next)) return
        if (open()) close(false)
      }}
      onKeyDown={(event) => {
        if (!open() || event.key !== 'Escape' || event.isComposing) return
        event.preventDefault()
        event.stopPropagation()
        close(true)
      }}
    >
      <button
        ref={trigger}
        type="button"
        class="palette-type-trigger"
        aria-expanded={open()}
        aria-haspopup="dialog"
        aria-controls={panelId}
        onClick={() => open() ? close(true) : show()}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          if (open()) close(true); else show()
        }}
      >
        <span>{props.label}: {props.selected.size === 0 ? message('palette.typeFilter.any') : message('palette.typeFilter.selected', { count: props.selected.size })}</span>
        <span class="palette-type-caret" aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div
          ref={(element) => {
            panel = element
            panelResize?.observe(element)
          }}
          id={panelId}
          class="palette-type-popover floating-surface"
          role="dialog"
          aria-label={message('palette.typeFilter.dialog', { label: props.label })}
        >
          <input
            ref={search}
            type="search"
            role="searchbox"
            aria-label={message('palette.typeFilter.search', { direction: props.label.toLocaleLowerCase() })}
            aria-controls={optionsId}
            placeholder={message('palette.typeFilter.searchPlaceholder')}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && filtered().length > 0) {
                event.preventDefault()
                focusOption(0)
              }
            }}
          />
          <div id={optionsId} class="palette-type-options" ref={optionsList}>
            <For each={filtered()} fallback={<span>{message('palette.typeFilter.noMatches')}</span>}>
              {(option) => (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={props.selected.has(option)}
                  onClick={() => toggle(option)}
                  onKeyDown={(event) => optionKeyDown(event, option)}
                >
                  <span class="palette-type-check" aria-hidden="true" />
                  <span>{labelOf(option)}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

/** Display label for a port type expression (advisory, presentation only). */
export const typeLabelOf = (t: TypeExpr): string => presentedType(defaultTokens, t).label

interface PreviewPort {
  readonly name: string
  readonly type: string
  readonly optional: boolean
  readonly tooltip?: string
  /** Dynamic family badge; families preview as one row, never expanded. */
  readonly dynamic?: 'autogrow' | 'combo' | 'slot'
}

const DYNAMIC_BADGE = { autogrow: 'autogrow', dynamicCombo: 'combo', dynamicSlot: 'slot' } as const

export function NodePalette(props: {
  anchor: PaletteAnchor
  /** Search corpus; the host assembles schemas + subgraphs + blueprints. */
  entries: () => PaletteEntry[]
  /** Most-recently inserted types, newest first (host-persisted). */
  recentTypes: () => readonly string[]
  /** For preview measurement/painting of the highlighted schema. */
  widgetRegistry: WidgetRegistry
  /** Visible canvas-pane size, for clamping the measured panel. */
  bounds: () => { width: number; height: number }
  onCommit: (entry: PaletteEntry) => void
  onHelp?: (entry: PaletteEntry) => void
  onClose: () => void
}) {
  const message = useAppMessage()
  const paletteEntries = createMemo(() => props.entries())
  const duplicateNames = createMemo(() => duplicatePaletteNames(paletteEntries()))
  const [paletteQuery, setPaletteQuery] = createSolidSignal('')
  const [paletteIndex, setPaletteIndex] = createSolidSignal(0)
  const [paletteCategory, setPaletteCategory] = createSolidSignal<string | undefined>(undefined)
  const [paletteInputTypes, setPaletteInputTypes] = createSolidSignal<ReadonlySet<string>>(new Set(props.anchor.initialInputTypes))
  const [paletteOutputTypes, setPaletteOutputTypes] = createSolidSignal<ReadonlySet<string>>(new Set(props.anchor.initialOutputTypes))
  const [expandedCategories, setExpandedCategories] = createSolidSignal<ReadonlySet<string>>(new Set())
  const listboxId = `node-palette-options-${createUniqueId()}`
  const resultGroupId = `${listboxId}-group`
  const statusId = `${listboxId}-status`
  /** Chip-row kind filter; undefined = all kinds (ANDed with kind: tokens). */
  const [paletteKinds, setPaletteKinds] = createSolidSignal<ReadonlySet<string> | undefined>(undefined)
  const linkDropEligibleEntries = createMemo(() => {
    const entries = paletteEntries()
    const drop = props.anchor.linkDrop
    return drop === undefined ? entries : entries.filter((entry) => paletteEntryMatchesLinkDrop(entry, drop))
  })
  const insertionEligibleEntries = createMemo(() => {
    const entries = linkDropEligibleEntries()
    const splice = props.anchor.splice
    if (splice === undefined) return entries
    return entries.filter((entry) =>
      entry.kind === 'utility' ||
      (entry.schema !== undefined &&
        autoConnectTarget(entry.schema, splice.fromType, 'in') !== undefined &&
        autoConnectTarget(entry.schema, splice.toType, 'out') !== undefined),
    )
  })

  // Reopening while mounted (anchor replaced without an intervening close)
  // behaves like a fresh open: text and per-open filters reset. Kind chips
  // persist for the palette's lifetime, exactly as before the extraction.
  createEffect(on(() => props.anchor, () => {
    setPaletteQuery('')
    setPaletteIndex(0)
    setPaletteCategory(undefined)
    setPaletteInputTypes(new Set(props.anchor.initialInputTypes))
    setPaletteOutputTypes(new Set(props.anchor.initialOutputTypes))
    setExpandedCategories(new Set<string>())
  }, { defer: true }))

  /**
   * Filters first, then ranking: kind:/in:/out: tokens (and the chip row,
   * ANDed with typed kind: tokens) narrow the corpus, the residual text
   * ranks through the shared scorer. Port filters consult the schema's
   * declared TYPE STRUCTURE, so one generic node matches every form its
   * variables allow - never one entry per concrete form.
   *
   * Memoized: the list, count, empty state, announcement, and highlight all
   * read this, so an unmemoized pipeline would filter and rank the whole
   * corpus once per consumer on every keystroke.
   */
  const paletteMatches = createMemo((): PaletteEntry[] => {
    const filters = parseSearchFilters(paletteQuery())
    const chips = paletteKinds()
    const pool = insertionEligibleEntries().filter((e) => {
      if (paletteCategory() !== undefined && !(paletteCategory() === '' ? e.category.trim() === '' : e.category === paletteCategory() || e.category.startsWith(`${paletteCategory()}/`))) return false
      if (filters.kinds !== undefined && !filters.kinds.has(e.kind)) return false
      if (chips !== undefined && !chips.has(e.kind)) return false
      if (filters.inputs === undefined && filters.outputs === undefined) return true
      if (e.schema !== undefined) return schemaMatchesPortFilters(e.schema, filters)
      // Blueprints filter on declared boundary hints (untrusted author
      // declarations, matched tolerantly); no hints = opted out.
      if (e.blueprint !== undefined) {
        const d = e.blueprint.descriptor
        return hintsMatchPortFilters({
          ...(d.boundaryInputs !== undefined ? { inputs: d.boundaryInputs } : {}),
          ...(d.boundaryOutputs !== undefined ? { outputs: d.boundaryOutputs } : {}),
        }, filters)
      }
      return false
    })
    const selectedInputs = paletteInputTypes().size > 0 ? [...paletteInputTypes()] : undefined
    const selectedOutputs = paletteOutputTypes().size > 0 ? [...paletteOutputTypes()] : undefined
    const selected = pool.filter((e) => {
      if (e.kind === 'utility') return true
      if (selectedInputs === undefined && selectedOutputs === undefined) return true
      const selectedFilters = {
        ...(selectedInputs !== undefined ? { inputs: selectedInputs } : {}),
        ...(selectedOutputs !== undefined ? { outputs: selectedOutputs } : {}),
      }
      if (e.schema !== undefined) return schemaMatchesAnyPortFilters(e.schema, selectedFilters)
      if (e.blueprint !== undefined) return hintsMatchAnyPortFilters({
        ...(e.blueprint.descriptor.boundaryInputs !== undefined ? { inputs: e.blueprint.descriptor.boundaryInputs } : {}),
        ...(e.blueprint.descriptor.boundaryOutputs !== undefined ? { outputs: e.blueprint.descriptor.boundaryOutputs } : {}),
      }, selectedFilters)
      return false
    })
    if (filters.text.length === 0 && paletteCategory() === undefined) {
      // Truncate after recency so a recent entry cannot be hidden by the search limit.
      return recentFirst(selected, (entry) => entry.type, props.recentTypes(), 200)
    }
    return rankSearch(filters.text, selected, (e) => e.fields, { limit: 200 })
  })

  const paletteCategories = () => buildCategoryTree(paletteEntries().map((entry) => entry.category))

  const toggleCategory = (path: string): void => {
    const next = new Set(expandedCategories())
    if (next.has(path)) next.delete(path); else next.add(path)
    setExpandedCategories(next)
  }

  const CategoryRows = (rowProps: { folders: readonly CategoryFolder[]; depth: number }) => (
    <For each={rowProps.folders}>{(folder) => {
      const childId = `palette-category-${encodeURIComponent(folder.path)}`
      return (
        <>
          <div class="palette-category-row" style={{ 'padding-left': `${rowProps.depth * semanticDesignTokens.space[12]}px` }}>
            <Show when={folder.children.length > 0} fallback={<span class="category-spacer" />}>
              <button
                type="button"
                class="category-toggle"
                aria-label={message(expandedCategories().has(folder.path) ? 'palette.category.collapse' : 'palette.category.expand', { category: folder.name })}
                aria-expanded={expandedCategories().has(folder.path)}
                aria-controls={expandedCategories().has(folder.path) ? childId : undefined}
                onClick={() => toggleCategory(folder.path)}
              >
                <span class="palette-type-caret" aria-hidden="true" />
              </button>
            </Show>
            <button
              type="button"
              data-testid="palette-category"
              classList={{ active: paletteCategory() === folder.path }}
              aria-pressed={paletteCategory() === folder.path}
              onClick={() => { setPaletteCategory(folder.path); setPaletteIndex(0) }}
            >
              <span>{folder.name}</span><span>{folder.count}</span>
            </button>
          </div>
          <Show when={expandedCategories().has(folder.path)}>
            <div id={childId}><CategoryRows folders={folder.children} depth={rowProps.depth + 1} /></div>
          </Show>
        </>
      )
    }}</For>
  )

  const paletteTypeOptions = (direction: 'in' | 'out'): string[] => {
    const found = new Set<string>()
    const collect = (type: TypeExpr): void => {
      // Canonical values, never display aliases: these strings are matched
      // against type ids by schemaMatches*/hintsMatch* filters.
      for (const label of typeExprCanonicalLabel(type).split(' | ')) found.add(label)
      if (type.kind === 'list' || type.kind === 'asset' || type.kind === 'stream') collect(type.element)
      else if (type.kind === 'variable') for (const allowed of type.allowedTypes ?? []) collect(allowed)
    }
    for (const entry of paletteEntries()) {
      if (!entry.schema) continue
      const types = direction === 'in' ? schemaInputTypes(entry.schema) : schemaOutputTypes(entry.schema)
      for (const type of types) collect(type)
    }
    return [...found].sort((a, b) => a.localeCompare(b))
  }
  const linkDropDirection = (): string => message(props.anchor.linkDrop?.seeking === 'in' ? 'palette.filter.input' : 'palette.filter.output')

  /** Highlighted palette entry (keyboard/mouse), clamped to the match list. */
  const paletteSelectedIndex = (): number => Math.max(0, Math.min(paletteIndex(), Math.max(0, paletteMatches().length - 1)))
  const paletteOptionId = (index: number): string => `${listboxId}-option-${index}`
  const paletteHighlighted = (): PaletteEntry | undefined => {
    const matches = paletteMatches()
    return matches.length === 0 ? undefined : matches[paletteSelectedIndex()]
  }
  const paletteResultLabel = (): string => paletteCategory() === undefined
    ? props.anchor.linkDrop === undefined ? message('palette.results.available') : message('palette.results.compatible')
    : paletteCategory() === '' ? message('palette.category.uncategorized') : paletteCategory()!
  const paletteAnnouncement = (): string => {
    const matches = paletteMatches()
    const active = paletteHighlighted()
    if (active === undefined) return paletteQuery().trim() === ''
      ? message('palette.announcement.noNodes')
      : message('palette.announcement.noMatches', { query: paletteQuery() })
    return message('palette.announcement.results', { count: matches.length, index: paletteSelectedIndex() + 1, name: active.name })
  }

  let palettePreviewCanvas: HTMLCanvasElement | undefined
  const previewPaintFailures = new Set<string>()

  /** Paint once per highlighted schema. The transient node never enters a store. */
  const paintPaletteNodePreview = (entry: PaletteEntry): void => {
    const canvas = palettePreviewCanvas
    if (!canvas || entry.schema === undefined) return
    canvas.removeAttribute('data-preview-ready')
    try {
      const measureCanvas = document.createElement('canvas').getContext('2d')
      if (!measureCanvas) throw new Error('Canvas2D is unavailable')
      const measure: TextMeasurer = (text, style) => {
        measureCanvas.font = style === 'title' || style === 'renamedTitle'
          ? `${style === 'renamedTitle' ? 'italic ' : ''}600 ${defaultTokens.titleFontSize}px ${defaultTokens.fontFamily}`
          : `${defaultTokens.fontSize}px ${defaultTokens.fontFamily}`
        return measureCanvas.measureText(text).width
      }
      const widgetMeasure: WidgetMeasure = (spec) => {
        const kind = props.widgetRegistry.kind(spec.widgetType)
        if (!kind) return undefined
        const viewId = kind.defaultView(spec)
        const view = props.widgetRegistry.viewsFor(spec.widgetType).find((candidate) => candidate.id === viewId)
        return view ? { viewId, rows: view.measure(spec).rows } : undefined
      }
      const { node, layout } = palettePreviewLayout(entry.schema, defaultTokens, measure, widgetMeasure)
      const availableWidth = Math.max(1, (canvas.parentElement?.clientWidth ?? layout.width + 16) - 16)
      const scale = Math.min(1, availableWidth / layout.width, 240 / layout.height)
      const width = Math.max(1, Math.ceil(layout.width * scale + 12))
      const height = Math.max(1, Math.ceil(layout.height * scale + 12))
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      const renderer = new CanvasRenderer(canvas, defaultTokens, createRegistryPainter(props.widgetRegistry))
      renderer.setGridVisible(false)
      renderer.setScene({
        graphId: '__palette_preview__',
        nodes: [{ id: node.id, x: 0, y: 0, node, layout, isSubgraph: entry.kind === 'subgraph' }],
        links: [], reroutes: [], valueSources: [], selectors: [], netStubs: [], groups: [], boundaryNodes: [], diagnostics: [],
      })
      renderer.setViewport({ x: 6, y: 6, scale })
      renderer.renderNow()
      renderer.dispose()
      canvas.dataset.previewReady = entry.type
    } catch (error) {
      if (!previewPaintFailures.has(entry.type)) {
        previewPaintFailures.add(entry.type)
        console.warn(`Unable to paint palette preview for ${entry.type}`, error)
      }
    }
  }

  createEffect(() => {
    const entry = paletteHighlighted()
    if (entry?.schema !== undefined && palettePreviewCanvas !== undefined) paintPaletteNodePreview(entry)
  })

  /**
   * Interface preview for the highlighted entry: real schema ports when a
   * schema exists (nodes and boundary-derived subgraphs), otherwise the
   * blueprint's author-DECLARED boundary hints (`declared` flags the caveat
   * in the UI - hints are verbatim passthrough, never verified interface).
   */
  const previewPortsOf = (
    entry: PaletteEntry,
  ): { inputs: PreviewPort[]; outputs: PreviewPort[]; declared: boolean } => {
    if (entry.schema !== undefined) {
      return {
        inputs: inputsOf(entry.schema).filter((i) => i.hidden !== true).map((i) => ({
          name: i.displayName ?? i.id,
          type: typeLabelOf(i.type),
          tooltip: presentedType(defaultTokens, i.type).tooltip,
          optional: i.optional,
          ...(i.dynamic !== undefined ? { dynamic: DYNAMIC_BADGE[i.dynamic.kind] } : {}),
        })),
        outputs: outputsOf(entry.schema).map((o) => ({
          name: o.displayName ?? o.id,
          type: typeLabelOf(o.type),
          tooltip: presentedType(defaultTokens, o.type).tooltip,
          optional: o.optional === true,
          ...(o.dynamic !== undefined ? { dynamic: DYNAMIC_BADGE[o.dynamic.kind] } : {}),
        })),
        declared: false,
      }
    }
    const d = entry.blueprint?.descriptor
    return {
      inputs: (d?.boundaryInputs ?? []).map((t) => ({ name: typeIdDisplayLabel(t), type: typeIdDisplayLabel(t), optional: false })),
      outputs: (d?.boundaryOutputs ?? []).map((t) => ({ name: typeIdDisplayLabel(t), type: typeIdDisplayLabel(t), optional: false })),
      declared: true,
    }
  }

  /**
   * Chip row: one chip per entry kind PRESENT in the corpus, shown only
   * when there is a real choice. The synthetic Reroute utility entry
   * means every document offers at least node + utility, so in practice
   * the row is always visible. Blueprint entries surface automatically.
   */
  const paletteKindChips = (): { id: string; label: string }[] => {
    const labels: Record<string, string> = {
      node: message('palette.kind.nodes'),
      subgraph: message('palette.kind.subgraphs'),
      blueprint: message('palette.kind.blueprints'),
      utility: message('palette.kind.utilities'),
    }
    const seen = new Set<string>()
    for (const e of paletteEntries()) seen.add(e.kind)
    return [...seen].sort().map((id) => ({ id, label: labels[id] ?? id }))
  }

  /** Toggle one kind chip; toggling the last active chip clears the filter. */
  const togglePaletteKind = (kind: string): void => {
    const current = paletteKinds()
    const next = new Set(current ?? [])
    if (next.has(kind)) next.delete(kind)
    else next.add(kind)
    setPaletteKinds(next.size === 0 ? undefined : next)
    setPaletteIndex(0)
  }

  const onPaletteKeyDown = (e: KeyboardEvent): void => {
    const matches = paletteMatches()
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setPaletteIndex(Math.min(paletteSelectedIndex() + 1, Math.max(0, matches.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setPaletteIndex(Math.max(paletteSelectedIndex() - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = matches[paletteSelectedIndex()]
      if (entry) props.onCommit(entry)
    }
  }

  let paletteEl: HTMLDivElement | undefined
  let paletteResults: HTMLDivElement | undefined
  let paletteResize: ResizeObserver | undefined

  /**
   * Search results and the optional preview determine the final palette
   * size. Measure after Solid paints them, then place the palette with its
   * top edge centered on the click/drop point, shifted as needed so every
   * edge remains inside the visible canvas.
   */
  const clampPalette = (): void => {
    const el = paletteEl
    if (!el) return
    const box = props.bounds()
    const placement = placeFloatingSurface({
      surface: { width: el.offsetWidth, height: el.offsetHeight },
      anchor: { left: props.anchor.x, top: props.anchor.y, right: props.anchor.x, bottom: props.anchor.y },
      bounds: { left: 0, top: 0, right: box.width, bottom: box.height },
      direction: 'point',
      align: 'center',
      margin: semanticDesignTokens.space[4],
      gap: 0,
    })
    el.style.left = `${placement.left}px`
    el.style.top = `${placement.top}px`
    el.style.maxWidth = `${placement.maxWidth}px`
    el.style.maxHeight = `${placement.maxHeight}px`
  }
  createEffect(() => {
    // Results can add the preview column after the initial mount, changing
    // the measured width without recreating the palette element.
    paletteQuery()
    paletteIndex()
    paletteCategory()
    props.bounds()
    queueMicrotask(() => clampPalette())
  })
  createEffect(() => {
    const id = paletteHighlighted() === undefined ? undefined : paletteOptionId(paletteSelectedIndex())
    if (id === undefined) return
    queueMicrotask(() => paletteResults?.querySelector<HTMLElement>(`#${id}`)?.scrollIntoView?.({ block: 'nearest' }))
  })
  onCleanup(() => paletteResize?.disconnect())

  return (
    <div class="palette-layer node-palette-layer" data-testid="palette-backdrop">
      <div
        ref={(el) => {
          paletteEl = el
          if (typeof ResizeObserver !== 'undefined') {
            paletteResize = new ResizeObserver(clampPalette)
            paletteResize.observe(el)
          }
          queueMicrotask(clampPalette)
        }}
        class="node-palette floating-surface"
        data-testid="node-palette"
        data-link-drop={props.anchor.linkDrop !== undefined ? props.anchor.linkDrop.seeking : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={props.anchor.linkDrop !== undefined ? message('palette.dialog.addCompatibleNode') : message('palette.action.addNode')}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
          )).filter((element) => element.getClientRects().length > 0)
          if (focusable.length === 0) return
          const index = focusable.indexOf(document.activeElement as HTMLElement)
          if (event.shiftKey && index <= 0) {
            event.preventDefault()
            focusable.at(-1)?.focus()
          } else if (!event.shiftKey && index === focusable.length - 1) {
            event.preventDefault()
            focusable[0]?.focus()
          }
        }}
      >
      <div class="palette-header">
        <SearchInput
          value={paletteQuery()}
          placeholder={props.anchor.linkDrop !== undefined ? message('palette.search.compatibleNodesPlaceholder') : message('palette.search.addNodePlaceholder')}
          controls={listboxId}
          describedBy={statusId}
          activeDescendant={paletteHighlighted() === undefined ? undefined : paletteOptionId(paletteSelectedIndex())}
          busy={false}
          ariaLabel={message('palette.action.addNode')}
          testId="palette-search"
          inputRef={(element) => queueMicrotask(() => element.focus())}
          onInput={(event) => {
            setPaletteQuery(event.currentTarget.value)
            setPaletteIndex(0)
          }}
          onKeyDown={onPaletteKeyDown}
        />
        <div class="palette-filters">
          <Show when={paletteKindChips().length > 1}>
            <div class="palette-kinds" data-testid="palette-kinds" role="group" aria-label={message('palette.filter.resultKinds')}>
              <For each={paletteKindChips()}>
                {(kind) => (
                  <button
                    type="button"
                    classList={{ 'palette-kind': true, active: paletteKinds()?.has(kind.id) ?? false }}
                    data-testid="palette-kind"
                    data-kind={kind.id}
                    aria-pressed={paletteKinds()?.has(kind.id) ?? false}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => togglePaletteKind(kind.id)}
                  >
                    {kind.label}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <SearchableTypeFilter label={message('palette.filter.input')} testid="palette-input-filter" options={paletteTypeOptions('in')} selected={paletteInputTypes()} onChange={(value) => { setPaletteInputTypes(value); setPaletteIndex(0) }} labelOf={typeIdDisplayLabel} />
          <SearchableTypeFilter label={message('palette.filter.output')} testid="palette-output-filter" options={paletteTypeOptions('out')} selected={paletteOutputTypes()} onChange={(value) => { setPaletteOutputTypes(value); setPaletteIndex(0) }} labelOf={typeIdDisplayLabel} />
          <Show when={props.anchor.linkDrop}>{(drop) => <button type="button" class="palette-active-filter" data-testid="palette-link-type-filter" aria-label={message('palette.filter.pendingLink', { direction: linkDropDirection(), type: typeLabelOf(drop().anchorType) })} data-tooltip-label={message('palette.filter.closePending')} onClick={() => props.onClose()}>{linkDropDirection()}: {typeLabelOf(drop().anchorType)} x</button>}</Show>
        </div>
      </div>
      <div class="palette-body" classList={{ 'has-preview': paletteHighlighted() !== undefined }}>
        <nav class="palette-categories" data-testid="palette-categories" aria-label={message('palette.category.navigation')}>
          <button type="button" classList={{ active: paletteCategory() === undefined }} aria-pressed={paletteCategory() === undefined} onClick={() => { setPaletteCategory(undefined); setPaletteIndex(0) }}>
            <span>{props.recentTypes().length > 0 && !paletteQuery() ? message('palette.category.recentAll') : message('palette.category.mostRelevant')}</span>
          </button>
          <CategoryRows folders={paletteCategories().folders} depth={0} />
          <Show when={paletteCategories().uncategorized > 0}><button type="button" data-testid="palette-category" classList={{ active: paletteCategory() === '' }} aria-pressed={paletteCategory() === ''} onClick={() => { setPaletteCategory(''); setPaletteIndex(0) }}><span>{message('palette.category.uncategorized')}</span><span>{paletteCategories().uncategorized}</span></button></Show>
        </nav>
        <div class="palette-results">
          <div
            ref={paletteResults}
            class="palette-result-listbox"
            classList={{ empty: paletteMatches().length === 0 }}
            id={listboxId}
            role="listbox"
            aria-label={message('palette.results.navigation')}
          >
            <Show when={paletteMatches().length > 0}>
              <SearchResultGroup id={resultGroupId} label={paletteResultLabel()} count={paletteMatches().length}>
                <ul class="palette-list" role="none">
                  <For each={paletteMatches()}>
                    {(entry, index) => {
                      const identity = () => paletteEntryIdentity(entry, duplicateNames())
                      return (
                        <li role="none" data-testid="palette-item" data-node-type={entry.type}>
                          <SearchResultRow
                            id={paletteOptionId(index())}
                            selected={index() === paletteSelectedIndex()}
                            title={entry.name}
                            detail={identity().visible ?? entry.category}
                            description={entry.description?.split('\n')[0]}
                            badge={identity().visible === undefined ? entry.pack ?? entry.kind : undefined}
                            onHighlight={() => setPaletteIndex(index())}
                            onActivate={() => props.onCommit(entry)}
                          />
                        </li>
                      )
                    }}
                  </For>
                </ul>
              </SearchResultGroup>
            </Show>
          </div>
          <Show when={paletteMatches().length === 0}>
            <SearchState
              kind="empty"
              title={message('palette.empty.title')}
              detail={paletteQuery().trim() === '' ? message('palette.empty.filters') : message('palette.empty.query')}
            />
          </Show>
          <div id={statusId} class="search-announcement" role="status" aria-live="polite" aria-atomic="true">{paletteAnnouncement()}</div>
        </div>
        <Show when={paletteHighlighted()}>
          {(entry) => {
            const ports = () => previewPortsOf(entry())
            const description = () =>
              entry().schema?.description ?? entry().blueprint?.descriptor.description
            return (
              <aside class="palette-preview" data-testid="palette-preview" aria-label={message('palette.preview.aria', { name: entry().name })}>
                <Show when={entry().schema !== undefined}>
                  <canvas
                    class="palette-node-preview"
                    data-testid="palette-node-preview"
                    ref={(canvas) => {
                      palettePreviewCanvas = canvas
                      queueMicrotask(() => paintPaletteNodePreview(entry()))
                    }}
                  />
                </Show>
                <h2 class="preview-title">{entry().name}</h2>
                <div class="preview-meta">
                  {entry().pack ?? entry().kind}
                  {' - '}
                  {entry().category}
                  <Show when={entry().schema !== undefined && isDeprecated(entry().schema!)}>
                    <span class="preview-flag">{message('palette.status.deprecated')}</span>
                  </Show>
                  <Show when={entry().schema?.experimental === true}>
                    <span class="preview-flag">{message('palette.status.experimental')}</span>
                  </Show>
                </div>
                <Show when={description()}>
                  <div class="preview-description">{description()}</div>
                </Show>
                <Show when={entry().schema?.hasDocs === true && props.onHelp !== undefined}>
                  <button type="button" class="preview-help" onClick={() => props.onHelp?.(entry())}>{message('nodeHelp.action.help')}</button>
                </Show>
                <Show when={ports().inputs.length > 0}>
                  <div class="preview-section">
                    {ports().declared ? message('palette.ports.declaredInputs') : message('palette.ports.inputs')}
                  </div>
                  <For each={ports().inputs}>
                    {(port) => (
                      <div class="preview-port" data-testid="preview-input">
                        <Show when={!ports().declared}>
                          <span class="preview-port-name">{port.name}</span>
                        </Show>
                        <span class="preview-port-type" tabindex={port.tooltip ? '0' : undefined} aria-label={port.tooltip ? `${port.type}: ${port.tooltip}` : port.type} data-tooltip-label={port.tooltip}>{port.type}</span>
                        <span class="preview-port-badge">{port.optional ? message('palette.port.optional') : message('palette.port.required')}</span>
                        <Show when={entry().schema && inputsOf(entry().schema!).find((i) => i.hidden !== true && (i.displayName ?? i.id) === port.name)?.widget}>{(widget) => <span class="preview-port-badge">{widget().kind}</span>}</Show>
                        <Show when={port.dynamic}>
                          <span class="preview-port-badge">{port.dynamic}</span>
                        </Show>
                      </div>
                    )}
                  </For>
                </Show>
                <Show when={ports().outputs.length > 0}>
                  <div class="preview-section">
                    {ports().declared ? message('palette.ports.declaredOutputs') : message('palette.ports.outputs')}
                  </div>
                  <For each={ports().outputs}>
                    {(port) => (
                      <div class="preview-port" data-testid="preview-output">
                        <Show when={!ports().declared}>
                          <span class="preview-port-name">{port.name}</span>
                        </Show>
                        <span class="preview-port-type" tabindex={port.tooltip ? '0' : undefined} aria-label={port.tooltip ? `${port.type}: ${port.tooltip}` : port.type} data-tooltip-label={port.tooltip}>{port.type}</span>
                        <Show when={port.dynamic}>
                          <span class="preview-port-badge">{port.dynamic}</span>
                        </Show>
                        <Show when={port.optional}>
                          <span class="preview-port-badge">{message('palette.port.optional')}</span>
                        </Show>
                      </div>
                    )}
                  </For>
                </Show>
                <Show when={(entry().blueprint?.descriptor.tags?.length ?? 0) > 0}>
                  <div class="preview-section">{message('palette.tags')}</div>
                  <div class="preview-tags">
                    {entry().blueprint!.descriptor.tags!.join(', ')}
                  </div>
                </Show>
              </aside>
            )
          }}
        </Show>
      </div>
      </div>
    </div>
  )
}
