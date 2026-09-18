/**
 * Selection toolbox tests: the strip centers above the selection bounding
 * box, button geometry agrees between layout and hit-testing, and the
 * degenerate cases (no buttons, no selected scene nodes) grow no toolbox.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  documentResolver,
  loadDocument,
  parseObjectInfo,
  type ObjectInfoEntry,
  type WorkflowDocument,
} from '@dinkster/core'
import { boundarySceneId, buildScene, type Scene } from '../src/scene.js'
import { defaultTokens } from '../src/tokens.js'
import type { TextMeasurer, WidgetMeasure } from '../src/layout.js'
import {
  hitTestToolbox,
  insideToolbox,
  TOOLBOX_BUTTON_SIZE,
  TOOLBOX_GAP_FROM_SELECTION,
  TOOLBOX_GAP,
  TOOLBOX_PAD,
  TOOLBOX_SEPARATOR_WIDTH,
  partialExecutionButtons,
  toolboxButton,
  toolboxLayout,
  toolboxSeparator,
  type ToolboxButton,
  type ToolboxRow,
} from '../src/toolbox.js'

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(coreRoot, rel), 'utf8'))

const { schemas } = parseObjectInfo(readJson('fixtures/object_info.json') as Record<string, ObjectInfoEntry>)
const measure: TextMeasurer = (text) => text.length * 6
const widgetMeasure: WidgetMeasure = () => ({ viewId: 'core.line', rows: 1 })

function sceneOf(workflow: string, graphId = 'g0'): Scene {
  const doc = loadDocument(readJson(`fixtures/workflows/${workflow}.json`)).document as WorkflowDocument
  return buildScene({
    document: doc,
    graphId,
    resolve: documentResolver(doc, (t) => schemas.get(t)),
    tokens: defaultTokens,
    measure,
    widgetMeasure,
  })
}

const BUTTONS: readonly ToolboxButton[] = [
  { id: 'core.mode.muted', glyph: 'M', label: 'Mute' },
  { id: 'core.mode.bypassed', glyph: 'B', label: 'Bypass', active: true },
  { id: 'core.delete', glyph: 'X', label: 'Delete' },
]
const BOTTOM_ROW: ToolboxRow = [
  toolboxButton(BUTTONS[2]!),
  toolboxSeparator(),
  toolboxButton(BUTTONS[0]!),
  toolboxButton(BUTTONS[1]!),
  toolboxSeparator(),
  toolboxButton({ id: 'core.more', glyph: '...', label: 'More actions' }),
]
const TOP_ROW: ToolboxRow = partialExecutionButtons({}).map(toolboxButton)
const ROWS = [TOP_ROW, BOTTOM_ROW] as const

function paintedSelectionOutlineTop(scene: Scene, ids: readonly string[], scale: number): number {
  const ordinary = scene.nodes.filter((node) => ids.includes(node.id))
  const boundaries = scene.boundaryNodes.filter((node) => ids.includes(boundarySceneId(node.side)))
  const individualTop = Math.min(
    ...ordinary.map((node) => node.y - 4),
    ...boundaries.map((node) => node.y - 3),
  )
  if (ordinary.length + boundaries.length < 2) return individualTop
  const selectedTop = Math.min(
    ...ordinary.map((node) => node.y),
    ...boundaries.map((node) => node.y),
  )
  return Math.min(individualTop, selectedTop - 8 - 0.5 / scale)
}

describe('toolboxLayout', () => {
  const scene = sceneOf('exec-basic')

  it('lays out a naturally narrower three-control top panel centered over the wider lower panel', () => {
    const n0 = scene.nodes.find((n) => n.id === 'n0')!
    const tl = toolboxLayout(scene, new Set(['n0']), ROWS, 1)!
    expect(tl).toBeDefined()
    const bottomWidth = 4 * TOOLBOX_BUTTON_SIZE + 2 * TOOLBOX_SEPARATOR_WIDTH + 5 * TOOLBOX_GAP
    const topWidth = 3 * TOOLBOX_BUTTON_SIZE + 2 * TOOLBOX_GAP
    const expectedWidth = TOOLBOX_PAD * 2 + Math.max(topWidth, bottomWidth)
    expect(TOOLBOX_BUTTON_SIZE).toBe(28)
    expect(tl.width).toBe(expectedWidth)
    expect(tl.height).toBe(TOOLBOX_PAD * 2 + 2 * TOOLBOX_BUTTON_SIZE + TOOLBOX_GAP)
    expect(tl.x + tl.width / 2).toBeCloseTo(n0.x + n0.layout.width / 2)
    expect(tl.y + tl.height).toBe(n0.y - 4 - TOOLBOX_GAP_FROM_SELECTION)
    expect(tl.rows).toHaveLength(2)
    expect(tl.rows[0]!.x + tl.rows[0]!.width / 2).toBeCloseTo(tl.x + tl.width / 2)
    expect(tl.rows[1]!.x + tl.rows[1]!.width / 2).toBeCloseTo(tl.x + tl.width / 2)
    expect(tl.rows[0]!.entries).toHaveLength(3)
    expect(tl.rows[0]!.panel.width).toBe(topWidth + TOOLBOX_PAD * 2)
    expect(tl.rows[1]!.panel.width).toBe(bottomWidth + TOOLBOX_PAD * 2)
    expect(tl.rows[0]!.panel.width).toBeLessThan(tl.rows[1]!.panel.width)
    expect(tl.rows[0]!.panel.x + tl.rows[0]!.panel.width / 2)
      .toBeCloseTo(tl.rows[1]!.panel.x + tl.rows[1]!.panel.width / 2)
    expect(tl.buttons).toHaveLength(7)
  })

  it('spans the bounding box of a multi-node selection', () => {
    const ids = scene.nodes.slice(0, 2).map((n) => n.id)
    const [a, b] = scene.nodes.slice(0, 2)
    const tl = toolboxLayout(scene, new Set(ids), ROWS, 1)!
    const minX = Math.min(a!.x, b!.x)
    const maxX = Math.max(a!.x + a!.layout.width, b!.x + b!.layout.width)
    const minY = Math.min(a!.y, b!.y)
    expect(tl.x + tl.width / 2).toBeCloseTo((minX + maxX) / 2)
    expect(tl.y + tl.height).toBe(minY - 8.5 - TOOLBOX_GAP_FROM_SELECTION)
  })

  it('returns undefined with no buttons or no selected scene nodes', () => {
    expect(toolboxLayout(scene, new Set(['n0']), [], 1)).toBeUndefined()
    expect(toolboxLayout(scene, new Set(), ROWS, 1)).toBeUndefined()
    expect(toolboxLayout(scene, new Set(['no-such-node']), ROWS, 1)).toBeUndefined()
  })

  it('drops empty top rows and renders the bottom row as a single row', () => {
    const tl = toolboxLayout(scene, new Set(['n0']), [[], BOTTOM_ROW], 1)!
    expect(tl.rows).toHaveLength(1)
    expect(tl.height).toBe(TOOLBOX_PAD * 2 + TOOLBOX_BUTTON_SIZE)
    expect(tl.buttons.map((rect) => rect.button.id)).toEqual([
      'core.delete', 'core.mode.muted', 'core.mode.bypassed', 'core.more',
    ])
  })

  it.each([
    { name: 'single node', ids: ['n0'] },
    { name: 'multiple nodes', ids: scene.nodes.slice(0, 2).map((node) => node.id) },
  ])('keeps screen geometry and hit centers stable across zoom for a $name selection', ({ ids }) => {
    const selected = scene.nodes.filter((node) => ids.includes(node.id))
    const minX = Math.min(...selected.map((node) => node.x))
    const minY = Math.min(...selected.map((node) => node.y))
    const maxX = Math.max(...selected.map((node) => node.x + node.layout.width))

    for (const scale of [0.25, 0.5, 1, 1.5, 2, 4]) {
      const tl = toolboxLayout(scene, new Set(ids), ROWS, scale)!
      const outlineTop = paintedSelectionOutlineTop(scene, ids, scale)
      expect((outlineTop - (tl.y + tl.height)) * scale).toBeCloseTo(TOOLBOX_GAP_FROM_SELECTION, 12)
      expect(tl.x + tl.width / 2).toBeCloseTo((minX + maxX) / 2)
      for (const rect of tl.buttons) {
        expect(rect.size * scale).toBe(TOOLBOX_BUTTON_SIZE)
        expect(hitTestToolbox(tl, rect.x + rect.size / 2, rect.y + rect.size / 2)?.button.id)
          .toBe(rect.button.id)
      }
    }
  })

  it('keeps the same screen-space gap for a mixed ordinary and boundary selection', () => {
    const boundaryScene = sceneOf('exec-subgraph', 'g1')
    const boundary = boundaryScene.boundaryNodes.find((node) => node.side === 'inputs')!
    const ordinary = boundaryScene.nodes[0]!
    const ids = [ordinary.id, boundarySceneId(boundary.side)]
    const minX = Math.min(ordinary.x, boundary.x)
    const maxX = Math.max(ordinary.x + ordinary.layout.width, boundary.x + boundary.layout.width)
    for (const scale of [0.25, 0.5, 1, 1.5, 2, 4]) {
      const tl = toolboxLayout(boundaryScene, new Set(ids), [BOTTOM_ROW], scale)!
      const outlineTop = paintedSelectionOutlineTop(boundaryScene, ids, scale)
      expect((outlineTop - (tl.y + tl.height)) * scale).toBeCloseTo(TOOLBOX_GAP_FROM_SELECTION, 12)
      expect(tl.x + tl.width / 2).toBeCloseTo((minX + maxX) / 2)
      for (const rect of tl.buttons) {
        expect(rect.size * scale).toBe(TOOLBOX_BUTTON_SIZE)
        expect(hitTestToolbox(tl, rect.x + rect.size / 2, rect.y + rect.size / 2)?.button.id)
          .toBe(rect.button.id)
      }
    }
  })
})

describe('hitTestToolbox', () => {
  const scene = sceneOf('exec-basic')
  const tl = toolboxLayout(scene, new Set(['n0']), [BOTTOM_ROW], 1)!

  it('resolves each button at its center, in declared order', () => {
    for (const [i, r] of tl.buttons.entries()) {
      const hit = hitTestToolbox(tl, r.x + r.size / 2, r.y + r.size / 2)
      expect(hit?.button.id).toBe(r.button.id)
    }
  })

  it('gives separators geometry but never treats them as buttons', () => {
    const separators = tl.rows[0]!.entries.filter((entry) => entry.kind === 'separator')
    expect(separators).toHaveLength(2)
    for (const separator of separators) {
      expect(separator.width).toBe(TOOLBOX_SEPARATOR_WIDTH)
      expect(separator.height).toBeCloseTo(TOOLBOX_BUTTON_SIZE * 0.6)
      expect(hitTestToolbox(tl, separator.x + separator.width / 2, separator.y + separator.height / 2)).toBeUndefined()
      expect(insideToolbox(tl, separator.x, separator.y)).toBe(true)
    }
  })

  it('misses between buttons but stays inside the strip chrome', () => {
    const first = tl.buttons[0]!
    const gapX = first.x + first.size + TOOLBOX_GAP / 2
    const midY = first.y + first.size / 2
    expect(hitTestToolbox(tl, gapX, midY)).toBeUndefined()
    expect(insideToolbox(tl, gapX, midY)).toBe(true)
  })

  it('misses outside the strip entirely', () => {
    expect(hitTestToolbox(tl, tl.x - 5, tl.y - 5)).toBeUndefined()
    expect(insideToolbox(tl, tl.x - 5, tl.y - 5)).toBe(false)
  })

  it('does not claim the empty shoulders beside a naturally narrower top row', () => {
    const twoRows = toolboxLayout(scene, new Set(['n0']), ROWS, 1)!
    const top = twoRows.rows[0]!
    const bottom = twoRows.rows[1]!
    expect(top.panel.width).toBeLessThan(bottom.panel.width)
    expect(insideToolbox(twoRows, bottom.panel.x + 1, top.panel.y + top.panel.height / 2)).toBe(false)
    expect(insideToolbox(twoRows, top.panel.x + 1, top.panel.y + top.panel.height / 2)).toBe(true)
  })
})

describe('partialExecutionButtons', () => {
  it('orders all modes as up-to, between, from-onwards', () => {
    expect(partialExecutionButtons({}).map((b) => b.id)).toEqual([
      'core.queueUpToHere',
      'core.queueBetween',
      'core.queueFromHere',
    ])
  })

  it('keeps unavailable modes visible and carries their disabled reason', () => {
    expect(partialExecutionButtons({ between: 'requires a contiguous multi-node selection' })).toMatchObject([
      { id: 'core.queueUpToHere', icon: 'play-to', label: 'Execute up to' },
      {
        id: 'core.queueBetween',
        icon: 'play-between',
        label: 'Execute between',
        disabled: true,
        reason: 'requires a contiguous multi-node selection',
      },
      { id: 'core.queueFromHere', icon: 'play-from', label: 'Execute from onwards' },
    ])
  })
})
