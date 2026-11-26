import { expect, test, type Page } from '@playwright/test'
import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import type * as frameEquivalence from '../../canvas/gallery/frame-equivalence.js'
import {
  canvasGalleryPages,
  galleryWidgetInputs,
} from '../../canvas/gallery/fixtures.js'

declare global {
  interface Window {
    canvasFrameEquivalence: typeof frameEquivalence
  }
}

test.describe.configure({ mode: 'parallel' })

let script: string
const frameStates = [
  'initial',
  'integer pan',
  'fractional pan',
  'same-phase pan',
  'exposed edges',
  'return pan',
  'zoom in',
  'overview detail',
  'overview drag',
  'overview release',
  'content detail',
  'settled zoom',
  'selection',
  'drag',
  'drag across tiles',
  'reverse drag',
  'drag release',
  'execution settled',
  'preview update',
  'badge hover',
  'live resize at tile edge',
  'live resize at lower tile edge',
  'edit and release',
  'theme',
  'node style',
  'resize',
  'repeated repaint',
]

test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'error',
    build: {
      write: false,
      lib: {
        entry: fileURLToPath(
          new URL('../../canvas/gallery/frame-equivalence.ts', import.meta.url),
        ),
        name: 'canvasFrameEquivalence',
        formats: ['iife'],
      },
    },
  })
  const bundles = Array.isArray(result) ? result : [result]
  const bundle = bundles[0]
  if (bundles.length !== 1 || !bundle || !('output' in bundle))
    throw new Error('Expected a single frame comparison bundle')
  const chunk = bundle.output.find((output) => output.type === 'chunk')
  if (!chunk || chunk.type !== 'chunk')
    throw new Error('Frame comparison bundle is missing')
  script = chunk.code
})

for (const dpr of [1, 1.25, 2]) {
  test.describe(`Whole-frame equivalence at DPR ${dpr}`, () => {
    // Cases share this DPR's page; independent DPR groups can use separate workers.
    test.describe.configure({ mode: 'default' })
    let page: Page
    const errors: string[] = []
    test.beforeAll(async ({ browser }, testInfo) => {
      page = await browser.newPage({
        ...testInfo.project.use.contextOptions,
        baseURL: testInfo.project.use.baseURL!,
        viewport: testInfo.project.use.viewport!,
        deviceScaleFactor: dpr,
      })
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto('/#canvas')
      await expect(page.getByTestId('canvas-anatomy-0')).toHaveAttribute(
        'data-ready',
        'anatomy-dark',
      )
      await page.addScriptTag({ content: script })
    })
    test.afterAll(async () => {
      await page?.close()
    })
    for (const theme of ['dark', 'light'] as const) {
      for (const [fixture] of canvasGalleryPages) {
        if (fixture === 'minimap') continue
        test(`${fixture}: retained history matches fresh redraws in ${theme} theme`, async () => {
          const result = await page.evaluate(
            async ({ fixture, theme }) =>
              window.canvasFrameEquivalence.compareCanvasFrames(fixture, theme),
            { fixture, theme },
          )
          const expectedStates =
            fixture === 'anatomy'
              ? [...frameStates, 'numeric before', 'numeric edit']
              : frameStates
          expect(
            result.frames.map(({ state, differences }) => ({
              state,
              differences,
            })),
            fixture,
          ).toEqual(expectedStates.map((state) => ({ state, differences: 0 })))
          expect(
            result.frames.find((frame) => frame.state === 'execution settled')!
              .candidateTiles,
            'Settled execution must exercise retained graph images',
          ).toBeGreaterThan(0)
          expect(
            result.frames.every((frame) => frame.pixels > 0),
            fixture,
          ).toBe(true)
          expect(
            result.corruptionDifferences,
            'A single changed channel must fail comparison',
          ).toBe(1)
          expect(
            result.staleDifferences,
            'A stale frame must fail comparison',
          ).toBeGreaterThan(0)
          if (fixture === 'anatomy') {
            const repeated = result.frames.find(
              (frame) => frame.state === 'repeated repaint',
            )!
            expect(repeated.referenceTiles).toBeGreaterThan(0)
            expect(repeated.candidateTiles).toBe(0)
            const fractional = result.frames.find(
              (frame) => frame.state === 'fractional pan',
            )!
            expect(fractional.candidateTiles).toBe(0)
            const pan = result.frames.find(
              (frame) => frame.state === 'same-phase pan',
            )!
            expect(pan.candidateTiles).toBeLessThan(pan.referenceTiles)
            for (const state of [
              'selection',
              'drag',
              'drag release',
              'edit and release',
            ]) {
              const changed = result.frames.find(
                (frame) => frame.state === state,
              )!
              expect(changed.candidateTiles, state).toBeGreaterThan(0)
              expect(changed.candidateTiles, state).toBeLessThan(
                changed.referenceTiles,
              )
            }
          }
          expect(
            result.frames.map(({ state, directDifferences }) => ({
              state,
              differences: directDifferences,
            })),
            'Cached frames must also match independent direct painting',
          ).toEqual(expectedStates.map((state) => ({ state, differences: 0 })))
          expect(errors).toEqual([])
        })
      }
    }
  })
}

for (const input of galleryWidgetInputs)
  test(`gallery widget ${input.id} survives selection, drag, edit and theme invalidation`, async ({
    page,
  }) => {
    await page.goto('/#canvas')
    await expect(page.getByTestId('canvas-anatomy-0')).toHaveAttribute(
      'data-ready',
      'anatomy-dark',
    )
    await page.addScriptTag({ content: script })
    const result = await page.evaluate(
      async (widgetId) =>
        window.canvasFrameEquivalence.compareCanvasFrames(
          'widget-states',
          'dark',
          widgetId,
        ),
      input.id,
    )
    expect(
      result.frames.map(({ differences }) => differences),
      input.id,
    ).toEqual(frameStates.map(() => 0))
    expect(
      result.frames.map(({ directDifferences }) => directDifferences),
      input.id,
    ).toEqual(frameStates.map(() => 0))
    expect(result.corruptionDifferences, input.id).toBe(1)
    expect(result.staleDifferences, input.id).toBeGreaterThan(0)
  })
