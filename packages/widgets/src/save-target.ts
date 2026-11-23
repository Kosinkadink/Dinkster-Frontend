import { jsonSameValue, type Json } from '@dinkster/core'
import { isSaveTarget } from './kinds.js'

/**
 * A target on Project default: it names no mount, so each project saves it
 * to its own default output mount. The SAVE_TARGET kind accepts only a
 * named mount, so only the gallery stores this shape.
 */
export const isProjectDefaultTarget = (value: unknown): value is { prefix: string } =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 1
  && isSaveTarget({ mount: 'output', prefix: (value as Record<string, unknown>)['prefix'] })

/** What an open save target's box holds. */
export interface SaveTargetDraftInput {
  /** The value the box opened on: a target, or null for the default output. */
  readonly stored: Json
  /** The picked mount, or null for Project default. */
  readonly mount: string | null
  readonly prefix: string
  /** Clear destination was pressed and nothing changed since. */
  readonly cleared: boolean
  /** The ready writable mounts, or undefined while they cannot be used (loading, none ready, unreadable). */
  readonly ready: readonly string[] | undefined
  /** What the row shows for Project default: the mount it means here, or its name while that is not known. */
  readonly projectMount?: string
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
 * only when the mount is ready, or is Project default, and the prefix is
 * valid, and null after Clear destination; anything else, or the stored
 * value again, keeps what is stored. A picked mount that is gone is never
 * replaced. An empty prefix cannot be stored but is not marked, since a
 * cleared target reads that way.
 */
export function saveTargetDraft(input: SaveTargetDraftInput): SaveTargetDraft {
  const prefixUsable = isSaveTarget({ mount: 'output', prefix: input.prefix })
  const projectDefault = input.mount === null
  const mountReady = projectDefault || input.ready?.includes(input.mount!) === true
  const mountGone = !projectDefault && input.ready !== undefined && input.mount !== '' && !mountReady
  const value: Json | undefined = input.cleared
    ? null
    : !mountReady || !prefixUsable
      ? undefined
      : projectDefault ? { prefix: input.prefix } : { mount: input.mount, prefix: input.prefix }
  const shownMount = projectDefault ? input.projectMount ?? '' : input.mount
  return {
    store: value === undefined || jsonSameValue(value, input.stored) ? undefined : value,
    rowText: input.cleared || (input.prefix === '' && !isSaveTarget(input.stored) && !isProjectDefaultTarget(input.stored))
      ? ''
      : [shownMount, input.prefix].filter((part) => part !== '').join('/'),
    mountGone,
    prefixInvalid: input.prefix !== '' && !prefixUsable,
  }
}
