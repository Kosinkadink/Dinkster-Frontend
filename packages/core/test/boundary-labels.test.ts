import { describe, expect, it } from 'vitest'
import { defaultBoundaryLabels, regionBoundaryLabels } from '../src/schema/boundary-labels.js'
import type { BoundaryItem } from '../src/format/document.js'

const item = (id: string, port = id, displayName?: string): BoundaryItem => ({
  id,
  ...(displayName === undefined ? {} : { displayName }),
  binds: { kind: 'port', node: 'node' as never, port: port as never },
})

describe('generated boundary labels', () => {
  it('preserves dynamic member and collision suffixes', () => {
    const items = [
      item('masks_m4'),
      item('masks_m7'),
      item('image_3'),
    ]
    expect([...defaultBoundaryLabels(items).values()]).toEqual(['masks_m4', 'masks_m7', 'image_3'])
  })

  it('preserves binding ids independently of interface ids and display names', () => {
    const items = [
      item('raw', 'MASK'),
      item('prompt', 'positive_prompt'),
      item('vae', 'VAE'),
      item('spaced-member', 'Masks M4'),
      item('spaced-ordinal', 'Image 3'),
    ]
    expect([...defaultBoundaryLabels(items).values()]).toEqual(['MASK', 'positive_prompt', 'VAE', 'Masks M4', 'Image 3'])
  })

  it('names unattached slots from their stable interface ids', () => {
    const unattached: BoundaryItem = { id: 'unused_input', binds: { kind: 'unbound', type: { kind: 'concrete', name: 'FLOAT' } } }
    expect(defaultBoundaryLabels([unattached]).get(unattached.id)).toBe('unused_input')
  })
})

describe('region boundary labels', () => {
  it('names ports by their loop role and disambiguates repeated roles', () => {
    const inputs = [item('image'), item('mask'), item('seed'), item('strength')]
    const outputs = [item('image'), item('mask'), item('state'), item('done')]
    const region = {
      kind: 'fold' as const,
      elementPorts: ['image', 'mask'],
      statePorts: ['seed'],
      outputRoles: {
        mask: { kind: 'compact' as const },
        state: { kind: 'state' as const, statePort: 'seed' },
      },
      continueOutput: 'done',
    }

    expect([...regionBoundaryLabels(inputs, region, 'inputs').values()]).toEqual([
      'Element', 'Element 2', 'State', 'Capture',
    ])
    expect([...regionBoundaryLabels(outputs, region, 'outputs').values()]).toEqual([
      'Gather', 'Compact', 'State', 'Continuation',
    ])
  })
})
