import type { AssetUploadDestination, AssetUploadProgress, DinksterConnection, MediaAssetRef } from '@dinkster/client'
import { FileImportError, importNativeAsset, resolveDroppedAsset, type DesktopFileImportProgress } from '../desktop-bridge.js'
import { model3dMimeFor } from '../model3d-mime.js'
import { assetUploadPolicy, assetUploadSizeProblem, mediaAcceptsFile } from './helpers.js'

/** Native totals mark staging; only native progress reports the publication boundary. */
export type AssetFileImportProgress = (
  | (DesktopFileImportProgress & { readonly transport: 'native' })
  | { readonly transport: 'browser'; readonly phase: 'copying'; readonly received: number; readonly total: number | null }
) & { readonly mount?: string }

function importName(name: string): string {
  const basename = (name.split(/[\\/]/).filter(Boolean).at(-1) ?? name).trim().replace(/[\u0000-\u001f\u007f]/g, '')
  const bounded = Array.from(basename).slice(0, 255).join('')
  return bounded === '' || bounded === '.' || bounded === '..' ? 'upload' : bounded
}

/** Resolve mounted files first; missing native support or an explicit refusal permits byte upload. */
export async function importAssetFile(file: File, options: {
  readonly baseUrl: string
  readonly connection: Pick<DinksterConnection, 'fetchMountSettings' | 'uploadMediaAsset' | 'uploadLatentAsset' | 'uploadNamedAsset'>
  readonly accept: readonly string[]
  readonly kind: string | undefined
  readonly policy: ReturnType<typeof assetUploadPolicy>
  readonly destination: AssetUploadDestination
  readonly current: () => boolean
  readonly signal: AbortSignal
  readonly onDestination?: (mount: string) => void
  readonly onProgress?: (progress: AssetFileImportProgress) => void
}): Promise<{ readonly asset: MediaAssetRef; readonly existing: boolean } | undefined> {
  const { accept, kind, policy, current, signal, connection } = options
  signal.throwIfAborted()
  const effectiveType = model3dMimeFor(file.name, file.type) ?? file.type
  const media = kind === 'media/image' || kind === 'media/audio' || kind === 'media/video' ? kind : undefined
  const latent = kind === 'data/latent'
  const existing = await resolveDroppedAsset(options.baseUrl, file, current)
  signal.throwIfAborted()
  if (!current()) return undefined
  if (existing && accept.length > 0 && !mediaAcceptsFile(accept, existing.mediaType, existing.name)) {
    throw new FileImportError('The existing file is not compatible with this input. Nothing was uploaded.')
  }
  if (!existing && accept.length > 0 && !mediaAcceptsFile(accept, effectiveType, file.name) && !(latent && file.type === '')) {
    throw new FileImportError(`Unsupported file type: ${effectiveType || 'unknown'}`)
  }
  const choice = options.destination
  const mount = latent || existing ? undefined : choice.mount || (await connection.fetchMountSettings()).importMount
  signal.throwIfAborted()
  if (!current()) return undefined
  if (mount) options.onDestination?.(mount)
  const destination = {
    ...(mount ? { mount } : {}),
    ...(choice.folder ? { folder: choice.folder } : {}),
  }
  const name = importName(file.name)
  const imported = existing ? undefined : await importNativeAsset(options.baseUrl, file, {
    name,
    mediaType: latent ? 'application/x-comfy-latent' : effectiveType || 'application/octet-stream',
    ...(media !== undefined ? { kind: media } : {}),
    ...(latent ? { kind: 'data/latent' } : destination),
  }, current, { signal, ...(options.onProgress ? { onProgress: (progress: DesktopFileImportProgress) => {
    options.onProgress?.({ ...progress, transport: 'native', ...(mount ? { mount } : {}) })
  } } : {}) })
  signal.throwIfAborted()
  if (!current()) return undefined
  if (!existing && !imported) {
    const problem = assetUploadSizeProblem(file, kind, policy)
    if (problem !== undefined) throw new FileImportError(problem)
  }
  const transfer = {
    signal,
    ...(options.onProgress ? { onProgress: ({ sent, total }: AssetUploadProgress) => {
      if (!signal.aborted && current()) options.onProgress?.({ transport: 'browser', phase: 'copying', received: sent, total, ...(mount ? { mount } : {}) })
    } } : {}),
  }
  const asset = existing ?? imported ?? (media !== undefined
    ? await connection.uploadMediaAsset(file, { scope: 'local', kind: media, name, ...destination, ...transfer })
    : latent
      ? await connection.uploadLatentAsset(file, { scope: 'local', name, ...transfer })
      : await connection.uploadNamedAsset(file, { scope: 'local', name, ...destination, ...transfer }))
  signal.throwIfAborted()
  return current() ? { asset, existing: existing !== undefined } : undefined
}
