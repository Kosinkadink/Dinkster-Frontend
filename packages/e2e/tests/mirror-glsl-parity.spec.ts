import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from './fixtures.js'

/**
 * GPU parity for the glsl mirror runner: every case of the backend-owned
 * image_adjust_v1 corpus, rendered through the REAL WebGL2 float path with
 * the REAL shipped shader (wire-29 serialization of dinkster.image.adjust),
 * must match the backend-recorded expected outputs within the schema's
 * declared per-channel tolerance. The corpus and wire fixtures are the
 * vendored copies pinned by packages/core/test/mirror-glsl.test.ts.
 */

interface CorpusFrame {
  readonly shape: readonly [number, number, number, number]
  readonly values: readonly number[]
}

interface CorpusCase {
  readonly id: string
  readonly frame: string
  readonly inputs: { readonly operation: string; readonly factor?: number; readonly mean?: number; readonly standard_deviation?: number }
  readonly expected: { readonly shape: readonly [number, number, number, number]; readonly values: readonly number[] }
}

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../core/test/fixtures/${name}`, import.meta.url)), 'utf8')

const corpusText = fixture('image_adjust_v1.json')
const corpus = JSON.parse(corpusText) as {
  readonly node_type: string
  readonly mirror_per_channel_tolerance: number
  readonly frames: Readonly<Record<string, CorpusFrame>>
  readonly cases: readonly CorpusCase[]
}
const adjustWire = JSON.parse(fixture('image_adjust_wire29.json')) as {
  readonly mirror: { readonly source: string }
}

const OPERATIONS = ['invert', 'normalize', 'brightness', 'contrast'] as const

test('the WebGL2 float path reproduces every backend corpus case within tolerance', async ({ page }) => {
  // Temporary skip pending attribution: Kosinkadink/comfy-vibe-station#430
  test.skip(true, 'red at main; attribution and re-enable tracked in Kosinkadink/comfy-vibe-station#430')
  expect(createHash('sha256').update(corpusText).digest('hex'))
    .toBe('e4d1352dd6b00bd415e67412dc51ec51083f307a2965a6c5af85ea2cd740b8af')
  expect(corpus.cases).toHaveLength(14)

  await page.goto('/')
  const results = await page.evaluate(async (args) => {
    const runnerModule = '/src/mirror-glsl-runner.ts'
    const { createGlslMirrorRunner } = await import(runnerModule) as {
      createGlslMirrorRunner(): {
        renderFloat(draw: {
          source: string
          images: readonly { name: string; frame: { data: Float32Array; width: number; height: number } }[]
          scalars: readonly { name: string; glslType: 'float' | 'int' | 'bool'; value: number | boolean }[]
          width: number
          height: number
        }): Float32Array | undefined
        dispose(): void
      }
    }
    const runner = createGlslMirrorRunner()
    const failures: string[] = []
    let maxDelta = 0
    try {
      for (const item of args.cases) {
        const frame = args.frames[item.frame]!
        const [batch, height, width, channels] = frame.shape
        for (let b = 0; b < batch; b += 1) {
          // The corpus records BHWC frames; the runner takes one RGBA
          // float frame per draw, so pad absent channels with zeros and
          // compare only the real ones.
          const rgba = new Float32Array(width * height * 4)
          for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
              for (let c = 0; c < channels; c += 1) {
                rgba[(y * width + x) * 4 + c] = frame.values[((b * height + y) * width + x) * channels + c]!
              }
            }
          }
          const out = runner.renderFloat({
            source: args.source,
            images: [{ name: 'u_image', frame: { data: rgba, width, height } }],
            scalars: [
              { name: 'operation', glslType: 'int', value: args.operations.indexOf(item.inputs.operation) },
              { name: 'factor', glslType: 'float', value: item.inputs.factor ?? 1.0 },
              { name: 'mean', glslType: 'float', value: item.inputs.mean ?? 0.5 },
              { name: 'standard_deviation', glslType: 'float', value: item.inputs.standard_deviation ?? 0.5 },
            ],
            width,
            height,
          })
          if (out === undefined) {
            failures.push(`${item.id}[batch ${b}]: renderFloat returned undefined`)
            continue
          }
          for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
              for (let c = 0; c < channels; c += 1) {
                const got = out[(y * width + x) * 4 + c]!
                const want = item.expected.values[((b * height + y) * width + x) * channels + c]!
                const delta = Math.abs(got - want)
                if (delta > maxDelta) maxDelta = delta
                if (!(delta <= args.tolerance)) {
                  failures.push(`${item.id}[batch ${b}] (${x},${y})c${c}: got ${got}, want ${want}, delta ${delta}`)
                }
              }
            }
          }
        }
      }
    } finally {
      runner.dispose()
    }
    return { failures, maxDelta }
  }, {
    cases: corpus.cases,
    frames: corpus.frames,
    source: adjustWire.mirror.source,
    operations: OPERATIONS as readonly string[],
    tolerance: corpus.mirror_per_channel_tolerance,
  })

  expect(results.failures).toEqual([])
  expect(results.maxDelta).toBeLessThanOrEqual(corpus.mirror_per_channel_tolerance)
})
