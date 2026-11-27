import { createEffect, createMemo, createSignal, on, Show } from 'solid-js'
import { ArrowLeft, Download, Folder, PanelTop, Wrench } from 'lucide-solid'
import {
  defaultTokens, presentedType, typeColor, typeExprCanonicalLabel, typeIdDisplayLabel,
  type LinkDropContext, type LinkDoubleClickContext,
} from '@dinkster/canvas'
import {
  autoConnectTarget, cardinalityOf, hasKnownLinkDropAnchorType, hintsMatchLinkDrop,
  hintsMatchPortFilters, isDeprecated, parseSearchFilters,
  rankSearch, schemaInputTypes, schemaMatchesLinkDrop,
  schemaMatchesPortFilters, schemaOutputTypes, semanticDesignTokens, typeExprFromTypeId,
  type Json, type NodeSchema, type PackBlueprintDescriptor, type SearchAction, type TypeExpr, type WidgetRegistry,
} from '@dinkster/core'
import { placeFloatingSurface } from '@dinkster/core/floating-surface'
import {
  BlueprintIcon, ProductButton, ProductIcon, ProductMenu, ProductSearch,
  ProductSearchNodePreview, ProductSearchTypeLabel, productSearchTypeName, productSearchTypeOptions,
  type ProductSearchGroup, type ProductSearchRow,
} from '@dinkster/ui'
import { useAppMessage } from './locale.js'
import { SchemaPreview } from './SchemaPreview.js'
import { searchPlace } from './universal-search.js'
import { palettePreviewSchema } from './palette-node-preview.js'

/** Canvas-pane anchor plus the world position where an immediate pick lands. */
export interface PaletteAnchor {
  readonly x: number
  readonly y: number
  readonly worldX: number
  readonly worldY: number
  readonly linkDrop?: LinkDropContext
  readonly suggestedNode?: { readonly type: string; readonly values: Readonly<Record<string, Json>> }
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
  readonly kind: 'node' | 'subgraph' | 'blueprint' | 'utility'
  readonly schema?: NodeSchema
  readonly blueprint?: { readonly packId: string; readonly descriptor: PackBlueprintDescriptor }
  /** Catalog snapshot identity, revalidated by the shared install action. */
  readonly install?: SearchAction
  readonly fields: readonly { readonly text: string; readonly weight: number }[]
}

/** Duplicate names retain canonical context without changing selection identity. */
export function paletteEntryIdentity(
  entry: PaletteEntry,
  duplicateNames: ReadonlySet<string>,
): { readonly visible?: string; readonly accessible: string } {
  if (!duplicateNames.has(entry.name)) return { accessible: entry.name }
  const context = [...(entry.pack === undefined ? [] : [entry.pack]), entry.category, entry.type]
  return { visible: context.join(' - '), accessible: [entry.name, ...context].join(', ') }
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

/** Creation-time eligibility uses the fresh elaborated surface, never a catalog-only entry. */
export function paletteEntryMatchesLinkDrop(entry: PaletteEntry, drop: LinkDropContext): boolean {
  if (entry.install !== undefined) return false
  if (entry.kind === 'utility') return true
  if (entry.schema !== undefined) return schemaMatchesLinkDrop(entry.schema, drop.anchorType, drop.seeking)
  if (entry.blueprint === undefined) return false
  const descriptor = entry.blueprint.descriptor
  return hintsMatchLinkDrop({
    ...(descriptor.boundaryInputs !== undefined ? { inputs: descriptor.boundaryInputs } : {}),
    ...(descriptor.boundaryOutputs !== undefined ? { outputs: descriptor.boundaryOutputs } : {}),
  }, drop.anchorType, drop.seeking)
}

export interface CategoryFolder {
  readonly name: string
  readonly path: string
  readonly count: number
  readonly children: readonly CategoryFolder[]
}

/** Build a slash-delimited folder tree without any UI dependency. */
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
  const freeze = (map: Map<string, MutableFolder>): CategoryFolder[] => [...map.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((folder) => ({ ...folder, children: freeze(folder.children) }))
  return { folders: freeze(roots), uncategorized }
}

export const typeLabelOf = (type: TypeExpr): string => {
  if (type.kind === 'variable' && !hasKnownLinkDropAnchorType(type)) return 'Any'
  if (type.kind === 'list') return `${typeLabelOf(type.element)} list`
  return productSearchTypeName(presentedType(defaultTokens, type).label)
}

/** The host owns corpus and placement; all browsing state lasts only for this open. */
export function NodePalette(props: {
  anchor: PaletteAnchor
  entries: () => PaletteEntry[]
  recentTypes: () => readonly string[]
  widgetRegistry: WidgetRegistry
  bounds: () => { width: number; height: number }
  onCommit: (entry: PaletteEntry) => void
  onHelp?: (entry: PaletteEntry) => void
  onRemoveLinkDrop: () => void
  onClose: () => void
}) {
  const message = useAppMessage()
  const [query, setQuery] = createSignal('')
  const [kind, setKind] = createSignal('all')
  const [category, setCategory] = createSignal<string>()
  const [current, setCurrent] = createSignal<string>()
  const initialRequirements = () => [
    ...(props.anchor.initialInputTypes ?? []).map((type) => ({ direction: 'takes' as const, type })),
    ...(props.anchor.initialOutputTypes ?? []).map((type) => ({ direction: 'gives' as const, type })),
  ]
  const [requirements, setRequirements] = createSignal<readonly { direction: 'takes' | 'gives'; type: string }[]>(initialRequirements())
  const entries = createMemo(() => props.entries())
  const duplicates = createMemo(() => duplicatePaletteNames(entries()))
  createEffect(on(() => props.anchor, (anchor, previous) => {
    if (previous?.linkDrop !== undefined && anchor.linkDrop === undefined &&
      anchor.worldX === previous.worldX && anchor.worldY === previous.worldY) return
    setQuery('')
    setCategory(undefined)
    setCurrent(undefined)
    setRequirements(initialRequirements())
  }))
  const matches = createMemo(() => {
    const filters = parseSearchFilters(query())
    const pool = entries().filter((entry) => {
      const drop = props.anchor.linkDrop
      if (drop !== undefined && !paletteEntryMatchesLinkDrop(entry, drop)) return false
      const splice = props.anchor.splice
      if (splice !== undefined && (!hasKnownLinkDropAnchorType(splice.fromType) || !hasKnownLinkDropAnchorType(splice.toType) ||
        entry.install !== undefined || (entry.kind !== 'utility' &&
        (entry.schema === undefined || autoConnectTarget(entry.schema, splice.fromType, 'in') === undefined ||
          autoConnectTarget(entry.schema, splice.toType, 'out') === undefined)))) return false
      if (kind() !== 'all' && entry.kind !== kind()) return false
      if (filters.kinds !== undefined && !filters.kinds.has(entry.kind)) return false
      if (category() !== undefined && !(category() === '' ? entry.category.trim() === '' :
        entry.category === category() || entry.category.startsWith(`${category()}/`))) return false
      const selected = {
        inputs: requirements().filter((item) => item.direction === 'takes').map((item) => item.type),
        outputs: requirements().filter((item) => item.direction === 'gives').map((item) => item.type),
      }
      const typed = filters.inputs !== undefined || filters.outputs !== undefined
      const picked = requirements().length > 0
      if (!typed && !picked) return true
      if (entry.schema !== undefined) return (!typed || schemaMatchesPortFilters(entry.schema, filters)) &&
        (!picked || schemaMatchesPortFilters(entry.schema, selected))
      const descriptor = entry.blueprint?.descriptor
      if (descriptor !== undefined) {
        const hints = {
          ...(descriptor.boundaryInputs !== undefined ? { inputs: descriptor.boundaryInputs } : {}),
          ...(descriptor.boundaryOutputs !== undefined ? { outputs: descriptor.boundaryOutputs } : {}),
        }
        return (!typed || hintsMatchPortFilters(hints, filters)) && (!picked || hintsMatchPortFilters(hints, selected))
      }
      return !typed && entry.kind === 'utility'
    })
    if (filters.text !== '') return rankSearch(filters.text, pool, (entry) => entry.fields, { limit: 200 })
    const recent = recentFirst(pool, (entry) => entry.type, props.recentTypes(), entries().length)
    const suggested = props.anchor.linkDrop === undefined ? undefined : props.anchor.suggestedNode?.type
    return suggested === undefined ? recent : [
      ...recent.filter((entry) => entry.type === suggested),
      ...recent.filter((entry) => entry.type !== suggested),
    ]
  })
  const row = (entry: PaletteEntry): ProductSearchRow => {
    const drop = props.anchor.linkDrop
    const target = drop !== undefined && entry.schema !== undefined ? autoConnectTarget(entry.schema, drop.anchorType, drop.seeking) : undefined
    const detail = entry.install !== undefined ? message('search.notInstalled') :
      target !== undefined ? message(drop!.seeking === 'in' ? 'palette.connection.into' : 'palette.connection.from', { port: target.port }) :
        paletteEntryIdentity(entry, duplicates()).visible ?? searchPlace(entry.category)
    return {
      key: `entry:${entry.type}`, title: entry.name, detail,
      icon: entry.kind === 'blueprint' ? BlueprintIcon : entry.kind === 'utility' ? Wrench : PanelTop,
      ...(entry.install === undefined ? {} : { detailIcon: Download }),
    }
  }
  const browsing = () => query().trim() === '' && category() === undefined && props.anchor.linkDrop === undefined && props.anchor.splice === undefined && requirements().length === 0
  const groups = createMemo((): readonly ProductSearchGroup[] => {
    if (!browsing()) return [{ key: 'matches', label: category() === undefined ? message('palette.kind.nodes') :
      category() === '' ? message('palette.category.uncategorized') : searchPlace(category()!), count: matches().length, rows: matches().map(row) }]
    const recent = matches().filter((entry) => props.recentTypes().includes(entry.type)).slice(0, 5)
    const folders = buildCategoryTree(matches().map((entry) => entry.category))
    return [
      ...(recent.length === 0 ? [] : [{ key: 'recent', label: message('search.group.recent'), rows: recent.map(row) }]),
      { key: 'categories', label: message('palette.category.navigation'), rows: [
        ...folders.folders.map((folder): ProductSearchRow => ({ key: `category:${folder.path}`, title: folder.name, icon: Folder, kind: 'folder', count: folder.count })),
        ...(folders.uncategorized > 0 ? [{ key: 'category:', title: message('palette.category.uncategorized'), icon: Folder, kind: 'folder' as const, count: folders.uncategorized }] : []),
      ] },
    ]
  })
  const selectedKey = () => {
    const keys = groups().flatMap((group) => group.rows.map((item) => item.key))
    return keys.includes(current() ?? '') ? current() : keys[0]
  }
  const selected = () => matches().find((entry) => `entry:${entry.type}` === selectedKey())
  const announcement = () => {
    const rows = groups().flatMap((group) => group.rows)
    const index = rows.findIndex((item) => item.key === selectedKey())
    if (index < 0) return query().trim() === ''
      ? message('palette.announcement.noNodes')
      : message('palette.announcement.noMatches', { query: query() })
    return message('palette.announcement.results', { count: rows.length, index: index + 1, name: rows[index]!.title })
  }
  const activate = (key: string) => {
    if (key.startsWith('category:')) { setCategory(key.slice(9)); setCurrent(undefined); return }
    const entry = matches().find((item) => `entry:${item.type}` === key)
    if (entry !== undefined) props.onCommit(entry)
  }
  const kinds = () => [
    { id: 'all', label: message('search.kind.all') },
    ...(['node', 'blueprint', 'utility', 'subgraph'] as const).filter((id) => id !== 'subgraph' || entries().some((entry) => entry.kind === id))
      .map((id) => ({ id, label: message(`palette.kind.${id === 'node' ? 'nodes' : id === 'blueprint' ? 'blueprints' : id === 'utility' ? 'utilities' : 'subgraphs'}`) })),
  ]
  const typeOptions = (direction: 'in' | 'out'): string[] => {
    const found = new Set<string>()
    const collect = (type: TypeExpr): void => {
      for (const label of typeExprCanonicalLabel(type).split(' | ')) found.add(label)
      if (type.kind === 'list' || type.kind === 'asset' || type.kind === 'stream') collect(type.element)
      else if (type.kind === 'variable') for (const allowed of type.allowedTypes ?? []) collect(allowed)
    }
    for (const entry of entries()) {
      if (entry.schema !== undefined) for (const type of direction === 'in' ? schemaInputTypes(entry.schema) : schemaOutputTypes(entry.schema)) collect(type)
      const descriptor = entry.blueprint?.descriptor
      for (const type of (direction === 'in' ? descriptor?.boundaryInputs : descriptor?.boundaryOutputs) ?? []) found.add(type)
    }
    return productSearchTypeOptions(found)
  }
  const typeShape = (type: string) => cardinalityOf(typeExprFromTypeId(type)) === 'list' ? 'diamond' as const : 'circle' as const
  let searchInput!: HTMLInputElement
  const typeMenu = (direction: 'takes' | 'gives') => {
    const wireType = () => {
      const drop = props.anchor.linkDrop
      return drop !== undefined && (drop.seeking === 'in' ? 'takes' : 'gives') === direction
        ? typeExprCanonicalLabel(drop.anchorType) : undefined
    }
    const selected = (type: string) => wireType() === type || requirements().some((item) => item.direction === direction && item.type === type)
    const change = (type: string) => {
      if (wireType() === type) props.onRemoveLinkDrop()
      else setRequirements((items) => selected(type)
        ? items.filter((item) => item.direction !== direction || item.type !== type)
        : [...items, { direction, type }])
      setCurrent(undefined)
      searchInput.focus({ preventScroll: true })
    }
    const label = () => message(direction === 'takes' ? 'palette.filter.takes' : 'palette.filter.gives')
    return <ProductMenu fill="quiet" align="end"
      label={label()} title={label()}
      filter={{ label: message(direction === 'takes' ? 'palette.filter.inputTypes' : 'palette.filter.outputTypes'), placeholder: message('palette.filter.findType') }}
      items={typeOptions(direction === 'takes' ? 'in' : 'out').map((type) => ({
          label: `${label()} ${productSearchTypeName(typeIdDisplayLabel(type))}`,
          labelContent: <ProductSearchTypeLabel label={productSearchTypeName(typeIdDisplayLabel(type))} direction={direction} color={typeColor(defaultTokens, type)} shape={typeShape(type)} />,
          checked: selected(type),
          onSelect: () => change(type),
        }))} />
  }
  const filters = <>{typeMenu('takes')}{typeMenu('gives')}</>
  let panel!: HTMLDivElement
  const place = () => {
    if (!panel) return
    const bounds = props.bounds()
    panel.style.maxWidth = ''
    const placement = placeFloatingSurface({
      // Reserve the full available height so changing results cannot move the field.
      surface: { width: panel.offsetWidth, height: bounds.height },
      anchor: { left: props.anchor.x, right: props.anchor.x, top: props.anchor.y, bottom: props.anchor.y },
      bounds: { left: 0, top: 0, right: bounds.width, bottom: bounds.height },
      direction: 'point', align: 'center', margin: semanticDesignTokens.space[4], gap: 0,
    })
    panel.style.left = `${placement.left}px`
    panel.style.top = `${placement.top}px`
    panel.style.maxWidth = `${placement.maxWidth}px`
    panel.style.maxHeight = `${placement.maxHeight}px`
  }
  createEffect(() => { props.bounds(); queueMicrotask(place) })
  return <div class="palette-layer node-palette-layer" data-testid="palette-backdrop">
    <div class="node-palette" data-testid="node-palette" role="dialog" aria-modal="true"
      aria-label={message(props.anchor.linkDrop === undefined ? 'palette.action.addNode' : 'palette.dialog.addCompatibleNode')}
      data-link-drop={props.anchor.linkDrop?.seeking}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.key !== 'Tab') return
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), [tabindex]:not([tabindex="-1"])')]
          .filter((element) => element.getClientRects().length > 0)
        const index = controls.indexOf(document.activeElement as HTMLElement)
        if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus() }
        else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0]?.focus() }
      }}
      ref={panel}>
      <Show when={category() !== undefined}>
        <ProductButton onClick={() => { setCategory(undefined); setCurrent(undefined) }}><ProductIcon icon={ArrowLeft} />{message('palette.category.back')}</ProductButton>
      </Show>
      <ProductSearch label={message('palette.action.addNode')} placeholder={message('palette.search.addNodePlaceholder')}
        query={query()} onQuery={(value) => { setQuery(value); setCurrent(undefined) }}
        kinds={kinds()} kind={kind()} onKind={(value) => { setKind(value); setCurrent(undefined) }}
        chips={[
          ...(props.anchor.linkDrop === undefined ? [] : [{
          label: typeLabelOf(props.anchor.linkDrop.anchorType),
          name: `${message(props.anchor.linkDrop.seeking === 'in' ? 'palette.filter.takes' : 'palette.filter.gives')} ${typeLabelOf(props.anchor.linkDrop.anchorType)}`,
          direction: props.anchor.linkDrop.seeking === 'in' ? 'takes' as const : 'gives' as const,
          color: presentedType(defaultTokens, props.anchor.linkDrop.anchorType).color,
          shape: cardinalityOf(props.anchor.linkDrop.anchorType) === 'list' ? 'diamond' as const : 'circle' as const,
          removeLabel: message('palette.filter.removeConnection'), onRemove: props.onRemoveLinkDrop,
          }]),
          ...requirements().map((item) => {
            const label = productSearchTypeName(typeIdDisplayLabel(item.type))
            const name = `${message(item.direction === 'takes' ? 'palette.filter.takes' : 'palette.filter.gives')} ${label}`
            return { label, name, direction: item.direction, color: typeColor(defaultTokens, item.type), shape: typeShape(item.type),
              removeLabel: message('palette.filter.removeType', { type: name }),
              onRemove: () => { setRequirements((items) => items.filter((candidate) => candidate !== item)); setCurrent(undefined) } }
          }),
        ]}
        filters={filters}
        groups={groups()} {...(selectedKey() === undefined ? {} : { current: selectedKey()! })}
        onCurrent={setCurrent} onActivate={activate} onClose={props.onClose}
        status={announcement()}
        markQuery={parseSearchFilters(query()).text}
        autofocus inputRef={(input) => { searchInput = input; input.dataset.testid = 'palette-search' }}
        empty={{ title: message('palette.empty.title'), detail: message(query().trim() === '' ? 'palette.empty.filters' : 'palette.empty.query') }}
        hints={[
          { keys: ['Up', 'Down'], label: message('search.hint.move') },
          { keys: ['Enter'], label: message(selected()?.install !== undefined ? 'search.hint.install' : selectedKey()?.startsWith('category:') ? 'search.hint.open' : 'search.hint.placeNode') },
          { keys: ['Tab'], label: message('search.hint.nextKind') },
          { keys: ['Esc'], label: message('search.hint.close') },
        ]}
        preview={<Show when={selected()}>{(entry) => <>
          <ProductSearchNodePreview title={entry().name}
            {...(entry().description === undefined ? {} : { description: entry().description! })}
            place={[searchPlace(entry().category), entry().pack].filter(Boolean).join(' - ')}
            flags={[
              ...(entry().install === undefined ? [] : [message('search.notInstalled')]),
              ...((entry().blueprint?.descriptor.boundaryInputs?.length ?? 0) === 0 ? [] : [message('palette.ports.declaredInputs')]),
              ...((entry().blueprint?.descriptor.boundaryOutputs?.length ?? 0) === 0 ? [] : [message('palette.ports.declaredOutputs')]),
              ...(entry().schema !== undefined && isDeprecated(entry().schema!) ? [message('palette.status.deprecated')] : []),
              ...(entry().schema?.experimental === true ? [message('palette.status.experimental')] : []),
            ]}
            drawing={<Show when={palettePreviewSchema(entry())}>{(schema) => <SchemaPreview schema={schema()} widgets={props.widgetRegistry} maximize subgraph={entry().kind === 'subgraph' || entry().kind === 'blueprint'} />}</Show>} />
          <Show when={entry().schema?.hasDocs === true && props.onHelp !== undefined}>
            <ProductButton onClick={() => props.onHelp?.(entry())}>{message('nodeHelp.action.help')}</ProductButton>
          </Show>
        </>}</Show>}
        previewPlace="beside" />
    </div>
  </div>
}
