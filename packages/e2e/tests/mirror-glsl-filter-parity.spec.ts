import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from './fixtures.js'

/**
 * GPU parity for the applies-scoped filter mirror: every case of the
 * backend-owned image_filter_v1 corpus (gaussian_blur and sharpen, the two
 * operations inside the mirror's applies scope), rendered through the REAL
 * WebGL2 float path with the REAL shipped shader (wire-30 serialization of
 * dinkster.image.filter), must match the backend-recorded expected outputs
 * within the schema's declared per-channel tolerance. The corpus and wire
 * fixtures are the vendored copies pinned by
 * packages/core/test/mirror-glsl.test.ts.
 */

interface CorpusFrame {
  readonly shape: readonly [number, number, number, number]
  readonly values: readonly number[]
}

interface CorpusCase {
  readonly id: string
  readonly frame: string
  readonly inputs: { readonly operation: string; readonly radius: number; readonly sigma: number; readonly strength?: number }
  readonly expected: { readonly shape: readonly [number, number, number, number]; readonly values: readonly number[] }
}

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../core/test/fixtures/${name}`, import.meta.url)), 'utf8')

const corpusText = fixture('image_filter_v1.json')
const corpus = JSON.parse(corpusText) as {
  readonly node_type: string
  readonly mirror_per_channel_tolerance: number
  readonly frames: Readonly<Record<string, CorpusFrame>>
  readonly cases: readonly CorpusCase[]
}
const filterWire = JSON.parse(fixture('image_filter_wire30.json')) as {
  readonly mirror: { readonly source: string; readonly applies: Readonly<Record<string, readonly string[]>> }
}

// The shader's operation branches index the DECLARED option order, of which
// the applies scope is a prefix (pinned in mirror-glsl.test.ts).
const OPERATIONS = ['gaussian_blur', 'sharpen'] as const

test('the WebGL2 float path reproduces every filter corpus case within tolerance', async ({ page }) => {
  expect(createHash('sha256').update(corpusText).digest('hex'))
    .toBe('ee611b312fe8650a63301572c90936b1f38c9ddf3d947c47135cfb6bc08fc643')
  expect(corpus.cases).toHaveLength(13)
  expect(filterWire.mirror.applies).toEqual({ operation: [...OPERATIONS] })

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
              { name: 'radius', glslType: 'int', value: item.inputs.radius },
              { name: 'sigma', glslType: 'float', value: item.inputs.sigma },
              // The blur branch never reads strength; bind it only when the
              // case declares it, exactly as binding derivation would.
              ...(item.inputs.strength !== undefined
                ? [{ name: 'strength', glslType: 'float' as const, value: item.inputs.strength }]
                : []),
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
    source: filterWire.mirror.source,
    operations: OPERATIONS as readonly string[],
    tolerance: corpus.mirror_per_channel_tolerance,
  })

  expect(results.failures).toEqual([])
  expect(results.maxDelta).toBeLessThanOrEqual(corpus.mirror_per_channel_tolerance)
})
