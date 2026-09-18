/**
 * Minimap: the pure overview renderer. Geometry (fit transform, world
 * roundtrip, viewport mapping) is tested as math; painting is tested with
 * a recording 2D-context stand-in - the contract is WHICH boxes paint in
 * WHICH colors (error red above all), not pixel output.
 */
import { describe, expect, it } from 'vitest'
import {
  drawMinimap,
  minimapToWorld,
  minimapTransform,
  minimapViewportRect,
  minimapWheelViewport,
  type MinimapBox,
  type MinimapInput,
} from '../src/minimap.js'
import { defaultTokens } from '../src/tokens.js'

interface PaintCall {
  readonly kind: 'fill' | 'stroke' | 'line' | 'clear' | 'arcFill' | 'text'
  readonly x: number
  readonly y: number
  readonly w?: number
  readonly h?: number
  readonly style: string
  readonly alpha: number
  readonly text?: string
}

/** Minimal Canvas2D stand-in recording paint calls with the active style. */
function fakeCtx() {
  const calls: PaintCall[] = []
  let pendingArc: { x: number; y: number } | undefined
  let pendingLine: { x: number; y: number; x2?: number; y2?: number } | undefined
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    clearRect: (x: number, y: number, w: number, h: number) => {
      calls.push({ kind: 'clear', x, y, w, h, style: '', alpha: ctx.globalAlpha })
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      calls.push({ kind: 'fill', x, y, w, h, style: String(ctx.fillStyle), alpha: ctx.globalAlpha })
    },
    strokeRect: (x: number, y: number, w: number, h: number) => {
      calls.push({ kind: 'stroke', x, y, w, h, style: String(ctx.strokeStyle), alpha: ctx.globalAlpha })
    },
    beginPath: () => {
      pendingArc = undefined
      pendingLine = undefined
    },
    moveTo: (x: number, y: number) => {
      pendingLine = { x, y }
    },
    lineTo: (x: number, y: number) => {
      if (pendingLine) pendingLine = { ...pendingLine, x2: x, y2: y }
    },
    stroke: () => {
      if (pendingLine) {
        calls.push({
          kind: 'line',
          x: pendingLine.x,
          y: pendingLine.y,
          w: pendingLine.x2!,
          h: pendingLine.y2!,
          style: String(ctx.strokeStyle),
          alpha: ctx.globalAlpha,
        })
      }
    },
    arc: (x: number, y: number) => {
      pendingArc = { x, y }
    },
    fill: () => {
      if (pendingArc) calls.push({ kind: 'arcFill', ...pendingArc, style: String(ctx.fillStyle), alpha: ctx.globalAlpha })
    },
    fillText: (text: string, x: number, y: number) => {
      calls.push({ kind: 'text', x, y, text, style: String(ctx.fillStyle), alpha: ctx.globalAlpha })
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

const box = (x: number, y: number, width: number, height: number): MinimapBox => ({ x, y, width, height })

describe('minimapTransform', () => {
  it('returns undefined for an empty scene', () => {
    expect(minimapTransform([], 220, 150)).toBeUndefined()
  })

  it('FR7 a panel no larger than its margins yields no transform', () => {
    expect(minimapTransform([box(0, 0, 10, 10)], 16, 100, 8)).toBeUndefined()
    expect(minimapTransform([box(0, 0, 10, 10)], 15, 100, 8)).toBeUndefined()
  })

  it('fits all boxes inside the panel with margin, aspect preserved', () => {
    const boxes = [box(0, 0, 100, 50), box(900, 400, 100, 100)]
    const t = minimapTransform(boxes, 220, 150, 8)
    expect(t).toBeDefined()
    // World bounds are 1000x500; both dimensions must land inside the margin.
    for (const b of boxes) {
      const x0 = b.x * t!.scale + t!.offsetX
      const y0 = b.y * t!.scale + t!.offsetY
      const x1 = (b.x + b.width) * t!.scale + t!.offsetX
      const y1 = (b.y + b.height) * t!.scale + t!.offsetY
      expect(x0).toBeGreaterThanOrEqual(8 - 1e-9)
      expect(y0).toBeGreaterThanOrEqual(8 - 1e-9)
      expect(x1).toBeLessThanOrEqual(220 - 8 + 1e-9)
      expect(y1).toBeLessThanOrEqual(150 - 8 + 1e-9)
    }
  })

  it('never zooms IN past 1:4 for tiny graphs', () => {
    const t = minimapTransform([box(0, 0, 10, 10)], 220, 150)
    expect(t!.scale).toBe(0.25)
  })

  it('centers the world bounds in the panel', () => {
    const t = minimapTransform([box(0, 0, 100, 100)], 220, 150)!
    const cx = 50 * t.scale + t.offsetX
    const cy = 50 * t.scale + t.offsetY
    expect(cx).toBeCloseTo(110)
    expect(cy).toBeCloseTo(75)
  })

  it('roundtrips minimap point -> world -> minimap', () => {
    const t = minimapTransform([box(-50, 200, 400, 300)], 220, 150)!
    const w = minimapToWorld(t, 42, 99)
    expect(w.x * t.scale + t.offsetX).toBeCloseTo(42)
    expect(w.y * t.scale + t.offsetY).toBeCloseTo(99)
  })

  it('maps the visible world viewport into minimap coordinates', () => {
    const t = minimapTransform([box(0, 0, 1000, 1000)], 220, 150)!
    const rect = minimapViewportRect(t, { x: -100, y: -200, scale: 2, canvasWidth: 800, canvasHeight: 600 })
    expect(rect.x).toBeCloseTo(50 * t.scale + t.offsetX)
    expect(rect.y).toBeCloseTo(100 * t.scale + t.offsetY)
    expect(rect.width).toBeCloseTo(400 * t.scale)
  })

  it('insets an edge-overlapping viewport inside the minimap panel at fractional zoom', () => {
    const t = { scale: 0.1, offsetX: 100, offsetY: 75 }
    const rect = minimapViewportRect(
      t,
      { x: -1000, y: -700, scale: 1.13, canvasWidth: 1440, canvasHeight: 900 },
      220,
      150,
    )
    expect(rect.x).toBeCloseTo(188.495575)
    expect(rect.y).toBeCloseTo(136.946903)
    expect(rect.x + rect.width).toBe(218)
    expect(rect.y + rect.height).toBe(148)
  })

  it('collapses a viewport wholly beyond an edge without escaping the inset panel', () => {
    const rect = minimapViewportRect(
      { scale: 0.1, offsetX: 100, offsetY: 75 },
      { x: -3000, y: 3000, scale: 0.42, canvasWidth: 1440, canvasHeight: 900 },
      220,
      150,
    )
    expect(rect).toEqual({ x: 218, y: 2, width: 0, height: 0 })
  })

  it('centers the pointed world location and applies the shared wheel zoom step', () => {
    const t = minimapTransform([box(0, 0, 2000, 1000)], 220, 150)!
    const world = { x: 1750, y: 700 }
    const mx = world.x * t.scale + t.offsetX
    const my = world.y * t.scale + t.offsetY
    const next = minimapWheelViewport(t, mx, my, { x: 20, y: -30, scale: 1 }, 800, 600, -100)

    expect(next.scale).toBeCloseTo(Math.exp(0.12))
    expect((400 - next.x) / next.scale).toBeCloseTo(world.x)
    expect((300 - next.y) / next.scale).toBeCloseTo(world.y)
    expect(minimapWheelViewport(t, mx, my, next, 800, 600, -100).scale).toBeCloseTo(Math.exp(0.24))
  })
})

describe('drawMinimap', () => {
  const base: Omit<MinimapInput, 'nodes'> = { width: 220, height: 150, tokens: defaultTokens }

  it('clears and paints only the background for an empty scene, returning undefined', () => {
    const { ctx, calls } = fakeCtx()
    const tf = drawMinimap(ctx, { ...base, nodes: [] })
    expect(tf).toBeUndefined()
    expect(calls.map((c) => c.kind)).toEqual(['clear', 'fill'])
    expect(calls[1]!.style).toBe(defaultTokens.colors.canvasBackground)
  })

  it('paints distinct node identity colors with a theme-safe fallback', () => {
    const { ctx, calls } = fakeCtx()
    drawMinimap(ctx, {
      ...base,
      nodes: [
        { ...box(0, 0, 100, 60), color: '#5b4a92' },
        { ...box(200, 0, 100, 60), color: '#276749' },
        { ...box(400, 0, 100, 60) },
      ],
    })
    const fills = calls.filter((c) => c.kind === 'fill').slice(1) // drop background
    expect(fills.map((c) => c.style)).toEqual(['#5b4a92', '#276749', defaultTokens.colors.widgetAffordance])
  })

  it('takes the neutral fallback from the active design tokens', () => {
    const { ctx, calls } = fakeCtx()
    drawMinimap(ctx, {
      ...base,
      tokens: {
        ...defaultTokens,
        colors: { ...defaultTokens.colors, widgetAffordance: '#d8d4cc' },
      },
      nodes: [box(0, 0, 100, 60)],
    })
    expect(calls.filter((c) => c.kind === 'fill')[1]!.style).toBe('#d8d4cc')
  })

  it('uses the visible neutral token for dense nodes without identity colors', () => {
    const { ctx, calls } = fakeCtx()
    drawMinimap(ctx, {
      ...base,
      nodes: [box(0, 0, 100, 60), box(200, 0, 100, 60)],
    })
    expect(calls.filter((c) => c.kind === 'fill').slice(1).map((c) => c.style))
      .toEqual([defaultTokens.colors.widgetAffordance, defaultTokens.colors.widgetAffordance])
    const channel = 0x68 / 255
    const nodeLuminance = ((channel + 0.055) / 1.055) ** 2.4
    const backgroundChannel = 0x18 / 255
    const backgroundLuminance = ((backgroundChannel + 0.055) / 1.055) ** 2.4
    expect((nodeLuminance + 0.05) / (backgroundLuminance + 0.05)).toBeGreaterThanOrEqual(3)
  })

  it('falls back for transparent or malformed persisted colors so nodes stay visible', () => {
    const { ctx, calls } = fakeCtx()
    drawMinimap(ctx, {
      ...base,
      nodes: [
        { ...box(0, 0, 100, 60), color: 'transparent' },
        { ...box(200, 0, 100, 60), color: 'not-a-color' },
      ],
    })
    expect(calls.filter((c) => c.kind === 'fill').slice(1).map((c) => c.style))
      .toEqual([defaultTokens.colors.widgetAffordance, defaultTokens.colors.widgetAffordance])
  })

  it('node colors off preserves every node geometry with one neutral fill', () => {
    const nodes = [
      { ...box(0, 0, 100, 60), color: '#5b4a92' },
      { ...box(200, 0, 120, 80), color: '#276749' },
      { ...box(400, 0, 140, 100) },
    ]
    const colored = fakeCtx()
    drawMinimap(colored.ctx, { ...base, nodes })
    const neutral = fakeCtx()
    drawMinimap(neutral.ctx, { ...base, nodes, nodeColors: false })
    const nodeFills = (calls: readonly PaintCall[]) => calls.filter((c) => c.kind === 'fill').slice(1)
    expect(nodeFills(neutral.calls).map(({ x, y, w, h }) => ({ x, y, w, h })))
      .toEqual(nodeFills(colored.calls).map(({ x, y, w, h }) => ({ x, y, w, h })))
    expect(nodeFills(neutral.calls).map((c) => c.style))
      .toEqual(Array(3).fill(defaultTokens.colors.widgetAffordance))
  })

  it('renders bypass fill only when enabled and keeps execution-state gating independent', () => {
    const nodes = [
      { ...box(0, 0, 100, 60), color: '#5b4a92', bypassed: true, state: 'error' as const },
      { ...box(200, 0, 100, 60), state: 'running' as const },
      { ...box(400, 0, 100, 60), state: 'done' as const },
    ]
    const statesOff = fakeCtx()
    drawMinimap(statesOff.ctx, {
      ...base,
      nodes,
      renderBypassState: false,
      renderErrorState: false,
    })
    expect(statesOff.calls.filter((c) => c.kind === 'fill').slice(1).map((c) => c.style))
      .toEqual(['#5b4a92', defaultTokens.colors.widgetAffordance, defaultTokens.colors.widgetAffordance])
    expect(statesOff.calls.filter((c) => c.kind === 'stroke').map((c) => c.style))
      .toEqual([defaultTokens.stateColors.running, defaultTokens.stateColors.done])

    const bypassOn = fakeCtx()
    drawMinimap(bypassOn.ctx, { ...base, nodes, renderBypassState: true })
    expect(bypassOn.calls.filter((c) => c.kind === 'fill')[1]!.style).toBe('rgba(75, 24, 75, 0.9)')
    expect(bypassOn.calls.filter((c) => c.kind === 'stroke').map((c) => c.style))
      .toEqual([
        defaultTokens.stateColors.error,
        defaultTokens.stateColors.running,
        defaultTokens.stateColors.done,
      ])
  })

  it('paints groups as solid fills UNDER nodes and includes them in bounds', () => {
    const { ctx, calls } = fakeCtx()
    const tf = drawMinimap(ctx, {
      ...base,
      nodes: [box(0, 0, 100, 60)],
      groups: [{ ...box(-500, -500, 200, 200), color: '#ff0000' }],
    })!
    const fills = calls.filter((c) => c.kind === 'fill').slice(1)
    expect(fills[0]!.style).toBe('#ff0000')
    expect(fills[0]!.alpha).toBe(1)
    expect(fills[1]!.alpha).toBe(1)
    // Group at -500 must be inside the panel: bounds include groups.
    expect(fills[0]!.x).toBeGreaterThanOrEqual(0)
    expect(fills[0]!.y).toBeGreaterThanOrEqual(0)
    // Transform covers the union: world -500 maps within the margin.
    expect(-500 * tf.scale + tf.offsetX).toBeGreaterThanOrEqual(8 - 1e-9)
  })

  it('keeps the fitted union identical when node colors or group painting are disabled', () => {
    const input = {
      ...base,
      nodes: [box(1200, 800, 300, 200)],
      groups: [box(-600, -400, 200, 100)],
    }
    const visible = drawMinimap(fakeCtx().ctx, input)
    const colorsOff = drawMinimap(fakeCtx().ctx, { ...input, nodeColors: false })
    const groupsHidden = drawMinimap(fakeCtx().ctx, { ...input, visibility: { groups: false } })
    expect(colorsOff).toEqual(visible)
    expect(groupsHidden).toEqual(visible)
  })

  it('group visibility suppresses group paint without removing bounds', () => {
    const { ctx, calls } = fakeCtx()
    const tf = drawMinimap(ctx, {
      ...base,
      nodes: [{ ...box(1000, 800, 100, 60), color: '#00ff00' }],
      groups: [{ ...box(-500, -400, 200, 100), color: '#ff0000' }],
      visibility: { groups: false },
    })
    expect(tf).toBeDefined()
    expect(calls.filter((c) => c.kind === 'fill')).toHaveLength(2)
    expect(calls.filter((c) => c.kind === 'fill')[1]!.style).toBe('#00ff00')
    expect(-500 * tf!.scale + tf!.offsetX).toBeGreaterThanOrEqual(8 - 1e-9)
    expect(1100 * tf!.scale + tf!.offsetX).toBeLessThanOrEqual(220 - 8 + 1e-9)
  })

  it('draws straight neutral links and endpoint dots after groups and before nodes', () => {
    const { ctx, calls } = fakeCtx()
    drawMinimap(ctx, {
      ...base,
      nodes: [box(0, 0, 100, 100)],
      groups: [{ ...box(-20, -20, 140, 140), color: '#ff0000' }],
      links: [{ from: { x: 10, y: 20 }, to: { x: 80, y: 90 } }],
    })
    const lineIndex = calls.findIndex((c) => c.kind === 'line')
    expect(lineIndex).toBeGreaterThan(calls.findIndex((c) => c.kind === 'fill' && c.style === '#ff0000'))
    expect(lineIndex).toBeLessThan(calls.findIndex((c) => c.kind === 'fill' && c.style === defaultTokens.colors.widgetAffordance))
    expect(calls[lineIndex]!.style).toBe(defaultTokens.colors.linkDefault)
    expect(calls.filter((c) => c.kind === 'arcFill' && c.style === defaultTokens.colors.linkDefault)).toHaveLength(2)
  })

  it('keeps every node at least 2px so nothing vanishes at overview scale', () => {
    const { ctx, calls } = fakeCtx()
    // Huge span forces a tiny scale; the 1x1 node still paints >= 2px.
    drawMinimap(ctx, { ...base, nodes: [box(0, 0, 1, 1), box(100000, 100000, 10, 10)] })
    const fills = calls.filter((c) => c.kind === 'fill').slice(1)
    expect(fills[0]!.w).toBeGreaterThanOrEqual(2)
    expect(fills[0]!.h).toBeGreaterThanOrEqual(2)
  })

  it('fills and strokes the square near-white viewport at the visible world rect', () => {
    const { ctx, calls } = fakeCtx()
    const tf = drawMinimap(ctx, {
      ...base,
      nodes: [box(0, 0, 1000, 1000)],
      viewport: { x: -100, y: -200, scale: 2, canvasWidth: 800, canvasHeight: 600 },
    })!
    const stroke = calls.find((c) => c.kind === 'stroke')!
    expect(stroke.style).toBe('rgba(255, 255, 255, 0.9)')
    const viewportFill = calls.find((c) => c.kind === 'fill' && c.style === 'rgba(255, 255, 255, 0.2)')!
    expect(viewportFill).toBeDefined()
    // Visible world rect: origin (50, 100), size (400, 300).
    expect(stroke.x).toBeCloseTo(50 * tf.scale + tf.offsetX)
    expect(stroke.y).toBeCloseTo(100 * tf.scale + tf.offsetY)
    expect(stroke.w).toBeCloseTo(400 * tf.scale)
    expect(stroke.h).toBeCloseTo(300 * tf.scale)
  })

  it('keeps the painted viewport stroke inside the panel inset at edge zoom levels', () => {
    for (const scale of [0.42, 1.13, 2.75]) {
      const { ctx, calls } = fakeCtx()
      drawMinimap(ctx, {
        ...base,
        nodes: [box(0, 0, 2000, 1200)],
        viewport: { x: -1800 * scale, y: -1000 * scale, scale, canvasWidth: 1440, canvasHeight: 900 },
      })
      const stroke = calls.find((c) => c.kind === 'stroke' && c.style === 'rgba(255, 255, 255, 0.9)')!
      expect(stroke.x).toBeGreaterThanOrEqual(2)
      expect(stroke.y).toBeGreaterThanOrEqual(2)
      expect(stroke.x + stroke.w!).toBeLessThanOrEqual(218)
      expect(stroke.y + stroke.h!).toBeLessThanOrEqual(148)
    }
  })

  it('does not paint a collapsed viewport that is wholly outside one panel edge', () => {
    const { ctx, calls } = fakeCtx()
    drawMinimap(ctx, {
      ...base,
      nodes: [box(0, 0, 2000, 1200)],
      viewport: { x: -4000, y: -200, scale: 1, canvasWidth: 800, canvasHeight: 600 },
    })
    expect(calls.some((c) => c.kind === 'fill' && c.style === 'rgba(255, 255, 255, 0.2)')).toBe(false)
    expect(calls.some((c) => c.kind === 'stroke' && c.style === 'rgba(255, 255, 255, 0.9)')).toBe(false)
  })

  it('draws labeled markers on top, clamped into the panel', () => {
    const { ctx, calls } = fakeCtx()
    drawMinimap(ctx, {
      ...base,
      nodes: [box(0, 0, 100, 100)],
      markers: [
        { x: 50, y: 50, label: '1' }, // inside content: near the panel center
        { x: 100000, y: -100000, label: '2' }, // far off-content: clamped to an edge
      ],
    })
    const texts = calls.filter((c) => c.kind === 'text')
    expect(texts.map((c) => c.text)).toEqual(['1', '2'])
    expect(texts[0]!.x).toBeCloseTo(110)
    expect(texts[0]!.y).toBeCloseTo(75)
    // Clamped: inside the panel, at the top-right corner region.
    expect(texts[1]!.x).toBeLessThanOrEqual(220 - 8)
    expect(texts[1]!.y).toBeGreaterThanOrEqual(8)
    // Marker chips fill in the selection color.
    const arcs = calls.filter((c) => c.kind === 'arcFill')
    expect(arcs).toHaveLength(2)
    expect(arcs[0]!.style).toBe(defaultTokens.colors.selection)
  })

  it('omits the viewport rectangle when no viewport is passed (thumbnail mode)', () => {
    const { ctx, calls } = fakeCtx()
    drawMinimap(ctx, { ...base, nodes: [box(0, 0, 100, 100)] })
    expect(calls.some((c) => c.kind === 'stroke')).toBe(false)
  })

  it('strokes remote viewports in their actor colors, under the local rectangle', () => {
    const { ctx, calls } = fakeCtx()
    const tf = drawMinimap(ctx, {
      ...base,
      nodes: [box(0, 0, 1000, 1000)],
      viewport: { x: 0, y: 0, scale: 1, canvasWidth: 800, canvasHeight: 600 },
      remoteViewports: [{ x: 100, y: 200, w: 400, h: 300, color: 'hsl(120 70% 55%)' }],
    })!
    const strokes = calls.filter((c) => c.kind === 'stroke')
    const remote = strokes.find((c) => c.style === 'hsl(120 70% 55%)')!
    expect(remote).toBeDefined()
    expect(remote.x).toBeCloseTo(100 * tf.scale + tf.offsetX)
    expect(remote.y).toBeCloseTo(200 * tf.scale + tf.offsetY)
    expect(remote.w).toBeCloseTo(400 * tf.scale)
    expect(remote.h).toBeCloseTo(300 * tf.scale)
    // Painted BEFORE the local near-white rectangle so "where am I" wins.
    const local = strokes.findIndex((c) => c.style === 'rgba(255, 255, 255, 0.9)')
    expect(strokes.indexOf(remote)).toBeLessThan(local)
  })

  it('remote viewports do not join the fit bounds (a far-off peer cannot zoom the overview out)', () => {
    const { ctx } = fakeCtx()
    const withRemote = drawMinimap(ctx, {
      ...base,
      nodes: [box(0, 0, 100, 100)],
      remoteViewports: [{ x: 100000, y: 100000, w: 800, h: 600, color: 'red' }],
    })!
    const { ctx: ctx2 } = fakeCtx()
    const without = drawMinimap(ctx2, { ...base, nodes: [box(0, 0, 100, 100)] })!
    expect(withRemote.scale).toBe(without.scale)
  })
})
