import type { NormalizedComboOption } from '@dinkster/core'

/** A combo option has a persisted value and independent presentation. */
export type ComboOption = NormalizedComboOption

export type ComboMenuEntry =
  | { readonly kind: 'option'; readonly option: ComboOption }
  | { readonly kind: 'folder'; readonly label: string; readonly path: readonly string[] }

export type ComboHighlightSource = 'keyboard' | 'pointer' | 'programmatic'

/**
 * Keep non-pointer highlight changes visible without letting hover-induced
 * layout changes create a mouseenter -> scroll -> mouseenter feedback loop.
 */
export function scrollComboHighlightIntoView(root: ParentNode | undefined, source: ComboHighlightSource): void {
  if (source === 'pointer') return
  root?.querySelector<HTMLElement>('.combo-menu-entry.active')?.scrollIntoView({ block: 'nearest' })
}

/**
 * Combo filtering deliberately uses substring matching rather than the node
 * palette's fuzzy ranker. A combo is a finite value picker, so preserving the
 * backend's order makes ArrowDown predictable and makes an empty query an
 * exact representation of the supplied option list.
 */
export function filterComboOptions(options: readonly ComboOption[], query: string): readonly ComboOption[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return options
  return options.filter((option) => [option.label, option.info, option.folder, String(option.value)]
    .some((value) => value?.toLocaleLowerCase().includes(needle)))
}

/** Direct children of one folder, or global matching leaves while searching. */
export function comboMenuEntries(
  options: readonly ComboOption[],
  folder: readonly string[],
  query: string,
): readonly ComboMenuEntry[] {
  if (query.trim() !== '') {
    return filterComboOptions(options, query).map((option) => ({ kind: 'option', option }))
  }
  const entries: ComboMenuEntry[] = []
  const folders = new Set<string>()
  for (const option of options) {
    const segments = option.folder?.split('/') ?? []
    if (segments.length < folder.length) continue
    if (!folder.every((segment, index) => segments[index] === segment)) continue
    if (segments.length > folder.length) {
      const label = segments[folder.length]!
      const path = [...folder, label]
      const key = path.join('/')
      if (!folders.has(key)) {
        folders.add(key)
        entries.push({ kind: 'folder', label, path })
      }
    } else {
      entries.push({ kind: 'option', option })
    }
  }
  return entries
}

/** Keep keyboard selection valid as filtering changes the number of rows. */
export function clampComboHighlight(index: number, optionCount: number): number {
  if (optionCount === 0) return 0
  return Math.max(0, Math.min(index, optionCount - 1))
}

/** Upper bound on combo rows in the DOM at once. */
export const COMBO_RENDER_CAP = 300

export interface ComboRenderWindow {
  /** First rendered entry index, inclusive. */
  readonly start: number
  /** One past the last rendered entry index. */
  readonly end: number
  readonly hiddenBefore: number
  readonly hiddenAfter: number
}

/**
 * The half-open entry range [start, end) to render, always containing the
 * highlighted index. Rendering every filtered entry froze the editor on
 * multi-thousand option lists, so oversized lists render a cap-sized window
 * instead. The window is anchored to half-cap blocks rather than centered on
 * the highlight: it only moves when the highlight crosses a block boundary,
 * so arrow keys do not rebuild rows on every press, and a deep initial value
 * is visible on open because the window follows the highlight.
 */
export function comboRenderWindow(totalCount: number, highlightIndex: number, cap: number = COMBO_RENDER_CAP): ComboRenderWindow {
  if (totalCount <= cap) return { start: 0, end: totalCount, hiddenBefore: 0, hiddenAfter: 0 }
  const step = Math.max(1, Math.floor(cap / 2))
  const index = clampComboHighlight(highlightIndex, totalCount)
  let start = (Math.floor(index / step) - 1) * step
  start = Math.min(start, totalCount - cap)
  // Containment guards: no-ops for cap >= 2, but keep [start, start + cap)
  // around the highlight even at cap 1.
  start = Math.max(start, index - cap + 1)
  start = Math.max(start, 0)
  start = Math.min(start, index)
  const end = Math.min(totalCount, start + cap)
  return { start, end, hiddenBefore: start, hiddenAfter: totalCount - end }
}
