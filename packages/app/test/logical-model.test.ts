import { describe, expect, it } from 'vitest'
import { ingestLogicalModels } from '../src/asset-browser/logical-model-merge.js'
import {
  bindLogicalModelSelection,
  selectLogicalModelAuto,
  selectLogicalModelVariant,
} from '../src/asset-browser/logical-model-select.js'
import type {
  LogicalModelAdapter,
  SourceRef,
  VariantDescription,
} from '../src/asset-browser/logical-model.js'

const DIGEST_A = `blake3:${'a'.repeat(64)}`
const DIGEST_B = `blake3:${'b'.repeat(64)}`
const DIGEST_C = `blake3:${'c'.repeat(64)}`

const builtin: SourceRef = { sourceId: 'builtin', sourceKind: 'builtin-catalog', label: 'Built in' }
const providerA: SourceRef = { sourceId: 'provider-a', sourceKind: 'provider', label: 'Provider A' }
const providerB: SourceRef = { sourceId: 'provider-b', sourceKind: 'provider', label: 'Provider B' }
const resolver: SourceRef = { sourceId: 'resolver', sourceKind: 'resolver', label: 'Resolver' }
const local: SourceRef = { sourceId: 'local', sourceKind: 'local-scan', label: 'Local models' }

type VariantOverrides = Partial<Omit<VariantDescription, 'precision' | 'quantization' | 'format' | 'size' | 'digest' | 'localRef'>> & {
  dtype?: string | undefined
  precision?: string | undefined
  quantization?: string | undefined
  format?: string | undefined
  size?: number | undefined
  digest?: string | undefined
  localRef?: VariantDescription['localRef'] | undefined
}

const variant = (overrides: VariantOverrides = {}): VariantDescription => {
  const value = {
    variantId: 'fp16',
    logicalId: 'model.alpha',
    precision: 'FP16',
    format: 'safetensors',
    size: 100,
    digest: DIGEST_A,
    providers: [providerA],
    availability: 'downloadable',
    compatibility: { status: 'compatible' },
    ...overrides,
  }
  return value as unknown as VariantDescription
}

const description = (variants: readonly VariantDescription[], overrides: Record<string, unknown> = {}) => ({
  logicalId: 'model.alpha',
  displayName: 'Alpha',
  kind: 'checkpoints',
  aliases: ['alpha'],
  variants,
  ...overrides,
})

const adapter = (source: SourceRef, descriptions: readonly unknown[]): LogicalModelAdapter => ({ source, descriptions })

const localRef = (name = 'alpha-fp16.safetensors', digest = DIGEST_A) => ({
  digest,
  name,
  size: 100,
  mediaType: 'application/octet-stream',
  virtualPath: `models/${name}`,
})

const ingestOne = (adapters: readonly LogicalModelAdapter[]) => {
  const result = ingestLogicalModels(adapters)
  expect(result.diagnostics).toEqual([])
  expect(result.models).toHaveLength(1)
  return result.models[0]!
}

describe('logical model variant grouping V1', () => {
  it('installed FP16 plus downloadable FP8 under one logical model', () => {
    const model = ingestOne([
      adapter(builtin, [description([
        variant(),
        variant({ variantId: 'fp8', precision: 'FP8', digest: DIGEST_B }),
      ])]),
      adapter(local, [description([
        variant({ providers: [local], availability: 'installed', localRef: localRef() }),
      ])]),
    ])
    expect(model.variants.map((entry) => [entry.variantId, entry.availability])).toEqual([
      ['fp16', 'installed'],
      ['fp8', 'downloadable'],
    ])
  })

  it('retains distinct variant ids sharing one digest', () => {
    const model = ingestOne([
      adapter(providerA, [description([variant({ providers: [providerA] })])]),
      adapter(providerB, [description([variant({ variantId: 'provider-b-fp16', providers: [providerB] })])]),
    ])
    expect(model.variants).toHaveLength(2)
    expect(model.variants.map((entry) => entry.variantId)).toEqual(['fp16', 'provider-b-fp16'])
    const reversed = ingestOne([
      adapter(providerB, [description([variant({ variantId: 'provider-b-fp16', providers: [providerB] })])]),
      adapter(providerA, [description([variant({ providers: [providerA] })])]),
    ])
    expect(reversed.variants.map((entry) => entry.variantId)).toEqual(['fp16', 'provider-b-fp16'])
  })

  it('renamed local digest match enriches a built-in identity', () => {
    const renamed = localRef('renamed-by-user.safetensors')
    const model = ingestOne([
      adapter(builtin, [description([variant()])]),
      adapter(local, [description([variant({ variantId: 'local-name', providers: [local], availability: 'installed', localRef: renamed })])]),
    ])
    expect(model.variants).toHaveLength(1)
    expect(model.variants[0]).toMatchObject({ availability: 'installed', localRef: renamed })
  })

  it('keeps the first same-source local ref while enriching a built-in identity', () => {
    const first = localRef('first.safetensors')
    const second = localRef('second.safetensors')
    const result = ingestLogicalModels([
      adapter(builtin, [description([variant()])]),
      adapter(local, [description([variant({ providers: [local], availability: 'installed', localRef: first })])]),
      adapter(local, [description([variant({ providers: [local], availability: 'installed', localRef: second })])]),
    ])
    expect(result.models[0]!.variants[0]!.localRef).toEqual(first)
    expect(result.diagnostics.map((entry) => entry.code)).toContain('variant-metadata-conflict')
  })

  it('selects the same exact local AssetRef regardless of adapter order', () => {
    const localA: SourceRef = { sourceId: 'local-a', sourceKind: 'local-scan', label: 'Local A' }
    const localB: SourceRef = { sourceId: 'local-b', sourceKind: 'local-scan', label: 'Local B' }
    const refA = { ...localRef('a.safetensors'), virtualPath: 'models/a.safetensors' }
    const refB = { ...localRef('z.safetensors'), virtualPath: 'models/z.safetensors' }
    const adapters = [
      adapter(localB, [description([variant({ variantId: 'z', providers: [localB], availability: 'installed', localRef: refB })])]),
      adapter(localA, [description([variant({ variantId: 'a', providers: [localA], availability: 'installed', localRef: refA })])]),
    ]
    for (const ordered of [adapters, [...adapters].reverse()]) {
      const model = ingestOne(ordered)
      expect(model.variants[0]!.localRef).toEqual(refA)
      expect(bindLogicalModelSelection(model.variants[0]!)).toEqual({ kind: 'installed', assetRef: refA })
    }
  })

  it('basename digest conflict', () => {
    const model = ingestOne([adapter(providerA, [description([
      variant({ variantId: 'a', digest: DIGEST_A, providers: [local], availability: 'installed', localRef: localRef('same.safetensors', DIGEST_A) }),
      variant({ variantId: 'b', digest: DIGEST_B, providers: [local], availability: 'installed', localRef: localRef('same.safetensors', DIGEST_B) }),
    ])])])
    expect(model.variants).toHaveLength(2)
    expect(model.variants.map((entry) => entry.conflicts)).toEqual([
      [{ code: 'basename-digest-conflict', basename: 'same.safetensors', otherVariantId: 'b' }],
      [{ code: 'basename-digest-conflict', basename: 'same.safetensors', otherVariantId: 'a' }],
    ])
  })

  it('provider refresh enrichment without duplication', () => {
    const model = ingestOne([adapter(providerA, [
      description([variant({ precision: undefined, size: undefined })]),
      description([variant({ precision: 'FP16', size: 100 })], { displayName: 'Alpha Model', aliases: ['alpha', 'alpha-model'] }),
    ])])
    expect(model).toMatchObject({ displayName: 'Alpha Model', aliases: ['alpha', 'alpha-model'] })
    expect(model.variants).toHaveLength(1)
    expect(model.variants[0]).toMatchObject({ precision: 'FP16', size: 100 })
  })

  it('incompatible hardware variant visible with reason and excluded from Auto', () => {
    const model = ingestOne([adapter(providerA, [description([
      variant({ variantId: 'fast', compatibility: { status: 'incompatible', reason: 'requires CUDA capability 12' } }),
      variant({ variantId: 'portable', digest: DIGEST_B }),
    ])])])
    expect(model.variants[0]!.compatibility).toEqual({ status: 'incompatible', reason: 'requires CUDA capability 12' })
    expect(selectLogicalModelAuto(model, { precisionOrder: ['FP16'] })).toMatchObject({
      mode: 'binding', choice: { variantId: 'portable' }, reasonCodes: ['binding-single-compatible-candidate'],
    })
  })

  it('Auto compatible-selection-only', () => {
    const model = ingestOne([adapter(providerA, [description([
      variant({ variantId: 'unknown', compatibility: { status: 'unknown', reason: 'not probed' } }),
      variant({ variantId: 'blocked', digest: DIGEST_B, compatibility: { status: 'incompatible', reason: 'unsupported' } }),
    ])])])
    expect(selectLogicalModelAuto(model, { precisionOrder: ['FP16'] })).toEqual({
      mode: 'none',
      choice: undefined,
      requiresExplicitConfirmation: false,
      reasonCodes: ['no-compatible-available-variant'],
    })
  })

  it('Auto with multiple compatible siblings yields a recommendation, never a binding selection', () => {
    const model = ingestOne([
      adapter(providerA, [description([
        variant(),
        variant({ variantId: 'fp8', precision: 'FP8', digest: DIGEST_B }),
      ])]),
      adapter(local, [description([
        variant({ providers: [local], availability: 'installed', localRef: localRef() }),
      ])]),
    ])
    expect(selectLogicalModelAuto(model, { precisionOrder: ['FP8', 'FP16'] })).toMatchObject({
      mode: 'recommendation',
      choice: { variantId: 'fp16' },
      requiresExplicitConfirmation: true,
      reasonCodes: ['recommendation-multiple-compatible', 'compatible-installed', 'requires-explicit-confirmation'],
    })
    const downloadable = ingestOne([adapter(providerA, [description([
      variant(),
      variant({ variantId: 'fp8', precision: 'FP8', digest: DIGEST_B }),
    ])])])
    expect(selectLogicalModelAuto(downloadable, { precisionOrder: ['FP8', 'FP16'] })).toMatchObject({
      mode: 'recommendation', choice: { variantId: 'fp8' }, requiresExplicitConfirmation: true,
    })
  })

  it('Auto binds on expected-digest/explicit mapping and on exactly-one-post-compatibility candidate', () => {
    const model = ingestOne([adapter(providerA, [description([
      variant(),
      variant({ variantId: 'fp8', precision: 'FP8', digest: DIGEST_B }),
    ])])])
    expect(selectLogicalModelAuto(model, { precisionOrder: ['FP16'], expectedDigest: DIGEST_B })).toMatchObject({
      mode: 'binding', choice: { variantId: 'fp8' }, reasonCodes: ['binding-expected-digest'],
    })
    expect(selectLogicalModelAuto(model, { precisionOrder: ['FP16'], trustedVariantId: 'fp16' })).toMatchObject({
      mode: 'binding', choice: { variantId: 'fp16' }, reasonCodes: ['binding-explicit-mapping'],
    })
    const oneCompatible = ingestOne([adapter(providerA, [description([
      variant(),
      variant({ variantId: 'fp8', precision: 'FP8', digest: DIGEST_B, compatibility: { status: 'incompatible', reason: 'runtime mismatch' } }),
    ])])])
    expect(selectLogicalModelAuto(oneCompatible, { precisionOrder: ['FP8', 'FP16'] })).toMatchObject({
      mode: 'binding', choice: { variantId: 'fp16' }, reasonCodes: ['binding-single-compatible-candidate'],
    })
  })

  it('installed-but-incompatible stays installed and visible but is never selected or recommended', () => {
    const model = ingestOne([adapter(local, [description([
      variant({ providers: [local], availability: 'installed', localRef: localRef(), compatibility: { status: 'incompatible', reason: 'hardware mismatch' } }),
    ])])])
    expect(model.variants[0]).toMatchObject({
      availability: 'installed',
      compatibility: { status: 'incompatible', reason: 'hardware mismatch' },
    })
    expect(selectLogicalModelAuto(model, { precisionOrder: ['FP16'] })).toMatchObject({ mode: 'none', choice: undefined })
  })

  it('explicit variant acquisition intent', () => {
    const model = ingestOne([adapter(providerA, [description([variant()])])])
    const selection = selectLogicalModelVariant(model, 'fp16')
    expect(selection).toMatchObject({ ok: true, compatibility: { status: 'compatible' } })
    if (!selection.ok) throw new Error('expected explicit selection')
    expect(bindLogicalModelSelection(selection.choice)).toEqual({
      kind: 'acquisition',
      intent: {
        logicalId: 'model.alpha',
        variantId: 'fp16',
        providers: [providerA],
        expected: { size: 100, digest: DIGEST_A },
      },
    })
    expect(selectLogicalModelVariant(model, 'missing')).toEqual({ ok: false, code: 'variant-not-found' })
  })

  it('offline built-in catalog only (no resolver adapter present)', () => {
    const model = ingestOne([adapter(builtin, [description([
      variant({ providers: [builtin], availability: 'unavailable' }),
    ])])])
    expect(model.variants[0]!.availability).toBe('unavailable')
    expect(bindLogicalModelSelection(model.variants[0]!)).toEqual({ kind: 'unavailable', availability: 'unavailable' })
  })

  it('digestless catalog entries merge only by exact identity and can be enriched with a digest', () => {
    const model = ingestOne([adapter(builtin, [
      description([variant({ variantId: 'unknown-a', digest: undefined, providers: [builtin], availability: 'unavailable' })]),
      description([variant({ variantId: 'unknown-b', digest: DIGEST_A, providers: [builtin], availability: 'unavailable' })]),
      description([variant({ variantId: 'unknown-a', digest: DIGEST_B, providers: [builtin], availability: 'unavailable' })]),
    ])])
    expect(model.variants).toHaveLength(2)
    expect(model.variants.map((entry) => [entry.variantId, entry.digest])).toEqual([
      ['unknown-a', DIGEST_B],
      ['unknown-b', DIGEST_A],
    ])
  })

  it('installed execution binding returns the unchanged exact AssetRef', () => {
    const ref = localRef()
    const model = ingestOne([adapter(local, [description([
      variant({ providers: [local], availability: 'installed', localRef: ref }),
    ])])])
    expect(bindLogicalModelSelection(model.variants[0]!)).toEqual({ kind: 'installed', assetRef: ref })
    expect(Object.keys((bindLogicalModelSelection(model.variants[0]!) as { assetRef: object }).assetRef)).toEqual([
      'digest', 'name', 'size', 'mediaType', 'virtualPath',
    ])
  })
})

describe('logical model hostile input hardening', () => {
  it('rejects prototype-polluting keys', () => {
    const result = ingestLogicalModels([adapter({ ...builtin, sourceId: '__proto__' }, [description([variant()])])])
    expect(result.models).toEqual([])
    expect(result.diagnostics.map((entry) => entry.code)).toContain('hostile-key')
  })

  it('rejects duplicate ids within one adapter payload', () => {
    const result = ingestLogicalModels([adapter(builtin, [description([variant(), variant()])])])
    expect(result.models).toEqual([])
    expect(result.diagnostics.map((entry) => entry.code)).toContain('duplicate-id')
  })

  it('rejects NUL-containing ids', () => {
    const result = ingestLogicalModels([adapter(builtin, [description([variant({ variantId: 'bad\0id' })])])])
    expect(result.models).toEqual([])
    expect(result.diagnostics.map((entry) => entry.code)).toContain('invalid-id')
  })

  it('rejects conflicting kinds under one logicalId', () => {
    const result = ingestLogicalModels([adapter(builtin, [
      description([variant()]),
      description([variant({ variantId: 'other', digest: DIGEST_B })], { kind: 'loras' }),
    ])])
    expect(result.models).toEqual([])
    expect(result.diagnostics.map((entry) => entry.code)).toContain('conflicting-kind')
  })

  it('strictly rejects malformed adapter envelopes and non-exact AssetRefs', () => {
    const foreignPrototype = Object.create({ source: builtin, descriptions: [] }) as unknown
    const extraField = { source: builtin, descriptions: [], unexpected: true }
    const malformedAdapters = ingestLogicalModels([null, foreignPrototype, extraField])
    expect(malformedAdapters.models).toEqual([])
    expect(malformedAdapters.diagnostics.map((entry) => entry.code)).toEqual([
      'malformed-adapter', 'malformed-adapter', 'malformed-adapter',
    ])

    const sixFieldRef = { ...localRef(), unexpected: true }
    const malformedRef = ingestLogicalModels([adapter(local, [description([
      variant({ providers: [local], availability: 'installed', localRef: sixFieldRef }),
    ])])])
    expect(malformedRef.models).toEqual([])
    expect(malformedRef.diagnostics.map((entry) => entry.code)).toContain('malformed-description')
  })

  it('quarantines identity conflicts deterministically while retaining unrelated models', () => {
    const claim = (logicalId: string, digest: string, variantId = 'v') => adapter(providerA, [{
      logicalId,
      displayName: logicalId,
      kind: 'checkpoints',
      aliases: [],
      variants: [variant({ logicalId, variantId, digest })],
    }])
    const conflicting = [claim('model.a', DIGEST_A), claim('model.b', DIGEST_A), claim('model.c', DIGEST_A)]
    for (const ordered of [conflicting, [...conflicting].reverse()]) {
      const result = ingestLogicalModels([...ordered, claim('model.safe', DIGEST_C)])
      expect(result.models.map((model) => model.logicalId)).toEqual(['model.safe'])
      expect(result.diagnostics.map((entry) => entry.code)).toContain('digest-logical-conflict')
    }

    for (const digests of [[DIGEST_A, DIGEST_B], [DIGEST_B, DIGEST_A]]) {
      const result = ingestLogicalModels([adapter(providerA, [
        description([variant({ digest: digests[0] })]),
        description([variant({ digest: digests[1] })]),
      ])])
      expect(result.models).toHaveLength(1)
      expect(result.models[0]!.variants.map((entry) => entry.digest)).toEqual([DIGEST_A, DIGEST_B])
      expect(result.diagnostics).toEqual([])
    }
  })

  it('keeps an ambiguous digestless sibling standalone independent of input order', () => {
    const rows = [
      description([variant({ digest: undefined })]),
      description([variant({ digest: DIGEST_A })]),
      description([variant({ digest: DIGEST_B })]),
    ]
    for (const descriptions of [rows, [...rows].reverse()]) {
      const result = ingestLogicalModels([adapter(providerA, descriptions)])
      expect(result.models[0]!.variants.map((entry) => entry.digest)).toEqual([undefined, DIGEST_A, DIGEST_B])
      expect(result.diagnostics.map((entry) => entry.code)).toContain('ambiguous-digestless-variant')
    }
  })

  it('keeps a standalone scan when an earlier digestless resolver fact is nonlocal in either adapter order', () => {
    const authoritative = adapter(resolver, [
      description([variant({ digest: undefined, providers: [resolver], availability: 'downloadable', compatibility: { status: 'incompatible', reason: 'first fact' } })]),
      description([variant({ providers: [resolver], availability: 'installed', localRef: localRef() })]),
    ])
    const scan = adapter(local, [description([
      variant({ variantId: 'local-file', logicalId: 'local-name:alpha', providers: [local], availability: 'installed', localRef: localRef() }),
    ], { logicalId: 'local-name:alpha', displayName: 'alpha.safetensors' })])
    for (const adapters of [[authoritative, scan], [scan, authoritative]]) {
      const result = ingestLogicalModels(adapters)
      expect(result.models.map((model) => model.logicalId)).toEqual(['local-name:alpha', 'model.alpha'])
      expect(result.models[1]!.variants[0]!.availability).toBe('downloadable')
      expect(result.models[1]!.variants[0]!.localRef).toBeUndefined()
      expect(result.models[1]!.variants[0]!.compatibility).toEqual({ status: 'incompatible', reason: 'first fact' })
      expect(result.models[0]!.variants[0]!.localRef).toEqual(localRef())
      expect(result.diagnostics.map((entry) => entry.code)).toContain('variant-metadata-conflict')
    }
  })
})
