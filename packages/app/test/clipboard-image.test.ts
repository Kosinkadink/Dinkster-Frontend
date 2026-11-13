import { describe, expect, it } from 'vitest'
import { readClipboardImage, type ClipboardImageItem } from '../src/clipboard-image.js'

const item = (types: readonly string[], blobs: Record<string, Blob> = {}): ClipboardImageItem => ({
  types,
  getType: async (type) => {
    const blob = blobs[type]
    if (blob === undefined) throw new Error(`no blob for ${type}`)
    return blob
  },
})

describe('clipboard image reading', () => {
  const pngBlob = new Blob([new Uint8Array([137, 80])], { type: 'image/png' })

  it('returns the first supported image across mixed clipboard items', async () => {
    const items = [item(['text/plain']), item(['text/html', 'image/png'], { 'image/png': pngBlob })]
    await expect(readClipboardImage(async () => items)).resolves.toEqual({ blob: pngBlob, mediaType: 'image/png' })
  })

  it('prefers PNG across items even when an earlier item offers only WebP', async () => {
    const webpBlob = new Blob([new Uint8Array([82, 73])], { type: 'image/webp' })
    const items = [item(['image/webp'], { 'image/webp': webpBlob }), item(['image/png'], { 'image/png': pngBlob })]
    await expect(readClipboardImage(async () => items)).resolves.toEqual({ blob: pngBlob, mediaType: 'image/png' })
  })

  it('returns undefined when the clipboard holds no supported image', async () => {
    await expect(readClipboardImage(async () => [item(['text/plain', 'image/tiff'])])).resolves.toBeUndefined()
    await expect(readClipboardImage(async () => [])).resolves.toBeUndefined()
  })

  it('returns undefined when the read or the blob retrieval fails', async () => {
    await expect(readClipboardImage(() => { throw new Error('unsupported') })).resolves.toBeUndefined()
    await expect(readClipboardImage(async () => { throw new DOMException('denied', 'NotAllowedError') })).resolves.toBeUndefined()
    await expect(readClipboardImage(async () => [item(['image/png'])])).resolves.toBeUndefined()
  })
})
