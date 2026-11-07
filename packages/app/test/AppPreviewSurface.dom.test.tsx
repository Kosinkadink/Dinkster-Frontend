// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it } from 'vitest'
import { AppPreviewSurface } from '../src/AppPreviewSurface.js'
import type { PreviewLoader } from '../src/node-previews.js'

afterEach(() => document.body.replaceChildren())

describe('AppPreviewSurface', () => {
  it('explains an exposed preview before content exists', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <AppPreviewSurface
        surface={{}}
        loader={{} as PreviewLoader}
        ariaLabelledBy="preview-label"
      />
    ), root)

    expect(root.querySelector('[data-testid="app-preview-status"]')?.textContent)
      .toBe('Preview appears after execution.')
    dispose()
  })

  it.each([[undefined, undefined], ['PQ to sRGB', undefined], [undefined, true]] as const)('labels color conversion %s and bounded preview %s', (colorTransform, previewOnly) => {
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <AppPreviewSurface
        surface={{
          preview: {
            kind: 'model3d',
            src: '/api/assets/model',
            download: { src: '/api/assets/model', name: 'trellis2.glb', ...(previewOnly === true ? { previewOnly } : {}) },
            status: 'failed',
            ...(colorTransform === undefined ? {} : { colorTransform }),
          },
        }}
        loader={{} as PreviewLoader}
        ariaLabelledBy="preview-label"
      />
    ), root)

    const download = root.querySelector<HTMLAnchorElement>('[data-testid="app-preview-download"]')!
    expect(download.getAttribute('href')).toBe('/api/assets/model')
    expect(download.download).toBe('trellis2.glb')
    expect(download.textContent).toBe(previewOnly === true || colorTransform !== undefined ? 'Download preview' : 'Download output')
    expect(root.querySelector('[data-testid="app-preview-color-transform"]')?.textContent)
      .toBe(colorTransform === undefined ? undefined : `Preview color: ${colorTransform}`)
    dispose()
  })
})
