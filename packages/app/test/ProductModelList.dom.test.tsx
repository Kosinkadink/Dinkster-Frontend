import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it } from 'vitest'
import { ProductModelList, type ProductModel } from '@dinkster/ui'

const models: readonly ProductModel[] = [
  {
    id: 'flux',
    name: 'FLUX.1 dev',
    kind: 'Diffusion model',
    versions: [
      {
        id: 'fp8',
        name: 'FP8',
        size: '11.9 GB',
        precision: 'FP8',
        state: 'installed',
        facts: [
          { label: 'File', value: 'flux-dev-fp8.safetensors' },
          { label: 'Folder', value: 'Studio models' },
        ],
      },
      {
        id: 'q4',
        name: 'Q4',
        size: '6.8 GB',
        precision: 'Q4',
        state: 'not-downloaded',
      },
    ],
  },
  {
    id: 'sdxl',
    name: 'SDXL base',
    kind: 'Checkpoint',
    versions: [
      {
        id: 'fp8',
        name: 'FP8',
        size: '6.9 GB',
        state: 'installed',
        facts: [{ label: 'File', value: 'sdxl-base.safetensors' }],
      },
    ],
  },
]

afterEach(() => document.body.replaceChildren())

function button(root: HTMLElement, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(
    (element) =>
      element.textContent?.includes(text) ||
      element.getAttribute('aria-label')?.includes(text),
  )
  expect(found, `Button containing ${text}`).toBeDefined()
  return found!
}

describe('ProductModelList', () => {
  it('expands versions without choosing and preserves both model and version identity for actions', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const chosen: string[][] = []
    const downloaded: string[][] = []
    const shown: string[][] = []
    const dispose = render(
      () => (
        <ProductModelList
          label="Models"
          models={models}
          onChoose={(modelId, versionId) => chosen.push([modelId, versionId])}
          onDownload={(modelId, versionId) =>
            downloaded.push([modelId, versionId])
          }
          onShowFolder={(modelId, versionId) =>
            shown.push([modelId, versionId])
          }
        />
      ),
      root,
    )
    try {
      expect(root.textContent).not.toContain('flux-dev-fp8.safetensors')
      button(root, 'FLUX.1 dev').click()
      expect(chosen).toEqual([])
      expect(button(root, 'FLUX.1 dev').getAttribute('aria-expanded')).toBe(
        'true',
      )
      button(root, 'FP8').click()
      expect(root.textContent).toContain('flux-dev-fp8.safetensors')
      button(root, 'Show folder').click()
      expect(shown).toEqual([['flux', 'fp8']])
      expect(chosen).toEqual([['flux', 'fp8']])
      button(root, 'Q4').click()
      expect(chosen).toEqual([['flux', 'fp8']])
      expect(root.textContent).toContain('Not downloaded')
      button(root, 'Download').click()
      expect(downloaded).toEqual([['flux', 'q4']])
      button(root, 'SDXL base').click()
      expect(root.textContent).toContain('sdxl-base.safetensors')
      expect(chosen).toEqual([
        ['flux', 'fp8'],
        ['sdxl', 'fp8'],
      ])
    } finally {
      dispose()
    }
  })

  it('updates a live version progress line without enabling selection or an independent download', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const [progress, setProgress] = createSignal<number | undefined>(0.25)
    const chosen: string[][] = []
    const downloaded: string[][] = []
    const dispose = render(
      () => (
        <ProductModelList
          label="Models"
          models={[
            {
              id: 'flux',
              name: 'FLUX.1 dev',
              kind: 'Diffusion model',
              versions: [
                {
                  id: 'fp16',
                  name: 'FP16',
                  state: 'downloading',
                  progress: progress(),
                  message: '6 of 24 GB',
                },
              ],
            },
          ]}
          onChoose={(modelId, versionId) => chosen.push([modelId, versionId])}
          onDownload={(modelId, versionId) =>
            downloaded.push([modelId, versionId])
          }
        />
      ),
      root,
    )
    try {
      expect(root.textContent).toContain('6 of 24 GB')
      expect(
        root
          .querySelector('[role="progressbar"]')
          ?.getAttribute('aria-valuenow'),
      ).toBe('0.25')
      button(root, 'FLUX.1 dev').click()
      setProgress(0.7)
      expect(button(root, 'FLUX.1 dev').getAttribute('aria-expanded')).toBe('true')
      expect(
        root
          .querySelector('[role="progressbar"]')
          ?.getAttribute('aria-valuenow'),
      ).toBe('0.7')
      setProgress(undefined)
      expect(
        root
          .querySelector('[role="progressbar"]')
          ?.hasAttribute('aria-valuenow'),
      ).toBe(false)
      expect(
        [...root.querySelectorAll('button')].some((element) =>
          element.textContent?.includes('Use this model'),
        ),
      ).toBe(false)
      expect(
        [...root.querySelectorAll('button')].some(
          (element) => element.textContent === 'Download',
        ),
      ).toBe(false)
      expect(chosen).toEqual([])
      expect(downloaded).toEqual([])
    } finally {
      dispose()
    }
  })
})
