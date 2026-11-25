/**
 * Minimap: the pure overview renderer. Geometry (fit transform, world
 * roundtrip, viewport mapping) is tested as math; painting is tested with
 * a recording 2D-context stand-in - the contract is WHICH shapes paint in
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
import { canvasColorsForTheme, defaultTokens, typeColor } from '../src/tokens.js'

interface PaintCall {
  readonly kind: 'fill' | 'stroke' | 'line' | 'curve' | 'clear' | 'arcFill' | 'text'
  readonly x: number
  readonly y: number
  readonly w?: number
  readonly h?: number
  readonly style: string
  readonly alpha: number
  readonly text?: string
  /** A rectangle drawn with rounded corners. */
  readonly rounded?: boolean
  readonly rule?: string
}

type Shape =
  | { readonly kind: 'rect'; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly rounded: boolean }
  | { readonly kind: 'line' | 'curve'; readonly x: number; readonly y: number; readonly x2: number; readonly y2: number }
  | { readonly kind: 'arc'; readonly x: number; readonly y: number }

/** Minimal Canvas2D stand-in recording each painted shape with the active style. */
function fakeCtx() {
  const calls: PaintCall[] = []
  let path: Shape[] = []
  let at = { x: 0, y: 0 }
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: 'butt',
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
    beginPath: () => { path = [] },
    rect: (x: number, y: number, w: number, h: number) => { path.push({ kind: 'rect', x, y, w, h, rounded: false }) },
    roundRect: (x: number, y: number, w: number, h: number) => { path.push({ kind: 'rect', x, y, w, h, rounded: true }) },
    moveTo: (x: number, y: number) => { at = { x, y } },
    lineTo: (x: number, y: number) => {
      path.push({ kind: 'line', x: at.x, y: at.y, x2: x, y2: y })
      at = { x, y }
    },
    bezierCurveTo: (_c1x: number, _c1y: number, _c2x: number, _c2y: number, x: number, y: number) => {
      path.push({ kind: 'curve', x: at.x, y: at.y, x2: x, y2: y })
      at = { x, y }
    },
    arc: (x: number, y: number) => { path.push({ kind: 'arc', x, y }) },
    stroke: () => {
      const style = String(ctx.strokeStyle)
      for (const shape of path) {
        if (shape.kind === 'rect') calls.push({ kind: 'stroke', x: shape.x, y: shape.y, w: shape.w, h: shape.h, rounded: shape.rounded, style, alpha: ctx.globalAlpha })
        else if (shape.kind !== 'arc') calls.push({ kind: shape.kind, x: shape.x, y: shape.y, w: shape.x2, h: shape.y2, style, alpha: ctx.globalAlpha })
      }
    },
    fill: (rule?: string) => {
      const style = String(ctx.fillStyle)
      for (const shape of path) {
        if (shape.kind === 'rect') calls.push({ kind: 'fill', x: shape.x, y: shape.y, w: shape.w, h: shape.h, rounded: shape.rounded, style, alpha: ctx.globalAlpha, ...(rule ? { rule } : {}) })
        else if (shape.kind === 'arc') calls.push({ kind: 'arcFill', x: shape.x, y: shape.y, style, alpha: ctx.globalAlpha })
      }
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
  const colors = defaultTokens.colors
  /** Node box fills: rectangles at full opacity after the background, excluding title lines. */
  const nodeFills = (calls: readonly PaintCall[]) =>
    calls.filter((c) => c.kind === 'fill' && c.alpha === 1 && c.style !== colors.valueMark).slice(1)
  const isViewFrame = (c: PaintCall) => c.kind === 'stroke' && c.style === colors.title && c.alpha === 0.72
  const isOutsideDim = (c: PaintCall) => c.kind === 'fill' && c.rule === 'evenodd'

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
    expect(nodeFills(calls).map((c) => c.style)).toEqual(['#5b4a92', '#276749', colors.widgetRaised])
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
    expect(nodeFills(calls).map((c) => c.style)).toEqual([colors.widgetRaised, colors.widgetRaised])
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
    expect(nodeFills(neutral.calls).map(({ x, y, w, h }) => ({ x, y, w, h })))
      .toEqual(nodeFills(colored.calls).map(({ x, y, w, h }) => ({ x, y, w, h })))
    expect(nodeFills(neutral.calls).map((c) => c.style)).toEqual(Array(3).fill(colors.widgetRaised))
  })

  it('draws nodes as rounded boxes with a thin outline and a title line', () => {
    const { ctx, calls } = fakeCtx()
    drawMinimap(ctx, { ...base, nodes: [box(0, 0, 300, 200), box(400, 0, 300, 200)] })
    expect(nodeFills(calls).every((c) => c.rounded)).toBe(true)
    expect(calls.filter((c) => c.kind === 'stroke' && c.style === colors.nodeOutline)).toHaveLength(2)
    expect(calls.filter((c) => c.kind === 'fill' && c.style === colors.valueMark)).toHaveLength(2)
  })

  it('renders bypass fill only when enabled and keeps execution-state gating independent', () => {
    const nodes = [
      { ...box(0, 0, 100, 60), color: '#5b4a92', bypassed: true, state: 'error' as const },
      { ...box(200, 0, 100, 60), state: 'running' as const },
      { ...box(400, 0, 100, 60), state: 'done' as const },
    ]
    const stateOutlines = (calls: readonly PaintCall[]) =>
      calls.filter((c) => c.kind === 'stroke' && c.style !== colors.nodeOutline).map((c) => c.style)
    const statesOff = fakeCtx()
    drawMinimap(statesOff.ctx, {
      ...base,
      nodes,
      renderBypassState: false,
      renderErrorState: false,
    })
    expect(nodeFills(statesOff.calls).map((c) => c.style))
      .toEqual(['#5b4a92', colors.widgetRaised, colors.widgetRaised])
    expect(stateOutlines(statesOff.calls))
      .toEqual([defaultTokens.stateColors.running, defaultTokens.stateColors.done])

    const bypassOn = fakeCtx()
    drawMinimap(bypassOn.ctx, { ...base, nodes, renderBypassState: true })
    expect(nodeFills(bypassOn.calls)[0]!.style).toBe('rgba(75, 24, 75, 0.9)')
    expect(stateOutlines(bypassOn.calls)).toEqual([
      defaultTokens.stateColors.error,
      defaultTokens.stateColors.running,
      defaultTokens.stateColors.done,
    ])
  })

  it('paints groups as a faint frame UNDER nodes and includes them in bounds', () => {
    const { ctx, calls } = fakeCtx()
    const tf = drawMinimap(ctx, {
      ...base,
      nodes: [box(0, 0, 100, 60)],
      groups: [{ ...box(-500, -500, 200, 200), color: '#ff0000' }],
    })!
    const groupFill = calls.findIndex((c) => c.kind === 'fill' && c.style === '#ff0000')
    expect(calls[groupFill]!.alpha).toBe(0.1)
    expect(calls.find((c) => c.kind === 'stroke' && c.style === '#ff0000')?.alpha).toBe(0.38)
    expect(groupFill).toBeLessThan(calls.indexOf(nodeFills(calls)[0]!))
    // Group at -500 must be inside the panel: bounds include groups.
    expect(calls[groupFill]!.x).toBeGreaterThanOrEqual(0)
    expect(calls[groupFill]!.y).toBeGreaterThanOrEqual(0)
    // Transform covers the union: world -500 maps within the margin.
    expect(-500 * tf.scale + tf.offsetX).toBeGreaterThanOrEqual(8 - 1e-9)
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
    expect(calls.some((c) => c.style === '#ff0000')).toBe(false)
    expect(nodeFills(calls).map((c) => c.style)).toEqual(['#00ff00'])
    expect(-500 * tf!.scale + tf!.offsetX).toBeGreaterThanOrEqual(8 - 1e-9)
    expect(1100 * tf!.scale + tf!.offsetX).toBeLessThanOrEqual(220 - 8 + 1e-9)
  })

  it('draws wires as curves in their type color after groups and before nodes', () => {
    const { ctx, calls } = fakeCtx()
    drawMinimap(ctx, {
      ...base,
      nodes: [box(0, 0, 100, 100), box(300, 0, 100, 100)],
      groups: [{ ...box(-20, -20, 440, 140), color: '#ff0000' }],
      links: [
        { from: { x: 100, y: 20 }, to: { x: 300, y: 90 }, typeName: 'INT' },
        { from: { x: 100, y: 50 }, to: { x: 300, y: 50 } },
      ],
    })
    const wires = calls.filter((c) => c.kind === 'curve')
    expect(wires.map((c) => c.style)).toEqual([typeColor(defaultTokens, 'INT'), colors.linkDefault])
    expect(calls.some((c) => c.kind === 'line')).toBe(false)
    const first = calls.indexOf(wires[0]!)
    expect(first).toBeGreaterThan(calls.findIndex((c) => c.style === '#ff0000'))
    expect(first).toBeLessThan(calls.indexOf(nodeFills(calls)[0]!))
  })

  it('Link Colors off draws every wire in one grey and drops the title lines', () => {
    const { ctx, calls } = fakeCtx()
    drawMinimap(ctx, {
      ...base,
      linkColors: false,
      nodes: [box(0, 0, 300, 200), box(400, 0, 300, 200)],
      links: [
        { from: { x: 300, y: 20 }, to: { x: 400, y: 90 }, typeName: 'INT' },
        { from: { x: 300, y: 50 }, to: { x: 400, y: 50 }, typeName: 'IMAGE' },
      ],
    })
    expect(calls.filter((c) => c.kind === 'curve').map((c) => c.style)).toEqual([colors.linkDefault, colors.linkDefault])
    expect(calls.filter((c) => c.kind === 'fill' && c.style === colors.valueMark)).toHaveLength(0)
  })

  it('keeps every node at least 2px, and draws plain blocks and straight wires when boxes are tiny', () => {
    const { ctx, calls } = fakeCtx()
    // Huge span forces a tiny scale; the 1x1 node still paints >= 2px.
    drawMinimap(ctx, {
      ...base,
      nodes: [box(0, 0, 1, 1), box(100000, 100000, 10, 10)],
      links: [{ from: { x: 1, y: 1 }, to: { x: 100000, y: 100005 } }],
    })
    const fills = nodeFills(calls)
    expect(fills[0]!.w).toBeGreaterThanOrEqual(2)
    expect(fills[0]!.h).toBeGreaterThanOrEqual(2)
    expect(fills.some((c) => c.rounded)).toBe(false)
    expect(calls.filter((c) => c.kind === 'line')).toHaveLength(1)
    expect(calls.some((c) => c.kind === 'curve')).toBe(false)
  })

  it('frames the visible world rect and dims what lies outside it', () => {
    const { ctx, calls } = fakeCtx()
    const tf = drawMinimap(ctx, {
      ...base,
      nodes: [box(0, 0, 1000, 1000)],
      viewport: { x: -100, y: -200, scale: 2, canvasWidth: 800, canvasHeight: 600 },
    })!
    const frame = calls.find(isViewFrame)!
    expect(frame).toBeDefined()
    // Visible world rect: origin (50, 100), size (400, 300).
    expect(frame.x).toBeCloseTo(50 * tf.scale + tf.offsetX)
    expect(frame.y).toBeCloseTo(100 * tf.scale + tf.offsetY)
    expect(frame.w).toBeCloseTo(400 * tf.scale)
    expect(frame.h).toBeCloseTo(300 * tf.scale)
    const dim = calls.filter(isOutsideDim)
    expect(dim.map((c) => ({ style: c.style, alpha: c.alpha }))).toEqual([
      { style: colors.canvasBackground, alpha: 0.34 },
      { style: colors.canvasBackground, alpha: 0.34 },
    ])
    // The even-odd pair: the whole panel, minus the frame.
    expect(dim[0]).toMatchObject({ x: 0, y: 0, w: 220, h: 150 })
    expect(dim[1]!.x).toBeCloseTo(frame.x)
  })

  it('keeps the local viewport visible on the light canvas', () => {
    const { ctx, calls } = fakeCtx()
    const light = canvasColorsForTheme('light')
    drawMinimap(ctx, {
      ...base,
      tokens: { ...defaultTokens, colors: light },
      nodes: [box(0, 0, 1000, 1000)],
      viewport: { x: 0, y: 0, scale: 1, canvasWidth: 800, canvasHeight: 600 },
    })
    expect(calls.find((c) => c.kind === 'stroke' && c.alpha === 0.72)?.style).toBe(light.title)
    expect(calls.find(isOutsideDim)?.style).toBe(light.canvasBackground)
  })

  it('keeps the painted viewport stroke inside the panel inset at edge zoom levels', () => {
    for (const scale of [0.42, 1.13, 2.75]) {
      const { ctx, calls } = fakeCtx()
      drawMinimap(ctx, {
        ...base,
        nodes: [box(0, 0, 2000, 1200)],
        viewport: { x: -1800 * scale, y: -1000 * scale, scale, canvasWidth: 1440, canvasHeight: 900 },
      })
      const stroke = calls.find(isViewFrame)!
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
    expect(calls.some(isOutsideDim)).toBe(false)
    expect(calls.some(isViewFrame)).toBe(false)
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
    expect(calls.some(isViewFrame)).toBe(false)
    expect(calls.some(isOutsideDim)).toBe(false)
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
    // Remote frames remain underneath the local viewport.
    const local = strokes.findIndex(isViewFrame)
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
