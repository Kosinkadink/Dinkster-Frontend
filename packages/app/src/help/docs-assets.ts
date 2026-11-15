import type { DinksterConnection, DocsLocaleDescriptor } from '@dinkster/client'
import type { MarkdownAssets } from './Markdown.js'

export async function loadDocsAssets(
  connection: Pick<DinksterConnection, 'fetchDocsAsset'>,
  pack: string,
  assets: DocsLocaleDescriptor['assets'],
  signal: AbortSignal,
): Promise<MarkdownAssets> {
  signal.throwIfAborted()
  const entries = await Promise.all(Object.entries(assets).map(async ([source, asset]) => {
    let blob: Blob
    try { blob = await connection.fetchDocsAsset(pack, asset.digest, signal) }
    catch {
      signal.throwIfAborted()
      return []
    }
    signal.throwIfAborted()
    const url = URL.createObjectURL(blob)
    signal.addEventListener('abort', () => URL.revokeObjectURL(url), { once: true })
    return [[source, { url, mediaType: asset.mediaType }]]
  }))
  return Object.fromEntries(entries.flat())
}
