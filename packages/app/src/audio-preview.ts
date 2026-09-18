import type { NodePreview } from '@dinkster/canvas'
import type { RenditionInfo, ValueDescriptor, ValueQuery } from '@dinkster/client'
import type { PeekValues } from './peek-preview.js'

export const AUDIO_WINDOW_SECONDS = 3
export const AUDIO_WINDOW_BYTES = 32 * 1024 * 1024
export const audioNumber = (meta: Readonly<Record<string, unknown>>, key: string): number | undefined => {
  const value = meta[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Metadata inspection and bounded server renditions never open the original asset. */
export function audioPreview(values: PeekValues, query: ValueQuery, descriptor: ValueDescriptor, renditions: readonly RenditionInfo[]): NonNullable<NodePreview['audio']> {
  const meta = descriptor.meta ?? {}
  const provider = (kind: string, limits: readonly string[]) => renditions.find((entry) =>
    entry.kind === kind && !!entry.version && entry.parameters?.includes(kind) &&
    limits.every((key) => (audioNumber(entry.limits ?? {}, key) ?? 0) > 0 && Number.isSafeInteger(entry.limits?.[key])) &&
    (!entry.parameters.includes('batch') || (/^\d+$/.test(entry.defaults?.['batch'] ?? '') && Number.isSafeInteger(Number(entry.defaults?.['batch'])))))
  const waveformInfo = provider('waveform', ['width', 'height', 'pixels'])
  const waveformWidth = Math.min(waveformInfo?.limits?.['width'] ?? 0, 512)
  const waveformHeight = Math.min(waveformInfo?.limits?.['height'] ?? 0, Math.floor((waveformInfo?.limits?.['pixels'] ?? 0) / Math.max(waveformWidth, 1)), 128)
  const waveform = waveformInfo && waveformWidth > 0 && waveformHeight > 0
    ? { info: waveformInfo, width: waveformWidth, height: waveformHeight }
    : undefined
  const windowInfo = provider('window', ['durationSeconds', 'sampleValues'])
  const window = windowInfo
    ? { info: windowInfo, seconds: Math.min(windowInfo.limits!['durationSeconds']!, AUDIO_WINDOW_SECONDS) }
    : undefined
  const batchProvider = [window?.info, waveform?.info].find((entry) => entry?.parameters?.includes('batch'))
  return {
    identity: JSON.stringify(query), meta,
    canScrub: window !== undefined,
    canSelectBatch: batchProvider !== undefined,
    initialBatch: Number(batchProvider?.defaults?.['batch'] ?? 0),
    async load(start, batch, signal) {
      const total = audioNumber(meta, 'duration')
      const rate = audioNumber(meta, 'sample_rate')
      const channels = audioNumber(meta, 'channels')
      const samples = Math.min(window?.info.limits?.['sampleValues'] ?? 0, Math.floor((AUDIO_WINDOW_BYTES - 4096) / 4))
      const budgetSeconds = rate && channels ? Math.floor(samples / channels) / rate : AUDIO_WINDOW_SECONDS
      const duration = Math.min(window?.seconds ?? 0, budgetSeconds, total === undefined ? AUDIO_WINDOW_SECONDS : Math.max(0, total - start))
      if (!Number.isFinite(start) || start < 0 || !Number.isSafeInteger(batch) || batch < 0 || (window && duration <= 0)) throw new Error('Audio window is outside the effective timeline')
      const diagnostics: string[] = []
      if (total === undefined) diagnostics.push('Audio duration not reported: seeking and continuous playback are unavailable')
      const request = async (kind: 'waveform' | 'window'): Promise<ArrayBuffer | undefined> => {
        const info = kind === 'waveform' ? waveform?.info : window?.info
        if (!info) {
          diagnostics.push(`Audio ${kind} unavailable: backend does not advertise usable parameters, defaults, limits and version`)
          return undefined
        }
        const batchSupported = info.parameters!.includes('batch')
        if (!batchSupported && batch !== 0) {
          diagnostics.push(`Audio ${kind} unavailable: backend does not advertise batch selection`)
          return undefined
        }
        const result = await values.rendition(query, kind, {
          signal, rendererVersion: info.version!,
          ...(batchSupported ? { batch } : {}),
          ...(kind === 'waveform' ? { waveform: { width: waveform!.width, height: waveform!.height } } : { window: { start, duration } }),
        })
        if (!result.available) {
          diagnostics.push(`Audio ${kind}: ${result.reason} (${result.status}) - ${result.error}`)
          return undefined
        }
        const expected = kind === 'waveform' ? 'image/png' : 'audio/wav'
        if (result.mime !== expected || result.bytes.byteLength > (kind === 'window' ? AUDIO_WINDOW_BYTES : 1024 * 1024)) {
          diagnostics.push(`Audio ${kind}: invalid MIME or rendition exceeds preview budget`)
          return undefined
        }
        if (kind === 'waveform') diagnostics.push(result.waveform === 'sampled-peak'
          ? 'Waveform: sampled peaks (not exhaustive)'
          : result.waveform ? `Waveform method: ${result.waveform}` : 'Waveform sampling method not reported')
        return result.bytes
      }
      const [waveformBytes, windowBytes] = await Promise.all([request('waveform'), request('window')])
      return { start, duration, ...(waveformBytes ? { waveform: waveformBytes } : {}), ...(windowBytes ? { window: windowBytes } : {}), diagnostics }
    },
  }
}
