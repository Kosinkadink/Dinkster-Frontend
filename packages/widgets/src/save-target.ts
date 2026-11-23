import { jsonSameValue, type Json } from '@dinkster/core'
import { isProjectDefaultTarget, isSaveTarget } from './kinds.js'

/** What an open save target's box holds. */
export interface SaveTargetDraftInput {
  /** The value the box keeps when it is left unchanged. */
  readonly stored: Json
  /** The picked mount, or null for Project default. */
  readonly mount: string | null
  readonly prefix: string
  /** The ready writable mounts, or undefined while they cannot be used (loading, none ready, unreadable). */
  readonly ready: readonly string[] | undefined
  /** What the row shows for Project default: the mount it means here, or its name while that is not known. */
  readonly projectMount: string
}

/** What an open save target's box shows and what leaving it stores. */
export interface SaveTargetDraft {
  /** What leaving the box stores; undefined when it keeps the stored value. */
  readonly store: Json | undefined
  /** Mount and prefix together, as the row shows them. */
  readonly rowText: string
  /** The picked mount is a named one that is not among the ready ones. */
  readonly mountGone: boolean
  /** The prefix is typed and cannot be used. */
  readonly prefixInvalid: boolean
}

/**
 * Reads an open save target's box. It stores Project default and the
 * prefix, or a ready mount and the prefix, when the prefix is valid;
 * anything else, or the stored value again, keeps what is stored. A
 * picked mount that is not ready is never replaced.
 */
export function saveTargetDraft(input: SaveTargetDraftInput): SaveTargetDraft {
  const prefixUsable = isProjectDefaultTarget({ prefix: input.prefix })
  const mountGone = input.mount !== null && input.ready !== undefined && !input.ready.includes(input.mount)
  const mountUsable = input.mount === null || input.ready?.includes(input.mount) === true
  const value: Json | undefined = !mountUsable || !prefixUsable
    ? undefined
    : input.mount === null ? { prefix: input.prefix } : { mount: input.mount, prefix: input.prefix }
  return {
    store: value === undefined || jsonSameValue(value, input.stored) ? undefined : value,
    rowText: [input.mount ?? input.projectMount, input.prefix].filter((part) => part !== '').join('/'),
    mountGone,
    prefixInvalid: input.prefix !== '' && !prefixUsable,
  }
}

/** A stored target as the row and the side part show it, or undefined for an empty one. */
export function saveTargetText(value: Json, projectMount: string): string | undefined {
  if (isSaveTarget(value)) return `${value.mount}/${value.prefix}`
  if (isProjectDefaultTarget(value)) return `${projectMount}/${value.prefix}`
  return undefined
}
