import { describe, expect, it } from 'vitest'

import { canonicalCompatTypeId, INTERCHANGEABLE_TYPE_IDS } from '@dinkster/core'

import { defaultTokens, presentedType, typeColor, typeDisplayAliases } from '../src/tokens.js'

/**
 * Every native boundary type id known to the frontend from the Dinkster
 * backend's schema wire. This list is the walked universe for the audit
 * below: adding an id here (or to any decision table, which the sync tests
 * force back into this list) demands the three coordinated decisions -
 * display alias, explicit color, interchangeability call - instead of
 * letting the hash-color fallback silently cover it, the failure mode
 * behind the dinkster.image (#267) and dinkster.mask (#270) fixes. A type that
 * exists only backend-side is procedural territory: the backend owner
 * announces new boundary types, and this list is the frontend's ledger of
 * having heard about them.
 */
const NATIVE_BOUNDARY_TYPE_IDS: readonly string[] = [
  'dinkster.model',
  'dinkster.conditioning',
  'dinkster.image',
  'dinkster.mask',
  'dinkster.latent',
  'dinkster.control',
  'dinkster.clip',
  'dinkster.vae',
  'dinkster.sampler',
  'dinkster.sigmas',
  'dinkster.guider',
  'dinkster.noise',
  // Pre-rename spellings of dinkster.clip/dinkster.vae still served by older backends.
  'dinkster.text_encoder',
  'dinkster.codec',
]

/**
 * Native ids DECIDED to stay distinct from every comfy.* type: the backend
 * registers no comfy spelling sharing their codec, so there is no second
 * wire id to unify. If the backend ever registers one (as it did for
 * image and mask), move the id into INTERCHANGEABLE_TYPE_IDS instead of
 * extending this list.
 */
const INTENTIONALLY_DISTINCT = new Set<string>([
  'dinkster.model',
  'dinkster.conditioning',
  'dinkster.latent',
  'dinkster.control',
  'dinkster.clip',
  'dinkster.vae',
  'dinkster.sampler',
  'dinkster.sigmas',
  'dinkster.guider',
  'dinkster.noise',
  'dinkster.text_encoder',
  'dinkster.codec',
])

describe('native type coverage audit', () => {
  it('gives every native boundary type id a display alias', () => {
    for (const id of NATIVE_BOUNDARY_TYPE_IDS) {
      expect(typeDisplayAliases[id], `${id} has no typeDisplayAliases entry`).toBeDefined()
    }
  })

  it('keeps the decision tables and the native id list in sync', () => {
    // Every dinkster.* id appearing in any decision table must be a known
    // native id, so the walked universe above cannot silently lag behind.
    for (const key of Object.keys(typeDisplayAliases)) {
      if (!key.startsWith('dinkster.')) continue
      expect(NATIVE_BOUNDARY_TYPE_IDS, `alias key ${key} is missing from NATIVE_BOUNDARY_TYPE_IDS`).toContain(key)
    }
    for (const id of INTENTIONALLY_DISTINCT) {
      expect(NATIVE_BOUNDARY_TYPE_IDS, `intentionally-distinct id ${id} is missing from NATIVE_BOUNDARY_TYPE_IDS`).toContain(id)
    }
  })

  it('backs every alias target with an explicit color, never the hash fallback', () => {
    for (const [id, target] of Object.entries(typeDisplayAliases)) {
      expect(Object.hasOwn(defaultTokens.typeColors, target), `${id} aliases to ${target}, which has no typeColors entry`).toBe(true)
      expect(typeColor(defaultTokens, id)).toBe(defaultTokens.typeColors[target])
    }
  })

  it('records an explicit interchangeability decision for every native id', () => {
    for (const id of NATIVE_BOUNDARY_TYPE_IDS) {
      const interchangeable = Object.hasOwn(INTERCHANGEABLE_TYPE_IDS, id)
      const distinct = INTENTIONALLY_DISTINCT.has(id)
      expect(interchangeable || distinct, `${id} has no interchangeability decision: add it to INTERCHANGEABLE_TYPE_IDS or INTENTIONALLY_DISTINCT`).toBe(true)
      expect(interchangeable && distinct, `${id} is marked both interchangeable and intentionally distinct`).toBe(false)
    }
  })

  it('presents both spellings of every interchangeable pair identically', () => {
    for (const [nativeId, canonicalId] of Object.entries(INTERCHANGEABLE_TYPE_IDS)) {
      expect(NATIVE_BOUNDARY_TYPE_IDS, `interchangeable key ${nativeId} is missing from NATIVE_BOUNDARY_TYPE_IDS`).toContain(nativeId)
      // The table maps native ids across the comfy-compat boundary; a
      // self-map or a native-to-native entry would make the decision
      // assertions above pass without deciding anything.
      expect(canonicalId).not.toBe(nativeId)
      expect(canonicalId.startsWith('comfy.'), `${nativeId} maps to ${canonicalId}, which is not a comfy.* id`).toBe(true)
      expect(canonicalCompatTypeId(nativeId)).toBe(canonicalId)
      const nativeAlias = typeDisplayAliases[nativeId]
      const canonicalAlias = typeDisplayAliases[canonicalId]
      expect(nativeAlias, `${nativeId} has no display alias`).toBeDefined()
      expect(canonicalAlias, `${canonicalId} has no display alias`).toBeDefined()
      expect(nativeAlias).toBe(canonicalAlias)
      const native = presentedType(defaultTokens, { kind: 'concrete', name: nativeId })
      const canonical = presentedType(defaultTokens, { kind: 'concrete', name: canonicalId })
      expect(native.label).toBe(canonical.label)
      expect(native.color).toBe(canonical.color)
    }
  })
})
