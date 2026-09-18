import { describe, expect, it } from 'vitest'
import { createCoreLensRegistry, LensRegistry } from '../src/lenses.js'

describe('LensRegistry', () => {
  it('resolves standard by default and registers definitions', () => {
    const registry = createCoreLensRegistry()
    expect(registry.resolve(undefined).id).toBe('standard')
    expect(registry.resolve('types').detailedPinTooltips).toBe(true)
    expect(registry.resolve('types').typeAdornments).toBe(true)
    expect(registry.resolve('exposure').widgetRowAffordance).toBe(true)
    expect(registry.resolve('exposure').previewSurfaceAffordance).toBe(true)
    const remove = registry.register({ id: 'custom', label: 'Custom', description: 'Test lens' })
    expect(registry.get('custom')?.label).toBe('Custom')
    remove()
    expect(registry.get('custom')).toBeUndefined()
  })

  it('requires its default to be registered', () => {
    expect(() => new LensRegistry().resolve(undefined)).toThrow(/default lens/)
  })
})
