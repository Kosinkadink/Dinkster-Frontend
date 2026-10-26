import { describe, expect, it } from 'vitest'

import { defaultTokens, typeColor, typeDisplayAliases } from '../src/tokens.js'

/**
 * Every native boundary type id known to the frontend from the Dinkster
 * backend's schema wire. This list is the walked universe for the audit
 * below: adding an id here (or to any decision table, which the sync tests
 * force back into this list) demands an explicit color instead of
 * letting the hash-color fallback silently cover it, the failure mode
 * behind earlier image and mask fixes. A type that
 * exists only backend-side is procedural territory: the backend owner
 * announces new boundary types, and this list is the frontend's ledger of
 * having heard about them.
 */
const NATIVE_BOUNDARY_TYPE_IDS: readonly string[] = [
  'MODEL',
  'CONDITIONING',
  'IMAGE',
  'MASK',
  'LATENT',
  'comfy.CONTROL_NET',
  'CLIP',
  'VAE',
  'SAMPLER',
  'SIGMAS',
  'GUIDER',
  'NOISE',
]

describe('native type coverage audit', () => {
  it('keeps the decision tables and the native id list in sync', () => {
    for (const target of Object.values(typeDisplayAliases)) {
      expect(NATIVE_BOUNDARY_TYPE_IDS, `alias target ${target} is missing from NATIVE_BOUNDARY_TYPE_IDS`).toContain(target)
    }
  })

  it('backs every alias target with an explicit color, never the hash fallback', () => {
    for (const [id, target] of Object.entries(typeDisplayAliases)) {
      expect(Object.hasOwn(defaultTokens.typeColors, target), `${id} aliases to ${target}, which has no typeColors entry`).toBe(true)
      expect(typeColor(defaultTokens, id)).toBe(defaultTokens.typeColors[target])
    }
  })
})
