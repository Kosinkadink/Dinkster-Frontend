import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const checker = fileURLToPath(
  new URL('./check-canvas-literals.mjs', import.meta.url),
)
const tokens = fileURLToPath(
  new URL('../packages/canvas/src/tokens.ts', import.meta.url),
)

test('canvas check rejects paint literals and aliases while accepting tokens and coordinate math', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dinkster-canvas-literals-'))
  const source = join(directory, 'paint.ts')
  const run = () =>
    spawnSync(process.execPath, [checker, '--source', directory], {
      encoding: 'utf8',
    })
  try {
    await writeFile(join(directory, 'value.ts'), 'export const custom = 7.25')
    await writeFile(
      source,
      [
        `import { canvasPaintTokens as paint } from ${JSON.stringify(tokens)}`,
        "// ctx.lineWidth = 7; ctx.fillStyle = '#abcdef' are comments.",
        'const item = values[2]',
        'const version = 45',
        "const colorLabel = measureWidth(ctx, '#ffffff')",
        'const radius = paint.pin.optionalMinRadius',
        'const key = "line" + "Width"',
        'const make = () => paint.pin.outlineStroke',
        'const entries = [paint.pin.outlineStroke]',
        'ctx[key] = make()',
        'ctx.lineWidth = entries.at(0)',
        'ctx.lineWidth = paint.pin.outlineStroke',
        'ctx.fillStyle = theme.colors.nodeBody',
        'ctx.globalAlpha = paint.overlay.marqueeOpacity',
        'ctx.setLineDash([...paint.dash.anyPin])',
        'ctx.arc(x + radius / 2, y, radius, 0, Math.PI * 2)',
        'ctx.fillRect(x, y, width * 0.5, height)',
        'ctx.font = `${paint.type.semiboldWeight} ${theme.fontSize}px ${theme.fontFamily}`',
        'ctx.setLineDash([])',
        'ctx.globalAlpha = 1',
      ].join('\n'),
    )
    const accepted = run()
    assert.equal(accepted.status, 0, accepted.stderr)
    for (const [plant, kind] of [
      ["const paint = '#abc'", 'color'],
      ["ctx['strokeStyle'] = 'rebeccapurple'", 'color'],
      ["const badge = { color: 'rebeccapurple' }", 'color'],
      ["ctx.fillStyle = 'rgb(20 30 40 / 0.6)'", 'color'],
      ["ctx['line' + 'Width'] = 7.25", 'size'],
      ['const make = () => 7.25; ctx.lineWidth = make()', 'size'],
      ['const values = [7.25]; ctx.lineWidth = values.at(0)', 'size'],
      ['const values = [7.25]; ctx.lineWidth = values[0]', 'size'],
      ["const key = `line${'Width'}`; ctx[key] = 7.25", 'size'],
      ["const key = () => 'lineWidth'; ctx[key()] = 7.25", 'size'],
      ['function make() { return 7.25 }; ctx.lineWidth = make()', 'size'],
      ["Object.assign(ctx, { ['line' + 'Width']: 7.25 })", 'size'],
      ["const make = () => 'rebeccapurple'; ctx.fillStyle = make()", 'color'],
      ['const make = () => 0.35; ctx.globalAlpha = make()', 'opacity'],
      ['const make = () => [3, 8]; ctx.setLineDash(make())', 'dash'],
      ['ctx.lineWidth = 1', 'size'],
      ['ctx.lineWidth = 1 / 2', 'size'],
      ['ctx.arc(x, y, 7.25, 0, Math.PI * 2)', 'size'],
      [
        "import { custom as local } from './value.js'; const alias = local; ctx.lineWidth = alias",
        'size',
      ],
      ['const PIN_HIT_RADIUS = 9', 'size'],
      ['const paint = { cornerRadius: 3 }', 'size'],
      ['ctx.globalAlpha = 0', 'opacity'],
      ['ctx.globalAlpha = 1 / 2', 'opacity'],
      ['ctx.globalAlpha *= 0.35', 'opacity'],
      ['Object.assign(ctx, { lineWidth: 4 })', 'size'],
      ['ctx.setLineDash([0, 1])', 'dash'],
      ['const pattern = [3, 8]; ctx.setLineDash(pattern)', 'dash'],
      ["ctx.font = '13px sans-serif'", 'font'],
      ['ctx.font = `600 ${theme.fontSize}px sans-serif`', 'font'],
    ]) {
      await writeFile(source, plant)
      const rejected = run()
      assert.equal(rejected.status, 1, plant)
      assert.match(rejected.stderr, new RegExp(`Literal canvas ${kind}`), plant)
      assert.match(rejected.stderr, /(?:paint|value)\.ts:\d+:\d+:/u, plant)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
