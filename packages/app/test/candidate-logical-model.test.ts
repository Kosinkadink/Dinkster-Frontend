import { describe, expect, it } from 'vitest'
import type { CandidateV1 } from '@dinkster/client'
import { candidateLogicalModelAdapter } from '../src/asset-browser/candidate-logical-model.js'
import { ingestLogicalModels } from '../src/asset-browser/logical-model-merge.js'
import { localMountScanAdapter } from '../src/asset-browser/local-mount-logical-model.js'
import type { AssetBrowserItem, AssetSourceAdapter } from '../src/asset-browser/types.js'

const A = `blake3:${'a'.repeat(64)}`
const B = `blake3:${'b'.repeat(64)}`

const ref = (digest: string, path: string) => ({
  digest,
  name: path.split('/').at(-1)!,
  size: 100,
  mediaType: 'application/x-safetensors',
  virtualPath: path,
})

const candidate = (digest: string, overrides: Partial<CandidateV1> = {}): CandidateV1 => ({
  logicalId: 'authoritative:model',
  family: 'Model',
  assetKind: 'model/checkpoint',
  variantId: 'fp8',
  dtype: 'float8_e4m3fn',
  quantization: 'fp8',
  format: 'safetensors',
  role: 'base',
  requirements: { loaders: ['LoadCheckpoint'], runtimes: ['cuda'], hardware: ['sm_89'] },
  digest,
  size: 100,
  mediaType: 'application/x-safetensors',
  availability: { status: 'downloadable', reason: 'provider only' },
  compatibility: { status: 'compatible', reason: '' },
  providerSources: [{
    source: { providerId: 'provider', sourceId: digest },
    status: 'available',
    reason: '',
    requires: {},
  }],
  ...overrides,
})

const localSource = (digest: string): AssetSourceAdapter => ({
  id: 'mount:models',
  label: 'Models',
  sourceLabel: 'Models',
  capabilities: { folders: true, query: true, kindFilter: true, thumbnails: false, actions: false },
  page: async (request) => request.cursor === undefined ? {
    items: [{
      id: `mount:models:${digest}`,
      name: 'local.safetensors',
      kind: 'model/checkpoint',
      digest,
      size: 100,
      mediaType: 'application/x-safetensors',
      virtualPath: 'models/local.safetensors',
      source: { id: 'mount:models', label: 'Models', path: 'models/local.safetensors' },
    } satisfies AssetBrowserItem],
  } : { items: [] },
})

describe('CandidateV1 logical model adapter', () => {
  it('retains same-variant different-digest siblings with truthful Candidate facts', () => {
    const result = ingestLogicalModels([candidateLogicalModelAdapter([candidate(B), candidate(A)])])
    expect(result.diagnostics).toEqual([])
    expect(result.models).toHaveLength(1)
    expect(result.models[0]!.variants.map((variant) => [variant.variantId, variant.digest])).toEqual([
      ['fp8', A],
      ['fp8', B],
    ])
    expect(result.models[0]!.variants[0]).toMatchObject({
      dtype: 'float8_e4m3fn',
      quantization: 'fp8',
      format: 'safetensors',
      compatibility: { status: 'compatible' },
      availability: 'downloadable',
    })
  })

  it('unions providers for an identical tuple and diagnoses contradictory scalar recurrence', () => {
    const first = candidate(A)
    const second = candidate(A, {
      dtype: 'contradictory',
      providerSources: [{
        source: { providerId: 'mirror', sourceId: 'two' },
        status: 'available', reason: '', requires: {},
      }],
    })
    const result = ingestLogicalModels([
      candidateLogicalModelAdapter([first], 'candidate-page-1'),
      candidateLogicalModelAdapter([second], 'candidate-page-2'),
    ])
    expect(result.models[0]!.variants).toHaveLength(1)
    expect(result.models[0]!.variants[0]!.dtype).toBe('float8_e4m3fn')
    expect(result.models[0]!.variants[0]!.providers.map((provider) => provider.label)).toEqual([
      'mirror / two',
      `provider / ${A}`,
    ])
    expect(result.diagnostics.map((entry) => entry.code)).toContain('variant-metadata-conflict')
  })

  it('re-homes a scan only into an exact local Candidate in either adapter order', async () => {
    const local = await localMountScanAdapter([localSource(A)], 'model/checkpoint')
    const exact = ref(A, 'candidate/exact.safetensors')
    const authoritative = candidateLogicalModelAdapter([candidate(A, {
      availability: { status: 'local', reason: '' },
      assetRef: exact,
    })])
    for (const adapters of [[local, authoritative], [authoritative, local]]) {
      const result = ingestLogicalModels(adapters)
      expect(result.diagnostics).toEqual([])
      expect(result.models.map((model) => model.logicalId)).toEqual(['authoritative:model'])
      expect(result.models[0]!.variants).toHaveLength(1)
      expect(result.models[0]!.variants[0]).toMatchObject({ availability: 'installed', digest: A })
      expect(result.models[0]!.variants[0]!.providers.map((provider) => provider.sourceId)).toContain('mount:models')
      expect(result.models[0]!.variants[0]!.localRef?.digest).toBe(A)
    }
  })

  it('keeps nonlocal authoritative and independently scanned rows separate without quarantine or ref transfer', async () => {
    const local = await localMountScanAdapter([localSource(A)], 'model/checkpoint')
    const result = ingestLogicalModels([candidateLogicalModelAdapter([candidate(A)]), local])
    expect(result.diagnostics.map((entry) => entry.code)).not.toContain('digest-logical-conflict')
    expect(result.models.map((model) => model.logicalId)).toEqual(['authoritative:model', 'local-name:local.safetensors'])
    expect(result.models[0]!.variants[0]!.localRef).toBeUndefined()
    expect(result.models[1]!.variants[0]!.localRef).toEqual(ref(A, 'models/local.safetensors'))
  })
})
