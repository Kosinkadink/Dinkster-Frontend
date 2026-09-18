import { describe, expect, it } from 'vitest'
import { autoSpecialization } from '../src/dynamic-slot.js'

const image = { kind: 'concrete', name: 'IMAGE' } as const
const variants = [
  { key: 'image', type: image },
  { key: 'latent', type: { kind: 'concrete', name: 'LATENT' } as const },
]

describe('DynamicSlot gesture-time auto specialization', () => {
  it('picks the only compatible variant', () => expect(autoSpecialization(image, variants, undefined)).toBe('image'))
  it('abstains for a union producer', () => expect(autoSpecialization({ kind: 'union', names: ['IMAGE', 'LATENT'] }, variants, undefined)).toBeUndefined())
  it('abstains for a wildcard producer', () => expect(autoSpecialization({ kind: 'wildcard' }, variants, undefined)).toBeUndefined())
  it('abstains when two variants accept the atom', () => expect(autoSpecialization(image, [...variants, { key: 'any', type: { kind: 'wildcard' } }], undefined)).toBeUndefined())
  it('never overwrites an existing selection', () => expect(autoSpecialization(image, variants, 'latent')).toBeUndefined())
})
