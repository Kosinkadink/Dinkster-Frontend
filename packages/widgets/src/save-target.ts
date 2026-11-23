import { jsonSameValue, type Json } from '@dinkster/core'
import { isSaveTarget } from './kinds.js'

/** What an open save target's box holds. */
export interface SaveTargetDraftInput {
  /** The value the box opened on: a target, or null for the default output. */
  readonly stored: Json
  readonly mount: string
  readonly prefix: string
  /** Clear destination was pressed and nothing changed since. */
  readonly cleared: boolean
  /** The ready writable mounts, or undefined while they cannot be used (loading, none ready, unreadable). */
  readonly ready: readonly string[] | undefined
}

/** What an open save target's box shows and what leaving it stores. */
export interface SaveTargetDraft {
  /** What leaving the box stores; undefined when it keeps the stored value. */
  readonly store: Json | undefined
  /** Mount and prefix together, as the row shows them; empty reads as the default output. */
  readonly rowText: string
  /** The picked mount is not among the ready ones. */
  readonly mountGone: boolean
  /** The prefix is typed and cannot be used. */
  readonly prefixInvalid: boolean
}

/**
 * Reads an open save target's box. It stores the mount and prefix together
 * only when the mount is ready and the prefix is valid, and null after
 * Clear destination; anything else, or the stored value again, keeps what
 * is stored. A picked mount that is gone is never replaced. An empty prefix
 * cannot be stored but is not marked, since a cleared target reads that way.
 */
export function saveTargetDraft(input: SaveTargetDraftInput): SaveTargetDraft {
  const prefixUsable = isSaveTarget({ mount: 'output', prefix: input.prefix })
  const mountReady = input.ready?.includes(input.mount) === true
  const mountGone = input.ready !== undefined && input.mount !== '' && !mountReady
  const value: Json | undefined = input.cleared
    ? null
    : !mountReady || !prefixUsable
      ? undefined
      : { mount: input.mount, prefix: input.prefix }
  return {
    store: value === undefined || jsonSameValue(value, input.stored) ? undefined : value,
    rowText: input.cleared || (input.prefix === '' && !isSaveTarget(input.stored))
      ? ''
      : [input.mount, input.prefix].filter((part) => part !== '').join('/'),
    mountGone,
    prefixInvalid: input.prefix !== '' && !prefixUsable,
  }
}
