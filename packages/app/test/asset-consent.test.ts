import { describe, expect, it } from 'vitest'
import type { MissingAsset } from '@dinkster/client'
import { t } from '@dinkster/core'
import { presentAssetPlan } from '../src/AssetConsentDialog.js'

const asset = (overrides: Partial<MissingAsset> = {}): MissingAsset => ({
  digest: 'blake3:abc', name: 'Example model', status: 'missing', sources: [], fetchable: false, ...overrides,
})

describe('asset consent plan presentation', () => {
  it('describes packaged assets without a download warning', () => {
    expect(presentAssetPlan(asset({ packagedFrom: ['video.pack'] }), t).source).toBe('Ships with pack video.pack')
  })

  it('excludes unresolvable assets from consent', () => {
    const row = presentAssetPlan(asset(), t)
    expect(row.consentable).toBe(false)
    expect(row.source).toContain('Unresolvable')
  })

  it('reuses binary size formatting and presents remote hosts', () => {
    const row = presentAssetPlan(asset({ fetchable: true, size: 1572864, sources: ['https://models.example/a', 'https://models.example/b'] }), t)
    expect(row.size).toBe('1.5 MiB')
    expect(row.source).toBe('Download from models.example')
    expect(row.consentable).toBe(true)
  })
})
