/**
 * Layout edits on a subgraph boundary's stored body, as the Boundary panel
 * makes them: each returns a new body that `boundary.arrange` stores. They
 * move, box and unbox entries; they never add, remove or rebind an item.
 *
 * Entries are named by the ids the panel's tree uses: an item by its id, a
 * section by `section:<id>` and a line by `line:<id of its first field>`.
 */

import type { BoundaryEntry, BoundaryLineEntry, BoundarySectionEntry, Json } from '@dinkster/core'
import type { BoundaryTreeDrop } from '@dinkster/ui'

export const sectionKey = (id: string): string => `section:${id}`
export const lineKey = (line: BoundaryLineEntry): string => `line:${line.rows[0]?.id ?? ''}`
export const entryKey = (entry: BoundaryEntry): string =>
  entry.kind === 'section' ? sectionKey(entry.id) : entry.kind === 'line' ? lineKey(entry) : entry.id

/** An entry and the list it sits in, with that list's section (undefined at the top level). */
export interface Located {
  readonly entry: BoundaryEntry
  readonly list: readonly BoundaryEntry[]
  readonly section?: string
}

/** Finds an entry by key at any depth; a field inside a line is not an entry of its own. */
export function locate(entries: readonly BoundaryEntry[], key: string, section?: string): Located | undefined {
  for (const entry of entries) {
    if (entryKey(entry) === key) return { entry, list: entries, ...(section !== undefined ? { section } : {}) }
    if (entry.kind === 'section') {
      const found = locate(entry.rows, key, sectionKey(entry.id))
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** The line a field sits on, if it sits on one. */
export function lineOf(entries: readonly BoundaryEntry[], id: string): BoundaryLineEntry | undefined {
  for (const entry of entries) {
    if (entry.kind === 'line' && entry.rows.some((row) => row.id === id)) return entry
    if (entry.kind === 'section') {
      const found = lineOf(entry.rows, id)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * The slot an entry sits in now, counted among the entries shown while it is
 * lifted out of the list; a field of a line sits just after its line.
 */
export function placeOf(entries: readonly BoundaryEntry[], key: string, section?: string): BoundaryTreeDrop | undefined {
  const at = (index: number): BoundaryTreeDrop => ({ kind: 'slot', ...(section !== undefined ? { section } : {}), index })
  for (const [index, entry] of entries.entries()) {
    if (entryKey(entry) === key) return at(index)
    if (entry.kind === 'line' && entry.rows.some((row) => row.id === key)) return at(index + 1)
    if (entry.kind === 'section') {
      const found = placeOf(entry.rows, key, sectionKey(entry.id))
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** The body without one entry, and that entry. A line left with one field becomes that field. */
export function takeEntry(entries: readonly BoundaryEntry[], key: string): { rest: BoundaryEntry[]; taken?: BoundaryEntry } {
  let taken: BoundaryEntry | undefined
  const visit = (list: readonly BoundaryEntry[]): BoundaryEntry[] => list.flatMap((entry): BoundaryEntry[] => {
    if (taken !== undefined) return [entry]
    if (entryKey(entry) === key) {
      taken = entry
      return []
    }
    if (entry.kind === 'section') return [{ ...entry, rows: visit(entry.rows) }]
    if (entry.kind === 'line') {
      const row = entry.rows.find((candidate) => candidate.id === key)
      if (row === undefined) return [entry]
      taken = row
      const rows = entry.rows.filter((candidate) => candidate !== row)
      return rows.length === 1 ? [rows[0]!] : [{ ...entry, rows }]
    }
    return [entry]
  })
  const rest = visit(entries)
  return taken === undefined ? { rest } : { rest, taken }
}

/** The body with an entry put where a drop names: a slot among a list's shown entries, or the end of a line. */
export function putEntry(entries: readonly BoundaryEntry[], drop: BoundaryTreeDrop, entry: BoundaryEntry): BoundaryEntry[] {
  if (drop.kind === 'pocket') {
    if (entry.kind !== 'input') return [...entries]
    return entries.map((candidate): BoundaryEntry =>
      candidate.kind === 'line' && lineKey(candidate) === drop.line ? { ...candidate, rows: [...candidate.rows, entry] }
        : candidate.kind === 'section' ? { ...candidate, rows: putEntry(candidate.rows, drop, entry) }
          : candidate)
  }
  const insert = (list: readonly BoundaryEntry[]): BoundaryEntry[] => [...list.slice(0, drop.index), entry, ...list.slice(drop.index)]
  if (drop.section === undefined) return insert(entries)
  return entries.map((candidate): BoundaryEntry =>
    candidate.kind !== 'section' ? candidate
      : sectionKey(candidate.id) === drop.section ? { ...candidate, rows: insert(candidate.rows) }
        : { ...candidate, rows: putEntry(candidate.rows, drop, entry) })
}

/** Moves one entry to a drop; undefined when the entry is not in the body. */
export function moveEntry(entries: readonly BoundaryEntry[], key: string, drop: BoundaryTreeDrop): BoundaryEntry[] | undefined {
  const { rest, taken } = takeEntry(entries, key)
  return taken === undefined ? undefined : putEntry(rest, drop, taken)
}

/** The body with one section replaced by `change(section)`, or by its rows when `change` gives undefined. */
export function changeSection(
  entries: readonly BoundaryEntry[],
  id: string,
  change: (section: BoundarySectionEntry) => BoundarySectionEntry | undefined,
): BoundaryEntry[] {
  return entries.flatMap((entry): BoundaryEntry[] => {
    if (entry.kind !== 'section') return [entry]
    if (entry.id !== id) return [{ ...entry, rows: changeSection(entry.rows, id, change) }]
    const next = change(entry)
    return next === undefined ? [...entry.rows] : [next]
  })
}

/** The body with one output's own-row setting turned on or off. */
export function setOwnRow(entries: readonly BoundaryEntry[], id: string, ownRow: boolean): BoundaryEntry[] {
  return entries.map((entry): BoundaryEntry => {
    if (entry.kind === 'section') return { ...entry, rows: setOwnRow(entry.rows, id, ownRow) }
    if (entry.kind !== 'output' || entry.id !== id) return entry
    const { ownRow: _ownRow, ...rest } = entry
    return ownRow ? { ...rest, ownRow: true } : rest
  })
}

const sectionIds = (entries: readonly BoundaryEntry[]): string[] =>
  entries.flatMap((entry) => entry.kind === 'section' ? [entry.id, ...sectionIds(entry.rows)] : [])

/**
 * The body with a new, empty section at the end of the top level, before the
 * outputs that end it, and that section's id.
 */
export function addSection(entries: readonly BoundaryEntry[], displayName: string): { body: BoundaryEntry[]; id: string } {
  const taken = new Set(sectionIds(entries))
  let number = 1
  while (taken.has(`section${number}`)) number += 1
  const id = `section${number}`
  let at = entries.length
  while (at > 0 && entries[at - 1]!.kind === 'output') at -= 1
  return { body: [...entries.slice(0, at), { kind: 'section', id, displayName, rows: [] }, ...entries.slice(at)], id }
}

/** The `body` parameter of `boundary.arrange`: every entry by kind and id, with its layout settings. */
export function arrangeBody(entries: readonly BoundaryEntry[]): Json[] {
  return entries.map((entry): Json => {
    if (entry.kind === 'input') return { kind: 'input', id: entry.id }
    if (entry.kind === 'output') return { kind: 'output', id: entry.id, ...(entry.ownRow === true ? { ownRow: true } : {}) }
    if (entry.kind === 'line') return { kind: 'line', rows: entry.rows.map((row) => ({ kind: 'input', id: row.id })) }
    return {
      kind: 'section',
      id: entry.id,
      ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
      ...(entry.collapsedByDefault === true ? { collapsedByDefault: true } : {}),
      ...(entry.openName === false ? { openName: false } : {}),
      rows: arrangeBody(entry.rows),
    }
  })
}
