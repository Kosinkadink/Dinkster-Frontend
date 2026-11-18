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
        'const ellipsize = value => value; ellipsize(20)',
        'const choose = (data, value) => value; ctx.lineWidth = choose(7.25, paint.pin.outlineStroke)',
        "const colorLabel = measureWidth(ctx, '#ffffff')",
        'const radius = paint.pin.optionalMinRadius',
        'const key = "line" + "Width"',
        'const make = () => paint.pin.outlineStroke',
        'const entries = [paint.pin.outlineStroke]',
        'ctx[key] = make()',
        'ctx.lineWidth = entries.at(0)',
        'const table = new Map([["key", paint.pin.outlineStroke]]); table.set("other", paint.pin.outlineStroke); ctx.lineWidth = table.get("key")',
        'const measurements = new Map(); measurements.set(20, paint.pin.outlineStroke); ctx.lineWidth = measurements.get(20)',
        'let assigned; assigned = paint.pin.outlineStroke; ctx.lineWidth = assigned',
        'const applyPaint = (data, stroke) => { ctx.lineWidth = stroke }; applyPaint(7.25, paint.pin.outlineStroke)',
        'const outer = (stroke) => { const inner = (stroke) => { ctx.lineWidth = stroke }; inner(paint.pin.outlineStroke) }; outer(7.25)',
        'const [, arrayToken] = [7.25, paint.pin.outlineStroke]',
        'const { value: objectToken } = { unrelated: 7.25, value: paint.pin.outlineStroke }',
        'const { pin: { outlineStroke } } = paint',
        'const [defaultToken = paint.pin.outlineStroke] = []',
        'ctx.lineWidth = arrayToken',
        'ctx.lineWidth = objectToken',
        'ctx.lineWidth = outlineStroke',
        'ctx.lineWidth = defaultToken',
        'const [, ...tokenDashes] = [7.25, ...paint.dash.anyPin]',
        'ctx.setLineDash(tokenDashes)',
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
      ['let pinStroke; pinStroke = 7.25; ctx.lineWidth = pinStroke', 'size'],
      [
        'const paint = (pinStroke) => { ctx.lineWidth = pinStroke }; paint(7.25)',
        'size',
      ],
      ["let value; value = 'red'; ctx.fillStyle = value", 'color'],
      [
        'function apply(value) { ctx.globalAlpha = value }; apply(0.35)',
        'opacity',
      ],
      [
        'const apply = (...values) => ctx.setLineDash(values); apply(3, 8)',
        'dash',
      ],
      [
        'const apply = ({ value }) => { ctx.lineWidth = value }; apply({ value: 7.25 })',
        'size',
      ],
      [
        'const apply = value => { ctx.lineWidth = value }; const alias = apply; alias(7.25)',
        'size',
      ],
      [
        'const apply = value => { ctx.lineWidth = value }; const forward = value => apply(value); forward(7.25)',
        'size',
      ],
      ['let key; key = "lineWidth"; ctx[key] = 7.25', 'size'],
      [
        'const table = new Map(); table.set("stroke", 7.25); ctx.lineWidth = table.get("stroke")',
        'size',
      ],
      [
        'const table = new Map([["stroke", 7.25]]); ctx.lineWidth = table.get("stroke")',
        'size',
      ],
      ['const [literal] = [7.25]; ctx.lineWidth = literal', 'size'],
      [
        'const { value: literal } = { get value() { return 7.25 } }; ctx.lineWidth = literal',
        'size',
      ],
      [
        'const value = 7.25; const { value: literal } = { value }; ctx.lineWidth = literal',
        'size',
      ],
      [
        'const make = () => [7.25]; const [literal] = make(); ctx.lineWidth = literal',
        'size',
      ],
      [
        'const [literal] = flag ? [7.25] : [0]; ctx.lineWidth = literal',
        'size',
      ],
      ['const [...literal] = [...[3, 8]]; ctx.setLineDash(literal)', 'dash'],
      [
        "const { value: literal } = { value: 'red' }; ctx.fillStyle = literal",
        'color',
      ],
      ['const [[literal]] = [[0.35]]; ctx.globalAlpha = literal', 'opacity'],
      ['const [literal] = [[3, 8]]; ctx.setLineDash(literal)', 'dash'],
      ['const [literal = 7.25] = []; ctx.lineWidth = literal', 'size'],
      ['const [, ...literal] = [0, 3, 8]; ctx.setLineDash(literal)', 'dash'],
      [
        'const data = [0, 7.25]; const [, literal] = data; ctx.lineWidth = literal',
        'size',
      ],
      [
        'const { nested: { value: literal } } = { nested: { value: 7.25 } }; ctx.lineWidth = literal',
        'size',
      ],
      [
        'const data = { value: 7.25 }; const { value: literal } = data; ctx.lineWidth = literal',
        'size',
      ],
      ["const [key] = ['lineWidth']; ctx[key] = 7.25", 'size'],
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
