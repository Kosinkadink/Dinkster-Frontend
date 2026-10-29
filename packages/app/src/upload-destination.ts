import type { AssetUploadDestination } from '@dinkster/client'

export interface UploadDestinationChoice extends AssetUploadDestination {
  readonly remember: boolean
}

type DestinationStorage = Pick<Storage, 'getItem' | 'setItem'>
const key = (backend: string, project: string): string => `dinkster.uploadDestination.${encodeURIComponent(backend)}.${encodeURIComponent(project)}`

export function readUploadDestination(backend: string, project: string, storage?: DestinationStorage): UploadDestinationChoice {
  try {
    const value: unknown = JSON.parse((storage ?? globalThis.localStorage).getItem(key(backend, project)) ?? 'null')
    if (typeof value === 'object' && value !== null) {
      const row = value as Record<string, unknown>
      if (row['version'] === 1 && typeof row['mount'] === 'string' && typeof row['folder'] === 'string') {
        return { mount: row['mount'], folder: row['folder'], remember: true }
      }
    }
  } catch { /* Unavailable or corrupt preferences never choose a destination. */ }
  return { remember: false }
}

/** Call only after an explicitly confirmed import succeeds; cancelled drafts never change defaults. */
export function saveUploadDestination(backend: string, project: string, choice: UploadDestinationChoice, storage?: DestinationStorage): void {
  if (choice.remember) (storage ?? globalThis.localStorage).setItem(key(backend, project), JSON.stringify({ version: 1, mount: choice.mount ?? '', folder: choice.folder ?? '' }))
}
