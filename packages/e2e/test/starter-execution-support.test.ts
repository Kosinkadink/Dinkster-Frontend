import { describe, expect, it } from 'vitest'
import {
  COMPOSITION_BLOCKER_FAMILIES,
  MEDIA_PREFIX_FOR_KIND,
  STARTER_FAMILIES,
  STARTER_ROWS,
  parseStarterOverrides,
} from '../tests/starter-execution-support.js'

describe('starter execution matrix', () => {
  it('lists every starter family exactly once with a save node and terminal output kind', () => {
    expect(STARTER_ROWS).toHaveLength(26)
    expect(new Set(STARTER_FAMILIES).size).toBe(STARTER_ROWS.length)
    expect(new Set(STARTER_ROWS.map((row) => row.templateId)).size).toBe(STARTER_ROWS.length)
    for (const row of STARTER_ROWS) {
      expect(row.family).toMatch(/^dinkster\./)
      expect(row.saveNodeType).toMatch(/^dinkster\.save_/)
      expect(row.saveTargetPrefix).toBe(row.templateId)
      expect(MEDIA_PREFIX_FOR_KIND[row.outputKind]).toBeTruthy()
    }
  })

  it('expects the documented terminal output kind per family', () => {
    const byTemplate = new Map(STARTER_ROWS.map((row) => [row.templateId, row]))
    expect(byTemplate.get('sd15')!.outputKind).toBe('image')
    expect(byTemplate.get('sdxl-refiner')!.outputKind).toBe('image')
    expect(byTemplate.get('chroma')!.outputKind).toBe('image')
    expect(byTemplate.get('chroma-radiance')!.outputKind).toBe('image')
    expect(byTemplate.get('flux-dev')!.outputKind).toBe('image')
    expect(byTemplate.get('flux-schnell')!.outputKind).toBe('image')
    expect(byTemplate.get('flux2-dev')!.outputKind).toBe('image')
    expect(byTemplate.get('flux2-klein-9b')!.outputKind).toBe('image')
    expect(byTemplate.get('flux2-klein-4b')!.outputKind).toBe('image')
    expect(byTemplate.get('ltxv')!.outputKind).toBe('video')
    expect(byTemplate.get('ltxav')!.outputKind).toBe('video')
    expect(byTemplate.get('z-image')!.outputKind).toBe('image')
    expect(byTemplate.get('z-image-pixel')!.outputKind).toBe('image')
    expect(byTemplate.get('minimax-h3')!.outputKind).toBe('video')
    expect(byTemplate.get('minimax-music3')!.outputKind).toBe('audio')
    expect(byTemplate.get('krea2')!.outputKind).toBe('image')
    expect(byTemplate.get('ideogram4')!.outputKind).toBe('image')
    expect(byTemplate.get('seedvr2')!.outputKind).toBe('image')
    expect(byTemplate.get('anima')!.outputKind).toBe('image')
    expect(byTemplate.get('lumina2')!.outputKind).toBe('image')
    expect(byTemplate.get('trellis2')!.saveNodeType).toBe('dinkster.save_model3d')
    expect(byTemplate.get('qwen-image')!.outputKind).toBe('image')
    expect(byTemplate.get('triposplat')!.saveNodeType).toBe('dinkster.save_gaussian_splat')
    expect(byTemplate.get('wan21')!.outputKind).toBe('video')
    expect(byTemplate.get('wan22')!.outputKind).toBe('video')
  })

  it('marks the non-composing pack families as composition blockers', () => {
    expect([...COMPOSITION_BLOCKER_FAMILIES].sort()).toEqual([
      'dinkster.qwen_image',
      'dinkster.triposplat',
      'dinkster.wan21',
      'dinkster.wan22',
    ])
  })
})

describe('starter override parsing', () => {
  const valid = JSON.stringify({
    'dinkster.sd15': {
      models: [
        {
          node: 'checkpoint',
          input: 'checkpoint',
          documentedValue: 'v1-5-pruned-emaonly-fp16.safetensors',
          replacement: 'sd15-small-test.safetensors',
          sizeBytes: 1234,
          sha256: 'a'.repeat(64),
        },
      ],
      values: [{ node: 'latent', input: 'width', value: 256 }],
    },
  })

  it('accepts a well-formed pinned override file', () => {
    const overrides = parseStarterOverrides(valid)
    expect(overrides.get('dinkster.sd15')!.models).toHaveLength(1)
    expect(overrides.get('dinkster.sd15')!.values).toEqual([
      { node: 'latent', input: 'width', value: 256 },
    ])
  })

  it('accepts an empty override file', () => {
    expect(parseStarterOverrides('{}').size).toBe(0)
  })

  it('refuses malformed JSON', () => {
    expect(() => parseStarterOverrides('{')).toThrow(/malformed DINKSTER_STARTER_OVERRIDES/)
  })

  it('refuses non-object bodies', () => {
    expect(() => parseStarterOverrides('[]')).toThrow(/keyed by starter family/)
    expect(() => parseStarterOverrides('42')).toThrow(/keyed by starter family/)
  })

  it('refuses family-mismatched keys', () => {
    expect(() => parseStarterOverrides(JSON.stringify({ 'dinkster.nope': { values: [{ node: 'n', input: 'i', value: 1 }] } })))
      .toThrow(/not a starter family/)
  })

  it('refuses unpinned model rows: missing size or digest', () => {
    const missingSize = {
      'dinkster.sd15': {
        models: [
          {
            node: 'checkpoint',
            input: 'checkpoint',
            documentedValue: 'v1-5-pruned-emaonly-fp16.safetensors',
            replacement: 'sd15-small-test.safetensors',
            sha256: 'a'.repeat(64),
          },
        ],
      },
    }
    expect(() => parseStarterOverrides(JSON.stringify(missingSize))).toThrow(/sizeBytes/)
    const missingDigest = {
      'dinkster.sd15': {
        models: [
          {
            node: 'checkpoint',
            input: 'checkpoint',
            documentedValue: 'v1-5-pruned-emaonly-fp16.safetensors',
            replacement: 'sd15-small-test.safetensors',
            sizeBytes: 1234,
          },
        ],
      },
    }
    expect(() => parseStarterOverrides(JSON.stringify(missingDigest))).toThrow(/sha256/)
  })

  it('refuses a non-hex sha256', () => {
    const body = {
      'dinkster.sd15': {
        models: [
          {
            node: 'checkpoint',
            input: 'checkpoint',
            documentedValue: 'v1-5-pruned-emaonly-fp16.safetensors',
            replacement: 'sd15-small-test.safetensors',
            sizeBytes: 1234,
            sha256: 'zz'.repeat(32),
          },
        ],
      },
    }
    expect(() => parseStarterOverrides(JSON.stringify(body))).toThrow(/sha256/)
  })

  it('refuses path-like replacement filenames', () => {
    const body = {
      'dinkster.sd15': {
        models: [
          {
            node: 'checkpoint',
            input: 'checkpoint',
            documentedValue: 'v1-5-pruned-emaonly-fp16.safetensors',
            replacement: 'sub/dir/model.safetensors',
            sizeBytes: 1234,
            sha256: 'a'.repeat(64),
          },
        ],
      },
    }
    expect(() => parseStarterOverrides(JSON.stringify(body))).toThrow(/plain filename/)
  })

  it('refuses empty family overrides and unknown keys', () => {
    expect(() => parseStarterOverrides(JSON.stringify({ 'dinkster.sd15': {} }))).toThrow(/no rows/)
    expect(() =>
      parseStarterOverrides(JSON.stringify({ 'dinkster.sd15': { values: [{ node: 'n', input: 'i', value: 1 }], extra: 1 } })),
    ).toThrow(/unknown key/)
  })

  it('refuses unbounded value rows and duplicate targets', () => {
    expect(() =>
      parseStarterOverrides(JSON.stringify({ 'dinkster.sd15': { values: [{ node: 'n', input: 'i', value: { deep: 1 } }] } })),
    ).toThrow(/finite number or non-empty string/)
    expect(() =>
      parseStarterOverrides(JSON.stringify({ 'dinkster.sd15': { values: [{ node: 'n', input: 'i', value: null }] } })),
    ).toThrow(/finite number or non-empty string/)
    expect(() =>
      parseStarterOverrides(
        JSON.stringify({
          'dinkster.sd15': {
            values: [
              { node: 'n', input: 'i', value: 1 },
              { node: 'n', input: 'i', value: 2 },
            ],
          },
        }),
      ),
    ).toThrow(/more than once/)
  })
})
