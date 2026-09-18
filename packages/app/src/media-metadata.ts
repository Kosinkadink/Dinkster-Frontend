import { parseAssetTypeId } from '@dinkster/core'

export type MediaKind = 'IMAGE' | 'MASK' | 'AUDIO' | 'VIDEO'

export type MediaMetadataFieldId =
  | 'storageDtype' | 'layout' | 'alphaMode' | 'dtype' | 'primaries' | 'transfer' | 'range'
  | 'polarity' | 'semantic' | 'sampleRateHz' | 'channels' | 'durationSeconds'
  | 'container' | 'codec' | 'pixelFormat' | 'alpha' | 'bitDepth' | 'colorSpace' | 'fps' | 'frameCount'

export interface MediaMetadataField {
  readonly id: MediaMetadataFieldId
  readonly value: string | boolean | undefined
}

export interface MediaMetadata {
  readonly kind: MediaKind
  readonly fields: readonly MediaMetadataField[]
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined

const text = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

const rationalText = (value: unknown): string | undefined => {
  if (Array.isArray(value) && value.length === 2 &&
    Number.isSafeInteger(value[0]) && Number.isSafeInteger(value[1]) && value[1] > 0) {
    return `${value[0]}/${value[1]}`
  }
  return text(value)
}

/** Read only declared facts; missing metadata never implies opaque pixels or a mask polarity. */
export function mediaMetadataOf(typeId: string, value: unknown): MediaMetadata | undefined {
  const type = parseAssetTypeId(typeId) ?? typeId
  const kind = type.split('.').at(-1)?.toUpperCase()
  if (kind !== 'IMAGE' && kind !== 'MASK' && kind !== 'AUDIO' && kind !== 'VIDEO') return undefined
  const meta = record(value) ?? {}
  const fields: MediaMetadataField[] = []
  const add = (id: MediaMetadataFieldId, value: unknown): void => {
    fields.push({ id, value: text(value) })
  }
  add('storageDtype', meta['storage_dtype'])
  if (kind === 'IMAGE') {
    const channels = record(meta['channels']) ?? {}
    const color = record(meta['color']) ?? {}
    add('layout', channels['layout'])
    add('alphaMode', channels['alpha'])
    add('dtype', meta['dtype'])
    add('primaries', color['primaries'])
    add('transfer', color['transfer'])
    add('range', color['range'])
  } else if (kind === 'MASK') {
    add('polarity', meta['polarity'])
    add('semantic', meta['semantic'])
    add('dtype', meta['dtype'])
  } else if (kind === 'AUDIO') {
    add('sampleRateHz', meta['sample_rate'])
    add('channels', meta['channels'])
    add('layout', meta['layout'])
    add('durationSeconds', meta['duration'])
    add('dtype', meta['dtype'])
  } else {
    const probe = record(meta['probe']) ?? {}
    const effective = record(meta['effective']) ?? probe
    add('container', meta['container'])
    add('codec', probe['video_codec'])
    add('pixelFormat', probe['pix_fmt'])
    const alpha = probe['alpha']
    fields.push({ id: 'alpha', value: typeof alpha === 'boolean' ? alpha : undefined })
    add('bitDepth', probe['bit_depth'])
    add('colorSpace', probe['color_space'])
    fields.push({ id: 'durationSeconds', value: rationalText(effective['duration']) })
    fields.push({ id: 'fps', value: rationalText(effective['fps']) })
    add('frameCount', effective['frame_count'])
  }
  return { kind, fields }
}
