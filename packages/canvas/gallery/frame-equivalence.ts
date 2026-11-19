import { registerCatalog } from '@dinkster/core'
import english from '../../app/src/locales/en.json'
import {
  CanvasRenderer,
  canvasColorsForTheme,
  canvasTypePaintForTheme,
  canvasPaintTokens,
  createRegistryPainter,
  defaultTokens,
  type OverlayState,
  type TextMeasurer,
  type WidgetMeasure,
} from '../src/index.js'
import {
  createWidgetRegistry,
  registerCoreWidgets,
  widgetRegistrationDoors,
} from '../../widgets/src/index.js'
import {
  createCanvasGalleryFixture,
  galleryWidgetInputs,
  type CanvasGalleryPage,
} from './fixtures.js'

/** Whole-frame comparisons use raw channels, without screenshot tolerances. */
function differingPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length) throw new Error('Frame dimensions differ')
  const left = new Uint32Array(a.buffer, a.byteOffset, a.byteLength / 4)
  const right = new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4)
  let count = 0
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) count++
  }
  return count
}

export async function compareCanvasFrames(
  page: CanvasGalleryPage,
  theme: 'dark' | 'light',
  widgetId = 'float',
) {
  await Promise.all([
    document.fonts.load('400 13px "Noto Sans"'),
    document.fonts.load('600 13px "Noto Sans"'),
    document.fonts.load('italic 600 13px "Noto Sans"'),
    document.fonts.load('400 13px "Noto Sans Mono"'),
  ])
  registerCatalog('en', english)
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  const tokens = {
    ...defaultTokens,
    ...canvasTypePaintForTheme(theme),
    colors: canvasColorsForTheme(theme),
    widgetRowLook:
      page === 'core-rows'
        ? ('inset-raised' as const)
        : defaultTokens.widgetRowLook,
    badgeLayout:
      page === 'tabs' ||
      page === 'tabs-content' ||
      page === 'run-editable' ||
      page === 'run-frozen'
        ? ('tabs' as const)
        : defaultTokens.badgeLayout,
  }
  const measurement = document.createElement('canvas').getContext('2d')!
  const measure: TextMeasurer = (text, role) => {
    const title = role === 'title' || role === 'renamedTitle'
    measurement.font = `${role === 'renamedTitle' ? 'italic ' : ''}${title ? `${canvasPaintTokens.type.semiboldWeight} ` : ''}${title ? tokens.titleFontSize : tokens.fontSize}px ${tokens.fontFamily}`
    return measurement.measureText(text).width
  }
  const widgetMeasure: WidgetMeasure = (spec) => {
    const kind = registry.kind(spec.widgetType)
    const view = registry
      .viewsFor(spec.widgetType)
      .find((view) => view.id === kind?.defaultView(spec))
    return view ? { viewId: view.id, rows: view.measure(spec).rows } : undefined
  }
  const fixture = createCanvasGalleryFixture(
    page,
    tokens,
    measure,
    widgetMeasure,
    galleryWidgetInputs.find((input) => input.id === widgetId)!,
  )
  if (page === 'previews') {
    const image = document.createElement('canvas')
    image.width = 320
    image.height = 160
    const context = image.getContext('2d')!
    context.fillStyle = tokens.colors.selection
    context.beginPath()
    context.arc(210, 65, 42, 0, Math.PI * 2)
    context.fill()
    fixture.previews = {
      ...fixture.previews,
      Image: { image, width: 320, height: 160 },
      Cached: { image, width: 320, height: 160, state: 'cached' },
      Estimate: { image, width: 320, height: 160, state: 'estimate' },
    }
  }
  const node = page === 'structure'
    ? fixture.scene.nodes.find((candidate) => !fixture.scene.netStubs.some((stub) => stub.nodeId === candidate.id))
    : fixture.scene.nodes[0]
  if (!node) throw new Error('Frame comparison requires a node fixture')
  let scene = fixture.scene
  if (page === 'structure') {
    // Overlapping remote dots expose batching changes outside the edited node's tiles.
    scene = {
      ...scene,
      reroutes: [
        ...scene.reroutes,
        ...Array.from({ length: 256 }, (_, index) => ({
          id: `dense-reroute-${index}`,
          x: 1200 + index % 8 * 2,
          y: 600 + Math.floor(index / 8) * 2,
        })),
      ],
    }
  }
  let states = fixture.states
  let overlay: OverlayState = fixture.overlay
  let colors = tokens.colors
  let typePaint = canvasTypePaintForTheme(theme)
  let viewport = { x: 0, y: 0, scale: fixture.scale }
  let width = fixture.width
  let height = fixture.height
  const host = document.createElement('div')
  // Keep measurable CSS dimensions without replacing the visible gallery.
  host.style.position = 'fixed'
  host.style.left = '-20000px'
  document.body.append(host)
  const createRenderer = () => {
    const canvas = document.createElement('canvas')
    // Match the readback policy of retained and fresh canvases throughout history.
    canvas.getContext('2d', { willReadFrequently: false })
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    host.append(canvas)
    const renderer = new CanvasRenderer(
      canvas,
      { ...tokens, ...typePaint, colors },
      createRegistryPainter(registry),
    )
    renderer.setReducedMotion(true)
    renderer.setGridVisible(false)
    renderer.setScene(scene)
    renderer.setNodeStates(states)
    renderer.setBadges(fixture.badges)
    renderer.setOverlay(overlay)
    renderer.setRowMarks(fixture.rowMarks)
    renderer.setCompanions(fixture.companions)
    renderer.setToolbox(fixture.toolbox)
    renderer.setNodePreviews(fixture.previews)
    renderer.setViewport(viewport)
    return { canvas, renderer }
  }
  const pixels = (canvas: HTMLCanvasElement) =>
    canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
      .data
  let tilePaints = 0
  const transfer = OffscreenCanvas.prototype.transferToImageBitmap
  OffscreenCanvas.prototype.transferToImageBitmap = function () {
    tilePaints++
    return transfer.call(this)
  }
  const candidate = createRenderer()
  const frames: {
    state: string
    differences: number
    directDifferences: number
    pixels: number
    candidateTiles: number
    referenceTiles: number
  }[] = []
  let initial: Uint8ClampedArray | undefined
  let lastExpected: Uint8ClampedArray | undefined
  let lastComparable: Uint8ClampedArray | undefined
  const compare = (state: string) => {
    // A new reference renderer cannot reuse pixels or state from a prior frame.
    const full = createRenderer()
    const direct = createRenderer()
    try {
      const before = tilePaints
      candidate.renderer.renderNow()
      const candidateTiles = tilePaints - before
      full.renderer.renderNow()
      const referenceTiles = tilePaints - before - candidateTiles
      // Repaint the complete scene without retained images or candidate bins.
      const bitmapTransfer = Object.getOwnPropertyDescriptor(
        OffscreenCanvas.prototype,
        'transferToImageBitmap',
      )!
      Object.defineProperty(
        OffscreenCanvas.prototype,
        'transferToImageBitmap',
        {
          ...bitmapTransfer,
          value: undefined,
        },
      )
      try {
        direct.renderer.renderNow()
      } finally {
        Object.defineProperty(
          OffscreenCanvas.prototype,
          'transferToImageBitmap',
          bitmapTransfer,
        )
      }
      const actual = pixels(candidate.canvas)
      const expected = pixels(full.canvas)
      frames.push({
        state,
        differences: differingPixels(actual, expected),
        directDifferences: differingPixels(actual, pixels(direct.canvas)),
        pixels: expected.length / 4,
        candidateTiles,
        referenceTiles,
      })
      initial ??= expected.slice()
      if (initial.length === expected.length) lastComparable = expected
      lastExpected = expected
    } finally {
      full.renderer.dispose()
      full.canvas.remove()
      direct.renderer.dispose()
      direct.canvas.remove()
    }
  }
  const move = (
    state: string,
    x: number,
    y: number,
    scale = viewport.scale,
  ) => {
    viewport = { x, y, scale }
    candidate.renderer.setViewport(viewport)
    compare(state)
  }
  try {
    compare('initial')
    move('integer pan', 8, -4)
    move('fractional pan', 8.25, -4.5)
    move('same-phase pan', 16.25, 3.5)
    move('exposed edges', -129.75, 91.5)
    move('return pan', 8.25, -4.5)
    move('zoom in', 8.25, -4.5, fixture.scale * 1.05)
    move('overview detail', -3.5, 5.25, 0.49)
    overlay = {
      ...overlay,
      dragOffsets: new Map([[node.id, { dx: 23.25, dy: -13.5 }]]),
    }
    candidate.renderer.setOverlay(overlay)
    compare('overview drag')
    overlay = fixture.overlay
    candidate.renderer.setOverlay(overlay)
    compare('overview release')
    move('content detail', -3.5, 5.25, 0.5)
    move('settled zoom', 0, 0, 1)
    overlay = { ...overlay, selection: new Set([node.id]) }
    candidate.renderer.setOverlay(overlay)
    compare('selection')
    overlay = {
      ...overlay,
      dragOffsets: new Map([[node.id, { dx: 23.25, dy: -13.5 }]]),
    }
    candidate.renderer.setOverlay(overlay)
    compare('drag')
    for (const [state, dx, dy] of [
      ['drag across tiles', 703.25, 19.5],
      ['reverse drag', -37.25, 41.5],
    ] as const) {
      overlay = { ...overlay, dragOffsets: new Map([[node.id, { dx, dy }]]) }
      candidate.renderer.setOverlay(overlay)
      compare(state)
    }
    overlay = { ...fixture.overlay, selection: new Set([node.id]) }
    candidate.renderer.setOverlay(overlay)
    compare('drag release')
    states = {
      ...Object.fromEntries(
        Object.entries(states).map(([id, progress]) => [
          id,
          progress.state === 'running'
            ? { ...progress, state: 'done' as const }
            : progress,
        ]),
      ),
      [node.id]: { state: states[node.id]?.state === 'done' ? 'cached' : 'done' },
    }
    candidate.renderer.setNodeStates(states)
    compare('execution settled')
    if (page === 'previews') {
      const image = fixture.previews.Image!.image as HTMLCanvasElement
      const context = image.getContext('2d')!
      context.fillStyle = tokens.colors.nodeHeader
      context.fillRect(0, 0, image.width, image.height)
    }
    candidate.renderer.setNodePreviews(fixture.previews)
    compare('preview update')
    overlay = {
      ...fixture.overlay,
      hoveredBadge: {
        nodeId: node.id,
        badgeId:
          fixture.badges[node.id]?.find((badge) => badge.placement === 'above')
            ?.id ?? '',
      },
    }
    candidate.renderer.setOverlay(overlay)
    compare('badge hover')
    overlay = {
      ...overlay,
      selection: new Set([node.id]),
      dragOffsets: new Map([[node.id, { dx: 5, dy: 80 }]]),
      resizePreview: {
        nodeId: node.id,
        x: node.x + 17,
        y:
          (canvasPaintTokens.graphCache.tilePixels +
            canvasPaintTokens.graphCache.bleedPixels) /
            devicePixelRatio +
          14 -
          80,
        width: node.layout.width + 37,
        height: node.layout.height + 29,
      },
    }
    candidate.renderer.setOverlay(overlay)
    compare('live resize at tile edge')
    const bottomNode =
      scene.nodes.find((item) =>
        fixture.badges[item.id]?.some((badge) => badge.placement === 'below'),
      ) ?? node
    const resizedHeight = bottomNode.layout.height + 29
    overlay = {
      ...fixture.overlay,
      selection: new Set([bottomNode.id]),
      dragOffsets: new Map([[bottomNode.id, { dx: -7, dy: 80 }]]),
      resizePreview: {
        nodeId: bottomNode.id,
        x: bottomNode.x + 17,
        y:
          (canvasPaintTokens.graphCache.tilePixels -
            canvasPaintTokens.graphCache.bleedPixels) /
            devicePixelRatio -
          14 -
          resizedHeight -
          80,
        width: bottomNode.layout.width - 19,
        height: resizedHeight,
      },
    }
    candidate.renderer.setOverlay(overlay)
    compare('live resize at lower tile edge')
    overlay = { ...fixture.overlay, selection: new Set([node.id]) }
    candidate.renderer.setOverlay(overlay)
    scene = {
      ...scene,
      nodes: scene.nodes.map((item) =>
        item.id === node.id
          ? {
              ...item,
              x: item.x + 23.25,
              y: item.y - 13.5,
              layout: { ...item.layout, title: 'Edited title' },
              node: { ...item.node, title: 'Edited title' },
            }
          : item,
      ),
    }
    candidate.renderer.setScene(scene)
    compare('edit and release')
    const nextTheme = theme === 'dark' ? 'light' : 'dark'
    colors = canvasColorsForTheme(nextTheme)
    typePaint = canvasTypePaintForTheme(nextTheme)
    candidate.renderer.setColors(colors, typePaint)
    compare('theme')
    scene = {
      ...scene,
      nodes: scene.nodes.map((item) =>
        item.id === node.id
          ? { ...item, color: tokens.colors.selection }
          : item,
      ),
    }
    candidate.renderer.setScene(scene)
    compare('node style')
    width -= 23
    height += 17
    candidate.canvas.style.width = `${width}px`
    candidate.canvas.style.height = `${height}px`
    compare('resize')
    compare('repeated repaint')
    const corrupt = lastExpected!.slice()
    corrupt[0] = corrupt[0]! ^ 255
    return {
      frames,
      corruptionDifferences: differingPixels(corrupt, lastExpected!),
      staleDifferences: differingPixels(initial!, lastComparable!),
    }
  } finally {
    candidate.renderer.dispose()
    OffscreenCanvas.prototype.transferToImageBitmap = transfer
    host.remove()
  }
}
