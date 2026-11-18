import { expect, test } from '@playwright/test'
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
  'content detail',
  'settled zoom',
  'selection',
  'drag',
  'execution settled',
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
    test.use({ deviceScaleFactor: dpr })
    for (const theme of ['dark', 'light'] as const) {
      for (const [fixture] of canvasGalleryPages) {
        if (fixture === 'minimap') continue
        test(`${fixture}: retained history matches fresh redraws in ${theme} theme`, async ({
          page,
        }) => {
          const errors: string[] = []
          page.on('pageerror', (error) => errors.push(error.message))
          await page.goto('/#canvas')
          await expect(
            page.getByRole('img', {
              name: 'anatomy in dark theme',
              exact: true,
            }),
          ).toHaveAttribute('data-ready', 'anatomy-dark')
          await page.addScriptTag({ content: script })
          const result = await page.evaluate(
            async ({ fixture, theme }) =>
              window.canvasFrameEquivalence.compareCanvasFrames(fixture, theme),
            { fixture, theme },
          )
          expect(
            result.frames.map(({ state, differences }) => ({
              state,
              differences,
            })),
            fixture,
          ).toEqual(frameStates.map((state) => ({ state, differences: 0 })))
          expect(
            result.frames.find((frame) => frame.state === 'execution settled')!.candidateTiles,
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
          }
          expect(
            result.frames.map(({ state, directDifferences }) => ({
              state,
              differences: directDifferences,
            })),
            'Cached frames must also match independent direct painting',
          ).toEqual(frameStates.map((state) => ({ state, differences: 0 })))
          expect(errors).toEqual([])
        })
      }
    }
  })
}

test('every registered gallery widget survives selection, drag, edit and theme invalidation', async ({
  page,
}) => {
  await page.goto('/#canvas')
  await expect(
    page.getByRole('img', { name: 'anatomy in dark theme', exact: true }),
  ).toHaveAttribute('data-ready', 'anatomy-dark')
  await page.addScriptTag({ content: script })
  for (const input of galleryWidgetInputs) {
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
  }
})
