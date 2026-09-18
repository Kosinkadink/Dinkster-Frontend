/**
 * OS-clipboard image reading for canvas paste. The graph envelope rides
 * clipboard TEXT (clipboard-paste.ts); an image item can therefore never
 * shadow an internal copy. When an external app put both text and an image
 * on the clipboard, the image wins.
 */

const CLIPBOARD_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

export type ClipboardImageMediaType = (typeof CLIPBOARD_IMAGE_TYPES)[number]

/** First supported image media type advertised by a clipboard item, if any. */
export const pickClipboardImageType = (types: readonly string[]): ClipboardImageMediaType | undefined =>
  CLIPBOARD_IMAGE_TYPES.find((candidate) => types.includes(candidate))

/** Fixed asset name; mirrors the drop path, which never leaks local filenames. */
export const pastedImageName = (mediaType: ClipboardImageMediaType): string =>
  `pasted-image.${mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice('image/'.length)}`

export interface ClipboardImageItem {
  readonly types: readonly string[]
  readonly getType: (type: string) => Promise<Blob>
}

/**
 * Read the best supported image from the OS clipboard, preferring PNG over
 * JPEG over WebP across ALL clipboard items, not per item. Returns undefined
 * when the clipboard holds no image or the read fails (unsupported API,
 * denied permission, revoked item) so the caller can fall through to the
 * text-envelope paste.
 */
export async function readClipboardImage(
  read: () => Promise<readonly ClipboardImageItem[]>,
): Promise<{ readonly blob: Blob; readonly mediaType: ClipboardImageMediaType } | undefined> {
  let items: readonly ClipboardImageItem[]
  try { items = await read() } catch { return undefined }
  for (const mediaType of CLIPBOARD_IMAGE_TYPES) {
    const item = items.find((candidate) => candidate.types.includes(mediaType))
    if (item === undefined) continue
    try { return { blob: await item.getType(mediaType), mediaType } } catch { return undefined }
  }
  return undefined
}
