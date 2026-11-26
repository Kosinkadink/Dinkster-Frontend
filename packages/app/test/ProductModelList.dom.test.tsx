import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProductModelList,
  type ProductModel,
  type ProductModelListHandle,
} from '@dinkster/ui'

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
  it('inspects field versions by keyboard without committing or downloading and keeps chosen keys controlled', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const versions: ProductModel = {
      ...models[0]!,
      versions: [
        { ...models[0]!.versions[0]!, id: 'fp8:digest-a', name: 'FP8 A' },
        { ...models[0]!.versions[0]!, id: 'fp8:digest-b', name: 'FP8 B' },
        models[0]!.versions[1]!,
        { id: 'missing', name: 'Unavailable version', state: 'unavailable' },
      ],
    }
    const [selected, setSelected] = createSignal([
      { modelId: 'flux', versionId: 'fp8:digest-a' },
      { modelId: 'flux', versionId: 'fp8:digest-b' },
    ])
    const inspected: string[][] = []
    const downloaded: string[][] = []
    let handle: ProductModelListHandle | undefined
    const dispose = render(
      () => (
        <ProductModelList
          label="Field models"
          models={[versions, models[1]!]}
          selected={selected()}
          inlineDetails={false}
          ref={(value) => {
            handle = value
          }}
          onSelect={(modelId, versionId) =>
            inspected.push([modelId, versionId])
          }
          onDownload={(modelId, versionId) =>
            downloaded.push([modelId, versionId])
          }
          onShowFolder={() => {
            throw new Error('Inline field action must not run')
          }}
        />
      ),
      root,
    )
    const key = (value: string): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', {
        key: value,
        bubbles: true,
        cancelable: true,
      })
      document.activeElement?.dispatchEvent(event)
      return event
    }
    try {
      expect(handle).toBeDefined()
      handle!.focusFirst()
      expect(document.activeElement).toBe(button(root, 'FLUX.1 dev'))
      button(root, 'FLUX.1 dev').click()
      key('ArrowDown')
      expect(document.activeElement).toBe(button(root, 'FP8 A'))
      expect(inspected.at(-1)).toEqual(['flux', 'fp8:digest-a'])
      expect(button(root, 'FP8 A').getAttribute('aria-pressed')).toBe('true')
      expect(button(root, 'FP8 B').getAttribute('aria-pressed')).toBe('true')
      expect(button(root, 'FP8 A').hasAttribute('aria-expanded')).toBe(false)
      button(root, 'FP8 A').click()
      expect(root.textContent).not.toContain('flux-dev-fp8.safetensors')
      expect(root.textContent).not.toContain('Show folder')
      key('ArrowDown')
      expect(document.activeElement).toBe(button(root, 'FP8 B'))
      key('ArrowDown')
      button(root, 'Q4').click()
      expect(inspected.at(-1)).toEqual(['flux', 'q4'])
      expect(button(root, 'Q4').getAttribute('aria-pressed')).toBe('false')
      key('ArrowDown')
      button(root, 'Unavailable version').click()
      expect(inspected.at(-1)).toEqual(['flux', 'missing'])
      expect(
        button(root, 'Unavailable version').getAttribute('aria-pressed'),
      ).toBe('false')
      expect(downloaded).toEqual([])
      const activeBeforeSelection = document.activeElement
      setSelected([{ modelId: 'flux', versionId: 'fp8:digest-b' }])
      expect(document.activeElement).toBe(activeBeforeSelection)
      expect(button(root, 'FP8 A').getAttribute('aria-pressed')).toBe('false')
      expect(button(root, 'FP8 B').getAttribute('aria-pressed')).toBe('true')
      key('End')
      expect(document.activeElement).toBe(button(root, 'SDXL base'))
      key('Home')
      expect(document.activeElement).toBe(button(root, 'FLUX.1 dev'))
      const escaped: string[] = []
      root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') escaped.push(event.key)
      })
      expect(key('Escape').defaultPrevented).toBe(false)
      expect(escaped).toEqual(['Escape'])
      const count = inspected.length
      button(root, 'Download').focus()
      expect(key('ArrowDown').defaultPrevented).toBe(false)
      expect(inspected).toHaveLength(count)
      button(root, 'FLUX.1 dev').focus()
      button(root, 'FLUX.1 dev').click()
      key('ArrowDown')
      expect(document.activeElement).toBe(button(root, 'SDXL base'))
    } finally {
      dispose()
    }
  })

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
      expect(button(root, 'FLUX.1 dev').textContent).toContain(
        '1 here, 1 to download',
      )
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
      expect(button(root, 'Download').textContent).toBe('6.8 GB')
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
      expect(button(root, 'FLUX.1 dev').hasAttribute('aria-expanded')).toBe(
        false,
      )
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
