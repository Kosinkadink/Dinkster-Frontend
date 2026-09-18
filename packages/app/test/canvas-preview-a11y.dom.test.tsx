import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it } from 'vitest'
import type { Scene } from '@dinkster/canvas'
import { CanvasPreviewA11y, selectedInputPreviewA11yTargets } from '../src/CanvasHost.js'

afterEach(() => document.body.replaceChildren())

const scene = ({
  nodes: [{ id: 'asset', layout: { title: 'Load Image' } }],
}) as unknown as Scene

describe('selected input preview accessibility', () => {
  it.each([
    [{ status: 'loading' as const }, 'Load Image, selected input example.png, 3 selected images: loading'],
    [{ status: 'unavailable' as const }, 'Load Image, selected input example.png, 3 selected images: unavailable'],
    [{ width: 320, height: 180 }, 'Load Image, selected input example.png, 3 selected images: 320 by 180 pixels'],
  ])('labels the passive image equivalent for state %#', (preview, label) => {
    const targets = selectedInputPreviewA11yTargets(scene, {
      asset: { name: 'example.png', count: 3, preview },
    })
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <CanvasPreviewA11y targets={targets} />, root)
    const image = root.querySelector('[data-testid="canvas-preview-a11y"]')!

    expect(image.getAttribute('role')).toBe('img')
    expect(image.getAttribute('aria-label')).toBe(label)
    expect(image.getAttribute('tabindex')).toBeNull()
    expect(root.querySelector('button')).toBeNull()
    dispose()
  })

  it('disappears when the selected input collection clears', () => {
    const [targets, setTargets] = createSignal(selectedInputPreviewA11yTargets(scene, {
      asset: { name: 'example.png', count: 1, preview: { width: 320, height: 180 } },
    }))
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <CanvasPreviewA11y targets={targets()} />, root)
    expect(root.querySelector('[data-testid="canvas-preview-a11y"]')).not.toBeNull()

    setTargets([])

    expect(root.querySelector('[data-testid="canvas-preview-a11y"]')).toBeNull()
    expect(root.querySelector('[aria-label="Selected input previews"]')).toBeNull()
    dispose()
  })
})
